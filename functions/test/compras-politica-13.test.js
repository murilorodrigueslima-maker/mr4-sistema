'use strict';
// Compras — Política 1.3 em SOMBRA (calculadora, comparação 1.2 × 1.3, isolamento de escrita, sem vazamento de futuro). Dados 100 % sintéticos.
const fs = require('fs'), path = require('path');
const fx = require('./fixtures/compras-estoque-f0');
const { fatosDeVenda, fatosDeCompra, somarDias, mapearProduto } = require('../lib/compras/canonico');
const { POLITICA_VIGENTE, POLITICAS } = require('../lib/compras/politica');
const { POLITICA_1_3_SOMBRA: P13, comConfig, validarPolitica13 } = require('../lib/compras/politica13');
const K = require('../lib/compras/calculadora13');
const S = require('../lib/compras/sombra13');

const HOJE = fx.HOJE;
const dia = fx.dia;

/** Produto com `qtd` un a cada `passo` dias nos últimos `de` dias; estoque atual e saldo diário informados por faixa. */
function mundo({ estoque = 5, passo = 2, qtd = 2, de = 200, semEstoque = null, compras = [], vendas = null } = {}) {
  const p = mapearProduto(fx.produto('PX-1', { estoque, cadastrado_em: '2024-01-01 10:00:00' }));
  const brutas = vendas || fx.serie('PX-1', { de, passo, qtd }).filter(v => !semEstoque || !(v.data >= dia(semEstoque[0]) && v.data <= dia(semEstoque[1])));
  const snapshots = {};
  for (let n = 400; n >= 0; n--) snapshots[dia(n)] = { saldos: { 'PX-1': semEstoque && n <= semEstoque[0] && n >= semEstoque[1] ? 0 : Math.max(1, estoque) } };
  const comprasBrutas = compras.map(c => c.Compra || c);
  const series = K.montarSeries({ produtos: [p], fatosVenda: brutas.flatMap(fatosDeVenda), comprasBrutas, snapshots, inicio: dia(400), hoje: HOJE });
  return { p, series, s: series.porId.get('PX-1'), t: series.n - 1, comprasBrutas };
}
const base = (m, cfg = P13) => { const f = K.caracteristicas(m.s, m.series, m.t, cfg); return { f, previsao: K.prever(f, cfg), variab: K.variabilidade(f, cfg) }; };
const PRAZO = { dias: 10, desvio_dias: 2, fonte: 'CONFIG_PRODUTO', n: null, fornecedor_id: null };
const decide = (b, extra = {}, cfg = P13) => K.decidir({ id: 'PX-1', ...b, classe: 'A', prazo: PRAZO, estoque: 5, transito: 0, cfg, ...extra });

describe('isolamento: a 1.3 não toca a produção', () => {
  test('a política vigente continua 1.2 e a 1.3 não está no registro de políticas', () => {
    expect(POLITICA_VIGENTE.policy_version).toBe('1.2');
    expect(Object.keys(POLITICAS)).toEqual(['1.0', '1.1', '1.2']);
    expect(P13.status).toBe('SHADOW_NOT_APPROVED');
  });
  test('nenhum módulo de produção carrega a 1.3 nem o index a exporta', () => {
    const raiz = path.join(__dirname, '..');
    const arquivos = ['index.js', ...fs.readdirSync(path.join(raiz, 'lib/compras')).filter(f => !/13/.test(f)).map(f => 'lib/compras/' + f)];
    for (const f of arquivos) expect([f, /politica13|calculadora13|sombra13|compras_sombra_13/.test(fs.readFileSync(path.join(raiz, f), 'utf8'))]).toEqual([f, false]);
  });
  test('a sombra nunca referencia a visão ou os documentos da produção como destino de escrita', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/compras/sombra13.js'), 'utf8');
    expect(src).not.toMatch(/collection\(['"]compras_n0[^'"]*['"]\)\.doc\([^)]*\)\.(set|update|delete)/);
    expect(src).not.toMatch(/compras_n0_view/);
    expect(S.COLECAO).toBe('compras_sombra_13');
  });
});

describe('configuração', () => {
  test('padrão é válido; premissas de prazo e embalagem explícitas; fatores neutros e sem teto de capital', () => {
    expect(validarPolitica13(P13)).toEqual([]);
    expect(P13.fator_demanda).toEqual({ global: 1, por_mes: {}, por_produto: {} });
    expect(P13.capital.teto_compra_cents).toBeNull();
    expect(P13.embalagem.sem_cadastro).toEqual({ minimo_un: 1, multiplo_un: 1 });
  });
  test('decisões do dono são mescladas sem alterar a base; configuração inválida é recusada', () => {
    const c = comConfig(P13, { produtos: { 'PX-1': { multiplo_un: 12 } }, ciclo_dias: { A: 45 } });
    expect(c.ciclo_dias).toEqual({ A: 45, B: 21, C: 15 });
    expect(P13.ciclo_dias.A).toBe(30);
    expect(() => comConfig(P13, { status: 'APPROVED' })).toThrow(/POLITICA_13_INVALIDA/);
    expect(() => comConfig(P13, { nivel_servico: { AX: 1 } })).toThrow(/nivel_servico/);
    expect(() => comConfig(P13, { produtos: { x: { multiplo_un: 0 } } })).toThrow(/multiplo_un/);
  });
});

describe('demanda reprimida (cautela)', () => {
  test('sem falta de estoque a velocidade é a observada (igual à 1.2)', () => {
    const b = base(mundo());
    expect(b.previsao.fonte).toBe('OBSERVADA');
    expect(b.previsao.v).toBeCloseTo(b.f.v_ingenua, 9);
  });
  test('30 dias sem estoque: corrige pelos dias disponíveis, sem passar do teto', () => {
    const b = base(mundo({ semEstoque: [40, 10] }));
    expect(b.previsao.dias_sem_estoque).toBeGreaterThanOrEqual(25);
    expect(b.previsao.v).toBeGreaterThan(b.f.v_ingenua * 1.3);
    expect(b.previsao.v).toBeLessThanOrEqual(2 * Math.max(b.f.v_ingenua, b.f.v_longa_ingenua) + 1e-9);
  });
  test('poucos dias com venda: não extrapola', () => {
    const m = mundo({ vendas: [fx.venda(dia(80), [['PX-1', 50]]), fx.venda(dia(70), [['PX-1', 50]])], semEstoque: [60, 0], estoque: 0 });
    const b = base(m);
    expect(b.previsao.v).toBeCloseTo(b.f.v_ingenua, 9);
    expect(b.previsao.flags).toContain('DEMANDA_REPRIMIDA_SEM_BASE_PARA_CORRIGIR');
  });
  test('peso 0 desliga o efeito', () => {
    const cfg = comConfig(P13, { demanda: { censura: { peso: 0 } } });
    const b = base(mundo({ semEstoque: [40, 10] }), cfg);
    expect(b.previsao.v).toBeCloseTo(b.f.v_ingenua, 9);
  });
});

describe('sem vazamento de futuro', () => {
  test('vendas, compras e modificações posteriores à data não mudam o cálculo naquela data', () => {
    const passado = [fx.compra(dia(100), [['PX-1', 10]])];
    const futuro = fx.compra(dia(20), [['PX-1', 500]]);
    futuro.Compra.modificado_em = dia(5) + ' 10:00:00';
    const A = mundo({ compras: passado }), B = mundo({ compras: [...passado, futuro] });
    B.s.dem[B.t - 5] += 999;                                        // venda "do futuro"
    const t = A.t - 30;
    expect(K.caracteristicas(B.s, B.series, t, P13)).toEqual(K.caracteristicas(A.s, A.series, t, P13));
    const ref = A.series.datas[t];
    expect(K.estimarPrazos(B.comprasBrutas, ref, P13).geral).toEqual(K.estimarPrazos(A.comprasBrutas, ref, P13).geral);
  });
});

describe('prazo de reposição', () => {
  const compras = (forn, atrasos) => atrasos.map((d, i) => { const c = fx.compra(dia(100 + i), [['PX-1', 1]], { fornecedor_id: forn }); c.Compra.modificado_em = somarDias(dia(100 + i), d) + ' 10:00:00'; return c.Compra; });
  test('proxy do fornecedor com amostra; mesmo dia e acima de 90 dias ignorados; incerteza limitada a 50 % do prazo', () => {
    const e = K.estimarPrazos(compras('FX-1', [0, 0, 8, 10, 10, 12, 60, 95]), HOJE, P13);
    expect(e.fornecedor.get('FX-1').n).toBe(5);
    const p = K.prazoDoProduto('PX-1', e, P13);
    expect(p).toMatchObject({ fonte: 'PROXY_FORNECEDOR', dias: 10, desvio_dias: 5 });
  });
  test('hierarquia: configuração do produto > fornecedor > importado > proxy > premissa', () => {
    const e = K.estimarPrazos(compras('FX-1', [8, 10, 10, 12, 14]), HOJE, P13);
    expect(K.prazoDoProduto('PX-1', e, comConfig(P13, { produtos: { 'PX-1': { prazo_dias: 33 } } }))).toMatchObject({ fonte: 'CONFIG_PRODUTO', dias: 33 });
    expect(K.prazoDoProduto('PX-1', e, comConfig(P13, { prazo: { fornecedores: { 'FX-1': { dias: 21 } } } }))).toMatchObject({ fonte: 'CONFIG_FORNECEDOR', dias: 21 });
    expect(K.prazoDoProduto('PX-1', e, comConfig(P13, { prazo: { fornecedores: { 'FX-1': { importado: true } } } }))).toMatchObject({ fonte: 'PREMISSA_IMPORTADO', dias: 60 });
    expect(K.prazoDoProduto('PX-1', K.estimarPrazos([], HOJE, P13), P13)).toMatchObject({ fonte: 'PREMISSA_SEM_DADO', dias: 14 });
  });
  test('confiabilidade baixa do fornecedor aumenta a incerteza do prazo', () => {
    const e = K.estimarPrazos(compras('FX-1', [10, 10, 10, 10, 10]), HOJE, P13);
    const sem = K.prazoDoProduto('PX-1', e, P13).desvio_dias;
    const com = K.prazoDoProduto('PX-1', e, comConfig(P13, { prazo: { fornecedores: { 'FX-1': { confiabilidade: 0.5 } } } })).desvio_dias;
    expect(com).toBeCloseTo(Math.sqrt(sem ** 2 + 25), 6);
  });
  test('pedido em trânsito recente conta; antigo é sinalizado como resíduo', () => {
    const r = fx.compra(dia(10), [['PX-1', 7]], { situacao: 'A receber' }).Compra, v = fx.compra(dia(200), [['PX-1', 9]], { situacao: 'Em aberto' }).Compra;
    expect(K.emTransito([r, v], HOJE, P13).get('PX-1')).toEqual({ un: 7, residuo_antigo_un: 9 });
  });
});

describe('quantidade e justificativa', () => {
  const m = mundo({ semEstoque: null });
  const b = base(m);
  test('parcelas fecham: ponto = demanda no prazo + segurança; alvo = ponto + ciclo; pedido = alvo − posição', () => {
    const d = decide(b);
    expect(d.ponto_reposicao).toBeCloseTo(d.demanda_no_prazo + d.seguranca, 9);
    expect(d.estoque_alvo).toBeCloseTo(d.ponto_reposicao + d.ciclo_un, 9);
    expect(d.pedir).toBe(true);
    expect(d.qtd_sugerida).toBe(Math.ceil(d.estoque_alvo - d.posicao - 1e-9));
    expect(d.demanda_no_prazo).toBeCloseTo(d.velocidade * 17, 9);
  });
  test('acima do ponto de reposição não pede; trânsito conta na posição; estoque negativo não vira necessidade extra', () => {
    expect(decide(b, { estoque: 500 }).qtd_sugerida).toBe(0);
    expect(decide(b, { transito: 500 }).qtd_sugerida).toBe(0);
    expect(decide(b, { estoque: -20 }).qtd_sugerida).toBe(decide(b, { estoque: 0 }).qtd_sugerida);
  });
  test('prazo maior e nível maior nunca reduzem a quantidade', () => {
    const q = x => decide(b, x).qtd_sugerida;
    expect(q({ prazo: { ...PRAZO, dias: 30 } })).toBeGreaterThan(q({}));
    expect(decide(b, { nivel: 0.98 }).seguranca).toBeGreaterThanOrEqual(decide(b, { nivel: 0.90 }).seguranca);
  });
  test('mínimo e múltiplo: só com cadastro; sem cadastro é premissa declarada', () => {
    expect(decide(b).embalagem.fonte_multiplo).toBe('PREMISSA_SEM_CADASTRO');
    const d = decide(b, {}, comConfig(P13, { produtos: { 'PX-1': { multiplo_un: 12, minimo_un: 48 } } }));
    expect(d.qtd_sugerida % 12).toBe(0);
    expect(d.qtd_sugerida).toBeGreaterThanOrEqual(48);
  });
  test('fator manual de sazonalidade vale para o mês da chegada e é neutro por padrão', () => {
    const d = decide(b, {}, comConfig(P13, { fator_demanda: { por_mes: { 10: 1.5 } } }));
    expect(d.velocidade).toBeCloseTo(decide(b).velocidade * 1.5, 9);
  });
  test('produto novo: sem segurança estatística, mas o ponto nunca fica abaixo da cobertura da classe', () => {
    const d = decide(b, { velocidadeFixa: 2 });
    expect(d.seguranca).toBe(0);
    expect(d.ponto_reposicao).toBeCloseTo(60, 9);
  });
  test('justificativa legível com cada parcela', () => {
    const d = decide(b);
    const t = K.justificar({ d, abc: { receita: 'A', margem: 'A', volume: 'B' }, previsao: b.previsao, variab: b.variab, f: b.f, perdida: K.vendaPerdida(b.f, b.previsao, 1000) }).join('\n');
    for (const trecho of ['Classe A', 'Demanda:', 'Prazo: 10 dias', 'Segurança:', 'Ponto de reposição', 'estoque-alvo', 'Sugestão:']) expect(t).toContain(trecho);
  });
  test('z da normal', () => { expect(K.zDe(0.95)).toBeCloseTo(1.6449, 3); expect(K.zDe(0.98)).toBeCloseTo(2.0537, 3); expect(K.zDe(0.5)).toBeCloseTo(0, 6); });
});

describe('capital de giro', () => {
  const item = (id, classe, o = {}) => ({ id, classe, custo_cents: 1000, margem_unit_cents: 500, velocidade: 1, qtd_sugerida: 20, qtd_protecao: 10, ponto_reposicao: 10, posicao: 0, embalagem: { minimo_un: 1, multiplo_un: 1 }, ...o });
  test('sem teto aloca tudo; com teto protege A antes do ciclo e nunca ultrapassa', () => {
    const itens = [item('c', 'C'), item('a', 'A'), item('neg', 'A', { margem_unit_cents: -1 })];
    expect(K.alocarCapital(itens, null, P13).alocado.get('c')).toBe(20);
    const r = K.alocarCapital(itens, 15000, P13);
    expect(r.usado_cents).toBeLessThanOrEqual(15000);
    expect([r.alocado.get('a'), r.alocado.get('c'), r.alocado.get('neg')]).toEqual([10, 5, 0]);
  });
  test('respeita múltiplo e mínimo', () => {
    const r = K.alocarCapital([item('a', 'A', { embalagem: { minimo_un: 6, multiplo_un: 6 }, qtd_sugerida: 24, qtd_protecao: 12 })], 11000, P13);
    expect(r.alocado.get('a')).toBe(6);
  });
});

describe('comparação 1.2 × 1.3 e gravação isolada', () => {
  const montar = () => {
    const c = fx.cenario();
    const produtos = c.produtos.map(mapearProduto);
    const vendas = c.vendas;
    const compras = c.compras.map(x => x.Compra || x);
    const snapshots = { [HOJE]: { saldos: Object.fromEntries(produtos.map(p => [p.product_id, p.current_stock])) } };
    return { hoje: HOJE, geradoEm: null, produtos, vendas, compras, snapshots };
  };
  const res = S.calcularSombra(montar());
  test('a 1.2 da comparação é a do motor de produção; todo elegível tem justificativa', () => {
    const { calcularTudo } = require('../lib/compras/motor');
    const e = montar();
    const r12 = calcularTudo({ produtos: e.produtos, fatosVenda: e.vendas.flatMap(fatosDeVenda), fatosCompra: e.compras.flatMap(fatosDeCompra), hoje: HOJE });
    for (const l of res.linhas) expect([l.product_id, l.v12.qtd]).toEqual([l.product_id, r12.metricas.find(m => m.product_id === l.product_id).suggestion.suggested_qty]);
    for (const l of res.linhas.filter(x => x.estado === 'ELEGIVEL')) expect(l.justificativa.length).toBeGreaterThanOrEqual(5);
    for (const l of res.linhas.filter(x => x.estado !== 'ELEGIVEL')) expect(l.v13.qtd).toBe(0);
  });
  test('CSV e documentos sem nome de produto, grupo ou fornecedor', () => {
    const csv = S.gerarCsv(res.linhas), docs = JSON.stringify(S.documentosSombra(res));
    for (const texto of [csv, docs]) { expect(texto).not.toMatch(/Produto sintético|Grupo sintético/); expect(texto).not.toMatch(/FX-\d/); }
    expect(csv.split('\n')[0]).toBe(S.COLUNAS_CSV.join(';'));
  });
  test('grava somente na coleção própria; blocos excedentes antigos são removidos', async () => {
    const escritas = [];
    const db = { collection: c => ({ doc: id => ({ c, id, get: async () => ({ data: () => (id === 'meta' ? { blocos: 3 } : undefined) }) }) }),
      batch: () => ({ set: r => escritas.push(['set', r.c, r.id]), delete: r => escritas.push(['delete', r.c, r.id]), commit: async () => {} }) };
    await S.persistirSombra(db, res);
    expect([...new Set(escritas.map(e => e[1]))]).toEqual(['compras_sombra_13']);
    expect(escritas.every(e => S.RE_DOC.test(e[2]))).toBe(true);
    expect(escritas.filter(e => e[0] === 'delete').map(e => e[2])).toEqual(['bloco_001', 'bloco_002']);
  });
  test('o script não grava sem confirmação explícita e nunca a partir de cópia local', async () => {
    const { principal } = require('../scripts/compras_sombra_13');
    await expect(principal(['--gravar'], () => {})).rejects.toThrow(/GRAVACAO_EXIGE/);
    await expect(principal(['--gravar', '--confirmo=compras_sombra_13', '--de-arquivo', '/inexistente'], () => {})).rejects.toThrow(/NAO_GRAVAR/);
  });
});
