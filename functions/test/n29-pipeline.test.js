'use strict';

/**
 * N29.1 — Pipeline V2 Mock Tests
 *
 * Valida o pipeline completo em modo mock (sem chamadas ao provider OpenAI).
 *
 * Pipeline V2:
 *   contextoRaw (22 campos)
 *   → buildGroundingFactsV2
 *   → buildV2 (prompt — não enviado ao provider)
 *   → [MOCK PROVIDER]
 *   → schema V2 {diagnostico, sinaisRelevantes, acaoSugerida, claims}
 *   → validarClaimsV2
 *   → validarFatosNoTextoV2
 *   → validarContradicaoSemanticaV2
 *   → validarMarcadoresProibidosV2 (AI_FINANCIAL_AUTHORITY = NONE)
 *
 * FAIL_CLOSED: sem bloco catch que converta falha em aprovação.
 * OPENAI_CALLS = 0.
 * PROD_WRITES = 0.
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

const { buildV2 } = require('../lib/ai/prompts/analistaOportunidadeV2');
const { GuardrailViolationError } = require('../lib/ai/guardrails');

// ── Fixture ───────────────────────────────────────────────────────────────────

const CTX_PIPELINE = Object.freeze({
  tipoOportunidade:              'QUEDA_DE_COMPRAS',
  scoreTotal:                    63,
  classificacao:                 'BOM',
  diasSemComprar:                31,
  tendencia:                     'CAINDO',
  recorrenciaStatus:             'ATRASADO',
  prioridade:                    70,
  pedidosTotal:                  15,
  pedidos30d:                    0,
  pedidos60d:                    1,
  pedidos90d:                    2,
  pedidos180d:                   5,
  faturamentoTotal:              1237.41,
  faturamento30d:                0,
  faturamento60d:                180.00,
  faturamento90d:                350.00,
  faturamento180d:               800.00,
  ticketMedioTotal:              82.49,
  diasEntreComprasMedio:         20.5,
  diasEntreComprasMediana:       18,
  quantidadeProdutosDistintos:   7,
  quantidadeCategoriasDistintas: 2,
});

// ── Helper: executa o pipeline V2 com output mock ─────────────────────────────

/**
 * Executa todas as camadas do pipeline V2 com um output mock pré-definido.
 * Lança o erro da primeira camada que detectar violação.
 *
 * @param {Object} ctx         — contextoRaw V2 (22 campos)
 * @param {Object} mockOutput  — saída simulada do provider (V2 schema)
 * @returns {{ ok, facts, output }}
 */
function runPipelineV2Mock(ctx, mockOutput) {
  // 1. buildGroundingFactsV2 — pode lançar Error se ctx inválido
  const facts = buildGroundingFactsV2(ctx);

  // 2. buildV2 — constrói prompt (não enviado ao provider em N29.1)
  const prompt = buildV2(ctx);
  expect(typeof prompt).toBe('string');
  expect(prompt.length).toBeGreaterThan(0);

  // 3. [MOCK PROVIDER] — mockOutput já é o JSON parseado

  // 4. Schema V2 — valida campos obrigatórios
  const camposSchema = ['diagnostico', 'sinaisRelevantes', 'acaoSugerida', 'claims'];
  for (const campo of camposSchema) {
    if (!(campo in mockOutput)) {
      throw new Error(`schema V2: campo obrigatório ausente: "${campo}"`);
    }
  }
  if (!Array.isArray(mockOutput.sinaisRelevantes)) {
    throw new Error('schema V2: sinaisRelevantes deve ser array');
  }
  if (!Array.isArray(mockOutput.claims)) {
    throw new Error('schema V2: claims deve ser array');
  }

  // 5. validarClaimsV2 — pode lançar GroundingV2ViolationError
  validarClaimsV2(mockOutput.claims, facts);

  // 6. validarFatosNoTextoV2 — texto = diagnostico + sinaisRelevantes + acaoSugerida
  const textoCompleto = [
    mockOutput.diagnostico,
    ...mockOutput.sinaisRelevantes,
    mockOutput.acaoSugerida,
  ].join(' ');
  validarFatosNoTextoV2(textoCompleto, mockOutput.claims, facts);

  // 7. validarContradicaoSemanticaV2
  validarContradicaoSemanticaV2(textoCompleto, facts);

  // 8. validarMarcadoresProibidosV2 — pode lançar GuardrailViolationError
  validarMarcadoresProibidosV2(mockOutput);

  return { ok: true, facts, output: mockOutput };
}

// ── Pipeline Tests ─────────────────────────────────────────────────────────────

describe('N29.1 — Pipeline V2 Mock', () => {

  test('PIPE-V2-01: happy path — output válido passa todas as camadas', () => {
    const mockOutput = {
      diagnostico: 'Cliente com queda de compras nos últimos 31 dias. Histórico de 15 pedidos no total.',
      sinaisRelevantes: [
        'Score 63/100, tendência de queda.',
        'Zero pedidos nos últimos 30 dias.',
        'Última compra há 31 dias, acima do intervalo médio de 20 dias.',
      ],
      acaoSugerida: 'Entrar em contato para verificar necessidade de reposição de estoque nesta semana.',
      claims: [
        { field: 'scoreTotal',          value: 63 },
        { field: 'diasSemComprar',      value: 31 },
        { field: 'pedidosTotal',        value: 15 },
        { field: 'pedidos30d',          value: 0 },
        { field: 'oportunidadeTipo',    value: 'QUEDA_DE_COMPRAS' },
        { field: 'oportunidadePrioridade', value: 70 },
      ],
    };

    const result = runPipelineV2Mock(CTX_PIPELINE, mockOutput);
    expect(result.ok).toBe(true);
  });

  test('PIPE-V2-02: claim com valor errado → GroundingV2ViolationError (FAIL_CLOSED)', () => {
    const mockOutput = {
      diagnostico: 'Cliente com score alto.',
      sinaisRelevantes: [],
      acaoSugerida: 'Entrar em contato.',
      claims: [
        { field: 'scoreTotal', value: 99 }, // errado: correto é 63
      ],
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutput))
      .toThrow(GroundingV2ViolationError);
  });

  test('PIPE-V2-03: campo inventado (não está nos facts V2) → GroundingV2ViolationError', () => {
    const mockOutput = {
      diagnostico: 'Análise completa.',
      sinaisRelevantes: [],
      acaoSugerida: 'Agir.',
      claims: [
        { field: 'nomeCliente', value: 'João' }, // campo PII — não existe nos facts V2
      ],
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutput))
      .toThrow(GroundingV2ViolationError);
  });

  test('PIPE-V2-04: R$ no texto sem claim de faturamento → TextFactV2ViolationError', () => {
    const mockOutput = {
      diagnostico: 'O faturamento total foi R$ 5000,00 este ano.',
      sinaisRelevantes: [],
      acaoSugerida: 'Contato imediato.',
      claims: [
        { field: 'scoreTotal', value: 63 },
        // sem claim de faturamento → texto com R$ é inventado
      ],
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutput))
      .toThrow(TextFactV2ViolationError);
  });

  test('PIPE-V2-05: texto afirma crescimento com tendência CAINDO → SemanticV2ContradictionError', () => {
    const mockOutput = {
      diagnostico: 'As compras estão aumentando. Cliente em fase de crescimento.',
      sinaisRelevantes: [],
      acaoSugerida: 'Manter contato regular.',
      claims: [
        { field: 'scoreTotal', value: 63 },
      ],
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutput))
      .toThrow(SemanticV2ContradictionError);
  });

  test('PIPE-V2-06: CONCEDER_DESCONTO em acaoSugerida → GuardrailViolationError', () => {
    const mockOutput = {
      diagnostico: 'Cliente inativo.',
      sinaisRelevantes: [],
      acaoSugerida: 'CONCEDER_DESCONTO de 15% para reativar pedidos.',
      claims: [
        { field: 'scoreTotal', value: 63 },
      ],
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutput))
      .toThrow(GuardrailViolationError);
  });

  test('PIPE-V2-07: ALTERAR_LIMITE em sinaisRelevantes → GuardrailViolationError', () => {
    const mockOutput = {
      diagnostico: 'Cliente bom.',
      sinaisRelevantes: ['Necessário ALTERAR_LIMITE de crédito para aumentar vendas.'],
      acaoSugerida: 'Propor ampliação.',
      claims: [{ field: 'scoreTotal', value: 63 }],
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutput))
      .toThrow(GuardrailViolationError);
  });

  test('PIPE-V2-08: campo de schema obrigatório ausente (diagnostico) → Error antes de grounding', () => {
    const mockOutputIncompleto = {
      sinaisRelevantes: [],
      acaoSugerida: 'Agir.',
      claims: [],
      // diagnostico ausente
    };

    expect(() => runPipelineV2Mock(CTX_PIPELINE, mockOutputIncompleto))
      .toThrow(/schema V2: campo obrigatório ausente/);
  });

  test('PIPE-V2-09: oportunidadeTipo afirmado corretamente passa o pipeline', () => {
    const mockOutput = {
      diagnostico: 'Cliente com queda detectada pelo sistema.',
      sinaisRelevantes: ['Tendência negativa nos últimos 30 dias.'],
      acaoSugerida: 'Verificar razão da redução de compras.',
      claims: [
        { field: 'oportunidadeTipo',       value: 'QUEDA_DE_COMPRAS' },
        { field: 'oportunidadePrioridade', value: 70 },
        { field: 'diasSemComprar',         value: 31 },
      ],
    };

    const result = runPipelineV2Mock(CTX_PIPELINE, mockOutput);
    expect(result.ok).toBe(true);
  });

  test('PIPE-V2-10: null oportunidade — modelo não reclama tipoOportunidade e pipeline passa', () => {
    const ctxNullOpp = {
      tipoOportunidade:              null,
      scoreTotal:                    88,
      classificacao:                 'MUITO_BOM',
      diasSemComprar:                6,
      tendencia:                     'ESTAVEL',
      recorrenciaStatus:             'DENTRO_DO_PADRAO',
      prioridade:                    null,
      pedidosTotal:                  22,
      pedidos30d:                    3,
      pedidos60d:                    5,
      pedidos90d:                    8,
      pedidos180d:                   14,
      faturamentoTotal:              5008.49,
      faturamento30d:                800.00,
      faturamento60d:                1500.00,
      faturamento90d:                2800.00,
      faturamento180d:               4200.00,
      ticketMedioTotal:              227.66,
      diasEntreComprasMedio:         8.2,
      diasEntreComprasMediana:       7,
      quantidadeProdutosDistintos:   9,
      quantidadeCategoriasDistintas: 4,
    };

    const mockOutput = {
      diagnostico: 'Cliente ativo com score 88. Sem oportunidade comercial identificada pelo sistema no momento.',
      sinaisRelevantes: [
        'Comprou há 6 dias, dentro do padrão.',
        'Score 88/100, classificação muito boa.',
      ],
      acaoSugerida: 'Manter relacionamento regular. Verificar novidades de catálogo na próxima semana.',
      claims: [
        { field: 'scoreTotal',     value: 88 },
        { field: 'diasSemComprar', value: 6 },
        // oportunidadeTipo não afirmado (null → correto)
      ],
    };

    const result = runPipelineV2Mock(ctxNullOpp, mockOutput);
    expect(result.ok).toBe(true);
    expect(result.facts.oportunidadeTipo).toBeNull();
    expect(result.facts.oportunidadePrioridade).toBeNull();
  });

});
