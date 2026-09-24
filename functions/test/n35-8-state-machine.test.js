'use strict';
// N35.8 — Testes da máquina de estado operacional
// Cobre: filaOperacional.js

const {
  ESTADOS,
  OUTCOMES,
  EVENT_TYPES,
  criarEstadoInicial,
  claimOportunidade,
  releaseOportunidade,
  registrarOutcome,
  isClaimavel,
  isEmAtendimento,
  isConcluida,
  getOperadorAtual,
  getUltimoOutcome,
} = require('../lib/filaOperacional');

const NOW = '2026-09-24T12:00:00.000Z';
const NOW2 = '2026-09-24T12:30:00.000Z';

function mkEstado(overrides = {}) {
  return criarEstadoInicial(
    overrides.commercialEntityId  || 'MR4_LINKED:abc123XYZ0987654321A',
    overrides.opportunityInstanceId || 'opp1234567890abcde',
    overrides.tipoOportunidade    || 'REATIVACAO_120D',
    overrides.isoNow              || NOW
  );
}

// ── criarEstadoInicial ────────────────────────────────────────────────────────

test('N35-8-SM-01: criarEstadoInicial retorna DISPONIVEL', () => {
  const est = mkEstado();
  expect(est.estado).toBe(ESTADOS.DISPONIVEL);
  expect(est.claimAtual).toBeNull();
  expect(Array.isArray(est.eventos)).toBe(true);
  expect(est.eventos.length).toBe(0);
});

test('N35-8-SM-02: criarEstadoInicial lança erro sem commercialEntityId', () => {
  expect(() =>
    criarEstadoInicial(null, 'opp1', 'REATIVACAO_120D', NOW)
  ).toThrow(/commercialEntityId/);
});

// ── claimOportunidade ─────────────────────────────────────────────────────────

test('N35-8-SM-03: DISPONIVEL → EM_ATENDIMENTO com claim', () => {
  const est = mkEstado();
  const novo = claimOportunidade(est, 'operador1', NOW);
  expect(novo.estado).toBe(ESTADOS.EM_ATENDIMENTO);
  expect(novo.claimAtual.operadorId).toBe('operador1');
  expect(novo.claimAtual.claimadoEm).toBe(NOW);
  expect(novo.eventos).toHaveLength(1);
  expect(novo.eventos[0].tipo).toBe(EVENT_TYPES.CLAIMED);
  expect(novo.eventos[0].estadoDepois).toBe(ESTADOS.EM_ATENDIMENTO);
});

test('N35-8-SM-04: AGUARDANDO_RETORNO → EM_ATENDIMENTO com claim', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.PEDIU_RETORNO, NOW);
  expect(est.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
  const novo = claimOportunidade(est, 'op1', NOW2);
  expect(novo.estado).toBe(ESTADOS.EM_ATENDIMENTO);
});

test('N35-8-SM-05: claimOportunidade lança erro se CONCLUIDA', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW);
  expect(() => claimOportunidade(est, 'op2', NOW2)).toThrow(/não permite claim/);
});

test('N35-8-SM-06: claimOportunidade lança erro se EM_ATENDIMENTO', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  expect(() => claimOportunidade(est, 'op2', NOW2)).toThrow(/não permite claim/);
});

test('N35-8-SM-07: claimOportunidade lança erro se operadorId vazio', () => {
  const est = mkEstado();
  expect(() => claimOportunidade(est, '', NOW)).toThrow(/operadorId obrigatório/);
  expect(() => claimOportunidade(est, null, NOW)).toThrow(/operadorId obrigatório/);
});

// ── releaseOportunidade ───────────────────────────────────────────────────────

test('N35-8-SM-08: release EM_ATENDIMENTO → DISPONIVEL', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  const liberado = releaseOportunidade(est, 'op1', NOW2);
  expect(liberado.estado).toBe(ESTADOS.DISPONIVEL);
  expect(liberado.claimAtual).toBeNull();
  expect(liberado.eventos).toHaveLength(2);
  expect(liberado.eventos[1].tipo).toBe(EVENT_TYPES.RELEASED);
});

test('N35-8-SM-09: release lança erro se operador errado', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  expect(() => releaseOportunidade(est, 'op2', NOW2)).toThrow(/não possui o claim/);
});

test('N35-8-SM-10: release lança erro se não estiver EM_ATENDIMENTO', () => {
  const est = mkEstado();
  expect(() => releaseOportunidade(est, 'op1', NOW)).toThrow(/não é EM_ATENDIMENTO/);
});

// ── registrarOutcome ──────────────────────────────────────────────────────────

test('N35-8-SM-11: CONVERSA_REALIZADA → CONCLUIDA', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW2);
  expect(est.estado).toBe(ESTADOS.CONCLUIDA);
  expect(est.claimAtual).toBeNull();
});

test('N35-8-SM-12: SEM_RESPOSTA → DISPONIVEL (sem cooldown fixo — D-D)', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.SEM_RESPOSTA, NOW2);
  // Estado retorna DISPONIVEL — pode ser claimado imediatamente (sem cooldown)
  expect(est.estado).toBe(ESTADOS.DISPONIVEL);
  expect(isClaimavel(est)).toBe(true);
});

test('N35-8-SM-13: PEDIU_RETORNO → AGUARDANDO_RETORNO', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.PEDIU_RETORNO, NOW2);
  expect(est.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
  expect(isClaimavel(est)).toBe(true);
});

test('N35-8-SM-14: SEM_INTERESSE_AGORA → CONCLUIDA', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.SEM_INTERESSE_AGORA, NOW2);
  expect(est.estado).toBe(ESTADOS.CONCLUIDA);
});

test('N35-8-SM-15: CONTATO_INVALIDO → CONCLUIDA', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.CONTATO_INVALIDO, NOW2);
  expect(est.estado).toBe(ESTADOS.CONCLUIDA);
});

test('N35-8-SM-16: registrarOutcome lança erro para outcome inválido', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  expect(() => registrarOutcome(est, 'op1', 'OUTCOME_INVENTADO', NOW2)).toThrow(/outcome inválido/);
});

test('N35-8-SM-17: registrarOutcome lança erro se não EM_ATENDIMENTO', () => {
  const est = mkEstado();
  expect(() => registrarOutcome(est, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW)).toThrow(/não é EM_ATENDIMENTO/);
});

// ── Audit trail ───────────────────────────────────────────────────────────────

test('N35-8-SM-18: sequência claim→outcome→claim→outcome gera audit trail correto', () => {
  let est = mkEstado();
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.SEM_RESPOSTA, NOW2);
  est = claimOportunidade(est, 'op2', NOW2);
  est = registrarOutcome(est, 'op2', OUTCOMES.CONVERSA_REALIZADA, NOW2);

  expect(est.eventos).toHaveLength(4);
  expect(est.eventos[0].tipo).toBe(EVENT_TYPES.CLAIMED);
  expect(est.eventos[1].tipo).toBe(EVENT_TYPES.OUTCOME_REGISTERED);
  expect(est.eventos[1].outcome).toBe(OUTCOMES.SEM_RESPOSTA);
  expect(est.eventos[2].tipo).toBe(EVENT_TYPES.CLAIMED);
  expect(est.eventos[3].tipo).toBe(EVENT_TYPES.OUTCOME_REGISTERED);
  expect(est.eventos[3].outcome).toBe(OUTCOMES.CONVERSA_REALIZADA);
  expect(est.estado).toBe(ESTADOS.CONCLUIDA);
});

// ── Queries ───────────────────────────────────────────────────────────────────

test('N35-8-SM-19: queries retornam valores corretos', () => {
  let est = mkEstado();
  expect(isClaimavel(est)).toBe(true);
  expect(isEmAtendimento(est)).toBe(false);
  expect(isConcluida(est)).toBe(false);
  expect(getOperadorAtual(est)).toBeNull();
  expect(getUltimoOutcome(est)).toBeNull();

  est = claimOportunidade(est, 'op1', NOW);
  expect(isClaimavel(est)).toBe(false);
  expect(isEmAtendimento(est)).toBe(true);
  expect(getOperadorAtual(est)).toBe('op1');

  est = registrarOutcome(est, 'op1', OUTCOMES.PEDIU_RETORNO, NOW2);
  expect(isClaimavel(est)).toBe(true); // AGUARDANDO_RETORNO é claimável
  expect(getUltimoOutcome(est)).toBe(OUTCOMES.PEDIU_RETORNO);
  expect(getOperadorAtual(est)).toBeNull();
});

// ── Imutabilidade ─────────────────────────────────────────────────────────────

test('N35-8-SM-20: funções não mutam o estado original', () => {
  const est = mkEstado();
  const estadoOriginal = JSON.stringify(est);
  claimOportunidade(est, 'op1', NOW);
  expect(JSON.stringify(est)).toBe(estadoOriginal);
});
