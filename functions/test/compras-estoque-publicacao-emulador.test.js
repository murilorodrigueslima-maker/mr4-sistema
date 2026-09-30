'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — E2E no EMULADOR: trava com transação real do Firestore (execuções concorrentes)
// e leitura da visão da tela através das Rules, perfil a perfil.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const admin = require('firebase-admin');
const E = require('../lib/compras/execucao');
const F = require('../lib/compras/fetch');
const X = require('./fixtures/compras-estoque-f0');
jest.setTimeout(120000);

const PROJETO = 'mr4-ponto';
let env, app, db, hostAnterior;
function cliFalso(portao) {
  const c = X.cenarioProdutoNovo();
  const fetchImpl = async url => {
    if (portao) await portao.entrar(cliId);   // quem pegou a trava fica retido no 1º GET até a outra execução terminar
    const u = new URL(url), q = u.searchParams, pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    const lista = u.pathname === '/produtos' ? c.produtos : u.pathname === '/vendas' ? c.vendas.filter(v => v.data >= q.get('data_inicio') && v.data <= q.get('data_fim')) : c.compras.filter(x => x.Compra.data_emissao >= q.get('data_inicio') && x.Compra.data_emissao <= q.get('data_fim'));
    await new Promise(r => setTimeout(r, 2));   // dá chance de a segunda execução disputar a trava
    return { ok: true, json: async () => ({ data: lista.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: lista.length, total_paginas: Math.max(1, Math.ceil(lista.length / lim)) } }) };
  };
  const cliId = Symbol('cli');
  return F.criarClienteGC({ fetchImpl, accessToken: 't', secretToken: 's', pausaMs: 0, dormir: async () => {} });
}
/** Portão determinístico: o PRIMEIRO cliente a chegar ao GestãoClick (= quem detém a trava) espera até abrir(). */
function criarPortao() {
  let abrir, primeiro = null, chegaram = new Set();
  const aberto = new Promise(r => (abrir = r));
  return { abrir, chegaram, entrar: async id => { chegaram.add(id); if (primeiro === null) primeiro = id; if (id === primeiro) await aberto; } };
}

beforeAll(async () => {
  hostAnterior = process.env.FIRESTORE_EMULATOR_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  env = await initializeTestEnvironment({ projectId: PROJETO, firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  app = admin.initializeApp({ projectId: PROJETO }, 'compras-e2e-' + Date.now());
  db = app.firestore();
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore();
    await d.doc('users/gestorEst').set({ role: 'gestor', ativo: true }); await d.doc('sistema_usuarios/gestorEst').set({ modulos: ['estoque'] });
    await d.doc('users/funcEst').set({ role: 'funcionario', ativo: true }); await d.doc('sistema_usuarios/funcEst').set({ modulos: ['estoque'] });
    await d.doc('users/semMod').set({ role: 'funcionario', ativo: true }); await d.doc('sistema_usuarios/semMod').set({ modulos: ['ponto'] });
  });
});
afterAll(async () => {
  await env.clearFirestore(); await env.cleanup(); await app.delete();
  if (hostAnterior === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = hostAnterior;
});

test('duas execuções simultâneas (sobreposição garantida): exatamente uma roda (OK), a outra é pulada (SKIPPED_LOCKED) sem tocar o GestãoClick; trava liberada', async () => {
  const agora = new Date('2026-09-28T15:00:00Z');
  const portao = criarPortao();
  const pA = E.executarExecucao({ db, cli: cliFalso(portao), tipo: 'FULL', gatilho: 'MANUAL', agora });
  const pB = E.executarExecucao({ db, cli: cliFalso(portao), tipo: 'FULL', gatilho: 'SCHEDULED', agora });
  // quem NÃO detém a trava termina primeiro (pulada); só então o detentor é liberado → sobreposição real
  await Promise.race([pA, pB]); portao.abrir();
  const [a, b] = await Promise.all([pA, pB]);
  expect([a.status, b.status].sort()).toEqual(['OK', 'SKIPPED_LOCKED']);
  expect(portao.chegaram.size).toBe(1);   // só a execução com a trava chamou o GestãoClick
  expect((await db.doc('compras_n0/lock').get()).exists).toBe(false);
  const runs = (await db.collection('compras_n0_runs').get()).docs.map(d => d.data().status).sort();
  expect(runs).toEqual(['OK', 'SKIPPED_LOCKED']);
});

test('snapshot gravado de verdade no Firestore (lote atômico) e lido pelas Rules conforme o perfil', async () => {
  expect((await db.doc('compras_n0_view/sugestoes').get()).data().policy_version).toBe('1.2');
  const ler = (uid, p) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore().doc(p).get();
  await assertSucceeds(ler('funcEst', 'compras_n0_view/sugestoes'));
  await assertFails(ler('funcEst', 'compras_n0_view/custos'));            // funcionário operacional: sem custo
  await assertSucceeds(ler('gestorEst', 'compras_n0_view/custos'));
  await assertSucceeds(ler('gestorEst', 'compras_n0_runs/' + (await db.collection('compras_n0_runs').get()).docs[0].id));
  for (const p of ['compras_n0_view/sugestoes', 'compras_n0_view/custos', 'compras_n0_base/v_000', 'estoque_snapshots/2026-09-28']) { await assertFails(ler('semMod', p)); await assertFails(ler(null, p)); }
  await assertFails(ler('gestorEst', 'compras_n0_base/v_000'));            // base do incremental: ninguém pelo app
  await assertFails(ler('gestorEst', 'compras_n0/lock'));
});

test('POLÍTICA 1.2 gravada de verdade + Rules: custo, margem, lucro, capital e revisão só para quem já vê custo; funcionário com estoque recebe só a operação', async () => {
  const S = require('../lib/compras/snapshot'), D = require('./fixtures/compras-ui-dados');
  const sn = D.dados(40).sn;
  await S.persistirSnapshot(db, sn);
  const ler = async (uid, p) => { const r = await (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore().doc(p).get(); return r.data(); };
  const DOCS_OPER = ['compras_n0_view/sugestoes', 'compras_n0/resumo', 'compras_n0/meta', 'compras_n0_produtos/bloco_000', 'estoque_snapshots/' + sn.snapshotEstoque.data_comercial];
  const FIN = /"fin"|resumo_financeiro|"revisao"|capital_cents|profit_|margin_pct|margin_tier|class_reasons|threshold|p1_floor|"simulator"|custo_cadastrado_cents|"price"/;
  for (const p of DOCS_OPER) { const d = await assertSucceeds(ler('funcEst', p)); expect([p, FIN.test(JSON.stringify(d))]).toEqual([p, false]); }       // o que o funcionário lê não tem financeiro
  for (const p of ['compras_n0_view/custos', 'compras_n0_custos/bloco_000']) { await assertFails(ler('funcEst', p)); await assertFails(ler('semMod', p)); await assertFails(ler(null, p)); }   // UNAUTHORIZED_COST_ACCESS=DENIED
  const custos = await assertSucceeds(ler('gestorEst', 'compras_n0_view/custos'));
  expect(custos.resumo_financeiro.simulator.strategy).toBe('LAYERED_P1_FLOOR'); expect(Object.values(custos.linhas)[0].fin.decision.class).toBeDefined(); expect(Array.isArray(custos.revisao)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(custos))).toBeLessThan(750000);
  await assertFails(env.authenticatedContext('gestorEst').firestore().doc('compras_n0_view/custos').set({ x: 1 }));   // ninguém escreve pelo app
  await assertFails(env.authenticatedContext('funcEst').firestore().doc('compras_n0_view/sugestoes').update({ x: 1 }));
});
