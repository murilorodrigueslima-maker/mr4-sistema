'use strict';
/**
 * B2 — carteira-v2: evolução ADITIVA de carteira-v1 (carteira_comercial/GC:<id>). Nada de PII no documento.
 * v1 → v2 NÃO toca ownerUid / ownerDesde / origemComercial* / criadoEm / atualizadoEm (decisão comercial preservada).
 * Compatibilidade: leitores v1 só usam ownerUid/portfolioId (continuam funcionando); validarDocCarteiraV1 só é usado na CRIAÇÃO v1.
 */
const crypto = require('crypto');
const V1 = require('./carteiraV1');

const SCHEMA_V2 = 'carteira-v2';
const SCHEMA_V1 = V1.SCHEMA;
const ANCORA_RE = /^GC:\d{1,20}$/;
const STATUS = Object.freeze(['ATIVA', 'EM_REVISAO', 'LIBERADA']);
const ORIGENS = Object.freeze(['MIGRACAO_ONDA1_N3526', 'PRIMEIRA_VENDA', 'REATIVACAO_120D', 'TRANSFERENCIA_ADMIN']);
const TIPOS_CONFLITO = Object.freeze(['DOC_IGUAL', 'TELEFONE_IGUAL', 'EMAIL_IGUAL']);
const FORCAS = Object.freeze(['FORTE', 'MEDIA', 'FRACA']);
// Campos de ownership que o backfill NUNCA pode alterar (impressão digital de ownership)
const CAMPOS_OWNERSHIP = Object.freeze(['portfolioId', 'ownerUid', 'ownerDesde', 'origemComercialUid', 'origemComercialGestaoClickId', 'criadoEm', 'atualizadoEm']);
// Campos acrescentados pelo backfill (além de schemaVersion e versao)
const CAMPOS_ADITIVOS = Object.freeze(['status', 'origem', 'cicloAncoraEm', 'clienteMr4Id', 'conflito', 'ultimoEventoId', 'schemaMigradoDe', 'v2MigradoEm', 'v2LoteId']);
const CAMPOS_CARTEIRA_V2 = Object.freeze([...V1.CAMPOS_CARTEIRA, ...CAMPOS_ADITIVOS]);
const CAMPOS_ALTERADOS_BACKFILL = Object.freeze(['schemaVersion', 'versao', ...CAMPOS_ADITIVOS]);
const PROIBIDO = /nome|cpf|cnpj|telefone|email|endereco|faturamento|ticket|margem|lucro|custo|score|ranking|reativacao|diasSemComprar|ultimaCompra|ultimaVenda|predominante/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isoOk = s => typeof s === 'string' && !isNaN(Date.parse(s));

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const grupoIdDe = ids => 'CG-' + sha([...ids].sort().join('|')).slice(0, 12);

function validarConflito(c) {
  if (c === null) return null;
  if (!c || typeof c !== 'object') return 'CONFLITO_FORMATO';
  const permitidos = ['grupoId', 'tipos', 'forca', 'relacionados', 'donosDiferentes', 'revisao', 'revisores', 'detectadoEm', 'origemDeteccao'];
  const extras = Object.keys(c).filter(k => !permitidos.includes(k)); if (extras.length) return 'CONFLITO_CAMPOS:' + extras.join(',');
  if (!/^CG-[0-9a-f]{12}$/.test(String(c.grupoId))) return 'CONFLITO_GRUPO';
  if (!Array.isArray(c.tipos) || !c.tipos.length || !c.tipos.every(t => TIPOS_CONFLITO.includes(t))) return 'CONFLITO_TIPOS';
  if (!FORCAS.includes(c.forca)) return 'CONFLITO_FORCA';
  if (!Array.isArray(c.relacionados) || !c.relacionados.every(r => ANCORA_RE.test(r))) return 'CONFLITO_RELACIONADOS';
  if (typeof c.donosDiferentes !== 'boolean') return 'CONFLITO_DONOS';
  if (!['PENDENTE', 'RESOLVIDO'].includes(c.revisao)) return 'CONFLITO_REVISAO';
  if (!Array.isArray(c.revisores) || !c.revisores.every(r => ['PROPRIETARIO', 'CAMILA'].includes(r))) return 'CONFLITO_REVISORES';
  return null;
}

/** Valida documento v2 (whitelist de campos, sem PII, invariantes de ownership/status/conflito). */
function validarDocCarteiraV2(d) {
  if (!d || typeof d !== 'object') return 'DOC_INVALIDO';
  const extras = Object.keys(d).filter(k => !CAMPOS_CARTEIRA_V2.includes(k)); if (extras.length) return 'CAMPOS_NAO_PERMITIDOS:' + extras.join(',');
  const prib = Object.keys(d).filter(k => PROIBIDO.test(k)); if (prib.length) return 'CAMPO_PROIBIDO:' + prib.join(',');
  if (d.schemaVersion !== SCHEMA_V2) return 'SCHEMA';
  if (!ANCORA_RE.test(String(d.portfolioId))) return 'ANCORA_INVALIDA';
  if (!Number.isInteger(d.versao) || d.versao < 1) return 'VERSAO';
  if (!STATUS.includes(d.status)) return 'STATUS';
  if (!ORIGENS.includes(d.origem)) return 'ORIGEM';
  if (d.cicloAncoraEm !== null && d.cicloAncoraEm !== undefined && !YMD.test(String(d.cicloAncoraEm))) return 'CICLO';
  if (d.status === 'LIBERADA' ? d.ownerUid : !d.ownerUid) return 'OWNER_X_STATUS';
  if (d.ownerUid && !isoOk(d.ownerDesde)) return 'OWNER_DESDE';
  if (d.status === 'EM_REVISAO' && !(d.conflito && d.conflito.revisao === 'PENDENTE')) return 'REVISAO_SEM_CONFLITO';
  const ec = validarConflito(d.conflito === undefined ? null : d.conflito); if (ec) return ec;
  if (d.clienteMr4Id !== null && d.clienteMr4Id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(String(d.clienteMr4Id))) return 'CLIENTE_MR4';
  return null;
}

/** Impressão digital de ownership (só campos que a B2 jamais pode mudar). */
function linhaOwnership(d) { return CAMPOS_OWNERSHIP.map(k => (d && d[k] !== undefined && d[k] !== null ? String(d[k]) : '∅')).join('|'); }
function impressaoOwnership(docsPorId) {
  const ids = Object.keys(docsPorId).sort();
  return sha(ids.map(i => i + '=' + linhaOwnership(docsPorId[i])).join('\n'));
}
function contagemPorOwner(docsPorId, nomesPorUid = {}) {
  const c = {}; for (const d of Object.values(docsPorId)) { const k = nomesPorUid[d.ownerUid] || d.ownerUid || 'SEM_OWNER'; c[k] = (c[k] || 0) + 1; } return c;
}

/**
 * Patch ADITIVO v1→v2. Retorna { patch, depois } — `patch` contém SOMENTE os campos de CAMPOS_ALTERADOS_BACKFILL.
 * ctx: { eventoInicialId, clienteMr4Id|null, conflito|null, loteId, agoraIso }
 */
function montarPatchBackfillV2(v1, ctx) {
  if (!v1 || v1.schemaVersion !== SCHEMA_V1) throw new Error('backfill: esperado schemaVersion=carteira-v1 (já migrada ou inválida)');
  if (!ANCORA_RE.test(String(v1.portfolioId))) throw new Error('backfill: âncora inválida');
  if (!v1.ownerUid) throw new Error('backfill: carteira v1 sem owner — fora do escopo (não se cria nem se atribui owner na B2)');
  if (!Number.isInteger(v1.versao) || v1.versao !== 1) throw new Error('backfill: versao v1 inesperada');
  if (!ctx.eventoInicialId) throw new Error('backfill: carteira sem evento inicial — B2 não fabrica evento');
  const conflito = ctx.conflito || null;
  const patch = {
    schemaVersion: SCHEMA_V2, versao: 2,
    status: conflito ? 'EM_REVISAO' : 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null,
    clienteMr4Id: ctx.clienteMr4Id || null, conflito, ultimoEventoId: ctx.eventoInicialId,
    schemaMigradoDe: SCHEMA_V1, v2MigradoEm: ctx.agoraIso, v2LoteId: ctx.loteId,
  };
  const depois = { ...v1, ...patch };
  const e = validarDocCarteiraV2(depois); if (e) throw new Error('backfill: documento v2 inválido: ' + e);
  if (linhaOwnership(v1) !== linhaOwnership(depois)) throw new Error('backfill: ownership alterado — ABORTAR');
  for (const k of Object.keys(patch)) if (!CAMPOS_ALTERADOS_BACKFILL.includes(k)) throw new Error('backfill: campo fora do patch aprovado: ' + k);
  return { patch, depois };
}

/** Leitura compatível v1/v2 (leitores novos). */
function lerCarteira(d) {
  if (!d) return null;
  const v2 = d.schemaVersion === SCHEMA_V2;
  return { portfolioId: d.portfolioId, ownerUid: d.ownerUid || null, ownerDesde: d.ownerDesde || null, versao: d.versao, schema: d.schemaVersion,
    status: v2 ? d.status : (d.ownerUid ? 'ATIVA' : 'LIBERADA'), conflito: v2 ? (d.conflito || null) : null, cicloAncoraEm: v2 ? (d.cicloAncoraEm || null) : null, clienteMr4Id: v2 ? (d.clienteMr4Id || null) : null };
}

module.exports = { SCHEMA_V2, SCHEMA_V1, ANCORA_RE, STATUS, ORIGENS, TIPOS_CONFLITO, FORCAS, CAMPOS_OWNERSHIP, CAMPOS_ADITIVOS, CAMPOS_CARTEIRA_V2, CAMPOS_ALTERADOS_BACKFILL,
  validarDocCarteiraV2, validarConflito, montarPatchBackfillV2, impressaoOwnership, linhaOwnership, contagemPorOwner, lerCarteira, grupoIdDe, sha };
