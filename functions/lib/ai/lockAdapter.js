'use strict';

/**
 * Lock Adapter Atômico para Firestore — N19 (L1).
 *
 * Implementa o protocolo de lock de concorrência do runIncremental()
 * usando Firestore Transaction para garantia atômica.
 *
 * Protocolo:
 *   1. Tenta adquirir o lock em transaction
 *   2. Lock livre (ou expirado) → escreve documento com ownerId + expiresAt
 *   3. Lock ocupado (outro owner, não expirado) → retorna false
 *   4. Release: verifica ownerId antes de apagar (não apaga lock alheio)
 *
 * Documento de lock:
 *   { ownerId, acquiredAt, expiresAt, ttlMs }
 *
 * IMPORTANTE:
 *   - NÃO executar em produção diretamente — adapter é injetado nos adapters
 *     do runIncremental(). Produção continua com lock=null até decisão.
 *   - Os testes usam mock de transaction para verificar comportamento atômico.
 *   - Não requer Rules/IAM adicionais (usa mesma coleção sync_state).
 */

const VERSAO_ADAPTER = 'lock-adapter-v1';

// Coleção e documento do lock (mesma coleção do sync_state)
const LOCK_COLLECTION = 'sync_state';
const LOCK_DOC_ID     = 'incremental_lock';

// ── Factory de adapter ────────────────────────────────────────────────────────

/**
 * Cria os adapters de lock para injeção no runIncremental().
 *
 * @param {Object} db — instância do Firestore (Admin SDK)
 * @returns {{ firestoreAcquireLock, firestoreReleaseLock }}
 */
function criarLockAdapter(db) {
  if (!db || typeof db.runTransaction !== 'function') {
    throw new Error('criarLockAdapter: db deve ser instância Firestore com runTransaction');
  }

  /**
   * Tenta adquirir o lock atomicamente.
   * @param {string} ownerId  — identificador único desta execução
   * @param {number} ttlMs    — TTL em ms (ex: 10 * 60 * 1000 = 10 min)
   * @returns {Promise<boolean>} true se adquirido, false se bloqueado
   */
  async function firestoreAcquireLock(ownerId, ttlMs) {
    const lockRef = db.collection(LOCK_COLLECTION).doc(LOCK_DOC_ID);
    const now     = Date.now();

    let acquired = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const data = snap.exists ? snap.data() : null;

      // Lock livre se: (a) documento não existe, (b) expiresAt passou
      const lockLivre = !data || !data.expiresAt || data.expiresAt < now;

      if (lockLivre) {
        tx.set(lockRef, {
          ownerId,
          acquiredAt: now,
          expiresAt:  now + ttlMs,
          ttlMs,
          versao:     VERSAO_ADAPTER,
        });
        acquired = true;
      }
      // Se lock ocupado: não faz nada na tx, acquired permanece false
    });

    return acquired;
  }

  /**
   * Libera o lock somente se ownerId corresponde.
   * Não remove lock de outro owner.
   * @param {string} ownerId — mesmo ownerId usado na aquisição
   */
  async function firestoreReleaseLock(ownerId) {
    const lockRef = db.collection(LOCK_COLLECTION).doc(LOCK_DOC_ID);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      if (!snap.exists) return;  // já removido — ok

      const data = snap.data();
      if (data.ownerId !== ownerId) return;  // não é nosso lock — não tocar

      tx.delete(lockRef);
    });
  }

  return { firestoreAcquireLock, firestoreReleaseLock, versaoAdapter: VERSAO_ADAPTER };
}

// ── Implementação para testes (mock de Firestore) ─────────────────────────────

/**
 * Cria um mock in-memory do adapter de lock para testes unitários.
 * Simula transações atômicas sem Firestore real.
 *
 * @returns {{ firestoreAcquireLock, firestoreReleaseLock, _state }}
 */
function criarLockAdapterMock() {
  let _lockDoc = null;  // simula o documento no Firestore

  async function firestoreAcquireLock(ownerId, ttlMs) {
    const now = Date.now();
    const lockLivre = !_lockDoc || !_lockDoc.expiresAt || _lockDoc.expiresAt < now;
    if (lockLivre) {
      _lockDoc = { ownerId, acquiredAt: now, expiresAt: now + ttlMs, ttlMs };
      return true;
    }
    return false;
  }

  async function firestoreReleaseLock(ownerId) {
    if (!_lockDoc) return;
    if (_lockDoc.ownerId !== ownerId) return;  // não remove lock alheio
    _lockDoc = null;
  }

  // Acesso ao estado interno para testes
  const _state = {
    getLock: () => _lockDoc ? { ..._lockDoc } : null,
    forceExpire: () => { if (_lockDoc) _lockDoc.expiresAt = Date.now() - 1; },
    forceClear:  () => { _lockDoc = null; },
  };

  return { firestoreAcquireLock, firestoreReleaseLock, _state, versaoAdapter: VERSAO_ADAPTER };
}

module.exports = {
  VERSAO_ADAPTER,
  LOCK_COLLECTION,
  LOCK_DOC_ID,
  criarLockAdapter,
  criarLockAdapterMock,
};
