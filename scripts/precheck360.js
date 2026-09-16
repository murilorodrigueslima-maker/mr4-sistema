'use strict';
/**
 * precheck360.js — Verifica que as coleções Perfil360 NÃO existem antes do bootstrap.
 * Leitura READ-ONLY. Termina com exit(1) se qualquer coleção já existir.
 * FIRESTORE_WRITES = ZERO
 */

const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore({ projectId: 'mr4-ponto', databaseId: '(default)' });

async function main() {
  console.log('='.repeat(60));
  console.log('GATE 2 PRECHECK — COLLECTIONS AUSENTES');
  console.log('='.repeat(60));

  let fail = false;

  const perfisSnap = await db.collection('perfis_360').limit(1).get();
  console.log(`PERFIS_360_EXISTS     = ${!perfisSnap.empty}`);
  console.log(`PERFIS_360_DOC_COUNT  = ${perfisSnap.size}`);
  if (!perfisSnap.empty) fail = true;

  const vendasSnap = await db.collection('vendas_gc').limit(1).get();
  console.log(`VENDAS_GC_EXISTS      = ${!vendasSnap.empty}`);
  console.log(`VENDAS_GC_DOC_COUNT   = ${vendasSnap.size}`);
  if (!vendasSnap.empty) fail = true;

  const syncDoc = await db.collection('sync_state').doc('perfil360').get();
  console.log(`SYNC_STATE_PERFIL360_EXISTS = ${syncDoc.exists}`);
  if (syncDoc.exists) fail = true;

  if (fail) {
    console.error('\nGATE_2_PRECHECK = FAIL — coleção já existe. PARANDO.');
    process.exit(1);
  }

  console.log('\nGATE_2_PRECHECK = PASS');
  console.log('FIRESTORE_WRITES = ZERO');
}

main().catch(e => {
  console.error('PRECHECK_ERROR:', e.message);
  process.exit(1);
});
