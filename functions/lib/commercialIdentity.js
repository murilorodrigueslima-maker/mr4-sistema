'use strict';
// N35.8 — Contrato de Identidade Comercial Híbrida
// Fonte de verdade para identidade de MR4_LINKED e GC_NATIVE.
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   PROD_WRITES=0
//   Funções puras — sem I/O, sem side effects

const crypto = require('crypto');

// ── Tipos de source ─────────────────────────────────────────────────────────────

const SOURCES = Object.freeze({
  MR4_LINKED: 'MR4_LINKED',
  GC_NATIVE:  'GC_NATIVE',
});

// ── commercialEntityId ─────────────────────────────────────────────────────────
//
// Identidade canônica para fins de estado operacional.
// Composta por source + stableId para evitar colisão entre os dois namespaces.
//
// MR4_LINKED: "MR4_LINKED:{mr4ClientId}"   — base62, 20 chars
// GC_NATIVE:  "GC_NATIVE:{gestaoClickId}"  — inteiro numérico, 5-9 dígitos
//
// A colisão entre namespaces é estruturalmente impossível:
//   MR4 IDs são base62 ≥ 20 chars; GC IDs são inteiros de ≤ 9 dígitos.
//   O prefixo torna isso explícito e auditável.
//
// NUNCA usar clienteMr4Id diretamente como chave para GC_NATIVE:
//   para GC_NATIVE, clienteMr4Id = gestaoClickId (aliás no pipeline),
//   mas o nome é semanticamente enganoso. Aqui usamos gestaoClickId explicitamente.

/**
 * Constrói o commercialEntityId canônico.
 *
 * @param {object} params
 * @param {'MR4_LINKED'|'GC_NATIVE'} params.source  — origem da identidade
 * @param {string} params.mr4ClientId                — ID do doc clientes/ (MR4_LINKED somente)
 * @param {string} params.gestaoClickId              — ID numérico no GestãoClick
 * @returns {string}  — ex.: "MR4_LINKED:abc123..." ou "GC_NATIVE:31349459"
 */
function buildCommercialEntityId({ source, mr4ClientId, gestaoClickId }) {
  if (!source || !SOURCES[source]) {
    throw new Error(`buildCommercialEntityId: source inválido: ${JSON.stringify(source)}`);
  }

  if (source === SOURCES.MR4_LINKED) {
    if (!mr4ClientId || typeof mr4ClientId !== 'string' || mr4ClientId.trim() === '') {
      throw new Error('buildCommercialEntityId: mr4ClientId obrigatório para MR4_LINKED');
    }
    // Rejeita gestaoClickId como mr4ClientId (inteiro numérico puro = identidade errada)
    if (/^\d+$/.test(mr4ClientId.trim())) {
      throw new Error(
        `buildCommercialEntityId: mr4ClientId parece gestaoClickId (somente dígitos: ${mr4ClientId}). ` +
        'Use source="GC_NATIVE" para clientes GestãoClick sem documento MR4.'
      );
    }
    return `MR4_LINKED:${mr4ClientId.trim()}`;
  }

  // GC_NATIVE
  if (!gestaoClickId || typeof gestaoClickId !== 'string' || gestaoClickId.trim() === '') {
    throw new Error('buildCommercialEntityId: gestaoClickId obrigatório para GC_NATIVE');
  }
  if (!/^\d+$/.test(gestaoClickId.trim())) {
    throw new Error(
      `buildCommercialEntityId: gestaoClickId deve ser inteiro numérico, recebido: ${gestaoClickId}`
    );
  }
  return `GC_NATIVE:${gestaoClickId.trim()}`;
}

/**
 * Extrai source e stableId de um commercialEntityId.
 * @param {string} commercialEntityId
 * @returns {{ source: string, stableId: string }}
 */
function parseCommercialEntityId(commercialEntityId) {
  if (typeof commercialEntityId !== 'string') {
    throw new Error('parseCommercialEntityId: commercialEntityId deve ser string');
  }
  const sep = commercialEntityId.indexOf(':');
  if (sep < 0) throw new Error(`parseCommercialEntityId: formato inválido: ${commercialEntityId}`);
  const source  = commercialEntityId.slice(0, sep);
  const stableId = commercialEntityId.slice(sep + 1);
  if (!SOURCES[source]) throw new Error(`parseCommercialEntityId: source desconhecido: ${source}`);
  if (!stableId) throw new Error(`parseCommercialEntityId: stableId vazio: ${commercialEntityId}`);
  return { source, stableId };
}

// ── Derivação a partir de Perfil360 ───────────────────────────────────────────

/**
 * Constrói o commercialEntityId a partir de um documento perfis_360.
 * Lida com MR4_LINKED e GC_NATIVE usando os campos presentes.
 *
 * @param {object} perfil360 — documento gravado em perfis_360/
 * @returns {string} commercialEntityId canônico
 */
function commercialEntityIdFromPerfil360(perfil360) {
  if (!perfil360 || typeof perfil360 !== 'object') {
    throw new Error('commercialEntityIdFromPerfil360: perfil360 inválido');
  }

  const source = perfil360.source;
  const gcId   = perfil360.gestaoClickId;
  const cid    = perfil360.clienteMr4Id;

  if (source === SOURCES.GC_NATIVE) {
    // GC_NATIVE: gestaoClickId é a identidade real
    if (!gcId) throw new Error(`commercialEntityIdFromPerfil360: GC_NATIVE sem gestaoClickId (clienteMr4Id=${cid})`);
    return buildCommercialEntityId({ source: SOURCES.GC_NATIVE, gestaoClickId: String(gcId) });
  }

  // MR4_LINKED (ou sem source = legado MR4_LINKED)
  if (!cid) throw new Error('commercialEntityIdFromPerfil360: MR4_LINKED sem clienteMr4Id');
  return buildCommercialEntityId({
    source:       SOURCES.MR4_LINKED,
    mr4ClientId:  String(cid),
    gestaoClickId: gcId ? String(gcId) : undefined,
  });
}

// ── opportunityInstanceId ─────────────────────────────────────────────────────
//
// Identifica UMA instância de oportunidade — estável dentro do mesmo ciclo
// comercial, mas diferente quando o ciclo muda (cliente comprou e inativou de novo).
//
// Âncora: ultimaCompraEm do perfil.
//   - Muda somente quando o cliente comprar (nova venda → novo anchorDate → novo instanceId).
//   - Independente de dataReferencia, horário de execução ou schedulerId.
//   - Para PROSPECT_VINCULADO (nuncaComprou=true): anchor = "NUNCA" (constante).
//
// A mudança de tipoOportunidade também gera novo instanceId
// (ex.: JANELA_DE_RECOMPRA → REATIVACAO_120D).

const ANCHOR_NUNCA = 'NUNCA_COMPROU';

/**
 * Gera o opportunityInstanceId determinístico para uma instância de oportunidade.
 *
 * @param {string} commercialEntityId   — ex.: "MR4_LINKED:abc123..."
 * @param {string} tipoOportunidade     — ex.: "REATIVACAO_120D"
 * @param {string|null} ultimaCompraEm  — YYYY-MM-DD; null para nuncaComprou
 * @returns {string}                    — 16 hex chars
 */
function buildOpportunityInstanceId(commercialEntityId, tipoOportunidade, ultimaCompraEm) {
  if (!commercialEntityId || typeof commercialEntityId !== 'string') {
    throw new Error('buildOpportunityInstanceId: commercialEntityId inválido');
  }
  if (!tipoOportunidade || typeof tipoOportunidade !== 'string') {
    throw new Error('buildOpportunityInstanceId: tipoOportunidade inválido');
  }

  const anchor = ultimaCompraEm
    ? String(ultimaCompraEm).slice(0, 10)
    : ANCHOR_NUNCA;

  const base = `${commercialEntityId}|${tipoOportunidade}|${anchor}`;
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 16);
}

// ── Validação de identidade ────────────────────────────────────────────────────

/**
 * Valida que um perfil360 possui identidade canônica completa e não-nula.
 * Retorna objeto com campos de diagnóstico.
 *
 * @param {object} perfil360
 * @returns {{ valid: boolean, commercialEntityId: string|null, error: string|null }}
 */
function validateIdentity(perfil360) {
  try {
    const id = commercialEntityIdFromPerfil360(perfil360);
    return { valid: true, commercialEntityId: id, error: null };
  } catch (err) {
    return { valid: false, commercialEntityId: null, error: err.message };
  }
}

// ── N35.25.1: âncora ESTÁVEL da carteira comercial ────────────────────────────
//
// O commercialEntityId da fila MUDA quando um cliente GC é vinculado ao MR4:
//   GC_NATIVE:<gcId>  →  MR4_LINKED:<mr4Id>   (worklistUniverso passa a pular o gcId vinculado)
// A carteira NÃO pode depender dessa chave. O único ID técnico presente nas duas formas e que nunca muda
// é o ID do cliente no GestãoClick (gcId): direto em GC_NATIVE; em MR4_LINKED via clientes/{mr4Id}.gestaoClickId.
// Âncora da carteira = "GC:<gcId>". Resolução centralizada AQUI (nenhum outro módulo interpreta prefixos).
// Sem PII: só IDs técnicos. MR4 sem vínculo GC → não resolve (falha fechada: sem carteira, nunca "carteira nova").

const PORTFOLIO_ANCHOR_PREFIX = 'GC:';
const PORTFOLIO_ANCHOR_RE = /^GC:\d{1,20}$/;

/** Normaliza gestaoClickId (nos cadastros aparece como número OU string) → string de dígitos ou null. */
function normalizeGestaoClickId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^\d{1,20}$/.test(s) ? s.replace(/^0+(?=\d)/, '') : null;
}

function portfolioAnchorFromGcId(gcId) {
  const g = normalizeGestaoClickId(gcId);
  if (!g) throw new Error('portfolioAnchorFromGcId: gcId inválido');
  return PORTFOLIO_ANCHOR_PREFIX + g;
}

/**
 * Resolve qualquer commercialEntityId para a âncora estável da carteira.
 * @param {string} commercialEntityId
 * @param {{ gcIdForMr4: (mr4Id:string) => (string|number|null) }} links — vínculo MR4→GC (clientes/{mr4Id}.gestaoClickId)
 * @returns {{ status:'RESOLVED', anchorId, gcId, source, mr4Id } | { status:'UNRESOLVED', reason, source?, mr4Id? }}
 */
function resolvePortfolioAnchor(commercialEntityId, links) {
  let parsed;
  try { parsed = parseCommercialEntityId(commercialEntityId); } catch (e) { return { status: 'UNRESOLVED', reason: 'ID_INVALIDO' }; }
  if (parsed.source === SOURCES.GC_NATIVE) {
    const gcId = normalizeGestaoClickId(parsed.stableId);
    if (!gcId) return { status: 'UNRESOLVED', reason: 'ID_INVALIDO', source: parsed.source };
    return { status: 'RESOLVED', anchorId: PORTFOLIO_ANCHOR_PREFIX + gcId, gcId, source: parsed.source, mr4Id: null };
  }
  const mr4Id = parsed.stableId;
  const raw = links && typeof links.gcIdForMr4 === 'function' ? links.gcIdForMr4(mr4Id) : undefined;
  const gcId = normalizeGestaoClickId(raw);
  if (!gcId) return { status: 'UNRESOLVED', reason: raw === undefined ? 'VINCULO_DESCONHECIDO' : 'MR4_SEM_VINCULO_GC', source: parsed.source, mr4Id };
  return { status: 'RESOLVED', anchorId: PORTFOLIO_ANCHOR_PREFIX + gcId, gcId, source: parsed.source, mr4Id };
}

/** Identidades conhecidas (derivadas, NÃO armazenadas) de uma âncora: a atual da fila e os aliases técnicos. */
function knownIdentitiesForGc(gcId, mr4Ids) {
  const g = normalizeGestaoClickId(gcId);
  const list = (mr4Ids || []).filter(Boolean).map(String).sort();
  const aliases = [buildCommercialEntityId({ source: SOURCES.GC_NATIVE, gestaoClickId: g }), ...list.map(m => buildCommercialEntityId({ source: SOURCES.MR4_LINKED, mr4ClientId: m }))];
  return { anchorId: PORTFOLIO_ANCHOR_PREFIX + g, current: list.length === 1 ? aliases[1] : aliases[0], aliases, ambiguous: list.length > 1 };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  SOURCES,
  ANCHOR_NUNCA,
  buildCommercialEntityId,
  parseCommercialEntityId,
  commercialEntityIdFromPerfil360,
  buildOpportunityInstanceId,
  validateIdentity,
  // N35.25.1
  PORTFOLIO_ANCHOR_PREFIX,
  PORTFOLIO_ANCHOR_RE,
  normalizeGestaoClickId,
  portfolioAnchorFromGcId,
  resolvePortfolioAnchor,
  knownIdentitiesForGc,
};
