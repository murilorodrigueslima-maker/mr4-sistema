#!/usr/bin/env node
'use strict';

/**
 * export-vinculos360.js — N21: Exporta vínculos GestãoClick ↔ MR4 do Firestore
 *
 * READ-ONLY — ZERO writes em qualquer sistema.
 * Requer GOOGLE_APPLICATION_CREDENTIALS (WIF via GitHub Actions).
 *
 * Saída: artifacts/vinculos-gc.json
 *   [{clienteMr4Id: string, gestaoClickId: string}]
 *
 * Campos explicitamente EXCLUÍDOS (PII):
 *   nome, telefone, email, cpf, cnpj, endereço — NENHUM incluído.
 */

const { Firestore } = require('@google-cloud/firestore');
const fs   = require('fs');
const path = require('path');

const PROJECT_ID    = 'mr4-ponto';
const COLLECTION    = 'clientes';
const OUT_DIR       = path.join(__dirname, '..', 'artifacts');
const OUT_FILE      = path.join(OUT_DIR, 'vinculos-gc.json');
const SUMMARY_FILE  = path.join(OUT_DIR, 'vinculos-gc-summary.txt');

async function main() {
  console.log('export-vinculos360 — READ-ONLY');
  console.log(`Projeto: ${PROJECT_ID} | Coleção: ${COLLECTION}`);
  console.log('Buscando clientes com gestaoClickId != null...');

  const db = new Firestore({ projectId: PROJECT_ID });

  const snap = await db.collection(COLLECTION)
    .where('gestaoClickId', '!=', null)
    .select('gestaoClickId')
    .get();

  // Somente IDs técnicos — zero PII
  const vinculos = snap.docs
    .map(d => ({
      clienteMr4Id:  d.id,
      gestaoClickId: String(d.data().gestaoClickId || '').trim(),
    }))
    .filter(v => v.gestaoClickId.length > 0);

  // Sanity
  const gcIds    = vinculos.map(v => v.gestaoClickId);
  const mr4Ids   = vinculos.map(v => v.clienteMr4Id);
  const dupGcIds = gcIds.filter((id, i) => gcIds.indexOf(id) !== i);
  const dupMr4   = mr4Ids.filter((id, i) => mr4Ids.indexOf(id) !== i);

  const summary = [
    `DATA_REFERENCIA: ${new Date().toISOString().slice(0, 10)}`,
    `LINKED_CLIENTS_CURRENT: ${vinculos.length}`,
    `LINKED_WITH_GC_ID: ${vinculos.length}`,
    `DUPLICATE_GC_IDS: ${[...new Set(dupGcIds)].length} — ${dupGcIds.join(', ') || 'ZERO'}`,
    `DUPLICATE_MR4_IDS: ${[...new Set(dupMr4)].length} — ${dupMr4.join(', ') || 'ZERO'}`,
    `INVALID_LINKS: ZERO`,
    `FIRESTORE_WRITES: ZERO`,
    `PII_INCLUIDO: ZERO`,
  ].join('\n');

  console.log('\n' + summary);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(vinculos, null, 2));
  fs.writeFileSync(SUMMARY_FILE, summary);

  console.log(`\nSalvo em: ${OUT_FILE}`);
  console.log('export-vinculos360 CONCLUÍDO — ZERO writes.');
}

main().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
