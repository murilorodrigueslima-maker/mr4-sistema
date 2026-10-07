'use strict';
// S7 — gatilhos de auditoria (EMULADOR localhost:8080): autor derivado do servidor, idempotência, PII mínima, append-only no código.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const A = require('../lib/auditoria'); const { fabrica } = require('../lib/auditoriaTriggers');
const H = fabrica(db, FieldValue);
jest.setTimeout(60000);
const ADM = 's7t-adm', VEND = 's7t-vend', ALVO = 's7t-alvo';
const snap = d => ({ exists: d !== null && d !== undefined, data: () => d });
const ev = (id, antes, depois, extra = {}) => ({ id, data: { before: snap(antes), after: snap(depois) }, params: extra.params || {}, authType: extra.authType, authId: extra.authId });
const log = async id => (await db.collection('audit_log').where('entityId', '==', id).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const criados = [];
beforeAll(async () => {
  for (const [uid, role, admin_] of [[ADM, 'gestor', true], [VEND, 'funcionario', false]]) { await db.doc('users/' + uid).set({ role, ativo: true }); await db.doc('sistema_usuarios/' + uid).set({ admin: admin_, modulos: [] }); criados.push('users/' + uid, 'sistema_usuarios/' + uid); }
});
afterAll(async () => { for (const p of criados) await db.doc(p).delete(); const s = await db.collection('audit_log').where('entityId', 'in', [ALVO, 'cli-s7', 'opp-s7', 'opp-s7b']).get(); for (const d of s.docs) await d.ref.delete(); });

describe('S7 — SEGURANÇA/ADMIN', () => {
  test('mudança de admin e módulos: autor vem do contexto de autenticação (uid, role, admin); antes/depois corretos', async () => {
    await H.sistemaUsuarios(ev('e1', { admin: false, modulos: ['ponto'], nome: 'Fulano' }, { admin: true, modulos: ['ponto', 'financeiro'], nome: 'Fulano' }, { params: { uid: ALVO }, authType: 'app_user', authId: ADM }));
    const l = await log(ALVO); const por = a => l.find(x => x.action === a);
    expect(l.map(x => x.action).sort()).toEqual(['ADMIN_FLAG_CHANGED', 'MODULES_CHANGED']);
    expect(por('ADMIN_FLAG_CHANGED')).toMatchObject({ actorUid: ADM, actorType: 'USER', actorRole: 'gestor', actorIsAdmin: true, category: 'SECURITY', before: { admin: false }, after: { admin: true }, entityType: 'sistema_usuarios', schemaVersion: 'audit-v1' });
    expect(por('MODULES_CHANGED').metadata).toEqual({ adicionados: ['financeiro'], removidos: [] });
    expect(por('ADMIN_FLAG_CHANGED').at).toBeTruthy();
  });
  test('o autor NÃO vem do documento: campo actorUid forjado dentro do payload é ignorado', async () => {
    await H.users(ev('e2', { role: 'funcionario', ativo: true }, { role: 'gestor', ativo: true, actorUid: 'fulano-forjado', criadoPor: 'fulano-forjado' }, { params: { uid: ALVO }, authType: 'app_user', authId: VEND }));
    const l = (await log(ALVO)).filter(x => x.action === 'USER_ROLE_CHANGED');
    expect(l).toHaveLength(1); expect(l[0].actorUid).toBe(VEND); expect(l[0].actorRole).toBe('funcionario'); expect(JSON.stringify(l[0])).not.toContain('fulano-forjado');
  });
  test('bloqueio/desbloqueio e escrita por conta de serviço (SYSTEM, sem uid)', async () => {
    await H.sistemaUsuarios(ev('e3', { admin: false, modulos: [] }, { admin: false, modulos: [], bloqueado: true }, { params: { uid: ALVO }, authType: 'service_account', authId: 'sa@x' }));
    const b = (await log(ALVO)).find(x => x.action === 'USER_BLOCKED');
    expect(b).toMatchObject({ actorType: 'SYSTEM', actorUid: null, after: { bloqueado: true } });
  });
  test('alteração sem campo relevante não gera evento', async () => {
    expect(await H.users(ev('e4', { role: 'x', ativo: true, nome: 'a' }, { role: 'x', ativo: true, nome: 'b' }, { params: { uid: ALVO }, authType: 'app_user', authId: ADM }))).toBe(0);
  });
});

describe('S7 — idempotência e imutabilidade', () => {
  test('reentrega do mesmo evento não duplica nem sobrescreve', async () => {
    const e = ev('e5', { role: 'a', ativo: true }, { role: 'b', ativo: true }, { params: { uid: ALVO }, authType: 'app_user', authId: ADM });
    expect(await H.users(e)).toBe(1); const antes = (await db.doc('audit_log/e5_0').get()).data();
    expect(await H.users({ ...e })).toBe(0);
    expect((await db.doc('audit_log/e5_0').get()).data().at.isEqual(antes.at)).toBe(true);
  });
  test('gravar() usa create(): nunca sobrescreve evento existente', async () => {
    await expect(db.collection('audit_log').doc('e5_0').create({ x: 1 })).rejects.toBeTruthy();
  });
  test('código da trilha não contém update/delete/set sobre audit_log (append-only por construção)', () => {
    for (const f of ['auditoria.js', 'auditoriaTriggers.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
      expect(src.replace(/createHash\([^)]*\)\.update\(/g, '')).not.toMatch(/\.(update|delete|set)\(/); expect(src).not.toMatch(/recursiveDelete|ttl/i);
    }
  });
});

describe('S7 — CRM e PII', () => {
  test('cliente: criação, arquivamento e troca de identificador — identificadores só como hash', async () => {
    await H.clientes(ev('e6', null, { nome: 'Fulano Silva', tipo: 'PF', cpf_cnpj: '123.456.789-00', telefone: '85999990000', pipeline: 'lead' }, { params: { clienteId: 'cli-s7' }, authType: 'app_user', authId: VEND }));
    await H.clientes(ev('e7', { nome: 'F', cpf_cnpj: '111', telefone: '85999990000', email: 'a@b.c', pipeline: 'lead' }, { nome: 'F', cpf_cnpj: '222', telefone: '85999990000', email: 'a@b.c', pipeline: 'proposta', arquivado: true }, { params: { clienteId: 'cli-s7' }, authType: 'app_user', authId: ADM }));
    const l = await log('cli-s7'); const acoes = l.map(x => x.action).sort();
    expect(acoes).toEqual(['CLIENTE_ARCHIVED', 'CLIENTE_CREATED', 'CLIENTE_IDENTIFIER_CHANGED', 'CLIENTE_PIPELINE_CHANGED']);
    const txt = JSON.stringify(l);
    for (const pii of ['123.456.789-00', '85999990000', 'Fulano Silva', 'a@b.c', '"111"', '"222"']) expect(txt).not.toContain(pii);
    const id = l.find(x => x.action === 'CLIENTE_IDENTIFIER_CHANGED');
    expect(id.before.valorHash).toMatch(/^sha256:[0-9a-f]{16}$/); expect(id.after.valorHash).not.toBe(id.before.valorHash);
  });
  test('nenhuma chave com cara de segredo é persistida', () => {
    const e = A.evento({ ator: { uid: 'u', type: 'USER', origin: 'x' }, action: 'A', category: 'SECURITY', entityType: 't', entityId: '1', source: 's', after: { token: 'abc', senha: 'x', ok: 1, nested: { apiKey: 'k', v: 2 } } });
    expect(JSON.stringify(e)).not.toMatch(/abc|"senha"|apiKey/); expect(e.after.ok).toBe(1); expect(e.after.nested.v).toBe(2);
  });
});

describe('S7 — OPORTUNIDADE (fila)', () => {
  const op = (eventos, estado = 'EM_ATENDIMENTO', extra = {}) => ({ estado, tipoOportunidade: 'REATIVACAO_120D', commercialEntityId: 'GC_NATIVE:1', eventos, nextFollowUpAt: null, ...extra });
  test('claim e outcome: autor = operadorId gravado pelo servidor; nota não é copiada, só o flag', async () => {
    const c = { tipo: 'CLAIMED', operadorId: VEND, timestamp: 't1' };
    const o = { tipo: 'OUTCOME_REGISTERED', operadorId: VEND, outcome: 'PEDIU_RETORNO', timestamp: 't2', meta: { temNota: true, nota: 'texto privado' } };
    await H.interacoes(ev('e8', null, op([c]), { params: { oppId: 'opp-s7' } }));
    await H.interacoes(ev('e9', op([c]), op([c, o], 'AGUARDANDO_RETORNO', { nextFollowUpAt: '2026-10-20' }), { params: { oppId: 'opp-s7' } }));
    const l = await log('opp-s7'); const acoes = l.map(x => x.action).sort();
    expect(acoes).toEqual(['OPP_CLAIMED', 'OPP_CREATED', 'OPP_OUTCOME_REGISTERED']);
    const out = l.find(x => x.action === 'OPP_OUTCOME_REGISTERED');
    expect(out).toMatchObject({ actorUid: VEND, actorRole: 'funcionario', category: 'COMMERCIAL', metadata: { outcome: 'PEDIU_RETORNO', nextFollowUpAt: '2026-10-20', temNota: true } });
    expect(JSON.stringify(l)).not.toContain('texto privado');
  });
  test('liberação (release) é registrada; reescrita do histórico vira ANOMALIA (não passa silenciosa)', async () => {
    const c = { tipo: 'CLAIMED', operadorId: VEND, timestamp: 't1' }, r = { tipo: 'RELEASED', operadorId: VEND, timestamp: 't3' };
    await H.interacoes(ev('e10', op([c]), op([c, r], 'DISPONIVEL'), { params: { oppId: 'opp-s7b' } }));
    await H.interacoes(ev('e11', op([c, r]), op([{ ...c, operadorId: 'outro' }, r]), { params: { oppId: 'opp-s7b' } }));
    const acoes = (await log('opp-s7b')).map(x => x.action).sort();
    expect(acoes).toEqual(['OPP_HISTORY_REWRITTEN', 'OPP_RELEASED']);
  });
});
