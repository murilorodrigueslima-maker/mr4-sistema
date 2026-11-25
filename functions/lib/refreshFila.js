'use strict';
/**
 * Fila de "BLOCO DESATUALIZADO" (processamento direcionado por webhook). Estratégia temporária e segura:
 * o webhook NÃO soma valores nem altera agregados por evento (evita contagem em dobro, estorno/cancelamento/ordem trocada);
 * ele só marca quais BLOCOS do sync ficaram desatualizados; o Cloud Run Job relê SÓ esses blocos (idempotente: o resultado é sempre o
 * estado atual da API) e republica. Eventos duplicados/fora de ordem apenas marcam o mesmo bloco ⇒ uma releitura cobre todos (coalescência).
 * Documento único `gc_refresh_fila/lote` { blocos: { <bloco>: { sujoDesdeMs, eventos } }, atualizadoMs }.
 */
const COL = 'gc_refresh_fila', DOC = 'lote';
const BLOCOS_POR_EVENTO = Object.freeze({
  'venda.cadastrada': ['vendas', 'pedidos', 'perfil360'],
  'venda.situacao_alterada': ['vendas', 'pedidos', 'perfil360'],   // inclui cancelamento (mudança de situação)
  'recebimento.baixado': ['financeiro'], 'recebimento.estornado': ['financeiro'],
  'pagamento.baixado': ['financeiro'], 'pagamento.estornado': ['financeiro'],
});
const BLOCOS_VALIDOS = ['vendas', 'estoque', 'financeiro', 'pedidos', 'catalogo', 'perfil360'];

/** Marca os blocos afetados pelo evento como desatualizados (idempotente por natureza). Devolve a lista marcada. */
async function marcarSujo({ db, evento, agoraMs = Date.now() }) {
  const blocos = BLOCOS_POR_EVENTO[evento] || []; if (!blocos.length) return [];
  const ref = db.collection(COL).doc(DOC);
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : { blocos: {} }; const b = { ...(d.blocos || {}) };
    for (const nome of blocos) b[nome] = { sujoDesdeMs: b[nome] ? b[nome].sujoDesdeMs : agoraMs, eventos: (b[nome] ? b[nome].eventos : 0) + 1 };
    tx.set(ref, { blocos: b, atualizadoMs: agoraMs });
  });
  return blocos;
}

/** Reclama (e zera) os blocos sujos para esta execução. Se a execução falhar, o próximo sync completo/de 2 h reconcilia (polling é a rede de segurança). */
async function reclamarSujos({ db, agoraMs = Date.now() }) {
  const ref = db.collection(COL).doc(DOC); let blocos = [];
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : null; if (!d || !d.blocos) return;
    blocos = Object.keys(d.blocos).filter(b => BLOCOS_VALIDOS.includes(b));
    if (blocos.length) tx.set(ref, { blocos: {}, atualizadoMs: agoraMs, ultimaReclamacaoMs: agoraMs, ultimosBlocos: blocos });
  });
  return blocos;
}

async function temSujos({ db }) { const s = await db.collection(COL).doc(DOC).get(); return !!(s.exists && s.data().blocos && Object.keys(s.data().blocos).length); }

/**
 * Efeito OPERACIONAL do webhook: só no modo ATIVO (que exige aprovação do proprietário e nunca é o padrão). Em DESLIGADO/RECEPCAO/SOMBRA
 * a fila não é tocada. `dispararJob` inicia o Cloud Run Job em MODO_SUJOS (a trava compartilhada garante uma execução por vez).
 */
async function aplicarModo({ db, modo, evento, dispararJob, dispararFinanceiro, agoraMs = Date.now() }) {
  if (modo !== 'ATIVO') return { efeito: false, blocos: [] };
  const blocos = await marcarSujo({ db, evento, agoraMs });
  if (blocos.length) { try { await dispararJob(); } catch (_) { /* inócuo: os blocos continuam marcados; o sync de 2 h reconcilia */ } }
  let financeiroN1 = null;
  if (dispararFinanceiro) { try { financeiroN1 = (await require('./financeiroGatilho').solicitar({ db, evento, disparar: dispararFinanceiro, agoraMs })).acao; } catch (_) { financeiroN1 = 'FALHA'; } }
  return financeiroN1 === null ? { efeito: blocos.length > 0, blocos } : { efeito: blocos.length > 0, blocos, financeiroN1 };
}

module.exports = { aplicarModo, COL, DOC, BLOCOS_POR_EVENTO, BLOCOS_VALIDOS, marcarSujo, reclamarSujos, temSujos };
