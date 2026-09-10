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

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { distMetros, fortalezaAgora, validarLatLng } = require('./utils');

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

  // 8. Sequência + gravação em transação
  const registrosRef = db.collection('registros');

  let tipoRegistro    = null;
  let tipoLabel       = null;
  let deterministicId = null; // funcId_data_tipo — garante unicidade atômica

  await db.runTransaction(async (tx) => {
    // 8a. Registros de hoje — sem orderBy (sort em memória; não exige índice na transação)
    const snap = await tx.get(
      registrosRef
        .where('funcId', '==', funcId)
        .where('data',   '==', data),
    );
    const regsHoje = snap.docs
      .map(d => d.data())
      .sort((a, b) => {
        // Quando dois registros têm a mesma hora (ss precision), usa criadoEm como tie-break
        if (a.hora !== b.hora) return a.hora > b.hora ? 1 : -1;
        const ta = a.criadoEm instanceof admin.firestore.Timestamp ? a.criadoEm.toMillis() : 0;
        const tb = b.criadoEm instanceof admin.firestore.Timestamp ? b.criadoEm.toMillis() : 0;
        return ta - tb;
      });

    const ultimo = regsHoje[regsHoje.length - 1];

    // 8b. Próximo tipo na sequência
    if (!ultimo)                               tipoRegistro = 'entrada';
    else if (ultimo.tipo === 'entrada')        tipoRegistro = 'saida_almoco';
    else if (ultimo.tipo === 'saida_almoco')   tipoRegistro = 'retorno_almoco';
    else if (ultimo.tipo === 'retorno_almoco') tipoRegistro = 'saida';
    else throw new HttpsError('failed-precondition', 'Ponto do dia já completo.');

    tipoLabel       = LABEL_PONTO[tipoRegistro];
    // ID determinístico: garante que dois commits simultâneos para o mesmo tipo
    // conflitem atomicamente — Firestore aborta e faz retry; no retry o doc já existe.
    deterministicId = funcId + '_' + data + '_' + tipoRegistro;

    // 8c. Unicidade atômica — lê o doc determinístico para registrá-lo no read-set
    //     da transação. Se outra transação concorrente já o criou, o Firestore vai
    //     abortar esta e reexecutar; na reexecução o exists() vai ser true → already-exists.
    const dupSnap = await tx.get(registrosRef.doc(deterministicId));
    if (dupSnap.exists) {
      throw new HttpsError('already-exists', 'Este tipo de ponto já foi registrado para esta data.');
    }

    // 8d. Cooldown (anti-duplo-clique em rede lenta — segunda camada de proteção)
    if (ultimo) {
      const criadoEm = ultimo.criadoEm instanceof admin.firestore.Timestamp
        ? ultimo.criadoEm.toMillis()
        : (typeof ultimo.criadoEm === 'string' ? new Date(ultimo.criadoEm).getTime() : 0);
      if (Date.now() - criadoEm < COOLDOWN_MS()) {
        throw new HttpsError('resource-exhausted', 'Aguarde alguns segundos antes de registrar outro ponto.');
      }
    }

    // 8e. Grava com ID determinístico dentro da transação
    tx.set(registrosRef.doc(deterministicId), {
      id:          deterministicId,
      funcId,                                              // SERVIDOR
      funcNome:    func.nome || '',                        // SERVIDOR
      authUid:     uid,                                    // SERVIDOR
      modalidade,                                          // SERVIDOR (do banco)
      data,                                                // SERVIDOR
      hora,                                                // SERVIDOR
      tipo:        tipoRegistro,                           // SERVIDOR
      tipoLabel,                                           // SERVIDOR
      lat:         validarLatLng(lat, lng) ? lat  : null, // CLIENTE/AUDITORIA
      lng:         validarLatLng(lat, lng) ? lng  : null, // CLIENTE/AUDITORIA
      dentroRaio,                                          // SERVIDOR (recalculado)
      horaCliente: typeof horaCliente === 'string'
        ? horaCliente.slice(0, 8) : null,                 // CLIENTE/AUDITORIA
      facialScore: typeof facialScore === 'number'
        ? Math.round(facialScore) : null,                 // CLIENTE/AUDITORIA
      foto:        foto && typeof foto === 'string'
        ? foto : null,                                    // CLIENTE/AUDITORIA
      criadoEm:    admin.firestore.FieldValue.serverTimestamp(), // SERVIDOR
    });
  });

  return {
    ok: true, id: deterministicId, tipo: tipoRegistro, tipoLabel, data, hora, dentroRaio, modalidade,
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
//   LISTAR_PRODUTOS        → GET /produtos    (compras, estoque, garantia, calculadora)
//   CONSULTAR_PRODUTO      → GET /produtos/:id (garantia, calculadora)
//   LISTAR_VENDAS          → GET /vendas      (vendas, compras, expedicao)
//   LISTAR_PAGAMENTOS      → GET /pagamentos  (compras)
//   LISTAR_RECEBIMENTOS    → GET /recebimentos (compras)
//   PESQUISAR_CLIENTES     → GET /clientes    (garantia)
//   ATUALIZAR_PRECO        → PUT /produtos/:id (calculadora) — ESCRITA, requer módulo exclusivo
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
    modulo:  ['compras', 'estoque', 'garantia', 'calculadora'],
    metodo:  'GET',
    path:    () => '/produtos',
    params:  (dados) => {
      const p = new URLSearchParams({ limite: String(dados.limite || 100) });
      if (dados.pagina) p.set('pagina', String(dados.pagina));
      if (dados.referencia) p.set('referencia', String(dados.referencia).slice(0, 50));
      return p.toString();
    },
    dto:     (item) => ({
      id:         item.id,
      codigo:     item.codigo || item.referencia || '',
      nome:       item.nome   || '',
      fabricante: item.fabricante || item.marca || '',
    }),
  },
  CONSULTAR_PRODUTO: {
    modulo:  ['garantia', 'calculadora', 'compras'],
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
    dto:     (item) => ({
      id:        item.id,
      numero:    item.numero   || '',
      data:      item.data     || '',
      cliente:   item.cliente  ? { nome: item.cliente.nome || '' } : {},
      valor:     item.valor_total || 0,
      status:    item.status   || '',
      vendedor:  item.vendedor ? { nome: item.vendedor.nome || '' } : {},
    }),
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
      id:         item.id,
      valor:      item.valor        || 0,
      vencimento: item.vencimento   || '',
      situacao:   item.situacao     || '',
      fornecedor: item.fornecedor ? { nome: item.fornecedor.nome || '' } : {},
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
      id:         item.id,
      valor:      item.valor        || 0,
      vencimento: item.vencimento   || '',
      situacao:   item.situacao     || '',
      cliente:    item.cliente ? { nome: item.cliente.nome || '' } : {},
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
  ATUALIZAR_PRECO: {
    modulo:  ['calculadora'],
    metodo:  'PUT',
    path:    (dados) => `/produtos/${encodeURIComponent(String(dados.produtoId))}`,
    params:  () => '',
    // Para escrita, o DTO é o payload enviado ao GC — validado rigorosamente
    dto:     null, // veja lógica de escrita abaixo
  },
};

async function gcQueryHandler(request) {
  // 1. Autenticação obrigatória
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para acessar dados do GestãoClick.');
  }
  const uid = request.auth.uid;

  // 2. Verificar gestor — FAIL CLOSED (lê users/{uid})
  const userDoc = await db.collection('users').doc(uid).get();
  const perfil  = userDoc.exists ? userDoc.data() : null;
  if (!perfil || perfil.role !== 'gestor' || !perfil.ativo) {
    throw new HttpsError('permission-denied', 'Acesso negado. Somente gestores ativos podem consultar o GestãoClick.');
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

  // 8. Para ATUALIZAR_PRECO: validar payload de escrita
  let gcBody = undefined;
  if (operacao === 'ATUALIZAR_PRECO') {
    const precoCusto = parseFloat(dados.preco_custo);
    const precoVenda = dados.preco_venda !== undefined ? parseFloat(dados.preco_venda) : undefined;
    if (isNaN(precoCusto) || precoCusto < 0) {
      throw new HttpsError('invalid-argument', 'preco_custo inválido.');
    }
    gcBody = { preco_custo: Math.round(precoCusto * 100) / 100 };
    if (precoVenda !== undefined && !isNaN(precoVenda) && precoVenda >= 0) {
      gcBody.preco_venda = Math.round(precoVenda * 100) / 100;
    }
  }

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
      ...(gcBody ? { body: JSON.stringify(gcBody) } : {}),
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
  if (operacao === 'ATUALIZAR_PRECO') {
    return { ok: true };
  }

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

// ── Exports ───────────────────────────────────────────────────────────────────

exports.registrarPonto          = onCall({ region: REGION }, registrarPontoHandler);
exports.criarContaFuncionario   = onCall({ region: REGION }, criarContaFuncionarioHandler);

// STATUS S0: gcQuery presente mas NÃO exportado para produção.
// Descomente as duas linhas abaixo em S2 após testes passarem.
// exports.gcQuery              = onCall({ region: REGION }, gcQueryHandler);
// exports._gcQueryHandler      = gcQueryHandler;

// Handlers exportados para testes diretos (sem onCall wrapper)
exports._registrarPontoHandler        = registrarPontoHandler;
exports._criarContaFuncionarioHandler = criarContaFuncionarioHandler;
