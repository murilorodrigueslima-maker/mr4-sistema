'use strict';
/**
 * Fila de "BLOCO DESATUALIZADO" (processamento direcionado por webhook). Estratégia temporária e segura:
 * o webhook NÃO soma valores nem altera agregados por evento (evita contagem em dobro, estorno/cancelamento/ordem trocada);
 * ele só marca quais BLOCOS do sync ficaram desatualizados; o Cloud Run Job relê SÓ esses blocos (idempotente: o resultado é sempre o
 * estado atual da API) e republica. Eventos duplicados/fora de ordem apenas marcam o mesmo bloco ⇒ uma releitura cobre todos (coalescência).
 * Documento único `gc_refresh_fila/lote` { blocos: { <bloco>: { sujoDesdeMs, eventos } }, emAndamento: { <bloco>: { sujoDesdeMs, eventos, execucao } }, atualizadoMs }.
 * `blocos` = avisos ainda não reclamados; `emAndamento` = reclamados e ainda SEM publicação confirmada (execução em curso, falha ou queda).
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
    const s = await tx.get(ref); const d = s.exists ? s.data() : {}; const b = { ...(d.blocos || {}) };
    for (const nome of blocos) b[nome] = { sujoDesdeMs: b[nome] ? b[nome].sujoDesdeMs : agoraMs, eventos: (b[nome] ? b[nome].eventos : 0) + 1 };
    tx.set(ref, { ...d, blocos: b, atualizadoMs: agoraMs });   // preserva o que está em andamento
  });
  return blocos;
}

/**
 * Reclama para esta execução os blocos com aviso novo E os que ficaram sem publicação confirmada. Nada é descartado aqui: eles passam
 * para `emAndamento` e só saem por `confirmarPublicados`. Se a execução falhar, a pendência entra na próxima execução direcionada.
 */
async function reclamarSujos({ db, agoraMs = Date.now(), execucao = String(agoraMs) }) {
  const ref = db.collection(COL).doc(DOC); let blocos = [];
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : null; if (!d) return;
    const antes = d.emAndamento || {}, novos = d.blocos || {};
    blocos = [...new Set([...Object.keys(antes), ...Object.keys(novos)])].filter(b => BLOCOS_VALIDOS.includes(b));
    if (!blocos.length) return;
    const emAndamento = {};
    for (const b of blocos) {
      const partes = [antes[b], novos[b]].filter(Boolean);
      emAndamento[b] = { sujoDesdeMs: Math.min(...partes.map(p => p.sujoDesdeMs || agoraMs)), eventos: partes.reduce((n, p) => n + (p.eventos || 0), 0), execucao };
    }
    tx.set(ref, { blocos: {}, emAndamento, atualizadoMs: agoraMs, ultimaReclamacaoMs: agoraMs, ultimosBlocos: blocos });
  });
  return blocos;
}

/** Baixa a pendência dos blocos PUBLICADOS por esta execução. Aviso que chegou durante a execução está em `blocos` e não é tocado. */
async function confirmarPublicados({ db, blocos, execucao, agoraMs = Date.now() }) {
  const ref = db.collection(COL).doc(DOC);
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) return; const d = s.data(); const em = { ...(d.emAndamento || {}) };
    const baixar = blocos.filter(b => em[b] && em[b].execucao === execucao); if (!baixar.length) return;
    for (const b of baixar) delete em[b];
    tx.set(ref, { ...d, emAndamento: em, atualizadoMs: agoraMs });
  });
}

/** Há aviso NOVO (ainda não reclamado)? É o que justifica disparar outra execução; falha pendente não gera disparo em laço. */
async function temSujos({ db }) { const s = await db.collection(COL).doc(DOC).get(); return !!(s.exists && s.data().blocos && Object.keys(s.data().blocos).length); }

/**
 * Efeito OPERACIONAL do webhook: só no modo ATIVO (que exige aprovação do proprietário e nunca é o padrão). Em DESLIGADO/RECEPCAO/SOMBRA
 * a fila não é tocada. `dispararJob` inicia o Cloud Run Job em MODO_SUJOS (a trava compartilhada garante uma execução por vez).
 */
async function aplicarModo({ db, modo, evento, eventoMs, dispararJob, dispararFinanceiro, agoraMs = Date.now() }) {
  if (modo !== 'ATIVO') return { efeito: false, blocos: [] };
  const blocos = await marcarSujo({ db, evento, agoraMs });
  if (blocos.length) { try { await dispararJob(); } catch (_) { /* inócuo: os blocos continuam marcados; o sync de 2 h reconcilia */ } }
  let financeiroN1 = null;
  if (dispararFinanceiro) { try { financeiroN1 = (await require('./financeiroGatilho').solicitar({ db, evento, disparar: dispararFinanceiro, agoraMs, eventoMs })).acao; } catch (_) { financeiroN1 = 'FALHA'; } }
  return financeiroN1 === null ? { efeito: blocos.length > 0, blocos } : { efeito: blocos.length > 0, blocos, financeiroN1 };
}

module.exports = { aplicarModo, COL, DOC, BLOCOS_POR_EVENTO, BLOCOS_VALIDOS, marcarSujo, reclamarSujos, confirmarPublicados, temSujos };
