'use strict';
/**
 * B3.1-D — REVERSÃO após transferência/criação por reativação quando a venda que a causou deixou de ser válida
 * (cancelada/alterada para não-concretizada OU devolução TOTAL registrada). Operação TRANSACIONAL, idempotente, auditável; NÃO apaga a transferência original:
 * cria um NOVO evento REVERSAO_TRANSFERENCIA e restaura owner/ownerDesde/ciclo/origem do estado anterior (dados guardados no evento original).
 * Qualquer ambiguidade (evento posterior, novo owner voltou a vender, dados de restauração ausentes, conflito aberto, owner anterior inelegível) ⇒ NÃO decide:
 * grava um item de revisão da gestão (carteira_comercial_revisoes) e não altera nada.
 */
const OWN = require('./carteiraOwnership'); const C2 = require('./carteiraV2'); const R = require('./reativacao120'); const DEV = require('./devolucoes'); const MOTOR = require('./motorCarteira');
const { validarVenda } = require('./carteiraRegra'); const A = require('./auditoria');
const COLL_REV = 'carteira_comercial_revisoes';
const CHAVES = (vendaId) => [`B3:TRANSFERIR_REATIVACAO:${vendaId}`, `B3:CRIAR_VIA_REATIVACAO:${vendaId}`, `B3:CRIAR_PRIMEIRA_VENDA:${vendaId}`];
const idRev = chave => 'rv_' + require('crypto').createHash('sha1').update(chave).digest('hex').slice(0, 32);

/** Avalia (leitura, sem escrita). { decisao: 'REVERTER'|'AMBIGUA'|'NAO_NECESSARIA', motivos[], evento? } */
async function avaliarReversao(store, { portfolioId, vendaId, hoje }) {
  const motivos = []; const ref = store.collection('carteira_comercial').doc(portfolioId);
  const [c, v, devs] = await Promise.all([ref.get(), store.collection('vendas_gc').doc(String(vendaId)).get(), store.collection(DEV.COLL).where('vendaId', '==', String(vendaId)).get()]);
  if (!c.exists) return { decisao: 'NAO_NECESSARIA', motivos: ['SEM_CARTEIRA'] };
  const cart = c.data(); const venda = v.exists ? { id: v.id, ...v.data() } : null;
  const totalDev = devs.docs.some(d => d.data().tipo === 'TOTAL'); const invalida = !venda || !!validarVenda(venda, hoje) || totalDev;
  if (!invalida) return { decisao: 'NAO_NECESSARIA', motivos: ['VENDA_CONTINUA_VALIDA'] };
  const evs = await store.collection('carteira_comercial_historico').where('portfolioId', '==', portfolioId).where('chaveIdempotencia', 'in', CHAVES(vendaId)).get();
  if (evs.size !== 1) return { decisao: evs.size === 0 ? 'NAO_NECESSARIA' : 'AMBIGUA', motivos: [evs.size === 0 ? 'VENDA_NAO_CAUSOU_MUDANCA_DE_OWNER' : 'EVENTOS_ORIGINAIS_MULTIPLOS'] };
  const ev = { id: evs.docs[0].id, ...evs.docs[0].data() };
  if (cart.schemaVersion !== C2.SCHEMA_V2) motivos.push('CARTEIRA_NAO_V2');
  if (cart.status === 'EM_REVISAO' || (cart.conflito && cart.conflito.revisao === 'PENDENTE')) motivos.push('CONFLITO_ABERTO');
  if (cart.ultimoEventoId !== ev.id) motivos.push('EVENTO_POSTERIOR_NA_CARTEIRA');
  if (cart.ownerUid !== ev.ownerNovoUid) motivos.push('OWNER_ATUAL_DIFERE_DO_DA_TRANSFERENCIA');
  const rest = ev.referencias && ev.referencias.restauracao; if (ev.ownerAnteriorUid && !rest) motivos.push('SEM_DADOS_DE_RESTAURACAO');   // criação (sem owner anterior) não precisa de restauração
  if (ev.ownerAnteriorUid && !(await OWN.ownerValido(store, ev.ownerAnteriorUid))) motivos.push('OWNER_ANTERIOR_INELEGIVEL');
  // o novo owner voltou a vender depois da venda que causou a transferência? então a posse pode ter nova justificativa válida
  if (venda) {
    const outras = await store.collection('vendas_gc').where('cliente_id', '==', String(portfolioId.slice(3))).get();
    const dataV = String(venda.data).slice(0, 10);
    const cfgs = (await store.collection('sistema_usuarios').get()).docs.filter(d => d.data().carteiraComercial).map(d => ({ uid: d.id, user: null, sistema: d.data() }));
    const gcNovo = (cfgs.find(x => x.uid === ev.ownerNovoUid) || { sistema: {} }).sistema.carteiraComercial; const gcId = gcNovo && String(gcNovo.gestaoClickVendedorId);
    const depois = outras.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => String(x.id) !== String(vendaId) && !validarVenda(x, hoje) && String(x.data).slice(0, 10) >= dataV && gcId && String(x.vendedor_id) === gcId);
    const semDevTotal = depois.filter(x => !(devs.docs.some(d => d.data().vendaId === String(x.id) && d.data().tipo === 'TOTAL')));
    if (semDevTotal.length) motivos.push('NOVO_OWNER_VENDEU_DEPOIS');
  }
  return { decisao: motivos.length ? 'AMBIGUA' : 'REVERTER', motivos, evento: ev };
}
async function registrarRevisao(store, FieldValue, { portfolioId, vendaId, motivos, agoraIso }) {
  const chave = `REVISAO:REVERSAO:${portfolioId}:${vendaId}`; const ref = store.collection(COLL_REV).doc(idRev(chave)); let criada = false;
  await store.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists) return; tx.create(ref, { schemaVersion: 'revisao-v1', tipo: 'REVERSAO_AMBIGUA', portfolioId, vendaId: String(vendaId), motivos, estado: 'PENDENTE', criadoEm: agoraIso, chave }); criada = true; });
  if (criada) await A.gravar(store, FieldValue, 'revisao_' + ref.id, A.evento({ ator: { uid: null, type: 'SYSTEM', origin: 'SERVER' }, action: 'REVERSAL_NEEDS_REVIEW', category: A.CATEGORIAS.COMMERCIAL, entityType: COLL_REV, entityId: portfolioId, source: 'LIB:reativacaoReversao', before: null, after: { estado: 'PENDENTE' }, metadata: { vendaId: String(vendaId), motivos } }));
  return { id: ref.id, criada };
}
/** Executa (ou encaminha para revisão). `operadorUid` = null ⇒ SISTEMA. */
async function executarReversao(store, FieldValue, p) {
  const agoraIso = p.agoraIso || new Date().toISOString(); const hoje = agoraIso.slice(0, 10);
  if (p.operadorUid) await OWN.autorizarRevisor(store, p.operadorUid);
  const av = await avaliarReversao(store, { portfolioId: p.portfolioId, vendaId: p.vendaId, hoje });
  if (av.decisao === 'NAO_NECESSARIA') return { status: 'NAO_NECESSARIA', motivos: av.motivos };
  if (av.decisao === 'AMBIGUA') return { status: 'REVISAO_DA_GESTAO', motivos: av.motivos, revisao: await registrarRevisao(store, FieldValue, { portfolioId: p.portfolioId, vendaId: p.vendaId, motivos: av.motivos, agoraIso }) };
  const ev = av.evento; const rest = (ev.referencias && ev.referencias.restauracao) || {}; const chave = `B3:REVERSAO:${p.vendaId}`;
  const params = { portfolioId: p.portfolioId, chaveIdempotencia: chave, motivo: 'Reversão: a venda ' + p.vendaId + ' deixou de ser válida (cancelada ou devolvida integralmente)', motivoCodigo: 'REVERSAO_VENDA_INVALIDA',
    operadorUid: p.operadorUid || 'SISTEMA:reativacao', atorTipo: p.operadorUid ? 'USER' : 'SYSTEM', origemOperacao: p.operadorUid ? 'CALLABLE' : 'JOB', agoraIso, referencias: { vendaGcId: String(p.vendaId), eventoRevertidoId: ev.id },
    lerTx: async tx => { const motor = await MOTOR.motorNaTx(tx, store); if (!p.ignorarMotor) OWN.exigir(MOTOR.podeEscreverOwnership(motor, 'B3'), 'failed-precondition', 'MOTOR_B3_NAO_AUTORIZADO'); return { motor }; } };
  const regras = { tipoEvento: 'REVERSAO_TRANSFERENCIA', mudaOwner: true, async planejar(antes, { tx, agoraIso: t }) {
    OWN.exigir(antes && antes.ultimoEventoId === ev.id && antes.ownerUid === ev.ownerNovoUid && antes.versao === ev.versaoCarteiraDepois, 'aborted', 'ESTADO_MUDOU_DESDE_A_AVALIACAO');
    const [sv, sd] = await Promise.all([tx.get(store.collection('vendas_gc').doc(String(p.vendaId))), tx.get(store.collection(DEV.COLL).where('vendaId', '==', String(p.vendaId)))]);
    const venda = sv.exists ? { id: sv.id, ...sv.data() } : null;
    OWN.exigir(!venda || !!validarVenda(venda, t.slice(0, 10)) || sd.docs.some(d => d.data().tipo === 'TOTAL'), 'failed-precondition', 'VENDA_CONTINUA_VALIDA');   // revalida DENTRO da transação
    const semOwner = !ev.ownerAnteriorUid;
    return { doc: { ...antes, ownerUid: semOwner ? null : ev.ownerAnteriorUid, ownerDesde: semOwner ? null : rest.ownerDesde, status: semOwner ? 'LIBERADA' : 'ATIVA', origem: semOwner ? antes.origem : rest.origem,
      cicloAncoraEm: semOwner ? null : (rest.cicloAncoraEm ?? null), atualizadoEm: t, versao: antes.versao + 1 } };
  } };
  const r = await OWN.aplicar(store, FieldValue, params, regras);
  return { status: r.repetido ? 'JA_REVERTIDA' : 'REVERTIDA', evento: r.eventoId };
}
module.exports = { COLL_REV, avaliarReversao, registrarRevisao, executarReversao, idRev };
