'use strict';
// PONTO — P1: encerramento direto no sábado (entrada → saída, sem batidas fictícias de almoço). EMULADOR (isolado). PROD_WRITES=0.

process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), vm = require('vm');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const PB = require('../lib/pontoBatida');
const { _registrarPontoHandler: bater } = require('../index');
jest.setTimeout(60000);

const ctxM = {}; vm.createContext(ctxM); vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), ctxM);
const M = ctxM;

const FUNC = 'func-p1-sab', UID = 'uid-p1-sab';
const LABEL = { entrada: 'Entrada', saida_almoco: 'Saída almoço', retorno_almoco: 'Retorno almoço', saida: 'Saída' };
let n = 0; const rid = () => 'p1req' + String(++n).padStart(4, '0') + Math.random().toString(36).slice(2, 8);
const SAB = '2026-10-24', SEX = '2026-10-23', SAB_ANTES_DO_CORTE = '2026-10-10';
const tx = (data, hora, extra) => PB.registrarBatidaTx(db, { funcId: FUNC, uid: UID, func: { nome: 'Func P1' }, data, hora, modalidade: 'PRESENCIAL', dentroRaio: true, lat: null, lng: null, horaCliente: null,
  facialScore: null, foto: null, requestId: rid(), tipoEsperado: null, agoraMs: Date.now(), cooldownOverrideMs: 0, LABEL_PONTO: LABEL, HttpsError, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(), ...extra });
const res = p => p.then(r => ({ ok: true, ...r }), e => ({ ok: false, code: e.code, codigo: e.details && e.details.codigo, msg: e.message }));
async function limpar() { const s = await db.collection('registros').where('funcId', '==', FUNC).get(); const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
const regs = async data => (await db.collection('registros').where('funcId', '==', FUNC).where('data', '==', data).get()).docs.map(d => d.data()).sort((a, b) => (a.hora < b.hora ? -1 : 1));
beforeAll(async () => {
  await db.doc('users/' + UID).set({ role: 'funcionario', ativo: true, funcionarioId: FUNC, nome: 'Func P1' });
  await db.doc('funcionarios/' + FUNC).set({ nome: 'Func P1', cargo: 'Teste', modalidade: 'PRESENCIAL', jornada: '8' });
});
beforeEach(limpar);
afterAll(async () => { await limpar(); await db.doc('users/' + UID).delete(); await db.doc('funcionarios/' + FUNC).delete(); });
const direto = (data, hora, extra = {}) => tx(data, hora, { tipoEsperado: 'saida', encerramentoDireto: true, ...extra });

describe('P1 · sábado: entrada → encerrar expediente', () => {
  test('feliz: grava SAÍDA direta com trilha (encerramentoDireto + motivo); dia completo; motor fecha o dia sem pendência', async () => {
    await tx(SAB, '08:40:15', { tipoEsperado: 'entrada' });
    const r = await direto(SAB, '12:30:00');
    expect(r).toMatchObject({ status: 'REGISTRADO', tipo: 'saida', data: SAB });
    const rs = await regs(SAB);
    expect(rs.map(x => x.tipo)).toEqual(['entrada', 'saida']);
    expect(rs[1]).toMatchObject({ encerramentoDireto: true, encerramentoMotivo: 'SABADO_SEM_ALMOCO', tipoEsperado: 'saida', id: FUNC + '_' + SAB + '_saida' });
    expect(rs[0].encerramentoDireto).toBeUndefined();
    expect(rs.some(x => x.tipo === 'saida_almoco' || x.tipo === 'retorno_almoco')).toBe(false);          // nenhuma batida fictícia
    const dia = M.calcDia({ jornada: '8', id: FUNC }, SAB, rs, null, []);
    expect(dia).toMatchObject({ status: 'ok', pendente: false, trabalhadoMin: 230, jornadaPrevistaMin: 210, saldoMin: 20 });
    expect((await res(tx(SAB, '12:31:00', { tipoEsperado: 'saida' }))).codigo).toBe('DIA_COMPLETO');
  });
  test('o motor aceita entrada+saída no sábado ANTES e DEPOIS do corte SABADO_V2 (jornada e saldo preservados)', () => {
    for (const d of [SAB_ANTES_DO_CORTE, SAB]) {
      const r = M.calcDia({ jornada: '8', id: FUNC }, d, [{ funcId: FUNC, data: d, tipo: 'entrada', hora: '08:30:00' }, { funcId: FUNC, data: d, tipo: 'saida', hora: '12:00:00' }], null, []);
      expect([d, r.status, r.trabalhadoMin, r.saldoMin]).toEqual([d, 'ok', 210, 0]);
    }
  });
  test('idempotência: mesmo requestId 2× → JA_PROCESSADO e UMA saída', async () => {
    await tx(SAB, '08:40:00', { tipoEsperado: 'entrada' });
    const id = rid(); const a = await direto(SAB, '12:30:00', { requestId: id }); const b = await direto(SAB, '12:30:05', { requestId: id });
    expect([a.status, b.status]).toEqual(['REGISTRADO', 'JA_PROCESSADO']);
    expect((await regs(SAB)).filter(x => x.tipo === 'saida')).toHaveLength(1);
  });
  test('limite de 6h: 06:00:00 de permanência é aceito; acima disso o almoço volta a ser obrigatório (nada gravado)', async () => {
    await tx(SAB, '07:00:00', { tipoEsperado: 'entrada' });
    const acima = await res(direto(SAB, '13:00:01')); expect(acima).toMatchObject({ ok: false, codigo: 'ENCERRAMENTO_DIRETO_EXIGE_ALMOCO' });
    expect((await regs(SAB)).map(x => x.tipo)).toEqual(['entrada']);
    expect(await direto(SAB, '13:00:00')).toMatchObject({ status: 'REGISTRADO', tipo: 'saida' });
  });
});

describe('P1 · recusas (decisão do servidor)', () => {
  test.each([
    ['dia útil (sexta)', SEX, 'ENCERRAMENTO_DIRETO_SO_NO_SABADO'],
    ['domingo', '2026-10-25', 'ENCERRAMENTO_DIRETO_SO_NO_SABADO'],
  ])('%s ⇒ recusado e a saída NÃO é gravada', async (_n, data, codigo) => {
    await tx(data, '08:00:00', { tipoEsperado: 'entrada' });
    const r = await res(direto(data, '12:00:00')); expect(r).toMatchObject({ ok: false, codigo });
    expect((await regs(data)).map(x => x.tipo)).toEqual(['entrada']);
  });
  test('sem entrada, ou depois da saída de almoço, ⇒ recusado (só vale logo após a entrada)', async () => {
    expect(await res(direto(SAB, '12:00:00'))).toMatchObject({ ok: false, codigo: 'ENCERRAMENTO_DIRETO_APENAS_APOS_ENTRADA' });
    await tx(SAB, '08:40:00', { tipoEsperado: 'entrada' }); await tx(SAB, '11:00:00', { tipoEsperado: 'saida_almoco' });
    expect(await res(direto(SAB, '12:00:00'))).toMatchObject({ ok: false, codigo: 'ENCERRAMENTO_DIRETO_APENAS_APOS_ENTRADA' });
  });
  test('sem a intenção explícita, a sequência continua obrigatória: "saida" após a entrada é TIPO_ESPERADO_DIVERGENTE', async () => {
    await tx(SAB, '08:40:00', { tipoEsperado: 'entrada' });
    expect(await res(tx(SAB, '12:00:00', { tipoEsperado: 'saida' }))).toMatchObject({ ok: false, codigo: 'TIPO_ESPERADO_DIVERGENTE' });
    expect((await regs(SAB)).map(x => x.tipo)).toEqual(['entrada']);
  });
  test('payload: encerramentoDireto exige tipoEsperado "saida" e valor booleano', () => {
    expect(() => PB.lerIntencao({ requestId: 'abcdefgh12', tipoEsperado: 'saida_almoco', encerramentoDireto: true })).toThrow(/EXIGE_TIPO_SAIDA/);
    expect(() => PB.lerIntencao({ requestId: 'abcdefgh12', tipoEsperado: 'saida', encerramentoDireto: 'sim' })).toThrow(/ENCERRAMENTO_DIRETO_INVALIDO/);
    expect(PB.lerIntencao({ requestId: 'abcdefgh12', tipoEsperado: 'saida' }).encerramentoDireto).toBe(false);
    expect(PB.lerIntencao({}).encerramentoDireto).toBe(false);                                           // cliente legado: nada muda
  });
  test('defesa em profundidade: encerramentoDireto com tipoEsperado ≠ saída ⇒ recusado no servidor', async () => {
    await tx(SAB, '08:40:00', { tipoEsperado: 'entrada' });
    expect(await res(tx(SAB, '12:00:00', { tipoEsperado: 'saida_almoco', encerramentoDireto: true }))).toMatchObject({ ok: false, codigo: 'ENCERRAMENTO_DIRETO_EXIGE_TIPO_SAIDA' });
  });
  test('integração pelo handler real: hoje não é sábado ⇒ ENCERRAMENTO_DIRETO_SO_NO_SABADO (ou aceito se rodar num sábado)', async () => {
    const hojeDow = new Date().getDay();   // fuso do host ≈ Fortaleza; só valida o caminho handler → lib
    const GPS = { lat: -3.7603154, lng: -38.5634329 };
    process.env.PONTO_COOLDOWN_MS = '0';
    const mk = d => ({ auth: { uid: UID, token: {} }, data: { ...GPS, requestId: rid(), ...d } });
    await bater(mk({ tipoEsperado: 'entrada' }));
    const r = await res(bater(mk({ tipoEsperado: 'saida', encerramentoDireto: true })));
    if (hojeDow === 6) expect(r.ok).toBe(true); else expect(r.codigo).toBe('ENCERRAMENTO_DIRETO_SO_NO_SABADO');
  });
});

describe('P1 · compatibilidade: fluxo normal e registros antigos intactos', () => {
  test('sábado com as 4 batidas (fluxo antigo) continua funcionando e calculando igual', async () => {
    for (const [t, h] of [['entrada', '08:30:00'], ['saida_almoco', '10:00:00'], ['retorno_almoco', '10:20:00'], ['saida', '12:10:00']]) await tx(SAB, h, { tipoEsperado: t });
    const rs = await regs(SAB); expect(rs.map(x => x.tipo)).toEqual(['entrada', 'saida_almoco', 'retorno_almoco', 'saida']);
    expect(rs.every(x => x.encerramentoDireto === undefined)).toBe(true);
    expect(M.calcDia({ jornada: '8', id: FUNC }, SAB, rs, null, [])).toMatchObject({ status: 'ok', trabalhadoMin: 200, saldoMin: -10 });
  });
  test('dia útil: sequência intacta; sem encerramentoDireto nada muda no registro gravado', async () => {
    await tx(SEX, '08:00:00', { tipoEsperado: 'entrada' });
    const r = await tx(SEX, '12:00:00', { tipoEsperado: 'saida_almoco' }); expect(r.tipo).toBe('saida_almoco');
    const rs = await regs(SEX); expect(rs.every(x => !('encerramentoDireto' in x))).toBe(true);
  });
  test('registros antigos (sábados fictícios sa=ra) seguem sendo calculados como antes', () => {
    const ant = d => ['entrada:08:36:46', 'saida_almoco:11:01:00', 'retorno_almoco:11:01:00', 'saida:12:10:00'].map(s => { const [t, ...h] = s.split(':'); return { funcId: FUNC, data: d, tipo: t, hora: h.join(':') }; });
    expect(M.calcDia({ jornada: '8', id: FUNC }, '2026-10-03', ant('2026-10-03'), null, []).status).toBe('incompleto');   // antes do corte: igual ao de hoje (não recalcula)
    expect(M.calcDia({ jornada: '8', id: FUNC }, '2026-10-24', ant('2026-10-24'), null, []).status).toBe('ok');
  });
});
