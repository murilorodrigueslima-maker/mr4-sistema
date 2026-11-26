'use strict';
// RECONCILIAÇÃO GC × MR4 — transporte FALSO (nenhuma rede): só GET, loja fixa, orçamento, zero escrita, saída sem dados pessoais.
const fs = require('fs'), path = require('path');
const R = require('../../scripts/reconciliar-estoque');
const S = require('../lib/compras/snapshot');
const X = require('./fixtures/compras-estoque-f0');
const G = require('./fixtures/compras-gc-falso');

const T0 = new Date('2026-09-28T15:00:00Z');            // sync do MR4 (12:00 em Fortaleza)
const T1 = new Date('2026-09-28T18:00:00Z');            // reconciliação (15:00)
const SENSIVEL = { nome_cliente: 'CLIENTE-SECRETO', nome_fornecedor: 'FORNECEDOR-SECRETO', documento: '12.345.678/0001-99' };

const produto = (id, estoque, o = {}) => ({ ...X.produto(id, { estoque, ...o }) });
function fonteBase() {
  const produtos = [produto('P1', 10), produto('P2', 20), produto('P3', 5), produto('P4', 8), produto('P5', -1), produto('P9', 4)];
  const vendas = [
    { ...X.venda('2026-09-20', [['P1', 6, 100], ['P2', 1]], { id: 'V1' }), ...SENSIVEL, loja_id: '262759' },
    { ...X.venda('2026-09-21', [['P3', 2]], { id: 'V2' }), ...SENSIVEL },
    { ...X.venda('2026-09-22', [['P4', 2]], { id: 'V3', situacao: 'Em aberto', situacao_estoque: '0' }) },
  ];
  const compras = [
    X.compra('2026-09-01', [['P1', 20], ['P2', 20]], { id: 'C1' }),
    X.compra('2026-09-10', [['P3', 7]], { id: 'C2', situacao: 'A receber' }),
    X.compra('2025-01-10', [['P9', 4]], { id: 'C3' }),
  ].map(c => ({ Compra: { ...c.Compra, ...SENSIVEL } }));
  return { produtos, vendas, compras };
}

/** Transporte no formato do gcHttp (status/headers/json). Registra tudo o que saiu. */
function transporteFalso(fonte, { falhar = {}, detalhe = {} } = {}) {
  const pedidos = [];
  const resposta = corpo => ({ status: 200, headers: { get: () => null }, json: async () => corpo });
  const t = async (url, opts) => {
    const u = new URL(url), q = u.searchParams;
    pedidos.push({ metodo: opts.method, caminho: u.pathname, loja: q.get('loja_id'), url });
    if (falhar[u.pathname]) return { status: falhar[u.pathname], headers: { get: () => null }, json: async () => ({}) };
    if (u.pathname.startsWith('/produtos/')) {
      const id = u.pathname.split('/')[2], p = detalhe[id] || fonte.produtos.find(x => x.id === id);
      return p ? resposta({ code: 200, status: 'success', data: p }) : { status: 404, headers: { get: () => null }, json: async () => ({}) };
    }
    let l;
    if (u.pathname === '/produtos') l = q.get('ativo') === '0' ? [] : fonte.produtos;
    else if (u.pathname === '/vendas') l = fonte.vendas.filter(v => v.data >= q.get('data_inicio') && v.data <= q.get('data_fim'));
    else if (u.pathname === '/compras') l = fonte.compras;
    else return { status: 404, headers: { get: () => null }, json: async () => ({}) };
    const pagina = Number(q.get('pagina') || 1), lim = Number(q.get('limite') || 20), paginas = Math.max(1, Math.ceil(l.length / lim));
    return resposta({ code: 200, status: 'success', data: l.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: l.length || null, total_paginas: l.length ? paginas : null, pagina_atual: pagina, limite_por_pagina: lim, proxima_pagina: pagina < paginas ? pagina + 1 : null } });
  };
  return { t, pedidos };
}

async function preparar() {
  const db = G.criarDbFalso();
  const r = await S.executarSync({ cli: G.criarGcFalso(fonteBase()).cli, db, agora: T0 });
  expect(r.ok).toBe(true);
  return db;
}
async function rodar({ db, fonte = fonteBase(), opcoes = {}, ambiente, transporte = {} }) {
  const linhas = [], f = transporteFalso(fonte, transporte), antes = JSON.stringify(db.st);
  const r = await R.executarReconciliacao({ transporte: f.t, credenciais: { access: 'tok-SECRETO', secret: 'sec-SECRETO' }, db, agora: T1, opcoes: { pausaMs: 0, ...opcoes }, saida: l => linhas.push(l), dormir: async () => {}, ambiente });
  expect(JSON.stringify(db.st)).toBe(antes);                                 // ZERO escrita
  const secao = tag => linhas.filter(l => l.startsWith(`RECON_${tag} `)).map(l => JSON.parse(l.slice(l.indexOf(' ') + 1)));
  const itens = tag => secao(tag).flatMap(x => x.itens);
  return { r, linhas, secao, itens, pedidos: f.pedidos };
}

describe('reconciliação', () => {
  test('fontes iguais: sem divergência; só GET; loja fixa 262759; orçamento impresso; nenhuma escrita', async () => {
    const db = await preparar();
    const x = await rodar({ db });
    expect(x.r).toMatchObject({ ok: true, secoes_com_erro: [] });
    expect(x.pedidos.every(p => p.metodo === 'GET' && p.loja === '262759')).toBe(true);
    expect(x.secao('QUANTIDADE')[0].divergentes).toBe(0);
    expect(x.secao('CUSTO')[0].divergentes).toBe(0);
    expect(x.secao('VENDAS')[0]).toMatchObject({ produtos_divergentes: 0, so_no_gc: 0, so_no_mr4: 0, nao_baixaram_estoque_nao_canceladas: { vendas: 1, unidades: 2 } });
    const o = x.secao('ORCAMENTO')[0];
    expect(o).toMatchObject({ maximo: 80, usadas: x.pedidos.length, escritas_firestore: 0, escritas_gc: 0, esgotado: false });
    expect(x.secao('INICIO')[0].aviso).toMatch(/NÃO é estoque físico/);
  });
  test('saída sem nomes, documentos, credenciais ou mensagens: só agregados e IDs/códigos de produto', async () => {
    const x = await rodar({ db: await preparar() });
    const tudo = x.linhas.join('\n');
    expect(tudo).not.toMatch(/SECRETO|12\.345\.678|Produto sintético|Grupo sintético|FX-1|V1"|C1"/);
    expect(x.linhas.every(l => /^RECON_[A-Z0-9_]+ \{/.test(l))).toBe(true);
  });
  test('classifica divergência explicada por movimento posterior × sem explicação; custo, cadastro, vendas e entradas', async () => {
    const db = await preparar(), f = fonteBase();
    f.produtos = [produto('P1', 7), produto('P2', 15), produto('P3', 5, { valor_custo: '12.00' }), produto('P4', 8), produto('P5', -1), produto('P7', 2)];   // P9 saiu; P7 entrou
    f.vendas.push({ ...X.venda('2026-09-28', [['P1', 3]], { id: 'V9' }), modificado_em: '2026-09-28 13:30:00' });                      // depois do sync das 12:00
    const x = await rodar({ db, fonte: f, transporte: { detalhe: { P9: { ...produto('P9', 4), ativo: '0' } } } });
    const q = Object.fromEntries(x.itens('DIVERGENCIA_QTD').map(i => [i.id, i]));
    expect(q.P1).toMatchObject({ gc: 7, mr4: 10, dif: -3, classe: 'EXPLICADA_POR_MOVIMENTO_POSTERIOR' });
    expect(q.P2).toMatchObject({ gc: 15, mr4: 20, classe: 'SEM_EXPLICACAO' });
    expect(x.itens('DIVERGENCIA_CUSTO')).toEqual([expect.objectContaining({ id: 'P3', dif_pct: 20 })]);
    expect(x.itens('CADASTRO_SO_GC').map(i => i.id)).toEqual(['P7']);
    expect(x.itens('CADASTRO_SO_MR4').map(i => i.id)).toEqual(['P9']);
    expect(x.itens('CADASTRO_AUSENTES_DETALHE')).toEqual([{ id: 'P9', situacao: 'INATIVO_NO_DETALHE' }]);
    expect(x.secao('VENDAS')[0]).toMatchObject({ so_no_gc: 1, so_no_gc_alterados_apos_mr4: 1 });
    expect(x.itens('DIVERGENCIA_VENDAS')).toEqual([expect.objectContaining({ id: 'P1', dif: 3, alterado_apos_mr4: true })]);
    const c = x.itens('CONTAGEM_FISICA');
    expect(c.find(i => i.id === 'P2').motivos).toContain('DIVERGENTE_GC_MR4');
    expect(c.find(i => i.id === 'P5').motivos).toContain('SALDO_NEGATIVO');
    expect(c.every(i => i.contagem_fisica === null)).toBe(true);
  });
  test('edição de venda já conhecida não conta duas vezes (efeito = versão nova − antiga)', async () => {
    const db = await preparar(), f = fonteBase();
    f.vendas[0] = { ...X.venda('2026-09-20', [['P1', 8, 100], ['P2', 1]], { id: 'V1' }), modificado_em: '2026-09-28 14:00:00' };
    f.produtos[0] = produto('P1', 8);
    const x = await rodar({ db, fonte: f });
    expect(x.itens('DIVERGENCIA_QTD')).toEqual([expect.objectContaining({ id: 'P1', dif: -2, classe: 'EXPLICADA_POR_MOVIMENTO_POSTERIOR' })]);
  });
  test('em trânsito = compras pendentes (proxy declarado) e sem movimentação sem valor por produto', async () => {
    const x = await rodar({ db: await preparar() });
    expect(x.secao('TRANSITO')[0]).toMatchObject({ compras_pendentes_gc: 1, unidades_gc: 7, unidades_mr4: 7 });
    expect(x.secao('TRANSITO')[0].declaracao).toMatch(/não fornece/);
    // P4 só tem venda sem baixa de estoque; P9 só tem compra antiga: os dois estão parados
    expect(x.secao('SEM_MOVIMENTO')[0].sem_venda_90d).toMatchObject({ produtos: 2, unidades: 12, capital_custo_cadastrado_cents: 12000 });
    expect(x.itens('SEM_MOVIMENTO_ITENS').map(i => i.id)).toEqual(['P4', 'P9']);
    expect(x.itens('SEM_MOVIMENTO_ITENS')[1]).toMatchObject({ id: 'P9', nunca_vendido: true, entrada_90d: false });
    expect(Object.keys(x.itens('SEM_MOVIMENTO_ITENS')[0])).not.toContain('capital');
  });
  test('declara campos de saldo: ausentes → saldo único; presentes → lista os nomes (nunca valores)', async () => {
    const db = await preparar();
    expect((await rodar({ db })).secao('CAMPOS_SALDO')[0].declaracao).toMatch(/único saldo/);
    const f = fonteBase(); f.produtos = f.produtos.map(p => ({ ...p, estoque_reservado: '987654' }));
    const x = await rodar({ db, fonte: f });
    expect(x.secao('CAMPOS_SALDO')[0].campos_com_nome_de_reserva_disponivel_transito_minimo.produto).toEqual(['estoque_reservado']);
    expect(x.linhas.join('')).not.toContain('987654');
  });
  test('orçamento esgotado: nunca passa do máximo, reporta e não repete', async () => {
    const f = fonteBase(); f.produtos = Array.from({ length: 650 }, (_, i) => produto('Q' + String(i).padStart(4, '0'), 1));
    const x = await rodar({ db: await preparar(), fonte: f, opcoes: { maxRequisicoes: 8 } });
    expect(x.pedidos.length).toBeLessThanOrEqual(8);
    expect(x.r.ok).toBe(false);
    expect(x.secao('ORCAMENTO')[0].usadas).toBe(x.pedidos.length);
    const y = await rodar({ db: await preparar(), fonte: f, opcoes: { maxRequisicoes: 5 } });
    expect(y.pedidos.length).toBe(1);                                        // 7 páginas não cabem: aborta após a 1ª, sem lista parcial
    expect(y.r).toMatchObject({ ok: false, abortado: 'SEM_DADOS_ESSENCIAIS', secoes_com_erro: [{ secao: 'produtos', codigo: 'GC_LIMITE_PAGINAS' }] });
  });
  test('leitor: repetições contam no orçamento e a trava vale também dentro delas', async () => {
    let n = 0;
    const l = R.criarLeitorGc({ transporte: async () => { n++; return { status: 503, headers: { get: () => null }, json: async () => ({}) }; }, credenciais: { access: 'a', secret: 'b' }, maxRequisicoes: 2, pausaMs: 0, dormir: async () => {} });
    await expect(l.get('/vendas', {})).rejects.toMatchObject({ codigo: 'RECON_ORCAMENTO_ESGOTADO' });
    expect(n).toBe(2);
    await expect(l.get('/vendas', { loja_id: '424483' })).rejects.toThrow();
    expect(n).toBe(2);
  });
  test('falha de uma seção não derruba as outras e sai como código', async () => {
    const x = await rodar({ db: await preparar(), transporte: { falhar: { '/compras': 403 } } });
    expect(x.r.secoes_com_erro).toEqual([{ secao: 'compras', codigo: 'GC_HTTP_403' }]);
    expect(x.secao('VENDAS')).toHaveLength(1); expect(x.secao('COMPRAS')).toHaveLength(0);
    expect(x.secao('QUANTIDADE')[0].movimentos_considerados_completos).toBe(false);
  });
  test('registro de outra loja aborta a leitura', async () => {
    const f = fonteBase(); f.produtos[0] = { ...f.produtos[0], loja_id: '424483' };
    const x = await rodar({ db: await preparar(), fonte: f });
    expect(x.r.secoes_com_erro).toEqual([{ secao: 'produtos', codigo: 'GC_LOJA_DIVERGENTE' }]);
  });
  test('sincronização em andamento ou reexecução do Job: aborta sem chamar o GC', async () => {
    const db = await preparar();
    const y = await rodar({ db, ambiente: { CLOUD_RUN_TASK_ATTEMPT: '1' } });
    expect(y.r.abortado).toBe('REEXECUCAO_AUTOMATICA_DO_JOB'); expect(y.pedidos).toHaveLength(0);
    await db.collection('gc_sync_lock').doc('sync-dados').set({ expiraEm: T1.getTime() + 60000 });
    const x = await rodar({ db });
    expect(x.r.abortado).toBe('SINCRONIZACAO_EM_ANDAMENTO'); expect(x.pedidos).toHaveLength(0);
    expect((await rodar({ db, opcoes: { ignorarTrava: true } })).r.ok).toBe(true);
  });
});

describe('segurança estática e argumentos', () => {
  const fonte = ['../../scripts/reconciliar-estoque.js', '../lib/estoqueReconciliacao.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  test('o script não contém escrita no Firestore nem método de mutação HTTP', () => {
    const codigo = fonte.replace(/\/\/.*$/gm, '');
    expect(codigo).not.toMatch(/\.batch\(|\.commit\(|runTransaction|bulkWriter|recursiveDelete/);
    expect(codigo).not.toMatch(/\.doc\([^)]*\)\.(set|update|create|delete)\(|\.collection\([^)]*\)\.add\(/);
    expect(codigo).not.toMatch(/persistirSnapshot|executarSync|consolidarHistorico/);   // nenhuma rotina que grava é chamada
    expect(codigo).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/);
    expect(Object.keys(R.somenteLeitura({}).collection('x').doc('y'))).toEqual(['get']);
  });
  test('argumentos: padrões, faixas e recusa de desconhecidos', () => {
    expect(R.lerOpcoes([])).toEqual(R.PADRAO);
    expect(R.lerOpcoes(['--max-requisicoes=60', '--ignorar-trava', '--dias-vendas=7'])).toMatchObject({ maxRequisicoes: 60, ignorarTrava: true, diasVendas: 7 });
    for (const a of [['--max-requisicoes=9999'], ['--pausa-ms=0'], ['--loja=424483'], ['x']]) expect(() => R.lerOpcoes(a)).toThrow();
  });
});
