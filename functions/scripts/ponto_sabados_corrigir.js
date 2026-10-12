#!/usr/bin/env node
'use strict';
/**
 * FASE 4.1 — correção retroativa dos sábados classificados como "ponto incompleto" por INTERVALO NULO (sa == ra, ou ra == saída).
 * NUNCA altera marcações, justificativas, créditos, espelhos ou cadastro. Grava 1 documento de auditoria por dia em ponto_sabado_correcoes
 * (id = funcId_data, create-only ⇒ idempotente); o motor consulta esse conjunto. Reversível: --reverter marca ativa:false (histórico preservado).
 * Uso: node scripts/ponto_sabados_corrigir.js                       (SIMULAÇÃO: relatório + JSON)
 *      node scripts/ponto_sabados_corrigir.js --aplicar --backup=/caminho/backup.json
 *      node scripts/ponto_sabados_corrigir.js --reverter=all|<id,id>  [--aplicar]
 * Critérios de elegibilidade (TODOS): sábado anterior ao corte; funcionário no banco, com início cadastrado; dia ainda "incompleto"
 * pelo motor atual e "ok" pelo motor corrigido; 4 marcações (E, SA, RA, S) com sa==ra ou ra==s; sem crédito/justificativa no dia;
 * mês SEM espelho assinado; evidência de escala: ≥2 sábados "limpos" do próprio funcionário, entrada do dia a ≤45 min da mediana deles e
 * total a ≤120 min da jornada de sábado. Qualquer dúvida ⇒ PENDENTE (com motivo).
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : []; }));
const ROOT = path.resolve(__dirname, '../..');
const ctx = { console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'modulos/ponto-regras.js'), 'utf8') +
  ';this.X={calcDia,calcBancoMes,registrosEfetivos,mesesDoBanco,SABADO_V2_DESDE,JORNADA_SABADO_MIN,toMin};', ctx);
const X = ctx.X;
const fortaleza = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d);
const dow = ds => new Date(ds + 'T12:00:00').getDay();
const mediana = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/** Classifica todos os sábados com batida de um funcionário. Puro (recebe dados já carregados). */
function classificar(f, regs, cred, just, esp) {
  const R = regs.filter(r => r.funcId === f.id), out = [];
  const datas = [...new Set(R.filter(r => r.data && dow(r.data) === 6).map(r => r.data))].sort();
  const dia = (func, ds) => X.calcDia(func, ds, R.filter(r => r.data === ds), cred.find(c => c.funcId === f.id && c.data === ds) || null, just.filter(j => j.funcId === f.id && j.data === ds));
  const base = { ...f, sabadosCorrigidos: {} };
  // evidência de escala: sábados "limpos" (já ok pelo motor atual, 2 ou 4 marcações válidas, total plausível)
  const limpos = datas.map(ds => ({ ds, r: dia(base, ds) })).filter(x => x.r.status === 'ok' && x.r.entrada && x.r.saida && x.r.trabalhadoMin >= 150 && x.r.trabalhadoMin <= 330);
  const medEntrada = mediana(limpos.map(x => X.toMin(x.r.entrada)));
  datas.forEach(ds => {
    const r0 = dia(base, ds);
    if (r0.status === 'ok' || r0.status === 'fora_periodo' || r0.status === 'credito') return;            // não é pendência de ponto
    const e = { funcId: f.id, data: ds, antes: { status: r0.status, pendencia: (r0.pendencias[0] || {}).tipo || null }, marcas: { e: r0.entrada, sa: r0.saidaAlmoco, ra: r0.retornoAlmoco, s: r0.saida } };
    const pend = m => { e.classe = 'PENDENTE'; e.motivo = m; out.push(e); };
    if (ds >= X.SABADO_V2_DESDE) return;
    if (f.controleBancoHoras === false) return pend('FORA_DO_BANCO');
    if (!f.inicioBancoHoras) return pend('SEM_DATA_DE_INICIO_DO_BANCO');
    if (ds < f.inicioBancoHoras) return pend('ANTES_DO_INICIO_DO_BANCO');
    if (r0.status === 'inconsistente') return pend('MARCACOES_INCONSISTENTES');
    if (esp.some(x => x.funcId === f.id && x.mes === ds.slice(0, 7) && x.assinado && !x.substituido)) {
      // espelho assinado: NADA é alterado; só relatório da divergência (o que a regra corrigida daria × o que foi assinado/congelado)
      const hip = dia({ ...f, sabadosCorrigidos: { [ds]: true } }, ds);
      e.classe = 'ASSINADO'; e.motivo = 'MES_COM_ESPELHO_ASSINADO';
      e.divergencia = { status: hip.status, trabalhadoMin: hip.trabalhadoMin, saldoMin: hip.saldoMin, ocorrenciaOutra: cred.some(c => c.funcId === f.id && c.data === ds) || just.some(j => j.funcId === f.id && j.data === ds) };
      return out.push(e);
    }
    if (cred.some(c => c.funcId === f.id && c.data === ds) || just.some(j => j.funcId === f.id && j.data === ds)) return pend('OUTRA_OCORRENCIA_NO_DIA_REVISAO_MANUAL');
    const m = e.marcas;
    if (!(m.e && m.sa && m.ra && m.s)) return pend('MARCACOES_FALTANTES');
    const tE = X.toMin(m.e), tSa = X.toMin(m.sa), tRa = X.toMin(m.ra), tS = X.toMin(m.s);
    if (!(tE <= tSa && tSa <= tRa && tRa <= tS) || !(tSa === tRa || tRa === tS)) return pend('PADRAO_DE_MARCACOES_FORA_DA_CAUSA_INTERVALO_NULO');
    const r1 = dia({ ...f, sabadosCorrigidos: { [ds]: true } }, ds);
    if (r1.status !== 'ok') return pend('MOTOR_CORRIGIDO_NAO_FECHA_O_DIA');
    if (limpos.length < 2) return pend('ESCALA_DESCONHECIDA_SEM_EVIDENCIA_SUFICIENTE');
    if (Math.abs(tE - medEntrada) > 45) return pend('ENTRADA_FORA_DO_PADRAO_DO_FUNCIONARIO');
    if (Math.abs(r1.trabalhadoMin - X.JORNADA_SABADO_MIN) > 120) return pend('TOTAL_FORA_DA_JORNADA_DE_SABADO');
    e.classe = 'ELEGIVEL'; e.depois = { status: 'ok', trabalhadoMin: r1.trabalhadoMin, saldoMin: r1.saldoMin, jornadaMin: r1.jornadaPrevistaMin };
    e.criterios = ['INTERVALO_NULO', tSa === tRa ? 'SA_IGUAL_RA' : 'RA_IGUAL_SAIDA', 'ESCALA_COMPROVADA_POR_SABADOS_LIMPOS(' + limpos.length + ')', 'SEM_OUTRA_OCORRENCIA', 'MES_NAO_ASSINADO'];
    out.push(e);
  });
  return { itens: out, limpos: limpos.length, medianaEntrada: medEntrada === null ? null : hm(Math.round(medEntrada)) };
}

/** Pendências/horas por funcionário antes × depois (meses do banco). */
function impacto(f, regs, cred, just, corrigidos, hoje) {
  const ontem = fortaleza(new Date(Date.parse(hoje + 'T12:00:00Z') - 86400000)), mAtual = hoje.slice(0, 7);
  const ms = X.mesesDoBanco(f.inicioBancoHoras, mAtual); if (!ms.length || f.controleBancoHoras === false) return null;
  const soma = (corr) => ms.reduce((a, m) => {
    const r = X.calcBancoMes({ ...f, sabadosCorrigidos: corr }, regs.filter(x => x.funcId === f.id && x.data && x.data.startsWith(m)), cred.filter(c => c.funcId === f.id && c.data && c.data.startsWith(m)), m, m === mAtual ? ontem : hoje, just.filter(j => j.funcId === f.id && j.data && j.data.startsWith(m)));
    return { pend: a.pend + r.pendencias.length, trab: a.trab + r.trabMin, saldo: a.saldo + r.saldo, dias: a.dias + r.diasTrab };
  }, { pend: 0, trab: 0, saldo: 0, dias: 0 });
  const antes = soma({}), depois = soma(corrigidos);
  return { pendenciasAntes: antes.pend, pendenciasDepois: depois.pend, horasAntesMin: antes.trab, horasDepoisMin: depois.trab, saldoAntesMin: antes.saldo, saldoDepoisMin: depois.saldo,
    deltaSaldoMin: depois.saldo - antes.saldo, deltaHorasMin: depois.trab - antes.trab };
}

/** Grava a auditoria (create-only, id = funcId_data): execução repetida não cria nada. */
async function aplicarCorrecoes(db, FieldValue, elegiveis) {
  let criados = 0, existentes = 0;
  for (const x of elegiveis) {
    const ref = db.collection('ponto_sabado_correcoes').doc(x.funcId + '_' + x.data);
    await db.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) { existentes++; return; }
      tx.create(ref, { funcId: x.funcId, data: x.data, ativa: true, tipo: 'SABADO_INTERVALO_NULO', antes: x.antes, depois: x.depois, marcas: x.marcas, criterios: x.criterios,
        regra: 'SABADO_V2_INTERVALO_NULO', corteMotor: X.SABADO_V2_DESDE, autorizacao: 'Proprietário — Fase 4.1 (11/10/2026)', origem: 'scripts/ponto_sabados_corrigir.js', criadoEm: FieldValue.serverTimestamp() });
      criados++;
    });
  }
  return { criados, existentes };
}
module.exports = { classificar, impacto, aplicarCorrecoes };


if (require.main === module) {
  const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
  const all = async c => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  (async () => {
    const hoje = fortaleza(new Date());
    const [fs_, regsAll, cred, just, esp, exist] = await Promise.all([all('funcionarios'), all('registros'), all('creditos_jornada'), all('justificativas'), all('espelhos'), all('ponto_sabado_correcoes')]);
    const regs = X.registrosEfetivos(regsAll);
    const hashCol = rows => crypto.createHash('sha1').update(JSON.stringify(rows.slice().sort((a, b) => a.id < b.id ? -1 : 1))).digest('hex');
    const hashes = () => ({ registros: hashCol(regsAll), justificativas: hashCol(just), creditos_jornada: hashCol(cred), espelhos: hashCol(esp), funcionarios: hashCol(fs_) });
    if (args.reverter) {
      const ids = args.reverter === 'all' ? exist.map(x => x.id) : String(args.reverter).split(',');
      console.log(JSON.stringify({ modo: args.aplicar ? 'REVERTER' : 'SIMULACAO_REVERSAO', ids: ids.length }));
      if (args.aplicar) for (const id of ids) await db.collection('ponto_sabado_correcoes').doc(id).update({ ativa: false, revertidaEm: admin.firestore.FieldValue.serverTimestamp() });
      return;
    }
    const resultado = []; const resumo = {};
    fs_.forEach((f, i) => {
      const c = classificar(f, regs, cred, just, esp);
      const jaCorrigidos = {}; exist.filter(x => x.funcId === f.id && x.ativa !== false).forEach(x => { jaCorrigidos[x.data] = true; });
      const novos = c.itens.filter(x => x.classe === 'ELEGIVEL' && !jaCorrigidos[x.data]);
      const todosCorr = { ...jaCorrigidos }; novos.forEach(x => { todosCorr[x.data] = true; });
      const imp = impacto(f, regs, cred, just, todosCorr, hoje);
      const cnt = k => c.itens.filter(x => x.classe === k).length;
      resumo['F' + i] = { cargo: (f.cargo || '').trim(), sabadosIncompletos: c.itens.length, elegiveis: cnt('ELEGIVEL'), jaCorrigidos: Object.keys(jaCorrigidos).length, assinadosPreservados: cnt('ASSINADO'), pendentes: cnt('PENDENTE'),
        evidenciaEscala: c.limpos, medianaEntrada: c.medianaEntrada, motivosPendencia: c.itens.filter(x => x.classe === 'PENDENTE').reduce((a, x) => (a[x.motivo] = (a[x.motivo] || 0) + 1, a), {}), impacto: imp };
      c.itens.forEach(x => resultado.push({ ref: 'F' + i, ...x }));
    });
    const antes = hashes();
    const out = { geradoEm: new Date().toISOString(), hoje, corte: X.SABADO_V2_DESDE, resumo, itens: resultado, hashesAntes: antes };
    const dir = process.env.HOME + '/mr4-ops/ponto-banco'; fs.mkdirSync(dir, { recursive: true });
    if (!args.aplicar) {
      fs.writeFileSync(dir + '/FASE4_1-simulacao.json', JSON.stringify(out, null, 1));
      console.log(JSON.stringify({ modo: 'SIMULACAO', resumo }, null, 1)); return;
    }
    if (!args.backup) throw new Error('--aplicar exige --backup=<arquivo> (exporte antes)');
    fs.writeFileSync(args.backup, JSON.stringify({ geradoEm: out.geradoEm, hashes: antes, funcionarios: fs_, registros: regsAll, justificativas: just, creditos_jornada: cred, espelhos: esp, ponto_sabado_correcoes: exist }));
    const { criados, existentes } = await aplicarCorrecoes(db, admin.firestore.FieldValue, resultado.filter(r => r.classe === 'ELEGIVEL'), out.geradoEm);
    const regsDepois = await all('registros');
    const hDepois = { registros: hashCol(regsDepois), justificativas: hashCol(await all('justificativas')), creditos_jornada: hashCol(await all('creditos_jornada')), espelhos: hashCol(await all('espelhos')), funcionarios: hashCol(await all('funcionarios')) };
    fs.writeFileSync(dir + '/FASE4_1-aplicacao.json', JSON.stringify({ ...out, criados, existentes, hashesDepois: hDepois, historicoIntacto: JSON.stringify(antes) === JSON.stringify(hDepois) }, null, 1));
    console.log(JSON.stringify({ modo: 'APLICADO', criados, existentes, historicoIntacto: JSON.stringify(antes) === JSON.stringify(hDepois) }));
  })().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
}
