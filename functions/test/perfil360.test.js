'use strict';

/**
 * Testes unitários — Perfil Comercial 360 V1
 * P360-01 a P360-45 (45 testes determinísticos, sem I/O)
 */

const {
  calcularPerfil360,
  deduplicarVendas,
  agruparVendasPorCliente,
  daysBetweenCalendarDates,
  subtractCalendarDays,
  isWithinWindow,
  toCentavos,
  centavosToReais,
  VERSAO_ENGINE,
} = require('../lib/perfil360');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkVenda(id, data, nome_situacao, valor_total, cliente_id, extra = {}) {
  const { vendedor_id = '10', nome_vendedor = 'Vendedor Padrão', produtos = [], ...rest } = extra;
  return {
    id:          String(id),
    data,
    nome_situacao,
    valor_total: String(valor_total),
    cliente_id:  String(cliente_id),
    cadastrado_em: `${data} 12:00:00`,
    vendedor_id,
    nome_vendedor,
    produtos,
    ...rest,
  };
}

function mkConc(id, data, valor, cliente_id, extra = {}) {
  return mkVenda(id, data, 'Concretizada', valor, cliente_id, extra);
}

// ── P360-01: vendas vazias → nuncaComprou ─────────────────────────────────────
test('P360-01: sem vendas → nuncaComprou=true, campos zerados, inativo=false', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_X',
    gestaoClickId: 'GC_X',
    vendas: [],
    dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(true);
  expect(p.inativo120d).toBe(false);
  expect(p.primeiraCompraEm).toBeNull();
  expect(p.ultimaCompraEm).toBeNull();
  expect(p.diasSemComprar).toBeNull();
  expect(p.faturamentoTotal).toBe(0);
  expect(p.pedidosTotal).toBe(0);
  expect(p.ticketMedioTotal).toBeNull();
  expect(p.versaoEngine).toBe(VERSAO_ENGINE);
  expect(p.dataReferencia).toBe('2026-09-15');
  expect(p._conflicts).toEqual([]);
});

// ── P360-02: uma Concretizada na dataReferencia ───────────────────────────────
test('P360-02: uma venda Concretizada na dataReferencia → perfil básico correto', () => {
  const v = mkConc('1', '2026-09-15', '100.00', 'GC1');
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_1',
    gestaoClickId: 'GC1',
    vendas: [v],
    dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(false);
  expect(p.primeiraCompraEm).toBe('2026-09-15');
  expect(p.ultimaCompraEm).toBe('2026-09-15');
  expect(p.diasSemComprar).toBe(0);
  expect(p.faturamentoTotal).toBe(100);
  expect(p.pedidosTotal).toBe(1);
  expect(p.ticketMedioTotal).toBe(100);
  expect(p.versaoEngine).toBe(VERSAO_ENGINE);
});

// ── P360-03: múltiplas vendas Concretizadas ───────────────────────────────────
test('P360-03: múltiplas Concretizadas → faturamento e pedidos acumulados', () => {
  const vendas = [
    mkConc('1', '2026-01-10', '50.00', 'G'),
    mkConc('2', '2026-05-20', '200.00', 'G'),
    mkConc('3', '2026-09-15', '75.00', 'G'),
  ];
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15',
  });
  expect(p.pedidosTotal).toBe(3);
  expect(p.faturamentoTotal).toBe(325);
  expect(p.primeiraCompraEm).toBe('2026-01-10');
  expect(p.ultimaCompraEm).toBe('2026-09-15');
});

// ── P360-04: status Reservado ignorado ───────────────────────────────────────
test('P360-04: status "Reservado" ignorado', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G',
    vendas: [mkVenda('1', '2026-09-15', 'Reservado', '100.00', 'G')],
    dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(true);
  expect(p.pedidosTotal).toBe(0);
});

// ── P360-05: status Em andamento ignorado ─────────────────────────────────────
test('P360-05: status "Em andamento" ignorado', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G',
    vendas: [mkVenda('1', '2026-09-15', 'Em andamento', '100.00', 'G')],
    dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(true);
});

// ── P360-06: status Em aberto ignorado ───────────────────────────────────────
test('P360-06: status "Em aberto" ignorado', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G',
    vendas: [mkVenda('1', '2026-09-15', 'Em aberto', '100.00', 'G')],
    dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(true);
});

// ── P360-07: status desconhecido ignorado ─────────────────────────────────────
test('P360-07: status desconhecido ("Cancelado") ignorado', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G',
    vendas: [mkVenda('1', '2026-09-15', 'Cancelado', '100.00', 'G')],
    dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(true);
});

// ── P360-08: deduplicar ID idêntico sem conflito ──────────────────────────────
test('P360-08: mesmo ID, conteúdo idêntico → conta uma vez, sem _conflicts', () => {
  const v1 = mkConc('100', '2026-09-01', '50.00', 'G');
  const v2 = mkConc('100', '2026-09-01', '50.00', 'G');
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G',
    vendas: [v1, v2],
    dataReferencia: '2026-09-15',
  });
  expect(p.pedidosTotal).toBe(1);
  expect(p._conflicts).toHaveLength(0);
});

// ── P360-09: mesmo ID com valor divergente → registra conflito ───────────────
test('P360-09: mesmo ID com valor_total diferente → registra em _conflicts, mantém primeira', () => {
  const v1 = mkConc('200', '2026-09-01', '50.00', 'G');
  const v2 = mkConc('200', '2026-09-01', '99.00', 'G');
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G',
    vendas: [v1, v2],
    dataReferencia: '2026-09-15',
  });
  expect(p.pedidosTotal).toBe(1);
  expect(p._conflicts).toHaveLength(1);
  expect(p._conflicts[0].id).toBe('200');
  expect(p.faturamentoTotal).toBe(50);
});

// ── P360-10: primeiraCompraEm = mínimo ────────────────────────────────────────
test('P360-10: primeiraCompraEm = data mínima entre Concretizadas', () => {
  const vendas = [
    mkConc('1', '2026-06-15', '100', 'G'),
    mkConc('2', '2026-03-10', '100', 'G'),
    mkConc('3', '2026-09-01', '100', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.primeiraCompraEm).toBe('2026-03-10');
});

// ── P360-11: ultimaCompraEm = máximo ──────────────────────────────────────────
test('P360-11: ultimaCompraEm = data máxima entre Concretizadas', () => {
  const vendas = [
    mkConc('1', '2026-06-15', '100', 'G'),
    mkConc('2', '2026-03-10', '100', 'G'),
    mkConc('3', '2026-09-01', '100', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.ultimaCompraEm).toBe('2026-09-01');
});

// ── P360-12: 119 dias → NÃO inativo ──────────────────────────────────────────
test('P360-12: 119 dias sem comprar → inativo120d=false', () => {
  // 2026-05-19 → 2026-09-15 = 119 dias
  const v = mkConc('1', '2026-05-19', '100', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2026-09-15' });
  expect(p.diasSemComprar).toBe(119);
  expect(p.inativo120d).toBe(false);
});

// ── P360-13: exatamente 120 dias → inativo ───────────────────────────────────
test('P360-13: exatamente 120 dias sem comprar → inativo120d=true', () => {
  // 2026-05-18 → 2026-09-15 = 120 dias
  const v = mkConc('1', '2026-05-18', '100', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2026-09-15' });
  expect(p.diasSemComprar).toBe(120);
  expect(p.inativo120d).toBe(true);
});

// ── P360-14: 121 dias → inativo ───────────────────────────────────────────────
test('P360-14: 121 dias sem comprar → inativo120d=true', () => {
  // 2026-05-17 → 2026-09-15 = 121 dias
  const v = mkConc('1', '2026-05-17', '100', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2026-09-15' });
  expect(p.diasSemComprar).toBe(121);
  expect(p.inativo120d).toBe(true);
});

// ── P360-15: nuncaComprou → inativo120d=false ─────────────────────────────────
test('P360-15: nuncaComprou → inativo120d=false (não é inativo, nunca comprou)', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [], dataReferencia: '2026-09-15',
  });
  expect(p.nuncaComprou).toBe(true);
  expect(p.inativo120d).toBe(false);
});

// ── P360-16: data de início da janela 30d está incluída ──────────────────────
test('P360-16: data exata do início da janela 30d é incluída (isWithinWindow inclusive)', () => {
  const w30start = subtractCalendarDays('2026-09-15', 29); // '2026-08-17'
  const v = mkConc('1', w30start, '50.00', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2026-09-15' });
  expect(p.pedidos30d).toBe(1);
  expect(p.faturamento30d).toBe(50);
});

// ── P360-17: dia anterior ao início da janela está excluído ──────────────────
test('P360-17: dia anterior ao início da janela 30d é excluído', () => {
  const dayBefore = subtractCalendarDays('2026-09-15', 30); // '2026-08-16'
  const v = mkConc('1', dayBefore, '50.00', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2026-09-15' });
  expect(p.pedidos30d).toBe(0);
  expect(p.faturamento30d).toBe(0);
  expect(p.pedidosTotal).toBe(1);
});

// ── P360-18: janela 60d ───────────────────────────────────────────────────────
test('P360-18: janela 60d — inclui início, exclui dia anterior', () => {
  const w60start  = subtractCalendarDays('2026-09-15', 59);
  const w60before = subtractCalendarDays('2026-09-15', 60);
  const vendas = [
    mkConc('1', w60start,  '100', 'G'),
    mkConc('2', w60before, '200', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.pedidos60d).toBe(1);
  expect(p.faturamento60d).toBe(100);
  expect(p.pedidosTotal).toBe(2);
});

// ── P360-19: janela 90d ───────────────────────────────────────────────────────
test('P360-19: janela 90d — inclui início, exclui dia anterior', () => {
  const w90start  = subtractCalendarDays('2026-09-15', 89);
  const w90before = subtractCalendarDays('2026-09-15', 90);
  const vendas = [
    mkConc('1', w90start,  '50', 'G'),
    mkConc('2', w90before, '50', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.pedidos90d).toBe(1);
  expect(p.pedidosTotal).toBe(2);
});

// ── P360-20: janela 180d ──────────────────────────────────────────────────────
test('P360-20: janela 180d — inclui início, exclui dia anterior', () => {
  const w180start  = subtractCalendarDays('2026-09-15', 179);
  const w180before = subtractCalendarDays('2026-09-15', 180);
  const vendas = [
    mkConc('1', w180start,  '80', 'G'),
    mkConc('2', w180before, '80', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.pedidos180d).toBe(1);
  expect(p.pedidosTotal).toBe(2);
});

// ── P360-21: ticketMedio = null quando sem pedidos na janela ─────────────────
test('P360-21: ticketMedio30d=null quando pedidos30d=0', () => {
  const v = mkConc('1', subtractCalendarDays('2026-09-15', 30), '100', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2026-09-15' });
  expect(p.ticketMedio30d).toBeNull();
  expect(p.ticketMedioTotal).toBe(100);
});

// ── P360-22: arredondamento do ticket médio ───────────────────────────────────
test('P360-22: ticketMedio arredonda half-up (301 centavos ÷ 2 = 1.51)', () => {
  const vendas = [
    mkConc('1', '2026-09-15', '1.00', 'G'),
    mkConc('2', '2026-09-15', '2.01', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.faturamento30d).toBe(3.01);
  expect(p.ticketMedio30d).toBe(1.51);
});

// ── P360-23: 2 vendas no mesmo dia → pedidos=2 ───────────────────────────────
test('P360-23: dois pedidos no mesmo dia → pedidosTotal=2 e faturamento soma os dois', () => {
  const vendas = [
    mkConc('1', '2026-09-15', '50', 'G'),
    mkConc('2', '2026-09-15', '50', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.pedidosTotal).toBe(2);
  expect(p.faturamentoTotal).toBe(100);
});

// ── P360-24: 2 vendas no mesmo dia → frequência null ────────────────────────
test('P360-24: dois pedidos no mesmo dia → frequência null (apenas 1 data distinta)', () => {
  const vendas = [
    mkConc('1', '2026-09-15', '50', 'G'),
    mkConc('2', '2026-09-15', '50', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.diasEntreComprasMedio).toBeNull();
  expect(p.diasEntreComprasMediana).toBeNull();
});

// ── P360-25: frequência por datas distintas ───────────────────────────────────
test('P360-25: frequência calculada por datas distintas (não por pedido individual)', () => {
  // 4 pedidos mas só 3 datas distintas: 2026-01-01, 2026-02-01, 2026-03-01
  // intervalos: [31, 28] → média=29.5, mediana=29.5
  const vendas = [
    mkConc('1', '2026-01-01', '100', 'G'),
    mkConc('2', '2026-01-01', '100', 'G'),
    mkConc('3', '2026-02-01', '100', 'G'),
    mkConc('4', '2026-03-01', '100', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.pedidosTotal).toBe(4);
  expect(p.diasEntreComprasMedio).toBe(29.5);
  expect(p.diasEntreComprasMediana).toBe(29.5);
});

// ── P360-26: mediana com número ímpar de intervalos ──────────────────────────
test('P360-26: mediana ímpar — [5,10,28] → mediana=10', () => {
  // datas: 2026-01-01, 2026-01-06 (+5d), 2026-01-16 (+10d), 2026-02-13 (+28d)
  const vendas = [
    mkConc('1', '2026-01-01', '10', 'G'),
    mkConc('2', '2026-01-06', '10', 'G'),
    mkConc('3', '2026-01-16', '10', 'G'),
    mkConc('4', '2026-02-13', '10', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.diasEntreComprasMediana).toBe(10);
});

// ── P360-27: mediana com número par de intervalos ─────────────────────────────
test('P360-27: mediana par — [5,10,11,28] → mediana=10.5', () => {
  // datas: 2026-01-01, 2026-01-06 (+5d), 2026-01-16 (+10d), 2026-01-27 (+11d), 2026-02-24 (+28d)
  const vendas = [
    mkConc('1', '2026-01-01', '10', 'G'),
    mkConc('2', '2026-01-06', '10', 'G'),
    mkConc('3', '2026-01-16', '10', 'G'),
    mkConc('4', '2026-01-27', '10', 'G'),
    mkConc('5', '2026-02-24', '10', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.diasEntreComprasMediana).toBe(10.5);
});

// ── P360-28: quantidadeUnidades soma todas ocorrências do produto ─────────────
test('P360-28: quantidadeUnidades soma quantidade de todos os itens do produto', () => {
  const venda = mkConc('1', '2026-09-15', '90', 'G', {
    produtos: [
      { produto_id: 'P1', nome_produto: 'Óleo', quantidade: '3', valor_total: '90' },
    ],
  });
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [venda],
    dataReferencia: '2026-09-15', produtosPorId: { P1: { nome_grupo: 'Lubrificantes' } },
  });
  const prod = p.produtosMaisComprados.find(x => x.produtoId === 'P1');
  expect(prod).toBeDefined();
  expect(prod.quantidadeUnidades).toBe(3);
});

// ── P360-29: quantidadePedidos conta vendas distintas ────────────────────────
test('P360-29: quantidadePedidos de produto = count de vendas distintas com aquele produto', () => {
  const v1 = mkConc('1', '2026-09-01', '30', 'G', {
    produtos: [{ produto_id: 'P1', nome_produto: 'Óleo', quantidade: '1', valor_total: '30' }],
  });
  const v2 = mkConc('2', '2026-09-10', '30', 'G', {
    produtos: [{ produto_id: 'P1', nome_produto: 'Óleo', quantidade: '1', valor_total: '30' }],
  });
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v1, v2],
    dataReferencia: '2026-09-15', produtosPorId: {},
  });
  const prod = p.produtosMaisComprados.find(x => x.produtoId === 'P1');
  expect(prod.quantidadePedidos).toBe(2);
});

// ── P360-30: faturamento por produto soma item.valor_total ───────────────────
test('P360-30: faturamento de produto soma item.valor_total de cada venda', () => {
  const v1 = mkConc('1', '2026-09-01', '50', 'G', {
    produtos: [{ produto_id: 'P1', nome_produto: 'Óleo', quantidade: '1', valor_total: '50' }],
  });
  const v2 = mkConc('2', '2026-09-10', '80', 'G', {
    produtos: [{ produto_id: 'P1', nome_produto: 'Óleo', quantidade: '2', valor_total: '80' }],
  });
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v1, v2],
    dataReferencia: '2026-09-15', produtosPorId: {},
  });
  const prod = p.produtosMaisComprados.find(x => x.produtoId === 'P1');
  expect(prod.faturamento).toBe(130);
});

// ── P360-31: mesmo produto duas vezes na mesma venda ─────────────────────────
test('P360-31: mesmo produto em dois itens da mesma venda → qty soma, pedidos=1', () => {
  const venda = mkConc('1', '2026-09-15', '100', 'G', {
    produtos: [
      { produto_id: 'P1', nome_produto: 'Óleo', quantidade: '2', valor_total: '20' },
      { produto_id: 'P1', nome_produto: 'Óleo', quantidade: '3', valor_total: '30' },
    ],
  });
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [venda],
    dataReferencia: '2026-09-15', produtosPorId: {},
  });
  const prod = p.produtosMaisComprados.find(x => x.produtoId === 'P1');
  expect(prod.quantidadeUnidades).toBe(5);
  expect(prod.quantidadePedidos).toBe(1);
  expect(prod.faturamento).toBe(50);
});

// ── P360-32: categoria vem de produtosPorId.nome_grupo ───────────────────────
test('P360-32: categoria de produto vem de produtosPorId[id].nome_grupo', () => {
  const venda = mkConc('1', '2026-09-15', '50', 'G', {
    produtos: [{ produto_id: 'P1', nome_produto: 'Filtro', quantidade: '1', valor_total: '50' }],
  });
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [venda],
    dataReferencia: '2026-09-15', produtosPorId: { P1: { nome_grupo: 'Filtros de Ar' } },
  });
  const cat = p.categoriasMaisCompradas[0];
  expect(cat.categoria).toBe('Filtros de Ar');
});

// ── P360-33: produto ausente em produtosPorId → SEM_CATEGORIA ────────────────
test('P360-33: produto ausente em produtosPorId → categoria SEM_CATEGORIA', () => {
  const venda = mkConc('1', '2026-09-15', '50', 'G', {
    produtos: [{ produto_id: 'P1', nome_produto: 'Peça X', quantidade: '1', valor_total: '50' }],
  });
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [venda],
    dataReferencia: '2026-09-15', produtosPorId: {},
  });
  const cat = p.categoriasMaisCompradas[0];
  expect(cat.categoria).toBe('SEM_CATEGORIA');
});

// ── P360-34: quantidadePedidos de categoria = vendas distintas ───────────────
test('P360-34: categoria.quantidadePedidos = vendas distintas (mesmo se dois produtos da cat na mesma venda)', () => {
  // venda1 tem P1 e P2, ambos da CatX → venda1 conta UMA VEZ para CatX
  // venda2 tem P1, também da CatX → total pedidosCatX=2
  const v1 = mkConc('1', '2026-09-01', '70', 'G', {
    produtos: [
      { produto_id: 'P1', nome_produto: 'A', quantidade: '1', valor_total: '30' },
      { produto_id: 'P2', nome_produto: 'B', quantidade: '1', valor_total: '40' },
    ],
  });
  const v2 = mkConc('2', '2026-09-10', '40', 'G', {
    produtos: [
      { produto_id: 'P1', nome_produto: 'A', quantidade: '1', valor_total: '40' },
    ],
  });
  const prods = { P1: { nome_grupo: 'CatX' }, P2: { nome_grupo: 'CatX' } };
  const p = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v1, v2],
    dataReferencia: '2026-09-15', produtosPorId: prods,
  });
  const cat = p.categoriasMaisCompradas.find(c => c.categoria === 'CatX');
  expect(cat.quantidadePedidos).toBe(2);
});

// ── P360-35: vendedor da última venda ──────────────────────────────────────────
test('P360-35: vendedorUltimaVendaNome vem da venda mais recente por data', () => {
  const vendas = [
    mkConc('1', '2026-09-14', '100', 'G', { nome_vendedor: 'Ana', vendedor_id: '1' }),
    mkConc('2', '2026-09-15', '100', 'G', { nome_vendedor: 'Bruno', vendedor_id: '2' }),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.vendedorUltimaVendaNome).toBe('Bruno');
  expect(p.vendedorUltimaVendaId).toBe('2');
});

// ── P360-36: tie-break pela ID numérica ───────────────────────────────────────
test('P360-36: mesma data e cadastrado_em → ID numérico maior vence no tie-break', () => {
  const vendas = [
    mkConc('100', '2026-09-15', '100', 'G', { nome_vendedor: 'Ana',   vendedor_id: '1' }),
    mkConc('200', '2026-09-15', '100', 'G', { nome_vendedor: 'Bruno', vendedor_id: '2' }),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.vendedorUltimaVendaNome).toBe('Bruno');
});

// ── P360-37: fronteira de mês ─────────────────────────────────────────────────
test('P360-37: janela 30d atravessa fronteira de mês (ago→set) corretamente', () => {
  // ref=2026-09-01, w30start = '2026-08-03' (sept01 - 29d)
  const ref = '2026-09-01';
  const w30start = subtractCalendarDays(ref, 29);
  expect(w30start).toBe('2026-08-03');
  const vInside  = mkConc('1', '2026-08-03', '100', 'G');
  const vOutside = mkConc('2', '2026-08-02', '100', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [vInside, vOutside], dataReferencia: ref });
  expect(p.pedidos30d).toBe(1);
  expect(p.faturamento30d).toBe(100);
});

// ── P360-38: fronteira de ano ─────────────────────────────────────────────────
test('P360-38: janela 30d atravessa fronteira de ano (dez/2025→jan/2026) corretamente', () => {
  // ref=2026-01-01, w30start = '2025-12-03' (jan01 - 29d)
  const ref = '2026-01-01';
  const w30start = subtractCalendarDays(ref, 29);
  expect(w30start).toBe('2025-12-03');
  const vInside  = mkConc('1', '2025-12-03', '100', 'G');
  const vOutside = mkConc('2', '2025-12-02', '100', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [vInside, vOutside], dataReferencia: ref });
  expect(p.pedidos30d).toBe(1);
  expect(p.faturamento30d).toBe(100);
});

// ── P360-39: ano bissexto (29/fev/2024) ──────────────────────────────────────
test('P360-39: ano bissexto — subtractCalendarDays atravessa 29/fev corretamente', () => {
  // 2024-03-01 - 1d = 2024-02-29 (existe em 2024, ano bissexto)
  expect(subtractCalendarDays('2024-03-01', 1)).toBe('2024-02-29');
  // 2024-03-01 - 29d = 2024-02-01
  expect(subtractCalendarDays('2024-03-01', 29)).toBe('2024-02-01');
  // venda em 29/fev está dentro da janela 30d de ref=2024-03-01
  const v = mkConc('1', '2024-02-29', '50', 'G');
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas: [v], dataReferencia: '2024-03-01' });
  expect(p.pedidos30d).toBe(1);
  expect(p.diasSemComprar).toBe(1);
});

// ── P360-40: centavos evitam erro float ──────────────────────────────────────
test('P360-40: 3×R$0,33 = R$0,99 exato (não 0.9899... por ponto flutuante)', () => {
  // Float direto: 3 * 0.33 = 0.9899999... (erro!)
  // Centavos: 3 * 33 = 99 centavos = R$0.99 (correto)
  const vendas = [
    mkConc('1', '2026-09-15', '0.33', 'G'),
    mkConc('2', '2026-09-15', '0.33', 'G'),
    mkConc('3', '2026-09-15', '0.33', 'G'),
  ];
  const p = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p.faturamentoTotal).toBe(0.99);
  expect(p.faturamento30d).toBe(0.99);
});

// ── P360-41: venda com cliente_id vazio ignorada no agrupamento ──────────────
test('P360-41: agruparVendasPorCliente ignora vendas com cliente_id vazio', () => {
  const vendas = [
    { id: '1', data: '2026-09-15', nome_situacao: 'Concretizada', valor_total: '50', cliente_id: '', produtos: [] },
    { id: '2', data: '2026-09-15', nome_situacao: 'Concretizada', valor_total: '50', cliente_id: 'CLI1', produtos: [] },
  ];
  const map = agruparVendasPorCliente(vendas);
  expect(map.has('')).toBe(false);
  expect(map.has('CLI1')).toBe(true);
  expect(map.get('CLI1')).toHaveLength(1);
});

// ── P360-42: agrupamento por cliente_id ───────────────────────────────────────
test('P360-42: agruparVendasPorCliente separa corretamente por cliente_id', () => {
  const vendas = [
    mkConc('1', '2026-09-01', '100', 'CLI1'),
    mkConc('2', '2026-09-05', '200', 'CLI2'),
    mkConc('3', '2026-09-10', '150', 'CLI1'),
  ];
  const map = agruparVendasPorCliente(vendas);
  expect(map.get('CLI1')).toHaveLength(2);
  expect(map.get('CLI2')).toHaveLength(1);
});

// ── P360-43: dois clientes não se misturam ────────────────────────────────────
test('P360-43: perfis de dois clientes são independentes (sem vazamento de dados)', () => {
  const todasVendas = [
    mkConc('1', '2026-09-01', '100', 'CLI1'),
    mkConc('2', '2026-09-05', '200', 'CLI2'),
    mkConc('3', '2026-09-10', '150', 'CLI1'),
  ];
  const map = agruparVendasPorCliente(todasVendas);
  const pA = calcularPerfil360({
    clienteMr4Id: 'MR4_A', gestaoClickId: 'CLI1',
    vendas: map.get('CLI1'),
    dataReferencia: '2026-09-15',
  });
  const pB = calcularPerfil360({
    clienteMr4Id: 'MR4_B', gestaoClickId: 'CLI2',
    vendas: map.get('CLI2'),
    dataReferencia: '2026-09-15',
  });
  expect(pA.pedidosTotal).toBe(2);
  expect(pA.faturamentoTotal).toBe(250);
  expect(pB.pedidosTotal).toBe(1);
  expect(pB.faturamentoTotal).toBe(200);
});

// ── P360-44: dataReferencia explícita garante determinismo ───────────────────
test('P360-44: mesma entrada + mesma dataReferencia → resultado idêntico', () => {
  const vendas = [
    mkConc('1', '2026-08-01', '100', 'G'),
    mkConc('2', '2026-09-01', '200', 'G'),
  ];
  const p1 = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  const p2 = calcularPerfil360({ clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15' });
  expect(p1.faturamentoTotal).toBe(p2.faturamentoTotal);
  expect(p1.pedidosTotal).toBe(p2.pedidosTotal);
  expect(p1.primeiraCompraEm).toBe(p2.primeiraCompraEm);
  expect(p1.ultimaCompraEm).toBe(p2.ultimaCompraEm);
  expect(p1.diasSemComprar).toBe(p2.diasSemComprar);
  expect(p1.inativo120d).toBe(p2.inativo120d);
});

// ── P360-45: calculadoEm é metadado, não afeta os cálculos ───────────────────
test('P360-45: calculadoEm não altera nenhum campo calculado', () => {
  const vendas = [mkConc('1', '2026-09-15', '100', 'G')];
  const p1 = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15',
    calculadoEm: '2026-09-15T10:00:00Z',
  });
  const p2 = calcularPerfil360({
    clienteMr4Id: 'M', gestaoClickId: 'G', vendas, dataReferencia: '2026-09-15',
    calculadoEm: '2026-09-15T23:59:59Z',
  });
  expect(p1.faturamentoTotal).toBe(p2.faturamentoTotal);
  expect(p1.pedidosTotal).toBe(p2.pedidosTotal);
  expect(p1.ticketMedioTotal).toBe(p2.ticketMedioTotal);
  // metadado é preservado mas não afeta a matemática
  expect(p1.calculadoEm).toBe('2026-09-15T10:00:00Z');
  expect(p2.calculadoEm).toBe('2026-09-15T23:59:59Z');
});
