'use strict';
/**
 * DIAGNÓSTICO TÉCNICO DO PONTO — Firestore Rules (EMULADOR; dados 100% sintéticos; nada de produção).
 *
 * Antes testes de caracterização do defeito; INVERTIDOS na correção:
 *   "CORRIGIDO Dxx" afirma que a escrita indevida agora é negada.
 *   "CONTROLE" afirma uma proteção que já funciona e não pode regredir.
 * Nenhuma regra trabalhista é avaliada aqui — só quem consegue escrever o quê e com que trilha.
 *
 * Porta padrão 8310 (nunca a 8080). Rodar:
 *   node scripts/testes/rodar.js -- test/ponto-diag
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('@firebase/firestore');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const fs = require('fs'), path = require('path'), vm = require('vm');
jest.setTimeout(60000);

const [HOST, PORT] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
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
  test('CORRIGIDO D01 (E1): gestor não oculta batida', async () => {
    await assertFails(db(G).doc(`registros/${F_E}_${DIA}_entrada`).update({ substituidoPor: 'registro-que-nao-existe' }));
    expect(M.registrosEfetivos([await ler(`registros/${F_E}_${DIA}_entrada`)])).toHaveLength(1);
  });
  test('CORRIGIDO D02 (E1): gestor não cria registro pelo cliente', async () => {
    const id = `${F_E}_2026-09-29_entrada`;
    await assertFails(db(G).doc('registros/' + id).set({ id, funcId: F_E, data: '2026-09-29', tipo: 'entrada', tipoLabel: 'Entrada', hora: '07:00:00', modalidade: 'PRESENCIAL', dentroRaio: true, criadoEm: new Date('2020-01-01T00:00:00Z') }));
  });
});

describe('Créditos de jornada e cadastro', () => {
  test('CORRIGIDO D03 (E1: não apaga; histórico do relançamento vem da trilha da E2; autor obrigatório na E4)', async () => {
    const ref = db(G).doc(`creditos_jornada/cred_${F_E}_${DIA}`);
    await assertFails(ref.delete());
    expect(await ler(`creditos_jornada/cred_${F_E}_${DIA}`)).not.toBeNull();
  });
  test('CORRIGIDO D04 (E1): não aceita segundo crédito no mesmo funcionário e dia', async () => {
    await assertFails(db(G).doc('creditos_jornada/id-qualquer').set({ funcId: F_E, data: DIA, minutos: 60, motivo: 'Falta justificada' }));
  });
  test('CORRIGIDO D05 (E1): usuário com módulo ponto não altera o próprio cadastro de ponto', async () => {
    await assertFails(db(DR).doc('funcionarios/' + F_DR).update({ modalidade: 'HOME_OFFICE', jornada: 4, inicioBancoHoras: '2026-09-28' }));
  });
  test('D06 parcial (E1: nunca o próprio; a exclusão dos demais só é negada na E4)', async () => {
    await assertFails(db(DR).doc('funcionarios/' + F_DR).delete());
  });
});

describe('Justificativas', () => {
  test('CORRIGIDO D07/D08/D09 (E1): pedido não é reescrito, decidida não muda nem vai para mês protegido', async () => {
    await assertFails(db(G).doc('justificativas/j-pend').update({ horarioPonto: '19:30', descricao: 'Texto trocado' }));
    await assertFails(db(G).doc('justificativas/j-aprov').update({ motivo: 'Férias', descricao: 'Alterado depois', data: '2026-09-30' }));
    await assertFails(db(G).doc('justificativas/j-aprov').update({ data: MES_FECHADO + '-10' }));
  });
  test('CORRIGIDO D10 (E1): nenhum dos dois contornos funciona', async () => {
    const ref = db(G).doc('justificativas/j-pend');
    await assertFails(ref.update({ tipoPonto: null }));
    await assertFails(ref.update({ status: 'aprovado' }));
    await assertFails(db(G).doc('justificativas/j-nasce-aprovada').set({ funcId: F_E, data: DIA, tipoPonto: 'saida', horarioPonto: '18:00', status: 'aprovado', lancadoPorGestor: true }));
  });
  test('CORRIGIDO D11 (E1): funcionário não grava campos reservados à gestão', async () => {
    await assertFails(db(E).doc('justificativas/j-func').set({ funcId: F_E, funcNome: 'Outro Nome', data: DIA, motivo: 'Ponto não batido', descricao: '', tipoPonto: 'saida', horarioPonto: '18:00',
      status: 'pendente', lancadoPorGestor: false, evidenciaGestao: 'x', registroEfetivoId: 'qualquer', criadoEm: '2000-01-01T00:00:00Z' }));
  });
});

describe('Espelhos', () => {
  test('CORRIGIDO D12 (E1): gestor não grava assinatura', async () => {
    await assertFails(db(G).doc('espelhos/esp-aberto').update({ assinado: true, status: 'assinado', assinadoPor: F_E, assinadoEm: serverTimestamp(), assinaturaImg: 'data:image/png;base64,AAAA' }));
  });
  test('CORRIGIDO D13 (E1, parte das Rules): snapshot não muda sem o hash mudar', async () => {
    await assertFails(db(G).doc('espelhos/esp-aberto').update({ snapshot: { totais: { saldo: -999 } } }));
  });
  test('CORRIGIDO D14 (E1): cliente não marca espelho assinado como substituído', async () => {
    await assertFails(db(G).doc('espelhos/esp-assinado').update({ substituido: true }));
    const f = { id: F_E, jornada: 8 };
    const dados = [{ mes: MES_FECHADO, regs: [], cred: [], just: [] }];
    expect(M.montarMesesBanco(f, dados, [await ler('espelhos/esp-assinado')], '2026-09-30', '2026-09-29', '2026-09')[0].origem).toBe('SNAPSHOT_ASSINADO');
  });
});

describe('Bloqueio de usuário', () => {
  test('CORRIGIDO D15 (E1): funcionário bloqueado não lê, não cria justificativa e não assina', async () => {
    const f = db(BL);
    await assertFails(f.doc('funcionarios/' + F_BL).get());
    await assertFails(f.doc('justificativas/j-bl').set({ funcId: F_BL, data: DIA, motivo: 'Férias', status: 'pendente', lancadoPorGestor: false }));
    await assertFails(f.doc('espelhos/esp-bloq').update({ assinado: true, status: 'assinado', hashAssinado: 'hb', assinadoEm: serverTimestamp(), assinadoPor: F_BL, assinaturaImg: 'x' }));
  });
});
