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

  // Máximo de NOVAS oportunidades por operador por dia (padrão quando o vendedor não define limite)
  DAILY_NEW_OPPORTUNITY_CAP: 10,

  // N35.17 — teto de segurança para sistema_usuarios.filaComercial.limiteNovasPorDia
  MAX_NEW_OPPORTUNITY_CAP_PER_SELLER: 30,

  // Follow-ups com data vencida NÃO consomem quota do CAP
  FOLLOWUPS_COUNT_TOWARD_CAP: false,

  // N35.14 — D-RETRY: SEM_RESPOSTA #1/#2 volta no próximo dia útil, mesmo vendedor, fora do CAP
  SEM_RESPOSTA_RETRY_RULE: 'NEXT_BUSINESS_DAY',

  // N35.14 — D-RECONTACT: entidade (commercialEntityId) suprimida após encerramento
  RECONTACT_SUPPRESSION_DAYS: 30,

  // Fuso comercial para "dia" e "dia útil" (sem horário de verão)
  BUSINESS_TIMEZONE: 'America/Fortaleza',
});

module.exports = OPERATIONAL_CONFIG_V1;
