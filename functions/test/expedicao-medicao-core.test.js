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
    expect(M.planejarRegistro(k({ tipo: 'CONFERENCIA_INICIO' })).id).toBe('1000001_confini_v2');
  });
  test('entrega: só em "de" e só para Uber MR4 e rotas (retirada e Uber do cliente = entrega no ato da saída)', () => {
    const e = (coluna, envio) => () => M.planejarRegistro(k({ tipo: 'ENTREGA', pedido: { numero: '5', coluna, versao: 3, envio } }));
    for (const envio of M.ENVIOS_COM_ENTREGA) expect(e('de', envio)().id).toBe('5_entrega_v3');
    for (const envio of ['retirada', 'retirada-terc', 'uber-cliente', null]) expect(e('de', envio)).toThrow('ETAPA_INVALIDA');
    expect(e('pr', 'rota-manha')).toThrow('ETAPA_INVALIDA');
  });
  test('lote e "registrando depois" só aparecem quando informados; lote mal formado é recusado', () => {
    const lote = M.novoLote(Date.parse('2026-11-30T10:00:00-03:00'), 0.5);
    expect(lote).toMatch(/^L[0-9a-z-]{6,40}$/);
    expect(M.planejarRegistro(k({ lote, loteTam: 3, depois: true })).dados).toMatchObject({ lote, loteTam: 3, depois: true });
    expect(M.planejarRegistro(k({ depois: false })).dados).not.toHaveProperty('depois');
    for (const x of [{ lote: 'qualquer', loteTam: 2 }, { lote }, { lote, loteTam: 31 }]) expect(() => M.planejarRegistro(k(x))).toThrow('LOTE_INVALIDO');
  });
  test('marca de transição: exige lote ou atraso; só nas três etapas; id por versão', () => {
    const m = (o = {}) => M.planejarMarca({ pedido: '9', versao: 1, etapa: 'INICIAR_SEPARACAO', uid: 'u', config: { ativa: true }, serverTimestamp: () => 'TS', depois: true, ...o });
    expect(m()).toEqual({ id: '9_marca_v1', dados: { pedido: '9', tipo: 'MARCA', versao: 1, etapa: 'INICIAR_SEPARACAO', em: 'TS', por: 'u', depois: true } });
    expect(() => m({ depois: false })).toThrow('NADA_A_ANOTAR');
    expect(() => m({ etapa: 'CANCELAR' })).toThrow('ETAPA_INVALIDA');
    expect(() => m({ config: { ativa: false } })).toThrow('MEDICAO_DESLIGADA');
  });
  test('ocorrência: motivo da lista curta; em "se" ou "pr"; retrabalho sempre booleano', () => {
    const r = M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'AVARIA', pedido: { numero: '7', coluna: 'se', versao: 1 } }));
    expect(r.id).toBe('7_oc_v1_AVARIA'); expect(r.dados.retrabalho).toBe(false);
    expect(() => M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'texto livre' }))).toThrow('MOTIVO_INVALIDO');
    expect(() => M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'AVARIA', pedido: { numero: '7', coluna: 'ag' } }))).toThrow('ETAPA_INVALIDA');
    expect(() => M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'NAO_ENTREGUE', pedido: { numero: '7', coluna: 'pr' } }))).toThrow('MOTIVO_INVALIDO');
    expect(M.planejarRegistro(k({ tipo: 'OCORRENCIA', motivo: 'NAO_ENTREGUE', pedido: { numero: '7', coluna: 'de', versao: 3 } })).id).toBe('7_oc_v3_NAO_ENTREGUE');
    expect(M.motivosDaColuna('pr').map(x => x.id)).not.toContain('NAO_ENTREGUE');
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
    expect(r.conferencia).toEqual({ iniciadas: 0, registradas: 1, separadosConferidos: 1, cobertura: 1 / 3 });
    expect(r.divergencias).toMatchObject({ registros: 2, pedidos: 1, comRetrabalho: 1, taxaSobreSeparados: 1 / 3 });
    expect(r.divergencias.porMotivo).toMatchObject({ ITEM_ESQUECIDO: 1, AVARIA: 1, PRODUTO_ERRADO: 0 });
    const sem = calc({ ...base(), registros: [] });
    expect(sem.divergencias.taxaSobreSeparados).toBeNull();            // zero registro não vira "0% de erro"
    expect(sem.intervalos.separadoConferido.confianca).toBe('SEM DADO');
    expect(M.paraMarkdown(sem)).toMatch(/NÃO significa zero erro/);
  });
  test('nada por pessoa: sem ranking, sem código de operador e sem identificador; aviso de uso sempre presente', () => {
    const r = calc(base());
    expect(r).not.toHaveProperty('operadores'); expect(r.contagens.contasQueRegistraram).toBe(2);
    for (const texto of [JSON.stringify(r), M.paraMarkdown(r), M.paraHtml(r)]) expect(texto).not.toMatch(/uid-aaa|uid-bbb|Operador|\bO[12]\b/);
    for (const texto of [M.paraMarkdown(r), M.paraHtml(r)]) expect(texto).toContain('NÃO servem para punição, desconto ou avaliação de funcionários');
  });
  test('sequência rápida: mesmo clique em OUTRO pedido a menos de 1 min; separar um e iniciar o próximo não é sequência', () => {
    const r = calc(base());
    // pedido 2 e 3: os dois "Iniciar" com 20 s de diferença
    expect(r.cliques).toEqual({ total: 13, naHora: 11, loteDeclarado: 0, sequencia: 2, depois: 0, fora: 0 });
    const d = { pedidos: [ped('1', 'pr', 2), ped('2', 'se', 1)], registros: [], eventos: [ev('1', 1, 'INICIAR_SEPARACAO', T0 + H), ev('1', 2, 'MARCAR_SEPARADO', T0 + 2 * H), ev('2', 1, 'INICIAR_SEPARACAO', T0 + 2 * H + 5000)] };
    expect(calc(d).cliques).toMatchObject({ naHora: 3, sequencia: 0 });
  });
  test('tempos úteis: saem sequência, atraso informado, fora do expediente e cliques emendados', () => {
    const r = calc(base());
    expect(r.intervalos.separacao).toMatchObject({ n: 3, uteis: { n: 2, p50: 20 * MIN }, descartes: { sequencia: 1 } });
    const d = base();
    d.registros.push({ pedido: '1', tipo: 'MARCA', versao: 2, etapa: 'MARCAR_SEPARADO', depois: true, em: T0 + 70 * MIN, por: 'uid-bbb' });
    d.eventos.push(ev('5', 1, 'INICIAR_SEPARACAO', T0 + 13 * H), ev('5', 2, 'MARCAR_SEPARADO', T0 + 13 * H + 20 * MIN), ev('6', 1, 'INICIAR_SEPARACAO', T0 + 30 * H), ev('6', 2, 'MARCAR_SEPARADO', T0 + 30 * H + 20000));
    d.pedidos.push(ped('5', 'pr', 2), ped('6', 'pr', 2));
    const x = calc(d);
    expect(x.intervalos.separacao.descartes).toMatchObject({ depois: 1, fora: 1, curto: 1, sequencia: 1 });
    expect(x.intervalos.separacao.uteis.n).toBe(1);
    expect(x.cliques).toMatchObject({ depois: 1, fora: 2 });
    // marca de outra etapa na mesma versão não contamina o evento
    d.registros[d.registros.length - 1].etapa = 'DESPACHAR';
    expect(calc(d).cliques.depois).toBe(0);
  });
  test('lote declarado: fora do tempo individual, medido como lote (duração, por pedido, linhas por minuto)', () => {
    const marca = (pedido, versao, etapa, em, lote) => ({ pedido, versao, etapa, tipo: 'MARCA', lote, loteTam: 2, em, por: 'uid-aaa' });
    const A = 'Labc-0001', B = 'Labc-0002';
    const d = { pedidos: [ped('1', 'pr', 2), ped('2', 'pr', 2, { itens: 6 }), ped('3', 'pr', 2, { itens: 4 })], registros: [
      marca('1', 1, 'INICIAR_SEPARACAO', T0 + H, A), marca('2', 1, 'INICIAR_SEPARACAO', T0 + H, A), marca('1', 2, 'MARCAR_SEPARADO', T0 + H + 20 * MIN, B), marca('2', 2, 'MARCAR_SEPARADO', T0 + H + 20 * MIN, B),
    ], eventos: [ev('1', 1, 'INICIAR_SEPARACAO', T0 + H, 'uid-aaa'), ev('2', 1, 'INICIAR_SEPARACAO', T0 + H + 1000, 'uid-aaa'), ev('1', 2, 'MARCAR_SEPARADO', T0 + H + 20 * MIN, 'uid-aaa'), ev('2', 2, 'MARCAR_SEPARADO', T0 + H + 20 * MIN + 1000, 'uid-aaa'),
      ev('3', 1, 'INICIAR_SEPARACAO', T0 + 3 * H), ev('3', 2, 'MARCAR_SEPARADO', T0 + 3 * H + 8 * MIN)] };
    const r = calc(d);
    expect(r.cliques).toMatchObject({ loteDeclarado: 4, sequencia: 0 });
    expect(r.intervalos.separacao).toMatchObject({ n: 3, uteis: { n: 1, p50: 8 * MIN }, descartes: { lote: 2 } });
    expect(r.intervalos.entradaInicio.uteis.n).toBe(3);                       // espera: o lote conta
    expect(r.lotes.separacao.emLote).toMatchObject({ lotes: 1, pedidos: 2, p50DuracaoMs: 20 * MIN + 1000, p50MsPorPedido: (20 * MIN + 1000) / 2 });
    expect(r.lotes.separacao.emLote.linhasPorMinuto).toBeCloseTo(8 / ((20 * MIN + 1000) / MIN), 5);
    expect(r.lotes.separacao.individual).toMatchObject({ pedidos: 1, linhasPorMinuto: 0.5 });
    expect(r.lotes.porEtapa.INICIAR_SEPARACAO).toEqual({ lotes: 1, pedidos: 2 });
    d.eventos.splice(3, 1);                                                    // um pedido do lote ainda separando: lote em aberto
    expect(calc(d).lotes.separacao.emLote.lotes).toBe(0);
  });
  test('conferência com início, entrega, divergência na entrega e venda gravada no pedido', () => {
    const d = { pedidos: [ped('1', 'de', 3, { envio: 'rota-manha', vendaCadastradaEm: T0 - MIN }), ped('2', 'de', 3, { envio: 'retirada' })], eventos: [
      ev('1', 1, 'INICIAR_SEPARACAO', T0 + H), ev('1', 2, 'MARCAR_SEPARADO', T0 + H + 10 * MIN), ev('1', 3, 'DESPACHAR', T0 + 2 * H),
      ev('2', 1, 'INICIAR_SEPARACAO', T0 + 4 * H), ev('2', 2, 'MARCAR_SEPARADO', T0 + 4 * H + 10 * MIN), ev('2', 3, 'DESPACHAR', T0 + 5 * H)], registros: [
      { pedido: '1', tipo: 'CONFERENCIA_INICIO', versao: 2, em: T0 + H + 15 * MIN, por: 'a' }, { pedido: '1', tipo: 'CONFERENCIA', versao: 2, em: T0 + H + 18 * MIN, por: 'a' },
      { pedido: '1', tipo: 'ENTREGA', versao: 3, em: T0 + 3 * H, por: 'a' }, { pedido: '1', tipo: 'OCORRENCIA', versao: 3, motivo: 'NAO_ENTREGUE', retrabalho: false, em: T0 + 3 * H + 5 * MIN, por: 'a' }] };
    const r = calc(d);
    expect(r.intervalos.vendaEntrada).toMatchObject({ n: 1, p50: MIN });
    expect(r.intervalos.separadoConfInicio.p50).toBe(5 * MIN); expect(r.intervalos.conferencia.uteis.p50).toBe(3 * MIN);
    expect(r.intervalos.conferidoDespacho.p50).toBe(42 * MIN); expect(r.intervalos.saidaEntrega.uteis.p50).toBe(H);
    expect(r.entregas).toEqual({ noAtoDaSaida: 1, aConfirmar: 1, confirmadas: 1, cobertura: 1 });
    expect(r.divergencias.depoisDaSaida).toBe(1);
    expect(r.dias[0]).toMatchObject({ dia: '2026-11-30', separados: 2, conferidos: 1, saidas: 2, entregas: 2, divergencias: 1 });
    expect(r.dias).toHaveLength(7);
  });
  test('gargalo = etapa com maior tempo dentro do expediente, com pelo menos 5 registros úteis', () => {
    const d = { pedidos: [], eventos: [], registros: [] };
    for (let i = 1; i <= 6; i++) { const t = T0 + i * 20 * MIN; d.pedidos.push(ped(String(i), 'de', 3, { criadoEm: t, envio: 'retirada' }));
      d.eventos.push(ev(String(i), 1, 'INICIAR_SEPARACAO', t + 5 * MIN), ev(String(i), 2, 'MARCAR_SEPARADO', t + 10 * MIN), ev(String(i), 3, 'DESPACHAR', t + 100 * MIN)); }
    const r = calc(d);
    expect(r.gargalos.maior).toBe('separadoDespacho');
    expect(r.gargalos.etapas.find(e => e.chave === 'separadoDespacho')).toMatchObject({ n: 6, amostraPequena: true });
    expect(M.paraMarkdown(r)).toMatch(/MAIOR TEMPO \(amostra pequena\)/);
    expect(calc(base()).gargalos.maior).toBeNull();
  });
  test('confiabilidade: nunca ALTA para tempo entre cliques', () => {
    const c = (n, uteis) => M.confiancaIntervalo({ n, uteis: { n: uteis } });
    expect(c(0, 0)).toBe('SEM DADO'); expect(c(50, 5)).toBe('AMOSTRA PEQUENA'); expect(c(100, 30)).toBe('BAIXA'); expect(c(50, 45)).toBe('MÉDIA');
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
    expect(r.contagens.entradas).toBe(0); expect(M.paraMarkdown(r)).toMatch(/medição de/); expect(M.paraHtml(r)).toMatch(/não medem sozinhos o trabalho físico/);
  });
});

describe('acompanhamento de 7 dias e expediente', () => {
  const cfg = { ativa: true, inicio: '2026-11-30' };
  test('janela de 7 dias corridos a partir da data escolhida', () => {
    expect(M.periodo('acompanhamento', agoraMs, cfg)).toMatchObject({ de: '2026-11-30', ate: '2026-12-06' });
    for (const c of [null, {}, { inicio: '30/11' }, { inicio: '2026-02-30' }]) expect(() => M.periodo('acompanhamento', agoraMs, c)).toThrow('SEM_DATA_INICIO');
    const em = d => M.estadoAcompanhamento(cfg, Date.parse(d + '-03:00'));
    expect(em('2026-11-29T23:00:00').estado).toBe('antes');
    expect(em('2026-11-30T00:10:00')).toMatchObject({ estado: 'andamento', dia: 1 });
    expect(em('2026-12-06T23:50:00')).toMatchObject({ estado: 'andamento', dia: 7 });
    expect(em('2026-12-07T00:10:00').estado).toBe('encerrado');
  });
  test('expediente padrão 7h–19h seg–sáb; configurável; inválido volta ao padrão', () => {
    const t = s => Date.parse(s + '-03:00');
    expect(M.foraDoExpediente(t('2026-11-30T06:59:00'))).toBe(true); expect(M.foraDoExpediente(t('2026-11-30T07:00:00'))).toBe(false);
    expect(M.foraDoExpediente(t('2026-11-30T19:00:00'))).toBe(true); expect(M.foraDoExpediente(t('2026-12-06T10:00:00'))).toBe(true);   // domingo
    expect(M.foraDoExpediente(t('2026-11-30T19:30:00'), { horaInicio: 8, horaFim: 20 })).toBe(false);
    expect(M.expediente({ horaInicio: 20, horaFim: 8 })).toEqual({ horaInicio: 7, horaFim: 19 });
    // sábado 18h → segunda 8h = 1 h de sábado + 1 h de segunda (domingo não conta)
    expect(M.msNoExpediente(t('2026-12-05T18:00:00'), t('2026-12-07T08:00:00'))).toBe(2 * H);
  });
});

describe('venda recebida no sync central', () => {
  const SYNC = require('../lib/expedicao/sync');
  test('grava o horário de cadastro do GestãoClick quando legível; sem ele, o documento fica como antes', () => {
    const agora = Date.parse('2026-11-30T10:00:00-03:00'), v = { numero: '1' };
    expect(SYNC.pedidoNovo({ ...v, cadastradoEm: '2026-11-30 09:58:30' }, agora, 'ts').vendaCadastradaEm).toBe(agora - 90000);
    for (const cadastradoEm of [undefined, '', 'ontem', '2026-12-30 09:00:00']) expect(SYNC.pedidoNovo({ ...v, cadastradoEm }, agora, 'ts')).not.toHaveProperty('vendaCadastradaEm');
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
