'use strict';
// B3 — Rules das novas coleções (acesso direto) + garantia estática de que o dry-run não escreve em produção.
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const ADE = 'b3r-ade', FAB = 'b3r-fab', CAM = 'b3r-cam', GES = 'b3r-ges';
let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: fs.readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore(); const u = (id, r, m) => Promise.all([d.doc('users/' + id).set({ role: r, ativo: true }), d.doc('sistema_usuarios/' + id).set({ admin: false, modulos: m })]);
    await u(ADE, 'funcionario', ['fila-comercial-operar']); await u(FAB, 'funcionario', ['fila-comercial-operar']); await u(CAM, 'funcionario', ['fila-comercial-gestao']); await u(GES, 'gestor', []);
    for (const col of ['carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_devolucoes']) await d.doc(col + '/x').set({ destinoUid: FAB, naoContatar: true }); });
});
afterAll(async () => { await env.cleanup(); });
const as = u => env.authenticatedContext(u).firestore();
test('vendedores não leem nem escrevem reservas/restrições/devoluções (nem as próprias); anônimo nada', async () => {
  for (const col of ['carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_devolucoes']) {
    for (const u of [ADE, FAB]) { await assertFails(as(u).doc(col + '/x').get()); await assertFails(as(u).collection(col).get()); await assertFails(as(u).doc(col + '/y').set({ a: 1 })); await assertFails(as(u).doc(col + '/x').update({ estado: 'CONVERTIDA', destinoUid: u })); await assertFails(as(u).doc(col + '/x').delete()); }
    await assertFails(env.unauthenticatedContext().firestore().doc(col + '/x').get());
  }
});
test('gestão (gestor e Camila sem admin) lê; ninguém escreve (nem gestor/Camila)', async () => {
  for (const col of ['carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_devolucoes']) for (const u of [GES, CAM]) { await assertSucceeds(as(u).doc(col + '/x').get()); await assertFails(as(u).doc(col + '/z').set({ a: 1 })); await assertFails(as(u).doc(col + '/x').delete()); }
  await assertFails(as(CAM).doc('sistema_usuarios/' + CAM).update({ admin: true }));
});
test('vendedor não força reativação nem altera data/ciclo/owner pelo SDK', async () => {
  for (const u of [ADE, FAB]) { await assertFails(as(u).doc('carteira_comercial/GC:1').set({ ownerUid: u })); await assertFails(as(u).doc('carteira_reativacoes/novo').set({ destinoUid: u, estado: 'RESERVADA' })); await assertFails(as(u).doc('carteira_comercial_historico/h').set({ tipoEvento: 'REATIVACAO_120D_PRIMEIRA_VENDA' })); }
});
test('dry-run e contexto são SOMENTE LEITURA (sem set/update/create/delete/batch/transaction no Firestore)', () => {
  for (const f of ['scripts/b3_dryrun.js', 'lib/reativacaoContexto.js', 'lib/gcFetchDerivado.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\b(vendasPorCliente|cooldowns|followUps|conflitosGc|ultimaRev|porCliente|porVenda|owners|cmp|situ|o|conflitosGc|ids)\.(set|add|delete)\(/g, '');
    expect(src).not.toMatch(/\.(update|create|commit)\(|\bbatch\(|runTransaction|\.doc\([^)]*\)\.(set|delete)\(|\.collection\([^)]*\)\.add\(/);
  }
});
