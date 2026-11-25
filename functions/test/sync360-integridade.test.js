'use strict';
/**
 * Etapa A · A1 — INTEGRIDADE do sync360 (runIncremental REAL, adaptadores simulados; sem rede, sem Firestore).
 * Reproduz: #6 cursor avançando indevidamente (lote parcial por erro HTTP engolido) e #5 filtro ignorado pela API.
 * "CARACTERIZAÇÃO" = o que o código ATUAL faz (passa hoje, será invertida na A3/C).
 * "DESEJADO" = `test.failing` (passa enquanto o defeito existe; vira falha vermelha quando for corrigido).
 *      VER_DEFEITOS=1 npx jest test/sync360-integridade.test.js   → mostra as asserções vermelhas
 */
const { runIncremental, fetchAllPagesByProximaPagina } = require('../lib/sync360');
const defeito = process.env.VER_DEFEITOS === '1' ? test : test.failing;

const fmt = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const venda = (id, m, cliente = '10') => ({ id: String(id), cliente_id: cliente, data: m.slice(0, 10), nome_situacao: 'Concretizada', valor_total: '100.00', modificado_em: m, cadastrado_em: m, vendedor_id: '1', nome_vendedor: 'Vendedor', produtos: [] });

function adaptadores(gcFetchPage, cursor) {
  const w = { vendas: [], perfis: {}, syncState: null };
  return {
    gcFetchPage,
    firestoreGetClientes: jest.fn().mockResolvedValue([{ firestoreDocumentId: 'docA', gestaoClickId: '10' }]),
    firestoreGetVendasByCliente: jest.fn().mockResolvedValue([]),
    firestoreGetPerfil: jest.fn().mockResolvedValue(null),
    firestoreUpsertVendas: jest.fn(async vs => { w.vendas.push(...vs); }),
    firestoreUpsertPerfil: jest.fn(async (id, p) => { w.perfis[id] = p; }),
    firestoreGetSyncState: jest.fn().mockResolvedValue(cursor ? { modifiedSinceCursor: cursor } : null),
    firestoreSetSyncState: jest.fn(async d => { w.syncState = d; }),
    dryRun: false, dataReferencia: '2026-11-22', _w: w,
  };
}
async function executar(ad) { try { return { r: await runIncremental(ad), erro: null }; } catch (e) { return { r: null, erro: e }; } }

// ─────────────────────────── #6 cursor avançando indevidamente ───────────────────────────
const CURSOR = '2026-11-20 10:00:00';
const T0 = Date.UTC(2026, 10, 20, 10, 30, 0);
// 150 vendas modificadas APÓS o cursor; ordem padrão da API: mais recentes primeiro
const modificadas = Array.from({ length: 150 }, (_, i) => venda(1000 + i, fmt(T0 + i * 20 * 60000))).reverse();
const pagina1 = modificadas.slice(0, 100);          // as 100 mais NOVAS
const idsAntigas = modificadas.slice(100).map(v => v.id);   // as 50 mais ANTIGAS (página 2)

/** Replica o wrapper real (gcReq360/gcRequest): erro HTTP com corpo JSON vira { data: [], meta: {} } — sem exceção. */
function gcComErroNaPagina2() {
  return jest.fn(async (endpoint, params) => {
    if (endpoint === '/vendas') return params.pagina === 1 || params.pagina === undefined ? { data: pagina1, meta: { proxima_pagina: 2, total_registros: 150, total_paginas: 2 } } : { data: [], meta: {} };
    return { data: [], meta: {} };
  });
}

describe('A1 #6 — cursor avançando indevidamente (HTTP 429/500 na página 2 engolido pelo wrapper)', () => {
  let ad, out;
  beforeAll(async () => { ad = adaptadores(gcComErroNaPagina2(), CURSOR); out = await executar(ad); });
  test('precondição: a página 2 foi pedida e o lote tinha 150 vendas modificadas, das quais só 100 chegaram', () => {
    const paginas = ad.gcFetchPage.mock.calls.filter(c => c[0] === '/vendas').map(c => c[1].pagina);
    expect(paginas).toEqual([1, 2]); expect(modificadas).toHaveLength(150); expect(idsAntigas).toHaveLength(50);
  });
  test('A3 (corrigido): lote parcial ⇒ ABORTA com erro, NÃO grava vendas/perfis e NÃO avança o cursor', () => {
    expect(out.erro).not.toBeNull(); expect(out.erro.codigo).toBe('GC_PAGINACAO_INCOMPLETA');
    expect(ad._w.syncState).toBeNull(); expect(ad._w.vendas).toHaveLength(0);
    expect(ad.firestoreSetSyncState).not.toHaveBeenCalled(); expect(ad.firestoreUpsertVendas).not.toHaveBeenCalled(); expect(ad.firestoreUpsertPerfil).not.toHaveBeenCalled();
  });
  test('A3 (corrigido): sem perda permanente — o cursor fica onde estava e a execução seguinte, com a API saudável, lê as 150', async () => {
    const todas = jest.fn(async (endpoint, params) => {
      if (endpoint !== '/vendas') return { data: [], meta: {} };
      const p = Number(params.pagina || 1); const data = modificadas.slice((p - 1) * 100, p * 100);
      return { data, meta: { proxima_pagina: p === 1 ? 2 : null, total_registros: 150, total_paginas: 2 } };
    });
    const ad2 = adaptadores(todas, CURSOR);                                              // cursor ORIGINAL (nunca avançou)
    const r2 = await runIncremental(ad2);
    expect(r2.modifiedVendas).toBe(150);
    const lidas = new Set(ad2._w.vendas.map(v => v.id)); expect(idsAntigas.every(id => lidas.has(id))).toBe(true);
  });
});

describe('A1 #4 (sync360) — paginação incompleta nunca deve ser resultado completo', () => {
  test('A3 (corrigido): fetchAllPagesByProximaPagina NÃO devolve 100 de 150 como se fosse tudo — lança erro', async () => {
    await expect(fetchAllPagesByProximaPagina(gcComErroNaPagina2(), '/vendas', {})).rejects.toMatchObject({ codigo: 'GC_PAGINACAO_INCOMPLETA' });
  });
  test('A3 (corrigido): página circular lança GC_PAGINACAO_INCONSISTENTE/CIRCULAR (sem `break` silencioso)', async () => {
    const gc = jest.fn(async () => ({ data: [venda(1, '2026-11-21 10:00:00')], meta: { proxima_pagina: 1, total_registros: 5 } }));
    await expect(fetchAllPagesByProximaPagina(gc, '/vendas', {})).rejects.toMatchObject({ name: 'GcErro' });
  });
  test('A3: limite de páginas ABORTA (nunca trunca)', async () => {
    const gc = jest.fn(async (e, p) => ({ data: [venda(p.pagina, '2026-11-21 10:00:00')], meta: { proxima_pagina: p.pagina + 1 } }));
    await expect(fetchAllPagesByProximaPagina(gc, '/vendas', {}, { maxPaginas: 3 })).rejects.toMatchObject({ codigo: 'GC_LIMITE_PAGINAS' });
  });
  test('A3: lista completa em várias páginas é devolvida inteira', async () => {
    const gc = jest.fn(async (e, p) => ({ data: [venda(p.pagina * 2, 'x'), venda(p.pagina * 2 + 1, 'x')], meta: { proxima_pagina: p.pagina < 3 ? p.pagina + 1 : null, total_registros: 6 } }));
    expect(await fetchAllPagesByProximaPagina(gc, '/vendas', {})).toHaveLength(6);
  });
  test('A3: sem filtro, total_registros não alcançado ⇒ erro', async () => {
    const gc = jest.fn(async () => ({ data: [venda(1, 'x')], meta: { proxima_pagina: null, total_registros: 5 } }));
    await expect(fetchAllPagesByProximaPagina(gc, '/vendas', {})).rejects.toMatchObject({ codigo: 'GC_PAGINACAO_INCOMPLETA' });
  });
});

// ─────────────────────────── #5 filtro ignorado pela API ───────────────────────────
// A API IGNORA `modificado_desde` (comprovado ao vivo em 23/11/2026) e devolve o histórico inteiro, mais recente primeiro.
const HISTORICO = Array.from({ length: 450 }, (_, k) => venda(5000 + k, fmt(Date.UTC(2026, 10, 22, 18, 0, 0) - k * 4 * 3600000)));   // 450 vendas, da mais nova (22/11 18:00) à mais antiga (~ 08/09); já em ordem "mais recente primeiro"
function gcQueIgnoraOFiltro() {
  return jest.fn(async (endpoint, params) => {
    if (endpoint !== '/vendas') return { data: [], meta: {} };
    const p = Number(params.pagina || 1); const data = HISTORICO.slice((p - 1) * 100, p * 100);
    return { data, meta: { total_registros: 450, total_paginas: 5, proxima_pagina: p < 5 ? p + 1 : null } };   // ignora modificado_desde
  });
}
const aPartirDoCursor = HISTORICO.filter(v => v.modificado_em >= '2026-11-20 09:59:00');   // cursor 10:00:00 − 60 s de sobreposição

describe('A1 #5 — filtro incremental IGNORADO pela API (resolvido na Etapa C; o detector puro já existe em gcHttp)', () => {
  let ad, out;
  beforeAll(async () => { ad = adaptadores(gcQueIgnoraOFiltro(), CURSOR); out = await executar(ad); });
  test('precondição: o código envia o parâmetro ignorado `modificado_desde` e a API devolve o histórico inteiro', () => {
    expect(ad.gcFetchPage.mock.calls.find(c => c[0] === '/vendas')[1].modificado_desde).toBe('2026-11-20 09:59:00');
    expect(HISTORICO).toHaveLength(450);
  });
  test('CARACTERIZAÇÃO (defeito atual): 5 páginas lidas em silêncio (histórico inteiro); só o filtro LOCAL evita erro — nenhum alerta, execução normal', () => {
    const paginas = ad.gcFetchPage.mock.calls.filter(c => c[0] === '/vendas').map(c => c[1].pagina);
    expect(paginas).toEqual([1, 2, 3, 4, 5]);
    expect(out.erro).toBeNull(); expect(out.r.modifiedVendas).toBe(aPartirDoCursor.length); expect(out.r.cursorAdvanced).toBe(true);
    expect(out.r.alerta).toBeUndefined();
  });
  defeito('DESEJADO (Etapa C): filtro ignorado ⇒ ABORTA com alerta FILTRO_INCREMENTAL_IGNORADO e PRESERVA o cursor', async () => {
    const ad2 = adaptadores(gcQueIgnoraOFiltro(), CURSOR); const o = await executar(ad2);
    expect(o.erro && o.erro.codigo).toBe('FILTRO_INCREMENTAL_IGNORADO');
    expect(ad2.firestoreSetSyncState).not.toHaveBeenCalled();
  });
});
