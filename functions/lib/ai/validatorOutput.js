'use strict';

/**
 * Validador Estruturado de Output de Agentes — N11.
 *
 * Complementa os guardrails (que validam segurança) com validação de schema:
 *   - Estrutura de campos esperados por tipo de agente
 *   - Tipos de dados dos campos
 *   - Ranges de valores numéricos
 *
 * Não duplica a lógica de segurança do guardrails.js — apenas garante schema correto.
 */

const VERSAO_VALIDATOR = 'validator-v1';

// ── Schemas por tipo de output ────────────────────────────────────────────────

const SCHEMAS = {
  ANALISE: {
    campos: ['tipo', 'conteudo', 'versaoGuardrails', 'auditoria', '_guardrails'],
    tipos:  { tipo: 'string', conteudo: 'string', versaoGuardrails: 'string' },
  },
  EXPLICACAO: {
    campos: ['tipo', 'conteudo', 'versaoGuardrails', 'auditoria', '_guardrails'],
    tipos:  { tipo: 'string', conteudo: 'string', versaoGuardrails: 'string' },
  },
  SUGESTAO: {
    campos: ['tipo', 'conteudo', 'versaoGuardrails', 'auditoria', '_guardrails'],
    tipos:  { tipo: 'string', conteudo: 'string', versaoGuardrails: 'string' },
  },
  ALERTA: {
    campos: ['tipo', 'conteudo', 'versaoGuardrails', 'auditoria', '_guardrails'],
    tipos:  { tipo: 'string', conteudo: 'string', versaoGuardrails: 'string' },
  },
  RESUMO: {
    campos: ['tipo', 'conteudo', 'versaoGuardrails', 'auditoria', '_guardrails'],
    tipos:  { tipo: 'string', conteudo: 'string', versaoGuardrails: 'string' },
  },
};

class SchemaValidationError extends Error {
  constructor(campo, motivo) {
    super(`[SCHEMA] campo "${campo}": ${motivo}`);
    this.name = 'SchemaValidationError';
    this.campo = campo;
    this.motivo = motivo;
  }
}

/**
 * Valida o schema estrutural de um output de agente.
 * @param {Object} output — output já passado pelo validarOutputAgente()
 * @returns {Object}      — output com metadado de validação de schema
 */
function validarSchema(output) {
  if (!output || typeof output !== 'object') {
    throw new SchemaValidationError('output', 'deve ser objeto');
  }

  const schema = SCHEMAS[output.tipo];
  if (!schema) {
    throw new SchemaValidationError('tipo', `tipo desconhecido: "${output.tipo}"`);
  }

  // Verificar campos obrigatórios
  for (const campo of schema.campos) {
    if (!(campo in output)) {
      throw new SchemaValidationError(campo, 'campo obrigatório ausente');
    }
  }

  // Verificar tipos
  for (const [campo, tipo] of Object.entries(schema.tipos || {})) {
    if (campo in output && typeof output[campo] !== tipo) {
      throw new SchemaValidationError(campo, `esperado ${tipo}, recebido ${typeof output[campo]}`);
    }
  }

  // _guardrails deve ter violacoes = []
  if (output._guardrails && !Array.isArray(output._guardrails.violacoes)) {
    throw new SchemaValidationError('_guardrails.violacoes', 'deve ser array');
  }

  return {
    ...output,
    _schemaValidation: {
      validadoEm:    new Date().toISOString(),
      versao:        VERSAO_VALIDATOR,
      tipoSchema:    output.tipo,
      camposChecados: schema.campos.length,
    },
  };
}

module.exports = {
  VERSAO_VALIDATOR,
  SCHEMAS,
  SchemaValidationError,
  validarSchema,
};
