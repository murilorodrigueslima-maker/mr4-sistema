'use strict';
/**
 * B3.1-E — Registro PERSISTENTE de conflitos de identidade, independente de existir carteira. identidade_conflitos/{CG-...}.
 * Só ids técnicos GC, tipos de sinal, status e timestamps (sem PII). Todo cliente-membro fica BLOQUEADO para automação até resolução FUTURA (esta
 * etapa não resolve, não funde, não escolhe owner). Criação idempotente (create-only por grupoId).
 */
const A = require('./auditoria');
const COLL = 'identidade_conflitos';
async function registrarGrupos(store, FieldValue, grupos, { agoraIso, origem = 'B3_1_REGISTRO', executar = false } = {}) {
  const novos = [], existentes = [];
  for (const g of grupos) {
    const ref = store.collection(COLL).doc(g.grupoId); const s = await ref.get();
    if (s.exists) { existentes.push(g.grupoId); continue; }
    const doc = { schemaVersion: 'conflito-v1', grupoId: g.grupoId, membros: g.ids.map(i => 'GC:' + i), tipos: g.tipos, forca: g.forca, comCarteira: g.comCarteira.map(i => 'GC:' + i), semCarteira: g.semCarteira.map(i => 'GC:' + i),
      donosDiferentes: g.donosDiferentes === true, status: 'PENDENTE', origem, detectadoEm: agoraIso, criadoEm: agoraIso, versao: 1 };
    novos.push(doc);
    if (executar) { await ref.create(doc); await A.gravar(store, FieldValue, 'conflito_' + g.grupoId, A.evento({ ator: { uid: null, type: 'SYSTEM', origin: 'SERVER' }, action: 'IDENTITY_CONFLICT_REGISTERED', category: A.CATEGORIAS.COMMERCIAL,
      entityType: COLL, entityId: g.grupoId, source: 'LIB:conflitosRegistro', before: null, after: { status: 'PENDENTE', membros: g.ids.length, forca: g.forca }, metadata: { origem } })); }
  }
  return { novos, existentes };
}
async function membrosBloqueados(store) { const s = await store.collection(COLL).where('status', '==', 'PENDENTE').get(); const ids = new Set(); s.docs.forEach(d => (d.data().membros || []).forEach(m => ids.add(String(m).replace(/^GC:/, '')))); return ids; }
module.exports = { COLL, registrarGrupos, membrosBloqueados };
