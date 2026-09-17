'use strict';

/**
 * Motor de Oportunidades Comerciais V1 — DETERMINÍSTICO, SEM LLM.
 *
 * APROVADO_PROPRIETARIO_2026-09-17
 *
 * Recebe: Perfil360 + Score + Tendência + Recorrência
 * Gera: array de oportunidades estruturadas
 *
 * Tipos de oportunidade:
 *   PROSPECT_VINCULADO   — cliente vinculado MR4 que nunca comprou → FILA_PROSPECCAO
 *   REATIVACAO_120D      — cliente inativo >= 120 dias → FILA_RECOMPRA
 *   QUEDA_DE_COMPRAS     — tendência CAINDO com histórico real → FILA_RECOMPRA
 *   JANELA_DE_RECOMPRA   — padrão histórico indica que é hora de recomprar → FILA_RECOMPRA
 *   CROSS_SELL_CATEGORIA — DESATIVADO V1 (CROSS_SELL_ENABLED = false)
 *
 * DECISÃO V1:
 *   O1: REATIVACAO_120D absorve JANELA_DE_RECOMPRA.
 *       Se diasSemComprar >= 120, gerar apenas REATIVACAO_120D (não JANELA_DE_RECOMPRA).
 *   PROSPECT_VINCULADO vai para FILA_PROSPECCAO, separada da FILA_RECOMPRA.
 *
 * NUNCA cria oportunidade sem evidência estrutural suficiente.
 */

const { createHash } = require('crypto');
const CFG = require('../config/score-comercial.v1.js');

const VERSAO_MOTOR = 'oportunidades-v1';

// ── Helpers ───────────────────────────────────────────────────────────────────

function gerarOportunidadeId(clienteMr4Id, tipo, dataReferencia) {
  const base = `${clienteMr4Id}:${tipo}:${dataReferencia}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function mkOportunidade(params) {
  const { clienteMr4Id, gestaoClickId, tipo, prioridade, fila, evidencias, metricas, dataReferencia } = params;
  return {
    id:             gerarOportunidadeId(clienteMr4Id, tipo, dataReferencia),
    clienteMr4Id,
    gestaoClickId,
    tipo,
    prioridade,      // inteiro 1-100: maior = mais urgente
    fila:            fila || 'FILA_RECOMPRA',
    evidencias,      // array de strings descritivas
    metricas,        // objeto com números rastreáveis ao input
    dataReferencia,
    versaoMotor:    VERSAO_MOTOR,
    status:         'ABERTA',
    criadaEm:       new Date().toISOString(),
  };
}

// ── Geração de oportunidades ──────────────────────────────────────────────────

// DECISÃO V1: clientes que nunca compraram são PROSPECT_VINCULADO → FILA_PROSPECCAO.
// Não são inativos, não são reativação, não são recompra.
function gerarOportProspectVinculado(perfil, score, dataReferencia) {
  if (!perfil.nuncaComprou) return null;
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'PROSPECT_VINCULADO',
    prioridade:    30,
    fila:          'FILA_PROSPECCAO',
    evidencias:    ['cliente vinculado MR4 sem nenhuma compra no histórico GestãoClick'],
    metricas:      { pedidosTotal: 0, scoreTotal: score?.scoreTotal ?? null },
    dataReferencia,
  });
}

// Mantida para compatibilidade de testes que ainda referenciam NUNCA_COMPROU.
// Internamente delegada para gerarOportProspectVinculado.
function gerarOportNuncaComprou(perfil, score, dataReferencia) {
  return gerarOportProspectVinculado(perfil, score, dataReferencia);
}

function gerarOportReativacao120d(perfil, score, dataReferencia, recorrencia = null) {
  if (!perfil.inativo120d || perfil.nuncaComprou) return null;

  const evidencias = [
    `cliente sem compra há ${perfil.diasSemComprar} dias (>= 120 = inativo)`,
    `última compra em ${perfil.ultimaCompraEm}`,
    `faturamento histórico: R$${perfil.faturamentoTotal.toFixed(2)}`,
  ];

  // O1: se recorrência indica atraso, adicionar como evidência na própria REATIVACAO
  if (recorrencia && (recorrencia.status === 'ATRASADO_VS_HISTORICO' || recorrencia.status === 'PROXIMO_DA_JANELA')) {
    const ciclo = recorrencia.padrao?.medianaIntervaloDias ?? recorrencia.padrao?.mediaIntervaloDias;
    evidencias.push(`ciclo histórico de recompra (mediana): ${ciclo ?? '?'} dias — também atrasado vs. histórico`);
  }

  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'REATIVACAO_120D',
    prioridade:    Math.max(50, 100 - Math.floor((perfil.diasSemComprar - 120) / 10)),
    fila:          'FILA_RECOMPRA',
    evidencias,
    metricas: {
      diasSemComprar:   perfil.diasSemComprar,
      ultimaCompraEm:   perfil.ultimaCompraEm,
      faturamentoTotal: perfil.faturamentoTotal,
      pedidosTotal:     perfil.pedidosTotal,
      scoreTotal:       score?.scoreTotal ?? null,
    },
    dataReferencia,
  });
}

function gerarOportQuedaDeCompras(perfil, tendencia, score, dataReferencia) {
  if (!tendencia || tendencia.tendencia !== 'CAINDO') return null;
  if (perfil.nuncaComprou || perfil.inativo120d) return null;
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'QUEDA_DE_COMPRAS',
    prioridade:    65,
    fila:          'FILA_RECOMPRA',
    evidencias:    [
      `tendência detectada: CAINDO (método: ${tendencia.metodo})`,
      `faturamento 30d: R$${(perfil.faturamento30d || 0).toFixed(2)}`,
      `faturamento anterior (30d-60d): R$${((perfil.faturamento60d || 0) - (perfil.faturamento30d || 0)).toFixed(2)}`,
    ],
    metricas: {
      tendencia:       tendencia.tendencia,
      metodo:          tendencia.metodo,
      faturamento30d:  perfil.faturamento30d,
      faturamento60d:  perfil.faturamento60d,
      pedidos30d:      perfil.pedidos30d,
      pedidos60d:      perfil.pedidos60d,
      scoreTotal:      score?.scoreTotal ?? null,
    },
    dataReferencia,
  });
}

// DECISÃO V1 (O1): REATIVACAO_120D absorve JANELA_DE_RECOMPRA.
// Se inativo120d, não gerar JANELA (a REATIVACAO já cobre e inclui o sinal de atraso).
function gerarOportJanelaRecompra(perfil, recorrencia, score, dataReferencia) {
  if (!recorrencia) return null;
  // O1: cliente inativo → apenas REATIVACAO_120D, não JANELA_DE_RECOMPRA
  if (perfil.inativo120d) return null;
  if (perfil.nuncaComprou) return null;
  const s = recorrencia.status;
  if (s !== 'PROXIMO_DA_JANELA' && s !== 'ATRASADO_VS_HISTORICO') return null;

  const prioridade = s === 'ATRASADO_VS_HISTORICO' ? 75 : 60;
  const cicloRef = recorrencia.padrao?.medianaIntervaloDias ?? recorrencia.padrao?.mediaIntervaloDias;
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'JANELA_DE_RECOMPRA',
    prioridade,
    fila:          'FILA_RECOMPRA',
    evidencias:    [
      `status de recorrência: ${s}`,
      `ciclo de recompra (mediana): ${cicloRef ?? '?'} dias`,
      `dias sem comprar: ${perfil.diasSemComprar}`,
    ],
    metricas: {
      statusRecorrencia:     s,
      diasSemComprar:        perfil.diasSemComprar,
      medianaIntervaloDias:  recorrencia.padrao?.medianaIntervaloDias ?? null,
      mediaIntervaloDias:    recorrencia.padrao?.mediaIntervaloDias ?? null,
      limiteAtrasoDias:      recorrencia.padrao?.limiteAtrasoDias ?? null,
      pedidosTotal:          perfil.pedidosTotal,
      scoreTotal:            score?.scoreTotal ?? null,
    },
    dataReferencia,
  });
}

// DECISÃO V1: CROSS_SELL_ENABLED = false → nenhuma oportunidade oficial gerada.
// Motor preservado, mas retorna null quando desativado.
function gerarOportCrossSell(perfil, score, dataReferencia) {
  if (!CFG.CROSS_SELL_ENABLED) return null;

  if (perfil.nuncaComprou) return null;
  if ((perfil.categoriasMaisCompradas || []).length !== 1) return null;
  if (perfil.pedidosTotal < 3) return null;
  if (perfil.inativo120d) return null;

  const cat = perfil.categoriasMaisCompradas[0]?.categoria || 'SEM_CATEGORIA';
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'CROSS_SELL_CATEGORIA',
    prioridade:    40,
    fila:          'FILA_RECOMPRA',
    evidencias:    [
      `cliente concentrado em 1 categoria: ${cat}`,
      `${perfil.pedidosTotal} pedidos históricos — base suficiente para explorar categorias complementares`,
    ],
    metricas: {
      categorias:       (perfil.categoriasMaisCompradas || []).length,
      categoriaAtual:   cat,
      pedidosTotal:     perfil.pedidosTotal,
      faturamentoTotal: perfil.faturamentoTotal,
      scoreTotal:       score?.scoreTotal ?? null,
    },
    dataReferencia,
  });
}

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Gera oportunidades estruturadas para um cliente.
 *
 * @param {Object} perfil      — Perfil360
 * @param {Object} score       — resultado de calcularScore()
 * @param {Object} tendencia   — resultado de calcularTendencia()
 * @param {Object} recorrencia — resultado de calcularRecorrencia()
 * @param {string} dataReferencia — YYYY-MM-DD
 * @returns {Object[]} — array de oportunidades
 */
function gerarOportunidades(perfil, score, tendencia, recorrencia, dataReferencia) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('gerarOportunidades: perfil inválido ou ausente');
  }

  const ref = dataReferencia || perfil.dataReferencia;
  const oportunidades = [];

  const add = (fn) => {
    const o = fn();
    if (o) oportunidades.push(o);
  };

  add(() => gerarOportProspectVinculado(perfil, score, ref));
  add(() => gerarOportReativacao120d(perfil, score, ref, recorrencia));
  add(() => gerarOportQuedaDeCompras(perfil, tendencia, score, ref));
  add(() => gerarOportJanelaRecompra(perfil, recorrencia, score, ref));
  add(() => gerarOportCrossSell(perfil, score, ref));

  return oportunidades;
}

module.exports = {
  VERSAO_MOTOR,
  gerarOportunidades,
  gerarOportunidadeId,
  // Funções expostas para testes
  gerarOportNuncaComprou,       // compatibilidade: delega para gerarOportProspectVinculado
  gerarOportProspectVinculado,
  gerarOportReativacao120d,
  gerarOportQuedaDeCompras,
  gerarOportJanelaRecompra,
  gerarOportCrossSell,
};
