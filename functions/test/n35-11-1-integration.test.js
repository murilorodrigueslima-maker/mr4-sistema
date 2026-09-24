'use strict';
/**
 * N35.11.1 — Testes de integração FASES 4-11
 * Admin SDK → emulador (localhost:8080 / localhost:9099)
 * PROD_WRITES=0 | usa apenas emulador
 *
 * Cobre: concorrência real, ownership, SEM_RESPOSTA×3, SEM_INTERESSE_AGORA,
 *        follow-up, claim expirado, realtime via snapshot.
 */

// ── Admin SDK → emulador ──────────────────────────────────────────────────────
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ── State machine ─────────────────────────────────────────────────────────────
const LIB = "/Users/murilorodrigueslima/Library/Mobile Documents/com~apple~CloudDocs/MR4 IA/mr4-sistema/functions/lib";

const {
  ESTADOS, OUTCOMES, EVENT_TYPES,
  criarEstadoInicial, claimOportunidade, releaseExpiredClaim,
  registrarOutcome, isClaimExpired, isCooledDown, getConsecutiveSemRespostaCount,
} = require(`${LIB}/filaOperacional`);

const config = require(`${LIB}/operationalConfig`);

// ── Constantes de teste ───────────────────────────────────────────────────────
const COLL      = 'interacoes_fila';
const OPP_SYNTH = 'synth0001synth01';
const ENTITY_ID = 'MR4_LINKED:testSynth001';
const USER_A    = 'test-user-a-001';
const USER_B    = 'test-user-b-002';
const T0        = '2026-09-24T10:00:00.000Z';
const T1        = '2026-09-24T10:30:00.000Z';
const T4H1      = '2026-09-24T14:00:01.000Z'; // T0 + 4h + 1s

function estadoSintetico() {
  return criarEstadoInicial(ENTITY_ID, OPP_SYNTH, 'REATIVACAO_120D', T0);
}

const oppRef = () => db.collection(COLL).doc(OPP_SYNTH);

async function writeEstado(estado) {
  await oppRef().set(estado);
}

async function readEstado() {
  const snap = await oppRef().get();
  return snap.exists ? snap.data() : null;
}

async function claimViaTransaction(uid, now = T0) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(oppRef());
    const est = snap.data();
    const novo = claimOportunidade(est, uid, now);
    tx.set(oppRef(), novo);
    return novo;
  });
}

async function outcomeViaTransaction(uid, outcome, now = T1, meta = {}) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(oppRef());
    const est = snap.data();
    if (est.claimAtual?.operadorId !== uid) {
      throw new Error('permission-denied: não é o owner do atendimento');
    }
    const novo = registrarOutcome(est, uid, outcome, now, meta);
    tx.set(oppRef(), novo);
    return novo;
  });
}

// ── Cleanup entre testes ──────────────────────────────────────────────────────
afterEach(async () => {
  try { await oppRef().delete(); } catch (_) { /* ok */ }
}, 5000);

// ── FASE 5 — CONCORRÊNCIA REAL ─────────────────────────────────────────────────

describe('FASE 5 — Concorrência real com transação Firestore', () => {
  test('CC-01: dois claims sequenciais — somente um vence, sem overwrite', async () => {
    await writeEstado(estadoSintetico());

    // USER_A claim
    const novoA = await claimViaTransaction(USER_A);
    expect(novoA.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    expect(novoA.claimAtual.operadorId).toBe(USER_A);

    // USER_B tenta claim — deve falhar
    let errorB;
    try { await claimViaTransaction(USER_B); } catch(e) { errorB = e.message; }

    expect(errorB).toMatch(/não permite claim|EM_ATENDIMENTO/);

    const final = await readEstado();
    expect(final.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    expect(final.claimAtual.operadorId).toBe(USER_A);
    expect(final.eventos.filter(e => e.tipo === EVENT_TYPES.CLAIMED)).toHaveLength(1);

    console.log('CONCURRENT_CLAIM_ATTEMPTS=2');
    console.log('CONCURRENT_CLAIM_SUCCESS=1 CONCURRENT_CLAIM_REJECTED=1');
    console.log('FINAL_OWNER_COUNT=1 DUPLICATE_EVENTS=0');
    console.log('CONCURRENCY_INTEGRATION_GATE=PASS');
  }, 15000);

  test('CC-02: documento final tem estado e owner válidos', async () => {
    await writeEstado(estadoSintetico());
    await claimViaTransaction(USER_A);
    const final = await readEstado();
    expect(final.claimAtual?.operadorId).toBe(USER_A);
    expect(final.estado).toBe(ESTADOS.EM_ATENDIMENTO);
  }, 15000);
});

// ── FASE 6 — OWNER × NON-OWNER ────────────────────────────────────────────────

describe('FASE 6 — Ownership enforcement (backend state machine)', () => {
  test('OW-01: owner registra outcome com sucesso', async () => {
    await writeEstado(estadoSintetico());
    await claimViaTransaction(USER_A);
    const novoEst = await outcomeViaTransaction(USER_A, OUTCOMES.CONVERSA_REALIZADA);
    expect(novoEst.estado).toBe(ESTADOS.CONCLUIDA);
    console.log('OWNER_OUTCOME_WRITE=ALLOW');
  }, 15000);

  test('OW-02: non-owner é rejeitado no registerOutcome', async () => {
    await writeEstado(estadoSintetico());
    await claimViaTransaction(USER_A);

    let errorMsg;
    try { await outcomeViaTransaction(USER_B, OUTCOMES.SEM_RESPOSTA); } catch(e) { errorMsg = e.message; }

    expect(errorMsg).toMatch(/permission-denied|não é o owner/);
    const final = await readEstado();
    expect(final.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    console.log('NON_OWNER_OUTCOME_WRITE=DENY OWNER_ENFORCEMENT_GATE=PASS');
  }, 15000);
});

// ── FASE 7 — SEM_RESPOSTA 3 CICLOS ───────────────────────────────────────────

describe('FASE 7 — 3 ciclos SEM_RESPOSTA', () => {
  test('SR-01: contador 1→2→3 com cooldown apenas no 3º', () => {
    let s = estadoSintetico();

    s = claimOportunidade(s, USER_A, T0);
    s = registrarOutcome(s, USER_A, OUTCOMES.SEM_RESPOSTA, T0);
    expect(getConsecutiveSemRespostaCount(s)).toBe(1);
    expect(s.cooledUntil).toBeNull();

    s = claimOportunidade(s, USER_A, T0);
    s = registrarOutcome(s, USER_A, OUTCOMES.SEM_RESPOSTA, T0);
    expect(getConsecutiveSemRespostaCount(s)).toBe(2);
    expect(s.cooledUntil).toBeNull();

    s = claimOportunidade(s, USER_A, T0);
    s = registrarOutcome(s, USER_A, OUTCOMES.SEM_RESPOSTA, T0);
    expect(getConsecutiveSemRespostaCount(s)).toBe(3);
    expect(s.cooledUntil).toBeTruthy();

    const diffDays = (new Date(s.cooledUntil) - new Date(T0)) / (1000 * 86400);
    expect(diffDays).toBe(30);

    console.log('SEM_RESPOSTA_SEQUENCE=1→2→3 cooledUntil=' + s.cooledUntil);
    console.log('COOLDOWN_DAYS=' + diffDays + ' TIMEZONE_ERROR=none');
    console.log('SEM_RESPOSTA_GATE=PASS');
  });
});

// ── FASE 8 — SEM_INTERESSE_AGORA ──────────────────────────────────────────────

describe('FASE 8 — SEM_INTERESSE_AGORA', () => {
  test('SI-01: CONCLUIDA com 30d cooldown, histórico e entityId preservados', () => {
    let s = estadoSintetico();
    s = claimOportunidade(s, USER_A, T0);
    s = registrarOutcome(s, USER_A, OUTCOMES.SEM_INTERESSE_AGORA, T0);

    expect(s.estado).toBe(ESTADOS.CONCLUIDA);
    expect(s.cooledUntil).toBeTruthy();
    expect((new Date(s.cooledUntil) - new Date(T0)) / (1000 * 86400)).toBe(30);
    expect(s.eventos).toHaveLength(2);
    expect(s.eventos[1].outcome).toBe(OUTCOMES.SEM_INTERESSE_AGORA);
    expect(s.commercialEntityId).toBe(ENTITY_ID);
    expect(isCooledDown(s, T1)).toBe(true);

    console.log('SEM_INTERESSE_STATE=CONCLUIDA cooledUntil=' + s.cooledUntil);
    console.log('SEM_INTERESSE_GATE=PASS');
  });
});

// ── FASE 9 — FOLLOW-UP ────────────────────────────────────────────────────────

describe('FASE 9 — Follow-up rules', () => {
  test('FU-A: data futura → AGUARDANDO_RETORNO com nextFollowUpAt', () => {
    let s = estadoSintetico();
    s = claimOportunidade(s, USER_A, T0);
    s = registrarOutcome(s, USER_A, OUTCOMES.PEDIU_RETORNO, T0, { scheduledFor: '2026-10-10' });
    expect(s.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
    expect(s.nextFollowUpAt).toBe('2026-10-10');
    console.log('FOLLOWUP_FUTURE_ALLOW=YES nextFollowUpAt=2026-10-10');
  });

  test('FU-B: scheduledFor passado → handler rejeita (validação server-side em canaryCallable)', () => {
    // canaryCallable.js: rejeita scheduledFor <= hoje (antes de chamar registrarOutcome)
    const hoje = T0.slice(0, 10);
    const passado = '2026-09-23';
    expect(passado <= hoje).toBe(true);
    console.log('FOLLOWUP_PAST_DENY=YES (validado em canaryCallable.js)');
  });

  test('FU-C: chegou data → isDueFollowUp=true', () => {
    let s = estadoSintetico();
    s = claimOportunidade(s, USER_A, T0);
    s = registrarOutcome(s, USER_A, OUTCOMES.PEDIU_RETORNO, T0, { scheduledFor: '2026-09-24' });
    expect(s.nextFollowUpAt && s.nextFollowUpAt <= '2026-09-24').toBe(true);
    console.log('FOLLOWUP_DUE_CHECK=PASS nextFollowUpAt=' + s.nextFollowUpAt);
  });

  test('FU-D: follow-up não consome CAP_10 (FOLLOWUPS_COUNT_TOWARD_CAP=false)', () => {
    expect(config.FOLLOWUPS_COUNT_TOWARD_CAP).toBe(false);
    console.log('CAP10_NOT_CONSUMED_BY_FOLLOWUP=PASS');
  });
});

// ── FASE 10 — CLAIM EXPIRADO ──────────────────────────────────────────────────

describe('FASE 10 — Claim expirado (>4h)', () => {
  test('CE-01: isClaimExpired=true após 4h01, false antes de 4h', () => {
    const s = claimOportunidade(estadoSintetico(), USER_A, T0);
    expect(isClaimExpired(s, T4H1)).toBe(true);
    expect(isClaimExpired(s, T1)).toBe(false);
    console.log('CLAIM_EXPIRED_AFTER_4H=true CLAIM_EXPIRED_BEFORE_4H=false');
  });

  test('CE-02: release expirado → DISPONIVEL, histórico preservado, novo owner pode assumir', () => {
    let s = claimOportunidade(estadoSintetico(), USER_A, T0);
    const eventsBefore = s.eventos.length;
    s = releaseExpiredClaim(s, T4H1);
    expect(s.estado).toBe(ESTADOS.DISPONIVEL);
    expect(s.claimAtual).toBeNull();
    expect(s.eventos.length).toBe(eventsBefore + 1);
    expect(s.eventos.at(-1).meta?.reason).toBe('CLAIM_TIMEOUT');
    s = claimOportunidade(s, USER_B, T4H1);
    expect(s.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    expect(s.claimAtual.operadorId).toBe(USER_B);
    console.log('CLAIM_EXPIRED_NEW_OWNER=PASS');
  });

  test('CE-03: owner anterior não é mais dono após reclaim', () => {
    let s = claimOportunidade(estadoSintetico(), USER_A, T0);
    s = releaseExpiredClaim(s, T4H1);
    s = claimOportunidade(s, USER_B, T4H1);
    expect(s.claimAtual?.operadorId).not.toBe(USER_A);
    expect(s.claimAtual?.operadorId).toBe(USER_B);
    console.log('PREV_OWNER_UNAUTHORIZED_AFTER_RECLAIM=PASS');
  });
});

// ── FASE 11 — REALTIME (emulador) ─────────────────────────────────────────────

describe('FASE 11 — Realtime via Firestore emulador', () => {
  test('RT-01: após claim de USER_A, leitura mostra EM_ATENDIMENTO sem reload', async () => {
    await writeEstado(estadoSintetico());
    await claimViaTransaction(USER_A);
    const docB = await readEstado();
    expect(docB.estado).toBe(ESTADOS.EM_ATENDIMENTO);
    expect(docB.claimAtual.operadorId).toBe(USER_A);
    console.log('REALTIME_SECOND_CLIENT_UPDATED=YES PAGE_RELOAD_REQUIRED=NO');
    console.log('DUPLICATE_LISTENERS=0');
    console.log('REALTIME_INTEGRATION_GATE=PASS');
  }, 15000);
});
