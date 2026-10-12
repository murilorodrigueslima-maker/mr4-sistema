'use strict';
// Fase 5.1 — banco tecnicamente pronto: extrato, ponto único de lançamento (resolve os 403), cenário operacional completo. Sintético.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const B = require('../lib/pontoBanco'); const M = B.M;
jest.setTimeout(120000);
const root = path.resolve(__dirname, '../..');
const d = (data, saldoMin, status = 'ok') => ({ data, saldoMin, contaNoSaldo: true, status });

describe('extrato = mesmo resultado do acumulado (puro)', () => {
  const meses = [{ mes: '2026-08', dias: [d('2026-08-03', 120), d('2026-08-04', -30), d('2026-08-05', -480, 'falta')] },
    { mes: '2026-09', dias: [d('2026-09-01', 240), { data: '2026-09-02', saldoMin: null, contaNoSaldo: false, status: 'incompleto' }, d('2026-09-03', 0), d('2026-09-08', -480, 'falta')] }];
  const lanc = [
    { id: 'FA_2026-09-08', tipo: 'FOLGA_COMPENSATORIA', data: '2026-09-08', dataAusencia: '2026-09-08', minutos: 480, periodo: 'DIA_INTEIRO' },        // motor já debitou ⇒ reclassifica
    { id: 'FA_2026-09-03', tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-03', minutos: 120 },                                          // motor não debitou ⇒ débito novo −120
    { id: 'FA_2026-12-01', tipo: 'FOLGA_COMPENSATORIA', data: '2026-12-01', dataAusencia: '2026-12-01', minutos: 480, periodo: 'DIA_INTEIRO' }, // futura: reservada
    { id: 'est_FA_2026-09-03', tipo: 'ESTORNO', estornaId: 'FA_2026-09-03', competencia: '2026-09', minutos: 120 },
    { id: 'aj', tipo: 'AJUSTE', competencia: '2026-09', minutos: 15 }];
  test('saldo final do extrato == saldo final do acumulado (com folga, compensação estornada, futura e ajuste)', () => {
    const ac = M.calcBancoAcumulado(meses, lanc), ex = M.extratoBanco(meses, lanc);
    expect(ex.saldoFinal).toBe(ac[ac.length - 1].saldoFinal);
    expect(ex.saldoFinal).toBe(120 - 30 - 480 + 240 + 0 - 480 + 15);               // compensação de 09-03 estornada ⇒ sem efeito; folga de 09-08 só reclassifica
    const ult = ex.linhas[ex.linhas.length - 1]; expect(ult.saldoApos).toBe(ex.saldoFinal);
  });
  test('classificação: extras, faltas e atrasos PROVISÓRIOS, pendência não conta, folga futura reservada, totais e saldo sem faltas/atrasos', () => {
    const ex = M.extratoBanco(meses, lanc);
    expect(ex.totais).toMatchObject({ creditosExtra: 360, faltas: -960, atrasos: -30, ajustes: 15 });
    expect(ex.linhas.filter(x => x.provisorio).map(x => x.tipo).sort()).toEqual(['ATRASO_OU_SAIDA_ANTECIPADA', 'FALTA', 'FALTA', 'PENDENCIA']);
    expect(ex.pendencias).toBe(1); expect(ex.foliasFuturas).toBe(480);
    expect(ex.linhas.find(x => x.tipo === 'FOLGA_FUTURA').minutos).toBe(0);
    expect(ex.saldoSemFaltasEAtrasos).toBe(ex.saldoFinal - ex.totais.faltas - ex.totais.atrasos);
  });
  test('sem lançamentos: apenas o que o motor calculou; vazio ⇒ saldo 0', () => {
    expect(M.extratoBanco([], []).saldoFinal).toBe(0);
    expect(M.extratoBanco(meses, []).saldoFinal).toBe(M.calcBancoAcumulado(meses, [])[1].saldoFinal);
  });
});

describe('ponto único de lançamento (resolve os 403) — emulador', () => {
  const AGORA = new Date('2026-10-08T15:00:00Z');
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'banco_horas_normas', 'ponto_meses_protegidos', 'users', 'sistema_usuarios'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(x => x.ref.delete())); } };
  const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
  const lanc = (uid, data) => B.lancamentoHandler(req(uid, data), { db, now: () => AGORA });
  const folga = (uid, data) => B.folgaHandler(req(uid, data), { db, now: () => AGORA });
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
  const saldo = f => db.runTransaction(async tx => { const x = await B.carregarBanco(tx, db, f, '2026-10-08'); return { final: x.rows[x.rows.length - 1].saldoFinal, rows: x.rows }; });
  beforeEach(async () => {
    await limpar();
    await db.doc('users/g').set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/g').set({ modulos: ['ponto'], admin: false, email: 'g@x' });
    await db.doc('users/u').set({ role: 'funcionario', ativo: true }); await db.doc('sistema_usuarios/u').set({ modulos: [], admin: false });
    await db.doc('funcionarios/FA').set({ nome: 'FA', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' });
    await db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: true, permiteSaldoNegativo: true, limiteNegativoMin: 1200 });
    await popular('FA', { saidas: extras(10, '18:00') });              // +10h de horas extras (crédito) em agosto
  });
  afterAll(limpar);

  test('COMPENSAR e ESTORNAR pelo ponto único: auth obrigatória, autorização, idempotência, estorno com histórico', async () => {
    const D = { funcId: 'FA', dataAusencia: '2026-09-20', minutos: 480, motivo: 'Compensação aprovada pela gestão' };   // domingo: motor não debita ⇒ débito novo
    expect(await erro(lanc(null, { acao: 'COMPENSAR', dados: D }))).toMatch(/unauthenticated/);
    expect(await erro(lanc('u', { acao: 'COMPENSAR', dados: D }))).toMatch(/permission-denied/);
    expect(await erro(lanc('g', { acao: 'APAGAR', dados: D }))).toMatch(/invalid-argument/);
    expect(await erro(lanc('g', { acao: 'COMPENSAR', dados: D, extra: 1 }))).toMatch(/invalid-argument/);
    const antes = (await saldo('FA')).final;
    expect(await lanc('g', { acao: 'COMPENSAR', dados: D })).toMatchObject({ ok: true, repetido: false });
    expect(await lanc('g', { acao: 'COMPENSAR', dados: D })).toMatchObject({ repetido: true });
    expect((await saldo('FA')).final).toBe(antes - 480);
    expect(await lanc('g', { acao: 'ESTORNAR', dados: { lancamentoId: 'FA_2026-09-20', motivo: 'Lançada por engano' } })).toMatchObject({ ok: true, repetido: false });
    expect((await saldo('FA')).final).toBe(antes);                          // estorno devolve o saldo
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(2);   // histórico: original + estorno
  });
  test('cenário operacional: crédito de extras → negativo → acúmulo entre meses → folga integral, parcial e futura → estorno → saldo e extrato coerentes', async () => {
    const base = (await saldo('FA')).final;
    expect(base).toBe(600);                                                  // 10 × 60 min de extras
    await folga('g', { funcId: 'FA', data: '2026-10-14', periodo: 'DIA_INTEIRO', motivo: 'Folga integral futura' });       // futura: reserva
    await folga('g', { funcId: 'FA', data: '2026-10-15', periodo: 'HORAS', minutos: 60, motivo: 'Folga parcial futura' });
    // saldo atual só muda quando as datas chegam (reservas não entram no acumulado)
    expect((await saldo('FA')).final).toBe(base);
    // negativo acima do saldo: 600 − 480 − 60 = 60; mais uma folga integral leva a negativo (permitido até 1200)
    expect(await folga('g', { funcId: 'FA', data: '2026-10-16', periodo: 'DIA_INTEIRO', motivo: 'Folga integral que gera saldo negativo' })).toMatchObject({ ok: true, negativo: true, saldoDepoisMin: 60 - 480 });
    await B.estornarHandler(req('g', { lancamentoId: 'FA_2026-10-16', motivo: 'Cancelada pela gestão' }), { db });
    const lf = (await db.collection('banco_horas_lancamentos').get()).docs.map(x => ({ id: x.id, ...x.data() }));
    const x = await db.runTransaction(tx => B.carregarBanco(tx, db, 'FA', '2026-10-08'));
    const ex = M.extratoBanco(x.meses, lf);
    expect(ex.saldoFinal).toBe(base);
    expect(ex.linhas.filter(l => l.tipo === 'FOLGA_FUTURA').map(l => l.data)).toEqual(['2026-10-14', '2026-10-15']);   // a do dia 16 foi estornada: deixa de valer (histórico mantido no razão)
    expect(ex.linhas.some(l => l.tipo === 'ESTORNO')).toBe(true);
  });
  test('limites e vencimentos da norma (ciclo, janela de compensação, validade) com acordo sintético', () => {
    const NORMA = { id: 'n', origem: { registro: 'CE000233/2026', clausula: '28ª' }, vigencia: { inicio: '2026-01-01', fim: '2027-12-31' }, bancoValidoAte: '2026-12-31', apuracaoDias: 120, compensacaoDias: 30, fatorFolgaPorHoraExtra: 1.5,
      limiteNegativoMesMin: 240, limiteExtraDiarioMin: 120, adicionalHoraExtra: 0.55, exigeAcordoColetivo: true, saldoNegativoFimCiclo: 'ZERAR', rescisaoSaldoNegativo: 'ZERAR_SEM_COBRANCA', rescisaoSaldoPositivo: 'PAGAR_HORA_EXTRA' };
    const ACORDO = { registro: 'ACT-SINTETICO', inicio: '2026-08-03', fim: '2027-08-02', anuenciaPatronal: true };
    const dias = [d('2026-09-01', 180), d('2026-09-02', -250), d('2026-09-03', 130)];
    const r = M.analisarBancoCct(NORMA, { hoje: '2026-11-20', acordo: ACORDO, dias, compensacoes: [], excecoes: [] });
    expect(r.status).toBe('OPERACIONAL');
    expect(r.ciclo).toMatchObject({ inicio: '2026-08-03', fim: '2026-11-30' });
    expect(r.alertas.map(a => a.tipo)).toEqual(expect.arrayContaining(['FIM_DO_CICLO_PROXIMO', 'LIMITE_NEGATIVO_EXCEDIDO', 'EXTRA_DIARIA_ACIMA_DO_LIMITE']));
    expect(M.analisarBancoCct(NORMA, { hoje: '2027-01-05', acordo: ACORDO, dias, compensacoes: [], excecoes: [] }).status).toBe('BANCO_FORA_DA_VALIDADE');
    expect(M.analisarBancoCct(NORMA, { hoje: '2026-11-20', acordo: null, dias, compensacoes: [], excecoes: [] }).status).toBe('SEM_ACORDO_COLETIVO');
  });
  test('espelho assinado: folga/compensação em mês protegido são tratadas pelas regras já testadas; aqui o marcador bloqueia a folga', async () => {
    await db.doc('espelhos/FA_2026-09').set({ funcId: 'FA', mes: '2026-09', assinado: true });
    expect(await erro(folga('g', { funcId: 'FA', data: '2026-09-22', periodo: 'DIA_INTEIRO', motivo: 'Folga em mês assinado' }))).toMatch(/MES_COM_ESPELHO_ASSINADO|DIA_COM_MARCACOES/);
  });
});

describe('estáticos', () => {
  test('UI usa o ponto único; funções antigas continuam exportadas; extrato e banner presentes', () => {
    const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8'), idx = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
    expect(g).toMatch(/httpsCallable\(functions, 'pontoBancoLancamento'\)/);
    expect(g).not.toMatch(/httpsCallable\(functions, 'pontoBancoCompensar'\)/);
    expect(g).toMatch(/Extrato de movimentações/); expect(g).toMatch(/faltas\/atrasos só viram débito definitivo após regra validada/);
    expect(idx).toMatch(/exports\.pontoBancoLancamento\s*=\s*onCall\(\{ region: REGION \}/);
    expect(fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'modulos/ponto-regras.js'), 'utf8'));
  });
});
