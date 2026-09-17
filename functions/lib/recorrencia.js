'use strict';

/**
 * Motor de Recorrência / Recompra V1 — DETERMINÍSTICO, SEM LLM.
 *
 * Identifica padrões históricos de recompra por cliente.
 *
 * DECISÃO V1 (APROVADO_PROPRIETARIO_2026-09-17):
 *   Ciclo de recompra calculado usando MEDIANA dos intervalos entre datas distintas.
 *   Motivo: intervalos excepcionalmente longos não devem distorcer o ciclo normal.
 *   Média permanece preservada no perfil e no resultado como métrica informativa.
 *
 * Classificações de status:
 *   DENTRO_DO_PADRAO     — tempo atual dentro do intervalo esperado (mediana)
 *   PROXIMO_DA_JANELA    — próximo do limite superior (fator de alerta)
 *   ATRASADO_VS_HISTORICO — além do intervalo esperado + margem
 *   SEM_BASE             — histórico insuficiente (< 2 datas distintas de compra)
 *   NUNCA_COMPROU        — zero compras históricas
 */

const VERSAO_MOTOR = 'recorrencia-v1';

// ── Configuração ──────────────────────────────────────────────────────────────

// Fator de alerta: diasSemComprar >= medianaIntervalos * FATOR_ALERTA → PROXIMO_DA_JANELA
const FATOR_ALERTA = 0.85;

// Fator de atraso: diasSemComprar >= medianaIntervalos * FATOR_ATRASO → ATRASADO
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
      status:       'NUNCA_COMPROU',
      padrao:       null,
      posicaoAtual: null,
      evidencias:   { pedidosTotal: 0 },
      versaoMotor:  VERSAO_MOTOR,
      calculadoEm,
    };
  }

  const medianaIntervalos = perfil.diasEntreComprasMediana;
  const mediaIntervalos   = perfil.diasEntreComprasMedio;
  const diasSemComprar    = perfil.diasSemComprar;
  const pedidosTotal      = perfil.pedidosTotal || 0;

  // SEM_BASE: mediana nula indica histórico insuficiente (< 2 datas distintas)
  if (medianaIntervalos === null || medianaIntervalos === undefined) {
    return {
      status:       'SEM_BASE',
      padrao:       null,
      posicaoAtual: { diasSemComprar },
      evidencias: {
        pedidosTotal,
        motivo: `requer >= ${MIN_DATAS_DISTINTAS} datas de compra distintas para calcular intervalo`,
      },
      versaoMotor:  VERSAO_MOTOR,
      calculadoEm,
    };
  }

  // Ciclo baseado em MEDIANA (V1)
  const limiteAlerta = Math.round(medianaIntervalos * FATOR_ALERTA);
  const limiteAtraso = Math.round(medianaIntervalos * FATOR_ATRASO);

  let status;
  if (diasSemComprar >= limiteAtraso)       status = 'ATRASADO_VS_HISTORICO';
  else if (diasSemComprar >= limiteAlerta)  status = 'PROXIMO_DA_JANELA';
  else                                      status = 'DENTRO_DO_PADRAO';

  return {
    status,
    padrao: {
      medianaIntervaloDias: Math.round(medianaIntervalos),  // ciclo de referência (V1)
      mediaIntervaloDias:   mediaIntervalos !== null ? Math.round(mediaIntervalos) : null,  // informativo
      limiteAlertaDias:     limiteAlerta,
      limiteAtrasoDias:     limiteAtraso,
    },
    posicaoAtual: {
      diasSemComprar,
      ultimaCompraEm: perfil.ultimaCompraEm,
    },
    evidencias: {
      pedidosTotal,
      diasEntreComprasMediana: medianaIntervalos,
      diasEntreComprasMedio:   mediaIntervalos,
      fatorAlerta:   FATOR_ALERTA,
      fatorAtraso:   FATOR_ATRASO,
    },
    versaoMotor:  VERSAO_MOTOR,
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
