'use strict';
// N35.9C — Configuração operacional V1
// Decisões de negócio aprovadas por Murilo (2026-09-24)
// NÃO criar Firestore config. NÃO usar remote config.

const OPERATIONAL_CONFIG_V1 = Object.freeze({
  // Cooldown após SEM_INTERESSE_AGORA (dias)
  SEM_INTERESSE_COOLDOWN_DAYS: 30,

  // Quantas respostas SEM_RESPOSTA consecutivas ativam cooldown
  SEM_RESPOSTA_MAX_CONSECUTIVE: 3,

  // Cooldown após atingir SEM_RESPOSTA_MAX_CONSECUTIVE (dias)
  SEM_RESPOSTA_COOLDOWN_DAYS: 30,

  // Tempo máximo de claim exclusivo antes de expirar (horas)
  CLAIM_TIMEOUT_HOURS: 4,

  // Máximo de NOVAS oportunidades por operador por dia
  DAILY_NEW_OPPORTUNITY_CAP: 10,

  // Follow-ups com data vencida NÃO consomem quota do CAP
  FOLLOWUPS_COUNT_TOWARD_CAP: false,
});

module.exports = OPERATIONAL_CONFIG_V1;
