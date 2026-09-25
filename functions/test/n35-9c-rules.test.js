'use strict';
// N35.9C — Testes das Regras Operacionais V1
// Decisões aprovadas por Murilo (2026-09-24):
//   1. SEM_INTERESSE_AGORA → cooldown 30 dias
//   2. 3× SEM_RESPOSTA consecutivos → cooldown 30 dias
//   3. CLAIM_TIMEOUT_HOURS = 4
//   4. FOLLOWUPS_COUNT_TOWARD_CAP = false
//
// INVARIANTES: OPENAI_CALLS=0, PROD_WRITES=0, I/O=0

const path = require('path');
const LIB  = path.join(__dirname, '..', 'lib');

const {
  ESTADOS,
  OUTCOMES,
  EVENT_TYPES,
  criarEstadoInicial,
  claimOportunidade,
  releaseOportunidade,
  releaseExpiredClaim,
  registrarOutcome,
  getConsecutiveSemRespostaCount,
  isClaimExpired,
  isCooledDown,
  getCooledUntil,
} = require(path.join(LIB, 'filaOperacional'));

const {
  WORKLIST_CAP,
  isDueFollowUp,
  gerarDailyWorklist,
} = require(path.join(LIB, 'dailyWorklist'));

const config = require(path.join(LIB, 'operationalConfig'));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMM_ID = 'MR4_LINKED:abc123def456789012'; // 20-char base62
const OPP_ID  = 'a1b2c3d4e5f60001';
const OP      = 'op-001';
const T0      = '2026-09-24T10:00:00.000Z';
const T0_PLUS_1H  = '2026-09-24T11:00:00.000Z';
const T0_PLUS_3H59 = '2026-09-24T13:59:59.000Z';
const T0_PLUS_4H   = '2026-09-24T14:00:00.000Z';
const T0_PLUS_4H1S = '2026-09-24T14:00:01.000Z';

// 30 dias após T0
const T0_PLUS_29D = '2026-10-23T10:00:00.000Z';
const T0_PLUS_30D = '2026-10-24T10:00:00.000Z';  // exatamente no limite
const T0_PLUS_30D1S = '2026-10-24T10:00:01.000Z'; // 1s após o limite

function makeState() {
  return criarEstadoInicial(COMM_ID, OPP_ID, 'REATIVACAO_120D', T0);
}

function makeClaimed(estado, op = OP, t = T0) {
  return claimOportunidade(estado, op, t);
}

function makeOutcome(estado, outcome, op = OP, t = T0, meta = {}) {
  return registrarOutcome(estado, op, outcome, t, meta);
}

// ── GRUPO 1: Config ───────────────────────────────────────────────────────────

describe('N35-9C-CFG — Configuração operacional V1', () => {

  test('N35-9C-CFG-01: SEM_INTERESSE_COOLDOWN_DAYS = 30', () => {
    expect(config.SEM_INTERESSE_COOLDOWN_DAYS).toBe(30);
  });

  test('N35-9C-CFG-02: SEM_RESPOSTA_MAX_CONSECUTIVE = 3, COOLDOWN_DAYS = 30', () => {
    expect(config.SEM_RESPOSTA_MAX_CONSECUTIVE).toBe(3);
    expect(config.SEM_RESPOSTA_COOLDOWN_DAYS).toBe(30);
  });

  test('N35-9C-CFG-03: CLAIM_TIMEOUT_HOURS = 4, FOLLOWUPS_COUNT_TOWARD_CAP = false, CAP = 10', () => {
    expect(config.CLAIM_TIMEOUT_HOURS).toBe(4);
    expect(config.FOLLOWUPS_COUNT_TOWARD_CAP).toBe(false);
    expect(config.DAILY_NEW_OPPORTUNITY_CAP).toBe(10);
  });

});

// ── GRUPO 2: SEM_INTERESSE_AGORA cooldown ─────────────────────────────────────

describe('N35-9C-SI — Cooldown SEM_INTERESSE_AGORA', () => {

  test('N35-9C-SI-01: SEM_INTERESSE_AGORA → cooledUntil definido (~30 dias)', () => {
    const s0 = makeClaimed(makeState());
    const s1 = makeOutcome(s0, OUTCOMES.SEM_INTERESSE_AGORA, OP, T0);

    expect(s1.estado).toBe(ESTADOS.CONCLUIDA);
    expect(s1.cooledUntil).toBeTruthy();

    // 30 dias ≈ 2592000000 ms
    const elapsed = new Date(s1.cooledUntil).getTime() - new Date(T0).getTime();
    expect(elapsed).toBeGreaterThanOrEqual(30 * 24 * 3600 * 1000 - 1000);
    expect(elapsed).toBeLessThanOrEqual(30 * 24 * 3600 * 1000 + 1000);
  });

  test('N35-9C-SI-02: isCooledDown true dentro dos 30 dias', () => {
    const s0 = makeClaimed(makeState());
    const s1 = makeOutcome(s0, OUTCOMES.SEM_INTERESSE_AGORA, OP, T0);

    expect(isCooledDown(s1, T0_PLUS_29D)).toBe(true);
    expect(isCooledDown(s1, T0)).toBe(true); // imediatamente após
  });

  test('N35-9C-SI-03: isCooledDown false após 30 dias (exatamente no limite e 1s depois)', () => {
    const s0 = makeClaimed(makeState());
    const s1 = makeOutcome(s0, OUTCOMES.SEM_INTERESSE_AGORA, OP, T0);

    // No limite exato: não está mais em cooldown (>=)
    expect(isCooledDown(s1, T0_PLUS_30D)).toBe(false);
    // 1s depois: não está em cooldown
    expect(isCooledDown(s1, T0_PLUS_30D1S)).toBe(false);
  });

  test('N35-9C-SI-04: getCooledUntil retorna o timestamp de expiração', () => {
    const s0 = makeClaimed(makeState());
    const s1 = makeOutcome(s0, OUTCOMES.SEM_INTERESSE_AGORA, OP, T0);

    expect(getCooledUntil(s1)).toBe(s1.cooledUntil);
    expect(typeof s1.cooledUntil).toBe('string');
  });

  test('N35-9C-SI-05: getCooledUntil retorna null quando sem cooldown', () => {
    const s0 = makeState();
    expect(getCooledUntil(s0)).toBeNull();
  });

});

// ── GRUPO 3: SEM_RESPOSTA consecutivos ───────────────────────────────────────

describe('N35-9C-SR — Cooldown 3× SEM_RESPOSTA consecutivos', () => {

  function doNCycles(n, outcome = OUTCOMES.SEM_RESPOSTA) {
    let s = makeState();
    for (let i = 0; i < n; i++) {
      s = makeClaimed(s, OP, T0);
      s = makeOutcome(s, outcome, OP, T0);
    }
    return s;
  }

  test('N35-9C-SR-01: 1× SEM_RESPOSTA → sem cooldown', () => {
    const s = doNCycles(1);
    expect(s.estado).toBe(ESTADOS.DISPONIVEL);
    expect(s.cooledUntil).toBeNull();
  });

  test('N35-9C-SR-02: 2× SEM_RESPOSTA consecutivos → sem cooldown', () => {
    const s = doNCycles(2);
    expect(s.estado).toBe(ESTADOS.DISPONIVEL);
    expect(s.cooledUntil).toBeNull();
  });

  test('N35-9C-SR-03: 3× SEM_RESPOSTA consecutivos → cooledUntil definido', () => {
    const s = doNCycles(3);
    expect(s.estado).toBe(ESTADOS.DISPONIVEL);
    expect(s.cooledUntil).toBeTruthy();

    const elapsed = new Date(s.cooledUntil).getTime() - new Date(T0).getTime();
    expect(elapsed).toBeGreaterThanOrEqual(30 * 24 * 3600 * 1000 - 1000);
  });

  test('N35-9C-SR-04: claimOportunidade lança quando cooled (3× SEM_RESPOSTA)', () => {
    const s = doNCycles(3);
    expect(isCooledDown(s, T0_PLUS_1H)).toBe(true);
    expect(() => claimOportunidade(s, OP, T0_PLUS_1H))
      .toThrow(/em cooldown/);
  });

  test('N35-9C-SR-05: CONVERSA_REALIZADA reseta sequência (→ CONCLUIDA, count=0 no próximo)', () => {
    let s = makeState();
    // 2× SEM_RESPOSTA
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    // CONVERSA_REALIZADA quebra a sequência → CONCLUIDA
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.CONVERSA_REALIZADA);
    expect(s.estado).toBe(ESTADOS.CONCLUIDA);

    // Contar apenas os OUTCOME_REGISTERED, o consecutivo seria 0 pois CONVERSA_REALIZADA veio por último
    expect(getConsecutiveSemRespostaCount(s)).toBe(0);
  });

  test('N35-9C-SR-06: PEDIU_RETORNO reseta sequência de SEM_RESPOSTA', () => {
    let s = makeState();
    // 2× SEM_RESPOSTA
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    // PEDIU_RETORNO quebra a sequência
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.PEDIU_RETORNO, OP, T0, { scheduledFor: '2026-10-24' });
    expect(s.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);

    // Contagem consecutiva: o último outcome é PEDIU_RETORNO → count = 0
    expect(getConsecutiveSemRespostaCount(s)).toBe(0);
    // Sem cooldown (2 < 3)
    expect(s.cooledUntil).toBeNull();
  });

  test('N35-9C-SR-07: SEM_RESPOSTA após resetar sequência conta novamente a partir de 1', () => {
    let s = makeState();
    // 2× SEM_RESPOSTA
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    // PEDIU_RETORNO → quebra sequência
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.PEDIU_RETORNO, OP, T0, { scheduledFor: '2026-10-24' });
    // Claim novamente → 1× SEM_RESPOSTA
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);

    // count = 1 (apenas o último SEM_RESPOSTA, após quebra por PEDIU_RETORNO)
    expect(getConsecutiveSemRespostaCount(s)).toBe(1);
    // Sem cooldown (1 < 3)
    expect(s.cooledUntil).toBeNull();
  });

  test('N35-9C-SR-08: claimOportunidade sucesso após expirar cooldown de 3× SEM_RESPOSTA', () => {
    const s = doNCycles(3);
    expect(isCooledDown(s, T0_PLUS_29D)).toBe(true);
    // Após expirar
    expect(isCooledDown(s, T0_PLUS_30D)).toBe(false);
    // Deve poder fazer claim
    expect(() => claimOportunidade(s, OP, T0_PLUS_30D)).not.toThrow();
  });

});

// ── GRUPO 4: Claim timeout ───────────────────────────────────────────────────

describe('N35-9C-CT — Claim timeout (CLAIM_TIMEOUT_HOURS=4)', () => {

  test('N35-9C-CT-01: 3h59m59s não está expirado', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    expect(isClaimExpired(s1, T0_PLUS_3H59)).toBe(false);
  });

  test('N35-9C-CT-02: exatamente 4h está expirado (boundary: >= 4h = expirado)', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    expect(isClaimExpired(s1, T0_PLUS_4H)).toBe(true);
  });

  test('N35-9C-CT-03: 4h01s está expirado', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    expect(isClaimExpired(s1, T0_PLUS_4H1S)).toBe(true);
  });

  test('N35-9C-CT-04: isClaimExpired retorna false quando não é EM_ATENDIMENTO', () => {
    const s0 = makeState();
    expect(isClaimExpired(s0, T0_PLUS_4H1S)).toBe(false);
  });

  test('N35-9C-CT-05: releaseExpiredClaim → estado DISPONIVEL, preserva cooledUntil e nextFollowUpAt', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    // Simular que tinha follow-up e cooldown
    const s1WithData = {
      ...s1,
      cooledUntil:    null,
      nextFollowUpAt: null,
    };

    const s2 = releaseExpiredClaim(s1WithData, T0_PLUS_4H);
    expect(s2.estado).toBe(ESTADOS.DISPONIVEL);
    expect(s2.claimAtual).toBeNull();
    // Preservou os campos
    expect(s2.cooledUntil).toBeNull();
    expect(s2.nextFollowUpAt).toBeNull();
  });

  test('N35-9C-CT-06: releaseExpiredClaim adiciona evento RELEASED com meta CLAIM_TIMEOUT', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    const s2 = releaseExpiredClaim(s1, T0_PLUS_4H);

    const lastEvt = s2.eventos[s2.eventos.length - 1];
    expect(lastEvt.tipo).toBe(EVENT_TYPES.RELEASED);
    expect(lastEvt.meta).toEqual({ reason: 'CLAIM_TIMEOUT' });
    expect(lastEvt.operadorId).toBe(OP);
  });

  test('N35-9C-CT-07: releaseExpiredClaim lança quando claim ainda não expirou', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    expect(() => releaseExpiredClaim(s1, T0_PLUS_3H59))
      .toThrow(/ainda ativo/);
  });

  test('N35-9C-CT-08: após releaseExpiredClaim, novo claim é possível', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    const s2 = releaseExpiredClaim(s1, T0_PLUS_4H);
    expect(() => claimOportunidade(s2, 'op-002', T0_PLUS_4H1S)).not.toThrow();
  });

  test('N35-9C-CT-09: histórico de eventos preservado após releaseExpiredClaim', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0, OP, T0);
    const s2 = releaseExpiredClaim(s1, T0_PLUS_4H);

    // Deve ter o CLAIMED original + o RELEASED por timeout
    expect(s2.eventos).toHaveLength(2);
    expect(s2.eventos[0].tipo).toBe(EVENT_TYPES.CLAIMED);
    expect(s2.eventos[1].tipo).toBe(EVENT_TYPES.RELEASED);
  });

});

// ── GRUPO 5: Follow-ups fora do CAP ──────────────────────────────────────────

describe('N35-9C-FU — Follow-ups fora do CAP (FOLLOWUPS_COUNT_TOWARD_CAP=false)', () => {

  function makeClienteItem(id, decisao = 'AGIR_AGORA', dias = 100) {
    return {
      opportunityInstanceId: id,
      decisaoAcaoComercial:  decisao,
      diasSemComprar:        dias,
    };
  }

  function makeEstadoComFollowUp(oppId, scheduledFor) {
    let s = criarEstadoInicial('MR4_LINKED:' + oppId, oppId, 'REATIVACAO_120D', T0);
    s = makeClaimed(s);
    s = makeOutcome(s, OUTCOMES.PEDIU_RETORNO, OP, T0, { scheduledFor });
    return s;
  }

  test('N35-9C-FU-01: isDueFollowUp true quando nextFollowUpAt <= dataReferencia', () => {
    const est = makeEstadoComFollowUp('opp001', '2026-09-24'); // mesmo dia
    expect(isDueFollowUp(est, '2026-09-24')).toBe(true);
  });

  test('N35-9C-FU-02: isDueFollowUp true quando nextFollowUpAt anterior a dataReferencia', () => {
    const est = makeEstadoComFollowUp('opp001', '2026-09-20');
    expect(isDueFollowUp(est, '2026-09-24')).toBe(true);
  });

  test('N35-9C-FU-03: isDueFollowUp false quando nextFollowUpAt posterior a dataReferencia', () => {
    const est = makeEstadoComFollowUp('opp001', '2026-09-30');
    expect(isDueFollowUp(est, '2026-09-24')).toBe(false);
  });

  test('N35-9C-FU-04: isDueFollowUp false quando estado = null', () => {
    expect(isDueFollowUp(null, '2026-09-24')).toBe(false);
  });

  test('N35-9C-FU-05: isDueFollowUp false quando nextFollowUpAt ausente', () => {
    const s0 = makeState();
    expect(isDueFollowUp(s0, '2026-09-24')).toBe(false);
  });

  test('N35-9C-FU-06: 10 novas + 3 follow-ups → worklist tem 13 itens (todos)', () => {
    // 10 clientes novos (sem follow-up)
    const novos = Array.from({ length: 10 }, (_, i) =>
      makeClienteItem(`new${String(i).padStart(3, '0')}`)
    );
    // 3 clientes com follow-up vencido
    const followUpIds = ['fu001', 'fu002', 'fu003'];
    const followUpItems = followUpIds.map(id => makeClienteItem(id));
    const estadosFU = new Map(
      followUpIds.map(id => [id, makeEstadoComFollowUp(id, '2026-09-20')])
    );

    const estados = new Map([
      ...estadosFU,
    ]);

    const result = gerarDailyWorklist({
      clientesHoje:       [...novos, ...followUpItems],
      estadosOperacionais: estados,
      cap:                10,
      dataReferencia:     '2026-09-24',
    });

    expect(result.dueFollowUps).toHaveLength(3);
    expect(result.newOpportunities).toHaveLength(10);
    expect(result.worklist).toHaveLength(13);
    expect(result.aplicouCap).toBe(false); // exatamente 10 novas, sem overflow
  });

  test('N35-9C-FU-07: 5 novas + 12 follow-ups → worklist tem 17 itens', () => {
    const novos = Array.from({ length: 5 }, (_, i) =>
      makeClienteItem(`new${String(i).padStart(3, '0')}`)
    );
    const fuIds = Array.from({ length: 12 }, (_, i) => `fu${String(i).padStart(3, '0')}`);
    const fuItems = fuIds.map(id => makeClienteItem(id));
    const estadosFU = new Map(
      fuIds.map(id => [id, makeEstadoComFollowUp(id, '2026-09-20')])
    );

    const result = gerarDailyWorklist({
      clientesHoje:       [...novos, ...fuItems],
      estadosOperacionais: estadosFU,
      cap:                10,
      dataReferencia:     '2026-09-24',
    });

    expect(result.dueFollowUps).toHaveLength(12);
    expect(result.newOpportunities).toHaveLength(5);
    expect(result.worklist).toHaveLength(17);
    expect(result.aplicouCap).toBe(false); // 5 novas < 10
  });

  test('N35-9C-FU-08: CAP só se aplica a novas — 12 novas + 3 followups → cap=10, total=15, worklist=13', () => {
    const novos = Array.from({ length: 12 }, (_, i) =>
      makeClienteItem(`new${String(i).padStart(3, '0')}`)
    );
    const fuIds = ['fu001', 'fu002', 'fu003'];
    const fuItems = fuIds.map(id => makeClienteItem(id));
    const estadosFU = new Map(
      fuIds.map(id => [id, makeEstadoComFollowUp(id, '2026-09-20')])
    );

    const result = gerarDailyWorklist({
      clientesHoje:       [...novos, ...fuItems],
      estadosOperacionais: estadosFU,
      cap:                10,
      dataReferencia:     '2026-09-24',
    });

    expect(result.dueFollowUps).toHaveLength(3);
    expect(result.newOpportunities).toHaveLength(10); // capped
    expect(result.worklist).toHaveLength(13);          // 3 FU + 10 new
    expect(result.aplicouCap).toBe(true);
    expect(result.total).toBe(15); // 12 novas elegíveis + 3 FU
  });

});

// ── GRUPO 6: Backlog e fairness ──────────────────────────────────────────────

describe('N35-9C-BL — Backlog e fairness', () => {

  test('N35-9C-BL-01: backlog não perdido após CAP — itens excedentes ainda elegíveis', () => {
    const clientes = Array.from({ length: 20 }, (_, i) => ({
      opportunityInstanceId: `opp${String(i).padStart(3, '0')}`,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        100 - i,
    }));

    const result = gerarDailyWorklist({
      clientesHoje:       clientes,
      estadosOperacionais: new Map(),
      cap:                10,
      dataReferencia:     '2026-09-24',
    });

    expect(result.worklist).toHaveLength(10);
    // Os outros 10 ainda fazem parte do total elegível
    expect(result.total).toBe(20);
    expect(result.aplicouCap).toBe(true);
  });

  test('N35-9C-BL-02: ordering — AGIR_AGORA antes de PROGRAMAR_CICLO, diasSemComprar como tiebreak', () => {
    const clientes = [
      { opportunityInstanceId: 'opp1', decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasSemComprar: 90 },
      { opportunityInstanceId: 'opp2', decisaoAcaoComercial: 'AGIR_AGORA',      diasSemComprar: 60 },
      { opportunityInstanceId: 'opp3', decisaoAcaoComercial: 'AGIR_AGORA',      diasSemComprar: 80 },
    ];

    const result = gerarDailyWorklist({
      clientesHoje:       clientes,
      estadosOperacionais: new Map(),
      cap:                10,
      dataReferencia:     '2026-09-24',
    });

    expect(result.worklist[0].opportunityInstanceId).toBe('opp3'); // AGIR_AGORA + 80 dias
    expect(result.worklist[1].opportunityInstanceId).toBe('opp2'); // AGIR_AGORA + 60 dias
    expect(result.worklist[2].opportunityInstanceId).toBe('opp1'); // PROGRAMAR_CICLO
  });

  test('N35-9C-BL-03: opportunityInstanceId estável — mesmo ID em rodadas distintas', () => {
    const { buildOpportunityInstanceId } = require(path.join(LIB, 'commercialIdentity'));

    const commId = COMM_ID;
    const tipo   = 'REATIVACAO_120D';
    const anchor = '2026-01-15';

    const id1 = buildOpportunityInstanceId(commId, tipo, anchor);
    const id2 = buildOpportunityInstanceId(commId, tipo, anchor);

    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

});

// ── GRUPO 7: Suppressão de entidade e reentry ─────────────────────────────────

describe('N35-9C-EC — Edge cases e suppressedEntities', () => {

  test('N35-9C-EC-01: isCooledDown false quando cooledUntil = null', () => {
    const s0 = makeState();
    expect(isCooledDown(s0, T0)).toBe(false);
  });

  test('N35-9C-EC-02: getCooledUntil retorna null quando sem cooldown', () => {
    const s0 = makeState();
    expect(getCooledUntil(s0)).toBeNull();
  });

  test('N35-9C-EC-03: suppressedEntities exclui entidade da worklist', () => {
    const commId = 'MR4_LINKED:suppressed0000000002';
    const cliente = {
      opportunityInstanceId: 'opp-suppressed',
      commercialEntityId:    commId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        200,
    };

    const suppressedEntities = new Map([
      [commId, T0_PLUS_30D], // suprimida por 30 dias
    ]);

    const result = gerarDailyWorklist({
      clientesHoje:       [cliente],
      estadosOperacionais: new Map(),
      cap:                10,
      dataReferencia:     '2026-09-24',
      suppressedEntities,
    });

    expect(result.worklist).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test('N35-9C-EC-04: suppressedEntities expirada — entidade volta à worklist', () => {
    const commId = 'MR4_LINKED:suppressed0000000002';
    const cliente = {
      opportunityInstanceId: 'opp-suppressed',
      commercialEntityId:    commId,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        200,
    };

    // Supressão expirou ontem
    const suppressedEntities = new Map([
      [commId, '2026-09-23T23:59:59.000Z'],
    ]);

    const result = gerarDailyWorklist({
      clientesHoje:       [cliente],
      estadosOperacionais: new Map(),
      cap:                10,
      dataReferencia:     '2026-09-24',
      suppressedEntities,
    });

    expect(result.worklist).toHaveLength(1);
  });

  test('N35-9C-EC-05: nextFollowUpAt definido após PEDIU_RETORNO e limpo nos outros outcomes', () => {
    let s = makeState();
    s = makeClaimed(s);
    s = makeOutcome(s, OUTCOMES.PEDIU_RETORNO, OP, T0, { scheduledFor: '2026-10-15' });
    expect(s.nextFollowUpAt).toBe('2026-10-15');
    expect(s.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);

    // N35.14 D-RETRY: SEM_RESPOSTA (#1) agenda o próximo dia útil; CONVERSA_REALIZADA limpa
    s = makeClaimed(s);
    s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    expect(s.nextFollowUpAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.nextFollowUpAt).not.toBe('2026-10-15');
    s = makeClaimed(s);
    s = makeOutcome(s, OUTCOMES.CONVERSA_REALIZADA);
    expect(s.nextFollowUpAt).toBeNull();
  });

  test('N35-9C-EC-06: PEDIU_RETORNO sem meta.scheduledFor → nextFollowUpAt = null', () => {
    let s = makeState();
    s = makeClaimed(s);
    s = makeOutcome(s, OUTCOMES.PEDIU_RETORNO, OP, T0); // sem meta.scheduledFor
    expect(s.nextFollowUpAt).toBeNull();
    expect(s.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
  });

  test('N35-9C-EC-07: reentry — ambos cooldowns atuam independentemente', () => {
    // SEM_INTERESSE → cooledUntil (30d)
    let s = makeState();
    s = makeClaimed(s, OP, T0);
    s = makeOutcome(s, OUTCOMES.SEM_INTERESSE_AGORA, OP, T0);
    const cuSI = s.cooledUntil;
    expect(cuSI).toBeTruthy();
    expect(s.estado).toBe(ESTADOS.CONCLUIDA);

    // Numa nova instância, 3× SEM_RESPOSTA → cooledUntil diferente
    const T1 = '2026-09-28T10:00:00.000Z';
    let s2 = criarEstadoInicial(COMM_ID, 'a1b2c3d4e5f60002', 'REATIVACAO_120D', T1);
    s2 = makeClaimed(s2, OP, T1);
    s2 = makeOutcome(s2, OUTCOMES.SEM_RESPOSTA, OP, T1);
    s2 = makeClaimed(s2, OP, T1);
    s2 = makeOutcome(s2, OUTCOMES.SEM_RESPOSTA, OP, T1);
    s2 = makeClaimed(s2, OP, T1);
    s2 = makeOutcome(s2, OUTCOMES.SEM_RESPOSTA, OP, T1);

    expect(s2.cooledUntil).toBeTruthy();
    // Os dois cooledUntil são independentes (instâncias diferentes)
    expect(s2.cooledUntil).not.toBe(cuSI);
    expect(s2.estado).toBe(ESTADOS.DISPONIVEL);
    expect(isCooledDown(s2, T1)).toBe(true);
  });

  test('N35-9C-EC-08: criarEstadoInicial possui cooledUntil=null e nextFollowUpAt=null', () => {
    const s0 = makeState();
    expect(s0.cooledUntil).toBeNull();
    expect(s0.nextFollowUpAt).toBeNull();
  });

  test('N35-9C-EC-09: worklist exclui item com cooledUntil ativo (3× SEM_RESPOSTA cooling)', () => {
    // Criar estado com cooldown ativo (3× SEM_RESPOSTA)
    let s = makeState();
    s = makeClaimed(s, OP, T0); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA, OP, T0);
    s = makeClaimed(s, OP, T0); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA, OP, T0);
    s = makeClaimed(s, OP, T0); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA, OP, T0);
    expect(s.cooledUntil).toBeTruthy();

    const cliente = {
      opportunityInstanceId: OPP_ID,
      decisaoAcaoComercial:  'AGIR_AGORA',
      diasSemComprar:        150,
    };

    const estados = new Map([[OPP_ID, s]]);

    const result = gerarDailyWorklist({
      clientesHoje:       [cliente],
      estadosOperacionais: estados,
      cap:                10,
      // dataReferencia dentro do cooldown (30 dias de T0 = 2026-10-24)
      dataReferencia:     '2026-09-25',
    });

    expect(result.worklist).toHaveLength(0);
  });

  test('N35-9C-EC-10: getConsecutiveSemRespostaCount conta corretamente sequência mista', () => {
    let s = makeState();
    // 2× SEM_RESPOSTA, PEDIU_RETORNO, 2× SEM_RESPOSTA
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.PEDIU_RETORNO, OP, T0, { scheduledFor: '2026-10-01' });
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);
    s = makeClaimed(s); s = makeOutcome(s, OUTCOMES.SEM_RESPOSTA);

    // Última sequência: 2 (PEDIU_RETORNO quebrou os primeiros 2)
    expect(getConsecutiveSemRespostaCount(s)).toBe(2);
    // Sem cooldown (2 < 3)
    expect(s.cooledUntil).toBeNull();
  });

});

// ── GRUPO 8: Verificação de compatibilidade regressiva ────────────────────────

describe('N35-9C-COMPAT — N35.8 tests não quebrados pelas regras N35.9C', () => {

  test('N35-9C-COMPAT-01: claimOportunidade sem cooledUntil continua funcionando', () => {
    const s0 = makeState();
    const s1 = claimOportunidade(s0, OP, T0);
    expect(s1.estado).toBe(ESTADOS.EM_ATENDIMENTO);
  });

  test('N35-9C-COMPAT-02: registrarOutcome SEM_RESPOSTA × 1 continua funcionando', () => {
    const s0 = makeState();
    const s1 = makeClaimed(s0);
    const s2 = makeOutcome(s1, OUTCOMES.SEM_RESPOSTA);
    expect(s2.estado).toBe(ESTADOS.DISPONIVEL);
    expect(s2.cooledUntil).toBeNull();
  });

  test('N35-9C-COMPAT-03: WORKLIST_CAP exportado é 10', () => {
    expect(WORKLIST_CAP).toBe(10);
  });

  test('N35-9C-COMPAT-04: gerarDailyWorklist backward-compatible sem suppressedEntities', () => {
    const clientes = [
      { opportunityInstanceId: 'opp1', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 90 },
    ];
    const result = gerarDailyWorklist({
      clientesHoje:       clientes,
      estadosOperacionais: new Map(),
      cap:                10,
      dataReferencia:     '2026-09-24',
      // sem suppressedEntities
    });
    expect(result.worklist).toHaveLength(1);
    expect(result.total).toBe(1);
  });

});
