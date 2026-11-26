'use strict';
// COM-02 — medição de conversão comercial (puro; sem emulador, sem produção).
const C = require('../lib/conversaoComercial');

const U1 = 'uid-v1', U2 = 'uid-v2';
const OPP = n => String(n).padStart(16, '0');
/** atendimento = CLAIMED (5 min antes) + OUTCOME. `quando` em ISO UTC. */
const atend = (op, outcome, quando, meta) => [
  { tipo: 'CLAIMED', operadorId: op, timestamp: new Date(Date.parse(quando) - 300000).toISOString() },
  { tipo: 'OUTCOME_REGISTERED', operadorId: op, outcome, timestamp: quando, ...(meta ? { meta } : {}) },
];
const opp = (n, gc, ...atendimentos) => ({ opportunityInstanceId: OPP(n), commercialEntityId: 'GC_NATIVE:' + gc, tipoOportunidade: 'JANELA_DE_RECOMPRA', eventos: atendimentos.flat() });
const venda = (id, gc, data, valor, ex = {}) => ({ id: String(id), cliente_id: String(gc), data, nome_situacao: 'Concretizada', valor_total: String(valor), vendedor_id: '11', ...ex });
const T = d => d + 'T13:00:00.000Z';        // 10:00 em Fortaleza
const rodar = (estados, vendas, opcoes = {}, extra = {}) => C.calcularFunil({ estados, vendas, ...extra, opcoes: { dataCorte: '2026-11-25', ...opcoes } });

describe('unidade de contagem: oportunidade/cliente, nunca pedido', () => {
  test('três pedidos do mesmo cliente na janela = 1 oportunidade convertida, 3 pedidos, faturamento somado', () => {
    const r = rodar([opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')))],
      [venda(1, 100, '2026-10-02', 100.10), venda(2, 100, '2026-10-05', 200.20), venda(3, 100, '2026-10-15', 50)]);
    expect(r.total.oportunidades.convertidas).toBe(1);
    expect(r.total.clientes.convertidos).toBe(1);
    expect(r.total.pedidos).toBe(3);
    expect(r.total.faturamento).toBe(350.3);
    expect(r.total.faturamentoPrimeiroPedido).toBe(100.1);
    expect(r.total.taxas.convertidasSobreBase).toBe(1);
  });
  test('um pedido é atribuído a no máximo uma oportunidade: último toque anterior ao pedido', () => {
    const r = rodar([
      opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))),
      opp(2, 100, atend(U2, 'CONVERSA_REALIZADA', T('2026-10-06'))),
    ], [venda(1, 100, '2026-10-03', 10), venda(2, 100, '2026-10-08', 20)]);
    expect(r.pedidos.map(p => [p.vendaId, p.opp, p.operadorId]).sort()).toEqual([['1', OPP(1), U1], ['2', OPP(2), U2]]);
    const um = rodar([
      opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))),
      opp(2, 100, atend(U2, 'CONVERSA_REALIZADA', T('2026-10-06'))),
    ], [venda(2, 100, '2026-10-08', 20)]);
    expect(um.total.oportunidades).toMatchObject({ trabalhadas: 2, convertidas: 1 });
    expect(um.total.clientes).toMatchObject({ contatados: 1, convertidos: 1 });
    expect(um.porVendedor[U2]).toMatchObject({ pedidos: 1, faturamento: 20 });
    expect(um.porVendedor[U1]).toMatchObject({ pedidos: 0, faturamento: 0 });
  });
  test('venda repetida (mesmo id) e oportunidade repetida contam uma vez; soma por vendedor fecha com o total', () => {
    const o1 = opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')));
    const o2 = opp(2, 200, atend(U1, 'SEM_RESPOSTA', T('2026-10-01')), atend(U2, 'CONVERSA_REALIZADA', T('2026-10-02')));
    const r = rodar([o1, o1, o2], [venda(1, 100, '2026-10-02', 10), venda(1, 100, '2026-10-02', 10), venda(2, 200, '2026-10-03', 5)]);
    expect(r.total.pedidos).toBe(2);
    expect(r.total.oportunidadesComMaisDeUmVendedor).toBe(1);
    const soma = k => Object.values(r.porVendedor).reduce((s, x) => s + x.oportunidades[k], 0);
    expect(soma('trabalhadas')).toBe(r.total.oportunidades.trabalhadas);
    expect(soma('convertidas')).toBe(r.total.oportunidades.convertidas);
  });
  test('recortes de período vizinhos não contam o mesmo pedido duas vezes', () => {
    const e = [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-09-30'))), opp(2, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-02')))];
    const v = [venda(1, 100, '2026-10-05', 10)];
    expect(rodar(e, v, { fim: '2026-09-30' }).total.pedidos).toBe(0);
    expect(rodar(e, v, { inicio: '2026-10-01' }).total.pedidos).toBe(1);
  });
});

describe('estágios e denominadores', () => {
  const estados = [
    opp(1, 1, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))),
    opp(2, 2, atend(U1, 'SEM_RESPOSTA', T('2026-10-01'))),
    opp(3, 3, atend(U1, 'CONTATO_INVALIDO', T('2026-10-01'))),
    opp(4, 4, atend(U1, 'PEDIU_RETORNO', T('2026-10-01'))),
    opp(5, 5, atend(U1, 'SEM_INTERESSE_AGORA', T('2026-10-01'))),
    opp(6, 6, [{ tipo: 'CLAIMED', operadorId: U1, timestamp: T('2026-10-01') }]),
  ];
  test('trabalhada > contatada > conversa; contato inválido não é contato; claim sem desfecho fica fora', () => {
    const t = rodar(estados, []).total;
    expect(t.oportunidades).toMatchObject({ trabalhadas: 5, contatadas: 4, conversa: 3, convertidas: 0 });
    expect(t.taxas.conversaSobreContatadas).toBe(0.75);
    expect(t.taxas.reativadasSobreInativas).toBeNull();                       // denominador zero = sem taxa, nunca 0%
  });
  test('base CONVERSA ignora venda após SEM_RESPOSTA; base TENTATIVA a inclui', () => {
    const v = [venda(1, 2, '2026-10-03', 10)];
    expect(rodar(estados, v).total.pedidos).toBe(0);
    expect(rodar(estados, v, { base: 'TENTATIVA' }).total.pedidos).toBe(1);
    expect(rodar(estados, [venda(1, 3, '2026-10-03', 10)], { base: 'TENTATIVA' }).total.pedidos).toBe(0);
  });
  test('interesse e proposta sem captura = NÃO MEDIDO (nunca zero); "sem interesse" declarado é contado à parte', () => {
    const t = rodar(estados, []).total;
    expect(t.interesse).toMatchObject({ status: 'NAO_MEDIDO', sim: null, nao: null, informadas: 0, naoInformadas: 3, semInteresseDeclarado: 1 });
    expect(t.proposta).toMatchObject({ status: 'NAO_MEDIDO', sim: null });
  });
  test('captura parcial: contagens só sobre quem informou; proposta SIM em qualquer atendimento vale para a oportunidade', () => {
    const t = rodar([
      opp(1, 1, atend(U1, 'PEDIU_RETORNO', T('2026-10-01'), { interesse: 'SIM', proposta: 'SIM' }), atend(U1, 'CONVERSA_REALIZADA', T('2026-10-03'), { proposta: 'NAO' })),
      opp(2, 2, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'), { interesse: 'NAO' })),
      opp(3, 3, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))),
    ], []).total;
    expect(t.interesse).toMatchObject({ status: 'PARCIAL', informadas: 2, sim: 1, nao: 1, naoInformadas: 1, taxaSobreInformadas: 0.5 });
    expect(t.proposta).toMatchObject({ status: 'PARCIAL', informadas: 1, sim: 1 });
  });
});

describe('janela de atribuição (7/14/30) e bordas', () => {
  const e = [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')))];
  test.each([[7, '2026-10-08', 1], [7, '2026-10-09', 0], [14, '2026-10-15', 1], [14, '2026-10-16', 0], [30, '2026-10-31', 1], [30, '2026-11-01', 0]])(
    'janela %i, pedido em %s → %i', (janelaDias, data, esperado) => {
      expect(rodar(e, [venda(1, 100, data, 10)], { janelaDias }).total.pedidos).toBe(esperado);
    });
  test('padrão = 14 dias; venda anterior ao contato nunca conta', () => {
    expect(rodar(e, []).parametros.janelaDias).toBe(14);
    expect(rodar(e, [venda(1, 100, '2026-09-30', 10)]).total.pedidos).toBe(0);
  });
  test('coorte imatura fica fora da taxa, mas o pedido já ocorrido aparece no total', () => {
    const r = rodar([opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-11-20')))], [venda(1, 100, '2026-11-21', 10)], { janelaDias: 14 });
    expect(r.total.oportunidades.convertidas).toBe(1);
    expect(r.total.maduras).toMatchObject({ base: 0, convertidas: 0 });
    expect(r.total.taxas.convertidasSobreBase).toBeNull();
  });
  test('contato e venda depois da data de corte são ignorados', () => {
    const r = rodar([opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))), opp(2, 200, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-20')))],
      [venda(1, 100, '2026-10-12', 10)], { dataCorte: '2026-10-10', janelaDias: 30 });
    expect(r.total.oportunidades.trabalhadas).toBe(1);
    expect(r.total.pedidos).toBe(0);
  });
  test('sensibilidade cobre janelas × bases × políticas e é monotônica na janela', () => {
    const l = C.sensibilidade({ estados: e, vendas: [venda(1, 100, '2026-10-12', 10)], opcoes: { dataCorte: '2026-11-25' } });
    expect(l).toHaveLength(18);
    const serie = l.filter(x => x.base === 'CONVERSA' && x.mesmoDia === 'ordem').map(x => [x.janelaDias, x.convertidas]);
    expect(serie).toEqual([[7, 0], [14, 1], [30, 1]]);
  });
  test('opções inválidas são recusadas', () => {
    expect(() => C.calcularFunil({ estados: [], vendas: [], opcoes: {} })).toThrow(/dataCorte/);
    expect(() => rodar([], [], { janelaDias: -1 })).toThrow(/janelaDias/);
    expect(() => rodar([], [], { base: 'X' })).toThrow(/base/);
    expect(() => rodar([], [], { mesmoDia: 'X' })).toThrow(/mesmoDia/);
  });
});

describe('mesmo dia, hora do cadastro e fuso de Fortaleza', () => {
  const e = [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')))];       // atendimento iniciado 09:55 local
  const v = hora => [venda(1, 100, '2026-10-01', 10, hora ? { cadastrado_em: '2026-10-01 ' + hora } : {})];
  test('só conta se cadastrado depois do início do atendimento', () => {
    expect(rodar(e, v('09:57:00')).total.pedidos).toBe(1);                       // durante a ligação
    const antes = rodar(e, v('09:00:00'));
    expect(antes.total.pedidos).toBe(0);
    expect(antes.exclusoes).toEqual({ PEDIDO_ANTERIOR_AO_CONTATO: 1 });
    expect(rodar(e, v(null)).exclusoes).toEqual({ MESMO_DIA_SEM_HORA: 1 });
  });
  test('políticas incluir / excluir', () => {
    expect(rodar(e, v('09:00:00'), { mesmoDia: 'incluir' }).total.pedidos).toBe(1);
    expect(rodar(e, v('11:00:00'), { mesmoDia: 'excluir' }).total.pedidos).toBe(0);
  });
  test('pedido já cadastrado antes do contato, com data futura, não é conversão', () => {
    const r = rodar(e, [venda(1, 100, '2026-10-05', 10, { cadastrado_em: '2026-09-29 15:00:00' })]);
    expect(r.total.pedidos).toBe(0);
    expect(r.exclusoes).toEqual({ PEDIDO_ANTERIOR_AO_CONTATO: 1 });
  });
  test('contato às 22:30 locais (01:30Z do dia seguinte) é do dia local', () => {
    const r = rodar([opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', '2026-10-02T01:30:00.000Z'))], [venda(1, 100, '2026-10-08', 10)], { janelaDias: 7 });
    expect(r.pedidos[0]).toMatchObject({ contatoDia: '2026-10-01', diasAposContato: 7 });
  });
  test('claim antigo (> 4h) não antecipa a âncora', () => {
    const est = { opportunityInstanceId: OPP(1), commercialEntityId: 'GC_NATIVE:100', eventos: [
      { tipo: 'CLAIMED', operadorId: U1, timestamp: '2026-10-01T12:00:00.000Z' },
      { tipo: 'OUTCOME_REGISTERED', operadorId: U1, outcome: 'CONVERSA_REALIZADA', timestamp: '2026-10-03T13:00:00.000Z' }] };
    expect(C.contatosDaOportunidade(est)[0].dia).toBe('2026-10-03');
  });
});

describe('cancelamento e devolução', () => {
  const e = [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')))];
  test('cancelada, em aberto, valor zero e devolução TOTAL não contam e aparecem nas exclusões', () => {
    const r = rodar(e, [
      venda(1, 100, '2026-10-02', 10, { nome_situacao: 'Cancelada' }), venda(2, 100, '2026-10-02', 10, { nome_situacao: 'Em aberto' }),
      venda(3, 100, '2026-10-02', 0), venda(4, 100, '2026-10-02', 10),
    ], {}, { devolucoes: new Map([['4', 'TOTAL']]) });
    expect(r.total.pedidos).toBe(0);
    expect(r.total.oportunidades.convertidas).toBe(0);
    expect(r.exclusoes).toEqual({ SITUACAO_NAO_CONCRETIZADA: 2, VALOR_ZERADO: 1, DEVOLUCAO_TOTAL: 1 });
  });
  test('devolução PARCIAL mantém o pedido (sem valor devolvido registrado) e é sinalizada', () => {
    const r = rodar(e, [venda(1, 100, '2026-10-02', 10)], {}, { devolucoes: { 1: 'PARCIAL' } });
    expect(r.total).toMatchObject({ pedidos: 1, pedidosComDevolucaoParcial: 1, faturamento: 10 });
  });
});

describe('reativado (≥ 120 dias sem compra no contato)', () => {
  const e = [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')))];
  const nova = venda(9, 100, '2026-10-05', 300);
  test('120 dias exatos reativa; 119 não', () => {
    const a = rodar(e, [venda(1, 100, '2026-06-03', 10), nova]);
    expect(a.total.oportunidades).toMatchObject({ inativasNoContato: 1, reativadas: 1 });
    expect(a.total.clientes.reativados).toBe(1);
    expect(a.total.faturamentoReativados).toBe(300);
    expect(a.total.taxas.reativadasSobreInativas).toBe(1);
    expect(rodar(e, [venda(1, 100, '2026-06-04', 10), nova]).total.oportunidades).toMatchObject({ convertidas: 1, reativadas: 0 });
  });
  test('compra anterior cancelada não conta como atividade', () => {
    const r = rodar(e, [venda(1, 100, '2026-01-10', 10), venda(2, 100, '2026-09-20', 10, { nome_situacao: 'Cancelada' }), nova]);
    expect(r.total.oportunidades.reativadas).toBe(1);
  });
  test('sem compra anterior = cliente novo, não reativado; histórico fora do recorte pode ser informado', () => {
    expect(rodar(e, [nova]).total.oportunidades).toMatchObject({ reativadas: 0, reativacaoIndeterminada: 0 });
    expect(rodar(e, [nova], {}, { coberturaDesde: '2026-05-01' }).total.oportunidades.reativacaoIndeterminada).toBe(1);
    expect(rodar(e, [nova], {}, { coberturaDesde: '2026-05-01', ultimaCompraForaDaCobertura: { 100: '2025-02-01' } }).total.oportunidades.reativadas).toBe(1);
  });
});

describe('identidade e conferência de vendedor', () => {
  test('MR4_LINKED usa o vínculo do cadastro; sem vínculo fica fora das taxas e é contado', () => {
    const e = [
      { ...opp(1, 0, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))), commercialEntityId: 'MR4_LINKED:abc' },
      { ...opp(2, 0, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'))), commercialEntityId: 'MR4_LINKED:semvinculo' },
    ];
    const r = rodar(e, [venda(1, 100, '2026-10-02', 10)], {}, { gcIdPorEntidade: { 'MR4_LINKED:abc': '100' }, vendedorGcPorUid: { [U1]: '11' } });
    expect(r.total.oportunidades).toMatchObject({ trabalhadas: 2, semVinculoGc: 1, convertidas: 1 });
    expect(r.total.maduras.base).toBe(1);
    expect(r.total).toMatchObject({ pedidosMesmoVendedor: 1, pedidosVendedorNaoComparavel: 0 });
  });
});

describe('linha de base observacional', () => {
  // 10 controles + 1 contatado no mesmo estrato (última compra 20 dias antes, 1 pedido); 3 dos 10 controles compram na janela
  const vendas = [];
  for (let i = 1; i <= 10; i++) { vendas.push(venda(1000 + i, i, '2026-09-11', 10)); if (i <= 3) vendas.push(venda(2000 + i, i, '2026-10-05', 10)); }
  vendas.push(venda(1100, 100, '2026-09-11', 10), venda(2100, 100, '2026-10-04', 10));
  const estados = [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01')))];
  test('esperado = taxa dos nunca contatados no mesmo estrato', () => {
    const r = C.linhaDeBase({ estados, vendas, opcoes: { dataCorte: '2026-11-25' } });
    const g = r.grupos.find(x => x.grupo === 'CONVERSA');
    expect(r.controlesElegiveis).toBe(10);
    expect(g).toMatchObject({ avaliados: 1, observados: 1, semControle: 0 });
    expect(g.taxaEsperada).toBeCloseTo(0.3);
    expect(r.aviso).toMatch(/NÃO CAUSALIDADE/);
  });
  test('cliente presente na fila (mesmo sem contato válido) não vira controle; poucos controles = sem estimativa', () => {
    const comInvalido = [...estados, opp(2, 1, atend(U1, 'CONTATO_INVALIDO', T('2026-10-01')))];
    expect(C.linhaDeBase({ estados: comInvalido, vendas, opcoes: { dataCorte: '2026-11-25' } }).controlesElegiveis).toBe(9);
    const g = C.linhaDeBase({ estados, vendas, minimoControles: 50, opcoes: { dataCorte: '2026-11-25' } }).grupos[0];
    expect(g).toMatchObject({ avaliados: 0, semControle: 1, taxaEsperada: null });
  });
  test('compra no próprio dia do contato fica fora dos dois lados; janela aberta = imaturo', () => {
    const r = C.linhaDeBase({ estados, vendas: vendas.filter(v => v.id !== '2100').concat(venda(3, 100, '2026-10-01', 10)), opcoes: { dataCorte: '2026-11-25' } });
    expect(r.grupos[0].observados).toBe(0);
    expect(C.linhaDeBase({ estados, vendas, opcoes: { dataCorte: '2026-10-10' } }).grupos[0].imaturos).toBe(1);
  });
});
