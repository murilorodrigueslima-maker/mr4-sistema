'use strict';
// B3 — Rules das novas coleções (acesso direto) + garantia estática de que o dry-run não escreve em produção.
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const VD1 = 'b3r-vd1', VD2 = 'b3r-vd2', RV4 = 'b3r-rv4', GES = 'b3r-ges';
const COLS_B3 = ['carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_devolucoes', 'identidade_conflitos', 'carteira_comercial_restricoes_hist', 'carteira_comercial_revisoes'];
let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: fs.readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), ...require('./_ambiente/emulador').firestore() } });
  await env.withSecurityRulesDisabled(async c => { const d = c.firestore(); const u = (id, r, m) => Promise.all([d.doc('users/' + id).set({ role: r, ativo: true }), d.doc('sistema_usuarios/' + id).set({ admin: false, modulos: m })]);
    await u(VD1, 'funcionario', ['fila-comercial-operar']); await u(VD2, 'funcionario', ['fila-comercial-operar']); await u(RV4, 'funcionario', ['fila-comercial-gestao']); await u(GES, 'gestor', []);
    for (const col of COLS_B3) await d.doc(col + '/x').set({ destinoUid: VD2, naoContatar: true }); });
});
afterAll(async () => { await env.cleanup(); });
const as = u => env.authenticatedContext(u).firestore();
test('vendedores não leem nem escrevem reservas/restrições/devoluções (nem as próprias); anônimo nada', async () => {
  for (const col of COLS_B3) {
    for (const u of [VD1, VD2]) { await assertFails(as(u).doc(col + '/x').get()); await assertFails(as(u).collection(col).get()); await assertFails(as(u).doc(col + '/y').set({ a: 1 })); await assertFails(as(u).doc(col + '/x').update({ estado: 'CONVERTIDA', destinoUid: u })); await assertFails(as(u).doc(col + '/x').delete()); }
    await assertFails(env.unauthenticatedContext().firestore().doc(col + '/x').get());
  }
});
test('gestão (gestor e Revisor4 sem admin) lê; ninguém escreve (nem gestor/Revisor4)', async () => {
  for (const col of COLS_B3) for (const u of [GES, RV4]) { await assertSucceeds(as(u).doc(col + '/x').get()); await assertFails(as(u).doc(col + '/z').set({ a: 1 })); await assertFails(as(u).doc(col + '/x').delete()); }
  await assertFails(as(RV4).doc('sistema_usuarios/' + RV4).update({ admin: true }));
});
test('vendedor não força reativação nem altera data/ciclo/owner pelo SDK', async () => {
  for (const u of [VD1, VD2]) { await assertFails(as(u).doc('carteira_comercial/GC:1').set({ ownerUid: u })); await assertFails(as(u).doc('carteira_reativacoes/novo').set({ destinoUid: u, estado: 'RESERVADA' })); await assertFails(as(u).doc('carteira_comercial_historico/h').set({ tipoEvento: 'REATIVACAO_120D_PRIMEIRA_VENDA' })); }
});
test('dry-run e contexto são SOMENTE LEITURA (sem set/update/create/delete/batch/transaction no Firestore)', () => {
  for (const f of ['scripts/b3_dryrun.js', 'lib/reativacaoContexto.js', 'lib/gcFetchDerivado.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\b(vendasPorCliente|cooldowns|followUps|conflitosGc|ultimaRev|porCliente|porVenda|owners|cmp|situ|o|conflitosGc|ids)\.(set|add|delete)\(/g, '');
    expect(src).not.toMatch(/\.(update|create|commit)\(|\bbatch\(|runTransaction|\.doc\([^)]*\)\.(set|delete)\(|\.collection\([^)]*\)\.add\(/);
  }
});
