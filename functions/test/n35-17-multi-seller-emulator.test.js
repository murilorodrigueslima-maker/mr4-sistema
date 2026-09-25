'use strict';
// N35.17 — Prova no EMULADOR: ativar vendedores só por configuração em sistema_usuarios,
// gerando pelo caminho real (carregarDados → Firestore) e com escrita LIVE transacional. PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const G = require('../lib/worklistGenerator');

const quiet = { log() {} };
const NOW = new Date('2026-09-25T09:00:00.000Z');
// uids de TESTE — nenhum deles existe no código da fila
const FAB = 'emu-vendedora-1';
const ADEMIR = 'emu-vendedor-2';
const V3 = 'VENDEDOR_TESTE_03';
const GESTAO = 'emu-gestao';
const FC = { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 };
const VENDAS_PREFIXO = 33300000;
const vendasIds = [];

async function limparWorklist() {
  await db.doc('fila_comercial/worklist').delete();
  await db.doc('fila_comercial/worklist_preview').delete();
}
async function setUser(uid, role, modulos, filaComercial) {
  await db.doc(`users/${uid}`).set({ ativo: true, role });
  const sys = { nome: uid, modulos, admin: false, bloqueado: false };
  if (filaComercial) sys.filaComercial = filaComercial;
  await db.doc(`sistema_usuarios/${uid}`).set(sys);
}
const nome = async gc => 'Cliente Emu ' + gc;
const novas = (doc, uid) => (doc.vendedores[uid] || { novas: [] }).novas.map(x => x.opportunityInstanceId);

beforeAll(async () => {
  // isola do que outras suítes deixaram no emulador
  for (const c of ['sistema_usuarios', 'users']) {
    const s = await db.collection(c).get();
    for (const d of s.docs) if (d.data().filaComercial) await d.ref.update({ filaComercial: admin.firestore.FieldValue.delete() });
  }
  const b = db.batch();
  for (let i = 0; i < 40; i++) {
    const gc = String(VENDAS_PREFIXO + i);
    for (let k = 0; k < 5; k++) {
      const d = new Date(Date.UTC(2026, 2, 5 + (i % 25)) - k * 20 * 86400000).toISOString().slice(0, 10);
      const id = `n3517-${gc}-${k}`;
      vendasIds.push(id);
      b.set(db.doc(`vendas_gc/${id}`), { id, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: '300', cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
    }
  }
  await b.commit();
  await setUser(FAB, 'funcionario', ['fila-comercial', 'fila-comercial-operar'], FC);
  await setUser(ADEMIR, 'funcionario', ['fila-comercial', 'fila-comercial-operar'], null); // tem permissão, sem participação
  await setUser(GESTAO, 'funcionario', ['fila-comercial-gestao'], null);
  await limparWorklist();
}, 60000);

afterAll(async () => {
  const b = db.batch();
  for (const id of vendasIds) b.delete(db.doc(`vendas_gc/${id}`));
  await b.commit();
  for (const uid of [FAB, ADEMIR, V3, GESTAO]) { await db.doc(`users/${uid}`).delete(); await db.doc(`sistema_usuarios/${uid}`).delete(); }
  await limparWorklist();
}, 60000);

beforeEach(limparWorklist);

test('EM-01 estado inicial: só a vendedora configurada recebe worklist; operar sem configuração não participa', async () => {
  const r = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome });
  expect(r.doc.vendedoresAtivos).toEqual([FAB]);
  expect(novas(r.doc, FAB)).toHaveLength(10);
  expect(r.doc.vendedores[ADEMIR]).toBeUndefined();
  expect(r.doc.vendedores[GESTAO]).toBeUndefined();
}, 60000);

test('EM-02 ativar o segundo vendedor = só configuração → listas independentes, sem duplicação', async () => {
  await db.doc(`sistema_usuarios/${ADEMIR}`).update({ filaComercial: FC });
  const r = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome });
  expect(r.doc.vendedoresAtivos.sort()).toEqual([ADEMIR, FAB].sort());
  const a = novas(r.doc, FAB), b = novas(r.doc, ADEMIR);
  expect(a).toHaveLength(10); expect(b).toHaveLength(10);
  expect(a.filter(x => b.includes(x))).toHaveLength(0);
  await db.doc(`sistema_usuarios/${ADEMIR}`).update({ filaComercial: admin.firestore.FieldValue.delete() }); // remove a simulação
}, 60000);

test('EM-03 vendedor fictício novo (VENDEDOR_TESTE_03) recebe worklist só por configuração', async () => {
  await setUser(V3, 'funcionario', ['fila-comercial-operar'], { ...FC, limiteNovasPorDia: 4 });
  const r = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome });
  expect(novas(r.doc, V3)).toHaveLength(4);
  expect(novas(r.doc, FAB)).toHaveLength(10);
  expect(novas(r.doc, V3).filter(x => novas(r.doc, FAB).includes(x))).toHaveLength(0);
  await db.doc(`sistema_usuarios/${V3}`).delete(); await db.doc(`users/${V3}`).delete();
}, 60000);

test('EM-04 pausar vendedor (recebeNovasOportunidades=false) sem remover acesso → 0 novas', async () => {
  await db.doc(`sistema_usuarios/${FAB}`).update({ 'filaComercial.recebeNovasOportunidades': false });
  const r = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome });
  expect(r.doc.vendedoresAtivos).toEqual([FAB]);
  expect(novas(r.doc, FAB)).toHaveLength(0);
  const sys = (await db.doc(`sistema_usuarios/${FAB}`).get()).data();
  expect(sys.modulos).toContain('fila-comercial-operar');
  await db.doc(`sistema_usuarios/${FAB}`).update({ 'filaComercial.recebeNovasOportunidades': true });
}, 60000);

test('MV-12 duas gerações LIVE concorrentes → uma grava, a outra desiste; documento único e consistente', async () => {
  const [r1, r2] = await Promise.all([
    G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome }),
    G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome }),
  ]);
  expect([r1.status, r2.status].sort()).toEqual(['GERADA', 'JA_GERADA_HOJE']);
  const doc = (await db.doc('fila_comercial/worklist').get()).data();
  expect(novas(doc, FAB)).toHaveLength(10);
  expect(new Set(Object.keys(doc.atribuicoes)).size).toBe(Object.keys(doc.atribuicoes).length);
}, 60000);

test('MV-11b retry depois de gravado → JA_GERADA_HOJE, sem regravar', async () => {
  const r1 = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome });
  const t1 = (await db.doc('fila_comercial/worklist').get()).updateTime.toMillis();
  const r2 = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nome });
  const t2 = (await db.doc('fila_comercial/worklist').get()).updateTime.toMillis();
  expect(r1.status).toBe('GERADA'); expect(r2.status).toBe('JA_GERADA_HOJE'); expect(t2).toBe(t1);
}, 60000);
