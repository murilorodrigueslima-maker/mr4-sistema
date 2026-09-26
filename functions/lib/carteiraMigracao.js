'use strict';
// N35.26 — Migração da Carteira Comercial (Onda 1). Módulo ISOLADO: depende só de carteiraV1 + commercialIdentity.
// Não contém transferência administrativa, painel nem gatilho de primeira venda.
//
// Garantias (provadas em emulador nas N35.25.1/N35.26):
//   - âncora estável carteira_comercial/GC:<gcId>, resolvida DENTRO da transação (vínculo MR4, ambiguidade, chave legada);
//   - create-only: nunca sobrescreve; carteira existente com owner/origem diferentes = conflito;
//   - evento CARTEIRA_CRIADA com id determinístico MIGRACAO_<lote>_GC_<gcId> → reexecutar não duplica;
//   - dryRun: mesmas leituras em transação somente leitura, nenhuma escrita;
//   - failFast: para no primeiro item que não seja criação/já-existente-idêntico e informa onde parou.

const { HttpsError } = require('firebase-functions/v2/https');
const { parseCommercialEntityId, resolvePortfolioAnchor, SOURCES } = require('./commercialIdentity');
const V1 = require('./carteiraV1');

const COLL = 'carteira_comercial';
const COLL_HIST = 'carteira_comercial_historico';

/** Resolve a âncora estável dentro da transação `tx` (leituras entram no controle de concorrência). */
async function resolverAncoraTx(tx, store, commercialEntityId) {
  let parsed;
  try { parsed = parseCommercialEntityId(commercialEntityId); } catch (e) { throw new HttpsError('invalid-argument', 'commercialEntityId inválido.'); }
  let gcRaw;
  if (parsed.source === SOURCES.MR4_LINKED) {
    const c = await tx.get(store.collection('clientes').doc(parsed.stableId));
    gcRaw = c.exists ? (c.data().gestaoClickId ?? null) : null;
  }
  const r = resolvePortfolioAnchor(commercialEntityId, { gcIdForMr4: () => gcRaw });
  if (r.status !== 'RESOLVED') throw new HttpsError('failed-precondition', `Revisão de identidade necessária (${r.reason}).`);
  const vinc = await tx.get(store.collection('clientes').where('gestaoClickId', 'in', [Number(r.gcId), r.gcId]));
  const mr4s = [...new Set(vinc.docs.map(d => d.id))].sort();
  if (mr4s.length > 1) throw new HttpsError('failed-precondition', 'Revisão de identidade necessária (IDENTIDADE_AMBIGUA).');
  const legadas = ['GC_NATIVE:' + r.gcId, ...mr4s.map(m => 'MR4_LINKED:' + m)];
  const snaps = await Promise.all(legadas.map(id => tx.get(store.collection(COLL).doc(id))));
  if (snaps.some(x => x.exists)) throw new HttpsError('failed-precondition', 'Revisão de identidade necessária (CARTEIRA_EM_CHAVE_LEGADA).');
  return { ...r, mr4s };
}

function idEventoMigracao(loteId, anchorId) { return 'MIGRACAO_' + loteId + '_' + anchorId.replace(':', '_'); }

/**
 * Executa (ou simula, com dryRun) uma onda. Um cliente por transação.
 * @param store Firestore (Admin SDK ou @google-cloud/firestore)
 * @param p { itens:[{portfolioId, identidadeAtual, proposedOwnerUid, origemComercialUid, origemComercialGestaoClickId}],
 *            loteId, operadorUid, motivo, agoraIso, dryRun=false, failFast=false }
 * @returns resumo + detalhe por item (status: CREATED | WOULD_CREATE | ALREADY_EXISTS_SAME | CONFLICT_OWNER |
 *          CONFLICT_ORIGIN | CONFLICT_HISTORY | IDENTITY_ERROR) e `paradoEm` quando failFast interrompe.
 */
async function executarOndaMigracao(store, { itens, loteId, operadorUid, motivo, agoraIso, dryRun = false, failFast = false }) {
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(String(loteId || ''))) throw new Error('loteId inválido');
  if (!operadorUid || !motivo || !agoraIso) throw new Error('operadorUid, motivo e agoraIso obrigatórios');
  const r = { dryRun: !!dryRun, total: 0, criados: 0, wouldCreate: 0, jaExistentesMesmoOwner: 0, conflitos: [], identidade: [], detalhe: [], paradoEm: null };
  for (let i = 0; i < (itens || []).length; i++) {
    const it = itens[i];
    r.total++;
    let status;
    try {
      await store.runTransaction(async tx => {
        const anc = await resolverAncoraTx(tx, store, it.identidadeAtual);
        if (anc.anchorId !== it.portfolioId) throw new HttpsError('failed-precondition', 'Revisão de identidade necessária (IDENTIDADE_MUDOU).');
        const ref = store.collection(COLL).doc(anc.anchorId);
        const refHist = store.collection(COLL_HIST).doc(idEventoMigracao(loteId, anc.anchorId));
        const [cur, h] = await Promise.all([tx.get(ref), tx.get(refHist)]);
        if (cur.exists) {
          const d = cur.data();
          if (d.ownerUid !== it.proposedOwnerUid) { status = 'CONFLICT_OWNER'; r.conflitos.push({ portfolioId: anc.anchorId, tipo: status, ownerAtual: d.ownerUid, proposto: it.proposedOwnerUid }); return; }
          if ((d.origemComercialGestaoClickId || null) !== (it.origemComercialGestaoClickId || null)) { status = 'CONFLICT_ORIGIN'; r.conflitos.push({ portfolioId: anc.anchorId, tipo: status }); return; }
          status = 'ALREADY_EXISTS_SAME'; r.jaExistentesMesmoOwner++; return;
        }
        if (h.exists) { status = 'CONFLICT_HISTORY'; r.conflitos.push({ portfolioId: anc.anchorId, tipo: status }); return; } // evento sem carteira = inconsistência
        if (dryRun) { status = 'WOULD_CREATE'; r.wouldCreate++; return; }
        tx.create(ref, V1.montarDocCarteiraV1({ portfolioId: anc.anchorId, ownerUid: it.proposedOwnerUid, ownerDesde: agoraIso,
          origemComercialUid: it.origemComercialUid, origemComercialGestaoClickId: it.origemComercialGestaoClickId, criadoEm: agoraIso, atualizadoEm: agoraIso, versao: 1 }));
        tx.create(refHist, V1.montarEventoHistoricoV1({ portfolioId: anc.anchorId, identidadeUsada: it.identidadeAtual, tipoEvento: 'CARTEIRA_CRIADA',
          ownerAnteriorUid: null, ownerNovoUid: it.proposedOwnerUid, motivo, operadorUid, criadoEm: agoraIso, versao: 1, chaveIdempotencia: 'MIGRACAO:' + loteId + ':' + anc.anchorId }));
        status = 'CREATED';
      }, dryRun ? { readOnly: true } : undefined);
      if (status === 'CREATED') r.criados++;
    } catch (e) {
      if (e && (e.code === 'already-exists' || e.code === 6)) { status = 'ALREADY_EXISTS_SAME'; r.jaExistentesMesmoOwner++; }
      else { status = 'IDENTITY_ERROR'; r.identidade.push({ portfolioId: it.portfolioId, erro: e.message }); }
    }
    r.detalhe.push({ i, portfolioId: it.portfolioId, status });
    if (failFast && !['CREATED', 'WOULD_CREATE', 'ALREADY_EXISTS_SAME'].includes(status)) { r.paradoEm = { indice: i, portfolioId: it.portfolioId, status }; break; }
  }
  return r;
}

module.exports = { resolverAncoraTx, executarOndaMigracao, idEventoMigracao, COLL, COLL_HIST };
