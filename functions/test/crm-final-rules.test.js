'use strict';
// CRM MR4 2.0 — matriz de permissões DIRETO NO FIRESTORE (Rules reais do repositório). Não passa pelo backend: prova o que um navegador adulterado consegue ler/escrever.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
let env; jest.setTimeout(60000);
const U = { fabA: 'r-fab', adeB: 'r-ade', semMod: 'r-semmod', inativo: 'r-inativo', gestor: 'r-gestor', gestaoMod: 'r-gestaomod', adminFlag: 'r-adminflag', dual: 'r-dual', func: 'r-func' };
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore(); const W = (p, x) => d.doc(p).set(x);
    const user = (id, role, ativo = true) => W('users/' + id, { role, ativo });
    const su = (id, admin, modulos) => W('sistema_usuarios/' + id, { admin, modulos });
    await user(U.fabA, 'funcionario'); await su(U.fabA, false, ['fila-comercial-operar']);
    await user(U.adeB, 'funcionario'); await su(U.adeB, false, ['fila-comercial-operar']);
    await user(U.semMod, 'funcionario'); await su(U.semMod, false, ['ponto']);
    await user(U.inativo, 'funcionario', false); await su(U.inativo, false, ['fila-comercial-operar']);
    await user(U.gestor, 'gestor'); await su(U.gestor, false, []);
    await user(U.gestaoMod, 'funcionario'); await su(U.gestaoMod, false, ['fila-comercial-gestao']);
    await user(U.adminFlag, 'funcionario'); await su(U.adminFlag, true, []);
    await user(U.dual, 'gestor'); await su(U.dual, true, ['fila-comercial-operar']);
    await user(U.func, 'funcionario');
    await W('interacoes_fila/opp1', { commercialEntityId: 'GC_NATIVE:1', eventos: [{ tipo: 'OUTCOME_REGISTERED', operadorId: U.fabA, meta: { nota: 'nota sintética da vendedora A' } }] });
    await W('fila_comercial/worklist', { vendedores: {} });
    await W('perfis_360/GC_NATIVE:1', { x: 1 }); await W('vendas_gc/1', { valor_total: '10' }); await W('carteira_comercial/GC_NATIVE:1', { responsavelUid: U.fabA });
    await W('clientes/c1', { nome: 'Sintético' });
  });
});
afterAll(async () => { if (env) await env.cleanup(); });
const as = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const ok = async (uid, path) => { try { await assertSucceeds(as(uid).doc(path).get()); return true; } catch (_) { return false; } };

const matriz = {   // [interacoes_fila, fila_comercial/worklist, perfis_360, vendas_gc]
  anonimo: [null, [0, 0, 0, 0]], vendedorA: [U.fabA, [1, 1, 0, 0]], vendedorB: [U.adeB, [1, 1, 0, 0]], semModulo: [U.semMod, [0, 0, 0, 0]], inativo: [U.inativo, [0, 0, 0, 0]],
  funcionarioComum: [U.func, [0, 0, 0, 0]], gestorRole: [U.gestor, [1, 1, 1, 0]], gestaoModulo: [U.gestaoMod, [1, 1, 0, 0]], adminFlagSemModulo: [U.adminFlag, [1, 1, 0, 0]], dualRole: [U.dual, [1, 1, 1, 0]],
};
const paths = ['interacoes_fila/opp1', 'fila_comercial/worklist', 'perfis_360/GC_NATIVE:1', 'vendas_gc/1'];
describe('leitura direta (Rules reais)', () => {
  test('matriz observada = matriz esperada (admin=true lê fila por desenho das Rules vigentes; vendas_gc: NINGUÉM no cliente; perfis_360: só gestor)', async () => {
    const obs = {};
    for (const [nome, [uid]] of Object.entries(matriz)) obs[nome] = [uid, await Promise.all(paths.map(async p => (await ok(uid, p)) ? 1 : 0))];
    const esp = Object.fromEntries(Object.entries(matriz).map(([k, [u, e]]) => [k, [u, e.map(Number)]]));
    console.log('MATRIZ_OBSERVADA ' + JSON.stringify(Object.fromEntries(Object.entries(obs).map(([k, v]) => [k, v[1].join('')]))));
    expect(obs).toEqual(esp);
  });
  test('escrita direta negada para todos em coleções do CRM (nenhum contato/tarefa forjável pelo navegador)', async () => {
    for (const uid of [null, U.fabA, U.adeB, U.gestor, U.dual, U.adminFlag])
      for (const p of ['interacoes_fila/opp1', 'interacoes_fila/novo', 'fila_comercial/worklist', 'perfis_360/x', 'vendas_gc/9', 'carteira_comercial/GC_NATIVE:1', 'carteira_comercial/novo'])
        await assertFails(as(uid).doc(p).set({ forjado: true }));
  });
  test('vendedor não escreve em clientes; vendedor B NÃO altera o evento de A', async () => {
    await assertFails(as(U.adeB).doc('clientes/c1').update({ nome: 'x' }));
    await assertFails(as(U.adeB).doc('interacoes_fila/opp1').update({ eventos: [] }));
  });
});

describe('ACHADO documentado: nota livre em interacoes_fila', () => {
  test('vendedor B lê, direto no Firestore, a nota que o vendedor A gravou (Rules vigentes: operar lê toda a coleção) — decisão de negócio pendente', async () => {
    const snap = await assertSucceeds(as(U.adeB).doc('interacoes_fila/opp1').get());
    expect(snap.data().eventos[0].meta.nota).toMatch(/vendedora A/);
  });
});
