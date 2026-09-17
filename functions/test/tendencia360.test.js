'use strict';

/**
 * TEND360-01 → TEND360-10
 * Testa o motor de Tendência Comercial V1 (tendenciaComercial.js).
 *
 * Invariantes:
 *   - Determinismo: mesma entrada = mesma saída
 *   - NUNCA_COMPROU se nuncaComprou=true
 *   - SEM_BASE se dados insuficientes em todas as janelas
 *   - CRESCENDO / ESTAVEL / CAINDO com base estrutural
 *   - versaoMotor presente
 */

const {
  calcularTendencia,
  variacaoRelativa,
  classificarVariacao,
  TOLERANCIA_ESTAVEL,
  VERSAO_MOTOR,
} = require('../lib/tendenciaComercial');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkPerfil(overrides = {}) {
  return {
    nuncaComprou:  false,
    pedidosTotal:  10,
    // janela 30d
    pedidos30d:    2,
    faturamento30d: 1000,
    // janela 60d (inclui 30d)
    pedidos60d:    4,
    faturamento60d: 2000,
    // janela 90d
    pedidos90d:    5,
    faturamento90d: 2500,
    // janela 180d (inclui 90d)
    pedidos180d:   8,
    faturamento180d: 4000,
    ...overrides,
  };
}

// ── TEND360-01: NUNCA_COMPROU ─────────────────────────────────────────────────

test('TEND360-01: nuncaComprou=true → tendencia NUNCA_COMPROU', () => {
  const r = calcularTendencia({ nuncaComprou: true, pedidosTotal: 0,
    pedidos30d: 0, faturamento30d: 0, pedidos60d: 0, faturamento60d: 0,
    pedidos90d: 0, faturamento90d: 0, pedidos180d: 0, faturamento180d: 0 });
  expect(r.tendencia).toBe('NUNCA_COMPROU');
  expect(r.metodo).toBe('NUNCA_COMPROU');
});

// ── TEND360-02: SEM_BASE — sem pedidos em nenhuma janela ──────────────────────

test('TEND360-02: todos pedidos=0 → SEM_BASE', () => {
  const r = calcularTendencia(mkPerfil({
    pedidos30d: 0, faturamento30d: 0,
    pedidos60d: 0, faturamento60d: 0,
    pedidos90d: 0, faturamento90d: 0,
    pedidos180d: 0, faturamento180d: 0,
  }));
  expect(r.tendencia).toBe('SEM_BASE');
});

// ── TEND360-03: CRESCENDO — faturamento 30d muito maior que anterior ──────────

test('TEND360-03: faturamento 30d >> anterior → CRESCENDO (método 30d)', () => {
  // ant = 60d - 30d = 0 pedidos, fat=0 → usa variação de pedidos
  // pedidos30d=3, pedidos60d-pedidos30d = 1 → variação = (3-1)/1 = 200% > 20%
  const r = calcularTendencia(mkPerfil({
    pedidos30d:    3,
    faturamento30d: 3000,
    pedidos60d:    4,     // ant = 4-3 = 1 pedido
    faturamento60d: 3500, // ant = 3500-3000 = 500 → var = (3000-500)/500 = 500% > 20%
  }));
  expect(r.tendencia).toBe('CRESCENDO');
  expect(r.metodo).toBe('JANELA_30D_VS_30D_ANTERIOR');
});

// ── TEND360-04: CAINDO — faturamento 30d muito menor que anterior ─────────────

test('TEND360-04: faturamento 30d << anterior → CAINDO (método 30d)', () => {
  // 30d: fat=200, ant: fat60d-fat30d = 2000-200 = 1800 → variacao = (200-1800)/1800 = -89% < -20%
  const r = calcularTendencia(mkPerfil({
    pedidos30d:     1,
    faturamento30d:  200,
    pedidos60d:     5,
    faturamento60d: 2000,
  }));
  expect(r.tendencia).toBe('CAINDO');
  expect(r.metodo).toBe('JANELA_30D_VS_30D_ANTERIOR');
});

// ── TEND360-05: ESTAVEL — variação dentro da tolerância ──────────────────────

test('TEND360-05: variação dentro de ±20% → ESTAVEL', () => {
  // fat30d=1000, ant=1100 → var = (1000-1100)/1100 ≈ -9% — dentro de ±20%
  const r = calcularTendencia(mkPerfil({
    pedidos30d:     2,
    faturamento30d:  1000,
    pedidos60d:     4,
    faturamento60d: 2100,   // ant = 2100-1000 = 1100
  }));
  expect(r.tendencia).toBe('ESTAVEL');
  expect(r.metodo).toBe('JANELA_30D_VS_30D_ANTERIOR');
});

// ── TEND360-06: fallback para janela 90d ──────────────────────────────────────

test('TEND360-06: sem dados 30d mas tem dados 90d → usa método 90d', () => {
  // pedidos30d=0, pedidos60d=0, mas pedidos90d=3 e pedidos180d=1
  const r = calcularTendencia(mkPerfil({
    pedidos30d:     0, faturamento30d:   0,
    pedidos60d:     0, faturamento60d:   0,
    pedidos90d:     3, faturamento90d:  3000,
    pedidos180d:    4, faturamento180d: 3500, // ant = 3500-3000 = 500 → CRESCENDO
  }));
  expect(r.metodo).toBe('JANELA_90D_VS_90D_ANTERIOR');
  expect(['CRESCENDO', 'ESTAVEL', 'CAINDO']).toContain(r.tendencia);
});

// ── TEND360-07: determinismo ──────────────────────────────────────────────────

test('TEND360-07: mesma entrada = mesma saída (determinismo)', () => {
  const p = mkPerfil();
  const r1 = calcularTendencia(p);
  const r2 = calcularTendencia(p);
  expect(r1.tendencia).toBe(r2.tendencia);
  expect(r1.metodo).toBe(r2.metodo);
});

// ── TEND360-08: versaoMotor presente ─────────────────────────────────────────

test('TEND360-08: versaoMotor presente e não-vazio', () => {
  const r = calcularTendencia(mkPerfil());
  expect(r.versaoMotor).toBeTruthy();
  expect(VERSAO_MOTOR).toBeTruthy();
});

// ── TEND360-09: perfil inválido lança erro ─────────────────────────────────────

test('TEND360-09: perfil inválido ou null lança erro descritivo', () => {
  expect(() => calcularTendencia(null)).toThrow('calcularTendencia: perfil inválido ou ausente');
  expect(() => calcularTendencia(42)).toThrow();
});

// ── TEND360-10: evidencias presentes em toda classificação ────────────────────

test('TEND360-10: resultado sempre tem campo evidencias com dados rastreáveis', () => {
  const casos = [
    mkPerfil(),
    mkPerfil({ pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 0 }),
    { nuncaComprou: true, pedidos30d: 0, faturamento30d: 0,
      pedidos60d: 0, faturamento60d: 0, pedidos90d: 0, faturamento90d: 0,
      pedidos180d: 0, faturamento180d: 0 },
  ];
  for (const p of casos) {
    const r = calcularTendencia(p);
    expect(r.evidencias).toBeDefined();
    expect(typeof r.evidencias).toBe('object');
  }
});

// ── Testes de helpers ─────────────────────────────────────────────────────────

describe('variacaoRelativa', () => {
  test('base=0, atual=0 → null', () => expect(variacaoRelativa(0, 0)).toBeNull());
  test('base=0, atual=5 → Infinity', () => expect(variacaoRelativa(5, 0)).toBe(Infinity));
  test('base=100, atual=150 → 0.5 (50%)', () => expect(variacaoRelativa(150, 100)).toBe(0.5));
  test('base=100, atual=80 → -0.2 (-20%)', () => expect(variacaoRelativa(80, 100)).toBe(-0.2));
});

describe('classificarVariacao', () => {
  test('null → SEM_BASE', () => expect(classificarVariacao(null, 0.2)).toBe('SEM_BASE'));
  test('Infinity → CRESCENDO', () => expect(classificarVariacao(Infinity, 0.2)).toBe('CRESCENDO'));
  test('0.5 com tol=0.2 → CRESCENDO', () => expect(classificarVariacao(0.5, 0.2)).toBe('CRESCENDO'));
  test('-0.5 com tol=0.2 → CAINDO', () => expect(classificarVariacao(-0.5, 0.2)).toBe('CAINDO'));
  test('0.1 com tol=0.2 → ESTAVEL', () => expect(classificarVariacao(0.1, 0.2)).toBe('ESTAVEL'));
  test('exatamente 0.2 → CRESCENDO (limiar inclusivo)', () => {
    expect(classificarVariacao(0.20, 0.20)).toBe('CRESCENDO');
  });
  test('exatamente -0.2 → CAINDO (limiar inclusivo)', () => {
    expect(classificarVariacao(-0.20, 0.20)).toBe('CAINDO');
  });
});

describe('TOLERANCIA_ESTAVEL', () => {
  test('TOLERANCIA_ESTAVEL é 0.20 (valor provisional)', () => {
    expect(TOLERANCIA_ESTAVEL).toBe(0.20);
  });
});
