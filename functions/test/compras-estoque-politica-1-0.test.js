'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.0 (configuração aprovada pelo gestor) · POLICY / SNAPSHOT / SYNC.
const fs = require('fs'), path = require('path');
const K = require('../lib/compras/canonico');
const M = require('../lib/compras/motor');
const C = require('../lib/compras/calibracao');
const F = require('../lib/compras/fetch');
const S = require('../lib/compras/snapshot');
const { POLITICA_1_0, POLITICA_VIGENTE, validarPolitica } = require('../lib/compras/politica');
const X = require('./fixtures/compras-estoque-f0');

const P = M.paramsDe(POLITICA_1_0);
// Suíte da Política 1.0 — versão FIXADA explicitamente (a vigente passou a ser 1.1)
const calc = (produtos, vendas, compras = [], hoje = X.HOJE) => M.calcularTudo({ produtos: produtos.map(K.mapearProduto), fatosVenda: vendas.flatMap(K.fatosDeVenda), fatosCompra: compras.flatMap(K.fatosDeCompra), hoje, politica: POLITICA_1_0 });
const um = (r, id) => r.metricas.find(m => m.product_id === id);
const diario = (id, n = 90) => X.serie(id, { de: n - 1, passo: 1, qtd: 1 });   // 1 un/dia → velocidade 1,0

// ═════════════════════════════════════════ POLICY ═════════════════════════════════════════
describe('POLICY — configuração central versionada', () => {
  test('Política 1.0 válida, congelada e preservada no registro (a vigente agora é 1.2)', () => {
    expect(validarPolitica(POLITICA_1_0)).toEqual([]);
    expect(require('../lib/compras/politica').POLITICAS['1.0']).toBe(POLITICA_1_0); expect(POLITICA_VIGENTE.policy_version).toBe('1.2');
    expect(Object.isFrozen(POLITICA_1_0) && Object.isFrozen(POLITICA_1_0.target_days) && Object.isFrozen(POLITICA_1_0.velocity.signal)).toBe(true);
    expect(() => { POLITICA_1_0.target_days.A = 45; }).toThrow(TypeError);
  });
  test('valores aprovados pelo gestor', () => {
    expect(POLITICA_1_0).toMatchObject({
      policy_version: '1.0', abc: { primary: 'abc_revenue', secondary: 'abc_units' }, target_days: { A: 30, B: 21, C: 15 },
      demand: { window_days: 90, minimum_units: 1 }, velocity: { window_days: 90, signal_window_days: 30, acceleration_behavior: 'SIGNAL_ONLY', deceleration_behavior: 'SIGNAL_ONLY' },
      new_product: { window_days: 60 }, coverage_indicators: { critical_below_days: 15, low_below_days: 30, excess_above_days: 180 }, rounding: 'CEIL',
      sync: { incremental_every_hours: 3, incremental_lookback_days: 90, scheduled: false }, stock_snapshot: { type: 'FULL_DAILY', timezone: 'America/Fortaleza' },
      blocked: { abc_margin: 'BLOCKED', purchase_affordability: 'BLOCKED' },
    });
  });
  test.each([
    ['sem versão', { policy_version: '' }, /policy_version/],
    ['alvo zero', { target_days: { A: 0, B: 21, C: 15 } }, /target_days.A/],
    ['demanda mínima 0', { demand: { ...POLITICA_1_0.demand, minimum_units: 0 } }, /minimum_units/],
    ['limiares fora de ordem', { coverage_indicators: { critical_below_days: 30, low_below_days: 15, excess_above_days: 180 } }, /fora de ordem/],
    ['arredondamento inválido', { rounding: 'FLOOR' }, /rounding/],
    ['fuso diferente', { stock_snapshot: { ...POLITICA_1_0.stock_snapshot, timezone: 'UTC' } }, /America\/Fortaleza/],
  ])('validação rejeita: %s', (_, mud, re) => { expect(validarPolitica({ ...POLITICA_1_0, ...mud }).join(' ')).toMatch(re); });
  test('motor sem números operacionais mágicos (só 0/1/2/10/1000/1e-9 em código)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/compras/motor.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const nums = [...new Set((src.match(/(?<![\w.])\d+(?:\.\d+)?(?:e-?\d+)?(?![\w])/g) || []))];
    expect(nums.filter(n => !['0', '1', '2', '10', '1000', '1e-9'].includes(n))).toEqual([]);
  });
});

describe('POLICY — regras de sugestão', () => {
  const c = X.cenario();
  const r = calc(c.produtos, c.vendas, c.compras);
  test('alvo por classe ABC_REVENUE: A=30, B=21, C=15 (e só isso define a quantidade)', () => {
    const vistos = new Set();
    for (const m of r.metricas.filter(x => x.suggestion.suggested_qty > 0)) {
      const cl = m.abc_revenue === 'SEM_VENDA' ? 'C' : m.abc_revenue;
      expect(m.suggestion.target_days).toBe({ A: 30, B: 21, C: 15 }[cl]); vistos.add(cl);
      expect(m.suggestion.suggested_qty).toBe(Math.ceil(m.policy_velocity * m.suggestion.target_days - m.available_stock_for_replenishment - 1e-9));
    }
    expect([...vistos].sort()).toEqual(['A', 'B']);
    const s = M.sugestaoOficial({ ...um(r, 'PX-FORTE'), abc_revenue: 'C', abc_units: 'C', abc_divergence: null }, P);
    expect(s.target_days).toBe(15);
  });
  test('indicador de cobertura NÃO define quantidade: classe C com cobertura LOW (16d) e alvo 15d → 0', () => {
    const r2 = calc([X.produto('LOW16', { estoque: 16 })], diario('LOW16'), [X.compra(X.dia(200), [['LOW16', 200]])]);
    const m = um(r2, 'LOW16');
    expect(m.coverage).toEqual({ estado: 'COVERAGE_LOW', dias: 16 }); expect(m.reason_codes).toContain('LOW_COVERAGE');
    expect(M.sugestaoOficial({ ...m, abc_revenue: 'C' }, P).suggested_qty).toBe(0);
    expect(M.sugestaoOficial({ ...m, abc_revenue: 'A' }, P).suggested_qty).toBe(14);   // 1,0 × 30 − 16
  });
  test('MIN_DEMAND_90D = 1: uma unidade em 90d basta para elegibilidade; zero em 90d (vendeu antes) não', () => {
    const r2 = calc([X.produto('UM', { estoque: 0 }), X.produto('ANTIGO', { estoque: 0 })], [X.venda(X.dia(40), [['UM', 1]]), X.venda(X.dia(200), [['ANTIGO', 5]])], [X.compra(X.dia(300), [['UM', 5], ['ANTIGO', 5]])]);
    expect(um(r2, 'UM').purchase_eligible).toBe(true); expect(um(r2, 'UM').suggestion.suggested_qty).toBe(1);   // 1/90 × 30 = 0,33 → ceil → 1
    expect(um(r2, 'ANTIGO').purchase_exclusions).toEqual(['INSUFFICIENT_RECENT_DEMAND']); expect(um(r2, 'ANTIGO').suggestion.suggested_qty).toBe(0);
  });
  test('NEW_PRODUCT_WINDOW = 60: 59 dias é novo; 60 não é; novo nunca vira "parado"', () => {
    const r2 = calc([X.produto('N59', { estoque: 5 }), X.produto('N60', { estoque: 5 })], [], [X.compra(X.dia(59), [['N59', 5]]), X.compra(X.dia(60), [['N60', 5]])]);
    expect(um(r2, 'N59')).toMatchObject({ new_product: true, dead_stock_band: null }); expect(um(r2, 'N59').reason_codes).toContain('NEW_PRODUCT');
    expect(um(r2, 'N60')).toMatchObject({ new_product: false, dead_stock_band: '60+' });
  });
  test.each([[14, 'COVERAGE_CRITICAL'], [15, 'COVERAGE_LOW'], [29, 'COVERAGE_LOW'], [30, 'COVERAGE_OK'], [180, 'COVERAGE_OK'], [181, 'COVERAGE_EXCESS']])('cobertura %i dias → %s (<15 crítica · 15–30 baixa · >180 excesso)', (est, estado) => {
    const r2 = calc([X.produto('CV', { estoque: est })], diario('CV'), [X.compra(X.dia(200), [['CV', 400]])]);
    expect(um(r2, 'CV').coverage).toEqual({ estado, dias: est });
  });
  test('CEIL: 0 < necessidade < 1 ⇒ 1; ruído de ponto flutuante não vira unidade extra; nunca fração', () => {
    const mk = o => ({ purchase_eligible: true, purchase_exclusions: [], policy_velocity: 0.1, available_stock_for_replenishment: 1, raw_stock: 1, units: { 90: 9 }, coverage: { estado: 'COVERAGE_CRITICAL' }, ...o });
    expect(M.aplicarPolitica(mk({ policy_velocity: 0.04 }), 'A', 30, { P }).suggested_qty).toBe(1);   // 1,2 − 1 = 0,2 → 1
    expect(M.aplicarPolitica(mk(), 'A', 30, { P }).suggested_qty).toBe(2);                           // 0,1 × 30 = 3,0000000000000004 − 1
    for (const v of [0.013, 0.37, 1.9, 2.5]) expect(Number.isInteger(M.aplicarPolitica(mk({ policy_velocity: v }), 'B', 21, { P }).suggested_qty)).toBe(true);
  });
  test('estoque negativo: RAW preservado, disponível = 0, NEGATIVE_STOCK na explicação, sem unidades extras', () => {
    const r2 = calc([X.produto('M10', { estoque: -10 }), X.produto('Z0', { estoque: 0 })], [...diario('M10'), ...diario('Z0')], [X.compra(X.dia(200), [['M10', 100], ['Z0', 100]])]);
    const a = um(r2, 'M10').suggestion, b = um(r2, 'Z0').suggestion;
    expect(a).toMatchObject({ raw_stock: -10, available_stock_for_replenishment: 0, suggested_qty: b.suggested_qty });
    expect(a.reason_codes).toContain('NEGATIVE_STOCK');
  });
  test('Reservado conta; Reservado depois cancelado deixa de contar (sugestão some)', () => {
    const v1 = X.venda(X.dia(10), [['RS', 1]], { id: 'VX-R1', situacao: 'Reservado' });
    const r1 = calc([X.produto('RS', { estoque: 0 })], [v1], [X.compra(X.dia(300), [['RS', 3]])]);
    expect(um(r1, 'RS').demand_by_source_90d.RESERVED).toBe(1); expect(um(r1, 'RS').suggestion.suggested_qty).toBe(1);
    const v2 = { ...v1, nome_situacao: 'Cancelada', modificado_em: '2026-09-27 08:00:00' };
    const r2 = calc([X.produto('RS', { estoque: 0 })], F.mesclarRegistros([v1], [v2]).registros, [X.compra(X.dia(300), [['RS', 3]])]);
    expect(um(r2, 'RS').never_sold).toBe(true); expect(um(r2, 'RS').suggestion.suggested_qty).toBe(0);
  });
  test('NEVER_SOLD (mesmo com estoque zero) e INACTIVE_PRODUCT → SUGGESTED_QTY=0, sem prioridade', () => {
    const r2 = calc([X.produto('NV0', { estoque: 0 }), X.produto('INA', { estoque: 0, ativo: '0' })], diario('INA'), [X.compra(X.dia(300), [['NV0', 3], ['INA', 90]])]);
    expect(um(r2, 'NV0').suggestion).toMatchObject({ suggested_qty: 0, priority: null, exclusions: ['NEVER_SOLD'] });
    expect(um(r2, 'INA').suggestion).toMatchObject({ suggested_qty: 0, priority: null, exclusions: ['INACTIVE_PRODUCT'] });
  });
  test('prioridade P1/P2/P3/P4 no cenário completo', () => {
    expect(um(r, 'PX-NEGATIVO').suggestion.priority).toBe('P1');   // A + negativo + demanda
    expect(um(r, 'PX-FORTE').suggestion.priority).toBe('P2');      // A + abaixo do alvo
    expect(um(r, 'PX-RUPTURA').suggestion.priority).toBe('P3');    // B + ruptura + demanda
    for (const m of r.metricas) { if (m.never_sold || !m.active) expect(m.suggestion.priority).toBeNull(); if (!(m.suggestion.suggested_qty > 0)) expect(m.suggestion.priority).toBeNull(); }
    const pol = C.resumoPolitica(r);
    expect(pol.P1_PRODUCTS + pol.P2_PRODUCTS + pol.P3_PRODUCTS + pol.P4_PRODUCTS).toBe(pol.TOTAL_SUGGESTED_PRODUCTS);
  });
  test('P4 = demais elegíveis com necessidade (ex.: classe C em ruptura com demanda)', () => {
    expect(M.prioridade({ raw_stock: 0, units: { 90: 5 } }, 'C', P)).toBe('P4');
  });
  test('custo NÃO influencia elegibilidade, prioridade ou quantidade', () => {
    const c2 = X.cenario(); c2.produtos.forEach(p => { p.valor_custo = '999.99'; });
    const r2 = calc(c2.produtos, c2.vendas, c2.compras);
    const chave = rr => rr.metricas.map(m => [m.product_id, m.purchase_eligible, m.suggestion.suggested_qty, m.suggestion.priority]);
    expect(chave(r2)).toEqual(chave(r));
    expect(C.resumoPolitica(r).COST_USED_IN_DECISION).toBe(false);
  });
  test('explicação completa e rastreável em cada sugestão', () => {
    expect(Object.keys(um(r, 'PX-FORTE').suggestion)).toEqual(['policy_version', 'abc_basis', 'abc_revenue', 'abc_units', 'abc_divergence', 'raw_stock', 'available_stock_for_replenishment', 'sales', 'velocity_window_days', 'velocity_used', 'velocity_signal', 'coverage_days', 'coverage_state', 'target_days', 'target_stock', 'calculated_need', 'rounding', 'suggested_qty', 'priority', 'eligible', 'exclusions', 'reason_codes', 'lead_time']);
    expect(um(r, 'PX-FORTE').suggestion).toMatchObject({ policy_version: '1.0', abc_basis: 'abc_revenue', sales: { d30: 20, d60: 40, d90: 60 }, velocity_window_days: 90, rounding: 'CEIL', lead_time: 'UNKNOWN_COVERAGE_POLICY_NOT_REORDER_POINT' });
  });
  test('ABC_UNITS preservado como secundário; divergência registrada sem mudar a classe principal', () => {
    for (const m of r.metricas) { expect(['A', 'B', 'C', 'SEM_VENDA']).toContain(m.abc_units); expect(m.abc_divergence).toBe(m.abc_revenue === m.abc_units ? null : `REVENUE_${m.abc_revenue}_UNITS_${m.abc_units}`); }
    expect(Object.keys(r.agregados.divergencia_abc)).toEqual(['REVENUE_A_UNITS_C', 'REVENUE_C_UNITS_A']);
  });
  test('policy_version registrado em resumo, meta, blocos, custos, sugestões e snapshot de estoque', () => {
    const snap = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: POLITICA_1_0 });
    expect([snap.resumo.policy_version, snap.meta.policy_version, snap.snapshotEstoque.policy_version]).toEqual(['1.0', '1.0', '1.0']);
    for (const m of snap.operacional) { expect(m.policy_version).toBe('1.0'); expect(m.suggestion.policy_version).toBe('1.0'); }
    for (const k of snap.custos) expect(k.policy_version).toBe('1.0');
    expect(snap.resumo.politica).toBe(POLITICA_1_0);
  });
});

// ═════════════════════════════════════════ SNAPSHOT ═════════════════════════════════════════
function dbFalso(inicial = {}) {
  const st = JSON.parse(JSON.stringify(inicial));
  const ref = (c, id) => ({ id, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => (st[c] && st[c][id] ? JSON.parse(JSON.stringify(st[c][id])) : undefined) }),
    set: async v => { (st[c] = st[c] || {})[id] = JSON.parse(JSON.stringify(v)); }, delete: async () => { if (st[c]) delete st[c][id]; } });
  return { st, collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }) }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), commit: async () => { for (const o of ops) await o(); } }; } };
}
const snapDe = (produtos, agora) => ({ ...S.montarSnapshot({ brutosProdutos: produtos, brutosVendas: [], brutosCompras: [], agora, politica: POLITICA_1_0 }), base: null });

describe('SNAPSHOT — estoque diário completo (opção A)', () => {
  test('877 produtos no documento do dia, abaixo de 1 MiB, com schema/policy/fuso', () => {
    const ps = Array.from({ length: 877 }, (_, i) => X.produto('PX-' + i, { estoque: (i % 7) - 1 }));
    const s = S.montarSnapshotEstoque(ps.map(K.mapearProduto), X.AGORA, POLITICA_1_0);
    expect(s).toMatchObject({ schema_version: 1, policy_version: '1.0', data_comercial: '2026-09-28', timezone: 'America/Fortaleza', produtos_total: 877 });
    expect(Object.keys(s.saldos).length).toBe(877); expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThan(1048576);
  });
  test('mesmo dia: substitui (último sync vence, 1 documento); dias diferentes: preservados', async () => {
    const db = dbFalso();
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 5 })], new Date('2026-09-28T10:00:00Z')));
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 3 })], new Date('2026-09-28T22:00:00Z')));
    expect(Object.keys(db.st.estoque_snapshots)).toEqual(['2026-09-28']); expect(db.st.estoque_snapshots['2026-09-28'].saldos.A).toBe(3);
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 1 })], new Date('2026-09-29T12:00:00Z')));
    expect(Object.keys(db.st.estoque_snapshots).sort()).toEqual(['2026-09-28', '2026-09-29']); expect(db.st.estoque_snapshots['2026-09-28'].saldos.A).toBe(3);
  });
  test('dia comercial America/Fortaleza: 23:30 local (02:30Z do dia seguinte) grava no dia local', async () => {
    const db = dbFalso();
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 5 })], new Date('2026-09-29T02:30:00Z')));
    expect(Object.keys(db.st.estoque_snapshots)).toEqual(['2026-09-28']);
  });
  test('produto adicionado aparece; removido some; inativo listado; negativo preservado no RAW', async () => {
    const db = dbFalso();
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 5 }), X.produto('B', { estoque: 2 })], new Date('2026-09-28T15:00:00Z')));
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: -4 }), X.produto('C', { estoque: 7 }), X.produto('D', { estoque: 0, ativo: '0' })], new Date('2026-09-29T15:00:00Z')));
    const d2 = await S.lerSaldoDoDia(db, '2026-09-29');
    expect(d2.saldos).toEqual({ A: -4, C: 7, D: 0 }); expect(d2.inativos).toEqual(['D']);
    expect((await S.lerSaldoDoDia(db, '2026-09-28')).saldos).toEqual({ A: 5, B: 2 });
  });
  test('leitura de um dia não depende do dia anterior (anterior apagado)', async () => {
    const db = dbFalso();
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 5 })], new Date('2026-09-28T15:00:00Z')));
    await S.persistirSnapshot(db, snapDe([X.produto('A', { estoque: 9 })], new Date('2026-09-29T15:00:00Z')));
    delete db.st.estoque_snapshots['2026-09-28'];
    expect(await S.lerSaldoDoDia(db, '2026-09-29')).toMatchObject({ dia: '2026-09-29', policy_version: '1.0', saldos: { A: 9 } });
    expect(await S.lerSaldoDoDia(db, '2026-09-28')).toBeNull();
    await expect(S.lerSaldoDoDia(db, '28/09/2026')).rejects.toThrow(/DIA_INVALIDO/);
  });
  test('guarda de tamanho: documento acima do limite aborta ANTES de gravar qualquer coisa', async () => {
    const db = dbFalso();
    const sn = snapDe([X.produto('A', { estoque: 5 })], X.AGORA);
    sn.operacional[0].code = 'x'.repeat(S.DOC_BYTES_MAX + 10);
    await expect(S.persistirSnapshot(db, sn)).rejects.toThrow(/DOC_GRANDE_DEMAIS/);
    expect(db.st).toEqual({});
  });
  test('total acima de um commit: base em lotes próprios, snapshot visível num lote final; base volta idêntica', async () => {
    const db = dbFalso();
    const sn = snapDe([X.produto('A', { estoque: 5 })], X.AGORA);
    const vendas = Array.from({ length: 150000 }, (_, i) => S.compactarVenda(X.venda('2026-09-' + String(1 + (i % 28)).padStart(2, '0'), [['A', 1, 25], ['B', 2, 30]], { id: 'VX-' + i })));
    sn.base = { vendas, compras: [] };
    await S.persistirSnapshot(db, sn);
    expect(sn.persistencia.lotes).toBeGreaterThan(1); expect(sn.persistencia.maior_doc_bytes).toBeLessThanOrEqual(S.DOC_BYTES_MAX);
    const b = await S.carregarBase(db);
    expect(b.vendas.length).toBe(150000); expect(b.vendas[123]).toEqual(vendas[123]);
    expect(db.st.compras_n0.meta.ultima_tentativa_ok).toBe(true);
  });
  test('base em tuplas: ida e volta sem perda do que o motor usa', () => {
    const v = S.compactarVenda({ ...X.venda('2026-09-01', [['A', 2, 30]], { id: 'VX-T', situacao: 'Reservado' }), nome_cliente: 'Cliente Sintético' });
    expect(S.decodificarVenda(S.codificarVenda(v))).toEqual(v); expect(JSON.stringify(v)).not.toMatch(/Cliente/);
    const c = S.compactarCompra(X.compra('2026-08-01', [['A', 5, 10]], { id: 'CX-T', frete: '15.00' }));
    expect(S.decodificarCompra(S.codificarCompra(c))).toEqual(c);
    expect(K.fatosDeCompra(c)[0].freight_taxes_not_allocated).toBe(true);
  });
  test('retenção da política (1827 dias ≈ 5 anos): só lista o que expurgar', () => {
    expect(S.diasParaExpurgo(['2021-09-27', '2021-09-28', '2026-09-28'], '2026-09-29')).toEqual(['2021-09-27']);
  });
});

// ═════════════════════════════════════════ SYNC ═════════════════════════════════════════
function gcFalso({ produtos = [], vendas = [], compras = [], falhas = [], emTodasAsJanelas = [] } = {}) {
  const chamadas = []; let i = 0;
  const fetchImpl = async (url, opts) => {
    chamadas.push({ url, method: opts.method });
    const f = falhas[i++];
    if (f === 'TIMEOUT') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    if (typeof f === 'number') return { ok: false, status: f, json: async () => ({}) };
    const u = new URL(url), q = u.searchParams, pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    let lista;
    if (u.pathname === '/produtos') lista = produtos;
    else if (u.pathname === '/vendas') lista = [...vendas.filter(v => v.data >= q.get('data_inicio') && v.data <= q.get('data_fim')), ...emTodasAsJanelas];   // registro que "migra" entre janelas
    else if (u.pathname === '/compras') lista = compras.filter(c => c.Compra.data_emissao >= q.get('data_inicio') && c.Compra.data_emissao <= q.get('data_fim'));
    else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: lista.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: lista.length, total_paginas: Math.max(1, Math.ceil(lista.length / lim)) } }) };
  };
  return { cli: F.criarClienteGC({ fetchImpl, accessToken: 'tok-FAKE', secretToken: 'sec-FAKE', pausaMs: 0, dormir: async () => {} }), chamadas };
}
const AG1 = new Date('2026-09-28T09:00:00Z'), AG2 = new Date('2026-09-28T12:00:00Z');   // 06:00 e 09:00 em Fortaleza

describe('SYNC — completo (reconciliação) × incremental 90d', () => {
  const base = () => {
    const prods = [X.produto('P1', { estoque: 0 }), X.produto('P2', { estoque: 4 })];
    const res = X.venda('2026-09-20', [['P1', 1]], { id: 'VX-RES', situacao: 'Reservado' }); res.modificado_em = '2026-09-20 10:00:00';
    const velha = X.venda('2026-03-10', [['P2', 2]], { id: 'VX-VELHA' });
    const apagada = X.venda('2026-09-15', [['P2', 1]], { id: 'VX-APAGADA' });
    const comp = [X.compra('2026-01-10', [['P1', 5], ['P2', 10]], { id: 'CX-1' })];
    return { prods, vendas: [res, velha, apagada], comp, res };
  };
  test('incremental sem base → BASE_AUSENTE_EXIGE_FULL; nada além do erro em meta', async () => {
    const db = dbFalso(); const b = base();
    const r = await S.executarSyncIncremental({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    expect(r.ok).toBe(false); expect(db.st.compras_n0.meta.erro).toBe('BASE_AUSENTE_EXIGE_FULL'); expect(db.st.compras_n0_produtos).toBeUndefined();
  });
  test('completo grava base compacta SEM dados de cliente e marca a reconciliação', async () => {
    const db = dbFalso(); const b = base();
    b.vendas.forEach(v => { v.nome_cliente = 'Cliente Sintético'; v.cliente_id = 'CL-1'; v.nome_vendedor = 'Vendedor Sintético'; });
    const r = await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1, politica: POLITICA_1_0 });
    expect(r.ok).toBe(true); expect(db.st.compras_n0.meta).toMatchObject({ modo_sync: 'FULL', ultima_reconciliacao_completa: AG1.toISOString(), policy_version: '1.0' });
    const txt = JSON.stringify(db.st.compras_n0_base);
    expect(txt).not.toMatch(/Cliente Sintético|CL-1|Vendedor Sintético|nome_cliente|cliente_id/);
    const ativa = db.st.compras_n0.meta.base_ativa;   // fatias por geração: id vem do ponteiro
    expect(JSON.parse(db.st.compras_n0_base[S.idFatia(ativa, 'v', 0)].registros_json).length).toBe(3);   // texto JSON (Firestore não aceita array aninhado)
  });
  test('incremental: busca só 90d + futuro (sem janela anterior, sem consulta ampla) e mescla pela versão mais recente — Reservado cancelado sai', async () => {
    const db = dbFalso(); const b = base();
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    expect(db.st.compras_n0_produtos.bloco_000.produtos.find(m => m.product_id === 'P1').demand_by_source_90d.RESERVED).toBe(1);
    const cancelada = { ...b.res, nome_situacao: 'Cancelada', modificado_em: '2026-09-28 08:30:00' };
    const gc = gcFalso({ produtos: b.prods, vendas: [cancelada, b.vendas[1], b.vendas[2]], compras: b.comp });
    const r = await S.executarSyncIncremental({ cli: gc.cli, db, agora: AG2 });
    expect(r.ok).toBe(true);
    const inicios = gc.chamadas.filter(c => /\/vendas/.test(c.url)).map(c => new URL(c.url).searchParams.get('data_inicio'));
    expect(inicios.every(d => d >= '2026-06-30')).toBe(true);                         // 90 dias antes de 28/09
    expect(gc.chamadas.some(c => /data_inicio=2000-01-01/.test(c.url))).toBe(false);   // sem janela anterior/consulta ampla
    expect(gc.chamadas.every(c => c.method === 'GET')).toBe(true);
    const p1 = db.st.compras_n0_produtos.bloco_000.produtos.find(m => m.product_id === 'P1');
    expect(p1.demand_by_source_90d.RESERVED).toBe(0); expect(p1.suggestion.suggested_qty).toBe(0);
    expect(db.st.compras_n0.meta).toMatchObject({ modo_sync: 'INCREMENTAL', ultima_reconciliacao_completa: AG1.toISOString(), reconciliacao_atrasada: false });
    expect(r.snapshot.meta.estatisticas.mescla.vendas).toMatchObject({ substituidos: 2, inseridos: 0 });
  });
  test('exclusão no ERP: incremental não enxerga; o COMPLETO reconcilia (remove da base)', async () => {
    const db = dbFalso(); const b = base();
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    const semApagada = b.vendas.filter(v => v.id !== 'VX-APAGADA');
    await S.executarSyncIncremental({ cli: gcFalso({ produtos: b.prods, vendas: semApagada, compras: b.comp }).cli, db, agora: AG2 });
    expect((await S.carregarBase(db)).vendas.map(v => v.id)).toContain('VX-APAGADA');
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: semApagada, compras: b.comp }).cli, db, agora: new Date('2026-09-29T06:00:00Z') });
    expect((await S.carregarBase(db)).vendas.map(v => v.id)).not.toContain('VX-APAGADA');
  });
  test('deduplicação: registro repetido entre janelas conta uma vez', async () => {
    const db = dbFalso(); const b = base();
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    const dup = X.venda('2026-09-27', [['P2', 1]], { id: 'VX-NOVA' });
    const r = await S.executarSyncIncremental({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp, emTodasAsJanelas: [dup] }).cli, db, agora: AG2 });
    expect(r.ok).toBe(true); expect(r.snapshot.meta.estatisticas.vendas.duplicates).toBeGreaterThan(0);
    expect((await S.carregarBase(db)).vendas.filter(v => v.id === 'VX-NOVA').length).toBe(1);
  });
  test('registro repetido DENTRO da mesma janela (únicos ≠ total) → falha segura, snapshot preservado', async () => {
    const db = dbFalso(); const b = base();
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    const dup = X.venda('2026-09-27', [['P2', 1]], { id: 'VX-NOVA' });
    const r = await S.executarSyncIncremental({ cli: gcFalso({ produtos: b.prods, vendas: [...b.vendas, dup, dup], compras: b.comp }).cli, db, agora: AG2 });
    expect(r.ok).toBe(false); expect(db.st.compras_n0.meta.erro).toBe('JANELA_INCOMPLETA'); expect(db.st.compras_n0.meta.modo_sync).toBe('FULL');
  });
  test('reconciliação completa atrasada (> 26h) é sinalizada no incremental', async () => {
    const db = dbFalso(); const b = base();
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    await S.executarSyncIncremental({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: new Date(AG1.getTime() + 27 * 3600e3) });
    expect(db.st.compras_n0.meta.reconciliacao_atrasada).toBe(true);
  });
  test.each([
    ['API fora (503 persistente)', [503, 503, 503], false, /GC HTTP 503/],
    ['timeout persistente', ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'], false, /aborted/],
    ['429 persistente', [429, 429, 429], false, /GC HTTP 429/],
    ['401 (não repete)', [401], false, /GC HTTP 401/],
    ['429 e 5xx transitórios (repete e conclui)', [429, 502], true, null],
    ['timeout transitório (repete e conclui)', ['TIMEOUT'], true, null],
  ])('incremental com %s → último snapshot preservado quando falha', async (_, falhas, ok, re) => {
    const db = dbFalso(); const b = base();
    await S.executarSync({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }).cli, db, agora: AG1 });
    const antes = JSON.stringify({ p: db.st.compras_n0_produtos, r: db.st.compras_n0.resumo, e: db.st.estoque_snapshots, b: db.st.compras_n0_base });
    const r = await S.executarSyncIncremental({ cli: gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp, falhas }).cli, db, agora: AG2 });
    expect(r.ok).toBe(ok);
    if (!ok) {
      expect(JSON.stringify({ p: db.st.compras_n0_produtos, r: db.st.compras_n0.resumo, e: db.st.estoque_snapshots, b: db.st.compras_n0_base })).toBe(antes);
      expect(db.st.compras_n0.meta).toMatchObject({ ultima_tentativa_ok: false, ultima_tentativa_modo: 'INCREMENTAL', ultima_sincronizacao_ok: AG1.toISOString() });
      expect(db.st.compras_n0.meta.erro).toMatch(re);
    }
  });
  test('nenhuma escrita no GestãoClick: só GET sai, em completo e incremental', async () => {
    const db = dbFalso(); const b = base();
    const g1 = gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp }), g2 = gcFalso({ produtos: b.prods, vendas: b.vendas, compras: b.comp });
    await S.executarSync({ cli: g1.cli, db, agora: AG1 }); await S.executarSyncIncremental({ cli: g2.cli, db, agora: AG2 });
    expect([...g1.chamadas, ...g2.chamadas].every(c => c.method === 'GET')).toBe(true);
    for (const f of fs.readdirSync(path.join(__dirname, '../lib/compras'))) expect(fs.readFileSync(path.join(__dirname, '../lib/compras', f), 'utf8')).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
  });
  test('agendamento só pelos pontos de entrada aprovados (index.js); a biblioteca não agenda nada sozinha', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    expect(idx.match(/require\('\.\/lib\/compras\/[a-z]+'\)/g)).toEqual(["require('./lib/compras/entrypoints')"]);
    expect((idx.match(/exports\.compras[A-Za-z]+\s*=/g) || []).map(x => x.replace(/\s*=$/, ''))).toEqual(['exports.comprasSyncManual', 'exports.comprasSyncCompleto', 'exports.comprasSyncIncremental']);
    for (const f of fs.readdirSync(path.join(__dirname, '../lib/compras'))) expect(fs.readFileSync(path.join(__dirname, '../lib/compras', f), 'utf8')).not.toMatch(/onSchedule|pubsub\.schedule|require\('firebase-functions/);
  });
});
