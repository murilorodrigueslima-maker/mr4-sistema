'use strict';
// Etapa A · A4 — Expedição: o leitor de vendas nunca transforma falha/resposta parcial em lista vazia ou completa.
const SYNC = require('../lib/expedicao/sync');
const resp = (status, corpo) => ({ status, headers: { get: () => null }, json: async () => { if (corpo === undefined) throw new Error('x'); return corpo; } });
const v = id => ({ id: String(id), numero: String(id) });
const leitor = fetchImpl => SYNC.criarLeitorVendas({ accessToken: 'a', secretToken: 's', fetchImpl, dormir: async () => {} });

describe('A4 — criarLeitorVendas', () => {
  test('vazio legítimo (200 + estrutura válida + sem próxima página) ⇒ []', async () => {
    const l = leitor(async () => resp(200, { code: 200, status: 'success', data: [], meta: { total_registros: null, proxima_pagina: null, pagina_atual: 1 } }));
    expect(await l.vendas('2026-11-20', '2026-11-22')).toEqual([]);
  });
  test('várias páginas ⇒ lista completa; só GET no host oficial', async () => {
    const urls = [];
    const l = leitor(async (u, o) => { urls.push([u, o.method]); const p = Number(new URL(u).searchParams.get('pagina')); return resp(200, { code: 200, status: 'success', data: [v(p * 10), v(p * 10 + 1)], meta: { total_registros: 6, proxima_pagina: p < 3 ? p + 1 : null, pagina_atual: p } }); });
    const r = await l.vendas('2026-11-20', '2026-11-22');
    expect(r).toHaveLength(6); expect(l.chamadas()).toBe(3);
    for (const [u, m] of urls) { expect(m).toBe('GET'); expect(u).toMatch(/^https:\/\/api\.gestaoclick\.com\/vendas\?/); }
  });
  test.each([[500], [503], [401], [403]])('HTTP %i ⇒ erro (nunca lista vazia)', async st => {
    await expect(leitor(async () => resp(st, { data: [] })).vendas('a', 'b')).rejects.toMatchObject({ name: 'GcErro' });
  });
  test('200 com corpo que não é JSON ⇒ erro', async () => { await expect(leitor(async () => resp(200, undefined)).vendas('a', 'b')).rejects.toMatchObject({ name: 'GcErro' }); });
  test('200 sem lista `data` ⇒ erro (antes virava [])', async () => { await expect(leitor(async () => resp(200, { meta: {} })).vendas('a', 'b')).rejects.toMatchObject({ name: 'GcErro' }); });
  test('página 2 some antes do fim ⇒ erro (nunca lista parcial)', async () => {
    const l = leitor(async u => { const p = Number(new URL(u).searchParams.get('pagina')); return p === 1 ? resp(200, { code: 200, status: 'success', data: [v(1), v(2)], meta: { total_registros: 4, proxima_pagina: 2, pagina_atual: 1 } }) : resp(200, { code: 200, status: 'success', data: [], meta: { proxima_pagina: null, pagina_atual: p } }); });
    await expect(l.vendas('a', 'b')).rejects.toMatchObject({ name: 'GcErro' });
  });
  test('excesso de páginas ABORTA (nunca trunca)', async () => {
    const l = leitor(async u => { const p = Number(new URL(u).searchParams.get('pagina')); return resp(200, { code: 200, status: 'success', data: [v(p)], meta: { total_registros: 99999, proxima_pagina: p + 1, pagina_atual: p } }); });
    await expect(l.vendas('a', 'b')).rejects.toMatchObject({ codigo: expect.stringMatching(/GC_LIMITE_PAGINAS|GC_PAGINACAO/) });
  });
  test('429 é repetido com limite e depois falha (sem esperar de verdade)', async () => {
    let n = 0; const l = leitor(async () => { n++; return resp(429, { data: [] }); });
    await expect(l.vendas('a', 'b')).rejects.toMatchObject({ name: 'GcErro' }); expect(n).toBeLessThanOrEqual(3);
  });
});

describe('A4 — sincronizar: em erro do leitor NÃO cria pedidos e NÃO grava ultima_ok', () => {
  test('falha propaga e nada é escrito', async () => {
    const escritas = []; const ref = { get: async () => ({ data: () => ({}) }), set: async d => { escritas.push(d); }, collection: () => ({ doc: () => ({}) }) };
    const db = { collection: () => ({ doc: () => ref }), batch: () => ({ create: () => { escritas.push('create'); }, commit: async () => {} }) };
    const leitorQuebrado = { chamadas: () => 1, vendas: async () => { throw new Error('GC_HTTP_503'); } };
    await expect(SYNC.sincronizar({ db, leitor: leitorQuebrado, dto: x => x, serverTimestamp: () => 'ts' })).rejects.toThrow('GC_HTTP_503');
    expect(escritas).toEqual([]);
  });
});
