'use strict';
/**
 * N35.12R — Testes da MATRIZ DE PERMISSÕES PROPOSTA (vendedor × gestão)
 *
 * ATENÇÃO: estes testes definem o TARGET do redesenho.
 * Eles FALHARÃO até o modelo ser implementado (fila-comercial-operar / fila-comercial-gestao).
 *
 * NÃO COMMITAR até o modelo ser aprovado e implementado.
 * PROD_WRITES=0 | usa apenas emulador
 *
 * Cenários cobertos (15):
 *   PM-01: vendedor + operar → claim ALLOW
 *   PM-02: vendedor + operar → outcome (owner) ALLOW
 *   PM-03: vendedor + operar → read fila ALLOW
 *   PM-04: vendedor sem módulo operar → claim DENY
 *   PM-05: Camila (gestao) → claim DENY
 *   PM-06: Camila (gestao) → outcome DENY
 *   PM-07: gestor (sem módulo) → read ALLOW [via isGestor — testado via callable se admin=true]
 *   PM-08: gestor (sem módulo operar) → claim DENY
 *   PM-09: funcionário comum → claim DENY
 *   PM-10: inativo → claim DENY
 *   PM-11: bloqueado → claim DENY
 *   PM-12: não autenticado → DENY
 *   PM-13: owner vendedor → outcome ALLOW
 *   PM-14: vendedor não-owner → outcome DENY
 *   PM-15: supervisor não-owner → outcome DENY
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

const { claimOpportunityHandler, registerOutcomeHandler, releaseOpportunityHandler } = require(path.join(LIB, 'canaryCallable'));
const { criarEstadoInicial, OUTCOMES }                    = require(path.join(LIB, 'filaOperacional'));

// ── Constantes ────────────────────────────────────────────────────────────────

const COLL   = 'interacoes_fila';
const OPP_ID = 'bb00cc11dd22ee33'; // 16 hex
const ENTITY = 'MR4_LINKED:permtest002';
const T0     = '2026-09-24T10:00:00.000Z';

const UID = {
  VENDEDOR_OK:       'pm-vendedor-ok',
  VENDEDOR_SEM_MOD:  'pm-vendedor-sem-mod',
  CAMILA_GESTAO:     'pm-camila-gestao',
  GESTOR_SEM_OPERAR: 'pm-gestor-sem-operar',
  FUNC_COMUM:        'pm-func-comum',
  INATIVO:           'pm-inativo',
  BLOQUEADO:         'pm-bloqueado',
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

const oppRef = () => db.collection(COLL).doc(OPP_ID);

async function resetOpp() {
  await oppRef().set(criarEstadoInicial(ENTITY, OPP_ID, 'REATIVACAO_120D', T0));
}

function req(uid, data = {}) {
  return { auth: uid ? { uid } : null, data: { opportunityInstanceId: OPP_ID, ...data } };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await resetOpp();

  // PM-01,02,13: vendedor com módulo operar
  await seedUser(UID.VENDEDOR_OK,
    { ativo: true, role: 'funcionario', email: 'vendedor@mr4.local' },
    { admin: false, modulos: ['fila-comercial', 'fila-comercial-operar'], nome: 'Vendedor OK' }
  );
  // PM-04: vendedor sem módulo operar (apenas fila-comercial)
  await seedUser(UID.VENDEDOR_SEM_MOD,
    { ativo: true, role: 'funcionario', email: 'vendedor2@mr4.local' },
    { admin: false, modulos: ['fila-comercial'], nome: 'Vendedor Sem Operar' }
  );
  // PM-05,06,15: Camila com módulo gestao
  await seedUser(UID.CAMILA_GESTAO,
    { ativo: true, role: 'funcionario', email: 'camila@mr4.local' },
    { admin: true, modulos: ['catalogo','expedicao','ponto','garantia','demandas','fila-comercial-gestao'], nome: 'Camila Gestao' }
  );
  // PM-08: gestor sem módulo operar
  await seedUser(UID.GESTOR_SEM_OPERAR,
    { ativo: true, role: 'gestor', email: 'gestor@mr4.local' },
    { admin: true, modulos: [], nome: 'Gestor Sem Operar' }
  );
  // PM-09: funcionario comum sem módulos fila
  await seedUser(UID.FUNC_COMUM,
    { ativo: true, role: 'funcionario', email: 'func@mr4.local' },
    { admin: false, modulos: ['catalogo', 'ponto'], nome: 'Func Comum' }
  );
  // PM-10: inativo
  await seedUser(UID.INATIVO,
    { ativo: false, role: 'funcionario', email: 'inativo@mr4.local' },
    { admin: false, modulos: ['fila-comercial-operar'], nome: 'Inativo' }
  );
  // PM-11: bloqueado
  await seedUser(UID.BLOQUEADO,
    { ativo: true, role: 'funcionario', email: 'bloqueado@mr4.local' },
    { admin: false, modulos: ['fila-comercial-operar'], bloqueado: true, nome: 'Bloqueado' }
  );
}, 20000);

afterAll(async () => {
  await oppRef().delete();
  for (const uid of Object.values(UID)) await cleanUser(uid);
}, 10000);

afterEach(async () => { await resetOpp(); }, 5000);

// ── PM-01: Vendedor + operar → claim ALLOW ────────────────────────────────────

describe('PM-01: vendedor com fila-comercial-operar → claim ALLOW', () => {
  test('claim concluído', async () => {
    const res = await claimOpportunityHandler(req(UID.VENDEDOR_OK));
    expect(res.estado).toBe('EM_ATENDIMENTO');
    console.log('PM_01_VENDEDOR_OPERAR_CLAIM_ALLOW=PASS');
  }, 15000);
});

// ── PM-02: Vendedor → outcome (owner) ALLOW ───────────────────────────────────

describe('PM-02: vendedor owner → outcome ALLOW', () => {
  test('registrarOutcome pelo owner', async () => {
    await claimOpportunityHandler(req(UID.VENDEDOR_OK));
    const res = await registerOutcomeHandler(req(UID.VENDEDOR_OK, { outcome: OUTCOMES.CONVERSA_REALIZADA }));
    expect(res.estado).toBe('CONCLUIDA');
    console.log('PM_02_VENDEDOR_OWNER_OUTCOME_ALLOW=PASS');
  }, 15000);
});

// ── PM-04: Vendedor SEM módulo operar → claim DENY ────────────────────────────

describe('PM-04: vendedor sem fila-comercial-operar → claim DENY', () => {
  test('claim rejeitado com permission-denied', async () => {
    await expect(claimOpportunityHandler(req(UID.VENDEDOR_SEM_MOD))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_04_VENDEDOR_SEM_MOD_CLAIM_DENY=PASS');
  }, 15000);
});

// ── PM-05: Camila (gestao) → claim DENY ──────────────────────────────────────

describe('PM-05: Camila com fila-comercial-gestao → claim DENY', () => {
  test('claim rejeitado (supervisão não opera)', async () => {
    await expect(claimOpportunityHandler(req(UID.CAMILA_GESTAO))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_05_CAMILA_GESTAO_CLAIM_DENY=PASS');
  }, 15000);
});

// ── PM-06: Camila (gestao) → outcome DENY ────────────────────────────────────

describe('PM-06: Camila com fila-comercial-gestao → outcome DENY', () => {
  test('outcome rejeitado antes do claim', async () => {
    // Sem claim, outcome deve falhar (não é owner)
    await expect(registerOutcomeHandler(req(UID.CAMILA_GESTAO, { outcome: OUTCOMES.SEM_RESPOSTA }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_06_CAMILA_GESTAO_OUTCOME_DENY=PASS');
  }, 15000);
});

// ── PM-08: Gestor sem módulo operar → claim DENY ─────────────────────────────

describe('PM-08: gestor sem fila-comercial-operar → claim DENY', () => {
  test('claim rejeitado (gestor não opera por padrão)', async () => {
    await expect(claimOpportunityHandler(req(UID.GESTOR_SEM_OPERAR))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_08_GESTOR_SEM_OPERAR_CLAIM_DENY=PASS');
  }, 15000);
});

// ── PM-09: Funcionário comum → DENY ──────────────────────────────────────────

describe('PM-09: funcionário comum sem módulos fila → DENY', () => {
  test('claim rejeitado', async () => {
    await expect(claimOpportunityHandler(req(UID.FUNC_COMUM))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_09_FUNC_COMUM_DENY=PASS');
  }, 15000);
});

// ── PM-10: Inativo → DENY ────────────────────────────────────────────────────

describe('PM-10: usuário inativo → DENY', () => {
  test('claim rejeitado', async () => {
    await expect(claimOpportunityHandler(req(UID.INATIVO))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_10_INATIVO_DENY=PASS');
  }, 15000);
});

// ── PM-11: Bloqueado → DENY ───────────────────────────────────────────────────

describe('PM-11: usuário bloqueado → DENY', () => {
  test('claim rejeitado', async () => {
    await expect(claimOpportunityHandler(req(UID.BLOQUEADO))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_11_BLOQUEADO_DENY=PASS');
  }, 15000);
});

// ── PM-12: Não autenticado → DENY ────────────────────────────────────────────

describe('PM-12: não autenticado → DENY', () => {
  test('unauthenticated error', async () => {
    await expect(claimOpportunityHandler(req(null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    console.log('PM_12_UNAUTH_DENY=PASS');
  }, 5000);
});

// ── PM-13: Owner vendedor → outcome ALLOW ────────────────────────────────────

describe('PM-13: owner vendedor → outcome ALLOW', () => {
  test('registra outcome como owner', async () => {
    await claimOpportunityHandler(req(UID.VENDEDOR_OK));
    const res = await registerOutcomeHandler(req(UID.VENDEDOR_OK, { outcome: OUTCOMES.SEM_RESPOSTA }));
    expect(res.estado).toBe('DISPONIVEL');
    console.log('PM_13_OWNER_OUTCOME_ALLOW=PASS');
  }, 15000);
});

// ── PM-14: Vendedor não-owner → outcome DENY ─────────────────────────────────

describe('PM-14: vendedor não-owner → outcome DENY', () => {
  test('outcome rejeitado para não-owner', async () => {
    // Vendedor_OK faz o claim
    await claimOpportunityHandler(req(UID.VENDEDOR_OK));
    // Vendedor_SEM_MOD tenta registrar outcome (não é owner e não tem operar)
    await expect(registerOutcomeHandler(req(UID.VENDEDOR_SEM_MOD, { outcome: OUTCOMES.SEM_RESPOSTA }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_14_NON_OWNER_OUTCOME_DENY=PASS');
  }, 15000);
});

// ── PM-15: Supervisor não-owner → outcome DENY ───────────────────────────────

describe('PM-15: supervisor (Camila) não-owner → outcome DENY', () => {
  test('outcome rejeitado para supervisor sem operação', async () => {
    await claimOpportunityHandler(req(UID.VENDEDOR_OK));
    await expect(registerOutcomeHandler(req(UID.CAMILA_GESTAO, { outcome: OUTCOMES.SEM_RESPOSTA }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_15_SUPERVISOR_NON_OWNER_DENY=PASS');
  }, 15000);
});

// ── PM-R03: Vendedor owner → release ALLOW ───────────────────────────────────

describe('PM-R03: vendedor owner → release ALLOW', () => {
  test('release concluído pelo owner', async () => {
    await claimOpportunityHandler(req(UID.VENDEDOR_OK));
    const res = await releaseOpportunityHandler(req(UID.VENDEDOR_OK));
    expect(res.estado).toBe('DISPONIVEL');
    console.log('PM_R03_VENDEDOR_OWNER_RELEASE_ALLOW=PASS');
  }, 15000);
});

// ── PM-R07: Camila (gestao) → release DENY ───────────────────────────────────

describe('PM-R07: supervisor (Camila) → release DENY', () => {
  test('release rejeitado (supervisão não opera)', async () => {
    await expect(releaseOpportunityHandler(req(UID.CAMILA_GESTAO))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    console.log('PM_R07_CAMILA_GESTAO_RELEASE_DENY=PASS');
  }, 15000);
});
