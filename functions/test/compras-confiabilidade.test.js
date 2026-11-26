'use strict';
// COMPRAS — confiabilidade dos dados: pendência antiga, indícios (sem presumir recebimento), prova de origem, investigação
// no GestãoClick com transporte FALSO (só GET, loja 262759, sem nomes), relatório e aviso na tela. Dados sintéticos; sem rede.
const C = require('../lib/compras/confiabilidade');
const I = require('../lib/investigacaoCompras');
const S = require('../lib/compras/snapshot');
const R = require('../scripts/relatorio_compras_confiabilidade');
const X = require('./fixtures/compras-estoque-f0');

const HOJE = '2026-11-26';
const compra = (id, data, itens, o = {}) => ({ id, codigo: o.codigo || id.replace(/\D/g, ''), data_emissao: data, nome_situacao: o.sit || 'Confirmada', fornecedor_id: o.forn || '900', modificado_em: o.mod || data + ' 10:00:00', valor_produtos: '100.00',
  produtos: itens.map(([produto_id, q]) => ({ produto: { produto_id, quantidade: String(q), valor_custo: '2.00' } })) });
const venda = (id, data, itens, o = {}) => ({ id, data, nome_situacao: o.sit || 'Concretizada', situacao_estoque: o.est || '1', produtos: itens.map(([produto_id, q]) => ({ produto_id, quantidade: String(q), valor_total: '1.00' })) });

describe('regra de confirmação', () => {
  const compras = [compra('C1', '2026-08-27', [['1', 5]], { sit: 'A receber' }), compra('C2', '2026-08-28', [['1', 5]], { sit: 'Em aberto' }), compra('C3', '2025-01-01', [['2', 3]]), compra('C4', '2025-01-01', [['2', 3]], { sit: 'Cancelada' }), compra('C5', '', [['3', 1]], { sit: 'Em aberto' })];
  test('só pendente; idade > 90 dias (90 exatos não entra); sem data entra', () => {
    const r = C.listarPendentes(compras, HOJE);
    expect(r.map(p => [p.id, p.idade_dias, p.precisa_confirmacao])).toEqual([['C5', null, true], ['C1', 91, true], ['C2', 90, false]]);
  });
  test('bloco da tela: sem custo, valor ou fornecedor; null quando não há o que confirmar', () => {
    const b = C.blocoPendencias(compras, HOJE, { 1: { code: 'A-1', name: 'Produto A' } });
    expect(b).toMatchObject({ idade_max_dias: 90, precisam_confirmacao: 2, pendentes_total: 3, unidades: 6, produtos: 2 });
    expect(b.por_produto['1']).toEqual({ compras: 1, unidades: 5, idade_max_dias: 91 });
    expect(JSON.stringify(b)).not.toMatch(/cents|custo|valor|fornecedor/i);
    expect(C.blocoPendencias([compras[1], compras[2]], HOJE)).toBeNull();
  });
  test('na visão publicada: campo só existe com pendência antiga e NENHUMA sugestão muda', () => {
    const agora = new Date('2026-11-26T15:00:00Z');
    const produtos = [X.produto('P1', { estoque: 1 })];
    const vendas = [X.venda('2026-11-01', [['P1', 30]]), X.venda('2026-08-01', [['P1', 30]])];
    const base = [X.compra('2026-01-10', [['P1', 20]])];
    const velha = X.compra('2026-02-01', [['P1', 500]], { situacao: 'A receber' });
    const a = S.montarSnapshot({ brutosProdutos: produtos, brutosVendas: vendas, brutosCompras: base, agora });
    const b = S.montarSnapshot({ brutosProdutos: produtos, brutosVendas: vendas, brutosCompras: [...base, velha], agora });
    expect(a.view.sugestoes.pendencias_compras).toBeUndefined();
    expect(b.view.sugestoes.pendencias_compras).toMatchObject({ precisam_confirmacao: 1, unidades: 500 });
    expect(b.view.sugestoes.linhas.map(l => [l.id, l.qtd, l.prioridade])).toEqual(a.view.sugestoes.linhas.map(l => [l.id, l.qtd, l.prioridade]));
    expect(a.view.sugestoes.linhas[0].qtd).toBeGreaterThan(0);
    // incremental (base compacta) produz o mesmo bloco
    const c = S.montarSnapshot({ brutosProdutos: produtos, brutosVendas: vendas.map(S.compactarVenda), brutosCompras: [...base, velha].map(S.compactarCompra), agora });
    expect(c.view.sugestoes.pendencias_compras).toEqual(b.view.sugestoes.pendencias_compras);
  });
});

describe('indícios de recebimento (nunca presunção)', () => {
  const ver = (compras, vendas, saldos, id = 'P') => { const movimentos = C.indexarMovimentosProduto(vendas, compras); return C.indiciosRecebimento({ pendente: C.listarPendentes(compras, HOJE).find(p => p.id === id), compras, movimentos, saldos, snapshots: {} }); };
  const pend = compra('P', '2026-01-10', [['1', 10]], { sit: 'Em aberto' });
  test('gêmea confirmada e saldo fechando → duplicidade provável', () => {
    const r = ver([pend, compra('G', '2026-01-10', [['1', 10]])], [venda('V', '2026-02-01', [['1', 6]])], { 1: 4 });
    expect(r).toMatchObject({ veredito: 'DUPLICIDADE_PROVAVEL', compras_gemeas: ['G'] });
    expect(r.itens[0]).toMatchObject({ residuo_vida: 0, saldo_implicito_na_emissao: 0 });
  });
  test('sobra compatível é só compatível; sem sobra → sem indício', () => {
    expect(ver([pend], [], { 1: 10 }).veredito).toBe('SOBRA_COMPATIVEL_NAO_COMPROVA');
    expect(ver([pend], [], { 1: 0 }).veredito).toBe('SEM_INDICIO_DE_ENTRADA');
    expect(Object.keys(C.VEREDITOS).join()).not.toMatch(/RECEBIDA/);
  });
});

describe('origem', () => {
  const compras = [compra('C1', '2026-10-02', [['1', 10], ['2', 7]], { codigo: '501' }), compra('C2', '2026-10-02', [['3', 2]], { codigo: '502' }), compra('C3', '2025-01-01', [['3', 9]], { codigo: '503', forn: '901' })];
  const snapshots = { '2026-10-01': { saldos: { 1: 0, 2: 1, 3: 0 } }, '2026-10-02': { saldos: { 1: 8, 2: 8, 3: 0 } } };
  const vendas = [venda('V', '2026-10-02', [['1', 2]])];
  const movimentos = C.indexarMovimentosProduto(vendas, compras);
  const entradas = C.provaPorEntradaNoSaldo({ compras, snapshots, movimentos });
  test('entrada no saldo comprova só com quantidade exata no mesmo dia', () => {
    expect(entradas.get('C1')).toMatchObject({ comprovada: true, dia: '2026-10-02', produtos_conferidos: 2 });
    expect(entradas.get('C2').comprovada).toBe(false);
    expect(entradas.has('C3')).toBe(false);
  });
  test('título: código + fornecedor; divergente vira CONFLITO e não é usado em decisão', () => {
    const titulo = (id, desc, forn, o = {}) => ({ source_id: id, description: desc, entity_type: 'FORNECEDOR', entity_id: forn, final_amount_cents: 1000, settled_flag: false, ...o });
    const { porCompra } = C.vincularTitulosACompras(compras, [titulo('T1', 'Compra de nº 502', '900', { settled_flag: true }), titulo('T2', 'Compra de nº 503', '900'), titulo('T3', 'Aluguel', '900')], () => 'REGISTRO');
    expect(porCompra.get('C2')).toMatchObject({ titulos: 1, soma_paga_cents: 1000, loja_no_registro: 1 });
    const o = C.classificarOrigem({ compras, vinculos: porCompra, entradas });
    expect(o.map(x => [x.id, x.nivel, x.usar_em_decisao_automatica])).toEqual([['C1', 'COMPROVADA_ENTRADA', true], ['C2', 'COMPROVADA_TITULO', true], ['C3', 'CONFLITO', false]]);
    expect(C.resumirOrigem(o)).toMatchObject({ comprovadas: { compras: 2, unidades: 19 }, nao_comprovadas: { compras: 1, unidades: 9 } });
  });
});

// ── Investigação no GestãoClick (transporte falso) ──────────────────────────────────────────────────────────────
const SEGREDOS = ['FORNECEDOR-SECRETO', 'CLIENTE-SECRETO', '12.345.678/0001-99', 'OBS-SECRETA', 'USUARIO-SECRETO', 'tok-SECRETO', 'sec-SECRETO', 'OUTRA LOJA'];
const fonte = () => ({
  compras: [
    { Compra: { ...compra('101', '2025-01-21', [['47142037', 10]], { codigo: '501', sit: 'A receber' }), nome_fornecedor: 'FORNECEDOR-SECRETO', observacoes: 'OBS-SECRETA chegou parcial', situacoes: [{ situacao: { id: '7', nome_situacao: 'A receber', data: '2025-01-21', nome_usuario: 'USUARIO-SECRETO' } }], pagamentos: [{ pagamento: { data_vencimento: '2025-02-21', valor: '100.00' } }] } },
    { Compra: { ...compra('102', '2026-10-02', [['47142039', 5]], { codigo: '502' }), nome_fornecedor: 'FORNECEDOR-SECRETO' } },
  ],
  vendas: [{ ...venda('777', '2026-11-25', [['47142037', 30], ['47142039', 20]]), codigo: '9001', cliente_id: '55', nome_cliente: 'CLIENTE-SECRETO', nome_loja: 'MR4 DISTRIBUIDORA' }],
  pagamentos: [{ id: '31', codigo: '1', descricao: 'Compra de nº 502', entidade: 'F', fornecedor_id: '900', nome_fornecedor: 'FORNECEDOR-SECRETO', valor_total: '10.00', liquidado: '1', data_vencimento: '2026-10-20', loja_id: '262759', nome_loja: 'MR4 DISTRIBUIDORA' }],
});
function transporte(f) {
  const pedidos = [];
  const resp = (corpo, status = 200) => ({ status, headers: { get: () => null }, json: async () => corpo });
  const t = async (url, opts) => {
    const u = new URL(url), q = u.searchParams;
    pedidos.push({ metodo: opts.method, caminho: u.pathname, loja: q.get('loja_id') });
    const d = /^\/(compras|vendas)\/(\d+)$/.exec(u.pathname);
    if (d) { const x = f[d[1]].map(v => v.Compra || v).find(v => v.id === d[2]); return x ? resp({ code: 200, status: 'success', data: x }) : resp({}, 404); }
    const campo = u.pathname === '/vendas' ? 'data' : u.pathname === '/pagamentos' ? 'data_vencimento' : 'data_emissao';
    const l = f[u.pathname.slice(1)].filter(v => { const x = (v.Compra || v)[campo]; return x >= q.get('data_inicio') && x <= q.get('data_fim'); });
    const pagina = Number(q.get('pagina') || 1), lim = Number(q.get('limite') || 20), paginas = Math.max(1, Math.ceil(l.length / lim));
    return resp({ code: 200, status: 'success', data: l.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: l.length || null, total_paginas: l.length ? paginas : null, pagina_atual: pagina, limite_por_pagina: lim, proxima_pagina: pagina < paginas ? pagina + 1 : null } });
  };
  return { t, pedidos };
}
async function investigar(f = fonte(), opcoes = {}) {
  const linhas = [], tr = transporte(f);
  const r = await I.executarInvestigacao({ transporte: tr.t, credenciais: { access: 'tok-SECRETO', secret: 'sec-SECRETO' }, agora: new Date('2026-11-26T18:00:00Z'), opcoes: { pausaMs: 0, vendas: ['777', '888'], ...opcoes }, saida: l => linhas.push(l), dormir: async () => {} });
  return { r, linhas, pedidos: tr.pedidos, log: R.lerLog(linhas.join('\n')) };
}

describe('investigação GC (somente leitura)', () => {
  test('só GET, sempre loja 262759, sem nomes/observações/credenciais; venda ausente registrada; vínculo por título', async () => {
    const x = await investigar();
    expect(x.r).toMatchObject({ ok: true, secoes_com_erro: [] });
    expect(x.pedidos.every(p => p.metodo === 'GET' && p.loja === '262759')).toBe(true);
    expect(x.linhas.every(l => l.startsWith('INVC_'))).toBe(true);
    for (const s of SEGREDOS) expect(x.linhas.join('\n')).not.toContain(s);
    expect(x.log.orcamento).toMatchObject({ usadas: x.pedidos.length, escritas_firestore: 0, leituras_firestore: 0, escritas_gc: 0 });
    expect(x.log.pendentes.get('101')).toMatchObject({ codigo: '501', observacao_menciona: { recebimento: true, parcial: true, cancelamento: false }, historico: { itens: [{ situacao_id: '7', nome: 'A receber', data: '2025-01-21' }] }, parcelas: [{ vencimento: '2025-02-21', valor: '100.00' }] });
    expect(x.log.detalhes.map(v => [v.id, v.encontrada])).toEqual([['777', true], ['888', false]]);
    expect(x.log.origem.get('102')).toMatchObject({ codigo: '502', titulos: 1, pagos: 1, loja_no_registro: 1 });
    expect(x.log.titulos).toMatchObject({ completo: true, loja_confirmada_no_registro: 1, compras_com_titulo: 1 });
  });
  test('título de OUTRA loja aborta a seção sem imprimir nada dele; orçamento nunca é ultrapassado', async () => {
    const f = fonte(); f.pagamentos[0] = { ...f.pagamentos[0], loja_id: '', nome_loja: 'OUTRA LOJA' };
    const x = await investigar(f);
    expect(x.r.ok).toBe(false); expect(x.r.secoes_com_erro).toEqual([{ secao: 'titulos', codigo: 'GC_LOJA_DIVERGENTE' }]); expect(x.log.origem).toBeNull(); expect(x.linhas.join('\n')).not.toContain('OUTRA LOJA');
    const y = await investigar(fonte(), { maxRequisicoes: 10 });
    expect(y.pedidos.length).toBeLessThanOrEqual(10); expect(y.r.ok).toBe(false); expect(y.log.origem).toBeNull();
  });
  test('argumentos: lista separada por +, faixas validadas', () => {
    expect(I.lerOpcoes(['--vendas=1+2', '--max-requisicoes=100'])).toMatchObject({ vendas: ['1', '2'], maxRequisicoes: 100 });
    expect(() => I.lerOpcoes(['--max-requisicoes=9999'])).toThrow('ARGUMENTO_FORA_DA_FAIXA');
    expect(() => I.lerOpcoes(['--loja=424483'])).toThrow('ARGUMENTO_INVALIDO');
  });
  test('relatório com e sem log: cenário atual reproduz a visão; sem log nada é dado como comprovado por título', async () => {
    const agora = new Date('2026-11-26T15:00:00Z');
    const produtos = [X.produto('47142037', { estoque: 2 }), X.produto('47142039', { estoque: 2 })];
    const vendas = [...fonte().vendas, venda('700', '2026-09-01', [['47142037', 40]])];
    const compras = fonte().compras.map(c => c.Compra);
    const sn = S.montarSnapshot({ brutosProdutos: produtos, brutosVendas: vendas, brutosCompras: compras, agora });
    const d = { resumo: sn.resumo, meta: sn.meta, base: { vendas: sn.base.vendas, compras: sn.base.compras }, produtos: sn.operacional, custos: sn.custos, view_sug: sn.view.sugestoes, nomes_forn: { fornecedores: { 900: { nome: '=Fornecedor Teste' } } }, snapshots: { '2026-11-26': sn.snapshotEstoque }, fin_pagar: [] };
    const sem = R.gerar(d);
    expect(sem.numeros).toMatchObject({ diverge: 0, pendentes: 1, candidata: ['777'] });
    expect(sem.numeros.origem.por_prova.titulo.compras).toBe(0);
    expect(sem.arquivos['04-COMPRAS-CONFIABILIDADE-DOS-DADOS.md']).toMatch(/PENDENTE da execução/);
    expect(sem.arquivos['04C-origem-das-compras.csv']).toContain("'=Fornecedor Teste");
    const x = await investigar();
    const com = R.gerar(d, x.log);
    expect(com.numeros.origem.por_prova.titulo.compras).toBe(1);
    expect(com.arquivos['04A-compras-pendentes.csv']).toContain(';501;');
    expect(com.arquivos['04-COMPRAS-CONFIABILIDADE-DOS-DADOS.md']).toMatch(/INTEGRAL/);
  });
});

// ── Tela ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('tela de Compras (script real, DOM mínimo)', () => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/compras.html'), 'utf8');
  const trecho = (a, b) => HTML.slice(HTML.indexOf(a), HTML.indexOf(b));
  function montar(p) {
    const box = { hidden: true, innerHTML: '' };
    const ctx = { estado: {}, document: { getElementById: () => box }, esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), fmt: n => String(n) };
    vm.createContext(ctx);
    vm.runInContext(trecho('// ── Compras pendentes antigas', '// ── Política 1.2 · textos legíveis') + ';globalThis.__m = montarPendencias; globalThis.__s = seloPendente;', ctx);
    ctx.__m(p);
    return { box, selo: ctx.__s };
  }
  test('sem pendência: nada aparece; com pendência: aviso escapado, sem ação de escrita, selo no produto', () => {
    const vazio = montar(undefined);
    expect(vazio.box.hidden).toBe(true); expect(vazio.selo({ id: '1' })).toBe('');
    const b = C.blocoPendencias([compra('C1', '2026-01-01', [['1', 5]], { sit: 'A receber' })], HOJE, { 1: { code: 'A<1>', name: '<img src=x>' } });
    const x = montar(b);
    expect(x.box.hidden).toBe(false); expect(x.box.innerHTML).toContain('precisam de confirmação'); expect(x.box.innerHTML).toContain('&lt;img src=x&gt;'); expect(x.box.innerHTML).not.toContain('<img');
    expect(x.box.innerHTML).not.toMatch(/<button|<input|<a /); expect(x.selo({ id: '1' })).toContain('CONFIRMAR'); expect(x.selo({ id: '2' })).toBe('');
    expect(HTML).toContain('<div class="pend-compras" id="pendCompras" hidden></div>');
  });
});
