'use strict';

/**
 * Motor de Oportunidades Comerciais V1 — DETERMINÍSTICO, SEM LLM.
 *
 * Recebe: Perfil360 + Score + Tendência + Recorrência
 * Gera: array de oportunidades estruturadas
 *
 * Tipos de oportunidade:
 *   REATIVACAO_120D          — cliente inativo >= 120 dias
 *   QUEDA_DE_COMPRAS         — tendência CAINDO com histórico real
 *   JANELA_DE_RECOMPRA       — padrão histórico indica que é hora de recomprar
 *   CLIENTE_ATIVO_EM_QUEDA   — cliente ativo mas com tendência descendente
 *   NUNCA_COMPROU            — cliente vinculado sem nenhuma compra
 *   CROSS_SELL_CATEGORIA     — cliente com baixa diversidade de categorias e histórico
 *
 * NUNCA cria oportunidade sem evidência estrutural suficiente.
 * Cada oportunidade tem ID determinístico baseado nos dados.
 */

const { createHash } = require('crypto');

const VERSAO_MOTOR = 'oportunidades-v1';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * ID determinístico: mesmo cliente + mesmo tipo + mesma dataReferencia = mesmo ID.
 * Permite idempotência na geração de oportunidades.
 */
function gerarOportunidadeId(clienteMr4Id, tipo, dataReferencia) {
  const base = `${clienteMr4Id}:${tipo}:${dataReferencia}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function mkOportunidade(params) {
  const { clienteMr4Id, gestaoClickId, tipo, prioridade, evidencias, metricas, dataReferencia } = params;
  return {
    id:             gerarOportunidadeId(clienteMr4Id, tipo, dataReferencia),
    clienteMr4Id,
    gestaoClickId,
    tipo,
    prioridade,      // inteiro 1-100: maior = mais urgente
    evidencias,      // array de strings descritivas
    metricas,        // objeto com números rastreáveis ao input
    dataReferencia,
    versaoMotor:    VERSAO_MOTOR,
    status:         'ABERTA',
    criadaEm:       new Date().toISOString(),
  };
}

// ── Geração de oportunidades ──────────────────────────────────────────────────

function gerarOportNuncaComprou(perfil, score, dataReferencia) {
  if (!perfil.nuncaComprou) return null;
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'NUNCA_COMPROU',
    prioridade:    30,  // baixa: sem histórico, difícil de priorizar
    evidencias:    ['cliente vinculado MR4 sem nenhuma compra Concretizada no histórico'],
    metricas:      { pedidosTotal: 0, scoreTotal: score?.scoreTotal ?? null },
    dataReferencia,
  });
}

function gerarOportReativacao120d(perfil, score, dataReferencia) {
  if (!perfil.inativo120d || perfil.nuncaComprou) return null;
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'REATIVACAO_120D',
    prioridade:    Math.max(50, 100 - Math.floor((perfil.diasSemComprar - 120) / 10)),
    evidencias:    [
      `cliente sem compra há ${perfil.diasSemComprar} dias (>= 120 = inativo)`,
      `última compra em ${perfil.ultimaCompraEm}`,
      `faturamento histórico: R$${perfil.faturamentoTotal.toFixed(2)}`,
    ],
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
  if (perfil.nuncaComprou || perfil.inativo120d) return null;  // outros tipos mais específicos
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'QUEDA_DE_COMPRAS',
    prioridade:    65,
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

function gerarOportJanelaRecompra(perfil, recorrencia, score, dataReferencia) {
  if (!recorrencia) return null;
  const s = recorrencia.status;
  if (s !== 'PROXIMO_DA_JANELA' && s !== 'ATRASADO_VS_HISTORICO') return null;
  if (perfil.nuncaComprou) return null;

  const prioridade = s === 'ATRASADO_VS_HISTORICO' ? 75 : 60;
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'JANELA_DE_RECOMPRA',
    prioridade,
    evidencias:    [
      `status de recorrência: ${s}`,
      `intervalo médio histórico: ${recorrencia.padrao?.mediaIntervaloDias ?? '?'} dias`,
      `dias sem comprar: ${perfil.diasSemComprar}`,
    ],
    metricas: {
      statusRecorrencia:    s,
      diasSemComprar:       perfil.diasSemComprar,
      mediaIntervaloDias:   recorrencia.padrao?.mediaIntervaloDias ?? null,
      medianaIntervaloDias: recorrencia.padrao?.medianaIntervaloDias ?? null,
      limiteAtrasoDias:     recorrencia.padrao?.limiteAtrasoDias ?? null,
      pedidosTotal:         perfil.pedidosTotal,
      scoreTotal:           score?.scoreTotal ?? null,
    },
    dataReferencia,
  });
}

function gerarOportCrossSell(perfil, score, dataReferencia) {
  // Apenas para clientes com histórico real e baixa diversidade de categorias
  if (perfil.nuncaComprou) return null;
  if ((perfil.categoriasMaisCompradas || []).length !== 1) return null;  // só 1 categoria
  if (perfil.pedidosTotal < 3) return null;  // base insuficiente para sugerir cross-sell
  if (perfil.inativo120d) return null;  // inativos têm tipo mais urgente

  const cat = perfil.categoriasMaisCompradas[0]?.categoria || 'SEM_CATEGORIA';
  return mkOportunidade({
    clienteMr4Id:  perfil.clienteMr4Id,
    gestaoClickId: perfil.gestaoClickId,
    tipo:          'CROSS_SELL_CATEGORIA',
    prioridade:    40,
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
 * @returns {Object[]} — array de oportunidades (pode ser vazio)
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

  add(() => gerarOportNuncaComprou(perfil, score, ref));
  add(() => gerarOportReativacao120d(perfil, score, ref));
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
  gerarOportNuncaComprou,
  gerarOportReativacao120d,
  gerarOportQuedaDeCompras,
  gerarOportJanelaRecompra,
  gerarOportCrossSell,
};
