'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · Rules (EMULADOR): operacional × custo, escrita negada a todos.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
jest.setTimeout(60000);
let env;
const PERFIS = {
  admin:            { users: { role: 'gestor', ativo: true }, sys: { modulos: [], admin: true } },
  gestorComEstoque: { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'] } },
  gestorSemEstoque: { users: { role: 'gestor', ativo: true }, sys: { modulos: ['vendas'] } },
  funcComEstoque:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['estoque'] } },
  funcSemEstoque:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['ponto'] } },
  bloqueado:        { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'], admin: true, bloqueado: true } },
  inativo:          { users: { role: 'funcionario', ativo: false }, sys: { modulos: ['estoque'] } },
};
const OPERACIONAL = [['compras_n0', 'resumo'], ['compras_n0', 'meta'], ['compras_n0_produtos', 'bloco_000'], ['estoque_snapshots', '2026-09-28']];
const CUSTO = [['compras_n0_custos', 'bloco_000']];
const LE_OPER = { admin: true, gestorComEstoque: true, funcComEstoque: true };
const LE_CUSTO = { admin: true, gestorComEstoque: true };   // funcionário com estoque NÃO vê custo

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    for (const [uid, p] of Object.entries(PERFIS)) { await db.doc('users/' + uid).set(p.users); if (p.sys) await db.doc('sistema_usuarios/' + uid).set(p.sys); }
    for (const [col, id] of [...OPERACIONAL, ...CUSTO]) await db.doc(`${col}/${id}`).set({ fixture: true });
    await db.doc('compras_n0/auditoria_interna').set({ fixture: true });
    await db.doc('compras_n0_base/v_000').set({ fixture: true });
    await db.doc('estoque_snapshots/indice').set({ fixture: true });
    for (const d of ['compras_n0_view/sugestoes', 'compras_n0_view/custos', 'compras_n0_view/outro', 'compras_n0_runs/20260929T000000Z-full-abc123', 'compras_n0/lock']) await db.doc(d).set({ fixture: true });
  });
});
afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });

describe('PERMISSION_MATRIX (backend)', () => {
  test.each([...OPERACIONAL, ...CUSTO])('ANÔNIMO não lê %s/%s', async (col, id) => { await assertFails(env.unauthenticatedContext().firestore().doc(`${col}/${id}`).get()); });
  for (const uid of Object.keys(PERFIS)) {
    for (const [col, id] of OPERACIONAL) test(`${uid} ${LE_OPER[uid] ? 'LÊ' : 'NÃO lê'} operacional ${col}/${id}`, async () => {
      const op = env.authenticatedContext(uid).firestore().doc(`${col}/${id}`).get(); await (LE_OPER[uid] ? assertSucceeds(op) : assertFails(op));
    });
    for (const [col, id] of CUSTO) test(`${uid} ${LE_CUSTO[uid] ? 'LÊ' : 'NÃO lê'} CUSTO ${col}/${id}`, async () => {
      const op = env.authenticatedContext(uid).firestore().doc(`${col}/${id}`).get(); await (LE_CUSTO[uid] ? assertSucceeds(op) : assertFails(op));
    });
  }
  test('ninguém escreve (nem admin) e docId fora da lista é negado', async () => {
    const db = env.authenticatedContext('admin').firestore();
    await assertFails(db.doc('compras_n0/resumo').set({ x: 1 }));
    await assertFails(db.doc('compras_n0_produtos/bloco_000').update({ x: 1 }));
    await assertFails(db.doc('compras_n0_custos/bloco_000').delete());
    await assertFails(db.doc('estoque_snapshots/2026-09-29').set({ x: 1 }));
    await assertFails(db.doc('compras_n0/auditoria_interna').get());
  });
  test('base do incremental (compras_n0_base): ninguém lê nem escreve — nem admin, nem gestor com estoque', async () => {
    for (const uid of Object.keys(PERFIS)) await assertFails(env.authenticatedContext(uid).firestore().doc('compras_n0_base/v_000').get());
    await assertFails(env.authenticatedContext('admin').firestore().doc('compras_n0_base/v_000').set({ x: 1 }));
    await assertFails(env.unauthenticatedContext().firestore().doc('compras_n0_base/v_000').get());
  });
  const LE_VIEW = { admin: true, gestorComEstoque: true, funcComEstoque: true };
  const LE_GESTOR = { admin: true, gestorComEstoque: true };
  for (const uid of Object.keys(PERFIS)) {
    test(`${uid} ${LE_VIEW[uid] ? 'LÊ' : 'NÃO lê'} a visão operacional da tela (compras_n0_view/sugestoes)`, async () => {
      const op = env.authenticatedContext(uid).firestore().doc('compras_n0_view/sugestoes').get(); await (LE_VIEW[uid] ? assertSucceeds(op) : assertFails(op));
    });
    test(`${uid} ${LE_GESTOR[uid] ? 'LÊ' : 'NÃO lê'} custos da tela e registro de execuções`, async () => {
      const db = env.authenticatedContext(uid).firestore();
      await (LE_GESTOR[uid] ? assertSucceeds(db.doc('compras_n0_view/custos').get()) : assertFails(db.doc('compras_n0_view/custos').get()));
      await (LE_GESTOR[uid] ? assertSucceeds(db.doc('compras_n0_runs/20260929T000000Z-full-abc123').get()) : assertFails(db.doc('compras_n0_runs/20260929T000000Z-full-abc123').get()));
    });
  }
  test('tela/execuções: anônimo não lê; ninguém escreve; docId fora da lista e trava negados', async () => {
    const an = env.unauthenticatedContext().firestore();
    for (const d of ['compras_n0_view/sugestoes', 'compras_n0_view/custos', 'compras_n0_runs/20260929T000000Z-full-abc123']) await assertFails(an.doc(d).get());
    const adm = env.authenticatedContext('admin').firestore();
    await assertFails(adm.doc('compras_n0_view/sugestoes').set({ x: 1 })); await assertFails(adm.doc('compras_n0_runs/x').set({ x: 1 }));
    await assertFails(adm.doc('compras_n0_view/outro').get()); await assertFails(adm.doc('compras_n0/lock').get()); await assertFails(adm.doc('compras_n0/lock').set({ x: 1 }));
  });
  test('estoque_snapshots só aceita docId de data (YYYY-MM-DD)', async () => {
    await assertSucceeds(env.authenticatedContext('funcComEstoque').firestore().doc('estoque_snapshots/2026-09-28').get());
    await assertFails(env.authenticatedContext('admin').firestore().doc('estoque_snapshots/indice').get());
  });
});
