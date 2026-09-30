'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.2 (RENTABILIDADE, RC): fórmulas, elegibilidade, confiança, decisão, orçamento, paridade
// FULL × INCREMENTAL, invariantes da Política 1.1 e proteção dos dados financeiros. Fixtures 100% sintéticas.
const fs = require('fs'), path = require('path');
const K = require('../lib/compras/canonico');
const M = require('../lib/compras/motor');
const S = require('../lib/compras/snapshot');
const Pol = require('../lib/compras/politica');
const Rent = require('../lib/compras/rentabilidade');
const Fx = require('./fixtures/compras-rentabilidade-fx');
const G = require('./fixtures/compras-gc-falso');
const X = Fx.X;

const P12 = Pol.POLITICA_1_2, PF = P12.profitability;
const AGORA = X.AGORA, HOJE = X.HOJE;
const comImportado = ids => ({ ...P12, profitability: { ...PF, cost: { ...PF.cost, imported_supplier_ids: ids } } });
function rodar(c, { politica = P12, agora = AGORA } = {}) {
  const sn = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora, politica });
  const produtos = c.produtos.map(K.mapearProduto);
  const full = Rent.calcularFinanceiro({ produtos, metricas: M.calcularTudo({ produtos, fatosVenda: c.vendas.flatMap(K.fatosDeVenda), fatosCompra: c.compras.flatMap(K.fatosDeCompra), hoje: K.dataComercial(agora), politica }).metricas, fatosVenda: c.vendas.flatMap(K.fatosDeVenda), fatosCompra: c.compras.flatMap(K.fatosDeCompra), hoje: K.dataComercial(agora), politica });
  const met = id => sn.operacional.find(m => m.product_id === id);
  return { sn, full, met, fin: id => full.porProduto.get(id), compacto: id => sn.custos.find(k => k.product_id === id).fin };
}
const cen = Fx.cenario();
const R = rodar(cen, { politica: comImportado(['IMP-1']) });

// ═══════════════════════════════════════════════ FATOS CANÔNICOS ═══════════════════════════════════════════════
describe('fatos canônicos (comprovados na API real)', () => {
  test('desconto do cabeçalho: valor OU percentual; total do item já é líquido do desconto do item', () => {
    const v = Fx.venda(X.dia(1), [['P', 2, 50, {}], ['P2', 1, 100, {}]], { descValor: 20 });
    expect(K.descontoCabecalhoVenda(v)).toBe(2000);
    const v2 = Fx.venda(X.dia(1), [['P', 2, 50, {}], ['P2', 1, 100, {}]], { descPct: 10 });
    expect(K.descontoCabecalhoVenda(v2)).toBe(2000);                             // 10 % de R$ 200
    expect(K.descontoCabecalhoVenda(Fx.venda(X.dia(1), [['P', 1, 50, {}]]))).toBe(0);
    const f = K.fatosDeVenda(Fx.venda(X.dia(1), [['P', 4, 25, { descPct: 10 }]]))[0];
    expect(f.line_total_cents).toBe(9000); expect(f.line_gross_cents).toBe(10000); // 4 × 25 = 100; 10 % de desconto no item
  });
  test('bruto da linha: só difere do total com desconto REAL (centavos de arredondamento do preço unitário não contam)', () => {
    expect(K.brutoDaLinha(10, 383, 3833)).toBe(3833);                            // 10 × 3,83 = 38,30 < 38,33: sem desconto
    expect(K.brutoDaLinha(10, 400, 3600)).toBe(4000);                            // desconto real
    expect(K.brutoDaLinha(0, 400, 3600)).toBe(3600); expect(K.brutoDaLinha(2, null, 3600)).toBe(3600);
  });
  test('custo com rateio: frete + impostos − desconto do cabeçalho, proporcional ao valor (centavos inteiros)', () => {
    expect(K.custoComRateio(1000, 100000, 10000, 5000, 3000)).toBe(1120);       // 1000 × (100000 + 10000 + 5000 − 3000) / 100000
    expect(K.custoComRateio(1000, 100000, 0, 0, 0)).toBe(1000);
    expect(K.custoComRateio(1000, null, 10000, 0, 0)).toBeNull();              // cabeçalho ausente (base antiga): nunca inventa rateio
    expect(K.custoComRateio(0, 100000, 1, 1, 1)).toBeNull();
    const f = K.fatosDeCompra(Fx.compra(X.dia(5), [['P', 100, 10]], { frete: 100, impostos: 50, desconto: 30 }))[0];
    expect(f.landed_unit_cost_cents).toBe(1120); expect(f.header_freight_cents).toBe(10000); expect(f.freight_taxes_not_allocated).toBe(true);
  });
  test('rateio do desconto do cabeçalho por linha: soma preservada (±1 centavo/linha); frete e serviços fora da receita', () => {
    const v = Fx.venda(X.dia(2), [['A', 1, 60, {}], ['B', 1, 40, {}]], { descValor: 10, frete: 15 });
    const f = K.fatosDeVenda(v); const liq = f.map(Rent.liquidoDaLinha);
    expect(liq).toEqual([5400, 3600]); expect(liq[0] + liq[1]).toBe(9000);       // 100 − 10; o frete (15) não entra
    expect(Rent.liquidoDaLinha({ line_total_cents: 0, sale_products_total_cents: 0, header_discount_cents: 0 })).toBeNull();
  });
});

// ═══════════════════════════════════════════════ PREÇO REALIZADO ═══════════════════════════════════════════════
describe('preço realizado (ponderado pela quantidade, só vendas válidas)', () => {
  const unico = (vendas, compras = [], p = {}) => { const c = { produtos: [Fx.produto('PR', { estoque: 0, custo: '10.00', venda: '25.00', ...p }), Fx.produto('BASE', { estoque: 1 })], vendas: [Fx.venda('2022-01-10', [['BASE', 1, 25, { custo: 10 }]]), ...vendas], compras: [Fx.compra(X.dia(300), [['PR', 100, 10]]), ...compras] }; return rodar(c); };
  test('22/23. ponderado por quantidade (não média simples das notas) e com centavos/arredondamento determinísticos', () => {
    const r = unico([Fx.venda(X.dia(10), [['PR', 1, 10, { custo: 6 }]]), Fx.venda(X.dia(9), [['PR', 9, 20, { custo: 6 }]])]);
    expect(r.fin('PR').price.unit_cents).toBe(1900);                             // (10 + 180) / 10 — a média simples das linhas seria 15,00
    const c = unico([Fx.venda(X.dia(10), [['PR', 3, 12.34, {}]]), Fx.venda(X.dia(9), [['PR', 2, 12.35, {}]])]);
    expect(c.fin('PR').price.unit_cents).toBe(1234);                             // (3 702 + 2 470) / 5 = 1 234,4 → 1 234
    expect(Rent.arredonda(500.5)).toBe(501); expect(Rent.arredonda(-500.5)).toBe(-501); expect(Rent.arredonda(333.33)).toBe(333);
  });
  test('8. bonificação / preço zero / desconto ≥ 100 %: fora do preço e do lucro (contadas); só bonificação → preço cadastrado marcado', () => {
    const r = unico([Fx.venda(X.dia(10), [['PR', 5, 0, {}]]), Fx.venda(X.dia(9), [['PR', 2, 25, { descPct: 100 }]]), Fx.venda(X.dia(8), [['PR', 4, 30, {}]])]);
    expect(r.fin('PR').price.unit_cents).toBe(3000); expect(r.fin('PR').price.excluded.non_positive_net).toBe(2);
    const so = unico([Fx.venda(X.dia(10), [['PR', 5, 0, {}]])]);
    expect(so.fin('PR').price).toMatchObject({ source: 'REGISTERED_FALLBACK', unit_cents: 2500, quality: 'FALLBACK' });
  });
  test('reservado, cancelada, sem baixa de estoque e data futura não são receita realizada', () => {
    const r = unico([Fx.venda(X.dia(10), [['PR', 1, 99, {}]], { situacao: 'Reservado' }), Fx.venda(X.dia(9), [['PR', 1, 98, {}]], { situacao: 'Cancelada' }), Fx.venda(X.dia(8), [['PR', 1, 97, {}]], { situacao: 'Em aberto', situacao_estoque: '0' }), Fx.venda('2026-10-05', [['PR', 1, 96, {}]]), Fx.venda(X.dia(7), [['PR', 2, 40, {}]])]);
    expect(r.fin('PR').price).toMatchObject({ unit_cents: 4000, lines: 1, qty: 2 });
    expect(r.fin('PR').price.excluded.not_completed).toBe(1);
  });
  test('9. desconto grande: preço líquido e desconto médio refletem item + cabeçalho', () => {
    const r = unico([Fx.venda(X.dia(10), [['PR', 10, 100, { descPct: 20 }]], { descPct: 10 })]);
    expect(r.fin('PR').price.unit_cents).toBe(7200);                             // 100 → 80 (item) → 72 (cabeçalho)
    expect(r.fin('PR').price.discount_bps).toBe(2800);                           // 28 % sobre o bruto de tabela
  });
  test('25. outlier: fora de [0,5×, 2×] da mediana com ≥ 5 linhas é excluído (contado); com < 5 linhas nada é excluído', () => {
    const normais = [10, 9, 8, 7, 6].map(d => Fx.venda(X.dia(d), [['PR', 1, 30, {}]]));
    const r = unico([...normais, Fx.venda(X.dia(5), [['PR', 1, 10, {}]])]);
    expect(r.fin('PR').price.unit_cents).toBe(3000); expect(r.fin('PR').price.excluded.outlier).toBe(1);
    const poucas = unico([...normais.slice(0, 3), Fx.venda(X.dia(5), [['PR', 1, 10, {}]])]);
    expect(poucas.fin('PR').price.excluded).toBeUndefined === undefined; expect(poucas.fin('PR').price.lines).toBe(4); expect(poucas.fin('PR').price.unit_cents).toBe(2500);   // (3×30 + 10) / 4
  });
  test('janelas 30/60/90 separadas e qualidade do preço (forte ≥ 3 linhas em ≥ 2 dias)', () => {
    const r = unico([Fx.venda(X.dia(80), [['PR', 1, 20, { custo: 10 }]]), Fx.venda(X.dia(50), [['PR', 1, 30, { custo: 10 }]]), Fx.venda(X.dia(10), [['PR', 1, 40, { custo: 10 }]])]);
    const w = r.fin('PR').windows;
    expect([w[30].price_cents, w[60].price_cents, w[90].price_cents]).toEqual([4000, 3500, 3000]);
    expect(r.fin('PR').price.quality).toBe('STRONG');
    expect(unico([Fx.venda(X.dia(10), [['PR', 1, 40, {}]])]).fin('PR').price.quality).toBe('WEAK');
  });
});

// ═══════════════════════════════════════════════ CUSTO E CONFIANÇA ═══════════════════════════════════════════════
describe('custo: referência (última compra com rateio) e confiança objetiva', () => {
  const comCusto = (cadastrado, compras, p = P12) => {
    const c = { produtos: [Fx.produto('PC', { estoque: 0, custo: cadastrado, venda: '30.00' }), Fx.produto('BASE', { estoque: 1 })], vendas: [Fx.venda('2022-01-10', [['BASE', 1, 25, { custo: 10 }]])], compras: [Fx.compra(X.dia(300), [['BASE', 5, 10]]), ...compras] };
    return rodar(c, { politica: p }).fin('PC').cost;
  };
  const compraRateada = (dias, o = {}) => Fx.compra(X.dia(dias), [['PC', 100, 10]], { frete: 100, impostos: 50, desconto: 30, ...o });   // landed 11,20
  test('HIGH: bate com o custo com rateio da última compra confirmada (≤ 0,5 %) e compra recente', () => {
    expect(comCusto('11.20', [compraRateada(30)])).toMatchObject({ confidence: 'HIGH', reason: 'MATCHES_LAST_PURCHASE_LANDED', reference_cents: 1120, divergence_bps: 0 });
    expect(comCusto('11.25', [compraRateada(30)])).toMatchObject({ confidence: 'HIGH' });      // 0,45 %
  });
  test('MEDIUM: divergência pequena (≤ 2 %) ou bate porém a compra é mais antiga que o limite', () => {
    expect(comCusto('11.30', [compraRateada(30)])).toMatchObject({ confidence: 'MEDIUM', reason: 'SMALL_DIVERGENCE_FROM_LAST_PURCHASE_LANDED' });
    expect(comCusto('11.20', [compraRateada(400)])).toMatchObject({ confidence: 'MEDIUM', reason: 'MATCHES_OLD_PURCHASE_LANDED', reference_age_days: 400 });
  });
  test('LOW: divergência grande; sem compra de referência; cabeçalho da compra ausente (base antiga)', () => {
    expect(comCusto('14.00', [compraRateada(30)])).toMatchObject({ confidence: 'LOW', reason: 'LARGE_DIVERGENCE_FROM_LAST_PURCHASE_LANDED' });
    expect(comCusto('10.00', [])).toMatchObject({ confidence: 'LOW', reason: 'NO_PURCHASE_REFERENCE' });
    const v1 = S.decodificarCompra(['CV1', X.dia(30), 'Confirmada', 'FX-1', X.dia(30) + ' 09:00:00', 1, [['PC', 100, '10.00']]]);   // tupla v1: sem valores do cabeçalho
    expect(v1.valor_produtos).toBeNull();
    expect(comCusto('11.20', [v1])).toMatchObject({ confidence: 'LOW', reason: 'PURCHASE_HEADER_DATA_MISSING' });
  });
  test('UNKNOWN: custo ausente ou zero — nunca se calcula margem com ele', () => {
    expect(comCusto('', [compraRateada(30)])).toMatchObject({ confidence: 'UNKNOWN', reason: 'COST_MISSING' });
    expect(comCusto('0.00', [compraRateada(30)])).toMatchObject({ confidence: 'UNKNOWN', reason: 'COST_ZERO' });
  });
  test('24. importado: fornecedor da última compra marcado → LOW (componentes do custo não provados), mesmo batendo com a compra', () => {
    expect(comCusto('11.20', [compraRateada(30, { fornecedor_id: 'IMP-9' })], comImportado(['IMP-9']))).toMatchObject({ confidence: 'LOW', reason: 'IMPORTED_COMPONENTS_UNPROVEN', reference_cents: 1120 });
    expect(comCusto('11.20', [compraRateada(30, { fornecedor_id: 'IMP-9' })])).toMatchObject({ confidence: 'HIGH' });   // lista vazia por padrão: nada é marcado sozinho
    expect(R.fin('RB-IMPORTADO').cost).toMatchObject({ confidence: 'LOW', reason: 'IMPORTED_COMPONENTS_UNPROVEN' });
  });
  test('última compra é a mais recente por data (empate: maior id); compra cancelada/pendente não é referência', () => {
    const nova = compraRateada(10, { id: 'CR-NOVA' }), velha = Fx.compra(X.dia(60), [['PC', 100, 8]], { id: 'CR-VELHA' });
    expect(comCusto('11.20', [velha, nova]).reference_cents).toBe(1120);
    expect(comCusto('11.20', [velha, compraRateada(5, { situacao: 'Cancelada' }), compraRateada(3, { situacao: 'A receber' })]).reference_cents).toBe(800);
  });
});

// ═══════════════════════════════════════════════ MARGEM E RENTABILIDADE ═══════════════════════════════════════════════
describe('margem, markup, lucro e capital (centavos inteiros)', () => {
  test('1–4. alta/baixa/negativa/baixa-demanda: fórmulas e faixas', () => {
    const a = R.fin('RB-A-ALTA'), b = R.fin('RB-A-BAIXA'), n = R.fin('RB-A-NEG'), c = R.fin('RB-C-ALTA');
    expect(a.unit).toMatchObject({ profit_cents: 2000, margin_pct: 66.67, markup: 3 });
    expect(b.unit).toMatchObject({ profit_cents: 500, margin_pct: 16.67, markup: 1.2 });
    expect(n.unit).toMatchObject({ profit_cents: -1000, margin_pct: -33.33 }); expect(n.margin.negative).toBe(true);
    expect(c.unit.margin_pct).toBe(66.67);
    expect([a, b, n, c].map(f => f.decision.margin_tier)).toEqual(['HIGH', 'LOW', 'NEGATIVE', 'HIGH']);
    for (const f of [a, b, n, c]) for (const v of [f.unit.profit_cents, f.cost.unit_cents, f.price.unit_cents]) expect(Number.isInteger(v)).toBe(true);
  });
  test('10. custo maior que o preço: margem negativa com dicas que separam causas (nunca bloqueia)', () => {
    expect(R.fin('RB-A-NEG').margin.hints).toEqual(['SOLD_BELOW_COST']);          // já vendia abaixo do custo da época
    const r = rodar({ produtos: [Fx.produto('NG', { estoque: 0, custo: '40.00', venda: '30.00' }), Fx.produto('BASE', { estoque: 1 })], vendas: [Fx.venda('2022-01-10', [['BASE', 1, 25, { custo: 10 }]]), ...Fx.serie('NG', { de: 89, passo: 3, qtd: 2, preco: 30, custo: 25 })], compras: [Fx.compra(X.dia(300), [['NG', 10, 25]])] });
    expect(r.fin('NG').margin.hints).toEqual(expect.arrayContaining(['COST_MAY_BE_WRONG_OR_STALE', 'PROFITABLE_AT_SALE_COST_COST_ROSE_SINCE']));
    expect(r.met('NG').suggestion.suggested_qty).toBeGreaterThan(0);              // compra NÃO é bloqueada
    const fb = rodar({ produtos: [Fx.produto('FB', { estoque: 3, custo: '40.00', venda: '30.00' }), Fx.produto('BASE', { estoque: 1 })], vendas: [Fx.venda('2022-01-10', [['BASE', 1, 25, { custo: 10 }]])], compras: [Fx.compra(X.dia(300), [['FB', 10, 40]])] });
    expect(fb.fin('FB').margin.hints).toContain('REGISTERED_PRICE_BELOW_COST');
  });
  test('5/6. sem custo e custo zero: margem INDISPONÍVEL com o motivo; continuam sugeridos pela Política 1.1', () => {
    for (const id of ['RB-SEMCUSTO', 'RB-CUSTOZERO']) {
      const f = R.fin(id);
      expect(f.margin).toMatchObject({ status: 'UNAVAILABLE', confidence: 'UNAVAILABLE' }); expect(f.unit.margin_pct).toBeNull();
      expect(f.purchase.capital_cents).toBeNull(); expect(f.purchase.profit_potential_cents).toBeNull();
      expect(R.met(id).suggestion.suggested_qty).toBeGreaterThan(0);
      expect(f.decision.signals).toContain('MISSING_COST');
    }
    expect(R.fin('RB-SEMCUSTO').margin.reason).toBe('COST_MISSING'); expect(R.fin('RB-CUSTOZERO').margin.reason).toBe('COST_ZERO');
  });
  test('7. sem venda na janela: preço cadastrado SÓ como fallback marcado; confiança da margem não passa de LOW', () => {
    const f = R.fin('RB-SEMVENDA');
    expect(f.price).toMatchObject({ source: 'REGISTERED_FALLBACK', unit_cents: 2500, quality: 'FALLBACK' });
    expect(f.margin).toMatchObject({ status: 'AVAILABLE', confidence: 'LOW' });
  });
  test('confiança da margem = mínimo entre custo e qualidade do preço', () => {
    expect(R.fin('RB-A-ALTA').margin.confidence).toBe('HIGH');                    // custo HIGH + preço STRONG
    expect(R.fin('RB-IMPORTADO').margin.confidence).toBe('LOW');                   // custo LOW (importado) + preço STRONG
    expect(R.fin('RB-C-ALTA').price.quality).toBe('STRONG');
  });
  test('lucro bruto 30/60/90 a custo DA ÉPOCA (custo gravado na venda), com cobertura; linha sem custo da época não entra no lucro', () => {
    const r = rodar({ produtos: [Fx.produto('LH', { estoque: 0, custo: '20.00', venda: '50.00' }), Fx.produto('BASE', { estoque: 1 })], vendas: [Fx.venda('2022-01-10', [['BASE', 1, 25, { custo: 10 }]]), Fx.venda(X.dia(20), [['LH', 2, 50, { custo: 15 }]]), Fx.venda(X.dia(10), [['LH', 1, 50, { custo: null }]])], compras: [Fx.compra(X.dia(300), [['LH', 10, 20]])] });
    const w = r.fin('LH').windows[30];
    expect(w).toMatchObject({ qty: 3, revenue_cents: 15000, profit_cents: 7000, profit_base_cents: 10000 });   // só a venda com custo da época: 100 − 2 × 15 = 70
    expect(w.cost_coverage_bps).toBe(6667);
  });
  test('margem agregada é lucro total ÷ receita total (não média de percentuais); resumo em centavos', () => {
    const res = R.sn.view.custos.resumo_financeiro.purchase;
    const fins = ['RB-A-ALTA', 'RB-A-BAIXA', 'RB-A-NEG', 'RB-C-ALTA', 'RB-IMPORTADO'].map(id => R.fin(id).purchase);
    const cap = fins.reduce((t, p) => t + p.capital_cents, 0), rec = fins.reduce((t, p) => t + p.revenue_potential_cents, 0);
    expect(res).toMatchObject({ capital_cents: cap, revenue_potential_cents: rec, gross_profit_potential_cents: rec - cap, weighted_margin_pct: Math.round((rec - cap) / rec * 10000) / 100, priced_products: 5, unpriced_products: 2, complete: false });
    const media = fins.map(p => p.profit_potential_cents / p.revenue_potential_cents * 100).reduce((t, x) => t + x, 0) / fins.length;
    expect(Math.abs(media - res.weighted_margin_pct)).toBeGreaterThan(1);       // a média simples dos percentuais seria outra coisa
    const d = Rent.distribuicao([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], [0.1, 0.25, 0.5, 0.75, 0.9], PF.scale.pct_divisor);
    expect(d).toEqual({ n: 10, p10: 10, p25: 30, p50: 50, p75: 80, p90: 90 });  // posto mais próximo, sem interpolação
  });
});

// ═══════════════════════════════════════════════ COMPRA: CAPITAL, RETORNO, EFICIÊNCIA ═══════════════════════════════════════════════
describe('economia da compra sugerida', () => {
  test('capital, receita potencial, lucro potencial e retorno (estimativas)', () => {
    const p = R.fin('RB-A-ALTA').purchase;
    expect(p).toMatchObject({ qty: 60, capital_cents: 60000, revenue_potential_cents: 180000, profit_potential_cents: 120000, return_on_capital: 2 });
    const n = R.fin('RB-A-NEG').purchase; expect(n.profit_potential_cents).toBe(-60000); expect(n.return_on_capital).toBe(-0.25);
  });
  test('eficiência do capital = retorno × 30 ÷ dias de giro da compra (qtd ÷ velocidade)', () => {
    const p = R.fin('RB-A-ALTA').purchase, v = R.met('RB-A-ALTA').policy_velocity;
    expect(p.turnover_days).toBe(Math.round(60 / v * 10000) / 10000);
    expect(p.efficiency).toBe(Math.round(p.return_on_capital * 30 / p.turnover_days * 10000) / 10000);
    const c = R.fin('RB-C-ALTA').purchase, vc = R.met('RB-C-ALTA').policy_velocity;   // item lento: 1 un (mínimo da CEIL) ÷ velocidade
    expect(c.turnover_days).toBe(Math.round(1 / vc * 10000) / 10000); expect(c.efficiency).toBe(Math.round(c.return_on_capital * 30 / c.turnover_days * 10000) / 10000);
  });
  test('produto sem sugestão não tem bloco de compra', () => { expect(R.fin('RB-SEMVENDA').purchase).toBeNull(); });
});

// ═══════════════════════════════════════════════ DECISÃO: NECESSIDADE × RENTABILIDADE ═══════════════════════════════════════════════
describe('matriz de decisão e sinais (explicativos; não mudam quantidade)', () => {
  test('1/2/3/4/13/14. combinações de necessidade e margem', () => {
    const d = id => R.fin(id).decision;
    expect(d('RB-A-ALTA')).toMatchObject({ need: 'HIGH', margin_tier: 'HIGH', matrix: 'BUY_STRONG' }); expect(d('RB-A-ALTA').signals).toContain('HIGH_DEMAND_HIGH_MARGIN');
    expect(d('RB-A-BAIXA')).toMatchObject({ need: 'HIGH', margin_tier: 'LOW', matrix: 'BUY_NEED_FLAG_MARGIN' }); expect(d('RB-A-BAIXA').signals).toContain('HIGH_DEMAND_LOW_MARGIN');
    expect(d('RB-A-NEG')).toMatchObject({ margin_tier: 'NEGATIVE', matrix: 'BUY_NEED_FLAG_MARGIN', attractiveness: 'NEGATIVE' }); expect(d('RB-A-NEG').signals).toEqual(expect.arrayContaining(['NEGATIVE_MARGIN', 'HIGH_DEMAND_LOW_MARGIN']));
    // baixa necessidade (P4) + alta margem: NÃO sobe de prioridade — apenas "observar demanda/cobertura"
    expect(R.met('RB-C-ALTA').suggestion.priority).toBe('P4'); expect(d('RB-C-ALTA')).toMatchObject({ need: 'LOW', matrix: 'OBSERVE_DEMAND_COVERAGE' }); expect(d('RB-C-ALTA').signals).toContain('LOW_DEMAND_HIGH_MARGIN');
    // P1 com margem baixa continua P1 e com a MESMA quantidade
    expect(R.met('RB-A-BAIXA').suggestion.priority).toBe('P1');
    expect(d('RB-SEMCUSTO')).toMatchObject({ margin_tier: 'UNAVAILABLE', matrix: 'BUY_NEED_MARGIN_UNKNOWN' });
    expect(d('RB-IMPORTADO').signals).toContain('LOW_COST_CONFIDENCE');
  });
  test('INVARIANTE 1.1: decisão de compra idêntica com a Política 1.2 (SUGGESTION_ENGINE_DIFF=0) em todos os cenários sintéticos', () => {
    const chave = m => JSON.stringify([m.purchase_eligible, m.purchase_exclusions, m.suggestion.suggested_qty, m.suggestion.priority, m.policy_velocity, m.coverage, m.abc_revenue, m.abc_units, m.new_product_proven_demand, m.reason_codes, m.suggestion.target_days, m.scenarios]);
    for (const c of [cen, X.cenario(), X.cenarioProdutoNovo()]) {
      const a = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: AGORA, politica: Pol.POLITICA_1_1 });
      const b = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: AGORA, politica: P12 });
      expect(b.operacional.map(chave)).toEqual(a.operacional.map(chave));
      const sv = v => JSON.stringify(v, (k, x) => (k === 'policy_version' || k === 'politica' ? undefined : x));
      expect(sv(b.view.sugestoes)).toBe(sv(a.view.sugestoes)); expect(sv(b.resumo)).toBe(sv(a.resumo)); expect(sv(b.meta)).toBe(sv(a.meta));
    }
  });
  test('Política 1.1 intocada e continua vigente; 1.2 é candidata, herda a 1.1 e valida', () => {
    expect(Pol.POLITICA_VIGENTE.policy_version).toBe('1.1'); expect(Pol.POLITICA_1_1.profitability).toBeUndefined();
    expect(Pol.POLITICA_1_2).toMatchObject({ policy_version: '1.2', inherits_from: '1.1', status: 'RELEASE_CANDIDATE_NOT_APPROVED', approved_on: null });
    for (const k of ['target_days', 'abc', 'demand', 'velocity', 'new_product', 'coverage_indicators', 'rounding', 'priority']) expect(Pol.POLITICA_1_2[k]).toEqual(Pol.POLITICA_1_1[k]);
    expect(Pol.validarPolitica(Pol.POLITICA_1_2)).toEqual([]);
    expect(PF.thresholds.status).toBe('PROPOSED_NOT_APPROVED');
    const ruim = JSON.parse(JSON.stringify(Pol.POLITICA_1_2)); ruim.profitability.cost.tolerance_high = 0.5;
    expect(Pol.validarPolitica(ruim).join()).toMatch(/tolerâncias fora de ordem/);
  });
  test('sem o bloco de rentabilidade (Política 1.1) nenhum documento ganha campo financeiro', () => {
    const b = S.montarSnapshot({ brutosProdutos: cen.produtos, brutosVendas: cen.vendas, brutosCompras: cen.compras, agora: AGORA, politica: Pol.POLITICA_1_1 });
    expect(JSON.stringify(b.custos)).not.toMatch(/"fin"/); expect(b.view.custos.resumo_financeiro).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════ SIMULADOR DE ORÇAMENTO ═══════════════════════════════════════════════
describe('simulador de orçamento (local, determinístico, inteiros, qtd_1_2 ≤ qtd_1_1)', () => {
  const itens = () => Rent.itensParaSimulador(R.full.porProduto, R.sn.operacional);
  const total = Rent.simularOrcamento(itens(), 10 ** 9, 'OPERATIONAL', PF).capital_needed_cents;
  test('16. orçamento suficiente: todas as quantidades da 1.1 são atendidas (itens com custo)', () => {
    for (const e of PF.budget.strategies) { const r = Rent.simularOrcamento(itens(), 10 ** 9, e, PF); expect(r.items.every(i => i.qty_1_2 === i.qty_1_1)).toBe(true); expect(r.spent_cents).toBe(total); expect(r.unbudgeted_no_cost.sort()).toEqual(['RB-CUSTOZERO', 'RB-SEMCUSTO']); }
  });
  test('15/17/18. orçamento insuficiente: inteiros, nunca acima do orçamento nem da sugestão, determinístico e independente da ordem de entrada', () => {
    for (const orc of [0, 999, 10000, 123456, 300000, total - 1]) for (const e of PF.budget.strategies) {
      const r = Rent.simularOrcamento(itens(), orc, e, PF);
      expect(r.spent_cents).toBeLessThanOrEqual(orc); expect(r.spent_cents + r.left_cents).toBe(orc);
      for (const i of r.items) { expect(Number.isInteger(i.qty_1_2)).toBe(true); expect(i.qty_1_2).toBeGreaterThanOrEqual(1); expect(i.qty_1_2).toBeLessThanOrEqual(i.qty_1_1); }
      const invertido = Rent.simularOrcamento(itens().reverse(), orc, e, PF); expect(JSON.stringify(invertido)).toBe(JSON.stringify(r));
    }
    expect(() => Rent.simularOrcamento(itens(), 100.5, 'LAYERED', PF)).toThrow('ORCAMENTO_INVALIDO');
    expect(() => Rent.simularOrcamento(itens(), 100, 'X', PF)).toThrow('ESTRATEGIA_INVALIDA');
  });
  test('13. P1 protegido: só-eficiência deixa P1 sem verba; camadas com piso garante todo P1 antes de otimizar', () => {
    const base = [
      { id: 'p1-critico-a', qty: 100, priority: 'P1', velocity: 2, cost_cents: 1000, price_cents: 1200, efficiency: 0.2 },
      { id: 'p1-critico-b', qty: 100, priority: 'P1', velocity: 2, cost_cents: 1000, price_cents: 1200, efficiency: 0.25 },
      { id: 'p4-lucrativo', qty: 100, priority: 'P4', velocity: 2, cost_cents: 1000, price_cents: 3000, efficiency: 5 },
    ];
    const orc = 100000;                                                            // exatamente as 100 unidades do P4 (R$ 10 cada)
    const ef = Rent.simularOrcamento(base, orc, 'EFFICIENCY', PF), piso = Rent.simularOrcamento(base, orc, 'LAYERED_P1_FLOOR', PF);
    expect(ef.by_priority.P1.products_unfunded).toBe(2);                           // a ganância por retorno abandona os dois P1
    expect(piso.by_priority.P1.products_unfunded).toBe(0);                         // todo P1 recebe ao menos o piso (7 dias × 2 un/dia = 14 un)
    expect(piso.items.filter(i => i.priority === 'P1').every(i => i.qty_1_2 >= 14)).toBe(true);
    expect(piso.items.find(i => i.priority === 'P4')).toBeUndefined();             // e nada do P4 enquanto o P1 não está completo
  });
  test('camadas: mantém a ordem operacional e otimiza por eficiência DENTRO de cada prioridade', () => {
    const it = [{ id: 'a', qty: 10, priority: 'P2', velocity: 1, cost_cents: 100, price_cents: 110, efficiency: 0.1 }, { id: 'b', qty: 10, priority: 'P2', velocity: 1, cost_cents: 100, price_cents: 200, efficiency: 0.9 }, { id: 'c', qty: 10, priority: 'P3', velocity: 1, cost_cents: 100, price_cents: 900, efficiency: 9 }];
    const r = Rent.simularOrcamento(it, 1500, 'LAYERED', PF);
    expect(r.items.map(i => [i.id, i.qty_1_2])).toEqual([['b', 10], ['a', 5]]);  // b (mais eficiente) antes de a; c (P3) só depois de todo o P2
  });
});

// ═══════════════════════════════════════════════ FULL × INCREMENTAL ═══════════════════════════════════════════════
describe('paridade FULL × INCREMENTAL (mesmas fontes)', () => {
  const agora2 = new Date(AGORA.getTime() + 3 * 3600e3);
  async function fullEIncremental(fonte, fonteNova = fonte) {
    const db = G.criarDbFalso();
    await S.executarSync({ cli: G.criarGcFalso(fonte).cli, db, agora: AGORA, politica: P12 });
    const f1 = G.financeiroPersistido(db);
    const inc = await S.executarSyncIncremental({ cli: G.criarGcFalso(fonteNova).cli, db, agora: agora2, politica: P12 });
    expect(inc.ok).toBe(true);
    return { f1, f2: G.financeiroPersistido(db), db };
  }
  async function fullDireto(fonte) { const db = G.criarDbFalso(); const r = await S.executarSync({ cli: G.criarGcFalso(fonte).cli, db, agora: agora2, politica: P12 }); expect(r.ok).toBe(true); return G.financeiroPersistido(db); }
  const detalhe = (p, id) => p.blocos.flatMap(b => b.produtos).find(x => x.product_id === id).fin;   // a lista é enxuta: o detalhe completo vem do bloco de custos
  const soFin = p => JSON.stringify({ b: p.blocos.map(b => b.produtos.map(x => [x.product_id, x.fin])), v: p.view_custos.linhas, r: p.view_custos.resumo_financeiro });
  test('21. sem mudança na fonte: documentos financeiros idênticos (incremental = FULL)', async () => {
    const { f1, f2 } = await fullEIncremental(cen);
    expect(soFin(f2)).toBe(soFin(f1)); expect(JSON.stringify(f2.view_sugestoes)).toBe(JSON.stringify(f1.view_sugestoes));
  });
  test('base v2 ida e volta: a base carregada reproduz exatamente os fatos financeiros do registro completo', async () => {
    const db = G.criarDbFalso(); await S.executarSync({ cli: G.criarGcFalso(cen).cli, db, agora: AGORA, politica: P12 });
    const base = await S.carregarBase(db);
    const chave = l => JSON.stringify(l.map(f => [f.sale_id, f.line, f.product_id, f.qty, f.line_total_cents, f.line_gross_cents, f.unit_cost_snapshot_cents, f.sale_products_total_cents, f.header_discount_cents, f.demand_source_status]).sort());   // ordem da base = ordem de leitura da API
    expect(chave(base.vendas.flatMap(K.fatosDeVenda))).toBe(chave(cen.vendas.flatMap(K.fatosDeVenda)));
    const lc = l => JSON.stringify(l.map(f => [f.purchase_id, f.product_id, f.unit_cost_cents, f.landed_unit_cost_cents, f.supplier_id, f.status]).sort());
    expect(lc(base.compras.flatMap(K.fatosDeCompra))).toBe(lc(cen.compras.flatMap(K.fatosDeCompra)));
  });
  test('11. custo alterado no cadastro do produto: o incremental relê os produtos e recalcula margem e confiança', async () => {
    const nova = { ...cen, produtos: cen.produtos.map(p => (p.id === 'RB-A-ALTA' ? { ...p, valor_custo: '12.00' } : p)) };
    const { f1, f2 } = await fullEIncremental(cen, nova);
    const antes = f1.view_custos.linhas['RB-A-ALTA'].fin, depois = f2.view_custos.linhas['RB-A-ALTA'].fin;
    expect(antes.unit.profit_cents).toBe(2000); expect(depois.unit.profit_cents).toBe(1800);
    expect(depois.cost).toMatchObject({ unit_cents: 1200, confidence: 'LOW', reason: 'LARGE_DIVERGENCE_FROM_LAST_PURCHASE_LANDED' }); expect(detalhe(f2, 'RB-A-ALTA').cost.divergence_bps).toBe(2000);
    expect(soFin(f2)).toBe(soFin(await fullDireto(nova)));                         // e o resultado é o de um FULL sobre a fonte alterada
  });
  test('11b. custo alterado + compra nova dentro da janela de 90 dias: referência e confiança acompanham', async () => {
    const nova = { ...cen, produtos: cen.produtos.map(p => (p.id === 'RB-A-ALTA' ? { ...p, valor_custo: '12.00' } : p)), compras: [...cen.compras, Fx.compra(X.dia(1), [['RB-A-ALTA', 50, 12]], { id: 'CR-REPOSICAO' })] };
    const { f2 } = await fullEIncremental(cen, nova);
    expect(f2.view_custos.linhas['RB-A-ALTA'].fin.cost).toMatchObject({ confidence: 'HIGH' }); expect(detalhe(f2, 'RB-A-ALTA').cost.reference_cents).toBe(1200);
    expect(soFin(f2)).toBe(soFin(await fullDireto(nova)));
  });
  test('12. venda alterada (mais nova pelo modificado_em): o preço realizado é substituído, sem duplicar', async () => {
    const alvo = cen.vendas.find(v => v.produtos[0].produto.produto_id === 'RB-A-ALTA' && v.data === X.dia(1));
    const alterada = { ...alvo, modificado_em: X.dia(0) + ' 08:00:00', produtos: [{ produto: { ...alvo.produtos[0].produto, valor_total: '0.00', valor_venda: '0.00' } }], valor_produtos: '0.00', valor_total: '0.00' };
    const nova = { ...cen, vendas: cen.vendas.map(v => (v.id === alvo.id ? alterada : v)) };
    const { f1, f2 } = await fullEIncremental(cen, nova);
    expect(detalhe(f2, 'RB-A-ALTA').price.lines).toBe(detalhe(f1, 'RB-A-ALTA').price.lines - 1);   // a venda virou bonificação (líquido 0) e saiu do preço
    expect(soFin(f2)).toBe(soFin(await fullDireto(nova)));
  });
});

// ═══════════════════════════════════════════════ PERSISTÊNCIA, TAMANHO E PERMISSÃO ═══════════════════════════════════════════════
describe('dados financeiros: só nos documentos protegidos; tamanho sob controle', () => {
  const CHAVES_FINANCEIRAS = /^(?!abc_margin$)(margin|markup|profit|capital|revenue|efficiency|return_on|gmroi|profitability|fin$)|_margin_|margin_(low|high)|imported_supplier/;   // minúsculas (snake_case): REVENUE_A_UNITS_C é divergência ABC já existente; abc_margin = marcador antigo 'BLOCKED'
  const chaves = (v, acc = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) acc.push(k); chaves(x, acc); } return acc; };
  test('19. NENHUM campo financeiro em resumo, meta, blocos operacionais, visão operacional e snapshot de estoque (perfil "estoque" lê esses)', () => {
    const sn = R.sn;
    for (const [nome, doc] of [['resumo', sn.resumo], ['meta', sn.meta], ['operacional', sn.operacional], ['view.sugestoes', sn.view.sugestoes], ['snapshotEstoque', sn.snapshotEstoque]]) {
      expect([nome, chaves(doc).filter(k => CHAVES_FINANCEIRAS.test(k) || k === 'fin')]).toEqual([nome, []]);
    }
    expect(JSON.stringify(sn.base)).not.toMatch(/"fin"/);
  });
  test('o financeiro vai SÓ para compras_n0_custos/* e compras_n0_view/custos (mesmas Rules de custo: gestor com módulo estoque)', async () => {
    const db = G.criarDbFalso(); await S.persistirSnapshot(db, R.sn);
    const comFin = []; for (const col of Object.keys(db.st)) for (const id of Object.keys(db.st[col])) if (col !== 'compras_n0_base' && /"fin"|resumo_financeiro/.test(db.st[col][id])) comFin.push(col + '/' + id);
    expect(comFin.every(x => x.startsWith('compras_n0_custos/') || x === 'compras_n0_view/custos')).toBe(true); expect(comFin).toContain('compras_n0_view/custos'); expect(comFin).toContain('compras_n0_custos/bloco_000');
  });
  test('nenhum array aninhado nos documentos com financeiro (Firestore); números finitos; sem NaN', () => {
    expect(S.temArrayAninhado(R.sn.view.custos)).toBe(false); for (const k of R.sn.custos) expect(S.temArrayAninhado(k)).toBe(false);
    const visita = v => { if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true); else if (v && typeof v === 'object') Object.values(v).forEach(visita); };
    visita(R.sn.custos); visita(R.sn.view.custos);
  });
  test('20. documento perto do limite: a guarda de 900 KB aborta ANTES de gravar qualquer coisa', async () => {
    const db = G.criarDbFalso(); const sn = S.montarSnapshot({ brutosProdutos: cen.produtos, brutosVendas: cen.vendas, brutosCompras: cen.compras, agora: AGORA, politica: P12 });
    sn.custos[0].fin.observacao = 'x'.repeat(S.DOC_BYTES_MAX);
    await expect(S.persistirSnapshot(db, sn)).rejects.toThrow(/DOC_GRANDE_DEMAIS compras_n0_custos\/bloco_000/); expect(db.st).toEqual({});
  });
  test('em escala real (877 produtos, 150 por bloco) o bloco de custos e a visão ficam folgados frente ao limite de 1 MiB', () => {
    const ps = Array.from({ length: 877 }, (_, i) => Fx.produto('E-' + i, { estoque: (i % 7) - 1, custo: '10.00', venda: '25.00' }));
    const vs = Array.from({ length: 6000 }, (_, i) => Fx.venda(X.dia(i % 89), [['E-' + (i % 877), 1 + (i % 3), 25, { custo: 10 }]], { id: 'VE-' + i }));
    const cs = Array.from({ length: 300 }, (_, i) => Fx.compra(X.dia(100 + (i % 200)), Array.from({ length: 8 }, (_, j) => ['E-' + ((i * 8 + j) % 877), 10, 10]), { id: 'CE-' + i, frete: 10 }));
    const sn = S.montarSnapshot({ brutosProdutos: ps, brutosVendas: vs, brutosCompras: cs, agora: AGORA, politica: P12 });
    const t = v => Buffer.byteLength(JSON.stringify(v));
    let maior = 0; for (let i = 0; i < sn.custos.length; i += S.BLOCO) maior = Math.max(maior, t({ produtos: sn.custos.slice(i, i + S.BLOCO) }));
    // PIOR CASO: quase todo o catálogo na visão — bloco e visão ficam folgados frente à guarda (DOC_BYTES_MAX)
    expect(Object.keys(sn.view.custos.linhas).length).toBeGreaterThan(700);
    expect(maior).toBeLessThan(S.DOC_BYTES_MAX / 2); expect(t(sn.view.custos)).toBeLessThan(S.DOC_BYTES_MAX * 0.65);   // pior caso absoluto (877 linhas): ~62 % do limite duro
    expect(sn.view.custos.detalhe_financeiro).toBe('RESUMIDO');                        // degrau de segurança acionado; nada abortou
    const linha0 = Object.values(sn.view.custos.linhas)[0].fin; expect(linha0.windows).toBeUndefined(); expect(linha0.margin).toBeDefined(); expect(linha0.decision).toBeDefined();   // enxuta, mas ainda com margem e decisão
    const pequeno = rodar(cen).sn.view.custos; expect(pequeno.detalhe_financeiro).toBe('COMPLETO'); expect(Object.values(pequeno.linhas)[0].fin.windows).toBeDefined();   // caso real: completa
  });
  test('base v1 (antiga) lida sem quebrar: itens sem custo da época → lucro histórico indisponível, nunca inventado', () => {
    const v1 = S.decodificarVenda(['V-ANTIGA', X.dia(5), 'Concretizada', '1', X.dia(5) + ' 10:00:00', [['PV', '2', '50.00']]]);
    expect(v1.produtos[0].valor_custo).toBeNull(); expect(v1.valor_produtos).toBeNull();
    const f = K.fatosDeVenda(v1)[0]; expect([f.unit_cost_snapshot_cents, f.sale_products_total_cents, f.header_discount_cents]).toEqual([null, null, 0]);
    const r = rodar({ produtos: [Fx.produto('PV', { estoque: 0, custo: '20.00', venda: '50.00' }), Fx.produto('BASE', { estoque: 1 })], vendas: [Fx.venda('2022-01-10', [['BASE', 1, 25, { custo: 10 }]]), v1], compras: [Fx.compra(X.dia(300), [['PV', 10, 20]])] });
    expect(r.fin('PV').windows[30]).toMatchObject({ revenue_cents: 5000 }); expect(r.fin('PV').windows[30].profit_cents).toBeNull(); expect(r.fin('PV').windows[30].cost_coverage_bps).toBe(0);
  });
});

// ═══════════════════════════════════════════════ GUARDAS ESTÁTICAS ═══════════════════════════════════════════════
describe('guardas estáticas do módulo', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../lib/compras/rentabilidade.js'), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n').replace(/'[^']*'/g, "''");
  test('sem número operacional espalhado: nenhum literal com 3+ dígitos ou decimal; sem IA; sem escrita no ERP', () => {
    expect(codigo.match(/\b\d{3,}\b|\b\d+\.\d+\b/g) || []).toEqual([]);
    expect(/openai|anthropic|gpt|llm/i.test(codigo)).toBe(false);
    expect(/fetch\(|method\s*:\s*'(POST|PUT|PATCH|DELETE)'|writeFile/i.test(fonte)).toBe(false);
    expect(/Infinity|9999/.test(codigo)).toBe(false);
  });
  test('o motor da Política 1.1 (motor.js) continua sem margem nem capital: a camada financeira é um módulo separado', () => {
    const motor = fs.readFileSync(path.join(__dirname, '../lib/compras/motor.js'), 'utf8');
    expect(motor).not.toMatch(/markup|profit|capital_parado|rentabilidade|require\('\.\/rentabilidade'\)/i);   // (abc_margin = marcador 'BLOCKED' antigo)
  });
});
