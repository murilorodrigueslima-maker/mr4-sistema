#!/usr/bin/env node
'use strict';
// Pré-visualização local da Expedição (medição de 7 dias) — SOMENTE emuladores, projeto "demo-", dados fictícios.
// Monta na pasta de trabalho: site/ (cópia das telas apontada para os emuladores) e emu/ (firebase.json + regras do repositório).
// Uso: node scripts/dev/expedicao-medicao/preparar.js /caminho/pasta
const fs = require('fs'), path = require('path');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');

const dir = pastaDeTrabalho(process.argv[2]);
const site = path.join(dir, 'site'), emu = path.join(dir, 'emu');
for (const d of [site, emu]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [path.join(site, 'modulos'), path.join(site, 'js'), path.join(site, 'assets'), emu]) fs.mkdirSync(d, { recursive: true });

const neutro = t => t.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'chave-ficticia-do-emulador').replace(/mr4-ponto/g, PROJETO);
const gravar = (rel, t) => {
  if (/mr4-ponto|AIza/.test(t)) throw new Error('referência de produção em ' + rel);
  fs.writeFileSync(path.join(site, rel), t);
};
for (const f of ['guard.js', 'expedicao-core.js', 'expedicao-medicao-core.js', 'expedicao-medicao-tela.js']) gravar('js/' + f, neutro(fs.readFileSync(path.join(RAIZ, 'js', f), 'utf8')));
if (fs.existsSync(path.join(RAIZ, 'assets/logo.png'))) fs.copyFileSync(path.join(RAIZ, 'assets/logo.png'), path.join(site, 'assets/logo.png'));

// a tela real não conhece emuladores: a CÓPIA recebe a conexão local e a entrada automática (?como=gestor|equipe)
const trocarUm = (t, de, para) => { if (t.split(de).length !== 2) throw new Error('trecho não encontrado em expedicao.html: ' + de.slice(0, 50)); return t.replace(de, () => para); };
let tela = neutro(fs.readFileSync(path.join(RAIZ, 'modulos/expedicao.html'), 'utf8'));
tela = trocarUm(tela, "const auth=getAuth(app), db=getFirestore(app);", `const auth=getAuth(app), db=getFirestore(app);
connectAuthEmulator(auth,'http://127.0.0.1:${PORTAS.auth}',{disableWarnings:true}); connectFirestoreEmulator(db,'127.0.0.1',${PORTAS.firestore});
const como=new URLSearchParams(location.search).get('como');
if(como){ const c=await (await fetch('../credencial-teste.json')).json(); await signInWithEmailAndPassword(auth,c[como].email,c[como].password); }`);
tela = trocarUm(tela, "import { getAuth, onAuthStateChanged } from", "import { getAuth, onAuthStateChanged, connectAuthEmulator, signInWithEmailAndPassword } from");
tela = trocarUm(tela, "import { getFirestore, collection,", "import { getFirestore, connectFirestoreEmulator, collection,");
gravar('modulos/expedicao.html', tela);
gravar('index.html', '<!doctype html><meta charset="utf-8"><title>harness</title><p><a href="modulos/expedicao.html?como=gestor">Entrar como gestor (fictício)</a> · <a href="modulos/expedicao.html?como=equipe">Entrar como equipe (fictícia)</a></p>');
gravar('login.html', '<!doctype html><meta charset="utf-8"><title>harness</title><p>Sem sessão. <a href="index.html">Voltar</a></p>');

fs.copyFileSync(path.join(RAIZ, 'modulos/firestore.rules'), path.join(emu, 'firestore.rules'));
fs.writeFileSync(path.join(emu, 'firebase.json'), JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  emulators: { firestore: { port: PORTAS.firestore, websocketPort: PORTAS.websocket }, auth: { port: PORTAS.auth }, hub: { port: PORTAS.hub }, logging: { port: PORTAS.logging }, ui: { enabled: false }, singleProjectMode: true },
}, null, 2));
console.log('preparado em ' + dir);
