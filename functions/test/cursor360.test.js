'use strict';

/**
 * CURSOR360-01 → CURSOR360-10
 * Testa a semântica de avanço do cursor no ciclo incremental.
 *
 * Invariante principal:
 *   cursor = max(modificado_em das vendas processadas com sucesso pelo mirror)
 *   NÃO depende de profile_writes, clientes_afetados ou PROFILE_WRITES=0.
 *   Bloqueado APENAS por exceção em adapter (venda write, profile write, cursor write).
 */

const {
  runIncremental,
  buildCursorWithOverlap,
  CURSOR_OVERLAP_SECS,
} = require('../lib/sync360');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkVenda(id, clienteId, modificadoEm, situacao = 'Concretizada', valor = '100.00') {
  const data = (modificadoEm || '2026-09-15 10:00:00').slice(0, 10);
  return {
    id:            String(id),
    cliente_id:    String(clienteId),
    data,
    nome_situacao: situacao,
    valor_total:   valor,
    modificado_em: modificadoEm || `${data} 10:00:00`,
    cadastrado_em: `${data} 09:00:00`,
    vendedor_id:   '10',
    nome_vendedor: 'Vendedor Padrão',
    produtos:      [],
  };
}

function mkCliente(docId, gcId) {
  return { firestoreDocumentId: String(docId), gestaoClickId: String(gcId) };
}

const CURSOR_BASE = '2026-09-15 10:00:00';

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
    firestoreGetSyncState:   jest.fn().mockResolvedValue({ modifiedSinceCursor: CURSOR_BASE }),
    firestoreSetSyncState:   jest.fn().mockImplementation(async doc => { writes.syncState = doc; }),
    dryRun:         false,
    dataReferencia: '2026-09-16',
    _writes: writes,
  };
  return { ...base, ...overrides, _writes: writes };
}

function setupVenda(adapters, venda) {
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })  // /vendas
    .mockResolvedValueOnce({ data: [], meta: {} })        // /produtos page 1
    .mockResolvedValueOnce({ data: [], meta: {} });        // guard extra page
}

// ── CURSOR360-01: venda órfã permite avanço ────────────────────────────────────

test('CURSOR360-01: venda órfã processada com sucesso permite cursor avançar', async () => {
  const vendaOrfa = mkVenda('v99', 'gc_sem_vinculo', '2026-09-15 11:00:00');
  const adapters  = mkAdapters();
  setupVenda(adapters, vendaOrfa);
  // Nenhum cliente vinculado — orphan
  adapters.firestoreGetClientes.mockResolvedValue([]);

  const result = await runIncremental(adapters);

  expect(result.cursorAdvanced).toBe(true);
  expect(result.creates).toBe(0);
  expect(result.updates).toBe(0);
  expect(adapters.firestoreUpsertVendas).toHaveBeenCalledTimes(1);
  expect(adapters._writes.syncState?.modifiedSinceCursor).toBe('2026-09-15 11:00:00');
});

// ── CURSOR360-02: CLIENTES_AFETADOS=0 não bloqueia cursor ────────────────────

test('CURSOR360-02: CLIENTES_AFETADOS=0 não bloqueia cursor', async () => {
  const venda    = mkVenda('v1', 'gc999', '2026-09-15 12:00:00');
  const adapters = mkAdapters();
  setupVenda(adapters, venda);
  // Clientes existem, mas gc999 não está entre eles → linkedAffected = []
  adapters.firestoreGetClientes.mockResolvedValue([
    mkCliente('docA', 'gc001'),
    mkCliente('docB', 'gc002'),
  ]);

  const result = await runIncremental(adapters);

  expect(result.cursorAdvanced).toBe(true);
  expect(result.creates).toBe(0);
  expect(adapters._writes.syncState?.modifiedSinceCursor).toBe('2026-09-15 12:00:00');
});

// ── CURSOR360-03: PROFILE_WRITES=0 não bloqueia cursor ───────────────────────

test('CURSOR360-03: PROFILE_WRITES=0 (firestoreUpsertPerfil nunca chamado) não bloqueia cursor', async () => {
  // Duas vendas para dois clientes órfãos distintos → nenhum vinculado no Firestore
  // → perfisParaEscrever = [] → firestoreUpsertPerfil = 0 chamadas
  const v1 = mkVenda('va', 'gc_orphan_1', '2026-09-15 13:00:00');
  const v2 = mkVenda('vb', 'gc_orphan_2', '2026-09-15 13:30:00');
  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [v1, v2], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([
    mkCliente('docA', 'gc_vinculado'),  // nenhum aponta para gc_orphan_*
  ]);

  const result = await runIncremental(adapters);

  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  expect(result.creates).toBe(0);
  expect(result.updates).toBe(0);
  expect(result.cursorAdvanced).toBe(true);
  expect(adapters._writes.syncState?.modifiedSinceCursor).toBe('2026-09-15 13:30:00');
});

// ── CURSOR360-04: falha venda write bloqueia cursor ───────────────────────────

test('CURSOR360-04: falha em firestoreUpsertVendas bloqueia cursor', async () => {
  const venda    = mkVenda('v3', 'gc001', '2026-09-15 14:00:00');
  const adapters = mkAdapters();
  setupVenda(adapters, venda);
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', 'gc001')]);
  adapters.firestoreUpsertVendas.mockRejectedValue(new Error('Firestore timeout'));

  await expect(runIncremental(adapters)).rejects.toThrow('Firestore timeout');

  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalledWith(
    expect.objectContaining({ modifiedSinceCursor: expect.any(String) })
  );
});

// ── CURSOR360-05: falha profile write bloqueia cursor ────────────────────────

test('CURSOR360-05: falha em firestoreUpsertPerfil bloqueia cursor', async () => {
  const venda    = mkVenda('v4', 'gc001', '2026-09-15 15:00:00');
  const adapters = mkAdapters();
  setupVenda(adapters, venda);
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', 'gc001')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);
  adapters.firestoreUpsertPerfil.mockRejectedValue(new Error('Profile write error'));

  await expect(runIncremental(adapters)).rejects.toThrow('Profile write error');

  // Cursor não deve ter sido escrito
  const cursorWritten = adapters.firestoreSetSyncState.mock.calls.some(
    call => call[0]?.modifiedSinceCursor !== undefined
  );
  expect(cursorWritten).toBe(false);
});

// ── CURSOR360-06: falha cursor write → função lança, cursorAdvanced não retornado

test('CURSOR360-06: falha em firestoreSetSyncState (cursor write) lança exceção', async () => {
  const venda    = mkVenda('v5', 'gc_orphan', '2026-09-15 16:00:00');
  const adapters = mkAdapters();
  setupVenda(adapters, venda);
  adapters.firestoreGetClientes.mockResolvedValue([]);
  adapters.firestoreSetSyncState.mockRejectedValue(new Error('SyncState write error'));

  // Função deve lançar — cursorAdvanced nunca fica true
  let threwError = false;
  try {
    await runIncremental(adapters);
  } catch (e) {
    threwError = true;
    expect(e.message).toMatch('SyncState write error');
  }
  expect(threwError).toBe(true);
});

// ── CURSOR360-07: delta vazio mantém cursor ───────────────────────────────────

test('CURSOR360-07: delta vazio (modifiedVendas=0) mantém cursor e não avança', async () => {
  const adapters = mkAdapters();
  // gcFetchPage retorna zero vendas após filtro local
  adapters.gcFetchPage.mockResolvedValue({ data: [], meta: {} });
  adapters.firestoreGetSyncState.mockResolvedValue({ modifiedSinceCursor: CURSOR_BASE });

  const result = await runIncremental(adapters);

  expect(result.cursorAdvanced).toBe(false);
  expect(result.modifiedVendas).toBe(0);
  expect(result.newCursor).toBe(CURSOR_BASE);   // cursor retido
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});

// ── CURSOR360-08: duas vendas com mesmo modificado_em são seguras ─────────────

test('CURSOR360-08: duas vendas com mesmo modificado_em — cursor = esse timestamp', async () => {
  const ts    = '2026-09-15 17:00:00';
  const v1    = mkVenda('v10', 'gc_orphan_A', ts);
  const v2    = mkVenda('v11', 'gc_orphan_B', ts);
  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [v1, v2], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([]);

  const result = await runIncremental(adapters);

  expect(result.cursorAdvanced).toBe(true);
  expect(result.newCursor).toBe(ts);
  expect(adapters._writes.syncState?.modifiedSinceCursor).toBe(ts);
});

// ── CURSOR360-09: rerun com overlap permanece idempotente ──────────────────────

test('CURSOR360-09: rerun com overlap regressa mesma venda — write idempotente, cursor estável', async () => {
  const ts    = '2026-09-15 17:17:23';  // mesmo ts do cursor
  const venda = mkVenda('vX', 'gc_orphan', ts);
  const cursor = ts;

  // Execução 1
  const adapters1 = mkAdapters();
  adapters1.firestoreGetSyncState.mockResolvedValue({ modifiedSinceCursor: cursor });
  adapters1.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters1.firestoreGetClientes.mockResolvedValue([]);
  const r1 = await runIncremental(adapters1);

  // Execução 2 (idempotente)
  const adapters2 = mkAdapters();
  adapters2.firestoreGetSyncState.mockResolvedValue({
    modifiedSinceCursor: adapters1._writes.syncState?.modifiedSinceCursor || cursor,
  });
  adapters2.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters2.firestoreGetClientes.mockResolvedValue([]);
  const r2 = await runIncremental(adapters2);

  // Ambas execuções: cursor = ts original, nenhum profile criado, writes idempotentes
  expect(r1.newCursor).toBe(ts);
  expect(r2.newCursor).toBe(ts);
  expect(r1.creates).toBe(0);
  expect(r2.creates).toBe(0);
  expect(r1.cursorAdvanced).toBe(true);
  expect(r2.cursorAdvanced).toBe(true);
  // Número de venda writes igual nos dois runs
  expect(adapters1.firestoreUpsertVendas).toHaveBeenCalledTimes(1);
  expect(adapters2.firestoreUpsertVendas).toHaveBeenCalledTimes(1);
});

// ── CURSOR360-10: venda órfã não cria Perfil360 ───────────────────────────────

test('CURSOR360-10: venda com cliente_id sem vínculo MR4 não cria nem altera Perfil360', async () => {
  const vendaOrfa = mkVenda('v99', 'gc_desconhecido_9999', '2026-09-15 18:00:00');
  const adapters  = mkAdapters();
  setupVenda(adapters, vendaOrfa);
  // Clientes com vínculos reais — nenhum aponta para gc_desconhecido_9999
  adapters.firestoreGetClientes.mockResolvedValue([
    mkCliente('docA', 'gc001'),
    mkCliente('docB', 'gc002'),
  ]);

  await runIncremental(adapters);

  // Venda gravada no mirror
  expect(adapters.firestoreUpsertVendas).toHaveBeenCalledTimes(1);
  const vendasWritten = adapters._writes.vendas;
  expect(vendasWritten.some(v => String(v.id) === 'v99')).toBe(true);

  // Perfil NÃO criado para o cliente órfão
  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  expect(Object.keys(adapters._writes.perfis)).toHaveLength(0);

  // Cursor avançou
  expect(adapters._writes.syncState?.modifiedSinceCursor).toBe('2026-09-15 18:00:00');
});
