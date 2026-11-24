'use strict';
// AGENTE COMPRAS MR4 — Fase C · aba "Fornecedores": o <script type="module"> REAL de modulos/compras.html numa sandbox (vm) com DOM mínimo e
// Firestore falso, alimentado pelo agregador REAL (dados sintéticos). Prova: o que a tela mostra, o que NÃO mostra (R$ para quem não pode), alertas,
// escape de HTML, interação (busca/filtro/ordem/detalhe) e que as demais abas continuam IDÊNTICAS à página em produção.
const fs = require('fs'), path = require('path'), vm = require('vm'), { execFileSync } = require('child_process');
const K = require('../lib/compras/canonico');
const Forn = require('../lib/compras/fornecedores');
const Sim = require('../lib/compras/simulador');
const DUI = require('./fixtures/compras-ui-dados');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/compras.html'), 'utf8');
const HTML_PROD = (() => { try { return execFileSync('git', ['show', '4cc4f55:modulos/compras.html'], { cwd: __dirname, maxBuffer: 1 << 24 }).toString(); } catch (e) { return null; } })();
const script = h => { const i = h.indexOf('<script type="module">') + '<script type="module">'.length; return h.slice(i, h.indexOf('</script>', i)).replace(/^import .*$/gm, ''); };

// ── dados sintéticos pelo agregador real ───────────────────────────────────────────────────────────────────────
const AGORA = new Date('2026-10-22T19:00:00Z'), HOJE = '2026-10-22';
let n = 0;
const venda = (data, itens, o = {}) => { const tot = itens.reduce((s, [, , t]) => s + t, 0); return { id: 'V' + (++n), data, nome_situacao: o.sit || 'Concretizada', situacao_estoque: o.est || '1', valor_produtos: tot.toFixed(2), desconto_valor: o.desc || '0.00',
  produtos: itens.map(([pid, q, t]) => ({ produto: { produto_id: pid, quantidade: String(q), valor_venda: (t / q).toFixed(2), valor_total: t.toFixed(2) } })) }; };
const compra = (f, ps, data = '2026-01-10') => ({ Compra: { id: 'C' + (++n), data_emissao: data, nome_situacao: 'Confirmada', fornecedor_id: f, valor_produtos: '10.00', produtos: ps.map(p => ({ produto: { produto_id: p, quantidade: '1', valor_custo: '5' } })) } });
const produtos = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map((id, i) => K.mapearProduto({ id, codigo_interno: 'COD-' + id, nome: 'Produto ' + id, ativo: '1', movimenta_estoque: '1', estoque: String(i === 2 ? -3 : 10 * i), nome_grupo: 'G', cadastrado_em: '2025-01-01 10:00:00' }));
const vendas = [
  venda('2026-07-15', [['P4', 5, 50]]), venda('2026-10-05', [['P7', 4, 40]]),
  venda('2026-07-01', [['P1', 100, 1000], ['P2', 20, 400]], { desc: '50.00' }), venda('2026-08-05', [['P1', 80, 800]]), venda('2026-09-05', [['P1', 60, 600], ['P3', 5, 50]]),
  venda('2026-10-02', [['P1', 30, 300]]), venda('2026-08-10', [['P4', 40, 400]]), venda('2026-09-10', [['P5', 12, 120]]), venda('2026-09-11', [['P6', 7, 70]]),
  venda('2026-08-12', [['', 9, 90]]), venda('2026-09-12', [['P1', 3, 30]], { sit: 'Reservado' }), venda('2026-09-13', [['P1', 99, 990]], { sit: 'Cancelada', est: '0' }),
];
const compras = [compra('F1', ['P1', 'P2', 'P3']), compra('F2', ['P4', 'P7'], '2026-02-01'), compra('F9', ['P2'], '2026-03-01'), compra('2026204', ['P5']), compra('F3', ['P2'], '2026-02-20')];
const NOMES = { F1: 'ALFA <b>COMERCIAL</b>', F2: 'BETA IMPORTADORA', F3: 'GAMA', F9: 'ZETA', 2026204: 'MR4 DISTRIBUIDORA' };
const gerar = (o = {}) => Forn.montarFornecedores({ produtos, fatosVenda: vendas.flatMap(K.fatosDeVenda), fatosCompra: compras.flatMap(K.fatosDeCompra), hoje: HOJE, agora: AGORA, modo: 'FULL', nomes: NOMES, sync: { stale_after_hours: 6, full_overdue_after_hours: 26 }, ...o });
const DOCS = gerar();

// ── sandbox ─────────────────────────────────────────────────────────────────────────────────────────────────────
const unesc = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function elemento(id) {
  const e = { id, textContent: '', value: '', hidden: false, style: {}, dataset: {}, className: '', handlers: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _html: '', addEventListener(t, f) { e.handlers[t] = f; }, querySelector: () => elemento('q'), focus() {}, setSelectionRange() {},
    get innerHTML() { return e._html; }, set innerHTML(v) { e._html = v; e._filhos = null; },
    querySelectorAll(sel) {
      if (!e._filhos) e._filhos = {};
      if (e._filhos[sel]) return e._filhos[sel];
      const mk = (re, campo) => [...e._html.matchAll(re)].map(m => { const x = elemento('f'); x.dataset[campo] = unesc(m[1]); return x; });
      const r = sel === '[data-forn]' ? mk(/data-forn="([^"]*)"/g, 'forn') : sel === '#fornSeg button' ? mk(/<button data-v="(\w+)"/g, 'v') : sel === '[data-fp-fechar]' ? mk(/data-(fp-fechar)/g, 'x') : [];
      return (e._filhos[sel] = r);
    } };
  return e;
}
async function tela({ unidades, valores, valoresNegado = false, unidadesNegado = false, html = HTML, agora = AGORA }) {
  const els = {}, leituras = [], redes = [], corpo = new Set(), teclas = {};
  const docs = { 'compras_n0_view/sugestoes': DUI.dados(0).sugestoes11, 'compras_n0/meta': { ultima_tentativa_ok: true } };
  if (unidades) docs['compras_n0_fornecedores/unidades'] = unidades; if (valores) docs['compras_n0_fornecedores/valores'] = valores;
  let cb;
  const FIXO = agora.getTime();
  class Data extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXO); } static now() { return FIXO; } }
  const ctx = { console, Date: Data, Number, String, Object, Math, JSON, Promise, Set, Map, Array, Error, performance: { now: () => 0 }, setTimeout, clearTimeout, fetch: (...a) => { redes.push(a[0]); throw new Error('REDE_PROIBIDA'); },
    document: { getElementById: id => (els[id] = els[id] || elemento(id)), querySelectorAll: () => [], querySelector: () => elemento('q'), addEventListener(t, f) { teclas[t] = f; }, body: { classList: { toggle(c, on) { if (on) corpo.add(c); else corpo.delete(c); }, remove(c) { corpo.delete(c); } } } },
    window: { location: {}, ComprasSimulador: Sim }, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), signOut: async () => {}, verificarAcessoModulo: async () => true,
    onAuthStateChanged: (a, f) => { cb = f; }, doc: (_, c, i) => c + '/' + i,
    getDoc: async k => { leituras.push(k);
      if (k === 'compras_n0_view/custos') throw new Error('permission-denied');
      if (k === 'compras_n0_fornecedores/valores' && valoresNegado) throw new Error('permission-denied');
      if (k === 'compras_n0_fornecedores/unidades' && unidadesNegado) throw new Error('permission-denied');
      return { exists: () => k in docs, data: () => docs[k] }; } };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(script(html) + '\n;globalThis.__E = estado; globalThis.__R = render; try { globalThis.__F = FORN; } catch (_) { /* página de produção não tem a aba */ }', ctx);
  await cb({ uid: 'u', displayName: 'Teste', email: 't@t' });
  const api = { ctx, els, leituras, redes, corpo, teclas, drawer: () => (els.fpDrawerBox ? els.fpDrawerBox._html : ''), fechar() { els.fpDrawerBox.querySelectorAll('[data-fp-fechar]')[1].handlers.click(); }, overlay() { els.fpDrawerBox.querySelectorAll('[data-fp-fechar]')[0].handlers.click(); }, dgt(id, v) { els[id].handlers.input({ target: { value: v } }); }, dord(v) { els.fpOrdem.handlers.change({ target: { value: v } }); }, dchk(on) { els.fpSoCorrente.handlers.change({ target: { checked: on } }); }, sit(v) { els.fornSituacao.handlers.change({ target: { value: v } }); }, E: () => ctx.__E, F: () => ctx.__F, painel: () => els.painelForn._html, lista: () => els.lista._html,
    async abrir() { ctx.__E.aba = 'forn'; ctx.__R(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); return api; },
    clicar(chave) { const f = els.painelForn.querySelectorAll('[data-forn]').find(x => x.dataset.forn === chave); f.handlers.click(); },
    seg(v) { els.painelForn.querySelectorAll('#fornSeg button').find(x => x.dataset.v === v).handlers.click(); },
    digitar(id, v) { els[id].handlers.input({ target: { value: v } }); }, ordem(v) { els.fornOrdem.handlers.change({ target: { value: v } }); } };
  return api;
}
const nomes = h => [...h.matchAll(/<div class="nome">([^<]*(?:&lt;[^<]*)*)<\/div>/g)].map(m => unesc(m[1]));
const secoes = h => [...h.matchAll(/<div class="fsec">([^<]+)<\/div>/g)].map(m => m[1]);


const txt = h => unesc(h.replace(/<span class="lbl">[^<]*<\/span>/g, '').replace(/<div class="fp-pct-bar">.*?<\/div>/g, '').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/^\||\|$/g, ''));
const reais = s => Number(String(s).replace(/[^\d,-]/g, '').replace(',', '.'));
const cents = s => Math.round(reais(s) * 100);
/** linha de fornecedor da tabela principal → { nome, cel: [...] } */
function linhaDe(h, chave) {
  const ini = h.indexOf('data-forn="' + chave + '"'); if (ini < 0) return null;
  const fim = [h.indexOf('<div class="frow', ini + 10), h.indexOf('<div class="fsec"', ini + 10)].filter(x => x > 0).sort((a, b) => a - b)[0] ?? h.length;
  const bloco = h.slice(ini, fim); const nome = unesc((bloco.match(/<div class="nome">(.*?)<\/div>/) || [])[1] || '');
  const cel = [...bloco.matchAll(/<div class="num(?: tot3)?">(.*?)<\/div>(?=<div class="num|<div class="go")/g)].map(m => txt(m[1]));
  return { nome, cel };
}
/** linhas de produto do painel lateral → [{ nome, meta, cel: [...] }] */
function produtosDoPainel(h) { return h.split(/<div class="fp-prow(?: fin)?" data-pid="/).slice(1).map(b => { const pid = unesc(b.slice(0, b.indexOf('"'))); const nome = unesc((b.match(/<div class="nome">(.*?)<\/div>/) || [])[1] || ''); const meta = unesc((b.match(/<div class="meta">(.*?)<\/div>/) || [])[1] || ''); const resto = b.slice(Math.max(0, b.indexOf('<div class="num'))); return { pid, nome, meta, cel: [...resto.matchAll(/<div class="num[^"]*">(.*?)<\/div>/g)].map(c => txt(c[1])) }; }); }
const G = d => [...d.externos, ...d.internos, d.sem_fornecedor, d.itens_sem_produto];
const mesesR = ['jul/26', 'ago/26', 'set/26'];

const pegar = (d, nome) => G(d).find(g => g.nome === nome);

describe('Painel gerencial — layout e permissões', () => {
  test('cabeçalho "Análise de Vendas por Fornecedor", indicadores, busca, filtros e ordenação por faturamento e média', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(h).toContain('<h2>Análise de Vendas por Fornecedor</h2>');
    for (const c of ['Faturamento líquido (3 meses)', 'Média mensal', 'Unidades vendidas', 'Fornecedores com vendas', 'Mês corrente (parcial)']) expect(h).toContain(c);
    expect(h).toContain('id="fornBusca"'); expect(h).toContain('Com vendas no período'); expect(h).toContain('Sem vendas no período'); expect(h).toContain('Origem interna');
    expect(h).toContain('Ordem: Faturamento total (maior)'); expect(h).toContain('Ordem: Média mensal R$ (maior)'); expect(h).toContain('Ordem: Unidades (maior)'); expect(h).toContain('Ordem: Nome (A–Z)');
  });
  test('GESTOR: colunas mensais em R$ (jul/ago/set), total 3 meses, unidades, produtos, média R$/mês e mês corrente parcial', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    for (const c of ['jul/26 (R$)', 'ago/26 (R$)', 'set/26 (R$)', 'Total 3 meses', '>Unidades<', '>Produtos<', 'Média R$/mês', 'out/26 (parcial)']) expect(h).toContain(c);
    expect(h).toMatch(/frow fin head/);
    // a coluna mensal NÃO é mais unidades
    expect(h).not.toContain('jul/26 (un)');
  });
  test('cada linha mostra exatamente os valores do documento: meses em centavos→R$, total = soma dos 3 meses, média = total ÷ 3, unidades e produtos', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    for (const g of G(DOCS.unidades)) {
      const v = G(DOCS.valores).find(x => x.chave === g.chave), l = linhaDe(h, g.chave); expect(l).not.toBeNull();
      expect(l.cel.slice(0, 3).map(cents)).toEqual(v.liq_cents);                               // meses em R$ = liq_cents do backend
      expect(cents(l.cel[3])).toBe(v.soma_cents);                                              // total 3 meses
      expect(l.cel.slice(0, 3).map(cents).reduce((a, b) => a + b, 0)).toBe(cents(l.cel[3]));    // soma dos meses exibidos = total exibido
      expect(Number(l.cel[4].replace(/\D/g, ''))).toBe(g.soma); expect(Number(l.cel[5].replace(/\D/g, ''))).toBe(g.produtos_vendidos);
      expect(cents(l.cel[6])).toBe(v.media_cents); expect(v.media_cents).toBe(Math.round(v.soma_cents / 3));   // média financeira ÷ 3
      expect(cents(l.cel[7])).toBe(v.mes_corrente_cents);                                      // mês corrente à parte
    }
  });
  test('mês sem venda entra como R$ 0,00 (esmaecido) e a média continua ÷ 3', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    const zeta = pegar(DOCS.unidades, 'ZETA'), vz = G(DOCS.valores).find(x => x.chave === zeta.chave), l = linhaDe(h, zeta.chave);
    expect(vz.liq_cents.filter(c => c === 0).length).toBeGreaterThan(0); expect(l.cel.slice(0, 3).map(cents)).toEqual(vz.liq_cents); expect(h).toContain('<span class="z">R$');
    expect(cents(l.cel[6])).toBe(Math.round(vz.soma_cents / 3));
  });
  test('a mesma linha é clicável: papel de botão, foco por teclado, rótulo acessível e indicador "›"', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(h).toMatch(/class="frow fin item" data-forn="[^"]+" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Ver produtos de /); expect(h).toContain('class="go" aria-hidden="true">›');
    expect(HTML).toMatch(/\.frow\.item:hover[^{]*\{[^}]*background/); expect(HTML).toMatch(/cursor: pointer/);
  });
  test('PERFIL SEM VALORES (Estoque): quantidades por mês, nenhum R$ no painel nem no painel lateral, nenhuma opção de ordenar por R$', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: null, valoresNegado: true })).abrir(); const h = t.painel();
    expect(t.leituras).toContain('compras_n0_fornecedores/valores'); expect(JSON.stringify(t.F().val)).toBe('null');
    for (const c of ['jul/26 (un)', 'ago/26 (un)', 'set/26 (un)', 'Média un/mês', 'Total 3 meses']) expect(h).toContain(c);
    expect(h).not.toContain('R$'); expect(h).not.toMatch(/frow fin/); expect(h).not.toContain('Faturamento'); expect(h).not.toContain('Média R$'); expect(h).not.toContain('Ordem: Faturamento');
    t.clicar(G(DOCS.unidades)[0].chave); const d = t.drawer();
    expect(d).not.toContain('R$'); expect(d).not.toMatch(/fp-prow fin/); expect(d).not.toContain('Faturamento'); expect(d).not.toContain('% do forn'); expect(d).not.toContain('fp-pct-bar'); expect(d).not.toContain('Ordem: Faturamento');
    expect(d).toContain('Unidades vendidas'); expect(d).toContain('Total un');
    expect(h + d).not.toMatch(/liq_cents|cents/);
  });
  test('o código da tela não imprime nada no console e não faz chamada de rede', async () => {
    const src = script(HTML); const bloco = src.slice(src.indexOf('// ── Aba Fornecedores'), src.indexOf('// ── Agente de Compras'));
    expect(bloco).not.toMatch(/console\./); expect(bloco).not.toMatch(/fetch\(|XMLHttpRequest|gestaoclick/i);
    const t = await tela({ unidades: DOCS.unidades, valores: null, valoresNegado: true }); await t.abrir(); expect(t.redes).toEqual([]);
  });
  test('quatro agrupamentos separados, total geral e conferência; nomes reais e escapados', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(secoes(h)).toEqual(['Fornecedores externos', 'Origem interna', 'Produtos sem fornecedor identificado', 'Itens de venda sem produto cadastrado']);
    expect(h).toContain('Total geral (todos os grupos)'); expect(h).toContain('✓ a soma de externos + origem interna + sem fornecedor + itens sem produto fecha');
    expect(h).toContain('ALFA &lt;b&gt;COMERCIAL&lt;/b&gt;'); expect(h).not.toContain('<b>COMERCIAL</b>'); expect(h).toContain('MR4 DISTRIBUIDORA');
    const totalCents = G(DOCS.valores).reduce((s, g) => s + g.soma_cents, 0); expect(totalCents).toBe(DOCS.valores.totais.soma_cents);
  });
});

describe('Painel gerencial — busca, filtros e ordenação dos fornecedores', () => {
  let t; beforeEach(async () => { t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); });
  test('ordem padrão = maior faturamento dentro de cada seção; alternativas: média, unidades, mês corrente e nome', () => {
    const ext = () => nomes(t.painel()).filter(x => DOCS.unidades.externos.some(g => g.nome === x));
    const porFat = [...DOCS.unidades.externos].sort((a, b) => G(DOCS.valores).find(v => v.chave === b.chave).soma_cents - G(DOCS.valores).find(v => v.chave === a.chave).soma_cents).map(g => g.nome);
    expect(ext()).toEqual(porFat);
    t.ordem('media'); expect(ext()).toEqual(porFat);                                           // média = total ÷ 3 ⇒ mesma ordem
    t.ordem('un'); expect(ext()).toEqual([...DOCS.unidades.externos].sort((a, b) => b.soma - a.soma).map(g => g.nome));
    t.ordem('nome'); expect(ext()).toEqual([...ext()].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    t.ordem('mes'); expect(t.F().ordem).toBe('mes');
  });
  test('busca por nome, nome anterior ou código do fornecedor; filtros por situação e por agrupamento', () => {
    t.digitar('fornBusca', 'beta'); expect(nomes(t.painel())).toContain('BETA IMPORTADORA'); expect(t.painel()).not.toContain('ZETA'); t.digitar('fornBusca', '');
    t.seg('int'); expect(secoes(t.painel())).toEqual(['Origem interna']); t.seg('isp'); expect(secoes(t.painel())).toEqual(['Itens de venda sem produto cadastrado']); t.seg('todos');
    t.sit('com'); expect(secoes(t.painel()).length).toBe(4); t.sit('sem');
    expect(nomes(t.painel())).toEqual(['GAMA']);                                            // fornecedor conhecido (cadastro/compras) sem venda nos 3 meses
  });
  test('"Sem vendas": lista os grupos com os 3 meses zerados quando o documento os traz', async () => {
    const un = JSON.parse(JSON.stringify(DOCS.unidades)), va = JSON.parse(JSON.stringify(DOCS.valores));
    const vazio = JSON.parse(JSON.stringify(un.externos[0])); Object.assign(vazio, { chave: 'EXTERNO:F00', fornecedor_id: 'F00', nome: 'FORNECEDOR PARADO', un: [0, 0, 0], soma: 0, media: 0, mes_corrente: 0, produtos_vendidos: 0, produtos: [] });
    un.externos.push(vazio); va.externos.push({ chave: 'EXTERNO:F00', liq_cents: [0, 0, 0], soma_cents: 0, media_cents: 0, mes_corrente_cents: 0, reservado_liq_cents: { por_mes: [0, 0, 0], mes_corrente: 0, futuro: 0, total: 0 }, produtos: {} });
    const s = await (await tela({ unidades: un, valores: va })).abrir(); s.sit('sem'); expect(nomes(s.painel())).toEqual(['FORNECEDOR PARADO', 'GAMA']);   // grupo com venda zero no documento + fornecedor da lista sem_vendas
    s.sit('com'); expect(nomes(s.painel())).not.toContain('FORNECEDOR PARADO'); expect(nomes(s.painel())).not.toContain('GAMA');
  });
});

describe('Painel lateral de produtos do fornecedor', () => {
  let t; beforeEach(async () => { t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); });
  const alfa = () => pegar(DOCS.unidades, 'ALFA <b>COMERCIAL</b>');
  test('clicar no fornecedor abre o painel: nome real, tipo, faturamento 3 meses, unidades, produtos distintos e média', () => {
    const g = alfa(), v = G(DOCS.valores).find(x => x.chave === g.chave); t.clicar(g.chave); const d = t.drawer();
    expect(d).toContain('role="dialog"'); expect(d).toContain('aria-modal="true"'); expect(d).toContain('ALFA &lt;b&gt;COMERCIAL&lt;/b&gt;'); expect(d).toContain('FORNECEDOR EXTERNO');
    const kpi = k => { const m = d.match(new RegExp('<div class="k">' + k + '</div><div class="v">([^<]*)</div>')); return m && unesc(m[1]); };
    expect(cents(kpi('Faturamento \\(3 meses\\)'))).toBe(v.soma_cents); expect(Number(kpi('Unidades vendidas').replace(/\D/g, ''))).toBe(g.soma); expect(Number(kpi('Produtos distintos'))).toBe(g.produtos_vendidos); expect(cents(kpi('Média mensal'))).toBe(v.media_cents);
    expect(t.corpo.has('fp-lock')).toBe(true);
  });
  test('tipo do grupo: origem interna MR4, sem fornecedor identificado e itens sem produto', () => {
    t.clicar(DOCS.unidades.internos[0].chave); expect(t.drawer()).toContain('ORIGEM INTERNA MR4'); t.fechar();
    t.clicar('SEM_FORNECEDOR'); expect(t.drawer()).toContain('SEM FORNECEDOR IDENTIFICADO'); t.fechar();
    t.clicar('ITENS_SEM_PRODUTO'); expect(t.drawer()).toContain('ITENS DE VENDA SEM PRODUTO CADASTRADO'); expect(t.drawer()).toContain('Item sem produto cadastrado');
  });
  test('cada produto: nome, código, unidades e R$ de jul/ago/set, total un, total R$, média R$/mês e % do fornecedor — iguais aos documentos', () => {
    const g = alfa(), v = G(DOCS.valores).find(x => x.chave === g.chave); t.clicar(g.chave); const ps = produtosDoPainel(t.drawer());
    expect(ps.length).toBe(g.produtos.filter(p => p.soma > 0).length);
    for (const p of g.produtos.filter(x => x.soma > 0)) {
      const pv = v.produtos[p.id], l = ps.find(x => x.nome === p.nome); expect(l).toBeTruthy(); expect(l.meta).toContain(p.codigo);
      expect(l.cel.slice(0, 3).map(x => Number(x.replace(/\D/g, '')))).toEqual(p.un); expect(Number(l.cel[3].replace(/\D/g, ''))).toBe(p.soma);
      expect(l.cel.slice(4, 7).map(cents)).toEqual(pv.liq_cents); expect(cents(l.cel[7])).toBe(pv.soma_cents); expect(cents(l.cel[8])).toBe(pv.media_cents);
      expect(l.cel[9]).toContain((pv.soma_cents / v.soma_cents * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    }
  });
  test('soma dos produtos = total do fornecedor (unidades e centavos) e participações somam 100%', () => {
    const g = alfa(), v = G(DOCS.valores).find(x => x.chave === g.chave); t.clicar(g.chave); const ps = produtosDoPainel(t.drawer());
    expect(ps.reduce((s, p) => s + Number(p.cel[3].replace(/\D/g, '')), 0)).toBe(g.soma); expect(ps.reduce((s, p) => s + cents(p.cel[7]), 0)).toBe(v.soma_cents);
    expect(ps.reduce((s, p) => s + Number(p.cel[9].replace('%', '').replace(',', '.')), 0)).toBeCloseTo(100, 0);
    for (const i of [0, 1, 2]) expect(ps.reduce((s, p) => s + cents(p.cel[4 + i]), 0)).toBe(v.liq_cents[i]);          // cada mês fecha
  });
  test('produto com vendas em só um ou dois meses: meses sem venda aparecem zerados; a média é do total ÷ 3', () => {
    const beta = pegar(DOCS.unidades, 'BETA IMPORTADORA'); t.clicar(beta.chave); const ps = produtosDoPainel(t.drawer());
    const p4 = ps.find(x => x.nome === 'Produto P4'); expect(p4.cel.slice(0, 3).map(x => x.replace(/\D/g, ''))).toEqual(['5', '40', '0']); expect(p4.cel[6]).toContain('0,00');
    const pv = G(DOCS.valores).find(x => x.chave === beta.chave).produtos[beta.produtos.find(p => p.nome === 'Produto P4').id]; expect(cents(p4.cel[8])).toBe(Math.round(pv.soma_cents / 3));
    expect(t.drawer()).toContain('<span class="z">');
  });
  test('produtos só com venda no mês corrente ficam fora da lista (e do contador) até marcar a opção', () => {
    const beta = pegar(DOCS.unidades, 'BETA IMPORTADORA'); t.clicar(beta.chave);
    expect(produtosDoPainel(t.drawer()).map(x => x.nome)).not.toContain('Produto P7'); expect(t.drawer()).toContain('de ' + beta.produtos.filter(p => p.soma > 0).length + ' vendidos no período');
    t.dchk(true); const ps = produtosDoPainel(t.drawer()); expect(ps.map(x => x.nome)).toContain('Produto P7'); expect(t.drawer()).toContain('SEM VENDA NOS 3 MESES'); expect(ps.find(x => x.nome === 'Produto P7').cel[3]).toBe('0');
  });
  test('busca de produtos (nome, código ou id) e ordenação por faturamento, unidades e nome', () => {
    const g = alfa(); t.clicar(g.chave);
    const nomesP = () => produtosDoPainel(t.drawer()).map(x => x.nome);
    const v = G(DOCS.valores).find(x => x.chave === g.chave);
    expect(nomesP()).toEqual([...g.produtos].filter(p => p.soma > 0).sort((a, b) => v.produtos[b.id].soma_cents - v.produtos[a.id].soma_cents).map(p => p.nome));   // padrão: faturamento
    t.dord('un'); expect(nomesP()).toEqual([...g.produtos].filter(p => p.soma > 0).sort((a, b) => b.soma - a.soma).map(p => p.nome));
    t.dord('nome'); expect(nomesP()).toEqual([...nomesP()].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    t.dgt('fpBusca', 'cod-p3'); expect(nomesP()).toEqual(['Produto P3']); t.dgt('fpBusca', 'zzz'); expect(t.drawer()).toContain('Nenhum produto encontrado');
  });
  test('fechamento simples: botão ✕, clique fora e tecla Esc; o foco volta para a linha e a rolagem é liberada', () => {
    const g = alfa(); t.clicar(g.chave); expect(t.drawer()).not.toBe(''); t.fechar(); expect(t.drawer()).toBe(''); expect(t.corpo.has('fp-lock')).toBe(false);
    t.clicar(g.chave); t.overlay(); expect(t.drawer()).toBe('');
    t.clicar(g.chave); t.teclas.keydown({ key: 'Escape' }); expect(t.drawer()).toBe(''); expect(t.F().sel).toBeNull();
    t.teclas.keydown({ key: 'Escape' }); expect(t.drawer()).toBe('');                                   // Esc sem painel aberto não faz nada
  });
  test('sair da aba com o painel aberto o fecha e libera a rolagem da página', async () => {
    t.clicar(alfa().chave); expect(t.corpo.has('fp-lock')).toBe(true);
    t.E().aba = 'sug'; t.ctx.__R(); expect(t.corpo.has('fp-lock')).toBe(false); expect(t.F().sel).toBeNull();
  });
  test('grupo sem produtos no documento resumido e aviso de sem sugestão automática', () => {
    t.clicar('SEM_FORNECEDOR'); expect(t.drawer()).toContain('não gera sugestão automática de reposição');
    const r = JSON.parse(JSON.stringify(DOCS.unidades)); r.detalhe_produtos = false; r.externos.forEach(g => { g.produtos = []; });
    return tela({ unidades: r, valores: DOCS.valores }).then(async s => { await s.abrir(); s.clicar(r.externos[0].chave); expect(s.drawer()).toContain('Detalhe por produto indisponível nesta geração'); });
  });
  test('layout responsivo: painel em tela cheia e cartões no celular; tabela com rolagem própria no computador (regras de CSS)', () => {
    expect(HTML).toMatch(/\.fp-drawer \{[^}]*width: min\(1180px, 96vw\)/); expect(HTML).toMatch(/@media \(max-width: 900px\) \{[^}]*\.forn-chips[\s\S]*?\.fp-drawer \{ width: 100vw; \}/);
    expect(HTML).toMatch(/\.fp-tab \{[^}]*overflow-x: auto/); expect(HTML).toMatch(/\.frow\.item::after \{ content: 'Ver produtos ›'/);
  });
});

describe('Painel gerencial — alertas de atualização e nomes (preservados)', () => {
  const nm = { ativo: true, atualizacao: 'LEITURA_NO_SYNC_COMPLETO', status: 'OK', motivo: null, atualizado_em: '2026-10-22T19:00:00.000Z', ultima_tentativa_ok: true, stale_after_hours: 48, conhecidos: 5 };
  const rico = (extra = {}) => gerar({ nomes: { F1: { nome: 'ALFA <b>COMERCIAL</b>', ativo: false, nome_anterior: 'ANTIGA <i>RAZAO</i>', ausente: false }, F2: { nome: 'BETA IMPORTADORA', ativo: true, ausente: true }, F3: 'GAMA', F9: 'ZETA' }, nomesMeta: { ...nm, ...extra } });
  test('selos de inativo, renomeado (nome anterior escapado) e ausente; busca pelo nome anterior', async () => {
    const d = rico(); const t = await (await tela({ unidades: d.unidades, valores: d.valores })).abrir(); const h = t.painel();
    expect(h).toContain('>INATIVO<'); expect(h).toContain('AUSENTE NO CADASTRO ATUAL'); expect(h).toContain('RENOMEADO · ANTES: ANTIGA &lt;i&gt;RAZAO&lt;/i&gt;'); expect(h).not.toContain('<i>RAZAO</i>');
    t.digitar('fornBusca', 'antiga'); expect(nomes(t.painel())).toEqual(['ALFA <b>COMERCIAL</b>']);
  });
  test('visão antiga, sincronismo atrasado, nomes desatualizados e conciliação quebrada são sinalizados', async () => {
    const ok = rico(); expect((await (await tela({ unidades: ok.unidades, valores: ok.valores })).abrir()).painel()).toContain('fresh ok');
    expect((await (await tela({ unidades: ok.unidades, valores: ok.valores, agora: new Date(AGORA.getTime() + 9 * 3600e3) })).abrir()).painel()).toContain('Visão desatualizada há 9 h');
    const at = gerar({ modo: 'INCREMENTAL', ultimoCompleto: '2026-10-20T10:00:00Z' }); expect((await (await tela({ unidades: at.unidades, valores: at.valores })).abrir()).painel()).toContain('Dados desatualizados');
    const velho = rico({ status: 'DESATUALIZADO', motivo: 'ULTIMA_LEITURA_FALHOU', ultima_tentativa_ok: false }); expect((await (await tela({ unidades: velho.unidades, valores: velho.valores })).abrir()).painel()).toContain('Nomes de fornecedores desatualizados desde');
    const q = JSON.parse(JSON.stringify(ok.unidades)); q.conciliacao.fecha = false; q.meta.limitacoes.push('CONCILIACAO_NAO_FECHA'); const h = (await (await tela({ unidades: q, valores: ok.valores })).abrir()).painel(); expect(h).toContain('✗ a soma dos grupos NÃO fecha');
  });
  test('sem documento / sem permissão: mensagens claras', async () => {
    expect((await (await tela({ unidades: null, valores: null })).abrir()).painel()).toContain('ainda não foram geradas');
    expect((await (await tela({ unidades: null, valores: null, unidadesNegado: true, valoresNegado: true })).abrir()).painel()).toContain('Sem permissão para ver as vendas por fornecedor');
  });
});

describe('Regressão: o resto da tela de Compras não mudou', () => {
  const W = DUI.dados(0);
  test('abas Sugestões e Atenção produzem EXATAMENTE a mesma lista e contagem que a página em produção (4cc4f55) com os mesmos dados', async () => {
    expect(HTML_PROD).not.toBeNull();
    const a = await tela({ unidades: null, valores: null, html: HTML_PROD }), b = await tela({ unidades: null, valores: null });
    expect(b.lista()).toBe(a.lista()); expect(b.els.contagem.textContent).toBe(a.els.contagem.textContent);
    a.E().aba = 'aten'; a.ctx.__R(); b.E().aba = 'aten'; b.ctx.__R(); expect(b.lista()).toBe(a.lista());
  });
  test('abrir e sair da aba Fornecedores devolve a lista intacta e não altera o estado das outras abas', async () => {
    const t = await tela({ unidades: DOCS.unidades, valores: DOCS.valores }); const antes = t.lista(), estadoAntes = JSON.stringify({ ...t.E(), aba: 0 });
    await t.abrir(); t.E().aba = 'sug'; t.ctx.__R();
    expect(t.lista()).toBe(antes); expect(JSON.stringify({ ...t.E(), aba: 0 })).toBe(estadoAntes); expect(t.els.painelForn.hidden).toBe(true);
    for (const id of ['lista', 'contagem', 'barraFiltros', 'chips']) expect(t.els[id].style.display).toBe('');
  });
  test('a página não referencia nenhuma rede/ERP novo e a nova coleção é lida só dentro da aba', () => {
    const src = script(HTML); const novos = src.split('\n').filter(l => /compras_n0_fornecedores/.test(l));
    expect(novos.length).toBeGreaterThan(0); expect(src).not.toMatch(/gestaoclick|api\.gestaoclick/i);
    expect(src.match(/getDoc\(doc\(db, 'compras_n0_fornecedores'/g).length).toBe(2);
  });
});


// ── Fase C.4 · fornecedores conhecidos sem vendas (lista `sem_vendas` do documento de unidades) ──────────────────────────────────────────
const NOMES4 = { ...NOMES, F8: 'DELTA PARADA', F7: 'EPSILON INATIVA', 2026205: 'MR4 TRANSFERENCIA' };
const DOCS4 = gerar({ nomes: { ...NOMES4, F7: { nome: 'EPSILON INATIVA', ativo: false } }, config: { ...Forn.DEFAULTS, internal_supplier_ids: ['2026204', '2026205'] } });
const SV = DOCS4.unidades.sem_vendas;
const fatTotal = h => unesc((h.match(/Faturamento líquido \(3 meses\)<\/div><div class="v">([^<]*)</) || [])[1] || '');
describe('Fornecedores sem vendas — tabela, filtros, selo Inativo e painel', () => {
  test('o documento de teste traz sem vendas externos (ativo e inativo) e interno, sem duplicar quem vendeu', () => {
    expect(SV.map(x => x.nome).sort()).toEqual(['DELTA PARADA', 'EPSILON INATIVA', 'GAMA', 'MR4 TRANSFERENCIA']);
    const com = [...DOCS4.unidades.externos, ...DOCS4.unidades.internos].map(g => g.fornecedor_id);
    expect(SV.filter(x => com.includes(x.fornecedor_id))).toEqual([]);
  });
  test('filtro "Sem vendas": lista todos, com R$ e unidades zerados; externos antes dos internos; selo Inativo; sem duplicar', async () => {
    const t = await (await tela({ unidades: DOCS4.unidades, valores: DOCS4.valores })).abrir(); t.sit('sem'); const h = t.painel();
    expect([...nomes(h)].sort()).toEqual(['DELTA PARADA', 'EPSILON INATIVA', 'GAMA', 'MR4 TRANSFERENCIA']);
    expect(secoes(h)).toEqual(['Fornecedores externos', 'Origem interna']);
    expect(new Set(nomes(h)).size).toBe(4);
    for (const x of SV) expect(linhaDe(h, x.chave)).not.toBeNull();
    const lin = x => linhaDe(h, x.chave).cel;
    SV.forEach(x => { expect(lin(x).filter(c => /R\$/.test(c)).every(c => cents(c) === 0)).toBe(true); expect(lin(x)[4]).toBe('0'); expect(lin(x)[5]).toBe('0'); });
    expect(h).toContain('SEM VENDAS NO PERÍODO'); expect((h.match(/>INATIVO</g) || []).length).toBe(1);
    expect(h.slice(h.indexOf('EXTERNO:F7'), h.indexOf('EXTERNO:F7') + 900)).toContain('>INATIVO<');
    expect(h.slice(h.indexOf('INTERNO:2026205'), h.indexOf('INTERNO:2026205') + 900)).toContain('ORIGEM INTERNA');
  });
  test('"Com vendas" não mostra ninguém da lista; "Todos" mostra com vendas primeiro e sem vendas no fim de cada seção; totais não mudam', async () => {
    const t = await (await tela({ unidades: DOCS4.unidades, valores: DOCS4.valores })).abrir(); t.sit('com');
    SV.forEach(x => expect(nomes(t.painel())).not.toContain(x.nome));
    t.sit('todos'); const n = nomes(t.painel()), ext = DOCS4.unidades.externos.map(g => g.nome);
    const ultimoCom = Math.max(...ext.map(x => n.indexOf(x))), primeiroSem = Math.min(...['DELTA PARADA', 'EPSILON INATIVA', 'GAMA'].map(x => n.indexOf(x)));
    expect(ultimoCom).toBeLessThan(primeiroSem);
    t.ordem('nome'); const n2 = nomes(t.painel()); expect(Math.max(...ext.map(x => n2.indexOf(x)))).toBeLessThan(Math.min(...['DELTA PARADA', 'EPSILON INATIVA', 'GAMA'].map(x => n2.indexOf(x))));
    expect(fatTotal(t.painel())).toBe(fatTotal((await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir()).painel()));   // faturamento total igual ao sem a lista
  });
  test('filtros por agrupamento e busca alcançam os sem vendas (inclusive pelo código do fornecedor)', async () => {
    const t = await (await tela({ unidades: DOCS4.unidades, valores: DOCS4.valores })).abrir();
    t.seg('int'); expect(nomes(t.painel())).toEqual(expect.arrayContaining(['MR4 TRANSFERENCIA'])); t.seg('ext'); expect(nomes(t.painel())).not.toContain('MR4 TRANSFERENCIA'); expect(nomes(t.painel())).toContain('DELTA PARADA'); t.seg('todos');
    t.digitar('fornBusca', 'delta'); expect(nomes(t.painel())).toEqual(['DELTA PARADA']); t.digitar('fornBusca', 'F7'); expect(nomes(t.painel())).toEqual(['EPSILON INATIVA']);
  });
  test('indicadores contam os sem vendas e continuam contando só quem vendeu em "Fornecedores com vendas"', async () => {
    const t = await (await tela({ unidades: DOCS4.unidades, valores: DOCS4.valores })).abrir(); const h = t.painel();
    const com = [...DOCS4.unidades.externos, ...DOCS4.unidades.internos].filter(g => g.soma > 0).length;
    expect(h).toContain(`<div class="k">Fornecedores com vendas</div><div class="v">${com}</div>`); expect(h).toContain('· 4 sem vendas');
  });
  test('painel de produtos de um fornecedor sem vendas: nome, tipo, zeros, mensagem clara e produtos atribuídos; fecha normalmente', async () => {
    const t = await (await tela({ unidades: DOCS4.unidades, valores: DOCS4.valores })).abrir(); t.clicar('EXTERNO:F8');
    const d = t.drawer(); expect(d).toContain('DELTA PARADA'); expect(d).toContain('FORNECEDOR EXTERNO'); expect(d).toContain('Este fornecedor não teve vendas nos 3 meses completos');
    expect(d).toContain('Nenhum produto está atribuído'); expect(d).toMatch(/R\$\s0,00/); expect(t.corpo.has('fp-lock')).toBe(true);
    t.fechar(); expect(t.drawer()).toBe(''); t.clicar('INTERNO:2026205'); expect(t.drawer()).toContain('ORIGEM INTERNA'); expect(t.drawer()).toContain('MR4 TRANSFERENCIA');
  });
  test('sem produtos vendidos, mas com produtos atribuídos pela última compra: a mensagem informa a quantidade', async () => {
    const un = JSON.parse(JSON.stringify(DOCS4.unidades)); un.sem_vendas.find(x => x.fornecedor_id === 'F3').produtos_atribuidos = 5;
    const t = await (await tela({ unidades: un, valores: DOCS4.valores })).abrir(); t.clicar('EXTERNO:F3'); expect(t.drawer()).toContain('atribuídos a ele (última compra confirmada): 5');
  });
  test('PERFIL SEM VALORES: a lista aparece só em unidades — nenhum R$ na tabela nem no painel, e o documento de valores não é lido', async () => {
    const t = await tela({ unidades: DOCS4.unidades, valores: null, valoresNegado: true }); await t.abrir(); t.sit('sem'); const h = t.painel();
    expect(nomes(h).length).toBe(4); expect(h).not.toMatch(/R\$/); expect(h).toContain('Unidades (maior)');
    t.clicar('EXTERNO:F8'); expect(t.drawer()).not.toMatch(/R\$/); expect(t.drawer()).toContain('Este fornecedor não teve vendas'); expect(t.F().val).toBeNull();
    expect(t.redes).toEqual([]);
  });
  test('COMPATIBILIDADE: documento sem a lista (backend antigo) funciona como na V2; sem filtro vazio enganoso', async () => {
    const un = JSON.parse(JSON.stringify(DOCS4.unidades)); delete un.sem_vendas; delete un.conciliacao.fornecedores;
    const t = await (await tela({ unidades: un, valores: DOCS4.valores })).abrir(); t.sit('sem');
    expect(nomes(t.painel())).toEqual([]); expect(t.painel()).toContain('Esta geração ainda não lista os fornecedores sem vendas'); t.sit('todos'); expect(nomes(t.painel())).not.toContain('DELTA PARADA');
    expect(fatTotal(t.painel())).toBe(fatTotal((await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir()).painel()));
  });
  test('COMPATIBILIDADE: a página ANTERIOR (V2 commitada) ignora o campo novo e mostra o mesmo que antes', async () => {
    const v2 = (() => { try { return execFileSync('git', ['show', '2fa91cc:modulos/compras.html'], { cwd: __dirname, maxBuffer: 1 << 24 }).toString(); } catch (e) { return null; } })();
    if (!v2) return;
    const t = await (await tela({ unidades: DOCS4.unidades, valores: DOCS4.valores, html: v2 })).abrir(); const h = t.painel();
    expect(fatTotal(h)).toBe(fatTotal((await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir()).painel())); expect(nomes(h)).not.toContain('DELTA PARADA'); expect(h).not.toContain('undefined');
  });
});
