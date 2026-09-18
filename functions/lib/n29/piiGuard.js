'use strict';

/**
 * N29 — PII Guard V2 e allowlist de campos para o provider.
 *
 * Expande o N28 piiGuard de 7 para 22 campos comerciais estruturados.
 * Mesmos PII_PATTERNS. Mesma lógica de auditoria — apenas a allowlist cresce.
 *
 * REGRA ABSOLUTA:
 *   O payload enviado ao provider OpenAI NÃO pode conter PII.
 *   Apenas campos comerciais estruturados são permitidos.
 *
 * Duas camadas:
 *   1. PROMPT_ALLOWLIST_V2: 22 campos que podem aparecer no contextoRaw V2
 *   2. GROUNDING_ALLOWLIST_V2: campos que podem existir nos facts locais V2
 *      (ficam no processo local, nunca viajam ao provider)
 *
 * Faturamento e ticket em R$ (não centavos) — nomes sem sufixo "Cents".
 * ERP text excluído: nomes de produtos/categorias (risco de injection).
 */

// Campos permitidos no contexto que vai ao prompt V2
const PROMPT_ALLOWLIST_V2 = new Set([
  // 7 campos N28 (mantidos)
  'tipoOportunidade',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'prioridade',
  // 15 campos adicionais N29
  'pedidosTotal',
  'pedidos30d',
  'pedidos60d',
  'pedidos90d',
  'pedidos180d',
  'faturamentoTotal',        // R$ (não cents)
  'faturamento30d',          // R$
  'faturamento60d',          // R$
  'faturamento90d',          // R$
  'faturamento180d',         // R$
  'ticketMedioTotal',        // R$ (não cents)
  'diasEntreComprasMedio',
  'diasEntreComprasMediana',
  'quantidadeProdutosDistintos',
  'quantidadeCategoriasDistintas',
]);

// Campos permitidos nos grounding facts V2 (validação local — nunca enviados ao LLM)
const GROUNDING_ALLOWLIST_V2 = new Set([
  // Contexto V2 completo
  'tipoOportunidade',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'prioridade',
  'pedidosTotal',
  'pedidos30d',
  'pedidos60d',
  'pedidos90d',
  'pedidos180d',
  'faturamentoTotal',
  'faturamento30d',
  'faturamento60d',
  'faturamento90d',
  'faturamento180d',
  'ticketMedioTotal',
  'diasEntreComprasMedio',
  'diasEntreComprasMediana',
  'quantidadeProdutosDistintos',
  'quantidadeCategoriasDistintas',
  // Nomes canônicos de grounding (mapeados de tipoOportunidade/prioridade)
  'oportunidadeTipo',
  'oportunidadePrioridade',
  // Metadados internos do grounding (não chegam ao LLM)
  'statusConfig',
  '_versaoGrounding',
  '_buildEm',
  // Campos de identidade internos (nunca no prompt)
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

// Padrões de PII detectáveis por regex (idênticos ao N28)
const PII_PATTERNS = [
  { nome: 'EMAIL',  re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/ },
  { nome: 'PHONE',  re: /\b(\+?55\s?)?\(?\d{2}\)?\s?\d{4,5}[\s\-]?\d{4}\b/ },
  { nome: 'CPF',    re: /\b\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\.\s]?\d{2}\b/ },
  { nome: 'CNPJ',   re: /\b\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\.\s\/]?\d{4}[\-\.\s]?\d{2}\b/ },
  { nome: 'CEP',    re: /\b\d{5}[\-\s]?\d{3}\b/ },
  { nome: 'GC_ID',  re: /\bgc[-_]?\d{5,}\b/i },
  { nome: 'MR4_ID', re: /\bmr4[-_]?\d{5,}\b/i },
];

/**
 * Audita o contexto V2 que será enviado ao prompt do LLM.
 * Verifica que SOMENTE campos da PROMPT_ALLOWLIST_V2 estão presentes.
 *
 * @param {Object} ctx - objeto contextoRaw V2 (22 campos)
 * @returns {{ ok: boolean, camposProibidos: string[], piiEncontrado: string[] }}
 */
function auditarContextoPromptV2(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, camposProibidos: ['(contexto inválido)'], piiEncontrado: [] };
  }

  const camposProibidos = Object.keys(ctx).filter(k => !PROMPT_ALLOWLIST_V2.has(k));

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
 * Verifica se um objeto contém apenas campos da GROUNDING_ALLOWLIST_V2.
 *
 * @param {Object} facts
 * @returns {{ ok: boolean, camposForaAllowlist: string[], piiValues: string[] }}
 */
function auditarGroundingFactsV2(facts) {
  if (!facts || typeof facts !== 'object') {
    return { ok: false, camposForaAllowlist: ['(facts inválido)'], piiValues: [] };
  }

  const camposForaAllowlist = Object.keys(facts).filter(k => !GROUNDING_ALLOWLIST_V2.has(k));

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
  PROMPT_ALLOWLIST_V2,
  GROUNDING_ALLOWLIST_V2,
  PII_PATTERNS,
  auditarContextoPromptV2,
  escaneiarTextoParaPII,
  auditarGroundingFactsV2,
};
