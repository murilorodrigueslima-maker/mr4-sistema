'use strict';
// Expedição P0 — o <script> REAL da página (modulos/expedicao.html) numa sandbox (vm) com DOM mínimo.
// Prova o comportamento da tela: nada muda antes da confirmação, falha não deixa estado falso, conflito mostra a
// verdade do servidor, mudanças de outra tela chegam pelo listener, e a tela não consulta o GestãoClick.
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/expedicao.html'), 'utf8');
const CORE = fs.readFileSync(path.join(__dirname, '../../js/expedicao-core.js'), 'utf8');
const ini = HTML.indexOf('<script>\n// ── CONFIG'), fim = HTML.indexOf('</script>', ini);
const SCRIPT = HTML.slice(ini + '<script>'.length, fim);
const MODULO = HTML.slice(HTML.indexOf('<script type="module">'), HTML.indexOf('</script>', HTML.indexOf('<script type="module">')));

function el() { return { textContent: '', innerHTML: '', value: '', disabled: false, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {} }; }
function tela({ transacao }) {
  const elementos = {}, toasts = [], h = {};
  const ctx = { console: { log() {}, warn() {} }, Date, Number, String, Object, Math, JSON, Promise, Set, Array, Error,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: id => (elementos[id] = elementos[id] || el()), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => { const e = el(); return e; } } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  ctx._expAdapter = { transacao };
  ctx._expServerTimestamp = () => '__TS__';
  ctx._expUsuario = { uid: 'u-a', papel: 'funcionario' };
  ctx._expOuvir = (inicio, handlers) => { Object.assign(h, handlers); h.inicio = inicio; return () => {}; };
  ctx._expOuvirSync = cb => { h.sync = cb; };
  vm.runInContext(SCRIPT + '\n;globalThis.__S = S; globalThis.__toastOrig = toast; toast = (m, t) => { globalThis.__toasts.push({ m, t }); };', Object.assign(ctx, { __toasts: toasts }));
  ctx.iniciarPainel();
  const col = c => elementos['col-' + c] ? elementos['col-' + c].innerHTML : '';
  return { ctx, h, toasts, col, S: () => ctx.__S };
}
const hojeMs = Date.now();
const pedido = (coluna, o = {}) => ({ numero: '1000001', coluna, versao: 2, ingresadoEm: hojeMs - 60000, movidoEm: hojeMs, cliente: 'Cliente Sintético', vendedor: 'V', itens: 1, valor: 10, cidade: '', envio: coluna === 'ag' ? null : 'retirada', saidaEm: coluna === 'de' ? hojeMs : null, data: '', hora: '', ...o });

describe('tela da Expedição (script real)', () => {
  test('WRITE FAILURE: escrita falha → card continua na coluna real, nada otimista, erro informado, sem "processando" preso', async () => {
    const t = tela({ transacao: async () => { throw new Error('unavailable (rede simulada)'); } });
    t.h.ativos([pedido('se')], [], false);
    expect(t.col('se')).toContain('card-1000001');
    await t.ctx.marcarSeparado('1000001');
    expect(t.S().pedidos['1000001'].coluna).toBe('se');
    expect(t.col('se')).toContain('card-1000001'); expect(t.col('pr')).not.toContain('card-1000001');
    expect(t.S().processando.size).toBe(0);
    expect(t.toasts.some(x => x.t === 't-error' && /nada foi alterado/.test(x.m))).toBe(true);
    expect(t.toasts.some(x => x.t === 't-success')).toBe(false);
  });
  test('SUCESSO: o card só muda quando o listener confirma (nunca antes)', async () => {
    let chamada = null;
    const t = tela({ transacao: async fn => { chamada = true; return { de: 'se', para: 'pr' }; } });
    t.h.ativos([pedido('se')], [], false);
    await t.ctx.marcarSeparado('1000001');
    expect(chamada).toBe(true);
    expect(t.S().pedidos['1000001'].coluna).toBe('se');            // sem mudança otimista
    t.h.ativos([pedido('pr', { versao: 3 })], [], false);          // confirmação chega pelo listener
    expect(t.col('pr')).toContain('card-1000001'); expect(t.col('se')).not.toContain('card-1000001');
  });
  test('STALE: servidor já está em "de" → tela mostra a verdade e avisa "atualizado em outra tela"', async () => {
    const t = tela({ transacao: async fn => fn({ ler: async () => pedido('de', { versao: 5 }), atualizar() { throw new Error('não deveria gravar'); }, criarEvento() { throw new Error('não deveria gravar'); } }) });
    t.h.ativos([pedido('se')], [], false);
    await t.ctx.marcarSeparado('1000001');
    expect(t.S().ativos['1000001']).toBeUndefined();               // saiu dos ativos (verdade do servidor)
    expect(t.toasts.some(x => /atualizado em outra tela/.test(x.m) && /Despachado/.test(x.m))).toBe(true);
  });
  test('LIVE UPDATE: outra tela move o pedido → esta tela reflete sem recarregar', () => {
    const t = tela({ transacao: async () => ({}) });
    t.h.ativos([pedido('ag')], [], false);
    expect(t.col('ag')).toContain('card-1000001');
    t.h.ativos([], [], false); t.h.hoje([pedido('de', { versao: 3 })]);
    expect(t.col('de')).toContain('card-1000001'); expect(t.col('ag')).not.toContain('card-1000001');
  });
  test('duplo clique: segunda ação no mesmo pedido é ignorada enquanto a primeira está em andamento', async () => {
    let n = 0, liberar; const pendente = new Promise(r => { liberar = r; });
    const t = tela({ transacao: async () => { n++; await pendente; return {}; } });
    t.h.ativos([pedido('se')], [], false);
    const p1 = t.ctx.marcarSeparado('1000001'); const p2 = t.ctx.marcarSeparado('1000001');
    expect(t.col('se')).toMatch(/disabled/);
    liberar(); await p1; await p2;
    expect(n).toBe(1);
  });
  test('Reabrir: botão só para gestor; motivo obrigatório', async () => {
    const t = tela({ transacao: async () => { throw new Error('não deveria chamar'); } });
    t.h.hoje([pedido('de')]);
    expect(t.col('de')).not.toContain('abrirReabrirModal');
    t.ctx._expUsuario = { uid: 'g', papel: 'gestor' }; t.h.hoje([pedido('de')]);
    expect(t.col('de')).toContain('abrirReabrirModal');
    t.ctx.abrirReabrirModal('1000001'); t.ctx.document.getElementById('reabrirMotivo').value = 'x';
    await t.ctx.confirmarReabrir();
    expect(t.toasts.some(x => /motivo/i.test(x.m))).toBe(true);
  });
  test('novo pedido chegando pelo listener avisa (não no carregamento inicial)', () => {
    const t = tela({ transacao: async () => ({}) });
    t.h.ativos([pedido('se')], [pedido('se')], false);
    expect(t.toasts.some(x => /novo/.test(x.m))).toBe(false);
    const novo = pedido('ag', { numero: '1000002', versao: 0 });
    t.h.ativos([pedido('se'), novo], [novo], false);
    expect(t.toasts.some(x => /1 novo pedido/.test(x.m))).toBe(true);
  });
  test('a página NÃO consulta o GestãoClick, NÃO lê a coleção inteira e NÃO grava fora da transação', () => {
    expect(HTML).not.toMatch(/gcQuery|httpsCallable|getFunctions/);
    expect(HTML).not.toMatch(/getDocs\s*\(|setDoc\s*\(|updateDoc\s*\(|addDoc\s*\(|deleteDoc\s*\(/);
    expect(MODULO).toMatch(/where\('coluna', 'in', \['ag', 'se', 'pr'\]\)/);
    expect(MODULO).toMatch(/where\('saidaEm', '>=', inicioDiaMs\)/);
    expect(MODULO).toMatch(/runTransaction/);
    expect(SCRIPT).not.toMatch(/\.coluna\s*=\s*['"]/);           // nenhuma atribuição otimista de coluna
  });
});
