'use strict';
// B2 — Rules com documentos carteira-v2: isolamento e imutabilidade preservados (acesso direto ao Firestore).
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const VD1 = 'b2r-vd1', VD2 = 'b2r-vd2', RV4 = 'b2r-rv4', GES = 'b2r-ges';
let env;
const dv2 = (gc, o, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: o, ownerDesde: 'x', versao: 2, status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, conflito: null, ...ex });
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore(); const u = (id, r, m) => Promise.all([d.doc('users/' + id).set({ role: r, ativo: true }), d.doc('sistema_usuarios/' + id).set({ admin: false, modulos: m })]);
    await u(VD1, 'funcionario', ['fila-comercial-operar', 'clientes']); await u(VD2, 'funcionario', ['fila-comercial-operar']); await u(RV4, 'funcionario', ['fila-comercial-gestao']); await u(GES, 'gestor', []);
    await d.doc('carteira_comercial/GC:1').set(dv2('1', VD1)); await d.doc('carteira_comercial/GC:2').set(dv2('2', VD2, { status: 'EM_REVISAO', conflito: { revisao: 'PENDENTE' } }));
    await d.doc('carteira_comercial_historico/h1').set({ schemaVersion: 'historico-v2', portfolioId: 'GC:1', tipoEvento: 'RENOVACAO_CICLO' });
  });
});
afterAll(async () => { await env.cleanup(); });
const as = u => env.authenticatedContext(u).firestore();
test('vendedor lê só a própria carteira v2 (inclusive EM_REVISAO); não lê a do outro nem lista tudo', async () => {
  await assertSucceeds(as(VD1).doc('carteira_comercial/GC:1').get()); await assertFails(as(VD1).doc('carteira_comercial/GC:2').get());
  await assertSucceeds(as(VD2).doc('carteira_comercial/GC:2').get()); await assertFails(as(VD2).doc('carteira_comercial/GC:1').get());
  await assertFails(as(VD1).collection('carteira_comercial').get()); await assertSucceeds(as(VD1).collection('carteira_comercial').where('ownerUid', '==', VD1).get());
});
test('gestão (gestor e Revisor4 sem admin) lê tudo; histórico só gestão', async () => {
  for (const u of [GES, RV4]) { await assertSucceeds(as(u).collection('carteira_comercial').get()); await assertSucceeds(as(u).doc('carteira_comercial_historico/h1').get()); }
  for (const u of [VD1, VD2]) await assertFails(as(u).doc('carteira_comercial_historico/h1').get());
});
test('NINGUÉM escreve carteira/histórico pelo SDK (dono, outro vendedor, Revisor4, gestor): owner, status, conflito, versão, evento', async () => {
  for (const u of [VD1, VD2, RV4, GES]) {
    await assertFails(as(u).doc('carteira_comercial/GC:1').update({ ownerUid: u })); await assertFails(as(u).doc('carteira_comercial/GC:1').update({ status: 'LIBERADA', ownerUid: null }));
    await assertFails(as(u).doc('carteira_comercial/GC:2').update({ conflito: null, status: 'ATIVA' })); await assertFails(as(u).doc('carteira_comercial/GC:1').update({ versao: 99 }));
    await assertFails(as(u).doc('carteira_comercial/GC:9').set(dv2('9', u))); await assertFails(as(u).doc('carteira_comercial/GC:1').delete());
    await assertFails(as(u).doc('carteira_comercial_historico/h1').update({ tipoEvento: 'X' })); await assertFails(as(u).doc('carteira_comercial_historico/h9').set({ tipoEvento: 'TRANSFERENCIA' })); await assertFails(as(u).doc('carteira_comercial_historico/h1').delete());
  }
});
test('Revisor4 continua não-admin (S5)', async () => { await assertFails(as(RV4).doc('sistema_usuarios/' + RV4).update({ admin: true })); });
