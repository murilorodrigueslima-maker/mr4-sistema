'use strict';
// Banco de horas acumulativo + compensação de faltas: lógica pura + Firestore Rules (emulador). Dados 100% sintéticos.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('firebase/firestore');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8') +
  ';this.A=calcBancoAcumulado;this.V=avaliarCompensacao;this.ID=idCompensacao;this.MM=montarMesesBanco;this.MD=mesesDoBanco;this.CM=calcBancoMes;this.VIG=compensacoesVigentes;', ctx);
const { A, V, ID, VIG, MM, MD } = ctx;
const d = (data, saldoMin) => ({ data, saldoMin, contaNoSaldo: true });

describe('lógica pura — acumulado', () => {
  test('saldo positivo e negativo atravessam a virada do mês (sem zerar)', () => {
    const r = A([{ mes: '2026-08', dias: [d('2026-08-03', 120)] }, { mes: '2026-09', dias: [d('2026-09-01', -300)] }, { mes: '2026-10', dias: [d('2026-10-01', 60)] }], []);
    expect(r.map(x => x.saldoFinal)).toEqual([120, -180, -120]);
    expect(r.map(x => x.saldoAnterior)).toEqual([0, 120, -180]);
    expect(r[1]).toMatchObject({ creditos: 0, debitos: -300 });
  });
  test('créditos e débitos do mês separados; dias fora do saldo ignorados', () => {
    const r = A([{ mes: '2026-09', dias: [d('2026-09-01', 90), d('2026-09-02', -30), { data: '2026-09-03', saldoMin: null, contaNoSaldo: false }] }], []);
    expect(r[0]).toMatchObject({ creditos: 90, debitos: -30, saldoFinal: 60 });
  });
  test('exemplos: +10h−8h=+2h ; +3h−8h=−5h ; −4h−8h=−12h (motor já debitou o dia → sem débito duplo)', () => {
    const caso = (sal, ) => {
      const base = [{ mes: '2026-09', dias: [d('2026-09-01', sal + 480), d('2026-09-02', -480)] }];
      const lan = [{ id: 'x', tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-02', minutos: 480 }];
      return [A(base, [])[0].saldoFinal, A(base, lan)[0].saldoFinal];
    };
    expect(caso(600)).toEqual([600, 600]);              // saldo final do mês não muda: a falta já estava debitada, só é reclassificada
    const av = (atual, deb, h, pol) => V(atual, deb, h, pol);
    expect(av(120, 480, 480, {})).toMatchObject({ ok: true, saldoDepoisMin: 120 });                    // 10h antes (120+480=600) −8h = +2h
    expect(av(-180, 480, 480, {})).toMatchObject({ ok: false, motivo: 'SALDO_INSUFICIENTE_NEGATIVO_NAO_PERMITIDO' });
    expect(av(-180, 480, 480, { permiteSaldoNegativo: true })).toMatchObject({ ok: true, saldoAntesMin: 300, saldoDepoisMin: -180, negativo: true });
    expect(av(-720, 480, 480, { permiteSaldoNegativo: true })).toMatchObject({ ok: true, saldoAntesMin: -240, saldoDepoisMin: -720 });
  });
  test('ausência que o motor NÃO debitou (ex.: justificada) gera débito real; parcial debita só o excedente', () => {
    const base = [{ mes: '2026-09', dias: [d('2026-09-01', 600), d('2026-09-02', 0), d('2026-09-03', -240)] }];
    expect(A(base, [{ id: 'a', tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-02', minutos: 480 }])[0]).toMatchObject({ compensacoes: -480, saldoFinal: 600 - 240 - 480 });
    expect(A(base, [{ id: 'b', tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-03', minutos: 480 }])[0].compensacoes).toBe(-240);
  });
  test('estorno cancela o efeito; ajuste entra na competência', () => {
    const base = [{ mes: '2026-09', dias: [d('2026-09-02', 0)] }];
    const c = { id: 'a', tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-02', minutos: 480 };
    expect(A(base, [c])[0].saldoFinal).toBe(-480);
    expect(A(base, [c, { id: 'est_a', tipo: 'ESTORNO', estornaId: 'a' }])[0].saldoFinal).toBe(0);
    expect(A(base, [{ id: 'j', tipo: 'AJUSTE', competencia: '2026-09', minutos: 30 }])[0]).toMatchObject({ ajustes: 30, saldoFinal: 30 });
    expect(VIG([c, { tipo: 'ESTORNO', estornaId: 'a' }])).toHaveLength(0);
  });
  test('entrada inválida e id determinístico', () => {
    expect(V(600, 0, 0, {}).ok).toBe(false); expect(V(600, 0, 1.5, {}).ok).toBe(false); expect(V(600, 0, 2000, {}).ok).toBe(false);
    expect(ID('f1', '2026-09-02')).toBe('f1_2026-09-02');
    expect(V(100, 0, 600, { permiteSaldoNegativo: true, limiteNegativoMin: 300 })).toMatchObject({ ok: false, motivo: 'EXCEDE_LIMITE_NEGATIVO' });
  });
});


describe('montagem dos meses — espelho assinado nunca é recalculado', () => {
  const F = { id: 'F1', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-01' };
  test('mesesDoBanco: do início ao mês pedido; sem início não acumula', () => {
    expect(MD('2026-08-15', '2026-10')).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(MD('2025-11-02', '2026-01')).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(MD(undefined, '2026-10')).toEqual([]);
  });
  test('assinado com snapshot usa os dias CONGELADOS (mesmo que o motor hoje diga outra coisa)', () => {
    const esp = [{ funcId: 'F1', mes: '2026-08', assinado: true, versao: 1, snapshot: { dias: [{ data: '2026-08-03', saldoDia: 77, contaNoSaldo: true, status: 'ok' }] } }];
    const r = MM(F, [{ mes: '2026-08', regs: [], cred: [], just: [] }], esp, '2026-10-07', '2026-10-06', '2026-10');
    expect(r[0]).toMatchObject({ congelado: true, origem: 'SNAPSHOT_ASSINADO' });
    expect(A(r, [])[0].saldoFinal).toBe(77);
  });
  test('assinado sem snapshot (legado) é sinalizado; não assinado usa o motor', () => {
    const esp = [{ funcId: 'F1', mes: '2026-08', assinado: true }];
    const r = MM(F, [{ mes: '2026-08', regs: [], cred: [], just: [] }, { mes: '2026-09', regs: [], cred: [], just: [] }], esp, '2026-10-07', '2026-10-06', '2026-10');
    expect(r[0]).toMatchObject({ congelado: false, origem: 'ASSINADO_SEM_SNAPSHOT' });
    expect(r[1].origem).toBe('MOTOR');
  });
  test('isolamento por funcionário: espelho de outro funcionário não congela', () => {
    const esp = [{ funcId: 'OUTRO', mes: '2026-08', assinado: true, snapshot: { dias: [{ data: '2026-08-03', saldoDia: 999, contaNoSaldo: true }] } }];
    expect(MM(F, [{ mes: '2026-08', regs: [], cred: [], just: [] }], esp, '2026-10-07', '2026-10-06', '2026-10')[0].origem).toBe('MOTOR');
  });
});

describe('estáticos — desligado por padrão, sem escrita destrutiva', () => {
  const gest = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto.html'), 'utf8');
  const func = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-func.html'), 'utf8');
  test('ambas as telas só exibem com acumulativoAtivo; gestão só compensa com compensacaoAtiva', () => {
    expect(gest).toMatch(/if\(!cfg\.acumulativoAtivo\)/); expect(func).toMatch(/if\(!cfg\.acumulativoAtivo\)return/);
    expect(gest).toMatch(/if\(!cfg\.compensacaoAtiva\)\{msg\('Compensação desativada/);
  });
  test('funcionário não tem nenhuma escrita no banco; gestão não apaga lançamentos', () => {
    const bloco = func.slice(func.indexOf('async function renderBancoAcumFunc'), func.indexOf('function ontemStr'));
    expect(bloco).not.toMatch(/_setDoc|_fbSetOwn|fbSet|_deleteDoc|fbDel|updateDoc/);
    const g = gest.slice(gest.indexOf('async function renderBancoAcumulado'), gest.indexOf('// ── Feriados 2026'));
    expect(g).not.toMatch(/_deleteDoc|fbDel\(/);
  });
  test('textos dinâmicos passam por esc()', () => {
    const g = gest.slice(gest.indexOf('function bancoAcumuladoHtml'), gest.indexOf('function abrirCompensacao'));
    expect(g).toMatch(/esc\(l\.motivo\)/); expect(g).toMatch(/esc\(f\.nome\)/);
  });
});

describe('Rules — razão banco_horas_lancamentos', () => {
  let env; const GES = 'g1', FUN = 'u-f1', OUT = 'u-f2', ADM = 'adm', FID1 = 'F1', FID2 = 'F2';
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'mr4-ponto-banco-test', firestore: { rules: fs.readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8') } });
  });
  afterAll(async () => { await env.cleanup(); });
  const seed = async (cfg) => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore();
      await db.doc('users/' + GES).set({ role: 'gestor', ativo: true });
      await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, bloqueado: false });
      await db.doc('users/' + ADM).set({ role: 'gestor', ativo: true });
      await db.doc('sistema_usuarios/' + ADM).set({ modulos: [], admin: true, bloqueado: false });
      await db.doc('users/' + FUN).set({ role: 'funcionario', ativo: true, funcionarioId: FID1 });
      await db.doc('users/' + OUT).set({ role: 'funcionario', ativo: true, funcionarioId: FID2 });
      if (cfg) await db.doc('banco_horas_config/politica').set(cfg);
      await db.doc('banco_horas_lancamentos/' + FID1 + '_2026-09-01').set({ funcId: FID1, tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-01', competencia: '2026-09', minutos: 480 });
    });
  };
  const comp = (extra = {}) => ({ funcId: FID1, tipo: 'COMPENSACAO_AUSENCIA', dataAusencia: '2026-09-02', competencia: '2026-09', minutos: 480, motivo: 'Compensação aprovada pela gestão',
    aprovadoPorUid: GES, aprovadoPorEmail: 'g@x', saldoAntesMin: 600, saldoDepoisMin: 120, criadoEm: serverTimestamp(), ...extra });
  const dbDe = uid => env.authenticatedContext(uid, { email: 'g@x' }).firestore();

  test('DESLIGADO por padrão: sem política ou com compensacaoAtiva=false, ninguém grava', async () => {
    await seed(null); await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').set(comp()));
    await seed({ compensacaoAtiva: false }); await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').set(comp()));
  });
  test('ativo: gestão grava; duplicado (mesmo id) falha; update/delete sempre negados', async () => {
    await seed({ compensacaoAtiva: true });
    await assertSucceeds(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').set(comp()));
    await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').set(comp()));
    await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').update({ minutos: 1 }));
    await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').delete());
    await assertFails(dbDe(ADM).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-01').delete());
  });
  test('saldo negativo só com política; sem permissão bloqueia; respeita limite', async () => {
    const neg = comp({ dataAusencia: '2026-09-03', saldoAntesMin: 300, saldoDepoisMin: -180 });
    await seed({ compensacaoAtiva: true }); await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-03').set(neg));
    await seed({ compensacaoAtiva: true, permiteSaldoNegativo: true, limiteNegativoMin: 120 }); await assertFails(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-03').set(neg));
    await seed({ compensacaoAtiva: true, permiteSaldoNegativo: true, limiteNegativoMin: 240 }); await assertSucceeds(dbDe(GES).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-03').set(neg));
  });
  test('validações: aprovador = quem chama; funcionário não grava; ninguém grava o próprio; campos extras/ aritmética inválida negados', async () => {
    await seed({ compensacaoAtiva: true });
    const ref = id => dbDe(GES).doc('banco_horas_lancamentos/' + id);
    await assertFails(ref(FID1 + '_2026-09-02').set(comp({ aprovadoPorUid: 'outro' })));
    await assertFails(ref(FID1 + '_2026-09-02').set(comp({ saldoDepoisMin: 999 })));
    await assertFails(ref(FID1 + '_2026-09-02').set(comp({ motivo: 'x' })));
    await assertFails(ref(FID1 + '_2026-09-02').set(comp({ extra: 1 })));
    await assertFails(ref(FID1 + '_2026-09-05').set(comp()));                       // id ≠ funcId_data
    await assertFails(dbDe(FUN).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-02').set(comp({ aprovadoPorUid: FUN })));
    await env.withSecurityRulesDisabled(async c => { await c.firestore().doc('users/' + GES).update({ funcionarioId: FID1 }); });
    await assertFails(ref(FID1 + '_2026-09-02').set(comp()));                       // gestão não mexe no PRÓPRIO banco
  });
  test('estorno: referencia compensação do mesmo funcionário; id determinístico; sem apagar', async () => {
    await seed({ compensacaoAtiva: true });
    const est = { funcId: FID1, tipo: 'ESTORNO', estornaId: FID1 + '_2026-09-01', competencia: '2026-09', minutos: 480, motivo: 'Lançada por engano', aprovadoPorUid: GES, aprovadoPorEmail: 'g@x', criadoEm: serverTimestamp() };
    await assertSucceeds(dbDe(GES).doc('banco_horas_lancamentos/est_' + FID1 + '_2026-09-01').set(est));
    await assertFails(dbDe(GES).doc('banco_horas_lancamentos/est_' + FID1 + '_2026-09-01').set(est));
    await assertFails(dbDe(GES).doc('banco_horas_lancamentos/est_x').set({ ...est, estornaId: 'inexistente' }));
    await assertFails(dbDe(GES).doc('banco_horas_lancamentos/est_' + FID1 + '_2026-09-01').delete());
  });
  test('isolamento: funcionário lê só o próprio razão; gestão lê todos; não autenticado nada', async () => {
    await seed({ compensacaoAtiva: true });
    await env.withSecurityRulesDisabled(async c => { await c.firestore().doc('banco_horas_lancamentos/' + FID2 + '_2026-09-01').set({ funcId: FID2, tipo: 'COMPENSACAO_AUSENCIA', minutos: 60 }); });
    await assertSucceeds(dbDe(FUN).doc('banco_horas_lancamentos/' + FID1 + '_2026-09-01').get());
    await assertFails(dbDe(FUN).doc('banco_horas_lancamentos/' + FID2 + '_2026-09-01').get());
    await assertFails(dbDe(FUN).collection('banco_horas_lancamentos').get());
    await assertSucceeds(dbDe(FUN).collection('banco_horas_lancamentos').where('funcId', '==', FID1).get());
    await assertSucceeds(dbDe(GES).doc('banco_horas_lancamentos/' + FID2 + '_2026-09-01').get());
    await assertFails(env.unauthenticatedContext().firestore().doc('banco_horas_lancamentos/' + FID1 + '_2026-09-01').get());
  });
  test('config: autenticado lê; só admin real grava', async () => {
    await seed({ compensacaoAtiva: false });
    await assertSucceeds(dbDe(FUN).doc('banco_horas_config/politica').get());
    await assertFails(dbDe(GES).doc('banco_horas_config/politica').set({ compensacaoAtiva: true }));
    await assertFails(dbDe(FUN).doc('banco_horas_config/politica').set({ compensacaoAtiva: true }));
  });
});
