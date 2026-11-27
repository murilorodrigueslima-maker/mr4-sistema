'use strict';
// Chamado por iniciar.sh: semeia dados FICTÍCIOS nos emuladores e serve as telas do ponto em http://127.0.0.1:5310.
// Recusa rodar fora dos emuladores. O SDK é redirecionado para os emuladores por módulos-ponte (/__emu/*.js).
const fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process'), vm = require('vm'), crypto = require('crypto');
const { createRequire } = require('module');
const RAIZ = process.env.RAIZ_REPO || path.resolve(__dirname, '../../..');
const req = createRequire(path.join(RAIZ, 'functions', 'package.json'));
const PORTA = 5310, PROJETO = 'demo-ponto-manual', REF = process.env.TELAS_REF || '';
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8310' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9310') {
  console.error('Recusado: rode por functions/test/harness-ponto/iniciar.sh (emuladores 8310/9310).'); process.exit(1);
}
const admin = req('firebase-admin');
const SENHA = 'senha-so-do-emulador';
const USUARIOS = [
  { uid: 'm-gestora', email: 'gestora@exemplo.test', rotulo: 'Gestora fictícia (painel)', perfil: { role: 'gestor' }, sistema: { modulos: ['ponto'], admin: false }, destino: '/modulos/ponto.html' },
  { uid: 'm-admin', email: 'admin@exemplo.test', rotulo: 'Administrador fictício (painel)', perfil: { role: 'gestor' }, sistema: { modulos: [], admin: true }, destino: '/modulos/ponto.html' },
  { uid: 'm-elisa', email: 'elisa@exemplo.test', rotulo: 'Funcionária fictícia Elisa (meu ponto)', perfil: { role: 'funcionario', funcionarioId: 'mf-elisa' }, destino: '/modulos/ponto-func.html' },
  { uid: 'm-enzo', email: 'enzo@exemplo.test', rotulo: 'Funcionário fictício Enzo (meu ponto)', perfil: { role: 'funcionario', funcionarioId: 'mf-enzo' }, destino: '/modulos/ponto-func.html' },
];

async function semear() {
  admin.initializeApp({ projectId: PROJETO });
  const db = admin.firestore(), auth = admin.auth();
  await fetch(`http://127.0.0.1:8310/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of USUARIOS) {
    await auth.createUser({ uid: u.uid, email: u.email, password: SENHA }).catch(e => { if (e.code !== 'auth/uid-already-exists') throw e; });
    await db.doc('users/' + u.uid).set({ ativo: true, nome: u.rotulo, email: u.email, ...u.perfil });
    if (u.sistema) await db.doc('sistema_usuarios/' + u.uid).set({ bloqueado: false, email: u.email, ...u.sistema });
  }
  const M = {}; vm.createContext(M); vm.runInContext(fs.readFileSync(path.join(RAIZ, 'modulos/ponto-regras.js'), 'utf8'), M);
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
  const dia = n => { const [a, m, d] = hoje.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n, 12)).toISOString().slice(0, 10); };
  const mesAnterior = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 2, 1, 12)).toISOString().slice(0, 7);
  const pessoas = [['mf-elisa', 'Elisa Fictícia', mesAnterior + '-01'], ['mf-enzo', 'Enzo Fictício', hoje.slice(0, 7) + '-01']];
  for (const [id, nome, inicio] of pessoas) {
    const func = { nome, cargo: 'Cargo fictício', jornada: '8', modalidade: 'HOME_OFFICE', inicioBancoHoras: inicio };
    await db.doc('funcionarios/' + id).set(func);
    const regs = [];
    const dias = []; for (let n = -45; n < 0; n++) { const d = dia(n); const w = new Date(d + 'T12:00:00').getDay(); if (d >= inicio && w >= 1 && w <= 5) dias.push(d); }
    for (const d of dias) for (const [tipo, hora] of [['entrada', '08:00'], ['saida_almoco', '12:00'], ['retorno_almoco', '13:00'], ['saida', '17:00']]) {
      if (id === 'mf-enzo' && d === dias[dias.length - 1] && tipo === 'saida') continue;     // um dia incompleto para regularizar
      const r = { id: `${id}_${d}_${tipo}`, funcId: id, funcNome: nome, data: d, tipo, tipoLabel: tipo, hora: hora + ':00', criadoEm: new Date(d + 'T' + hora + ':00-03:00') };
      regs.push(r); await db.doc('registros/' + r.id).set(r);
    }
    if (id === 'mf-elisa') {   // espelho do mês anterior aguardando assinatura
      const snap = M.buildEspelhoSnapshot({ id, ...func }, regs, [], [], mesAnterior, hoje); snap.geradoEm = new Date().toISOString(); snap.funcId = id;
      const limpo = JSON.parse(JSON.stringify(snap));
      await db.doc('espelhos/m-esp-elisa').set({ id: 'm-esp-elisa', funcId: id, mes: mesAnterior, mesLabel: mesAnterior.split('-').reverse().join('/'), versao: 1, versaoAnteriorId: null, versaoSucessoraId: null, invalidado: false,
        assinado: false, assinadoEm: null, assinadoPor: null, assinaturaImg: null, snapshot: limpo, hashSnapshot: crypto.createHash('sha256').update(M.canonicalizarSnapshot(limpo)).digest('hex'), geradoPor: 'Gestor', criadoEm: new Date().toISOString() });
    } else {
      await db.doc('justificativas/m-just-enzo').set({ id: 'm-just-enzo', funcId: id, funcNome: nome, data: dias[dias.length - 1], motivo: 'Ponto não batido — Saída às 17:00', descricao: 'Esqueci de registrar a saída (fictício)', tipoPonto: 'saida', horarioPonto: '17:00', status: 'pendente', lancadoPorGestor: false, criadoEm: new Date().toISOString() });
    }
  }
}

const CDN = 'https://www.gstatic.com/firebasejs/10.12.0';
const PONTES = {
  'firebase-firestore.js': `export * from '${CDN}/firebase-firestore.js';
import { getFirestore as g, connectFirestoreEmulator as c } from '${CDN}/firebase-firestore.js';
export function getFirestore(app){const d=g(app);if(!d.__emu){c(d,'127.0.0.1',8310);d.__emu=true;}return d;}`,
  'firebase-auth.js': `export * from '${CDN}/firebase-auth.js';
import { getAuth as g, connectAuthEmulator as c } from '${CDN}/firebase-auth.js';
export function getAuth(app){const a=g(app);if(!a.__emu){c(a,'http://127.0.0.1:9310',{disableWarnings:true});a.__emu=true;}return a;}`,
  'firebase-functions.js': `export * from '${CDN}/firebase-functions.js';
import { getFunctions as g, connectFunctionsEmulator as c } from '${CDN}/firebase-functions.js';
export function getFunctions(app,r){const f=g(app,r);if(!f.__emu){c(f,'127.0.0.1',5311);f.__emu=true;}return f;}`,
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:8310 http://127.0.0.1:9310 http://127.0.0.1:5311 ws://127.0.0.1:9311; frame-src 'self' http://127.0.0.1:9310";

const entrada = () => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Ponto local</title><body style="font-family:sans-serif;padding:24px">
<h2>Ponto — emuladores locais (dados fictícios)${REF ? ' · telas ' + REF : ''}</h2>${USUARIOS.map(u => `<p><button data-e="${u.email}" data-d="${u.destino}">${u.rotulo}</button></p>`).join('')}<pre id="m"></pre>
<script type="module">
import { initializeApp } from '/__emu/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut } from '/__emu/firebase-auth.js';
const auth = getAuth(initializeApp({ apiKey: 'demo', authDomain: '${PROJETO}.firebaseapp.com', projectId: '${PROJETO}' }));
document.querySelectorAll('button').forEach(b => b.onclick = async () => { try { await signOut(auth); await signInWithEmailAndPassword(auth, b.dataset.e, '${SENHA}'); location.href = b.dataset.d; } catch (e) { document.getElementById('m').textContent = e.message; } });
</script></body></html>`;

const REF_PUBLICADAS = '890594c';   // telas publicadas em 26/11/2026: abertas em /antigas/modulos/… (aparelho com cache)
function arquivoDoRepo(rel, ref) {
  if (ref) return cp.execFileSync('git', ['-C', RAIZ, 'show', `${ref}:${rel}`], { maxBuffer: 1e8 }).toString('utf8');
  return fs.readFileSync(path.join(RAIZ, rel), 'utf8');
}
function reescrever(html) {
  return html.replace(new RegExp(CDN.replace(/[.]/g, '\\.') + '/(firebase-[a-z]+\\.js)', 'g'), '/__emu/$1')
    .replace(/apiKey:\s*"[^"]+"/g, 'apiKey:"demo"').replace(/mr4-ponto\.(firebaseapp\.com|firebasestorage\.app)/g, PROJETO + '.$1').replace(/projectId:\s*"mr4-ponto"/g, `projectId:"${PROJETO}"`);
}

http.createServer((q, r) => {
  let url = new URL(q.url, 'http://x').pathname, ref = REF;
  if (url.startsWith('/antigas/')) { url = url.slice('/antigas'.length); ref = REF_PUBLICADAS; }
  const enviar = (tipo, corpo, cod = 200) => { r.writeHead(cod, { 'Content-Type': tipo + '; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }); r.end(corpo); };
  try {
    if (url === '/' || url === '/entrar' || url === '/login.html' || url === '/modulos/ponto-login-func.html') return enviar('text/html', entrada());
    if (url.startsWith('/__emu/')) { const n = url.slice(7); return enviar('text/javascript', PONTES[n] || (n === 'firebase-app.js' ? `export * from '${CDN}/firebase-app.js';` : '')); }
    if (/^\/modulos\/(ponto\.html|ponto-func\.html|ponto-regras\.js)$/.test(url)) {
      const corpo = arquivoDoRepo(url.slice(1), ref);
      return url.endsWith('.js') ? enviar('text/javascript', corpo) : enviar('text/html', reescrever(corpo));
    }
    return enviar('text/plain', 'não encontrado', 404);
  } catch (e) { return enviar('text/plain', 'erro: ' + e.message, 500); }
}).listen(PORTA, '127.0.0.1', () => semear().then(() => console.log(`PRONTO: http://127.0.0.1:${PORTA}/  (Ctrl+C encerra)`)).catch(e => { console.error(e); process.exit(1); }));
