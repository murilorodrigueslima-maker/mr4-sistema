'use strict';
/**
 * PONTO INTEGRIDADE E1 — Rules (EMULADOR; dados fictícios). Manipulação DIRETA pelo SDK (sem a tela) por funcionário,
 * gestor, dual-role e administrador.   FIRESTORE_EMULATOR_HOST=localhost:8310 npx jest --runInBand test/ponto-e1
 */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8310';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('@firebase/firestore');
const { ler } = require('./helpers/ponto-pagina');
const C = require('./helpers/ponto-cenario');
jest.setTimeout(60000);

const [HOST, PORT] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
if (!['localhost', '127.0.0.1'].includes(HOST)) throw new Error('Só roda no emulador local.');
const { G, AD, DR, E, E2, BL, DISPLAY } = C.A_UIDS;
const { F, DIA, MES_FECHADO, NOME } = C;
const GESTAO = [['gestor', G], ['administrador', AD], ['dual-role', DR]];
const TODOS = [...GESTAO, ['funcionário', E]];

let env;
const db = uid => env.authenticatedContext(uid, { email: uid + '@exemplo.test' }).firestore();
const semRegras = fn => env.withSecurityRulesDisabled(async c => fn(c.firestore()));
const doc = async p => { let d; await semRegras(async x => { const s = await x.doc(p).get(); d = s.exists ? s.data() : null; }); return d; };

beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'demo-ponto-e1', firestore: { rules: ler('modulos/firestore.rules'), host: HOST, port: Number(PORT) } }); });
beforeEach(async () => { await env.clearFirestore(); await semRegras(C.semear); });
afterAll(async () => { if (env) { await env.clearFirestore(); await env.cleanup(); } });

describe('Batidas: originais não são criadas, alteradas, ocultadas nem apagadas por NINGUÉM no cliente (D01, D02)', () => {
  const orig = `registros/${F.E}_${DIA}_entrada`;
  test.each(TODOS)('%s', async (_n, uid) => {
    const r = db(uid).doc(orig);
    await assertFails(r.update({ hora: '08:00:00' }));
    await assertFails(r.update({ substituidoPor: 'qualquer' }));
    await assertFails(r.update({ substituidoPor: 'corr_x', substituidoEm: serverTimestamp(), substituidoPorJustificativa: 'x' }));
    await assertFails(r.set({ funcId: F.E, data: DIA, tipo: 'entrada', hora: '07:00:00' }));
    await assertFails(r.delete());
    await assertFails(db(uid).doc(`registros/${F.E}_2026-09-29_entrada`).set({ funcId: F.E, data: '2026-09-29', tipo: 'entrada', hora: '07:00:00', criadoEm: new Date('2020-01-01') }));
    await assertFails(db(uid).doc('registros/corr_falsa').set({ funcId: F.E2, data: DIA, tipo: 'saida', hora: '18:00:00', lancadoPorJustificativa: true }));
    expect(await doc(orig)).toMatchObject({ hora: '08:05:00' });
  });
});

describe('Justificativas (D07–D11)', () => {
  const base = (f, x) => ({ funcId: f, funcNome: NOME[f], data: DIA, motivo: 'Atestado médico', descricao: 'd', status: 'pendente', lancadoPorGestor: false, ...x });
  test.each(TODOS)('%s não reescreve pedido, não decide, não move e não apaga decidida', async (_n, uid) => {
    const p = db(uid).doc('justificativas/j-pend'), a = db(uid).doc('justificativas/j-aprov');
    for (const m of [{ horarioPonto: '19:30' }, { descricao: 'trocado' }, { tipoPonto: null }, { status: 'aprovado' }, { status: 'rejeitado', respondidoPorUid: uid }, { evidenciaGestao: 'x' }]) await assertFails(p.update(m));
    for (const m of [{ motivo: 'Férias' }, { data: '2026-09-30' }, { data: MES_FECHADO + '-10' }, { status: 'pendente' }]) await assertFails(a.update(m));
    await assertFails(a.delete());
    await assertFails(a.set({ ...base(F.E, {}), id: 'j-aprov' }));   // sobrescrever = update
  });
  test.each(GESTAO)('%s: correção de batida não nasce aprovada; não imita pedido do funcionário; sem campos de decisão nem autor falso', async (_n, uid) => {
    const g = id => db(uid).doc('justificativas/' + id);
    const ok = x => base(F.E2, { lancadoPorGestor: true, ...x });
    await assertFails(g('n1').set(ok({ tipoPonto: 'saida', horarioPonto: '18:00', status: 'aprovado' })));
    await assertFails(g('n2').set(base(F.E2)));                                                                  // lancadoPorGestor false
    await assertFails(g('n3').set(ok({ respondidoPorUid: uid })));
    await assertFails(g('n4').set(ok({ registroEfetivoId: 'corr_x', decididaPeloServidor: true })));
    await assertFails(g('n5').set(ok({ lancadoPorUid: 'outra-pessoa' })));
    await assertFails(g('n6').set(ok({ propostoPorUid: 'outra-pessoa' })));
    await assertFails(g('n7').set(ok({ data: '2026-9-1' })));
    await assertFails(g('n8').set(ok({ status: 'rejeitado' })));
    await assertFails(g('n9').set(ok({ data: MES_FECHADO + '-05', funcId: F.E })));                              // mês protegido
    await assertSucceeds(g('ok1').set(ok({ status: 'aprovado', lancadoPorUid: uid })));
    await assertSucceeds(g('ok2').set(ok({ tipoPonto: 'saida', horarioPonto: '18:00', evidenciaGestao: 'câmera' })));
  });
  test('gestão não lança nada sobre o PRÓPRIO ponto (admin e dual-role)', async () => {
    for (const [uid, f] of [[AD, F.AD], [DR, F.DR]]) await assertFails(db(uid).doc('justificativas/auto').set(base(f, { lancadoPorGestor: true, status: 'aprovado' })));
  });
  test('funcionário: só os próprios campos, o próprio nome e a própria identidade', async () => {
    const n = id => db(E).doc('justificativas/' + id);
    for (const x of [{ evidenciaGestao: 'x' }, { registroEfetivoId: 'y' }, { respondidoPorUid: G }, { obsGestor: 'ok' }, { funcNome: 'Outra Pessoa' }, { authUid: E2 }, { status: 'aprovado' },
      { lancadoPorGestor: true }, { id: 'outro-id' }, { tipoPonto: null, campoNovo: 1 }]) await assertFails(n('x').set(base(F.E, x)));
    await assertFails(n('y').set(base(F.E2)));
    await assertFails(n('z').set(base(F.E, { data: MES_FECHADO + '-05' })));
    await assertSucceeds(n('ok').set(base(F.E, { id: 'ok', authUid: E })));
    await assertFails(db(E).doc('justificativas/j-pend').delete());
  });
});

describe('Créditos de jornada (D03, D04)', () => {
  const id = `cred_${F.E}_2026-09-25`;
  const novo = (f, data, x) => ({ id: `cred_${f}_${data}`, funcId: f, funcNome: NOME[f], data, minutos: 480, motivo: 'Atestado médico', criadoEm: data + 'T12:00:00Z', ...x });
  test.each(TODOS)('%s não apaga crédito', async (_n, uid) => { await assertFails(db(uid).doc('creditos_jornada/' + id).delete()); expect(await doc('creditos_jornada/' + id)).toBeTruthy(); });
  test.each(GESTAO)('%s: sem segundo crédito no dia, sem trocar funcionário/data, valores válidos, autor verdadeiro', async (_n, uid) => {
    const c = i => db(uid).doc('creditos_jornada/' + i);
    await assertFails(c('id-livre').set(novo(F.E, '2026-09-25')));
    await assertFails(c(id).update({ funcId: F.E2 }));
    await assertFails(c(id).update({ data: '2026-09-30' }));
    await assertFails(c(id).update({ minutos: -60 }));
    await assertFails(c(id).update({ minutos: 100000 }));
    await assertFails(c(id).update({ minutos: '480' }));
    await assertFails(c(id).update({ motivo: '' }));
    await assertFails(c(id).update({ campoNovo: true }));
    await assertFails(c(id).update({ lancadoPorUid: 'outra-pessoa' }));
    await assertFails(c(`cred_${F.E2}_2026-09-24`).set(novo(F.E2, '2026-09-24', { lancadoPorUid: 'outra-pessoa' })));
    await assertSucceeds(c(`cred_${F.E2}_2026-09-24`).set(novo(F.E2, '2026-09-24')));
  });
  test('funcionário não cria nem altera crédito; admin e dual-role não mexem no próprio', async () => {
    await assertFails(db(E).doc('creditos_jornada/' + id).update({ minutos: 600 }));
    await assertFails(db(E).doc(`creditos_jornada/cred_${F.E}_2026-09-24`).set(novo(F.E, '2026-09-24')));
    for (const [uid, f] of [[AD, F.AD], [DR, F.DR]]) await assertFails(db(uid).doc(`creditos_jornada/cred_${f}_2026-09-24`).set(novo(f, '2026-09-24')));
  });
});

describe('Cadastro (D05, D06)', () => {
  test.each([['administrador', AD, F.AD], ['dual-role', DR, F.DR]])('%s não altera o que muda o próprio ponto, nem apaga o próprio cadastro', async (_n, uid, f) => {
    const r = db(uid).doc('funcionarios/' + f);
    for (const m of [{ jornada: '4' }, { jornada: 4 }, { modalidade: 'HOME_OFFICE' }, { inicioBancoHoras: '2026-09-28' }, { controleBancoHoras: false }, { afastamentoBanco: { inicio: DIA } }, { escalas: [] }, { inativo: true }])
      await assertFails(r.update(m));
    await assertFails(r.delete());
    await assertSucceeds(r.update({ telefone: '(00) 0000-0000', jornada: 8, modalidade: 'PRESENCIAL' }));      // mesmos valores: salvar dados pessoais continua
  });
  test('funcionário não altera o cadastro; outro gestor altera', async () => {
    await assertFails(db(E).doc('funcionarios/' + F.E).update({ jornada: '6' }));
    await assertSucceeds(db(G).doc('funcionarios/' + F.DR).update({ jornada: '6' }));
  });
});

describe('Espelhos (D12–D14)', () => {
  const assinaturaFalsa = { assinado: true, status: 'assinado', assinadoPor: NOME[F.E], assinadoEm: serverTimestamp(), assinaturaImg: 'data:image/png;base64,AAAA', hashAssinado: 'hash-original' };
  test.each(GESTAO.filter(x => x[1] !== DR).concat([['dual-role', DR]]))('%s NÃO assina pelo funcionário', async (_n, uid) => {
    const r = db(uid).doc('espelhos/esp-aberto');
    await assertFails(r.update(assinaturaFalsa));
    for (const k of Object.keys(assinaturaFalsa)) await assertFails(r.update({ [k]: assinaturaFalsa[k] }));
    await assertFails(r.update({ assinadoPorUid: E }));
    await assertFails(db(uid).doc('espelhos/novo-assinado').set({ funcId: F.E, mes: '2026-07', versao: 1, ...assinaturaFalsa }));
    await assertFails(db(uid).doc('espelhos/novo-img').set({ funcId: F.E, mes: '2026-07', versao: 1, assinado: false, assinaturaImg: 'x' }));
  });
  test.each(TODOS)('%s não altera documento assinado, não marca substituído, não apaga versões', async (_n, uid) => {
    const s = db(uid).doc('espelhos/esp-assinado');
    for (const m of [{ snapshot: {} }, { hashSnapshot: 'x' }, { assinado: false }, { assinaturaImg: null }, { substituido: true }, { invalidado: true }, { geradoEm: 'x' }, { mesLabel: 'x' }, { revisaoEmAndamento: true }]) await assertFails(s.update(m));
    await assertFails(s.delete());
    await assertFails(db(uid).doc('espelhos/esp-aberto').delete());
    await assertFails(db(uid).doc('espelhos/esp-aberto').update({ substituido: true }));
  });
  test('snapshot não muda sem o hash mudar', async () => {
    const r = db(G).doc('espelhos/esp-aberto');
    await assertFails(r.update({ snapshot: { totais: { saldo: -999 } } }));
    await assertSucceeds(r.update({ snapshot: { totais: { saldo: -999 }, geradoEm: 'g2' }, hashSnapshot: 'hash-novo' }));
  });
  const v2 = x => ({ id: 'v2', funcId: F.E, mes: MES_FECHADO, versao: 2, versaoAnteriorId: 'esp-assinado', assinado: false, snapshot: { totais: {} }, hashSnapshot: 'h2', motivoRevisao: 'Revisão fictícia', ...x });
  const abre = x => ({ versaoSucessoraId: 'v2', revisaoEmAndamento: true, revisaoAbertaEm: 'agora', motivoRevisao: 'Revisão fictícia', ...x });
  const lote = (uid, novo, antigo) => { const d = db(uid), b = d.batch(); if (novo) b.set(d.doc('espelhos/v2'), novo); if (antigo) b.update(d.doc('espelhos/esp-assinado'), antigo); return b.commit(); };
  test('reabertura exige justificativa, versão nova no mesmo lote, mesmo funcionário e mês', async () => {
    await assertFails(lote(G, null, abre()));                                         // sem v2
    await assertFails(lote(G, v2({ motivoRevisao: '' }), abre()));
    await assertFails(lote(G, v2(), abre({ motivoRevisao: '' })));
    await assertFails(lote(G, v2({ funcId: F.E2 }), abre()));
    await assertFails(lote(G, v2({ mes: '2026-07' }), abre()));
    await assertFails(lote(G, v2({ assinado: true }), abre()));
    await assertFails(lote(G, v2({ versaoAnteriorId: 'esp-aberto' }), abre()));      // anterior não assinada
    await assertSucceeds(lote(G, v2(), abre()));
    expect((await doc('espelhos/esp-assinado')).assinado).toBe(true);
    await assertFails(db(G).doc('espelhos/esp-assinado').update(abre({ motivoRevisao: 'segunda reabertura' })));   // já há revisão aberta
  });
  test('funcionário assina só como ele mesmo, com a hora do servidor', async () => {
    const r = db(E).doc('espelhos/esp-aberto');
    await assertFails(r.update({ ...assinaturaFalsa, assinadoPor: NOME[F.E2] }));
    await assertFails(r.update({ ...assinaturaFalsa, assinadoPorUid: E2 }));
    await assertFails(r.update({ ...assinaturaFalsa, assinadoEm: new Date() }));
    await assertFails(r.update({ ...assinaturaFalsa, assinaturaImg: '' }));
    await assertFails(r.update({ ...assinaturaFalsa, snapshot: {} }));
    await assertFails(db(E2).doc('espelhos/esp-aberto').update(assinaturaFalsa));
    await assertSucceeds(r.update({ ...assinaturaFalsa, assinadoPorUid: E }));
    await assertFails(r.update({ assinaturaImg: 'outra' }));
  });
});

describe('Bloqueio (D15)', () => {
  test('funcionário bloqueado não lê, não justifica e não assina', async () => {
    const f = db(BL);
    await assertFails(f.doc('funcionarios/' + F.BL).get());
    await assertFails(f.collection('registros').where('funcId', '==', F.BL).get());
    await assertFails(f.doc('espelhos/esp-bloq').get());
    await assertFails(f.doc('justificativas/b').set({ funcId: F.BL, data: DIA, motivo: 'Férias', status: 'pendente', lancadoPorGestor: false }));
    await assertFails(f.doc('espelhos/esp-bloq').update({ assinado: true, status: 'assinado', hashAssinado: 'hash-original', assinadoEm: serverTimestamp(), assinadoPor: NOME[F.BL], assinaturaImg: 'x' }));
  });
});

describe('Trilhas e coleções do servidor: nenhum cliente grava; trilha só a gestão lê', () => {
  const COLS = ['ponto_trilha', 'ponto_trilha_blobs', 'ponto_justificativas_decisoes', 'ponto_meses_protegidos', 'banco_horas_lancamentos', 'ponto_pendencias_decisoes', 'ponto_escalas', 'ponto_sabado_correcoes'];
  test.each(TODOS)('%s não grava', async (_n, uid) => {
    for (const c of COLS) { await assertFails(db(uid).doc(c + '/x').set({ funcId: F.E })); await assertFails(db(uid).doc(c + '/x').delete()); }
  });
  test('leitura da trilha', async () => {
    await semRegras(d => d.doc('ponto_trilha/t1').set({ funcId: F.E }));
    for (const uid of [G, AD, DR]) await assertSucceeds(db(uid).doc('ponto_trilha/t1').get());
    for (const uid of [E, BL, DISPLAY]) await assertFails(db(uid).doc('ponto_trilha/t1').get());
  });
  test('anônimo e conta de TV não acessam o ponto', async () => {
    for (const d of [env.unauthenticatedContext().firestore(), db(DISPLAY)]) {
      await assertFails(d.doc('espelhos/esp-aberto').get());
      await assertFails(d.doc('justificativas/x').set({ funcId: F.E, data: DIA, status: 'pendente', lancadoPorGestor: false }));
    }
  });
});
