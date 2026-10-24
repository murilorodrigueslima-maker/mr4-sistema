'use strict';
// AGENTE COMPRAS MR4 — Fase C.3 · compatibilidade com o Firestore REAL (lição de 24/10/2026): o emulador aceitou um campo "__SEM_PRODUTO__"
// que a produção RECUSOU ("field name is reserved"), então o sync gravou o snapshot normal mas NÃO os agregados de fornecedores.
const C = require('../lib/compras/docCompat');
const S = require('../lib/compras/snapshot');
const F = require('../lib/compras/fornecedores');
const K = require('../lib/compras/canonico');
const G = require('./fixtures/compras-gc-falso');
const D = require('./fixtures/compras-ui-dados');
const X = require('./fixtures/compras-rentabilidade-fx').X;

const fonte = D.cenario(6), P12 = D.politica, T0 = X.AGORA;
const COL = 'compras_n0_fornecedores';

/** Firestore falso que se comporta como o REAL nesta regra: recusa campo reservado/vazio/array aninhado/undefined em qualquer gravação (set e batch). */
function dbComoProducao(db) {
  const valida = (ref, v) => { const pb = C.problemasFirestore(v, { maxBytes: 1024 * 1024 }); if (pb.length) { const e = new Error('3 INVALID_ARGUMENT: ' + pb[0]); e.code = 3; throw e; } };
  const envolve = r => ({ ...r, set: async v => { valida(r, v); return r.set(v); } });
  return { ...db, collection: c => { const col = db.collection(c); return { ...col, doc: id => envolve(col.doc(id)) }; },
    batch: () => { const l = db.batch(); return { set: (r, v) => { valida(r, v); l.set(r, v); }, delete: r => l.delete(r), commit: () => l.commit() }; },
    runTransaction: fn => db.runTransaction(tx => fn({ ...tx, set: (r, v) => { valida(r, v); tx.set(r, v); } })) };
}
const nomesDeCampo = o => { const k = []; (function a(x) { if (Array.isArray(x)) x.forEach(a); else if (x && typeof x === 'object') for (const [n, v] of Object.entries(x)) { k.push(n); a(v); } })(o); return k; };

describe('problemasFirestore — o que o Firestore real recusa e o emulador deixa passar', () => {
  test('nomes de campo reservados (__x__), vazios e gigantes; array aninhado; undefined; NaN/Infinity', () => {
    expect(C.problemasFirestore({ a: { __SEM_PRODUTO__: 1 } }).join()).toMatch(/NOME_DE_CAMPO_RESERVADO "__SEM_PRODUTO__"/);
    expect(C.problemasFirestore({ __id__: 1 })).toHaveLength(1); expect(C.problemasFirestore({ ____: 1 })).toHaveLength(1); expect(C.problemasFirestore({ __id: 1, id__: 1 })).toEqual([]);
    expect(C.problemasFirestore({ '': 1 }).join()).toMatch(/VAZIO/); expect(C.problemasFirestore({ ['x'.repeat(1501)]: 1 }).join()).toMatch(/GRANDE_DEMAIS/);
    expect(C.problemasFirestore({ a: [[1]] }).join()).toMatch(/ARRAY_ANINHADO/); expect(C.problemasFirestore({ a: undefined }).join()).toMatch(/UNDEFINED/);
    expect(C.problemasFirestore({ a: NaN, b: Infinity })).toHaveLength(2);
    expect(C.problemasFirestore({ a: 'x'.repeat(2000) }, { maxBytes: 1000 })).toContain('DOCUMENTO_GRANDE_DEMAIS');
    let fundo = { v: 1 }; for (let i = 0; i < 25; i++) fundo = { n: fundo }; expect(C.problemasFirestore(fundo).join()).toMatch(/PROFUNDIDADE/);
  });
  test('nomes comuns passam: sublinhado simples ou no meio, ids numéricos, "SEM_PRODUTO", mapas dentro de arrays', () => {
    expect(C.problemasFirestore({ _a: 1, a_: 2, a__b: 3, '123': { SEM_PRODUTO: [{ x: 1 }] }, 'EXTERNO:1': 1, 'a b': 2 })).toEqual([]);
  });
});

describe('Os documentos gerados são compatíveis com o Firestore real (regressão do __SEM_PRODUTO__)', () => {
  const venda = (data, itens) => ({ id: 'V' + data + itens.length, data, nome_situacao: 'Concretizada', situacao_estoque: '1', valor_produtos: '10.00', desconto_valor: '1.00', produtos: itens.map(([pid, q, t]) => ({ produto: { produto_id: pid, quantidade: String(q), valor_venda: '1', valor_total: t.toFixed(2) } })) });
  const compra = (f, ps) => ({ Compra: { id: 'C' + f, data_emissao: '2026-01-01', nome_situacao: 'Confirmada', fornecedor_id: f, valor_produtos: '10.00', produtos: ps.map(p => ({ produto: { produto_id: p, quantidade: '1', valor_custo: '5' } })) } });
  test('com item de venda sem produto, produto sem fornecedor, interno, reservado e nomes estranhos: 0 problemas nos 2 documentos', () => {
    const r = F.montarFornecedores({ produtos: [], fatosVenda: [venda('2026-08-10', [['', 3, 5], ['P1', 2, 5], ['PZ', 1, 5]])].flatMap(K.fatosDeVenda), fatosCompra: [compra('F1', ['P1']), compra('2026204', ['P9'])].flatMap(K.fatosDeCompra),
      hoje: '2026-10-22', agora: T0, nomes: { F1: '__nome__', 2026204: { nome: '', ativo: false } } });
    expect(C.problemasFirestore(r.unidades)).toEqual([]); expect(C.problemasFirestore(r.valores)).toEqual([]);
    expect(nomesDeCampo(r.valores)).toContain('SEM_PRODUTO'); expect(nomesDeCampo(r.valores).filter(n => C.RESERVADO.test(n))).toEqual([]);
  });
  test('o sync completo e o incremental passam por um Firestore que recusa campo reservado (como a produção) e GRAVAM os 3 documentos', async () => {
    const real = G.criarDbFalso(), db = dbComoProducao(real);
    const gc = () => G.criarGcFalso({ ...fonte, fornecedores: [{ id: 'FX-1', nome: 'N1', ativo: '1' }] });
    const r = await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    expect(r.ok).toBe(true); expect(r.snapshot.persistencia.fornecedores).toMatchObject({ gravado: true });
    expect(Object.keys(real.st[COL]).sort()).toEqual(['nomes', 'unidades', 'valores']);
    const i = await S.executarSyncIncremental({ cli: gc().cli, db, agora: new Date(T0.getTime() + 3 * 3600e3), politica: P12 });
    expect(i.ok).toBe(true); expect(i.snapshot.persistencia.fornecedores).toMatchObject({ gravado: true });
    for (const id of ['unidades', 'valores', 'nomes']) expect(C.problemasFirestore(real.ler(COL, id))).toEqual([]);
  });
  test('a validação TEM efeito: documento com campo reservado não é gravado, o erro é explícito e o sync segue normal', async () => {
    const real = G.criarDbFalso();
    const ruim = { fornecedores: { docs: [[COL, 'unidades', { externos: [{ produtos: [{ id: 'x' }] }], sem: { __SEM_PRODUTO__: 1 } }], [COL, 'valores', { ok: 1 }]] } };
    const res = await S.persistirFornecedores(real, ruim);
    expect(res.gravado).toBe(false); expect(res.erro).toMatch(/FIRESTORE_INCOMPATIVEL unidades.*NOME_DE_CAMPO_RESERVADO/); expect(real.st[COL]).toBeUndefined();
  });
  test('MUTANTE da lição: com o nome antigo "__SEM_PRODUTO__" o documento seria recusado (o teste acima o pegaria)', () => {
    const doc = { itens_sem_produto: { produtos: { __SEM_PRODUTO__: { liq_cents: [0] } } } };
    expect(C.problemasFirestore(doc)).not.toEqual([]);
  });
});
