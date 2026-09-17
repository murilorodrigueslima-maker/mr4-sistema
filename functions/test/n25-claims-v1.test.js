'use strict';

/**
 * CLAIM-V1-01 → CLAIM-V1-09
 * Validação de claims estruturados — N25.
 */

const {
  buildGroundingFacts,
  validarClaims,
  validarOutputComGrounding,
  GroundingViolationError,
} = require('../lib/ai/groundingOutput');

const PERFIL = {
  clienteMr4Id:            'SIM_CLAIM_001',
  nuncaComprou:            false,
  inativo120d:             false,
  diasSemComprar:          60,
  ultimaCompraEm:          '2026-07-18',
  primeiraCompraEm:        '2025-01-10',
  dataReferencia:          '2026-09-17',
  faturamentoTotal:        8000,
  faturamento30d:          500,
  faturamento90d:          2000,
  faturamento180d:         5000,
  pedidosTotal:            4,
  pedidos30d:              0,
  pedidos90d:              2,
  ticketMedio:             2000,
  diasEntreComprasMedio:   45,
  diasEntreComprasMediana: 40,
};

const SCORE  = { scoreTotal: 55, classificacao: 'REGULAR', statusConfig: 'PROVISIONAL' };
const TEND   = { tendencia: 'ESTAVEL' };
const RECORR = { status: 'DENTRO_DO_PADRAO' };

let facts;
beforeAll(() => { facts = buildGroundingFacts(PERFIL, SCORE, TEND, RECORR); });

// ── CLAIM-V1-01: claim válido passa ──────────────────────────────────────────

test('CLAIM-V1-01: claim válido (scoreTotal=55) passa', () => {
  expect(() => validarClaims([{ field: 'scoreTotal', value: 55 }], facts)).not.toThrow();
});

// ── CLAIM-V1-02: dinheiro inventado bloqueia ──────────────────────────────────

test('CLAIM-V1-02: faturamento inventado (R$9.000 vs R$8.000) bloqueia', () => {
  expect(() => validarClaims([{ field: 'faturamentoTotalCents', value: 900_000 }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-03: data inventada bloqueia ─────────────────────────────────────

test('CLAIM-V1-03: data de última compra inventada bloqueia', () => {
  expect(() => validarClaims([{ field: 'ultimaCompraEm', value: '2026-08-01' }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-04: dias inventados bloqueia ────────────────────────────────────

test('CLAIM-V1-04: diasSemComprar inventado (90 vs 60) bloqueia', () => {
  expect(() => validarClaims([{ field: 'diasSemComprar', value: 90 }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-05: score inventado bloqueia ────────────────────────────────────

test('CLAIM-V1-05: scoreTotal inventado (100 vs 55) bloqueia', () => {
  expect(() => validarClaims([{ field: 'scoreTotal', value: 100 }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-06: produto inexistente bloqueia ─────────────────────────────────

test('CLAIM-V1-06: campo desconhecido em claims bloqueia', () => {
  expect(() => validarClaims([{ field: 'produtoInexistente', value: 'xyz' }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-07: categoria inexistente bloqueia ───────────────────────────────

test('CLAIM-V1-07: campo de categoria desconhecido bloqueia', () => {
  expect(() => validarClaims([{ field: 'categoriaFalsa', value: 'eletronicos' }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-08: null preservado ─────────────────────────────────────────────

test('CLAIM-V1-08: claim null para campo null passa', () => {
  // faturamento60d não está no PERFIL → deve ser null nos facts
  expect(() => validarClaims([{ field: 'faturamento60dCents', value: null }], facts)).not.toThrow();
});

test('CLAIM-V1-08b: claim não-null para campo null bloqueia', () => {
  expect(() => validarClaims([{ field: 'faturamento60dCents', value: 100_000 }], facts))
    .toThrow(GroundingViolationError);
});

// ── CLAIM-V1-09: saída factual sem claims bloqueia ────────────────────────────

test('CLAIM-V1-09: validarOutputComGrounding sem claims bloqueia (BLOCK)', () => {
  const outputSemClaims = {
    tipo:             'ANALISE',
    conteudo:         'análise sem claims',
    versaoGuardrails: 'guardrails-v1',
    auditoria:        { fontes: ['score'], observacoes: null, geradoEm: new Date().toISOString() },
    _guardrails:      { violacoes: [] },
    // sem campo claims
  };
  expect(() => validarOutputComGrounding(outputSemClaims, facts))
    .toThrow(GroundingViolationError);
});

test('CLAIM-V1-09b: permitirSemClaims=true (MockProvider) não bloqueia', () => {
  const outputSemClaims = {
    tipo:             'ANALISE',
    conteudo:         'análise mock sem claims',
    versaoGuardrails: 'guardrails-v1',
    auditoria:        { fontes: ['score'], observacoes: null, geradoEm: new Date().toISOString() },
    _guardrails:      { violacoes: [] },
  };
  expect(() => validarOutputComGrounding(outputSemClaims, facts, { permitirSemClaims: true }))
    .not.toThrow();
});
