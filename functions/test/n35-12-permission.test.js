'use strict';
/**
 * N35.12 — Testes de autorização dual-role (fila-comercial)
 *
 * Cobre os 5 cenários exigidos:
 *   PA-01: gestor autorizado                       → ALLOW
 *   PA-02: funcionario + módulo fila-comercial     → ALLOW (Camila)
 *   PA-03: funcionario SEM módulo fila-comercial   → DENY
 *   PA-04: funcionario bloqueado/inativo           → DENY
 *   PA-05: não autenticado                         → DENY
 *
 * INVARIANTES: PROD_WRITES=0 | usa apenas emulador
 * Pré-requisito: firebase emulators rodando em localhost:8080 (Firestore)
 */

process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const path = require('path');
const LIB  = path.join(__dirname, '..', 'lib');

const { claimOpportunityHandler } = require(path.join(LIB, 'canaryCallable'));
const { criarEstadoInicial }      = require(path.join(LIB, 'filaOperacional'));

// ── Constantes ────────────────────────────────────────────────────────────────

const COLL     = 'interacoes_fila';
const OPP_ID   = 'aa00bb11cc22dd33'; // 16 hex chars (sintético)
const ENTITY   = 'MR4_LINKED:permtest001';
const T0       = '2026-09-24T10:00:00.000Z';

const UID = {
  GESTOR_OK:      'perm-gestor-ok',
  FUNC_MOD_OK:    'perm-func-mod-ok',
  FUNC_SEM_MOD:   'perm-func-sem-mod',
  FUNC_INATIVO:   'perm-func-inativo',
  FUNC_BLOQUEADO: 'perm-func-bloqueado',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedUser(uid, userDoc, sysDoc) {
  await db.collection('users').doc(uid).set(userDoc);
  await db.collection('sistema_usuarios').doc(uid).set(sysDoc);
}

async function cleanUser(uid) {
  await db.collection('users').doc(uid).delete();
  await db.collection('sistema_usuarios').doc(uid).delete();
}

function mockRequest(uid, oppId = OPP_ID) {
  return { auth: uid ? { uid } : null, data: { opportunityInstanceId: oppId } };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Oportunidade sintética no emulador para testes que chegam até o claim
  const estado = criarEstadoInicial(ENTITY, OPP_ID, 'REATIVACAO_120D', T0);
  await db.collection(COLL).doc(OPP_ID).set(estado);

  // PA-01 — gestor (gestão apenas, sem operar; N35.12S: gestor não opera por padrão → DENY)
  await seedUser(UID.GESTOR_OK,
    { ativo: true, role: 'gestor',     email: 'gestor@test.mr4' },
    { admin: false, modulos: ['fila-comercial-gestao'], nome: 'Gestor Teste' }
  );
  // PA-02 — funcionario + módulo operar (N35.12S: fila-comercial-operar necessário para claim)
  await seedUser(UID.FUNC_MOD_OK,
    { ativo: true, role: 'funcionario', email: 'vendedor@test.mr4' },
    { admin: false, modulos: ['fila-comercial-operar'], nome: 'Vendedor Teste' }
  );
  // PA-03 — funcionario sem módulo fila-comercial
  await seedUser(UID.FUNC_SEM_MOD,
    { ativo: true, role: 'funcionario', email: 'func@test.mr4' },
    { admin: false, modulos: ['catalogo','ponto'], nome: 'Func Comum' }
  );
  // PA-04a — funcionario inativo
  await seedUser(UID.FUNC_INATIVO,
    { ativo: false, role: 'funcionario', email: 'inativo@test.mr4' },
    { admin: false, modulos: ['fila-comercial'], nome: 'Inativo Teste' }
  );
  // PA-04b — funcionario bloqueado (ativo mas bloqueado no sistema_usuarios)
  await seedUser(UID.FUNC_BLOQUEADO,
    { ativo: true, role: 'funcionario', email: 'bloqueado@test.mr4' },
    { admin: false, modulos: ['fila-comercial'], nome: 'Bloqueado Teste', bloqueado: true }
  );
}, 15000);

afterAll(async () => {
  await db.collection(COLL).doc(OPP_ID).delete();
  for (const uid of Object.values(UID)) await cleanUser(uid);
}, 10000);

// Reseta o estado da oportunidade entre testes que fazem claim
afterEach(async () => {
  const estado = criarEstadoInicial(ENTITY, OPP_ID, 'REATIVACAO_120D', T0);
  await db.collection(COLL).doc(OPP_ID).set(estado);
}, 5000);

// ── PA-01 — Gestor sem operar → DENY (N35.12S: role=gestor NÃO concede operação) ─

describe('PA-01: gestor sem fila-comercial-operar → DENY', () => {
  test('claim rejeitado (gestor é gestão, não operação)', async () => {
    const req = mockRequest(UID.GESTOR_OK);
    await expect(claimOpportunityHandler(req)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PA_01_GESTOR_SEM_OPERAR_DENY=PASS');
  }, 15000);
});

// ── PA-02 — Funcionario com fila-comercial-operar → ALLOW ─────────────────────

describe('PA-02: funcionario com fila-comercial-operar (vendedor) → ALLOW', () => {
  test('claim concluído sem erro de permissão', async () => {
    const req = mockRequest(UID.FUNC_MOD_OK);
    const res = await claimOpportunityHandler(req);
    expect(res.estado).toBe('EM_ATENDIMENTO');
    expect(res.operadorNome).toBeTruthy();
    console.log('PA_02_VENDEDOR_OPERAR_ALLOW=PASS operadorNome=' + res.operadorNome);
  }, 15000);
});

// ── PA-03 — Funcionario SEM módulo fila-comercial → DENY ──────────────────────

describe('PA-03: funcionario sem módulo fila-comercial', () => {
  test('claim lança permission-denied', async () => {
    const req = mockRequest(UID.FUNC_SEM_MOD);
    await expect(claimOpportunityHandler(req)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // Oportunidade não alterada
    const snap = await db.collection(COLL).doc(OPP_ID).get();
    expect(snap.data().estado).toBe('DISPONIVEL');
    console.log('PA_03_FUNC_SEM_MOD_DENY=PASS estado=DISPONIVEL');
  }, 15000);
});

// ── PA-04 — Funcionario bloqueado/inativo → DENY ──────────────────────────────

describe('PA-04: funcionario bloqueado ou inativo', () => {
  test('PA-04a: inativo → DENY (conta inativa)', async () => {
    const req = mockRequest(UID.FUNC_INATIVO);
    await expect(claimOpportunityHandler(req)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PA_04A_INATIVO_DENY=PASS');
  }, 15000);

  test('PA-04b: bloqueado no sistema_usuarios → DENY', async () => {
    const req = mockRequest(UID.FUNC_BLOQUEADO);
    await expect(claimOpportunityHandler(req)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PA_04B_BLOQUEADO_DENY=PASS');
  }, 15000);
});

// ── PA-05 — Não autenticado → DENY ────────────────────────────────────────────

describe('PA-05: não autenticado', () => {
  test('sem auth → lança unauthenticated', async () => {
    const req = mockRequest(null);  // auth=null
    await expect(claimOpportunityHandler(req)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    console.log('PA_05_UNAUTHENTICATED_DENY=PASS');
  }, 5000);
});
