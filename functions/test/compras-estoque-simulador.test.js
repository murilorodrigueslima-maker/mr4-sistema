'use strict';
// Política 1.2 FINAL — simulador "tenho R$ X": invariantes (inteiros, ≤ orçamento, ≤ qtd 1.1, determinismo), centavos, casos de borda, 877 produtos,
// cópia idêntica do módulo na tela; faixas de margem; classificação financeira; regressão temporal (lucro histórico × margem de reposição); tamanho dos documentos.
const fs = require('fs'), path = require('path');
const Sim = require('../lib/compras/simulador');
const Rent = require('../lib/compras/rentabilidade');
const Pol = require('../lib/compras/politica');
const S = require('../lib/compras/snapshot');
const K = require('../lib/compras/canonico');
const M = require('../lib/compras/motor');
const Fx = require('./fixtures/compras-rentabilidade-fx');
const D = require('./fixtures/compras-ui-dados');
const X = Fx.X;
const PF = Pol.POLITICA_1_2.profitability, CFG = Rent.cfgSim(PF), ESTRATEGIA = PF.budget.default_strategy;

const it = (id, priority, qty, cost, price = null, velocity = 1, efficiency = null) => ({ id, priority, qty, cost_cents: cost, price_cents: price === null ? (cost === null ? null : Math.round(cost * 1.4)) : price, velocity, efficiency });
const sim = (itens, orc) => Sim.simular(itens, orc, ESTRATEGIA, CFG);
const invariantes = (itens, orc, r) => {
  expect(r.spent_cents).toBeLessThanOrEqual(orc); expect(r.spent_cents + r.left_cents).toBe(orc); expect(Number.isInteger(r.spent_cents)).toBe(true);
  const porId = new Map(itens.map(i => [i.id, i]));
  let soma = 0;
  for (const a of r.items) { const i = porId.get(a.id); expect(Number.isInteger(a.qty_1_2)).toBe(true); expect(a.qty_1_2).toBeGreaterThanOrEqual(1); expect(a.qty_1_2).toBeLessThanOrEqual(i.qty); expect(a.capital_cents).toBe(a.qty_1_2 * i.cost_cents); soma += a.capital_cents; }
  expect(soma).toBe(r.spent_cents);
};
// gerador determinístico (LCG) — nenhum Math.random
const lcg = seed => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); };
const embaralha = (l, rnd) => { const a = l.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const catalogo = (n, seed = 7) => { const r = lcg(seed); return Array.from({ length: n }, (_, k) => it('P' + String(k).padStart(4, '0'), ['P1', 'P2', 'P3', 'P4'][Math.floor(r() * 4)], 1 + Math.floor(r() * 60), 100 + Math.floor(r() * 9000), r() < 0.1 ? null : 100 + Math.floor(r() * 14000), r() * 3, r() < 0.2 ? null : Math.round(r() * 30000) / 10000)); };

describe('simulador: casos de borda e centavos', () => {
  const A = [it('A', 'P1', 10, 333, 500, 1), it('B', 'P1', 4, 101, 150, 0.5), it('C', 'P4', 50, 50, 400, 1, 9)];
  test('orçamento zero e R$ 0,01: nada comprado, nada quebra, sem NaN', () => {
    for (const orc of [0, 1]) { const r = sim(A, orc); expect(r.items).toEqual([]); expect(r.spent_cents).toBe(0); expect(r.left_cents).toBe(orc); expect(r.gross_return_on_capital).toBeNull(); expect(r.gross_margin_pct).toBeNull(); expect(JSON.stringify(r)).not.toMatch(/NaN|null,"x"/); }
  });
  test('insuficiente para UMA unidade / exatamente o custo / um centavo abaixo', () => {
    const uma = [it('U', 'P2', 5, 1000)];
    expect(sim(uma, 999).items).toEqual([]);                                           // um centavo abaixo
    const r = sim(uma, 1000); expect(r.items).toHaveLength(1); expect(r.items[0].qty_1_2).toBe(1); expect(r.spent_cents).toBe(1000); expect(r.left_cents).toBe(0);
    expect(sim(uma, 1001).items[0].qty_1_2).toBe(1); expect(sim(uma, 2000).items[0].qty_1_2).toBe(2); expect(sim(uma, 1999).items[0].qty_1_2).toBe(1);
  });
  test('centavos: custos que não dividem o orçamento; soma exata em inteiros, nunca acima', () => {
    for (const orc of [1000, 1001, 1009, 9999, 12345]) invariantes(A, orc, sim(A, orc));
    const r = sim([it('X', 'P3', 100, 333)], 1000); expect(r.items[0].qty_1_2).toBe(3); expect(r.spent_cents).toBe(999); expect(r.left_cents).toBe(1);
  });
  test('todos os P1 cobertos (piso) com orçamento folgado; capital mínimo = soma dos pisos; sem alerta', () => {
    const min = Sim.capitalMinimoP1(A, CFG); const esperado = A.filter(i => i.priority === 'P1').reduce((t, i) => t + Sim.pisoP1(i, CFG) * i.cost_cents, 0);
    expect(min.capital_cents).toBe(esperado); expect(esperado).toBeGreaterThan(0);
    const r = sim(A, min.capital_cents + 5000); expect(r.alerts).toEqual([]); expect(r.p1.floor_covered).toBe(2); expect(r.p1.floor_uncovered).toBe(0); expect(r.p1.minimum_capital_floor_cents).toBe(esperado);
  });
  test('nenhum P1 totalmente coberto: alerta P1_FLOOR_INSUFFICIENT, orçamento respeitado, P1 distribuídos deterministicamente', () => {
    const r = sim(A, 200); expect(r.alerts).toEqual(['P1_FLOOR_INSUFFICIENT']); invariantes(A, 200, r);
    expect(r.items.filter(a => a.priority === 'P1').length).toBeGreaterThan(0); expect(r.p1.floor_covered).toBeLessThan(2);   // a sobra (menor que uma unidade de P1) pode comprar item barato de outra camada
    expect(sim(A, Sim.capitalMinimoP1(A, CFG).capital_cents).alerts).toEqual([]);      // exatamente o mínimo: sem alerta
    expect(sim(A, Sim.capitalMinimoP1(A, CFG).capital_cents - 1).alerts).toEqual(['P1_FLOOR_INSUFFICIENT']);
  });
  test('P1 com margem NEGATIVA e P1 com custo LOW continuam contemplados (margem não bloqueia; o simulador não olha confiança)', () => {
    const itens = [it('NEG', 'P1', 10, 4000, 3000, 1), it('OK', 'P1', 10, 1000, 2500, 1)];
    const r = sim(itens, 1000000); expect(r.items.map(a => a.id).sort()).toEqual(['NEG', 'OK']); expect(r.items.find(a => a.id === 'NEG').qty_1_2).toBe(10);
  });
  test('P4 com margem altíssima NÃO passa na frente do piso do P1 nem de P1 pendente', () => {
    const itens = [it('P1A', 'P1', 50, 1000, 1100, 1), it('P4A', 'P4', 1000, 10, 100000, 1, 99)];
    const piso = Sim.pisoP1(itens[0], CFG) * 1000;
    const r = sim(itens, piso + 500);                                                  // só o piso do P1 e sobra que não compra nem uma unidade extra de P1
    expect(r.items.find(a => a.id === 'P1A').qty_1_2).toBe(Sim.pisoP1(itens[0], CFG));
    expect(r.items.find(a => a.id === 'P4A').qty_1_2).toBe(50);                        // a sobra (R$ 5,00) é toda do P4 (custo 10): só depois do piso
    const r2 = sim(itens, piso + 10000); expect(r2.items.find(a => a.id === 'P1A').qty_1_2).toBeGreaterThan(Sim.pisoP1(itens[0], CFG));   // P1 completa antes de P4
    expect(r2.items.some(a => a.id === 'P4A')).toBe(false);
  });
  test('empate total: desempate por id, independente da ordem de entrada', () => {
    const itens = [it('Z', 'P2', 5, 500, 700, 1, 1), it('B', 'P2', 5, 500, 700, 1, 1), it('M', 'P2', 5, 500, 700, 1, 1)];
    const r = sim(itens, 1000); expect(r.items.map(a => [a.id, a.qty_1_2])).toEqual([['B', 2]]);   // empate total: o menor id recebe o orçamento
    expect(JSON.stringify(sim(itens.slice().reverse(), 1000))).toBe(JSON.stringify(r));
  });
  test('custo indisponível: fora da simulação e listado; preço fallback entra na receita como qualquer preço de referência', () => {
    const itens = [it('SC', 'P1', 10, null), it('FB', 'P1', 10, 1000, 1500)];
    const r = sim(itens, 100000); expect(r.unbudgeted_no_cost).toEqual(['SC']); expect(r.items.map(a => a.id)).toEqual(['FB']); expect(r.revenue_potential_cents).toBe(15000);
    expect(r.p1.products_without_cost).toBe(1);
  });
  test('orçamento inválido e estratégia inválida são rejeitados (nunca NaN, nunca fração)', () => {
    for (const b of [-1, 1.5, NaN, '100', null, undefined]) expect(() => sim(A, b)).toThrow('ORCAMENTO_INVALIDO');
    expect(() => Sim.simular(A, 100, 'X', CFG)).toThrow('ESTRATEGIA_INVALIDA');
  });
});

describe('simulador: propriedades em massa (determinístico) e 877 produtos', () => {
  test('SIMULATION_ORDER_DIFF=0: 25 embaralhamentos de 877 produtos × 5 orçamentos = resultados idênticos', () => {
    const base = catalogo(877), rnd = lcg(99);
    for (const orc of [500000, 1000000, 2000000, 3000000, 5000000]) {
      const ref = JSON.stringify(sim(base, orc));
      for (let k = 0; k < 5; k++) expect(JSON.stringify(sim(embaralha(base, rnd), orc))).toBe(ref);
      expect(JSON.stringify(sim(base.slice().reverse(), orc))).toBe(ref);
    }
  });
  test('SIMULATION_OVER_BUDGET=0 e SIMULATION_OVER_POLICY_QTY=0: 300 catálogos aleatórios × orçamentos com centavos quebrados', () => {
    const rnd = lcg(2026);
    for (let n = 0; n < 300; n++) {
      const itens = catalogo(1 + Math.floor(rnd() * 120), 1000 + n), orc = Math.floor(rnd() * 4000000) + Math.floor(rnd() * 100);
      invariantes(itens, orc, sim(itens, orc));
    }
  });
  test('orçamento crescente: gasto não diminui; com orçamento ≥ compra completa, compra tudo que tem custo (= 1.1)', () => {
    const base = catalogo(877); let ant = -1;
    for (const orc of [0, 100000, 500000, 1000000, 3000000, 10 ** 9]) { const r = sim(base, orc); expect(r.spent_cents).toBeGreaterThanOrEqual(ant); ant = r.spent_cents; }
    const todo = sim(base, 10 ** 10); expect(todo.units_funded).toBe(todo.units_needed); expect(todo.spent_cents).toBe(todo.capital_needed_cents);
  });
  test('cópia na tela é IDÊNTICA ao módulo do servidor (uma só implementação)', () => {
    expect(fs.readFileSync(path.join(__dirname, '../../js/compras-simulador.js'), 'utf8')).toBe(fs.readFileSync(path.join(__dirname, '../lib/compras/simulador.js'), 'utf8'));
  });
  test('trade-off de validação: eficiência pura rende mais lucro que camadas+piso, mas deixa P1 sem verba (por isso não é a estratégia padrão)', () => {
    const base = catalogo(300, 5), orc = 400000;
    const ef = Sim.simular(base, orc, 'EFFICIENCY', CFG), piso = Sim.simular(base, orc, 'LAYERED_P1_FLOOR', CFG);
    expect(ef.gross_profit_potential_cents).toBeGreaterThanOrEqual(piso.gross_profit_potential_cents);
    expect(piso.p1.unfunded).toBeLessThanOrEqual(ef.p1.unfunded);
  });
});

describe('faixas de margem aprovadas e classificação financeira (derivada, explicável)', () => {
  const fin = (margin, conf = 'HIGH', eff = 0.5) => ({ margin: { status: margin === null ? 'UNAVAILABLE' : 'AVAILABLE' }, unit: { margin_pct: margin }, cost: { confidence: conf }, purchase: eff === null ? null : { efficiency: eff } });
  test('limites: <0 negativa · [0,24) baixa · [24,39) intermediária · ≥39 alta · indisponível', () => {
    const t = PF.thresholds; expect([t.margin_low_pct, t.margin_high_pct, t.status, t.threshold_source, t.negative_margin_auto_block]).toEqual([24, 39, 'APPROVED_FOR_RC', 'distribution_rc_2026_09', false]);
    const f = m => Rent.faixaMargem(fin(m), t);
    expect([-0.01, 0, 0.01, 23.99, 24, 38.99, 39, 60, null].map(f)).toEqual(['NEGATIVE', 'LOW', 'LOW', 'LOW', 'MID', 'MID', 'HIGH', 'HIGH', 'UNAVAILABLE']);
  });
  test('classe: ATENÇÃO antes de tudo (negativa, indisponível, custo LOW/UNKNOWN); ALTA; BAIXA; MÉDIA — sempre com motivos', () => {
    const c = (m, conf, eff) => { const f = fin(m, conf, eff); const tier = Rent.faixaMargem(f, PF.thresholds); const atr = Rent.atratividade(f, PF.thresholds); const metrica = { suggestion: { priority: 'P1', suggested_qty: 5 }, abc_units: 'A' }; f.decision = Rent.decidir(f, metrica, PF); return [tier, f.decision.class, f.decision.class_reasons, atr]; };
    expect(c(-5, 'HIGH', 0.5).slice(1, 3)).toEqual(['ATENCAO', ['MARGIN_NEGATIVE']]);
    expect(c(null, 'UNKNOWN', null)[1]).toBe('ATENCAO');
    expect(c(50, 'LOW', 2).slice(1, 3)).toEqual(['ATENCAO', ['COST_CONFIDENCE_LOW']]);           // margem alta não "limpa" custo duvidoso
    expect(c(50, 'HIGH', 2).slice(1, 3)).toEqual(['ALTA', ['MARGIN_HIGH', 'RETURN_HIGH']]);
    expect(c(50, 'HIGH', 0.05).slice(1, 3)).toEqual(['BAIXA', ['RETURN_LOW']]);                 // margem alta, mas capital rende pouco: não é "alta" (motivo explícito)
    expect(c(10, 'HIGH', 0.5).slice(1, 3)).toEqual(['BAIXA', ['MARGIN_LOW']]);
    expect(c(30, 'MEDIUM', 0.5)[1]).toBe('MEDIA');
    expect(c(30, 'HIGH', 0.05).slice(1, 3)).toEqual(['BAIXA', ['RETURN_LOW']]);
  });
  test('matriz necessidade × margem: margem baixa com necessidade = "compra necessária", nunca remove nem zera a quantidade', () => {
    const f = fin(10, 'HIGH', 0.5); const metrica = { suggestion: { priority: 'P1', suggested_qty: 5 }, abc_units: 'A' };
    expect(Rent.decidir(f, metrica, PF)).toMatchObject({ need: 'HIGH', matrix: 'BUY_NEED_FLAG_MARGIN', margin_tier: 'LOW' });
    expect(Rent.decidir(fin(60, 'HIGH', 1.5), { suggestion: { priority: 'P4', suggested_qty: 5 }, abc_units: 'C' }, PF).matrix).toBe('OBSERVE_DEMAND_COVERAGE');
    expect(Rent.decidir(fin(10, 'HIGH', 0.1), { suggestion: { priority: 'P4', suggested_qty: 5 }, abc_units: 'C' }, PF).matrix).toBe('LOW_CAPITAL_ATTRACTIVENESS');
  });
});

describe('regressão temporal: lucro HISTÓRICO (custo da época) ≠ margem de REPOSIÇÃO (custo atual)', () => {
  test('custo histórico menor, custo atual maior: lucro histórico > 0 e margem de reposição < 0 — conceitos separados', () => {
    const P = [Fx.produto('T-BASE', { estoque: 1 }), Fx.produto('T-REP', { estoque: 0, custo: '40.00', venda: '30.00' })];
    const V = [Fx.venda('2022-01-10', [['T-BASE', 1, 25, { custo: 10 }]]), ...Fx.serie('T-REP', { de: 89, passo: 5, qtd: 2, preco: 30, custo: 10 })];   // vendeu a R$30 com custo R$10 na época
    const C = [Fx.compra(X.dia(3), [['T-REP', 100, 40]], { id: 'CR-T' })];                                                                              // reposição recente a R$40
    const sn = S.montarSnapshot({ brutosProdutos: P, brutosVendas: V, brutosCompras: C, agora: X.AGORA, politica: Pol.POLITICA_1_2 });
    const f = sn.custos.find(k => k.product_id === 'T-REP').fin;
    expect(f.windows['90'].profit_cents).toBeGreaterThan(0);                                   // HISTORICAL_GROSS_PROFIT > 0 (R$30 − R$10 por unidade)
    expect(f.unit.profit_cents).toBe(3000 - 4000); expect(f.margin.negative).toBe(true);        // CURRENT_REPLACEMENT_MARGIN < 0 (R$30 − R$40)
    expect(f.margin.hints).toContain('PROFITABLE_AT_SALE_COST_COST_ROSE_SINCE'); expect(f.decision.class).toBe('ATENCAO');
    expect(f.cost.unit_cents).toBe(4000); expect(f.windows['90'].profit_base_cents).toBeDefined();
  });
});

describe('tamanho dos documentos: folga real (≤ 750 KB) com dados de revisão', () => {
  const tam = d => Buffer.byteLength(JSON.stringify(d));
  const bytesDocs = sn => ({ custos: tam(sn.view.custos), sugestoes: tam(sn.view.sugestoes), maior: Math.max(...sn.custos.map(tam), ...sn.operacional.map(tam), tam(sn.view.custos), tam(sn.view.sugestoes), tam(sn.resumo)) });
  test('catálogo de 877 produtos com 1 de cada vez flagrado como revisão: view/custos e todos os documentos < 750 KB', () => {
    const c = D.cenario(870), sn = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: D.politica });
    const b = bytesDocs(sn); expect(Object.keys(sn.view.custos.linhas).length + sn.view.custos.revisao.length).toBeGreaterThan(100);
    expect(b.custos).toBeLessThan(750000); expect(b.maior).toBeLessThan(750000); expect(b.sugestoes).toBeLessThan(750000);
  });
  test('degrau de segurança: soft limit pequeno → ficha enxuta e, se preciso, sai a revisão de "só preço cadastrado" (contagem preservada no resumo)', () => {
    const c = D.cenario(120), pol = { ...D.politica, profitability: { ...D.politica.profitability, view: { soft_limit_bytes: 20000 } } };
    const cheio = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: D.politica });
    const sn = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: pol });
    expect(sn.view.custos.detalhe_financeiro).toBe('RESUMIDO'); expect(sn.view.custos.revisao_parcial).toBe(true);
    expect(sn.view.custos.revisao.length).toBeLessThan(cheio.view.custos.revisao.length);
    expect(sn.view.custos.resumo_financeiro.review.registered_price_fallback).toBe(cheio.view.custos.resumo_financeiro.review.registered_price_fallback);
    for (const r of sn.view.custos.revisao) expect(r.fin.margin.negative === true || !(r.fin.cost.unit_cents > 0) || ['LOW', 'UNKNOWN'].includes(r.fin.cost.confidence) || (r.fin.decision.signals || []).includes('HIGH_DEMAND_LOW_MARGIN')).toBe(true);
  });
  test('nenhum campo financeiro vaza para resumo/meta/operacional/visão operacional (inclui os novos campos)', () => {
    const c = D.cenario(30), sn = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: D.politica });
    const publico = JSON.stringify([sn.resumo, sn.meta, sn.operacional, sn.view.sugestoes, sn.snapshotEstoque]);
    expect(publico).not.toMatch(/"fin"|resumo_financeiro|"revisao"|capital_cents|profit_|margin_pct|margin_tier|"class_reasons"|thresholds|threshold_source|p1_floor|"simulator"/);
  });
});
