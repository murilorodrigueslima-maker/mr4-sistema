'use strict';
// PONTO — P6 no SERVIDOR: aprovar correção de batida ANTIGA exige evidência (da justificativa ou registrada pelo gestor). EMULADOR. PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const J = require('../lib/pontoJustificativa');
jest.setTimeout(60000);
const AGORA = new Date('2026-10-12T15:00:00Z'), GES = 'p6-ges';
const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'ponto_meses_protegidos', 'ponto_justificativas_decisoes', 'ponto_justificativas_lock', 'users', 'sistema_usuarios'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const dec = d => J.decidirJustificativaHandler({ auth: { uid: GES }, data: d }, { db, now: () => AGORA });
const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
const reg = (id, data, tipo, hora) => db.collection('registros').doc(id).set({ id, funcId: 'FA', data, tipo, hora: hora + ':00' });
const just = (id, data, tipo, hora, extra = {}) => db.collection('justificativas').doc(id).set({ id, funcId: 'FA', funcNome: 'FA', data, motivo: 'Ponto não batido — ' + tipo + ' às ' + hora, tipoPonto: tipo, horarioPonto: hora, status: 'pendente', lancadoPorGestor: false, ...extra });
beforeEach(async () => {
  await limpar();
  await db.doc('users/' + GES).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, email: 'g@x' });
  await db.doc('funcionarios/FA').set({ nome: 'FA', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' });
});
afterAll(limpar);
const VELHO = '2026-10-01', RECENTE = '2026-10-10';      // hoje (servidor) = 2026-10-12: 11 dias × 2 dias

describe('P6 · servidor', () => {
  test('antiga SEM evidência ⇒ recusada, nada gravado; erro específico', async () => {
    await reg('r1', VELHO, 'entrada', '08:00'); await reg('r2', VELHO, 'saida', '17:00'); await reg('r3', VELHO, 'saida_almoco', '17:01');
    await just('ja', VELHO, 'saida_almoco', '12:00');
    expect(await erro(dec({ ids: ['ja'], decisao: 'APROVAR' }))).toMatch(/failed-precondition:EVIDENCIA_OBRIGATORIA_JUSTIFICATIVA_ANTIGA/);
    expect(await erro(dec({ ids: ['ja'], decisao: 'APROVAR', obs: 'ok' }))).toMatch(/EVIDENCIA_OBRIGATORIA/);                 // observação curta não vale
    expect((await db.collection('ponto_justificativas_decisoes').get()).size).toBe(0);
    expect((await db.doc('justificativas/ja').get()).data().status).toBe('pendente');
    expect((await db.doc('registros/r3').get()).data().substituidoPor).toBeUndefined();
  });
  test('antiga + observação do gestor ≥ 15 caracteres (evidência verificada) ⇒ aprovada (correção legítima continua possível); trilha com a observação', async () => {
    await reg('r1', VELHO, 'entrada', '08:00'); await reg('r2', VELHO, 'saida', '17:00');
    await just('js', VELHO, 'saida_almoco', '12:00'); await just('jr', VELHO, 'retorno_almoco', '13:00');
    const r = await dec({ ids: ['js', 'jr'], decisao: 'APROVAR', obs: 'Conferi com o gerente e as câmeras do dia' });
    expect(r).toMatchObject({ ok: true, status: 'aprovado' });
    const tr = (await db.collection('ponto_justificativas_decisoes').get()).docs.map(d => d.data());
    expect(tr.length).toBe(2); expect(tr.every(t => t.obs === 'Conferi com o gerente e as câmeras do dia' && t.decisao === 'APROVAR')).toBe(true);
  });
  test('antiga com descrição do funcionário (≥ 15), com anexo ou com evidência da gestão ⇒ aprovada sem observação extra', async () => {
    for (const [i, extra] of [['d', { descricao: 'Esqueci de bater; saí para o almoço às 12:00' }], ['a', { anexo: 'data:image/png;base64,AAAA', anexoTipo: 'image/png' }], ['g', { evidenciaGestao: 'imagem da câmera 3', lancadoPorGestor: true }]].entries()) {
      const dia = '2026-10-0' + (i + 2); await reg('e' + i, dia, 'entrada', '08:00'); await reg('s' + i, dia, 'saida', '17:00'); await reg('x' + i, dia, 'saida_almoco', '17:01'); await reg('y' + i, dia, 'retorno_almoco', '17:02');
      await just('js' + i, dia, 'saida_almoco', '12:00', extra[1] ? extra[1] : extra); await just('jr' + i, dia, 'retorno_almoco', '13:00', extra[1] ? extra[1] : extra);
    }
    for (const i of [0, 1, 2]) expect(await erro(dec({ ids: ['js' + i, 'jr' + i], decisao: 'APROVAR' }))).toBe('OK');
  });
  test('RECENTE (≤ 3 dias) sem evidência continua aprovável (regra só vale para justificativa antiga)', async () => {
    await reg('r1', RECENTE, 'entrada', '08:00'); await reg('r2', RECENTE, 'saida', '17:00');
    await just('a', RECENTE, 'saida_almoco', '12:00'); await just('b', RECENTE, 'retorno_almoco', '13:00');
    expect(await erro(dec({ ids: ['a', 'b'], decisao: 'APROVAR' }))).toBe('OK');
  });
  test('ocorrência antiga (atestado) e REJEITAR/SOLICITAR_INFO nunca exigem evidência', async () => {
    await db.collection('justificativas').doc('at').set({ id: 'at', funcId: 'FA', funcNome: 'FA', data: VELHO, motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false });
    expect(await erro(dec({ ids: ['at'], decisao: 'APROVAR' }))).toBe('OK');
    await reg('r1', '2026-10-02', 'entrada', '08:00'); await just('ra', '2026-10-02', 'saida', '17:00'); await just('rb', '2026-10-02', 'saida_almoco', '12:00');
    expect(await erro(dec({ ids: ['ra'], decisao: 'REJEITAR', obs: 'sem lastro' }))).toBe('OK');
    expect(await erro(dec({ ids: ['rb'], decisao: 'SOLICITAR_INFO', obs: 'envie o comprovante' }))).toBe('OK');
  });
  test('par: se UMA das duas for antiga sem evidência, o par é recusado (nada gravado)', async () => {
    await reg('r1', VELHO, 'entrada', '08:00'); await reg('r2', VELHO, 'saida', '17:00');
    await just('js', VELHO, 'saida_almoco', '12:00', { descricao: 'Almoço às 12:00 conforme conversado' }); await just('jr', VELHO, 'retorno_almoco', '13:00');
    expect(await erro(dec({ ids: ['js', 'jr'], decisao: 'APROVAR' }))).toMatch(/EVIDENCIA_OBRIGATORIA/);
    expect((await db.collection('ponto_justificativas_decisoes').get()).size).toBe(0);
  });
});
