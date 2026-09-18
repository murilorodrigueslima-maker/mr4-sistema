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
// N31.5 Fix 1: captura número decimal completo ("17,5" ou "17.5" como unidade única)
// Evita que "17,5 dias" gere match autônomo de "5 dias" via word boundary na vírgula.
const REGEX_DIAS          = /\b(\d+(?:[,.]\d+)?)\s+dias?\b/gi;
const REGEX_PONTOS        = /\b(\d+)\s+pontos?\b/gi;
const REGEX_PEDIDOS_TEXTO = /\b(\d+)\s+pedidos?\b/gi;

// Urgência sem sinal determinístico
const REGEX_URGENCIA = /\b(urgente|urgência|urgencia|imediato|imediata|agora\s+mesmo|hoje\s+mesmo|sem\s+demora|imediatamente)\b/i;

// N31.3 Fix 1: Negação LOCAL (mesma cláusula, antes da palavra de urgência)
// Usa \S+ em vez de \w+ para cobrir caracteres acentuados do português (á, ã, é, ç …)
const REGEX_NEGACAO_LOCAL_ANTES = [
  /\bn[ãa]o\b(?:\s+\S+){0,5}\s*$/i,   // "não [até 5 tokens]"
  /\bsem\b(?:\s+\S+){0,3}\s*$/i,       // "sem [até 3 tokens]"
  /\bevite?\b(?:\s+\S+){0,2}\s*$/i,    // "evite [até 2 tokens]"
];

// N31.3 Fix 2 / N31.5 Fix 2: Janelas de métricas temporais legítimas
const JANELAS_METRICAS = Object.freeze(new Set([30, 60, 90, 180]));

// N31.5 Fix 2: âncora de lista de janelas de métricas no ctxAntes
// Detecta: "nos últimos [n1, n2, ..., e/ou ]" ou "janelas de [n1, ..., e/ou ]"
// O ctxAntes deve terminar com esta construção imediatamente antes do número N.
// Anti-bypass: requer âncora léxica explícita; não libera N após contexto genérico.
// N32.2 GAP-1: adicionado suporte à conjunção "ou" em listas (ex: "30, 60, 90 ou 180 dias")
const REGEX_ANCORA_JANELA = /(?:[úu]ltimos?\s+|janelas?\s+de\s+)(?:\d+\s*(?:,\s*|(?:e|ou)\s+))*\s*$/i;

// N32.2 GAP-2: "pedidos em N dias" / "compras em N dias"
// Anti-bypass: exige palavra de métrica transacional antes de "em"; bloqueia "ligar em N dias" etc.
const REGEX_ANCORA_PEDIDOS_EM = /\b(?:pedidos?|compras?)\s+em\s+$/i;

// N32.2 GAP-3: "faturamento de N dias" / "faturamento dos últimos N dias" / "faturamento no período de N dias"
// Anti-bypass: exige "faturamento" explícito; bloqueia "prazo de N dias", "condição de N dias" etc.
const REGEX_ANCORA_FATURAMENTO_DE = /\bfaturamento\s+(?:de\s+|dos?\s+[úu]ltimos?\s+|no\s+per[íi]odo\s+de\s+)\s*$/i;

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

// ── Helpers N31.3 ────────────────────────────────────────────────────────────

/**
 * N31.3 Fix 1: Retorna a palavra de urgência se há urgência AFIRMATIVA no texto,
 * ou null se todas as ocorrências estão localmente negadas.
 * Negação LOCAL = na mesma cláusula (.!?;) e antes da palavra de urgência.
 */
function _urgenciaAfirmativaPresente(texto) {
  if (typeof texto !== 'string') return null;
  const clausulas = texto.split(/(?<=[.!?;])\s*/);
  for (const clausula of clausulas) {
    if (!clausula) continue;
    for (const m of clausula.matchAll(new RegExp(REGEX_URGENCIA.source, 'gi'))) {
      const textoAntes = clausula.slice(0, m.index);
      if (!REGEX_NEGACAO_LOCAL_ANTES.some(r => r.test(textoAntes))) {
        return m[0];
      }
    }
  }
  return null;
}

/**
 * N31.3 Fix 2: Verifica se a janela de métricas de N dias está presente nos facts.
 * Cobre pedidosNd e faturamentoNd para N ∈ {30,60,90,180}.
 */
function _janelaMetricaExiste(n, facts) {
  if (n === 30)  return facts.pedidos30d  !== null || facts.faturamento30d  !== null;
  if (n === 60)  return facts.pedidos60d  !== null || facts.faturamento60d  !== null;
  if (n === 90)  return facts.pedidos90d  !== null || facts.faturamento90d  !== null;
  if (n === 180) return facts.pedidos180d !== null || facts.faturamento180d !== null;
  return false;
}

/**
 * N31.5 Fix 2: Retorna o Set de janelas métricas com dados reais nos facts.
 * Evita whitelist cega de {30,60,90,180} — só autoriza janelas com dado presente.
 */
function _janelasAutorizadas(facts) {
  const autorizadas = new Set();
  for (const n of JANELAS_METRICAS) {
    if (_janelaMetricaExiste(n, facts)) autorizadas.add(n);
  }
  return autorizadas;
}

/**
 * N31.5 Fix 2: Detecta se um match de N dias é referência legítima de janela
 * dentro de uma construção de lista de métricas.
 *
 * Exemplos legítimos:
 *   "nos últimos 30, 60, 90 e 180 dias"  → ctxAntes = "nos últimos 30, 60, 90 e "
 *   "nos últimos 180 dias"                → ctxAntes = "nos últimos "
 *   "janelas de 30, 60 e 90 dias"         → ctxAntes = "janelas de 30, 60 e "
 *
 * Anti-bypass: requer âncora ("últimos" / "janelas de") seguida de lista de
 * números IMEDIATAMENTE antes de N. Contexto genérico com "últimos" distante
 * (ex: "últimos resultados indicam … 180 dias") não ativa o bypass.
 *
 * @param {string} texto
 * @param {number} matchIndex  — posição do match no texto
 * @param {number} n           — valor numérico do match (deve ser inteiro)
 * @param {Set<number>} janelasAutorizadas — resultado de _janelasAutorizadas(facts)
 */
function _ehReferenciaJanela(texto, matchIndex, n, janelasAutorizadas) {
  if (!Number.isInteger(n)) return false;          // janelas só em inteiros
  if (!JANELAS_METRICAS.has(n)) return false;      // só {30,60,90,180}
  if (!janelasAutorizadas.has(n)) return false;    // janela precisa ter dado real
  const ctxAntes = texto.slice(Math.max(0, matchIndex - 120), matchIndex);
  // GAP-1 (N31.5/N32.2): lista "nos últimos ... e/ou N" ou "janelas de ... e/ou N"
  if (REGEX_ANCORA_JANELA.test(ctxAntes)) return true;
  // GAP-2 (N32.2): "pedidos em N dias" / "compras em N dias"
  if (REGEX_ANCORA_PEDIDOS_EM.test(ctxAntes)) return true;
  // GAP-3 (N32.2): "faturamento de N dias" / variantes preposicionais
  if (REGEX_ANCORA_FATURAMENTO_DE.test(ctxAntes)) return true;
  return false;
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
  // N31:   diasAteProximoCiclo é fact aceitável.
  // N31.3: janela de métricas "nos últimos N dias" → bypass quando N ∈ {30,60,90,180}
  //        com dado presente nos facts.
  // N31.5 Fix 1: REGEX_DIAS captura decimal completo ("17,5" / "17.5");
  //              normalizar para float antes de comparar com facts.
  // N31.5 Fix 2: _ehReferenciaJanela detecta lista "30, 60, 90 e 180 dias"
  //              com âncora léxica obrigatória — substituiu o ctxAntes(20) inline.
  const janelasAuth = _janelasAutorizadas(facts);
  const diasMatches = [...texto.matchAll(REGEX_DIAS)];
  for (const match of diasMatches) {
    const rawN = match[1];                            // ex: "17,5", "17.5", "17"
    const n    = parseFloat(rawN.replace(',', '.'));  // normalizar separador decimal
    if (!Number.isFinite(n) || n <= 0) continue;

    // N31.5 Fix 2: referência de janela de métricas (lista ou singular)
    if (_ehReferenciaJanela(texto, match.index, n, janelasAuth)) continue;

    const diasFacts = [
      facts.diasSemComprar,
      facts.diasEntreComprasMedio,
      facts.diasEntreComprasMediana,
      facts.diasAteProximoCiclo,
    ].filter(v => v !== null);

    // N31.5 Fix 1: match exato cobre floats ("17,5" === 17.5);
    // rounding só se n é inteiro no texto e fact é float (contrato N31.3).
    const coincide = diasFacts.some(v => {
      if (v === n) return true;
      if (Number.isInteger(n) && !Number.isInteger(v)) {
        return Math.floor(v) === n || Math.ceil(v) === n;
      }
      return false;
    });
    if (!coincide) {
      throw new TextFactV2ViolationError('DIAS', rawN);
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
  // Regra determinística: urgência AFIRMATIVA requer pelo menos um sinal do motor
  // (oportunidadeTipo ≠ null OU oportunidadePrioridade ≠ null).
  // N31.3 Fix 1: negação LOCAL (mesma cláusula, antes da palavra) isenta a ocorrência.
  // "não há necessidade de ação imediata" → isento; "entre em contato imediatamente" → BLOCK.
  const urgenciaAfirmativa = _urgenciaAfirmativaPresente(texto);
  if (urgenciaAfirmativa !== null &&
      facts.oportunidadeTipo === null &&
      facts.oportunidadePrioridade === null) {
    throw new TextFactV2ViolationError('URGENCIA_SEM_SINAL', urgenciaAfirmativa);
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

// ── validarTextoAcaoComercial ─────────────────────────────────────────────────

class TextoAcaoViolationError extends Error {
  constructor(decisao, descricao, padrao) {
    super(
      `[TEXTO-ACAO] output contém instrução incompatível com decisão ${decisao}: ` +
      `${descricao} (padrão: "${padrao}")`
    );
    this.name     = 'TextoAcaoViolationError';
    this.decisao  = decisao;
    this.descricao = descricao;
    this.padrao   = padrao;
  }
}

// Padrões de ação imediata incompatíveis com PROGRAMAR_CICLO.
// PROGRAMAR_CICLO = acompanhar no ciclo normal, sem urgência imediata.
// LIMITE NLP: "amanhã" é bloqueado mesmo quando diasAteProximoCiclo=1
// (conservador: o texto correto seria "no próximo ciclo", não "amanhã").
const MARCADORES_PROGRAMAR_CICLO_IMEDIATO = Object.freeze([
  [/\bentre em contato\s+(imediatamente|agora|hoje|j[aá])\b/i, 'contato imediato'],
  [/\bligue\s+(hoje|agora|j[aá]|imediatamente)\b/i, 'ligar hoje/agora'],
  [/\bcontate\s+(hoje|agora|j[aá]|imediatamente)\b/i, 'contato imediato'],
  [/\babordar?\s+(imediatamente|agora|hoje|j[aá])\b/i, 'abordar imediatamente'],
  [/\bprioriz[ae]?\b.*?\b(agora|hoje|imediatamente)\b/i, 'priorizar agora'],
  [/\breative\s+o\s+cliente\b/i, 'reativar cliente sem oportunidade'],
  [/amanhã/i, 'amanhã: urgência implícita incompatível com ciclo programado'],
]);

// Padrões de ação comercial incompatíveis com NAO_AGIR.
// NAO_AGIR = sem sinal determinístico suficiente para ação.
// LIMITE NLP: "/ligue/" pode falso-positivo em "não ligue sem verificar" —
// documentado como aceitável (conservador: FAIL_CLOSED).
const MARCADORES_NAO_AGIR = Object.freeze([
  [/\bentre em contato\b/i, 'sugestão de contato'],
  [/\bmande mensagem\b/i, 'sugestão de mensagem'],
  [/\benvi[ae]\s+(?:uma\s+)?mensagem\b/i, 'sugestão de envio de mensagem'],
  [/\b(?:ligue|ligar)\b/i, 'sugestão de ligação'],
  [/\bfa[çc]a uma oferta\b/i, 'sugestão de oferta'],
  [/\breativ[ae]\b/i, 'sugestão de reativação'],
  [/\babordar?\s+o\s+cliente\b/i, 'sugestão de abordagem'],
  [/\bprioriz[ae]?\s+o\s+contato\b/i, 'sugestão de priorizar contato'],
  [/\bcontate\b/i, 'sugestão de contato direto'],
]);

/**
 * Valida que o texto livre do output V2 não contém instruções explicitamente
 * incompatíveis com a decisão determinística de ação comercial (N31).
 *
 * Verifica: diagnostico + sinaisRelevantes + acaoSugerida (texto completo).
 *
 * Não tenta resolver NLP completo. Detecta apenas padrões explicitamente
 * incompatíveis (instruções de ação imediata para PROGRAMAR_CICLO;
 * qualquer instrução de ação comercial para NAO_AGIR).
 *
 * AGIR_AGORA: sem bloqueio de texto (ação comercial legítima esperada).
 *
 * @param {string}      decisaoAcaoComercial — valor calculado deterministicamente
 * @param {Object}      output — { diagnostico, sinaisRelevantes, acaoSugerida }
 * @throws {TextoAcaoViolationError}
 */
function validarTextoAcaoComercial(decisaoAcaoComercial, output) {
  const partes = [
    typeof output.diagnostico === 'string'       ? output.diagnostico : '',
    Array.isArray(output.sinaisRelevantes)        ? output.sinaisRelevantes.join(' ') : '',
    typeof output.acaoSugerida === 'string'       ? output.acaoSugerida : '',
  ];
  const texto = partes.join(' ');

  if (decisaoAcaoComercial === 'PROGRAMAR_CICLO') {
    for (const [regex, descricao] of MARCADORES_PROGRAMAR_CICLO_IMEDIATO) {
      if (regex.test(texto)) {
        throw new TextoAcaoViolationError('PROGRAMAR_CICLO', descricao, regex.source);
      }
    }
  }

  if (decisaoAcaoComercial === 'NAO_AGIR') {
    for (const [regex, descricao] of MARCADORES_NAO_AGIR) {
      if (regex.test(texto)) {
        throw new TextoAcaoViolationError('NAO_AGIR', descricao, regex.source);
      }
    }
  }
  // AGIR_AGORA: sem bloqueio de texto — ação comercial é esperada e legítima
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
  MARCADORES_PROGRAMAR_CICLO_IMEDIATO,
  MARCADORES_NAO_AGIR,
  buildGroundingFactsV2,
  validarClaimsV2,
  validarFatosNoTextoV2,
  validarContradicaoSemanticaV2,
  validarMarcadoresProibidosV2,
  validarCoerenciaAcaoComercial,
  validarTextoAcaoComercial,
  GroundingV2ViolationError,
  TextFactV2ViolationError,
  SemanticV2ContradictionError,
  AcaoCoerenciaViolationError,
  TextoAcaoViolationError,
  // N32.2: exportar para testes
  REGEX_ANCORA_JANELA,
  REGEX_ANCORA_PEDIDOS_EM,
  REGEX_ANCORA_FATURAMENTO_DE,
};
