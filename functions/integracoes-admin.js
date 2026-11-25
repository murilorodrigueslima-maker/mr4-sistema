'use strict';
/**
 * Cloud Functions ESPECÍFICAS do módulo Integrações e Credenciais (codebase "integracoes", conta de serviço dedicada com IAM mínimo).
 * Nenhuma função genérica de segredos: cada callable faz uma operação fixa sobre os 3 segredos autorizados.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const { IntErro } = require('./lib/integracoes/nucleo');
const { criarHandlers } = require('./lib/integracoes/handlers');
const SM = require('./lib/integracoes/secretManager');

const REGION = 'southamerica-east1';
const SA = 'mr4-integracoes@mr4-ponto.iam.gserviceaccount.com';
const OPC = { region: REGION, serviceAccount: SA, maxInstances: 3, memory: '256MiB', timeoutSeconds: 60 };
let H = null;
const handlers = () => H || (H = criarHandlers({ db: admin.firestore(), sm: SM.criar(), requisitarGcp: SM.requisitarGcp, transporteGc: (...a) => fetch(...a) }));

const envolver = nome => onCall(OPC, async req => {
  try { return await handlers()[nome]({ auth: req.auth ? { uid: req.auth.uid, token: req.auth.token } : null, data: req.data }); }
  catch (e) {
    if (e instanceof IntErro) throw new HttpsError(e.code, e.code === 'permission-denied' ? 'Acesso restrito ao administrador master.' : e.message);
    console.error(JSON.stringify({ evento: 'integracoes_erro', fn: nome, codigo: String((e && (e.code || e.name)) || 'ERRO').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) }));   // nunca loga mensagem (pode conter valores)
    throw new HttpsError('internal', 'Falha interna. Tente novamente.');
  }
});
exports.intStatus = envolver('status');
exports.intGcSalvar = envolver('gcSalvar');
exports.intGcTestar = envolver('gcTestar');
exports.intGcReverter = envolver('gcReverter');
exports.intWebhookSegredo = envolver('whSegredo');
exports.intWebhookModo = envolver('whModo');
exports.intWebhookTeste = envolver('whTeste');
exports.intSyncManual = envolver('syncManual');
