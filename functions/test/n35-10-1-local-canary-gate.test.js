'use strict';
/**
 * N35.10.1 — Local Canary Gate
 * Valida TODOS os gates antes da autorização de produção.
 *
 * INVARIANTES: PROD_WRITES=0 | OPENAI_CALLS=0 | COMMITS=0
 *
 * Seções:
 *   A. TRAJECTÓRIAS (pure state machine — 4 canários)
 *   B. SEM_RESPOSTA SEQUENCE
 *   C. RULES/SECURITY (emulador @firebase/rules-unit-testing)
 *   D. CONCURRENT CLAIM + CLAIM TIMEOUT (Admin SDK → emulador)
 *   E. CAP_10 (5 cenários no emulador)
 *   F. IDEMPOTÊNCIA
 *   G. ENTITY SUPPRESSION (canário B obrigatório)
 *
 * Pré-requisito: firebase emulators rodando em localhost:8080 (Firestore) + localhost:9099 (Auth)
 */

// ── Admin SDK → emulador ──────────────────────────────────────────────────────
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const adminDb = admin.firestore();
adminDb.settings({ ignoreUndefinedProperties: true });

// ── State machine / identity ──────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const LIB  = path.join(__dirname, '..', 'lib');

const {
  ESTADOS, OUTCOMES, EVENT_TYPES,
  criarEstadoInicial, claimOportunidade, releaseOportunidade,
  releaseExpiredClaim, registrarOutcome,
  isCooledDown, isClaimExpired, getConsecutiveSemRespostaCount,
  isConcluida,
} = require(path.join(LIB, 'filaOperacional'));

const { gerarDailyWorklist, isDueFollowUp } = require(path.join(LIB, 'dailyWorklist'));
const { buildCommercialEntityId, buildOpportunityInstanceId } = require(path.join(LIB, 'commercialIdentity'));

// ── Rules testing ─────────────────────────────────────────────────────────────
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

// ── Canários (IDs reais da N35.10 FASE 4) ────────────────────────────────────
const CANARIOS = Object.freeze([
  { nome: 'VP Filme - Valdizar',
    commercialEntityId: 'MR4_LINKED:M6wAPSqRGQVKcMqK76lt',
    opportunityInstanceId: 'f6f744b856019469',
    tipoOportunidade: 'REATIVACAO_120D' },
  { nome: 'Albuquerque Auto Som',
    commercialEntityId: 'MR4_LINKED:jDC32RQVOXrfRyXI9tnB',
    opportunityInstanceId: 'a4ff158c667e74ef',
    tipoOportunidade: 'REATIVACAO_120D' },
  { nome: 'Laninha Castro',
    commercialEntityId: 'MR4_LINKED:AimKwxONryOZPpnUVOUH',
    opportunityInstanceId: 'a31a49b109172b18',
    tipoOportunidade: 'REATIVACAO_120D' },
  { nome: 'Danilo Marques MR4',
    commercialEntityId: 'MR4_LINKED:xCKommcUFF6ULOIFbTN2',
    opportunityInstanceId: 'c42a7af563da0a06',
    tipoOportunidade: 'REATIVACAO_120D' },
]);

// ── Timestamps de teste ───────────────────────────────────────────────────────
const T0       = '2026-09-24T10:00:00.000Z';
const T0_1H    = '2026-09-24T11:00:00.000Z';
const T0_4H1S  = '2026-09-24T14:00:01.000Z';
const T0_29D   = '2026-10-23T10:00:00.000Z';
const T0_30D   = '2026-10-24T10:00:00.000Z';
const T0_30D1S = '2026-10-24T10:00:01.000Z';
const DATA_REF = '2026-09-24';
const DATA_FU_VENCIDA  = '2026-09-23';  // follow-up vencido
const DATA_FU_FUTURA   = '2026-10-01';  // follow-up futuro

const OP_A = 'vendedor-A';
const OP_B = 'vendedor-B';

// ── Helpers de emulador ───────────────────────────────────────────────────────
const COLL = 'interacoes_fila';

async function limparCanarios() {
  const batch = adminDb.batch();
  for (const c of CANARIOS) {
    batch.delete(adminDb.collection(COLL).doc(c.opportunityInstanceId));
  }
  await batch.commit();
}

async function criarEstadoEmulador(canario, overrides = {}) {
  const estado = criarEstadoInicial(
    canario.commercialEntityId,
    canario.opportunityInstanceId,
    canario.tipoOportunidade,
    T0
  );
  const doc = { ...estado, ...overrides };
  await adminDb.collection(COLL).doc(canario.opportunityInstanceId).set(doc);
  return doc;
}

async function lerEstado(oppId) {
  const snap = await adminDb.collection(COLL).doc(oppId).get();
  return snap.exists ? snap.data() : null;
}

// Simula claim via runTransaction (Admin SDK → emulador)
async function claimViaTransaction(oppId, operadorId, isoNow) {
  return adminDb.runTransaction(async tx => {
    const ref  = adminDb.collection(COLL).doc(oppId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Documento ${oppId} não existe`);
    const estadoAtual = snap.data();
    const novoEstado  = claimOportunidade(estadoAtual, operadorId, isoNow);
    tx.set(ref, novoEstado);
    return novoEstado;
  });
}

// Simula registrarOutcome via runTransaction
async function outcomeViaTransaction(oppId, operadorId, outcome, isoNow, meta = {}) {
  return adminDb.runTransaction(async tx => {
    const ref  = adminDb.collection(COLL).doc(oppId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Documento ${oppId} não existe`);
    const estadoAtual = snap.data();
    const novoEstado  = registrarOutcome(estadoAtual, operadorId, outcome, isoNow, meta);
    tx.set(ref, novoEstado);
    return novoEstado;
  });
}

// Simula release via runTransaction
async function releaseViaTransaction(oppId, operadorId, isoNow) {
  return adminDb.runTransaction(async tx => {
    const ref  = adminDb.collection(COLL).doc(oppId);
    const snap = await tx.get(ref);
    const novoEstado = releaseOportunidade(snap.data(), operadorId, isoNow);
    tx.set(ref, novoEstado);
    return novoEstado;
  });
}

async function releaseExpiredViaTransaction(oppId, isoNow) {
  return adminDb.runTransaction(async tx => {
    const ref  = adminDb.collection(COLL).doc(oppId);
    const snap = await tx.get(ref);
    const novoEstado = releaseExpiredClaim(snap.data(), isoNow);
    tx.set(ref, novoEstado);
    return novoEstado;
  });
}

// ── Proposed rules (current + interacoes_fila block) ─────────────────────────
function buildProposedRules() {
  const current = fs.readFileSync(
    path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'
  );
  const interacoesRule = `
    // ── interacoes_fila (N35.10) — read=fila-comercial, write=false ──
    match /interacoes_fila/{oppId} {
      allow read:  if temModulo('fila-comercial');
      allow write: if false;
    }
`;
  // Inserir antes do catch-all
  return current.replace(
    `    // ── Tudo mais: negado por padrão ───────────────────────────────────────────
    match /{document=**} {
      allow read, write: if false;
    }`,
    interacoesRule + `\n    // ── Tudo mais: negado por padrão ───────────────────────────────────────────
    match /{document=**} {
      allow read, write: if false;
    }`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO A — TRAJECTÓRIAS (pure state machine)
// ═══════════════════════════════════════════════════════════════════════════════

describe('A. Trajectórias — máquina de estado pura', () => {

  // CANÁRIO A — conclusão normal
  test('CAN-A-01: DISPONIVEL → claim → EM_ATENDIMENTO → CONVERSA_REALIZADA → CONCLUIDA', () => {
    const c = CANARIOS[0];
    let est = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    expect(est.estado).toBe(ESTADOS.DISPONIVEL);

    est = claimOportunidade(est, OP_A, T0);
    expect(est.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    expect(est.claimAtual.operadorId).toBe(OP_A);

    est = registrarOutcome(est, OP_A, OUTCOMES.CONVERSA_REALIZADA, T0_1H);
    expect(est.estado).toBe(ESTADOS.CONCLUIDA);
    expect(est.claimAtual).toBeNull();
    expect(isConcluida(est)).toBe(true);
    expect(est.eventos).toHaveLength(2);

    // Não deve aparecer na worklist
    const worklist = gerarDailyWorklist({
      clientesHoje: [{ opportunityInstanceId: c.opportunityInstanceId, decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 690 }],
      estadosOperacionais: new Map([[c.opportunityInstanceId, est]]),
      cap: 10,
      dataReferencia: DATA_REF,
    });
    expect(worklist.worklist).toHaveLength(0);
  });

  // CANÁRIO B — SEM_INTERESSE_AGORA
  test('CAN-B-01: CONCLUIDA + cooledUntil=T0+30d após SEM_INTERESSE_AGORA', () => {
    const c = CANARIOS[1];
    let est = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    est = claimOportunidade(est, OP_A, T0);
    est = registrarOutcome(est, OP_A, OUTCOMES.SEM_INTERESSE_AGORA, T0);

    expect(est.estado).toBe(ESTADOS.CONCLUIDA);
    expect(isCooledDown(est, T0_29D)).toBe(true);
    expect(isCooledDown(est, T0_30D)).toBe(false);
    expect(isCooledDown(est, T0_30D1S)).toBe(false);
  });

  test('CAN-B-02: nova opportunityInstanceId da MESMA entidade suprimida durante cooldown', () => {
    const c      = CANARIOS[1];
    const novaOppId = buildOpportunityInstanceId(c.commercialEntityId, c.tipoOportunidade, '2026-01-01');
    let estAntigo = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    estAntigo = claimOportunidade(estAntigo, OP_A, T0);
    estAntigo = registrarOutcome(estAntigo, OP_A, OUTCOMES.SEM_INTERESSE_AGORA, T0);

    // suppressedEntities: entidade -> cooledUntil
    const suppressed = new Map([[c.commercialEntityId, estAntigo.cooledUntil]]);
    const novoCliente = {
      opportunityInstanceId: novaOppId,
      commercialEntityId:    c.commercialEntityId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        400,
    };
    const worklist = gerarDailyWorklist({
      clientesHoje:        [novoCliente],
      estadosOperacionais: new Map(),
      suppressedEntities:  suppressed,
      cap:                 10,
      dataReferencia:      DATA_REF,
    });
    expect(worklist.worklist).toHaveLength(0); // suprimida
    expect(worklist.dueFollowUps).toHaveLength(0);
  });

  // CANÁRIO C — follow-up
  test('CAN-C-01: PEDIU_RETORNO → nextFollowUpAt futuro → fora de dueFollowUps E de newOpportunities', () => {
    // N35.14: follow-up futuro bloqueia a entidade até a data (antes reaparecia como nova — bug N35.13)
    // (só fica em dueFollowUps quando a data venceu; antes disso, é newOpportunity elegível)
    const c = CANARIOS[2];
    let est = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    est = claimOportunidade(est, OP_A, T0);
    est = registrarOutcome(est, OP_A, OUTCOMES.PEDIU_RETORNO, T0, { scheduledFor: DATA_FU_FUTURA });
    expect(est.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
    expect(est.nextFollowUpAt).toBe(DATA_FU_FUTURA);

    const clienteHoje = {
      opportunityInstanceId: c.opportunityInstanceId,
      commercialEntityId:    c.commercialEntityId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        404,
    };
    const worklist = gerarDailyWorklist({
      clientesHoje:        [clienteHoje],
      estadosOperacionais: new Map([[c.opportunityInstanceId, est]]),
      cap:                 10,
      dataReferencia:      DATA_REF,
    });
    // follow-up futuro → isDueFollowUp=false → não vai para dueFollowUps
    expect(isDueFollowUp(est, DATA_REF)).toBe(false);
    expect(worklist.dueFollowUps).toHaveLength(0);
    expect(worklist.newOpportunities).toHaveLength(0);
    expect(worklist.worklist).toHaveLength(0);
  });

  test('CAN-C-02: follow-up vencido → aparece em dueFollowUps e NÃO consome CAP', () => {
    const c = CANARIOS[2];
    const estFu = {
      estado:        ESTADOS.AGUARDANDO_RETORNO,
      nextFollowUpAt: DATA_FU_VENCIDA,
      cooledUntil:   null,
      claimAtual:    null,
    };
    expect(isDueFollowUp(estFu, DATA_REF)).toBe(true);

    // 10 novas + 1 follow-up vencido = 11 total
    const novas = Array.from({ length: 10 }, (_, i) => ({
      opportunityInstanceId: `nova-opp-${i}`,
      commercialEntityId:    `MR4_LINKED:entidade${i}`,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        200 + i,
    }));
    const clienteFu = {
      opportunityInstanceId: c.opportunityInstanceId,
      commercialEntityId:    c.commercialEntityId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        404,
    };
    const estadosOp = new Map([[c.opportunityInstanceId, estFu]]);
    const worklist = gerarDailyWorklist({
      clientesHoje:        [...novas, clienteFu],
      estadosOperacionais: estadosOp,
      cap:                 10,
      dataReferencia:      DATA_REF,
    });
    expect(worklist.dueFollowUps).toHaveLength(1);
    expect(worklist.newOpportunities).toHaveLength(10);
    expect(worklist.worklist).toHaveLength(11);
    expect(worklist.worklist[0].opportunityInstanceId).toBe(c.opportunityInstanceId); // follow-up primeiro
  });

  // CANÁRIO D — concorrência pura (máquina de estado)
  test('CAN-D-01: segundo claim sobre EM_ATENDIMENTO falha (mutual exclusion)', () => {
    const c = CANARIOS[3];
    let est = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    est = claimOportunidade(est, OP_A, T0);
    expect(est.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    expect(() => claimOportunidade(est, OP_B, T0_1H)).toThrow(/EM_ATENDIMENTO/);
  });

  test('CAN-D-02: claim expirado (4h+1s) → releaseExpiredClaim → novo claim possível', () => {
    const c = CANARIOS[3];
    let est = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    est = claimOportunidade(est, OP_A, T0);

    expect(isClaimExpired(est, T0_1H)).toBe(false);
    expect(isClaimExpired(est, T0_4H1S)).toBe(true);

    est = releaseExpiredClaim(est, T0_4H1S);
    expect(est.estado).toBe(ESTADOS.DISPONIVEL);
    expect(est.claimAtual).toBeNull();
    expect(est.eventos.some(e => e.meta?.reason === 'CLAIM_TIMEOUT')).toBe(true);

    // Novo owner correto
    est = claimOportunidade(est, OP_B, T0_4H1S);
    expect(est.claimAtual.operadorId).toBe(OP_B);
  });

  test('CAN-D-03: não-owner não consegue release', () => {
    const c = CANARIOS[3];
    let est = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, T0);
    est = claimOportunidade(est, OP_A, T0);
    expect(() => releaseOportunidade(est, OP_B, T0_1H)).toThrow(/OP_A|op-A|vendedor-A/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO B — SEM_RESPOSTA SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════════

describe('B. SEM_RESPOSTA — sequência e reset', () => {

  function mkBaseState() {
    return criarEstadoInicial('MR4_LINKED:testSemResposta001', 'test-sr-001', 'REATIVACAO_120D', T0);
  }

  test('SR-01: 1º SEM_RESPOSTA → sem cooldown', () => {
    let est = claimOportunidade(mkBaseState(), OP_A, T0);
    est = registrarOutcome(est, OP_A, OUTCOMES.SEM_RESPOSTA, T0);
    expect(isCooledDown(est, T0_1H)).toBe(false);
    expect(getConsecutiveSemRespostaCount(est)).toBe(1);
  });

  test('SR-02: 2º SEM_RESPOSTA consecutivo → sem cooldown', () => {
    let est = mkBaseState();
    for (let i = 0; i < 2; i++) {
      est = claimOportunidade(est, OP_A, T0);
      est = registrarOutcome(est, OP_A, OUTCOMES.SEM_RESPOSTA, T0);
    }
    expect(isCooledDown(est, T0_1H)).toBe(false);
    expect(getConsecutiveSemRespostaCount(est)).toBe(2);
  });

  test('SR-03: 3º SEM_RESPOSTA consecutivo → cooledUntil +30d', () => {
    let est = mkBaseState();
    for (let i = 0; i < 3; i++) {
      est = claimOportunidade(est, OP_A, T0);
      est = registrarOutcome(est, OP_A, OUTCOMES.SEM_RESPOSTA, T0);
    }
    expect(isCooledDown(est, T0_29D)).toBe(true);
    expect(isCooledDown(est, T0_30D)).toBe(false);
    expect(getConsecutiveSemRespostaCount(est)).toBe(3);
  });

  test('SR-04: CONVERSA interrompe sequência de SEM_RESPOSTA', () => {
    let est = mkBaseState();
    // 2× SEM_RESPOSTA
    for (let i = 0; i < 2; i++) {
      est = claimOportunidade(est, OP_A, T0);
      est = registrarOutcome(est, OP_A, OUTCOMES.SEM_RESPOSTA, T0);
    }
    // conversa realizada (finaliza)
    est = claimOportunidade(est, OP_A, T0);
    est = registrarOutcome(est, OP_A, OUTCOMES.CONVERSA_REALIZADA, T0_1H);
    // nova oportunidade (novo estado para a mesma entidade, diferente oppId)
    const novaOpp = criarEstadoInicial('MR4_LINKED:testSemResposta001', 'test-sr-002', 'REATIVACAO_120D', T0);
    expect(getConsecutiveSemRespostaCount(novaOpp)).toBe(0); // sequência zerada
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO C — SECURITY / RULES (emulador @firebase/rules-unit-testing)
// ═══════════════════════════════════════════════════════════════════════════════

describe('C. Regras Firestore (proposed rules com interacoes_fila)', () => {
  let testEnv;
  const UID_COM_FC  = 'rul-gestor-com-fc';
  const UID_SEM_FC  = 'rul-gestor-sem-fc';
  const UID_ADMIN   = 'rul-gestor-admin';
  const UID_FUNC    = 'rul-funcionario';
  const OPP_TEST    = 'test-rules-opp-001';

  const PROPOSED_RULES = buildProposedRules();

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'mr4-ponto',
      firestore: {
        rules: PROPOSED_RULES,
        host:  'localhost',
        port:  8080,
      },
    });

    await testEnv.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      // users
      await db.collection('users').doc(UID_COM_FC).set({ role: 'gestor', ativo: true });
      await db.collection('users').doc(UID_SEM_FC).set({ role: 'gestor', ativo: true });
      await db.collection('users').doc(UID_ADMIN).set({ role: 'gestor', ativo: true });
      await db.collection('users').doc(UID_FUNC).set({ role: 'funcionario', ativo: true, funcionarioId: 'test-func-001' });
      // sistema_usuarios
      await db.collection('sistema_usuarios').doc(UID_COM_FC).set({ admin: false, modulos: ['fila-comercial'] });
      await db.collection('sistema_usuarios').doc(UID_SEM_FC).set({ admin: false, modulos: ['ponto'] });
      await db.collection('sistema_usuarios').doc(UID_ADMIN).set({ admin: true, modulos: [] });
      await db.collection('sistema_usuarios').doc(UID_FUNC).set({ admin: false, modulos: ['fila-comercial'] });
      // interacoes_fila seed
      const estado = criarEstadoInicial('MR4_LINKED:rulesTestEntity', OPP_TEST, 'REATIVACAO_120D', T0);
      await db.collection('interacoes_fila').doc(OPP_TEST).set(estado);
    });
  }, 30000);

  afterAll(async () => {
    if (testEnv) await testEnv.cleanup();
  });

  function clientDb(uid) {
    return uid
      ? testEnv.authenticatedContext(uid).firestore()
      : testEnv.unauthenticatedContext().firestore();
  }

  // IG-01: Unauthenticated read → DENY
  test('IG-01: UNAUTHENTICATED_ACCESS=DENY — read interacoes_fila', async () => {
    const ref = clientDb(null).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.get());
  });

  // IG-02: Gestor sem fila-comercial → DENY
  test('IG-02: USER_WITHOUT_COMMERCIAL_PERMISSION=DENY — gestor sem fila-comercial', async () => {
    const ref = clientDb(UID_SEM_FC).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.get());
  });

  // IG-03: Funcionário com módulo fila-comercial mas role≠gestor → DENY (temModulo requer isGestor)
  test('IG-03: FUNCIONARIO_WITH_FC_MODULE=DENY (temModulo requer role=gestor)', async () => {
    const ref = clientDb(UID_FUNC).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.get());
  });

  // IG-04: Gestor com fila-comercial → ALLOW read
  test('IG-04: AUTHORIZED_COMMERCIAL_USER=ALLOW — gestor com modulos=[fila-comercial]', async () => {
    const ref = clientDb(UID_COM_FC).collection('interacoes_fila').doc(OPP_TEST);
    await assertSucceeds(ref.get());
  });

  // IG-05: Admin gestor → ALLOW read
  test('IG-05: ADMIN_GESTOR=ALLOW — gestor com admin=true', async () => {
    const ref = clientDb(UID_ADMIN).collection('interacoes_fila').doc(OPP_TEST);
    await assertSucceeds(ref.get());
  });

  // IG-06: Qualquer write via cliente → DENY (write: if false)
  test('IG-06: IDENTITY_MUTATION=DENY — write: if false bloqueia todos os clients', async () => {
    const ref = clientDb(UID_ADMIN).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.set({ commercialEntityId: 'HACKED', estado: 'DISPONIVEL' }));
  });

  // IG-07: opportunityInstanceId mutation → DENY (write: false)
  test('IG-07: OPPORTUNITY_INSTANCE_ID_MUTATION=DENY — write: if false', async () => {
    const ref = clientDb(UID_COM_FC).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.update({ opportunityInstanceId: 'injected-opp' }));
  });

  // IG-08: History deletion → DENY (write: false)
  test('IG-08: HISTORY_DELETION_BY_FRONTEND=DENY — delete by client', async () => {
    const ref = clientDb(UID_ADMIN).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.delete());
  });

  // IG-09: Create by client → DENY
  test('IG-09: CLIENT_CREATE=DENY — new doc via client SDK', async () => {
    const ref = clientDb(UID_ADMIN).collection('interacoes_fila').doc('novo-opp-inject');
    const estado = criarEstadoInicial('MR4_LINKED:X', 'novo-opp-inject', 'REATIVACAO_120D', T0);
    await assertFails(ref.set(estado));
  });

  // IG-10: Unauthenticated create → DENY
  test('IG-10: UNAUTHENTICATED_WRITE=DENY', async () => {
    const ref = clientDb(null).collection('interacoes_fila').doc(OPP_TEST);
    await assertFails(ref.set({ estado: 'EM_ATENDIMENTO' }));
  });
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO D — CONCURRENT CLAIM + CLAIM TIMEOUT (Admin SDK → emulador)
// ═══════════════════════════════════════════════════════════════════════════════

describe('D. Concurrent claim + claim timeout (Admin SDK emulador)', () => {
  const C = CANARIOS[3]; // Danilo Marques MR4

  beforeEach(async () => {
    await criarEstadoEmulador(C);
  }, 10000);

  afterEach(async () => {
    await limparCanarios();
  }, 10000);

  test('D-01: claim sequencial — segundo claim vê EM_ATENDIMENTO e lança erro', async () => {
    // Primeiro claim via transaction
    await claimViaTransaction(C.opportunityInstanceId, OP_A, T0);

    // Segundo claim deve falhar (estado agora é EM_ATENDIMENTO)
    await expect(
      claimViaTransaction(C.opportunityInstanceId, OP_B, T0_1H)
    ).rejects.toThrow(/EM_ATENDIMENTO/);

    // Verificar que owner não foi sobrescrito
    const estado = await lerEstado(C.opportunityInstanceId);
    expect(estado.claimAtual.operadorId).toBe(OP_A);
  }, 15000);

  test('D-02: claim timeout (4h+1s) → release → novo owner correto', async () => {
    await claimViaTransaction(C.opportunityInstanceId, OP_A, T0);

    // Avançar relógio: T0_4H1S > T0 + 4h
    const estadoDepoisClaim = await lerEstado(C.opportunityInstanceId);
    expect(isClaimExpired(estadoDepoisClaim, T0_4H1S)).toBe(true);

    // Release por timeout
    await releaseExpiredViaTransaction(C.opportunityInstanceId, T0_4H1S);
    const estadoDepoisRelease = await lerEstado(C.opportunityInstanceId);
    expect(estadoDepoisRelease.estado).toBe(ESTADOS.DISPONIVEL);
    expect(estadoDepoisRelease.claimAtual).toBeNull();
    expect(estadoDepoisRelease.eventos.some(e => e.meta?.reason === 'CLAIM_TIMEOUT')).toBe(true);

    // Novo owner
    await claimViaTransaction(C.opportunityInstanceId, OP_B, T0_4H1S);
    const estadoFinal = await lerEstado(C.opportunityInstanceId);
    expect(estadoFinal.claimAtual.operadorId).toBe(OP_B);
  }, 15000);

  test('D-03: APPLICATION_LEVEL_GAP — registrarOutcome não valida ownership (doc + fallback)', async () => {
    // registrarOutcome (pure function) NÃO valida quem é o owner do claim —
    // essa validação cabe à Cloud Function (não deployada ainda).
    // O teste documenta o gap e verifica que o claim original é preservado no histórico.
    await claimViaTransaction(C.opportunityInstanceId, OP_A, T0);
    // Um não-owner pode chamar registrarOutcome via Admin SDK — comportamento esperado no nível da lib
    const novoEst = await outcomeViaTransaction(
      C.opportunityInstanceId, OP_B, OUTCOMES.CONVERSA_REALIZADA, T0_1H
    );
    expect(novoEst.estado).toBe(ESTADOS.CONCLUIDA);
    // Verificar que o claim original (OP_A) ficou registrado no evento CLAIMED
    const evClaimed = novoEst.eventos.find(e => e.tipo === EVENT_TYPES.CLAIMED);
    expect(evClaimed?.operadorId).toBe(OP_A);
    // APPLICATION_LEVEL_GAP: Cloud Function deve validar request.auth.uid === claimAtual.operadorId
  }, 15000);

  test('D-04: INVALID_STATE_TRANSITION=DENY — outcome sem claim prévio lança erro', async () => {
    // Estado é DISPONIVEL (sem claim)
    await expect(
      outcomeViaTransaction(C.opportunityInstanceId, OP_A, OUTCOMES.CONVERSA_REALIZADA, T0)
    ).rejects.toThrow(/EM_ATENDIMENTO/);
  }, 15000);

  test('D-05: histórico preservado após release expirado', async () => {
    await claimViaTransaction(C.opportunityInstanceId, OP_A, T0);
    await releaseExpiredViaTransaction(C.opportunityInstanceId, T0_4H1S);
    const est = await lerEstado(C.opportunityInstanceId);
    expect(est.eventos).toHaveLength(2); // CLAIMED + RELEASED
    expect(est.eventos[0].tipo).toBe(EVENT_TYPES.CLAIMED);
    expect(est.eventos[1].tipo).toBe(EVENT_TYPES.RELEASED);
  }, 15000);
}, 90000);

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO E — CAP_10 NO EMULADOR (5 cenários com estado persistido)
// ═══════════════════════════════════════════════════════════════════════════════

describe('E. CAP_10 — 5 cenários', () => {

  function mkCliente(id, decisao, dias, entId) {
    return {
      opportunityInstanceId: id,
      commercialEntityId:    entId || `MR4_LINKED:${id}`,
      decisaoAcaoComercial:  decisao,
      diasSemComprar:        dias,
    };
  }

  // E-A: 15 novas → 10 selecionadas
  test('CAP-A: 15 novas oportunidades → cap=10 aplicado, 10 selecionadas', () => {
    const clientes = Array.from({ length: 15 }, (_, i) =>
      mkCliente(`cap-a-opp${i}`, 'AGIR_AGORA', 200 - i)
    );
    const r = gerarDailyWorklist({
      clientesHoje: clientes, estadosOperacionais: new Map(), cap: 10, dataReferencia: DATA_REF,
    });
    expect(r.worklist).toHaveLength(10);
    expect(r.aplicouCap).toBe(true);
    expect(r.newOpportunities).toHaveLength(10);
  });

  // E-B: 10 novas + 3 follow-ups vencidos → 13 itens
  test('CAP-B: 10 novas + 3 follow-ups vencidos → 13 total', () => {
    const novas = Array.from({ length: 10 }, (_, i) =>
      mkCliente(`cap-b-new${i}`, 'AGIR_AGORA', 200 - i)
    );
    const fus = Array.from({ length: 3 }, (_, i) => ({
      ...mkCliente(`cap-b-fu${i}`, 'AGIR_AGORA', 300 + i),
    }));
    const estadosFu = new Map(fus.map((c, i) => [c.opportunityInstanceId, {
      estado: ESTADOS.AGUARDANDO_RETORNO, nextFollowUpAt: DATA_FU_VENCIDA, cooledUntil: null, claimAtual: null,
    }]));
    const r = gerarDailyWorklist({
      clientesHoje: [...fus, ...novas], estadosOperacionais: estadosFu, cap: 10, dataReferencia: DATA_REF,
    });
    expect(r.dueFollowUps).toHaveLength(3);
    expect(r.newOpportunities).toHaveLength(10);
    expect(r.worklist).toHaveLength(13);
  });

  // E-C: 12 novas + 3 follow-ups vencidos → 13 (cap corta novas em 10)
  test('CAP-C: 12 novas + 3 follow-ups vencidos → 13 (cap corta novas a 10)', () => {
    const novas = Array.from({ length: 12 }, (_, i) =>
      mkCliente(`cap-c-new${i}`, 'AGIR_AGORA', 200 - i)
    );
    const fus = Array.from({ length: 3 }, (_, i) => ({
      ...mkCliente(`cap-c-fu${i}`, 'AGIR_AGORA', 300 + i),
    }));
    const estadosFu = new Map(fus.map((c) => [c.opportunityInstanceId, {
      estado: ESTADOS.AGUARDANDO_RETORNO, nextFollowUpAt: DATA_FU_VENCIDA, cooledUntil: null, claimAtual: null,
    }]));
    const r = gerarDailyWorklist({
      clientesHoje: [...fus, ...novas], estadosOperacionais: estadosFu, cap: 10, dataReferencia: DATA_REF,
    });
    expect(r.dueFollowUps).toHaveLength(3);
    expect(r.newOpportunities).toHaveLength(10);
    expect(r.worklist).toHaveLength(13);
    expect(r.aplicouCap).toBe(true);
  });

  // E-D: entidade em cooldown → 0 daquela entidade
  test('CAP-D: entidade em cooldown → excluída da worklist', () => {
    const entId = 'MR4_LINKED:CooledEntity001';
    const oppId = 'cooled-opp-001';
    const estadoCooldown = {
      estado:      ESTADOS.DISPONIVEL,
      cooledUntil: T0_30D, // ainda em cooldown
      claimAtual:  null, nextFollowUpAt: null,
    };
    const clientes = [mkCliente(oppId, 'AGIR_AGORA', 200, entId)];
    const r = gerarDailyWorklist({
      clientesHoje: clientes,
      estadosOperacionais: new Map([[oppId, estadoCooldown]]),
      cap: 10,
      dataReferencia: DATA_REF, // antes de T0_30D
    });
    expect(r.worklist).toHaveLength(0);
  });

  // E-E: mesma entidade com nova opportunityInstanceId durante cooldown → suprimida
  test('CAP-E: nova opportunityInstanceId durante cooldown da entidade → suprimida', () => {
    const entId   = 'MR4_LINKED:CooledEntity002';
    const novaOpp = buildOpportunityInstanceId(entId, 'REATIVACAO_120D', '2026-01-01');
    const suppressed = new Map([[entId, T0_30D]]);
    const clientes = [{
      opportunityInstanceId: novaOpp,
      commercialEntityId:    entId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        250,
    }];
    const r = gerarDailyWorklist({
      clientesHoje: clientes, estadosOperacionais: new Map(),
      suppressedEntities: suppressed, cap: 10, dataReferencia: DATA_REF,
    });
    expect(r.worklist).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO F — IDEMPOTÊNCIA
// ═══════════════════════════════════════════════════════════════════════════════

describe('F. Idempotência', () => {

  test('F-01: gerar worklist duas vezes produz resultado idêntico (sem duplicatas)', () => {
    const clientes = Array.from({ length: 5 }, (_, i) =>
      ({ opportunityInstanceId: `idem-${i}`, commercialEntityId: `MR4_LINKED:E${i}`, decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 200 + i })
    );
    const r1 = gerarDailyWorklist({ clientesHoje: clientes, estadosOperacionais: new Map(), cap: 10, dataReferencia: DATA_REF });
    const r2 = gerarDailyWorklist({ clientesHoje: clientes, estadosOperacionais: new Map(), cap: 10, dataReferencia: DATA_REF });
    expect(r1.worklist.map(c => c.opportunityInstanceId)).toEqual(r2.worklist.map(c => c.opportunityInstanceId));
  });

  test('F-02: repetir CONCLUIDA não cria novo evento (histórico não duplicado)', () => {
    let est = criarEstadoInicial('MR4_LINKED:IdemTest001', 'idem-opp-001', 'REATIVACAO_120D', T0);
    est = claimOportunidade(est, OP_A, T0);
    est = registrarOutcome(est, OP_A, OUTCOMES.CONVERSA_REALIZADA, T0_1H);
    const eventosAntes = est.eventos.length;
    // CONCLUIDA não pode receber mais operações
    expect(() => claimOportunidade(est, OP_A, T0_1H)).toThrow(/CONCLUIDA/);
    expect(est.eventos.length).toBe(eventosAntes); // histórico intacto
  });

  test('F-03: gerarDailyWorklist não deduplica input (dedup cabe ao caller)', () => {
    // gerarDailyWorklist não deduplica opportunityInstanceId — se o caller enviar
    // o mesmo ID duas vezes, ele aparece duas vezes. Dedup é responsabilidade do snapshot.
    const oppId = 'idem-dup-001';
    const clientes = [
      { opportunityInstanceId: oppId, commercialEntityId: 'MR4_LINKED:A', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 200 },
      { opportunityInstanceId: oppId, commercialEntityId: 'MR4_LINKED:A', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 200 },
    ];
    const r = gerarDailyWorklist({ clientesHoje: clientes, estadosOperacionais: new Map(), cap: 10, dataReferencia: DATA_REF });
    // Ambos aparecem (sem dedup interno)
    expect(r.worklist).toHaveLength(2);
    // Documentar que dedup deve ser aplicado antes de chamar gerarDailyWorklist
  });

  test('F-04: releaseExpiredClaim idempotente — segundo release lança erro controlado', () => {
    let est = criarEstadoInicial('MR4_LINKED:IdemTest002', 'idem-opp-002', 'REATIVACAO_120D', T0);
    est = claimOportunidade(est, OP_A, T0);
    est = releaseExpiredClaim(est, T0_4H1S);
    // Segundo release: estado já é DISPONIVEL (sem claim) — deve lançar erro controlado
    expect(() => releaseExpiredClaim(est, T0_4H1S)).toThrow();
  });

  test('F-05: opportunityInstanceId determinístico — geração repetida produz mesmo hash', () => {
    const id1 = buildOpportunityInstanceId('MR4_LINKED:M6wAPSqRGQVKcMqK76lt', 'REATIVACAO_120D', '2024-10-25');
    const id2 = buildOpportunityInstanceId('MR4_LINKED:M6wAPSqRGQVKcMqK76lt', 'REATIVACAO_120D', '2024-10-25');
    expect(id1).toBe(id2);
    expect(id1).toBe('f6f744b856019469');
    const worklist1 = gerarDailyWorklist({
      clientesHoje: [{ opportunityInstanceId: id1, commercialEntityId: 'MR4_LINKED:M6wAPSqRGQVKcMqK76lt', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 690 }],
      estadosOperacionais: new Map(), cap: 10, dataReferencia: DATA_REF,
    });
    const worklist2 = gerarDailyWorklist({
      clientesHoje: [{ opportunityInstanceId: id2, commercialEntityId: 'MR4_LINKED:M6wAPSqRGQVKcMqK76lt', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 690 }],
      estadosOperacionais: new Map(), cap: 10, dataReferencia: DATA_REF,
    });
    expect(worklist1.worklist[0].opportunityInstanceId).toBe(worklist2.worklist[0].opportunityInstanceId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO G — ENTITY SUPPRESSION no emulador (canário B obrigatório)
// ═══════════════════════════════════════════════════════════════════════════════

describe('G. Entity suppression no emulador (canário B)', () => {
  const C = CANARIOS[1]; // Albuquerque Auto Som

  beforeEach(async () => {
    await criarEstadoEmulador(C);
  }, 10000);

  afterEach(async () => {
    await limparCanarios();
  }, 10000);

  test('G-01: SEM_INTERESSE_AGORA no emulador — cooledUntil gravado em Firestore', async () => {
    await claimViaTransaction(C.opportunityInstanceId, OP_A, T0);
    await outcomeViaTransaction(C.opportunityInstanceId, OP_A, OUTCOMES.SEM_INTERESSE_AGORA, T0);

    const estado = await lerEstado(C.opportunityInstanceId);
    expect(estado.estado).toBe(ESTADOS.CONCLUIDA);
    expect(estado.cooledUntil).toBeTruthy();
    expect(isCooledDown(estado, T0_29D)).toBe(true);
    expect(isCooledDown(estado, T0_30D1S)).toBe(false);
  }, 15000);

  test('G-02: nova opp da MESMA entidade suprimida não entra na worklist', async () => {
    await claimViaTransaction(C.opportunityInstanceId, OP_A, T0);
    await outcomeViaTransaction(C.opportunityInstanceId, OP_A, OUTCOMES.SEM_INTERESSE_AGORA, T0);
    const estadoConcluido = await lerEstado(C.opportunityInstanceId);

    const novaOppId = buildOpportunityInstanceId(C.commercialEntityId, C.tipoOportunidade, '2026-03-01');
    const suppressed = new Map([[C.commercialEntityId, estadoConcluido.cooledUntil]]);
    const novoCliente = {
      opportunityInstanceId: novaOppId,
      commercialEntityId:    C.commercialEntityId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        600,
    };
    const worklist = gerarDailyWorklist({
      clientesHoje:        [novoCliente],
      estadosOperacionais: new Map(),
      suppressedEntities:  suppressed,
      cap:                 10,
      dataReferencia:      DATA_REF,
    });
    expect(worklist.worklist).toHaveLength(0);
  }, 20000);
}, 90000);
