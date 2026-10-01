'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · Rules de fin_n1 e fin_n1_titulos_abertos (EMULADOR). Enforcement server-side.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
jest.setTimeout(60000);
let env;
const PERFIS = {
  admin:            { users: { role: 'gestor', ativo: true }, sys: { modulos: [], admin: true } },
  gestorComFin:     { users: { role: 'gestor', ativo: true }, sys: { modulos: ['financeiro'] } },
  gestorSemFin:     { users: { role: 'gestor', ativo: true }, sys: { modulos: ['vendas'] } },
  gestorSemCadastro:{ users: { role: 'gestor', ativo: true }, sys: null },
  funcComFin:       { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['financeiro'] } },
  funcSemFin:       { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['ponto'] } },
  bloqueado:        { users: { role: 'gestor', ativo: true }, sys: { modulos: ['financeiro'], admin: true, bloqueado: true } },
  inativo:          { users: { role: 'funcionario', ativo: false }, sys: { modulos: ['financeiro'] } },
};
const PODE = { admin: true, gestorComFin: true, funcComFin: true };   // demais: negado
const DOCS = [['fin_n1', 'active'], ['fin_n1', 'meta'], ['fin_n1_resumo', 'g1__resumo'], ['fin_n1_resumo', 'g1__entidades'], ['fin_n1_titulos', 'g1__PAGAR__VENCIDO__000']];

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    for (const [uid, p] of Object.entries(PERFIS)) { await db.doc('users/' + uid).set(p.users); if (p.sys) await db.doc('sistema_usuarios/' + uid).set(p.sys); }
    for (const [col, id] of DOCS) await db.doc(`${col}/${id}`).set({ fixture: true });
    await db.doc('fin_n1/outro').set({ fixture: true });
    await db.doc('fin_n1_ctl/lock').set({ run_id: 'x' });
  });
});
afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });

describe('AUTHORIZATION_MATRIX (backend)', () => {
  test.each(DOCS)('ANÔNIMO não lê %s/%s', async (col, id) => { await assertFails(env.unauthenticatedContext().firestore().doc(`${col}/${id}`).get()); });
  for (const uid of Object.keys(PERFIS)) {
    for (const [col, id] of DOCS) {
      test(`${uid} ${PODE[uid] ? 'LÊ' : 'NÃO lê'} ${col}/${id}`, async () => {
        const op = env.authenticatedContext(uid).firestore().doc(`${col}/${id}`).get();
        await (PODE[uid] ? assertSucceeds(op) : assertFails(op));
      });
    }
  }
  test('ninguém escreve (nem admin) e docId fora da lista é negado', async () => {
    const db = env.authenticatedContext('admin').firestore();
    await assertFails(db.doc('fin_n1/active').set({ x: 1 }));
    await assertFails(db.doc('fin_n1_titulos/g1__PAGAR__VENCIDO__000').update({ x: 1 }));
    await assertFails(db.doc('fin_n1_resumo/g2__resumo').set({ x: 1 }));
    await assertFails(db.doc('fin_n1_ctl/lock').get());                       // trava: nunca do navegador
    await assertFails(db.doc('fin_n1_ctl/lock').set({ run_id: 'y' }));
    await assertFails(db.collection('fin_n1_titulos').get());                  // listar a coleção inteira é negado (só get por id)
    await assertFails(db.collection('fin_n1_resumo').get());
    await assertFails(db.doc('fin_n1/meta').delete());
    await assertFails(db.doc('fin_n1/outro').get());
  });
});
