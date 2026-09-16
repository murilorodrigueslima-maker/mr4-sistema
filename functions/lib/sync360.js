'use strict';

/**
 * Sync360 — Camada de orquestração: GestãoClick → Firestore Perfil360
 *
 * DESIGN: toda I/O é injetada via adaptadores para permitir testes unitários
 * sem Firestore real nem GestãoClick real.
 *
 * NÃO contém: escrita direta ao Firestore/GC, referências a SDK, credenciais.
 * NÃO contém: score, IA, recomendação, encarteiramento.
 */

const {
  calcularPerfil360,
  deduplicarVendas,
  agruparVendasPorCliente,
  VERSAO_ENGINE,
} = require('./perfil360');

// ── Constantes ─────────────────────────────────────────────────────────────────

const VENDAS_GC_COLLECTION  = 'vendas_gc';
const PERFIS_360_COLLECTION = 'perfis_360';
const SYNC_STATE_COLLECTION = 'sync_state';
const SYNC_STATE_DOC        = 'perfil360';
const HISTORICO_INICIO      = '2022-03-24';
const CURSOR_OVERLAP_SECS   = 60;  // 1 minuto de margem para evitar perda no mesmo segundo

// ── Helpers puros ──────────────────────────────────────────────────────────────

/**
 * Data de referência no timezone America/Fortaleza (UTC-3, sem DST).
 * Recebe `now` para permitir testes determinísticos.
 */
function calcularDataReferencia(now = new Date()) {
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/Fortaleza' }))
    .toISOString().slice(0, 10);
}

/**
 * Normaliza uma venda do GC para o formato mínimo armazenado em vendas_gc.
 * Preserva valor_total como string para fidelidade à fonte.
 */
function minimalVenda(v) {
  const itens = (v.produtos || []).map(raw => {
    const p = raw.produto || raw;
    return {
      produto_id:   String(p.produto_id   || ''),
      nome_produto: String(p.nome_produto || ''),
      quantidade:   String(p.quantidade   || '0'),
      valor_total:  String(p.valor_total  || '0'),
    };
  }).filter(p => p.produto_id);

  return {
    id:            String(v.id),
    cliente_id:    String(v.cliente_id    || ''),
    data:          (v.data                || '').slice(0, 10),
    nome_situacao: String(v.nome_situacao || ''),
    valor_total:   String(v.valor_total   || '0'),
    modificado_em: String(v.modificado_em || ''),
    cadastrado_em: String(v.cadastrado_em || ''),
    vendedor_id:   String(v.vendedor_id   || ''),
    nome_vendedor: String(v.nome_vendedor || ''),
    produtos:      itens,
  };
}

/**
 * Compara dois perfis para detectar mudança nos dados determinísticos.
 * Exclui `calculadoEm` (metadado de execução) e `_conflicts` (debug interno).
 * Retorna true se QUALQUER campo determinístico diferir.
 */
const _IGNORAR = new Set(['calculadoEm', '_conflicts']);
function dadosMudaram(existing, novo) {
  if (!existing) return true;
  for (const [k, v] of Object.entries(novo)) {
    if (_IGNORAR.has(k)) continue;
    if (JSON.stringify(existing[k] ?? null) !== JSON.stringify(v ?? null)) return true;
  }
  return false;
}

/**
 * Constrói cursor com overlap para evitar perda por mesmo-segundo ou clock skew.
 * Input/output: string "YYYY-MM-DD HH:MM:SS" (timezone da API GC, invariante).
 */
function buildCursorWithOverlap(cursorStr, overlapSeconds = CURSOR_OVERLAP_SECS) {
  if (!cursorStr) return null;
  const parts = cursorStr.split(' ');
  if (parts.length !== 2) return cursorStr;
  const [datePart, timePart] = parts;
  const [y, m, d]    = datePart.split('-').map(Number);
  const [h, min, s]  = timePart.split(':').map(Number);
  const dt = new Date(y, m - 1, d, h, min, s);
  dt.setSeconds(dt.getSeconds() - overlapSeconds);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

/**
 * Constrói Map<produtoId, {nome_grupo, ...}> a partir de um array de produtos.
 * Deduplicado por id; evita chamadas repetidas ao endpoint de produtos.
 */
function buildProdutosPorId(produtos) {
  const map = {};
  for (const p of (produtos || [])) {
    const id = String(p.id || '').trim();
    if (id && !map[id]) {
      map[id] = { nome_grupo: String(p.nome_grupo || p.grupo || ''), ...p };
    }
  }
  return map;
}

/**
 * Pagina um endpoint GC usando meta.proxima_pagina.
 * NÃO usa meta.total (não é confiável com modificado_desde).
 * Lança exceção se qualquer página falhar — o chamador deve abortar sem writes.
 *
 * @param {Function} gcFetchPage — (endpoint, params) → Promise<{data, meta}>
 */
async function fetchAllPagesByProximaPagina(gcFetchPage, endpoint, params = {}) {
  const results = [];
  let pagina = 1;
  const visitados = new Set();

  while (true) {
    if (visitados.has(pagina)) break;  // proteção contra paginação circular
    visitados.add(pagina);

    const r = await gcFetchPage(endpoint, { ...params, pagina, limite: 100 });
    const data = Array.isArray(r.data) ? r.data : [];
    results.push(...data);

    const proxima = (r.meta || {}).proxima_pagina;
    if (!proxima) break;
    pagina = Number(proxima);
  }

  return results;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

/**
 * Bootstrap completo: busca todo o histórico GC, calcula 52 perfis, persiste.
 *
 * Protocolo de segurança:
 *   1. Fetch ALL pages first — qualquer falha lança exceção → zero writes
 *   2. Processing puro (sem I/O)
 *   3. Writes Firestore — falha → cursor não avança
 *   4. Cursor só avança após TODOS os writes terem sucedido
 *
 * @param {Object} adapters
 *   gcFetchPage          (endpoint, params) → {data[], meta}
 *   firestoreGetClientes () → [{firestoreDocumentId, gestaoClickId, ...}]
 *   firestoreGetPerfil   (clienteMr4Id) → perfilDoc | null
 *   firestoreUpsertVendas (vendasMinimas[]) → void
 *   firestoreUpsertPerfil (clienteMr4Id, perfilDoc) → void
 *   firestoreSetSyncState (doc) → void
 *   dryRun               boolean
 *   dataReferencia        YYYY-MM-DD
 */
async function runBootstrap({
  gcFetchPage,
  firestoreGetClientes,
  firestoreGetPerfil,
  firestoreUpsertVendas,
  firestoreUpsertPerfil,
  firestoreGetSyncState,
  firestoreSetSyncState,
  dryRun = false,
  dataReferencia,
}) {
  // Captura o timestamp de início — usado para cursor de catch-up após bootstrap.
  // Qualquer venda modificada DURANTE o bootstrap (modificado_em >= bootstrapStartedAt)
  // será capturada pelo incremental de catch-up usando esse timestamp - overlap.
  const bootstrapStartedAt = new Date().toISOString();

  // ── Etapa 1: Fetch ALL pages — qualquer falha aborta tudo (zero writes) ──────
  const todasVendas = await fetchAllPagesByProximaPagina(gcFetchPage, '/vendas', {
    data_inicio: HISTORICO_INICIO,
    data_fim:    dataReferencia,
  });

  // Produtos carregados UMA VEZ (não por cliente) — categoria resolvida no momento do sync
  const todosProdutos = await fetchAllPagesByProximaPagina(gcFetchPage, '/produtos', { ativo: '1' });
  const produtosPorId = buildProdutosPorId(todosProdutos);

  const clientes = await firestoreGetClientes();
  const clientesLinkados = clientes.filter(
    c => c.gestaoClickId && String(c.gestaoClickId).trim()
  );

  // ── Etapa 2: Processing puro ──────────────────────────────────────────────────
  const { vendas: vendasDedup, conflicts: conflictsDedup } = deduplicarVendas(todasVendas);
  const mapaVendas = agruparVendasPorCliente(vendasDedup);

  const perfisParaEscrever = [];
  let creates = 0, updates = 0, unchanged = 0;

  for (const c of clientesLinkados) {
    const gcId   = String(c.gestaoClickId);
    const vendas = mapaVendas.get(gcId) || [];
    const perfil = calcularPerfil360({
      clienteMr4Id:     c.firestoreDocumentId,
      gestaoClickId:    gcId,
      vendas,
      produtosPorId,
      dataReferencia,
      calculadoEm:      new Date().toISOString(),
      historicoCoberto: { inicio: HISTORICO_INICIO, fim: dataReferencia },
    });

    const existing = await firestoreGetPerfil(c.firestoreDocumentId);
    if (!existing) {
      creates++;
      perfisParaEscrever.push(perfil);
    } else if (dadosMudaram(existing, perfil)) {
      updates++;
      perfisParaEscrever.push(perfil);
    } else {
      unchanged++;
    }
  }

  const result = {
    creates,
    updates,
    unchanged,
    totalVendas:    vendasDedup.length,
    totalClientes:  clientesLinkados.length,
    totalConflicts: conflictsDedup.length,
    bootstrapStartedAt,
    dryRun,
  };

  if (dryRun) return result;

  // ── Etapa 3a: Marcar BOOTSTRAPPING antes dos writes ───────────────────────────
  // Permite detectar bootstrap interrompido (status != READY após execução).
  await firestoreSetSyncState({
    status:              'BOOTSTRAPPING',
    bootstrapStartedAt,
    lastDataReferencia:  dataReferencia,
    engineVersion:       VERSAO_ENGINE,
  });

  try {
    // ── Etapa 3b: Writes vendas_gc (17k docs — adapter usa BulkWriter/batches) ──
    await firestoreUpsertVendas(vendasDedup.map(minimalVenda));

    // ── Etapa 3c: Writes perfis_360 ──────────────────────────────────────────────
    for (const p of perfisParaEscrever) {
      await firestoreUpsertPerfil(p.clienteMr4Id, p);
    }

    // ── Etapa 3d: Cursor catch-up — cursor inicial aponta para ANTES do bootstrap.
    // Cursor = bootstrapStartedAt convertido para "YYYY-MM-DD HH:MM:SS" local GC,
    // menos overlap. Na prática, o chamador deve fazer um incremental de catch-up
    // após o bootstrap usando bootstrapStartedAt como ponto de partida.
    const newCursor = vendasDedup.reduce(
      (max, v) => (v.modificado_em || '') > max ? (v.modificado_em || '') : max,
      ''
    );

    // ── Etapa 4: Status READY — somente após TODOS os writes bem-sucedidos ───────
    await firestoreSetSyncState({
      status:              'READY',
      bootstrapStartedAt,
      lastBootstrapAt:     new Date().toISOString(),
      lastDataReferencia:  dataReferencia,
      modifiedSinceCursor: newCursor,
      engineVersion:       VERSAO_ENGINE,
    });
  } catch (err) {
    // Falha parcial — marca ERROR. Dados parcialmente escritos não são apagados.
    // Chamador deve inspecionar o estado e decidir ação (re-bootstrap ou rollback manual).
    try {
      await firestoreSetSyncState({
        status:             'ERROR',
        bootstrapStartedAt,
        lastErrorAt:        new Date().toISOString(),
        lastErrorMessage:   String(err.message || err),
        engineVersion:      VERSAO_ENGINE,
      });
    } catch (_) { /* ignora erro ao marcar ERROR para não mascarar o original */ }
    throw err;
  }

  return result;
}

// ── Incremental ────────────────────────────────────────────────────────────────

/**
 * Incremental: busca vendas modificadas desde o cursor, atualiza mirror e perfis.
 *
 * Protocolo de segurança (mesmo que bootstrap):
 *   1. Fetch pages — falha → zero writes, cursor inalterado
 *   2. Processing puro
 *   3. Writes vendas_gc + perfis_360 — falha → cursor inalterado
 *   4. Cursor avança APÓS todos os writes
 *
 * Estratégia de recálculo para vendas históricas modificadas (Arquitetura B):
 *   - Mirror vendas_gc contém histórico completo
 *   - Modified venda é merged com mirror por ID
 *   - Engine recalcula o perfil completo (primeiraCompra, frequência, etc.)
 *   - NÃO usa delta ingênuo — sempre recalcula do zero a partir do mirror
 *
 * @param {Object} adapters
 *   gcFetchPage                (endpoint, params) → {data[], meta}
 *   firestoreGetClientes       () → [{firestoreDocumentId, gestaoClickId}]
 *   firestoreGetVendasByCliente (gcId) → vendaMinima[]
 *   firestoreGetPerfil         (clienteMr4Id) → perfilDoc | null
 *   firestoreUpsertVendas      (vendas[]) → void
 *   firestoreUpsertPerfil      (clienteMr4Id, doc) → void
 *   firestoreGetSyncState      () → syncStateDoc | null
 *   firestoreSetSyncState      (doc) → void
 *   dryRun                     boolean
 *   dataReferencia             YYYY-MM-DD
 */
async function runIncremental({
  gcFetchPage,
  firestoreGetClientes,
  firestoreGetVendasByCliente,
  firestoreGetPerfil,
  firestoreUpsertVendas,
  firestoreUpsertPerfil,
  firestoreGetSyncState,
  firestoreSetSyncState,
  dryRun = false,
  dataReferencia,
}) {
  // ── Etapa 1: Cursor + Fetch ───────────────────────────────────────────────────
  const syncState  = await firestoreGetSyncState();
  const cursor     = syncState?.modifiedSinceCursor ?? null;
  const fetchSince = cursor ? buildCursorWithOverlap(cursor, CURSOR_OVERLAP_SECS) : null;

  // Pagina por proxima_pagina (meta.total não é confiável com modificado_desde)
  const gcParams = fetchSince ? { modificado_desde: fetchSince } : {};
  const todasModificadas = await fetchAllPagesByProximaPagina(gcFetchPage, '/vendas', gcParams);

  // API GestãoClick filtra por DATA apenas (não datetime). Filtro local garante
  // precisão do cursor e elimina registros espúrios para datas futuras extremas.
  const modifiedVendas = fetchSince
    ? todasModificadas.filter(v => (v.modificado_em || '') >= fetchSince)
    : todasModificadas;

  if (modifiedVendas.length === 0) {
    return { creates: 0, updates: 0, unchanged: 0, modifiedVendas: 0, cursorAdvanced: false };
  }

  // Produtos UMA VEZ (não por cliente)
  const todosProdutos = await fetchAllPagesByProximaPagina(gcFetchPage, '/produtos', { ativo: '1' });
  const produtosPorId = buildProdutosPorId(todosProdutos);

  // ── Etapa 2: Identify affected clients + recalculate ─────────────────────────
  const affectedGcIds = new Set(
    modifiedVendas.map(v => String(v.cliente_id || '')).filter(Boolean)
  );
  const clientes = await firestoreGetClientes();
  const linkedAffected = clientes.filter(
    c => c.gestaoClickId && affectedGcIds.has(String(c.gestaoClickId))
  );

  const perfisParaEscrever = [];
  let creates = 0, updates = 0, unchanged = 0;

  for (const c of linkedAffected) {
    const gcId = String(c.gestaoClickId);

    // Ler mirror completo do cliente (histórico local)
    const mirrorVendas = await firestoreGetVendasByCliente(gcId);

    // Merge: modified sobrescreve mirror por ID (sem duplicar)
    const merged = new Map(mirrorVendas.map(v => [String(v.id), v]));
    for (const mv of modifiedVendas) {
      if (String(mv.cliente_id) === gcId) {
        merged.set(String(mv.id), minimalVenda(mv));
      }
    }
    const vendasParaEngine = Array.from(merged.values());

    const perfil = calcularPerfil360({
      clienteMr4Id:    c.firestoreDocumentId,
      gestaoClickId:   gcId,
      vendas:          vendasParaEngine,
      produtosPorId,
      dataReferencia,
      calculadoEm:     new Date().toISOString(),
    });

    const existing = await firestoreGetPerfil(c.firestoreDocumentId);
    if (!existing)                         { creates++; perfisParaEscrever.push(perfil); }
    else if (dadosMudaram(existing, perfil)) { updates++; perfisParaEscrever.push(perfil); }
    else                                   { unchanged++; }
  }

  const result = {
    creates,
    updates,
    unchanged,
    modifiedVendas: modifiedVendas.length,
    cursorAdvanced: false,
    dryRun,
  };

  if (dryRun) return result;

  // ── Etapa 3: Writes ───────────────────────────────────────────────────────────
  await firestoreUpsertVendas(modifiedVendas.map(minimalVenda));

  for (const p of perfisParaEscrever) {
    await firestoreUpsertPerfil(p.clienteMr4Id, p);
  }

  // ── Etapa 4: Cursor avança APÓS todos os writes ───────────────────────────────
  const newCursor = modifiedVendas.reduce(
    (max, v) => (v.modificado_em || '') > max ? (v.modificado_em || '') : max,
    cursor || ''
  );
  await firestoreSetSyncState({
    ...(syncState || {}),
    modifiedSinceCursor: newCursor,
    lastIncrementalAt:   new Date().toISOString(),
    engineVersion:       VERSAO_ENGINE,
  });

  return { ...result, cursorAdvanced: true };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  // Constantes
  VENDAS_GC_COLLECTION,
  PERFIS_360_COLLECTION,
  SYNC_STATE_COLLECTION,
  SYNC_STATE_DOC,
  HISTORICO_INICIO,
  CURSOR_OVERLAP_SECS,

  // Helpers puros (testáveis isoladamente)
  calcularDataReferencia,
  minimalVenda,
  dadosMudaram,
  buildCursorWithOverlap,
  buildProdutosPorId,
  fetchAllPagesByProximaPagina,

  // Orquestradores
  runBootstrap,
  runIncremental,
};
