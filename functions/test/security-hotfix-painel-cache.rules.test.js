'use strict';
// MR4 SECURITY HOTFIX P0 — Rules de painel_cache (substitui data/*.json públicos). EMULADOR.
// Prova no BACKEND (Rules), não na interface: anônimo, autenticado sem autorização, gestor sem módulo,
// bloqueado e perfis autorizados — cada um só lê o documento que sua função/módulo permite.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
jest.setTimeout(60000);

const DOCS = ['vendas', 'caixa', 'estoque', 'estoque_custos', 'produtos_catalogo'];
let testEnv;

// perfil → { users, sistema_usuarios | null }
const PERFIS = {
  funcSemModulo:     { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['ponto'] } },
  funcEstoque:       { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['estoque'] } },
  funcEstoqueBloq:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['estoque'], bloqueado: true } },
  funcVendas:        { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['vendas', 'caixa'] } },
  funcInativo:       { users: { role: 'funcionario', ativo: false }, sys: { modulos: ['estoque'] } },
  gestorSemCadastro: { users: { role: 'gestor', ativo: true }, sys: null },
  gestorSemModulo:   { users: { role: 'gestor', ativo: true }, sys: { modulos: ['ponto'] } },
  gestorVendas:      { users: { role: 'gestor', ativo: true }, sys: { modulos: ['vendas'] } },
  gestorCaixa:       { users: { role: 'gestor', ativo: true }, sys: { modulos: ['caixa'] } },
  gestorEstoque:     { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'] } },
  gestorBloqueado:   { users: { role: 'gestor', ativo: true }, sys: { modulos: ['vendas', 'caixa', 'estoque'], admin: true, bloqueado: true } },
  admin:             { users: { role: 'gestor', ativo: true }, sys: { modulos: [], admin: true } },
  display:           { users: { role: 'display', ativo: true }, sys: null },
};
// Matriz esperada (true = pode ler)
const ESPERADO = {
  funcSemModulo:     { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  funcEstoque:       { vendas: false, caixa: false, estoque: true,  estoque_custos: false, produtos_catalogo: true },
  funcEstoqueBloq:   { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  funcVendas:        { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false }, // vendas/caixa exigem gestor
  funcInativo:       { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  gestorSemCadastro: { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  gestorSemModulo:   { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  gestorVendas:      { vendas: true,  caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  gestorCaixa:       { vendas: false, caixa: true,  estoque: false, estoque_custos: false, produtos_catalogo: false },
  gestorEstoque:     { vendas: false, caixa: false, estoque: true,  estoque_custos: true,  produtos_catalogo: true },
  gestorBloqueado:   { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
  admin:             { vendas: true,  caixa: true,  estoque: true,  estoque_custos: true,  produtos_catalogo: true },
  display:           { vendas: false, caixa: false, estoque: false, estoque_custos: false, produtos_catalogo: false },
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'mr4-ponto',
    firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 },
  });
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const [uid, p] of Object.entries(PERFIS)) {
      await db.collection('users').doc(uid).set(p.users);
      if (p.sys) await db.collection('sistema_usuarios').doc(uid).set(p.sys);
    }
    for (const d of DOCS) await db.collection('painel_cache').doc(d).set({ atualizado_em: '2026-09-28T12:00:00', fixture: true });
    await db.collection('painel_cache').doc('outro').set({ fixture: true });
  });
});
afterAll(async () => { await testEnv.clearFirestore(); await testEnv.cleanup(); });

describe('ANONYMOUS_USER', () => {
  test.each(DOCS)('anônimo NÃO lê painel_cache/%s', async d => {
    await assertFails(testEnv.unauthenticatedContext().firestore().collection('painel_cache').doc(d).get());
  });
  test('anônimo NÃO lista a coleção', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().collection('painel_cache').get());
  });
});

describe('Matriz perfil × documento (backend)', () => {
  for (const [uid, esperado] of Object.entries(ESPERADO)) {
    for (const d of DOCS) {
      test(`${uid} ${esperado[d] ? 'LÊ' : 'NÃO lê'} painel_cache/${d}`, async () => {
        const op = testEnv.authenticatedContext(uid).firestore().collection('painel_cache').doc(d).get();
        await (esperado[d] ? assertSucceeds(op) : assertFails(op));
      });
    }
  }
});

describe('Escrita e documentos fora da lista', () => {
  test.each(['admin', 'gestorEstoque', 'funcEstoque'])('%s NÃO escreve em painel_cache', async uid => {
    const db = testEnv.authenticatedContext(uid).firestore();
    await assertFails(db.collection('painel_cache').doc('vendas').set({ hoje: 1 }));
    await assertFails(db.collection('painel_cache').doc('estoque').update({ total_produtos: 1 }));
    await assertFails(db.collection('painel_cache').doc('novo').set({ x: 1 }));
    await assertFails(db.collection('painel_cache').doc('caixa').delete());
  });
  test('admin NÃO lê docId fora da lista (deny por padrão)', async () => {
    await assertFails(testEnv.authenticatedContext('admin').firestore().collection('painel_cache').doc('outro').get());
  });
  test('GESTOR_WITHOUT_REQUIRED_PERMISSION: ser gestor não basta para custos/vendas', async () => {
    for (const uid of ['gestorSemCadastro', 'gestorSemModulo']) {
      const db = testEnv.authenticatedContext(uid).firestore();
      await assertFails(db.collection('painel_cache').doc('estoque_custos').get());
      await assertFails(db.collection('painel_cache').doc('vendas').get());
    }
  });
  test('AUTHENTICATED_UNAUTHORIZED_USER: funcionário com módulo estoque NÃO lê custos/margem', async () => {
    await assertFails(testEnv.authenticatedContext('funcEstoque').firestore().collection('painel_cache').doc('estoque_custos').get());
  });
});
