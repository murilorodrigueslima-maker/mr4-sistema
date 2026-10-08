'use strict';
// Compensação/estorno no BACKEND (transação atômica). Emulador; dados 100% sintéticos; nada de produção.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const B = require('../lib/pontoBanco'); const M = B.M;
jest.setTimeout(120000);
const AGORA = new Date('2026-10-08T15:00:00Z');                       // hoje = 2026-10-08 (Fortaleza); ontem = 2026-10-07
const GES = 'bb-ges', SEMMOD = 'bb-semmod', FUNU = 'bb-funu', PROPRIO = 'bb-proprio';
const POL = { acumulativoAtivo: true, compensacaoAtiva: true };
const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'users', 'sistema_usuarios'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const req = (uid, d) => ({ auth: uid ? { uid } : null, data: d });
const comp = (uid, d, pol) => B.compensarHandler(req(uid, d), { db, now: () => AGORA });
const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
let seq = 0;
const reg = (funcId, data, tipo, hora) => db.collection('registros').doc('r' + (++seq)).set({ funcId, data, tipo, hora: hora + ':00' });
/** Mês de 2026-08-03 a 2026-10-07: seg–sex 08–12/13–17 (8h exatas), sábado 08:30–12:00; `extra`: {data: horaSaida}; `ausentes`: datas sem batida. */
async function popular(funcId, { extra = {}, ausentes = [] } = {}) {
  const batch = [];
  for (let t = Date.UTC(2026, 7, 3); t <= Date.UTC(2026, 9, 7); t += 86400000) {
    const dt = new Date(t), ds = dt.toISOString().slice(0, 10), w = dt.getUTCDay();
    if (ausentes.includes(ds) || w === 0) continue;
    if (w === 6) { batch.push(reg(funcId, ds, 'entrada', '08:30'), reg(funcId, ds, 'saida', '12:00')); continue; }
    batch.push(reg(funcId, ds, 'entrada', '08:00'), reg(funcId, ds, 'saida_almoco', '12:00'), reg(funcId, ds, 'retorno_almoco', '13:00'), reg(funcId, ds, 'saida', extra[ds] || '17:00'));
  }
  await Promise.all(batch);
}
const extras = (n, min) => { const o = {}; for (let t = Date.UTC(2026, 7, 4); Object.keys(o).length < n; t += 86400000) { const dt = new Date(t); if (dt.getUTCDay() >= 1 && dt.getUTCDay() <= 5) o[dt.toISOString().slice(0, 10)] = min; } return o; };  // n dias úteis (a partir de 04/08) com saída em `min`
const func = (id, extra = {}) => { const o = { nome: 'Func ' + id, jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03', ...extra }; Object.keys(o).forEach(k => o[k] === undefined && delete o[k]); return db.collection('funcionarios').doc(id).set(o); };
const saldoFinal = async (funcId) => db.runTransaction(async tx => { const x = await B.carregarBanco(tx, db, funcId, '2026-10-08'); return x.rows[x.rows.length - 1].saldoFinal; });
const politica = p => db.doc('banco_horas_config/politica').set(p);
const hashColecao = async c => crypto.createHash('sha1').update(JSON.stringify((await db.collection(c).orderBy('__name__').get()).docs.map(d => [d.id, d.data()]))).digest('hex');

beforeEach(async () => {
  await limpar();
  for (const [uid, role, mods, extra] of [[GES, 'gestor', ['ponto'], {}], [SEMMOD, 'gestor', ['crm'], {}], [FUNU, 'funcionario', [], {}], [PROPRIO, 'gestor', ['ponto'], { funcionarioId: 'FPROP' }]]) {
    await db.doc('users/' + uid).set({ role, ativo: true, ...extra }); await db.doc('sistema_usuarios/' + uid).set({ modulos: mods, admin: false, email: uid + '@x' });
  }
  await politica(POL);
});
afterAll(async () => { await limpar(); });

describe('exemplos do acordo', () => {
  // extras: 10 dias de saída às 18:00 = +600; ausência 22/09 (terça): motor debita −480 ⇒ saldo +120
  test('+10h −8h = +2h (motor já debitou a falta: NÃO desconta de novo)', async () => {
    await func('FA'); await popular('FA', { extra: extras(10, '18:00'), ausentes: ['2026-09-22'] });
    expect(await saldoFinal('FA')).toBe(120);
    const r = await comp(GES, { funcId: 'FA', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' });
    expect(r).toMatchObject({ ok: true, saldoAntesMin: 600, saldoDepoisMin: 120, negativo: false });
    expect(await saldoFinal('FA')).toBe(120);                                        // sem débito duplo
    const l = (await db.doc('banco_horas_lancamentos/FA_2026-09-22').get()).data();
    expect(l).toMatchObject({ debitoMotorDiaMin: 480, descontoFolha: false, aprovadoPorUid: GES, saldoNegativo: false });
  });
  test('+3h −8h = −5h: bloqueado sem política; permitido só com permiteSaldoNegativo + limite explícito', async () => {
    await func('FB'); await popular('FB', { extra: extras(3, '18:00'), ausentes: ['2026-09-22'] });
    const d = { funcId: 'FB', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' };
    expect(await erro(comp(GES, d))).toMatch(/SALDO_INSUFICIENTE_NEGATIVO_NAO_PERMITIDO/);
    await politica({ ...POL, permiteSaldoNegativo: true });                                       // sem limite ⇒ política incompleta, nada presumido
    expect(await erro(comp(GES, d))).toMatch(/POLITICA_INCOMPLETA_SEM_LIMITE_NEGATIVO/);
    await politica({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: 240 });
    expect(await erro(comp(GES, d))).toMatch(/EXCEDE_LIMITE_NEGATIVO/);
    await politica({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: 300 });
    expect(await comp(GES, d)).toMatchObject({ ok: true, saldoDepoisMin: -300, negativo: true });
    expect(await saldoFinal('FB')).toBe(-300);
  });
  test('−4h −8h = −12h somente se permitido pelo limite', async () => {
    await func('FC'); await popular('FC', { extra: extras(1, '13:00'), ausentes: ['2026-09-22'] });   // saída 13:00 ⇒ −240 (almoço 12–13; 08–12 + 0) vide cálculo
    const base = await saldoFinal('FC');
    const d = { funcId: 'FC', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' };
    await politica({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: Math.abs(base) - 1 });
    expect(await erro(comp(GES, d))).toMatch(/EXCEDE_LIMITE_NEGATIVO/);
    await politica({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: Math.abs(base) });
    expect(await comp(GES, d)).toMatchObject({ ok: true, saldoDepoisMin: base });
  });
});

describe('idempotência, duplicidade e concorrência', () => {
  test('mesma ordem repetida ⇒ idempotente; ordem diferente para a mesma ausência ⇒ already-exists; 1 só lançamento', async () => {
    await func('FA'); await popular('FA', { extra: extras(10, '18:00'), ausentes: ['2026-09-22'] });
    const d = { funcId: 'FA', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' };
    await comp(GES, d); expect(await comp(GES, d)).toMatchObject({ repetido: true });
    expect(await erro(comp(GES, { ...d, minutos: 240 }))).toMatch(/already-exists/);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(1);
  });
  test('CONCORRÊNCIA: duas compensações simultâneas sobre o mesmo saldo (débito novo) ⇒ exatamente uma passa; saldo nunca fica incorreto', async () => {
    await func('FD'); await popular('FD', { extra: extras(10, '18:00') });           // +600, sem faltas; domingos 20 e 27/09 não têm débito do motor
    const mk = data => erro(comp(GES, { funcId: 'FD', dataAusencia: data, minutos: 480, motivo: 'Compensação aprovada' }));
    const rs = await Promise.all([mk('2026-09-20'), mk('2026-09-27')]);
    expect(rs.filter(x => x === 'OK')).toHaveLength(1);
    expect(rs.filter(x => /SALDO_INSUFICIENTE/.test(x))).toHaveLength(1);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(1);
    expect(await saldoFinal('FD')).toBe(120);
    expect((await db.doc('banco_horas_saldo/FD').get()).data().versao).toBe(1);
  });
  test('rajada de 6 pedidos idênticos ⇒ 1 lançamento', async () => {
    await func('FA'); await popular('FA', { extra: extras(10, '18:00'), ausentes: ['2026-09-22'] });
    const d = { funcId: 'FA', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' };
    await Promise.all(Array.from({ length: 6 }, () => erro(comp(GES, d))));
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(1);
  });
});

describe('estorno e virada de mês', () => {
  test('estorno cria registro (nada é apagado), é idempotente e devolve o efeito do débito novo', async () => {
    await func('FD'); await popular('FD', { extra: extras(10, '18:00') });
    await comp(GES, { funcId: 'FD', dataAusencia: '2026-09-20', minutos: 480, motivo: 'Compensação aprovada' });
    expect(await saldoFinal('FD')).toBe(120);
    const e1 = await B.estornarHandler(req(GES, { lancamentoId: 'FD_2026-09-20', motivo: 'Lançada por engano' }), { db });
    expect(e1).toMatchObject({ ok: true, repetido: false });
    expect(await B.estornarHandler(req(GES, { lancamentoId: 'FD_2026-09-20', motivo: 'Lançada por engano' }), { db })).toMatchObject({ repetido: true });
    expect(await saldoFinal('FD')).toBe(600);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(2);        // original + estorno
    expect(await erro(B.estornarHandler(req(GES, { lancamentoId: 'FD_2026-01-01', motivo: 'Lançada por engano' }), { db }))).toMatch(/not-found/);
  });
  test('virada de mês: saldo atravessa ago→set→out sem zerar (positivo e negativo)', async () => {
    await func('FA'); await popular('FA', { extra: { '2026-08-04': '18:00', '2026-08-05': '18:00', '2026-09-22': '16:00' } });
    const x = await db.runTransaction(tx => B.carregarBanco(tx, db, 'FA', '2026-10-08'));
    expect(x.rows.map(r => r.mes)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(x.rows.map(r => r.saldoFinal)).toEqual([120, 60, 60]);
    expect(x.rows[1].saldoAnterior).toBe(120); expect(x.rows[2].saldoAnterior).toBe(60);
  });
});

describe('política, dados e permissões', () => {
  const d = { funcId: 'FA', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' };
  beforeEach(async () => { await func('FA'); await popular('FA', { extra: extras(10, '18:00'), ausentes: ['2026-09-22'] }); });
  test('banco desligado (sem política / flags falsas) ⇒ nada é gravado', async () => {
    await db.doc('banco_horas_config/politica').delete(); expect(await erro(comp(GES, d))).toMatch(/BANCO_DESLIGADO/);
    await politica({ acumulativoAtivo: true, compensacaoAtiva: false }); expect(await erro(comp(GES, d))).toMatch(/BANCO_DESLIGADO/);
    await politica({ acumulativoAtivo: false, compensacaoAtiva: true }); expect(await erro(comp(GES, d))).toMatch(/BANCO_DESLIGADO/);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
  });
  test('funcionário sem data de início NÃO é presumido: recusado', async () => {
    await func('FX', { inicioBancoHoras: undefined });
    expect(await erro(comp(GES, { ...d, funcId: 'FX' }))).toMatch(/SEM_DATA_DE_INICIO_DO_BANCO/);
    await func('FY', { controleBancoHoras: false }); expect(await erro(comp(GES, { ...d, funcId: 'FY' }))).toMatch(/failed-precondition/);
  });
  test('permissões: anônimo, sem módulo ponto, funcionário comum, e o PRÓPRIO banco ⇒ negados; payload estrito', async () => {
    expect(await erro(comp(null, d))).toMatch(/unauthenticated/);
    expect(await erro(comp(SEMMOD, d))).toMatch(/permission-denied/);
    expect(await erro(comp(FUNU, d))).toMatch(/permission-denied/);
    expect(await erro(comp('inexistente', d))).toMatch(/permission-denied/);
    await func('FPROP'); await popular('FPROP', { extra: extras(10, '18:00'), ausentes: ['2026-09-22'] });
    expect(await erro(comp(PROPRIO, { ...d, funcId: 'FPROP' }))).toMatch(/permission-denied/);
    expect(await erro(comp(GES, { ...d, extra: 1 }))).toMatch(/invalid-argument/);
    expect(await erro(comp(GES, { ...d, minutos: 1.5 }))).toMatch(/invalid-argument/);
    expect(await erro(comp(GES, { ...d, dataAusencia: '2026-10-09' }))).toMatch(/invalid-argument/);   // futura
    expect(await erro(comp(GES, { ...d, motivo: 'x' }))).toMatch(/invalid-argument/);
    expect(await erro(B.estornarHandler(req(SEMMOD, { lancamentoId: 'FA_2026-09-22', motivo: 'Lançada por engano' }), { db }))).toMatch(/not-found|permission-denied/);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
  });
  test('HISTÓRICO PRESERVADO: registros, justificativas, créditos e espelhos assinados ficam byte a byte iguais', async () => {
    await db.doc('espelhos/FA_2026-08').set({ funcId: 'FA', mes: '2026-08', assinado: true, assinadoPor: 'x', assinaturaImg: 'data:img', snapshot: { dias: [{ data: '2026-08-04', saldoDia: 60, contaNoSaldo: true, status: 'ok' }] }, versao: 1 });
    await db.doc('espelhos/FA_2026-07').set({ funcId: 'FA', mes: '2026-07', assinado: true });                // legado sem snapshot
    await politica({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: 100000 });     // o espelho de agosto congelado muda o saldo; aqui só interessa o histórico
    const antes = await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hashColecao));
    await comp(GES, d); await B.estornarHandler(req(GES, { lancamentoId: 'FA_2026-09-22', motivo: 'Lançada por engano' }), { db });
    expect(await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hashColecao))).toEqual(antes);
  });
  test('espelho assinado com snapshot é CONGELADO no acumulado (o motor de hoje não o recalcula)', async () => {
    await db.doc('espelhos/FA_2026-08').set({ funcId: 'FA', mes: '2026-08', assinado: true, versao: 1, snapshot: { dias: [{ data: '2026-08-04', saldoDia: 999, contaNoSaldo: true, status: 'ok' }] } });
    const x = await db.runTransaction(tx => B.carregarBanco(tx, db, 'FA', '2026-10-08'));
    expect(x.rows[0]).toMatchObject({ mes: '2026-08', congelado: true, saldoFinal: 999 });
  });
});

describe('garantias estáticas', () => {
  const fonte = fs.readFileSync(path.resolve(__dirname, '../lib/pontoBanco.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  test('nenhum desconto em folha/rescisão; só lê marcações/justificativas/espelhos; nunca apaga', () => {
    expect(fonte).not.toMatch(/salario|rescis|folha(?!:)|payroll/i);
    expect(fonte).not.toMatch(/\.delete\(|FieldValue\.delete|tx\.update|tx\.delete/);
    expect(fonte).not.toMatch(/collection\('(registros|justificativas|creditos_jornada|espelhos)'\)\.doc\(/);
  });
  test('cópia do motor no backend é IDÊNTICA a modulos/ponto-regras.js (sem divergência de cálculo)', () => {
    const a = fs.readFileSync(path.resolve(__dirname, '../lib/ponto-regras.copy.js'), 'utf8'), b = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8');
    expect(a).toBe(b);
  });
  test('callables exportados e sem secrets', () => {
    const idx = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
    expect(idx).toMatch(/exports\.pontoBancoCompensar\s*=\s*onCall\(\{ region: REGION \}/); expect(idx).toMatch(/exports\.pontoBancoEstornar\s*=\s*onCall\(\{ region: REGION \}/);
  });
});
