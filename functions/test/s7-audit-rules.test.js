'use strict';
/** S7 — Rules do audit_log: append-only para TODOS os perfis do cliente; leitura por escopo. + regressões S5/S3/S2/S1. */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = process.env.S7_RULES_PATH || resolve(__dirname, '../../modulos/firestore.rules');
const VD1 = 'uid-s7-vd1', VD2 = 'uid-s7-vd2', RV4 = 'uid-s7-rv4', GEST = 'uid-s7-gest', ADM = 'uid-s7-adm';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(VD1, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-operar', 'clientes'] });
  await u(VD2, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-operar'] });
  await u(RV4, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-gestao'] });
  await u(GEST, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('audit_log/e-sec').set({ category: 'SECURITY', action: 'ADMIN_FLAG_CHANGED', actorUid: ADM, entityId: VD2 });
  await db.doc('audit_log/e-com-vd1').set({ category: 'COMMERCIAL', action: 'OPP_CLAIMED', actorUid: VD1, entityId: 'o1' });
  await db.doc('audit_log/e-com-vd2').set({ category: 'COMMERCIAL', action: 'OPP_CLAIMED', actorUid: VD2, entityId: 'o2' });
  await db.doc('fila_comercial/worklist').set({ vendedores: {} });
  await db.doc('interacoes_fila/o1').set({ eventos: [] });
  await db.doc('clientes/cx').set({ nome: 'x', gestaoClickId: '2' }); await db.doc('carteira_comercial/GC:2').set({ ownerUid: VD2 });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES, 'utf8'), host: 'localhost', port: 8080 } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const FORJADO = { schemaVersion: 'audit-v1', category: 'COMMERCIAL', action: 'OPP_CLAIMED', actorUid: GEST, actorType: 'USER', entityId: 'o9' };

describe('S7 — append-only: ninguém do cliente escreve no audit_log', () => {
  for (const [nome, ctx] of [['vendedor (Vend1)', () => as(VD1)], ['vendedora (Vend2)', () => as(VD2)], ['Revisor4 (gestão)', () => as(RV4)], ['gestor', () => as(GEST)], ['admin', () => as(ADM)], ['anônimo', () => anon()]]) {
    test(`${nome}: não cria (nem forjando ator), não altera, não apaga`, async () => {
      await assertFails(ctx().doc('audit_log/novo').set(FORJADO));
      await assertFails(ctx().collection('audit_log').add(FORJADO));
      await assertFails(ctx().doc('audit_log/e-com-vd1').update({ actorUid: 'outro' }));
      await assertFails(ctx().doc('audit_log/e-com-vd1').set({ ...FORJADO, entityId: 'o1' }));
      await assertFails(ctx().doc('audit_log/e-com-vd1').delete());
      await assertFails(ctx().doc('audit_log/e-sec').delete());
    });
  }
});

describe('S7 — leitura por escopo', () => {
  test('vendedores e anônimo não leem nada (nem os próprios eventos, nem do outro)', async () => {
    for (const u of [as(VD1), as(VD2), anon()]) {
      await assertFails(u.doc('audit_log/e-com-vd1').get()); await assertFails(u.doc('audit_log/e-com-vd2').get()); await assertFails(u.doc('audit_log/e-sec').get());
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
  test('Revisor4 (módulo gestão, não admin): só category COMMERCIAL — nunca SECURITY', async () => {
    await assertSucceeds(as(RV4).doc('audit_log/e-com-vd1').get());
    await assertFails(as(RV4).doc('audit_log/e-sec').get());
    await assertSucceeds(as(RV4).collection('audit_log').where('category', '==', 'COMMERCIAL').get());
    await assertFails(as(RV4).collection('audit_log').get());
    await assertFails(as(RV4).doc('sistema_usuarios/' + RV4).update({ admin: true }));       // continua não-admin (S5)
  });
});

describe('S7 — regressões S5, S3, S2, S1', () => {
  test('S5: gestor comum/vendedor não se promovem; admin real pode', async () => {
    await assertFails(as(GEST).doc('sistema_usuarios/' + GEST).update({ admin: true }));
    await assertFails(as(VD1).doc('sistema_usuarios/' + VD1).update({ admin: true }));
    await assertSucceeds(as(ADM).doc('sistema_usuarios/' + VD2).update({ modulos: ['fila-comercial-operar', 'x'] }));
  });
  test('S3: ninguém apaga cliente', async () => { for (const u of [as(VD1), as(GEST), as(ADM), anon()]) await assertFails(u.doc('clientes/cx').delete()); });
  test('S2: Vend1 não escreve em cliente da carteira da Vend2', async () => { await assertFails(as(VD1).doc('clientes/cx').update({ pipeline: 'x' })); });
  test('S1: vendedor não lê worklist/interacoes direto; gestão lê', async () => {
    await assertFails(as(VD1).doc('fila_comercial/worklist').get()); await assertFails(as(VD2).doc('interacoes_fila/o1').get());
    await assertSucceeds(as(RV4).doc('fila_comercial/worklist').get());
  });
});
