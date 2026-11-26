#!/usr/bin/env node
'use strict';
// Monta na pasta de trabalho: site/ (cópia das telas apontando para os emuladores do harness) e emu/ (firebase.json,
// regras do repositório e um index.js de Functions só com os callables da fila e os gatilhos do sinalizador, sem segredos).
// Uso: node scripts/dev/com-funil/preparar.js /caminho/pasta
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');

const dir = pastaDeTrabalho(process.argv[2]);
const site = path.join(dir, 'site'), emu = path.join(dir, 'emu'), fns = path.join(emu, 'functions');
for (const d of [site, emu]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(site, 'modulos'), { recursive: true }); fs.mkdirSync(path.join(site, 'js'), { recursive: true }); fs.mkdirSync(fns, { recursive: true });

const trocar = t => t
  .replace(/'localhost', 8080\)/g, `'localhost', ${PORTAS.firestore})`)
  .replace(/localhost:9099/g, `localhost:${PORTAS.auth}`)
  .replace(/'localhost', 5001\)/g, `'localhost', ${PORTAS.functions})`)
  .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'chave-ficticia-do-emulador')
  .replace(/mr4-ponto/g, PROJETO);
const copiar = (rel, conteudo) => {
  const t = trocar(conteudo === undefined ? fs.readFileSync(path.join(RAIZ, rel), 'utf8') : conteudo);
  if (/mr4-ponto|AIza|'localhost', (8080|5001)\)|localhost:9099/.test(t)) throw new Error('referência de produção/porta padrão em ' + rel);
  fs.writeFileSync(path.join(site, rel), t);
};
copiar('login.html');
for (const d of ['js', 'modulos']) for (const f of fs.readdirSync(path.join(RAIZ, d))) if (/\.(html|js)$/.test(f)) copiar(path.join(d, f));
fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
if (fs.existsSync(path.join(RAIZ, 'assets/logo.png'))) fs.copyFileSync(path.join(RAIZ, 'assets/logo.png'), path.join(site, 'assets/logo.png'));
fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><meta charset="utf-8"><title>harness</title><p id="logado">Autenticado no emulador.</p>');
// auxiliar de tela ANTERIOR à captura, para testar JavaScript antigo em cache
fs.writeFileSync(path.join(dir, 'fila-worklist-view.antigo.js'), execFileSync('git', ['-C', RAIZ, 'show', '60ffb69:modulos/fila-worklist-view.js']));

fs.copyFileSync(path.join(RAIZ, 'modulos/firestore.rules'), path.join(emu, 'firestore.rules'));
fs.copyFileSync(path.join(RAIZ, 'firestore.indexes.json'), path.join(emu, 'firestore.indexes.json'));
fs.writeFileSync(path.join(emu, 'firebase.json'), JSON.stringify({
  firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
  functions: [{ source: 'functions', codebase: 'default' }],
  emulators: {
    firestore: { port: PORTAS.firestore, websocketPort: PORTAS.websocket }, auth: { port: PORTAS.auth }, functions: { port: PORTAS.functions },
    hub: { port: PORTAS.hub }, logging: { port: PORTAS.logging }, eventarc: { port: PORTAS.eventarc }, tasks: { port: PORTAS.tasks }, ui: { enabled: false }, singleProjectMode: true,
  },
}, null, 2));
const lib = n => JSON.stringify(path.join(RAIZ, 'functions/lib', n));
fs.writeFileSync(path.join(fns, 'index.js'), `'use strict';
// GERADO por scripts/dev/com-funil/preparar.js — espelha functions/index.js só no que o CRM/Fila usa.
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const { onCall } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const C = require(${lib('canaryCallable')});
const { crmConsultaHandler } = require(${lib('crmConsulta')});
const S = require(${lib('filaSinal')});
const REGION = 'southamerica-east1';
exports.claimOpportunity = onCall({ region: REGION }, req => C.claimOpportunityHandler(req));
exports.registerOutcome = onCall({ region: REGION }, req => C.registerOutcomeHandler(req));
exports.releaseOpportunity = onCall({ region: REGION }, req => C.releaseOpportunityHandler(req));
exports.crmConsulta = onCall({ region: REGION }, req => crmConsultaHandler(req));
for (const [nome, document] of Object.entries(S.FONTES)) exports[nome] = onDocumentWritten({ document, region: REGION },
  ev => S.sinalizarFila({ db, FieldValue: require('firebase-admin/firestore').FieldValue, eventId: ev.id, eventTime: ev.time }));
`);
fs.writeFileSync(path.join(fns, 'package.json'), JSON.stringify({ name: 'harness-com-funil', main: 'index.js', engines: { node: '22' },
  dependencies: JSON.parse(fs.readFileSync(path.join(RAIZ, 'functions/package.json'), 'utf8')).dependencies }, null, 2));
fs.symlinkSync(fs.realpathSync(path.join(RAIZ, 'functions/node_modules')), path.join(fns, 'node_modules'));
console.log('preparado em ' + dir);
