'use strict';
// N35.30 — Job agendado da regra da carteira, publicado SOMENTE EM SOMBRA.
//
// FORCAR_SOMBRA = true é uma trava de código: mesmo que alguém grave carteira_comercial_config/regra.modo='ATIVO',
// este job continua escrevendo APENAS em carteira_comercial_decisoes_sombra (+ checkpoint_sombra).
// Ativar de verdade exige mudar esta constante, novo commit e novo deploy (fase futura, com autorização).
//
// Por que agendado e não gatilho em vendas_gc: a sincronização regrava vendas em lote (sync360); um gatilho por
// documento reavaliaria vendas antigas. O corte de ativação + checkpoint limitam a leitura às vendas novas.
// Kill switch: carteira_comercial_config/regra.modo = 'DESLIGADO' (efeito na próxima execução, sem deploy).

const crypto = require('crypto');
const admin = require('firebase-admin');
const { processarVendasRecentes } = require('./carteiraRegra');

const FORCAR_SOMBRA = true;

async function carteiraRegraJobHandler(_event, opts = {}) {
  const store = opts.db || admin.firestore();
  const agora = opts.now ? opts.now() : new Date();
  const runId = agora.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
  const r = await processarVendasRecentes(store, { agoraIso: agora.toISOString(), forcarSombra: FORCAR_SOMBRA, runId });
  // Log só com IDs/contagens (sem cliente, documento, contato ou valor).
  console.log(JSON.stringify({ job: 'processarCarteiraComercial', status: r.status, runId: r.runId, mode: r.modo, ruleVersion: r.regraVersao,
    cutoff: r.corte, checkpointBefore: r.checkpointAntes, checkpointAfter: r.checkpointDepois, read: r.lidas, processed: r.processadas,
    decisions: r.porDecisaoSombra, alreadyProcessed: r.jaProcessadas, ignored: r.ignoradasPorMotivo, invalidatedAfterDecision: r.invalidadasAposDecisao,
    errors: r.erros, durationMs: r.duracaoMs }));
  return r;
}

module.exports = { carteiraRegraJobHandler, FORCAR_SOMBRA };
