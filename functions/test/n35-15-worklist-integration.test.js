'use strict';
// N35.15 — Integração no EMULADOR: gerador LIVE → claim lazy → outcome → regeneração. PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();

const G = require('../lib/worklistGenerator');
const { claimOpportunityHandler, registerOutcomeHandler, releaseOpportunityHandler } = require('../lib/canaryCallable');
const { dataComercial, proximoDiaUtil } = require('../lib/filaOperacional');

const FAB = 'UGXinD3KVXX0ouYEfamBWjizC5C2';
const ADEMIR = 'G9JDOBsquwdth77qgwtXpcjSxYd2';
const quiet = { log() {} };
const req = (uid, data) => ({ auth: { uid }, data });

function vendas(prefixo, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const gc = String(prefixo + i);
    for (let k = 0; k < 5; k++) {
      const d = new Date(Date.UTC(2026, 2, 10 + (i % 15)) - k * 20 * 86400000).toISOString().slice(0, 10);
      out.push({ id: gc + 'v' + k, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: '300', cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
    }
  }
  return out;
}
async function estadosAtuais() {
  const s = await db.collection('interacoes_fila').get();
  return new Map(s.docs.map(d => [d.id, d.data()]));
}
function dados(estados) {
  return {
    perfis: [], clientes: [], vendas: vendas(88800000, 20), estados,
    users: new Map([[FAB, { ativo: true, role: 'funcionario' }]]),
    sistema: new Map([[FAB, { modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }]]),
  };
}
const nome = async gc => 'Cliente Emu ' + gc;
let hojeDoc;
let idsGerados = [];

beforeAll(async () => {
  await db.doc(`users/${FAB}`).set({ ativo: true, role: 'funcionario', email: 'fab@test.local' });
  await db.doc(`sistema_usuarios/${FAB}`).set({ nome: 'Fabiana Teste', modulos: ['fila-comercial-operar'], admin: false });
  await db.doc(`users/${ADEMIR}`).set({ ativo: true, role: 'funcionario', email: 'ademir@test.local' });
  await db.doc(`sistema_usuarios/${ADEMIR}`).set({ nome: 'Ademir Teste', modulos: ['fila-comercial-operar'], admin: false });
  await db.doc('fila_comercial/worklist').delete();
  await db.doc('fila_comercial/worklist_preview').delete();
}, 30000);

afterAll(async () => {
  for (const id of idsGerados) await db.doc(`interacoes_fila/${id}`).delete();
  await db.doc('fila_comercial/worklist').delete();
  await db.doc('fila_comercial/worklist_preview').delete();
  for (const uid of [FAB, ADEMIR]) { await db.doc(`users/${uid}`).delete(); await db.doc(`sistema_usuarios/${uid}`).delete(); }
}, 30000);

test('IT-01 geração LIVE grava 1 documento e ZERO interacoes_fila', async () => {
  const antes = (await db.collection('interacoes_fila').get()).size;
  const r = await G.executarGeracaoWorklist({ db, now: new Date(), mode: 'LIVE', logger: quiet, lookupNome: nome, dados: dados(await estadosAtuais()) });
  expect(r.status).toBe('GERADA');
  hojeDoc = (await db.doc('fila_comercial/worklist').get()).data();
  idsGerados = Object.keys(hojeDoc.atribuicoes);
  expect(hojeDoc.vendedores[FAB].novas).toHaveLength(10);
  expect((await db.collection('interacoes_fila').get()).size).toBe(antes);
  for (const it of hojeDoc.vendedores[FAB].novas) expect((await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).exists).toBe(false);
}, 30000);

test('IT-02 leitura repetida (refresh) não cria documento operacional', async () => {
  const antes = (await db.collection('interacoes_fila').get()).size;
  for (let i = 0; i < 3; i++) await db.doc('fila_comercial/worklist').get();
  for (const it of hojeDoc.vendedores[FAB].novas) expect((await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).exists).toBe(false);
  expect((await db.collection('interacoes_fila').get()).size).toBe(antes);
}, 20000);

test('IT-03 primeiro claim cria o estado com nome de exibição', async () => {
  const it = hojeDoc.vendedores[FAB].novas[0];
  const r = await claimOpportunityHandler(req(FAB, { opportunityInstanceId: it.opportunityInstanceId }));
  expect(r.estado).toBe('EM_ATENDIMENTO');
  const d = (await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).data();
  expect(d.nomeCliente).toBe(it.nomeCliente);
  expect(d.commercialEntityId).toBe(it.commercialEntityId);
}, 20000);

test('IT-04 Ademir (não ativo) não consegue criar/operar item da Fabiana', async () => {
  const it = hojeDoc.vendedores[FAB].novas[1];
  await expect(claimOpportunityHandler(req(ADEMIR, { opportunityInstanceId: it.opportunityInstanceId }))).rejects.toMatchObject({ code: 'permission-denied' });
  expect((await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).exists).toBe(false);
}, 20000);

test('IT-05 duplo clique simultâneo → 1 estado, 1 CLAIMED, 1 dono', async () => {
  const it = hojeDoc.vendedores[FAB].novas[2];
  const rs = await Promise.allSettled([1, 2, 3].map(() => claimOpportunityHandler(req(FAB, { opportunityInstanceId: it.opportunityInstanceId }))));
  expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const d = (await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).data();
  expect(d.eventos.filter(e => e.tipo === 'CLAIMED')).toHaveLength(1);
  expect(d.claimAtual.operadorId).toBe(FAB);
}, 30000);

test('IT-06 SEM_RESPOSTA → nextFollowUpAt = próximo dia útil, mesmo dono do último outcome', async () => {
  const it = hojeDoc.vendedores[FAB].novas[0];
  const r = await registerOutcomeHandler(req(FAB, { opportunityInstanceId: it.opportunityInstanceId, outcome: 'SEM_RESPOSTA' }));
  expect(r.nextFollowUpAt).toBe(proximoDiaUtil(dataComercial(new Date().toISOString())));
  const d = (await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).data();
  expect(d.eventos.filter(e => e.tipo === 'OUTCOME_REGISTERED').slice(-1)[0].operadorId).toBe(FAB);
}, 20000);

test('IT-07 regeneração no mesmo dia durante atendimento → no-op, atribuições e claim intactos', async () => {
  const r = await G.executarGeracaoWorklist({ db, now: new Date(), mode: 'LIVE', logger: quiet, lookupNome: nome, dados: dados(await estadosAtuais()) });
  expect(r.status).toBe('JA_GERADA_HOJE');
  const depois = (await db.doc('fila_comercial/worklist').get()).data();
  expect(depois.atribuicoes).toEqual(hojeDoc.atribuicoes);
  const claimado = (await db.doc(`interacoes_fila/${hojeDoc.vendedores[FAB].novas[2].opportunityInstanceId}`).get()).data();
  expect(claimado.estado).toBe('EM_ATENDIMENTO');
}, 30000);

test('IT-08 próximo dia útil: SEM_RESPOSTA volta como retorno da Fabiana (fora do CAP), com o nome do estado', async () => {
  const it = hojeDoc.vendedores[FAB].novas[0];
  const proxDia = proximoDiaUtil(dataComercial(new Date().toISOString()));
  const r = await G.executarGeracaoWorklist({ db: null, now: new Date(proxDia + 'T09:00:00.000Z'), mode: 'LIVE', logger: quiet, lookupNome: async () => null, dados: dados(await estadosAtuais()) });
  const f = r.doc.vendedores[FAB].followUps.map(x => [x.opportunityInstanceId, x.nomeCliente]);
  expect(f).toContainEqual([it.opportunityInstanceId, it.nomeCliente]);
  expect(r.doc.vendedores[FAB].novas.map(x => x.commercialEntityId)).not.toContain(it.commercialEntityId);
}, 30000);

test('IT-09 release devolve a Disponível sem apagar histórico', async () => {
  const it = hojeDoc.vendedores[FAB].novas[2];
  const r = await releaseOpportunityHandler(req(FAB, { opportunityInstanceId: it.opportunityInstanceId }));
  expect(r.estado).toBe('DISPONIVEL');
  const d = (await db.doc(`interacoes_fila/${it.opportunityInstanceId}`).get()).data();
  expect(d.eventos.map(e => e.tipo)).toEqual(['CLAIMED', 'RELEASED']);
}, 20000);

test('IT-10 DRY_RUN grava só preview e NÃO habilita criação lazy', async () => {
  await db.doc('fila_comercial/worklist').delete();
  await G.executarGeracaoWorklist({ db, now: new Date(), mode: 'DRY_RUN', logger: quiet, lookupNome: nome, dados: dados(await estadosAtuais()) });
  const prev = (await db.doc('fila_comercial/worklist_preview').get()).data();
  const alvo = prev.vendedores[FAB].novas.find(x => !idsGerados.includes(x.opportunityInstanceId)) || prev.vendedores[FAB].novas[5];
  const existia = (await db.doc(`interacoes_fila/${alvo.opportunityInstanceId}`).get()).exists;
  if (!existia) {
    await expect(claimOpportunityHandler(req(FAB, { opportunityInstanceId: alvo.opportunityInstanceId }))).rejects.toMatchObject({ code: 'not-found' });
    expect((await db.doc(`interacoes_fila/${alvo.opportunityInstanceId}`).get()).exists).toBe(false);
  }
  idsGerados.push(...Object.keys(prev.atribuicoes));
}, 30000);
