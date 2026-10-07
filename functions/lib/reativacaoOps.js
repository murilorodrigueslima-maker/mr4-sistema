'use strict';
/**
 * B3 — operações de reativação (server-side, transacionais, idempotentes) — INATIVAS: não exportadas por index.js, sem callable/gatilho/job.
 * Coleção `carteira_reativacoes/{idDaChave}` (Rules: write:false para todos; só Admin SDK): reserva de 7 dias por (cliente, ciclo).
 */
const { HttpsError } = require('firebase-functions/v2/https');
const R = require('./reativacao120');
const OWN = require('./carteiraOwnership');
const H2 = require('./carteiraHistoricoV2');

const COLL = 'carteira_reativacoes';
const SCHEMA = 'reativacao-v1';
const err = (c, m) => new HttpsError(c, m);
const idReserva = chave => 'rv_' + require('crypto').createHash('sha1').update(String(chave)).digest('hex').slice(0, 32);
const exigir = (c, code, m) => { if (!c) throw err(code, m); };

/** Libera UMA reserva (idempotente por chave). Recusa conflito, não-contatar, limite diário excedido, destino inválido. */
async function liberarReserva(store, FieldValue, p) {
  exigir(/^REATIV:GC:\d+:\d{4}-\d{2}-\d{2}$/.test(String(p.chave)), 'invalid-argument', 'chave inválida');
  exigir(p.destinoUid && /^\d{4}-\d{2}-\d{2}$/.test(String(p.liberadoEm)), 'invalid-argument', 'destino/data obrigatórios');
  const ref = store.collection(COLL).doc(idReserva(p.chave)); const refC = store.collection(OWN.COLL).doc(p.portfolioId);
  const limite = p.limiteDiario || R.LIMITE_DIARIO; let res;
  await store.runTransaction(async tx => {
    const [s, c, doDia] = await Promise.all([tx.get(ref), tx.get(refC), tx.get(store.collection(COLL).where('destinoUid', '==', p.destinoUid).where('liberadoEm', '==', p.liberadoEm))]);
    if (s.exists) { res = { repetido: true, id: ref.id }; return; }
    const cart = c.exists ? c.data() : null;
    exigir(doDia.size < limite, 'resource-exhausted', 'LIMITE_DIARIO_DO_VENDEDOR');
    if (p.tipo === 'CARTEIRA') {
      exigir(cart && cart.ownerUid === p.ownerUid && p.ownerUid !== p.destinoUid, 'failed-precondition', 'CARTEIRA_INCONSISTENTE_COM_A_RESERVA');
      exigir(cart.status !== 'EM_REVISAO' && !(cart.conflito && cart.conflito.revisao === 'PENDENTE'), 'failed-precondition', 'CARTEIRA_EM_REVISAO_DE_CONFLITO');
    } else {
      exigir(!cart, 'failed-precondition', 'CLIENTE_JA_TEM_CARTEIRA');
      const rel = await tx.get(store.collection(OWN.COLL).where('conflito.relacionados', 'array-contains', p.portfolioId).limit(1));
      exigir(rel.empty, 'failed-precondition', 'CLIENTE_EM_CONFLITO_DE_IDENTIDADE');
    }
    const doc = { schemaVersion: SCHEMA, chave: p.chave, portfolioId: p.portfolioId, ciclo: p.ciclo, tipo: p.tipo, ownerUid: p.ownerUid || null, destinoUid: p.destinoUid, estado: 'RESERVADA',
      liberadoEm: p.liberadoEm, reservaAte: R.somarDias(p.liberadoEm, R.RESERVA_DIAS), followUpAte: null, prioridade: p.prioridade ?? null, criadoEm: p.agoraIso || new Date().toISOString() };
    tx.create(ref, doc); res = { repetido: false, id: ref.id, doc };
  });
  return res;
}
/** Estende a janela SOMENTE com follow-up real: data futura (<=180 dias) e motivo. Nunca indefinido. */
async function estenderPorFollowUp(store, FieldValue, { chave, destinoUid, followUpAte, motivo, hoje }) {
  exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(followUpAte)) && followUpAte > hoje && followUpAte <= R.somarDias(hoje, 180), 'invalid-argument', 'follow-up exige data futura (até 180 dias)');
  exigir(typeof motivo === 'string' && motivo.trim().length >= 3, 'invalid-argument', 'follow-up exige motivo');
  const ref = store.collection(COLL).doc(idReserva(chave));
  await store.runTransaction(async tx => {
    const s = await tx.get(ref); exigir(s.exists, 'not-found', 'reserva inexistente');
    const r = s.data(); exigir(r.destinoUid === destinoUid && r.estado === 'RESERVADA', 'failed-precondition', 'reserva não pertence ao vendedor ou não está ativa');
    tx.update(ref, { followUpAte, followUpMotivo: String(motivo).trim().slice(0, 200) });
  });
}
/** Expira reservas vencidas SEM transferir nada (sem venda ⇒ owner intacto). */
async function expirarReservas(store, hoje) {
  const s = await store.collection(COLL).where('estado', '==', 'RESERVADA').get(); let n = 0;
  for (const d of s.docs) { const r = d.data(); const fim = r.followUpAte && r.followUpAte > r.reservaAte ? r.followUpAte : r.reservaAte; if (fim < hoje) { await d.ref.update({ estado: 'EXPIRADA', expiradaEm: hoje }); n++; } }
  return n;
}
async function carregarReservasDoCliente(store, portfolioId) {
  const s = await store.collection(COLL).where('portfolioId', '==', portfolioId).get(); return new Map(s.docs.map(d => [d.data().chave, d.data()]));
}
/**
 * Aplica o efeito de UMA venda (decisão B3 já calculada pelo chamador a partir de dados lidos no servidor).
 * Mudança de owner SEMPRE via carteiraOwnership (transação + versão esperada + histórico v2 + auditoria); a reserva vira CONVERTIDA na MESMA transação.
 */
async function aplicarDecisaoVenda(store, FieldValue, { decisao, venda, carteira, operadorUid = 'SISTEMA:reativacao', agoraIso }) {
  const D = R.DECISOES; const d = decisao; const ref = d.referencias || {};
  const chave = 'B3:' + d.decisao + ':' + venda.id; const base = { portfolioId: ref.portfolioId, chaveIdempotencia: chave, operadorUid, atorTipo: 'SYSTEM', origemOperacao: 'JOB', agoraIso, referencias: { vendaGcId: String(venda.id), ciclo: ref.ciclo || null, reservaChave: ref.reservaChave || null }, motivoCodigo: 'REATIVACAO_120D' };
  const converterReserva = ref.reservaChave ? { lerTx: tx => tx.get(store.collection(COLL).doc(idReserva(ref.reservaChave))),
    escreverTx: (tx, rs) => { exigir(rs.exists && rs.data().estado === 'RESERVADA', 'aborted', 'RESERVA_NAO_ATIVA'); tx.update(rs.ref, { estado: 'CONVERTIDA', convertidaEm: agoraIso, vendaId: String(venda.id) }); } } : {};
  const dataVenda = String(venda.data).slice(0, 10);
  switch (d.decisao) {
    case D.TRANSFERIR_REATIVACAO: return OWN.reativar(store, FieldValue, { ...base, ...converterReserva, novoOwnerUid: d.ownerDepoisUid, versaoEsperada: carteira.versao, cicloAncoraEm: dataVenda, motivo: 'Reativação 120 dias (venda ' + venda.id + ')' });
    case D.CRIAR_VIA_REATIVACAO: return OWN.criarCarteira(store, FieldValue, { ...base, ...converterReserva, ownerUid: d.ownerDepoisUid, origem: 'REATIVACAO_120D', cicloAncoraEm: dataVenda, origemComercialGestaoClickId: String(venda.vendedor_id), motivo: 'Primeira venda na reativação (venda ' + venda.id + ')' });
    case D.CRIAR_PRIMEIRA_VENDA: return OWN.criarCarteira(store, FieldValue, { ...base, ownerUid: d.ownerDepoisUid, origem: 'PRIMEIRA_VENDA', cicloAncoraEm: dataVenda, origemComercialGestaoClickId: String(venda.vendedor_id), motivo: 'Primeira venda válida (venda ' + venda.id + ')', motivoCodigo: 'PRIMEIRA_VENDA' });
    case D.RENOVAR_OWNER: case D.COBERTURA_RENOVA_OWNER: case D.COBERTURA_PAUSA:
      if (carteira.cicloAncoraEm && carteira.cicloAncoraEm >= dataVenda) return { repetido: false, ignorado: 'CICLO_JA_COBRE_A_DATA' };
      return OWN.renovarCiclo(store, FieldValue, { ...base, versaoEsperada: carteira.versao, cicloAncoraEm: dataVenda, motivo: (d.decisao === D.RENOVAR_OWNER ? 'Venda do dono' : 'Cobertura: venda de outro vendedor renova o ciclo do dono') + ' (venda ' + venda.id + ')', motivoCodigo: d.decisao });
    default: return { repetido: false, ignorado: d.decisao };
  }
}
module.exports = { COLL, SCHEMA, idReserva, liberarReserva, estenderPorFollowUp, expirarReservas, carregarReservasDoCliente, aplicarDecisaoVenda };
