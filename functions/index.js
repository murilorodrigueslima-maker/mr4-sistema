'use strict';

/**
 * Cloud Functions — MR4 Ponto Digital
 *
 * AVISO DE SEGURANÇA:
 * - FACIAL CLIENT-SIDE NÃO É BARREIRA DE SEGURANÇA CONTRA USUÁRIO TÉCNICO.
 *   facialScore vem do navegador e é aceito apenas como dado de auditoria.
 *   A barreira real é: autenticação Firebase + validação server-side aqui.
 * - GPS do cliente pode ser falsificado (limitação estrutural da web).
 *   Server recalcula distância com as coordenadas brutas enviadas.
 *   dentroRaio nunca é aceito do cliente.
 *
 * NÃO PUBLICAR EM PRODUÇÃO sem passar pelos testes A-T no emulador.
 */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated, onDocumentWritten, onDocumentWrittenWithAuthContext } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const { distMetros, fortalezaAgora, validarLatLng } = require('./utils');
const { executarGeracaoFilaSnapshot }               = require('./lib/filaSnapshotGenerator');
const { executarGeracaoWorklist }                   = require('./lib/worklistGenerator');
const { criarLookupNomeGC }                         = require('./lib/filaNomes');
const { carteiraRegraJobHandler }                   = require('./lib/carteiraRegraJob');
const comprasEntrypoints                            = require('./lib/compras/entrypoints');
const expedicaoSync                                 = require('./lib/expedicao/sync');
const {
  claimOpportunityHandler,
  registerOutcomeHandler,
  releaseOpportunityHandler,
} = require('./lib/canaryCallable');

if (!admin.apps.length) admin.initializeApp();
const db        = admin.firestore();
const authAdmin = admin.auth();

// ── Constantes ────────────────────────────────────────────────────────────────

const REGION = 'southamerica-east1';

const EMP_LAT  = -3.7603154;
const EMP_LNG  = -38.5634329;
const RAIO_M   = 200;

// Lido em runtime para permitir override nos testes (PONTO_COOLDOWN_MS=0 nos testes de sequência)
const COOLDOWN_MS = () => parseInt(process.env.PONTO_COOLDOWN_MS || '10000', 10);
const FOTO_MAX_BYTES = 350_000;  // ~350 KB base64

const LABEL_PONTO = {
  entrada:        'Entrada',
  saida_almoco:   'Saída almoço',
  retorno_almoco: 'Retorno',
  saida:          'Saída',
};

// ── Handler: registrarPonto ───────────────────────────────────────────────────
// PONTO 2.0 F0 (P0-01): batida idempotente por intenção (requestId + tipoEsperado) — ver lib/pontoBatida.js
const pontoBatida = require('./lib/pontoBatida');

async function registrarPontoHandler(request) {
  // 1. Autenticação obrigatória
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para registrar ponto.');
  }
  const uid = request.auth.uid;

  // 2. Identidade server-side: users/{uid}
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError('not-found', 'Conta não vinculada a funcionário. Contate o gestor.');
  }
  const userPerfil = userDoc.data();
  if (userPerfil.role !== 'funcionario') {
    throw new HttpsError('permission-denied', 'Somente funcionários podem registrar ponto por esta função.');
  }
  if (!userPerfil.ativo) {
    throw new HttpsError('permission-denied', 'Conta inativa. Contate o gestor.');
  }
  const funcId = userPerfil.funcionarioId;
  if (!funcId) {
    throw new HttpsError('not-found', 'Funcionário não vinculado ao perfil. Contate o gestor.');
  }

  // 3. Dados do funcionário
  const funcDoc = await db.collection('funcionarios').doc(funcId).get();
  if (!funcDoc.exists) {
    throw new HttpsError('not-found', 'Funcionário não encontrado. Contate o gestor.');
  }
  const func      = funcDoc.data();
  const modalidade = func.modalidade || 'PRESENCIAL';

  // 4. Payload do cliente (campos controlados pelo servidor são ignorados se enviados)
  const { lat, lng, horaCliente, facialScore, foto } = request.data || {};
  let intencao;
  try { intencao = pontoBatida.lerIntencao(request.data); }
  catch (e) { throw new HttpsError('invalid-argument', 'Dados da batida inválidos (' + e.codigo + ').'); }

  // 5. Validação de GPS
  let dentroRaio = null;
  if (modalidade === 'PRESENCIAL') {
    if (!validarLatLng(lat, lng)) {
      throw new HttpsError('invalid-argument', 'Localização GPS inválida ou fora dos limites do Brasil.');
    }
    const dist = distMetros(lat, lng, EMP_LAT, EMP_LNG);
    dentroRaio = dist <= RAIO_M;
    if (!dentroRaio) {
      throw new HttpsError(
        'failed-precondition',
        `Você está a ${Math.round(dist)}m da empresa (raio permitido: ${RAIO_M}m).`,
      );
    }
  } else if (validarLatLng(lat, lng)) {
    dentroRaio = distMetros(lat, lng, EMP_LAT, EMP_LNG) <= RAIO_M;
  }

  // 6. Validação de foto
  if (foto && typeof foto === 'string' && foto.length > FOTO_MAX_BYTES) {
    throw new HttpsError('invalid-argument', 'Foto muito grande. Reduza a qualidade e tente novamente.');
  }

  // 7. Hora oficial do servidor (America/Fortaleza — nunca do cliente)
  const { data, hora } = fortalezaAgora();

  // 8. Sequência + gravação em UMA transação, idempotente por intenção (PONTO 2.0 F0 — P0-01)
  const envCooldown = process.env.PONTO_COOLDOWN_MS;
  const r = await pontoBatida.registrarBatidaTx(db, {
    funcId, uid, func, data, hora, modalidade, dentroRaio,
    lat:         validarLatLng(lat, lng) ? lat : null,                      // CLIENTE/AUDITORIA
    lng:         validarLatLng(lat, lng) ? lng : null,                      // CLIENTE/AUDITORIA
    horaCliente: typeof horaCliente === 'string' ? horaCliente.slice(0, 8) : null,
    facialScore: typeof facialScore === 'number' ? Math.round(facialScore) : null,
    foto:        foto && typeof foto === 'string' ? foto : null,
    requestId: intencao.requestId, tipoEsperado: intencao.tipoEsperado,
    agoraMs: Date.now(),
    cooldownOverrideMs: envCooldown !== undefined ? parseInt(envCooldown, 10) : undefined,   // testes (PONTO_COOLDOWN_MS)
    LABEL_PONTO, HttpsError, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true, status: r.status, id: r.id, tipo: r.tipo, tipoLabel: r.tipoLabel, data: r.data, hora: r.hora,
    dentroRaio: r.dentroRaio, modalidade: r.modalidade,
  };
}

// ── Handler: criarContaFuncionario ────────────────────────────────────────────

async function criarContaFuncionarioHandler(request) {
  // 1. Autenticação obrigatória
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para criar contas.');
  }
  const uid = request.auth.uid;

  // 2. Verificar gestor — FAIL CLOSED
  const callerDoc = await db.collection('users').doc(uid).get();
  const isGestor  =
    callerDoc.exists &&
    callerDoc.data().role === 'gestor' &&
    callerDoc.data().ativo === true;

  if (!isGestor) {
    throw new HttpsError('permission-denied', 'Somente gestores podem criar contas de funcionários.');
  }

  // 3. Payload
  const { email, senha, funcId, funcNome } = request.data || {};
  if (!email  || typeof email   !== 'string') throw new HttpsError('invalid-argument', 'E-mail inválido.');
  if (!senha  || typeof senha   !== 'string' || senha.length < 6) throw new HttpsError('invalid-argument', 'Senha deve ter pelo menos 6 caracteres.');
  if (!funcId || typeof funcId  !== 'string') throw new HttpsError('invalid-argument', 'funcId inválido.');
  if (!funcNome || typeof funcNome !== 'string') throw new HttpsError('invalid-argument', 'Nome do funcionário inválido.');

  // 4. Funcionário existe?
  const funcDoc = await db.collection('funcionarios').doc(funcId).get();
  if (!funcDoc.exists) {
    throw new HttpsError('not-found', `Funcionário ${funcId} não encontrado.`);
  }

  // 5. Conta já vinculada?
  const usersSnap = await db.collection('users').where('funcionarioId', '==', funcId).limit(1).get();
  if (!usersSnap.empty) {
    throw new HttpsError('already-exists', 'Este funcionário já possui uma conta de acesso.');
  }

  // 6. Criar Auth user via Admin SDK (não desloga gestor)
  let newUser;
  try {
    newUser = await authAdmin.createUser({
      email:       email.trim().toLowerCase(),
      password:    senha,
      displayName: funcNome,
    });
  } catch (e) {
    const msgs = {
      'auth/email-already-exists': 'Este e-mail já está em uso por outra conta.',
      'auth/invalid-email':        'E-mail inválido.',
      'auth/weak-password':        'Senha muito fraca (mínimo 6 caracteres).',
    };
    throw new HttpsError('invalid-argument', msgs[e.code] || 'Erro ao criar conta: ' + e.message);
  }

  // 7. Criar users/{uid}
  await db.collection('users').doc(newUser.uid).set({
    funcionarioId: funcId,
    role:          'funcionario',
    ativo:         true,
    nome:          funcNome,
    email:         email.trim().toLowerCase(),
    criadoEm:      admin.firestore.FieldValue.serverTimestamp(),
    criadoPor:     uid,
  });

  return { ok: true, uid: newUser.uid };
}

// ── Handler: gcQuery ─────────────────────────────────────────────────────────
//
// NÃO É UM PROXY ABERTO.
// Aceita apenas operações conhecidas (whitelist estrita).
// O cliente informa QUAL operação quer executar — o servidor define
// exatamente qual endpoint do GestãoClick é chamado e quais parâmetros
// são permitidos.
//
// Operações disponíveis:
//   LISTAR_PRODUTOS        → GET /produtos    (compras, estoque, garantia)
//   CONSULTAR_PRODUTO      → GET /produtos/:id (garantia, compras)
//   LISTAR_VENDAS          → GET /vendas      (vendas, compras, expedicao)
//   LISTAR_PAGAMENTOS      → GET /pagamentos  (compras)
//   LISTAR_RECEBIMENTOS    → GET /recebimentos (compras)
//   PESQUISAR_CLIENTES     → GET /clientes    (garantia, clientes)
//
// Cada operação tem:
//   - Autenticação Firebase obrigatória
//   - Role de gestor verificada server-side (lê users/{uid})
//   - Módulo verificado server-side (lê sistema_usuarios/{uid})
//   - Parâmetros do cliente validados e sanitizados
//   - DTO mínimo retornado ao cliente (apenas campos necessários)
//
// STATUS S0: STUB — não deployado. Lógica de negócio presente para revisão.
//            Credenciais GC virão de process.env (definidas na CF config).
//            Implementação real: S2.
//
// ATENÇÃO: NÃO modificar registrarPontoHandler nem criarContaFuncionarioHandler.
//          Este handler é completamente independente.

const GC_BASE_URL = 'https://api.gestaoclick.com';

// Mapa de operações permitidas: chave → configuração
const GC_OPERACOES = {
  LISTAR_PRODUTOS: {
    modulo:  ['compras', 'estoque', 'garantia'],
    metodo:  'GET',
    path:    () => '/produtos',
    params:  (dados) => {
      const p = new URLSearchParams({ limite: String(dados.limite || 100) });
      if (dados.pagina) p.set('pagina', String(dados.pagina));
      if (dados.nome)       p.set('nome',       String(dados.nome).replace(/[^a-zA-Z0-9À-ÿ\s./-]/g, '').slice(0, 80));
      if (dados.referencia) p.set('referencia', String(dados.referencia).slice(0, 50));
      return p.toString();
    },
    dto:     (item) => ({
      id:            item.id,
      codigo:        item.codigo_interno || item.codigo || item.referencia || '',
      nome:          item.nome       || '',
      fabricante:    item.fabricante || item.marca      || '',
      estoque_atual: Number(item.estoque_atual ?? item.estoque ?? 0),
    }),
  },
  CONSULTAR_PRODUTO: {
    modulo:  ['garantia', 'compras'],
    metodo:  'GET',
    path:    (dados) => `/produtos/${encodeURIComponent(String(dados.produtoId))}`,
    params:  () => '',
    dto:     (item) => ({
      id:           item.id,
      codigo:       item.codigo   || '',
      nome:         item.nome     || '',
      preco_venda:  item.preco_venda  || 0,
      preco_custo:  item.preco_custo  || 0,
      estoque_atual: item.estoque_atual || 0,
      fornecedor:   item.fornecedor || item.marca || item.fabricante || '',
    }),
  },
  LISTAR_VENDAS: {
    modulo:  ['vendas', 'compras', 'expedicao'],
    metodo:  'GET',
    path:    () => '/vendas',
    params:  (dados) => {
      const p = new URLSearchParams({ limite: String(dados.limite || 100) });
      if (dados.pagina)         p.set('pagina',          String(dados.pagina));
      if (dados.data_inicio)    p.set('data_inicio',     String(dados.data_inicio).slice(0, 10));
      if (dados.data_fim)       p.set('data_fim',        String(dados.data_fim).slice(0, 10));
      if (dados.status)         p.set('status',          String(dados.status).slice(0, 30));
      return p.toString();
    },
    dto:     (item) => {
      const dataHora = item.data_hora || item.data_criacao || item.created_at || '';
      const horaMatch = dataHora.match(/(\d{2}:\d{2})/);
      return {
        id:          item.id,
        numero:      String(item.codigo || item.numero || item.id || ''),
        data:        (item.data || item.data_venda || item.data_pedido || '').slice(0, 10),
        hora:        horaMatch ? horaMatch[1] : '',
        cliente:     item.nome_cliente  || item.razao_social || '',
        cliente_id:  String(item.cliente_id || ''),
        valor:       item.valor_total || 0,
        status:      item.status      || '',
        vendedor:    item.nome_vendedor || item.nome_usuario  || '',
        situacao_id: item.situacao_id || '',
        cidade:      item.cidade_cliente || item.cidade || '',
        itens:       Array.isArray(item.produtos) ? item.produtos.length : Number(item.quantidade_produtos || 0),
        produtos:    Array.isArray(item.produtos) ? item.produtos.map(raw => {
          const p = raw.produto || raw;
          return {
            id:          String(p.produto_id || p.id || ''),
            nome:        p.nome_produto || p.nome     || '',
            quantidade:  Number(p.quantidade || p.qtd) || 0,
            valor_custo: Number(p.valor_custo || p.custo) || 0,
            valor_venda: Number(p.valor_venda || p.preco_venda || p.preco) || 0,
          };
        }) : [],
      };
    },
  },
  LISTAR_PAGAMENTOS: {
    modulo:  ['compras'],
    metodo:  'GET',
    path:    () => '/pagamentos',
    params:  (dados) => {
      const p = new URLSearchParams({ limite: String(dados.limite || 100) });
      if (dados.pagina) p.set('pagina', String(dados.pagina));
      return p.toString();
    },
    dto:     (item) => ({
      id:              item.id,
      valor:           item.valor            || 0,
      data_vencimento: item.data_vencimento  || item.vencimento || '',
      liquidado:       item.liquidado        ?? 0,
      situacao:        item.situacao         || '',
      fornecedor:      item.fornecedor ? { nome: item.fornecedor.nome || '' } : {},
    }),
  },
  LISTAR_RECEBIMENTOS: {
    modulo:  ['compras'],
    metodo:  'GET',
    path:    () => '/recebimentos',
    params:  (dados) => {
      const p = new URLSearchParams({ limite: String(dados.limite || 100) });
      if (dados.pagina) p.set('pagina', String(dados.pagina));
      return p.toString();
    },
    dto:     (item) => ({
      id:              item.id,
      valor:           item.valor            || 0,
      data_vencimento: item.data_vencimento  || item.vencimento || '',
      liquidado:       item.liquidado        ?? 0,
      situacao:        item.situacao         || '',
      cliente:         item.cliente ? { nome: item.cliente.nome || '' } : {},
    }),
  },
  PESQUISAR_CLIENTES: {
    modulo:  ['garantia', 'clientes'],
    metodo:  'GET',
    path:    () => '/clientes',
    params:  (dados) => {
      const p = new URLSearchParams({ limite: String(dados.limite || 20) });
      // Aceita apenas busca textual — nunca passa o termo sem sanitizar
      if (dados.busca) p.set('nome', String(dados.busca).replace(/[^a-zA-Z0-9À-ÿ\s./-]/g, '').slice(0, 80));
      return p.toString();
    },
    // DTO mínimo: sem CPF, sem CNPJ, sem dados financeiros do cliente
    dto:     (item) => ({
      id:       item.id,
      nome:     item.nome     || '',
      cidade:   item.cidade   || '',
      telefone: item.telefone || '',
    }),
  },
};

async function gcQueryHandler(request) {
  // 1. Autenticação obrigatória
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para acessar dados do GestãoClick.');
  }
  const uid = request.auth.uid;

  // 2. Verificar perfil — FAIL CLOSED (lê users/{uid})
  const userDoc = await db.collection('users').doc(uid).get();
  const perfil  = userDoc.exists ? userDoc.data() : null;
  if (!perfil || !perfil.ativo) {
    throw new HttpsError('permission-denied', 'Acesso negado.');
  }
  // Gestor: acesso completo. Funcionário da expedição: somente LISTAR_VENDAS.
  if (perfil.role !== 'gestor') {
    const { operacao: opCheck } = request.data || {};
    if (perfil.role !== 'funcionario' || opCheck !== 'LISTAR_VENDAS') {
      throw new HttpsError('permission-denied', 'Acesso negado. Somente gestores ou funcionários da expedição (LISTAR_VENDAS).');
    }
    const sysCheck = await db.collection('sistema_usuarios').doc(uid).get();
    const modCheck = sysCheck.exists ? (sysCheck.data().modulos || []) : [];
    if (!modCheck.includes('expedicao')) {
      throw new HttpsError('permission-denied', 'Módulo expedicao necessário para esta operação.');
    }
  }

  // 3. Payload do cliente
  const { operacao, dados = {} } = request.data || {};
  if (!operacao || typeof operacao !== 'string') {
    throw new HttpsError('invalid-argument', 'Campo "operacao" ausente ou inválido.');
  }

  // 4. Whitelist de operações
  const config = GC_OPERACOES[operacao];
  if (!config) {
    throw new HttpsError('invalid-argument', `Operação desconhecida: "${operacao}". Operações permitidas: ${Object.keys(GC_OPERACOES).join(', ')}`);
  }

  // 4b. Limites de paginação (proteção contra abuso)
  if (dados.limite !== undefined) {
    const lim = Number(dados.limite);
    if (!Number.isInteger(lim) || lim < 1 || lim > 200) {
      throw new HttpsError('invalid-argument', '"limite" deve ser inteiro entre 1 e 200.');
    }
  }
  if (dados.pagina !== undefined) {
    const pag = Number(dados.pagina);
    if (!Number.isInteger(pag) || pag < 1 || pag > 200) {
      throw new HttpsError('invalid-argument', '"pagina" deve ser inteiro entre 1 e 200.');
    }
  }

  // 5. Verificar módulo server-side (lê sistema_usuarios/{uid})
  const sysDoc     = await db.collection('sistema_usuarios').doc(uid).get();
  const modulosUser = sysDoc.exists ? (sysDoc.data().modulos || []) : [];
  const temModulo  = config.modulo.some(m => modulosUser.includes(m));
  if (!temModulo) {
    throw new HttpsError('permission-denied', `Módulo não autorizado. Necessário: ${config.modulo.join(' ou ')}.`);
  }

  // 6. Verificar credenciais GC (via env da CF — nunca no browser)
  const accessToken  = process.env.GC_ACCESS_TOKEN;
  const secretToken  = process.env.GC_SECRET_ACCESS_TOKEN;
  if (!accessToken || !secretToken) {
    throw new HttpsError('internal', 'Credenciais GestãoClick não configuradas.');
  }

  // 7. Montar URL — servidor define o path e valida os params
  let produtoId = null;
  if (dados.produtoId !== undefined) {
    produtoId = String(dados.produtoId);
    if (!/^\d+$/.test(produtoId)) {
      throw new HttpsError('invalid-argument', 'produtoId deve ser numérico.');
    }
  }

  const path    = config.path(dados);
  const params  = config.params(dados);
  const gcUrl   = `${GC_BASE_URL}${path}${params ? '?' + params : ''}`;

  // 9. Chamar GestãoClick

  let gcResp;
  try {
    gcResp = await fetch(gcUrl, {
      method:  config.metodo,
      headers: {
        'access-token':        accessToken,
        'secret-access-token': secretToken,
        'Content-Type':        'application/json',
      },
    });
  } catch (e) {
    throw new HttpsError('unavailable', 'Erro de rede ao chamar GestãoClick: ' + e.message);
  }

  if (!gcResp.ok) {
    const txt = await gcResp.text();
    throw new HttpsError('unavailable', `GestãoClick retornou ${gcResp.status}: ${txt.slice(0, 200)}`);
  }

  const rawJson = await gcResp.json();

  // 10. Aplicar DTO mínimo — nunca retornar raw ao browser
  // Resposta paginada ou item único
  if (rawJson.data && Array.isArray(rawJson.data)) {
    return {
      data:     rawJson.data.map(config.dto),
      meta:     {
        pagina_atual:   rawJson.meta?.pagina_atual   || 1,
        total_paginas:  rawJson.meta?.total_paginas  || 1,
        total_registros: rawJson.meta?.total_registros || rawJson.data.length,
      },
    };
  }

  // Item único
  return { data: config.dto(rawJson) };
}

// ── Handler: syncPainelDisplay ────────────────────────────────────────────────
//
// S3 — Etapa 2: sincroniza métricas de vendas do GestãoClick para
// display_metrics/painel_comercial no Firestore.
//
// Regras reproduzidas fielmente a partir de painel-comercial.html:
//   - Período: 1º do mês corrente até hoje (America/Fortaleza)
//   - Filtro: situacao_id === '3952593' (Concretizados)
//   - Identificação de vendedor: nomeMatchPainel() (case-insensitive, match parcial)
//   - Campos de valor: valor_total || total || valor
//   - Campos de data:  data || data_venda || data_pedido
//   - Paginação: automática (limite=100 por página)
//
// NÃO grava: clientes, CPF/CNPJ, produtos, endereços, IDs de vendas, metas ou pctMeta.
// Escrita via Admin SDK — regra "allow write: if false" no Firestore protege contra
// escrita pelo navegador.

const SITUACAO_CONCRETIZADO = '3952593';

// Reproduz exatamente a lógica de nomeMatch() do painel-comercial.html
function nomeMatchPainel(nomeGC, nomeConfig) {
  const a = (nomeGC    || '').toLowerCase().trim();
  const b = (nomeConfig || '').toLowerCase().trim();
  if (!a || !b) return false;
  return a === b
    || a.startsWith(b.split(' ')[0])
    || b.startsWith(a.split(' ')[0])
    || a.includes(b.split(' ')[0]);
}

// Busca todas as vendas do período com paginação automática.
// Reproduz fetchVendas() do painel-comercial.html (pagina até totalPaginas).
async function fetchTodasVendasGC(accessToken, secretToken, dataInicio, dataFim) {
  const headers = {
    'access-token':        accessToken,
    'secret-access-token': secretToken,
    'Content-Type':        'application/json',
  };
  let todos = [], pagina = 1;
  while (true) {
    const params = new URLSearchParams({
      pagina:      String(pagina),
      limite:      '100',
      data_inicio: dataInicio,
      data_fim:    dataFim,
    });
    const resp = await fetch(`${GC_BASE_URL}/vendas?${params}`, { method: 'GET', headers });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`GestãoClick /vendas retornou ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const json  = await resp.json();
    const data  = Array.isArray(json.data) ? json.data : [];
    todos       = todos.concat(data);
    const total = Number(json.meta?.total_paginas || 1);
    if (pagina >= total) break;
    pagina++;
  }
  return todos;
}

async function syncPainelDisplayHandler() {
  const docRef = db.collection('display_metrics').doc('painel_comercial');

  // Prevenção de execuções sobrepostas: pula se já foi atualizado há menos de 25 min.
  // O onSchedule garante não sobreposição em condições normais; esta guarda cobre
  // execuções manuais acidentais ou re-tentativas automáticas do Cloud Scheduler.
  const existing = await docRef.get();
  if (existing.exists) {
    const ts = existing.data().atualizadoEm;
    if (ts && typeof ts.toDate === 'function') {
      if (Date.now() - ts.toDate().getTime() < 25 * 60 * 1000) return;
    }
  }

  // Nomes dos vendedores: lidos de painel_config/default (somente leitura).
  // Fallback para os nomes padrão caso o documento não exista.
  const DEFAULT_VENDEDORES = ['Ademir', 'Fabiana'];
  let vendedores  = DEFAULT_VENDEDORES;
  let metaPorNome = {};  // nome → meta mensal (R$) — copiada de painel_config, atualiza a cada 30 min
  let metaEquipe  = 0;
  try {
    const cfgSnap = await db.collection('painel_config').doc('default').get();
    if (cfgSnap.exists) {
      const cfg = cfgSnap.data();
      if (Array.isArray(cfg.vendedores)) {
        const validos = cfg.vendedores.filter(v => v.nome);
        const nomes   = validos.map(v => v.nome);
        if (nomes.length > 0) vendedores = nomes;
        validos.forEach(v => { metaPorNome[v.nome] = Number(v.meta) || 0; });
      }
      metaEquipe = Number(cfg.meta_equipe) || 0;
    }
  } catch (_) { /* usa defaults */ }

  // Período em America/Fortaleza (UTC-3 fixo) — mesma referência usada em todo o sistema.
  const { data: hojeStr } = fortalezaAgora();
  const [ano, mes]        = hojeStr.split('-');
  const inicioMes         = `${ano}-${mes}-01`;

  // Credenciais do Secret Manager (nunca expostas ao cliente)
  const accessToken = process.env.GC_ACCESS_TOKEN;
  const secretToken = process.env.GC_SECRET_ACCESS_TOKEN;
  if (!accessToken || !secretToken) throw new Error('Credenciais GC não configuradas.');

  // Busca e filtro
  const todasVendas    = await fetchTodasVendasGC(accessToken, secretToken, inicioMes, hojeStr);
  const concretizadas  = todasVendas.filter(v => String(v.situacao_id) === SITUACAO_CONCRETIZADO);

  // Métricas por vendedor (lógica idêntica ao painel-comercial.html)
  const metricsVendedores = vendedores.map(nome => {
    const vendasV    = concretizadas.filter(v =>
      nomeMatchPainel(v.nome_vendedor || v.vendedor || v.nome_usuario || '', nome)
    );
    const vendasHoje = vendasV.filter(v =>
      (v.data || v.data_venda || v.data_pedido || '').slice(0, 10) === hojeStr
    );
    const totalMes    = vendasV.reduce(   (s, v) => s + Number(v.valor_total || v.total || v.valor || 0), 0);
    const totalHoje   = vendasHoje.reduce((s, v) => s + Number(v.valor_total || v.total || v.valor || 0), 0);
    const pedidosMes  = vendasV.length;
    const pedidosHoje = vendasHoje.length;
    return {
      nome,
      meta:       metaPorNome[nome] || 0,
      totalMes,   totalHoje,
      pedidosMes, pedidosHoje,
      ticketMes:  pedidosMes  ? totalMes  / pedidosMes  : 0,
      ticketHoje: pedidosHoje ? totalHoje / pedidosHoje : 0,
    };
  });

  // Totais da equipe (somatório dos vendedores)
  const equipe = {
    totalHoje:   metricsVendedores.reduce((s, v) => s + v.totalHoje,   0),
    totalMes:    metricsVendedores.reduce((s, v) => s + v.totalMes,    0),
    pedidosHoje: metricsVendedores.reduce((s, v) => s + v.pedidosHoje, 0),
    pedidosMes:  metricsVendedores.reduce((s, v) => s + v.pedidosMes,  0),
  };
  equipe.ticketHoje = equipe.pedidosHoje ? equipe.totalHoje / equipe.pedidosHoje : 0;
  equipe.ticketMes  = equipe.pedidosMes  ? equipe.totalMes  / equipe.pedidosMes  : 0;

  // Grava via Admin SDK — o navegador não pode escrever (allow write: if false nas Rules)
  await docRef.set({
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    periodo:      { inicioMes, fim: hojeStr },
    equipe,
    vendedores:   metricsVendedores,
    // Somente os campos de config estritamente necessários para o painel display.
    // Alterações em painel_config levam até 30 min para refletir na TV.
    configuracao: { metaEquipe },
  });
}

// ── Handler: concluirRevisaoEspelho ───────────────────────────────────────────
//
// Trigger Firestore: dispara quando um documento em espelhos/{espelhoId} é
// atualizado. Finaliza v1 atomicamente após a assinatura de v2.
//
// Fluxo:
//   1. v2 é assinada pelo funcionário (browser): assinado false→true
//   2. Este trigger detecta a mudança e localiza v1 via v2.versaoAnteriorId
//   3. Valida cross-reference e estado de v1
//   4. Atualiza v1: revisaoEmAndamento=false, substituido=true, substituidoEm=now
//
// Idempotência: se v1 já está com substituido=true + revisaoEmAndamento=false, retorna sem ação.
// Admin SDK: bypass das Rules — necessário pois funcionário não pode atualizar v1.

// Função pura de validação — sem efeitos colaterais, testável diretamente.
// Retorna: 'ok' | 'noop-assinado' | 'noop-no-versaoAnteriorId' | 'invalid-v2-status'
//        | 'v1-not-found' | 'idempotent' | 'funcId-mismatch' | 'mes-mismatch'
//        | 'cross-ref-mismatch' | 'v1-not-in-revision'
function validateConcluirRevisao(before, after, v1, v2Id) {
  // 1. Transição assinado: false → true
  if (!after.assinado || before.assinado) return 'noop-assinado';
  // 2. É uma revisão (possui versaoAnteriorId)
  if (!after.versaoAnteriorId) return 'noop-no-versaoAnteriorId';
  // 3. Status de v2 consistente (se presente, deve ser 'assinado')
  if (after.status !== undefined && after.status !== 'assinado') return 'invalid-v2-status';
  // 4. v1 existe
  if (!v1) return 'v1-not-found';
  // 5. Idempotência: v1 já finalizada
  if (v1.substituido === true && v1.revisaoEmAndamento === false) return 'idempotent';
  // 6. Mesmo funcionário
  if (v1.funcId !== after.funcId) return 'funcId-mismatch';
  // 7. Mesmo período
  if (v1.mes !== after.mes) return 'mes-mismatch';
  // 8. Cross-reference: v1 aponta para esta v2
  if (v1.versaoSucessoraId !== v2Id) return 'cross-ref-mismatch';
  // 9. v1 está em revisão aberta
  if (!v1.revisaoEmAndamento) return 'v1-not-in-revision';
  return 'ok';
}

async function concluirRevisaoEspelhoHandler(event) {
  const after     = event.data.after.data();
  const before    = event.data.before.data();
  const espelhoId = event.params.espelhoId;

  // Gatilho antecipado sem I/O: descarta casos que não precisam de DB
  if (!after.assinado || before.assinado) return;
  const v1Id = after.versaoAnteriorId;
  if (!v1Id) return;

  if (after.status !== undefined && after.status !== 'assinado') {
    console.error(`concluirRevisao: v2.status inválido '${after.status}'. Abortando.`);
    return;
  }

  const v1Ref  = db.collection('espelhos').doc(v1Id);
  const v1Snap = await v1Ref.get();
  const v1     = v1Snap.exists ? v1Snap.data() : null;

  const result = validateConcluirRevisao(before, after, v1, espelhoId);

  if (result === 'idempotent') {
    console.log(`concluirRevisao: v1 ${v1Id} já finalizada (idempotente).`);
    return;
  }
  if (result !== 'ok') {
    const isWarn = result === 'v1-not-in-revision';
    console[isWarn ? 'warn' : 'error'](
      `concluirRevisao: abortando (${result}) v2=${espelhoId} v1Id=${v1Id}`
    );
    return;
  }

  await v1Ref.update({
    revisaoEmAndamento: false,
    substituido:        true,
    substituidoEm:      admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`concluirRevisao: v1 ${v1Id} finalizada (v2=${espelhoId}).`);
}

// ── Exports ───────────────────────────────────────────────────────────────────

exports.registrarPonto          = onCall({ region: REGION }, registrarPontoHandler);
exports.criarContaFuncionario   = onCall({ region: REGION }, criarContaFuncionarioHandler);

// S2: gcQuery exportado para produção.
// Credenciais GC via Secret Manager (definidas com firebase functions:secrets:set).
exports.gcQuery         = onCall({ region: REGION, secrets: ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'] }, gcQueryHandler);
exports._gcQueryHandler = gcQueryHandler;
exports._gcOperacoes   = GC_OPERACOES;   // testes: normalizador oficial (identidade do pedido)

// Expedição P0 — sync CENTRAL de pedidos novos (GestãoClick SOMENTE GET), a cada 1 min.
// Substitui o gcQuery de 15 s por navegador: cria só pedidos inexistentes (create-if-not-exists, nunca sobrescreve);
// as telas recebem pelo listener. FUNCTION_DEPLOYED=NO — publicar só com --only functions:expedicaoSyncPedidos.
exports.expedicaoSyncPedidos = onSchedule({
  schedule:        'every 1 minutes',
  timeZone:        'America/Fortaleza',
  region:          REGION,
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
  timeoutSeconds:  55,
  memory:          '256MiB',
  retryCount:      0,
  maxInstances:    1,
}, async () => {
  try {
    const leitor = expedicaoSync.criarLeitorVendas({ accessToken: process.env.GC_ACCESS_TOKEN, secretToken: process.env.GC_SECRET_ACCESS_TOKEN });
    const r = await expedicaoSync.sincronizar({ db, leitor, dto: GC_OPERACOES.LISTAR_VENDAS.dto, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() });
    console.log(JSON.stringify({ evento: 'expedicao_sync', status: 'OK', ...r }));
  } catch (err) {
    console.error(JSON.stringify({ evento: 'expedicao_sync', status: 'FAILED', erro: String(err.message).slice(0, 200) }));
  }
});

// S3 — Etapa 2: sincronização agendada do Painel Comercial.
// Executa a cada 30 minutos; usa os mesmos secrets GC já configurados no Secret Manager.
exports.syncPainelDisplay = onSchedule({
  schedule:        'every 30 minutes',
  region:          REGION,
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
  timeoutSeconds:  120,
}, syncPainelDisplayHandler);

// S7 — trilha de auditoria append-only (audit_log). Autor derivado do contexto de autenticação do evento / operador gravado no servidor.
// Escrita só por estas Functions (create); Rules negam toda escrita do cliente. Sem TTL/limpeza.
const _aud = () => require('./lib/auditoriaTriggers').fabrica(require('firebase-admin').firestore(), require('firebase-admin').firestore.FieldValue);
exports.auditUsers            = onDocumentWrittenWithAuthContext({ document: 'users/{uid}', region: REGION, retry: true }, ev => _aud().users(ev));
exports.auditSistemaUsuarios  = onDocumentWrittenWithAuthContext({ document: 'sistema_usuarios/{uid}', region: REGION, retry: true }, ev => _aud().sistemaUsuarios(ev));
exports.auditClientes         = onDocumentWrittenWithAuthContext({ document: 'clientes/{clienteId}', region: REGION, retry: true }, ev => _aud().clientes(ev));
exports.auditInteracoesFila   = onDocumentWritten({ document: 'interacoes_fila/{oppId}', region: REGION, retry: true }, ev => _aud().interacoes(ev));


// B3.3 — reativação comercial: job diário 06:00 (Fortaleza) e processador de vendas/cancelamentos (de hora em hora). Ambos NASCEM DESLIGADOS:
// só agem com carteira_comercial_config/reativacao.modo='ATIVO' E carteira_comercial_config/motor.motorAtivo='B3'; verificam a saúde antes de escrever
// (disjuntor desliga o motor sem apagar nada). Kill switch: scripts/b3_desligar.js.
exports.reativacaoDiaria = onSchedule({
  schedule: '0 6 * * *', timeZone: 'America/Fortaleza', region: REGION, timeoutSeconds: 300, memory: '512MiB', retryCount: 0, secrets: ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
}, async () => {
  try {
    const { executarReativacaoDiaria } = require('./lib/reativacaoJob');
    const lookupNome = criarLookupNomeGC({ accessToken: process.env.GC_ACCESS_TOKEN, secretToken: process.env.GC_SECRET_ACCESS_TOKEN });
    const agora = new Date(); const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(agora);
    const r = await executarReativacaoDiaria(db, admin.firestore.FieldValue, { hoje, agoraIso: agora.toISOString(), lookupNome });
    console.log('[reativacao-diaria]', JSON.stringify({ status: r.status, criadas: r.criadas, repetidas: r.repetidas, expiradas: r.expiradas, semNome: r.semNome, violacoes: r.violacoes && r.violacoes.length }));
  } catch (err) { console.error('[reativacao-diaria] ERRO:', err.message); }
});
exports.reativacaoVendas = onSchedule({
  schedule: '50 * * * *', timeZone: 'America/Fortaleza', region: REGION, timeoutSeconds: 300, memory: '512MiB', retryCount: 0,
}, async () => {
  try {
    const { processarVendas } = require('./lib/reativacaoVendas'); const agora = new Date();
    const r = await processarVendas(db, admin.firestore.FieldValue, { agoraIso: agora.toISOString(), runId: 'sch-' + agora.toISOString().slice(0, 13) });
    console.log('[reativacao-vendas]', JSON.stringify({ status: r.status, modo: r.modo, novas: r.novas, aplicadas: r.aplicadas, erros: r.erros && r.erros.length, reversoes: r.reversoes && { executadas: r.reversoes.executadas, ambiguas: r.reversoes.ambiguas } }));
  } catch (err) { console.error('[reativacao-vendas] ERRO:', err.message); }
});

exports.concluirRevisaoEspelho = onDocumentUpdated(
  { document: 'espelhos/{espelhoId}', region: REGION, retry: true },
  concluirRevisaoEspelhoHandler,
);

// N34.5 — Geração agendada do snapshot da fila comercial (a cada 60 min).
// Falha isolada: erro não interrompe sync360 nem syncPainelDisplay.
// FUNCTION_DEPLOYED=NO — deployar manualmente após N34.5 ser aprovado.
exports.gerarFilaSnapshot = onSchedule({
  schedule:        'every 60 minutes',
  region:          REGION,
  timeoutSeconds:  300,
}, async () => {
  try {
    await executarGeracaoFilaSnapshot({ db });
  } catch (err) {
    console.error('[fila-snapshot] ERRO na geração:', err.message);
    // NÃO re-throw — falha isolada, não afeta sync360 nem syncPainelDisplay
  }
});

// N35.15 — Worklist V2 diária (dias úteis, 06:00 America/Fortaleza).
// Modo em lib/filaQueueConfig.js (OFF | DRY_RUN | LIVE). Grava no máximo 1 documento em fila_comercial.
// Nunca cria interacoes_fila (criação é lazy, no claim). Falha isolada: não afeta snapshot nem sync.
exports.gerarWorklistDiaria = onSchedule({
  schedule:        '0 6 * * 1-5',
  timeZone:        'America/Fortaleza',
  region:          REGION,
  timeoutSeconds:  300,
  memory:          '512MiB',
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
}, async () => {
  try {
    const lookupNome = criarLookupNomeGC({
      accessToken: process.env.GC_ACCESS_TOKEN,
      secretToken: process.env.GC_SECRET_ACCESS_TOKEN,
    });
    await executarGeracaoWorklist({ db, lookupNome });
  } catch (err) {
    console.error('[worklist-v2] ERRO na geração:', err.message);
  }
});

// N35.30 — Regra da carteira comercial (R2) em MODO SOMBRA: grava só decisões de sombra (FORCAR_SOMBRA no job).
// De hora em hora (o sync de vendas_gc roda a cada 2 h); sem retry automático; falha isolada.
exports.processarCarteiraComercial = onSchedule({
  schedule:        '45 * * * *',
  timeZone:        'America/Fortaleza',
  region:          REGION,
  timeoutSeconds:  300,
  memory:          '256MiB',
  retryCount:      0,
}, async (event) => {
  try {
    await carteiraRegraJobHandler(event);
  } catch (err) {
    console.error('[carteira-regra] ERRO:', err.message);
  }
});

// Agente Compras & Estoque — Política 1.1 (motor determinístico; GestãoClick SOMENTE GET).
// Manual: HTTP PRIVADO (IAM; sem acesso público), POST { tipo: 'FULL' | 'INCREMENTAL' }.
// Agendados: completo diário (reconciliação) + incremental a cada 3 h — agenda aprovada, America/Fortaleza.
// Trava compartilhada (compras_n0/lock) impede execuções simultâneas; falha preserva o último snapshot válido.
exports.comprasSyncManual = onRequest({
  region:          REGION,
  invoker:         'private',
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
  timeoutSeconds:  1800,
  memory:          '1GiB',
  concurrency:     1,
  maxInstances:    1,
}, (req, res) => comprasEntrypoints.syncManualHandler(req, res, { db }));

exports.comprasSyncCompleto = onSchedule({
  schedule:        comprasEntrypoints.AGENDA.FULL,
  timeZone:        comprasEntrypoints.AGENDA.TIMEZONE,
  region:          REGION,
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
  timeoutSeconds:  1800,
  memory:          '1GiB',
  retryCount:      0,
  maxInstances:    1,
}, () => comprasEntrypoints.syncAgendadoHandler('FULL', { db }));

exports.comprasSyncIncremental = onSchedule({
  schedule:        comprasEntrypoints.AGENDA.INCREMENTAL,
  timeZone:        comprasEntrypoints.AGENDA.TIMEZONE,
  region:          REGION,
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
  timeoutSeconds:  900,
  memory:          '1GiB',
  retryCount:      0,
  maxInstances:    1,
}, () => comprasEntrypoints.syncAgendadoHandler('INCREMENTAL', { db }));

// Agente Financeiro MR4 — Fase 2: sync FULL (GestãoClick SOMENTE GET) → fin_n1 protegido (geração + ponteiro). Sem HTTP, sem callable.
// Agenda 3/3 h (min 40, America/Fortaleza); trava com lease em fin_n1_ctl/lock; falha preserva a geração ativa.
const financeiroEntrypoints = require('./lib/financeiro/entrypoints');
exports.financeiroSync = onSchedule({
  schedule:        financeiroEntrypoints.AGENDA.CRON,
  timeZone:        financeiroEntrypoints.AGENDA.TIMEZONE,
  region:          REGION,
  secrets:         ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'],
  timeoutSeconds:  1800,
  memory:          '1GiB',
  retryCount:      0,
  maxInstances:    1,
}, () => financeiroEntrypoints.syncAgendadoHandler({ db, log: e => console.log(JSON.stringify(e)) }));

// N35.11 — Callables da Fila Comercial (canário operacional)
// CRM 2.0 F1: handlers recebem SÓ `request` (o 2º argumento do onCall v2 é a resposta de streaming, não opções de teste)
exports.claimOpportunity   = onCall({ region: REGION }, req => claimOpportunityHandler(req));
exports.registerOutcome    = onCall({ region: REGION }, req => registerOutcomeHandler(req));
exports.releaseOpportunity = onCall({ region: REGION }, req => releaseOpportunityHandler(req));

// CRM MR4 2.0 — Fase 1: leitura do CRM (Cliente 360, cartões, indicadores). SOMENTE LEITURA; escopo validado no servidor.
const { crmConsultaHandler } = require('./lib/crmConsulta');
exports.crmConsulta        = onCall({ region: REGION }, req => crmConsultaHandler(req));

// B3.1 — gestão da reativação (NÃO CONTATAR, devoluções, reversão). Inativa até receber dados: não cria oportunidades nem muda owner sozinha.
const { reativacaoGestaoHandler } = require('./lib/reativacaoGestaoCallable');
exports.crmReativacaoGestao = onCall({ region: REGION }, req => reativacaoGestaoHandler(req));

// Telefone do cliente nos cartões de reativação: consulta o GestãoClick sob demanda, autoriza ANTES no backend; número nunca é gravado/logado.
exports.crmContatoReativacao = onCall({ region: REGION, secrets: ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'] }, req => {
  const { contatoReativacaoHandler } = require('./lib/contatoReativacao'); const { criarLookupContatoGC } = require('./lib/contatoGc');
  return contatoReativacaoHandler(req, { lookup: criarLookupContatoGC({ accessToken: process.env.GC_ACCESS_TOKEN, secretToken: process.env.GC_SECRET_ACCESS_TOKEN }) });
});


// AI Gateway interno — Agente Comercial (Fase 1). Chamada ao provedor SOMENTE aqui (chave no Secret Manager). Sem ferramentas de escrita.
const { aiAgenteHandler } = require('./lib/ai/gateway/gateway');
exports.aiAgente = onCall({ region: REGION, secrets: ['OPENAI_API_KEY'], timeoutSeconds: 60, memory: '512MiB', maxInstances: 5 }, req => aiAgenteHandler(req));

// Handlers exportados para testes diretos (sem onCall/trigger wrapper)
exports._registrarPontoHandler             = registrarPontoHandler;
exports._criarContaFuncionarioHandler      = criarContaFuncionarioHandler;
exports._syncPainelDisplayHandler          = syncPainelDisplayHandler;
exports._nomeMatchPainel                   = nomeMatchPainel;
exports._fetchTodasVendasGC                = fetchTodasVendasGC;
exports._concluirRevisaoEspelhoHandler     = concluirRevisaoEspelhoHandler;
exports._claimOpportunityHandler           = claimOpportunityHandler;
exports._registerOutcomeHandler            = registerOutcomeHandler;
exports._releaseOpportunityHandler         = releaseOpportunityHandler;
exports._validateConcluirRevisao           = validateConcluirRevisao;
