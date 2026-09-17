'use strict';

/**
 * OPORT360-01 → OPORT360-12
 * Testa o motor de Oportunidades Comerciais V1 (oportunidades.js).
 *
 * Invariantes:
 *   - IDs determinísticos (mesmo cliente + tipo + data = mesmo id)
 *   - NUNCA_COMPROU: apenas tipo NUNCA_COMPROU é gerado
 *   - REATIVACAO_120D: apenas para inativo120d=true e nuncaComprou=false
 *   - QUEDA_DE_COMPRAS: apenas para tendência CAINDO, não-inativo, não-nuncaComprou
 *   - JANELA_DE_RECOMPRA: apenas para PROXIMO_DA_JANELA ou ATRASADO_VS_HISTORICO
 *   - CROSS_SELL: apenas 1 categoria + pedidosTotal >= 3 + não inativo
 *   - prioridade 1-100
 *   - perfil inválido lança erro
 */

const {
  gerarOportunidades,
  gerarOportunidadeId,
  gerarOportNuncaComprou,
  gerarOportReativacao120d,
  gerarOportQuedaDeCompras,
  gerarOportJanelaRecompra,
  gerarOportCrossSell,
  VERSAO_MOTOR,
} = require('../lib/oportunidades');

// ── Helpers ────────────────────────────────────────────────────────────────────

const DATA_REF = '2026-09-16';

function mkPerfil(overrides = {}) {
  return {
    clienteMr4Id:           'cli_001',
    gestaoClickId:          'gc_001',
    dataReferencia:         DATA_REF,
    nuncaComprou:           false,
    inativo120d:            false,
    diasSemComprar:         15,
    ultimaCompraEm:         '2026-09-01',
    faturamentoTotal:       12000,
    faturamento30d:         2000,
    faturamento60d:         4000,
    pedidosTotal:           10,
    pedidos30d:             2,
    pedidos60d:             4,
    categoriasMaisCompradas: [
      { categoria: 'PNEU', faturamento: 8000 },
      { categoria: 'OLEO', faturamento: 4000 },
    ],
    ...overrides,
  };
}

function mkScore(overrides = {}) {
  return { scoreTotal: 70, classificacao: 'BOM', ...overrides };
}

function mkTendencia(tendencia = 'ESTAVEL', overrides = {}) {
  return { tendencia, metodo: 'JANELA_30D_VS_30D_ANTERIOR', ...overrides };
}

function mkRecorrencia(status = 'DENTRO_DO_PADRAO', overrides = {}) {
  return {
    status,
    padrao: { mediaIntervaloDias: 25, medianaIntervaloDias: 22, limiteAlertaDias: 21, limiteAtrasoDias: 28 },
    posicaoAtual: { diasSemComprar: 15 },
    ...overrides,
  };
}

// ── OPORT360-01: IDs determinísticos ─────────────────────────────────────────

test('OPORT360-01: gerarOportunidadeId é determinístico para os mesmos inputs', () => {
  const id1 = gerarOportunidadeId('cli_001', 'REATIVACAO_120D', DATA_REF);
  const id2 = gerarOportunidadeId('cli_001', 'REATIVACAO_120D', DATA_REF);
  expect(id1).toBe(id2);
  expect(id1).toHaveLength(16);
});

test('OPORT360-01b: IDs distintos para tipo diferente', () => {
  const id1 = gerarOportunidadeId('cli_001', 'REATIVACAO_120D', DATA_REF);
  const id2 = gerarOportunidadeId('cli_001', 'NUNCA_COMPROU', DATA_REF);
  expect(id1).not.toBe(id2);
});

// ── OPORT360-02: NUNCA_COMPROU ────────────────────────────────────────────────

test('OPORT360-02: nuncaComprou=true → apenas tipo NUNCA_COMPROU é gerado', () => {
  const perfilNovo = mkPerfil({
    nuncaComprou: true,
    inativo120d: false,
    pedidosTotal: 0,
    faturamentoTotal: 0,
    categoriasMaisCompradas: [],
  });
  const oports = gerarOportunidades(perfilNovo, null, null, null, DATA_REF);
  expect(oports).toHaveLength(1);
  expect(oports[0].tipo).toBe('NUNCA_COMPROU');
  expect(oports[0].prioridade).toBe(30);
});

// ── OPORT360-03: REATIVACAO_120D ─────────────────────────────────────────────

test('OPORT360-03: inativo120d=true, nuncaComprou=false → tipo REATIVACAO_120D presente', () => {
  const perfilInativo = mkPerfil({
    inativo120d: true,
    diasSemComprar: 150,
    categoriasMaisCompradas: [],  // 0 categorias → sem cross-sell
  });
  const oports = gerarOportunidades(perfilInativo, mkScore(), mkTendencia('ESTAVEL'), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).toContain('REATIVACAO_120D');
  expect(tipos).not.toContain('NUNCA_COMPROU');
  expect(tipos).not.toContain('QUEDA_DE_COMPRAS');  // inativo → bloqueado
});

test('OPORT360-03b: prioridade de REATIVACAO_120D >= 50', () => {
  const perfilInativo = mkPerfil({ inativo120d: true, diasSemComprar: 150, categoriasMaisCompradas: [] });
  const oports = gerarOportunidades(perfilInativo, mkScore(), null, null, DATA_REF);
  const ort = oports.find(o => o.tipo === 'REATIVACAO_120D');
  expect(ort).toBeDefined();
  expect(ort.prioridade).toBeGreaterThanOrEqual(50);
});

// ── OPORT360-04: QUEDA_DE_COMPRAS ────────────────────────────────────────────

test('OPORT360-04: tendência CAINDO + ativo → tipo QUEDA_DE_COMPRAS presente', () => {
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia('CAINDO'), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).toContain('QUEDA_DE_COMPRAS');
  const ort = oports.find(o => o.tipo === 'QUEDA_DE_COMPRAS');
  expect(ort.prioridade).toBeGreaterThan(0);
  expect(ort.prioridade).toBeLessThanOrEqual(100);
});

test('OPORT360-04b: tendência CRESCENDO → sem QUEDA_DE_COMPRAS', () => {
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia('CRESCENDO'), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
});

test('OPORT360-04c: tendência CAINDO mas inativo120d → sem QUEDA_DE_COMPRAS (tem REATIVACAO)', () => {
  const perfilInativo = mkPerfil({ inativo120d: true, diasSemComprar: 150, categoriasMaisCompradas: [] });
  const oports = gerarOportunidades(perfilInativo, mkScore(), mkTendencia('CAINDO'), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
  expect(tipos).toContain('REATIVACAO_120D');
});

// ── OPORT360-05: JANELA_DE_RECOMPRA ──────────────────────────────────────────

test('OPORT360-05: recorrência PROXIMO_DA_JANELA → tipo JANELA_DE_RECOMPRA presente', () => {
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia(), mkRecorrencia('PROXIMO_DA_JANELA'), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).toContain('JANELA_DE_RECOMPRA');
  const ort = oports.find(o => o.tipo === 'JANELA_DE_RECOMPRA');
  expect(ort.prioridade).toBe(60);
});

test('OPORT360-05b: recorrência ATRASADO_VS_HISTORICO → prioridade 75', () => {
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia(), mkRecorrencia('ATRASADO_VS_HISTORICO'), DATA_REF);
  const ort = oports.find(o => o.tipo === 'JANELA_DE_RECOMPRA');
  expect(ort).toBeDefined();
  expect(ort.prioridade).toBe(75);
});

test('OPORT360-05c: recorrência DENTRO_DO_PADRAO → sem JANELA_DE_RECOMPRA', () => {
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia(), mkRecorrencia('DENTRO_DO_PADRAO'), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
});

// ── OPORT360-06: CROSS_SELL_CATEGORIA ────────────────────────────────────────

test('OPORT360-06: 1 categoria + pedidosTotal>=3 + ativo → CROSS_SELL_CATEGORIA', () => {
  const perfilCross = mkPerfil({
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 8000 }],
    pedidosTotal: 5,
    inativo120d: false,
  });
  const oports = gerarOportunidades(perfilCross, mkScore(), mkTendencia('ESTAVEL'), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).toContain('CROSS_SELL_CATEGORIA');
});

test('OPORT360-06b: 2 categorias → sem CROSS_SELL_CATEGORIA', () => {
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia(), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).not.toContain('CROSS_SELL_CATEGORIA');
});

test('OPORT360-06c: 1 categoria mas inativo120d → sem CROSS_SELL_CATEGORIA', () => {
  const perfilInativo = mkPerfil({
    inativo120d: true,
    diasSemComprar: 150,
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 8000 }],
  });
  const oports = gerarOportunidades(perfilInativo, mkScore(), mkTendencia(), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).not.toContain('CROSS_SELL_CATEGORIA');
});

test('OPORT360-06d: 1 categoria mas pedidosTotal < 3 → sem CROSS_SELL_CATEGORIA', () => {
  const perfilPoucoHistorico = mkPerfil({
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 500 }],
    pedidosTotal: 2,
  });
  const oports = gerarOportunidades(perfilPoucoHistorico, mkScore(), mkTendencia(), mkRecorrencia(), DATA_REF);
  const tipos = oports.map(o => o.tipo);
  expect(tipos).not.toContain('CROSS_SELL_CATEGORIA');
});

// ── OPORT360-07: cliente sem oportunidades ────────────────────────────────────

test('OPORT360-07: cliente ativo com 2 categorias + recorrência dentro padrão → 0 oportunidades específicas', () => {
  // 2 categorias → sem cross-sell; tendência ESTAVEL; recorrência DENTRO_DO_PADRAO; ativo
  const oports = gerarOportunidades(mkPerfil(), mkScore(), mkTendencia('ESTAVEL'), mkRecorrencia('DENTRO_DO_PADRAO'), DATA_REF);
  expect(oports).toHaveLength(0);
});

// ── OPORT360-08: prioridade entre 1-100 em toda oportunidade ─────────────────

test('OPORT360-08: prioridade de qualquer oportunidade está entre 1 e 100', () => {
  const cenarios = [
    [mkPerfil({ nuncaComprou: true, pedidosTotal: 0, categoriasMaisCompradas: [] }), null, null, null],
    [mkPerfil({ inativo120d: true, diasSemComprar: 200, categoriasMaisCompradas: [] }), mkScore(), mkTendencia('CAINDO'), mkRecorrencia()],
    [mkPerfil({ categoriasMaisCompradas: [{ categoria: 'X', faturamento: 100 }], pedidosTotal: 5 }), mkScore(), mkTendencia('CAINDO'), mkRecorrencia('ATRASADO_VS_HISTORICO')],
  ];
  for (const [p, s, t, r] of cenarios) {
    const oports = gerarOportunidades(p, s, t, r, DATA_REF);
    for (const o of oports) {
      expect(o.prioridade).toBeGreaterThanOrEqual(1);
      expect(o.prioridade).toBeLessThanOrEqual(100);
    }
  }
});

// ── OPORT360-09: perfil inválido lança erro ───────────────────────────────────

test('OPORT360-09: perfil inválido lança erro descritivo', () => {
  expect(() => gerarOportunidades(null, null, null, null, DATA_REF)).toThrow('gerarOportunidades: perfil inválido ou ausente');
  expect(() => gerarOportunidades('string', null, null, null, DATA_REF)).toThrow();
});

// ── OPORT360-10: campos obrigatórios em toda oportunidade ─────────────────────

test('OPORT360-10: toda oportunidade tem id, tipo, prioridade, evidencias, metricas, versaoMotor', () => {
  const perfilInativo = mkPerfil({ inativo120d: true, diasSemComprar: 180, categoriasMaisCompradas: [] });
  const oports = gerarOportunidades(perfilInativo, mkScore(), mkTendencia(), mkRecorrencia(), DATA_REF);
  expect(oports.length).toBeGreaterThan(0);
  for (const o of oports) {
    expect(o.id).toBeTruthy();
    expect(o.tipo).toBeTruthy();
    expect(typeof o.prioridade).toBe('number');
    expect(Array.isArray(o.evidencias)).toBe(true);
    expect(o.evidencias.length).toBeGreaterThan(0);
    expect(typeof o.metricas).toBe('object');
    expect(o.versaoMotor).toBeTruthy();
    expect(o.status).toBe('ABERTA');
  }
});

// ── OPORT360-11: VERSAO_MOTOR exportado ──────────────────────────────────────

test('OPORT360-11: VERSAO_MOTOR exportado e não-vazio', () => {
  expect(VERSAO_MOTOR).toBeTruthy();
});

// ── OPORT360-12: determinismo — mesmo input = mesmas oportunidades ────────────

test('OPORT360-12: gerarOportunidades é determinístico (mesmo resultado em 2 chamadas)', () => {
  const p = mkPerfil({ inativo120d: true, diasSemComprar: 150, categoriasMaisCompradas: [] });
  const oports1 = gerarOportunidades(p, mkScore(), mkTendencia(), mkRecorrencia(), DATA_REF);
  const oports2 = gerarOportunidades(p, mkScore(), mkTendencia(), mkRecorrencia(), DATA_REF);
  expect(oports1.map(o => o.id)).toEqual(oports2.map(o => o.id));
  expect(oports1.map(o => o.tipo)).toEqual(oports2.map(o => o.tipo));
  expect(oports1.map(o => o.prioridade)).toEqual(oports2.map(o => o.prioridade));
});
