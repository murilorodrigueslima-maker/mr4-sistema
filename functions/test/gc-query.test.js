'use strict';

/**
 * Testes de segurança — gcQuery (S2)
 *
 * Testa o handler _gcQueryHandler diretamente contra o emulador Firestore/Auth.
 * fetch() é mockado para nunca chamar o GestãoClick de verdade.
 *
 * Cenários obrigatórios (S2 spec §12):
 *   F01 — sem Firebase Auth → DENIED (unauthenticated)
 *   F02 — token inválido (auth null) → DENIED
 *   F03 — usuário inexistente (sem users/{uid}) → DENIED
 *   F04 — ativo=false → DENIED
 *   F05 — gestor sem módulo → DENIED
 *   F06 — módulo correto → ALLOWED
 *   F07 — operação inexistente → DENIED
 *   F08 — parâmetro fora do limite (limite > 200) → DENIED
 *   F09 — pagina fora do limite → DENIED
 *   F10 — produtoId inválido (não numérico) → DENIED
 *   F11 — tentativa de controlar endpoint (via dados.endpoint) → ignorado (não vaza)
 *   F12 — tentativa de controlar método HTTP (via dados.method) → ignorado
 *   F13 — campos extras em ATUALIZAR_PRECO → DENIED
 *   F14 — ATUALIZAR_PRECO sem módulo calculadora → DENIED
 *   F15 — ATUALIZAR_PRECO com módulo calculadora → ALLOWED
 *   F16 — preco_custo negativo → DENIED
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=gc-query
 */

process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

// Credenciais GC mockadas — nunca chegam ao GestãoClick real
process.env.GC_ACCESS_TOKEN        = 'mock-access-token-test';
process.env.GC_SECRET_ACCESS_TOKEN = 'mock-secret-token-test';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const db = admin.firestore();

const { _gcQueryHandler } = require('../index');
const { HttpsError }      = require('firebase-functions/v2/https');

// ── UIDs de teste ─────────────────────────────────────────────────────────────
const UID_GESTOR_CALC    = 'uid-gc-gestor-calculadora';
const UID_GESTOR_SEM_MOD = 'uid-gc-gestor-sem-modulo';
const UID_INATIVO        = 'uid-gc-gestor-inativo';
const UID_SEM_PERFIL     = 'uid-gc-sem-perfil';
const UID_FUNC           = 'uid-gc-funcionario';

// ── Mock fetch global ─────────────────────────────────────────────────────────
// Resposta padrão GC: lista vazia, meta pagina 1/1
const GC_RESP_LIST = { data: [], meta: { pagina_atual: 1, total_paginas: 1, total_registros: 0 } };
const GC_RESP_ITEM = { id: 42, nome: 'Produto X', codigo: 'PX001', preco_venda: 100, preco_custo: 60, estoque_atual: 5 };
const GC_RESP_OK   = {};

let mockFetchImpl = null;

beforeAll(async () => {
  // Mock global fetch — Cloud Function usa fetch() nativo do Node 18
  global.fetch = jest.fn((...args) => {
    if (mockFetchImpl) return mockFetchImpl(...args);
    // Default: retorna lista vazia
    return Promise.resolve({
      ok: true,
      status: 200,
      json:   async () => GC_RESP_LIST,
      text:   async () => JSON.stringify(GC_RESP_LIST),
    });
  });

  // Seed emulador
  await db.collection('users').doc(UID_GESTOR_CALC).set({ role: 'gestor', ativo: true, nome: 'Gestor Calc' });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_CALC).set({ modulos: ['calculadora', 'garantia', 'compras', 'expedicao'], admin: false });

  await db.collection('users').doc(UID_GESTOR_SEM_MOD).set({ role: 'gestor', ativo: true, nome: 'Gestor Sem Mod' });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_SEM_MOD).set({ modulos: [], admin: false });

  await db.collection('users').doc(UID_INATIVO).set({ role: 'gestor', ativo: false, nome: 'Gestor Inativo' });
  await db.collection('sistema_usuarios').doc(UID_INATIVO).set({ modulos: ['calculadora'], admin: false });

  await db.collection('users').doc(UID_FUNC).set({ role: 'funcionario', ativo: true, nome: 'Func GC' });
  // UID_SEM_PERFIL — sem documento em users/
});

afterAll(async () => {
  await admin.app().delete();
});

afterEach(() => {
  jest.clearAllMocks();
  mockFetchImpl = null;
});

// Helpers
function req(uid, data = {}) { return { auth: { uid, token: {} }, data }; }
function reqSemAuth(data = {}) { return { auth: null, data }; }

async function expectDenied(promise, code) {
  await expect(promise).rejects.toMatchObject({ code: code || expect.stringContaining('') });
}
async function expectError(promise, codeExpected) {
  try {
    await promise;
    throw new Error('Deveria ter lançado HttpsError');
  } catch (e) {
    if (!(e instanceof HttpsError)) throw e;
    if (codeExpected) expect(e.code).toBe(codeExpected);
  }
}

// ── F01 — sem Firebase Auth ───────────────────────────────────────────────────
test('F01 — sem auth → unauthenticated', async () => {
  await expectError(
    _gcQueryHandler(reqSemAuth({ operacao: 'LISTAR_PRODUTOS' })),
    'unauthenticated'
  );
});

// ── F02 — auth null (token inválido / expirado) ───────────────────────────────
test('F02 — auth null → unauthenticated', async () => {
  await expectError(
    _gcQueryHandler({ auth: null, data: { operacao: 'LISTAR_PRODUTOS' } }),
    'unauthenticated'
  );
});

// ── F03 — usuário inexistente em users/ ──────────────────────────────────────
test('F03 — usuário sem perfil em users/ → permission-denied', async () => {
  await expectError(
    _gcQueryHandler(req(UID_SEM_PERFIL, { operacao: 'LISTAR_PRODUTOS' })),
    'permission-denied'
  );
});

// ── F04 — gestor com ativo=false ──────────────────────────────────────────────
test('F04 — ativo=false → permission-denied', async () => {
  await expectError(
    _gcQueryHandler(req(UID_INATIVO, { operacao: 'LISTAR_PRODUTOS' })),
    'permission-denied'
  );
});

// ── F05 — gestor sem módulo requisitado ──────────────────────────────────────
test('F05 — gestor sem módulo → permission-denied', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_SEM_MOD, { operacao: 'LISTAR_PRODUTOS' })),
    'permission-denied'
  );
});

// ── F06 — módulo correto → ALLOWED ───────────────────────────────────────────
test('F06 — módulo calculadora → LISTAR_PRODUTOS ALLOWED', async () => {
  const result = await _gcQueryHandler(req(UID_GESTOR_CALC, { operacao: 'LISTAR_PRODUTOS', dados: { limite: 10 } }));
  expect(result).toHaveProperty('data');
  expect(Array.isArray(result.data)).toBe(true);
});

// ── F07 — operação inexistente ────────────────────────────────────────────────
test('F07 — operação desconhecida → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, { operacao: 'DELETAR_TUDO' })),
    'invalid-argument'
  );
});

// ── F08 — limite > 200 ────────────────────────────────────────────────────────
test('F08 — limite=500 → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, { operacao: 'LISTAR_PRODUTOS', dados: { limite: 500 } })),
    'invalid-argument'
  );
});

// ── F09 — pagina fora do limite ───────────────────────────────────────────────
test('F09 — pagina=999 → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, { operacao: 'LISTAR_PRODUTOS', dados: { pagina: 999 } })),
    'invalid-argument'
  );
});

// ── F10 — produtoId inválido ──────────────────────────────────────────────────
test('F10 — produtoId não numérico → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, { operacao: 'CONSULTAR_PRODUTO', dados: { produtoId: 'abc;DROP' } })),
    'invalid-argument'
  );
});

// ── F11 — tentativa de controlar endpoint via dados ───────────────────────────
test('F11 — endpoint arbitrário em dados ignorado; GC chamado com path correto', async () => {
  const calls = [];
  mockFetchImpl = (url, opts) => {
    calls.push({ url, method: opts?.method });
    return Promise.resolve({ ok: true, status: 200, json: async () => GC_RESP_LIST, text: async () => '{}' });
  };

  await _gcQueryHandler(req(UID_GESTOR_CALC, {
    operacao: 'LISTAR_PRODUTOS',
    dados: { endpoint: '/evil/path', limit: 10 },
  }));

  // Deve ter chamado o URL real de /produtos, não /evil/path
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(c => c.url.includes('/produtos'))).toBe(true);
  expect(calls.every(c => !c.url.includes('/evil'))).toBe(true);
});

// ── F12 — tentativa de controlar método HTTP ──────────────────────────────────
test('F12 — method arbitrário em dados ignorado; GC chamado com método fixo', async () => {
  const methods = [];
  mockFetchImpl = (url, opts) => {
    methods.push(opts?.method || 'GET');
    return Promise.resolve({ ok: true, status: 200, json: async () => GC_RESP_LIST, text: async () => '{}' });
  };

  await _gcQueryHandler(req(UID_GESTOR_CALC, {
    operacao: 'LISTAR_PRODUTOS',
    dados: { method: 'DELETE', 'Content-Type': 'text/html' },
  }));

  // Método deve ser GET (definido pelo servidor, não pelo cliente)
  expect(methods.length).toBeGreaterThan(0);
  expect(methods.every(m => m === 'GET')).toBe(true);
});

// ── F13 — campos extras em ATUALIZAR_PRECO ────────────────────────────────────
test('F13 — campo extra em ATUALIZAR_PRECO → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: 10, campo_malicioso: 'hack' },
    })),
    'invalid-argument'
  );
});

// ── F14 — ATUALIZAR_PRECO sem módulo calculadora ──────────────────────────────
test('F14 — ATUALIZAR_PRECO com gestor sem módulo calculadora → permission-denied', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_SEM_MOD, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: 10 },
    })),
    'permission-denied'
  );
});

// ── F15 — ATUALIZAR_PRECO com módulo correto → ALLOWED ───────────────────────
test('F15 — ATUALIZAR_PRECO com calculadora → ALLOWED (retorna { ok: true })', async () => {
  mockFetchImpl = (url, opts) => {
    if (!opts || opts.method !== 'PUT') {
      // Requisição de preço anterior (GET)
      return Promise.resolve({ ok: true, status: 200, json: async () => GC_RESP_ITEM, text: async () => '{}' });
    }
    // Requisição de atualização (PUT)
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
  };

  const result = await _gcQueryHandler(req(UID_GESTOR_CALC, {
    operacao: 'ATUALIZAR_PRECO',
    dados: { produtoId: '42', preco_custo: 55.00, preco_venda: 110.00 },
  }));

  expect(result).toEqual({ ok: true });
});

// ── F16 — preco_custo negativo ────────────────────────────────────────────────
test('F16 — preco_custo negativo → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: -5 },
    })),
    'invalid-argument'
  );
});

// ── F17 — funcionário não acessa gcQuery ─────────────────────────────────────
test('F17 — funcionário → permission-denied', async () => {
  await expectError(
    _gcQueryHandler(req(UID_FUNC, { operacao: 'LISTAR_PRODUTOS' })),
    'permission-denied'
  );
});
