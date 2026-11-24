'use strict';
// Etapa A · A0 — camada HTTP segura (gcHttp.criarCliente). Sem rede, sem credenciais reais.
const { criarCliente, criarTransporteHttps, GcErro, CODIGOS, BASE } = require('../lib/gcHttp');
const { EventEmitter } = require('events');

const SEG_A = 'SEGREDO-ACESSO-FAKE-123', SEG_S = 'SEGREDO-SECRETO-FAKE-456', CORPO_SECRETO = 'CORPO-BRUTO-SENSIVEL-XYZ';
const OK = (data = [{ id: '1' }], meta = { total_registros: 1, total_paginas: 1, pagina_atual: 1, limite_por_pagina: 100, proxima_pagina: null }) => ({ code: 200, status: 'success', meta, data });

function resp(status, corpo, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: k => headers[String(k).toLowerCase()] ?? null }, json: async () => { if (corpo === undefined) throw new SyntaxError('Unexpected end'); if (typeof corpo === 'string') throw new SyntaxError('Unexpected token'); return corpo; } };
}
/** transporte simulado que responde conforme uma fila */
function fila(...itens) {
  const chamadas = [];
  const transporte = async (url, opts) => { chamadas.push({ url, opts }); const x = itens.length > 1 ? itens.shift() : itens[0]; if (x instanceof Error) throw x; return typeof x === 'function' ? x() : x; };
  return { transporte, chamadas };
}
function cliente(f, extra = {}) {
  const esperas = [];
  const c = criarCliente({ transporte: f.transporte, credenciais: { access: SEG_A, secret: SEG_S }, dormir: async ms => { esperas.push(ms); }, ...extra });
  return { c, esperas };
}
const falha = async p => { try { await p; } catch (e) { return e; } throw new Error('esperava erro'); };

describe('gcHttp.criarCliente — sucesso e segurança básica', () => {
  test('200 válido devolve o JSON; só GET; redirect bloqueado; credenciais só em cabeçalhos', async () => {
    const f = fila(resp(200, OK())); const { c } = cliente(f);
    const j = await c.get('/vendas', { loja_id: '262759', pagina: 1 });
    expect(j.data).toHaveLength(1);
    expect(f.chamadas).toHaveLength(1);
    const { url, opts } = f.chamadas[0];
    expect(opts.method).toBe('GET'); expect(opts.redirect).toBe('error'); expect(opts.body).toBeUndefined();
    expect(url.startsWith(BASE + '/vendas?')).toBe(true); expect(url).toContain('loja_id=262759');
    expect(url).not.toContain(SEG_A); expect(url).not.toContain(SEG_S);
    expect(opts.headers['access-token']).toBe(SEG_A); expect(opts.headers['secret-access-token']).toBe(SEG_S);
  });
  test('sem credenciais ⇒ erro; tentativas fora de 1..5 ⇒ erro', () => {
    expect(() => criarCliente({ transporte: async () => {}, credenciais: {} })).toThrow(/GC_CREDENCIAIS_AUSENTES/);
    expect(() => criarCliente({ transporte: async () => {}, credenciais: { access: 'a', secret: 'b' }, tentativas: 99 })).toThrow();
  });
  test('caminho/host inválidos são recusados ANTES de enviar', async () => {
    const f = fila(resp(200, OK())); const { c } = cliente(f);
    for (const cam of ['vendas', '//evil.example/x', '@evil.example/x', '/vendas?x=1', '/../etc', '/a#b', 123]) {
      const e = await falha(c.get(cam)); expect(e).toBeInstanceOf(GcErro);
    }
    expect(f.chamadas).toHaveLength(0);
  });
  test('parâmetros nulos/indefinidos são omitidos', async () => {
    const f = fila(resp(200, OK())); const { c } = cliente(f);
    await c.get('/vendas', { a: undefined, b: null, c: 0, d: '' });
    expect(f.chamadas[0].url).toBe(BASE + '/vendas?c=0&d=');
  });
});

describe('gcHttp — erros HTTP', () => {
  test.each([401, 403, 404, 400, 422])('HTTP %i ⇒ erro imediato, 1 chamada, sem retentativa', async st => {
    const f = fila(resp(st, { code: st, status: 'error' })); const { c, esperas } = cliente(f);
    const e = await falha(c.get('/vendas'));
    expect(e.codigo).toBe(`GC_HTTP_${st}`); expect(e.status).toBe(st);
    expect(f.chamadas).toHaveLength(1); expect(esperas).toEqual([]);
  });
  test.each([500, 502, 503])('HTTP %i ⇒ 3 tentativas com backoff, depois erro', async st => {
    const f = fila(resp(st, { code: st })); const { c, esperas } = cliente(f);
    const e = await falha(c.get('/vendas'));
    expect(e.codigo).toBe(`GC_HTTP_${st}`); expect(e.tentativas).toBe(3);
    expect(f.chamadas).toHaveLength(3); expect(esperas).toEqual([2000, 4000]);
    expect(c.estatisticas().retries).toBe(2);
  });
  test('500 seguido de 200 ⇒ sucesso (1 retentativa)', async () => {
    const f = fila(resp(500, {}), resp(200, OK())); const { c } = cliente(f);
    const j = await c.get('/vendas'); expect(j.data).toHaveLength(1);
    expect(f.chamadas).toHaveLength(2); expect(c.estatisticas().retries).toBe(1);
  });
  test('redirecionamento: status 3xx ou erro do fetch ⇒ GC_REDIRECIONAMENTO, sem retentativa', async () => {
    let f = fila(resp(302, {}, { location: 'https://evil.example' })); let { c } = cliente(f);
    expect((await falha(c.get('/vendas'))).codigo).toBe(CODIGOS.REDIRECIONAMENTO); expect(f.chamadas).toHaveLength(1);
    const err = new TypeError('fetch failed'); err.cause = new Error('unexpected redirect');
    f = fila(err); ({ c } = cliente(f));
    expect((await falha(c.get('/vendas'))).codigo).toBe(CODIGOS.REDIRECIONAMENTO); expect(f.chamadas).toHaveLength(1);
  });
  test('falha de rede e timeout são retentados (3x) e depois erro tipado', async () => {
    let f = fila(new TypeError('fetch failed')); let { c } = cliente(f);
    let e = await falha(c.get('/vendas')); expect(e.codigo).toBe(CODIGOS.REDE); expect(f.chamadas).toHaveLength(3);
    const to = new Error('t'); to.name = 'TimeoutError'; f = fila(to); ({ c } = cliente(f));
    e = await falha(c.get('/vendas')); expect(e.codigo).toBe(CODIGOS.TIMEOUT); expect(f.chamadas).toHaveLength(3);
  });
});

describe('gcHttp — HTTP 429 e Retry-After (sem retentativas ilimitadas)', () => {
  test('429 com Retry-After ⇒ espera exatamente o informado e tenta de novo', async () => {
    const f = fila(resp(429, { code: 429 }, { 'retry-after': '5' }), resp(200, OK())); const { c, esperas } = cliente(f);
    await c.get('/vendas'); expect(esperas).toEqual([5000]); expect(f.chamadas).toHaveLength(2); expect(c.estatisticas().r429).toBe(1);
  });
  test('429 persistente ⇒ no máximo 3 tentativas e erro GC_429_ESGOTADO', async () => {
    const f = fila(resp(429, { code: 429 }, { 'retry-after': '2' })); const { c, esperas } = cliente(f);
    const e = await falha(c.get('/vendas')); expect(e.codigo).toBe(CODIGOS.R429_ESGOTADO); expect(f.chamadas).toHaveLength(3); expect(esperas).toEqual([2000, 2000]);
  });
  test('429 sem Retry-After ⇒ usa backoff', async () => {
    const f = fila(resp(429, {}), resp(200, OK())); const { c, esperas } = cliente(f);
    await c.get('/vendas'); expect(esperas).toEqual([2000]);
  });
  test('Retry-After acima do limite (30 s) ⇒ aborta na hora, sem esperar', async () => {
    const f = fila(resp(429, {}, { 'retry-after': '120' })); const { c, esperas } = cliente(f);
    const e = await falha(c.get('/vendas')); expect(e.codigo).toBe(CODIGOS.R429_RETRY_AFTER_ALTO); expect(e.retryAfterSeg).toBe(120);
    expect(f.chamadas).toHaveLength(1); expect(esperas).toEqual([]);
  });
  test('Retry-After em data HTTP é interpretado; valor inválido cai no backoff', async () => {
    const agora = Date.parse('2026-11-23T20:00:00Z'); const em10 = new Date(agora + 10000).toUTCString();
    let f = fila(resp(429, {}, { 'retry-after': em10 }), resp(200, OK())); let r = cliente(f, { agora: () => agora });
    await r.c.get('/vendas'); expect(r.esperas).toEqual([10000]);
    f = fila(resp(429, {}, { 'retry-after': 'abc' }), resp(200, OK())); r = cliente(f);
    await r.c.get('/vendas'); expect(r.esperas).toEqual([2000]);
  });
  test('tentativas configuráveis (1 = sem retentativa)', async () => {
    const f = fila(resp(429, {})); const { c } = cliente(f, { tentativas: 1 });
    await falha(c.get('/vendas')); expect(f.chamadas).toHaveLength(1);
  });
});

describe('gcHttp — formato da resposta (HTTP 200 inválido NUNCA vira lista vazia)', () => {
  test.each([
    ['corpo não é JSON', resp(200, 'texto')],
    ['corpo vazio', resp(200, undefined)],
  ])('%s ⇒ GC_JSON_INVALIDO (retentado 3x)', async (_n, r) => {
    const f = fila(r); const { c } = cliente(f);
    const e = await falha(c.get('/vendas')); expect(e.codigo).toBe(CODIGOS.JSON_INVALIDO); expect(f.chamadas).toHaveLength(3);
  });
  test.each([
    ['raiz é lista', []],
    ['code ≠ 200 com HTTP 200', { code: 500, status: 'error', data: [], meta: {} }],
    ['status de erro', { code: 200, status: 'error', data: [], meta: {} }],
    ['sem indicação de sucesso', { data: [], meta: {} }],
    ['data ausente (chave errada)', { code: 200, status: 'success', dados: [{ id: 1 }], meta: {} }],
    ['data é texto', { code: 200, status: 'success', data: 'oops', meta: {} }],
    ['data é objeto em listagem', { code: 200, status: 'success', data: {}, meta: {} }],
    ['meta ausente', { code: 200, status: 'success', data: [] }],
    ['meta é lista', { code: 200, status: 'success', data: [], meta: [] }],
  ])('200 com estrutura inválida: %s ⇒ GC_RESPOSTA_INESPERADA, sem retentativa', async (_n, corpo) => {
    const f = fila(resp(200, corpo)); const { c, esperas } = cliente(f);
    const e = await falha(c.get('/vendas')); expect(e.codigo).toBe(CODIGOS.RESPOSTA_INESPERADA);
    expect(f.chamadas).toHaveLength(1); expect(esperas).toEqual([]);
  });
  test('raiz que é um texto JSON válido (não objeto) ⇒ GC_RESPOSTA_INESPERADA', async () => {
    const f = fila({ status: 200, ok: true, headers: { get: () => null }, json: async () => 'x' }); const { c } = cliente(f);
    expect((await falha(c.get('/vendas'))).codigo).toBe(CODIGOS.RESPOSTA_INESPERADA); expect(f.chamadas).toHaveLength(1);
  });
  test('tipo "detalhe": data objeto é válido; lista é inválida', async () => {
    let f = fila(resp(200, { code: 200, status: 'success', data: { id: '9' } })); let { c } = cliente(f);
    expect((await c.get('/vendas/9', {}, { tipo: 'detalhe' })).data.id).toBe('9');
    f = fila(resp(200, { code: 200, status: 'success', data: [] })); ({ c } = cliente(f));
    expect((await falha(c.get('/vendas/9', {}, { tipo: 'detalhe' }))).codigo).toBe(CODIGOS.RESPOSTA_INESPERADA);
  });
  test('resposta VAZIA REAL (formato comprovado ao vivo) é aceita; `error`/`message` na raiz são ignorados', async () => {
    const vazia = { code: 200, status: 'success', meta: { total_registros: null, total_paginas: null, total_registros_pagina: null, pagina_atual: 1, limite_por_pagina: 1, pagina_anterior: null, url_anterior: null, proxima_pagina: null, proxima_url: null }, data: [], error: '', message: 'qualquer' };
    const f = fila(resp(200, vazia)); const { c } = cliente(f);
    const j = await c.get('/vendas', { data_modificado_inicio: '2030-01-01' }); expect(j.data).toEqual([]); expect(f.chamadas).toHaveLength(1);
  });
});

describe('gcHttp — erros sanitizados', () => {
  test('nenhum erro contém credenciais, corpo bruto ou query string', async () => {
    const casos = [
      fila(resp(500, { mensagem: CORPO_SECRETO })), fila(resp(401, { mensagem: CORPO_SECRETO })), fila(resp(429, { m: CORPO_SECRETO })),
      fila(resp(200, { code: 500, status: 'error', mensagem: CORPO_SECRETO, data: [], meta: {} })), fila(new TypeError('fetch failed ' + SEG_A)),
    ];
    for (const f of casos) {
      const { c } = cliente(f); const e = await falha(c.get('/vendas', { cpf: '123.456.789-00', loja_id: '262759' }));
      const txt = e.message + JSON.stringify(e) + (e.stack || '').split('\n')[0];
      for (const s of [SEG_A, SEG_S, CORPO_SECRETO, '123.456.789-00', 'loja_id=', '?']) expect(txt).not.toContain(s);
    }
  });
});

describe('gcHttp.criarTransporteHttps — adaptador de https.get', () => {
  /** https simulado: responde conforme `resposta`; registra as chamadas */
  function httpsFalso(resposta) {
    const chamadas = [];
    return { chamadas, get(url, opts, cb) {
      chamadas.push({ url, opts }); const req = new EventEmitter();
      process.nextTick(() => {
        if (resposta.erro) { req.emit('error', resposta.erro); return; }
        const res = new EventEmitter(); res.statusCode = resposta.status; res.headers = resposta.headers || {};
        cb(res); for (const c of resposta.pedacos) res.emit('data', c); res.emit('end');
      });
      return req;
    } };
  }
  const via = (resposta, extra = {}) => { const h = httpsFalso(resposta); const c = criarCliente({ transporte: criarTransporteHttps(h), credenciais: { access: SEG_A, secret: SEG_S }, dormir: async () => {}, ...extra }); return { h, c }; };

  test('200 em vários pedaços (string e Buffer) é reconstituído e validado; cabeçalhos e signal repassados', async () => {
    const corpo = JSON.stringify(OK([{ id: '1' }, { id: '2' }], { total_registros: 2, total_paginas: 1, pagina_atual: 1, limite_por_pagina: 100, proxima_pagina: null }));
    const { h, c } = via({ status: 200, pedacos: [corpo.slice(0, 20), Buffer.from(corpo.slice(20))] });
    const j = await c.get('/vendas', { loja_id: '262759' });
    expect(j.data).toHaveLength(2);
    expect(h.chamadas[0].opts.headers['access-token']).toBe(SEG_A); expect(h.chamadas[0].opts.signal).toBeDefined();
    expect(h.chamadas[0].url.startsWith(BASE)).toBe(true);
  });
  test('status e Retry-After (inclusive cabeçalho em lista) chegam ao cliente: 429 com Retry-After é respeitado', async () => {
    const h = httpsFalso({ status: 429, headers: { 'retry-after': ['3'] }, pedacos: ['{}'] }); const esperas = [];
    const c = criarCliente({ transporte: criarTransporteHttps(h), credenciais: { access: 'a', secret: 'b' }, tentativas: 2, dormir: async ms => { esperas.push(ms); } });
    const e = await falha(c.get('/vendas'));
    expect(e.codigo).toBe(CODIGOS.R429_ESGOTADO); expect(esperas).toEqual([3000]); expect(h.chamadas).toHaveLength(2);
  });
  test('3xx volta como status e é recusado (https.get não segue redirecionamento)', async () => {
    const { c } = via({ status: 301, headers: { location: 'https://evil.example' }, pedacos: [''] });
    expect((await falha(c.get('/vendas'))).codigo).toBe(CODIGOS.REDIRECIONAMENTO);
  });
  test('corpo que não é JSON ⇒ GC_JSON_INVALIDO; erro de socket ⇒ GC_REDE (retentado)', async () => {
    expect((await falha(via({ status: 200, pedacos: ['<html>erro</html>'] }).c.get('/vendas'))).codigo).toBe(CODIGOS.JSON_INVALIDO);
    const r = via({ erro: new Error('ECONNRESET') }); expect((await falha(r.c.get('/vendas'))).codigo).toBe(CODIGOS.REDE); expect(r.h.chamadas).toHaveLength(3);
  });
  test('protocolo não https e url inválida são recusados pelo transporte', async () => {
    const t = criarTransporteHttps(httpsFalso({ status: 200, pedacos: ['{}'] }));
    await expect(t('http://api.gestaoclick.com/vendas')).rejects.toMatchObject({ codigo: CODIGOS.HOST_FORA_DO_GC });
    await expect(t('::não é url::')).rejects.toMatchObject({ codigo: CODIGOS.CAMINHO_INVALIDO });
  });
});
