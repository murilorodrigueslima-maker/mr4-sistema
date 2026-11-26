'use strict';
// Expedição — medição: cálculo puro, registros opcionais, relatório semanal (sem emulador, sem rede). Dados sintéticos.
const fs = require('fs'), path = require('path');
const M = require('../../js/expedicao-medicao-core.js');
const S = require('../../scripts/ops/relatorio-expedicao-semanal.js');

const MIN = 60000, H = 3600000;
const T0 = Date.parse('2026-11-30T08:00:00-03:00');          // segunda
const agoraMs = Date.parse('2026-12-07T12:00:00-03:00');
const P = M.periodo('semana-passada', agoraMs);
const ped = (numero, coluna, versao, o = {}) => ({ numero, coluna, versao, origem: 'sync', criadoEm: T0, ingresadoEm: T0, movidoEm: T0, itens: 2, valor: 100, data: '2026-11-30', ...o });
const ev = (pedido, versao, acao, em, por = 'uid-bbb', o = {}) => ({ pedido, versao, acao, em, por, de: { INICIAR_SEPARACAO: 'ag', MARCAR_SEPARADO: 'se', DESPACHAR: 'pr', REABRIR: 'de' }[acao] || 'ag', ...o });
const base = () => ({
  pedidos: [ped('1', 'de', 3), ped('2', 'de', 3, { itens: 5 }), ped('3', 'cancelado', 2), ped('4', 'pr', 2)],
  eventos: [
    ev('1', 1, 'INICIAR_SEPARACAO', T0 + 60 * MIN), ev('1', 2, 'MARCAR_SEPARADO', T0 + 70 * MIN), ev('1', 3, 'DESPACHAR', T0 + 100 * MIN),
    // pedido 2: três cliques em sequência, junto com o pedido 3 (lote)
    ev('2', 1, 'INICIAR_SEPARACAO', T0 + 5 * H, 'uid-aaa'), ev('2', 2, 'MARCAR_SEPARADO', T0 + 5 * H + 5000, 'uid-aaa'), ev('2', 3, 'DESPACHAR', T0 + 5 * H + 10000, 'uid-aaa'),
    ev('3', 1, 'INICIAR_SEPARACAO', T0 + 5 * H + 20000, 'uid-aaa'), ev('3', 2, 'CANCELAR', T0 + 5 * H + 30000, 'uid-aaa', { de: 'se' }),
    ev('4', 1, 'INICIAR_SEPARACAO', T0 + 26 * H), ev('4', 2, 'MARCAR_SEPARADO', T0 + 26 * H + 30 * MIN),
  ],
  registros: [
    { pedido: '1', tipo: 'CONFERENCIA', versao: 2, em: T0 + 80 * MIN, por: 'uid-aaa' },
    { pedido: '1', tipo: 'OCORRENCIA', versao: 2, motivo: 'ITEM_ESQUECIDO', retrabalho: true, em: T0 + 81 * MIN, por: 'uid-aaa' },
    { pedido: '1', tipo: 'OCORRENCIA', versao: 2, motivo: 'AVARIA', retrabalho: false, em: T0 + 82 * MIN, por: 'uid-aaa' },
  ],
});
const calc = (d, extra = {}) => M.calcular({ ...d, inicioMs: P.inicioMs, fimMs: P.fimMs, agoraMs, ...extra });

describe('registro opcional (planejarRegistro)', () => {
  const k = (o = {}) => ({ pedido: { numero: '1000001', coluna: 'pr', versao: 2 }, tipo: 'CONFERENCIA', uid: 'u', config: { ativa: true }, serverTimestamp: () => '__TS__', ...o });
  test('desligado por padrão: sem configuração, ou ativa != true, nada é montado', () => {
    for (const config of [null, undefined, {}, { ativa: false }, { ativa: 'true' }]) expect(() => M.planejarRegistro(k({ config }))).toThrow('MEDICAO_DESLIGADA');
  });
  test('conferência: id determinístico por pedido+versão; só em "pr"', () => {
    expect(M.planejarRegistro(k())).toEqual({ id: '1000001_conf_v2', dados: { pedido: '1000001', tipo: 'CONFERENCIA', versao: 2, em: '__TS__', por: 'u' } });
    for (const coluna of ['ag', 'se', 'de', 'cancelado']) expect(() => M.planejarRegistro(k({ pedido: { numero: '1', coluna, versao: 1 } }))).toThrow('ETAPA_INVALIDA');
  });
  test('ocorrência: motivo da lista curta; em "se" ou "pr"; retrabalho sempre booleano', () => {
    const r = M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'AVARIA', pedido: { numero: '7', coluna: 'se', versao: 1 } }));
    expect(r.id).toBe('7_oc_v1_AVARIA'); expect(r.dados.retrabalho).toBe(false);
    expect(() => M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'texto livre' }))).toThrow('MOTIVO_INVALIDO');
    expect(() => M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'AVARIA', pedido: { numero: '7', coluna: 'ag' } }))).toThrow('ETAPA_INVALIDA');
    expect(() => M.planejarRegistro(k({ tipo: 'OUTRO' }))).toThrow('TIPO_INVALIDO');
    expect(M.MOTIVOS.length).toBeLessThanOrEqual(8);
  });
  test('as Rules espelham os mesmos motivos', () => {
    const rules = fs.readFileSync(path.join(__dirname, '../../modulos/firestore.rules'), 'utf8');
    const lista = rules.match(/d\.motivo in \[([^\]]+)\]/)[1].match(/[A-Z_]+/g);
    expect(lista).toEqual([...M.MOTIVO_IDS]);
  });
});

describe('períodos (Fortaleza)', () => {
  test('semana passada = segunda a domingo anteriores, inclusive quando hoje é segunda ou domingo', () => {
    for (const d of ['2026-11-23T00:10:00-03:00', '2026-11-26T15:00:00-03:00', '2026-11-29T23:50:00-03:00']) expect(M.periodo('semana-passada', Date.parse(d))).toMatchObject({ de: '2026-11-16', ate: '2026-11-22' });
  });
  test('7d/30d incluem hoje; fim exclusivo à meia-noite', () => {
    const p = M.periodo('7d', Date.parse('2026-11-26T23:00:00-03:00'));
    expect(p).toMatchObject({ de: '2026-11-20', ate: '2026-11-26' }); expect(p.fimMs - p.inicioMs).toBe(7 * 86400000);
    expect(M.periodo('30d', Date.parse('2026-11-26T12:00:00-03:00')).de).toBe('2026-10-28');
    expect(() => M.periodo('ano', 0)).toThrow('PERIODO_INVALIDO');
  });
});

describe('cálculo', () => {
  test('contagens, intervalos e pendentes', () => {
    const r = calc(base(), { ativos: [ped('4', 'pr', 2, { ingresadoEm: agoraMs - 4 * 86400000 }), ped('5', 'ag', 0, { ingresadoEm: agoraMs - H })] });
    expect(r.contagens).toMatchObject({ entradas: 4, iniciados: 4, separados: 3, despachados: 2, cancelados: 1, canceladosAposInicio: 1, reaberturas: 0 });
    expect(r.intervalos.separacao).toMatchObject({ n: 3, p50: 10 * MIN });
    expect(r.intervalos.separadoConferido).toMatchObject({ n: 1, p50: 10 * MIN });
    expect(r.intervalos.conferidoDespacho).toMatchObject({ n: 1, p50: 20 * MIN });
    expect(r.intervalos.separadoDespacho.n).toBe(2);
    expect(r.intervalos.entradaDespacho.n).toBe(2);
    expect(r.pendentes.pr).toMatchObject({ total: 1, mais3d: 1 }); expect(r.pendentes.ag).toMatchObject({ total: 1, ate2h: 1 });
  });
  test('conferência, divergências e retrabalho vêm só dos registros', () => {
    const r = calc(base());
    expect(r.conferencia).toEqual({ registradas: 1, separadosConferidos: 1, cobertura: 1 / 3 });
    expect(r.divergencias).toMatchObject({ registros: 2, pedidos: 1, comRetrabalho: 1, taxaSobreSeparados: 1 / 3 });
    expect(r.divergencias.porMotivo).toMatchObject({ ITEM_ESQUECIDO: 1, AVARIA: 1, PRODUTO_ERRADO: 0 });
    const sem = calc({ ...base(), registros: [] });
    expect(sem.divergencias.taxaSobreSeparados).toBeNull();            // zero registro não vira "0% de erro"
    expect(sem.intervalos.separadoConferido.confianca).toBe('SEM DADO');
    expect(M.paraMarkdown(sem)).toMatch(/não\*\* significa zero erro/);
  });
  test('operadores viram O1/O2; nenhum identificador interno aparece na saída', () => {
    const r = calc(base());
    expect(r.operadores.map(o => o.codigo)).toEqual(['O1', 'O2']);
    expect(r.operadores[0]).toMatchObject({ separou: 1, linhasSeparadas: 5, conferiu: 1, ocorrencias: 2, cancelou: 1 });
    expect(r.operadores[1]).toMatchObject({ iniciou: 2, separou: 2, linhasSeparadas: 4, despachou: 1 });
    for (const texto of [JSON.stringify(r), M.paraMarkdown(r), M.paraHtml(r)]) expect(texto).not.toMatch(/uid-aaa|uid-bbb/);
  });
  test('cliques em lote: mesmo operador, pedidos diferentes, menos de 1 min', () => {
    const r = calc(base());
    expect(r.operadores[0].cliquesEmLote).toBe(1);                    // uid-aaa: tudo em 30 s
    expect(r.operadores[1].cliquesEmLote).toBe(0);
    expect(r.cliques).toEqual({ total: 10, emLote: 0.5 });
  });
  test('confiabilidade: nunca ALTA para tempo entre cliques', () => {
    expect(M.confiancaIntervalo({ n: 0 }, 0)).toBe('SEM DADO');
    expect(M.confiancaIntervalo({ n: 5, emSequencia: 0 }, 0)).toBe('AMOSTRA PEQUENA');
    expect(M.confiancaIntervalo({ n: 50, emSequencia: 0.4 }, 0)).toBe('BAIXA');
    expect(M.confiancaIntervalo({ n: 50, emSequencia: 0 }, 0.9)).toBe('BAIXA');
    expect(M.confiancaIntervalo({ n: 50, emSequencia: 0.1 }, 0.1)).toBe('MÉDIA');
  });
  test('período: intervalo pertence a onde termina; eventos fora não contam', () => {
    const d = base();
    d.eventos.push(ev('9', 1, 'INICIAR_SEPARACAO', P.inicioMs - H), ev('9', 2, 'MARCAR_SEPARADO', P.inicioMs + H), ev('9', 3, 'DESPACHAR', P.fimMs + H));
    d.pedidos.push(ped('9', 'de', 3, { criadoEm: P.inicioMs - 2 * H }));
    const r = calc(d);
    expect(r.contagens).toMatchObject({ entradas: 4, iniciados: 4, separados: 4, despachados: 2 });
    expect(r.intervalos.separacao.n).toBe(4);
  });
  test('reaberto: o segundo ciclo mede a partir da reabertura e não reaproveita a separação antiga', () => {
    const d = { pedidos: [ped('1', 'de', 7, { ingresadoEm: T0 + 10 * H })], registros: [], eventos: [
      ev('1', 1, 'INICIAR_SEPARACAO', T0 + H), ev('1', 2, 'MARCAR_SEPARADO', T0 + 2 * H), ev('1', 3, 'DESPACHAR', T0 + 3 * H), ev('1', 4, 'REABRIR', T0 + 10 * H),
      ev('1', 5, 'INICIAR_SEPARACAO', T0 + 11 * H), ev('1', 6, 'MARCAR_SEPARADO', T0 + 12 * H), ev('1', 7, 'DESPACHAR', T0 + 13 * H)] };
    const r = calc(d);
    expect(r.contagens).toMatchObject({ entradas: 1, reaberturas: 1, separados: 2, despachados: 2 });
    expect(r.intervalos.entradaInicio).toMatchObject({ n: 2, p50: H });
  });
  test('entradas sem nenhum clique no dia aparecem', () => {
    const d = base(); d.pedidos.push(ped('8', 'ag', 0, { criadoEm: T0 + 3 * 86400000 }));
    expect(calc(d).contagens.diasComEntradaSemClique).toBe(1);
  });
  test('vazio não quebra', () => {
    const r = calc({ pedidos: [], eventos: [], registros: [] }, { ativos: [] });
    expect(r.contagens.entradas).toBe(0); expect(M.paraMarkdown(r)).toMatch(/medição de/); expect(M.paraHtml(r)).toMatch(/não medem trabalho físico/);
  });
});

describe('ligação aproximada com a venda', () => {
  const v = (id, o = {}) => ({ id, data: '2026-11-30', valor: 100, linhas: 2, vendedor: 'h1', cadastradoEm: '2026-11-30 07:59:30', ...o });
  test('só aceita correspondência única; desempata por linhas e vendedor', () => {
    expect(M.vincularVendas([ped('1', 'ag', 0)], [v('a')]).vendaMs.get('1')).toBe(T0 - 30000);
    expect(M.vincularVendas([ped('1', 'ag', 0)], [v('a'), v('b')]).ligados).toBe(0);
    expect(M.vincularVendas([ped('1', 'ag', 0)], [v('a'), v('b', { linhas: 3 })]).ligados).toBe(1);
    expect(M.vincularVendas([ped('1', 'ag', 0, { vendedor: 'h2' })], [v('a'), v('b', { vendedor: 'h2' })]).ligados).toBe(1);
    expect(M.vincularVendas([ped('1', 'ag', 0), ped('2', 'ag', 0)], [v('a')]).ligados).toBe(0);   // 2 pedidos disputando 1 venda
  });
});

describe('relatório semanal (script) — somente leitura', () => {
  const FONTE = fs.readFileSync(path.join(__dirname, '../../scripts/ops/relatorio-expedicao-semanal.js'), 'utf8');
  function falso() {
    const chamadas = [];
    const fetchImpl = async (url, init) => { chamadas.push({ url, ...init }); return { ok: true, status: 200, json: async () => (init.method === 'GET' ? { fields: {} } : [{}]) }; };
    return { chamadas, fetchImpl };
  }
  test('só GET e :runQuery; não pede nome de cliente nem cidade', async () => {
    const f = falso();
    await S.executar(['--emulador', 'x:1', '--com-vendas'], { agoraMs, escrever: () => {}, fetchImpl: f.fetchImpl });
    expect(f.chamadas.length).toBeGreaterThan(3);
    for (const c of f.chamadas) { expect(['GET', 'POST']).toContain(c.method); if (c.method === 'POST') expect(c.url).toMatch(/:runQuery$/); }
    const corpos = f.chamadas.map(c => c.body || '').join('');
    expect(corpos).not.toMatch(/"cliente"|"cidade"|nome_cliente|cliente_id|motivo/);
    expect(FONTE).not.toMatch(/:commit|:batchWrite|'PATCH'|'DELETE'|'PUT'|\.set\(\{|--force/);
  });
  test('trava de custo interrompe', async () => {
    await expect(S.executar(['--emulador', 'x:1', '--max-leituras', '2'], { agoraMs, escrever: () => {}, fetchImpl: falso().fetchImpl })).rejects.toThrow('TRAVA_DE_LEITURAS');
  });
  test('opções e datas', () => {
    expect(S.argumentos([]).periodo).toBe('semana-passada');
    expect(() => S.argumentos(['--apagar'])).toThrow('OPCAO_DESCONHECIDA');
    expect(() => S.argumentos(['--de'])).toThrow('FALTA_VALOR');
    expect(S.intervaloDe({ de: '2026-11-30', ate: '2026-12-06' }, 0)).toMatchObject({ inicioMs: P.inicioMs, fimMs: P.fimMs });
    expect(() => S.intervaloDe({ de: '2026-12-06', ate: '2026-11-30' }, 0)).toThrow(/USE/);
  });
  test('vendedor nunca sai em claro', () => { expect(S.apelido('Fulano de Teste')).toMatch(/^h[0-9a-f]{16}$/); expect(S.apelido('123 Fulano de Teste')).toBe(S.apelido('fulano de teste')); });
});
