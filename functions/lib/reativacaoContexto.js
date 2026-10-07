'use strict';
/** B3 — carrega (SOMENTE LEITURA) o contexto que o planejador precisa. Nenhuma escrita. */
const R = require('./reativacao120');
const { normalizeGestaoClickId } = require('./commercialIdentity');

async function carregarContexto(store, { hoje, conflitosGcExtra }) {
  const [cartSnap, userSnap, sisSnap, vendSnap, intSnap, cliSnap, resSnap, restrSnap, devSnap] = await Promise.all([
    store.collection('carteira_comercial').get(), store.collection('users').get(), store.collection('sistema_usuarios').get(),
    store.collection('vendas_gc').select('cliente_id', 'data', 'vendedor_id', 'nome_situacao', 'valor_total').get(), store.collection('interacoes_fila').get(),
    store.collection('clientes').select('gestaoClickId').get(), store.collection('carteira_reativacoes').get(),
    store.collection('carteira_comercial_restricoes').get(), store.collection('carteira_comercial_devolucoes').get(),
  ]);
  const users = new Map(userSnap.docs.map(d => [d.id, d.data()]));
  const configs = sisSnap.docs.filter(d => d.data().carteiraComercial).map(d => ({ uid: d.id, user: users.get(d.id) || null, sistema: d.data() }));
  const vend = R.indexarVendedores(configs);
  const carteiras = new Map(cartSnap.docs.map(d => [d.id, d.data()]));
  const vendasPorCliente = new Map();
  for (const d of vendSnap.docs) { const v = { id: d.id, ...d.data() }; const g = normalizeGestaoClickId(v.cliente_id); if (!g) continue; if (!vendasPorCliente.has(g)) vendasPorCliente.set(g, []); vendasPorCliente.get(g).push(v); }
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
  // conflitos: carteiras EM_REVISAO + irmãos citados + (opcional) grupos só-sem-carteira detectados fora (GC)
  const conflitosGc = new Set(conflitosGcExtra || []);
  for (const [id, c] of carteiras) if (c.conflito && c.conflito.revisao === 'PENDENTE') { conflitosGc.add(id.slice(3)); (c.conflito.relacionados || []).forEach(r => conflitosGc.add(String(r).slice(3))); }
  const reservasExistentes = new Map(resSnap.docs.map(d => [d.data().chave, d.data()]));
  const naoContatar = new Set(restrSnap.docs.filter(d => d.data().naoContatar === true).map(d => d.id.replace(/^GC:/, '')));
  const devolucoes = new Map(devSnap.docs.map(d => [String(d.data().vendaId), d.data().tipo]));
  return { carteiras, vend, vendasPorCliente, semCarteira, cooldowns, followUps, conflitosGc, reservasExistentes, naoContatar, devolucoes,
    fontes: { naoContatar: !restrSnap.empty ? 'PRESENTE' : 'AUSENTE_OU_VAZIA', devolucoes: !devSnap.empty ? 'PRESENTE' : 'AUSENTE_OU_VAZIA' } };
}
module.exports = { carregarContexto };
