'use strict';
// FINANCEIRO Fase 2 · GET-only, paginação completa, retry seguro, respostas ruins do ERP.
const F = require('../lib/financeiro/fetch');
const { gcFalso } = require('./fixtures/financeiro-f2');
const { titulo } = require('./fixtures/financeiro-f1');
const mes = (n, dia = '10') => titulo({ id: 'T' + n, data_vencimento: `2026-09-${dia}` });
const lote = (n, inicio = 0) => Array.from({ length: n }, (_, i) => titulo({ id: 'T' + (inicio + i), data_vencimento: '2026-09-' + String(1 + ((inicio + i) % 28)).padStart(2, '0') }));
const J = { inicio: '2026-09-01', fim: '2026-09-30' };

describe('paginação completa', () => {
  test('primeira, intermediária e última página (250 → 100+100+50), sem perda e sem duplicação; limite de 100 respeitado', async () => {
    const { cli, chamadas } = gcFalso({ pagamentos: lote(250) });
    const r = await F.buscarJanela(cli, 'pagamentos', J);
    expect(r.itens).toHaveLength(250); expect(new Set(r.itens.map(x => x.id)).size).toBe(250); expect(r.paginas).toBe(3);
    expect(chamadas.map(c => new URL(c.url).searchParams.get('pagina'))).toEqual(['1', '2', '3']);
    expect(chamadas.every(c => new URL(c.url).searchParams.get('limite') === '100')).toBe(true);
  });
  test('página vazia / janela sem títulos: total 0, 1 chamada, sem erro', async () => {
    const { cli, chamadas } = gcFalso({ pagamentos: [] });
    const r = await F.buscarJanela(cli, 'pagamentos', J); expect(r.itens).toEqual([]); expect(r.total).toBe(0); expect(chamadas).toHaveLength(1);
  });
  test('página intermediária vazia antes do fim → janela incompleta (não passa como completa)', async () => {
    const { cli } = gcFalso({ pagamentos: lote(250), falhas: { vazio: (p, pg) => pg === 2 } });
    await expect(F.buscarJanela(cli, 'pagamentos', J)).rejects.toMatchObject({ codigo: 'JANELA_INCOMPLETA' });
  });
  test('resposta repetida (API devolve a mesma página): erro PAGINA_REPETIDA, sem loop', async () => {
    const { cli, chamadas } = gcFalso({ pagamentos: lote(250), falhas: { repetirPagina: (p, pg) => pg === 2 } });
    await expect(F.buscarJanela(cli, 'pagamentos', J)).rejects.toMatchObject({ codigo: 'PAGINA_REPETIDA' });
    expect(chamadas.length).toBeLessThanOrEqual(3);
  });
  test('item que muda de janela durante a varredura (aparece em duas janelas) é deduplicado pelo ID, fica o mais recente', async () => {
    const velho = titulo({ id: 'MOVEL', data_vencimento: '2026-09-30', liquidado: '0', modificado_em: '2026-09-29 10:00:00' });
    const novo = { ...velho, liquidado: '1', data_liquidacao: '2026-10-01', modificado_em: '2026-10-01 09:00:00' };
    const respostas = { '2026-09-01': { data: [velho], total: 1 }, '2026-10-01': { data: [novo], total: 1 } };
    const cli = F.criarClienteGC({ fetchImpl: async url => { const q = new URL(url).searchParams; const r = respostas[q.get('data_inicio')] || { data: [], total: 0 };
      return { ok: true, json: async () => ({ data: r.data, meta: { total_registros: r.total, total_paginas: 1 } }) }; }, accessToken: 'a', secretToken: 'b', pausaMs: 0 });
    const r = await F.buscarTitulos(cli, 'pagamentos', { inicio: '2026-09-01', fim: '2026-10-31' });
    expect(r.titulos).toHaveLength(1); expect(r.titulos[0].liquidado).toBe('1'); expect(r.estatisticas.duplicates).toBe(1);
  });
  test('resposta parcial (menos itens que o total_registros) falha como JANELA_INCOMPLETA', async () => {
    const parcial = gcFalso({ pagamentos: lote(120), falhas: { total: () => 5 } });
    await expect(F.buscarJanela(parcial.cli, 'pagamentos', J)).rejects.toMatchObject({ codigo: 'JANELA_INCOMPLETA' });
  });
  test('número de páginas absurdo é recusado (anti-loop)', async () => {
    const cli = F.criarClienteGC({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'x' }], meta: { total_registros: 1, total_paginas: 999999 } }) }), accessToken: 'a', secretToken: 'b', pausaMs: 0 });
    await expect(F.buscarJanela(cli, 'pagamentos', J)).rejects.toMatchObject({ codigo: 'PAGINAS_DEMAIS' });
  });
});

describe('erros do ERP e retry seguro', () => {
  test('503 transitório: repete com backoff e conclui; retries contados', async () => {
    const { cli, dormidas } = gcFalso({ pagamentos: lote(30), falhas: { http: (p, n) => (n <= 2 ? 503 : null) } });
    const r = await F.buscarJanela(cli, 'pagamentos', J); expect(r.itens).toHaveLength(30); expect(cli.retries()).toBe(2); expect(dormidas.slice(0, 2)).toEqual([1, 2]);
  });
  test('429 (rate limit) é repetido; 503 persistente falha depois de 3 tentativas', async () => {
    const a = gcFalso({ pagamentos: lote(5), falhas: { http: (p, n) => (n === 1 ? 429 : null) } });
    expect((await F.buscarJanela(a.cli, 'pagamentos', J)).itens).toHaveLength(5);
    const b = gcFalso({ pagamentos: lote(5), falhas: { http: () => 503 } });
    await expect(F.buscarJanela(b.cli, 'pagamentos', J)).rejects.toThrow(/GC HTTP 503/); expect(b.chamadas).toHaveLength(3);
  });
  test('erro definitivo (400/401/404) NÃO é repetido', async () => {
    const a = gcFalso({ pagamentos: lote(5), falhas: { http: () => 401 } });
    await expect(F.buscarJanela(a.cli, 'pagamentos', J)).rejects.toThrow(/GC HTTP 401/); expect(a.chamadas).toHaveLength(1);
  });
  test('timeout (AbortError) é repetido e conclui; timeout persistente falha', async () => {
    const a = gcFalso({ pagamentos: lote(5), falhas: { timeout: (p, n) => n === 1 } });
    expect((await F.buscarJanela(a.cli, 'pagamentos', J)).itens).toHaveLength(5);
    const b = gcFalso({ pagamentos: lote(5), falhas: { timeout: () => true } });
    await expect(F.buscarJanela(b.cli, 'pagamentos', J)).rejects.toBeTruthy(); expect(b.chamadas).toHaveLength(3);
  });
  test('JSON inválido é repetido; persistente falha com mensagem sem corpo da resposta', async () => {
    const a = gcFalso({ pagamentos: lote(5), falhas: { jsonInvalido: (p, n) => n === 1 } });
    expect((await F.buscarJanela(a.cli, 'pagamentos', J)).itens).toHaveLength(5);
    const b = gcFalso({ pagamentos: lote(5), falhas: { jsonInvalido: () => true } });
    await expect(F.buscarJanela(b.cli, 'pagamentos', J)).rejects.toThrow(/JSON inválido/);
  });
  test('erro na PRIMEIRA e numa página INTERMEDIÁRIA aborta a janela (nada parcial devolvido)', async () => {
    const p1 = gcFalso({ pagamentos: lote(250), falhas: { http: () => 500 } });
    await expect(F.buscarTitulos(p1.cli, 'pagamentos', J)).rejects.toBeTruthy();
    const p2 = gcFalso({ pagamentos: lote(250), falhas: { http: (p, n, u) => (u.searchParams.get('pagina') === '2' ? 500 : null) } });
    await expect(F.buscarTitulos(p2.cli, 'pagamentos', J)).rejects.toBeTruthy();
  });
});

describe('GET-only e índices comerciais', () => {
  test('qualquer método diferente de GET e qualquer recurso fora da lista são bloqueados antes de sair', async () => {
    const { cli, chamadas } = gcFalso();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const p of ['/pagamentos', '/recebimentos', '/compras', '/vendas']) await expect(cli.get(p, { method: m })).rejects.toThrow(/GET_ONLY_GUARD/);
    for (const p of ['/clientes', '/fornecedores', '/contas_bancarias', '/pagamentos/1/baixar']) await expect(cli.get(p)).rejects.toThrow(/GET_ONLY_GUARD/);
    expect(chamadas).toEqual([]);
  });
  test('todas as chamadas de uma varredura completa são GET', async () => {
    const g = gcFalso({ pagamentos: lote(20), recebimentos: lote(20, 1000) });
    await F.buscarReferencias(g.cli); await F.buscarTitulos(g.cli, 'pagamentos', J); await F.buscarIndicesComerciais(g.cli, { inicio: '2026-08-01', fim: '2026-09-30' });
    expect(g.chamadas.length).toBeGreaterThan(5); expect(new Set(g.chamadas.map(c => c.method))).toEqual(new Set(['GET']));
  });
  test('índices comerciais guardam só id, código e id da contraparte (nada de nome/valor/CPF)', async () => {
    const g = gcFalso({ compras: [{ id: 'C1', codigo: '10', fornecedor_id: 'F1', nome_fornecedor: 'NÃO DEVE SAIR', valor_total: '1', data_emissao: '2026-09-05' }], vendas: [{ id: 'V1', codigo: '20', cliente_id: 'K1', nome_cliente: 'NÃO DEVE SAIR', valor_total: '1', data: '2026-09-05' }] });
    const r = await F.buscarIndicesComerciais(g.cli, { inicio: '2026-09-01', fim: '2026-09-30' });
    expect(r.compras).toEqual([{ id: 'C1', codigo: '10', fornecedor_id: 'F1' }]); expect(r.vendas).toEqual([{ id: 'V1', codigo: '20', cliente_id: 'K1' }]);
    expect(JSON.stringify(r)).not.toMatch(/NÃO DEVE SAIR/);
  });
  test('pausa entre chamadas respeita o limite da API', async () => {
    const g = gcFalso({ pagamentos: lote(250), pausaMs: 350 });
    await F.buscarJanela(g.cli, 'pagamentos', J); expect(g.dormidas.filter(x => x === 350)).toHaveLength(3);
  });
});
