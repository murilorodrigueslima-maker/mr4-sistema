// Somente leitura. Uso: node scripts/webhook/relatorio-webhooks.js  (ADC do gcloud; projeto mr4-ponto). Não grava nada; não imprime payloads.
const path = require('path'); const admin = require(path.join(__dirname, '..', '..', 'functions', 'node_modules', 'firebase-admin'));
const { resumir } = require('../../functions/lib/webhooks/relatorio'); const R = require('../../functions/lib/webhooks/receptor');
admin.initializeApp({ projectId: 'mr4-ponto' }); const db = admin.firestore();
(async () => {
  const s = await db.collection(R.COL_EVENTOS).limit(5000).get(); const ev = s.docs.map(d => d.data());
  console.log('RESUMO', JSON.stringify(resumir(ev), null, 1));
  const cmp = await R.compararComPolling({ db, existeNoPolling: async (rec, id) => rec === 'vendas' ? (await db.collection('vendas_gc').doc(String(id)).get()).exists : false });
  console.log('SOMBRA_X_POLLING (só vendas são conferidas no espelho; recebimentos/pagamentos contam como ausentes aqui)', JSON.stringify(cmp));
  const ultimo = ev.reduce((m, e) => Math.max(m, e.recebido_ms || 0), 0); const modo = ((await db.collection(R.COL_CONFIG).doc(R.DOC_CONFIG || 'estado').get()).data() || {}).modo;
  console.log('SILENCIO', JSON.stringify(R.avaliarSilencio({ modo, ultimoEventoMs: ultimo, agoraMs: Date.now() })));
})().catch(e => { console.error('ERRO', e.code || e.message); process.exit(1); });
