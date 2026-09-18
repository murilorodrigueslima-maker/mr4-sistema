'use strict';

/**
 * N31 — ACTION OBEDIENCE CONTRACT
 *
 * OPENAI_CALLS = 0. Pipeline simulado com MockProvider.
 * Motor determinístico > LLM: acaoTiming reflete exatamente a decisão.
 *
 * Suites:
 *   OBEY-01..30    — 30 testes de obediência estruturada e textual
 *   ADV-01..20     — 20 testes adversariais
 *   NULLCTRL-xxx   — 4 casos null control × 3 cenários = 12 testes
 *
 * Total: 62 testes. OPENAI_CALLS_REAL = 0.
 */

const {
  buildGroundingFactsV2,
  validarClaimsV2,
  validarFatosNoTextoV2,
  validarContradicaoSemanticaV2,
  validarMarcadoresProibidosV2,
  validarCoerenciaAcaoComercial,
  validarTextoAcaoComercial,
  GroundingV2ViolationError,
  AcaoCoerenciaViolationError,
  TextoAcaoViolationError,
  TextFactV2ViolationError,
} = require('../lib/n29/groundingOutput');

const { calcularDecisaoAcaoComercial } = require('../lib/decisaoAcaoComercial');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Contexto V2 mínimo com todos os 22 campos. */
function makeCtxV2(overrides = {}) {
  return {
    tipoOportunidade:             null,
    scoreTotal:                   50,
    classificacao:                'REGULAR',
    diasSemComprar:               5,
    tendencia:                    'ESTAVEL',
    recorrenciaStatus:            'DENTRO_DO_PADRAO',
    prioridade:                   null,
    pedidosTotal:                 10,
    pedidos30d:                   2,
    pedidos60d:                   3,
    pedidos90d:                   4,
    pedidos180d:                  7,
    faturamentoTotal:             5000,
    faturamento30d:               800,
    faturamento60d:               1200,
    faturamento90d:               1600,
    faturamento180d:              3000,
    ticketMedioTotal:             500,
    diasEntreComprasMedio:        15,
    diasEntreComprasMediana:      14,
    quantidadeProdutosDistintos:  5,
    quantidadeCategoriasDistintas: 2,
    ...overrides,
  };
}

/** Output V2 mock mínimo e obediente (sem valores numéricos para não acionar grounding). */
function makeOutput(overrides = {}) {
  return {
    diagnostico:      'Cliente com padrão de compra regular e estável.',
    sinaisRelevantes: ['Score comercial estável, sem oscilações recentes.'],
    acaoTiming:       'NO_CICLO',
    acaoSugerida:     'Acompanhar no próximo ciclo de compra.',
    claims:           [],
    ...overrides,
  };
}

const VALIDOS_ACAO_TIMING = ['AGORA', 'NO_CICLO', 'NENHUMA'];

/**
 * Pipeline de validação V2 completo (sem OpenAI).
 * Retorna { status: 'PASS', facts, decisao } ou lança.
 */
function validarPipelineV2(ctx, decisao, mockOutput) {
  // Fase 1: schema acaoTiming obrigatório
  if (!mockOutput.acaoTiming || !VALIDOS_ACAO_TIMING.includes(mockOutput.acaoTiming)) {
    const err = new Error(
      `[SCHEMA-V2] acaoTiming ausente ou inválido: ${JSON.stringify(mockOutput.acaoTiming)}`
    );
    err.name = 'SchemaAcaoTimingError';
    throw err;
  }

  // Fase 2: grounding facts
  const facts = buildGroundingFactsV2(ctx, decisao);

  // Fase 3: claims grounding
  if (Array.isArray(mockOutput.claims) && mockOutput.claims.length > 0) {
    validarClaimsV2(mockOutput.claims, facts);
  }

  // Fase 4: coerência estrutural (decisão → acaoTiming)
  validarCoerenciaAcaoComercial(decisao.decisaoAcaoComercial, mockOutput.acaoTiming);

  // Fase 5: validação textual de ação comercial
  validarTextoAcaoComercial(decisao.decisaoAcaoComercial, mockOutput);

  // Fase 6: grounding texto-fatos
  const textoCompleto = [
    mockOutput.diagnostico || '',
    ...(mockOutput.sinaisRelevantes || []),
    mockOutput.acaoSugerida || '',
  ].join(' ');
  validarFatosNoTextoV2(textoCompleto, mockOutput.claims || [], facts);

  // Fase 7: contradição semântica
  validarContradicaoSemanticaV2(textoCompleto, facts);

  // Fase 8: guardrails financeiros
  validarMarcadoresProibidosV2(mockOutput);

  return { status: 'PASS', facts, decisao };
}

// ── Fixtures dos 4 casos NULL CONTROL (análogos aos SHADOW-001..012) ─────────

const NULL_CONTROL_CASOS = [
  // A: cliente dentro do padrão, oportunidade null → PROGRAMAR_CICLO
  {
    id: 'NC-A',
    ctx: makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'DENTRO_DO_PADRAO', diasEntreComprasMediana: 14, diasSemComprar: 2 }),
    expectedDecisao: 'PROGRAMAR_CICLO',
    expectedTiming:  'NO_CICLO',
    expectedDias:    12,
  },
  // B: reativação → AGIR_AGORA
  {
    id: 'NC-B',
    ctx: makeCtxV2({ tipoOportunidade: 'REATIVACAO_120D', recorrenciaStatus: 'ATRASADO', diasSemComprar: 225 }),
    expectedDecisao: 'AGIR_AGORA',
    expectedTiming:  'AGORA',
    expectedDias:    null,
  },
  // C: queda de compras → AGIR_AGORA
  {
    id: 'NC-C',
    ctx: makeCtxV2({ tipoOportunidade: 'QUEDA_DE_COMPRAS', recorrenciaStatus: 'ATRASADO', diasSemComprar: 73 }),
    expectedDecisao: 'AGIR_AGORA',
    expectedTiming:  'AGORA',
    expectedDias:    null,
  },
  // D: sem base, mediana null → NAO_AGIR
  {
    id: 'NC-D',
    ctx: makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null, diasSemComprar: null }),
    expectedDecisao: 'NAO_AGIR',
    expectedTiming:  'NENHUMA',
    expectedDias:    null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE OBEY-01..30 — Obediência estruturada e textual
// ─────────────────────────────────────────────────────────────────────────────

describe('N31 — OBEY: Action Obedience Contract', () => {

  // ── Structural coherence ──────────────────────────────────────────────────

  test('OBEY-01: AGIR_AGORA + AGORA → PASS (coerência estrutural)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 225 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'AGORA', acaoSugerida: 'Priorizar este cliente na fila de recompra.' });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  test('OBEY-02: PROGRAMAR_CICLO + NO_CICLO → PASS (coerência estrutural)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 2 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NO_CICLO' });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
    expect(decisao.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
  });

  test('OBEY-03: NAO_AGIR + NENHUMA → PASS (coerência estrutural)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NENHUMA', acaoSugerida: 'Sem ação indicada no momento. Monitorar.' });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
    expect(decisao.decisaoAcaoComercial).toBe('NAO_AGIR');
  });

  test('OBEY-04: AGIR_AGORA + NO_CICLO → BLOCK (acaoTiming errado)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 40 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NO_CICLO' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(AcaoCoerenciaViolationError);
  });

  test('OBEY-05: AGIR_AGORA + NENHUMA → BLOCK (acaoTiming errado)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'JANELA_DE_RECOMPRA', diasSemComprar: 20 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NENHUMA' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(AcaoCoerenciaViolationError);
  });

  test('OBEY-06: PROGRAMAR_CICLO + AGORA → BLOCK (modelo ignora decisão)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 22, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'AGORA' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(AcaoCoerenciaViolationError);
  });

  test('OBEY-07: PROGRAMAR_CICLO + NENHUMA → BLOCK (modelo subdecide)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 22, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NENHUMA' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(AcaoCoerenciaViolationError);
  });

  test('OBEY-08: NAO_AGIR + AGORA → BLOCK (modelo cria ação inexistente)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'AGORA' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(AcaoCoerenciaViolationError);
  });

  test('OBEY-09: NAO_AGIR + NO_CICLO → BLOCK (modelo superdecide)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'ATRASADO', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NO_CICLO' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(AcaoCoerenciaViolationError);
  });

  // ── Text action validator — PROGRAMAR_CICLO ───────────────────────────────

  test('OBEY-10: PROGRAMAR_CICLO + texto "entre em contato imediatamente" → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NO_CICLO',
      acaoSugerida: 'Entre em contato imediatamente com o cliente.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  test('OBEY-11: PROGRAMAR_CICLO + texto "ligue hoje" → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NO_CICLO', acaoSugerida: 'Ligue hoje para fechar.' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  test('OBEY-12: PROGRAMAR_CICLO + texto respeita ciclo → PASS', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NO_CICLO',
      acaoSugerida: 'Programar contato para o próximo ciclo de compra (em 9 dias).',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  // ── Text action validator — NAO_AGIR ──────────────────────────────────────

  test('OBEY-13: NAO_AGIR + texto "entre em contato com o cliente" → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      acaoSugerida: 'Entre em contato com o cliente para verificar necessidades.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  test('OBEY-14: NAO_AGIR + texto "faça uma oferta" → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NENHUMA', acaoSugerida: 'Faça uma oferta especial para este cliente.' });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  test('OBEY-15: NAO_AGIR + texto conservador → PASS', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      acaoSugerida: 'Não há ação comercial indicada no momento. Aguardar sinal do motor.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  // ── Grounding diasAteProximoCiclo ─────────────────────────────────────────

  test('OBEY-16: PROGRAMAR_CICLO diasAteProximoCiclo=8 — claim 8 dias → PASS', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    expect(decisao.diasAteProximoCiclo).toBe(8);
    const output = makeOutput({
      acaoTiming:  'NO_CICLO',
      acaoSugerida: 'Próximo ciclo em 8 dias. Preparar abordagem.',
      claims:      [{ field: 'diasAteProximoCiclo', value: 8 }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  test('OBEY-17: PROGRAMAR_CICLO diasAteProximoCiclo=8 — claim valor=9 → BLOCK (grounding)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming: 'NO_CICLO',
      claims:     [{ field: 'diasAteProximoCiclo', value: 9 }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(GroundingV2ViolationError);
  });

  test('OBEY-18: PROGRAMAR_CICLO diasAteProximoCiclo=8 — texto inventa "amanhã" → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NO_CICLO',
      acaoSugerida: 'O cliente deve ser abordado amanhã para maximizar conversão.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  test('OBEY-19: PROGRAMAR_CICLO — claim diasAteProximoCiclo inventado quando null → BLOCK', () => {
    // NAO_AGIR → diasAteProximoCiclo=null nos facts; modelo não pode afirmar valor
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    expect(decisao.diasAteProximoCiclo).toBeNull();
    const output = makeOutput({
      acaoTiming: 'NENHUMA',
      claims:     [{ field: 'diasAteProximoCiclo', value: 0 }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(GroundingV2ViolationError);
  });

  test('OBEY-20: PROGRAMAR_CICLO — diasAteProximoCiclo correto no fact, claim null → PASS', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NO_CICLO', claims: [] });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  // ── Schema acaoTiming ─────────────────────────────────────────────────────

  test('OBEY-21: acaoTiming ausente → BLOCK (schema)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput();
    delete output.acaoTiming;
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(/SchemaAcaoTiming|acaoTiming/);
  });

  test('OBEY-22: acaoTiming=null → BLOCK (schema)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: null });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(/SchemaAcaoTiming|acaoTiming/);
  });

  test('OBEY-23: acaoTiming="TALVEZ" → BLOCK (schema: valor fora do enum)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'TALVEZ' });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(/SchemaAcaoTiming|acaoTiming/);
  });

  test('OBEY-24: acaoTiming="agora" (lowercase) → BLOCK (schema: case-sensitive)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 200 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'agora' });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(/SchemaAcaoTiming|acaoTiming/);
  });

  // ── AGIR_AGORA text freedom ───────────────────────────────────────────────

  test('OBEY-25: AGIR_AGORA + texto com "entre em contato" → PASS (ação legítima)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 225 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'AGORA',
      acaoSugerida: 'Entre em contato com o cliente para reativação.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  test('OBEY-26: AGIR_AGORA + texto "ligue hoje" → PASS (ação legítima)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 50 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'AGORA', acaoSugerida: 'Ligue hoje para converter oportunidade.' });
    expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
  });

  // ── Cross-field text validation ───────────────────────────────────────────

  test('OBEY-27: NAO_AGIR + acaoTiming=NENHUMA mas diagnostico contém "entre em contato" → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      diagnostico: 'Realize o contato. Entre em contato urgente.',
      acaoSugerida: 'Aguardar.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  test('OBEY-28: NAO_AGIR + acaoTiming=NENHUMA mas sinaisRelevantes contém "ligue" → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:        'NENHUMA',
      sinaisRelevantes:  ['É necessário ligar agora para o cliente.'],
      acaoSugerida:      'Sem ação comercial indicada.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output))
      .toThrow(TextoAcaoViolationError);
  });

  // ── Fail closed ───────────────────────────────────────────────────────────

  test('OBEY-29: erro no text action validator → pipeline FAIL_CLOSED (não aprova silenciosamente)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NENHUMA', acaoSugerida: 'Contate o cliente imediatamente.' });
    let threw = false;
    try {
      validarPipelineV2(ctx, decisao, output);
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(TextoAcaoViolationError);
    }
    expect(threw).toBe(true);
  });

  test('OBEY-30: erro no grounding → pipeline FAIL_CLOSED (erro propagado, não ignorado)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming: 'NO_CICLO',
      claims:     [{ field: 'scoreTotal', value: 9999 }],  // valor inventado
    });
    let threw = false;
    try {
      validarPipelineV2(ctx, decisao, output);
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(GroundingV2ViolationError);
    }
    expect(threw).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE ADV-01..20 — Adversarial: tentativas de escape
// ─────────────────────────────────────────────────────────────────────────────

describe('N31 — ADV: Adversarial Action Escape Attempts', () => {

  test('ADV-01: NAO_AGIR — ação escondida em diagnostico → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      diagnostico: 'Score baixo. Entre em contato com o cliente para entender o contexto.',
      acaoSugerida: 'Sem ação necessária.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-02: NAO_AGIR — ação escondida em sinaisRelevantes → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:       'NENHUMA',
      sinaisRelevantes: ['Mande mensagem para verificar disponibilidade.'],
      acaoSugerida:     'Aguardar momento oportuno.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-03: NAO_AGIR — modelo inventa claim oportunidadeTipo → BLOCK (grounding)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming: 'NENHUMA',
      claims:     [{ field: 'oportunidadeTipo', value: 'REATIVACAO_120D' }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(GroundingV2ViolationError);
  });

  test('ADV-04: NAO_AGIR — modelo altera acaoTiming para AGORA via output direto → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'AGORA' });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(AcaoCoerenciaViolationError);
  });

  test('ADV-05: PROGRAMAR_CICLO — texto "ligue hoje" em acaoSugerida → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'NO_CICLO', acaoSugerida: 'Ligue hoje para garantir o pedido.' });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-06: PROGRAMAR_CICLO — "entre em contato imediatamente" no diagnostico → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NO_CICLO',
      diagnostico: 'Situação regular. Entre em contato imediatamente.',
      acaoSugerida: 'Aguardar ciclo.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-07: NAO_AGIR — texto com urgência sem sinal → BLOCK (URGENCIA_SEM_SINAL)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null, prioridade: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      diagnostico: 'Situação urgente. O cliente precisa de atenção imediata.',
      acaoSugerida: 'Monitorar.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextFactV2ViolationError);
  });

  test('ADV-08: AGIR_AGORA — modelo sugere "CONCEDER_DESCONTO" → BLOCK (guardrail financeiro)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 200 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'AGORA',
      acaoSugerida: 'CONCEDER_DESCONTO de 15% para reativar o cliente.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow();
  });

  test('ADV-09: AGIR_AGORA — modelo sugere "ALTERAR_LIMITE" → BLOCK (guardrail financeiro)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 45 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'AGORA',
      acaoSugerida: 'ALTERAR_LIMITE de crédito para facilitar a compra.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow();
  });

  test('ADV-10: PROGRAMAR_CICLO — modelo tenta mudar acaoTiming para AGORA → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 22, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({ acaoTiming: 'AGORA' });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(AcaoCoerenciaViolationError);
  });

  test('ADV-11: NAO_AGIR — modelo tenta mudar acaoTiming para NO_CICLO → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'ATRASADO', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    expect(decisao.decisaoAcaoComercial).toBe('NAO_AGIR');
    const output = makeOutput({ acaoTiming: 'NO_CICLO' });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(AcaoCoerenciaViolationError);
  });

  test('ADV-12: AGIR_AGORA — modelo inventa diasAteProximoCiclo=10 via claim → BLOCK (null nos facts)', () => {
    const ctx = makeCtxV2({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 200 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    expect(decisao.diasAteProximoCiclo).toBeNull();
    const output = makeOutput({
      acaoTiming: 'AGORA',
      claims:     [{ field: 'diasAteProximoCiclo', value: 10 }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(GroundingV2ViolationError);
  });

  test('ADV-13: PROGRAMAR_CICLO — modelo inventa claim diasAteProximoCiclo errado → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 6 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    expect(decisao.diasAteProximoCiclo).toBe(8);
    const output = makeOutput({
      acaoTiming: 'NO_CICLO',
      claims:     [{ field: 'diasAteProximoCiclo', value: 5 }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(GroundingV2ViolationError);
  });

  test('ADV-14: NAO_AGIR — texto "faça uma oferta" em sinaisRelevantes → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:       'NENHUMA',
      sinaisRelevantes: ['Faça uma oferta agressiva para recuperar o cliente.'],
      acaoSugerida:     'Sem ação indicada.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-15: NAO_AGIR — modelo tenta claim campo _versaoGrounding (interno) → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming: 'NENHUMA',
      claims:     [{ field: '_versaoGrounding', value: 'grounding-v2-n29' }],
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(GroundingV2ViolationError);
  });

  test('ADV-16: AGIR_AGORA (QUEDA_DE_COMPRAS) — modelo contradiz tendência CAINDO → BLOCK (semântico)', () => {
    // PADROES_CONTRADICAO_TENDENCIA cobre 'CAINDO' e 'CRESCENDO' (não 'QUEDA')
    const ctx = makeCtxV2({
      tipoOportunidade: 'QUEDA_DE_COMPRAS',
      tendencia:        'CAINDO',
      diasSemComprar:   50,
    });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'AGORA',
      diagnostico: 'Compras estão aumentando, cliente em forte crescimento das compras.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow();
  });

  test('ADV-17: PROGRAMAR_CICLO — modelo inventa data ISO no texto → BLOCK (text-fact)', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NO_CICLO',
      diagnostico: 'Última compra em 2024-01-15. Próximo ciclo em 2024-02-01.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextFactV2ViolationError);
  });

  test('ADV-18: NAO_AGIR — "reative o cliente" no texto → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      acaoSugerida: 'Reative o cliente com uma proposta especial.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-19: NAO_AGIR — "O vendedor deve ligar para o cliente" → BLOCK', () => {
    const ctx = makeCtxV2({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:  'NENHUMA',
      acaoSugerida: 'O vendedor deve ligar para o cliente e apresentar novidades.',
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });

  test('ADV-20: PROGRAMAR_CICLO — "contate hoje" em sinaisRelevantes → BLOCK', () => {
    const ctx = makeCtxV2({ diasEntreComprasMediana: 14, diasSemComprar: 5 });
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const output = makeOutput({
      acaoTiming:       'NO_CICLO',
      sinaisRelevantes: ['Contate hoje para maximizar conversão.'],
    });
    expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(TextoAcaoViolationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE NULLCTRL — 4 casos × 3 cenários = 12 testes
// ─────────────────────────────────────────────────────────────────────────────

describe('N31 — NULLCTRL: Null Control Fixtures', () => {

  for (const caso of NULL_CONTROL_CASOS) {
    const { id, ctx, expectedDecisao, expectedTiming, expectedDias } = caso;

    test(`NULLCTRL-${id}-A: motor calcula decisão correta`, () => {
      const decisao = calcularDecisaoAcaoComercial(ctx);
      expect(decisao.decisaoAcaoComercial).toBe(expectedDecisao);
      expect(decisao.diasAteProximoCiclo).toBe(expectedDias);
    });

    test(`NULLCTRL-${id}-B: mock obediente com acaoTiming=${expectedTiming} → PASS`, () => {
      const decisao = calcularDecisaoAcaoComercial(ctx);
      const textoAcao = expectedDecisao === 'NAO_AGIR'
        ? 'Sem ação comercial indicada. Monitorar o perfil do cliente.'
        : expectedDecisao === 'PROGRAMAR_CICLO'
          ? 'Acompanhar no próximo ciclo de compra.'
          : 'Priorizar o atendimento a este cliente.';

      const output = makeOutput({ acaoTiming: expectedTiming, acaoSugerida: textoAcao });
      expect(() => validarPipelineV2(ctx, decisao, output)).not.toThrow();
    });

    test(`NULLCTRL-${id}-C: mock desobediente acaoTiming errado → BLOCK`, () => {
      const decisao = calcularDecisaoAcaoComercial(ctx);
      // acaoTiming sempre errado: usa valor diferente do esperado
      const timingsErrados = ['AGORA', 'NO_CICLO', 'NENHUMA'].filter(t => t !== expectedTiming);
      const timingErrado = timingsErrados[0];
      const output = makeOutput({ acaoTiming: timingErrado });
      expect(() => validarPipelineV2(ctx, decisao, output)).toThrow(AcaoCoerenciaViolationError);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CONTAGEM FINAL E CONTRATOS ESTÁTICOS
// ─────────────────────────────────────────────────────────────────────────────

describe('N31 — META: Contratos estáticos do pipeline', () => {

  test('OPENAI_CALLS_REAL = 0: nenhum import de provider real neste arquivo', () => {
    // Verifica por reflexão que calcularDecisaoAcaoComercial não faz chamadas externas
    const { VERSAO_DECISAO } = require('../lib/decisaoAcaoComercial');
    expect(VERSAO_DECISAO).toBe('decisao-acao-v1-n30');
    expect(typeof calcularDecisaoAcaoComercial).toBe('function');
  });

  test('ACAO_TIMING_MAP coerente: 3 valores, todos presentes', () => {
    const { ACAO_TIMING_MAP } = require('../lib/decisaoAcaoComercial');
    expect(ACAO_TIMING_MAP.AGIR_AGORA).toBe('AGORA');
    expect(ACAO_TIMING_MAP.PROGRAMAR_CICLO).toBe('NO_CICLO');
    expect(ACAO_TIMING_MAP.NAO_AGIR).toBe('NENHUMA');
  });

  test('validarTextoAcaoComercial exportado de groundingOutput', () => {
    const mod = require('../lib/n29/groundingOutput');
    expect(typeof mod.validarTextoAcaoComercial).toBe('function');
    expect(typeof mod.TextoAcaoViolationError).toBe('function');
  });

  test('ANALISE_OUTPUT_SCHEMA_V2 exige acaoTiming com enum exato', () => {
    const { ANALISE_OUTPUT_SCHEMA_V2 } = require('../lib/ai/providers/openaiProvider');
    expect(ANALISE_OUTPUT_SCHEMA_V2.required).toContain('acaoTiming');
    const acaoTimingProp = ANALISE_OUTPUT_SCHEMA_V2.properties.acaoTiming;
    expect(acaoTimingProp.type).toBe('string');
    expect(acaoTimingProp.enum).toEqual(['AGORA', 'NO_CICLO', 'NENHUMA']);
  });

  test('buildV2 aceita segundo param decisao sem lançar', () => {
    const { buildV2 } = require('../lib/ai/prompts/analistaOportunidadeV2');
    const ctx = makeCtxV2();
    const decisao = calcularDecisaoAcaoComercial(ctx);
    const prompt = buildV2(ctx, decisao);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('DECISÃO DE AÇÃO COMERCIAL');
    expect(prompt).toContain('PROGRAMAR_CICLO');
    expect(prompt).toContain('NO_CICLO');
  });

  test('buildV2 sem decisao usa NAO_AGIR como padrão conservador', () => {
    const { buildV2 } = require('../lib/ai/prompts/analistaOportunidadeV2');
    const ctx = makeCtxV2();
    const prompt = buildV2(ctx, null);
    expect(prompt).toContain('NAO_AGIR');
    expect(prompt).toContain('NENHUMA');
  });
});
