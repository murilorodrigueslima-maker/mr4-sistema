'use strict';
// N35.15 — Gerador oficial da Worklist V2 diária.
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   Escreve NO MÁXIMO 1 documento: fila_comercial/worklist (LIVE) ou fila_comercial/worklist_preview (DRY_RUN)
//   NUNCA escreve em interacoes_fila, perfis_360, clientes ou vendas_gc (criação operacional é lazy, no claim)
//   Idempotente no mesmo dia: worklist LIVE já gerada para hoje não é recalculada (CAP de 10 NOVAS/dia preservado)
//   Documento sem CPF/CNPJ/telefone/e-mail/endereço/financeiro/prioridade; nome só para exibição

const QC = require('./filaQueueConfig');
const {
  gerarWorklistPorVendedor, resolverVendedoresAtivos, indiceAtribuicoes,
} = require('./dailyWorklist');
const { construirUniversoHibrido } = require('./worklistUniverso');
const { calcularDataReferencia } = require('./filaSnapshotGenerator');
const { prepararDadosUI, verificarCamposBloqueados } = require('./filaComercialUtils');

const COLL = 'fila_comercial';
const DOC_LIVE = 'worklist';
const DOC_PREVIEW = 'worklist_preview';
const SCHEMA_VERSION = 'worklist-v2';
const VERSAO = 'N35.15';
const CAMPOS_VENDAS = ['id', 'cliente_id', 'data', 'nome_situacao', 'valor_total', 'cadastrado_em', 'vendedor_id', 'produtos'];

function gcIdDe(c) {
  if (typeof c.commercialEntityId === 'string' && c.commercialEntityId.startsWith('GC_NATIVE:')) return c.commercialEntityId.slice(10);
  return c.gestaoClickId ? String(c.gestaoClickId) : null;
}

/** Item exibível: somente o necessário para a fila (reusa a lista branca do snapshot). */
function itemDoc(c, rank) {
  const ui = prepararDadosUI(c) || {};
  const item = {
    rank,
    opportunityInstanceId: c.opportunityInstanceId,
    commercialEntityId: c.commercialEntityId,
    tipoOportunidade: c.tipoOportunidade || null,
    labelOp: ui.labelOp || null,
    nomeCliente: c.nomeCliente,
    diasSemComprar: typeof c.diasSemComprar === 'number' ? c.diasSemComprar : null,
    diasEntreComprasMediana: ui.diasEntreComprasMediana ?? null,
    situacao: ui.situacao || null,
    quando: ui.quando || null,
    sinaisVisiveis: ui.sinaisVisiveis || [],
  };
  if (c.nextFollowUpAt) item.nextFollowUpAt = c.nextFollowUpAt;
  return item;
}

/**
 * Seleção com nome resolvido. Novas sem nome resolvível são substituídas pela próxima elegível.
 * Follow-ups e atendimentos NUNCA são descartados por falta de nome (compromisso já assumido):
 * usam o nome gravado no estado operacional ou o lookup.
 */
async function selecionarComNomes({ candidatos, estados, ativos, dataReferencia, agoraIso, lookupNome, maxLookups }) {
  const cacheNome = new Map();            // commercialEntityId → nome|null
  const naoResolvidos = new Set();        // entidades excluídas por nome
  let lookups = 0;
  let limiteAtingido = false;

  const nomeLocal = (c) => {
    if (c.nomeCliente) return c.nomeCliente;
    const e = estados.get(c.opportunityInstanceId);
    return (e && e.nomeCliente) || null;
  };
  async function resolver(c) {
    if (cacheNome.has(c.commercialEntityId)) return cacheNome.get(c.commercialEntityId);
    let nome = nomeLocal(c);
    if (!nome) {
      const gc = gcIdDe(c);
      if (gc && typeof lookupNome === 'function') {
        if (lookups >= maxLookups) { limiteAtingido = true; return null; }
        lookups++;
        try { nome = await lookupNome(gc); } catch (_) { nome = null; }
        nome = typeof nome === 'string' && nome.trim() ? nome.trim() : null;
      }
    }
    cacheNome.set(c.commercialEntityId, nome);
    return nome;
  }

  let wl;
  for (let rodada = 0; rodada < 50; rodada++) {
    wl = gerarWorklistPorVendedor({
      candidatos: candidatos.filter(c => !naoResolvidos.has(c.commercialEntityId)),
      estados, vendedoresAtivos: ativos, dataReferencia, agoraIso,
      duplicateGcIds: QC.DUPLICATE_GC_IDS, canaryIds: QC.CANARY_OPPORTUNITY_IDS,
    });
    let excluiu = false;
    for (const uid of wl.vendedoresAtivos) {
      for (const c of wl.porVendedor[uid].newOpportunities) {
        const nome = await resolver(c);
        if (!nome) { naoResolvidos.add(c.commercialEntityId); excluiu = true; }
      }
    }
    if (!excluiu || limiteAtingido) break;
  }
  // se o teto de lookups foi atingido, remove as novas ainda sem nome (nunca exibir sem nome)
  for (const uid of wl.vendedoresAtivos) {
    const g = wl.porVendedor[uid];
    g.newOpportunities = g.newOpportunities.filter(c => cacheNome.get(c.commercialEntityId));
    for (const grupo of ['dueFollowUps', 'emAtendimento']) {
      for (const c of g[grupo]) await resolver(c);
    }
  }
  const aplicarNome = c => ({ ...c, nomeCliente: cacheNome.get(c.commercialEntityId) || nomeLocal(c) || null });
  for (const uid of wl.vendedoresAtivos) {
    const g = wl.porVendedor[uid];
    g.newOpportunities = g.newOpportunities.map(aplicarNome);
    g.dueFollowUps = g.dueFollowUps.map(aplicarNome);
    g.emAtendimento = g.emAtendimento.map(aplicarNome);
  }
  return { wl, lookups, nameUnresolved: naoResolvidos.size, limiteAtingido };
}

function montarDocumento({ wl, dataReferencia, geradoEm, stats, sel, rejeitados }) {
  const vendedores = {};
  const atribuicoes = {};
  const idx = indiceAtribuicoes(wl); // lança se houver colisão
  for (const uid of wl.vendedoresAtivos) {
    const g = wl.porVendedor[uid];
    vendedores[uid] = {
      novas: g.newOpportunities.map((c, i) => itemDoc(c, i + 1)),
      followUps: g.dueFollowUps.map((c, i) => itemDoc(c, i + 1)),
      emAtendimento: g.emAtendimento.map((c, i) => itemDoc(c, i + 1)),
    };
    for (const grupo of ['novas', 'followUps', 'emAtendimento']) {
      for (const it of vendedores[uid][grupo]) {
        const a = idx.get(it.opportunityInstanceId);
        atribuicoes[it.opportunityInstanceId] = {
          uid, grupo, commercialEntityId: a.commercialEntityId, tipoOportunidade: a.tipoOportunidade, nomeCliente: it.nomeCliente || null,
        };
      }
    }
  }
  const excluidos = Object.fromEntries(Object.entries(wl.excluidos).map(([k, v]) => [k, v.length]));
  return {
    schemaVersion: SCHEMA_VERSION,
    versao: VERSAO,
    dataReferencia,
    geradoEm,
    cap: wl.cap,
    vendedoresAtivos: wl.vendedoresAtivos,
    vendedoresRotulos: Object.fromEntries(QC.ACTIVE_QUEUE_SELLERS.filter(s => wl.vendedoresAtivos.includes(s.uid)).map(s => [s.uid, s.label])),
    vendedores,
    atribuicoes,
    canarios: wl.canarios.map(c => c.opportunityInstanceId),
    contagens: {
      candidatosHoje: stats.hoje,
      gcNativeEmMemoria: stats.gcNativeEmMemoria,
      excluidos,
      backlog: wl.backlog.length,
      followUpsSemDonoAtivo: wl.followUpsSemDonoAtivo.length,
      nameLookups: sel.lookups,
      nameUnresolved: sel.nameUnresolved,
      vendedoresRejeitados: rejeitados.length,
    },
  };
}

async function carregarDados(db) {
  const configurados = QC.ACTIVE_QUEUE_SELLERS.map(s => s.uid);
  const [perfisSnap, clientesSnap, vendasSnap, interSnap, ...userSnaps] = await Promise.all([
    db.collection('perfis_360').get(),
    db.collection('clientes').get(),
    db.collection('vendas_gc').select(...CAMPOS_VENDAS).get(),
    db.collection('interacoes_fila').get(),
    ...configurados.map(uid => db.collection('users').doc(uid).get()),
    ...configurados.map(uid => db.collection('sistema_usuarios').doc(uid).get()),
  ]);
  const n = configurados.length;
  return {
    perfis: perfisSnap.docs.map(d => ({ id: d.id, data: d.data() })),
    clientes: clientesSnap.docs.map(d => ({ id: d.id, data: d.data() })),
    vendas: vendasSnap.docs.map(d => d.data()),
    estados: new Map(interSnap.docs.map(d => [d.id, d.data()])),
    users: new Map(configurados.map((uid, i) => [uid, userSnaps[i].exists ? userSnaps[i].data() : null])),
    sistema: new Map(configurados.map((uid, i) => [uid, userSnaps[n + i].exists ? userSnaps[n + i].data() : null])),
  };
}

/**
 * @param {object} p
 * @param {FirebaseFirestore.Firestore} p.db
 * @param {Function} [p.lookupNome]   — async (gestaoClickId) => nome|null
 * @param {Date}     [p.now]
 * @param {string}   [p.mode]         — override de QC.WORKLIST_V2_MODE (testes)
 * @param {object}   [p.logger]
 * @param {object}   [p.dados]        — dados pré-carregados (testes/simulação); pula carregarDados
 */
async function executarGeracaoWorklist({ db, lookupNome, now = new Date(), mode = QC.WORKLIST_V2_MODE, logger = console, dados }) {
  if (mode === 'OFF') {
    logger.log(JSON.stringify({ event: 'worklist_v2_off' }));
    return { status: 'OFF', escrito: null };
  }
  if (mode !== 'DRY_RUN' && mode !== 'LIVE') throw new Error(`executarGeracaoWorklist: modo inválido ${mode}`);

  const dataReferencia = calcularDataReferencia(now);
  const destino = mode === 'LIVE' ? DOC_LIVE : DOC_PREVIEW;

  if (mode === 'LIVE' && db) {
    const atual = await db.collection(COLL).doc(DOC_LIVE).get();
    if (atual.exists && atual.data().dataReferencia === dataReferencia && atual.data().schemaVersion === SCHEMA_VERSION) {
      logger.log(JSON.stringify({ event: 'worklist_v2_ja_gerada', dataReferencia }));
      return { status: 'JA_GERADA_HOJE', escrito: null, doc: atual.data() };
    }
  }

  const d = dados || await carregarDados(db);
  const universo = await construirUniversoHibrido({ perfis: d.perfis, clientes: d.clientes, vendas: d.vendas, dataReferencia });
  const { ativos, rejeitados } = resolverVendedoresAtivos(QC.ACTIVE_QUEUE_SELLERS, d.users, d.sistema);
  const sel = await selecionarComNomes({
    candidatos: universo.hoje, estados: d.estados, ativos, dataReferencia,
    agoraIso: now.toISOString(), lookupNome, maxLookups: QC.MAX_NAME_LOOKUPS_PER_RUN,
  });
  const doc = montarDocumento({ wl: sel.wl, dataReferencia, geradoEm: now.toISOString(), stats: universo.stats, sel, rejeitados });

  const bloqueados = verificarCamposBloqueados(doc);
  if (bloqueados.length) throw new Error('WORKLIST_DOC_CAMPOS_BLOQUEADOS: ' + bloqueados.join(','));

  if (db) await db.collection(COLL).doc(destino).set(doc);
  logger.log(JSON.stringify({
    event: 'worklist_v2_gerada', mode, destino, dataReferencia,
    vendedores: doc.vendedoresAtivos.length,
    novas: doc.vendedoresAtivos.map(u => doc.vendedores[u].novas.length),
    followUps: doc.vendedoresAtivos.map(u => doc.vendedores[u].followUps.length),
    nameLookups: sel.lookups, nameUnresolved: sel.nameUnresolved,
  }));
  return { status: 'GERADA', escrito: db ? `${COLL}/${destino}` : null, doc, rejeitados };
}

module.exports = {
  executarGeracaoWorklist, selecionarComNomes, montarDocumento, carregarDados, itemDoc,
  COLL, DOC_LIVE, DOC_PREVIEW, SCHEMA_VERSION,
};
