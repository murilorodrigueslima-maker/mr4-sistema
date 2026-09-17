'use strict';

/**
 * Agente: Auditor de IA.
 *
 * Responsabilidade: verificar a qualidade e conformidade de outputs de outros agentes.
 * É o único agente que LIDA COM outputs de outros agentes — inspeciona sem modificar.
 *
 * Garante:
 *   - Outputs contêm campos de auditoria
 *   - Mock mode está sinalizado quando ativo
 *   - Violações de guardrails foram capturadas
 *   - Rastreabilidade: pode reconstruir de onde veio cada análise
 */

const NOME_AGENTE = 'auditorIA';
const VERSAO_AGENTE = '1.0.0';

/**
 * Audita um conjunto de outputs de agentes.
 * @param {Object[]} outputs — array de outputs validados por validarOutputAgente()
 * @returns {Object}         — relatório de auditoria
 */
function auditarOutputs(outputs) {
  if (!Array.isArray(outputs)) {
    throw new Error('auditorIA.auditarOutputs: outputs deve ser array');
  }

  const resultados = outputs.map((output, idx) => {
    const guardrails = output._guardrails || {};
    const meta       = output._meta       || {};

    return {
      indice:          idx,
      agente:          guardrails.agente || meta.agente || 'desconhecido',
      tipo:            output.tipo || 'DESCONHECIDO',
      mockMode:        meta.mockMode === true,
      versaoGuardrails: guardrails.versao || null,
      validadoEm:      guardrails.validadoEm || null,
      violacoes:       guardrails.violacoes || [],
      temFontes:       Array.isArray(output.auditoria?.fontes) && output.auditoria.fontes.length > 0,
      conforme:        (guardrails.violacoes || []).length === 0,
    };
  });

  const totalConformes   = resultados.filter(r => r.conforme).length;
  const totalEmMock      = resultados.filter(r => r.mockMode).length;
  const totalComViolacao = resultados.filter(r => !r.conforme).length;

  return {
    agente:         NOME_AGENTE,
    versaoAgente:   VERSAO_AGENTE,
    auditadoEm:     new Date().toISOString(),
    totalOutputs:   resultados.length,
    totalConformes,
    totalEmMock,
    totalComViolacao,
    conformeGeral:  totalComViolacao === 0,
    resultados,
  };
}

module.exports = { NOME_AGENTE, VERSAO_AGENTE, auditarOutputs };
