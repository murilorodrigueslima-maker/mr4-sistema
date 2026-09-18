'use strict';

/**
 * N29.3 — Testes de contrato null + configuração de tokens
 *
 * Confirma:
 *   1. Schema V2 suporta null em oportunidadeTipo / oportunidadePrioridade
 *   2. "N/A" nunca equivale a null (grounding bloca)
 *   3. null nunca vira 0 nem string vazia
 *   4. max_output_tokens V2 = 1000
 *   5. V1 (INSTRUCTIONS + ANALISE_OUTPUT_SCHEMA) intactos
 *
 * OPENAI_CALLS = 0. PROD_WRITES = 0.
 */

const {
  buildGroundingFactsV2,
  validarClaimsV2,
  GroundingV2ViolationError,
} = require('../lib/n29/groundingOutput');

const {
  INSTRUCTIONS_V2,
  ANALISE_OUTPUT_SCHEMA_V2,
  MAX_OUTPUT_TOKENS_V2,
  INSTRUCTIONS,
  ANALISE_OUTPUT_SCHEMA,
} = require('../lib/ai/providers/openaiProvider');

const { buildV2 } = require('../lib/ai/prompts/analistaOportunidadeV2');

// ── Fixture: contexto com oportunidadeTipo=null e prioridade=null ─────────────
const CTX_NULL = Object.freeze({
  tipoOportunidade:              null,
  scoreTotal:                    94,
  classificacao:                 'EXCELENTE',
  diasSemComprar:                20,
  tendencia:                     'CRESCENDO',
  recorrenciaStatus:             'DENTRO_DO_PADRAO',
  prioridade:                    null,
  pedidosTotal:                  7,
  pedidos30d:                    1,
  pedidos60d:                    2,
  pedidos90d:                    4,
  pedidos180d:                   6,
  faturamentoTotal:              1530.03,
  faturamento30d:                218.58,
  faturamento60d:                437.16,
  faturamento90d:                874.32,
  faturamento180d:               1311.45,
  ticketMedioTotal:              218.58,
  diasEntreComprasMedio:         105.83,
  diasEntreComprasMediana:       29,
  quantidadeProdutosDistintos:   33,
  quantidadeCategoriasDistintas: 10,
});

// ── NULL-SCHEMA-01: oportunidadeTipo=null → claim null → PASS ─────────────────
test('NULL-SCHEMA-01: oportunidadeTipo=null — claim null PASS', () => {
  const facts = buildGroundingFactsV2(CTX_NULL);
  expect(facts.oportunidadeTipo).toBeNull();
  expect(() => validarClaimsV2(
    [{ field: 'oportunidadeTipo', value: null }],
    facts,
  )).not.toThrow();
});

// ── NULL-SCHEMA-02: oportunidadePrioridade=null → claim null → PASS ──────────
test('NULL-SCHEMA-02: oportunidadePrioridade=null — claim null PASS', () => {
  const facts = buildGroundingFactsV2(CTX_NULL);
  expect(facts.oportunidadePrioridade).toBeNull();
  expect(() => validarClaimsV2(
    [{ field: 'oportunidadePrioridade', value: null }],
    facts,
  )).not.toThrow();
});

// ── NULL-SCHEMA-03: oportunidadeTipo="N/A" quando fato=null → BLOCK ──────────
test('NULL-SCHEMA-03: oportunidadeTipo="N/A" com fato null → GROUNDING_BLOCK', () => {
  const facts = buildGroundingFactsV2(CTX_NULL);
  expect(() => validarClaimsV2(
    [{ field: 'oportunidadeTipo', value: 'N/A' }],
    facts,
  )).toThrow(GroundingV2ViolationError);
});

// ── NULL-SCHEMA-04: oportunidadePrioridade="N/A" → BLOCK ──────────────────────
test('NULL-SCHEMA-04: oportunidadePrioridade="N/A" com fato null → GROUNDING_BLOCK', () => {
  const facts = buildGroundingFactsV2(CTX_NULL);
  expect(() => validarClaimsV2(
    [{ field: 'oportunidadePrioridade', value: 'N/A' }],
    facts,
  )).toThrow(GroundingV2ViolationError);
});

// ── NULL-SCHEMA-05: null não vira 0 ───────────────────────────────────────────
test('NULL-SCHEMA-05: oportunidadeTipo=null — claim 0 → GROUNDING_BLOCK', () => {
  const facts = buildGroundingFactsV2(CTX_NULL);
  expect(() => validarClaimsV2(
    [{ field: 'oportunidadeTipo', value: 0 }],
    facts,
  )).toThrow(GroundingV2ViolationError);
});

// ── NULL-SCHEMA-06: null não vira string vazia ────────────────────────────────
test('NULL-SCHEMA-06: oportunidadeTipo=null — claim "" → GROUNDING_BLOCK', () => {
  const facts = buildGroundingFactsV2(CTX_NULL);
  expect(() => validarClaimsV2(
    [{ field: 'oportunidadeTipo', value: '' }],
    facts,
  )).toThrow(GroundingV2ViolationError);
});

// ── TOKEN-01: MAX_OUTPUT_TOKENS_V2 = 1000 ─────────────────────────────────────
test('TOKEN-01: MAX_OUTPUT_TOKENS_V2 exportado de openaiProvider = 1000', () => {
  expect(MAX_OUTPUT_TOKENS_V2).toBe(1000);
});

// ── TOKEN-02: V1 (INSTRUCTIONS + ANALISE_OUTPUT_SCHEMA) inalterados ──────────
test('TOKEN-02: exports V1 intactos em openaiProvider', () => {
  // INSTRUCTIONS V1 existe e é string
  expect(typeof INSTRUCTIONS).toBe('string');
  expect(INSTRUCTIONS.length).toBeGreaterThan(0);

  // V1 schema existe e tem campos obrigatórios
  expect(ANALISE_OUTPUT_SCHEMA).toBeDefined();
  expect(ANALISE_OUTPUT_SCHEMA.type).toBe('object');
  expect(ANALISE_OUTPUT_SCHEMA.properties).toBeDefined();

  // V2 instrução não é a mesma que V1
  expect(INSTRUCTIONS_V2).not.toBe(INSTRUCTIONS);

  // V2 schema não é o mesmo que V1
  expect(ANALISE_OUTPUT_SCHEMA_V2).not.toBe(ANALISE_OUTPUT_SCHEMA);
});

// ── Verificação extra: buildV2 renderiza null como 'null' (não 'N/A') ─────────
test('NULL-PROMPT: buildV2 com oportunidadeTipo=null renderiza "null" no prompt', () => {
  const prompt = buildV2(CTX_NULL);
  expect(prompt).toContain('TIPO DE OPORTUNIDADE: null');
  expect(prompt).toContain('PRIORIDADE: null');
  expect(prompt).not.toContain('TIPO DE OPORTUNIDADE: N/A');
  expect(prompt).not.toContain('PRIORIDADE: N/A');
});

// ── Verificação extra: INSTRUCTIONS_V2 menciona regra de null ─────────────────
test('NULL-INSTR: INSTRUCTIONS_V2 contém regra de serialização null', () => {
  expect(INSTRUCTIONS_V2).toContain('null');
  expect(INSTRUCTIONS_V2).toContain('N/A');
  // Regra existente de exclusão de campo null
  expect(INSTRUCTIONS_V2).toContain('NÃO inclua esse campo em claims');
});
