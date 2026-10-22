'use strict';
// AGENTE COMPRAS MR4 — Fase C (backend): nomes de fornecedor PREPARADOS e DESLIGADOS + gravação ISOLADA dos agregados.
const S = require('../lib/compras/snapshot');
const Fe = require('../lib/compras/fetch');
const F = require('../lib/compras/fornecedores');
const G = require('./fixtures/compras-gc-falso');
const D = require('./fixtures/compras-ui-dados');
const X = require('./fixtures/compras-rentabilidade-fx').X;

const fonte = D.cenario(6), P12 = D.politica, T0 = X.AGORA;
const gc = () => G.criarGcFalso(fonte);
const COL = 'compras_n0_fornecedores';
const chaves = o => { const out = []; const a = x => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(k); a(v); } }; a(o); return out; };
const MONETARIO = /cents|liq|faturamento|valor|preco|pre[cç]o|custo|moeda|brl/i;

describe('Nomes de fornecedor: preparado, NÃO ativo', () => {
  test('/fornecedores NÃO está na allowlist de produção e o cliente real bloqueia a chamada', async () => {
    expect(Fe.RECURSOS_PERMITIDOS).not.toContain('/fornecedores');
    const chamadas = []; const cli = Fe.criarClienteGC({ fetchImpl: async u => { chamadas.push(u); return { ok: true, json: async () => ({ data: [], meta: {} }) }; }, accessToken: 'a', secretToken: 'b', pausaMs: 0 });
    await expect(cli.get('/fornecedores?pagina=1&limite=100')).rejects.toThrow(/GET_ONLY_GUARD/);
    expect(chamadas).toEqual([]);                                                       // nem a requisição de rede aconteceu
  });
  test('padrão desligado: o sync não faz NENHUMA chamada a mais e o resultado é o mesmo de antes', async () => {
    expect(F.DEFAULTS.fetch_names).toBe(false);
    const a = gc(); const db = G.criarDbFalso();
    const r = await S.executarSync({ cli: a.cli, db, agora: T0, politica: P12 });
    expect(r.ok).toBe(true); expect(a.chamadas.every(c => !/fornecedores/.test(c.url))).toBe(true);
    expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores).toEqual({ ativo: false });
    expect(r.snapshot.fornecedores.unidades.externos.every(g => g.nome_origem === 'FALLBACK_ID')).toBe(true);
  });
  test('ligado (config) com fonte injetada: usa nomes reais nos ids vendidos; só id+nome entram', async () => {
    const base = await S.executarSync({ cli: gc().cli, db: G.criarDbFalso(), agora: T0, politica: P12 });
    const ids = base.snapshot.fornecedores.unidades.externos.map(g => g.fornecedor_id); expect(ids.length).toBeGreaterThan(0);
    const nomes = Object.fromEntries(ids.map(id => [id, 'NOME REAL ' + id]));
    const fetchMod = { ...Fe, buscarFornecedores: async () => ({ nomes, estatisticas: { recurso: 'fornecedores', nomeados: ids.length } }) };
    const pol = { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: true } };
    const r = await S.executarSync({ cli: gc().cli, db: G.criarDbFalso(), agora: T0, politica: pol, fetchMod });
    expect(r.ok).toBe(true);
    r.snapshot.fornecedores.unidades.externos.forEach(g => expect(g).toMatchObject({ nome: 'NOME REAL ' + g.fornecedor_id, nome_origem: 'GESTAOCLICK' }));
    expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores).toMatchObject({ ativo: true, ok: true });
    expect(r.snapshot.fornecedores.unidades.meta.limitacoes).not.toContain('NOMES_DE_FORNECEDOR_AUSENTES');
  });
  test('ligado mas a leitura falha (ex.: allowlist não autorizada): sync NÃO falha; nomes viram "Fornecedor #id"; erro registrado sem segredo', async () => {
    const pol = { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: true } }; const db = G.criarDbFalso();
    const r = await S.executarSync({ cli: gc().cli, db, agora: T0, politica: pol });          // cliente real da fixture ⇒ GET_ONLY_GUARD
    expect(r.ok).toBe(true);
    expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores).toMatchObject({ ativo: true, ok: false });
    expect(JSON.stringify(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores)).toMatch(/GET_ONLY_GUARD|guard/i);
  });
  test('buscarFornecedores devolve só id e nome (nunca CNPJ/CPF/contatos) e confere a paginação', async () => {
    const lista = [{ id: '1', nome: 'AAA', cnpj: '00000000000000', email: 'x@y.z', contatos: [1], enderecos: [2] }, { id: '2', nome: '  ' }, { id: '3', nome: 'CCC', cpf: '11111111111' }];
    const cli = { get: async () => ({ data: lista, meta: { total_registros: 3, total_paginas: 1 } }) };
    const r = await Fe.buscarFornecedores(cli);
    expect(r.nomes).toEqual({ 1: 'AAA', 3: 'CCC' }); expect(JSON.stringify(r)).not.toMatch(/cnpj|cpf|email|contatos|enderecos|0000|1111/i);
    await expect(Fe.buscarFornecedores({ get: async () => ({ data: lista.slice(0, 2), meta: { total_registros: 3, total_paginas: 1 } }) })).rejects.toThrow(/JANELA_INCOMPLETA/);
  });
});

describe('Gravação isolada dos agregados', () => {
  test('o sync grava compras_n0_fornecedores/{unidades,valores}; unidades sem nenhum campo monetário; valores com centavos', async () => {
    const db = G.criarDbFalso(); const r = await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    expect(r.ok).toBe(true); expect(Object.keys(db.st[COL]).sort()).toEqual(['unidades', 'valores']);
    const u = db.ler(COL, 'unidades'), v = db.ler(COL, 'valores');
    expect(chaves(u).filter(k => MONETARIO.test(k))).toEqual([]); expect(v.moeda).toBe('BRL');
    expect(u.conciliacao.fecha).toBe(true); expect(v.conciliacao.fecha).toBe(true);
    expect(r.snapshot.persistencia.fornecedores).toMatchObject({ gravado: true, detalhe_produtos: true });
  });
  test('NENHUM documento existente muda: as demais coleções são idênticas ao que o sync gravava antes (compat com produção 4cc4f55 já coberta nas suítes de deploy)', async () => {
    const a = G.criarDbFalso(), b = G.criarDbFalso();
    await S.executarSync({ cli: gc().cli, db: a, agora: T0, politica: P12 });
    // mesma execução, mas com a gravação de fornecedores impedida: o restante precisa ser byte a byte igual
    const bloq = { ...b, collection: c => (c === COL ? { doc: () => ({ set: async () => { throw new Error('bloqueado'); } }) } : b.collection(c)), batch: () => { const l = b.batch(); return { set: (r, v) => { if (r._c === COL) throw new Error('bloqueado'); l.set(r, v); }, commit: () => l.commit() }; } };
    await S.executarSync({ cli: gc().cli, db: bloq, agora: T0, politica: P12 });
    const sem = st => Object.fromEntries(Object.entries(st).filter(([c]) => c !== COL).map(([c, docs]) => [c, Object.fromEntries(Object.entries(docs).map(([id, s]) => [id, JSON.parse(s)]))]));
    const norm = o => JSON.parse(JSON.stringify(o, (k, x) => (/^(geracao|base_ativa|base_pendente|base_orfas|persistencia)$/.test(k) ? undefined : x)).replace(/g\d+x[0-9a-f]{6}_/g, ''));
    expect(Object.keys(sem(a.st)).sort()).toEqual(Object.keys(sem(b.st)).sort());
    for (const c of Object.keys(sem(a.st))) expect(norm(sem(a.st)[c])).toEqual(norm(sem(b.st)[c]));
  });
  test('falha ao gravar os agregados NÃO derruba o sync nem desfaz o snapshot de Compras', async () => {
    const db = G.criarDbFalso();
    const falho = { ...db, batch: () => { const l = db.batch(); return { set: (r, v) => { if (r._c === COL) throw new Error('DOC_INDISPONIVEL'); l.set(r, v); }, commit: () => l.commit() }; } };
    const r = await S.executarSync({ cli: gc().cli, db: falho, agora: T0, politica: P12 });
    expect(r.ok).toBe(true); expect(r.snapshot.persistencia.fornecedores).toEqual({ gravado: false, erro: 'DOC_INDISPONIVEL' });
    expect(db.ler('compras_n0', 'meta').ultima_tentativa_ok).toBe(true); expect(db.st[COL]).toBeUndefined();
  });
  test('documento acima do limite: grava o RESUMO por fornecedor (sem detalhe de produto) e marca detalhe_produtos=false', async () => {
    const db = G.criarDbFalso();
    const grande = { fornecedores: { docs: [[COL, 'unidades', { externos: [{ produtos: [{ x: 'a'.repeat(S.DOC_BYTES_MAX) }] }], internos: [], sem_fornecedor: { produtos: [] }, itens_sem_produto: { produtos: [] } }], [COL, 'valores', { externos: [], internos: [], sem_fornecedor: { produtos: [] }, itens_sem_produto: { produtos: [] } }]] } };
    const res = await S.persistirFornecedores(db, grande);
    expect(res).toMatchObject({ gravado: true, detalhe_produtos: false });
    expect(db.ler(COL, 'unidades').externos[0].produtos).toEqual([]); expect(db.ler(COL, 'unidades').detalhe_produtos).toBe(false);
  });
  test('sem agregado (snapshot antigo) nada é gravado; array aninhado é recusado', async () => {
    const db = G.criarDbFalso();
    expect(await S.persistirFornecedores(db, {})).toEqual({ gravado: false, motivo: 'SEM_AGREGADO' });
    const r = await S.persistirFornecedores(db, { fornecedores: { docs: [[COL, 'unidades', { a: [[1]] }]] } });
    expect(r.gravado).toBe(false); expect(r.erro).toMatch(/DOC_INCOMPATIVEL_FIRESTORE/); expect(db.st[COL]).toBeUndefined();
  });
  test('incremental repassa o último sync completo e marca DESATUALIZADA quando o completo está atrasado', async () => {
    const db = G.criarDbFalso();
    await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    const T1 = new Date(T0.getTime() + 3 * 3600e3), T2 = new Date(T0.getTime() + 40 * 3600e3);
    const r1 = await S.executarSyncIncremental({ cli: gc().cli, db, agora: T1, politica: P12 });
    expect(r1.snapshot.fornecedores.unidades.meta).toMatchObject({ modo_sync: 'INCREMENTAL', ultimo_sync_completo: T0.toISOString() });
    expect(r1.snapshot.fornecedores.unidades.meta.atualizacao.status).not.toBe('DESATUALIZADA');
    const r2 = await S.executarSyncIncremental({ cli: gc().cli, db, agora: T2, politica: P12 });
    expect(r2.snapshot.fornecedores.unidades.meta.atualizacao).toMatchObject({ status: 'DESATUALIZADA', motivo: 'SYNC_COMPLETO_ATRASADO' });
  });
});
