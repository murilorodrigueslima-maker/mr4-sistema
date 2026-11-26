'use strict';
/** Regra `compras_sombra_13` (Política 1.3 em sombra): leitura só da gestão (gestor com módulo estoque ou admin, não bloqueado); nenhuma escrita pelo cliente. */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = readFileSync(process.env.RULES_FILE || resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
const [host, porta] = (process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080').split(':');
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
const DOCS = ['meta', 'resumo', 'bloco_000', 'dia_2026-11-26'];
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-mr4-sombra13', firestore: { rules: RULES, host, port: Number(porta) } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore();
    for (const n of nomes) { const p = P[n]; if (!p) continue; await d.collection('users').doc(uid(n)).set(p.u); if (p.s) await d.collection('sistema_usuarios').doc(uid(n)).set(p.s); }
    for (const id of DOCS) await d.collection('compras_sombra_13').doc(id).set({ x: 1 }); });
});
afterAll(async () => { if (env) await env.cleanup(); });
const ctx = n => (P[n] ? env.authenticatedContext(uid(n)) : env.unauthenticatedContext()).firestore();
describe.each(nomes)('%s', n => {
  const le = !!(P[n] && P[n].le);
  test(`leitura: ${le ? 'permitida' : 'negada'}`, async () => { for (const id of DOCS) await (le ? assertSucceeds : assertFails)(ctx(n).collection('compras_sombra_13').doc(id).get()); });
  test('escrita sempre negada', async () => {
    const col = ctx(n).collection('compras_sombra_13');
    await assertFails(col.doc('meta').set({ y: 1 })); await assertFails(col.doc('meta').delete()); await assertFails(col.doc('novo').set({ y: 1 }));
  });
});
