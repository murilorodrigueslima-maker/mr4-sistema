'use strict';

/**
 * N29.1 — Grounding V2 Tests
 *
 * GROUND-V2-01..20  : buildGroundingFactsV2 + validarClaimsV2 + validarFatosNoTextoV2
 * NULL-CTRL-A..E    : grupo de controle tipoOportunidade=null, prioridade=null
 *
 * OPENAI_CALLS = 0. Nenhuma chamada ao provider. Validação local apenas.
 */

const {
  buildGroundingFactsV2,
  validarClaimsV2,
  validarFatosNoTextoV2,
  validarContradicaoSemanticaV2,
  validarMarcadoresProibidosV2,
  GroundingV2ViolationError,
  TextFactV2ViolationError,
  SemanticV2ContradictionError,
} = require('../lib/n29/groundingOutput');

const {
  GuardrailViolationError,
} = require('../lib/ai/guardrails');

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Cliente com oportunidade REATIVACAO_120D (caso típico)
const CTX_SAMPLE = Object.freeze({
  tipoOportunidade:              'REATIVACAO_120D',
  scoreTotal:                    45,
  classificacao:                 'REGULAR',
  diasSemComprar:                150,
  tendencia:                     'CAINDO',
  recorrenciaStatus:             'ATRASADO',
  prioridade:                    75,
  pedidosTotal:                  8,
  pedidos30d:                    0,
  pedidos60d:                    0,
  pedidos90d:                    0,
  pedidos180d:                   2,
  faturamentoTotal:              4800.00,
  faturamento30d:                0,
  faturamento60d:                0,
  faturamento90d:                0,
  faturamento180d:               1200.00,
  ticketMedioTotal:              600.00,
  diasEntreComprasMedio:         45.5,
  diasEntreComprasMediana:       40,
  quantidadeProdutosDistintos:   12,
  quantidadeCategoriasDistintas: 3,
});

// Cliente ativo sem oportunidade classificada (controle — 4 casos reais no lote)
const CTX_NULL_OPP = Object.freeze({
  tipoOportunidade:              null,
  scoreTotal:                    100,
  classificacao:                 'EXCELENTE',
  diasSemComprar:                2,
  tendencia:                     'CRESCENDO',
  recorrenciaStatus:             'DENTRO_DO_PADRAO',
  prioridade:                    null,
  pedidosTotal:                  40,
  pedidos30d:                    5,
  pedidos60d:                    8,
  pedidos90d:                    12,
  pedidos180d:                   20,
  faturamentoTotal:              25000.00,
  faturamento30d:                3000.00,
  faturamento60d:                6000.00,
  faturamento90d:                9000.00,
  faturamento180d:               15000.00,
  ticketMedioTotal:              625.00,
  diasEntreComprasMedio:         12.5,
  diasEntreComprasMediana:       11,
  quantidadeProdutosDistintos:   25,
  quantidadeCategoriasDistintas: 6,
});

// ── GROUND-V2 Tests ───────────────────────────────────────────────────────────

describe('N29.1 — Grounding V2', () => {

  // ── buildGroundingFactsV2 ──────────────────────────────────────────────────

  test('GROUND-V2-01: 22 claims válidos passam validarClaimsV2', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    const claims = [
      { field: 'scoreTotal',                    value: 45 },
      { field: 'classificacao',                  value: 'REGULAR' },
      { field: 'diasSemComprar',                 value: 150 },
      { field: 'tendencia',                      value: 'CAINDO' },
      { field: 'recorrenciaStatus',              value: 'ATRASADO' },
      { field: 'pedidosTotal',                   value: 8 },
      { field: 'pedidos30d',                     value: 0 },
      { field: 'pedidos60d',                     value: 0 },
      { field: 'pedidos90d',                     value: 0 },
      { field: 'pedidos180d',                    value: 2 },
      { field: 'faturamentoTotal',               value: 4800.00 },
      { field: 'faturamento30d',                 value: 0 },
      { field: 'faturamento60d',                 value: 0 },
      { field: 'faturamento90d',                 value: 0 },
      { field: 'faturamento180d',                value: 1200.00 },
      { field: 'ticketMedioTotal',               value: 600.00 },
      { field: 'diasEntreComprasMedio',          value: 45.5 },
      { field: 'diasEntreComprasMediana',        value: 40 },
      { field: 'quantidadeProdutosDistintos',    value: 12 },
      { field: 'quantidadeCategoriasDistintas',  value: 3 },
      { field: 'oportunidadeTipo',               value: 'REATIVACAO_120D' },
      { field: 'oportunidadePrioridade',         value: 75 },
    ];
    expect(() => validarClaimsV2(claims, facts)).not.toThrow();
  });

  test('GROUND-V2-02: faturamentoTotal correto (R$) passa', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() => validarClaimsV2([{ field: 'faturamentoTotal', value: 4800.00 }], facts)).not.toThrow();
  });

  test('GROUND-V2-03: faturamentoTotal inventado (valor diferente) → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'faturamentoTotal', value: 5000 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-04: faturamento30d inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'faturamento30d', value: 999 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-05: ticketMedioTotal correto (R$) passa', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() => validarClaimsV2([{ field: 'ticketMedioTotal', value: 600.00 }], facts)).not.toThrow();
  });

  test('GROUND-V2-06: ticketMedioTotal inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'ticketMedioTotal', value: 650 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-07: pedidosTotal inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'pedidosTotal', value: 99 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-08: pedidos180d inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'pedidos180d', value: 5 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-09: diasEntreComprasMediana inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'diasEntreComprasMediana', value: 99 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-10: quantidadeProdutosDistintos inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'quantidadeProdutosDistintos', value: 1 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-11: quantidadeCategoriasDistintas inventado → GroundingV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarClaimsV2([{ field: 'quantidadeCategoriasDistintas', value: 10 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-12: campo null nos facts → claim null passa', () => {
    const ctx = { ...CTX_SAMPLE, diasEntreComprasMedio: null };
    const facts = buildGroundingFactsV2(ctx);
    expect(facts.diasEntreComprasMedio).toBeNull();
    expect(() =>
      validarClaimsV2([{ field: 'diasEntreComprasMedio', value: null }], facts)
    ).not.toThrow();
  });

  test('GROUND-V2-13: campo null nos facts → claim 0 (interpretação numérica) → GroundingV2ViolationError', () => {
    const ctx = { ...CTX_SAMPLE, diasEntreComprasMedio: null };
    const facts = buildGroundingFactsV2(ctx);
    expect(() =>
      validarClaimsV2([{ field: 'diasEntreComprasMedio', value: 0 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-14: SEM_BASE string preservado → claim SEM_BASE passa', () => {
    const ctx = { ...CTX_SAMPLE, tendencia: 'SEM_BASE', recorrenciaStatus: 'SEM_BASE' };
    const facts = buildGroundingFactsV2(ctx);
    expect(facts.tendencia).toBe('SEM_BASE');
    expect(() =>
      validarClaimsV2([{ field: 'tendencia', value: 'SEM_BASE' }], facts)
    ).not.toThrow();
  });

  test('GROUND-V2-15: SEM_BASE convertido a número pelo modelo → GroundingV2ViolationError', () => {
    const ctx = { ...CTX_SAMPLE, tendencia: 'SEM_BASE' };
    const facts = buildGroundingFactsV2(ctx);
    expect(() =>
      validarClaimsV2([{ field: 'tendencia', value: 0 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-16: tipoOportunidade=null → oportunidadeTipo=null → claim não-nulo → GroundingV2ViolationError', () => {
    const ctx = { ...CTX_SAMPLE, tipoOportunidade: null, prioridade: null };
    const facts = buildGroundingFactsV2(ctx);
    expect(facts.oportunidadeTipo).toBeNull();
    expect(() =>
      validarClaimsV2([{ field: 'oportunidadeTipo', value: 'REATIVACAO_120D' }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-17: prioridade=null → oportunidadePrioridade=null → claim 80 → GroundingV2ViolationError', () => {
    const ctx = { ...CTX_SAMPLE, tipoOportunidade: null, prioridade: null };
    const facts = buildGroundingFactsV2(ctx);
    expect(facts.oportunidadePrioridade).toBeNull();
    expect(() =>
      validarClaimsV2([{ field: 'oportunidadePrioridade', value: 80 }], facts)
    ).toThrow(GroundingV2ViolationError);
  });

  test('GROUND-V2-18: CONCEDER_DESCONTO em acaoSugerida → GuardrailViolationError', () => {
    const output = {
      diagnostico:       'Cliente inativo há 150 dias.',
      sinaisRelevantes:  ['Queda nas compras nos últimos meses'],
      acaoSugerida:      'CONCEDER_DESCONTO de 10% para reativar.',
      claims:            [],
    };
    expect(() => validarMarcadoresProibidosV2(output)).toThrow(GuardrailViolationError);
  });

  test('GROUND-V2-19: APROVAR_CREDITO em diagnostico → GuardrailViolationError', () => {
    const output = {
      diagnostico:       'APROVAR_CREDITO automático para este cliente fiel.',
      sinaisRelevantes:  [],
      acaoSugerida:      'Entrar em contato.',
      claims:            [],
    };
    expect(() => validarMarcadoresProibidosV2(output)).toThrow(GuardrailViolationError);
  });

  test('GROUND-V2-20: "R$ X" no texto sem claim de faturamento/ticketMedio → TextFactV2ViolationError', () => {
    const facts = buildGroundingFactsV2(CTX_SAMPLE);
    expect(() =>
      validarFatosNoTextoV2('O faturamento foi de R$ 9999,99.', [], facts)
    ).toThrow(TextFactV2ViolationError);
  });

  // ── NULL OPPORTUNITY CONTROL GROUP ────────────────────────────────────────

  describe('Grupo de controle — tipoOportunidade=null, prioridade=null', () => {

    test('NULL-CTRL-A: modelo não afirma oportunidade → validarClaimsV2 passa (oportunidadeTipo omitido)', () => {
      const facts = buildGroundingFactsV2(CTX_NULL_OPP);
      expect(facts.oportunidadeTipo).toBeNull();
      expect(facts.oportunidadePrioridade).toBeNull();
      // Modelo afirma apenas dados objetivos, sem oportunidade
      const claims = [
        { field: 'scoreTotal',     value: 100 },
        { field: 'diasSemComprar', value: 2 },
        { field: 'pedidosTotal',   value: 40 },
      ];
      expect(() => validarClaimsV2(claims, facts)).not.toThrow();
    });

    test('NULL-CTRL-B: modelo inventa REATIVACAO_120D → GroundingV2ViolationError (null→não-nulo bloqueado)', () => {
      const facts = buildGroundingFactsV2(CTX_NULL_OPP);
      expect(() =>
        validarClaimsV2([{ field: 'oportunidadeTipo', value: 'REATIVACAO_120D' }], facts)
      ).toThrow(GroundingV2ViolationError);
    });

    test('NULL-CTRL-C: modelo inventa prioridade 80 → GroundingV2ViolationError (null→não-nulo bloqueado)', () => {
      const facts = buildGroundingFactsV2(CTX_NULL_OPP);
      expect(() =>
        validarClaimsV2([{ field: 'oportunidadePrioridade', value: 80 }], facts)
      ).toThrow(GroundingV2ViolationError);
    });

    test('NULL-CTRL-D: modelo recomenda CONCEDER_DESCONTO → GuardrailViolationError', () => {
      const output = {
        diagnostico:      'Cliente ativo, score máximo.',
        sinaisRelevantes: ['Comprou há 2 dias', 'Alta frequência de compras'],
        acaoSugerida:     'CONCEDER_DESCONTO para manter fidelidade.',
        claims:           [{ field: 'scoreTotal', value: 100 }],
      };
      expect(() => validarMarcadoresProibidosV2(output)).toThrow(GuardrailViolationError);
    });

    test('NULL-CTRL-E: modelo recomenda contato urgente sem sinal → TextFactV2ViolationError(URGENCIA_SEM_SINAL)', () => {
      // REGRA DETERMINÍSTICA: oportunidadeTipo=null E oportunidadePrioridade=null
      // → qualquer afirmação de urgência no texto é infundada → BLOCK.
      // Texto puro de urgência (sem MARCADOR proibido de sistema) não é bloqueável
      // pelos guardrails standard. Esta regra fecha o gap para o null control group.
      const facts = buildGroundingFactsV2(CTX_NULL_OPP);
      const texto = 'Este cliente precisa de contato urgente hoje mesmo.';
      expect(() =>
        validarFatosNoTextoV2(texto, [], facts)
      ).toThrow(TextFactV2ViolationError);

      // Verifica o tipo específico do erro
      try {
        validarFatosNoTextoV2(texto, [], facts);
      } catch (e) {
        expect(e.tipo).toBe('URGENCIA_SEM_SINAL');
      }
    });

  });

  // ── buildGroundingFactsV2 — validações estruturais ────────────────────────

  describe('buildGroundingFactsV2 — estrutura', () => {

    test('facts é imutável (Object.freeze)', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE);
      expect(Object.isFrozen(facts)).toBe(true);
    });

    test('tipoOportunidade é mapeado para oportunidadeTipo nos facts', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE);
      expect(facts.oportunidadeTipo).toBe('REATIVACAO_120D');
      expect('tipoOportunidade' in facts).toBe(false);
    });

    test('prioridade é mapeado para oportunidadePrioridade nos facts', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE);
      expect(facts.oportunidadePrioridade).toBe(75);
      expect('prioridade' in facts).toBe(false);
    });

    test('faturamentoTotal permanece em R$ (não convertido para centavos)', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE);
      expect(facts.faturamentoTotal).toBe(4800.00);
    });

    test('ticketMedioTotal permanece em R$', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE);
      expect(facts.ticketMedioTotal).toBe(600.00);
    });

    test('campo obrigatório ausente → Error', () => {
      const incompleto = { ...CTX_SAMPLE };
      delete incompleto.ticketMedioTotal;
      expect(() => buildGroundingFactsV2(incompleto)).toThrow(/campo obrigatório ausente/);
    });

    test('statusConfig e _versaoGrounding são metadados internos não afirmáveis', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE);
      expect(() =>
        validarClaimsV2([{ field: 'statusConfig', value: 'SHADOW' }], facts)
      ).toThrow(GroundingV2ViolationError);
      expect(() =>
        validarClaimsV2([{ field: '_versaoGrounding', value: 'grounding-v2-n29' }], facts)
      ).toThrow(GroundingV2ViolationError);
    });

  });

  // ── validarContradicaoSemanticaV2 ─────────────────────────────────────────

  describe('validarContradicaoSemanticaV2', () => {

    test('tendencia CAINDO + texto "compras estão aumentando" → SemanticV2ContradictionError', () => {
      const facts = buildGroundingFactsV2(CTX_SAMPLE); // tendencia: 'CAINDO'
      expect(() =>
        validarContradicaoSemanticaV2('As compras estão aumentando significativamente.', facts)
      ).toThrow(SemanticV2ContradictionError);
    });

    test('tendencia CRESCENDO + texto "queda de compras" → SemanticV2ContradictionError', () => {
      const facts = buildGroundingFactsV2(CTX_NULL_OPP); // tendencia: 'CRESCENDO'
      expect(() =>
        validarContradicaoSemanticaV2('Há queda de compras recentemente.', facts)
      ).toThrow(SemanticV2ContradictionError);
    });

    test('tendencia SEM_BASE → sem contradição possível (passes)', () => {
      const ctx = { ...CTX_SAMPLE, tendencia: 'SEM_BASE' };
      const facts = buildGroundingFactsV2(ctx);
      expect(() =>
        validarContradicaoSemanticaV2('As compras estão aumentando.', facts)
      ).not.toThrow();
    });

  });

});
