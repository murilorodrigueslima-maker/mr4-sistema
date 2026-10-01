/* MR4 Financeiro v2 — lógica de apresentação PURA (sem DOM, sem rede). Testada em Node; carregada pelo navegador como window.FinanceiroView.
 * Regras de produto: nenhum saldo/caixa/capacidade; "Requer conferência" separado; >365 sempre visível; "Boleto Inter/Pix" ambíguo;
 * fluxo programado rotulado; nenhum percentual de inadimplência; fuso America/Fortaleza. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FinanceiroView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TZ = 'America/Fortaleza';
  var STALE_HORAS = 6;                       // 2 ciclos do agendador (3 h) + folga
  var TAM_PAGINA_FATIA = 250;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function brl(cents) {
    if (cents == null || isNaN(cents)) return '—';
    var neg = cents < 0, v = Math.abs(Math.round(cents)), r = Math.floor(v / 100), c = v % 100;
    return (neg ? '−' : '') + 'R$ ' + String(r).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + (c < 10 ? '0' : '') + c;
  }
  function dataBR(ymd) { return /^\d{4}-\d{2}-\d{2}/.test(String(ymd || '')) ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : '—'; }
  function dataComercial(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date()); }
  function dataHoraBR(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d.getTime())) return '—';
    var p = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
    return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
  }
  function somarDias(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  /** Frescor a partir de quando a geração ativa foi publicada. */
  function frescor(publicadoEm, agoraMs, limiteHoras) {
    var lim = limiteHoras || STALE_HORAS;
    if (!publicadoEm) return { estado: 'UNAVAILABLE', idadeMin: null, texto: 'Ainda não há dados sincronizados.' };
    var idade = Math.round(((agoraMs == null ? Date.now() : agoraMs) - new Date(publicadoEm).getTime()) / 60000);
    if (isNaN(idade)) return { estado: 'UNAVAILABLE', idadeMin: null, texto: 'Ainda não há dados sincronizados.' };
    var h = Math.floor(idade / 60);
    var rel = idade < 1 ? 'agora há pouco' : idade < 60 ? 'há ' + idade + ' min' : 'há ' + h + ' h';
    if (idade > lim * 60) return { estado: 'STALE', idadeMin: idade, texto: 'Dados desatualizados: última atualização ' + rel + ' (' + dataHoraBR(publicadoEm) + '). Confira o ERP antes de decidir.' };
    return { estado: 'CURRENT', idadeMin: idade, texto: 'Atualizado em ' + dataHoraBR(publicadoEm) + ' (' + rel + ')' };
  }

  var FAIXAS = [['D1_A_7', '1–7 dias'], ['D8_A_15', '8–15 dias'], ['D16_A_30', '16–30 dias'], ['D31_A_60', '31–60 dias'], ['D61_A_90', '61–90 dias'], ['D91_A_180', '91–180 dias'], ['D181_A_365', '181–365 dias'], ['ACIMA_365', 'Mais de 365 dias']];
  function linhasEnvelhecimento(nat) { return FAIXAS.map(function (f) { var x = (nat.envelhecimento || {})[f[0]] || { n: 0, c: 0 }; return { id: f[0], rotulo: f[1], n: x.n, c: x.c, destaque: f[0] === 'ACIMA_365' }; }); }

  /** Cards da visão geral: principais (operacionais) e secundários (fluxo programado). Nunca saldo/caixa/capacidade. */
  function modeloCards(r) {
    var P = r.pagar, R = r.receber, F = r.fluxo_programado;
    var card = function (id, titulo, x, tom, sub) { return { id: id, titulo: titulo, valor: brl(x.c), n: x.n, tom: tom, sub: sub || (x.n + (x.n === 1 ? ' título' : ' títulos')) }; };
    var principais = [
      card('pagar_hoje', 'A pagar hoje', P.hoje, 'neutro'), card('receber_hoje', 'A receber hoje', R.hoje, 'neutro'),
      card('pagar_7d', 'A pagar · próximos 7 dias', P.prox_7d, 'neutro'), card('receber_7d', 'A receber · próximos 7 dias', R.prox_7d, 'neutro'),
      card('pagar_vencido', 'Vencido a pagar', P.vencido, P.vencido.n ? 'alerta' : 'neutro'), card('receber_vencido', 'Vencido a receber', R.vencido, R.vencido.n ? 'alerta' : 'neutro'),
      { id: 'conferencia', titulo: 'Requer conferência', valor: String(P.requer_conferencia.n + R.requer_conferencia.n), n: P.requer_conferencia.n + R.requer_conferencia.n, tom: (P.requer_conferencia.n + R.requer_conferencia.n) ? 'atencao' : 'neutro',
        sub: (P.requer_conferencia.n + R.requer_conferencia.n) ? P.requer_conferencia.n + ' a pagar · ' + R.requer_conferencia.n + ' a receber' : 'nenhum título' },
    ];
    var fl = function (id, titulo, x) { return { id: id, titulo: titulo, valor: brl(x.liquido_c), tom: 'neutro', sub: 'receber ' + brl(x.receber_c) + ' − pagar ' + brl(x.pagar_c) }; };
    return { principais: principais, secundarios: [fl('fluxo_7d', 'Fluxo programado · 7 dias', F.d7), fl('fluxo_30d', 'Fluxo programado · 30 dias', F.d30)], definicaoFluxo: F.definicao };
  }

  /** Filtros de lista: quais grupos (em ordem) e, se houver, limite de dias a partir de hoje. */
  var FILTROS = {
    vencidas: { rotulo: 'Vencidas', grupos: ['VENCIDO'] },
    hoje: { rotulo: 'Hoje', grupos: ['HOJE'] },
    d7: { rotulo: 'Próximos 7 dias', grupos: ['HOJE', 'FUTURO'], dias: 7 },
    d30: { rotulo: 'Próximos 30 dias', grupos: ['HOJE', 'FUTURO'], dias: 30 },
    conferencia: { rotulo: 'Requer conferência', grupos: ['UNKNOWN'] },
    pagas: { rotulo: 'Pagas', grupos: ['PAGO'] },
  };
  function rotuloFiltro(id, natureza) { var f = FILTROS[id]; if (!f) return id; return id === 'pagas' && natureza === 'RECEBER' ? 'Recebidas' : f.rotulo; }

  /** Plano de leitura: lista de ids de fatia a buscar, em ordem, para um filtro (nunca mais que o necessário). */
  function planoLeitura(geracao, natureza, filtroId, resumo) {
    var f = FILTROS[filtroId]; if (!f) return [];
    var det = resumo[natureza === 'PAGAR' ? 'pagar' : 'receber'].detalhe, ids = [];
    f.grupos.forEach(function (g) { var n = (det[g] || {}).fatias || 0; for (var i = 0; i < n; i++) ids.push({ id: geracao + '__' + natureza + '__' + g + '__' + ('00' + i).slice(-3), grupo: g, indice: i }); });
    return ids;
  }
  /** Estado de uma lista paginada: carrega UMA fatia por vez; para cedo quando o filtro por dias já passou do limite. */
  function novaLista(geracao, natureza, filtroId, resumo, hoje) {
    return { natureza: natureza, filtro: filtroId, hoje: hoje, plano: planoLeitura(geracao, natureza, filtroId, resumo), proxima: 0, itens: [], fim: false, lidas: 0 };
  }
  /** Há mais a carregar E ainda faltam itens para atingir o mínimo desejado na tela? (evita parar no 1º grupo quando ele é pequeno) */
  function precisaMais(est, minimo) { return !est.fim && est.itens.length < minimo; }
  function proximaFatia(est) { return est.fim || est.proxima >= est.plano.length ? null : est.plano[est.proxima]; }
  function aplicarFatia(est, fatia) {
    var f = FILTROS[est.filtro], lim = f.dias != null ? somarDias(est.hoje, f.dias) : null, cheguei = false;
    var itens = (fatia.itens || []).map(function (i) { return Object.assign({ _g: fatia.grupo }, i); });
    if (lim) itens = itens.filter(function (i) { if (i.v > lim) { cheguei = true; return false; } return true; });
    est.itens = est.itens.concat(itens); est.proxima++; est.lidas++;
    // FUTURO está em ordem de vencimento: se algum título passou do limite, o resto também passou → para
    if (cheguei && fatia.grupo === 'FUTURO') est.fim = true;
    if (est.proxima >= est.plano.length) est.fim = true;
    return est;
  }

  var STATUS = { VENCIDO: ['Vencido', 'alerta'], HOJE: ['Vence hoje', 'atencao'], FUTURO: ['A vencer', 'neutro'], UNKNOWN: ['Requer conferência', 'atencao'] };
  function statusRotulo(item, natureza) {
    var g = item._g;
    if (g === 'PAGO') return { rotulo: natureza === 'RECEBER' ? 'Recebido' : 'Pago', tom: 'ok' };
    var s = STATUS[g] || ['—', 'neutro']; return { rotulo: s[0], tom: s[1] };
  }
  function textoVinculo(lk) {
    if (!lk) return null;
    if (lk.t === 'VENDA') return 'Venda nº ' + lk.cod;
    if (lk.t === 'COMPRA') return 'Compra nº ' + lk.cod;
    if (lk.t === 'AMBIGUO') return 'Vínculo ambíguo';                       // nunca apresentado como vínculo certo
    return null;
  }
  /** Linha de tabela como dados (a página só escapa e imprime). */
  function modeloLinha(item, natureza) {
    var st = statusRotulo(item, natureza);
    return { id: item.id, vencimento: dataBR(item.v), contraparte: item.ent || (item.et === 'FUNCIONARIO' ? 'Funcionário' : item.et === 'OUTROS' ? 'Outros' : '—'), descricao: item.desc || '—', valor: brl(item.val), status: st.rotulo, tom: st.tom,
      plano: item.pl || 'Sem classificação', forma: item.fp || '—', ambigua: !!item.amb, faixa: item.ag ? (FAIXAS.filter(function (f) { return f[0] === item.ag; })[0] || [0, ''])[1] : null,
      pagoEm: item.sd ? dataBR(item.sd) : null, vinculo: textoVinculo(item.lk), vinculoAmbiguo: !!(item.lk && item.lk.t === 'AMBIGUO'), conferencia: item._g === 'UNKNOWN' ? (item.motx || 'Dados contraditórios no ERP') : null, acimaDeUmAno: item.ag === 'ACIMA_365' };
  }

  /** Validação defensiva do ponteiro/resumo (falha FECHADA: nada de mostrar números de documento estranho). */
  function validarGeracao(ativo, resumo) {
    if (!ativo || !ativo.geracao || !ativo.resumo_id) return { ok: false, motivo: 'SEM_GERACAO' };
    if (!resumo || resumo.geracao !== ativo.geracao) return { ok: false, motivo: 'RESUMO_DE_OUTRA_GERACAO' };
    if (!resumo.pagar || !resumo.receber || !resumo.fluxo_programado) return { ok: false, motivo: 'RESUMO_INCOMPLETO' };
    return { ok: true };
  }
  /** Formas de pagamento para a tabela (a fonte pode ser ambígua: "Boleto Inter/Pix" fica como está). */
  function linhasFormas(nat) { return (nat.por_forma || []).map(function (f) { return { forma: f.forma, ambigua: !!f.ambigua, aberto: f.aberto, vencido: f.vencido }; }); }

  return { TZ: TZ, STALE_HORAS: STALE_HORAS, TAM_PAGINA_FATIA: TAM_PAGINA_FATIA, FAIXAS: FAIXAS, FILTROS: FILTROS, esc: esc, brl: brl, dataBR: dataBR, dataComercial: dataComercial, dataHoraBR: dataHoraBR, somarDias: somarDias, frescor: frescor,
    linhasEnvelhecimento: linhasEnvelhecimento, modeloCards: modeloCards, rotuloFiltro: rotuloFiltro, planoLeitura: planoLeitura, novaLista: novaLista, precisaMais: precisaMais, proximaFatia: proximaFatia, aplicarFatia: aplicarFatia,
    statusRotulo: statusRotulo, textoVinculo: textoVinculo, modeloLinha: modeloLinha, validarGeracao: validarGeracao, linhasFormas: linhasFormas };
});
