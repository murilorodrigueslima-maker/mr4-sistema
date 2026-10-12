#!/usr/bin/env node
'use strict';
// Cria os marcadores ponto_meses_protegidos/{funcId}_{YYYY-MM} para espelhos JÁ assinados (o gatilho cobre os novos). Aditivo; nunca apaga; dry-run por padrão.
function marcadores(espelhos) {
  const m = {};
  (espelhos || []).forEach(e => { if (e.assinado === true && e.funcId && /^\d{4}-\d{2}$/.test(e.mes || '')) m[e.funcId + '_' + e.mes] = { funcId: e.funcId, mes: e.mes, espelhoId: e.id, versao: e.versao || null, origem: 'backfill' }; });
  return m;
}
async function aplicar(db, FieldValue, espelhos) {
  const m = marcadores(espelhos); let criados = 0, existentes = 0;
  for (const [id, v] of Object.entries(m)) {
    const ref = db.collection('ponto_meses_protegidos').doc(id);
    await db.runTransaction(async tx => { if ((await tx.get(ref)).exists) { existentes++; return; } tx.create(ref, { ...v, protegidoEm: FieldValue.serverTimestamp() }); criados++; });
  }
  return { criados, existentes, total: Object.keys(m).length };
}
module.exports = { marcadores, aplicar };
if (require.main === module) {
  const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
  (async () => {
    const esp = (await db.collection('espelhos').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    if (!process.argv.includes('--aplicar')) { console.log(JSON.stringify({ modo: 'SIMULACAO', marcadores: Object.keys(marcadores(esp)) })); return; }
    console.log(JSON.stringify({ modo: 'APLICADO', ...(await aplicar(db, admin.firestore.FieldValue, esp)) }));
  })().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
}
