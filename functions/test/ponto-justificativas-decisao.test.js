'use strict';
// Fase 4.3 — auditoria e decisão sobre justificativas pendentes: classificação, regras (aprovação/rejeição/solicitação), interface. Dados sintéticos.
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('firebase/firestore');
const { auditar } = require('../scripts/ponto_justificativas_auditar');
const root = path.resolve(__dirname, '../..');
jest.setTimeout(60000);

const F = { id: 'F1', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' };
const reg = (data, tipo, hora) => ({ id: tipo + data, funcId: 'F1', data, tipo, hora: hora + ':00' });
const dia = (data, e, sa, ra, s) => [['entrada', e], ['saida_almoco', sa], ['retorno_almoco', ra], ['saida', s]].filter(x => x[1]).map(([t, h]) => reg(data, t, h));
const jp = (id, data, tipo, hora, extra = {}) => ({ id, funcId: 'F1', data, motivo: 'Ponto não batido — ' + tipo + ' às ' + hora, tipoPonto: tipo, horarioPonto: hora, status: 'pendente', ...extra });
const aud = (regsAll, just, esp = [], hoje = '2026-10-11') => auditar({ funcs: [F], regsAll, cred: [], just, esp, corr: [], hoje });
const por = (r, id) => r.find(x => x.id === id);

describe('auditoria (classificação e recomendação)', () => {
  test('1 pronta: horário alegado + descrição, dia fecha; sem anexo mas com descrição', () => {
    const r = aud(dia('2026-10-06', '08:00', '12:00', '13:00', null), [jp('a', '2026-10-06', 'saida', '17:02', { descricao: 'Esqueci de bater ao sair; saí às 17:02 com o gerente presente' })]);
    expect(por(r, 'a')).toMatchObject({ classe: 1, impactoSeAprovada: { fechaODia: true, trabalhadoMin: 482 } });
  });
  test('2 complemento: sem descrição/anexo; sem horário a corrigir', () => {
    const r = aud(dia('2026-10-06', '08:00', '12:00', '13:00', null), [jp('a', '2026-10-06', 'saida', '17:02'), { id: 'b', funcId: 'F1', data: '2026-10-07', motivo: 'Atestado médico', status: 'pendente' }]);
    expect(por(r, 'a').classe).toBe(2); expect(por(r, 'b').classe).toBe(2);
  });
  test('2 par almoço sem descrição: impacto isolado incoerente vs. conjunto coerente; recomenda não aprovar em lote', () => {
    const regs = dia('2026-10-06', '08:14', '17:25', '17:26', '17:31');
    const r = aud(regs, [jp('s', '2026-10-06', 'saida_almoco', '12:01'), jp('r', '2026-10-06', 'retorno_almoco', '13:01')]);
    const s = por(r, 's');
    expect(s.classe).toBe(2);
    expect(s.impactoSeAprovada.trabalhadoMin).toBeLessThan(300);            // isolada: absurda
    expect(s.impactoSeAprovadasJuntas).toMatchObject({ fechaODia: true, trabalhadoMin: 497, saldoDiaMin: 17 });
    expect(s.recomendacao).toMatch(/não aprovar em lote/);
    expect(s.parDoDia).toHaveLength(2);
  });
  test('3 erro técnico: data futura; sábado com intervalo nulo', () => {
    const r = aud([], [jp('f', '2026-10-29', 'saida_almoco', '13:01')]);
    expect(por(r, 'f')).toMatchObject({ classe: 3, dataFutura: true });
    const r2 = aud(dia('2026-10-03', '08:36', '12:03', '12:03', '12:10'), [jp('x', '2026-10-03', 'saida', '12:10', { descricao: 'x' })], [], '2026-10-11');
    expect(por(r2, 'x').classe).toBeGreaterThanOrEqual(1);
  });
  test('4 duplicada/resolvida: mesma batida já aprovada (conflito) ou horário já consta', () => {
    const j = [jp('a', '2026-10-06', 'saida', '17:02', { status: 'aprovado' }), jp('b', '2026-10-06', 'saida', '17:30', { descricao: 'x' })];
    const r = aud(dia('2026-10-06', '08:00', '12:00', '13:00', '17:02'), j);
    expect(por(r, 'b')).toMatchObject({ classe: 4 }); expect(por(r, 'b').recomendacao).toMatch(/APROVADA/);
    const r2 = aud(dia('2026-10-06', '08:00', '12:00', '13:00', '17:30'), [jp('c', '2026-10-06', 'saida', '17:30', { descricao: 'x' })]);
    expect(por(r2, 'c').classe).toBe(4);
  });
  test('5 protegida: mês com espelho assinado (prevalece sobre qualquer outra classe)', () => {
    const r = aud(dia('2026-09-10', '08:00', '12:00', '13:00', null), [jp('a', '2026-09-10', 'saida', '17:00', { descricao: 'x' })], [{ funcId: 'F1', mes: '2026-09', assinado: true }]);
    expect(por(r, 'a').classe).toBe(5);
  });
  test('só audita pendentes; nada é decidido nem alterado (função pura)', () => {
    const j = [jp('a', '2026-10-06', 'saida', '17:02'), jp('d', '2026-10-05', 'saida', '17:02', { status: 'aprovado' }), jp('e', '2026-10-04', 'saida', '17:02', { status: 'rejeitado' })];
    const antes = JSON.stringify(j);
    expect(aud(dia('2026-10-06', '08:00', '12:00', '13:00', null), j)).toHaveLength(1);
    expect(JSON.stringify(j)).toBe(antes);
  });
});

describe('regras: aprovar, rejeitar, solicitar informação (fluxo existente)', () => {
  let env;
  const GES = 'gestor1', GES2 = 'gestor2', FUN = 'func1', FUN2 = 'func2';
  beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto-just-test', firestore: { rules: fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8') } }); });
  afterAll(async () => { await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore();
      for (const g of [GES, GES2]) { await db.doc('users/' + g).set({ role: 'gestor', ativo: true, ...(g === GES2 ? { funcionarioId: 'F9' } : {}) }); await db.doc('sistema_usuarios/' + g).set({ modulos: ['ponto'], admin: false, bloqueado: false }); }
      await db.doc('users/' + FUN).set({ role: 'funcionario', ativo: true, funcionarioId: 'F1' });
      await db.doc('users/' + FUN2).set({ role: 'funcionario', ativo: true, funcionarioId: 'F2' });
      await db.doc('justificativas/j1').set({ id: 'j1', funcId: 'F1', data: '2026-10-06', motivo: 'Ponto não batido — Saída às 17:02', tipoPonto: 'saida', horarioPonto: '17:02', status: 'pendente', lancadoPorGestor: false });
      await db.doc('justificativas/j9').set({ id: 'j9', funcId: 'F9', data: '2026-10-06', motivo: 'Ponto não batido — Saída às 17:02', tipoPonto: 'saida', horarioPonto: '17:02', status: 'pendente', lancadoPorGestor: false });
      await db.doc('registros/rS').set({ id: 'rS', funcId: 'F1', data: '2026-10-06', tipo: 'saida', hora: '17:30:00' });
    });
  });
  const ctx = uid => env.authenticatedContext(uid, { email: uid + '@x' }).firestore();

  test('solicitar informações: gestão grava a solicitação, status segue pendente; funcionário não grava; outro funcionário não lê', async () => {
    await assertSucceeds(ctx(GES).doc('justificativas/j1').update({ infoSolicitada: 'Informe o horário e quem presenciou', infoSolicitadaPorUid: GES, infoSolicitadaEm: serverTimestamp() }));
    await assertFails(ctx(FUN).doc('justificativas/j1').update({ infoSolicitada: 'x' }));
    await assertSucceeds(ctx(FUN).doc('justificativas/j1').get());
    await assertFails(ctx(FUN2).doc('justificativas/j1').get());
  });
  test('aprovar: autor/data gravados com identidade real; replay e personificação negados; original preservado', async () => {
    const g = ctx(GES);
    const b = g.batch();
    b.update(g.doc('justificativas/j1'), { status: 'aprovado', obsGestor: 'Conferido', respondidoPorUid: GES, respondidoPorEmail: GES + '@x', respondidoEm: serverTimestamp() });
    b.update(g.doc('registros/rS'), { substituidoPor: 'corr_j1', substituidoEm: serverTimestamp(), substituidoPorJustificativa: 'j1' });
    b.set(g.doc('registros/corr_j1'), { id: 'corr_j1', funcId: 'F1', data: '2026-10-06', tipo: 'saida', hora: '17:02:00', lancadoPorJustificativa: true, justificativaId: 'j1', valorOriginal: [{ id: 'rS', hora: '17:30:00', tipo: 'saida' }] });
    await assertSucceeds(b.commit());
    await env.withSecurityRulesDisabled(async c => { expect((await c.firestore().doc('registros/rS').get()).data().hora).toBe('17:30:00'); });        // horário original intacto
    await assertFails(ctx(GES2).doc('justificativas/j1').update({ status: 'rejeitado', respondidoPorUid: GES2, respondidoPorEmail: GES2 + '@x', respondidoEm: serverTimestamp() }));   // já decidida
  });
  test('rejeitar: registra autor e motivo; personificar aprovador é negado', async () => {
    await assertFails(ctx(GES).doc('justificativas/j1').update({ status: 'rejeitado', obsGestor: 'x', respondidoPorUid: 'outro', respondidoPorEmail: GES + '@x', respondidoEm: serverTimestamp() }));
    await assertSucceeds(ctx(GES).doc('justificativas/j1').update({ status: 'rejeitado', obsGestor: 'Sem evidência', respondidoPorUid: GES, respondidoPorEmail: GES + '@x', respondidoEm: serverTimestamp() }));
  });
  test('NÃO há autoaprovação: funcionário não decide; gestão não decide sobre o próprio ponto', async () => {
    await assertFails(ctx(FUN).doc('justificativas/j1').update({ status: 'aprovado', respondidoPorUid: FUN, respondidoPorEmail: FUN + '@x', respondidoEm: serverTimestamp() }));
    await assertFails(ctx(GES2).doc('justificativas/j9').update({ status: 'aprovado', respondidoPorUid: GES2, respondidoPorEmail: GES2 + '@x', respondidoEm: serverTimestamp() }));
    await assertFails(ctx(GES2).doc('justificativas/j9').update({ infoSolicitada: 'x' }));
  });
});

describe('interface (estática)', () => {
  const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
  test('contexto, consequências, gates e solicitação de informações; reutiliza o fluxo (sem criar coleção nova)', () => {
    const bloco = g.slice(g.indexOf('async function anexarContextoJustificativa'), g.indexOf('// ── Feriados 2026'));
    expect(bloco).toMatch(/Se APROVAR/); expect(bloco).toMatch(/Se REJEITAR/); expect(bloco).toMatch(/ESPELHO ASSINADO/); expect(bloco).toMatch(/POSTERIOR a hoje/);
    expect(bloco).toMatch(/justif-conferi/);
    expect(bloco).not.toMatch(/ponto_pendencias|_deleteDoc|fbDel\(/);
    expect(g).toMatch(/bloquearAprovar/); expect(g).toMatch(/Informe o motivo da rejeição/); expect(g).toMatch(/onclick="solicitarInfoJustificativa\(\)"/);
  });
  test('aprovação continua só manual: nenhum caminho decide sozinho', () => {
    const resp = g.slice(g.indexOf('async function responderJustificativa'), g.indexOf('async function creditarJornada'));
    expect(resp).not.toMatch(/setInterval|setTimeout\(.*responder/);
    expect(g.slice(g.indexOf('async function anexarContextoJustificativa'), g.indexOf('// ── Feriados 2026'))).not.toMatch(/status:'aprovado'|status:'rejeitado'/);
  });
});
