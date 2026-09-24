'use strict';
// N35.8 / N35.9C — Daily Worklist com CAP_10 e separação de follow-ups
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   PROD_WRITES=0
//   Funções puras — sem I/O, sem side effects
//   CAP_10 conceitual — NÃO ativar em produção (D-CAP)
//
// N35.9C — Regras CAP:
//   - CAP aplica-se exclusivamente a NOVAS oportunidades
//   - Follow-ups com nextFollowUpAt vencido ficam FORA do CAP (adicionais)
//   - FOLLOWUPS_COUNT_TOWARD_CAP = false

const config = require('./operationalConfig');

// ── Constantes ────────────────────────────────────────────────────────────────

const WORKLIST_CAP = config.DAILY_NEW_OPPORTUNITY_CAP;

const PRIORIDADE_ORDEM = Object.freeze({
  AGIR_AGORA:      1,
  PROGRAMAR_CICLO: 2,
  NAO_AGIR:        3,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compara dois clientesBrutos por prioridade e diasSemComprar.
 * Maior prioridade (número menor em PRIORIDADE_ORDEM) primeiro.
 * Em caso de empate: maior diasSemComprar primeiro (urgência).
 */
function compararPrioridade(a, b) {
  const pa = PRIORIDADE_ORDEM[a.decisaoAcaoComercial] ?? 99;
  const pb = PRIORIDADE_ORDEM[b.decisaoAcaoComercial] ?? 99;
  if (pa !== pb) return pa - pb;
  return (b.diasSemComprar || 0) - (a.diasSemComprar || 0);
}

/**
 * Retorna true se o item tem follow-up vencido para a dataReferencia.
 * Critérios:
 *   - estado existe e não é CONCLUIDA
 *   - nextFollowUpAt está definido
 *   - nextFollowUpAt <= dataReferencia (YYYY-MM-DD string comparison)
 *
 * @param {object|null} estadoOp — estado operacional do item (pode ser null)
 * @param {string}      dataReferencia — YYYY-MM-DD
 * @returns {boolean}
 */
function isDueFollowUp(estadoOp, dataReferencia) {
  if (!estadoOp) return false;
  if (!estadoOp.nextFollowUpAt) return false;
  // Importação lazy para evitar dependência circular (filaOperacional → dailyWorklist seria circular)
  const { ESTADOS } = require('./filaOperacional');
  if (estadoOp.estado === ESTADOS.CONCLUIDA) return false;
  // YYYY-MM-DD string comparison é lexicographicamente correta
  return estadoOp.nextFollowUpAt <= dataReferencia;
}

// ── API principal ─────────────────────────────────────────────────────────────

/**
 * Gera a worklist diária separando follow-ups vencidos de novas oportunidades.
 * CAP aplica-se apenas a novas oportunidades (FOLLOWUPS_COUNT_TOWARD_CAP=false).
 *
 * Elegibilidade geral:
 *   - NÃO concluída (estado != CONCLUIDA)
 *   - NÃO em cooldown ativo (isCooledDown)
 *   - NÃO em atendimento ativo por OUTRO operador (se operadorId fornecido)
 *   - Já em atendimento pelo mesmo operador: incluído (continuidade)
 *   - NÃO suprimida por entidade (suppressedEntities)
 *
 * Separação:
 *   - dueFollowUps: itens com nextFollowUpAt vencido (estado AGUARDANDO_RETORNO típico)
 *   - newOpportunities: demais elegíveis (CAP aplicado)
 *   - worklist: concat(dueFollowUps, newOpportunities) — lista final completa
 *
 * @param {object} opts
 * @param {Array}  opts.clientesHoje           — array de clientesBrutos (fila "hoje")
 * @param {Map}    opts.estadosOperacionais     — Map<opportunityInstanceId, estadoOperacional>
 * @param {string} [opts.operadorId]            — filtrar por operador (opcional)
 * @param {number} [opts.cap=WORKLIST_CAP]      — limite para NOVAS oportunidades (padrão: 10)
 * @param {string} [opts.dataReferencia]        — YYYY-MM-DD
 * @param {Map}    [opts.suppressedEntities]    — Map<commercialEntityId, isoUntil> — entidades suprimidas
 *                                               (p.ex. após SEM_INTERESSE, para novas instâncias do mesmo cliente)
 * @returns {{ worklist, dueFollowUps, newOpportunities, total, cap, aplicouCap, dataReferencia }}
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

  const { ESTADOS, isCooledDown } = require('./filaOperacional');

  // Classificar cada cliente em: excluído / followUp / novo
  const dueFollowUps    = [];
  const newOpportunities = [];

  for (const cliente of clientesHoje) {
    const oppId = cliente.opportunityInstanceId;
    const est   = oppId ? estadosOperacionais.get(oppId) : null;

    // Exclusão 1: concluída
    if (est && est.estado === ESTADOS.CONCLUIDA) continue;

    // Exclusão 2: cooldown ativo (3× SEM_RESPOSTA)
    if (est && isCooledDown(est, now + 'T00:00:00Z')) continue;

    // Exclusão 3: em atendimento por outro operador
    if (est && est.estado === ESTADOS.EM_ATENDIMENTO && est.claimAtual) {
      if (operadorId && est.claimAtual.operadorId !== operadorId) continue;
    }

    // Exclusão 4: entidade suprimida (p.ex. após SEM_INTERESSE em outra instância)
    const entId = cliente.commercialEntityId;
    if (entId && suppressed.has(entId)) {
      const suprimidaAte = suppressed.get(entId);
      if (new Date(now + 'T00:00:00Z') < new Date(suprimidaAte)) continue;
    }

    // Classificação: follow-up vencido vs nova oportunidade
    if (isDueFollowUp(est, now)) {
      dueFollowUps.push(cliente);
    } else {
      newOpportunities.push(cliente);
    }
  }

  // Ordenar cada grupo por prioridade comercial
  dueFollowUps.sort(compararPrioridade);
  newOpportunities.sort(compararPrioridade);

  // Aplicar CAP apenas às novas oportunidades
  const aplicouCap     = newOpportunities.length > cap;
  const cappedNewOpps  = newOpportunities.slice(0, cap);

  // Worklist final: follow-ups primeiro, depois novas oportunidades
  const worklist = [...dueFollowUps, ...cappedNewOpps];

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
 * Versão simplificada sem estados operacionais (testa apenas CAP e ordenação).
 * Útil para testes unitários do pipeline puro.
 *
 * @param {Array}  clientesHoje
 * @param {number} [cap=WORKLIST_CAP]
 * @returns {{ worklist: Array, total: number, cap: number, aplicouCap: boolean }}
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  WORKLIST_CAP,
  PRIORIDADE_ORDEM,
  compararPrioridade,
  isDueFollowUp,
  gerarDailyWorklist,
  gerarWorklistSimples,
};
