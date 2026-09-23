'use strict';

/**
 * Testes de Firestore Rules — modelo dual-role (P0 fix 2026-09-22)
 *
 * Valida os helpers isDualRoleAtivo() e temAcessoModulo() adicionados às Rules.
 *
 * Cenários testados:
 *   DR-1..DR-3  : isDualRoleAtivo — gestor, dual-role válido, funcionario sem sistema_usuarios
 *   DR-4        : dual-role bloqueado (bloqueado=true) → NEGADO
 *   DR-5..DR-7  : temAcessoModulo — modulo correspondente PERMITIDO, modulo errado NEGADO
 *   DR-8..DR-10 : admin=true (qualquer módulo) PERMITIDO
 *   DR-11..DR-13: ponto regressão — ponto ainda exige role=gestor
 *   DR-14..DR-16: coleções diversas com dual-role
 *   DR-17       : fornecedores_custo — dual-role garantia pode LER mas NÃO ESCREVE
 *   DR-18       : clientes com GC fields — dual-role respeita noGcFieldsOnCreate/gcFieldsIntact
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID = 'mr4-ponto-dr-test';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

// ── UIDs de teste ─────────────────────────────────────────────────────────────
const UID_GESTOR         = 'dr-uid-gestor';
const UID_DUAL_DEMANDAS  = 'dr-uid-dual-demandas';   // funcionario + modulos=['demandas']
const UID_DUAL_GARANTIA  = 'dr-uid-dual-garantia';   // funcionario + modulos=['garantia']
const UID_DUAL_ADMIN     = 'dr-uid-dual-admin';      // funcionario + admin=true
const UID_DUAL_BLOQUEADO = 'dr-uid-dual-bloqueado';  // funcionario + bloqueado=true
const UID_FUNC_SEM_ADM   = 'dr-uid-func-semadm';     // funcionario sem sistema_usuarios

let testEnv;

const SEED = async db => {
  // Gestor direto
  await db.collection('users').doc(UID_GESTOR).set({ role: 'gestor', ativo: true });
  await db.collection('sistema_usuarios').doc(UID_GESTOR).set({
    nome: 'Murilo', cargo: 'Gestor', modulos: ['ponto', 'demandas', 'garantia'], admin: false, bloqueado: false
  });

  // Dual-role: modulos=['demandas']
  await db.collection('users').doc(UID_DUAL_DEMANDAS).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-DR-01' });
  await db.collection('sistema_usuarios').doc(UID_DUAL_DEMANDAS).set({
    nome: 'Fabiana', cargo: 'Vendedora', modulos: ['demandas'], admin: false, bloqueado: false
  });

  // Dual-role: modulos=['garantia']
  await db.collection('users').doc(UID_DUAL_GARANTIA).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-DR-02' });
  await db.collection('sistema_usuarios').doc(UID_DUAL_GARANTIA).set({
    nome: 'Gutemberg', cargo: 'Técnico', modulos: ['garantia'], admin: false, bloqueado: false
  });

  // Dual-role: admin=true
  await db.collection('users').doc(UID_DUAL_ADMIN).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-DR-03' });
  await db.collection('sistema_usuarios').doc(UID_DUAL_ADMIN).set({
    nome: 'Admin Func', cargo: 'Admin', modulos: [], admin: true, bloqueado: false
  });

  // Dual-role bloqueado
  await db.collection('users').doc(UID_DUAL_BLOQUEADO).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-DR-04' });
  await db.collection('sistema_usuarios').doc(UID_DUAL_BLOQUEADO).set({
    nome: 'Bloqueado', cargo: 'Ex', modulos: ['demandas'], admin: false, bloqueado: true
  });

  // Funcionario sem sistema_usuarios (puro clock-in)
  await db.collection('users').doc(UID_FUNC_SEM_ADM).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-DR-05' });
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

const db   = uid => uid
  ? testEnv.authenticatedContext(uid).firestore()
  : testEnv.unauthenticatedContext().firestore();

const seed = (col, id, data) =>
  testEnv.withSecurityRulesDisabled(ctx => ctx.firestore().collection(col).doc(id).set(data));

// ── DR-1..DR-4: isDualRoleAtivo ───────────────────────────────────────────────

describe('DR-1..DR-4 — isDualRoleAtivo', () => {
  beforeEach(async () => { await seed('demandas', 'test-doc', { titulo: 'Teste' }); });

  test('DR-1: gestor lê demandas (isDualRoleAtivo via temAcessoModulo)', async () => {
    await assertSucceeds(db(UID_GESTOR).collection('demandas').doc('test-doc').get());
  });

  test('DR-2: dual-role com modulo=demandas lê demandas', async () => {
    await assertSucceeds(db(UID_DUAL_DEMANDAS).collection('demandas').doc('test-doc').get());
  });

  test('DR-3: funcionario sem sistema_usuarios NÃO lê demandas', async () => {
    await assertFails(db(UID_FUNC_SEM_ADM).collection('demandas').doc('test-doc').get());
  });

  test('DR-4: dual-role bloqueado NÃO lê demandas', async () => {
    await assertFails(db(UID_DUAL_BLOQUEADO).collection('demandas').doc('test-doc').get());
  });
});

// ── DR-5..DR-7: temAcessoModulo — módulo correto vs. incorreto ────────────────

describe('DR-5..DR-7 — temAcessoModulo módulo correto vs. incorreto', () => {
  beforeEach(async () => {
    await seed('demandas',  'demo-demanda',  { titulo: 'Demanda teste' });
    await seed('garantias', 'demo-garantia', { cliente: 'Cliente teste' });
  });

  test('DR-5: dual-role modulo=demandas PODE LER demandas', async () => {
    await assertSucceeds(db(UID_DUAL_DEMANDAS).collection('demandas').doc('demo-demanda').get());
  });

  test('DR-6: dual-role modulo=demandas NÃO LÊ garantias (módulo errado)', async () => {
    await assertFails(db(UID_DUAL_DEMANDAS).collection('garantias').doc('demo-garantia').get());
  });

  test('DR-7: dual-role modulo=garantia LÊ garantias', async () => {
    await assertSucceeds(db(UID_DUAL_GARANTIA).collection('garantias').doc('demo-garantia').get());
  });
});

// ── DR-8..DR-10: admin=true concede qualquer módulo ──────────────────────────

describe('DR-8..DR-10 — admin=true em dual-role', () => {
  beforeEach(async () => {
    await seed('demandas',  'adm-demanda',  { titulo: 'Admin test' });
    await seed('garantias', 'adm-garantia', { cliente: 'Admin test' });
    await seed('compras_config', 'settings', { caixaDisponivel: 1000 });
  });

  test('DR-8: dual-role admin=true LÊ demandas', async () => {
    await assertSucceeds(db(UID_DUAL_ADMIN).collection('demandas').doc('adm-demanda').get());
  });

  test('DR-9: dual-role admin=true LÊ garantias', async () => {
    await assertSucceeds(db(UID_DUAL_ADMIN).collection('garantias').doc('adm-garantia').get());
  });

  test('DR-10: dual-role admin=true LÊ compras_config', async () => {
    await assertSucceeds(db(UID_DUAL_ADMIN).collection('compras_config').doc('settings').get());
  });
});

// ── DR-11..DR-13: regressão ponto (não muda) ─────────────────────────────────

describe('DR-11..DR-13 — ponto regressão (temModulo mantido)', () => {
  test('DR-11: dual-role sem módulo ponto NÃO lê registros de OUTRO func (ponto exige role=gestor)', async () => {
    // funcId: 'FUNC-DR-99' é de outro funcionário (UID_DUAL_DEMANDAS tem funcId='FUNC-DR-01')
    await seed('registros', 'reg-test', { funcId: 'FUNC-DR-99', data: '2026-09-22' });
    await assertFails(db(UID_DUAL_DEMANDAS).collection('registros').doc('reg-test').get());
  });

  test('DR-12: dual-role admin=true NÃO lê registros de OUTRO func (ponto exige role=gestor)', async () => {
    await seed('registros', 'reg-test', { funcId: 'FUNC-DR-99', data: '2026-09-22' });
    await assertFails(db(UID_DUAL_ADMIN).collection('registros').doc('reg-test').get());
  });

  test('DR-13: gestor COM módulo ponto ACESSA registros (regressão gestor preservado)', async () => {
    await seed('sistema_usuarios', UID_GESTOR, {
      nome: 'Murilo', cargo: 'Gestor', modulos: ['ponto'], admin: false, bloqueado: false
    });
    await seed('registros', 'reg-test-g', { funcId: 'FUNC-01', data: '2026-09-22' });
    await assertSucceeds(db(UID_GESTOR).collection('registros').doc('reg-test-g').get());
  });
});

// ── DR-14..DR-16: coleções diversas ──────────────────────────────────────────

describe('DR-14..DR-16 — coleções diversas com dual-role', () => {
  test('DR-14: dual-role garantia LÊ fornecedores_custo', async () => {
    await seed('fornecedores_custo', 'forn-1', { nome: 'Samsung', custo: 0.12 });
    await assertSucceeds(db(UID_DUAL_GARANTIA).collection('fornecedores_custo').doc('forn-1').get());
  });

  test('DR-15: dual-role demandas LÊ expedicao_pedidos? NÃO (módulo errado)', async () => {
    await seed('expedicao_pedidos', 'ped-1', { numero: 'P001' });
    await assertFails(db(UID_DUAL_DEMANDAS).collection('expedicao_pedidos').doc('ped-1').get());
  });

  test('DR-16: dual-role cria demanda', async () => {
    await assertSucceeds(
      db(UID_DUAL_DEMANDAS).collection('demandas').doc('nova-demanda').set({ titulo: 'Nova', status: 'aberta' })
    );
  });
});

// ── DR-17: fornecedores_custo escrita restrita a gestor ──────────────────────

describe('DR-17 — fornecedores_custo: dual-role lê mas NÃO escreve', () => {
  test('DR-17a: dual-role garantia LÊ fornecedores_custo', async () => {
    await seed('fornecedores_custo', 'forn-2', { nome: 'LG', custo: 0.10 });
    await assertSucceeds(db(UID_DUAL_GARANTIA).collection('fornecedores_custo').doc('forn-2').get());
  });

  test('DR-17b: dual-role garantia NÃO ESCREVE fornecedores_custo', async () => {
    await assertFails(
      db(UID_DUAL_GARANTIA).collection('fornecedores_custo').doc('forn-new').set({ nome: 'Novo', custo: 0.08 })
    );
  });

  test('DR-17c: gestor ESCREVE fornecedores_custo', async () => {
    await assertSucceeds(
      db(UID_GESTOR).collection('fornecedores_custo').doc('forn-g').set({ nome: 'Gestor', custo: 0.15 })
    );
  });
});

// ── DR-18: clientes GC fields preservados com dual-role ──────────────────────

describe('DR-18 — clientes: dual-role respeita proteção de campos GC', () => {
  test('DR-18a: dual-role clientes cria cliente (sem campos GC)', async () => {
    await seed('sistema_usuarios', UID_DUAL_DEMANDAS, {
      nome: 'Fabiana', cargo: 'Vendedora', modulos: ['clientes'], admin: false, bloqueado: false
    });
    const UID_DUAL_CLIENTES = UID_DUAL_DEMANDAS; // reuse uid, update sistema_usuarios
    await assertSucceeds(
      db(UID_DUAL_CLIENTES).collection('clientes').doc('novo-cli').set({ nome: 'João', telefone: '88000000000' })
    );
  });

  test('DR-18b: dual-role NÃO cria cliente com campo gestaoClickId', async () => {
    await seed('sistema_usuarios', UID_DUAL_DEMANDAS, {
      nome: 'Fabiana', cargo: 'Vendedora', modulos: ['clientes'], admin: false, bloqueado: false
    });
    await assertFails(
      db(UID_DUAL_DEMANDAS).collection('clientes').doc('cli-gc').set({
        nome: 'João GC', gestaoClickId: 'GC-123'
      })
    );
  });
});
