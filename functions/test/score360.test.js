'use strict';

/**
 * SCORE360-01 → SCORE360-11
 * Testa o motor de Score Comercial V1 (scoreComercial.js).
 *
 * Invariantes:
 *   - Mesma entrada = mesmo score (determinismo)
 *   - statusConfig sempre 'PROVISIONAL'
 *   - nuncaComprou = scoreTotal 0 ou próximo de 0
 *   - inativo120d = recencia = 0
 *   - score 0-100 em todos os cenários
 *   - versaoMotor presente e não vazio
 */

const {
  calcularScore,
  calcularRecencia,
  calcularFrequencia,
  calcularFaturamento,
  calcularTendenciaPontuacao,
  calcularDiversidade,
  calcularEngajamento,
  classificarScore,
  VERSAO_MOTOR,
} = require('../lib/scoreComercial');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkPerfilBase(overrides = {}) {
  return {
    clienteMr4Id:              'cli_001',
    gestaoClickId:             'gc_001',
    dataReferencia:            '2026-09-16',
    nuncaComprou:              false,
    inativo120d:               false,
    diasSemComprar:            15,
    ultimaCompraEm:            '2026-09-01',
    faturamentoTotal:          15000,
    faturamento90d:            4000,
    faturamento30d:            1500,
    faturamento60d:            2800,
    faturamento180d:           8000,
    pedidosTotal:              20,
    pedidos90d:                5,
    pedidos30d:                2,
    pedidos60d:                4,
    pedidos180d:               10,
    diasEntreComprasMedio:     20,
    diasEntreComprasMediana:   18,
    quantidadeProdutosDistintos: 8,
    categoriasMaisCompradas:   [
      { categoria: 'PNEU', faturamento: 8000 },
      { categoria: 'OLEO', faturamento: 4000 },
      { categoria: 'FREIO', faturamento: 3000 },
    ],
    ...overrides,
  };
}

function mkPerfilNuncaComprou(overrides = {}) {
  return {
    clienteMr4Id:              'cli_new',
    gestaoClickId:             'gc_new',
    dataReferencia:            '2026-09-16',
    nuncaComprou:              true,
    inativo120d:               false,
    diasSemComprar:            null,
    ultimaCompraEm:            null,
    faturamentoTotal:          0,
    faturamento90d:            0,
    faturamento30d:            0,
    faturamento60d:            0,
    faturamento180d:           0,
    pedidosTotal:              0,
    pedidos90d:                0,
    pedidos30d:                0,
    pedidos60d:                0,
    pedidos180d:               0,
    diasEntreComprasMedio:     null,
    diasEntreComprasMediana:   null,
    quantidadeProdutosDistintos: 0,
    categoriasMaisCompradas:   [],
    ...overrides,
  };
}

function mkPerfilInativo(overrides = {}) {
  return mkPerfilBase({
    inativo120d:    true,
    diasSemComprar: 200,
    ultimaCompraEm: '2026-03-01',
    faturamento30d: 0,
    faturamento60d: 0,
    faturamento90d: 0,
    pedidos30d:     0,
    pedidos60d:     0,
    pedidos90d:     0,
    ...overrides,
  });
}

// ── SCORE360-01: determinismo — mesma entrada = mesmo resultado ────────────────

test('SCORE360-01: determinismo — mesma entrada produz mesmo scoreTotal', () => {
  const perfil = mkPerfilBase();
  const r1 = calcularScore(perfil, 'CRESCENDO');
  const r2 = calcularScore(perfil, 'CRESCENDO');
  expect(r1.scoreTotal).toBe(r2.scoreTotal);
  expect(r1.classificacao).toBe(r2.classificacao);
  expect(r1.motivos).toEqual(r2.motivos);
});

// ── SCORE360-02: statusConfig sempre PROVISIONAL ───────────────────────────────

test('SCORE360-02: statusConfig sempre PROVISIONAL em todos os cenários', () => {
  expect(calcularScore(mkPerfilBase(), 'CRESCENDO').statusConfig).toBe('PROVISIONAL');
  expect(calcularScore(mkPerfilNuncaComprou()).statusConfig).toBe('PROVISIONAL');
  expect(calcularScore(mkPerfilInativo(), 'CAINDO').statusConfig).toBe('PROVISIONAL');
});

// ── SCORE360-03: nuncaComprou = scoreTotal muito baixo ─────────────────────────

test('SCORE360-03: nuncaComprou → scoreTotal <= 10 (todos componentes zerados)', () => {
  const r = calcularScore(mkPerfilNuncaComprou());
  expect(r.scoreTotal).toBeLessThanOrEqual(10);
  expect(r.motivos).toContain('NUNCA_COMPROU');
  expect(r.componentes.recencia.pontuacao).toBe(0);
  expect(r.componentes.frequencia.pontuacao).toBe(0);
  expect(r.componentes.faturamento.pontuacao).toBe(0);
  expect(r.componentes.diversidade.pontuacao).toBe(0);
  expect(r.componentes.engajamento.pontuacao).toBe(0);
});

// ── SCORE360-04: inativo120d = recência 0 ─────────────────────────────────────

test('SCORE360-04: cliente inativo (120+ dias) → recencia.pontuacao = 0 e motivo INATIVO_120D', () => {
  const r = calcularScore(mkPerfilInativo(), 'CAINDO');
  expect(r.componentes.recencia.pontuacao).toBe(0);
  expect(r.componentes.recencia.faixa).toBe('inativo');
  expect(r.motivos).toContain('INATIVO_120D');
});

// ── SCORE360-05: cliente ativo/excelente → scoreTotal alto ────────────────────

test('SCORE360-05: cliente muito ativo e com tendência crescente → scoreTotal >= 60', () => {
  const r = calcularScore(mkPerfilBase(), 'CRESCENDO');
  expect(r.scoreTotal).toBeGreaterThanOrEqual(60);
  expect(['EXCELENTE', 'BOM']).toContain(r.classificacao);
});

// ── SCORE360-06: tendência CAINDO reduz score ─────────────────────────────────

test('SCORE360-06: tendência CAINDO reduz score vs CRESCENDO (mesmo cliente)', () => {
  const perfil = mkPerfilBase();
  const crescendo = calcularScore(perfil, 'CRESCENDO').scoreTotal;
  const caindo    = calcularScore(perfil, 'CAINDO').scoreTotal;
  expect(crescendo).toBeGreaterThan(caindo);
});

// ── SCORE360-07: score entre 0 e 100 em todos os cenários ─────────────────────

test('SCORE360-07: scoreTotal sempre entre 0 e 100 (qualquer perfil)', () => {
  const casos = [
    [mkPerfilNuncaComprou(), 'SEM_BASE'],
    [mkPerfilInativo(),      'CAINDO'],
    [mkPerfilBase(),         'CRESCENDO'],
    [mkPerfilBase({ faturamentoTotal: 999999, pedidos90d: 100, diasSemComprar: 1 }), 'CRESCENDO'],
    [mkPerfilBase({ faturamentoTotal: 0,      pedidos90d: 0,   diasSemComprar: 500 }), 'CAINDO'],
  ];
  for (const [p, t] of casos) {
    const r = calcularScore(p, t);
    expect(r.scoreTotal).toBeGreaterThanOrEqual(0);
    expect(r.scoreTotal).toBeLessThanOrEqual(100);
  }
});

// ── SCORE360-08: versaoMotor presente ─────────────────────────────────────────

test('SCORE360-08: versaoMotor e versaoConfig presentes e não-vazios', () => {
  const r = calcularScore(mkPerfilBase(), 'ESTAVEL');
  expect(r.versaoMotor).toBeTruthy();
  expect(r.versaoConfig).toBeTruthy();
  expect(VERSAO_MOTOR).toBeTruthy();
});

// ── SCORE360-09: perfil inválido lança erro ────────────────────────────────────

test('SCORE360-09: perfil inválido ou null lança erro descritivo', () => {
  expect(() => calcularScore(null)).toThrow('calcularScore: perfil inválido ou ausente');
  expect(() => calcularScore('string')).toThrow();
});

// ── SCORE360-10: motivos TENDENCIA_CRESCENTE / TENDENCIA_QUEDA ─────────────────

test('SCORE360-10: motivo TENDENCIA_CRESCENTE quando tendencia=CRESCENDO', () => {
  const r = calcularScore(mkPerfilBase({ diasSemComprar: 10 }), 'CRESCENDO');
  expect(r.motivos).toContain('TENDENCIA_CRESCENTE');
});

test('SCORE360-10b: motivo TENDENCIA_QUEDA quando tendencia=CAINDO', () => {
  const r = calcularScore(mkPerfilBase(), 'CAINDO');
  expect(r.motivos).toContain('TENDENCIA_QUEDA');
});

// ── SCORE360-11: componentes com pesos somam <= 100 ───────────────────────────

test('SCORE360-11: soma dos pesos dos componentes = 100', () => {
  const r = calcularScore(mkPerfilBase(), 'ESTAVEL');
  const somaPesos = Object.values(r.componentes).reduce((s, c) => s + c.peso, 0);
  expect(somaPesos).toBe(100);
});

// ── Testes de componentes individuais ─────────────────────────────────────────

describe('calcularRecencia', () => {
  test('dias=10 → excelente, pontuacao=100', () => {
    const r = calcularRecencia({ diasSemComprar: 10, nuncaComprou: false });
    expect(r.faixa).toBe('excelente');
    expect(r.pontuacao).toBe(100);
  });
  test('dias=45 → bom, pontuacao=75', () => {
    const r = calcularRecencia({ diasSemComprar: 45, nuncaComprou: false });
    expect(r.faixa).toBe('bom');
    expect(r.pontuacao).toBe(75);
  });
  test('dias=150 → inativo, pontuacao=0', () => {
    const r = calcularRecencia({ diasSemComprar: 150, nuncaComprou: false });
    expect(r.faixa).toBe('inativo');
    expect(r.pontuacao).toBe(0);
  });
  test('nuncaComprou → pontuacao=0', () => {
    const r = calcularRecencia({ diasSemComprar: null, nuncaComprou: true });
    expect(r.pontuacao).toBe(0);
    expect(r.faixa).toBe('NUNCA_COMPROU');
  });
});

describe('calcularDiversidade', () => {
  test('3 categorias → ALTA, pontuacao >= 75', () => {
    const r = calcularDiversidade(mkPerfilBase());
    expect(r.faixa).toBe('ALTA');
    expect(r.pontuacao).toBeGreaterThanOrEqual(75);
  });
  test('0 categorias (nuncaComprou) → ZERO, pontuacao=0', () => {
    const r = calcularDiversidade(mkPerfilNuncaComprou());
    expect(r.pontuacao).toBe(0);
  });
});
