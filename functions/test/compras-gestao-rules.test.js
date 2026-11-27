'use strict';
/** Regras da gestão de Compras (parâmetros, pendências, origem e históricos): leitura só da gestão (gestor com módulo estoque ou admin, não bloqueado); nenhuma escrita pelo cliente. */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = readFileSync(process.env.RULES_FILE || resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
const [host, porta] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
let env;
const P = {
  'gestor módulos=[estoque]': { u: { role: 'gestor', ativo: true }, s: { modulos: ['estoque'], admin: false }, le: true },
  'gestor admin=true': { u: { role: 'gestor', ativo: true }, s: { modulos: [], admin: true }, le: true },
  'gestor módulos=[ponto]': { u: { role: 'gestor', ativo: true }, s: { modulos: ['ponto'], admin: false }, le: false },
  'gestor sem sistema_usuarios': { u: { role: 'gestor', ativo: true }, le: false },
  'gestor inativo': { u: { role: 'gestor', ativo: false }, s: { admin: true, modulos: [] }, le: false },
  'gestor BLOQUEADO': { u: { role: 'gestor', ativo: true }, s: { modulos: ['estoque'], admin: true, bloqueado: true }, le: false },
  'dual-role módulos=[estoque]': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F1' }, s: { modulos: ['estoque'], admin: false }, le: false },
  'funcionário comum': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F2' }, le: false },
  display: { u: { role: 'display', ativo: true }, le: false },
  anonimo: null,
};
const nomes = Object.keys(P); const uid = n => 'g' + nomes.indexOf(n);
const CAMINHOS = ['compras_fornecedor_parametros/9001', 'compras_fornecedor_parametros/9001/historico/0000001', 'compras_pendencias_confirmacao/600', 'compras_pendencias_confirmacao/600/historico/0000001',
  'compras_origem/600', 'compras_origem_controle/atual', 'compras_origem_confirmacao/600', 'compras_origem_confirmacao/600/historico/0000001'];
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-mr4-cadastros-rules', firestore: { rules: RULES, host, port: Number(porta) } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore();
    for (const n of nomes) { const p = P[n]; if (!p) continue; await d.collection('users').doc(uid(n)).set(p.u); if (p.s) await d.collection('sistema_usuarios').doc(uid(n)).set(p.s); }
    for (const x of CAMINHOS) await d.doc(x).set({ x: 1 }); });
});
afterAll(async () => { if (env) await env.cleanup(); });
const ctx = n => (P[n] ? env.authenticatedContext(uid(n)) : env.unauthenticatedContext()).firestore();
describe.each(nomes)('%s', n => {
  const le = !!(P[n] && P[n].le);
  test(`leitura: ${le ? 'permitida' : 'negada'}`, async () => { for (const x of CAMINHOS) await (le ? assertSucceeds : assertFails)(ctx(n).doc(x).get()); });
  test('escrita sempre negada (criar, alterar, apagar, histórico)', async () => {
    for (const x of CAMINHOS) { const r = ctx(n).doc(x); await assertFails(r.set({ y: 1 })); await assertFails(r.update({ x: 2 })); await assertFails(r.delete()); await assertFails(ctx(n).doc(x.replace(/[^/]+$/, 'novo')).set({ y: 1 })); }
  });
});
