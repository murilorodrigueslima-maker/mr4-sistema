'use strict';
// Etapa C — leitura incremental por dia, sobreposição, proteção contra filtro ignorado e reconciliação periódica.
const { runIncremental } = require('../lib/sync360');
const DIA = 86400000;
const venda = (id, m, c = '10') => ({ id: String(id), cliente_id: c, data: m.slice(0, 10), nome_situacao: 'Concretizada', valor_total: '100.00', modificado_em: m, cadastrado_em: m, vendedor_id: '1', nome_vendedor: 'V', produtos: [] });
function ad(vendas, syncState, extra = {}) {
  const w = { vendas: [], estado: null };
  const gc = jest.fn(async (ep, p) => ep === '/vendas' ? { data: typeof vendas === 'function' ? vendas(p) : vendas, meta: { proxima_pagina: null } } : { data: [], meta: {} });
  return { gcFetchPage: gc, firestoreGetClientes: async () => [{ firestoreDocumentId: 'dA', gestaoClickId: '10' }], firestoreGetVendasByCliente: async () => [], firestoreGetPerfil: async () => null,
    firestoreUpsertVendas: jest.fn(async v => { w.vendas.push(...v); }), firestoreUpsertPerfil: jest.fn(async () => {}), firestoreGetSyncState: async () => syncState,
    firestoreSetSyncState: jest.fn(async d => { w.estado = d; }), dryRun: false, dataReferencia: '2026-11-22', _w: w, ...extra };
}
const AGORA = Date.parse('2026-11-25T12:00:00Z');

describe('Etapa C — incremental por dia', () => {
  test('envia data_modificado_inicio = dia de (cursor − 24 h); nunca modificado_desde', async () => {
    const a = ad([venda(1, '2026-11-24 08:00:00')], { modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA - DIA).toISOString() }, { agoraMs: AGORA });
    await runIncremental(a); const p = a.gcFetchPage.mock.calls[0][1];
    expect(p.data_modificado_inicio).toBe('2026-11-23'); expect(p).not.toHaveProperty('modificado_desde');
  });
  test('sobreposição: vendas entre cursor−60s e o cursor entram; anteriores a isso são descartadas pelo filtro local', async () => {
    const a = ad([venda(1, '2026-11-24 06:59:30'), venda(2, '2026-11-24 06:58:00'), venda(3, '2026-11-24 09:00:00')], { modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA - DIA).toISOString() }, { agoraMs: AGORA });
    await runIncremental(a); expect(a._w.vendas.map(v => v.id).sort()).toEqual(['1', '3']);
  });
  test('cursor avança só depois das gravações e é o maior modificado_em lido', async () => {
    const a = ad([venda(1, '2026-11-24 09:00:00')], { modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA - DIA).toISOString() }, { agoraMs: AGORA });
    const r = await runIncremental(a); expect(r.cursorAdvanced).toBe(true); expect(a._w.estado.modifiedSinceCursor).toBe('2026-11-24 09:00:00');
  });
  test('filtro IGNORADO pela API (linha anterior ao dia enviado) ⇒ erro FILTRO_INCREMENTAL_IGNORADO, nada gravado, cursor preservado', async () => {
    const a = ad([venda(1, '2026-11-24 09:00:00'), venda(2, '2026-10-01 10:00:00')], { modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA - DIA).toISOString() }, { agoraMs: AGORA });
    await expect(runIncremental(a)).rejects.toMatchObject({ codigo: 'FILTRO_INCREMENTAL_IGNORADO' });
    expect(a.firestoreSetSyncState).not.toHaveBeenCalled(); expect(a.firestoreUpsertVendas).not.toHaveBeenCalled();
  });
  test('sem cursor (1ª vez) NÃO envia filtro de data', async () => {
    const a = ad([venda(1, '2026-11-24 09:00:00')], null, { agoraMs: AGORA }); await runIncremental(a);
    expect(a.gcFetchPage.mock.calls[0][1]).not.toHaveProperty('data_modificado_inicio');
  });
});

describe('Etapa C — reconciliação periódica', () => {
  test('sem reconciliação registrada ⇒ relê 30 dias (cursor − 30 d), usa TUDO que veio e grava lastReconciliationAt', async () => {
    const antigas = [venda(1, '2026-10-30 10:00:00'), venda(2, '2026-11-10 10:00:00'), venda(3, '2026-11-24 09:00:00')];
    const a = ad(antigas, { modifiedSinceCursor: '2026-11-24 07:00:00' }, { agoraMs: AGORA });
    const r = await runIncremental(a);
    expect(a.gcFetchPage.mock.calls[0][1].data_modificado_inicio).toBe('2026-10-25'); expect(r.reconciliacao).toBe(true);
    expect(a._w.vendas.map(v => v.id).sort()).toEqual(['1', '2', '3']); expect(a._w.estado.lastReconciliationAt).toBe(new Date(AGORA).toISOString());
  });
  test('reconciliação feita há menos de 7 dias ⇒ NÃO reconcilia (volta ao incremental de 24 h)', async () => {
    const a = ad([venda(3, '2026-11-24 09:00:00')], { modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA - 3 * DIA).toISOString() }, { agoraMs: AGORA });
    const r = await runIncremental(a); expect(r.reconciliacao).toBe(false); expect(a.gcFetchPage.mock.calls[0][1].data_modificado_inicio).toBe('2026-11-23');
  });
  test('reconciliação vencida (> 7 dias) ⇒ reconcilia', async () => {
    const a = ad([venda(3, '2026-11-24 09:00:00')], { modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA - 8 * DIA).toISOString() }, { agoraMs: AGORA });
    expect((await runIncremental(a)).reconciliacao).toBe(true);
  });
  test('reconciliação sem nada novo: só registra a data (sem mexer no cursor) e não grava vendas', async () => {
    const a = ad([], { modifiedSinceCursor: '2026-11-24 07:00:00' }, { agoraMs: AGORA });
    const r = await runIncremental(a); expect(r.modifiedVendas).toBe(0);
    expect(a._w.estado).toMatchObject({ modifiedSinceCursor: '2026-11-24 07:00:00', lastReconciliationAt: new Date(AGORA).toISOString() }); expect(a.firestoreUpsertVendas).not.toHaveBeenCalled();
  });
  test('falha na leitura da reconciliação ⇒ aborta, sem gravar e SEM registrar a reconciliação (tentará de novo)', async () => {
    const a = ad([], { modifiedSinceCursor: '2026-11-24 07:00:00' }, { agoraMs: AGORA });
    a.gcFetchPage = jest.fn(async () => { throw new Error('GC_HTTP_503'); });
    await expect(runIncremental(a)).rejects.toThrow('GC_HTTP_503'); expect(a.firestoreSetSyncState).not.toHaveBeenCalled();
  });
});
