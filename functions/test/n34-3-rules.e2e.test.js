'use strict';

/**
 * N34.3 — Testes de Regras Firestore para fila_comercial (8 cenários)
 *
 * Prova os 8 cenários de autorização para a coleção fila_comercial:
 *   FC-01  Não autenticado → read → FAILS
 *   FC-02  Funcionário (role≠gestor) → read → FAILS
 *   FC-03  Gestor sem doc sistema_usuarios → read → FAILS
 *   FC-04  Gestor com modulos=[] (sem fila-comercial) → read → FAILS
 *   FC-05  Gestor com modulos=['fila-comercial'] → read → SUCCEEDS
 *   FC-06  Gestor com admin=true → read → SUCCEEDS
 *   FC-07  Gestor com fila-comercial → write → FAILS (write: false)
 *   FC-08  Gestor admin → write → FAILS (write: false)
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore
 *   (porta padrão: 8080)
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=n34-3-rules
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

let testEnv;

// ─── UIDs de teste ─────────────────────────────────────────────────────────────

const UID_GESTOR_COM_MODULO = 'fc-gestor-com-modulo';  // role=gestor + modulos=['fila-comercial']
const UID_GESTOR_ADMIN      = 'fc-gestor-admin';        // role=gestor + admin=true + modulos=[]
const UID_GESTOR_SEM        = 'fc-gestor-sem-fc';       // role=gestor + modulos=['ponto'] (sem fila-comercial)
const UID_GESTOR_SEM_SYSDOC = 'fc-gestor-sem-sysdoc';  // role=gestor + SEM doc sistema_usuarios
const UID_FUNC              = 'fc-funcionario';         // role=funcionario (não é gestor)

// ─── Seed ──────────────────────────────────────────────────────────────────────

async function seedAll(db) {
  // users
  await db.collection('users').doc(UID_GESTOR_COM_MODULO).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_GESTOR_ADMIN).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_GESTOR_SEM).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_GESTOR_SEM_SYSDOC).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_FUNC).set({ role: 'funcionario', ativo: true, funcionarioId: 'fc-func-001' });

  // sistema_usuarios
  await db.collection('sistema_usuarios').doc(UID_GESTOR_COM_MODULO).set({
    admin: false, modulos: ['fila-comercial'],
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_ADMIN).set({
    admin: true, modulos: [],
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_SEM).set({
    admin: false, modulos: ['ponto', 'expedicao'],  // sem 'fila-comercial'
  });
  await db.collection('sistema_usuarios').doc(UID_FUNC).set({
    admin: false, modulos: ['fila-comercial'],  // tem o módulo, mas role≠gestor
  });
  // UID_GESTOR_SEM_SYSDOC: propositalmente sem doc em sistema_usuarios

  // Documento de snapshot para leitura
  await db.collection('fila_comercial').doc('snapshot').set({
    schemaVersion: 'v1',
    pipelineVersion: 'N34.3-test',
    clientesHoje: [],
    clientesProximos: [],
    metadata: { totalHoje: 0, totalProximos: 0, totalProcessados: 2, windowDays: 7 },
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host:  'localhost',
      port:  8080,
    },
  });
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedAll(ctx.firestore());
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

const db = uid => uid
  ? testEnv.authenticatedContext(uid).firestore()
  : testEnv.unauthenticatedContext().firestore();

// ─── FC-01: Não autenticado → read → FAILS ────────────────────────────────────

test('FC-01: unauthenticated cannot read fila_comercial/snapshot', async () => {
  const ref = db(null).collection('fila_comercial').doc('snapshot');
  await assertFails(ref.get());
});

// ─── FC-02: Funcionário (role≠gestor) → read → FAILS ─────────────────────────

test('FC-02: funcionario (role≠gestor) cannot read fila_comercial/snapshot', async () => {
  const ref = db(UID_FUNC).collection('fila_comercial').doc('snapshot');
  await assertFails(ref.get());
});

// ─── FC-03: Gestor sem doc sistema_usuarios → read → FAILS ───────────────────

test('FC-03: gestor without sistema_usuarios doc cannot read fila_comercial/snapshot', async () => {
  const ref = db(UID_GESTOR_SEM_SYSDOC).collection('fila_comercial').doc('snapshot');
  await assertFails(ref.get());
});

// ─── FC-04: Gestor com modulos sem fila-comercial → read → FAILS ─────────────

test('FC-04: gestor with modulos=[ponto] (no fila-comercial) cannot read', async () => {
  const ref = db(UID_GESTOR_SEM).collection('fila_comercial').doc('snapshot');
  await assertFails(ref.get());
});

// ─── FC-05: Gestor com modulos=['fila-comercial'] → read → SUCCEEDS ──────────

test('FC-05: gestor with modulos=[fila-comercial] CAN read fila_comercial/snapshot', async () => {
  const ref = db(UID_GESTOR_COM_MODULO).collection('fila_comercial').doc('snapshot');
  await assertSucceeds(ref.get());
});

// ─── FC-06: Gestor com admin=true → read → SUCCEEDS ──────────────────────────

test('FC-06: gestor with admin=true CAN read fila_comercial/snapshot', async () => {
  const ref = db(UID_GESTOR_ADMIN).collection('fila_comercial').doc('snapshot');
  await assertSucceeds(ref.get());
});

// ─── FC-07: Gestor com fila-comercial → write → FAILS (write: false) ─────────

test('FC-07: gestor with fila-comercial module cannot WRITE (write: if false)', async () => {
  const ref = db(UID_GESTOR_COM_MODULO).collection('fila_comercial').doc('snapshot');
  await assertFails(ref.set({ schemaVersion: 'v1', clientesHoje: [], clientesProximos: [] }));
});

// ─── FC-08: Gestor admin → write → FAILS (write: false) ──────────────────────

test('FC-08: gestor admin cannot WRITE (write: if false — Admin SDK only)', async () => {
  const ref = db(UID_GESTOR_ADMIN).collection('fila_comercial').doc('snapshot');
  await assertFails(ref.set({ schemaVersion: 'v1', clientesHoje: [], clientesProximos: [] }));
});
