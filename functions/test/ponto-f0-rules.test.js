'use strict';
// PONTO MR4 2.0 — Fase 0 · Rules (EMULADOR). P0-02 correção aditiva / original imutável / trilha; P1-05 autoedição.
// Reproduz exatamente as escritas que ponto.html faz na aprovação (batch: marca original + cria correção + decide justificativa).
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('@firebase/firestore');
const { readFileSync } = require('fs');
const { resolve } = require('path');
jest.setTimeout(60000);

const PROJECT_ID = 'mr4-ponto';
const RULES = readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
let testEnv;

const UID_G = 'f0-gestor', UID_GF = 'f0-gestor-func', UID_D = 'f0-dual', UID_E = 'f0-func', UID_E2 = 'f0-func2';
const F_GF = 'f0-fn-gestor', F_D = 'f0-fn-dual', F_E = 'f0-fn-func', F_E2 = 'f0-fn-func2';
const DIA = '2026-09-28';
const ctx = uid => testEnv.authenticatedContext(uid, { email: uid + '@mr4.test' }).firestore();

async function seed(db) {
  const u = (uid, d) => db.collection('users').doc(uid).set({ ativo: true, ...d });
  await u(UID_G, { role: 'gestor' });
  await u(UID_GF, { role: 'gestor', funcionarioId: F_GF });                 // gestor que também bate ponto
  await u(UID_D, { role: 'funcionario', funcionarioId: F_D });              // dual-role com módulo ponto
  await u(UID_E, { role: 'funcionario', funcionarioId: F_E });
  await u(UID_E2, { role: 'funcionario', funcionarioId: F_E2 });
  for (const uid of [UID_G, UID_GF, UID_D]) await db.collection('sistema_usuarios').doc(uid).set({ modulos: ['ponto'], admin: false });
  const reg = (id, funcId, tipo, hora) => db.collection('registros').doc(id).set({ id, funcId, data: DIA, tipo, hora, funcNome: funcId, criadoEm: DIA + 'T11:00:00Z' });
  await reg('r-e-ent', F_E, 'entrada', '08:05:00');
  await reg('r-d-ent', F_D, 'entrada', '08:10:00');
  await reg('r-gf-ent', F_GF, 'entrada', '08:12:00');
  const jus = (id, funcId, extra = {}) => db.collection('justificativas').doc(id).set({ id, funcId, funcNome: funcId, data: DIA, motivo: 'Ponto não batido',
    descricao: 'Esqueci de bater no horário certo', tipoPonto: 'entrada', horarioPonto: '08:00', status: 'pendente', lancadoPorGestor: false, criadoEm: DIA + 'T12:00:00Z', ...extra });
  await jus('j-e-1', F_E); await jus('j-e-2', F_E, { horarioPonto: '07:58' });
  await jus('j-d-1', F_D); await jus('j-gf-1', F_GF);
}
beforeAll(async () => { testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: RULES, host: 'localhost', port: 8080 } }); });
beforeEach(async () => { await testEnv.clearFirestore(); await testEnv.withSecurityRulesDisabled(async c => seed(c.firestore())); });
afterAll(async () => { await testEnv.clearFirestore(); await testEnv.cleanup(); });

/** Mesmas escritas do ponto.html → responderJustificativa('aprovado') para correção de batida. */
function aprovarCorrecao(db, uid, justifId, j, vigentes) {
  const b = db.batch();
  const regId = 'corr_' + justifId;
  for (const r of vigentes) b.update(db.collection('registros').doc(r.id), { substituidoPor: regId, substituidoEm: serverTimestamp(), substituidoPorJustificativa: justifId });
  const originais = vigentes.map(r => ({ id: r.id, hora: r.hora, tipo: r.tipo }));
  b.set(db.collection('registros').doc(regId), { id: regId, funcId: j.funcId, funcNome: j.funcId, data: DIA, hora: j.horarioPonto + ':00', tipo: 'entrada', lancadoPorJustificativa: true,
    justificativaId: justifId, correcaoDe: originais.map(o => o.id), valorOriginal: originais, valorProposto: j.horarioPonto + ':00', motivoCorrecao: 'Ponto não batido',
    descricaoCorrecao: 'Esqueci de bater no horário certo', solicitadoPorFuncId: j.funcId, solicitadoEm: DIA + 'T12:00:00Z', aprovadoPorUid: uid, aprovadoPorEmail: uid + '@mr4.test',
    aprovadoEm: serverTimestamp(), criadoEm: '2026-09-28T13:00:00Z' });
  b.update(db.collection('justificativas').doc(justifId), { status: 'aprovado', obsGestor: 'ok', respondidoPorUid: uid, respondidoPorEmail: uid + '@mr4.test', respondidoEm: serverTimestamp(),
    registroEfetivoId: regId, registrosOriginais: originais });
  return b.commit();
}
const ler = async path => { let d; await testEnv.withSecurityRulesDisabled(async c => { const s = await c.firestore().doc(path).get(); d = s.exists ? s.data() : null; }); return d; };

describe('P0-02 — correção aditiva: original preservado + trilha', () => {
  test('CORR-01 aprovação: original continua existindo (hora intacta) e marcado; correção guarda ORIGINAL/PEDIDO/SOLICITANTE/APROVADOR/QUANDO', async () => {
    await assertSucceeds(aprovarCorrecao(ctx(UID_G), UID_G, 'j-e-1', { funcId: F_E, horarioPonto: '08:00' }, [{ id: 'r-e-ent', hora: '08:05:00', tipo: 'entrada' }]));
    const orig = await ler('registros/r-e-ent'), corr = await ler('registros/corr_j-e-1'), j = await ler('justificativas/j-e-1');
    expect(orig).toMatchObject({ hora: '08:05:00', tipo: 'entrada', substituidoPor: 'corr_j-e-1', substituidoPorJustificativa: 'j-e-1' });
    expect(orig.substituidoEm).toBeTruthy();
    expect(corr).toMatchObject({ hora: '08:00:00', valorOriginal: [{ id: 'r-e-ent', hora: '08:05:00', tipo: 'entrada' }], valorProposto: '08:00:00', motivoCorrecao: 'Ponto não batido',
      solicitadoPorFuncId: F_E, aprovadoPorUid: UID_G, justificativaId: 'j-e-1' });
    expect(corr.aprovadoEm).toBeTruthy();
    expect(j).toMatchObject({ status: 'aprovado', respondidoPorUid: UID_G, registroEfetivoId: 'corr_j-e-1' });
  });
  test('CORR-02 original NUNCA pode ser apagado pelo cliente (gestor, dual-role, funcionário)', async () => {
    for (const uid of [UID_G, UID_D, UID_E]) await assertFails(ctx(uid).collection('registros').doc('r-e-ent').delete());
  });
  test('CORR-03 original imutável: não pode mudar hora/tipo; substituição só uma vez e só com os campos de substituição', async () => {
    await assertFails(ctx(UID_G).collection('registros').doc('r-e-ent').update({ hora: '08:00:00' }));
    await assertFails(ctx(UID_G).collection('registros').doc('r-e-ent').update({ substituidoPor: 'x', hora: '08:00:00' }));
    await assertSucceeds(ctx(UID_G).collection('registros').doc('r-e-ent').update({ substituidoPor: 'corr_a', substituidoEm: serverTimestamp(), substituidoPorJustificativa: 'a' }));
    await assertFails(ctx(UID_G).collection('registros').doc('r-e-ent').update({ substituidoPor: 'corr_b' }));   // 2ª vez
  });
  test('CORR-04 segunda correção NÃO apaga a primeira: a 1ª correção vira "substituída" e as três versões continuam', async () => {
    await assertSucceeds(aprovarCorrecao(ctx(UID_G), UID_G, 'j-e-1', { funcId: F_E, horarioPonto: '08:00' }, [{ id: 'r-e-ent', hora: '08:05:00', tipo: 'entrada' }]));
    await assertSucceeds(aprovarCorrecao(ctx(UID_D), UID_D, 'j-e-2', { funcId: F_E, horarioPonto: '07:58' }, [{ id: 'corr_j-e-1', hora: '08:00:00', tipo: 'entrada' }]));
    const [o, c1, c2] = [await ler('registros/r-e-ent'), await ler('registros/corr_j-e-1'), await ler('registros/corr_j-e-2')];
    expect([o.hora, c1.hora, c2.hora]).toEqual(['08:05:00', '08:00:00', '07:58:00']);
    expect([o.substituidoPor, c1.substituidoPor, c2.substituidoPor]).toEqual(['corr_j-e-1', 'corr_j-e-2', undefined]);
    expect(c2).toMatchObject({ aprovadoPorUid: UID_D, valorOriginal: [{ id: 'corr_j-e-1', hora: '08:00:00', tipo: 'entrada' }] });
  });
  test('CORR-05 rejeição registra quem/quando; decisão só a partir de "pendente" (não aprova 2× nem reverte em silêncio)', async () => {
    await assertSucceeds(ctx(UID_G).collection('justificativas').doc('j-e-1').update({ status: 'rejeitado', obsGestor: 'sem prova', respondidoPorUid: UID_G, respondidoPorEmail: UID_G + '@mr4.test', respondidoEm: serverTimestamp() }));
    const j = await ler('justificativas/j-e-1');
    expect(j).toMatchObject({ status: 'rejeitado', respondidoPorUid: UID_G });
    await assertFails(ctx(UID_G).collection('justificativas').doc('j-e-1').update({ status: 'aprovado' }));
    await assertFails(aprovarCorrecao(ctx(UID_D), UID_D, 'j-e-1', { funcId: F_E, horarioPonto: '08:00' }, [{ id: 'r-e-ent', hora: '08:05:00', tipo: 'entrada' }]));
    expect((await ler('registros/r-e-ent')).substituidoPor).toBeUndefined();   // batch atômico: nada aplicado
  });
});

describe('P1-05 — ninguém edita/aprova/corrige o próprio ponto (chamada direta às Rules)', () => {
  test('SELF-01 dual-role: aprovar a própria justificativa, corrigir o próprio registro, lançar crédito ou espelho próprio → NEGADO', async () => {
    const d = ctx(UID_D);
    await assertFails(aprovarCorrecao(d, UID_D, 'j-d-1', { funcId: F_D, horarioPonto: '08:00' }, [{ id: 'r-d-ent', hora: '08:10:00', tipo: 'entrada' }]));
    await assertFails(d.collection('justificativas').doc('j-d-1').update({ status: 'rejeitado', respondidoPorUid: UID_D, respondidoPorEmail: UID_D + '@mr4.test', respondidoEm: serverTimestamp() }));
    await assertFails(d.collection('registros').doc('novo-d').set({ id: 'novo-d', funcId: F_D, data: DIA, tipo: 'saida', hora: '18:00:00' }));
    await assertFails(d.collection('registros').doc('r-d-ent').update({ substituidoPor: 'x', substituidoEm: serverTimestamp(), substituidoPorJustificativa: 'x' }));
    await assertFails(d.collection('creditos_jornada').doc('cred_' + F_D + '_' + DIA).set({ id: 'c', funcId: F_D, data: DIA, minutos: 480, motivo: 'Atestado médico' }));
    await assertFails(d.collection('espelhos').doc('esp-d').set({ funcId: F_D, mes: '2026-09', assinado: false }));
    await assertFails(d.collection('justificativas').doc('j-d-auto').set({ id: 'j-d-auto', funcId: F_D, data: DIA, motivo: 'Férias', status: 'aprovado', lancadoPorGestor: true }));
    await assertFails(d.collection('justificativas').doc('j-d-1').delete());
  });
  test('SELF-02 gestor que também é funcionário: mesma regra (privilégio de gestor não vale para o próprio ponto)', async () => {
    const g = ctx(UID_GF);
    await assertFails(aprovarCorrecao(g, UID_GF, 'j-gf-1', { funcId: F_GF, horarioPonto: '08:00' }, [{ id: 'r-gf-ent', hora: '08:12:00', tipo: 'entrada' }]));
    await assertFails(g.collection('creditos_jornada').doc('c-gf').set({ id: 'c-gf', funcId: F_GF, data: DIA, minutos: 480, motivo: 'Atestado médico' }));
  });
  test('SELF-03 os mesmos usuários CONTINUAM podendo decidir sobre o ponto dos OUTROS', async () => {
    await assertSucceeds(aprovarCorrecao(ctx(UID_D), UID_D, 'j-e-1', { funcId: F_E, horarioPonto: '08:00' }, [{ id: 'r-e-ent', hora: '08:05:00', tipo: 'entrada' }]));
    await assertSucceeds(ctx(UID_GF).collection('creditos_jornada').doc('cred_' + F_E2 + '_' + DIA).set({ id: 'c', funcId: F_E2, data: DIA, minutos: 480, motivo: 'Atestado médico' }));
    await assertSucceeds(ctx(UID_G).collection('espelhos').doc('esp-e').set({ funcId: F_E, mes: '2026-09', assinado: false }));
  });
  test('SELF-04 caminho do funcionário intacto: cria a própria justificativa pendente; não aprova nada', async () => {
    const e = ctx(UID_E);
    await assertSucceeds(e.collection('justificativas').doc('j-e-nova').set({ id: 'j-e-nova', funcId: F_E, data: DIA, motivo: 'Atestado médico', descricao: 'x', status: 'pendente', lancadoPorGestor: false }));
    await assertFails(e.collection('justificativas').doc('j-e-1').update({ status: 'aprovado' }));
    const dual = ctx(UID_D);          // dual-role também pode justificar o próprio ponto como FUNCIONÁRIO (pendente)
    await assertSucceeds(dual.collection('justificativas').doc('j-d-nova').set({ id: 'j-d-nova', funcId: F_D, data: DIA, motivo: 'Atestado médico', descricao: 'x', status: 'pendente', lancadoPorGestor: false }));
  });
});
