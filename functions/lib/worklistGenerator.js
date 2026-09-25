'use strict';
// N35.15 — Gerador oficial da Worklist V2 diária.
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   Escreve NO MÁXIMO 2 documentos (N35.20.1): fila_comercial/{worklist|worklist_preview} (operacional) e
//   fila_comercial_gestao/{worklist|worklist_preview} (gerencial, mesma transação/lote)
//   NUNCA escreve em interacoes_fila, perfis_360, clientes ou vendas_gc (criação operacional é lazy, no claim)
//   Idempotente no mesmo dia: worklist LIVE já gerada para hoje não é recalculada (CAP de 10 NOVAS/dia preservado)
//   Documento sem CPF/CNPJ/telefone/e-mail/endereço/financeiro/prioridade; nome só para exibição
//   N35.18.1: a worklist LIVE anterior é a fonte do ownership entre dias (atribuicoes + pendenciasRetidas)
//   N35.20: cada item pode levar `contextoComercial` (informativo, calculado após a seleção).
//   N35.20.1: dado gerencial (ticket médio) NUNCA no documento operacional — vai para fila_comercial_gestao/{mesmo id},
//             chave opportunityInstanceId, gravado na mesma transação. Rules: vendedor DENY.
//   Escritas: fila_comercial/{worklist|worklist_preview} + fila_comercial_gestao/{worklist|worklist_preview}

const QC = require('./filaQueueConfig');
const {
  gerarWorklistPorVendedor, resolverParticipantes, indiceAtribuicoes, extrairAtribuicoesAnteriores,
} = require('./dailyWorklist');
const { construirUniversoHibrido, agruparVendasPorCliente } = require('./worklistUniverso');
// N35.20: camada INFORMATIVA — calculada só para itens já selecionados; nunca participa da seleção
const { buildContextoComercial, contextoSemPII, separarGestao, camposGestaoExpostos } = require('./contextoComercial');
const { calcularPerfil360 } = require('./perfil360');
const { calcularTendencia } = require('./tendenciaComercial');
const { parseCommercialEntityId, commercialEntityIdFromPerfil360 } = require('./commercialIdentity');
const { calcularDataReferencia } = require('./filaSnapshotGenerator');
const { prepararDadosUI, verificarCamposBloqueados } = require('./filaComercialUtils');
const { sanitizeCommercialDisplayName, contemDocumento } = require('./nomeExibicao');

const COLL = 'fila_comercial';
const DOC_LIVE = 'worklist';
const DOC_PREVIEW = 'worklist_preview';
// N35.20.1: dados EXCLUSIVOS de gestão (ticket médio) — coleção própria; Rules negam leitura ao vendedor
const COLL_GESTAO = 'fila_comercial_gestao';
const SCHEMA_GESTAO = 'worklist-gestao-v1';
const SCHEMA_VERSION = 'worklist-v2';
const VERSAO = 'N35.18.1';
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
    nomeCliente: sanitizeCommercialDisplayName(c.nomeCliente),
    diasSemComprar: typeof c.diasSemComprar === 'number' ? c.diasSemComprar : null,
    diasEntreComprasMediana: ui.diasEntreComprasMediana ?? null,
    situacao: ui.situacao || null,
    quando: ui.quando || null,
    sinaisVisiveis: ui.sinaisVisiveis || [],
  };
  if (c.nextFollowUpAt) item.nextFollowUpAt = c.nextFollowUpAt;
  if (c.atribuidoDesde) item.atribuidoDesde = c.atribuidoDesde;
  return item;
}

/**
 * Seleção com nome resolvido. Novas sem nome resolvível são substituídas pela próxima elegível.
 * Follow-ups e atendimentos NUNCA são descartados por falta de nome (compromisso já assumido):
 * usam o nome gravado no estado operacional ou o lookup.
 */
async function selecionarComNomes({ candidatos, estados, participantes, dataReferencia, agoraIso, lookupNome, maxLookups, atribuicoesAnteriores = [] }) {
  const cacheNome = new Map();            // commercialEntityId → nome|null
  const naoResolvidos = new Set();        // entidades excluídas por nome
  let lookups = 0;
  let limiteAtingido = false;
  let nameSanitized = 0;       // nomes que tinham CPF/CNPJ removido
  let nameSanitizedEmpty = 0;  // nomes que ficaram vazios após a sanitização (candidato substituído)

  // N35.16.1: todo nome passa pela sanitização central; vazio após sanitizar = não exibível
  const limpar = (bruto) => {
    if (typeof bruto !== 'string' || !bruto.trim()) return null;
    const limpo = sanitizeCommercialDisplayName(bruto);
    if (contemDocumento(bruto)) { nameSanitized++; if (!limpo) nameSanitizedEmpty++; }
    return limpo;
  };
  const nomeLocal = (c) => {
    const e = estados.get(c.opportunityInstanceId);
    return limpar(c.nomeCliente) || limpar(e && e.nomeCliente) || null;
  };
  async function resolver(c) {
    if (cacheNome.has(c.commercialEntityId)) return cacheNome.get(c.commercialEntityId);
    let nome = nomeLocal(c);
    if (!nome) {
      const gc = gcIdDe(c);
      if (gc && typeof lookupNome === 'function') {
        if (lookups >= maxLookups) { limiteAtingido = true; return null; }
        lookups++;
        let bruto = null;
        try { bruto = await lookupNome(gc); } catch (_) { bruto = null; }
        nome = limpar(bruto);
      }
    }
    cacheNome.set(c.commercialEntityId, nome);
    return nome;
  }

  let wl;
  for (let rodada = 0; rodada < 50; rodada++) {
    wl = gerarWorklistPorVendedor({
      candidatos: candidatos.filter(c => !naoResolvidos.has(c.commercialEntityId)),
      estados, participantes, dataReferencia, agoraIso,
      duplicateGcIds: QC.DUPLICATE_GC_IDS, canaryIds: QC.CANARY_OPPORTUNITY_IDS,
      atribuicoesAnteriores,
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
    for (const grupo of ['dueFollowUps', 'emAtendimento', 'pendentes']) {
      for (const c of g[grupo]) await resolver(c);
    }
    // N35.18.1: pendência sem nome exibível NÃO perde o dono — fica retida (não exibida, não redistribuída)
    const semNome = g.pendentes.filter(c => !cacheNome.get(c.commercialEntityId));
    if (semNome.length) {
      wl.pendenciasRetidas.push(...semNome.map(c => ({ ...c, donoOriginal: uid, motivoRetencao: 'SEM_NOME' })));
      g.pendentes = g.pendentes.filter(c => cacheNome.get(c.commercialEntityId));
    }
  }
  const aplicarNome = c => ({ ...c, nomeCliente: cacheNome.get(c.commercialEntityId) || nomeLocal(c) || null });
  for (const uid of wl.vendedoresAtivos) {
    const g = wl.porVendedor[uid];
    g.newOpportunities = g.newOpportunities.map(aplicarNome);
    g.dueFollowUps = g.dueFollowUps.map(aplicarNome);
    g.emAtendimento = g.emAtendimento.map(aplicarNome);
    g.pendentes = g.pendentes.map(aplicarNome);
  }
  wl.pendenciasRetidas = wl.pendenciasRetidas.map(c => ({ ...c, nomeCliente: nomeLocal(c) }));
  const st = (lookupNome && lookupNome.stats) || { sanitized: 0, sanitizedEmpty: 0 };
  return {
    wl, lookups, nameUnresolved: naoResolvidos.size, limiteAtingido,
    nameSanitized: nameSanitized + st.sanitized, nameSanitizedEmpty: nameSanitizedEmpty + st.sanitizedEmpty,
  };
}

/**
 * N35.20 — Fábrica do contexto comercial (informativo). Recalcula o perfil do DIA a partir de vendas_gc em memória
 * (GC_NATIVE e MR4_LINKED com gestaoClickId); sem vendas, usa o perfil gravado (tendência só se do dia).
 * Qualquer erro ou PII → sem contexto para o item (a UI usa o card anterior). Nunca lança.
 */
function criarFabricaContexto({ dados, dataReferencia }) {
  let porGc = null;
  let perfilPorEntidade = null;
  return function contextoPara(c, grupo) {
    try {
      if (!porGc) porGc = agruparVendasPorCliente(dados.vendas || []);
      if (!perfilPorEntidade) {
        perfilPorEntidade = new Map();
        for (const p of dados.perfis || []) {
          try { perfilPorEntidade.set(commercialEntityIdFromPerfil360(p.data || {}), p.data); } catch (_) { /* identidade inválida */ }
        }
      }
      const { source, stableId } = parseCommercialEntityId(c.commercialEntityId);
      const gravado = perfilPorEntidade.get(c.commercialEntityId) || null;
      const gcId = source === 'GC_NATIVE' ? stableId : (gravado && gravado.gestaoClickId ? String(gravado.gestaoClickId) : null);
      const vendas = gcId ? (porGc.get(gcId) || []) : [];
      let perfil = gravado;
      let perfilAtual = !!(gravado && gravado.dataReferencia === dataReferencia);
      if (vendas.length) {
        perfil = calcularPerfil360({ clienteMr4Id: gravado ? gravado.clienteMr4Id : stableId, gestaoClickId: gcId, vendas, dataReferencia });
        perfilAtual = true;
      }
      const tendenciaCodigo = perfil ? calcularTendencia(perfil).tendencia : null;
      const ctx = buildContextoComercial({
        item: c, perfil, perfilAtual, tendenciaCodigo, vendas, grupo,
        estadoOperacional: dados.estados && dados.estados.get ? dados.estados.get(c.opportunityInstanceId) : null,
        dataReferencia,
      });
      return contextoSemPII(ctx) ? ctx : null;
    } catch (_) {
      return null;
    }
  };
}

function montarDocumento({ wl, dataReferencia, geradoEm, stats, sel, rejeitados, participantes = [], contextoPara = null, coletorGestao = null }) {
  const vendedores = {};
  const atribuicoes = {};
  const idx = indiceAtribuicoes(wl); // lança se houver colisão
  // N35.20: contexto é anexado DEPOIS da seleção; não altera IDs, ordem, grupo, dono ou atribuições
  // N35.20.1: `gestao` sai do item (vai para o coletor → fila_comercial_gestao, chave opportunityInstanceId)
  const comContexto = (c, i, grupo) => {
    const it = itemDoc(c, i + 1);
    const ctx = contextoPara ? contextoPara(c, grupo) : null;
    if (ctx) {
      const { operacional, gestao } = separarGestao(ctx);
      it.contextoComercial = operacional;
      if (gestao && coletorGestao) coletorGestao.set(c.opportunityInstanceId, gestao);
    }
    return it;
  };
  for (const uid of wl.vendedoresAtivos) {
    const g = wl.porVendedor[uid];
    vendedores[uid] = {
      novas: g.newOpportunities.map((c, i) => comContexto(c, i, 'novas')),
      followUps: g.dueFollowUps.map((c, i) => comContexto(c, i, 'followUps')),
      emAtendimento: g.emAtendimento.map((c, i) => comContexto(c, i, 'emAtendimento')),
      pendentes: (g.pendentes || []).map((c, i) => comContexto(c, i, 'pendentes')),
    };
    for (const grupo of ['novas', 'followUps', 'emAtendimento', 'pendentes']) {
      for (const it of vendedores[uid][grupo]) {
        const a = idx.get(it.opportunityInstanceId);
        atribuicoes[it.opportunityInstanceId] = {
          uid, grupo, commercialEntityId: a.commercialEntityId, tipoOportunidade: a.tipoOportunidade, nomeCliente: it.nomeCliente || null,
          desde: it.atribuidoDesde || dataReferencia, // N35.18.1: 1ª distribuição ao dono
        };
      }
    }
  }
  // N35.18.1: dono fora da fila hoje → ownership preservado, não exibido nem redistribuído
  const pendenciasRetidas = {};
  for (const c of (wl.pendenciasRetidas || [])) {
    pendenciasRetidas[c.opportunityInstanceId] = {
      uid: c.donoOriginal, commercialEntityId: c.commercialEntityId, tipoOportunidade: c.tipoOportunidade || null,
      nomeCliente: c.nomeCliente || null, desde: c.atribuidoDesde || dataReferencia, motivo: c.motivoRetencao || 'DONO_FORA_DA_FILA',
    };
  }
  const excluidos = Object.fromEntries(Object.entries(wl.excluidos).map(([k, v]) => [k, v.length]));
  return {
    schemaVersion: SCHEMA_VERSION,
    versao: VERSAO,
    dataReferencia,
    geradoEm,
    cap: wl.cap,
    pipelineVersion: VERSAO,
    vendedoresAtivos: wl.vendedoresAtivos,
    vendedoresRotulos: Object.fromEntries(participantes.filter(p => wl.vendedoresAtivos.includes(p.uid)).map(p => [p.uid, p.rotulo])),
    vendedoresConfig: Object.fromEntries(wl.vendedoresAtivos.map(uid => [uid, { recebeNovas: wl.recebeNovas[uid], limiteNovas: wl.limites[uid] }])),
    vendedores,
    atribuicoes,
    pendenciasRetidas,
    canarios: wl.canarios.map(c => c.opportunityInstanceId),
    contagens: {
      pendenciasCarregadas: wl.vendedoresAtivos.reduce((s, u) => s + (wl.porVendedor[u].pendentes || []).length, 0),
      pendenciasRetidas: Object.keys(pendenciasRetidas).length,
      pendenciasEncerradas: wl.pendenciasEncerradas || {},
      candidatosHoje: stats.hoje,
      gcNativeEmMemoria: stats.gcNativeEmMemoria,
      excluidos,
      backlog: wl.backlog.length,
      followUpsSemDonoAtivo: wl.followUpsSemDonoAtivo.length,
      nameLookups: sel.lookups,
      nameUnresolved: sel.nameUnresolved,
      nameSanitized: sel.nameSanitized,
      nameSanitizedEmpty: sel.nameSanitizedEmpty,
      vendedoresRejeitados: rejeitados.length,
    },
  };
}

async function carregarDados(db) {
  // N35.17: participantes vêm da configuração em sistema_usuarios (coleção pequena) — nenhum uid no código
  const [perfisSnap, clientesSnap, vendasSnap, interSnap, sistemaSnap, anteriorSnap] = await Promise.all([
    db.collection('perfis_360').get(),
    db.collection('clientes').get(),
    db.collection('vendas_gc').select(...CAMPOS_VENDAS).get(),
    db.collection('interacoes_fila').get(),
    db.collection('sistema_usuarios').get(),
    db.collection(COLL).doc(DOC_LIVE).get(), // N35.18.1: fonte do ownership (sempre a LIVE, também em DRY_RUN)
  ]);
  const sistema = new Map(sistemaSnap.docs.map(d => [d.id, d.data()]));
  const comConfig = [...sistema.entries()].filter(([, s]) => s && s[QC.FILA_CONFIG_FIELD]).map(([uid]) => uid);
  const userSnaps = await Promise.all(comConfig.map(uid => db.collection('users').doc(uid).get()));
  return {
    perfis: perfisSnap.docs.map(d => ({ id: d.id, data: d.data() })),
    clientes: clientesSnap.docs.map(d => ({ id: d.id, data: d.data() })),
    vendas: vendasSnap.docs.map(d => d.data()),
    estados: new Map(interSnap.docs.map(d => [d.id, d.data()])),
    users: new Map(comConfig.map((uid, i) => [uid, userSnaps[i].exists ? userSnaps[i].data() : null])),
    sistema,
    worklistAnterior: anteriorSnap.exists ? anteriorSnap.data() : null,
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
  const { participantes, rejeitados } = resolverParticipantes(d.sistema, d.users);
  const atribuicoesAnteriores = extrairAtribuicoesAnteriores(d.worklistAnterior || null, dataReferencia);
  const sel = await selecionarComNomes({
    candidatos: universo.hoje, estados: d.estados, participantes, dataReferencia,
    agoraIso: now.toISOString(), lookupNome, maxLookups: QC.MAX_NAME_LOOKUPS_PER_RUN,
    atribuicoesAnteriores,
  });
  const contextoPara = criarFabricaContexto({ dados: d, dataReferencia });
  const coletorGestao = new Map();
  const doc = montarDocumento({ wl: sel.wl, dataReferencia, geradoEm: now.toISOString(), stats: universo.stats, sel, rejeitados, participantes, contextoPara, coletorGestao });
  // N35.20.1: documento gerencial — só opportunityInstanceId → campos gerenciais (sem nome, uid ou PII)
  const docGestao = {
    schemaVersion: SCHEMA_GESTAO,
    dataReferencia,
    geradoEm: doc.geradoEm,
    itens: Object.fromEntries([...coletorGestao.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  };

  const bloqueados = verificarCamposBloqueados(doc);
  if (bloqueados.length) throw new Error('WORKLIST_DOC_CAMPOS_BLOQUEADOS: ' + bloqueados.join(','));
  // N35.20.1 — defesa final: documento legível pelo vendedor NUNCA contém campo exclusivo de gestão (fail closed)
  const expostos = camposGestaoExpostos(doc);
  if (expostos.length) throw new Error('WORKLIST_DOC_CAMPO_GESTAO_EXPOSTO: ' + expostos.slice(0, 5).join(','));
  // N35.16.1 — defesa final antes de persistir: nenhum nome vazio ou com CPF/CNPJ (fail closed, nada é gravado)
  const nomesInvalidos = Object.values(doc.vendedores)
    .flatMap(v => [...v.novas, ...v.followUps, ...v.emAtendimento, ...(v.pendentes || [])])
    .concat(Object.values(doc.atribuicoes))
    .filter(x => !x.nomeCliente || contemDocumento(x.nomeCliente)).length
    // retidas não são exibidas: nome pode faltar, mas nunca pode conter documento
    + Object.values(doc.pendenciasRetidas || {}).filter(x => x.nomeCliente && contemDocumento(x.nomeCliente)).length;
  if (nomesInvalidos) throw new Error(`WORKLIST_DOC_NOME_INVALIDO: ${nomesInvalidos}`);

  if (db) {
    const ref = db.collection(COLL).doc(destino);
    const refGestao = db.collection(COLL_GESTAO).doc(destino); // mesmo id (worklist | worklist_preview)
    if (mode === 'LIVE' && typeof db.runTransaction === 'function') {
      // N35.17: execuções concorrentes/retry — só a primeira grava a worklist do dia (CAP diário preservado)
      // N35.20.1: operacional + gerencial na MESMA transação (nunca um sem o outro)
      const gravou = await db.runTransaction(async tx => {
        const atual = await tx.get(ref);
        if (atual.exists && atual.data().dataReferencia === dataReferencia && atual.data().schemaVersion === SCHEMA_VERSION) return false;
        tx.set(ref, doc);
        tx.set(refGestao, docGestao);
        return true;
      });
      if (!gravou) {
        logger.log(JSON.stringify({ event: 'worklist_v2_ja_gerada', dataReferencia, origem: 'transacao' }));
        return { status: 'JA_GERADA_HOJE', escrito: null, doc: (await ref.get()).data() };
      }
    } else {
      const batch = typeof db.batch === 'function' ? db.batch() : null;
      if (batch) { batch.set(ref, doc); batch.set(refGestao, docGestao); await batch.commit(); }
      else { await ref.set(doc); await refGestao.set(docGestao); }
    }
  }
  logger.log(JSON.stringify({
    event: 'worklist_v2_gerada', mode, destino, dataReferencia,
    vendedores: doc.vendedoresAtivos.length,
    novas: doc.vendedoresAtivos.map(u => doc.vendedores[u].novas.length),
    followUps: doc.vendedoresAtivos.map(u => doc.vendedores[u].followUps.length),
    pendentes: doc.vendedoresAtivos.map(u => doc.vendedores[u].pendentes.length),
    pendenciasRetidas: doc.contagens.pendenciasRetidas,
    nameLookups: sel.lookups, nameUnresolved: sel.nameUnresolved,
  }));
  return { status: 'GERADA', escrito: db ? `${COLL}/${destino}` : null, escritoGestao: db ? `${COLL_GESTAO}/${destino}` : null, doc, docGestao, rejeitados };
}

module.exports = {
  executarGeracaoWorklist, selecionarComNomes, montarDocumento, carregarDados, itemDoc, criarFabricaContexto,
  COLL, DOC_LIVE, DOC_PREVIEW, SCHEMA_VERSION, COLL_GESTAO, SCHEMA_GESTAO,
};
