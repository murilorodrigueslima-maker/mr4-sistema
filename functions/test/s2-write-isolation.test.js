'use strict';
/**
 * S2 — isolamento de escrita entre vendedores em `clientes`.
 * Dono = carteira_comercial/GC:<clientes.gestaoClickId>.ownerUid (única prova de posse existente hoje).
 * Cliente sem carteira / sem vínculo GC: comportamento anterior (limitação documentada).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const RULES_PATH = process.env.S2_RULES_PATH || resolve(__dirname, '../../modulos/firestore.rules');
const A = 'uid-s2-ademir', B = 'uid-s2-fabiana', GEST = 'uid-s2-gestor', CAM = 'uid-s2-camila', ADM = 'uid-s2-admin', SEMMOD = 'uid-s2-semmod';
let env;
const SEED = async db => {
  const u = (id, d, s) => Promise.all([db.collection('users').doc(id).set(d), db.collection('sistema_usuarios').doc(id).set(s)]);
  await u(A, { role: 'funcionario', ativo: true, funcionarioId: 'fa' }, { admin: false, modulos: ['clientes', 'fila-comercial-operar'] });
  await u(B, { role: 'funcionario', ativo: true, funcionarioId: 'fb' }, { admin: false, modulos: ['clientes', 'fila-comercial-operar'] });
  await u(CAM, { role: 'funcionario', ativo: true, funcionarioId: 'fc' }, { admin: false, modulos: ['clientes', 'fila-comercial-gestao'] });
  await u(SEMMOD, { role: 'funcionario', ativo: true, funcionarioId: 'fd' }, { admin: false, modulos: ['fila-comercial-operar'] });
  await u(GEST, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
  await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
  await db.doc('carteira_comercial/GC:1').set({ ownerUid: A });
  await db.doc('carteira_comercial/GC:2').set({ ownerUid: B });
  const base = { nome: 'N', telefone: '85999990000', email: 'a@b.c', cpf_cnpj: '111', pipeline: 'lead', notas: [] };
  await db.doc('clientes/cA').set({ ...base, gestaoClickId: '1' });
  await db.doc('clientes/cB').set({ ...base, gestaoClickId: '2' });
  await db.doc('clientes/cNum').set({ ...base, gestaoClickId: 2 });            // id numérico também resolve
  await db.doc('clientes/cGcSemCarteira').set({ ...base, gestaoClickId: '999' });
  await db.doc('clientes/cLegado').set({ ...base });                            // sem vínculo GC
  await db.doc('clientes/cDeletar').set({ ...base, gestaoClickId: '2' });
};
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => { await SEED(c.firestore()); }); });
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const cli = (db, id) => db.collection('clientes').doc(id);

// [quem, cliente próprio, cliente do outro]
const PARES = [['A (Ademir)', A, 'cA', 'cB'], ['B (Fabiana)', B, 'cB', 'cA']];
for (const [nome, uid, meu, alheio] of PARES) {
  describe(`S2 — vendedor ${nome}`, () => {
    test('updates legítimos no cliente próprio (pipeline, notas, followUp, ultimoContato, vendas)', async () => {
      await assertSucceeds(cli(as(uid), meu).update({ pipeline: 'proposta' }));
      await assertSucceeds(cli(as(uid), meu).update({ notas: [{ texto: 'x' }], ultimoContato: 'agora' }));
      await assertSucceeds(cli(as(uid), meu).update({ followUp: '2026-10-20', vendas: [{ v: 1 }] }));
    });
    test('edita dados cadastrais e arquiva o PRÓPRIO cliente', async () => {
      await assertSucceeds(cli(as(uid), meu).update({ telefone: '85988887777', email: 'n@n.n', cpf_cnpj: '222' }));
      await assertSucceeds(cli(as(uid), meu).update({ arquivado: true, arquivado_em: 'x' }));
    });
    test('NÃO edita cliente do outro vendedor (pipeline, notas, followUp)', async () => {
      await assertFails(cli(as(uid), alheio).update({ pipeline: 'ganho' }));
      await assertFails(cli(as(uid), alheio).update({ notas: [{ texto: 'sabotagem' }] }));
      await assertFails(cli(as(uid), alheio).update({ followUp: null }));
    });
    test('NÃO altera identificadores/matching do cliente do outro (cpf_cnpj, telefone, email)', async () => {
      await assertFails(cli(as(uid), alheio).update({ cpf_cnpj: '000' }));
      await assertFails(cli(as(uid), alheio).update({ telefone: '0', email: 'x@x.x' }));
    });
    test('NÃO arquiva cliente do outro nem altera vínculo GC', async () => {
      await assertFails(cli(as(uid), alheio).update({ arquivado: true }));
      await assertFails(cli(as(uid), alheio).update({ gestaoClickId: '888' }));
      await assertFails(cli(as(uid), meu).update({ gestaoClickId: '777' }));
    });
    test('NÃO escreve campos de ownership (nem no próprio nem no do outro; nem na criação)', async () => {
      for (const campo of ['ownerUid', 'vendedor', 'vendedorUid', 'responsavel', 'carteira', 'portfolioId', 'permissoes']) {
        await assertFails(cli(as(uid), meu).update({ [campo]: uid }));
        await assertFails(cli(as(uid), alheio).update({ [campo]: uid }));
        await assertFails(cli(as(uid), 'novoX').set({ nome: 'n', [campo]: uid }));
      }
    });
    test('cliente com gestaoClickId numérico também é protegido', async () => {
      const outro = uid === A ? 'cNum' : null; // cNum pertence à carteira de B
      if (outro) await assertFails(cli(as(uid), outro).update({ pipeline: 'x' }));
      else await assertSucceeds(cli(as(uid), 'cNum').update({ pipeline: 'x' }));
    });
    test('cria cliente novo sem vínculo GC (fluxo manual) e NÃO cria com gestaoClickId', async () => {
      await assertSucceeds(cli(as(uid), 'novo-ok').set({ nome: 'Novo', pipeline: 'lead', origem: 'manual' }));
      await assertFails(cli(as(uid), 'novo-gc').set({ nome: 'Novo', gestaoClickId: '2' }));
    });
  });
}

describe('S2 — cliente SEM carteira (comportamento escolhido: mantém o anterior, limitação documentada)', () => {
  test('sem vínculo GC (CRM legado): vendedor com módulo clientes continua editando', async () => {
    await assertSucceeds(cli(as(A), 'cLegado').update({ pipeline: 'proposta' }));
    await assertSucceeds(cli(as(B), 'cLegado').update({ notas: [{ texto: 'x' }] }));
  });
  test('GC sem carteira: continua editável (não há prova de dono)', async () => {
    await assertSucceeds(cli(as(A), 'cGcSemCarteira').update({ pipeline: 'proposta' }));
  });
  test('mesmo sem carteira: ownership e vínculo GC seguem protegidos', async () => {
    await assertFails(cli(as(A), 'cLegado').update({ ownerUid: A }));
    await assertFails(cli(as(A), 'cLegado').update({ gestaoClickId: '1' }));
  });
});

describe('S2 — gestão e anônimo', () => {
  test('gestor (role) e admin mantêm operações administrativas em qualquer cliente', async () => {
    await assertSucceeds(cli(as(GEST), 'cA').update({ pipeline: 'ganho' }));
    await assertSucceeds(cli(as(GEST), 'cB').update({ notas: [{ texto: 'adm' }] }));
    await assertSucceeds(cli(as(ADM), 'cB').update({ arquivado: true }));
    await assertSucceeds(cli(as(GEST), 'cB').update({ cpf_cnpj: '333' }));
  });
  test('gestão explícita (Camila, com módulo clientes) edita cliente de qualquer carteira', async () => {
    await assertSucceeds(cli(as(CAM), 'cA').update({ pipeline: 'x' }));
    await assertSucceeds(cli(as(CAM), 'cB').update({ pipeline: 'x' }));
  });
  test('gestão NÃO escreve ownership/GC pelo SDK (só backend)', async () => {
    await assertFails(cli(as(GEST), 'cA').update({ ownerUid: B }));
    await assertFails(cli(as(GEST), 'cA').update({ gestaoClickId: '2' }));
  });
  test('sem módulo clientes e anônimo não escrevem nem leem', async () => {
    await assertFails(cli(as(SEMMOD), 'cLegado').update({ pipeline: 'x' }));
    await assertFails(cli(anon(), 'cLegado').update({ pipeline: 'x' }));
    await assertFails(cli(anon(), 'novo').set({ nome: 'x' }));
    await assertFails(cli(anon(), 'cLegado').get());
  });
  test('acesso direto: vendedor lê o cliente do outro (leitura inalterada), mas não escreve', async () => {
    await assertSucceeds(cli(as(A), 'cB').get());
    await assertFails(cli(as(A), 'cB').update({ pipeline: 'x' }));
  });
});

describe('S2 — regressões S3 e S5', () => {
  test('S3: ninguém apaga cliente (nem dono, nem gestor, nem admin, nem anônimo)', async () => {
    for (const u of [as(B), as(A), as(GEST), as(ADM), as(CAM), anon()]) await assertFails(cli(u, 'cDeletar').delete());
    await assertFails(as(A).doc('conversas/55').delete());
  });
  test('S5: gestor comum e vendedor não se promovem; admin real continua podendo', async () => {
    await assertFails(as(GEST).doc('sistema_usuarios/' + GEST).update({ admin: true }));
    await assertFails(as(A).doc('sistema_usuarios/' + A).update({ admin: true }));
    await assertSucceeds(as(ADM).doc('sistema_usuarios/' + B).update({ modulos: ['clientes'] }));
  });
});
