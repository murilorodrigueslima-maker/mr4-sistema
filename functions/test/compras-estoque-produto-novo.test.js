'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — exceção PRODUTO NOVO COM DEMANDA COMPROVADA (estrutura configurável, DESATIVADA
// na Política 1.0) + proteção de crescimento/tamanho do armazenamento.
const fs = require('fs'), path = require('path');
const K = require('../lib/compras/canonico');
const M = require('../lib/compras/motor');
const C = require('../lib/compras/calibracao');
const S = require('../lib/compras/snapshot');
const Pol = require('../lib/compras/politica');
const X = require('./fixtures/compras-estoque-f0');
const { POLITICA_1_0, POLITICA_VIGENTE, REGRAS_EXPERIMENTAIS_PRODUTO_NOVO: REGRAS, METODOS_QTD_PRODUTO_NOVO: METODOS } = Pol;

const calc = (c, politica = POLITICA_1_0) => M.calcularTudo({ produtos: c.produtos.map(K.mapearProduto), fatosVenda: c.vendas.flatMap(K.fatosDeVenda), fatosCompra: c.compras.flatMap(K.fatosDeCompra), hoje: X.HOJE, politica });
const um = (r, id) => r.metricas.find(m => m.product_id === id);
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/compras-politica-1-0-golden.json'), 'utf8'));
const linha = m => [m.product_id, m.purchase_eligible, m.purchase_exclusions.join('|'), m.suggestion.suggested_qty, m.suggestion.priority, m.policy_velocity, m.coverage.estado, m.coverage.dias, m.reason_codes.join('|'), m.dead_stock_band, m.new_product, m.suggestion.target_days, m.suggestion.calculated_need];
const E25 = { ...REGRAS.E, rate_rule: { type: 'MIN_OBSERVED_DAILY_RATE', min_daily_rate: 0.25 } };   // limiar de TESTE (não é o real)
const exp = (rot, regra) => Pol.politicaExperimental(POLITICA_1_0, rot, regra);

// ═════════════════════════ POLICY_1_0_UNCHANGED ═════════════════════════
describe('POLICY_1_0_UNCHANGED — reproduz exatamente o b3b13dc', () => {
  test.each([['cenario', 'produtos'], ['cenarioProdutoNovo', 'produto_novo'], ['cenarioProdutoNovoABC', 'produto_novo_abc']])('fixture %s idêntica ao golden gerado com b3b13dc', (fn, chave) => {
    const c = X[fn]();
    const s = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: POLITICA_1_0 });
    expect(s.operacional.map(linha)).toEqual(GOLDEN[chave]);
  });
  test('Política 1.0 não contém a exceção; continua 1.0, válida e preservada no registro', () => {
    expect(POLITICA_1_0.new_product.proven_demand).toBeUndefined();
    expect(POLITICA_1_0.policy_version).toBe('1.0'); expect(Pol.POLITICAS['1.0']).toBe(POLITICA_1_0); expect(Pol.validarPolitica(POLITICA_1_0)).toEqual([]);
    expect(GOLDEN.gerado_com).toBe('b3b13dc');
  });
  test('na 1.0, todo produto novo fica fora da sugestão (NEW_PRODUCT), mesmo com demanda forte', () => {
    const r = calc(X.cenarioProdutoNovo());
    for (const m of r.metricas.filter(x => x.new_product)) { expect(m.purchase_exclusions).toContain('NEW_PRODUCT'); expect(m.suggestion.suggested_qty).toBe(0); expect(m.new_product_proven_demand).toBeNull(); }
  });
});

// ═════════════════════════ STRUCTURE ═════════════════════════
describe('STRUCTURE — regra configurável e versionada', () => {
  test('candidatas A–D válidas; E exige limiar derivado dos dados', () => {
    for (const k of ['A', 'B', 'C', 'D']) expect(Pol.validarRegraProdutoNovo(REGRAS[k])).toEqual([]);
    expect(Pol.validarRegraProdutoNovo(REGRAS.E).join(' ')).toMatch(/min_daily_rate obrigatório/);
    expect(Pol.validarRegraProdutoNovo(E25)).toEqual([]);
  });
  test.each([
    ['sem unidades', { ...REGRAS.C, minimum_units: 0 }, /minimum_units deve ser ≥ 1/],
    ['idade negativa', { ...REGRAS.C, minimum_age_days: -1 }, /minimum_age_days/],
    ['método inválido', { ...REGRAS.C, quantity_velocity: 'MAIOR' }, /quantity_velocity/],
    ['reservado indefinido', { ...REGRAS.C, count_reserved: undefined }, /count_reserved/],
  ])('validação rejeita: %s', (_, r, re) => { expect(Pol.validarRegraProdutoNovo(r).join(' ')).toMatch(re); });
  test('política experimental: sufixo +EXP, congelada, nunca 1.1 nem vigente; a 1.0 não muda', () => {
    const p = exp('C', REGRAS.C);
    expect(p.policy_version).toBe('1.0+EXP-C'); expect(p.policy_version).not.toMatch(/^1\.1/); expect(POLITICA_VIGENTE).not.toBe(p); expect(Pol.POLITICAS['1.0']).toBe(POLITICA_1_0);
    expect(Object.isFrozen(p.new_product.proven_demand)).toBe(true); expect(Pol.validarPolitica(p)).toEqual([]);
    expect(Pol.validarPolitica(exp('E', REGRAS.E)).join(' ')).toMatch(/min_daily_rate/);
    expect(POLITICA_1_0.new_product.proven_demand).toBeUndefined();
  });
});

// ═════════════════════════ EVIDENCE ═════════════════════════
describe('EVIDENCE — fatos de demanda do produto novo (sem regra)', () => {
  const r = calc(X.cenarioProdutoNovo());
  const ev = id => um(r, id).new_product_evidence;
  test.each([
    ['NV-SEM', { units_since_first_evidence: 0, distinct_sale_days: 0, age_days: 20 }],
    ['NV-UMA', { units_since_first_evidence: 1, distinct_sale_days: 1 }],
    ['NV-DIA1', { units_since_first_evidence: 10, distinct_sale_days: 1, largest_single_day_units: 10 }],
    ['NV-DOIS', { units_since_first_evidence: 3, distinct_sale_days: 2 }],
    ['NV-TRES', { units_since_first_evidence: 6, distinct_sale_days: 3, observed_daily_rate: 0.3 }],
    ['NV-CANC', { units_since_first_evidence: 2, distinct_sale_days: 1 }],                       // canceladas não contam
    ['NV-RES', { units_since_first_evidence: 6, completed_units: 0, reserved_units: 6 }],
    ['NV-MISTO', { units_since_first_evidence: 6, completed_units: 4, reserved_units: 2 }],
    ['NV-I6', { age_days: 6 }], ['NV-I7', { age_days: 7 }], ['NV-I59', { age_days: 59 }],
  ])('%s', (id, esperado) => { expect(ev(id)).toMatchObject(esperado); });
  test('idade 60 e 61: não são novos (sem evidência de novo; seguem a regra normal)', () => {
    for (const id of ['NV-I60', 'NV-I61']) { expect(um(r, id).new_product).toBe(false); expect(um(r, id).new_product_evidence).toBeNull(); }
  });
});

// ═════════════════════════ RULES ═════════════════════════
describe('RULES — candidatas A/B/C/D/E sobre a evidência', () => {
  const r = calc(X.cenarioProdutoNovo());
  const aceita = (id, regra) => M.avaliarDemandaComprovada(um(r, id).new_product_evidence, regra).accepted;
  const IDS = ['NV-SEM', 'NV-UMA', 'NV-DIA1', 'NV-DOIS', 'NV-TRES', 'NV-CANC', 'NV-RES', 'NV-MISTO', 'NV-NEG', 'NV-I6', 'NV-I7', 'NV-I59'];
  const esperado = {   // ✓ por regra (E com limiar de teste 0,25/dia)
    A: ['NV-UMA', 'NV-DIA1', 'NV-DOIS', 'NV-TRES', 'NV-CANC', 'NV-RES', 'NV-MISTO', 'NV-NEG', 'NV-I6', 'NV-I7', 'NV-I59'],
    B: ['NV-DOIS', 'NV-TRES', 'NV-RES', 'NV-MISTO', 'NV-NEG', 'NV-I6', 'NV-I7', 'NV-I59'],
    C: ['NV-TRES', 'NV-RES', 'NV-MISTO', 'NV-NEG', 'NV-I6', 'NV-I7', 'NV-I59'],
    D: ['NV-TRES', 'NV-RES', 'NV-MISTO', 'NV-NEG', 'NV-I7', 'NV-I59'],
    E: ['NV-TRES', 'NV-RES', 'NV-MISTO', 'NV-I7'],
  };
  test.each(Object.keys(esperado))('regra %s aceita exatamente os esperados', k => {
    const regra = k === 'E' ? E25 : REGRAS[k];
    expect(IDS.filter(id => aceita(id, regra))).toEqual(esperado[k]);
  });
  test('proteção contra venda isolada: 10 un num único pedido só passa na regra A', () => {
    expect(['A', 'B', 'C', 'D'].filter(k => aceita('NV-DIA1', REGRAS[k]))).toEqual(['A']);
    expect(aceita('NV-DIA1', E25)).toBe(false);
    expect(M.avaliarDemandaComprovada(um(r, 'NV-DIA1').new_product_evidence, REGRAS.C).failed).toEqual(['MIN_DISTINCT_SALE_DAYS']);
  });
  test('idade 6 × 7: a exigência de idade mínima (D/E) separa', () => {
    expect(M.avaliarDemandaComprovada(um(r, 'NV-I6').new_product_evidence, REGRAS.D).failed).toEqual(['MIN_AGE']);
    expect(aceita('NV-I7', REGRAS.D)).toBe(true);
  });
  test('reservado explícito: com count_reserved=false, "só reservado" não prova demanda e o misto perde unidades', () => {
    const semRes = { ...REGRAS.C, count_reserved: false };
    expect(aceita('NV-RES', semRes)).toBe(false); expect(aceita('NV-MISTO', semRes)).toBe(false);   // 4 concluídas < 5
    expect(aceita('NV-RES', REGRAS.C)).toBe(true);
  });
  test('cancelamento: vendas canceladas não contam (C rejeita o que só teria unidades com as canceladas)', () => {
    expect(aceita('NV-CANC', REGRAS.C)).toBe(false);
  });
  test('regra desativada nunca aceita', () => {
    expect(M.avaliarDemandaComprovada(um(r, 'NV-TRES').new_product_evidence, { ...REGRAS.C, enabled: false })).toEqual({ accepted: false, failed: ['RULE_DISABLED'] });
  });
});

// ═════════════════════════ ENABLED_BEHAVIOR (política experimental; NÃO é a vigente) ═════════════════════════
describe('ENABLED_BEHAVIOR — com a exceção ligada numa política experimental', () => {
  const c = X.cenarioProdutoNovo();
  const rC = calc(c, exp('C', REGRAS.C));
  test('aceito: sai NEW_PRODUCT da exclusão, entra NEW_PRODUCT_WITH_PROVEN_DEMAND, continua novo e nunca "parado"', () => {
    const m = um(rC, 'NV-TRES');
    expect(m.purchase_exclusions).toEqual([]); expect(m.reason_codes).toEqual(expect.arrayContaining(['NEW_PRODUCT', 'NEW_PRODUCT_WITH_PROVEN_DEMAND']));
    expect(m.new_product).toBe(true); expect(m.dead_stock_band).toBeNull();
    const alvo = { A: 30, B: 21, C: 15 }[m.abc_revenue];
    expect(m.suggestion.suggested_qty).toBe(Math.ceil(0.3 * alvo - 1e-9)); expect(m.suggestion.policy_version).toBe('1.0+EXP-C');
  });
  test('estoque negativo: quantidade parte de 0 e mantém NEGATIVE_STOCK', () => {
    const m = um(rC, 'NV-NEG');
    expect(m.available_stock_for_replenishment).toBe(0); expect(m.reason_codes).toContain('NEGATIVE_STOCK');
    expect(m.suggestion.suggested_qty).toBe(Math.ceil(0.2 * { A: 30, B: 21, C: 15 }[m.abc_revenue] - 1e-9));
  });
  test('sem venda, inativo e venda cancelada continuam fora', () => {
    expect(um(rC, 'NV-SEM').suggestion.suggested_qty).toBe(0);
    expect(um(rC, 'NV-INAT').purchase_exclusions).toEqual(['INACTIVE_PRODUCT']); expect(um(rC, 'NV-INAT').suggestion.suggested_qty).toBe(0);
    expect(um(rC, 'NV-CANC').purchase_exclusions).toContain('NEW_PRODUCT');
  });
  test('idade 60/61 (maduros) têm exatamente o mesmo resultado da 1.0', () => {
    const r10 = calc(c);
    for (const id of ['NV-I60', 'NV-I61', 'MA']) expect(linha(um(rC, id)).slice(1, 11)).toEqual(linha(um(r10, id)).slice(1, 11));
  });
  test('classes A/B/C: alvo 30/21/15 aplicado ao produto novo aceito', () => {
    const r = calc(X.cenarioProdutoNovoABC(), exp('B', REGRAS.B));
    expect(['NX', 'NY', 'NZ'].map(id => um(r, id).abc_revenue)).toEqual(['A', 'B', 'C']);
    expect(['NX', 'NY', 'NZ'].map(id => um(r, id).suggestion.suggested_qty)).toEqual([9, 7, 3]);   // 0,3×30 · 0,3×21 · 0,2×15
  });
  test('métodos de quantidade 1/2/3: definição e ordem (3 = mínimo, nunca maior que 1 ou 2)', () => {
    const r = calc(c);
    for (const m of r.metricas.filter(x => x.new_product_evidence && x.new_product_evidence.units_since_first_evidence > 0)) {
      const ev = m.new_product_evidence;
      const v1 = M.velocidadeProdutoNovo(ev, METODOS.METODO_1), v2 = M.velocidadeProdutoNovo(ev, METODOS.METODO_2), v3 = M.velocidadeProdutoNovo(ev, METODOS.METODO_3);
      expect(v1).toBe(ev.observed_daily_rate); expect(v2).toBe(ev.signal_window_rate); expect(v3).toBe(Math.min(v1, v2));
    }
    const i59 = um(r, 'NV-I59').new_product_evidence;   // 59 dias: 30d (4 un/30) difere da observada (6 un/59)
    expect(i59.signal_window_rate).toBeCloseTo(0.133, 3); expect(i59.observed_daily_rate).toBeCloseTo(0.102, 3);
    expect(M.velocidadeProdutoNovo(i59, METODOS.METODO_3)).toBeCloseTo(0.102, 3);
    expect(() => M.velocidadeProdutoNovo(i59, 'QUALQUER')).toThrow(/METODO_QTD_PRODUTO_NOVO_INVALIDO/);
  });
  test('método configurado é o usado na quantidade', () => {
    const r2 = calc(c, exp('C-M2', { ...REGRAS.C, quantity_velocity: METODOS.METODO_2 }));
    expect(um(r2, 'NV-I59').policy_velocity).toBe(um(r2, 'NV-I59').new_product_evidence.signal_window_rate);
  });
  test('análise de sensibilidade: contagens coerentes, venda isolada visível e detalhe mascarado', () => {
    const r10 = calc(c);
    const a = C.analisarProdutoNovo(r10, { A: REGRAS.A, B: REGRAS.B, C: REGRAS.C, D: REGRAS.D, E: E25 }, { mascarar: id => 'N-' + id.length });
    expect(a.NEW_PRODUCTS_TOTAL).toBe(14); expect(a.NEW_PRODUCTS_WITH_DEMAND).toBe(13);   // todos os novos menos NV-SEM
    expect(a.por_regra.A.NEW_PRODUCTS_ELIGIBLE).toBeGreaterThanOrEqual(a.por_regra.B.NEW_PRODUCTS_ELIGIBLE);
    expect(a.por_regra.B.NEW_PRODUCTS_ELIGIBLE).toBeGreaterThanOrEqual(a.por_regra.C.NEW_PRODUCTS_ELIGIBLE);
    expect(a.por_regra.C.NEW_PRODUCTS_ELIGIBLE).toBeGreaterThanOrEqual(a.por_regra.D.NEW_PRODUCTS_ELIGIBLE);
    expect(a.por_regra.A.aceitos_com_venda_unica_grande).toBeGreaterThan(0); expect(a.por_regra.C.aceitos_com_venda_unica_grande).toBe(0);
    expect(a.por_regra.C.aceitos_so_com_reservado).toBe(1);
    for (const rg of Object.values(a.por_regra)) for (const mt of Object.values(rg.metodos)) expect(mt.por_abc.A.produtos + mt.por_abc.B.produtos + mt.por_abc.C.produtos).toBe(mt.TOTAL_ADDITIONAL_PRODUCTS);
    for (const rg of Object.values(a.por_regra)) expect(rg.metodos.METODO_3.TOTAL_ADDITIONAL_UNITS).toBeLessThanOrEqual(Math.min(rg.metodos.METODO_1.TOTAL_ADDITIONAL_UNITS, rg.metodos.METODO_2.TOTAL_ADDITIONAL_UNITS));
    expect(JSON.stringify(a.exclusoes_reais_ruptura_com_demanda)).not.toMatch(/NV-/);
    expect(C.analisarProdutoNovo(r10, { C: REGRAS.C }).por_regra.C.NEW_PRODUCTS_ELIGIBLE).toBe(a.por_regra.C.NEW_PRODUCTS_ELIGIBLE);
  });
});

// ═════════════════════════ STORAGE ═════════════════════════
function dbMedidor() {
  const st = {}; const commits = [];
  const ref = (c, id) => ({ id, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => (st[c] && st[c][id] ? JSON.parse(st[c][id]) : undefined) }),
    set: async v => { (st[c] = st[c] || {})[id] = JSON.stringify(v); }, delete: async () => { if (st[c]) delete st[c][id]; } });
  return { st, commits, collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }) }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push([r, v]), commit: async () => { commits.push({ ops: ops.length, bytes: ops.reduce((s, [, v]) => s + Buffer.byteLength(JSON.stringify(v)), 0), maiorDoc: Math.max(...ops.map(([, v]) => Buffer.byteLength(JSON.stringify(v)))) }); for (const [r, v] of ops) await r.set(v); } }; } };
}
const MiB = 1024 * 1024;

describe('STORAGE — base histórica completa e travas de tamanho', () => {
  test('travas com margem abaixo dos limites reais do Firestore (doc 1 MiB; commit 10 MiB / 500 ops)', () => {
    expect(S.DOC_BYTES_MAX).toBeLessThanOrEqual(0.9 * MiB);
    expect(S.LOTE_BYTES_MAX).toBeLessThanOrEqual(0.85 * 10 * MiB);
    expect(S.LOTE_OPS_MAX).toBeLessThanOrEqual(0.9 * 500);
  });
  test('regressão de tamanho em escala real (877 produtos, ~18k vendas, 600 compras): todo doc e todo commit abaixo das travas', async () => {
    const ps = Array.from({ length: 877 }, (_, i) => X.produto('PX-' + i, { estoque: (i % 9) - 1 }));
    const vs = Array.from({ length: 17900 }, (_, i) => X.venda(X.dia(i % 1600), [['PX-' + (i % 877), 1 + (i % 3), 25], ['PX-' + ((i * 7) % 877), 1, 40]], { id: 'VX-' + i }));
    const cs = Array.from({ length: 600 }, (_, i) => X.compra(X.dia(i % 1600), Array.from({ length: 8 }, (_, j) => ['PX-' + ((i * 8 + j) % 877), 10, 10]), { id: 'CX-' + i }));
    const sn = S.montarSnapshot({ brutosProdutos: ps, brutosVendas: vs, brutosCompras: cs, agora: X.AGORA });
    const db = dbMedidor();
    await S.persistirSnapshot(db, sn);
    for (const c of db.commits) { expect(c.bytes).toBeLessThanOrEqual(S.LOTE_BYTES_MAX); expect(c.ops).toBeLessThanOrEqual(S.LOTE_OPS_MAX); expect(c.maiorDoc).toBeLessThanOrEqual(S.DOC_BYTES_MAX); }
    for (const col of Object.values(db.st)) for (const j of Object.values(col)) expect(Buffer.byteLength(j)).toBeLessThanOrEqual(S.DOC_BYTES_MAX);
    expect(db.st.compras_n0.meta).toBeDefined(); expect(JSON.parse(db.st.compras_n0.meta).avisos).toEqual([]);
  }, 60000);
  test('aviso determinístico de crescimento da base (75% / 100% do limite operacional); nada é apagado', () => {
    const L = S.BASE_LIMITE_OPERACIONAL_BYTES;
    expect(S.avisosBase(3 * MiB)).toEqual([]);
    expect(S.avisosBase(0.75 * L)).toEqual(['INCREMENTAL_BASE_NEAR_OPERATIONAL_LIMIT']);
    expect(S.avisosBase(L)).toEqual(['INCREMENTAL_BASE_OVER_OPERATIONAL_LIMIT']);
    const src = fs.readFileSync(path.join(__dirname, '../lib/compras/snapshot.js'), 'utf8');
    expect(src).not.toMatch(/diasParaExpurgo\([^)]*\)\s*\.forEach|base.*\.delete\(\)/);
  });
  test('base acima do limite operacional: grava tudo (sem truncar histórico) e registra o aviso', async () => {
    const db = dbMedidor();
    const sn = S.montarSnapshot({ brutosProdutos: [X.produto('A', { estoque: 1 })], brutosVendas: [], brutosCompras: [], agora: X.AGORA });
    const vendas = Array.from({ length: 330000 }, (_, i) => S.compactarVenda(X.venda('2026-09-' + String(1 + (i % 28)).padStart(2, '0'), [['A', 1, 25], ['B', 2, 30]], { id: 'VX-' + i })));
    sn.base = { vendas, compras: [] };
    await S.persistirSnapshot(db, sn);
    const meta = JSON.parse(db.st.compras_n0.meta);
    expect(meta.base_bytes).toBeGreaterThanOrEqual(S.BASE_LIMITE_OPERACIONAL_BYTES); expect(meta.avisos).toEqual(['INCREMENTAL_BASE_OVER_OPERATIONAL_LIMIT']);
    expect((await S.carregarBase(db)).vendas.length).toBe(330000);
    for (const c of db.commits) expect(c.bytes).toBeLessThanOrEqual(S.LOTE_BYTES_MAX);
  }, 120000);
});
