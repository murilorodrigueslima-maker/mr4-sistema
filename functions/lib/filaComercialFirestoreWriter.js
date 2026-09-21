'use strict';
// N34.3 — Fila Comercial Firestore Writer
// Escreve snapshot da fila em fila_comercial/snapshot via Admin SDK.
// Injeção de dependência: recebe db como parâmetro para testabilidade.
// PROD_WRITES: depende do db passado pelo chamador (emulador vs produção).

const COLLECTION = 'fila_comercial';
const DOCUMENT   = 'snapshot';

/**
 * Escreve o snapshot VIEW MODEL em fila_comercial/snapshot.
 * Deve receber instância Admin SDK apontada para emulador (em testes)
 * ou para produção (em Cloud Function autorizada).
 *
 * @param {FirebaseFirestore.Firestore} db       — Admin SDK Firestore instance
 * @param {object}                      snapshot — Resultado de construirSnapshot()
 * @returns {Promise<void>}
 */
async function escreverSnapshotFila(db, snapshot) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('escreverSnapshotFila: db deve ser instância do Admin SDK Firestore');
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('escreverSnapshotFila: snapshot inválido');
  }
  const doc = {
    ...snapshot,
    timestamp: snapshot.timestamp || new Date(),
    escritoEm: new Date(),
  };
  await db.collection(COLLECTION).doc(DOCUMENT).set(doc);
}

module.exports = {
  COLLECTION,
  DOCUMENT,
  escreverSnapshotFila,
};
