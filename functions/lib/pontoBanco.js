'use strict';
/**
 * Banco de horas — compensação de faltas e estorno NO BACKEND (transação atômica).
 *  • O saldo é recalculado AQUI (motor único copiado de modulos/ponto-regras.js; teste de igualdade impede divergência), nunca confiado ao cliente.
 *  • Idempotência/duplicidade: id do lançamento = funcId_dataAusencia (tx.create falha se existir). Concorrência: todo lançamento do funcionário lê e
 *    regrava o documento-trava banco_horas_saldo/{funcId} na MESMA transação → dois lançamentos simultâneos serializam; o 2º reavalia o saldo.
 *  • Débito duplo: o motor já debita falta (−jornada). O lançamento só cobra o que o motor NÃO debitou (calcBancoAcumulado/avaliarCompensacao).
 *  • Política: nada é presumido. Sem banco_horas_config/politica com os interruptores explícitos, a operação é recusada. Saldo negativo exige
 *    permiteSaldoNegativo===true E limiteNegativoMin inteiro > 0 cadastrados. Prazo (prazoCompensacaoDias) é informativo: nenhuma ação automática.
 *  • NUNCA desconta em folha/rescisão e nunca toca marcações, justificativas, espelhos ou crédito de jornada (só lê).
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { HttpsError } = require('firebase-functions/v2/https');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'ponto-regras.copy.js'), 'utf8') +
  ';this.X={calcBancoAcumulado,avaliarCompensacao,montarMesesBanco,mesesDoBanco,registrosEfetivos,compensacoesVigentes,idCompensacao,fmtMin};', ctx);
const M = ctx.X;
const DATA = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const negar = () => new HttpsError('permission-denied', 'Sem permissão para o banco de horas.');
const fortaleza = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d);
const diaAnterior = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10); };

/** Política válida e explícita. Retorna { ok, motivo? , pol }. */
function lerPolitica(p) {
  p = p || {};
  if (p.compensacaoAtiva !== true || p.acumulativoAtivo !== true) return { ok: false, motivo: 'BANCO_DESLIGADO' };
  const pol = { permiteSaldoNegativo: p.permiteSaldoNegativo === true, limiteNegativoMin: Number.isInteger(p.limiteNegativoMin) && p.limiteNegativoMin > 0 ? p.limiteNegativoMin : null,
    prazoCompensacaoDias: Number.isInteger(p.prazoCompensacaoDias) && p.prazoCompensacaoDias > 0 ? p.prazoCompensacaoDias : null, baseJuridica: typeof p.baseJuridica === 'string' ? p.baseJuridica : '' };
  if (pol.permiteSaldoNegativo && pol.limiteNegativoMin === null) return { ok: false, motivo: 'POLITICA_INCOMPLETA_SEM_LIMITE_NEGATIVO' };   // negativo só com limite explícito
  return { ok: true, pol };
}

async function autorizar(store, uid, funcId) {
  const [u, s] = await Promise.all([store.collection('users').doc(uid).get(), store.collection('sistema_usuarios').doc(uid).get()]);
  if (!u.exists || !s.exists || u.data().ativo !== true || s.data().bloqueado === true || !['gestor', 'funcionario'].includes(u.data().role)) throw negar();
  const mods = Array.isArray(s.data().modulos) ? s.data().modulos : [];
  if (!(s.data().admin === true || mods.includes('ponto'))) throw negar();
  if (u.data().funcionarioId && u.data().funcionarioId === funcId) throw negar();       // ninguém mexe no PRÓPRIO banco
  return { email: String(s.data().email || u.data().email || '') };
}

/** Carrega o necessário DENTRO da transação e devolve { rows, meses, lf, func }. */
async function carregarBanco(tx, store, funcId, hoje) {
  const fRef = store.collection('funcionarios').doc(funcId); const f = await tx.get(fRef);
  if (!f.exists) throw new HttpsError('not-found', 'Funcionário inexistente.');
  const func = { id: f.id, ...f.data() };
  if (func.controleBancoHoras === false) throw new HttpsError('failed-precondition', 'Funcionário fora do banco de horas.');
  const mAtual = hoje.slice(0, 7), ms = M.mesesDoBanco(func.inicioBancoHoras, mAtual);
  if (!ms.length) throw new HttpsError('failed-precondition', 'SEM_DATA_DE_INICIO_DO_BANCO');       // nunca presume data
  const q = c => tx.get(store.collection(c).where('funcId', '==', funcId));
  const [rg, jt, cr, es, lc] = await Promise.all([q('registros'), q('justificativas'), q('creditos_jornada'), q('espelhos'), q('banco_horas_lancamentos')]);
  const regs = M.registrosEfetivos(rg.docs.map(d => ({ id: d.id, ...d.data() }))), just = jt.docs.map(d => ({ id: d.id, ...d.data() })), cred = cr.docs.map(d => ({ id: d.id, ...d.data() }));
  const esp = es.docs.map(d => ({ id: d.id, ...d.data() })), lf = lc.docs.map(d => ({ id: d.id, ...d.data() }));
  const dados = ms.map(m => ({ mes: m, regs: regs.filter(r => r.data && r.data.startsWith(m)), cred: cred.filter(c => c.data && c.data.startsWith(m)), just: just.filter(j => j.data && j.data.startsWith(m)) }));
  const meses = M.montarMesesBanco(func, dados, esp, hoje, diaAnterior(hoje), mAtual);
  return { func, meses, lf, rows: M.calcBancoAcumulado(meses, lf), espelhos: esp };
}

function validarPayload(d, chaves) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !chaves.includes(k))) throw new HttpsError('invalid-argument', 'Payload inválido.');
}
const motivoOk = m => typeof m === 'string' && m.trim().length >= 5 && m.trim().length <= 300;

async function compensarHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; validarPayload(d, ['funcId', 'dataAusencia', 'minutos', 'motivo']);
  if (typeof d.funcId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(d.funcId)) throw new HttpsError('invalid-argument', 'funcId inválido.');
  if (typeof d.dataAusencia !== 'string' || !DATA.test(d.dataAusencia)) throw new HttpsError('invalid-argument', 'Data inválida.');
  if (!Number.isInteger(d.minutos) || d.minutos <= 0 || d.minutos > 1440) throw new HttpsError('invalid-argument', 'Horas inválidas.');
  if (!motivoOk(d.motivo)) throw new HttpsError('invalid-argument', 'Motivo obrigatório (5 a 300 caracteres).');
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const agora = (opts.now ? opts.now() : new Date());
  const uid = request.auth.uid, hoje = fortaleza(agora);
  if (d.dataAusencia > hoje) throw new HttpsError('invalid-argument', 'A data da ausência não pode ser futura.');
  const ator = await autorizar(store, uid, d.funcId);
  const id = M.idCompensacao(d.funcId, d.dataAusencia), lRef = store.collection('banco_horas_lancamentos').doc(id), lockRef = store.collection('banco_horas_saldo').doc(d.funcId);
  return store.runTransaction(async tx => {
    const cfg = await tx.get(store.collection('banco_horas_config').doc('politica')); const P = lerPolitica(cfg.exists ? cfg.data() : null);
    if (!P.ok) throw new HttpsError('failed-precondition', P.motivo);
    const [lock, ja] = await Promise.all([tx.get(lockRef), tx.get(lRef)]);
    if (ja.exists) {
      const x = ja.data();
      if (x.minutos === d.minutos && x.aprovadoPorUid === uid) return { ok: true, repetido: true, id };    // mesma ordem repetida (retry) ⇒ idempotente
      throw new HttpsError('already-exists', 'JA_EXISTE_COMPENSACAO_PARA_ESTA_AUSENCIA');
    }
    const B = await carregarBanco(tx, store, d.funcId, hoje);
    const mes = B.meses.find(m => m.mes === d.dataAusencia.slice(0, 7));
    if (!mes) throw new HttpsError('failed-precondition', 'DATA_FORA_DO_PERIODO_DO_BANCO');
    const dia = mes.dias.find(x => x.data === d.dataAusencia), deb = dia && dia.contaNoSaldo && dia.saldoMin < 0 ? -dia.saldoMin : 0;
    const ult = B.rows[B.rows.length - 1];
    const av = M.avaliarCompensacao(ult.saldoFinal, deb, d.minutos, P.pol);
    if (!av.ok) throw new HttpsError('failed-precondition', av.motivo);
    tx.create(lRef, { funcId: d.funcId, tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: d.dataAusencia, competencia: d.dataAusencia.slice(0, 7), minutos: d.minutos, motivo: d.motivo.trim(),
      aprovadoPorUid: uid, aprovadoPorEmail: ator.email, saldoAntesMin: av.saldoAntesMin, saldoDepoisMin: av.saldoDepoisMin, debitoMotorDiaMin: deb, saldoNegativo: av.negativo,
      mesAssinado: !!(mes.congelado || mes.origem === 'ASSINADO_SEM_SNAPSHOT'), descontoFolha: false, criadoEm: FV.serverTimestamp() });
    tx.set(lockRef, { funcId: d.funcId, versao: (lock.exists ? (lock.data().versao || 0) : 0) + 1, atualizadoEm: FV.serverTimestamp() });
    return { ok: true, repetido: false, id, saldoAntesMin: av.saldoAntesMin, saldoDepoisMin: av.saldoDepoisMin, negativo: av.negativo };
  });
}

async function estornarHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; validarPayload(d, ['lancamentoId', 'motivo']);
  if (typeof d.lancamentoId !== 'string' || !/^[A-Za-z0-9_-]{1,64}_20\d{2}-\d{2}-\d{2}$/.test(d.lancamentoId)) throw new HttpsError('invalid-argument', 'Lançamento inválido.');
  if (!motivoOk(d.motivo)) throw new HttpsError('invalid-argument', 'Motivo obrigatório (5 a 300 caracteres).');
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const uid = request.auth.uid;
  const col = store.collection('banco_horas_lancamentos'), lRef = col.doc(d.lancamentoId), eRef = col.doc('est_' + d.lancamentoId);
  const pre = await lRef.get(); if (!pre.exists || pre.data().tipo !== 'COMPENSACAO_AUSENCIA') throw new HttpsError('not-found', 'Compensação inexistente.');
  const ator = await autorizar(store, uid, pre.data().funcId);
  const lockRef = store.collection('banco_horas_saldo').doc(pre.data().funcId);
  return store.runTransaction(async tx => {
    const cfg = await tx.get(store.collection('banco_horas_config').doc('politica'));
    if (!cfg.exists || cfg.data().compensacaoAtiva !== true) throw new HttpsError('failed-precondition', 'BANCO_DESLIGADO');
    const [l, e, lock] = await Promise.all([tx.get(lRef), tx.get(eRef), tx.get(lockRef)]);
    if (!l.exists) throw new HttpsError('not-found', 'Compensação inexistente.');
    if (e.exists) return { ok: true, repetido: true };
    tx.create(eRef, { funcId: l.data().funcId, tipo: 'ESTORNO', estornaId: d.lancamentoId, competencia: l.data().competencia, minutos: l.data().minutos, motivo: d.motivo.trim(),
      aprovadoPorUid: uid, aprovadoPorEmail: ator.email, criadoEm: FV.serverTimestamp() });
    tx.set(lockRef, { funcId: l.data().funcId, versao: (lock.exists ? (lock.data().versao || 0) : 0) + 1, atualizadoEm: FV.serverTimestamp() });
    return { ok: true, repetido: false };
  });
}

module.exports = { compensarHandler, estornarHandler, lerPolitica, carregarBanco, M };
