'use strict';
/**
 * B3.1 — callable de GESTÃO da reativação (proprietário = role gestor; Camila = módulo fila-comercial-gestao; NUNCA vendedor, NUNCA exige admin).
 * Ações: naoContatar | devolucao | reversao. Identidade só de request.auth.uid; payload estrito; todas as mudanças server-side, idempotentes (requestId),
 * auditadas (S7). Não cria oportunidades, não ativa motor, não distribui carteira.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const RESTR = require('./restricoes'); const DEV = require('./devolucoes'); const REV = require('./reativacaoReversao'); const OWN = require('./carteiraOwnership'); const VND = require('./reativacaoVendas'); const { validarVenda } = require('./carteiraRegra');
const PERMITIDOS = { naoContatar: ['acao', 'portfolioId', 'naoContatar', 'motivoCodigo', 'motivo', 'requestId'], devolucao: ['acao', 'vendaId', 'tipo', 'dataDevolucao', 'motivo', 'requestId'], reversao: ['acao', 'portfolioId', 'vendaId', 'requestId'], venda: ['acao', 'vendaId'], pendencias: ['acao'] };

async function reativacaoGestaoHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; if (!d || typeof d !== 'object' || Array.isArray(d) || !PERMITIDOS[d.acao]) throw new HttpsError('invalid-argument', 'ACAO_INVALIDA');
  const extras = Object.keys(d).filter(k => !PERMITIDOS[d.acao].includes(k)); if (extras.length) throw new HttpsError('invalid-argument', 'CAMPOS_NAO_PERMITIDOS: ' + extras.join(', '));
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const agoraIso = (opts.now ? opts.now() : new Date()).toISOString(); const operadorUid = request.auth.uid;
  if (d.acao === 'naoContatar') { const r = await RESTR.definirNaoContatar(store, FV, { ...d, operadorUid, agoraIso }); return { ok: true, repetido: r.repetido, naoContatar: r.estado ? r.estado.naoContatar : null }; }
  if (d.acao === 'devolucao') { const r = await DEV.registrarDevolucao(store, FV, { ...d, operadorUid, agoraIso }); return { ok: true, repetido: r.repetido, reversaoPodeSerNecessaria: !!r.reversaoPodeSerNecessaria }; }
  if (d.acao === 'venda') {                                                                  // consulta para a gestão conferir a venda CORRETA antes de registrar devolução (sem nome/contato do cliente)
    await OWN.autorizarRevisor(store, operadorUid);
    if (!/^\d{1,20}$/.test(String(d.vendaId))) throw new HttpsError('invalid-argument', 'vendaId inválido');
    const [sv, devs, evs] = await Promise.all([store.collection('vendas_gc').doc(String(d.vendaId)).get(), store.collection('carteira_comercial_devolucoes').where('vendaId', '==', String(d.vendaId)).get(), store.collection('carteira_comercial_historico').where('referencias.vendaGcId', '==', String(d.vendaId)).get()]);
    if (!sv.exists) throw new HttpsError('not-found', 'VENDA_INEXISTENTE_NO_ESPELHO');
    const v = { id: sv.id, ...sv.data() }; const inval = validarVenda(v, agoraIso.slice(0, 10));
    return { ok: true, venda: { vendaId: v.id, data: String(v.data).slice(0, 10), situacao: v.nome_situacao || null, valida: !inval, motivoInvalida: inval, clienteGc: v.cliente_id || null, vendedorGc: v.vendedor_id || null, valorTotal: Number(v.valor_total) || null },
      devolucoes: devs.docs.map(x => ({ tipo: x.data().tipo, dataDevolucao: x.data().dataDevolucao, motivo: x.data().motivo })), eventosDeCarteira: evs.docs.map(x => ({ tipoEvento: x.data().tipoEvento, portfolioId: x.data().portfolioId, criadoEm: x.data().criadoEm })) };
  }
  if (d.acao === 'pendencias') {                                                             // pendências de reversão: revisões abertas + transferências/criações cuja venda deixou de valer
    await OWN.autorizarRevisor(store, operadorUid);
    const rev = await store.collection('carteira_comercial_revisoes').where('estado', '==', 'PENDENTE').get(); const inv = await VND.varrerInvalidacoes(store, FV, { hoje: agoraIso.slice(0, 10), agoraIso, executar: false });
    return { ok: true, revisoesAbertas: rev.docs.map(x => ({ id: x.id, tipo: x.data().tipo, portfolioId: x.data().portfolioId, vendaId: x.data().vendaId, motivos: x.data().motivos, criadoEm: x.data().criadoEm })), invalidacoes: inv };
  }
  const r = await REV.executarReversao(store, FV, { ...d, operadorUid, agoraIso }); return { ok: true, status: r.status, motivos: r.motivos || null };
}
module.exports = { reativacaoGestaoHandler, PERMITIDOS };
