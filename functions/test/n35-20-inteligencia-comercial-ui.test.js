'use strict';
// N35.20 — Inteligência Comercial V1 na interface: contexto no gerador + view-model do card/detalhe.
// Puro (db=null), sem produção, sem LLM.
const fs = require('fs');
const path = require('path');
const C = require('../lib/contextoComercial');
const WV = require('../../modulos/fila-worklist-view.js');
const { calcularPerfil360 } = require('../lib/perfil360');
const { calcularTendencia } = require('../lib/tendenciaComercial');
const { criarEstadoInicial, claimOportunidade, registrarOutcome, releaseOpportunity, isCooledDown } = require('../lib/filaOperacional');

const HOJE = '2026-09-25';
const D1 = new Date('2026-09-28T09:00:00.000Z');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/fila-comercial.html'), 'utf8');
const VIEW_SRC = fs.readFileSync(path.join(__dirname, '../../modulos/fila-worklist-view.js'), 'utf8');

function vendasCli({ gc = '123', n = 8, ultima = '2026-04-13', intervalo = 14, produtos } = {}) {
  const out = [];
  const base = Date.parse(ultima + 'T12:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(base - i * intervalo * 86400000).toISOString().slice(0, 10);
    const itens = produtos ? produtos(i) : [
      { produto_id: 'P1', nome_produto: 'KIT LED H4 6000K', quantidade: '5', valor_total: '300.00' },
      ...(i % 2 === 0 ? [{ produto_id: 'P2', nome_produto: 'CAMERA DE RE KX3', quantidade: '1', valor_total: '150.00' }] : []),
      ...(i % 4 === 0 ? [{ produto_id: 'P4', nome_produto: 'SENSOR ESTACIONAMENTO', quantidade: '1', valor_total: '80.00' }] : []),
      ...(i === 0 ? [{ produto_id: 'P3', nome_produto: 'MULTIMIDIA 9P', quantidade: '1', valor_total: '900.00' },
        { produto_id: 'P5', nome_produto: 'TWEETER BL 10', quantidade: '1', valor_total: '50.00' }] : []),
      ...(i === 1 ? [{ produto_id: 'P6', nome_produto: 'LAMPADA T10 (50 un)', quantidade: '50', valor_total: '100.00' }] : []),
    ];
    out.push({ id: `V${gc}-${i}`, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: String(itens.reduce((s, x) => s + parseFloat(x.valor_total), 0)), produtos: itens });
  }
  return out;
}
function ctx({ vendas = vendasCli(), tipo = 'REATIVACAO_120D', grupo = 'novas', estado, perfilAtual = true, item = {} } = {}) {
  const perfil = calcularPerfil360({ clienteMr4Id: '123', gestaoClickId: '123', vendas, dataReferencia: HOJE });
  return C.buildContextoComercial({
    item: { opportunityInstanceId: 'aaaaaaaaaaaaaaaa', commercialEntityId: 'GC_NATIVE:123', tipoOportunidade: tipo, diasSemComprar: perfil.diasSemComprar, ...item },
    perfil, perfilAtual, tendenciaCodigo: calcularTendencia(perfil).tendencia, vendas, grupo, estadoOperacional: estado, dataReferencia: HOJE,
  });
}
const itemCom = (c, extra = {}) => ({ opportunityInstanceId: 'aaaaaaaaaaaaaaaa', tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'CLIENTE TESTE', situacao: 'Texto legado', contextoComercial: c, ...extra });
const strings = o => JSON.stringify(o).match(/"(?:[^"\\]|\\.)*"/g).map(s => JSON.parse(s));

describe('Contexto (IC-01..17)', () => {
  test('IC-01 motivo reativação', () => {
    expect(ctx().motivo).toBe('Sem comprar há 165 dias. Cliente recorrente que comprava aproximadamente a cada 14 dias e parou.');
  });
  test('IC-01b "parou" só com atraso real (ciclo longo não atrasado apenas descreve o ritmo)', () => {
    const t = C.buildOpportunityReason({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 133, cicloHabitualDias: 251, pedidosTotal: 6 });
    expect(t.texto).toBe('Sem comprar há 133 dias. Costuma comprar aproximadamente a cada 251 dias.');
    const s = C.buildContextoComercial({ item: { tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 133 }, perfil: { pedidosTotal: 6, diasEntreComprasMediana: 251 }, dataReferencia: HOJE });
    expect(s.sinais.map(x => x.tipo)).not.toContain('ATRASO_CICLO');
  });
  test('IC-02 motivo recompra', () => {
    const c = ctx({ vendas: vendasCli({ n: 10, ultima: '2026-08-25', intervalo: 20 }), tipo: 'JANELA_DE_RECOMPRA' });
    expect(c.motivo).toBe('Costuma comprar aproximadamente a cada 20 dias. A última compra foi há 31 dias.');
    expect(c.rotuloTipo).toBe('Janela de recompra');
  });
  test('IC-03 motivo queda: afirma queda só com tendência atual CAINDO', () => {
    const q = C.buildOpportunityReason({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 40, tendenciaAtual: 'CAINDO' });
    expect(q.texto).toBe('As compras recentes diminuíram em relação ao período anterior. A última compra foi há 40 dias.');
    const sem = C.buildOpportunityReason({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 40, tendenciaAtual: null });
    expect(sem.texto).toBe('A última compra foi há 40 dias.');
  });
  test('IC-04 follow-up tem precedência (inclusive sobre pendência)', () => {
    const c = ctx({ grupo: 'followUps', estado: { nextFollowUpAt: HOJE, eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome: 'PEDIU_RETORNO' }] }, item: { atribuidoDesde: '2026-09-20' } });
    expect(c.motivoCodigo).toBe('FOLLOW_UP');
    expect(c.motivo).toBe('Retorno combinado com o cliente para hoje.');
  });
  test('IC-05 pendência tem precedência sobre a regra da oportunidade', () => {
    const c = ctx({ grupo: 'pendentes', item: { atribuidoDesde: '2026-09-25' } });
    expect(c.motivoCodigo).toBe('PENDENCIA_ANTERIOR');
    expect(c.motivo).toBe('Continua na sua fila desde 25/09/2026. Sem comprar há 165 dias. Cliente recorrente que comprava aproximadamente a cada 14 dias e parou.');
  });
  test('IC-06 1 pedido não cria ciclo', () => { expect(ctx({ vendas: vendasCli({ n: 1 }) }).historico.cicloHabitualDias).toBeUndefined(); });
  test('IC-07 2 pedidos não cria ciclo (344 dias nunca aparece)', () => {
    const c = ctx({ vendas: vendasCli({ n: 2, intervalo: 344 }) });
    expect(c.historico.cicloHabitualDias).toBeUndefined();
    expect(c.motivo).toBe('Sem comprar há 165 dias.');
    expect(JSON.stringify(c)).not.toContain('344');
  });
  test('IC-08 3+ pedidos pode criar ciclo', () => { expect(ctx({ vendas: vendasCli({ n: 3, intervalo: 30 }) }).historico.cicloHabitualDias).toBe(30); });
  test('IC-09 ciclo arredondado (mediana x.5 → inteiro)', () => {
    const v = vendasCli({ n: 4, intervalo: 10 });
    v[3].data = new Date(Date.parse(v[2].data + 'T12:00:00Z') - 11 * 86400000).toISOString().slice(0, 10); // intervalos 10,10,11 → mediana 10
    const v2 = vendasCli({ n: 3, intervalo: 10 });
    v2[2].data = new Date(Date.parse(v2[1].data + 'T12:00:00Z') - 11 * 86400000).toISOString().slice(0, 10); // intervalos 10,11 → mediana 10.5
    expect(ctx({ vendas: v2 }).historico.cicloHabitualDias).toBe(11);
    expect(Number.isInteger(ctx({ vendas: v }).historico.cicloHabitualDias)).toBe(true);
  });
  test('IC-10 produto recorrente exige >= 2 pedidos distintos', () => {
    const nomes = ctx().produtos.recorrentes.map(p => p.nome);
    expect(nomes).not.toContain('MULTIMIDIA 9P'); // 1 pedido
    expect(nomes).not.toContain('LAMPADA T10 (50 un)'); // 50 unidades, 1 pedido
  });
  test('IC-11 produtos ordenados por nº de pedidos (não por unidades)', () => {
    expect(ctx().produtos.recorrentes).toEqual([{ nome: 'KIT LED H4 6000K', pedidos: 8 }, { nome: 'CAMERA DE RE KX3', pedidos: 4 }, { nome: 'SENSOR ESTACIONAMENTO', pedidos: 2 }]);
  });
  test('IC-12 limite de 3 produtos recorrentes e 3 da última compra', () => {
    const c = ctx();
    expect(c.produtos.recorrentes.length).toBeLessThanOrEqual(3);
    expect(c.produtos.ultimaCompra).toEqual([{ nome: 'KIT LED H4 6000K' }, { nome: 'CAMERA DE RE KX3' }, { nome: 'SENSOR ESTACIONAMENTO' }]);
  });
  test('IC-13 tendência atual exibida em linguagem humana', () => {
    const c = ctx({ vendas: vendasCli({ n: 30, ultima: '2026-09-20', intervalo: 7 }), tipo: 'JANELA_DE_RECOMPRA' });
    if (c.tendencia) expect(['Compras aumentando', 'Compras diminuindo', 'Compras estáveis']).toContain(c.tendencia.label);
    const q = C.buildContextoComercial({ item: { tipoOportunidade: 'QUEDA_DE_COMPRAS' }, perfil: { pedidosTotal: 5 }, perfilAtual: true, tendenciaCodigo: 'CAINDO', dataReferencia: HOJE });
    expect(q.tendencia).toEqual({ codigo: 'CAINDO', label: 'Compras diminuindo' });
  });
  test('IC-14 tendência defasada omitida (perfil gravado fora da dataReferencia)', () => {
    const q = C.buildContextoComercial({ item: { tipoOportunidade: 'QUEDA_DE_COMPRAS' }, perfil: { pedidosTotal: 5 }, perfilAtual: false, tendenciaCodigo: 'CAINDO', dataReferencia: HOJE });
    expect(q.tendencia).toBeUndefined();
    expect(q.motivo).not.toMatch(/diminu/);
    expect(q.sinais.map(s => s.tipo)).not.toContain('COMPRAS_DIMINUINDO');
  });
  test('IC-15 produto com PII é descartado (não corrigido)', () => {
    const c = ctx({ vendas: vendasCli({ produtos: () => [
      { produto_id: 'A', nome_produto: 'KIT LED H4', quantidade: '1', valor_total: '1' },
      { produto_id: 'B', nome_produto: 'ENTREGA RUA DAS FLORES 123', quantidade: '1', valor_total: '1' },
      { produto_id: 'C', nome_produto: 'CPF 123.456.789-09 BRINDE', quantidade: '1', valor_total: '1' },
      { produto_id: 'D', nome_produto: 'LIGAR (85) 98765-4321', quantidade: '1', valor_total: '1' },
      { produto_id: 'E', nome_produto: 'x@y.com', quantidade: '1', valor_total: '1' },
    ] }) });
    expect(c.produtos.recorrentes).toEqual([{ nome: 'KIT LED H4', pedidos: 8 }]);
    expect(c.produtos.ultimaCompra).toEqual([{ nome: 'KIT LED H4' }]);
    expect(C.contextoSemPII(c)).toBe(true);
  });
  test('IC-16 PII nunca aparece no motivo/sinais; defesa final detecta texto contaminado', () => {
    const c = ctx();
    for (const s of [c.motivo, ...c.sinais.map(x => x.label)]) expect(C.contemPII(s)).toBe(false);
    expect(C.contextoSemPII({ ...c, motivo: 'Cliente 12.345.678/0001-95' })).toBe(false);
    expect(C.contextoSemPII({ ...c, sinais: [{ tipo: 'X', label: 'fone 85 98765-4321' }] })).toBe(false);
  });
  test('IC-17 ausência de categoria não quebra (campo não existe)', () => {
    const c = C.buildContextoComercial({ item: { tipoOportunidade: 'REATIVACAO_120D' }, perfil: { categoriasMaisCompradas: [] }, dataReferencia: HOJE });
    expect(c.categorias).toBeUndefined();
    expect(() => WV.modeloDetalhe(itemCom(c), {})).not.toThrow();
  });
});

describe('Interface (IC-18..24)', () => {
  const c = ctx();
  test('IC-18 vendedor não vê ticket médio (nem no card nem no detalhe)', () => {
    expect(c.gestao.ticketMedio).toBeGreaterThan(0);
    const card = WV.modeloCard(itemCom(c));
    const det = WV.modeloDetalhe(itemCom(c), { gestao: false });
    expect(det.gestao).toBeNull();
    for (const s of [...strings(card), ...strings(det)]) expect(s).not.toMatch(/R\$|ticket/i);
    expect(WV.modeloDetalhe(itemCom(c)).gestao).toBeNull(); // padrão = vendedor
  });
  test('IC-19 gestão vê ticket médio formatado (N35.20.1: vindo do documento gerencial, não do contexto)', () => {
    const det = WV.modeloDetalhe(itemCom(c), { gestao: true, dadosGestao: { ticketMedio: 426.05 } });
    expect(det.gestao.ticketMedio).toBe('R$ 426,05');
    expect(WV.modeloDetalhe(itemCom(c), { gestao: true }).gestao).toEqual({ estado: 'carregando' });
    expect(WV.modeloDetalhe(itemCom(c), { gestao: true, dadosGestao: null }).gestao).toEqual({ estado: 'indisponivel' });
    // contexto no formato N35.20 local (com gestao.ticketMedio) é ignorado
    expect(WV.modeloDetalhe(itemCom({ ...c, gestao: { ticketMedio: 999 } }), { gestao: true, dadosGestao: null }).gestao).toEqual({ estado: 'indisponivel' });
  });
  test('IC-18b vendedor não vê ticket mesmo se dados gerenciais forem passados por engano', () => {
    expect(WV.modeloDetalhe(itemCom({ ...c, gestao: { ticketMedio: 999 } }), { gestao: false, dadosGestao: { ticketMedio: 426.05 } }).gestao).toBeNull();
  });
  test('IC-20 produtos não aparecem no card', () => {
    const card = WV.modeloCard(itemCom(c));
    expect(card).toEqual({ usaContexto: true, motivo: c.motivo, linhaHistorico: 'Última compra: 13/04/2026 · 8 pedidos' });
    const fn = HTML.slice(HTML.indexOf('function renderWorklistCard'), HTML.indexOf('function renderGrupoWl'));
    expect(fn).not.toMatch(/produtos|ticket|gestao/i);
  });
  test('IC-20b card de pendência: motivo real visível e "Pendente desde" na linha de histórico; detalhe completo', () => {
    const p = ctx({ grupo: 'pendentes', item: { atribuidoDesde: '2026-09-25' } });
    const card = WV.modeloCard(itemCom(p));
    expect(card.motivo).toBe('Sem comprar há 165 dias. Cliente recorrente que comprava aproximadamente a cada 14 dias e parou.');
    expect(card.linhaHistorico).toBe('Pendente desde 25/09 · Última compra: 13/04/2026 · 8 pedidos');
    expect(WV.modeloDetalhe(itemCom(p)).motivo.startsWith('Continua na sua fila desde 25/09/2026.')).toBe(true);
  });
  test('IC-21 produtos aparecem no detalhe (recorrentes com nº de pedidos + última compra)', () => {
    const det = WV.modeloDetalhe(itemCom(c), {});
    expect(det.produtosRecorrentes[0]).toEqual({ nome: 'KIT LED H4 6000K', detalhe: '8 pedidos' });
    expect(det.produtosUltimaCompra.length).toBeGreaterThan(0);
    expect(HTML).toContain('Produtos recorrentes');
    expect(HTML).toContain('Contexto comercial');
  });
  test('IC-22 contexto ausente usa fallback (card e detalhe anteriores)', () => {
    const legado = { opportunityInstanceId: 'bbbbbbbbbbbbbbbb', tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'X', situacao: 'Está há 200 dias sem comprar.', quando: 'Neste ciclo', sinaisVisiveis: [{ label: 'Dias sem comprar', valor: '200 dias' }] };
    expect(WV.modeloCard(legado)).toEqual({ usaContexto: false, motivo: 'Está há 200 dias sem comprar.', linhaHistorico: null });
    const d = WV.modeloDetalhe(legado, {});
    expect(d.usaContexto).toBe(false);
    expect(d.sinaisLegados).toEqual([{ label: 'Dias sem comprar', valor: '200 dias' }]);
    expect(WV.modeloCard({ ...legado, contextoComercial: { versao: 'V9' } }).usaContexto).toBe(false); // versão desconhecida → legado
  });
  test('IC-23 nulls/undefined/N/A/"0 dias" nunca aparecem', () => {
    const esparso = C.buildContextoComercial({ item: { tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 0 }, perfil: { pedidosTotal: 1, ultimaCompraEm: '2026-09-25' }, dataReferencia: HOJE });
    const card = WV.modeloCard(itemCom(esparso));
    const det = WV.modeloDetalhe(itemCom(esparso), { gestao: true });
    for (const s of [...strings(card), ...strings(det)]) expect(s).not.toMatch(/^(null|undefined|NaN|N\/A)$|\b0 dias\b/);
    expect(det.historico.find(h => h.label === 'Sem comprar')).toBeUndefined();
  });
  test('IC-24 enum técnico não aparece (contexto e sinais legados)', () => {
    expect(WV.humanizarValorLegado('CRESCENDO')).toBe('Compras aumentando');
    expect(WV.humanizarValorLegado('↗ Subindo')).toBe('Compras aumentando');
    expect(WV.humanizarValorLegado('↘ Caindo')).toBe('Compras diminuindo');
    expect(WV.humanizarValorLegado('→ Estável')).toBe('Compras estáveis');
    expect(WV.humanizarValorLegado('ALGUM_ENUM_NOVO')).toBeNull();
    expect(WV.sinaisLegadosSeguros([{ label: 'Tendência', valor: 'CRESCENDO' }, { label: 'X', valor: 'OUTRO_ENUM' }])).toEqual([{ label: 'Tendência', valor: 'Compras aumentando' }]);
    const det = WV.modeloDetalhe(itemCom(ctx({ tipo: 'JANELA_DE_RECOMPRA', vendas: vendasCli({ n: 30, ultima: '2026-09-20', intervalo: 7 }) })), { gestao: true });
    for (const s of strings(det)) expect(s).not.toMatch(/^[A-Z][A-Z_]{3,}$/);
  });
  test('IC-24b gestão: contagens por tipo e por origem, sem ranking nem valores', () => {
    const doc = { schemaVersion: 'worklist-v2', dataReferencia: HOJE, vendedoresAtivos: ['a'], vendedoresRotulos: { a: 'A' }, vendedores: { a: {
      novas: [itemCom(c, { opportunityInstanceId: '1111111111111111' })],
      pendentes: [itemCom(c, { opportunityInstanceId: '2222222222222222', tipoOportunidade: 'JANELA_DE_RECOMPRA' })],
      followUps: [itemCom(c, { opportunityInstanceId: '3333333333333333' })], emAtendimento: [] } } };
    const g = WV.montarVisaoGestao({ doc, hoje: HOJE, agoraMs: Date.now(), opMap: new Map() });
    expect(g[0].contagens).toMatchObject({ novas: 1, anteriores: 1, retornos: 1, porTipo: { 'Retomar contato': 2, 'Janela de recompra': 1 } });
    expect(JSON.stringify(g[0].contagens)).not.toMatch(/rank|score|ticket|R\$/i);
  });
});

// ── Não interferência (IC-25..35) ────────────────────────────────────────────
const A_UID = 'vend-a', B_UID = 'vend-b';
function cenario() {
  const vendas = [];
  for (let i = 0; i < 50; i++) vendas.push(...vendasCli({ gc: String(77700000 + i), n: 3 + (i % 6), ultima: new Date(Date.UTC(2026, 1, 1 + i)).toISOString().slice(0, 10), intervalo: 12 + (i % 9) }));
  const fc = (lim, rec = true) => ({ ativo: true, recebeNovasOportunidades: rec, limiteNovasPorDia: lim });
  const sistema = new Map([[A_UID, { nome: 'A', modulos: ['fila-comercial-operar'], filaComercial: fc(10) }], [B_UID, { nome: 'B', modulos: ['fila-comercial-operar'], filaComercial: fc(5) }]]);
  const users = new Map([[A_UID, { ativo: true, role: 'funcionario' }], [B_UID, { ativo: true, role: 'funcionario' }]]);
  return { vendas, sistema, users };
}
async function geracoes() {
  const base = cenario();
  const run = async (G, dados) => (await G.executarGeracaoWorklist({ db: null, now: D1, mode: 'DRY_RUN', logger: { log() {} }, lookupNome: async gc => 'Cliente ' + gc, dados })).doc;
  const Greal = require('../lib/worklistGenerator');
  const d0 = await run(Greal, { perfis: [], clientes: [], vendas: base.vendas, estados: new Map(), sistema: base.sistema, users: base.users, worklistAnterior: null });
  // estados: 1 follow-up vencido do vendedor A sobre uma oportunidade real
  const alvo = d0.vendedores[A_UID].novas[0];
  let e = criarEstadoInicial(alvo.commercialEntityId, alvo.opportunityInstanceId, alvo.tipoOportunidade, '2026-09-26T12:00:00.000Z');
  e = claimOportunidade(e, A_UID, '2026-09-26T12:01:00.000Z');
  e = registrarOutcome(e, A_UID, 'PEDIU_RETORNO', '2026-09-26T12:02:00.000Z', { scheduledFor: '2026-09-28' });
  const dados = () => ({ perfis: [], clientes: [], vendas: base.vendas, estados: new Map([[alvo.opportunityInstanceId, e]]), sistema: base.sistema, users: base.users,
    worklistAnterior: { ...d0, dataReferencia: '2026-09-25' } });
  let A;
  jest.isolateModules(() => {
    // "A" = sem contexto: mesma API do módulo (N35.20.1 inclui separarGestao/camposGestaoExpostos), build desligado
    jest.doMock('../lib/contextoComercial', () => ({ ...jest.requireActual('../lib/contextoComercial'), buildContextoComercial: () => null }));
    const Gsem = require('../lib/worklistGenerator');
    A = run(Gsem, dados());
  });
  A = await A;
  jest.dontMock('../lib/contextoComercial');
  const B = await run(Greal, dados());
  return { A, B };
}
const semContexto = doc => JSON.parse(JSON.stringify(doc, (k, v) => (k === 'contextoComercial' ? undefined : v)));
const lista = (doc, g) => doc.vendedoresAtivos.flatMap(u => doc.vendedores[u][g].map(x => `${u}:${x.rank}:${x.opportunityInstanceId}`));

describe('Não interferência (IC-25..35)', () => {
  let A, B;
  beforeAll(async () => { ({ A, B } = await geracoes()); });

  test('IC-25 opportunityInstanceIds idênticos e a ÚNICA diferença é contextoComercial', () => {
    const b = semContexto(B), a = semContexto(A);
    expect({ ...b, geradoEm: 0 }).toEqual({ ...a, geradoEm: 0 });
    const comCtx = B.vendedoresAtivos.flatMap(u => ['novas', 'pendentes', 'followUps'].flatMap(g => B.vendedores[u][g])).filter(x => x.contextoComercial).length;
    expect(comCtx).toBeGreaterThan(0);
    expect(JSON.stringify(A)).not.toContain('contextoComercial');
  });
  test('IC-26 ownership idêntico (atribuicoes uid/grupo/desde)', () => { expect(B.atribuicoes).toEqual(A.atribuicoes); });
  test('IC-27 distribuição idêntica (mesmos vendedores, ordem e ranks)', () => {
    expect(B.vendedoresAtivos).toEqual(A.vendedoresAtivos);
    expect(lista(B, 'novas')).toEqual(lista(A, 'novas'));
  });
  test('IC-28 limite diário idêntico', () => {
    expect(B.vendedoresConfig).toEqual(A.vendedoresConfig);
    expect(B.vendedores[B_UID].novas.length).toBeLessThanOrEqual(5);
    expect(B.contagens).toEqual(A.contagens);
  });
  test('IC-29 follow-ups idênticos (e com motivo de follow-up)', () => {
    expect(lista(B, 'followUps')).toEqual(lista(A, 'followUps'));
    expect(lista(B, 'followUps')).toHaveLength(1);
    expect(B.vendedores[A_UID].followUps[0].contextoComercial.motivoCodigo).toBe('FOLLOW_UP');
  });
  test('IC-30 pendências idênticas (e com motivo de pendência)', () => {
    expect(lista(B, 'pendentes')).toEqual(lista(A, 'pendentes'));
    expect(lista(B, 'pendentes').length).toBeGreaterThan(0);
    expect(B.vendedores[A_UID].pendentes[0].contextoComercial.motivoCodigo).toBe('PENDENCIA_ANTERIOR');
  });
  const naoUsaContexto = f => expect(fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8')).not.toMatch(/contextoComercial/);
  test('IC-31 claim não alterado (módulo não referencia contexto; resultado determinístico)', () => {
    naoUsaContexto('canaryCallable.js');
    const run = () => claimOportunidade(criarEstadoInicial('GC_NATIVE:1', 'eeeeeeeeeeeeeeee', 'REATIVACAO_120D', '2026-09-25T10:00:00.000Z'), 'u', '2026-09-25T10:01:00.000Z');
    const a = run(); ctx(); expect(run()).toEqual(a);
    expect(a.estado).toBe('EM_ATENDIMENTO');
  });
  test('IC-32 outcome não alterado', () => {
    naoUsaContexto('filaOperacional.js');
    const run = () => registrarOutcome(claimOportunidade(criarEstadoInicial('GC_NATIVE:1', 'eeeeeeeeeeeeeeee', 'REATIVACAO_120D', '2026-09-25T10:00:00.000Z'), 'u', '2026-09-25T10:01:00.000Z'), 'u', 'CONVERSA_REALIZADA', '2026-09-25T10:02:00.000Z');
    const a = run(); ctx(); expect(run()).toEqual(a);
    expect(a.estado).toBe('CONCLUIDA');
  });
  test('IC-33 cooldown não alterado', () => {
    const r = registrarOutcome(claimOportunidade(criarEstadoInicial('GC_NATIVE:1', 'eeeeeeeeeeeeeeee', 'REATIVACAO_120D', '2026-09-25T10:00:00.000Z'), 'u', '2026-09-25T10:01:00.000Z'), 'u', 'SEM_INTERESSE_AGORA', '2026-09-25T10:02:00.000Z');
    C.buildContextoComercial({ item: { tipoOportunidade: 'REATIVACAO_120D' }, estadoOperacional: r, grupo: 'emAtendimento', dataReferencia: HOJE });
    expect(isCooledDown(r, '2026-09-26T00:00:00.000Z')).toBe(true);
  });
  test('IC-34 state machine não alterada (decisão do motor não importa contexto)', () => {
    for (const f of ['filaOperacional.js', 'dailyWorklist.js', 'worklistUniverso.js', 'oportunidades.js', 'filaQueueConfig.js', 'canaryCallable.js']) naoUsaContexto(f);
    expect(typeof releaseOpportunity === 'function' || releaseOpportunity === undefined).toBe(true);
  });
  test('IC-35 nenhum I/O externo por card (view-model e render do contexto são puros)', () => {
    const view = VIEW_SRC;
    for (const p of ['fetch(', 'getDoc', 'collection(', 'httpsCallable', 'XMLHttpRequest', 'firebase']) expect(view.includes(p)).toBe(false);
    const render = HTML.slice(HTML.indexOf('function renderContextoComercial'), HTML.indexOf('function renderDetalheOperacional'));
    for (const p of ['fetch(', 'getDoc', 'collection(', 'httpsCallable', 'await ']) expect(render.includes(p)).toBe(false);
    const gerador = fs.readFileSync(path.join(__dirname, '../lib/worklistGenerator.js'), 'utf8');
    const fabrica = gerador.slice(gerador.indexOf('function criarFabricaContexto'), gerador.indexOf('function montarDocumento'));
    for (const p of ['fetch(', '.get(', 'collection(', 'lookupNome', 'await ']) expect(fabrica.replace(/porGc\.get\(|perfilPorEntidade\.get\(|dados\.estados\.get\(/g, '').includes(p)).toBe(false);
  });
});

describe('Robustez da integração', () => {
  test('IC-36 erro no cálculo do contexto não derruba a geração (item sai sem contexto)', async () => {
    const G = require('../lib/worklistGenerator');
    const fab = G.criarFabricaContexto({ dados: { vendas: [], perfis: [], estados: new Map() }, dataReferencia: HOJE });
    expect(fab({ commercialEntityId: 'INVALIDO' }, 'novas')).toBeNull();
    expect(fab({ commercialEntityId: 'GC_NATIVE:999', opportunityInstanceId: 'ffffffffffffffff', tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 130 }, 'novas').motivo).toBe('Sem comprar há 130 dias.');
  });
  test('IC-37 MR4_LINKED com perfil gravado defasado e sem vendas: sem tendência', () => {
    const G = require('../lib/worklistGenerator');
    const perfil = { clienteMr4Id: 'cli-1', gestaoClickId: null, dataReferencia: '2026-09-15', pedidosTotal: 6, ultimaCompraEm: '2026-05-01', diasEntreComprasMediana: 20, faturamento30d: 0, faturamento60d: 0, pedidos30d: 0, pedidos60d: 0, faturamento90d: 0, faturamento180d: 900, pedidos90d: 0, pedidos180d: 3 };
    const fab = G.criarFabricaContexto({ dados: { vendas: [], perfis: [{ id: 'cli-1', data: perfil }], estados: new Map() }, dataReferencia: HOJE });
    const c = fab({ commercialEntityId: 'MR4_LINKED:cli-1', opportunityInstanceId: 'ffffffffffffffff', tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 147 }, 'novas');
    expect(c.tendencia).toBeUndefined();
    expect(c.motivo).toBe('A última compra foi há 147 dias.');
    expect(c.historico.pedidosTotal).toBe(6);
  });
});
