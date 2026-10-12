'use strict';
// Fase 4: sábado (turno contínuo, escala individual) e folga compensatória no backend. Emulador; dados sintéticos.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const B = require('../lib/pontoBanco'); const M = B.M;
jest.setTimeout(120000);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8') + ';this.calcDia=calcDia;this.calcTotal=calcTotal;this.SAB=SABADO_V2_DESDE;this.jp=getJornadaPrevista;', ctx);
const R = (data, e, sa, ra, s) => [['entrada', e], ['saida_almoco', sa], ['retorno_almoco', ra], ['saida', s]].filter(x => x[1]).map(([tipo, h]) => ({ data, tipo, hora: h + ':00' }));
const dia = (f, data, marcas) => ctx.calcDia(f, data, R(data, ...marcas), null, []);
const F = { id: 'X', jornada: 8 };
const SAB_ANTES = '2026-10-10', SAB_DEPOIS = '2026-10-17', SAB_DEPOIS2 = '2026-10-24';

describe('sábado — turno contínuo (motor)', () => {
  test('sábado 08:30–12:00 com DUAS marcações: 3h30, saldo 0 (antes e depois)', () => {
    for (const d of [SAB_ANTES, SAB_DEPOIS]) expect(dia(F, d, ['08:30', null, null, '12:00'])).toMatchObject({ status: 'ok', trabalhadoMin: 210, saldoMin: 0 });
  });
  test('4 marcações com intervalo nulo: ANTES do corte continua incompleto (histórico intacto); DEPOIS fecha o dia', () => {
    expect(dia(F, SAB_ANTES, ['08:35', '12:03', '12:03', '12:03']).status).toBe('incompleto');
    expect(dia(F, SAB_DEPOIS, ['08:35', '12:03', '12:03', '12:03'])).toMatchObject({ status: 'ok', trabalhadoMin: 208, saldoMin: -2 });
    expect(dia(F, SAB_DEPOIS, ['08:30', '10:53', '10:53', '12:55'])).toMatchObject({ status: 'ok', trabalhadoMin: 265, saldoMin: 55 });
  });
  test('intervalo real de sábado continua descontado; ordem invertida segue inválida; dia útil não muda', () => {
    expect(dia(F, SAB_DEPOIS, ['08:00', '11:00', '11:30', '13:30'])).toMatchObject({ status: 'ok', trabalhadoMin: 300 });
    expect(dia(F, SAB_DEPOIS, ['08:30', '12:10', '12:05', '12:30']).status).toBe('incompleto');
    expect(dia(F, '2026-10-19', ['08:00', '12:00', '12:00', '17:00']).status).toBe('incompleto');       // segunda: sa == ra continua inválido
  });
  test('atraso, saída antecipada e hora extra no sábado', () => {
    expect(dia(F, SAB_DEPOIS, ['08:50', null, null, '12:00']).saldoMin).toBe(-20);
    expect(dia(F, SAB_DEPOIS, ['08:30', null, null, '11:30']).saldoMin).toBe(-30);
    expect(dia(F, SAB_DEPOIS, ['08:30', null, null, '13:00']).saldoMin).toBe(60);
  });
  test('sábado sem batida segue sendo falta (−3h30), nem por isso é "incompleto"', () => {
    expect(ctx.calcDia(F, SAB_DEPOIS, [], null, [])).toMatchObject({ status: 'falta', saldoMin: -210 });
  });
});

describe('escalas individuais (motor)', () => {
  const A = { id: 'A', jornada: 8 };                                                   // padrão legado: sábado 210
  const Bf = { id: 'B', jornada: 8, escala: { vigenteDesde: '2026-10-01', dias: { 6: 240 } } };   // sábado 4h
  const C = { id: 'C', jornada: 8, escala: { vigenteDesde: '2026-10-01', dias: { 6: 0, 5: 360 } } };  // sem sábado; sexta 6h
  const Dv = { id: 'D', jornada: 6 };                                                  // 6h/dia
  test('jornadas diferentes por funcionário no mesmo sábado', () => {
    expect(ctx.jp(A, SAB_DEPOIS)).toBe(210); expect(ctx.jp(Bf, SAB_DEPOIS)).toBe(240); expect(ctx.jp(C, SAB_DEPOIS)).toBe(0); expect(ctx.jp(Dv, '2026-10-19')).toBe(360);
    expect(dia(Bf, SAB_DEPOIS, ['08:00', null, null, '12:00'])).toMatchObject({ jornadaPrevistaMin: 240, saldoMin: 0 });
    expect(dia(A, SAB_DEPOIS, ['08:00', null, null, '12:00'])).toMatchObject({ jornadaPrevistaMin: 210, saldoMin: 30 });
  });
  test('escala NÃO retroage (vigenteDesde) e nunca vale para domingo', () => {
    expect(ctx.jp(Bf, '2026-09-26')).toBe(210);
    expect(ctx.jp({ id: 'E', jornada: 8, escala: { vigenteDesde: '2026-01-01', dias: { 0: 480 } } }, '2026-10-18')).toBe(0);
  });
  test('sábado de folga na escala: sem batida não é falta; trabalhado vira saldo positivo; sexta de 6h', () => {
    expect(ctx.calcDia(C, SAB_DEPOIS, [], null, [])).toMatchObject({ status: 'sem_jornada', contaNoSaldo: false });
    expect(dia(C, SAB_DEPOIS, ['08:30', null, null, '11:30'])).toMatchObject({ status: 'ok', saldoMin: 180 });
    expect(ctx.jp(C, '2026-10-16')).toBe(360);
  });
});

describe('folga — funções puras', () => {
  test('dia inteiro = jornada do dia (escala); horas ≤ jornada; domingo sem jornada', () => {
    expect(M.minutosDaFolga(F, '2026-10-19', 'DIA_INTEIRO')).toMatchObject({ ok: true, minutos: 480 });
    expect(M.minutosDaFolga(F, SAB_DEPOIS, 'DIA_INTEIRO')).toMatchObject({ ok: true, minutos: 210 });
    expect(M.minutosDaFolga(F, '2026-10-19', 'HORAS', 120)).toMatchObject({ ok: true, minutos: 120 });
    expect(M.minutosDaFolga(F, '2026-10-19', 'HORAS', 600).ok).toBe(false);
    expect(M.minutosDaFolga(F, '2026-10-18', 'DIA_INTEIRO')).toMatchObject({ ok: false, motivo: 'DIA_SEM_JORNADA' });
  });
  test('projeção: dia futuro debita tudo; dia já debitado pelo motor não debita de novo', () => {
    expect(M.projetarFolga(600, 0, 0, 480)).toMatchObject({ debitoNovoMin: 480, saldoDepoisMin: 120 });
    expect(M.projetarFolga(120, 480, 0, 480)).toMatchObject({ debitoNovoMin: 0, saldoDepoisMin: 600 - 480 });
    expect(M.projetarFolga(600, 0, 300, 240)).toMatchObject({ saldoAntesMin: 300, saldoDepoisMin: 60 });
  });
});

describe('folga compensatória — backend (emulador)', () => {
  const AGORA = new Date('2026-10-08T15:00:00Z'), DEPOIS = new Date('2026-10-15T15:00:00Z');
  const GES = 'f-ges', ADM = 'f-adm', FUNU = 'f-funu', POL = { acumulativoAtivo: true, compensacaoAtiva: true };
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'banco_horas_normas', 'users', 'sistema_usuarios'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(x => x.ref.delete())); } };
  const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
  const folga = (uid, dd, now) => B.folgaHandler(req(uid, dd), { db, now: () => now || AGORA });
  const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
  let seq = 0; const reg = (f, data, tipo, hora) => db.collection('registros').doc('r' + (++seq)).set({ funcId: f, data, tipo, hora: hora + ':00' });
  async function popular(f, { ate = '2026-10-07', saidas = {}, ausentes = [] } = {}) {
    const ps = [];
    for (let t = Date.UTC(2026, 7, 3); t <= Date.parse(ate + 'T00:00:00Z'); t += 86400000) {
      const dt = new Date(t), ds = dt.toISOString().slice(0, 10), w = dt.getUTCDay();
      if (ausentes.includes(ds) || w === 0) continue;
      if (w === 6) { ps.push(reg(f, ds, 'entrada', '08:30'), reg(f, ds, 'saida', '12:00')); continue; }
      ps.push(reg(f, ds, 'entrada', '08:00'), reg(f, ds, 'saida_almoco', '12:00'), reg(f, ds, 'retorno_almoco', '13:00'), reg(f, ds, 'saida', saidas[ds] || '17:00'));
    }
    await Promise.all(ps);
  }
  const extras = (n, min) => { const o = {}; for (let t = Date.UTC(2026, 7, 4); Object.keys(o).length < n; t += 86400000) { const dt = new Date(t); if (dt.getUTCDay() >= 1 && dt.getUTCDay() <= 5) o[dt.toISOString().slice(0, 10)] = min; } return o; };
  const func = (id, e = {}) => db.collection('funcionarios').doc(id).set({ nome: 'F ' + id, jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03', ...e });
  const saldo = async (f, hoje) => db.runTransaction(async tx => { const x = await B.carregarBanco(tx, db, f, hoje); return x.rows[x.rows.length - 1].saldoFinal; });
  const D = { funcId: 'FA', data: '2026-10-14', periodo: 'DIA_INTEIRO', motivo: 'Folga aprovada pela gestão' };
  const hashCol = async c => crypto.createHash('sha1').update(JSON.stringify((await db.collection(c).orderBy('__name__').get()).docs.map(d => [d.id, d.data()]))).digest('hex');
  beforeEach(async () => {
    await limpar();
    await db.doc('users/' + GES).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, email: 'g@x' });
    await db.doc('users/' + ADM).set({ role: 'gestor', ativo: true, funcionarioId: 'FADM' }); await db.doc('sistema_usuarios/' + ADM).set({ modulos: [], admin: true });
    await db.doc('users/' + FUNU).set({ role: 'funcionario', ativo: true }); await db.doc('sistema_usuarios/' + FUNU).set({ modulos: [], admin: false });
    await db.doc('banco_horas_config/politica').set(POL);
    await func('FA'); await popular('FA', { saidas: extras(10, '18:00') });          // +10h acumuladas até 07/10
  });
  afterAll(async () => { await limpar(); });

  test('folga de dia inteiro futura: aprovada, saldo projetado, e quando o dia chega NÃO há débito duplo', async () => {
    const r = await folga(GES, D);
    expect(r).toMatchObject({ ok: true, minutos: 480, saldoAntesMin: 600, saldoDepoisMin: 120, negativo: false });
    const l = (await db.doc('banco_horas_lancamentos/FA_2026-10-14').get()).data();
    expect(l).toMatchObject({ tipo: 'FOLGA_COMPENSATORIA', periodo: 'DIA_INTEIRO', minutos: 480, jornadaPrevistaMin: 480, aprovadoPorUid: GES, descontoFolha: false });
    // dia chega: marcações até 13/10, e 14/10 (quarta) sem batida ⇒ motor debita 480; o razão só reclassifica
    await popular('FA', { ate: '2026-10-13', saidas: extras(10, '18:00') });
    // (popular recria registros já existentes; limpamos e repopulamos para precisão)
    await db.collection('registros').get().then(s => Promise.all(s.docs.map(d => d.ref.delete()))); await popular('FA', { ate: '2026-10-15', saidas: extras(10, '18:00'), ausentes: ['2026-10-14'] });
    const comFolga = await saldo('FA', '2026-10-16');
    await db.doc('banco_horas_lancamentos/FA_2026-10-14').delete();
    const semFolga = await saldo('FA', '2026-10-16');
    expect(comFolga).toBe(semFolga);                                                        // exatamente uma vez (o motor já debitou)
    expect(semFolga).toBe(600 - 480);
  });
  test('folga parcial (horas) e dia de sábado pela jornada do sábado', async () => {
    expect(await folga(GES, { ...D, data: '2026-10-15', periodo: 'HORAS', minutos: 120 })).toMatchObject({ ok: true, minutos: 120, saldoDepoisMin: 480 });
    expect(await folga(GES, { ...D, data: '2026-10-17', periodo: 'DIA_INTEIRO' })).toMatchObject({ ok: true, minutos: 210 });
    expect(await erro(folga(GES, { ...D, data: '2026-10-16', periodo: 'HORAS', minutos: 600 }))).toMatch(/MINUTOS_INVALIDOS/);
  });
  test('reserva: folgas futuras consomem o saldo; a que não cabe é recusada (sem negativo)', async () => {
    await folga(GES, { ...D, data: '2026-10-14' });                                        // 480 de 600
    expect(await erro(folga(GES, { ...D, data: '2026-10-15' }))).toMatch(/SALDO_INSUFICIENTE_NEGATIVO_NAO_PERMITIDO/);
    await db.doc('banco_horas_config/politica').set({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: 600 });
    expect(await folga(GES, { ...D, data: '2026-10-15' })).toMatchObject({ ok: true, negativo: true, saldoDepoisMin: 600 - 480 - 480 });
    await db.doc('banco_horas_config/politica').set({ ...POL, permiteSaldoNegativo: true, limiteNegativoMin: 100 });
    expect(await erro(folga(GES, { ...D, data: '2026-10-16' }))).toMatch(/EXCEDE_LIMITE_NEGATIVO/);
  });
  test('CONCORRÊNCIA: duas folgas simultâneas de dias diferentes sobre o mesmo saldo ⇒ uma só passa', async () => {
    const rs = await Promise.all([erro(folga(GES, { ...D, data: '2026-10-14' })), erro(folga(GES, { ...D, data: '2026-10-15' }))]);
    expect(rs.filter(x => x === 'OK')).toHaveLength(1);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(1);
    expect((await db.doc('banco_horas_saldo/FA').get()).data().versao).toBe(1);
  });
  test('duplicidade: mesma data repetida é idempotente; outra ordem para a mesma data é recusada; 6 pedidos ⇒ 1', async () => {
    await folga(GES, D); expect(await folga(GES, D)).toMatchObject({ repetido: true });
    expect(await erro(folga(GES, { ...D, periodo: 'HORAS', minutos: 60 }))).toMatch(/already-exists|JA_EXISTE/);
    await db.doc('banco_horas_lancamentos/FA_2026-10-14').delete();
    await Promise.all(Array.from({ length: 6 }, () => erro(folga(GES, D))));
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(1);
  });
  test('não confunde folga com domingo, feriado, férias, ausência justificada, dia trabalhado ou mês assinado', async () => {
    expect(await erro(folga(GES, { ...D, data: '2026-10-18' }))).toMatch(/DIA_SEM_JORNADA/);
    await db.collection('creditos_jornada').doc('c1').set({ funcId: 'FA', data: '2026-10-19', motivo: 'Feriado nacional', minutos: 480 });
    expect(await erro(folga(GES, { ...D, data: '2026-10-19' }))).toMatch(/DIA_COBERTO_POR_FERIADO_OU_FERIAS/);
    await db.collection('creditos_jornada').doc('c2').set({ funcId: 'FA', data: '2026-10-20', motivo: 'Férias', minutos: 480 });
    expect(await erro(folga(GES, { ...D, data: '2026-10-20' }))).toMatch(/DIA_COBERTO_POR_FERIADO_OU_FERIAS/);
    await db.collection('justificativas').doc('j1').set({ funcId: 'FA', data: '2026-10-21', motivo: 'Atestado médico', status: 'aprovado' });
    expect(await erro(folga(GES, { ...D, data: '2026-10-21' }))).toMatch(/JA_EXISTE_AUSENCIA_JUSTIFICADA/);
    expect(await erro(folga(GES, { ...D, data: '2026-10-06' }))).toMatch(/DIA_COM_MARCACOES/);
    await db.doc('espelhos/FA_2026-10').set({ funcId: 'FA', mes: '2026-10', assinado: true });
    expect(await erro(folga(GES, { ...D, data: '2026-10-22' }))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
  });
  test('estorno da folga: registro mantido, saldo reservado volta, idempotente', async () => {
    await folga(GES, D);
    expect(await B.estornarHandler(req(GES, { lancamentoId: 'FA_2026-10-14', motivo: 'Folga cancelada pela gestão' }), { db })).toMatchObject({ ok: true, repetido: false });
    expect(await B.estornarHandler(req(GES, { lancamentoId: 'FA_2026-10-14', motivo: 'Folga cancelada pela gestão' }), { db })).toMatchObject({ repetido: true });
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(2);
    expect(await folga(GES, { ...D, data: '2026-10-15' })).toMatchObject({ ok: true, saldoAntesMin: 600 });   // reserva liberada
  });
  test('com norma coletiva: sem acordo bloqueia; com acordo respeita 4h/mês negativas', async () => {
    const NORMA = { id: 'n1', ativa: true, origem: { registro: 'CE000233/2026', clausula: '28ª' }, vigencia: { inicio: '2026-01-01', fim: '2027-12-31' }, bancoValidoAte: '2026-12-31', apuracaoDias: 120, compensacaoDias: 30,
      fatorFolgaPorHoraExtra: 1.5, limiteNegativoMesMin: 240, limiteExtraDiarioMin: 120, adicionalHoraExtra: 0.55, exigeAcordoColetivo: true, saldoNegativoFimCiclo: 'ZERAR', rescisaoSaldoNegativo: 'ZERAR_SEM_COBRANCA', rescisaoSaldoPositivo: 'PAGAR_HORA_EXTRA' };
    await db.doc('banco_horas_normas/n1').set(NORMA);
    await db.doc('banco_horas_config/politica').set({ ...POL, permiteSaldoNegativo: true, normaId: 'n1' });
    expect(await erro(folga(GES, D))).toMatch(/SEM_ACORDO_COLETIVO/);
    await db.doc('banco_horas_config/acordo').set({ registro: 'ACT-SINTETICO', inicio: '2026-08-03', fim: '2027-08-02', anuenciaPatronal: true });
    expect(await folga(GES, D)).toMatchObject({ ok: true, negativo: false });
    expect(await erro(folga(GES, { ...D, data: '2026-10-15' }))).toMatch(/LIMITE_NEGATIVO_MENSAL_EXCEDIDO/);   // 600−480−480 = −360 < −240
  });
  test('permissões: anônimo, funcionário comum e o PRÓPRIO banco negados; desligado não grava; nada histórico muda', async () => {
    await func('FADM');
    const antes = await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hashCol));
    expect(await erro(folga(null, D))).toMatch(/unauthenticated/);
    expect(await erro(folga(FUNU, D))).toMatch(/permission-denied/);
    expect(await erro(folga(ADM, { ...D, funcId: 'FADM' }))).toMatch(/permission-denied/);
    await db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: false });
    expect(await erro(folga(GES, D))).toMatch(/BANCO_DESLIGADO/);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
    expect(await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hashCol))).toEqual(antes);
  });
  test('virada de mês: folga em novembro, saldo de outubro atravessa sem zerar', async () => {
    const r = await folga(GES, { ...D, data: '2026-11-03' }, AGORA);
    expect(r.saldoAntesMin).toBe(600);
    const x = await db.runTransaction(tx => B.carregarBanco(tx, db, 'FA', '2026-10-08'));
    expect(x.rows[x.rows.length - 1].saldoFinal).toBe(600);
  });
});

describe('estáticos', () => {
  test('callable exportado; cópia do motor idêntica; sem folha; interface sem escrita direta', () => {
    const root = path.resolve(__dirname, '../..');
    expect(fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8')).toMatch(/exports\.pontoBancoFolga\s*=\s*onCall\(\{ region: REGION \}/);
    expect(fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'modulos/ponto-regras.js'), 'utf8'));
    const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
    const bloco = g.slice(g.indexOf('function _folgaCalc'), g.indexOf('// ── Feriados 2026'));
    expect(bloco).not.toMatch(/_setDoc|_deleteDoc|fbSet\(|fbDel\(/);
    expect(bloco).toMatch(/window\._bhFolga/);
  });
});
