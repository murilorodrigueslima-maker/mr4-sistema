'use strict';
// AGENTE COMPRAS MR4 — Fase C.4 · fornecedores conhecidos SEM venda nos meses completos (lista `sem_vendas` só no documento de unidades).
const S = require('../lib/compras/snapshot');
const F = require('../lib/compras/fornecedores');
const G = require('./fixtures/compras-gc-falso');
const D = require('./fixtures/compras-ui-dados');
const X = require('./fixtures/compras-rentabilidade-fx').X;

const fonte = D.cenario(6), P12 = D.politica, T0 = X.AGORA, H = n => new Date(T0.getTime() + n * 3600e3);
const COL = 'compras_n0_fornecedores';
const api = o => ({ id: o.id, nome: o.nome, ativo: o.ativo === undefined ? '1' : o.ativo, cnpj: '00.000.000/0001-00', email: 'x@y.z', contatos: [{ telefone: '1' }] });
const rodar = (lista, db, agora = T0, o = {}) => S.executarSync({ cli: G.criarGcFalso({ ...fonte, fornecedores: lista }).cli, db, agora, politica: P12, ...o });
const U = r => r.snapshot.fornecedores.unidades, V = r => r.snapshot.fornecedores.valores;
const comGrupo = u => [...u.externos, ...u.internos].map(g => g.fornecedor_id);
const EXTRAS = [api({ id: '9001', nome: 'SEM VENDA ATIVO' }), api({ id: '9002', nome: 'SEM VENDA INATIVO', ativo: '0' }), api({ id: '2026204', nome: 'MR4 DISTRIBUIDORA' })];
let ids, lista;
beforeAll(async () => {
  const r0 = await rodar([], G.criarDbFalso());
  ids = U(r0).externos.map(g => g.fornecedor_id);
  lista = [...ids.map(id => api({ id, nome: 'FORNECEDOR ' + id })), ...EXTRAS];
});

describe('sem_vendas: conciliação dos conhecidos, sem duplicação', () => {
  test('conhecidos = com grupo + sem vendas; interseção vazia; interno separado dos externos; selo Inativo; nomes reais', async () => {
    const r = await rodar(lista, G.criarDbFalso()), u = U(r), sv = u.sem_vendas;
    const sids = sv.map(x => x.fornecedor_id), com = comGrupo(u);
    expect(sids.filter(x => com.includes(x))).toEqual([]);
    expect(new Set(sids).size).toBe(sids.length);
    expect(u.conciliacao.fornecedores).toEqual({ conhecidos: com.length + sids.length, com_grupo: com.length, sem_vendas: sids.length, fecha: true });
    expect(new Set([...com, ...sids]).size).toBe(lista.length);
    expect(sv.find(x => x.fornecedor_id === '9001')).toMatchObject({ tipo: 'EXTERNO', chave: 'EXTERNO:9001', nome: 'SEM VENDA ATIVO', nome_origem: 'GESTAOCLICK', produtos_atribuidos: 0 });
    expect(sv.find(x => x.fornecedor_id === '9001').inativo).toBeUndefined();
    expect(sv.find(x => x.fornecedor_id === '9002')).toMatchObject({ tipo: 'EXTERNO', nome: 'SEM VENDA INATIVO', inativo: true });
    expect(sv.find(x => x.fornecedor_id === '2026204')).toMatchObject({ tipo: 'INTERNO', chave: 'INTERNO:2026204', nome: 'MR4 DISTRIBUIDORA' });
    expect(u.externos.some(g => g.fornecedor_id === '2026204')).toBe(false);
    // externos primeiro, depois internos; dentro do tipo por nome
    expect(sv.map(x => x.tipo)).toEqual([...sv.map(x => x.tipo)].sort((a, b) => (a === b ? 0 : a === 'EXTERNO' ? -1 : 1)));
  });
  test('os quatro agrupamentos continuam existindo e só têm a forma de antes', async () => {
    const u = U(await rodar(lista, G.criarDbFalso()));
    expect(Object.keys(u)).toEqual(expect.arrayContaining(['externos', 'internos', 'sem_fornecedor', 'itens_sem_produto']));
    expect(u.sem_fornecedor.chave).toBe('SEM_FORNECEDOR'); expect(u.itens_sem_produto.chave).toBe('ITENS_SEM_PRODUTO');
    expect(u.sem_vendas.some(x => !['EXTERNO', 'INTERNO'].includes(x.tipo))).toBe(false);
  });
  test('cache de nomes vazio: não inventa fornecedores; só quem é "última compra" de algum produto aparece, como "Fornecedor #id"', async () => {
    const r = await rodar([], G.criarDbFalso());
    U(r).sem_vendas.forEach(x => { expect(x.nome).toBe('Fornecedor #' + x.fornecedor_id); expect(x.produtos_atribuidos).toBeGreaterThan(0); });
  });
});

describe('sem_vendas: fornecedor só conhecido pelas compras (sem nome no cache)', () => {
  test('quem é "última compra" de produtos mas não vendeu aparece como "Fornecedor #id" com produtos atribuídos', async () => {
    const r = await rodar([], G.criarDbFalso(), H(24 * 400)), sv = U(r).sem_vendas;
    expect(sv.length).toBeGreaterThan(0);
    sv.forEach(x => { expect(x.nome).toBe('Fornecedor #' + x.fornecedor_id); expect(x.nome_origem).toBe('FALLBACK_ID'); expect(x.produtos_atribuidos).toBeGreaterThan(0); });
    expect(U(r).conciliacao.fornecedores.fecha).toBe(true);
  });
});

describe('sem_vendas: segurança e privacidade', () => {
  test('só no documento de unidades; sem valores monetários, CNPJ, e-mail ou contatos em lugar algum', async () => {
    const db = G.criarDbFalso(), r = await rodar(lista, db);
    expect(V(r).sem_vendas).toBeUndefined();
    expect(JSON.stringify(V(r))).not.toMatch(/sem_vendas|SEM VENDA/);
    const sv = JSON.stringify(U(r).sem_vendas);
    expect(sv).not.toMatch(/cents|liq|R\$|faturamento|cnpj|cpf|email|telefone|contatos|00\.000/i);
    for (const x of U(r).sem_vendas) expect(Object.keys(x).sort()).toEqual(expect.arrayContaining(['chave', 'fornecedor_id', 'nome', 'nome_origem', 'produtos_atribuidos', 'tipo']));
    for (const id of ['nomes', 'unidades', 'valores']) expect(JSON.stringify(db.ler(COL, id))).not.toMatch(/"(cnpj|cpf|email|telefone|contatos|enderecos)"/i);
  });
  test('o documento gravado passa na validação de compatibilidade com o Firestore e continua pequeno', async () => {
    const db = G.criarDbFalso(), r = await rodar(lista, db);
    expect(r.ok).toBe(true); expect(r.snapshot.persistencia.fornecedores).toMatchObject({ gravado: true });
    const gravado = db.ler(COL, 'unidades'); expect(gravado.sem_vendas.length).toBe(U(r).sem_vendas.length);
    expect(Buffer.byteLength(JSON.stringify(gravado))).toBeLessThan(900 * 1024);
  });
});

describe('sem_vendas: nenhum número existente muda (invariância)', () => {
  test('unidades e valores idênticos com e sem a lista; conciliação de vendas igual', async () => {
    const a = await rodar(lista, G.criarDbFalso()), b = await rodar([], G.criarDbFalso());
    const sem = u => { const c = JSON.parse(JSON.stringify(u)); delete c.sem_vendas; delete c.conciliacao.fornecedores; ['nome', 'nome_origem'].forEach(() => 0); return c; };
    const num = x => JSON.stringify(x, (k, v) => (['nome', 'nome_origem', 'nome_anterior', 'inativo', 'nome_ausente_na_api', 'nomes_fornecedores', 'limitacoes', 'gerado_em', 'valido_ate', 'ultimo_sync_completo'].includes(k) ? undefined : v));
    expect(num(sem(U(a)))).toBe(num(sem(U(b)))); expect(num(V(a))).toBe(num(V(b)));
    expect(U(a).conciliacao.fecha).toBe(true);
  });
});

describe('sem_vendas: recalculada quando o fornecedor passa a vender ou deixa de vender', () => {
  const FIM = H(24 * 400);   // 400 dias depois: nenhuma venda do cenário cai nos 3 meses completos
  test('deixa de vender: sai de externos e entra em sem_vendas (com o último nome), sem duplicar', async () => {
    const db = G.criarDbFalso();
    const a = await rodar(lista, db), vendedores = comGrupo(U(a));
    expect(vendedores.length).toBeGreaterThan(0);
    const b = await rodar(lista, db, FIM), ub = U(b);
    expect(b.ok).toBe(true);
    const com = comGrupo(ub), sids = ub.sem_vendas.map(x => x.fornecedor_id);
    vendedores.filter(id => !com.includes(id)).forEach(id => { expect(sids).toContain(id); expect(ub.sem_vendas.find(x => x.fornecedor_id === id).nome).toBe('FORNECEDOR ' + id); });
    expect(sids.filter(x => com.includes(x))).toEqual([]); expect(new Set(sids).size).toBe(sids.length);
    expect(ub.conciliacao.fornecedores.fecha).toBe(true); expect(ub.conciliacao.fornecedores.conhecidos).toBe(lista.length);
  });
  test('volta a vender: sai de sem_vendas e reaparece como grupo; os conhecidos continuam fechando', async () => {
    const db = G.criarDbFalso();
    const b = await rodar(lista, db, FIM), semAntes = U(b).sem_vendas.map(x => x.fornecedor_id);
    const c = await rodar(lista, db, T0), uc = U(c), com = comGrupo(uc);
    ids.forEach(id => expect(com).toContain(id));
    expect(semAntes).toEqual(expect.arrayContaining(ids.filter(id => !comGrupo(U(b)).includes(id))));
    ids.forEach(id => expect(uc.sem_vendas.map(x => x.fornecedor_id)).not.toContain(id));
    expect(uc.conciliacao.fornecedores).toMatchObject({ conhecidos: lista.length, fecha: true });
  });
  test('fornecedor inativo e interno continuam na lista após nova execução; reativar remove o selo', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db);
    const l2 = lista.map(x => (x.id === '9002' ? { ...x, ativo: '1' } : x));
    const r = await rodar(l2, db, H(24));
    expect(U(r).sem_vendas.find(x => x.fornecedor_id === '9002').inativo).toBeUndefined();
    expect(U(r).sem_vendas.find(x => x.fornecedor_id === '2026204').tipo).toBe('INTERNO');
  });
});

describe('sem_vendas: custo de chamadas e compatibilidade', () => {
  test('nenhuma chamada nova: o COMPLETO continua com 1 GET de /fornecedores a mais (como antes da lista) e o incremental com 0', async () => {
    const mk = () => G.criarGcFalso({ ...fonte, fornecedores: lista });
    const sem = mk(), com = mk();
    await S.executarSync({ cli: sem.cli, db: G.criarDbFalso(), agora: T0, politica: { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: false } } });
    const db = G.criarDbFalso(); await S.executarSync({ cli: com.cli, db, agora: T0, politica: P12 });
    expect(com.chamadas.length - sem.chamadas.length).toBe(1);
    expect(com.chamadas.every(c => c.method === 'GET' || c.method === undefined)).toBe(true);
    const inc = mk(); const r = await S.executarSyncIncremental({ cli: inc.cli, db, agora: H(3), politica: P12 });
    expect(r.ok).toBe(true); expect(inc.chamadas.filter(x => /\/fornecedores/.test(x.url)).length).toBe(0);
    expect(U(r).sem_vendas.length).toBeGreaterThan(0);          // o incremental também entrega a lista (usa o cache de nomes)
  });
  test('documento ANTIGO (sem sem_vendas) é um subconjunto do novo: remover o campo reproduz o formato anterior', async () => {
    const u = JSON.parse(JSON.stringify(U(await rodar(lista, G.criarDbFalso())))); delete u.sem_vendas; delete u.conciliacao.fornecedores;
    expect(Object.keys(u.conciliacao).sort()).toEqual(['fecha', 'unidades']);
  });
});
