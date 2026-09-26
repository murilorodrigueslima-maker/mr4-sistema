'use strict';
// N35.26 — Executor da Onda 1 (carteiraMigracao) + Rules de carteira_comercial/_historico. EMULADOR. PROD_WRITES=0.
// Depende SÓ dos módulos publicados na N35.26 (carteiraMigracao, carteiraV1, carteiraComercial, commercialIdentity, rules).
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const M = require('../lib/carteiraMigracao');
const V1 = require('../lib/carteiraV1');
const { COLL, COLL_HIST } = M;

const LOTE = 'TESTE_N3526';
const base = { loteId: LOTE, operadorUid: 'op-migracao', motivo: 'Migração teste', agoraIso: '2026-09-26T15:00:00.000Z' };
const item = (gc, owner, extra = {}) => ({ portfolioId: 'GC:' + gc, identidadeAtual: 'GC_NATIVE:' + gc, proposedOwnerUid: owner, origemComercialUid: owner, origemComercialGestaoClickId: '1080453', ...extra });
const ITENS = [item('7001', 'F'), item('7002', 'A'), item('7003', 'F')];
const contar = async c => (await db.collection(c).get()).size;
const limpar = async () => { for (const c of [COLL, COLL_HIST]) for (const d of (await db.collection(c).get()).docs) await d.ref.delete(); await db.doc('clientes/mr4n3526').delete(); };
beforeEach(limpar);
afterAll(limpar);

describe('Executor da Onda 1 (MG)', () => {
  test('MG-01 dryRun: lê tudo, não escreve nada', async () => {
    const r = await M.executarOndaMigracao(db, { ...base, itens: ITENS, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, total: 3, wouldCreate: 3, criados: 0, conflitos: [], identidade: [] });
    expect(await contar(COLL)).toBe(0); expect(await contar(COLL_HIST)).toBe(0);
  });
  test('MG-02 execução real: 1 carteira + 1 evento por cliente, na âncora, documento mínimo', async () => {
    const r = await M.executarOndaMigracao(db, { ...base, itens: ITENS });
    expect(r).toMatchObject({ criados: 3, conflitos: [], identidade: [], paradoEm: null });
    expect(await contar(COLL)).toBe(3); expect(await contar(COLL_HIST)).toBe(3);
    const d = (await db.doc(`${COLL}/GC:7002`).get()).data();
    expect(d).toEqual({ schemaVersion: 'carteira-v1', portfolioId: 'GC:7002', ownerUid: 'A', ownerDesde: base.agoraIso, origemComercialUid: 'A',
      origemComercialGestaoClickId: '1080453', criadoEm: base.agoraIso, atualizadoEm: base.agoraIso, versao: 1 });
    expect(V1.validarDocCarteiraV1(d)).toBeNull();
    const h = (await db.doc(`${COLL_HIST}/${M.idEventoMigracao(LOTE, 'GC:7002')}`).get()).data();
    expect(h).toMatchObject({ portfolioId: 'GC:7002', tipoEvento: 'CARTEIRA_CRIADA', ownerAnteriorUid: null, ownerNovoUid: 'A', versao: 1, chaveIdempotencia: 'MIGRACAO:' + LOTE + ':GC:7002' });
  });
  test('MG-03 reexecução: 0 criados; dryRun pós-migração = ALREADY_EXISTS_SAME para todos', async () => {
    await M.executarOndaMigracao(db, { ...base, itens: ITENS });
    const r2 = await M.executarOndaMigracao(db, { ...base, itens: ITENS });
    const r3 = await M.executarOndaMigracao(db, { ...base, itens: ITENS, dryRun: true });
    expect(r2).toMatchObject({ criados: 0, jaExistentesMesmoOwner: 3, conflitos: [] });
    expect(r3).toMatchObject({ wouldCreate: 0, jaExistentesMesmoOwner: 3, conflitos: [] });
    expect(await contar(COLL)).toBe(3); expect(await contar(COLL_HIST)).toBe(3);
  });
  test('MG-04 failFast: para no primeiro conflito de owner e informa onde parou; nada sobrescrito', async () => {
    await M.executarOndaMigracao(db, { ...base, itens: [item('7002', 'F')] });            // pré-existente com outro owner
    const r = await M.executarOndaMigracao(db, { ...base, itens: ITENS, failFast: true });
    expect(r.paradoEm).toEqual({ indice: 1, portfolioId: 'GC:7002', status: 'CONFLICT_OWNER' });
    expect(r.criados).toBe(1);                                                              // só o item 0
    expect((await db.doc(`${COLL}/GC:7002`).get()).data().ownerUid).toBe('F');
    expect((await db.doc(`${COLL}/GC:7003`).get()).exists).toBe(false);
  });
  test('MG-05 origem divergente e evento órfão (sem carteira) são conflitos', async () => {
    await M.executarOndaMigracao(db, { ...base, itens: [item('7001', 'F')] });
    const r = await M.executarOndaMigracao(db, { ...base, itens: [item('7001', 'F', { origemComercialGestaoClickId: '948278' })] });
    expect(r.conflitos).toEqual([{ portfolioId: 'GC:7001', tipo: 'CONFLICT_ORIGIN' }]);
    await db.doc(`${COLL_HIST}/${M.idEventoMigracao(LOTE, 'GC:7009')}`).set({ x: 1 });
    const r2 = await M.executarOndaMigracao(db, { ...base, itens: [item('7009', 'A')], dryRun: true });
    expect(r2.conflitos).toEqual([{ portfolioId: 'GC:7009', tipo: 'CONFLICT_HISTORY' }]);
  });
  test('MG-06 identidade: MR4_LINKED resolve na âncora; identidade mudou / chave legada / sem vínculo bloqueiam', async () => {
    await db.doc('clientes/mr4n3526').set({ gestaoClickId: '7005' });
    const ok = await M.executarOndaMigracao(db, { ...base, itens: [item('7005', 'A', { identidadeAtual: 'MR4_LINKED:mr4n3526' })] });
    expect(ok.criados).toBe(1);
    const mudou = await M.executarOndaMigracao(db, { ...base, itens: [item('7006', 'A', { identidadeAtual: 'MR4_LINKED:mr4n3526' })], dryRun: true });
    expect(mudou.identidade[0].erro).toMatch(/IDENTIDADE_MUDOU/);
    await db.doc(`${COLL}/GC_NATIVE:7007`).set({ ownerUid: 'F' });
    const leg = await M.executarOndaMigracao(db, { ...base, itens: [item('7007', 'F')], dryRun: true });
    expect(leg.identidade[0].erro).toMatch(/CHAVE_LEGADA/);
    const semv = await M.executarOndaMigracao(db, { ...base, itens: [item('7008', 'F', { identidadeAtual: 'MR4_LINKED:naoexiste' })], dryRun: true });
    expect(semv.identidade[0].erro).toMatch(/Revisão de identidade/);
  });
  test('MG-07 payload: documento e evento sem PII/financeiro; loteId/campos obrigatórios validados', async () => {
    await M.executarOndaMigracao(db, { ...base, itens: ITENS });
    const txt = JSON.stringify([(await db.collection(COLL).get()).docs.map(d => d.data()), (await db.collection(COLL_HIST).get()).docs.map(d => d.data())]);
    expect(txt).not.toMatch(/nome|cpf|cnpj|telefone|email|endereco|faturamento|ticket|margem|lucro|custo|score|ranking/i);
    await expect(M.executarOndaMigracao(db, { ...base, loteId: 'x', itens: [] })).rejects.toThrow(/loteId/);
    await expect(M.executarOndaMigracao(db, { ...base, motivo: '', itens: [] })).rejects.toThrow(/obrigatórios/);
  });
  test('MG-08 módulo isolado: não depende de transferência, painel, callable nem worklist', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/carteiraMigracao.js'), 'utf8');
    const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
    expect(reqs).toEqual(['./carteiraV1', './commercialIdentity', 'firebase-functions/v2/https']);
  });
});

describe('Rules carteira_comercial / _historico (MG)', () => {
  test('MG-09 matriz: vendedor lê só a própria; gestão/gestor leem tudo e histórico; admin sem gestão e anônimo negados; ninguém escreve', async () => {
    const RULES = fs.readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
    const env = await initializeTestEnvironment({ projectId: 'mr4-n3526-rules', firestore: { rules: RULES, host: 'localhost', port: 8080 } });
    const P = {
      fab: [{ role: 'funcionario', ativo: true }, { admin: false, bloqueado: false, modulos: ['fila-comercial', 'fila-comercial-operar'] }],
      ade: [{ role: 'funcionario', ativo: true }, { admin: false, bloqueado: false, modulos: ['fila-comercial', 'fila-comercial-operar'] }],
      cam: [{ role: 'funcionario', ativo: true }, { admin: false, bloqueado: false, modulos: ['fila-comercial-gestao'] }],
      mur: [{ role: 'gestor', ativo: true }, { admin: true, modulos: ['fila-comercial'] }],
      adm: [{ role: 'funcionario', ativo: true }, { admin: true, bloqueado: false, modulos: ['ponto'] }],
    };
    try {
      await env.withSecurityRulesDisabled(async ctx => {
        const f = ctx.firestore();
        for (const [k, [u, s]] of Object.entries(P)) { await f.doc('users/' + k).set(u); await f.doc('sistema_usuarios/' + k).set(s); }
        await f.doc(`${COLL}/GC:1`).set({ ownerUid: 'fab', versao: 1 });
        await f.doc(`${COLL_HIST}/h1`).set({ portfolioId: 'GC:1' });
      });
      const as = k => (k ? env.authenticatedContext(k) : env.unauthenticatedContext()).firestore();
      await assertSucceeds(as('fab').doc(`${COLL}/GC:1`).get());
      await assertFails(as('ade').doc(`${COLL}/GC:1`).get());
      await assertSucceeds(as('cam').doc(`${COLL}/GC:1`).get());
      await assertSucceeds(as('mur').doc(`${COLL}/GC:1`).get());
      await assertFails(as('adm').doc(`${COLL}/GC:1`).get());
      await assertFails(as(null).doc(`${COLL}/GC:1`).get());
      for (const k of ['cam', 'mur']) await assertSucceeds(as(k).doc(`${COLL_HIST}/h1`).get());
      for (const k of ['fab', 'ade', 'adm', null]) await assertFails(as(k).doc(`${COLL_HIST}/h1`).get());
      for (const k of ['fab', 'ade', 'cam', 'mur', 'adm', null]) {
        await assertFails(as(k).doc(`${COLL}/GC:2`).set({ ownerUid: 'x' }));
        await assertFails(as(k).doc(`${COLL}/GC:1`).update({ ownerUid: 'x' }));
        await assertFails(as(k).doc(`${COLL}/GC:1`).delete());
        await assertFails(as(k).doc(`${COLL}/GC_NATIVE:1`).set({ ownerUid: 'x' }));   // alias/identidade legada
        await assertFails(as(k).doc(`${COLL_HIST}/x`).set({ a: 1 }));
        await assertFails(as(k).doc(`${COLL_HIST}/h1`).update({ a: 1 }));
        await assertFails(as(k).doc(`${COLL_HIST}/h1`).delete());
      }
    } finally { await env.cleanup(); }
  }, 60000);
});
