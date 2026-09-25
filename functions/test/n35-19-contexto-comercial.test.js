'use strict';
// N35.19 — Inteligência Comercial V1 (contexto do cliente). Puro, sem produção, sem LLM.
// N35.20: asserções atualizadas para o contrato V1 aprovado (motivo string, omissão de campos sem dado,
//         produtos agrupados, sinais {tipo,label}, gestao.ticketMedio). Mesmas intenções dos CI-01..23.
const fs = require('fs');
const path = require('path');
const C = require('../lib/contextoComercial');
const { calcularPerfil360 } = require('../lib/perfil360');
const { calcularTendencia } = require('../lib/tendenciaComercial');
const { criarEstadoInicial, claimOportunidade, registrarOutcome, isCooledDown } = require('../lib/filaOperacional');
const G = require('../lib/worklistGenerator');
const { contemDocumento } = require('../lib/nomeExibicao');

const HOJE = '2026-09-25';
const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const it = (o = {}) => ({ opportunityInstanceId: 'aaaaaaaaaaaaaaaa', commercialEntityId: 'GC_NATIVE:123', tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 165, ...o });

// 8 compras a cada ~14 dias, última em 2026-04-13 (165 dias antes de 25/09)
function vendasRecorrente({ n = 8, ultima = '2026-04-13', intervalo = 14, produtos } = {}) {
  const out = [];
  const base = Date.parse(ultima + 'T12:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(base - i * intervalo * 86400000).toISOString().slice(0, 10);
    const itens = produtos ? produtos(i) : [
      { produto_id: 'P1', nome_produto: 'KIT LED H4 6000K', quantidade: '2', valor_total: '300.00' },
      ...(i % 2 === 0 ? [{ produto_id: 'P2', nome_produto: 'CAMERA DE RE KX3', quantidade: '1', valor_total: '150.00' }] : []),
      ...(i === 0 ? [{ produto_id: 'P3', nome_produto: 'MULTIMIDIA 9P', quantidade: '1', valor_total: '900.00' }] : []),
    ];
    out.push({ id: 'V' + i, cliente_id: '123', data: d, nome_situacao: 'Concretizada', valor_total: String(itens.reduce((s, x) => s + parseFloat(x.valor_total), 0)), produtos: itens });
  }
  return out;
}
function ctxDe(vendas, o = {}) {
  const perfil = calcularPerfil360({ clienteMr4Id: '123', gestaoClickId: '123', vendas, dataReferencia: HOJE });
  const item = it({ diasSemComprar: perfil.diasSemComprar, ...(o.item || {}) });
  return C.buildContextoComercial({ perfil, perfilAtual: true, tendenciaCodigo: calcularTendencia(perfil).tendencia, vendas, dataReferencia: HOJE, ...o, item });
}
const tipos = c => c.sinais.map(s => s.tipo);
const PII = { cpf: /\d{3}\.\d{3}\.\d{3}-\d{2}/, cnpj: /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/, email: /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i, fone: /\(?\d{2}\)?\s?9\d{4}-?\d{4}/ };

describe('Motivo e determinismo', () => {
  test('CI-01 motivo determinístico com dados reais do histórico', () => {
    const c = ctxDe(vendasRecorrente());
    expect(c.motivoCodigo).toBe('REATIVACAO_120D');
    expect(c.motivo).toBe('Sem comprar há 165 dias. Cliente recorrente que comprava aproximadamente a cada 14 dias e parou.');
    expect(c.rotuloTipo).toBe('Retomar contato');
    expect(c.versao).toBe('V1');
  });

  test('CI-02 mesma entrada → mesma saída (inclusive ordem de produtos e sinais)', () => {
    const v = vendasRecorrente();
    expect(JSON.stringify(ctxDe(v))).toBe(JSON.stringify(ctxDe(JSON.parse(JSON.stringify(v)))));
    expect(JSON.stringify(ctxDe([...v].reverse()))).toBe(JSON.stringify(ctxDe(v)));
  });

  test('CI-03 sem dados → fallback seguro (sem exceção, sem números inventados, sem null)', () => {
    const c = C.buildContextoComercial({ item: { opportunityInstanceId: 'bbbbbbbbbbbbbbbb', tipoOportunidade: 'X' }, dataReferencia: HOJE });
    expect(c.motivo).toBe('Oportunidade selecionada pelas regras da fila comercial.');
    expect(c.historico).toEqual({});
    expect(c.produtos).toEqual({ recorrentes: [], ultimaCompra: [] });
    expect(c.sinais).toEqual([]);
    expect(c.gestao).toEqual({});
    expect(JSON.stringify(c)).not.toMatch(/null|undefined|NaN/);
  });

  test('CI-04 nunca inventa indicador: ciclo exige >= 3 pedidos; tendência exige perfil do dia; faturamento nunca entra', () => {
    const duas = ctxDe(vendasRecorrente({ n: 2, intervalo: 344 }));
    expect(duas.historico.cicloHabitualDias).toBeUndefined();
    const v = vendasRecorrente({ n: 8, ultima: '2026-09-10', intervalo: 5 });
    const perfil = calcularPerfil360({ clienteMr4Id: '123', gestaoClickId: '123', vendas: v, dataReferencia: HOJE });
    const defasado = C.buildContextoComercial({ item: it({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 15 }), perfil, perfilAtual: false, tendenciaCodigo: 'CAINDO', vendas: v, dataReferencia: HOJE });
    expect(defasado.tendencia).toBeUndefined();
    const s = JSON.stringify(ctxDe(vendasRecorrente()));
    for (const k of ['faturamento', 'faturamentoTotal', 'faturamento30d', 'faturamento90d', 'faturamento180d', 'score', 'prioridade']) expect(s.includes(`"${k}"`)).toBe(false);
  });

  test('CI-05 dias sem comprar correto (calendário, dataReferencia)', () => {
    const c = ctxDe(vendasRecorrente({ ultima: '2026-04-13' }));
    expect(c.historico.diasSemComprar).toBe(165);
    expect(c.historico.ultimaCompraEm).toBe('2026-04-13');
    expect(c.sinais).toContainEqual({ tipo: 'INATIVO', label: 'Sem comprar há 165 dias' });
  });

  test('CI-06 follow-up tem precedência explicativa sobre o tipo da oportunidade', () => {
    const estado = { nextFollowUpAt: HOJE, eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome: 'PEDIU_RETORNO' }] };
    const c = ctxDe(vendasRecorrente(), { grupo: 'followUps', estadoOperacional: estado });
    expect(c.motivoCodigo).toBe('FOLLOW_UP');
    expect(c.motivo).toBe('Retorno combinado com o cliente para hoje.');
    expect(c.sinais[0]).toEqual({ tipo: 'RETORNO_HOJE', label: 'Retorno para hoje' });
    const sr = ctxDe(vendasRecorrente(), { grupo: 'followUps', estadoOperacional: { nextFollowUpAt: '2026-09-24', eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome: 'SEM_RESPOSTA' }] } });
    expect(sr.motivo).toBe('Nova tentativa: o último contato ficou sem resposta.');
    expect(sr.sinais[0].tipo).toBe('RETORNO_VENCIDO');
  });

  test('CI-06b pendência anterior prefixa o motivo com a data da 1ª distribuição', () => {
    const c = ctxDe(vendasRecorrente(), { grupo: 'pendentes', item: { atribuidoDesde: '2026-09-25' } });
    expect(c.motivoCodigo).toBe('PENDENCIA_ANTERIOR');
    expect(c.motivo.startsWith('Continua na sua fila desde 25/09/2026. Sem comprar há 165 dias.')).toBe(true);
  });

  test('CI-06c JANELA_DE_RECOMPRA e QUEDA_DE_COMPRAS têm texto próprio', () => {
    const j = C.buildOpportunityReason({ tipoOportunidade: 'JANELA_DE_RECOMPRA', diasSemComprar: 31, cicloHabitualDias: 20, pedidosTotal: 50 });
    expect(j.texto).toBe('Costuma comprar aproximadamente a cada 20 dias. A última compra foi há 31 dias.');
    const q = C.buildOpportunityReason({ tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 92, tendenciaAtual: 'CAINDO' });
    expect(q.texto).toBe('As compras recentes diminuíram em relação ao período anterior. A última compra foi há 92 dias.');
  });
});

describe('Produtos e categorias', () => {
  test('CI-07 categoria não existe no contrato V1 (nunca "SEM_CATEGORIA")', () => {
    const c = ctxDe(vendasRecorrente());
    expect(c.categorias).toBeUndefined();
    expect(JSON.stringify(c)).not.toMatch(/categoria|SEM_CATEGORIA/i);
  });

  test('CI-08 produtos vazios (vendas sem itens) → listas vazias', () => {
    const c = ctxDe(vendasRecorrente({ produtos: () => [] }));
    expect(c.produtos).toEqual({ recorrentes: [], ultimaCompra: [] });
  });

  test('CI-08b recorrência = nº de pedidos distintos (>= 2); última compra = itens da venda mais recente', () => {
    const c = ctxDe(vendasRecorrente());
    expect(c.produtos.recorrentes).toEqual([{ nome: 'KIT LED H4 6000K', pedidos: 8 }, { nome: 'CAMERA DE RE KX3', pedidos: 4 }]);
    expect(c.produtos.ultimaCompra).toEqual([{ nome: 'KIT LED H4 6000K' }, { nome: 'CAMERA DE RE KX3' }, { nome: 'MULTIMIDIA 9P' }]);
  });

  test('CI-08c vendas não concretizadas não entram', () => {
    const v = vendasRecorrente();
    v.push({ id: 'VX', cliente_id: '123', data: '2026-09-20', nome_situacao: 'Em aberto', valor_total: '10', produtos: [{ produto_id: 'PX', nome_produto: 'NAO CONCRETIZADO', quantidade: '1', valor_total: '10' }] });
    expect(JSON.stringify(ctxDe(v))).not.toContain('NAO CONCRETIZADO');
  });
});

describe('Privacidade', () => {
  const sujo = () => [
    { produto_id: 'P1', nome_produto: 'KIT LED H4 6000K', quantidade: '1', valor_total: '100' },
    { produto_id: 'Q1', nome_produto: 'ENTREGA CPF 123.456.789-09', quantidade: '1', valor_total: '1' },
    { produto_id: 'Q2', nome_produto: 'NF CNPJ 12.345.678/0001-95', quantidade: '1', valor_total: '1' },
    { produto_id: 'Q3', nome_produto: 'CONTATO (85) 98765-4321', quantidade: '1', valor_total: '1' },
    { produto_id: 'Q4', nome_produto: 'ENVIAR PARA cliente@exemplo.com', quantidade: '1', valor_total: '1' },
  ];
  test('CI-09 CPF removido', () => { const s = JSON.stringify(ctxDe(vendasRecorrente({ produtos: sujo }))); expect(PII.cpf.test(s)).toBe(false); expect(contemDocumento(s)).toBe(false); });
  test('CI-10 CNPJ removido', () => { expect(PII.cnpj.test(JSON.stringify(ctxDe(vendasRecorrente({ produtos: sujo }))))).toBe(false); });
  test('CI-11 telefone não aparece', () => { expect(PII.fone.test(JSON.stringify(ctxDe(vendasRecorrente({ produtos: sujo }))))).toBe(false); });
  test('CI-12 e-mail não aparece', () => { expect(PII.email.test(JSON.stringify(ctxDe(vendasRecorrente({ produtos: sujo }))))).toBe(false); });
  test('CI-12b produto legítimo continua; campos de cadastro (cpf_cnpj/telefone/email) nunca são lidos', () => {
    const c = ctxDe(vendasRecorrente({ produtos: sujo }));
    expect(c.produtos.recorrentes.map(p => p.nome)).toEqual(['KIT LED H4 6000K']);
    const src = fs.readFileSync(path.join(__dirname, '../lib/contextoComercial.js'), 'utf8');
    for (const campo of ['cpf_cnpj', '.telefone', '.email', '.endereco', '.cidade']) expect(src.includes(campo)).toBe(false);
  });
});

describe('Não interferência no motor determinístico', () => {
  const MOTOR = ['dailyWorklist.js', 'filaOperacional.js', 'canaryCallable.js', 'worklistUniverso.js', 'filaQueueConfig.js', 'oportunidades.js'];
  test('CI-13 contexto não muta entradas (item, perfil, vendas e estado congelados)', () => {
    const v = deepFreeze(vendasRecorrente());
    const perfil = deepFreeze(calcularPerfil360({ clienteMr4Id: '123', gestaoClickId: '123', vendas: v, dataReferencia: HOJE }));
    const item = deepFreeze(it({ opportunityInstanceId: 'cccccccccccccccc' }));
    const estado = deepFreeze({ nextFollowUpAt: HOJE, eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome: 'PEDIU_RETORNO' }] });
    expect(() => C.buildContextoComercial({ item, perfil, perfilAtual: true, vendas: v, grupo: 'followUps', estadoOperacional: estado, dataReferencia: HOJE })).not.toThrow();
    expect(item.opportunityInstanceId).toBe('cccccccccccccccc');
  });

  test('CI-14/15/16/20 ownership, distribuição, limite e multi-vendedor não mudam (decisão não usa o módulo; gerador determinístico)', async () => {
    for (const f of MOTOR) expect(fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8')).not.toMatch(/contextoComercial/);
    const vendas = [];
    for (let i = 0; i < 40; i++) vendas.push(...vendasRecorrente({ n: 5, ultima: new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10), intervalo: 20 }).map(v => ({ ...v, id: v.id + '-' + i, cliente_id: String(66600000 + i) })));
    const sistema = new Map([['s-a', { nome: 'A', modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }], ['s-b', { nome: 'B', modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 5 } }]]);
    const users = new Map([['s-a', { ativo: true, role: 'funcionario' }], ['s-b', { ativo: true, role: 'funcionario' }]]);
    const gerar = () => G.executarGeracaoWorklist({ db: null, now: new Date('2026-09-25T09:00:00Z'), mode: 'DRY_RUN', logger: { log() {} }, lookupNome: async gc => 'Cliente ' + gc, dados: { perfis: [], clientes: [], vendas, estados: new Map(), sistema, users } });
    const a = (await gerar()).doc;
    const b = (await gerar()).doc;
    const semTempo = d => JSON.stringify({ ...d, geradoEm: null });
    expect(semTempo(b)).toBe(semTempo(a));
    expect(a.vendedores['s-a'].novas.length).toBeLessThanOrEqual(10);
    expect(a.vendedores['s-b'].novas.length).toBeLessThanOrEqual(5);
  });

  test('CI-17/18/19 claim, outcome e cooldown idênticos com ou sem contexto calculado', () => {
    const run = () => {
      let e = criarEstadoInicial('GC_NATIVE:123', 'dddddddddddddddd', 'REATIVACAO_120D', '2026-09-25T10:00:00.000Z');
      e = claimOportunidade(e, 'u1', '2026-09-25T10:01:00.000Z');
      const r = registrarOutcome(e, 'u1', 'SEM_INTERESSE_AGORA', '2026-09-25T10:02:00.000Z');
      return { r, cooled: isCooledDown(r, '2026-09-26T00:00:00.000Z') };
    };
    const antes = run();
    deepFreeze(antes.r);
    C.buildContextoComercial({ item: it({ opportunityInstanceId: 'dddddddddddddddd' }), grupo: 'emAtendimento', estadoOperacional: antes.r, dataReferencia: HOJE });
    const depois = run();
    expect(JSON.stringify(depois)).toBe(JSON.stringify(antes));
    expect(antes.cooled).toBe(true);
  });

  test('CI-21 módulo não chama rede, Firestore nem LLM', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/contextoComercial.js'), 'utf8');
    const codigo = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const requires = [...codigo.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    expect(requires).toEqual(['./nomeExibicao']);
    for (const proibido of ['fetch(', 'XMLHttpRequest', 'openai', 'https.', 'firestore(', '.collection(']) expect(codigo.toLowerCase().includes(proibido.toLowerCase())).toBe(false);
  });
});

describe('Sinais seguros', () => {
  test('CI-22 recorrente + atraso quando dias > 2× ciclo; recompra recente não recebe atraso; compra única', () => {
    expect(tipos(ctxDe(vendasRecorrente()))).toEqual(['INATIVO', 'CLIENTE_RECORRENTE', 'ATRASO_CICLO']);
    const recente = ctxDe(vendasRecorrente({ n: 10, ultima: '2026-09-20', intervalo: 7 }), { item: { tipoOportunidade: 'JANELA_DE_RECOMPRA' } });
    expect(tipos(recente)).toEqual(['CLIENTE_RECORRENTE']);
    const unica = ctxDe(vendasRecorrente({ n: 1 }));
    expect(tipos(unica)).toEqual(['INATIVO', 'COMPRA_UNICA']);
    expect(unica.motivo).toBe('Sem comprar há 165 dias. Fez uma única compra até hoje.');
  });

  test('CI-23 tendência oculta em REATIVACAO_120D (queda implícita) e exibida nos demais tipos com perfil do dia', () => {
    expect(ctxDe(vendasRecorrente(), { tendenciaCodigo: 'CAINDO' }).tendencia).toBeUndefined();
    const q = ctxDe(vendasRecorrente(), { item: { tipoOportunidade: 'QUEDA_DE_COMPRAS' }, tendenciaCodigo: 'CAINDO' });
    expect(q.tendencia).toEqual({ codigo: 'CAINDO', label: 'Compras diminuindo' });
    expect(tipos(q)).toContain('COMPRAS_DIMINUINDO');
  });
});
