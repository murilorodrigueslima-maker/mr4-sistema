'use strict';
// Fiação do pacote do webhook (sem rede): exportações, agenda e que NADA é disparado fora do ATIVO.
const { dbWebhook } = require('./fixtures/webhook-db');
let mockDb; const mockChamadas = [];
jest.mock('firebase-admin', () => { const firestore = () => ({ collection: (...a) => mockDb.collection(...a), runTransaction: (...a) => mockDb.runTransaction(...a) }); return { apps: [1], initializeApp: () => {}, firestore }; });
jest.mock('google-auth-library', () => ({ GoogleAuth: class { async getClient() { return { request: async o => { mockChamadas.push(o.url); return {}; } }; } } }), { virtual: true });
const P = require('../webhook-gestaoclick');
const evento = (extra = {}) => ({ evento: 'recebimento.baixado', recurso: 'recebimentos', registro_id: '1', recebido_ms: Date.now(), status: 'RECEBIDO', ...extra });

test('3 exportações; varredura a cada 10 min, 1 instância, sem retry, só os 2 segredos do ERP, não pública', () => {
  expect(Object.keys(P).sort()).toEqual(['gcWebhookProcessar', 'gcWebhookVarredura', 'webhookGestaoClick']);
  const e = P.gcWebhookVarredura.__endpoint; expect(e.scheduleTrigger.schedule).toBe('every 10 minutes'); expect(e.maxInstances).toBe(1); expect(e.secretEnvironmentVariables.map(s => s.key).sort()).toEqual(['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN']); expect(e.httpsTrigger).toBeUndefined();
});
test('DESLIGADO por ausência de configuração: varredura e processador não disparam nada', async () => {
  mockDb = dbWebhook({ gc_webhook_eventos: { a: evento() } }); await P.gcWebhookVarredura.run({}); expect(mockDb.n).toEqual({ leituras: 1, gravacoes: 0 });
  await P.gcWebhookProcessar.run({ params: { id: 'a' } }); expect(mockChamadas).toEqual([]); expect(mockDb.n.gravacoes).toBe(0);
});
test('ATIVO (somente neste teste): processador marca, dispara Job e Financeiro e confirma o efeito', async () => {
  mockDb = dbWebhook({ gc_webhook_config: { estado: { modo: 'ATIVO' } }, gc_webhook_eventos: { b: evento({ efeito: 'PENDENTE', loja_id: '262759', status: 'SOMBRA_CONCLUIDA', resultado: 'CONFERIDO' }) } });
  jest.resetModules(); const Q = require('../webhook-gestaoclick');                        // novo leitor de configuração (sem o cache de 30 s)
  await Q.gcWebhookProcessar.run({ params: { id: 'b' } });
  expect(mockChamadas.map(u => new URL(u).host).sort()).toEqual(['cloudscheduler.googleapis.com', 'run.googleapis.com']); expect(mockDb.st.gc_webhook_eventos.b.efeito).toBe('APLICADO');
});
test('ATIVO com a conferência falhando (sem acesso ao ERP): o processador NÃO marca bloco nem dispara nada; o efeito espera', async () => {
  mockChamadas.length = 0;
  mockDb = dbWebhook({ gc_webhook_config: { estado: { modo: 'ATIVO' } }, gc_webhook_eventos: { c: evento({ efeito: 'PENDENTE', loja_id: '262759', status: 'PENDENTE_SOMBRA' }) } });
  jest.resetModules(); const Q = require('../webhook-gestaoclick');
  await Q.gcWebhookProcessar.run({ params: { id: 'c' } });
  expect(mockChamadas.map(u => new URL(u).host).filter(h => /^(run|cloudscheduler)\./.test(h))).toEqual([]);
  expect(mockDb.st.gc_refresh_fila).toBeUndefined(); expect(mockDb.st.gc_webhook_eventos.c).toMatchObject({ status: 'PENDENTE_SOMBRA', efeito: 'PENDENTE', resultado: 'FALHA_CONSULTA' });
});
