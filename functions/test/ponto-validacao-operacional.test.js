'use strict';
// Fase 4.5 — validação operacional: gatilho de proteção, caminhos alternativos em mês assinado, uso exclusivo do callable. Sintético.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), vm = require('vm');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('firebase/firestore');
const PR = require('../lib/pontoProtecao'); const PM = require('../scripts/ponto_proteger_meses');
const J = require('../lib/pontoJustificativa'); const RG = require('../lib/pontoRegularizacao'); const BANCO = require('../lib/pontoBanco');
jest.setTimeout(120000);
const root = path.resolve(__dirname, '../..');

describe('gatilho de proteção (lógica, emulador)', () => {
  const COL = ['ponto_meses_protegidos'];
  const limpar = async () => { for (const c of COL) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
  beforeEach(limpar); afterAll(limpar);
  test('espelho ASSINADO cria o marcador; não assinado/ inválido não cria; reassinar é idempotente e não apaga', async () => {
    expect(await PR.protegerMesAssinado(db, FieldValue, { funcId: 'F1', mes: '2026-09', assinado: false }, 'e1')).toEqual({ marcado: false });
    expect(await PR.protegerMesAssinado(db, FieldValue, { funcId: 'F1', mes: '2026-9', assinado: true }, 'e1')).toEqual({ marcado: false });
    expect(await PR.protegerMesAssinado(db, FieldValue, null, 'e1')).toEqual({ marcado: false });
    expect((await db.collection('ponto_meses_protegidos').get()).size).toBe(0);
    expect(await PR.protegerMesAssinado(db, FieldValue, { funcId: 'F1', mes: '2026-09', assinado: true, versao: 2 }, 'e1')).toEqual({ marcado: true, id: 'F1_2026-09' });
    await PR.protegerMesAssinado(db, FieldValue, { funcId: 'F1', mes: '2026-09', assinado: true, versao: 2 }, 'e1');
    const d = (await db.doc('ponto_meses_protegidos/F1_2026-09').get()).data();
    expect(d).toMatchObject({ funcId: 'F1', mes: '2026-09', espelhoId: 'e1', versao: 2, origem: 'trigger' });
    expect(await PR.protegerMesAssinado(db, FieldValue, { funcId: 'F1', mes: '2026-09', assinado: false }, 'e1')).toEqual({ marcado: false });   // desassinar não remove
    expect((await db.doc('ponto_meses_protegidos/F1_2026-09').get()).exists).toBe(true);
  });
  test('o arquivo index.js compila (guarda contra erro de sintaxe que derruba TODAS as funções) e o gatilho usa a API modular', () => {
    const src = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
    expect(() => new vm.Script(src, { filename: 'index.js' })).not.toThrow();
    expect(src).toMatch(/exports\.pontoProtegerMesAssinado\s*=\s*onDocumentWritten\(\{ document: 'espelhos\/\{espelhoId\}'/);
    expect(src).toMatch(/require\('firebase-admin\/firestore'\)/);
  });
});

describe('caminhos alternativos em mês assinado (regras do banco de dados)', () => {
  let env;
  beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'mr4-ponto-v45-test', firestore: { rules: fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8') } }); });
  afterAll(async () => { await env.cleanup(); });
  const ctx = uid => env.authenticatedContext(uid, { email: uid + '@x' }).firestore();
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async c => {
      const x = c.firestore();
      await x.doc('users/g').set({ role: 'gestor', ativo: true }); await x.doc('sistema_usuarios/g').set({ modulos: ['ponto'], admin: true, bloqueado: false });
      await x.doc('users/g2').set({ role: 'gestor', ativo: true }); await x.doc('sistema_usuarios/g2').set({ modulos: ['ponto'], admin: false, bloqueado: false });
      await x.doc('users/u').set({ role: 'funcionario', ativo: true, funcionarioId: 'F1' });
      await x.doc('ponto_meses_protegidos/F1_2026-05').set({ funcId: 'F1', mes: '2026-05' });
      await x.doc('justificativas/jp').set({ id: 'jp', funcId: 'F1', data: '2026-05-10', motivo: 'Ponto não batido — Saída às 17:00', tipoPonto: 'saida', horarioPonto: '17:00', status: 'pendente', lancadoPorGestor: false });
      await x.doc('justificativas/ja').set({ id: 'ja', funcId: 'F1', data: '2026-05-11', motivo: 'Atestado médico', status: 'aprovado', lancadoPorGestor: true });
      await x.doc('registros/r1').set({ id: 'r1', funcId: 'F1', data: '2026-05-10', tipo: 'saida', hora: '17:30:00' });
      await x.doc('creditos_jornada/c1').set({ funcId: 'F1', data: '2026-05-11', minutos: 480, motivo: 'Atestado médico' });
      await x.doc('espelhos/F1_2026-05').set({ funcId: 'F1', mes: '2026-05', assinado: true, hashSnapshot: 'h', snapshot: { dias: [] } });
    });
  });
  test('excluir, rejeitar, pedir informação, aprovar, corrigir marcação e mexer em crédito: TODOS negados no cliente (admin inclusive)', async () => {
    for (const uid of ['g', 'g2']) {
      const d = ctx(uid);
      await assertFails(d.doc('justificativas/jp').delete());
      await assertFails(d.doc('justificativas/jp').update({ status: 'rejeitado', obsGestor: 'x', respondidoPorUid: uid, respondidoPorEmail: uid + '@x', respondidoEm: serverTimestamp() }));
      await assertFails(d.doc('justificativas/jp').update({ infoSolicitada: 'complemento' }));
      await assertFails(d.doc('justificativas/jp').update({ status: 'aprovado', respondidoPorUid: uid, respondidoPorEmail: uid + '@x', respondidoEm: serverTimestamp() }));
      await assertFails(d.doc('registros/r1').update({ substituidoPor: 'corr_x', substituidoEm: serverTimestamp(), substituidoPorJustificativa: 'jp' }));
      await assertFails(d.doc('registros/corr_x').set({ id: 'corr_x', funcId: 'F1', data: '2026-05-10', tipo: 'saida', hora: '17:00:00' }));
      await assertFails(d.doc('creditos_jornada/c1').update({ minutos: 0 }));
      await assertFails(d.doc('creditos_jornada/c1').delete());
      await assertFails(d.doc('creditos_jornada/c2').set({ funcId: 'F1', data: '2026-05-12', minutos: 480, motivo: 'Férias' }));
      await assertFails(d.doc('justificativas/novo').set({ id: 'novo', funcId: 'F1', data: '2026-05-12', motivo: 'Férias', status: 'aprovado', lancadoPorGestor: true }));
    }
    await assertFails(ctx('u').doc('justificativas/novo2').set({ id: 'novo2', funcId: 'F1', data: '2026-05-12', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false }));
  });
  test('o espelho assinado e o marcador continuam imutáveis para o cliente', async () => {
    await assertFails(ctx('g').doc('espelhos/F1_2026-05').update({ snapshot: { dias: [{ data: '2026-05-01' }] } }));
    await assertFails(ctx('g').doc('ponto_meses_protegidos/F1_2026-05').delete());
    await assertFails(ctx('g').doc('ponto_meses_protegidos/F1_2026-06').set({ funcId: 'F1', mes: '2026-06' }));
  });
  test('competência NÃO assinada segue operando (sem regressão): criar/ajustar créditos e rejeitar', async () => {
    await env.withSecurityRulesDisabled(async c => { await c.firestore().doc('justificativas/jn').set({ id: 'jn', funcId: 'F1', data: '2026-10-06', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false }); });
    await assertSucceeds(ctx('g2').doc('creditos_jornada/c9').set({ funcId: 'F1', data: '2026-10-06', minutos: 480, motivo: 'Atestado médico' }));
    await assertSucceeds(ctx('g2').doc('justificativas/jn').update({ status: 'rejeitado', obsGestor: 'sem prova', respondidoPorUid: 'g2', respondidoPorEmail: 'g2@x', respondidoEm: serverTimestamp() }));
  });
});

describe('caminhos alternativos via servidor (callables) em mês assinado — dados sintéticos', () => {
  const AGORA = new Date('2026-10-12T15:00:00Z');
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'ponto_meses_protegidos', 'ponto_justificativas_decisoes', 'ponto_justificativas_lock', 'ponto_pendencias_decisoes', 'ponto_pendencias_estado', 'ponto_escalas', 'ponto_escalas_lock', 'ponto_sabado_correcoes', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'users', 'sistema_usuarios'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
  beforeEach(async () => {
    await limpar();
    await db.doc('users/gg').set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/gg').set({ modulos: ['ponto'], admin: true, email: 'g@x' });
    await db.doc('funcionarios/FA').set({ nome: 'FA', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-04-01' });
    for (const [id, t, h] of [['r1', 'entrada', '08:00'], ['r2', 'saida_almoco', '12:00'], ['r3', 'retorno_almoco', '13:00']]) await db.doc('registros/' + id).set({ id, funcId: 'FA', data: '2026-05-12', tipo: t, hora: h + ':00' });
    await db.doc('justificativas/jx').set({ id: 'jx', funcId: 'FA', data: '2026-05-12', motivo: 'Ponto não batido — Saída às 17:00', tipoPonto: 'saida', horarioPonto: '17:00', status: 'pendente', lancadoPorGestor: false });
    await db.doc('espelhos/FA_2026-05').set({ funcId: 'FA', mes: '2026-05', assinado: true });
    await db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: true, permiteSaldoNegativo: true, limiteNegativoMin: 5000 });
  });
  afterAll(limpar);
  const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
  test('aprovar (callable de justificativa), decidir pendência, nova escala e folga: todos recusam o mês assinado; nada gravado', async () => {
    const ctxs = { auth: { uid: 'gg' } };
    expect(await erro(J.decidirJustificativaHandler({ ...ctxs, data: { ids: ['jx'], decisao: 'APROVAR' } }, { db, now: () => AGORA }))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
    expect(await erro(RG.decidirHandler({ ...ctxs, data: { funcId: 'FA', data: '2026-05-12', decisao: 'EM_ANALISE', motivo: 'Em análise pela gestão' } }, { db, now: () => AGORA }))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
    const DIAS = Object.fromEntries([1, 2, 3, 4, 5, 6].map(k => [String(k), { trabalha: true, entrada: '08:00', saida: '17:00', intervaloMin: 60 }]));
    expect(await erro(RG.escalaHandler({ ...ctxs, data: { funcId: 'FA', vigenteDesde: '2026-05-01', dias: DIAS, motivo: 'Tentativa em mês assinado' } }, { db, now: () => AGORA }))).toMatch(/MES_ASSINADO_NA_VIGENCIA/);
    expect(await erro(BANCO.folgaHandler({ ...ctxs, data: { funcId: 'FA', data: '2026-05-13', periodo: 'DIA_INTEIRO', motivo: 'Folga em mês assinado' } }, { db, now: () => AGORA }))).toMatch(/MES_COM_ESPELHO_ASSINADO/);
    expect((await db.collection('ponto_justificativas_decisoes').get()).size + (await db.collection('ponto_pendencias_decisoes').get()).size + (await db.collection('ponto_escalas').get()).size + (await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
    expect((await db.doc('justificativas/jx').get()).data().status).toBe('pendente');
    expect((await db.doc('registros/r2').get()).data().substituidoPor).toBeUndefined();
  });
});

describe('aprovação de pares exclusivamente pelo callable (estático)', () => {
  const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
  test('nenhum caminho do ponto.html grava status de justificativa/correção direto', () => {
    expect(g).not.toMatch(/status\s*:\s*'aprovado'[\s\S]{0,60}respondidoPor/);                    // sem o lote antigo
    expect(g).not.toMatch(/batch\.update\(docRef\('justificativas'/);
    expect(g).not.toMatch(/corr_'\+justifAtualId/);
    const usos = [...g.matchAll(/_decidirJustif\(/g)].length; expect(usos).toBeGreaterThanOrEqual(2);
    expect(g).toMatch(/aprovarParJustificativas/); expect(g).toMatch(/window\._justDecidir\(\{ids,decisao,obs\}\)/);
    // fbSet('justificativas', ...) só cria ocorrência/proposta NOVA (id novo) — nunca um id existente com status
    const sets = [...g.matchAll(/fbSet\('justificativas',([^,]+),\{([^}]{0,160})/g)].map(m => m[1]);
    sets.forEach(id => expect(id).toMatch(/^id$/));
  });
});
