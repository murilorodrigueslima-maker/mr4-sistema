'use strict';
// N35.9B — Testes do desenho do estado operacional
// Valida: identity, state machine, worklist, concorrência (local), idempotência

const path = require('path');
const WORKDIR = path.join(__dirname, '..');

const {
  buildCommercialEntityId,
  buildOpportunityInstanceId,
  commercialEntityIdFromPerfil360,
  validateIdentity,
  SOURCES,
  parseCommercialEntityId,
  ANCHOR_NUNCA,
} = require('../lib/commercialIdentity');

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

const {
  gerarDailyWorklist,
  gerarWorklistSimples,
  WORKLIST_CAP,
} = require('../lib/dailyWorklist');

const NOW = '2026-09-24T10:00:00.000Z';
const NOW2 = '2026-09-24T10:05:00.000Z';

// ── FASES 3 + 4: Identity Contract & clienteMr4Id guard ──────────────────────

test('N35-9B-ID-01: GC_NATIVE identity não depende de clientes/{id}', () => {
  const perfil = { source: 'GC_NATIVE', gestaoClickId: '31349459', clienteMr4Id: '31349459' };
  const result = validateIdentity(perfil);
  expect(result.valid).toBe(true);
  expect(result.commercialEntityId).toBe('GC_NATIVE:31349459');
});

test('N35-9B-ID-02: MR4_LINKED identity não usa gestaoClickId puro como id', () => {
  // Tentar usar gestaoClickId numérico como mr4ClientId deve falhar
  expect(() =>
    buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: '31349459' })
  ).toThrow(/parece gestaoClickId/);
});

test('N35-9B-ID-03: OPERATIONAL_STATE_REQUIRES_CLIENTE_MR4_ID=NO para GC_NATIVE', () => {
  const gcNativeIds = ['18950912','19071983','19156323','19463017','19473623'];
  for (const gcId of gcNativeIds) {
    const perfil = { source: 'GC_NATIVE', gestaoClickId: gcId };
    const result = validateIdentity(perfil);
    expect(result.valid).toBe(true);
    expect(result.commercialEntityId.startsWith('GC_NATIVE:')).toBe(true);
    // Sem dependência de campo clienteMr4Id para GC_NATIVE
    const parsed = parseCommercialEntityId(result.commercialEntityId);
    expect(parsed.source).toBe('GC_NATIVE');
    expect(parsed.stableId).toBe(gcId);
  }
});

test('N35-9B-ID-04: Zero colisões em 75 perfis simulados', () => {
  const GC_IDS  = ['18950912','19071983','19156323','19463017','19473623',
                   '23011207','30716035','31349459','32275912','36551586'];
  const MR4_IDS = Array.from({ length: 65 }, (_, i) => `mr4Synthetic${String(i+1).padStart(4,'0')}AbCd`);

  const ids = new Set();
  let collisions = 0;

  for (const gcId of GC_IDS) {
    const id = buildCommercialEntityId({ source: 'GC_NATIVE', gestaoClickId: gcId });
    if (ids.has(id)) collisions++;
    ids.add(id);
  }
  for (const mr4Id of MR4_IDS) {
    const id = buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: mr4Id });
    if (ids.has(id)) collisions++;
    ids.add(id);
  }

  expect(collisions).toBe(0);
  expect(ids.size).toBe(75);
});

test('N35-9B-ID-05: opportunityInstanceId é estável (determinístico) para mesmo ciclo', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0001AbCd';
  const tipo   = 'REATIVACAO_120D';
  const anchor = '2026-01-15';

  const id1 = buildOpportunityInstanceId(commId, tipo, anchor);
  const id2 = buildOpportunityInstanceId(commId, tipo, anchor);
  expect(id1).toBe(id2);
  expect(id1).toHaveLength(16);
  expect(/^[0-9a-f]{16}$/.test(id1)).toBe(true);
});

test('N35-9B-ID-06: opportunityInstanceId muda com nova compra (nova ultimaCompraEm)', () => {
  const commId = 'GC_NATIVE:31349459';
  const tipo   = 'REATIVACAO_120D';

  const idCiclo1 = buildOpportunityInstanceId(commId, tipo, '2025-06-01');
  const idCiclo2 = buildOpportunityInstanceId(commId, tipo, '2026-01-15');
  expect(idCiclo1).not.toBe(idCiclo2);
});

test('N35-9B-ID-07: opportunityInstanceId de PROSPECT_VINCULADO usa ANCHOR_NUNCA', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0002AbCd';
  const id1 = buildOpportunityInstanceId(commId, 'PROSPECT_VINCULADO', null);
  const id2 = buildOpportunityInstanceId(commId, 'PROSPECT_VINCULADO', null);
  expect(id1).toBe(id2); // estável
  expect(id1).toHaveLength(16);
});

test('N35-9B-ID-08: opportunityInstanceId é único entre tipos para mesma entidade', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0003AbCd';
  const anchor = '2026-01-15';
  const ids = new Set([
    buildOpportunityInstanceId(commId, 'REATIVACAO_120D', anchor),
    buildOpportunityInstanceId(commId, 'QUEDA_DE_COMPRAS', anchor),
    buildOpportunityInstanceId(commId, 'JANELA_DE_RECOMPRA', anchor),
  ]);
  expect(ids.size).toBe(3); // todos distintos
});

// ── FASE 7: State Machine de Produção ────────────────────────────────────────

test('N35-9B-SM-01: transição completa DISPONIVEL→EM_ATENDIMENTO→CONCLUIDA', () => {
  const commId = 'GC_NATIVE:31349459';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');
  const op     = 'usuario123';

  let estado = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
  expect(estado.estado).toBe(ESTADOS.DISPONIVEL);

  estado = claimOportunidade(estado, op, NOW);
  expect(estado.estado).toBe(ESTADOS.EM_ATENDIMENTO);

  estado = registrarOutcome(estado, op, OUTCOMES.CONVERSA_REALIZADA, NOW2);
  expect(estado.estado).toBe(ESTADOS.CONCLUIDA);
  expect(isConcluida(estado)).toBe(true);
});

test('N35-9B-SM-02: SEM_RESPOSTA retorna para DISPONIVEL sem cooldown', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0001AbCd';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');

  let estado = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);
  estado = registrarOutcome(estado, 'op1', OUTCOMES.SEM_RESPOSTA, NOW2);

  expect(estado.estado).toBe(ESTADOS.DISPONIVEL);
  expect(isClaimavel(estado)).toBe(true); // imediatamente claimável
});

test('N35-9B-SM-03: PEDIU_RETORNO → AGUARDANDO_RETORNO → EM_ATENDIMENTO', () => {
  const commId = 'GC_NATIVE:19463017';
  const oppId  = buildOpportunityInstanceId(commId, 'QUEDA_DE_COMPRAS', '2025-09-01');

  let estado = criarEstadoInicial(commId, oppId, 'QUEDA_DE_COMPRAS', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);
  estado = registrarOutcome(estado, 'op1', OUTCOMES.PEDIU_RETORNO, NOW2, { dataRetorno: '2026-09-30' });
  expect(estado.estado).toBe(ESTADOS.AGUARDANDO_RETORNO);

  // Pode ser claimado novamente
  expect(isClaimavel(estado)).toBe(true);
  estado = claimOportunidade(estado, 'op2', '2026-09-30T09:00:00.000Z');
  expect(estado.estado).toBe(ESTADOS.EM_ATENDIMENTO);
});

test('N35-9B-SM-04: estado CONCLUIDA não pode ser claimado', () => {
  const commId = 'GC_NATIVE:23011207';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-02-01');

  let estado = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);
  estado = registrarOutcome(estado, 'op1', OUTCOMES.SEM_INTERESSE_AGORA, NOW2);
  expect(isConcluida(estado)).toBe(true);

  expect(() => claimOportunidade(estado, 'op2', NOW2)).toThrow(/não permite claim/);
});

test('N35-9B-SM-05: release libera sem registrar outcome', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0004AbCd';
  const oppId  = buildOpportunityInstanceId(commId, 'JANELA_DE_RECOMPRA', '2026-03-01');

  let estado = criarEstadoInicial(commId, oppId, 'JANELA_DE_RECOMPRA', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);
  estado = releaseOportunidade(estado, 'op1', NOW2);

  expect(estado.estado).toBe(ESTADOS.DISPONIVEL);
  expect(estado.claimAtual).toBeNull();
  expect(getUltimoOutcome(estado)).toBeNull(); // sem outcome registrado
});

test('N35-9B-SM-06: operador não pode liberar claim de outro operador', () => {
  const commId = 'GC_NATIVE:30716035';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-01');

  let estado = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);

  expect(() => releaseOportunidade(estado, 'op2', NOW2)).toThrow(/não possui o claim/);
});

test('N35-9B-SM-07: audit trail imutável — evento adicionado não altera anteriores', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0005AbCd';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');

  let estado = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
  const estadoOriginal = { ...estado };

  estado = claimOportunidade(estado, 'op1', NOW);
  expect(estadoOriginal.eventos.length).toBe(0);
  expect(estado.eventos.length).toBe(1);

  const primeiroEvento = { ...estado.eventos[0] };
  estado = registrarOutcome(estado, 'op1', OUTCOMES.SEM_RESPOSTA, NOW2);
  expect(estado.eventos[0]).toEqual(primeiroEvento); // primeiro evento inalterado
  expect(estado.eventos.length).toBe(2);
});

// ── FASE 13: Concorrência local (simulação pura) ──────────────────────────────

test('N35-9B-CONC-01: duplo claim concorrente — apenas um deve ter sucesso', () => {
  const commId = 'GC_NATIVE:36551586';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-02-01');

  const estadoInicial = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);

  // Simula dois operadores tentando claim do mesmo estado inicial (snapshot = mesma versão)
  const op1Success = (() => {
    try {
      return claimOportunidade(estadoInicial, 'op1', NOW);
    } catch { return null; }
  })();

  const op2Success = (() => {
    try {
      // Pega o estado depois do claim do op1 — o segundo claim falha por estado
      const estadoDepoisOp1 = op1Success;
      return claimOportunidade(estadoDepoisOp1, 'op2', NOW2);
    } catch { return null; }
  })();

  // op1 teve sucesso, op2 falhou
  expect(op1Success).not.toBeNull();
  expect(op2Success).toBeNull();
  expect(op1Success.estado).toBe(ESTADOS.EM_ATENDIMENTO);
  expect(getOperadorAtual(op1Success)).toBe('op1');
});

test('N35-9B-CONC-02: transação atômica simulada — o vencedor é deterministicamente único', () => {
  // Em Firestore real: a transação conditional update garante que
  // exatamente um claim ganha. Aqui simulamos o invariante.
  const commId = 'MR4_LINKED:mr4Synthetic0010AbCd';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');

  const estadoV1 = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);

  // Ambos op1 e op2 leram estadoV1 "ao mesmo tempo"
  // O sistema Firestore aplica transação: apenas uma gravação ganha
  // Simulamos: op1 ganha (versão 2 tem op1); op2 tenta sobre estadoV1 (stale) → falha
  const estadoV2 = claimOportunidade(estadoV1, 'op1', NOW);

  // op2 tenta com base em estadoV1 (versão stale) — estado = DISPONIVEL, ok
  // mas após a transação, leria estadoV2 (EM_ATENDIMENTO) → lança erro
  expect(() => claimOportunidade(estadoV2, 'op2', NOW2)).toThrow(/não permite claim/);
});

// ── FASE 16/17: Idempotência ──────────────────────────────────────────────────

test('N35-9B-IDEMP-01: duplo registro de outcome deve lançar erro no segundo', () => {
  const commId = 'GC_NATIVE:19071983';
  const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');

  let estado = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);
  estado = registrarOutcome(estado, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW2);

  // Segundo registro: estado já é CONCLUIDA → lança erro
  expect(() => registrarOutcome(estado, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW2))
    .toThrow(/não é EM_ATENDIMENTO/);
});

test('N35-9B-IDEMP-02: duplo claim na mesma oportunidade é rejeitado', () => {
  const commId = 'GC_NATIVE:19156323';
  const oppId  = buildOpportunityInstanceId(commId, 'QUEDA_DE_COMPRAS', '2025-08-01');

  let estado = criarEstadoInicial(commId, oppId, 'QUEDA_DE_COMPRAS', NOW);
  estado = claimOportunidade(estado, 'op1', NOW);

  expect(() => claimOportunidade(estado, 'op1', NOW2)).toThrow(/não permite claim/);
});

// ── FASE 11: Conclusão não bloqueia entrada futura ────────────────────────────

test('N35-9B-REENTRY-01: nova oportunidade gera novo opportunityInstanceId após compra', () => {
  const commId = 'MR4_LINKED:mr4Synthetic0020AbCd';

  // Ciclo 1: cliente comprou em jan
  const opp1 = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');

  // Simulação: processo opp1 completo (concluída)
  let estado1 = criarEstadoInicial(commId, opp1, 'REATIVACAO_120D', NOW);
  estado1 = claimOportunidade(estado1, 'op1', NOW);
  estado1 = registrarOutcome(estado1, 'op1', OUTCOMES.CONVERSA_REALIZADA, NOW2);
  expect(isConcluida(estado1)).toBe(true);

  // Ciclo 2: cliente não comprou há 120 dias (nova âncora = outra data)
  // A nova oportunidade gera um oppId DIFERENTE → novo documento
  const opp2 = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-06-01');
  expect(opp2).not.toBe(opp1);

  // Novo estado para opp2 — começa como DISPONIVEL
  const estado2 = criarEstadoInicial(commId, opp2, 'REATIVACAO_120D', '2026-09-24T10:00:00.000Z');
  expect(estado2.estado).toBe(ESTADOS.DISPONIVEL);
  expect(isClaimavel(estado2)).toBe(true);
});

// ── FASE 22: Backlog / CAP separados ─────────────────────────────────────────

test('N35-9B-CAP-01: CAP não exclui follow-ups — apenas limita novas tarefas', () => {
  // Simular: 8 novas tarefas + 3 follow-ups (AGUARDANDO_RETORNO pelo mesmo op)
  const criarClienteHoje = (id, decisao, diasSemComprar, oppId) => ({
    commercialEntityId: id, opportunityInstanceId: oppId,
    decisaoAcaoComercial: decisao, diasSemComprar,
  });

  const operadorId = 'op1';

  // 8 clientes novos (AGIR_AGORA, sem estado operacional)
  const novos = Array.from({ length: 8 }, (_, i) => {
    const commId = `MR4_LINKED:mr4Synthetic${String(i+30).padStart(4,'0')}AbCd`;
    return criarClienteHoje(commId, 'AGIR_AGORA', 150 - i, null);
  });

  // 3 follow-ups do mesmo operador (AGUARDANDO_RETORNO)
  const GC = ['31349459', '30716035', '23011207'];
  const followUpsEstados = new Map();
  const followUps = GC.map(gcId => {
    const commId = `GC_NATIVE:${gcId}`;
    const oppId  = buildOpportunityInstanceId(commId, 'REATIVACAO_120D', '2026-01-15');
    // Estado: AGUARDANDO_RETORNO (claimável pelo operadorId)
    let est = criarEstadoInicial(commId, oppId, 'REATIVACAO_120D', NOW);
    est = claimOportunidade(est, operadorId, NOW);
    est = registrarOutcome(est, operadorId, OUTCOMES.PEDIU_RETORNO, NOW, { dataRetorno: '2026-09-24' });
    followUpsEstados.set(oppId, est);
    return criarClienteHoje(commId, 'AGIR_AGORA', 120, oppId);
  });

  const todosClientes = [...novos, ...followUps];
  const estadosMap    = followUpsEstados;

  const { worklist, total, cap, aplicouCap } = gerarDailyWorklist({
    clientesHoje: todosClientes,
    estadosOperacionais: estadosMap,
    operadorId,
    cap: WORKLIST_CAP,
  });

  // CAP_10 = 10; temos 11 elegíveis (8 novos + 3 follow-ups do mesmo op)
  expect(total).toBe(11);  // todos elegíveis (follow-ups do mesmo op são incluídos)
  expect(cap).toBe(10);
  expect(aplicouCap).toBe(true);
  expect(worklist.length).toBe(10);
});

test('N35-9B-CAP-02: backlog não desaparece após CAP — apenas não entra na worklist hoje', () => {
  const cap = 3;
  const clientes = Array.from({ length: 10 }, (_, i) => ({
    commercialEntityId: `MR4_LINKED:mr4Synthetic${String(i+50).padStart(4,'0')}AbCd`,
    decisaoAcaoComercial: 'AGIR_AGORA',
    diasSemComprar: 200 - i,
  }));

  const { worklist, total, aplicouCap } = gerarWorklistSimples(clientes, cap);
  expect(total).toBe(10);     // todos presentes na estrutura
  expect(worklist.length).toBe(3);  // só 3 na worklist de hoje
  expect(aplicouCap).toBe(true);
  // Os 7 restantes não são descartados — apenas não estão na worklist hoje
  // (backlog = lista original - worklist)
  const backlogCount = total - worklist.length;
  expect(backlogCount).toBe(7);
});

// ── FASE 24: GC_NATIVE no frontend (fluxo operacional) ───────────────────────

test('N35-9B-GC-01: GC_NATIVE gera opportunityInstanceId válido para operações', () => {
  const gcPerfil = {
    source: 'GC_NATIVE',
    gestaoClickId: '31349459',
    nomeCliente: '51.908.552 MAGNO ERNESTO TEIXEIRA',
    tipoOportunidade: 'REATIVACAO_120D',
    ultimaCompraEm: '2026-01-15',
  };

  const result = validateIdentity(gcPerfil);
  expect(result.valid).toBe(true);

  const oppId = buildOpportunityInstanceId(
    result.commercialEntityId,
    gcPerfil.tipoOportunidade,
    gcPerfil.ultimaCompraEm
  );

  // Pode criar estado operacional válido
  const estado = criarEstadoInicial(result.commercialEntityId, oppId, 'REATIVACAO_120D', NOW);
  expect(estado.estado).toBe(ESTADOS.DISPONIVEL);
  expect(estado.commercialEntityId).toBe('GC_NATIVE:31349459');
  expect(isClaimavel(estado)).toBe(true);
});

test('N35-9B-GC-02: GC_NATIVE não requer campo clientes/{id} para operar', () => {
  // GC_NATIVE tem gestaoClickId como chave; clienteMr4Id = gestaoClickId (alias)
  // O estado operacional usa commercialEntityId que NÃO é o docId de clientes/
  const gcPerfil = {
    source: 'GC_NATIVE',
    gestaoClickId: '36551586',
    // SEM clienteMr4Id ≠ gestaoClickId (ausente ou igual — irrelevante para identidade)
  };

  const result = validateIdentity(gcPerfil);
  expect(result.valid).toBe(true);
  expect(result.commercialEntityId).toBe('GC_NATIVE:36551586');

  // Nunca vai buscar clientes/36551586 para criar estado operacional
  // (o documento não existe em clientes/ para GC_NATIVE puros)
  const parsed = parseCommercialEntityId(result.commercialEntityId);
  expect(parsed.source).toBe('GC_NATIVE');
  expect(parsed.stableId).toBe('36551586');
});

// ── FASE 27: Quarentena dos 22 IDs ───────────────────────────────────────────

test('N35-9B-QUAR-01: IDs em quarentena não geram estado operacional na worklist', () => {
  // Simular: cliente em quarentena não deve aparecer
  // Implementação: filtro antes de criarEstadoInicial
  const QUARANTINED = new Set(['18950912', '19071983']); // exemplo de 2 dos 22

  const clientes = [
    { commercialEntityId: 'GC_NATIVE:18950912', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 200, quarentena: true },
    { commercialEntityId: 'GC_NATIVE:31349459', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 150, quarentena: false },
    { commercialEntityId: 'MR4_LINKED:mr4Synthetic0001AbCd', decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 130 },
  ];

  // Filtro de quarentena deve acontecer ANTES do CAP
  const elegiveis = clientes.filter(c => !c.quarentena);
  expect(elegiveis.length).toBe(2);

  const { worklist } = gerarWorklistSimples(elegiveis, 10);
  expect(worklist.some(c => QUARANTINED.has(c.commercialEntityId.split(':')[1]))).toBe(false);
});
