'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 1 · Calibração. Só AGREGADOS (contagens/unidades) sobre o resultado do motor.
// Nenhum nome, SKU ou valor monetário sai daqui. Nenhum cenário é escolhido: todos são comparados lado a lado.
const { PARAMS, aplicarPolitica, avaliarDemandaComprovada, velocidadeProdutoNovo } = require('./motor');
const { METODOS_QTD_PRODUTO_NOVO } = require('./politica');
// P (parâmetros da política) vem sempre do resultado do motor (r.params); PARAMS é só o padrão.

const CLASSES = ['A', 'B', 'C'];
const FAIXAS_COBERTURA = [[0, 7], [7, 15], [15, 21], [21, 30], [30, 45], [45, 60], [60, 90], [90, 180], [180, null]];   // null = faixa aberta
const rotuloFaixa = ([a, b]) => b === null ? `>${a}` : `${a}-${b}`;
const conta = (lista, f) => lista.filter(f).length;
const soma = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
const mediana = v => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b), k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const classeDe = (m, base) => (m[base] === 'SEM_VENDA' ? 'SEM_VENDA' : m[base]);

/** Resultado de UM cenário sobre uma base ABC (reaplica a política; não depende do que o motor gravou). */
function simularCenario(metricas, nome, alvo, base = 'abc_revenue', opcoes = {}) {
  const linhas = metricas.map(m => {
    const c = classeDe(m, base) === 'SEM_VENDA' ? 'C' : m[base];
    return { m, classe: classeDe(m, base), s: aplicarPolitica(m, c, alvo[c], { P: PARAMS, ...opcoes }) };
  });
  const comprar = linhas.filter(l => l.s.needs_purchase);
  const rupturaDemanda = linhas.filter(l => l.m.reason_codes.includes('STOCKOUT_RECENT_DEMAND'));
  const naoCoberta = rupturaDemanda.filter(l => !l.s.needs_purchase);
  const motivosNaoCoberta = {};
  for (const l of naoCoberta) for (const r of (l.s.excluded_by.length ? l.s.excluded_by : ['TARGET_ALREADY_MET'])) motivosNaoCoberta[r] = (motivosNaoCoberta[r] || 0) + 1;
  const porFornecedor = {};
  for (const l of comprar) { const f = l.m.last_supplier || 'SEM_FORNECEDOR'; (porFornecedor[f] = porFornecedor[f] || { produtos: 0, unidades: 0 }); porFornecedor[f].produtos++; porFornecedor[f].unidades += l.s.suggested_qty; }
  const grupos = Object.entries(porFornecedor).filter(([f]) => f !== 'SEM_FORNECEDOR').map(([, g]) => g);
  const prio = {};
  for (const l of comprar) { prio[l.s.priority] = prio[l.s.priority] || { produtos: 0, unidades: 0 }; prio[l.s.priority].produtos++; prio[l.s.priority].unidades += l.s.suggested_qty; }
  return {
    cenario: nome, base, alvo_dias: alvo, arredondamento: opcoes.arredondamento || 'CEIL',
    PRODUCTS_TO_BUY: comprar.length,
    UNITS_TO_BUY: soma(comprar, l => l.s.suggested_qty),
    por_classe: Object.fromEntries(CLASSES.map(c => [c, { produtos: conta(comprar, l => l.classe === c), unidades: soma(comprar.filter(l => l.classe === c), l => l.s.suggested_qty) }])),
    STOCKOUT_RECENT_DEMAND_COVERED: `${rupturaDemanda.length - naoCoberta.length}/${rupturaDemanda.length}`,
    stockout_recent_demand_not_covered_reasons: motivosNaoCoberta,
    EXCESS_PRODUCTS_EXCLUDED: conta(linhas, l => l.m.coverage.estado === 'COVERAGE_EXCESS' && !l.s.needs_purchase),
    excess_products_with_purchase: conta(comprar, l => l.m.coverage.estado === 'COVERAGE_EXCESS'),
    NEVER_SOLD_EXCLUDED: conta(linhas, l => l.m.never_sold && !l.s.needs_purchase),
    INACTIVE_EXCLUDED: conta(linhas, l => !l.m.active && !l.s.needs_purchase),
    NEW_PRODUCT_EXCLUDED: conta(linhas, l => l.m.new_product && !l.s.needs_purchase),
    INSUFFICIENT_DEMAND_EXCLUDED: conta(linhas, l => l.m.purchase_exclusions.includes('INSUFFICIENT_RECENT_DEMAND')),
    NEGATIVE_STOCK_CASES: conta(comprar, l => l.m.raw_stock < 0),
    RECENT_DECELERATION_INCLUDED: conta(comprar, l => l.m.velocity_signal === 'RECENT_DECELERATION'),
    RESERVED_DEMAND_INCLUDED: conta(comprar, l => l.m.demand_by_source_90d.RESERVED > 0),
    COST_RELIABLE_PRODUCTS: conta(comprar, l => l.m.cost_confidence === 'KNOWN_COST'),
    COST_UNRELIABLE_PRODUCTS: conta(comprar, l => l.m.cost_confidence === 'LOW_CONFIDENCE_COST'),
    NO_COST_PRODUCTS: conta(comprar, l => l.m.cost_confidence === 'NO_COST'),
    prioridade: prio,
    fornecedores: {
      SUPPLIER_GROUP_COUNT: grupos.length,
      sem_fornecedor: porFornecedor.SEM_FORNECEDOR ? porFornecedor.SEM_FORNECEDOR.produtos : 0,
      PRODUCTS_PER_SUPPLIER: { max: Math.max(0, ...grupos.map(g => g.produtos)), mediana: mediana(grupos.map(g => g.produtos)) },
      SUGGESTED_UNITS_PER_SUPPLIER: { max: Math.max(0, ...grupos.map(g => g.unidades)), mediana: mediana(grupos.map(g => g.unidades)) },
    },
  };
}

function resumoCalibracao(r) {
  const M = r.metricas;
  const base = r.abc_base;
  const P = r.params || PARAMS;
  const sim = (lista, n, alvo, b, o = {}) => simularCenario(lista, n, alvo, b, { P, ...o });
  const cenarios = Object.fromEntries(Object.entries(r.cenarios).map(([n, alvo]) => [n, sim(M, n, alvo, base)]));
  const cenariosUnidades = Object.fromEntries(Object.entries(r.cenarios).map(([n, alvo]) => [n, sim(M, n, alvo, 'abc_units')]));
  const arredondamento = Object.fromEntries(Object.entries(r.cenarios).map(([n, alvo]) => {
    const round = sim(M, n, alvo, base, { arredondamento: 'ROUND' });
    return [n, { CEIL: { produtos: cenarios[n].PRODUCTS_TO_BUY, unidades: cenarios[n].UNITS_TO_BUY }, ROUND: { produtos: round.PRODUCTS_TO_BUY, unidades: round.UNITS_TO_BUY } }];
  }));
  // Sensibilidade: produtos em desaceleração usando a média de 30d em vez de 90d
  const desacel = Object.fromEntries(Object.entries(r.cenarios).map(([n, alvo]) => {
    const alt = M.map(m => (m.velocity_signal === 'RECENT_DECELERATION' ? { ...m, policy_velocity: m.avg_daily[30] } : m));
    const s = sim(alt, n, alvo, base);
    return [n, { produtos: s.PRODUCTS_TO_BUY, unidades: s.UNITS_TO_BUY }];
  }));

  // Sensibilidade: demanda mínima em 90d para reposição automática (parâmetro provisório = 3 un)
  const demandaMinima = Object.fromEntries([1, 2, 3].map(min => {
    const alt = M.map(m => {
      const outras = m.purchase_exclusions.filter(e => e !== 'INSUFFICIENT_RECENT_DEMAND');
      const ok = outras.length === 0 && !m.never_sold && m.units[90] >= min;
      return { ...m, purchase_eligible: ok, purchase_exclusions: ok ? [] : (m.units[90] < min && !m.never_sold ? [...outras, 'INSUFFICIENT_RECENT_DEMAND'] : outras) };
    });
    return ['min_' + min + 'un', Object.fromEntries(Object.entries(r.cenarios).map(([n, alvo]) => { const x = sim(alt, n, alvo, base); return [n, { produtos: x.PRODUCTS_TO_BUY, unidades: x.UNITS_TO_BUY, ruptura_com_demanda_coberta: x.STOCKOUT_RECENT_DEMAND_COVERED, classe_C_produtos: x.por_classe.C.produtos }]; }))];
  }));

  const porClasse = {};
  for (const c of [...CLASSES, 'SEM_VENDA']) {
    const L = M.filter(m => classeDe(m, base) === c);
    porClasse[c] = {
      total: L.length,
      ruptura: conta(L, m => m.raw_stock === 0), negativo: conta(L, m => m.raw_stock < 0),
      critica: conta(L, m => m.coverage.estado === 'COVERAGE_CRITICAL'), baixa: conta(L, m => m.coverage.estado === 'COVERAGE_LOW'),
      ok: conta(L, m => m.coverage.estado === 'COVERAGE_OK'), excesso: conta(L, m => m.coverage.estado === 'COVERAGE_EXCESS'),
      sem_demanda: conta(L, m => m.coverage.estado === 'NO_DEMAND_OBSERVED'), historico_insuficiente: conta(L, m => m.coverage.estado === 'INSUFFICIENT_HISTORY'),
      ruptura_com_demanda_90d: conta(L, m => m.reason_codes.includes('STOCKOUT_RECENT_DEMAND')),
      sem_venda_120d: conta(L, m => m.raw_stock > 0 && m.days_since_last_sale >= 120),
      sem_venda_180d: conta(L, m => m.raw_stock > 0 && m.days_since_last_sale >= 180),
      sem_venda_365d: conta(L, m => m.raw_stock > 0 && m.days_since_last_sale >= 365),
      velocidade: Object.fromEntries(['RECENT_ACCELERATION', 'RECENT_DECELERATION', 'STABLE', 'INSUFFICIENT_HISTORY'].map(k => [k, conta(L, m => m.velocity_signal === k)])),
      histograma_cobertura_dias: Object.fromEntries(FAIXAS_COBERTURA.map(f => [rotuloFaixa(f), conta(L, m => m.coverage.dias !== null && m.coverage.dias > 0 && m.coverage.dias >= f[0] && (f[1] === null || m.coverage.dias < f[1]))])),
    };
  }
  const classesUnidades = Object.fromEntries([...CLASSES, 'SEM_VENDA'].map(c => [c, conta(M, m => m.abc_units === c)]));
  const cruzamentoABC = Object.fromEntries(CLASSES.map(a => [a, Object.fromEntries([...CLASSES, 'SEM_VENDA'].map(b => [b, conta(M, m => m.abc_revenue === a && m.abc_units === b)]))]));

  const matrizParado = Object.fromEntries([...CLASSES, 'SEM_VENDA'].map(c => [c, Object.fromEntries([...P.FAIXAS_PARADO].reverse().map(f => [f + '+', conta(M, m => classeDe(m, base) === c && m.dead_stock_band === f + '+')]))]));

  const zerados = M.filter(m => m.raw_stock === 0);
  const ruptura = {
    total_zerados: zerados.length,
    STOCKOUT_WITH_RECENT_DEMAND_30D: conta(zerados, m => m.units[30] > 0),
    STOCKOUT_WITH_RECENT_DEMAND_60D: conta(zerados, m => m.units[60] > 0),
    STOCKOUT_WITH_RECENT_DEMAND_90D: conta(zerados, m => m.units[90] > 0),
    STOCKOUT_WITHOUT_RECENT_DEMAND: conta(zerados, m => m.units[90] === 0),
    sem_demanda_mas_vendeu_em_365d: conta(zerados, m => m.units[90] === 0 && m.units[365] > 0),
    nunca_vendido: conta(zerados, m => m.never_sold),
    por_classe_com_demanda_90d: Object.fromEntries([...CLASSES, 'SEM_VENDA'].map(c => [c, conta(zerados, m => classeDe(m, base) === c && m.units[90] > 0)])),
  };

  const neg = M.filter(m => m.raw_stock < 0);
  const negativos = {
    total: neg.length,
    classe: Object.fromEntries(['NEGATIVE_WITH_RECENT_SALES', 'NEGATIVE_WITHOUT_RECENT_SALES', 'NEGATIVE_INACTIVE_PRODUCT', 'NEGATIVE_DATA_ANOMALY'].map(k => [k, conta(neg, m => m.negative_stock_class === k)])),
    magnitude: { '-1': conta(neg, m => m.raw_stock === -1), '-2..-5': conta(neg, m => m.raw_stock <= -2 && m.raw_stock >= -5), '-6..-10': conta(neg, m => m.raw_stock <= -6 && m.raw_stock >= -10), '<-10': conta(neg, m => m.raw_stock < -10) },
    por_abc: Object.fromEntries([...CLASSES, 'SEM_VENDA'].map(c => [c, conta(neg, m => classeDe(m, base) === c)])),
    elegiveis_reposicao: conta(neg, m => m.purchase_eligible),
    compra_extra_para_compensar_negativo: 0,   // por construção: AVAILABLE_STOCK_FOR_REPLENISHMENT = max(estoque, 0)
  };

  const nv = M.filter(m => m.never_sold);
  const nuncaVendidos = {
    total: nv.length,
    confianca: { HIGH: conta(nv, m => m.never_sold_confidence === 'HIGH'), MEDIUM: conta(nv, m => m.never_sold_confidence === 'MEDIUM'), LOW: conta(nv, m => m.never_sold_confidence === 'LOW') },
    estoque_positivo: conta(nv, m => m.raw_stock > 0), estoque_zero: conta(nv, m => m.raw_stock === 0), estoque_negativo: conta(nv, m => m.raw_stock < 0),
    ativos: conta(nv, m => m.active), inativos: conta(nv, m => !m.active),
    cadastro_confiavel: conta(nv, m => m.created_at_reliable), fornecedor_conhecido: conta(nv, m => m.suppliers.length > 0),
    excluidos_de_compra: conta(nv, m => !Object.values(m.scenarios).some(s => s.needs_purchase)),
  };

  const janelasNovo = Object.fromEntries([30, 60, 90].map(w => {
    const novos = M.filter(m => m.audit.days_observed !== null && m.audit.days_observed < w);
    const adicionais = novos.filter(m => !(m.audit.days_observed < 30));
    return [w + 'd', { novos: novos.length, a_mais_que_30d: adicionais.length, deixariam_faixa_de_parado: conta(adicionais, m => m.dead_stock_band !== null), deixariam_nunca_vendido: conta(adicionais, m => m.never_sold), perderiam_reposicao_automatica: conta(adicionais, m => m.purchase_eligible), sairiam_de_cobertura_calculada: conta(adicionais, m => m.coverage.dias !== null) }];
  }));

  const comVenda = M.filter(m => m.units[180] > 0);
  const velocidade = {
    distribuicao: Object.fromEntries(['RECENT_ACCELERATION', 'RECENT_DECELERATION', 'STABLE', 'INSUFFICIENT_HISTORY'].map(k => [k, conta(M, m => m.velocity_signal === k)])),
    SALES_STOPPED_RECENTLY: conta(M, m => m.sales_stopped_recently),
    distorcoes: {
      pico_7d_maior_que_2x_90d: conta(comVenda, m => m.units[7] >= 2 && m.avg_daily[7] > 2 * m.avg_daily[90]),
      media_30d_ge_1_25x_180d: conta(comVenda, m => m.avg_daily[30] >= 1.25 * m.avg_daily[180] && m.units[30] >= 3),
      media_180d_ge_2x_30d: conta(comVenda, m => m.avg_daily[180] >= 2 * m.avg_daily[30] && m.units[180] >= 6),
      velocidade_politica_acima_da_media_90d: conta(M, m => m.policy_velocity !== null && m.avg_daily[90] !== null && m.policy_velocity > m.avg_daily[90]),
    },
    limiares: { ACELERACAO_30_VS_90: P.ACELERACAO_30_VS_90, ACELERACAO_90_VS_ANTERIOR: P.ACELERACAO_90_VS_ANTERIOR, DESACELERACAO_30_VS_90: P.DESACELERACAO_30_VS_90, DESACELERACAO_90_VS_ANTERIOR: P.DESACELERACAO_90_VS_ANTERIOR, MIN_UNIDADES_180D: P.VELOCIDADE_MIN_UNIDADES_180D, MIN_DIAS_OBSERVADOS: P.VELOCIDADE_MIN_DIAS_OBSERVADOS },
    sensibilidade_desaceleracao_usando_30d: desacel,
  };

  // Concentração por fornecedor (último fornecedor comprovado). Diagnóstico — não classifica fornecedor.
  const concentracao = (lista) => {
    const n = {}; for (const m of lista) if (m.last_supplier) n[m.last_supplier] = (n[m.last_supplier] || 0) + 1;
    const v = Object.values(n).sort((a, b) => b - a), tot = lista.length || 1;
    return { produtos: lista.length, fornecedores: v.length, top1: v[0] || 0, top1_pct: Math.round((v[0] || 0) / tot * 1000) / 10, top3: (v[0] || 0) + (v[1] || 0) + (v[2] || 0), top3_pct: Math.round(((v[0] || 0) + (v[1] || 0) + (v[2] || 0)) / tot * 1000) / 10 };
  };
  const fornecedores = {
    com_fornecedor: conta(M, m => m.suppliers.length > 0), multiplos: conta(M, m => m.suppliers.length >= 2),
    concentracao_curva_A: concentracao(M.filter(m => classeDe(m, base) === 'A')),
    concentracao_ruptura_com_demanda: concentracao(M.filter(m => m.reason_codes.includes('STOCKOUT_RECENT_DEMAND'))),
  };

  const atencao = {}; for (const m of M) for (const c of m.reason_codes) atencao[c] = (atencao[c] || 0) + 1;
  const custo = { KNOWN_COST: conta(M, m => m.cost_confidence === 'KNOWN_COST'), LOW_CONFIDENCE_COST: conta(M, m => m.cost_confidence === 'LOW_CONFIDENCE_COST'), NO_COST: conta(M, m => m.cost_confidence === 'NO_COST') };
  const reservado = { produtos_com_reserva_90d: conta(M, m => m.demand_by_source_90d.RESERVED > 0), unidades_reservadas_90d: soma(M, m => m.demand_by_source_90d.RESERVED), unidades_concluidas_90d: soma(M, m => m.demand_by_source_90d.COMPLETED), outras_90d: soma(M, m => m.demand_by_source_90d.OTHER_STOCK_MOVED) };

  return { rules_version: r.rules_version, hoje: r.hoje, abc_base: base, cenarios, cenarios_base_unidades: cenariosUnidades, arredondamento, sensibilidade_demanda_minima_90d: demandaMinima, por_classe: porClasse, classes_abc_unidades: classesUnidades, cruzamento_abc_receita_x_unidades: cruzamentoABC, matriz_parado: matrizParado, ruptura, negativos, nunca_vendidos: nuncaVendidos, janelas_produto_novo: janelasNovo, velocidade, fornecedores, atencao, custo, reservado };
}

/** Linhas da Curva A com ID MASCARADO (mascarar = função id → rótulo). Sem nome/SKU/valor. */
function detalheCurvaA(r, mascarar) {
  return r.metricas.filter(m => m.abc_revenue === 'A').map(m => ({
    id: mascarar(m.product_id), current_stock: m.raw_stock, sales_30d: m.units[30], sales_60d: m.units[60], sales_90d: m.units[90],
    average_daily_sales: m.policy_velocity, coverage_days: m.coverage.dias, coverage_state: m.coverage.estado,
    suggested_qty: Object.fromEntries(Object.entries(m.scenarios).map(([n, s]) => [n, s.suggested_qty])),
    stockout: m.raw_stock === 0, negative_stock: m.raw_stock < 0, velocity_signal: m.velocity_signal, last_sale_date: m.last_sale_date,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Resumo da POLÍTICA OFICIAL (sugestão de m.suggestion) — só contagens/unidades.
 * Inclui a investigação factual de ruptura com demanda que NÃO recebeu sugestão (motivo por produto, sem identidade).
 */
function resumoPolitica(r) {
  const M = r.metricas;
  const sug = M.filter(m => m.suggestion.suggested_qty > 0);
  const porClasse = c => { const L = sug.filter(m => m.suggestion.abc_revenue === c || (c === 'C' && m.suggestion.abc_revenue === 'SEM_VENDA')); return { produtos: L.length, unidades: soma(L, m => m.suggestion.suggested_qty) }; };
  const rupturaDemanda = M.filter(m => m.reason_codes.includes('STOCKOUT_RECENT_DEMAND'));
  const naoSugeridas = rupturaDemanda.filter(m => !(m.suggestion.suggested_qty > 0));
  const motivo = m => {
    if (m.purchase_exclusions.includes('INACTIVE_PRODUCT')) return 'INACTIVE';
    if (m.purchase_exclusions.includes('NEW_PRODUCT')) return 'NEW_PRODUCT';
    if (m.purchase_exclusions.includes('KIT_NOT_SUPPORTED')) return 'KIT_NOT_SUPPORTED';
    if (m.purchase_exclusions.includes('NOT_STOCK_MOVING') || m.purchase_exclusions.includes('STOCK_UNKNOWN')) return 'DATA_ISSUE';
    if (m.purchase_exclusions.includes('INSUFFICIENT_RECENT_DEMAND')) return 'INSUFFICIENT_RECENT_DEMAND';
    if (!(m.policy_velocity > 0)) return 'INSUFFICIENT_HISTORY';
    return 'OTHER_RULE';
  };
  const motivos = {}; for (const m of naoSugeridas) { const k = motivo(m); motivos[k] = (motivos[k] || 0) + 1; }
  const detalhe = naoSugeridas.map(m => ({ motivo: motivo(m), exclusoes: m.purchase_exclusions, dias_observado: m.audit.days_observed, unidades_90d: m.units[90], estoque_bruto: m.raw_stock, velocidade: m.policy_velocity, primeira_evidencia_ha_dias: m.audit.days_observed, abc_receita: m.abc_revenue }));
  const prio = k => conta(sug, m => m.suggestion.priority === k);
  return {
    policy_version: r.policy_version,
    TOTAL_ELIGIBLE_PRODUCTS: conta(M, m => m.purchase_eligible),
    TOTAL_SUGGESTED_PRODUCTS: sug.length,
    TOTAL_SUGGESTED_UNITS: soma(sug, m => m.suggestion.suggested_qty),
    P1_PRODUCTS: prio('P1'), P2_PRODUCTS: prio('P2'), P3_PRODUCTS: prio('P3'), P4_PRODUCTS: prio('P4'),
    unidades_por_prioridade: Object.fromEntries(['P1', 'P2', 'P3', 'P4'].map(k => [k, soma(sug.filter(m => m.suggestion.priority === k), m => m.suggestion.suggested_qty)])),
    A: porClasse('A'), B: porClasse('B'), C: porClasse('C'),
    STOCKOUT_RECENT_DEMAND: rupturaDemanda.length,
    STOCKOUT_SUGGESTED: rupturaDemanda.length - naoSugeridas.length,
    STOCKOUT_NOT_SUGGESTED_REASONS: motivos,
    stockout_not_suggested_detail: detalhe,
    NEGATIVE_STOCK_TOTAL: conta(M, m => m.raw_stock < 0),
    NEGATIVE_STOCK_SUGGESTED: conta(sug, m => m.raw_stock < 0),
    NEVER_SOLD_EXCLUDED: conta(M, m => m.never_sold && !(m.suggestion.suggested_qty > 0)),
    INACTIVE_EXCLUDED: conta(M, m => !m.active && !(m.suggestion.suggested_qty > 0)),
    NEW_PRODUCT_EXCLUDED: conta(M, m => m.new_product && !(m.suggestion.suggested_qty > 0)),
    RECENT_DECELERATION_SUGGESTED: conta(sug, m => m.velocity_signal === 'RECENT_DECELERATION'),
    RECENT_ACCELERATION_SUGGESTED: conta(sug, m => m.velocity_signal === 'RECENT_ACCELERATION'),
    ELIGIBLE_TARGET_ALREADY_MET: conta(M, m => m.purchase_eligible && m.policy_velocity > 0 && !(m.suggestion.suggested_qty > 0)),
    COST_USED_IN_DECISION: false,
    divergencia_abc: { REVENUE_A_UNITS_C: conta(M, m => m.abc_divergence === 'REVENUE_A_UNITS_C'), REVENUE_C_UNITS_A: conta(M, m => m.abc_divergence === 'REVENUE_C_UNITS_A'), total_divergentes: conta(M, m => m.abc_divergence !== null) },
    cobertura_indicadores: { critica: conta(M, m => m.coverage.estado === 'COVERAGE_CRITICAL'), baixa: conta(M, m => m.coverage.estado === 'COVERAGE_LOW'), ok: conta(M, m => m.coverage.estado === 'COVERAGE_OK'), excesso: conta(M, m => m.coverage.estado === 'COVERAGE_EXCESS') },
  };
}

/** Quantis simples (valores ordenados; índice por piso). */
function quantis(v, qs = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const s = v.filter(x => x !== null && x !== undefined).sort((a, b) => a - b);
  return { n: s.length, ...Object.fromEntries(qs.map(q => ['p' + Math.round(q * 100), s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null])), max: s.length ? s[s.length - 1] : null };
}

/**
 * Análise de sensibilidade da exceção PRODUTO NOVO COM DEMANDA COMPROVADA sobre o resultado da Política vigente.
 * Não altera a política: simula, para cada regra candidata e cada método de quantidade, o que MUDARIA.
 * `regras` = { rótulo: regra } (formato de new_product.proven_demand). Só contagens/unidades; detalhe por produto
 * sai com ID MASCARADO (mascarar = id → rótulo).
 */
function analisarProdutoNovo(r, regras, { mascarar = id => id } = {}) {
  const P = r.params || PARAMS;
  const M = r.metricas;
  const novos = M.filter(m => m.new_product && m.new_product_evidence);
  const classe = m => (m.abc_revenue === 'SEM_VENDA' ? 'C' : m.abc_revenue);
  const outrasExclusoes = m => m.purchase_exclusions.filter(e => e !== 'NEW_PRODUCT');
  const qtd = (m, metodo) => {
    const v = velocidadeProdutoNovo(m.new_product_evidence, metodo);
    return aplicarPolitica({ ...m, purchase_eligible: true, purchase_exclusions: [], policy_velocity: v }, classe(m), P.ALVO_DIAS[classe(m)], { P }).suggested_qty;
  };
  const porRegra = {};
  for (const [rot, regra] of Object.entries(regras)) {
    const aceitos = novos.filter(m => avaliarDemandaComprovada(m.new_product_evidence, regra).accepted && outrasExclusoes(m).length === 0);
    const metodos = {};
    for (const [nomeM, metodo] of Object.entries(METODOS_QTD_PRODUTO_NOVO)) {
      const comQtd = aceitos.map(m => ({ m, q: qtd(m, metodo) })).filter(x => x.q > 0);
      metodos[nomeM] = { metodo, TOTAL_ADDITIONAL_PRODUCTS: comQtd.length, TOTAL_ADDITIONAL_UNITS: soma(comQtd, x => x.q),
        por_abc: Object.fromEntries(CLASSES.map(c => [c, { produtos: conta(comQtd, x => classe(x.m) === c), unidades: soma(comQtd.filter(x => classe(x.m) === c), x => x.q) }])) };
    }
    porRegra[rot] = {
      regra, NEW_PRODUCTS_ELIGIBLE: aceitos.length,
      NEW_PRODUCTS_STOCKOUT_ELIGIBLE: conta(aceitos, m => m.raw_stock === 0),
      NEW_PRODUCTS_NEGATIVE_ELIGIBLE: conta(aceitos, m => m.raw_stock < 0),
      aceitos_so_com_reservado: conta(aceitos, m => m.new_product_evidence.completed_units === 0 && m.new_product_evidence.reserved_units > 0),
      aceitos_com_venda_unica_grande: conta(aceitos, m => m.new_product_evidence.distinct_sale_days === 1),
      eligible_por_abc: Object.fromEntries(CLASSES.map(c => [c, conta(aceitos, m => classe(m) === c)])),
      metodos,
    };
  }
  const comDemanda = novos.filter(m => m.new_product_evidence.units_since_first_evidence > 0);
  const maduros = M.filter(m => !m.new_product && m.suggestion && m.suggestion.suggested_qty > 0);
  const excluidas = M.filter(m => m.new_product && m.reason_codes.includes('STOCKOUT_RECENT_DEMAND') && !(m.suggestion.suggested_qty > 0));
  return {
    NEW_PRODUCTS_TOTAL: novos.length,
    NEW_PRODUCTS_WITH_DEMAND: comDemanda.length,
    NEW_PRODUCTS_STOCKOUT: conta(novos, m => m.raw_stock === 0),
    NEW_PRODUCTS_NEGATIVE: conta(novos, m => m.raw_stock < 0),
    distribuicao_novos_com_demanda: {
      idade_dias: quantis(comDemanda.map(m => m.new_product_evidence.age_days)),
      unidades: quantis(comDemanda.map(m => m.new_product_evidence.units_since_first_evidence)),
      dias_distintos_com_venda: quantis(comDemanda.map(m => m.new_product_evidence.distinct_sale_days)),
      taxa_diaria_observada: quantis(comDemanda.map(m => m.new_product_evidence.observed_daily_rate)),
      venda_em_um_unico_dia: conta(comDemanda, m => m.new_product_evidence.distinct_sale_days === 1),
      so_reservado: conta(comDemanda, m => m.new_product_evidence.completed_units === 0 && m.new_product_evidence.reserved_units > 0),
      com_reservado: conta(comDemanda, m => m.new_product_evidence.reserved_units > 0),
    },
    referencia_maduros_sugeridos_taxa_diaria: Object.fromEntries(CLASSES.map(c => [c, quantis(maduros.filter(m => classe(m) === c).map(m => m.policy_velocity))])),
    por_regra: porRegra,
    exclusoes_reais_ruptura_com_demanda: excluidas.map(m => {
      const ev = m.new_product_evidence;
      return { MASKED_ID: mascarar(m.product_id), AGE_DAYS: ev.age_days, ABC_REVENUE: m.abc_revenue, ABC_UNITS: m.abc_units, RAW_STOCK: m.raw_stock,
        SALES_UNITS_SINCE_CREATION: ev.units_since_first_evidence, DISTINCT_SALE_DAYS: ev.distinct_sale_days, LARGEST_SINGLE_DAY_UNITS: ev.largest_single_day_units,
        COMPLETED_UNITS: ev.completed_units, RESERVED_UNITS: ev.reserved_units, OBSERVED_DAILY_RATE: ev.observed_daily_rate, RATE_30D: ev.signal_window_rate,
        RATE_90D_AVAILABLE: ev.velocity_window_rate, CURRENT_REASON_CODES: m.reason_codes,
        REGRAS_QUE_ACEITARIAM: Object.entries(regras).filter(([, rg]) => avaliarDemandaComprovada(ev, rg).accepted && outrasExclusoes(m).length === 0).map(([k]) => k),
        FALHAS_POR_REGRA: Object.fromEntries(Object.entries(regras).map(([k, rg]) => [k, avaliarDemandaComprovada(ev, rg).failed])),
        QTD_POR_METODO: Object.fromEntries(Object.entries(METODOS_QTD_PRODUTO_NOVO).map(([k, mt]) => [k, qtd(m, mt)])) };
    }),
  };
}

module.exports = { simularCenario, resumoCalibracao, resumoPolitica, detalheCurvaA, analisarProdutoNovo, quantis, FAIXAS_COBERTURA };
