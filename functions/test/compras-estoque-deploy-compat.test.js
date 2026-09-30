'use strict';
// Política 1.2 — COMPATIBILIDADE DE DEPLOY E ROLLBACK, provada contra o CÓDIGO REAL DE PRODUÇÃO (4cc4f55, extraído do git):
// backend antigo × novo sobre o MESMO Firestore falso e a MESMA fonte falsa do GestãoClick (só GET).
// Regra de ouro: enquanto a Política 1.2 não for ativada, o novo backend grava a base no formato v1 (idêntico ao de produção);
// o rollback do backend nunca encontra base que não entenda. Ativar a 1.2 exige sync completo (incremental sobre base v1 falha FECHADO, sem tocar o ERP).
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const S = require('../lib/compras/snapshot');
const Pol = require('../lib/compras/politica');
const G = require('./fixtures/compras-gc-falso');
const D = require('./fixtures/compras-ui-dados');
const X = require('./fixtures/compras-rentabilidade-fx').X;

let OLD;
beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compras-old-'));
  const tar = execFileSync('git', ['archive', '4cc4f55', 'lib/compras'], { cwd: path.join(__dirname, '..'), maxBuffer: 1 << 26 });
  fs.writeFileSync(path.join(tmp, 'old.tar'), tar); execFileSync('tar', ['-xf', 'old.tar'], { cwd: tmp });
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(tmp, 'node_modules'));
  OLD = require(path.join(tmp, 'lib/compras/snapshot.js'));
});

const fonte = D.cenario(6), P12 = D.politica, P11 = Pol.POLITICA_1_1;
const T0 = X.AGORA, T1 = new Date(T0.getTime() + 3 * 3600e3), T2 = new Date(T0.getTime() + 6 * 3600e3);
const gc = () => G.criarGcFalso(fonte);
const meta = db => db.ler('compras_n0', 'meta');
const formatoAtivo = db => meta(db).base_ativa.formato;
const layoutAtivo = db => meta(db).base_ativa.layout || 1;
const slices = db => Object.entries(db.st.compras_n0_base || {}).map(([id, v]) => [id.replace(/^g\w+x[0-9a-f]{6}_/, ''), { ...JSON.parse(v), geracao: undefined }]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const semTempo = v => JSON.parse(JSON.stringify(v, (k, x) => (['gerado_em', 'ultima_sincronizacao_ok', 'ultima_tentativa', 'geracao', 'base_ativa', 'base_pendente', 'base_orfas', 'persistencia', 'ultima_reconciliacao_completa', 'run_id'].includes(k) ? undefined : x)));
const docsOperacionais = db => Object.fromEntries(['compras_n0', 'compras_n0_produtos', 'compras_n0_view', 'estoque_snapshots'].flatMap(c => Object.keys(db.st[c] || {}).map(id => [c + '/' + id, semTempo(db.ler(c, id))])));

describe('MATRIZ DE COMPATIBILIDADE (backend × política)', () => {
  test('M1 antigo(1.1) → novo(1.1): base do antigo é lida pelo novo; o novo grava o mesmo layout; o antigo volta a ler (rollback seguro)', async () => {
    const db = G.criarDbFalso();
    expect((await OLD.executarSync({ cli: gc().cli, db, agora: T0 })).ok).toBe(true); expect(layoutAtivo(db)).toBe(1);
    expect((await S.executarSyncIncremental({ cli: gc().cli, db, agora: T1, politica: P11 })).ok).toBe(true); expect(layoutAtivo(db)).toBe(1);
    const r = await OLD.executarSyncIncremental({ cli: gc().cli, db, agora: T2 }); expect(r.ok).toBe(true);                  // rollback do backend: lê o que o novo gravou
  });
  test('M2 novo(1.1) FULL grava IDÊNTICO ao de produção: mesmas fatias, mesmos documentos operacionais e de custo', async () => {
    const a = G.criarDbFalso(), b = G.criarDbFalso();
    await OLD.executarSync({ cli: gc().cli, db: a, agora: T0 }); await S.executarSync({ cli: gc().cli, db: b, agora: T0, politica: P11 });
    expect(layoutAtivo(b)).toBe(1); expect(meta(b).base_ativa.layout).toBeUndefined();
    expect(slices(b)).toEqual(slices(a));                                                   // bytes de fatia iguais: nenhum campo novo na base
    expect(docsOperacionais(b)).toEqual(docsOperacionais(a));
    expect(semTempo(b.ler('compras_n0_view', 'custos'))).toEqual(semTempo(a.ler('compras_n0_view', 'custos')));
  });
  test('M3 novo(1.1) × antigo: incremental do novo gera os MESMOS documentos que o incremental antigo (1.1 inalterada)', async () => {
    const a = G.criarDbFalso(), b = G.criarDbFalso();
    await OLD.executarSync({ cli: gc().cli, db: a, agora: T0 }); await S.executarSync({ cli: gc().cli, db: b, agora: T0, politica: P11 });
    await OLD.executarSyncIncremental({ cli: gc().cli, db: a, agora: T1 }); await S.executarSyncIncremental({ cli: gc().cli, db: b, agora: T1, politica: P11 });
    expect(docsOperacionais(b)).toEqual(docsOperacionais(a)); expect(slices(b)).toEqual(slices(a));
  });
  test('M4 ROLLBACK DO BACKEND com a 1.2 ativa: o backend ANTIGO LÊ a base da 1.2 (mesmo rótulo; campos extras ignorados), gera os mesmos documentos operacionais e regrava o layout 1', async () => {
    const db = G.criarDbFalso(), ref = G.criarDbFalso();
    expect((await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 })).ok).toBe(true);
    expect(formatoAtivo(db)).toBe('tuplas-json-v1'); expect(layoutAtivo(db)).toBe(2);                        // mesmo rótulo que produção entende
    expect(slices(db).every(([, d]) => d.formato === 'tuplas-json-v1')).toBe(true);
    await OLD.executarSync({ cli: gc().cli, db: ref, agora: T0 });                                           // referência: produção sobre a mesma fonte
    const r = await OLD.executarSyncIncremental({ cli: gc().cli, db, agora: T1 }); expect(r.ok).toBe(true); expect(meta(db).ultima_tentativa_ok).toBe(true);
    await OLD.executarSyncIncremental({ cli: gc().cli, db: ref, agora: T1 });
    expect(docsOperacionais(db)).toEqual(docsOperacionais(ref));                                              // o antigo, sobre a base da 1.2, = o antigo sobre a própria base
    expect(slices(db)).toEqual(slices(ref)); expect(layoutAtivo(db)).toBe(1);                                 // e devolve a base ao layout de produção
    expect((await OLD.executarSync({ cli: gc().cli, db, agora: T2 })).ok).toBe(true);                        // FULL antigo também passa
  });
  test('M4b depois do rollback (base no layout 1), reativar a 1.2 exige FULL: incremental 1.2 falha fechado, sem ERP; o FULL recupera', async () => {
    const db = G.criarDbFalso(); await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    await OLD.executarSyncIncremental({ cli: gc().cli, db, agora: T1 }); expect(layoutAtivo(db)).toBe(1);
    const g = gc(); const r = await S.executarSyncIncremental({ cli: g.cli, db, agora: T2, politica: P12 });
    expect(r.ok).toBe(false); expect(r.erro).toMatch(/BASE_V1_EXIGE_FULL/); expect(g.chamadas.length).toBe(0);
    expect((await S.executarSync({ cli: gc().cli, db, agora: T2, politica: P12 })).ok).toBe(true); expect(layoutAtivo(db)).toBe(2);
  });
  test('M5 novo(1.2) incremental sobre base do layout 1 (ativação antes do FULL): falha FECHADA, ZERO leituras no ERP, snapshot visível intacto', async () => {
    const db = G.criarDbFalso(); await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P11 });
    const antes = docsOperacionais(db), g = gc();
    const r = await S.executarSyncIncremental({ cli: g.cli, db, agora: T1, politica: P12 });
    expect(r.ok).toBe(false); expect(r.erro).toMatch(/BASE_V1_EXIGE_FULL/); expect(g.chamadas.length).toBe(0);
    expect(meta(db).erro).toBe('BASE_V1_EXIGE_FULL'); expect(docsOperacionais(db)).toEqual({ ...antes, 'compras_n0/meta': expect.anything() });
    expect(layoutAtivo(db)).toBe(1);
  });
  test('M6 novo(1.2) FULL após layout 1: passa para layout 2 com rentabilidade; depois o incremental 1.2 funciona e = FULL', async () => {
    const db = G.criarDbFalso(); await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P11 });
    await S.executarSyncIncremental({ cli: gc().cli, db, agora: T1, politica: P12 });                      // falha (M5)
    expect((await S.executarSync({ cli: gc().cli, db, agora: T1, politica: P12 })).ok).toBe(true); expect(layoutAtivo(db)).toBe(2);
    expect(db.ler('compras_n0_view', 'custos').resumo_financeiro).toBeTruthy();
    const f1 = G.financeiroPersistido(db);
    expect((await S.executarSyncIncremental({ cli: gc().cli, db, agora: T2, politica: P12 })).ok).toBe(true);
    const f2 = G.financeiroPersistido(db); expect(JSON.stringify(f2.view_custos.resumo_financeiro)).toBe(JSON.stringify(f1.view_custos.resumo_financeiro));
  });
  test('M7 rollback de POLÍTICA (1.2 → 1.1) com base de layout 2 ativa: o novo backend lê o layout 2 e volta a gravar o layout 1; telas perdem as colunas financeiras', async () => {
    const db = G.criarDbFalso(); await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    const r = await S.executarSyncIncremental({ cli: gc().cli, db, agora: T1, politica: P11 }); expect(r.ok).toBe(true);
    expect(layoutAtivo(db)).toBe(1);
    expect(db.ler('compras_n0_view', 'custos').resumo_financeiro).toBeUndefined();
    expect(JSON.stringify(db.ler('compras_n0_view', 'custos'))).not.toMatch(/"fin"|"revisao"/);
  });
  test('M8 leitura da base de produção continua compatível (carregarBase do novo lê a base antiga)', async () => {
    const db = G.criarDbFalso(); await OLD.executarSync({ cli: gc().cli, db, agora: T0 });
    const n = await S.carregarBase(db), o = await OLD.carregarBase(db);
    expect(n.layout).toBe(1); expect(n.vendas.map(v => v.id)).toEqual(o.vendas.map(v => v.id)); expect(n.compras.length).toBe(o.compras.length);
  });
  test('M9 a base do layout 2 lida pelo backend ANTIGO traz as mesmas vendas/compras (id, itens, quantidades, totais, custo, fornecedor, flag de frete) que a lida pelo novo', async () => {
    const db = G.criarDbFalso(); await S.executarSync({ cli: gc().cli, db, agora: T0, politica: P12 });
    const n = await S.carregarBase(db), o = await OLD.carregarBase(db);
    const v = l => JSON.stringify(l.map(x => [x.id, x.data, x.nome_situacao, x.situacao_estoque, x.modificado_em, x.produtos.map(i => [i.produto_id, i.quantidade, i.valor_total])]));
    expect(v(o.vendas)).toBe(v(n.vendas));
    const c = l => JSON.stringify(l.map(x => [x.id, x.data_emissao, x.nome_situacao, x.fornecedor_id, x.modificado_em, x.produtos.map(i => [i.produto_id, i.quantidade, i.valor_custo])]));
    expect(c(o.compras)).toBe(c(n.compras));
    const flag = l => JSON.stringify(l.map(x => [x.id, !!x.valor_frete]));                                       // o antigo só enxerga o flag 1/0 (frete OU impostos)
    expect(flag(o.compras)).toBe(JSON.stringify(n.compras.map(x => [x.id, !!(Number(x.valor_frete) || Number(x.valor_impostos))])));
  });
});

describe('layout 1 x layout 2 (tuplas)', () => {
  test('layout 1 = tupla de produção; layout 2 só ACRESCENTA ao fim (posição 5 segue sendo o flag 1/0); decodificação de ambos', () => {
    const v = { id: 'V1', data: '2026-09-01', nome_situacao: 'Concretizada', situacao_estoque: '1', modificado_em: 'x', valor_produtos: '100.00', desconto_valor: '5.00', desconto_porcentagem: null, produtos: [{ produto_id: 'P', quantidade: '2', valor_total: '95.00', valor_custo: '10.00', valor_venda: null }] };
    const v1 = S.codificarVenda(v, 1), v2 = S.codificarVenda(v, 2);
    expect(v1).toEqual(['V1', '2026-09-01', 'Concretizada', '1', 'x', [['P', '2', '95.00']]]);
    expect(v2.slice(0, 5)).toEqual(v1.slice(0, 5)); expect(v2[5].map(i => i.slice(0, 3))).toEqual(v1[5]); expect(v2.length).toBeGreaterThan(6);   // prefixo idêntico
    expect(S.decodificarVenda(v2)).toEqual(v);
    const c = { id: 'C1', data_emissao: '2026-09-01', nome_situacao: 'Confirmada', fornecedor_id: 'F', modificado_em: 'y', valor_frete: '0.00', valor_impostos: '0.00', valor_produtos: '100.00', desconto_valor: null, produtos: [{ produto_id: 'P', quantidade: '1', valor_custo: '10.00' }] };
    const c1 = S.codificarCompra(c, 1), c2 = S.codificarCompra(c, 2);
    expect(c1).toEqual(['C1', '2026-09-01', 'Confirmada', 'F', 'y', 0, [['P', '1', '10.00']]]);                 // frete 0,00 não vira "tem frete"
    expect(c2.slice(0, 7)).toEqual(c1.slice(0, 7));                                                                // o antigo lê só as 7 primeiras posições: idênticas
    expect(S.codificarCompra({ ...c, valor_frete: '12.50' }, 1)[5]).toBe(1); expect(S.codificarCompra({ ...c, valor_frete: '12.50' }, 2)[5]).toBe(1);
    expect(S.decodificarCompra(S.codificarCompra({ ...c, valor_frete: '12.50' }, 2)).valor_frete).toBe('12.50');   // layout 2 preserva o valor
    expect(S.decodificarCompra(S.codificarCompra({ ...c, valor_frete: '12.50' }, 1)).valor_frete).toBe('1');        // layout 1: só o flag
    expect(S.layoutDaPolitica(Pol.POLITICA_1_1)).toBe(1); expect(S.layoutDaPolitica(Pol.POLITICA_1_0)).toBe(1); expect(S.layoutDaPolitica(P12)).toBe(2);
    expect(S.FORMATO_BASE).toBe('tuplas-json-v1');                                                                 // mesmo rótulo que produção aceita
  });
});
