'use strict';
// Painel Comercial P0 — fidelidade dos dados: apuração, reconciliação, falhas, concorrência, TV × gestor. fetch SEMPRE mockado (nunca o GestãoClick real).
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const M = require('../lib/painelMetricas'); const SY = require('../lib/painelSync');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
jest.setTimeout(120000);
const root = path.resolve(__dirname, '../..');
const CFG = { metas: { ademir: 165000, fabiana: 75000 }, metaGeral: 240000 };
let seq = 1000;
const venda = (o = {}) => ({ id: String(++seq), situacao_id: '3952593', vendedor_id: '948278', data: '2026-10-10', valor_total: '100.00', valor_custo: '40.00', nome_vendedor: 'X', ...o });
const calc = (vendas, hojeStr = '2026-10-10', mes = '2026-10') => M.calcular({ vendas, hojeStr, mes, cfg: CFG });

describe('apuração (pura)', () => {
  test('Ademir, Fabiana, Outros e sem vendedor: soma exata e invariante', () => {
    const r = calc([venda({ vendedor_id: '948278', valor_total: '200.00' }), venda({ vendedor_id: '1080453', valor_total: '150.50' }), venda({ vendedor_id: '559684', valor_total: '99.99' }),
      venda({ vendedor_id: '', valor_total: '0.01' }), venda({ vendedor_id: undefined, valor_total: '10.00' })]);
    expect(r.ok).toBe(true);
    expect(r.ademir.totalMes).toBe(200); expect(r.fabiana.totalMes).toBe(150.5); expect(r.outros.totalMes).toBe(110); expect(r.outros.pedidosMes).toBe(3);
    expect(r.geral.totalMes).toBe(460.5); expect(r.centavos.geral).toBe(r.centavos.ademir + r.centavos.fabiana + r.centavos.outros);
    expect(r.qualidade.vendasSemVendedor).toBe(2);
  });
  test('NÃO depende de nome: nome "Ademir" com outro vendedor_id vai para Outros; nome diferente com o id certo fica com Ademir', () => {
    const r = calc([venda({ nome_vendedor: 'Ademir Santos', vendedor_id: '555' }), venda({ nome_vendedor: 'qualquer coisa', vendedor_id: '948278' })]);
    expect(r.ademir.pedidosMes).toBe(1); expect(r.outros.pedidosMes).toBe(1); expect(r.qualidade.vendedoresNaoMapeados).toBe(1);
  });
  test('deduplicação por id (mesmo pedido em páginas diferentes) e conflito de valor vira divergência', () => {
    const a = venda({ id: '777', valor_total: '50.00' });
    const r = calc([a, { ...a }, venda()]);
    expect(r.ok).toBe(true); expect(r.geral.pedidosMes).toBe(2); expect(r.qualidade.duplicidadesDetectadas).toBe(1);
    const c = calc([a, { ...a, valor_total: '60.00' }]);
    expect(c.ok).toBe(false); expect(c.erros.join()).toMatch(/DUPLICIDADE_CONFLITANTE/);
  });
  test('status: só concretizada entra; cancelada e outras ficam fora; canceladas contadas à parte', () => {
    const r = calc([venda({ valor_total: '100.00' }), venda({ situacao_id: '3952594', valor_total: '875.00' }), venda({ situacao_id: '3952591', valor_total: '10.00' }), venda({ situacao_id: '3952597', valor_total: '5.00' })]);
    expect(r.geral.totalMes).toBe(100); expect(r.cancelamentos).toEqual({ qtd: 1, valor: 875 }); expect(r.qualidade.naoConcretizadas).toBe(2);
  });
  test('mudança retroativa: venda cancelada depois sai do total na próxima apuração (recalculo integral)', () => {
    const v1 = venda({ id: 'R1', valor_total: '300.00' }), v2 = venda({ id: 'R2', valor_total: '100.00' });
    expect(calc([v1, v2]).geral.totalMes).toBe(400);
    expect(calc([{ ...v1, situacao_id: '3952594' }, v2]).geral.totalMes).toBe(100);
  });
  test('dinheiro em centavos: sem erro de ponto flutuante; inválido vira divergência', () => {
    const r = calc(Array.from({ length: 10 }, () => venda({ valor_total: '0.10' })).concat([venda({ valor_total: '0.20' })]));
    expect(r.geral.totalMes).toBe(1.2);                                       // 0,1×10+0,2 sem 1.2000000000000002
    expect(calc([venda({ valor_total: '12,50' })]).ok).toBe(false); expect(calc([venda({ valor_total: 'abc' })]).qualidade.valoresInvalidos).toBe(1);
  });
  test('dia/mês e fuso: "hoje" só da data informada; venda do mês anterior fora; virada de mês', () => {
    const vs = [venda({ data: '2026-10-10', valor_total: '10.00' }), venda({ data: '2026-10-09', valor_total: '20.00' }), venda({ data: '2026-09-30', valor_total: '30.00' })];
    const r = calc(vs, '2026-10-10');
    expect(r.geral.totalHoje).toBe(10); expect(r.geral.totalMes).toBe(30); expect(r.qualidade.foraDoPeriodo).toBe(1);
    const n = calc(vs, '2026-11-01', '2026-11');
    expect(n.geral.totalMes).toBe(0); expect(n.geral.pedidosMes).toBe(0);
  });
  test('metas: % e restante; Outros sem meta presumida; ticket sem divisão por zero', () => {
    const r = calc([venda({ valor_total: '16500.00' })]);
    expect(r.ademir).toMatchObject({ meta: 165000, pctMeta: 10, restante: 148500 });
    expect(r.geral).toMatchObject({ meta: 240000, pctMeta: 6.9 }); expect(r.outros).not.toHaveProperty('meta');
    expect(calc([]).geral.ticketMes).toBe(0);
  });
});

// ── Servidor GC falso ────────────────────────────────────────────────────────
function gcFalso({ conc = [], canc = [], porPagina = 2, falhaNaPagina = null, totalRegistrosErrado = false, chamadas = [] }) {
  return async (url) => {
    const u = new URL(url); chamadas.push(url);
    const sit = u.searchParams.get('situacao_id'), pag = Number(u.searchParams.get('pagina'));
    const lista = sit === '3952593' ? conc : sit === '3952594' ? canc : [];
    if (falhaNaPagina && sit === '3952593' && pag === falhaNaPagina) return { ok: false, status: 502, json: async () => ({}) };
    const tot = Math.max(1, Math.ceil(lista.length / porPagina));
    return { ok: true, status: 200, json: async () => ({ data: lista.slice((pag - 1) * porPagina, pag * porPagina), meta: { total_paginas: tot, total_registros: totalRegistrosErrado ? lista.length + 1 : lista.length, pagina_atual: pag } }) };
  };
}
const TOK = { access: 'a', secret: 's' };
const COLS = ['display_metrics', 'display_metrics_gestor', 'display_metrics_ctl', 'painel_config', 'painel_mapeamento'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const AGORA = new Date('2026-10-11T15:00:00Z');     // 12:00 em Fortaleza, 11/10
const sync = (f, extra = {}) => SY.sincronizar({ db, FieldValue, fetchImpl: f, agora: AGORA, tokens: TOK, ...extra });

describe('sincronização (emulador, GC falso)', () => {
  beforeEach(async () => {
    await limpar();
    await db.doc('painel_config/default').set({ vendedores: [{ nome: 'Ademir', meta: 165000 }, { nome: 'Fabiana', meta: 75000 }], meta_equipe: 240000 });
  });
  afterAll(limpar);
  const conc = () => [venda({ id: 'A1', valor_total: '200.00' }), venda({ id: 'F1', vendedor_id: '1080453', valor_total: '100.00' }), venda({ id: 'C1', vendedor_id: '1392140', valor_total: '400.00' }),
    venda({ id: 'A2', valor_total: '50.25', data: '2026-10-11' }), venda({ id: 'S1', vendedor_id: '', valor_total: '10.00' })];

  test('paginação (3 páginas), publica TV (formato antigo + novos campos) e Gestor; status OK; metas intactas', async () => {
    const metaAntes = JSON.stringify((await db.doc('painel_config/default').get()).data());
    const ch = [];
    const r = await sync(gcFalso({ conc: conc(), canc: [venda({ id: 'X9', situacao_id: '3952594', valor_total: '875.00' })], porPagina: 2, chamadas: ch }));
    expect(r.status).toBe('OK');
    expect(ch.filter(u => /situacao_id=3952593/.test(u) && /data_inicio=2026-10-01/.test(u)).length).toBe(3);   // 5 vendas / 2 por página (o histórico usa outros períodos)
    const tv = (await db.doc('display_metrics/painel_comercial').get()).data();
    expect(tv.equipe).toMatchObject({ totalMes: 760.25, pedidosMes: 5, totalHoje: 50.25, pedidosHoje: 1 });          // legado = GERAL
    expect(tv.vendedores.map(v => v.nome)).toEqual(['Ademir', 'Fabiana']);
    expect(tv.vendedores[0]).toMatchObject({ meta: 165000, totalMes: 250.25, pedidosMes: 2 });
    expect(tv.outros).toMatchObject({ totalMes: 410, pedidosMes: 2 });
    expect(tv.geral).toMatchObject({ meta: 240000, totalMes: 760.25 });
    expect(tv.qualidade).toMatchObject({ vendasSemVendedor: 1, duplicidadesDetectadas: 0, reconciliado: true });
    expect(tv.configuracao).toEqual({ metaEquipe: 240000 });
    expect(tv.vendedores[0].totalMes + tv.vendedores[1].totalMes + tv.outros.totalMes).toBeCloseTo(tv.geral.totalMes, 2);
    const st = (await db.doc('display_metrics/painel_status').get()).data();
    expect(st).toMatchObject({ status: 'OK', falhasConsecutivas: 0, intervaloMinutos: 5 }); expect(st.ultimoSucessoEm).toBeTruthy();
    expect(JSON.stringify((await db.doc('painel_config/default').get()).data())).toBe(metaAntes);
    const g = (await db.doc('display_metrics_gestor/painel').get()).data();
    expect(g.cancelamentos).toEqual({ qtd: 1, valor: 875 }); expect(g.custo).toHaveProperty('margemBruta'); expect(g.historico).toHaveLength(6);
  });
  test('TV NÃO contém custo, margem, desconto, cancelamento nem dados de venda (varredura profunda de chaves)', async () => {
    await sync(gcFalso({ conc: conc(), canc: [venda({ situacao_id: '3952594' })] }));
    const tv = (await db.doc('display_metrics/painel_comercial').get()).data();
    const chaves = []; (function varre(o, p = '') { Object.entries(o || {}).forEach(([k, v]) => { chaves.push(p + k); if (v && typeof v === 'object' && !v.toDate) varre(v, p + k + '.'); }); })(tv);
    expect(chaves.filter(k => /custo|margem|desconto|frete|cancel|cliente|produto|cpf|cnpj|valor_custo/i.test(k))).toEqual([]);
    const st = (await db.doc('display_metrics/painel_status').get()).data();
    expect(Object.keys(st).filter(k => /custo|margem|total|valor/i.test(k))).toEqual([]);
  });
  test('FALHA PARCIAL (página 2 com 502): preserva o último conjunto válido, registra a falha, não zera nada', async () => {
    await sync(gcFalso({ conc: conc(), porPagina: 2 }));
    const antes = JSON.stringify((await db.doc('display_metrics/painel_comercial').get()).data());
    const r = await sync(gcFalso({ conc: conc(), porPagina: 2, falhaNaPagina: 2 }), { agora: new Date(AGORA.getTime() + 6 * 60000), runId: 'r2', });
    expect(r).toMatchObject({ status: 'FALHA' });
    expect(JSON.stringify((await db.doc('display_metrics/painel_comercial').get()).data())).toBe(antes);
    const st = (await db.doc('display_metrics/painel_status').get()).data();
    expect(st).toMatchObject({ status: 'FALHA', falhasConsecutivas: 1, erro: 'GC_HTTP_502' }); expect(st.ultimoSucessoEm).toBeTruthy();
  }, 30000);
  test('divergência (total_registros ≠ recebido): NÃO publica; primeira execução sem dados não cria documento', async () => {
    const r = await sync(gcFalso({ conc: conc(), totalRegistrosErrado: true }));
    expect(r.status).toBe('DIVERGENCIA');
    expect((await db.doc('display_metrics/painel_comercial').get()).exists).toBe(false);
    expect((await db.doc('display_metrics/painel_status').get()).data().status).toBe('DIVERGENCIA');
  });
  test('valor inválido ou conflito de duplicidade ⇒ DIVERGENCIA (não publica números suspeitos)', async () => {
    expect((await sync(gcFalso({ conc: [venda({ valor_total: 'abc' })] }))).status).toBe('DIVERGENCIA');
    await db.doc('display_metrics_ctl/lease').delete();
    const a = venda({ id: 'D1', valor_total: '10.00' });
    expect((await sync(gcFalso({ conc: [a, { ...a, valor_total: '11.00' }], porPagina: 1 }))).status).toBe('DIVERGENCIA');
  });
  test('CONCORRÊNCIA: duas sincronizações simultâneas ⇒ uma executa, a outra recua', async () => {
    const base = gcFalso({ conc: conc() });
    const f = async (u, o) => { await new Promise(r => setTimeout(r, 80)); return base(u, o); };     // execução "lenta": a 2ª chega durante a 1ª
    const rs = await Promise.all([sync(f, { runId: 'a' }), sync(f, { runId: 'b' })]);
    expect(rs.map(x => x.status).sort()).toEqual(['OK', 'OUTRA_EXECUCAO_EM_ANDAMENTO']);
  });
  test('retroativo: venda cancelada depois da primeira sincronização some do total na seguinte', async () => {
    const lista = conc();
    await sync(gcFalso({ conc: lista }));
    expect((await db.doc('display_metrics/painel_comercial').get()).data().geral.totalMes).toBe(760.25);
    const depois = lista.filter(v => v.id !== 'C1');
    await sync(gcFalso({ conc: depois, canc: [lista.find(v => v.id === 'C1') && { ...lista.find(v => v.id === 'C1'), situacao_id: '3952594' }] }), { agora: new Date(AGORA.getTime() + 6 * 60000) });
    const tv = (await db.doc('display_metrics/painel_comercial').get()).data();
    expect(tv.geral.totalMes).toBe(360.25); expect(tv.outros.pedidosMes).toBe(1);
  });
  test('mapeamento auditado em painel_mapeamento é respeitado (id novo vira Ademir sem mexer em código)', async () => {
    await db.doc('painel_mapeamento/vendedores').set({ vendedores: { '948278': { chave: 'ademir', nomeConfig: 'Ademir' }, '1080453': { chave: 'fabiana', nomeConfig: 'Fabiana' }, '1392140': { chave: 'fabiana', nomeConfig: 'Fabiana' } } });
    await sync(gcFalso({ conc: conc() }));
    const tv = (await db.doc('display_metrics/painel_comercial').get()).data();
    expect(tv.vendedores[1].pedidosMes).toBe(2); expect(tv.outros.pedidosMes).toBe(1);
  });
});

describe('permissões TV × gestor (regras)', () => {
  let env;
  beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto-painel-test', firestore: { rules: fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8') } }); });
  afterAll(async () => { await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async c => {
      const x = c.firestore();
      await x.doc('users/tv').set({ role: 'display', ativo: true }); await x.doc('users/ges').set({ role: 'gestor', ativo: true }); await x.doc('users/fun').set({ role: 'funcionario', ativo: true, funcionarioId: 'F1' });
      await x.doc('display_metrics/painel_comercial').set({ equipe: { totalMes: 1 } }); await x.doc('display_metrics/painel_status').set({ status: 'OK' });
      await x.doc('display_metrics_gestor/painel').set({ custo: { mes: 1, margemBruta: 1 } });
      await x.doc('painel_mapeamento/vendedores').set({ a: 1 }); await x.doc('display_metrics_ctl/lease').set({ a: 1 });
    });
  });
  const ctx = uid => env.authenticatedContext(uid).firestore();
  test('conta display lê a TV e o status, mas NÃO o documento do gestor, nem configuração/mapeamento/lease', async () => {
    const tv = ctx('tv');
    await assertSucceeds(tv.doc('display_metrics/painel_comercial').get()); await assertSucceeds(tv.doc('display_metrics/painel_status').get());
    await assertFails(tv.doc('display_metrics_gestor/painel').get());
    await assertFails(tv.collection('display_metrics_gestor').get());
    await assertFails(tv.doc('painel_mapeamento/vendedores').get()); await assertFails(tv.doc('display_metrics_ctl/lease').get()); await assertFails(tv.doc('painel_config/default').get());
  });
  test('gestor lê TV e gestor; funcionário e anônimo não leem o gestor; ninguém escreve do cliente', async () => {
    const g = ctx('ges');
    await assertSucceeds(g.doc('display_metrics/painel_comercial').get()); await assertSucceeds(g.doc('display_metrics_gestor/painel').get());
    await assertFails(ctx('fun').doc('display_metrics_gestor/painel').get()); await assertFails(ctx('fun').doc('display_metrics/painel_comercial').get());
    await assertFails(env.unauthenticatedContext().firestore().doc('display_metrics_gestor/painel').get());
    for (const p of ['display_metrics/painel_comercial', 'display_metrics_gestor/painel', 'display_metrics/painel_status', 'painel_mapeamento/vendedores']) { await assertFails(g.doc(p).set({ x: 1 })); await assertFails(ctx('tv').doc(p).set({ x: 1 })); }
  });
});

describe('estático', () => {
  test('função agendada a cada 5 min, 1 instância; front sem "Ao vivo" fixo; sem GC no navegador', () => {
    const idx = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
    expect(idx).toMatch(/exports\.syncPainelDisplay = onSchedule\(\{\s*schedule:\s*'every 5 minutes'/); expect(idx).toMatch(/maxInstances:\s*1/);
    const h = fs.readFileSync(path.join(root, 'painel-comercial.html'), 'utf8');
    expect(h).toMatch(/DADOS DESATUALIZADOS/); expect(h).toMatch(/painel_status/);
    expect(h).not.toMatch(/gestaoclick|access-token|secret-access/i);
    expect(h).not.toMatch(/valor_custo|margem|custo/i);
  });
});
