'use strict';

/**
 * Priorizador de Oportunidades Comerciais V1 — DETERMINÍSTICO, SEM LLM.
 *
 * Recebe uma lista de oportunidades (de oportunidades.js) + o score do cliente
 * e retorna as oportunidades ranqueadas por prioridade final.
 *
 * IMPORTANTE: score do cliente ≠ prioridade da oportunidade.
 *   - Um cliente com score alto pode ter oportunidade de prioridade baixa (tudo bem).
 *   - Um cliente com score baixo pode ter oportunidade urgente (ex: 200 dias inativo com R$50k histórico).
 *
 * Critérios de ranqueamento (todos PROVISIONAL, pendente calibração):
 *   1. urgencia (número base da oportunidade, 1-100)
 *   2. bonus por faturamento histórico alto (>= R$10k = +15 pts, >= R$5k = +8)
 *   3. penalidade por inativo muito longo (> 365d = -10)
 *
 * Score do cliente é informativo — não entra no cálculo da prioridade diretamente.
 * O ranqueamento final é: prioridadeFinal DESC, criadaEm ASC (desempate por mais antiga).
 */

const VERSAO_MOTOR = 'priorizador-v1';

// ── Configuração ──────────────────────────────────────────────────────────────
// PROVISIONAL

const BONUS_FATURAMENTO_ALTO  = 15;   // >= REF_FATURAMENTO_ALTO
const BONUS_FATURAMENTO_MEDIO = 8;    // >= REF_FATURAMENTO_MEDIO
const REF_FATURAMENTO_ALTO   = 10000;
const REF_FATURAMENTO_MEDIO  = 5000;
const PENALIDADE_INATIVO_LONGO = 10;  // > 365 dias
const LIMITE_INATIVO_LONGO     = 365;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Calcula a prioridade final de uma oportunidade, considerando contexto do perfil.
 * A prioridade base vem do motor de oportunidades; aqui adicionamos contexto.
 */
function calcularPrioridadeFinal(oportunidade, perfil) {
  let prioridade = oportunidade.prioridade;

  const fatHistorico = perfil.faturamentoTotal || 0;
  const diasSemComprar = perfil.diasSemComprar || 0;

  // Bonus por faturamento histórico (cliente de alto valor merece mais atenção)
  if (fatHistorico >= REF_FATURAMENTO_ALTO)       prioridade += BONUS_FATURAMENTO_ALTO;
  else if (fatHistorico >= REF_FATURAMENTO_MEDIO) prioridade += BONUS_FATURAMENTO_MEDIO;

  // Penalidade para inativos muito longos (probabilidade de resgate diminui)
  if (diasSemComprar > LIMITE_INATIVO_LONGO) prioridade -= PENALIDADE_INATIVO_LONGO;

  return clamp(Math.round(prioridade), 1, 100);
}

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Prioriza uma lista de oportunidades e retorna ranqueada.
 *
 * @param {Object[]} oportunidades  — array de oportunidades (de gerarOportunidades)
 * @param {Object}   perfil         — Perfil360 do cliente
 * @param {Object}   [score]        — resultado de calcularScore() — informativo apenas
 * @returns {Object[]}              — oportunidades ranqueadas com prioridadeFinal
 */
function priorizarOportunidades(oportunidades, perfil, score = null) {
  if (!Array.isArray(oportunidades)) {
    throw new Error('priorizarOportunidades: oportunidades deve ser array');
  }
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('priorizarOportunidades: perfil inválido ou ausente');
  }

  const ranqueadas = oportunidades.map((oport) => ({
    ...oport,
    prioridadeFinal: calcularPrioridadeFinal(oport, perfil),
    scoreClienteRef: score?.scoreTotal ?? null,  // informativo, não usado no rank
    statusConfig:    'PROVISIONAL',
    versaoMotorPriorizador: VERSAO_MOTOR,
  }));

  // Ordena: prioridadeFinal DESC; desempate por criadaEm ASC (mais antigas sobem)
  ranqueadas.sort((a, b) => {
    if (b.prioridadeFinal !== a.prioridadeFinal) return b.prioridadeFinal - a.prioridadeFinal;
    return (a.criadaEm || '').localeCompare(b.criadaEm || '');
  });

  return ranqueadas;
}

module.exports = {
  VERSAO_MOTOR,
  priorizarOportunidades,
  calcularPrioridadeFinal,
  BONUS_FATURAMENTO_ALTO,
  BONUS_FATURAMENTO_MEDIO,
  REF_FATURAMENTO_ALTO,
  REF_FATURAMENTO_MEDIO,
  PENALIDADE_INATIVO_LONGO,
  LIMITE_INATIVO_LONGO,
};
