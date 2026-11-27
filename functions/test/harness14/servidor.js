'use strict';
// Servidor estático LOCAL do harness (127.0.0.1:5320). Serve só a tela e os scripts; /login.html é a entrada de teste.
// A tela de Compras é a de produção com a configuração TROCADA na hora pela dos emuladores; se a troca não for exata, não é servida.
const http = require('http'), fs = require('fs'), path = require('path');
const RAIZ = path.resolve(__dirname, '../../..');
const PORTA = 5320;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const fixos = { '/': 'entrar.html', '/login.html': 'entrar.html', '/__harness/usuarios.json': 'usuarios.json' };

function comprasParaEmulador(html) {
  const trocas = [
    [/const FIREBASE_CONFIG = \{[\s\S]*?\};/, "const FIREBASE_CONFIG = { apiKey: 'demo-chave-local', authDomain: 'demo-mr4-sim14.firebaseapp.com', projectId: 'demo-mr4-sim14' };"],
    [/const db = getFirestore\(app\);/, "const db = getFirestore(app);\n(await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js')).connectFirestoreEmulator(db, '127.0.0.1', 8320);\n(await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js')).connectAuthEmulator(auth, 'http://127.0.0.1:9320', { disableWarnings: true });"],
    [/ {2}liberarAgente\(\);[^\n]*\n/, '\n'],                       // o agente (IA) não faz parte deste teste
  ];
  let out = html;
  for (const [de, para] of trocas) { if (!de.test(out)) return null; out = out.replace(de, () => para); }
  return /mr4-ponto|AIza/.test(out) ? null : out;
}

if (require.main === module) http.createServer((req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const arquivo = fixos[caminho] ? path.join(__dirname, fixos[caminho]) : /^\/(modulos|js|assets)\/[A-Za-z0-9._-]+$/.test(caminho) ? path.join(RAIZ, caminho) : null;
  if (req.method !== 'GET' || !arquivo || !fs.existsSync(arquivo)) { res.writeHead(404); res.end('nao encontrado'); return; }
  const cab = { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  // das telas do sistema, só as duas deste teste (as demais apontam para a produção)
  if (/^\/modulos\/.*\.html$/.test(caminho) && !['/modulos/compras-simulador14.html', '/modulos/compras.html'].includes(caminho)) { res.writeHead(404); res.end('fora do harness'); return; }
  if (caminho === '/modulos/compras.html') {
    const html = comprasParaEmulador(fs.readFileSync(arquivo, 'utf8'));
    res.writeHead(html ? 200 : 500, cab); res.end(html || 'recusado: nao foi possivel apontar a tela para os emuladores'); return;
  }
  res.writeHead(200, cab); fs.createReadStream(arquivo).pipe(res);
}).listen(PORTA, '127.0.0.1', () => console.log(`planejamento de compra (dados fictícios): http://localhost:${PORTA}/login.html`));
module.exports = { comprasParaEmulador, PORTA };
