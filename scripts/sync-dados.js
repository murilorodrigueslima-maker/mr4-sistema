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
  console.error('❌ Tokens GestãoClick não configurados');
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
const ESCOPO_VENDAS       = 'padrao_sem_loja_id';   // a Etapa B passará a 'loja_262759': mudar o escopo ZERA a referência (= 1ª execução)
const LIMITE_QUEDA_PADRAO = 0.70;
const MAX_PAGINAS         = 400;                    // trava de segurança: ABORTA (GC_LIMITE_PAGINAS), nunca trunca
const gcCliente = gcHttp.criarCliente({ transporte: gcHttp.criarTransporteHttps(https), credenciais: { access: ACCESS_TOKEN, secret: SECRET_TOKEN } });
const falhas = [];
function registrarFalha(bloco, codigo, detalhe) {
  falhas.push({ bloco, codigo, detalhe: detalhe || null });
  console.error(`🚨 FALHA bloco=${bloco} codigo=${codigo}${detalhe ? ' ' + detalhe : ''}`);   // só códigos e contagens — sem dados pessoais
}
/** Lista COMPLETA (ou erro): nunca devolve resultado parcial. */
function lerLista(caminho, params, opcoes = {}) {
  return gcHttp.paginarCompleto(gcCliente, caminho, params, { limite: 100, maxPaginas: MAX_PAGINAS, ...opcoes });
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
    console.warn('⚠️  Firestore falhou ao inicializar:', e.message);
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
    console.warn(`⚠️  Firestore.get(${colecao}/${docId}):`, e.message);
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
    console.warn(`⚠️  Firestore.set(${colecao}/${docId}):`, e.message);
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
    console.warn(`⚠️  Firestore.batch(${ops.map(o => o.col + '/' + o.id).join(', ')}):`, e.message);
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
    console.warn(`🚨 ANOMALIA ${nome}: ${av.motivo} (anterior=${totalAnterior} novo=${totalNovo}) — preservando cache`);
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
  console.log('📊 Sincronizando vendas...');
  const META_MES    = 200000;
  const META_DIA    = 8000;
  const META_SEMANA = 40000;

  let vendas = [];
  try {
    const inicio = diasAtras(JANELA_VENDAS_DIAS);
    const r = await lerLista('/vendas', { data_inicio: inicio, data_fim: hoje() });
    vendas = r.itens;
    console.log(`  → ${vendas.length} vendas encontradas`);
  } catch(e) {
    console.log('⚠️ Erro ao buscar vendas:', e.codigo || e.message);
    registrarFalha('vendas', e.codigo || 'ERRO_INESPERADO');
    // GC falhou ou devolveu resposta inválida/incompleta: não sobrescreve os caches protegidos (preserva o último válido)
    console.log('  ↩ Mantendo painel_cache/vendas, painel_cache/caixa e display_metrics inalterados');
    return;
  }

  // Proteção de publicação: queda > 70% (ou vazio) em relação à referência _meta.vendasTotal (mesma janela e escopo)
  const refVendas = await firestoreLerReferencia('painel_cache', 'vendas');
  const anteriorVendas = refVendas.ok ? referenciaVendasAnterior(refVendas.dados) : null;
  const avVendas = refVendas.ok
    ? gcHttp.avaliarPublicacao({ novo: vendas.length, anterior: anteriorVendas, limiteQuedaPct: LIMITE_QUEDA_PADRAO })
    : { publicar: false, motivo: 'REFERENCIA_ILEGIVEL' };
  if (!avVendas.publicar) {
    registrarFalha('vendas', 'PUBLICACAO_BLOQUEADA', `${avVendas.motivo} novo=${vendas.length} anterior=${anteriorVendas}`);
    console.log('  ↩ Mantendo painel_cache/vendas, painel_cache/caixa e display_metrics inalterados');
    return;
  }

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
    console.log(`✅ Vendas: hoje R$ ${fatHoje.toFixed(2)} | mês R$ ${fatMes.toFixed(2)}`);
    console.log(`✅ display_metrics: ${dmVendedores.length} vendedores | mês R$ ${fatMes.toFixed(2)}`);
  } else {
    registrarFalha('vendas', 'GRAVACAO_FALHOU');
    console.log(`❌ Vendas: hoje R$ ${fatHoje.toFixed(2)} | mês R$ ${fatMes.toFixed(2)} — FALHA ao gravar painel_cache/display_metrics (lote atômico: nenhum documento foi alterado)`);
  }
}

// ── ESTOQUE ──────────────────────────────────────────────────────────────────
async function syncEstoque() {
  console.log('🗄️ Sincronizando estoque...');
  let produtos = [];

  try {
    const r = await lerLista('/produtos', { ativo: 1 });
    produtos = r.itens;
  } catch(e) {
    console.log('⚠️ Erro ao buscar produtos:', e.codigo || e.message);
    registrarFalha('estoque', e.codigo || 'ERRO_INESPERADO');
    console.log('  ↩ Mantendo painel_cache/estoque e painel_cache/estoque_custos inalterados');
    return;
  }

  // Proteção de publicação: queda > 70% (ou vazio) em relação a painel_cache/estoque.total_produtos
  const refEstoque = await firestoreLerReferencia('painel_cache', 'estoque');
  const anteriorEstoque = refEstoque.ok && refEstoque.dados && Number.isFinite(refEstoque.dados.total_produtos) ? refEstoque.dados.total_produtos : null;
  const avEstoque = refEstoque.ok
    ? gcHttp.avaliarPublicacao({ novo: produtos.length, anterior: anteriorEstoque, limiteQuedaPct: LIMITE_QUEDA_PADRAO })
    : { publicar: false, motivo: 'REFERENCIA_ILEGIVEL' };
  if (!avEstoque.publicar) {
    registrarFalha('estoque', 'PUBLICACAO_BLOQUEADA', `${avEstoque.motivo} novo=${produtos.length} anterior=${anteriorEstoque}`);
    console.log('  ↩ Mantendo painel_cache/estoque e painel_cache/estoque_custos inalterados');
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
  console.log(`${eOk ? '✅' : '❌'} Estoque: ${produtos.length} produtos | ${abaixoMinimo.length} abaixo do mínimo${eOk ? '' : ' — FALHA ao gravar painel_cache (lote atômico: nenhum documento foi alterado)'}`);
}

// ── FINANCEIRO ───────────────────────────────────────────────────────────────
async function syncFinanceiro() {
  console.log('💰 Sincronizando financeiro...');
  let lancamentos = [];

  try {
    const inicio = diasAtras(60);
    const fim    = diasAtras(-30);
    // permitirVazio: SÓ aqui — ausência de lançamentos na janela é legítima; a proteção abaixo impede que um vazio
    // (ou queda > 70%) sobrescreva dados financeiros válidos já publicados.
    const r = await lerLista('/pagamentos', { data_inicio: inicio, data_fim: fim }, { permitirVazio: true });
    lancamentos = r.itens;
    console.log(`  → ${lancamentos.length} lançamentos encontrados`);
  } catch(e) {
    console.log('⚠️ Erro ao buscar pagamentos:', e.codigo || e.message);
    registrarFalha('financeiro', e.codigo || 'ERRO_INESPERADO');
    // GC falhou: não sobrescreve o cache Firestore (preservar último válido)
    console.log('  ↩ Mantendo financeiro_cache/latest inalterado');
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
    console.log('  ↩ financeiro_cache/latest preservado (referência ilegível)');
    return;
  }
  const totalAnterior = refFin.dados ? (refFin.dados._meta?.lancamentosTotal ?? null) : null;
  const anomalia = detectarAnomalia('financeiro', lancamentos.length, totalAnterior, 0.70);

  if (anomalia) {
    // GC retornou quantidade drasticamente menor — NÃO sobrescrever Firestore (e gerar alerta)
    registrarFalha('financeiro', 'PUBLICACAO_BLOQUEADA', `novo=${lancamentos.length} anterior=${totalAnterior}`);
    console.log('  ↩ financeiro_cache/latest preservado (anomalia detectada)');
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
    console.log(`✅ Financeiro: Firestore | vencido ${brl(totalVencido)} | a receber ${brl(totalReceber)}`);
  } else {
    registrarFalha('financeiro', 'GRAVACAO_FALHOU');
    console.log(`⚠️  Financeiro: Firestore indisponível | vencido ${brl(totalVencido)}`);
  }
}

// ── PEDIDOS (Expedição) ───────────────────────────────────────────────────────
async function syncPedidos() {
  console.log('🚚 Sincronizando pedidos para expedição...');
  let vendas = [];

  try {
    const inicio = diasAtras(2);
    const r = await lerLista('/vendas', { data_inicio: inicio, data_fim: hoje() });
    vendas = r.itens;
    console.log(`  → ${vendas.length} pedidos encontrados`);
  } catch(e) {
    console.log('⚠️ Erro ao buscar pedidos:', e.codigo || e.message);
    registrarFalha('pedidos', e.codigo || 'ERRO_INESPERADO');
    console.log('  ↩ Mantendo pedidos_cache/latest inalterado');
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
    console.log('  ↩ pedidos_cache/latest preservado (referência ilegível)');
    return;
  }
  const totalAnterior = refPed.dados ? (refPed.dados._meta?.pedidosTotal ?? null) : null;
  const anomalia = detectarAnomalia('pedidos', pedidos.length, totalAnterior, 0.80);

  if (anomalia) {
    registrarFalha('pedidos', 'PUBLICACAO_BLOQUEADA', `novo=${pedidos.length} anterior=${totalAnterior}`);
    console.log('  ↩ pedidos_cache/latest preservado (anomalia detectada)');
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
    console.log(`✅ Pedidos: Firestore (sanitizado) | ${pedidos.length} registros`);
  } else {
    registrarFalha('pedidos', 'GRAVACAO_FALHOU');
    console.log(`⚠️  Pedidos: Firestore indisponível | ${pedidos.length} registros`);
  }
}

// ── CATÁLOGO DE PRODUTOS (para busca local por nome e código) ─────────────────
async function syncCatalogoProdutos() {
  console.log('📦 Sincronizando catálogo de produtos...');
  let produtos = [];
  try {
    const r = await lerLista('/produtos', { ativo: 1 });
    produtos = r.itens;
  } catch(e) {
    console.log('⚠️ Erro ao buscar catálogo:', e.codigo || e.message);
    registrarFalha('catalogo', e.codigo || 'ERRO_INESPERADO');
    console.log('  ↩ Mantendo painel_cache/produtos_catalogo inalterado');
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
  if (!avCat.publicar) {
    registrarFalha('catalogo', 'PUBLICACAO_BLOQUEADA', `${avCat.motivo} novo=${catalogo.length} anterior=${anteriorCat}`);
    console.log('  ↩ Mantendo painel_cache/produtos_catalogo inalterado');
    return;
  }

  // SECURITY HOTFIX P0: antes em data/produtos.json (público). Agora painel_cache/produtos_catalogo
  // (autocomplete da aba Equivalentes do Estoque): módulo estoque. ~100 B por item → limite de 1 MiB do
  // documento comporta ~8.000 produtos; hoje ~900.
  const pOk = await firestoreSet('painel_cache', 'produtos_catalogo', { atualizado_em: dataISO(), total: catalogo.length, itens: catalogo });
  if (!pOk) registrarFalha('catalogo', 'GRAVACAO_FALHOU');
  console.log(`${pOk ? '✅' : '❌'} Catálogo: ${catalogo.length} produtos${pOk ? '' : ' — FALHA ao gravar painel_cache'}`);
}

// ── PERFIL360 INCREMENTAL ────────────────────────────────────────────────────
// Executa em isolamento via Promise.allSettled — falha não afeta outros syncs.
// Requer GOOGLE_APPLICATION_CREDENTIALS (WIF/OIDC) para acesso ao Firestore.
async function syncPerfil360() {
  console.log('🔄 Perfil360: iniciando incremental...');
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
      console.log('⚠️  Perfil360: Firestore indisponível — pulando incremental');
      return;
    }

    const https = require('https');
    function gcReq360(path, params = {}) {
      return new Promise((resolve, reject) => {
        const qs  = new URLSearchParams({ ...params, limite: '100' }).toString();
        const url = `https://api.gestaoclick.com${path}?${qs}`;
        https.get(url, {
          headers: {
            'access-token':        ACCESS_TOKEN,
            'secret-access-token': SECRET_TOKEN,
            'Content-Type':        'application/json',
          },
        }, res => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('GC JSON: ' + e.message)); }
          });
        }).on('error', reject);
      });
    }

    const gcFetchPage = async (endpoint, params) => {
      const r = await gcReq360(endpoint, params);
      return { data: Array.isArray(r.data) ? r.data : [], meta: r.meta || {} };
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
        console.error('  [Perfil360 BulkWriter]', err.documentRef.path, err.code);
        return false;
      });
      for (const venda of vendas) {
        writer.set(db.collection(VENDAS_GC_COLLECTION).doc(String(venda.id)), venda);
      }
      await writer.close();
    };

    const syncState = await firestoreGetSyncState();
    if (!syncState || syncState.status !== 'READY') {
      console.log(`⚠️  Perfil360: status=${syncState?.status || 'N/A'} — pulando (não READY)`);
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

    console.log(`✅ Perfil360: ${result.modifiedVendas} vendas delta | ${result.creates}C/${result.updates}U perfis | cursor avançou=${result.cursorAdvanced}`);
  } catch(e) {
    console.error('❌ Perfil360 incremental falhou (isolado):', e.message);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`🔄 Iniciando sync — ${agora()}`);
  const blocos = ['vendas', 'estoque', 'financeiro', 'pedidos', 'catalogo', 'perfil360'];
  const resultados = await Promise.allSettled([
    syncVendas(),
    syncEstoque(),
    syncFinanceiro(),
    syncPedidos(),
    syncCatalogoProdutos(),
    syncPerfil360(),
  ]);
  resultados.forEach((r, i) => { if (r.status === 'rejected') registrarFalha(blocos[i], 'EXCECAO_NAO_TRATADA', String((r.reason && r.reason.message) || r.reason).slice(0, 120)); });
  // Resumo estruturado (só códigos e contagens — sem dados pessoais) e STATUS DO WORKFLOW: qualquer falha ⇒ erro
  console.log('RESUMO_SYNC ' + JSON.stringify({ ok: falhas.length === 0, falhas: falhas.map(f => ({ bloco: f.bloco, codigo: f.codigo })) }));
  if (falhas.length) {
    process.exitCode = 1;
    console.error(`❌ Sync concluído COM ${falhas.length} falha(s): ${falhas.map(f => f.bloco + ':' + f.codigo).join(', ')}`);
  } else {
    console.log('🏁 Sync concluído!');
  }
})();
