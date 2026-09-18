'use strict';

/**
 * N27 — Testes unitários do OpenAIProvider.
 *
 * LLM_REAL_CALLS = ZERO. fetch é mockado globalmente.
 * API key usada: chave sintética 'sk-test-SYNTHETIC-N27'
 * Nenhuma chamada real à API OpenAI.
 *
 * Casos cobertos:
 *   N27-PROV-01: construtor sem API key lança erro
 *   N27-PROV-02: happy path retorna { texto, claims, tokens, modelo, latenciaMs }
 *   N27-PROV-03: resposta sem campo "conteudo" lança erro de schema
 *   N27-PROV-04: resposta sem campo "claims" lança erro de schema
 *   N27-PROV-05: resposta não-JSON lança erro de parsing
 *   N27-PROV-06: HTTP 401 lança erro com status
 *   N27-PROV-07: HTTP 429 com retry retorna sucesso na segunda tentativa
 *   N27-PROV-08: claims são passados corretamente para o output
 *   N27-PROV-09: Authorization header contém Bearer token (sem logar valor)
 *   N27-PROV-10: timeout AbortError é relançado após maxRetries
 */

const { OpenAIProvider } = require('../lib/ai/providers/openaiProvider');

const API_KEY_SINTETICA = 'sk-test-SYNTHETIC-N27';

// ── Helpers de mock ──────────────────────────────────────────────────────────

function mockResponseOk(body, status = 200) {
  return Promise.resolve({
    ok:     status >= 200 && status < 300,
    status,
    text:   () => Promise.resolve(JSON.stringify(body)),
    json:   () => Promise.resolve(body),
  });
}

function mockResponseError(status, text) {
  return Promise.resolve({
    ok:   false,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.reject(new Error('not JSON')),
  });
}

function openaiBody(conteudo, claims, model = 'gpt-5.6-luna') {
  return {
    model,
    choices: [{
      message:       { content: JSON.stringify({ conteudo, claims }) },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens:      120,
      completion_tokens:  80,
      total_tokens:       200,
      prompt_tokens_details:     { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

// ── N27-PROV-01 ────────────────────────────────────────────────────────────────

test('N27-PROV-01: construtor sem API key lança erro', () => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    expect(() => new OpenAIProvider()).toThrow(/OPENAI_API_KEY/);
  } finally {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
  }
});

// ── N27-PROV-02 ────────────────────────────────────────────────────────────────

test('N27-PROV-02: happy path retorna campos esperados', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });
  const claims = [{ field: 'scoreTotal', value: 62 }];

  global.fetch = jest.fn().mockReturnValue(mockResponseOk(openaiBody(
    'O cliente apresenta histórico regular de compras.',
    claims
  )));

  const res = await provider.complete('prompt de teste', { maxTokens: 200 });

  expect(typeof res.texto).toBe('string');
  expect(res.texto.length).toBeGreaterThan(0);
  expect(Array.isArray(res.claims)).toBe(true);
  expect(res.claims).toEqual(claims);
  expect(typeof res.tokens).toBe('object');
  expect(typeof res.tokens.input).toBe('number');
  expect(typeof res.tokens.output).toBe('number');
  expect(typeof res.latenciaMs).toBe('number');
  expect(res.mock).toBe(false);
}, 5000);

// ── N27-PROV-03 ────────────────────────────────────────────────────────────────

test('N27-PROV-03: resposta sem campo "conteudo" lança erro de schema', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  global.fetch = jest.fn().mockReturnValue(mockResponseOk({
    model: 'gpt-5.6-luna',
    choices: [{
      message:       { content: JSON.stringify({ claims: [] }) }, // sem conteudo
      finish_reason: 'stop',
    }],
    usage: {},
  }));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/conteudo/);
}, 5000);

// ── N27-PROV-04 ────────────────────────────────────────────────────────────────

test('N27-PROV-04: resposta sem campo "claims" lança erro de schema', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  global.fetch = jest.fn().mockReturnValue(mockResponseOk({
    model: 'gpt-5.6-luna',
    choices: [{
      message:       { content: JSON.stringify({ conteudo: 'texto ok' }) }, // sem claims
      finish_reason: 'stop',
    }],
    usage: {},
  }));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/claims/);
}, 5000);

// ── N27-PROV-05 ────────────────────────────────────────────────────────────────

test('N27-PROV-05: resposta não-JSON lança erro de parsing', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 1 });

  global.fetch = jest.fn().mockReturnValue(Promise.resolve({
    ok:   true,
    status: 200,
    json: () => Promise.resolve({
      model: 'gpt-5.6-luna',
      choices: [{
        message:       { content: 'isso nao e json valido <<<' },
        finish_reason: 'stop',
      }],
      usage: {},
    }),
  }));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/JSON/);
}, 5000);

// ── N27-PROV-06 ────────────────────────────────────────────────────────────────

test('N27-PROV-06: HTTP 401 lança erro com status', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 1 });

  global.fetch = jest.fn().mockReturnValue(mockResponseError(401, 'Unauthorized'));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/401/);
}, 5000);

// ── N27-PROV-07 ────────────────────────────────────────────────────────────────

test('N27-PROV-07: HTTP 429 com retry retorna sucesso na segunda tentativa', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 2 });
  const claims = [{ field: 'diasSemComprar', value: 45 }];

  global.fetch = jest.fn()
    .mockReturnValueOnce(mockResponseError(429, 'Too Many Requests'))
    .mockReturnValue(mockResponseOk(openaiBody('Análise ok.', claims)));

  const res = await provider.complete('prompt', { maxTokens: 200 });
  expect(res.texto).toBe('Análise ok.');
  expect(res.tentativas).toBe(2);
}, 10000);

// ── N27-PROV-08 ────────────────────────────────────────────────────────────────

test('N27-PROV-08: claims são preservados intactos no resultado', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });
  const claims = [
    { field: 'scoreTotal',   value: 55 },
    { field: 'tendencia',    value: 'ESTAVEL' },
    { field: 'diasSemComprar', value: 30 },
  ];

  global.fetch = jest.fn().mockReturnValue(
    mockResponseOk(openaiBody('Análise com múltiplos claims.', claims))
  );

  const res = await provider.complete('prompt', {});
  expect(res.claims).toHaveLength(3);
  expect(res.claims[0]).toEqual({ field: 'scoreTotal', value: 55 });
  expect(res.claims[1]).toEqual({ field: 'tendencia',  value: 'ESTAVEL' });
  expect(res.claims[2]).toEqual({ field: 'diasSemComprar', value: 30 });
}, 5000);

// ── N27-PROV-09 ────────────────────────────────────────────────────────────────

test('N27-PROV-09: cabeçalho Authorization usa Bearer (sem logar valor da chave)', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  let capturedHeaders;
  global.fetch = jest.fn().mockImplementation((url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponseOk(openaiBody('ok', []));
  });

  await provider.complete('prompt', {});

  expect(capturedHeaders).toBeDefined();
  expect(capturedHeaders['Authorization']).toMatch(/^Bearer /);
  // Não logamos o valor real — verificamos apenas o formato
  expect(capturedHeaders['Authorization'].startsWith('Bearer sk-')).toBe(true);
}, 5000);

// ── N27-PROV-10 ────────────────────────────────────────────────────────────────

test('N27-PROV-10: AbortError (timeout) é relançado após maxRetries', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 1, timeout: 50 });

  global.fetch = jest.fn().mockImplementation(() => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  });

  await expect(provider.complete('prompt', {})).rejects.toThrow('aborted');
}, 5000);

// ── Limpeza ───────────────────────────────────────────────────────────────────

afterEach(() => {
  if (global.fetch && global.fetch.mockRestore) {
    global.fetch.mockRestore();
  }
});
