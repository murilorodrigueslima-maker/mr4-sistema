'use strict';
// Atualização da base do planejamento contra o Firestore Emulator (127.0.0.1:8320): coleções gravadas pelo próprio snapshot do
// sistema, dados 100 % fictícios. Sem emulador o arquivo é ignorado (rode: sh functions/test/harness14/rodar.sh rules).
const temEmulador = process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8320';
const d = temEmulador ? describe : describe.skip;

d('atualizarBase no emulador', () => {
  const admin = require('firebase-admin');
  const B = require('../lib/compras/simuladorBase');
  const S = require('./harness14/semear');
  const app = admin.apps.find(a => a && a.name === 'plan') || admin.initializeApp({ projectId: 'demo-mr4-plan-emu' }, 'plan');
  const db = app.firestore();
  const em = min => new Date(S.AGORA.getTime() + min * 60000);
  jest.setTimeout(120000);                                                     // 1ª gravação no emulador pode ser lenta
  const foto = async () => { const o = {}; for (const c of await db.listCollections()) if (c.id !== 'compras_sombra_14') for (const x of (await c.get()).docs) o[c.id + '/' + x.id] = JSON.stringify(x.data()); return o; };
  const meta = async () => (await db.collection('compras_sombra_14').doc('meta').get()).data();
  beforeAll(async () => { for (const c of await db.listCollections()) await db.recursiveDelete(c); });
  afterAll(async () => { await app.delete(); });

  test('sem dados de compras não grava nada', async () => {
    expect(await B.atualizarBase(db, { agora: em(0) })).toEqual({ status: 'SEM_DADOS_DE_COMPRAS' });
    expect((await db.collection('compras_sombra_14').get()).size).toBe(0);
  });
  test('gera a base a partir das coleções do sistema, aplica a origem e não altera mais nada', async () => {
    await S.gravar(db);
    const antes = await foto();
    const r = await B.atualizarBase(db, { agora: em(1) });
    expect(r).toMatchObject({ status: 'ATUALIZADA', data_comercial: S.HOJE, marcas_de_origem: 2, saldos_diarios_lidos: 1 });
    expect(r.itens).toBeGreaterThan(20);
    expect(await foto()).toEqual(antes);
    const m = await meta();
    expect(m).toMatchObject({ formato: 2, status: 'SOMBRA_NAO_APROVADA' });
    const itens = (await Promise.all(Array.from({ length: m.blocos }, (_, i) => db.collection('compras_sombra_14').doc('bloco_00' + i).get()))).flatMap(x => JSON.parse(x.data().itens_json));
    expect(itens.find(i => i.id === 'PT-027').origem_comprovada).toBe(false);
    expect(JSON.parse(m.pendentes_json).map(p => p.id).sort()).toEqual(['CT-ANTIGA', 'CT-RECENTE']);
    expect((await db.collection('compras_sombra_14').doc('trava').get()).exists).toBe(false);
  });
  test('mesmos dados: não regera; botão respeita o intervalo mínimo e depois regera', async () => {
    const g = (await meta()).gerado_em;
    expect((await B.atualizarBase(db, { agora: em(30) })).status).toBe('JA_ATUALIZADA');
    expect(await B.atualizarBase(db, { forcar: true, agora: em(2) })).toMatchObject({ status: 'JA_ATUALIZADA', recente: true });
    expect((await meta()).gerado_em).toBe(g);
    expect((await B.atualizarBase(db, { forcar: true, agora: em(40) })).status).toBe('ATUALIZADA');
  });
  test('trava: uma atualização por vez; trava vencida é assumida', async () => {
    const ref = db.collection('compras_sombra_14').doc('trava');
    await ref.set({ dono: 'outro', expira_em: em(60).toISOString() });
    expect((await B.atualizarBase(db, { forcar: true, agora: em(50) })).status).toBe('EM_ANDAMENTO');
    expect((await B.atualizarBase(db, { forcar: true, agora: em(70) })).status).toBe('ATUALIZADA');
    expect((await ref.get()).exists).toBe(false);
  });
  test('falha de leitura preserva a base anterior e libera a trava', async () => {
    const antes = await meta();
    await db.collection('compras_n0').doc('meta').update({ ultima_sincronizacao_ok: em(80).toISOString(), 'base_ativa.vendas': 99 });
    await expect(B.atualizarBase(db, { agora: em(90) })).rejects.toThrow(/BASE_INCOMPLETA/);
    expect(await meta()).toEqual(antes);
    expect((await db.collection('compras_sombra_14').doc('trava').get()).exists).toBe(false);
  });
});
