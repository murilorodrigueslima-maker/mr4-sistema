'use strict';

/**
 * incremental360.js — Executa um ciclo incremental do Perfil360 em produção.
 *
 * Lê cursor real de sync_state/perfil360, busca delta GestãoClick, atualiza
 * vendas_gc e perfis_360. Em DRY_RUN=true: ZERO writes, apenas análise.
 *
 * Autenticação: GOOGLE_APPLICATION_CREDENTIALS (WIF external_account no CI/CD)
 *
 * Variáveis obrigatórias:
 *   GC_ACCESS_TOKEN        — access-token da API GestãoClick
 *   GC_SECRET_ACCESS_TOKEN — secret-access-token da API GestãoClick
 *
 * Uso:
 *   DRY_RUN=true  node scripts/incremental360.js   (análise, sem writes)
 *   DRY_RUN=false node scripts/incremental360.js   (ciclo real)
 */

const { Firestore }  = require('@google-cloud/firestore');
const https          = require('https');

const {
  runIncremental,
  calcularDataReferencia,
  SYNC_STATE_COLLECTION,
  SYNC_STATE_DOC,
  VENDAS_GC_COLLECTION,
  PERFIS_360_COLLECTION,
  CURSOR_OVERLAP_SECS,
  buildCursorWithOverlap,
} = require('../functions/lib/sync360');

const DRY_RUN  = process.env.DRY_RUN !== 'false';
const GC_ACCESS = process.env.GC_ACCESS_TOKEN || process.env.GESTAOCLICK_ACCESS_TOKEN;
const GC_SECRET = process.env.GC_SECRET_ACCESS_TOKEN || process.env.GESTAOCLICK_SECRET_TOKEN;
const GC_BASE_URL = 'https://api.gestaoclick.com';
const PROJECT_ID  = 'mr4-ponto';

if (!GC_ACCESS || !GC_SECRET) {
  console.error('ERRO: GC_ACCESS_TOKEN e GC_SECRET_ACCESS_TOKEN obrigatórios');
  process.exit(1);
}

const db = new Firestore({ projectId: PROJECT_ID, databaseId: '(default)' });

// ── GestãoClick HTTP client ──────────────────────────────────────────────────

function gcRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs  = new URLSearchParams({ ...params, limite: '100' }).toString();
    const url = `${GC_BASE_URL}${path}?${qs}`;
    const options = {
      headers: {
        'access-token':        GC_ACCESS,
        'secret-access-token': GC_SECRET,
        'Content-Type':        'application/json',
      },
    };
    https.get(url, options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('GC JSON parse: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const gcFetchPage = async (endpoint, params) => {
  const r = await gcRequest(endpoint, params);
  return { data: Array.isArray(r.data) ? r.data : [], meta: r.meta || {} };
};

// ── Firestore adapters ───────────────────────────────────────────────────────

async function firestoreGetClientes() {
  const snap = await db.collection('clientes')
    .where('gestaoClickId', '!=', null)
    .select('gestaoClickId')
    .get();
  return snap.docs
    .map(d => ({ firestoreDocumentId: d.id, gestaoClickId: String(d.data().gestaoClickId || '') }))
    .filter(c => c.gestaoClickId.trim());
}

async function firestoreGetVendasByCliente(gcId) {
  const snap = await db.collection(VENDAS_GC_COLLECTION)
    .where('cliente_id', '==', String(gcId))
    .get();
  return snap.docs.map(d => d.data());
}

async function firestoreGetVendaById(vendaId) {
  const doc = await db.collection(VENDAS_GC_COLLECTION).doc(String(vendaId)).get();
  return doc.exists ? doc.data() : null;
}

async function firestoreGetPerfil(clienteMr4Id) {
  const doc = await db.collection(PERFIS_360_COLLECTION).doc(clienteMr4Id).get();
  return doc.exists ? doc.data() : null;
}

async function firestoreGetSyncState() {
  const doc = await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).get();
  return doc.exists ? doc.data() : null;
}

async function firestoreSetSyncState(data) {
  if (DRY_RUN) { console.log('[DRY_RUN] SetSyncState:', JSON.stringify(data).slice(0, 200)); return; }
  await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).set(data, { merge: true });
}

async function firestoreUpsertPerfil(clienteMr4Id, perfil) {
  if (DRY_RUN) { return; }
  await db.collection(PERFIS_360_COLLECTION).doc(clienteMr4Id).set(perfil);
}

async function firestoreUpsertVendas(vendas) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] UpsertVendas: ${vendas.length} docs (não escritos)`);
    return;
  }
  const writer = db.bulkWriter();
  writer.onWriteError(err => {
    console.error('[BulkWriter] Erro:', err.documentRef.path, err.code);
    return false;
  });
  let n = 0;
  for (const venda of vendas) {
    const ref = db.collection(VENDAS_GC_COLLECTION).doc(String(venda.id));
    writer.set(ref, venda);
    n++;
    if (n % 499 === 0) { await writer.flush(); }
  }
  await writer.close();
}

// ── Sanity pós-incremental ───────────────────────────────────────────────────

async function sanityPosIncremental() {
  const perfisSnap = await db.collection(PERFIS_360_COLLECTION).get();
  const vendasSnap = await db.collection(VENDAS_GC_COLLECTION).get();
  const syncDoc    = await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).get();

  let fatEngineCentavos = 0, pedidosEngine = 0;
  perfisSnap.docs.forEach(d => {
    const p = d.data();
    if (!p.nuncaComprou) {
      fatEngineCentavos += Math.round((p.faturamentoTotal || 0) * 100);
      pedidosEngine     += (p.pedidosTotal || 0);
    }
  });

  const clientesSnap = await db.collection('clientes')
    .where('gestaoClickId', '!=', null).select('gestaoClickId').get();
  const gcIds = new Set(
    clientesSnap.docs.map(d => String(d.data().gestaoClickId || '')).filter(Boolean)
  );

  let fatEspelhoCentavos = 0, pedidosEspelho = 0;
  const vendasIdsVistos = new Set();
  vendasSnap.docs.forEach(d => {
    const v  = d.data();
    const id = String(v.cliente_id || '');
    if (!gcIds.has(id)) return;
    if (v.nome_situacao !== 'Concretizada') return;
    if (vendasIdsVistos.has(v.id)) return;
    vendasIdsVistos.add(v.id);
    fatEspelhoCentavos += Math.round((parseFloat(v.valor_total) || 0) * 100);
    pedidosEspelho++;
  });

  const difCentavos = Math.abs(fatEngineCentavos - fatEspelhoCentavos);
  const difPedidos  = Math.abs(pedidosEngine - pedidosEspelho);

  console.log('\n' + '='.repeat(60));
  console.log('SANITY PÓS-INCREMENTAL');
  console.log('='.repeat(60));
  console.log(`VENDAS_GC_DOCS               = ${vendasSnap.size}`);
  console.log(`PERFIS_360_DOCS              = ${perfisSnap.size}`);
  console.log(`SYNC_STATUS                  = ${syncDoc.exists ? syncDoc.data().status : 'NÃO_EXISTE'}`);
  console.log(`FATURAMENTO_PERFIS_CENTAVOS  = ${fatEngineCentavos}`);
  console.log(`FATURAMENTO_ESPELHO_CENTAVOS = ${fatEspelhoCentavos}`);
  console.log(`DIFERENCA_CENTAVOS           = ${difCentavos}`);
  console.log(`PEDIDOS_PERFIS               = ${pedidosEngine}`);
  console.log(`PEDIDOS_ESPELHO              = ${pedidosEspelho}`);
  console.log(`DIFERENCA_PEDIDOS            = ${difPedidos}`);
  console.log(`SANITY_PASS                  = ${difCentavos === 0 && difPedidos === 0}`);
  console.log(`CURSOR_DEPOIS                = ${syncDoc.exists ? (syncDoc.data().modifiedSinceCursor || 'N/A') : 'N/A'}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dataReferencia = calcularDataReferencia();

  console.log('='.repeat(60));
  console.log('INCREMENTAL PERFIL360');
  console.log('='.repeat(60));
  console.log(`DRY_RUN          = ${DRY_RUN}`);
  console.log(`DATA_REFERENCIA  = ${dataReferencia}`);
  console.log(`CURSOR_OVERLAP_SECONDS = ${CURSOR_OVERLAP_SECS}`);
  console.log();

  // ── Auditar sync_state real (leitura direta Firestore) ───────────────────
  console.log('='.repeat(60));
  console.log('SYNC_STATE ATUAL');
  console.log('='.repeat(60));
  const syncState = await firestoreGetSyncState();
  if (!syncState) {
    console.error('ERRO: sync_state/perfil360 não encontrado. Execute bootstrap primeiro.');
    process.exit(1);
  }
  console.log(`STATUS                 = ${syncState.status}`);
  console.log(`ENGINE_VERSION         = ${syncState.engineVersion || 'N/A'}`);
  console.log(`LAST_DATA_REFERENCIA   = ${syncState.lastDataReferencia || 'N/A'}`);
  console.log(`LAST_BOOTSTRAP_AT      = ${syncState.lastBootstrapAt || 'N/A'}`);
  console.log(`LAST_INCREMENTAL_AT    = ${syncState.lastIncrementalAt || 'N/A'}`);
  console.log(`CURSOR_PERSISTIDO      = ${syncState.modifiedSinceCursor || 'N/A'}`);

  if (syncState.status !== 'READY') {
    console.error(`ERRO: sync_state.status = ${syncState.status}. Esperado: READY.`);
    process.exit(1);
  }

  const cursorPersistido = syncState.modifiedSinceCursor || null;
  const cursorEfetivo    = cursorPersistido
    ? buildCursorWithOverlap(cursorPersistido, CURSOR_OVERLAP_SECS)
    : null;

  console.log(`CURSOR_EFETIVO         = ${cursorEfetivo || 'N/A (sem cursor — full fetch)'}`);
  console.log(`API_FILTER_FROM        = ${cursorEfetivo ? cursorEfetivo.slice(0, 10) : 'N/A'}`);
  console.log();

  // ── Executar incremental ─────────────────────────────────────────────────
  console.log('Executando runIncremental...');

  // Para dry-run verbose: interceptar adapters para contar
  let apiTotalFetched = 0;
  let apiTotalFiltered = 0;

  const gcFetchPageVerbose = async (endpoint, params) => {
    const r = await gcFetchPage(endpoint, params);
    if (endpoint === '/vendas') apiTotalFetched += (r.data || []).length;
    return r;
  };

  const firestoreGetVendasByClienteVerbose = async (gcId) => {
    const vendas = await firestoreGetVendasByCliente(gcId);
    return vendas;
  };

  const result = await runIncremental({
    gcFetchPage:             gcFetchPageVerbose,
    firestoreGetClientes,
    firestoreGetVendasByCliente: firestoreGetVendasByClienteVerbose,
    firestoreGetVendaById,
    firestoreGetPerfil,
    firestoreUpsertVendas,
    firestoreUpsertPerfil,
    firestoreGetSyncState,
    firestoreSetSyncState,
    dryRun:         DRY_RUN,
    dataReferencia,
  });

  console.log('\n' + '='.repeat(60));
  console.log('RESULTADO INCREMENTAL');
  console.log('='.repeat(60));
  console.log(`TOTAL_API_FETCHED        = ${apiTotalFetched}`);
  console.log(`TOTAL_AFTER_LOCAL_FILTER = ${result.modifiedVendas}`);
  console.log(`TOTAL_UNIQUE             = ${result.modifiedVendas}`);
  console.log(`NOVAS_VENDAS             = ${result.creates}`);
  console.log(`VENDAS_MODIFICADAS       = ${result.updates + result.unchanged}`);
  console.log(`CLIENTES_AFETADOS        = ${(result.creates + result.updates + result.unchanged)}`);
  console.log(`EXPECTED_VENDAS_WRITES   = ${result.modifiedVendas}`);
  console.log(`EXPECTED_PROFILE_WRITES  = ${result.creates + result.updates}`);
  console.log(`ACTUAL_FIRESTORE_WRITES  = ${DRY_RUN ? 0 : (result.modifiedVendas + result.creates + result.updates)}`);
  console.log(`CURSOR_ADVANCED          = ${result.cursorAdvanced}`);
  console.log();

  if (DRY_RUN) {
    console.log('FIRESTORE_WRITES = ZERO (DRY_RUN=true)');
    return;
  }

  // ── Sanity pós-incremental real ──────────────────────────────────────────
  await sanityPosIncremental();

  console.log('\nFIRESTORE_WRITES = EXECUTADOS');
  console.log('GC_WRITES        = ZERO');
}

main().catch(err => {
  console.error('\nFALHA FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
