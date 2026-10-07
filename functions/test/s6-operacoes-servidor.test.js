'use strict';
// S6 — claim/release/outcome: identidade do servidor, payload estrito, concorrência, idempotência, auditoria, bypass direto. (EMULADOR)
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const { claimOpportunityHandler: claim, registerOutcomeHandler: outcome, releaseOpportunityHandler: release } = require('../lib/canaryCallable');
const { criarEstadoInicial } = require('../lib/filaOperacional');
const { fabrica } = require('../lib/auditoriaTriggers');
jest.setTimeout(60000);

const ADE = 's6-ade', FAB = 's6-fab', BLOQ = 's6-bloq', SEM = 's6-sem', GES = 's6-ges';
const O = { a: 's6aaaaaaaaaaaa01', livre: 's6aaaaaaaaaaaa02', race: 's6aaaaaaaaaaaa03', out: 's6aaaaaaaaaaaa04', rel: 's6aaaaaaaaaaaa05', aud: 's6aaaaaaaaaaaa06' };
const hex = s => s.replace(/s6/, 'ab').replace(/[^0-9a-f]/g, 'c');            // ids precisam casar /^[0-9a-f]{16}$/
const ID = Object.fromEntries(Object.entries(O).map(([k, v]) => [k, hex(v)]));
const criados = []; const put = async (p, d) => { criados.push(p); await db.doc(p).set(d); };
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
const agora = () => new Date().toISOString();
const hojeFort = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
let wlAntes = null;
const estado = (k, ent) => ({ ...criarEstadoInicial(ent, ID[k], 'REATIVACAO_120D', agora()), nomeCliente: 'Cliente ' + k });

beforeAll(async () => {
  const w = await db.doc('fila_comercial/worklist').get(); wlAntes = w.exists ? w.data() : null;
  for (const [uid, role, mods, extra] of [[ADE, 'funcionario', ['fila-comercial-operar'], {}], [FAB, 'funcionario', ['fila-comercial-operar'], {}], [BLOQ, 'funcionario', ['fila-comercial-operar'], { bloqueado: true }],
    [SEM, 'funcionario', ['ponto'], {}], [GES, 'gestor', [], {}]]) { await put('users/' + uid, { role, ativo: true }); await put('sistema_usuarios/' + uid, { nome: uid, modulos: mods, admin: false, ...extra }); }
  await db.doc('fila_comercial/worklist').set({ schemaVersion: 'worklist-v2', dataReferencia: hojeFort(), atribuicoes: { [ID.a]: { uid: ADE, commercialEntityId: 'GC_NATIVE:66000001', tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente A' } }, vendedores: {}, vendedoresAtivos: [] });
  for (const k of ['livre', 'race', 'out', 'rel', 'aud']) await put('interacoes_fila/' + ID[k], estado(k, 'GC_NATIVE:6600' + (10 + Object.keys(ID).indexOf(k))));
});
afterAll(async () => {
  for (const p of criados) await db.doc(p).delete();
  for (const k of Object.keys(ID)) await db.doc('interacoes_fila/' + ID[k]).delete();
  for (const d of (await db.collection('crm_notas_privadas').where('operadorId', 'in', [ADE, FAB]).get()).docs) await d.ref.delete();
  for (const d of (await db.collection('audit_log').where('entityId', 'in', Object.values(ID)).get()).docs) await d.ref.delete();
  if (wlAntes) await db.doc('fila_comercial/worklist').set(wlAntes); else await db.doc('fila_comercial/worklist').delete();
});
const erro = p => p.then(() => 'OK', e => e.code);

describe('S6 — identidade, autorização, payload', () => {
  test('anônimo, bloqueado e sem módulo são recusados', async () => {
    expect(await erro(claim(req(null, { opportunityInstanceId: ID.livre })))).toBe('unauthenticated');
    expect(await erro(claim(req(BLOQ, { opportunityInstanceId: ID.livre })))).toBe('permission-denied');
    expect(await erro(claim(req(SEM, { opportunityInstanceId: ID.livre })))).toBe('permission-denied');
    expect(await erro(outcome(req(GES, { opportunityInstanceId: ID.livre, outcome: 'SEM_RESPOSTA' })))).toBe('permission-denied');   // gestão não opera como vendedor
  });
  test('vendedor não falsifica o operador: campos de identidade no payload são recusados e nada é gravado', async () => {
    for (const campo of ['actorUid', 'operadorUid', 'operadorId', 'sellerUid', 'vendedorUid', 'uid']) {
      expect(await erro(claim(req(ADE, { opportunityInstanceId: ID.livre, [campo]: FAB })))).toBe('invalid-argument');
      expect(await erro(release(req(ADE, { opportunityInstanceId: ID.livre, [campo]: FAB })))).toBe('invalid-argument');
      expect(await erro(outcome(req(ADE, { opportunityInstanceId: ID.livre, outcome: 'SEM_RESPOSTA', [campo]: FAB })))).toBe('invalid-argument');
    }
    expect((await db.doc('interacoes_fila/' + ID.livre).get()).data().eventos).toEqual([]);
  });
  test('payload inesperado/inválido é recusado', async () => {
    expect(await erro(claim(req(ADE, { opportunityInstanceId: ID.livre, extra: 1 })))).toBe('invalid-argument');
    expect(await erro(claim(req(ADE, 'x')))).toBe('invalid-argument');
    expect(await erro(claim(req(ADE, { opportunityInstanceId: 'zz' })))).toBe('invalid-argument');
    expect(await erro(outcome(req(ADE, { opportunityInstanceId: ID.livre, outcome: 'SEM_RESPOSTA', requestId: 'curto' })))).toBe('invalid-argument');
  });
  test('vendedor não opera oportunidade atribuída ao outro; estado inválido é recusado', async () => {
    expect(await erro(claim(req(FAB, { opportunityInstanceId: ID.a })))).toBe('permission-denied');
    expect(await erro(outcome(req(ADE, { opportunityInstanceId: ID.livre, outcome: 'SEM_RESPOSTA' })))).toBe('failed-precondition');   // não está em atendimento
    expect(await erro(release(req(ADE, { opportunityInstanceId: ID.livre })))).toBe('failed-precondition');
  });
});

describe('S6 — concorrência', () => {
  test('claim simultâneo de dois vendedores: exatamente UM vence, um único claim/evento', async () => {
    const r = await Promise.allSettled([claim(req(ADE, { opportunityInstanceId: ID.race })), claim(req(FAB, { opportunityInstanceId: ID.race }))]);
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter(x => x.status === 'rejected')[0].reason.code).toBe('already-exists');
    const d = (await db.doc('interacoes_fila/' + ID.race).get()).data();
    expect(d.eventos.filter(e => e.tipo === 'CLAIMED')).toHaveLength(1);
    expect([ADE, FAB]).toContain(d.claimAtual.operadorId);
    expect(d.eventos[0].operadorId).toBe(d.claimAtual.operadorId);
  });
  test('o perdedor não consegue registrar resultado nem liberar o claim do vencedor', async () => {
    const d = (await db.doc('interacoes_fila/' + ID.race).get()).data(); const perdedor = d.claimAtual.operadorId === ADE ? FAB : ADE;
    expect(await erro(outcome(req(perdedor, { opportunityInstanceId: ID.race, outcome: 'SEM_RESPOSTA' })))).toBe('permission-denied');
    expect(await erro(release(req(perdedor, { opportunityInstanceId: ID.race })))).toBe('permission-denied');
  });
});

describe('S6 — idempotência (retry não duplica)', () => {
  test('claim repetido do mesmo operador devolve sucesso sem novo evento', async () => {
    await claim(req(ADE, { opportunityInstanceId: ID.out }));
    const r = await claim(req(ADE, { opportunityInstanceId: ID.out }));
    expect(r.estado).toBe('EM_ATENDIMENTO');
    expect((await db.doc('interacoes_fila/' + ID.out).get()).data().eventos.filter(e => e.tipo === 'CLAIMED')).toHaveLength(1);
  });
  test('outcome com o mesmo requestId: aplicado uma vez só (1 evento, 1 nota); segundo retorno repete o resultado', async () => {
    const payload = { opportunityInstanceId: ID.out, outcome: 'PEDIU_RETORNO', scheduledFor: (d => { d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })(new Date()), nota: 'ligar', requestId: 'req-s6-0001-abcd' };
    const r1 = await outcome(req(ADE, payload)); const r2 = await outcome(req(ADE, payload));
    expect(r2.repetido).toBe(true); expect(r2.outcome).toBe(r1.outcome); expect(r2.nextFollowUpAt).toBe(r1.nextFollowUpAt);
    const d = (await db.doc('interacoes_fila/' + ID.out).get()).data();
    expect(d.eventos.filter(e => e.tipo === 'OUTCOME_REGISTERED')).toHaveLength(1);
    const notas = await db.collection('crm_notas_privadas').where('opportunityInstanceId', '==', ID.out).get(); expect(notas.size).toBe(1);
  });
  test('outro operador não pode "reaproveitar" o requestId de alguém', async () => {
    expect(await erro(outcome(req(FAB, { opportunityInstanceId: ID.out, outcome: 'SEM_RESPOSTA', requestId: 'req-s6-0001-abcd' })))).toBe('failed-precondition');
  });
  test('release repetido do mesmo operador: 1 evento RELEASED', async () => {
    await claim(req(ADE, { opportunityInstanceId: ID.rel }));
    await release(req(ADE, { opportunityInstanceId: ID.rel })); const r = await release(req(ADE, { opportunityInstanceId: ID.rel }));
    expect(r.estado).toBe('DISPONIVEL');
    expect((await db.doc('interacoes_fila/' + ID.rel).get()).data().eventos.filter(e => e.tipo === 'RELEASED')).toHaveLength(1);
  });
});

describe('S6 — integração com a auditoria S7', () => {
  const H = fabrica(db, FieldValue);
  const aplicar = async (id, fn) => {
    const ref = db.doc('interacoes_fila/' + id); const antes = await ref.get();
    const out = await fn(); const depois = await ref.get();
    const snap = s => ({ exists: s.exists, data: () => s.data() });
    await H.interacoes({ id: 'ev-' + id + '-' + Date.now(), data: { before: snap(antes), after: snap(depois) }, params: { oppId: id } });
    return out;
  };
  test('operação concluída gera evento com o operador autenticado; falha NÃO gera evento', async () => {
    const lista = async () => (await db.collection('audit_log').where('entityId', '==', ID.aud).get()).docs.map(d => d.data());
    await aplicar(ID.aud, () => erro(claim(req(SEM, { opportunityInstanceId: ID.aud }))));            // recusado
    expect(await lista()).toHaveLength(0);
    await aplicar(ID.aud, () => claim(req(FAB, { opportunityInstanceId: ID.aud })));
    await aplicar(ID.aud, () => outcome(req(FAB, { opportunityInstanceId: ID.aud, outcome: 'SEM_RESPOSTA' })));
    const ev = await lista();
    expect(ev.map(e => e.action).sort()).toEqual(['OPP_CLAIMED', 'OPP_OUTCOME_REGISTERED']);
    expect(ev.every(e => e.actorUid === FAB && e.actorRole === 'funcionario')).toBe(true);
    await aplicar(ID.aud, () => erro(outcome(req(ADE, { opportunityInstanceId: ID.aud, outcome: 'SEM_RESPOSTA' }))));   // recusado de novo
    expect(await lista()).toHaveLength(2);
  });
});
