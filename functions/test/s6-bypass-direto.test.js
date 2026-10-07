'use strict';
// S6 — acesso direto ao Firestore NÃO contorna o backend: o navegador não cria/altera/apaga oportunidade, claim, nota, carteira nem auditoria.
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const ADE = 's6b-ade', FAB = 's6b-fab', GES = 's6b-ges', ADM = 's6b-adm';
let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore(); const u = (id, x, y) => Promise.all([d.doc('users/' + id).set(x), d.doc('sistema_usuarios/' + id).set(y)]);
    await u(ADE, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-operar', 'clientes'] });
    await u(FAB, { role: 'funcionario', ativo: true }, { admin: false, modulos: ['fila-comercial-operar'] });
    await u(GES, { role: 'gestor', ativo: true }, { admin: false, modulos: [] });
    await u(ADM, { role: 'gestor', ativo: true }, { admin: true, modulos: [] });
    await d.doc('interacoes_fila/opp1').set({ estado: 'DISPONIVEL', claimAtual: null, eventos: [] });
    await d.doc('fila_comercial/worklist').set({ atribuicoes: {} });
  });
});
afterAll(async () => { await env.cleanup(); });
const as = uid => env.authenticatedContext(uid).firestore();
describe('S6 — bypass direto', () => {
  for (const [nome, uid] of [['vendedor Ademir', ADE], ['vendedora Fabiana', FAB], ['gestor', GES], ['admin', ADM]]) {
    test(`${nome}: não fabrica claim/estado/evento/nota/carteira/auditoria pelo SDK`, async () => {
      const db = as(uid);
      await assertFails(db.doc('interacoes_fila/opp1').update({ estado: 'EM_ATENDIMENTO', claimAtual: { operadorId: uid } }));
      await assertFails(db.doc('interacoes_fila/opp1').update({ eventos: [{ tipo: 'OUTCOME_REGISTERED', operadorId: uid }] }));
      await assertFails(db.doc('interacoes_fila/novo').set({ estado: 'DISPONIVEL' }));
      await assertFails(db.doc('interacoes_fila/opp1').delete());
      await assertFails(db.doc('crm_notas_privadas/opp1__0').set({ operadorId: uid, texto: 'x' }));
      await assertFails(db.doc('fila_comercial/worklist').update({ atribuicoes: { opp1: { uid } } }));
      await assertFails(db.doc('carteira_comercial/GC:1').set({ ownerUid: uid }));
      await assertFails(db.doc('carteira_comercial_historico/h1').set({ tipoEvento: 'x', ownerNovoUid: uid }));
      await assertFails(db.doc('audit_log/forjado').set({ actorUid: 'outro', action: 'X' }));
    });
  }
});
