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

// ── F18 — preco_custo = NaN → invalid-argument ────────────────────────────────
test('F18 — preco_custo NaN → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: NaN },
    })),
    'invalid-argument'
  );
});

// ── F19 — preco_custo = string → invalid-argument ─────────────────────────────
test('F19 — preco_custo string ("abc") → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: 'abc' },
    })),
    'invalid-argument'
  );
});

// ── F20 — preco_venda = string → invalid-argument (presente e inválido = rejeita tudo) ──
test('F20 — preco_venda string → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '42', preco_custo: 50, preco_venda: 'invalido' },
    })),
    'invalid-argument'
  );
});

// ── F21 — sem credenciais GC (env vazio) → internal ──────────────────────────
test('F21 — env GC_ACCESS_TOKEN ausente → internal', async () => {
  const savedToken  = process.env.GC_ACCESS_TOKEN;
  const savedSecret = process.env.GC_SECRET_ACCESS_TOKEN;
  delete process.env.GC_ACCESS_TOKEN;
  delete process.env.GC_SECRET_ACCESS_TOKEN;

  try {
    await expectError(
      _gcQueryHandler(req(UID_GESTOR_CALC, { operacao: 'LISTAR_PRODUTOS', dados: { limite: 10 } })),
      'internal'
    );
  } finally {
    process.env.GC_ACCESS_TOKEN        = savedToken;
    process.env.GC_SECRET_ACCESS_TOKEN = savedSecret;
  }
});

// ── F22 — PESQUISAR_CLIENTES: DTO não contém CPF/CNPJ ────────────────────────
test('F22 — PESQUISAR_CLIENTES DTO exclui CPF e CNPJ', async () => {
  const GC_CLIENTE_COMPLETO = {
    data: [{
      id: 99, nome: 'João Silva', cidade: 'Fortaleza', telefone: '(85)99999-0000',
      cpf: '000.000.000-00', cnpj: '00.000.000/0001-00', email: 'joao@example.com',
      endereco: 'Rua A, 123', limite_credito: 5000,
    }],
    meta: { pagina_atual: 1, total_paginas: 1, total_registros: 1 },
  };
  mockFetchImpl = () => Promise.resolve({
    ok: true, status: 200,
    json: async () => GC_CLIENTE_COMPLETO,
    text: async () => JSON.stringify(GC_CLIENTE_COMPLETO),
  });

  const result = await _gcQueryHandler(req(UID_GESTOR_CALC, {
    operacao: 'PESQUISAR_CLIENTES',
    dados: { busca: 'João', limite: 5 },
  }));

  expect(Array.isArray(result.data)).toBe(true);
  expect(result.data.length).toBe(1);
  const cliente = result.data[0];
  // Campos proibidos não devem existir no DTO
  expect(cliente).not.toHaveProperty('cpf');
  expect(cliente).not.toHaveProperty('cnpj');
  expect(cliente).not.toHaveProperty('email');
  expect(cliente).not.toHaveProperty('endereco');
  expect(cliente).not.toHaveProperty('limite_credito');
  // Campos permitidos presentes
  expect(cliente).toHaveProperty('id');
  expect(cliente).toHaveProperty('nome');
  expect(cliente).toHaveProperty('cidade');
  expect(cliente).toHaveProperty('telefone');
});

// ── F24 — preco_custo Infinity → invalid-argument ─────────────────────────────
test('F24 — preco_custo Infinity → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: Infinity },
    })),
    'invalid-argument'
  );
});

// ── F25 — preco_venda NaN → invalid-argument ──────────────────────────────────
test('F25 — preco_venda NaN → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: 50, preco_venda: NaN },
    })),
    'invalid-argument'
  );
});

// ── F26 — preco_venda Infinity → invalid-argument ─────────────────────────────
test('F26 — preco_venda Infinity → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: 50, preco_venda: Infinity },
    })),
    'invalid-argument'
  );
});

// ── F27 — preco_venda negativo → invalid-argument ─────────────────────────────
test('F27 — preco_venda negativo → invalid-argument', async () => {
  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '123', preco_custo: 50, preco_venda: -10 },
    })),
    'invalid-argument'
  );
});

// ── F28 — preco_venda ausente → ALLOWED (campo opcional) ─────────────────────
test('F28 — preco_venda ausente → ALLOWED, retorna { ok: true }', async () => {
  const gcCalls = [];
  mockFetchImpl = (url, opts) => {
    gcCalls.push({ url, method: opts?.method });
    if (!opts || opts.method !== 'PUT') {
      return Promise.resolve({ ok: true, status: 200, json: async () => GC_RESP_ITEM, text: async () => '{}' });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
  };

  const result = await _gcQueryHandler(req(UID_GESTOR_CALC, {
    operacao: 'ATUALIZAR_PRECO',
    dados: { produtoId: '42', preco_custo: 55 },
  }));
  expect(result).toEqual({ ok: true });
  // Deve ter feito o PUT ao GC (sem preco_venda no body)
  const put = gcCalls.find(c => c.method === 'PUT');
  expect(put).toBeDefined();
});

// ── F29 — atualização parcial bloqueada (custo válido + venda inválido) ────────
// Operação inteira deve falhar; nenhum PUT deve chegar ao GestãoClick.
test('F29 — custo válido + venda inválida → rejeita tudo, zero PUTs no GC', async () => {
  const gcCalls = [];
  mockFetchImpl = (url, opts) => {
    gcCalls.push({ url, method: opts?.method });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
  };

  await expectError(
    _gcQueryHandler(req(UID_GESTOR_CALC, {
      operacao: 'ATUALIZAR_PRECO',
      dados: { produtoId: '42', preco_custo: 55, preco_venda: 'invalido' },
    })),
    'invalid-argument'
  );
  // A validação joga antes de qualquer chamada HTTP
  const puts = gcCalls.filter(c => c.method === 'PUT');
  expect(puts.length).toBe(0);
  // Nenhuma chamada ao GC deve ter ocorrido (nem GET de preço anterior)
  expect(gcCalls.length).toBe(0);
});

// ── F23 — PESQUISAR_CLIENTES: sanitização do parâmetro busca ─────────────────
// Caracteres fora do charset permitido devem ser removidos antes de enviar à GC.
test('F23 — busca com caracteres especiais é sanitizada antes de enviar à GC', async () => {
  const urlsChamadas = [];
  mockFetchImpl = (url, opts) => {
    urlsChamadas.push(url);
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ data: [], meta: { pagina_atual: 1, total_paginas: 1, total_registros: 0 } }),
      text: async () => '{}',
    });
  };

  await _gcQueryHandler(req(UID_GESTOR_CALC, {
    operacao: 'PESQUISAR_CLIENTES',
    dados: { busca: 'João<script>alert(1)</script>', limite: 5 },
  }));

  expect(urlsChamadas.length).toBeGreaterThan(0);
  const url = urlsChamadas[0];
  // A URL não deve conter as tags ou caracteres de script
  expect(url).not.toContain('<script>');
  expect(url).not.toContain('</script>');
  expect(url).not.toContain('alert(1)');
  // Deve conter a parte válida do nome sanitizado
  expect(url).toContain('nome=Jo%C3%A3o');
});
