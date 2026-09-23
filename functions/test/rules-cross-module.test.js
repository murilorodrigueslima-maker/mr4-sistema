'use strict';

/**
 * Testes cross-module — Gate Final P0 (2026-09-22)
 *
 * Valida que cada persona só acessa os módulos autorizados.
 * Invariante: UNAUTHORIZED_ACCESS_ESCAPES=0
 *
 * Personas testadas:
 *   CM-F  Fabiana   — funcionario, modulos=['demandas']
 *   CM-G  Gutemberg — funcionario, modulos=['garantia']
 *   CM-C  Camila    — funcionario, admin=true (superusuário)
 *   CM-S  Swyanne   — funcionario, modulos=['clientes']
 *   CM-PP ponto-puro — funcionario, sem sistema_usuarios
 *   CM-D  display   — role='display', sem sistema_usuarios
 *   CM-I  inativo   — funcionario, ativo=false
 *   CM-B  bloqueado — funcionario, bloqueado=true
 *   CM-R  role-desconhecida — role='desconhecido', ativo=true
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID = 'mr4-ponto-cm-test';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

// ── UIDs ──────────────────────────────────────────────────────────────────────
const UID_FABIANA    = 'cm-fabiana';
const UID_GUTEMBERG  = 'cm-gutemberg';
const UID_CAMILA     = 'cm-camila';
const UID_SWYANNE    = 'cm-swyanne';
const UID_PP         = 'cm-ponto-puro';
const UID_DISPLAY    = 'cm-display';
const UID_INATIVO    = 'cm-inativo';
const UID_BLOQUEADO  = 'cm-bloqueado';
const UID_ROLE_DESCONHECIDA = 'cm-role-desconhecida';

let testEnv;

const SEED = async db => {
  // Fabiana — funcionario, modulos=['demandas']
  await db.collection('users').doc(UID_FABIANA).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-CM-01' });
  await db.collection('sistema_usuarios').doc(UID_FABIANA).set({ nome: 'Fabiana', modulos: ['demandas'], admin: false, bloqueado: false });

  // Gutemberg — funcionario, modulos=['garantia']
  await db.collection('users').doc(UID_GUTEMBERG).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-CM-02' });
  await db.collection('sistema_usuarios').doc(UID_GUTEMBERG).set({ nome: 'Gutemberg', modulos: ['garantia'], admin: false, bloqueado: false });

  // Camila — funcionario, admin=true
  await db.collection('users').doc(UID_CAMILA).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-CM-03' });
  await db.collection('sistema_usuarios').doc(UID_CAMILA).set({ nome: 'Camila', modulos: [], admin: true, bloqueado: false });

  // Swyanne — funcionario, modulos=['clientes']
  await db.collection('users').doc(UID_SWYANNE).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-CM-04' });
  await db.collection('sistema_usuarios').doc(UID_SWYANNE).set({ nome: 'Swyanne', modulos: ['clientes'], admin: false, bloqueado: false });

  // ponto-puro — funcionario, sem sistema_usuarios
  await db.collection('users').doc(UID_PP).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-CM-05' });

  // display — role=display, sem sistema_usuarios
  await db.collection('users').doc(UID_DISPLAY).set({ role: 'display', ativo: true });

  // inativo — funcionario, ativo=false
  await db.collection('users').doc(UID_INATIVO).set({ role: 'funcionario', ativo: false, funcionarioId: 'FUNC-CM-07' });
  await db.collection('sistema_usuarios').doc(UID_INATIVO).set({ nome: 'Inativo', modulos: ['demandas', 'garantia', 'clientes'], admin: false, bloqueado: false });

  // bloqueado — funcionario, bloqueado=true
  await db.collection('users').doc(UID_BLOQUEADO).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-CM-08' });
  await db.collection('sistema_usuarios').doc(UID_BLOQUEADO).set({ nome: 'Bloqueado', modulos: ['demandas', 'garantia', 'clientes'], admin: false, bloqueado: true });

  // role-desconhecida — role='desconhecido', ativo=true
  await db.collection('users').doc(UID_ROLE_DESCONHECIDA).set({ role: 'desconhecido', ativo: true });
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async ctx => { await SEED(ctx.firestore()); });
});

afterAll(async () => { await testEnv.cleanup(); });

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async ctx => { await SEED(ctx.firestore()); });
});

const db   = uid => testEnv.authenticatedContext(uid).firestore();
const seed = (col, id, data) =>
  testEnv.withSecurityRulesDisabled(ctx => ctx.firestore().collection(col).doc(id).set(data));

// ── CM-F: Fabiana (demandas apenas) ──────────────────────────────────────────

describe('CM-F — Fabiana (modulos=[demandas])', () => {
  beforeEach(async () => {
    await seed('demandas',  'doc-f1', { titulo: 'T' });
    await seed('garantias', 'doc-f2', { cliente: 'X' });
    await seed('clientes',  'doc-f3', { nome: 'C' });
    await seed('compras_config', 'cfg', { v: 1 });
  });

  test('CM-F1: Fabiana LÊ demandas (módulo correto)', async () => {
    await assertSucceeds(db(UID_FABIANA).collection('demandas').doc('doc-f1').get());
  });
  test('CM-F2: Fabiana CRIA demanda', async () => {
    await assertSucceeds(db(UID_FABIANA).collection('demandas').doc('nova').set({ titulo: 'Nova' }));
  });
  test('CM-F3: Fabiana NÃO lê garantias (módulo errado) → ESCAPE=0', async () => {
    await assertFails(db(UID_FABIANA).collection('garantias').doc('doc-f2').get());
  });
  test('CM-F4: Fabiana NÃO lê clientes (módulo errado) → ESCAPE=0', async () => {
    await assertFails(db(UID_FABIANA).collection('clientes').doc('doc-f3').get());
  });
  test('CM-F5: Fabiana NÃO lê compras_config (módulo errado) → ESCAPE=0', async () => {
    await assertFails(db(UID_FABIANA).collection('compras_config').doc('cfg').get());
  });
  test('CM-F6: Fabiana NÃO lê registros de outro func (ponto exige gestor) → ESCAPE=0', async () => {
    await seed('registros', 'reg-outro', { funcId: 'FUNC-CM-99', data: '2026-09-22' });
    await assertFails(db(UID_FABIANA).collection('registros').doc('reg-outro').get());
  });
});

// ── CM-G: Gutemberg (garantia apenas) ─────────────────────────────────────────

describe('CM-G — Gutemberg (modulos=[garantia])', () => {
  beforeEach(async () => {
    await seed('garantias',         'doc-g1', { cliente: 'X' });
    await seed('fornecedores_custo', 'forn-g1', { nome: 'Samsung', custo: 0.12 });
    await seed('demandas',          'doc-g2', { titulo: 'T' });
  });

  test('CM-G1: Gutemberg LÊ garantias', async () => {
    await assertSucceeds(db(UID_GUTEMBERG).collection('garantias').doc('doc-g1').get());
  });
  test('CM-G2: Gutemberg LÊ fornecedores_custo (necessário para garantia)', async () => {
    await assertSucceeds(db(UID_GUTEMBERG).collection('fornecedores_custo').doc('forn-g1').get());
  });
  test('CM-G3: Gutemberg NÃO ESCREVE fornecedores_custo (write=isGestor) → ESCAPE=0', async () => {
    await assertFails(
      db(UID_GUTEMBERG).collection('fornecedores_custo').doc('novo').set({ nome: 'LG', custo: 0.1 })
    );
  });
  test('CM-G4: Gutemberg NÃO lê demandas (módulo errado) → ESCAPE=0', async () => {
    await assertFails(db(UID_GUTEMBERG).collection('demandas').doc('doc-g2').get());
  });
  test('CM-G5: Gutemberg NÃO lê clientes → ESCAPE=0', async () => {
    await seed('clientes', 'cli-g', { nome: 'C' });
    await assertFails(db(UID_GUTEMBERG).collection('clientes').doc('cli-g').get());
  });
});

// ── CM-C: Camila (admin=true) ─────────────────────────────────────────────────

describe('CM-C — Camila (admin=true)', () => {
  beforeEach(async () => {
    await seed('demandas',          'doc-c1', { titulo: 'T' });
    await seed('garantias',         'doc-c2', { cliente: 'X' });
    await seed('clientes',          'doc-c3', { nome: 'C' });
    await seed('compras_config',    'cfg-c',  { v: 1 });
    await seed('expedicao_pedidos', 'ped-c',  { num: 'P1' });
    await seed('marketing_conteudos', 'mk-c', { titulo: 'M' });
    await seed('produto_equivalentes', 'eq-c', { grupo: 'G' });
  });

  test('CM-C1: Camila LÊ demandas (admin=true)', async () => {
    await assertSucceeds(db(UID_CAMILA).collection('demandas').doc('doc-c1').get());
  });
  test('CM-C2: Camila LÊ garantias', async () => {
    await assertSucceeds(db(UID_CAMILA).collection('garantias').doc('doc-c2').get());
  });
  test('CM-C3: Camila LÊ clientes', async () => {
    await assertSucceeds(db(UID_CAMILA).collection('clientes').doc('doc-c3').get());
  });
  test('CM-C4: Camila LÊ compras_config', async () => {
    await assertSucceeds(db(UID_CAMILA).collection('compras_config').doc('cfg-c').get());
  });
  test('CM-C5: Camila LÊ expedicao_pedidos', async () => {
    await assertSucceeds(db(UID_CAMILA).collection('expedicao_pedidos').doc('ped-c').get());
  });
  test('CM-C6: Camila LÊ marketing_conteudos', async () => {
    await assertSucceeds(db(UID_CAMILA).collection('marketing_conteudos').doc('mk-c').get());
  });
  test('CM-C7: Camila NÃO lê registros de outro func (ponto exige role=gestor) → ESCAPE=0', async () => {
    await seed('registros', 'reg-c', { funcId: 'FUNC-CM-99', data: '2026-09-22' });
    await assertFails(db(UID_CAMILA).collection('registros').doc('reg-c').get());
  });
  test('CM-C8: Camila NÃO lê fila_comercial (exige temModulo=gestor) → ESCAPE=0', async () => {
    await seed('fila_comercial', 'fila-c', { status: 'aberta' });
    await assertFails(db(UID_CAMILA).collection('fila_comercial').doc('fila-c').get());
  });
});

// ── CM-S: Swyanne (clientes apenas) ──────────────────────────────────────────

describe('CM-S — Swyanne (modulos=[clientes])', () => {
  beforeEach(async () => {
    await seed('clientes',          'doc-s1', { nome: 'C' });
    await seed('conversas_resumo',  'conv-s', { ultimaMsg: 'ok' });
    await seed('chat_status',       'chat-s', { conectado: true });
    await seed('demandas',          'doc-s2', { titulo: 'T' });
    await seed('garantias',         'doc-s3', { cliente: 'X' });
  });

  test('CM-S1: Swyanne LÊ clientes', async () => {
    await assertSucceeds(db(UID_SWYANNE).collection('clientes').doc('doc-s1').get());
  });
  test('CM-S2: Swyanne CRIA cliente (sem campos GC)', async () => {
    await assertSucceeds(
      db(UID_SWYANNE).collection('clientes').doc('novo-cli').set({ nome: 'Novo', telefone: '88000000' })
    );
  });
  test('CM-S3: Swyanne NÃO cria cliente com gestaoClickId → ESCAPE=0', async () => {
    await assertFails(
      db(UID_SWYANNE).collection('clientes').doc('cli-gc').set({ nome: 'X', gestaoClickId: 'GC-1' })
    );
  });
  test('CM-S4: Swyanne LÊ conversas_resumo', async () => {
    await assertSucceeds(db(UID_SWYANNE).collection('conversas_resumo').doc('conv-s').get());
  });
  test('CM-S5: Swyanne LÊ chat_status', async () => {
    await assertSucceeds(db(UID_SWYANNE).collection('chat_status').doc('chat-s').get());
  });
  test('CM-S6: Swyanne NÃO lê demandas (módulo errado) → ESCAPE=0', async () => {
    await assertFails(db(UID_SWYANNE).collection('demandas').doc('doc-s2').get());
  });
  test('CM-S7: Swyanne NÃO lê garantias → ESCAPE=0', async () => {
    await assertFails(db(UID_SWYANNE).collection('garantias').doc('doc-s3').get());
  });
});

// ── CM-PP: ponto-puro (sem sistema_usuarios) ──────────────────────────────────

describe('CM-PP — ponto-puro (funcionario sem sistema_usuarios)', () => {
  beforeEach(async () => {
    await seed('demandas',  'doc-pp', { titulo: 'T' });
    await seed('garantias', 'doc-pp2', { cliente: 'X' });
    await seed('clientes',  'doc-pp3', { nome: 'C' });
    await seed('registros', 'reg-pp', { funcId: 'FUNC-CM-05', data: '2026-09-22' });
  });

  test('CM-PP1: ponto-puro NÃO lê demandas → ESCAPE=0', async () => {
    await assertFails(db(UID_PP).collection('demandas').doc('doc-pp').get());
  });
  test('CM-PP2: ponto-puro NÃO lê garantias → ESCAPE=0', async () => {
    await assertFails(db(UID_PP).collection('garantias').doc('doc-pp2').get());
  });
  test('CM-PP3: ponto-puro NÃO lê clientes → ESCAPE=0', async () => {
    await assertFails(db(UID_PP).collection('clientes').doc('doc-pp3').get());
  });
  test('CM-PP4: ponto-puro LÊ o PRÓPRIO registro de ponto (isFuncionario)', async () => {
    await assertSucceeds(db(UID_PP).collection('registros').doc('reg-pp').get());
  });
});

// ── CM-D: display ─────────────────────────────────────────────────────────────

describe('CM-D — display (role=display)', () => {
  beforeEach(async () => {
    await seed('display_metrics', 'met-d', { vendas: 10 });
    await seed('demandas',        'doc-d', { titulo: 'T' });
    await seed('clientes',        'doc-d2', { nome: 'C' });
  });

  test('CM-D1: display LÊ display_metrics (isDisplay)', async () => {
    await assertSucceeds(db(UID_DISPLAY).collection('display_metrics').doc('met-d').get());
  });
  test('CM-D2: display NÃO ESCREVE display_metrics (write=false) → ESCAPE=0', async () => {
    await assertFails(
      db(UID_DISPLAY).collection('display_metrics').doc('met-d').set({ vendas: 99 })
    );
  });
  test('CM-D3: display NÃO lê demandas → ESCAPE=0', async () => {
    await assertFails(db(UID_DISPLAY).collection('demandas').doc('doc-d').get());
  });
  test('CM-D4: display NÃO lê clientes → ESCAPE=0', async () => {
    await assertFails(db(UID_DISPLAY).collection('clientes').doc('doc-d2').get());
  });
});

// ── CM-I: inativo ─────────────────────────────────────────────────────────────

describe('CM-I — inativo (ativo=false)', () => {
  beforeEach(async () => {
    await seed('demandas',  'doc-i', { titulo: 'T' });
    await seed('garantias', 'doc-i2', { cliente: 'X' });
    await seed('clientes',  'doc-i3', { nome: 'C' });
    await seed('registros', 'reg-i', { funcId: 'FUNC-CM-07', data: '2026-09-22' });
  });

  test('CM-I1: inativo NÃO lê demandas → ESCAPE=0', async () => {
    await assertFails(db(UID_INATIVO).collection('demandas').doc('doc-i').get());
  });
  test('CM-I2: inativo NÃO lê garantias → ESCAPE=0', async () => {
    await assertFails(db(UID_INATIVO).collection('garantias').doc('doc-i2').get());
  });
  test('CM-I3: inativo NÃO lê clientes → ESCAPE=0', async () => {
    await assertFails(db(UID_INATIVO).collection('clientes').doc('doc-i3').get());
  });
  test('CM-I4: inativo NÃO lê o próprio registro (ativo=false bloqueia isFuncionario) → ESCAPE=0', async () => {
    await assertFails(db(UID_INATIVO).collection('registros').doc('reg-i').get());
  });
});

// ── CM-B: bloqueado ───────────────────────────────────────────────────────────

describe('CM-B — bloqueado (bloqueado=true em sistema_usuarios)', () => {
  beforeEach(async () => {
    await seed('demandas',  'doc-b', { titulo: 'T' });
    await seed('garantias', 'doc-b2', { cliente: 'X' });
    await seed('clientes',  'doc-b3', { nome: 'C' });
  });

  test('CM-B1: bloqueado NÃO lê demandas (bloqueado=true) → ESCAPE=0', async () => {
    await assertFails(db(UID_BLOQUEADO).collection('demandas').doc('doc-b').get());
  });
  test('CM-B2: bloqueado NÃO lê garantias → ESCAPE=0', async () => {
    await assertFails(db(UID_BLOQUEADO).collection('garantias').doc('doc-b2').get());
  });
  test('CM-B3: bloqueado NÃO lê clientes → ESCAPE=0', async () => {
    await assertFails(db(UID_BLOQUEADO).collection('clientes').doc('doc-b3').get());
  });
  test('CM-B4: bloqueado LÊ o PRÓPRIO registro de ponto (isFuncionario não checa bloqueado)', async () => {
    // isFuncionario() só checa users/{uid}.ativo — bloqueado está em sistema_usuarios
    await seed('registros', 'reg-b', { funcId: 'FUNC-CM-08', data: '2026-09-22' });
    await assertSucceeds(db(UID_BLOQUEADO).collection('registros').doc('reg-b').get());
  });
});

// ── CM-R: role-desconhecida ───────────────────────────────────────────────────

describe('CM-R — role-desconhecida (role=desconhecido)', () => {
  beforeEach(async () => {
    await seed('demandas',       'doc-r', { titulo: 'T' });
    await seed('garantias',      'doc-r2', { cliente: 'X' });
    await seed('display_metrics','doc-r3', { vendas: 1 });
    await seed('clientes',       'doc-r4', { nome: 'C' });
  });

  test('CM-R1: role desconhecida NÃO lê demandas → ESCAPE=0', async () => {
    await assertFails(db(UID_ROLE_DESCONHECIDA).collection('demandas').doc('doc-r').get());
  });
  test('CM-R2: role desconhecida NÃO lê garantias → ESCAPE=0', async () => {
    await assertFails(db(UID_ROLE_DESCONHECIDA).collection('garantias').doc('doc-r2').get());
  });
  test('CM-R3: role desconhecida NÃO lê display_metrics → ESCAPE=0', async () => {
    await assertFails(db(UID_ROLE_DESCONHECIDA).collection('display_metrics').doc('doc-r3').get());
  });
  test('CM-R4: role desconhecida NÃO lê clientes → ESCAPE=0', async () => {
    await assertFails(db(UID_ROLE_DESCONHECIDA).collection('clientes').doc('doc-r4').get());
  });
});
