// sync-dados.js — Sincroniza vendas, estoque e financeiro do GestãoClick
// Roda via GitHub Actions a cada 2 horas
//
// S1: financeiro_cache e pedidos_cache escritos no Firestore (Admin SDK).
// SECURITY HOTFIX P0 (28/09/2026): vendas, estoque e catálogo deixaram de ser gravados em
//   data/*.json (servidos publicamente pelo GitHub Pages). Agora vão para a coleção protegida
//   painel_cache (Rules: leitura por módulo, escrita só Admin SDK). Nenhum dado comercial é
//   escrito no repositório.
const path = require('path');
const https = require('https');
const gcHttp = require('../functions/lib/gcHttp');   // Etapa A (A2): camada HTTP segura + paginação verificada

const ACCESS_TOKEN  = process.env.GC_ACCESS_TOKEN;
const SECRET_TOKEN  = process.env.GC_SECRET_ACCESS_TOKEN;
const API_BASE      = 'https://api.gestaoclick.com';
const PROJECT_ID    = 'mr4-ponto';

if (!ACCESS_TOKEN || !SECRET_TOKEN) {
  log.erro('❌ Tokens GestãoClick não configurados');
  process.exit(1);
}

// ── INTEGRIDADE DA SINCRONIZAÇÃO (Etapa A · A2) ──────────────────────────────────────────────
// Regras: (1) HTTP inválido interrompe o bloco; (2) paginação incompleta NUNCA vira resultado completo;
// (3) queda > 70% ou vazio com dado anterior bloqueia a PUBLICAÇÃO (Financeiro 70% e Pedidos 80% preservados);
// (4) o último dado válido é preservado em qualquer falha; (5) limites de páginas ABORTAM, nunca truncam;
// (6) qualquer falha/bloqueio faz o workflow terminar com ERRO (process.exitCode = 1).
//
// ATOMICIDADE DAS GRAVAÇÕES (quais documentos são independentes e quais precisam ser gravados juntos):
//   • GRUPO VENDAS   — painel_cache/vendas + painel_cache/caixa + display_metrics/latest: derivam do MESMO conjunto de
//                      vendas e são lidos por telas diferentes ⇒ gravados em UM lote atômico (tudo ou nada).
//   • GRUPO ESTOQUE  — painel_cache/estoque + painel_cache/estoque_custos: mesma leitura de produtos ⇒ UM lote atômico.
//   • INDEPENDENTES  — financeiro_cache/latest, pedidos_cache/latest, painel_cache/produtos_catalogo: cada um vem de
//                      uma consulta própria; uma falha em um não deixa os outros inconsistentes entre si.
//   • Os grupos podem divergir ENTRE SI no tempo (consultas diferentes; falha de um bloco ≠ falha dos outros): isso
//     é aceito e agora VISÍVEL (workflow vermelho + RESUMO_SYNC). Perfil360 (syncPerfil360) é tratado na A3.
const JANELA_VENDAS_DIAS  = 30;
const ESCOPO_VENDAS       = 'loja_262759';          // Etapa B: consulta sempre com loja_id=262759 (antes: 'padrao_sem_loja_id'; mudar o escopo ZERA a referência = 1ª execução)
const LIMITE_QUEDA_PADRAO = 0.70;
const MAX_PAGINAS         = 400;                    // trava de segurança: ABORTA (GC_LIMITE_PAGINAS), nunca trunca
const gcCliente = gcHttp.criarCliente({ transporte: gcHttp.criarTransporteHttps(https), credenciais: { access: ACCESS_TOKEN, secret: SECRET_TOKEN } });
const falhas = [];
const avisos = [];      // eventos de auditoria que NÃO são falha (ex.: vazio de Pedidos corroborado) — só códigos
// A2.1 — leitura de vendas (30 dias) compartilhada com Pedidos como CORROBORAÇÃO do vazio. syncVendas SEMPRE resolve (finally).
let _resolverVendas30; const vendas30Pronta = new Promise(r => { _resolverVendas30 = r; });
let _estadoVendas30 = null;
// A2.2 — LOGS PÚBLICOS (repositório público): SÓ informação operacional — bloco, status, códigos de erro, duração e resultado
// das verificações de integridade. NUNCA valores em R$, contagens de negócio, nomes, identificadores, respostas da API,
// mensagens de exceção (podem conter dados) nem stack traces. Toda saída passa por `log.*`; textos são FIXOS (sem interpolar dados).
// Os testes (sync-dados-a22-logs.test.js) impedem a reintrodução.
const log = {
  info: m => console.log(m),
  aviso: m => console.warn(m),
  erro: m => console.error(m),
};
/** Classificação segura de uma exceção: só um código curto (nunca a mensagem). */
function codigoSeguro(e) {
  if (e && typeof e.codigo === 'string' && /^[A-Z0-9_]{3,60}$/.test(e.codigo)) return e.codigo;
  if (e && (typeof e.code === 'string' || typeof e.code === 'number') && /^[A-Za-z0-9_.-]{1,40}$/.test(String(e.code))) return 'ERRO_' + String(e.code).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return 'ERRO_INESPERADO';
}
process.on('unhandledRejection', e => { log.erro(`🚨 EXCECAO_NAO_TRATADA codigo=${codigoSeguro(e)}`); process.exitCode = 1; });
process.on('uncaughtException', e => { log.erro(`🚨 EXCECAO_NAO_TRATADA codigo=${codigoSeguro(e)}`); process.exit(1); });
function registrarFalha(bloco, codigo, detalhe) {
  falhas.push({ bloco, codigo, detalhe: detalhe || null });
  log.erro(`🚨 FALHA bloco=${bloco} codigo=${codigo}${detalhe ? ' motivo=' + detalhe : ''}`);   // detalhe = SÓ enum de motivo (nunca contagens/dados)
}
/** Lista COMPLETA (ou erro): nunca devolve resultado parcial. */
function lerLista(caminho, params, opcoes = {}) {
  return gcHttp.paginarCompleto(gcCliente, caminho, params, { limite: 100, maxPaginas: MAX_PAGINAS, ...opcoes });
}

// ── RECUPERAÇÃO SEGURA DE ANOMALIAS (quarentena + aceite humano em duas etapas) ───────────────────────────────────
// Detalhes e regras: functions/lib/recuperacaoAnomalias.js. NENHUMA anomalia é aprovada automaticamente: a execução agendada só
// registra leituras/estabilidade; o aceite exige execução MANUAL (workflow_dispatch) em duas etapas. Falha de estado/auditoria ⇒ fail-closed.
const recup = require('../functions/lib/recuperacaoAnomalias');
const ENT = (() => {
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') return { ok: true, acao: 'normal' };   // agendado: SEMPRE normal
  return recup.validarEntradas({ acao: process.env.ACAO_ANOMALIA || 'normal', bloco: process.env.BLOCO_ANOMALIA || '', assinatura8: process.env.ASSINATURA8_ANOMALIA || '', motivo: process.env.MOTIVO_ANOMALIA || '', aprovacaoId: process.env.APROVACAO_ID_ANOMALIA || '' });
})();
const MOTIVOS_DE_QUEDA = new Set(['VAZIO_COM_DADOS_ANTERIORES', 'QUEDA_ACIMA_DO_LIMITE', 'QUEDA_OU_VAZIO_ANOMALO']);
/** Reconciliação por partição (vendas): relê a janela em duas metades e confere união de IDs == leitura completa. null = não se aplica. */
async function particaoVendas(inicio, fim, idsLidos) {
  if (!(inicio < fim)) return null;
  const ms = d => Date.parse(d + 'T00:00:00Z'), dia = m => new Date(m).toISOString().slice(0, 10);
  const meio = dia((ms(inicio) + ms(fim)) / 2), prox = dia(ms(meio) + 86400000);
  const a = await lerLista('/vendas', { data_inicio: inicio, data_fim: meio }, { permitirVazio: true });
  const b = await lerLista('/vendas', { data_inicio: prox, data_fim: fim }, { permitirVazio: true });
  const uni = new Set([...a.itens, ...b.itens].map(x => String(x.id))), lidos = new Set(idsLidos.map(String));
  return uni.size === lidos.size && [...uni].every(i => lidos.has(i));
}
/** Decide a publicação à luz da recuperação. `av` = {publicar, motivo}. Devolve {publicar, motivo}; qualquer erro ⇒ mantém `av` (bloqueio). */
async function recuperar(bloco, av, ctx) {
  const db = initFirestore(); if (!db) return av;
  const agoraMs = Date.now(), ator = String(process.env.GITHUB_ACTOR || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 39) || 'github';
  const runId = /^\d{1,20}$/.test(String(process.env.GITHUB_RUN_ID || '')) ? String(process.env.GITHUB_RUN_ID) : null;
  try {
    const est = await recup.lerEstado(db, bloco);
    const gravar = async (estado, eventos) => { if (estado) await recup.gravarEstado(db, estado); for (const ev of eventos) await recup.auditar(db, ev, agoraMs, ator); };
    if (av.publicar) { const r = recup.registrarNormal(est, { bloco, total: ctx.total }); if (r.eventos.length) await gravar(r.estado, r.eventos); return av; }
    if (!MOTIVOS_DE_QUEDA.has(av.motivo)) return av;                       // referência ilegível etc.: não é queda de volume
    let particaoOk = null; if (ctx.particao) { try { particaoOk = await ctx.particao(); } catch (_) { particaoOk = false; } }
    const r = recup.registrarBloqueio(est, { bloco, agoraMs, total: ctx.total, ids: ctx.ids || [], escopo: ctx.escopo, janelaInicio: ctx.janelaInicio, janelaFim: ctx.janelaFim, janelaDias: ctx.janelaDias, referencia: ctx.referencia, motivo: av.motivo, particaoOk });
    let estado = r.estado; const eventos = [...r.eventos]; let decisao = av;
    const estQ = estado.estado, estavelQ = estado.estavel, sig8 = r.assinatura8, pendQ = r.estabilidade.estavel ? '' : ' PENDENCIAS=' + r.estabilidade.motivos.join(',');   // enums/hash curto: nenhum dado do negócio
    log.info(`  🛑 ${bloco}: QUARENTENA estado=${estQ} ESTAVEL=${estavelQ} ASSINATURA8=${sig8}${pendQ}`);
    if (ENT.ok && ENT.bloco === bloco && ENT.acao === 'solicitar_aceite') {
      const x = recup.solicitarAceite(estado, { assinatura8: ENT.assinatura8, motivo: ENT.motivo, ator, agoraMs, runId }); estado = x.estado; eventos.push(...x.eventos);
      const codAceite = x.codigo, idAprovTxt = x.ok ? ' ID_APROVACAO=' + x.aprovacaoId : '';
      log.info(`  ↪ aceite (etapa A): ${codAceite}${idAprovTxt}`);
    } else if (ENT.ok && ENT.bloco === bloco && ENT.acao === 'confirmar_aceite') {
      const x = recup.confirmarAceite(estado, { id: ENT.aprovacaoId, assinatura8: ENT.assinatura8, ator, agoraMs, leituraAtual: { completa: true, assinatura8: r.assinatura8, particaoOk }, runId });
      estado = x.estado; eventos.push(...x.eventos); const codAceiteB = x.codigo; log.info(`  ↪ aceite (etapa B): ${codAceiteB}`);
      if (x.ok && x.publicar) decisao = { publicar: true, motivo: 'APROVADO_HUMANO', quedaPct: null };
    }
    await gravar(estado, eventos);      // fail-closed: se isto lançar, cai no catch e o bloqueio é mantido
    return decisao;
  } catch (e) {
    log.aviso(`⚠️  recuperação de anomalias (${bloco}) indisponível (codigo=${codigoSeguro(e)}) — bloqueio mantido`);
    return av;
  }
}

// ── FIRESTORE (opcional) ──────────────────────────────────────────────────────
// Usa @google-cloud/firestore que suporta nativamente:
//   - GOOGLE_APPLICATION_CREDENTIALS com arquivo external_account (WIF/OIDC)
//   - FIREBASE_SERVICE_ACCOUNT (JSON da SA, fallback local)
//   - ADC padrão (gcloud application-default)
// Se nenhum disponível: os caches protegidos (painel_cache, financeiro_cache, pedidos_cache,
// display_metrics) não são atualizados — nenhum dado comercial é gravado em arquivo público.
let _db = null;

function initFirestore() {
  if (_db) return _db;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const opts = { projectId: PROJECT_ID };
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (sa) {
      // Fallback local: chave JSON explícita
      const { GoogleAuth } = require('google-auth-library');
      opts.auth = new GoogleAuth({
        credentials: JSON.parse(sa),
        scopes: ['https://www.googleapis.com/auth/datastore'],
      });
    }
    // Sem SA: usa GOOGLE_APPLICATION_CREDENTIALS (WIF/ADC) automaticamente
    _db = new Firestore(opts);
    return _db;
  } catch(e) {
    log.aviso(`⚠️  Firestore falhou ao inicializar (codigo=${codigoSeguro(e)})`);
    return null;
  }
}

/** Lê o documento de REFERÊNCIA. Distingue "não existe" (1ª execução ⇒ dados=null) de "falha de leitura" (ok=false):
 *  falha de leitura NUNCA é tratada como primeira execução (a publicação é bloqueada). */
async function firestoreLerReferencia(colecao, docId) {
  const db = initFirestore();
  if (!db) return { ok: false, dados: null };
  try {
    const snap = await db.collection(colecao).doc(docId).get();
    return { ok: true, dados: snap.exists ? snap.data() : null };
  } catch(e) {
    log.aviso(`⚠️  Firestore.get(${colecao}/${docId}) falhou (codigo=${codigoSeguro(e)})`);
    return { ok: false, dados: null };
  }
}

async function firestoreSet(colecao, docId, dados) {
  const db = initFirestore();
  if (!db) return false;
  try {
    await db.collection(colecao).doc(docId).set(dados);
    return true;
  } catch(e) {
    log.aviso(`⚠️  Firestore.set(${colecao}/${docId}) falhou (codigo=${codigoSeguro(e)})`);
    return false;
  }
}

/** Gravação ATÔMICA de vários documentos (tudo ou nada). Devolve true/false; nada é gravado se qualquer um falhar. */
async function firestoreBatchSet(ops) {
  const db = initFirestore();
  if (!db) return false;
  try {
    const lote = db.batch();
    for (const o of ops) lote.set(db.collection(o.col).doc(o.id), o.dados);
    await lote.commit();
    return true;
  } catch(e) {
    log.aviso(`⚠️  Firestore.batch(${ops.map(o => o.col + '/' + o.id).join(', ')}) falhou (codigo=${codigoSeguro(e)})`);
    return false;
  }
}

// ── GC FETCH ─────────────────────────────────────────────────────────────────
// (Etapa A · A2) fetchGC/chamarGCComRetry foram SUBSTITUÍDOS por lib/gcHttp (status HTTP, formato da resposta,
// 429/Retry-After, paginação completa ou erro). Ver gcCliente e lerLista acima.

// ── SANITIZAÇÃO DE DADOS PESSOAIS ─────────────────────────────────────────────
// Remove número de cadastro (CPF parcial / registro comercial) que precede o nome
// do cliente. Ex: "52.011.584 PEDRO DE OLIVEIRA ARAUJO" → "PEDRO DE OLIVEIRA ARAUJO"
// LGPD Art. 6º: minimização de dados expostos no Firestore.
function sanitizarCliente(nome) {
  if (!nome || nome === '—') return nome || '—';
  // Padrão: 2-14 dígitos/pontos/barras/hífens seguidos de espaço + nome
  return nome.replace(/^[\d.\/\-]{5,}\s+/, '').trim() || nome;
}

// ── DETECÇÃO DE ANOMALIA ──────────────────────────────────────────────────────
// Retorna true se a detecção identificar dados suspeitos e o cache Firestore deve
// ser PRESERVADO (não sobrescrito).
// Regra: NÃO sobrescrever o último cache válido se GC retornar dados suspeitos.
function detectarAnomalia(nome, totalNovo, totalAnterior, limiteQuedaPct = 0.70) {
  const av = gcHttp.avaliarPublicacao({ novo: totalNovo, anterior: totalAnterior, limiteQuedaPct });
  if (!av.publicar) {
    log.aviso(`🚨 ANOMALIA ${nome}: ${av.motivo} — preservando cache`);
    return true;
  }
  return false;
}

/** Referência de volume de vendas: _meta.vendasTotal do último documento PUBLICADO, só se a janela e o escopo forem os mesmos.
 *  Sem referência válida (1ª execução, documento antigo sem _meta, escopo diferente) ⇒ null ⇒ publica. */
function referenciaVendasAnterior(doc) {
  const m = doc && doc._meta;
  if (!m || m.janelaDias !== JANELA_VENDAS_DIAS || m.escopo !== ESCOPO_VENDAS) return null;
  return Number.isFinite(m.vendasTotal) && m.vendasTotal >= 0 ? m.vendasTotal : null;
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function brl(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
}

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
}

function dataISO() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' })).toISOString().slice(0,19);
}

// ── Datas úteis ──────────────────────────────────────────────────────────────
function hoje() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  return d.toISOString().slice(0,10);
}

function inicioSemana() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  const dia = d.getDay(); // 0=dom
  d.setDate(d.getDate() - (dia === 0 ? 6 : dia - 1));
  return d.toISOString().slice(0,10);
}

function inicioMes() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

function diasAtras(n) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0,10);
}

// ── VENDAS ───────────────────────────────────────────────────────────────────
async function syncVendas() {
  try { await syncVendasCorpo(); } finally { _resolverVendas30(_estadoVendas30); }
}
async function syncVendasCorpo() {
  log.info('📊 Sincronizando vendas...');
  const META_MES    = 200000;
  const META_DIA    = 8000;
  const META_SEMANA = 40000;

  let vendas = [];
  try {
    const inicio = diasAtras(JANELA_VENDAS_DIAS);
    const r = await lerLista('/vendas', { data_inicio: inicio, data_fim: hoje() });
    vendas = r.itens;
    log.info('  → leitura de vendas completa e íntegra');
  } catch(e) {
    log.info('⚠️ Erro ao buscar vendas: '+codigoSeguro(e));
    registrarFalha('vendas', codigoSeguro(e));
    // GC falhou ou devolveu resposta inválida/incompleta: não sobrescreve os caches protegidos (preserva o último válido)
    log.info('  ↩ Mantendo painel_cache/vendas, painel_cache/caixa e display_metrics inalterados');
    return;
  }

  // Proteção de publicação: queda > 70% (ou vazio) em relação à referência _meta.vendasTotal (mesma janela e escopo)
  const refVendas = await firestoreLerReferencia('painel_cache', 'vendas');
  const anteriorVendas = refVendas.ok ? referenciaVendasAnterior(refVendas.dados) : null;
  const avVendas = refVendas.ok
    ? gcHttp.avaliarPublicacao({ novo: vendas.length, anterior: anteriorVendas, limiteQuedaPct: LIMITE_QUEDA_PADRAO })
    : { publicar: false, motivo: 'REFERENCIA_ILEGIVEL' };
  const decVendas = await recuperar('vendas', avVendas, { total: vendas.length, ids: vendas.map(v => v.id), escopo: ESCOPO_VENDAS, janelaInicio: diasAtras(JANELA_VENDAS_DIAS), janelaFim: hoje(), janelaDias: JANELA_VENDAS_DIAS, referencia: anteriorVendas, particao: () => particaoVendas(diasAtras(JANELA_VENDAS_DIAS), hoje(), vendas.map(v => v.id)) });
  if (!decVendas.publicar) {
    registrarFalha('vendas', 'PUBLICACAO_BLOQUEADA', avVendas.motivo);
    log.info('  ↩ Mantendo painel_cache/vendas, painel_cache/caixa e display_metrics inalterados');
    return;
  }
  // A2.1: leitura íntegra e aprovada ⇒ serve de corroboração (só datas e contagem; nenhum dado pessoal)
  const dataDe = v => String(v.data || v.data_venda || v.data_pedido || '').slice(0, 10);
  _estadoVendas30 = { integra: true, escopo: ESCOPO_VENDAS, inicio: diasAtras(JANELA_VENDAS_DIAS), fim: hoje(), datas: vendas.map(dataDe).filter(Boolean), semData: vendas.filter(v => !dataDe(v)).length };

  const hojStr  = hoje();
  const semStr  = inicioSemana();
  const mesStr  = inicioMes();

  let fatHoje = 0, fatSemana = 0, fatMes = 0;
  const vendedorMap    = {};  // para vendas.json (todos os status)
  const vendedorMapDM  = {};  // para display_metrics (Concretizados = situacao_id 3952593)
  const diaMap = {};

  const SITUACAO_CONCRETIZADO = '3952593';

  vendas.forEach(p => {
    const data  = (p.data || p.data_venda || p.data_pedido || '').slice(0,10);
    const valor = Number(p.valor_total || p.total || p.valor || 0);
    const vend  = p.nome_vendedor || p.vendedor || p.nome_usuario || 'Outros';

    if (data === hojStr)   fatHoje   += valor;
    if (data >= semStr)    fatSemana += valor;
    if (data >= mesStr)    fatMes    += valor;

    if (!vendedorMap[vend]) vendedorMap[vend] = { nome: vend, faturamento: 0, pedidos: 0 };
    vendedorMap[vend].faturamento += valor;
    vendedorMap[vend].pedidos++;

    if (!diaMap[data]) diaMap[data] = 0;
    diaMap[data] += valor;

    // display_metrics — apenas Concretizados
    if (String(p.situacao_id) === SITUACAO_CONCRETIZADO || String(p.situacao) === SITUACAO_CONCRETIZADO) {
      if (!vendedorMapDM[vend]) vendedorMapDM[vend] = { nome: vend, total_mes: 0, total_hoje: 0, pedidos_mes: 0, pedidos_hoje: 0 };
      vendedorMapDM[vend].total_mes    += valor;
      vendedorMapDM[vend].pedidos_mes  += 1;
      if (data === hojStr) {
        vendedorMapDM[vend].total_hoje   += valor;
        vendedorMapDM[vend].pedidos_hoje += 1;
      }
    }
  });

  const ultimos7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = diasAtras(i);
    const label = new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'2-digit' });
    ultimos7.push({ data: d, label, valor: diaMap[d] || 0 });
  }

  const vendedores = Object.values(vendedorMap)
    .sort((a,b) => b.faturamento - a.faturamento)
    .map(v => ({
      ...v,
      ticket_medio: v.pedidos > 0 ? v.faturamento / v.pedidos : 0
    }));

  const dadosVendas = {
    atualizado_em: dataISO(),
    hoje:     fatHoje,
    semana:   fatSemana,
    mes:      fatMes,
    meta_mes: META_MES,
    meta_dia: META_DIA,
    meta_semana: META_SEMANA,
    vendedores,
    ultimos_7_dias: ultimos7,
    // Campo ADITIVO (as telas não o usam): referência de volume para a próxima proteção. Só é gravado junto com uma
    // publicação aprovada e completa — execução parcial/bloqueada/falha NUNCA o atualiza.
    _meta: { vendasTotal: vendas.length, janelaDias: JANELA_VENDAS_DIAS, escopo: ESCOPO_VENDAS, sincronizadoEm: dataISO() },
  };

  // SECURITY HOTFIX P0: antes em data/vendas.json (público). Agora protegido:
  //   painel_cache/vendas — dashboard de vendas (faturamento, metas, vendedores): gestor + módulo vendas/admin
  //   painel_cache/caixa  — só o necessário ao Caixa Diário (faturamento de hoje): gestor + módulo caixa/admin
  // display_metrics — painel de TV (Rules: perfil 'display' ativo ou gestor)
  const dmVendedores = Object.values(vendedorMapDM)
    .sort((a,b) => b.total_mes - a.total_mes)
    .map(v => ({
      ...v,
      ticket_mes:   v.pedidos_mes  > 0 ? v.total_mes  / v.pedidos_mes  : 0,
      ticket_hoje:  v.pedidos_hoje > 0 ? v.total_hoje / v.pedidos_hoje : 0,
    }));
  const dmDoc = {
    atualizado_em: dataISO(),
    mes:           mesStr,
    meta_mes:      META_MES,
    faturamento_mes: fatMes,
    pct_meta:      META_MES > 0 ? Math.round((fatMes / META_MES) * 1000) / 10 : 0,
    vendedores:    dmVendedores,
  };
  // GRUPO VENDAS: gravação ATÔMICA (tudo ou nada) — vendas, caixa e display_metrics precisam ficar consistentes entre si
  const vOk = await firestoreBatchSet([
    { col: 'painel_cache',    id: 'vendas', dados: dadosVendas },
    { col: 'painel_cache',    id: 'caixa',  dados: { atualizado_em: dadosVendas.atualizado_em, hoje: fatHoje } },
    { col: 'display_metrics', id: 'latest', dados: dmDoc },
  ]);
  if (vOk) {
    log.info('✅ Vendas publicadas');
    log.info('✅ display_metrics publicado');
  } else {
    registrarFalha('vendas', 'GRAVACAO_FALHOU');
    log.info('❌ Vendas: FALHA ao gravar painel_cache/display_metrics (lote atômico: nenhum documento foi alterado)');
  }
}

// ── ESTOQUE ──────────────────────────────────────────────────────────────────
async function syncEstoque() {
  log.info('🗄️ Sincronizando estoque...');
  let produtos = [];

  try {
    const r = await lerLista('/produtos', { ativo: 1 });
    produtos = r.itens;
  } catch(e) {
    log.info('⚠️ Erro ao buscar produtos: '+codigoSeguro(e));
    registrarFalha('estoque', codigoSeguro(e));
    log.info('  ↩ Mantendo painel_cache/estoque e painel_cache/estoque_custos inalterados');
    return;
  }

  // Proteção de publicação: queda > 70% (ou vazio) em relação a painel_cache/estoque.total_produtos
  const refEstoque = await firestoreLerReferencia('painel_cache', 'estoque');
  const anteriorEstoque = refEstoque.ok && refEstoque.dados && Number.isFinite(refEstoque.dados.total_produtos) ? refEstoque.dados.total_produtos : null;
  const avEstoque = refEstoque.ok
    ? gcHttp.avaliarPublicacao({ novo: produtos.length, anterior: anteriorEstoque, limiteQuedaPct: LIMITE_QUEDA_PADRAO })
    : { publicar: false, motivo: 'REFERENCIA_ILEGIVEL' };
  const decEstoque = await recuperar('estoque', avEstoque, { total: produtos.length, ids: produtos.map(p => p.id), escopo: 'loja_262759', janelaInicio: '', janelaFim: '', janelaDias: null, referencia: anteriorEstoque });
  if (!decEstoque.publicar) {
    registrarFalha('estoque', 'PUBLICACAO_BLOQUEADA', avEstoque.motivo);
    log.info('  ↩ Mantendo painel_cache/estoque e painel_cache/estoque_custos inalterados');
    return;
  }

  let valorTotal = 0;
  const abaixoMinimo = [];
  const semGiro      = [];
  const margemBaixa  = [];

  const hoje90 = diasAtras(90);

  produtos.forEach(p => {
    const estoque  = Number(p.estoque || 0);
    const custo    = Number(p.valor_custo || 0);
    const venda    = Number(p.valor_venda || 0);
    const minimo   = Number(p.estoque_minimo || p.qtd_minima || 0);
    const ref      = p.codigo_interno || p.codigo || '—';
    const nome     = p.nome || '—';
    const margem   = venda > 0 ? ((venda - custo) / venda * 100) : 0;
    const ultVenda = (p.ultima_venda || '').slice(0,10);

    valorTotal += estoque * custo;

    if (minimo > 0 && estoque < minimo) {
      abaixoMinimo.push({ ref, nome, estoque, minimo, falta: minimo - estoque });
    }

    if (estoque > 0 && ultVenda && ultVenda < hoje90) {
      const dias = Math.floor((Date.now() - new Date(ultVenda).getTime()) / 86400000);
      semGiro.push({ ref, nome, ultima_venda: ultVenda, dias, estoque });
    }

    if (venda > 0 && margem < 25) {
      margemBaixa.push({ ref, nome, margem: margem.toFixed(1), preco: venda, custo });
    }
  });

  // SECURITY HOTFIX P0: antes em data/estoque.json (público, com custo). Menor privilégio:
  //   painel_cache/estoque        — operacional (sem custo/preço): módulo estoque (gestor ou funcionário)
  //   painel_cache/estoque_custos — valor do estoque e margem (custo/preço): gestor + módulo estoque/admin
  const atualizadoEm = dataISO();
  const estoqueOperacional = {
    atualizado_em:  atualizadoEm,
    total_produtos: produtos.length,
    abaixo_minimo:  abaixoMinimo.slice(0, 50),
    sem_giro:       semGiro.sort((a,b) => b.dias - a.dias).slice(0, 50),
  };
  const estoqueCustos = {
    atualizado_em:       atualizadoEm,
    valor_total_estoque: valorTotal,
    margem_baixa:        margemBaixa.sort((a,b) => a.margem - b.margem).slice(0, 50),
  };
  // GRUPO ESTOQUE: gravação ATÔMICA (tudo ou nada) — operacional e custos derivam da mesma leitura
  const eOk = await firestoreBatchSet([
    { col: 'painel_cache', id: 'estoque',        dados: estoqueOperacional },
    { col: 'painel_cache', id: 'estoque_custos', dados: estoqueCustos },
  ]);
  if (!eOk) registrarFalha('estoque', 'GRAVACAO_FALHOU');
  log.info(`${eOk ? '✅ Estoque publicado' : '❌ Estoque: FALHA ao gravar painel_cache (lote atômico: nenhum documento foi alterado)'}`);
}

// ── FINANCEIRO ───────────────────────────────────────────────────────────────
async function syncFinanceiro() {
  log.info('💰 Sincronizando financeiro...');
  let lancamentos = [];

  try {
    const inicio = diasAtras(60);
    const fim    = diasAtras(-30);
    // permitirVazio: SÓ aqui — ausência de lançamentos na janela é legítima; a proteção abaixo impede que um vazio
    // (ou queda > 70%) sobrescreva dados financeiros válidos já publicados.
    const r = await lerLista('/pagamentos', { data_inicio: inicio, data_fim: fim }, { permitirVazio: true });
    lancamentos = r.itens;
    log.info('  → leitura de pagamentos completa e íntegra');
  } catch(e) {
    log.info('⚠️ Erro ao buscar pagamentos: '+codigoSeguro(e));
    registrarFalha('financeiro', codigoSeguro(e));
    // GC falhou: não sobrescreve o cache Firestore (preservar último válido)
    log.info('  ↩ Mantendo financeiro_cache/latest inalterado');
    return;
  }

  const hojStr = hoje();
  const em7    = diasAtras(-7);

  let totalVencido = 0, totalPagar = 0, totalReceber = 0;
  const vencidas = [], vencendo = [];

  lancamentos.forEach(c => {
    const venc      = (c.data_vencimento || '').slice(0,10);
    const valor     = Number(c.valor || 0);
    const nome      = c.nome_cliente || c.nome_fornecedor || c.descricao || c.observacao || '—';
    const liquidado = c.liquidado === '1' || c.liquidado === true;
    const entidade  = c.entidade || '';
    const tipo      = entidade === 'I' ? 'Receber' : 'Pagar';

    if (liquidado) return;

    if (entidade === 'O') totalPagar    += valor;
    if (entidade === 'I') totalReceber  += valor;

    if (venc < hojStr) {
      totalVencido += valor;
      const dias = Math.floor((Date.now() - new Date(venc).getTime()) / 86400000);
      vencidas.push({ nome, valor, vencimento: venc, dias_atraso: dias, tipo });
    } else if (venc <= em7) {
      vencendo.push({ nome, valor, vencimento: venc, tipo });
    }
  });

  const inadimplencia = totalReceber > 0
    ? ((vencidas.filter(v=>v.tipo==='Receber').reduce((s,v)=>s+v.valor,0) / totalReceber) * 100).toFixed(1)
    : 0;

  const financeiro = {
    atualizado_em:     dataISO(),
    contas_vencidas:   vencidas.sort((a,b) => b.dias_atraso - a.dias_atraso),
    contas_vencendo:   vencendo.sort((a,b) => a.vencimento.localeCompare(b.vencimento)),
    fluxo_caixa:       [],
    inadimplencia_pct: Number(inadimplencia),
    total_vencido:     totalVencido,
    total_a_receber:   totalReceber,
    total_a_pagar:     totalPagar,
  };

  // ── Detecção de anomalia ──────────────────────────────────────────────────
  const refFin = await firestoreLerReferencia('financeiro_cache', 'latest');
  if (!refFin.ok) {
    registrarFalha('financeiro', 'PUBLICACAO_BLOQUEADA', 'REFERENCIA_ILEGIVEL');
    log.info('  ↩ financeiro_cache/latest preservado (referência ilegível)');
    return;
  }
  const totalAnterior = refFin.dados ? (refFin.dados._meta?.lancamentosTotal ?? null) : null;
  let anomalia = detectarAnomalia('financeiro', lancamentos.length, totalAnterior, 0.70);
  const decFin = await recuperar('financeiro', anomalia ? { publicar: false, motivo: 'QUEDA_OU_VAZIO_ANOMALO' } : { publicar: true, motivo: 'OK' }, { total: lancamentos.length, ids: lancamentos.map((l, i) => String(l.id ?? l.codigo ?? i)), escopo: 'loja_262759', janelaInicio: '', janelaFim: '', janelaDias: null, referencia: totalAnterior });
  if (anomalia && decFin.publicar) anomalia = false;
  if (anomalia) {
    // GC retornou quantidade drasticamente menor — NÃO sobrescrever Firestore (e gerar alerta)
    registrarFalha('financeiro', 'PUBLICACAO_BLOQUEADA', 'QUEDA_OU_VAZIO_ANOMALO');
    log.info('  ↩ financeiro_cache/latest preservado (anomalia detectada)');
    return;
  }

  // ── Escrita Firestore ─────────────────────────────────────────────────────
  const docFirestore = {
    ...financeiro,
    _meta: {
      lancamentosTotal: lancamentos.length,
      sincronizadoEm:   dataISO(),
    },
  };
  const ok = await firestoreSet('financeiro_cache', 'latest', docFirestore);

  if (ok) {
    log.info('✅ Financeiro publicado');
  } else {
    registrarFalha('financeiro', 'GRAVACAO_FALHOU');
    log.info('⚠️  Financeiro: Firestore indisponível');
  }
}

// ── PEDIDOS (Expedição) ───────────────────────────────────────────────────────
async function syncPedidos() {
  log.info('🚚 Sincronizando pedidos para expedição...');
  let vendas = [];
  let vazioCorroborado = false;

  try {
    const inicio = diasAtras(2);
    const fim = hoje();
    // permitirVazio: SÓ para obter a resposta vazia válida; ela só é ACEITA com corroboração independente (A2.1, abaixo)
    const r = await lerLista('/vendas', { data_inicio: inicio, data_fim: fim }, { permitirVazio: true });
    vendas = r.itens;
    log.info('  → leitura de pedidos completa e íntegra');
    if (r.vazio) {
      const vendas30 = await vendas30Pronta;
      const av = gcHttp.avaliarVazioPedidos({ vendas30, janela: { escopo: ESCOPO_VENDAS, inicio, fim } });
      if (!av.aceitar) {
        log.info(`  ⚠️ Pedidos vazio NÃO corroborado (${av.motivo}) — preservando pedidos_cache/latest`);
        const err = new gcHttp.GcErro(gcHttp.CODIGOS.VAZIO_INESPERADO, `vazio de Pedidos não corroborado: ${av.motivo}`, { caminho: '/vendas' });
        throw err;
      }
      vazioCorroborado = true;
      avisos.push({ bloco: 'pedidos', codigo: 'PEDIDOS_VAZIO_CORROBORADO' });
      log.info('  ℹ️ Pedidos vazio LEGÍTIMO: leitura longa de vendas íntegra e sem vendas na janela de Pedidos (corroborado)');
    }
  } catch(e) {
    log.info('⚠️ Erro ao buscar pedidos: '+codigoSeguro(e));
    registrarFalha('pedidos', codigoSeguro(e));
    log.info('  ↩ Mantendo pedidos_cache/latest inalterado');
    return;
  }

  const pedidos = vendas.map(p => {
    const dataHora = p.data_hora || p.data_criacao || p.created_at || p.data_pedido || '';
    const dataBase = (p.data || p.data_venda || p.data_pedido || '').slice(0, 10);
    const horaMatch = dataHora.match(/(\d{2}:\d{2})/);
    const hora = horaMatch ? horaMatch[1] : '';

    return {
      id:        String(p.id || ''),
      numero:    String(p.codigo || p.numero || p.codigo_venda || p.id || ''),
      data:      dataBase,
      hora:      hora,
      // sanitizarCliente remove número de cadastro antes do nome (LGPD Art. 6º)
      cliente:   sanitizarCliente(p.nome_cliente || p.cliente || p.razao_social || '—'),
      vendedor:  p.nome_vendedor || p.vendedor || p.nome_usuario || '—',
      valor:     Number(p.valor_total || p.total || p.valor || 0),
      itens:     Number(p.quantidade_produtos || (p.produtos || []).length || 0),
      status_gc: p.status || p.situacao || '',
      cidade:    p.cidade_cliente || p.cidade || '',
    };
  });

  pedidos.sort((a, b) => b.data.localeCompare(a.data) || b.numero.localeCompare(a.numero));

  const out = {
    atualizado_em: dataISO(),
    total: pedidos.length,
    pedidos,
  };

  // ── Detecção de anomalia ──────────────────────────────────────────────────
  const refPed = await firestoreLerReferencia('pedidos_cache', 'latest');
  if (!refPed.ok) {
    registrarFalha('pedidos', 'PUBLICACAO_BLOQUEADA', 'REFERENCIA_ILEGIVEL');
    log.info('  ↩ pedidos_cache/latest preservado (referência ilegível)');
    return;
  }
  const totalAnterior = refPed.dados ? (refPed.dados._meta?.pedidosTotal ?? null) : null;
  // vazio corroborado (A2.1) é ausência legítima de vendas: a confirmação independente substitui a regra de queda; demais quedas seguem protegidas
  let anomalia = vazioCorroborado ? false : detectarAnomalia('pedidos', pedidos.length, totalAnterior, 0.80);
  const decPed = await recuperar('pedidos', anomalia ? { publicar: false, motivo: 'QUEDA_OU_VAZIO_ANOMALO' } : { publicar: true, motivo: 'OK' }, { total: pedidos.length, ids: pedidos.map((p, i) => String(p.numero ?? p.id ?? i)), escopo: 'loja_262759', janelaInicio: '', janelaFim: '', janelaDias: null, referencia: totalAnterior });
  if (anomalia && decPed.publicar) anomalia = false;
  if (anomalia) {
    registrarFalha('pedidos', 'PUBLICACAO_BLOQUEADA', 'QUEDA_OU_VAZIO_ANOMALO');
    log.info('  ↩ pedidos_cache/latest preservado (anomalia detectada)');
    return;
  }

  // ── Escrita Firestore ─────────────────────────────────────────────────────
  const docFirestore = {
    ...out,
    _meta: {
      pedidosTotal:   pedidos.length,
      sincronizadoEm: dataISO(),
    },
  };
  const ok = await firestoreSet('pedidos_cache', 'latest', docFirestore);

  if (ok) {
    log.info('✅ Pedidos publicado');
  } else {
    registrarFalha('pedidos', 'GRAVACAO_FALHOU');
    log.info('⚠️  Pedidos: Firestore indisponível');
  }
}

// ── CATÁLOGO DE PRODUTOS (para busca local por nome e código) ─────────────────
async function syncCatalogoProdutos() {
  log.info('📦 Sincronizando catálogo de produtos...');
  let produtos = [];
  try {
    const r = await lerLista('/produtos', { ativo: 1 });
    produtos = r.itens;
  } catch(e) {
    log.info('⚠️ Erro ao buscar catálogo: ' + codigoSeguro(e));
    registrarFalha('catalogo', codigoSeguro(e));
    log.info('  ↩ Mantendo painel_cache/produtos_catalogo inalterado');
    return;
  }

  const catalogo = produtos.map(p => ({
    id:        p.id,
    codigo:    p.codigo_interno || p.codigo || '',
    nome:      p.nome || '',
    fabricante: p.marca || p.fabricante || '',
  })).filter(p => p.codigo || p.nome);

  // Proteção de publicação: queda > 70% (ou vazio) em relação a produtos_catalogo.total
  const refCat = await firestoreLerReferencia('painel_cache', 'produtos_catalogo');
  const anteriorCat = refCat.ok && refCat.dados && Number.isFinite(refCat.dados.total) ? refCat.dados.total : null;
  const avCat = refCat.ok
    ? gcHttp.avaliarPublicacao({ novo: catalogo.length, anterior: anteriorCat, limiteQuedaPct: LIMITE_QUEDA_PADRAO })
    : { publicar: false, motivo: 'REFERENCIA_ILEGIVEL' };
  const decCat = await recuperar('catalogo', avCat, { total: catalogo.length, ids: catalogo.map(p => p.codigo || p.nome), escopo: 'loja_262759', janelaInicio: '', janelaFim: '', janelaDias: null, referencia: anteriorCat });
  if (!decCat.publicar) {
    registrarFalha('catalogo', 'PUBLICACAO_BLOQUEADA', avCat.motivo);
    log.info('  ↩ Mantendo painel_cache/produtos_catalogo inalterado');
    return;
  }

  // SECURITY HOTFIX P0: antes em data/produtos.json (público). Agora painel_cache/produtos_catalogo
  // (autocomplete da aba Equivalentes do Estoque): módulo estoque. ~100 B por item → limite de 1 MiB do
  // documento comporta ~8.000 produtos; hoje ~900.
  const pOk = await firestoreSet('painel_cache', 'produtos_catalogo', { atualizado_em: dataISO(), total: catalogo.length, itens: catalogo });
  if (!pOk) registrarFalha('catalogo', 'GRAVACAO_FALHOU');
  log.info(`${pOk ? '✅ Catálogo publicado' : '❌ Catálogo: FALHA ao gravar painel_cache'}`);
}

// ── PERFIL360 INCREMENTAL ────────────────────────────────────────────────────
// Executa em isolamento via Promise.allSettled — falha não afeta outros syncs.
// Requer GOOGLE_APPLICATION_CREDENTIALS (WIF/OIDC) para acesso ao Firestore.
async function syncPerfil360() {
  log.info('🔄 Perfil360: iniciando incremental...');
  try {
    const {
      runIncremental,
      calcularDataReferencia,
      SYNC_STATE_COLLECTION,
      SYNC_STATE_DOC,
      VENDAS_GC_COLLECTION,
      PERFIS_360_COLLECTION,
      buildCursorWithOverlap,
      CURSOR_OVERLAP_SECS,
    } = require('../functions/lib/sync360');

    const db = initFirestore();
    if (!db) {
      log.info('⚠️  Perfil360: Firestore indisponível — pulando incremental');
      return;
    }

    // Etapa A · A3 / B: o Perfil360 usa a MESMA camada HTTP segura do restante do sync (gcCliente): resposta inválida, 429/5xx
    // (retentativas controladas) ou paginação incompleta LANÇAM erro — o cursor não avança e nada parcial é gravado — e a
    // consulta carrega loja_id=262759 (Etapa B). Nenhum corpo bruto/credencial em log.
    const gcFetchPage = async (endpoint, params = {}) => {
      const j = await gcCliente.get(endpoint, { ...params, limite: '100' }, { tipo: 'lista' });
      return { data: j.data, meta: j.meta };
    };

    const firestoreGetClientes = async () => {
      const snap = await db.collection('clientes')
        .where('gestaoClickId', '!=', null).select('gestaoClickId').get();
      return snap.docs
        .map(d => ({ firestoreDocumentId: d.id, gestaoClickId: String(d.data().gestaoClickId || '') }))
        .filter(c => c.gestaoClickId.trim());
    };

    const firestoreGetVendasByCliente = async (gcId) => {
      const snap = await db.collection(VENDAS_GC_COLLECTION)
        .where('cliente_id', '==', String(gcId)).get();
      return snap.docs.map(d => d.data());
    };

    const firestoreGetVendaById = async (vendaId) => {
      const doc = await db.collection(VENDAS_GC_COLLECTION).doc(String(vendaId)).get();
      return doc.exists ? doc.data() : null;
    };

    const firestoreGetPerfil = async (clienteMr4Id) => {
      const doc = await db.collection(PERFIS_360_COLLECTION).doc(clienteMr4Id).get();
      return doc.exists ? doc.data() : null;
    };

    const firestoreGetSyncState = async () => {
      const doc = await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).get();
      return doc.exists ? doc.data() : null;
    };

    const firestoreSetSyncState = async (data) => {
      await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).set(data, { merge: true });
    };

    const firestoreUpsertPerfil = async (clienteMr4Id, perfil) => {
      await db.collection(PERFIS_360_COLLECTION).doc(clienteMr4Id).set(perfil);
    };

    const firestoreUpsertVendas = async (vendas) => {
      if (!vendas.length) return;
      const { BulkWriter } = db.constructor;
      const writer = db.bulkWriter();
      writer.onWriteError(err => {
        log.erro(`  [Perfil360 BulkWriter] falha de gravação codigo=${codigoSeguro(err)}`);
        return false;
      });
      for (const venda of vendas) {
        writer.set(db.collection(VENDAS_GC_COLLECTION).doc(String(venda.id)), venda);
      }
      await writer.close();
    };

    const syncState = await firestoreGetSyncState();
    if (!syncState || syncState.status !== 'READY') {
      log.info('⚠️  Perfil360: sincronização-base não está READY — pulando');
      return;
    }

    const result = await runIncremental({
      gcFetchPage,
      firestoreGetClientes,
      firestoreGetVendasByCliente,
      firestoreGetVendaById,
      firestoreGetPerfil,
      firestoreUpsertVendas,
      firestoreUpsertPerfil,
      firestoreGetSyncState,
      firestoreSetSyncState,
      dryRun:         false,
      dataReferencia: calcularDataReferencia(),
    });

    log.info(`✅ Perfil360: incremental concluído | cursor avançou=${result.cursorAdvanced === true}`);
  } catch(e) {
    log.erro(`❌ Perfil360 incremental falhou (isolado) codigo=${codigoSeguro(e)}`);
  }
}

// ── HEARTBEAT (gc_sync_status/ultima) ─────────────────────────────────────────
// ultimoSucessoCompletoEm = último ciclo SEM nenhuma falha; ultimoSucessoPorBloco[b] = último ciclo em que o bloco b não falhou.
// Lê o documento anterior para preservar os últimos sucessos; se a leitura falhar, NÃO grava (não perde histórico). Sem dados do negócio.
async function registrarHeartbeat(blocos, inicioTotal, duracoes, parcial = false) {
  try {
    const ref = await firestoreLerReferencia('gc_sync_status', 'ultima');
    if (!ref.ok) { log.aviso('⚠️  Heartbeat não gravado (leitura do anterior falhou)'); return; }
    const ant = ref.dados || {}; const agoraIso = new Date().toISOString(); const falhou = new Set(falhas.map(f => f.bloco));
    const porBloco = { ...(ant.ultimoSucessoPorBloco || {}) };
    for (const b of blocos) if (!falhou.has(b)) porBloco[b] = agoraIso;
    const runId = /^\d{1,20}$/.test(String(process.env.GITHUB_RUN_ID || '')) ? String(process.env.GITHUB_RUN_ID) : null;
    const doc = {
      schema: 1, ultimaTentativaEm: agoraIso,
      ultimoSucessoCompletoEm: falhas.length === 0 && !parcial ? agoraIso : (ant.ultimoSucessoCompletoEm || null),   // execução DIRECIONADA (parcial) nunca declara sucesso completo
      ultimoSucessoPorBloco: porBloco,
      ultimaExecucao: { runId, origem: ORIGEM, parcial: !!parcial, ok: falhas.length === 0, duracaoMs: Date.now() - inicioTotal, falhas: falhas.map(f => ({ bloco: f.bloco, codigo: f.codigo })) },
    };
    const ok = await firestoreSet('gc_sync_status', 'ultima', doc);
    if (!ok) log.aviso('⚠️  Heartbeat não gravado (escrita falhou)');
  } catch (e) { log.aviso(`⚠️  Heartbeat não gravado (codigo=${codigoSeguro(e)})`); }
}

// ── TRAVA TRANSACIONAL COMPARTILHADA (Cloud Run Job × GitHub Actions) ─────────────────────────────────────────────
// Uma execução por vez, em QUALQUER origem. Documento gc_sync_lock/sync-dados {detentor, origem, adquiridaEm, expiraEm}. Expira sozinho (TTL) para que
// uma falha/queda NUNCA deixe o sync preso; só o detentor libera. Falha ao falar com o Firestore ⇒ NÃO executa (fail-closed).
const TRAVA_COLECAO = 'gc_sync_lock', TRAVA_DOC = 'sync-dados', TRAVA_TTL_MS = 25 * 60000;
const ORIGEM = process.env.CLOUD_RUN_JOB ? 'cloudrun' : (process.env.GITHUB_ACTIONS ? 'github' : 'local');
const DETENTOR = `${ORIGEM}-${String(process.env.CLOUD_RUN_EXECUTION || process.env.GITHUB_RUN_ID || Date.now()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`;
async function adquirirTrava(db) {
  const ref = db.collection(TRAVA_COLECAO).doc(TRAVA_DOC);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref); const agoraMs = Date.now(); const d = snap.exists ? snap.data() : null;
    if (d && Number(d.expiraEm) > agoraMs && d.detentor !== DETENTOR) return { ok: false, motivo: 'TRAVA_EM_USO' };
    tx.set(ref, { detentor: DETENTOR, origem: ORIGEM, adquiridaEm: agoraMs, expiraEm: agoraMs + TRAVA_TTL_MS, assumiuExpirada: !!(d && Number(d.expiraEm) > 0 && Number(d.expiraEm) <= agoraMs && d.detentor !== DETENTOR) });
    return { ok: true, motivo: d && Number(d.expiraEm) > 0 && Number(d.expiraEm) <= agoraMs && d.detentor !== DETENTOR ? 'TRAVA_EXPIRADA_ASSUMIDA' : 'TRAVA_ADQUIRIDA' };
  });
}
async function liberarTrava(db) {
  try {
    const ref = db.collection(TRAVA_COLECAO).doc(TRAVA_DOC);
    await db.runTransaction(async tx => { const snap = await tx.get(ref); const d = snap.exists ? snap.data() : null; if (d && d.detentor === DETENTOR) tx.set(ref, { ...d, expiraEm: 0, liberadaEm: Date.now() }); });
  } catch (_) { /* best-effort: a expiração (TTL) recupera */ }
}
/** Blocos pedidos por BLOCOS=vendas,pedidos (execução direcionada); vazio/ausente ⇒ todos. Nomes inválidos ⇒ erro (nada roda). */
const TODOS_OS_BLOCOS = ['vendas', 'estoque', 'financeiro', 'pedidos', 'catalogo', 'perfil360'];
function blocosSolicitados() {
  const bruto = String(process.env.BLOCOS || '').trim(); if (!bruto) return { ok: true, lista: TODOS_OS_BLOCOS.slice(), parcial: false };
  const lista = [...new Set(bruto.split(',').map(x => x.trim()).filter(Boolean))];
  if (!lista.length || lista.some(b => !TODOS_OS_BLOCOS.includes(b))) return { ok: false, lista: [], parcial: false };
  return { ok: true, lista, parcial: lista.length !== TODOS_OS_BLOCOS.length };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  log.info(`🔄 Iniciando sync — ${agora()}`);
  const sel = blocosSolicitados();
  if (!sel.ok) { registrarFalha('sync', 'BLOCOS_INVALIDOS'); log.erro('❌ BLOCOS inválidos — nada foi executado'); process.exitCode = 1; return; }
  const db0 = initFirestore();
  let travaOk = false;
  if (db0) {
    try {
      // intervalo mínimo (disparos periódicos): evita sync duplicado logo após outro
      const minInt = Number(process.env.INTERVALO_MIN_MINUTOS || 0);
      if (minInt > 0 && !sel.parcial) {   // só o sync COMPLETO usa o intervalo (execuções direcionadas de estoque/etc. não o adiam)
        const hb = await firestoreLerReferencia('gc_sync_status', 'ultima'); const ult = hb.ok && hb.dados ? Date.parse(hb.dados.ultimoSucessoCompletoEm || '') : NaN;
        if (Number.isFinite(ult) && Date.now() - ult < minInt * 60000) { log.info('⏭️  SYNC_IGNORADO_INTERVALO — execução recente'); return; }
      }
      const t = await adquirirTrava(db0); const motivoTrava = t.motivo;
      log.info(`🔒 ${motivoTrava} origem=${ORIGEM}`);
      if (!t.ok) { log.info('⏭️  SYNC_IGNORADO_TRAVA — outra execução em andamento'); return; }
      travaOk = true;
    } catch (e) { registrarFalha('sync', 'TRAVA_INDISPONIVEL', codigoSeguro(e)); log.erro('❌ trava indisponível — nada foi executado (fail-closed)'); process.exitCode = 1; return; }
  }
  let selFinal = sel;
  const modoSujos = process.env.MODO_SUJOS === '1';
  try {
    if (modoSujos && db0) {   // execução disparada por webhook: relê SÓ os blocos marcados como desatualizados (fila gc_refresh_fila)
      const sujos = await require('../functions/lib/refreshFila').reclamarSujos({ db: db0 });
      const semSujos = sujos.length === 0, parcialSujos = sujos.length !== TODOS_OS_BLOCOS.length;
      if (semSujos) {
        log.info('⏭️  SEM_BLOCOS_DESATUALIZADOS');
        return;
      }
      selFinal = { ok: true, lista: sujos, parcial: parcialSujos };
    }
    await executarSync(selFinal);
  } finally {
    if (travaOk) await liberarTrava(db0);
    if (modoSujos && db0) await reenfileirarSeHouverSujos(db0);   // eventos chegaram durante a execução ⇒ nova execução (coalescida)
  }
})();

/** Se chegaram eventos durante a execução, dispara OUTRA execução do próprio Job (a trava garante uma por vez). Falha é inócua: o sync de 2 h reconcilia. */
async function reenfileirarSeHouverSujos(db) {
  try {
    if (!(await require('../functions/lib/refreshFila').temSujos({ db }))) return;
    const job = process.env.CLOUD_RUN_JOB; if (!job) return;
    const { GoogleAuth } = require('google-auth-library'); const cli = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    await cli.request({ url: `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/southamerica-east1/jobs/${job}:run`, method: 'POST', data: { overrides: { containerOverrides: [{ env: [{ name: 'MODO_SUJOS', value: '1' }] }] } } });
    log.info('🔁 REEXECUCAO_DISPARADA');
  } catch (e) { log.aviso(`⚠️  reexecução não disparada (codigo=${codigoSeguro(e)})`); }
}

async function executarSync(sel) {
  const todos = TODOS_OS_BLOCOS;
  const blocos = sel.lista;
  const inicioTotal = Date.now(); const duracoes = {};
  const medir = (nome, fn) => { const t0 = Date.now(); return Promise.resolve().then(fn).finally(() => { duracoes[nome] = Date.now() - t0; }); };
  const fns = { vendas: syncVendas, estoque: syncEstoque, financeiro: syncFinanceiro, pedidos: syncPedidos, catalogo: syncCatalogoProdutos, perfil360: syncPerfil360 };
  if (!blocos.includes('vendas')) _resolverVendas30(null);   // Pedidos sem Vendas: sem corroboração (vazio não aceito, dado anterior preservado)
  const resultados = await Promise.allSettled(blocos.map(b => medir(b, fns[b])));
  resultados.forEach((r, i) => { if (r.status === 'rejected') registrarFalha(blocos[i], 'EXCECAO_NAO_TRATADA', codigoSeguro(r.reason)); });
  await registrarHeartbeat(blocos, inicioTotal, duracoes, sel.parcial);
  // Resumo estruturado (só códigos e contagens — sem dados pessoais) e STATUS DO WORKFLOW: qualquer falha ⇒ erro
  // RESUMO_SYNC: SÓ bloco/código/motivo(enum)/duração. Nenhuma contagem de negócio, valor ou dado pessoal.
  log.info('RESUMO_SYNC ' + JSON.stringify({ ok: falhas.length === 0, falhas: falhas.map(f => ({ bloco: f.bloco, codigo: f.codigo, motivo: f.detalhe && /^[A-Z0-9_]{3,60}$/.test(f.detalhe) ? f.detalhe : undefined })), avisos, duracaoMs: Date.now() - inicioTotal, duracoesMs: duracoes, requisicoesGc: gcCliente.estatisticas().chamadas, retentativasGc: gcCliente.estatisticas().retries }));   // só contagens técnicas da camada HTTP
  if (falhas.length) {
    process.exitCode = 1;
    log.erro(`❌ Sync concluído COM ${falhas.length} falha(s): ${falhas.map(f => f.bloco + ':' + f.codigo).join(', ')}`);
  } else {
    log.info('🏁 Sync concluído!');
  }
}
