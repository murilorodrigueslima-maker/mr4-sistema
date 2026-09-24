'use strict';
// N34.6 — Gerador Agendado de Snapshot da Fila Comercial
// Core testável. O handler Firebase em index.js é um thin wrapper sobre executarGeracaoFilaSnapshot.
//
// INVARIANTES:
//   OPENAI_CALLS=0        — sem LLM
//   PROD_WRITES=0         — depende do db injetado (emulador em testes)
//   SELLER_ASSIST=NO      — situacao/quando via renderers de abordagemContract
//   PII_IN_LOGS=NO        — apenas contagens, sem nomes nem IDs de cliente
//   MAIN_SYNC_UNTOUCHED=YES — não lê nem escreve em vendas_gc, sync_state, perfis_360
//   SINGLE_REFERENCE_DATE=YES — todos os perfis avaliados com a mesma dataReferencia

const { processarPerfisParaFila, PIPELINE_VERSION } = require('./filaComercialPipeline');
const { construirSnapshot, assertSnapshotSeguro }    = require('./filaComercialWriter');
const { escreverSnapshotFila }                       = require('./filaComercialFirestoreWriter');
const { daysBetweenCalendarDates }                   = require('./perfil360');

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
 * Rebasa as métricas temporais de um perfil para uma dataReferencia única.
 * Recalcula diasSemComprar e inativo120d sem modificar o documento persistido.
 * Never-bought (nuncaComprou=true) e perfis sem ultimaCompraEm são preservados intactos.
 *
 * @param {object} perfil — output de calcularPerfil360 tal como gravado em perfis_360
 * @param {string} drStr  — data de referência YYYY-MM-DD do snapshot
 * @returns {object}      — perfil com diasSemComprar/inativo120d recalculados
 * @throws {Error}        — se ultimaCompraEm > drStr (estado inválido)
 */
function rebasarTemporalPerfil(perfil, drStr) {
  if (perfil.nuncaComprou || perfil.ultimaCompraEm == null) {
    return perfil;
  }

  const ucStr = typeof perfil.ultimaCompraEm === 'string'
    ? perfil.ultimaCompraEm.slice(0, 10)
    : null;

  if (!ucStr || !/^\d{4}-\d{2}-\d{2}$/.test(ucStr)) {
    return perfil;
  }

  const diasSemComprar = daysBetweenCalendarDates(ucStr, drStr);

  if (diasSemComprar < 0) {
    throw new Error(
      `TEMPORAL_REBASE_ERROR: ultimaCompraEm=${ucStr} está no futuro relativo a dataReferencia=${drStr} para clienteMr4Id=${perfil.clienteMr4Id}`
    );
  }

  return {
    ...perfil,
    diasSemComprar,
    inativo120d: diasSemComprar >= 120,
  };
}

/**
 * Carrega todos os perfis de perfis_360 e combina com dados de clientes/.
 * Leitura em paralelo. Retorna apenas entradas com clienteMr4Id presente.
 * Inclui criadoEm (campo criado_em) para uso na seção de Prospecção.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<Array<{ perfil360: object, nomeCliente: string|null, criadoEm: string|null }>>}
 */
async function carregarPerfisComNomes(db) {
  const [perfisSnap, clientesSnap] = await Promise.all([
    db.collection('perfis_360').get(),
    db.collection('clientes').get(),
  ]);

  const clienteInfoMap = new Map();
  for (const doc of clientesSnap.docs) {
    const d = doc.data();
    clienteInfoMap.set(doc.id, {
      nome:     d.nome || d.razao_social || d.nomeCliente || null,
      criadoEm: d.criado_em || null,
    });
  }

  return perfisSnap.docs
    .map(doc => {
      const info = clienteInfoMap.get(doc.id) || {};
      return {
        perfil360:   doc.data(),
        nomeCliente: info.nome || doc.data().nomeCliente || null,
        criadoEm:    info.criadoEm || null,
      };
    })
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

  // Rebase temporal: todos os perfis avaliados contra a MESMA dataReferencia do snapshot.
  // Não altera documentos persistidos — apenas recalcula diasSemComprar/inativo120d em memória.
  const perfisRebaseados = perfisComNomes.map(({ perfil360, nomeCliente, criadoEm }) => ({
    perfil360:   rebasarTemporalPerfil(perfil360, drStr),
    nomeCliente,
    criadoEm,
  }));

  const clientesBrutos = await processarPerfisParaFila(perfisRebaseados, { dataReferencia: drStr });

  // Enriquece prospects com criadoEm para o card de Prospecção.
  // criadoEm nunca entra em HOJE ou PROXIMOS — apenas na seção PROSPECCAO.
  const criadoEmPorId = new Map(
    perfisRebaseados
      .filter(p => p.criadoEm && p.perfil360.clienteMr4Id)
      .map(p => [p.perfil360.clienteMr4Id, p.criadoEm])
  );

  const clientesBrutosComProspect = clientesBrutos.map(c => {
    if (c.tipoOportunidade === 'PROSPECT_VINCULADO' && criadoEmPorId.has(c.clienteMr4Id)) {
      return { ...c, criadoEm: criadoEmPorId.get(c.clienteMr4Id) };
    }
    return c;
  });

  const snapshot = construirSnapshot(clientesBrutosComProspect, {
    pipelineVersion:  PIPELINE_VERSION,
    timestamp:        now,
    dataReferencia:   drStr,
  });

  assertSnapshotSeguro(snapshot);

  await escreverSnapshotFila(db, snapshot);

  const durationMs = Date.now() - t0;
  logger.log(JSON.stringify({
    event:              'fila_snapshot_success',
    profilesConsidered: perfisComNomes.length,
    todayCount:         snapshot.metadata.totalHoje,
    upcomingCount:      snapshot.metadata.totalProximos,
    prospeccaoCount:    snapshot.metadata.totalProspeccao,
    durationMs,
    schemaVersion:      snapshot.schemaVersion,
  }));

  return snapshot;
}

module.exports = {
  executarGeracaoFilaSnapshot,
  calcularDataReferencia,
  carregarPerfisComNomes,
  rebasarTemporalPerfil,
};
