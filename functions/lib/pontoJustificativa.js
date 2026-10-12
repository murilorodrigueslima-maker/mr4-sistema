'use strict';
/**
 * Decisão sobre justificativas de ponto NO SERVIDOR (fase 4.4). Única via de APROVAÇÃO de correção de batida.
 *  • Transação + trava por funcionário×dia (ponto_justificativas_lock): decisões simultâneas serializam e reavaliam o dia.
 *  • Mês protegido (espelho assinado, lido do documento E do marcador): aprovar é recusado; rejeitar/solicitar informação não alteram cálculo.
 *  • Conflitos: batida com correção APROVADA diferente, ou outra pendente diferente para a mesma batida ⇒ bloqueia até revisão.
 *  • Par de almoço: aprovar uma metade isoladamente que gere jornada incoerente é recusado (aprove o par: ids=[a,b] atômico).
 *  • Preserva marcações originais (substituidoPor, nunca apaga), grava autor/data/motivo e uma trilha em ponto_justificativas_decisoes.
 *  • Nunca decide sozinho: só executa o pedido de um gestor autorizado; nada de salvo/banco é tocado.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { M, autorizar } = require('./pontoBanco');
const { lerFuncionario } = require('./pontoRegularizacao');
const fortaleza = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d);
const TIPOS = { entrada: 'Entrada', saida_almoco: 'Saída almoço', retorno_almoco: 'Retorno almoço', saida: 'Saída' };
const SEM_CREDITO = ['Falta injustificada', 'Folga não remunerada', 'Suspensão disciplinar', 'Home Office'];
const idOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const estrito = (d, chaves) => { if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !chaves.includes(k))) throw new HttpsError('invalid-argument', 'Payload inválido.'); };
const falha = c => new HttpsError('failed-precondition', c);

/** aplica as batidas propostas sobre as marcações efetivas do dia (substitui a do mesmo tipo) */
function aplicar(efetivos, lista, funcId, data) {
  let alt = efetivos.slice();
  lista.forEach(j => { alt = alt.filter(r => r.tipo !== j.tipoPonto).concat([{ funcId, data, tipo: j.tipoPonto, hora: j.horarioPonto + ':00' }]); });
  return alt;
}
/** O dia resultante é COERENTE? Marcações presentes em ordem cronológica e intervalo de almoço ≤ 3h (cl. 28ª e / DEC-1).
 *  Dia ainda incompleto por falta de marcação NÃO é incoerente (progresso legítimo); ordem invertida ou almoço absurdo é. */
function coerente(r) {
  const m = [r.entrada, r.saidaAlmoco, r.retornoAlmoco, r.saida].map(h => (h ? M.toMin(h) : null)).filter(v => v !== null);
  for (let i = 1; i < m.length; i++) if (m[i] < m[i - 1]) return false;
  if (r.saidaAlmoco && r.retornoAlmoco && (M.toMin(r.retornoAlmoco) - M.toMin(r.saidaAlmoco)) > 180) return false;
  return true;
}

async function decidirJustificativaHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; estrito(d, ['ids', 'decisao', 'obs']);
  if (!Array.isArray(d.ids) || d.ids.length < 1 || d.ids.length > 4 || !d.ids.every(idOk) || new Set(d.ids).size !== d.ids.length) throw new HttpsError('invalid-argument', 'ids inválidos.');
  if (!['APROVAR', 'REJEITAR', 'SOLICITAR_INFO'].includes(d.decisao)) throw new HttpsError('invalid-argument', 'Decisão inválida.');
  const obs = typeof d.obs === 'string' ? d.obs.trim() : '';
  if (obs.length > 300) throw new HttpsError('invalid-argument', 'Observação longa demais.');
  if (d.decisao !== 'APROVAR' && obs.length < 5) throw new HttpsError('invalid-argument', 'Motivo obrigatório (mín. 5 caracteres).');
  if (d.decisao === 'SOLICITAR_INFO' && d.ids.length !== 1) throw new HttpsError('invalid-argument', 'Solicitação de informação é por justificativa.');
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const agora = opts.now ? opts.now() : new Date();
  const hoje = fortaleza(agora), uid = request.auth.uid;
  const refs = d.ids.map(i => store.collection('justificativas').doc(i));
  // identificação do funcionário (autorização antes da transação; a transação revalida o conteúdo)
  const pre = await Promise.all(refs.map(r => r.get()));
  if (pre.some(x => !x.exists)) throw new HttpsError('not-found', 'Justificativa inexistente.');
  const funcId = pre[0].data().funcId, data = pre[0].data().data;
  if (pre.some(x => x.data().funcId !== funcId || x.data().data !== data)) throw falha('IDS_DE_FUNCIONARIOS_OU_DIAS_DIFERENTES');
  const ator = await autorizar(store, uid, funcId);
  const lockRef = store.collection('ponto_justificativas_lock').doc(funcId + '_' + data);
  return store.runTransaction(async tx => {
    const [lock, protegido, D] = await Promise.all([tx.get(lockRef), tx.get(store.collection('ponto_meses_protegidos').doc(funcId + '_' + data.slice(0, 7))), lerFuncionario(tx, store, funcId)]);
    const atuais = d.ids.map(i => D.just.find(x => x.id === i));
    if (atuais.some(x => !x)) throw new HttpsError('not-found', 'Justificativa inexistente.');
    const alvo = { APROVAR: 'aprovado', REJEITAR: 'rejeitado', SOLICITAR_INFO: 'pendente' }[d.decisao];
    // idempotência: mesmo pedido já efetivado pelo mesmo autor
    if (d.decisao !== 'SOLICITAR_INFO' && atuais.every(x => x.status === alvo && x.respondidoPorUid === uid)) return { ok: true, repetido: true, status: alvo };
    if (atuais.some(x => x.status !== 'pendente')) throw falha('JUSTIFICATIVA_JA_DECIDIDA');
    const assinado = !!protegido.exists || D.esp.some(e => e.mes === data.slice(0, 7) && e.assinado && !e.substituido);
    const efetivos = D.regs.filter(r => r.data === data);
    let corrIds = [];
    if (d.decisao === 'APROVAR') {
      if (assinado) throw falha('MES_COM_ESPELHO_ASSINADO');
      if (data > hoje) throw falha('DATA_FUTURA');
      const doDia = D.just.filter(x => x.data === data);
      const ponto = atuais.filter(x => x.tipoPonto);
      if (ponto.some(x => !x.horarioPonto || !/^\d{2}:\d{2}$/.test(x.horarioPonto) || !TIPOS[x.tipoPonto])) throw falha('JUSTIFICATIVA_SEM_HORARIO_VALIDO');
      if (new Set(ponto.map(x => x.tipoPonto)).size !== ponto.length) throw falha('IDS_COM_MESMA_BATIDA');
      if (ponto.length && ponto.length !== atuais.length) throw falha('MISTURA_DE_CORRECAO_E_OCORRENCIA');
      if (ponto.length) {
        // conflitos com correção já aprovada ou com outra pendente, para a mesma batida
        ponto.forEach(x => {
          const mesma = doDia.filter(o => o.id !== x.id && o.tipoPonto === x.tipoPonto && !d.ids.includes(o.id));
          if (mesma.some(o => o.status === 'aprovado' && o.horarioPonto === x.horarioPonto)) throw falha('BATIDA_JA_CORRIGIDA_COM_O_MESMO_HORARIO');
          if (mesma.some(o => o.status === 'aprovado')) throw falha('CONFLITO_COM_CORRECAO_APROVADA');
          if (mesma.some(o => o.status === 'pendente' && o.horarioPonto !== x.horarioPonto)) throw falha('CONFLITO_ENTRE_PENDENTES_REVISE_E_REJEITE_UMA');
        });
        const antes = M.calcDia(D.func, data, efetivos, D.cred.find(c => c.data === data) || null, doDia.filter(x => x.status === 'aprovado'));
        const depoisRegs = aplicar(efetivos, ponto, funcId, data);
        const outras = doDia.filter(x => x.status === 'aprovado' && !d.ids.includes(x.id));
        const depois = M.calcDia(D.func, data, depoisRegs, D.cred.find(c => c.data === data) || null, outras);
        const parAberto = doDia.some(o => o.status === 'pendente' && !d.ids.includes(o.id) && o.tipoPonto && ['saida_almoco', 'retorno_almoco'].includes(o.tipoPonto) && ponto.some(x => ['saida_almoco', 'retorno_almoco'].includes(x.tipoPonto)));
        if (!coerente(depois)) {
          if (parAberto) throw falha('APROVACAO_ISOLADA_INCOERENTE_APROVE_O_PAR');
          throw falha('RESULTADO_INCOERENTE_REVISE_AS_MARCACOES');
        }
        // aplica: correção aditiva (original nunca apagado)
        ponto.forEach(x => {
          const regId = 'corr_' + x.id;
          const vigentes = efetivos.filter(r => r.tipo === x.tipoPonto);
          vigentes.forEach(r => tx.update(store.collection('registros').doc(r.id), { substituidoPor: regId, substituidoEm: FV.serverTimestamp(), substituidoPorJustificativa: x.id }));
          const originais = vigentes.map(r => ({ id: r.id, hora: r.hora || null, tipo: r.tipo }));
          tx.create(store.collection('registros').doc(regId), { id: regId, funcId, funcNome: x.funcNome || D.func.nome || null, data, hora: x.horarioPonto + ':00', tipo: x.tipoPonto, tipoLabel: TIPOS[x.tipoPonto],
            lat: null, lng: null, dentroRaio: null, foto: null, facialScore: null, lancadoPorJustificativa: true, justificativaId: x.id, correcaoDe: originais.map(o => o.id), valorOriginal: originais,
            valorProposto: x.horarioPonto + ':00', motivoCorrecao: x.motivo || null, descricaoCorrecao: x.descricao || null, solicitadoPorFuncId: funcId, solicitadoEm: x.criadoEm || null,
            aprovadoPorUid: uid, aprovadoPorEmail: ator.email, aprovadoEm: FV.serverTimestamp(), origem: 'pontoJustificativaDecidir', criadoEm: agora.toISOString() });
          corrIds.push({ id: x.id, regId, originais });
        });
      } else {
        // ocorrência (atestado, férias, falta...): crédito de jornada como no fluxo legado
        atuais.forEach(x => {
          if (SEM_CREDITO.includes(x.motivo)) return;
          const dow = new Date(data + 'T12:00:00').getDay();
          const esc = M.escalaDoDia(D.func, data, dow);
          const jornMin = (parseFloat(D.func.jornada) || 8) * 60;
          const minutos = x.motivo === 'Folga compensatória' ? 0 : (esc !== null ? esc : (dow === 6 ? M.JORNADA_SABADO_MIN : jornMin));
          const credId = 'cred_' + funcId + '_' + data;
          tx.set(store.collection('creditos_jornada').doc(credId), { id: credId, funcId, funcNome: x.funcNome || D.func.nome || null, data, minutos, motivo: x.motivo, criadoEm: agora.toISOString() }, { merge: true });
        });
      }
    }
    // gravações de decisão (justificativas + trilha)
    const versao = ((lock.exists && lock.data().versao) || 0) + 1;
    atuais.forEach((x, k) => {
      const c = corrIds.find(z => z.id === x.id);
      const base = d.decisao === 'SOLICITAR_INFO'
        ? { infoSolicitada: obs, infoSolicitadaPorUid: uid, infoSolicitadaPorEmail: ator.email, infoSolicitadaEm: FV.serverTimestamp() }
        : { status: alvo, obsGestor: obs, respondidoPorUid: uid, respondidoPorEmail: ator.email, respondidoEm: FV.serverTimestamp(), decididaPeloServidor: true,
            ...(c ? { registroEfetivoId: c.regId, registrosOriginais: c.originais } : {}), ...(d.ids.length > 1 ? { decididaEmConjuntoCom: d.ids.filter(i => i !== x.id) } : {}) };
      tx.update(refs[k], base);
      tx.create(store.collection('ponto_justificativas_decisoes').doc(x.id + '_' + versao + '_' + k), { justificativaId: x.id, funcId, data, decisao: d.decisao, statusAnterior: x.status, statusResultante: alvo,
        obs, autorUid: uid, autorEmail: ator.email, conjunto: d.ids, tipoPonto: x.tipoPonto || null, horarioPonto: x.horarioPonto || null, mesProtegido: assinado, criadoEm: FV.serverTimestamp() });
    });
    tx.set(lockRef, { funcId, data, versao, atualizadoEm: FV.serverTimestamp() });
    return { ok: true, repetido: false, status: alvo, versao, conjunto: d.ids.length };
  });
}

module.exports = { decidirJustificativaHandler, coerente, aplicar };
