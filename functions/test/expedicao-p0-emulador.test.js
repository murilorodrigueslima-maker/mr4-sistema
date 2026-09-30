'use strict';
// Expedição P0 — Firestore Rules + transações REAIS no emulador (firestore). Fixtures 100% sintéticas.
// Cobre: matriz de transições (ALLOW/DENY), compare-and-set de versão, evento obrigatório e imutável, cliente ANTIGO
// (payloads exatos da página em produção) bloqueado, duas telas (stale), criação concorrente, auditoria
// exatamente-uma-vez, falha de escrita sem efeito, sync central e escopo/leitura dos listeners.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app'); require('firebase/compat/firestore');
const admin = require('firebase-admin');
const { readFileSync } = require('fs'); const { resolve } = require('path');
const C = require('../../js/expedicao-core.js');
const SYNC = require('../lib/expedicao/sync');

const PROJECT_ID = 'mr4-ponto';
const COL = 'expedicao_pedidos';
const U = { gestor: 'exp-gestor', func: 'exp-func', semMod: 'exp-sem-modulo', outroMod: 'exp-outro-modulo' };
let env, adm;
const TS = () => firebase.firestore.FieldValue.serverTimestamp();

async function semear(db) {
  await db.collection('users').doc(U.gestor).set({ role: 'gestor', ativo: true });
  await db.collection('sistema_usuarios').doc(U.gestor).set({ nome: 'G', modulos: ['expedicao'], admin: false, bloqueado: false });
  await db.collection('users').doc(U.func).set({ role: 'funcionario', ativo: true, funcionarioId: 'F-EXP' });
  await db.collection('sistema_usuarios').doc(U.func).set({ nome: 'F', modulos: ['expedicao'], admin: false, bloqueado: false });
  await db.collection('users').doc(U.semMod).set({ role: 'funcionario', ativo: true, funcionarioId: 'F-SEM' });
  await db.collection('users').doc(U.outroMod).set({ role: 'funcionario', ativo: true, funcionarioId: 'F-OUT' });
  await db.collection('sistema_usuarios').doc(U.outroMod).set({ nome: 'O', modulos: ['demandas'], admin: false, bloqueado: false });
}
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  adm = (admin.apps.find(a => a && a.name === 'exp-p0') || admin.initializeApp({ projectId: PROJECT_ID }, 'exp-p0')).firestore();
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => semear(c.firestore())); });

const fs = uid => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const agora = () => Date.now();
// pedido como a página antiga / o sync criam (histórico sem versão = versão 0)
const base = (numero, coluna, o = {}) => ({ numero, data: '2026-09-29', hora: '09:00', ingresadoEm: agora() - 3600e3, movidoEm: agora() - 3600e3, coluna, cliente: 'Cliente Sintético', vendedor: 'V', itens: 1, valor: 10, cidade: '', envio: coluna === 'ag' ? null : 'retirada', saidaEm: coluna === 'de' ? agora() - 60e3 : null, ...o });
const semearPedido = (numero, coluna, o) => env.withSecurityRulesDisabled(c => c.firestore().collection(COL).doc(numero).set(base(numero, coluna, o)));
const ler = async numero => { let d; await env.withSecurityRulesDisabled(async c => { const s = await c.firestore().collection(COL).doc(numero).get(); d = s.exists ? s.data() : null; }); return d; };
const eventos = async numero => { let l; await env.withSecurityRulesDisabled(async c => { l = (await c.firestore().collection(COL).doc(numero).collection('eventos').get()).docs.map(d => ({ id: d.id, ...d.data() })); }); return l; };

// adaptador compat (mesma interface da página) → núcleo real
const adapterDe = db => ({ transacao: fn => db.runTransaction(t => fn({
  ler: async n => { const s = await t.get(db.collection(COL).doc(n)); return s.exists ? s.data() : null; },
  atualizar: (n, c) => t.update(db.collection(COL).doc(n), c),
  criarEvento: (n, id, d) => t.set(db.collection(COL).doc(n).collection('eventos').doc(id), d),
})) });
const ctxDe = (uid, papel = 'funcionario') => ({ uid, papel, agoraMs: agora(), origem: 'teste', serverTimestamp: TS });
const acao = (uid, numero, a, esperado, dados, papel) => C.executarAcao(adapterDe(fs(uid)), numero, a, esperado, dados || {}, ctxDe(uid, papel));

// escrita "crua" com protocolo completo aparentemente válido (para provar que as RULES barram a transição em si)
async function transicaoCrua(uid, numero, para, extras = {}, { versao, eventoId, evento = {} } = {}) {
  const atual = await ler(numero); const v = versao ?? ((atual.versao || 0) + 1); const id = eventoId ?? ('v' + v);
  const db = fs(uid); const b = db.batch();
  b.update(db.collection(COL).doc(numero), { coluna: para, versao: v, ultimoEventoId: 'v' + v, atualizadoEm: TS(), atualizadoPor: uid, movidoEm: agora(), ...extras });
  b.set(db.collection(COL).doc(numero).collection('eventos').doc(id), { pedido: numero, de: atual.coluna, para, acao: 'MARCAR_SEPARADO', versao: v, em: TS(), por: uid, origem: 'teste', ...evento });
  return b.commit();
}

describe('RULES — transições permitidas (via núcleo, como a página nova)', () => {
  test('ALLOW ag→se→pr→de (funcionário com módulo)', async () => {
    await semearPedido('1000001', 'ag');
    await assertSucceeds(acao(U.func, '1000001', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' }));
    await assertSucceeds(acao(U.func, '1000001', 'MARCAR_SEPARADO', 'se'));
    await assertSucceeds(acao(U.func, '1000001', 'DESPACHAR', 'pr', { envio: 'rota-manha' }));
    expect((await ler('1000001')).coluna).toBe('de');
  });
  test('ALLOW cancelar a partir de ag, se e pr', async () => {
    for (const [n, col] of [['1000011', 'ag'], ['1000012', 'se'], ['1000013', 'pr']]) { await semearPedido(n, col); await assertSucceeds(acao(U.func, n, 'CANCELAR', col)); expect((await ler(n)).coluna).toBe('cancelado'); }
  });
  test('ALLOW reabrir (de→ag) só por gestor com motivo', async () => {
    await semearPedido('1000021', 'de');
    await assertSucceeds(acao(U.gestor, '1000021', 'REABRIR', 'de', { motivo: 'cliente devolveu' }, 'gestor'));
    const d = await ler('1000021'); expect(d).toMatchObject({ coluna: 'ag', envio: null, saidaEm: null }); expect(d.reabertura).toMatchObject({ motivo: 'cliente devolveu', por: U.gestor });
  });
});

describe('RULES — transições proibidas (escrita crua com protocolo "válido": quem barra é o servidor)', () => {
  test.each([
    ['ag', 'pr', {}], ['ag', 'de', { envio: 'retirada', saidaEm: Date.now() }], ['se', 'de', { envio: 'retirada', saidaEm: Date.now() }],
    ['se', 'ag', {}], ['pr', 'se', {}], ['pr', 'ag', {}],
    ['de', 'pr', {}], ['de', 'se', {}], ['de', 'cancelado', { canceladoEm: Date.now() }],
    ['cancelado', 'ag', {}], ['cancelado', 'se', {}], ['cancelado', 'pr', {}], ['cancelado', 'de', { saidaEm: Date.now() }],
  ])('DENY %s → %s', async (de, para, extras) => {
    await semearPedido('1000100', de);
    await assertFails(transicaoCrua(U.gestor, '1000100', para, extras));
    expect((await ler('1000100')).coluna).toBe(de); expect(await eventos('1000100')).toHaveLength(0);
  });
  test('DENY reabrir por funcionário; DENY reabrir sem motivo; DENY despachado→aguardando comum', async () => {
    await semearPedido('1000101', 'de');
    const reab = m => ({ envio: null, saidaEm: null, ingresadoEm: Date.now(), reabertura: { motivo: m, por: U.func, em: TS() } });
    await assertFails(transicaoCrua(U.func, '1000101', 'ag', reab('cliente devolveu'), { evento: { acao: 'REABRIR', motivo: 'cliente devolveu' } }));
    await assertFails(transicaoCrua(U.gestor, '1000101', 'ag', { envio: null, saidaEm: null, ingresadoEm: Date.now(), reabertura: { motivo: 'x', por: U.gestor, em: TS() } }, { evento: { acao: 'REABRIR' } }));
    await assertFails(transicaoCrua(U.gestor, '1000101', 'ag', {}));
    expect((await ler('1000101')).coluna).toBe('de');
  });
  test('DENY envio fora da lista; DENY horário do navegador fora de ±10 min; DENY campo extra na transição', async () => {
    await semearPedido('1000102', 'ag');
    await assertFails(transicaoCrua(U.func, '1000102', 'se', { envio: 'drone' }, { evento: { acao: 'INICIAR_SEPARACAO' } }));
    await assertFails(transicaoCrua(U.func, '1000102', 'se', { envio: 'retirada', movidoEm: Date.now() - 3600e3 }, { evento: { acao: 'INICIAR_SEPARACAO' } }));
    await assertFails(transicaoCrua(U.func, '1000102', 'se', { envio: 'retirada', cliente: 'trocado' }, { evento: { acao: 'INICIAR_SEPARACAO' } }));
    expect((await ler('1000102')).coluna).toBe('ag');
  });
  test('sem acesso ao módulo: não lê, não cria, não transiciona', async () => {
    await semearPedido('1000103', 'ag');
    for (const uid of [U.semMod, U.outroMod, null]) {
      await assertFails(fs(uid).collection(COL).doc('1000103').get());
      await assertFails(fs(uid).collection(COL).doc('1000999').set(base('1000999', 'ag')));
    }
    await assertFails(acao(U.outroMod, '1000103', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' }));
  });
});

describe('RULES — compare-and-set e evento obrigatório/imutável', () => {
  test('DENY versão errada (não é atual+1); DENY sem evento; DENY evento com de/para falsos', async () => {
    await semearPedido('1000200', 'se', { versao: 4 });
    await assertFails(transicaoCrua(U.func, '1000200', 'pr', {}, { versao: 4 }));
    await assertFails(transicaoCrua(U.func, '1000200', 'pr', {}, { versao: 6 }));
    await assertFails(fs(U.func).collection(COL).doc('1000200').update({ coluna: 'pr', versao: 5, ultimoEventoId: 'v5', atualizadoEm: TS(), atualizadoPor: U.func, movidoEm: agora() }));
    await assertFails(transicaoCrua(U.func, '1000200', 'pr', {}, { evento: { de: 'ag' } }));
    await assertFails(transicaoCrua(U.func, '1000200', 'pr', {}, { evento: { para: 'de' } }));
    await assertFails(transicaoCrua(U.func, '1000200', 'pr', {}, { evento: { por: 'outro-uid' } }));
    expect((await ler('1000200')).coluna).toBe('se');
  });
  test('eventos: não podem ser alterados, apagados nem criados avulsos; pedido não pode ser apagado', async () => {
    await semearPedido('1000201', 'ag');
    await acao(U.func, '1000201', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' });
    const ev = fs(U.gestor).collection(COL).doc('1000201').collection('eventos');
    await assertFails(ev.doc('v1').update({ para: 'de' }));
    await assertFails(ev.doc('v1').delete());
    await assertFails(ev.doc('v9').set({ pedido: '1000201', de: 'se', para: 'pr', acao: 'MARCAR_SEPARADO', versao: 9, em: TS(), por: U.gestor, origem: 'x' }));
    await assertFails(fs(U.gestor).collection(COL).doc('1000201').delete());
    await assertSucceeds(ev.doc('v1').get());
  });
});

describe('CLIENTE ANTIGO (payloads exatos da página em produção) — LEGACY_CLIENT_REGRESSION_BLOCKED', () => {
  // mover(): setDoc(merge) {coluna, movidoEm, envio, saidaEm} · confirmarCancel: merge {coluna:'cancelado', canceladoEm}
  // confirmarReabrir: merge {coluna:'ag', saidaEm:null, envio:null, ingresadoEm, movidoEm} · fetchPedidos: setDoc(novo) SEM merge
  const merge = (uid, n, d) => fs(uid).collection(COL).doc(n).set(d, { merge: true });
  test('aba antiga NÃO regride: de→se, de→pr, pr→ag (criação tardia), de→ag (reabrir antigo)', async () => {
    await semearPedido('1000300', 'de');
    await assertFails(merge(U.func, '1000300', { coluna: 'se', movidoEm: agora(), envio: 'retirada', saidaEm: null }));
    await assertFails(merge(U.func, '1000300', { coluna: 'pr', movidoEm: agora(), envio: 'retirada', saidaEm: null }));
    await assertFails(merge(U.gestor, '1000300', { coluna: 'ag', saidaEm: null, envio: null, ingresadoEm: agora(), movidoEm: agora() }));
    await semearPedido('1000301', 'pr');
    await assertFails(fs(U.func).collection(COL).doc('1000301').set(base('1000301', 'ag', { ingresadoEm: agora(), movidoEm: agora() })));   // setDoc sem merge
    expect((await ler('1000300')).coluna).toBe('de'); expect((await ler('1000301')).coluna).toBe('pr');
  });
  test('aba antiga não consegue NENHUMA escrita de status sem o protocolo (nem avanço "válido", nem cancelar)', async () => {
    await semearPedido('1000302', 'se');
    await assertFails(merge(U.func, '1000302', { coluna: 'pr', movidoEm: agora(), envio: 'retirada', saidaEm: null }));
    await assertFails(merge(U.func, '1000302', { coluna: 'cancelado', canceladoEm: agora() }));
    await assertFails(merge(U.func, '1000302', { envio: 'rota-tarde' }));   // nem campo avulso
    expect(await ler('1000302')).toMatchObject({ coluna: 'se', envio: 'retirada' });
  });
  test('aba antiga ainda pode CRIAR pedido inexistente em "ag" (compatível; nunca sobrescreve)', async () => {
    await assertSucceeds(fs(U.func).collection(COL).doc('1000303').set(base('1000303', 'ag', { ingresadoEm: agora(), movidoEm: agora() })));
    await assertFails(fs(U.func).collection(COL).doc('1000304').set(base('1000304', 'se')));   // criação fora de 'ag'
    await assertFails(fs(U.func).collection(COL).doc('1000305').set({ ...base('1000305', 'ag'), extra: 1 }));
    await assertFails(fs(U.func).collection(COL).doc('1000306').set(base('1000307', 'ag')));   // numero ≠ id
  });
});

describe('DUAS TELAS e ESTADO TERMINAL', () => {
  test('STALE_TWO_CLIENT: A vê "se"; B leva a pr → de; A tenta se→pr → REJECTED_STALE_STATE, banco segue "de"', async () => {
    await semearPedido('1000400', 'se');
    const telaA = { coluna: (await fs(U.func).collection(COL).doc('1000400').get()).data().coluna };   // A carregou 'se'
    await acao(U.gestor, '1000400', 'MARCAR_SEPARADO', 'se');
    await acao(U.gestor, '1000400', 'DESPACHAR', 'pr', { envio: 'rota-tarde' });
    await expect(acao(U.func, '1000400', 'MARCAR_SEPARADO', telaA.coluna)).rejects.toMatchObject({ codigo: 'STALE_STATE', atual: expect.objectContaining({ coluna: 'de' }) });
    expect((await ler('1000400')).coluna).toBe('de');
    expect((await eventos('1000400')).map(e => e.id).sort()).toEqual(['v1', 'v2']);
  });
  test('TERMINAL: despachado → separando / pronto / aguardando negados (núcleo e servidor)', async () => {
    await semearPedido('1000401', 'de');
    for (const [a, d] of [['INICIAR_SEPARACAO', { envio: 'retirada' }], ['MARCAR_SEPARADO', {}], ['DESPACHAR', { envio: 'retirada' }], ['CANCELAR', {}]]) await expect(acao(U.gestor, '1000401', a, 'de', d)).rejects.toMatchObject({ codigo: 'TRANSICAO_INVALIDA' });
    for (const para of ['se', 'pr', 'ag']) await assertFails(transicaoCrua(U.gestor, '1000401', para, {}));
    expect((await ler('1000401')).coluna).toBe('de'); expect(await eventos('1000401')).toHaveLength(0);
  });
  test('cancelado não ressuscita por tela antiga nem pela nova', async () => {
    await semearPedido('1000402', 'cancelado', { canceladoEm: agora() });
    await expect(acao(U.func, '1000402', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' })).rejects.toMatchObject({ codigo: 'STALE_STATE' });
    await assertFails(fs(U.func).collection(COL).doc('1000402').set({ coluna: 'ag' }, { merge: true }));
    await assertFails(fs(U.func).collection(COL).doc('1000402').set(base('1000402', 'ag')));
    expect((await ler('1000402')).coluna).toBe('cancelado');
  });
});

describe('CRIAÇÃO CONCORRENTE e SYNC CENTRAL', () => {
  const leitorFalso = vendas => ({ chamadas: () => 1, vendas: async () => vendas });
  const venda = codigo => ({ id: '9' + codigo + '00', codigo, data: '2026-09-29', data_hora: '2026-09-29 09:15:00', nome_cliente: 'Cliente Sintético', nome_vendedor: 'V', valor_total: '10.00', produtos: [{ produto: { produto_id: '1' } }] });
  const dto = require('../index.js')._gcOperacoes.LISTAR_VENDAS.dto;
  test('CONCURRENT_CREATE: A cria e avança para "se"; B (atrasada) tenta criar "ag" → não sobrescreve; final "se"', async () => {
    await assertSucceeds(fs(U.func).collection(COL).doc('1000500').set(base('1000500', 'ag', { ingresadoEm: agora(), movidoEm: agora() })));   // A cria
    await acao(U.func, '1000500', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' });                                                         // A avança
    await assertFails(fs(U.gestor).collection(COL).doc('1000500').set(base('1000500', 'ag', { ingresadoEm: agora(), movidoEm: agora() })));  // B atrasada
    const r = await SYNC.sincronizar({ db: adm, leitor: leitorFalso([venda('1000500')]), dto, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() });   // sync central também tenta
    expect(r).toMatchObject({ criados: 0, existentes: 1 });
    expect((await ler('1000500')).coluna).toBe('se');
  });
  test('sync central: identidade = codigo (não o id de 9 dígitos); cria só o inexistente; 2ª execução não cria nada; nunca sobrescreve', async () => {
    await semearPedido('1000601', 'pr');
    const ts = () => admin.firestore.FieldValue.serverTimestamp();
    const r1 = await SYNC.sincronizar({ db: adm, leitor: leitorFalso([venda('1000600'), venda('1000601')]), dto, serverTimestamp: ts });
    expect(r1).toMatchObject({ criados: 1, existentes: 1, vendas_vistas: 2 });
    const novo = await ler('1000600'); expect(novo).toMatchObject({ numero: '1000600', coluna: 'ag', versao: 0, ultimoEventoId: 'v0', origem: 'sync', hora: '09:15', itens: 1 });
    expect(await ler('900')).toBeNull(); expect(await ler('9100060000')).toBeNull();
    expect((await eventos('1000600')).map(e => e.id)).toEqual(['v0']);
    expect((await ler('1000601')).coluna).toBe('pr');
    const r2 = await SYNC.sincronizar({ db: adm, leitor: leitorFalso([venda('1000600'), venda('1000601')]), dto, serverTimestamp: ts });
    expect(r2.criados).toBe(0);
    // o pedido criado pelo sync segue o fluxo normal pela tela nova (versão 0 → v1)
    await assertSucceeds(acao(U.func, '1000600', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' }));
    expect((await eventos('1000600')).map(e => e.id).sort()).toEqual(['v0', 'v1']);
    let estado; await env.withSecurityRulesDisabled(async c => { estado = (await c.firestore().collection('expedicao_sync').doc('estado').get()).data(); });
    expect(estado).toMatchObject({ vendas_vistas: 2, criados: 0 }); expect(typeof estado.ultima_ok_ms).toBe('number');
    await assertSucceeds(fs(U.func).collection('expedicao_sync').doc('estado').get());
    await assertFails(fs(U.gestor).collection('expedicao_sync').doc('estado').set({ x: 1 }));
    await assertFails(fs(U.semMod).collection('expedicao_sync').doc('estado').get());
  });
  test('leitor GC do sync: só GET em /vendas no host oficial', async () => {
    const chamadas = []; const l = SYNC.criarLeitorVendas({ accessToken: 'a', secretToken: 's', fetchImpl: async (u, o) => { chamadas.push([u, o.method]); return { ok: true, json: async () => ({ data: [], meta: { total_paginas: 1 } }) }; } });
    await l.vendas('2026-09-27', '2026-09-29');
    expect(chamadas).toHaveLength(1); expect(chamadas[0][1]).toBe('GET'); expect(chamadas[0][0]).toMatch(/^https:\/\/api\.gestaoclick\.com\/vendas\?/);
    expect(() => SYNC.criarLeitorVendas({ accessToken: '', secretToken: '' })).toThrow('SECRETS_GC_AUSENTES');
  });
});

describe('AUDITORIA e FALHA DE ESCRITA', () => {
  test('AUDIT_EVENT_EXACTLY_ONCE: N transições válidas = N eventos (v1..vN, dados corretos); recusas = 0 eventos', async () => {
    await semearPedido('1000700', 'ag');
    await acao(U.func, '1000700', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' });
    await expect(acao(U.func, '1000700', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' })).rejects.toMatchObject({ codigo: 'STALE_STATE' });   // repetição
    await acao(U.func, '1000700', 'MARCAR_SEPARADO', 'se');
    await assertFails(transicaoCrua(U.func, '1000700', 'ag', {}));
    await acao(U.gestor, '1000700', 'DESPACHAR', 'pr', { envio: 'rota-manha' });
    const ev = (await eventos('1000700')).sort((a, b) => a.versao - b.versao);
    expect(ev.map(e => [e.id, e.de, e.para, e.acao, e.por])).toEqual([['v1', 'ag', 'se', 'INICIAR_SEPARACAO', U.func], ['v2', 'se', 'pr', 'MARCAR_SEPARADO', U.func], ['v3', 'pr', 'de', 'DESPACHAR', U.gestor]]);
    for (const e of ev) expect(e.em).toBeInstanceOf(firebase.firestore.Timestamp);   // horário do servidor
    const d = await ler('1000700'); expect(d).toMatchObject({ versao: 3, ultimoEventoId: 'v3', atualizadoPor: U.gestor }); expect(d.atualizadoEm).toBeInstanceOf(firebase.firestore.Timestamp);
    expect(Object.keys(ev[0]).sort()).toEqual(['acao', 'de', 'em', 'id', 'origem', 'para', 'pedido', 'por', 'versao']);   // sem dados de cliente
  });
  test('WRITE FAILURE: falha dentro da transação (rede/permissão) → banco igual, nenhum evento', async () => {
    await semearPedido('1000800', 'se', { versao: 2 });
    const antes = await ler('1000800');
    const dbF = fs(U.func);
    const falhaRede = { transacao: fn => dbF.runTransaction(async t => { await fn({ ler: async n => (await t.get(dbF.collection(COL).doc(n))).data(), atualizar: (n, c) => t.update(dbF.collection(COL).doc(n), c), criarEvento: (n, id, d) => t.set(dbF.collection(COL).doc(n).collection('eventos').doc(id), d) }); throw new Error('unavailable (rede simulada)'); }) };
    await expect(C.executarAcao(falhaRede, '1000800', 'MARCAR_SEPARADO', 'se', {}, ctxDe(U.func))).rejects.toThrow(/unavailable/);
    await expect(acao(U.semMod, '1000800', 'MARCAR_SEPARADO', 'se')).rejects.toBeTruthy();   // sem permissão
    expect(await ler('1000800')).toEqual(antes); expect(await eventos('1000800')).toHaveLength(0);
  });
});

describe('DESEMPENHO — escopo dos listeners × coleção inteira (fixture no tamanho de produção)', () => {
  test('abertura: listeners trazem só ativos + despachados de hoje; a tela antiga leria a coleção inteira', async () => {
    const hoje0 = C.inicioDoDiaFortaleza(Date.now());
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore(); let b = db.batch(), n = 0;
      const put = async (id, d) => { b.set(db.collection(COL).doc(id), d); if (++n % 400 === 0) { await b.commit(); b = db.batch(); } };
      for (let i = 0; i < 2461; i++) await put('2' + String(i).padStart(6, '0'), base('2' + String(i).padStart(6, '0'), 'de', { saidaEm: hoje0 - (1 + i) * 3600e3 }));   // histórico
      for (let i = 0; i < 341; i++) await put('3' + String(i).padStart(6, '0'), base('3' + String(i).padStart(6, '0'), 'cancelado', { canceladoEm: hoje0 - i * 3600e3 }));
      for (let i = 0; i < 25; i++) await put('4' + String(i).padStart(6, '0'), base('4' + String(i).padStart(6, '0'), ['ag', 'se', 'pr'][i % 3]));
      for (let i = 0; i < 14; i++) await put('5' + String(i).padStart(6, '0'), base('5' + String(i).padStart(6, '0'), 'de', { saidaEm: hoje0 + 60e3 * (i + 1) }));
      await b.commit();
    });
    const db = fs(U.func);
    const ouvir = q => new Promise((res, rej) => { const u = q.onSnapshot(s => { u(); res(s); }, rej); });
    const [a, h] = await Promise.all([ouvir(db.collection(COL).where('coluna', 'in', ['ag', 'se', 'pr'])), ouvir(db.collection(COL).where('saidaEm', '>=', hoje0))]);
    const tudo = await db.collection(COL).get();   // o que a tela ANTIGA fazia a cada abertura
    const bytes = s => s.docs.reduce((t, d) => t + Buffer.byteLength(JSON.stringify(d.data())), 0);
    const r = { antiga_docs: tudo.size, antiga_bytes: bytes(tudo), rc_docs: a.size + h.size, rc_bytes: bytes(a) + bytes(h), ativos: a.size, despachados_hoje: h.size };
    console.log('DESEMPENHO_EXPEDICAO ' + JSON.stringify(r));
    expect(r.antiga_docs).toBe(2841); expect(r.ativos).toBe(25); expect(r.despachados_hoje).toBe(14); expect(r.rc_docs).toBe(39);
    expect(r.rc_bytes * 50).toBeLessThan(r.antiga_bytes);
  }, 120000);
});

describe('ABA ANTIGA REAL (script de produção ff8981a) contra as Rules novas — OLD_TAB_PROTECTION', () => {
  const vm = require('vm');
  const LEGADO = require('fs').readFileSync(resolve(__dirname, 'fixtures/expedicao-pagina-legada-ff8981a.js'), 'utf8');
  function el() { return { textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {} }; }
  function abaAntiga(uid, { vendas = [], getOneForcaNull = false } = {}) {
    const db = fs(uid), erros = [];
    const ctx = { console: { log() {}, warn() {} }, Date, Number, String, Object, Math, JSON, Promise, Set, Array, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
      document: { getElementById: () => el(), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => el() } };
    ctx.window = ctx;
    ctx._fsGetAll = async c => (await db.collection(c).get()).docs.map(d => d.data());
    ctx._fsGetOne = async (c, id) => { if (getOneForcaNull) return null; const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
    // objetos da sandbox vêm de outro realm: clona (JSON preserva null) antes de entregar ao SDK
    ctx._fsSet = async (c, id, data, opts) => { try { await db.collection(c).doc(String(id)).set(JSON.parse(JSON.stringify(data)), opts && opts.merge ? { merge: true } : {}); } catch (e) { erros.push(e.code || e.message); throw e; } };
    ctx._gcQuery = async () => ({ data: { data: vendas, meta: { total_paginas: 1 } } });
    vm.createContext(ctx); vm.runInContext(LEGADO + '\n;globalThis.__S = S; globalThis.__fetch = fetchPedidos;', ctx);
    return { ctx, erros, abrir: () => ctx.iniciarPainel(), buscar: () => ctx.__fetch() };
  }
  const tentar = p => p.then(() => 'ok', e => 'rejeitado');
  test('tela desatualizada ANTIGA: carregou "se"; outra tela despacha; a antiga clica "Marcar Separado" → servidor recusa, pedido segue "de"', async () => {
    await semearPedido('1000900', 'se', { envio: 'retirada' });
    const A = abaAntiga(U.func); await A.abrir();
    expect(A.ctx.__S.pedidos['1000900'].coluna).toBe('se');
    await acao(U.gestor, '1000900', 'MARCAR_SEPARADO', 'se'); await acao(U.gestor, '1000900', 'DESPACHAR', 'pr', { envio: 'rota-tarde' });
    expect(await tentar(A.ctx.marcarSeparado('1000900'))).toBe('rejeitado');
    A.ctx.iniciarSeparacao('1000900'); A.ctx.__S.envioSel = 'retirada'; expect(await tentar(A.ctx.confirmarModal())).toBe('rejeitado');
    expect(A.erros.every(e => e === 'permission-denied')).toBe(true); expect(A.erros.length).toBe(2);
    expect(await ler('1000900')).toMatchObject({ coluna: 'de', envio: 'rota-tarde' });
    expect((await eventos('1000900')).map(e => e.id).sort()).toEqual(['v1', 'v2']);
  });
  test('criação tardia ANTIGA (leu "não existe" antes; o pedido já está em "pr") → setDoc sem merge recusado', async () => {
    const B = abaAntiga(U.func, { vendas: [], getOneForcaNull: true });
    await B.abrir(); await new Promise(r => setImmediate(r));                        // aba antiga abriu sem o pedido
    await semearPedido('1000901', 'pr', { envio: 'retirada' });                       // outra tela criou e avançou até "pr"
    B.ctx._gcQuery = async () => ({ data: { data: [{ numero: '1000901', data: '2026-09-29', hora: '09:00', cliente: 'C', vendedor: 'V', valor: 1, itens: 1, cidade: '' }], meta: { total_paginas: 1 } } });
    await B.buscar();                                                                 // leu "não existe" (antes) → setDoc sem merge
    expect(B.erros).toContain('permission-denied');
    expect((await ler('1000901')).coluna).toBe('pr');
  });
  test('reabrir e cancelar ANTIGOS (merge sem protocolo) → recusados', async () => {
    await semearPedido('1000902', 'de'); await semearPedido('1000903', 'se', { envio: 'retirada' });
    const G = abaAntiga(U.gestor); await G.abrir();
    G.ctx.abrirReabrirModal('1000902'); expect(await tentar(G.ctx.confirmarReabrir())).toBe('rejeitado');
    G.ctx.abrirCancelModal('1000903'); expect(await tentar(G.ctx.confirmarCancel())).toBe('rejeitado');
    expect((await ler('1000902')).coluna).toBe('de'); expect((await ler('1000903')).coluna).toBe('se');
  });
  test('aba antiga ainda cria pedido NOVO inexistente (sem sobrescrever nada) — compatibilidade durante a transição', async () => {
    const B2 = abaAntiga(U.gestor, { vendas: [], getOneForcaNull: true }); await B2.abrir(); await new Promise(r => setImmediate(r));   // 2ª aba antiga já aberta, sem o pedido
    const B = abaAntiga(U.func, { vendas: [{ numero: '1000904', data: '2026-09-29', hora: '09:00', cliente: 'C', vendedor: 'V', valor: 1, itens: 1, cidade: '' }] });
    await B.abrir();                                   // iniciarPainel() já dispara fetchPedidos() uma vez
    for (let i = 0; i < 60 && !(await ler('1000904')); i++) await new Promise(r => setTimeout(r, 50));
    expect(B.erros).toEqual([]); expect((await ler('1000904')).coluna).toBe('ag');
    // uma 2ª aba antiga que também "viu" o pedido como inexistente: a gravação dela chega como update → recusada
    B2.ctx._gcQuery = async () => ({ data: { data: [{ numero: '1000904', data: '2026-09-29', hora: '10:00', cliente: 'C2', vendedor: 'V2', valor: 2, itens: 2, cidade: '' }], meta: { total_paginas: 1 } } });
    await B2.buscar();
    expect(B2.erros).toEqual(['permission-denied']); expect(await ler('1000904')).toMatchObject({ coluna: 'ag', hora: '09:00', cliente: 'C' });
  });
});
