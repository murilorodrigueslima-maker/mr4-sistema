'use strict';
// AGENTE COMPRAS MR4 — Fase C (backend): nomes de fornecedor PREPARADOS e DESLIGADOS + gravação ISOLADA dos agregados.
const S = require('../lib/compras/snapshot');
const F = require('../lib/compras/fornecedores');
const G = require('./fixtures/compras-gc-falso');
const D = require('./fixtures/compras-ui-dados');
const X = require('./fixtures/compras-rentabilidade-fx').X;

const fonte = D.cenario(6), P12 = D.politica, T0 = X.AGORA;
const gc = () => G.criarGcFalso(fonte);
const COL = 'compras_n0_fornecedores';
const chaves = o => { const out = []; const a = x => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(k); a(v); } }; a(o); return out; };
const MONETARIO = /cents|liq|faturamento|valor|preco|pre[cç]o|custo|moeda|brl/i;

describe('Gravação isolada dos agregados', () => {
  test('o sync grava compras_n0_fornecedores/{unidades,valores}; unidades sem nenhum campo monetário; valores com centavos', async () => {
    const db = G.criarDbFalso(); const r = await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    expect(r.ok).toBe(true); expect(Object.keys(db.st[COL]).sort()).toEqual(['nomes', 'unidades', 'valores']);   // + cache de nomes (Fase C.2; só Admin SDK)
    const u = db.ler(COL, 'unidades'), v = db.ler(COL, 'valores');
    expect(chaves(u).filter(k => MONETARIO.test(k))).toEqual([]); expect(v.moeda).toBe('BRL');
    expect(u.conciliacao.fecha).toBe(true); expect(v.conciliacao.fecha).toBe(true);
    expect(r.snapshot.persistencia.fornecedores).toMatchObject({ gravado: true, detalhe_produtos: true });
  });
  test('NENHUM documento existente muda: as demais coleções são idênticas ao que o sync gravava antes (compat com produção db408ef já coberta nas suítes de deploy)', async () => {
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
    expect(r.gravado).toBe(false); expect(r.erro).toMatch(/FIRESTORE_INCOMPATIVEL.*ARRAY_ANINHADO/); expect(db.st[COL]).toBeUndefined();
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
