/* Painel Comercial TV — lógica PURA (sem DOM/Firebase): frescor dos dados, ranking, gráfico, textos. Testada em functions/test/painel-p1.test.js. */
(function (root) {
  'use strict';
  var brl = function (v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
  var brlCurto = function (v) { var n = Number(v || 0); return Math.abs(n) >= 1000 ? 'R$ ' + (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: n >= 100000 ? 0 : 1 }) + ' mil' : brl(n); };
  var pct = function (v) { return (Math.round(Number(v || 0) * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %'; };

  /** Estado dos dados. idadeMin = minutos desde o último SUCESSO; statusDoc = display_metrics/painel_status. */
  function estadoDados(o) {
    o = o || {};
    if (o.erro) return { nivel: 'indisponivel', rotulo: 'DADOS INDISPONÍVEIS', cor: 'red' };
    if (o.idadeMin === null || o.idadeMin === undefined) return { nivel: 'aguardando', rotulo: 'Aguardando dados', cor: 'yellow' };
    var falha = o.status === 'FALHA' || o.status === 'DIVERGENCIA';
    var m = Math.max(0, Math.round(o.idadeMin));
    if (m > 45 || (falha && m > 15)) return { nivel: 'desatualizado', rotulo: 'DADOS DESATUALIZADOS · há ' + m + ' min', cor: 'red' };
    if (m > 15 || falha) return { nivel: 'atrasado', rotulo: 'Atualização atrasada · há ' + m + ' min', cor: 'yellow' };
    return { nivel: 'ok', rotulo: 'Ao vivo', cor: 'green' };
  }

  /** Ranking por faturamento (Ademir/Fabiana); sinaliza quem tem MAIOR % da meta para não favorecer a meta menor/maior. */
  function ranking(vendedores) {
    var v = (vendedores || []).map(function (x) { return { nome: x.nome, totalMes: x.totalMes || 0, pctMeta: x.meta ? Math.round((x.totalMes / x.meta) * 1000) / 10 : 0, meta: x.meta || 0 }; });
    var porFat = v.slice().sort(function (a, b) { return b.totalMes - a.totalMes; });
    var melhorPct = v.slice().sort(function (a, b) { return b.pctMeta - a.pctMeta; })[0];
    return porFat.map(function (x, i) { return Object.assign({}, x, { posicao: i + 1, melhorPctMeta: !!melhorPct && melhorPct.nome === x.nome && v.length > 1 && (v[0].pctMeta !== v[1].pctMeta) }); });
  }

  /** Cartões 'por dia': delta desde a última atualização (apenas totais agregados; nenhum evento de venda é inventado). */
  function delta(anterior, atual) { return atual > anterior + 0.004 ? Math.round((atual - anterior) * 100) / 100 : 0; }

  /** Pontos do gráfico (índices de dia 1..N). real = acumulado até hoje; esperado = meta distribuída pelo peso dos dias; projecao = de hoje ao fim do mês. */
  function grafico(o) {
    var dias = (o.calendario && o.calendario.dias) || [], n = dias.length || 31;
    var serie = o.serieDiaria || [], hoje = o.hojeStr, meta = o.meta || 0;
    var totalPeso = dias.reduce(function (s, d) { return s + d.peso; }, 0) || 1;
    var cum = 0, esperado = [], real = [], projecao = [];
    var acumPorDia = {}; serie.forEach(function (s) { acumPorDia[s.d] = s.a; });
    var idxHoje = -1;
    dias.forEach(function (d, i) {
      cum += d.peso; esperado.push({ i: i + 1, v: meta * cum / totalPeso });
      if (acumPorDia[d.d] !== undefined) { real.push({ i: i + 1, v: acumPorDia[d.d] }); if (d.d === hoje) idxHoje = i; }
    });
    var ritmo = o.ritmo || {};
    if (idxHoje >= 0 && ritmo.mediaPorDiaUtil && ritmo.confiabilidade !== 'INSUFICIENTE') {
      var base = acumPorDia[hoje], c2 = 0;
      projecao.push({ i: idxHoje + 1, v: base });
      for (var j = idxHoje + 1; j < dias.length; j++) { c2 += dias[j].peso; projecao.push({ i: j + 1, v: base + c2 * ritmo.mediaPorDiaUtil }); }
    }
    var maxY = Math.max(meta, 1, real.length ? real[real.length - 1].v : 0, projecao.length ? projecao[projecao.length - 1].v : 0) * 1.06;
    return { n: n, real: real, esperado: esperado, projecao: projecao, maxY: maxY, idxHoje: idxHoje };
  }


  /** Quanto falta para a meta e quanto é preciso por dia útil equivalente restante (apresentação; usa os dias do ritmo validado). */
  function faltaEPorDia(total, meta, diasRestantes) {
    var m = Number(meta) || 0, t = Number(total) || 0;
    if (!m) return { falta: null, porDia: null, batida: false };
    var falta = Math.max(0, Math.round((m - t) * 100) / 100);
    if (falta === 0) return { falta: 0, porDia: 0, batida: true };
    var d = Number(diasRestantes);
    return { falta: falta, porDia: d > 0 ? Math.round((falta / d) * 100) / 100 : null, batida: false };
  }

  /** Datas ainda não confirmadas (verificado:false) de hoje em diante no mês — o painel avisa que o ritmo depende delas. */
  function avisoCalendario(calendario, hojeStr) {
    var f = (calendario && calendario.feriados) || [];
    return f.filter(function (x) { return x.verificado === false && x.d >= (hojeStr || ''); })
      .map(function (x) { return { d: x.d, nome: x.nome, expediente: x.expediente, dia: x.d.slice(8, 10) + '/' + x.d.slice(5, 7) }; });
  }

  function textoComparativo(c) {
    if (!c) return { titulo: 'Mês anterior (mesmo período)', valor: '—', detalhe: 'Sem base comparável ainda' };
    var sinal = c.diferenca >= 0 ? '+' : '−';
    return { titulo: 'Mês anterior (mesmo período)', valor: brl(c.valor), detalhe: sinal + brl(Math.abs(c.diferenca)) + (c.variacaoPct === null ? '' : ' (' + (c.variacaoPct >= 0 ? '+' : '−') + String(Math.abs(c.variacaoPct)).replace('.', ',') + ' %)'), positivo: c.diferenca >= 0 };
  }

  var API = { brl: brl, brlCurto: brlCurto, pct: pct, estadoDados: estadoDados, ranking: ranking, delta: delta, grafico: grafico, textoComparativo: textoComparativo, faltaEPorDia: faltaEPorDia, avisoCalendario: avisoCalendario };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PainelTV = API;
})(typeof window !== 'undefined' ? window : this);
