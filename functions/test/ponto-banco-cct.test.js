'use strict';
// CCT CE000233/2026 — banco de horas por norma versionada. Lógica pura + backend (emulador). Dados sintéticos; nada de produção.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const B = require('../lib/pontoBanco'); const M = B.M;
jest.setTimeout(120000);

// Norma conforme a verificação documental (cl. 28ª). Fixture de TESTE: em produção vem de banco_horas_normas.
const NORMA = { id: 'cct-ce000233-2026-v1', versao: 1, ativa: true, origem: { registro: 'CE000233/2026', aditivos: ['CE001390/2026'], clausula: '28ª' },
  vigencia: { inicio: '2026-01-01', fim: '2027-12-31' }, bancoValidoAte: '2026-12-31', apuracaoDias: 120, compensacaoDias: 30, fatorFolgaPorHoraExtra: 1.5,
  limiteNegativoMesMin: 240, limiteExtraDiarioMin: 120, adicionalHoraExtra: 0.55, exigeAcordoColetivo: true,
  saldoNegativoFimCiclo: 'ZERAR', rescisaoSaldoNegativo: 'ZERAR_SEM_COBRANCA', rescisaoSaldoPositivo: 'PAGAR_HORA_EXTRA' };
const ACORDO = { registro: 'ACT-TESTE-SINTETICO', inicio: '2026-08-03', fim: '2027-08-02', anuenciaPatronal: true };
const d = (data, saldoMin, status) => ({ data, saldoMin, contaNoSaldo: true, status: status || 'ok' });

describe('norma e ciclos (puro)', () => {
  test('norma completa é válida; qualquer campo ausente invalida e nomeia o campo', () => {
    expect(M.normaCctValida(NORMA)).toEqual({ ok: true, faltando: [] });
    const n = { ...NORMA }; delete n.fatorFolgaPorHoraExtra; delete n.apuracaoDias;
    expect(M.normaCctValida(n).faltando).toEqual(expect.arrayContaining(['fatorFolgaPorHoraExtra', 'apuracaoDias']));
    expect(M.normaCctValida({ ...NORMA, saldoNegativoFimCiclo: 'COBRAR' }).ok).toBe(false);          // nunca aceita cobrança do trabalhador
  });
  test('ciclos de 120 dias + janela de 30 dias, a partir do INÍCIO DO ACORDO (sem início ⇒ nenhum ciclo)', () => {
    const c = M.ciclosCct('2026-08-03', 120, 30, '2027-01-10');
    expect(c[0]).toMatchObject({ inicio: '2026-08-03', fim: '2026-11-30', compensarAte: '2026-12-30' });
    expect(c[1].inicio).toBe('2026-12-01');
    expect(M.ciclosCct(undefined, 120, 30, '2027-01-10')).toEqual([]);
  });
});

describe('análise da gestão (puro)', () => {
  const base = { hoje: '2026-10-11', acordo: ACORDO, dias: [], compensacoes: [], excecoes: [] };
  test('sem acordo coletivo ⇒ SEM_ACORDO_COLETIVO (banco sem validade), nunca presume ciclo', () => {
    const r = M.analisarBancoCct(NORMA, { ...base, acordo: null });
    expect(r.status).toBe('SEM_ACORDO_COLETIVO'); expect(r.ciclo).toBeNull();
  });
  test('acordo sem anuência patronal / fora da vigência / norma fora da vigência bloqueiam', () => {
    expect(M.analisarBancoCct(NORMA, { ...base, acordo: { ...ACORDO, anuenciaPatronal: false } }).status).toBe('ACORDO_SEM_ANUENCIA_PATRONAL');
    expect(M.analisarBancoCct(NORMA, { ...base, acordo: { ...ACORDO, inicio: '2026-10-20' } }).status).toBe('ACORDO_FORA_DA_VIGENCIA');
    expect(M.analisarBancoCct(NORMA, { ...base, hoje: '2028-01-05' }).status).toBe('NORMA_FORA_DA_VIGENCIA');
  });
  test('1h extra = 1h30 de folga; folga pendente considera horas negativas e compensações', () => {
    const r = M.analisarBancoCct(NORMA, { ...base, dias: [d('2026-09-01', 120), d('2026-09-02', 60), d('2026-09-10', -90)], compensacoes: [{ dataAusencia: '2026-09-11', minutos: 30 }] });
    expect(r.status).toBe('OPERACIONAL');
    expect(r.resumo).toMatchObject({ positivasMin: 180, negativasMin: 90, compensacoesMin: 30, folgaDevidaMin: 270, folgaPendenteMin: 150 });
  });
  test('limite negativo 4h/mês: excedido ⇒ alerta; com exceção da diretoria ⇒ sem alerta', () => {
    const dias = [d('2026-09-03', -200), d('2026-09-04', -100)];
    expect(M.analisarBancoCct(NORMA, { ...base, dias }).alertas.map(a => a.tipo)).toContain('LIMITE_NEGATIVO_EXCEDIDO');
    expect(M.analisarBancoCct(NORMA, { ...base, dias, excecoes: [{ data: '2026-09-04', minutos: 120 }] }).alertas.map(a => a.tipo)).not.toContain('LIMITE_NEGATIVO_EXCEDIDO');
  });
  test('limite de 2h extras por dia ⇒ alerta com as datas', () => {
    const r = M.analisarBancoCct(NORMA, { ...base, dias: [d('2026-09-01', 121), d('2026-09-02', 120)] });
    expect(r.alertas.find(a => a.tipo === 'EXTRA_DIARIA_ACIMA_DO_LIMITE').datas).toEqual(['2026-09-01']);
  });
  test('virada de ciclo: janela de compensação, vencimento e pagamento SÓ informativo (não gera pagamento)', () => {
    const dias = [d('2026-09-01', 120)];
    expect(M.analisarBancoCct(NORMA, { ...base, hoje: '2026-12-10', dias }).alertas.map(a => a.tipo)).toContain('JANELA_DE_COMPENSACAO');
    const v = M.analisarBancoCct(NORMA, { ...base, hoje: '2026-12-30', dias: [d('2026-09-01', 120)] });
    const ciclo1 = v.ciclo;
    expect(ciclo1.n).toBe(1);
    const apos = M.analisarBancoCct({ ...NORMA, bancoValidoAte: null }, { ...base, hoje: '2026-12-31', dias });
    expect(apos.ciclo.n).toBe(2);                                                          // novo ciclo; o anterior vira histórico
    const venc = M.analisarBancoCct({ ...NORMA, bancoValidoAte: null }, { ...base, hoje: '2026-12-31', dias: [d('2026-12-05', 60)] });
    expect(venc.exigePagamento.every(p => p.geraPagamentoAutomatico === false)).toBe(true);
  });
  test('após a validade do banco (31/12/2026) o status bloqueia', () => {
    expect(M.analisarBancoCct(NORMA, { ...base, hoje: '2027-01-05', acordo: { ...ACORDO, fim: '2027-08-02' } }).status).toBe('BANCO_FORA_DA_VALIDADE');
  });
  test('faltas no ciclo vão para "exige análise" (norma não define)', () => {
    const r = M.analisarBancoCct(NORMA, { ...base, dias: [d('2026-09-01', -480, 'falta')] });
    expect(r.exigeAnalise.join(' ')).toMatch(/falta/i);
  });
});

describe('backend com norma (emulador)', () => {
  const AGORA = new Date('2026-10-08T15:00:00Z'), GES = 'c-ges', ADM = 'c-adm', FUNU = 'c-funu';
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'banco_horas_normas', 'users', 'sistema_usuarios'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(x => x.ref.delete())); } };
  const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
  const comp = (uid, dd) => B.compensarHandler(req(uid, dd), { db, now: () => AGORA });
  const exc = (uid, dd) => B.excecaoHandler(req(uid, dd), { db, now: () => AGORA });
  const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
  let seq = 0; const reg = (f, data, tipo, hora) => db.collection('registros').doc('r' + (++seq)).set({ funcId: f, data, tipo, hora: hora + ':00' });
  async function popular(f, { saidas = {}, ausentes = [] } = {}) {
    const ps = [];
    for (let t = Date.UTC(2026, 7, 3); t <= Date.UTC(2026, 9, 7); t += 86400000) {
      const dt = new Date(t), ds = dt.toISOString().slice(0, 10), w = dt.getUTCDay();
      if (ausentes.includes(ds) || w === 0) continue;
      if (w === 6) { ps.push(reg(f, ds, 'entrada', '08:30'), reg(f, ds, 'saida', '12:00')); continue; }
      ps.push(reg(f, ds, 'entrada', '08:00'), reg(f, ds, 'saida_almoco', '12:00'), reg(f, ds, 'retorno_almoco', '13:00'), reg(f, ds, 'saida', saidas[ds] || '17:00'));
    }
    await Promise.all(ps);
  }
  const func = (id) => db.collection('funcionarios').doc(id).set({ nome: 'F ' + id, jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' });
  const pol = (extra = {}) => db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: true, permiteSaldoNegativo: true, normaId: NORMA.id, baseJuridica: 'CCT CE000233/2026 cl. 28ª + ACT sintético', ...extra });
  const D = { funcId: 'FA', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Compensação aprovada' };
  beforeEach(async () => {
    await limpar();
    await db.doc('users/' + GES).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, email: 'g@x' });
    await db.doc('users/' + ADM).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + ADM).set({ modulos: [], admin: true, email: 'a@x' });
    await db.doc('users/' + FUNU).set({ role: 'funcionario', ativo: true }); await db.doc('sistema_usuarios/' + FUNU).set({ modulos: [], admin: false });
    await db.doc('banco_horas_normas/' + NORMA.id).set(NORMA); await db.doc('banco_horas_config/acordo').set(ACORDO); await pol();
    await func('FA');
  });
  afterAll(async () => { await limpar(); });

  test('sem acordo coletivo cadastrado ⇒ compensação BLOQUEADA (SEM_ACORDO_COLETIVO)', async () => {
    await popular('FA', { ausentes: ['2026-09-22'] });
    await db.doc('banco_horas_config/acordo').delete();
    expect(await erro(comp(GES, D))).toMatch(/SEM_ACORDO_COLETIVO/);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
  });
  test('norma inativa ou inexistente ⇒ bloqueia; sem normaId a Fase 2 continua igual', async () => {
    await popular('FA', { ausentes: ['2026-09-22'] });
    await db.doc('banco_horas_normas/' + NORMA.id).update({ ativa: false });
    expect(await erro(comp(GES, D))).toMatch(/NORMA_INATIVA_OU_INEXISTENTE/);
    await db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: true, permiteSaldoNegativo: true, limiteNegativoMin: 600 });   // modo Fase 2
    expect(await comp(GES, D)).toMatchObject({ ok: true });
  });
  test('limite de 4 h negativas/mês: 8h sem saldo é recusada; com exceção da diretoria (≥24h de antecedência) é aceita', async () => {
    await popular('FA', { ausentes: ['2026-09-22'] });                                // falta debitada pelo motor: saldo −8h
    expect(await erro(comp(GES, D))).toMatch(/LIMITE_NEGATIVO_MENSAL_EXCEDIDO/);
    // exceção só de administrador, e com data ≥ amanhã (24h): para a data da ausência (passada) é recusada
    expect(await erro(exc(ADM, { funcId: 'FA', data: '2026-09-22', minutos: 300, motivo: 'Exceção da diretoria teste' }))).toMatch(/EXCECAO_EXIGE_24H_DE_ANTECEDENCIA/);
    expect(await erro(exc(GES, { funcId: 'FA', data: '2026-10-20', minutos: 300, motivo: 'Exceção da diretoria teste' }))).toMatch(/permission-denied/);   // gestão ≠ diretoria
    expect(await exc(ADM, { funcId: 'FA', data: '2026-10-20', minutos: 300, motivo: 'Exceção da diretoria teste' })).toMatchObject({ ok: true, repetido: false });
    expect(await exc(ADM, { funcId: 'FA', data: '2026-10-20', minutos: 300, motivo: 'Exceção da diretoria teste' })).toMatchObject({ repetido: true });
    expect(await erro(exc(ADM, { funcId: 'FA', data: '2026-10-20', minutos: 200, motivo: 'Exceção da diretoria teste' }))).toMatch(/already-exists/);
  });
  test('banco após 31/12/2026 (validade) e data anterior ao acordo são recusados', async () => {
    await popular('FA', { saidas: {}, ausentes: ['2026-09-22'] });
    expect(await erro(comp(GES, { ...D, dataAusencia: '2026-08-01' }))).toMatch(/DATA_ANTERIOR_AO_ACORDO|failed-precondition/);
    await db.doc('banco_horas_normas/' + NORMA.id).update({ bancoValidoAte: '2026-09-01' });
    expect(await erro(comp(GES, D))).toMatch(/BANCO_FORA_DA_VALIDADE/);
  });
  test('NADA é alterado: sem saldos reais, sem pagamento, sem toque em marcações/espelhos', async () => {
    await popular('FA', { ausentes: ['2026-09-22'] });
    await db.doc('espelhos/FA_2026-08').set({ funcId: 'FA', mes: '2026-08', assinado: true });
    const antes = JSON.stringify((await db.collection('espelhos').get()).docs.map(x => x.data()));
    await erro(comp(GES, D));
    expect(JSON.stringify((await db.collection('espelhos').get()).docs.map(x => x.data()))).toBe(antes);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
  });
  test('permissões da exceção: anônimo, funcionário comum e o PRÓPRIO administrador no seu banco negados', async () => {
    expect(await erro(exc(null, { funcId: 'FA', data: '2026-10-20', minutos: 60, motivo: 'Exceção da diretoria teste' }))).toMatch(/unauthenticated/);
    expect(await erro(exc(FUNU, { funcId: 'FA', data: '2026-10-20', minutos: 60, motivo: 'Exceção da diretoria teste' }))).toMatch(/permission-denied/);
    await db.doc('users/' + ADM).update({ funcionarioId: 'FA' });
    expect(await erro(exc(ADM, { funcId: 'FA', data: '2026-10-20', minutos: 60, motivo: 'Exceção da diretoria teste' }))).toMatch(/permission-denied/);
  });
});

describe('norma cadastrável e interface', () => {
  const root = path.resolve(__dirname, '../..');
  test('script da norma: válida pelo validador, INATIVA, sem acordo/política/saldo', () => {
    const { NORMA: N } = require('../scripts/banco_norma');
    expect(M.normaCctValida(N).ok).toBe(true);
    expect(N.ativa).toBe(false);
    expect(N.origem).toMatchObject({ registro: 'CE000233/2026', clausula: '28ª' });
    expect(N).toMatchObject({ apuracaoDias: 120, compensacaoDias: 30, fatorFolgaPorHoraExtra: 1.5, limiteNegativoMesMin: 240, limiteExtraDiarioMin: 120, adicionalHoraExtra: 0.55, exigeAcordoColetivo: true });
    const fonte = fs.readFileSync(path.join(root, 'functions/scripts/banco_norma.js'), 'utf8');
    expect(fonte).not.toMatch(/banco_horas_config|banco_horas_lancamentos|registros|espelhos/);
  });
  test('interface: prévia só com cctPreview/acumulativoAtivo; não gera pagamento; nenhuma escrita direta', () => {
    const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
    expect(g).toMatch(/if\(!cfg\.acumulativoAtivo&&!cfg\.cctPreview\)/);
    expect(g).toMatch(/nenhum pagamento é gerado automaticamente/);
    const bloco = g.slice(g.indexOf('async function renderBancoAcumulado'), g.indexOf('// ── Feriados 2026'));
    expect(bloco).not.toMatch(/_setDoc\(docRef\('banco_horas_(normas|config)/);
  });
  test('regras: normas e histórico de política sem escrita de cliente', () => {
    const r = fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8');
    expect(r).toMatch(/match \/banco_horas_normas\/\{normaId\}\s*\{\s*allow read: if isAuthed\(\);\s*allow write: if false;/);
  });
});

describe('estáticos', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../lib/pontoBanco.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  test('callable de exceção exportado; cópia do motor idêntica; sem cobrança/folha', () => {
    expect(fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8')).toMatch(/exports\.pontoBancoExcecao\s*=\s*onCall\(\{ region: REGION \}/);
    expect(fs.readFileSync(path.resolve(__dirname, '../lib/ponto-regras.copy.js'), 'utf8')).toBe(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'));
    expect(src).not.toMatch(/salario|rescis|payroll/i);
  });
});
