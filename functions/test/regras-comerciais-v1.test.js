'use strict';

/**
 * REGRAS COMERCIAIS V1 — testes de especificação.
 *
 * APROVADO_PROPRIETARIO_2026-09-17
 *
 * Cada teste verifica uma regra de negócio explicitamente aprovada:
 *   SCORE-V1    — pesos, significados, limites de contribuição
 *   SINGLE-V1   — pedido único → SEM_BASE
 *   RECURRENCE-V1 — ciclo por mediana, outliers, mesmo dia
 *   TREND-V1    — base mínima 2 pedidos
 *   NEVER-V1    — never bought: identidade, campos nulos
 *   OPP-V1      — conflito O1 (reativação absorve janela), janela válida
 *   CROSS-V1    — cross-sell desativado
 *   QUEUE-V1    — filas corretas por tipo de cliente
 *   FRONTIER    — fronteiras exatas de recência
 */

const CFG = require('../config/score-comercial.v1.js');
const {
  calcularScore,
  calcularRecencia,
  calcularFrequencia,
  calcularFaturamento,
  calcularTendenciaPontuacao,
  calcularDiversidade,
} = require('../lib/scoreComercial');
const { calcularRecorrencia, FATOR_ALERTA, FATOR_ATRASO } = require('../lib/recorrencia');
const { calcularTendencia } = require('../lib/tendenciaComercial');
const { gerarOportunidades } = require('../lib/oportunidades');

// ── Helpers ────────────────────────────────────────────────────────────────────

const DATA_REF = '2026-09-17';

function mkPerfil(overrides = {}) {
  return {
    clienteMr4Id:              'cli_v1',
    gestaoClickId:             'gc_v1',
    dataReferencia:            DATA_REF,
    nuncaComprou:              false,
    inativo120d:               false,
    diasSemComprar:            20,
    ultimaCompraEm:            '2026-08-28',
    faturamentoTotal:          3000,
    faturamento90d:            1200,
    faturamento30d:            500,
    faturamento60d:            1000,
    faturamento180d:           2500,
    pedidosTotal:              10,
    pedidos90d:                3,
    pedidos30d:                2,
    pedidos60d:                4,
    pedidos180d:               8,
    diasEntreComprasMedio:     22,
    diasEntreComprasMediana:   20,
    quantidadeProdutosDistintos: 5,
    categoriasMaisCompradas:   [
      { categoria: 'PNEU',  faturamento: 2000 },
      { categoria: 'OLEO',  faturamento: 1000 },
    ],
    ...overrides,
  };
}

function mkPerfilNuncaComprou(overrides = {}) {
  return {
    clienteMr4Id:              'cli_new',
    gestaoClickId:             'gc_new',
    dataReferencia:            DATA_REF,
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

// ── SCORE-V1-01: pesos somam exatamente 100 ────────────────────────────────────

test('SCORE-V1-01: soma de todos os pesos = 100 exato', () => {
  const soma = Object.values(CFG.PESOS).reduce((acc, v) => acc + v, 0);
  expect(soma).toBe(100);
});

// ── SCORE-V1-02: engajamento desativado ────────────────────────────────────────

test('SCORE-V1-02: PESOS.engajamento = 0 (V1 sem fonte confiável)', () => {
  expect(CFG.PESOS.engajamento).toBe(0);
});

// ── SCORE-V1-03: never bought não recebe sinal artificial ─────────────────────

test('SCORE-V1-03: nuncaComprou → todos componentes zerados, scoreTotal <= 10', () => {
  const r = calcularScore(mkPerfilNuncaComprou());
  expect(r.scoreTotal).toBeLessThanOrEqual(10);
  expect(r.componentes.recencia.pontuacao).toBe(0);
  expect(r.componentes.frequencia.pontuacao).toBe(0);
  expect(r.componentes.faturamento.pontuacao).toBe(0);
  expect(r.componentes.diversidade.pontuacao).toBe(0);
  expect(r.componentes.engajamento.pontuacao).toBe(0);
  // Engajamento: peso=0 → contribuição sempre 0, mesmo que pontuacao > 0
  expect(r.componentes.engajamento.peso).toBe(0);
  const contribEngajamento = r.componentes.engajamento.pontuacao * r.componentes.engajamento.peso / 100;
  expect(contribEngajamento).toBe(0);
});

// ── SCORE-V1-04: faturamento máximo contribui somente 10 pts ─────────────────

test('SCORE-V1-04: faturamento com >= R$10k → pontuacao=100, contribuição máxima = 10 pts', () => {
  expect(CFG.PESOS.faturamento).toBe(10);
  const r = calcularFaturamento(mkPerfil({ faturamentoTotal: 10000 }));
  expect(r.pontuacao).toBe(100);
  expect(r.faixa).toBe('ALTO');
  // Max contribuição no score total: 100 * 10 / 100 = 10 pts
  const maxContrib = r.pontuacao * CFG.PESOS.faturamento / 100;
  expect(maxContrib).toBe(10);
});

// ── SCORE-V1-05: recência máximo 38 pts ───────────────────────────────────────

test('SCORE-V1-05: PESOS.recencia = 38 → max contribuição = 38 pts', () => {
  expect(CFG.PESOS.recencia).toBe(38);
  const r = calcularRecencia({ diasSemComprar: 1, nuncaComprou: false });
  expect(r.pontuacao).toBe(100);
  const maxContrib = r.pontuacao * CFG.PESOS.recencia / 100;
  expect(maxContrib).toBe(38);
});

// ── SCORE-V1-06: frequência/recorrência máximo 30 pts ────────────────────────

test('SCORE-V1-06: PESOS.frequencia = 30 → max contribuição = 30 pts', () => {
  expect(CFG.PESOS.frequencia).toBe(30);
  // pedidos90d >= 3 (ref) → pontuacao=100
  const r = calcularFrequencia(mkPerfil({ pedidos90d: 3 }));
  expect(r.pontuacao).toBe(100);
  const maxContrib = r.pontuacao * CFG.PESOS.frequencia / 100;
  expect(maxContrib).toBe(30);
});

// ── SCORE-V1-07: tendência máximo 15 pts ──────────────────────────────────────

test('SCORE-V1-07: PESOS.tendencia = 15 → CRESCENDO = 100 → max contribuição = 15 pts', () => {
  expect(CFG.PESOS.tendencia).toBe(15);
  const r = calcularTendenciaPontuacao('CRESCENDO');
  expect(r.pontuacao).toBe(100);
  const maxContrib = r.pontuacao * CFG.PESOS.tendencia / 100;
  expect(maxContrib).toBe(15);
});

// ── SCORE-V1-08: diversidade máximo 7 pts ────────────────────────────────────

test('SCORE-V1-08: PESOS.diversidade = 7 → max contribuição = 7 pts', () => {
  expect(CFG.PESOS.diversidade).toBe(7);
  // 4 categorias → pontuacao = min(4*25, 100) = 100
  const r = calcularDiversidade(mkPerfil({
    categoriasMaisCompradas: [
      { categoria: 'A', faturamento: 100 },
      { categoria: 'B', faturamento: 100 },
      { categoria: 'C', faturamento: 100 },
      { categoria: 'D', faturamento: 100 },
    ],
  }));
  expect(r.pontuacao).toBe(100);
  const maxContrib = r.pontuacao * CFG.PESOS.diversidade / 100;
  expect(maxContrib).toBe(7);
});

// ── SINGLE-V1-01: 1 compra → frequência SEM_BASE / pontuacao=0 ───────────────

test('SINGLE-V1-01: pedidosTotal=1, diasEntreComprasMediana=null → frequência SEM_BASE, pontuacao=0', () => {
  const r = calcularFrequencia(mkPerfil({
    pedidosTotal:            1,
    diasEntreComprasMediana: null,
    diasEntreComprasMedio:   null,
  }));
  expect(r.faixa).toBe('SEM_BASE');
  expect(r.pontuacao).toBe(0);
});

test('SINGLE-V1-01b: pedidosTotal=0, diasEntreComprasMediana=null → frequência SEM_BASE, pontuacao=0', () => {
  const r = calcularFrequencia(mkPerfil({
    nuncaComprou:            false,
    pedidosTotal:            0,
    diasEntreComprasMediana: null,
    diasEntreComprasMedio:   null,
  }));
  // pedidosTotal=0 → also caught by SEM_BASE (<=1) or NUNCA_COMPROU guard
  expect(r.pontuacao).toBe(0);
});

// ── SINGLE-V1-02: 2 datas distintas → frequência pode ser calculada ──────────

test('SINGLE-V1-02: pedidosTotal=2, diasEntreComprasMediana=25 → frequência calculável (não SEM_BASE)', () => {
  const r = calcularFrequencia(mkPerfil({
    pedidosTotal:            2,
    diasEntreComprasMediana: 25,
    diasEntreComprasMedio:   25,
    pedidos90d:              2,
  }));
  expect(r.faixa).not.toBe('SEM_BASE');
  expect(r.faixa).not.toBe('NUNCA_COMPROU');
  expect(typeof r.pontuacao).toBe('number');
});

// ── RECURRENCE-V1-01: ciclo usa MEDIANA, não média ────────────────────────────

test('RECURRENCE-V1-01: limites calculados pela MEDIANA, não pela média', () => {
  // mediana=20, media=60 (outlier inflado)
  const r = calcularRecorrencia(mkPerfil({
    diasEntreComprasMediana: 20,
    diasEntreComprasMedio:   60,
    diasSemComprar:          10,
  }));
  expect(r.padrao.medianaIntervaloDias).toBe(20);
  expect(r.padrao.limiteAlertaDias).toBe(Math.round(20 * FATOR_ALERTA));
  expect(r.padrao.limiteAtrasoDias).toBe(Math.round(20 * FATOR_ATRASO));
  // Garantia: limites NÃO baseados na média (60)
  expect(r.padrao.limiteAlertaDias).not.toBe(Math.round(60 * FATOR_ALERTA));
});

// ── RECURRENCE-V1-02: outlier não domina ciclo ───────────────────────────────

test('RECURRENCE-V1-02: outlier na média não altera ciclo de referência (mediana protege)', () => {
  // Caso extremo: mediana=15, media=200 (compra excepcional muito antiga)
  const r = calcularRecorrencia(mkPerfil({
    diasEntreComprasMediana: 15,
    diasEntreComprasMedio:   200,
    diasSemComprar:          10,
  }));
  expect(r.padrao.medianaIntervaloDias).toBe(15);
  expect(r.padrao.limiteAlertaDias).toBe(Math.round(15 * FATOR_ALERTA));  // 13d (não 170d)
  expect(r.padrao.mediaIntervaloDias).toBe(200);  // média preservada como informativo
  expect(r.status).toBe('DENTRO_DO_PADRAO');
});

// ── RECURRENCE-V1-03: mesmo dia não cria intervalo artificial ────────────────

test('RECURRENCE-V1-03: diasEntreComprasMediana=null (sem datas distintas) → SEM_BASE', () => {
  // Se todos os pedidos estão no mesmo dia, diasEntreComprasMediana=null
  const r = calcularRecorrencia(mkPerfil({
    pedidosTotal:            5,
    diasEntreComprasMediana: null,   // motor de perfil produz null para pedidos no mesmo dia
    diasEntreComprasMedio:   null,
    diasSemComprar:          30,
  }));
  expect(r.status).toBe('SEM_BASE');
  expect(r.padrao).toBeNull();
});

// ── TREND-V1-01: 1 pedido na base → SEM_BASE ─────────────────────────────────

test('TREND-V1-01: exatamente 1 pedido em todas as janelas → tendência SEM_BASE', () => {
  // ped30=1, ped30ant=0 → temBase30=false; ped90=1, ped90ant=0 → temBase90=false
  const r = calcularTendencia(mkPerfil({
    pedidos30d:   1,
    pedidos60d:   1,   // ped30ant = pedidos60d - pedidos30d = 0
    pedidos90d:   1,
    pedidos180d:  1,   // ped90ant = pedidos180d - pedidos90d = 0
    faturamento30d:  100,
    faturamento60d:  100,
    faturamento90d:  100,
    faturamento180d: 100,
  }));
  expect(r.tendencia).toBe('SEM_BASE');
  expect(r.metodo).toBe('SEM_BASE');
});

// ── TREND-V1-02: 2 pedidos → tendência pode ser classificada ─────────────────

test('TREND-V1-02: exatamente 2 pedidos em janela 30d → tendência classificável (não SEM_BASE)', () => {
  // ped30=2 >= MINIMO_PEDIDOS_PARA_BASE(2) → temBase30=true → classifica
  const r = calcularTendencia(mkPerfil({
    pedidos30d:     2,
    pedidos60d:     2,    // ped30ant=0
    faturamento30d: 1000,
    faturamento60d: 1000,
  }));
  expect(r.tendencia).not.toBe('SEM_BASE');
  expect(r.metodo).toBe('JANELA_30D_VS_30D_ANTERIOR');
});

test('TREND-V1-02b: 2 pedidos na janela anterior (30d-60d) → tendência classificável', () => {
  // ped30=0, ped30ant=2 → temBase30=true → classifica
  const r = calcularTendencia(mkPerfil({
    pedidos30d:     0,
    pedidos60d:     2,    // ped30ant=2
    faturamento30d: 0,
    faturamento60d: 1000,
  }));
  expect(r.tendencia).not.toBe('SEM_BASE');
  expect(r.metodo).toBe('JANELA_30D_VS_30D_ANTERIOR');
});

// ── NEVER-V1-01: never bought não é inativo ───────────────────────────────────

test('NEVER-V1-01: nuncaComprou=true → NÃO inativo (inativo120d=false, recência NUNCA_COMPROU)', () => {
  const perfil = mkPerfilNuncaComprou();
  expect(perfil.inativo120d).toBe(false);
  const rec = calcularRecencia(perfil);
  expect(rec.faixa).toBe('NUNCA_COMPROU');
  expect(rec.faixa).not.toBe('inativo');
  const score = calcularScore(perfil);
  expect(score.motivos).toContain('NUNCA_COMPROU');
  expect(score.motivos).not.toContain('INATIVO_120D');
});

// ── NEVER-V1-02: diasSemComprar=null para never bought ───────────────────────

test('NEVER-V1-02: nuncaComprou=true → diasSemComprar é null no perfil', () => {
  const perfil = mkPerfilNuncaComprou();
  expect(perfil.diasSemComprar).toBeNull();
  // Recorrência retorna NUNCA_COMPROU (não SEM_BASE, não INATIVO)
  const r = calcularRecorrencia(perfil);
  expect(r.status).toBe('NUNCA_COMPROU');
  expect(r.padrao).toBeNull();
  expect(r.posicaoAtual).toBeNull();
});

// ── NEVER-V1-03: ticket=null para never bought ────────────────────────────────

test('NEVER-V1-03: nuncaComprou=true → faturamentoTotal=0, faturamento pontuacao=0', () => {
  const perfil = mkPerfilNuncaComprou();
  expect(perfil.faturamentoTotal).toBe(0);
  const r = calcularFaturamento(perfil);
  expect(r.pontuacao).toBe(0);
  expect(r.faixa).toBe('NUNCA_COMPROU');
});

// ── OPP-V1-01: >= 120d + recorrência ATRASADO → somente REATIVACAO_120D ──────

test('OPP-V1-01: inativo120d=true + recorrência ATRASADO → apenas REATIVACAO_120D (sem JANELA)', () => {
  const perfilInativo = mkPerfil({
    inativo120d:             true,
    diasSemComprar:          150,
    diasEntreComprasMediana: 30,
    diasEntreComprasMedio:   30,
    categoriasMaisCompradas: [],
  });
  const score    = calcularScore(perfilInativo, 'ESTAVEL');
  const recorr   = calcularRecorrencia(perfilInativo);
  // 150d >= round(30*1.10)=33 → ATRASADO_VS_HISTORICO
  expect(recorr.status).toBe('ATRASADO_VS_HISTORICO');
  const oports = gerarOportunidades(perfilInativo, score, null, recorr, DATA_REF);
  const tipos  = oports.map(o => o.tipo);
  expect(tipos).toContain('REATIVACAO_120D');
  expect(tipos).not.toContain('JANELA_DE_RECOMPRA');  // O1: reativação absorve janela
});

// ── OPP-V1-02: < 120d + janela válida → JANELA_DE_RECOMPRA pode existir ──────

test('OPP-V1-02: inativo120d=false + recorrência PROXIMO_DA_JANELA → JANELA_DE_RECOMPRA presente', () => {
  const perfilAtivo = mkPerfil({
    inativo120d:             false,
    diasSemComprar:          20,
    diasEntreComprasMediana: 22,
    diasEntreComprasMedio:   25,
    pedidos30d:              1,
    pedidos60d:              2,
  });
  const score    = calcularScore(perfilAtivo, 'ESTAVEL');
  const recorr   = calcularRecorrencia(mkPerfil({
    diasSemComprar:          Math.round(22 * FATOR_ALERTA),  // exato no limiteAlerta → PROXIMO
    diasEntreComprasMediana: 22,
    diasEntreComprasMedio:   25,
    inativo120d:             false,
  }));
  expect(recorr.status).toBe('PROXIMO_DA_JANELA');
  const oports = gerarOportunidades(perfilAtivo, score, null, recorr, DATA_REF);
  const tipos  = oports.map(o => o.tipo);
  expect(tipos).toContain('JANELA_DE_RECOMPRA');
  expect(tipos).not.toContain('REATIVACAO_120D');
});

// ── CROSS-V1-01: cross-sell desativado → zero oportunidades CROSS_SELL ────────

test('CROSS-V1-01: CROSS_SELL_ENABLED=false → sem CROSS_SELL_CATEGORIA mesmo com 1 cat + ped>=3', () => {
  expect(CFG.CROSS_SELL_ENABLED).toBe(false);
  const perfilCross = mkPerfil({
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 5000 }],
    pedidosTotal:            10,
    inativo120d:             false,
  });
  const score  = calcularScore(perfilCross, 'ESTAVEL');
  const oports = gerarOportunidades(perfilCross, score, null, null, DATA_REF);
  const tipos  = oports.map(o => o.tipo);
  expect(tipos).not.toContain('CROSS_SELL_CATEGORIA');
});

// ── QUEUE-V1-01: never bought → FILA_PROSPECCAO ───────────────────────────────

test('QUEUE-V1-01: nuncaComprou=true → oportunidade na FILA_PROSPECCAO', () => {
  const perfil = mkPerfilNuncaComprou();
  const oports = gerarOportunidades(perfil, null, null, null, DATA_REF);
  expect(oports).toHaveLength(1);
  expect(oports[0].tipo).toBe('PROSPECT_VINCULADO');
  expect(oports[0].fila).toBe('FILA_PROSPECCAO');
});

// ── QUEUE-V1-02: comprador com oportunidade → FILA_RECOMPRA ──────────────────

test('QUEUE-V1-02: comprador ativo com JANELA_DE_RECOMPRA → fila=FILA_RECOMPRA', () => {
  const perfilAtivo = mkPerfil({
    inativo120d:             false,
    diasSemComprar:          Math.round(20 * FATOR_ALERTA),  // PROXIMO_DA_JANELA
    diasEntreComprasMediana: 20,
    diasEntreComprasMedio:   22,
  });
  const score    = calcularScore(perfilAtivo, 'ESTAVEL');
  const recorr   = calcularRecorrencia(perfilAtivo);
  const oports   = gerarOportunidades(perfilAtivo, score, null, recorr, DATA_REF);
  const janela   = oports.find(o => o.tipo === 'JANELA_DE_RECOMPRA');
  expect(janela).toBeDefined();
  expect(janela.fila).toBe('FILA_RECOMPRA');
});

test('QUEUE-V1-02b: REATIVACAO_120D → fila=FILA_RECOMPRA', () => {
  const perfilInativo = mkPerfil({ inativo120d: true, diasSemComprar: 150, categoriasMaisCompradas: [] });
  const score  = calcularScore(perfilInativo, 'CAINDO');
  const oports = gerarOportunidades(perfilInativo, score, null, null, DATA_REF);
  const reativ = oports.find(o => o.tipo === 'REATIVACAO_120D');
  expect(reativ).toBeDefined();
  expect(reativ.fila).toBe('FILA_RECOMPRA');
});

// ── FRONTIER: fronteiras exatas de recência ───────────────────────────────────

describe('FRONTIER-RECENCIA: thresholds exatos (dias sem comprar)', () => {
  const casos = [
    // [dias, faixa esperada, pontuação esperada]
    [29,  'excelente', 100],
    [30,  'excelente', 100],  // <= 30 → excelente (inclusivo)
    [31,  'bom',        75],  // > 30 e <= 60
    [59,  'bom',        75],
    [60,  'bom',        75],  // <= 60 → bom (inclusivo)
    [61,  'regular',    50],  // > 60 e <= 90
    [89,  'regular',    50],
    [90,  'regular',    50],  // <= 90 → regular (inclusivo)
    [91,  'fraco',      25],  // > 90 e < 120
    [119, 'fraco',      25],
    [120, 'inativo',     0],  // >= 120 → inativo (regra empresarial)
    [121, 'inativo',     0],
  ];

  for (const [dias, faixa, pontuacao] of casos) {
    test(`FRONTIER-RECENCIA: ${dias}d → faixa=${faixa}, pontuacao=${pontuacao}`, () => {
      const r = calcularRecencia({ diasSemComprar: dias, nuncaComprou: false });
      expect(r.faixa).toBe(faixa);
      expect(r.pontuacao).toBe(pontuacao);
    });
  }
});

// ── FRONTIER: fronteiras exatas de faturamento ────────────────────────────────

describe('FRONTIER-FATURAMENTO: tiers progressivos V1', () => {
  const casos = [
    [0,       20, 'BAIXO'],
    [999.99,  20, 'BAIXO'],
    [1000,    40, 'BAIXO_MEDIO'],
    [1999.99, 40, 'BAIXO_MEDIO'],
    [2000,    60, 'MEDIO'],
    [4999.99, 60, 'MEDIO'],
    [5000,    80, 'MEDIO_ALTO'],
    [9999.99, 80, 'MEDIO_ALTO'],
    [10000,  100, 'ALTO'],
    [99999,  100, 'ALTO'],
  ];

  for (const [fat, pontuacao, faixa] of casos) {
    test(`FRONTIER-FATURAMENTO: R$${fat} → pontuacao=${pontuacao}, faixa=${faixa}`, () => {
      const r = calcularFaturamento(mkPerfil({ faturamentoTotal: fat }));
      expect(r.pontuacao).toBe(pontuacao);
      expect(r.faixa).toBe(faixa);
    });
  }
});
