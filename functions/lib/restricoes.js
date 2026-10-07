'use strict';
/**
 * B3.1-A — NÃO CONTATAR. Estado atual em carteira_comercial_restricoes/{GC:id}; trilha append-only em carteira_comercial_restricoes_hist.
 * Só gestão (role gestor OU módulo fila-comercial-gestao) altera — SEMPRE por backend (Rules: write:false para todos). Sem PII (só id técnico,
 * código de motivo e texto curto). Vendedor apenas vê o bloqueio (via crmConsulta). Bloqueia oportunidade AUTOMÁTICA; retorno espontâneo segue permitido.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const OWN = require('./carteiraOwnership'); const H2 = require('./carteiraHistoricoV2'); const A = require('./auditoria');
const COLL = 'carteira_comercial_restricoes', COLL_HIST = 'carteira_comercial_restricoes_hist';
const MOTIVOS = Object.freeze(['PEDIDO_DO_CLIENTE', 'CLIENTE_NAO_QUER_CONTATO', 'DECISAO_COMERCIAL', 'JURIDICO_FINANCEIRO', 'OUTRO']);
const ANCORA = /^GC:\d{1,20}$/;
const err = (c, m) => new HttpsError(c, m);
const idEvento = req => 'rh_' + require('crypto').createHash('sha1').update(String(req)).digest('hex').slice(0, 32);

async function definirNaoContatar(store, FieldValue, p) {
  OWN.exigir(ANCORA.test(String(p.portfolioId)), 'invalid-argument', 'portfolioId inválido');
  OWN.exigir(typeof p.naoContatar === 'boolean', 'invalid-argument', 'naoContatar (boolean) obrigatório');
  OWN.exigir(MOTIVOS.includes(p.motivoCodigo), 'invalid-argument', 'motivoCodigo inválido');
  OWN.exigir(typeof p.motivo === 'string' && p.motivo.trim().length >= 3 && p.motivo.length <= 200, 'invalid-argument', 'motivo (3–200 caracteres) obrigatório');
  OWN.exigir(/^[A-Za-z0-9_-]{8,64}$/.test(String(p.requestId)), 'invalid-argument', 'requestId inválido');
  const revisor = await OWN.autorizarRevisor(store, p.operadorUid);                             // identidade vem do login (callable); aqui só papel
  const agoraIso = p.agoraIso || new Date().toISOString(); const refR = store.collection(COLL).doc(p.portfolioId), refH = store.collection(COLL_HIST).doc(idEvento(p.requestId));
  let res;
  await store.runTransaction(async tx => {
    const [sr, sh] = await Promise.all([tx.get(refR), tx.get(refH)]);
    if (sh.exists) { res = { repetido: true, estado: sr.exists ? sr.data() : null }; return; }
    const antes = sr.exists ? sr.data() : null; const atual = !!(antes && antes.naoContatar);
    OWN.exigir(atual !== p.naoContatar, 'failed-precondition', p.naoContatar ? 'CLIENTE_JA_ESTA_COMO_NAO_CONTATAR' : 'CLIENTE_NAO_ESTA_COMO_NAO_CONTATAR');
    const versao = (antes ? antes.versao : 0) + 1;
    const doc = { schemaVersion: 'restricao-v1', portfolioId: p.portfolioId, naoContatar: p.naoContatar, motivoCodigo: p.motivoCodigo, motivo: p.motivo.trim(), desde: agoraIso, atualizadoEm: agoraIso,
      atualizadoPorUid: p.operadorUid, atualizadoPorPapel: revisor.papel, versao };
    tx.set(refR, doc);
    tx.create(refH, { schemaVersion: 'restricao-hist-v1', portfolioId: p.portfolioId, acao: p.naoContatar ? 'MARCAR' : 'DESMARCAR', motivoCodigo: p.motivoCodigo, motivo: p.motivo.trim(), criadoEm: agoraIso,
      atorUid: p.operadorUid, atorPapel: revisor.papel, versaoAntes: antes ? antes.versao : 0, versaoDepois: versao, requestId: p.requestId });
    res = { repetido: false, estado: doc };
  });
  if (!res.repetido) await A.gravar(store, FieldValue, 'restricao_' + idEvento(p.requestId), A.evento({ ator: await A.enriquecerAtor(store, { uid: p.operadorUid, type: 'USER', origin: 'CALLABLE_AUTH' }),
    action: p.naoContatar ? 'DO_NOT_CONTACT_SET' : 'DO_NOT_CONTACT_CLEARED', category: A.CATEGORIAS.COMMERCIAL, entityType: COLL, entityId: p.portfolioId, source: 'LIB:restricoes',
    before: { naoContatar: atualDe(res) }, after: { naoContatar: p.naoContatar }, metadata: { motivoCodigo: p.motivoCodigo } }));
  return res;
}
const atualDe = res => !res.estado ? false : !res.estado.naoContatar;       // estado anterior = inverso do novo (garantido pela precondição)
async function listarNaoContatar(store) { return new Set((await store.collection(COLL).where('naoContatar', '==', true).get()).docs.map(d => d.id.replace(/^GC:/, ''))); }
module.exports = { COLL, COLL_HIST, MOTIVOS, definirNaoContatar, listarNaoContatar, idEvento };
