'use strict';
// N35.18.1 — Ownership entre dias no EMULADOR, pelo caminho real (carregarDados lê a worklist LIVE anterior
// do Firestore; escrita LIVE transacional). PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const G = require('../lib/worklistGenerator');

const quiet = { log() {} };
const D0 = new Date('2026-09-25T09:00:00.000Z');
const D1 = new Date('2026-09-28T09:00:00.000Z');
const A = 'emu-own-a', B = 'emu-own-b';
const FC = { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 };
const VENDAS_PREFIXO = 77700000;
const vendasIds = [];
const nome = async gc => 'Cliente Emu ' + gc;
const gerar = now => G.executarGeracaoWorklist({ db, now, mode: 'LIVE', logger: quiet, lookupNome: nome });
const ids = (doc, uid, g = 'novas') => ((doc.vendedores[uid] || {})[g] || []).map(x => x.opportunityInstanceId);
const lerLive = async () => (await db.doc('fila_comercial/worklist').get()).data();

function auditar(doc) {
  const opp = new Map(); let dup = 0, colisao = 0;
  for (const uid of doc.vendedoresAtivos) for (const g of ['novas', 'pendentes', 'followUps', 'emAtendimento']) for (const x of doc.vendedores[uid][g]) {
    if (opp.has(x.opportunityInstanceId)) { dup++; if (opp.get(x.opportunityInstanceId) !== uid) colisao++; }
    opp.set(x.opportunityInstanceId, uid);
  }
  const atribOk = Object.keys(doc.atribuicoes).length === opp.size && [...opp].every(([o, u]) => doc.atribuicoes[o].uid === u);
  return { dup, colisao, atribOk };
}

let doc0;
beforeAll(async () => {
  for (const c of ['sistema_usuarios', 'users']) {
    const s = await db.collection(c).get();
    for (const d of s.docs) if (d.data().filaComercial) await d.ref.update({ filaComercial: admin.firestore.FieldValue.delete() });
  }
  const b = db.batch();
  for (let i = 0; i < 60; i++) {
    const gc = String(VENDAS_PREFIXO + i);
    for (let k = 0; k < 5; k++) {
      const d = new Date(Date.UTC(2026, 2, 5 + (i % 25)) - k * 20 * 86400000).toISOString().slice(0, 10);
      const id = `n35181-${gc}-${k}`;
      vendasIds.push(id);
      b.set(db.doc(`vendas_gc/${id}`), { id, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: '300', cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
    }
  }
  await b.commit();
  for (const uid of [A, B]) {
    await db.doc(`users/${uid}`).set({ ativo: true, role: 'funcionario' });
    await db.doc(`sistema_usuarios/${uid}`).set({ nome: uid, modulos: ['fila-comercial', 'fila-comercial-operar'], admin: false, bloqueado: false, filaComercial: FC });
  }
  await db.doc('fila_comercial/worklist').delete();
  const r0 = await gerar(D0);
  expect(r0.status).toBe('GERADA');
  doc0 = await lerLive();
}, 60000);

afterAll(async () => {
  const b = db.batch();
  for (const id of vendasIds) b.delete(db.doc(`vendas_gc/${id}`));
  await b.commit();
  for (const uid of [A, B]) { await db.doc(`users/${uid}`).delete(); await db.doc(`sistema_usuarios/${uid}`).delete(); }
  await db.doc('fila_comercial/worklist').delete();
  await db.doc('fila_comercial/worklist_preview').delete();
}, 60000);

beforeEach(async () => { await db.doc('fila_comercial/worklist').set(doc0); }); // sempre parte da sexta gravada

test('OW-15-EMU troca de data pelo caminho real: a worklist anterior lida do Firestore mantém os donos', async () => {
  const r = await gerar(D1);
  expect(r.status).toBe('GERADA');
  const doc = await lerLive();
  expect(doc.dataReferencia).toBe('2026-09-28');
  expect(ids(doc, A, 'pendentes').sort()).toEqual(ids(doc0, A).sort());
  expect(ids(doc, B, 'pendentes').sort()).toEqual(ids(doc0, B).sort());
  for (const [opp, a] of Object.entries(doc0.atribuicoes)) expect(doc.atribuicoes[opp].uid).toBe(a.uid);
  expect(ids(doc, A)).toHaveLength(10);
  expect(ids(doc, B)).toHaveLength(10);
  expect(auditar(doc)).toEqual({ dup: 0, colisao: 0, atribOk: true });
}, 60000);

test('OW-13 duas gerações concorrentes: 1 escritor, sem duplicidade, sem colisão de ownership, sem worklist parcial', async () => {
  const [r1, r2] = await Promise.all([gerar(D1), gerar(D1)]);
  expect([r1.status, r2.status].sort()).toEqual(['GERADA', 'JA_GERADA_HOJE']);
  const doc = await lerLive();
  const vencedor = r1.status === 'GERADA' ? r1.doc : r2.doc;
  expect(JSON.stringify(doc)).toBe(JSON.stringify(vencedor));
  expect(auditar(doc)).toEqual({ dup: 0, colisao: 0, atribOk: true });
  expect(doc.vendedoresAtivos).toEqual([A, B]);
  for (const uid of [A, B]) { expect(ids(doc, uid)).toHaveLength(10); expect(ids(doc, uid, 'pendentes')).toHaveLength(10); }
  for (const [opp, a] of Object.entries(doc0.atribuicoes)) expect(doc.atribuicoes[opp].uid).toBe(a.uid);
}, 60000);

test('OW-14 execução repetida no mesmo dia é idempotente (documento intacto)', async () => {
  await gerar(D1);
  const antes = JSON.stringify(await lerLive());
  const r = await gerar(D1);
  expect(r.status).toBe('JA_GERADA_HOJE');
  expect(JSON.stringify(await lerLive())).toBe(antes);
}, 60000);
