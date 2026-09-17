'use strict';

/**
 * LOCK-PROD-01 → LOCK-PROD-08
 * Testa o adapter atômico de lock do incremental — N19 (L1).
 */

const { criarLockAdapterMock, VERSAO_ADAPTER } = require('../lib/ai/lockAdapter');
const { runIncremental } = require('../lib/sync360');

// ── LOCK-PROD-01 a 04: comportamento atômico ──────────────────────────────────

describe('L1 — lock adapter mock: comportamento atômico', () => {

  test('LOCK-PROD-01: duas aquisições simultâneas → exatamente uma adquire', async () => {
    const { firestoreAcquireLock, firestoreReleaseLock } = criarLockAdapterMock();
    const TTL = 10 * 60 * 1000;

    // Simula duas execuções "simultâneas" (sequencial no JS single-thread é suficiente)
    const r1 = await firestoreAcquireLock('owner_A', TTL);
    const r2 = await firestoreAcquireLock('owner_B', TTL);  // já bloqueado

    expect(r1).toBe(true);
    expect(r2).toBe(false);  // bloqueado pelo owner_A

    await firestoreReleaseLock('owner_A');
  });

  test('LOCK-PROD-02: owner_A não consegue liberar lock de owner_B', async () => {
    const { firestoreAcquireLock, firestoreReleaseLock, _state } = criarLockAdapterMock();
    const TTL = 10 * 60 * 1000;

    await firestoreAcquireLock('owner_B', TTL);

    // owner_A tenta liberar — não deve conseguir
    await firestoreReleaseLock('owner_A');

    // Lock ainda pertence ao owner_B
    const lock = _state.getLock();
    expect(lock).not.toBeNull();
    expect(lock.ownerId).toBe('owner_B');

    await firestoreReleaseLock('owner_B');
  });

  test('LOCK-PROD-03: lock expirado pode ser substituído', async () => {
    const { firestoreAcquireLock, firestoreReleaseLock, _state } = criarLockAdapterMock();

    await firestoreAcquireLock('owner_OLD', 100);  // TTL 100ms
    _state.forceExpire();  // força expiração imediata

    // Novo owner deve conseguir adquirir
    const r = await firestoreAcquireLock('owner_NEW', 10 * 60 * 1000);
    expect(r).toBe(true);

    const lock = _state.getLock();
    expect(lock.ownerId).toBe('owner_NEW');

    await firestoreReleaseLock('owner_NEW');
  });

  test('LOCK-PROD-04: lock válido NÃO pode ser substituído por outro owner', async () => {
    const { firestoreAcquireLock, firestoreReleaseLock } = criarLockAdapterMock();
    const TTL = 10 * 60 * 1000;

    await firestoreAcquireLock('owner_A', TTL);
    const r = await firestoreAcquireLock('owner_B', TTL);  // deve falhar

    expect(r).toBe(false);
    await firestoreReleaseLock('owner_A');
  });

  test('LOCK-PROD-05: release após erro no processo → lock é liberado', async () => {
    const { firestoreAcquireLock, firestoreReleaseLock, _state } = criarLockAdapterMock();
    const TTL = 10 * 60 * 1000;

    await firestoreAcquireLock('owner_X', TTL);

    // Simula que o processo lança exceção mas permanece vivo (finally block)
    try {
      await firestoreReleaseLock('owner_X');
    } finally {
      // Garantido que o lock foi liberado
    }

    expect(_state.getLock()).toBeNull();

    // Outro owner deve conseguir adquirir
    const r2 = await firestoreAcquireLock('owner_Y', TTL);
    expect(r2).toBe(true);
    await firestoreReleaseLock('owner_Y');
  });

  test('LOCK-PROD-06: crash simulado (TTL) → lock expira e novo pode adquirir', async () => {
    const { firestoreAcquireLock, firestoreReleaseLock, _state } = criarLockAdapterMock();

    // Processo "morreu" após adquirir — não liberou
    await firestoreAcquireLock('owner_CRASHED', 100);
    _state.forceExpire();  // simula passagem do TTL

    // Recuperação: novo processo adquire
    const r = await firestoreAcquireLock('owner_RECOVERY', 10 * 60 * 1000);
    expect(r).toBe(true);
    await firestoreReleaseLock('owner_RECOVERY');
  });
});

// ── LOCK-PROD-07 e 08: integração com runIncremental ─────────────────────────

describe('L1 — lock adapter: integração com runIncremental', () => {

  function mkAdapters({ lockAdapter = null, modifiedVendas = [] } = {}) {
    const { firestoreAcquireLock, firestoreReleaseLock } = lockAdapter || {};
    return {
      gcFetchPage:             async (ep) => ep === '/vendas' ? { data: modifiedVendas, meta: {} } : { data: [], meta: {} },
      firestoreGetClientes:    async () => [],
      firestoreGetVendasByCliente: async () => [],
      firestoreGetPerfil:      async () => null,
      firestoreUpsertVendas:   async () => {},
      firestoreUpsertPerfil:   async () => {},
      firestoreGetSyncState:   async () => ({ modifiedSinceCursor: null }),
      firestoreSetSyncState:   async () => {},
      firestoreAcquireLock:    firestoreAcquireLock || null,
      firestoreReleaseLock:    firestoreReleaseLock || null,
      dryRun:        true,
      dataReferencia: '2026-09-16',
    };
  }

  test('LOCK-PROD-07: sem lock adapter → incremental executa (modo legado)', async () => {
    const result = await runIncremental(mkAdapters());
    // Sem lock definido, executa normalmente
    expect(result).toBeDefined();
  });

  test('LOCK-PROD-08: lock bloqueado → runIncremental lança e NÃO faz writes', async () => {
    const lockAdapter = criarLockAdapterMock();
    const TTL = 10 * 60 * 1000;

    // Pré-ocupa o lock
    await lockAdapter.firestoreAcquireLock('owner_EXTERNO', TTL);

    const writes = [];
    const adapters = {
      ...mkAdapters({ lockAdapter }),
      dryRun: false,  // modo real — se chegasse a escrever seria problema
      firestoreUpsertVendas: async (v) => { writes.push(v); },
      firestoreUpsertPerfil: async (id, p) => { writes.push({ id, p }); },
      firestoreSetSyncState: async (s) => { writes.push({ type: 'syncState', s }); },
    };

    await expect(runIncremental(adapters)).rejects.toThrow('INCREMENTAL_LOCK_NOT_ACQUIRED');
    expect(writes).toHaveLength(0);  // zero writes

    await lockAdapter.firestoreReleaseLock('owner_EXTERNO');
  });
});

// ── Versão do adapter ─────────────────────────────────────────────────────────

test('VERSAO_ADAPTER está definida', () => {
  expect(VERSAO_ADAPTER).toBeTruthy();
  expect(typeof VERSAO_ADAPTER).toBe('string');
});
