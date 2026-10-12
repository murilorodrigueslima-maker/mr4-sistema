'use strict';
/** Gatilho espelhos/{id}: espelho ASSINADO ⇒ marca a competência como protegida (ponto_meses_protegidos). Aditivo, idempotente, nunca apaga. */
async function protegerMesAssinado(db, FieldValue, dep, espelhoId) {
  if (!dep || dep.assinado !== true || !dep.funcId || !/^\d{4}-\d{2}$/.test(dep.mes || '')) return { marcado: false };
  await db.collection('ponto_meses_protegidos').doc(dep.funcId + '_' + dep.mes).set(
    { funcId: dep.funcId, mes: dep.mes, espelhoId, versao: dep.versao || null, origem: 'trigger', protegidoEm: FieldValue.serverTimestamp() }, { merge: true });
  return { marcado: true, id: dep.funcId + '_' + dep.mes };
}
module.exports = { protegerMesAssinado };
