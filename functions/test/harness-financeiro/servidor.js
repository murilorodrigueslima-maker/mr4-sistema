'use strict';
// Harness local do Financeiro (chamado por iniciar.sh): semeia dados FICTÍCIOS nos emuladores e serve a página em http://localhost:5230.
// Isolamento: recusa rodar fora dos emuladores 8230/9230; a página é servida com as portas e o projeto trocados em memória
// (o arquivo do repositório não muda) e com Content-Security-Policy que só permite falar com os emuladores locais.
const fs = require('fs'), path = require('path'), http = require('http'), { createRequire } = require('module');
const RAIZ = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(RAIZ, 'functions', 'package.json'));
const PORTA = 5230, PROJETO = 'demo-mr4-fin';
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8230' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9230') {
  console.error('Recusado: rode por functions/test/harness-financeiro/iniciar.sh (emuladores 8230/9230).'); process.exit(1);
}
const admin = req('firebase-admin');
const A = require(path.join(RAIZ, 'functions/lib/financeiro/agregados'));
const C = require(path.join(RAIZ, 'functions/lib/financeiro/canonico'));
const P = require(path.join(RAIZ, 'functions/lib/financeiro/publicacao'));
const { FORMAS, titulo, receber } = require(path.join(RAIZ, 'functions/test/fixtures/financeiro-f1'));

// Usuários do EMULADOR (não existem fora dele).
const SENHA_TESTE = 'senha-so-do-emulador';
const USUARIOS = [
  { uid: 'fin-teste', email: 'financeiro@exemplo.test', rotulo: 'Entrar como usuário COM Financeiro', modulos: ['financeiro'] },
  { uid: 'sem-fin', email: 'sem-financeiro@exemplo.test', rotulo: 'Entrar como usuário SEM Financeiro (deve ser negado)', modulos: ['vendas'] },
];

/** Massa de conta feita à mão: os resultados esperados saem de cabeça (ver ESPERADO). Datas relativas a hoje. */
function massaFicticia(hoje) {
  let n = 0; const d = x => C.somarDias(hoje, x);
  const base = (venc, valor, pagoEm) => ({ id: 'T' + (++n), codigo: String(n), valor: valor.toFixed(2), valor_total: valor.toFixed(2), data_vencimento: venc, data_competencia: venc, liquidado: pagoEm ? '1' : '0', data_liquidacao: pagoEm || '' });
  const rec = (venc, valor, pagoEm) => receber({ ...base(venc, valor, pagoEm), cliente_id: 'C' + n, nome_cliente: 'Cliente Fictício ' + n, descricao: 'Título fictício ' + n });
  const receberLista = [
    rec(d(-1), 100), rec(d(-31), 200), rec(d(-400), 300), rec(d(0), 150), rec(d(10), 250),
    rec(d(-5), 400, d(-5)), rec(d(-10), 500, d(-9)), rec(d(-100), 600, d(-50)), rec(d(-40), 700, d(-45)), rec(d(-500), 800, d(-20)), rec(d(-900), 900, d(-600)),
    receber({ ...base(d(-3), 999, d(-1)), liquidado: '0', cliente_id: 'CX', nome_cliente: 'Cliente Fictício Conferência' }),
  ];
  const pagarLista = [titulo({ ...base(d(-2), 120), fornecedor_id: 'F1', nome_fornecedor: 'Fornecedor Fictício 1', descricao: 'Despesa fictícia' }), titulo({ ...base(d(3), 80), fornecedor_id: 'F2', nome_fornecedor: 'Fornecedor Fictício 2', descricao: 'Despesa fictícia' })];
  const refs = { formasPorId: FORMAS };
  return [...pagarLista.map(b => C.mapearTitulo(b, 'PAGAR', refs)), ...receberLista.map(b => C.mapearTitulo(b, 'RECEBER', refs))];
}
const ESPERADO = [
  '1 vencido na carteira ......... 60,0% (R$ 600,00 ÷ R$ 1.000,00; 3 ÷ 5 títulos)',
  '2 safra 365 dias .............. 12,0% (R$ 300,00 ÷ R$ 2.500,00; 2 ÷ 6 títulos; 8,0% há mais de 30 dias)  [após o botão]',
  '3 faixas sobre a carteira ..... 1–7: 10,0% · 31–90: 20,0% · >365: 30,0%',
  '4 recebido após o vencimento .. 63,3% (R$ 1.900,00 ÷ R$ 3.000,00; 3 ÷ 5 títulos)  [após o botão]',
  '5 e 7 ......................... Não disponível',
  '6 antigos ..................... 50,0% do vencido (R$ 300,00 ÷ R$ 600,00); 30,0% da carteira',
];

async function semear() {
  admin.initializeApp({ projectId: PROJETO });
  const db = admin.firestore(), auth = admin.auth();
  await fetch(`http://127.0.0.1:8230/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of USUARIOS) {
    await auth.createUser({ uid: u.uid, email: u.email, password: SENHA_TESTE }).catch(e => { if (e.code !== 'auth/uid-already-exists') throw e; });
    await db.doc('users/' + u.uid).set({ role: 'gestor', ativo: true, nome: 'Usuário Fictício' });
    await db.doc('sistema_usuarios/' + u.uid).set({ modulos: u.modulos, admin: false, bloqueado: false });
  }
  const agora = new Date(), hoje = C.dataComercial(agora), geracao = A.novaGeracao(agora), runId = 'harness';
  const g = A.construirGeracao({ canon: massaFicticia(hoje), agora, geracao, hoje });
  const l = await P.adquirirLock(db, { runId, agora }); if (!l.ok) throw new Error(l.motivo);
  await P.publicarGeracao(db, { geracao, resumo: g.resumo, entidades: g.entidades, fatias: g.fatias, runId, agora });
  await P.liberarLock(db, runId);
}

// ── servidor estático com lista permitida ──
const ARQUIVOS = { '/modulos/financeiro-v2.html': 'text/html', '/modulos/financeiro-view.js': 'text/javascript', '/modulos/agente-ia-widget.js': 'text/javascript', '/js/vivo.js': 'text/javascript', '/assets/logo.png': 'image/png' };
const TROCAS = [
  ["connectFirestoreEmulator(db, 'localhost', 8080)", "connectFirestoreEmulator(db, 'localhost', 8230)"],
  ["'http://localhost:9099'", "'http://localhost:9230'"],
  ["connectFunctionsEmulator(funcs, 'localhost', 5001)", "connectFunctionsEmulator(funcs, 'localhost', 5239)"],   // sem emulador de Functions: a aba Agente fica oculta
  [/apiKey:"[^"]+"/, 'apiKey:"chave-ficticia"'],
  [/projectId:"[^"]+"/, `projectId:"${PROJETO}"`],
  [/authDomain:"[^"]+"/, `authDomain:"${PROJETO}.firebaseapp.com"`],
  [/storageBucket:"[^"]+"/, `storageBucket:"${PROJETO}.appspot.com"`],
];
function paginaFinanceiro() {
  let h = fs.readFileSync(path.join(RAIZ, 'modulos/financeiro-v2.html'), 'utf8');
  for (const [de, para] of TROCAS) { const antes = h; h = h.replace(de, para); if (h === antes) throw new Error('Troca não aplicada (página mudou): ' + de); }
  return h;
}
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; "
  + "connect-src 'self' http://localhost:8230 ws://localhost:8230 http://localhost:9230 http://localhost:5239 https://www.gstatic.com";
const LOGIN = () => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness Financeiro</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem}button{display:block;width:100%;margin:.5rem 0;padding:.7rem;font:inherit;cursor:pointer}pre{background:#f3f4f6;padding:.8rem;white-space:pre-wrap;font-size:.8rem}</style></head><body>
<h1>Harness local do Financeiro</h1><p>Dados fictícios, só nos emuladores desta máquina.</p>
${USUARIOS.map((u, i) => `<button data-i="${i}">${u.rotulo}</button>`).join('')}<p id="msg"></p><h2>Esperado</h2><pre>${ESPERADO.join('\n')}</pre>
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
const auth = getAuth(initializeApp({ apiKey: 'chave-ficticia', projectId: '${PROJETO}', authDomain: '${PROJETO}.firebaseapp.com' }));
connectAuthEmulator(auth, 'http://localhost:9230', { disableWarnings: true });
const emails = ${JSON.stringify(USUARIOS.map(u => u.email))};
document.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
  try { await signInWithEmailAndPassword(auth, emails[b.dataset.i], ${JSON.stringify(SENHA_TESTE)}); location.href = '/modulos/financeiro-v2.html'; }
  catch (e) { document.getElementById('msg').textContent = 'Falha no login do emulador: ' + e.code; }
}));
</script></body></html>`;

function responder(res, status, tipo, corpo, extra = {}) { res.writeHead(status, { 'Content-Type': tipo + (/^text/.test(tipo) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, ...extra }); res.end(corpo); }
const servidor = http.createServer((q, res) => {
  const p = new URL(q.url, 'http://localhost').pathname;
  if (q.method !== 'GET') return responder(res, 405, 'text/plain', 'somente GET');
  if (p === '/__login') return responder(res, 200, 'text/html', LOGIN());
  if (p === '/' || p === '/login.html' || p === '/index.html') return responder(res, 302, 'text/plain', '', { Location: '/__login' });   // login/menu reais não são servidos
  if (!Object.prototype.hasOwnProperty.call(ARQUIVOS, p)) return responder(res, 404, 'text/plain', 'fora do harness');
  try { return responder(res, 200, ARQUIVOS[p], p === '/modulos/financeiro-v2.html' ? paginaFinanceiro() : fs.readFileSync(path.join(RAIZ, p.slice(1)))); }
  catch (e) { return responder(res, 500, 'text/plain', e.message); }
});

semear().then(() => { paginaFinanceiro(); servidor.listen(PORTA, 'localhost', () => console.log(`\nHarness pronto: http://localhost:${PORTA}/\n${ESPERADO.join('\n')}\n(Ctrl+C encerra)\n`)); })
  .catch(e => { console.error('Falha no harness:', e.message); process.exit(1); });
