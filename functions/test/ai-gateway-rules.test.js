'use strict';
// AGENTE COMERCIAL · coleções de uso/limite (ai_rate, ai_uso, ai_chamadas) são SÓ do backend: Rules reais negam leitura e escrita a todos.
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
jest.setTimeout(60000); let env;
const U = { gestor: ['gestor', []], func: ['funcionario', ['fila-comercial-operar']], gest2: ['funcionario', ['fila-comercial-gestao']], admin: ['gestor', [], true] };
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore(); for (const [id, [role, mods, adm]] of Object.entries(U)) { await d.doc('users/' + id).set({ role, ativo: true }); await d.doc('sistema_usuarios/' + id).set({ modulos: mods, admin: !!adm }); } for (const p of ['ai_rate/u', 'ai_uso/2026-09-30__u', 'ai_chamadas/x']) await d.doc(p).set({ fixture: true }); });
});
afterAll(async () => { if (env) await env.cleanup(); });
test('ninguém (anônimo, vendedor, gestor, gestão, admin) lê, lista ou escreve ai_rate/ai_uso/ai_chamadas', async () => {
  for (const uid of [null, ...Object.keys(U)]) { const db = (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
    for (const p of ['ai_rate/u', 'ai_uso/2026-09-30__u', 'ai_chamadas/x']) { await assertFails(db.doc(p).get()); await assertFails(db.doc(p).set({ x: 1 })); await assertFails(db.doc(p).delete()); }
    for (const c of ['ai_rate', 'ai_uso', 'ai_chamadas']) await assertFails(db.collection(c).get()); }
});
test('o agente não adiciona nenhuma regra: o arquivo de Rules é idêntico ao do main aprovado', () => {
  const { execSync } = require('child_process'); const raiz = resolve(__dirname, '../..'); let base; try { base = execSync('git show f944e67:modulos/firestore.rules', { cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return; }
  expect(readFileSync(resolve(raiz, 'modulos/firestore.rules'), 'utf8')).toBe(base);
});
