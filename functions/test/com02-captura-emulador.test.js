'use strict';
// COM-02 — callable registerOutcome com a captura mínima. EMULADOR (localhost:8080). PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const C = require('../lib/canaryCallable');
jest.setTimeout(60000);

const UID = 'com02-vendedor', OPPS = ['c002000000000001', 'c002000000000002', 'c002000000000003', 'c002000000000004'];
const agora = { now: () => new Date('2026-11-26T13:00:00.000Z') };
const req = data => ({ auth: { uid: UID }, data });
const erro = p => p.then(() => 'OK', e => e.code + ':' + e.message);
const emAtendimento = opp => db.doc('interacoes_fila/' + opp).set({ commercialEntityId: 'GC_NATIVE:99200001', opportunityInstanceId: opp, tipoOportunidade: 'JANELA_DE_RECOMPRA', estado: 'EM_ATENDIMENTO',
  criadoEm: '2026-11-26T12:55:00.000Z', atualizadoEm: '2026-11-26T12:55:00.000Z', claimAtual: { operadorId: UID, claimadoEm: '2026-11-26T12:55:00.000Z' }, cooledUntil: null, nextFollowUpAt: null,
  eventos: [{ tipo: 'CLAIMED', operadorId: UID, timestamp: '2026-11-26T12:55:00.000Z' }] });
const ler = async opp => (await db.doc('interacoes_fila/' + opp).get()).data();

beforeAll(async () => {
  await db.doc('users/' + UID).set({ role: 'funcionario', ativo: true });
  await db.doc('sistema_usuarios/' + UID).set({ nome: 'Vendedor Teste', bloqueado: false, modulos: ['fila-comercial-operar'] });
});
beforeEach(async () => { for (const o of OPPS) await emAtendimento(o); });
afterAll(async () => { for (const o of OPPS) await db.doc('interacoes_fila/' + o).delete(); await db.doc('users/' + UID).delete(); await db.doc('sistema_usuarios/' + UID).delete(); });

test('payload antigo (sem captura) continua aceito e sem meta nova', async () => {
  const r = await C.registerOutcomeHandler(req({ opportunityInstanceId: OPPS[0], outcome: 'CONVERSA_REALIZADA' }), agora);
  expect(r).toMatchObject({ estado: 'CONCLUIDA', outcome: 'CONVERSA_REALIZADA' });
  expect((await ler(OPPS[0])).eventos[1].meta).toBeUndefined();
});
test('grava interesse e proposta no evento; retry com o mesmo requestId não duplica nem altera', async () => {
  const data = { opportunityInstanceId: OPPS[1], outcome: 'CONVERSA_REALIZADA', interesse: 'SIM', proposta: 'SIM', requestId: 'com02-req-0001' };
  await C.registerOutcomeHandler(req(data), agora);
  const r = await C.registerOutcomeHandler(req({ ...data, proposta: 'NAO' }), agora);
  expect(r.repetido).toBe(true);
  const d = await ler(OPPS[1]);
  expect(d.eventos).toHaveLength(2);
  expect(d.eventos[1].meta).toEqual({ interesse: 'SIM', proposta: 'SIM', requestId: 'com02-req-0001' });
});
test('inválido ou incompatível → invalid-argument e NADA é gravado', async () => {
  for (const extra of [{ interesse: 'TALVEZ' }, { proposta: true }, { outcome: 'SEM_RESPOSTA', interesse: 'SIM' }, { valorProposta: 100 }]) {
    expect(await erro(C.registerOutcomeHandler(req({ opportunityInstanceId: OPPS[2], outcome: 'CONVERSA_REALIZADA', ...extra }), agora))).toMatch(/^invalid-argument:/);
  }
  expect(await ler(OPPS[2])).toMatchObject({ estado: 'EM_ATENDIMENTO' });
  expect((await ler(OPPS[2])).eventos).toHaveLength(1);
});
test('captura não altera cooldown de "sem interesse" nem escreve fora da fila', async () => {
  const antes = (await db.collection('carteira_comercial').count().get()).data().count;
  const r = await C.registerOutcomeHandler(req({ opportunityInstanceId: OPPS[3], outcome: 'SEM_INTERESSE_AGORA', proposta: 'SIM' }), agora);
  expect(r.cooledUntil).toBe('2026-12-26T13:00:00.000Z');
  expect((await db.collection('carteira_comercial').count().get()).data().count).toBe(antes);
});
