'use strict';
// PONTO — INICIALIZAÇÃO APÓS LOGIN (regressão do incidente de 30/09/2026: spinner infinito em ponto.html).
// Executa o <script type="module"> REAL de cada página numa sandbox (vm) com Firebase/DOM falsos e dispara o onAuthStateChanged como
// um usuário real: o listener NUNCA pode rejeitar (exceção antes de esconder o loader = spinner eterno) e o caminho feliz tem de
// esconder o loader, mostrar o painel e sinalizar "pronto". Causa original: `perfil` (const dentro do try) usado fora do try.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ler = f => fs.readFileSync(path.join(__dirname, '../../modulos', f), 'utf8');
function modulo(html) { const i = html.indexOf('<script type="module">') + '<script type="module">'.length; return html.slice(i, html.indexOf('</script>', i)); }
const nomes = src => [...src.matchAll(/^import \{([^}]+)\} from [^;]+;/gm)].flatMap(m => m[1].split(',').map(s => s.trim()));

function elemento() { const e = { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, innerHTML: '', textContent: '', value: '', children: [], options: [], selectedOptions: [], files: [], childNodes: [], parentNode: null, selectedIndex: 0, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({}), getContext: () => ({}), insertAdjacentHTML() {}, remove() {}, replaceWith() {}, after() {}, before() {}, closest: () => null, contains: () => false, appendChild() {}, querySelector: () => elemento(), querySelectorAll: () => [], setAttribute() {}, focus() {}, click() {} }; return e; }
async function rodar(pagina, { user, docs }) {
  const src = modulo(ler(pagina)); const els = {}; const eventos = []; let cb = null; const nav = { href: '' };
  const janela = { location: nav, addEventListener() {}, dispatchEvent: e => { eventos.push(e.type); return true; }, _erros: [] };
  const ctx = { console: { log() {}, warn() {}, error: (...a) => janela._erros.push(a.map(String).join(' ')), info() {} }, Date, Math, JSON, Promise, Set, Map, Array, Object, String, Number, Error, parseInt, parseFloat, isNaN, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Event: class { constructor(t) { this.type = t; } }, navigator: { geolocation: {}, userAgent: 'jest' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: id => (els[id] = els[id] || elemento()), querySelectorAll: () => [], querySelector: () => elemento(), addEventListener() {}, createElement: () => elemento(), body: elemento(), documentElement: elemento() },
    window: janela, location: nav, FormData: class {}, URL, Blob: class {}, FileReader: class {}, Image: class {}, alert() {}, confirm: () => false };
  for (const n of nomes(src)) ctx[n] = (...a) => ({ _n: n, a });
  ctx.initializeApp = () => ({}); ctx.getAuth = () => ({}); ctx.getFirestore = () => ({}); ctx.getFunctions = () => ({}); ctx.httpsCallable = () => async () => ({ data: {} });
  ctx.onAuthStateChanged = (a, f) => { cb = f; }; ctx.signOut = async () => {}; ctx.doc = (_d, c, id) => ({ c, id }); ctx.collection = (_d, c) => ({ c }); ctx.serverTimestamp = () => 'TS';
  ctx.getDoc = async r => { const d = docs[r.c + '/' + r.id]; return { id: r.id, exists: () => d !== undefined, data: () => d }; };
  ctx.getDocs = async () => ({ docs: [], size: 0, empty: true, forEach() {} }); ctx.query = (...a) => ({ a }); ctx.where = (...a) => a; ctx.orderBy = (...a) => a; ctx.limit = n => n;
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(src.replace(/^import \{[^}]+\} from [^;]+;\s*$/gm, ''), ctx);
  expect(typeof cb).toBe('function');
  let erro = null; try { await cb(user); } catch (e) { erro = e; }
  return { erro, els, janela, eventos, nav, loaderOculto: () => els.loadingScreen && els.loadingScreen.style.display === 'none' };
}
const U = { uid: 'uid-teste', email: 'teste@example.test' };
const perfil = (role, extra = {}) => ({ 'users/uid-teste': { role, ativo: true, funcionarioId: 'F-1', ...extra } });
const sys = (o) => ({ 'sistema_usuarios/uid-teste': o });

describe('ponto.html (gestão) — inicialização após login', () => {
  const caminhos = [
    ['gestor com módulo ponto', { ...perfil('gestor'), ...sys({ modulos: ['ponto'] }) }],
    ['gestor admin', { ...perfil('gestor'), ...sys({ admin: true, modulos: [] }) }],
    ['dual-role (funcionário com módulo ponto)', { ...perfil('funcionario'), ...sys({ modulos: ['ponto'] }) }],
  ];
  test.each(caminhos)('%s: listener NÃO rejeita, loader some, painel aparece, firebaseReady é emitido', async (_n, docs) => {
    const r = await rodar('ponto.html', { user: U, docs });
    expect(r.erro).toBeNull();                                   // antes do patch: ReferenceError: perfil is not defined
    expect(r.loaderOculto()).toBe(true);
    expect(r.els.dashboard.style.display).toBe('flex');
    expect(r.janela._firebaseReady).toBe(true); expect(r.eventos).toContain('firebaseReady');
    expect(r.janela._userEmail).toBe(U.email);
  });
  test('dual-role: _meuFuncId vem do cadastro (esconde ações sobre o próprio ponto); gestor puro: null/undefined', async () => {
    const d = await rodar('ponto.html', { user: U, docs: { ...perfil('funcionario'), ...sys({ modulos: ['ponto'] }) } }); expect(d.erro).toBeNull(); expect(d.janela._meuFuncId).toBe('F-1'); expect(d.janela._isDualRole).toBe(true);
    const g = await rodar('ponto.html', { user: U, docs: { 'users/uid-teste': { role: 'gestor', ativo: true }, ...sys({ admin: true }) } }); expect(g.erro).toBeNull(); expect(g.janela._meuFuncId).toBeNull();
  });
  test('caminhos de bloqueio continuam bloqueando SEM exceção (mensagem no lugar do spinner)', async () => {
    for (const [docs, msg] of [[{}, /Acesso não autorizado/], [{ ...perfil('gestor'), ...sys({ modulos: ['vendas'] }) }, /Módulo Ponto não liberado/], [{ ...perfil('gestor', { ativo: false }), ...sys({ admin: true }) }, /Acesso não autorizado/]]) {
      const r = await rodar('ponto.html', { user: U, docs }); expect(r.erro).toBeNull(); expect(r.els.loadingScreen.innerHTML).toMatch(msg); expect(r.janela._firebaseReady).toBeFalsy();
    }
  });
  test('funcionário comum vai para ponto-func.html; sem usuário vai para o login', async () => {
    const f = await rodar('ponto.html', { user: U, docs: { ...perfil('funcionario'), ...sys({ modulos: ['vendas'] }) } }); expect(f.erro).toBeNull(); expect(f.nav.href).toBe('ponto-func.html');
    const a = await rodar('ponto.html', { user: null, docs: {} }); expect(a.erro).toBeNull(); expect(a.nav.href).toMatch(/login\.html$/);
  });
  test('varredura: nenhuma variável declarada dentro do try do listener é usada depois dele', () => {
    const src = modulo(ler('ponto.html')); const ini = src.indexOf('onAuthStateChanged(auth'); const corpo = src.slice(ini);
    const t0 = corpo.indexOf('try {'), c0 = corpo.indexOf('} catch(e)'); const dentro = corpo.slice(t0, c0), depois = corpo.slice(c0, corpo.indexOf('\n});', c0));
    const declaradas = [...dentro.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]);
    for (const v of declaradas) expect([v, new RegExp('\\b' + v + '\\b').test(depois.replace(/console\.warn\([^)]*\)/g, ''))]).toEqual([v, false]);
  });
});

describe('ponto-func.html (funcionário) — inicialização após login', () => {
  test('funcionário ativo: listener não rejeita e sinaliza authReady com o cadastro', async () => {
    const r = await rodar('ponto-func.html', { user: U, docs: { ...perfil('funcionario'), 'funcionarios/F-1': { nome: 'Func Teste' } } });
    expect(r.erro).toBeNull(); expect(r.eventos).toContain('authReady'); expect(r.janela._funcAtivo).toMatchObject({ id: 'F-1' });
  });
  test('gestor recebe aviso de acesso restrito; conta inativa/sem vínculo recebe mensagem — sem exceção e sem spinner mudo', async () => {
    for (const [docs, msg] of [[{ ...perfil('gestor') }, /Acesso restrito/], [{ ...perfil('funcionario', { ativo: false }) }, /Conta inativa/], [{}, /Conta não vinculada/], [{ ...perfil('funcionario') }, /Funcionário não encontrado/]]) {
      const r = await rodar('ponto-func.html', { user: U, docs }); expect(r.erro).toBeNull(); expect(r.els.loadingScreen.innerHTML).toMatch(msg);
    }
  });
});

// ── Fluxo COMPLETO: módulo + motor + script da página, login → evento de "pronto" → primeira renderização ────────────────────────────
// (o módulo sozinho não pega erro na inicialização que vem DEPOIS do evento; aqui nenhum ReferenceError/TypeError pode escapar)
function scriptsClassicos(html) { const out = []; const re = /<script(?![^>]*type="module")(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html))) out.push(m[1]); return out; }
async function rodarCompleto(pagina, { user, docs, evento }) {
  const html = ler(pagina), src = modulo(html); const els = {}; const ouvintes = {}; let cb = null; const erros = [];
  const janela = { location: { href: '' }, addEventListener: (t, f) => { (ouvintes[t] = ouvintes[t] || []).push(f); }, removeEventListener() {}, dispatchEvent: e => { for (const f of ouvintes[e.type] || []) { try { const r = f(e); if (r && r.catch) r.catch(x => erros.push('async:' + x.name + ': ' + x.message)); } catch (x) { erros.push(x.name + ': ' + x.message); } } return true; }, setTimeout, clearTimeout, jspdf: { jsPDF: class {} } };
  const ctx = { console: { log() {}, warn() {}, info() {}, error: (...a) => erros.push('console.error: ' + a.map(x => (x && x.message) || String(x)).join(' ')) }, Date, Math, JSON, Promise, Set, Map, Array, Object, String, Number, Error, RegExp, parseInt, parseFloat, isNaN, Intl, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: f => setTimeout(f, 0),
    Event: class { constructor(t) { this.type = t; } }, navigator: { geolocation: { getCurrentPosition() {} }, userAgent: 'jest', mediaDevices: {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: id => (els[id] = els[id] || elemento()), querySelectorAll: () => [], querySelector: () => elemento(), addEventListener() {}, createElement: () => elemento(), body: elemento(), documentElement: elemento(), head: elemento() },
    window: janela, FormData: class {}, URL, Blob: class {}, FileReader: class {}, Image: class {}, alert() {}, confirm: () => false, prompt: () => null, fetch: async () => ({ ok: true, json: async () => ({}) }), structuredClone: x => JSON.parse(JSON.stringify(x)) };
  for (const n of nomes(src)) ctx[n] = (...a) => ({ _n: n, a });
  Object.assign(ctx, { initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), getFunctions: () => ({}), httpsCallable: () => async () => ({ data: {} }), onAuthStateChanged: (a, f) => { cb = f; }, signOut: async () => {}, doc: (_d, c, id) => ({ c, id }), collection: (_d, c) => ({ c }), serverTimestamp: () => 'TS',
    getDoc: async r => { const d = docs[r.c + '/' + r.id]; return { id: r.id, exists: () => d !== undefined, data: () => d }; }, getDocs: async q => ({ docs: [], size: 0, empty: true, forEach() {} }), query: (...a) => ({ a }), where: (...a) => a, orderBy: (...a) => a, limit: n => n, writeBatch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }), setDoc: async () => {}, deleteDoc: async () => {} });
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(src.replace(/^import \{[^}]+\} from [^;]+;\s*$/gm, ''), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), ctx);
  for (const s of scriptsClassicos(html)) { if (/^\s*window\.onload=function/.test(s)) continue; try { vm.runInContext(s, ctx); } catch (e) { erros.push('script: ' + e.name + ': ' + e.message); } }
  await cb(user); await new Promise(r => setTimeout(r, 50));
  return { erros, els, janela };
}
describe('fluxo completo após login (sem erros de código da página)', () => {
  test('ponto.html (gestão): login → firebaseReady → primeira renderização sem ReferenceError/TypeError; loader oculto', async () => {
    const r = await rodarCompleto('ponto.html', { user: U, docs: { ...perfil('gestor'), ...sys({ admin: true }) } });
    expect(r.erros.filter(e => /ReferenceError|is not defined|Cannot read/.test(e))).toEqual([]);
    expect(r.els.loadingScreen.style.display).toBe('none'); expect(r.els.dashboard.style.display).toBe('flex');
  });
  test('ponto-func.html (funcionário): login → authReady → iniciarApp sem ReferenceError/TypeError; loader oculto', async () => {
    const r = await rodarCompleto('ponto-func.html', { user: U, docs: { ...perfil('funcionario'), 'funcionarios/F-1': { nome: 'Func Teste', jornada: '8' } } });
    expect(r.erros.filter(e => /ReferenceError|is not defined|Cannot read/.test(e))).toEqual([]);
    expect(r.els.loadingScreen.style.display).toBe('none');
  });
});
