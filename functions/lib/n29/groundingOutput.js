'use strict';

/**
 * Grounding V2 — N29.1
 *
 * buildGroundingFactsV2: facts em R$ (sem conversão para centavos).
 * Mapeamento de nomes: tipoOportunidade → oportunidadeTipo,
 *                      prioridade → oportunidadePrioridade.
 *
 * REGRA URGÊNCIA (determinística):
 *   Se texto contém marcador de urgência E oportunidadeTipo=null E
 *   oportunidadePrioridade=null → TextFactV2ViolationError('URGENCIA_SEM_SINAL').
 *   Não há sinal determinístico que sustente urgência: nenhuma oportunidade
 *   classificada pelo motor, nenhuma prioridade atribuída.
 *
 * OPENAI_CALLS = 0 neste módulo. Apenas validação local.
 */

const {
  MARCADORES_PROIBIDOS,
  GuardrailViolationError,
} = require('../ai/guardrails');

const {
  PADROES_CONTRADICAO_TENDENCIA,
} = require('../ai/groundingOutput');

const VERSAO_GROUNDING_V2 = 'grounding-v2-n29';

// 22 campos obrigatórios no contextoRaw V2 (espelha SCHEMA_CONTEXTO_V2)
const SCHEMA_CONTEXTO_V2 = [
  'tipoOportunidade',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'prioridade',
  'pedidosTotal',
  'pedidos30d',
  'pedidos60d',
  'pedidos90d',
  'pedidos180d',
  'faturamentoTotal',
  'faturamento30d',
  'faturamento60d',
  'faturamento90d',
  'faturamento180d',
  'ticketMedioTotal',
  'diasEntreComprasMedio',
  'diasEntreComprasMediana',
  'quantidadeProdutosDistintos',
  'quantidadeCategoriasDistintas',
];

// ── Erros ─────────────────────────────────────────────────────────────────────

class GroundingV2ViolationError extends Error {
  constructor(field, expected, received) {
    super(
      `[GROUNDING-V2] claim inválido: campo "${field}" — ` +
      `esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(received)}`
    );
    this.name     = 'GroundingV2ViolationError';
    this.field    = field;
    this.expected = expected;
    this.received = received;
  }
}

class TextFactV2ViolationError extends Error {
  constructor(tipo, encontrado) {
    super(`[TEXT-FACT-V2] afirmação factual sem claim correspondente: ${tipo} "${encontrado}"`);
    this.name         = 'TextFactV2ViolationError';
    this.tipo         = tipo;
    this.encontrado   = encontrado;
  }
}

class SemanticV2ContradictionError extends Error {
  constructor(campo, valorFact, padrao) {
    super(`[SEMANTIC-V2] contradição factual: ${campo}="${valorFact}" mas texto afirma o oposto ("${padrao}")`);
    this.name       = 'SemanticV2ContradictionError';
    this.campo      = campo;
    this.valorFact  = valorFact;
    this.padrao     = padrao;
  }
}

class AcaoCoerenciaViolationError extends Error {
  constructor(decisao, acaoTimingRecebido, acaoTimingEsperado) {
    super(
      `[ACAO-COERENCIA] acaoTiming incoerente com decisão determinística: ` +
      `decisao=${decisao}, acaoTiming=${acaoTimingRecebido}, esperado=${acaoTimingEsperado}`
    );
    this.name               = 'AcaoCoerenciaViolationError';
    this.decisao            = decisao;
    this.acaoTimingRecebido = acaoTimingRecebido;
    this.acaoTimingEsperado = acaoTimingEsperado;
  }
}

// ── Mapeamento acaoTiming ─────────────────────────────────────────────────────
// Contrato estruturado: decisao determinística → acaoTiming esperado no output V2.
// AGIR_AGORA→AGORA, PROGRAMAR_CICLO→NO_CICLO, NAO_AGIR→NENHUMA.
const ACAO_TIMING_MAP = Object.freeze({
  AGIR_AGORA:      'AGORA',
  PROGRAMAR_CICLO: 'NO_CICLO',
  NAO_AGIR:        'NENHUMA',
});

// ── Padrões numéricos no texto ────────────────────────────────────────────────

const REGEX_MONETARIO     = /R\$\s*[\d.,]+/gi;
const REGEX_REAIS         = /\b\d[\d.,]*\s*reais?\b/gi;
const REGEX_DATA_ISO      = /\d{4}-\d{2}-\d{2}/g;
const REGEX_DATA_BR       = /\b\d{2}\/\d{2}\/\d{4}\b/g;
const REGEX_DIAS          = /\b(\d+)\s+dias?\b/gi;
const REGEX_PONTOS        = /\b(\d+)\s+pontos?\b/gi;
const REGEX_PEDIDOS_TEXTO = /\b(\d+)\s+pedidos?\b/gi;

// Urgência sem sinal determinístico
const REGEX_URGENCIA = /\b(urgente|urgência|urgencia|imediato|imediata|agora\s+mesmo|hoje\s+mesmo|sem\s+demora|imediatamente)\b/i;

// ── buildGroundingFactsV2 ─────────────────────────────────────────────────────

/**
 * Constrói facts V2 a partir do contextoRaw (22 campos) + decisão N30 (opcional).
 *
 * Valores financeiros em R$ (não centavos). null permanece null.
 * SEM_BASE permanece string. Sem nenhuma coerção.
 *
 * Mapeamento de nomes para os claim names canônicos de INSTRUCTIONS_V2:
 *   ctx.tipoOportunidade → facts.oportunidadeTipo
 *   ctx.prioridade       → facts.oportunidadePrioridade
 *
 * N30: segundo parâmetro opcional { decisaoAcaoComercial, diasAteProximoCiclo }.
 *   Quando ausente, ambos os campos ficam null (claimáveis mas não afirmáveis).
 *
 * @param {Object} ctx     — contextoRaw V2 com os 22 campos
 * @param {Object|null} decisao — resultado de calcularDecisaoAcaoComercial (N30)
 * @returns {Object}       — facts imutáveis (Object.freeze)
 */
function buildGroundingFactsV2(ctx, decisao = null) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('buildGroundingFactsV2: ctx inválido');
  }
  for (const campo of SCHEMA_CONTEXTO_V2) {
    if (!(campo in ctx)) {
      throw new Error(`buildGroundingFactsV2: campo obrigatório ausente: "${campo}"`);
    }
  }

  return Object.freeze({
    // 20 campos diretos (mesmo nome em contextoRaw e nos facts/claims)
    scoreTotal:                    ctx.scoreTotal,
    classificacao:                 ctx.classificacao,
    diasSemComprar:                ctx.diasSemComprar,
    tendencia:                     ctx.tendencia,
    recorrenciaStatus:             ctx.recorrenciaStatus,
    pedidosTotal:                  ctx.pedidosTotal,
    pedidos30d:                    ctx.pedidos30d,
    pedidos60d:                    ctx.pedidos60d,
    pedidos90d:                    ctx.pedidos90d,
    pedidos180d:                   ctx.pedidos180d,
    faturamentoTotal:              ctx.faturamentoTotal,    // R$ float, não centavos
    faturamento30d:                ctx.faturamento30d,      // R$
    faturamento60d:                ctx.faturamento60d,      // R$
    faturamento90d:                ctx.faturamento90d,      // R$
    faturamento180d:               ctx.faturamento180d,     // R$
    ticketMedioTotal:              ctx.ticketMedioTotal,    // R$
    diasEntreComprasMedio:         ctx.diasEntreComprasMedio,
    diasEntreComprasMediana:       ctx.diasEntreComprasMediana,
    quantidadeProdutosDistintos:   ctx.quantidadeProdutosDistintos,
    quantidadeCategoriasDistintas: ctx.quantidadeCategoriasDistintas,
    // 2 campos mapeados: nome do contextoRaw → nome canônico do claim (INSTRUCTIONS_V2)
    oportunidadeTipo:              ctx.tipoOportunidade,   // tipoOportunidade → oportunidadeTipo
    oportunidadePrioridade:        ctx.prioridade,          // prioridade → oportunidadePrioridade
    // N30: campos de decisão determinística (null quando decisao não fornecido)
    decisaoAcaoComercial:          decisao?.decisaoAcaoComercial ?? null,
    diasAteProximoCiclo:           decisao?.diasAteProximoCiclo  ?? null,
    // Metadados internos (não afirmáveis — iniciam com _ ou são statusConfig)
    statusConfig:                  'SHADOW',
    _versaoGrounding:              VERSAO_GROUNDING_V2,
    _buildEm:                      new Date().toISOString(),
  });
}

// ── validarClaimsV2 ───────────────────────────────────────────────────────────

/**
 * Valida claims estruturados contra os grounding facts V2.
 *
 * Comparação por igualdade estrita (===):
 *   - null em facts → modelo não pode afirmar valor não-nulo
 *   - campo desconhecido nos facts → violação
 *   - campo de metadado interno (_X, statusConfig) → violação
 *   - valor diferente → violação
 *
 * @param {Array}  claims  — [{field, value}, ...]
 * @param {Object} facts   — resultado de buildGroundingFactsV2()
 * @throws {GroundingV2ViolationError}
 */
function validarClaimsV2(claims, facts) {
  if (!Array.isArray(claims)) {
    throw new GroundingV2ViolationError('claims', 'array', typeof claims);
  }

  for (const claim of claims) {
    const { field, value } = claim;

    // Metadados internos não são afirmáveis
    if (field.startsWith('_') || field === 'statusConfig') {
      throw new GroundingV2ViolationError(field, '(não afirmável)', value);
    }

    // Campo desconhecido nos facts → violação
    if (!(field in facts)) {
      throw new GroundingV2ViolationError(field, '(campo claimável V2)', '(campo desconhecido)');
    }

    const expected = facts[field];

    // null em facts → modelo não pode afirmar valor não-nulo
    if (expected === null && value !== null) {
      throw new GroundingV2ViolationError(field, null, value);
    }

    // Valor diferente → violação
    if (expected !== null && value !== expected) {
      throw new GroundingV2ViolationError(field, expected, value);
    }
  }
}

// ── validarFatosNoTextoV2 ─────────────────────────────────────────────────────

/**
 * Valida que valores factuais no texto livre da IA têm claims correspondentes.
 *
 * Herda a mesma estratégia conservadora do V1 + regra de urgência:
 *
 * REGRA URGÊNCIA (determinística):
 *   texto contém urgência E oportunidadeTipo=null E oportunidadePrioridade=null
 *   → TextFactV2ViolationError('URGENCIA_SEM_SINAL')
 *   Justificativa: sem sinal do motor determinístico (nenhuma oportunidade
 *   classificada, nenhuma prioridade), afirmação de urgência é infundada.
 *   Urgência em texto puro (sem MARCADOR proibido) não é blockável por guardrail;
 *   esta regra fecha o gap quando ambos os sinais de sinal são null.
 *
 * @param {string} texto   — texto livre do output V2 (diagnostico + acaoSugerida etc.)
 * @param {Array}  claims  — claims estruturados já validados por validarClaimsV2
 * @param {Object} facts   — resultado de buildGroundingFactsV2()
 * @throws {TextFactV2ViolationError}
 */
function validarFatosNoTextoV2(texto, claims, facts) {
  if (typeof texto !== 'string') return;

  const camposComClaim = new Set((claims || []).map(c => c.field));
  const temClaimDe    = (...prefixos) =>
    [...camposComClaim].some(f => prefixos.some(p => f.startsWith(p) || f === p));

  // ── Valores monetários (R$ prefix) ───────────────────────────────────────
  const monetarios = texto.match(REGEX_MONETARIO) || [];
  for (const m of monetarios) {
    // 'faturamento' cobre faturamentoTotal e faturamento30d..180d
    // 'ticketMedio' cobre ticketMedioTotal
    if (!temClaimDe('faturamento', 'ticketMedio')) {
      throw new TextFactV2ViolationError('MONETARIO', m);
    }
  }

  // ── Valores em reais sem prefixo R$ (ex: "1500 reais") ───────────────────
  const reaisTexto = texto.match(REGEX_REAIS) || [];
  for (const m of reaisTexto) {
    if (!temClaimDe('faturamento', 'ticketMedio')) {
      throw new TextFactV2ViolationError('REAIS_TEXTO', m);
    }
  }

  // ── Datas ISO (YYYY-MM-DD) ────────────────────────────────────────────────
  const datasISO = texto.match(REGEX_DATA_ISO) || [];
  for (const d of datasISO) {
    // V2 não tem campos de data — qualquer data ISO no texto é inventada
    if (!temClaimDe('ultimaCompraEm', 'primeiraCompraEm', 'dataReferencia')) {
      throw new TextFactV2ViolationError('DATA_ISO', d);
    }
  }

  // ── Datas BR (dd/mm/yyyy) ─────────────────────────────────────────────────
  const datasBR = texto.match(REGEX_DATA_BR) || [];
  for (const d of datasBR) {
    if (!temClaimDe('ultimaCompraEm', 'primeiraCompraEm', 'dataReferencia')) {
      throw new TextFactV2ViolationError('DATA_BR', d);
    }
  }

  // ── "N dias" no texto ─────────────────────────────────────────────────────
  const diasMatches = [...texto.matchAll(REGEX_DIAS)];
  for (const match of diasMatches) {
    const n = parseInt(match[1], 10);
    if (n <= 0) continue;
    const diasFacts = [
      facts.diasSemComprar,
      facts.diasEntreComprasMedio,
      facts.diasEntreComprasMediana,
    ].filter(v => v !== null);
    const coincide = diasFacts.some(v => v === n);
    if (!coincide && !temClaimDe('diasSemComprar', 'diasEntreComprasMedio', 'diasEntreComprasMediana')) {
      throw new TextFactV2ViolationError('DIAS', String(n));
    }
  }

  // ── "N pontos" no texto (score) ───────────────────────────────────────────
  const pontosMatches = [...texto.matchAll(REGEX_PONTOS)];
  for (const match of pontosMatches) {
    const n = parseInt(match[1], 10);
    if (n <= 0) continue;
    const coincide = facts.scoreTotal !== null && facts.scoreTotal === n;
    if (!coincide && !temClaimDe('scoreTotal')) {
      throw new TextFactV2ViolationError('PONTOS', String(n));
    }
  }

  // ── "N pedidos" no texto ──────────────────────────────────────────────────
  const pedidosMatches = [...texto.matchAll(REGEX_PEDIDOS_TEXTO)];
  for (const match of pedidosMatches) {
    const n = parseInt(match[1], 10);
    if (n < 0) continue;
    const pedidosFacts = [
      facts.pedidosTotal,
      facts.pedidos30d,
      facts.pedidos60d,
      facts.pedidos90d,
      facts.pedidos180d,
    ].filter(v => v !== null);
    const coincide = pedidosFacts.some(v => v === n);
    if (!coincide && !temClaimDe('pedidosTotal', 'pedidos30d', 'pedidos60d', 'pedidos90d', 'pedidos180d')) {
      throw new TextFactV2ViolationError('PEDIDOS', String(n));
    }
  }

  // ── URGÊNCIA SEM SINAL DETERMINÍSTICO ─────────────────────────────────────
  // Regra determinística: urgência requer pelo menos um sinal do motor
  // (oportunidadeTipo ≠ null OU oportunidadePrioridade ≠ null).
  // Quando ambos são null, não há base factual para afirmar urgência.
  const urgenciaMatch = texto.match(REGEX_URGENCIA);
  if (urgenciaMatch &&
      facts.oportunidadeTipo === null &&
      facts.oportunidadePrioridade === null) {
    throw new TextFactV2ViolationError('URGENCIA_SEM_SINAL', urgenciaMatch[0]);
  }
}

// ── validarContradicaoSemanticaV2 ─────────────────────────────────────────────

/**
 * Valida que o texto livre não contradiz os fatos de tendência.
 * Reutiliza PADROES_CONTRADICAO_TENDENCIA do V1 (motor idêntico).
 *
 * @param {string} texto   — conteúdo do output V2
 * @param {Object} facts   — resultado de buildGroundingFactsV2()
 * @throws {SemanticV2ContradictionError}
 */
function validarContradicaoSemanticaV2(texto, facts) {
  if (typeof texto !== 'string' || !facts) return;
  const tendencia = facts.tendencia;
  if (!tendencia || tendencia === 'SEM_BASE') return;

  const padroes = PADROES_CONTRADICAO_TENDENCIA[tendencia] || [];
  for (const padrao of padroes) {
    if (padrao.test(texto)) {
      throw new SemanticV2ContradictionError('tendencia', tendencia, padrao.source);
    }
  }
}

// ── validarMarcadoresProibidosV2 ──────────────────────────────────────────────

/**
 * Verifica output V2 (diagnostico, sinaisRelevantes, acaoSugerida) contra
 * MARCADORES_PROIBIDOS (AI_FINANCIAL_AUTHORITY = NONE).
 *
 * Lança GuardrailViolationError (mesma classe do V1) para consistência.
 *
 * @param {Object} output  — {diagnostico, sinaisRelevantes, acaoSugerida, claims}
 * @throws {GuardrailViolationError}
 */
function validarMarcadoresProibidosV2(output) {
  const partes = [
    typeof output.diagnostico === 'string' ? output.diagnostico : '',
    Array.isArray(output.sinaisRelevantes) ? output.sinaisRelevantes.join(' ') : '',
    typeof output.acaoSugerida === 'string' ? output.acaoSugerida : '',
  ];
  const textoCompleto = partes.join(' ').toUpperCase();

  for (const marcador of MARCADORES_PROIBIDOS) {
    if (textoCompleto.includes(marcador.toUpperCase())) {
      throw new GuardrailViolationError(
        'AI_FINANCIAL_AUTHORITY_V2',
        `output V2 contém marcador proibido: "${marcador}"`
      );
    }
  }
}

// ── validarCoerenciaAcaoComercial ─────────────────────────────────────────────

/**
 * Valida que o acaoTiming produzido pelo LLM é coerente com a decisão
 * determinística calculada antes da chamada (N30).
 *
 * Guardrail pós-output: FAIL_CLOSED — incoerência → AcaoCoerenciaViolationError.
 *
 * Decisão → acaoTiming esperado (ACAO_TIMING_MAP):
 *   AGIR_AGORA      → AGORA
 *   PROGRAMAR_CICLO → NO_CICLO
 *   NAO_AGIR        → NENHUMA
 *
 * @param {string}      decisaoAcaoComercial — valor calculado deterministicamente
 * @param {string|null} acaoTiming           — valor no output do LLM
 * @throws {AcaoCoerenciaViolationError}
 */
function validarCoerenciaAcaoComercial(decisaoAcaoComercial, acaoTiming) {
  if (acaoTiming == null) return; // schema antigo sem acaoTiming → não bloqueia

  const esperado = ACAO_TIMING_MAP[decisaoAcaoComercial];
  if (!esperado) {
    throw new AcaoCoerenciaViolationError(
      decisaoAcaoComercial, acaoTiming, '(decisão desconhecida)'
    );
  }

  if (acaoTiming !== esperado) {
    throw new AcaoCoerenciaViolationError(decisaoAcaoComercial, acaoTiming, esperado);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_GROUNDING_V2,
  SCHEMA_CONTEXTO_V2,
  ACAO_TIMING_MAP,
  buildGroundingFactsV2,
  validarClaimsV2,
  validarFatosNoTextoV2,
  validarContradicaoSemanticaV2,
  validarMarcadoresProibidosV2,
  validarCoerenciaAcaoComercial,
  GroundingV2ViolationError,
  TextFactV2ViolationError,
  SemanticV2ContradictionError,
  AcaoCoerenciaViolationError,
};
