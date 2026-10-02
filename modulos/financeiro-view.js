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
  /** Filtros de situação ADICIONAIS (fora de FILTROS para não alterar o contrato existente): "Em aberto" = vencidas + hoje + a vencer (poucas fatias; sem limite de dias). */
  var FILTROS_EXTRA = { abertas: { rotulo: 'Em aberto', grupos: ['VENCIDO', 'HOJE', 'FUTURO'] } };
  function defFiltro(id) { return FILTROS[id] || FILTROS_EXTRA[id] || null; }
  function rotuloFiltro(id, natureza) { var f = defFiltro(id); if (!f) return id; return id === 'pagas' && natureza === 'RECEBER' ? 'Recebidas' : f.rotulo; }

  /** Plano de leitura: lista de ids de fatia a buscar, em ordem, para um filtro (nunca mais que o necessário). */
  function planoLeitura(geracao, natureza, filtroId, resumo) {
    var f = defFiltro(filtroId); if (!f) return [];
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
    var f = defFiltro(est.filtro), lim = f.dias != null ? somarDias(est.hoje, f.dias) : null, cheguei = false;
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


  // ═══ FASE A — busca, período, filtros combináveis, ordenação, chips e cache (TUDO local; nenhuma consulta nova; nenhum dado alterado) ═══
  /** Texto para comparação: minúsculas, sem acentos, espaços colapsados. */
  function normalizar(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function termosBusca(q) { var n = normalizar(q); return n ? n.split(' ') : []; }
  /** Campos pesquisáveis (somente os que EXISTEM nas fatias): entidade, descrição, código do título, plano de contas, forma de pagamento. */
  function textoBuscavel(item) { return normalizar([item.ent, item.desc, item.cod, item.pl, item.fp].filter(function (x) { return x != null && x !== ''; }).join(' ')); }
  function casaBusca(item, q) { var ts = termosBusca(q); if (!ts.length) return true; var tx = textoBuscavel(item); return ts.every(function (t) { return tx.indexOf(t) >= 0; }); }

  /** Períodos (datas só-data America/Fortaleza; comparação por texto YYYY-MM-DD: nada se desloca de dia). Semana = segunda a domingo. */
  var PERIODOS = [['hoje', 'Hoje'], ['ontem', 'Ontem'], ['semana', 'Esta semana'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado'], ['ult7', 'Últimos 7 dias'], ['ult30', 'Últimos 30 dias'], ['ult90', 'Últimos 90 dias'], ['personalizado', 'Personalizado']];
  function diaSemana(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
  function ultimoDiaDoMes(ano, mes1a12) { return new Date(Date.UTC(ano, mes1a12, 0)).getUTCDate(); }
  function validaYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00Z').getTime()) && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s; }
  /** {de, ate} inclusivo (qualquer ponta pode ser null no personalizado). */
  function intervaloPeriodo(id, hoje, de, ate) {
    var y = +hoje.slice(0, 4), m = +hoje.slice(5, 7), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    if (id === 'hoje') return { de: hoje, ate: hoje };
    if (id === 'ontem') { var o = somarDias(hoje, -1); return { de: o, ate: o }; }
    if (id === 'semana') { var dow = diaSemana(hoje), voltar = dow === 0 ? 6 : dow - 1, ini = somarDias(hoje, -voltar); return { de: ini, ate: somarDias(ini, 6) }; }
    if (id === 'mes') return { de: y + '-' + pad(m) + '-01', ate: y + '-' + pad(m) + '-' + pad(ultimoDiaDoMes(y, m)) };
    if (id === 'mes_passado') { var yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1; return { de: yy + '-' + pad(mm) + '-01', ate: yy + '-' + pad(mm) + '-' + pad(ultimoDiaDoMes(yy, mm)) }; }
    if (id === 'ult7') return { de: somarDias(hoje, -6), ate: hoje };
    if (id === 'ult30') return { de: somarDias(hoje, -29), ate: hoje };
    if (id === 'ult90') return { de: somarDias(hoje, -89), ate: hoje };
    if (id === 'personalizado') {
      var a = validaYmd(de) ? de : null, b = validaYmd(ate) ? ate : null; if (!a && !b) return null;
      if (a && b && a > b) { var t = a; a = b; b = t; } return { de: a, ate: b };
    }
    return null;
  }
  function rotuloPeriodo(p) {
    if (!p) return ''; var nome = (PERIODOS.filter(function (x) { return x[0] === p.id; })[0] || [0, p.id])[1];
    if (p.id === 'personalizado') nome = (p.de ? dataBR(p.de) : '…') + ' a ' + (p.ate ? dataBR(p.ate) : '…');
    return nome + ' · ' + (p.ref === 'pagamento' ? 'pagamento/recebimento' : 'vencimento');
  }
  /** Data de referência do título: vencimento (v) ou pagamento/recebimento (sd, só existe em pagos). Ausente → fora do período. */
  function dataRef(item, ref) { return ref === 'pagamento' ? (item.sd || null) : (item.v || null); }
  function dentroDoPeriodo(item, p, hoje) {
    if (!p) return true; var iv = intervaloPeriodo(p.id, hoje, p.de, p.ate); if (!iv) return true;
    var d = dataRef(item, p.ref); if (!d) return false;
    return (!iv.de || d >= iv.de) && (!iv.ate || d <= iv.ate);
  }

  /** "1.234,56" | "1234,5" | "1234.56" | "R$ 1.000" → centavos inteiros; vazio/inválido → null. */
  function parseReais(txt) {
    var s = String(txt == null ? '' : txt).replace(/R\$|\s/g, ''); if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var p = s.split('.'); return parseInt(p[0], 10) * 100 + (p[1] ? parseInt((p[1] + '0').slice(0, 2), 10) : 0);
  }
  function vinculoDe(item) { return !item.lk ? 'sem' : item.lk.t === 'AMBIGUO' ? 'ambiguo' : 'com'; }
  var ROTULO_VINCULO = { com: 'Com vínculo (venda/compra)', ambiguo: 'Vínculo ambíguo', sem: 'Sem vínculo' };

  /** Critérios (todos opcionais e combináveis). periodo = { id, ref: 'vencimento'|'pagamento', de, ate }. min/max em centavos. */
  function criteriosVazios() { return { busca: '', periodo: null, plano: '', forma: '', vinculo: '', entidade: '', min: null, max: null }; }
  function periodoAtivo(p) { return !!p && !!intervaloPeriodo(p.id, '2000-01-01', p.de, p.ate); }   // "personalizado" sem datas válidas não restringe nada
  function temCriterio(c) { return !!(c.busca && termosBusca(c.busca).length) || periodoAtivo(c.periodo) || !!c.plano || !!c.forma || !!c.vinculo || !!(c.entidade && normalizar(c.entidade)) || c.min != null || c.max != null; }
  function filtrarItens(itens, c, hoje) {
    var ent = normalizar(c.entidade);
    return itens.filter(function (i) {
      if (c.busca && !casaBusca(i, c.busca)) return false;
      if (periodoAtivo(c.periodo) && !dentroDoPeriodo(i, c.periodo, hoje)) return false;
      if (c.plano && (i.pl || 'Sem classificação') !== c.plano) return false;
      if (c.forma && (i.fp || '—') !== c.forma) return false;
      if (c.vinculo && vinculoDe(i) !== c.vinculo) return false;
      if (ent && normalizar(i.ent).indexOf(ent) < 0) return false;
      if (c.min != null && !(typeof i.val === 'number' && i.val >= c.min)) return false;
      if (c.max != null && !(typeof i.val === 'number' && i.val <= c.max)) return false;
      return true;
    });
  }
  /** Opções distintas (ordenadas) de um campo, para os seletores; ausente vira o mesmo rótulo usado na tabela. */
  function opcoesDistintas(itens, campo) {
    var vistos = {}, fora = campo === 'pl' ? 'Sem classificação' : campo === 'fp' ? '—' : null;
    itens.forEach(function (i) { var v = i[campo] || fora; if (v != null && v !== '') vistos[v] = (vistos[v] || 0) + 1; });
    return Object.keys(vistos).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); }).map(function (k) { return { valor: k, n: vistos[k] }; });
  }

  /** Ordenação por cabeçalho. Ausentes SEMPRE no fim (nos dois sentidos); desempate estável por vencimento e id. */
  var ORDEM_SITUACAO = { VENCIDO: 0, HOJE: 1, FUTURO: 2, UNKNOWN: 3, PAGO: 4 };
  function chaveOrdem(i, campo) {
    if (campo === 'venc') return i.v || null;
    if (campo === 'pagamento') return i.sd || null;
    if (campo === 'valor') return typeof i.val === 'number' ? i.val : null;
    if (campo === 'entidade') { var e = normalizar(i.ent); return e || null; }
    if (campo === 'situacao') return ORDEM_SITUACAO[i._g] != null ? ORDEM_SITUACAO[i._g] : null;
    return null;
  }
  function ordenarItens(itens, campo, dir) {
    if (!campo) return itens.slice(); var f = dir === 'desc' ? -1 : 1;
    return itens.slice().sort(function (a, b) {
      var x = chaveOrdem(a, campo), y = chaveOrdem(b, campo);
      if (x === null && y === null) { /* ambos ausentes: cai no desempate */ }
      else if (x === null) return 1; else if (y === null) return -1;
      else if (x !== y) return (x < y ? -1 : 1) * f;
      var v = String(a.v || '').localeCompare(String(b.v || '')); if (v) return v;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /** Estado da lista: { situacao, criterios, ordem: { campo, dir } }. Chips ativos = situação + cada critério. */
  function chipsAtivos(situacao, c, natureza) {
    var ch = [{ id: 'situacao', rotulo: rotuloFiltro(situacao, natureza) }];
    if (c.busca && termosBusca(c.busca).length) ch.push({ id: 'busca', rotulo: 'Busca: ' + String(c.busca).trim() });
    if (periodoAtivo(c.periodo)) ch.push({ id: 'periodo', rotulo: rotuloPeriodo(c.periodo) });
    if (c.plano) ch.push({ id: 'plano', rotulo: 'Plano: ' + c.plano });
    if (c.forma) ch.push({ id: 'forma', rotulo: 'Forma: ' + c.forma });
    if (c.vinculo) ch.push({ id: 'vinculo', rotulo: ROTULO_VINCULO[c.vinculo] || c.vinculo });
    if (c.entidade && normalizar(c.entidade)) ch.push({ id: 'entidade', rotulo: (natureza === 'PAGAR' ? 'Fornecedor: ' : 'Cliente: ') + String(c.entidade).trim() });
    if (c.min != null || c.max != null) ch.push({ id: 'valor', rotulo: 'Valor: ' + (c.min != null ? brl(c.min) : '…') + ' a ' + (c.max != null ? brl(c.max) : '…') });
    return ch;
  }
  /** Remove SOMENTE o critério pedido. Remover a situação volta para "Em aberto" (sem recorte de situação). Retorna novo estado (não muta). */
  function removerCriterio(estado, id) {
    var c = Object.assign({}, estado.criterios), sit = estado.situacao;
    if (id === 'situacao') sit = 'abertas'; else if (id === 'busca') c.busca = ''; else if (id === 'periodo') c.periodo = null; else if (id === 'plano') c.plano = ''; else if (id === 'forma') c.forma = '';
    else if (id === 'vinculo') c.vinculo = ''; else if (id === 'entidade') c.entidade = ''; else if (id === 'valor') { c.min = null; c.max = null; }
    return { situacao: sit, criterios: c, ordem: estado.ordem };
  }
  /** Limpar filtros: zera TODOS os critérios e a situação (volta a "Em aberto"); mantém a ordenação escolhida. */
  function limparFiltros(estado) { return { situacao: 'abertas', criterios: criteriosVazios(), ordem: estado.ordem }; }

  /** Cache de fatias por id (evita reler ao trocar de chip/filtro). leitor(id) é injetado (a página usa getDoc); conta leituras reais. */
  function criarCacheFatias() {
    var m = {}, leituras = 0;
    return {
      tem: function (id) { return Object.prototype.hasOwnProperty.call(m, id); },
      obter: function (id) { return m[id]; },
      definir: function (id, d) { m[id] = d; },
      tamanho: function () { return Object.keys(m).length; },
      leituras: function () { return leituras; },
      ler: function (id, leitor) { var self = this; if (self.tem(id)) return Promise.resolve(m[id]); leituras++; return Promise.resolve(leitor(id)).then(function (d) { if (d) m[id] = d; return d; }); },
      limpar: function () { m = {}; },
    };
  }
  /** Quantas fatias de um filtro ainda NÃO estão no cache (para avisar o custo antes de "buscar em todos os pagos"). */
  function fatiasPendentes(geracao, natureza, filtroId, resumo, cache) {
    return planoLeitura(geracao, natureza, filtroId, resumo).filter(function (f) { return !cache.tem(f.id); }).length;
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
    statusRotulo: statusRotulo, textoVinculo: textoVinculo, modeloLinha: modeloLinha, validarGeracao: validarGeracao, linhasFormas: linhasFormas,
    FILTROS_EXTRA: FILTROS_EXTRA, defFiltro: defFiltro, PERIODOS: PERIODOS, normalizar: normalizar, termosBusca: termosBusca, textoBuscavel: textoBuscavel, casaBusca: casaBusca, intervaloPeriodo: intervaloPeriodo, rotuloPeriodo: rotuloPeriodo,
    dentroDoPeriodo: dentroDoPeriodo, parseReais: parseReais, vinculoDe: vinculoDe, ROTULO_VINCULO: ROTULO_VINCULO, criteriosVazios: criteriosVazios, periodoAtivo: periodoAtivo, temCriterio: temCriterio, filtrarItens: filtrarItens, opcoesDistintas: opcoesDistintas,
    ordenarItens: ordenarItens, chipsAtivos: chipsAtivos, removerCriterio: removerCriterio, limparFiltros: limparFiltros, criarCacheFatias: criarCacheFatias, fatiasPendentes: fatiasPendentes };
});
