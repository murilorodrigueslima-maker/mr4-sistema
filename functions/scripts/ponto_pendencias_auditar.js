#!/usr/bin/env node
'use strict';
// FASE 4.2 — auditoria SOMENTE LEITURA das pendências de ponto atuais (classificadas pela mesma função da tela). Saída em ~/mr4-ops/ponto-banco.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');
const ctx = { console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'modulos/ponto-regras.js'), 'utf8') +
  ';this.X={calcDia,registrosEfetivos,classificarPendenciaDia,toMin,getJornadaPrevista,CLASSE_PENDENCIA};', ctx);
const X = ctx.X;
const fortaleza = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d);
const mediana = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
function auditar({ funcs, regs, cred, just, esp, corr, hoje }) {
  const out = [];
  funcs.forEach((f, i) => {
    const sab = {}; corr.filter(c => c.funcId === f.id && c.ativa !== false).forEach(c => { sab[c.data] = true; });
    const func = { ...f, sabadosCorrigidos: sab };
    const R = regs.filter(r => r.funcId === f.id);
    if (func.controleBancoHoras === false) return;
    const inicio = func.inicioBancoHoras || (R.map(r => r.data).sort()[0] || hoje);
    const datas = [...new Set(R.map(r => r.data))].filter(d => d >= inicio && d < hoje).sort();
    const limpos = datas.filter(d => new Date(d + 'T12:00:00').getDay() === 6).map(d => X.calcDia(func, d, R.filter(r => r.data === d), null, [])).filter(r => r.status === 'ok' && r.entrada).map(r => X.toMin(r.entrada));
    const med = mediana(limpos);
    // dias do calendário sem batida (falta) não são "pendência de ponto incompleto": o motor já os trata como falta
    datas.forEach(d => {
      const r = X.calcDia(func, d, R.filter(x => x.data === d), cred.find(c => c.funcId === f.id && c.data === d) || null, just.filter(j => j.funcId === f.id && j.data === d));
      if (!r.pendente) return;
      const c = X.classificarPendenciaDia(func, r, { espelhos: esp, justificativas: just, medianaEntradaSabado: med });
      out.push({ ref: 'F' + i, funcId: f.id, data: d, diaSemana: r.diaSemana, noBanco: !!func.inicioBancoHoras, jornadaMin: r.jornadaPrevistaMin,
        marcas: { entrada: r.entrada, saidaAlmoco: r.saidaAlmoco, retornoAlmoco: r.retornoAlmoco, saida: r.saida }, statusMotor: r.status, pendencia: (r.pendencias[0] || {}).tipo,
        justificativas: just.filter(j => j.funcId === f.id && j.data === d).map(j => ({ status: j.status, motivo: j.motivo })),
        espelhoAssinado: c.classe === 'PROTEGIDO_ASSINADO', ...c });
    });
  });
  return out;
}
module.exports = { auditar };
if (require.main === module) {
  const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
  const all = async c => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  (async () => {
    const [funcs, regsAll, cred, just, esp, corr] = await Promise.all(['funcionarios', 'registros', 'creditos_jornada', 'justificativas', 'espelhos', 'ponto_sabado_correcoes'].map(all));
    const hoje = fortaleza(new Date());
    const itens = auditar({ funcs, regs: X.registrosEfetivos(regsAll), cred, just, esp, corr, hoje });
    const porClasse = {}, porFunc = {};
    itens.forEach(x => { porClasse[x.classe] = (porClasse[x.classe] || 0) + 1; const k = x.ref + (x.noBanco ? '' : ' (fora do banco)'); porFunc[k] = porFunc[k] || { total: 0, porClasse: {} }; porFunc[k].total++; porFunc[k].porClasse[x.classe] = (porFunc[k].porClasse[x.classe] || 0) + 1; });
    const resumo = { geradoEm: new Date().toISOString(), hoje, total: itens.length, noBanco: itens.filter(x => x.noBanco).length, foraDoBanco: itens.filter(x => !x.noBanco).length, porClasse, porFunc };
    const dir = process.env.HOME + '/mr4-ops/ponto-banco'; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/FASE4_2-pendencias.json', JSON.stringify({ resumo, itens }, null, 1));
    console.log(JSON.stringify(resumo, null, 1));
  })().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
}
