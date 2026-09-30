'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política de compras VERSIONADA (fonte única dos parâmetros).
// Regra: nenhum número operacional (dias-alvo, janelas, limiares, arredondamento…) fica espalhado no código.
// Todo resumo, bloco de produto, sugestão e snapshot de estoque grava `policy_version`.
// Alterar qualquer valor ⇒ nova versão (nunca editar uma versão publicada).

function congelar(o) { Object.values(o).forEach(v => { if (v && typeof v === 'object') congelar(v); }); return Object.freeze(o); }

/** Política 1.0 — configuração inicial aprovada pelo gestor em 29/09/2026. */
const POLITICA_1_0 = congelar({
  policy_version: '1.0',
  approved_on: '2026-09-29',
  abc: { primary: 'abc_revenue', secondary: 'abc_units', cut_a: 0.80, cut_b: 0.95, window_days: 365 },
  target_days: { A: 30, B: 21, C: 15 },                      // quantidade sugerida usa SÓ isto
  demand: {
    window_days: 90, minimum_units: 1,                         // ≥ 1 un de demanda válida em 90d → pode ser elegível
    rule: 'STOCK_MOVED_NOT_CANCELLED_DATE_LE_TODAY',
    reserved: 'COUNTS_IF_STOCK_MOVED_LATEST_VERSION_WINS',     // reserva cancelada depois deixa de contar
  },
  velocity: {
    window_days: 90,                                           // SALES_VELOCITY_BASE
    signal_window_days: 30,                                    // detecta aceleração/desaceleração
    acceleration_behavior: 'SIGNAL_ONLY',                      // 30d NÃO substitui a média de 90d
    deceleration_behavior: 'SIGNAL_ONLY',
    signal: { min_units_2x_window: 6, min_days_observed: 90, accel_min_units_signal_window: 3, accel_30_vs_90: 1.25, accel_90_vs_prev: 1.25, decel_30_vs_90: 0.5, decel_90_vs_prev: 0.5 },
    stopped: { min_units_before: 6, no_sale_days: 60, lookback_days: 365 },   // SALES_STOPPED_RECENTLY
  },
  new_product: { window_days: 60, replenishment: 'EXCLUDED_INSUFFICIENT_HISTORY', dead_stock: 'NEVER_CLASSIFIED' },
  coverage_indicators: { critical_below_days: 15, low_below_days: 30, excess_above_days: 180 },   // só indicadores
  calculated_min_stock_days: 15,                               // indicador CALCULATED_MIN_STOCK (não define quantidade)
  rounding: 'CEIL',                                            // ceil(necessidade); 0 < necessidade < 1 ⇒ 1
  negative_stock: 'AVAILABLE_EQUALS_MAX_RAW_0_WITH_REASON_NEGATIVE_STOCK',
  never_sold: 'SUGGESTED_QTY_0',
  inactive: 'SUGGESTED_QTY_0',
  priority: { engine: 'P1_P4_V1', recent_demand_window_days: 90 },
  windows_days: [7, 30, 60, 90, 180, 365],                   // precisa conter demanda, velocidade, sinal e 2× velocidade
  stockout_demand_bands_days: [30, 60, 90],                  // diagnóstico de ruptura com demanda recente
  explanation_sales_windows_days: [30, 60, 90],              // vendas mostradas na explicação da sugestão
  dead_stock_bands_days: [365, 180, 120, 90, 60, 30],
  cost: { usage: 'INFORMATIVE_ONLY_NOT_USED_FOR_ELIGIBILITY_PRIORITY_OR_QTY', known_tolerance: 0.005, known_max_age_days: 365 },
  sync: { full: 'DAILY_OVERNIGHT_RECONCILIATION', incremental_every_hours: 3, incremental_lookback_days: 90, stale_after_hours: 6, full_overdue_after_hours: 26, scheduled: false },
  stock_snapshot: { type: 'FULL_DAILY', timezone: 'America/Fortaleza', schema_version: 1, retention_days: 1827, same_day: 'REPLACE_LAST_SYNC_WINS' },
  blocked: { abc_margin: 'BLOCKED', purchase_affordability: 'BLOCKED' },
});

/** Cenários EXPERIMENTAIS da Fase 1 — só para calibração/comparação; não são política. */
const CENARIOS_EXPERIMENTAIS = congelar({
  CONSERVATIVE: { A: 45, B: 30, C: 15 },
  BALANCED: { A: 30, B: 21, C: 15 },
  LEAN: { A: 21, B: 15, C: 7 },
});

// ── Exceção de PRODUTO NOVO COM DEMANDA COMPROVADA — estrutura CONFIGURÁVEL (Política 1.0 NÃO a contém: desativada) ──
// Formato de `new_product.proven_demand` numa política futura (ex.: 1.1, só após aprovação do gestor):
//   { enabled, minimum_age_days, minimum_units, minimum_distinct_sale_days,
//     rate_rule: { type: 'NONE' | 'MIN_OBSERVED_DAILY_RATE', min_daily_rate },
//     count_reserved: true|false,                                   // reservado com baixa conta como na Política 1.0?
//     quantity_velocity: 'OBSERVED_SINCE_FIRST_EVIDENCE' | 'SIGNAL_WINDOW_RATE' | 'MIN_OBSERVED_AND_SIGNAL' }
const METODOS_QTD_PRODUTO_NOVO = congelar({
  METODO_1: 'OBSERVED_SINCE_FIRST_EVIDENCE',   // velocidade observada desde a primeira evidência × alvo ABC
  METODO_2: 'SIGNAL_WINDOW_RATE',              // velocidade da janela de sinal (30d) × alvo ABC
  METODO_3: 'MIN_OBSERVED_AND_SIGNAL',         // min(observada, 30d) × alvo ABC — conservadora
});
/** Regras CANDIDATAS (calibração). Nenhuma é política. E: limiar de taxa vem da distribuição real (null aqui). */
const REGRAS_EXPERIMENTAIS_PRODUTO_NOVO = congelar({
  A: { enabled: true, minimum_age_days: 0, minimum_units: 1, minimum_distinct_sale_days: 1, rate_rule: { type: 'NONE', min_daily_rate: null }, count_reserved: true, quantity_velocity: 'OBSERVED_SINCE_FIRST_EVIDENCE' },
  B: { enabled: true, minimum_age_days: 0, minimum_units: 3, minimum_distinct_sale_days: 2, rate_rule: { type: 'NONE', min_daily_rate: null }, count_reserved: true, quantity_velocity: 'OBSERVED_SINCE_FIRST_EVIDENCE' },
  C: { enabled: true, minimum_age_days: 0, minimum_units: 5, minimum_distinct_sale_days: 3, rate_rule: { type: 'NONE', min_daily_rate: null }, count_reserved: true, quantity_velocity: 'OBSERVED_SINCE_FIRST_EVIDENCE' },
  D: { enabled: true, minimum_age_days: 7, minimum_units: 5, minimum_distinct_sale_days: 3, rate_rule: { type: 'NONE', min_daily_rate: null }, count_reserved: true, quantity_velocity: 'OBSERVED_SINCE_FIRST_EVIDENCE' },
  E: { enabled: true, minimum_age_days: 7, minimum_units: 1, minimum_distinct_sale_days: 3, rate_rule: { type: 'MIN_OBSERVED_DAILY_RATE', min_daily_rate: null }, count_reserved: true, quantity_velocity: 'OBSERVED_SINCE_FIRST_EVIDENCE' },
});

function validarRegraProdutoNovo(r) {
  const e = [];
  if (!r || typeof r !== 'object') return ['proven_demand ausente'];
  if (typeof r.enabled !== 'boolean') e.push('proven_demand.enabled deve ser booleano');
  for (const k of ['minimum_age_days', 'minimum_units', 'minimum_distinct_sale_days']) if (!(Number.isInteger(r[k]) && r[k] >= 0)) e.push('proven_demand.' + k + ' deve ser inteiro ≥ 0');
  if (!(r.minimum_units >= 1)) e.push('proven_demand.minimum_units deve ser ≥ 1 (sem venda nunca prova demanda)');
  const rr = r.rate_rule || {};
  if (!['NONE', 'MIN_OBSERVED_DAILY_RATE'].includes(rr.type)) e.push('proven_demand.rate_rule.type inválido');
  if (rr.type === 'MIN_OBSERVED_DAILY_RATE' && !(typeof rr.min_daily_rate === 'number' && rr.min_daily_rate > 0)) e.push('proven_demand.rate_rule.min_daily_rate obrigatório (> 0) — derivar dos dados');
  if (typeof r.count_reserved !== 'boolean') e.push('proven_demand.count_reserved deve ser booleano');
  if (r.require_active !== undefined && typeof r.require_active !== 'boolean') e.push('proven_demand.require_active deve ser booleano');
  if (!Object.values(METODOS_QTD_PRODUTO_NOVO).includes(r.quantity_velocity)) e.push('proven_demand.quantity_velocity inválido');
  return e;
}

/**
 * Política EXPERIMENTAL para calibração/testes: a política base + uma regra de produto novo.
 * A versão ganha sufixo '+EXP-<rótulo>' — NUNCA vira 1.1 nem POLITICA_VIGENTE.
 */
function politicaExperimental(base, rotulo, regra) {
  return congelar(JSON.parse(JSON.stringify({ ...base, policy_version: base.policy_version + '+EXP-' + rotulo, approved_on: null, new_product: { ...base.new_product, proven_demand: regra } })));
}

/**
 * Política 1.1 — aprovada pelo gestor em 29/09/2026. HERDA a 1.0 integralmente; a ÚNICA mudança comportamental é a
 * exceção determinística NEW_PRODUCT_WITH_PROVEN_DEMAND (regra D + Método 3 + produto ativo).
 * A 1.0 continua disponível e reproduzível (golden gerado com o código b3b13dc).
 */
const POLITICA_1_1 = congelar(JSON.parse(JSON.stringify({
  ...POLITICA_1_0,
  policy_version: '1.1',
  inherits_from: '1.0',
  approved_on: '2026-09-29',
  changes_from_parent: ['new_product.proven_demand'],
  new_product: {
    ...POLITICA_1_0.new_product,
    replenishment: 'EXCLUDED_UNLESS_PROVEN_DEMAND',
    proven_demand: {
      enabled: true,
      minimum_age_days: 7,
      minimum_units: 5,
      minimum_distinct_sale_days: 3,
      rate_rule: { type: 'NONE', min_daily_rate: null },
      count_reserved: true,                            // reservado com baixa conta (regra de demanda aprovada)
      require_active: true,
      quantity_velocity: METODOS_QTD_PRODUTO_NOVO.METODO_3,
    },
  },
})));

/**
 * Política 1.2 — RENTABILIDADE (RELEASE CANDIDATE, NÃO APROVADA, NÃO VIGENTE). Herda a 1.1 sem alterar nada da decisão de compra:
 * demanda, cobertura, quantidade, ABC, ruptura e prioridade P1–P4 ficam idênticos (QTD_1_2 ≤ QTD_1_1; no RC, igual). Acrescenta a
 * camada financeira (custo, preço realizado, margem, capital, retorno, eficiência do capital) em `profitability`.
 * `thresholds` são PROPOSTAS derivadas da distribuição real (ver relatório) e só classificam sinais — não definem quantidade.
 */
const POLITICA_1_2 = congelar(JSON.parse(JSON.stringify({
  ...POLITICA_1_1,
  policy_version: '1.2',
  inherits_from: '1.1',
  status: 'RELEASE_CANDIDATE_NOT_APPROVED',
  approved_on: null,
  changes_from_parent: ['profitability'],
  profitability: {
    enabled: true,
    policy_version: '1.2',
    windows_days: [30, 60, 90],
    scale: { bps: 10000, pct_divisor: 100, ratio_digits: 10000 },        // bps = 1/100 de 1 %; razões com 4 casas
    price: {
      window_days: 90,                                                     // preço realizado usado na reposição (= janela de velocidade)
      completed_only: true,                                                // só "Concretizada" (reservado não é receita realizada)
      exclude_non_positive_net: true,                                      // bonificação/brinde/desconto ≥ 100 %: fora do preço e do lucro
      header_discount: 'PROPORTIONAL_TO_LINE_TOTAL',
      outlier_fence: { min_lines: 5, low: 0.5, high: 2, basis: 'PRODUCT_MEDIAN_UNIT_NET_PRICE_IN_WINDOW' },
      fallback: 'REGISTERED_PRICE',                                        // só sem venda elegível na janela; sempre marcado
      strong_min_lines: 3, strong_min_sale_days: 2,
    },
    cost: {
      source: 'ERP_REGISTERED_COST',
      semantics: 'LAST_CONFIRMED_PURCHASE_LANDED_COST_INFERRED_NOT_DOCUMENTED',
      reference: 'LAST_CONFIRMED_PURCHASE_LANDED',
      tolerance_high: 0.005, tolerance_medium: 0.02, high_max_reference_age_days: 365,
      imported_supplier_ids: [],                                           // a API não identifica importados: lista é decisão do gestor (vazia = nenhum marcado)
    },
    efficiency: { base_days: 30 },                                         // EFICIENCIA_DO_CAPITAL = retorno bruto por 30 dias de capital imobilizado
    decision: { high_need_priorities: ['P1', 'P2', 'P3'], priorities: ['P1', 'P2', 'P3', 'P4'], signal_names: ['NEGATIVE_MARGIN', 'MISSING_COST', 'LOW_COST_CONFIDENCE', 'HIGH_DEMAND_LOW_MARGIN', 'HIGH_DEMAND_HIGH_MARGIN', 'LOW_DEMAND_HIGH_MARGIN'] },
    // PROPOSTAS (30/09/2026, distribuição real do catálogo: margem P25 ≈ 23,9 % / P75 ≈ 38,9 %; eficiência das sugestões P25 ≈ 0,20 / P75 ≈ 0,98;
    // 10 % de desconto médio ≈ P98 dos produtos vendidos). Só classificam sinais e atratividade — NÃO definem quantidade. Não aprovadas.
    thresholds: { status: 'PROPOSED_NOT_APPROVED', margin_low_pct: 24, margin_high_pct: 39, efficiency_low: 0.2, efficiency_high: 1, deep_discount_bps: 1000 },
    distribution_percentiles: [0.1, 0.25, 0.5, 0.75, 0.9],
    view: { soft_limit_bytes: 500000 },                                    // acima disso a visão de custos usa a ficha enxuta (limite duro de documento = 900 KB)
    budget: { default_strategy: 'LAYERED_P1_FLOOR', strategies: ['OPERATIONAL', 'EFFICIENCY', 'PROTECT_P1_THEN_EFFICIENCY', 'LAYERED', 'LAYERED_P1_FLOOR'], p1_floor_days: 7 },   // estratégia padrão e piso de 7 dias: PROPOSTAS, não aprovadas
  },
})));

/** Validação do bloco de rentabilidade (Política 1.2). */
function validarRentabilidade(r) {
  const e = [];
  if (!r || typeof r !== 'object') return ['profitability ausente'];
  if (!Array.isArray(r.windows_days) || !r.windows_days.length || r.windows_days.some(d => !(Number.isInteger(d) && d > 0))) e.push('profitability.windows_days inválido');
  else if (!r.windows_days.includes(r.price && r.price.window_days)) e.push('profitability.price.window_days precisa estar em windows_days');
  const c = r.cost || {};
  if (!(c.tolerance_high > 0 && c.tolerance_high < c.tolerance_medium)) e.push('profitability.cost tolerâncias fora de ordem');
  if (!Array.isArray(c.imported_supplier_ids)) e.push('profitability.cost.imported_supplier_ids deve ser lista');
  const f = r.price && r.price.outlier_fence;
  if (!(f && f.low > 0 && f.low < 1 && f.high > 1 && Number.isInteger(f.min_lines) && f.min_lines >= 3)) e.push('profitability.price.outlier_fence inválida');
  const t = r.thresholds || {};
  if (t.margin_low_pct !== null && t.margin_high_pct !== null && !(t.margin_low_pct < t.margin_high_pct)) e.push('profitability.thresholds margem fora de ordem');
  if (t.efficiency_low !== null && t.efficiency_high !== null && !(t.efficiency_low < t.efficiency_high)) e.push('profitability.thresholds eficiência fora de ordem');
  if (!(r.budget && r.budget.strategies.includes(r.budget.default_strategy))) e.push('profitability.budget.default_strategy inválida');
  return e;
}

/** Validação estrutural (versão, classes, janelas, limiares coerentes). Devolve lista de erros. */
function validarPolitica(p) {
  const e = [];
  const pos = (v, n) => { if (!(typeof v === 'number' && v > 0)) e.push(n + ' deve ser número > 0'); };
  if (!p || typeof p.policy_version !== 'string' || !p.policy_version) e.push('policy_version ausente');
  if (!p || !p.target_days) return e.concat('target_days ausente');
  for (const c of ['A', 'B', 'C']) pos(p.target_days[c], 'target_days.' + c);
  if (!['abc_revenue', 'abc_units'].includes(p.abc && p.abc.primary)) e.push('abc.primary inválido');
  pos(p.demand && p.demand.window_days, 'demand.window_days');
  if (!(p.demand && Number.isInteger(p.demand.minimum_units) && p.demand.minimum_units >= 1)) e.push('demand.minimum_units deve ser inteiro ≥ 1');
  pos(p.velocity && p.velocity.window_days, 'velocity.window_days');
  pos(p.new_product && p.new_product.window_days, 'new_product.window_days');
  if (p.new_product && p.new_product.proven_demand !== undefined) e.push(...validarRegraProdutoNovo(p.new_product.proven_demand));
  if (p.profitability !== undefined) e.push(...validarRentabilidade(p.profitability));
  const ci = p.coverage_indicators || {};
  if (!(ci.critical_below_days < ci.low_below_days && ci.low_below_days < ci.excess_above_days)) e.push('coverage_indicators fora de ordem');
  if (!['CEIL', 'ROUND'].includes(p.rounding)) e.push('rounding inválido');
  if (!((p.windows_days || []).includes(p.demand && p.demand.window_days) && (p.windows_days || []).includes(p.velocity && p.velocity.window_days))) e.push('janelas de demanda/velocidade precisam estar em windows_days');
  if (!(p.stock_snapshot && p.stock_snapshot.timezone === 'America/Fortaleza')) e.push('stock_snapshot.timezone deve ser America/Fortaleza');
  const w = p.windows_days || [], v = p.velocity || {};
  for (const n of [v.signal_window_days, v.window_days * 2, v.stopped && v.stopped.lookback_days, v.stopped && v.stopped.no_sale_days, p.abc && p.abc.window_days, p.priority && p.priority.recent_demand_window_days, ...(p.stockout_demand_bands_days || []), ...(p.explanation_sales_windows_days || [])]) if (!w.includes(n)) e.push('janela ' + n + ' ausente de windows_days');
  return e;
}

/** Registro de versões (nunca sobrescrever uma versão publicada). */
const POLITICAS = congelar({ '1.0': POLITICA_1_0, '1.1': POLITICA_1_1, '1.2': POLITICA_1_2 });

module.exports = { POLITICA_1_0, POLITICA_1_1, POLITICA_1_2, POLITICAS, POLITICA_VIGENTE: POLITICA_1_1, CENARIOS_EXPERIMENTAIS, METODOS_QTD_PRODUTO_NOVO, REGRAS_EXPERIMENTAIS_PRODUTO_NOVO, validarRegraProdutoNovo, politicaExperimental, validarPolitica, validarRentabilidade };
