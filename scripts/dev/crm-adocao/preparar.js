#!/usr/bin/env node
'use strict';
// Monta na pasta de trabalho: site-antes/ e site-depois/ (cópias das telas apontando para os emuladores) e emu/ (firebase.json,
// regras do repositório e um index.js de Functions só com os callables do CRM/Fila e os gatilhos do sinalizador, sem segredos;
// o telefone do cliente é FICTÍCIO). "antes" = telas do commit base; "depois" = telas da árvore de trabalho.
// Uso: node scripts/dev/crm-adocao/preparar.js /caminho/pasta [commit-base]
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');

const dir = pastaDeTrabalho(process.argv[2]);
const base = process.argv[3] || 'ee9a62d';
const emu = path.join(dir, 'emu'), fns = path.join(emu, 'functions');
const git = (...a) => execFileSync('git', ['-C', RAIZ, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const trocar = t => t
  .replace(/'localhost', 8710\)/g, `'localhost', ${PORTAS.firestore})`)
  .replace(/localhost:9710/g, `localhost:${PORTAS.auth}`)
  .replace(/'localhost', 5710\)/g, `'localhost', ${PORTAS.functions})`)
  .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'chave-ficticia-do-emulador')
  .replace(/mr4-ponto/g, PROJETO);

function montarSite(nome, listar, ler) {
  const site = path.join(dir, nome);
  fs.rmSync(site, { recursive: true, force: true });
  for (const d of ['modulos', 'js', 'assets']) fs.mkdirSync(path.join(site, d), { recursive: true });
  const copiar = rel => {
    const t = trocar(ler(rel));
    if (/mr4-ponto|AIza|'localhost', (8080|5001|8710|5710)\)|localhost:(9099|9710)/.test(t)) throw new Error('referência de produção/porta padrão em ' + rel);
    // tela do roteiro sem ligação com o emulador falaria com serviço real: interrompe antes de abrir o navegador
    if (/crm[^/]*\.html$|fila-comercial\.html$|login\.html$/.test(rel) && /getAuth\(/.test(t) && !/connectAuthEmulator\(auth/.test(t)) throw new Error('tela sem emulador: ' + rel);
    fs.writeFileSync(path.join(site, rel), t);
  };
  copiar('login.html');
  for (const d of ['js', 'modulos']) for (const f of listar(d)) if (/\.(html|js)$/.test(f)) copiar(d + '/' + f);
  if (fs.existsSync(path.join(RAIZ, 'assets/logo.png'))) fs.copyFileSync(path.join(RAIZ, 'assets/logo.png'), path.join(site, 'assets/logo.png'));
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><meta charset="utf-8"><title>harness</title><p id="logado">Autenticado no emulador.</p>');
}
montarSite('site-depois', d => fs.readdirSync(path.join(RAIZ, d)), rel => fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
montarSite('site-antes', d => git('ls-tree', '--name-only', base, d + '/').split('\n').filter(Boolean).map(f => path.basename(f)), rel => git('show', `${base}:${rel}`));

fs.rmSync(emu, { recursive: true, force: true }); fs.mkdirSync(fns, { recursive: true });
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
// GERADO por scripts/dev/crm-adocao/preparar.js — espelha functions/index.js só no que o CRM/Fila usam.
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
// telefone FICTÍCIO (faixa não atribuída): o harness nunca fala com o GestãoClick
exports.crmContatoReativacao = onCall({ region: REGION }, req => require(${lib('contatoReativacao')}).contatoReativacaoHandler(req, { lookup: async () => ({ celular: '85900000001' }) }));
for (const [nome, document] of Object.entries(S.FONTES)) exports[nome] = onDocumentWritten({ document, region: REGION },
  ev => S.sinalizarFila({ db, FieldValue: require('firebase-admin/firestore').FieldValue, eventId: ev.id, eventTime: ev.time }));
`);
fs.writeFileSync(path.join(fns, 'package.json'), JSON.stringify({ name: 'harness-crm-adocao', main: 'index.js', engines: { node: '22' },
  dependencies: JSON.parse(fs.readFileSync(path.join(RAIZ, 'functions/package.json'), 'utf8')).dependencies }, null, 2));
fs.symlinkSync(fs.realpathSync(path.join(RAIZ, 'functions/node_modules')), path.join(fns, 'node_modules'));
console.log('preparado em ' + dir + ' (antes = ' + base + ')');
