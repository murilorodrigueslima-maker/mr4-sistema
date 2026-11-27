'use strict';
/**
 * DIAGNÓSTICO TÉCNICO DO PONTO — Firestore Rules (EMULADOR; dados 100% sintéticos; nada de produção).
 *
 * Testes de CARACTERIZAÇÃO:
 *   "CONFIRMADO Dxx" afirma o comportamento ATUAL que consideramos defeito. Passa hoje; ao corrigir, deve falhar e ser
 *   invertido (assertSucceeds → assertFails) junto com a correção.
 *   "CONTROLE" afirma uma proteção que já funciona e não pode regredir.
 * Nenhuma regra trabalhista é avaliada aqui — só quem consegue escrever o quê e com que trilha.
 *
 * Porta padrão 8270 (nunca a 8080). Rodar:
 *   FIRESTORE_EMULATOR_HOST=localhost:8270 npx jest --runInBand test/ponto-diag
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('@firebase/firestore');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const fs = require('fs'), path = require('path'), vm = require('vm');
jest.setTimeout(60000);

const [HOST, PORT] = (process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8270').split(':');
if (!['localhost', '127.0.0.1'].includes(HOST)) throw new Error('Este diagnóstico só roda no emulador local.');
const PROJECT_ID = 'demo-ponto-diag-rules';
const RULES = readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');

const M = {}; vm.createContext(M);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), M);

let env;
const G = 'd-gestor', DR = 'd-dual', E = 'd-func', BL = 'd-func-bloq';
const F_DR = 'fx-dual', F_E = 'fx-func', F_BL = 'fx-bloq';
const DIA = '2026-09-28', MES_FECHADO = '2026-08';
const db = uid => env.authenticatedContext(uid, { email: uid + '@exemplo.test' }).firestore();
const ler = async p => { let d; await env.withSecurityRulesDisabled(async c => { const s = await c.firestore().doc(p).get(); d = s.exists ? s.data() : null; }); return d; };
const semRegras = fn => env.withSecurityRulesDisabled(async c => fn(c.firestore()));

async function seed(d) {
  const u = (uid, x) => d.doc('users/' + uid).set({ ativo: true, ...x });
  await u(G, { role: 'gestor' });
  await u(DR, { role: 'funcionario', funcionarioId: F_DR });
  await u(E, { role: 'funcionario', funcionarioId: F_E });
  await u(BL, { role: 'funcionario', funcionarioId: F_BL });
  await d.doc('sistema_usuarios/' + G).set({ modulos: ['ponto'], admin: false });
  await d.doc('sistema_usuarios/' + DR).set({ modulos: ['ponto'], admin: false });
  await d.doc('sistema_usuarios/' + BL).set({ modulos: [], admin: false, bloqueado: true });
  for (const f of [F_DR, F_E, F_BL]) await d.doc('funcionarios/' + f).set({ nome: f, jornada: 8, modalidade: 'PRESENCIAL', inicioBancoHoras: '2026-08-01' });
  await d.doc(`registros/${F_E}_${DIA}_entrada`).set({ id: `${F_E}_${DIA}_entrada`, funcId: F_E, data: DIA, tipo: 'entrada', hora: '08:05:00', criadoEm: new Date('2026-09-28T11:05:00Z') });
  await d.doc(`creditos_jornada/cred_${F_E}_${DIA}`).set({ funcId: F_E, data: DIA, minutos: 480, motivo: 'Atestado médico', criadoEm: '2026-09-28T12:00:00Z' });
  await d.doc('justificativas/j-pend').set({ id: 'j-pend', funcId: F_E, funcNome: F_E, data: DIA, motivo: 'Ponto não batido', descricao: 'Pedido original do funcionário', tipoPonto: 'saida', horarioPonto: '17:00', status: 'pendente', lancadoPorGestor: false });
  await d.doc('justificativas/j-aprov').set({ id: 'j-aprov', funcId: F_E, funcNome: F_E, data: DIA, motivo: 'Atestado médico', descricao: 'Original', status: 'aprovado', lancadoPorGestor: false, respondidoPorUid: G, respondidoPorEmail: G + '@exemplo.test', respondidoEm: new Date() });
  await d.doc(`ponto_meses_protegidos/${F_E}_${MES_FECHADO}`).set({ funcId: F_E, mes: MES_FECHADO });
  await d.doc('espelhos/esp-aberto').set({ id: 'esp-aberto', funcId: F_E, mes: '2026-09', versao: 1, assinado: false, snapshot: { totais: { saldo: 0 } }, hashSnapshot: 'hash-original' });
  await d.doc('espelhos/esp-assinado').set({ id: 'esp-assinado', funcId: F_E, mes: MES_FECHADO, versao: 1, assinado: true, snapshot: { dias: [{ data: MES_FECHADO + '-03', saldoDia: 60, contaNoSaldo: true, status: 'ok' }] }, hashSnapshot: 'h', hashAssinado: 'h' });
  await d.doc('espelhos/esp-bloq').set({ id: 'esp-bloq', funcId: F_BL, mes: '2026-09', versao: 1, assinado: false, snapshot: { totais: {} }, hashSnapshot: 'hb' });
}

beforeAll(async () => { env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: RULES, host: HOST, port: Number(PORT) } }); });
beforeEach(async () => { await env.clearFirestore(); await semRegras(seed); });
afterAll(async () => { if (env) { await env.clearFirestore(); await env.cleanup(); } });

describe('CONTROLE — proteções que funcionam', () => {
  test('funcionário não cria batida, crédito nem altera a própria batida ou o cadastro', async () => {
    const f = db(E);
    await assertFails(f.doc('registros/x').set({ funcId: F_E, data: DIA, tipo: 'saida', hora: '17:00:00' }));
    await assertFails(f.doc(`registros/${F_E}_${DIA}_entrada`).update({ hora: '08:00:00' }));
    await assertFails(f.doc('creditos_jornada/x').set({ funcId: F_E, data: DIA, minutos: 480 }));
    await assertFails(f.doc('funcionarios/' + F_E).update({ jornada: 6 }));
    await assertFails(f.doc('justificativas/j-pend').update({ status: 'aprovado' }));
  });
  test('gestor não altera hora de batida nem apaga; espelho assinado tem snapshot e assinatura imutáveis', async () => {
    await assertFails(db(G).doc(`registros/${F_E}_${DIA}_entrada`).update({ hora: '08:00:00' }));
    await assertFails(db(G).doc(`registros/${F_E}_${DIA}_entrada`).delete());
    await assertFails(db(G).doc('espelhos/esp-assinado').update({ snapshot: {} }));
    await assertFails(db(G).doc('espelhos/esp-assinado').update({ assinado: false }));
    await assertFails(db(G).doc('espelhos/esp-assinado').delete());
  });
  test('trilhas do servidor não aceitam escrita de cliente', async () => {
    for (const c of ['ponto_justificativas_decisoes', 'ponto_pendencias_decisoes', 'banco_horas_lancamentos', 'ponto_escalas', 'ponto_sabado_correcoes', 'ponto_meses_protegidos']) {
      await assertFails(db(G).doc(c + '/x').set({ funcId: F_E }));
    }
  });
});

describe('Batidas (registros)', () => {
  test('CONFIRMADO D01: gestor oculta uma batida do cálculo sem criar correção, sem autor e sem justificativa', async () => {
    const ref = db(G).doc(`registros/${F_E}_${DIA}_entrada`);
    await assertSucceeds(ref.update({ substituidoPor: 'registro-que-nao-existe' }));
    const r = await ler(`registros/${F_E}_${DIA}_entrada`);
    expect(M.registrosEfetivos([r])).toHaveLength(0);                       // some do Espelho e do Banco
    expect(Object.keys(r).filter(k => /substituid|aprovad|autor/i.test(k))).toEqual(['substituidoPor']);   // nem quem, nem quando
  });
  test('CONFIRMADO D02: gestor cria pelo cliente um registro com aparência de batida do funcionário, com hora e "criadoEm" escolhidos', async () => {
    const id = `${F_E}_2026-09-29_entrada`;
    await assertSucceeds(db(G).doc('registros/' + id).set({ id, funcId: F_E, data: '2026-09-29', tipo: 'entrada', tipoLabel: 'Entrada', hora: '07:00:00', modalidade: 'PRESENCIAL', dentroRaio: true, criadoEm: new Date('2020-01-01T00:00:00Z') }));
    const r = await ler('registros/' + id);
    expect(r.lancadoPorJustificativa).toBeUndefined();
    expect(r.aprovadoPorUid).toBeUndefined();
    expect(M.buildOrigemBatidas([r], '2026-09').dias['2026-09-29'].entrada.origem).toBe('batida');   // Espelho exibe como batida normal
  });
});

describe('Créditos de jornada e cadastro', () => {
  test('CONFIRMADO D03: crédito é criado com data do cliente, sobrescrito e apagado sem nenhuma trilha', async () => {
    const ref = db(G).doc(`creditos_jornada/cred_${F_E}_${DIA}`);
    await assertSucceeds(ref.update({ minutos: 0, motivo: 'Folga compensatória', criadoEm: '2001-01-01T00:00:00Z' }));
    await assertSucceeds(ref.delete());
    expect(await ler(`creditos_jornada/cred_${F_E}_${DIA}`)).toBeNull();
  });
  test('CONFIRMADO D04: aceita segundo crédito no mesmo funcionário e dia (ID livre)', async () => {
    await assertSucceeds(db(G).doc('creditos_jornada/id-qualquer').set({ funcId: F_E, data: DIA, minutos: 60, motivo: 'Falta justificada' }));
  });
  test('CONFIRMADO D05: usuário com módulo ponto altera o PRÓPRIO cadastro (jornada, modalidade, início do banco)', async () => {
    await assertSucceeds(db(DR).doc('funcionarios/' + F_DR).update({ modalidade: 'HOME_OFFICE', jornada: 4, inicioBancoHoras: '2026-09-28' }));
  });
  test('CONFIRMADO D06: cadastro de funcionário com marcações pode ser apagado pelo cliente', async () => {
    await assertSucceeds(db(G).doc('funcionarios/' + F_E).delete());
  });
});

describe('Justificativas', () => {
  test('CONFIRMADO D07: gestor reescreve o pedido do funcionário (horário e texto) antes da decisão', async () => {
    await assertSucceeds(db(G).doc('justificativas/j-pend').update({ horarioPonto: '19:30', descricao: 'Texto trocado' }));
  });
  test('CONFIRMADO D08: conteúdo de justificativa já APROVADA pode ser alterado depois da decisão', async () => {
    await assertSucceeds(db(G).doc('justificativas/j-aprov').update({ motivo: 'Férias', descricao: 'Alterado depois', data: '2026-09-30' }));
  });
  test('CONFIRMADO D09: justificativa pode ser movida PARA DENTRO de um mês protegido', async () => {
    await assertSucceeds(db(G).doc('justificativas/j-aprov').update({ data: MES_FECHADO + '-10' }));
  });
  test('CONFIRMADO D10: a trava "aprovar correção só no servidor" é contornada em duas escritas (ou criando já aprovada)', async () => {
    const ref = db(G).doc('justificativas/j-pend');
    await assertFails(ref.update({ status: 'aprovado' }));                          // controle: caminho direto negado
    await assertSucceeds(ref.update({ tipoPonto: null }));
    await assertSucceeds(ref.update({ status: 'aprovado' }));
    await assertSucceeds(ref.update({ tipoPonto: 'saida' }));
    expect(await ler('justificativas/j-pend')).toMatchObject({ status: 'aprovado', tipoPonto: 'saida' });
    await assertSucceeds(db(G).doc('justificativas/j-nasce-aprovada').set({ funcId: F_E, data: DIA, tipoPonto: 'saida', horarioPonto: '18:00', status: 'aprovado', lancadoPorGestor: false }));
    const col = await db(G).collection('ponto_justificativas_decisoes').get();
    expect(col.size).toBe(0);                                                        // nenhuma trilha de decisão
  });
  test('CONFIRMADO D11: funcionário grava campos reservados à gestão (evidenciaGestao, nome de terceiro, dados de decisão)', async () => {
    await assertSucceeds(db(E).doc('justificativas/j-func').set({ funcId: F_E, funcNome: 'Outro Nome', data: DIA, motivo: 'Ponto não batido', descricao: '', tipoPonto: 'saida', horarioPonto: '18:00',
      status: 'pendente', lancadoPorGestor: false, evidenciaGestao: 'x', registroEfetivoId: 'qualquer', criadoEm: '2000-01-01T00:00:00Z' }));
    expect(M.temEvidenciaJustificativa(await ler('justificativas/j-func'))).toBe(true);
  });
});

describe('Espelhos', () => {
  test('CONFIRMADO D12: gestor grava um espelho como ASSINADO pelo funcionário (sem o funcionário)', async () => {
    await assertSucceeds(db(G).doc('espelhos/esp-aberto').update({ assinado: true, status: 'assinado', assinadoPor: F_E, assinadoEm: serverTimestamp(), assinaturaImg: 'data:image/png;base64,AAAA' }));
    expect(await ler('espelhos/esp-aberto')).toMatchObject({ assinado: true, assinadoPor: F_E });
  });
  test('CONFIRMADO D13: snapshot de espelho em assinatura muda sem mudar o hash; a assinatura com o hash antigo é aceita', async () => {
    await assertSucceeds(db(G).doc('espelhos/esp-aberto').update({ snapshot: { totais: { saldo: -999 } } }));
    await assertSucceeds(db(E).doc('espelhos/esp-aberto').update({ assinado: true, status: 'assinado', hashAssinado: 'hash-original', assinadoEm: serverTimestamp(), assinadoPor: F_E, assinaturaImg: 'x' }));
    expect((await ler('espelhos/esp-aberto')).snapshot.totais.saldo).toBe(-999);
  });
  test('CONFIRMADO D14: marcar espelho assinado como "substituido" (sem v2) faz o Banco recalcular o mês congelado', async () => {
    const f = { id: F_E, jornada: 8 };
    const dados = [{ mes: MES_FECHADO, regs: [], cred: [], just: [] }];
    const montar = esp => M.montarMesesBanco(f, dados, [esp], '2026-09-30', '2026-09-29', '2026-09')[0];
    expect(montar(await ler('espelhos/esp-assinado')).origem).toBe('SNAPSHOT_ASSINADO');
    await assertSucceeds(db(G).doc('espelhos/esp-assinado').update({ substituido: true }));
    expect(montar(await ler('espelhos/esp-assinado')).origem).toBe('MOTOR');
  });
});

describe('Bloqueio de usuário', () => {
  test('CONFIRMADO D15: funcionário BLOQUEADO continua lendo, criando justificativa e assinando espelho', async () => {
    const f = db(BL);
    await assertSucceeds(f.doc('funcionarios/' + F_BL).get());
    await assertSucceeds(f.doc('justificativas/j-bl').set({ funcId: F_BL, data: DIA, motivo: 'Férias', status: 'pendente', lancadoPorGestor: false }));
    await assertSucceeds(f.doc('espelhos/esp-bloq').update({ assinado: true, status: 'assinado', hashAssinado: 'hb', assinadoEm: serverTimestamp(), assinadoPor: F_BL, assinaturaImg: 'x' }));
  });
});
