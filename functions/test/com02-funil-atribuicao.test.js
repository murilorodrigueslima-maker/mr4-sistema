'use strict';
// COM-02 — etapas separadas do funil e atribuição por evidência (opção). Puro; sem emulador, sem produção.
const C = require('../lib/conversaoComercial');
const { ATRIBUIDA, PROVAVEL, NAO } = C.NIVEIS;

const U1 = 'uid-v1', U2 = 'uid-v2';
const OPP = n => String(n).padStart(16, '0');
const atend = (op, outcome, quando, meta) => [
  { tipo: 'CLAIMED', operadorId: op, timestamp: new Date(Date.parse(quando) - 300000).toISOString() },
  { tipo: 'OUTCOME_REGISTERED', operadorId: op, outcome, timestamp: quando, ...(meta ? { meta } : {}) },
];
const opp = (n, gc, ...atendimentos) => ({ opportunityInstanceId: OPP(n), commercialEntityId: 'GC_NATIVE:' + gc, tipoOportunidade: 'JANELA_DE_RECOMPRA', eventos: atendimentos.flat() });
const venda = (id, gc, data, valor, ex = {}) => ({ id: String(id), cliente_id: String(gc), data, nome_situacao: 'Concretizada', valor_total: String(valor), vendedor_id: '11', ...ex });
const T = d => d + 'T13:00:00.000Z';
const VEND = { [U1]: '11', [U2]: '22' };
const rodar = (estados, vendas, opcoes = {}, extra = {}) => C.calcularFunil({ estados, vendas, vendedorGcPorUid: VEND, ...extra, opcoes: { dataCorte: '2026-11-25', ...opcoes } });
const ev = (estados, vendas, opcoes = {}, extra = {}) => rodar(estados, vendas, { atribuicao: 'EVIDENCIA', ...opcoes }, extra);
const caso = (r, id) => r.evidencia.casos.find(k => k.vendaId === String(id));
const conversa = (n, gc, meta, op = U1, dia = '2026-10-01') => opp(n, gc, atend(op, 'CONVERSA_REALIZADA', T(dia), meta));

describe('etapas separadas; sem dado = NÃO MEDIDO', () => {
  test('sem captura, sem vendas e sem registro: nada vira zero', () => {
    const e = rodar([conversa(1, 100)], []).total.etapas;
    expect(e.contatado).toMatchObject({ status: 'MEDIDO', oportunidades: 1, clientes: 1 });
    for (const k of ['interessado', 'propostaApresentada', 'pedidoRealizado', 'vendaConcluida', 'reativado']) {
      expect(e[k]).toMatchObject({ status: 'NAO_MEDIDO', oportunidades: null, clientes: null });
    }
    expect(rodar([], []).total.etapas.contatado.status).toBe('NAO_MEDIDO');
  });
  test('pedido realizado ≠ venda concluída: em aberto, cancelada e devolvida contam só como pedido', () => {
    const r = rodar([conversa(1, 100), conversa(2, 200), conversa(3, 300), conversa(4, 400), conversa(5, 500)], [
      venda(1, 100, '2026-10-02', 10, { nome_situacao: 'Em aberto' }), venda(2, 200, '2026-10-02', 20, { nome_situacao: 'Cancelada' }),
      venda(3, 300, '2026-10-02', 30), venda(4, 400, '2026-10-02', 40), venda(5, 500, '2026-10-02', 0),
    ], {}, { devolucoes: { 3: 'TOTAL' } });
    const e = r.total.etapas;
    expect(e.pedidoRealizado).toMatchObject({ status: 'MEDIDO', oportunidades: 4, pedidos: 4, valor: 100, naoConcluidos: { SITUACAO_NAO_CONCRETIZADA: 2, DEVOLUCAO_TOTAL: 1 } });
    expect(e.vendaConcluida).toMatchObject({ oportunidades: 1, pedidos: 1, valor: 40, devolucao: 'PELO_REGISTRO_MANUAL' });
    expect(r.total.pedidos).toBe(1);                                              // campos anteriores inalterados
    expect(r.total.faturamento).toBe(40);
  });
  test('registro de devoluções vazio = devolução NÃO MEDIDA', () => {
    for (const devolucoes of [undefined, new Map(), {}]) {
      expect(rodar([conversa(1, 100)], [venda(1, 100, '2026-10-02', 10)], {}, { devolucoes }).total.etapas.vendaConcluida.devolucao).toBe('NAO_MEDIDO');
    }
  });
  test('interessado e proposta vêm só da captura (venda não implica interesse)', () => {
    const e = rodar([conversa(1, 100, { interesse: 'SIM', proposta: 'NAO' }), conversa(2, 200)], [venda(1, 200, '2026-10-02', 10)]).total.etapas;
    expect(e.interessado).toMatchObject({ status: 'PARCIAL', oportunidades: 1, clientes: 1, informadas: 1, naoInformadas: 1 });
    expect(e.propostaApresentada).toMatchObject({ status: 'PARCIAL', oportunidades: 0 });
  });
  test('reativado exige venda concluída; histórico desconhecido deixa a etapa PARCIAL', () => {
    const velha = venda(1, 100, '2026-05-01', 10);
    const aberta = rodar([conversa(1, 100)], [velha, venda(2, 100, '2026-10-02', 10, { nome_situacao: 'Em aberto' })]).total.etapas;
    expect(aberta.reativado.oportunidades).toBe(0);
    expect(aberta.pedidoRealizado.oportunidades).toBe(1);
    expect(rodar([conversa(1, 100)], [velha, venda(2, 100, '2026-10-02', 10)]).total.etapas.reativado).toMatchObject({ status: 'MEDIDO', oportunidades: 1, valor: 10 });
    expect(rodar([conversa(1, 100)], [venda(2, 100, '2026-10-02', 10)], {}, { coberturaDesde: '2026-04-01' }).total.etapas.reativado).toMatchObject({ status: 'PARCIAL', indeterminadas: 1 });
  });
});

describe('atribuição por evidência: níveis', () => {
  const v = (data = '2026-10-03', ex) => [venda(1, 100, data, 100, ex)];
  test('padrão continua último toque; a classificação é informada sem alterar o resultado', () => {
    const r = rodar([conversa(1, 100)], v('2026-10-14', { vendedor_id: '22' }));
    expect(r.parametros.atribuicao).toBe('ULTIMO_TOQUE');
    expect(r.total.pedidos).toBe(1);
    expect(caso(r, 1)).toMatchObject({ nivel: NAO, motivo: 'VENDEDOR_DIVERGENTE', mesmoVendedor: false });
  });
  test.each([['interesse'], ['proposta']])('mesmo vendedor + %s SIM = atribuída com evidência', campo => {
    const r = ev([conversa(1, 100, { [campo]: 'SIM' })], v('2026-10-14'));
    expect(caso(r, 1)).toMatchObject({ nivel: ATRIBUIDA, motivo: 'VENDEDOR_E_INTENCAO' });
    expect(r.total.pedidos).toBe(1);
    expect(ev([conversa(1, 100, { [campo]: 'SIM' })], v('2026-10-14'), { nivelMinimo: ATRIBUIDA }).total.pedidos).toBe(1);
  });
  test('sem captura: até 7 dias é provável; 8 dias ou mais não é atribuível', () => {
    expect(caso(ev([conversa(1, 100)], v('2026-10-08')), 1)).toMatchObject({ nivel: PROVAVEL, motivo: 'SEM_INTENCAO_REGISTRADA', diasAposContato: 7 });
    const longe = ev([conversa(1, 100)], v('2026-10-09'));
    expect(caso(longe, 1)).toMatchObject({ nivel: NAO, motivo: 'PRAZO_LONGO_SEM_INTENCAO' });
    expect(longe.total.pedidos).toBe(0);
    expect(longe.exclusoes).toEqual({ PRAZO_LONGO_SEM_INTENCAO: 1 });
    expect(ev([conversa(1, 100)], v('2026-10-08'), { nivelMinimo: ATRIBUIDA }).total.pedidos).toBe(0);
    expect(ev([conversa(1, 100)], v('2026-10-09'), { prazoProvavelDias: 14 }).total.pedidos).toBe(1);
  });
  test('vendedor divergente nunca é atribuído, mesmo com proposta', () => {
    const r = ev([conversa(1, 100, { proposta: 'SIM' })], v('2026-10-02', { vendedor_id: '22' }));
    expect(caso(r, 1)).toMatchObject({ nivel: NAO, motivo: 'VENDEDOR_DIVERGENTE' });
    expect(r.total.etapas.pedidoRealizado.oportunidades).toBe(0);
  });
  test('vendedor não verificável: só com intenção, e no máximo provável', () => {
    const semMapa = { vendedorGcPorUid: {} };
    expect(caso(ev([conversa(1, 100, { proposta: 'SIM' })], v(), {}, semMapa), 1)).toMatchObject({ nivel: PROVAVEL, motivo: 'VENDEDOR_NAO_VERIFICAVEL' });
    expect(caso(ev([conversa(1, 100)], v(), {}, semMapa), 1)).toMatchObject({ nivel: NAO, motivo: 'VENDEDOR_NAO_VERIFICAVEL' });
  });
  test('"sem interesse" ou interesse NÃO na manifestação mais recente é evidência contrária', () => {
    for (const estados of [
      [opp(1, 100, atend(U1, 'SEM_INTERESSE_AGORA', T('2026-10-01'), { proposta: 'SIM' }))],
      [opp(1, 100, atend(U1, 'CONVERSA_REALIZADA', T('2026-10-01'), { proposta: 'SIM' }), atend(U1, 'CONVERSA_REALIZADA', T('2026-10-02'), { interesse: 'NAO' }))],
    ]) expect(caso(ev(estados, v()), 1)).toMatchObject({ nivel: NAO, motivo: 'SEM_INTERESSE_DECLARADO' });
  });
  test('só tentativa (sem resposta) não é evidência; pedido sem relação temporal nem vira caso', () => {
    const e = [opp(1, 100, atend(U1, 'SEM_RESPOSTA', T('2026-10-01')))];
    expect(caso(ev(e, v()), 1)).toMatchObject({ nivel: NAO, motivo: 'SEM_CONVERSA' });
    expect(ev(e, v('2026-11-20')).evidencia.casos).toEqual([]);
    expect(() => ev(e, [], { base: 'TENTATIVA' })).toThrow(/só CONVERSA/);
  });
  test('pedido anterior ao contato é listado com o motivo e não é atribuído', () => {
    const r = ev([conversa(1, 100, { proposta: 'SIM' })], v('2026-10-01', { cadastrado_em: '2026-10-01 08:00:00' }));
    expect(caso(r, 1)).toMatchObject({ nivel: NAO, motivo: 'PEDIDO_ANTERIOR_AO_CONTATO' });
    expect(caso(r, 1).sinais).toContain('MESMO_DIA');
  });
});

describe('atribuição por evidência: unicidade e concorrência', () => {
  test('dois vendedores: o crédito segue o vendedor do pedido (não o último toque) e fica no máximo provável', () => {
    const estados = [conversa(1, 100, { proposta: 'SIM' }, U1, '2026-10-01'), conversa(2, 100, undefined, U2, '2026-10-02')];
    const vendas = [venda(1, 100, '2026-10-03', 50)];
    const r = ev(estados, vendas);
    expect(caso(r, 1)).toMatchObject({ opp: OPP(1), nivel: PROVAVEL, motivo: 'MAIS_DE_UM_VENDEDOR', operadorId: U1 });
    expect(caso(r, 1).sinais).toEqual(expect.arrayContaining(['MAIS_DE_UM_VENDEDOR', 'MAIS_DE_UMA_OPORTUNIDADE']));
    expect(r.porVendedor[U1].pedidos).toBe(1);
    expect(rodar(estados, vendas).pedidos[0].operadorId).toBe(U2);               // último toque (padrão) não mudou
  });
  test('um pedido em no máximo uma oportunidade; a oportunidade leva só o 1º pedido concluído', () => {
    const estados = [conversa(1, 100), conversa(2, 100, undefined, U1, '2026-10-02')];
    const r = ev(estados, [venda(1, 100, '2026-10-03', 10), venda(2, 100, '2026-10-04', 20), venda(3, 100, '2026-10-05', 30)]);
    expect(r.evidencia.casos).toHaveLength(3);
    expect(new Set(r.evidencia.casos.map(k => k.vendaId)).size).toBe(3);
    expect(r.total).toMatchObject({ pedidos: 1, faturamento: 10 });
    expect([2, 3].map(i => caso(r, i).motivo)).toEqual(['PEDIDO_ADICIONAL', 'PEDIDO_ADICIONAL']);
  });
  test('pedido cancelado antes não consome a vaga do pedido concluído', () => {
    const r = ev([conversa(1, 100)], [venda(1, 100, '2026-10-02', 10, { nome_situacao: 'Cancelada' }), venda(2, 100, '2026-10-03', 20)]);
    expect(r.total.etapas.pedidoRealizado).toMatchObject({ pedidos: 2, naoConcluidos: { SITUACAO_NAO_CONCRETIZADA: 1 } });
    expect(r.total.etapas.vendaConcluida).toMatchObject({ pedidos: 1, valor: 20 });
  });
  test('soma por vendedor fecha com o total e os níveis fecham com os casos', () => {
    const r = ev([conversa(1, 100, { proposta: 'SIM' }), conversa(2, 200, undefined, U2)],
      [venda(1, 100, '2026-10-03', 10), venda(2, 200, '2026-10-03', 20, { vendedor_id: '22' }), venda(3, 200, '2026-10-12', 5, { vendedor_id: '22' })]);
    expect(Object.values(r.porVendedor).reduce((s, x) => s + x.pedidos, 0)).toBe(r.total.pedidos);
    expect(Object.values(r.evidencia.porNivel).reduce((s, x) => s + x.pedidos, 0)).toBe(r.evidencia.casos.length);
    expect(r.evidencia.porNivel[ATRIBUIDA]).toMatchObject({ pedidos: 1, valorConcluido: 10 });
    expect(r.evidencia.porNivel[PROVAVEL]).toMatchObject({ pedidos: 1, valorConcluido: 20 });
  });
  test('sinais de registro em lote e início junto com o resultado (informativos)', () => {
    const rapido = (n, gc, quando) => opp(n, gc, [{ tipo: 'CLAIMED', operadorId: U1, timestamp: new Date(Date.parse(quando) - 1000).toISOString() },
      { tipo: 'OUTCOME_REGISTERED', operadorId: U1, outcome: 'CONVERSA_REALIZADA', timestamp: quando }]);
    const r = ev([rapido(1, 100, '2026-10-01T13:00:00.000Z'), rapido(2, 200, '2026-10-01T13:00:30.000Z')], [venda(1, 200, '2026-10-02', 10)]);
    expect(caso(r, 1)).toMatchObject({ nivel: PROVAVEL });
    expect(caso(r, 1).sinais).toEqual(expect.arrayContaining(['REGISTRO_EM_LOTE', 'INICIO_E_RESULTADO_JUNTOS']));
  });
  test('opções inválidas e sensibilidade na regra por evidência', () => {
    expect(() => rodar([], [], { atribuicao: 'X' })).toThrow(/atribuicao/);
    expect(() => rodar([], [], { nivelMinimo: 'NAO_ATRIBUIVEL' })).toThrow(/nivelMinimo/);
    expect(() => rodar([], [], { prazoProvavelDias: -1 })).toThrow(/prazoProvavelDias/);
    expect(C.sensibilidade({ estados: [], vendas: [], opcoes: { dataCorte: '2026-11-25', atribuicao: 'EVIDENCIA' } })).toHaveLength(9);
  });
  test('não depende de carteira nem de comissão', () => {
    const src = require('fs').readFileSync(require.resolve('../lib/conversaoComercial'), 'utf8');
    expect(src).not.toMatch(/carteira_comercial'|decidirVendaCarteira|comiss(ao|oes)\w*\(/);
    expect(src).not.toMatch(/firestore\(|\.set\(\s*ref|\.update\(\{/);
  });
});

describe('lista de casos ambíguos (validação do dono)', () => {
  const M = require('../../scripts/ops/medir-conversao');
  const estados = [conversa(1, 100), conversa(2, 200), conversa(3, 300, { proposta: 'SIM' }), conversa(4, 400)];
  const vendas = [
    venda(11, 100, '2026-10-03', 10),                                   // provável sem conflito → fora da lista
    venda(21, 200, '2026-10-03', 20, { vendedor_id: '22' }),            // vendedor divergente → prioridade 1
    venda(31, 300, '2026-10-03', 30),                                   // atribuída → fora
    venda(32, 300, '2026-10-04', 5),                                    // adicional → prioridade 3
    venda(41, 400, '2026-10-12', 40),                                   // prazo longo → prioridade 2
  ];
  test('só o que a regra não resolve, ordenado por prioridade', () => {
    const l = C.casosAmbiguos(ev(estados, vendas).evidencia.casos);
    expect(l.map(k => [k.vendaId, k.prioridade, k.motivo])).toEqual([
      ['21', 1, 'VENDEDOR_DIVERGENTE'], ['41', 2, 'PRAZO_LONGO_SEM_INTENCAO'], ['32', 3, 'PEDIDO_ADICIONAL']]);
    for (const k of l) expect(k.pergunta.length).toBeGreaterThan(10);
  });
  test('CSV: cliente anonimizado, vendedores rotulados, sem nome, uid ou ID de cliente', () => {
    const casos = ev(estados, vendas.map(v => ({ ...v, nome_cliente: 'FULANO LTDA' }))).evidencia.casos;
    const csv = M.csvAmbiguos(casos, { rotuloUid: { [U1]: 'V1' }, rotuloGc: { 11: 'V1', 22: 'V2' } });
    expect(csv.linhas).toBe(3);
    expect(csv.porPrioridade).toEqual({ 1: 1, 2: 1, 3: 1 });
    const linhas = csv.texto.replace(/^﻿/, '').trim().split('\r\n').map(x => x.split(';'));
    expect(linhas[0]).toHaveLength(20);
    expect(linhas[1].slice(0, 11)).toEqual(['A001', '1', '21', '2026-10-03', '20,00', 'Concretizada', 'C001', OPP(2), 'JANELA_DE_RECOMPRA', 'V1', 'V2']);
    expect(csv.texto).not.toMatch(/FULANO|uid-v|;200;|GC_NATIVE/);
  });
  test('documento de outra loja é descartado; sem o campo, vale o escopo do espelho (262759)', () => {
    expect([{ loja_id: '262759' }, {}, { loja_id: '' }, { loja_id: '424483' }].map(M.daLoja)).toEqual([true, true, true, false]);
  });
});
