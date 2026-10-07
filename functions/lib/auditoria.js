'use strict';
/**
 * S7 — Trilha de auditoria de segurança/CRM: coleção `audit_log` (APPEND-ONLY).
 *  • Escrita SOMENTE por Cloud Functions (Admin SDK) via create() — nenhum update/delete no código; Rules negam toda escrita do cliente.
 *  • Autor derivado do servidor: contexto de autenticação do evento Firestore (writes de clientes) ou operadorId gravado pelo
 *    backend (fila). Nunca vem do payload do navegador.
 *  • Idempotente: id determinístico (eventId_índice) + create() → reentrega do gatilho não duplica.
 *  • PII mínima: identificadores (CPF/CNPJ, telefone, e-mail) só como hash truncado; sem notas, sem credenciais.
 *  • Estruturas anteriores reaproveitadas (NÃO duplicadas): carteira_comercial_historico (titularidade), interacoes_fila.eventos
 *    (fila; aqui espelhada em linha imutável), gc_audit (operações GC).
 */
const crypto = require('crypto');

const SCHEMA = 'audit-v1';
const COLECAO = 'audit_log';
const CATEGORIAS = Object.freeze({ SECURITY: 'SECURITY', CRM: 'CRM', COMMERCIAL: 'COMMERCIAL' });
const SEGREDO = /senha|password|token|secret|credential|api[_-]?key/i;

const hashCurto = v => (v === undefined || v === null || v === '' ? null : 'sha256:' + crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex').slice(0, 16));
const igual = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const val = v => (v === undefined ? null : v);
function limpar(o) {                                     // defesa em profundidade: nunca persistir chave com cara de segredo
  if (Array.isArray(o)) return o.map(limpar);
  if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) if (!SEGREDO.test(k)) r[k] = limpar(v); return r; }
  return o === undefined ? null : o;
}
function evento({ ator, action, category, entityType, entityId, source, before = null, after = null, metadata = null }) {
  return limpar({ schemaVersion: SCHEMA, category, action, entityType, entityId: String(entityId), source,
    actorUid: ator.uid || null, actorType: ator.type, actorRole: ator.role || null, actorIsAdmin: ator.admin === undefined ? null : ator.admin, actorOrigin: ator.origin,
    before, after, metadata });
}

// ── Diffs puros (testáveis) ───────────────────────────────────────────────────────
function diffUsers(antes, depois) {
  const out = [];
  if (!antes && depois) return [{ action: 'USER_CREATED', category: CATEGORIAS.SECURITY, before: null, after: { role: val(depois.role), ativo: val(depois.ativo), funcionarioId: val(depois.funcionarioId) } }];
  if (antes && !depois) return [{ action: 'USER_DELETED', category: CATEGORIAS.SECURITY, before: { role: val(antes.role), ativo: val(antes.ativo), funcionarioId: val(antes.funcionarioId) }, after: null }];
  for (const [campo, action] of [['role', 'USER_ROLE_CHANGED'], ['ativo', 'USER_ACTIVE_CHANGED'], ['funcionarioId', 'USER_LINK_CHANGED']])
    if (!igual(antes[campo], depois[campo])) out.push({ action, category: CATEGORIAS.SECURITY, before: { [campo]: val(antes[campo]) }, after: { [campo]: val(depois[campo]) } });
  return out;
}
function diffSistemaUsuarios(antes, depois) {
  const out = [], S = CATEGORIAS.SECURITY;
  const perfil = d => ({ admin: d.admin === true, bloqueado: d.bloqueado === true, modulos: Array.isArray(d.modulos) ? d.modulos.slice().sort() : [], cargo: val(d.cargo) });
  if (!antes && depois) return [{ action: 'ACCESS_PROFILE_CREATED', category: S, before: null, after: perfil(depois) }];
  if (antes && !depois) return [{ action: 'ACCESS_PROFILE_DELETED', category: S, before: perfil(antes), after: null }];
  const a = perfil(antes), d = perfil(depois);
  if (a.admin !== d.admin) out.push({ action: 'ADMIN_FLAG_CHANGED', category: S, before: { admin: a.admin }, after: { admin: d.admin } });
  if (a.bloqueado !== d.bloqueado) out.push({ action: d.bloqueado ? 'USER_BLOCKED' : 'USER_UNBLOCKED', category: S, before: { bloqueado: a.bloqueado }, after: { bloqueado: d.bloqueado } });
  if (!igual(a.modulos, d.modulos)) out.push({ action: 'MODULES_CHANGED', category: S, before: { modulos: a.modulos }, after: { modulos: d.modulos },
    metadata: { adicionados: d.modulos.filter(m => !a.modulos.includes(m)), removidos: a.modulos.filter(m => !d.modulos.includes(m)) } });
  for (const campo of ['filaComercial', 'carteiraComercial'])
    if (!igual(antes[campo], depois[campo])) out.push({ action: campo === 'filaComercial' ? 'QUEUE_CONFIG_CHANGED' : 'PORTFOLIO_CONFIG_CHANGED', category: S, before: { [campo]: val(antes[campo]) }, after: { [campo]: val(depois[campo]) } });
  if (!igual(a.cargo, d.cargo)) out.push({ action: 'ACCESS_PROFILE_CARGO_CHANGED', category: S, before: { cargo: a.cargo }, after: { cargo: d.cargo } });
  return out;
}
const IDENT_PII = ['cpf_cnpj', 'telefone', 'email'];
function diffClientes(antes, depois) {
  const C = CATEGORIAS.CRM, out = [];
  if (!antes && depois) return [{ action: 'CLIENTE_CREATED', category: C, before: null, after: { tipo: val(depois.tipo), pipeline: val(depois.pipeline), origem: val(depois.origem), vinculoGc: depois.gestaoClickId != null } }];
  if (antes && !depois) return [{ action: 'CLIENTE_DELETED', category: C, before: { pipeline: val(antes.pipeline), vinculoGc: antes.gestaoClickId != null }, after: null }];
  if (!!antes.arquivado !== !!depois.arquivado) out.push({ action: depois.arquivado ? 'CLIENTE_ARCHIVED' : 'CLIENTE_UNARCHIVED', category: C, before: { arquivado: !!antes.arquivado }, after: { arquivado: !!depois.arquivado } });
  for (const campo of IDENT_PII) if (!igual(antes[campo], depois[campo]))
    out.push({ action: 'CLIENTE_IDENTIFIER_CHANGED', category: C, before: { campo, valorHash: hashCurto(antes[campo]) }, after: { campo, valorHash: hashCurto(depois[campo]) } });
  for (const campo of ['gestaoClickId', 'gestaoClickLinkMethod']) if (!igual(antes[campo], depois[campo]))
    out.push({ action: 'CLIENTE_LINK_CHANGED', category: C, before: { campo, valor: val(antes[campo]) }, after: { campo, valor: val(depois[campo]) } });
  if (!igual(antes.pipeline, depois.pipeline)) out.push({ action: 'CLIENTE_PIPELINE_CHANGED', category: C, before: { pipeline: val(antes.pipeline) }, after: { pipeline: val(depois.pipeline) } });
  return out;
}
const TIPO_OPP = { CLAIMED: 'OPP_CLAIMED', RELEASED: 'OPP_RELEASED', OUTCOME_REGISTERED: 'OPP_OUTCOME_REGISTERED' };
/** Eventos NOVOS no array `eventos` (só append conta; reescrita do histórico gera ANOMALIA). */
function diffInteracoes(antes, depois) {
  const K = CATEGORIAS.COMMERCIAL, out = [];
  if (!antes && depois) out.push({ action: 'OPP_CREATED', category: K, actorUid: null, before: null, after: { estado: val(depois.estado), tipoOportunidade: val(depois.tipoOportunidade), commercialEntityId: val(depois.commercialEntityId) } });
  if (antes && !depois) return [{ action: 'OPP_DELETED', category: K, actorUid: null, before: { estado: val(antes.estado) }, after: null }];
  const ev0 = (antes && antes.eventos) || [], ev1 = (depois && depois.eventos) || [];
  const prefixoIntacto = ev0.every((e, i) => igual(e, ev1[i]));
  if (!prefixoIntacto) out.push({ action: 'OPP_HISTORY_REWRITTEN', category: K, actorUid: null, before: { eventos: ev0.length }, after: { eventos: ev1.length } });
  else ev1.slice(ev0.length).forEach(e => {
    const base = { category: K, actorUid: e.operadorId || null, before: antes ? { estado: val(antes.estado) } : null, after: { estado: val(depois.estado) } };
    if (e.tipo === 'OUTCOME_REGISTERED') out.push({ ...base, action: TIPO_OPP[e.tipo], metadata: { outcome: val(e.outcome), nextFollowUpAt: val(depois.nextFollowUpAt), temNota: !!(e.meta && e.meta.temNota), eventoTimestamp: val(e.timestamp) } });
    else out.push({ ...base, action: TIPO_OPP[e.tipo] || 'OPP_EVENT_' + String(e.tipo || 'DESCONHECIDO'), metadata: { eventoTimestamp: val(e.timestamp) } });
  });
  return out;
}

// ── Autor (derivado do servidor) ──────────────────────────────────────────────────
function atorDoContexto(authType, authId) {
  if (authType === 'app_user' && authId) return { uid: authId, type: 'USER', origin: 'FIRESTORE_AUTH_CONTEXT' };
  if (['service_account', 'system', 'api_key'].includes(authType)) return { uid: null, type: 'SYSTEM', origin: 'FIRESTORE_AUTH_CONTEXT:' + authType };
  if (authType === 'unauthenticated') return { uid: null, type: 'SYSTEM', origin: 'FIRESTORE_AUTH_CONTEXT:unauthenticated' };
  return { uid: authId || null, type: 'UNKNOWN', origin: 'FIRESTORE_AUTH_CONTEXT:' + (authType || 'ausente') };
}
async function enriquecerAtor(db, ator) {
  if (!ator.uid) return ator;
  const [u, s] = await Promise.all([db.collection('users').doc(ator.uid).get(), db.collection('sistema_usuarios').doc(ator.uid).get()]);
  return { ...ator, role: u.exists ? u.data().role || null : null, admin: s.exists ? s.data().admin === true : null };
}

/** Grava (create — nunca sobrescreve). Reentrega do gatilho = ALREADY_EXISTS ignorado. */
async function gravar(db, FieldValue, id, ev) {
  try { await db.collection(COLECAO).doc(id).create({ ...ev, at: FieldValue.serverTimestamp() }); return true; }
  catch (e) { if (e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message)))) return false; throw e; }
}

async function auditarMudanca({ db, FieldValue, eventId, ator, entityType, entityId, source, itens }) {
  let n = 0;
  for (let i = 0; i < itens.length; i++) {
    const { action, category, before, after, metadata, actorUid } = itens[i];
    let a = ator;
    if (actorUid !== undefined) a = await enriquecerAtor(db, actorUid ? { uid: actorUid, type: 'USER', origin: 'SERVER_RECORDED_OPERATOR' } : { uid: null, type: 'SYSTEM', origin: 'SERVER_RECORDED_OPERATOR' });
    if (await gravar(db, FieldValue, `${eventId}_${i}`, evento({ ator: a, action, category, entityType, entityId, source, before, after, metadata }))) n++;
  }
  return n;
}

module.exports = { SCHEMA, COLECAO, CATEGORIAS, hashCurto, limpar, evento, diffUsers, diffSistemaUsuarios, diffClientes, diffInteracoes, atorDoContexto, enriquecerAtor, gravar, auditarMudanca };
