'use strict';
/**
 * S5 — escalada de privilégio: users / sistema_usuarios só podem ser escritos por ADMIN REAL
 * (users.role='gestor' ativo + sistema_usuarios.admin==true, não bloqueado). Gestor comum, vendedor e anônimo não.
 * Também prova que fluxos legítimos NÃO relacionados a privilégio continuam funcionando.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');
const ADMIN = 'uid-s5-admin', GESTOR = 'uid-s5-gestor', GESTOR_BLOQ = 'uid-s5-gestor-bloq', GESTOR_SEM_PERFIL = 'uid-s5-gestor-sempf';
const VEND = 'uid-s5-vend', VEND_ADMIN_FLAG = 'uid-s5-vend-adminflag', OUTRO = 'uid-s5-outro', ANON_SEM_USERS = 'uid-s5-semusers', INATIVO_ADMIN = 'uid-s5-admin-inativo';

let env;
const SEED = async db => {
  await db.collection('users').doc(ADMIN).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(GESTOR).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(GESTOR_BLOQ).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(GESTOR_SEM_PERFIL).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(INATIVO_ADMIN).set({ role: 'gestor', ativo: false });
  await db.collection('users').doc(VEND).set({ role: 'funcionario', ativo: true, funcionarioId: 'f1' });
  await db.collection('users').doc(VEND_ADMIN_FLAG).set({ role: 'funcionario', ativo: true, funcionarioId: 'f2' });
  await db.collection('users').doc(OUTRO).set({ role: 'funcionario', ativo: true, funcionarioId: 'f3' });
  await db.collection('sistema_usuarios').doc(ADMIN).set({ admin: true, modulos: [], nome: 'Admin' });
  await db.collection('sistema_usuarios').doc(GESTOR).set({ admin: false, modulos: ['financeiro'], nome: 'Gestor' });
  await db.collection('sistema_usuarios').doc(GESTOR_BLOQ).set({ admin: true, bloqueado: true, modulos: [] });
  await db.collection('sistema_usuarios').doc(INATIVO_ADMIN).set({ admin: true, modulos: [] });
  await db.collection('sistema_usuarios').doc(VEND).set({ admin: false, modulos: ['fila-comercial-operar'] });
  await db.collection('sistema_usuarios').doc(VEND_ADMIN_FLAG).set({ admin: true, modulos: [] });   // dual-role com flag: NÃO escreve (só gestor-admin)
  await db.collection('sistema_usuarios').doc(OUTRO).set({ admin: false, modulos: [] });
};
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 } });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const su = (db, uid) => db.collection('sistema_usuarios').doc(uid);
const us = (db, uid) => db.collection('users').doc(uid);

describe('S5 — ADMIN REAL pode executar operações administrativas', () => {
  test('ADMIN define admin=true e módulos para outro usuário (sistema_usuarios)', async () => {
    await assertSucceeds(su(as(ADMIN), OUTRO).update({ admin: true, modulos: ['financeiro'] }));
  });
  test('ADMIN cria perfil para conta existente e bloqueia/desbloqueia', async () => {
    await assertSucceeds(su(as(ADMIN), 'uid-novo').set({ nome: 'Novo', cargo: 'X', admin: false, modulos: [] }));
    await assertSucceeds(su(as(ADMIN), OUTRO).update({ bloqueado: true }));
  });
  test('ADMIN altera users (role/ativo) e remove perfil', async () => {
    await assertSucceeds(us(as(ADMIN), OUTRO).update({ ativo: false }));
    await assertSucceeds(su(as(ADMIN), OUTRO).delete());
  });
});

describe('S5 — GESTOR sem admin NÃO se promove nem promove outros', () => {
  test('gestor NÃO define admin=true para si (update)', async () => { await assertFails(su(as(GESTOR), GESTOR).update({ admin: true })); });
  test('gestor NÃO define admin=true para si (set merge/replace)', async () => {
    await assertFails(su(as(GESTOR), GESTOR).set({ admin: true, modulos: ['financeiro'] }));
    await assertFails(su(as(GESTOR), GESTOR).set({ admin: true }, { merge: true }));
  });
  test('gestor NÃO define admin=true para outro usuário', async () => {
    await assertFails(su(as(GESTOR), OUTRO).update({ admin: true }));
    await assertFails(su(as(GESTOR), VEND).update({ admin: true }));
  });
  test('gestor NÃO altera campos protegidos de autorização de ninguém (modulos, bloqueado, filaComercial, carteiraComercial)', async () => {
    await assertFails(su(as(GESTOR), OUTRO).update({ modulos: ['financeiro', 'estoque'] }));
    await assertFails(su(as(GESTOR), VEND).update({ bloqueado: true }));
    await assertFails(su(as(GESTOR), VEND).update({ filaComercial: { participa: true } }));
    await assertFails(su(as(GESTOR), VEND).update({ carteiraComercial: { podePossuirCarteira: true } }));
    await assertFails(su(as(GESTOR), GESTOR).update({ modulos: ['financeiro', 'admin', 'estoque'] }));
  });
  test('gestor NÃO cria perfil novo nem exclui perfis', async () => {
    await assertFails(su(as(GESTOR), 'uid-qualquer').set({ admin: true }));
    await assertFails(su(as(GESTOR), OUTRO).delete());
  });
  test('gestor NÃO promove a gestor, reativa ou cria users/{uid}', async () => {
    await assertFails(us(as(GESTOR), OUTRO).update({ role: 'gestor' }));
    await assertFails(us(as(GESTOR), OUTRO).update({ ativo: false }));
    await assertFails(us(as(GESTOR), 'uid-novo-gestor').set({ role: 'gestor', ativo: true }));
    await assertFails(us(as(GESTOR), GESTOR).update({ role: 'gestor', ativo: true, funcionarioId: 'x' }));
  });
  test('gestor com admin=true BLOQUEADO ou users inativo NÃO escreve; gestor sem sistema_usuarios NÃO escreve', async () => {
    await assertFails(su(as(GESTOR_BLOQ), OUTRO).update({ admin: true }));
    await assertFails(su(as(INATIVO_ADMIN), OUTRO).update({ admin: true }));
    await assertFails(su(as(GESTOR_SEM_PERFIL), GESTOR_SEM_PERFIL).set({ admin: true }));
  });
});

describe('S5 — VENDEDOR e não autenticado', () => {
  test('vendedor NÃO promove a si nem terceiros', async () => {
    await assertFails(su(as(VEND), VEND).update({ admin: true }));
    await assertFails(su(as(VEND), OUTRO).update({ admin: true }));
    await assertFails(us(as(VEND), VEND).update({ role: 'gestor' }));
    await assertFails(us(as(VEND), OUTRO).update({ role: 'gestor' }));
  });
  test('vendedor NÃO altera campos administrativos', async () => {
    await assertFails(su(as(VEND), VEND).update({ modulos: ['financeiro'] }));
    await assertFails(su(as(VEND), VEND).update({ bloqueado: false, filaComercial: { limiteNovasPorDia: 99 } }));
    await assertFails(su(as(VEND), VEND).delete());
  });
  test('funcionário com flag admin=true (dual-role) NÃO escreve em users/sistema_usuarios (só gestor-admin)', async () => {
    await assertFails(su(as(VEND_ADMIN_FLAG), OUTRO).update({ admin: true }));
    await assertFails(us(as(VEND_ADMIN_FLAG), OUTRO).update({ role: 'gestor' }));
  });
  test('usuário SEM users/{uid} NÃO escreve', async () => {
    await assertFails(su(as(ANON_SEM_USERS), ANON_SEM_USERS).set({ admin: true }));
    await assertFails(us(as(ANON_SEM_USERS), ANON_SEM_USERS).set({ role: 'gestor', ativo: true }));
  });
  test('NÃO autenticado NÃO escreve', async () => {
    await assertFails(su(anon(), OUTRO).update({ admin: true }));
    await assertFails(su(anon(), 'x').set({ admin: true }));
    await assertFails(us(anon(), OUTRO).update({ role: 'gestor' }));
    await assertFails(us(anon(), 'x').set({ role: 'gestor', ativo: true }));
  });
});

describe('S5 — leituras e fluxos legítimos NÃO relacionados a privilégio continuam funcionando', () => {
  test('cada usuário lê o próprio users e sistema_usuarios; gestor lê os de terceiros; vendedor não lê os de terceiros', async () => {
    await assertSucceeds(us(as(VEND), VEND).get());
    await assertSucceeds(su(as(VEND), VEND).get());
    await assertSucceeds(us(as(GESTOR), OUTRO).get());
    await assertSucceeds(su(as(GESTOR), OUTRO).get());
    await assertFails(us(as(VEND), OUTRO).get());
    await assertFails(su(as(VEND), OUTRO).get());
  });
  test('gestor sem admin continua com o acesso do módulo concedido (ex.: lê/escreve coleção do módulo ponto só com módulo; sem módulo, negado)', async () => {
    await assertFails(env.authenticatedContext(GESTOR).firestore().collection('funcionarios').doc('f1').set({ nome: 'x' }));   // GESTOR só tem 'financeiro'
    await assertSucceeds(env.authenticatedContext(ADMIN).firestore().collection('funcionarios').doc('f1').set({ nome: 'x' })); // admin=true concede qualquer módulo (comportamento anterior preservado)
  });
  test('Admin SDK/regras desabilitadas (Cloud Function criarContaFuncionario) continuam gravando users', async () => {
    await env.withSecurityRulesDisabled(async c => { await c.firestore().collection('users').doc('uid-cf').set({ role: 'funcionario', ativo: true, funcionarioId: 'fx' }); });
    await assertSucceeds(us(as('uid-cf'), 'uid-cf').get());
  });
});
