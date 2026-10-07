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
const ADE = 'uid-s1-ademir', FAB = 'uid-s1-fabiana', CAM = 'uid-s1-camila', GEST = 'uid-s1-gestor', ADM = 'uid-s1-admin';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(ADE, { role: 'funcionario', ativo: true, funcionarioId: 'fa' }, { admin: false, modulos: ['fila-comercial', 'fila-comercial-operar', 'clientes'] });
  await u(FAB, { role: 'funcionario', ativo: true, funcionarioId: 'fb' }, { admin: false, modulos: ['fila-comercial', 'fila-comercial-operar'] });
  await u(CAM, { role: 'funcionario', ativo: true, funcionarioId: 'fc' }, { admin: false, modulos: ['fila-comercial-gestao'] });   // NÃO admin
  await u(GEST, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('fila_comercial/worklist').set({ dataReferencia: '2026-10-07', vendedores: { [ADE]: { novas: [] }, [FAB]: { novas: [] } } });
  await db.doc('fila_comercial/worklist_preview').set({ vendedores: {} });
  await db.doc('fila_comercial/snapshot').set({ clientesHoje: [] });
  await db.doc('interacoes_fila/oppA').set({ claimAtual: { operadorId: ADE }, eventos: [{ operadorId: ADE }] });
  await db.doc('interacoes_fila/oppF').set({ claimAtual: { operadorId: FAB }, eventos: [{ operadorId: FAB }] });
  await db.doc('carteira_comercial/GC:1').set({ ownerUid: ADE });
  await db.doc('carteira_comercial/GC:2').set({ ownerUid: FAB });
  await db.doc('carteira_comercial_historico/h1').set({ evento: 'x' });
  await db.doc('fila_comercial_gestao/worklist').set({ itens: {} });
  await db.doc('crm_notas_privadas/oppF__0').set({ operadorId: FAB, texto: 'privado' });
  await db.doc('perfis_360/p1').set({ x: 1 });
  await db.doc('clientes/cDeletar').set({ nome: 'x', gestaoClickId: '2' });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

for (const [nome, uid, outroOpp, minhaCart, outraCart] of [['Ademir', ADE, 'oppF', 'GC:1', 'GC:2'], ['Fabiana', FAB, 'oppA', 'GC:2', 'GC:1']]) {
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
      await assertFails(as(uid).collection('carteira_comercial').where('ownerUid', '==', uid === ADE ? FAB : ADE).get());
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

describe('S1 — gestão mantém visão completa (Camila SEM admin)', () => {
  for (const [nome, uid] of [['gestor (role)', GEST], ['admin', ADM], ['Camila (módulo fila-comercial-gestao)', CAM]]) {
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
  test('Camila continua NÃO sendo admin: não escreve sistema_usuarios nem se promove (S5)', async () => {
    await assertFails(as(CAM).doc('sistema_usuarios/' + CAM).update({ admin: true }));
    await assertFails(as(CAM).doc('sistema_usuarios/' + FAB).update({ modulos: ['x'] }));
  });
  test('Camila não escreve nada comercial pelo SDK', async () => {
    await assertFails(as(CAM).doc('fila_comercial/worklist').set({ x: 1 }));
    await assertFails(as(CAM).doc('interacoes_fila/oppA').update({ estado: 'X' }));
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
    await assertFails(as(ADE).doc('sistema_usuarios/' + ADE).update({ admin: true }));
    await assertFails(as(GEST).doc('sistema_usuarios/' + GEST).update({ admin: true }));
    await assertSucceeds(as(ADM).doc('sistema_usuarios/' + FAB).update({ modulos: ['fila-comercial-operar'] }));
  });
  test('S3: ninguém apaga cliente nem histórico', async () => {
    for (const u of [as(ADE), as(GEST), as(ADM), anon()]) await assertFails(u.doc('clientes/cDeletar').delete());
  });
  test('S2: Ademir não escreve em cliente de carteira da Fabiana (GC:2); escreve no próprio (GC:1)', async () => {
    await assertFails(as(ADE).doc('clientes/cDeletar').update({ pipeline: 'x' }));
    await env.withSecurityRulesDisabled(async c => { await c.firestore().doc('clientes/cProprio').set({ nome: 'p', gestaoClickId: '1' }); });
    await assertSucceeds(as(ADE).doc('clientes/cProprio').update({ pipeline: 'proposta' }));
  });
});
