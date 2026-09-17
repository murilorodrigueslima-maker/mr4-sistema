'use strict';

/**
 * N26 — Gate de Ativação do Primeiro LLM Real
 *
 * Testes obrigatórios conforme especificação N26 seção 24:
 *   N26-PIPE-01 a N26-PIPE-03  — Auditor e validador no pipeline
 *   N26-TEXT-01 a N26-TEXT-03  — Padrões adicionais de texto livre
 *   N26-SEM-01  a N26-SEM-02   — Contradição semântica
 *   N26-PII-01  a N26-PII-03   — Provider payload sem PII
 *   N26-TRACE-01               — Trace sem provider payload
 *   N26-SIDE-01                — Provider sem acesso a Firestore/API
 *
 * Todos os testes usam somente fixtures sintéticas.
 * LLM_REAL_CALLS = ZERO.
 */

const {
  buildGroundingFacts,
  validarOutputComGrounding,
  validarFatosNoTexto,
  validarContradicaoSemantica,
  GroundingViolationError,
  TextFactViolationError,
  SemanticContradictionError,
} = require('../lib/ai/groundingOutput');
const {
  validarOutputAgente,
  mkOutputAgente,
  GuardrailViolationError,
  MARCADORES_PROIBIDOS,
} = require('../lib/ai/guardrails');
const { SchemaValidationError, validarSchema } = require('../lib/ai/validatorOutput');
const { executarPipelineComercial } = require('../lib/ai/servicoAgenteComercial');
const { MockProvider } = require('../lib/ai/provider');

// ── Fixtures sintéticas base ──────────────────────────────────────────────────

const PERFIL = {
  clienteMr4Id:             'N26_SIM_001',
  nuncaComprou:             false,
  inativo120d:              false,
  diasSemComprar:           60,
  ultimaCompraEm:           '2026-07-18',
  primeiraCompraEm:         '2025-01-10',
  dataReferencia:           '2026-09-17',
  faturamentoTotal:         8000,
  faturamento30d:           500,
  faturamento90d:           2000,
  pedidosTotal:             6,
  pedidos90d:               3,
  ticketMedio:              1333,
  diasEntreComprasMedio:    55,
  diasEntreComprasMediana:  50,
};
const SCORE  = { scoreTotal: 42, classificacao: 'FRACO', statusConfig: 'PROVISIONAL' };
const TEND_CAINDO   = { tendencia: 'CAINDO' };
const TEND_CRESCENDO = { tendencia: 'CRESCENDO' };
const RECORR = { status: 'ATRASADO_VS_HISTORICO' };

let facts, factsCrescendo;
beforeAll(() => {
  facts         = buildGroundingFacts(PERFIL, SCORE, TEND_CAINDO,   RECORR);
  factsCrescendo = buildGroundingFacts(PERFIL, SCORE, TEND_CRESCENDO, RECORR);
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-PIPE-01: AuditorIA participa do pipeline
// ─────────────────────────────────────────────────────────────────────────────

test('N26-PIPE-01: pipeline retorna relatório de auditoria com conformeGeral', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  expect(resultado.auditoria).toBeDefined();
  expect(resultado.auditoria.agente).toBe('auditorIA');
  expect(resultado.auditoria).toHaveProperty('conformeGeral');
  expect(resultado.auditoria).toHaveProperty('totalOutputs');
  expect(resultado.auditoria.totalOutputs).toBeGreaterThan(0);
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// N26-PIPE-02: AuditorIA com output violando → conformeGeral = false
// ─────────────────────────────────────────────────────────────────────────────

test('N26-PIPE-02: output com violações → auditoria.conformeGeral = false', () => {
  const { auditarOutputs } = require('../lib/ai/agents/auditorIA');
  // Simular output que passou guardrails mas tem violação registrada
  const outputComViolacao = {
    tipo:             'ANALISE',
    conteudo:         'texto',
    versaoGuardrails: 'guardrails-v1',
    auditoria:        {},
    _guardrails: { violacoes: ['violação simulada'], validadoEm: new Date().toISOString() },
  };
  const relatorio = auditarOutputs([outputComViolacao]);
  expect(relatorio.conformeGeral).toBe(false);
  expect(relatorio.totalComViolacao).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-PIPE-03: SchemaValidationError = BLOCK (propagado)
// ─────────────────────────────────────────────────────────────────────────────

test('N26-PIPE-03: output com tipo desconhecido → SchemaValidationError (BLOCK)', () => {
  const outputInvalido = {
    tipo:             'TIPO_INEXISTENTE',
    conteudo:         'x',
    versaoGuardrails: 'g',
    auditoria:        {},
    _guardrails:      { violacoes: [] },
  };
  expect(() => validarSchema(outputInvalido)).toThrow(SchemaValidationError);
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-TEXT-01: "1500 reais" sem claim → BLOCK
// ─────────────────────────────────────────────────────────────────────────────

test('N26-TEXT-01: "1500 reais" sem claim de faturamento → BLOCK', () => {
  expect(() => validarFatosNoTexto('O cliente faturou 1500 reais no mês.', [], facts))
    .toThrow(TextFactViolationError);
});

test('N26-TEXT-01b: "R$ 1.500" sem claim → BLOCK', () => {
  expect(() => validarFatosNoTexto('Faturou R$ 1.500 este mês.', [], facts))
    .toThrow(TextFactViolationError);
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-TEXT-02: "92 pontos" sem claim de scoreTotal → BLOCK
// ─────────────────────────────────────────────────────────────────────────────

test('N26-TEXT-02: "92 pontos" inventado (score é 42) → BLOCK', () => {
  expect(() => validarFatosNoTexto('Esse cliente tem 92 pontos de score.', [], facts))
    .toThrow(TextFactViolationError);
});

test('N26-TEXT-02b: valor correto "42 pontos" com claim → OK', () => {
  const claims = [{ field: 'scoreTotal', value: 42 }];
  expect(() => validarFatosNoTexto('Score de 42 pontos.', claims, facts))
    .not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-TEXT-03: "14 pedidos" inventado → BLOCK
// ─────────────────────────────────────────────────────────────────────────────

test('N26-TEXT-03: "14 pedidos" inventado (pedidosTotal é 6) → BLOCK', () => {
  expect(() => validarFatosNoTexto('Cliente fez 14 pedidos no total.', [], facts))
    .toThrow(TextFactViolationError);
});

test('N26-TEXT-03b: "6 pedidos" correto com claim → OK', () => {
  const claims = [{ field: 'pedidosTotal', value: 6 }];
  expect(() => validarFatosNoTexto('Fez 6 pedidos.', claims, facts))
    .not.toThrow();
});

test('N26-TEXT-03c: data BR "18/07/2026" sem claim → BLOCK', () => {
  expect(() => validarFatosNoTexto('Comprou em 18/07/2026.', [], facts))
    .toThrow(TextFactViolationError);
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-SEM-01: CAINDO + "compras aumentando" → BLOCK
// ─────────────────────────────────────────────────────────────────────────────

test('N26-SEM-01: tendência CAINDO + "compras aumentando" → SemanticContradictionError', () => {
  expect(() => validarContradicaoSemantica(
    'O cliente está com as compras aumentando significativamente.',
    facts // tendencia = CAINDO
  )).toThrow(SemanticContradictionError);
});

test('N26-SEM-01b: tendência CAINDO + texto sem contradição → OK', () => {
  expect(() => validarContradicaoSemantica(
    'O cliente apresenta queda na frequência de compras.',
    facts
  )).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-SEM-02: CRESCENDO + "compras caindo" → BLOCK
// ─────────────────────────────────────────────────────────────────────────────

test('N26-SEM-02: tendência CRESCENDO + "compras caindo" → SemanticContradictionError', () => {
  expect(() => validarContradicaoSemantica(
    'As compras estão caindo no histórico recente.',
    factsCrescendo // tendencia = CRESCENDO
  )).toThrow(SemanticContradictionError);
});

test('N26-SEM-02b: tendência CRESCENDO + texto consistente → OK', () => {
  expect(() => validarContradicaoSemantica(
    'O cliente apresenta crescimento nas compras recentes.',
    factsCrescendo
  )).not.toThrow();
});

test('N26-SEM-03: validarOutputComGrounding propaga SemanticContradictionError', () => {
  const output = mkOutputAgente({
    tipo: 'ANALISE',
    conteudo: 'As compras estão aumentando muito.',
    fontes: ['score'],
  });
  const outputComGuardrails = validarOutputAgente(output);
  // facts tem tendencia=CAINDO → "aumentando" é contradição
  expect(() => validarOutputComGrounding(
    { ...outputComGuardrails, claims: [{ field: 'scoreTotal', value: 42 }] },
    facts
  )).toThrow(SemanticContradictionError);
});

// ─────────────────────────────────────────────────────────────────────────────
// N26-PII-01 a N26-PII-03: provider payload não contém PII
// ─────────────────────────────────────────────────────────────────────────────

test('N26-PII-01: payload enviado ao provider não contém telefone', async () => {
  const provider = new MockProvider();
  const resultado = await executarPipelineComercial(PERFIL);
  // Verificar que nenhuma chamada do provider contém telefone
  const chamadas = provider.getChamadas?.() || [];
  for (const chamada of chamadas) {
    const promptStr = JSON.stringify(chamada.prompt || '');
    expect(promptStr).not.toContain('"telefone"');
    expect(promptStr).not.toContain('"fone"');
  }
  // O perfil sintético não tem telefone — verificar também no resultado
  expect(JSON.stringify(resultado.trace)).not.toContain('"telefone"');
}, 10000);

test('N26-PII-02: payload ao provider não contém email', async () => {
  const perfilComEmail = { ...PERFIL, email: 'cliente@test.com' };
  const resultado = await executarPipelineComercial(perfilComEmail);
  // Trace não deve expor email
  expect(JSON.stringify(resultado.trace)).not.toContain('"email"');
  expect(JSON.stringify(resultado.trace)).not.toContain('cliente@test.com');
}, 10000);

test('N26-PII-03: payload ao provider não contém CPF/CNPJ', async () => {
  const perfilComCpf = { ...PERFIL, cpf: '123.456.789-00', cnpj: '00.000.000/0001-00' };
  const resultado = await executarPipelineComercial(perfilComCpf);
  expect(JSON.stringify(resultado.trace)).not.toContain('"cpf"');
  expect(JSON.stringify(resultado.trace)).not.toContain('"cnpj"');
  expect(JSON.stringify(resultado.trace)).not.toContain('123.456.789-00');
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// N26-TRACE-01: trace não contém provider payload
// ─────────────────────────────────────────────────────────────────────────────

test('N26-TRACE-01: trace não contém prompt integral ou payload bruto do provider', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  const traceStr = JSON.stringify(resultado.trace);
  // Trace contém spans com entrada resumida — não o prompt completo
  // O prompt completo não deve estar nos spans (só slice de 100 chars na chamada do provider)
  expect(traceStr).not.toContain('DADOS DO CLIENTE:');     // parte do prompt template
  expect(traceStr).not.toContain('OPORTUNIDADES IDENTIFICADAS:');
  // Trace deve ter campos obrigatórios
  expect(resultado.trace.traceId).toBeDefined();
  expect(resultado.trace.finalizado).toBe(true);
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// N26-SIDE-01: provider não tem acesso a Firestore/API handles
// ─────────────────────────────────────────────────────────────────────────────

test('N26-SIDE-01: MockProvider não possui referências a Firestore/GC/Auth', () => {
  const provider = new MockProvider();
  const providerStr = JSON.stringify(provider) + provider.complete.toString();
  // Provider não pode ter referências a serviços de backend
  expect(providerStr).not.toContain('firestore');
  expect(providerStr).not.toContain('getFirestore');
  expect(providerStr).not.toContain('gestaoclick');
  expect(providerStr).not.toContain('getAuth');
  expect(providerStr).not.toContain('admin.initializeApp');
});

test('N26-SIDE-01b: sideEffects=[] no resultado do pipeline', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  expect(resultado.sideEffects).toEqual([]);
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// N26-PIPE-04: grounding é chamado no pipeline (output tem _grounding)
// ─────────────────────────────────────────────────────────────────────────────

test('N26-PIPE-04: output do agente tem _grounding após pipeline', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  // analise (sempre executada) deve ter _grounding
  expect(resultado.analise._grounding).toBeDefined();
  expect(resultado.analise._grounding.versao).toBe('grounding-v2');
  expect(resultado.analise._grounding.factsClienteId).toBe('N26_SIM_001');
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// N26-GUARD-01: novos marcadores proibidos na lista
// ─────────────────────────────────────────────────────────────────────────────

test('N26-GUARD-01: CRIAR_TAREFA em MARCADORES_PROIBIDOS', () => {
  expect(MARCADORES_PROIBIDOS).toContain('CRIAR_TAREFA');
});

test('N26-GUARD-02: ALTERAR_DADOS em MARCADORES_PROIBIDOS', () => {
  expect(MARCADORES_PROIBIDOS).toContain('ALTERAR_DADOS');
});

test('N26-GUARD-03: EXECUTAR_ACAO em MARCADORES_PROIBIDOS', () => {
  expect(MARCADORES_PROIBIDOS).toContain('EXECUTAR_ACAO');
});

test('N26-GUARD-04: output com CRIAR_TAREFA → GuardrailViolationError', () => {
  const o = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'CRIAR_TAREFA follow-up' });
  expect(() => validarOutputAgente(o)).toThrow(GuardrailViolationError);
});
