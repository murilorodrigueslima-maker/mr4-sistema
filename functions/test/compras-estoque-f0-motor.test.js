'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · motor determinístico sobre fixtures sintéticas (uma situação por produto).
const S = require('../lib/compras/snapshot');
const M = require('../lib/compras/motor');
const K = require('../lib/compras/canonico');
const X = require('./fixtures/compras-estoque-f0');
const { POLITICA_1_0 } = require('../lib/compras/politica');   // suíte de regressão da 1.0 (versão fixada)

const c = X.cenario();
const snap = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: POLITICA_1_0 });
const m = id => snap.operacional.find(x => x.product_id === id);
const L = snap.resumo.listas;

describe('Modelo canônico', () => {
  test('dinheiro em centavos sem erro de ponto flutuante; valores inválidos → null', () => {
    expect(K.centavos('10.005')).toBe(1001); expect(K.centavos('0.1')).toBe(10); expect(K.centavos('')).toBeNull(); expect(K.centavos('abc')).toBeNull(); expect(K.centavos('-3.50')).toBe(-350);
  });
  test('data de cadastro em massa (14–15/04/2026) não é data de criação confiável', () => {
    expect(K.mapearProduto(X.produto('A')).created_at_reliable).toBe(false);
    expect(K.mapearProduto(X.produto('B', { cadastrado_em: '2025-02-01 10:00:00' })).created_at_reliable).toBe(true);
  });
  test('ERP não tem estoque mínimo → erp_min_stock=null e comparação marcada como indisponível', () => {
    expect(m('PX-FORTE').erp_min_stock).toBeNull();
    expect(m('PX-FORTE').below_erp_min_stock).toBe('ERP_MIN_STOCK_UNAVAILABLE');
  });
});

describe('Demanda: cancelamentos, orçamentos, duplicatas e datas', () => {
  test('venda cancelada e venda sem baixa de estoque NÃO contam como demanda', () => {
    expect(m('PX-CANCEL').units[30]).toBe(3);
    expect(m('PX-CANCEL').excluded_sales_lines).toBe(2);
    expect(m('PX-SOCANCEL').never_sold).toBe(true);
  });
  test.each(['Cancelada', 'Venda cancelada', 'CANCELADO', 'Não fechou'])('situação "%s" é excluída', st => {
    expect(K.contaComoDemanda({ situacao_estoque: '1', nome_situacao: st })).toBe(false);
  });
  test('venda com data futura não conta (nem como última venda)', () => {
    expect(m('PX-FORTE').last_sale_date <= X.HOJE).toBe(true);
    expect(m('PX-FORTE').future_dated_sales_lines).toBe(1);
    expect(m('PX-FORTE').days_since_last_sale).toBeGreaterThanOrEqual(0);
  });
  test('venda duplicada e compra duplicada contam uma vez só (dedupe por venda+linha / compra+linha)', () => {
    const v = X.venda(X.dia(5), [['PX-D', 4]], { id: 'VX-DUP' }), co = X.compra(X.dia(50), [['PX-D', 10]], { id: 'CX-DUP' });
    const fv = [v, v, v].flatMap(K.fatosDeVenda), fc = [co, co].flatMap(K.fatosDeCompra);
    const r = M.calcularTudo({ produtos: [K.mapearProduto(X.produto('PX-D', { estoque: 2 }))], fatosVenda: fv, fatosCompra: fc, hoje: X.HOJE });
    expect(r.metricas[0].units[30]).toBe(4);
    expect(r.duplicatas).toEqual({ vendas: 2, compras: 1 });
  });
  test('item vendido de produto que não existe mais é contado como órfão (auditável)', () => {
    expect(snap.resumo.produtos_de_venda_nao_encontrados).toBe(1);
  });
  test('OLDEST_SALES_DATE = venda de demanda mais antiga', () => { expect(snap.resumo.data_venda_mais_antiga).toBe('2022-01-10'); });
});

describe('Velocidade e janelas', () => {
  test('janelas 7/30/60/90/180/365 e médias 30/60/90 (2 un a cada 3 dias)', () => {
    const f = m('PX-FORTE');
    expect(f.units[90]).toBe(60); expect(f.units[30]).toBe(20); expect(f.units[180]).toBe(120); expect(f.units[7]).toBe(6);
    expect(f.avg_daily[90]).toBeCloseTo(0.667, 3); expect(f.avg_daily[30]).toBeCloseTo(0.667, 3);
  });
  test('produto observado há menos que a janela usa o período observado', () => {
    expect(m('PX-NOVO').audit.days_observed).toBe(8);
    expect(m('PX-NOVO').avg_daily[90]).toBeCloseTo(0.25, 3);
  });
});

describe('Cobertura (sem infinito; estados explícitos)', () => {
  test.each([
    ['PX-FORTE', 'COVERAGE_CRITICAL', 7.5], ['PX-BAIXO', 'COVERAGE_LOW', 22.5], ['PX-SEMCUSTO', 'COVERAGE_OK', 30],
    ['PX-EXCESSO', 'COVERAGE_EXCESS', 299.9], ['PX-RUPTURA', 'CURRENT_STOCKOUT', 0], ['PX-NEGATIVO', 'NEGATIVE_STOCK', null],
    ['PX-ZEROALTO', 'NO_DEMAND_OBSERVED', null], ['PX-NOVO', 'INSUFFICIENT_HISTORY', null], ['PX-NUNCA-LOW', 'INSUFFICIENT_HISTORY', null],
  ])('%s → %s (%s dias)', (id, estado, dias) => { expect(m(id).coverage).toEqual({ estado, dias }); });
  test('nenhuma cobertura é 9999/Infinity/NaN', () => {
    for (const x of snap.operacional) expect(x.coverage.dias === null || (Number.isFinite(x.coverage.dias) && x.coverage.dias < 9999)).toBe(true);
  });
});

describe('Ruptura, nunca vendido, dias sem venda, parado', () => {
  test('ruptura atual afirmada; ruptura histórica UNSUPPORTED (sem histórico de saldo)', () => {
    expect([...L.ruptura_atual].sort()).toEqual(['PX-INATIVO', 'PX-KIT', 'PX-RUPTURA']);
    expect(L.estoque_negativo).toEqual(['PX-NEGATIVO']);
    for (const x of snap.operacional) expect(x.historical_stockout).toBe('UNSUPPORTED');
  });
  test.each([
    ['PX-ZEROALTO', 'HIGH', 'HISTORICO_COBRE_A_VIDA_CONHECIDA'], ['PX-SOCANCEL', 'HIGH', 'HISTORICO_COBRE_A_VIDA_CONHECIDA'],
    ['PX-NUNCA-REC', 'MEDIUM', 'PRODUTO_RECENTE'], ['PX-NUNCA-ANTIGO', 'MEDIUM', 'VIDA_DO_PRODUTO_ANTERIOR_AO_HISTORICO'],
    ['PX-NUNCA-LOW', 'LOW', 'SEM_DATA_DE_INICIO_CONFIAVEL'],
  ])('nunca vendido %s → confiança %s (%s)', (id, conf, motivo) => {
    expect(m(id).never_sold).toBe(true); expect(m(id).never_sold_confidence).toBe(conf); expect(m(id).never_sold_reason).toBe(motivo);
  });
  test.each([[30, 35, '30+'], [60, 65, '60+'], [90, 95, '90+'], [120, 125, '120+'], [180, 185, '180+'], [365, 370, '365+']])('sem venda há %s+ dias (%s dias) → faixa %s com evidência de estoque', (n, dias, faixa) => {
    const x = m('PX-SEM' + n);
    expect(x.days_since_last_sale).toBe(dias); expect(x.dead_stock_band).toBe(faixa); expect(x.no_sale_qualifier).toBe('NO_SALES_WITH_STOCK_EVIDENCE');
    expect(L.parado[faixa]).toContain('PX-SEM' + n);
  });
  test('entrada de compra DEPOIS da última venda → histórico de estoque desconhecido no período', () => {
    expect(m('PX-SEMINCERTO').no_sale_qualifier).toBe('NO_SALES_STOCK_HISTORY_UNKNOWN');
  });
  test('estoque parado só com estoque > 0 (ruptura/negativo nunca entram em faixa)', () => {
    for (const x of snap.operacional) if (!(x.current_stock > 0)) expect(x.dead_stock_band).toBeNull();
  });
  test('venda zero e estoque alto → 365+ e nunca vendido de alta confiança', () => {
    expect(m('PX-ZEROALTO').dead_stock_band).toBe('365+'); expect(L.nunca_vendido_alta_confianca).toContain('PX-ZEROALTO');
  });
});

describe('Velocidade (sinal com limiares explícitos, não previsão) e produto novo', () => {
  test('aceleração / desaceleração / estável / insuficiente', () => {
    expect(m('PX-ACELERA').velocity_signal).toBe('RECENT_ACCELERATION'); expect(m('PX-QUEDA').velocity_signal).toBe('RECENT_DECELERATION');
    expect(m('PX-FORTE').velocity_signal).toBe('STABLE'); expect(m('PX-NOVO').velocity_signal).toBe('INSUFFICIENT_HISTORY'); expect(m('PX-CANCEL').velocity_signal).toBe('INSUFFICIENT_HISTORY');
  });
  test('produto novo marcado e fora de cobertura e de reposição automática', () => {
    expect([...L.produtos_novos].sort()).toEqual(['PX-NOVO', 'PX-NUNCA-REC']); expect(m('PX-NOVO').purchase_exclusions).toContain('NEW_PRODUCT');   // janela 60d
    for (const sc of Object.values(m('PX-NOVO').scenarios)) expect(sc.suggested_qty).toBe(0);
  });
});

describe('ABC', () => {
  test('ABC_REVENUE e ABC_UNITS calculados; sem venda em 365d → SEM_VENDA (não C); ABC_MARGIN BLOCKED', () => {
    expect(m('PX-FORTE').abc_revenue).toBe('A'); expect(m('PX-FORTE').abc_units).toBe('A');
    expect(m('PX-SEM365').abc_revenue).toBe('SEM_VENDA'); expect(m('PX-ZEROALTO').abc_units).toBe('SEM_VENDA');
    for (const x of snap.operacional) expect(x.abc_margin).toBe('BLOCKED');
    const n = L.abc_receita; expect(n.A.length + n.B.length + n.C.length + n.SEM_VENDA.length).toBe(c.produtos.length);
  });
  test('curvaABC: cortes 80/95 sobre participação acumulada', () => {
    const r = M.curvaABC([{ id: 'a', v: 70 }, { id: 'b', v: 15 }, { id: 'c', v: 10 }, { id: 'd', v: 5 }, { id: 'e', v: 0 }], 'v');
    expect(r).toEqual({ a: 'A', b: 'A', c: 'B', d: 'C', e: 'SEM_VENDA' });
  });
});

describe('Fornecedor, mínimo calculado, sugestão explicável', () => {
  test('vínculo só por item de compra CONFIRMADA; cancelada/pendente não vinculam; último fornecedor por data', () => {
    expect([...m('PX-FORTE').suppliers].sort()).toEqual(['FX-1', 'FX-2']); expect(m('PX-FORTE').last_supplier).toBe('FX-2');
    expect(m('PX-PENDENTE').suppliers).toEqual(['FX-3']); expect(m('PX-PENDENTE').pending_purchases).toBe(1);
    expect([...L.sem_fornecedor].sort()).toEqual(['PX-NUNCA-ANTIGO', 'PX-NUNCA-LOW', 'PX-SEMCUSTO']);
  });
  test('CALCULATED_MIN_STOCK = ceil(média 90d × 15) e flag abaixo do mínimo calculado', () => {
    expect(m('PX-FORTE').calculated_min_stock).toBe(11); expect(m('PX-FORTE').below_calculated_min_stock).toBe(true);
    expect(m('PX-EXCESSO').below_calculated_min_stock).toBe(false); expect(m('PX-ZEROALTO').calculated_min_stock).toBeNull();
  });
  test('elegíveis para reposição: ativos, movimentam estoque, não kit, não nunca vendidos, não novos, demanda ≥ 3 un/90d', () => {
    expect([...L.compra_por_cenario.BALANCED].sort()).toEqual(['PX-BAIXO', 'PX-FORTE', 'PX-NEGATIVO', 'PX-PENDENTE', 'PX-RUPTURA']);
  });
  test('quantidade por cenário = ceil(velocidade × dias da classe) − estoque disponível; motivos rastreáveis', () => {
    const f = m('PX-FORTE').scenarios;   // classe A, velocidade 0,667/dia, estoque 5
    expect([f.CONSERVATIVE.suggested_qty, f.BALANCED.suggested_qty, f.LEAN.suggested_qty]).toEqual([26, 16, 10]);
    expect(f.BALANCED).toMatchObject({ class: 'A', target_days: 30, target_stock: 20.01, calculated_need: 15.01, priority: 'P2' });   // ceil(15,01) = 16
    expect(m('PX-FORTE').reason_codes).toEqual(['LOW_COVERAGE', 'LEAD_TIME_UNKNOWN']);
    expect(m('PX-RUPTURA').reason_codes[0]).toBe('STOCKOUT_RECENT_DEMAND');
    expect(m('PX-PENDENTE').reason_codes).toContain('PENDING_PURCHASE_EXISTS');
  });
  test('estoque negativo: quantidade parte de 0 (sem compra extra para compensar) e sinaliza NEGATIVE_STOCK', () => {
    expect(m('PX-NEGATIVO').reason_codes).toContain('NEGATIVE_STOCK'); expect(m('PX-NEGATIVO').available_stock_for_replenishment).toBe(0);
    expect(m('PX-NEGATIVO').scenarios.BALANCED.suggested_qty).toBe(6);   // ceil(0,2 × 30) − 0; NÃO 6 + 2
  });
  test('inativo e kit nunca sugeridos, com motivo', () => {
    expect(m('PX-INATIVO').purchase_exclusions).toEqual(['INACTIVE_PRODUCT']); expect(m('PX-KIT').purchase_exclusions).toEqual(['KIT_NOT_SUPPORTED']);
    for (const id of ['PX-INATIVO', 'PX-KIT']) for (const sc of Object.values(m(id).scenarios)) expect(sc.suggested_qty).toBe(0);
  });
  test('auditoria por produto: estoque, janela, média, velocidade de política, cobertura, versão das regras', () => {
    expect(m('PX-FORTE').audit).toEqual({ rules_version: M.RULES_VERSION, policy_version: '1.0', sales_window_days: 90, units_90d: 60, avg_daily_90d: 0.667, policy_velocity: 0.667, coverage_days: 7.5, days_observed: 200, demand_lines: 61 });
  });
});

describe('Custo e separação operacional × custo', () => {
  test('documento operacional NÃO tem custo, preço, faturamento nem valor de estoque', () => {
    const txt = JSON.stringify(snap.operacional) + JSON.stringify(snap.resumo);
    expect(txt).not.toMatch(/_cents|price|stock_value|valor_custo|valor_venda|faturamento/i);
    expect(txt).not.toMatch(/Produto sintético/);   // nomes ficam fora dos documentos agregados
  });
  test('documento de custo: custo cadastrado, último custo de compra, valor INDICATIVO, confiança por produto; sem custo → null', () => {
    const k = id => snap.custos.find(x => x.product_id === id);
    expect(k('PX-FORTE')).toMatchObject({ registered_cost_cents: 1000, last_purchase_cost_cents: 1000, indicative_registered_cost_value_cents: 5000, cost_confidence: 'KNOWN_COST' });
    expect(k('PX-SEMCUSTO').registered_cost_cents).toBeNull(); expect(k('PX-SEMCUSTO').indicative_registered_cost_value_cents).toBeNull();
    expect(k('PX-NEGATIVO').indicative_registered_cost_value_cents).toBeNull();
  });
  test('limitações estruturais publicadas no resumo', () => {
    expect(snap.resumo.limitacoes.join(' ')).toMatch(/HISTORICAL_STOCK_BALANCE_AVAILABLE=NO[\s\S]*LEAD_TIME_SUPPORT=NO[\s\S]*COST_CONFIDENCE=LOW[\s\S]*ABC_MARGIN=BLOCKED/);
  });
  test('determinístico: mesma entrada → mesma saída', () => {
    const c2 = X.cenario();
    const s2 = S.montarSnapshot({ brutosProdutos: c2.produtos, brutosVendas: c2.vendas, brutosCompras: c2.compras, agora: X.AGORA, politica: POLITICA_1_0 });
    expect(s2.operacional).toEqual(snap.operacional); expect(s2.resumo.listas).toEqual(snap.resumo.listas);
  });
});
