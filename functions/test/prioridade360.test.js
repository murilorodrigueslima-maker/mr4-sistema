'use strict';

/**
 * PRIO-01 → PRIO-05
 * Prova root cause B2 (N21): priorizarOportunidades retorna prioridadeFinal,
 * não prioridadeScore (campo inexistente usado no N20 → sempre 0 → faixa 1-20).
 */

const {
  priorizarOportunidades,
  calcularPrioridadeFinal,
  BONUS_FATURAMENTO_ALTO,
  BONUS_FATURAMENTO_MEDIO,
  PENALIDADE_INATIVO_LONGO,
  REF_FATURAMENTO_ALTO,
  REF_FATURAMENTO_MEDIO,
  LIMITE_INATIVO_LONGO,
} = require('../lib/priorizadorOportunidades');

function mkOport(tipo, prioridade) {
  return {
    tipo,
    prioridade,
    clienteMr4Id: 'MR4_TEST',
    gestaoClickId: 'GC_TEST',
    criadaEm: '2026-09-17',
    evidencias: {},
    metricas: {},
    dataReferencia: '2026-09-17',
  };
}

function mkPerfil(faturamentoTotal, diasSemComprar) {
  return { faturamentoTotal, diasSemComprar };
}

// PRIO-01: base 30, sem bônus → prioridadeFinal = 30
test('PRIO-01: base=30, fat=0, dias=0 → prioridadeFinal=30 (não 0)', () => {
  const oport = mkOport('SEM_BASE', 30);
  const perfil = mkPerfil(0, 0);
  const resultado = calcularPrioridadeFinal(oport, perfil);
  expect(resultado).toBe(30);
  expect(resultado).toBeGreaterThan(20);  // prova que não fica em faixa 1-20 sem razão
});

// PRIO-02: base 65, faturamento >= R$5k → 65 + 8 = 73
test('PRIO-02: base=65, fat=7000 (>=R$5k) → prioridadeFinal=73', () => {
  const oport = mkOport('QUEDA_DE_COMPRAS', 65);
  const perfil = mkPerfil(7000, 30);
  const resultado = calcularPrioridadeFinal(oport, perfil);
  expect(resultado).toBe(65 + BONUS_FATURAMENTO_MEDIO);
  expect(resultado).toBe(73);
});

// PRIO-03: base 75 + bônus fat >= R$10k → 75 + 15 = 90
test('PRIO-03: base=75, fat=15000 (>=R$10k) → prioridadeFinal=90', () => {
  const oport = mkOport('ATRASADO_VS_HISTORICO', 75);
  const perfil = mkPerfil(15000, 150);
  const resultado = calcularPrioridadeFinal(oport, perfil);
  expect(resultado).toBe(75 + BONUS_FATURAMENTO_ALTO);
  expect(resultado).toBe(90);
});

// PRIO-04: base 100, sem bônus/penalidade → 100 (nunca deve resultar em 1-20)
test('PRIO-04: base=100, fat=0, dias=0 → prioridadeFinal=100 (não 1-20)', () => {
  const oport = mkOport('REATIVACAO_120D', 100);
  const perfil = mkPerfil(0, 0);
  const resultado = calcularPrioridadeFinal(oport, perfil);
  expect(resultado).toBe(100);
  // prova que sem regra explícita base=100 nunca cai para 1-20
  expect(resultado).toBeGreaterThan(20);
});

// PRIO-05: penalidade > 365 dias → -10 exato
test('PRIO-05: penalidade >365d → exatamente -10 aplicado', () => {
  const oport = mkOport('JANELA_DE_RECOMPRA', 75);
  const perfil = mkPerfil(0, 400);  // > LIMITE_INATIVO_LONGO
  const resultado = calcularPrioridadeFinal(oport, perfil);
  expect(resultado).toBe(75 - PENALIDADE_INATIVO_LONGO);
  expect(resultado).toBe(65);
  expect(LIMITE_INATIVO_LONGO).toBe(365);
});

// ── Prova do bug N20: campo prioridadeFinal existe, prioridadeScore não ────────

test('B2-PROOF: priorizarOportunidades retorna prioridadeFinal, não prioridadeScore', () => {
  const opors = [mkOport('QUEDA_DE_COMPRAS', 65)];
  const perfil = mkPerfil(7000, 30);
  const ranqueadas = priorizarOportunidades(opors, perfil);

  expect(ranqueadas).toHaveLength(1);
  // campo correto existe e não é 1-20
  expect(ranqueadas[0].prioridadeFinal).toBeDefined();
  expect(ranqueadas[0].prioridadeFinal).toBeGreaterThan(20);
  // campo errado (usado no N20) não existe
  expect(ranqueadas[0].prioridadeScore).toBeUndefined();
});

// ── Constantes verificadas ─────────────────────────────────────────────────────

test('constantes do priorizador estão corretas', () => {
  expect(BONUS_FATURAMENTO_ALTO).toBe(15);
  expect(BONUS_FATURAMENTO_MEDIO).toBe(8);
  expect(PENALIDADE_INATIVO_LONGO).toBe(10);
  expect(REF_FATURAMENTO_ALTO).toBe(10000);
  expect(REF_FATURAMENTO_MEDIO).toBe(5000);
  expect(LIMITE_INATIVO_LONGO).toBe(365);
});
