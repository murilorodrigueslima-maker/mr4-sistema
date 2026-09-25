'use strict';
// N35.14 — Criação lazy no claim (emulador). PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();

const { claimOpportunityHandler, releaseOpportunityHandler } = require('../lib/canaryCallable');
const { criarEstadoInicial, dataComercial } = require('../lib/filaOperacional');

const COLL = 'interacoes_fila';
const U = { A: 'n3514-vend-a', B: 'n3514-vend-b', G: 'n3514-gestao' };
const ENT = 'GC_NATIVE:77001234';
const OPP = 'aa11bb22cc33dd44';
const OPP_B = 'bb11bb22cc33dd44';
const OPP_CANARIO = 'cc11bb22cc33dd44';
const OPP_NAO_ATRIB = 'dd11bb22cc33dd44';
const req = (uid, opp) => ({ auth: uid ? { uid } : null, data: { opportunityInstanceId: opp } });
const hoje = () => dataComercial(new Date().toISOString());

async function seedUser(uid, modulos) {
  await db.collection('users').doc(uid).set({ ativo: true, role: 'funcionario', email: uid + '@t.mr4' });
  await db.collection('sistema_usuarios').doc(uid).set({ admin: false, modulos, nome: uid });
}
async function setWorklist(dataReferencia, atribuicoes) {
  await db.collection('fila_comercial').doc('worklist').set({ schemaVersion: 'worklist-v2', dataReferencia, atribuicoes, canarios: [OPP_CANARIO] });
}
async function limparOps() {
  for (const id of [OPP, OPP_B, OPP_CANARIO, OPP_NAO_ATRIB]) await db.collection(COLL).doc(id).delete();
}

beforeAll(async () => {
  await seedUser(U.A, ['fila-comercial', 'fila-comercial-operar']);
  await seedUser(U.B, ['fila-comercial', 'fila-comercial-operar']);
  await seedUser(U.G, ['fila-comercial-gestao']);
}, 20000);
afterAll(async () => {
  await limparOps();
  await db.collection('fila_comercial').doc('worklist').delete();
  for (const uid of Object.values(U)) { await db.collection('users').doc(uid).delete(); await db.collection('sistema_usuarios').doc(uid).delete(); }
}, 20000);
beforeEach(async () => {
  await limparOps();
  await setWorklist(hoje(), {
    [OPP]:   { uid: U.A, grupo: 'newOpportunities', commercialEntityId: ENT, tipoOportunidade: 'REATIVACAO_120D' },
    [OPP_B]: { uid: U.B, grupo: 'newOpportunities', commercialEntityId: 'GC_NATIVE:77009999', tipoOportunidade: 'QUEDA_DE_COMPRAS' },
  });
}, 20000);

test('LZ-01 primeiro claim de oportunidade atribuída cria o estado e já em atendimento', async () => {
  const r = await claimOpportunityHandler(req(U.A, OPP));
  expect(r.estado).toBe('EM_ATENDIMENTO');
  const d = (await db.collection(COLL).doc(OPP).get()).data();
  expect(d.commercialEntityId).toBe(ENT);
  expect(d.tipoOportunidade).toBe('REATIVACAO_120D');
  expect(d.claimAtual.operadorId).toBe(U.A);
  expect(d.eventos.map(e => e.tipo)).toEqual(['CLAIMED']);
}, 15000);

test('LZ-02 oportunidade atribuída a outro vendedor → negado, nada criado', async () => {
  await expect(claimOpportunityHandler(req(U.B, OPP))).rejects.toMatchObject({ code: 'permission-denied' });
  expect((await db.collection(COLL).doc(OPP).get()).exists).toBe(false);
}, 15000);

test('LZ-03 oportunidade fora da worklist do dia → not-found, nada criado', async () => {
  await expect(claimOpportunityHandler(req(U.A, OPP_NAO_ATRIB))).rejects.toMatchObject({ code: 'not-found' });
  expect((await db.collection(COLL).doc(OPP_NAO_ATRIB).get()).exists).toBe(false);
}, 15000);

test('LZ-04 worklist de outro dia não autoriza criação', async () => {
  await setWorklist('2020-01-01', { [OPP]: { uid: U.A, commercialEntityId: ENT, tipoOportunidade: 'REATIVACAO_120D' } });
  await expect(claimOpportunityHandler(req(U.A, OPP))).rejects.toMatchObject({ code: 'not-found' });
  expect((await db.collection(COLL).doc(OPP).get()).exists).toBe(false);
}, 15000);

test('LZ-05 gestão (sem operar) não cria nem opera', async () => {
  await expect(claimOpportunityHandler(req(U.G, OPP))).rejects.toMatchObject({ code: 'permission-denied' });
  expect((await db.collection(COLL).doc(OPP).get()).exists).toBe(false);
}, 15000);

test('LZ-06 duplo clique simultâneo do mesmo vendedor → 1 estado, 1 evento CLAIMED', async () => {
  const rs = await Promise.allSettled([claimOpportunityHandler(req(U.A, OPP)), claimOpportunityHandler(req(U.A, OPP))]);
  expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const d = (await db.collection(COLL).doc(OPP).get()).data();
  expect(d.eventos.filter(e => e.tipo === 'CLAIMED')).toHaveLength(1);
}, 20000);

test('LZ-07 dois vendedores disputando o mesmo ID → só o atribuído vence; 1 estado', async () => {
  const rs = await Promise.allSettled([claimOpportunityHandler(req(U.A, OPP)), claimOpportunityHandler(req(U.B, OPP))]);
  expect(rs.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  const d = (await db.collection(COLL).doc(OPP).get()).data();
  expect(d.claimAtual.operadorId).toBe(U.A);
  expect(d.eventos).toHaveLength(1);
}, 20000);

test('LZ-08 release após criação lazy volta a DISPONIVEL sem apagar o documento', async () => {
  await claimOpportunityHandler(req(U.A, OPP));
  const r = await releaseOpportunityHandler(req(U.A, OPP));
  expect(r.estado).toBe('DISPONIVEL');
  const d = (await db.collection(COLL).doc(OPP).get()).data();
  expect(d.eventos.map(e => e.tipo)).toEqual(['CLAIMED', 'RELEASED']);
}, 15000);

test('LZ-09 canário existente (fora das atribuições) continua operável como antes', async () => {
  await db.collection(COLL).doc(OPP_CANARIO).set(criarEstadoInicial('MR4_LINKED:canarioTesteABCDEFGH', OPP_CANARIO, 'REATIVACAO_120D', new Date().toISOString()));
  const r = await claimOpportunityHandler(req(U.B, OPP_CANARIO));
  expect(r.estado).toBe('EM_ATENDIMENTO');
}, 15000);

test('LZ-10 sem documento de worklist: documento inexistente não é criado', async () => {
  await db.collection('fila_comercial').doc('worklist').delete();
  await expect(claimOpportunityHandler(req(U.A, OPP))).rejects.toMatchObject({ code: 'not-found' });
  expect((await db.collection(COLL).doc(OPP).get()).exists).toBe(false);
}, 15000);

test('LZ-11 documento existente atribuído a outro vendedor → negado (não rouba o card)', async () => {
  await db.collection(COLL).doc(OPP_B).set(criarEstadoInicial('GC_NATIVE:77009999', OPP_B, 'QUEDA_DE_COMPRAS', new Date().toISOString()));
  await expect(claimOpportunityHandler(req(U.A, OPP_B))).rejects.toMatchObject({ code: 'permission-denied' });
}, 15000);
