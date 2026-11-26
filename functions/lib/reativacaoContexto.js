'use strict';
/** B3 — carrega (SOMENTE LEITURA) o contexto que o planejador precisa. Nenhuma escrita. */
const R = require('./reativacao120');
const { normalizeGestaoClickId } = require('./commercialIdentity');

// Montadores PUROS, compartilhados com a leitura incremental (reativacaoIncremental.js): as duas leituras constroem o contexto
// com exatamente a mesma lógica, mudando apenas QUAIS documentos são lidos.
const CAMPOS_VENDA = Object.freeze(['cliente_id', 'data', 'vendedor_id', 'nome_situacao', 'valor_total', 'cadastrado_em']);
/** users + sistema_usuarios → índice de vendedores. */
function montarVendedores(userDocs, sisDocs) {
  const users = new Map(userDocs.map(d => [d.id, d.data()]));
  return R.indexarVendedores(sisDocs.filter(d => d.data().carteiraComercial).map(d => ({ uid: d.id, user: users.get(d.id) || null, sistema: d.data() })));
}
/** Documentos de vendas_gc (em ordem de id) → Map(gcId → vendas). Venda sem cliente válido fica de fora. */
function agruparVendas(vendaDocs) {
  const m = new Map();
  for (const d of vendaDocs) { const v = { id: d.id, ...d.data() }; const g = normalizeGestaoClickId(v.cliente_id); if (!g) continue; if (!m.has(g)) m.set(g, []); m.get(g).push(v); }
  return m;
}
/** Conflitos: carteiras com conflito PENDENTE + irmãos citados + registro persistente (+ extras). */
function montarConflitos(carteiras, regDocs, extra) {
  const s = new Set(extra || []);
  for (const [id, c] of carteiras) if (c.conflito && c.conflito.revisao === 'PENDENTE') { s.add(id.slice(3)); (c.conflito.relacionados || []).forEach(r => s.add(String(r).slice(3))); }
  regDocs.forEach(d => (d.data().membros || []).forEach(m => s.add(String(m).replace(/^GC:/, ''))));       // B3.1-E: registro persistente de conflitos
  return s;
}
/** Devoluções controladas → Map(vendaId → tipo); TOTAL prevalece. */
function montarDevolucoes(devDocs) {
  const m = new Map(); devDocs.forEach(d => { const x = d.data(); if (m.get(String(x.vendaId)) !== 'TOTAL') m.set(String(x.vendaId), x.tipo); });
  return m;
}

async function carregarContexto(store, { hoje, conflitosGcExtra }) {
  const [cartSnap, userSnap, sisSnap, vendSnap, intSnap, cliSnap, resSnap, restrSnap, devSnap, regSnap] = await Promise.all([
    store.collection('carteira_comercial').get(), store.collection('users').get(), store.collection('sistema_usuarios').get(),
    store.collection('vendas_gc').select(...CAMPOS_VENDA).get(), store.collection('interacoes_fila').get(),
    store.collection('clientes').select('gestaoClickId').get(), store.collection('carteira_reativacoes').get(),
    store.collection('carteira_comercial_restricoes').get(), store.collection('carteira_comercial_devolucoes').get(), store.collection('identidade_conflitos').where('status', '==', 'PENDENTE').get(),
  ]);
  const vend = montarVendedores(userSnap.docs, sisSnap.docs);
  const carteiras = new Map(cartSnap.docs.map(d => [d.id, d.data()]));
  const vendasPorCliente = agruparVendas(vendSnap.docs);
  const semCarteira = [...vendasPorCliente.keys()].filter(g => !carteiras.has('GC:' + g) && R.validas(vendasPorCliente.get(g), hoje).length > 0);
  // entidade → GC (MR4_LINKED resolve pelo vínculo do CRM)
  const mr4ToGc = new Map(cliSnap.docs.filter(d => d.data().gestaoClickId).map(d => [d.id, String(d.data().gestaoClickId)]));
  const cooldowns = new Map(), followUps = new Map();
  for (const d of intSnap.docs) {
    const e = d.data(); const ent = String(e.commercialEntityId || ''); let g = null;
    if (ent.startsWith('GC_NATIVE:')) g = ent.slice(10); else if (ent.startsWith('MR4_LINKED:')) g = mr4ToGc.get(ent.slice(11)) || null;
    if (!g) continue;
    if (e.cooledUntil) { const ate = String(e.cooledUntil).slice(0, 10); if (!cooldowns.has(g) || cooldowns.get(g) < ate) cooldowns.set(g, ate); }
    if (e.nextFollowUpAt && e.estado !== 'CONCLUIDA') { const f = String(e.nextFollowUpAt).slice(0, 10); if (!followUps.has(g) || followUps.get(g) < f) followUps.set(g, f); }
  }
  const conflitosGc = montarConflitos(carteiras, regSnap.docs, conflitosGcExtra);
  const reservasExistentes = new Map(resSnap.docs.map(d => [d.data().chave, d.data()]));
  const naoContatar = new Set(restrSnap.docs.filter(d => d.data().naoContatar === true).map(d => d.id.replace(/^GC:/, '')));
  const devolucoes = montarDevolucoes(devSnap.docs);
  return { carteiras, vend, vendasPorCliente, semCarteira, cooldowns, followUps, conflitosGc, reservasExistentes, naoContatar, devolucoes,
    fontes: { naoContatar: !restrSnap.empty ? 'PRESENTE' : 'AUSENTE_OU_VAZIA', devolucoes: !devSnap.empty ? 'PRESENTE' : 'AUSENTE_OU_VAZIA', conflitosRegistrados: regSnap.size } };
}
module.exports = { carregarContexto, CAMPOS_VENDA, montarVendedores, agruparVendas, montarConflitos, montarDevolucoes };
