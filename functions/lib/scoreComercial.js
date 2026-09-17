'use strict';

/**
 * Motor de Score Comercial — PROPENSAO_RECOMPRA_V1.
 *
 * SIGNIFICADO OFICIAL: "FORÇA DOS SINAIS DE QUE O CLIENTE PODE VOLTAR A COMPRAR."
 * Não é probabilidade, não é percentual de chance.
 *
 * Recebe um Perfil360 e retorna score explicável por componentes.
 * Mesma entrada + mesma config = mesma saída (sem randomização, sem I/O).
 *
 * APROVADO_PROPRIETARIO_2026-09-17
 *
 * NÃO usa: encarteiramento, margem, crédito, dados externos, LLM.
 * NÃO decide: preço, desconto, limite, carteira, pedido.
 */

const CFG = require('../config/score-comercial.v1.js');

const VERSAO_MOTOR = 'score-v1';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ── Componente: Recência ──────────────────────────────────────────────────────
// Máximo: PESOS.recencia = 38 pts (quando pontuacao=100)

function calcularRecencia(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { diasSemComprar: null } };
  }

  const dias = perfil.diasSemComprar;
  const t = CFG.THRESHOLDS_RECENCIA;
  const p = CFG.PONTOS_RECENCIA;

  let faixa, pontuacao;
  if (dias <= t.excelente)      { faixa = 'excelente'; pontuacao = p.excelente; }
  else if (dias <= t.bom)       { faixa = 'bom';       pontuacao = p.bom; }
  else if (dias <= t.regular)   { faixa = 'regular';   pontuacao = p.regular; }
  else if (dias < t.fraco)      { faixa = 'fraco';     pontuacao = p.fraco; }
  else                          { faixa = 'inativo';   pontuacao = p.inativo; }

  return { pontuacao, faixa, detalhes: { diasSemComprar: dias } };
}

// ── Componente: Frequência / Recorrência ──────────────────────────────────────
// DECISÃO V1: cliente com somente 1 data distinta de compra → SEM_BASE → 0 pts.
// Pedidos no mesmo dia não criam frequência artificial.
// A partir da 2ª data distinta de compra, frequência pode ser calculada.
// Máximo: PESOS.frequencia = 30 pts (quando pontuacao=100)

function calcularFrequencia(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { pedidos90d: 0, diasEntreCompras: null } };
  }

  // Single purchase → SEM_BASE: não inferir frequência de uma única compra.
  // diasEntreComprasMediana === null indica que não há 2 datas distintas.
  if (perfil.pedidosTotal <= 1 || perfil.diasEntreComprasMediana === null || perfil.diasEntreComprasMediana === undefined) {
    return {
      pontuacao: 0,
      faixa: 'SEM_BASE',
      detalhes: {
        pedidosTotal: perfil.pedidosTotal || 0,
        pedidos90d: perfil.pedidos90d || 0,
        diasEntreCompras: null,
        motivo: 'requer >= 2 datas distintas de compra para calcular frequência',
      },
    };
  }

  const pedidos90d = perfil.pedidos90d || 0;
  const ref = 3;  // REF_PEDIDOS_90D — 3 pedidos em 90d = frequência de referência

  const pontuacao = clamp(Math.round((pedidos90d / ref) * 100), 0, 100);
  const faixa = pedidos90d === 0  ? 'SEM_COMPRAS_90D'
    : pedidos90d >= ref           ? 'ALTA'
    : pedidos90d >= ref / 2       ? 'MEDIA'
    : 'BAIXA';

  return {
    pontuacao,
    faixa,
    detalhes: {
      pedidos90d,
      referencia: ref,
      diasEntreComprasMedio:   perfil.diasEntreComprasMedio,
      diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    },
  };
}

// ── Componente: Faturamento ───────────────────────────────────────────────────
// DECISÃO V1: faixas progressivas. NÃO domina o score (máx 10 pts).
// Máximo: PESOS.faturamento = 10 pts (quando pontuacao=100)

function calcularFaturamento(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { faturamentoTotal: 0 } };
  }

  const fatTotal = perfil.faturamentoTotal || 0;

  // Tiers progressivos baseados na realidade dos vinculados (mediana ≈ R$1.964, P75 ≈ R$4.824)
  let pontuacao = 0;
  let faixa = 'BAIXO';
  for (const tier of CFG.FAIXAS_FATURAMENTO) {
    if (fatTotal >= tier.min && fatTotal <= tier.max) {
      pontuacao = tier.pontuacao;
      faixa = tier.label;
      break;
    }
  }

  return {
    pontuacao,
    faixa,
    detalhes: { faturamentoTotal: fatTotal },
  };
}

// ── Componente: Tendência (recebe classificação externa) ──────────────────────
// Máximo: PESOS.tendencia = 15 pts (quando pontuacao=100)

function calcularTendenciaPontuacao(tendencia) {
  const pontuacao = CFG.PONTOS_TENDENCIA[tendencia] ?? CFG.PONTOS_TENDENCIA['SEM_BASE'];
  return { pontuacao, tendencia };
}

// ── Componente: Diversidade de Categorias ─────────────────────────────────────
// Máximo: PESOS.diversidade = 7 pts (quando pontuacao=100)

function calcularDiversidade(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { categorias: 0, produtos: 0 } };
  }

  const numCats  = (perfil.categoriasMaisCompradas || []).length;
  const numProds = perfil.quantidadeProdutosDistintos || 0;

  // 1 cat=25, 2=50, 3=75, 4+=100
  const pontuacao = clamp(numCats * 25, 0, 100);
  const faixa = numCats === 0 ? 'ZERO'
    : numCats === 1 ? 'BAIXA'
    : numCats <= 2  ? 'MEDIA'
    : 'ALTA';

  return { pontuacao, faixa, detalhes: { categorias: numCats, produtos: numProds } };
}

// ── Componente: Engajamento ───────────────────────────────────────────────────
// DECISÃO V1: PESO = 0. Mantido para compatibilidade; não contribui para o score.
// Motivo: sem fonte de dados confiável em V1 (NPS, canais, cliques não disponíveis).

function calcularEngajamento(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { janelasCom: 0 } };
  }

  const janelasCom = [perfil.pedidos30d, perfil.pedidos60d, perfil.pedidos90d, perfil.pedidos180d]
    .filter(v => v > 0).length;

  const pontuacao = Math.round((janelasCom / 4) * 100);
  const faixa = janelasCom === 4 ? 'MUITO_ATIVO'
    : janelasCom >= 3 ? 'ATIVO'
    : janelasCom >= 2 ? 'MODERADO'
    : janelasCom === 1 ? 'BAIXO'
    : 'INATIVO';

  return { pontuacao, faixa, detalhes: { janelasCom } };
}

// ── Classificação final ───────────────────────────────────────────────────────

function classificarScore(scoreTotal) {
  for (const faixa of CFG.FAIXAS_SCORE) {
    if (scoreTotal >= faixa.min && scoreTotal <= faixa.max) return faixa.label;
  }
  return 'INATIVO';
}

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Calcula o Score de Propensão de Recompra para um cliente a partir do Perfil360.
 *
 * @param {Object} perfil      — Perfil360 calculado por calcularPerfil360()
 * @param {string} tendencia   — Classificação do motor de tendência (ex: 'CRESCENDO')
 * @param {Object} [opcoes]    — { dataReferencia: 'YYYY-MM-DD' }
 * @returns {Object}           — Score com componentes, motivos, metadados
 */
function calcularScore(perfil, tendencia = 'SEM_BASE', opcoes = {}) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('calcularScore: perfil inválido ou ausente');
  }

  const dataReferencia = opcoes.dataReferencia || perfil.dataReferencia || null;
  const calculadoEm    = new Date().toISOString();

  const recencia      = calcularRecencia(perfil);
  const frequencia    = calcularFrequencia(perfil);
  const faturamento   = calcularFaturamento(perfil);
  const tendenciaCmp  = calcularTendenciaPontuacao(tendencia);
  const diversidade   = calcularDiversidade(perfil);
  const engajamento   = calcularEngajamento(perfil);

  const p = CFG.PESOS;

  // Score total ponderado (0-100)
  // Componentes: 0-100 | Pesos: soma=100 | resultado: (sum × pesos) / 100 ∈ [0,100]
  const scoreTotal = clamp(
    Math.round(
      (recencia.pontuacao     * p.recencia     / 100) +
      (frequencia.pontuacao   * p.frequencia   / 100) +
      (faturamento.pontuacao  * p.faturamento  / 100) +
      (tendenciaCmp.pontuacao * p.tendencia    / 100) +
      (diversidade.pontuacao  * p.diversidade  / 100) +
      (engajamento.pontuacao  * p.engajamento  / 100)
    ),
    0, 100
  );

  const classificacao = classificarScore(scoreTotal);

  const motivos = [];
  if (perfil.nuncaComprou)                            motivos.push('NUNCA_COMPROU');
  if (perfil.inativo120d)                              motivos.push('INATIVO_120D');
  if (recencia.faixa    === 'excelente')               motivos.push('RECENCIA_EXCELENTE');
  if (frequencia.faixa  === 'ALTA')                    motivos.push('FREQUENCIA_ALTA');
  if (faturamento.faixa === 'ALTO')                    motivos.push('FATURAMENTO_ALTO');
  if (tendencia         === 'CRESCENDO')               motivos.push('TENDENCIA_CRESCENTE');
  if (tendencia         === 'CAINDO')                  motivos.push('TENDENCIA_QUEDA');
  if (diversidade.faixa === 'ALTA')                    motivos.push('DIVERSIDADE_ALTA');

  return {
    clienteMr4Id:   perfil.clienteMr4Id,
    gestaoClickId:  perfil.gestaoClickId,
    scoreTotal,
    classificacao,
    versaoMotor:    VERSAO_MOTOR,
    versaoConfig:   CFG.VERSAO_CONFIG,
    versaoScore:    'PROPENSAO_RECOMPRA_V1',
    statusConfig:   'APROVADO_PROPRIETARIO_2026-09-17',
    motivos,
    componentes: {
      recencia:    { peso: p.recencia,    ...recencia },
      frequencia:  { peso: p.frequencia,  ...frequencia },
      faturamento: { peso: p.faturamento, ...faturamento },
      tendencia:   { peso: p.tendencia,   ...tendenciaCmp },
      diversidade: { peso: p.diversidade, ...diversidade },
      engajamento: { peso: p.engajamento, ...engajamento },
    },
    dadosBase: {
      nuncaComprou:     perfil.nuncaComprou,
      inativo120d:      perfil.inativo120d,
      diasSemComprar:   perfil.diasSemComprar,
      faturamentoTotal: perfil.faturamentoTotal,
      faturamento90d:   perfil.faturamento90d,
      pedidosTotal:     perfil.pedidosTotal,
      pedidos90d:       perfil.pedidos90d,
      ultimaCompraEm:   perfil.ultimaCompraEm,
    },
    dataReferencia,
    calculadoEm,
  };
}

module.exports = {
  VERSAO_MOTOR,
  calcularScore,
  // Funções expostas para testes unitários
  calcularRecencia,
  calcularFrequencia,
  calcularFaturamento,
  calcularTendenciaPontuacao,
  calcularDiversidade,
  calcularEngajamento,
  classificarScore,
};
