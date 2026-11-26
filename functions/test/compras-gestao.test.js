'use strict';
// COMPRAS — gestão interna: classificação de origem persistida (loja ativa), parâmetros por fornecedor (MANUAL × ESTIMADO), situação de
// pendências antigas, callables (autorização, validação estrita, versão, histórico append-only, auditoria) e isolamento só nas
// recomendações novas. Dados 100% FICTÍCIOS; sem rede.
const O = require('../lib/compras/origem');
const P = require('../lib/compras/parametrosFornecedor');
const G = require('../lib/comprasGestao');
const S = require('../lib/compras/snapshot');
const S13 = require('../lib/compras/sombra13');
const FinS = require('../lib/financeiro/sync');
const { criarFake } = require('./helpers/fakeFirestore');
const { gcFalso, dbFalso, massa } = require('./fixtures/financeiro-f2');
const X = require('./fixtures/compras-estoque-f0');

const AGORA = new Date('2026-11-26T15:00:00Z'), HOJE = '2026-11-26';
const ALFA = '9001', BETA = '9002';
let seq = 0;
const compra = (data, itens, o = {}) => { const id = o.id || String(7000 + (++seq)); const valor = itens.reduce((s, [, q, c = 10]) => s + q * c, 0);
  return { Compra: { id, codigo: o.codigo || id, data_emissao: data, nome_situacao: o.sit || 'Confirmada', fornecedor_id: o.forn === undefined ? ALFA : o.forn, modificado_em: (o.mod || data) + ' 10:00:00', valor_produtos: valor.toFixed(2), valor_frete: '0.00', valor_impostos: '0.00', desconto_valor: '0.00',
    produtos: itens.map(([produto_id, q, c = 10]) => ({ produto: { produto_id, quantidade: String(q), valor_custo: String(c) } })) } }; };
const mais = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// seis compras confirmadas do fornecedor ALFA, prazos de 10..20 dias, múltiplos de 10, a cada 30 dias
const historico = () => [0, 1, 2, 3, 4, 5].map(i => compra(mais('2026-03-01', i * 30), [['101', 20 + i * 10, 5], ['102', 50, 2]], { id: '50' + i, mod: mais('2026-03-01', i * 30 + 10 + i * 2) }));
const VELHA = () => compra('2026-02-01', [['101', 40, 5]], { id: '600', sit: 'A receber' });
const RECENTE = () => compra('2026-11-01', [['101', 7, 5]], { id: '601', sit: 'Em aberto' });
const SEM_PROVA = () => compra('2026-08-01', [['103', 1000, 3]], { id: '602', forn: BETA });
const todas = () => [...historico(), VELHA(), RECENTE(), SEM_PROVA()];
const indice = cs => cs.map(w => ({ id: w.Compra.id, codigo: w.Compra.codigo, fornecedor_id: w.Compra.fornecedor_id }));
const titulo = (id, cod, forn, venc = '2026-04-01') => ({ source_id: id, natureza: 'PAGAR', description: 'Compra de nº ' + cod, entity_type: 'FORNECEDOR', entity_id: forn, final_amount_cents: 1000, settled_flag: true, due_date: venc });
// comprovadas: as seis do histórico (30/60 dias) + a pendente antiga; 601 e 602 sem título
const titulos = () => [...historico().flatMap((w, i) => [30, 60].map(n => titulo('T' + i + '-' + n, w.Compra.codigo, ALFA, mais(w.Compra.data_emissao, n)))), titulo('T600', '600', ALFA)];

describe('origem: classificação persistida', () => {
  test('efetivo: título prevalece; confirmação só onde não há prova; recusa sempre isola', () => {
    expect(O.efetivo('COMPROVADA_TITULO')).toEqual({ nivel: 'COMPROVADA_TITULO', usar_em_decisao_automatica: true });
    expect(O.efetivo('SEM_PROVA')).toEqual({ nivel: 'SEM_PROVA', usar_em_decisao_automatica: false });
    expect(O.efetivo('CONFLITO', 'CONFIRMADA_LOJA')).toEqual({ nivel: 'CONFIRMADA_GESTOR', usar_em_decisao_automatica: true });
    expect(O.efetivo('COMPROVADA_TITULO', 'NAO_PERTENCE')).toEqual({ nivel: 'REJEITADA_GESTOR', usar_em_decisao_automatica: false });
  });
  test('título de outra loja nunca comprova; fornecedor divergente = CONFLITO', () => {
    const cs = indice([compra('2026-01-01', [['1', 1]], { id: '1' }), compra('2026-01-01', [['1', 1]], { id: '2' }), compra('2026-01-01', [['1', 1]], { id: '3' })]);
    const r = O.classificarPorTitulos({ compras: cs, titulos: [titulo('A', '1', ALFA), titulo('B', '2', ALFA), titulo('C', '3', BETA), { ...titulo('D', '2', ALFA), natureza: 'RECEBER' }], lojaPorTitulo: new Map([['A', '262759'], ['B', '111']]) });
    expect([...r.porCompra].map(([id, x]) => [id, x.nivel_automatico])).toEqual([['1', 'COMPROVADA_TITULO'], ['2', 'SEM_PROVA'], ['3', 'CONFLITO']]);
    expect(r.titulos).toEqual({ lidos: 3, outra_loja: 1, com_loja_no_registro: 1 });
  });
  const rodar = (db, o = {}) => O.persistirOrigem(db, { compras: indice(todas()), titulos: titulos(), agora: AGORA, runId: 'r', ...o });
  test('grava o contrato por compra e o controle em uma leitura; repetir não regrava; mapa vai como texto', async () => {
    const db = criarFake(); const a = await rodar(db);
    expect(a).toMatchObject({ gravado: true, alteradas: 9, resumo: { total: 9, liberadas: 7, isoladas: 2 } });
    const d = (await db.collection('compras_origem').doc('602').get()).data();
    expect(d).toMatchObject({ nivel: 'SEM_PROVA', usar_em_decisao_automatica: false, loja: '262759', criterio: 'TITULO_A_PAGAR', confirmacao_manual: null });
    expect(d.atualizadoEm).toBeTruthy();
    const c = (await db.collection('compras_origem_controle').doc('atual').get()).data();
    expect(typeof c.compras_json).toBe('string'); expect(Object.values(c).some(v => v && typeof v === 'object' && v['602'])).toBe(false);
    expect([...(await O.lerControle(db)).isoladas].sort()).toEqual(['601', '602']);
    expect((await rodar(db)).alteradas).toBe(0);
    const t = await rodar(db, { titulos: [...titulos(), titulo('T602', '602', BETA)] });
    expect(t).toMatchObject({ alteradas: 1, resumo: { isoladas: 1 } });
  });
  test('proteções: leitura vazia, nenhuma comprovada ou queda brusca não gravam nada', async () => {
    const db = criarFake();
    expect(await rodar(db, { titulos: [] })).toEqual({ gravado: false, motivo: 'DADOS_INSUFICIENTES' });
    expect(await rodar(db, { titulos: [titulo('Z', '999999', ALFA)] })).toMatchObject({ gravado: false, motivo: 'NENHUMA_COMPRA_COMPROVADA' });
    await rodar(db);
    expect(await rodar(db, { titulos: titulos().slice(0, 2) })).toMatchObject({ gravado: false, motivo: 'QUEDA_SUSPEITA' });
    expect((await O.lerControle(db)).isoladas.size).toBe(2);
  });
  test('sem controle: indisponível e nada é isolado', async () => {
    const c = await O.lerControle(criarFake());
    expect(c).toMatchObject({ disponivel: false }); expect(O.isolarCompras(todas(), c.isoladas)).toHaveLength(9);
  });
  test('sync financeiro grava a origem sem GET a mais; falha na origem não derruba o financeiro', async () => {
    const dados = massa({ hoje: '2026-09-28', nPagar: 60, nReceber: 40 }); const quando = new Date('2026-09-28T15:00:00Z');
    dados.pagamentos = dados.pagamentos.map(t => ({ ...t, loja_id: '262759', nome_loja: 'Loja Fictícia' }));
    const rodarFin = async hook => { const db = dbFalso(); db.hook = hook; const gc = gcFalso(dados), logs = []; const r = await FinS.executarSyncFinanceiro({ cli: gc.cli, db, agora: quando, log: e => logs.push(e) }); return { db, r, logs, gc }; };
    const ok = await rodarFin(null);
    expect(ok.r.ok).toBe(true); const ev = ok.logs.find(e => e.evento === 'origem_compras'); expect(ev).toMatchObject({ status: 'OK' }); expect(ev.total).toBeGreaterThan(0);
    expect(Object.keys(ok.db.st.compras_origem).length).toBe(ev.total);
    expect(ok.gc.chamadas.every(c => c.method === 'GET' && !/loja_id=(?!262759)/.test(c.url))).toBe(true);
    const falha = await rodarFin(({ col }) => { if (col === 'compras_origem_controle') throw new Error('INDISPONIVEL'); });
    expect(falha.r.ok).toBe(true); expect(falha.logs.find(e => e.evento === 'origem_compras')).toMatchObject({ status: 'ERRO' });
    expect(falha.gc.chamadas.length).toBe(ok.gc.chamadas.length);
  });
});

describe('parâmetros: validação estrita e estimativas', () => {
  const v = (valores, fontes, pp) => P.validarParametros(valores, fontes, pp);
  test('recusa campo desconhecido, tipo errado, fonte ausente/inválida, máximo menor que o médio', () => {
    for (const [a, b, c] of [[{ x: 1 }, {}], [{ qtdMinima: '5' }, { qtdMinima: 'MANUAL' }], [{ qtdMinima: 0 }, { qtdMinima: 'MANUAL' }], [{ qtdMinima: 1.5 }, { qtdMinima: 'MANUAL' }], [{ qtdMinima: 5 }, {}], [{ qtdMinima: 5 }, { qtdMinima: 'CHUTE' }],
      [{}, { qtdMinima: 'MANUAL' }], [{ origem: 'LUA' }, { origem: 'MANUAL' }], [{ condicoesPagamento: '   ' }, { condicoesPagamento: 'MANUAL' }], [{ prazoMedioDias: 20, prazoMaxDias: 10 }, { prazoMedioDias: 'MANUAL', prazoMaxDias: 'MANUAL' }],
      [{ multiplosPorProduto: { 'a/b': 2 } }, {}, { multiplosPorProduto: { 'a/b': 'MANUAL' } }], [{ multiplosPorProduto: { 101: 2 } }, {}, {}], [{ multiplosPorProduto: [2] }, {}, {}]]) expect(v(a, b, c).erros.length).toBeGreaterThan(0);
  });
  test('documento completo conforme o contrato; mapa é ESTIMADO só se todos os itens forem', () => {
    const r = v({ prazoMedioDias: 12, multiplosPorProduto: { 101: 10, 102: 50 } }, { prazoMedioDias: 'MANUAL' }, { multiplosPorProduto: { 101: 'ESTIMADO', 102: 'MANUAL' } });
    expect(r.erros).toEqual([]);
    expect(Object.keys(r.doc).sort()).toEqual(['condicoesPagamento', 'confiabilidadePrazo', 'fontes', 'fontesPorProduto', 'frequenciaReposicaoDias', 'multiploPadrao', 'multiplosPorProduto', 'origem', 'prazoMaxDias', 'prazoMedioDias', 'qtdMinima', 'qtdMinimaPorProduto', 'valorMinimoCents']);
    expect(r.doc.fontes).toEqual({ prazoMedioDias: 'MANUAL', multiplosPorProduto: 'MANUAL' }); expect(r.doc.qtdMinima).toBeNull(); expect(r.doc.qtdMinimaPorProduto).toEqual({});
  });
  const base = () => todas().map(S.compactarCompra);
  const venc = new Map(historico().map(w => [w.Compra.id, [mais(w.Compra.data_emissao, 30), mais(w.Compra.data_emissao, 60)]]));
  test('estimativas com base e amostra', () => {
    const e = P.estimarParametros({ compras: base(), fornecedorId: ALFA, hoje: HOJE, vencimentos: venc, nome: 'Fornecedor Fictício Alfa' });
    expect(e.campos.prazoMedioDias).toMatchObject({ valor: 14, amostra: 6 }); expect(e.campos.prazoMaxDias.valor).toBe(20);
    expect(e.campos.confiabilidadePrazo.valor).toBe('MEDIA'); expect(e.campos.qtdMinima).toMatchObject({ valor: 70, amostra: 6 });
    expect(e.campos.valorMinimoCents.valor).toBe(20000); expect(e.campos.multiploPadrao.valor).toBe(10); expect(e.campos.frequenciaReposicaoDias.valor).toBe(30);
    expect(e.campos.condicoesPagamento.valor).toBe('2 parcela(s): vencimento típico em 30/60 dias da emissão');
    expect(e.campos.origem.valor).toBeNull();
    expect(e.produtos['102']).toMatchObject({ compras: 6, multiplosPorProduto: { valor: 50 }, qtdMinimaPorProduto: { valor: 50 } });
    for (const c of Object.values(e.campos)) expect(c.base.length).toBeGreaterThan(10);
  });
  test('dados insuficientes não viram valor; compra sem origem comprovada fica fora', () => {
    const e = P.estimarParametros({ compras: base(), fornecedorId: BETA, hoje: HOJE, nome: 'Fictícia Trading Co Ltd' });
    expect(e.campos.prazoMedioDias).toMatchObject({ valor: null, amostra: 0 }); expect(e.campos.qtdMinima.valor).toBeNull(); expect(e.campos.origem.valor).toBe('IMPORTADO');
    const x = P.estimarParametros({ compras: base(), fornecedorId: ALFA, hoje: HOJE, isoladas: new Set(['500', '501']) });
    expect(x.base).toMatchObject({ compras_confirmadas: 6, usadas: 4, excluidas_sem_origem: 2 }); expect(x.campos.prazoMedioDias.valor).toBeNull();
  });
});

// ── callables ───────────────────────────────────────────────────────────────────────────────────────────────────
async function ambiente({ classificar = true } = {}) {
  seq = 0; const db = criarFake();
  const produtos = [X.produto('101', { estoque: 0 }), X.produto('102', { estoque: 5 }), X.produto('103', { estoque: 2 })];
  const vendas = []; for (let n = 1; n <= 80; n += 2) vendas.push(X.venda(mais(HOJE, -n), [['101', 3], ['102', 1], ['103', 1]]));
  await S.persistirSnapshot(db, S.montarSnapshot({ brutosProdutos: produtos, brutosVendas: vendas, brutosCompras: todas(), agora: AGORA }));
  await db.collection('compras_n0_fornecedores').doc('nomes').set({ versao: 1, fornecedores: { [ALFA]: { nome: 'Fornecedor Fictício Alfa', ativo: true }, [BETA]: { nome: 'Fornecedor Fictício Beta', ativo: true } } });
  for (const [uid, u, s] of [['gestor', { role: 'gestor', ativo: true, nome: 'Gestora Teste' }, { admin: true }], ['semmodulo', { role: 'gestor', ativo: true }, { modulos: ['ponto'] }], ['bloqueado', { role: 'gestor', ativo: true }, { admin: true, bloqueado: true }],
    ['inativo', { role: 'gestor', ativo: false }, { admin: true }], ['func', { role: 'funcionario', ativo: true }, { modulos: ['estoque'] }], ['semperfil', { role: 'gestor', ativo: true }, null]]) { await db.collection('users').doc(uid).set(u); if (s) await db.collection('sistema_usuarios').doc(uid).set(s); }
  if (classificar) await O.persistirOrigem(db, { compras: indice(todas()), titulos: titulos(), agora: AGORA });
  const chamar = (h, data, uid = 'gestor') => G[h]({ auth: uid ? { uid } : null, data }, { db, now: () => AGORA });
  const ler = async (c, id) => (await db.collection(c).doc(id).get()).data();
  const col = async c => (await db.collection(c).get()).docs.map(d => [d.id, d.data()]);
  return { db, chamar, ler, col };
}
const erro = async (p, code, msg) => { await expect(p).rejects.toMatchObject({ code }); if (msg) await expect(p).rejects.toThrow(msg); };

describe('callables: autorização', () => {
  const casos = [['salvarParametrosHandler', { fornecedorId: ALFA, valores: {}, fontes: {}, versaoAnterior: 0 }], ['confirmarPendenciaHandler', { compraId: '600', status: 'PENDENTE', versaoAnterior: 0 }], ['confirmarOrigemHandler', { compraId: '602', decisao: 'CONFIRMADA_LOJA', observacao: 'conferido', versaoAnterior: 0 }], ['dadosHandler', { secao: 'ORIGEM' }]];
  test.each(casos)('%s: só gestor ativo, não bloqueado, com admin ou módulo estoque; nada é gravado na recusa', async (h, data) => {
    const a = await ambiente(); const antes = JSON.stringify([...a.db.dados].map(([k, m]) => [k, [...m]]));
    await erro(a.chamar(h, data, null), 'unauthenticated');
    for (const uid of ['semmodulo', 'bloqueado', 'inativo', 'func', 'semperfil', 'ninguem']) await erro(a.chamar(h, data, uid), 'permission-denied');
    expect(JSON.stringify([...a.db.dados].map(([k, m]) => [k, [...m]]))).toBe(antes);
  });
});

describe('callables: parâmetros', () => {
  const pedido = (o = {}) => ({ fornecedorId: ALFA, valores: { prazoMedioDias: 14, qtdMinima: 100 }, fontes: { prazoMedioDias: 'ESTIMADO', qtdMinima: 'MANUAL' }, versaoAnterior: 0, ...o });
  test('grava contrato, histórico e auditoria; repetição é idempotente; versão antiga é recusada', async () => {
    const a = await ambiente();
    expect(await a.chamar('salvarParametrosHandler', pedido())).toEqual({ ok: true, repetido: false, versao: 1 });
    const d = await a.ler('compras_fornecedor_parametros', ALFA);
    expect(d).toMatchObject({ prazoMedioDias: 14, qtdMinima: 100, prazoMaxDias: null, multiplosPorProduto: {}, fontes: { prazoMedioDias: 'ESTIMADO', qtdMinima: 'MANUAL' }, atualizadoPorUid: 'gestor', versao: 1 }); expect(d).toHaveProperty('atualizadoEm');
    expect(await a.chamar('salvarParametrosHandler', pedido())).toMatchObject({ repetido: true, versao: 1 });
    await erro(a.chamar('salvarParametrosHandler', pedido({ valores: { qtdMinima: 5 }, fontes: { qtdMinima: 'MANUAL' } })), 'failed-precondition', 'VERSAO_DESATUALIZADA');
    expect(await a.chamar('salvarParametrosHandler', pedido({ valores: { qtdMinima: 5 }, fontes: { qtdMinima: 'MANUAL' }, versaoAnterior: 1 }))).toMatchObject({ versao: 2 });
    expect((await a.col(`compras_fornecedor_parametros/${ALFA}/historico`)).map(([id, h]) => [id, h.qtdMinima])).toEqual([['0000001', 100], ['0000002', 5]]);
    const aud = await a.col('audit_log'); expect(aud).toHaveLength(2); expect(aud[1][1]).toMatchObject({ category: 'PURCHASING', action: 'SUPPLIER_PARAMS_SAVED', actorUid: 'gestor', entityId: ALFA });
  });
  test('ESTIMADO precisa bater com a sugestão do servidor; payload estrito; fornecedor desconhecido', async () => {
    const a = await ambiente();
    await erro(a.chamar('salvarParametrosHandler', pedido({ valores: { prazoMedioDias: 3 }, fontes: { prazoMedioDias: 'ESTIMADO' } })), 'failed-precondition', 'SUGESTAO_MUDOU');
    await erro(a.chamar('salvarParametrosHandler', { ...pedido(), atualizadoPorUid: 'outro' }), 'invalid-argument');
    await erro(a.chamar('salvarParametrosHandler', pedido({ fornecedorId: '../x' })), 'invalid-argument');
    await erro(a.chamar('salvarParametrosHandler', pedido({ fornecedorId: '123456', fontes: { prazoMedioDias: 'MANUAL', qtdMinima: 'MANUAL' } })), 'not-found');
    expect(await a.col('compras_fornecedor_parametros')).toEqual([]); expect(await a.col('audit_log')).toEqual([]);
  });
});

describe('callables: pendências antigas', () => {
  test('só pendente antiga; observação obrigatória nas decisões; histórico append-only; nada do ERP/base muda', async () => {
    const a = await ambiente(); const base = JSON.stringify(await a.col('compras_n0_base')), view = JSON.stringify(await a.col('compras_n0_view'));
    const p = (o = {}) => ({ compraId: '600', status: 'RECEBIDA', observacao: 'conferido na nota fictícia', versaoAnterior: 0, ...o });
    await erro(a.chamar('confirmarPendenciaHandler', p({ observacao: '' })), 'invalid-argument');
    await erro(a.chamar('confirmarPendenciaHandler', p({ status: 'ENTREGUE' })), 'invalid-argument');
    await erro(a.chamar('confirmarPendenciaHandler', p({ observacao: 'x'.repeat(501) })), 'invalid-argument');
    await erro(a.chamar('confirmarPendenciaHandler', p({ compraId: '601' })), 'failed-precondition', 'COMPRA_NAO_E_PENDENTE_ANTIGA');
    await erro(a.chamar('confirmarPendenciaHandler', p({ compraId: '500' })), 'failed-precondition');
    await erro(a.chamar('confirmarPendenciaHandler', p({ compraId: '404' })), 'not-found');
    expect(await a.chamar('confirmarPendenciaHandler', p())).toMatchObject({ versao: 1 });
    expect(await a.chamar('confirmarPendenciaHandler', p())).toMatchObject({ repetido: true });
    await erro(a.chamar('confirmarPendenciaHandler', p({ status: 'CANCELADA' })), 'failed-precondition', 'VERSAO_DESATUALIZADA');
    expect(await a.chamar('confirmarPendenciaHandler', p({ status: 'AGUARDANDO_CONFERENCIA', observacao: undefined, versaoAnterior: 1 }))).toMatchObject({ versao: 2 });
    expect(await a.ler('compras_pendencias_confirmacao', '600')).toMatchObject({ status: 'AGUARDANDO_CONFERENCIA', observacao: null, atualizadoPorUid: 'gestor', versao: 2, situacaoErp: 'A receber' });
    expect((await a.col('compras_pendencias_confirmacao/600/historico')).map(([, h]) => h.status)).toEqual(['RECEBIDA', 'AGUARDANDO_CONFERENCIA']);
    expect((await a.col('audit_log')).every(([, x]) => !JSON.stringify(x).includes('nota fictícia'))).toBe(true);
    expect(JSON.stringify(await a.col('compras_n0_base'))).toBe(base); expect(JSON.stringify(await a.col('compras_n0_view'))).toBe(view);
  });
});

describe('callables: origem', () => {
  test('confirmar libera, recusar isola, voltar desfaz; a sincronização preserva a decisão', async () => {
    const a = await ambiente(); const p = (o = {}) => ({ compraId: '602', decisao: 'CONFIRMADA_LOJA', observacao: 'nota fictícia da loja', versaoAnterior: 0, ...o });
    await erro(a.chamar('confirmarOrigemHandler', p({ compraId: '500' })), 'failed-precondition', 'JA_COMPROVADA');
    await erro(a.chamar('confirmarOrigemHandler', p({ observacao: '' })), 'invalid-argument');
    await erro(a.chamar('confirmarOrigemHandler', p({ decisao: 'VOLTAR_AUTOMATICO' })), 'failed-precondition');
    expect(await a.chamar('confirmarOrigemHandler', p())).toMatchObject({ versao: 1, nivel: 'CONFIRMADA_GESTOR', usar_em_decisao_automatica: true });
    expect(await a.chamar('confirmarOrigemHandler', p())).toMatchObject({ repetido: true });
    await O.persistirOrigem(a.db, { compras: indice(todas()), titulos: [...titulos(), titulo('T601', '601', ALFA)], agora: AGORA });
    expect(await a.ler('compras_origem', '602')).toMatchObject({ nivel: 'CONFIRMADA_GESTOR', usar_em_decisao_automatica: true, nivel_automatico: 'SEM_PROVA', confirmacao_manual: { decisao: 'CONFIRMADA_LOJA' } });
    expect([...(await O.lerControle(a.db)).isoladas]).toEqual([]);
    expect(await a.chamar('confirmarOrigemHandler', p({ decisao: 'VOLTAR_AUTOMATICO', observacao: undefined, versaoAnterior: 1 }))).toMatchObject({ versao: 2, usar_em_decisao_automatica: false });
    expect(await a.chamar('confirmarOrigemHandler', p({ decisao: 'NAO_PERTENCE', versaoAnterior: 2 }))).toMatchObject({ nivel: 'REJEITADA_GESTOR' });
    expect(await a.col('compras_origem_confirmacao/602/historico')).toHaveLength(3); expect(await a.col('audit_log')).toHaveLength(3);
  });
  test('sem classificação não há o que confirmar', async () => {
    const a = await ambiente({ classificar: false });
    await erro(a.chamar('confirmarOrigemHandler', { compraId: '602', decisao: 'CONFIRMADA_LOJA', observacao: 'conferido', versaoAnterior: 0 }), 'failed-precondition', 'ORIGEM_NAO_CLASSIFICADA');
    expect(await a.chamar('dadosHandler', { secao: 'ORIGEM' })).toEqual({ disponivel: false, compras: [] });
  });
});

describe('callables: dados da tela', () => {
  test('fornecedores, pendências (impacto por estado, sem presumir recebimento) e origem', async () => {
    const a = await ambiente();
    const f = await a.chamar('dadosHandler', { secao: 'FORNECEDORES' });
    expect(f.fornecedores.map(x => x.id).sort()).toEqual([ALFA, BETA]);
    expect(f.fornecedores.find(x => x.id === BETA).estimativas.base).toMatchObject({ excluidas_sem_origem: 1, usadas: 0 });
    const p = await a.chamar('dadosHandler', { secao: 'PENDENCIAS' });
    expect(p.compras.map(c => c.id)).toEqual(['600']);
    const c = p.compras[0];
    expect(c).toMatchObject({ numero: '600', fornecedor: 'Fornecedor Fictício Alfa', situacao_erp: 'A receber', unidades: 40, valor_cents: 20000, confirmacao: null, evidencias: { titulos: { vinculados: 1 } } });
    expect(c.itens[0]).toMatchObject({ produto_id: '101', codigo: 'COD-101', quantidade: 40 });
    expect(Object.keys(c.impacto)).toEqual(G.STATUS_PENDENCIA);
    expect(c.impacto.RECEBIDA.antes.unidades).toBeGreaterThan(c.impacto.RECEBIDA.depois.unidades); expect(c.impacto.RECEBIDA.hipotese).toBe(true);
    for (const s of ['PENDENTE', 'DUPLICADA', 'CANCELADA', 'AGUARDANDO_CONFERENCIA']) { expect(c.impacto[s].depois).toEqual(c.impacto[s].antes); expect(c.impacto[s].antes).toEqual(c.impacto.RECEBIDA.antes); }
    await a.chamar('confirmarPendenciaHandler', { compraId: '600', status: 'PENDENTE', versaoAnterior: 0 });
    expect((await a.chamar('dadosHandler', { secao: 'PENDENCIAS' })).compras[0]).toMatchObject({ confirmacao: { status: 'PENDENTE', quem: 'Gestora Teste' }, historico: [{ versao: 1 }] });
    const o = await a.chamar('dadosHandler', { secao: 'ORIGEM' });
    expect(o.compras.map(x => [x.id, x.nivel, x.usar_em_decisao_automatica]).sort()).toEqual([['601', 'SEM_PROVA', false], ['602', 'SEM_PROVA', false]]);
    expect(o.politica_vigente).toMatchObject({ versao: '1.2', confirmadas_isoladas: 1 });
    expect(o.compras.find(x => x.id === '602')).toMatchObject({ numero: '602', fornecedor: 'Fornecedor Fictício Beta', presente_na_base: true, data_emissao: '2026-08-01', situacao_erp: 'Confirmada', unidades: 1000, valor_cents: 300000, versao: 0, historico: [], titulos: { vinculados: 0 }, itens: [{ produto_id: '103', codigo: 'COD-103', quantidade: 1000, custo_unit_cents: 300 }] });
    await erro(a.chamar('dadosHandler', { secao: 'TUDO' }), 'invalid-argument');
  });
});

describe('isolamento só nas recomendações novas', () => {
  test('sombra 1.3: compra isolada sai de prazo/trânsito/fornecedor; a referência 1.2 não muda', async () => {
    const a = await ambiente(); const ent = await S13.lerEntradas(a.db);
    expect([...ent.comprasIsoladas].sort()).toEqual(['601', '602']);
    const com = S13.calcularSombra(ent), sem = S13.calcularSombra({ ...ent, comprasIsoladas: new Set() });
    expect(com.compras_isoladas_por_origem).toBe(2); expect(sem.compras_isoladas_por_origem).toBe(0);
    const l = (r, id) => r.linhas.find(x => x.product_id === id);
    expect(l(sem, '101').em_transito).toBe(7); expect(l(com, '101').em_transito).toBe(0);
    expect(l(sem, '103').prazo.fornecedor_id).toBe(BETA); expect(l(com, '103').prazo.fornecedor_id).toBeNull();
    expect(com.linhas.map(x => x.v12)).toEqual(sem.linhas.map(x => x.v12));
  });
  test('motor, política vigente e sync não leem a origem nem os parâmetros', () => {
    const fs = require('fs'), path = require('path');
    for (const f of ['motor.js', 'politica.js', 'snapshot.js', 'rentabilidade.js', 'historico.js', 'fornecedores.js']) expect(fs.readFileSync(path.join(__dirname, '../lib/compras', f), 'utf8')).not.toMatch(/compras_origem|compras_fornecedor_parametros|compras_pendencias_confirmacao|require\('\.\/(origem|parametrosFornecedor)'\)|comprasGestao/);
    expect(fs.readFileSync(path.join(__dirname, '../lib/comprasGestao.js'), 'utf8')).not.toMatch(/fetch\(|gestaoclick\.com|criarClienteGC/i);
  });
});
