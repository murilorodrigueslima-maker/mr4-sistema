'use strict';
// Painel Comercial P1 — calendário, ritmo, projeção, comparativo, documento da TV, lógica do front e segurança. fetch mockado; sem GestãoClick real.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const C = require('../lib/painelCalendario'); const SY = require('../lib/painelSync'); const { CAL } = require('../scripts/painel_calendario');
const T = require('../../js/painel-tv-logic.js');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
jest.setTimeout(120000);
const root = path.resolve(__dirname, '../..');

describe('calendário comercial', () => {
  test('pesos: seg–sex 1,0; sábado 3,5/9; domingo 0; feriado FECHADO 0; NORMAL e REDUZIDO por horas; exceção vence', () => {
    expect(C.diaComercial(CAL, '2026-10-07').peso).toBe(1);                       // quarta
    expect(C.diaComercial(CAL, '2026-10-10').peso).toBeCloseTo(3.5 / 9, 6);       // sábado
    expect(C.diaComercial(CAL, '2026-10-11').peso).toBe(0);                       // domingo
    expect(C.diaComercial(CAL, '2026-10-12')).toMatchObject({ peso: 0, motivo: expect.stringMatching(/FERIADO/) });   // N.Sra. Aparecida
    expect(C.diaComercial(CAL, '2026-04-21').peso).toBe(1);                       // Tiradentes: loja vendeu ⇒ NORMAL
    expect(C.diaComercial(CAL, '2026-02-18').peso).toBeCloseTo(4 / 9, 6);         // quarta de cinzas reduzido
    const c2 = { ...CAL, excecoes: [{ data: '2026-10-12', horas: 4.5, nome: 'aberto' }] };
    expect(C.diaComercial(c2, '2026-10-12').peso).toBeCloseTo(0.5, 6);
    expect(C.diaComercial(null, '2026-10-12').peso).toBe(1);                      // sem calendário: padrão da semana, sem feriados
  });
  test('dias úteis equivalentes de outubro/2026 e fração do expediente do dia', () => {
    const t = C.diasDoMes(CAL, '2026-10').reduce((a, d) => a + d.peso, 0);
    expect(t).toBeCloseTo(21 + 5 * 3.5 / 9, 6);                                   // 22 úteis − feriado 12/10 + 5 sábados
    expect(C.fracaoHoje(CAL, '2026-10-07', '08:30')).toBe(0); expect(C.fracaoHoje(CAL, '2026-10-07', '13:00')).toBeCloseTo(0.5, 6); expect(C.fracaoHoje(CAL, '2026-10-07', '20:00')).toBe(1);
    expect(C.fracaoHoje(CAL, '2026-10-11', '12:00')).toBe(0);                     // domingo
  });
});

describe('ritmo e projeção', () => {
  const base = { cfg: CAL, mes: '2026-10', meta: 240000 };
  test('exemplo real: 11/10 12:00, R$ 58.414,05 ⇒ média por dia equivalente, meta necessária e projeção; acumulado ≠ diário', () => {
    const r = C.ritmoEProjecao({ ...base, hojeStr: '2026-10-11', hora: '12:00', acumulado: 58414.05 });
    expect(r.diasEquivalentesDecorridos).toBeCloseTo(7.78, 2); expect(r.diasEquivalentesRestantes).toBeCloseTo(15.17, 2);
    expect(r.mediaPorDiaUtil).toBeCloseTo(58414.05 / 7.7778, 0); expect(r.metaNecessariaPorDiaUtil).toBeCloseTo((240000 - 58414.05) / 15.1667, 0);
    expect(r.projecaoFechamento).toBeCloseTo(58414.05 + 15.1667 * (58414.05 / 7.7778), -1);
    expect(r).toMatchObject({ confiabilidade: 'MEDIA', estimativa: true, situacao: 'ABAIXO' });
  });
  test('início do mês: sem base ⇒ sem projeção (nada de números absurdos); 1–3 dias ⇒ BAIXA', () => {
    const a = C.ritmoEProjecao({ ...base, hojeStr: '2026-10-01', hora: '09:00', acumulado: 500 });
    expect(a.confiabilidade).toBe('INSUFICIENTE'); expect(a.projecaoFechamento).toBeNull(); expect(a.mediaPorDiaUtil).toBeNull();
    const b = C.ritmoEProjecao({ ...base, hojeStr: '2026-10-02', hora: '17:30', acumulado: 18000 });
    expect(b.confiabilidade).toBe('BAIXA'); expect(b.projecaoFechamento).toBeGreaterThan(0);
  });
  test('meta batida: restante 0 e necessária 0; mês encerrado: sem dias restantes ⇒ meta/dia nula (sem divisão por zero)', () => {
    expect(C.ritmoEProjecao({ ...base, hojeStr: '2026-10-20', hora: '10:00', acumulado: 250000 }).metaNecessariaPorDiaUtil).toBe(0);
    const fim = C.ritmoEProjecao({ ...base, hojeStr: '2026-10-31', hora: '23:00', acumulado: 200000 });
    expect(fim.diasEquivalentesRestantes).toBe(0); expect(fim.metaNecessariaPorDiaUtil).toBeNull();
  });
  test('domingo/feriado não geram dias previstos nem consomem ritmo', () => {
    const dom = C.ritmoEProjecao({ ...base, hojeStr: '2026-10-11', hora: '10:00', acumulado: 58414.05 });
    const sab = C.ritmoEProjecao({ ...base, hojeStr: '2026-10-10', hora: '17:30', acumulado: 58414.05 });
    expect(dom.diasEquivalentesDecorridos).toBeCloseTo(sab.diasEquivalentesDecorridos, 6);
  });
});

describe('comparativo com o mês anterior (mesmo período equivalente)', () => {
  const dias = {}; ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].forEach((d, i) => { dias[d] = { v: 100000 * (i + 1), p: i + 1 }; });   // R$ 1.000 … 5.000
  test('consome o mesmo nº de dias equivalentes; dia parcial é proporcional; sem série ⇒ null', () => {
    const c = C.comparativoMesAnterior({ cfg: CAL, mesAnterior: '2026-09', diasEquivalentesDecorridos: 2.5, diarioAnterior: dias, acumuladoAtual: 4000, pedidosAtual: 10 });
    expect(c.valor).toBe(1000 + 2000 + 3000 * 0.5);                                // 1 + 2 dias completos + metade do 3º
    expect(c).toMatchObject({ diferenca: -500, mes: '2026-09', estimativaProporcional: true });
    expect(C.comparativoMesAnterior({ cfg: CAL, mesAnterior: '2026-09', diasEquivalentesDecorridos: 2, diarioAnterior: null, acumuladoAtual: 1, pedidosAtual: 1 })).toBeNull();
  });
  test('feriado fechado do mês anterior não consome equivalência (07/09)', () => {
    const d = { '2026-09-04': { v: 100000, p: 1 }, '2026-09-05': { v: 100000, p: 1 }, '2026-09-07': { v: 0, p: 0 }, '2026-09-08': { v: 100000, p: 1 } };
    const c = C.comparativoMesAnterior({ cfg: CAL, mesAnterior: '2026-09', diasEquivalentesDecorridos: 1, diarioAnterior: d, acumuladoAtual: 0, pedidosAtual: 0 });
    expect(c.valor).toBe(0);                                                       // 1º dia útil do mês (01/09) vazio: nada vendido nas primeiras 1,0 equivalentes
  });
});

describe('documento da TV (sync com GC falso)', () => {
  const COLS = ['display_metrics', 'display_metrics_gestor', 'display_metrics_ctl', 'painel_config', 'painel_mapeamento', 'painel_calendario'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
  let seq = 5000; const v = (o = {}) => ({ id: String(++seq), situacao_id: '3952593', vendedor_id: '948278', data: '2026-10-09', valor_total: '100.00', valor_custo: '40.00', ...o });
  const fake = (conc, canc = [], extra = {}) => async (url) => { const u = new URL(url); const sit = u.searchParams.get('situacao_id'), ini = u.searchParams.get('data_inicio'), fim = u.searchParams.get('data_fim');
    const todos = sit === '3952593' ? conc : sit === '3952594' ? canc : [];
    const lista = todos.filter(x => x.data >= ini && x.data <= fim);
    return { ok: true, status: 200, json: async () => ({ data: lista, meta: { total_paginas: 1, total_registros: lista.length } }) }; };
  beforeEach(async () => { await limpar(); await db.doc('painel_config/default').set({ vendedores: [{ nome: 'Ademir', meta: 165000 }, { nome: 'Fabiana', meta: 75000 }], meta_equipe: 240000 }); await db.doc('painel_calendario/default').set(CAL); });
  afterAll(limpar);
  test('TV recebe série diária acumulada, calendário, ritmo, projeção e comparativo; sem custo/margem; Gestor recebe ritmo', async () => {
    const conc = [v({ data: '2026-10-01', valor_total: '1000.00' }), v({ data: '2026-10-02', valor_total: '2000.50' }), v({ data: '2026-10-09', valor_total: '500.00', vendedor_id: '1080453' }),
      v({ data: '2026-09-01', valor_total: '1000.00' }), v({ data: '2026-09-02', valor_total: '1000.00' }), v({ data: '2026-09-03', valor_total: '1000.00' })];
    const agora = new Date('2026-10-09T18:00:00Z');                                // 15:00 em Fortaleza, sexta
    const r = await SY.sincronizar({ db, FieldValue, fetchImpl: fake(conc), agora, tokens: { access: 'a', secret: 's' } });
    expect(r.status).toBe('OK');
    const tv = (await db.doc('display_metrics/painel_comercial').get()).data();
    expect(tv.schemaVersao).toBe(3);
    expect(tv.geral.totalMes).toBe(3500.5);
    expect(tv.serieDiaria[0]).toMatchObject({ d: '2026-10-01', v: 1000, a: 1000 }); expect(tv.serieDiaria[tv.serieDiaria.length - 1]).toMatchObject({ d: '2026-10-09', a: 3500.5 });
    expect(tv.serieDiaria.length).toBe(9);
    expect(tv.ritmo).toMatchObject({ estimativa: true }); expect(tv.ritmo.diasEquivalentesDecorridos).toBeGreaterThan(5);
    expect(tv.projecao.estimativa).toBe(true); expect(tv.calendario.dias.length).toBe(31); expect(tv.calendario.feriados.map(f => f.d)).toContain('2026-10-12');
    expect(tv.comparativoMesAnterior).toMatchObject({ mes: '2026-09', estimativaProporcional: true });
    const chaves = JSON.stringify(Object.keys(tv)) + JSON.stringify(Object.keys(tv.ritmo)) + JSON.stringify(Object.keys(tv.calendario));
    expect(chaves).not.toMatch(/custo|margem|desconto|cancel/i);
    const g = (await db.doc('display_metrics_gestor/painel').get()).data(); expect(g.ritmo).toBeTruthy(); expect(g.custo).toBeTruthy();
    expect(g.historico[g.historico.length - 1].diario).toBeTruthy();
  });
  test('totais continuam conciliados (soma das partes = geral) e a série acumulada fecha com o total do mês', async () => {
    const conc = [v({ data: '2026-10-01', valor_total: '10.10' }), v({ data: '2026-10-03', valor_total: '20.20', vendedor_id: '1080453' }), v({ data: '2026-10-05', valor_total: '0.30', vendedor_id: '999' })];
    await SY.sincronizar({ db, FieldValue, fetchImpl: fake(conc), agora: new Date('2026-10-08T15:00:00Z'), tokens: { access: 'a', secret: 's' } });
    const tv = (await db.doc('display_metrics/painel_comercial').get()).data();
    const soma = tv.vendedores[0].totalMes + tv.vendedores[1].totalMes + tv.outros.totalMes;
    expect(Math.round(soma * 100)).toBe(Math.round(tv.geral.totalMes * 100));
    expect(tv.serieDiaria[tv.serieDiaria.length - 1].a).toBe(tv.geral.totalMes);
  });
});

describe('lógica do front (puro)', () => {
  test('estado dos dados: ao vivo, atrasado, desatualizado, falha, indisponível, aguardando', () => {
    expect(T.estadoDados({ idadeMin: 3 })).toMatchObject({ nivel: 'ok', rotulo: 'Ao vivo' });
    expect(T.estadoDados({ idadeMin: 20 })).toMatchObject({ nivel: 'atrasado', cor: 'yellow' });
    expect(T.estadoDados({ idadeMin: 50 })).toMatchObject({ nivel: 'desatualizado', cor: 'red' });
    expect(T.estadoDados({ idadeMin: 5, status: 'FALHA' })).toMatchObject({ nivel: 'atrasado' });
    expect(T.estadoDados({ idadeMin: 20, status: 'DIVERGENCIA' })).toMatchObject({ nivel: 'desatualizado' });
    expect(T.estadoDados({ idadeMin: null })).toMatchObject({ nivel: 'aguardando' });
    expect(T.estadoDados({ erro: true, idadeMin: null })).toMatchObject({ nivel: 'indisponivel' });
    expect(T.estadoDados({ idadeMin: 3 }).rotulo).not.toMatch(/DESATUALIZADOS/);
  });
  test('ranking por faturamento, com destaque do MAIOR % da meta (não favorece meta menor/maior)', () => {
    const r = T.ranking([{ nome: 'Ademir', totalMes: 36234.28, meta: 165000 }, { nome: 'Fabiana', totalMes: 21779.77, meta: 75000 }]);
    expect(r.map(x => x.nome)).toEqual(['Ademir', 'Fabiana']); expect(r[0].pctMeta).toBe(22); expect(r[1].pctMeta).toBe(29);
    expect(r.find(x => x.melhorPctMeta).nome).toBe('Fabiana');
  });
  test('delta só para aumentos de total agregado; gráfico: acumulado real, meta esperada por peso e projeção só com base', () => {
    expect(T.delta(100, 100)).toBe(0); expect(T.delta(100, 99)).toBe(0); expect(T.delta(100, 150.5)).toBe(50.5);
    const dias = [1, 2, 3, 4].map(i => ({ d: '2026-10-0' + i, peso: i === 3 ? 0 : 1 }));
    const g = T.grafico({ calendario: { dias }, serieDiaria: [{ d: '2026-10-01', a: 10 }, { d: '2026-10-02', a: 30 }], meta: 90, hojeStr: '2026-10-02', ritmo: { mediaPorDiaUtil: 15, confiabilidade: 'MEDIA' } });
    expect(g.real.map(p => p.v)).toEqual([10, 30]); expect(g.esperado.map(p => p.v)).toEqual([30, 60, 60, 90]);
    expect(g.projecao).toEqual([{ i: 2, v: 30 }, { i: 3, v: 30 }, { i: 4, v: 45 }]);
    expect(T.grafico({ calendario: { dias }, serieDiaria: [{ d: '2026-10-01', a: 10 }], meta: 90, hojeStr: '2026-10-01', ritmo: { confiabilidade: 'INSUFICIENTE' } }).projecao).toEqual([]);
  });
  test('comparativo textual e formatação', () => {
    expect(T.textoComparativo(null).valor).toBe('—');
    const t = T.textoComparativo({ valor: 1000, diferenca: -250, variacaoPct: -25 });
    expect(t.detalhe).toMatch(/−.*250.*−25/); expect(t.positivo).toBe(false);
  });
});

describe('segurança e estático', () => {
  let env;
  beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto-p1-test', firestore: { rules: fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8') } }); });
  afterAll(async () => { await env.cleanup(); });
  test('calendário só gestor; conta display lê só a TV e o status; gestor lê gestor', async () => {
    await env.withSecurityRulesDisabled(async c => { const x = c.firestore(); await x.doc('users/tv').set({ role: 'display', ativo: true }); await x.doc('users/g').set({ role: 'gestor', ativo: true });
      await x.doc('painel_calendario/default').set({ a: 1 }); await x.doc('display_metrics/painel_comercial').set({ a: 1 }); await x.doc('display_metrics_gestor/painel').set({ a: 1 }); });
    const tv = env.authenticatedContext('tv').firestore(), g = env.authenticatedContext('g').firestore();
    await assertSucceeds(tv.doc('display_metrics/painel_comercial').get());
    await assertFails(tv.doc('display_metrics_gestor/painel').get()); await assertFails(tv.doc('painel_calendario/default').get()); await assertFails(tv.doc('painel_calendario/default').set({ a: 2 }));
    await assertSucceeds(g.doc('painel_calendario/default').get()); await assertSucceeds(g.doc('display_metrics_gestor/painel').get());
  });
  test('preview: sem custo/margem, sem documento do gestor, sem credenciais GC, sem rolagem; produção intacta', () => {
    const h = fs.readFileSync(path.join(root, 'painel-comercial-preview.html'), 'utf8');
    expect(h).not.toMatch(/display_metrics_gestor|valor_custo|margem|custo|comiss|access-token|gestaoclick/i);
    expect(h).toMatch(/overflow:hidden/); expect(h).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    expect(h).toMatch(/display_metrics','painel_comercial'/); expect(h).toMatch(/painel_status/);
    expect(h).toMatch(/noindex/);
    const prod = fs.readFileSync(path.join(root, 'painel-comercial.html'), 'utf8');
    expect(prod).toMatch(/Painel Comercial — MR4 Distribuidora/); expect(prod).not.toMatch(/painel-tv-logic/);
  });
  test('P1.2: faltaEPorDia — falta, valor por dia útil, meta batida, sem meta e sem dias (sem divisão por zero)', () => {
    expect(T.faltaEPorDia(36234.28, 165000, 15.17)).toEqual({ falta: 128765.72, porDia: 8488.18, batida: false });
    expect(T.faltaEPorDia(21779.77, 75000, 15.17).falta).toBe(53220.23);
    expect(T.faltaEPorDia(80000, 75000, 10)).toEqual({ falta: 0, porDia: 0, batida: true });
    expect(T.faltaEPorDia(100, 0, 10)).toEqual({ falta: null, porDia: null, batida: false });
    expect(T.faltaEPorDia(100, 1000, 0).porDia).toBeNull();
    expect(T.faltaEPorDia(100, 1000, -1).porDia).toBeNull();
  });
  test('P1.2: avisoCalendario lista só datas não verificadas de hoje em diante', () => {
    const cal = { feriados: [{ d: '2026-10-12', nome: 'A', verificado: false, expediente: 'FECHADO' }, { d: '2026-10-30', nome: 'B', verificado: false, expediente: 'NORMAL' }, { d: '2026-10-05', nome: 'C', verificado: false, expediente: 'NORMAL' }, { d: '2026-10-20', nome: 'D', verificado: true, expediente: 'NORMAL' }] };
    expect(T.avisoCalendario(cal, '2026-10-12').map(x => x.dia)).toEqual(['12/10', '30/10']);
    expect(T.avisoCalendario(null, '2026-10-12')).toEqual([]);
  });
  test('P1.2: layout corporativo — sem gráfico, sem roxo/neon, sem animação contínua, metas individuais e falta/valor por dia', () => {
    const h = fs.readFileSync(path.join(root, 'painel-comercial-preview.html'), 'utf8');
    expect(h).not.toMatch(/<svg|desenhar|T\.grafico|Evolução diária/);
    expect(h).not.toMatch(/#(7C3AED|8B5CF6|A855F7|9333EA|6D28D9)|neon|flash|pulso/i);
    expect((h.match(/animation:/g) || []).length).toBe(1);   // apenas o spinner de carregamento
    expect(h).toMatch(/Falta para a meta/); expect(h).toMatch(/Necessário por dia útil/); expect(h).toMatch(/faltaEPorDia/);
    expect(h).toMatch(/Outros/); expect(h).toMatch(/Sem meta individual/);
  });
});
