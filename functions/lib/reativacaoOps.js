'use strict';
/**
 * B3/B3.1 — operações de reativação (server-side, transacionais, idempotentes). INATIVAS até receberem dados/oportunidades reais:
 * nada as aciona automaticamente (sem agendador; o job tem FORCAR_DRY). Coleção `carteira_reativacoes/{rv_<sha1(chave)>}` (Rules: write:false para todos).
 * Reserva NUNCA cria ownership. Mudança de owner só via carteiraOwnership (transação + versão + histórico + auditoria) e SÓ com o motor B3 autorizado.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');
const R = require('./reativacao120'); const OWN = require('./carteiraOwnership'); const A = require('./auditoria'); const MOTOR = require('./motorCarteira');
const RESTR = require('./restricoes'); const CONF = require('./conflitosRegistro');

const COLL = 'carteira_reativacoes', SCHEMA = 'reativacao-v1';
const err = (c, m) => new HttpsError(c, m);
const exigir = OWN.exigir;
const idReserva = chave => 'rv_' + crypto.createHash('sha1').update(String(chave)).digest('hex').slice(0, 32);
/** id da oportunidade no CRM/fila (mesmo formato dos demais: 16 hex), derivado da chave ⇒ determinístico. */
const idOportunidade = chave => crypto.createHash('sha1').update('opp|' + String(chave)).digest('hex').slice(0, 16);
const auditar = (store, FieldValue, id, p) => A.gravar(store, FieldValue, id, A.evento({ ator: p.ator || { uid: null, type: 'SYSTEM', origin: 'SERVER' }, category: A.CATEGORIAS.COMMERCIAL, entityType: COLL, source: 'LIB:reativacaoOps', ...p }));

/** Libera UMA reserva (idempotente por chave; uma por cliente/ciclo). Recusa conflito (carteira OU registro), NÃO CONTATAR, limite diário, destino inválido. */
async function liberarReserva(store, FieldValue, p) {
  exigir(/^REATIV:GC:\d+:\d{4}-\d{2}-\d{2}$/.test(String(p.chave)), 'invalid-argument', 'chave inválida');
  exigir(p.destinoUid && /^\d{4}-\d{2}-\d{2}$/.test(String(p.liberadoEm)), 'invalid-argument', 'destino/data obrigatórios');
  const ref = store.collection(COLL).doc(idReserva(p.chave)); const refC = store.collection(OWN.COLL).doc(p.portfolioId);
  const limite = p.limiteDiario || R.LIMITE_DIARIO; let res;
  await store.runTransaction(async tx => {
    const [s, c, doDia, rst, regs] = await Promise.all([tx.get(ref), tx.get(refC), tx.get(store.collection(COLL).where('destinoUid', '==', p.destinoUid).where('liberadoEm', '==', p.liberadoEm)),
      tx.get(store.collection(RESTR.COLL).doc(p.portfolioId)), tx.get(store.collection(CONF.COLL).where('membros', 'array-contains', p.portfolioId).where('status', '==', 'PENDENTE').limit(1))]);
    if (s.exists) { res = { repetido: true, id: ref.id }; return; }
    const cart = c.exists ? c.data() : null;
    exigir(doDia.size < limite, 'resource-exhausted', 'LIMITE_DIARIO_DO_VENDEDOR');
    exigir(!(rst.exists && rst.data().naoContatar === true), 'failed-precondition', 'CLIENTE_NAO_CONTATAR');
    exigir(regs.empty, 'failed-precondition', 'CLIENTE_EM_CONFLITO_DE_IDENTIDADE');
    // cliente sem carteira: somente UM vendedor reservado por vez (a chave do ciclo já garante; conferimos reservas ativas do mesmo cliente)
    const ativas = await tx.get(store.collection(COLL).where('portfolioId', '==', p.portfolioId).where('estado', '==', 'RESERVADA'));
    exigir(ativas.empty, 'failed-precondition', 'JA_EXISTE_RESERVA_ATIVA_PARA_O_CLIENTE');
    if (p.tipo === 'CARTEIRA') {
      exigir(cart && cart.ownerUid === p.ownerUid && p.ownerUid !== p.destinoUid, 'failed-precondition', 'CARTEIRA_INCONSISTENTE_COM_A_RESERVA');
      exigir(cart.status !== 'EM_REVISAO' && !(cart.conflito && cart.conflito.revisao === 'PENDENTE'), 'failed-precondition', 'CARTEIRA_EM_REVISAO_DE_CONFLITO');
    } else {
      exigir(!cart, 'failed-precondition', 'CLIENTE_JA_TEM_CARTEIRA');
      const rel = await tx.get(store.collection(OWN.COLL).where('conflito.relacionados', 'array-contains', p.portfolioId).limit(1));
      exigir(rel.empty, 'failed-precondition', 'CLIENTE_EM_CONFLITO_DE_IDENTIDADE');
    }
    const doc = { schemaVersion: SCHEMA, chave: p.chave, opportunityInstanceId: idOportunidade(p.chave), portfolioId: p.portfolioId, ciclo: p.ciclo, tipo: p.tipo, ownerUid: p.ownerUid || null, destinoUid: p.destinoUid,
      estado: 'RESERVADA', liberadoEm: p.liberadoEm, reservaAte: R.somarDias(p.liberadoEm, R.RESERVA_DIAS), followUpAte: null, prioridade: p.prioridade ?? null,
      nomeCliente: typeof p.nomeCliente === 'string' ? p.nomeCliente.slice(0, 80) : null, criadoEm: p.agoraIso || new Date().toISOString() };
    tx.create(ref, doc); res = { repetido: false, id: ref.id, doc };
  });
  if (!res.repetido) await auditar(store, FieldValue, 'reserva_' + res.id + '_criada', { action: 'REACTIVATION_RESERVED', entityId: p.portfolioId, before: null, after: { estado: 'RESERVADA', destinoUid: p.destinoUid, tipo: p.tipo }, metadata: { chave: p.chave, reservaAte: res.doc.reservaAte } });
  return res;
}
/** Estende a janela SOMENTE com follow-up real: data futura (<=180 dias) E motivo. Nunca indefinido. */
async function estenderPorFollowUp(store, FieldValue, { chave, destinoUid, followUpAte, motivo, hoje }) {
  exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(followUpAte)) && followUpAte > hoje && followUpAte <= R.somarDias(hoje, 180), 'invalid-argument', 'follow-up exige data futura (até 180 dias)');
  exigir(typeof motivo === 'string' && motivo.trim().length >= 3, 'invalid-argument', 'follow-up exige motivo');
  const ref = store.collection(COLL).doc(idReserva(chave));
  await store.runTransaction(async tx => {
    const s = await tx.get(ref); exigir(s.exists, 'not-found', 'reserva inexistente');
    const r = s.data(); exigir(r.destinoUid === destinoUid && r.estado === 'RESERVADA', 'failed-precondition', 'reserva não pertence ao vendedor ou não está ativa');
    tx.update(ref, { followUpAte, followUpMotivo: String(motivo).trim().slice(0, 200) });
  });
  await auditar(store, FieldValue, 'reserva_' + idReserva(chave) + '_fu_' + followUpAte, { ator: { uid: destinoUid, type: 'USER', origin: 'CALLABLE_AUTH' }, action: 'REACTIVATION_FOLLOWUP_EXTENDED', entityId: chave, before: null, after: { followUpAte } });
}
/** Expira reservas vencidas SEM transferir nada (sem venda ⇒ owner intacto; sem carteira continua sem carteira). Gera auditoria. */
async function expirarReservas(store, hoje, FieldValue) {
  const s = await store.collection(COLL).where('estado', '==', 'RESERVADA').get(); let n = 0;
  for (const d of s.docs) {
    const r = d.data(); const fim = r.followUpAte && r.followUpAte > r.reservaAte ? r.followUpAte : r.reservaAte;
    if (fim < hoje) {
      const ok = await store.runTransaction(async tx => { const x = await tx.get(d.ref); if (!x.exists || x.data().estado !== 'RESERVADA') return false; tx.update(d.ref, { estado: 'EXPIRADA', expiradaEm: hoje }); return true; });
      if (ok) { n++; if (FieldValue) await auditar(store, FieldValue, 'reserva_' + d.id + '_expirada', { action: 'REACTIVATION_EXPIRED', entityId: r.portfolioId, before: { estado: 'RESERVADA' }, after: { estado: 'EXPIRADA' }, metadata: { chave: r.chave, ownerMantido: r.ownerUid || null } }); }
    }
  }
  return n;
}
async function carregarReservasDoCliente(store, portfolioId) {
  const s = await store.collection(COLL).where('portfolioId', '==', portfolioId).get(); return new Map(s.docs.map(d => [d.data().chave, d.data()]));
}
/**
 * Aplica o efeito de UMA venda (decisão B3 calculada pelo chamador a partir de dados lidos no servidor). Só com o motor B3 autorizado.
 * Mudança de owner SEMPRE via carteiraOwnership; a reserva vira CONVERTIDA na MESMA transação; guarda dados de RESTAURAÇÃO para reversão futura.
 */
async function aplicarDecisaoVenda(store, FieldValue, { decisao, venda, carteira, operadorUid = 'SISTEMA:reativacao', agoraIso, ignorarMotor = false }) {
  const D = R.DECISOES; const d = decisao; const ref = d.referencias || {};
  const chave = 'B3:' + d.decisao + ':' + venda.id;
  const restauracao = carteira ? { ownerDesde: carteira.ownerDesde ?? null, cicloAncoraEm: carteira.cicloAncoraEm ?? null, origem: carteira.origem ?? null } : null;
  const base = { portfolioId: ref.portfolioId, chaveIdempotencia: chave, operadorUid, atorTipo: 'SYSTEM', origemOperacao: 'JOB', agoraIso, motivoCodigo: 'REATIVACAO_120D',
    referencias: { vendaGcId: String(venda.id), ciclo: ref.ciclo || null, reservaChave: ref.reservaChave || null, restauracao } };
  const motorOk = async tx => { const m = await MOTOR.motorNaTx(tx, store); if (!ignorarMotor) exigir(MOTOR.podeEscreverOwnership(m, 'B3'), 'failed-precondition', 'MOTOR_B3_NAO_AUTORIZADO'); return m; };
  const comReserva = ref.reservaChave ? { lerTx: async tx => ({ motor: await motorOk(tx), rs: await tx.get(store.collection(COLL).doc(idReserva(ref.reservaChave))) }),
    escreverTx: (tx, lido) => { exigir(lido.rs.exists && lido.rs.data().estado === 'RESERVADA', 'aborted', 'RESERVA_NAO_ATIVA'); tx.update(lido.rs.ref, { estado: 'CONVERTIDA', convertidaEm: agoraIso, vendaId: String(venda.id) }); } }
    : { lerTx: async tx => ({ motor: await motorOk(tx) }) };
  const dataVenda = String(venda.data).slice(0, 10);
  switch (d.decisao) {
    case D.TRANSFERIR_REATIVACAO: return OWN.reativar(store, FieldValue, { ...base, ...comReserva, novoOwnerUid: d.ownerDepoisUid, versaoEsperada: carteira.versao, cicloAncoraEm: dataVenda, motivo: 'Reativação 120 dias (venda ' + venda.id + ')' });
    case D.CRIAR_VIA_REATIVACAO: return OWN.criarCarteira(store, FieldValue, { ...base, ...comReserva, ownerUid: d.ownerDepoisUid, origem: 'REATIVACAO_120D', cicloAncoraEm: dataVenda, origemComercialGestaoClickId: String(venda.vendedor_id), motivo: 'Primeira venda na reativação (venda ' + venda.id + ')' });
    case D.CRIAR_PRIMEIRA_VENDA: return OWN.criarCarteira(store, FieldValue, { ...base, ...comReserva, ownerUid: d.ownerDepoisUid, origem: 'PRIMEIRA_VENDA', cicloAncoraEm: dataVenda, origemComercialGestaoClickId: String(venda.vendedor_id), motivo: 'Primeira venda válida (venda ' + venda.id + ')', motivoCodigo: 'PRIMEIRA_VENDA' });
    case D.RENOVAR_OWNER: case D.COBERTURA_RENOVA_OWNER: case D.COBERTURA_PAUSA:
      if (carteira.cicloAncoraEm && carteira.cicloAncoraEm >= dataVenda) return { repetido: false, ignorado: 'CICLO_JA_COBRE_A_DATA' };
      return OWN.renovarCiclo(store, FieldValue, { ...base, ...comReserva, versaoEsperada: carteira.versao, cicloAncoraEm: dataVenda, motivo: (d.decisao === D.RENOVAR_OWNER ? 'Venda do dono' : 'Cobertura: venda de outro vendedor renova o ciclo do dono') + ' (venda ' + venda.id + ')', motivoCodigo: d.decisao });
    default: return { repetido: false, ignorado: d.decisao };
  }
}
module.exports = { COLL, SCHEMA, idReserva, idOportunidade, liberarReserva, estenderPorFollowUp, expirarReservas, carregarReservasDoCliente, aplicarDecisaoVenda };
