'use strict';

/**
 * N33.3 — Contrato de Abordagem V1 para COMO_ABORDAR
 *
 * ZERO OpenAI | ZERO I/O | ZERO side effects | ZERO production
 *
 * Define:
 *   1. Quais decisões são elegíveis para LLM (somente AGIR_AGORA)
 *   2. Renders determinísticos para PROGRAMAR_CICLO e NAO_AGIR
 *   3. Orientação por tipo de oportunidade (dados, não código LLM)
 *   4. Regras de validação do texto comoAbordar (seller-facing)
 *
 * AI_FINANCIAL_AUTHORITY = NONE — permanece inalterado.
 *
 * Tipos V1 cobertos: REATIVACAO_120D, QUEDA_DE_COMPRAS, JANELA_DE_RECOMPRA.
 * CROSS_SELL: desativado. PROSPECT_VINCULADO: não entra sem autorização específica.
 */

const VERSAO_CONTRACT = 'abordagem-contract-v1';

// ── Elegibilidade LLM ─────────────────────────────────────────────────────────

/**
 * Somente AGIR_AGORA é elegível para LLM em V1.
 * PROGRAMAR_CICLO e NAO_AGIR têm renders determinísticos.
 */
const LLM_ELIGIBLE_DECISIONS = Object.freeze(['AGIR_AGORA']);

/**
 * Retorna true se a decisão é elegível para LLM (gerar comoAbordar).
 * @param {string} decisaoAcaoComercial
 * @returns {boolean}
 */
function ehElegivelLLM(decisaoAcaoComercial) {
  return LLM_ELIGIBLE_DECISIONS.includes(decisaoAcaoComercial);
}

// ── Renders determinísticos ───────────────────────────────────────────────────

/**
 * Texto de "quando" para AGIR_AGORA — constante seller-facing.
 * Single source of truth: usada pela fila e pelo Seller Assist.
 */
const QUANDO_AGIR_AGORA = 'Ação recomendada: neste ciclo.';

/**
 * Render determinístico para AGIR_AGORA — sem LLM, sem provider.
 * Single source of truth: usada diretamente pela fila e reutilizada pelo Seller Assist.
 *
 * @param {Object} decisaoCtx — { tipoOportunidade, diasSemComprar, diasEntreComprasMediana, cicloMedianoDias? }
 * @returns {string} — texto seller-facing de situacao
 */
function renderizarAgirAgora(decisaoCtx) {
  const tipo = decisaoCtx.tipoOportunidade;
  const dsc  = decisaoCtx.diasSemComprar;
  const med  = decisaoCtx.diasEntreComprasMediana ?? decisaoCtx.cicloMedianoDias ?? null;

  if (tipo === 'REATIVACAO_120D') {
    return `Cliente sem comprar há ${dsc} dias (ciclo habitual: ${med} dias). Reativação necessária.`;
  }
  if (tipo === 'QUEDA_DE_COMPRAS') {
    return `Cliente com queda no ritmo de compras. Sem compras há ${dsc} dias (ciclo habitual: ${med} dias).`;
  }
  if (tipo === 'JANELA_DE_RECOMPRA') {
    return `Cliente na janela de recompra habitual. ${dsc} dias desde a última compra (ciclo habitual: ${med} dias).`;
  }
  return `Ação comercial identificada. ${dsc} dias desde a última compra.`;
}

/**
 * Render determinístico para PROGRAMAR_CICLO — sem LLM.
 *
 * @param {number|null} diasAteProximoCiclo — diasAteProximoCiclo do motor N30
 * @returns {Object} — resultado imutável
 */
function renderizarProgramarCiclo(diasAteProximoCiclo) {
  const dias = (typeof diasAteProximoCiclo === 'number' && diasAteProximoCiclo >= 0)
    ? Math.round(diasAteProximoCiclo)
    : null;

  return Object.freeze({
    decisaoAcao: 'PROGRAMAR_CICLO',
    situacao:    'Cliente dentro do ciclo habitual de compra.',
    quando:      dias !== null && dias > 0
                   ? `Próxima revisão: em aproximadamente ${dias} dias.`
                   : 'Próxima revisão: no próximo ciclo habitual.',
    comoAbordar: null,  // PROGRAMAR_CICLO — sem LLM em V1
  });
}

/**
 * Render determinístico para NAO_AGIR — sem LLM.
 * Usa linguagem de ausência de sinal, não de saúde comercial.
 * NÃO afirma que o cliente está bem — apenas que não há sinal suficiente.
 *
 * @returns {Object} — resultado imutável
 */
function renderizarNaoAgir() {
  return Object.freeze({
    decisaoAcao: 'NAO_AGIR',
    situacao:    'Sem sinal determinístico suficiente para ação comercial.',
    quando:      'Sem ação necessária no momento.',
    comoAbordar: null,  // NAO_AGIR — sem LLM em V1
  });
}

// ── Orientação por tipo de oportunidade ──────────────────────────────────────
//
// Estrutura de dados para uso pelo prompt quando a LLM for conectada.
// NÃO é código executado por LLM — é o contrato que define O QUE o prompt
// deve pedir à LLM que produza (orientando o vendedor).
//
// Cada tipo define:
//   objetivoContato — uma linha descrevendo o objetivo do contato
//   investigar      — tópicos que o vendedor PODE e DEVE investigar
//   naoAfirmar      — causas/afirmações que NÃO PODEM aparecer como fatos
//   tamanhoIdeal    — guia de tamanho para o output LLM
//
// Distinção fundamental:
//   HIPÓTESE/PERGUNTA: "investigue se houve mudança de fornecedor" → PERMITIDA
//   AFIRMAÇÃO:         "o cliente mudou de fornecedor"             → PROIBIDA

const ORIENTACAO_POR_OPORTUNIDADE = Object.freeze({

  REATIVACAO_120D: Object.freeze({
    objetivoContato: 'Retomar o relacionamento e verificar se existe demanda atual.',
    investigar: Object.freeze([
      'motivo da pausa no ciclo de compra',
      'mudança na necessidade de reposição',
      'mudança no padrão de abastecimento',
      'possível mudança de fornecedor',
      'redução do giro no negócio do cliente',
    ]),
    naoAfirmar: Object.freeze([
      'cliente mudou de fornecedor',
      'cliente está insatisfeito com o serviço',
      'cliente perdeu demanda',
      'cliente fechou ou reduziu o negócio',
    ]),
    tamanhoIdeal: '1-2 frases orientando investigação e retomada de relacionamento',
  }),

  QUEDA_DE_COMPRAS: Object.freeze({
    objetivoContato: 'Entender a causa da redução no ritmo de compras.',
    investigar: Object.freeze([
      'causa da redução do volume de compras',
      'redução no giro do estoque do cliente',
      'mudança no padrão de compra',
      'concentração das compras em outro fornecedor',
      'mudança na necessidade do negócio',
    ]),
    naoAfirmar: Object.freeze([
      'o cliente mudou de fornecedor',
      'o giro do estoque caiu por um motivo específico',
      'o cliente está comprando do concorrente',
      'o cliente perdeu clientes',
    ]),
    tamanhoIdeal: '1-2 frases orientando investigação com contexto de queda',
  }),

  JANELA_DE_RECOMPRA: Object.freeze({
    objetivoContato: 'Verificar necessidade de reposição compatível com o ciclo histórico.',
    investigar: Object.freeze([
      'necessidade de reposição de estoque',
      'demanda atual do cliente',
      'situação atual do estoque',
    ]),
    naoAfirmar: Object.freeze([
      'o cliente precisa comprar agora',
      'o estoque do cliente acabou',
      'é urgente que o cliente compre',
    ]),
    tamanhoIdeal: '1-2 frases de acompanhamento leve, sem urgência fabricada',
  }),

});

// ── Proibições seller-facing ──────────────────────────────────────────────────

/**
 * Termos internos do motor que não podem aparecer em output ao vendedor.
 * Exatos (case-insensitive match).
 */
const TERMOS_INTERNOS_SELLER_FACING = Object.freeze([
  'AGIR_AGORA',
  'PROGRAMAR_CICLO',
  'NAO_AGIR',
  'scoreTotal',
  'priorityScore',
  'REATIVACAO_120D',
  'QUEDA_DE_COMPRAS',
  'JANELA_DE_RECOMPRA',
  'decision engine',
  'determinístico',
  'grounding',
  'Perfil360',
  'claims',
  'validator',
  'FILA_RECOMPRA',
  'FILA_PROSPECCAO',
  'statusConfig',
  'AI_MODE',
  'SHADOW',
]);

/**
 * Padrões de autoridade financeira — AI_FINANCIAL_AUTHORITY = NONE.
 * Nenhuma dessas frases pode aparecer em comoAbordar.
 */
const PADROES_FINANCEIROS_PROIBIDOS = Object.freeze([
  /\bofere[çc]a?\s+desconto\b/i,
  /\bde[es]conto\s+especial\b/i,
  /\bdar\s+(?:um\s+)?desconto\b/i,
  /\bmelhore\s+o\s+pre[çc]o\b/i,
  /\bbaixe?\s+o\s+pre[çc]o\b/i,
  /\bpre[çc]o\s+especial\b/i,
  /\blibere?\s+cr[eé]dito\b/i,
  /\blimite\s+de\s+cr[eé]dito\b/i,
  /\bcondi[çc][aã]o\s+especial\b/i,
  /\bparcelamento\b/i,
  /\bprazo\s+(?:de\s+pagamento|estendido|especial)\b/i,
  /\bcomiss[aã]o\b/i,
]);

/**
 * Padrões de causa inventada apresentada como FATO.
 * Distingue de HIPÓTESES (que são permitidas):
 *   OK:    "investigue se o cliente mudou de fornecedor"
 *   BLOCK: "o cliente mudou de fornecedor"
 *
 * Regex terminam com (?!\s*\?) para não bloquear a forma de pergunta.
 */
const PADROES_CAUSA_INVENTADA = Object.freeze([
  /\bmudou\s+de\s+fornecedor\b(?!\s*\?)/i,
  /\best[aá]\s+insatisfeito\b/i,
  /\bficou\s+insatisfeito\b/i,
  /\best[aá]\s+comprando\s+(?:do|de)\s+(?:outro|concorrente)\b/i,
  /\bconcorrente\s+(?:ganhou|levou)\b/i,
  /\bperdeu\s+clientes\b(?!\s*\?)/i,
]);

/**
 * Padrões de mensagem pronta para cliente (WhatsApp / email).
 * comoAbordar é orientação ao VENDEDOR, não mensagem ao cliente.
 */
const PADROES_MENSAGEM_PRONTA = Object.freeze([
  /^ol[aá]\s/i,      // "Olá <nome>..."
  /^oi\s/i,           // "Oi <nome>..."
  /\btudo\s+bem\s*\?/i, // "tudo bem?"
  /\bcomo\s+vai\s*\?/i, // "como vai?"
]);

/**
 * Padrões de urgência fabricada incompatíveis com JANELA_DE_RECOMPRA.
 * JANELA é um sinal de oportunidade, não de urgência real.
 */
const PADROES_URGENCIA_JANELA = Object.freeze([
  /\b(?:o\s+cliente\s+)?precisa\s+comprar\s*(?:agora|hoje|j[aá]|imediatamente)?\b/i,
  /(^|\s)[eé]\s+urgente\b/i,
  /\burgente(?:mente)?\s+(?:comprar|repor|adquirir)\b/i,
]);

// ── Erros ─────────────────────────────────────────────────────────────────────

class AbordagemViolationError extends Error {
  constructor(regra, trecho, padrao = null) {
    const ref = padrao ? ` (padrão: "${String(padrao).slice(0, 60)}")` : '';
    super(`[ABORDAGEM] ${regra}${ref}: "${String(trecho).slice(0, 80)}"`);
    this.name   = 'AbordagemViolationError';
    this.regra  = regra;
    this.padrao = padrao;
    this.trecho = trecho;
  }
}

// ── Validadores helpers ───────────────────────────────────────────────────────

function _validarTermosInternos(texto) {
  const upper = texto.toUpperCase();
  for (const termo of TERMOS_INTERNOS_SELLER_FACING) {
    if (upper.includes(termo.toUpperCase())) {
      throw new AbordagemViolationError('TERMO_INTERNO', texto, termo);
    }
  }
}

function _validarFinanceiro(texto) {
  for (const padrao of PADROES_FINANCEIROS_PROIBIDOS) {
    if (padrao.test(texto)) {
      throw new AbordagemViolationError('FINANCEIRO', texto, padrao.source);
    }
  }
}

function _validarCausaInventada(texto) {
  for (const padrao of PADROES_CAUSA_INVENTADA) {
    if (padrao.test(texto)) {
      throw new AbordagemViolationError('CAUSA_INVENTADA', texto, padrao.source);
    }
  }
}

function _validarMensagemPronta(texto) {
  for (const padrao of PADROES_MENSAGEM_PRONTA) {
    if (padrao.test(texto)) {
      throw new AbordagemViolationError('MENSAGEM_PRONTA', texto, padrao.source);
    }
  }
}

function _validarUrgenciaJanela(texto) {
  for (const padrao of PADROES_URGENCIA_JANELA) {
    if (padrao.test(texto)) {
      throw new AbordagemViolationError('URGENCIA_JANELA', texto, padrao.source);
    }
  }
}

// ── Validador principal ───────────────────────────────────────────────────────

/**
 * Valida o texto de comoAbordar contra o contrato V1.
 *
 * Regras universais:
 *   1. TERMO_INTERNO    — sem terminologia interna do motor
 *   2. FINANCEIRO       — sem autoridade financeira (AI_FINANCIAL_AUTHORITY=NONE)
 *   3. CAUSA_INVENTADA  — sem causa afirmada como fato
 *   4. MENSAGEM_PRONTA  — não é mensagem pronta para o cliente
 *
 * Regras por tipo (opcional via opts.tipoOportunidade):
 *   5. URGENCIA_JANELA  — urgência fabricada bloqueada para JANELA_DE_RECOMPRA
 *
 * Regras NOT implementadas (deferir — requerem NLP ou heurística frágil):
 *   - Distinção genérica investigação vs. afirmação além dos padrões conhecidos
 *   - Validação semântica completa de orientação por oportunidade
 *   - Comprimento mínimo/máximo (preferência, não hard block)
 *
 * @param {string} texto — comoAbordar text to validate
 * @param {Object} [opts]
 * @param {string} [opts.tipoOportunidade] — habilita checks tipo-específicos
 * @throws {AbordagemViolationError}
 */
function validarComoAbordar(texto, opts = {}) {
  if (typeof texto !== 'string' || !texto.trim()) {
    throw new AbordagemViolationError('FORMATO', texto ?? '(vazio)');
  }

  _validarTermosInternos(texto);
  _validarFinanceiro(texto);
  _validarCausaInventada(texto);
  _validarMensagemPronta(texto);

  if (opts.tipoOportunidade === 'JANELA_DE_RECOMPRA') {
    _validarUrgenciaJanela(texto);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_CONTRACT,
  LLM_ELIGIBLE_DECISIONS,
  ORIENTACAO_POR_OPORTUNIDADE,
  TERMOS_INTERNOS_SELLER_FACING,
  PADROES_FINANCEIROS_PROIBIDOS,
  PADROES_CAUSA_INVENTADA,
  PADROES_MENSAGEM_PRONTA,
  PADROES_URGENCIA_JANELA,
  AbordagemViolationError,
  ehElegivelLLM,
  QUANDO_AGIR_AGORA,
  renderizarAgirAgora,
  renderizarProgramarCiclo,
  renderizarNaoAgir,
  validarComoAbordar,
};
