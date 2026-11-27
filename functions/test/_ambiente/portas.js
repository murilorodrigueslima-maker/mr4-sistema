'use strict';
// Portas EXCLUSIVAS do ambiente de teste/prévia do MR4. Bloco 0 = emulador de desenvolvimento (firebase.json e telas em localhost);
// blocos 1–9 = testes (padrão 1; para rodar duas suítes ao mesmo tempo, MR4_TEST_BLOCO=2, 3…). Nunca a 8080.
const BASES = { firestore: 8710, websocket: 9810, auth: 9710, functions: 5710, hub: 4710, logging: 4810, eventarc: 9830 };
const PROIBIDAS = [8080];   // porta de outro projeto nesta máquina: nenhum teste pode abri-la nem chamá-la
function doBloco(bloco) {
  const b = Number(bloco);
  if (!Number.isInteger(b) || b < 0 || b > 9) throw new Error('MR4_TEST_BLOCO deve ser um número de 1 a 9');
  return Object.fromEntries(Object.entries(BASES).map(([k, v]) => [k, v + b]));
}
module.exports = { doBloco, PROIBIDAS };
