#!/usr/bin/env node
'use strict';
// FASE 4.3 — auditoria SOMENTE LEITURA das justificativas pendentes (classificação e recomendação; nenhuma decisão é tomada).
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');
const ctx = { console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'modulos/ponto-regras.js'), 'utf8') +
  ';this.X={calcDia,registrosEfetivos,classificarPendenciaDia,toMin,fmtMin,calcTotal};', ctx);
const X = ctx.X;
const fortaleza = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d);
const ROT = { entrada: 'Entrada', saida_almoco: 'Saída almoço', retorno_almoco: 'Retorno almoço', saida: 'Saída' };

function auditar({ funcs, regsAll, cred, just, esp, corr, hoje }) {
  const regs = X.registrosEfetivos(regsAll);
  const out = [];
  const pend = just.filter(j => j.status === 'pendente');
  pend.forEach(j => {
    const f = funcs.find(x => x.id === j.funcId) || { id: j.funcId, jornada: 8 };
    const sab = {}; corr.filter(c => c.funcId === f.id && c.ativa !== false).forEach(c => { sab[c.data] = true; });
    const func = { ...f, sabadosCorrigidos: sab };
    const R = regs.filter(r => r.funcId === f.id && r.data === j.data);
    const original = regsAll.filter(r => r.funcId === f.id && r.data === j.data);
    const r = X.calcDia(func, j.data, R, cred.find(c => c.funcId === f.id && c.data === j.data) || null, just.filter(x => x.funcId === f.id && x.data === j.data));
    const assinado = esp.some(e => e.funcId === f.id && e.mes === j.data.slice(0, 7) && e.assinado && !e.substituido);
    const marcas = { entrada: r.entrada, saidaAlmoco: r.saidaAlmoco, retornoAlmoco: r.retornoAlmoco, saida: r.saida };
    const mesmasNoDia = just.filter(x => x.funcId === j.funcId && x.data === j.data && x.id !== j.id);
    const duplicada = mesmasNoDia.filter(x => x.tipoPonto === j.tipoPonto && x.horarioPonto === j.horarioPonto && x.status !== 'rejeitado');
    const aprovadaMesmaBatida = mesmasNoDia.filter(x => x.tipoPonto && x.tipoPonto === j.tipoPonto && x.status === 'aprovado');
    const correcoes = original.filter(x => x.lancadoPorJustificativa || x.correcaoDe).length;
    const batidaVigente = j.tipoPonto ? marcas[{ entrada: 'entrada', saida_almoco: 'saidaAlmoco', retorno_almoco: 'retornoAlmoco', saida: 'saida' }[j.tipoPonto]] : null;
    const item = {
      id: j.id, funcId: j.funcId, data: j.data, diaSemana: r.diaSemana, motivo: j.motivo, descricao: j.descricao || '', tipoOcorrencia: j.tipoPonto ? 'PONTO_NAO_BATIDO' : 'OUTRA_OCORRENCIA',
      batidaAlegada: j.tipoPonto ? ROT[j.tipoPonto] : null, horarioAlegado: j.horarioPonto || null,
      jornadaPrevistaMin: r.jornadaPrevistaMin, marcas, marcasFaltantes: ['entrada', 'saidaAlmoco', 'retornoAlmoco', 'saida'].filter(k => !marcas[k]),
      statusMotor: r.status, evidencia: { anexo: !!j.anexo, anexoNome: j.anexoNome || null, anexoTipo: j.anexoTipo || null, evidenciaGestao: j.evidenciaGestao || null },
      lancadoPorGestor: !!j.lancadoPorGestor, criadoEm: j.criadoEm || null, status: j.status,
      correcoesNoDia: correcoes, espelhoAssinado: assinado,
      outrasNoDia: mesmasNoDia.map(x => ({ status: x.status, motivo: x.motivo })), duplicadaDe: duplicada.map(x => x.id), aprovadaMesmaBatida: aprovadaMesmaBatida.map(x => x.id),
    };
    // impacto estimado SE aprovadas JUNTAS (todas as pendentes de batida do mesmo dia) — não é decisão
    const doDia = pend.filter(x => x.funcId === j.funcId && x.data === j.data && x.tipoPonto && x.horarioPonto);
    if (doDia.length > 1) {
      let alt = R.slice();
      doDia.forEach(x => { alt = alt.filter(y => y.tipo !== x.tipoPonto).concat([{ funcId: f.id, data: j.data, tipo: x.tipoPonto, hora: x.horarioPonto + ':00' }]); });
      const rj = X.calcDia(func, j.data, alt, cred.find(c => c.funcId === f.id && c.data === j.data) || null, just.filter(x => x.funcId === f.id && x.data === j.data && x.status !== 'pendente'));
      item.parDoDia = doDia.map(x => ({ id: x.id, batida: ROT[x.tipoPonto], horario: x.horarioPonto }));
      item.impactoSeAprovadasJuntas = { statusDepois: rj.status, trabalhadoMin: rj.trabalhadoMin, saldoDiaMin: rj.saldoMin, fechaODia: rj.status === 'ok' };
    }
    // impacto estimado SE aprovada (não é decisão): recalcula o dia com a batida alegada em lugar da vigente
    if (j.tipoPonto && j.horarioPonto) {
      const alt = R.filter(x => x.tipo !== j.tipoPonto).concat([{ funcId: f.id, data: j.data, tipo: j.tipoPonto, hora: j.horarioPonto + ':00' }]);
      const r2 = X.calcDia(func, j.data, alt, cred.find(c => c.funcId === f.id && c.data === j.data) || null, just.filter(x => x.funcId === f.id && x.data === j.data && x.id !== j.id));
      item.impactoSeAprovada = { statusDepois: r2.status, trabalhadoMin: r2.trabalhadoMin, saldoDiaMin: r2.saldoMin, fechaODia: r2.status === 'ok' };
    }
    // classificação (1..5) + recomendação fundamentada; a decisão final é da gestão
    const futura = j.data > hoje;
    item.dataFutura = futura;
    const aprovConflito = aprovadaMesmaBatida.map(x => just.find(y => y.id === x.id)).filter(Boolean);
    if (futura) { item.classe = 3; item.rotulo = 'POSSIVEL_ERRO_TECNICO'; item.recomendacao = 'Data POSTERIOR a hoje (' + j.data + '): uma justificativa de ponto não pode referir-se a um dia que ainda não ocorreu. Provável erro de digitação/seleção de data; recusar ou pedir correção da data.'; out.push(item); return; }
    if (assinado) { item.classe = 5; item.rotulo = 'PROTEGIDA_POR_ESPELHO_ASSINADO'; item.recomendacao = 'Não decidir aqui: mês com espelho assinado. Qualquer correção exige procedimento explícito.'; }
    else if (aprovadaMesmaBatida.length || duplicada.length) { item.classe = 4; item.rotulo = 'DUPLICADA_OU_RESOLVIDA'; item.recomendacao = aprovadaMesmaBatida.length ? 'Já existe correção APROVADA para esta mesma batida neste dia (' + aprovConflito.map(x => x.horarioPonto).join(', ') + '); esta propõe ' + j.horarioPonto + ' — conflito. Rejeitar/arquivar, salvo nova evidência.' : 'Já existe justificativa equivalente para a mesma batida neste dia; arquivar como duplicata após conferir.'; }
    else if (j.tipoPonto && batidaVigente && j.horarioPonto && batidaVigente.slice(0, 5) === j.horarioPonto) { item.classe = 4; item.rotulo = 'DUPLICADA_OU_RESOLVIDA'; item.recomendacao = 'A batida já consta com o mesmo horário; a justificativa é redundante.'; }
    else if (!j.tipoPonto) { item.classe = 2; item.rotulo = 'NECESSITA_INFORMACAO_COMPLEMENTAR'; item.recomendacao = 'Ocorrência sem horário a corrigir: conferir motivo e comprovante antes de decidir.'; }
    else if (r.pendencias.some(p => p.tipo === 'DATA_INCONSISTENCY')) { item.classe = 3; item.rotulo = 'POSSIVEL_ERRO_TECNICO'; item.recomendacao = 'O dia está inconsistente por correção dupla/sem critério; revisar antes de aprovar.'; }
    else if (r.diaSemana === 6 && j.tipoPonto && j.horarioPonto && marcas.saidaAlmoco && marcas.retornoAlmoco && marcas.saidaAlmoco === marcas.retornoAlmoco) { item.classe = 3; item.rotulo = 'POSSIVEL_ERRO_TECNICO'; item.recomendacao = 'Sábado com intervalo nulo; o sistema antigo tratava como incompleto. Confirmar o horário alegado com o funcionário antes de aprovar.'; }
    else if (item.impactoSeAprovadasJuntas && !item.evidencia.anexo && !j.descricao) {
      item.classe = 2; item.rotulo = 'NECESSITA_INFORMACAO_COMPLEMENTAR';
      const j2 = item.impactoSeAprovadasJuntas;
      item.recomendacao = 'Par de justificativas (' + item.parDoDia.map(x => x.batida + ' ' + x.horario).join(' + ') + ') sem descrição nem anexo. As marcações reais do dia têm saída/retorno de almoço registrados no fim do expediente (' + (marcas.saidaAlmoco || '—') + '/' + (marcas.retornoAlmoco || '—') + '). Aprovadas juntas o dia ' + (j2.fechaODia ? 'fecha com ' + X.fmtMin(j2.trabalhadoMin) + ' (saldo ' + X.fmtMin(j2.saldoDiaMin) + ')' : 'continua pendente') + '. Aprovar uma só do par produz resultado incoerente. Solicitar relato/comprovação ao funcionário; não aprovar em lote.';
    }
    else if (!item.evidencia.anexo && !item.evidencia.evidenciaGestao && !j.descricao) { item.classe = 2; item.rotulo = 'NECESSITA_INFORMACAO_COMPLEMENTAR'; item.recomendacao = 'Sem descrição nem anexo/evidência: solicitar informação ao funcionário.'; }
    else { item.classe = 1; item.rotulo = 'PRONTA_PARA_DECISAO'; item.recomendacao = 'Há horário alegado e descrição; conferir a coerência com as demais marcações do dia e decidir.'; }
    out.push(item);
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
    const itens = auditar({ funcs, regsAll, cred, just, esp, corr, hoje });
    itens.forEach(i => { const k = funcs.findIndex(f => f.id === i.funcId); i.ref = 'F' + k; i.cargo = ((funcs[k] || {}).cargo || '').trim(); });
    const por = {}; itens.forEach(i => por[i.rotulo] = (por[i.rotulo] || 0) + 1);
    const dir = process.env.HOME + '/mr4-ops/ponto-banco'; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/FASE4_3-justificativas.json', JSON.stringify({ geradoEm: new Date().toISOString(), hoje, total: itens.length, porClasse: por, itens }, null, 1));
    const md = ['# Fase 4.3 — justificativas pendentes (' + hoje + ')', '', '| # | Func | Data | Dia | Motivo informado | Marcações atuais (E/SA/RA/S) | Jornada | Evidência | Impacto isolado | Impacto do par | Classe | Recomendação |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
    const dnome = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    itens.slice().sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : 0).forEach((i, n) => md.push('| ' + (n + 1) + ' | ' + i.ref + ' | ' + i.data + ' | ' + dnome[i.diaSemana] + ' | ' + i.motivo + ' | ' +
      [i.marcas.entrada, i.marcas.saidaAlmoco, i.marcas.retornoAlmoco, i.marcas.saida].map(v => v || '—').join(' / ') + ' | ' + X.fmtMin(i.jornadaPrevistaMin) + ' | ' + (i.evidencia.anexo ? 'anexo' : 'nenhuma') + (i.descricao ? ' + desc.' : '') + ' | ' +
      (i.impactoSeAprovada ? (i.impactoSeAprovada.fechaODia ? 'fecha: ' + X.fmtMin(i.impactoSeAprovada.trabalhadoMin) + ' (' + X.fmtMin(i.impactoSeAprovada.saldoDiaMin) + ')' : 'segue pendente') : '—') + ' | ' +
      (i.impactoSeAprovadasJuntas ? (i.impactoSeAprovadasJuntas.fechaODia ? 'fecha: ' + X.fmtMin(i.impactoSeAprovadasJuntas.trabalhadoMin) + ' (' + X.fmtMin(i.impactoSeAprovadasJuntas.saldoDiaMin) + ')' : 'segue pendente') : '—') + ' | ' + i.classe + ' ' + i.rotulo + ' | ' + i.recomendacao + ' |'));
    fs.writeFileSync(dir + '/FASE4_3-justificativas.md', md.join('\n'));
    console.log(JSON.stringify({ total: itens.length, porClasse: por, porFunc: itens.reduce((a, i) => (a[i.ref] = (a[i.ref] || 0) + 1, a), {}) }));
    itens.sort((a, b) => a.data < b.data ? -1 : 1).forEach(i => console.log([i.ref, i.data, 'dow' + i.diaSemana, i.classe, i.rotulo, '|', i.motivo, '|', 'marcas', JSON.stringify(i.marcas), '| jornada', i.jornadaPrevistaMin, '| anexo', i.evidencia.anexo, '| desc', JSON.stringify((i.descricao || '').slice(0, 60)), '| gestor', i.lancadoPorGestor, '| impacto', JSON.stringify(i.impactoSeAprovada || null), '| assinado', i.espelhoAssinado, '| outras', i.outrasNoDia.length].join(' ')));
  })().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
}
