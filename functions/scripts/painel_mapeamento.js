#!/usr/bin/env node
'use strict';
// Grava painel_mapeamento/vendedores (vendedor_id → chave). Auditado contra 4.718 vendas concretizadas jan–out/2026 (12/10/2026).
// NÃO toca painel_config (metas). Dry-run por padrão; --aplicar grava (create-only: recusa sobrescrever).
const MAPA = {
  vendedores: {
    '948278': { chave: 'ademir', nomeConfig: 'Ademir', nomeGC: 'ADEMIR LOPES FURTADO' },
    '1080453': { chave: 'fabiana', nomeConfig: 'Fabiana', nomeGC: 'fabiana andrade da silva' },
  },
  outrosConhecidos: { '559684': 'MURILO RODRIGUES LIMA', '791775': 'Swyanne Kethlyn', '1392140': 'Camila Silveira Silva' },
  regra: 'vendedor_id mapeado ⇒ chave; qualquer outro id (ou sem id) ⇒ Outros. Nunca por nome.',
  auditadoEm: '2026-10-12', fonte: 'GestaoClick /vendas situacao_id=3952593 (jan–out/2026)',
};
module.exports = { MAPA };
if (require.main === module) {
  console.log(JSON.stringify({ modo: process.argv.includes('--aplicar') ? 'APLICAR' : 'DRY-RUN', mapa: MAPA }, null, 1));
  if (process.argv.includes('--aplicar')) {
    const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
    const ref = db.doc('painel_mapeamento/vendedores');
    db.runTransaction(async tx => { if ((await tx.get(ref)).exists) throw new Error('MAPEAMENTO_JA_EXISTE'); tx.create(ref, { ...MAPA, criadoEm: admin.firestore.FieldValue.serverTimestamp() }); })
      .then(() => console.log(JSON.stringify({ aplicado: true }))).catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
  }
}
