'use strict';
/**
 * PACOTE DO WEBHOOK (NÃO exportado por functions/index.js — só é publicado como pacote isolado, com autorização).
 *   webhookGestaoClick  : onRequest público (invoker allUsers), valida assinatura, grava e responde 2xx. Padrão DESLIGADO (gc_webhook_config/estado.modo).
 *   gcWebhookProcessar  : gatilho do Firestore; processa em SOMBRA (só compara; nenhum efeito em coleções de negócio).
 * Segredo: GC_WEBHOOK_SECRET (Secret Manager), copiado da tela do GestãoClick pelo usuário master — nunca no repositório.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const REGION = 'southamerica-east1';
const WH_SECRET = defineSecret('GC_WEBHOOK_SECRET'), GC_ACCESS = defineSecret('GC_ACCESS_TOKEN'), GC_SECRET = defineSecret('GC_SECRET_ACCESS_TOKEN');
const R = require('./lib/webhooks/receptor');
const lerConfig = R.criarLeitorConfig({ db });

exports.webhookGestaoClick = onRequest({ region: REGION, secrets: [WH_SECRET], timeoutSeconds: 10, memory: '256MiB', maxInstances: 5, invoker: 'public', cors: false }, async (req, res) => {
  const r = await R.tratarRequisicao({ req: { metodo: req.method, cabecalhos: req.headers, corpoCru: req.rawBody }, db, segredo: WH_SECRET.value(), lerConfig,
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(), log: l => (l.status >= 500 ? logger.error : l.status >= 400 ? logger.warn : logger.info)('WEBHOOK_GC', l) });
  res.status(r.status).json(r.corpo);
});

exports.gcWebhookProcessar = onDocumentCreated({ document: `${R.COL_EVENTOS}/{id}`, region: REGION, secrets: [GC_ACCESS, GC_SECRET], timeoutSeconds: 60, memory: '256MiB', maxInstances: 5, retry: false }, async (ev) => {
  const gcHttp = require('./lib/gcHttp');
  const cli = gcHttp.criarCliente({ credenciais: { access: GC_ACCESS.value(), secret: GC_SECRET.value() } });
  const buscar = async (recurso, id) => { try { const j = await cli.get(`/${recurso}/${encodeURIComponent(id)}`, {}, { tipo: 'detalhe' }); return { status: 200, loja_id: j && j.data && j.data.loja_id }; } catch (e) { if (e && e.status === 404) return { status: 404 }; throw e; } };
  const out = await R.processarSombra({ db, id: ev.params.id, buscar }); logger.info('WEBHOOK_GC_SOMBRA', { resultado: out.codigo });
  // Efeito operacional (marcar bloco desatualizado + disparar o Job) SÓ no modo ATIVO — exige aprovação e nunca é o padrão.
  const cfg = await lerConfig(); const evDoc = (await db.collection(R.COL_EVENTOS).doc(ev.params.id).get()).data() || {};
  const { GoogleAuth } = require('google-auth-library');
  const dispararJob = async () => { const c = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); await c.request({ url: 'https://run.googleapis.com/v2/projects/mr4-ponto/locations/southamerica-east1/jobs/mr4-sync-job:run', method: 'POST', data: { overrides: { containerOverrides: [{ env: [{ name: 'MODO_SUJOS', value: '1' }] }] } } }); };
  const ef = await require('./lib/refreshFila').aplicarModo({ db, modo: cfg.modo, evento: evDoc.evento, dispararJob }); if (ef.efeito) logger.info('WEBHOOK_GC_BLOCOS_MARCADOS', { blocos: ef.blocos });
});
