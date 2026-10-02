'use strict';
// ESTOQUE · Fase A: falso negativo da tela legada, Margem baixa, aba Produtos (busca/filtros/ordenação/capital/cache) e carga SOB DEMANDA.
const fs = require('fs'), path = require('path');
const E = require('../../modulos/estoque-view.js');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/estoque.html'), 'utf8');
const prod = (id, o = {}) => ({ product_id: String(id), active: true, moves_stock: true, kit: false, raw_stock: 10, available_stock_for_replenishment: 10, new_product: false, never_sold: false, days_since_last_sale: 5, last_sale_date: '2026-09-26', units: { 30: 10, 90: 30 }, coverage: { estado: 'COVERAGE_OK', dias: 30 }, abc_revenue: 'B', abc_units: 'B', velocity_signal: 'STABLE', sales_stopped_recently: false, below_calculated_min_stock: false, last_supplier: '1000001', ...o });
const BLOCOS = [
  prod(1, { raw_stock: 0, coverage: { estado: 'CURRENT_STOCKOUT', dias: 0 }, days_since_last_sale: 3 }),
  prod(2, { raw_stock: -4, coverage: { estado: 'NEGATIVE_STOCK' }, days_since_last_sale: 1, abc_revenue: 'A', abc_units: 'A', units: { 30: 40, 90: 120 } }),
  prod(3, { raw_stock: 5, coverage: { estado: 'COVERAGE_CRITICAL', dias: 4 }, below_calculated_min_stock: true, abc_revenue: 'A', abc_units: 'A', units: { 30: 12, 90: 40 }, last_supplier: '1000002' }),
  prod(4, { raw_stock: 50, coverage: { estado: 'COVERAGE_EXCESS', dias: 400 }, days_since_last_sale: 119, velocity_signal: 'RECENT_DECELERATION', last_supplier: '1000002' }),
  prod(5, { raw_stock: 20, coverage: { estado: 'NO_DEMAND_OBSERVED', dias: null }, days_since_last_sale: 120, units: { 30: 0, 90: 0 }, abc_revenue: 'C', abc_units: 'C' }),
  prod(6, { raw_stock: 8, never_sold: true, days_since_last_sale: null, last_sale_date: null, units: { 30: 0, 90: 0 }, abc_revenue: 'SEM_VENDA', abc_units: 'SEM_VENDA', coverage: { estado: 'NO_DEMAND_OBSERVED' }, last_supplier: null }),
  prod(7, { raw_stock: 30, days_since_last_sale: 45, new_product: false, sales_stopped_recently: true, coverage: { estado: 'COVERAGE_LOW', dias: 12 }, units: { 30: 0, 90: 9 } }),
  prod(8, { raw_stock: 9, new_product: true, never_sold: true, days_since_last_sale: null, last_sale_date: null, coverage: { estado: 'INSUFFICIENT_HISTORY' } }),
  prod(9, { active: false }), prod(10, { kit: true }), prod(11, { moves_stock: false }), prod(12, { raw_stock: null }),
];
const CAT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(i => ({ id: String(i), codigo: 'COD-' + (100 + i), nome: ['Zero', 'Lâmpada Negativa', 'Bateria Crítica', 'Farol Excesso', 'Filtro Parado', 'Cabo Nunca', 'Óleo Perdendo', 'Novo Produto', 'Inativo', 'Kit', 'Serviço', 'Sem saldo'][i - 1] }));
const CUSTOS = [{ product_id: '3', indicative_registered_cost_value_cents: 150000 }, { product_id: '4', indicative_registered_cost_value_cents: 920000 }, { product_id: '5', indicative_registered_cost_value_cents: 33000 }, { product_id: '1', indicative_registered_cost_value_cents: 0 }, { product_id: '2', indicative_registered_cost_value_cents: 5000 }];
const L = custos => E.construirLinhas(BLOCOS, CAT, custos);
const ids = l => l.map(x => x.id);
const C = o => ({ ...E.criteriosProdutos(), ...o });

describe('FALSO NEGATIVO da tela legada: lista vazia não vira "nenhum produto ✅"', () => {
  test('vazia → indisponível (nunca zero) com explicação; com itens → dados reais', () => {
    for (const tipo of ['abaixoMinimo', 'semGiro', 'listaCompras']) {
      const v = E.estadoListaLegada(tipo, []); expect(v.estado).toBe('INDISPONIVEL'); expect(v.kpi).toBe('—'); expect(v.contagem).toBe('—'); expect(v.desc).toMatch(/não possui|não tem/i); expect(v.desc).not.toMatch(/nenhum produto está abaixo do mínimo ✅/);
      expect(E.estadoListaLegada(tipo, undefined).estado).toBe('INDISPONIVEL'); expect(E.estadoListaLegada(tipo, null).kpi).toBe('—');
    }
    const d = E.estadoListaLegada('abaixoMinimo', [{ ref: 'A' }, { ref: 'B' }]); expect(d.estado).toBe('DADOS'); expect(d.kpi).toBe('2'); expect(d.contagem).toBe('2');
  });
  test('não mistura definições: aponta para a aba Produtos (mínimo CALCULADO) sem trocar o número do legado', () => {
    expect(E.estadoListaLegada('abaixoMinimo', []).desc).toMatch(/aba Produtos/); expect(E.estadoListaLegada('abaixoMinimo', []).desc).toMatch(/mínimo calculado/);
    expect(E.estadoListaLegada('listaCompras', []).desc).toMatch(/Compras & Estoque/);
  });
  test('a página usa o estado honesto e a frase enganosa saiu', () => {
    expect(HTML).not.toMatch(/Nenhum produto abaixo do mínimo/); expect(HTML).not.toMatch(/Nenhum produto sem giro identificado/); expect(HTML).not.toMatch(/Lista de reposição vazia/);
    expect(HTML).toMatch(/EV\.estadoListaLegada\('abaixoMinimo'/); expect(HTML).toMatch(/EV\.estadoListaLegada\('semGiro'/); expect(HTML).toMatch(/EV\.estadoListaLegada\('listaCompras'/);
    expect(HTML).toMatch(/id="kpiAbaixoMinimoSub"/); expect(HTML).toMatch(/id="kpiSemGiroSub"/);
  });
  test('KPIs originais preservados (total de produtos e valor em estoque seguem a mesma leitura)', () => {
    expect(HTML).toMatch(/\(dados\.total_produtos \?\? 0\)\.toLocaleString\('pt-BR'\)/); expect(HTML).toMatch(/custosRestritos \? 'Restrito' : fmtMoeda\(dados\.valor_total_estoque\)/);
  });
});

describe('Margem baixa: busca, ordenação e aviso de lista limitada (cálculo intacto)', () => {
  const M = [{ ref: 'B1', nome: 'Bateria Alfa', margem: '5.5', preco: 100, custo: 94.5 }, { ref: 'A2', nome: 'Lâmpada Beta', margem: '20.0', preco: 50, custo: 40 }, { ref: 'C3', nome: 'Cabo', margem: '12.1', preco: null, custo: 30 }];
  test('limitada a 50: contagem "50+" e aviso; com menos de 50: contagem exata e sem aviso', () => {
    const cheia = new Array(50).fill(M[0]); const i = E.infoMargem(cheia); expect(i.limitada).toBe(true); expect(i.contagem).toBe('50+'); expect(i.aviso).toMatch(/50 menores margens/); expect(i.aviso).toMatch(/pode haver mais/);
    const j = E.infoMargem(M); expect(j.limitada).toBe(false); expect(j.contagem).toBe('3'); expect(j.aviso).toBeNull();
  });
  test('busca (sem acento/caixa) e ordenação com ausentes no fim', () => {
    expect(E.filtrarMargem(M, 'lampada').map(p => p.ref)).toEqual(['A2']); expect(E.filtrarMargem(M, 'b1').map(p => p.ref)).toEqual(['B1']); expect(E.filtrarMargem(M, '').length).toBe(3);
    expect(E.ordenarMargem(M, 'margem', 'asc').map(p => p.ref)).toEqual(['B1', 'C3', 'A2']); expect(E.ordenarMargem(M, 'margem', 'desc').map(p => p.ref)).toEqual(['A2', 'C3', 'B1']);
    expect(E.ordenarMargem(M, 'preco', 'asc').map(p => p.ref)).toEqual(['A2', 'B1', 'C3']); expect(E.ordenarMargem(M, 'preco', 'desc').map(p => p.ref)).toEqual(['B1', 'A2', 'C3']);   // preço ausente sempre no fim
    const antes = JSON.stringify(M); E.ordenarMargem(M, 'nome', 'asc'); expect(JSON.stringify(M)).toBe(antes);
  });
  test('a página mostra o aviso e a contagem 50+ e não altera o cálculo (sem tocar em margem/preço/custo da fonte)', () => {
    expect(HTML).toMatch(/EV\.infoMargem\(itens\)/); expect(HTML).toMatch(/id="margemBusca"/); expect(HTML).toMatch(/id="margemOrdem"/); expect(HTML).toMatch(/const m = parseFloat\(p\.margem\) \|\| 0;/);
  });
});

describe('Produtos: linhas a partir dos blocos do motor (mesma exclusão do motor)', () => {
  test('inativo, kit, sem movimento de estoque e sem saldo ficam fora; nome/código vêm do catálogo', () => {
    const l = L(null); expect(ids(l)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(l[2]).toMatchObject({ codigo: 'COD-103', nome: 'Bateria Crítica', estoque: 5, coberturaEstado: 'COVERAGE_CRITICAL', coberturaDias: 4, abaixoMinCalc: true, abc: 'A', fornecedorCodigo: '1000002' });
    expect(l[0].giro90d).toBeNull(); expect(l[2].giro90d).toBe(8); expect(l[5].fornecedorCodigo).toBeNull(); expect(l[5].diasSemVenda).toBeNull(); expect(l[5].nuncaVendido).toBe(true);
  });
  test('produto fora do catálogo não quebra (sem nome/código)', () => { const l = E.construirLinhas([prod(99)], [], null); expect(l[0].nome).toBeNull(); expect(l[0].codigo).toBeNull(); });
});

describe('Produtos: busca SOMENTE por nome e código (sem acento/caixa; AND)', () => {
  test('nome e código', () => {
    const l = L(null); expect(ids(E.filtrarProdutos(l, C({ busca: 'lampada' })))).toEqual(['2']); expect(ids(E.filtrarProdutos(l, C({ busca: 'COD-103' })))).toEqual(['3']); expect(ids(E.filtrarProdutos(l, C({ busca: '  oleo  perdendo ' })))).toEqual(['7']);
    expect(ids(E.filtrarProdutos(l, C({ busca: 'cod-10' })))).toHaveLength(8);   // prefixo comum
  });
  test('NÃO pesquisa fornecedor, marca, categoria nem código de barras', () => { const l = L(null); expect(E.filtrarProdutos(l, C({ busca: '1000002' }))).toEqual([]); expect(E.filtrarProdutos(l, C({ busca: 'fabricante' }))).toEqual([]); });
});

describe('Produtos: filtros determinísticos (sem limites novos)', () => {
  const l = L(null), f = c => ids(E.filtrarProdutos(l, C(c)));
  test('situação', () => {
    expect(f({ situacao: 'sem_estoque' })).toEqual(['1', '2']); expect(f({ situacao: 'baixo' })).toEqual(['3', '7']); expect(f({ situacao: 'normal' })).toEqual([]); expect(f({ situacao: 'excesso' })).toEqual(['4']);
    expect(f({ situacao: 'sem_demanda' })).toEqual(['5', '6']); expect(f({ situacao: 'abaixo_min_calc' })).toEqual(['3']);
  });
  test('venda/giro: "sem venda +N" é ≥ N, só com estoque e não novo; nunca vendido idem; 119 não / 120 sim', () => {
    expect(f({ venda: 'sv30' })).toEqual(['4', '5', '7']); expect(f({ venda: 'sv60' })).toEqual(['4', '5']); expect(f({ venda: 'sv90' })).toEqual(['4', '5']); expect(f({ venda: 'sv120' })).toEqual(['5']);
    expect(f({ venda: 'nunca' })).toEqual(['6']);                    // o 8 é produto novo: fora; o 1 tem estoque 0 e já vendeu
    expect(f({ venda: 'alto_giro' })).toEqual(['2', '3']); expect(f({ venda: 'perdendo_giro' })).toEqual(['4', '7']);
  });
  test('curva ABC, cobertura (estado do motor) e fornecedor (código do ERP)', () => {
    expect(f({ abc: 'A' })).toEqual(['2', '3']); expect(f({ abc: 'C' })).toEqual(['5']); expect(f({ abc: 'B' })).toEqual(['1', '4', '7', '8']);
    expect(f({ cobertura: 'COVERAGE_EXCESS' })).toEqual(['4']); expect(f({ cobertura: 'INSUFFICIENT_HISTORY' })).toEqual(['8']);
    expect(f({ fornecedor: '1000002' })).toEqual(['3', '4']); expect(f({ fornecedor: '1000001' })).toEqual(['1', '2', '5', '7', '8']);
    expect(E.opcoesFornecedor(l)).toEqual([{ valor: '1000001', n: 5 }, { valor: '1000002', n: 2 }]);
    expect(E.opcoesCobertura(l).map(o => o.valor)).toEqual(['CURRENT_STOCKOUT', 'NEGATIVE_STOCK', 'COVERAGE_CRITICAL', 'COVERAGE_LOW', 'COVERAGE_EXCESS', 'NO_DEMAND_OBSERVED', 'INSUFFICIENT_HISTORY']);
  });
  test('combinação de critérios (3+) e limpar', () => {
    expect(f({ busca: 'cod-10', venda: 'sv30', abc: 'C', fornecedor: '1000001' })).toEqual(['5']); expect(f({ busca: 'cod-10', venda: 'sv30', abc: 'C', fornecedor: '1000002' })).toEqual([]);
    expect(f({ situacao: 'excesso', venda: 'perdendo_giro', abc: 'B' })).toEqual(['4']);
    const c = C({ busca: 'x', situacao: 'baixo', venda: 'sv30', abc: 'A', cobertura: 'COVERAGE_LOW', fornecedor: '1000001' });
    expect(E.chipsAtivosProdutos(c).map(x => x.id)).toEqual(['busca', 'situacao', 'venda', 'abc', 'cobertura', 'fornecedor']);
    const r = E.removerCriterioProdutos(c, 'abc'); expect(r.abc).toBe(''); expect(r.venda).toBe('sv30'); expect(c.abc).toBe('A');   // só aquele critério; sem mutar
    expect(E.temCriterioProdutos(E.limparProdutos())).toBe(false);
  });
  test('rótulos de fornecedor deixam claro que é CÓDIGO do ERP da última compra (não "fornecedor oficial")', () => {
    expect(E.chipsAtivosProdutos(C({ fornecedor: '1000002' }))[0].rotulo).toBe('Fornecedor (código ERP): 1000002'); expect(HTML).toMatch(/Fornecedor da última compra \(código do ERP\)/); expect(HTML).toMatch(/Fornecedor \(cód\. ERP, última compra\)/);
  });
});

describe('Produtos: ordenação determinística (ausentes sempre no fim; desempate por nome e id)', () => {
  const l = L(CUSTOS), o = (c, d) => ids(E.ordenarProdutos(l, c, d));
  test('estoque, última venda, dias sem vender, giro, cobertura, curva, nome, código', () => {
    expect(o('estoque', 'asc')).toEqual(['2', '1', '3', '6', '8', '5', '7', '4']); expect(o('estoque', 'desc')).toEqual(['4', '7', '5', '8', '6', '3', '1', '2']);
    expect(o('dias', 'desc')).toEqual(['5', '4', '7', '3', '1', '2', '6', '8']); expect(o('dias', 'asc').slice(-2)).toEqual(['6', '8']);                       // nunca vendidos (sem dias) no fim nos dois sentidos
    expect(o('ultima', 'desc').slice(-2)).toEqual(['6', '8']); expect(o('ultima', 'asc').slice(-2)).toEqual(['6', '8']);
    expect(o('giro', 'desc')).toEqual(['3', '8', '4', '7', '6', '5', '2', '1']);                                                                                 // giro nulo (sem saldo positivo) no fim
    expect(o('giro', 'asc')).toEqual(['6', '5', '7', '4', '8', '3', '2', '1']);
    expect(o('cobertura', 'asc')).toEqual(['1', '3', '7', '4', '6', '5', '2', '8']);   // sem cobertura (6,5,2,8) no fim, por nome expect(o('cobertura', 'desc').slice(0, 2)).toEqual(['4', '7']);
    expect(o('curva', 'asc').slice(0, 2)).toEqual(['3', '2']); expect(o('curva', 'asc').pop()).toBe('6'); expect(o('curva', 'desc')[0]).toBe('6');                // A < B < C < SEM_VENDA
    expect(o('nome', 'asc')[0]).toBe('3'); expect(o('codigo', 'asc')[0]).toBe('1');
  });
  test('capital: só existe ordenação/valor com custos carregados; ausente vai ao fim; sem custos o campo vira "ausente" para todos', () => {
    expect(o('capital', 'desc')).toEqual(['4', '3', '5', '6', '2', '8', '7', '1']); expect(o('capital', 'asc')).toEqual(['5', '3', '4', '6', '2', '8', '7', '1']);
    const sem = E.construirLinhas(BLOCOS, CAT, null); expect(sem.every(x => x.capital === undefined)).toBe(true); expect(ids(E.ordenarProdutos(sem, 'capital', 'desc'))).toEqual(ids(E.ordenarProdutos(sem, 'nome', 'asc')));
  });
  test('ordenar não muta e é estável entre execuções', () => { const a = ids(l); E.ordenarProdutos(l, 'estoque', 'asc'); expect(ids(l)).toEqual(a); expect(o('estoque', 'asc')).toEqual(o('estoque', 'asc')); });
});

describe('Capital só para quem já pode ver custos (Rules): sem permissão não existe coluna, ordenação nem valor', () => {
  test('com custos: capital só para saldo positivo com valor; sem custos: undefined e podeVerCapital=false', () => {
    const com = L(CUSTOS); expect(E.podeVerCapital(com)).toBe(true); expect(com.find(x => x.id === '3').capital).toBe(1500); expect(com.find(x => x.id === '1').capital).toBeNull(); expect(com.find(x => x.id === '2').capital).toBeNull();   // saldo ≤ 0 → sem capital
    const sem = L(null); expect(E.podeVerCapital(sem)).toBe(false); expect(sem.some(x => x.capital !== undefined)).toBe(false); expect(E.podeVerCapital([])).toBe(false);
  });
  test('a página lê custos numa tentativa protegida e esconde capital quando a Rule nega (nenhuma permissão ampliada)', () => {
    expect(HTML).toMatch(/try \{ const ks = await getDocs\(collection\(db, 'compras_n0_custos'\)\)/); expect(HTML).toMatch(/e\.code === 'permission-denied'|\(e && e\.code === 'permission-denied'\)/);
    expect(HTML).toMatch(/cap = EV\.podeVerCapital\(L\)/); expect(HTML).toMatch(/k !== 'capital' \|\| cap/);
  });
});

describe('Cache por versão (mudar filtros/reabrir não relê os blocos)', () => {
  test('mesma versão reaproveita; versão nova ou limpar invalida; contagem de cargas', () => {
    const c = E.criarCacheProdutos(); expect(c.valido('v1')).toBe(false); c.definir('v1', [1, 2]); expect(c.valido('v1')).toBe(true); expect(c.obter()).toEqual([1, 2]); expect(c.valido('v2')).toBe(false); expect(c.cargas()).toBe(1);
    c.definir('v2', [3]); expect(c.cargas()).toBe(2); expect(c.valido('v1')).toBe(false); c.limpar(); expect(c.valido('v2')).toBe(false);
  });
});

describe('Carga SOB DEMANDA e sem IA (página)', () => {
  test('blocos só são lidos dentro de carregarProdutos(), que só roda ao abrir a aba Produtos', () => {
    expect([...HTML.matchAll(/collection\(db, 'compras_n0_produtos'\)/g)]).toHaveLength(1); expect([...HTML.matchAll(/collection\(db, 'compras_n0_custos'\)/g)]).toHaveLength(1); expect([...HTML.matchAll(/'produtos_catalogo'/g)].length).toBeGreaterThanOrEqual(1);
    const iniFn = HTML.indexOf('async function carregarProdutos'), fimFn = HTML.indexOf('function abrirProdutos'); const corpo = HTML.slice(iniFn, fimFn);
    expect(corpo).toMatch(/compras_n0_produtos/); expect(HTML.indexOf("collection(db, 'compras_n0_produtos')")).toBeGreaterThan(iniFn); expect(HTML.indexOf("collection(db, 'compras_n0_custos')")).toBeGreaterThan(iniFn);
    expect(HTML).toMatch(/if \(tab === 'produtos' && !window\._prodAberto\) \{ window\._prodAberto = true; abrirProdutos\(\); \}/);
    expect(HTML).toMatch(/if \(!forcar && versao && prodCache\.valido\(versao\)\)/);
    const carregarEstoque = HTML.slice(HTML.indexOf('async function carregarEstoque'), HTML.indexOf('// ── PRODUTOS (Fase A)'));
    expect(carregarEstoque).not.toMatch(/compras_n0_|abrirProdutos|carregarProdutos/);   // a abertura da tela NÃO lê os blocos
  });
  test('filtros/ordenação do Estoque não chamam IA nem escrevem (FILTER_AI_CALLS=0)', () => {
    const trecho = HTML.slice(HTML.indexOf('// ── PRODUTOS (Fase A)'), HTML.indexOf('// ── Mobile sidebar toggle'));
    expect(trecho).not.toMatch(/aiAgente|httpsCallable|chamar\(|setDoc|addDoc|updateDoc|deleteDoc|fetch\(/);
    expect(trecho).not.toMatch(/\bwhere\(|\borderBy\(/);
    const view = fs.readFileSync(path.join(__dirname, '../../modulos/estoque-view.js'), 'utf8'); expect(view).not.toMatch(/aiAgente|httpsCallable|firebase|fetch\(|XMLHttp|localStorage/);
  });
  test('a aba do Agente e o Equivalentes seguem intactos', () => {
    expect(HTML).toMatch(/id="tabBtnAgente" hidden onclick="trocarTab\('agente', this\)"/); expect(HTML).toMatch(/window\.__agenteEstoque\.abrir\(\)/); expect(HTML).toMatch(/trocarTab\('equivalentes', this\)/); expect(HTML).toMatch(/eqCarregar\(\)/);
    expect(HTML).toMatch(/<script src="\.\/estoque-view\.js\?v=\w+"><\/script>/);
  });
});
