'use strict';

/**
 * RULE360-01 → RULE360-10
 * Testa Firestore Rules para as coleções do Perfil360:
 *   perfis_360  — gestor lê, ninguém escreve via frontend
 *   vendas_gc   — ninguém lê ou escreve via frontend
 *   sync_state  — ninguém lê ou escreve via frontend
 *   clientes    — regras existentes não regridem (09)
 *   gestaoClickId — proteção existente não regride (10)
 *
 * Pré-requisito: Firebase emulators rodando (firestore na porta 8080).
 *   cd functions && npm test -- --testPathPattern=rules360
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

const UID_GESTOR = 'uid-r360-gestor';
const UID_FUNC   = 'uid-r360-func';

let testEnv;

const SEED = async (db) => {
  await db.collection('users').doc(UID_GESTOR).set({
    role: 'gestor', ativo: true, nome: 'Gestor R360',
  });
  await db.collection('users').doc(UID_FUNC).set({
    role: 'funcionario', ativo: true, nome: 'Func R360',
  });
  // perfil360 existente para testes de leitura
  await db.collection('perfis_360').doc('cliente-r360-001').set({
    clienteMr4Id: 'cliente-r360-001',
    gestaoClickId: '9001',
    nuncaComprou: false,
    faturamentoTotal: 1000.00,
    versaoEngine: '1.0.0',
  });
  // cliente existente para testes de regressão
  await db.collection('clientes').doc('cliente-r360-linked').set({
    nome: 'Cliente R360', pipeline: 'ativo',
    gestaoClickId: '9001',
    gestaoClickLinkedAt: new Date('2026-09-15T00:00:00Z'),
    gestaoClickLinkMethod: 'PHONE_NAME',
  });
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async ctx => { await SEED(ctx.firestore()); });
});

afterAll(async () => { await testEnv.cleanup(); });

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async ctx => { await SEED(ctx.firestore()); });
});

const db = (uid) => uid
  ? testEnv.authenticatedContext(uid).firestore()
  : testEnv.unauthenticatedContext().firestore();

// ── RULE360-01 — gestor lê perfis_360 ────────────────────────────────────────

describe('RULE360-01 — gestor pode ler perfis_360', () => {
  test('gestor lê perfil existente em perfis_360', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('perfis_360').doc('cliente-r360-001').get()
    );
  });
});

// ── RULE360-02 — funcionário comum não lê perfis_360 ─────────────────────────

describe('RULE360-02 — funcionário comum não lê perfis_360', () => {
  test('funcionário sem role gestor é barrado em perfis_360', async () => {
    await assertFails(
      db(UID_FUNC).collection('perfis_360').doc('cliente-r360-001').get()
    );
  });
});

// ── RULE360-03 — gestor NÃO escreve perfis_360 ───────────────────────────────

describe('RULE360-03 — gestor não escreve perfis_360 via frontend', () => {
  test('gestor é barrado ao criar documento em perfis_360', async () => {
    await assertFails(
      db(UID_GESTOR).collection('perfis_360').doc('cliente-r360-novo').set({
        clienteMr4Id: 'cliente-r360-novo',
        nuncaComprou: true,
      })
    );
  });
});

// ── RULE360-04 — funcionário NÃO escreve perfis_360 ──────────────────────────

describe('RULE360-04 — funcionário não escreve perfis_360', () => {
  test('funcionário é barrado ao criar documento em perfis_360', async () => {
    await assertFails(
      db(UID_FUNC).collection('perfis_360').doc('cliente-r360-novo').set({
        clienteMr4Id: 'cliente-r360-novo',
        nuncaComprou: true,
      })
    );
  });
});

// ── RULE360-05 — frontend não lê vendas_gc ────────────────────────────────────

describe('RULE360-05 — frontend não lê vendas_gc', () => {
  test('gestor é barrado ao ler vendas_gc', async () => {
    await assertFails(
      db(UID_GESTOR).collection('vendas_gc').doc('venda-001').get()
    );
  });

  test('funcionário é barrado ao ler vendas_gc', async () => {
    await assertFails(
      db(UID_FUNC).collection('vendas_gc').doc('venda-001').get()
    );
  });

  test('anônimo é barrado ao ler vendas_gc', async () => {
    await assertFails(
      db(null).collection('vendas_gc').doc('venda-001').get()
    );
  });
});

// ── RULE360-06 — frontend não escreve vendas_gc ───────────────────────────────

describe('RULE360-06 — frontend não escreve vendas_gc', () => {
  test('gestor é barrado ao criar em vendas_gc', async () => {
    await assertFails(
      db(UID_GESTOR).collection('vendas_gc').doc('venda-nova').set({
        id: 'venda-nova', cliente_id: '1', valor_total: '100',
      })
    );
  });

  test('anônimo é barrado ao criar em vendas_gc', async () => {
    await assertFails(
      db(null).collection('vendas_gc').doc('venda-nova').set({
        id: 'venda-nova', cliente_id: '1', valor_total: '100',
      })
    );
  });
});

// ── RULE360-07 — frontend não lê sync_state ──────────────────────────────────

describe('RULE360-07 — frontend não lê sync_state', () => {
  test('gestor é barrado ao ler sync_state', async () => {
    await assertFails(
      db(UID_GESTOR).collection('sync_state').doc('perfil360').get()
    );
  });

  test('funcionário é barrado ao ler sync_state', async () => {
    await assertFails(
      db(UID_FUNC).collection('sync_state').doc('perfil360').get()
    );
  });
});

// ── RULE360-08 — frontend não escreve sync_state ─────────────────────────────

describe('RULE360-08 — frontend não escreve sync_state', () => {
  test('gestor é barrado ao escrever sync_state', async () => {
    await assertFails(
      db(UID_GESTOR).collection('sync_state').doc('perfil360').set({
        status: 'READY',
      })
    );
  });

  test('anônimo é barrado ao escrever sync_state', async () => {
    await assertFails(
      db(null).collection('sync_state').doc('perfil360').set({
        status: 'READY',
      })
    );
  });
});

// ── RULE360-09 — regras de clientes continuam funcionando ────────────────────

describe('RULE360-09 — regras clientes não regridem após adição de Perfil360', () => {
  test('gestor lê cliente existente', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc('cliente-r360-linked').get()
    );
  });

  test('funcionário não lê clientes (sem permissão de módulo)', async () => {
    // Funcionário sem módulo comercial não deve ler clientes
    await assertFails(
      db(UID_FUNC).collection('clientes').doc('cliente-r360-linked').get()
    );
  });

  test('anônimo não lê clientes', async () => {
    await assertFails(
      db(null).collection('clientes').doc('cliente-r360-linked').get()
    );
  });
});

// ── RULE360-10 — proteção gestaoClickId continua funcionando ─────────────────

describe('RULE360-10 — proteção gestaoClickId não regride', () => {
  test('gestor não pode setar gestaoClickId diretamente via frontend', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc('cliente-r360-linked').update({
        gestaoClickId: '99999-novo',
      })
    );
  });

  test('gestor pode atualizar campo comercial legítimo (nome)', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc('cliente-r360-linked').update({
        nome: 'Cliente R360 Atualizado',
      })
    );
  });
});
