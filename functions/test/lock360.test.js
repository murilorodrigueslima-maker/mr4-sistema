'use strict';

/**
 * LOCK360-01 → LOCK360-07
 * Testa o mecanismo de lock de concorrência do ciclo incremental.
 *
 * Invariante:
 *   - Dois ciclos incrementais simultâneos não podem correr cursor/mirror concorrentemente.
 *   - Se firestoreAcquireLock retorna false → lança INCREMENTAL_LOCK_NOT_ACQUIRED.
 *   - Lock é liberado no finally mesmo quando o core lança exceção.
 *   - Sem adapters de lock → comportamento legacy (sem lock), sem erros.
 */

const { runIncremental, LOCK_TIMEOUT_MS } = require('../lib/sync360');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkVenda(id, clienteId, modificadoEm) {
  const data = (modificadoEm || '2026-09-15 10:00:00').slice(0, 10);
  return {
    id:            String(id),
    cliente_id:    String(clienteId),
    data,
    nome_situacao: 'Concretizada',
    valor_total:   '100.00',
    modificado_em: modificadoEm || `${data} 10:00:00`,
    cadastrado_em: `${data} 09:00:00`,
    vendedor_id:   '10',
    nome_vendedor: 'V',
    produtos:      [],
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

// ── LOCK360-01: sem adapters de lock → executa normalmente (backward-compat) ──

test('LOCK360-01: sem firestoreAcquireLock/Release, incremental funciona normalmente (legacy)', async () => {
  const venda = mkVenda('v1', 'gc_orphan', '2026-09-15 11:00:00');
  const adapters = mkAdapters();
  // Call 1: /vendas  Call 2: /produtos (vazio — orphan, sem perfil)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });

  // Sem propriedades de lock — legacy
  expect(adapters.firestoreAcquireLock).toBeUndefined();
  expect(adapters.firestoreReleaseLock).toBeUndefined();

  const result = await runIncremental(adapters);
  expect(result.cursorAdvanced).toBe(true);
});

// ── LOCK360-02: lock adquirido com sucesso → incremental executa normalmente ──

test('LOCK360-02: firestoreAcquireLock retorna true → incremental executa normalmente', async () => {
  const venda = mkVenda('v2', 'gc_orphan', '2026-09-15 12:00:00');
  const lockCalls = { acquired: [], released: [] };

  const adapters = mkAdapters({
    firestoreAcquireLock: jest.fn().mockImplementation(async (lockId, timeoutMs) => {
      lockCalls.acquired.push({ lockId, timeoutMs });
      return true;
    }),
    firestoreReleaseLock: jest.fn().mockImplementation(async (lockId) => {
      lockCalls.released.push(lockId);
    }),
  });
  // Call 1: /vendas  Call 2: /produtos (vazio — orphan)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });

  const result = await runIncremental(adapters);

  expect(result.cursorAdvanced).toBe(true);
  expect(lockCalls.acquired.length).toBe(1);
  expect(lockCalls.released.length).toBe(1);
  // lockId deve ser o mesmo entre acquire e release
  expect(lockCalls.acquired[0].lockId).toBe(lockCalls.released[0]);
  // timeout deve ser LOCK_TIMEOUT_MS
  expect(lockCalls.acquired[0].timeoutMs).toBe(LOCK_TIMEOUT_MS);
});

// ── LOCK360-03: lock não adquirido → lança erro INCREMENTAL_LOCK_NOT_ACQUIRED ─

test('LOCK360-03: firestoreAcquireLock retorna false → lança INCREMENTAL_LOCK_NOT_ACQUIRED', async () => {
  const adapters = mkAdapters({
    firestoreAcquireLock: jest.fn().mockResolvedValue(false),
    firestoreReleaseLock: jest.fn().mockResolvedValue(undefined),
  });

  await expect(runIncremental(adapters)).rejects.toThrow('INCREMENTAL_LOCK_NOT_ACQUIRED');

  // Nenhum write deve ter ocorrido
  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
  // Release NÃO deve ser chamado se acquire retornou false (lock não foi adquirido)
  expect(adapters.firestoreReleaseLock).not.toHaveBeenCalled();
});

// ── LOCK360-04: lock liberado no finally mesmo quando core lança exceção ───────

test('LOCK360-04: firestoreReleaseLock é chamado no finally mesmo quando core falha', async () => {
  const venda = mkVenda('v4', 'gc_orphan', '2026-09-15 14:00:00');
  const lockReleased = [];

  const adapters = mkAdapters({
    firestoreAcquireLock: jest.fn().mockResolvedValue(true),
    firestoreReleaseLock: jest.fn().mockImplementation(async (lockId) => {
      lockReleased.push(lockId);
    }),
  });
  // Call 1: /vendas  Call 2: /produtos (vazio)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreUpsertVendas.mockRejectedValue(new Error('Firestore timeout'));

  await expect(runIncremental(adapters)).rejects.toThrow('Firestore timeout');

  // Lock deve ter sido liberado no finally
  expect(lockReleased.length).toBe(1);
});

// ── LOCK360-05: lockId é único por execução ────────────────────────────────────

test('LOCK360-05: cada execução gera lockId único', async () => {
  const lockIds = [];
  const makeAdapters = () => {
    const a = mkAdapters({
      firestoreAcquireLock: jest.fn().mockImplementation(async (id) => {
        lockIds.push(id);
        return true;
      }),
      firestoreReleaseLock: jest.fn().mockResolvedValue(undefined),
    });
    a.gcFetchPage.mockResolvedValue({ data: [], meta: {} });
    return a;
  };

  await runIncremental(makeAdapters());
  await runIncremental(makeAdapters());
  await runIncremental(makeAdapters());

  expect(lockIds.length).toBe(3);
  const unique = new Set(lockIds);
  expect(unique.size).toBe(3);
});

// ── LOCK360-06: release falha silenciosamente (best-effort) ──────────────────

test('LOCK360-06: firestoreReleaseLock que lança exceção não propaga erro ao chamador', async () => {
  const venda = mkVenda('v6', 'gc_orphan', '2026-09-15 16:00:00');
  const adapters = mkAdapters({
    firestoreAcquireLock: jest.fn().mockResolvedValue(true),
    firestoreReleaseLock: jest.fn().mockRejectedValue(new Error('network error on release')),
  });
  // Call 1: /vendas  Call 2: /produtos (vazio — orphan)
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });

  // Não deve lançar apesar do release falhar
  const result = await runIncremental(adapters);
  expect(result.cursorAdvanced).toBe(true);
});

// ── LOCK360-07: LOCK_TIMEOUT_MS exportado e tem valor sensato ─────────────────

test('LOCK360-07: LOCK_TIMEOUT_MS é exportado, >= 5 minutos e <= 30 minutos', () => {
  expect(typeof LOCK_TIMEOUT_MS).toBe('number');
  expect(LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  expect(LOCK_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60 * 1000);
});
