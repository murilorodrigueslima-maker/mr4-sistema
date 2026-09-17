'use strict';

/**
 * PROVIDER-V1-01 → PROVIDER-V1-02
 * Mock bloqueado em production; nenhuma chamada externa — N25.
 */

const { criarProvider, MockProvider, getModoExecucao, MODOS_MOCK_PERMITIDOS } = require('../lib/ai/provider');
const { verificarInterfaceProvider } = require('../lib/ai/providers/realProvider.interface');

// ── PROVIDER-V1-01: Mock bloqueado em production ──────────────────────────────

test('PROVIDER-V1-01: criarProvider("mock") em NODE_ENV=production lança erro', () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    expect(() => criarProvider('mock')).toThrow('bloqueado em modo "production"');
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('PROVIDER-V1-01b: em NODE_ENV=test MockProvider é permitido', () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    expect(() => criarProvider('mock')).not.toThrow();
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('PROVIDER-V1-01c: modos permitidos incluem test, development, simulation, offline', () => {
  for (const modo of ['test', 'development', 'simulation', 'offline']) {
    expect(MODOS_MOCK_PERMITIDOS.has(modo)).toBe(true);
  }
});

test('PROVIDER-V1-01d: staging NÃO está nos modos permitidos por padrão', () => {
  expect(MODOS_MOCK_PERMITIDOS.has('staging')).toBe(false);
});

// ── PROVIDER-V1-02: nenhuma chamada externa acontece ─────────────────────────

test('PROVIDER-V1-02: MockProvider não faz chamadas externas (mock:true em toda resposta)', async () => {
  const provider = new MockProvider();
  const resultado = await provider.complete('prompt de teste', { chave: 'ANALISE_CLIENTE' });
  expect(resultado.mock).toBe(true);
  expect(resultado.latenciaMs).toBe(0);  // sem latência real = sem chamada externa
  expect(resultado.modelo).toBe('mock-model');
});

test('PROVIDER-V1-02b: tipo desconhecido ("anthropic") lança erro imediatamente', () => {
  expect(() => criarProvider('anthropic')).toThrow('não suportado');
});

test('PROVIDER-V1-02c: tipo "openai" lança erro imediatamente', () => {
  expect(() => criarProvider('openai')).toThrow('não suportado');
});

test('PROVIDER-V1-02d: tipo "gemini" lança erro imediatamente', () => {
  expect(() => criarProvider('gemini')).toThrow('não suportado');
});

// ── PROVIDER-V1-03: interface de provider real é verificável ─────────────────

test('PROVIDER-V1-03: MockProvider satisfaz interface de provider', () => {
  const provider = new MockProvider();
  expect(() => verificarInterfaceProvider(provider)).not.toThrow();
});

test('PROVIDER-V1-03b: objeto sem complete() não satisfaz interface', () => {
  expect(() => verificarInterfaceProvider({ nome: 'x' })).toThrow('complete');
});

test('PROVIDER-V1-03c: objeto sem nome não satisfaz interface', () => {
  expect(() => verificarInterfaceProvider({ complete: async () => {} })).toThrow('nome');
});
