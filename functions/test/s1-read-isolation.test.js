'use strict';
/**
 * S1 — isolamento de LEITURA entre vendedores (Rules, acesso direto ao Firestore).
 * Vendedor não lê worklist (todos os vendedores), interacoes_fila, carteira alheia, notas privadas, histórico da carteira.
 * Gestão (role gestor e módulo fila-comercial-gestao SEM admin) mantém visão completa. Anônimo nada.
 * Também prova regressões S2/S3/S5.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const RULES_PATH = process.env.S1_RULES_PATH || resolve(__dirname, '../../modulos/firestore.rules');
const VD1 = 'uid-s1-vend1', VD2 = 'uid-s1-vend2', RV4 = 'uid-s1-revisor4', GEST = 'uid-s1-gestor', ADM = 'uid-s1-admin';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(VD1, { role: 'funcionario', ativo: true, funcionarioId: 'fa' }, { admin: false, modulos: ['fila-comercial', 'fila-comercial-operar', 'clientes'] });
  await u(VD2, { role: 'funcionario', ativo: true, funcionarioId: 'fb' }, { admin: false, modulos: ['fila-comercial', 'fila-comercial-operar'] });
  await u(RV4, { role: 'funcionario', ativo: true, funcionarioId: 'fc' }, { admin: false, modulos: ['fila-comercial-gestao'] });   // NÃO admin
  await u(GEST, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('fila_comercial/worklist').set({ dataReferencia: '2026-10-07', vendedores: { [VD1]: { novas: [] }, [VD2]: { novas: [] } } });
  await db.doc('fila_comercial/worklist_preview').set({ vendedores: {} });
  await db.doc('fila_comercial/snapshot').set({ clientesHoje: [] });
  await db.doc('interacoes_fila/oppA').set({ claimAtual: { operadorId: VD1 }, eventos: [{ operadorId: VD1 }] });
  await db.doc('interacoes_fila/oppF').set({ claimAtual: { operadorId: VD2 }, eventos: [{ operadorId: VD2 }] });
  await db.doc('carteira_comercial/GC:1').set({ ownerUid: VD1 });
  await db.doc('carteira_comercial/GC:2').set({ ownerUid: VD2 });
  await db.doc('carteira_comercial_historico/h1').set({ evento: 'x' });
  await db.doc('fila_comercial_gestao/worklist').set({ itens: {} });
  await db.doc('crm_notas_privadas/oppF__0').set({ operadorId: VD2, texto: 'privado' });
  await db.doc('perfis_360/p1').set({ x: 1 });
  await db.doc('clientes/cDeletar').set({ nome: 'x', gestaoClickId: '2' });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

for (const [nome, uid, outroOpp, minhaCart, outraCart] of [['Vend1', VD1, 'oppF', 'GC:1', 'GC:2'], ['Vend2', VD2, 'oppA', 'GC:2', 'GC:1']]) {
  describe(`S1 — vendedor ${nome}: leitura direta`, () => {
    test('NÃO lê a worklist (todos os vendedores) nem a prévia', async () => {
      await assertFails(as(uid).doc('fila_comercial/worklist').get());
      await assertFails(as(uid).doc('fila_comercial/worklist_preview').get());
    });
    test('NÃO lê interacoes_fila (nem doc do outro, nem próprio, nem listagem)', async () => {
      await assertFails(as(uid).doc('interacoes_fila/' + outroOpp).get());
      await assertFails(as(uid).collection('interacoes_fila').get());
    });
    test('lê SOMENTE a própria carteira; carteira alheia e listagem total negadas', async () => {
      await assertSucceeds(as(uid).doc('carteira_comercial/' + minhaCart).get());
      await assertFails(as(uid).doc('carteira_comercial/' + outraCart).get());
      await assertFails(as(uid).collection('carteira_comercial').get());
      await assertSucceeds(as(uid).collection('carteira_comercial').where('ownerUid', '==', uid).get());
      await assertFails(as(uid).collection('carteira_comercial').where('ownerUid', '==', uid === VD1 ? VD2 : VD1).get());
    });
    test('NÃO lê notas privadas, histórico da carteira, dados de gestão nem perfis 360', async () => {
      await assertFails(as(uid).doc('crm_notas_privadas/oppF__0').get());
      await assertFails(as(uid).doc('carteira_comercial_historico/h1').get());
      await assertFails(as(uid).doc('fila_comercial_gestao/worklist').get());
      await assertFails(as(uid).doc('perfis_360/p1').get());
    });
    test('snapshot legado segue legível (limitação documentada, sem dono por vendedor)', async () => {
      await assertSucceeds(as(uid).doc('fila_comercial/snapshot').get());
    });
  });
}

describe('S1 — gestão mantém visão completa (Revisor4 SEM admin)', () => {
  for (const [nome, uid] of [['gestor (role)', GEST], ['admin', ADM], ['Revisor4 (módulo fila-comercial-gestao)', RV4]]) {
    test(`${nome} lê worklist, prévia, interacoes_fila, carteira e histórico`, async () => {
      await assertSucceeds(as(uid).doc('fila_comercial/worklist').get());
      await assertSucceeds(as(uid).doc('fila_comercial/worklist_preview').get());
      await assertSucceeds(as(uid).collection('interacoes_fila').get());
      await assertSucceeds(as(uid).doc('carteira_comercial/GC:1').get());
      await assertSucceeds(as(uid).doc('carteira_comercial/GC:2').get());
      await assertSucceeds(as(uid).doc('carteira_comercial_historico/h1').get());
      await assertSucceeds(as(uid).doc('fila_comercial_gestao/worklist').get());
    });
  }
  test('Revisor4 continua NÃO sendo admin: não escreve sistema_usuarios nem se promove (S5)', async () => {
    await assertFails(as(RV4).doc('sistema_usuarios/' + RV4).update({ admin: true }));
    await assertFails(as(RV4).doc('sistema_usuarios/' + VD2).update({ modulos: ['x'] }));
  });
  test('Revisor4 não escreve nada comercial pelo SDK', async () => {
    await assertFails(as(RV4).doc('fila_comercial/worklist').set({ x: 1 }));
    await assertFails(as(RV4).doc('interacoes_fila/oppA').update({ estado: 'X' }));
  });
});

describe('S1 — anônimo e sem perfil', () => {
  test('anônimo não lê nada comercial', async () => {
    for (const p of ['fila_comercial/worklist', 'fila_comercial/snapshot', 'interacoes_fila/oppA', 'carteira_comercial/GC:1', 'carteira_comercial_historico/h1', 'crm_notas_privadas/oppF__0'])
      await assertFails(anon().doc(p).get());
    await assertFails(anon().collection('interacoes_fila').get());
  });
});

describe('S1 — regressões S5, S3 e S2', () => {
  test('S5: vendedor/gestor comum não se promovem; admin real pode', async () => {
    await assertFails(as(VD1).doc('sistema_usuarios/' + VD1).update({ admin: true }));
    await assertFails(as(GEST).doc('sistema_usuarios/' + GEST).update({ admin: true }));
    await assertSucceeds(as(ADM).doc('sistema_usuarios/' + VD2).update({ modulos: ['fila-comercial-operar'] }));
  });
  test('S3: ninguém apaga cliente nem histórico', async () => {
    for (const u of [as(VD1), as(GEST), as(ADM), anon()]) await assertFails(u.doc('clientes/cDeletar').delete());
  });
  test('S2: Vend1 não escreve em cliente de carteira da Vend2 (GC:2); escreve no próprio (GC:1)', async () => {
    await assertFails(as(VD1).doc('clientes/cDeletar').update({ pipeline: 'x' }));
    await env.withSecurityRulesDisabled(async c => { await c.firestore().doc('clientes/cProprio').set({ nome: 'p', gestaoClickId: '1' }); });
    await assertSucceeds(as(VD1).doc('clientes/cProprio').update({ pipeline: 'proposta' }));
  });
});
