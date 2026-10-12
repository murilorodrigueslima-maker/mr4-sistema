'use strict';
// Fase 4.2 — fila de regularização (classificação, decisões no backend) e escalas individuais versionadas. Emulador; dados sintéticos.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const B = require('../lib/pontoBanco'); const M = B.M; const RG = require('../lib/pontoRegularizacao');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
jest.setTimeout(120000);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8') + ';this.calcDia=calcDia;this.cls=classificarPendenciaDia;this.jp=getJornadaPrevista;', ctx);
const R = (funcId, data, e, sa, ra, s) => [['entrada', e], ['saida_almoco', sa], ['retorno_almoco', ra], ['saida', s]].filter(x => x[1]).map(([tipo, h]) => ({ funcId, data, tipo, hora: h + ':00' }));
const F = { id: 'F1', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' };
const dia = (f, data, regs, just = []) => ctx.calcDia(f, data, regs, null, just);
const cl = (f, data, regs, c = {}) => ctx.cls(f, dia(f, data, regs, c.justificativas || []), { espelhos: [], justificativas: [], ...c });

describe('classificação (pura)', () => {
  test('marcação faltante lista o que falta; nunca propõe horário', () => {
    const r = cl(F, '2026-09-22', R('F1', '2026-09-22', '08:00', '12:00', '13:00', null));
    expect(r).toMatchObject({ classe: 'MARCACAO_FALTANTE', ausentes: ['Saída'] });
    expect(cl(F, '2026-09-22', R('F1', '2026-09-22', '08:00', null, null, '17:00')).ausentes).toEqual(['Saída almoço', 'Retorno almoço']);
  });
  test('justificativa pendente > marcação faltante; espelho assinado > tudo', () => {
    const j = [{ funcId: 'F1', data: '2026-09-22', status: 'pendente', motivo: 'Ponto não batido — Saída às 17:00' }];
    expect(cl(F, '2026-09-22', R('F1', '2026-09-22', '08:00', '12:00', '13:00', null), { justificativas: j }).classe).toBe('JUSTIFICATIVA_AGUARDANDO');
    expect(cl(F, '2026-09-22', R('F1', '2026-09-22', '08:00', '12:00', '13:00', null), { justificativas: j, espelhos: [{ funcId: 'F1', mes: '2026-09', assinado: true }] }).classe).toBe('PROTEGIDO_ASSINADO');
  });
  test('sábado: intervalo nulo não corrigido = erro técnico; entrada fora do padrão = escala desconhecida; sem início = escala desconhecida', () => {
    expect(cl(F, '2026-10-10', R('F1', '2026-10-10', '08:35', '12:03', '12:03', '12:03'))).toMatchObject({ classe: 'ERRO_TECNICO', motivo: 'SABADO_INTERVALO_NULO_NAO_CORRIGIDO' });
    expect(cl(F, '2026-10-10', R('F1', '2026-10-10', '10:30', null, null, null), { medianaEntradaSabado: 510 })).toMatchObject({ classe: 'ESCALA_DESCONHECIDA', motivo: 'SABADO_FORA_DO_PADRAO_DO_FUNCIONARIO' });
    expect(cl({ ...F, inicioBancoHoras: undefined }, '2026-10-10', R('F1', '2026-10-10', '08:30', null, null, null)).classe).toBe('ESCALA_DESCONHECIDA');
  });
  test('dia com marcações completas mas sequência inválida = decisão da gestão', () => {
    expect(cl(F, '2026-09-22', R('F1', '2026-09-22', '08:00', '13:00', '12:00', '17:00'))).toMatchObject({ classe: 'DECISAO_GESTAO', motivo: 'SEQUENCIA_DE_MARCACOES_INVALIDA' });
  });
});

describe('escalas versionadas (motor)', () => {
  const esc = (vig, rev, sab) => ({ vigenteDesde: vig, rev, dias: { 1: { minutos: 480 }, 2: { minutos: 480 }, 3: { minutos: 480 }, 4: { minutos: 480 }, 5: { minutos: 480 }, 6: { minutos: sab } } });
  test('vence a versão de maior vigência ≤ data; nova versão não retroage; mesma vigência: maior rev', () => {
    const f = { ...F, escalas: [esc('2026-09-01', 1, 240), esc('2026-11-01', 1, 0), esc('2026-09-01', 2, 270)] };
    expect(ctx.jp(f, '2026-08-29')).toBe(210);          // antes de qualquer escala: padrão
    expect(ctx.jp(f, '2026-10-10')).toBe(270);          // rev 2 da vigência de 09/01
    expect(ctx.jp(f, '2026-11-07')).toBe(0);            // nova vigência
  });
  test('F2-like: sábado de 4h (10:00–14:00) com escala individual fecha o dia sem pendência', () => {
    const f = { ...F, escalas: [{ vigenteDesde: '2026-09-01', rev: 1, dias: { 6: { minutos: 240 } } }] };
    expect(dia(f, '2026-10-10', R('F1', '2026-10-10', '10:00', null, null, '14:00'))).toMatchObject({ status: 'ok', jornadaPrevistaMin: 240, saldoMin: 0 });
  });
});

describe('backend (emulador)', () => {
  const AGORA = new Date('2026-10-12T15:00:00Z'), GES = 'r-ges', FUNU = 'r-funu', SEMMOD = 'r-semmod', PROPRIO = 'r-proprio';
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'ponto_sabado_correcoes', 'ponto_pendencias_decisoes', 'ponto_pendencias_estado', 'ponto_escalas', 'ponto_escalas_lock', 'users', 'sistema_usuarios'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
  const req = (uid, d) => ({ auth: uid ? { uid } : null, data: d });
  const dec = (uid, d) => RG.decidirHandler(req(uid, d), { db, now: () => AGORA });
  const esc = (uid, d) => RG.escalaHandler(req(uid, d), { db, now: () => AGORA });
  const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
  let seq = 0; const reg = (f, data, tipo, hora) => db.collection('registros').doc('r' + (++seq)).set({ funcId: f, data, tipo, hora: hora + ':00' });
  const hash = async c => crypto.createHash('sha1').update(JSON.stringify((await db.collection(c).orderBy('__name__').get()).docs.map(d => [d.id, d.data()]))).digest('hex');
  const limpos = () => Promise.all(['2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29'].flatMap(d => [reg('FA', d, 'entrada', '08:30'), reg('FA', d, 'saida', '12:00')]));
  const D = { funcId: 'FA', data: '2026-09-22', decisao: 'EM_ANALISE', motivo: 'Em análise pela gestão' };
  beforeEach(async () => {
    await limpar();
    await db.doc('users/' + GES).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + GES).set({ modulos: ['ponto'], admin: false, email: 'g@x' });
    await db.doc('users/' + SEMMOD).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + SEMMOD).set({ modulos: ['crm'], admin: false });
    await db.doc('users/' + FUNU).set({ role: 'funcionario', ativo: true }); await db.doc('sistema_usuarios/' + FUNU).set({ modulos: [], admin: false });
    await db.doc('users/' + PROPRIO).set({ role: 'gestor', ativo: true, funcionarioId: 'FA' }); await db.doc('sistema_usuarios/' + PROPRIO).set({ modulos: ['ponto'], admin: false });
    await db.doc('funcionarios/FA').set({ nome: 'FA', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' });
    await reg('FA', '2026-09-22', 'entrada', '08:00'); await reg('FA', '2026-09-22', 'saida_almoco', '12:00'); await reg('FA', '2026-09-22', 'retorno_almoco', '13:00');   // falta a saída
    await limpos();
  });
  afterAll(limpar);

  test('decisões registradas com autor/motivo, status derivado, idempotência e histórico append-only', async () => {
    expect(await dec(GES, D)).toMatchObject({ ok: true, repetido: false, status: 'em_analise', versao: 1 });
    expect(await dec(GES, D)).toMatchObject({ repetido: true });
    expect(await dec(GES, { ...D, decisao: 'ENCAMINHAR_REVISAO', motivo: 'Falta evidência da saída' })).toMatchObject({ status: 'encaminhado', versao: 2 });
    expect(await dec(GES, { ...D, decisao: 'JUSTIFICADO_SEM_HORARIO', motivo: 'Ciente; sem horário comprovado' })).toMatchObject({ status: 'justificado', versao: 3 });
    expect(await dec(GES, { ...D, decisao: 'REABRIR', motivo: 'Chegou nova evidência' })).toMatchObject({ status: 'pendente', versao: 4 });
    const ds = (await db.collection('ponto_pendencias_decisoes').get()).docs.map(x => x.data());
    expect(ds).toHaveLength(4); expect(ds.every(x => x.autorUid === GES && x.motivo && x.classe === 'MARCACAO_FALTANTE')).toBe(true);
  });
  test('CONCORRÊNCIA: 5 decisões diferentes simultâneas ⇒ 5 versões distintas, nenhuma perdida', async () => {
    const ms = ['EM_ANALISE', 'ENCAMINHAR_REVISAO', 'JUSTIFICADO_SEM_HORARIO', 'EM_ANALISE', 'ENCAMINHAR_REVISAO'];
    const rs = await Promise.all(ms.map((x, i) => erro(dec(GES, { ...D, decisao: x, motivo: 'Decisão concorrente número ' + i }))));
    expect(rs.filter(x => x === 'OK').length).toBe(5);
    const vs = (await db.collection('ponto_pendencias_decisoes').get()).docs.map(x => x.data().versao).sort();
    expect(vs).toEqual([1, 2, 3, 4, 5]);
  });
  test('NÃO inventa horário nem mexe em marcações/justificativas/espelhos/cadastro', async () => {
    const antes = await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hash));
    await dec(GES, D); await dec(GES, { ...D, decisao: 'JUSTIFICADO_SEM_HORARIO', motivo: 'Ciente; sem horário comprovado' });
    expect(await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hash))).toEqual(antes);
  });
  test('mês assinado e dia sem pendência bloqueiam; futuro/hoje recusados', async () => {
    expect(await erro(dec(GES, { ...D, data: '2026-09-23' }))).toMatch(/SEM_PENDENCIA_NESTA_DATA/);
    expect(await erro(dec(GES, { ...D, data: '2026-10-12' }))).toMatch(/invalid-argument/);
    await db.doc('espelhos/FA_2026-09').set({ funcId: 'FA', mes: '2026-09', assinado: true });
    expect(await erro(dec(GES, D))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
    expect((await db.collection('ponto_pendencias_decisoes').get()).size).toBe(0);
  });
  test('aplicar regra do sábado: cria a correção auditada uma única vez; só onde se aplica', async () => {
    const S = '2026-09-26';
    await reg('FA', S, 'entrada', '08:35'); await reg('FA', S, 'saida_almoco', '12:03'); await reg('FA', S, 'retorno_almoco', '12:03'); await reg('FA', S, 'saida', '12:10');
    expect(await erro(dec(GES, { ...D, decisao: 'APLICAR_REGRA_SABADO' }))).toMatch(/REGRA_NAO_SE_APLICA_A_ESTA_DATA/);          // 22/09 (terça)
    const r = await dec(GES, { funcId: 'FA', data: S, decisao: 'APLICAR_REGRA_SABADO', motivo: 'Intervalo nulo confirmado pela gestão' });
    expect(r).toMatchObject({ ok: true, status: 'corrigido', correcaoCriada: true });
    const c = (await db.doc('ponto_sabado_correcoes/FA_' + S).get()).data();
    expect(c).toMatchObject({ ativa: true, decididoPorUid: GES, marcas: { sa: '12:03', ra: '12:03' }, origem: 'pontoPendenciaDecidir' });
    expect(await dec(GES, { funcId: 'FA', data: S, decisao: 'APLICAR_REGRA_SABADO', motivo: 'Intervalo nulo confirmado pela gestão' })).toMatchObject({ repetido: true });
    expect(await erro(dec(GES, { funcId: 'FA', data: S, decisao: 'REABRIR', motivo: 'Tentativa de reabrir' }))).toMatch(/SEM_PENDENCIA|CORRECAO_APLICADA/);
  });
  test('permissões: anônimo, funcionário comum, sem módulo ponto e o PRÓPRIO ponto negados; payload estrito', async () => {
    expect(await erro(dec(null, D))).toMatch(/unauthenticated/);
    expect(await erro(dec(FUNU, D))).toMatch(/permission-denied/);
    expect(await erro(dec(SEMMOD, D))).toMatch(/permission-denied/);
    expect(await erro(dec(PROPRIO, D))).toMatch(/permission-denied/);
    expect(await erro(dec(GES, { ...D, extra: 1 }))).toMatch(/invalid-argument/);
    expect(await erro(dec(GES, { ...D, decisao: 'APAGAR' }))).toMatch(/invalid-argument/);
    expect(await erro(dec(GES, { ...D, motivo: 'x' }))).toMatch(/invalid-argument/);
  });

  const DIAS = { 1: { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 }, 2: { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 }, 3: { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 },
    4: { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 }, 5: { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 }, 6: { trabalha: true, entrada: '10:00', saida: '14:00', intervaloMin: 0 } };
  const E = { funcId: 'FA', vigenteDesde: '2026-11-01', dias: DIAS, motivo: 'Escala confirmada com o funcionário' };
  test('escala: nova versão com vigência, minutos calculados, repetida = idempotente, revisão = rev 2; histórico append-only', async () => {
    const r = await esc(GES, E);
    expect(r).toMatchObject({ ok: true, repetido: false, rev: 1, retroativa: false });
    const d = (await db.doc('ponto_escalas/FA_2026-11-01_r1').get()).data();
    expect(d.dias['6']).toMatchObject({ minutos: 240, entrada: '10:00', saida: '14:00' }); expect(d.dias['1'].minutos).toBe(480);
    expect(await esc(GES, E)).toMatchObject({ repetido: true });
    const r2 = await esc(GES, { ...E, dias: { ...DIAS, 6: { trabalha: false } }, motivo: 'Sábado deixou de ser trabalhado' });
    expect(r2).toMatchObject({ rev: 2 });
    expect((await db.collection('ponto_escalas').get()).size).toBe(2);
    // o motor do backend usa as escalas
    const x = await db.runTransaction(tx => B.carregarBanco(tx, db, 'FA', '2026-10-12'));
    expect(x.func.escalas.length).toBe(2);
    expect(M.getJornadaPrevista(x.func, '2026-11-07')).toBe(0);
  });
  test('escala: retroativa marcada; mês assinado bloqueia; validações; permissões', async () => {
    expect(await esc(GES, { ...E, vigenteDesde: '2026-10-01' })).toMatchObject({ retroativa: true });
    await db.doc('espelhos/FA_2026-10').set({ funcId: 'FA', mes: '2026-10', assinado: true });
    expect(await erro(esc(GES, { ...E, vigenteDesde: '2026-10-05', motivo: 'Outra tentativa em mês assinado' }))).toMatch(/MES_ASSINADO_NA_VIGENCIA/);
    expect(await erro(esc(GES, { ...E, dias: { ...DIAS, 3: { trabalha: true, entrada: '17:00', saida: '08:00' } } }))).toMatch(/invalid-argument/);
    expect(await erro(esc(GES, { ...E, dias: { 1: DIAS[1] } }))).toMatch(/invalid-argument/);
    expect(await erro(esc(FUNU, E))).toMatch(/permission-denied/);
    expect(await erro(esc(PROPRIO, E))).toMatch(/permission-denied/);
    expect(await erro(esc(null, E))).toMatch(/unauthenticated/);
  });
});

describe('regras e estáticos', () => {
  const root = path.resolve(__dirname, '../..');
  let env;
  beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto-reg-test', firestore: { rules: fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8') } }); });
  afterAll(async () => { await env.cleanup(); });
  test('cliente não escreve em decisões/estado/escalas; funcionário lê só a própria escala', async () => {
    await env.withSecurityRulesDisabled(async c => {
      const x = c.firestore();
      await x.doc('users/g').set({ role: 'gestor', ativo: true }); await x.doc('sistema_usuarios/g').set({ modulos: ['ponto'], admin: true, bloqueado: false });
      await x.doc('users/u').set({ role: 'funcionario', ativo: true, funcionarioId: 'F1' });
      await x.doc('ponto_escalas/F1_a').set({ funcId: 'F1' }); await x.doc('ponto_escalas/F2_a').set({ funcId: 'F2' });
    });
    const g = env.authenticatedContext('g').firestore(), u = env.authenticatedContext('u').firestore();
    for (const p of ['ponto_pendencias_decisoes/x', 'ponto_pendencias_estado/x', 'ponto_escalas/novo', 'ponto_escalas_lock/x']) { await assertFails(g.doc(p).set({ a: 1 })); await assertFails(u.doc(p).set({ a: 1 })); }
    await assertSucceeds(u.doc('ponto_escalas/F1_a').get()); await assertFails(u.doc('ponto_escalas/F2_a').get());
    await assertSucceeds(g.doc('ponto_escalas/F2_a').get());
    await assertFails(u.doc('ponto_pendencias_estado/x').get());
  });
  test('telas usam os callables; sem escrita direta nas coleções novas; motor copiado idêntico; callables exportados', () => {
    const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
    const bloco = g.slice(g.indexOf('async function renderRegularizacao'), g.indexOf('// ── Feriados 2026'));
    expect(bloco).toMatch(/window\._pendDecidir/); expect(bloco).toMatch(/window\._escalaDefinir/);
    expect(bloco).not.toMatch(/fbSet\('(ponto_|registros|espelhos|funcionarios)/); expect(bloco).not.toMatch(/_deleteDoc|fbDel\(/);
    expect(fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'modulos/ponto-regras.js'), 'utf8'));
    const idx = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
    expect(idx).toMatch(/exports\.pontoPendenciaDecidir\s*=\s*onCall\(\{ region: REGION \}/); expect(idx).toMatch(/exports\.pontoEscalaDefinir\s*=\s*onCall\(\{ region: REGION \}/);
  });
});
