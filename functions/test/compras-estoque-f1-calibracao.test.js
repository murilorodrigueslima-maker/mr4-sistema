'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 1 · calibração: demanda reservada, estoque negativo, políticas de cobertura
// por ABC (cenários lado a lado), prioridade, velocidade, fornecedores, snapshot diário e sync incremental.
const K = require('../lib/compras/canonico');
const M = require('../lib/compras/motor');
const C = require('../lib/compras/calibracao');
const F = require('../lib/compras/fetch');
const S = require('../lib/compras/snapshot');
const X = require('./fixtures/compras-estoque-f0');

const calc = (produtos, vendas, compras = []) => M.calcularTudo({ produtos: produtos.map(K.mapearProduto), fatosVenda: vendas.flatMap(K.fatosDeVenda), fatosCompra: compras.flatMap(K.fatosDeCompra), hoje: X.HOJE });
const um = (r, id) => r.metricas.find(m => m.product_id === id);
// métrica mínima para testar a política isoladamente
const mk = (o = {}) => ({ purchase_eligible: true, purchase_exclusions: [], policy_velocity: 0.5, available_stock_for_replenishment: 3, raw_stock: 3, units: { 90: 45 }, coverage: { estado: 'COVERAGE_CRITICAL' }, ...o });

describe('Demanda "Reservado" (rastreável e reversível)', () => {
  test('Reservado com baixa de estoque conta como demanda, identificado como RESERVED; Concretizada = COMPLETED', () => {
    const vs = [X.venda(X.dia(5), [['PR', 2]], { situacao: 'Reservado' }), X.venda(X.dia(6), [['PR', 3]]), X.venda(X.dia(7), [['PR', 9]], { situacao: 'Reservado', situacao_estoque: '0' })];
    expect(vs.map(v => K.origemDemanda(v))).toEqual(['RESERVED', 'COMPLETED', 'NOT_DEMAND']);
    const r = calc([X.produto('PR', { estoque: 4 })], vs, [X.compra(X.dia(100), [['PR', 10]])]);
    expect(um(r, 'PR').demand_by_source_90d).toEqual({ COMPLETED: 3, RESERVED: 2, OTHER_STOCK_MOVED: 0 });
    expect(um(r, 'PR').units[30]).toBe(5);
    expect(um(r, 'PR').reason_codes).toContain('RESERVED_DEMAND_INCLUDED');
  });
  test('Reservado depois CANCELADO: a versão mais nova substitui a antiga e a demanda some', () => {
    const v1 = X.venda(X.dia(5), [['PR', 2]], { id: 'VX-RES', situacao: 'Reservado' }); v1.modificado_em = '2026-09-23 10:00:00';
    const v2 = { ...v1, nome_situacao: 'Cancelada', modificado_em: '2026-09-25 09:00:00' };
    const antes = calc([X.produto('PR', { estoque: 4 })], [v1]);
    expect(um(antes, 'PR').demand_by_source_90d.RESERVED).toBe(2);
    const m1 = F.mesclarRegistros([v1], [v2]);
    expect(m1).toMatchObject({ inseridos: 0, substituidos: 1, ignorados: 0 });
    const depois = calc([X.produto('PR', { estoque: 4 })], m1.registros);
    expect(um(depois, 'PR').demand_by_source_90d).toEqual({ COMPLETED: 0, RESERVED: 0, OTHER_STOCK_MOVED: 0 });
    expect(um(depois, 'PR').never_sold).toBe(true);
    // uma versão MAIS ANTIGA chegando depois não ressuscita a reserva
    expect(F.mesclarRegistros(m1.registros, [v1])).toMatchObject({ substituidos: 0, ignorados: 1 });
  });
});

describe('Estoque negativo: RAW_STOCK × AVAILABLE_STOCK_FOR_REPLENISHMENT', () => {
  const vendas = id => X.serie(id, { de: 150, passo: 5, qtd: 1 });
  const r = calc(
    [X.produto('N1', { estoque: -1 }), X.produto('N10', { estoque: -10 }), X.produto('N0', { estoque: 0 }), X.produto('NSEM', { estoque: -3 }), X.produto('NINAT', { estoque: -2, ativo: '0' }), X.produto('NANOM', { estoque: -4 })],
    [...vendas('N1'), ...vendas('N10'), ...vendas('N0'), X.venda(X.dia(200), [['NSEM', 5]]), ...vendas('NINAT')],
    [X.compra(X.dia(160), [['N1', 30], ['N10', 30], ['N0', 30], ['NSEM', 5], ['NINAT', 30]])]);
  test('-1 e -10 geram a MESMA quantidade que estoque 0 (nenhuma compra extra para compensar o negativo)', () => {
    for (const n of Object.keys(M.PARAMS.CENARIOS)) {
      expect(um(r, 'N1').scenarios[n].suggested_qty).toBe(um(r, 'N0').scenarios[n].suggested_qty);
      expect(um(r, 'N10').scenarios[n].suggested_qty).toBe(um(r, 'N0').scenarios[n].suggested_qty);
    }
    expect(um(r, 'N10')).toMatchObject({ raw_stock: -10, available_stock_for_replenishment: 0 });
    expect(um(r, 'N10').reason_codes).toEqual(expect.arrayContaining(['NEGATIVE_STOCK', 'STOCKOUT_RECENT_DEMAND']));
  });
  test('classificação sem presumir causa', () => {
    expect(um(r, 'N1').negative_stock_class).toBe('NEGATIVE_WITH_RECENT_SALES');
    expect(um(r, 'NSEM').negative_stock_class).toBe('NEGATIVE_WITHOUT_RECENT_SALES');
    expect(um(r, 'NINAT').negative_stock_class).toBe('NEGATIVE_INACTIVE_PRODUCT');
    expect(um(r, 'NANOM').negative_stock_class).toBe('NEGATIVE_DATA_ANOMALY');   // negativo sem venda e sem compra registradas
    const neg = C.resumoCalibracao(r).negativos;
    expect(neg.total).toBe(5); expect(neg.compra_extra_para_compensar_negativo).toBe(0);
    expect(neg.magnitude).toEqual({ '-1': 1, '-2..-5': 3, '-6..-10': 1, '<-10': 0 });
  });
});

describe('Política de cobertura por classe (sem lead time) e arredondamento', () => {
  test.each([
    ['CONSERVATIVE', 'A', 20], ['BALANCED', 'A', 12], ['LEAN', 'A', 8],
    ['CONSERVATIVE', 'B', 12], ['BALANCED', 'B', 8], ['LEAN', 'B', 5],
    ['CONSERVATIVE', 'C', 5], ['BALANCED', 'C', 5], ['LEAN', 'C', 1],
  ])('%s classe %s → %i un (velocidade 0,5/dia, estoque 3)', (cen, classe, qtd) => {
    const s = M.aplicarPolitica(mk(), classe, M.PARAMS.CENARIOS[cen][classe]);
    expect(s.target_stock).toBeCloseTo(0.5 * M.PARAMS.CENARIOS[cen][classe], 6); expect(s.suggested_qty).toBe(qtd);   // qtd = ceil(0,5 × dias − 3)
  });
  test('arredondamento CEIL garante mínimo de 1 quando há necessidade fracionária; ROUND pode zerar', () => {
    const m = mk({ policy_velocity: 0.01, available_stock_for_replenishment: 0, raw_stock: 0 });
    expect(M.aplicarPolitica(m, 'C', 7).suggested_qty).toBe(1);
    expect(M.aplicarPolitica(m, 'C', 7, { arredondamento: 'ROUND' }).suggested_qty).toBe(0);
  });
  test('estoque já acima do alvo → 0 (sem prioridade)', () => {
    expect(M.aplicarPolitica(mk({ available_stock_for_replenishment: 100, raw_stock: 100 }), 'A', 45)).toMatchObject({ suggested_qty: 0, needs_purchase: false, priority: null });
  });
  test('sem velocidade, nunca vendido, novo e inativo → SUGGESTED_QTY=0 com o motivo', () => {
    expect(M.aplicarPolitica(mk({ policy_velocity: 0 }), 'A', 45)).toMatchObject({ suggested_qty: 0, excluded_by: ['NO_VELOCITY'] });
    for (const ex of ['NEVER_SOLD', 'NEW_PRODUCT', 'INACTIVE_PRODUCT']) expect(M.aplicarPolitica(mk({ purchase_eligible: false, purchase_exclusions: [ex] }), 'A', 45)).toMatchObject({ suggested_qty: 0, excluded_by: [ex] });
  });
});

describe('Prioridade determinística (não é "comprar imediatamente")', () => {
  test.each([
    ['A + ruptura + demanda', 'A', { raw_stock: 0 }, 'P1'],
    ['A + negativo + demanda', 'A', { raw_stock: -2 }, 'P1'],
    ['A + cobertura abaixo do alvo (crítica)', 'A', { raw_stock: 3 }, 'P2'],
    ['A + cobertura abaixo do alvo (baixa)', 'A', { raw_stock: 10, coverage: { estado: 'COVERAGE_LOW' } }, 'P2'],
    ['B + ruptura + demanda', 'B', { raw_stock: 0, coverage: { estado: 'CURRENT_STOCKOUT' } }, 'P3'],
    ['B + negativo + demanda', 'B', { raw_stock: -1, coverage: { estado: 'NEGATIVE_STOCK' } }, 'P3'],
    ['B + cobertura crítica (sem ruptura)', 'B', { raw_stock: 3 }, 'P4'],
    ['C + ruptura + demanda', 'C', { raw_stock: 0, coverage: { estado: 'CURRENT_STOCKOUT' } }, 'P4'],
    ['A + ruptura SEM demanda recente', 'A', { raw_stock: 0, units: { 90: 0 } }, 'P4'],
  ])('%s → %s', (_, classe, o, p) => { expect(M.prioridade(mk(o), classe)).toBe(p); });
});

describe('Sinal de velocidade (limiares explícitos)', () => {
  test.each([
    [{ u30: 10, u90: 15, u180: 20, diasObservado: 200, novo: false }, 'RECENT_ACCELERATION'],
    [{ u30: 5, u90: 15, u180: 18, diasObservado: 200, novo: false }, 'RECENT_ACCELERATION'],    // 90d ≫ 90d anteriores, sem queda em 30d
    [{ u30: 1, u90: 15, u180: 25, diasObservado: 200, novo: false }, 'RECENT_DECELERATION'],
    [{ u30: 3, u90: 9, u180: 40, diasObservado: 200, novo: false }, 'RECENT_DECELERATION'],     // parou em relação ao semestre anterior
    [{ u30: 5, u90: 15, u180: 30, diasObservado: 200, novo: false }, 'STABLE'],
    [{ u30: 2, u90: 3, u180: 5, diasObservado: 200, novo: false }, 'INSUFFICIENT_HISTORY'],
    [{ u30: 9, u90: 20, u180: 20, diasObservado: 60, novo: false }, 'INSUFFICIENT_HISTORY'],
  ])('%j → %s', (e, s) => { expect(M.sinalVelocidade(e)).toBe(s); });
  test('aceleração recente não é penalizada pela média longa; desaceleração é sinalizada (velocidade de política = 90d)', () => {
    const r = calc([X.produto('ACC', { estoque: 5 }), X.produto('DEC', { estoque: 5 })],
      [...X.serie('ACC', { de: 89, ate: 31, passo: 20, qtd: 1 }), ...X.serie('ACC', { de: 29, passo: 2, qtd: 2 }), ...X.serie('DEC', { de: 89, ate: 61, passo: 2, qtd: 2 }), X.venda(X.dia(15), [['DEC', 1]])],
      [X.compra(X.dia(200), [['ACC', 60], ['DEC', 60]])]);
    const a = um(r, 'ACC'), d = um(r, 'DEC');
    // Política 1.0: 30d só SINALIZA — a velocidade usada é sempre a média de 90d (aceleração e desaceleração)
    expect(a.velocity_signal).toBe('RECENT_ACCELERATION'); expect(a.policy_velocity).toBe(a.avg_daily[90]); expect(a.reason_codes).toContain('RECENT_ACCELERATION');
    expect(d.velocity_signal).toBe('RECENT_DECELERATION'); expect(d.policy_velocity).toBe(d.avg_daily[90]); expect(d.reason_codes).toContain('RECENT_DECELERATION');
    // modo de calibração MAX_30D_90D (não é política) — só para comparação
    const { POLITICA_1_0 } = require('../lib/compras/politica');
    const alt = { ...POLITICA_1_0, velocity: { ...POLITICA_1_0.velocity, acceleration_behavior: 'MAX_30D_90D' } };
    const r2 = M.calcularTudo({ produtos: [X.produto('ACC', { estoque: 5 })].map(K.mapearProduto), fatosVenda: [...X.serie('ACC', { de: 89, ate: 31, passo: 20, qtd: 1 }), ...X.serie('ACC', { de: 29, passo: 2, qtd: 2 })].flatMap(K.fatosDeVenda), fatosCompra: [X.compra(X.dia(200), [['ACC', 60]])].flatMap(K.fatosDeCompra), hoje: X.HOJE, politica: alt });
    expect(r2.metricas[0].policy_velocity).toBe(r2.metricas[0].avg_daily[30]);
  });
  test('vendeu historicamente e parou → SALES_STOPPED_RECENTLY', () => {
    const r = calc([X.produto('STOP', { estoque: 20 })], X.serie('STOP', { de: 300, ate: 70, passo: 20, qtd: 1 }), [X.compra(X.dia(320), [['STOP', 40]])]);
    expect(um(r, 'STOP').sales_stopped_recently).toBe(true); expect(um(r, 'STOP').reason_codes).toContain('SALES_STOPPED_RECENTLY');
  });
});

describe('Calibração sobre o cenário completo (agregados, lado a lado)', () => {
  const c = X.cenario();
  const r = calc(c.produtos, c.vendas, c.compras);
  const cal = C.resumoCalibracao(r);
  test('os três cenários existem e nenhum é "escolhido"', () => {
    expect(Object.keys(cal.cenarios)).toEqual(['CONSERVATIVE', 'BALANCED', 'LEAN']);
    expect(JSON.stringify(cal)).not.toMatch(/recomendado|vencedor|escolhido/i);
  });
  test('conservador ≥ equilibrado ≥ enxuto em unidades; por classe soma o total', () => {
    const u = n => cal.cenarios[n].UNITS_TO_BUY;
    expect(u('CONSERVATIVE')).toBeGreaterThanOrEqual(u('BALANCED')); expect(u('BALANCED')).toBeGreaterThanOrEqual(u('LEAN'));
    for (const s of Object.values(cal.cenarios)) {
      expect(s.por_classe.A.produtos + s.por_classe.B.produtos + s.por_classe.C.produtos).toBe(s.PRODUCTS_TO_BUY);
      expect(Object.values(s.prioridade).reduce((t, p) => t + p.produtos, 0)).toBe(s.PRODUCTS_TO_BUY);
    }
  });
  test('nunca vendido, inativo e excesso ficam fora de compra em TODOS os cenários', () => {
    for (const s of Object.values(cal.cenarios)) {
      expect(s.NEVER_SOLD_EXCLUDED).toBe(r.agregados.nunca_vendido.length);
      expect(s.INACTIVE_EXCLUDED).toBe(1); expect(s.excess_products_with_purchase).toBe(0);
      expect(s.EXCESS_PRODUCTS_EXCLUDED).toBe(r.agregados.cobertura_excesso.length);
    }
    expect(cal.nunca_vendidos.excluidos_de_compra).toBe(cal.nunca_vendidos.total);
  });
  test('agrupamento por fornecedor (último fornecedor comprovado)', () => {
    expect(cal.cenarios.BALANCED.fornecedores).toEqual({ SUPPLIER_GROUP_COUNT: 3, sem_fornecedor: 0, PRODUCTS_PER_SUPPLIER: { max: 3, mediana: 1 }, SUGGESTED_UNITS_PER_SUPPLIER: { max: 17, mediana: 16 } });   // FX-1: 6+6+5 · FX-2: 16 · FX-3: 5
  });
  test('ruptura com demanda recente 30/60/90 é cumulativa e separada da ruptura sem demanda', () => {
    const z = cal.ruptura;
    expect(z.STOCKOUT_WITH_RECENT_DEMAND_30D).toBeLessThanOrEqual(z.STOCKOUT_WITH_RECENT_DEMAND_60D);
    expect(z.STOCKOUT_WITH_RECENT_DEMAND_60D).toBeLessThanOrEqual(z.STOCKOUT_WITH_RECENT_DEMAND_90D);
    expect(z.STOCKOUT_WITH_RECENT_DEMAND_90D + z.STOCKOUT_WITHOUT_RECENT_DEMAND).toBe(z.total_zerados);
  });
  test('matriz parado ABC × faixa bate com as listas de parado; C parado aparece', () => {
    const tot = Object.values(cal.matriz_parado).reduce((t, l) => t + Object.values(l).reduce((a, b) => a + b, 0), 0);
    expect(tot).toBe(Object.values(r.agregados.parado).reduce((t, l) => t + l.length, 0));
    expect(cal.matriz_parado.C['120+'] + cal.matriz_parado.C['180+']).toBeGreaterThanOrEqual(2);
    expect(cal.por_classe.C.sem_venda_180d).toBeGreaterThanOrEqual(1);
  });
  test('Curva A em ruptura → P1; Curva A em excesso → sem compra', () => {
    const a = r.metricas.filter(m => m.abc_revenue === 'A');
    for (const m of a.filter(x => x.raw_stock <= 0 && x.purchase_eligible)) expect(m.scenarios.BALANCED.priority).toBe('P1');
    for (const m of a.filter(x => x.coverage.estado === 'COVERAGE_EXCESS')) expect(m.scenarios.CONSERVATIVE.suggested_qty).toBe(0);
  });
  test('sensibilidade da demanda mínima (1/2/3 un em 90d): menos exigente ⇒ mais produtos; nunca vendido segue fora', () => {
    const d = cal.sensibilidade_demanda_minima_90d;
    expect(d.min_1un.BALANCED.produtos).toBeGreaterThanOrEqual(d.min_2un.BALANCED.produtos);
    expect(d.min_2un.BALANCED.produtos).toBeGreaterThanOrEqual(d.min_3un.BALANCED.produtos);
    expect(d.min_3un.BALANCED.produtos).toBe(cal.cenarios.BALANCED.PRODUCTS_TO_BUY);
    // caso dedicado: ruptura com 2 un em 90d só entra com mínimo ≤ 2; nunca vendido nunca entra
    const r2 = calc([X.produto('D2', { estoque: 0 }), X.produto('D1', { estoque: 0 }), X.produto('NV', { estoque: 0 })],
      [X.venda(X.dia(20), [['D2', 1]]), X.venda(X.dia(50), [['D2', 1]]), X.venda(X.dia(40), [['D1', 1]])], [X.compra(X.dia(300), [['D2', 5], ['D1', 5], ['NV', 5]])]);
    const s2 = C.resumoCalibracao(r2).sensibilidade_demanda_minima_90d;
    expect([s2.min_1un.BALANCED.produtos, s2.min_2un.BALANCED.produtos, s2.min_3un.BALANCED.produtos]).toEqual([2, 1, 0]);
    expect(s2.min_1un.BALANCED.ruptura_com_demanda_coberta).toBe('2/2');
  });
  test('janelas de produto novo 30/60/90 são monotônicas e mostram o que mudaria', () => {
    const j = cal.janelas_produto_novo;
    expect(j['30d'].novos).toBeLessThanOrEqual(j['60d'].novos); expect(j['60d'].novos).toBeLessThanOrEqual(j['90d'].novos);
    expect(j['30d'].a_mais_que_30d).toBe(0);
    expect(j['60d'].a_mais_que_30d).toBe(j['60d'].novos - j['30d'].novos);
  });
  test('detalhe da Curva A usa ID mascarado e não tem nome/valor', () => {
    const d = C.detalheCurvaA(r, id => 'A-' + String(id).length);
    expect(d.length).toBe(r.metricas.filter(m => m.abc_revenue === 'A').length);
    expect(JSON.stringify(d)).not.toMatch(/PX-|Produto sintético|_cents/);
    expect(Object.keys(d[0])).toEqual(['id', 'current_stock', 'sales_30d', 'sales_60d', 'sales_90d', 'average_daily_sales', 'coverage_days', 'coverage_state', 'suggested_qty', 'stockout', 'negative_stock', 'velocity_signal', 'last_sale_date']);
  });
  test('custo: valor de compra por cenário SÓ para KNOWN_COST e só no documento de custo', () => {
    const snap = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA });
    for (const k of snap.custos) for (const v of Object.values(k.scenario_purchase_value_known_cost_only_cents)) if (v !== null) expect(k.cost_confidence).toBe('KNOWN_COST');
    expect(JSON.stringify(snap.resumo.calibracao)).not.toMatch(/_cents/);
    expect(snap.resumo.limitacoes.join(' ')).toMatch(/PURCHASE_AFFORDABILITY=BLOCKED/);
    expect(snap.resumo.limitacoes.join(' ')).toMatch(/POLÍTICA DE COBERTURA/);
  });
});

describe('Snapshot diário de estoque (opção A × B)', () => {
  test('delta registra só mudanças, produto novo e produto removido', () => {
    expect(S.snapshotDelta({ a: 1, b: 2, c: 3 }, { a: 1, b: 0, d: 7 })).toEqual({ b: 0, d: 7, c: null });
  });
  test('reconstrução por baseline + deltas = snapshot completo do dia (A e B equivalentes)', () => {
    const dias = { '2026-09-01': { a: 5, b: 2 }, '2026-09-02': { a: 4, b: 2 }, '2026-09-03': { a: 4, b: 0, c: 9 }, '2026-09-04': { b: 0, c: 8 } };
    const ds = Object.keys(dias);
    const baseline = { data: ds[0], saldos: dias[ds[0]] };
    const deltas = ds.slice(1).map((d, i) => ({ data: d, mudancas: S.snapshotDelta(dias[ds[i]], dias[d]) }));
    for (const d of ds) expect(S.reconstruirSaldos(baseline, deltas, d)).toEqual(dias[d]);
    expect(() => S.reconstruirSaldos({ data: '2026-09-05', saldos: {} }, deltas, '2026-09-03')).toThrow(/SEM_BASELINE/);
  });
  test('snapshot completo é gravado 1×/dia pelo sync (idempotente no mesmo dia)', async () => {
    const st = {};
    const ref = (c, id) => ({ id, set: async v => { (st[c] = st[c] || {})[id] = v; }, get: async () => ({ data: () => st[c] && st[c][id] }), delete: async () => {} });
    const db = { collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: [] }) }), batch: () => { const o = []; return { set: (r, v) => o.push(() => r.set(v)), commit: async () => { for (const f of o) await f(); } }; } };
    const c = X.cenario();
    const snap = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA });
    await S.persistirSnapshot(db, snap); await S.persistirSnapshot(db, snap);
    expect(Object.keys(st.estoque_snapshots)).toEqual(['2026-09-28']);
    expect(Object.keys(st.estoque_snapshots['2026-09-28'].saldos).length).toBe(c.produtos.length);
  });
  test('estimativa de armazenamento: cresce com os anos; B < A', () => {
    const e = n => S.estimarArmazenamento({ produtos: 877, bytesPorProduto: 16, mudancasPorDia: 60, anos: n });
    expect(e(1).opcao_A_bytes).toBeLessThan(e(2).opcao_A_bytes); expect(e(2).opcao_A_bytes).toBeLessThan(e(5).opcao_A_bytes);
    expect(e(5).opcao_B_bytes).toBeLessThan(e(5).opcao_A_bytes);
  });
});

describe('Sync incremental (planejamento/simulação, nada agendado)', () => {
  test('plano: todos os produtos + vendas/compras pela retrovisão + janela futura', () => {
    expect(F.planoIncremental('2026-09-28', 60)).toEqual({ produtos: 'TODOS', vendas: { inicio: '2026-07-30', fim: '2026-09-28', futura: true }, compras: { inicio: '2026-07-30', fim: '2026-09-28', futura: true }, lookback_dias: 60 });
  });
  test('defasagem modificação × data da venda dimensiona a retrovisão', () => {
    const reg = [
      { id: 1, data: '2026-09-01', cadastrado_em: '2026-09-01 10:00:00', modificado_em: '2026-09-01 10:00:00' },   // não modificado depois
      { id: 2, data: '2026-09-01', cadastrado_em: '2026-09-01 10:00:00', modificado_em: '2026-09-11 10:00:00' },   // 10 dias
      { id: 3, data: '2026-06-01', cadastrado_em: '2026-06-01 10:00:00', modificado_em: '2026-09-09 10:00:00' },   // 100 dias
      { id: 4, data: '2026-09-30', cadastrado_em: '2026-07-14 10:00:00', modificado_em: '2026-07-20 10:00:00' },   // data futura
    ];
    const a = F.analisarDefasagem(reg, 'data', [7, 15, 120]);
    expect(a).toMatchObject({ registros: 4, modificados_apos_cadastro: 3, data_negocio_futura_no_cadastro: 1 });
    expect(a.cobertura_por_lookback_pct).toEqual({ '7d': 33.33, '15d': 66.67, '120d': 100 });
  });
  test('estimativa de GETs por janela (100 por página) + conferência ampla', () => {
    const reg = Array.from({ length: 250 }, (_, i) => ({ data: '2026-09-' + String(1 + (i % 28)).padStart(2, '0') }));
    expect(F.estimarChamadas(reg, 'data', { inicio: '2026-08-01', fim: '2026-09-28' })).toEqual({ janelas: 3, chamadas: 1 + 3 + 1 + 1 });
  });
});
