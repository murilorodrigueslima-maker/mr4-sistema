'use strict';
/**
 * Regularização de pendências do ponto e escalas individuais (fase 4.2) — tudo NO BACKEND (transação, idempotente, auditável).
 *  • pontoPendenciaDecidir: registra a decisão da gestão sobre um dia pendente (em análise / encaminhar / justificado sem horário / reabrir /
 *    aplicar a regra do sábado — este único caso escreve em ponto_sabado_correcoes). NÃO cria horários, NÃO altera marcações/justificativas/espelhos.
 *    A correção de horário continua pelo fluxo existente de justificativa "ponto não batido" + aprovação.
 *  • pontoEscalaDefinir: nova versão (append-only, nunca sobrescreve) da escala semanal do funcionário, com vigência e motivo.
 * Funcionário nunca decide: exige módulo ponto, e ninguém atua sobre o PRÓPRIO ponto.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { M, autorizar } = require('./pontoBanco');
const DATA = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const fortaleza = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d);
const DECISOES = { EM_ANALISE: 'em_analise', ENCAMINHAR_REVISAO: 'encaminhado', JUSTIFICADO_SEM_HORARIO: 'justificado', REABRIR: 'pendente', APLICAR_REGRA_SABADO: 'corrigido' };
const estrito = (d, chaves) => { if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !chaves.includes(k))) throw new HttpsError('invalid-argument', 'Payload inválido.'); };
const idOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const motivoOk = m => typeof m === 'string' && m.trim().length >= 5 && m.trim().length <= 300;

async function lerFuncionario(tx, store, funcId) {
  const q = c => tx.get(store.collection(c).where('funcId', '==', funcId));
  const fRef = await tx.get(store.collection('funcionarios').doc(funcId));
  if (!fRef.exists) throw new HttpsError('not-found', 'Funcionário inexistente.');
  const [rg, jt, cr, es, sc, ec] = await Promise.all([q('registros'), q('justificativas'), q('creditos_jornada'), q('espelhos'), q('ponto_sabado_correcoes'), q('ponto_escalas')]);
  const func = { id: fRef.id, ...fRef.data() };
  func.sabadosCorrigidos = {}; sc.docs.forEach(d => { const x = d.data(); if (x.ativa !== false && x.data) func.sabadosCorrigidos[x.data] = true; });
  func.escalas = ec.docs.map(d => d.data());
  return { func, regs: M.registrosEfetivos(rg.docs.map(d => ({ id: d.id, ...d.data() }))), just: jt.docs.map(d => ({ id: d.id, ...d.data() })),
    cred: cr.docs.map(d => d.data()), esp: es.docs.map(d => ({ id: d.id, ...d.data() })) };
}

function diaDe(D, data) {
  return M.calcDia(D.func, data, D.regs.filter(r => r.data === data), D.cred.find(c => c.data === data) || null, D.just.filter(j => j.data === data));
}
function medianaSabado(D) {
  const xs = [...new Set(D.regs.filter(r => new Date(r.data + 'T12:00:00').getDay() === 6).map(r => r.data))]
    .map(d => diaDe({ ...D, func: { ...D.func, sabadosCorrigidos: {} } }, d)).filter(r => r.status === 'ok' && r.entrada).map(r => M.toMin(r.entrada)).sort((a, b) => a - b);
  const n = xs.length; return n ? (n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2) : null;
}

async function decidirHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; estrito(d, ['funcId', 'data', 'decisao', 'motivo']);
  if (!idOk(d.funcId)) throw new HttpsError('invalid-argument', 'funcId inválido.');
  if (typeof d.data !== 'string' || !DATA.test(d.data)) throw new HttpsError('invalid-argument', 'Data inválida.');
  if (!DECISOES[d.decisao]) throw new HttpsError('invalid-argument', 'Decisão inválida.');
  if (!motivoOk(d.motivo)) throw new HttpsError('invalid-argument', 'Motivo obrigatório (5 a 300 caracteres).');
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const agora = opts.now ? opts.now() : new Date();
  const hoje = fortaleza(agora), uid = request.auth.uid;
  if (d.data >= hoje) throw new HttpsError('invalid-argument', 'Só dias já encerrados podem ser regularizados.');
  const ator = await autorizar(store, uid, d.funcId);
  const estRef = store.collection('ponto_pendencias_estado').doc(d.funcId + '_' + d.data);
  return store.runTransaction(async tx => {
    const [est, D] = await Promise.all([tx.get(estRef), lerFuncionario(tx, store, d.funcId)]);
    const r = diaDe(D, d.data);
    const cls = r.pendente ? M.classificarPendenciaDia(D.func, r, { espelhos: D.esp, justificativas: D.just, medianaEntradaSabado: medianaSabado(D) }) : null;
    if (D.esp.some(e => e.mes === d.data.slice(0, 7) && e.assinado && !e.substituido)) throw new HttpsError('failed-precondition', 'MES_COM_ESPELHO_ASSINADO');
    const atual = est.exists ? est.data() : { status: 'pendente', versao: 0 };
    // mesma ordem repetida (retry) ⇒ idempotente, mesmo que o efeito dela já tenha resolvido a pendência
    if (est.exists && atual.ultimaDecisao === d.decisao && atual.ultimoMotivo === d.motivo.trim() && atual.ultimoAutorUid === uid) return { ok: true, repetido: true, status: atual.status };
    if (atual.status === 'corrigido' && d.decisao === 'REABRIR') throw new HttpsError('failed-precondition', 'CORRECAO_APLICADA_USE_REVERSAO_AUDITADA');
    if (d.decisao !== 'REABRIR' && !r.pendente) throw new HttpsError('failed-precondition', 'SEM_PENDENCIA_NESTA_DATA');
    let correcaoCriada = false;
    if (d.decisao === 'APLICAR_REGRA_SABADO') {
      if (!cls || cls.motivo !== 'SABADO_INTERVALO_NULO_NAO_CORRIGIDO' || r.diaSemana !== 6) throw new HttpsError('failed-precondition', 'REGRA_NAO_SE_APLICA_A_ESTA_DATA');
      if (d.data >= M.SABADO_V2_DESDE) throw new HttpsError('failed-precondition', 'DATA_JA_USA_A_REGRA_NOVA');
      const r1 = diaDe({ ...D, func: { ...D.func, sabadosCorrigidos: { ...D.func.sabadosCorrigidos, [d.data]: true } } }, d.data);
      if (r1.status !== 'ok') throw new HttpsError('failed-precondition', 'REGRA_NAO_FECHA_O_DIA');
      const cRef = store.collection('ponto_sabado_correcoes').doc(d.funcId + '_' + d.data);
      const c = await tx.get(cRef);
      if (!c.exists) {
        tx.create(cRef, { funcId: d.funcId, data: d.data, ativa: true, tipo: 'SABADO_INTERVALO_NULO', antes: { status: r.status, pendencia: (r.pendencias[0] || {}).tipo || null },
          depois: { status: 'ok', trabalhadoMin: r1.trabalhadoMin, saldoMin: r1.saldoMin, jornadaMin: r1.jornadaPrevistaMin },
          marcas: { e: r.entrada, sa: r.saidaAlmoco, ra: r.retornoAlmoco, s: r.saida }, criterios: ['INTERVALO_NULO', 'DECISAO_INDIVIDUAL_DA_GESTAO'], regra: 'SABADO_V2_INTERVALO_NULO',
          corteMotor: M.SABADO_V2_DESDE, autorizacao: 'Decisão da gestão na fila de regularização', decididoPorUid: uid, decididoPorEmail: ator.email, motivo: d.motivo.trim(),
          origem: 'pontoPendenciaDecidir', criadoEm: FV.serverTimestamp() });
        correcaoCriada = true;
      }
    }
    const versao = (atual.versao || 0) + 1, status = DECISOES[d.decisao];
    tx.create(store.collection('ponto_pendencias_decisoes').doc(d.funcId + '_' + d.data + '_' + versao), {
      funcId: d.funcId, data: d.data, versao, decisao: d.decisao, statusResultante: status, statusAnterior: atual.status, motivo: d.motivo.trim(),
      classe: cls ? cls.classe : null, causa: cls ? cls.motivo : null, autorUid: uid, autorEmail: ator.email, correcaoCriada, criadoEm: FV.serverTimestamp() });
    tx.set(estRef, { funcId: d.funcId, data: d.data, status, versao, ultimaDecisao: d.decisao, ultimoMotivo: d.motivo.trim(), ultimoAutorUid: uid, atualizadoEm: FV.serverTimestamp() });
    return { ok: true, repetido: false, status, versao, correcaoCriada };
  });
}

/** dias: { '1'..'6': { trabalha:boolean, entrada?, saida?, intervaloMin? } } — domingo não faz parte da escala. */
function normalizarDias(dias) {
  if (!dias || typeof dias !== 'object' || Array.isArray(dias)) throw new HttpsError('invalid-argument', 'Dias inválidos.');
  const out = {};
  for (let w = 1; w <= 6; w++) {
    const x = dias[String(w)];
    if (!x || typeof x !== 'object') throw new HttpsError('invalid-argument', 'Informe todos os dias de segunda a sábado (use "não trabalha").');
    if (x.trabalha === false) { out[String(w)] = { trabalha: false, minutos: 0 }; continue; }
    if (x.trabalha !== true) throw new HttpsError('invalid-argument', 'Campo "trabalha" obrigatório.');
    if (!HHMM.test(x.entrada || '') || !HHMM.test(x.saida || '')) throw new HttpsError('invalid-argument', 'Horários inválidos (HH:MM).');
    const iv = x.intervaloMin === undefined ? 0 : x.intervaloMin;
    if (!Number.isInteger(iv) || iv < 0 || iv > 240) throw new HttpsError('invalid-argument', 'Intervalo inválido.');
    const min = M.toMin(x.saida) - M.toMin(x.entrada) - iv;
    if (!(min > 0) || min > 720) throw new HttpsError('invalid-argument', 'Jornada do dia inválida (saída após a entrada, no máximo 12h).');
    out[String(w)] = { trabalha: true, entrada: x.entrada, saida: x.saida, intervaloMin: iv, minutos: min };
  }
  return out;
}

async function escalaHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; estrito(d, ['funcId', 'vigenteDesde', 'dias', 'motivo']);
  if (!idOk(d.funcId)) throw new HttpsError('invalid-argument', 'funcId inválido.');
  if (typeof d.vigenteDesde !== 'string' || !DATA.test(d.vigenteDesde)) throw new HttpsError('invalid-argument', 'Data de vigência inválida.');
  if (!motivoOk(d.motivo)) throw new HttpsError('invalid-argument', 'Motivo obrigatório (5 a 300 caracteres).');
  const dias = normalizarDias(d.dias);
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const agora = opts.now ? opts.now() : new Date();
  const hoje = fortaleza(agora), uid = request.auth.uid;
  const ator = await autorizar(store, uid, d.funcId);
  const lockRef = store.collection('ponto_escalas_lock').doc(d.funcId);
  return store.runTransaction(async tx => {
    const [lock, f, es, ec] = await Promise.all([tx.get(lockRef), tx.get(store.collection('funcionarios').doc(d.funcId)),
      tx.get(store.collection('espelhos').where('funcId', '==', d.funcId)), tx.get(store.collection('ponto_escalas').where('funcId', '==', d.funcId))]);
    if (!f.exists) throw new HttpsError('not-found', 'Funcionário inexistente.');
    // nova vigência nunca atinge mês com espelho assinado
    const ini = d.vigenteDesde.slice(0, 7);
    if (es.docs.some(x => x.data().assinado && !x.data().substituido && x.data().mes >= ini)) throw new HttpsError('failed-precondition', 'MES_ASSINADO_NA_VIGENCIA');
    const mesmas = ec.docs.map(x => x.data()).filter(x => x.vigenteDesde === d.vigenteDesde);
    const rev = mesmas.reduce((a, x) => Math.max(a, x.rev || 0), 0) + 1;
    const igual = mesmas.find(x => x.rev === rev - 1 && JSON.stringify(x.dias) === JSON.stringify(dias));
    if (igual) return { ok: true, repetido: true, id: d.funcId + '_' + d.vigenteDesde + '_r' + (rev - 1) };
    const id = d.funcId + '_' + d.vigenteDesde + '_r' + rev;
    const retroativa = d.vigenteDesde <= hoje;
    tx.create(store.collection('ponto_escalas').doc(id), { funcId: d.funcId, vigenteDesde: d.vigenteDesde, rev, dias, motivo: d.motivo.trim(), retroativa,
      criadoPorUid: uid, criadoPorEmail: ator.email, criadoEm: FV.serverTimestamp() });
    tx.set(lockRef, { funcId: d.funcId, versao: ((lock.exists && lock.data().versao) || 0) + 1, atualizadoEm: FV.serverTimestamp() });
    return { ok: true, repetido: false, id, rev, retroativa };
  });
}

module.exports = { decidirHandler, escalaHandler, normalizarDias, DECISOES, lerFuncionario };
