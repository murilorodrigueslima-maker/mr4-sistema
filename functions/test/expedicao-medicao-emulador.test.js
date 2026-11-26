'use strict';
// Expedição — medição: Firestore Rules + relatório semanal contra o EMULADOR. Fixtures 100% sintéticas.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
const [EMU_HOST, EMU_PORTA] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app'); require('firebase/compat/firestore');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const C = require('../../js/expedicao-core.js'), M = require('../../js/expedicao-medicao-core.js');
const S = require('../../scripts/ops/relatorio-expedicao-semanal.js');

const PROJECT_ID = 'demo-exp-medicao', COL = 'expedicao_pedidos', REG = M.COL_REGISTROS;
const U = { gestor: 'med-gestor', func: 'med-func', outro: 'med-outro-modulo' };
let env;
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: EMU_HOST, port: Number(EMU_PORTA) } }); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await db.doc('users/' + U.gestor).set({ role: 'gestor', ativo: true });
    await db.doc('sistema_usuarios/' + U.gestor).set({ modulos: ['expedicao'], admin: false, bloqueado: false });
    await db.doc('users/' + U.func).set({ role: 'funcionario', ativo: true });
    await db.doc('sistema_usuarios/' + U.func).set({ modulos: ['expedicao'], admin: false, bloqueado: false });
    await db.doc('users/' + U.outro).set({ role: 'funcionario', ativo: true });
    await db.doc('sistema_usuarios/' + U.outro).set({ modulos: ['demandas'], admin: false, bloqueado: false });
  });
});
const fs = uid => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const admin = fn => env.withSecurityRulesDisabled(c => fn(c.firestore()));
const semear = (numero, coluna, versao = 2) => admin(db => db.collection(COL).doc(numero).set({ numero, data: '2026-11-30', hora: '', ingresadoEm: Date.now() - 3600e3, movidoEm: Date.now() - 3600e3, coluna, cliente: 'Cliente Sintético', vendedor: 'V', itens: 1, valor: 10, cidade: '', envio: coluna === 'ag' ? null : 'retirada', saidaEm: null, versao, origem: 'sync' }));
const ligar = (ativa = true) => admin(db => db.doc('expedicao_config/medicao').set({ ativa }));
const plano = (uid, numero, coluna, versao, tipo = 'CONFERENCIA', extra = {}) => M.planejarRegistro({ pedido: { numero, coluna, versao }, tipo, uid, config: { ativa: true }, serverTimestamp: TS, ...extra });
const gravar = (uid, p, dados = {}, id) => fs(uid).collection(REG).doc(id || p.id).set({ ...p.dados, ...dados });

describe('RULES — configuração', () => {
  const cfg = (uid, o = {}) => fs(uid).doc('expedicao_config/medicao').set({ ativa: true, atualizadoEm: TS(), atualizadoPor: uid, ...o });
  test('só gestor liga/desliga, com formato fechado; não apaga; outro documento é recusado', async () => {
    await assertSucceeds(cfg(U.gestor)); await assertSucceeds(cfg(U.gestor, { ativa: false }));
    await assertFails(cfg(U.func)); await assertFails(cfg(U.outro));
    await assertFails(cfg(U.gestor, { ativa: 'sim' })); await assertFails(cfg(U.gestor, { extra: 1 })); await assertFails(cfg(U.gestor, { atualizadoPor: 'outro' }));
    await assertFails(fs(U.gestor).doc('expedicao_config/outra').set({ ativa: true, atualizadoEm: TS(), atualizadoPor: U.gestor }));
    await assertFails(fs(U.gestor).doc('expedicao_config/medicao').delete());
    await assertSucceeds(fs(U.func).doc('expedicao_config/medicao').get());
    await assertFails(fs(U.outro).doc('expedicao_config/medicao').get()); await assertFails(fs(null).doc('expedicao_config/medicao').get());
  });
});

describe('RULES — registros opcionais', () => {
  test('desligada (sem documento ou ativa=false): nada é aceito', async () => {
    await semear('100', 'pr');
    await assertFails(gravar(U.func, plano(U.func, '100', 'pr', 2)));
    await ligar(false);
    await assertFails(gravar(U.gestor, plano(U.gestor, '100', 'pr', 2)));
  });
  test('ligada: conferência em "pr" na versão atual; 1 por ciclo; imutável; transação "não sobrescreve"', async () => {
    await semear('100', 'pr'); await ligar();
    const p = plano(U.func, '100', 'pr', 2);
    await assertSucceeds(fs(U.func).collection(REG).doc(p.id).get());       // leitura de documento inexistente (usada pela transação)
    await assertSucceeds(gravar(U.func, p));
    await assertFails(gravar(U.gestor, plano(U.gestor, '100', 'pr', 2)));    // segunda gravação = update
    await assertFails(fs(U.gestor).collection(REG).doc(p.id).update({ versao: 3 }));
    await assertFails(fs(U.gestor).collection(REG).doc(p.id).delete());
    await assertSucceeds(fs(U.func).collection(REG).where('em', '>=', firebase.firestore.Timestamp.fromMillis(Date.now() - 86400000)).get());
    await assertFails(fs(U.outro).collection(REG).get()); await assertFails(fs(null).collection(REG).get());
  });
  test('negações de conferência', async () => {
    await semear('100', 'pr'); await semear('200', 'se', 1); await ligar();
    const p = plano(U.func, '100', 'pr', 2);
    await assertFails(gravar(U.func, p, { versao: 3 }, '100_conf_v3'));
    await assertFails(gravar(U.func, p, { por: 'outro' }));
    await assertFails(gravar(U.func, p, { em: firebase.firestore.Timestamp.fromMillis(Date.now() - 3600e3) }));
    await assertFails(gravar(U.func, p, { observacao: 'texto livre' }));
    await assertFails(gravar(U.func, p, {}, 'qualquer-id'));
    await assertFails(gravar(U.func, p, { pedido: '999' }, '999_conf_v2'));
    await assertFails(gravar(U.func, plano(U.func, '200', 'pr', 1)));        // o pedido real está em "se"
    await assertFails(gravar(U.outro, plano(U.outro, '100', 'pr', 2)));
    await assertFails(gravar(null, plano('x', '100', 'pr', 2)));
  });
  test('ocorrência: motivos da lista em se/pr; vários motivos no mesmo ciclo; fora disso, nega', async () => {
    await semear('200', 'se', 1); await semear('300', 'ag', 0); await semear('400', 'de', 3); await ligar();
    for (const motivo of M.MOTIVO_IDS) await assertSucceeds(gravar(U.func, plano(U.func, '200', 'se', 1, 'OCORRENCIA', { motivo, retrabalho: true })));
    const p = plano(U.func, '200', 'se', 1, 'OCORRENCIA', { motivo: 'AVARIA' });
    await assertFails(gravar(U.func, p, { motivo: 'OUTRO' }, '200_oc_v1_OUTRO'));
    await semear('201', 'se', 1);
    const q = plano(U.func, '201', 'se', 1, 'OCORRENCIA', { motivo: 'AVARIA' });
    await assertFails(gravar(U.func, q, { retrabalho: 'sim' }));
    await assertFails(gravar(U.func, q, { nota: 'x' }));
    await assertFails(gravar(U.func, q, {}, '201_oc_v1_PRODUTO_ERRADO'));
    for (const [n, col, v] of [['300', 'se', 0], ['400', 'pr', 3]]) await assertFails(gravar(U.func, plano(U.func, n, col, v, 'OCORRENCIA', { motivo: 'AVARIA' })));
  });
  test('registro não toca o pedido: o fluxo normal segue (com e sem conferência)', async () => {
    await semear('500', 'pr'); await semear('501', 'pr'); await ligar();
    await assertSucceeds(gravar(U.func, plano(U.func, '500', 'pr', 2)));
    const adapter = { transacao: fn => { const db = fs(U.func); return db.runTransaction(t => fn({ ler: async n => (await t.get(db.collection(COL).doc(n))).data(), atualizar: (n, c) => t.update(db.collection(COL).doc(n), c), criarEvento: (n, id, d) => t.set(db.collection(COL).doc(n).collection('eventos').doc(id), d) })); } };
    for (const n of ['500', '501']) await assertSucceeds(C.executarAcao(adapter, n, 'DESPACHAR', 'pr', { envio: 'retirada' }, { uid: U.func, papel: 'funcionario', agoraMs: Date.now(), serverTimestamp: TS }));
    await assertFails(gravar(U.func, plano(U.func, '501', 'pr', 3)));        // já despachado
  });
});

describe('relatório semanal contra o emulador (REST, somente leitura)', () => {
  test('conta pedidos, trilha, registros e ligação com a venda; não vaza identificadores', async () => {
    const t0 = Date.parse('2026-11-30T09:00:00-03:00'), T = ms => firebase.firestore.Timestamp.fromMillis(ms);
    await admin(async db => {
      await db.doc(`${COL}/700`).set({ numero: '700', data: '2026-11-30', ingresadoEm: t0, movidoEm: t0 + 900e3, criadoEm: T(t0), coluna: 'de', saidaEm: t0 + 900e3, versao: 3, itens: 1, valor: 55.5, origem: 'sync', cliente: 'NAO-PODE-SAIR', vendedor: 'Vendedor Teste' });
      await db.doc(`${COL}/701`).set({ numero: '701', data: '2026-11-30', ingresadoEm: t0, movidoEm: t0, criadoEm: T(t0), coluna: 'ag', versao: 0, itens: 2, valor: 20, origem: 'sync', cliente: 'NAO-PODE-SAIR' });
      for (const [v, acao, de, em] of [[1, 'INICIAR_SEPARACAO', 'ag', 300e3], [2, 'MARCAR_SEPARADO', 'se', 600e3], [3, 'DESPACHAR', 'pr', 900e3]])
        await db.doc(`${COL}/700/eventos/v${v}`).set({ pedido: '700', versao: v, acao, de, em: T(t0 + em), por: 'uid-secreto' });
      await db.doc(`${REG}/700_conf_v2`).set({ pedido: '700', tipo: 'CONFERENCIA', versao: 2, em: T(t0 + 700e3), por: 'uid-secreto' });
      await db.doc('expedicao_config/medicao').set({ ativa: true });
      await db.doc('vendas_gc/9').set({ data: '2026-11-30', valor_total: '55.50', cadastrado_em: '2026-11-30 08:59:20', nome_vendedor: 'Vendedor Teste', produtos: [{ produto_id: '1' }] });
    });
    const saida = [];
    const r = await S.executar(['--emulador', process.env.FIRESTORE_EMULATOR_HOST, '--projeto', PROJECT_ID, '--de', '2026-11-30', '--ate', '2026-12-06', '--com-vendas'],
      { agoraMs: Date.parse('2026-12-07T10:00:00-03:00'), escrever: s => saida.push(s) });
    expect(r.resultado.contagens).toMatchObject({ entradas: 2, iniciados: 1, separados: 1, despachados: 1 });
    expect(r.resultado.intervalos.vendaInicio).toMatchObject({ n: 1, p50: 340e3 });
    expect(r.resultado.intervalos.separadoConferido).toMatchObject({ n: 1, p50: 100e3 });
    expect(r.resultado.conferencia.cobertura).toBe(1);
    expect(r.resultado.pendentes.ag.total).toBe(1);
    expect(saida.join('\n')).not.toMatch(/NAO-PODE-SAIR|uid-secreto|Vendedor Teste/);
    expect(r.leituras).toBeLessThan(15);
  });
});
