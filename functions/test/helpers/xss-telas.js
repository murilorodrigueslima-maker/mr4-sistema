'use strict';
// Apoio ao teste de escape das telas: carrega o código REAL das páginas numa sandbox (vm) com DOM mínimo e analisa o HTML
// gerado com um parser HTML5 (parse5) e o código de cada atributo on* com o próprio motor JavaScript.
const fs = require('fs'), path = require('path'), vm = require('vm');
const parser = require('@babel/parser');
const parse5 = require('parse5');

const RAIZ = path.resolve(__dirname, '../../..');
const ler = rel => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

/** Blocos <script> sem src (ou o arquivo inteiro, se .js). */
function blocos(rel) {
  const t = ler(rel);
  if (rel.endsWith('.js')) return [t];
  const out = []; const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(t))) if (!/\bsrc=/.test(m[1])) out.push(m[2]);
  return out;
}

/** Código das declarações de topo com os nomes pedidos (function, const/let, window.x = …). Nome não encontrado é ignorado. */
function extrair(rel, nomes) {
  const quer = new Set(nomes); const partes = [];
  for (const codigo of blocos(rel)) {
    const ast = parser.parse(codigo, { sourceType: 'module' });
    for (const n of ast.program.body) {
      let nome = null, trecho = codigo.slice(n.start, n.end);
      if (n.type === 'FunctionDeclaration') nome = n.id.name;
      else if (n.type === 'VariableDeclaration') {
        for (const d of n.declarations) if (d.id.type === 'Identifier' && quer.has(d.id.name) && d.init) partes.push(`var ${d.id.name} = ${codigo.slice(d.init.start, d.init.end)};`);
      } else if (n.type === 'ExpressionStatement' && n.expression.type === 'AssignmentExpression' && n.expression.left.type === 'MemberExpression' && n.expression.left.object.name === 'window') nome = n.expression.left.property.name;
      if (nome && quer.has(nome)) partes.push(trecho);
    }
  }
  return partes.join('\n');
}

/** Elemento falso: guarda o que a página escreve. */
function elemento(tag = 'div') {
  const filhos = [];
  const e = {
    tagName: tag.toUpperCase(), innerHTML: '', textContent: '', value: '', disabled: false, checked: false, hidden: false, src: '', href: '', title: '', className: '', id: '',
    style: { setProperty() {} }, dataset: {}, filhos, options: [], selectedIndex: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, remove() {}, focus() {}, scrollIntoView() {}, click() {},
    appendChild(f) { filhos.push(f); return f; }, insertBefore(f) { filhos.push(f); return f; }, insertAdjacentHTML(_p, h) { e.innerHTML += h; },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
  };
  return e;
}

function sandbox(extra = {}) {
  const elementos = {}, criados = [];
  const document = {
    getElementById: id => (elementos[id] = elementos[id] || elemento()),
    createElement: tag => { const e = elemento(tag); criados.push(e); return e; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: elemento('body'),
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Date, Number, String, Object, Math, JSON, Promise, Set, Map, Array, Error, RegExp, Intl, Boolean, parseInt, parseFloat, isNaN, encodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, document, localStorage: { getItem: () => null, setItem() {} }, navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => false, alert() {}, prompt: () => null, ...extra,
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.addEventListener = () => {};
  vm.createContext(ctx);
  return { ctx, elementos, criados, rodar: codigo => vm.runInContext(codigo, ctx) };
}

/** Árvore → lista plana de elementos { tag, attrs } e o texto visível. */
function analisar(html) {
  const elems = []; let texto = '';
  (function andar(n) {
    if (n.nodeName === '#text') texto += n.value;
    else if (n.tagName) elems.push({ tag: n.tagName, attrs: Object.fromEntries(n.attrs.map(a => [a.name, a.value])) });
    for (const f of (n.content ? n.content.childNodes : n.childNodes) || []) andar(f);
  })(parse5.parseFragment(html));
  return { elems, texto };
}
const esqueleto = html => analisar(html).elems.map(e => `${e.tag}[${Object.keys(e.attrs).sort().join(',')}]`);

/** Executa cada atributo on* como o navegador faria e devolve as chamadas feitas: [{ atributo, nome, args }]. Erro de sintaxe lança. */
function chamadasDosAtributos(html) {
  const chamadas = [];
  for (const el of analisar(html).elems) {
    for (const [nome, codigo] of Object.entries(el.attrs)) {
      if (!nome.startsWith('on')) continue;
      const registrar = n => (...args) => { chamadas.push({ atributo: nome, nome: n, args }); };
      const alvo = { event: { stopPropagation() {}, preventDefault() {} }, setTimeout: f => f(), window: { open: registrar('open') }, document: { getElementById: () => elemento() } };
      for (const [, id] of codigo.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!(id in alvo) && !['if', 'function'].includes(id)) alvo[id] = registrar(id);
      alvo.PWN = registrar('PWN');
      alvo.__el = elemento(el.tag);
      vm.runInNewContext(`(function(){\n${codigo}\n}).call(__el)`, alvo);
    }
  }
  return chamadas;
}

// Texto hostil: fecha atributo (aspas simples e duplas), abre elementos, foge de string JavaScript, barra invertida e entidade literal.
const ATAQUE = `"'><img src=x onerror=PWN()></option></textarea><script>PWN()</script> ');PWN();// \\');PWN();// &#39;);PWN();// \`\${PWN()}`;

module.exports = { ler, blocos, extrair, sandbox, elemento, analisar, esqueleto, chamadasDosAtributos, ATAQUE };
