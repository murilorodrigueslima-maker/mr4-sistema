'use strict';

/**
 * Motor de Recorrência / Recompra V1 — DETERMINÍSTICO, SEM LLM.
 *
 * Identifica padrões históricos de recompra por cliente.
 * Calcula quando os dados são suficientes:
 *   - intervalo médio entre compras
 *   - mediana dos intervalos
 *   - posição atual em relação ao padrão histórico
 *
 * Classificações de status:
 *   DENTRO_DO_PADRAO     — tempo atual dentro do intervalo esperado
 *   PROXIMO_DA_JANELA    — próximo do limite superior (fator de alerta)
 *   ATRASADO_VS_HISTORICO — além do intervalo esperado + margem
 *   SEM_BASE             — histórico insuficiente (< 2 datas distintas)
 *   NUNCA_COMPROU        — zero compras históricas
 *
 * IMPORTANTE: NÃO afirmar que cliente "vai comprar".
 * Linguagem estrutural descritiva apenas.
 */

const VERSAO_MOTOR = 'recorrencia-v1';

// ── Configuração ──────────────────────────────────────────────────────────────

// Fator de alerta: se diasSemComprar >= mediaIntervalos * FATOR_ALERTA → PROXIMO_DA_JANELA
// PROVISIONAL
const FATOR_ALERTA = 0.85;

// Fator de atraso: se diasSemComprar >= mediaIntervalos * FATOR_ATRASO → ATRASADO
// PROVISIONAL
const FATOR_ATRASO = 1.10;

// Mínimo de datas distintas com compra para calcular intervalo
const MIN_DATAS_DISTINTAS = 2;

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Calcula o padrão de recorrência de um cliente a partir do Perfil360.
 *
 * @param {Object} perfil — Perfil360 calculado por calcularPerfil360()
 * @returns {Object}      — { status, padrao, posicaoAtual, evidencias, versaoMotor, calculadoEm }
 */
function calcularRecorrencia(perfil) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('calcularRecorrencia: perfil inválido ou ausente');
  }

  const calculadoEm = new Date().toISOString();

  if (perfil.nuncaComprou) {
    return {
      status:      'NUNCA_COMPROU',
      padrao:      null,
      posicaoAtual: null,
      evidencias:  { pedidosTotal: 0 },
      versaoMotor: VERSAO_MOTOR,
      calculadoEm,
    };
  }

  const mediaIntervalos   = perfil.diasEntreComprasMedio;
  const medianaIntervalos = perfil.diasEntreComprasMediana;
  const diasSemComprar    = perfil.diasSemComprar;
  const pedidosTotal      = perfil.pedidosTotal || 0;

  // SEM_BASE: perfil com 1 compra ou sem intervalo calculável
  if (mediaIntervalos === null || mediaIntervalos === undefined) {
    return {
      status:      'SEM_BASE',
      padrao:      null,
      posicaoAtual: { diasSemComprar },
      evidencias: {
        pedidosTotal,
        motivo: `requer >= ${MIN_DATAS_DISTINTAS} datas de compra distintas para calcular intervalo`,
      },
      versaoMotor: VERSAO_MOTOR,
      calculadoEm,
    };
  }

  // Calcular posição atual vs. padrão histórico
  const limiteAlerta = Math.round(mediaIntervalos * FATOR_ALERTA);
  const limiteAtraso = Math.round(mediaIntervalos * FATOR_ATRASO);

  let status;
  if (diasSemComprar >= limiteAtraso)        status = 'ATRASADO_VS_HISTORICO';
  else if (diasSemComprar >= limiteAlerta)   status = 'PROXIMO_DA_JANELA';
  else                                       status = 'DENTRO_DO_PADRAO';

  return {
    status,
    padrao: {
      mediaIntervaloDias:   Math.round(mediaIntervalos),
      medianaIntervaloDias: medianaIntervalos !== null ? Math.round(medianaIntervalos) : null,
      limiteAlertaDias:     limiteAlerta,
      limiteAtrasoDias:     limiteAtraso,
    },
    posicaoAtual: {
      diasSemComprar,
      ultimaCompraEm: perfil.ultimaCompraEm,
    },
    evidencias: {
      pedidosTotal,
      diasEntreComprasMedio:   mediaIntervalos,
      diasEntreComprasMediana: medianaIntervalos,
      fatorAlerta:   FATOR_ALERTA,
      fatorAtraso:   FATOR_ATRASO,
    },
    versaoMotor: VERSAO_MOTOR,
    calculadoEm,
  };
}

module.exports = {
  VERSAO_MOTOR,
  FATOR_ALERTA,
  FATOR_ATRASO,
  MIN_DATAS_DISTINTAS,
  calcularRecorrencia,
};
