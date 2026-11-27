'use strict';
/**
 * Regra `compras_n0_fornecedores` (Compras — Análise de Vendas por Fornecedor, Fase C), publicada em produção em 24/10/2026 e reconciliada no Git.
 *   unidades: temAcessoModulo('estoque')                               ⇒ gestor OU funcionário (dual-role) com módulo estoque/admin, não bloqueado
 *   valores : temModulo('estoque') && naoBloqueado()                   ⇒ SÓ gestor (+ admin ou módulo estoque), não bloqueado
 *   qualquer outro docId e QUALQUER escrita: negados.
 * Os expectativos vêm do texto da regra e da política (bloqueado ⇒ nada). Vale para o arquivo do repositório E para o candidato "produção + R1".
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = readFileSync(process.env.RULES_FILE || resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
let env;
const P = {
  'gestor módulos=[estoque]':        { u: { role: 'gestor', ativo: true }, s: { modulos: ['estoque'], admin: false }, e: [true, true] },
  'gestor admin=true':               { u: { role: 'gestor', ativo: true }, s: { modulos: [], admin: true }, e: [true, true] },
  'gestor módulos=[ponto]':          { u: { role: 'gestor', ativo: true }, s: { modulos: ['ponto'], admin: false }, e: [false, false] },
  'gestor SEM sistema_usuarios':     { u: { role: 'gestor', ativo: true }, e: [false, false] },
  'gestor BLOQUEADO (estoque+admin)': { u: { role: 'gestor', ativo: true }, s: { modulos: ['estoque'], admin: true, bloqueado: true }, e: [false, false] },
  'dual-role módulos=[estoque]':     { u: { role: 'funcionario', ativo: true, funcionarioId: 'F1' }, s: { modulos: ['estoque'], admin: false }, e: [true, false] },
  'dual-role admin=true':            { u: { role: 'funcionario', ativo: true, funcionarioId: 'F2' }, s: { modulos: [], admin: true }, e: [true, false] },
  'dual-role módulos=[compras]':     { u: { role: 'funcionario', ativo: true, funcionarioId: 'F3' }, s: { modulos: ['compras'], admin: false }, e: [false, false] },
  'dual-role estoque BLOQUEADO':     { u: { role: 'funcionario', ativo: true, funcionarioId: 'F4' }, s: { modulos: ['estoque'], admin: false, bloqueado: true }, e: [false, false] },
  'funcionário comum':               { u: { role: 'funcionario', ativo: true, funcionarioId: 'F5' }, e: [false, false] },
  display:                           { u: { role: 'display', ativo: true }, e: [false, false] },
  anonimo:                           null,
};
const nomes = Object.keys(P); const uid = n => 'c' + nomes.indexOf(n);
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-compras-n0', firestore: { rules: RULES, ...require('./_ambiente/emulador').firestore() } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore();
    for (const n of nomes) { const p = P[n]; if (!p) continue; await d.collection('users').doc(uid(n)).set(p.u); if (p.s) await d.collection('sistema_usuarios').doc(uid(n)).set(p.s); }
    for (const id of ['unidades', 'valores', 'outro']) await d.collection('compras_n0_fornecedores').doc(id).set({ x: 1 }); });
});
afterAll(async () => { if (env) await env.cleanup(); });
const ctx = n => (P[n] ? env.authenticatedContext(uid(n)) : env.unauthenticatedContext()).firestore();
test('o bloco compras_n0_fornecedores existe no arquivo de regras avaliado (não é teste vazio)', () => { expect(RULES).toMatch(/match \/compras_n0_fornecedores\/\{docId\}/); expect(RULES).toMatch(/docId == 'unidades' && temAcessoModulo\('estoque'\)/); expect(RULES).toMatch(/docId == 'valores'  && temModulo\('estoque'\) && naoBloqueado\(\)/); });
describe.each(nomes)('%s', n => {
  const e = P[n] ? P[n].e : [false, false];
  test(`unidades: ${e[0] ? 'LÊ' : 'nega'}`, async () => { await (e[0] ? assertSucceeds : assertFails)(ctx(n).collection('compras_n0_fornecedores').doc('unidades').get()); });
  test(`valores: ${e[1] ? 'LÊ' : 'nega'}`, async () => { await (e[1] ? assertSucceeds : assertFails)(ctx(n).collection('compras_n0_fornecedores').doc('valores').get()); });
  test('outro docId: nega; escrita em qualquer doc: nega', async () => {
    const col = ctx(n).collection('compras_n0_fornecedores');
    await assertFails(col.doc('outro').get()); await assertFails(col.doc('unidades').set({ y: 1 })); await assertFails(col.doc('valores').set({ y: 1 })); await assertFails(col.doc('novo').set({ y: 1 }));
  });
});
