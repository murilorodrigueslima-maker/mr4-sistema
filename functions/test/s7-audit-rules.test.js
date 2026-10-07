'use strict';
/** S7 — Rules do audit_log: append-only para TODOS os perfis do cliente; leitura por escopo. + regressões S5/S3/S2/S1. */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = process.env.S7_RULES_PATH || resolve(__dirname, '../../modulos/firestore.rules');
const ADE = 'uid-s7-ade', FAB = 'uid-s7-fab', CAM = 'uid-s7-cam', GEST = 'uid-s7-gest', ADM = 'uid-s7-adm';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(ADE, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-operar', 'clientes'] });
  await u(FAB, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-operar'] });
  await u(CAM, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-gestao'] });
  await u(GEST, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('audit_log/e-sec').set({ category: 'SECURITY', action: 'ADMIN_FLAG_CHANGED', actorUid: ADM, entityId: FAB });
  await db.doc('audit_log/e-com-ade').set({ category: 'COMMERCIAL', action: 'OPP_CLAIMED', actorUid: ADE, entityId: 'o1' });
  await db.doc('audit_log/e-com-fab').set({ category: 'COMMERCIAL', action: 'OPP_CLAIMED', actorUid: FAB, entityId: 'o2' });
  await db.doc('fila_comercial/worklist').set({ vendedores: {} });
  await db.doc('interacoes_fila/o1').set({ eventos: [] });
  await db.doc('clientes/cx').set({ nome: 'x', gestaoClickId: '2' }); await db.doc('carteira_comercial/GC:2').set({ ownerUid: FAB });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES, 'utf8'), host: 'localhost', port: 8080 } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const FORJADO = { schemaVersion: 'audit-v1', category: 'COMMERCIAL', action: 'OPP_CLAIMED', actorUid: GEST, actorType: 'USER', entityId: 'o9' };

describe('S7 — append-only: ninguém do cliente escreve no audit_log', () => {
  for (const [nome, ctx] of [['vendedor (Ademir)', () => as(ADE)], ['vendedora (Fabiana)', () => as(FAB)], ['Camila (gestão)', () => as(CAM)], ['gestor', () => as(GEST)], ['admin', () => as(ADM)], ['anônimo', () => anon()]]) {
    test(`${nome}: não cria (nem forjando ator), não altera, não apaga`, async () => {
      await assertFails(ctx().doc('audit_log/novo').set(FORJADO));
      await assertFails(ctx().collection('audit_log').add(FORJADO));
      await assertFails(ctx().doc('audit_log/e-com-ade').update({ actorUid: 'outro' }));
      await assertFails(ctx().doc('audit_log/e-com-ade').set({ ...FORJADO, entityId: 'o1' }));
      await assertFails(ctx().doc('audit_log/e-com-ade').delete());
      await assertFails(ctx().doc('audit_log/e-sec').delete());
    });
  }
});

describe('S7 — leitura por escopo', () => {
  test('vendedores e anônimo não leem nada (nem os próprios eventos, nem do outro)', async () => {
    for (const u of [as(ADE), as(FAB), anon()]) {
      await assertFails(u.doc('audit_log/e-com-ade').get()); await assertFails(u.doc('audit_log/e-com-fab').get()); await assertFails(u.doc('audit_log/e-sec').get());
      await assertFails(u.collection('audit_log').get());
      await assertFails(u.collection('audit_log').where('category', '==', 'COMMERCIAL').get());
    }
  });
  test('gestor e admin (role gestor) leem tudo', async () => {
    for (const u of [as(GEST), as(ADM)]) {
      await assertSucceeds(u.doc('audit_log/e-sec').get());
      await assertSucceeds(u.collection('audit_log').get());
    }
  });
  test('Camila (módulo gestão, não admin): só category COMMERCIAL — nunca SECURITY', async () => {
    await assertSucceeds(as(CAM).doc('audit_log/e-com-ade').get());
    await assertFails(as(CAM).doc('audit_log/e-sec').get());
    await assertSucceeds(as(CAM).collection('audit_log').where('category', '==', 'COMMERCIAL').get());
    await assertFails(as(CAM).collection('audit_log').get());
    await assertFails(as(CAM).doc('sistema_usuarios/' + CAM).update({ admin: true }));       // continua não-admin (S5)
  });
});

describe('S7 — regressões S5, S3, S2, S1', () => {
  test('S5: gestor comum/vendedor não se promovem; admin real pode', async () => {
    await assertFails(as(GEST).doc('sistema_usuarios/' + GEST).update({ admin: true }));
    await assertFails(as(ADE).doc('sistema_usuarios/' + ADE).update({ admin: true }));
    await assertSucceeds(as(ADM).doc('sistema_usuarios/' + FAB).update({ modulos: ['fila-comercial-operar', 'x'] }));
  });
  test('S3: ninguém apaga cliente', async () => { for (const u of [as(ADE), as(GEST), as(ADM), anon()]) await assertFails(u.doc('clientes/cx').delete()); });
  test('S2: Ademir não escreve em cliente da carteira da Fabiana', async () => { await assertFails(as(ADE).doc('clientes/cx').update({ pipeline: 'x' })); });
  test('S1: vendedor não lê worklist/interacoes direto; gestão lê', async () => {
    await assertFails(as(ADE).doc('fila_comercial/worklist').get()); await assertFails(as(FAB).doc('interacoes_fila/o1').get());
    await assertSucceeds(as(CAM).doc('fila_comercial/worklist').get());
  });
});
