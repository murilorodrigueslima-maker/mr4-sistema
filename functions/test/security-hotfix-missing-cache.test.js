'use strict';
// MR4 SECURITY HOTFIX RC — primeira publicação: Rules no ar + painel_cache ainda inexistente + tela nova.
// As telas devem falhar de forma segura: sem JSON público, sem zero apresentado como dado real,
// com mensagem compreensível e sem expor erro técnico/credencial.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');
const ler = f => fs.readFileSync(path.join(ROOT, 'modulos', f), 'utf8');
const scripts = (html, tipo) => [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(m => !/src=/.test(m[1]) && (tipo === 'module' ? /module/.test(m[1]) : !/module/.test(m[1]))).map(m => m[2]);

// DOM mínimo para executar o script clássico do caixa de verdade
function domFalso() {
  const els = {};
  const el = id => (els[id] = els[id] || { id, textContent: '', innerHTML: '', value: '', className: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector: () => el('_q'), querySelectorAll: () => [] });
  const store = {};
  return {
    els,
    document: { getElementById: el, querySelector: () => el('_q'), querySelectorAll: () => [], addEventListener() {}, createElement: () => el('_c') },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    store,
  };
}

describe('MISSING_CACHE_BEHAVIOR — caixa.html (executado)', () => {
  function carregar(cache) {
    const d = domFalso();
    const ctx = { document: d.document, localStorage: d.localStorage, window: {}, console: { log() {}, warn() {}, error() {} }, setTimeout, alert() {}, confirm: () => true };
    ctx.window = ctx;
    ctx.window.__lerCaixaCache = async () => { if (cache === 'negado') { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } return cache; };
    vm.createContext(ctx);
    vm.runInContext(scripts(ler('caixa.html'), 'classic').join('\n'), ctx);
    return { ctx, d };
  }
  test('cache inexistente: "Indisponível", conferência NÃO compara com zero e o histórico grava null (não 0)', async () => {
    const { ctx, d } = carregar(null);
    await ctx.inicializar();
    expect(d.els.kpiGC.textContent).toBe('Indisponível');
    d.els.inPix = { value: '150' };
    ctx.calcular();
    expect(d.els.reconStatus.textContent).toMatch(/indisponível/i);
    expect(d.els.kpiStatus.textContent).toBe('—');
    expect(d.els.reconDetail.innerHTML).not.toMatch(/Diferença|Falta|Sobra/);
    ctx.salvar();                                   // fechamento salvo sem o total do GC
    const hist = JSON.parse(Object.values(d.store)[0] || '[]');
    expect(hist).toHaveLength(1);
    expect(hist[0].gc_total).toBeNull();            // null = indisponível, nunca 0
    ctx.renderHistorico && ctx.renderHistorico();
  });
  test('sem permissão: mensagem clara, sem detalhe técnico', async () => {
    const { ctx, d } = carregar('negado');
    await ctx.inicializar();
    expect(d.els.kpiGC.textContent).toBe('Indisponível');
    expect(d.els.lastUpdate.textContent).toBe('Sem permissão para o faturamento (módulo Caixa)');
  });
  test('cache presente: comportamento de conferência inalterado', async () => {
    const { ctx, d } = carregar({ hoje: 100, atualizado_em: '2026-09-28T10:00:00' });
    await ctx.inicializar();
    d.els.inPix = { value: '100' };
    ctx.calcular();
    expect(d.els.reconStatus.textContent).toMatch(/conferem/);
  });
});

describe('MISSING_CACHE_BEHAVIOR — vendas.html e estoque.html (inspeção do caminho sem dados)', () => {
  test('vendas: sem dados → aviso + "—" e retorna ANTES de renderDashboard (sem zeros "reais")', () => {
    const m = scripts(ler('vendas.html'), 'module').join('\n');
    const bloco = m.slice(m.indexOf('if (!dataFound) {'), m.indexOf('renderDashboard(data);'));
    expect(bloco).toMatch(/noDataBanner'\)\.style\.display = ''/);
    expect(bloco).toMatch(/\['kpiHoje', 'kpiMes', 'kpiPct'\]\) document\.getElementById\(id\)\.textContent = '—'/);
    expect(bloco).toMatch(/return;/);
    expect(bloco).not.toMatch(/hoje:\s*0|mes:\s*0/);
  });
  test('estoque: sem dados → "—" em KPIs e contadores, aviso nas tabelas e retorna (sem "0 produtos")', () => {
    const m = scripts(ler('estoque.html'), 'module').join('\n');
    const bloco = m.slice(m.indexOf("const semPermissao"), m.indexOf("try {\n      const snapC"));
    expect(bloco).toMatch(/kpiTotalProdutos', 'kpiValorEstoque', 'kpiAbaixoMinimo', 'kpiSemGiro'\]\) document\.getElementById\(id\)\.textContent = '—'/);
    expect(bloco).toMatch(/emptyState\(semPermissao \? '🔒' : '⏳', titulo, desc\)/);
    expect(bloco).toMatch(/return;/);
    expect(bloco).not.toMatch(/total_produtos:\s*0/);
  });
  test('nenhuma tela volta para JSON público nem mostra e.message/stack ao usuário', () => {
    for (const f of ['vendas.html', 'caixa.html', 'estoque.html']) {
      const s = ler(f);
      expect(s).not.toMatch(/fetch\(['"`][^'"`]*data\//);
      expect(s).not.toMatch(/textContent\s*=\s*[^;]*e\.(message|stack)/);
      expect(s).not.toMatch(/innerHTML\s*=\s*[^;]*e\.(message|stack)/);
    }
  });
});
