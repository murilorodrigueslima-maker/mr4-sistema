'use strict';
// Garante que o pacote do Firebase Hosting contém SÓ o front-end autorizado e nenhum segredo/dado (lista permitida).
const { execFileSync } = require('child_process'); const fs = require('fs'), path = require('path'), os = require('os');
const RAIZ = path.resolve(__dirname, '..', '..');
const { PERMITIDOS, PROIBIDOS_NOME, listar } = require(path.join(RAIZ, 'scripts/hosting/empacotar.js'));
describe('Hosting — pacote com lista permitida', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mr4-dist-'));
  let arquivos;
  beforeAll(() => { execFileSync('node', [path.join(RAIZ, 'scripts/hosting/empacotar.js'), out]); arquivos = listar(out); });
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));
  test('tem o essencial', () => { for (const a of ['index.html', 'login.html', 'painel-comercial.html', 'modulos/compras.html', 'js/sistema.js', 'assets/logo.png']) expect(arquivos).toContain(a); });
  test('todo arquivo está na lista permitida e nenhum tem nome proibido', () => { for (const a of arquivos) { expect(PERMITIDOS.some(r => r.test(a))).toBe(true); expect(PROIBIDOS_NOME.test(a)).toBe(false); } });
  test('nenhuma pasta de código/dados/documentos/regras vai junto', () => { expect(arquivos.filter(a => /^(functions|scripts|docs|artifacts|tools|worker|data)\//.test(a) || /firestore\.rules|\.md$|\.json$/.test(a))).toEqual([]); });
  test('firebase.json: hosting aponta para dist e define cabeçalhos de segurança', () => {
    const h = JSON.parse(fs.readFileSync(path.join(RAIZ, 'firebase.json'), 'utf8')).hosting; expect(h.public).toBe('dist');
    const all = JSON.stringify(h.headers); for (const k of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy', 'no-cache']) expect(all).toContain(k);
  });
  test('.gitignore ignora dist/', () => { expect(fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf8')).toMatch(/^dist\/?$/m); });
});
