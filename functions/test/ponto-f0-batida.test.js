'use strict';
// PONTO MR4 2.0 — Fase 0 · P0-01 — batida idempotente por intenção. EMULADOR (localhost:8080). PROD_WRITES=0.
// Invariante: ONE_INTENT = ONE_PUNCH. Nova batida legítima (intenção nova e coerente) continua funcionando.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';
process.env.PONTO_COOLDOWN_MS       = '0';            // sequência rápida nos testes; o cooldown é testado à parte

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const { _registrarPontoHandler: bater } = require('../index');
const PB = require('../lib/pontoBatida');
jest.setTimeout(60000);

const UID = 'uid-f0-func', FUNC = 'func-f0-001';
const GPS = { lat: -3.7603154, lng: -38.5634329 };
const req = (data = {}) => ({ auth: { uid: UID, token: {} }, data: { ...GPS, ...data } });
let n = 0; const rid = () => 'f0req' + String(++n).padStart(4, '0') + Math.random().toString(36).slice(2, 8);
const intencao = (tipoEsperado, requestId = rid()) => ({ requestId, tipoEsperado });
const resultado = p => p.then(r => ({ ok: true, ...r }), e => ({ ok: false, code: e.code, codigo: e.details && e.details.codigo, msg: e.message, details: e.details }));

async function limpar() {
  const s = await db.collection('registros').where('funcId', '==', FUNC).get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit();
}
async function batidasDeHoje() {
  const s = await db.collection('registros').where('funcId', '==', FUNC).get();
  const ms = v => (v && v.toMillis ? v.toMillis() : 0);
  return s.docs.map(d => d.data()).sort((a, b) => (a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : ms(a.criadoEm) - ms(b.criadoEm)));   // mesmo desempate do servidor
}
beforeAll(async () => {
  await db.doc('users/' + UID).set({ role: 'funcionario', ativo: true, funcionarioId: FUNC, nome: 'Func F0' });
  await db.doc('funcionarios/' + FUNC).set({ nome: 'Func F0', cargo: 'Teste', modalidade: 'PRESENCIAL' });
});
beforeEach(async () => { process.env.PONTO_COOLDOWN_MS = '0'; await limpar(); });
afterAll(async () => { await limpar(); await db.doc('users/' + UID).delete(); await db.doc('funcionarios/' + FUNC).delete(); });

describe('Fluxo normal com intenção', () => {
  test('NORMAL_ENTRY / NORMAL_LUNCH_EXIT / NORMAL_LUNCH_RETURN / NORMAL_EXIT: 4 intenções coerentes = 4 batidas na ordem', async () => {
    for (const t of PB.TIPOS) {
      const r = await bater(req(intencao(t)));
      expect(r).toMatchObject({ ok: true, status: 'REGISTRADO', tipo: t });
    }
    const regs = await batidasDeHoje();
    expect(regs.map(r => r.tipo)).toEqual(['entrada', 'saida_almoco', 'retorno_almoco', 'saida']);
    expect(regs.every(r => PB.REQUEST_ID_RE.test(r.requestId) && r.tipoEsperado === r.tipo)).toBe(true);
    expect((await resultado(bater(req(intencao('saida'))))).code).toBe('failed-precondition');   // dia completo
  });
});

describe('Duplicidades: ONE_INTENT = ONE_PUNCH', () => {
  test('DOUBLE_CLICK: a mesma intenção 2× em sequência → 1 batida; a 2ª devolve JA_PROCESSADO com o mesmo resultado', async () => {
    const i = intencao('entrada');
    const a = await bater(req(i)); const b = await bater(req(i));
    expect(a.status).toBe('REGISTRADO'); expect(b.status).toBe('JA_PROCESSADO');
    expect([b.id, b.tipo, b.hora, b.data]).toEqual([a.id, a.tipo, a.hora, a.data]);
    expect(await batidasDeHoje()).toHaveLength(1);
  });
  test('FIVE_SIMULTANEOUS_REQUESTS: 5 envios simultâneos da mesma intenção → exatamente 1 batida (entrada), nunca saída do almoço', async () => {
    const i = intencao('entrada');
    const rs = await Promise.all(Array.from({ length: 5 }, () => resultado(bater(req(i)))));
    const regs = await batidasDeHoje();
    expect(regs.map(r => r.tipo)).toEqual(['entrada']);
    expect(rs.filter(r => r.ok && r.status === 'REGISTRADO')).toHaveLength(1);
    rs.filter(r => r.ok).forEach(r => expect(r.tipo).toBe('entrada'));
    rs.filter(r => !r.ok).forEach(r => expect(['already-exists', 'aborted']).toContain(r.code));   // nunca avançou de tipo
  });
  test('SAME_INTENT_RETRY: retry da mesma intenção depois que a batida seguinte já existe continua devolvendo a 1ª batida', async () => {
    const i1 = intencao('entrada');
    await bater(req(i1));
    await bater(req(intencao('saida_almoco')));
    const again = await bater(req(i1));
    expect(again).toMatchObject({ status: 'JA_PROCESSADO', tipo: 'entrada' });
    expect((await batidasDeHoje()).map(r => r.tipo)).toEqual(['entrada', 'saida_almoco']);
  });
  test('TIMEOUT_RETRY: o servidor gravou mas a resposta se perdeu; o cliente reenvia a MESMA intenção → JA_PROCESSADO (sem 2ª batida)', async () => {
    const i = intencao('entrada');
    await bater(req(i));                                    // "resposta perdida": cliente não viu
    const retry = await bater(req(i));
    expect(retry.status).toBe('JA_PROCESSADO');
    expect(await batidasDeHoje()).toHaveLength(1);
  });
  test('REFRESH_AFTER_SUBMIT: após recarregar, a tela velha (tipoEsperado=entrada) é recusada com o estado real; a intenção recalculada funciona', async () => {
    await bater(req(intencao('entrada')));
    const velha = await resultado(bater(req(intencao('entrada'))));        // nova intenção com estado velho
    expect(velha).toMatchObject({ ok: false, code: 'failed-precondition', codigo: 'TIPO_ESPERADO_DIVERGENTE' });
    expect(velha.details).toMatchObject({ esperado: 'entrada', proximo: 'saida_almoco', ultimo: { tipo: 'entrada' } });
    expect((await bater(req(intencao('saida_almoco')))).tipo).toBe('saida_almoco');
    expect((await batidasDeHoje()).map(r => r.tipo)).toEqual(['entrada', 'saida_almoco']);
  });
  test('TWO_TABS: duas abas, intenções diferentes para o mesmo tipo, ao mesmo tempo → 1 batida; a outra aba recebe recusa (não avança)', async () => {
    const rs = await Promise.all([resultado(bater(req(intencao('entrada')))), resultado(bater(req(intencao('entrada'))))]);
    expect(rs.filter(r => r.ok)).toHaveLength(1);
    expect(['TIPO_ESPERADO_DIVERGENTE', 'JA_REGISTRADO', undefined]).toContain(rs.find(r => !r.ok).codigo);
    expect((await batidasDeHoje()).map(r => r.tipo)).toEqual(['entrada']);
  });
  test('TWO_DEVICES: celular bate a entrada; o computador (tela aberta antes) tenta "entrada" depois → recusado com estado atual', async () => {
    await bater(req(intencao('entrada')));
    const pc = await resultado(bater(req(intencao('entrada'))));
    expect(pc.codigo).toBe('TIPO_ESPERADO_DIVERGENTE');
    expect(await batidasDeHoje()).toHaveLength(1);
  });
  test('OUT_OF_ORDER_REQUESTS: "saída do almoço" chega antes da "entrada" → recusada; a entrada entra; nunca 2 estados para 1 intenção', async () => {
    const sa = await resultado(bater(req(intencao('saida_almoco'))));
    expect(sa.codigo).toBe('TIPO_ESPERADO_DIVERGENTE');
    expect((await bater(req(intencao('entrada')))).tipo).toBe('entrada');
    expect((await batidasDeHoje()).map(r => r.tipo)).toEqual(['entrada']);
  });
  test('TRANSACTION_RETRY: 10 intenções distintas simultâneas para "entrada" (transações conflitantes, com retry) → 1 entrada, 0 batidas extras', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => resultado(bater(req(intencao('entrada'))))));
    expect(rs.filter(r => r.ok)).toHaveLength(1);
    expect((await batidasDeHoje()).map(r => r.tipo)).toEqual(['entrada']);
  });
});

describe('Nova batida legítima, cooldown e cliente legado', () => {
  test('NOVA_BATIDA_LEGITIMA: intenção nova e coerente logo após outra batida é aceita (idempotência não bloqueia por tempo)', async () => {
    await bater(req(intencao('entrada')));
    expect((await bater(req(intencao('saida_almoco')))).status).toBe('REGISTRADO');
  });
  test('COOLDOWN: com intenção, nova batida < 10 s é recusada (COOLDOWN); sem intenção (legado) a janela é 60 s', async () => {
    delete process.env.PONTO_COOLDOWN_MS;
    await bater(req(intencao('entrada')));
    const r = await resultado(bater(req(intencao('saida_almoco'))));
    expect(r).toMatchObject({ ok: false, code: 'resource-exhausted', codigo: 'COOLDOWN' });
    // a MESMA intenção reenviada dentro do cooldown continua respondendo JA_PROCESSADO (idempotência vem antes)
    const regs = await batidasDeHoje();
    expect((await bater(req({ requestId: regs[0].requestId, tipoEsperado: 'entrada' }))).status).toBe('JA_PROCESSADO');
    expect(PB.COOLDOWN_COM_INTENCAO_MS).toBe(10000); expect(PB.COOLDOWN_LEGADO_MS).toBe(60000);
  });
  test('LEGADO: cliente antigo sem requestId/tipoEsperado continua registrando na sequência (compatibilidade na transição)', async () => {
    const a = await bater(req({})); const b = await bater(req({}));
    expect([a.tipo, b.tipo]).toEqual(['entrada', 'saida_almoco']);
    expect(a.status).toBe('REGISTRADO');
  });
  test('VALIDAÇÃO: requestId malformado ou tipoEsperado desconhecido → invalid-argument, nada gravado', async () => {
    expect((await resultado(bater(req({ requestId: 'x', tipoEsperado: 'entrada' })))).code).toBe('invalid-argument');
    expect((await resultado(bater(req({ requestId: rid(), tipoEsperado: 'almoco' })))).code).toBe('invalid-argument');
    expect(await batidasDeHoje()).toHaveLength(0);
  });
  test('CORREÇÃO NA SEQUÊNCIA: registro substituído por correção não conta para a próxima batida', async () => {
    await bater(req(intencao('entrada')));
    const [orig] = await batidasDeHoje();
    await db.doc('registros/' + orig.id).update({ substituidoPor: 'corr_x' });
    const corr = { ...orig, id: 'corr_x', hora: '08:00:00', lancadoPorJustificativa: true, requestId: null }; delete corr.substituidoPor;
    await db.doc('registros/corr_x').set(corr);
    expect((await bater(req(intencao('saida_almoco')))).tipo).toBe('saida_almoco');
    await db.doc('registros/corr_x').delete();
  });
});
