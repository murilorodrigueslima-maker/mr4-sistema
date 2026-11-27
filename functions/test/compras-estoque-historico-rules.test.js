'use strict';
// HISTÓRICO DE ESTOQUE — Rules (EMULADOR): operacional (módulo estoque) × capital (gestor) × interno (ninguém); escrita negada.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
jest.setTimeout(60000);
let env;
const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
const PERFIS = {
  admin:            { users: { role: 'gestor', ativo: true }, sys: { modulos: [], admin: true } },
  gestorComEstoque: { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'] } },
  gestorSemEstoque: { users: { role: 'gestor', ativo: true }, sys: { modulos: ['vendas'] } },
  funcComEstoque:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['estoque'] } },
  funcSemEstoque:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['ponto'] } },
  bloqueado:        { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'], admin: true, bloqueado: true } },
  inativo:          { users: { role: 'funcionario', ativo: false }, sys: { modulos: ['estoque'] } },
};
const OPERACIONAL = ['resumo', 'produtos', 'estado'];
const GESTOR = ['resumo_valor', 'valor_2026-09-28'];
const NINGUEM = ['custos_vigentes', 'outro', 'valor_tudo'];
const LE_OPER = { admin: true, gestorComEstoque: true, funcComEstoque: true };
const LE_VALOR = { admin: true, gestorComEstoque: true };

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host, port: Number(port) } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    for (const [uid, p] of Object.entries(PERFIS)) { await db.doc('users/' + uid).set(p.users); await db.doc('sistema_usuarios/' + uid).set(p.sys); }
    for (const id of [...OPERACIONAL, ...GESTOR, ...NINGUEM]) await db.doc('estoque_historico/' + id).set({ fixture: true });
  });
});
afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });

const ler = (uid, id) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore().doc('estoque_historico/' + id).get();

test.each([...OPERACIONAL, ...GESTOR, ...NINGUEM])('anônimo não lê %s', async id => { await assertFails(ler(null, id)); });
for (const uid of Object.keys(PERFIS)) {
  for (const id of OPERACIONAL) test(`${uid} ${LE_OPER[uid] ? 'LÊ' : 'NÃO lê'} operacional ${id}`, async () => { await (LE_OPER[uid] ? assertSucceeds : assertFails)(ler(uid, id)); });
  for (const id of GESTOR) test(`${uid} ${LE_VALOR[uid] ? 'LÊ' : 'NÃO lê'} capital ${id}`, async () => { await (LE_VALOR[uid] ? assertSucceeds : assertFails)(ler(uid, id)); });
  for (const id of NINGUEM) test(`${uid} NÃO lê interno ${id}`, async () => { await assertFails(ler(uid, id)); });
}
test('ninguém escreve nem lista (nem admin)', async () => {
  const db = env.authenticatedContext('admin').firestore();
  for (const id of [...OPERACIONAL, ...GESTOR, ...NINGUEM]) await assertFails(db.doc('estoque_historico/' + id).set({ x: 1 }));
  await assertFails(db.doc('estoque_historico/resumo').delete());
  await assertFails(db.collection('estoque_historico').get());
});

// Ponta a ponta no emulador (Admin SDK real): o lote do histórico é aceito pelo Firestore e a leitura segue o menor privilégio.
describe('consolidação no emulador', () => {
  test('dois dias de sync gravam fluxos e agregados; funcionário lê o operacional e não o capital', async () => {
    const admin = require('firebase-admin');
    const S = require('../lib/compras/snapshot');
    const X = require('./fixtures/compras-estoque-f0');
    const G = require('./fixtures/compras-gc-falso');
    const anterior = process.env.FIRESTORE_EMULATOR_HOST;
    process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`;
    const app = admin.initializeApp({ projectId: 'mr4-ponto' }, 'historico-e2e-' + Date.now());
    try {
      await env.clearFirestore();
      await env.withSecurityRulesDisabled(async c => { const f = c.firestore(); for (const [uid, p] of Object.entries(PERFIS)) { await f.doc('users/' + uid).set(p.users); await f.doc('sistema_usuarios/' + uid).set(p.sys); } });
      const db = app.firestore();
      const fonte = q => ({ produtos: [X.produto('PA', { estoque: q })], vendas: [X.venda('2026-09-28', [['PA', 3]])], compras: [X.compra('2026-09-20', [['PA', 5]])] });
      for (const [agora, q] of [[new Date('2026-09-27T23:00:00Z'), 10], [new Date('2026-09-28T23:00:00Z'), 7], [new Date('2026-09-29T06:15:00Z'), 7]]) {
        const r = await S.executarSync({ cli: G.criarGcFalso(fonte(q)).cli, db, agora });
        expect(r.erro || null).toBeNull();
        expect(r.snapshot.persistencia.historico.ok).toBe(true);
      }
      expect((await db.doc('estoque_snapshots/2026-09-28').get()).data().fluxo).toMatchObject({ vendas_un: 3, produtos_com_ajuste: 0 });
      await assertSucceeds(ler('funcComEstoque', 'resumo'));
      await assertSucceeds(ler('gestorComEstoque', 'valor_2026-09-28'));
      await assertFails(ler('funcComEstoque', 'valor_2026-09-28'));
    } finally {
      await app.delete();
      if (anterior === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = anterior;
    }
  });
});
