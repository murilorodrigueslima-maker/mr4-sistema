'use strict';

/**
 * N28 — PII Guard e allowlist de campos para o provider.
 *
 * REGRA ABSOLUTA:
 *   O payload enviado ao provider OpenAI NÃO pode conter PII.
 *   Apenas campos comerciais estruturados são permitidos.
 *
 * Duas camadas:
 *   1. PROMPT_ALLOWLIST: campos que podem aparecer no contexto do prompt
 *      (são os campos gerados pelo analistaOportunidade.contextoRaw)
 *   2. GROUNDING_ALLOWLIST: campos que podem existir nos facts locais
 *      (ficam no processo local, nunca viajam ao provider)
 *
 * O provider recebe SOMENTE o prompt construído a partir do contexto sanitizado.
 * Os grounding facts são usados apenas para validação local.
 */

// Campos permitidos no contexto que vai ao prompt (= contextoRaw em analistaOportunidade)
const PROMPT_ALLOWLIST = new Set([
  'tipoOportunidade',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'prioridade',
]);

// Campos permitidos nos grounding facts (validação local — nunca enviados ao LLM)
const GROUNDING_ALLOWLIST = new Set([
  'scoreTotal',
  'classificacao',
  'statusConfig',
  'tendencia',
  'recorrenciaStatus',
  'diasSemComprar',
  'pedidosTotal',
  'pedidos30d',
  'pedidos60d',
  'pedidos90d',
  'pedidos180d',
  'faturamentoTotalCents',
  'faturamento30dCents',
  'faturamento60dCents',
  'faturamento90dCents',
  'faturamento180dCents',
  'ticketMedioCents',
  'diasEntreComprasMedio',
  'diasEntreComprasMediana',
  'inativo120d',
  'nuncaComprou',
  'oportunidadeTipo',
  'oportunidadePrioridade',
  // metadados do grounding (não chegam ao LLM)
  '_versaoGrounding',
  '_buildEm',
  // campos de identidade internos (nunca no prompt)
  'clienteMr4Id',
  'gestaoClickId',
  'nuncaComprou',
  'inativo120d',
  'ultimaCompraEm',
  'primeiraCompraEm',
  'dataReferencia',
  'produtosIds',
  'categoriasIds',
]);

// Padrões de PII detectáveis por regex
const PII_PATTERNS = [
  { nome: 'EMAIL',  re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/ },
  { nome: 'PHONE',  re: /\b(\+?55\s?)?\(?\d{2}\)?\s?\d{4,5}[\s\-]?\d{4}\b/ },
  { nome: 'CPF',    re: /\b\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\.\s]?\d{2}\b/ },
  { nome: 'CNPJ',   re: /\b\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\.\s\/]?\d{4}[\-\.\s]?\d{2}\b/ },
  { nome: 'CEP',    re: /\b\d{5}[\-\s]?\d{3}\b/ },
  // IDs internos (formato específico do projeto)
  { nome: 'GC_ID',  re: /\bgc[-_]?\d{5,}\b/i },
  { nome: 'MR4_ID', re: /\bmr4[-_]?\d{5,}\b/i },
];

/**
 * Audita o contexto que será enviado ao prompt do LLM.
 * Verifica que SOMENTE campos da PROMPT_ALLOWLIST estão presentes.
 *
 * @param {Object} ctx - objeto contextoRaw ou contextoSanitizado
 * @returns {{ ok: boolean, camposProibidos: string[], piiEncontrado: string[] }}
 */
function auditarContextoPrompt(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, camposProibidos: ['(contexto inválido)'], piiEncontrado: [] };
  }

  const camposProibidos = Object.keys(ctx).filter(k => !PROMPT_ALLOWLIST.has(k));

  // Verifica PII nos valores de string
  const piiEncontrado = [];
  for (const [campo, valor] of Object.entries(ctx)) {
    if (typeof valor !== 'string') continue;
    for (const { nome, re } of PII_PATTERNS) {
      if (re.test(valor)) {
        piiEncontrado.push(`${campo}:${nome}`);
      }
    }
  }

  return {
    ok:              camposProibidos.length === 0 && piiEncontrado.length === 0,
    camposProibidos,
    piiEncontrado,
  };
}

/**
 * Varre uma string (ex: o prompt final) em busca de padrões de PII.
 *
 * @param {string} texto
 * @returns {{ ok: boolean, encontrado: string[] }}
 */
function escaneiarTextoParaPII(texto) {
  if (typeof texto !== 'string') return { ok: true, encontrado: [] };
  const encontrado = [];
  for (const { nome, re } of PII_PATTERNS) {
    if (re.test(texto)) encontrado.push(nome);
  }
  return { ok: encontrado.length === 0, encontrado };
}

/**
 * Verifica se um objeto contém apenas campos da GROUNDING_ALLOWLIST.
 * (Para validação dos facts — eles ficam locais, mas não devem ter PII.)
 *
 * @param {Object} facts
 * @returns {{ ok: boolean, camposForaAllowlist: string[], piiValues: string[] }}
 */
function auditarGroundingFacts(facts) {
  if (!facts || typeof facts !== 'object') {
    return { ok: false, camposForaAllowlist: ['(facts inválido)'], piiValues: [] };
  }

  const camposForaAllowlist = Object.keys(facts).filter(k => !GROUNDING_ALLOWLIST.has(k));

  const piiValues = [];
  for (const [campo, valor] of Object.entries(facts)) {
    if (typeof valor !== 'string') continue;
    for (const { nome, re } of PII_PATTERNS) {
      if (re.test(valor)) piiValues.push(`${campo}:${nome}`);
    }
  }

  return {
    ok:                   camposForaAllowlist.length === 0 && piiValues.length === 0,
    camposForaAllowlist,
    piiValues,
  };
}

module.exports = {
  PROMPT_ALLOWLIST,
  GROUNDING_ALLOWLIST,
  PII_PATTERNS,
  auditarContextoPrompt,
  escaneiarTextoParaPII,
  auditarGroundingFacts,
};
