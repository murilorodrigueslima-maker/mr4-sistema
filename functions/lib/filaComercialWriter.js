'use strict';
// N34 Phase E — Fila Comercial: snapshot builder
// Constrói o documento VIEW MODEL pronto para escrita em fila_comercial/snapshot.
// PURO: sem Firebase, sem LLM, sem side effects. Testável com Jest puro.
//
// Responsabilidade: recebe clientes brutos do pipeline, devolve objeto
// sanitizado (sem CAMPOS_BLOQUEADOS) pronto para Admin SDK escrever em Firestore.
//
// Garantias:
//   SELLER_ASSIST_SENT_TO_FRONTEND=NO  (comoAbordar nunca entra no snapshot)
//   PROD_WRITES=0                      (este módulo nunca acessa Firestore)
//   DATA_CAMPOSBLOCK_IN_SNAPSHOT=NO    (prepararDadosUI() remove todos)

const {
  prepararDadosUI,
  filtrarOrdenarFilaHoje,
  filtrarOrdenarProximosContatos,
  verificarCamposBloqueados,
  UPCOMING_WINDOW_DAYS,
} = require('./filaComercialUtils');

const SCHEMA_VERSION = 'v1';

/**
 * Constrói o snapshot VIEW MODEL a partir de clientes brutos do pipeline.
 * Deve ser chamado ANTES de qualquer escrita em Firestore.
 *
 * @param {object[]} clientesBrutos - Array de clientes com campos completos do pipeline
 * @param {object}   opts
 * @param {number}   [opts.windowDays=7]      - Janela de PRÓXIMOS em dias
 * @param {Date}     [opts.timestamp=new Date()] - Momento do snapshot
 * @param {string}   [opts.pipelineVersion]   - Versão do pipeline (ex: 'N33.6')
 * @returns {{ clientesHoje: object[], clientesProximos: object[], metadata: object }}
 */
function construirSnapshot(clientesBrutos, opts = {}) {
  const windowDays = (typeof opts.windowDays === 'number') ? opts.windowDays : UPCOMING_WINDOW_DAYS;
  const timestamp = (opts.timestamp instanceof Date) ? opts.timestamp : new Date();
  const pipelineVersion = opts.pipelineVersion || null;

  if (!Array.isArray(clientesBrutos)) {
    throw new TypeError('construirSnapshot: clientesBrutos deve ser Array');
  }

  // Filtra e ordena nas duas seções ANTES de preparar UI (usa campos brutos para sort)
  const filaHoje     = filtrarOrdenarFilaHoje(clientesBrutos);
  const filaProximos = filtrarOrdenarProximosContatos(clientesBrutos, windowDays);

  // Prepara VIEW MODEL (strip de CAMPOS_BLOQUEADOS) para cada cliente
  const clientesHoje     = filaHoje.map(prepararDadosUI).filter(Boolean);
  const clientesProximos = filaProximos.map(prepararDadosUI).filter(Boolean);

  return {
    schemaVersion:   SCHEMA_VERSION,
    pipelineVersion: pipelineVersion,
    timestamp:       timestamp,
    clientesHoje,
    clientesProximos,
    metadata: {
      totalHoje:      clientesHoje.length,
      totalProximos:  clientesProximos.length,
      totalProcessados: clientesBrutos.length,
      windowDays,
    },
  };
}

/**
 * Valida que um snapshot não contém CAMPOS_BLOQUEADOS em nenhum nível.
 * Lança erro se encontrar. Usar após construirSnapshot() em testes.
 * @param {object} snapshot - Resultado de construirSnapshot()
 */
function assertSnapshotSeguro(snapshot) {
  const bloqueados = verificarCamposBloqueados(snapshot);
  if (bloqueados.length > 0) {
    throw new Error(
      `SECURITY VIOLATION: snapshot contém CAMPOS_BLOQUEADOS: ${bloqueados.join(', ')}`
    );
  }
}

module.exports = {
  SCHEMA_VERSION,
  construirSnapshot,
  assertSnapshotSeguro,
};
