'use strict';
// N35.8 / N35.9C / N35.14 — Daily Worklist
//
// INVARIANTES:
//   OPENAI_CALLS=0 · PROD_WRITES=0 · funções puras (sem I/O)
//
// N35.14 — Worklist V2 (gerarWorklistPorVendedor):
//   - CAP de NOVAS oportunidades POR VENDEDOR ATIVO (não global)
//   - vendedor ativo = configurado em filaQueueConfig E com permissão válida (resolverVendedoresAtivos)
//   - follow-ups vencidos (PEDIU_RETORNO / SEM_RESPOSTA #1-#2) → mesmo vendedor, FORA do CAP
//   - follow-up futuro, atendimento ativo e supressão bloqueiam a ENTIDADE (commercialEntityId),
//     não só a instância — mudança de tipo não burla a regra
//   - ordenação canônica única (filaOrdering), igual à do snapshot HOJE
//   - identidade só por IDs canônicos; nome nunca participa

const config = require('./operationalConfig');
const { compararOrdemCanonica } = require('./filaOrdering');

const WORKLIST_CAP = config.DAILY_NEW_OPPORTUNITY_CAP;
const MODULO_OPERAR = 'fila-comercial-operar';
const TIPOS_V1 = Object.freeze(['REATIVACAO_120D', 'JANELA_DE_RECOMPRA', 'QUEDA_DE_COMPRAS']);
const OPP_ID_RE = /^[0-9a-f]{16}$/;
const ENTITY_RE = /^(MR4_LINKED|GC_NATIVE):.+$/;

const PRIORIDADE_ORDEM = Object.freeze({
  AGIR_AGORA:      1,
  PROGRAMAR_CICLO: 2,
  NAO_AGIR:        3,
});

// ── Ordenação ─────────────────────────────────────────────────────────────────

/**
 * Agrupa por decisaoAcaoComercial (AGIR_AGORA primeiro) e, dentro do grupo,
 * aplica a ordenação canônica única. Na fila HOJE todos são AGIR_AGORA, então
 * a ordem é exatamente a canônica (prioridade → diasSemComprar → identidade).
 */
function compararPrioridade(a, b) {
  const pa = PRIORIDADE_ORDEM[a.decisaoAcaoComercial] ?? 99;
  const pb = PRIORIDADE_ORDEM[b.decisaoAcaoComercial] ?? 99;
  if (pa !== pb) return pa - pb;
  return compararOrdemCanonica(a, b);
}

// ── Helpers de estado ─────────────────────────────────────────────────────────

function ESTADOS_() { return require('./filaOperacional').ESTADOS; }

function ultimoOutcome(estado) {
  const evs = (estado.eventos || []).filter(e => e.tipo === 'OUTCOME_REGISTERED');
  return evs.length ? evs[evs.length - 1] : null;
}

/** Início do dia comercial (00:00 America/Fortaleza, UTC-3 sem horário de verão). */
function inicioDoDia(dataReferencia) {
  return `${dataReferencia}T03:00:00.000Z`;
}

function claimAtivo(estado, agoraIso) {
  const { ESTADOS, isClaimExpired } = require('./filaOperacional');
  return estado.estado === ESTADOS.EM_ATENDIMENTO && !!estado.claimAtual && !isClaimExpired(estado, agoraIso);
}

/**
 * Bloqueios por ENTIDADE derivados de todos os estados operacionais conhecidos.
 *   COOLDOWN               — cooledUntil ativo (SEM_INTERESSE_AGORA, 3× SEM_RESPOSTA)
 *   RECONTACT_SUPPRESSION  — encerrada (CONCLUIDA) há menos de RECONTACT_SUPPRESSION_DAYS
 * @returns {Map<commercialEntityId, {motivo, ate}>}
 */
function somarDias(iso, dias) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString();
}

function bloqueiosPorEntidade(estados, agoraIso) {
  const { ESTADOS, isCooledDown } = require('./filaOperacional');
  const out = new Map();
  const registrar = (ent, motivo, ate) => {
    const atual = out.get(ent);
    if (!atual || new Date(ate) > new Date(atual.ate)) out.set(ent, { motivo, ate });
  };
  for (const e of estados.values()) {
    if (!e || !e.commercialEntityId) continue;
    if (e.cooledUntil && isCooledDown(e, agoraIso)) registrar(e.commercialEntityId, 'COOLDOWN', e.cooledUntil);
    if (e.estado === ESTADOS.CONCLUIDA) {
      const ult = ultimoOutcome(e);
      const base = (ult && ult.timestamp) || e.atualizadoEm;
      if (base) {
        const ate = somarDias(base, config.RECONTACT_SUPPRESSION_DAYS);
        if (new Date(agoraIso) < new Date(ate)) registrar(e.commercialEntityId, 'RECONTACT_SUPPRESSION', ate);
      }
    }
  }
  return out;
}

/**
 * Compromissos operacionais abertos por ENTIDADE (bloqueiam a entidade como "nova"):
 *   EM_ATENDIMENTO — claim ativo (não expirado) → só o dono vê
 *   FOLLOWUP       — nextFollowUpAt definido, não concluída, sem cooldown → dono = autor do último outcome
 * @returns {Map<commercialEntityId, {tipo, estado, dono, vencido}>}
 */
function compromissosPorEntidade(estados, dataReferencia, agoraIso) {
  const { ESTADOS, isCooledDown } = require('./filaOperacional');
  const out = new Map();
  for (const e of estados.values()) {
    if (!e || !e.commercialEntityId) continue;
    if (claimAtivo(e, agoraIso)) {
      out.set(e.commercialEntityId, { tipo: 'EM_ATENDIMENTO', estado: e, dono: e.claimAtual.operadorId, vencido: true });
      continue;
    }
    if (e.estado !== ESTADOS.CONCLUIDA && e.nextFollowUpAt && !isCooledDown(e, agoraIso)) {
      if (out.has(e.commercialEntityId) && out.get(e.commercialEntityId).tipo === 'EM_ATENDIMENTO') continue;
      const ult = ultimoOutcome(e);
      out.set(e.commercialEntityId, {
        tipo: 'FOLLOWUP', estado: e, dono: ult ? ult.operadorId : null,
        vencido: e.nextFollowUpAt <= dataReferencia,
      });
    }
  }
  return out;
}

function gcIdDoCandidato(c) {
  if (typeof c.commercialEntityId === 'string' && c.commercialEntityId.startsWith('GC_NATIVE:')) {
    return c.commercialEntityId.slice('GC_NATIVE:'.length);
  }
  return c.gestaoClickId ? String(c.gestaoClickId) : null;
}

// ── Vendedores ativos ─────────────────────────────────────────────────────────

/**
 * Vendedor ativo = listado na configuração E com permissão operacional válida agora.
 * Possuir fila-comercial-operar sozinho NÃO torna ninguém ativo.
 *
 * @param {Array<{uid,label}>} configurados
 * @param {Map<uid, object>}   usersDocs      — users/{uid}
 * @param {Map<uid, object>}   sistemaDocs    — sistema_usuarios/{uid}
 * @returns {{ ativos: string[], rejeitados: Array<{uid, motivo}> }}
 */
function resolverVendedoresAtivos(configurados, usersDocs, sistemaDocs) {
  const ativos = [];
  const rejeitados = [];
  for (const s of configurados || []) {
    const u = usersDocs.get(s.uid);
    const sys = sistemaDocs.get(s.uid);
    let motivo = null;
    if (!u) motivo = 'USERS_DOC_AUSENTE';
    else if (u.ativo !== true) motivo = 'INATIVO';
    else if (u.role !== 'funcionario' && u.role !== 'gestor') motivo = 'ROLE_INVALIDA';
    else if (!sys) motivo = 'SISTEMA_USUARIOS_AUSENTE';
    else if (sys.bloqueado === true) motivo = 'BLOQUEADO';
    else if (!Array.isArray(sys.modulos) || !sys.modulos.includes(MODULO_OPERAR)) motivo = 'SEM_MODULO_OPERAR';
    if (motivo) rejeitados.push({ uid: s.uid, motivo }); else ativos.push(s.uid);
  }
  return { ativos: [...new Set(ativos)].sort(), rejeitados };
}

// ── Worklist V2 ───────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {Array}  p.candidatos        — clientesBrutos (pipeline) com commercialEntityId/opportunityInstanceId
 * @param {Map}    p.estados           — Map<opportunityInstanceId, estado> (interacoes_fila)
 * @param {string[]} p.vendedoresAtivos — uids já resolvidos por resolverVendedoresAtivos
 * @param {string} p.dataReferencia    — YYYY-MM-DD (dia comercial)
 * @param {string} [p.agoraIso]        — instante da geração (default: 00:00 do dia comercial)
 * @param {Iterable<string>} [p.duplicateGcIds]
 * @param {Iterable<string>} [p.canaryIds]
 * @param {number} [p.cap]             — CAP de NOVAS por vendedor
 */
function gerarWorklistPorVendedor({
  candidatos, estados, vendedoresAtivos, dataReferencia, agoraIso,
  duplicateGcIds = [], canaryIds = [], cap = WORKLIST_CAP,
}) {
  if (!Array.isArray(candidatos)) throw new Error('gerarWorklistPorVendedor: candidatos deve ser array');
  if (!(estados instanceof Map)) throw new Error('gerarWorklistPorVendedor: estados deve ser Map');
  if (!Array.isArray(vendedoresAtivos)) throw new Error('gerarWorklistPorVendedor: vendedoresAtivos deve ser array');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia || '')) throw new Error('gerarWorklistPorVendedor: dataReferencia obrigatória');
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`gerarWorklistPorVendedor: cap inválido: ${cap}`);

  const { ESTADOS } = require('./filaOperacional');
  const agora = agoraIso || inicioDoDia(dataReferencia);
  const ativos = [...new Set(vendedoresAtivos)].sort();
  const ativosSet = new Set(ativos);
  const dup = new Set([...duplicateGcIds].map(String));
  const canarios = new Set(canaryIds);

  const bloqueios = bloqueiosPorEntidade(estados, agora);
  const compromissos = compromissosPorEntidade(estados, dataReferencia, agora);

  const porVendedor = Object.fromEntries(ativos.map(uid => [uid, { dueFollowUps: [], emAtendimento: [], newOpportunities: [] }]));
  const excluidos = {};
  const excluir = (motivo, c) => { (excluidos[motivo] = excluidos[motivo] || []).push(c.opportunityInstanceId || c.commercialEntityId || null); };
  const canariosSeparados = [];
  const followUpsSemDonoAtivo = [];

  // Índice de candidatos por entidade (melhor instância pela ordem canônica)
  const ordenados = [...candidatos].filter(Boolean).sort(compararOrdemCanonica);
  const melhorPorEntidade = new Map();
  for (const c of ordenados) {
    if (!ENTITY_RE.test(c.commercialEntityId || '') || !OPP_ID_RE.test(c.opportunityInstanceId || '')) { excluir('IDENTIDADE_INVALIDA', c); continue; }
    if (melhorPorEntidade.has(c.commercialEntityId)) { excluir('ENTIDADE_DUPLICADA_NO_INPUT', c); continue; }
    melhorPorEntidade.set(c.commercialEntityId, c);
  }

  // 1) Compromissos abertos: atendimento ativo e follow-ups (fora do CAP, dono fixo)
  for (const [ent, k] of compromissos) {
    const cand = melhorPorEntidade.get(ent);
    const item = {
      ...(cand || {}),
      commercialEntityId: ent,
      opportunityInstanceId: k.estado.opportunityInstanceId,
      tipoOportunidade: k.estado.tipoOportunidade,
      estadoOperacional: k.estado.estado,
      nextFollowUpAt: k.estado.nextFollowUpAt || null,
    };
    if (k.tipo === 'EM_ATENDIMENTO') {
      if (ativosSet.has(k.dono)) porVendedor[k.dono].emAtendimento.push(item);
      continue;
    }
    if (!k.vencido) continue; // follow-up futuro: fora de tudo até a data
    if (ativosSet.has(k.dono)) porVendedor[k.dono].dueFollowUps.push(item);
    else followUpsSemDonoAtivo.push({ ...item, donoOriginal: k.dono });
  }

  // 2) Pool de NOVAS
  const pool = [];
  for (const [ent, c] of melhorPorEntidade) {
    if (c.decisaoAcaoComercial !== 'AGIR_AGORA' || !TIPOS_V1.includes(c.tipoOportunidade)) { excluir('FORA_DA_FILA_HOJE', c); continue; }
    const gc = gcIdDoCandidato(c);
    if (gc && dup.has(gc)) { excluir('DUPLICATA_GC', c); continue; }
    if (canarios.has(c.opportunityInstanceId)) { canariosSeparados.push(c); continue; }
    if (compromissos.has(ent)) {
      const k = compromissos.get(ent);
      excluir(k.tipo === 'EM_ATENDIMENTO' ? 'EM_ATENDIMENTO' : (k.vencido ? 'FOLLOWUP_VENCIDO' : 'FOLLOWUP_FUTURO'), c);
      continue;
    }
    if (bloqueios.has(ent)) { excluir(bloqueios.get(ent).motivo, c); continue; }
    const est = estados.get(c.opportunityInstanceId);
    if (est && est.estado === ESTADOS.CONCLUIDA) { excluir('CONCLUIDA_MESMA_INSTANCIA', c); continue; }
    pool.push(c);
  }
  pool.sort(compararOrdemCanonica);

  // 3) Distribuição determinística: round-robin sobre a ordem canônica,
  //    vendedor inicial rotacionado por dia. Sem inferência de carteira.
  const backlog = [];
  const n = ativos.length;
  if (n === 0) {
    backlog.push(...pool);
  } else {
    let k = Math.floor(Date.parse(dataReferencia + 'T12:00:00Z') / 86400000) % n;
    for (const c of pool) {
      let tentativas = 0;
      while (tentativas < n && porVendedor[ativos[k % n]].newOpportunities.length >= cap) { k++; tentativas++; }
      if (tentativas >= n) { backlog.push(c); continue; }
      porVendedor[ativos[k % n]].newOpportunities.push({ ...c, assignedSeller: ativos[k % n] });
      k++;
    }
  }

  for (const uid of ativos) {
    const g = porVendedor[uid];
    g.dueFollowUps.sort(compararOrdemCanonica);
    g.dueFollowUps = g.dueFollowUps.map(c => ({ ...c, assignedSeller: uid }));
    g.emAtendimento = g.emAtendimento.map(c => ({ ...c, assignedSeller: uid }));
    g.worklist = [...g.dueFollowUps, ...g.newOpportunities];
  }

  return {
    dataReferencia,
    geradoParaInstante: agora,
    cap,
    vendedoresAtivos: ativos,
    porVendedor,
    canarios: canariosSeparados.sort(compararOrdemCanonica),
    followUpsSemDonoAtivo,
    backlog,
    excluidos,
  };
}

/**
 * Índice oppId → atribuição. Lança erro se a mesma oportunidade ou entidade
 * aparecer para dois vendedores (invariante de não-colisão).
 */
function indiceAtribuicoes(wl) {
  const porOpp = new Map();
  const porEnt = new Map();
  for (const [uid, g] of Object.entries(wl.porVendedor)) {
    for (const grupo of ['dueFollowUps', 'emAtendimento', 'newOpportunities']) {
      for (const c of g[grupo]) {
        if (porOpp.has(c.opportunityInstanceId)) throw new Error(`COLISAO_OPORTUNIDADE ${c.opportunityInstanceId}`);
        if (porEnt.has(c.commercialEntityId) && porEnt.get(c.commercialEntityId) !== uid) throw new Error(`COLISAO_ENTIDADE ${c.commercialEntityId}`);
        porOpp.set(c.opportunityInstanceId, { uid, grupo, commercialEntityId: c.commercialEntityId, tipoOportunidade: c.tipoOportunidade });
        porEnt.set(c.commercialEntityId, uid);
      }
    }
  }
  return porOpp;
}

/**
 * Documento persistível da worklist do dia (fila_comercial/worklist) — só IDs, sem PII.
 * Usado pelo claim para validar atribuição antes da criação lazy.
 */
function montarDocumentoWorklist(wl, geradoEmIso) {
  const atribuicoes = {};
  for (const [oppId, a] of indiceAtribuicoes(wl)) atribuicoes[oppId] = a;
  return {
    schemaVersion: 'worklist-v2',
    dataReferencia: wl.dataReferencia,
    geradoEm: geradoEmIso,
    cap: wl.cap,
    vendedoresAtivos: wl.vendedoresAtivos,
    atribuicoes,
    canarios: wl.canarios.map(c => c.opportunityInstanceId),
  };
}

// ── API legada (N35.8/N35.9C) — corrigida para as mesmas regras de estado ────

/**
 * Retorna true se o item tem follow-up vencido para a dataReferencia.
 */
function isDueFollowUp(estadoOp, dataReferencia) {
  if (!estadoOp) return false;
  if (!estadoOp.nextFollowUpAt) return false;
  if (estadoOp.estado === ESTADOS_().CONCLUIDA) return false;
  return estadoOp.nextFollowUpAt <= dataReferencia;
}

/**
 * Worklist de um operador (API legada). Não distribui entre vendedores — use
 * gerarWorklistPorVendedor para distribuição. N35.14: mesmas regras de estado da V2
 * (follow-up futuro excluído; atendimento de outro excluído; supressão por entidade;
 * follow-up vencido de outro operador não aparece; ordenação canônica).
 */
function gerarDailyWorklist({
  clientesHoje,
  estadosOperacionais,
  operadorId,
  cap = WORKLIST_CAP,
  dataReferencia,
  suppressedEntities,
}) {
  if (!Array.isArray(clientesHoje)) {
    throw new Error('gerarDailyWorklist: clientesHoje deve ser array');
  }
  if (!(estadosOperacionais instanceof Map)) {
    throw new Error('gerarDailyWorklist: estadosOperacionais deve ser Map');
  }
  if (cap < 1 || !Number.isInteger(cap)) {
    throw new Error(`gerarDailyWorklist: cap inválido: ${cap}`);
  }

  const suppressed = suppressedEntities instanceof Map ? suppressedEntities : new Map();
  const now = dataReferencia || new Date().toISOString().slice(0, 10);
  const agora = inicioDoDia(now);
  const { ESTADOS, isCooledDown } = require('./filaOperacional');
  const bloqueios = bloqueiosPorEntidade(estadosOperacionais, agora);

  const dueFollowUps = [];
  const newOpportunities = [];

  for (const cliente of clientesHoje) {
    const oppId = cliente.opportunityInstanceId;
    const est = oppId ? estadosOperacionais.get(oppId) : null;
    const entId = cliente.commercialEntityId;

    if (est && est.estado === ESTADOS.CONCLUIDA) continue;
    if (est && isCooledDown(est, now + 'T00:00:00Z')) continue;

    // API legada: qualquer atendimento em curso de outro operador (ou sem operador informado) é excluído.
    // Expiração de claim (4h) é tratada na V2 e na callable.
    if (est && est.estado === ESTADOS.EM_ATENDIMENTO && est.claimAtual) {
      if (!operadorId || est.claimAtual.operadorId !== operadorId) continue;
    }

    if (entId && suppressed.has(entId)) {
      if (new Date(now + 'T00:00:00Z') < new Date(suppressed.get(entId))) continue;
    }
    if (entId && bloqueios.has(entId) && !(est && isDueFollowUp(est, now))) continue;

    if (est && est.nextFollowUpAt && est.estado !== ESTADOS.CONCLUIDA && est.nextFollowUpAt > now) continue;

    if (isDueFollowUp(est, now)) {
      const dono = (ultimoOutcome(est) || {}).operadorId;
      if (operadorId && dono && dono !== operadorId) continue;
      dueFollowUps.push(cliente);
    } else {
      newOpportunities.push(cliente);
    }
  }

  dueFollowUps.sort(compararPrioridade);
  newOpportunities.sort(compararPrioridade);

  const aplicouCap    = newOpportunities.length > cap;
  const cappedNewOpps = newOpportunities.slice(0, cap);
  const worklist      = [...dueFollowUps, ...cappedNewOpps];

  return {
    worklist,
    dueFollowUps,
    newOpportunities:   cappedNewOpps,
    total:              dueFollowUps.length + newOpportunities.length,
    totalEligivel:      dueFollowUps.length + newOpportunities.length,
    cap,
    aplicouCap,
    dataReferencia:     now,
    geradoEm:           new Date().toISOString(),
  };
}

/**
 * Versão simplificada sem estados operacionais (CAP + ordenação canônica).
 */
function gerarWorklistSimples(clientesHoje, cap = WORKLIST_CAP) {
  if (!Array.isArray(clientesHoje)) {
    throw new Error('gerarWorklistSimples: clientesHoje deve ser array');
  }
  if (cap < 1 || !Number.isInteger(cap)) {
    throw new Error(`gerarWorklistSimples: cap inválido: ${cap}`);
  }
  const ordenados  = [...clientesHoje].sort(compararPrioridade);
  const aplicouCap = ordenados.length > cap;
  const worklist   = ordenados.slice(0, cap);
  return { worklist, total: clientesHoje.length, cap, aplicouCap };
}

module.exports = {
  WORKLIST_CAP,
  PRIORIDADE_ORDEM,
  TIPOS_V1,
  compararPrioridade,
  isDueFollowUp,
  gerarDailyWorklist,
  gerarWorklistSimples,
  // N35.14
  resolverVendedoresAtivos,
  gerarWorklistPorVendedor,
  indiceAtribuicoes,
  montarDocumentoWorklist,
  bloqueiosPorEntidade,
  compromissosPorEntidade,
  inicioDoDia,
};
