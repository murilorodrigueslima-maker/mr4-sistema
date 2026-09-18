'use strict';

/**
 * N30 — Testes determinísticos de decisão de ação comercial.
 *
 * OPENAI_CALLS = 0. Sem Firestore, HTTP, Firebase, side effects.
 * Total: 20 testes (ACTION-01..ACTION-20).
 *
 * Cobertura:
 *   ACTION-01..03: tipoOportunidade != null → AGIR_AGORA
 *   ACTION-04..06: null + DENTRO_DO_PADRAO → PROGRAMAR_CICLO + ciclo correto
 *   ACTION-07..10: NAO_AGIR cases + score isolado não cria oportunidade
 *   ACTION-11..16: validarCoerenciaAcaoComercial (BLOCK e PASS)
 *   ACTION-17..19: grounding blocks claims inventados sobre decisao/diasAteCiclo
 *   ACTION-20:     PROSPECT_VINCULADO explicitamente indica FILA_PROSPECCAO
 */

const {
  DECISAO_ENUM,
  FILA_PROSPECCAO_TIPOS,
  calcularDecisaoAcaoComercial,
} = require('../lib/decisaoAcaoComercial');

const {
  buildGroundingFactsV2,
  validarClaimsV2,
  validarCoerenciaAcaoComercial,
  GroundingV2ViolationError,
  AcaoCoerenciaViolationError,
} = require('../lib/n29/groundingOutput');

// ── ctx de suporte ─────────────────────────────────────────────────────────────
function makeCtx(overrides = {}) {
  return {
    tipoOportunidade:              null,
    scoreTotal:                    40,
    classificacao:                 'MEDIO',
    diasSemComprar:                6,
    tendencia:                     'ESTAVEL',
    recorrenciaStatus:             'DENTRO_DO_PADRAO',
    prioridade:                    null,
    pedidosTotal:                  5,
    pedidos30d:                    0,
    pedidos60d:                    1,
    pedidos90d:                    2,
    pedidos180d:                   3,
    faturamentoTotal:              1500.00,
    faturamento30d:                0,
    faturamento60d:                300.00,
    faturamento90d:                600.00,
    faturamento180d:               900.00,
    ticketMedioTotal:              300.00,
    diasEntreComprasMedio:         21,
    diasEntreComprasMediana:       22,
    quantidadeProdutosDistintos:   4,
    quantidadeCategoriasDistintas: 2,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRA A — AGIR_AGORA
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-01: REATIVACAO_120D → AGIR_AGORA:FILA_RECOMPRA', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        'REATIVACAO_120D',
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 30,
    diasSemComprar:          5,
  });
  expect(r.decisaoAcaoComercial).toBe('AGIR_AGORA');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('REATIVACAO_120D');
  expect(r.motivoDeterministico).toContain('FILA_RECOMPRA');
});

test('ACTION-02: JANELA_DE_RECOMPRA → AGIR_AGORA:FILA_RECOMPRA', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        'JANELA_DE_RECOMPRA',
    recorrenciaStatus:       'PROXIMO_DA_JANELA',
    diasEntreComprasMediana: 22,
    diasSemComprar:          20,
  });
  expect(r.decisaoAcaoComercial).toBe('AGIR_AGORA');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('FILA_RECOMPRA');
});

test('ACTION-03: QUEDA_DE_COMPRAS → AGIR_AGORA:FILA_RECOMPRA', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        'QUEDA_DE_COMPRAS',
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 15,
    diasSemComprar:          5,
  });
  expect(r.decisaoAcaoComercial).toBe('AGIR_AGORA');
  expect(r.motivoDeterministico).toContain('FILA_RECOMPRA');
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRA B — PROGRAMAR_CICLO
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-04: null + DENTRO_DO_PADRAO + mediana válida → PROGRAMAR_CICLO', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar:          6,
  });
  expect(r.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
  expect(r.motivoDeterministico).toContain('REGRA_B');
});

test('ACTION-05: diasAteProximoCiclo calculado corretamente (22 - 6 = 16)', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar:          6,
  });
  expect(r.diasAteProximoCiclo).toBe(16);
});

test('ACTION-06: estado DENTRO_DO_PADRAO com dias=mediana é INCONSISTENTE → NAO_AGIR (FAIL CLOSED)', () => {
  // O pipeline real nunca produz DENTRO_DO_PADRAO com diasSemComprar >= mediana.
  // (recorrencia.js: limiteAlerta = round(mediana×0.85) ≤ mediana → diasSemComprar < mediana sempre.)
  // A função pura deve detectar e rejeitar essa entrada inconsistente.
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22.0,
    diasSemComprar:          22.0, // dias == mediana → estado inconsistente
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('ESTADO_RECORRENCIA_INCONSISTENTE');
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRA C — NAO_AGIR
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-07: null + SEM_BASE → NAO_AGIR', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'SEM_BASE',
    diasEntreComprasMediana: null,
    diasSemComprar:          30,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('REGRA_C');
});

test('ACTION-08: null + mediana=null → NAO_AGIR (mesmo com DENTRO_DO_PADRAO)', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: null,
    diasSemComprar:          5,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
});

test('ACTION-09: score=100 sozinho (sem oportunidade, sem ciclo válido) → NAO_AGIR', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'SEM_BASE',
    diasEntreComprasMediana: null,
    diasSemComprar:          5,
    scoreTotal:              100,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
});

test('ACTION-10: score=5 + SEM_BASE → NAO_AGIR', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'SEM_BASE',
    diasEntreComprasMediana: null,
    diasSemComprar:          120,
    scoreTotal:              5,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
});

// ═══════════════════════════════════════════════════════════════════════════════
// validarCoerenciaAcaoComercial — BLOCK
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-11: NAO_AGIR + acaoTiming=AGORA → BLOCK (AcaoCoerenciaViolationError)', () => {
  expect(() => validarCoerenciaAcaoComercial('NAO_AGIR', 'AGORA'))
    .toThrow(AcaoCoerenciaViolationError);
});

test('ACTION-12: PROGRAMAR_CICLO + acaoTiming=AGORA → BLOCK', () => {
  let err = null;
  try { validarCoerenciaAcaoComercial('PROGRAMAR_CICLO', 'AGORA'); }
  catch (e) { err = e; }
  expect(err).toBeInstanceOf(AcaoCoerenciaViolationError);
  expect(err.acaoTimingEsperado).toBe('NO_CICLO');
});

test('ACTION-13: AGIR_AGORA + acaoTiming=NO_CICLO → BLOCK', () => {
  let err = null;
  try { validarCoerenciaAcaoComercial('AGIR_AGORA', 'NO_CICLO'); }
  catch (e) { err = e; }
  expect(err).toBeInstanceOf(AcaoCoerenciaViolationError);
  expect(err.acaoTimingEsperado).toBe('AGORA');
});

// ═══════════════════════════════════════════════════════════════════════════════
// validarCoerenciaAcaoComercial — PASS
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-14: AGIR_AGORA + acaoTiming=AGORA → PASS', () => {
  expect(() => validarCoerenciaAcaoComercial('AGIR_AGORA', 'AGORA')).not.toThrow();
});

test('ACTION-15: PROGRAMAR_CICLO + acaoTiming=NO_CICLO → PASS', () => {
  expect(() => validarCoerenciaAcaoComercial('PROGRAMAR_CICLO', 'NO_CICLO')).not.toThrow();
});

test('ACTION-16: NAO_AGIR + acaoTiming=NENHUMA → PASS', () => {
  expect(() => validarCoerenciaAcaoComercial('NAO_AGIR', 'NENHUMA')).not.toThrow();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grounding blocks claims inventados sobre campos N30
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-17: grounding bloqueia diasAteProximoCiclo inventado quando AGIR_AGORA (null)', () => {
  const ctx = makeCtx({ tipoOportunidade: 'REATIVACAO_120D', prioridade: 30 });
  const decisao = calcularDecisaoAcaoComercial(ctx); // AGIR_AGORA, diasAteProximoCiclo=null
  const facts = buildGroundingFactsV2(ctx, decisao);

  expect(facts.diasAteProximoCiclo).toBeNull();
  expect(() => validarClaimsV2([{ field: 'diasAteProximoCiclo', value: 10 }], facts))
    .toThrow(GroundingV2ViolationError);
});

test('ACTION-18: grounding bloqueia decisaoAcaoComercial inventada (NAO_AGIR → afirma AGIR_AGORA)', () => {
  const ctx = makeCtx({ tipoOportunidade: null, recorrenciaStatus: 'SEM_BASE', diasEntreComprasMediana: null });
  const decisao = calcularDecisaoAcaoComercial(ctx); // NAO_AGIR
  const facts = buildGroundingFactsV2(ctx, decisao);

  let err = null;
  try { validarClaimsV2([{ field: 'decisaoAcaoComercial', value: 'AGIR_AGORA' }], facts); }
  catch (e) { err = e; }
  expect(err).toBeInstanceOf(GroundingV2ViolationError);
  expect(err.expected).toBe('NAO_AGIR');
});

test('ACTION-19: grounding bloqueia diasAteProximoCiclo errado (real=16, afirma=99)', () => {
  const ctx = makeCtx({
    tipoOportunidade: null,
    recorrenciaStatus: 'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar: 6,
  });
  const decisao = calcularDecisaoAcaoComercial(ctx); // PROGRAMAR_CICLO, diasAteProximoCiclo=16
  const facts = buildGroundingFactsV2(ctx, decisao);

  expect(facts.diasAteProximoCiclo).toBe(16);
  let err = null;
  try { validarClaimsV2([{ field: 'diasAteProximoCiclo', value: 99 }], facts); }
  catch (e) { err = e; }
  expect(err).toBeInstanceOf(GroundingV2ViolationError);
  expect(err.expected).toBe(16);
  expect(err.received).toBe(99);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION-20: PROSPECT_VINCULADO — FILA_PROSPECCAO explícita
// ═══════════════════════════════════════════════════════════════════════════════

test('ACTION-20: PROSPECT_VINCULADO → AGIR_AGORA:FILA_PROSPECCAO (não FILA_RECOMPRA)', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        'PROSPECT_VINCULADO',
    recorrenciaStatus:       'SEM_BASE',
    diasEntreComprasMediana: null,
    diasSemComprar:          null,
  });
  expect(r.decisaoAcaoComercial).toBe('AGIR_AGORA');
  expect(r.motivoDeterministico).toContain('FILA_PROSPECCAO');
  expect(r.motivoDeterministico).not.toContain('FILA_RECOMPRA');
  expect(FILA_PROSPECCAO_TIPOS).toContain('PROSPECT_VINCULADO');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOUNDARY — Invariant de ciclo (N30.1)
// Provas que a função é FAIL CLOSED contra estados inconsistentes.
// O pipeline real nunca produz DENTRO_DO_PADRAO com dias >= mediana
// (recorrencia.js FATOR_ALERTA=0.85 → limiteAlerta ≤ mediana sempre).
// ═══════════════════════════════════════════════════════════════════════════════

test('BOUNDARY-01: DENTRO_DO_PADRAO + mediana=22 + dias=21 → PROGRAMAR_CICLO (diasAteCiclo=1)', () => {
  // Último estado válido antes da borda
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar:          21,
  });
  expect(r.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
  expect(r.diasAteProximoCiclo).toBe(1);
  expect(r.diasAteProximoCiclo).toBeGreaterThan(0);
});

test('BOUNDARY-02: DENTRO_DO_PADRAO + mediana=22 + dias=22 → NAO_AGIR (INCONSISTENTE)', () => {
  // dias == mediana: estado que o pipeline real nunca produz com DENTRO_DO_PADRAO
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar:          22,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('ESTADO_RECORRENCIA_INCONSISTENTE');
});

test('BOUNDARY-03: DENTRO_DO_PADRAO + mediana=22 + dias=23 → NAO_AGIR (INCONSISTENTE)', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar:          23,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('ESTADO_RECORRENCIA_INCONSISTENTE');
});

test('BOUNDARY-04: DENTRO_DO_PADRAO + mediana=22 + dias=30 → NAO_AGIR (INCONSISTENTE)', () => {
  const r = calcularDecisaoAcaoComercial({
    tipoOportunidade:        null,
    recorrenciaStatus:       'DENTRO_DO_PADRAO',
    diasEntreComprasMediana: 22,
    diasSemComprar:          30,
  });
  expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
  expect(r.diasAteProximoCiclo).toBeNull();
  expect(r.motivoDeterministico).toContain('ESTADO_RECORRENCIA_INCONSISTENTE');
});

test('BOUNDARY-05: estados inconsistentes nunca geram AGIR_AGORA', () => {
  // Cobre todos os casos de estado inconsistente
  const casosInconsistentes = [
    { mediana: 22, dias: 22 },
    { mediana: 22, dias: 23 },
    { mediana: 22, dias: 30 },
    { mediana: 14, dias: 14 },
    { mediana: 8,  dias: 9  },
    { mediana: 1,  dias: 1  },
  ];
  for (const c of casosInconsistentes) {
    const r = calcularDecisaoAcaoComercial({
      tipoOportunidade:        null,
      recorrenciaStatus:       'DENTRO_DO_PADRAO',
      diasEntreComprasMediana: c.mediana,
      diasSemComprar:          c.dias,
    });
    expect(r.decisaoAcaoComercial).not.toBe('AGIR_AGORA');
  }
});

test('BOUNDARY-06: diasAteProximoCiclo nunca negativo em estados válidos', () => {
  // Para todos os estados válidos (diasSemComprar < mediana), diasAteProximoCiclo >= 0
  const casosValidos = [
    { mediana: 22, dias: 0 },
    { mediana: 22, dias: 1 },
    { mediana: 22, dias: 21 },
    { mediana: 8,  dias: 6  },
    { mediana: 14, dias: 11 },
    { mediana: 29, dias: 24 },
  ];
  for (const c of casosValidos) {
    const r = calcularDecisaoAcaoComercial({
      tipoOportunidade:        null,
      recorrenciaStatus:       'DENTRO_DO_PADRAO',
      diasEntreComprasMediana: c.mediana,
      diasSemComprar:          c.dias,
    });
    expect(r.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
    expect(r.diasAteProximoCiclo).toBeGreaterThanOrEqual(0);
    expect(r.diasAteProximoCiclo).toBe(c.mediana - c.dias);
  }
});

test('BOUNDARY-07: pipeline real (recorrencia.js FATOR_ALERTA=0.85) nunca produz DENTRO_DO_PADRAO com dias >= mediana', () => {
  // Prova computacional via simulação dos limites do motor de recorrência
  const { FATOR_ALERTA } = require('../lib/recorrencia');
  const medianas = [1, 2, 3, 4, 7, 8, 14, 22, 29, 32, 100, 204.5];

  for (const mediana of medianas) {
    const limiteAlerta = Math.round(mediana * FATOR_ALERTA);
    // DENTRO_DO_PADRAO quando diasSemComprar < limiteAlerta
    const maxDiasValido = limiteAlerta - 1; // máximo inteiro aceito pelo pipeline
    // Invariant: maxDiasValido < mediana sempre
    expect(maxDiasValido).toBeLessThan(mediana);
  }
  // PIPELINE_VALID_STATE_POSSIBLE=NO confirmado
});

test('BOUNDARY-08: quatro null controls reais mantêm resultados corretos após invariant', () => {
  // Verifica que os 4 casos SHADOW com tipoOportunidade=null permanecem PROGRAMAR_CICLO
  // com os valores calculados durante o lote N29.3.
  const casos = [
    { id: 'SHADOW-001', mediana: 14,  dias: 2,  expectedAteCiclo: 12 },
    { id: 'SHADOW-005', mediana: 8,   dias: 0,  expectedAteCiclo: 8  },
    { id: 'SHADOW-011', mediana: 29,  dias: 20, expectedAteCiclo: 9  },
    { id: 'SHADOW-012', mediana: 22,  dias: 6,  expectedAteCiclo: 16 },
  ];
  for (const c of casos) {
    const r = calcularDecisaoAcaoComercial({
      tipoOportunidade:        null,
      recorrenciaStatus:       'DENTRO_DO_PADRAO',
      diasEntreComprasMediana: c.mediana,
      diasSemComprar:          c.dias,
    });
    expect(r.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
    expect(r.diasAteProximoCiclo).toBe(c.expectedAteCiclo);
  }
});
