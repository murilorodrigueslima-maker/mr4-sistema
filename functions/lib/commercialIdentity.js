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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  SOURCES,
  ANCHOR_NUNCA,
  buildCommercialEntityId,
  parseCommercialEntityId,
  commercialEntityIdFromPerfil360,
  buildOpportunityInstanceId,
  validateIdentity,
};
