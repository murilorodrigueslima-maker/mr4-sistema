'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.2 · RENTABILIDADE (motor determinístico; SEM IA; dinheiro em CENTAVOS inteiros).
// Camada 2 (financeira) sobre a Camada 1 (necessidade = Política 1.1, intocada). Este módulo NUNCA altera elegibilidade, quantidade,
// ABC, cobertura ou prioridade da Política 1.1: só lê o resultado dela e acrescenta custo, preço realizado, margem, capital e retorno.
// Todos os parâmetros vêm de politica.profitability (nada operacional fica espalhado aqui).
//
// FONTES COMPROVADAS (sondagem GET de 30/09/2026 — ver MR4_COMPRAS_POLICY_1_2_RENTABILIDADE_RC.md):
//   custo  — /produtos.valor_custo (CADASTRADO no ERP). Em 94 % dos produtos com compra é o custo da ÚLTIMA compra confirmada com
//            frete + impostos − desconto do cabeçalho rateados por valor ("landed"). Semântica NÃO documentada pelo ERP ⇒ tratada como
//            inferida por evidência e sempre acompanhada de confiança.
//   preço  — /vendas itens: valor_total JÁ é líquido do desconto do item; o desconto do CABEÇALHO (valor ou %) não está embutido
//            e é rateado por linha proporcionalmente ao valor da linha. Frete e serviços nunca entram na receita de produto.
//   custo histórico — /vendas itens: valor_custo gravado na venda (custo do ERP NA ÉPOCA): base do lucro bruto 30/60/90d.
const { diffDias } = require('./canonico');

const arredonda = x => Math.sign(x) * Math.round(Math.abs(x));      // meio-para-longe-de-zero, determinístico
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ehNum = v => typeof v === 'number' && Number.isFinite(v);

/** Percentil por posto mais próximo (sem interpolação): determinístico e reproduzível. */
function percentil(ordenado, p) {
  if (!ordenado.length) return null;
  const i = Math.min(ordenado.length - 1, Math.max(0, Math.ceil(p * ordenado.length) - 1));
  return ordenado[i];
}
function distribuicao(valores, ps, pctDivisor) {
  const v = valores.filter(ehNum).slice().sort((a, b) => a - b);
  const out = { n: v.length };
  for (const p of ps) out['p' + Math.round(p * pctDivisor)] = percentil(v, p);   // rótulo p10, p25… (pctDivisor vem da política)
  return out;
}

// ── LINHA DE VENDA: elegibilidade e receita líquida ────────────────────────────────────────────────────────────────────
/** Receita líquida da linha: valor_total do item (já líquido do desconto do item) − parte do desconto do cabeçalho, proporcional ao valor. */
function liquidoDaLinha(f) {
  const tot = f.line_total_cents;
  if (tot === null || tot === undefined || !(tot > 0)) return null;
  const vp = f.sale_products_total_cents, desc = f.header_discount_cents || 0;
  if (!desc || vp === null || vp === undefined || !(vp > 0)) return tot;
  return tot - arredonda(desc * tot / vp);
}
/** Regra EXPLÍCITA de elegibilidade financeira (nenhum registro é apagado; só deixa de contar no preço/lucro). */
function motivoInelegivel(f, hoje, P) {
  if (!f.product_id) return 'NO_PRODUCT';
  if (!f.counts_as_demand) return 'NOT_DEMAND';                                   // cancelada / sem baixa de estoque
  if (P.price.completed_only && f.demand_source_status !== 'COMPLETED') return 'NOT_COMPLETED';   // reservado não é receita realizada
  if (!f.date || f.date > hoje) return 'FUTURE_OR_NO_DATE';
  if (!(f.qty > 0)) return 'INVALID_QTY';
  const liq = liquidoDaLinha(f);
  if (P.price.exclude_non_positive_net && (liq === null || !(liq > 0))) return 'NON_POSITIVE_NET';   // bonificação / brinde / desconto ≥ 100 %
  return null;
}

// ── CUSTO: referência, divergência e confiança ─────────────────────────────────────────────────────────────────────────
/**
 * Confiança do custo — regra objetiva, limiares derivados da distribuição observada (producão 30/09: divergência ≤ 0,5 % em 94 % dos
 * produtos com compra, ≤ 2 % em 96 %; o restante diverge muito — mediana 5 % abaixo e cauda de +190 %).
 *   UNKNOWN : custo ausente/zero
 *   LOW     : sem compra de referência; OU cabeçalho da compra ausente (base antiga — rodar FULL); OU divergência > tolerância média;
 *             OU fornecedor da última compra marcado como importado (componentes de custo não provados)
 *   MEDIUM  : divergência ≤ tolerância média (mas > alta) OU bate com a referência porém a compra é mais antiga que o limite
 *   HIGH    : bate com o custo com rateio da última compra confirmada (≤ tolerância alta) e compra recente
 */
function classificarCusto(produto, comprasConfirmadas, hoje, P) {
  const C = P.cost, cost = produto.registered_cost_cents;
  const base = { unit_cents: null, source: C.source, confidence: 'UNKNOWN', reason: null, reference_cents: null, reference_type: null, divergence_bps: null, reference_age_days: null, last_purchase_date: null };
  if (cost === null || cost === undefined) return { ...base, reason: 'COST_MISSING' };
  if (!(cost > 0)) return { ...base, reason: 'COST_ZERO' };
  const r = { ...base, unit_cents: cost };
  const ult = comprasConfirmadas.filter(f => f.unit_cost_cents > 0 && f.issue_date)
    .sort((a, b) => b.issue_date.localeCompare(a.issue_date) || cmpId(String(b.purchase_id), String(a.purchase_id)))[0];
  if (!ult) return { ...r, confidence: 'LOW', reason: 'NO_PURCHASE_REFERENCE' };
  r.last_purchase_date = ult.issue_date; r.reference_age_days = diffDias(ult.issue_date, hoje);
  if (ult.landed_unit_cost_cents === null || ult.landed_unit_cost_cents === undefined) return { ...r, confidence: 'LOW', reason: 'PURCHASE_HEADER_DATA_MISSING', reference_type: null };
  r.reference_cents = ult.landed_unit_cost_cents; r.reference_type = C.reference;
  const d = (cost - r.reference_cents) / r.reference_cents;
  r.divergence_bps = arredonda(d * P.scale.bps);
  if (C.imported_supplier_ids.includes(ult.supplier_id)) return { ...r, confidence: 'LOW', reason: 'IMPORTED_COMPONENTS_UNPROVEN' };
  const ad = Math.abs(d);
  if (ad <= C.tolerance_high) return { ...r, confidence: r.reference_age_days <= C.high_max_reference_age_days ? 'HIGH' : 'MEDIUM', reason: r.reference_age_days <= C.high_max_reference_age_days ? 'MATCHES_LAST_PURCHASE_LANDED' : 'MATCHES_OLD_PURCHASE_LANDED' };
  if (ad <= C.tolerance_medium) return { ...r, confidence: 'MEDIUM', reason: 'SMALL_DIVERGENCE_FROM_LAST_PURCHASE_LANDED' };
  return { ...r, confidence: 'LOW', reason: 'LARGE_DIVERGENCE_FROM_LAST_PURCHASE_LANDED' };
}

// ── PREÇO REALIZADO, DESCONTO E LUCRO HISTÓRICO ────────────────────────────────────────────────────────────────────────
function janela(linhas, dias, hoje) { return linhas.filter(l => diffDias(l.f.date, hoje) < dias); }
function agregar(linhas, P) {
  let qty = 0, rev = 0, bruto = 0, baseLucro = 0, custo = 0, comCusto = 0;
  const dias = new Set();
  for (const l of linhas) {
    qty += l.f.qty; rev += l.liq; dias.add(l.f.date);
    bruto += l.f.line_gross_cents > 0 ? l.f.line_gross_cents : l.f.line_total_cents;   // bruto da linha (antes dos descontos); sem desconto de item = o próprio total
    const c = l.f.unit_cost_snapshot_cents;
    if (c > 0) { comCusto++; baseLucro += l.liq; custo += arredonda(l.f.qty * c); }
  }
  const out = { lines: linhas.length, sale_days: dias.size, qty, revenue_cents: rev, price_cents: qty > 0 ? arredonda(rev / qty) : null,
    discount_bps: bruto > 0 ? Math.max(0, arredonda((bruto - rev) * P.scale.bps / bruto)) : null,
    profit_cents: comCusto > 0 ? baseLucro - custo : null, profit_base_cents: baseLucro, cost_coverage_bps: rev > 0 ? arredonda(baseLucro * P.scale.bps / rev) : null };
  return out;
}
/** Linhas financeiras elegíveis do produto + cerca de outliers (só com linhas suficientes). Devolve também o que foi excluído e por quê. */
function linhasDoProduto(fatos, hoje, P) {
  const exc = { non_positive_net: 0, not_completed: 0, outlier: 0 };
  const ok = [];
  for (const f of fatos) {
    const m = motivoInelegivel(f, hoje, P);
    if (m === 'NON_POSITIVE_NET') { if (f.counts_as_demand && f.date && f.date <= hoje) exc.non_positive_net++; continue; }
    if (m === 'NOT_COMPLETED') { exc.not_completed++; continue; }
    if (m) continue;
    ok.push({ f, liq: liquidoDaLinha(f) });
  }
  const jan = janela(ok, P.price.window_days, hoje);
  const F = P.price.outlier_fence;
  if (jan.length >= F.min_lines) {
    const pu = jan.map(l => l.liq / l.f.qty).sort((a, b) => a - b);
    const med = pu[Math.floor((pu.length - 1) / 2)];                      // mediana (elemento central inferior): determinística
    const fora = new Set(jan.filter(l => { const u = l.liq / l.f.qty; return u < med * F.low || u > med * F.high; }));
    exc.outlier = fora.size;
    return { linhas: ok.filter(l => !fora.has(l)), excluidas: exc };
  }
  return { linhas: ok, excluidas: exc };
}

// ── PRODUTO: margem, confiança e sinais ────────────────────────────────────────────────────────────────────────────────
const RANK = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const RANK_PRECO = { FALLBACK: 1, WEAK: 2, STRONG: 3 };
const DE_RANK = ['UNAVAILABLE', 'LOW', 'MEDIUM', 'HIGH'];

function precoUnitario(agg90, produto, P) {
  if (agg90.price_cents > 0) {
    const forte = agg90.lines >= P.price.strong_min_lines && agg90.sale_days >= P.price.strong_min_sale_days;
    return { source: 'REALIZED_' + P.price.window_days + 'D', unit_cents: agg90.price_cents, quality: forte ? 'STRONG' : 'WEAK' };
  }
  if (P.price.fallback === 'REGISTERED_PRICE' && produto.sale_price_cents > 0) return { source: 'REGISTERED_FALLBACK', unit_cents: produto.sale_price_cents, quality: 'FALLBACK' };
  return { source: 'UNAVAILABLE', unit_cents: null, quality: null };
}
function dicasMargemNegativa(custo, preco, aggs, P) {
  const h = [];
  if (custo.confidence === 'LOW' || custo.confidence === 'UNKNOWN') h.push('COST_MAY_BE_WRONG_OR_STALE');
  if (preco.source === 'REGISTERED_FALLBACK') h.push('REGISTERED_PRICE_BELOW_COST');
  const dd = P.thresholds.deep_discount_bps;
  if (dd !== null && aggs[P.price.window_days].discount_bps !== null && aggs[P.price.window_days].discount_bps >= dd) h.push('DEEP_DISCOUNT');   // limiar ausente ⇒ sem dica (nunca dispara por null)
  const hist = aggs[P.price.window_days];
  if (hist.profit_cents !== null && hist.profit_cents > 0) h.push('PROFITABLE_AT_SALE_COST_COST_ROSE_SINCE');
  else if (hist.profit_cents !== null && hist.profit_cents < 0) h.push('SOLD_BELOW_COST');
  return h;
}
/** Rentabilidade de UM produto. `metrica` é o resultado da Política 1.1 (somente leitura). */
function rentabilidadeProduto({ produto, metrica, fatosVenda, comprasConfirmadas, hoje, P }) {
  const custo = classificarCusto(produto, comprasConfirmadas, hoje, P);
  const { linhas, excluidas } = linhasDoProduto(fatosVenda, hoje, P);
  const aggs = {}; for (const d of P.windows_days) aggs[d] = agregar(janela(linhas, d, hoje), P);
  const a = aggs[P.price.window_days];
  const preco = precoUnitario(a, produto, P);
  const windows = Object.fromEntries(P.windows_days.map(d => [String(d), aggs[d]]));
  const fin = { policy_version: P.policy_version, cost: custo,
    price: { source: preco.source, unit_cents: preco.unit_cents, quality: preco.quality, registered_cents: produto.sale_price_cents, lines: a.lines, sale_days: a.sale_days, qty: a.qty, discount_bps: a.discount_bps, excluded: excluidas },
    windows, unit: { profit_cents: null, margin_pct: null, markup: null },
    margin: { status: 'UNAVAILABLE', reason: null, confidence: 'UNAVAILABLE', negative: false, hints: [] }, purchase: null, decision: null };
  if (!(custo.unit_cents > 0)) fin.margin.reason = custo.reason;
  else if (!(preco.unit_cents > 0)) fin.margin.reason = 'PRICE_UNAVAILABLE';
  else {
    const lucro = preco.unit_cents - custo.unit_cents;
    fin.unit = { profit_cents: lucro, margin_pct: arredonda(lucro * P.scale.bps / preco.unit_cents) / P.scale.pct_divisor, markup: arredonda(preco.unit_cents * P.scale.ratio_digits / custo.unit_cents) / P.scale.ratio_digits };
    const conf = Math.min(RANK[custo.confidence], RANK_PRECO[preco.quality]);
    fin.margin = { status: 'AVAILABLE', reason: null, confidence: DE_RANK[conf], negative: lucro < 0, hints: lucro < 0 ? dicasMargemNegativa(custo, preco, aggs, P) : [] };
  }
  // capital hoje parado em estoque (a custo) e GMROI histórico — INFORMATIVOS, não entram na decisão: só há o estoque de HOJE (sem histórico de saldo)
  if (custo.unit_cents > 0 && metrica.raw_stock > 0) {
    const est = arredonda(metrica.raw_stock * custo.unit_cents);
    fin.inventory = { stock_cost_cents: est, gmroi_90d: a.profit_cents !== null ? arredonda(a.profit_cents * P.scale.ratio_digits / est) / P.scale.ratio_digits : null };
  }
  // economia da compra sugerida (Política 1.1 define a quantidade; aqui só se precifica)
  const qty = metrica.suggestion.suggested_qty;
  if (qty > 0) {
    const p = { qty, capital_cents: null, revenue_potential_cents: null, profit_potential_cents: null, return_on_capital: null, turnover_days: null, efficiency: null };
    if (custo.unit_cents > 0) p.capital_cents = qty * custo.unit_cents;
    if (preco.unit_cents > 0) p.revenue_potential_cents = qty * preco.unit_cents;
    if (p.capital_cents !== null && p.revenue_potential_cents !== null) {
      p.profit_potential_cents = p.revenue_potential_cents - p.capital_cents;
      p.return_on_capital = arredonda(p.profit_potential_cents * P.scale.ratio_digits / p.capital_cents) / P.scale.ratio_digits;
      // EFICIÊNCIA DO CAPITAL = retorno bruto por período-base (30 d) de capital imobilizado; dias de giro = qtd ÷ velocidade
      if (metrica.policy_velocity > 0) {
        p.turnover_days = Math.round(qty / metrica.policy_velocity * P.scale.ratio_digits) / P.scale.ratio_digits;
        p.efficiency = arredonda(p.return_on_capital * P.efficiency.base_days / p.turnover_days * P.scale.ratio_digits) / P.scale.ratio_digits;
      }
    }
    fin.purchase = p;
  }
  fin.decision = decidir(fin, metrica, P);
  return fin;
}

// ── DECISÃO: camadas necessidade × rentabilidade ───────────────────────────────────────────────────────────────────────
function faixaMargem(fin, T) {
  if (fin.margin.status !== 'AVAILABLE') return 'UNAVAILABLE';
  const m = fin.unit.margin_pct;
  if (m < 0) return 'NEGATIVE';
  if (T.margin_low_pct !== null && m < T.margin_low_pct) return 'LOW';
  if (T.margin_high_pct !== null && m >= T.margin_high_pct) return 'HIGH';
  return 'MID';
}
function atratividade(fin, T) {
  if (fin.margin.status !== 'AVAILABLE') return 'UNAVAILABLE';
  if (fin.unit.margin_pct < 0) return 'NEGATIVE';
  const e = fin.purchase && fin.purchase.efficiency;
  if (!ehNum(e)) return 'UNAVAILABLE';
  if (T.efficiency_low !== null && e < T.efficiency_low) return 'LOW';
  if (T.efficiency_high !== null && e >= T.efficiency_high) return 'HIGH';
  return 'MEDIUM';
}
function decidir(fin, metrica, P) {
  const T = P.thresholds, prio = metrica.suggestion.priority, qty = metrica.suggestion.suggested_qty;
  const mt = faixaMargem(fin, T);
  const need = qty > 0 ? (P.decision.high_need_priorities.includes(prio) ? 'HIGH' : 'LOW') : null;
  const demanda = metrica.abc_units === 'A' ? 'HIGH' : (metrica.abc_units === 'C' || metrica.abc_units === 'SEM_VENDA') ? 'LOW' : 'MID';
  const sinais = [];
  if (mt === 'NEGATIVE') sinais.push('NEGATIVE_MARGIN');
  if (fin.cost.confidence === 'UNKNOWN') sinais.push('MISSING_COST');
  if (fin.cost.confidence === 'LOW') sinais.push('LOW_COST_CONFIDENCE');
  if (demanda === 'HIGH' && (mt === 'LOW' || mt === 'NEGATIVE')) sinais.push('HIGH_DEMAND_LOW_MARGIN');
  if (demanda === 'HIGH' && mt === 'HIGH') sinais.push('HIGH_DEMAND_HIGH_MARGIN');
  if (demanda === 'LOW' && mt === 'HIGH') sinais.push('LOW_DEMAND_HIGH_MARGIN');
  let matriz = null;
  if (need) {
    if (mt === 'UNAVAILABLE') matriz = need === 'HIGH' ? 'BUY_NEED_MARGIN_UNKNOWN' : 'BUY_LOW_NEED_MARGIN_UNKNOWN';
    else if (need === 'HIGH') matriz = mt === 'HIGH' ? 'BUY_STRONG' : (mt === 'LOW' || mt === 'NEGATIVE') ? 'BUY_NEED_FLAG_MARGIN' : 'BUY_NEED';
    else matriz = mt === 'HIGH' ? 'OBSERVE_DEMAND_COVERAGE' : (mt === 'LOW' || mt === 'NEGATIVE') ? 'LOW_CAPITAL_ATTRACTIVENESS' : 'BUY_LOW_NEED';
  }
  return { need, demand: demanda, margin_tier: mt, attractiveness: atratividade(fin, T), matrix: matriz, signals: sinais };
}

// ── ARMAZENAMENTO COMPACTO: o que vai para o Firestore (sem nulos nem constantes; o motor continua com o objeto completo) ──────
const CAMPOS_JANELA = ['lines', 'qty', 'revenue_cents', 'price_cents', 'profit_cents', 'profit_base_cents'];
function compactarFin(fin) {
  const limpo = v => {
    if (Array.isArray(v)) return v.map(limpo);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (x === null || x === undefined) continue; if (Array.isArray(x) && !x.length) continue; o[k] = limpo(x); } return o; }
    return v;
  };
  const c = limpo(fin);
  if (c.cost) { delete c.cost.source; delete c.cost.reference_type; }                          // constantes (estão no resumo/política)
  if (c.price && c.price.excluded && !Object.values(c.price.excluded).some(n => n > 0)) delete c.price.excluded;
  for (const k of Object.keys(c.windows || {})) { const w = {}; for (const f of CAMPOS_JANELA) if (c.windows[k][f] !== undefined && !(f !== 'lines' && c.windows[k].lines === 0)) w[f] = c.windows[k][f]; c.windows[k] = w; }
  return c;
}

/**
 * Ficha ENXUTA para a lista da tela (compras_n0_view/custos): o pior caso (todos os produtos na visão) precisa caber com folga
 * no limite de documento. O detalhe completo (janelas 30/60/90, referência de custo, estoque a custo…) fica no bloco
 * compras_n0_custos/bloco_{bloco} (mesmas Rules de custo) e a tela o lê só ao abrir o detalhe.
 */
function fichaDaLista(fin, bloco) {
  const w90 = (fin.windows && fin.windows['90']) || {};
  const pick = (o, ks) => { const r = {}; if (o) for (const k of ks) if (o[k] !== undefined) r[k] = o[k]; return r; };
  const d = fin.decision || {};
  const ficha = { bloco, cost: pick(fin.cost, ['unit_cents', 'confidence', 'reason']), price: pick(fin.price, ['unit_cents', 'source', 'quality']), unit: fin.unit, margin: fin.margin,
    decision: pick(d, ['margin_tier', 'attractiveness', 'matrix', 'signals']) };
  if (fin.purchase) ficha.purchase = pick(fin.purchase, ['capital_cents', 'revenue_potential_cents', 'profit_potential_cents', 'return_on_capital', 'efficiency']);
  if (w90.profit_cents !== undefined) ficha.gross_profit_90d_cents = w90.profit_cents;
  return ficha;
}

// ── CARTEIRA: todos os produtos + resumo agregado ──────────────────────────────────────────────────────────────────────
function calcularFinanceiro({ produtos, metricas, fatosVenda, fatosCompra, hoje, politica }) {
  const P = politica.profitability;
  const vendasPor = new Map(), comprasPor = new Map();
  for (const f of fatosVenda) { if (!f.product_id) continue; if (!vendasPor.has(f.product_id)) vendasPor.set(f.product_id, []); vendasPor.get(f.product_id).push(f); }
  for (const f of fatosCompra) { if (f.status !== 'CONFIRMADA' || !f.product_id) continue; if (!comprasPor.has(f.product_id)) comprasPor.set(f.product_id, []); comprasPor.get(f.product_id).push(f); }
  const porId = new Map(produtos.map(p => [p.product_id, p]));
  const out = new Map();
  for (const m of metricas) out.set(m.product_id, rentabilidadeProduto({ produto: porId.get(m.product_id), metrica: m, fatosVenda: vendasPor.get(m.product_id) || [], comprasConfirmadas: comprasPor.get(m.product_id) || [], hoje, P }));
  return { porProduto: out, resumo: resumoFinanceiro(out, metricas, P) };
}
function resumoFinanceiro(mapa, metricas, P) {
  const L = [...mapa.entries()].map(([id, fin]) => ({ id, fin, m: metricas.find(x => x.product_id === id) }));
  const conta = f => L.filter(f).length;
  const comMargem = L.filter(x => x.fin.margin.status === 'AVAILABLE');
  const vendidos90 = L.filter(x => x.fin.price.source === 'REALIZED_' + P.price.window_days + 'D');
  const sug = L.filter(x => x.fin.purchase);
  const sugCompletos = sug.filter(x => x.fin.purchase.capital_cents !== null && x.fin.purchase.revenue_potential_cents !== null);
  const cap = sugCompletos.reduce((t, x) => t + x.fin.purchase.capital_cents, 0), rec = sugCompletos.reduce((t, x) => t + x.fin.purchase.revenue_potential_cents, 0);
  const unSug = sug.reduce((t, x) => t + x.fin.purchase.qty, 0), unCompletas = sugCompletos.reduce((t, x) => t + x.fin.purchase.qty, 0);
  const ps = P.distribution_percentiles, pd = P.scale.pct_divisor;
  return {
    policy_version: P.policy_version, cost_basis: P.cost.source, historical_cost_basis: 'ERP_COST_AT_SALE', estimate: true,
    products: L.length, products_with_valid_cost: conta(x => x.fin.cost.unit_cents > 0), products_without_cost: conta(x => !(x.fin.cost.unit_cents > 0)),
    cost_confidence: { HIGH: conta(x => x.fin.cost.confidence === 'HIGH'), MEDIUM: conta(x => x.fin.cost.confidence === 'MEDIUM'), LOW: conta(x => x.fin.cost.confidence === 'LOW'), UNKNOWN: conta(x => x.fin.cost.confidence === 'UNKNOWN') },
    margin_available_products: comMargem.length, negative_margin_products: comMargem.filter(x => x.fin.margin.negative).length,
    price_sources: { REALIZED: vendidos90.length, REGISTERED_FALLBACK: conta(x => x.fin.price.source === 'REGISTERED_FALLBACK'), UNAVAILABLE: conta(x => x.fin.price.source === 'UNAVAILABLE') },
    margin_distribution_pct: distribuicao(comMargem.map(x => x.fin.unit.margin_pct), ps, pd),
    margin_distribution_pct_sold_90d: distribuicao(comMargem.filter(x => vendidos90.includes(x)).map(x => x.fin.unit.margin_pct), ps, pd),
    efficiency_distribution: distribuicao(sug.map(x => x.fin.purchase.efficiency), ps, pd), return_distribution: distribuicao(sug.map(x => x.fin.purchase.return_on_capital), ps, pd),
    margin_confidence: { HIGH: conta(x => x.fin.margin.confidence === 'HIGH'), MEDIUM: conta(x => x.fin.margin.confidence === 'MEDIUM'), LOW: conta(x => x.fin.margin.confidence === 'LOW'), UNAVAILABLE: conta(x => x.fin.margin.confidence === 'UNAVAILABLE') },
    purchase: { suggested_products: sug.length, suggested_units: unSug, priced_products: sugCompletos.length, priced_units: unCompletas, unpriced_products: sug.length - sugCompletos.length,
      complete: sugCompletos.length === sug.length,
      capital_cents: cap, revenue_potential_cents: rec, gross_profit_potential_cents: rec - cap,
      weighted_margin_pct: rec > 0 ? arredonda((rec - cap) * P.scale.bps / rec) / P.scale.pct_divisor : null,
      gross_return_on_capital: cap > 0 ? arredonda((rec - cap) * P.scale.ratio_digits / cap) / P.scale.ratio_digits : null },
    signals: Object.fromEntries(P.decision.signal_names.map(s => [s, conta(x => x.fin.decision.signals.includes(s))])),
    matrix: L.reduce((o, x) => { const k = x.fin.decision.matrix; if (k) o[k] = (o[k] || 0) + 1; return o; }, {}),
  };
}

// ── SIMULADOR DE ORÇAMENTO (local, determinístico, quantidades inteiras, qtd_1_2 ≤ qtd_1_1) ────────────────────────────
const ordemPrioridade = p => ({ P1: 1, P2: 2, P3: 3, P4: 4 }[p] || 9);
// maior eficiência primeiro; quem não tem eficiência calculável vai para o fim (nunca NaN)
const eficienciaDesc = (a, b) => { const x = ehNum(a.efficiency), y = ehNum(b.efficiency); return x && y ? b.efficiency - a.efficiency : x ? -1 : y ? 1 : 0; };
const ORDENS = {
  // ordem da Política 1.1 (prioridade, maior quantidade, id)
  OPERATIONAL: (a, b) => ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || b.qty - a.qty || cmpId(a.id, b.id),
  // só retorno (mostra o que a ganância por eficiência faria: pode deixar P1 sem verba)
  EFFICIENCY: (a, b) => eficienciaDesc(a, b) || ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || cmpId(a.id, b.id),
  // P1 inteiro primeiro (ordem operacional); depois tudo por eficiência
  PROTECT_P1_THEN_EFFICIENCY: (a, b) => (a.priority === 'P1' ? 0 : 1) - (b.priority === 'P1' ? 0 : 1) || (a.priority === 'P1' ? ORDENS.OPERATIONAL(a, b) : eficienciaDesc(a, b) || ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || cmpId(a.id, b.id)),
  // camadas: mantém a prioridade operacional e ordena por eficiência DENTRO de cada prioridade
  LAYERED: (a, b) => ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || eficienciaDesc(a, b) || b.qty - a.qty || cmpId(a.id, b.id),
};
// Estratégias = lista de FASES. Cada fase escolhe itens (filtro), a ordem e o teto de unidades do item naquela fase; fases seguintes
// completam até a sugestão operacional (1.1). Nunca passa de qtd_1_1 e nunca fraciona unidade.
const pisoP1 = (i, P) => Math.min(i.qty, Math.max(1, Math.ceil((i.velocity > 0 ? i.velocity : 0) * P.budget.p1_floor_days)));
const FASES = {
  OPERATIONAL: () => [{ ordem: 'OPERATIONAL' }],
  EFFICIENCY: () => [{ ordem: 'EFFICIENCY' }],
  PROTECT_P1_THEN_EFFICIENCY: () => [{ filtro: i => i.priority === 'P1', ordem: 'OPERATIONAL' }, { ordem: 'EFFICIENCY' }],
  LAYERED: () => [{ ordem: 'LAYERED' }],
  // piso mínimo para TODO P1 (cobre `p1_floor_days` de demanda, ≥ 1 un) antes de qualquer otimização; depois camadas por eficiência
  LAYERED_P1_FLOOR: P => [{ filtro: i => i.priority === 'P1', ordem: 'OPERATIONAL', teto: i => pisoP1(i, P) }, { ordem: 'LAYERED' }],
};
function simularOrcamento(itens, orcamentoCents, estrategia, P) {
  if (!FASES[estrategia]) throw new Error('ESTRATEGIA_INVALIDA: ' + estrategia);
  if (!(Number.isInteger(orcamentoCents) && orcamentoCents >= 0)) throw new Error('ORCAMENTO_INVALIDO');
  const orcaveis = itens.filter(i => i.qty > 0 && i.cost_cents > 0), semCusto = itens.filter(i => i.qty > 0 && !(i.cost_cents > 0));
  let resto = orcamentoCents; const aloc = new Map(), sequencia = [];
  for (const fase of FASES[estrategia](P)) {
    const lista = orcaveis.filter(fase.filtro || (() => true)).sort(ORDENS[fase.ordem]);
    for (const i of lista) {
      const ja = aloc.get(i.id) || 0, teto = Math.min(i.qty, fase.teto ? fase.teto(i) : i.qty);
      const q = Math.min(teto - ja, Math.floor(resto / i.cost_cents));      // inteiro; nunca acima da sugestão operacional (1.1)
      if (q >= 1) { if (!aloc.has(i.id)) sequencia.push(i.id); aloc.set(i.id, ja + q); resto -= q * i.cost_cents; }
    }
  }
  // itens na ORDEM EM QUE FORAM FINANCIADOS (os comparadores desempatam por id ⇒ resultado independe da ordem de entrada)
  const alocados = sequencia.map(id => orcaveis.find(i => i.id === id)).map(i => ({ id: i.id, priority: i.priority, qty_1_1: i.qty, qty_1_2: aloc.get(i.id), capital_cents: aloc.get(i.id) * i.cost_cents, revenue_cents: i.price_cents > 0 ? aloc.get(i.id) * i.price_cents : null }));
  const soma = (l, f) => l.reduce((t, x) => t + (f(x) || 0), 0);
  const precificados = alocados.filter(a => a.revenue_cents !== null);
  const rec = soma(precificados, a => a.revenue_cents), capP = soma(precificados, a => a.capital_cents);
  const porPrio = {};
  for (const pr of P.decision.priorities) {
    const tot = orcaveis.filter(i => i.priority === pr), al = alocados.filter(a => a.priority === pr);
    porPrio[pr] = { products: tot.length, units_needed: soma(tot, i => i.qty), units_funded: soma(al, a => a.qty_1_2), products_fully_funded: al.filter(a => a.qty_1_2 === a.qty_1_1).length, products_unfunded: tot.length - al.length, capital_needed_cents: soma(tot, i => i.qty * i.cost_cents), capital_funded_cents: soma(al, a => a.capital_cents) };
  }
  return { strategy: estrategia, budget_cents: orcamentoCents, spent_cents: orcamentoCents - resto, left_cents: resto, products_funded: alocados.length, units_funded: soma(alocados, a => a.qty_1_2),
    units_needed: soma(orcaveis, i => i.qty), capital_needed_cents: soma(orcaveis, i => i.qty * i.cost_cents), revenue_potential_cents: rec, gross_profit_potential_cents: rec - capP,
    gross_return_on_capital: capP > 0 ? arredonda((rec - capP) * P.scale.ratio_digits / capP) / P.scale.ratio_digits : null,
    by_priority: porPrio, unbudgeted_no_cost: semCusto.map(i => i.id).sort(), items: alocados };
}
/** Itens do simulador a partir do resultado financeiro + métrica 1.1 (só produtos com sugestão). */
function itensParaSimulador(mapaFin, metricas) {
  return metricas.filter(m => m.suggestion.suggested_qty > 0).map(m => { const f = mapaFin.get(m.product_id); return { id: m.product_id, qty: m.suggestion.suggested_qty, priority: m.suggestion.priority, abc: m.abc_revenue, velocity: m.policy_velocity, cost_cents: f.cost.unit_cents, price_cents: f.price.unit_cents, efficiency: f.purchase ? f.purchase.efficiency : null }; });
}

module.exports = { fichaDaLista, compactarFin, arredonda, percentil, distribuicao, liquidoDaLinha, motivoInelegivel, classificarCusto, linhasDoProduto, agregar, rentabilidadeProduto, decidir, faixaMargem, atratividade, calcularFinanceiro, resumoFinanceiro, ORDENS, simularOrcamento, itensParaSimulador };
