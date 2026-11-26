'use strict';
// Harness local do CRM (investigação de uso + revisão de atribuição) — SOMENTE emuladores, projeto "demo-" e dados fictícios.
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const PROJETO = 'demo-mr4-crm';
const PORTAS = Object.freeze({ site: 5370, firestore: 8370, auth: 9370, functions: 5371, hub: 4370, logging: 4570, websocket: 9371, eventarc: 9372, tasks: 9373 });
/** Pasta de trabalho do harness: obrigatória e fora do repositório. */
function pastaDeTrabalho(arg) {
  if (!arg) throw new Error('informe a pasta de trabalho (fora do repositório)');
  const p = path.resolve(arg);
  if (p === RAIZ || p.startsWith(RAIZ + path.sep)) throw new Error('a pasta de trabalho deve ficar FORA do repositório');
  return p;
}
module.exports = { RAIZ, PROJETO, PORTAS, pastaDeTrabalho };
