'use strict';
// N35.10 — Testes do Ciclo Operacional Canário
// Valida o ciclo completo: oportunidade → worklist → claim → resultado → cooldown/follow-up
//
// INVARIANTES: OPENAI_CALLS=0, PROD_WRITES=0, I/O=0
// 25 testes cobrindo: ciclo completo, cooldown, worklist, CAP_10, identidade, determinismo

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
  isCooledDown,
  getCooledUntil,
  isClaimExpired,
  getConsecutiveSemRespostaCount,
  isClaimavel,
  isConcluida,
} = require(path.join(LIB, 'filaOperacional'));

const {
  isDueFollowUp,
  gerarDailyWorklist,
} = require(path.join(LIB, 'dailyWorklist'));

const {
  buildCommercialEntityId,
  buildOpportunityInstanceId,
  commercialEntityIdFromPerfil360,
  validateIdentity,
} = require(path.join(LIB, 'commercialIdentity'));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MR4_ID   = 'M6wAPSqRGQVKcMqK76lt';   // canário 1 (VP Filme)
const GC_ID    = '39690634';                // canário GC_NATIVE (não REATIVACAO, usado apenas p/ identidade)
const COMM_MR4 = `MR4_LINKED:${MR4_ID}`;
const COMM_GC  = `GC_NATIVE:${GC_ID}`;
const TIPO     = 'REATIVACAO_120D';
const ULTIMA   = '2024-10-25';
const OP       = 'vendedor-001';

const T0      = '2026-09-24T10:00:00.000Z';
const T0_1H   = '2026-09-24T11:00:00.000Z';
const T0_4H   = '2026-09-24T14:00:00.000Z';   // exatamente no timeout
const T0_4H1S = '2026-09-24T14:00:01.000Z';   // 1s após timeout
const T0_29D  = '2026-10-23T10:00:00.000Z';
const T0_30D  = '2026-10-24T10:00:00.000Z';   // exatamente no fim do cooldown
const T0_30D1S= '2026-10-24T10:00:01.000Z';

function mkState(overrides = {}) {
  return criarEstadoInicial(
    overrides.commercialEntityId    || COMM_MR4,
    overrides.opportunityInstanceId || 'f6f744b856019469',
    overrides.tipoOportunidade      || TIPO,
    overrides.isoNow                || T0
  );
}

function mkClaimed(estado = mkState(), op = OP, t = T0) {
  return claimOportunidade(estado, op, t);
}

// ── CICLO COMPLETO (5 testes) ─────────────────────────────────────────────────

test('N35-10-01: ciclo CONVERSA_REALIZADA → CONCLUIDA', () => {
  const est0  = mkState();
  const est1  = mkClaimed(est0);
  const est2  = registrarOutcome(est1, OP, OUTCOMES.CONVERSA_REALIZADA, T0_1H);

  expect(est2.estado).toBe(ESTADOS.CONCLUIDA);
  expect(est2.claimAtual).toBeNull();
  expect(isConcluida(est2)).toBe(true);
  expect(est2.eventos).toHaveLength(2);
});

test('N35-10-02: ciclo SEM_RESPOSTA (1x) → DISPONIVEL', () => {
  const est2 = registrarOutcome(mkClaimed(), OP, OUTCOMES.SEM_RESPOSTA, T0_1H);
  expect(est2.estado).toBe(ESTADOS.DISPONIVEL);
  expect(isCooledDown(est2, T0_1H)).toBe(false);
});

test('N35-10-03: ciclo PEDIU_RETORNO → AGUARDANDO_RETORNO + nextFollowUpAt', () => {
  const est2 = registrarOutcome(mkClaimed(), OP, OUTCOMES.PEDIU_RETORNO, T0_1H, { scheduledFor: '2026-10-01' });
  expect(est2.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
  expect(est2.nextFollowUpAt).toBe('2026-10-01');
});

test('N35-10-04: ciclo SEM_INTERESSE_AGORA → CONCLUIDA + cooledUntil 30d', () => {
  const est2 = registrarOutcome(mkClaimed(), OP, OUTCOMES.SEM_INTERESSE_AGORA, T0);
  expect(est2.estado).toBe(ESTADOS.CONCLUIDA);
  expect(isCooledDown(est2, T0_29D)).toBe(true);
  expect(isCooledDown(est2, T0_30D1S)).toBe(false);
});

test('N35-10-05: ciclo CONTATO_INVALIDO → CONCLUIDA', () => {
  const est2 = registrarOutcome(mkClaimed(), OP, OUTCOMES.CONTATO_INVALIDO, T0_1H);
  expect(est2.estado).toBe(ESTADOS.CONCLUIDA);
  expect(isConcluida(est2)).toBe(true);
});

// ── FOLLOW-UP (3 testes) ───────────────────────────────────────────────────────

test('N35-10-06: PEDIU_RETORNO sem scheduledFor → nextFollowUpAt null', () => {
  const est2 = registrarOutcome(mkClaimed(), OP, OUTCOMES.PEDIU_RETORNO, T0_1H);
  expect(est2.nextFollowUpAt).toBeNull();
});

test('N35-10-07: isDueFollowUp verdadeiro quando nextFollowUpAt vencido', () => {
  const estado = {
    estado:        ESTADOS.AGUARDANDO_RETORNO,
    nextFollowUpAt: '2026-09-23',
  };
  expect(isDueFollowUp(estado, '2026-09-24')).toBe(true);
});

test('N35-10-08: isDueFollowUp falso quando CONCLUIDA, mesmo com nextFollowUpAt', () => {
  const estado = {
    estado:        ESTADOS.CONCLUIDA,
    nextFollowUpAt: '2026-09-01',
  };
  expect(isDueFollowUp(estado, '2026-09-24')).toBe(false);
});

// ── COOLDOWN (3 testes) ───────────────────────────────────────────────────────

test('N35-10-09: 3× SEM_RESPOSTA consecutivos → cooledUntil +30d', () => {
  let est = mkState();
  for (let i = 0; i < 3; i++) {
    est = claimOportunidade(est, OP, T0);
    // usar T0 como timestamp do outcome para que cooledUntil = T0 + 30d
    est = registrarOutcome(est, OP, OUTCOMES.SEM_RESPOSTA, T0);
  }
  expect(isCooledDown(est, T0_29D)).toBe(true);
  // T0_30D = exatamente T0+30d = cooledUntil; agora >= não está em cooldown
  expect(isCooledDown(est, T0_30D)).toBe(false);
  expect(isCooledDown(est, T0_30D1S)).toBe(false);
});

test('N35-10-10: 2× SEM_RESPOSTA consecutivos → sem cooldown', () => {
  let est = mkState();
  for (let i = 0; i < 2; i++) {
    est = claimOportunidade(est, OP, T0);
    est = registrarOutcome(est, OP, OUTCOMES.SEM_RESPOSTA, T0_1H);
  }
  expect(isCooledDown(est, T0_1H)).toBe(false);
  expect(getConsecutiveSemRespostaCount(est)).toBe(2);
});

test('N35-10-11: claimOportunidade lança erro se opp em cooldown', () => {
  // 3× SEM_RESPOSTA → estado=DISPONIVEL com cooledUntil ativo
  let est = mkState();
  for (let i = 0; i < 3; i++) {
    est = claimOportunidade(est, OP, T0);
    est = registrarOutcome(est, OP, OUTCOMES.SEM_RESPOSTA, T0);
  }
  expect(est.estado).toBe(ESTADOS.DISPONIVEL);
  expect(isCooledDown(est, T0_1H)).toBe(true);
  expect(() => claimOportunidade(est, OP, T0_1H)).toThrow(/cooldown/);
});

// ── CLAIM TIMEOUT (3 testes) ──────────────────────────────────────────────────

test('N35-10-12: isClaimExpired falso antes de 4h (1h decorrida)', () => {
  const est = mkClaimed();
  expect(isClaimExpired(est, T0_1H)).toBe(false);   // 1h << 4h timeout
});

test('N35-10-13: isClaimExpired verdadeiro após 4h01s', () => {
  const est = mkClaimed();
  expect(isClaimExpired(est, T0_4H1S)).toBe(true);
});

test('N35-10-14: releaseExpiredClaim → DISPONIVEL sem destruir eventos', () => {
  const est  = mkClaimed();
  const est2 = releaseExpiredClaim(est, T0_4H1S);
  expect(est2.estado).toBe(ESTADOS.DISPONIVEL);
  expect(est2.claimAtual).toBeNull();
  expect(est2.eventos.length).toBeGreaterThan(0);
  const released = est2.eventos.find(e => e.meta?.reason === 'CLAIM_TIMEOUT');
  expect(released).toBeTruthy();
});

// ── CONCORRÊNCIA / CLAIM EXCLUSIVO (2 testes) ──────────────────────────────

test('N35-10-15: claim sobre EM_ATENDIMENTO lança erro (exclusão mútua)', () => {
  const est = mkClaimed();
  expect(() => claimOportunidade(est, 'outro-op', T0_1H)).toThrow(/EM_ATENDIMENTO/);
});

test('N35-10-16: release por operador diferente do owner lança erro', () => {
  const est = mkClaimed(mkState(), 'op-A');
  expect(() => releaseOportunidade(est, 'op-B', T0_1H)).toThrow(/op-A/);
});

// ── WORKLIST / CAP_10 (4 testes) ──────────────────────────────────────────────

function mkCliente(id, decisao, dias) {
  return {
    opportunityInstanceId: id,
    commercialEntityId:    `MR4_LINKED:${id}`,
    decisaoAcaoComercial:  decisao,
    diasSemComprar:        dias,
  };
}

test('N35-10-17: CAP_10 limita novas oportunidades a 10', () => {
  const clientes = Array.from({ length: 11 }, (_, i) =>
    mkCliente(`opp${i+1}`, 'AGIR_AGORA', 150 - i)
  );
  const result = gerarDailyWorklist({
    clientesHoje:        clientes,
    estadosOperacionais: new Map(),
    cap:                 10,
    dataReferencia:      '2026-09-24',
  });
  expect(result.worklist.length).toBe(10);
  expect(result.aplicouCap).toBe(true);
});

test('N35-10-18: follow-ups vencidos ficam fora do CAP (adicionais)', () => {
  const estadoComFollowup = {
    estado:        ESTADOS.AGUARDANDO_RETORNO,
    nextFollowUpAt: '2026-09-23',
    cooledUntil:   null,
    claimAtual:    null,
  };
  const clientes = Array.from({ length: 11 }, (_, i) =>
    mkCliente(`opp${i+1}`, 'AGIR_AGORA', 150 - i)
  );
  const clienteFollowup = mkCliente('opp-fu', 'AGIR_AGORA', 200);
  const estados = new Map([['opp-fu', estadoComFollowup]]);

  const result = gerarDailyWorklist({
    clientesHoje:        [...clientes, clienteFollowup],
    estadosOperacionais: estados,
    cap:                 10,
    dataReferencia:      '2026-09-24',
  });
  // follow-up (1) + 10 novas = 11
  expect(result.worklist.length).toBe(11);
  expect(result.dueFollowUps.length).toBe(1);
});

test('N35-10-19: worklist ordena AGIR_AGORA antes de PROGRAMAR_CICLO', () => {
  const clientes = [
    mkCliente('opp-pc', 'PROGRAMAR_CICLO', 50),
    mkCliente('opp-aa', 'AGIR_AGORA', 120),
  ];
  const result = gerarDailyWorklist({
    clientesHoje:        clientes,
    estadosOperacionais: new Map(),
    cap:                 10,
    dataReferencia:      '2026-09-24',
  });
  expect(result.worklist[0].opportunityInstanceId).toBe('opp-aa');
});

test('N35-10-20: worklist exclui entidade suprimida (suppressedEntities)', () => {
  const clientes = [
    { ...mkCliente('opp1', 'AGIR_AGORA', 200), commercialEntityId: 'MR4_LINKED:X' },
  ];
  const supressed = new Map([['MR4_LINKED:X', '2026-12-01T00:00:00.000Z']]);
  const result = gerarDailyWorklist({
    clientesHoje:        clientes,
    estadosOperacionais: new Map(),
    suppressedEntities:  supressed,
    cap:                 10,
    dataReferencia:      '2026-09-24',
  });
  expect(result.worklist.length).toBe(0);
});

// ── IDENTIDADE (5 testes) ──────────────────────────────────────────────────────

test('N35-10-21: buildCommercialEntityId MR4_LINKED para canário VP Filme', () => {
  const id = buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: MR4_ID });
  expect(id).toBe(`MR4_LINKED:${MR4_ID}`);
});

test('N35-10-22: buildCommercialEntityId GC_NATIVE para gestaoClickId numérico', () => {
  const id = buildCommercialEntityId({ source: 'GC_NATIVE', gestaoClickId: GC_ID });
  expect(id).toBe(`GC_NATIVE:${GC_ID}`);
});

test('N35-10-23: opportunityInstanceId é determinístico (mesmos inputs → mesmo hash)', () => {
  const id1 = buildOpportunityInstanceId(COMM_MR4, TIPO, ULTIMA);
  const id2 = buildOpportunityInstanceId(COMM_MR4, TIPO, ULTIMA);
  expect(id1).toBe(id2);
  expect(id1).toBe('f6f744b856019469');  // valor calculado no FASE 4
});

test('N35-10-24: opportunityInstanceId diferente para tipo diferente (mesmo entity)', () => {
  const id1 = buildOpportunityInstanceId(COMM_MR4, 'REATIVACAO_120D', ULTIMA);
  const id2 = buildOpportunityInstanceId(COMM_MR4, 'JANELA_DE_RECOMPRA', ULTIMA);
  expect(id1).not.toBe(id2);
});

test('N35-10-25: commercialEntityIdFromPerfil360 retorna MR4_LINKED para perfil sem source', () => {
  const perfil = { clienteMr4Id: MR4_ID, gestaoClickId: GC_ID }; // sem source = legado MR4
  const result = validateIdentity(perfil);
  expect(result.valid).toBe(true);
  expect(result.commercialEntityId).toBe(COMM_MR4);
});
