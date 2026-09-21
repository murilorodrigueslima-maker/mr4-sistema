'use strict';
// N34.5 — Gerador Agendado de Snapshot da Fila Comercial
// Core testável. O handler Firebase em index.js é um thin wrapper sobre executarGeracaoFilaSnapshot.
//
// INVARIANTES:
//   OPENAI_CALLS=0        — sem LLM
//   PROD_WRITES=0         — depende do db injetado (emulador em testes)
//   SELLER_ASSIST=NO      — situacao/quando via renderers de abordagemContract
//   PII_IN_LOGS=NO        — apenas contagens, sem nomes nem IDs de cliente
//   MAIN_SYNC_UNTOUCHED=YES — não lê nem escreve em vendas_gc, sync_state, perfis_360

const { processarPerfisParaFila, PIPELINE_VERSION } = require('./filaComercialPipeline');
const { construirSnapshot, assertSnapshotSeguro }    = require('./filaComercialWriter');
const { escreverSnapshotFila }                       = require('./filaComercialFirestoreWriter');

/**
 * Retorna a data de referência atual em America/Fortaleza como string YYYY-MM-DD.
 * @param {Date} now
 * @returns {string}
 */
function calcularDataReferencia(now = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Fortaleza',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).formatToParts(now);
  const ano = partes.find(p => p.type === 'year').value;
  const mes = partes.find(p => p.type === 'month').value;
  const dia = partes.find(p => p.type === 'day').value;
  return `${ano}-${mes}-${dia}`;
}

/**
 * Carrega todos os perfis de perfis_360 e combina com nomes de clientes/.
 * Leitura em paralelo. Retorna apenas entradas com clienteMr4Id presente.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<Array<{ perfil360: object, nomeCliente: string|null }>>}
 */
async function carregarPerfisComNomes(db) {
  const [perfisSnap, clientesSnap] = await Promise.all([
    db.collection('perfis_360').get(),
    db.collection('clientes').get(),
  ]);

  const nomesMap = new Map();
  for (const doc of clientesSnap.docs) {
    const d = doc.data();
    nomesMap.set(doc.id, d.nome || d.razao_social || d.nomeCliente || null);
  }

  return perfisSnap.docs
    .map(doc => ({
      perfil360:   doc.data(),
      nomeCliente: nomesMap.get(doc.id) || null,
    }))
    .filter(({ perfil360 }) => !!perfil360.clienteMr4Id);
}

/**
 * Orquestra a geração completa do snapshot da fila comercial.
 * Lança erro em caso de falha — o handler em index.js captura sem re-throw (falha isolada).
 *
 * @param {object}  opts
 * @param {FirebaseFirestore.Firestore} opts.db            — instância do Admin SDK Firestore
 * @param {object}  [opts.logger=console]                  — logger injetável (para testes)
 * @param {Date}    [opts.now=new Date()]                  — relógio injetável (para testes)
 * @param {string}  [opts.dataReferencia]                  — override de data YYYY-MM-DD
 * @returns {Promise<object>} snapshot construído
 */
async function executarGeracaoFilaSnapshot({ db, logger = console, now = new Date(), dataReferencia }) {
  const t0    = Date.now();
  const drStr = dataReferencia || calcularDataReferencia(now);

  logger.log(JSON.stringify({ event: 'fila_snapshot_start', dataReferencia: drStr }));

  const perfisComNomes = await carregarPerfisComNomes(db);
  const clientesBrutos = await processarPerfisParaFila(perfisComNomes, { dataReferencia: drStr });

  const snapshot = construirSnapshot(clientesBrutos, {
    pipelineVersion: PIPELINE_VERSION,
    timestamp:       now,
  });

  assertSnapshotSeguro(snapshot);

  await escreverSnapshotFila(db, snapshot);

  const durationMs = Date.now() - t0;
  logger.log(JSON.stringify({
    event:              'fila_snapshot_success',
    profilesConsidered: perfisComNomes.length,
    todayCount:         snapshot.metadata.totalHoje,
    upcomingCount:      snapshot.metadata.totalProximos,
    durationMs,
    schemaVersion:      snapshot.schemaVersion,
  }));

  return snapshot;
}

module.exports = {
  executarGeracaoFilaSnapshot,
  calcularDataReferencia,
  carregarPerfisComNomes,
};
