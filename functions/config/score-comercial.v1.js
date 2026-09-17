'use strict';

/**
 * Configuração versionada do Score Comercial — PROPENSAO_RECOMPRA_V1.
 *
 * SIGNIFICADO OFICIAL:
 *   Score = "FORÇA DOS SINAIS DE QUE O CLIENTE PODE VOLTAR A COMPRAR."
 *   NÃO é probabilidade, NÃO é percentual de chance.
 *   Score 90 = sinais comerciais muito fortes de possível nova compra.
 *
 * STATUS: APROVADO_PROPRIETARIO_2026-09-17
 */

const VERSAO_CONFIG = 'score-propensao-recompra-v1';

const SCORE_SIGNIFICADO = 'FORCA_DOS_SINAIS_DE_POSSIVEL_RECOMPRA';

// ── Pesos dos componentes (soma = 100) ────────────────────────────────────────
// APROVADO em 2026-09-17
const PESOS = {
  recencia:    38,  // quão recente foi a última compra
  frequencia:  30,  // ritmo de compras (com recorrência via mediana)
  tendencia:   15,  // trajetória de compras (crescendo/caindo)
  faturamento: 10,  // volume financeiro (tiers progressivos)
  diversidade:  7,  // variedade de categorias
  engajamento:  0,  // DESATIVADO V1 — sem fonte de dados confiável
};

// ── Thresholds de recência (dias sem comprar) ─────────────────────────────────
// Regra empresarial: >= 120 dias = INATIVO. NUNCA alterar esse threshold.
// Never bought NÃO é inativo.
const THRESHOLDS_RECENCIA = {
  excelente: 30,       // 0-30 dias → pontuação máxima
  bom:        60,       // 31-60 dias
  regular:    90,       // 61-90 dias
  fraco:     120,       // 91-119 dias (note: >= 120 = inativo)
  inativo:   Infinity,  // >= 120 dias → inativo
};

// ── Pontuação de recência (0-100) ─────────────────────────────────────────────
// Componente contribui: pontuacao_0_100 × PESOS.recencia / 100 → máx 38 pts
const PONTOS_RECENCIA = {
  excelente: 100,
  bom:        75,
  regular:    50,
  fraco:      25,
  inativo:     0,
};

// ── Tiers de faturamento (V1) ─────────────────────────────────────────────────
// Distribuição progressiva. Baseada na realidade dos compradores vinculados:
//   mediana histórica ≈ R$1.964 | P75 ≈ R$4.824
// Componente retorna 0-100; contribui: pontuacao × PESOS.faturamento / 100 → máx 10 pts
const FAIXAS_FATURAMENTO = [
  { min: 10000, max: Infinity, pontuacao: 100, label: 'ALTO' },      // >= R$10k   → 10 pts
  { min:  5000, max:  9999.99, pontuacao:  80, label: 'MEDIO_ALTO' }, // R$5k-<R$10k→  8 pts
  { min:  2000, max:  4999.99, pontuacao:  60, label: 'MEDIO' },      // R$2k-<R$5k →  6 pts
  { min:  1000, max:  1999.99, pontuacao:  40, label: 'BAIXO_MEDIO' },// R$1k-<R$2k →  4 pts
  { min:     0, max:   999.99, pontuacao:  20, label: 'BAIXO' },      // R$0-<R$1k  →  2 pts
];

// ── Pontuação de tendência (0-100) ────────────────────────────────────────────
// Componente contribui: pontuacao × PESOS.tendencia / 100 → máx 15 pts
const PONTOS_TENDENCIA = {
  CRESCENDO:     100,
  ESTAVEL:        75,
  SEM_BASE:       50,  // neutro — sem dados suficientes para classificar
  NUNCA_COMPROU:   0,
  CAINDO:         25,
};

// ── Classificação final do score ──────────────────────────────────────────────
const FAIXAS_SCORE = [
  { label: 'EXCELENTE', min: 80, max: 100 },
  { label: 'BOM',       min: 60, max: 79  },
  { label: 'REGULAR',   min: 40, max: 59  },
  { label: 'FRACO',     min: 20, max: 39  },
  { label: 'INATIVO',   min:  0, max: 19  },
];

// ── Feature flags ─────────────────────────────────────────────────────────────
// DECISÃO V1: cross-sell desativado — nenhuma oportunidade CROSS_SELL_CATEGORIA gerada.
// Motor não foi apagado; apenas flag desativa geração oficial.
const CROSS_SELL_ENABLED = false;

module.exports = {
  VERSAO_CONFIG,
  SCORE_SIGNIFICADO,
  PESOS,
  THRESHOLDS_RECENCIA,
  PONTOS_RECENCIA,
  FAIXAS_FATURAMENTO,
  PONTOS_TENDENCIA,
  FAIXAS_SCORE,
  CROSS_SELL_ENABLED,
};
