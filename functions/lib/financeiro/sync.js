'use strict';
// AGENTE FINANCEIRO MR4 — Fase 2 · sincronização (FULL). GestãoClick SOMENTE GET. Nenhum dado pessoal em log.
//
// FULL vs incremental: a API só filtra por "data efetiva" (liquidação se pago, vencimento se aberto) — não há filtro por modificação,
// e uma baixa/alteração move o título de janela. Um incremental perderia baixas e mudanças de vencimento → RELIABLE_INCREMENTAL_AVAILABLE=NO.
// Portanto: UMA Function agendada que roda FULL (≈ 780 GET, ≈ 8–10 min).
const K = require('./canonico');
const F = require('./fetch');
const A = require('./agregados');
const P = require('./publicacao');

const INICIO_TITULOS = '2015-01-01';
const INICIO_COMERCIAL = '2021-01-01';
const HORIZONTE_DIAS = 730;

/** Remove de mensagens de erro qualquer coisa que possa ser dado pessoal ou id longo. */
function sanitizarErro(e) {
  const m = String((e && (e.codigo || e.message)) || e || 'ERRO').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\d{6,}/g, '#').replace(/\s+/g, ' ');
  return m.slice(0, 160);
}
const novoRunId = (agora = new Date()) => 'fin-' + agora.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 8);

/** Executa uma sincronização FULL. Retorna { ok, ... } e nunca lança para o agendador. */
async function executarSyncFinanceiro({ cli, db, agora = new Date(), runId = novoRunId(agora), gatilho = 'AGENDADO', log = () => {}, fetchMod = F, relogio = () => new Date() }) {
  const t0 = relogio().getTime();
  const evento = (ev, extra = {}) => log({ componente: 'financeiroSync', evento: ev, run_id: runId, tipo: 'FULL', gatilho, ...extra });
  evento('inicio');
  let lock;
  try { lock = await P.adquirirLock(db, { runId, tipo: 'FULL', agora }); } catch (e) { evento('erro', { fase: 'lock', erro: sanitizarErro(e) }); return { ok: false, motivo: 'LOCK_ERRO' }; }
  if (!lock.ok) { evento('ignorado', { motivo: lock.motivo }); return { ok: false, motivo: lock.motivo }; }
  if (lock.recuperado) evento('lock_recuperado');
  const geracao = A.novaGeracao(agora);
  const hoje = K.dataComercial(agora);
  try {
    const fim = K.somarDias(hoje, HORIZONTE_DIAS);
    const batida = async () => { await P.renovarLock(db, runId, relogio()); };
    const refs = await fetchMod.buscarReferencias(cli);
    const ap = await fetchMod.buscarTitulos(cli, 'pagamentos', { inicio: INICIO_TITULOS, fim }); await batida();
    const ar = await fetchMod.buscarTitulos(cli, 'recebimentos', { inicio: INICIO_TITULOS, fim }); await batida();
    const ix = await fetchMod.buscarIndicesComerciais(cli, { inicio: INICIO_COMERCIAL, fim: hoje }); await batida();
    const syncedAt = agora.toISOString();
    const canon = [...ap.titulos.map(b => K.mapearTitulo(b, 'PAGAR', { formasPorId: refs.formasPorId, syncedAt })), ...ar.titulos.map(b => K.mapearTitulo(b, 'RECEBER', { formasPorId: refs.formasPorId, syncedAt }))];
    const agrupa = (lista, campo) => lista.reduce((a, x) => { if (x.codigo != null) (a[x.codigo] = a[x.codigo] || []).push(x); return a; }, {});
    const vendasPorCodigo = agrupa(ix.vendas), comprasPorCodigo = agrupa(ix.compras);
    const g = A.construirGeracao({ canon, vendasPorCodigo, comprasPorCodigo, agora, geracao, hoje });
    const estatisticas = { run_id: runId, geracao, titulos_pagar: ap.titulos.length, titulos_receber: ar.titulos.length, paginas: ap.estatisticas.paginas + ar.estatisticas.paginas, indices: ix.estatisticas, gets: cli.chamadas(), retries: cli.retries ? cli.retries() : 0, janela: { inicio: INICIO_TITULOS, fim } };
    const pub = await P.publicarGeracao(db, { geracao, resumo: g.resumo, entidades: g.entidades, fatias: g.fatias, runId, agora, estatisticas, aoProgredir: batida });
    const dur = relogio().getTime() - t0;
    evento('fim', { status: 'OK', geracao, duracao_ms: dur, paginas: estatisticas.paginas, titulos: estatisticas.titulos_pagar + estatisticas.titulos_receber, gets: estatisticas.gets, retries: estatisticas.retries, documentos: pub.ids.length, removidos: pub.removidos });
    return { ok: true, geracao, estatisticas, resumo: g.resumo };
  } catch (e) {
    const dur = relogio().getTime() - t0;
    try { const m = await db.collection(P.COL.ptr).doc('meta').get(); await db.collection(P.COL.ptr).doc('meta').set({ ...(m.exists ? m.data() : {}), ultima_tentativa: agora.toISOString(), ultima_tentativa_ok: false, erro: sanitizarErro(e), run_id_erro: runId }); } catch (_) { /* sem meta: já registrado no log */ }
    evento('fim', { status: 'ERRO', erro: sanitizarErro(e), duracao_ms: dur, gets: cli.chamadas(), retries: cli.retries ? cli.retries() : 0 });
    return { ok: false, motivo: 'ERRO', erro: sanitizarErro(e) };
  } finally {
    try { await P.liberarLock(db, runId); } catch (_) { /* a lease expira sozinha */ }
  }
}
module.exports = { INICIO_TITULOS, INICIO_COMERCIAL, HORIZONTE_DIAS, sanitizarErro, novoRunId, executarSyncFinanceiro };
