'use strict';
/** S4 — Rules: vendedor (módulo clientes) não lê clientes/conversas/msgs/resumo/chat_status direto; gestão mantém; escritas legadas do vendedor fechadas onde há conversa. */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const RULES = process.env.S4_RULES_PATH || resolve(__dirname, '../../modulos/firestore.rules');
const VD1 = 'uid-s4-vd1', VD2 = 'uid-s4-vd2', RV4 = 'uid-s4-rv4', GEST = 'uid-s4-gest', ADM = 'uid-s4-adm';
const PH = '5585999991111';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(VD1, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['clientes', 'fila-comercial-operar'] });
  await u(VD2, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['clientes', 'fila-comercial-operar'] });
  await u(RV4, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-gestao'] });
  await u(GEST, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('clientes/c1').set({ nome: 'X', gestaoClickId: '1', telefone: '(85) 9999-0000' });
  await db.doc('clientes/c2').set({ nome: 'Y', gestaoClickId: '2' }); await db.doc('clientes/c3').set({ nome: 'Z' });
  await db.doc('carteira_comercial/GC:1').set({ ownerUid: VD1 }); await db.doc('carteira_comercial/GC:2').set({ ownerUid: VD2 });
  await db.doc('fila_comercial/worklist').set({ v: {} }); await db.doc('interacoes_fila/o').set({ e: [] });
  await db.doc('conversas/' + PH).set({ nome: 'x' }); await db.doc(`conversas/${PH}/msgs/m1`).set({ texto: 'oi' });
  await db.doc('conversas_resumo/' + PH).set({ ultima: 'oi' }); await db.doc('chat_status/' + PH).set({ status: 'ok' });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES, 'utf8'), ...require('./_ambiente/emulador').firestore() } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore(); const anon = () => env.unauthenticatedContext().firestore();

for (const [nome, uid, proprio, alheio] of [['Vend1', VD1, 'c1', 'c2'], ['Vend2', VD2, 'c2', 'c1']]) {
  describe(`S4 — vendedor ${nome} (módulo clientes): leitura direta`, () => {
    test('NÃO lista a coleção clientes nem lê cliente algum (próprio, alheio, sem carteira)', async () => {
      await assertFails(as(uid).collection('clientes').get());
      for (const c of [proprio, alheio, 'c3']) await assertFails(as(uid).doc('clientes/' + c).get());
      await assertFails(as(uid).collection('clientes').where('gestaoClickId', '==', proprio === 'c1' ? '1' : '2').get());
      await assertFails(as(uid).collection('clientes').limit(1).get());
    });
    test('NÃO lê conversas, msgs, resumo nem chat_status (get, list e collectionGroup)', async () => {
      await assertFails(as(uid).doc('conversas/' + PH).get());
      await assertFails(as(uid).doc(`conversas/${PH}/msgs/m1`).get());
      await assertFails(as(uid).collection(`conversas/${PH}/msgs`).get());
      await assertFails(as(uid).collectionGroup('msgs').get());
      await assertFails(as(uid).collection('conversas_resumo').get());
      await assertFails(as(uid).doc('chat_status/' + PH).get());
    });
    test('NÃO escreve em conversas/msgs/resumo/chat_status (sem contexto confiável de titularidade)', async () => {
      await assertFails(as(uid).doc('conversas/5585000000000').set({ nome: 'n' }));
      await assertFails(as(uid).collection(`conversas/${PH}/msgs`).add({ texto: 'fabricada' }));
      await assertFails(as(uid).doc('conversas_resumo/' + PH).set({ ultima: 'x' }));
      await assertFails(as(uid).doc('chat_status/' + PH).set({ status: 'resolvido' }));
    });
    test('escrita de cliente segue protegida (S2/S3): não edita o do outro, não apaga', async () => {
      await assertFails(as(uid).doc('clientes/' + alheio).update({ pipeline: 'x' }));
      await assertFails(as(uid).doc('clientes/' + proprio).delete());
      await assertSucceeds(as(uid).doc('clientes/' + proprio).update({ pipeline: 'proposta' }));       // escrita legítima no próprio continua
    });
  });
}
describe('S4 — gestão e anônimo', () => {
  test('gestor e admin (role gestor) mantêm leitura/escrita do legado', async () => {
    for (const u of [as(GEST), as(ADM)]) {
      await assertSucceeds(u.collection('clientes').get()); await assertSucceeds(u.doc('clientes/c3').get());
      await assertSucceeds(u.doc('conversas/' + PH).get()); await assertSucceeds(u.collection(`conversas/${PH}/msgs`).get());
      await assertSucceeds(u.doc('conversas_resumo/' + PH).get()); await assertSucceeds(u.doc('chat_status/' + PH).set({ status: 'pendente' }));
    }
  });
  test('Revisor4 (gestão por módulo, sem ser gestor) não ganha leitura do legado — e continua não-admin', async () => {
    await assertFails(as(RV4).collection('clientes').get()); await assertFails(as(RV4).doc('conversas/' + PH).get());
    await assertFails(as(RV4).doc('sistema_usuarios/' + RV4).update({ admin: true }));
  });
  test('anônimo: nada', async () => {
    await assertFails(anon().collection('clientes').get()); await assertFails(anon().doc('conversas/' + PH).get());
    await assertFails(anon().doc('clientes/c1').update({ nome: 'x' })); await assertFails(anon().doc('chat_status/' + PH).set({ a: 1 }));
  });
});
describe('S4 — regressões S5, S3, S2, S1, S7, S6', () => {
  test('S5', async () => { await assertFails(as(GEST).doc('sistema_usuarios/' + GEST).update({ admin: true })); await assertSucceeds(as(ADM).doc('sistema_usuarios/' + VD2).update({ modulos: ['clientes'] })); });
  test('S3 (sem delete) e S2 (sem escrever cliente alheio)', async () => { await assertFails(as(ADM).doc('clientes/c3').delete()); await assertFails(as(VD1).doc('clientes/c2').update({ pipeline: 'x' })); });
  test('S1 (worklist/interacoes só gestão)', async () => {
    await assertFails(as(VD1).doc('fila_comercial/worklist').get()); await assertFails(as(VD1).doc('interacoes_fila/o').get()); await assertSucceeds(as(RV4).doc('fila_comercial/worklist').get());
  });
  test('S7 (audit_log append-only) e S6 (sem escrever oportunidade pelo SDK)', async () => {
    await assertFails(as(ADM).doc('audit_log/x').set({ a: 1 })); await assertFails(as(VD1).doc('interacoes_fila/o').update({ estado: 'X' }));
  });
});
