'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · Motor Nível 1 (obrigações e recebíveis). Função pura, determinística, auditável.
// NÃO calcula: saldo bancário, caixa disponível, capacidade de compra, runway, projeção com saldo inicial (BLOCKED).
// NÃO classifica clientes como inadimplentes: afirma apenas "título vencido" quando é fato.
const { somarDias, diffDias } = require('./canonico');

// ── STATUS (não confia em status textual; usa datas + flag + valor) ─────────
//   SETTLED   liquidado=1 com data de liquidação válida
//   OVERDUE   aberto (liquidado=0) com vencimento < hoje
//   DUE_TODAY aberto com vencimento = hoje
//   FUTURE    aberto com vencimento > hoje
//   UNKNOWN   qualquer contradição/ausência (com motivo) — melhor que inventar
function status(t, hoje) {
  if (t.source_id == null) return { status: 'UNKNOWN', motivo: 'SEM_ID' };
  if (t.final_amount_cents == null) return { status: 'UNKNOWN', motivo: 'VALOR_FINAL_INVALIDO' };
  if (t.final_amount_cents < 0) return { status: 'UNKNOWN', motivo: 'VALOR_FINAL_NEGATIVO' };
  if (t.settled_flag === true) {
    if (!t.settlement_date) return { status: 'UNKNOWN', motivo: t.settlement_date_raw ? 'DATA_LIQUIDACAO_INVALIDA' : 'LIQUIDADO_SEM_DATA' };
    return { status: 'SETTLED', motivo: null };
  }
  if (t.settled_flag === false) {
    if (t.settlement_date_raw) return { status: 'UNKNOWN', motivo: 'ABERTO_COM_DATA_LIQUIDACAO' };
    if (!t.due_date) return { status: 'UNKNOWN', motivo: t.due_date_raw ? 'VENCIMENTO_INVALIDO' : 'SEM_VENCIMENTO' };
    if (t.due_date < hoje) return { status: 'OVERDUE', motivo: null };
    if (t.due_date === hoje) return { status: 'DUE_TODAY', motivo: null };
    return { status: 'FUTURE', motivo: null };
  }
  return { status: 'UNKNOWN', motivo: 'FLAG_LIQUIDADO_INVALIDA' };
}
const ABERTO = s => s === 'OVERDUE' || s === 'DUE_TODAY' || s === 'FUTURE';

// ── BUCKETS EXCLUSIVOS (cada título aberto cai em exatamente um) ────────────
//   VENCIDO · HOJE · AMANHA · D2_A_7 · D8_A_15 · D16_A_30 · ACIMA_30
function bucketExclusivo(t, hoje) {
  const d = diffDias(hoje, t.due_date);
  if (d < 0) return 'VENCIDO';
  if (d === 0) return 'HOJE';
  if (d === 1) return 'AMANHA';
  if (d <= 7) return 'D2_A_7';
  if (d <= 15) return 'D8_A_15';
  if (d <= 30) return 'D16_A_30';
  return 'ACIMA_30';
}
// ── JANELAS ACUMULADAS (NÃO incluem vencidos; incluem hoje) ────────────────
//   A_VENCER_ATE_7D  = vencimento em [hoje, hoje+7]   ·  A_VENCER_ATE_15D  ·  A_VENCER_ATE_30D
const JANELAS = { A_VENCER_ATE_7D: 7, A_VENCER_ATE_15D: 15, A_VENCER_ATE_30D: 30 };

function novoAgregado() { return { quantidade: 0, total_cents: 0, ids: [] }; }
function somar(ag, t) { ag.quantidade++; ag.total_cents += t.final_amount_cents; ag.ids.push(t.source_id); }

/**
 * Motor de uma natureza (PAGAR ou RECEBER).
 * @param titulos canônicos já DEDUPLICADOS
 * @param hoje    'YYYY-MM-DD' comercial (Fortaleza)
 * @returns { natureza, hoje, contagem_status, buckets, janelas, vencido_mais_60d, liquidado, por_plano, por_forma, concentracao, maiores, recorrencia_candidata, desconhecidos }
 */
function calcularNatureza(titulos, natureza, hoje, opcoes = {}) {
  const topN = opcoes.topN || 10;
  const buckets = { VENCIDO: novoAgregado(), HOJE: novoAgregado(), AMANHA: novoAgregado(), D2_A_7: novoAgregado(), D8_A_15: novoAgregado(), D16_A_30: novoAgregado(), ACIMA_30: novoAgregado() };
  const janelas = Object.fromEntries(Object.keys(JANELAS).map(k => [k, novoAgregado()]));
  const vencido60 = novoAgregado();
  const abertosTotal = novoAgregado();
  // realizado (liquidações) — separado de previsto
  const liquidado = { HOJE: novoAgregado(), ULTIMOS_7D: novoAgregado(), ULTIMOS_30D: novoAgregado(), MES_CORRENTE: novoAgregado() };
  const inicioMes = hoje.slice(0, 8) + '01';
  const contagem = { OVERDUE: 0, DUE_TODAY: 0, FUTURE: 0, SETTLED: 0, UNKNOWN: 0 };
  const desconhecidos = [];
  const porPlano = {}, porForma = {}, porEntidade = {};
  const abertos = [];

  for (const t of titulos) {
    if (t.natureza !== natureza) continue;
    const s = status(t, hoje);
    contagem[s.status]++;
    if (s.status === 'UNKNOWN') { desconhecidos.push({ id: t.source_id, motivo: s.motivo }); continue; }
    const planoKey = t.chart_account.id ? t.chart_account.id + '|' + (t.chart_account.name || '') : 'SEM_PLANO';
    const formaKey = (t.payment_method.raw_name || 'SEM_FORMA') + '|' + t.payment_method.normalized;
    porPlano[planoKey] = porPlano[planoKey] || { plano_id: t.chart_account.id, plano_nome: t.chart_account.name || null, aberto: novoAgregado(), liquidado_30d: novoAgregado() };
    porForma[formaKey] = porForma[formaKey] || { raw: t.payment_method.raw_name, normalizada: t.payment_method.normalized, ambigua: t.payment_method.ambiguous, aberto: novoAgregado(), liquidado_30d: novoAgregado() };

    if (ABERTO(s.status)) {
      abertos.push(t);
      somar(abertosTotal, t);
      somar(buckets[bucketExclusivo(t, hoje)], t);
      const d = diffDias(hoje, t.due_date);
      for (const [k, n] of Object.entries(JANELAS)) if (d >= 0 && d <= n) somar(janelas[k], t);
      if (d < -60) somar(vencido60, t);
      somar(porPlano[planoKey].aberto, t);
      somar(porForma[formaKey].aberto, t);
      const ek = t.entity_id ? t.entity_type + ':' + t.entity_id : 'SEM_ENTIDADE:' + t.entity_type;
      porEntidade[ek] = porEntidade[ek] || { chave: ek, entity_type: t.entity_type, entity_id: t.entity_id, aberto: novoAgregado(), vencido: novoAgregado() };
      somar(porEntidade[ek].aberto, t);
      if (s.status === 'OVERDUE') somar(porEntidade[ek].vencido, t);
    } else {   // SETTLED
      const ds = diffDias(t.settlement_date, hoje);   // dias desde a liquidação
      if (ds === 0) somar(liquidado.HOJE, t);
      if (ds >= 0 && ds < 7) somar(liquidado.ULTIMOS_7D, t);
      if (ds >= 0 && ds < 30) { somar(liquidado.ULTIMOS_30D, t); somar(porPlano[planoKey].liquidado_30d, t); somar(porForma[formaKey].liquidado_30d, t); }
      if (t.settlement_date >= inicioMes && t.settlement_date <= hoje) somar(liquidado.MES_CORRENTE, t);
    }
  }

  const ordenaAg = (a, b) => b.aberto.total_cents - a.aberto.total_cents || String(a.chave).localeCompare(String(b.chave));
  const concentracao = Object.values(porEntidade).sort(ordenaAg).slice(0, topN)
    .map(e => ({ ...e, participacao_pct: abertosTotal.total_cents ? Math.round(e.aberto.total_cents / abertosTotal.total_cents * 1000) / 10 : 0 }));
  const maiores = [...abertos].sort((a, b) => b.final_amount_cents - a.final_amount_cents || a.source_id.localeCompare(b.source_id)).slice(0, topN)
    .map(t => ({ id: t.source_id, vencimento: t.due_date, total_cents: t.final_amount_cents, status: status(t, hoje).status, entity_type: t.entity_type, entity_id: t.entity_id, plano: t.chart_account.name }));

  return {
    natureza, hoje,
    contagem_status: contagem,
    abertos: abertosTotal,
    buckets,                 // exclusivos: somam exatamente "abertos"
    janelas,                 // acumuladas, sem vencidos
    vencido_mais_60d: vencido60,
    liquidado,               // realizado (quando/quanto a API registra a baixa); não é extrato bancário
    por_plano: Object.values(porPlano).sort((a, b) => b.aberto.total_cents - a.aberto.total_cents || String(a.plano_id).localeCompare(String(b.plano_id))),
    por_forma: Object.values(porForma).sort((a, b) => b.aberto.total_cents - a.aberto.total_cents || String(a.raw).localeCompare(String(b.raw))),
    concentracao,
    maiores,
    recorrencia_candidata: natureza === 'PAGAR' ? recorrencias(titulos.filter(t => t.natureza === 'PAGAR' && status(t, hoje).status !== 'UNKNOWN')) : [],
    desconhecidos,
  };
}

// Recorrência CANDIDATA (regra explícita, não comportamental): mesma entidade + mesmo plano de contas,
// com títulos em ≥ 3 meses de vencimento distintos. Serve para revisão humana, não para decisão.
function recorrencias(titulos) {
  const g = {};
  for (const t of titulos) {
    if (!t.due_date || !t.chart_account.id) continue;
    const k = (t.entity_id ? t.entity_type + ':' + t.entity_id : 'SEM_ENTIDADE') + '|' + t.chart_account.id;
    g[k] = g[k] || { chave: k, plano: t.chart_account.name, meses: new Set(), ids: [] };
    g[k].meses.add(t.due_date.slice(0, 7)); g[k].ids.push(t.source_id);
  }
  return Object.values(g).filter(x => x.meses.size >= 3).map(x => ({ chave: x.chave, plano: x.plano, meses_distintos: x.meses.size, ids: x.ids }))
    .sort((a, b) => b.meses_distintos - a.meses_distintos || a.chave.localeCompare(b.chave));
}

// ── Vínculo recebível → venda (determinístico) ─────────────────────────────
// Só confirma quando: descrição EXATAMENTE "Venda de nº <código>" E a venda com esse código existe E o cliente é o mesmo.
const RE_VENDA = /^Venda de nº (\d+)$/;
function vincularVenda(titulo, vendasPorCodigo) {
  const m = typeof titulo.description === 'string' ? titulo.description.match(RE_VENDA) : null;
  if (!m) return { estado: 'SEM_REFERENCIA', codigo: null };
  const v = vendasPorCodigo[m[1]];
  if (!v) return { estado: 'NAO_RESOLVIDO', codigo: m[1] };
  if (String(v.cliente_id) !== String(titulo.entity_id)) return { estado: 'CONFLITO_CLIENTE', codigo: m[1] };
  return { estado: 'CONFIRMADO', codigo: m[1], venda_id: String(v.id) };
}

module.exports = { status, bucketExclusivo, JANELAS, calcularNatureza, recorrencias, vincularVenda, RE_VENDA };
