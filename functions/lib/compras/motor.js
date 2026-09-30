'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Motor determinístico por produto. Sem IA. Tudo rastreável.
// Limitações estruturais (comprovadas): sem histórico de saldo de estoque → ausência de venda NÃO prova ausência de
// demanda; sem data de recebimento → SEM lead time (a sugestão é POLÍTICA DE COBERTURA, não ponto de pedido);
// custo = custo CADASTRADO (baixa confiança) → NÃO entra em elegibilidade, prioridade nem quantidade.
//
// Todos os parâmetros vêm da política versionada (politica.js). Este arquivo não contém números operacionais.
const { somarDias, diffDias } = require('./canonico');
const { POLITICA_VIGENTE, CENARIOS_EXPERIMENTAIS } = require('./politica');

const RULES_VERSION = 'ce-p1.0-1';

/** Parâmetros planos derivados de UMA política (nomes internos estáveis). */
function paramsDe(pol) {
  const s = pol.velocity.signal;
  return {
    POLICY_VERSION: pol.policy_version,
    JANELAS_DIAS: pol.windows_days,
    ABC_BASE: pol.abc.primary, ABC_SECUNDARIA: pol.abc.secondary, ABC_CORTE_A: pol.abc.cut_a, ABC_CORTE_B: pol.abc.cut_b, ABC_JANELA: pol.abc.window_days,
    ALVO_DIAS: pol.target_days,
    JANELA_DEMANDA: pol.demand.window_days, DEMANDA_MINIMA: pol.demand.minimum_units,
    JANELA_VELOCIDADE: pol.velocity.window_days, JANELA_SINAL: pol.velocity.signal_window_days,
    ACELERACAO_COMPORTAMENTO: pol.velocity.acceleration_behavior,
    VELOCIDADE_MIN_UNIDADES_180D: s.min_units_2x_window, VELOCIDADE_MIN_DIAS_OBSERVADOS: s.min_days_observed, ACELERACAO_MIN_UNIDADES_SINAL: s.accel_min_units_signal_window,
    ACELERACAO_30_VS_90: s.accel_30_vs_90, ACELERACAO_90_VS_ANTERIOR: s.accel_90_vs_prev,
    DESACELERACAO_30_VS_90: s.decel_30_vs_90, DESACELERACAO_90_VS_ANTERIOR: s.decel_90_vs_prev,
    PAROU_MIN_UNIDADES_ANTES: pol.velocity.stopped.min_units_before, PAROU_JANELA_SEM_VENDA: pol.velocity.stopped.no_sale_days, PAROU_JANELA_ANTES: pol.velocity.stopped.lookback_days,
    FAIXAS_DEMANDA_RUPTURA: pol.stockout_demand_bands_days, JANELAS_VENDAS_EXPLICACAO: pol.explanation_sales_windows_days,
    REGRA_PRODUTO_NOVO: pol.new_product.proven_demand || null,   // ausente na Política 1.0 → exceção desativada
    PRODUTO_NOVO_DIAS: pol.new_product.window_days,
    COBERTURA_CRITICA_DIAS: pol.coverage_indicators.critical_below_days, COBERTURA_BAIXA_DIAS: pol.coverage_indicators.low_below_days, COBERTURA_EXCESSO_DIAS: pol.coverage_indicators.excess_above_days,
    COBERTURA_MINIMA_CALCULADA_DIAS: pol.calculated_min_stock_days,
    ARREDONDAMENTO: pol.rounding,
    JANELA_DEMANDA_RECENTE_PRIORIDADE: pol.priority.recent_demand_window_days,
    FAIXAS_PARADO: pol.dead_stock_bands_days,
    CUSTO_TOLERANCIA_RELATIVA: pol.cost.known_tolerance, CUSTO_IDADE_MAX_DIAS: pol.cost.known_max_age_days,
  };
}
const PARAMS = { ...paramsDe(POLITICA_VIGENTE), CENARIOS: CENARIOS_EXPERIMENTAIS };

/** Agrega os fatos por produto (dedupe por venda+linha e por compra+linha). */
function indexarFatos(vendas, compras) {
  const v = new Map(), c = new Map(), vistosV = new Set(), vistosC = new Set();
  let dupV = 0, dupC = 0;
  for (const f of vendas) {
    const k = f.sale_id + '#' + f.line;
    if (vistosV.has(k)) { dupV++; continue; }
    vistosV.add(k);
    if (!f.product_id) continue;
    (v.get(f.product_id) || v.set(f.product_id, []).get(f.product_id)).push(f);
  }
  for (const f of compras) {
    const k = f.purchase_id + '#' + f.line;
    if (vistosC.has(k)) { dupC++; continue; }
    vistosC.add(k);
    if (!f.product_id) continue;
    (c.get(f.product_id) || c.set(f.product_id, []).get(f.product_id)).push(f);
  }
  return { vendasPorProduto: v, comprasPorProduto: c, duplicatas: { vendas: dupV, compras: dupC } };
}

function faixaParado(dias, P = PARAMS) { for (const f of P.FAIXAS_PARADO) if (dias >= f) return f + '+'; return null; }
const r3 = x => Math.round(x * 1000) / 1000;
const EPS = 1e-9;

/**
 * Sinal de velocidade com limiares explícitos (fato, não previsão).
 * u30 = unidades na janela de SINAL, u90 = na janela de VELOCIDADE, u180 = em 2× a janela de velocidade.
 */
function sinalVelocidade({ u30, u90, u180, diasObservado, novo }, P = PARAMS) {
  const S = P.JANELA_SINAL, V = P.JANELA_VELOCIDADE;
  if (novo || diasObservado === null || diasObservado < P.VELOCIDADE_MIN_DIAS_OBSERVADOS || u180 < P.VELOCIDADE_MIN_UNIDADES_180D) return 'INSUFFICIENT_HISTORY';
  const t30 = u30 / S, t90 = u90 / V, tAnt = (u180 - u90) / V;
  const anteriorCompleto = diasObservado >= 2 * V;
  if ((u30 >= P.ACELERACAO_MIN_UNIDADES_SINAL && t30 >= P.ACELERACAO_30_VS_90 * t90) || (anteriorCompleto && u90 >= P.ACELERACAO_MIN_UNIDADES_SINAL && t90 >= P.ACELERACAO_90_VS_ANTERIOR * tAnt && t30 >= t90)) return 'RECENT_ACCELERATION';
  if (t30 <= P.DESACELERACAO_30_VS_90 * t90 || (anteriorCompleto && tAnt > 0 && t90 <= P.DESACELERACAO_90_VS_ANTERIOR * tAnt)) return 'RECENT_DECELERATION';
  return 'STABLE';
}

/**
 * Evidência de demanda de PRODUTO NOVO (só para produto dentro da janela de novo). Fatos, sem regra.
 * idade = dias desde a primeira evidência (1ª venda, 1ª compra confirmada ou cadastro confiável).
 */
function evidenciaProdutoNovo(demanda, diasObservado, avg, P = PARAMS, ativo = true) {
  const soma = f => demanda.filter(f).reduce((s, x) => s + x.qty, 0);
  const unidades = soma(() => true);
  const idade = diasObservado === null ? null : diasObservado;
  return {
    age_days: idade,
    units_since_first_evidence: unidades,
    distinct_sale_days: new Set(demanda.map(f => f.date)).size,
    completed_units: soma(f => (f.demand_source_status || 'COMPLETED') === 'COMPLETED'),
    reserved_units: soma(f => f.demand_source_status === 'RESERVED'),
    other_stock_moved_units: soma(f => f.demand_source_status === 'OTHER_STOCK_MOVED'),
    largest_single_day_units: Math.max(0, ...Object.values(demanda.reduce((m, f) => { m[f.date] = (m[f.date] || 0) + f.qty; return m; }, {}))),
    observed_daily_rate: idade === null ? null : r3(unidades / Math.max(1, idade)),
    signal_window_rate: avg[P.JANELA_SINAL],
    velocity_window_rate: avg[P.JANELA_VELOCIDADE],
    active: ativo !== false,
  };
}

/** Motivo factual de um produto novo que NÃO passou na exceção (critério → código). */
const MOTIVO_FALHA_PRODUTO_NOVO = Object.freeze({
  MIN_AGE: 'NEW_PRODUCT_MIN_AGE_NOT_MET',
  MIN_UNITS: 'NEW_PRODUCT_MIN_UNITS_NOT_MET',
  MIN_DISTINCT_SALE_DAYS: 'NEW_PRODUCT_DISTINCT_DAYS_NOT_MET',
  MIN_DAILY_RATE: 'NEW_PRODUCT_MIN_RATE_NOT_MET',
  NOT_ACTIVE: 'NEW_PRODUCT_NOT_ACTIVE',
});

/** Aplica UMA regra de demanda comprovada à evidência. Devolve { accepted, failed[] } (critérios que falharam). */
function avaliarDemandaComprovada(ev, regra) {
  if (!ev || !regra || !regra.enabled) return { accepted: false, failed: ['RULE_DISABLED'] };
  const unidades = regra.count_reserved ? ev.units_since_first_evidence : ev.units_since_first_evidence - ev.reserved_units;
  const falhas = [];
  if (ev.age_days === null || ev.age_days < regra.minimum_age_days) falhas.push('MIN_AGE');
  if (unidades < regra.minimum_units) falhas.push('MIN_UNITS');
  if (ev.distinct_sale_days < regra.minimum_distinct_sale_days) falhas.push('MIN_DISTINCT_SALE_DAYS');
  if (regra.rate_rule && regra.rate_rule.type === 'MIN_OBSERVED_DAILY_RATE' && !(ev.observed_daily_rate >= regra.rate_rule.min_daily_rate)) falhas.push('MIN_DAILY_RATE');
  if (regra.require_active && ev.active === false) falhas.push('NOT_ACTIVE');
  return { accepted: falhas.length === 0, failed: falhas };
}

/** Velocidade de produto novo por método de quantidade (a comparar; nenhum é política até aprovação). */
function velocidadeProdutoNovo(ev, metodo) {
  const obs = ev.observed_daily_rate, sin = ev.signal_window_rate;
  if (metodo === 'OBSERVED_SINCE_FIRST_EVIDENCE') return obs;
  if (metodo === 'SIGNAL_WINDOW_RATE') return sin;
  if (metodo === 'MIN_OBSERVED_AND_SIGNAL') return obs === null || sin === null ? null : Math.min(obs, sin);
  throw new Error('METODO_QTD_PRODUTO_NOVO_INVALIDO: ' + metodo);
}

/** Confiança do custo cadastrado (rótulo informativo; nunca decide compra). */
function confiancaCusto(p, confirmadas, hoje, P = PARAMS) {
  if (!(p.registered_cost_cents > 0)) return 'NO_COST';
  const ult = confirmadas.filter(f => f.unit_cost_cents > 0).sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || '') || String(b.purchase_id).localeCompare(String(a.purchase_id)))[0];
  if (!ult || diffDias(ult.issue_date, hoje) > P.CUSTO_IDADE_MAX_DIAS) return 'LOW_CONFIDENCE_COST';
  const tol = Math.max(1, Math.round(ult.unit_cost_cents * P.CUSTO_TOLERANCIA_RELATIVA));
  return Math.abs(p.registered_cost_cents - ult.unit_cost_cents) <= tol ? 'KNOWN_COST' : 'LOW_CONFIDENCE_COST';
}

/**
 * Métricas de UM produto (independentes de classe ABC).
 * @param ctx { hoje, dataVendaMaisAntiga, P }
 */
function calcularProduto(p, vendas = [], compras = [], ctx) {
  const { hoje, dataVendaMaisAntiga } = ctx;
  const P = ctx.P || PARAMS;
  const D = P.JANELA_DEMANDA, V = P.JANELA_VELOCIDADE, S = P.JANELA_SINAL;
  // demanda = venda que baixou estoque, não cancelada, com data ≤ hoje (data futura = fora)
  const demanda = vendas.filter(f => f.counts_as_demand && f.date && f.date <= hoje && f.qty != null && f.qty > 0);
  const futuras = vendas.filter(f => f.counts_as_demand && f.date && f.date > hoje).length;
  const excluidas = vendas.length - demanda.length - futuras;
  const confirmadas = compras.filter(f => f.status === 'CONFIRMADA' && f.issue_date);
  const pendentes = compras.filter(f => f.status === 'PENDENTE');

  const unidades = {}, receita = {};
  for (const n of P.JANELAS_DIAS) {
    const ini = somarDias(hoje, -n);
    const fs = demanda.filter(f => f.date > ini);
    unidades[n] = fs.reduce((s, f) => s + f.qty, 0);
    receita[n] = fs.reduce((s, f) => s + (f.line_total_cents || 0), 0);
  }
  const iniD = somarDias(hoje, -D);
  const porOrigem = { COMPLETED: 0, RESERVED: 0, OTHER_STOCK_MOVED: 0 };
  for (const f of demanda) if (f.date > iniD) { const o = f.demand_source_status || 'COMPLETED'; porOrigem[o] = (porOrigem[o] || 0) + f.qty; }

  const datasVenda = demanda.map(f => f.date).sort();
  const ultimaVenda = datasVenda.length ? datasVenda[datasVenda.length - 1] : null;
  const primeiraVenda = datasVenda.length ? datasVenda[0] : null;
  const primeiraCompra = confirmadas.map(f => f.issue_date).sort()[0] || null;
  const ultimaCompra = confirmadas.map(f => f.issue_date).sort().pop() || null;
  const candidatos = [primeiraVenda, primeiraCompra, p.created_at_reliable ? p.created_at : null].filter(Boolean).sort();
  const primeiraEvidencia = candidatos[0] || null;
  const diasObservado = primeiraEvidencia ? diffDias(primeiraEvidencia, hoje) : null;
  const novo = diasObservado !== null && diasObservado < P.PRODUTO_NOVO_DIAS;

  const media = n => (diasObservado === null ? null : r3(unidades[n] / Math.min(n, Math.max(1, diasObservado))));
  const avg = Object.fromEntries(P.JANELAS_DIAS.filter(n => n <= 2 * V).map(n => [n, media(n)]));

  // NUNCA VENDIDO (contra o histórico disponível)
  const nuncaVendido = demanda.length === 0;
  let confianca = null, motivoConfianca = null;
  if (nuncaVendido) {
    const inicioConhecido = primeiraCompra || (p.created_at_reliable ? p.created_at : null);
    if (!inicioConhecido) { confianca = 'LOW'; motivoConfianca = 'SEM_DATA_DE_INICIO_CONFIAVEL'; }
    else if (dataVendaMaisAntiga && inicioConhecido < dataVendaMaisAntiga) { confianca = 'MEDIUM'; motivoConfianca = 'VIDA_DO_PRODUTO_ANTERIOR_AO_HISTORICO'; }
    else if (diffDias(inicioConhecido, hoje) < V) { confianca = 'MEDIUM'; motivoConfianca = 'PRODUTO_RECENTE'; }
    else { confianca = 'HIGH'; motivoConfianca = 'HISTORICO_COBRE_A_VIDA_CONHECIDA'; }
  }

  // DIAS SEM VENDA + evidência de estoque no período
  const diasSemVenda = ultimaVenda ? diffDias(ultimaVenda, hoje) : (primeiraEvidencia ? diffDias(primeiraEvidencia, hoje) : null);
  const inicioSemVenda = ultimaVenda || primeiraEvidencia;
  const evidenciaEstoque = p.current_stock > 0 && !!ultimaCompra && !!inicioSemVenda && ultimaCompra <= inicioSemVenda;
  const qualificadorSemVenda = diasSemVenda === null || diasSemVenda === 0 ? null : (evidenciaEstoque ? 'NO_SALES_WITH_STOCK_EVIDENCE' : 'NO_SALES_STOCK_HISTORY_UNKNOWN');

  // ESTOQUE: bruto × disponível para reposição (negativo nunca vira necessidade adicional)
  const rawStock = p.current_stock;
  const disponivel = rawStock === null ? null : Math.max(0, rawStock);
  const rupturaAtual = rawStock !== null && rawStock <= 0;

  // VELOCIDADE: base = média da janela de velocidade; janela de sinal só DETECTA (não substitui) na política 1.0
  const sinal = sinalVelocidade({ u30: unidades[S], u90: unidades[V], u180: unidades[2 * V], diasObservado, novo }, P);
  let velocidade = avg[V] === null ? null : (P.ACELERACAO_COMPORTAMENTO === 'MAX_30D_90D' && sinal === 'RECENT_ACCELERATION' ? Math.max(avg[S], avg[V]) : avg[V]);
  const paraou = (unidades[P.PAROU_JANELA_ANTES] - unidades[P.PAROU_JANELA_SEM_VENDA]) >= P.PAROU_MIN_UNIDADES_ANTES && unidades[P.PAROU_JANELA_SEM_VENDA] === 0;

  // Produto novo: proteção de lançamento; exceção SÓ se a política trouxer proven_demand habilitada e TODOS os
  // critérios passarem. Aceito → velocidade pelo método da política (1.1: Método 3 = min(desde a 1ª evidência, 30d)).
  const evidNovo = novo ? evidenciaProdutoNovo(demanda, diasObservado, avg, P, p.active) : null;
  const avaliacaoNovo = novo && P.REGRA_PRODUTO_NOVO ? avaliarDemandaComprovada(evidNovo, P.REGRA_PRODUTO_NOVO) : null;
  const novoComprovado = !!(avaliacaoNovo && avaliacaoNovo.accepted);
  if (novoComprovado) velocidade = velocidadeProdutoNovo(evidNovo, P.REGRA_PRODUTO_NOVO.quantity_velocity);

  // COBERTURA (indicador; dias = disponível ÷ velocidade; nunca infinito)
  let cobertura;
  if (rawStock === null) cobertura = { estado: 'UNKNOWN', dias: null };
  else if (rawStock < 0) cobertura = { estado: 'NEGATIVE_STOCK', dias: null };
  else if (rawStock === 0) cobertura = { estado: 'CURRENT_STOCKOUT', dias: 0 };
  else if ((novo && !novoComprovado) || diasObservado === null) cobertura = { estado: 'INSUFFICIENT_HISTORY', dias: null };
  else if (!velocidade) cobertura = { estado: 'NO_DEMAND_OBSERVED', dias: null };
  else {
    const dias = Math.round(disponivel / velocidade * 10) / 10;
    cobertura = { estado: dias < P.COBERTURA_CRITICA_DIAS ? 'COVERAGE_CRITICAL' : dias < P.COBERTURA_BAIXA_DIAS ? 'COVERAGE_LOW' : dias > P.COBERTURA_EXCESSO_DIAS ? 'COVERAGE_EXCESS' : 'COVERAGE_OK', dias };
  }

  const faixaDemanda = P.FAIXAS_DEMANDA_RUPTURA.find(n => unidades[n] > 0);
  const rupturaDemanda = !rupturaAtual ? null : (faixaDemanda ? `RECENT_DEMAND_${faixaDemanda}D` : 'NO_RECENT_DEMAND');

  let classeNegativo = null;
  if (rawStock !== null && rawStock < 0) {
    if (!p.active) classeNegativo = 'NEGATIVE_INACTIVE_PRODUCT';
    else if (!p.moves_stock || (demanda.length === 0 && confirmadas.length === 0)) classeNegativo = 'NEGATIVE_DATA_ANOMALY';
    else if (unidades[D] > 0) classeNegativo = 'NEGATIVE_WITH_RECENT_SALES';
    else classeNegativo = 'NEGATIVE_WITHOUT_RECENT_SALES';
  }

  // Produto novo nunca é classificado como parado por ausência de venda
  const parado = !novo && rawStock > 0 && diasSemVenda !== null ? faixaParado(diasSemVenda, P) : null;
  const fornecedores = [...new Set(confirmadas.map(f => f.supplier_id).filter(Boolean))];
  const ultimoFornecedor = confirmadas.filter(f => f.supplier_id).sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || '') || String(b.purchase_id).localeCompare(String(a.purchase_id)))[0];
  const custo = confiancaCusto(p, confirmadas, hoje, P);
  const minCalc = velocidade ? Math.ceil(velocidade * P.COBERTURA_MINIMA_CALCULADA_DIAS - EPS) : null;

  // ELEGIBILIDADE para sugestão (NÃO é compra automática). Custo não participa.
  const exclusoes = [];
  if (!p.active) exclusoes.push('INACTIVE_PRODUCT');
  if (!p.moves_stock) exclusoes.push('NOT_STOCK_MOVING');
  if (p.has_composition) exclusoes.push('KIT_NOT_SUPPORTED');
  if (nuncaVendido) exclusoes.push('NEVER_SOLD');
  if (novo && !novoComprovado) exclusoes.push('NEW_PRODUCT');
  if (rawStock === null) exclusoes.push('STOCK_UNKNOWN');
  if (!nuncaVendido && unidades[D] < P.DEMANDA_MINIMA) exclusoes.push('INSUFFICIENT_RECENT_DEMAND');

  const at = [];
  if (rupturaAtual && unidades[P.JANELA_DEMANDA_RECENTE_PRIORIDADE] > 0) at.push('STOCKOUT_RECENT_DEMAND');
  if (cobertura.estado === 'COVERAGE_CRITICAL' || cobertura.estado === 'COVERAGE_LOW') at.push('LOW_COVERAGE');
  if (rawStock !== null && rawStock < 0) at.push('NEGATIVE_STOCK');
  if (nuncaVendido) at.push('NEVER_SOLD');
  if (parado && ['365+', '180+', '120+'].includes(parado)) at.push('NO_SALE_' + parado.replace('+', 'D'));
  if (cobertura.estado === 'COVERAGE_EXCESS') at.push('EXCESS_COVERAGE');
  if (custo === 'NO_COST') at.push('NO_COST');
  if (custo === 'LOW_CONFIDENCE_COST') at.push('LOW_COST_CONFIDENCE');
  if (!fornecedores.length) at.push('NO_SUPPLIER');
  if (novo) at.push('NEW_PRODUCT');
  if (novoComprovado) at.push('NEW_PRODUCT_WITH_PROVEN_DEMAND');
  if (avaliacaoNovo && !novoComprovado) for (const f of avaliacaoNovo.failed) at.push(MOTIVO_FALHA_PRODUTO_NOVO[f] || 'NEW_PRODUCT_RULE_' + f);
  if (!p.active) at.push('INACTIVE_PRODUCT');
  if (sinal === 'INSUFFICIENT_HISTORY') at.push('INSUFFICIENT_HISTORY');
  if (sinal === 'RECENT_ACCELERATION') at.push('RECENT_ACCELERATION');
  if (sinal === 'RECENT_DECELERATION') at.push('RECENT_DECELERATION');
  if (paraou) at.push('SALES_STOPPED_RECENTLY');
  if (porOrigem.RESERVED > 0) at.push('RESERVED_DEMAND_INCLUDED');
  if (pendentes.length) at.push('PENDING_PURCHASE_EXISTS');
  if (p.has_composition) at.push('KIT_NOT_SUPPORTED');

  return {
    product_id: p.product_id, policy_version: P.POLICY_VERSION, active: p.active, moves_stock: p.moves_stock, kit: p.has_composition,
    current_stock: rawStock, raw_stock: rawStock, available_stock_for_replenishment: disponivel,
    current_stockout: rupturaAtual, historical_stockout: 'UNSUPPORTED', stockout_demand: rupturaDemanda, negative_stock_class: classeNegativo,
    first_evidence_date: primeiraEvidencia, created_at_reliable: p.created_at_reliable, new_product: novo,
    new_product_evidence: evidNovo, new_product_proven_demand: avaliacaoNovo,
    last_sale_date: ultimaVenda, days_since_last_sale: diasSemVenda, no_sale_qualifier: qualificadorSemVenda,
    never_sold: nuncaVendido, never_sold_confidence: confianca, never_sold_reason: motivoConfianca,
    units: unidades, revenue_cents: receita, avg_daily: avg, demand_by_source_90d: porOrigem,
    velocity_signal: sinal, policy_velocity: velocidade, sales_stopped_recently: paraou,
    coverage: cobertura, dead_stock_band: parado,
    suppliers: fornecedores, last_supplier: ultimoFornecedor ? ultimoFornecedor.supplier_id : null,
    last_purchase_date: ultimaCompra, pending_purchases: pendentes.length, cost_confidence: custo,
    erp_min_stock: p.erp_min_stock, calculated_min_stock: minCalc,
    below_erp_min_stock: p.erp_min_stock == null ? 'ERP_MIN_STOCK_UNAVAILABLE' : rawStock < p.erp_min_stock,
    below_calculated_min_stock: minCalc === null || rawStock === null ? null : rawStock < minCalc,
    purchase_eligible: exclusoes.length === 0, purchase_exclusions: exclusoes,
    reason_codes: at,
    excluded_sales_lines: excluidas, future_dated_sales_lines: futuras,
    audit: { rules_version: RULES_VERSION, policy_version: P.POLICY_VERSION, sales_window_days: V, units_90d: unidades[V], avg_daily_90d: avg[V], policy_velocity: velocidade, coverage_days: cobertura.dias, days_observed: diasObservado, demand_lines: demanda.length },
  };
}

/**
 * Prioridade operacional determinística — MAIOR PRIORIDADE PARA ANÁLISE, não "comprar automaticamente".
 * Só é calculada para produto elegível com necessidade (quantidade sugerida > 0).
 *   P1 = A + (ruptura ou negativo) + demanda recente
 *   P2 = A + cobertura abaixo do alvo (com estoque disponível)
 *   P3 = B + (ruptura ou negativo) + demanda recente
 *   P4 = demais elegíveis com necessidade
 */
function prioridade(m, classe, P = PARAMS) {
  const semEstoqueComDemanda = m.raw_stock !== null && m.raw_stock <= 0 && m.units[P.JANELA_DEMANDA_RECENTE_PRIORIDADE] > 0;
  if (classe === 'A' && semEstoqueComDemanda) return 'P1';
  if (classe === 'A' && m.raw_stock > 0) return 'P2';
  if (classe === 'B' && semEstoqueComDemanda) return 'P3';
  return 'P4';
}

/**
 * Aplica uma cobertura-alvo (sem lead time) a um produto.
 * necessidade = velocidade × dias_alvo − AVAILABLE_STOCK_FOR_REPLENISHMENT
 * SUGGESTED_QTY = CEIL(necessidade) se necessidade > 0 (0 < necessidade < 1 ⇒ 1); senão 0.
 */
function aplicarPolitica(m, classe, dias, { arredondamento, P = PARAMS } = {}) {
  const regra = arredondamento || P.ARREDONDAMENTO;
  if (!m.purchase_eligible || !(m.policy_velocity > 0)) return { class: classe, target_days: dias, target_stock: null, calculated_need: null, suggested_qty: 0, needs_purchase: false, priority: null, excluded_by: m.purchase_eligible ? ['NO_VELOCITY'] : m.purchase_exclusions };
  const alvo = m.policy_velocity * dias;
  const necessidade = alvo - m.available_stock_for_replenishment;
  const qtd = necessidade <= EPS ? 0 : (regra === 'ROUND' ? Math.round(necessidade) : Math.ceil(necessidade - EPS));
  return { class: classe, target_days: dias, target_stock: r3(alvo), calculated_need: r3(necessidade), suggested_qty: qtd, needs_purchase: qtd > 0, priority: qtd > 0 ? prioridade(m, classe, P) : null, excluded_by: [] };
}

/** ABC por uma métrica (acumulada); zero → SEM_VENDA (não é "C"). */
function curvaABC(itens, chave, P = PARAMS) {
  const comValor = itens.filter(i => i[chave] > 0).sort((a, b) => b[chave] - a[chave] || String(a.id).localeCompare(String(b.id)));
  const total = comValor.reduce((s, i) => s + i[chave], 0);
  const out = {};
  let acum = 0;
  for (const i of comValor) {
    const antes = acum / total;
    acum += i[chave];
    out[i.id] = antes < P.ABC_CORTE_A ? 'A' : antes < P.ABC_CORTE_B ? 'B' : 'C';
  }
  for (const i of itens) if (!out[i.id]) out[i.id] = 'SEM_VENDA';
  return out;
}

/** Sugestão OFICIAL da política, com explicação completa (rastreável). Custo não participa. */
function sugestaoOficial(m, P) {
  const classe = m[P.ABC_BASE] === 'SEM_VENDA' ? 'C' : m[P.ABC_BASE];
  const s = aplicarPolitica(m, classe, P.ALVO_DIAS[classe], { P });
  return {
    policy_version: P.POLICY_VERSION, abc_basis: P.ABC_BASE,
    abc_revenue: m.abc_revenue, abc_units: m.abc_units, abc_divergence: m.abc_divergence,
    raw_stock: m.raw_stock, available_stock_for_replenishment: m.available_stock_for_replenishment,
    sales: Object.fromEntries(P.JANELAS_VENDAS_EXPLICACAO.map(n => ['d' + n, m.units[n]])),
    velocity_window_days: P.JANELA_VELOCIDADE, velocity_used: m.policy_velocity, velocity_signal: m.velocity_signal,
    coverage_days: m.coverage.dias, coverage_state: m.coverage.estado,
    target_days: s.target_days, target_stock: s.target_stock, calculated_need: s.calculated_need, rounding: P.ARREDONDAMENTO,
    suggested_qty: s.suggested_qty, priority: s.priority,
    eligible: m.purchase_eligible, exclusions: s.excluded_by,
    reason_codes: m.reason_codes, lead_time: 'UNKNOWN_COVERAGE_POLICY_NOT_REORDER_POINT',
    // Só em políticas com a exceção configurada (≥ 1.1): caminho de elegibilidade e auditoria do lançamento
    ...(P.REGRA_PRODUTO_NOVO ? {
      eligibility_path: !m.new_product ? 'MATURE' : (m.new_product_proven_demand && m.new_product_proven_demand.accepted ? 'NEW_PRODUCT_WITH_PROVEN_DEMAND' : 'NEW_PRODUCT_PROTECTED'),
      new_product_exception: !m.new_product ? null : {
        rule: 'NEW_PRODUCT_WITH_PROVEN_DEMAND', accepted: !!(m.new_product_proven_demand && m.new_product_proven_demand.accepted),
        failed_criteria: m.new_product_proven_demand ? m.new_product_proven_demand.failed : [],
        criteria: { minimum_age_days: P.REGRA_PRODUTO_NOVO.minimum_age_days, minimum_units: P.REGRA_PRODUTO_NOVO.minimum_units, minimum_distinct_sale_days: P.REGRA_PRODUTO_NOVO.minimum_distinct_sale_days, require_active: !!P.REGRA_PRODUTO_NOVO.require_active },
        age_days: m.new_product_evidence.age_days,
        valid_demand_units: P.REGRA_PRODUTO_NOVO.count_reserved ? m.new_product_evidence.units_since_first_evidence : m.new_product_evidence.units_since_first_evidence - m.new_product_evidence.reserved_units,
        distinct_valid_sale_days: m.new_product_evidence.distinct_sale_days,
        completed_demand_units: m.new_product_evidence.completed_units, reserved_demand_units: m.new_product_evidence.reserved_units,
        largest_single_day_units: m.new_product_evidence.largest_single_day_units,
        velocity_since_creation: m.new_product_evidence.observed_daily_rate, velocity_30d: m.new_product_evidence.signal_window_rate,
        quantity_method: P.REGRA_PRODUTO_NOVO.quantity_velocity,
        velocity_used: m.new_product_proven_demand && m.new_product_proven_demand.accepted ? m.policy_velocity : null,
      },
    } : {}),
  };
}

/** Motor completo: métricas + ABC (principal e secundária) + sugestão oficial + cenários de calibração. */
function calcularTudo({ produtos, fatosVenda, fatosCompra, hoje, politica = POLITICA_VIGENTE, cenarios = CENARIOS_EXPERIMENTAIS }) {
  const P = paramsDe(politica);
  const { vendasPorProduto, comprasPorProduto, duplicatas } = indexarFatos(fatosVenda, fatosCompra);
  const datasDemanda = fatosVenda.filter(f => f.counts_as_demand && f.date && f.date <= hoje).map(f => f.date).sort();
  const ctx = { hoje, dataVendaMaisAntiga: datasDemanda[0] || null, P };
  const metricas = produtos.map(p => calcularProduto(p, vendasPorProduto.get(p.product_id) || [], comprasPorProduto.get(p.product_id) || [], ctx));
  const abcRec = curvaABC(metricas.map(m => ({ id: m.product_id, v: m.revenue_cents[P.ABC_JANELA] })), 'v', P);
  const abcUn = curvaABC(metricas.map(m => ({ id: m.product_id, v: m.units[P.ABC_JANELA] })), 'v', P);
  for (const m of metricas) {
    m.abc_revenue = abcRec[m.product_id]; m.abc_units = abcUn[m.product_id]; m.abc_margin = 'BLOCKED';
    m.abc_divergence = m.abc_revenue === m.abc_units ? null : `REVENUE_${m.abc_revenue}_UNITS_${m.abc_units}`;
    m.suggestion = sugestaoOficial(m, P);
    if (m.suggestion.suggested_qty > 0) { m.reason_codes.push('LEAD_TIME_UNKNOWN'); m.suggestion.reason_codes = m.reason_codes; }
    const classe = m[P.ABC_BASE] === 'SEM_VENDA' ? 'C' : m[P.ABC_BASE];
    m.scenarios = Object.fromEntries(Object.entries(cenarios || {}).map(([nome, c]) => [nome, aplicarPolitica(m, classe, c[classe], { P })]));
  }
  const ids = f => metricas.filter(f).map(m => m.product_id);
  const idsProdutos = new Set(produtos.map(p => p.product_id));
  const orfaos = [...vendasPorProduto.keys()].filter(id => !idsProdutos.has(id));
  return {
    hoje, rules_version: RULES_VERSION, policy_version: P.POLICY_VERSION, politica, params: P, cenarios: cenarios || {}, abc_base: P.ABC_BASE,
    data_venda_mais_antiga: ctx.dataVendaMaisAntiga, duplicatas,
    metricas,
    agregados: {
      ruptura_atual: ids(m => m.current_stockout && m.raw_stock === 0),
      estoque_negativo: ids(m => m.raw_stock < 0),
      cobertura_critica: ids(m => m.coverage.estado === 'COVERAGE_CRITICAL'),
      cobertura_baixa: ids(m => m.coverage.estado === 'COVERAGE_LOW'),
      cobertura_excesso: ids(m => m.coverage.estado === 'COVERAGE_EXCESS'),
      sem_demanda_observada: ids(m => m.coverage.estado === 'NO_DEMAND_OBSERVED'),
      nunca_vendido: ids(m => m.never_sold),
      nunca_vendido_alta_confianca: ids(m => m.never_sold && m.never_sold_confidence === 'HIGH'),
      elegiveis_reposicao: ids(m => m.purchase_eligible),
      sugestoes_politica: ids(m => m.suggestion.suggested_qty > 0),
      prioridade: Object.fromEntries(['P1', 'P2', 'P3', 'P4'].map(k => [k, ids(m => m.suggestion.priority === k)])),
      compra_por_cenario: Object.fromEntries(Object.keys(cenarios || {}).map(n => [n, ids(m => m.scenarios[n].needs_purchase)])),
      produtos_novos: ids(m => m.new_product),
      com_fornecedor: ids(m => m.suppliers.length > 0),
      sem_fornecedor: ids(m => m.suppliers.length === 0),
      abaixo_minimo_calculado: ids(m => m.below_calculated_min_stock === true),
      parado: Object.fromEntries(P.FAIXAS_PARADO.map(f => [f + '+', ids(m => m.dead_stock_band === f + '+')])),
      abc_receita: { A: ids(m => m.abc_revenue === 'A'), B: ids(m => m.abc_revenue === 'B'), C: ids(m => m.abc_revenue === 'C'), SEM_VENDA: ids(m => m.abc_revenue === 'SEM_VENDA') },
      abc_unidades: { A: ids(m => m.abc_units === 'A'), B: ids(m => m.abc_units === 'B'), C: ids(m => m.abc_units === 'C'), SEM_VENDA: ids(m => m.abc_units === 'SEM_VENDA') },
      divergencia_abc: { REVENUE_A_UNITS_C: ids(m => m.abc_divergence === 'REVENUE_A_UNITS_C'), REVENUE_C_UNITS_A: ids(m => m.abc_divergence === 'REVENUE_C_UNITS_A') },
      velocidade: Object.fromEntries(['RECENT_ACCELERATION', 'RECENT_DECELERATION', 'STABLE', 'INSUFFICIENT_HISTORY'].map(k => [k, ids(m => m.velocity_signal === k)])),
    },
    produtos_de_venda_nao_encontrados: orfaos,
  };
}

module.exports = { RULES_VERSION, PARAMS, paramsDe, indexarFatos, calcularProduto, evidenciaProdutoNovo, avaliarDemandaComprovada, velocidadeProdutoNovo, sinalVelocidade, confiancaCusto, prioridade, aplicarPolitica, sugestaoOficial, curvaABC, calcularTudo, faixaParado };
