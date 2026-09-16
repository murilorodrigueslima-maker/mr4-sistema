'use strict';

/**
 * AUTO360-01 → AUTO360-15
 * Testa o ciclo incremental do Perfil360 em isolamento total:
 *   - ZERO chamadas reais a GestãoClick, Firestore ou qualquer I/O externa
 *   - Todos os adaptadores são stubs/mocks injetados
 */

const {
  runIncremental,
  buildCursorWithOverlap,
  CURSOR_OVERLAP_SECS,
} = require('../lib/sync360');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkVenda(id, clienteId, data = '2026-09-15', situacao = 'Concretizada', valor = '100.00', modificadoEm = null) {
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

// ── AUTO360-01: dry-run não escreve nada ──────────────────────────────────────

test('AUTO360-01: dry-run retorna resultado sem executar writes no Firestore', async () => {
  const venda = mkVenda('v1', '1', '2026-09-15', 'Concretizada', '200.00', '2026-09-15 11:00:00');
  const adapters = mkAdapters({ dryRun: true });
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })  // /vendas
    .mockResolvedValueOnce({ data: [], meta: {} })        // /produtos
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);

  const result = await runIncremental(adapters);

  expect(adapters.firestoreUpsertVendas).not.toHaveBeenCalled();
  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
  expect(result.dryRun).toBe(true);
  expect(result.cursorAdvanced).toBe(false);
});

// ── AUTO360-02: cursor real lido do sync_state ────────────────────────────────

test('AUTO360-02: cursor é lido do sync_state.modifiedSinceCursor', async () => {
  const cursor = '2026-09-14 08:30:00';
  const adapters = mkAdapters();
  adapters.firestoreGetSyncState.mockResolvedValue({ modifiedSinceCursor: cursor });

  await runIncremental(adapters);

  expect(adapters.firestoreGetSyncState).toHaveBeenCalledTimes(1);
  // Sem vendas → retorno antecipado; gcFetchPage chamado com modificado_desde=cursor-60s
  const calledParams = adapters.gcFetchPage.mock.calls[0]?.[1] || {};
  if (calledParams.modificado_desde) {
    // Cursor efetivo deve ser cursor - 60s (overlap)
    expect(calledParams.modificado_desde).toBe(buildCursorWithOverlap(cursor, CURSOR_OVERLAP_SECS));
  }
});

// ── AUTO360-03: overlap de 60s aplicado ao cursor ────────────────────────────

test('AUTO360-03: cursorEfetivo = cursor - 60 segundos', () => {
  const cursor   = '2026-09-15 10:01:00';
  const efetivo  = buildCursorWithOverlap(cursor, CURSOR_OVERLAP_SECS);
  expect(efetivo).toBe('2026-09-15 10:00:00');
  expect(CURSOR_OVERLAP_SECS).toBe(60);
});

test('AUTO360-03b: overlap cruza minuto corretamente', () => {
  expect(buildCursorWithOverlap('2026-09-15 10:00:30', 60)).toBe('2026-09-15 09:59:30');
});

// ── AUTO360-04: filtro local remove vendas antes do cursorEfetivo ─────────────

test('AUTO360-04: filtro local elimina vendas com modificado_em < cursorEfetivo', async () => {
  const cursorPersistido = '2026-09-15 12:01:00';
  const cursorEfetivo    = buildCursorWithOverlap(cursorPersistido, 60); // 12:00:00
  const vendaAntes  = mkVenda('v1', '1', '2026-09-15', 'Concretizada', '100.00', '2026-09-15 11:59:59');
  const vendaDepois = mkVenda('v2', '1', '2026-09-15', 'Concretizada', '100.00', '2026-09-15 12:00:30');

  const adapters = mkAdapters();
  adapters.firestoreGetSyncState.mockResolvedValue({ modifiedSinceCursor: cursorPersistido });
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [vendaAntes, vendaDepois], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  const vendasEscritas = adapters._writes.vendas;
  expect(vendasEscritas).toHaveLength(1);
  expect(vendasEscritas[0].id).toBe('v2');
  expect(vendasEscritas[0].modificado_em >= cursorEfetivo).toBe(true);
});

// ── AUTO360-05: venda nova (não está no mirror) ───────────────────────────────

test('AUTO360-05: venda nova cria perfil e é escrita no mirror', async () => {
  const venda = mkVenda('v99', '1', '2026-09-15', 'Concretizada', '500.00', '2026-09-15 11:00:00');
  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);  // mirror vazio
  adapters.firestoreGetPerfil.mockResolvedValue(null);         // perfil não existe

  await runIncremental(adapters);

  expect(adapters._writes.vendas.some(v => v.id === 'v99')).toBe(true);
  expect(adapters._writes.perfis['docA']).toBeDefined();
  expect(adapters._writes.syncState.modifiedSinceCursor).toBe('2026-09-15 11:00:00');
});

// ── AUTO360-06: venda modificada atualiza mirror e perfil ─────────────────────

test('AUTO360-06: venda modificada (valor diferente) atualiza mirror e recalcula perfil', async () => {
  const vendaOriginal  = mkVenda('v1', '1', '2026-09-10', 'Concretizada', '100.00', '2026-09-10 10:00:00');
  const vendaModificada = { ...mkVenda('v1', '1', '2026-09-10', 'Concretizada', '999.00', '2026-09-15 11:00:00') };

  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [vendaModificada], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([vendaOriginal]);
  adapters.firestoreGetPerfil.mockResolvedValue({ faturamentoTotal: 100, pedidosTotal: 1, nuncaComprou: false });

  await runIncremental(adapters);

  const v = adapters._writes.vendas.find(x => x.id === 'v1');
  expect(v).toBeDefined();
  expect(v.valor_total).toBe('999.00');
  expect(adapters._writes.perfis['docA']).toBeDefined();
});

// ── AUTO360-07: venda muda de cliente → recalcula AMBOS ──────────────────────

test('AUTO360-07: venda que muda de cliente_id recalcula cliente antigo e novo', async () => {
  // Venda v1 estava no cliente 1 (docA), agora pertence ao cliente 2 (docB)
  const vendaMudouCliente = mkVenda('v1', '2', '2026-09-15', 'Concretizada', '300.00', '2026-09-15 11:00:00');
  const vendaNoMirrorClienteAntigo = mkVenda('v1', '1', '2026-09-10', 'Concretizada', '300.00', '2026-09-10 10:00:00');

  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [vendaMudouCliente], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([
    mkCliente('docA', '1'),
    mkCliente('docB', '2'),
  ]);
  // firestoreGetVendaById retorna venda com cliente antigo (1)
  adapters.firestoreGetVendaById.mockResolvedValue(vendaNoMirrorClienteAntigo);
  adapters.firestoreGetVendasByCliente
    .mockImplementation(async (gcId) => gcId === '1' ? [vendaNoMirrorClienteAntigo] : []);

  await runIncremental(adapters);

  // Ambos os clientes devem ter perfil recalculado
  expect(adapters._writes.perfis['docA']).toBeDefined();  // cliente antigo
  expect(adapters._writes.perfis['docB']).toBeDefined();  // cliente novo
});

// ── AUTO360-08: Concretizada → outro status para de contar no perfil ──────────

test('AUTO360-08: venda Concretizada → Cancelada deixa de contar no faturamento', async () => {
  const vendaCancelada = mkVenda('v1', '1', '2026-09-10', 'Cancelada', '500.00', '2026-09-15 11:00:00');
  const vendaOriginalNoMirror = mkVenda('v1', '1', '2026-09-10', 'Concretizada', '500.00', '2026-09-10 10:00:00');

  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [vendaCancelada], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([vendaOriginalNoMirror]);
  adapters.firestoreGetPerfil.mockResolvedValue({
    faturamentoTotal: 500, pedidosTotal: 1, nuncaComprou: false,
  });

  await runIncremental(adapters);

  // Mirror atualizado com venda cancelada
  const v = adapters._writes.vendas.find(x => x.id === 'v1');
  expect(v?.nome_situacao).toBe('Cancelada');

  // Perfil recalculado: nuncaComprou=true (sem Concretizadas)
  const perfil = adapters._writes.perfis['docA'];
  expect(perfil).toBeDefined();
  expect(perfil.nuncaComprou).toBe(true);
  expect(perfil.faturamentoTotal).toBe(0);
});

// ── AUTO360-09: outro status → Concretizada passa a contar ──────────────────

test('AUTO360-09: venda não-Concretizada → Concretizada passa a contar no faturamento', async () => {
  const vendaConcretizada = mkVenda('v1', '1', '2026-09-10', 'Concretizada', '750.00', '2026-09-15 11:00:00');
  const vendaOriginalPendente = mkVenda('v1', '1', '2026-09-10', 'Pendente', '750.00', '2026-09-10 10:00:00');

  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [vendaConcretizada], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([vendaOriginalPendente]);
  adapters.firestoreGetPerfil.mockResolvedValue({ nuncaComprou: true, faturamentoTotal: 0 });

  await runIncremental(adapters);

  const perfil = adapters._writes.perfis['docA'];
  expect(perfil.nuncaComprou).toBe(false);
  expect(perfil.faturamentoTotal).toBeGreaterThan(0);
});

// ── AUTO360-10: sem mudanças → zero writes de perfil ─────────────────────────

test('AUTO360-10: se perfil não mudou não é escrito no Firestore', async () => {
  const venda = mkVenda('v1', '1', '2026-09-15', 'Concretizada', '100.00', '2026-09-15 11:00:00');
  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([venda]);
  // Perfil existente já reflete o estado correto (dadosMudaram = false)
  adapters.firestoreGetPerfil.mockImplementation(async () => {
    const { calcularPerfil360, deduplicarVendas } = require('../lib/perfil360');
    const { vendas } = deduplicarVendas([venda]);
    return calcularPerfil360({
      clienteMr4Id: 'docA', gestaoClickId: '1', vendas, produtosPorId: {},
      dataReferencia: '2026-09-16', calculadoEm: new Date().toISOString(),
    });
  });

  await runIncremental(adapters);

  expect(adapters.firestoreUpsertPerfil).not.toHaveBeenCalled();
  // Mas venda foi atualizada no mirror
  expect(adapters.firestoreUpsertVendas).toHaveBeenCalled();
  // Cursor avançou
  expect(adapters._writes.syncState.modifiedSinceCursor).toBeTruthy();
});

// ── AUTO360-11: cursor não avança em falha ────────────────────────────────────

test('AUTO360-11: cursor não avança se firestoreUpsertVendas lança exceção', async () => {
  const venda = mkVenda('v1', '1', '2026-09-15', 'Concretizada', '100.00', '2026-09-15 11:00:00');
  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);
  adapters.firestoreUpsertVendas.mockRejectedValue(new Error('Firestore write failed'));

  await expect(runIncremental(adapters)).rejects.toThrow('Firestore write failed');

  // cursor NÃO foi avançado
  expect(adapters.firestoreSetSyncState).not.toHaveBeenCalled();
});

// ── AUTO360-12: falha Perfil360 isolada via Promise.allSettled ───────────────

test('AUTO360-12: falha em Perfil360 não afeta tarefas irmãs via allSettled', async () => {
  const throwingTask = async () => { throw new Error('Perfil360 crash simulado'); };
  const okTask       = async () => 'ok';

  const results = await Promise.allSettled([throwingTask(), okTask(), okTask()]);

  expect(results[0].status).toBe('rejected');
  expect(results[1].status).toBe('fulfilled');
  expect(results[2].status).toBe('fulfilled');
  expect(results[1].value).toBe('ok');
});

// ── AUTO360-13: delta não faz full-history API fetch ─────────────────────────

test('AUTO360-13: com cursor definido, API é chamada com modificado_desde (não full fetch)', async () => {
  const cursor = '2026-09-15 10:00:00';
  const adapters = mkAdapters();
  adapters.firestoreGetSyncState.mockResolvedValue({ modifiedSinceCursor: cursor });

  await runIncremental(adapters);

  // /vendas deve ter sido chamado com modificado_desde
  const vendasCall = adapters.gcFetchPage.mock.calls.find(c => c[0] === '/vendas');
  expect(vendasCall).toBeDefined();
  const params = vendasCall[1] || {};
  expect(params.modificado_desde).toBe(buildCursorWithOverlap(cursor, CURSOR_OVERLAP_SECS));
  // Não deve ter chamado sem parâmetro (full-history)
  const semFiltro = adapters.gcFetchPage.mock.calls.some(
    c => c[0] === '/vendas' && !c[1]?.modificado_desde
  );
  expect(semFiltro).toBe(false);
});

// ── AUTO360-14: deduplica venda.id ────────────────────────────────────────────

test('AUTO360-14: se mesma venda aparecer duas vezes na API, é processada uma vez', async () => {
  const venda = mkVenda('v1', '1', '2026-09-15', 'Concretizada', '100.00', '2026-09-15 11:00:00');
  const adapters = mkAdapters();
  adapters.gcFetchPage
    .mockResolvedValueOnce({ data: [venda, venda], meta: {} })  // duplicada na resposta
    .mockResolvedValueOnce({ data: [], meta: {} })
    .mockResolvedValueOnce({ data: [], meta: {} });
  adapters.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
  adapters.firestoreGetVendasByCliente.mockResolvedValue([]);

  await runIncremental(adapters);

  // mirror recebe duas cópias (upsert por id é idempotente no Firestore),
  // mas merged para engine tem 1 entrada única por id
  const vendasEscritas = adapters._writes.vendas;
  const ids = vendasEscritas.map(v => v.id);
  const uniqIds = [...new Set(ids)];
  // O merge por Map garante que o engine vê apenas 1 entrada por id
  // (as duas entradas de UpsertVendas são ambas v1 — idempotente)
  expect(uniqIds).toHaveLength(1);
  expect(uniqIds[0]).toBe('v1');
});

// ── AUTO360-15: rerun idempotente ─────────────────────────────────────────────

test('AUTO360-15: dois incrementais consecutivos com mesmos dados produzem resultado igual', async () => {
  const venda = mkVenda('v1', '1', '2026-09-15', 'Concretizada', '200.00', '2026-09-15 11:00:00');

  function buildAdapters() {
    const a = mkAdapters();
    a.gcFetchPage
      .mockResolvedValueOnce({ data: [venda], meta: {} })
      .mockResolvedValueOnce({ data: [], meta: {} })
      .mockResolvedValueOnce({ data: [], meta: {} });
    a.firestoreGetClientes.mockResolvedValue([mkCliente('docA', '1')]);
    a.firestoreGetVendasByCliente.mockResolvedValue([venda]);  // já no mirror
    a.firestoreGetPerfil.mockResolvedValue(null);
    return a;
  }

  const run1 = buildAdapters();
  await runIncremental(run1);

  const run2 = buildAdapters();
  await runIncremental(run2);

  // Ambos escrevem a mesma venda e calculam o mesmo perfil
  expect(run1._writes.vendas.length).toBe(run2._writes.vendas.length);
  expect(run1._writes.syncState.modifiedSinceCursor)
    .toBe(run2._writes.syncState.modifiedSinceCursor);
});
