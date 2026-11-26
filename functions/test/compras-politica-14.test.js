'use strict';
// Compras — Política 1.4 em SOMBRA: motor de alocação do orçamento, gerador, isolamento de escrita e backtest sem futuro. Dados 100 % sintéticos.
const fs = require('fs'), path = require('path');
const fx = require('./fixtures/compras-estoque-f0');
const A = require('../lib/compras/alocacao14');
const S14 = require('../lib/compras/sombra14');
const S13 = require('../lib/compras/sombra13');
const K = require('../lib/compras/calculadora13');
const { fatosDeVenda, somarDias, mapearProduto, diffDias } = require('../lib/compras/canonico');
const { POLITICA_VIGENTE, POLITICAS } = require('../lib/compras/politica');
const RAIZ = path.join(__dirname, '../..');
const ler = f => fs.readFileSync(path.join(RAIZ, f), 'utf8');

/** Item sintético: venda de `v`/dia, estoque zero, custo R$ 10 e preço R$ 20. */
const item = (id, o = {}) => ({ id, codigo: 'C-' + id, nome: 'Item ' + id, categoria: 'Cat', marca: null, fornecedor_id: 'F1', classe: 'A', xyz: 'X', estado: 'ELEGIVEL', estoque: 0,
  transito: { recente: 0, antigo: 0, recente_sem_origem: 0, antigo_sem_origem: 0 }, custo_cents: 1000, preco_cents: 2000, v: 1, v_observada: 1, sd_dia: 1, esporadico: false, novo: false,
  prazo_dias: 10, prazo_desvio: 2, prazo_fonte: 'CONFIG_PRODUTO', minimo_un: 1, multiplo_un: 1, multiplo_observado: 1, nao_comprar: false, crescimento_fator: 1, origem_comprovada: true, origem_motivo: null, ...o });
const dados = (itens, fornecedores = { F1: { nome: 'Fornecedor um' }, F2: { nome: 'Fornecedor dois' } }) => ({ itens, fornecedores });
const qtd = (r, id) => (r.linhas.find(l => l.id === id) || { qtd: 0 }).qtd;
const motivo = (r, id) => r.linhas.find(l => l.id === id).motivo;
const variado = () => Array.from({ length: 40 }, (_, i) => item('P' + String(i).padStart(2, '0'), { classe: ['A', 'B', 'C'][i % 3], xyz: ['X', 'Y', 'Z'][(i >> 1) % 3], v: 0.1 + (i % 7) * 0.6, v_observada: 0.1 + (i % 7) * 0.6, sd_dia: 0.5 + (i % 5),
  custo_cents: 300 + (i % 11) * 450, preco_cents: 900 + (i % 11) * 800 + (i % 4) * 200, estoque: (i * 3) % 17, fornecedor_id: i % 4 === 0 ? 'F2' : 'F1' }));

describe('distribuição de demanda', () => {
  test.each([[3, 3], [3, 30], [0.2, 2], [500, 40000]])('média %p e variância %p: a soma das probabilidades reproduz a média', (mu, v) => {
    const d = A.distribuicao(mu, v);
    expect(d.prefix[d.prefix.length - 1]).toBeCloseTo(mu, 1);
    for (let k = 1; k < d.tail.length; k++) expect(d.tail[k]).toBeLessThanOrEqual(d.tail[k - 1] + 1e-12);
    expect(A.probAoMenos(d, 0)).toBe(1);
    expect(A.probAoMenos(d, d.tail.length + 5)).toBe(0);
  });
  test('Poisson conhecida e quantil', () => {
    const d = A.distribuicao(2, 2);
    expect(A.probAoMenos(d, 1)).toBeCloseTo(1 - Math.exp(-2), 6);
    expect(A.quantil(d, 0.5)).toBe(2);
    expect(A.quantil(d, 0.95)).toBe(5);
  });
  test('sem demanda: nada a vender', () => { expect(A.esperadoAte(A.distribuicao(0, 5), 10)).toBe(0); });
});

describe('configuração', () => {
  test('padrão é válido, em sombra, com cenário conservador para pedidos antigos e compras sem origem', () => {
    const c = A.configurar();
    expect(A.validar(c)).toEqual([]);
    expect(c.status).toBe('SHADOW_NOT_APPROVED');
    expect(c.transito.antigos).toBe('IGNORAR');
    expect(c.origem).toBe('REVISAR');
    expect(c.fator_demanda).toBe(1);
  });
  test('recusa valores fora de faixa e não aceita promover a política', () => {
    for (const x of [{ status: 'APPROVED' }, { orcamento_cents: -1 }, { nivel_servico: 1 }, { cobertura_dias: -3 }, { peso_antecipacao: 2 }, { transito: { antigos: 'X' } }, { origem: 'X' }, { ajustes: { a: 1.5 } }]) expect(() => A.configurar(x)).toThrow(/POLITICA_14_INVALIDA/);
  });
  test('a política vigente continua 1.2 e a 1.4 não entra no registro de políticas', () => {
    expect(POLITICA_VIGENTE.policy_version).toBe('1.2');
    expect(Object.keys(POLITICAS)).toEqual(['1.0', '1.1', '1.2']);
  });
});

describe('alocação do orçamento', () => {
  test('nunca gasta mais que o orçamento; quantidades inteiras e não negativas', () => {
    for (const o of [0, 100, 5000, 50000, 200000, 5000000]) {
      const r = A.simular(dados(variado()), { orcamento_cents: o });
      expect(r.totais.capital_cents).toBeLessThanOrEqual(o);
      expect(r.linhas.every(l => Number.isInteger(l.qtd) && l.qtd >= 0)).toBe(true);
    }
  });
  test('mais dinheiro nunca reduz o atendimento nem a margem preservada; retornos são decrescentes', () => {
    const passos = [0, 100000, 200000, 300000, 400000].map(o => A.simular(dados(variado()), { orcamento_cents: o }).totais);
    for (let i = 1; i < passos.length; i++) {
      expect(passos[i].atendimento_pct).toBeGreaterThanOrEqual(passos[i - 1].atendimento_pct - 1e-9);
      expect(passos[i].margem_preservada_cents).toBeGreaterThanOrEqual(passos[i - 1].margem_preservada_cents);
    }
    const ganho = passos.slice(1).map((p, i) => p.margem_preservada_cents - passos[i].margem_preservada_cents);
    expect(ganho[ganho.length - 1]).toBeLessThan(ganho[0]);
  });
  test('valor por unidade adicional é decrescente (sem custo fixo de ruptura)', () => {
    const cfg = A.configurar(), p = A.preparar(item('a', { v: 2, v_observada: 2, sd_dia: 3 }), cfg);
    let ant = Infinity;
    for (let n = 0; n < p.alvo + 20; n++) { const v = A.valorDoLote(p, n, 1, cfg); expect(v).toBeLessThanOrEqual(ant + 1e-9); ant = v; }
  });
  test('o resultado não depende da ordem de entrada', () => {
    const a = A.simular(dados(variado()), { orcamento_cents: 150000 }), b = A.simular(dados(variado().reverse()), { orcamento_cents: 150000 });
    expect(b.linhas.map(l => [l.id, l.qtd])).toEqual(a.linhas.map(l => [l.id, l.qtd]));
  });
  test('a margem percentual sozinha não manda: item de 90 % que quase não vende perde para o de giro com 29 %', () => {
    const lento = item('lento', { v: 0.002, v_observada: 0.002, sd_dia: 0.02, custo_cents: 1000, preco_cents: 10000, classe: 'C', xyz: 'Z' });   // 90 % de margem
    const giro = item('giro', { v: 3, v_observada: 3, sd_dia: 2, custo_cents: 1000, preco_cents: 1400 });                                          // 29 %
    const r = A.simular(dados([lento, giro]), { orcamento_cents: 10000 });
    expect([qtd(r, 'giro'), qtd(r, 'lento')]).toEqual([10, 0]);
  });
  test('o que decide é o valor ESPERADO por real: mesma margem e custo, a unidade com mais chance de vender entra primeiro', () => {
    const r = A.simular(dados([item('pouco', { v: 0.05, v_observada: 0.05, sd_dia: 0.2 }), item('muito', { v: 2, v_observada: 2, sd_dia: 1.5 })]), { orcamento_cents: 10000 });
    expect([qtd(r, 'muito'), qtd(r, 'pouco')]).toEqual([10, 0]);
  });
  test('sem teto compra até o alvo, nunca além (salvo embalagem)', () => {
    const r = A.simular(dados(variado()), {});
    for (const l of r.linhas) if (l.qtd > 0) expect(l.posicao + l.qtd).toBeLessThanOrEqual(l.alvo + l.multiplo + l.minimo);
    expect(r.totais.capital_necessario_cents).toBe(r.totais.capital_cents);
  });
  test('mínimo e múltiplo são respeitados mesmo com orçamento apertado', () => {
    const itens = [item('m', { minimo_un: 24, multiplo_un: 12, v: 3, v_observada: 3 })];
    expect(qtd(A.simular(dados(itens), { orcamento_cents: 23000 }), 'm')).toBe(0);
    const r = A.simular(dados(itens), { orcamento_cents: 37000 });
    expect(qtd(r, 'm')).toBe(36);
    for (const o of [24000, 50000, 90000]) { const q = qtd(A.simular(dados(itens), { orcamento_cents: o }), 'm'); expect(q % 12).toBe(0); expect(q).toBeGreaterThanOrEqual(24); }
  });
  test('motivos explícitos para quem não entra: orçamento, estoque, origem, margem, falta longa, sem custo', () => {
    const itens = [item('ok'), item('cheio', { estoque: 500 }), item('semorigem', { origem_comprovada: false, origem_motivo: 'compra sem fornecedor' }), item('prejuizo', { preco_cents: 900 }),
      item('revisar', { estado: 'REVISAR_RUPTURA_LONGA' }), item('semcusto', { custo_cents: null }), item('parado', { v: 0, v_observada: 0 }), item('nao', { nao_comprar: true })];
    const r = A.simular(dados(itens), { orcamento_cents: 5000 });
    expect(motivo(r, 'ok')).toBe('PARCIAL_POR_ORCAMENTO');
    expect(r.linhas.find(l => l.id === 'ok').falta_para_o_alvo_cents).toBeGreaterThan(0);
    expect(r.nao_contemplados.map(l => l.id)).toEqual(['ok']);
    expect([motivo(r, 'cheio'), motivo(r, 'semorigem'), motivo(r, 'prejuizo'), motivo(r, 'revisar'), motivo(r, 'semcusto'), motivo(r, 'parado'), motivo(r, 'nao')])
      .toEqual(['ESTOQUE_SUFICIENTE', 'ORIGEM_NAO_COMPROVADA', 'MARGEM_NAO_POSITIVA', 'REVISAR_RUPTURA_LONGA', 'SEM_CUSTO', 'SEM_DEMANDA', 'MARCADO_NAO_COMPRAR']);
    const inc = A.simular(dados(itens), { origem: 'INCLUIR' });
    expect(qtd(inc, 'semorigem')).toBeGreaterThan(0);
  });
  test('com gatilho, quem está acima do ponto de reposição espera; sem gatilho completa até o alvo', () => {
    const cfg = A.configurar(), p = A.preparar(item('g'), cfg), i = [item('g', { estoque: p.ponto })];
    expect(motivo(A.simular(dados(i), { gatilho: 'PONTO' }), 'g')).toBe('ACIMA_DO_PONTO');
    expect(qtd(A.simular(dados(i), {}), 'g')).toBeGreaterThan(0);
  });
  test('produto prioritário entra primeiro e supera revisão; excluído nunca entra', () => {
    const itens = [item('caro', { v: 5, v_observada: 5, preco_cents: 6000 }), item('prio', { estado: 'REVISAR_RUPTURA_LONGA', v: 0.5, v_observada: 0.5 })];
    const sem = A.simular(dados(itens), { orcamento_cents: 8000 });
    expect(qtd(sem, 'prio')).toBe(0);
    const com = A.simular(dados(itens), { orcamento_cents: 8000, prioritarios: ['prio'] });
    expect(qtd(com, 'prio')).toBeGreaterThan(0);
    expect(qtd(A.simular(dados(itens), { excluidos: ['caro'] }), 'caro')).toBe(0);
  });
  test('filtros por fornecedor, categoria, marca e curva restringem compra e indicadores', () => {
    const itens = [item('a', { fornecedor_id: 'F1', categoria: 'X', marca: 'M1', classe: 'A' }), item('b', { fornecedor_id: 'F2', categoria: 'Y', marca: 'M2', classe: 'B' })];
    for (const f of [{ fornecedores: ['F2'] }, { categorias: ['Y'] }, { marcas: ['M2'] }, { curvas: ['B'] }]) {
      const r = A.simular(dados(itens), { filtros: f });
      expect(r.linhas.map(l => l.id)).toEqual(['b']);
      expect(r.totais.produtos_no_escopo).toBe(1);
    }
  });
  test('pedidos antigos: ignorar (padrão), receber parcial ou receber tudo mudam a posição', () => {
    const i = [item('t', { transito: { recente: 2, antigo: 40, recente_sem_origem: 3, antigo_sem_origem: 10 } })];
    const pos = x => A.simular(dados(i), x).linhas[0].posicao;
    expect(pos({})).toBe(2);
    expect(pos({ transito: { antigos: 'PARCIAL' } })).toBe(22);
    expect(pos({ transito: { antigos: 'PARCIAL', fracao_parcial: 0.25 } })).toBe(12);
    expect(pos({ transito: { antigos: 'TUDO' } })).toBe(42);
    expect(pos({ transito: { antigos: 'TUDO' }, origem: 'INCLUIR' })).toBe(55);
  });
  test('estoque negativo não gera unidades extras', () => {
    expect(A.simular(dados([item('n', { estoque: -30 })]), {}).linhas[0].qtd).toBe(A.simular(dados([item('n', { estoque: 0 })]), {}).linhas[0].qtd);
  });
  test('sinal de crescimento é limitado ao teto e fator manual neutro por padrão', () => {
    const cfg = A.configurar();
    expect(A.preparar(item('g', { crescimento_fator: 3 }), cfg).cresc).toBeCloseTo(1.1, 9);
    expect(A.preparar(item('g', { crescimento_fator: 1.05 }), A.configurar({ crescimento: { usar: false } })).cresc).toBe(1);
    expect(A.preparar(item('g'), A.configurar({ fator_demanda: 2 })).v).toBeCloseTo(2, 9);
  });
});

describe('pedido mínimo por fornecedor', () => {
  const itens = () => [item('a', { v: 4, v_observada: 4 }), item('b', { fornecedor_id: 'F2', v: 0.3, v_observada: 0.3 })];
  const forn = min => ({ F1: { nome: 'Um' }, F2: { nome: 'Dois', minimo_cents: min } });
  test('nenhum fornecedor fica com pedido abaixo do mínimo', () => {
    for (const min of [5000, 20000, 60000, 5000000]) {
      const r = A.simular(dados(itens(), forn(min)), { orcamento_cents: 150000 });
      const f2 = r.fornecedores.find(f => f.fornecedor_id === 'F2');
      if (f2 && f2.unidades > 0) expect(f2.valor_cents).toBeGreaterThanOrEqual(min);
      expect(r.alertas).not.toContain('FORNECEDOR_ABAIXO_DO_MINIMO');
      expect(r.totais.capital_cents).toBeLessThanOrEqual(150000);
    }
  });
  test('mínimo impossível: o fornecedor fica de fora e o dinheiro vai para os demais', () => {
    const r = A.simular(dados(itens(), forn(5000000)), { orcamento_cents: 150000 });
    expect(qtd(r, 'b')).toBe(0);
    expect(motivo(r, 'b')).toBe('FORNECEDOR_ABAIXO_DO_MINIMO');
    expect(r.fornecedores.find(f => f.fornecedor_id === 'F2').situacao).toBe('FORA_POR_NAO_ATINGIR_O_MINIMO');
  });
  test('mínimo informado na tela prevalece; modo NENHUM desliga; histórico é premissa opcional', () => {
    const cfg = A.configurar({ minimo_fornecedor: { por_fornecedor: { F2: { cents: 100 } } } });
    expect(A.minimoDoFornecedor('F2', cfg, forn(999999))).toEqual({ cents: 100, un: 0, fonte: 'INFORMADO' });
    expect(A.minimoDoFornecedor('F2', A.configurar({ minimo_fornecedor: { modo: 'NENHUM' } }), forn(999999))).toBeNull();
    expect(A.minimoDoFornecedor('F2', A.configurar(), { F2: { pedido_p10_cents: 700 } })).toBeNull();
    expect(A.minimoDoFornecedor('F2', A.configurar({ minimo_fornecedor: { modo: 'HISTORICO_P10' } }), { F2: { pedido_p10_cents: 700 } })).toEqual({ cents: 700, un: 0, fonte: 'PREMISSA_HISTORICO' });
  });
});

describe('ajuste manual e saídas', () => {
  test('ajuste recalcula valores, indicadores e avisa quando passa do orçamento ou do mínimo', () => {
    const base = A.simular(dados(variado()), { orcamento_cents: 100000 });
    const alvo = base.linhas.find(l => l.qtd > 0);
    const mais = A.simular(dados(variado()), { orcamento_cents: 100000, ajustes: { [alvo.id]: alvo.qtd + 500 } });
    const l = mais.linhas.find(x => x.id === alvo.id);
    expect([l.qtd, l.qtd_recomendada, l.ajustado]).toEqual([alvo.qtd + 500, alvo.qtd, true]);
    expect(mais.totais.capital_cents).toBe(base.totais.capital_cents + 500 * alvo.custo_cents);
    expect(mais.fornecedores.reduce((s, f) => s + f.valor_cents, 0)).toBe(mais.totais.capital_cents);
    expect(mais.alertas).toContain('AJUSTES_ULTRAPASSAM_O_ORCAMENTO');
    const zero = A.simular(dados(variado()), { orcamento_cents: 100000, ajustes: { [alvo.id]: 0 } });
    expect(zero.totais.capital_cents).toBe(base.totais.capital_cents - alvo.valor_cents);
    expect(zero.linhas.find(x => x.id === alvo.id).justificativa.join(' ')).toMatch(/Ajuste manual/);
  });
  test('totais batem com as linhas; rótulo de simulação; justificativa em linguagem de negócio', () => {
    const r = A.simular(dados(variado()), { orcamento_cents: 100000 });
    expect(r.rotulo).toBe('SIMULAÇÃO — não é recomendação operacional; nenhum pedido é criado');
    expect(r.linhas.reduce((s, l) => s + l.valor_cents, 0)).toBe(r.totais.capital_cents);
    const l = r.linhas.find(x => x.qtd > 0);
    expect(l.justificativa.join(' ')).toMatch(/Prazo .*Posição .*Chance de faltar/);
    expect(l.cobertura_depois).toBeGreaterThan(l.cobertura_antes);
    expect(l.risco_depois).toBeLessThanOrEqual(l.risco_antes);
  });
  test('CSV neutraliza texto que começa como fórmula e omite nomes quando pedido', () => {
    const r = A.simular(dados([item('x', { nome: '=cmd()', codigo: '+1+1' })]), {});
    const t = A.csv(r.linhas);
    expect(t).toContain("'=cmd()");
    expect(t).toContain("'+1+1");
    expect(A.csv(r.linhas, { comNomes: false })).not.toContain('cmd()');
  });
});

// ── Gerador ────────────────────────────────────────────────────────────────────────────────────────────────────
function entradas() {
  const produtos = ['PX-1', 'PX-2', 'PX-3'].map(id => mapearProduto(fx.produto(id, { estoque: 2, cadastrado_em: '2024-01-01 10:00:00', grupo_id: 'G1' })));
  const vendas = ['PX-1', 'PX-2', 'PX-3'].flatMap(id => fx.serie(id, { de: 300, passo: 3, qtd: 2 }));
  const compras = [
    fx.compra(fx.dia(120), [['PX-1', 50]], { fornecedor_id: 'FX-1' }), fx.compra(fx.dia(60), [['PX-2', 50]], { fornecedor_id: '2026204' }),
    fx.compra(fx.dia(70), [['PX-3', 20]], { fornecedor_id: 'FX-1' }), fx.compra(fx.dia(40), [['PX-3', 40]], { fornecedor_id: 'FX-1' }), fx.compra(fx.dia(20), [['PX-3', 60]], { fornecedor_id: 'FX-1' }),
    fx.compra(fx.dia(200), [['PX-1', 7]], { fornecedor_id: 'FX-1', situacao: 'A receber' }), fx.compra(fx.dia(5), [['PX-1', 3]], { fornecedor_id: 'FX-1', situacao: 'Em aberto' }),
    fx.compra(fx.dia(5), [['PX-1', 9]], { fornecedor_id: '', situacao: 'A receber' }),
  ].map(c => c.Compra);
  return { hoje: fx.HOJE, geradoEm: null, produtos: produtos.map(p => ({ ...p, group_id: 'G1' })), vendas, compras, snapshots: {}, sugestaoGravada12: new Map(),
    view: { linhas: [{ id: 'PX-1', nome: 'Nome fictício 1', grupo: 'Categoria fictícia' }] }, fornecedores: { nomes: { fornecedores: { 'FX-1': { nome: 'Fornecedor fictício' } } }, unidades: null } };
}
describe('gerador da sombra 1.4', () => {
  const comLista = () => { const e = entradas(); return { e, config: { origem: { compras_sem_origem: [e.compras[1].id] } } }; };   // a compra do PX-2 sem prova
  const { e: ent, config } = comLista(), r = S14.calcular(ent, { config });
  const i = id => r.itens.find(x => x.id === id);
  test('origem não comprovada: a compra listada marca o produto e não alimenta fornecedor nem prazo', () => {
    expect(i('PX-1').origem_comprovada).toBe(true);
    expect(i('PX-2').origem_comprovada).toBe(false);
    expect(i('PX-2').origem_motivo).toMatch(/sem prova/);
    expect(i('PX-2').fornecedor_id).toBeNull();
    expect(S14.origemDaCompra({ id: '1', fornecedor_id: null }, S14.GERACAO)).toBe('SEM_FORNECEDOR');
    expect(S14.origemDaCompra({ id: '9', fornecedor_id: 'FX-1' }, { origem: { ...S14.GERACAO.origem, fornecedores_sem_origem: ['FX-1'] } })).toBe('FORNECEDOR_MARCADO');
  });
  test('sem lista informada nada é presumido: só compra sem fornecedor fica sem origem', () => {
    const livre = S14.calcular(entradas());
    expect(livre.itens.every(x => x.origem_comprovada)).toBe(true);
    expect(livre.resumo.compras_sem_origem).toBe(1);
  });
  test('lista de origem vem do relatório de confiabilidade (só o que não é SIM)', () => {
    const csv = '\uFEFFcompra_id;situacao;usar_em_decisao_automatica\n1;Confirmada;SIM\n2;Confirmada;NAO\n3;Em aberto;\n';
    expect(S14.lerOrigemCsv(csv)).toEqual(['2', '3']);
    expect(() => S14.lerOrigemCsv('a;b\n1;2')).toThrow(/ORIGEM_CSV_SEM_COLUNAS/);
  });
  test('a caminho separado em recente, antigo e sem origem', () => {
    expect(i('PX-1').transito).toEqual({ recente: 3, antigo: 7, recente_sem_origem: 9, antigo_sem_origem: 0 });
  });
  test('nome, categoria pelo grupo, nome do fornecedor, múltiplo observado e marca não inventada', () => {
    expect(i('PX-1').nome).toBe('Nome fictício 1');
    expect(i('PX-3').categoria).toBe('Categoria fictícia');
    expect(i('PX-3').multiplo_observado).toBe(20);
    expect(i('PX-3').marca).toBeNull();
    expect(r.fornecedores['FX-1'].nome).toBe('Fornecedor fictício');
    expect(r.fornecedores['FX-1'].minimo_cents).toBeNull();
    const c = S14.calcular(entradas(), { config: { marcas: { 'PX-3': 'Marca T' }, fornecedores: { 'FX-1': { minimo_cents: 12345 } } } });
    expect(c.itens.find(x => x.id === 'PX-3').marca).toBe('Marca T');
    expect(c.fornecedores['FX-1'].minimo_cents).toBe(12345);
  });
  test('documentos passam na verificação do Firestore e reconstroem os itens', () => {
    const docs = S14.documentos(r, new Date('2026-09-28T12:00:00Z'));
    expect(docs.map(d => d[0])).toEqual(['bloco_000', 'meta']);
    expect(docs.every(d => S14.RE_DOC.test(d[0]))).toBe(true);
    expect(JSON.parse(docs[0][1].itens_json)).toEqual(r.itens);
    expect(docs[1][1].status).toBe('SOMBRA_NAO_APROVADA');
    expect(JSON.stringify(docs)).not.toMatch(/cliente_id|cpf|cnpj/i);
  });
  test('persistir escreve SOMENTE em compras_sombra_14 e apaga blocos excedentes', async () => {
    const ops = [];
    const db = { collection: c => ({ doc: id => ({ c, id, get: async () => ({ data: () => ({ blocos: 3 }) }) }) }), batch: () => ({ set: ref => ops.push(['set', ref.c, ref.id]), delete: ref => ops.push(['delete', ref.c, ref.id]), commit: async () => {} }) };
    await S14.persistir(db, r);
    expect(new Set(ops.map(o => o[1]))).toEqual(new Set(['compras_sombra_14']));
    expect(ops.filter(o => o[0] === 'delete').map(o => o[2])).toEqual(['bloco_001', 'bloco_002']);
  });
  test('o comando recusa gravar sem confirmação ou a partir de cópia local', async () => {
    const { principal } = require('../scripts/compras_sombra_14');
    await expect(principal(['--gravar'])).rejects.toThrow(/GRAVACAO_EXIGE/);
    await expect(principal(['--gravar', '--confirmo=compras_sombra_14', '--de-arquivo', 'x'])).rejects.toThrow(/COPIA_LOCAL/);
  });
});

describe('isolamento e cópia do navegador', () => {
  test('o arquivo do navegador é idêntico ao do servidor', () => { expect(ler('js/compras-alocacao14.js')).toBe(ler('functions/lib/compras/alocacao14.js')); });
  test('o motor é puro: sem require, rede, relógio ou sorteio', () => {
    expect(ler('functions/lib/compras/alocacao14.js')).not.toMatch(/require\(|fetch\(|Date\.now|new Date|Math\.random|XMLHttpRequest|localStorage/);
  });
  test('nenhum módulo de produção carrega a 1.4', () => {
    const arquivos = ['index.js', ...fs.readdirSync(path.join(RAIZ, 'functions/lib/compras')).filter(f => !/1[34]/.test(f)).map(f => 'lib/compras/' + f)];
    for (const f of arquivos) expect([f, /alocacao14|sombra14|compras_sombra_14/.test(ler('functions/' + f))]).toEqual([f, false]);
  });
  test('a sombra 1.4 não tem destino de escrita fora da própria coleção', () => {
    const src = ler('functions/lib/compras/sombra14.js');
    expect(src).not.toMatch(/collection\(['"]compras_n0[^'"]*['"]\)\.doc\([^)]*\)\.(set|update|delete)/);
    expect(S14.COLECAO).toBe('compras_sombra_14');
  });
});

describe('simulador (tela): só leitura, só gestão, rótulo visível, emulador só em localhost', () => {
  const html = ler('modulos/compras-simulador14.html');
  test('nenhuma API de escrita nem função de servidor', () => {
    expect(html).not.toMatch(/setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction|httpsCallable|firebase-functions|XMLHttpRequest|sendBeacon|fetch\(/);
    const colecoes = [...html.matchAll(/doc\(db,\s*'([a-z_0-9]+)'/g)].map(m => m[1]);
    expect([...new Set(colecoes)].sort()).toEqual(['compras_sombra_14', 'sistema_usuarios', 'users']);
  });
  test('rótulo de simulação visível e módulo compartilhado', () => {
    expect(html).toContain('SIMULAÇÃO — não é recomendação operacional; nenhum pedido é criado');
    expect(html).toContain('<script src="../js/compras-alocacao14.js"></script>');
  });
  test('emulador somente em localhost, com projeto de demonstração e sem a porta de outro servidor', () => {
    expect(html).toMatch(/const LOCAL = location\.hostname === 'localhost' \|\| location\.hostname === '127\.0\.0\.1';/);
    expect(html).toContain("projectId: 'demo-mr4-sim14'");
    expect(html).not.toMatch(/\b(8080|9099)\b/);
  });
  test('acesso conferido na tela além das Rules', () => { expect(html).toMatch(/role !== 'gestor'/); });
});

// ── Backtest sem vazamento de futuro ───────────────────────────────────────────────────────────────────────────
describe('backtest: o que foi vendido depois não muda a decisão de antes', () => {
  const B14 = require('../scripts/compras_backtest_14');
  const INICIO = '2022-03-01', FIM = '2026-11-25', CORTE = '2026-06-01';
  const monta = extra => {
    const produtos = ['PX-1', 'PX-2'].map(id => ({ ...mapearProduto(fx.produto(id, { estoque: 30, cadastrado_em: '2024-01-01 10:00:00' })), current_stock: 30 }));
    const vendas = [];
    for (let d = '2025-01-02'; d <= FIM; d = somarDias(d, 3)) vendas.push(fx.venda(d, [['PX-1', 3], ['PX-2', 1]]));
    vendas.push(...extra);
    const compras = [fx.compra('2025-03-01', [['PX-1', 50], ['PX-2', 20]]).Compra];
    const fatosVenda = vendas.flatMap(fatosDeVenda);
    const series = K.montarSeries({ produtos, fatosVenda, comprasBrutas: compras, snapshots: { [FIM]: { saldos: { 'PX-1': 30, 'PX-2': 30 } } }, inicio: INICIO, hoje: FIM });
    return B14.montarDe({ ent: { compras }, produtos, fatosVenda, series, empiricos: [7, 14, 21] });
  };
  test('as entradas de cada revisão anterior ao corte são idênticas', () => {
    const a = monta([]), b = monta([fx.venda(somarDias(CORTE, 10), [['PX-1', 900], ['PX-2', 700]], { id: 'FUTURA' })]);
    const antes = a.bt.revisoes.filter(t => diffDias(INICIO, CORTE) >= t);
    expect(antes.length).toBeGreaterThan(15);
    const limpar = x => x.map(({ ...i }) => i);
    // o saldo anterior a 25/11 é reconstruído de trás para frente nos dados sintéticos; a demanda e a classe não podem mudar
    for (const t of antes) {
      const chaves = ['v', 'v_observada', 'sd_dia', 'classe', 'xyz', 'prazo_dias', 'preco_cents', 'crescimento_fator'];
      const so = m => limpar(m.bt.itens14.get(t)).map(i => chaves.map(k => i[k]));
      expect(so(b)).toEqual(so(a));
    }
  });
  test('fronteira eficiente: ignora pontos piores e a interpolação no mesmo capital nunca extrapola', () => {
    const pts = [{ capital_medio: 100, atendido_pct: 50 }, { capital_medio: 200, atendido_pct: 70 }, { capital_medio: 150, atendido_pct: 40 }, { capital_medio: 140, atendido_pct: 51 }];
    expect(B14.fronteira(pts)).toEqual([[100, 50], [200, 70]]);
    expect(B14.noCapital(pts, 150)).toBe(60);
    expect(B14.noCapital(pts.map(p => ({ ...p, perda: 100 - p.atendido_pct })), 150, 'perda', false)).toBe(40);
    expect(B14.noCapital(pts, 99)).toBeNull();
    expect(B14.noCapital(pts, 201)).toBeNull();
  });
  test('indicadores no mesmo capital vêm da mesma combinação de pontos', () => {
    const pts = [{ capital_medio: 100, atendido_pct: 50, linhas: 10 }, { capital_medio: 140, atendido_pct: 51, linhas: 999 }, { capital_medio: 200, atendido_pct: 70, linhas: 30 }];
    const m = B14.misturaNoCapital(pts, 150);
    expect([m('atendido_pct'), m('linhas')]).toEqual([60, 20]);
    expect(B14.misturaNoCapital(pts, 201)).toBeNull();
  });
  test('rateio simples divide o dinheiro entre todos sem passar do teto nem pedir mais que o necessário', () => {
    const l = B14.rateado([{ k: 1, q: 10, custo: 5, grupo: 4, cobertura: 1 }, { k: 2, q: 10, custo: 5, grupo: 1, cobertura: 0 }], 60);
    expect(l.map(o => [o.k, o.q])).toEqual([[1, 6], [2, 6]]);
    expect(B14.rateado([{ k: 1, q: 3, custo: 5, grupo: 1, cobertura: 0 }], 1000)[0].q).toBe(3);
  });
  test('retornos decrescentes: primeiro capital a partir do qual o ganho fica sempre abaixo do limiar', () => {
    expect(B14.retornoDecrescente([[200, 50], [210, 55], [220, 59], [230, 62], [240, 64], [250, 65], [260, 65.3], [270, 65.6], [280, 65.8], [290, 66], [300, 66.1]].map(([c, v]) => ({ capital_medio: c * 1000, atendido_pct: v }))).capital).toBe(250000);
  });
  test('sem dinheiro para tudo, as regras simples atendem ruptura da curva A primeiro e não passam do teto', () => {
    const l = B14.porUrgencia([{ k: 1, q: 10, custo: 5, grupo: 4, cobertura: 1 }, { k: 2, q: 10, custo: 5, grupo: 1, cobertura: 0 }], 60);
    expect(l.map(o => [o.k, o.q])).toEqual([[2, 10], [1, 2]]);
  });
});
