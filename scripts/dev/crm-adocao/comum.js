'use strict';
// Harness local de adoção do CRM (medição do fluxo do vendedor) — SOMENTE emuladores, projeto "demo-" e dados fictícios.
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const PROJETO = 'demo-mr4-adocao';
const PORTAS = Object.freeze({ site: 5470, firestore: 8470, auth: 9470, functions: 5471, hub: 4470, logging: 4670, websocket: 9471, eventarc: 9472, tasks: 9473 });
/** Pasta de trabalho do harness: obrigatória e fora do repositório. */
function pastaDeTrabalho(arg) {
  if (!arg) throw new Error('informe a pasta de trabalho (fora do repositório)');
  const p = path.resolve(arg);
  if (p === RAIZ || p.startsWith(RAIZ + path.sep)) throw new Error('a pasta de trabalho deve ficar FORA do repositório');
  return p;
}
module.exports = { RAIZ, PROJETO, PORTAS, pastaDeTrabalho };
