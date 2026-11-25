'use strict';
/**
 * Gatilho do Financeiro (fin_n1) por evento de recebimento/pagamento — SÓ no modo ATIVO do webhook (aprovação do proprietário).
 * O evento nunca altera valores: apenas pede ao `financeiroSync` EXISTENTE (sync completo, com geração + ponteiro e trava própria) que rode antes das 3 h.
 * Coalescência: no máximo 1 pedido a cada INTERVALO_MIN_MS (30 min); eventos no intervalo ficam como `pendente` e são cobertos pela próxima
 * execução (pedido seguinte ou a de 3 h, que continua como reconciliação). Falha ao disparar é inócua (nada é perdido; o agendamento de 3 h cobre).
 * Controle em `gc_refresh_fila/financeiro_n1` (backend). Não mexe em fin_n1*, nem em permissões do Financeiro.
 */
const COL = 'gc_refresh_fila', DOC = 'financeiro_n1';
const INTERVALO_MIN_MS = 30 * 60 * 1000;
const EVENTOS = ['recebimento.baixado', 'recebimento.estornado', 'pagamento.baixado', 'pagamento.estornado'];

async function solicitar({ db, evento, disparar, agoraMs = Date.now(), intervaloMs = INTERVALO_MIN_MS }) {
  if (!EVENTOS.includes(evento)) return { acao: 'IGNORADO' };
  const ref = db.collection(COL).doc(DOC); let decisao = 'PENDENTE';
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : {};
    if (!d.ultimoPedidoMs || agoraMs - d.ultimoPedidoMs >= intervaloMs) { decisao = 'DISPARAR'; tx.set(ref, { ultimoPedidoMs: agoraMs, pendente: false, eventos: (d.eventos || 0) + 1 }); }
    else tx.set(ref, { ...d, pendente: true, eventos: (d.eventos || 0) + 1 });
  });
  if (decisao !== 'DISPARAR') return { acao: 'COALESCIDO' };
  try { await disparar(); return { acao: 'DISPARADO' }; } catch (_) { return { acao: 'FALHA_DISPARO' }; }   // o sync de 3 h reconcilia
}
module.exports = { solicitar, EVENTOS, INTERVALO_MIN_MS, COL, DOC };
