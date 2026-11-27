'use strict';
/**
 * DIAGNÓSTICO TÉCNICO DO PONTO — backend (EMULADOR; dados 100% sintéticos; nada de produção).
 * "CONFIRMADO Dxx" = comportamento atual considerado defeito (inverter ao corrigir). "CONTROLE" = proteção que funciona.
 * Porta padrão 8270. Projeto "demo-*": o SDK nunca alcança um projeto real.
 */

if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Este diagnóstico só roda no emulador local.');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const PROJECT = 'demo-ponto-diag-backend';
const app = admin.initializeApp({ projectId: PROJECT }, 'diag');
const db = app.firestore();
const B = require('../lib/pontoBanco');
const J = require('../lib/pontoJustificativa');
const R = require('../lib/pontoRegularizacao');
const PB = require('../lib/pontoBatida');
jest.setTimeout(120000);

const GES = 'dg-ges';
const req = d => ({ auth: { uid: GES }, data: d });
const erro = p => p.then(() => 'OK', e => (e.details && e.details.codigo) || e.message || String(e));
const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'users', 'sistema_usuarios',
  'ponto_justificativas_decisoes', 'ponto_justificativas_lock', 'ponto_meses_protegidos', 'ponto_escalas', 'ponto_escalas_lock', 'ponto_sabado_correcoes'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
let seq = 0;
const reg = (funcId, data, tipo, hora) => db.collection('registros').doc('dr' + (++seq)).set({ funcId, data, tipo, hora: hora + ':00' });
const diaCheio = (f, d, saida = '17:00', entrada = '08:00') => Promise.all([reg(f, d, 'entrada', entrada), reg(f, d, 'saida_almoco', '12:00'), reg(f, d, 'retorno_almoco', '13:00'), reg(f, d, 'saida', saida)]);

beforeEach(async () => {
  await limpar();
  await db.doc('users/' + GES).set({ role: 'gestor', ativo: true });
  await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, email: 'g@exemplo.test' });
  await db.doc('funcionarios/FX').set({ nome: 'FX', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-10-05' });
});
afterAll(async () => { await limpar(); await app.delete(); });

describe('Banco de horas — idempotência e reservas', () => {
  const AGORA = new Date('2026-10-08T15:00:00Z');
  const o = { db, now: () => AGORA };
  beforeEach(async () => {
    await db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: true });      // saldo negativo NÃO permitido
    await diaCheio('FX', '2026-10-05', '23:00', '06:00');          // +480
    await diaCheio('FX', '2026-10-06'); await diaCheio('FX', '2026-10-07');
  });
  const comp = { funcId: 'FX', dataAusencia: '2026-10-07', minutos: 120, motivo: 'Compensação sintética' };

  test('CONTROLE: repetir a mesma ordem não duplica o lançamento', async () => {
    expect(await B.compensarHandler(req(comp), o)).toMatchObject({ ok: true, repetido: false });
    expect(await B.compensarHandler(req(comp), o)).toMatchObject({ ok: true, repetido: true });
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(1);
  });
  test('CONFIRMADO D16: depois do estorno, refazer a compensação responde "ok/repetido" sem que ela volte a valer', async () => {
    await B.compensarHandler(req(comp), o);
    await B.estornarHandler(req({ lancamentoId: 'FX_2026-10-07', motivo: 'Estorno sintético' }), o);
    expect(await B.compensarHandler(req(comp), o)).toMatchObject({ ok: true, repetido: true });
    const l = (await db.collection('banco_horas_lancamentos').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    expect(B.M.compensacoesVigentes(l)).toHaveLength(0);                                                     // sucesso falso
    expect(await erro(B.compensarHandler(req({ ...comp, minutos: 60 }), o))).toBe('JA_EXISTE_COMPENSACAO_PARA_ESTA_AUSENCIA');   // data fica presa
  });
  test('CONFIRMADO D17: compensação ignora folga futura já aprovada e compromete o mesmo saldo duas vezes', async () => {
    expect(await B.folgaHandler(req({ funcId: 'FX', data: '2026-10-14', periodo: 'DIA_INTEIRO', motivo: 'Folga sintética' }), o)).toMatchObject({ ok: true, saldoDepoisMin: 0 });
    expect(await erro(B.folgaHandler(req({ funcId: 'FX', data: '2026-10-15', periodo: 'DIA_INTEIRO', motivo: 'Folga sintética' }), o))).toMatch(/SALDO_INSUFICIENTE/);   // controle
    expect(await B.compensarHandler(req({ funcId: 'FX', dataAusencia: '2026-10-08', minutos: 480, motivo: 'Compensação sintética' }), o)).toMatchObject({ ok: true });
    for (const d of ['09', '12', '13', '15', '16', '19']) await diaCheio('FX', '2026-10-' + d);
    await reg('FX', '2026-10-10', 'entrada', '08:30'); await reg('FX', '2026-10-10', 'saida', '12:00');
    await reg('FX', '2026-10-17', 'entrada', '08:30'); await reg('FX', '2026-10-17', 'saida', '12:00');
    const saldo = await db.runTransaction(async tx => { const x = await B.carregarBanco(tx, db, 'FX', '2026-10-20'); return x.rows[x.rows.length - 1].saldoFinal; });
    expect(saldo).toBe(-480);                                                                                 // negativo apesar de a política proibir
  });
});

describe('Escalas — idempotência', () => {
  test('CONTROLE: reenviar a mesma escala não cria nova revisão', async () => {
    const dia = { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 };
    const dados = { funcId: 'FX', vigenteDesde: '2026-11-02', motivo: 'Escala sintética', dias: { 1: dia, 2: dia, 3: dia, 4: dia, 5: dia, 6: { trabalha: false } } };
    const o = { db, now: () => new Date('2026-10-08T15:00:00Z') };
    expect(await R.escalaHandler(req(dados), o)).toMatchObject({ repetido: false, rev: 1 });
    expect(await R.escalaHandler(req(dados), o)).toMatchObject({ repetido: true });
    expect((await db.collection('ponto_escalas').get()).size).toBe(1);
  });
});

describe('Decisão de justificativas', () => {
  const o = { db, now: () => new Date('2026-10-20T15:00:00Z') };
  const pedido = { funcId: 'FX', funcNome: 'FX', data: '2026-10-07', motivo: 'Ponto não batido', descricao: '', tipoPonto: 'saida', horarioPonto: '18:00', status: 'pendente', lancadoPorGestor: false };

  test('CORRIGIDO D11 (E2): campo evidenciaGestao em pedido do funcionário não dispensa a evidência', async () => {
    await db.doc('justificativas/j1').set({ ...pedido, id: 'j1', evidenciaGestao: 'x' });
    expect(await erro(J.decidirJustificativaHandler(req({ ids: ['j1'], decisao: 'APROVAR' }), o))).toBe('EVIDENCIA_OBRIGATORIA_JUSTIFICATIVA_ANTIGA');
  });
  test('CORRIGIDO D18 (E2): a trilha da decisão guarda o crédito sobrescrito', async () => {
    await db.doc('creditos_jornada/cred_FX_2026-10-07').set({ funcId: 'FX', data: '2026-10-07', minutos: 240, motivo: 'Feriado municipal', criadoEm: '2026-10-01T00:00:00Z' });
    await db.doc('justificativas/j2').set({ id: 'j2', funcId: 'FX', data: '2026-10-07', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false });
    await J.decidirJustificativaHandler(req({ ids: ['j2'], decisao: 'APROVAR' }), o);
    expect((await db.doc('creditos_jornada/cred_FX_2026-10-07').get()).data()).toMatchObject({ minutos: 480, motivo: 'Atestado médico' });
    const trilha = (await db.collection('ponto_justificativas_decisoes').get()).docs[0].data();
    expect(trilha.creditoAnterior).toMatchObject({ minutos: 240, motivo: 'Feriado municipal' });
  });
});

describe('Batida — idempotência e duplicidade', () => {
  const bater = (extra = {}) => PB.registrarBatidaTx(db, { funcId: 'FX', uid: 'u', func: { nome: 'FX' }, data: '2026-10-20', hora: '08:00:00', modalidade: 'PRESENCIAL', dentroRaio: true,
    lat: null, lng: null, horaCliente: '03:00:00', facialScore: null, foto: null, requestId: null, tipoEsperado: 'entrada', agoraMs: Date.now(), cooldownOverrideMs: 0,
    LABEL_PONTO: { entrada: 'Entrada' }, HttpsError, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(), ...extra });

  test('CONTROLE: 8 envios simultâneos com intenções diferentes geram uma única entrada', async () => {
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => bater({ requestId: 'concorrente-' + i + '-abc' })));
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await db.collection('registros').get()).size).toBe(1);
  });
  test('CONTROLE: a hora gravada é a do servidor; a do aparelho fica só como auditoria', async () => {
    const r = await bater({ requestId: 'hora-servidor-1' });
    expect((await db.doc('registros/' + r.id).get()).data()).toMatchObject({ hora: '08:00:00', horaCliente: '03:00:00' });
  });
  test('D01 (efeito, agora só alcançável com Admin SDK — as Rules da E1 negam ao cliente): marcação sem correção impede registrar de novo', async () => {
    const r = await bater({ requestId: 'antes-de-ocultar' });
    await db.doc('registros/' + r.id).update({ substituidoPor: 'inexistente' });   // o que as Rules permitem ao gestor
    expect(await erro(bater({ requestId: 'depois-de-ocultar' }))).toBe('JA_REGISTRADO');
  });
});
