'use strict';
/**
 * B2 — histórico v2 (carteira_comercial_historico). APPEND-ONLY. Os 367 eventos v1 (CARTEIRA_CRIADA) NÃO são reescritos:
 * leitores usam `normalizarEvento`, que lê v1 e v2. Idempotência: docId derivado da chave + create().
 */
const crypto = require('crypto');
const V1 = require('./carteiraV1');

const SCHEMA_HIST_V2 = 'historico-v2';
const TIPOS_V2 = Object.freeze([...V1.TIPOS_EVENTO, 'MIGRATED_BASELINE', 'RENOVACAO_CICLO', 'LIBERACAO', 'REVERSAO_TRANSFERENCIA', 'CONFLITO_ABERTO', 'CONFLITO_RESOLVIDO']);
const TIPOS_QUE_MUDAM_OWNER = Object.freeze(['CARTEIRA_CRIADA', 'CARTEIRA_CRIADA_PRIMEIRA_VENDA', 'CARTEIRA_CRIADA_REATIVACAO', 'TRANSFERENCIA', 'REATIVACAO_120D_PRIMEIRA_VENDA', 'CORRECAO_ADMINISTRATIVA', 'LIBERACAO', 'REVERSAO_TRANSFERENCIA']);
const ORIGENS_OPERACAO = Object.freeze(['CALLABLE', 'JOB', 'MIGRACAO']);
const ATORES = Object.freeze(['USER', 'SYSTEM']);
const ANCORA_RE = /^GC:\d{1,20}$/;

const idDeChave = chave => 'ev_' + crypto.createHash('sha1').update(String(chave)).digest('hex').slice(0, 32);

function montarEventoHistoricoV2(p) {
  if (!TIPOS_V2.includes(p.tipoEvento)) throw new Error('tipoEvento inválido: ' + p.tipoEvento);
  if (!ANCORA_RE.test(String(p.portfolioId || ''))) throw new Error('portfolioId inválido');
  if (!p.chaveIdempotencia) throw new Error('chaveIdempotencia obrigatória');
  if (!ORIGENS_OPERACAO.includes(p.origemOperacao)) throw new Error('origemOperacao inválida');
  if (!ATORES.includes(p.atorTipo)) throw new Error('atorTipo inválido');
  if (!Number.isInteger(p.versaoCarteiraAntes) && p.versaoCarteiraAntes !== null) throw new Error('versaoCarteiraAntes inválida');
  if (!Number.isInteger(p.versaoCarteiraDepois) || p.versaoCarteiraDepois < 1) throw new Error('versaoCarteiraDepois inválida');
  const muda = TIPOS_QUE_MUDAM_OWNER.includes(p.tipoEvento);
  if (!muda && (p.ownerAnteriorUid || null) !== (p.ownerNovoUid || null)) throw new Error('evento ' + p.tipoEvento + ' não pode alterar owner');
  return {
    schemaVersion: SCHEMA_HIST_V2, portfolioId: p.portfolioId, identidadeUsada: p.identidadeUsada || null, tipoEvento: p.tipoEvento,
    ownerAnteriorUid: p.ownerAnteriorUid || null, ownerNovoUid: p.ownerNovoUid || null, motivo: p.motivo || null, motivoCodigo: p.motivoCodigo || null,
    operadorUid: p.operadorUid || null, atorTipo: p.atorTipo, origemOperacao: p.origemOperacao, criadoEm: p.criadoEm,
    versao: p.versaoCarteiraDepois, versaoCarteiraAntes: p.versaoCarteiraAntes === undefined ? null : p.versaoCarteiraAntes, versaoCarteiraDepois: p.versaoCarteiraDepois,
    seq: p.seq, referencias: p.referencias || null, chaveIdempotencia: p.chaveIdempotencia,
  };
}
/** Leitura compatível v1/v2 → forma única. */
function normalizarEvento(h) {
  if (!h) return null;
  return { schema: h.schemaVersion || 'historico-v1', portfolioId: h.portfolioId, tipoEvento: h.tipoEvento, ownerAnteriorUid: h.ownerAnteriorUid || null, ownerNovoUid: h.ownerNovoUid || null,
    motivo: h.motivo || null, ator: h.operadorUid || null, atorTipo: h.atorTipo || null, origemOperacao: h.origemOperacao || (String(h.chaveIdempotencia || '').startsWith('MIGRACAO:') ? 'MIGRACAO' : null),
    criadoEm: h.criadoEm, versaoDepois: h.versaoCarteiraDepois ?? h.versao ?? null, versaoAntes: h.versaoCarteiraAntes ?? null, seq: h.seq ?? null, chaveIdempotencia: h.chaveIdempotencia || null };
}
module.exports = { SCHEMA_HIST_V2, TIPOS_V2, TIPOS_QUE_MUDAM_OWNER, idDeChave, montarEventoHistoricoV2, normalizarEvento };
