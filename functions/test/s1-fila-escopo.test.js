'use strict';
// S1 — crmConsulta { acao:'fila' }: escopo no servidor (EMULADOR localhost:8080) + garantias estáticas do frontend migrado.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const Q = require('../lib/crmConsulta');
jest.setTimeout(60000);

const VD1 = 's1f-vd1', VD2 = 's1f-vd2', RV4 = 's1f-rv4', GES = 's1f-ges', SEM = 's1f-sem';
const OA = 's1f0000000000a1', OA2 = 's1f0000000000a2', OF = 's1f0000000000f1', OC = 's1f0000000000c1';
const criados = []; const put = async (p, d) => { criados.push(p); await db.doc(p).set(d); };
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
const erro = p => p.then(() => 'OK', e => e.code + ':' + e.message);
let wlAntes = null;
const item = (o, e, n) => ({ opportunityInstanceId: o, commercialEntityId: e, nomeCliente: n, tipoOportunidade: 'REATIVACAO_120D' });
const ev = (op, outcome) => ({ tipo: 'OUTCOME_REGISTERED', operadorId: op, outcome, timestamp: '2026-10-06T13:00:00.000Z', meta: { temNota: true } });

beforeAll(async () => {
  const w = await db.doc('fila_comercial/worklist').get(); wlAntes = w.exists ? w.data() : null;
  for (const [uid, role, mods] of [[VD1, 'funcionario', ['fila-comercial-operar']], [VD2, 'funcionario', ['fila-comercial-operar']], [RV4, 'funcionario', ['fila-comercial-gestao']], [GES, 'gestor', []], [SEM, 'funcionario', ['ponto']]]) {
    await put('users/' + uid, { role, ativo: true }); await put('sistema_usuarios/' + uid, { nome: uid, modulos: mods, admin: false });
  }
  await db.doc('fila_comercial/worklist').set({ schemaVersion: 'worklist-v2', versao: 'x', dataReferencia: '2026-10-07', geradoEm: 'g', cap: 10, vendedoresAtivos: [VD1, VD2],
    vendedoresRotulos: { [VD1]: 'Vend1', [VD2]: 'Vend2' }, vendedoresConfig: { [VD2]: { limite: 9 } }, contagens: { x: 1 }, canarios: ['seg'], pendenciasRetidas: {},
    atribuicoes: { [OA]: { uid: VD1 }, [OF]: { uid: VD2 } },
    vendedores: { [VD1]: { novas: [item(OA, 'GC_NATIVE:11111111', 'Cliente do Vend1')], followUps: [], emAtendimento: [], pendentes: [] },
                  [VD2]: { novas: [item(OF, 'GC_NATIVE:22222222', 'Cliente da Vend2')], followUps: [], emAtendimento: [], pendentes: [] } } });
  await put('interacoes_fila/' + OA, { opportunityInstanceId: OA, commercialEntityId: 'GC_NATIVE:11111111', estado: 'DISPONIVEL', claimAtual: null, eventos: [], nextFollowUpAt: null });
  await put('interacoes_fila/' + OA2, { opportunityInstanceId: OA2, commercialEntityId: 'GC_NATIVE:33333333', estado: 'ABERTA', claimAtual: null, eventos: [ev(VD1, 'PEDIU_RETORNO')], nextFollowUpAt: '2026-10-08' });
  await put('interacoes_fila/' + OF, { opportunityInstanceId: OF, commercialEntityId: 'GC_NATIVE:22222222', estado: 'EM_ATENDIMENTO', claimAtual: { operadorId: VD2, claimadoEm: '2026-10-07T12:00:00.000Z' }, eventos: [ev(VD2, 'SEM_RESPOSTA')], nextFollowUpAt: null });
  await put('interacoes_fila/' + OC, { opportunityInstanceId: OC, commercialEntityId: 'GC_NATIVE:44444444', estado: 'ABERTA', claimAtual: null, eventos: [ev(VD2, 'PEDIU_RETORNO')], nextFollowUpAt: '2026-10-09' });
});
afterAll(async () => {
  for (const p of criados) await db.doc(p).delete();
  if (wlAntes) await db.doc('fila_comercial/worklist').set(wlAntes); else await db.doc('fila_comercial/worklist').delete();
});
const fila = uid => Q.crmConsultaHandler(req(uid, { acao: 'fila' }), { db });

describe('S1 backend — escopo da fila', () => {
  test('vendedor Vend1 recebe só a própria worklist e as próprias oportunidades', async () => {
    const r = await fila(VD1);
    expect(r.escopo).toBe('VENDEDOR');
    expect(Object.keys(r.worklist.vendedores)).toEqual([VD1]);
    expect(r.worklist.vendedoresAtivos).toEqual([VD1]);
    const ids = r.interacoes.map(i => i.opportunityInstanceId).sort();
    expect(ids).toEqual([OA, OA2].sort());
    const txt = JSON.stringify(r);
    for (const proibido of ['Cliente da Vend2', VD2, OF, OC, '22222222', '44444444', 'atribuicoes', 'vendedoresConfig', 'canarios', 'pendenciasRetidas']) expect(txt).not.toContain(proibido);
  });
  test('payload do vendedor não traz campo/valor gerencial (ticket, R$)', async () => {
    const achados = [];
    const walk = (o, p) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (/ticket|faturamento|valorTotal|margem/i.test(k)) achados.push(p + '.' + k); walk(v, p + '.' + k); } else if (typeof o === 'string' && /ticket|R\$/i.test(o)) achados.push(p + '=' + o.slice(0, 20)); };
    walk(await fila(VD1), ''); expect(achados).toEqual([]);
  });
  test('vendedora Vend2 recebe só o que é dela (inverso)', async () => {
    const r = await fila(VD2);
    expect(Object.keys(r.worklist.vendedores)).toEqual([VD2]);
    expect(r.interacoes.map(i => i.opportunityInstanceId).sort()).toEqual([OF, OC].sort());
    const txt = JSON.stringify(r);
    for (const proibido of ['Cliente do Vend1', VD1, OA, OA2, '11111111', '33333333']) expect(txt).not.toContain(proibido);
  });
  test('eventos de outro operador em oportunidade visível são reduzidos (sem identidade real, sem meta/nota)', async () => {
    await db.doc('interacoes_fila/' + OA).update({ eventos: [ev(VD2, 'SEM_RESPOSTA')], claimAtual: { operadorId: VD2, claimadoEm: '2026-10-07T12:30:00.000Z' } });
    const r = await fila(VD1);
    const o = r.interacoes.find(i => i.opportunityInstanceId === OA);
    expect(o.claimAtual.operadorId).toBe('OUTRO');
    expect(o.eventos[0]).toEqual({ tipo: 'OUTCOME_REGISTERED', outcome: 'SEM_RESPOSTA', timestamp: '2026-10-06T13:00:00.000Z', operadorId: 'OUTRO' });
    expect(JSON.stringify(r)).not.toContain(VD2);
    await db.doc('interacoes_fila/' + OA).update({ eventos: [], claimAtual: null });
  });
  test('gestão (role gestor) e Revisor4 (módulo gestão, sem admin) recebem o documento completo', async () => {
    for (const u of [GES, RV4]) {
      const r = await fila(u);
      expect(r.escopo).toBe('GESTAO');
      expect(Object.keys(r.worklist.vendedores).sort()).toEqual([VD1, VD2].sort());
      expect(r.interacoes.map(i => i.opportunityInstanceId)).toEqual(expect.arrayContaining([OA, OA2, OF, OC]));
    }
  });
  test('sem módulo e anônimo são negados', async () => {
    expect(await erro(fila(SEM))).toBe('permission-denied:SEM_PERMISSAO');
    expect(await erro(fila(null))).toMatch(/^unauthenticated/);
  });
  test('payload com campos extras é rejeitado (não vira filtro controlado pelo cliente)', async () => {
    expect(await erro(Q.crmConsultaHandler(req(VD1, { acao: 'fila', vendedorUid: VD2 }), { db }))).toBe('invalid-argument:CAMPOS_NAO_PERMITIDOS');
  });
});

describe('S1 frontend — telas migradas', () => {
  const ROOT = path.join(__dirname, '..', '..', 'modulos');
  for (const f of ['crm.html', 'fila-comercial.html']) {
    test(`${f} lê a fila só via crmConsulta (sem leitura direta de worklist/interacoes_fila)`, () => {
      const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(h).toContain("acao: 'fila'");
      expect(h).not.toMatch(/doc\(db,\s*'fila_comercial',\s*'worklist/);
      expect(h).not.toMatch(/collection\(db,\s*'interacoes_fila'/);
      expect(h).not.toContain('worklist_preview');
    });
  }
  test('crm.html recarrega a fila depois de iniciar, cancelar e salvar', () => {
    const h = fs.readFileSync(path.join(ROOT, 'crm.html'), 'utf8');
    expect((h.match(/finally \{ S\.enviando\.delete\(id\); await carregarFila\(false\); \}/g) || []).length).toBe(3);
  });
});
