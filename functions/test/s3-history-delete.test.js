'use strict';
/**
 * S3 — proteção do histórico comercial: ninguém (vendedor, gestor, admin, anônimo) apaga fisicamente
 * clientes, conversas, mensagens, resumos, chat_status, interações, carteira e eventos por chamada direta ao Firestore.
 * Fluxos legítimos (criar/atualizar/arquivar) continuam.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const RULES_PATH = process.env.S3_RULES_PATH || resolve(__dirname, '../../modulos/firestore.rules');
const SELLER = 'uid-s3-seller', OTHER = 'uid-s3-other', GESTOR = 'uid-s3-gestor', ADMIN = 'uid-s3-admin', FILA = 'uid-s3-fila';
const PHONE = '5585999991111';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(SELLER, { role: 'funcionario', ativo: true, funcionarioId: 'f1' }, { admin: false, modulos: ['clientes', 'fila-comercial-operar'] });
  await u(OTHER, { role: 'funcionario', ativo: true, funcionarioId: 'f2' }, { admin: false, modulos: ['clientes'] });
  await u(FILA, { role: 'funcionario', ativo: true, funcionarioId: 'f3' }, { admin: false, modulos: ['fila-comercial-operar'] });
  await u(GESTOR, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADMIN, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('clientes/c1').set({ nome: 'Cliente', pipeline: 'Lead', criado_por: SELLER });
  await db.doc('clientes/c-gc').set({ nome: 'Vinculado', gestaoClickId: '123' });
  await db.doc('conversas/' + PHONE).set({ nome: 'x' });
  await db.doc(`conversas/${PHONE}/msgs/m1`).set({ texto: 'oi' });
  await db.doc('conversas_resumo/' + PHONE).set({ ultima: 'oi' });
  await db.doc('chat_status/' + PHONE).set({ status: 'ok' });
  await db.doc('interacoes_fila/opp1').set({ resultado: 'venda' });
  await db.doc('carteira_comercial/GC:1').set({ vendedor: 'a' });
  await db.doc('carteira_comercial_historico/h1').set({ evento: 'atribuicao' });
  await db.doc('crm_notas_privadas/n1').set({ autor: SELLER, texto: 'n' });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const ALVOS = ['clientes/c1', 'clientes/c-gc', 'conversas/' + PHONE, `conversas/${PHONE}/msgs/m1`, 'conversas_resumo/' + PHONE, 'chat_status/' + PHONE,
  'interacoes_fila/opp1', 'carteira_comercial/GC:1', 'carteira_comercial_historico/h1', 'crm_notas_privadas/n1'];

describe('S3 — delete direto negado para todos os perfis', () => {
  for (const [nome, ctx] of [['vendedor (dono)', () => as(SELLER)], ['outro vendedor', () => as(OTHER)], ['vendedor só fila', () => as(FILA)],
    ['gestor', () => as(GESTOR)], ['admin', () => as(ADMIN)], ['anônimo', () => anon()]]) {
    for (const p of ALVOS) test(`${nome} NÃO apaga ${p}`, async () => { await assertFails(ctx().doc(p).delete()); });
  }
});

describe('S3 — mensagem de conversa é imutável', () => {
  test('gestor/vendedor NÃO reescreve mensagem existente', async () => {
    await assertFails(as(SELLER).doc(`conversas/${PHONE}/msgs/m1`).update({ texto: 'adulterado' }));
    await assertFails(as(GESTOR).doc(`conversas/${PHONE}/msgs/m1`).set({ texto: 'adulterado' }));
  });
});

describe('S3 — fluxos legítimos continuam', () => {
  test('vendedor com módulo clientes cria e atualiza cliente', async () => {
    await assertSucceeds(as(SELLER).doc('clientes/novo').set({ nome: 'Novo', pipeline: 'Lead' }));
    await assertSucceeds(as(SELLER).doc('clientes/c1').update({ pipeline: 'Proposta' }));
  });
  test('arquivar cliente (update) funciona para vendedor e gestor', async () => {
    await assertSucceeds(as(SELLER).doc('clientes/c1').update({ arquivado: true, arquivado_em: 'x' }));
    await assertSucceeds(as(GESTOR).doc('clientes/c-gc').update({ arquivado: true }));
  });
  test('conversa: criar/atualizar conversa, resumo e chat_status; enviar mensagem nova', async () => {
    await assertSucceeds(as(SELLER).doc('conversas/5585000000000').set({ nome: 'n' }));
    await assertSucceeds(as(SELLER).doc('conversas/' + PHONE).update({ nome: 'y' }));
    await assertSucceeds(as(SELLER).doc('conversas_resumo/' + PHONE).set({ ultima: 'novo' }));
    await assertSucceeds(as(SELLER).doc('chat_status/' + PHONE).set({ status: 'aberto' }));
    await assertSucceeds(as(GESTOR).collection(`conversas/${PHONE}/msgs`).add({ texto: 'nova' }));
  });
  test('leitura de histórico segue permitida a quem tem acesso e negada a anônimo/sem módulo', async () => {
    await assertSucceeds(as(SELLER).doc('clientes/c1').get());
    await assertSucceeds(as(GESTOR).doc('conversas/' + PHONE).get());
    await assertFails(anon().doc('clientes/c1').get());
    await assertFails(as(FILA).doc('clientes/c1').get());
  });
  test('interações/carteira seguem sem escrita de cliente (só backend)', async () => {
    await assertFails(as(SELLER).doc('interacoes_fila/opp1').update({ resultado: 'x' }));
    await assertFails(as(ADMIN).doc('carteira_comercial_historico/h2').set({ evento: 'x' }));
  });
  test('admin mantém função administrativa (sistema_usuarios)', async () => {
    await assertSucceeds(as(ADMIN).doc('sistema_usuarios/' + OTHER).update({ modulos: ['clientes', 'x'] }));
  });
});
