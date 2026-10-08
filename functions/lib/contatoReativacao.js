'use strict';
/**
 * Callable crmContatoReativacao { opportunityInstanceId } → telefone do cliente de uma OPORTUNIDADE DE REATIVAÇÃO.
 * Autorização NO BACKEND, antes de qualquer consulta ao GestãoClick: vendedor ativo/não bloqueado com módulo fila-comercial-operar E reserva RESERVADA e vigente
 * destinada a ele; ou gestão (role gestor | módulo fila-comercial-gestao). Cliente NÃO CONTATAR ⇒ nada é retornado. O número NÃO é gravado, logado nem auditado
 * (auditoria registra só quem, quando e o cliente); a resposta só vai para o chamador autorizado.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { escolherContato } = require('./contatoGc'); const A = require('./auditoria');
const OPP = /^[0-9a-f]{16}$/;
const negar = () => new HttpsError('permission-denied', 'Sem acesso a este contato.');

async function contatoReativacaoHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data; if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => k !== 'opportunityInstanceId') || !OPP.test(String(d.opportunityInstanceId))) throw new HttpsError('invalid-argument', 'Pedido inválido.');
  const admin = require('firebase-admin'); const store = opts.db || admin.firestore(); const FV = admin.firestore.FieldValue; const uid = request.auth.uid; const agora = (opts.now ? opts.now() : new Date());
  const [u, s] = await Promise.all([store.collection('users').doc(uid).get(), store.collection('sistema_usuarios').doc(uid).get()]);
  if (!u.exists || !s.exists || !u.data().ativo || s.data().bloqueado === true || !['gestor', 'funcionario'].includes(u.data().role)) throw negar();
  const mods = Array.isArray(s.data().modulos) ? s.data().modulos : []; const gestao = u.data().role === 'gestor' || mods.includes('fila-comercial-gestao'); const vendedor = mods.includes('fila-comercial-operar');
  if (!gestao && !vendedor) throw negar();
  const q = await store.collection('carteira_reativacoes').where('opportunityInstanceId', '==', d.opportunityInstanceId).limit(1).get(); if (q.empty) throw negar();   // inexistente e alheia são indistinguíveis
  const rv = q.docs[0].data(); const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(agora); const fim = rv.followUpAte && rv.followUpAte > rv.reservaAte ? rv.followUpAte : rv.reservaAte;
  if (rv.estado !== 'RESERVADA') throw negar();
  if (!gestao && (rv.destinoUid !== uid || hoje < rv.liberadoEm || hoje > fim)) throw negar();                                                                        // ← autorização ANTES de consultar o GestãoClick
  const rst = await store.collection('carteira_comercial_restricoes').doc(rv.portfolioId).get(); if (rst.exists && rst.data().naoContatar === true) return { bloqueado: true, motivo: 'NAO_CONTATAR' };
  let c; try { c = await opts.lookup(rv.portfolioId.slice(3)); } catch (_) { throw new HttpsError('unavailable', 'Não foi possível consultar o contato agora.'); }
  const contato = escolherContato(c); if (!c) throw new HttpsError('unavailable', 'Não foi possível consultar o contato agora.');
  try { await A.gravar(store, FV, `contato_${d.opportunityInstanceId}_${uid}_${agora.toISOString().slice(0, 13).replace(/\D/g, '')}`, A.evento({ ator: await A.enriquecerAtor(store, { uid, type: 'USER', origin: 'CALLABLE_AUTH' }),
    action: 'REACTIVATION_CONTACT_VIEWED', category: A.CATEGORIAS.COMMERCIAL, entityType: 'carteira_reativacoes', entityId: rv.portfolioId, source: 'CALLABLE:crmContatoReativacao', before: null, after: null, metadata: { tipo: contato ? contato.tipo : 'SEM_TELEFONE' } })); } catch (_) { /* auditoria não bloqueia; sem dados sensíveis */ }
  return contato ? { bloqueado: false, tipo: contato.tipo, exibicao: contato.exibicao, whatsapp: contato.whatsapp } : { bloqueado: false, tipo: 'SEM_TELEFONE', exibicao: null, whatsapp: null };
}
module.exports = { contatoReativacaoHandler };
