'use strict';

/**
 * N33.2 — Testes dos Sinais Comerciais Determinísticos V1
 *
 * OPENAI_CALLS=0 | PROD_WRITES=0 | DEPLOYS=0 | AI_MODE=SHADOW
 *
 * Seções:
 *   A  (SC-A01..A05) ATRASO_SEM_BASE — entradas inválidas
 *   B  (SC-B01..B05) ATRASO_ANTES_DO_CICLO — cliente dentro do prazo
 *   C  (SC-C01..C03) ATRASO_NO_CICLO — cliente exatamente no prazo
 *   D  (SC-D01..D07) ATRASO_ATRASADO — cliente além do prazo
 *   E  (SC-E01..E04) ATRASO_ROUNDING — política de arredondamento
 *   F  (SC-F01..F03) ATRASO_INVARIANTS — determinismo e imutabilidade
 *   G  (SC-G01..G03) VOLUME_SEM_MOVIMENTO — ambas janelas zeradas
 *   H  (SC-H01..H03) VOLUME_BASE_ZERO_CRESCIMENTO — crescimento a partir de zero
 *   I  (SC-I01..I04) VOLUME_QUEDA_TOTAL — queda para zero
 *   J  (SC-J01..J03) VOLUME_CRESCIMENTO — variação ≥ +20%
 *   K  (SC-K01..K03) VOLUME_QUEDA — variação ≤ -20%
 *   L  (SC-L01..L02) VOLUME_ESTAVEL — variação dentro de ±20%
 *   M  (SC-M01..M03) VOLUME_INDEPENDENT — pedidos ≠ faturamento
 *   N  (SC-N01..N02) VOLUME_J30D_J90D — janelas j30d e j90d separadas
 *   O  (SC-O01..O02) VOLUME_ROUNDING — arredondamento de variação
 *   P  (SC-P01..P02) VOLUME_INVALID — entradas inválidas
 *   Q  (SC-Q01..Q02) VOLUME_IMMUTABILITY — outputs congelados
 *   R  (SC-R01..R03) SANITIZED_CASES — casos N33 (003, 006, 009)
 *   S  (SC-S01..S03) ACTION_DECISION_UNCHANGED — sinais não alteram decisão
 *
 * Total esperado: 62 testes
 */

const {
  VERSAO_SINAIS,
  TOLERANCIA_ESTAVEL_VOLUME,
  STATUS_ATRASO,
  STATUS_VOLUME,
  calcularAtrasoCiclo,
  calcularVariacaoVolume,
  _statusVolume,
  _variacaoPct,
} = require('../lib/sinaisComerciais');

const {
  calcularDecisaoAcaoComercial,
} = require('../lib/decisaoAcaoComercial');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkPerfil(overrides = {}) {
  return {
    pedidos30d:    0,
    pedidos60d:    0,
    pedidos90d:    0,
    pedidos180d:   0,
    faturamento30d:  0,
    faturamento60d:  0,
    faturamento90d:  0,
    faturamento180d: 0,
    ...overrides,
  };
}

// Fixture sanitizada para decisão (não altera resultado)
function mkCtxDecisao(overrides = {}) {
  return {
    scoreTotal: 63, classificacao: 'BOM', diasSemComprar: 31,
    tendencia: 'CAINDO', recorrenciaStatus: 'ATRASADO_VS_HISTORICO',
    pedidosTotal: 9, pedidos30d: 0, pedidos60d: 2, pedidos90d: 2, pedidos180d: 6,
    faturamentoTotal: 1237.41, faturamento30d: 0, faturamento60d: 92.87,
    faturamento90d: 92.87, faturamento180d: 776.39, ticketMedioTotal: 137.49,
    diasEntreComprasMedio: 30.43, diasEntreComprasMediana: 22,
    quantidadeProdutosDistintos: 10, quantidadeCategoriasDistintas: 5,
    tipoOportunidade: 'QUEDA_DE_COMPRAS', prioridade: 65,
    nuncaComprou: false,
    ...overrides,
  };
}

// ── SEÇÃO A — ATRASO_SEM_BASE ─────────────────────────────────────────────────

test('SC-A01: diasSemComprar=null → SEM_BASE', () => {
  const r = calcularAtrasoCiclo(null, 30);
  expect(r.status).toBe(STATUS_ATRASO.SEM_BASE);
  expect(r.diasAlemDoCiclo).toBeNull();
  expect(r.razaoDoCiclo).toBeNull();
  expect(r.percentualAlemDoCiclo).toBeNull();
});

test('SC-A02: diasEntreComprasMediana=null → SEM_BASE', () => {
  const r = calcularAtrasoCiclo(40, null);
  expect(r.status).toBe(STATUS_ATRASO.SEM_BASE);
  expect(r.diasAlemDoCiclo).toBeNull();
  expect(r.razaoDoCiclo).toBeNull();
});

test('SC-A03: mediana=0 → SEM_BASE (divisão por zero)', () => {
  const r = calcularAtrasoCiclo(40, 0);
  expect(r.status).toBe(STATUS_ATRASO.SEM_BASE);
  expect(r.cicloMedianoDias).toBeNull();
});

test('SC-A04: mediana negativa → SEM_BASE', () => {
  const r = calcularAtrasoCiclo(40, -5);
  expect(r.status).toBe(STATUS_ATRASO.SEM_BASE);
});

test('SC-A05: diasSemComprar negativo → SEM_BASE', () => {
  const r = calcularAtrasoCiclo(-1, 30);
  expect(r.status).toBe(STATUS_ATRASO.SEM_BASE);
});

// ── SEÇÃO B — ATRASO_ANTES_DO_CICLO ──────────────────────────────────────────

test('SC-B01: diasSemComprar=0, mediana=30 → ANTES_DO_CICLO', () => {
  const r = calcularAtrasoCiclo(0, 30);
  expect(r.status).toBe(STATUS_ATRASO.ANTES_DO_CICLO);
  expect(r.diasAlemDoCiclo).toBeNull();
  expect(r.percentualAlemDoCiclo).toBeNull();
  expect(r.razaoDoCiclo).toBe(0.00);
});

test('SC-B02: diasSemComprar=15, mediana=30 → ANTES_DO_CICLO, razao=0.50', () => {
  const r = calcularAtrasoCiclo(15, 30);
  expect(r.status).toBe(STATUS_ATRASO.ANTES_DO_CICLO);
  expect(r.razaoDoCiclo).toBe(0.50);
  expect(r.diasAlemDoCiclo).toBeNull();
});

test('SC-B03: diasSemComprar=29, mediana=30 → ANTES_DO_CICLO (1 dia antes)', () => {
  const r = calcularAtrasoCiclo(29, 30);
  expect(r.status).toBe(STATUS_ATRASO.ANTES_DO_CICLO);
  // razao = round(29/30*100)/100 = round(96.66)/100 = 0.97
  expect(r.razaoDoCiclo).toBe(0.97);
});

test('SC-B04: mediana decimal — dsc=10, mediana=14.5 → ANTES_DO_CICLO', () => {
  const r = calcularAtrasoCiclo(10, 14.5);
  expect(r.status).toBe(STATUS_ATRASO.ANTES_DO_CICLO);
  expect(r.cicloMedianoDias).toBe(14.5);
  expect(r.diasAlemDoCiclo).toBeNull();
});

test('SC-B05: ANTES_DO_CICLO preserva diasSemComprar e cicloMedianoDias', () => {
  const r = calcularAtrasoCiclo(5, 30);
  expect(r.diasSemComprar).toBe(5);
  expect(r.cicloMedianoDias).toBe(30);
});

// ── SEÇÃO C — ATRASO_NO_CICLO ─────────────────────────────────────────────────

test('SC-C01: diasSemComprar=30, mediana=30 → NO_CICLO', () => {
  const r = calcularAtrasoCiclo(30, 30);
  expect(r.status).toBe(STATUS_ATRASO.NO_CICLO);
  expect(r.diasAlemDoCiclo).toBe(0);
  expect(r.razaoDoCiclo).toBe(1.00);
  expect(r.percentualAlemDoCiclo).toBe(0.0);
});

test('SC-C02: mediana decimal exata — dsc=14.5, mediana=14.5 → NO_CICLO', () => {
  const r = calcularAtrasoCiclo(14.5, 14.5);
  expect(r.status).toBe(STATUS_ATRASO.NO_CICLO);
  expect(r.diasAlemDoCiclo).toBe(0);
  expect(r.percentualAlemDoCiclo).toBe(0.0);
});

test('SC-C03: NO_CICLO — diasAlem=0 (não null), razao=1.00, pct=0.0', () => {
  const r = calcularAtrasoCiclo(7, 7);
  expect(r.diasAlemDoCiclo).toBe(0);
  expect(r.razaoDoCiclo).toBe(1.00);
  expect(r.percentualAlemDoCiclo).toBe(0.0);
  expect(r.status).toBe(STATUS_ATRASO.NO_CICLO);
});

// ── SEÇÃO D — ATRASO_ATRASADO ─────────────────────────────────────────────────

test('SC-D01: 1 dia além — dsc=31, mediana=30 → ATRASADO, diasAlem=1', () => {
  const r = calcularAtrasoCiclo(31, 30);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(r.diasAlemDoCiclo).toBe(1);
  // razao = round(31/30*100)/100 = round(103.33)/100 = 1.03
  expect(r.razaoDoCiclo).toBe(1.03);
  // pct = round((1/30)*1000)/10 = round(33.33)/10 = 3.3
  expect(r.percentualAlemDoCiclo).toBe(3.3);
});

test('SC-D02: 50% além — dsc=45, mediana=30 → ATRASADO, pct=50.0', () => {
  const r = calcularAtrasoCiclo(45, 30);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(r.diasAlemDoCiclo).toBe(15);
  expect(r.razaoDoCiclo).toBe(1.50);
  expect(r.percentualAlemDoCiclo).toBe(50.0);
});

test('SC-D03: 100% além (2×) — dsc=60, mediana=30 → razao=2.00, pct=100.0', () => {
  const r = calcularAtrasoCiclo(60, 30);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(r.diasAlemDoCiclo).toBe(30);
  expect(r.razaoDoCiclo).toBe(2.00);
  expect(r.percentualAlemDoCiclo).toBe(100.0);
});

test('SC-D04: múltiplo alto — dsc=225, mediana=8 → razao=28.13, diasAlem=217', () => {
  const r = calcularAtrasoCiclo(225, 8);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(r.diasAlemDoCiclo).toBe(217);
  // 225/8 = 28.125 → round(28.125*100)/100 = round(2812.5)/100 = 2813/100 = 28.13
  expect(r.razaoDoCiclo).toBe(28.13);
});

test('SC-D05: CASE_003 — dsc=40, mediana=32 → ATRASADO, diasAlem=8, razao=1.25, pct=25.0', () => {
  const r = calcularAtrasoCiclo(40, 32);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(r.diasAlemDoCiclo).toBe(8);
  expect(r.razaoDoCiclo).toBe(1.25);
  expect(r.percentualAlemDoCiclo).toBe(25.0);
});

test('SC-D06: CASE_006 — dsc=171, mediana=6 → ATRASADO, diasAlem=165, razao=28.50, pct=2750.0', () => {
  const r = calcularAtrasoCiclo(171, 6);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(r.diasAlemDoCiclo).toBe(165);
  expect(r.razaoDoCiclo).toBe(28.50);
  expect(r.percentualAlemDoCiclo).toBe(2750.0);
});

test('SC-D07: CASE_009 — dsc=60, mediana=14.5 → ATRASADO, diasAlem=46, razao=4.14, pct=313.8', () => {
  const r = calcularAtrasoCiclo(60, 14.5);
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
  // Math.round(60-14.5) = Math.round(45.5) = 46
  expect(r.diasAlemDoCiclo).toBe(46);
  // Math.round(60/14.5*100)/100 = Math.round(413.79)/100 = 4.14
  expect(r.razaoDoCiclo).toBe(4.14);
  // Math.round((45.5/14.5)*1000)/10 = Math.round(3137.93)/10 = 313.8
  expect(r.percentualAlemDoCiclo).toBe(313.8);
});

// ── SEÇÃO E — ATRASO_ROUNDING ─────────────────────────────────────────────────

test('SC-E01: diasAlemDoCiclo é inteiro (Math.round)', () => {
  // dsc=60, med=14.5 → dsc-med=45.5 → round → 46
  const r = calcularAtrasoCiclo(60, 14.5);
  expect(Number.isInteger(r.diasAlemDoCiclo)).toBe(true);
  expect(r.diasAlemDoCiclo).toBe(46);
});

test('SC-E02: razaoDoCiclo tem no máximo 2 casas decimais', () => {
  const r = calcularAtrasoCiclo(60, 14.5);
  const str = String(r.razaoDoCiclo);
  const partes = str.split('.');
  const casas = partes[1] ? partes[1].length : 0;
  expect(casas).toBeLessThanOrEqual(2);
  expect(r.razaoDoCiclo).toBe(4.14);
});

test('SC-E03: percentualAlemDoCiclo tem no máximo 1 casa decimal', () => {
  const r = calcularAtrasoCiclo(60, 14.5);
  const str = String(r.percentualAlemDoCiclo);
  const partes = str.split('.');
  const casas = partes[1] ? partes[1].length : 0;
  expect(casas).toBeLessThanOrEqual(1);
});

test('SC-E04: 1/3 sem artefato de divisão — dsc=31, mediana=30', () => {
  const r = calcularAtrasoCiclo(31, 30);
  // pct = round((1/30)*1000)/10 = round(33.33)/10 = 3.3
  expect(r.percentualAlemDoCiclo).toBe(3.3);
  // não deve ser 3.333... ou 3.33...
  expect(r.percentualAlemDoCiclo).not.toBeCloseTo(3.333, 2);
});

// ── SEÇÃO F — ATRASO_INVARIANTS ───────────────────────────────────────────────

test('SC-F01: determinismo — mesma entrada = mesma saída', () => {
  const r1 = calcularAtrasoCiclo(60, 14.5);
  const r2 = calcularAtrasoCiclo(60, 14.5);
  expect(r1).toEqual(r2);
  expect(r1.status).toBe(r2.status);
  expect(r1.diasAlemDoCiclo).toBe(r2.diasAlemDoCiclo);
});

test('SC-F02: output é imutável (Object.freeze)', () => {
  const r = calcularAtrasoCiclo(45, 30);
  expect(() => { r.status = 'HACK'; }).toThrow();
  expect(r.status).toBe(STATUS_ATRASO.ATRASADO);
});

test('SC-F03: entradas não são mutadas pela função', () => {
  const dsc = 45;
  const med = 30;
  calcularAtrasoCiclo(dsc, med);
  expect(dsc).toBe(45);
  expect(med).toBe(30);
});

// ── SEÇÃO G — VOLUME_SEM_MOVIMENTO ───────────────────────────────────────────

test('SC-G01: ambas janelas 30d zero → j30d.pedidos=SEM_MOVIMENTO', () => {
  const r = calcularVariacaoVolume(mkPerfil());
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.SEM_MOVIMENTO);
  expect(r.j30d.pedidos.variacao).toBeNull();
});

test('SC-G02: ambas janelas 90d zero → j90d.faturamento=SEM_MOVIMENTO', () => {
  const r = calcularVariacaoVolume(mkPerfil());
  expect(r.j90d.faturamento.status).toBe(STATUS_VOLUME.SEM_MOVIMENTO);
  expect(r.j90d.faturamento.atual).toBe(0);
  expect(r.j90d.faturamento.anterior).toBe(0);
});

test('SC-G03: mix — j30d SEM_MOVIMENTO, j90d tem dados', () => {
  const r = calcularVariacaoVolume(mkPerfil({
    pedidos90d: 3, pedidos180d: 8,
    faturamento90d: 900, faturamento180d: 1800,
  }));
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.SEM_MOVIMENTO);
  expect(r.j90d.pedidos.status).not.toBe(STATUS_VOLUME.SEM_MOVIMENTO);
});

// ── SEÇÃO H — VOLUME_BASE_ZERO_CRESCIMENTO ────────────────────────────────────

test('SC-H01: pedidos anterior=0, atual>0 → BASE_ZERO_CRESCIMENTO', () => {
  // pedidos30d=5, pedidos60d=5 → anterior = 5-5 = 0, atual = 5
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 5, pedidos60d: 5 }));
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.BASE_ZERO_CRESCIMENTO);
  expect(r.j30d.pedidos.variacao).toBeNull();
  expect(r.j30d.pedidos.atual).toBe(5);
  expect(r.j30d.pedidos.anterior).toBe(0);
});

test('SC-H02: faturamento anterior=0, atual>0 → BASE_ZERO_CRESCIMENTO', () => {
  const r = calcularVariacaoVolume(mkPerfil({
    faturamento30d: 1000, faturamento60d: 1000,
  }));
  expect(r.j30d.faturamento.status).toBe(STATUS_VOLUME.BASE_ZERO_CRESCIMENTO);
});

test('SC-H03: j90d BASE_ZERO_CRESCIMENTO', () => {
  // pedidos90d=4, pedidos180d=4 → anterior = 4-4 = 0, atual = 4
  const r = calcularVariacaoVolume(mkPerfil({ pedidos90d: 4, pedidos180d: 4 }));
  expect(r.j90d.pedidos.status).toBe(STATUS_VOLUME.BASE_ZERO_CRESCIMENTO);
});

// ── SEÇÃO I — VOLUME_QUEDA_TOTAL ──────────────────────────────────────────────

test('SC-I01: pedidos anterior>0, atual=0 → QUEDA_TOTAL', () => {
  // pedidos30d=0, pedidos60d=3 → anterior=3, atual=0
  const r = calcularVariacaoVolume(mkPerfil({ pedidos60d: 3 }));
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.QUEDA_TOTAL);
  expect(r.j30d.pedidos.atual).toBe(0);
  expect(r.j30d.pedidos.anterior).toBe(3);
  expect(r.j30d.pedidos.variacao).toBe(-100.0);
});

test('SC-I02: faturamento anterior>0, atual=0 → QUEDA_TOTAL', () => {
  const r = calcularVariacaoVolume(mkPerfil({ faturamento60d: 500 }));
  expect(r.j30d.faturamento.status).toBe(STATUS_VOLUME.QUEDA_TOTAL);
  expect(r.j30d.faturamento.variacao).toBe(-100.0);
});

test('SC-I03: CASE_006 j90d.pedidos — atual=0, anterior=2 → QUEDA_TOTAL', () => {
  // pedidos90d=0, pedidos180d=2 → anterior=2-0=2, atual=0
  const r = calcularVariacaoVolume(mkPerfil({ pedidos180d: 2 }));
  expect(r.j90d.pedidos.status).toBe(STATUS_VOLUME.QUEDA_TOTAL);
  expect(r.j90d.pedidos.variacao).toBe(-100.0);
});

test('SC-I04: QUEDA_TOTAL variacao=-100.0 (não Infinity)', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos60d: 10 }));
  expect(r.j30d.pedidos.variacao).toBe(-100.0);
  expect(isFinite(r.j30d.pedidos.variacao)).toBe(true);
  expect(r.j30d.pedidos.variacao).not.toBe(Infinity);
});

// ── SEÇÃO J — VOLUME_CRESCIMENTO ─────────────────────────────────────────────

test('SC-J01: +20% exato → CRESCIMENTO (limiar)', () => {
  // atual=6, anterior=5 → var=20% = TOLERANCIA_ESTAVEL_VOLUME exato
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 6, pedidos60d: 11 }));
  // anterior = 11 - 6 = 5
  expect(r.j30d.pedidos.atual).toBe(6);
  expect(r.j30d.pedidos.anterior).toBe(5);
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.CRESCIMENTO);
});

test('SC-J02: +50% → CRESCIMENTO', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 6, pedidos60d: 10 }));
  // anterior = 10-6 = 4, var = (6-4)/4 = 50% → CRESCIMENTO
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.CRESCIMENTO);
  // variacao = round((2/4)*1000)/10 = round(500)/10 = 50.0
  expect(r.j30d.pedidos.variacao).toBe(50.0);
});

test('SC-J03: +19.9% → ESTAVEL (abaixo do limiar)', () => {
  // atual=11.99, anterior=10 → var=19.9% < 20%
  // Usando inteiros: atual=119, anterior=100 → var=19%
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 119, pedidos60d: 219 }));
  // anterior = 219-119 = 100, var = 19% → ESTAVEL
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.ESTAVEL);
});

// ── SEÇÃO K — VOLUME_QUEDA ────────────────────────────────────────────────────

test('SC-K01: -20% exato → QUEDA (limiar)', () => {
  // atual=4, anterior=5 → var=-20% = -TOLERANCIA exato
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 4, pedidos60d: 9 }));
  // anterior = 9-4 = 5, var = (4-5)/5 = -20% → QUEDA
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.QUEDA);
});

test('SC-K02: -60% → QUEDA, CASE_009 j90d.pedidos', () => {
  // pedidos90d=2, pedidos180d=7 → anterior=5, atual=2, var=-60%
  const r = calcularVariacaoVolume(mkPerfil({ pedidos90d: 2, pedidos180d: 7 }));
  expect(r.j90d.pedidos.status).toBe(STATUS_VOLUME.QUEDA);
  expect(r.j90d.pedidos.variacao).toBe(-60.0);
  expect(r.j90d.pedidos.atual).toBe(2);
  expect(r.j90d.pedidos.anterior).toBe(5);
});

test('SC-K03: -19% → ESTAVEL (acima do limiar negativo)', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 81, pedidos60d: 181 }));
  // anterior = 181-81 = 100, var = (81-100)/100 = -19% → ESTAVEL
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.ESTAVEL);
});

// ── SEÇÃO L — VOLUME_ESTAVEL ──────────────────────────────────────────────────

test('SC-L01: mesma quantidade → ESTAVEL (0%)', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 5, pedidos60d: 10 }));
  // anterior=5, atual=5, var=0% → ESTAVEL
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.ESTAVEL);
  expect(r.j30d.pedidos.variacao).toBe(0.0);
});

test('SC-L02: faturamento estável', () => {
  const r = calcularVariacaoVolume(mkPerfil({
    faturamento30d: 1000, faturamento60d: 2000,
    // anterior = 2000-1000 = 1000 = atual → ESTAVEL
  }));
  expect(r.j30d.faturamento.status).toBe(STATUS_VOLUME.ESTAVEL);
  expect(r.j30d.faturamento.variacao).toBe(0.0);
});

// ── SEÇÃO M — VOLUME_INDEPENDENT ─────────────────────────────────────────────

test('SC-M01: pedidos crescem, faturamento cai → status independentes', () => {
  // ped: atual=6, anterior=4 → +50% CRESCIMENTO
  // fat: atual=800, anterior=1000 → -20% QUEDA
  const r = calcularVariacaoVolume(mkPerfil({
    pedidos30d:    6,   pedidos60d:    10,   // anterior=4
    faturamento30d: 800, faturamento60d: 1800, // anterior=1000
  }));
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.CRESCIMENTO);
  expect(r.j30d.faturamento.status).toBe(STATUS_VOLUME.QUEDA);
});

test('SC-M02: pedidos caem, faturamento cresce → status independentes', () => {
  const r = calcularVariacaoVolume(mkPerfil({
    pedidos30d:    3,   pedidos60d:    8,    // anterior=5, var=-40% QUEDA
    faturamento30d: 2000, faturamento60d: 2500, // anterior=500, +300% CRESCIMENTO
  }));
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.QUEDA);
  expect(r.j30d.faturamento.status).toBe(STATUS_VOLUME.CRESCIMENTO);
});

test('SC-M03: j30d e j90d são independentes entre si', () => {
  const r = calcularVariacaoVolume(mkPerfil({
    pedidos30d: 5, pedidos60d: 5,   // j30d.pedidos: atual=5, ant=0 → BASE_ZERO_CRESCIMENTO
    pedidos90d: 2, pedidos180d: 7,  // j90d.pedidos: atual=2, ant=5 → QUEDA
  }));
  expect(r.j30d.pedidos.status).toBe(STATUS_VOLUME.BASE_ZERO_CRESCIMENTO);
  expect(r.j90d.pedidos.status).toBe(STATUS_VOLUME.QUEDA);
});

// ── SEÇÃO N — VOLUME_J30D_J90D ────────────────────────────────────────────────

test('SC-N01: j30d.pedidos.anterior = pedidos60d - pedidos30d', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 3, pedidos60d: 8 }));
  expect(r.j30d.pedidos.anterior).toBe(5); // 8-3=5
  expect(r.j30d.pedidos.atual).toBe(3);
});

test('SC-N02: j90d.pedidos.anterior = pedidos180d - pedidos90d', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos90d: 2, pedidos180d: 7 }));
  expect(r.j90d.pedidos.anterior).toBe(5); // 7-2=5
  expect(r.j90d.pedidos.atual).toBe(2);
});

// ── SEÇÃO O — VOLUME_ROUNDING ─────────────────────────────────────────────────

test('SC-O01: variacao tem 1 casa decimal', () => {
  // pedidos30d=2, pedidos60d=5 → anterior=3, atual=2 → var=round((-1/3)*1000)/10 = -33.3
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 2, pedidos60d: 5 }));
  const str = String(r.j30d.pedidos.variacao);
  const partes = str.split('.');
  const casas = partes[1] ? partes[1].length : 0;
  expect(casas).toBeLessThanOrEqual(1);
  expect(r.j30d.pedidos.variacao).toBe(-33.3);
});

test('SC-O02: variacao negativa não é Infinity nem NaN', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos60d: 5 }));
  expect(isFinite(r.j30d.pedidos.variacao)).toBe(true);
  expect(isNaN(r.j30d.pedidos.variacao)).toBe(false);
});

// ── SEÇÃO P — VOLUME_INVALID ──────────────────────────────────────────────────

test('SC-P01: perfil=null → lança erro', () => {
  expect(() => calcularVariacaoVolume(null)).toThrow('calcularVariacaoVolume: perfil deve ser objeto');
});

test('SC-P02: perfil=string → lança erro', () => {
  expect(() => calcularVariacaoVolume('foo')).toThrow();
});

// ── SEÇÃO Q — VOLUME_IMMUTABILITY ─────────────────────────────────────────────

test('SC-Q01: resultado raiz é imutável', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 5, pedidos60d: 10 }));
  expect(() => { r.j30d = null; }).toThrow();
});

test('SC-Q02: j30d.pedidos é imutável', () => {
  const r = calcularVariacaoVolume(mkPerfil({ pedidos30d: 5, pedidos60d: 10 }));
  expect(() => { r.j30d.pedidos.status = 'HACK'; }).toThrow();
});

// ── SEÇÃO R — SANITIZED_CASES (N33) ──────────────────────────────────────────
// Fatos sanitizados — sem PII, sem identificadores reais.

/**
 * CASE_003 (JANELA_DE_RECOMPRA, N33):
 *   diasSemComprar=40, mediana=32
 *   pedidos30d=0, pedidos60d=1
 */
test('SC-R01: CASE_003 — atrasoCiclo e j30d.pedidos capturados deterministicamente', () => {
  const atraso = calcularAtrasoCiclo(40, 32);
  expect(atraso.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(atraso.diasAlemDoCiclo).toBe(8);
  expect(atraso.razaoDoCiclo).toBe(1.25);
  expect(atraso.percentualAlemDoCiclo).toBe(25.0);

  const vol = calcularVariacaoVolume(mkPerfil({ pedidos60d: 1 }));
  // anterior=1-0=1, atual=0 → QUEDA_TOTAL
  expect(vol.j30d.pedidos.status).toBe(STATUS_VOLUME.QUEDA_TOTAL);
  expect(vol.j30d.pedidos.variacao).toBe(-100.0);
});

/**
 * CASE_006 (REATIVACAO_120D, N33):
 *   diasSemComprar=171, mediana=6
 *   pedidos30d=0, pedidos60d=0, pedidos90d=0, pedidos180d=2
 */
test('SC-R02: CASE_006 — múltiplo 28.5× e j90d.QUEDA_TOTAL capturados deterministicamente', () => {
  const atraso = calcularAtrasoCiclo(171, 6);
  expect(atraso.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(atraso.diasAlemDoCiclo).toBe(165);
  expect(atraso.razaoDoCiclo).toBe(28.50);
  expect(atraso.percentualAlemDoCiclo).toBe(2750.0);

  const vol = calcularVariacaoVolume(mkPerfil({ pedidos180d: 2 }));
  // j90d: atual=0, anterior=2-0=2 → QUEDA_TOTAL
  expect(vol.j90d.pedidos.status).toBe(STATUS_VOLUME.QUEDA_TOTAL);
  // O insight "28× o ciclo" que a LLM não calculou agora está aqui:
  expect(atraso.razaoDoCiclo).toBeGreaterThan(28);
});

/**
 * CASE_009 (QUEDA_DE_COMPRAS, N33):
 *   diasSemComprar=60, mediana=14.5
 *   pedidos30d=0, pedidos60d=0, pedidos90d=2, pedidos180d=7
 */
test('SC-R03: CASE_009 — 4× o ciclo e j90d.QUEDA(-60%) capturados deterministicamente', () => {
  const atraso = calcularAtrasoCiclo(60, 14.5);
  expect(atraso.status).toBe(STATUS_ATRASO.ATRASADO);
  expect(atraso.diasAlemDoCiclo).toBe(46);
  expect(atraso.razaoDoCiclo).toBe(4.14);

  const vol = calcularVariacaoVolume(mkPerfil({ pedidos90d: 2, pedidos180d: 7 }));
  // j30d: 0 vs 0 → SEM_MOVIMENTO (LLM antes escolhia comparar com 180d)
  expect(vol.j30d.pedidos.status).toBe(STATUS_VOLUME.SEM_MOVIMENTO);
  // j90d: 2 vs 5 → QUEDA -60%
  expect(vol.j90d.pedidos.status).toBe(STATUS_VOLUME.QUEDA);
  expect(vol.j90d.pedidos.variacao).toBe(-60.0);
  expect(vol.j90d.pedidos.anterior).toBe(5);
});

// ── SEÇÃO S — ACTION_DECISION_UNCHANGED ──────────────────────────────────────
// Prova que os sinais comerciais não alteram nenhuma decisão determinística.

test('SC-S01: AGIR_AGORA não muda após calcular sinais', () => {
  const ctx = mkCtxDecisao();
  const decisaoAntes = calcularDecisaoAcaoComercial(ctx);
  // Calcula sinais — não usa resultado
  calcularAtrasoCiclo(ctx.diasSemComprar, ctx.diasEntreComprasMediana);
  calcularVariacaoVolume(ctx);
  const decisaoDepois = calcularDecisaoAcaoComercial(ctx);
  expect(decisaoAntes.decisaoAcaoComercial).toBe(decisaoDepois.decisaoAcaoComercial);
  expect(decisaoAntes.decisaoAcaoComercial).toBe('AGIR_AGORA');
});

test('SC-S02: PROGRAMAR_CICLO não muda após calcular sinais', () => {
  const ctx = mkCtxDecisao({
    tipoOportunidade: null, prioridade: null,
    diasSemComprar: 5, diasEntreComprasMediana: 30,
    recorrenciaStatus: 'DENTRO_DO_PADRAO', tendencia: 'CRESCENDO',
    scoreTotal: 88,
  });
  const decisaoAntes = calcularDecisaoAcaoComercial(ctx);
  calcularAtrasoCiclo(ctx.diasSemComprar, ctx.diasEntreComprasMediana);
  calcularVariacaoVolume(ctx);
  const decisaoDepois = calcularDecisaoAcaoComercial(ctx);
  expect(decisaoAntes.decisaoAcaoComercial).toBe(decisaoDepois.decisaoAcaoComercial);
  expect(decisaoAntes.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
});

test('SC-S03: sinaisComerciais é módulo completamente isolado do motor de decisão', () => {
  // Prova estrutural: sinaisComerciais não importa decisaoAcaoComercial
  const sinaisModule = require('../lib/sinaisComerciais');
  expect(sinaisModule.calcularAtrasoCiclo).toBeDefined();
  expect(sinaisModule.calcularVariacaoVolume).toBeDefined();
  // Nenhum campo relacionado à decisão no módulo
  expect(sinaisModule.DECISAO_ENUM).toBeUndefined();
  expect(sinaisModule.calcularDecisaoAcaoComercial).toBeUndefined();
});

// ── Verificação de exports ────────────────────────────────────────────────────

test('VERSAO_SINAIS exportado', () => {
  expect(VERSAO_SINAIS).toBe('sinais-comerciais-v1');
});

test('TOLERANCIA_ESTAVEL_VOLUME = 0.20 (alinhado com tendenciaComercial)', () => {
  expect(TOLERANCIA_ESTAVEL_VOLUME).toBe(0.20);
});

test('STATUS_ATRASO: todos os 4 valores presentes', () => {
  expect(Object.keys(STATUS_ATRASO)).toHaveLength(4);
  ['SEM_BASE', 'ANTES_DO_CICLO', 'NO_CICLO', 'ATRASADO'].forEach(v => {
    expect(STATUS_ATRASO[v]).toBe(v);
  });
});

test('STATUS_VOLUME: todos os 7 valores presentes', () => {
  expect(Object.keys(STATUS_VOLUME)).toHaveLength(7);
  ['SEM_BASE', 'SEM_MOVIMENTO', 'BASE_ZERO_CRESCIMENTO', 'QUEDA_TOTAL',
   'CRESCIMENTO', 'QUEDA', 'ESTAVEL'].forEach(v => {
    expect(STATUS_VOLUME[v]).toBe(v);
  });
});
