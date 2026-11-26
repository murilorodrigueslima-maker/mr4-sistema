'use strict';
/** Regras do planejamento de compra (compras_sombra_14 e cadastros lidos por ele): leitura só da gestão (gestor com módulo estoque ou admin, não bloqueado).
 *  A base nunca é gravada pelo cliente; a ESCRITA dos cadastros pertence a outro módulo (por isso só a leitura é testada aqui). */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = readFileSync(process.env.RULES_FILE || resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
const [host, porta] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8320').split(':');
let env;
const P = {
  'gestor módulos=[estoque]': { u: { role: 'gestor', ativo: true }, s: { modulos: ['estoque'], admin: false }, le: true },
  'gestor admin=true': { u: { role: 'gestor', ativo: true }, s: { modulos: [], admin: true }, le: true },
  'gestor módulos=[ponto]': { u: { role: 'gestor', ativo: true }, s: { modulos: ['ponto'], admin: false }, le: false },
  'gestor BLOQUEADO': { u: { role: 'gestor', ativo: true }, s: { modulos: ['estoque'], admin: true, bloqueado: true }, le: false },
  'dual-role módulos=[estoque]': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F1' }, s: { modulos: ['estoque'], admin: false }, le: false },
  'funcionário comum': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F2' }, le: false },
  display: { u: { role: 'display', ativo: true }, le: false },
  anonimo: null,
};
const nomes = Object.keys(P); const uid = n => 's' + nomes.indexOf(n);
const DOCS = ['meta', 'bloco_000'];
const CADASTROS = ['compras_fornecedor_parametros', 'compras_pendencias_confirmacao', 'compras_origem'];
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-mr4-sombra14', firestore: { rules: RULES, host, port: Number(porta) } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore();
    for (const n of nomes) { const p = P[n]; if (!p) continue; await d.collection('users').doc(uid(n)).set(p.u); if (p.s) await d.collection('sistema_usuarios').doc(uid(n)).set(p.s); }
    for (const id of DOCS) await d.collection('compras_sombra_14').doc(id).set({ x: 1 });
    for (const c of CADASTROS) await d.collection(c).doc('X1').set({ x: 1 }); });
});
afterAll(async () => { if (env) await env.cleanup(); });
const ctx = n => (P[n] ? env.authenticatedContext(uid(n)) : env.unauthenticatedContext()).firestore();
describe.each(nomes)('%s', n => {
  const le = !!(P[n] && P[n].le);
  test(`leitura: ${le ? 'permitida' : 'negada'}`, async () => { for (const id of DOCS) await (le ? assertSucceeds : assertFails)(ctx(n).collection('compras_sombra_14').doc(id).get()); });
  test(`cadastros do planejamento (documento e lista): ${le ? 'permitido' : 'negado'}`, async () => {
    for (const c of CADASTROS) { await (le ? assertSucceeds : assertFails)(ctx(n).collection(c).doc('X1').get()); await (le ? assertSucceeds : assertFails)(ctx(n).collection(c).get()); }
  });
  test('escrita da base sempre negada', async () => {
    const col = ctx(n).collection('compras_sombra_14');
    await assertFails(col.doc('meta').set({ y: 1 })); await assertFails(col.doc('meta').delete()); await assertFails(col.doc('novo').set({ y: 1 }));
  });
});
