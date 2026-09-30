'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.1 = 1.0 + exceção NEW_PRODUCT_WITH_PROVEN_DEMAND (regra D + Método 3 + ativo).
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const K = require('../lib/compras/canonico');
const M = require('../lib/compras/motor');
const S = require('../lib/compras/snapshot');
const Pol = require('../lib/compras/politica');
const X = require('./fixtures/compras-estoque-f0');
const { POLITICA_1_0, POLITICA_1_1, POLITICAS, POLITICA_VIGENTE } = Pol;
jest.setTimeout(60000);

const calc = (c, politica = POLITICA_1_1) => M.calcularTudo({ produtos: c.produtos.map(K.mapearProduto), fatosVenda: c.vendas.flatMap(K.fatosDeVenda), fatosCompra: c.compras.flatMap(K.fatosDeCompra), hoje: X.HOJE, politica });
const um = (r, id) => r.metricas.find(m => m.product_id === id);
const linha = m => [m.product_id, m.purchase_eligible, m.purchase_exclusions.join('|'), m.suggestion.suggested_qty, m.suggestion.priority, m.policy_velocity, m.coverage.estado, m.coverage.dias, m.reason_codes.join('|'), m.dead_stock_band, m.new_product, m.suggestion.target_days, m.suggestion.calculated_need];
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/compras-politica-1-0-golden.json'), 'utf8'));

/** Cenário de bordas da 1.1: produto novo (idade = compra confirmada) com vendas controladas. */
function bordas() {
  const P = [], V = [], C = [];
  P.push(X.produto('MA', { estoque: 500 })); C.push(X.compra(X.dia(400), [['MA', 600]])); V.push(...X.serie('MA', { de: 360, passo: 5, qtd: 1, preco: 10 }).slice(0, 78));
  const novo = (id, idade, vendas, o = {}) => { P.push(X.produto(id, { estoque: o.estoque === undefined ? 0 : o.estoque, ativo: o.ativo })); C.push(X.compra(X.dia(idade), [[id, 30]])); vendas.forEach(([d, q, extra]) => V.push(X.venda(X.dia(d), [[id, q, 10]], extra || {}))); };
  novo('U4', 20, [[12, 2], [8, 1], [2, 1]]);                  // 4 un, 3 dias → não passa
  novo('U5', 20, [[12, 2], [8, 2], [2, 1]]);                  // 5 un, 3 dias → passa
  novo('D2', 20, [[12, 3], [2, 3]]);                          // 6 un, 2 dias → não passa
  novo('D3', 20, [[12, 2], [8, 2], [2, 2]]);                  // 6 un, 3 dias → passa
  novo('G10', 20, [[5, 10]]);                                 // 10 un num dia → não passa
  novo('G20', 20, [[5, 20]]);                                 // 20 un num dia → não passa
  novo('A6', 6, [[5, 2], [3, 2], [1, 2]]);                    // idade 6 → não passa
  novo('A7', 7, [[6, 2], [3, 2], [1, 2]]);                    // idade 7 → passa
  novo('INA', 20, [[12, 2], [8, 2], [2, 2]], { ativo: '0' }); // inativo → não passa
  novo('CAN', 20, [[12, 2, { situacao: 'Cancelada' }], [8, 2, { situacao: 'Cancelada' }], [2, 2, { situacao: 'Cancelada' }]]);   // só canceladas
  novo('RES', 20, [[12, 2, { situacao: 'Reservado' }], [8, 2, { situacao: 'Reservado' }], [2, 2, { situacao: 'Reservado' }]]);   // só reservado (com baixa)
  novo('MIX', 20, [[12, 2], [8, 2], [2, 2, { situacao: 'Reservado' }]]);                                                        // concluído + reservado
  novo('NEG', 20, [[12, 2], [8, 2], [2, 2]], { estoque: -5 }); // negativo + critérios completos
  novo('POS', 30, [[20, 2], [10, 2], [3, 2]], { estoque: 3 });  // estoque > 0 → cobertura calculada
  novo('M3', 40, [[38, 2], [36, 2], [34, 2], [5, 1]]);          // 30d (1/30) < desde a 1ª evidência (7/40)
  return { produtos: P, vendas: V, compras: C };
}

// ═════════════════════════ POLICY ═════════════════════════
describe('POLICY 1.1 — versão, herança e preservação da 1.0', () => {
  test('1.1 herda a 1.0 e muda SÓ new_product (exceção + rótulo de reposição)', () => {
    const tirar = p => { const c = JSON.parse(JSON.stringify(p)); for (const k of ['policy_version', 'inherits_from', 'approved_on', 'changes_from_parent']) delete c[k]; delete c.new_product; return c; };
    expect(tirar(POLITICA_1_1)).toEqual(tirar(POLITICA_1_0));
    expect(POLITICA_1_1).toMatchObject({ policy_version: '1.1', inherits_from: '1.0', changes_from_parent: ['new_product.proven_demand'] });
    expect(POLITICA_1_1.new_product.window_days).toBe(POLITICA_1_0.new_product.window_days);
    expect(POLITICA_1_1.new_product.proven_demand).toEqual({ enabled: true, minimum_age_days: 7, minimum_units: 5, minimum_distinct_sale_days: 3, rate_rule: { type: 'NONE', min_daily_rate: null }, count_reserved: true, require_active: true, quantity_velocity: 'MIN_OBSERVED_AND_SIGNAL' });
    expect(Pol.validarPolitica(POLITICA_1_1)).toEqual([]); expect(Object.isFrozen(POLITICA_1_1.new_product.proven_demand)).toBe(true);
  });
  test('registro de versões: 1.0 e 1.1 disponíveis; vigente = 1.1; 1.0 intocada', () => {
    expect(POLITICAS['1.0']).toBe(POLITICA_1_0); expect(POLITICAS['1.1']).toBe(POLITICA_1_1); expect(POLITICA_VIGENTE).toBe(POLITICA_1_1);
    expect(POLITICA_1_0.policy_version).toBe('1.0'); expect(POLITICA_1_0.new_product.proven_demand).toBeUndefined();
  });
  test.each([['cenario', 'produtos'], ['cenarioProdutoNovo', 'produto_novo'], ['cenarioProdutoNovoABC', 'produto_novo_abc']])('golden da 1.0 (gerado com b3b13dc) continua idêntico — %s', (fn, k) => {
    expect(calc(X[fn](), POLITICA_1_0).metricas.map(linha)).toEqual(GOLDEN[k]);
  });
  test.each(['cenario', 'cenarioProdutoNovo', 'cenarioProdutoNovoABC'])('nenhum produto MADURO muda entre 1.0 e 1.1 — %s', fn => {
    const r0 = calc(X[fn](), POLITICA_1_0), r1 = calc(X[fn]());
    for (const m of r0.metricas.filter(x => !x.new_product)) expect(linha(um(r1, m.product_id))).toEqual(linha(m));
  });
  test('motor segue sem números operacionais (a 1.1 vem da configuração)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/compras/motor.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    expect([...new Set(src.match(/(?<![\w.])\d+(?:\.\d+)?(?:e-?\d+)?(?![\w])/g) || [])].filter(n => !['0', '1', '2', '10', '1000', '1e-9'].includes(n))).toEqual([]);
  });
});

describe('POLICY 1.1 — bordas da exceção (TODOS os critérios)', () => {
  const r = calc(bordas());
  const passa = id => um(r, id).new_product_proven_demand.accepted;
  test.each([
    ['A6', false, ['NEW_PRODUCT_MIN_AGE_NOT_MET']], ['A7', true, []],
    ['U4', false, ['NEW_PRODUCT_MIN_UNITS_NOT_MET']], ['U5', true, []],
    ['D2', false, ['NEW_PRODUCT_DISTINCT_DAYS_NOT_MET']], ['D3', true, []],
    ['G10', false, ['NEW_PRODUCT_DISTINCT_DAYS_NOT_MET']], ['G20', false, ['NEW_PRODUCT_DISTINCT_DAYS_NOT_MET']],
    ['INA', false, ['NEW_PRODUCT_NOT_ACTIVE']], ['CAN', false, ['NEW_PRODUCT_MIN_UNITS_NOT_MET', 'NEW_PRODUCT_DISTINCT_DAYS_NOT_MET']],
    ['NEG', true, []], ['D3', true, []],
  ])('%s → passa=%s, motivos factuais %j', (id, ok, motivos) => {
    const m = um(r, id);
    expect(passa(id)).toBe(ok);
    for (const c of motivos) expect(m.reason_codes).toContain(c);
    if (ok) { expect(m.reason_codes).toEqual(expect.arrayContaining(['NEW_PRODUCT', 'NEW_PRODUCT_WITH_PROVEN_DEMAND'])); expect(m.suggestion.eligibility_path).toBe('NEW_PRODUCT_WITH_PROVEN_DEMAND'); expect(m.suggestion.suggested_qty).toBeGreaterThan(0); }
    else { expect(m.new_product).toBe(true); expect(m.reason_codes).toContain('NEW_PRODUCT'); expect(m.reason_codes).not.toContain('NEW_PRODUCT_WITH_PROVEN_DEMAND'); expect(m.suggestion.suggested_qty).toBe(0); expect(m.suggestion.eligibility_path).toBe('NEW_PRODUCT_PROTECTED'); }
  });
  test('venda grande num único dia (10 / 20 un) nunca satisfaz — proteção deliberada', () => {
    for (const id of ['G10', 'G20']) expect(um(r, id).suggestion.new_product_exception).toMatchObject({ accepted: false, distinct_valid_sale_days: 1, failed_criteria: ['MIN_DISTINCT_SALE_DAYS'] });
  });
  test('só canceladas → nunca vendido, 0 unidades válidas, não passa', () => {
    expect(um(r, 'CAN').never_sold).toBe(true); expect(um(r, 'CAN').suggestion.new_product_exception.valid_demand_units).toBe(0);
  });
  test('reservado com baixa conta (regra aprovada) e fica auditável; misto separa concluído × reservado', () => {
    expect(um(r, 'RES').suggestion.new_product_exception).toMatchObject({ accepted: true, valid_demand_units: 6, completed_demand_units: 0, reserved_demand_units: 6 });
    expect(um(r, 'MIX').suggestion.new_product_exception).toMatchObject({ accepted: true, valid_demand_units: 6, completed_demand_units: 4, reserved_demand_units: 2 });
    expect(um(r, 'RES').reason_codes).toContain('RESERVED_DEMAND_INCLUDED');
  });
  test('estoque zero e negativo com critérios completos: sugerem; negativo não gera unidades extras', () => {
    const neg = um(r, 'NEG'), zero = um(r, 'D3');
    expect(neg.suggestion).toMatchObject({ raw_stock: -5, available_stock_for_replenishment: 0 });
    const v = neg.suggestion.new_product_exception.velocity_used, alvo = neg.suggestion.target_days;
    expect(neg.suggestion.suggested_qty).toBe(Math.ceil(v * alvo - 1e-9));             // calculado sobre disponível = 0
    expect(neg.suggestion.suggested_qty).not.toBe(Math.ceil(v * alvo - 1e-9) + 5);     // sem compensar o −5
    expect(neg.reason_codes).toEqual(expect.arrayContaining(['NEGATIVE_STOCK', 'STOCKOUT_RECENT_DEMAND', 'NEW_PRODUCT_WITH_PROVEN_DEMAND']));
    expect(zero.reason_codes).toEqual(expect.arrayContaining(['STOCKOUT_RECENT_DEMAND', 'NEW_PRODUCT_WITH_PROVEN_DEMAND']));
  });
  test('Método 3: velocidade = min(desde a 1ª evidência, 30d); ceil da necessidade; alvo pela classe ABC_REVENUE', () => {
    for (const id of ['U5', 'D3', 'A7', 'NEG', 'POS', 'M3', 'RES', 'MIX']) {
      const m = um(r, id), ex = m.suggestion.new_product_exception, s = m.suggestion;
      expect(ex.velocity_used).toBe(Math.min(ex.velocity_since_creation, ex.velocity_30d)); expect(m.policy_velocity).toBe(ex.velocity_used);
      expect(s.target_days).toBe({ A: 30, B: 21, C: 15 }[s.abc_revenue === 'SEM_VENDA' ? 'C' : s.abc_revenue]);
      expect(s.suggested_qty).toBe(Math.max(0, Math.ceil(ex.velocity_used * s.target_days - s.available_stock_for_replenishment - 1e-9)));
    }
    const m3 = um(r, 'M3').suggestion.new_product_exception;
    expect(m3.velocity_30d).toBeLessThan(m3.velocity_since_creation); expect(m3.velocity_used).toBe(m3.velocity_30d);   // nunca a maior
  });
  test('produto novo aceito com estoque: cobertura calculada pela velocidade usada → LOW_COVERAGE aplicável', () => {
    const m = um(r, 'POS');
    expect(m.coverage).toEqual({ estado: 'COVERAGE_LOW', dias: 15 }); expect(m.reason_codes).toContain('LOW_COVERAGE');
    expect(m.dead_stock_band).toBeNull();   // novo nunca é "parado"
  });
  test('explicação completa da exceção (sem caixa-preta)', () => {
    const s = um(r, 'NEG').suggestion;
    expect(s.policy_version).toBe('1.1');
    expect(Object.keys(s.new_product_exception)).toEqual(['rule', 'accepted', 'failed_criteria', 'criteria', 'age_days', 'valid_demand_units', 'distinct_valid_sale_days', 'completed_demand_units', 'reserved_demand_units', 'largest_single_day_units', 'velocity_since_creation', 'velocity_30d', 'quantity_method', 'velocity_used']);
    expect(s.new_product_exception.criteria).toEqual({ minimum_age_days: 7, minimum_units: 5, minimum_distinct_sale_days: 3, require_active: true });
    for (const k of ['abc_revenue', 'target_days', 'raw_stock', 'available_stock_for_replenishment', 'target_stock', 'suggested_qty', 'reason_codes', 'priority']) expect(s).toHaveProperty(k);
    expect(um(r, 'MA').suggestion).toMatchObject({ eligibility_path: 'MATURE', new_product_exception: null });
  });
});

describe('POLICY 1.1 — classes ABC e prioridade', () => {
  function abc() {
    const P = [], V = [], C = [];
    P.push(X.produto('MA', { estoque: 500 })); C.push(X.compra(X.dia(400), [['MA', 600]])); V.push(...X.serie('MA', { de: 360, passo: 4, qtd: 1, preco: 10 }).slice(0, 78));   // 780
    const novo = (id, qtds, preco, estoque = 0) => { P.push(X.produto(id, { estoque })); C.push(X.compra(X.dia(20), [[id, 20]])); [12, 8, 2].forEach((d, i) => V.push(X.venda(X.dia(d), [[id, qtds[i], preco]]))); };
    novo('NX', [2, 2, 2], 20);        // 120 → A
    novo('NY', [2, 2, 2], 10);        //  60 → B
    novo('NZ', [2, 2, 1], 8);         //  40 → C
    novo('NA2', [2, 2, 2], 0.01, 2);  // receita ínfima → C (com estoque)
    return { produtos: P, vendas: V, compras: C };
  }
  const r = calc(abc());
  test('A=30 / B=21 / C=15 aplicados ao produto novo aceito', () => {
    expect(['NX', 'NY', 'NZ'].map(id => um(r, id).abc_revenue)).toEqual(['A', 'B', 'C']);
    expect(['NX', 'NY', 'NZ'].map(id => um(r, id).suggestion.suggested_qty)).toEqual([9, 7, 4]);   // 0,3×30 · 0,3×21 · 0,25×15=3,75→4
  });
  test('mesma matriz P1–P4; nada acima de P1; lançamento identificado', () => {
    expect(um(r, 'NX').suggestion.priority).toBe('P1');   // A + ruptura + demanda
    expect(um(r, 'NY').suggestion.priority).toBe('P3');   // B + ruptura + demanda
    expect(um(r, 'NZ').suggestion.priority).toBe('P4');   // C
    const b = calc(bordas());
    for (const m of [...r.metricas, ...b.metricas]) expect([null, 'P1', 'P2', 'P3', 'P4']).toContain(m.suggestion.priority);
    for (const m of r.metricas.filter(x => x.suggestion.eligibility_path === 'NEW_PRODUCT_WITH_PROVEN_DEMAND')) expect(m.reason_codes).toContain('NEW_PRODUCT_WITH_PROVEN_DEMAND');
  });
  test('P2: produto novo A aceito com estoque disponível abaixo do alvo', () => {
    const c = abc(); c.produtos.find(p => p.id === 'NX').estoque = '2';
    expect(um(calc(c), 'NX').suggestion).toMatchObject({ priority: 'P2', suggested_qty: 7 });   // 9 − 2
  });
});

// ═════════════════════════ SNAPSHOT / SYNC / FUSO ═════════════════════════
describe('SNAPSHOT/SYNC 1.1 — versão registrada; fuso', () => {
  test('snapshot de estoque, resumo, meta, blocos e custos registram policy_version 1.1 (vigente)', () => {
    const c = bordas();
    const s = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA });
    expect([s.resumo.policy_version, s.meta.policy_version, s.snapshotEstoque.policy_version]).toEqual(['1.1', '1.1', '1.1']);
    for (const m of s.operacional) expect(m.suggestion.policy_version).toBe('1.1');
    for (const k of s.custos) expect(k.policy_version).toBe('1.1');
    const s0 = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: POLITICA_1_0 });
    expect(s0.snapshotEstoque.policy_version).toBe('1.0'); expect(s0.snapshotEstoque.saldos).toEqual(s.snapshotEstoque.saldos);
  });
  test('UTC = America/Fortaleza = Asia/Tokyo com a 1.1 (data comercial e sugestões idênticas)', () => {
    const LIB = path.resolve(__dirname, '../lib/compras'), FIX = path.resolve(__dirname, 'fixtures/compras-estoque-f0');
    const rodar = tz => JSON.parse(execFileSync(process.execPath, ['-e', `
      const S = require(${JSON.stringify(LIB + '/snapshot')}); const X = require(${JSON.stringify(FIX)});
      const c = X.cenarioProdutoNovo();
      const s = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: new Date('2026-09-29T02:30:00Z') });
      process.stdout.write(JSON.stringify({ d: s.snapshotEstoque.data_comercial, pv: s.snapshotEstoque.policy_version, sug: s.operacional.map(m => [m.product_id, m.suggestion.suggested_qty, m.suggestion.priority, m.suggestion.eligibility_path]) }));`], { env: { ...process.env, TZ: tz } }).toString());
    const u = rodar('UTC');
    expect(u.d).toBe('2026-09-28'); expect(u.pv).toBe('1.1');
    expect(rodar('America/Fortaleza')).toEqual(u); expect(rodar('Asia/Tokyo')).toEqual(u);
  });
  test('tamanho: a 1.1 não aumenta substancialmente o payload (catálogo maduro ≤ +10%; ≤ 1 KB por produto novo)', () => {
    const tam = (c, pol) => Buffer.byteLength(JSON.stringify(S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: pol }).operacional));
    const maduro = X.cenario();
    expect(tam(maduro, POLITICA_1_1)).toBeLessThanOrEqual(tam(maduro, POLITICA_1_0) * 1.1);
    const novos = X.cenarioProdutoNovo(), n = 14;
    expect((tam(novos, POLITICA_1_1) - tam(novos, POLITICA_1_0)) / n).toBeLessThanOrEqual(1024);
  });
});
