'use strict';

/**
 * CATEG360-01 → CATEG360-06
 * Testa a preservação de categorias (nome_grupo) no ciclo incremental.
 *
 * Invariante:
 *   nome_grupo vem do endpoint /produtos (produtosPorId), não de vendas_gc.
 *   O incremental re-fetcha /produtos a cada ciclo, garantindo categorias atualizadas.
 *   Produto sem nome_grupo no mapa → categoria = 'SEM_CATEGORIA' (correto).
 *
 * Ordem das calls a gcFetchPage:
 *   Call 1: /vendas  (página 1, sem proxima_pagina → para aqui)
 *   Call 2: /produtos (página 1, sem proxima_pagina → para aqui)
 *   Total: 2 calls por ciclo sem paginação.
 */

const { runIncremental } = require('../lib/sync360');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkVenda(id, clienteId, modificadoEm, produtos = []) {
  const data = (modificadoEm || '2026-09-15 10:00:00').slice(0, 10);
  return {
    id:            String(id),
    cliente_id:    String(clienteId),
    data,
    nome_situacao: 'Concretizada',
    valor_total:   '500.00',
    modificado_em: modificadoEm || `${data} 10:00:00`,
    cadastrado_em: `${data} 09:00:00`,
    vendedor_id:   '10',
    nome_vendedor: 'Vendedor Teste',
    produtos,
  };
}

function mkAdapters(overrides = {}) {
  const writes = { vendas: [], perfis: {}, syncState: null };
  const base = {
    gcFetchPage:             jest.fn().mockResolvedValue({ data: [], meta: {} }),
    firestoreGetClientes:    jest.fn().mockResolvedValue([]),
    firestoreGetVendasByCliente: jest.fn().mockResolvedValue([]),
    firestoreGetVendaById:   jest.fn().mockResolvedValue(null),
    firestoreGetPerfil:      jest.fn().mockResolvedValue(null),
    firestoreUpsertVendas:   jest.fn().mockImplementation(async vs => { writes.vendas.push(...vs); }),
    firestoreUpsertPerfil:   jest.fn().mockImplementation(async (id, p) => { writes.perfis[id] = p; }),
    firestoreGetSyncState:   jest.fn().mockResolvedValue({ modifiedSinceCursor: '2026-09-15 09:00:00' }),
    firestoreSetSyncState:   jest.fn().mockImplementation(async doc => { writes.syncState = doc; }),
    dryRun:         false,
    dataReferencia: '2026-09-16',
    _writes: writes,
  };
  return { ...base, ...overrides, _writes: writes };
}

// ── CATEG360-01: incremental preserva nome_grupo quando produtosPorId tem a categoria ───

test('CATEG360-01: incremental com produtosPorId contendo nome_grupo gera categoria correta', async () => {
  const clienteId = 'gc001';
  const docId     = 'docA';
  const venda = mkVenda('v1', clienteId, '2026-09-15 11:00:00', [
    { produto_id: 'p1', nome_produto: 'Produto 1', quantidade: '2', valor_total: '200.00' },
  ]);

  const adapters = mkAdapters();
  // Call 1: /vendas  Call 2: /produtos
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [{ id: 'p1', nome_grupo: 'LUBRIFICANTES', nome_produto: 'Produto 1' }], meta: {} });

  adapters.firestoreGetClientes.mockResolvedValue([
    { firestoreDocumentId: docId, gestaoClickId: clienteId },
  ]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  const perfil = adapters._writes.perfis[docId];
  expect(perfil).toBeDefined();
  expect(perfil.categoriasMaisCompradas).toBeDefined();
  const cat = perfil.categoriasMaisCompradas.find(c => c.categoria === 'LUBRIFICANTES');
  expect(cat).toBeDefined();
  expect(perfil.categoriasMaisCompradas.some(c => c.categoria === 'SEM_CATEGORIA')).toBe(false);
});

// ── CATEG360-02: produto sem nome_grupo resulta em SEM_CATEGORIA ──────────────

test('CATEG360-02: produto sem nome_grupo no mapa de produtos → categoria SEM_CATEGORIA', async () => {
  const clienteId = 'gc002';
  const docId     = 'docB';
  const venda = mkVenda('v2', clienteId, '2026-09-15 12:00:00', [
    { produto_id: 'pX', nome_produto: 'Produto X', quantidade: '1', valor_total: '100.00' },
  ]);

  const adapters = mkAdapters();
  // Call 1: /vendas  Call 2: /produtos (nome_grupo vazio)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [{ id: 'pX', nome_grupo: '', nome_produto: 'Produto X' }], meta: {} });

  adapters.firestoreGetClientes.mockResolvedValue([
    { firestoreDocumentId: docId, gestaoClickId: clienteId },
  ]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  const perfil = adapters._writes.perfis[docId];
  expect(perfil).toBeDefined();
  const cat = perfil.categoriasMaisCompradas.find(c => c.categoria === 'SEM_CATEGORIA');
  expect(cat).toBeDefined();
});

// ── CATEG360-03: produto não encontrado em produtosPorId → SEM_CATEGORIA ──────

test('CATEG360-03: produto_id não encontrado em produtosPorId → SEM_CATEGORIA', async () => {
  const clienteId = 'gc003';
  const docId     = 'docC';
  const venda = mkVenda('v3', clienteId, '2026-09-15 13:00:00', [
    { produto_id: 'pDesconhecido', nome_produto: 'Produto ?', quantidade: '1', valor_total: '100.00' },
  ]);

  const adapters = mkAdapters();
  // Call 1: /vendas  Call 2: /produtos (lista vazia — produto não existe no GC)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });

  adapters.firestoreGetClientes.mockResolvedValue([
    { firestoreDocumentId: docId, gestaoClickId: clienteId },
  ]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  const perfil = adapters._writes.perfis[docId];
  expect(perfil).toBeDefined();
  const cat = perfil.categoriasMaisCompradas.find(c => c.categoria === 'SEM_CATEGORIA');
  expect(cat).toBeDefined();
});

// ── CATEG360-04: múltiplas categorias, ordenadas por faturamento DESC ─────────

test('CATEG360-04: múltiplas categorias no perfil ordenadas por faturamento DESC', async () => {
  const clienteId = 'gc004';
  const docId     = 'docD';
  // Uma venda com dois produtos de categorias distintas
  const venda = mkVenda('v4', clienteId, '2026-09-15 14:00:00', [
    { produto_id: 'p10', nome_produto: 'Produto 10', quantidade: '1', valor_total: '1000.00' },
    { produto_id: 'p20', nome_produto: 'Produto 20', quantidade: '1', valor_total: '200.00' },
  ]);

  const adapters = mkAdapters();
  // Call 1: /vendas  Call 2: /produtos
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [
      { id: 'p10', nome_grupo: 'FILTROS',       nome_produto: 'Produto 10' },
      { id: 'p20', nome_grupo: 'LUBRIFICANTES', nome_produto: 'Produto 20' },
    ], meta: {} });

  adapters.firestoreGetClientes.mockResolvedValue([
    { firestoreDocumentId: docId, gestaoClickId: clienteId },
  ]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  const perfil = adapters._writes.perfis[docId];
  expect(perfil).toBeDefined();
  const cats = perfil.categoriasMaisCompradas;
  expect(cats.length).toBe(2);
  // FILTROS faturamento=1000 > LUBRIFICANTES faturamento=200 → FILTROS primeiro
  expect(cats[0].categoria).toBe('FILTROS');
  expect(cats[0].faturamento >= cats[1].faturamento).toBe(true);
});

// ── CATEG360-05: dry-run não grava perfil mas newCursor correto ───────────────

test('CATEG360-05: dry-run com produtosPorId não grava perfil (FIRESTORE_WRITES=ZERO)', async () => {
  const clienteId = 'gc005';
  const docId     = 'docE';
  const venda = mkVenda('v5', clienteId, '2026-09-15 15:00:00', [
    { produto_id: 'p1', nome_produto: 'P1', quantidade: '1', valor_total: '100.00' },
  ]);

  const adapters = mkAdapters({ dryRun: true });
  // Call 1: /vendas  Call 2: /produtos
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [{ id: 'p1', nome_grupo: 'PNEUS' }], meta: {} });

  adapters.firestoreGetClientes.mockResolvedValue([
    { firestoreDocumentId: docId, gestaoClickId: clienteId },
  ]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  const result = await runIncremental(adapters);

  expect(result.dryRun).toBe(true);
  expect(result.cursorAdvanced).toBe(false);
  expect(result.newCursor).toBe('2026-09-15 15:00:00');
  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});

// ── CATEG360-06: recálculo a partir do mirror preserva categorias existentes ──

test('CATEG360-06: recálculo incremental a partir do mirror preserva categoria da venda histórica', async () => {
  // Venda histórica armazenada em vendas_gc (sem nome_grupo — só produto_id).
  // Nova venda chega no incremental. Recálculo usa produtosPorId re-fetched
  // que resolve nome_grupo para ambas as vendas.
  const clienteId = 'gc006';
  const docId     = 'docF';

  const vendaHistorica = {
    id: 'vh1', cliente_id: clienteId, data: '2026-07-01',
    nome_situacao: 'Concretizada', valor_total: '300.00',
    modificado_em: '2026-07-01 10:00:00', cadastrado_em: '2026-07-01 09:00:00',
    vendedor_id: '10', nome_vendedor: 'V',
    produtos: [
      { produto_id: 'p1', nome_produto: 'P1', quantidade: '1', valor_total: '300.00' },
    ],
  };

  const novaVenda = mkVenda('vn1', clienteId, '2026-09-15 16:00:00', [
    { produto_id: 'p2', nome_produto: 'P2', quantidade: '1', valor_total: '150.00' },
  ]);

  const adapters = mkAdapters();
  // Call 1: /vendas  Call 2: /produtos (inclui p1 histórico E p2 novo)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [novaVenda], meta: {} })
    .mockResolvedValueOnce({ data: [
      { id: 'p1', nome_grupo: 'LUBRIFICANTES', nome_produto: 'P1' },
      { id: 'p2', nome_grupo: 'FILTROS',       nome_produto: 'P2' },
    ], meta: {} });

  adapters.firestoreGetClientes.mockResolvedValue([
    { firestoreDocumentId: docId, gestaoClickId: clienteId },
  ]);
  // Mirror contém a venda histórica
  adapters.firestoreGetVendasByCliente.mockResolvedValue([vendaHistorica]);

  await runIncremental(adapters);

  const perfil = adapters._writes.perfis[docId];
  expect(perfil).toBeDefined();
  const cats = perfil.categoriasMaisCompradas.map(c => c.categoria);
  // Ambas as categorias devem aparecer no perfil
  expect(cats).toContain('LUBRIFICANTES');
  expect(cats).toContain('FILTROS');
});
