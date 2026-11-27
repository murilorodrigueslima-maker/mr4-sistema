#!/usr/bin/env node
'use strict';
// Grava painel_mapeamento/vendedores (vendedor_id → chave) a partir de um arquivo PRIVADO, fora do repositório.
// NÃO toca painel_config (metas). Dry-run por padrão; --aplicar grava (create-only: recusa sobrescrever).
//   node scripts/painel_mapeamento.js --arquivo <mapeamento.json> [--aplicar]
// Formato: { "vendedores": { "<vendedor_id>": { "chave": "vend1", "nomeConfig": "Vend1", "ordem": 1 } },
//            "outrosConhecidos": { "<vendedor_id>": "OUTRO_RESPONSAVEL" }, "auditadoEm": "AAAA-MM-DD", "fonte": "...", "regra": "..." }
const { chavesDoMapa } = require('../lib/painelMetricas');
function validar(mapa) {
  const erros = [];
  const ids = Object.keys((mapa && mapa.vendedores) || {});
  if (!ids.length) erros.push('SEM_VENDEDORES');
  if (ids.some(id => !/^\d+$/.test(id))) erros.push('VENDEDOR_ID_INVALIDO');
  if (ids.some(id => !mapa.vendedores[id].chave || !mapa.vendedores[id].nomeConfig)) erros.push('ENTRADA_INCOMPLETA');
  if (ids.length && chavesDoMapa(mapa.vendedores).length === 0) erros.push('SEM_CHAVES');
  return erros;
}
module.exports = { validar };
if (require.main === module) {
  const i = process.argv.indexOf('--arquivo'); const arquivo = i >= 0 ? process.argv[i + 1] : null;
  if (!arquivo) { console.log(JSON.stringify({ ok: false, erro: 'USO: --arquivo <mapeamento.json> [--aplicar]' })); process.exit(2); }
  const MAPA = JSON.parse(require('fs').readFileSync(require('path').resolve(arquivo), 'utf8'));
  const erros = validar(MAPA);
  // não imprime o conteúdo (dados de pessoas): só contagens
  console.log(JSON.stringify({ modo: process.argv.includes('--aplicar') ? 'APLICAR' : 'DRY-RUN', vendedores: Object.keys(MAPA.vendedores || {}).length, outrosConhecidos: Object.keys(MAPA.outrosConhecidos || {}).length, erros }));
  if (erros.length) process.exit(2);
  if (process.argv.includes('--aplicar')) {
    const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
    const ref = db.doc('painel_mapeamento/vendedores');
    db.runTransaction(async tx => { if ((await tx.get(ref)).exists) throw new Error('MAPEAMENTO_JA_EXISTE'); tx.create(ref, { ...MAPA, criadoEm: admin.firestore.FieldValue.serverTimestamp() }); })
      .then(() => console.log(JSON.stringify({ aplicado: true }))).catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
  }
}
