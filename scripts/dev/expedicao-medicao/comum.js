'use strict';
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const PROJETO = 'demo-mr4-exp';
const PORTAS = Object.freeze({ site: 5350, firestore: 8350, auth: 9350, websocket: 9351, hub: 4350, logging: 4550 });
/** Pasta de trabalho: obrigatória e fora do repositório. */
function pastaDeTrabalho(arg) {
  if (!arg) throw new Error('informe a pasta de trabalho (fora do repositório)');
  const p = path.resolve(arg);
  if (p === RAIZ || p.startsWith(RAIZ + path.sep)) throw new Error('a pasta de trabalho deve ficar FORA do repositório');
  return p;
}
module.exports = { RAIZ, PROJETO, PORTAS, pastaDeTrabalho };
