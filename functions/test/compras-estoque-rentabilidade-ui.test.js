'use strict';
// Política 1.2 — o <script type="module"> REAL de modulos/compras.html numa sandbox (vm) com DOM mínimo e Firestore falso.
// Prova: sem `fin` a tela é a de hoje; com `fin` mostra capital/margem/lucro/retorno, resumo, filtros e ordenação; margem indisponível
// nunca vira número; a tela só lê os documentos de visão (nunca os blocos de custos) e não calcula limiar nenhum.
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/compras.html'), 'utf8');
const ini = HTML.indexOf('<script type="module">') + '<script type="module">'.length, fim = HTML.indexOf('</script>', ini);
const SCRIPT = HTML.slice(ini, fim).replace(/^import .*$/gm, '');

function el() {
  const e = { textContent: '', innerHTML: '', value: '', hidden: false, style: {}, dataset: {}, className: '', handlers: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener(t, f) { e.handlers[t] = f; } };
  return e;
}
const linha = (id, o = {}) => ({ id, nome: 'Produto ' + id, codigo: 'C-' + id, grupo: 'G', prioridade: 'P1', abc: 'A', estoque: 0, vendas: { d30: 4, d60: 8, d90: 12 }, cobertura_dias: 0, cobertura_estado: 'RUPTURA', qtd: 10, alvo_dias: 30, motivos: [], ...o });
const fin = (o = {}) => ({ cost: { unit_cents: 1000, confidence: 'HIGH', reason: 'MATCHES_LAST_PURCHASE_LANDED', reference_cents: 1000, divergence_bps: 0, reference_age_days: 12 },
  price: { unit_cents: 3000, source: 'REALIZED_90D', quality: 'STRONG', lines: 20, discount_bps: 150 }, unit: { profit_cents: 2000, margin_pct: 66.67, markup: 3 }, margin: { status: 'AVAILABLE', confidence: 'HIGH', negative: false },
  decision: { margin_tier: 'HIGH', attractiveness: 'HIGH', matrix: 'BUY_STRONG', signals: ['HIGH_DEMAND_HIGH_MARGIN'] },
  purchase: { capital_cents: 10000, revenue_potential_cents: 30000, profit_potential_cents: 20000, return_on_capital: 2, efficiency: 1.5 }, windows: { 30: { lines: 4, profit_cents: 8000 }, 60: { lines: 8, profit_cents: 16000 }, 90: { lines: 12, profit_cents: 24000 } }, ...o });

async function tela({ linhas, custos, custosNegado = false }) {
  const els = {}, leituras = [];
  const docs = { 'compras_n0_view/sugestoes': { policy_version: '1.2', data_comercial: '2026-09-30', contagens: { P1: 3, P2: 0, P3: 0, P4: 0 }, linhas }, 'compras_n0/meta': { ultima_tentativa_ok: true, ultimo_sucesso_em: null } };
  if (custos) docs['compras_n0_view/custos'] = custos;
  let cb;
  const ctx = { console, Date, Number, String, Object, Math, JSON, Promise, Set, Array, Error, performance: { now: () => 0 }, setTimeout, clearTimeout,
    document: { getElementById: id => (els[id] = els[id] || el()), querySelectorAll: () => [], querySelector: () => el(), addEventListener() {} },
    window: { location: {}, __comprasPerf: { renders: [] } },
    FIREBASE_CFG: null, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), signOut: async () => {}, verificarAcessoModulo: async () => true,
    onAuthStateChanged: (a, f) => { cb = f; }, doc: (_, c, i) => c + '/' + i,
    getDoc: async k => { leituras.push(k); if (k === 'compras_n0_view/custos' && custosNegado) throw new Error('permission-denied'); return { exists: () => k in docs, data: () => docs[k] }; } };
  ctx.window.__comprasPerf = ctx.window.__comprasPerf; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT + '\n;globalThis.__E = estado; globalThis.__R = render;', ctx);
  await cb({ uid: 'u', displayName: 'Teste', email: 't@t' });
  return { ctx, els, leituras, lista: () => els.lista.innerHTML, contagem: () => els.contagem.textContent, E: () => ctx.__E,
    acao: (id, v) => { ctx.__E[id === 'fFin' ? 'fFin' : 'ordem'] = v; ctx.__R(); } };
}

const L = [linha('A', { qtd: 10 }), linha('B', { qtd: 10 }), linha('C', { qtd: 10 }), linha('D', { qtd: 10 })];
const CUSTOS = { linhas: {
  A: { custo_cadastrado_cents: 1000, fin: fin() },
  B: { custo_cadastrado_cents: 2500, fin: fin({ unit: { profit_cents: -1000, margin_pct: -33.33, markup: 0.67 }, margin: { status: 'AVAILABLE', confidence: 'LOW', negative: true, hints: ['COST_MAY_BE_WRONG_OR_STALE'] }, decision: { margin_tier: 'NEGATIVE', attractiveness: 'NEGATIVE', matrix: 'BUY_NEED_FLAG_MARGIN', signals: ['NEGATIVE_MARGIN', 'HIGH_DEMAND_LOW_MARGIN'] }, purchase: { capital_cents: 40000, revenue_potential_cents: 30000, profit_potential_cents: -10000 } }) },
  C: { custo_cadastrado_cents: null, fin: fin({ cost: { confidence: 'UNKNOWN', reason: 'COST_MISSING' }, price: { unit_cents: 3000, source: 'REALIZED_90D', quality: 'STRONG' }, unit: {}, margin: { status: 'UNAVAILABLE', confidence: 'UNAVAILABLE', negative: false }, decision: { margin_tier: 'UNAVAILABLE', attractiveness: 'UNAVAILABLE', matrix: 'BUY_NEED_MARGIN_UNKNOWN', signals: ['MISSING_COST'] }, purchase: { revenue_potential_cents: 30000 } }) },
  D: { custo_cadastrado_cents: 2000, fin: fin({ unit: { profit_cents: 500, margin_pct: 20, markup: 1.3 }, cost: { unit_cents: 2000, confidence: 'MEDIUM', reason: 'SMALL_DIVERGENCE_FROM_LAST_PURCHASE_LANDED' }, decision: { margin_tier: 'LOW', attractiveness: 'LOW', matrix: 'BUY_NEED_FLAG_MARGIN', signals: [] }, purchase: { capital_cents: 20000, revenue_potential_cents: 30000, profit_potential_cents: 10000, return_on_capital: 0.5, efficiency: 0.4 } }) } },
  resumo_financeiro: { policy_version: '1.2', purchase: { capital_cents: 70000, revenue_potential_cents: 90000, gross_profit_potential_cents: 20000, weighted_margin_pct: 22.2, gross_return_on_capital: 0.29, complete: false, unpriced_products: 1 } } };
const ids = html => [...html.matchAll(/>C-([A-D])\b/g)].map(m => m[1]);

describe('tela Compras — Política 1.2 (script real)', () => {
  test('sem `fin` (Política 1.1 ou perfil sem custo): tela de hoje — sem resumo, sem colunas financeiras, filtros escondidos', async () => {
    const t = await tela({ linhas: L, custos: { linhas: { A: { custo_cadastrado_cents: 1000 } } } });
    expect(t.E().finOn).toBe(false); expect(t.els.resumoFin.hidden).toBe(true); expect(t.lista()).not.toMatch(/Capital necessário|Margem/);
    expect(t.els.fFin.hidden).toBe(true); expect(t.els.fOrdem.hidden).toBe(true);
    const n = await tela({ linhas: L, custos: null, custosNegado: true });
    expect(n.E().finOn).toBe(false); expect(n.lista()).not.toMatch(/Capital necessário/); expect(ids(n.lista())).toEqual(['A', 'B', 'C', 'D']);
  });
  test('com `fin`: resumo em estimativa, colunas, selos de atenção e margem indisponível sem número', async () => {
    const t = await tela({ linhas: L, custos: CUSTOS });
    expect(t.E().finOn).toBe(true); expect(t.els.resumoFin.hidden).toBe(false);
    expect(t.els.resumoFin.innerHTML).toMatch(/Estimativas, não promessa/); expect(t.els.resumoFin.innerHTML).toMatch(/sem custo ficam fora/);
    expect(t.lista()).toMatch(/Capital necessário/); expect(t.lista()).toMatch(/66,7%/); expect(t.lista()).toMatch(/-33,3%|−33,3%/);
    expect(t.lista()).toMatch(/MARGEM NEGATIVA/); expect(t.lista()).toMatch(/SEM CUSTO/); expect(t.lista()).toMatch(/<details class="fin">/);
    const c = t.lista().split('>C-C')[1].split('>C-D')[0];
    expect(c).toMatch(/sem custo confiável/); expect(c).not.toMatch(/\d,\d%<\/span>/);
    expect(t.els.fFin.hidden).toBe(false); expect(t.contagem()).toMatch(/capital R\$/);
  });
  test('ordem padrão = Política 1.1; ordenações financeiras colocam "sem valor" no fim e são estáveis', async () => {
    const t = await tela({ linhas: L, custos: CUSTOS });
    expect(ids(t.lista())).toEqual(['A', 'B', 'C', 'D']);
    t.acao('fOrdem', 'margem'); expect(ids(t.lista())).toEqual(['A', 'D', 'B', 'C']);
    t.acao('fOrdem', 'capital'); expect(ids(t.lista())).toEqual(['B', 'D', 'A', 'C']);
    t.acao('fOrdem', 'lucropot'); expect(ids(t.lista())).toEqual(['A', 'D', 'B', 'C']);
    t.acao('fOrdem', 'retorno'); expect(ids(t.lista())).toEqual(['A', 'D', 'B', 'C']);
    t.acao('fOrdem', ''); expect(ids(t.lista())).toEqual(['A', 'B', 'C', 'D']);
  });
  test('filtros financeiros', async () => {
    const t = await tela({ linhas: L, custos: CUSTOS });
    for (const [f, esperado] of [['neg', ['B']], ['indisp', ['C']], ['alta', ['A']], ['baixa', ['D']], ['ret_alto', ['A']], ['ret_baixo', ['D']], ['custo_incerto', ['C']]]) { t.acao('fFin', f); expect([f, ids(t.lista())]).toEqual([f, esperado]); }
  });
  test('a tela lê só as visões e não define limiar financeiro', async () => {
    const t = await tela({ linhas: L, custos: CUSTOS });
    expect(t.leituras.sort()).toEqual(['compras_n0/meta', 'compras_n0_view/custos', 'compras_n0_view/sugestoes']);
    expect(SCRIPT).not.toMatch(/compras_n0_custos|getDocs|collection\(|margin_low|margin_high|efficiency_(low|high)/);
  });
});
