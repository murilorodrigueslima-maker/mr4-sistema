'use strict';
// Fase 4.4 — decisão de justificativas NO SERVIDOR: concorrência, duplicidade, mês assinado, conflitos, par de almoço, permissões. Dados sintéticos.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const J = require('../lib/pontoJustificativa'); const { M } = require('../lib/pontoBanco'); const PM = require('../scripts/ponto_proteger_meses');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('firebase/firestore');
jest.setTimeout(120000);
const root = path.resolve(__dirname, '../..');
const AGORA = new Date('2026-10-12T15:00:00Z'), GES = 'j-ges', GES2 = 'j-ges2', FUNU = 'j-funu', SEMMOD = 'j-semmod', PROPRIO = 'j-proprio';
const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'ponto_meses_protegidos', 'ponto_justificativas_decisoes', 'ponto_justificativas_lock', 'ponto_sabado_correcoes', 'ponto_escalas', 'users', 'sistema_usuarios'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const dec = (uid, d) => J.decidirJustificativaHandler({ auth: uid ? { uid } : null, data: d }, { db, now: () => AGORA });
const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
const hash = async c => crypto.createHash('sha1').update(JSON.stringify((await db.collection(c).orderBy('__name__').get()).docs.map(d => [d.id, d.data()]))).digest('hex');
const DIA = '2026-10-07';
const reg = (id, tipo, hora, data = DIA) => db.collection('registros').doc(id).set({ id, funcId: 'FA', data, tipo, hora: hora + ':00' });
const just = (id, tipo, hora, extra = {}) => db.collection('justificativas').doc(id).set({ id, funcId: 'FA', funcNome: 'FA', data: DIA, motivo: 'Ponto não batido — ' + tipo + ' às ' + hora, tipoPonto: tipo, horarioPonto: hora, status: 'pendente', lancadoPorGestor: false, ...extra });
async function cenarioPar() {      // marcações reais: almoço batido no fim do expediente; par pendente 12:01/13:01
  await reg('r1', 'entrada', '08:14'); await reg('r2', 'saida_almoco', '17:25'); await reg('r3', 'retorno_almoco', '17:26'); await reg('r4', 'saida', '17:31');
  await just('ja', 'saida_almoco', '12:01'); await just('jb', 'retorno_almoco', '13:01');
}
beforeEach(async () => {
  await limpar();
  await db.doc('users/' + GES).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, email: 'g1@x' });
  await db.doc('users/' + GES2).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + GES2).set({ modulos: ['ponto'], admin: false, email: 'g2@x' });
  await db.doc('users/' + FUNU).set({ role: 'funcionario', ativo: true }); await db.doc('sistema_usuarios/' + FUNU).set({ modulos: [], admin: false });
  await db.doc('users/' + SEMMOD).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + SEMMOD).set({ modulos: ['crm'], admin: false });
  await db.doc('users/' + PROPRIO).set({ role: 'gestor', ativo: true, funcionarioId: 'FA' }); await db.doc('sistema_usuarios/' + PROPRIO).set({ modulos: ['ponto'], admin: false });
  await db.doc('funcionarios/FA').set({ nome: 'FA', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' });
});
afterAll(limpar);

describe('par de almoço', () => {
  test('aprovação ISOLADA que gera jornada incoerente é recusada e nada é gravado', async () => {
    await cenarioPar();
    const antes = await Promise.all(['registros', 'justificativas', 'creditos_jornada'].map(hash));
    expect(await erro(dec(GES, { ids: ['ja'], decisao: 'APROVAR' }))).toMatch(/APROVACAO_ISOLADA_INCOERENTE_APROVE_O_PAR/);
    expect(await erro(dec(GES, { ids: ['jb'], decisao: 'APROVAR' }))).toMatch(/APROVACAO_ISOLADA_INCOERENTE_APROVE_O_PAR/);
    expect(await Promise.all(['registros', 'justificativas', 'creditos_jornada'].map(hash))).toEqual(antes);
    expect((await db.collection('ponto_justificativas_decisoes').get()).size).toBe(0);
  });
  test('aprovar o PAR é atômico: ambas corrigidas, originais preservados, trilha completa, dia coerente', async () => {
    await cenarioPar();
    const r = await dec(GES, { ids: ['ja', 'jb'], decisao: 'APROVAR', obs: 'Conferido com o funcionário' });
    expect(r).toMatchObject({ ok: true, status: 'aprovado', conjunto: 2 });
    const rs = (await db.collection('registros').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    expect(rs.find(x => x.id === 'r2')).toMatchObject({ hora: '17:25:00', substituidoPor: 'corr_ja' });            // original intacto + marcado
    expect(rs.find(x => x.id === 'r3')).toMatchObject({ hora: '17:26:00', substituidoPor: 'corr_jb' });
    expect(rs.find(x => x.id === 'corr_ja')).toMatchObject({ hora: '12:01:00', tipo: 'saida_almoco', aprovadoPorUid: GES, valorOriginal: [{ id: 'r2', hora: '17:25:00' }] });
    const js = (await db.collection('justificativas').get()).docs.map(d => d.data());
    expect(js.every(x => x.status === 'aprovado' && x.respondidoPorUid === GES && x.respondidoEm && x.decididaPeloServidor)).toBe(true);
    expect((await db.collection('ponto_justificativas_decisoes').get()).size).toBe(2);
    const f = { id: 'FA', jornada: 8, inicioBancoHoras: '2026-08-03' };
    const dia = M.calcDia(f, DIA, M.registrosEfetivos(rs).filter(x => x.data === DIA), null, []);
    expect(dia).toMatchObject({ status: 'ok', trabalhadoMin: 497 });
  });
  test('reenvio idempotente; outro gestor não decide de novo; CONCORRÊNCIA: 2 gestores aprovam o mesmo par ⇒ 1 efeito', async () => {
    await cenarioPar();
    const rs = await Promise.all([erro(dec(GES, { ids: ['ja', 'jb'], decisao: 'APROVAR' })), erro(dec(GES2, { ids: ['ja', 'jb'], decisao: 'APROVAR' }))]);
    expect(rs.filter(x => x === 'OK')).toHaveLength(1);
    expect(rs.filter(x => /JUSTIFICATIVA_JA_DECIDIDA/.test(x))).toHaveLength(1);
    expect((await db.collection('registros').get()).docs.filter(d => d.id.startsWith('corr_'))).toHaveLength(2);
    const quem = (await db.doc('justificativas/ja').get()).data().respondidoPorUid;
    expect(await dec(quem, { ids: ['ja', 'jb'], decisao: 'APROVAR' })).toMatchObject({ repetido: true });
    expect((await db.collection('ponto_justificativas_decisoes').get()).size).toBe(2);
  });
});

describe('conflitos e legitimidade', () => {
  test('correção aprovada com outro horário ⇒ bloqueia; pendentes divergentes ⇒ bloqueiam até rejeitar uma', async () => {
    await reg('r1', 'entrada', '08:00'); await reg('r2', 'saida_almoco', '12:00'); await reg('r3', 'retorno_almoco', '13:00');
    await just('a', 'saida', '17:02', { status: 'aprovado', respondidoPorUid: 'x' }); await just('b', 'saida', '17:30');
    expect(await erro(dec(GES, { ids: ['b'], decisao: 'APROVAR' }))).toMatch(/CONFLITO_COM_CORRECAO_APROVADA/);
    await db.doc('justificativas/a').update({ status: 'pendente' });
    expect(await erro(dec(GES, { ids: ['b'], decisao: 'APROVAR' }))).toMatch(/CONFLITO_ENTRE_PENDENTES/);
    expect(await dec(GES, { ids: ['a'], decisao: 'REJEITAR', obs: 'Horário não comprovado' })).toMatchObject({ status: 'rejeitado' });
    expect(await dec(GES, { ids: ['b'], decisao: 'APROVAR' })).toMatchObject({ status: 'aprovado' });
  });
  test('situação legítima NÃO é bloqueada: correção parcial (a saída ainda faltará) e ocorrência com crédito', async () => {
    await reg('r2', 'saida_almoco', '12:00'); await reg('r3', 'retorno_almoco', '13:00');
    await just('e', 'entrada', '08:05');
    expect(await dec(GES, { ids: ['e'], decisao: 'APROVAR' })).toMatchObject({ status: 'aprovado' });          // dia segue sem saída, mas coerente
    await db.collection('justificativas').doc('at').set({ id: 'at', funcId: 'FA', funcNome: 'FA', data: '2026-10-06', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false });
    await db.collection('justificativas').doc('ho').set({ id: 'ho', funcId: 'FA', funcNome: 'FA', data: '2026-10-05', motivo: 'Home Office', status: 'pendente', lancadoPorGestor: false });
    await dec(GES, { ids: ['at'], decisao: 'APROVAR' }); await dec(GES, { ids: ['ho'], decisao: 'APROVAR' });
    expect((await db.doc('creditos_jornada/cred_FA_2026-10-06').get()).data()).toMatchObject({ minutos: 480, motivo: 'Atestado médico' });
    expect((await db.doc('creditos_jornada/cred_FA_2026-10-05').get()).exists).toBe(false);
  });
  test('data futura: aprovar recusado; rejeitar permitido', async () => {
    await db.collection('justificativas').doc('f').set({ id: 'f', funcId: 'FA', data: '2026-10-29', motivo: 'Ponto não batido — Saída almoço às 13:01', tipoPonto: 'saida_almoco', horarioPonto: '13:01', status: 'pendente', lancadoPorGestor: false });
    expect(await erro(dec(GES, { ids: ['f'], decisao: 'APROVAR' }))).toMatch(/DATA_FUTURA/);
    expect(await dec(GES, { ids: ['f'], decisao: 'REJEITAR', obs: 'Data inválida (futura)' })).toMatchObject({ status: 'rejeitado' });
  });
});

describe('período protegido (servidor)', () => {
  test('espelho assinado OU marcador ⇒ aprovar recusado no servidor; rejeitar e pedir informação não alteram o cálculo', async () => {
    await cenarioPar();
    await db.doc('espelhos/FA_2026-10').set({ funcId: 'FA', mes: '2026-10', assinado: true });
    expect(await erro(dec(GES, { ids: ['ja', 'jb'], decisao: 'APROVAR' }))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
    await db.doc('espelhos/FA_2026-10').delete();
    await db.doc('ponto_meses_protegidos/FA_2026-10').set({ funcId: 'FA', mes: '2026-10' });         // só o marcador (gatilho adiantado)
    expect(await erro(dec(GES, { ids: ['ja', 'jb'], decisao: 'APROVAR' }))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
    const antesReg = await hash('registros');
    expect(await dec(GES, { ids: ['ja'], decisao: 'SOLICITAR_INFO', obs: 'Informe como comprova o almoço' })).toMatchObject({ ok: true });
    expect((await db.doc('justificativas/ja').get()).data()).toMatchObject({ status: 'pendente', infoSolicitada: 'Informe como comprova o almoço' });
    expect(await dec(GES, { ids: ['jb'], decisao: 'REJEITAR', obs: 'Sem comprovação' })).toMatchObject({ status: 'rejeitado' });
    expect(await hash('registros')).toBe(antesReg);
  });
  test('backfill: marcadores para espelhos assinados, idempotente; não-assinados ficam de fora', async () => {
    const esp = [{ id: 'e1', funcId: 'FA', mes: '2026-05', assinado: true }, { id: 'e2', funcId: 'FA', mes: '2026-06', assinado: false }, { id: 'e3', funcId: 'FB', mes: '2026-05', assinado: true, versao: 2 }];
    expect(await PM.aplicar(db, admin.firestore.FieldValue, esp)).toEqual({ criados: 2, existentes: 0, total: 2 });
    expect(await PM.aplicar(db, admin.firestore.FieldValue, esp)).toEqual({ criados: 0, existentes: 2, total: 2 });
    expect((await db.doc('ponto_meses_protegidos/FA_2026-06').get()).exists).toBe(false);
  });
});

describe('autorização e entrada', () => {
  test('anônimo, funcionário, sem módulo e o PRÓPRIO ponto negados; payload estrito; motivo obrigatório', async () => {
    await cenarioPar();
    expect(await erro(dec(null, { ids: ['ja'], decisao: 'REJEITAR', obs: 'sem prova' }))).toMatch(/unauthenticated/);
    expect(await erro(dec(FUNU, { ids: ['ja'], decisao: 'REJEITAR', obs: 'sem prova' }))).toMatch(/permission-denied/);
    expect(await erro(dec(SEMMOD, { ids: ['ja'], decisao: 'REJEITAR', obs: 'sem prova' }))).toMatch(/permission-denied/);
    expect(await erro(dec(PROPRIO, { ids: ['ja'], decisao: 'APROVAR' }))).toMatch(/permission-denied/);
    expect(await erro(dec(GES, { ids: ['ja'], decisao: 'APAGAR' }))).toMatch(/invalid-argument/);
    expect(await erro(dec(GES, { ids: ['ja'], decisao: 'REJEITAR', obs: 'x' }))).toMatch(/invalid-argument/);
    expect(await erro(dec(GES, { ids: ['ja'], decisao: 'APROVAR', extra: 1 }))).toMatch(/invalid-argument/);
    expect(await erro(dec(GES, { ids: ['ja', 'ja'], decisao: 'APROVAR' }))).toMatch(/invalid-argument/);
    expect(await erro(dec(GES, { ids: ['inexistente'], decisao: 'REJEITAR', obs: 'sem prova' }))).toMatch(/not-found/);
  });
});

describe('regras do banco de dados (período protegido e aprovação de correção só pelo servidor)', () => {
  let env;
  beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto-j44-test', firestore: { rules: fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8') } }); });
  afterAll(async () => { await env.cleanup(); });
  const ctx = uid => env.authenticatedContext(uid, { email: uid + '@x' }).firestore();
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async c => {
      const x = c.firestore();
      await x.doc('users/g').set({ role: 'gestor', ativo: true }); await x.doc('sistema_usuarios/g').set({ modulos: ['ponto'], admin: false, bloqueado: false });
      await x.doc('users/u').set({ role: 'funcionario', ativo: true, funcionarioId: 'F1' });
      await x.doc('ponto_meses_protegidos/F1_2026-05').set({ funcId: 'F1', mes: '2026-05' });
      await x.doc('justificativas/p1').set({ id: 'p1', funcId: 'F1', data: '2026-10-06', motivo: 'Ponto não batido', tipoPonto: 'saida', horarioPonto: '17:00', status: 'pendente', lancadoPorGestor: false });
      await x.doc('justificativas/p2').set({ id: 'p2', funcId: 'F1', data: '2026-10-06', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false });
      await x.doc('justificativas/pm').set({ id: 'pm', funcId: 'F1', data: '2026-05-10', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false });
    });
  });
  test('competência protegida: ninguém cria/edita registros, justificativas e créditos dela', async () => {
    const g = ctx('g'), u = ctx('u');
    await assertFails(g.doc('registros/novo').set({ funcId: 'F1', data: '2026-05-12', tipo: 'saida', hora: '17:00:00' }));
    await assertFails(g.doc('justificativas/nova').set({ id: 'nova', funcId: 'F1', data: '2026-05-12', motivo: 'Atestado médico', status: 'aprovado', lancadoPorGestor: true }));
    await assertFails(u.doc('justificativas/nova2').set({ id: 'nova2', funcId: 'F1', data: '2026-05-12', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false }));
    await assertFails(g.doc('creditos_jornada/c1').set({ funcId: 'F1', data: '2026-05-12', minutos: 480, motivo: 'Atestado médico' }));
    await assertFails(g.doc('justificativas/pm').update({ status: 'rejeitado', respondidoPorUid: 'g', respondidoPorEmail: 'g@x', respondidoEm: serverTimestamp() }));
    // fora da competência protegida continua funcionando
    await assertSucceeds(g.doc('creditos_jornada/c2').set({ funcId: 'F1', data: '2026-10-12', minutos: 480, motivo: 'Atestado médico' }));
    await assertSucceeds(u.doc('justificativas/nova3').set({ id: 'nova3', funcId: 'F1', data: '2026-10-12', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false }));
  });
  test('aprovar CORREÇÃO DE BATIDA direto no cliente é negado; rejeitar e ocorrências seguem como antes', async () => {
    const g = ctx('g');
    await assertFails(g.doc('justificativas/p1').update({ status: 'aprovado', respondidoPorUid: 'g', respondidoPorEmail: 'g@x', respondidoEm: serverTimestamp() }));
    await assertSucceeds(g.doc('justificativas/p1').update({ status: 'rejeitado', obsGestor: 'Sem prova', respondidoPorUid: 'g', respondidoPorEmail: 'g@x', respondidoEm: serverTimestamp() }));
    await assertSucceeds(g.doc('justificativas/p2').update({ status: 'aprovado', respondidoPorUid: 'g', respondidoPorEmail: 'g@x', respondidoEm: serverTimestamp() }));
  });
  test('trilhas e marcadores sem escrita de cliente', async () => {
    for (const p of ['ponto_meses_protegidos/x', 'ponto_justificativas_decisoes/x', 'ponto_justificativas_lock/x']) { await assertFails(ctx('g').doc(p).set({ a: 1 })); await assertFails(ctx('u').doc(p).set({ a: 1 })); }
    await assertSucceeds(ctx('g').doc('ponto_meses_protegidos/F1_2026-05').get());
  });
});

describe('estáticos', () => {
  test('callable e gatilho exportados; UI usa o callable e não escreve direto; motor copiado idêntico', () => {
    const idx = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
    expect(idx).toMatch(/exports\.pontoJustificativaDecidir\s*=\s*onCall\(\{ region: REGION \}/);
    expect(idx).toMatch(/exports\.pontoProtegerMesAssinado\s*=\s*onDocumentWritten\(\{ document: 'espelhos\/\{espelhoId\}'/);
    const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
    const resp = g.slice(g.indexOf('async function _decidirJustif'), g.indexOf('window.responderJustificativa=responderJustificativa;'));
    expect(resp).toMatch(/window\._justDecidir/);
    expect(resp).not.toMatch(/_writeBatch|batch\.|fbSet\(|\.commit\(/);
    expect(fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'modulos/ponto-regras.js'), 'utf8'));
  });
});
