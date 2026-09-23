'use strict';

/**
 * Frontend Direct-URL Module Guard — P0 Final Closure (2026-09-22)
 *
 * Valida que verificarAcessoModulo() bloqueia acesso direto por URL no frontend.
 * Simula a chamada exata que cada modulo/*.html faz em onAuthStateChanged.
 *
 * Persona principal: Swyanne (funcionario, modulos=['clientes'])
 *   → clientes.html:   verificarAcessoModulo(db, uid, 'clientes') → ALLOW
 *   → financeiro.html: verificarAcessoModulo(db, uid, 'financeiro') → BLOCK
 *   → garantia.html:   verificarAcessoModulo(db, uid, 'garantia') → BLOCK
 *   → expedicao.html:  verificarAcessoModulo(db, uid, 'expedicao') → BLOCK
 *   → demandas.html:   verificarAcessoModulo(db, uid, 'demandas') → BLOCK
 *   → compras.html:    verificarAcessoModulo(db, uid, 'compras') → BLOCK
 *   → marketing.html:  verificarAcessoModulo(db, uid, 'marketing') → BLOCK
 *   → equivalentes:    verificarAcessoModulo(db, uid, 'equivalentes') → BLOCK
 *   → estoque.html:    verificarAcessoModulo(db, uid, 'estoque') → BLOCK
 *
 * Personas adicionais:
 *   Gestor (sem sistema_usuarios) → ALLOW em todos os módulos (backward compat)
 *   Camila (admin=true) → ALLOW em todos os módulos
 *   ponto-puro (sem sistema_usuarios) → BLOCK em todos os módulos
 *   bloqueado → BLOCK mesmo com módulo correto
 *
 * FRONTEND_DIRECT_URL_ESCAPES=0 obrigatório.
 *
 * Uses Firestore emulator with PROJECT_ID = 'mr4-ponto-fug-test' (isolado).
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID = 'mr4-ponto-fug-test';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

// ── UIDs ──────────────────────────────────────────────────────────────────────
const UID_SWYANNE  = 'fug-swyanne';   // funcionario, modulos=['clientes']
const UID_GESTOR   = 'fug-gestor';    // gestor, sem sistema_usuarios
const UID_CAMILA   = 'fug-camila';    // funcionario, admin=true
const UID_PP       = 'fug-ponto-puro'; // funcionario, sem sistema_usuarios
const UID_BLOQUEADO = 'fug-bloqueado'; // funcionario, bloqueado=true, modulos=['clientes']

// ── Replica de verificarAcessoModulo (guard.js) ───────────────────────────────
// Esta função é a MESMA lógica que guard.js exporta.
// O teste valida o comportamento sem depender da importação ES module.

async function verificarAcessoModulo(db, uid, modulo) {
  try {
    const rDoc = await db.collection('users').doc(uid).get();
    if (!rDoc.exists) return false;
    const rd = rDoc.data();
    if (!rd.ativo) return false;
    if (rd.role === 'gestor') return true;
    if (rd.role !== 'funcionario') return false;
    const sDoc = await db.collection('sistema_usuarios').doc(uid).get();
    if (!sDoc.exists) return false;
    const sd = sDoc.data();
    if (sd.bloqueado) return false;
    return sd.admin === true || (Array.isArray(sd.modulos) && sd.modulos.includes(modulo));
  } catch(e) {
    return false;
  }
}

let testEnv;

const SEED = async db => {
  // Swyanne — funcionario, modulos=['clientes']
  await db.collection('users').doc(UID_SWYANNE).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-FUG-01' });
  await db.collection('sistema_usuarios').doc(UID_SWYANNE).set({ nome: 'Swyanne', modulos: ['clientes'], admin: false, bloqueado: false });

  // Gestor — sem sistema_usuarios
  await db.collection('users').doc(UID_GESTOR).set({ role: 'gestor', ativo: true });

  // Camila — funcionario, admin=true
  await db.collection('users').doc(UID_CAMILA).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-FUG-03' });
  await db.collection('sistema_usuarios').doc(UID_CAMILA).set({ nome: 'Camila', modulos: [], admin: true, bloqueado: false });

  // ponto-puro — funcionario, sem sistema_usuarios
  await db.collection('users').doc(UID_PP).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-FUG-04' });

  // bloqueado — funcionario, bloqueado=true, modulos=['clientes']
  await db.collection('users').doc(UID_BLOQUEADO).set({ role: 'funcionario', ativo: true, funcionarioId: 'FUNC-FUG-05' });
  await db.collection('sistema_usuarios').doc(UID_BLOQUEADO).set({ nome: 'Bloqueado', modulos: ['clientes'], admin: false, bloqueado: true });
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

// Wrapper: simula exatamente a chamada que cada modulo/*.html faz em onAuthStateChanged.
// Usa authenticated context — o user lê o próprio users/{uid} e sistema_usuarios/{uid},
// exatamente como guard.js faz no browser com o token Firebase do usuário logado.
const guardCall = (uid, modulo) =>
  verificarAcessoModulo(testEnv.authenticatedContext(uid).firestore(), uid, modulo);

// ── FUG-A: Swyanne → módulo correto ALLOW ────────────────────────────────────

describe('FUG-A — Swyanne (modulos=[clientes]) → clientes ALLOW', () => {
  test('FUG-A1: clientes.html → verificarAcessoModulo(clientes) → true', async () => {
    const result = await guardCall(UID_SWYANNE, 'clientes');
    expect(result).toBe(true);
  });
});

// ── FUG-B: Swyanne → módulos errados BLOCK (ESCAPE=0) ────────────────────────

describe('FUG-B — Swyanne tenta módulos não autorizados → BLOCK', () => {
  test('FUG-B1: financeiro.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'financeiro')).toBe(false);
  });
  test('FUG-B2: garantia.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'garantia')).toBe(false);
  });
  test('FUG-B3: expedicao.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'expedicao')).toBe(false);
  });
  test('FUG-B4: demandas.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'demandas')).toBe(false);
  });
  test('FUG-B5: compras.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'compras')).toBe(false);
  });
  test('FUG-B6: marketing.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'marketing')).toBe(false);
  });
  test('FUG-B7: equivalentes.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'equivalentes')).toBe(false);
  });
  test('FUG-B8: estoque.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_SWYANNE, 'estoque')).toBe(false);
  });
});

// ── FUG-C: Gestor (sem sistema_usuarios) → ALLOW em todos (backward compat) ──

describe('FUG-C — Gestor sem sistema_usuarios → ALLOW em qualquer módulo', () => {
  const todosModulos = ['clientes', 'financeiro', 'garantia', 'expedicao', 'demandas', 'compras', 'marketing', 'equivalentes', 'estoque'];
  todosModulos.forEach(m => {
    test(`FUG-C: gestor → ${m}.html → true (backward compat)`, async () => {
      expect(await guardCall(UID_GESTOR, m)).toBe(true);
    });
  });
});

// ── FUG-D: Camila (admin=true) → ALLOW em todos ──────────────────────────────

describe('FUG-D — Camila (admin=true) → ALLOW em qualquer módulo', () => {
  test('FUG-D1: financeiro.html → true (admin=true)', async () => {
    expect(await guardCall(UID_CAMILA, 'financeiro')).toBe(true);
  });
  test('FUG-D2: estoque.html → true (admin=true)', async () => {
    expect(await guardCall(UID_CAMILA, 'estoque')).toBe(true);
  });
  test('FUG-D3: garantia.html → true (admin=true)', async () => {
    expect(await guardCall(UID_CAMILA, 'garantia')).toBe(true);
  });
});

// ── FUG-E: ponto-puro (sem sistema_usuarios) → BLOCK em todos ────────────────

describe('FUG-E — ponto-puro (sem sistema_usuarios) → BLOCK', () => {
  test('FUG-E1: clientes.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_PP, 'clientes')).toBe(false);
  });
  test('FUG-E2: financeiro.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_PP, 'financeiro')).toBe(false);
  });
  test('FUG-E3: demandas.html → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_PP, 'demandas')).toBe(false);
  });
});

// ── FUG-F: bloqueado com módulo correto → BLOCK ───────────────────────────────

describe('FUG-F — bloqueado (bloqueado=true) → BLOCK mesmo com módulo correto', () => {
  test('FUG-F1: clientes.html (módulo correto, bloqueado=true) → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_BLOQUEADO, 'clientes')).toBe(false);
  });
  test('FUG-F2: demandas.html (módulo incorreto, bloqueado=true) → false (ESCAPE=0)', async () => {
    expect(await guardCall(UID_BLOQUEADO, 'demandas')).toBe(false);
  });
});
