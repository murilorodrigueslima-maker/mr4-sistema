'use strict';

/**
 * MOCK-PROT-01 → MOCK-PROT-04
 * Testa proteção do MockProvider por ambiente — N19 (MOCK).
 */

const { criarProvider, MODOS_MOCK_PERMITIDOS, getModoExecucao } = require('../lib/ai/provider');

// ── Proteção: modos bloqueados ────────────────────────────────────────────────

describe('MOCK — proteção por ambiente', () => {

  test('MOCK-PROT-01: NODE_ENV=production sem flag → lança erro', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => criarProvider('mock')).toThrow(/bloqueado em modo/i);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  test('MOCK-PROT-02: NODE_ENV=staging sem flag → lança erro', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    try {
      expect(() => criarProvider('mock')).toThrow(/bloqueado em modo/i);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  test('MOCK-PROT-03: NODE_ENV=production COM flag explícita → permitido', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => criarProvider('mock', { permitirMockEmProducao: true })).not.toThrow();
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  test('MOCK-PROT-04: NODE_ENV=test (padrão Jest) → permitido', () => {
    // Jest seta NODE_ENV=test automaticamente
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => criarProvider('mock')).not.toThrow();
  });
});

// ── Modos permitidos: cobertura completa ──────────────────────────────────────

describe('MOCK — todos os modos permitidos funcionam', () => {
  const MODOS = ['test', 'development', 'simulation', 'offline'];

  for (const modo of MODOS) {
    test(`modo "${modo}" → permitido`, () => {
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = modo;
      try {
        expect(() => criarProvider('mock')).not.toThrow();
      } finally {
        process.env.NODE_ENV = orig;
      }
    });
  }
});

// ── getModoExecucao e MODOS_MOCK_PERMITIDOS ───────────────────────────────────

test('getModoExecucao retorna string lowercase', () => {
  const modo = getModoExecucao();
  expect(typeof modo).toBe('string');
  expect(modo).toBe(modo.toLowerCase());
});

test('MODOS_MOCK_PERMITIDOS é Set com modos esperados', () => {
  expect(MODOS_MOCK_PERMITIDOS instanceof Set).toBe(true);
  expect(MODOS_MOCK_PERMITIDOS.has('test')).toBe(true);
  expect(MODOS_MOCK_PERMITIDOS.has('development')).toBe(true);
  expect(MODOS_MOCK_PERMITIDOS.has('production')).toBe(false);
});
