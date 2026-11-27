#!/usr/bin/env node
'use strict';
// EXECUTOR ISOLADO DOS TESTES.
//   node scripts/testes/rodar.js [--puro] [-- <argumentos do jest>]
// Confere que as portas exclusivas estão livres (senão ABORTA, sem encerrar processo de ninguém), sobe Firestore e Auth emulados
// com projeto "demo-", e roda o Jest com a trava de rede ativa em todos os processos. --puro: sem emulador (só testes que não usam banco).
// Duas execuções ao mesmo tempo: MR4_TEST_BLOCO=2 (até 9). Java: JAVA_HOME ou MR4_JAVA_HOME.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn, spawnSync } = require('child_process');
const RAIZ = path.resolve(__dirname, '../..'), FN = path.join(RAIZ, 'functions'), PROJETO = 'demo-mr4';
const { doBloco, PROIBIDAS } = require(path.join(FN, 'test/_ambiente/portas'));
const GUARDA = path.join(FN, 'test/_ambiente/guarda.js');

const argv = process.argv.slice(2);
const corte = argv.indexOf('--');
const proprias = corte < 0 ? argv.filter(a => a === '--puro' || a === '--dentro') : argv.slice(0, corte);
const doJest = corte < 0 ? argv.filter(a => !proprias.includes(a)) : argv.slice(corte + 1);
const sair = (m, c = 1) => { console.error(`[ambiente-de-teste] ${m}`); process.exit(c); };

const bloco = Number(process.env.MR4_TEST_BLOCO || 1);
if (bloco === 0) sair('o bloco 0 é do emulador de desenvolvimento; use de 1 a 9.');
const portas = doBloco(bloco);
if (Object.values(portas).some(p => PROIBIDAS.includes(p))) sair('configuração de portas inclui uma porta proibida.');

function ambienteLimpo(extra) {
  const e = { ...process.env, ...extra };
  for (const k of Object.keys(e)) if (/^(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN|GITHUB_TOKEN|GH_TOKEN|GC_.*|GESTAOCLICK.*)$/.test(k)) delete e[k];
  return e;
}

function rodarJest(modo, argumentos) {
  const base = argumentos.length ? argumentos : ['--testPathPattern=test/', '--forceExit'];
  const args = base.includes('--runInBand') ? base : ['--runInBand', ...base];
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'mr4-sem-credencial-'));
  const env = ambienteLimpo({ MR4_TEST_MODO: modo, MR4_TEST_PORTAS: JSON.stringify(modo === 'emulador' ? portas : {}), MR4_TEST_PROJETO: PROJETO, CLOUDSDK_CONFIG: vazio,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${GUARDA}"`.trim() });
  if (modo === 'puro') { delete env.FIRESTORE_EMULATOR_HOST; delete env.FIREBASE_AUTH_EMULATOR_HOST; }
  else { env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${portas.firestore}`; env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${portas.auth}`; }
  const r = spawnSync(process.execPath, [require.resolve('jest/bin/jest', { paths: [FN] }), ...args], { cwd: FN, env, stdio: 'inherit' });
  fs.rmSync(vazio, { recursive: true, force: true });
  process.exit(r.status === null ? 1 : r.status);
}

const ocupada = (porta, host) => new Promise(ok => {
  const s = net.connect({ port: porta, host });
  const fim = v => { s.destroy(); ok(v); };
  s.once('connect', () => fim(true)); s.once('error', () => fim(false)); s.setTimeout(700, () => fim(true));
});

async function principal() {
  if (proprias.includes('--dentro')) {
    if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${portas.firestore}`) sair(`o emulador anunciado (${process.env.FIRESTORE_EMULATOR_HOST}) não é o desta execução.`);
    return rodarJest('emulador', JSON.parse(process.env.MR4_TEST_ARGS || '[]'));
  }
  if (proprias.includes('--puro')) return rodarJest('puro', doJest);

  const conflitos = [];
  for (const [nome, porta] of Object.entries(portas)) if (await ocupada(porta, '127.0.0.1') || await ocupada(porta, '::1')) conflitos.push(`${nome}:${porta}`);
  if (conflitos.length) sair(`ABORTADO — porta(s) do bloco ${bloco} já em uso: ${conflitos.join(', ')}. Nenhum processo foi encerrado. Use outro bloco (MR4_TEST_BLOCO=${bloco % 9 + 1}).`, 3);

  const arquivo = path.join(RAIZ, `firebase.testes-${bloco}.json`);
  const emu = porta => ({ host: '127.0.0.1', port: porta });
  fs.writeFileSync(arquivo, JSON.stringify({ firestore: { rules: 'modulos/firestore.rules', indexes: 'firestore.indexes.json' },
    emulators: { firestore: { ...emu(portas.firestore), websocketPort: portas.websocket }, auth: emu(portas.auth), hub: emu(portas.hub), logging: emu(portas.logging), eventarc: emu(portas.eventarc), ui: { enabled: false }, singleProjectMode: true } }, null, 2));
  const env = ambienteLimpo({ MR4_TEST_BLOCO: String(bloco), MR4_TEST_ARGS: JSON.stringify(doJest) });
  const java = process.env.MR4_JAVA_HOME || process.env.JAVA_HOME;
  if (java) { env.JAVA_HOME = java; env.PATH = `${path.join(java, 'bin')}${path.delimiter}${env.PATH}`; }
  const firebase = path.join(FN, 'node_modules/.bin/firebase');
  const filho = spawn(firebase, ['emulators:exec', '--config', arquivo, '--only', 'firestore,auth', '--project', PROJETO, `"${process.execPath}" "${__filename}" --dentro`], { cwd: RAIZ, env, stdio: 'inherit' });
  const limpar = () => { try { fs.unlinkSync(arquivo); } catch { /* já removido */ } };
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { filho.kill(s); });
  filho.on('exit', c => { limpar(); process.exit(c === null ? 1 : c); });
  filho.on('error', e => { limpar(); sair(`não foi possível iniciar o emulador: ${e.message}`); });
}
principal();
