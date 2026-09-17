'use strict';

/**
 * Grounding Determinístico — N19 (G1 + G2).
 *
 * PRINCÍPIO: A IA NÃO É A FONTE DOS FATOS.
 * Perfil360 e os motores determinísticos são a fonte de verdade.
 *
 * Este módulo resolve dois gaps identificados na auditoria:
 *
 *   G1 — Números/datas/contagens fabricados pela IA passavam pelos guardrails
 *        sem verificação. Agora, qualquer afirmação factual da IA deve usar
 *        claims estruturados, e cada claim é validado contra os facts do input.
 *
 *   G2 — Dados do Perfil360 (nomes, observações, categorias) iam direto para
 *        o prompt sem sanitização. Agora passam por isolamento estruturado que
 *        impede que conteúdo malicioso ganhe autoridade de instrução.
 *
 * ARQUITETURA:
 *
 *   1. buildGroundingFacts(perfil, score, tendencia, recorrencia)
 *      → extrai todos os fatos numéricos/datas/contagens permitidos
 *
 *   2. sanitizarDadoParaPrompt(valor, campo)
 *      → trata dado como DADO, não como instrução
 *
 *   3. validarClaims(claims, facts)
 *      → valida que cada claim da IA existe nos facts e tem o valor correto
 *
 *   4. validarOutputComGrounding(output, facts)
 *      → valida output estruturado (claims) contra facts
 *
 * NOTA: Com MockProvider os claims são fixos e não há risco de alucinação.
 * Este módulo protege a arquitetura para quando LLM real for conectado.
 */

const VERSAO_GROUNDING = 'grounding-v2';

// ── Padrões suspeitos em campos de dados (G2) ──────────────────────────────────
// Impede que dados do Perfil360 ganhem autoridade de instrução no prompt.
const PADROES_INSTRUCAO_EM_DADOS = [
  /ignore\s+(as\s+instru[çc][õo]es|previous|system)/i,
  /system\s*:/i,
  /developer\s*:/i,
  /assistant\s*:/i,
  /user\s*:/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+(if|though)/i,
  /forget\s+your\s+rules/i,
  /jailbreak/i,
  /dan\s+mode/i,
  /aprove\s+(desconto|pedido)/i,
  /altere?\s+(pre[çc]o|desconto|limite|cr[eé]dito)/i,
  /crie?\s+(pedido|venda)/i,
];

// ── Erros ──────────────────────────────────────────────────────────────────────

class GroundingViolationError extends Error {
  constructor(field, expected, received) {
    super(
      `[GROUNDING] claim inválido: campo "${field}" — ` +
      `esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(received)}`
    );
    this.name     = 'GroundingViolationError';
    this.field    = field;
    this.expected = expected;
    this.received = received;
  }
}

class DataInjectionError extends Error {
  constructor(campo, motivo) {
    super(`[DATA_INJECTION] campo "${campo}": ${motivo}`);
    this.name  = 'DataInjectionError';
    this.campo = campo;
    this.motivo = motivo;
  }
}

// ── G1: Facts ─────────────────────────────────────────────────────────────────

/**
 * Extrai o conjunto canônico de fatos factuais de um cliente.
 * Este é o único conjunto de valores que a IA pode referenciar em claims.
 *
 * Valores em centavos (inteiros) para evitar drift de float.
 * null explícito significa "dado não disponível" — diferente de zero.
 *
 * @param {Object} perfil        — Perfil360
 * @param {Object} [score]       — resultado de calcularScore()
 * @param {Object} [tendencia]   — resultado de calcularTendencia()
 * @param {Object} [recorrencia] — resultado de calcularRecorrencia()
 * @param {Object} [opcoes]      — { oportunidade, prioridade }
 * @returns {Object} — facts imutáveis
 */
function buildGroundingFacts(perfil, score = null, tendencia = null, recorrencia = null, opcoes = {}) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('buildGroundingFacts: perfil inválido');
  }

  // Converte para centavos (inteiros) para comparação sem drift de float.
  // null permanece null — não inventar zero.
  const toCents = (v) => (v === null || v === undefined) ? null : Math.round(Number(v) * 100);

  // Produtos e categorias: somente IDs/nomes conhecidos — usados para validar claims de texto
  const produtosIds       = Array.isArray(perfil.produtosComprados)
    ? perfil.produtosComprados.map(p => String(p.produtoId || p.id || '')).filter(Boolean)
    : [];
  const categoriasIds     = Array.isArray(perfil.categorias)
    ? perfil.categorias.map(c => String(c.categoriaId || c.id || c || '')).filter(Boolean)
    : [];

  // Oportunidade determinística (opcional)
  const oport = opcoes.oportunidade || null;

  return Object.freeze({
    // ── Identidade ──────────────────────────────────────────────────────────
    clienteMr4Id:      perfil.clienteMr4Id   ?? null,
    gestaoClickId:     perfil.gestaoClickId  ?? null,
    nuncaComprou:      perfil.nuncaComprou   ?? true,
    inativo120d:       perfil.inativo120d    ?? false,

    // ── Temporal ────────────────────────────────────────────────────────────
    ultimaCompraEm:    perfil.ultimaCompraEm ?? null,
    primeiraCompraEm:  perfil.primeiraCompraEm ?? null,
    diasSemComprar:    (perfil.nuncaComprou ? null : (perfil.diasSemComprar ?? null)),
    dataReferencia:    perfil.dataReferencia ?? null,

    // ── Faturamento (centavos) ───────────────────────────────────────────────
    faturamentoTotalCents:  toCents(perfil.faturamentoTotal),
    faturamento30dCents:    toCents(perfil.faturamento30d),
    faturamento60dCents:    toCents(perfil.faturamento60d),
    faturamento90dCents:    toCents(perfil.faturamento90d),
    faturamento180dCents:   toCents(perfil.faturamento180d),

    // ── Contagens ────────────────────────────────────────────────────────────
    pedidosTotal:   perfil.pedidosTotal  ?? (perfil.nuncaComprou ? 0 : null),
    pedidos30d:     perfil.pedidos30d    ?? 0,
    pedidos60d:     perfil.pedidos60d    ?? 0,
    pedidos90d:     perfil.pedidos90d    ?? 0,
    pedidos180d:    perfil.pedidos180d   ?? 0,

    // ── Intervalos ───────────────────────────────────────────────────────────
    diasEntreComprasMedio:   perfil.diasEntreComprasMedio   ?? null,
    diasEntreComprasMediana: perfil.diasEntreComprasMediana ?? null,
    ticketMedioCents:        toCents(perfil.ticketMedio),

    // ── Score (calculado pelos engines — não é fato bruto do perfil) ─────────
    scoreTotal:       score?.scoreTotal    ?? null,
    classificacao:    score?.classificacao ?? null,
    statusConfig:     score?.statusConfig  ?? 'PROVISIONAL',

    // ── Tendência ────────────────────────────────────────────────────────────
    tendencia:        tendencia?.tendencia ?? null,

    // ── Recorrência ──────────────────────────────────────────────────────────
    recorrenciaStatus: recorrencia?.status ?? null,

    // ── Oportunidade (determinística — não alterável pela IA) ────────────────
    oportunidadeTipo:      oport?.tipo      ?? null,
    oportunidadePrioridade: oport?.prioridade ?? null,

    // ── Catálogo (arrays de IDs/nomes conhecidos — para validar claims de texto)
    produtosIds,
    categoriasIds,

    // ── Metadado do grounding ────────────────────────────────────────────────
    _versaoGrounding: VERSAO_GROUNDING,
    _buildEm:         new Date().toISOString(),
  });
}

// ── G1: Validação de claims ───────────────────────────────────────────────────

/**
 * Valida um array de claims estruturados contra os facts do cliente.
 *
 * Cada claim tem formato: { field: string, value: any }
 *   - field: chave do facts object
 *   - value: valor que a IA afirma
 *
 * Regras:
 *   - claim.field deve existir em facts
 *   - claim.value deve ser estritamente igual a facts[field]
 *   - null no facts → o field existe mas não tem dado → IA não pode afirmar valor
 *   - nuncaComprou=true → diasSemComprar=null → claim de diasSemComprar é inválido
 *
 * @param {Object[]} claims — [{ field, value }, ...]
 * @param {Object}   facts  — resultado de buildGroundingFacts()
 * @throws {GroundingViolationError} se qualquer claim for inválido
 * @returns {Object[]} claims validados
 */
function validarClaims(claims, facts) {
  if (!Array.isArray(claims)) {
    throw new Error('validarClaims: claims deve ser array');
  }
  if (!facts || typeof facts !== 'object') {
    throw new Error('validarClaims: facts inválido');
  }

  for (const claim of claims) {
    const { field, value } = claim;

    // Campo deve existir nos facts
    if (!(field in facts)) {
      throw new GroundingViolationError(field, '(campo existente em facts)', '(campo desconhecido)');
    }

    // Campos internos do grounding não podem ser afirmados pela IA
    if (field.startsWith('_')) {
      throw new GroundingViolationError(field, '(campo não afirmável)', value);
    }

    const expected = facts[field];

    // null no facts = dado não disponível — IA não pode inventar valor
    if (expected === null && value !== null) {
      throw new GroundingViolationError(field, null, value);
    }

    // Comparação estrita
    if (expected !== null && value !== expected) {
      throw new GroundingViolationError(field, expected, value);
    }
  }

  return claims;
}

// ── Padrões numéricos/datas em texto livre ────────────────────────────────────
// Detecta valores monetários, percentuais e datas no texto da IA para cross-check.
const REGEX_MONETARIO   = /R\$\s*[\d.,]+/gi;
const REGEX_PERCENTUAL  = /\d+[\.,]?\d*\s*%/g;
const REGEX_DATA_BR     = /\d{2}\/\d{2}\/\d{4}/g;
const REGEX_DATA_ISO    = /\d{4}-\d{2}-\d{2}/g;
const REGEX_DIAS        = /\b(\d+)\s+dias?\b/gi;

class TextFactViolationError extends Error {
  constructor(tipo, valorEncontrado) {
    super(`[TEXT_FACT] afirmação factual sem claim correspondente: ${tipo} "${valorEncontrado}"`);
    this.name = 'TextFactViolationError';
    this.tipo = tipo;
    this.valorEncontrado = valorEncontrado;
  }
}

/**
 * Valida que valores factuais no texto livre da IA têm claims estruturados correspondentes.
 *
 * Estratégia conservadora: bloqueia quando há dúvida.
 *   - Valores monetários no texto → exige claim faturamento*Cents correspondente
 *   - Percentuais → permitidos (contexto de score é aceito)
 *   - Datas ISO (YYYY-MM-DD) no texto → exige claim de data correspondente
 *   - "N dias" no texto → se N > 0 e não há claim diasSemComprar/diasEntre* → bloqueia
 *     exceto se N coincide com algum valor já em facts
 *
 * @param {string} texto   — conteúdo textual do output da IA
 * @param {Object} claims  — claims estruturados já validados
 * @param {Object} facts   — resultado de buildGroundingFacts()
 * @throws {TextFactViolationError} se valor factual sem claim for detectado
 */
function validarFatosNoTexto(texto, claims, facts) {
  if (typeof texto !== 'string') return;

  // Conjunto de campos com claim aprovado
  const camposComClaim = new Set((claims || []).map(c => c.field));

  // ── Valores monetários ────────────────────────────────────────────────────
  const monetarios = texto.match(REGEX_MONETARIO) || [];
  for (const m of monetarios) {
    // Se nenhum claim de faturamento está presente, bloqueia
    const temClaimFaturamento = [...camposComClaim].some(f => f.startsWith('faturamento') || f === 'ticketMedioCents');
    if (!temClaimFaturamento) {
      throw new TextFactViolationError('MONETARIO', m);
    }
  }

  // ── Datas ISO no texto ────────────────────────────────────────────────────
  const datasISO = texto.match(REGEX_DATA_ISO) || [];
  for (const d of datasISO) {
    const temClaimData = [...camposComClaim].some(f =>
      f === 'ultimaCompraEm' || f === 'primeiraCompraEm' || f === 'dataReferencia'
    );
    if (!temClaimData) {
      throw new TextFactViolationError('DATA_ISO', d);
    }
  }

  // ── "N dias" no texto ─────────────────────────────────────────────────────
  const diasMatches = [...texto.matchAll(REGEX_DIAS)];
  for (const match of diasMatches) {
    const n = parseInt(match[1], 10);
    if (n <= 0) continue;
    // Verificar se n coincide com algum valor em facts relacionado a dias
    const diasFacts = [
      facts.diasSemComprar,
      facts.diasEntreComprasMedio,
      facts.diasEntreComprasMediana,
    ].filter(v => v !== null);
    const coincide = diasFacts.some(v => v === n);
    if (!coincide && !camposComClaim.has('diasSemComprar') &&
        !camposComClaim.has('diasEntreComprasMedio') &&
        !camposComClaim.has('diasEntreComprasMediana')) {
      throw new TextFactViolationError('DIAS', String(n));
    }
  }
}

/**
 * Valida um output estruturado de agente que usa claims.
 *
 * A partir de grounding-v2, claims são OBRIGATÓRIOS para outputs factuais.
 * OUTPUT_SEM_CLAIMS = BLOCK (não mais aviso).
 *
 * @param {Object} output           — output do agente
 * @param {Object} facts            — resultado de buildGroundingFacts()
 * @param {Object} [opcoes]         — { permitirSemClaims: boolean } — somente para MockProvider
 * @returns {Object}                — output com metadado de grounding
 */
function validarOutputComGrounding(output, facts, opcoes = {}) {
  if (!output || typeof output !== 'object') {
    throw new Error('validarOutputComGrounding: output inválido');
  }
  if (!facts || typeof facts !== 'object') {
    throw new Error('validarOutputComGrounding: facts inválido');
  }

  const claimsValidados = [];

  if (Array.isArray(output.claims) && output.claims.length > 0) {
    validarClaims(output.claims, facts);
    claimsValidados.push(...output.claims);
    // Validação cruzada: fatos no texto devem ter claims
    if (typeof output.conteudo === 'string') {
      validarFatosNoTexto(output.conteudo, claimsValidados, facts);
    }
  } else {
    // OUTPUT_SEM_CLAIMS: BLOCK a menos que explicitamente permitido (MockProvider)
    if (!opcoes.permitirSemClaims) {
      throw new GroundingViolationError(
        'claims',
        '(array de claims estruturados obrigatório)',
        '(ausente ou vazio)'
      );
    }
  }

  return {
    ...output,
    _grounding: {
      validadoEm:      new Date().toISOString(),
      versao:          VERSAO_GROUNDING,
      claimsValidados: claimsValidados.length,
      factsClienteId:  facts.clienteMr4Id,
    },
  };
}

// ── G2: Sanitização de dados para prompt ──────────────────────────────────────

/**
 * Trata um dado como DADO, não como instrução.
 *
 * Não destrói o dado — apenas sinaliza e envolve em delimitadores para
 * que o prompt trate como conteúdo de dados, não como instrução do sistema.
 *
 * @param {*}      valor  — valor do campo de dados
 * @param {string} campo  — nome do campo (para log)
 * @returns {{ valor: string, suspeito: boolean, motivo: string|null }}
 */
function sanitizarDadoParaPrompt(valor, campo = 'desconhecido') {
  const texto = String(valor ?? '');

  for (const padrao of PADROES_INSTRUCAO_EM_DADOS) {
    if (padrao.test(texto)) {
      return {
        valor:    `[DADO:${campo}]`,  // reduz para placeholder — não expõe instrução
        suspeito: true,
        motivo:   `padrão de instrução detectado em campo de dado: ${padrao}`,
      };
    }
  }

  return { valor: texto, suspeito: false, motivo: null };
}

/**
 * Prepara o contexto completo para envio ao prompt, sanitizando campos de dados.
 *
 * Campos estruturados (números, datas, flags) não são sanitizados — vêm dos facts.
 * Campos de texto livre (nome_grupo, observacoes) são sanitizados.
 *
 * @param {Object} contextoRaw  — contexto montado pelo agente
 * @param {Object} facts        — facts gerados por buildGroundingFacts()
 * @returns {{ contextoSanitizado, suspeitos: string[] }}
 */
function prepararContextoParaPrompt(contextoRaw, facts) {
  const suspeitos = [];
  const contextoSanitizado = {};

  for (const [campo, valor] of Object.entries(contextoRaw)) {
    // Campos presentes nos facts são estruturados — não sanitizar texto livre
    if (campo in facts) {
      contextoSanitizado[campo] = valor;
      continue;
    }

    // Campos de texto livre passam pela sanitização
    if (typeof valor === 'string') {
      const { valor: valorSanitizado, suspeito, motivo } = sanitizarDadoParaPrompt(valor, campo);
      contextoSanitizado[campo] = valorSanitizado;
      if (suspeito) suspeitos.push(`${campo}: ${motivo}`);
    } else if (Array.isArray(valor)) {
      // Arrays (ex: oportunidades[]) — sanitizar cada string elemento
      contextoSanitizado[campo] = valor.map((item, idx) => {
        if (typeof item === 'string') {
          const { valor: v, suspeito: s, motivo: m } = sanitizarDadoParaPrompt(item, `${campo}[${idx}]`);
          if (s) suspeitos.push(`${campo}[${idx}]: ${m}`);
          return v;
        }
        return item;
      });
    } else {
      contextoSanitizado[campo] = valor;
    }
  }

  return { contextoSanitizado, suspeitos };
}

module.exports = {
  VERSAO_GROUNDING,
  GroundingViolationError,
  DataInjectionError,
  TextFactViolationError,
  buildGroundingFacts,
  validarClaims,
  validarOutputComGrounding,
  validarFatosNoTexto,
  sanitizarDadoParaPrompt,
  prepararContextoParaPrompt,
  // Exposto para testes
  PADROES_INSTRUCAO_EM_DADOS,
};
