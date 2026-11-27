'use strict';
/**
 * Executa as PÁGINAS REAIS do ponto (ponto.html / ponto-func.html) num contexto Node, contra o emulador:
 * o <script type="module"> e o <script> clássico são os do arquivo (ou de um commit do Git = "tela antiga em cache");
 * só o SDK modular é substituído por um adaptador sobre o Firestore AUTENTICADO do rules-unit-testing — então toda
 * leitura/escrita passa pelas Rules de verdade. O escopo do módulo é separado do clássico, como no navegador.
 * Callables: chamam os handlers reais das Functions (Admin SDK) informados em `callables`. Dados sempre fictícios.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const { webcrypto } = require('crypto');
const { serverTimestamp } = require('@firebase/firestore');

const RAIZ = path.resolve(__dirname, '../../..');
/** Telas publicadas em 26/11/2026 (antes desta entrega): continuam em cache em aparelhos durante a transição. */
const REF_TELAS_ANTIGAS = '890594c';

function ler(arquivo, ref) {
  return ref ? cp.execFileSync('git', ['-C', RAIZ, 'show', `${ref}:${arquivo}`], { encoding: 'utf8', maxBuffer: 1e8 })
    : fs.readFileSync(path.join(RAIZ, arquivo), 'utf8');
}

function elemento(id) {
  const alvo = {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false, files: [], options: [], width: 300, height: 120, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, append() {}, remove() {}, insertAdjacentHTML() {}, addEventListener() {}, removeEventListener() {}, focus() {}, scrollIntoView() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => elemento('q'), querySelectorAll: () => [], closest: () => null,
    getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }),
    toDataURL: () => 'data:image/png;base64,QVNTSU5BVFVSQQ==', getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 120 }),
    parentElement: { clientWidth: 348 },
  };
  return alvo;
}

/** objetos criados no contexto da página (outro "realm") viram objetos do Node; sentinelas/Timestamp passam intactos */
function paraNode(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Array.from(v, paraNode);
  const proto = Object.getPrototypeOf(v);
  if (proto === null || (proto.constructor && proto.constructor.name === 'Object')) {
    const o = {}; for (const k of Object.keys(v)) o[k] = paraNode(v[k]); return o;
  }
  return v;
}

function adaptadorSdk(db, uid, email, callables) {
  const snap = s => ({ id: s.id, exists: () => s.exists, data: () => s.data(), ref: s.ref });
  const lista = s => ({ docs: s.docs.map(snap), size: s.size, empty: s.empty, forEach: f => s.docs.map(snap).forEach(f) });
  return {
    initializeApp: () => ({}), getAuth: () => ({ currentUser: { uid, email } }), signOut: async () => {},
    onAuthStateChanged: (_a, cb) => { adaptadorSdk.pendentes.push(() => cb({ uid, email })); },
    getFirestore: () => db, getFunctions: () => ({}),
    collection: (d, n) => d.collection(n), doc: (d, c, i) => d.collection(c).doc(i),
    query: (ref, ...cs) => cs.reduce((q, c) => c(q), ref),
    where: (f, op, v) => q => q.where(f, op, paraNode(v)), orderBy: (f, dir) => q => q.orderBy(f, dir), limit: n => q => q.limit(n),
    getDoc: async ref => snap(await ref.get()), getDocs: async q => lista(await q.get()),
    setDoc: (ref, data, o) => ref.set(paraNode(data), paraNode(o || {})), updateDoc: (ref, data) => ref.update(paraNode(data)), deleteDoc: ref => ref.delete(),
    writeBatch: d => {
      const b = d.batch();
      const w = { set: (r, x, o) => { b.set(r, paraNode(x), paraNode(o || {})); return w; }, update: (r, x) => { b.update(r, paraNode(x)); return w; }, delete: r => { b.delete(r); return w; }, commit: () => b.commit() };
      return w;
    },
    serverTimestamp: () => serverTimestamp(),
    httpsCallable: (_f, nome) => async data => {
      if (!callables[nome]) { const e = new Error('callable não simulada: ' + nome); e.code = 'functions/not-found'; throw e; }
      try { return { data: await callables[nome]({ auth: { uid, token: { email } }, data: paraNode(data) }) }; }
      catch (e) { const x = new Error(e.message); x.code = 'functions/' + (e.code || 'internal'); x.details = e.details; throw x; }
    },
  };
}
adaptadorSdk.pendentes = [];

/**
 * @param pagina 'ponto.html' | 'ponto-func.html'
 * @param o { db, uid, email, ref (commit), callables, prompt }
 * @returns { ctx, el(id), set(id, valor), run(codigo), avisos, erros }
 */
async function abrirPagina(pagina, o) {
  const html = ler('modulos/' + pagina, o.ref);
  const regras = ler('modulos/ponto-regras.js', o.ref);
  const modulo = html.slice(html.indexOf('<script type="module">') + 22, html.indexOf('</script>', html.indexOf('<script type="module">')));
  const ini = html.lastIndexOf('\n<script>\n');
  const classico = html.slice(ini + 10, html.lastIndexOf('</script>'));
  const els = {}, ouvintes = {}, avisos = [], erros = [];
  const el = id => (els[id] = els[id] || elemento(id));
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error: (...a) => erros.push(a.map(x => (x && x.message) || String(x)).join(' ')) },
    document: { getElementById: el, querySelector: s => el('sel:' + s), querySelectorAll: () => [], createElement: () => elemento('novo'), addEventListener() {}, body: elemento('body') },
    location: { href: 'http://127.0.0.1/modulos/' + pagina, search: '', reload() {} },
    navigator: { userAgent: 'teste', clipboard: { writeText: async () => {} } },
    addEventListener: (t, f) => { (ouvintes[t] = ouvintes[t] || []).push(f); },
    dispatchEvent: e => { (ouvintes[e.type] || []).forEach(f => f(e)); return true; },
    Event: class { constructor(t) { this.type = t; } },
    confirm: () => true, alert: m => avisos.push(String(m)), prompt: () => (o.prompt === undefined ? null : o.prompt),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
    crypto: webcrypto, TextEncoder, Intl, Date, Math, JSON, Promise,
    __sdk: adaptadorSdk(o.db, o.uid, o.email || o.uid + '@exemplo.test', o.callables || {}),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(regras, ctx, { filename: 'ponto-regras.js' });
  vm.runInContext(classico, ctx, { filename: pagina });
  // notificações da tela
  vm.runInContext('if (typeof notif === "function") { const __n = notif; notif = function (m, t) { __avisos.push(String(m)); return __n(m, t); }; }', Object.assign(ctx, { __avisos: avisos }));
  adaptadorSdk.pendentes = [];
  const nomes = Object.keys(ctx.__sdk);
  vm.runInContext(`(function(){const {${nomes.join(',')}} = __sdk;\n${modulo.replace(/import\s*\{[^}]*\}\s*from\s*'[^']*';?/g, '')}\n})();`, ctx, { filename: pagina + ':module' });
  for (const p of adaptadorSdk.pendentes) await p();
  await assentar();
  return {
    ctx, el, avisos, erros,
    set: (id, v) => { el(id).value = v; },
    run: codigo => vm.runInContext(codigo, ctx),
  };
}
/** espera as promessas disparadas sem await pela própria tela (renderizações) */
async function assentar(ms = 150) { await new Promise(r => global.setTimeout(r, ms)); }

module.exports = { abrirPagina, assentar, ler, RAIZ, REF_TELAS_ANTIGAS };
