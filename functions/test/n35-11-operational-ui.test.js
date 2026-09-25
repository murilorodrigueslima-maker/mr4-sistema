'use strict';

/**
 * N35.11 — INTERFACE OPERACIONAL DO CANÁRIO
 * Suite de testes: máquina de estado, handlers, pipeline, permissões.
 *
 * APROVADO_PROPRIETARIO_PRE-PROD
 *
 * Categorias:
 *   SM      — State machine (filaOperacional.js puro)
 *   CLAIM   — Claim handler (canaryCallable.claimOpportunityHandler)
 *   OUTCOME — Outcome handler (canaryCallable.registerOutcomeHandler)
 *   RELEASE — Release handler (canaryCallable.releaseOpportunityHandler)
 *   COOL    — Cooldown rules
 *   FOLLOW  — Follow-up (PEDIU_RETORNO)
 *   PERM    — Permission gates
 *   PIPE    — Pipeline identity (opportunityInstanceId)
 *   IDENT   — Identity mutation prevention
 *
 * INVARIANTES PERMANENTES (não muda nenhum teste):
 *   CAP10_ACTIVATED=NO
 *   PROD_WRITES=0 (todos os testes são unitários ou contra emulador mockado)
 *   NÃO cria novas oportunidades em produção
 */

const {
  ESTADOS,
  OUTCOMES,
  EVENT_TYPES,
  criarEstadoInicial,
  claimOportunidade,
  releaseOportunidade,
  releaseExpiredClaim,
  registrarOutcome,
  isClaimavel,
  isEmAtendimento,
  isConcluida,
  getOperadorAtual,
  getUltimoOutcome,
  getConsecutiveSemRespostaCount,
  isClaimExpired,
  isCooledDown,
} = require('../lib/filaOperacional');

const { buildOpportunityInstanceId, buildCommercialEntityId, SOURCES } = require('../lib/commercialIdentity');
const { prepararDadosUI, verificarCamposBloqueados, CAMPOS_BLOQUEADOS } = require('../lib/filaComercialUtils');

// Fixtures
const ENTITY_ID   = 'MR4_LINKED:testclient001';
const OPP_ID      = 'abcdef1234567890';
const TIPO        = 'REATIVACAO_120D';
const OP1         = 'operador-uid-001';
const OP2         = 'operador-uid-002';
const T0          = '2026-09-24T10:00:00.000Z';
const T1          = '2026-09-24T11:00:00.000Z';
const T5H_LATER   = '2026-09-24T15:01:00.000Z'; // > 4h timeout

function estadoBase() {
  return criarEstadoInicial(ENTITY_ID, OPP_ID, TIPO, T0);
}

function estadoEmAtendimento(operadorId = OP1, ts = T0) {
  return claimOportunidade(estadoBase(), operadorId, ts);
}

// ── SM-01: Estado inicial válido ───────────────────────────────────────────────

test('SM-01: criarEstadoInicial produz DISPONIVEL com campos obrigatórios', () => {
  const s = estadoBase();
  expect(s.estado).toBe(ESTADOS.DISPONIVEL);
  expect(s.opportunityInstanceId).toBe(OPP_ID);
  expect(s.commercialEntityId).toBe(ENTITY_ID);
  expect(s.tipoOportunidade).toBe(TIPO);
  expect(s.claimAtual).toBeNull();
  expect(s.cooledUntil).toBeNull();
  expect(s.nextFollowUpAt).toBeNull();
  expect(Array.isArray(s.eventos)).toBe(true);
  expect(s.eventos).toHaveLength(0);
});

// ── SM-02: Claim em DISPONIVEL → EM_ATENDIMENTO ────────────────────────────────

test('SM-02: claim em DISPONIVEL transiciona para EM_ATENDIMENTO', () => {
  const s = claimOportunidade(estadoBase(), OP1, T0);
  expect(s.estado).toBe(ESTADOS.EM_ATENDIMENTO);
  expect(s.claimAtual.operadorId).toBe(OP1);
  expect(s.claimAtual.claimadoEm).toBe(T0);
  expect(s.eventos).toHaveLength(1);
  expect(s.eventos[0].tipo).toBe(EVENT_TYPES.CLAIMED);
});

// ── SM-03: Claim em EM_ATENDIMENTO → lança erro (double-claim) ────────────────

test('SM-03: double-claim em EM_ATENDIMENTO lança erro de estado', () => {
  const s = estadoEmAtendimento();
  expect(() => claimOportunidade(s, OP2, T1)).toThrow(/não permite claim|EM_ATENDIMENTO/);
});

// ── SM-04: Claim em AGUARDANDO_RETORNO → EM_ATENDIMENTO ───────────────────────

test('SM-04: claim em AGUARDANDO_RETORNO transiciona para EM_ATENDIMENTO', () => {
  let s = estadoEmAtendimento();
  s = registrarOutcome(s, OP1, OUTCOMES.PEDIU_RETORNO, T0, { scheduledFor: '2026-10-10' });
  expect(s.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
  const s2 = claimOportunidade(s, OP2, T1);
  expect(s2.estado).toBe(ESTADOS.EM_ATENDIMENTO);
});

// ── SM-05: CONVERSA_REALIZADA → CONCLUIDA ─────────────────────────────────────

test('SM-05: CONVERSA_REALIZADA transiciona para CONCLUIDA', () => {
  const s = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.CONVERSA_REALIZADA, T1);
  expect(s.estado).toBe(ESTADOS.CONCLUIDA);
  expect(s.claimAtual).toBeNull();
  expect(getUltimoOutcome(s)).toBe(OUTCOMES.CONVERSA_REALIZADA);
});

// ── SM-06: SEM_RESPOSTA → DISPONIVEL ──────────────────────────────────────────

test('SM-06: SEM_RESPOSTA transiciona para DISPONIVEL (1ª vez)', () => {
  const s = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.SEM_RESPOSTA, T1);
  expect(s.estado).toBe(ESTADOS.DISPONIVEL);
  expect(s.cooledUntil).toBeNull(); // ainda não atingiu 3×
});

// ── SM-07: PEDIU_RETORNO → AGUARDANDO_RETORNO com nextFollowUpAt ──────────────

test('SM-07: PEDIU_RETORNO seta nextFollowUpAt e transiciona para AGUARDANDO_RETORNO', () => {
  const s = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.PEDIU_RETORNO, T1, { scheduledFor: '2026-10-15' });
  expect(s.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);
  expect(s.nextFollowUpAt).toBe('2026-10-15');
  expect(s.claimAtual).toBeNull();
});

// ── SM-08: SEM_INTERESSE_AGORA → CONCLUIDA + cooledUntil +30d ─────────────────

test('SM-08: SEM_INTERESSE_AGORA transiciona para CONCLUIDA com cooldown de 30 dias', () => {
  const s = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.SEM_INTERESSE_AGORA, T1);
  expect(s.estado).toBe(ESTADOS.CONCLUIDA);
  expect(s.cooledUntil).toBeTruthy();
  const coolDate = new Date(s.cooledUntil);
  const nowDate  = new Date(T1);
  const diffDays = Math.round((coolDate - nowDate) / (1000 * 86400));
  expect(diffDays).toBe(30);
});

// ── SM-09: CONTATO_INVALIDO → CONCLUIDA ───────────────────────────────────────

test('SM-09: CONTATO_INVALIDO transiciona para CONCLUIDA', () => {
  const s = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.CONTATO_INVALIDO, T1);
  expect(s.estado).toBe(ESTADOS.CONCLUIDA);
});

// ── SM-10: releaseOportunidade retorna para DISPONIVEL ───────────────────────

test('SM-10: releaseOportunidade retorna para DISPONIVEL e limpa claimAtual', () => {
  const s = releaseOportunidade(estadoEmAtendimento(), OP1, T1);
  expect(s.estado).toBe(ESTADOS.DISPONIVEL);
  expect(s.claimAtual).toBeNull();
  expect(s.eventos.at(-1).tipo).toBe(EVENT_TYPES.RELEASED);
});

// ── SM-11: release por não-owner lança erro ───────────────────────────────────

test('SM-11: release por operador não-owner lança erro', () => {
  const s = estadoEmAtendimento(OP1);
  expect(() => releaseOportunidade(s, OP2, T1)).toThrow(/não possui o claim/);
});

// ── COOL-12: 3× SEM_RESPOSTA consecutivos → cooldown 30d ─────────────────────

test('COOL-12: 3 SEM_RESPOSTA consecutivos ativam cooldown de 30 dias', () => {
  let s = estadoBase();
  for (let i = 0; i < 3; i++) {
    s = claimOportunidade(s, OP1, T0);
    s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T0);
  }
  expect(s.cooledUntil).toBeTruthy();
  const diffDays = Math.round(
    (new Date(s.cooledUntil) - new Date(T0)) / (1000 * 86400)
  );
  expect(diffDays).toBe(30);
});

// ── COOL-13: 2× SEM_RESPOSTA NÃO ativa cooldown ──────────────────────────────

test('COOL-13: 2 SEM_RESPOSTA consecutivos NÃO ativam cooldown', () => {
  let s = estadoBase();
  for (let i = 0; i < 2; i++) {
    s = claimOportunidade(s, OP1, T0);
    s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T0);
  }
  expect(s.cooledUntil).toBeNull();
});

// ── COOL-14: outro outcome interrompe sequência SEM_RESPOSTA ──────────────────

test('COOL-14: CONVERSA_REALIZADA entre SEM_RESPOSTAs reseta contador', () => {
  let s = estadoBase();
  // 2× sem resposta
  for (let i = 0; i < 2; i++) {
    s = claimOportunidade(s, OP1, T0);
    s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T0);
  }
  // um conversa → reseta
  s = claimOportunidade(s, OP1, T0);
  s = registrarOutcome(s, OP1, OUTCOMES.CONVERSA_REALIZADA, T0);
  // recriar e tentar novamente — a oportunidade ficou CONCLUIDA,
  // então testamos só o contador no estado atual
  expect(getConsecutiveSemRespostaCount(s)).toBe(0);
});

// ── COOL-15: claim bloqueado quando em cooldown ───────────────────────────────

test('COOL-15: claim bloqueado quando oportunidade está em cooldown ativo', () => {
  let s = estadoBase();
  for (let i = 0; i < 3; i++) {
    s = claimOportunidade(s, OP1, T0);
    s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T0);
  }
  expect(isCooledDown(s, T1)).toBe(true);
  expect(() => claimOportunidade(s, OP1, T1)).toThrow(/cooldown/);
});

// ── COOL-16: claim permitido após expiração do cooldown ───────────────────────

test('COOL-16: claim permitido após expiração do cooldown', () => {
  let s = estadoBase();
  for (let i = 0; i < 3; i++) {
    s = claimOportunidade(s, OP1, T0);
    s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T0);
  }
  // simula data 31 dias depois
  const afterCooldown = new Date(new Date(T0).getTime() + 31 * 86400 * 1000).toISOString();
  expect(isCooledDown(s, afterCooldown)).toBe(false);
  const s2 = claimOportunidade(s, OP1, afterCooldown);
  expect(s2.estado).toBe(ESTADOS.EM_ATENDIMENTO);
});

// ── SM-17: isClaimExpired após 4h ─────────────────────────────────────────────

test('SM-17: isClaimExpired retorna true após 4 horas', () => {
  const s = estadoEmAtendimento(OP1, T0);
  expect(isClaimExpired(s, T5H_LATER)).toBe(true);
  expect(isClaimExpired(s, T1)).toBe(false);
});

// ── SM-18: releaseExpiredClaim funciona após timeout ──────────────────────────

test('SM-18: releaseExpiredClaim libera claim expirado para DISPONIVEL', () => {
  const s = estadoEmAtendimento(OP1, T0);
  const released = releaseExpiredClaim(s, T5H_LATER);
  expect(released.estado).toBe(ESTADOS.DISPONIVEL);
  expect(released.claimAtual).toBeNull();
  expect(released.eventos.at(-1).meta?.reason).toBe('CLAIM_TIMEOUT');
});

// ── SM-19: releaseExpiredClaim preserva histórico e nextFollowUpAt ────────────

test('SM-19: releaseExpiredClaim preserva nextFollowUpAt e eventos anteriores', () => {
  let s = estadoBase();
  s = claimOportunidade(s, OP1, T0);
  s = registrarOutcome(s, OP1, OUTCOMES.PEDIU_RETORNO, T0, { scheduledFor: '2026-10-01' });
  // re-claim, deixa expirar
  s = claimOportunidade(s, OP1, T1);
  const released = releaseExpiredClaim(s, T5H_LATER);
  expect(released.nextFollowUpAt).toBe('2026-10-01');
  expect(released.eventos.length).toBeGreaterThanOrEqual(3);
});

// ── SM-20: registrarOutcome não valida ownership (pure function gap) ──────────

test('SM-20: registrarOutcome (pure fn) aceita qualquer operadorId — ownership validado no servidor', () => {
  const s = estadoEmAtendimento(OP1);
  // INTENÇÃO: a função pura não valida — quem valida é canaryCallable.registerOutcomeHandler
  expect(() => registrarOutcome(s, OP2, OUTCOMES.SEM_RESPOSTA, T1)).not.toThrow();
});

// ── FOLLOW-21: nextFollowUpAt limpo em outcomes não-follow-up ─────────────────

test('FOLLOW-21: SEM_RESPOSTA substitui o retorno agendado pelo próximo dia útil (N35.14 D-RETRY)', () => {
  const { proximoDiaUtil, dataComercial } = require('../lib/filaOperacional');
  let s = estadoBase();
  s = claimOportunidade(s, OP1, T0);
  s = registrarOutcome(s, OP1, OUTCOMES.PEDIU_RETORNO, T0, { scheduledFor: '2026-10-10' });
  expect(s.nextFollowUpAt).toBe('2026-10-10');
  s = claimOportunidade(s, OP1, T1);
  s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T1);
  expect(s.nextFollowUpAt).toBe(proximoDiaUtil(dataComercial(T1)));
  s = claimOportunidade(s, OP1, T1);
  s = registrarOutcome(s, OP1, OUTCOMES.CONVERSA_REALIZADA, T1);
  expect(s.nextFollowUpAt).toBeNull();
});

// ── FOLLOW-22: PEDIU_RETORNO sem scheduledFor → nextFollowUpAt null ────────────

test('FOLLOW-22: PEDIU_RETORNO sem scheduledFor produz nextFollowUpAt null', () => {
  const s = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.PEDIU_RETORNO, T1);
  expect(s.nextFollowUpAt).toBeNull();
});

// ── PERM-23: verificarCamposBloqueados detecta campos proibidos ───────────────

test('PERM-23: verificarCamposBloqueados detecta campos proibidos no output de UI', () => {
  const clienteComDados = {
    nomeCliente:   'Teste',
    clienteMr4Id:  'mr4-001',
    scoreTotal:    0.87,
    prioridade:    99,
  };
  const found = verificarCamposBloqueados(clienteComDados);
  expect(found.some(f => f.includes('clienteMr4Id'))).toBe(true);
  expect(found.some(f => f.includes('scoreTotal'))).toBe(true);
  expect(found.some(f => f.includes('prioridade'))).toBe(true);
});

// ── PERM-24: prepararDadosUI não expõe campos bloqueados ─────────────────────

test('PERM-24: prepararDadosUI remove todos os campos de CAMPOS_BLOQUEADOS', () => {
  const clienteBruto = {
    nomeCliente:             'Cliente Teste',
    clienteMr4Id:            'mr4-001',
    tipoOportunidade:        'REATIVACAO_120D',
    opportunityInstanceId:   OPP_ID,
    scoreTotal:              0.88,
    prioridade:              10,
    comoAbordar:             'Ligar cedo',
    decisaoAcaoComercial:    'AGIR_AGORA',
    diasSemComprar:          135,
    diasEntreComprasMediana: 45,
    diasAteProximoCiclo:     null,
    tendencia:               'CAINDO',
    sellerAssist: {
      situacao: 'Cliente sem comprar há 135 dias.',
      quando:   'Contate agora.',
      sinais:   { diasSemComprar: 135, cicloMedianoDias: 45, tendencia: 'CAINDO' },
    },
  };
  const ui = prepararDadosUI(clienteBruto);
  const blocked = verificarCamposBloqueados(ui);
  expect(blocked).toHaveLength(0);
  expect(ui.opportunityInstanceId).toBe(OPP_ID);
  expect(ui.nomeCliente).toBe('Cliente Teste');
});

// ── IDENT-25: opportunityInstanceId não está em CAMPOS_BLOQUEADOS ─────────────

test('IDENT-25: opportunityInstanceId não é campo bloqueado', () => {
  expect(CAMPOS_BLOQUEADOS).not.toContain('opportunityInstanceId');
});

// ── IDENT-26: opportunityInstanceId é hash determinístico ────────────────────

test('IDENT-26: buildOpportunityInstanceId é determinístico para mesmos inputs', () => {
  const entityId = buildCommercialEntityId({ source: SOURCES.MR4_LINKED, mr4ClientId: 'mr4-abc' });
  const id1 = buildOpportunityInstanceId(entityId, 'REATIVACAO_120D', '2026-06-15');
  const id2 = buildOpportunityInstanceId(entityId, 'REATIVACAO_120D', '2026-06-15');
  expect(id1).toBe(id2);
  expect(id1).toMatch(/^[0-9a-f]{16}$/);
});

// ── IDENT-27: opportunityInstanceId muda com tipo diferente ──────────────────

test('IDENT-27: opportunityInstanceId muda ao alterar tipoOportunidade', () => {
  const entityId = buildCommercialEntityId({ source: SOURCES.MR4_LINKED, mr4ClientId: 'mr4-xyz' });
  const idReativ = buildOpportunityInstanceId(entityId, 'REATIVACAO_120D',    '2026-06-15');
  const idJanela = buildOpportunityInstanceId(entityId, 'JANELA_DE_RECOMPRA', '2026-06-15');
  expect(idReativ).not.toBe(idJanela);
});

// ── IDENT-28: opportunityInstanceId muda com ultimaCompraEm diferente ─────────

test('IDENT-28: opportunityInstanceId muda ao alterar ultimaCompraEm', () => {
  const entityId = buildCommercialEntityId({ source: SOURCES.MR4_LINKED, mr4ClientId: 'mr4-xyz' });
  const id1 = buildOpportunityInstanceId(entityId, 'REATIVACAO_120D', '2026-06-15');
  const id2 = buildOpportunityInstanceId(entityId, 'REATIVACAO_120D', '2026-07-01');
  expect(id1).not.toBe(id2);
});

// ── IDENT-29: identidade NUNCA vem do cliente no output UI ───────────────────

test('IDENT-29: clienteMr4Id nunca aparece no output prepararDadosUI', () => {
  const clienteBruto = {
    nomeCliente:          'Teste',
    clienteMr4Id:         'mr4-segredo',
    tipoOportunidade:     'QUEDA_DE_COMPRAS',
    opportunityInstanceId: 'abc123def456789a',
    decisaoAcaoComercial: 'AGIR_AGORA',
    diasSemComprar:       60,
    diasEntreComprasMediana: 30,
    sellerAssist: { situacao: 's', quando: 'q', sinais: {} },
  };
  const ui = prepararDadosUI(clienteBruto);
  expect(JSON.stringify(ui)).not.toContain('mr4-segredo');
  expect(ui.clienteMr4Id).toBeUndefined();
});

// ── SM-30: histórico de eventos preservado em todas as transições ──────────────

test('SM-30: histórico de eventos acumula sem sobrescrever', () => {
  let s = estadoBase();
  s = claimOportunidade(s, OP1, T0);
  s = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T0);
  s = claimOportunidade(s, OP1, T1);
  s = registrarOutcome(s, OP1, OUTCOMES.PEDIU_RETORNO, T1, { scheduledFor: '2026-10-20' });

  expect(s.eventos).toHaveLength(4);
  expect(s.eventos[0].tipo).toBe(EVENT_TYPES.CLAIMED);
  expect(s.eventos[1].tipo).toBe(EVENT_TYPES.OUTCOME_REGISTERED);
  expect(s.eventos[2].tipo).toBe(EVENT_TYPES.CLAIMED);
  expect(s.eventos[3].tipo).toBe(EVENT_TYPES.OUTCOME_REGISTERED);
  expect(s.eventos[3].outcome).toBe(OUTCOMES.PEDIU_RETORNO);
});

// ── SM-31: estado imutável — não modifica o objeto original ──────────────────

test('SM-31: funções da máquina de estado são imutáveis (não modificam original)', () => {
  const original = estadoBase();
  const claimed  = claimOportunidade(original, OP1, T0);
  expect(original.estado).toBe(ESTADOS.DISPONIVEL);
  expect(claimed.estado).toBe(ESTADOS.EM_ATENDIMENTO);
});

// ── PERM-32: criarEstadoInicial lança para campos ausentes ───────────────────

test('PERM-32: criarEstadoInicial lança erro para campos obrigatórios ausentes', () => {
  expect(() => criarEstadoInicial('', OPP_ID, TIPO, T0)).toThrow(/commercialEntityId/);
  expect(() => criarEstadoInicial(ENTITY_ID, '', TIPO, T0)).toThrow(/opportunityInstanceId/);
  expect(() => criarEstadoInicial(ENTITY_ID, OPP_ID, '', T0)).toThrow(/tipoOportunidade/);
  expect(() => criarEstadoInicial(ENTITY_ID, OPP_ID, TIPO, '')).toThrow(/isoNow/);
});

// ── SM-33: registrarOutcome lança para outcome inválido ───────────────────────

test('SM-33: registrarOutcome lança para outcome inválido', () => {
  const s = estadoEmAtendimento();
  expect(() => registrarOutcome(s, OP1, 'OUTCOME_INVENTADO', T1)).toThrow(/outcome inválido/);
});

// ── SM-34: queries isClaimavel, isEmAtendimento, isConcluida ─────────────────

test('SM-34: queries retornam valores corretos por estado', () => {
  const sDisp = estadoBase();
  expect(isClaimavel(sDisp)).toBe(true);
  expect(isEmAtendimento(sDisp)).toBe(false);
  expect(isConcluida(sDisp)).toBe(false);

  const sEM = estadoEmAtendimento();
  expect(isClaimavel(sEM)).toBe(false);
  expect(isEmAtendimento(sEM)).toBe(true);

  const sCon = registrarOutcome(estadoEmAtendimento(), OP1, OUTCOMES.CONVERSA_REALIZADA, T1);
  expect(isConcluida(sCon)).toBe(true);
  expect(isClaimavel(sCon)).toBe(false);
});

// ── SM-35: getOperadorAtual e getUltimoOutcome ────────────────────────────────

test('SM-35: getOperadorAtual e getUltimoOutcome refletem estado correto', () => {
  const s = estadoEmAtendimento(OP1);
  expect(getOperadorAtual(s)).toBe(OP1);

  const sCon = registrarOutcome(s, OP1, OUTCOMES.SEM_RESPOSTA, T1);
  expect(getOperadorAtual(sCon)).toBeNull();
  expect(getUltimoOutcome(sCon)).toBe(OUTCOMES.SEM_RESPOSTA);
});
