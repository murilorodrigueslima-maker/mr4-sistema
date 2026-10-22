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
const produtos = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((id, i) => K.mapearProduto({ id, codigo_interno: 'COD-' + id, nome: 'Produto ' + id, ativo: '1', movimenta_estoque: '1', estoque: String(i === 2 ? -3 : 10 * i), nome_grupo: 'G', cadastrado_em: '2025-01-01 10:00:00' }));
const vendas = [
  venda('2026-07-01', [['P1', 100, 1000], ['P2', 20, 400]], { desc: '50.00' }), venda('2026-08-05', [['P1', 80, 800]]), venda('2026-09-05', [['P1', 60, 600], ['P3', 5, 50]]),
  venda('2026-10-02', [['P1', 30, 300]]), venda('2026-08-10', [['P4', 40, 400]]), venda('2026-09-10', [['P5', 12, 120]]), venda('2026-09-11', [['P6', 7, 70]]),
  venda('2026-08-12', [['', 9, 90]]), venda('2026-09-12', [['P1', 3, 30]], { sit: 'Reservado' }), venda('2026-09-13', [['P1', 99, 990]], { sit: 'Cancelada', est: '0' }),
];
const compras = [compra('F1', ['P1', 'P2', 'P3']), compra('F2', ['P4'], '2026-02-01'), compra('F9', ['P2'], '2026-03-01'), compra('2026204', ['P5']), compra('F3', ['P2'], '2026-02-20')];
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
      const r = sel === '[data-forn]' ? mk(/data-forn="([^"]*)"/g, 'forn') : sel === '#fornSeg button' ? mk(/<button data-v="(\w+)"/g, 'v') : [];
      return (e._filhos[sel] = r);
    } };
  return e;
}
async function tela({ unidades, valores, valoresNegado = false, unidadesNegado = false, html = HTML, agora = AGORA }) {
  const els = {}, leituras = [], redes = [];
  const docs = { 'compras_n0_view/sugestoes': DUI.dados(0).sugestoes11, 'compras_n0/meta': { ultima_tentativa_ok: true } };
  if (unidades) docs['compras_n0_fornecedores/unidades'] = unidades; if (valores) docs['compras_n0_fornecedores/valores'] = valores;
  let cb;
  const FIXO = agora.getTime();
  class Data extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXO); } static now() { return FIXO; } }
  const ctx = { console, Date: Data, Number, String, Object, Math, JSON, Promise, Set, Map, Array, Error, performance: { now: () => 0 }, setTimeout, clearTimeout, fetch: (...a) => { redes.push(a[0]); throw new Error('REDE_PROIBIDA'); },
    document: { getElementById: id => (els[id] = els[id] || elemento(id)), querySelectorAll: () => [], querySelector: () => elemento('q'), addEventListener() {} },
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
  const api = { ctx, els, leituras, redes, E: () => ctx.__E, F: () => ctx.__F, painel: () => els.painelForn._html, lista: () => els.lista._html,
    async abrir() { ctx.__E.aba = 'forn'; ctx.__R(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); return api; },
    clicar(chave) { const f = els.painelForn.querySelectorAll('[data-forn]').find(x => x.dataset.forn === chave); f.handlers.click(); },
    seg(v) { els.painelForn.querySelectorAll('#fornSeg button').find(x => x.dataset.v === v).handlers.click(); },
    digitar(id, v) { els[id].handlers.input({ target: { value: v } }); }, ordem(v) { els.fornOrdem.handlers.change({ target: { value: v } }); } };
  return api;
}
const nomes = h => [...h.matchAll(/<div class="nome">([^<]*(?:&lt;[^<]*)*)<\/div>/g)].map(m => unesc(m[1]));
const secoes = h => [...h.matchAll(/<div class="fsec">([^<]+)<\/div>/g)].map(m => m[1]);

describe('Aba Fornecedores — conteúdo e permissões', () => {
  test('a aba existe, é carregada sob demanda e só lê os dois documentos próprios (nenhuma rede, nada do ERP)', async () => {
    expect(HTML).toMatch(/<button data-aba="forn" id="tabForn">Fornecedores<\/button>/);
    const t = await tela({ unidades: DOCS.unidades, valores: DOCS.valores });
    expect(t.leituras.filter(k => /fornecedores/.test(k))).toEqual([]);                        // nada é lido antes de abrir a aba
    await t.abrir();
    expect(t.leituras.filter(k => /fornecedores/.test(k))).toEqual(['compras_n0_fornecedores/unidades', 'compras_n0_fornecedores/valores']);
    expect(t.redes).toEqual([]); expect(t.els.painelForn.hidden).toBe(false);
    for (const id of ['lista', 'contagem', 'barraFiltros', 'chips']) expect(t.els[id].style.display).toBe('none');
  });
  test('GESTOR (valores liberados): mostra as colunas e totais em R$, a média mensal de faturamento e a opção de ordenar por R$', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(h).toContain('Média R$/mês'); expect(h).toContain('Faturamento líquido'); expect(h).toContain('só gestor'); expect(h).toContain('Ordem: maior faturamento (R$)');
    expect(h).toContain((DOCS.valores.totais.media_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
    expect(h).toMatch(/frow val/);
  });
  test('PERFIL SEM PERMISSÃO DE VALORES: leitura negada pelas Rules ⇒ nenhum R$, nenhuma coluna, nenhuma opção de ordem por R$', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: null, valoresNegado: true })).abrir(); const h = t.painel();
    expect(t.leituras).toContain('compras_n0_fornecedores/valores');                          // tentou; o backend negou
    expect(h).not.toContain('R$'); expect(h).not.toContain('Faturamento'); expect(h).not.toContain('Ordem: maior faturamento'); expect(h).not.toMatch(/frow val/);
    expect(h).toContain('valores financeiros ficam disponíveis apenas ao perfil gestor');
    expect(JSON.stringify(t.F().val)).toBe('null');                                           // o navegador nem recebeu o documento
  });
  test('quatro agrupamentos separados, nesta ordem, com total geral e conferência fechando', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(secoes(h)).toEqual(['Fornecedores externos', 'Origem interna', 'Produtos sem fornecedor identificado', 'Itens de venda sem produto cadastrado']);
    expect(h).toContain('Total geral (todos os grupos)'); expect(h).toContain('✓ a soma de externos + origem interna + sem fornecedor + itens sem produto fecha');
    expect(h).toContain('MR4 DISTRIBUIDORA'); expect(h).toContain('ORIGEM INTERNA');
    expect(h).toContain('SEM SUGESTÃO AUTOMÁTICA');
  });
  test('três meses civis completos + mês corrente SEPARADO e rotulado como parcial; médias do servidor', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    for (const c of ['>jul/26<', '>ago/26<', '>set/26<', 'out/26 (parcial)', 'Média/mês', 'fora da média']) expect(h).toContain(c);
    const g = DOCS.unidades.externos[0];
    expect(h).toContain(`<b>${g.media.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</b>`);
  });
  test('data/hora do último sincronismo completo, aviso de atribuição gerencial e ausência de sugestão de compra', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(h).toContain('Último sincronismo completo'); expect(h).toContain(new Date(AGORA).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }));
    expect(h).toContain('Atribuição gerencial'); expect(h).toMatch(/não representa a origem histórica exata/);
    expect(h).not.toMatch(/Prioridade|Sugerid|Qtd sugerida|Capital necessário|Comprar/i);
    expect(h.replace(/SEM SUGESTÃO AUTOMÁTICA/g, '')).not.toMatch(/sugest/i);
  });
  test('NOME do fornecedor é escapado (sem HTML injetado) e o código aparece quando o nome falta', async () => {
    const t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); const h = t.painel();
    expect(h).not.toContain('<b>COMERCIAL</b>'); expect(h).toContain('ALFA &lt;b&gt;COMERCIAL&lt;/b&gt;');
    const sem = gerar({ nomes: {} }); const t2 = await (await tela({ unidades: sem.unidades, valores: sem.valores })).abrir();
    expect(t2.painel()).toContain('Fornecedor #F1'); expect(t2.painel()).toContain('NOME INDISPONÍVEL'); expect(t2.painel()).toContain('Nomes de fornecedor ainda não sincronizados');
  });
});

describe('Aba Fornecedores — alertas de atualização', () => {
  test('dados dentro do limite: selo "Atualizado" e nenhum alerta', async () => {
    const h = (await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores, agora: new Date(AGORA.getTime() + 2 * 3600e3) })).abrir()).painel();
    expect(h).toContain('fresh ok'); expect(h).not.toContain('forn-nota warn'); expect(h).not.toContain('forn-nota fail');
  });
  test('visão com mais de 6 h: alerta de desatualizada com as horas', async () => {
    const h = (await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores, agora: new Date(AGORA.getTime() + 9 * 3600e3) })).abrir()).painel();
    expect(h).toContain('Visão desatualizada há 9 h'); expect(h).toContain('forn-nota warn'); expect(h).not.toContain('fresh ok');
  });
  test('sync completo atrasado (incremental): alerta vermelho "Dados desatualizados"', async () => {
    const d = gerar({ modo: 'INCREMENTAL', ultimoCompleto: '2026-10-20T10:00:00Z' });
    const h = (await (await tela({ unidades: d.unidades, valores: d.valores })).abrir()).painel();
    expect(d.unidades.meta.atualizacao.status).toBe('DESATUALIZADA'); expect(h).toContain('forn-nota fail'); expect(h).toContain('Dados desatualizados'); expect(h).toContain('O sincronismo completo está atrasado');
  });
  test('histórico parcial e sync desconhecido também são sinalizados; conciliação quebrada nunca passa em silêncio', async () => {
    const p = gerar({ modo: 'INCREMENTAL' }); expect(p.unidades.meta.atualizacao.status).toBe('DESCONHECIDA');
    expect((await (await tela({ unidades: p.unidades, valores: p.valores })).abrir()).painel()).toContain('Dados sem confirmação de atualização');
    const quebrado = JSON.parse(JSON.stringify(DOCS.unidades)); quebrado.conciliacao.fecha = false; quebrado.meta.limitacoes.push('CONCILIACAO_NAO_FECHA');
    const h = (await (await tela({ unidades: quebrado, valores: DOCS.valores })).abrir()).painel();
    expect(h).toContain('✗ a soma dos grupos NÃO fecha'); expect(h).toContain('não use estes números');
  });
  test('sem documento ainda / sem permissão: mensagens claras, sem quebrar a página', async () => {
    expect((await (await tela({ unidades: null, valores: null })).abrir()).painel()).toContain('ainda não foram geradas');
    expect((await (await tela({ unidades: null, valores: null, unidadesNegado: true, valoresNegado: true })).abrir()).painel()).toContain('Sem permissão para ver as vendas por fornecedor');
  });
});

describe('Aba Fornecedores — busca, ordenação, filtro e detalhe', () => {
  let t; beforeEach(async () => { t = await (await tela({ unidades: DOCS.unidades, valores: DOCS.valores })).abrir(); });
  test('padrão: maior média de unidades primeiro, só dentro de cada seção', () => {
    const ext = DOCS.unidades.externos.map(g => g.nome); expect(nomes(t.painel()).filter(x => ext.includes(x))).toEqual(ext);
    expect(DOCS.unidades.externos.map(g => g.media)).toEqual([...DOCS.unidades.externos.map(g => g.media)].sort((a, b) => b - a));
  });
  test('busca por fornecedor (nome ou código) filtra e preserva o foco', () => {
    t.digitar('fornBusca', 'beta'); expect(nomes(t.painel()).some(x => x === 'BETA IMPORTADORA')).toBe(true); expect(t.painel()).not.toContain('>GAMA<'); expect(t.painel()).not.toContain('ALFA');
    t.digitar('fornBusca', 'zzzz'); expect(t.painel()).toContain('Nenhum fornecedor encontrado');
  });
  test('filtro por agrupamento e ordem alternativa (nome, mês corrente, R$)', () => {
    t.seg('int'); expect(secoes(t.painel())).toEqual(['Origem interna']); t.seg('isp'); expect(secoes(t.painel())).toEqual(['Itens de venda sem produto cadastrado']);
    t.seg('ext'); t.ordem('nome'); const n = nomes(t.painel()); expect(n).toEqual([...n].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    t.ordem('rs'); expect(secoes(t.painel())).toEqual(['Fornecedores externos']); expect(t.F().ordem).toBe('rs');
    t.seg('todos'); expect(secoes(t.painel()).length).toBe(4);
  });
  test('detalhe: clicar no fornecedor lista os produtos com estoque atual, meses, média, mês corrente e reservado; recolhe ao clicar de novo', () => {
    const alfa = DOCS.unidades.externos.find(g => g.nome.startsWith('ALFA')); t.clicar(alfa.chave); const h = t.painel();
    expect(h).toContain('class="fdet"'); expect(h).toContain('Estoque atual'); expect(h).toContain('Produto P1'); expect(h).toContain('COD-P1');
    expect(h).toMatch(/RESERVADO 3 un/); expect(h).toMatch(/neg-num">-3</);                  // P3 com estoque negativo destacado
    expect(h).toContain('2 produto(s) vendido(s)');
    t.clicar(alfa.chave); expect(t.painel()).not.toContain('class="fdet"');
  });
  test('detalhe: produto comprado de vários fornecedores recebe o selo (atribuição ao último, sem dupla contagem)', () => {
    const zeta = DOCS.unidades.externos.find(g => g.nome === 'ZETA'); t.clicar(zeta.chave);
    expect(t.painel()).toMatch(/TAMBÉM COMPRADO DE 2 OUTRO\(S\) FORNECEDOR\(ES\)/); expect(t.painel()).toContain('Produto P2');
  });
  test('detalhe: busca de produto; produto sem fornecedor / item sem produto avisam que não geram sugestão automática', () => {
    const alfa = DOCS.unidades.externos.find(g => g.nome.startsWith('ALFA')); t.clicar(alfa.chave); t.digitar('fornBuscaProd', 'P3'); expect(t.painel()).toContain('Produto P3'); expect(t.painel()).not.toContain('Produto P1<');
    t.clicar(alfa.chave); t.seg('isp'); t.clicar('ITENS_SEM_PRODUTO'); expect(t.painel()).toContain('Item sem produto cadastrado'); expect(t.painel()).toContain('não gera sugestão automática de reposição');
    t.seg('sem'); t.clicar('SEM_FORNECEDOR'); expect(t.painel()).toContain('produto sem fornecedor identificado');
  });
  test('detalhe como gestor mostra R$/mês por produto; sem permissão não mostra', async () => {
    const alfa = DOCS.unidades.externos.find(g => g.nome.startsWith('ALFA')); t.clicar(alfa.chave); expect(t.painel()).toMatch(/prow val/);
    const s = await (await tela({ unidades: DOCS.unidades, valores: null, valoresNegado: true })).abrir(); s.clicar(alfa.chave); expect(s.painel()).not.toMatch(/prow val|R\$/);
  });
  test('documento resumido (sem detalhe por produto) é explicado', async () => {
    const r = JSON.parse(JSON.stringify(DOCS.unidades)); r.detalhe_produtos = false; r.externos.forEach(g => { g.produtos = []; });
    const s = await (await tela({ unidades: r, valores: DOCS.valores })).abrir(); s.clicar(r.externos[0].chave); expect(s.painel()).toContain('Detalhe por produto indisponível nesta geração');
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
