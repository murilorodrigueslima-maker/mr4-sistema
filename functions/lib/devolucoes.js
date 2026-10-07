'use strict';
/**
 * B3.1-C — Devoluções. NÃO há fonte confiável no GestãoClick (nenhum vínculo determinístico devolução↔venda): o registro é uma OPERAÇÃO CONTROLADA da gestão
 * (proprietário/Camila) com referência OBJETIVA à venda. Nunca capturado de texto financeiro. TOTAL invalida a renovação; PARCIAL mantém.
 * Coleção carteira_comercial_devolucoes/{dv_<sha1(requestId)>} (append-only; Rules write:false).
 */
const { HttpsError } = require('firebase-functions/v2/https');
const OWN = require('./carteiraOwnership'); const A = require('./auditoria'); const { validarVenda } = require('./carteiraRegra'); const { normalizeGestaoClickId } = require('./commercialIdentity');
const COLL = 'carteira_comercial_devolucoes', TIPOS = Object.freeze(['TOTAL', 'PARCIAL']);
const idDev = req => 'dv_' + require('crypto').createHash('sha1').update(String(req)).digest('hex').slice(0, 32);

async function registrarDevolucao(store, FieldValue, p) {
  OWN.exigir(/^\d{1,20}$/.test(String(p.vendaId)), 'invalid-argument', 'vendaId inválido');
  OWN.exigir(TIPOS.includes(p.tipo), 'invalid-argument', 'tipo deve ser TOTAL ou PARCIAL');
  OWN.exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(p.dataDevolucao)), 'invalid-argument', 'dataDevolucao (YYYY-MM-DD) obrigatória');
  OWN.exigir(typeof p.motivo === 'string' && p.motivo.trim().length >= 3 && p.motivo.length <= 200, 'invalid-argument', 'motivo (3–200) obrigatório');
  OWN.exigir(/^[A-Za-z0-9_-]{8,64}$/.test(String(p.requestId)), 'invalid-argument', 'requestId inválido');
  const revisor = await OWN.autorizarRevisor(store, p.operadorUid);
  const agoraIso = p.agoraIso || new Date().toISOString(); const hoje = agoraIso.slice(0, 10);
  OWN.exigir(p.dataDevolucao <= hoje, 'invalid-argument', 'dataDevolucao no futuro');
  const ref = store.collection(COLL).doc(idDev(p.requestId)); let res;
  await store.runTransaction(async tx => {
    const [sd, sv, outras] = await Promise.all([tx.get(ref), tx.get(store.collection('vendas_gc').doc(String(p.vendaId))), tx.get(store.collection(COLL).where('vendaId', '==', String(p.vendaId)))]);
    if (sd.exists) { res = { repetido: true, id: ref.id }; return; }
    OWN.exigir(sv.exists, 'not-found', 'VENDA_INEXISTENTE_NO_ESPELHO');
    const v = { id: sv.id, ...sv.data() }; const cli = normalizeGestaoClickId(v.cliente_id);
    OWN.exigir(cli, 'failed-precondition', 'VENDA_SEM_CLIENTE');
    const inval = validarVenda({ ...v, data: v.data }, hoje); OWN.exigir(!inval, 'failed-precondition', 'VENDA_NAO_VALIDA:' + inval);
    OWN.exigir(p.dataDevolucao >= String(v.data).slice(0, 10), 'invalid-argument', 'devolução anterior à data da venda');
    OWN.exigir(!outras.docs.some(d => d.data().tipo === 'TOTAL'), 'already-exists', 'VENDA_JA_TEM_DEVOLUCAO_TOTAL');
    const doc = { schemaVersion: 'devolucao-v1', vendaId: String(p.vendaId), portfolioId: 'GC:' + cli, tipo: p.tipo, dataDevolucao: p.dataDevolucao, motivo: p.motivo.trim(), registradoPorUid: p.operadorUid, registradoPorPapel: revisor.papel, registradoEm: agoraIso, requestId: p.requestId };
    tx.create(ref, doc); res = { repetido: false, id: ref.id, doc, reversaoPodeSerNecessaria: p.tipo === 'TOTAL' };
  });
  if (!res.repetido) await A.gravar(store, FieldValue, 'devolucao_' + ref.id, A.evento({ ator: await A.enriquecerAtor(store, { uid: p.operadorUid, type: 'USER', origin: 'CALLABLE_AUTH' }), action: 'RETURN_REGISTERED', category: A.CATEGORIAS.COMMERCIAL,
    entityType: COLL, entityId: res.doc.portfolioId, source: 'LIB:devolucoes', before: null, after: { vendaId: res.doc.vendaId, tipo: p.tipo }, metadata: { dataDevolucao: p.dataDevolucao } }));
  return res;
}
/** Mapa vendaId → 'TOTAL' | 'PARCIAL' (TOTAL prevalece). */
async function mapaDevolucoes(store) {
  const m = new Map(); for (const d of (await store.collection(COLL).get()).docs) { const x = d.data(); if (m.get(x.vendaId) !== 'TOTAL') m.set(x.vendaId, x.tipo); } return m;
}
module.exports = { COLL, TIPOS, idDev, registrarDevolucao, mapaDevolucoes };
