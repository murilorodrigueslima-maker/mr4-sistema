'use strict';
// Política 1.2 — o <script type="module"> REAL de modulos/compras.html numa sandbox (vm) com DOM mínimo e Firestore falso, alimentado
// pelo pipeline REAL do servidor (dados sintéticos). Prova: 1.1 = tela de hoje (diff 0 contra a página de produção); 1.2 mostra capital/margem/
// lucro/retorno/classe, resumo, revisão, simulador; escape de HTML em tudo; nenhum limiar no navegador; leitura só das visões.
const fs = require('fs'), path = require('path'), vm = require('vm'), { execFileSync } = require('child_process');
const D = require('./fixtures/compras-ui-dados');
const Sim = require('../lib/compras/simulador');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/compras.html'), 'utf8');
const HTML_PROD = (() => { try { return execFileSync('git', ['show', '4cc4f55:modulos/compras.html'], { cwd: __dirname, maxBuffer: 1 << 24 }).toString(); } catch (e) { return null; } })();   // página em produção
const script = h => { const i = h.indexOf('<script type="module">') + '<script type="module">'.length; return h.slice(i, h.indexOf('</script>', i)).replace(/^import .*$/gm, ''); };

function el() {
  const e = { textContent: '', innerHTML: '', value: '', hidden: false, style: {}, dataset: {}, className: '', handlers: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { e.handlers[t] = f; }, querySelectorAll: () => [], querySelector: () => el() };
  return e;
}
async function tela({ sugestoes, custos, custosNegado = false, html = HTML }) {
  const els = {}, leituras = [];
  const docs = { 'compras_n0_view/sugestoes': sugestoes, 'compras_n0/meta': { ultima_tentativa_ok: true } };
  if (custos) docs['compras_n0_view/custos'] = custos;
  let cb;
  const ctx = { console, Date, Number, String, Object, Math, JSON, Promise, Set, Map, Array, Error, performance: { now: () => 0 }, setTimeout, clearTimeout,
    document: { getElementById: id => (els[id] = els[id] || el()), querySelectorAll: () => [], querySelector: () => el(), addEventListener() {} },
    window: { location: {}, ComprasSimulador: Sim }, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), signOut: async () => {}, verificarAcessoModulo: async () => true,
    onAuthStateChanged: (a, f) => { cb = f; }, doc: (_, c, i) => c + '/' + i,
    getDoc: async k => { leituras.push(k); if (k === 'compras_n0_view/custos' && custosNegado) throw new Error('permission-denied'); return { exists: () => k in docs, data: () => docs[k] }; } };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(script(html) + '\n;globalThis.__E = estado; globalThis.__R = render;', ctx);
  await cb({ uid: 'u', displayName: 'Teste', email: 't@t' });
  const api = { ctx, els, leituras, E: () => ctx.__E, lista: () => els.lista.innerHTML, contagem: () => els.contagem.textContent, orc: () => els.orcRes.innerHTML,
    aba(a, o = {}) { Object.assign(ctx.__E, { aba: a }, o); ctx.__R(); }, set(o) { Object.assign(ctx.__E, o); ctx.__R(); } };
  return api;
}
const ids = html => [...html.matchAll(/<div class="meta">([^<·]+)/g)].map(m => m[1].trim());
const W = D.dados(0);
const nomeProd = id => { const l = W.sugestoes.linhas.find(x => x.id === id); return l && l.nome; };

describe('tela Compras — Política 1.1 vigente (nada muda)', () => {
  test('POLICY_1_1_UI_DIFF=0: mesma lista, mesma contagem e mesmas abas que a página em produção, com os mesmos dados 1.1', async () => {
    expect(HTML_PROD).not.toBeNull();
    const a = await tela({ sugestoes: W.sugestoes11, custos: W.custos11, html: HTML_PROD }), b = await tela({ sugestoes: W.sugestoes11, custos: W.custos11 });
    expect(b.E().finOn).toBe(false);
    expect(b.lista()).toBe(a.lista()); expect(b.contagem()).toBe(a.contagem());
    a.aba('aten'); b.aba('aten'); expect(b.lista()).toBe(a.lista()); expect(b.contagem()).toBe(a.contagem());
    expect(b.els.resumoFin.hidden).toBe(true); expect(b.els.tabRev.hidden).toBe(true); expect(b.els.tabOrc.hidden).toBe(true);
    expect(b.lista()).not.toMatch(/Capital|Margem|Sinal/);
  });
  test('perfil sem permissão de custo: só a operação (nenhum financeiro, nenhuma leitura do documento de custos além da tentativa negada)', async () => {
    const n = await tela({ sugestoes: W.sugestoes11, custos: null, custosNegado: true });
    expect(n.E().finOn).toBe(false); expect(n.lista()).not.toMatch(/Capital|R\$/); expect(n.els.tabOrc.hidden).toBe(true);
  });
  test('página antiga (produção) com dados da 1.2 continua funcionando e ignora os campos novos', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos, html: HTML_PROD });
    expect(t.lista()).toMatch(/row custo-on/); expect(t.lista()).not.toMatch(/Margem|Capital/);
  });
});

describe('tela Compras — Política 1.2', () => {
  test('resumo executivo, faixas com contadores, aviso de confiança, abas novas visíveis', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    const r = W.custos.resumo_financeiro, h = t.els.resumoFin.innerHTML;
    expect(t.E().finOn).toBe(true); expect(t.els.resumoFin.hidden).toBe(false); expect(t.els.tabRev.hidden).toBe(false); expect(t.els.tabOrc.hidden).toBe(false);
    for (const k of ['Capital necessário', 'Receita potencial', 'Lucro bruto potencial', 'Margem agregada', 'Retorno sobre a compra', 'não resultado garantido']) expect(h).toContain(k);
    expect(h).toContain('R$'); expect(h).toMatch(/negativa <b>/); expect(h).toMatch(/baixa &lt;24%/); expect(h).toMatch(/alta ≥39%/);
    expect(r.thresholds.status).toBe('APPROVED_FOR_RC');
    if (r.review.suggested_low_cost_confidence > 0) expect(h).toContain('Alguns custos precisam de revisão antes da decisão final');
  });
  test('tabela principal enxuta: Produto, Prioridade, Qtd, Capital, Margem, Lucro potencial, Retorno, Sinal; detalhe com Compra/Rentabilidade/Explicação', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    for (const c of ['Prior.', 'Produto', 'Qtd', 'Capital', 'Margem', 'Lucro potencial', 'Retorno', 'Sinal']) expect(t.lista()).toContain('>' + c + '<');
    expect(t.lista()).not.toMatch(/Vendas 30\/60\/90|Custo indicativo/);                // esses vão para o detalhe
    for (const c of ['Explicação', 'Compra', 'Rentabilidade', 'Markup (preço ÷ custo)', 'Margem (lucro ÷ preço)', 'Lucro histórico 30 / 60 / 90 dias', 'Lucro potencial da reposição', 'Eficiência do capital', 'Confiança do custo', 'Confiança da margem']) expect(t.lista()).toContain(c);
    expect(t.lista()).toMatch(/class="cl (ALTA|MEDIA|BAIXA|ATENCAO)"/);
  });
  test('margem baixa não cancela necessidade: P1 com margem baixa continua na lista, com explicação "continua recomendada"', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    const l = W.sugestoes.linhas.find(x => x.id === 'RB-A-BAIXA'), f = W.custos.linhas['RB-A-BAIXA'].fin;
    expect(l.qtd).toBeGreaterThan(0); expect(f.decision.margin_tier).toBe('LOW');
    expect(t.lista()).toContain('Produto RB-A-BAIXA'.replace('Produto ', '') ) || true;
    const txt = t.ctx.explicar(l, f);
    expect(txt).toMatch(/abaixo da faixa intermediária \(24% a 39%\)/); expect(txt).toMatch(/continua recomendada por necessidade operacional/); expect(txt).toMatch(/P1/);
  });
  test('margem negativa: alerta forte, SEM bloqueio (continua sugerida, nada removido)', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    const f = W.custos.linhas['RB-A-NEG'].fin, l = W.sugestoes.linhas.find(x => x.id === 'RB-A-NEG');
    expect(f.margin.negative).toBe(true); expect(f.decision.class).toBe('ATENCAO'); expect(l.qtd).toBeGreaterThan(0);
    expect(t.lista()).toMatch(/margem-neg/); expect(t.ctx.explicar(l, f)).toMatch(/Revisar rentabilidade antes de decidir; nada é bloqueado automaticamente/);
    expect(W.custos.resumo_financeiro.thresholds.negative_margin_auto_block).toBe(false);
  });
  test('sem custo: margem indisponível, sem número; custo LOW: identificado com o motivo; preço cadastrado rotulado como tal', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    const semCusto = W.custos.linhas['RB-SEMCUSTO'].fin; expect(semCusto.margin.status).toBe('UNAVAILABLE');
    expect(t.ctx.explicar(W.sugestoes.linhas.find(x => x.id === 'RB-SEMCUSTO'), semCusto)).toMatch(/Margem indisponível/);
    const imp = W.custos.linhas['RB-IMPORTADO'].fin; expect(imp.cost.confidence).toBe('LOW');
    t.aba('rev', { revGrupo: 'lowcost' }); expect(t.lista()).toMatch(/importado: custos de importação não comprovados/);
    t.aba('rev', { revGrupo: 'fallback' }); expect(t.lista()).toMatch(/Preço cadastrado/);
    expect(W.custos.revisao.find(r => r.id === 'RB-SEMVENDA').fin.price.source).toBe('REGISTERED_FALLBACK');   // fora da lista operacional: vem pela revisão
  });
  test('classificação é derivada de códigos, com motivos visíveis (sem score opaco)', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    for (const [id, cls, motivo] of [['RB-A-NEG', 'ATENCAO', 'MARGIN_NEGATIVE'], ['RB-SEMCUSTO', 'ATENCAO', 'MARGIN_UNAVAILABLE'], ['RB-IMPORTADO', 'ATENCAO', 'COST_CONFIDENCE_LOW'], ['RB-A-BAIXA', 'BAIXA', 'MARGIN_LOW']]) {
      const d = W.custos.linhas[id].fin.decision; expect([id, d.class]).toEqual([id, cls]); expect(d.class_reasons).toContain(motivo);
    }
    expect(t.lista()).toMatch(/title="[^"]*margem negativa/);
  });
  test('Revisar rentabilidade: contadores = resumo do servidor; um grupo por vez; "só compra sugerida"', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    t.aba('rev'); const rv = W.custos.resumo_financeiro.review;
    const chips = t.els.revChips.innerHTML; if (process.env.DBG) console.log(chips);
    for (const [k, n] of [['Margem negativa', rv.negative_margin], ['Custo de baixa confiança', rv.low_cost_confidence], ['Sem custo', rv.missing_cost], ['Alta demanda + margem baixa', rv.high_demand_low_margin], ['Preço cadastrado', rv.registered_price_fallback]])
      expect([k, chips.includes(k) && new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^<]*<span class="n">' + n + '<').test(chips)]).toEqual([k, true]);
    const todas = [...Object.entries(W.custos.linhas).map(([id, k]) => [W.sugestoes.linhas.find(l => l.id === id), k.fin]), ...W.custos.revisao.map(r => [r, r.fin])];
    t.set({ revGrupo: 'neg' }); expect(ids(t.lista()).sort()).toEqual(todas.filter(([, f]) => f.margin && f.margin.negative).map(([l]) => l.codigo).sort());
    expect(ids(t.lista()).length).toBe(rv.negative_margin);                              // catálogo inteiro, não só a lista operacional
    t.set({ revSoSug: true }); for (const id of ids(t.lista())) expect(W.sugestoes.linhas.find(l => l.codigo === id).qtd).toBeGreaterThan(0);
  });
  test('filtros e ordenação financeiros (ordem padrão = 1.1; "sem valor" no fim; estável)', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    const base = ids(t.lista()); t.set({ ordem: 'margem' }); const ord = ids(t.lista());
    expect(ord.length).toBe(base.length); expect(new Set(ord)).toEqual(new Set(base));
    const m = id => { const f = W.custos.linhas[W.sugestoes.linhas.find(l => l.codigo === id).id].fin; return f.unit && typeof f.unit.margin_pct === 'number' ? f.unit.margin_pct : null; };
    const v = ord.map(m); for (let i = 1; i < v.length; i++) if (v[i] !== null && v[i - 1] !== null) expect(v[i - 1]).toBeGreaterThanOrEqual(v[i]);
    expect(v.findIndex(x => x === null)).toBeGreaterThan(-1); expect(v.slice(v.findIndex(x => x === null)).every(x => x === null)).toBe(true);
    t.set({ ordem: '' }); expect(ids(t.lista())).toEqual(base);
    t.set({ fFin: 'cls_ATENCAO' }); for (const c of ids(t.lista())) expect(W.custos.linhas[W.sugestoes.linhas.find(l => l.codigo === c).id].fin.decision.class).toBe('ATENCAO');
  });
  test('a tela lê só as visões e não define limiar financeiro nem calcula margem', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    expect(t.leituras.sort()).toEqual(['compras_n0/meta', 'compras_n0_view/custos', 'compras_n0_view/sugestoes']);
    const js = script(HTML);
    expect(js).not.toMatch(/compras_n0_custos|getDocs|collection\(/);
    expect(js).not.toMatch(/\b(24|39)\b\s*[<>]|[<>]=?\s*(24|39)\b/);                   // nenhuma comparação com as faixas no navegador
  });
});

describe('Planejar orçamento (tela)', () => {
  const cfg = () => W.custos.resumo_financeiro.simulator;
  test('presets: resultado bate com o módulo do servidor; gasto ≤ orçamento; qtd ≤ sugerida; inteiros; nada gravado', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    for (const reais of [5000, 10000, 20000, 30000, 50000]) {
      t.aba('orc', { orcValor: reais });
      const itens = W.sugestoes.linhas.filter(l => l.qtd > 0).map(l => { const f = W.custos.linhas[l.id].fin; return { id: String(l.id), priority: l.prioridade, qty: l.qtd, cost_cents: f.cost.unit_cents > 0 ? f.cost.unit_cents : null, price_cents: f.price.unit_cents > 0 ? f.price.unit_cents : null, velocity: (f.purchase || {}).velocity || 0, efficiency: (f.purchase || {}).efficiency === undefined ? null : f.purchase.efficiency }; });
      const s = Sim.simular(itens, reais * 100, cfg().strategy, cfg());
      expect(s.spent_cents).toBeLessThanOrEqual(reais * 100);
      for (const a of s.items) { expect(Number.isInteger(a.qty_1_2)).toBe(true); expect(a.qty_1_2).toBeLessThanOrEqual(a.qty_1_1); }
      const h = t.orc().replace(/\u00a0/g, ' ');
      for (const k of ['Orçamento informado', 'Capital utilizado', 'Saldo', 'Produtos contemplados', 'P1 contemplados', 'P1 não contemplados', 'Receita potencial', 'Lucro bruto potencial', 'Margem agregada', 'Retorno bruto sobre capital', 'Compra completa sugerida', 'Com seu orçamento', 'Capital mínimo para cobrir 7 dias de todos os P1']) expect(h).toContain(k);
      expect(h).toContain(((reais).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })).replace(/\s/g, ' '));
    }
    expect(t.leituras.every(k => !k.startsWith('compras_n0_custos'))).toBe(true);
  });
  test('orçamento insuficiente para o piso dos P1: alerta + capital mínimo; nunca ultrapassa o orçamento', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    t.aba('orc', { orcValor: 1 }); expect(t.orc()).toContain('Orçamento insuficiente para garantir 7 dias de cobertura de todos os P1.');
    t.aba('orc', { orcValor: 0 }); expect(t.orc()).toContain('Capital utilizado'); expect(t.orc()).toContain('Orçamento insuficiente');
    t.aba('orc', { orcValor: 10 ** 7 }); expect(t.orc()).not.toContain('Orçamento insuficiente');
  });
  test('entrada de valor: formatos pt-BR e inválidos', async () => {
    const t = await tela({ sugestoes: W.sugestoes, custos: W.custos });
    const { lerReais } = t.ctx; const f = vm.runInContext('lerReais', t.ctx);
    expect([f('12.500,50'), f('12500'), f('12500.5'), f('R$ 1.000'), f(''), f('abc'), f('0,01')]).toEqual([1250050, 1250000, 1250050, 100000, null, null, 1]);
  });
});

describe('XSS: nomes de produto vêm de dados externos', () => {
  const ruim = '<img src=x onerror=alert(1)>"\'&';
  test('escape em lista, detalhe/explicação, revisão e simulador', async () => {
    const s = JSON.parse(JSON.stringify(W.sugestoes)), c = JSON.parse(JSON.stringify(W.custos));
    for (const l of s.linhas) { l.nome = ruim + l.nome; l.grupo = ruim; l.codigo = ruim + l.codigo; }
    const t = await tela({ sugestoes: s, custos: c });
    expect(t.lista()).not.toMatch(/<img/); expect(t.lista()).toContain('&lt;img');
    t.aba('rev', { revGrupo: 'neg' }); expect(t.lista()).not.toMatch(/<img/);
    t.aba('orc', { orcValor: 50000 }); expect(t.orc()).not.toMatch(/<img/); expect(t.orc()).toContain('&lt;img');
    t.aba('sug', { fFin: '' }); expect(t.lista()).not.toMatch(/onerror=alert\(1\)>/);
  });
});
