'use strict';
// Endereço do emulador isolado para os testes. Nenhum teste escreve porta fixa.
const ativo = () => process.env.MR4_TEST_MODO === 'emulador';
function portas() {
  if (!ativo()) throw new Error('Este teste precisa do emulador isolado: node scripts/testes/rodar.js -- <arquivo>');
  return JSON.parse(process.env.MR4_TEST_PORTAS);
}
const firestore = () => ({ host: '127.0.0.1', port: portas().firestore });
module.exports = { ativo, portas, firestore };
