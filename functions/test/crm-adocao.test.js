'use strict';
// CRM — adoção: atalhos do topo, "Pendentes" recolhida, histórico de produtos no cartão, ícones subconjuntados e a prova de que
// nada mudou nas regras: ordem das seções, dados enviados no registro e classificação comprovada / provável / não atribuída.
const fs = require('fs'), path = require('path');
const V = require('../../modulos/crm-view.js');
const A = require('../../modulos/crm-atribuicao-view.js');
const F = require('../lib/filaOperacional');
const C = require('../lib/conversaoComercial');
const { buildContextoComercial } = require('../lib/contextoComercial');
const { calcularPerfil360 } = require('../lib/perfil360');

const ler = f => fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');
const html = ler('modulos/crm.html');
const hoje = '2026-11-26', U = 'u1';
const agoraMs = Date.parse(hoje + 'T13:00:00Z');
const opp = i => String(i).padStart(16, '0');
const item = (i, extra) => ({ opportunityInstanceId: opp(i), commercialEntityId: 'GC_NATIVE:' + (100000 + i), tipoOportunidade: 'JANELA_DE_RECOMPRA', nomeCliente: 'Cliente Fictício ' + i, ...extra });
const faixa = (de, n) => Array.from({ length: n }, (_, k) => item(de + k));
const visaoCom = (pendentes, novas) => V.montarHoje({ uid: U, hoje, agoraMs, podeOperar: true, opMap: new Map(),
  doc: { schemaVersion: 'worklist-v2', dataReferencia: hoje, cap: 10, vendedores: { [U]: { followUps: [], emAtendimento: [], pendentes: faixa(1, pendentes), novas: faixa(500, novas) } } } });
const ids = l => l.map(x => x.item.opportunityInstanceId);

describe('QUEM: atalhos e seção recolhida (só apresentação)', () => {
  test('atalhos: só seções com itens, contagem real, na mesma ordem das seções da tela', () => {
    expect(V.atalhosDaLista(visaoCom(142, 10))).toEqual([{ secao: 'pendentes', rotulo: 'Pendentes', n: 142 }, { secao: 'novas', rotulo: 'Novas', n: 10 }]);
    expect(V.atalhosDaLista(visaoCom(0, 0))).toEqual([]);
    expect(V.atalhosDaLista(null)).toEqual([]);
    const secoes = [...html.slice(html.indexOf('const SECOES = ['), html.indexOf('function renderHoje')).matchAll(/^\s+\['(\w+)',/gm)].map(m => m[1]);
    expect(secoes).toEqual(['reativacoes', 'atrasados', 'retornosHoje', 'emAtendimento', 'pendentes', 'novas', 'trabalhadasHoje']);   // ordem operacional intacta
    const todas = Object.fromEntries(secoes.map(s => [s, [item(1)]]));
    expect(V.atalhosDaLista(todas).map(a => a.secao)).toEqual(secoes.slice(0, -1));
  });
  test('recolhida: os 5 primeiros na mesma ordem; expandida: todos; a lista original não muda', () => {
    const p = visaoCom(142, 10).pendentes, original = ids(p);
    expect(ids(V.recorteSecao(p, false, {}))).toEqual(original.slice(0, 5));
    expect(ids(V.recorteSecao(p, true, {}))).toEqual(original);
    expect(ids(p)).toEqual(original);
    expect(V.recorteSecao(p.slice(0, 3), false, {})).toHaveLength(3);
  });
  test('cartão com registro aberto nunca é escondido pelo recolhimento (rascunho preservado, ordem mantida)', () => {
    const p = visaoCom(30, 0).pendentes, aberto = p[20].item.opportunityInstanceId;
    expect(ids(V.recorteSecao(p, false, { [aberto]: { nota: 'rascunho' } }))).toEqual([...ids(p).slice(0, 5), aberto]);
  });
  test('tela: recolhe só "Pendentes"; Iniciar acompanha o cartão; JS antigo em cache ⇒ lista inteira, sem erro', () => {
    expect(html).toContain("const recolhivel = k === 'pendentes' && !!V.recorteSecao && itens.length > V.LIMITE_RECOLHIDA;");
    expect(html).toContain('(V.atalhosDaLista ? V.atalhosDaLista(v) : [])');
    expect(html).toContain('if (iniciado) mostrarCartao(id);');
    expect(html).toContain('${m.oferta ? ofertaHtml(m.oferta) : \'\'}');
  });
});

describe('O QUE: histórico de produtos no cartão (dado que o item já traz)', () => {
  const vendas = [60, 90, 120, 150].map((d, i) => {
    const data = new Date(Date.parse(hoje + 'T12:00:00Z') - d * 864e5).toISOString().slice(0, 10);
    const p = (id, n) => ({ produto_id: id, nome_produto: n, quantidade: '1' });
    return { id: String(10 + i), cliente_id: '123456', data, nome_situacao: 'Concretizada', valor_total: '10.00',
      produtos: i === 0 ? [p('1', 'Lâmpada fictícia'), p('3', 'Antena fictícia'), p('4', 'Cabo fictício')] : [p('1', 'Lâmpada fictícia'), p('2', 'Moldura fictícia'), p('5', 'Sensor fictício')] };
  });
  const ctx = buildContextoComercial({ item: item(1), perfil: calcularPerfil360({ clienteMr4Id: '123456', gestaoClickId: '123456', vendas, dataReferencia: hoje }), perfilAtual: true, vendas, dataReferencia: hoje });
  const modelo = V.modeloCartao({ item: item(1, { contextoComercial: ctx }), estado: {} }, null, null);

  test('usa exatamente o que o gerador gravou: até 2 recorrentes e até 2 da última compra, sem repetir', () => {
    expect(modelo.oferta.recorrentes).toEqual(ctx.produtos.recorrentes.slice(0, 2));
    expect(modelo.oferta.recorrentes[0]).toEqual({ nome: 'Lâmpada fictícia', pedidos: 4 });
    expect(modelo.oferta.ultimaCompra).toEqual(['Antena fictícia', 'Cabo fictício']);
  });
  test('sem produtos (reativação, retorno fora da lista, worklist antiga): cartão como antes', () => {
    expect(V.modeloCartao({ item: item(2), estado: {} }, null, null).oferta).toBeNull();
    expect(V.ofertaDoHistorico({ produtos: { recorrentes: [], ultimaCompra: [{ nome: '' }] } })).toBeNull();
    expect(V.ofertaDoHistorico({})).toBeNull();
  });
  test('número já dito no motivo não se repete; número diferente continua aparecendo', () => {
    const com = (motivo, historico) => V.modeloCartao({ item: item(3, { contextoComercial: { versao: 'V1', motivo, historico } }), estado: {} }, null, null).linhas.map(l => l.k);
    expect(com('Costuma comprar aproximadamente a cada 30 dias. A última compra foi há 25 dias.', { diasSemComprar: 25, cicloHabitualDias: 30 })).toEqual([]);
    expect(com('Sem comprar há 250 dias.', { diasSemComprar: 25, cicloHabitualDias: 30 })).toEqual(['Dias sem comprar', 'Compra a cada']);
    expect(com('Costuma comprar aproximadamente a cada 300 dias.', { cicloHabitualDias: 30 })).toEqual(['Compra a cada']);
    expect(com('A última compra foi há 1 dia.', { diasSemComprar: 1, ultimaCompraEm: '2026-11-25' })).toEqual(['Última compra']);
  });
  test('nome de produto entra no HTML só escapado e o rótulo não promete recomendação', () => {
    const fonte = html.slice(html.indexOf('function ofertaHtml'), html.indexOf('function painelRegistro'));
    const escLinha = html.split('\n').find(l => l.startsWith('const esc = '));
    const render = new Function(`${escLinha}\n${fonte}\nreturn ofertaHtml;`)();
    const s = render({ recorrentes: [{ nome: '<img src=x onerror=1>', pedidos: 3 }], ultimaCompra: ['"><script>'] });
    expect(s).not.toMatch(/<img|<script/); expect(s).toContain('&lt;img'); expect(s).toContain('(3 pedidos)');
    expect(s).toContain('Compra com frequência'); expect(s).toContain('Também na última compra');
    expect(render({ recorrentes: [], ultimaCompra: ['Cabo'] })).toContain('Na última compra');
    expect(fonte).not.toMatch(/ofereça|recomendad/i);
  });
});

describe('peso: fonte de ícones só com os ícones usados', () => {
  const nomes = (html.match(/icon_names=([a-z0-9_,]+)/) || [])[1];
  test('todo ícone da tela está na lista, em ordem alfabética (exigência do serviço); sem a fonte variável completa', () => {
    const usados = [...new Set([...html.matchAll(/class="ms">([a-z0-9_]+)</g)].map(m => m[1]))].sort();
    expect(nomes.split(',')).toEqual(usados);
    expect(html).not.toContain('opsz,wght,FILL,GRAD@20..48');
    expect(ler('modulos/agente-comercial-view.js')).not.toMatch(/class="ms"/);
  });
});

describe('regras comerciais intactas', () => {
  test('o registro envia os mesmos campos de antes', () => {
    expect(html).toContain('const payload = { opportunityInstanceId: id, outcome: sel.resultado, requestId: (sel.rid = sel.rid || novoRequestId()) };');
    expect(html).toContain("if (sel.resultado === 'PEDIU_RETORNO') payload.scheduledFor = sel.data;");
    expect(html).toContain('if (nota.texto) payload.nota = nota.texto;');
    expect([...html.matchAll(/payload\.(\w+) =/g)].map(m => m[1]).sort()).toEqual(['nota', 'scheduledFor']);
  });
  test('a tela do vendedor não toca atribuição, comissão nem carteira', () => {
    expect(html + ler('modulos/crm-view.js')).not.toMatch(/crmAtribuicaoRevisao|COMPROVADA|NAO_ATRIBUIDA|comiss[aã]o|carteira_comercial/i);
  });

  // Cenário fixo; os resultados esperados são os do commit base (ee9a62d). Qualquer mudança de regra quebra aqui.
  const vendedorGcPorUid = { a: '91', b: '92' };
  const atendimento = (i, outcome, meta, quem = 'a') => {
    const t0 = '2026-11-02T13:00:00.000Z', t1 = '2026-11-02T13:30:00.000Z';
    return F.registrarOutcome(F.claimOportunidade(F.criarEstadoInicial('GC_NATIVE:' + (200000 + i), opp(i), 'JANELA_DE_RECOMPRA', t0), quem, t0), quem, outcome, t1, meta);
  };
  const venda = (i, data, vendedor = '91') => ({ id: String(900 + i), cliente_id: String(200000 + i), data, cadastrado_em: data + ' 17:00:00', nome_situacao: 'Concretizada', valor_total: '100.00', vendedor_id: vendedor, produtos: [] });
  const estados = [atendimento(1, 'CONVERSA_REALIZADA', { interesse: 'SIM' }), atendimento(2, 'CONVERSA_REALIZADA'), atendimento(3, 'CONVERSA_REALIZADA'), atendimento(4, 'SEM_RESPOSTA'), atendimento(5, 'CONVERSA_REALIZADA')];
  const vendas = [venda(1, '2026-11-04'), venda(2, '2026-11-04'), venda(3, '2026-11-04', '92'), venda(4, '2026-11-04'), venda(5, '2026-11-14')];
  const f = C.calcularFunil({ estados, vendas, vendedorGcPorUid, opcoes: { dataCorte: '2026-11-25', janelaDias: 14 } });
  const casos = [...f.evidencia.casos].sort((x, y) => x.vendaId.localeCompare(y.vendaId));

  test('níveis da regra por cenário', () => {
    expect(casos.map(k => [k.vendaId, k.nivel, k.motivo])).toEqual([
      ['901', 'ATRIBUIDA_COM_EVIDENCIA', 'VENDEDOR_E_INTENCAO'], ['902', 'PROVAVEL', 'SEM_INTENCAO_REGISTRADA'], ['903', 'NAO_ATRIBUIVEL', 'VENDEDOR_DIVERGENTE'],
      ['904', 'NAO_ATRIBUIVEL', 'SEM_CONVERSA'], ['905', 'NAO_ATRIBUIVEL', 'PRAZO_LONGO_SEM_INTENCAO']]);
  });
  test('comprovada, provável e não atribuída seguem separadas; comprovada e não atribuída só por decisão humana', () => {
    const ambiguos = new Set(C.casosAmbiguos(f.evidencia.casos).map(k => k.vendaId));
    const tela = casos.map(k => ({ vendaId: k.vendaId, opportunityInstanceId: k.opp, clienteGcId: k.gc, pedido: { concluido: k.concluida, valor: k.valor }, sistema: { nivel: k.nivel },
      precisaRevisao: ambiguos.has(k.vendaId) || k.nivel === C.NIVEIS.ATRIBUIDA, revisao: null }));
    const base = tela.map(c => c.opportunityInstanceId);
    const resumo = lista => { const r = A.indicadores(lista, base).porSituacao; return A.SITUACOES.map(s => r[s].pedidos); };   // [comprovada, provável, aguardando, não atribuída]
    expect(resumo(tela)).toEqual([0, 1, 4, 0]);
    const decidir = (id, decisao) => c => (c.vendaId === id ? { ...c, revisao: { decisao, opportunityInstanceId: c.opportunityInstanceId } } : c);
    expect(resumo(tela.map(decidir('901', 'COMPROVADA')).map(decidir('903', 'NAO_ATRIBUIDA')))).toEqual([1, 1, 2, 1]);
    expect(A.DECISOES.map(d => d.codigo)).toEqual(['COMPROVADA', 'PROVAVEL', 'NAO_ATRIBUIDA']);
  });
});
