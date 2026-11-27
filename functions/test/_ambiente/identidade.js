'use strict';
// globalSetup do Jest: antes de QUALQUER teste, confirma que o ambiente é o isolado desta execução; senão aborta.
module.exports = async () => {
  const abortar = m => { throw new Error(`[ambiente-de-teste] ${m}\nRode pela raiz do repositório: node scripts/testes/rodar.js -- <arquivos>   (ou, em functions/, npm test)`); };
  const modo = process.env.MR4_TEST_MODO;
  if (modo !== 'emulador' && modo !== 'puro') abortar('testes chamados fora do executor isolado.');
  if (!require('net').Socket.prototype[Symbol.for('mr4.guardaDeRede')]) abortar('a trava de rede não está ativa.');
  if (modo === 'puro') return;
  const p = JSON.parse(process.env.MR4_TEST_PORTAS || '{}');
  if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${p.firestore}`) abortar('FIRESTORE_EMULATOR_HOST não aponta para o emulador desta execução.');
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== `127.0.0.1:${p.auth}`) abortar('FIREBASE_AUTH_EMULATOR_HOST não aponta para o emulador desta execução.');
  if (!/^demo-/.test(process.env.MR4_TEST_PROJETO || '')) abortar('o emulador não foi iniciado com um projeto "demo-".');
  let hub;
  try { hub = await (await fetch(`http://127.0.0.1:${p.hub}/emulators`)).json(); } catch (e) { abortar(`a central do emulador (porta ${p.hub}) não respondeu: ${e.message}`); }
  for (const s of ['firestore', 'auth']) if (!hub[s] || hub[s].port !== p[s]) abortar(`o emulador ${s} ativo não é o desta execução (esperado na porta ${p[s]}).`);
};
