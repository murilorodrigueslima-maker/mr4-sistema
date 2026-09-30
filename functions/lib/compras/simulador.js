(function (raiz, fabrica) {
  'use strict';
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api; else raiz.ComprasSimulador = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // SIMULADOR DE ORÇAMENTO — "tenho R$ X para comprar" (Política 1.2). Função PURA, determinística, sem I/O, sem relógio, sem IA.
  // Mesmo arquivo roda no servidor (testes/relatório) e na tela (cópia idêntica em js/, conferida por teste).
  // NÃO altera nada: não cria pedido, não grava sugestão, não muda estoque nem política. Dinheiro em CENTAVOS inteiros; quantidades inteiras.
  // Invariantes: quantidade simulada ≤ quantidade da Política 1.1 · gasto ≤ orçamento · resultado independe da ordem de entrada.
  // cfg = { p1_floor_days, priorities[], scale: { bps, pct_divisor, ratio_digits } } (vem da política; nada é fixo aqui).
  const arredonda = x => Math.sign(x) * Math.round(Math.abs(x));
  const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const ehNum = v => typeof v === 'number' && Number.isFinite(v);
  const ordemPrioridade = p => ({ P1: 1, P2: 2, P3: 3, P4: 4 }[p] || 9);
  // maior eficiência primeiro; sem eficiência calculável vai para o fim (nunca NaN)
  const eficienciaDesc = (a, b) => { const x = ehNum(a.efficiency), y = ehNum(b.efficiency); return x && y ? b.efficiency - a.efficiency : x ? -1 : y ? 1 : 0; };
  const ORDENS = {
    OPERATIONAL: (a, b) => ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || b.qty - a.qty || cmpId(a.id, b.id),
    EFFICIENCY: (a, b) => eficienciaDesc(a, b) || ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || cmpId(a.id, b.id),
    PROTECT_P1_THEN_EFFICIENCY: (a, b) => (a.priority === 'P1' ? 0 : 1) - (b.priority === 'P1' ? 0 : 1) || (a.priority === 'P1' ? ORDENS.OPERATIONAL(a, b) : eficienciaDesc(a, b) || ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || cmpId(a.id, b.id)),
    // camadas: mantém a prioridade operacional e ordena por eficiência DENTRO de cada prioridade
    LAYERED: (a, b) => ordemPrioridade(a.priority) - ordemPrioridade(b.priority) || eficienciaDesc(a, b) || b.qty - a.qty || cmpId(a.id, b.id),
  };
  // piso do P1: cobre `p1_floor_days` de demanda (velocidade da política), no mínimo 1 un e nunca acima da sugestão 1.1
  const pisoP1 = (i, cfg) => Math.min(i.qty, Math.max(1, Math.ceil((i.velocity > 0 ? i.velocity : 0) * cfg.p1_floor_days)));
  const FASES = {
    OPERATIONAL: () => [{ ordem: 'OPERATIONAL' }],
    EFFICIENCY: () => [{ ordem: 'EFFICIENCY' }],
    PROTECT_P1_THEN_EFFICIENCY: () => [{ filtro: i => i.priority === 'P1', ordem: 'OPERATIONAL' }, { ordem: 'EFFICIENCY' }],
    LAYERED: () => [{ ordem: 'LAYERED' }],
    // piso mínimo para TODO P1 antes de qualquer otimização; depois camadas (prioridade operacional, eficiência dentro da camada)
    LAYERED_P1_FLOOR: cfg => [{ filtro: i => i.priority === 'P1', ordem: 'OPERATIONAL', teto: i => pisoP1(i, cfg) }, { ordem: 'LAYERED' }],
  };
  const ESTRATEGIAS = Object.keys(FASES);
  const soma = (l, f) => l.reduce((t, x) => t + (f(x) || 0), 0);

  /** Capital mínimo para cobrir `p1_floor_days` de TODOS os P1 com custo (CAPITAL_MINIMO_P1_7D). */
  function capitalMinimoP1(itens, cfg) {
    const p1 = itens.filter(i => i.priority === 'P1' && i.qty > 0);
    const com = p1.filter(i => i.cost_cents > 0);
    return { products: p1.length, products_without_cost: p1.length - com.length, units: soma(com, i => pisoP1(i, cfg)), capital_cents: soma(com, i => pisoP1(i, cfg) * i.cost_cents), total_capital_cents: soma(com, i => i.qty * i.cost_cents), total_units: soma(com, i => i.qty) };
  }

  function simular(itens, orcamentoCents, estrategia, cfg) {
    if (!FASES[estrategia]) throw new Error('ESTRATEGIA_INVALIDA: ' + estrategia);
    if (!(Number.isInteger(orcamentoCents) && orcamentoCents >= 0)) throw new Error('ORCAMENTO_INVALIDO');
    const orcaveis = itens.filter(i => i.qty > 0 && i.cost_cents > 0), semCusto = itens.filter(i => i.qty > 0 && !(i.cost_cents > 0));
    let resto = orcamentoCents; const aloc = new Map(), sequencia = [];
    for (const fase of FASES[estrategia](cfg)) {
      const lista = orcaveis.filter(fase.filtro || (() => true)).sort(ORDENS[fase.ordem]);
      for (const i of lista) {
        const ja = aloc.get(i.id) || 0, teto = Math.min(i.qty, fase.teto ? fase.teto(i) : i.qty);
        const q = Math.min(teto - ja, Math.floor(resto / i.cost_cents));      // inteiro; nunca acima da sugestão operacional (1.1)
        if (q >= 1) { if (!aloc.has(i.id)) sequencia.push(i.id); aloc.set(i.id, ja + q); resto -= q * i.cost_cents; }
      }
    }
    // itens na ORDEM EM QUE FORAM FINANCIADOS (os comparadores desempatam por id ⇒ resultado independe da ordem de entrada)
    const porId = new Map(orcaveis.map(i => [i.id, i]));
    const alocados = sequencia.map(id => porId.get(id)).map(i => ({ id: i.id, priority: i.priority, qty_1_1: i.qty, qty_1_2: aloc.get(i.id), capital_cents: aloc.get(i.id) * i.cost_cents, revenue_cents: i.price_cents > 0 ? aloc.get(i.id) * i.price_cents : null,
      p1_floor_met: i.priority === 'P1' ? aloc.get(i.id) >= pisoP1(i, cfg) : null }));
    const precificados = alocados.filter(a => a.revenue_cents !== null);
    const rec = soma(precificados, a => a.revenue_cents), capP = soma(precificados, a => a.capital_cents);
    const S = cfg.scale;
    const margem = (r, c) => (r > 0 ? arredonda((r - c) * S.bps / r) / S.pct_divisor : null);
    const retorno = (r, c) => (c > 0 ? arredonda((r - c) * S.ratio_digits / c) / S.ratio_digits : null);
    const porPrio = {};
    for (const pr of cfg.priorities) {
      const tot = orcaveis.filter(i => i.priority === pr), al = alocados.filter(a => a.priority === pr);
      porPrio[pr] = { products: tot.length, units_needed: soma(tot, i => i.qty), units_funded: soma(al, a => a.qty_1_2), products_fully_funded: al.filter(a => a.qty_1_2 === a.qty_1_1).length, products_unfunded: tot.length - al.length,
        capital_needed_cents: soma(tot, i => i.qty * i.cost_cents), capital_funded_cents: soma(al, a => a.capital_cents) };
    }
    // compra completa (1.1) precificada — referência para "o que foi preservado / perdido"
    const fullPrec = orcaveis.filter(i => i.price_cents > 0), fullRec = soma(fullPrec, i => i.qty * i.price_cents), fullCap = soma(fullPrec, i => i.qty * i.cost_cents);
    const min = capitalMinimoP1(itens, cfg), p1 = alocados.filter(a => a.priority === 'P1');
    const p1Info = { products: min.products, products_with_cost: porPrio.P1 ? porPrio.P1.products : 0, funded: p1.length, unfunded: (porPrio.P1 ? porPrio.P1.products : 0) - p1.length, floor_covered: p1.filter(a => a.p1_floor_met).length,
      floor_uncovered: (porPrio.P1 ? porPrio.P1.products : 0) - p1.filter(a => a.p1_floor_met).length, minimum_capital_floor_cents: min.capital_cents, total_capital_cents: min.total_capital_cents, products_without_cost: min.products_without_cost };
    const insuficiente = estrategia === 'LAYERED_P1_FLOOR' && orcamentoCents < min.capital_cents;
    return { strategy: estrategia, budget_cents: orcamentoCents, spent_cents: orcamentoCents - resto, left_cents: resto, products_funded: alocados.length, units_funded: soma(alocados, a => a.qty_1_2),
      units_needed: soma(orcaveis, i => i.qty), capital_needed_cents: soma(orcaveis, i => i.qty * i.cost_cents), revenue_potential_cents: rec, gross_profit_potential_cents: rec - capP,
      gross_margin_pct: margem(rec, capP), gross_return_on_capital: retorno(rec, capP),
      full: { products: orcaveis.length, units: soma(orcaveis, i => i.qty), capital_cents: soma(orcaveis, i => i.qty * i.cost_cents), priced_capital_cents: fullCap, revenue_potential_cents: fullRec, gross_profit_potential_cents: fullRec - fullCap, gross_margin_pct: margem(fullRec, fullCap), gross_return_on_capital: retorno(fullRec, fullCap) },
      p1: p1Info, alerts: insuficiente ? ['P1_FLOOR_INSUFFICIENT'] : [],
      by_priority: porPrio, unbudgeted_no_cost: semCusto.map(i => i.id).sort(cmpId), items: alocados };
  }
  return { ESTRATEGIAS, ORDENS, simular, capitalMinimoP1, pisoP1 };
});
