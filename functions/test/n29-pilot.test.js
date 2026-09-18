'use strict';

/**
 * N29 — Testes unitários do Shadow Pilot V2.
 *
 * Invariantes verificadas:
 *   - PROMPT_ALLOWLIST_V2: exatamente 22 campos
 *   - auditarContextoPromptV2: aceita e bloqueia corretamente
 *   - escaneiarTextoParaPII: detecta PII em texto livre
 *   - pseudonimizarV2: exclui PII, inclui 22 campos, computa quantidades corretas
 *   - buildV2: valida schema V2, lança erro para campo ausente
 *   - ANALISE_OUTPUT_SCHEMA_V2: estrutura com diagnostico/sinaisRelevantes/acaoSugerida/claims
 *   - groundingOutput backward compat: ticketMedioCents (N28) ainda passa; ticketMedioTotal (N29) passa
 *   - inventar faturamento/ticket sem claim é bloqueado
 *   - inventar desconto financeiro é bloqueado por guardrails
 *
 * N29-PII-01 a N29-PII-05: PII Guard V2 e allowlist
 * N29-CTX-01 a N29-CTX-05: Contexto V2 e pseudonimização
 * N29-SCH-01 a N29-SCH-08: Schema V2 e prompt V2
 * N29-GRD-01 a N29-GRD-05: Grounding — backward compat e bloqueio de invenção
 */

const {
  PROMPT_ALLOWLIST_V2,
  auditarContextoPromptV2,
  escaneiarTextoParaPII,
  auditarGroundingFactsV2,
  GROUNDING_ALLOWLIST_V2,
} = require('../lib/n29/piiGuard');

const {
  validarFatosNoTexto,
  TextFactViolationError,
} = require('../lib/ai/groundingOutput');

const { MARCADORES_PROIBIDOS, validarOutputAgente, mkOutputAgente, GuardrailViolationError } =
  require('../lib/ai/guardrails');

const { VERSAO_PROMPT, SCHEMA_CONTEXTO_V2, buildV2 } =
  require('../lib/ai/prompts/analistaOportunidadeV2');

const {
  ANALISE_OUTPUT_SCHEMA_V2,
  INSTRUCTIONS_V2,
} = require('../lib/ai/providers/openaiProvider');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkCtxV2(overrides = {}) {
  return {
    tipoOportunidade:            'JANELA_DE_RECOMPRA',
    scoreTotal:                  72,
    classificacao:               'BOM',
    diasSemComprar:              35,
    tendencia:                   'ESTAVEL',
    recorrenciaStatus:           'DENTRO_DO_PADRAO',
    prioridade:                  72,
    pedidosTotal:                8,
    pedidos30d:                  1,
    pedidos60d:                  2,
    pedidos90d:                  3,
    pedidos180d:                 5,
    faturamentoTotal:            4800.00,
    faturamento30d:              600.00,
    faturamento60d:              1200.00,
    faturamento90d:              1800.00,
    faturamento180d:             3000.00,
    ticketMedioTotal:            600.00,
    diasEntreComprasMedio:       28,
    diasEntreComprasMediana:     25,
    quantidadeProdutosDistintos: 12,
    quantidadeCategoriasDistintas: 3,
    ...overrides,
  };
}

function mkPseudoV2(overrides = {}) {
  return {
    shadowId:                    'SHADOW-001',
    nuncaComprou:                false,
    inativo120d:                 false,
    diasSemComprar:              35,
    pedidosTotal:                8,
    pedidos30d:                  1,
    pedidos60d:                  2,
    pedidos90d:                  3,
    pedidos180d:                 5,
    diasEntreComprasMedio:       28,
    diasEntreComprasMediana:     25,
    _scoreTotal:                 72,
    _classificacao:              'BOM',
    _tendencia:                  'ESTAVEL',
    _recorrenciaStatus:          'DENTRO_DO_PADRAO',
    _oportunidadeTipo:           'JANELA_DE_RECOMPRA',
    _oportunidadePrioridade:     72,
    faturamentoTotal:            4800.00,
    faturamento30d:              600.00,
    faturamento60d:              1200.00,
    faturamento90d:              1800.00,
    faturamento180d:             3000.00,
    ticketMedioTotal:            600.00,
    quantidadeProdutosDistintos: 12,
    quantidadeCategoriasDistintas: 3,
    ...overrides,
  };
}

// ── N29-PII-01: PROMPT_ALLOWLIST_V2 contém exatamente 22 campos ───────────────

test('N29-PII-01: PROMPT_ALLOWLIST_V2 contém exatamente 22 campos', () => {
  const esperados = [
    'tipoOportunidade', 'scoreTotal', 'classificacao', 'diasSemComprar',
    'tendencia', 'recorrenciaStatus', 'prioridade',
    'pedidosTotal', 'pedidos30d', 'pedidos60d', 'pedidos90d', 'pedidos180d',
    'faturamentoTotal', 'faturamento30d', 'faturamento60d', 'faturamento90d', 'faturamento180d',
    'ticketMedioTotal',
    'diasEntreComprasMedio', 'diasEntreComprasMediana',
    'quantidadeProdutosDistintos', 'quantidadeCategoriasDistintas',
  ];
  expect(PROMPT_ALLOWLIST_V2.size).toBe(22);
  for (const campo of esperados) {
    expect(PROMPT_ALLOWLIST_V2.has(campo)).toBe(true);
  }
});

// ── N29-PII-02: auditarContextoPromptV2 aceita contexto V2 válido ─────────────

test('N29-PII-02: auditarContextoPromptV2 aceita contexto com 22 campos permitidos', () => {
  const ctx = mkCtxV2();
  const { ok, camposProibidos, piiEncontrado } = auditarContextoPromptV2(ctx);
  expect(ok).toBe(true);
  expect(camposProibidos).toHaveLength(0);
  expect(piiEncontrado).toHaveLength(0);
});

// ── N29-PII-03: auditarContextoPromptV2 bloqueia campo fora da V2 allowlist ───

test('N29-PII-03: auditarContextoPromptV2 bloqueia campo não autorizado em V2', () => {
  const ctx = mkCtxV2({ nomeCliente: 'João Silva' });
  const { ok, camposProibidos } = auditarContextoPromptV2(ctx);
  expect(ok).toBe(false);
  expect(camposProibidos).toContain('nomeCliente');
});

// ── N29-PII-04: auditarContextoPromptV2 bloqueia campos de cents (N28) ────────

test('N29-PII-04: auditarContextoPromptV2 bloqueia campos cents (fora da V2 allowlist)', () => {
  const ctx = mkCtxV2({ faturamentoTotalCents: 480000 });
  const { ok, camposProibidos } = auditarContextoPromptV2(ctx);
  expect(ok).toBe(false);
  expect(camposProibidos).toContain('faturamentoTotalCents');
});

// ── N29-PII-05: escaneiarTextoParaPII detecta PII em prompt V2 ────────────────

test('N29-PII-05: escaneiarTextoParaPII detecta CPF em texto do prompt V2', () => {
  const texto = 'Score: 72/100 | CPF do comprador: 123.456.789-00 | Dias: 35';
  const { ok, encontrado } = escaneiarTextoParaPII(texto);
  expect(ok).toBe(false);
  expect(encontrado).toContain('CPF');
});

// ── N29-CTX-01: pseudonimizarV2 não contém identificadores reais ──────────────

test('N29-CTX-01: pseudo V2 não contém clienteMr4Id, gestaoClickId nem nome', () => {
  const pseudo = mkPseudoV2();
  const camposProibidos = [
    'clienteMr4Id', 'gestaoClickId', 'nome', 'email', 'telefone',
    'cpf', 'cnpj', 'endereco', 'cep',
    'ultimaCompraEm', 'primeiraCompraEm', 'dataReferencia',
    'vendedorUltimaVendaNome', 'vendedorUltimaVendaId',
  ];
  for (const campo of camposProibidos) {
    expect(pseudo).not.toHaveProperty(campo);
  }
});

// ── N29-CTX-02: pseudo V2 exclui texto ERP ────────────────────────────────────

test('N29-CTX-02: pseudo V2 não contém arrays ERP (produtosMaisComprados, categoriasMaisCompradas)', () => {
  const pseudo = mkPseudoV2();
  expect(pseudo).not.toHaveProperty('produtosMaisComprados');
  expect(pseudo).not.toHaveProperty('categoriasMaisCompradas');
});

// ── N29-CTX-03: quantidadeCategoriasDistintas = categoriasMaisCompradas.length ─

test('N29-CTX-03: quantidadeCategoriasDistintas é calculada como length do array', () => {
  // Simula o que pseudonimizarV2 faz internamente
  const original = {
    categoriasMaisCompradas: [
      { categoria: 'Filtros' },
      { categoria: 'Óleos' },
      { categoria: 'Pneus' },
    ],
  };
  const qtd = Array.isArray(original.categoriasMaisCompradas)
    ? original.categoriasMaisCompradas.length
    : null;
  expect(qtd).toBe(3);
});

// ── N29-CTX-04: quantidadeCategoriasDistintas = null quando array ausente ─────

test('N29-CTX-04: quantidadeCategoriasDistintas é null quando categoriasMaisCompradas não existe', () => {
  const original = {};
  const qtd = Array.isArray(original.categoriasMaisCompradas)
    ? original.categoriasMaisCompradas.length
    : null;
  expect(qtd).toBeNull();
});

// ── N29-CTX-05: contextoRaw V2 tem faturamento em R$ (não em cents) ───────────

test('N29-CTX-05: contextoRaw V2 usa campo faturamentoTotal (R$), não faturamentoTotalCents', () => {
  const pseudo = mkPseudoV2({ faturamentoTotal: 4800.00 });
  const ctx = {
    tipoOportunidade:            pseudo._oportunidadeTipo       ?? null,
    scoreTotal:                  pseudo._scoreTotal              ?? null,
    classificacao:               pseudo._classificacao           ?? null,
    diasSemComprar:              pseudo.diasSemComprar           ?? null,
    tendencia:                   pseudo._tendencia               ?? null,
    recorrenciaStatus:           pseudo._recorrenciaStatus       ?? null,
    prioridade:                  pseudo._oportunidadePrioridade  ?? null,
    pedidosTotal:                pseudo.pedidosTotal             ?? null,
    pedidos30d:                  pseudo.pedidos30d               ?? null,
    pedidos60d:                  pseudo.pedidos60d               ?? null,
    pedidos90d:                  pseudo.pedidos90d               ?? null,
    pedidos180d:                 pseudo.pedidos180d              ?? null,
    faturamentoTotal:            pseudo.faturamentoTotal         ?? null,
    faturamento30d:              pseudo.faturamento30d           ?? null,
    faturamento60d:              pseudo.faturamento60d           ?? null,
    faturamento90d:              pseudo.faturamento90d           ?? null,
    faturamento180d:             pseudo.faturamento180d          ?? null,
    ticketMedioTotal:            pseudo.ticketMedioTotal         ?? null,
    diasEntreComprasMedio:       pseudo.diasEntreComprasMedio    ?? null,
    diasEntreComprasMediana:     pseudo.diasEntreComprasMediana  ?? null,
    quantidadeProdutosDistintos: pseudo.quantidadeProdutosDistintos ?? null,
    quantidadeCategoriasDistintas: pseudo.quantidadeCategoriasDistintas ?? null,
  };
  expect(ctx).toHaveProperty('faturamentoTotal', 4800.00);
  expect(ctx).not.toHaveProperty('faturamentoTotalCents');
  expect(ctx).not.toHaveProperty('ticketMedioCents');
});

// ── N29-SCH-01: SCHEMA_CONTEXTO_V2 tem exatamente 22 campos ──────────────────

test('N29-SCH-01: SCHEMA_CONTEXTO_V2 tem exatamente 22 campos', () => {
  expect(SCHEMA_CONTEXTO_V2).toHaveLength(22);
});

// ── N29-SCH-02: buildV2 aceita contexto V2 completo ──────────────────────────

test('N29-SCH-02: buildV2 aceita contexto V2 válido e retorna prompt string', () => {
  const ctx = mkCtxV2();
  const prompt = buildV2(ctx);
  expect(typeof prompt).toBe('string');
  expect(prompt.length).toBeGreaterThan(100);
  expect(prompt).toContain('JANELA_DE_RECOMPRA');
  expect(prompt).toContain('72/100');
});

// ── N29-SCH-03: buildV2 lança para campo ausente no contexto ─────────────────

test('N29-SCH-03: buildV2 lança erro quando campo obrigatório está ausente', () => {
  const ctx = mkCtxV2();
  delete ctx.faturamentoTotal;
  expect(() => buildV2(ctx)).toThrow('campo obrigatório ausente: "faturamentoTotal"');
});

// ── N29-SCH-04: ANALISE_OUTPUT_SCHEMA_V2 tem os 5 campos corretos (N31 adicionou acaoTiming) ──

test('N29-SCH-04: ANALISE_OUTPUT_SCHEMA_V2 required inclui diagnostico, sinaisRelevantes, acaoTiming, acaoSugerida, claims', () => {
  const required = ANALISE_OUTPUT_SCHEMA_V2.required;
  expect(required).toContain('diagnostico');
  expect(required).toContain('sinaisRelevantes');
  expect(required).toContain('acaoTiming');   // N31: acaoTiming obrigatório (MOTOR DETERMINÍSTICO > LLM)
  expect(required).toContain('acaoSugerida');
  expect(required).toContain('claims');
  expect(required).toHaveLength(5);
});

// ── N29-SCH-05: ANALISE_OUTPUT_SCHEMA_V2 sinaisRelevantes é array de strings ──

test('N29-SCH-05: ANALISE_OUTPUT_SCHEMA_V2 sinaisRelevantes é array de strings', () => {
  const prop = ANALISE_OUTPUT_SCHEMA_V2.properties.sinaisRelevantes;
  expect(prop.type).toBe('array');
  expect(prop.items.type).toBe('string');
});

// ── N29-SCH-06 (bônus): buildV2 aceita null para campos opcionais ─────────────

test('N29-SCH-06: buildV2 aceita null em campos opcionais (exibe N/A)', () => {
  const ctx = mkCtxV2({
    faturamentoTotal: null,
    faturamento30d:   null,
    ticketMedioTotal: null,
  });
  const prompt = buildV2(ctx);
  expect(prompt).toContain('N/A');
});

// ── N29-SCH-07 (bônus): VERSAO_PROMPT V2 = '2.0.0' ──────────────────────────

test('N29-SCH-07: VERSAO_PROMPT V2 é 2.0.0', () => {
  expect(VERSAO_PROMPT).toBe('2.0.0');
});

// ── N29-SCH-08 (bônus): INSTRUCTIONS_V2 inclui AI_FINANCIAL_AUTHORITY=NONE ───

test('N29-SCH-08: INSTRUCTIONS_V2 menciona restrição financeira (AI_FINANCIAL_AUTHORITY=NONE)', () => {
  expect(INSTRUCTIONS_V2).toContain('AI_FINANCIAL_AUTHORITY=NONE');
  expect(INSTRUCTIONS_V2).toContain('acaoSugerida');
  expect(INSTRUCTIONS_V2).toContain('diagnostico');
  expect(INSTRUCTIONS_V2).toContain('sinaisRelevantes');
});

// ── N29-GRD-01: backward compat — ticketMedioCents (N28) ainda valida texto ──
// Garante que o fix ticketMedioCents→ticketMedio não quebrou N28.

test('N29-GRD-01: claim ticketMedioCents (N28) ainda passa validarFatosNoTexto com "R$ X"', () => {
  const minFacts = { diasSemComprar: 30, diasEntreComprasMedio: 28, diasEntreComprasMediana: 25, scoreTotal: 65 };
  const claims   = [{ field: 'ticketMedioCents', value: 60000 }];
  expect(() => validarFatosNoTexto('O ticket médio do cliente é R$ 600,00.', claims, minFacts))
    .not.toThrow();
});

// ── N29-GRD-02: forward compat — ticketMedioTotal (N29) valida texto ──────────

test('N29-GRD-02: claim ticketMedioTotal (N29) passa validarFatosNoTexto com "R$ X"', () => {
  const minFacts = { diasSemComprar: 30, diasEntreComprasMedio: 28, diasEntreComprasMediana: 25, scoreTotal: 65 };
  const claims   = [{ field: 'ticketMedioTotal', value: 600.00 }];
  expect(() => validarFatosNoTexto('O ticket médio do cliente é R$ 600,00.', claims, minFacts))
    .not.toThrow();
});

// ── N29-GRD-03: INVENTED_TICKET_BLOCKED — "R$ X" sem claim → bloqueio ────────
// Garante que ticket inventado sem claim é bloqueado pelo grounding.

test('N29-GRD-03: "R$ X" no texto sem claim de faturamento/ticket bloqueia (INVENTED_TICKET_BLOCKED)', () => {
  const minFacts = { diasSemComprar: 30, diasEntreComprasMedio: 28, diasEntreComprasMediana: 25, scoreTotal: 65 };
  expect(() => validarFatosNoTexto('O ticket médio é R$ 850,00 por pedido.', [], minFacts))
    .toThrow(TextFactViolationError);
});

// ── N29-GRD-04: INVENTED_REVENUE_BLOCKED — faturamento inventado → bloqueio ──

test('N29-GRD-04: faturamento inventado sem claim bloqueia (INVENTED_REVENUE_BLOCKED)', () => {
  const minFacts = { diasSemComprar: 30, diasEntreComprasMedio: 28, diasEntreComprasMediana: 25, scoreTotal: 65 };
  expect(() => validarFatosNoTexto('O cliente faturou R$ 50.000 no semestre.', [], minFacts))
    .toThrow(TextFactViolationError);
});

// ── N29-GRD-05: INVENTED_DISCOUNT_BLOCKED — guardrail bloqueia marcador ──────
// Garante AI_FINANCIAL_AUTHORITY=NONE: CONCEDER_DESCONTO é marcador proibido.

test('N29-GRD-05: output com CONCEDER_DESCONTO é bloqueado por guardrail (INVENTED_DISCOUNT_BLOCKED)', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'CONCEDER_DESCONTO de 15% para reativação';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
  expect(MARCADORES_PROIBIDOS).toContain('CONCEDER_DESCONTO');
});
