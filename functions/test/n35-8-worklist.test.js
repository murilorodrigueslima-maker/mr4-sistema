'use strict';
// N35.8 — Testes do Daily Worklist com CAP_10
// Cobre: dailyWorklist.js

const {
  WORKLIST_CAP,
  PRIORIDADE_ORDEM,
  compararPrioridade,
  gerarWorklistSimples,
  gerarDailyWorklist,
} = require('../lib/dailyWorklist');

const {
  ESTADOS,
  OUTCOMES,
  criarEstadoInicial,
  claimOportunidade,
  registrarOutcome,
} = require('../lib/filaOperacional');

const NOW = '2026-09-24T12:00:00.000Z';

function mkCliente(overrides = {}) {
  return {
    opportunityInstanceId: overrides.oppId || null,
    decisaoAcaoComercial:  overrides.decisao || 'AGIR_AGORA',
    diasSemComprar:        overrides.dsc || 30,
    nomeCliente:           overrides.nome || 'Cliente Teste',
    ...overrides,
  };
}

function mkEstado(oppId, estado = ESTADOS.DISPONIVEL) {
  return criarEstadoInicial('MR4_LINKED:abc123', oppId, 'REATIVACAO_120D', NOW);
}

function mkConcluida(oppId) {
  let est = mkEstado(oppId);
  est = claimOportunidade(est, 'op1', NOW);
  est = registrarOutcome(est, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW);
  return est;
}

function mkEmAtendimento(oppId, operadorId) {
  let est = mkEstado(oppId);
  est = claimOportunidade(est, operadorId, NOW);
  return est;
}

// ── gerarWorklistSimples ──────────────────────────────────────────────────────

test('N35-8-WL-01: retorna todos os itens quando abaixo do cap', () => {
  const clientes = [mkCliente(), mkCliente(), mkCliente()];
  const result = gerarWorklistSimples(clientes, 10);
  expect(result.worklist).toHaveLength(3);
  expect(result.total).toBe(3);
  expect(result.aplicouCap).toBe(false);
  expect(result.cap).toBe(10);
});

test('N35-8-WL-02: respeita CAP_10 (exato)', () => {
  const clientes = Array.from({ length: 15 }, (_, i) => mkCliente({ nome: `C${i}` }));
  const result = gerarWorklistSimples(clientes, 10);
  expect(result.worklist).toHaveLength(10);
  expect(result.total).toBe(15);
  expect(result.aplicouCap).toBe(true);
});

test('N35-8-WL-03: AGIR_AGORA tem prioridade sobre PROGRAMAR_CICLO', () => {
  const clientes = [
    mkCliente({ nome: 'B', decisao: 'PROGRAMAR_CICLO', dsc: 60 }),
    mkCliente({ nome: 'A', decisao: 'AGIR_AGORA', dsc: 20 }),
  ];
  const result = gerarWorklistSimples(clientes, 10);
  expect(result.worklist[0].nomeCliente).toBe('A');
  expect(result.worklist[1].nomeCliente).toBe('B');
});

test('N35-8-WL-04: empate em decisao → diasSemComprar maior primeiro', () => {
  const clientes = [
    mkCliente({ nome: 'Antigo', decisao: 'AGIR_AGORA', dsc: 30 }),
    mkCliente({ nome: 'MaisAntigo', decisao: 'AGIR_AGORA', dsc: 90 }),
  ];
  const result = gerarWorklistSimples(clientes, 10);
  expect(result.worklist[0].nomeCliente).toBe('MaisAntigo');
  expect(result.worklist[1].nomeCliente).toBe('Antigo');
});

test('N35-8-WL-05: lança erro para cap inválido', () => {
  expect(() => gerarWorklistSimples([], 0)).toThrow(/cap inválido/);
  expect(() => gerarWorklistSimples([], -1)).toThrow(/cap inválido/);
  expect(() => gerarWorklistSimples([], 1.5)).toThrow(/cap inválido/);
});

test('N35-8-WL-06: WORKLIST_CAP é 10', () => {
  expect(WORKLIST_CAP).toBe(10);
});

// ── gerarDailyWorklist (com estados operacionais) ─────────────────────────────

test('N35-8-WL-07: exclui CONCLUIDA da worklist', () => {
  const oppId    = 'opp_concluido_123';
  const cliente  = mkCliente({ oppId, nome: 'Concluido' });
  const estados  = new Map([[oppId, mkConcluida(oppId)]]);

  const result = gerarDailyWorklist({
    clientesHoje:          [cliente],
    estadosOperacionais:   estados,
  });
  expect(result.worklist).toHaveLength(0);
  expect(result.total).toBe(0);
});

test('N35-8-WL-08: exclui EM_ATENDIMENTO por outro operador', () => {
  const oppId   = 'opp_atendimento_456';
  const cliente = mkCliente({ oppId, nome: 'EmAtendimento' });
  const estados = new Map([[oppId, mkEmAtendimento(oppId, 'outro_op')]]);

  const result = gerarDailyWorklist({
    clientesHoje:          [cliente],
    estadosOperacionais:   estados,
    operadorId:            'meu_op',
  });
  expect(result.worklist).toHaveLength(0);
});

test('N35-8-WL-09: inclui EM_ATENDIMENTO pelo mesmo operador', () => {
  const oppId   = 'opp_meu_789';
  const cliente = mkCliente({ oppId, nome: 'MeuAtendimento' });
  const estados = new Map([[oppId, mkEmAtendimento(oppId, 'meu_op')]]);

  const result = gerarDailyWorklist({
    clientesHoje:          [cliente],
    estadosOperacionais:   estados,
    operadorId:            'meu_op',
  });
  expect(result.worklist).toHaveLength(1);
  expect(result.worklist[0].nomeCliente).toBe('MeuAtendimento');
});

test('N35-8-WL-10: sem oppId → sempre elegível (sem estado operacional)', () => {
  const cliente = mkCliente({ oppId: null });
  const result  = gerarDailyWorklist({
    clientesHoje:        [cliente],
    estadosOperacionais: new Map(),
  });
  expect(result.worklist).toHaveLength(1);
});

test('N35-8-WL-11: lança erro se estadosOperacionais não é Map', () => {
  expect(() =>
    gerarDailyWorklist({ clientesHoje: [], estadosOperacionais: {} })
  ).toThrow(/deve ser Map/);
});

test('N35-8-WL-12: lança erro se clientesHoje não é array', () => {
  expect(() =>
    gerarDailyWorklist({ clientesHoje: null, estadosOperacionais: new Map() })
  ).toThrow(/deve ser array/);
});

// ── PRIORIDADE_ORDEM é frozen ─────────────────────────────────────────────────

test('N35-8-WL-13: PRIORIDADE_ORDEM está frozen e correto', () => {
  expect(Object.isFrozen(PRIORIDADE_ORDEM)).toBe(true);
  expect(PRIORIDADE_ORDEM.AGIR_AGORA).toBeLessThan(PRIORIDADE_ORDEM.PROGRAMAR_CICLO);
  expect(PRIORIDADE_ORDEM.PROGRAMAR_CICLO).toBeLessThan(PRIORIDADE_ORDEM.NAO_AGIR);
});
