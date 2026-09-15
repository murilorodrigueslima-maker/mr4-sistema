'use strict';

/**
 * Testes de segurança — proteção campos GestãoClick (S1 Fase 1)
 *
 * Garante que gestaoClickId, gestaoClickLinkedAt, gestaoClickLinkMethod
 * não podem ser criados ou modificados pelo frontend (cliente SDK).
 * Apenas Admin SDK (que ignora Rules) pode escrever esses campos.
 *
 * GC-RULE1  — gestor lê cliente-unlinked              → assertSucceeds
 * GC-RULE2  — gestor lê cliente-linked                → assertSucceeds
 * GC-RULE3  — gestor cria cliente SEM campos GC       → assertSucceeds
 * GC-RULE4  — gestor cria cliente COM gestaoClickId   → assertFails
 * GC-RULE5  — gestor cria cliente COM todos 3 campos GC → assertFails
 * GC-RULE6  — gestor atualiza campo comercial (nome)  → assertSucceeds
 * GC-RULE7  — gestor tenta setar gestaoClickId em update → assertFails
 * GC-RULE8  — gestor tenta setar gestaoClickLinkedAt  → assertFails
 * GC-RULE9  — gestor tenta setar gestaoClickLinkMethod → assertFails
 * GC-RULE10 — gestor tenta remover gestaoClickId (set sem campo) → assertFails
 * GC-RULE11 — gestor deleta cliente-unlinked          → assertSucceeds
 * GC-RULE12 — gestor deleta cliente-linked            → assertSucceeds
 * GC-RULE13 — funcionário NÃO cria cliente             → assertFails
 * GC-RULE14 — não-autenticado NÃO lê clientes         → assertFails
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=gc-rules
 *
 * Pré-requisito:
 *   Firebase emulators rodando: firestore (8080)
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { deleteField } = require('firebase/firestore');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

const UID_GESTOR = 'uid-gcr-gestor';
const UID_FUNC   = 'uid-gcr-func';

const DOC_UNLINKED = 'cliente-gcr-unlinked';
const DOC_LINKED   = 'cliente-gcr-linked';

let testEnv;

const SEED = async (db) => {
  await db.collection('users').doc(UID_GESTOR).set({
    role: 'gestor', ativo: true, nome: 'Gestor GCR Teste',
  });
  await db.collection('users').doc(UID_FUNC).set({
    role: 'funcionario', ativo: true, nome: 'Func GCR Teste',
  });
  await db.collection('clientes').doc(DOC_UNLINKED).set({
    nome: 'Cliente Sem Vinculo GC', pipeline: 'prospecto', telefone: '85911110000',
  });
  await db.collection('clientes').doc(DOC_LINKED).set({
    nome: 'Cliente Com Vinculo GC', pipeline: 'ativo', telefone: '85922220000',
    gestaoClickId: '99999',
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

// ── GC-RULE1 e GC-RULE2 — Leitura ─────────────────────────────────────────────
describe('GC-RULE1 — gestor lê cliente-unlinked', () => {
  test('gestor pode ler cliente sem vínculo GC', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc(DOC_UNLINKED).get()
    );
  });
});

describe('GC-RULE2 — gestor lê cliente-linked', () => {
  test('gestor pode ler cliente com vínculo GC', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc(DOC_LINKED).get()
    );
  });
});

// ── GC-RULE3, GC-RULE4, GC-RULE5 — Create ─────────────────────────────────────
describe('GC-RULE3 — gestor cria cliente SEM campos GC', () => {
  test('create com apenas campos comerciais é permitido', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc('novo-cliente-gcr').set({
        nome: 'Novo Cliente', pipeline: 'prospecto', telefone: '85933330000',
      })
    );
  });
});

describe('GC-RULE4 — gestor tenta criar cliente COM gestaoClickId', () => {
  test('create com gestaoClickId é bloqueado', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc('novo-cliente-gcr-bad').set({
        nome: 'Novo Cliente', pipeline: 'prospecto', gestaoClickId: '12345',
      })
    );
  });
});

describe('GC-RULE5 — gestor tenta criar cliente COM todos os 3 campos GC', () => {
  test('create com gestaoClickId + gestaoClickLinkedAt + gestaoClickLinkMethod é bloqueado', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc('novo-cliente-gcr-bad2').set({
        nome: 'Novo Cliente', pipeline: 'prospecto',
        gestaoClickId: '12345',
        gestaoClickLinkedAt: new Date(),
        gestaoClickLinkMethod: 'PHONE_NAME',
      })
    );
  });
});

// ── GC-RULE6 a GC-RULE10 — Update ─────────────────────────────────────────────
describe('GC-RULE6 — gestor atualiza campo comercial (nome) em cliente-linked', () => {
  test('update de nome é permitido mesmo em cliente com vínculo GC', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc(DOC_LINKED).update({
        nome: 'Nome Atualizado',
      })
    );
  });
});

describe('GC-RULE7 — gestor tenta setar gestaoClickId em update', () => {
  test('update que modifica gestaoClickId é bloqueado', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc(DOC_UNLINKED).update({
        nome: 'Nome Ok', gestaoClickId: '77777',
      })
    );
  });
});

describe('GC-RULE8 — gestor tenta setar gestaoClickLinkedAt em update', () => {
  test('update que modifica gestaoClickLinkedAt é bloqueado', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc(DOC_UNLINKED).update({
        gestaoClickLinkedAt: new Date(),
      })
    );
  });
});

describe('GC-RULE9 — gestor tenta setar gestaoClickLinkMethod em update', () => {
  test('update que modifica gestaoClickLinkMethod é bloqueado', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc(DOC_UNLINKED).update({
        gestaoClickLinkMethod: 'DOCUMENT',
      })
    );
  });
});

describe('GC-RULE10 — gestor tenta remover gestaoClickId com deleteField()', () => {
  test('update com deleteField() em gestaoClickId é bloqueado', async () => {
    await assertFails(
      db(UID_GESTOR).collection('clientes').doc(DOC_LINKED).update({
        nome: 'Nome Ok',
        gestaoClickId: deleteField(),
      })
    );
  });
});

// ── GC-RULE11, GC-RULE12 — Delete ─────────────────────────────────────────────
describe('GC-RULE11 — gestor deleta cliente-unlinked', () => {
  test('delete de cliente sem vínculo GC é permitido', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc(DOC_UNLINKED).delete()
    );
  });
});

describe('GC-RULE12 — gestor deleta cliente-linked', () => {
  test('delete de cliente com vínculo GC é permitido (controle por política, não Rules)', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('clientes').doc(DOC_LINKED).delete()
    );
  });
});

// ── GC-RULE13, GC-RULE14 — Bloqueios gerais ───────────────────────────────────
describe('GC-RULE13 — funcionário NÃO pode criar cliente', () => {
  test('create por funcionário é bloqueado', async () => {
    await assertFails(
      db(UID_FUNC).collection('clientes').doc('cliente-func-tentativa').set({
        nome: 'Teste Func', pipeline: 'prospecto',
      })
    );
  });
});

describe('GC-RULE14 — não-autenticado NÃO lê clientes', () => {
  test('leitura sem autenticação é bloqueada', async () => {
    await assertFails(
      db(null).collection('clientes').doc(DOC_UNLINKED).get()
    );
  });
});
