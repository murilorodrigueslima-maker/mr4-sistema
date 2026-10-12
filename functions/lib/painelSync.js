'use strict';
/**
 * Painel Comercial — sincronização (GestãoClick SOMENTE GET → display_metrics*). Escrita só pelo servidor (Admin SDK).
 *  • Execução a cada 5 min; trava (lease) transacional contra execuções concorrentes.
 *  • Falha NUNCA zera números: em erro/divergência preserva os documentos válidos e só atualiza o status.
 *  • Documentos: TV (display_metrics/painel_comercial, sem custo/margem) e Gestor (display_metrics_gestor/painel).
 *  • Histórico (6 meses fechados) refrescado a cada 6 h, para não multiplicar chamadas à API.
 */
const M = require('./painelMetricas'); const CAL = require('./painelCalendario');
const BASE = 'https://api.gestaoclick.com';
const LEASE_MIN = 4, HIST_HORAS = 6, MAX_PAGINAS = 120, HIST_MESES = 6;
const fortaleza = d => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const horaFortaleza = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const somarMes = (mes, n) => { let [y, m] = mes.split('-').map(Number); m += n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const ultimoDia = mes => { const [y, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const espera = ms => new Promise(r => setTimeout(r, ms));

/** Busca TODAS as páginas de uma situação/período. Verifica contagem × total_registros. Retry curto em 429/5xx. */
async function buscarVendas({ fetchImpl, tokens, situacaoId, inicio, fim, esperaRetry = [500, 1500] }) {
  const headers = { 'access-token': tokens.access, 'secret-access-token': tokens.secret, 'Content-Type': 'application/json' };
  let out = [], pagina = 1, totalPaginas = 1, totalRegistros = null;
  do {
    const qs = new URLSearchParams({ situacao_id: situacaoId, data_inicio: inicio, data_fim: fim, limite: '100', pagina: String(pagina) });
    let resp = null, ultimoErro = null;
    for (let t = 0; t <= esperaRetry.length; t++) {
      try {
        resp = await fetchImpl(`${BASE}/vendas?${qs}`, { method: 'GET', headers });
        if (resp.ok) break;
        ultimoErro = 'GC_HTTP_' + resp.status;
        if (resp.status !== 429 && resp.status < 500) break;                       // erro definitivo (4xx): não insiste
      } catch (e) { ultimoErro = 'GC_REDE'; resp = null; }
      if (t < esperaRetry.length) await espera(esperaRetry[t]);
    }
    if (!resp || !resp.ok) throw Object.assign(new Error(ultimoErro || 'GC_FALHA'), { codigo: ultimoErro || 'GC_FALHA' });
    let j; try { j = await resp.json(); } catch (_) { throw Object.assign(new Error('GC_JSON_INVALIDO'), { codigo: 'GC_JSON_INVALIDO' }); }
    out = out.concat(Array.isArray(j.data) ? j.data : []);
    totalPaginas = Number((j.meta && j.meta.total_paginas) || 1);
    if (j.meta && j.meta.total_registros !== undefined && j.meta.total_registros !== null) totalRegistros = Number(j.meta.total_registros);
    pagina++;
    if (pagina > MAX_PAGINAS) throw Object.assign(new Error('GC_PAGINAS_DEMAIS'), { codigo: 'GC_PAGINAS_DEMAIS' });
  } while (pagina <= totalPaginas);
  // total_registros é o total de TODAS as páginas: se existir, deve bater com o recebido (integridade da paginação)
  const integra = totalRegistros === null || totalRegistros === out.length;
  return { vendas: out, totalRegistros, integra };
}

async function sincronizar({ db, FieldValue, fetchImpl, agora = new Date(), tokens, intervaloMin = 5, runId = String(Date.now()) }) {
  const ctl = db.collection('display_metrics_ctl').doc('lease');
  const statusRef = db.collection('display_metrics').doc('painel_status');
  const tvRef = db.collection('display_metrics').doc('painel_comercial'), gestRef = db.collection('display_metrics_gestor').doc('painel');
  const t0 = Date.now();
  // 1) lease transacional
  const tomou = await db.runTransaction(async tx => {
    const s = await tx.get(ctl);
    if (s.exists && s.data().expiraEmMs > agora.getTime()) return false;
    tx.set(ctl, { runId, expiraEmMs: agora.getTime() + LEASE_MIN * 60000, iniciadoEm: FieldValue.serverTimestamp() });
    return true;
  });
  if (!tomou) return { status: 'OUTRA_EXECUCAO_EM_ANDAMENTO' };
  const registrarStatus = async (patch) => {
    const prev = (await statusRef.get()).data() || {};
    const base = { ultimaTentativaEm: FieldValue.serverTimestamp(), intervaloMinutos: intervaloMin };
    await statusRef.set({ ...prev, ...base, ...patch }, { merge: false });
  };
  try {
    const hojeStr = fortaleza(agora), mes = hojeStr.slice(0, 7), inicioMes = mes + '-01';
    // 2) configuração (somente leitura): metas e mapeamento auditado
    const [cfgSnap, mapSnap, antGest, calSnap] = await Promise.all([db.collection('painel_config').doc('default').get(), db.collection('painel_mapeamento').doc('vendedores').get(), gestRef.get(), db.collection('painel_calendario').doc('default').get()]);
    const calCfg = calSnap.exists ? calSnap.data() : null;
    const cfgDoc = cfgSnap.exists ? cfgSnap.data() : {};
    const metaPorNome = {}; (Array.isArray(cfgDoc.vendedores) ? cfgDoc.vendedores : []).forEach(v => { if (v && v.nome) metaPorNome[v.nome] = Number(v.meta) || 0; });
    const mapaDoc = mapSnap.exists && mapSnap.data().vendedores ? mapSnap.data().vendedores : null;
    const mapa = mapaDoc || M.MAPA_PADRAO;
    const nomeDe = k => Object.values(mapa).find(m => m.chave === k)?.nomeConfig || (k === 'ademir' ? 'Ademir' : 'Fabiana');
    const outrosConhecidos = mapSnap.exists && mapSnap.data().outrosConhecidos ? mapSnap.data().outrosConhecidos : {};
    const cfg = { mapa, outrosConhecidos, metas: { ademir: metaPorNome[nomeDe('ademir')] || 0, fabiana: metaPorNome[nomeDe('fabiana')] || 0 }, metaGeral: Number(cfgDoc.meta_equipe) || 0 };
    // 3) vendas do mês corrente (concretizadas) + canceladas do mês
    const conc = await buscarVendas({ fetchImpl, tokens, situacaoId: M.STATUS_CONCRETIZADOS[0], inicio: inicioMes, fim: hojeStr });
    const canc = await buscarVendas({ fetchImpl, tokens, situacaoId: M.STATUS_CANCELADA, inicio: inicioMes, fim: hojeStr });
    const r = M.calcular({ vendas: conc.vendas.concat(canc.vendas), hojeStr, mes, cfg });
    const erros = r.erros.slice();
    if (!conc.integra) erros.push(`PAGINACAO_NAO_BATE:${conc.vendas.length}/${conc.totalRegistros}`);
    if (erros.length) {
      await registrarStatus({ status: 'DIVERGENCIA', erro: erros.slice(0, 5).join('; ').slice(0, 300), falhasConsecutivas: ((await statusRef.get()).data() || {}).falhasConsecutivas + 1 || 1, duracaoMs: Date.now() - t0 });
      return { status: 'DIVERGENCIA', erros };
    }
    // 4) histórico (a cada 6 h) — falha aqui NÃO impede publicar o mês corrente
    const ant = antGest.exists ? antGest.data() : {};
    let historico = ant.historico || [], histEm = ant.historicoAtualizadoEm || null, histErro = null;
    const idadeH = histEm && histEm.toMillis ? (agora.getTime() - histEm.toMillis()) / 3600000 : Infinity;
    const faltaDiario = !historico.length || historico.some(h => !h.diario);
    if (idadeH >= HIST_HORAS || faltaDiario) {
      try {
        const novo = [];
        for (let i = HIST_MESES; i >= 1; i--) {
          const m = somarMes(mes, -i);
          const [c, k] = [await buscarVendas({ fetchImpl, tokens, situacaoId: M.STATUS_CONCRETIZADOS[0], inicio: m + '-01', fim: ultimoDia(m) }),
            await buscarVendas({ fetchImpl, tokens, situacaoId: M.STATUS_CANCELADA, inicio: m + '-01', fim: ultimoDia(m) })];
          const x = M.calcular({ vendas: c.vendas.concat(k.vendas), hojeStr: '0000-00-00', mes: m, cfg });
          if (!x.ok || !c.integra) throw Object.assign(new Error('HIST_DIVERGENCIA:' + m), { codigo: 'HIST_DIVERGENCIA' });
          novo.push({ mes: m, geral: x.geral.totalMes, pedidos: x.geral.pedidosMes, ticket: x.geral.ticketMes, ademir: x.ademir.totalMes, fabiana: x.fabiana.totalMes, outros: x.outros.totalMes,
            pedidosAdemir: x.ademir.pedidosMes, pedidosFabiana: x.fabiana.pedidosMes, pedidosOutros: x.outros.pedidosMes, cancelamentosQtd: x.cancelamentos.qtd, cancelamentosValor: x.cancelamentos.valor,
            custo: M.reais(x.custo.mesCentavos), coberturaCusto: x.custo.cobertura, diario: x.diario });
        }
        historico = novo; histEm = FieldValue.serverTimestamp();
      } catch (e) { histErro = e.codigo || 'HIST_FALHA'; }
    }
    // 5) publica TV (compatível com o formato antigo + novos campos) e Gestor
    const vendedoresLegado = ['ademir', 'fabiana'].map(k => ({ nome: nomeDe(k), meta: r[k].meta, totalMes: r[k].totalMes, totalHoje: r[k].totalHoje, pedidosMes: r[k].pedidosMes, pedidosHoje: r[k].pedidosHoje,
      ticketMes: r[k].ticketMes, ticketHoje: r[k].ticketHoje, pctMeta: r[k].pctMeta, restante: r[k].restante }));
    const g = r.geral;
    const equipeLegado = { totalHoje: g.totalHoje, totalMes: g.totalMes, pedidosHoje: g.pedidosHoje, pedidosMes: g.pedidosMes, ticketHoje: g.ticketHoje, ticketMes: g.ticketMes };
    const sinc = { status: 'OK', intervaloMinutos: intervaloMin };
    const qualBasica = { vendasConsideradas: r.qualidade.vendasConsideradas, vendasSemVendedor: r.qualidade.vendasSemVendedor, duplicidadesDetectadas: r.qualidade.duplicidadesDetectadas, reconciliado: true, fonte: 'GestaoClick' };
    // Ritmo, projeção, série diária e comparativo (derivados dos totais conciliados + calendário comercial; informativos)
    const hora = horaFortaleza(agora);
    const ritmo = CAL.ritmoEProjecao({ cfg: calCfg, mes, hojeStr, hora, acumulado: g.totalMes, meta: cfg.metaGeral });
    const diasMes = CAL.diasDoMes(calCfg, mes);
    let acum = 0;
    const serieDiaria = diasMes.filter(x => x.d <= hojeStr).map(x => { const d = r.diario[x.d] || { v: 0, p: 0 }; acum += d.v; return { d: x.d, v: M.reais(d.v), p: d.p, a: M.reais(acum) }; });
    const mesAnt = somarMes(mes, -1);
    const antEntrada = (historico || []).find(h => h.mes === mesAnt);
    const comparativo = antEntrada && antEntrada.diario
      ? CAL.comparativoMesAnterior({ cfg: calCfg, mesAnterior: mesAnt, diasEquivalentesDecorridos: ritmo.diasEquivalentesDecorridos, diarioAnterior: antEntrada.diario, acumuladoAtual: g.totalMes, pedidosAtual: g.pedidosMes })
      : null;
    const calendario = { mes, fonte: calSnap.exists ? 'painel_calendario/default' : 'padrao', horasDiaCompleto: CAL.normalizar(calCfg).horasDiaCompleto,
      dias: diasMes.map(x => ({ d: x.d, peso: Math.round(x.peso * 1000) / 1000 })),
      feriados: (calCfg && Array.isArray(calCfg.feriados) ? calCfg.feriados : []).filter(f => String(f.data).startsWith(mes)).map(f => ({ d: f.data, nome: f.nome, expediente: f.expediente, verificado: !!f.verificado })) };
    const tv = { atualizadoEm: FieldValue.serverTimestamp(), periodo: { inicioMes, fim: hojeStr }, equipe: equipeLegado, vendedores: vendedoresLegado, configuracao: { metaEquipe: cfg.metaGeral },
      schemaVersao: 3, geral: { ...g }, outros: { ...r.outros }, qualidade: qualBasica, sincronizacao: sinc,
      ritmo, projecao: { fechamento: ritmo.projecaoFechamento, diferencaMeta: ritmo.diferencaProjetadaMeta, pctMeta: ritmo.pctProjetadoMeta, confiabilidade: ritmo.confiabilidade, situacao: ritmo.situacao, estimativa: true },
      serieDiaria, calendario, comparativoMesAnterior: comparativo };
    const gest = { atualizadoEm: FieldValue.serverTimestamp(), periodo: { inicioMes, fim: hojeStr }, ritmo, comparativoMesAnterior: comparativo, geral: { ...g }, ademir: { ...r.ademir }, fabiana: { ...r.fabiana }, outros: { ...r.outros },
      custo: { mes: M.reais(r.custo.mesCentavos), margemBruta: M.reais(g.totalMes * 100 - r.custo.mesCentavos), margemPct: g.totalMes ? Math.round(1000 * (g.totalMes * 100 - r.custo.mesCentavos) / (g.totalMes * 100)) / 10 : 0,
        cobertura: r.custo.cobertura, porChave: Object.fromEntries(Object.entries(r.custo.porChave).map(([k, v]) => [k, M.reais(v)])) },
      cancelamentos: r.cancelamentos, historico, historicoAtualizadoEm: histEm, historicoErro: histErro,
      qualidade: { ...r.qualidade, paginacaoIntegra: conc.integra, totalRegistrosGC: conc.totalRegistros }, centavos: r.centavos, sincronizacao: sinc };
    await tvRef.set(tv); await gestRef.set(gest);
    await registrarStatus({ status: 'OK', erro: null, ultimoSucessoEm: FieldValue.serverTimestamp(), falhasConsecutivas: 0, duracaoMs: Date.now() - t0, vendasConsideradas: r.qualidade.vendasConsideradas, historicoErro: histErro });
    return { status: 'OK', geral: g.totalMes, pedidos: g.pedidosMes, ademir: r.ademir.totalMes, fabiana: r.fabiana.totalMes, outros: r.outros.totalMes };
  } catch (e) {
    const cod = String(e && (e.codigo || e.message) || 'ERRO').replace(/[^A-Za-z0-9_:\-]/g, '').slice(0, 60);
    try { const prev = (await statusRef.get()).data() || {}; await registrarStatus({ status: 'FALHA', erro: cod, falhasConsecutivas: (prev.falhasConsecutivas || 0) + 1, duracaoMs: Date.now() - t0 }); } catch (_) { /* melhor esforço */ }
    return { status: 'FALHA', erro: cod };
  } finally {
    try { await ctl.set({ runId, expiraEmMs: 0, liberadoEm: FieldValue.serverTimestamp() }); } catch (_) { /* expira sozinho */ }
  }
}

module.exports = { sincronizar, buscarVendas, fortaleza, somarMes };
