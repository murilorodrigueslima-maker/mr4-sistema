'use strict';
// Planejamento de compra: cadastro de fornecedores, tetos, pedidos grandes, comparação 1.2 × 1.3 × 1.4, fronteira, plano semanal,
// CSV, atualização da base (callable) e autorização. Dados 100 % sintéticos.
const fs = require('fs'), path = require('path');
const fx = require('./fixtures/compras-estoque-f0');
const A = require('../lib/compras/alocacao14');
const S14 = require('../lib/compras/sombra14');
const K = require('../lib/compras/calculadora13');
const { POLITICA_1_3_SOMBRA: P13 } = require('../lib/compras/politica13');
const { mapearProduto, fatosDeVenda, somarDias } = require('../lib/compras/canonico');
const P = require('../../js/compras-planejamento');
const C = require('../lib/comprasSimuladorCallable');
const RAIZ = path.join(__dirname, '../..');
const ler = f => fs.readFileSync(path.join(RAIZ, f), 'utf8');

const item = (id, o = {}) => ({ id, codigo: 'C-' + id, nome: 'Item ' + id, categoria: 'Cat', marca: null, fornecedor_id: 'F1', classe: 'A', xyz: 'X', estado: 'ELEGIVEL', estoque: 0,
  transito: { recente: 0, antigo: 0, recente_sem_origem: 0, antigo_sem_origem: 0 }, custo_cents: 1000, preco_cents: 2000, v: 1, v_observada: 1, sd_dia: 1, esporadico: false, novo: false,
  prazo_dias: 10, prazo_desvio: 2, prazo_fonte: 'PROXY_FORNECEDOR', minimo_un: 1, multiplo_un: 1, multiplo_observado: 1, nao_comprar: false, crescimento_fator: 1, origem_comprovada: true, origem_motivo: null, ultima_compra_id: 'U-' + id,
  linhas_venda: { n: 40, p50: 2, p80: 8, p90: 20, p95: 30, max: 60 }, r12: { q: 20, abc: 'A', v: 1 }, r13: { v: 1, rop: 25, alvo: 55 }, ...o });
const base = (itens, extra = {}) => ({ itens, fornecedores: { F1: { nome: 'Fornecedor um' }, F2: { nome: 'Fornecedor dois' } }, ...extra });
const variado = () => Array.from({ length: 30 }, (_, i) => { const v = 0.2 + (i % 7) * 0.5; return item('P' + String(i).padStart(2, '0'), { classe: ['A', 'B', 'C'][i % 3], xyz: ['X', 'Y', 'Z'][i % 3], v, v_observada: v, sd_dia: 0.5 + (i % 4),
  custo_cents: 300 + (i % 11) * 450, preco_cents: 900 + (i % 11) * 800, estoque: (i * 3) % 13, fornecedor_id: i % 4 === 0 ? 'F2' : 'F1', r12: { q: 3 + i, abc: ['A', 'B', 'C'][i % 3], v }, r13: { v, rop: 17 * v + 2, alvo: 40 * v + 2 } }); });
const linha = (r, id) => r.linhas.find(l => l.id === id);
const porForn = (r, id) => (r.fornecedores.find(f => f.fornecedor_id === id) || { valor_cents: 0 }).valor_cents;

describe('cadastro de fornecedor (contrato de dados): padrão seguro e valores inválidos ignorados', () => {
  test('sem nenhum documento nada muda nos números; marca o que não está confirmado', () => {
    const d = base([item('a')]);
    const r = P.aplicarCadastros(d);
    for (const k of ['prazo_dias', 'prazo_desvio', 'prazo_fonte', 'multiplo_un', 'minimo_un', 'origem_comprovada']) expect(r.itens[0][k]).toEqual(d.itens[0][k]);
    expect(r.itens[0].nao_confirmado).toEqual(['PRAZO_ESTIMADO', 'EMBALAGEM_NAO_INFORMADA']);
    expect(r.fornecedores.F1.cadastrado).toBe(false);
    expect(r.cadastro).toEqual({ fornecedores_com_cadastro: 0, fornecedores: 2, campos_ignorados: [] });
  });
  test('prazo, múltiplo, mínimos e frequência entram; MANUAL é informado, o resto é estimado', () => {
    const parametros = { F1: { prazoMedioDias: 20, prazoMaxDias: 30, multiploPadrao: 6, multiplosPorProduto: { b: 12 }, qtdMinimaPorProduto: { b: 24 }, valorMinimoCents: 5000, qtdMinima: 10, frequenciaReposicaoDias: 14, confiabilidadePrazo: 'BAIXA', fontes: { prazoMedioDias: 'MANUAL', multiploPadrao: 'MANUAL', valorMinimoCents: 'ESTIMADO' } } };
    const r = P.aplicarCadastros(base([item('a'), item('b')]), { parametros });
    const [a, b] = r.itens;
    expect([a.prazo_dias, a.prazo_fonte, a.multiplo_un, a.revisao_dias, b.multiplo_un, b.minimo_un]).toEqual([20, 'CADASTRO_INFORMADO', 6, 14, 12, 24]);
    expect(a.prazo_desvio).toBeCloseTo(Math.sqrt(5 ** 2 + (20 * 0.4) ** 2), 6);                 // (30−20)/2 e confiabilidade baixa
    expect(a.nao_confirmado).toEqual([]);
    expect(r.fornecedores.F1).toMatchObject({ minimo_cents: 5000, minimo_un: 10, minimo_natureza: 'ESTIMADO', cadastrado: true });
    const s = A.simular(r, {});
    expect(linha(s, 'a').qtd % 6).toBe(0);
    expect(linha(s, 'b').qtd % 12).toBe(0);
    expect(linha(s, 'b').qtd).toBeGreaterThanOrEqual(24);
    expect(linha(s, 'a').justificativa.join(' ')).toMatch(/informado no cadastro do fornecedor/);
  });
  test('importado sem prazo informado usa a premissa de importado', () => {
    const r = P.aplicarCadastros(base([item('a')]), { parametros: { F1: { origem: 'IMPORTADO' } } });
    expect([r.itens[0].prazo_dias, r.itens[0].prazo_fonte, r.itens[0].importado]).toEqual([60, 'PREMISSA_IMPORTADO', true]);
  });
  test('valores fora do formato não quebram nem entram', () => {
    const sujo = { prazoMedioDias: -3, prazoMaxDias: 'x', qtdMinima: 1.5, valorMinimoCents: -1, multiploPadrao: 0, multiplosPorProduto: [1], qtdMinimaPorProduto: { a: 'muito' }, frequenciaReposicaoDias: 0, origem: 'MARTE', confiabilidadePrazo: 'TALVEZ', fontes: 7 };
    const d = base([item('a')]), r = P.aplicarCadastros(d, { parametros: { F1: sujo } });
    for (const k of ['prazo_dias', 'multiplo_un', 'minimo_un', 'revisao_dias']) expect(r.itens[0][k]).toEqual(d.itens[0][k]);
    expect(r.cadastro.campos_ignorados.length).toBeGreaterThanOrEqual(8);
    expect(() => A.simular(r, {})).not.toThrow();
    expect(() => P.aplicarCadastros(d, { parametros: { F1: null }, pendencias: { z: null }, origem: {} })).not.toThrow();
  });
  test('confirmação das compras pendentes: recebida, duplicada e cancelada saem; o resto não presume recebimento', () => {
    const pendentes = [{ id: 'C1', antiga: false, sem_origem: false, itens: [['a', 5]] }, { id: 'C2', antiga: true, sem_origem: false, itens: [['a', 7]] }, { id: 'C3', antiga: false, sem_origem: true, itens: [['a', 11]] }];
    const t = (pendencias, origem) => P.aplicarCadastros(base([item('a')], { pendentes }), { pendencias, origem }).itens[0];
    expect(t({}).transito).toEqual({ recente: 5, antigo: 7, recente_sem_origem: 11, antigo_sem_origem: 0 });
    for (const status of ['PENDENTE', 'AGUARDANDO_CONFERENCIA']) expect(t({ C1: { status }, C2: { status }, C3: { status } }).transito).toEqual(t({}).transito);
    for (const status of ['RECEBIDA', 'DUPLICADA', 'CANCELADA']) { const x = t({ C1: { status } }); expect(x.transito.recente).toBe(0); expect(x.estoque).toBe(0); }
    expect(t({}, { C1: { usar_em_decisao_automatica: false }, C3: { usar_em_decisao_automatica: true } }).transito).toEqual({ recente: 11, antigo: 7, recente_sem_origem: 5, antigo_sem_origem: 0 });
    expect(t({}).nao_confirmado).toContain('PENDENTE_SEM_CONFIRMACAO');
  });
  test('marca de origem da última compra prevalece sobre a base', () => {
    const r = P.aplicarCadastros(base([item('a'), item('b', { origem_comprovada: false })]), { origem: { 'U-a': { usar_em_decisao_automatica: false }, 'U-b': { usar_em_decisao_automatica: true } } });
    expect(r.itens.map(i => i.origem_comprovada)).toEqual([false, true]);
    expect(A.simular(r, {}).linhas.find(l => l.id === 'a').motivo).toBe('ORIGEM_NAO_COMPROVADA');
  });
});

describe('entradas novas do motor', () => {
  test('limite da compra: o menor entre total, semanal e mensal, descontado o comprometido', () => {
    expect(P.limiteDaCompra({})).toEqual({ cents: null, limitante: null });
    expect(P.limiteDaCompra({ total_cents: 1000, semanal_cents: 900, comprometido_semana_cents: 300, mensal_cents: 5000 })).toEqual({ cents: 600, limitante: 'semanal' });
    expect(P.limiteDaCompra({ mensal_cents: 500, comprometido_mes_cents: 900, total_cents: 100 })).toEqual({ cents: 0, limitante: 'mensal' });
  });
  test('teto por fornecedor é respeitado e o dinheiro vai para os demais', () => {
    const d = base(variado()), livre = A.simular(d, { orcamento_cents: 200000 });
    expect(porForn(livre, 'F1')).toBeGreaterThan(30000);
    for (const teto of [0, 30000]) {
      const r = A.simular(d, { orcamento_cents: 200000, orcamento_fornecedor_cents: { F1: teto } });
      expect(porForn(r, 'F1')).toBeLessThanOrEqual(teto);
      expect(porForn(r, 'F2')).toBeGreaterThanOrEqual(porForn(livre, 'F2'));
      expect(r.nao_contemplados.some(l => /(PARCIAL_POR_TETO|SEM_ORCAMENTO)_DO_FORNECEDOR/.test(l.motivo))).toBe(true);
      expect(r.totais.capital_cents).toBeLessThanOrEqual(200000);
    }
    const aj = A.simular(d, { orcamento_fornecedor_cents: { F1: 0 }, ajustes: { P01: 5 } });
    expect(aj.alertas).toContain('AJUSTES_ULTRAPASSAM_O_TETO_DO_FORNECEDOR');
  });
  test('prazo: tela por fornecedor > prazo fixo > fator > dado do item', () => {
    const p = x => A.preparar(item('a'), A.configurar(x));
    expect([p({}).L, p({ prazo: { modo: 'FIXO', dias: 30 } }).L, p({ prazo: { fator: 2 } }).L, p({ prazo: { modo: 'FIXO', dias: 30, por_fornecedor: { F1: 5 } } }).L]).toEqual([10, 30, 20, 5]);
    expect(p({ prazo: { modo: 'FIXO', dias: 40 } }).ponto).toBeGreaterThan(p({}).ponto);
    expect(() => A.configurar({ prazo: { modo: 'FIXO' } })).toThrow(/prazo.dias/);
  });
  test('mínimo e múltiplo: tela (produto > fornecedor) > cadastro > padrão > unidade avulsa', () => {
    const e = (i, x) => A.embalagemDe(i, A.configurar(x));
    expect(e(item('a'), {})).toEqual({ multiplo: 1, minimo: 1 });
    expect(e(item('a'), { embalagem: { multiplo_padrao: 5, minimo_padrao: 7 } })).toEqual({ multiplo: 5, minimo: 10 });
    const cad = item('a', { multiplo_un: 6, multiplo_cadastrado: true });
    expect(e(cad, { embalagem: { multiplo_padrao: 5 } }).multiplo).toBe(6);
    expect(e(cad, { embalagem: { por_fornecedor: { F1: { multiplo: 4 } } } }).multiplo).toBe(4);
    expect(e(cad, { embalagem: { por_fornecedor: { F1: { multiplo: 4 } }, por_produto: { a: { multiplo: 9, minimo: 20 } } } })).toEqual({ multiplo: 9, minimo: 27 });
    expect(e(item('a', { multiplo_un: 1, multiplo_cadastrado: true }), { embalagem: { multiplo_padrao: 5 } }).multiplo).toBe(1);   // "1" cadastrado vale
    expect(() => A.configurar({ embalagem: { por_produto: { a: { multiplo: 0 } } } })).toThrow(/embalagem/);
  });
  test('filtro por curva XYZ', () => {
    const r = A.simular(base(variado()), { filtros: { xyz: ['Z'] } });
    expect(r.linhas.every(l => l.xyz === 'Z')).toBe(true);
    expect(r.linhas.length).toBeGreaterThan(0);
  });
  test('ajuste manual fora do múltiplo é avisado', () => {
    expect(A.simular(base([item('a', { multiplo_un: 6 })]), { ajustes: { a: 7 } }).alertas).toContain('AJUSTES_FORA_DO_MINIMO_OU_MULTIPLO');
  });
});

describe('pedido grande', () => {
  const d = () => base([item('a', { v: 0.5, v_observada: 0.5, sd_dia: 0.5, linhas_venda: { n: 30, p80: 30, p90: 80, p95: 90, max: 100 } }), item('b', { v: 3, v_observada: 3, preco_cents: 2600 })]);
  test('desligado por padrão: não muda nada e não informa reserva', () => {
    const r = A.simular(d(), {});
    expect(A.PARAMETROS.pedido_grande.usar).toBe(false);
    expect(r.totais.pedido_grande).toBeUndefined();
    expect(linha(r, 'a').reservado_pedido_grande).toBe(0);
    expect(r.totais.pedido_grande_pct).toBeGreaterThanOrEqual(r.totais.pedido_grande_sem_compra_pct);
  });
  test('ligado: busca o percentil limitado em dias, com capital e custo anual explícitos', () => {
    const sem = A.simular(d(), {}), com = A.simular(d(), { pedido_grande: { usar: true, percentil: 90, teto_dias: 60 } });
    expect(linha(com, 'a').pedido_grande_un).toBe(80);
    expect(linha(com, 'a').qtd).toBeGreaterThanOrEqual(30);                      // 60 dias × 0,5/dia
    expect(linha(com, 'a').qtd).toBeGreaterThan(linha(sem, 'a').qtd);
    expect(com.totais.pedido_grande.capital_reservado_cents).toBeGreaterThan(0);
    expect(com.totais.pedido_grande.custo_anual_cents).toBe(Math.round(com.totais.pedido_grande.capital_reservado_cents * 0.3));
    expect(com.totais.pedido_grande_pct).toBeGreaterThanOrEqual(sem.totais.pedido_grande_pct);
    expect(linha(com, 'a').justificativa.join(' ')).toMatch(/reserva para pedido grande .*por ano/);
  });
  test('a reserva não passa da parte do orçamento nem do orçamento; amostra pequena não gera reserva', () => {
    const r = A.simular(d(), { orcamento_cents: 40000, pedido_grande: { usar: true, fracao_max_orcamento: 0.25 } });
    expect(r.totais.pedido_grande.capital_reservado_cents).toBeLessThanOrEqual(10000);
    expect(r.totais.capital_cents).toBeLessThanOrEqual(40000);
    const p = A.preparar(item('c', { linhas_venda: { n: 3, p90: 50 } }), A.configurar({ pedido_grande: { usar: true } }));
    expect(p.grande).toEqual({ un: 0, linhas: 0, piso: 0 });
    expect(() => A.configurar({ pedido_grande: { percentil: 99 } })).toThrow(/percentil/);
  });
  test('linhas de venda: soma o produto dentro da venda, só demanda dos últimos 365 dias', () => {
    const hoje = '2026-09-28', v = (d, q, o) => fx.venda(somarDias(hoje, -d), [['PX', q]], o);
    const dup = fx.venda(somarDias(hoje, -2), [['PX', 3], ['PX', 4]], { id: 'DUPLA' });
    const m = S14.linhasDeVenda([v(1, 1), v(10, 2), dup, v(400, 99), v(5, 50, { situacao: 'Cancelada' })].flatMap(fatosDeVenda), hoje);
    expect(m.get('PX')).toEqual({ n: 3, p50: 2, p80: 7, p90: 7, p95: 7, max: 7 });
  });
});

describe('comparação 1.2 × 1.3 × 1.4, fronteira e plano', () => {
  const d = () => base(variado());
  test('as três regras usam o mesmo dinheiro, tetos e embalagem', () => {
    const c = P.comparar(d(), { orcamento_cents: 60000, orcamento_fornecedor_cents: { F2: 5000 }, embalagem: { multiplo_padrao: 4 } });
    expect(c.regras.map(r => r.id)).toEqual(['r12', 'r13', 'r14']);
    const custo = Object.fromEntries(variado().map(i => [i.id, i]));
    for (const r of c.regras) {
      expect(r.totais.capital_cents).toBeLessThanOrEqual(60000);
      let f2 = 0;
      for (const [id, q] of r.qtd) { expect(q % 4).toBe(0); if (custo[id].fornecedor_id === 'F2') f2 += q * custo[id].custo_cents; }
      expect(f2).toBeLessThanOrEqual(5000);
    }
    expect(c.sem_compra.capital_cents).toBe(0);
  });
  test('a 1.3 na tela reproduz a distribuição de capital do motor 1.3', () => {
    const cfg = A.configurar({ orcamento_cents: 45000 }), prontos = d().itens.map(i => A.preparar(i, cfg));
    const itens = prontos.map(p => { const r = p.item.r13, pos = p.item.estoque; if (!(pos < r.rop)) return null; const q = Math.ceil(r.alvo - pos);
      return { id: p.id, classe: p.classe, custo_cents: p.custo, margem_unit_cents: p.preco - p.custo, velocidade: r.v, qtd_sugerida: q, qtd_protecao: Math.min(q, Math.ceil(r.rop - pos)), ponto_reposicao: r.rop, posicao: pos, embalagem: { minimo_un: 1, multiplo_un: 1 } }; }).filter(Boolean);
    const motor = K.alocarCapital(itens, 45000, P13).alocado;
    const tela = P.regra13(prontos, cfg);
    for (const i of itens) expect([i.id, tela.get(i.id) || 0]).toEqual([i.id, motor.get(i.id)]);
  });
  test('1.2 corta por urgência e respeita o mínimo', () => {
    const q = P.regra12([item('x', { r12: { q: 10, abc: 'C', v: 1 }, classe: 'C' }), item('y', { r12: { q: 10, abc: 'A', v: 1 } })].map(i => A.preparar(i, A.configurar())), A.configurar({ orcamento_cents: 12000 }));
    expect([q.get('y'), q.get('x')]).toEqual([10, 2]);
  });
  test('fronteira: capital crescente até o necessário e ponto de retorno decrescente', () => {
    const f = P.criarFronteira(d(), { filtros: { fornecedores: ['F1'] } }, { pontos: 10 });
    const curva = f.orcamentos.map((_, i) => f.ponto(i));
    expect(curva[0].r14.capital_cents).toBe(0);
    expect(curva[curva.length - 1].r14.capital_cents).toBe(f.capital_necessario_cents);
    for (let i = 1; i < curva.length; i++) expect(curva[i].r14.atendimento_pct).toBeGreaterThanOrEqual(curva[i - 1].r14.atendimento_pct - 0.2);
    expect(curva.every(p => p.r14.capital_cents <= p.orcamento_cents)).toBe(true);
    const sint = [[0, 50], [10, 60], [20, 66], [30, 66.5], [40, 66.8]].map(([c, a]) => ({ capital_cents: c * 100000, atendimento_pct: a }));
    const r = P.retornoDecrescente(sint, { limiar: 1 });
    expect([r.ponto.capital_cents, r.noventa.capital_cents]).toEqual([2000000, 2000000]);
    expect(P.retornoDecrescente(sint, { limiar: 0.01 }).ponto).toBeNull();
    expect(P.retornoDecrescente([sint[0]]).ponto).toBeNull();
  });
  test('plano semanal respeita semana, mês e total', () => {
    const p = P.planoSemanal(d(), {}, { semanas: 8, hoje: '2026-11-26', semanal_cents: 30000, mensal_cents: 70000, total_cents: 150000, comprometido_mes_cents: 50000 });
    expect(p.semanas.every(s => s.usado_cents <= 30000)).toBe(true);
    expect(p.semanas[0].usado_cents).toBeLessThanOrEqual(20000);                  // 70 mil do mês − 50 mil comprometidos
    for (const m of p.meses) expect(m.usado_cents).toBeLessThanOrEqual(70000);
    expect(p.usado_cents).toBeLessThanOrEqual(150000);
    expect(p.semanas[1].data).toBe('2026-12-03');
    expect([...p.por_produto.values()].every(a => a.length === 8)).toBe(true);
    expect(P.planoSemanal(d(), {}, { hoje: '2026-11-26' }).erro).toMatch(/semanal ou o mensal/);
  });
  test('CSV: lista de planejamento, nunca pedido; dados não confirmados e proteção contra fórmula', () => {
    const dados = P.aplicarCadastros(base([item('a', { nome: '=cmd()' })], {}), {});
    dados.fornecedores.F1.nome = '+HIPERLINK';
    const sim = A.simular(dados, {}), t = P.csvPlanejamento(sim, { comparacao: P.comparar(dados, {}), dados, data: '26/11/2026', premissas: ['=x;y\nz'] });
    const linhas = t.split('\n');
    expect(linhas[0]).toBe(P.AVISO_CSV);
    expect(linhas[3]).toBe('x,y z');                                       // sem ";" (não cria colunas) nem início de fórmula
    expect(t).toContain('qtd_regra_1_2;qtd_regra_1_3');
    expect(t).toContain('prazo estimado | mínimo/múltiplo não informado');
    expect(t).toContain("'=cmd()");
    expect(t).toContain("'+HIPERLINK");
  });
  test('o módulo é puro: sem rede, armazenamento, sorteio ou relógio', () => {
    expect(ler('js/compras-planejamento.js')).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|Math\.random|Date\.now|new Date\(\)|firebase/);
  });
});

describe('gerador: dados do planejamento', () => {
  const produtos = ['PX-1', 'PX-2'].map(id => mapearProduto(fx.produto(id, { estoque: 2, cadastrado_em: '2024-01-01 10:00:00' })));
  const vendas = ['PX-1', 'PX-2'].flatMap(id => fx.serie(id, { de: 300, passo: 3, qtd: 2 }));
  const compras = [fx.compra(fx.dia(120), [['PX-1', 50], ['PX-2', 30]], { id: 'K1' }), fx.compra(fx.dia(200), [['PX-1', 7]], { id: 'K2', situacao: 'A receber' }), fx.compra(fx.dia(5), [['PX-1', 3], ['PX-FORA', 1]], { id: 'K3', situacao: 'Em aberto' })].map(c => c.Compra);
  const ent = { hoje: fx.HOJE, geradoEm: 'X', produtos, vendas, compras, snapshots: {}, sugestaoGravada12: new Map(), view: null, fornecedores: null };
  const res = S14.calcular(ent);
  test('pendentes item a item reproduzem o "a caminho" da base', () => {
    expect(res.pendentes.map(p => [p.id, p.antiga, p.itens])).toEqual([['K2', true, [['PX-1', 7]]], ['K3', false, [['PX-1', 3]]]]);
    const ap = P.aplicarCadastros({ itens: res.itens, fornecedores: res.fornecedores, pendentes: res.pendentes });
    expect(ap.itens.map(i => i.transito)).toEqual(res.itens.map(i => i.transito));
  });
  test('regras 1.2 e 1.3 vêm dos próprios motores e conferem na tela', () => {
    const cfg = A.configurar(), prontos = res.itens.map(i => A.preparar(i, cfg));
    const q13 = P.regra13(prontos, cfg), q12 = P.regra12(prontos, cfg);
    for (const l of res.base.linhas.filter(x => x.estado === 'ELEGIVEL')) { expect(q13.get(l.product_id) || 0).toBe(l.v13.qtd); expect(q12.get(l.product_id) || 0).toBe(l.v12.qtd); }
    expect(res.itens[0].linhas_venda.n).toBeGreaterThan(50);
    expect(res.itens[0].ultima_compra_id).toBe('K1');
  });
  test('confirmação de origem da gestão prevalece sobre a regra padrão; formato 2 nos documentos', () => {
    expect(S14.origemDaCompra({ id: '9', fornecedor_id: null }, { origem: { ...S14.GERACAO.origem, compras_com_origem: ['9'] } })).toBeNull();
    const meta = S14.documentos(res).pop()[1];
    expect(meta.formato).toBe(2);
    expect(JSON.parse(meta.pendentes_json)).toEqual(res.pendentes);
  });
});

describe('callable planejamentoComprasAtualizar: autorização e payload', () => {
  const banco = docs => ({ collection: c => ({ doc: id => ({ get: async () => ({ exists: !!docs[c + '/' + id], data: () => docs[c + '/' + id] }) }) }) });
  const req = (data = {}, uid = 'u1') => ({ auth: uid ? { uid } : null, data });
  const G = { role: 'gestor', ativo: true };
  const casos = [['sem users', {}], ['funcionário com módulo', { 'users/u1': { role: 'funcionario', ativo: true }, 'sistema_usuarios/u1': { modulos: ['estoque'] } }], ['gestor inativo', { 'users/u1': { role: 'gestor', ativo: false }, 'sistema_usuarios/u1': { admin: true } }],
    ['gestor bloqueado', { 'users/u1': G, 'sistema_usuarios/u1': { admin: true, bloqueado: true } }], ['gestor sem o módulo', { 'users/u1': G, 'sistema_usuarios/u1': { modulos: ['ponto'] } }], ['gestor sem sistema_usuarios', { 'users/u1': G }]];
  test.each(casos)('%s: negado', async (_, docs) => { await expect(C.handler(req(), { db: banco(docs) })).rejects.toMatchObject({ code: 'permission-denied' }); });
  test('sem login e payload estranho', async () => {
    await expect(C.handler(req({}, null), { db: banco({}) })).rejects.toMatchObject({ code: 'unauthenticated' });
    for (const data of [{ x: 1 }, { forcar: 'sim' }, [1], 'a']) await expect(C.handler(req(data), { db: banco({}) })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test.each([[{ modulos: ['estoque'] }], [{ admin: true }]])('gestor autorizado %p; sem dados de compras responde sem gravar', async sis => {
    const r = await C.handler(req(), { db: banco({ 'users/u1': G, 'sistema_usuarios/u1': sis }), log: { log() {} } });
    expect(r).toEqual({ status: 'SEM_DADOS_DE_COMPRAS' });
  });
  test('falha interna não vaza detalhe', async () => {
    const db = banco({ 'users/u1': G, 'sistema_usuarios/u1': { admin: true } }); const col = db.collection;
    db.collection = c => { if (c === 'compras_n0') throw new Error('segredo@exemplo.com 12345678901'); return col(c); };
    await expect(C.handler(req(), { db, log: { log() {} } })).rejects.toMatchObject({ code: 'internal', message: 'Não foi possível atualizar a base agora. A base anterior foi mantida.' });
  });
  test('a atualização só escreve na coleção própria e não usa GestãoClick nem segredos', () => {
    const src = ler('functions/lib/compras/simuladorBase.js') + ler('functions/lib/comprasSimuladorCallable.js');
    expect(src).not.toMatch(/GC_|gcHttp|criarClienteGC|fetch\(|secrets/);
    expect([...src.matchAll(/(?:tx|ref|lote)\.(set|update|delete)\(/g)].length).toBe(2);       // só a trava (as duas em compras_sombra_14)
    expect(ler('functions/lib/compras/simuladorBase.js')).toMatch(/const ref = db\.collection\(S14\.COLECAO\)\.doc\(TRAVA\)/);
    const bloco = ler('functions/index.js').split('exports.planejamentoComprasAtualizar')[1].split('\n').slice(0, 2).join(' ');
    expect(bloco).not.toMatch(/secrets|schedule/);
  });
});
