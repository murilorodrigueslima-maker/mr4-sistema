'use strict';

/**
 * PRIO360-01 → PRIO360-10
 * Testa o Priorizador de Oportunidades V1.
 *
 * Invariantes:
 *   - Ranqueamento por prioridadeFinal DESC
 *   - Bonus por faturamento histórico alto
 *   - Penalidade por inativo muito longo
 *   - prioridadeFinal entre 1-100
 *   - scoreClienteRef é informativo, não altera rank
 *   - statusConfig = PROVISIONAL
 *   - array vazio → array vazio
 *   - inputs inválidos → erro
 */

const {
  priorizarOportunidades,
  calcularPrioridadeFinal,
  BONUS_FATURAMENTO_ALTO,
  BONUS_FATURAMENTO_MEDIO,
  REF_FATURAMENTO_ALTO,
  REF_FATURAMENTO_MEDIO,
  PENALIDADE_INATIVO_LONGO,
  LIMITE_INATIVO_LONGO,
  VERSAO_MOTOR,
} = require('../lib/priorizadorOportunidades');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkOport(tipo, prioridade, overrides = {}) {
  return {
    id:            `id_${tipo}`,
    tipo,
    prioridade,
    evidencias:    [`evidência para ${tipo}`],
    metricas:      {},
    criadaEm:      new Date().toISOString(),
    status:        'ABERTA',
    versaoMotor:   'oportunidades-v1',
    ...overrides,
  };
}

function mkPerfil(overrides = {}) {
  return {
    clienteMr4Id:    'cli_001',
    faturamentoTotal: 8000,
    diasSemComprar:  45,
    nuncaComprou:    false,
    inativo120d:     false,
    ...overrides,
  };
}

function mkScore(scoreTotal = 70) {
  return { scoreTotal, classificacao: 'BOM' };
}

// ── PRIO360-01: array vazio → array vazio ─────────────────────────────────────

test('PRIO360-01: array vazio de oportunidades retorna array vazio', () => {
  const result = priorizarOportunidades([], mkPerfil(), mkScore());
  expect(result).toEqual([]);
});

// ── PRIO360-02: ranqueamento DESC por prioridadeFinal ─────────────────────────

test('PRIO360-02: oportunidades ranqueadas por prioridadeFinal DESC', () => {
  const oports = [
    mkOport('NUNCA_COMPROU', 30),
    mkOport('REATIVACAO_120D', 70),
    mkOport('QUEDA_DE_COMPRAS', 50),
  ];
  const result = priorizarOportunidades(oports, mkPerfil({ faturamentoTotal: 0 }), null);
  expect(result[0].tipo).toBe('REATIVACAO_120D');
  expect(result[1].tipo).toBe('QUEDA_DE_COMPRAS');
  expect(result[2].tipo).toBe('NUNCA_COMPROU');
});

// ── PRIO360-03: bonus por faturamento alto ────────────────────────────────────

test('PRIO360-03: faturamentoTotal >= REF_ALTO → prioridadeFinal += BONUS_ALTO', () => {
  const oport = mkOport('REATIVACAO_120D', 60);
  const perfilAlto = mkPerfil({ faturamentoTotal: REF_FATURAMENTO_ALTO });
  const pf = calcularPrioridadeFinal(oport, perfilAlto);
  expect(pf).toBe(Math.min(100, 60 + BONUS_FATURAMENTO_ALTO));
});

test('PRIO360-03b: REF_MEDIO <= fat < REF_ALTO → prioridadeFinal += BONUS_MEDIO', () => {
  const oport = mkOport('REATIVACAO_120D', 60);
  const perfilMedio = mkPerfil({ faturamentoTotal: REF_FATURAMENTO_MEDIO });
  const pf = calcularPrioridadeFinal(oport, perfilMedio);
  expect(pf).toBe(Math.min(100, 60 + BONUS_FATURAMENTO_MEDIO));
});

test('PRIO360-03c: fat < REF_MEDIO → sem bonus', () => {
  const oport = mkOport('REATIVACAO_120D', 60);
  const perfilBaixo = mkPerfil({ faturamentoTotal: 1000 });
  const pf = calcularPrioridadeFinal(oport, perfilBaixo);
  expect(pf).toBe(60);
});

// ── PRIO360-04: penalidade por inativo muito longo ────────────────────────────

test('PRIO360-04: diasSemComprar > LIMITE_INATIVO_LONGO → prioridadeFinal -= PENALIDADE', () => {
  const oport = mkOport('REATIVACAO_120D', 60);
  const perfilMuitoInativo = mkPerfil({ diasSemComprar: LIMITE_INATIVO_LONGO + 1, faturamentoTotal: 0 });
  const pf = calcularPrioridadeFinal(oport, perfilMuitoInativo);
  expect(pf).toBe(Math.max(1, 60 - PENALIDADE_INATIVO_LONGO));
});

test('PRIO360-04b: diasSemComprar = LIMITE_INATIVO_LONGO (exato) → sem penalidade', () => {
  const oport = mkOport('REATIVACAO_120D', 60);
  const perfilExato = mkPerfil({ diasSemComprar: LIMITE_INATIVO_LONGO, faturamentoTotal: 0 });
  const pf = calcularPrioridadeFinal(oport, perfilExato);
  expect(pf).toBe(60);
});

// ── PRIO360-05: prioridadeFinal sempre entre 1 e 100 ─────────────────────────

test('PRIO360-05: prioridadeFinal clamped entre 1 e 100', () => {
  const oportMin = mkOport('NUNCA_COMPROU', 1);
  const oportMax = mkOport('REATIVACAO_120D', 95);
  const perfilExtrem = mkPerfil({ faturamentoTotal: REF_FATURAMENTO_ALTO, diasSemComprar: 10 });

  const pfMin = calcularPrioridadeFinal(oportMin, mkPerfil({ faturamentoTotal: 0, diasSemComprar: LIMITE_INATIVO_LONGO + 100 }));
  const pfMax = calcularPrioridadeFinal(oportMax, perfilExtrem);

  expect(pfMin).toBeGreaterThanOrEqual(1);
  expect(pfMax).toBeLessThanOrEqual(100);
});

// ── PRIO360-06: scoreClienteRef é informativo ─────────────────────────────────

test('PRIO360-06: scoreClienteRef preservado mas não altera prioridadeFinal', () => {
  const oport = mkOport('REATIVACAO_120D', 60);
  const perfil = mkPerfil({ faturamentoTotal: 0 });

  const r1 = priorizarOportunidades([oport], perfil, mkScore(20));
  const r2 = priorizarOportunidades([oport], perfil, mkScore(90));

  expect(r1[0].prioridadeFinal).toBe(r2[0].prioridadeFinal);
  expect(r1[0].scoreClienteRef).toBe(20);
  expect(r2[0].scoreClienteRef).toBe(90);
});

// ── PRIO360-07: statusConfig = PROVISIONAL ───────────────────────────────────

test('PRIO360-07: toda oportunidade priorizada tem statusConfig = PROVISIONAL', () => {
  const result = priorizarOportunidades([mkOport('REATIVACAO_120D', 70)], mkPerfil(), mkScore());
  expect(result[0].statusConfig).toBe('PROVISIONAL');
  expect(result[0].versaoMotorPriorizador).toBeTruthy();
});

// ── PRIO360-08: inputs inválidos lançam erro ──────────────────────────────────

test('PRIO360-08: oportunidades não-array lança erro', () => {
  expect(() => priorizarOportunidades(null, mkPerfil())).toThrow('priorizarOportunidades: oportunidades deve ser array');
});

test('PRIO360-08b: perfil inválido lança erro', () => {
  expect(() => priorizarOportunidades([], null)).toThrow('priorizarOportunidades: perfil inválido ou ausente');
});

// ── PRIO360-09: desempate por criadaEm ASC (mais antiga primeiro) ─────────────

test('PRIO360-09: oportunidades com mesma prioridade ranqueadas por criadaEm ASC', () => {
  const t1 = new Date('2026-09-10T10:00:00.000Z').toISOString();
  const t2 = new Date('2026-09-12T10:00:00.000Z').toISOString();
  const oports = [
    mkOport('TIPO_B', 60, { criadaEm: t2 }),
    mkOport('TIPO_A', 60, { criadaEm: t1 }),
  ];
  const result = priorizarOportunidades(oports, mkPerfil({ faturamentoTotal: 0 }), null);
  expect(result[0].tipo).toBe('TIPO_A');  // mais antiga sobe no empate
  expect(result[1].tipo).toBe('TIPO_B');
});

// ── PRIO360-10: VERSAO_MOTOR exportado ───────────────────────────────────────

test('PRIO360-10: VERSAO_MOTOR exportado e não-vazio', () => {
  expect(VERSAO_MOTOR).toBeTruthy();
});
