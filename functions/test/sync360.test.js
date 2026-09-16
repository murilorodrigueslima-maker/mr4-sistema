'use strict';

/**
 * SYNC360-01 → SYNC360-25
 * Testa functions/lib/sync360.js em isolamento total:
 *   - ZERO chamadas reais a GestãoClick, Firestore ou qualquer I/O externa
 *   - Todos os adaptadores são stubs/mocks injetados
 */

const {
  calcularDataReferencia,
  minimalVenda,
  dadosMudaram,
  buildCursorWithOverlap,
  buildProdutosPorId,
  fetchAllPagesByProximaPagina,
  runBootstrap,
  runIncremental,
  CURSOR_OVERLAP_SECS,
} = require('../lib/sync360');

// ── Helpers de teste ───────────────────────────────────────────────────────────

function mkVenda(id, clienteId, data = '2026-09-01', situacao = 'Concretizada', valor = '100.00') {
  return {
    id:            String(id),
    cliente_id:    String(clienteId),
    data,
    nome_situacao: situacao,
    valor_total:   valor,
    modificado_em: `${data} 10:00:00`,
    cadastrado_em: `${data} 09:00:00`,
    vendedor_id:   '10',
    nome_vendedor: 'Vendedor Padrão',
    produtos:      [],
  };
}

function mkCliente(docId, gcId) {
  return { firestoreDocumentId: String(docId), gestaoClickId: String(gcId) };
}

/** Cria stubs de adaptadores com comportamento padrão (vazio). */
function mkAdapters(overrides = {}) {
  const writes = { vendas: [], perfis: {}, syncState: null };
  return {
    gcFetchPage:            jest.fn().mockResolvedValue({ data: [], meta: {} }),
    firestoreGetClientes:   jest.fn().mockResolvedValue([]),
    firestoreGetPerfil:     jest.fn().mockResolvedValue(null),
    firestoreGetVendasByCliente: jest.fn().mockResolvedValue([]),
    firestoreUpsertVendas:  jest.fn().mockImplementation(async vs => { writes.vendas.push(...vs); }),
    firestoreUpsertPerfil:  jest.fn().mockImplementation(async (id, p) => { writes.perfis[id] = p; }),
    firestoreGetSyncState:  jest.fn().mockResolvedValue(null),
    firestoreSetSyncState:  jest.fn().mockImplementation(async doc => { writes.syncState = doc; }),
    dryRun:        false,
    dataReferencia: '2026-09-15',
    _writes: writes,
    ...overrides,
  };
}

// ── SYNC360-01: calcularDataReferencia ────────────────────────────────────────

test('SYNC360-01: calcularDataReferencia retorna string YYYY-MM-DD de 10 chars', () => {
  const dr = calcularDataReferencia();
  expect(typeof dr).toBe('string');
  expect(dr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('SYNC360-01b: calcularDataReferencia com Date injetado retorna data determinística', () => {
  // UTC 2026-09-15T15:00:00Z = Fortaleza 2026-09-15T12:00:00 (UTC-3)
  const now = new Date('2026-09-15T15:00:00Z');
  const dr = calcularDataReferencia(now);
  expect(dr).toBe('2026-09-15');
});

// ── SYNC360-02: minimalVenda normaliza campos ─────────────────────────────────

test('SYNC360-02: minimalVenda mapeia campos essenciais corretamente', () => {
  const raw = {
    id: '999', cliente_id: '42', data: '2026-09-01 00:00:00',
    nome_situacao: 'Concretizada', valor_total: '250.50',
    modificado_em: '2026-09-02 10:30:00', cadastrado_em: '2026-09-01 09:00:00',
    vendedor_id: '7', nome_vendedor: 'Ana',
    produtos: [{ produto_id: '1', nome_produto: 'Filtro', quantidade: '2', valor_total: '50.00' }],
  };
  const m = minimalVenda(raw);
  expect(m.id).toBe('999');
  expect(m.cliente_id).toBe('42');
  expect(m.data).toBe('2026-09-01');  // trunca para 10 chars
  expect(m.nome_situacao).toBe('Concretizada');
  expect(m.valor_total).toBe('250.50');
  expect(m.modificado_em).toBe('2026-09-02 10:30:00');
  expect(m.produtos).toHaveLength(1);
  expect(m.produtos[0].produto_id).toBe('1');
  expect(m.produtos[0].quantidade).toBe('2');
});

// ── SYNC360-03: minimalVenda com produtos ausentes ────────────────────────────

test('SYNC360-03: minimalVenda com produtos undefined → array vazio', () => {
  const raw = { id: '1', cliente_id: '2', data: '2026-01-01', nome_situacao: 'X',
                valor_total: '0', modificado_em: '', cadastrado_em: '', vendedor_id: '', nome_vendedor: '' };
  const m = minimalVenda(raw);
  expect(m.produtos).toEqual([]);
});

test('SYNC360-03b: minimalVenda filtra produtos sem produto_id', () => {
  const raw = {
    id: '1', cliente_id: '2', data: '2026-01-01', nome_situacao: 'X',
    valor_total: '0', modificado_em: '', cadastrado_em: '', vendedor_id: '', nome_vendedor: '',
    produtos: [{ nome_produto: 'Sem ID', quantidade: '1', valor_total: '0' }],
  };
  const m = minimalVenda(raw);
  expect(m.produtos).toHaveLength(0);
});

// ── SYNC360-04: dadosMudaram — existing=null → sempre true ───────────────────

test('SYNC360-04: dadosMudaram retorna true quando existing é null', () => {
  expect(dadosMudaram(null, { faturamentoTotal: 100, nuncaComprou: false })).toBe(true);
});

// ── SYNC360-05: dadosMudaram — campo determinístico diferente ────────────────

test('SYNC360-05: dadosMudaram retorna true quando campo determinístico difere', () => {
  const existing = { faturamentoTotal: 100, nuncaComprou: false };
  const novo     = { faturamentoTotal: 200, nuncaComprou: false };
  expect(dadosMudaram(existing, novo)).toBe(true);
});

// ── SYNC360-06: dadosMudaram — todos campos iguais → false ───────────────────

test('SYNC360-06: dadosMudaram retorna false quando todos os campos determinísticos são iguais', () => {
  const base = { faturamentoTotal: 100, pedidosTotal: 3, nuncaComprou: false };
  expect(dadosMudaram({ ...base }, { ...base })).toBe(false);
});

// ── SYNC360-07: dadosMudaram ignora calculadoEm ──────────────────────────────

test('SYNC360-07: dadosMudaram ignora diferença em calculadoEm', () => {
  const existing = { faturamentoTotal: 100, calculadoEm: '2026-09-14T00:00:00Z' };
  const novo     = { faturamentoTotal: 100, calculadoEm: '2026-09-15T00:00:00Z' };
  expect(dadosMudaram(existing, novo)).toBe(false);
});

// ── SYNC360-08: dadosMudaram ignora _conflicts ───────────────────────────────

test('SYNC360-08: dadosMudaram ignora diferença em _conflicts', () => {
  const existing = { faturamentoTotal: 100, _conflicts: [] };
  const novo     = { faturamentoTotal: 100, _conflicts: [{ id: '1' }] };
  expect(dadosMudaram(existing, novo)).toBe(false);
});

// ── SYNC360-09: buildCursorWithOverlap — subtrai 60 segundos ─────────────────

test('SYNC360-09: buildCursorWithOverlap subtrai 60 segundos', () => {
  const result = buildCursorWithOverlap('2026-09-15 10:01:30', 60);
  expect(result).toBe('2026-09-15 10:00:30');
});

// ── SYNC360-10: buildCursorWithOverlap — rollover de meia-noite ───────────────

test('SYNC360-10: buildCursorWithOverlap lida com rollover de hora/minuto', () => {
  const result = buildCursorWithOverlap('2026-09-15 10:00:00', 120);
  expect(result).toBe('2026-09-15 09:58:00');
});

test('SYNC360-10b: buildCursorWithOverlap retorna null quando input é null', () => {
  expect(buildCursorWithOverlap(null, 60)).toBeNull();
});

// ── SYNC360-11: buildProdutosPorId — deduplica por id ────────────────────────

test('SYNC360-11: buildProdutosPorId constrói mapa e deduplica por id', () => {
  const produtos = [
    { id: '1', nome_grupo: 'Filtros' },
    { id: '2', nome_grupo: 'Óleo' },
    { id: '1', nome_grupo: 'Filtros (duplicado)' },  // mesmo id → ignorar
  ];
  const mapa = buildProdutosPorId(produtos);
  expect(Object.keys(mapa)).toHaveLength(2);
  expect(mapa['1'].nome_grupo).toBe('Filtros');  // primeiro prevalece
  expect(mapa['2'].nome_grupo).toBe('Óleo');
});

// ── SYNC360-12: fetchAllPagesByProximaPagina — página única ──────────────────

test('SYNC360-12: fetchAllPagesByProximaPagina retorna página única quando sem proxima_pagina', async () => {
  const gcFetchPage = jest.fn().mockResolvedValue({
    data: [{ id: '1' }, { id: '2' }],
    meta: {},
  });
  const result = await fetchAllPagesByProximaPagina(gcFetchPage, '/vendas', { limite: 2 });
  expect(result).toHaveLength(2);
  expect(gcFetchPage).toHaveBeenCalledTimes(1);
});

// ── SYNC360-13: fetchAllPagesByProximaPagina — múltiplas páginas ──────────────

test('SYNC360-13: fetchAllPagesByProximaPagina pagina via meta.proxima_pagina', async () => {
  const gcFetchPage = jest.fn()
    .mockResolvedValueOnce({ data: [{ id: '1' }], meta: { proxima_pagina: '2' } })
    .mockResolvedValueOnce({ data: [{ id: '2' }], meta: { proxima_pagina: '3' } })
    .mockResolvedValueOnce({ data: [{ id: '3' }], meta: {} });

  const result = await fetchAllPagesByProximaPagina(gcFetchPage, '/vendas', {});
  expect(result).toHaveLength(3);
  expect(result.map(v => v.id)).toEqual(['1', '2', '3']);
  expect(gcFetchPage).toHaveBeenCalledTimes(3);
});

// ── SYNC360-14: fetchAllPagesByProximaPagina — para sem proxima_pagina ────────

test('SYNC360-14: fetchAllPagesByProximaPagina para ao receber meta sem proxima_pagina', async () => {
  const gcFetchPage = jest.fn().mockResolvedValue({ data: [{ id: '1' }], meta: { total: 1 } });
  const result = await fetchAllPagesByProximaPagina(gcFetchPage, '/vendas', {});
  expect(gcFetchPage).toHaveBeenCalledTimes(1);
  expect(result).toHaveLength(1);
});

// ── SYNC360-15: fetchAllPagesByProximaPagina — proteção circular ─────────────

test('SYNC360-15: fetchAllPagesByProximaPagina protege contra paginação circular', async () => {
  const gcFetchPage = jest.fn().mockResolvedValue({ data: [{ id: '1' }], meta: { proxima_pagina: '1' } });
  const result = await fetchAllPagesByProximaPagina(gcFetchPage, '/vendas', {});
  // Deve parar após detectar que pagina=1 já foi visitada
  expect(gcFetchPage).toHaveBeenCalledTimes(1);
  expect(result).toHaveLength(1);
});

// ── SYNC360-16: runBootstrap dryRun=true sem writes ─────────────────────────

test('SYNC360-16: runBootstrap dryRun=true retorna counts sem chamar adapters de escrita', async () => {
  const adapters = mkAdapters({ dryRun: true });
  adapters.gcFetchPage.mockResolvedValue({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([]);

  const r = await runBootstrap(adapters);

  expect(r.dryRun).toBe(true);
  expect(r.creates).toBe(0);
  expect(r.unchanged).toBe(0);
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});

// ── SYNC360-17: runBootstrap cria perfis para clientes com vendas ─────────────

test('SYNC360-17: runBootstrap dryRun=true counts creates corretamente', async () => {
  const v1 = mkVenda('1001', '10');
  const v2 = mkVenda('1002', '20');

  const adapters = mkAdapters({ dryRun: true });
  adapters.gcFetchPage.mockResolvedValueOnce({ data: [v1, v2], meta: {} })  // /vendas
                      .mockResolvedValueOnce({ data: [], meta: {} });         // /produtos
  adapters.firestoreGetClientes.mockResolvedValue([
    mkCliente('docA', '10'),
    mkCliente('docB', '20'),
  ]);
  // existing perfis = null → cria
  adapters.firestoreGetPerfil.mockResolvedValue(null);

  const r = await runBootstrap(adapters);
  expect(r.creates).toBe(2);
  expect(r.updates).toBe(0);
  expect(r.unchanged).toBe(0);
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
});

// ── SYNC360-18: runBootstrap unchanged quando perfil existe e dados iguais ────

test('SYNC360-18: runBootstrap conta unchanged quando perfil existe e dados não mudaram', async () => {
  const v1 = mkVenda('101', '10');
  const adapters = mkAdapters({ dryRun: false });
  adapters.gcFetchPage.mockResolvedValueOnce({ data: [v1], meta: {} })
                      .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);

  // Primeiro run real para obter o perfil calculado
  const firstAdapters = mkAdapters({ dryRun: true });
  firstAdapters.gcFetchPage = adapters.gcFetchPage;
  firstAdapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);
  firstAdapters.firestoreGetPerfil.mockResolvedValue(null);
  await runBootstrap(firstAdapters);

  // Segundo run: perfil "existe" com mesmos dados determinísticos
  // Simula: existing tem os mesmos campos que o engine produziria
  // Basta devolver o que o engine calcularia — usamos firestoreGetPerfil stub
  // Dado que não temos o objeto exato, testamos apenas que unchanged > 0 quando dados iguais
  // Para isso, capturamos o perfil gerado no run real
  const { VERSAO_ENGINE } = require('../lib/sync360');

  // Re-run com perfil "existente" que tem dados conhecidos iguais
  adapters.gcFetchPage = jest.fn()
    .mockResolvedValueOnce({ data: [v1], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);

  // Para garantir unchanged, devolvemos um perfil idêntico ao engine produzirá
  // O mais simples: usar dadosMudaram com existing=null no 1o run (creates=1)
  // e no 2o run devolver o perfil exato → unchanged=1
  let capturedPerfil = null;
  adapters.firestoreUpsertPerfil.mockImplementation(async (id, p) => { capturedPerfil = p; });
  await runBootstrap(adapters);  // run real (dryRun=false), creates=1

  // Agora second run com o perfil capturado como existing
  const adapters2 = mkAdapters({ dryRun: true });
  adapters2.gcFetchPage = jest.fn()
    .mockResolvedValueOnce({ data: [v1], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters2.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);
  adapters2.firestoreGetPerfil.mockResolvedValue(capturedPerfil);  // existing = mesmo perfil

  const r2 = await runBootstrap(adapters2);
  expect(r2.unchanged).toBe(1);
  expect(r2.creates).toBe(0);
  expect(r2.updates).toBe(0);
});

// ── SYNC360-19: runBootstrap updates quando dados diferem ────────────────────

test('SYNC360-19: runBootstrap conta updates quando perfil existe mas dados mudaram', async () => {
  const v1 = mkVenda('201', '10');
  const adapters = mkAdapters({ dryRun: true });
  adapters.gcFetchPage = jest.fn()
    .mockResolvedValueOnce({ data: [v1], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);
  // Existing perfil tem faturamentoTotal diferente → update
  adapters.firestoreGetPerfil.mockResolvedValue({ faturamentoTotal: 9999, pedidosTotal: 99, nuncaComprou: false });

  const r = await runBootstrap(adapters);
  expect(r.updates).toBe(1);
  expect(r.creates).toBe(0);
  expect(r.unchanged).toBe(0);
});

// ── SYNC360-20: runBootstrap dryRun cursor NÃO avança ────────────────────────

test('SYNC360-20: runBootstrap dryRun=true NÃO chama firestoreSetSyncState', async () => {
  const adapters = mkAdapters({ dryRun: true });
  adapters.gcFetchPage.mockResolvedValue({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([]);

  await runBootstrap(adapters);
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});

// ── SYNC360-21: runIncremental — zero vendas modificadas → no-op ──────────────

test('SYNC360-21: runIncremental retorna zero counts quando gcFetchPage retorna vazio', async () => {
  const adapters = mkAdapters();
  adapters.gcFetchPage.mockResolvedValue({ data: [], meta: {} });
  adapters.firestoreGetSyncState.mockResolvedValue({ modifiedSinceCursor: '2026-09-14 12:00:00' });

  const r = await runIncremental(adapters);
  expect(r.modifiedVendas).toBe(0);
  expect(r.creates).toBe(0);
  expect(r.cursorAdvanced).toBe(false);
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});

// ── SYNC360-22: runIncremental merge mirror + modified ────────────────────────

test('SYNC360-22: runIncremental faz merge de venda modificada no mirror antes de recalcular', async () => {
  const vOld = { ...mkVenda('301', '10', '2026-08-01'), nome_situacao: 'Aguardando', valor_total: '0.00' };
  const vNew = { ...mkVenda('301', '10', '2026-08-01'), nome_situacao: 'Concretizada', valor_total: '500.00' };

  const adapters = mkAdapters({ dryRun: false });
  adapters.gcFetchPage = jest.fn()
    .mockResolvedValueOnce({ data: [vNew], meta: {} })   // /vendas (incremental)
    .mockResolvedValueOnce({ data: [], meta: {} });        // /produtos
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([minimalVenda(vOld)]);
  adapters.firestoreGetPerfil.mockResolvedValue(null);
  adapters.firestoreGetSyncState.mockResolvedValue(null);

  const r = await runIncremental(adapters);
  expect(r.creates).toBe(1);  // perfil novo (existing=null)
  expect(r.modifiedVendas).toBe(1);

  // Perfil calculado deve refletir a venda NOVA (Concretizada), não a antiga
  const perfilSalvo = adapters._writes.perfis['docA'];
  expect(perfilSalvo.nuncaComprou).toBe(false);
  expect(perfilSalvo.pedidosTotal).toBe(1);
});

// ── SYNC360-23: runIncremental cursor avança APÓS writes ─────────────────────

test('SYNC360-23: runIncremental cursor avança somente após writes bem-sucedidos', async () => {
  const vend = mkVenda('401', '10');
  vend.modificado_em = '2026-09-15 15:00:00';

  const adapters = mkAdapters({ dryRun: false });
  adapters.gcFetchPage = jest.fn()
    .mockResolvedValueOnce({ data: [vend], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);
  adapters.firestoreGetPerfil.mockResolvedValue(null);
  adapters.firestoreGetSyncState.mockResolvedValue(null);

  let syncStateCalledAfterUpsert = false;
  let upsertCalled = false;
  adapters.firestoreUpsertPerfil.mockImplementation(async () => { upsertCalled = true; });
  adapters.firestoreSetSyncState.mockImplementation(async doc => {
    syncStateCalledAfterUpsert = upsertCalled;
    adapters._writes.syncState = doc;
  });

  const r = await runIncremental(adapters);
  expect(r.cursorAdvanced).toBe(true);
  expect(syncStateCalledAfterUpsert).toBe(true);  // syncState foi após upsert
  expect(adapters._writes.syncState.modifiedSinceCursor).toBe('2026-09-15 15:00:00');
});

// ── SYNC360-24: runIncremental usa cursor com overlap ────────────────────────

test('SYNC360-24: runIncremental passa cursor com overlap para gcFetchPage', async () => {
  const adapters = mkAdapters({ dryRun: false });
  adapters.gcFetchPage.mockResolvedValue({ data: [], meta: {} });
  adapters.firestoreGetSyncState.mockResolvedValue({
    modifiedSinceCursor: '2026-09-15 12:01:00',
  });

  await runIncremental(adapters);

  // Deve ter chamado gcFetchPage com modificado_desde = cursor - 60s
  const firstCall = adapters.gcFetchPage.mock.calls[0];
  const params    = firstCall[1];
  expect(params.modificado_desde).toBe('2026-09-15 12:00:00');
});

// ── SYNC360-24b: filtro defensivo local elimina vendas antes do cursor efetivo ─

test('SYNC360-24b: filtro local remove vendas com modificado_em antes do cursorEfetivo', async () => {
  // cursor = 12:01:00 → cursorEfetivo = 12:00:00
  // API retorna 2 vendas: uma antes (11:59:59) e uma depois (12:00:30)
  // Apenas a segunda deve ser processada (upsertVendas)
  const vendaAntes  = { ...mkVenda('v1', '1', '2026-09-15'), modificado_em: '2026-09-15 11:59:59' };
  const vendaDepois = { ...mkVenda('v2', '1', '2026-09-15'), modificado_em: '2026-09-15 12:00:30' };

  const adapters = mkAdapters({ dryRun: false });
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [vendaAntes, vendaDepois], meta: {} })  // /vendas
    .mockResolvedValueOnce({ data: [], meta: {} });                         // /produtos

  adapters.firestoreGetSyncState.mockResolvedValue({
    modifiedSinceCursor: '2026-09-15 12:01:00',
  });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  // Apenas vendaDepois deve ter sido escrita (vendaAntes filtrada localmente)
  const vendasEscritas = adapters._writes.vendas;
  expect(vendasEscritas).toHaveLength(1);
  expect(vendasEscritas[0].id).toBe('v2');
});

// ── SYNC360-25: runBootstrap aborta se gcFetchPage falhar ────────────────────

test('SYNC360-25: runBootstrap aborta sem nenhum write se gcFetchPage lança exceção', async () => {
  const adapters = mkAdapters({ dryRun: false });
  adapters.gcFetchPage.mockRejectedValue(new Error('Timeout GC API'));
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '10')]);

  await expect(runBootstrap(adapters)).rejects.toThrow('Timeout GC API');
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});
