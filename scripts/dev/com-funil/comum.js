'use strict';
// Harness local do funil comercial (COM-02) — SOMENTE emuladores, projeto "demo-" (sem acesso a produção) e dados fictícios.
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const PROJETO = 'demo-mr4-com';
const PORTAS = Object.freeze({ site: 5240, firestore: 8240, auth: 9240, functions: 5241, hub: 4240, logging: 4540, websocket: 9241, eventarc: 9341, tasks: 9541 });
/** Pasta de trabalho do harness: obrigatória e fora do repositório. */
function pastaDeTrabalho(arg) {
  if (!arg) throw new Error('informe a pasta de trabalho (fora do repositório)');
  const p = path.resolve(arg);
  if (p === RAIZ || p.startsWith(RAIZ + path.sep)) throw new Error('a pasta de trabalho deve ficar FORA do repositório');
  return p;
}
module.exports = { RAIZ, PROJETO, PORTAS, pastaDeTrabalho };
