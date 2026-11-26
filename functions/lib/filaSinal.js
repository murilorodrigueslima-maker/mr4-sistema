'use strict';
/**
 * INF-02 — sinalizador de atualização ao vivo do CRM / Fila Comercial: UM documento `crm_fila_versao/estado`
 * { versao, atualizadoEm }. As telas observam só este documento e chamam crmConsulta {acao:'fila'} quando `versao` muda.
 *
 * Sem dados pessoais (nem uid, nem cliente, nem coleção de origem). Escrita só por backend (Rules: write:false).
 * Os gatilhos (index.js: sinalFila*) observam as FONTES lidas pela fila — assim todo escritor é coberto (callables de
 * atendimento, geradores, jobs de reativação, callable de gestão, scripts e console), sem alterar cada um deles.
 * `vendas_gc` (histórico exibido nas reativações) NÃO tem gatilho de propósito (volume do sync): é coberto pela
 * reconciliação periódica das telas e pelo processador de vendas, que altera a reserva (e portanto sinaliza).
 */
const COL = 'crm_fila_versao', DOC = 'estado';
const IDADE_MAXIMA_MS = 10 * 60 * 1000;   // retry:true não pode insistir por dias; a reconciliação das telas cobre o resto

/** Fontes de crmConsulta {acao:'fila'} que sinalizam mudança (nome do gatilho → documento observado). */
const FONTES = Object.freeze({
  sinalFilaAtendimentos: 'interacoes_fila/{oppId}',                 // claim / resultado / liberação
  sinalFilaWorklist: 'fila_comercial/worklist',                     // geração das 06:00 (não o snapshot nem a prévia)
  sinalFilaReservas: 'carteira_reativacoes/{reservaId}',            // liberar / converter / estender / encerrar / expirar
  sinalFilaRestricoes: 'carteira_comercial_restricoes/{portfolioId}', // NÃO CONTATAR
});

/** Valor único por evento (id do evento): basta mudar. Idempotente em retentativa. */
async function sinalizarFila({ db, FieldValue, eventId, eventTime, agoraMs = Date.now() }) {
  const t = Date.parse(eventTime || '');
  if (Number.isFinite(t) && agoraMs - t > IDADE_MAXIMA_MS) return { sinalizado: false, motivo: 'EVENTO_ANTIGO' };
  await db.collection(COL).doc(DOC).set({ versao: String(eventId || agoraMs), atualizadoEm: FieldValue.serverTimestamp() });
  return { sinalizado: true };
}

/** Versão atual ('' = ainda não existe). Ler ANTES dos dados: a resposta nunca declara uma versão mais nova que o conteúdo. */
async function lerVersao(store) {
  const s = await store.collection(COL).doc(DOC).get();
  return s.exists ? String(s.data().versao || '') : '';
}

module.exports = { COL, DOC, FONTES, IDADE_MAXIMA_MS, sinalizarFila, lerVersao };
