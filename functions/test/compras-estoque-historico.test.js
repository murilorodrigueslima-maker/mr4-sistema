'use strict';
// HISTÓRICO DIÁRIO DE ESTOQUE — validação da origem, fluxos registrados/inferidos, idempotência, delta de custo e isolamento.
const S = require('../lib/compras/snapshot');
const H = require('../lib/compras/historico');
const { problemasFirestore } = require('../lib/compras/docCompat');
const X = require('./fixtures/compras-estoque-f0');
const G = require('./fixtures/compras-gc-falso');

const D0 = '2026-09-27', D1 = '2026-09-28', D2 = '2026-09-29';
const noite = d => new Date(d + 'T23:00:00Z');        // 20:00 em Fortaleza (último sync do dia)
const madrugada = d => new Date(d + 'T06:15:00Z');    // 03:15 em Fortaleza (completo)

const produtos = (estoques, extra = {}) => Object.entries(estoques).map(([id, q]) => X.produto(id, { estoque: q, ...(extra[id] || {}) }));
async function sync(db, agora, fonte) {
  const r = await S.executarSync({ cli: G.criarGcFalso(fonte).cli, db, agora });
  expect(r.erro || null).toBeNull();
  return r;
}
const doc = (db, id) => db.ler('estoque_historico', id);
const dia = (db, d) => db.ler('estoque_snapshots', d);
const copia = db => JSON.stringify({ h: db.st.estoque_historico, s: db.st.estoque_snapshots });

// cenário: D1 vende 3 de A (saldo 10→7, explicado), compra 5 de B (0→5, explicado) e C cai 4 sem registro (inferido)
const vendas = [X.venda(D1, [['PA', 3]], { id: 'VH-1' }), X.venda('2026-09-10', [['PA', 2], ['PB', 4]], { id: 'VH-0' }), X.venda(D1, [['PA', 9]], { id: 'VH-CANC', situacao: 'Cancelado' })];
const compras = [X.compra('2026-09-20', [['PB', 5]], { id: 'CH-1' }), X.compra(D1, [['PA', 100]], { id: 'CH-PEND', situacao: 'A receber' })];
compras[0].Compra.modificado_em = D1 + ' 10:00:00';                     // entrada reconhecida na data da confirmação
const fonteDe = (estoques, extra) => ({ produtos: produtos(estoques, extra), vendas, compras });

async function doisDias() {
  const db = G.criarDbFalso();
  await sync(db, noite(D0), fonteDe({ PA: 10, PB: 0, PC: 9 }));
  await sync(db, noite(D1), fonteDe({ PA: 7, PB: 5, PC: 5 }));
  const r = await sync(db, madrugada(D2), fonteDe({ PA: 7, PB: 5, PC: 5 }, { PC: { valor_custo: '2.50' } }));
  return { db, r };
}

describe('validação da origem', () => {
  const snap = (saldos, total = Object.keys(saldos).length) => ({ saldos, produtos_total: total });
  const cheio = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['P' + i, 5]));
  test('íntegra passa (com e sem referência)', () => {
    expect(H.validarOrigemEstoque(snap(cheio(100))).ok).toBe(true);
    expect(H.validarOrigemEstoque(snap(cheio(95)), snap(cheio(100))).ok).toBe(true);
  });
  test.each([
    ['LEITURA_VAZIA', snap({})],
    ['IDS_DUPLICADOS_OU_AUSENTES', snap(cheio(10), 12)],
    ['ID_INVALIDO', snap({ null: 1 })],
    ['SALDOS_ILEGIVEIS', snap({ ...cheio(50), P0: null })],
  ])('recusa %s', (motivo, s) => { const r = H.validarOrigemEstoque(s); expect(r.ok).toBe(false); expect(r.motivos).toContain(motivo); });
  test('recusa queda de produtos e saldos zerados em massa contra a referência', () => {
    expect(H.validarOrigemEstoque(snap(cheio(60)), snap(cheio(100))).motivos).toContain('QUEDA_DE_PRODUTOS');
    const zerado = Object.fromEntries(Object.keys(cheio(100)).map(k => [k, 0]));
    expect(H.validarOrigemEstoque(snap(zerado), snap(cheio(100))).motivos).toContain('SALDOS_ZERADOS_EM_MASSA');
  });
  test('leitura vazia no sync NÃO grava o dia (preserva o último válido do dia) e avisa', async () => {
    const db = G.criarDbFalso();
    await sync(db, noite(D0), fonteDe({ PA: 10, PB: 1 }));
    const antes = JSON.stringify(dia(db, D0));
    const r = await sync(db, new Date(D0 + 'T23:30:00Z'), { produtos: [], vendas, compras });
    expect(JSON.stringify(dia(db, D0))).toBe(antes);
    expect(r.snapshot.persistencia.estoque_dia).toMatchObject({ gravado: false });
    expect(r.snapshot.persistencia.avisos).toContain('ESTOQUE_DIA_NAO_GRAVADO');
  });
  test('catálogo parcial (queda > 30 %) em dia novo: o dia fica AUSENTE, não é gravado', async () => {
    const db = G.criarDbFalso(), todos = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['P' + i, 3]));
    await sync(db, noite(D0), fonteDe(todos));
    await sync(db, noite(D1), fonteDe(Object.fromEntries(Object.entries(todos).slice(0, 10))));
    expect(dia(db, D1)).toBeUndefined(); expect(dia(db, D0)).toBeDefined();
  });
});

describe('consolidação de dias fechados', () => {
  test('fluxo do dia: venda e entrada registradas; resíduo inferido; cancelada e pendente fora', async () => {
    const { db, r } = await doisDias();
    expect(r.snapshot.persistencia.historico).toMatchObject({ ok: true, dia_base: D1 });
    const d = dia(db, D1);
    expect(JSON.parse(d.fluxo_json)).toEqual({ v: { PA: 3 }, e: { PB: 5 }, aj: { PC: -4 } });
    expect(d.fluxo).toMatchObject({ origem: 'FECHAMENTO', anterior: D0, vendas_un: 3, entradas_un: 5, inferido_entrada_un: 0, inferido_saida_un: 4, produtos_com_ajuste: 1, fechamento_parcial: false });
    expect(d.saldos).toEqual({ PA: 7, PB: 5, PC: 5 });                       // saldo original intacto
  });
  test('primeiro dia sem anterior: nada é inferido (null), e o dia de hoje não é consolidado', async () => {
    const { db } = await doisDias();
    expect(dia(db, D0).fluxo).toMatchObject({ anterior: null, inferido_entrada_un: null, inferido_saida_un: null, produtos_com_ajuste: null });
    expect(dia(db, D2).fluxo).toBeUndefined();
  });
  test('resumo e métricas por produto: dias sem estoque, cobertura, risco, ruptura e série', async () => {
    const { db } = await doisDias();
    const res = doc(db, 'resumo'), p = doc(db, 'produtos');
    expect(res.dia_base).toBe(D1);
    expect(res.janela).toMatchObject({ dias_observados: 2, primeiro_dia: D0, dias_faltantes: [] });
    expect(res.avisos.join(' ')).toMatch(/não é contagem física/i);
    expect(res.serie.map(x => x.d)).toEqual([D0, D1]);
    expect(res.totais).toMatchObject({ produtos: 3, unidades_registradas: 17, inferido_saida_un: 4 });
    const linhas = JSON.parse(p.linhas_json).map(l => Object.fromEntries(p.colunas.map((c, i) => [c, l[i]])));
    const pb = linhas.find(l => l.id === 'PB');
    expect(pb).toMatchObject({ saldo: 5, obs: 2, sem: 1, sem_seguidos: 0, ent90: 5, vend90: 4, giro: null });
    expect(linhas.find(l => l.id === 'PC')).toMatchObject({ risco: 'SEM_DEMANDA', inf_sai: 4 });
  });
  test('nenhum valor em R$ nos documentos operacionais; capital só nos documentos de gestor', async () => {
    const { db } = await doisDias();
    for (const v of [doc(db, 'resumo'), doc(db, 'produtos'), doc(db, 'estado'), dia(db, D1)]) expect(JSON.stringify(v)).not.toMatch(/cents|capital|custo_cadastrado|valor_custo/);
    expect(doc(db, 'resumo_valor').atual.capital_cents).toBe(7 * 1000 + 5 * 1000 + 5 * 250);
    expect(JSON.parse(doc(db, 'valor_' + D0).custos_alterados_json)).toEqual({ PA: 1000, PB: 1000, PC: 1000 });   // primeiro fechamento: mapa completo
    expect(JSON.parse(doc(db, 'valor_' + D1).custos_alterados_json)).toEqual({ PC: 250 });                          // depois: só o que mudou
  });
  test('delta de custos: no dia seguinte só o que mudou; a série de capital acumula', async () => {
    const { db } = await doisDias();
    await sync(db, noite(D2), fonteDe({ PA: 7, PB: 5, PC: 5 }, { PC: { valor_custo: '2.50' } }));
    await sync(db, madrugada('2026-09-30'), fonteDe({ PA: 7, PB: 5, PC: 5 }, { PC: { valor_custo: '3.00' } }));
    expect(JSON.parse(doc(db, 'valor_' + D2).custos_alterados_json)).toEqual({ PC: 300 });
    expect(JSON.parse(doc(db, 'custos_vigentes').custos_json)).toEqual({ PA: 1000, PB: 1000, PC: 300 });
    expect(doc(db, 'resumo_valor').serie.map(x => x.d)).toEqual([D0, D1, D2]);
    expect(dia(db, D2).fluxo).toMatchObject({ vendas_un: 0, inferido_saida_un: 0, anterior: D1 });
  });
  test('idempotente por dia: novos syncs no mesmo dia não regravam nada (1 leitura)', async () => {
    const { db } = await doisDias(), antes = copia(db);
    const r = await S.executarSyncIncremental({ cli: G.criarGcFalso(fonteDe({ PA: 1, PB: 1, PC: 1 })).cli, db, agora: new Date(D2 + 'T12:15:00Z') });
    expect(r.snapshot.persistencia.historico).toMatchObject({ ok: true, pulado: 'JA_CONSOLIDADO', leituras: 1, escritas: 0 });
    const depois = JSON.parse(copia(db)), base = JSON.parse(antes);
    expect(depois.h).toEqual(base.h);
    expect(depois.s[D0]).toBe(base.s[D0]); expect(depois.s[D1]).toBe(base.s[D1]);
  });
  test('reprocessar (estado perdido) não altera dias já consolidados nem zera o delta de custos', async () => {
    const { db, r } = await doisDias();
    const valor = JSON.stringify(doc(db, 'valor_' + D1)), d1 = JSON.stringify(dia(db, D1));
    delete db.st.estoque_historico.estado;
    const x = await H.consolidarHistorico({ db, snap: r.snapshot, agora: madrugada(D2) });
    expect(x).toMatchObject({ ok: true, dias_consolidados: 0 });
    expect(JSON.stringify(doc(db, 'valor_' + D1))).toBe(valor); expect(JSON.stringify(dia(db, D1))).toBe(d1);
  });
  test('snapshots antigos (retroativo) usam só dias reais; buraco não é reconstruído nem inferido', async () => {
    const db = G.criarDbFalso();
    const velho = (d, saldos) => ({ schema_version: 1, data_comercial: d, gerado_em: d + 'T23:00:00.000Z', produtos_total: Object.keys(saldos).length, saldos, inativos: [] });
    await db.collection('estoque_snapshots').doc('2026-09-24').set(velho('2026-09-24', { PA: 20, PB: 0, PC: 9 }));
    await db.collection('estoque_snapshots').doc('2026-09-26').set(velho('2026-09-26', { PA: 15, PB: 0, PC: 9 }));
    await sync(db, noite(D1), fonteDe({ PA: 7, PB: 5, PC: 5 }));
    await sync(db, madrugada(D2), fonteDe({ PA: 7, PB: 5, PC: 5 }));
    expect(dia(db, '2026-09-25')).toBeUndefined(); expect(dia(db, D0)).toBeUndefined();
    expect(dia(db, '2026-09-26').fluxo).toMatchObject({ origem: 'RETROATIVO', anterior: null, inferido_saida_un: null });
    expect(dia(db, D1).fluxo).toMatchObject({ origem: 'FECHAMENTO', anterior: null });
    expect(doc(db, 'valor_2026-09-24')).toBeUndefined(); expect(doc(db, 'valor_2026-09-26')).toBeUndefined();   // capital de dia passado não é inventado
    expect(doc(db, 'resumo').janela).toMatchObject({ dias_observados: 3, dias_faltantes: ['2026-09-25', D0] });
    const l = JSON.parse(doc(db, 'produtos').linhas_json).find(x => x[0] === 'PB');
    expect(l[H.COLUNAS_PRODUTO.indexOf('sem')]).toBe(2); expect(l[H.COLUNAS_PRODUTO.indexOf('sem_seguidos')]).toBe(0);
  });
  test('falha na gravação do histórico não derruba o sync nem deixa estado parcial', async () => {
    const db = G.criarDbFalso();
    await sync(db, noite(D1), fonteDe({ PA: 7 }));
    const original = db.batch;
    db.batch = () => { const l = original(); const hist = []; return { ...l, set: (r, v) => { hist.push(r._c); l.set(r, v); }, commit: async () => { if (hist.includes('estoque_historico')) throw Object.assign(new Error('x'), { codigo: 'FALHA_SIMULADA' }); return l.commit(); } }; };
    const r = await sync(db, madrugada(D2), fonteDe({ PA: 7 }));
    expect(r.ok).toBe(true);
    expect(r.snapshot.persistencia.historico).toEqual({ ok: false, erro: 'FALHA_SIMULADA' });
    expect(Object.keys(db.st.estoque_historico)).toEqual(['estado']);          // só o ponteiro do ciclo anterior, sem avanço
    expect(doc(db, 'estado').verificado_ate).toBe(D0); expect(dia(db, D1).fluxo).toBeUndefined();
  });
});

describe('métricas e limites', () => {
  const politica = require('../lib/compras/politica').POLITICA_VIGENTE;
  const montarDias = (n, produtosN) => {
    const ids = Array.from({ length: produtosN }, (_, i) => String(70000000 + i));
    return Array.from({ length: n }, (_, k) => {
      const d = new Date(Date.UTC(2026, 6, 1 + k)).toISOString().slice(0, 10);
      const saldos = Object.fromEntries(ids.map((id, i) => [id, (i + k) % 7 === 0 ? 0 : 10 + (i % 50)]));
      const mov = Object.fromEntries(ids.filter((_, i) => i % 5 === 0).map(id => [id, 2]));
      return { dia: d, saldos, fluxo: { v: mov, e: {}, aj: mov }, resumo: { origem: 'FECHAMENTO', unidades_em_estoque: 1, sem_estoque: 1, vendas_un: 1, entradas_un: 0, inferido_entrada_un: 1, inferido_saida_un: 0, fechamento_parcial: false } };
    });
  };
  test('giro, excesso e risco usam a política vigente', () => {
    const dias = montarDias(20, 3).map(d => ({ ...d, saldos: { A: 1000, B: 2, C: 40 }, fluxo: { v: { A: 1, B: 1, C: 1 }, e: {}, aj: {} } }));
    const base = dias[dias.length - 1].dia;
    const movimentos = { vendas: new Map(dias.map(d => [d.dia, new Map([['A', 1], ['B', 1], ['C', 1]])])), entradas: new Map() };
    const porId = new Map(['A', 'B', 'C'].map(id => [id, { product_id: id, policy_velocity: 1, abc_revenue: 'A' }]));
    const m = Object.fromEntries(H.calcularMetricas({ diaBase: base, dias, movimentos, porId, politica }).map(x => [x.id, x]));
    expect(m.A).toMatchObject({ risco: 'EXCESSO', excesso_un: 1000 - politica.coverage_indicators.excess_above_days, cobertura: 1000 });
    expect(m.B).toMatchObject({ risco: 'CRITICO', excesso_un: 0 });
    expect(m.B.giro).toBeCloseTo(365 / 2, 1);
    expect(m.C.risco).toBe('OK');
  });
  test('escala real × 3 (2.500 produtos, 90 dias): documentos dentro do limite do Firestore', () => {
    const dias = montarDias(90, 2500), base = dias[89].dia;
    const movimentos = { vendas: new Map(), entradas: new Map() };
    const porId = new Map(Object.keys(dias[0].saldos).map(id => [id, { product_id: id, code: 'COD-' + id, policy_velocity: 0.4, abc_revenue: 'B' }]));
    const metricas = H.calcularMetricas({ diaBase: base, dias, movimentos, porId, politica });
    const resumo = H.montarResumo({ diaBase: base, dias, metricas, diasFaltantes: [], diasInvalidos: [], geradoEm: 'x', politicaVersao: politica.policy_version });
    const valor = H.montarValor({ diaBase: base, metricas, custosPorId: new Map(metricas.map(x => [x.id, 12345])), geradoEm: 'x' });
    const produtosDoc = { linhas_json: JSON.stringify(metricas.map(x => H.COLUNAS_PRODUTO.map(c => x[c]))) };
    for (const d of [resumo, produtosDoc, valor.doDia, valor.vigentes, valor.resumo]) expect(problemasFirestore(d)).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(resumo))).toBeLessThan(60 * 1024);
  });
});
