'use strict';
/**
 * F1 — Política: usuário BLOQUEADO não acessa informações nem executa operações, independentemente do cargo.
 * Fonte única da verificação de bloqueio para as Functions que só checavam users.ativo/role.
 * `sistema_usuarios/{uid}.bloqueado === true` ⇒ permission-denied (mesma regra das Firestore Rules, R1).
 * Sem documento em sistema_usuarios: não há registro de bloqueio a respeitar (gestor/funcionário só com `users`) — segue a decisão das Rules.
 * FAIL CLOSED na leitura: se não for possível ler sistema_usuarios, NEGA (não presume "não bloqueado").
 */
const { HttpsError } = require('firebase-functions/v2/https');

async function exigirNaoBloqueado(db, uid) {
  let snap;
  try { snap = await db.collection('sistema_usuarios').doc(uid).get(); }
  catch (_) { throw new HttpsError('permission-denied', 'Acesso negado.'); }          // fail closed (sem expor o erro)
  if (snap.exists && snap.data().bloqueado === true) throw new HttpsError('permission-denied', 'Conta bloqueada. Contate o gestor.');
  return snap.exists ? snap.data() : null;
}

module.exports = { exigirNaoBloqueado };
