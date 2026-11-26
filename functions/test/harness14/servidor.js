'use strict';
// Servidor estático LOCAL do harness (127.0.0.1:5210). Serve só a tela e os scripts; /login.html é a entrada de teste.
const http = require('http'), fs = require('fs'), path = require('path');
const RAIZ = path.resolve(__dirname, '../../..');
const PORTA = 5210;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const fixos = { '/': 'entrar.html', '/login.html': 'entrar.html', '/__harness/usuarios.json': 'usuarios.json' };
http.createServer((req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const arquivo = fixos[caminho] ? path.join(__dirname, fixos[caminho]) : /^\/(modulos|js|assets)\/[A-Za-z0-9._-]+$/.test(caminho) ? path.join(RAIZ, caminho) : null;
  if (req.method !== 'GET' || !arquivo || !fs.existsSync(arquivo)) { res.writeHead(404); res.end('nao encontrado'); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(arquivo).pipe(res);
}).listen(PORTA, '127.0.0.1', () => console.log(`simulador (dados fictícios): http://localhost:${PORTA}/login.html`));
