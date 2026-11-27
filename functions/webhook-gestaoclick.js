'use strict';
/**
 * PACOTE DO WEBHOOK (NÃO exportado por functions/index.js — só é publicado como pacote isolado, com autorização).
 *   webhookGestaoClick  : onRequest público (invoker allUsers), valida assinatura, grava e responde 2xx. Padrão DESLIGADO (gc_webhook_config/estado.modo).
 *   gcWebhookProcessar  : gatilho do Firestore; processa em SOMBRA (só compara; nenhum efeito em coleções de negócio).
 *   gcWebhookVarredura  : agendada (10 min); repete pendentes, monitora silêncio/atrasos e, só em ATIVO, retoma efeitos e a pendência do Financeiro.
 *                         Em DESLIGADO/RECEPCAO faz 1 leitura (a configuração) e termina.
 * Segredo: GC_WEBHOOK_SECRET (Secret Manager), copiado da tela do GestãoClick pelo usuário master — nunca no repositório.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const REGION = 'southamerica-east1';
const WH_SECRET = defineSecret('GC_WEBHOOK_SECRET'), GC_ACCESS = defineSecret('GC_ACCESS_TOKEN'), GC_SECRET = defineSecret('GC_SECRET_ACCESS_TOKEN');
const R = require('./lib/webhooks/receptor');
const lerConfig = R.criarLeitorConfig({ db });
const SEGRT = require('./lib/segredosRuntime');
const V = require('./lib/webhooks/varredura');

/** Consulta de UM registro no GestãoClick (só GET). Segredos e cliente são criados apenas no primeiro uso. */
function criarBuscar(opcoes = {}) {
  let cli = null;
  return async (recurso, id) => {
    if (!cli) {
      const [acc, sec] = [await SEGRT.lerSegredo('GC_ACCESS_TOKEN', { reserva: GC_ACCESS.value() }), await SEGRT.lerSegredo('GC_SECRET_ACCESS_TOKEN', { reserva: GC_SECRET.value() })];
      cli = require('./lib/gcHttp').criarCliente({ credenciais: { access: acc, secret: sec }, ...opcoes });
    }
    try {
      const j = await cli.get(`/${recurso}/${encodeURIComponent(id)}`, {}, { tipo: 'detalhe' }); const d = (j && j.data) || {}; const reg = d.Venda || d;
      return { status: 200, loja_id: reg.loja_id, nome_loja: reg.nome_loja };
    } catch (e) { if (e && e.status === 404) return { status: 404 }; throw e; }
  };
}
async function chamarGoogle(url, data) { const { GoogleAuth } = require('google-auth-library'); const c = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); await c.request({ url, method: 'POST', data, timeout: 20000 }); }
// Efeitos operacionais: chamados SOMENTE no modo ATIVO.
const dispararJob = () => chamarGoogle('https://run.googleapis.com/v2/projects/mr4-ponto/locations/southamerica-east1/jobs/mr4-sync-job:run', { overrides: { containerOverrides: [{ env: [{ name: 'MODO_SUJOS', value: '1' }] }] } });
// Financeiro (fin_n1): pede o financeiroSync existente via Cloud Scheduler (jobs:run). Exige permissão específica concedida SÓ na aprovação do ATIVO; sem ela falha de forma inócua.
const dispararFinanceiro = () => chamarGoogle('https://cloudscheduler.googleapis.com/v1/projects/mr4-ponto/locations/southamerica-east1/jobs/firebase-schedule-financeiroSync-southamerica-east1:run', {});

exports.webhookGestaoClick = onRequest({ region: REGION, secrets: [WH_SECRET], timeoutSeconds: 10, memory: '256MiB', maxInstances: 5, invoker: 'public', cors: false }, async (req, res) => {
  // Segredo lido em tempo de execução (versão mais recente; cache 60 s) ⇒ a troca pelo módulo Integrações vale sem reimplantar. Em DESLIGADO nem consulta o Secret Manager.
  const cfg0 = await lerConfig(); const segredo = cfg0.modo === 'DESLIGADO' ? null : await SEGRT.lerSegredo('GC_WEBHOOK_SECRET', { reserva: WH_SECRET.value(), ttlMs: 60000 });
  const r = await R.tratarRequisicao({ req: { metodo: req.method, cabecalhos: req.headers, corpoCru: req.rawBody }, db, segredo, lerConfig,
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(), log: l => (l.status >= 500 ? logger.error : l.status >= 400 ? logger.warn : logger.info)('WEBHOOK_GC', l) });
  res.status(r.status).json(r.corpo);
});

exports.gcWebhookProcessar = onDocumentCreated({ document: `${R.COL_EVENTOS}/{id}`, region: REGION, secrets: [GC_ACCESS, GC_SECRET], timeoutSeconds: 60, memory: '256MiB', maxInstances: 5, retry: false }, async (ev) => {
  const id = ev.params.id;
  try { const out = await R.processarSombra({ db, id, buscar: criarBuscar({ tentativas: 2, timeoutMs: 10000, retryAfterMaxMs: 5000 }) }); (out.codigo === 'LOJA_DIVERGENTE' ? logger.warn : logger.info)('WEBHOOK_GC_SOMBRA', { resultado: out.codigo }); }
  catch (e) { logger.error('WEBHOOK_GC_SOMBRA', { resultado: 'ERRO_INTERNO' }); }   // o efeito fica retido; a varredura repete a conferência
  // Efeito operacional (marcar bloco desatualizado + disparar o Job + pendência do Financeiro) SÓ no modo ATIVO — exige aprovação e nunca é o padrão —
  // e SÓ com a origem conferida: consulta pendente espera a varredura; conferência negativa bloqueia.
  const cfg = await lerConfig(); const evDoc = (await db.collection(R.COL_EVENTOS).doc(id).get()).data() || {};
  const ef = await V.aplicarEfeito({ db, modo: cfg.modo, id, evDoc, dispararJob, dispararFinanceiro }); if (ef.efeito) logger.info('WEBHOOK_GC_BLOCOS_MARCADOS', { blocos: ef.blocos, financeiroN1: ef.financeiroN1 }); else if (ef.conferencia) logger.warn('WEBHOOK_GC_EFEITO_RETIDO', { conferencia: ef.conferencia });
});

exports.gcWebhookVarredura = onSchedule({ schedule: 'every 10 minutes', timeZone: 'America/Fortaleza', region: REGION, secrets: [GC_ACCESS, GC_SECRET], timeoutSeconds: 300, memory: '256MiB', retryCount: 0, maxInstances: 1 }, async () => {
  await V.executarVarredura({ db, buscar: criarBuscar({ tentativas: 1, timeoutMs: 10000 }), dispararJob, dispararFinanceiro, logger });
});
