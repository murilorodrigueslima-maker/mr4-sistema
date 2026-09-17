'use strict';

/**
 * Motor de Tendência Comercial V1 — DETERMINÍSTICO, SEM LLM.
 *
 * Classifica a trajetória de compras de um cliente comparando períodos
 * equivalentes. Evita conclusões com amostra insuficiente.
 *
 * Classificações:
 *   CRESCENDO      — compras aumentaram no período recente vs. anterior
 *   ESTAVEL        — variação dentro de tolerância (±20%)
 *   CAINDO         — compras diminuíram no período recente vs. anterior
 *   SEM_BASE       — dados insuficientes para comparação confiável
 *   NUNCA_COMPROU  — zero compras históricas
 *
 * Mesma entrada + mesma config = mesma saída (sem I/O, sem randomização).
 */

const VERSAO_MOTOR = 'tendencia-v1';

// ── Configuração ──────────────────────────────────────────────────────────────

// Variação mínima para considerar CRESCENDO ou CAINDO (20%)
// PROVISIONAL — pendente calibração empresarial
const TOLERANCIA_ESTAVEL = 0.20;

// DECISÃO V1 (APROVADO_PROPRIETARIO_2026-09-17):
// Mínimo de 2 pedidos na base comparável para classificar tendência.
// Com somente 1 pedido em qualquer janela → SEM_BASE (evidência insuficiente).
const MINIMO_PEDIDOS_PARA_BASE = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calcula a variação relativa entre dois valores.
 * Retorna null se `base` for zero (evita divisão por zero).
 */
function variacaoRelativa(atual, base) {
  if (base === 0) return atual > 0 ? Infinity : null;
  return (atual - base) / base;
}

/**
 * Classifica a tendência a partir de uma variação relativa.
 */
function classificarVariacao(variacao, tolerancia) {
  if (variacao === null)     return 'SEM_BASE';
  if (variacao === Infinity) return 'CRESCENDO';  // de 0 para positivo
  if (variacao >= tolerancia)  return 'CRESCENDO';
  if (variacao <= -tolerancia) return 'CAINDO';
  return 'ESTAVEL';
}

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Calcula a tendência comercial de um cliente a partir do seu Perfil360.
 *
 * Estratégia de comparação (ordem de preferência):
 *   1. 30d vs 30d anterior (60d - 30d)  — melhor resolução
 *   2. 90d vs 90d anterior (180d - 90d) — fallback com mais dados
 *   3. SEM_BASE — dados insuficientes
 *
 * Para janela 30d vs anterior:
 *   - período recente: pedidos30d / faturamento30d
 *   - período anterior: (pedidos60d - pedidos30d) / (faturamento60d - faturamento30d)
 *
 * @param {Object} perfil — Perfil360 calculado por calcularPerfil360()
 * @returns {Object}      — { tendencia, versaoMotor, metodo, evidencias, calculadoEm }
 */
function calcularTendencia(perfil) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('calcularTendencia: perfil inválido ou ausente');
  }

  const calculadoEm = new Date().toISOString();

  if (perfil.nuncaComprou) {
    return {
      tendencia:  'NUNCA_COMPROU',
      versaoMotor: VERSAO_MOTOR,
      metodo:     'NUNCA_COMPROU',
      evidencias: { pedidosTotal: 0 },
      calculadoEm,
    };
  }

  // ── Método 1: 30d vs período anterior (30d-60d) ────────────────────────────
  const ped30        = perfil.pedidos30d   || 0;
  const fat30        = perfil.faturamento30d  || 0;
  const ped30ant     = (perfil.pedidos60d   || 0) - ped30;
  const fat30ant     = (perfil.faturamento60d  || 0) - fat30;

  const temBase30 = ped30 >= MINIMO_PEDIDOS_PARA_BASE
    || ped30ant >= MINIMO_PEDIDOS_PARA_BASE;

  if (temBase30) {
    // Comparação por faturamento (mais robusto que pedidos para valores variados)
    const varFat30 = variacaoRelativa(fat30, fat30ant);
    // Fallback para pedidos se faturamento tiver base zero
    const varPed30 = variacaoRelativa(ped30, ped30ant);
    const variacao = fat30ant > 0 ? varFat30 : varPed30;

    const tendencia = classificarVariacao(variacao, TOLERANCIA_ESTAVEL);

    return {
      tendencia,
      versaoMotor: VERSAO_MOTOR,
      metodo:      'JANELA_30D_VS_30D_ANTERIOR',
      evidencias: {
        ped30, ped30ant, fat30, fat30ant,
        variacaoFaturamento: varFat30 !== null ? Math.round(varFat30 * 10000) / 100 : null,
        variacaoPedidos:     varPed30 !== null ? Math.round(varPed30 * 10000) / 100 : null,
      },
      toleranciaUsada: TOLERANCIA_ESTAVEL,
      calculadoEm,
    };
  }

  // ── Método 2: 90d vs período anterior (90d-180d) ───────────────────────────
  const ped90    = perfil.pedidos90d   || 0;
  const fat90    = perfil.faturamento90d  || 0;
  const ped90ant = (perfil.pedidos180d  || 0) - ped90;
  const fat90ant = (perfil.faturamento180d || 0) - fat90;

  const temBase90 = ped90 >= MINIMO_PEDIDOS_PARA_BASE
    || ped90ant >= MINIMO_PEDIDOS_PARA_BASE;

  if (temBase90) {
    const varFat90 = variacaoRelativa(fat90, fat90ant);
    const varPed90 = variacaoRelativa(ped90, ped90ant);
    const variacao = fat90ant > 0 ? varFat90 : varPed90;

    const tendencia = classificarVariacao(variacao, TOLERANCIA_ESTAVEL);

    return {
      tendencia,
      versaoMotor: VERSAO_MOTOR,
      metodo:      'JANELA_90D_VS_90D_ANTERIOR',
      evidencias: {
        ped90, ped90ant, fat90, fat90ant,
        variacaoFaturamento: varFat90 !== null ? Math.round(varFat90 * 10000) / 100 : null,
        variacaoPedidos:     varPed90 !== null ? Math.round(varPed90 * 10000) / 100 : null,
      },
      toleranciaUsada: TOLERANCIA_ESTAVEL,
      calculadoEm,
    };
  }

  // ── Sem base suficiente ────────────────────────────────────────────────────
  return {
    tendencia:  'SEM_BASE',
    versaoMotor: VERSAO_MOTOR,
    metodo:     'SEM_BASE',
    evidencias: {
      ped30, ped30ant, ped90, ped90ant,
      pedidosTotal: perfil.pedidosTotal || 0,
      motivo: `menos de ${MINIMO_PEDIDOS_PARA_BASE} pedidos em qualquer janela de comparação`,
    },
    calculadoEm,
  };
}

module.exports = {
  VERSAO_MOTOR,
  TOLERANCIA_ESTAVEL,
  calcularTendencia,
  // Helpers expostos para testes
  variacaoRelativa,
  classificarVariacao,
};
