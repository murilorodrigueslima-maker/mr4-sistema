'use strict';

/**
 * N27 — Testes unitários do OpenAIProvider (Responses API).
 *
 * LLM_REAL_CALLS = ZERO. fetch é mockado globalmente.
 * API key usada: chave sintética 'sk-test-SYNTHETIC-N27'
 * Nenhuma chamada real à API OpenAI.
 *
 * ENDPOINT verificado: /v1/responses (Responses API, não Chat Completions)
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
 *   N27-PROV-09: endpoint usado é /v1/responses (não /v1/chat/completions)
 *   N27-PROV-10: timeout AbortError é relançado após maxRetries
 *   N27-PROV-11: store=false está presente no body (privacidade)
 *   N27-PROV-12: usage usa input_tokens/output_tokens (Responses API, não prompt_tokens)
 */

const { OpenAIProvider, ENDPOINT_PATH } = require('../lib/ai/providers/openaiProvider');

const API_KEY_SINTETICA = 'sk-test-SYNTHETIC-N27';

// ── Helpers de mock ─────────────────────────────────────────────────────────

function responsesApiBody(conteudo, claims, model = 'gpt-5.6-luna') {
  return {
    id:     'resp_test_123',
    object: 'response',
    model,
    status: 'completed',
    output: [{
      type:    'message',
      role:    'assistant',
      content: [{
        type: 'output_text',
        text: JSON.stringify({ conteudo, claims }),
      }],
    }],
    usage: {
      input_tokens:  120,
      output_tokens:  80,
      total_tokens:  200,
      input_tokens_details:  { cached_tokens:    30 },
      output_tokens_details: { reasoning_tokens:  0 },
    },
  };
}

function mockOk(body) {
  return Promise.resolve({
    ok:     true,
    status: 200,
    text:   () => Promise.resolve(JSON.stringify(body)),
    json:   () => Promise.resolve(body),
  });
}

function mockErr(status, text) {
  return Promise.resolve({
    ok:   false,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.reject(new Error('not JSON')),
  });
}

// ── N27-PROV-01 ──────────────────────────────────────────────────────────────

test('N27-PROV-01: construtor sem API key lança erro', () => {
  const orig = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    expect(() => new OpenAIProvider()).toThrow(/OPENAI_API_KEY/);
  } finally {
    if (orig !== undefined) process.env.OPENAI_API_KEY = orig;
  }
});

// ── N27-PROV-02 ──────────────────────────────────────────────────────────────

test('N27-PROV-02: happy path retorna campos esperados', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });
  const claims   = [{ field: 'scoreTotal', value: 62 }];

  global.fetch = jest.fn().mockReturnValue(
    mockOk(responsesApiBody('O cliente apresenta histórico regular.', claims))
  );

  const res = await provider.complete('prompt de teste', { maxTokens: 200 });

  expect(typeof res.texto).toBe('string');
  expect(res.texto.length).toBeGreaterThan(0);
  expect(Array.isArray(res.claims)).toBe(true);
  expect(res.claims).toEqual(claims);
  expect(typeof res.tokens.input).toBe('number');
  expect(typeof res.tokens.output).toBe('number');
  expect(typeof res.latenciaMs).toBe('number');
  expect(res.mock).toBe(false);
}, 5000);

// ── N27-PROV-03 ──────────────────────────────────────────────────────────────

test('N27-PROV-03: resposta sem campo "conteudo" lança erro de schema', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  global.fetch = jest.fn().mockReturnValue(mockOk({
    id: 'resp_x', object: 'response', model: 'gpt-5.6-luna', status: 'completed',
    output: [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ claims: [] }) }],
    }],
    usage: {},
  }));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/conteudo/);
}, 5000);

// ── N27-PROV-04 ──────────────────────────────────────────────────────────────

test('N27-PROV-04: resposta sem campo "claims" lança erro de schema', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  global.fetch = jest.fn().mockReturnValue(mockOk({
    id: 'resp_x', object: 'response', model: 'gpt-5.6-luna', status: 'completed',
    output: [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ conteudo: 'texto ok' }) }],
    }],
    usage: {},
  }));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/claims/);
}, 5000);

// ── N27-PROV-05 ──────────────────────────────────────────────────────────────

test('N27-PROV-05: output_text não-JSON lança erro de parsing', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 1 });

  global.fetch = jest.fn().mockReturnValue(mockOk({
    id: 'resp_x', object: 'response', model: 'gpt-5.6-luna', status: 'completed',
    output: [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'isso não é json <<<' }],
    }],
    usage: {},
  }));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/JSON/);
}, 5000);

// ── N27-PROV-06 ──────────────────────────────────────────────────────────────

test('N27-PROV-06: HTTP 401 lança erro com status', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 1 });

  global.fetch = jest.fn().mockReturnValue(mockErr(401, 'Unauthorized'));

  await expect(provider.complete('prompt', {})).rejects.toThrow(/401/);
}, 5000);

// ── N27-PROV-07 ──────────────────────────────────────────────────────────────

test('N27-PROV-07: HTTP 429 com retry retorna sucesso na segunda tentativa', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 2 });
  const claims   = [{ field: 'diasSemComprar', value: 45 }];

  global.fetch = jest.fn()
    .mockReturnValueOnce(mockErr(429, 'Too Many Requests'))
    .mockReturnValue(mockOk(responsesApiBody('Análise ok.', claims)));

  const res = await provider.complete('prompt', { maxTokens: 200 });
  expect(res.texto).toBe('Análise ok.');
  expect(res.tentativas).toBe(2);
}, 10000);

// ── N27-PROV-08 ──────────────────────────────────────────────────────────────

test('N27-PROV-08: claims com tipos mistos (number + string) preservados', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });
  const claims   = [
    { field: 'scoreTotal',    value: 55 },
    { field: 'tendencia',     value: 'ESTAVEL' },
    { field: 'diasSemComprar', value: 30 },
  ];

  global.fetch = jest.fn().mockReturnValue(
    mockOk(responsesApiBody('Análise com múltiplos claims.', claims))
  );

  const res = await provider.complete('prompt', {});
  expect(res.claims).toHaveLength(3);
  expect(res.claims[0]).toEqual({ field: 'scoreTotal',     value: 55 });
  expect(res.claims[1]).toEqual({ field: 'tendencia',      value: 'ESTAVEL' });
  expect(res.claims[2]).toEqual({ field: 'diasSemComprar', value: 30 });
}, 5000);

// ── N27-PROV-09 ──────────────────────────────────────────────────────────────

test('N27-PROV-09: endpoint chamado é /v1/responses (Responses API)', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  let capturedUrl;
  global.fetch = jest.fn().mockImplementation((url, _opts) => {
    capturedUrl = url;
    return mockOk(responsesApiBody('ok', []));
  });

  await provider.complete('prompt', {});

  expect(capturedUrl).toContain(ENDPOINT_PATH);          // contém /responses
  expect(capturedUrl).not.toContain('/chat/completions'); // NÃO é Chat Completions
}, 5000);

// ── N27-PROV-10 ──────────────────────────────────────────────────────────────

test('N27-PROV-10: AbortError (timeout) é relançado após maxRetries', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA, maxRetries: 1, timeout: 50 });

  global.fetch = jest.fn().mockImplementation(() => {
    const err = new Error('The operation was aborted');
    err.name  = 'AbortError';
    return Promise.reject(err);
  });

  await expect(provider.complete('prompt', {})).rejects.toThrow('aborted');
}, 5000);

// ── N27-PROV-11 ──────────────────────────────────────────────────────────────

test('N27-PROV-11: store=false presente no body (privacidade)', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  let capturedBody;
  global.fetch = jest.fn().mockImplementation((_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return mockOk(responsesApiBody('ok', []));
  });

  await provider.complete('prompt', {});

  expect(capturedBody.store).toBe(false);
}, 5000);

// ── N27-PROV-12 ──────────────────────────────────────────────────────────────

test('N27-PROV-12: tokens mapeados de input_tokens/output_tokens (Responses API)', async () => {
  const provider = new OpenAIProvider({ apiKey: API_KEY_SINTETICA });

  global.fetch = jest.fn().mockReturnValue(
    mockOk(responsesApiBody('texto', []))
  );

  const res = await provider.complete('prompt', {});

  // Responses API usa input_tokens/output_tokens (não prompt_tokens/completion_tokens)
  expect(res.tokens.input).toBe(120);
  expect(res.tokens.output).toBe(80);
  expect(res.tokens.cachedInput).toBe(30);
  expect(res.tokens.reasoning).toBe(0);
}, 5000);

// ── Limpeza ───────────────────────────────────────────────────────────────────

afterEach(() => {
  if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
  if (global.fetch && typeof global.fetch.mockReset === 'function') global.fetch.mockReset();
});
