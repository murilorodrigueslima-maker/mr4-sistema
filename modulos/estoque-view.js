/* MR4 Estoque — lógica de apresentação PURA (sem DOM, sem rede). Testada em Node; no navegador vira window.EstoqueView.
 * Fase A de filtros: só CONSULTA/organização. Usa exclusivamente classificações que o motor de Compras já calculou (coverage.estado, dead_stock_band,
 * curva ABC, sinal de velocidade, mínimo calculado). Nenhum limite novo é inventado; nada é escrito. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.EstoqueView = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var num = function (v) { return typeof v === 'number' && isFinite(v); };
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  function normalizar(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function termos(q) { var n = normalizar(q); return n ? n.split(' ') : []; }
  function casa(texto, q) { var ts = termos(q); if (!ts.length) return true; var tx = normalizar(texto); return ts.every(function (t) { return tx.indexOf(t) >= 0; }); }

  // ═══ 1) FALSO NEGATIVO DA TELA LEGADA ═══
  // painel_cache/estoque é gerado a partir de estoque_minimo / ultima_venda do produto do ERP, campos que a API NÃO devolve (mínimo do ERP: 0% preenchido).
  // Lista vazia, portanto, NÃO significa "nenhum produto": significa que a fonte não consegue afirmar. Se um dia a fonte trouxer itens, eles são exibidos normalmente.
  var LEGADO = {
    abaixoMinimo: { titulo: 'Não é possível informar', kpiSub: 'ERP não informa estoque mínimo', desc: 'Esta lista depende do estoque mínimo do ERP, que esta fonte não possui; por isso ela não consegue afirmar que nenhum produto está abaixo do mínimo. Para o risco de reposição calculado pelo motor de Compras, veja a aba Produtos (filtro “Abaixo do mínimo calculado”).' },
    semGiro: { titulo: 'Não é possível informar', kpiSub: 'ERP não informa a última venda', desc: 'Esta lista depende da data da última venda do produto, que esta fonte não possui; por isso ela não consegue afirmar que nenhum produto está parado. Veja a aba Produtos (filtros de venda: nunca vendido, sem venda há +30/+60/+90/+120 dias).' },
    listaCompras: { titulo: 'Lista de reposição indisponível', kpiSub: '', desc: 'A lista de reposição é gerada a partir do estoque mínimo do ERP, que esta fonte não possui. As sugestões de compra do motor estão no módulo Compras & Estoque.' },
  };
  /** { estado: 'DADOS' | 'INDISPONIVEL', titulo, desc, kpi, contagem } — nunca trata a ausência de dado como zero. */
  function estadoListaLegada(tipo, itens) {
    var l = LEGADO[tipo]; var n = Array.isArray(itens) ? itens.length : 0;
    if (n > 0) return { estado: 'DADOS', titulo: null, desc: null, kpi: String(n), contagem: String(n), kpiSub: null };
    return { estado: 'INDISPONIVEL', titulo: l.titulo, desc: l.desc, kpi: '—', contagem: '—', kpiSub: l.kpiSub };
  }

  // ═══ 2) MARGEM BAIXA (top 50 do sync): busca, ordenação e aviso de lista limitada ═══
  var LIMITE_MARGEM = 50;
  function infoMargem(itens) {
    var n = Array.isArray(itens) ? itens.length : 0, limitada = n >= LIMITE_MARGEM;
    return { limitada: limitada, contagem: limitada ? LIMITE_MARGEM + '+' : String(n), aviso: limitada ? 'Mostrando as ' + LIMITE_MARGEM + ' menores margens (limite do sincronismo): pode haver mais produtos com margem baixa fora desta lista.' : null };
  }
  var ORD_MARGEM = { margem: function (p) { return parseFloat(p.margem); }, preco: function (p) { return p.preco; }, custo: function (p) { return p.custo; }, nome: function (p) { return normalizar(p.nome) || null; }, ref: function (p) { return normalizar(p.ref) || null; } };
  function comparar(a, b, dir) { // ausentes sempre no fim, nos dois sentidos
    var an = a === null || a === undefined || (typeof a === 'number' && !isFinite(a)), bn = b === null || b === undefined || (typeof b === 'number' && !isFinite(b));
    if (an && bn) return 0; if (an) return 1; if (bn) return -1; if (a === b) return 0; return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1);
  }
  function filtrarMargem(itens, q) { return (itens || []).filter(function (p) { return casa((p.ref || '') + ' ' + (p.nome || ''), q); }); }
  function ordenarMargem(itens, campo, dir) {
    var f = ORD_MARGEM[campo]; if (!f) return (itens || []).slice();
    return (itens || []).slice().sort(function (a, b) { return comparar(f(a), f(b), dir) || String(a.ref || '').localeCompare(String(b.ref || '')) || String(a.nome || '').localeCompare(String(b.nome || '')); });
  }

  // ═══ 3) ABA PRODUTOS ═══
  var ESTADO_COBERTURA = { CURRENT_STOCKOUT: 'Zerado', NEGATIVE_STOCK: 'Saldo negativo', COVERAGE_CRITICAL: 'Cobertura crítica', COVERAGE_LOW: 'Cobertura baixa', COVERAGE_OK: 'Cobertura adequada', COVERAGE_EXCESS: 'Excesso', NO_DEMAND_OBSERVED: 'Sem demanda observada', INSUFFICIENT_HISTORY: 'Histórico insuficiente', UNKNOWN: 'Indeterminada' };
  var SITUACOES = { sem_estoque: ['Sem estoque', ['CURRENT_STOCKOUT', 'NEGATIVE_STOCK']], baixo: ['Estoque baixo', ['COVERAGE_CRITICAL', 'COVERAGE_LOW']], normal: ['Normal', ['COVERAGE_OK']], excesso: ['Excesso', ['COVERAGE_EXCESS']], sem_demanda: ['Sem demanda observada', ['NO_DEMAND_OBSERVED']], abaixo_min_calc: ['Abaixo do mínimo calculado', null] };
  var VENDAS = { nunca: 'Nunca vendido (com estoque)', sv30: 'Sem venda há +30 dias (com estoque)', sv60: 'Sem venda há +60 dias (com estoque)', sv90: 'Sem venda há +90 dias (com estoque)', sv120: 'Sem venda há +120 dias (com estoque)', alto_giro: 'Alto giro (curva A em unidades, com vendas em 90 dias)', perdendo_giro: 'Perdendo giro' };
  var DIAS_SV = { sv30: 30, sv60: 60, sv90: 90, sv120: 120 };       // parâmetros de CONSULTA escolhidos pelo usuário (≥ N dias, igual à regra dos 120 dias); não são classificação nova
  var ABC = ['A', 'B', 'C'];
  var ORDEM_ABC = { A: 0, B: 1, C: 2, SEM_VENDA: 3 };

  /** Linha de produto a partir do bloco do motor (compras_n0_produtos), do catálogo (nome/código) e, só se autorizado, dos custos. */
  function construirLinhas(blocos, catalogo, custos) {
    var cat = {}; (catalogo || []).forEach(function (i) { cat[String(i.id)] = i; });
    var cus = null; if (custos) { cus = {}; custos.forEach(function (c) { cus[String(c.product_id)] = c; }); }
    var linhas = [];
    (blocos || []).forEach(function (p) {
      if (!p || p.active === false || p.moves_stock === false || p.kit === true || !num(p.raw_stock)) return;       // mesma exclusão do motor
      var id = String(p.product_id), c = cat[id] || {}, u = p.units || {}, v90 = num(u['90']) ? u['90'] : 0, v30 = num(u['30']) ? u['30'] : 0, est = p.raw_stock, cov = p.coverage || {};
      var l = { id: id, codigo: c.codigo || null, nome: c.nome || null, estoque: est, disponivel: num(p.available_stock_for_replenishment) ? p.available_stock_for_replenishment : null,
        vendas30d: v30, vendas90d: v90, ultimaVenda: p.last_sale_date || null, diasSemVenda: p.never_sold ? null : (num(p.days_since_last_sale) ? p.days_since_last_sale : null),
        nuncaVendido: p.never_sold === true, novo: p.new_product === true, giro90d: est > 0 ? r2(v90 / est) : null,
        coberturaEstado: cov.estado || null, coberturaDias: num(cov.dias) ? cov.dias : null, abc: p.abc_revenue || null, abcUnidades: p.abc_units || null,
        perdendoGiro: p.velocity_signal === 'RECENT_DECELERATION' || (p.sales_stopped_recently === true && est > 0), altoGiro: p.abc_units === 'A' && v90 > 0,
        abaixoMinCalc: p.below_calculated_min_stock === true,
        fornecedorCodigo: typeof p.last_supplier === 'string' && p.last_supplier ? p.last_supplier : null,   // CÓDIGO do ERP do fornecedor da última compra (a fonte não traz o nome)
        capital: undefined };
      if (cus) { var k = cus[id]; l.capital = k && est > 0 && num(k.indicative_registered_cost_value_cents) ? Math.round(k.indicative_registered_cost_value_cents / 100) : null; }
      linhas.push(l);
    });
    return linhas;
  }
  function criteriosProdutos() { return { busca: '', situacao: '', venda: '', abc: '', cobertura: '', fornecedor: '' }; }
  function temCriterioProdutos(c) { return !!(termos(c.busca).length || c.situacao || c.venda || c.abc || c.cobertura || c.fornecedor); }
  function passaSituacao(l, s) { var d = SITUACOES[s]; if (!d) return true; return d[1] ? d[1].indexOf(l.coberturaEstado) >= 0 : l.abaixoMinCalc === true; }
  function passaVenda(l, v) {
    if (!v) return true; var ativo = l.estoque > 0 && !l.novo;
    if (v === 'nunca') return ativo && l.nuncaVendido;
    if (DIAS_SV[v] != null) return ativo && !l.nuncaVendido && l.diasSemVenda !== null && l.diasSemVenda >= DIAS_SV[v];
    if (v === 'alto_giro') return l.altoGiro; if (v === 'perdendo_giro') return l.perdendoGiro; return true;
  }
  function filtrarProdutos(linhas, c) {
    return linhas.filter(function (l) {
      if (termos(c.busca).length && !casa((l.nome || '') + ' ' + (l.codigo || ''), c.busca)) return false;     // SOMENTE nome e código
      if (!passaSituacao(l, c.situacao)) return false; if (!passaVenda(l, c.venda)) return false;
      if (c.abc && l.abc !== c.abc) return false; if (c.cobertura && l.coberturaEstado !== c.cobertura) return false; if (c.fornecedor && l.fornecedorCodigo !== c.fornecedor) return false;
      return true;
    });
  }
  var CAMPOS_ORDEM = { nome: ['Produto A–Z', function (l) { return normalizar(l.nome) || null; }], codigo: ['Código', function (l) { return normalizar(l.codigo) || null; }], estoque: ['Estoque', function (l) { return l.estoque; }],
    ultima: ['Última venda', function (l) { return l.ultimaVenda; }], dias: ['Dias sem vender', function (l) { return l.diasSemVenda; }], giro: ['Giro (90 dias)', function (l) { return l.giro90d; }],
    cobertura: ['Cobertura (dias)', function (l) { return l.coberturaDias; }], curva: ['Curva ABC', function (l) { return l.abc in ORDEM_ABC ? ORDEM_ABC[l.abc] : null; }], capital: ['Capital em estoque', function (l) { return l.capital === undefined ? null : l.capital; }] };
  /** Ordenação determinística: ausentes sempre no fim (qualquer sentido); desempate por nome e id. */
  function ordenarProdutos(linhas, campo, dir) {
    var d = CAMPOS_ORDEM[campo]; if (!d) return linhas.slice();
    return linhas.slice().sort(function (a, b) { return comparar(d[1](a), d[1](b), dir) || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR') || String(a.id).localeCompare(String(b.id)); });
  }
  function opcoesFornecedor(linhas) { var m = {}; linhas.forEach(function (l) { if (l.fornecedorCodigo) m[l.fornecedorCodigo] = (m[l.fornecedorCodigo] || 0) + 1; }); return Object.keys(m).sort(function (a, b) { return m[b] - m[a] || a.localeCompare(b); }).map(function (k) { return { valor: k, n: m[k] }; }); }
  function opcoesCobertura(linhas) { var m = {}; linhas.forEach(function (l) { if (l.coberturaEstado) m[l.coberturaEstado] = (m[l.coberturaEstado] || 0) + 1; }); return Object.keys(ESTADO_COBERTURA).filter(function (k) { return m[k]; }).map(function (k) { return { valor: k, rotulo: ESTADO_COBERTURA[k], n: m[k] }; }); }
  function chipsAtivosProdutos(c) {
    var ch = [];
    if (termos(c.busca).length) ch.push({ id: 'busca', rotulo: 'Busca: ' + String(c.busca).trim() });
    if (c.situacao) ch.push({ id: 'situacao', rotulo: 'Situação: ' + SITUACOES[c.situacao][0] });
    if (c.venda) ch.push({ id: 'venda', rotulo: VENDAS[c.venda] });
    if (c.abc) ch.push({ id: 'abc', rotulo: 'Curva ' + c.abc });
    if (c.cobertura) ch.push({ id: 'cobertura', rotulo: 'Cobertura: ' + (ESTADO_COBERTURA[c.cobertura] || c.cobertura) });
    if (c.fornecedor) ch.push({ id: 'fornecedor', rotulo: 'Fornecedor (código ERP): ' + c.fornecedor });
    return ch;
  }
  function removerCriterioProdutos(c, id) { var n = Object.assign({}, c); if (id in n) n[id] = ''; return n; }
  function limparProdutos() { return criteriosProdutos(); }
  /** Cache por versão do sincronismo (compras_n0/meta.ultima_sincronizacao_ok): mudar filtros ou reabrir a aba NÃO relê os blocos. */
  function criarCacheProdutos() {
    var versao = null, dados = null, cargas = 0;
    return { versao: function () { return versao; }, valido: function (v) { return dados !== null && versao === v; }, obter: function () { return dados; }, definir: function (v, d) { versao = v; dados = d; cargas++; }, cargas: function () { return cargas; }, limpar: function () { versao = null; dados = null; } };
  }
  /** Capital só aparece para quem JÁ pode ler os custos (decidido pela leitura permitida pelas Rules); sem permissão: coluna/ordenação/KPI de capital não existem. */
  function podeVerCapital(linhas) { return linhas.length > 0 && linhas[0].capital !== undefined; }

  return { LIMITE_MARGEM: LIMITE_MARGEM, normalizar: normalizar, casa: casa, estadoListaLegada: estadoListaLegada, infoMargem: infoMargem, filtrarMargem: filtrarMargem, ordenarMargem: ordenarMargem, comparar: comparar,
    ESTADO_COBERTURA: ESTADO_COBERTURA, SITUACOES: SITUACOES, VENDAS: VENDAS, ABC: ABC, CAMPOS_ORDEM: CAMPOS_ORDEM, construirLinhas: construirLinhas, criteriosProdutos: criteriosProdutos, temCriterioProdutos: temCriterioProdutos,
    filtrarProdutos: filtrarProdutos, ordenarProdutos: ordenarProdutos, opcoesFornecedor: opcoesFornecedor, opcoesCobertura: opcoesCobertura, chipsAtivosProdutos: chipsAtivosProdutos, removerCriterioProdutos: removerCriterioProdutos,
    limparProdutos: limparProdutos, criarCacheProdutos: criarCacheProdutos, podeVerCapital: podeVerCapital };
});
