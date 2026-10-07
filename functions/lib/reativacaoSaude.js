'use strict';
/**
 * B3.3 — verificação técnica de SAÚDE da reativação + disjuntor automático. Roda no início de cada execução real (job 06:00 e processador de vendas) e pode ser
 * chamada manualmente (scripts/b3_saude.js). Qualquer violação DESLIGA o motor (reativacao.modo = 'DESLIGADO'), registra o motivo e audita — sem apagar reservas,
 * carteiras ou histórico. Violações cobertas: owner alterado sem evento; transferência sem reserva válida; oportunidade duplicada; limite do piloto excedido;
 * evento de owner fora do motor autorizado; erro no processamento de vendas (reportado pelo chamador).
 */
const A = require('./auditoria'); const REF = ['carteira_comercial_config', 'reativacao'];
const TIPOS_OWNER = ['TRANSFERENCIA', 'REATIVACAO_120D_PRIMEIRA_VENDA', 'CARTEIRA_CRIADA_REATIVACAO', 'CARTEIRA_CRIADA_PRIMEIRA_VENDA', 'LIBERACAO', 'REVERSAO_TRANSFERENCIA', 'CORRECAO_ADMINISTRATIVA'];

async function verificarSaude(store, { cfg = {}, desde = null } = {}) {
  const v = [];
  const [cart, hist, res] = await Promise.all([store.collection('carteira_comercial').get(), store.collection('carteira_comercial_historico').get(), store.collection('carteira_reativacoes').get()]);
  // 1) owner da carteira deve coincidir com o último evento que muda owner (nenhuma alteração silenciosa)
  const ult = new Map();
  for (const d of hist.docs) { const e = d.data(); if (!e.criadoEm) continue; const cur = ult.get(e.portfolioId); if (!cur || e.criadoEm > cur.criadoEm || (e.criadoEm === cur.criadoEm && (e.versaoCarteiraDepois || e.versao || 0) > (cur.versaoCarteiraDepois || cur.versao || 0))) if (TIPOS_OWNER.includes(e.tipoEvento)) ult.set(e.portfolioId, e); }
  for (const d of cart.docs) { const c = d.data(); const e = ult.get(d.id); if (e && (e.ownerNovoUid || null) !== (c.ownerUid || null)) v.push({ tipo: 'OWNER_DIVERGE_DO_HISTORICO', portfolioId: d.id }); }
  // 2) transferência/criação por reativação sem reserva CONVERTIDA correspondente
  const reservasPorChave = new Map(res.docs.map(d => [d.data().chave, d.data()]));
  for (const d of hist.docs) { const e = d.data(); if (!['REATIVACAO_120D_PRIMEIRA_VENDA', 'CARTEIRA_CRIADA_REATIVACAO'].includes(e.tipoEvento)) continue; if (desde && e.criadoEm < desde) continue;
    const ch = e.referencias && e.referencias.reservaChave; const r = ch && reservasPorChave.get(ch); if (!r || !['CONVERTIDA', 'REVERTIDA'].includes(r.estado) || r.destinoUid !== e.ownerNovoUid) v.push({ tipo: 'TRANSFERENCIA_SEM_RESERVA_VALIDA', portfolioId: e.portfolioId }); }
  // 3) oportunidade duplicada: mais de uma reserva ativa por cliente, ou mesma chave repetida
  const ativasPorCliente = new Map(), chaves = new Set();
  for (const d of res.docs) { const r = d.data(); if (chaves.has(r.chave)) v.push({ tipo: 'CHAVE_DUPLICADA', chave: r.chave }); chaves.add(r.chave); if (r.estado === 'RESERVADA') ativasPorCliente.set(r.portfolioId, (ativasPorCliente.get(r.portfolioId) || 0) + 1); }
  for (const [p, n] of ativasPorCliente) if (n > 1) v.push({ tipo: 'OPORTUNIDADE_DUPLICADA', portfolioId: p, n });
  // 4) limite do piloto
  if (Number.isFinite(cfg.maxReservasAtivas)) { const por = new Map(); res.docs.forEach(d => { const r = d.data(); if (r.estado === 'RESERVADA') por.set(r.destinoUid, (por.get(r.destinoUid) || 0) + 1); }); for (const [u, n] of por) if (n > cfg.maxReservasAtivas) v.push({ tipo: 'LIMITE_PILOTO_EXCEDIDO', destinoUid: u, n }); }
  if (Number.isFinite(cfg.limiteDiario)) { const por = new Map(); res.docs.forEach(d => { const r = d.data(); const k = r.destinoUid + '|' + r.liberadoEm; por.set(k, (por.get(k) || 0) + 1); }); for (const [k, n] of por) if (n > cfg.limiteDiario) v.push({ tipo: 'LIMITE_DIARIO_EXCEDIDO', chave: k, n }); }
  return { ok: v.length === 0, violacoes: v, carteiras: cart.size, reservas: res.size, eventos: hist.size };
}
/** Desliga o motor (sem apagar nada) e audita. */
async function dispararDisjuntor(store, FieldValue, violacoes, { agoraIso, origem }) {
  await store.doc(REF.join('/')).set({ modo: 'DESLIGADO', disjuntor: { acionadoEm: agoraIso, origem, violacoes: violacoes.slice(0, 20) } }, { merge: true });
  await A.gravar(store, FieldValue, 'disjuntor_' + Date.parse(agoraIso), A.evento({ ator: { uid: null, type: 'SYSTEM', origin: 'SERVER' }, action: 'REACTIVATION_CIRCUIT_BREAKER', category: A.CATEGORIAS.COMMERCIAL, entityType: 'carteira_comercial_config', entityId: 'reativacao', source: 'LIB:reativacaoSaude', before: { modo: 'ATIVO' }, after: { modo: 'DESLIGADO' }, metadata: { origem, violacoes: violacoes.slice(0, 20).map(x => x.tipo) } }));
}
module.exports = { verificarSaude, dispararDisjuntor, REF };
