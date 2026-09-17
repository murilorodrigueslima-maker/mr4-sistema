'use strict';

/**
 * Configuração versionada do Score Comercial V1.
 *
 * STATUS: PROVISIONAL / EXPERIMENTAL
 * Os pesos abaixo são estimativas iniciais para validação estrutural.
 * PENDENTES de calibração com dados reais e decisão empresarial (ver PENDENCIAS.md S1).
 *
 * NÃO usar esses pesos como critério comercial definitivo até validação humana.
 */

const VERSAO_CONFIG = 'score-v1-provisional';

// ── Pesos dos componentes (soma = 100) ────────────────────────────────────────
// PROVISIONAL: pendente calibração empresarial
const PESOS = {
  recencia:           25,  // quão recente foi a última compra
  frequencia:         20,  // ritmo de compras
  faturamento:        25,  // volume financeiro
  tendencia:          15,  // trajetória de compras (crescendo/caindo)
  diversidade:        10,  // variedade de categorias
  engajamento:         5,  // proporção de janelas com compra
};

// ── Thresholds de recência (dias sem comprar) ─────────────────────────────────
// PROVISIONAL
const THRESHOLDS_RECENCIA = {
  excelente: 30,   // até 30 dias → pontuação máxima
  bom:        60,   // 31-60 dias
  regular:    90,   // 61-90 dias
  fraco:     120,   // 91-120 dias
  inativo:   Infinity, // > 120 dias → inativo
};

// ── Pontuação de recência (0-100) ─────────────────────────────────────────────
// PROVISIONAL: escala linear por faixas
const PONTOS_RECENCIA = {
  excelente: 100,
  bom:        75,
  regular:    50,
  fraco:      25,
  inativo:     0,
};

// ── Referências de faturamento para normalização ──────────────────────────────
// PROVISIONAL: baseado nos dados conhecidos do bootstrap (R$137k / 35 compradores ≈ R$3.9k/cliente)
const REF_FATURAMENTO_TOTAL    = 10000;  // R$10k → pontuação base máxima
const REF_FATURAMENTO_90D      = 3000;   // R$3k em 90d → pontuação 90d boa
const REF_PEDIDOS_90D          = 3;      // 3 pedidos em 90d → frequência boa

// ── Thresholds de tendência ───────────────────────────────────────────────────
// PROVISIONAL
const PONTOS_TENDENCIA = {
  CRESCENDO:    100,
  ESTAVEL:       75,
  SEM_BASE:      50,  // neutro — sem dados suficientes
  NUNCA_COMPROU:  0,
  CAINDO:        25,
};

// ── Classificação final do score ──────────────────────────────────────────────
// PROVISIONAL
const FAIXAS_SCORE = [
  { label: 'EXCELENTE', min: 80, max: 100 },
  { label: 'BOM',       min: 60, max: 79  },
  { label: 'REGULAR',   min: 40, max: 59  },
  { label: 'FRACO',     min: 20, max: 39  },
  { label: 'INATIVO',   min:  0, max: 19  },
];

module.exports = {
  VERSAO_CONFIG,
  PESOS,
  THRESHOLDS_RECENCIA,
  PONTOS_RECENCIA,
  REF_FATURAMENTO_TOTAL,
  REF_FATURAMENTO_90D,
  REF_PEDIDOS_90D,
  PONTOS_TENDENCIA,
  FAIXAS_SCORE,
};
