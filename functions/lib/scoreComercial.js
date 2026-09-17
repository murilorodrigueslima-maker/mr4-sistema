'use strict';

/**
 * Motor de Score Comercial V1 — DETERMINÍSTICO, SEM LLM.
 *
 * Recebe um Perfil360 e retorna score explicável por componentes.
 * Mesma entrada + mesma config = mesma saída (sem randomização, sem I/O).
 *
 * STATUS DOS PESOS: PROVISIONAL / EXPERIMENTAL — ver config/score-comercial.v1.js
 * Os pesos precisam de calibração empresarial antes de uso comercial definitivo.
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

function arredondar2(v) {
  return Math.round(v * 100) / 100;
}

// ── Componente: Recência ──────────────────────────────────────────────────────

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
  else if (dias <= t.fraco)     { faixa = 'fraco';     pontuacao = p.fraco; }
  else                          { faixa = 'inativo';   pontuacao = p.inativo; }

  return { pontuacao, faixa, detalhes: { diasSemComprar: dias } };
}

// ── Componente: Frequência ────────────────────────────────────────────────────

function calcularFrequencia(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { pedidos90d: 0, diasEntreCompras: null } };
  }

  const pedidos90d = perfil.pedidos90d || 0;
  const ref = CFG.REF_PEDIDOS_90D;

  // Normaliza em 0-100: linear até a referência, depois capped
  const pontuacao = clamp(Math.round((pedidos90d / ref) * 100), 0, 100);
  const faixa = pedidos90d === 0 ? 'SEM_COMPRAS_90D'
    : pedidos90d >= ref          ? 'ALTA'
    : pedidos90d >= ref / 2      ? 'MEDIA'
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

function calcularFaturamento(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { faturamentoTotal: 0, faturamento90d: 0 } };
  }

  const fatTotal = perfil.faturamentoTotal || 0;
  const fat90d   = perfil.faturamento90d   || 0;

  // Score combinado: 60% total + 40% recente
  const pctTotal = clamp(fatTotal / CFG.REF_FATURAMENTO_TOTAL, 0, 1);
  const pct90d   = clamp(fat90d   / CFG.REF_FATURAMENTO_90D,  0, 1);
  const pontuacao = Math.round((pctTotal * 60 + pct90d * 40) * 100) / 100;

  const faixa = fatTotal === 0        ? 'SEM_FATURAMENTO'
    : fatTotal >= CFG.REF_FATURAMENTO_TOTAL ? 'ALTO'
    : fatTotal >= CFG.REF_FATURAMENTO_TOTAL / 2 ? 'MEDIO'
    : 'BAIXO';

  return {
    pontuacao: clamp(Math.round(pontuacao), 0, 100),
    faixa,
    detalhes: { faturamentoTotal: fatTotal, faturamento90d: fat90d },
  };
}

// ── Componente: Tendência (recebe classificação externa) ──────────────────────

function calcularTendenciaPontuacao(tendencia) {
  const pontuacao = CFG.PONTOS_TENDENCIA[tendencia] ?? CFG.PONTOS_TENDENCIA['SEM_BASE'];
  return { pontuacao, tendencia };
}

// ── Componente: Diversidade de Categorias ─────────────────────────────────────

function calcularDiversidade(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { categorias: 0, produtos: 0 } };
  }

  const numCats  = (perfil.categoriasMaisCompradas || []).length;
  const numProds = perfil.quantidadeProdutosDistintos || 0;

  // Linear: 1 categoria = 25pts, 2 = 50, 3 = 75, 4+ = 100
  const pontuacao = clamp(numCats * 25, 0, 100);
  const faixa = numCats === 0 ? 'ZERO'
    : numCats === 1 ? 'BAIXA'
    : numCats <= 2  ? 'MEDIA'
    : 'ALTA';

  return { pontuacao, faixa, detalhes: { categorias: numCats, produtos: numProds } };
}

// ── Componente: Engajamento (proporção de janelas com compra) ─────────────────

function calcularEngajamento(perfil) {
  if (perfil.nuncaComprou) {
    return { pontuacao: 0, faixa: 'NUNCA_COMPROU', detalhes: { janelasCom: 0 } };
  }

  // Conta quantas das 4 janelas têm pelo menos 1 pedido
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
 * Calcula o Score Comercial para um cliente a partir do seu Perfil360.
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

  // Componentes individuais
  const recencia      = calcularRecencia(perfil);
  const frequencia    = calcularFrequencia(perfil);
  const faturamento   = calcularFaturamento(perfil);
  const tendenciaCmp  = calcularTendenciaPontuacao(tendencia);
  const diversidade   = calcularDiversidade(perfil);
  const engajamento   = calcularEngajamento(perfil);

  const p = CFG.PESOS;

  // Score total ponderado (0-100)
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

  // Motivos em linguagem estruturada (não em linguagem comercial)
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
    statusConfig:   'PROVISIONAL',  // sinaliza que pesos não foram validados empresarialmente
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
