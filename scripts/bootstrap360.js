'use strict';

/**
 * bootstrap360.js — Bootstrap único das coleções Perfil360 em produção.
 *
 * Cria: vendas_gc (espelho), perfis_360, sync_state/perfil360
 * NÃO executa se sync_state.status == 'READY' (idempotente).
 * NÃO toca: dados de ponto, espelhos, funcionários, mr4-webhook.
 *
 * Autenticação: GOOGLE_APPLICATION_CREDENTIALS (WIF external_account no CI/CD)
 *               ou ADC local (gcloud auth application-default login).
 *
 * Variáveis de ambiente obrigatórias:
 *   GC_ACCESS_TOKEN        — access-token da API GestãoClick
 *   GC_SECRET_ACCESS_TOKEN — secret-access-token da API GestãoClick
 *
 * Uso:
 *   DRY_RUN=true  node scripts/bootstrap360.js   (sem writes)
 *   DRY_RUN=false node scripts/bootstrap360.js   (escrita real)
 *
 * Execução no CI/CD (GitHub Actions — workflow manual):
 *   jobs:
 *     bootstrap:
 *       steps:
 *         - name: Bootstrap Perfil360
 *           run: node scripts/bootstrap360.js
 *           env:
 *             DRY_RUN: 'false'
 *             GC_ACCESS_TOKEN: ${{ secrets.GC_ACCESS_TOKEN }}
 *             GC_SECRET_ACCESS_TOKEN: ${{ secrets.GC_SECRET_ACCESS_TOKEN }}
 *             GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.auth.outputs.credentials_file_path }}
 */

const { Firestore } = require('@google-cloud/firestore');
const https = require('https');

const DRY_RUN        = process.env.DRY_RUN !== 'false';
// Suporta nomes de env vars do GitHub Actions E do .env local
const GC_ACCESS = process.env.GC_ACCESS_TOKEN || process.env.GESTAOCLICK_ACCESS_TOKEN;
const GC_SECRET = process.env.GC_SECRET_ACCESS_TOKEN || process.env.GESTAOCLICK_SECRET_TOKEN;
const GC_BASE_URL    = 'https://api.gestaoclick.com';
const PROJECT_ID     = 'mr4-ponto';
const BATCH_SIZE     = 499;  // Firestore batch limit é 500, usa 499 por segurança

if (!GC_ACCESS || !GC_SECRET) {
  console.error('ERRO: variáveis de autenticação GestãoClick não encontradas.');
  console.error('  GitHub Actions: GC_ACCESS_TOKEN + GC_SECRET_ACCESS_TOKEN');
  console.error('  Local:          GESTAOCLICK_ACCESS_TOKEN + GESTAOCLICK_SECRET_TOKEN');
  process.exit(1);
}

const {
  runBootstrap,
  HISTORICO_INICIO,
  SYNC_STATE_COLLECTION,
  SYNC_STATE_DOC,
  VENDAS_GC_COLLECTION,
  PERFIS_360_COLLECTION,
} = require('../functions/lib/sync360');

// ── Firestore client (Admin SDK via @google-cloud/firestore) ─────────────────
const db = new Firestore({ projectId: PROJECT_ID, databaseId: '(default)' });

// ── GestãoClick HTTP client ──────────────────────────────────────────────────

function gcRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, limite: '100' }).toString();
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
        catch (e) { reject(new Error('GC JSON parse error: ' + e.message)); }
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

async function firestoreGetPerfil(clienteMr4Id) {
  const doc = await db.collection(PERFIS_360_COLLECTION).doc(clienteMr4Id).get();
  return doc.exists ? doc.data() : null;
}

async function firestoreGetSyncState() {
  const doc = await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).get();
  return doc.exists ? doc.data() : null;
}

async function firestoreSetSyncState(data) {
  if (DRY_RUN) { console.log('[DRY_RUN] SetSyncState:', JSON.stringify(data).slice(0, 120)); return; }
  await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).set(data, { merge: true });
}

async function firestoreUpsertPerfil(clienteMr4Id, perfil) {
  if (DRY_RUN) { return; }
  await db.collection(PERFIS_360_COLLECTION).doc(clienteMr4Id).set(perfil);
}

/**
 * Grava vendas_gc em batches de BATCH_SIZE.
 * Usa BulkWriter para paralelismo controlado.
 */
async function firestoreUpsertVendas(vendas) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] UpsertVendas: ${vendas.length} docs (não escritos)`);
    return;
  }

  const writer = db.bulkWriter();
  writer.onWriteError(err => {
    // BulkWriter faz retry automático; erros persistentes relançam exceção
    console.error('[BulkWriter] Erro:', err.documentRef.path, err.code);
    return false;  // false = não tentar novamente neste erro
  });

  let n = 0;
  for (const venda of vendas) {
    const ref = db.collection(VENDAS_GC_COLLECTION).doc(String(venda.id));
    writer.set(ref, venda);
    n++;
    // Flush a cada BATCH_SIZE para não acumular operações na memória
    if (n % BATCH_SIZE === 0) {
      await writer.flush();
      console.log(`  vendas_gc: ${n}/${vendas.length} escritas...`);
    }
  }
  await writer.close();
  console.log(`  vendas_gc: ${n} documentos escritos.`);
}

// ── Verificação de pré-condição (coleções ausentes) ──────────────────────────

async function verificarColecoeAusentes() {
  const results = {};
  for (const col of [PERFIS_360_COLLECTION, VENDAS_GC_COLLECTION]) {
    const snap = await db.collection(col).limit(1).get();
    results[col] = snap.empty ? 'AUSENTE' : 'JA_EXISTE';
  }
  const syncDoc = await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).get();
  results[`${SYNC_STATE_COLLECTION}/${SYNC_STATE_DOC}`] = syncDoc.exists ? 'JA_EXISTE' : 'AUSENTE';
  return results;
}

// ── Sanity pós-bootstrap ──────────────────────────────────────────────────────

async function sanityPosBootstrap(bootstrapResult) {
  const perfisSnap = await db.collection(PERFIS_360_COLLECTION).get();
  const vendasSnap = await db.collection(VENDAS_GC_COLLECTION).get();
  const syncDoc    = await db.collection(SYNC_STATE_COLLECTION).doc(SYNC_STATE_DOC).get();

  let nuncaComprou = 0, jaComprou = 0, inativo120d = 0, ativo = 0;
  let fatEngineCentavos = 0, pedidosEngine = 0;

  // GestãoClick IDs dos clientes linkados (para filtrar vendas_gc)
  const clientesSnap = await db.collection('clientes')
    .where('gestaoClickId', '!=', null).select('gestaoClickId').get();
  const gcIds = new Set(
    clientesSnap.docs.map(d => String(d.data().gestaoClickId || '')).filter(Boolean)
  );

  perfisSnap.docs.forEach(d => {
    const p = d.data();
    if (p.nuncaComprou) nuncaComprou++;
    else {
      jaComprou++;
      if (p.inativo120d) inativo120d++;
      else ativo++;
      fatEngineCentavos += Math.round((p.faturamentoTotal || 0) * 100);
      pedidosEngine += (p.pedidosTotal || 0);
    }
  });

  // Sanity financeiro: comparar perfis vs espelho vendas_gc
  let fatEspelhoCentavos = 0, pedidosEspelho = 0;
  const vendasIdsVistos = new Set();
  vendasSnap.docs.forEach(d => {
    const v = d.data();
    const gcId = String(v.cliente_id || '');
    if (!gcIds.has(gcId)) return;                       // cliente não linkado
    if (v.nome_situacao !== 'Concretizada') return;     // só Concretizadas
    if (vendasIdsVistos.has(v.id)) return;              // dedup
    vendasIdsVistos.add(v.id);
    fatEspelhoCentavos += Math.round((parseFloat(v.valor_total) || 0) * 100);
    pedidosEspelho++;
  });

  const difCentavos = Math.abs(fatEngineCentavos - fatEspelhoCentavos);
  const difPedidos  = Math.abs(pedidosEngine - pedidosEspelho);

  console.log('\n' + '='.repeat(60));
  console.log('SANITY PÓS-BOOTSTRAP');
  console.log('='.repeat(60));
  console.log(`VENDAS_GC_DOCS              = ${vendasSnap.size}`);
  console.log(`PERFIS_360_DOCS             = ${perfisSnap.size}`);
  console.log(`SYNC_STATUS                 = ${syncDoc.exists ? syncDoc.data().status : 'NÃO_EXISTE'}`);
  console.log(`NUNCA_COMPROU               = ${nuncaComprou}`);
  console.log(`JA_COMPROU                  = ${jaComprou}`);
  console.log(`INATIVOS_120D               = ${inativo120d}`);
  console.log(`ATIVOS                      = ${ativo}`);
  console.log(`FATURAMENTO_PERFIS_CENTAVOS = ${fatEngineCentavos}`);
  console.log(`FATURAMENTO_ESPELHO_CENTAVOS = ${fatEspelhoCentavos}`);
  console.log(`DIFERENCA_CENTAVOS          = ${difCentavos}`);
  console.log(`PEDIDOS_PERFIS              = ${pedidosEngine}`);
  console.log(`PEDIDOS_ESPELHO             = ${pedidosEspelho}`);
  console.log(`DIFERENCA_PEDIDOS           = ${difPedidos}`);

  const sOk  = syncDoc.exists && syncDoc.data().status === 'READY';
  const pOk  = perfisSnap.size === 52;
  const dcOk = difCentavos === 0;
  const dpOk = difPedidos === 0;

  console.log(`\nSANITY_PASS = ${sOk && pOk && dcOk && dpOk}`);
  return { sOk, pOk, nuncaComprou, jaComprou, inativo120d, ativo,
           fatEngineCentavos, fatEspelhoCentavos, difCentavos,
           pedidosEngine, pedidosEspelho, difPedidos, dcOk, dpOk };
}

// ── Verificação de amostra ────────────────────────────────────────────────────

async function verificarAmostra() {
  const perfisSnap = await db.collection(PERFIS_360_COLLECTION).get();
  const perfis = perfisSnap.docs.map(d => d.data());

  const amostras = [
    { label: 'nuncaComprou',   p: perfis.find(p => p.nuncaComprou) },
    { label: 'inativo120d',    p: perfis.find(p => !p.nuncaComprou && p.inativo120d) },
    { label: 'ativo',          p: perfis.find(p => !p.nuncaComprou && !p.inativo120d) },
    { label: 'multiplas',      p: perfis.find(p => (p.pedidosTotal || 0) > 5) },
  ];

  console.log('\nVERIFICAÇÃO DE AMOSTRAS:');
  for (const { label, p } of amostras) {
    if (!p) { console.log(`  ${label}: NÃO_ENCONTRADO`); continue; }
    const docRef = db.collection(PERFIS_360_COLLECTION).doc(p.clienteMr4Id);
    const docSnap = await docRef.get();
    const match = docSnap.exists &&
      docSnap.data().pedidosTotal === p.pedidosTotal &&
      docSnap.data().nuncaComprou === p.nuncaComprou &&
      docSnap.data().versaoEngine === p.versaoEngine;
    console.log(`  ${label}: clienteMr4Id=${p.clienteMr4Id.slice(0,8)}... MATCH=${match}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dataReferencia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' });

  console.log('='.repeat(60));
  console.log('BOOTSTRAP PERFIL360 V1');
  console.log('='.repeat(60));
  console.log(`DRY_RUN         = ${DRY_RUN}`);
  console.log(`DATA_REFERENCIA = ${dataReferencia}`);
  console.log(`HISTORICO_INICIO = ${HISTORICO_INICIO}`);
  console.log();

  // ── Verificar pré-condições ───────────────────────────────────────────────
  if (!DRY_RUN) {
    console.log('Verificando pré-condições...');
    const estadoCols = await verificarColecoeAusentes();
    let bloqueado = false;
    for (const [col, status] of Object.entries(estadoCols)) {
      console.log(`  ${col}: ${status}`);
      if (status === 'JA_EXISTE') {
        // sync_state pode existir se bootstrap foi interrompido — permitir re-run
        if (col !== `${SYNC_STATE_COLLECTION}/${SYNC_STATE_DOC}`) {
          console.error(`\nPRÉ-CONDIÇÃO FALHOU: ${col} já existe. PARANDO.`);
          bloqueado = true;
        } else {
          const sd = await firestoreGetSyncState();
          if (sd && sd.status === 'READY') {
            console.error('\nPRÉ-CONDIÇÃO FALHOU: sync_state.status=READY. Bootstrap já completo.');
            bloqueado = true;
          } else {
            console.log(`  (sync_state existe mas status=${sd?.status} — re-bootstrap permitido)`);
          }
        }
      }
    }
    if (bloqueado) process.exit(1);
  }

  // ── Executar bootstrap ────────────────────────────────────────────────────
  console.log('\nExecutando bootstrap...');
  const result = await runBootstrap({
    gcFetchPage,
    firestoreGetClientes,
    firestoreGetPerfil,
    firestoreGetSyncState,
    firestoreUpsertVendas,
    firestoreUpsertPerfil,
    firestoreSetSyncState,
    dryRun:         DRY_RUN,
    dataReferencia,
  });

  console.log('\n' + '='.repeat(60));
  console.log('RESULTADO BOOTSTRAP');
  console.log('='.repeat(60));
  console.log(`DRY_RUN_TOTAL_CLIENTES    = ${result.totalClientes}`);
  console.log(`DRY_RUN_TOTAL_VENDAS      = ${result.totalVendas}`);
  console.log(`DRY_RUN_CREATES           = ${result.creates}`);
  console.log(`DRY_RUN_UPDATES           = ${result.updates}`);
  console.log(`DRY_RUN_UNCHANGED         = ${result.unchanged}`);
  console.log(`DRY_RUN_CONFLICTS         = ${result.totalConflicts}`);

  if (DRY_RUN) {
    console.log('\nFIRESTORE_WRITES = ZERO (DRY_RUN=true)');
    return;
  }

  // ── Sanity pós-bootstrap ──────────────────────────────────────────────────
  await sanityPosBootstrap(result);
  await verificarAmostra();

  console.log('\nFIRESTORE_WRITES = EXECUTADOS');
  console.log('GC_WRITES        = ZERO');
  console.log('PRONTO_PARA_SYNC_AUTOMATICO = NÃO (configurar na próxima fase)');
}

main().catch(err => {
  console.error('\nFALHA FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
