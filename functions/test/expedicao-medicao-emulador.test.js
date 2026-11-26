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
    for (const motivo of M.MOTIVO_IDS.filter(m => m !== 'NAO_ENTREGUE')) await assertSucceeds(gravar(U.func, plano(U.func, '200', 'se', 1, 'OCORRENCIA', { motivo, retrabalho: true })));
    const p = plano(U.func, '200', 'se', 1, 'OCORRENCIA', { motivo: 'AVARIA' });
    await assertFails(gravar(U.func, p, { motivo: 'OUTRO' }, '200_oc_v1_OUTRO'));
    await semear('201', 'se', 1);
    const q = plano(U.func, '201', 'se', 1, 'OCORRENCIA', { motivo: 'AVARIA' });
    await assertFails(gravar(U.func, q, { retrabalho: 'sim' }));
    await assertFails(gravar(U.func, q, { nota: 'x' }));
    await assertFails(gravar(U.func, q, {}, '201_oc_v1_PRODUTO_ERRADO'));
    await assertFails(gravar(U.func, plano(U.func, '300', 'se', 0, 'OCORRENCIA', { motivo: 'AVARIA' })));   // o real está em "ag"
    await assertSucceeds(gravar(U.func, plano(U.func, '400', 'de', 3, 'OCORRENCIA', { motivo: 'NAO_ENTREGUE' })));
    const r = plano(U.func, '201', 'se', 1, 'OCORRENCIA', { motivo: 'AVARIA' });
    await assertFails(gravar(U.func, r, { motivo: 'NAO_ENTREGUE' }, '201_oc_v1_NAO_ENTREGUE'));          // antes da saída não existe
  });
  test('registro não toca o pedido: o fluxo normal segue (com e sem conferência)', async () => {
    await semear('500', 'pr'); await semear('501', 'pr'); await ligar();
    await assertSucceeds(gravar(U.func, plano(U.func, '500', 'pr', 2)));
    const adapter = { transacao: fn => { const db = fs(U.func); return db.runTransaction(t => fn({ ler: async n => (await t.get(db.collection(COL).doc(n))).data(), atualizar: (n, c) => t.update(db.collection(COL).doc(n), c), criarEvento: (n, id, d) => t.set(db.collection(COL).doc(n).collection('eventos').doc(id), d) })); } };
    for (const n of ['500', '501']) await assertSucceeds(C.executarAcao(adapter, n, 'DESPACHAR', 'pr', { envio: 'retirada' }, { uid: U.func, papel: 'funcionario', agoraMs: Date.now(), serverTimestamp: TS }));
    await assertFails(gravar(U.func, plano(U.func, '501', 'pr', 3)));        // já despachado
  });
});

describe('RULES — janela de 7 dias, entrega, lote e atraso', () => {
  const cfg = (o = {}) => fs(U.gestor).doc('expedicao_config/medicao').set({ ativa: true, atualizadoEm: TS(), atualizadoPor: U.gestor, ...o });
  test('configuração: início AAAA-MM-DD e expediente inteiro coerente; só gestor', async () => {
    await assertSucceeds(cfg({ inicio: '2026-11-30', horaInicio: 7, horaFim: 19 }));
    await assertSucceeds(cfg({ inicio: '2026-12-07' }));
    for (const o of [{ inicio: '30/11/2026' }, { inicio: 20261130 }, { horaInicio: 8 }, { horaFim: 18 }, { horaInicio: 19, horaFim: 7 }, { horaInicio: 7.5, horaFim: 18 }, { horaInicio: 0, horaFim: 25 }, { dias: 30 }]) await assertFails(cfg(o));
    await assertFails(fs(U.func).doc('expedicao_config/medicao').set({ ativa: true, inicio: '2026-11-30', atualizadoEm: TS(), atualizadoPor: U.func }));
  });
  const semearDe = async (n, envio) => { await semear(n, 'de', 3); await admin(db => db.doc(`${COL}/${n}`).update({ envio })); };
  test('entrega: só em "de", envio com entrega, uma por saída, imutável', async () => {
    await semearDe('600', 'rota-manha'); await semearDe('601', 'retirada'); await semear('602', 'pr'); await ligar();
    const p = M.planejarRegistro({ pedido: { numero: '600', coluna: 'de', versao: 3, envio: 'rota-manha' }, tipo: 'ENTREGA', uid: U.func, config: { ativa: true }, serverTimestamp: TS });
    await assertSucceeds(gravar(U.func, p)); await assertFails(gravar(U.gestor, p, { por: U.gestor }));
    await assertFails(fs(U.gestor).collection(REG).doc(p.id).delete());
    await assertFails(gravar(U.func, p, { pedido: '601' }, '601_entrega_v3'));
    await assertFails(gravar(U.func, p, { pedido: '602', versao: 2 }, '602_entrega_v2'));
    await assertFails(gravar(U.func, p, { motivo: 'AVARIA' }, '600_entrega_v3'));
  });
  test('conferência com início; lote e "depois" validados', async () => {
    await semear('610', 'pr'); await semear('611', 'pr'); await ligar();
    const lote = M.novoLote();
    await assertSucceeds(gravar(U.func, plano(U.func, '610', 'pr', 2, 'CONFERENCIA_INICIO', { lote, loteTam: 2, depois: true })));
    await assertSucceeds(gravar(U.func, plano(U.func, '610', 'pr', 2, 'CONFERENCIA', { lote, loteTam: 2 })));
    const p = plano(U.func, '611', 'pr', 2);
    for (const o of [{ depois: false }, { depois: 'sim' }, { lote }, { loteTam: 2 }, { lote: 'x', loteTam: 2 }, { lote, loteTam: 31 }, { lote, loteTam: 0 }, { lote, loteTam: '2' }, { etapa: 'DESPACHAR' }]) await assertFails(gravar(U.func, p, o));
  });
  test('marca de transição: só quem fez, com o evento daquela versão; não altera o pedido nem os eventos', async () => {
    await semear('620', 'ag', 0); await ligar();
    const adapter = uid => ({ transacao: fn => { const db = fs(uid); return db.runTransaction(t => fn({ ler: async n => (await t.get(db.collection(COL).doc(n))).data(), atualizar: (n, c) => t.update(db.collection(COL).doc(n), c), criarEvento: (n, id, d) => t.set(db.collection(COL).doc(n).collection('eventos').doc(id), d) })); } });
    await assertSucceeds(C.executarAcao(adapter(U.func), '620', 'INICIAR_SEPARACAO', 'ag', { envio: 'rota-tarde' }, { uid: U.func, papel: 'funcionario', agoraMs: Date.now(), serverTimestamp: TS }));
    const m = (uid, o = {}) => M.planejarMarca({ pedido: '620', versao: 1, etapa: 'INICIAR_SEPARACAO', uid, config: { ativa: true }, serverTimestamp: TS, lote: M.novoLote(), loteTam: 2, ...o });
    const p = m(U.func);
    await assertFails(gravar(U.gestor, m(U.gestor)));                                            // não foi ele que clicou
    await assertFails(gravar(U.func, p, { etapa: 'DESPACHAR' }));
    await assertFails(gravar(U.func, p, { versao: 2 }, '620_marca_v2'));                         // não existe evento v2
    await assertFails(gravar(U.func, { id: p.id, dados: { pedido: '620', tipo: 'MARCA', versao: 1, etapa: 'INICIAR_SEPARACAO', em: TS(), por: U.func } }));   // sem lote nem atraso
    await assertFails(gravar(U.func, p, { texto: 'x' }));
    await assertSucceeds(gravar(U.func, p));
    await assertFails(gravar(U.func, m(U.func)));                                                // imutável
    // o pedido avançou: ainda é possível anotar a versão antiga (o evento existe)
    await assertSucceeds(C.executarAcao(adapter(U.func), '620', 'MARCAR_SEPARADO', 'se', {}, { uid: U.func, papel: 'funcionario', agoraMs: Date.now(), serverTimestamp: TS }));
    await assertSucceeds(gravar(U.func, M.planejarMarca({ pedido: '620', versao: 2, etapa: 'MARCAR_SEPARADO', uid: U.func, config: { ativa: true }, serverTimestamp: TS, depois: true })));
    let ev; await admin(async db => { ev = (await db.doc(`${COL}/620/eventos/v1`).get()).data(); });
    expect(ev).not.toHaveProperty('lote');
    await assertFails(fs(U.gestor).doc(`${COL}/620/eventos/v1`).update({ lote: 'Labcdef-1' }));    // eventos seguem imutáveis
    await ligar(false); await assertFails(gravar(U.func, M.planejarMarca({ pedido: '620', versao: 2, etapa: 'MARCAR_SEPARADO', uid: U.func, config: { ativa: true }, serverTimestamp: TS, depois: true }), {}, '620_marca_v2'));
  });
  test('pedido com horário da venda (sync novo) segue o fluxo pela tela; a tela não consegue alterar o campo', async () => {
    await semear('630', 'ag', 0); await admin(db => db.doc(`${COL}/630`).update({ vendaCadastradaEm: Date.now() - 1000 }));
    const db = fs(U.func), b = db.batch();
    b.update(db.doc(`${COL}/630`), { coluna: 'se', envio: 'retirada', versao: 1, ultimoEventoId: 'v1', atualizadoEm: TS(), atualizadoPor: U.func, movidoEm: Date.now(), vendaCadastradaEm: 1 });
    b.set(db.doc(`${COL}/630/eventos/v1`), { pedido: '630', de: 'ag', para: 'se', acao: 'INICIAR_SEPARACAO', versao: 1, em: TS(), por: U.func, origem: 't' });
    await assertFails(b.commit());
    const adapter = { transacao: fn => db.runTransaction(t => fn({ ler: async n => (await t.get(db.collection(COL).doc(n))).data(), atualizar: (n, c) => t.update(db.collection(COL).doc(n), c), criarEvento: (n, id, d) => t.set(db.collection(COL).doc(n).collection('eventos').doc(id), d) })) };
    await assertSucceeds(C.executarAcao(adapter, '630', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' }, { uid: U.func, papel: 'funcionario', agoraMs: Date.now(), serverTimestamp: TS }));
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
    // período "acompanhamento": usa a data configurada na tela
    await admin(db => db.doc('expedicao_config/medicao').set({ ativa: true, inicio: '2026-11-30' }));
    const a = await S.executar(['--emulador', process.env.FIRESTORE_EMULATOR_HOST, '--projeto', PROJECT_ID, '--periodo', 'acompanhamento'], { agoraMs: Date.parse('2026-12-07T10:00:00-03:00'), escrever: () => {} });
    expect(a.resultado.periodo).toMatchObject({ de: '2026-11-30', ate: '2026-12-06' }); expect(a.resultado.contagens.entradas).toBe(2);
  });
});
