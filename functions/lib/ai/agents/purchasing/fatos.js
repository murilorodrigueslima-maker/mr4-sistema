'use strict';
// AGENTE DE COMPRAS — fatos por produto, resumo (sobre TODA a lista do motor) e rankings. NADA aqui recalcula o motor: quantidade, prioridade, custo,
// capital, margem e retorno vêm prontos de compras_n0_view/{sugestoes,custos}; só são DERIVADOS sinais (códigos) por comparação simples e contagens.
// Única métrica nova: impactoReceitaDia = velocidade (motor) × preço estimado (motor) — produto de dois fatos, só para a gestão.
const reais = c => (typeof c === 'number' && Number.isFinite(c) ? Math.round(c) / 100 : null);
const ehNum = v => typeof v === 'number' && Number.isFinite(v);
const RISCO = new Set(['CURRENT_STOCKOUT', 'NEGATIVE_STOCK', 'COVERAGE_CRITICAL', 'COVERAGE_LOW']);
const CRITICOS_NAO_ADIAR = new Set(['CURRENT_STOCKOUT', 'NEGATIVE_STOCK', 'COVERAGE_CRITICAL']);
const SEM_VENDA = ['NO_SALE_365D', 'NO_SALE_180D', 'NO_SALE_120D'];
const ORDEM_PRIO = { P1: 1, P2: 2, P3: 3, P4: 4 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpId = (a, b) => cmp(String(a), String(b));

/** Fatos + sinais de UMA linha da visão. gestao=false → nenhum campo financeiro (custo, margem, capital, preço, lucro). */
function fatosDaLinha(l, k, gestao) {
  const aten = l.attention_reasons || [], motivos = l.motivos || [], f = {}, s = [];
  const prio = l.prioridade || null, qtd = l.qtd > 0 ? l.qtd : 0, est = l.cobertura_estado || null;
  if (prio) f.prioridade = prio;
  if (l.abc) f.curvaAbc = String(l.abc);
  if (ehNum(l.estoque)) f.estoque = l.estoque;
  if (ehNum(l.cobertura_dias)) f.coberturaDias = l.cobertura_dias;
  if (est) f.coberturaEstado = est;
  if (ehNum(l.alvo_dias)) f.alvoDias = l.alvo_dias;
  if (ehNum(l.velocidade)) f.velocidadeDia = l.velocidade;
  if (l.vendas && ehNum(l.vendas.d30)) f.vendas30d = l.vendas.d30;
  if (l.vendas && ehNum(l.vendas.d90)) f.vendas90d = l.vendas.d90;
  f.qtdSugerida = qtd;
  // sinais operacionais (todos derivados de campos do motor)
  if (est === 'CURRENT_STOCKOUT') s.push('RUPTURA_ATUAL');
  if (l.estoque_negativo || est === 'NEGATIVE_STOCK') s.push('ESTOQUE_NEGATIVO');
  if (est === 'COVERAGE_CRITICAL') s.push('COBERTURA_CRITICA');
  if (est === 'COVERAGE_LOW') s.push('COBERTURA_BAIXA');
  if (qtd > 0 && ehNum(l.cobertura_dias) && l.alvo_dias > 0 && l.cobertura_dias < l.alvo_dias) s.push('COBERTURA_ABAIXO_DO_ALVO');
  const risco = RISCO.has(est) && l.velocidade > 0; if (risco) s.push('RISCO_RUPTURA');
  if (l.abc_unidades === 'A') s.push('VELOCIDADE_ELEVADA');
  if (motivos.includes('RECENT_ACCELERATION')) s.push('ACELERACAO_RECENTE');
  if (qtd > 0) s.push('SUGESTAO_DO_MOTOR');
  if (qtd > 0 && prio === 'P4' && !CRITICOS_NAO_ADIAR.has(est)) s.push('PODE_AGUARDAR');
  if (aten.includes('EXCESS_COVERAGE')) s.push('COBERTURA_EXCESSO');
  if (SEM_VENDA.some(x => aten.includes(x))) s.push('SEM_VENDA_RECENTE');
  if (aten.includes('NEVER_SOLD')) s.push('NUNCA_VENDIDO');
  if (aten.includes('NEW_PRODUCT_PROTECTED')) s.push('PRODUTO_NOVO_PROTEGIDO');
  let impacto = null;
  if (gestao && qtd > 0) {
    const fin = (k && k.fin) || null, c = (fin && fin.cost) || {}, p = (fin && fin.price) || {}, pu = (fin && fin.purchase) || {}, d = (fin && fin.decision) || {}, m = (fin && fin.margin) || {};
    if (fin) {
      const cu = c.unit_cents > 0 ? c.unit_cents : null;
      if (cu !== null) { f.custoUnitario = reais(cu); f.custoConfianca = String(c.confidence || 'UNKNOWN'); }
      if (p.unit_cents > 0) f.precoUnitario = reais(p.unit_cents);
      if (ehNum(pu.capital_cents)) f.capitalNecessario = reais(pu.capital_cents); else if (cu !== null) f.capitalNecessario = reais(cu * qtd);
      if (ehNum(pu.revenue_potential_cents)) f.receitaPotencial = reais(pu.revenue_potential_cents);
      if (ehNum(pu.profit_potential_cents)) f.lucroPotencial = reais(pu.profit_potential_cents);
      if (m.status === 'AVAILABLE' && fin.unit && ehNum(fin.unit.margin_pct)) f.margemPct = fin.unit.margin_pct;
      if (ehNum(pu.return_on_capital)) f.retornoPct = Math.round(pu.return_on_capital * 10000) / 100;
      if (cu === null) s.push('SEM_CUSTO'); else if (c.confidence === 'LOW' || c.confidence === 'UNKNOWN') s.push('CUSTO_BAIXA_CONFIANCA');
      if (d.margin_tier === 'NEGATIVE') s.push('MARGEM_NEGATIVA'); else if (d.margin_tier === 'LOW') s.push('MARGEM_BAIXA'); else if (d.margin_tier === 'HIGH') s.push('MARGEM_ALTA');
      if (d.attractiveness === 'HIGH') s.push('RETORNO_ALTO'); else if (d.attractiveness === 'LOW') s.push('RETORNO_BAIXO');
      if ((d.signals || []).includes('HIGH_DEMAND_LOW_MARGIN')) s.push('ALTA_DEMANDA_MARGEM_BAIXA');
      if (d.matrix === 'LOW_CAPITAL_ATTRACTIVENESS') s.push('CAPITAL_POUCO_ATRATIVO');
      if (cu !== null && p.unit_cents > 0 && l.velocidade > 0) { impacto = Math.round(l.velocidade * p.unit_cents) / 100; f.impactoReceitaDia = impacto; }
    } else if (k) {                                              // visão de custos sem Política 1.2: só a confiança grossa do motor 1.1
      if (k.confianca === 'NO_COST') s.push('SEM_CUSTO'); else if (k.confianca === 'LOW_CONFIDENCE_COST') s.push('CUSTO_BAIXA_CONFIANCA');
      if (ehNum(k.valor_sugestao_custo_conhecido_cents)) f.capitalNecessario = reais(k.valor_sugestao_custo_conhecido_cents);
    }
  }
  return { id: String(l.id), codigo: l.codigo || null, nome: l.nome || null, prioridade: prio, qtd, risco, impacto, capital: ehNum(f.capitalNecessario) ? f.capitalNecessario : null, estado: est, velocidade: ehNum(l.velocidade) ? l.velocidade : 0, coberturaDias: ehNum(l.cobertura_dias) ? l.cobertura_dias : null, f, sinais: s };
}

/** Todos os produtos da visão do motor → fatos. */
function fatosDaVisao(visao, gestao) {
  const custos = (visao.custos && visao.custos.linhas) || {};
  return (visao.sugestoes.linhas || []).map(l => fatosDaLinha(l, custos[l.id], gestao));
}

const tem = (p, c) => p.sinais.includes(c);
const porPrio = (a, b) => (ORDEM_PRIO[a.prioridade] || 9) - (ORDEM_PRIO[b.prioridade] || 9);
const desc = (f) => (a, b) => (f(b) - f(a));
/** Rankings determinísticos (listas de ids). A ordem "urgentes" é a do PRÓPRIO motor (prioridade, quantidade, id); empates sempre por id. */
function rankings(P, gestao) {
  const sug = P.filter(p => p.qtd > 0);
  const ord = (lista, ...cmps) => [...lista].sort((a, b) => { for (const c of cmps) { const r = c(a, b); if (r) return r; } return cmpId(a.id, b.id); }).map(p => p.id);
  const sevRisco = p => ({ NEGATIVE_STOCK: 0, CURRENT_STOCKOUT: 1, COVERAGE_CRITICAL: 2, COVERAGE_LOW: 3 }[p.estado] ?? 9);
  const r = {
    urgentes: ord(sug, porPrio, desc(p => p.qtd)),
    risco: ord(P.filter(p => p.risco), (a, b) => sevRisco(a) - sevRisco(b), porPrio, desc(p => p.velocidade)),
    adiar: ord(P.filter(p => tem(p, 'PODE_AGUARDAR')), gestao ? desc(p => p.capital || 0) : desc(p => p.qtd)),
    revisar: ord(sug.filter(p => ['MARGEM_NEGATIVA', 'ALTA_DEMANDA_MARGEM_BAIXA', 'CAPITAL_POUCO_ATRATIVO', 'CUSTO_BAIXA_CONFIANCA', 'SEM_CUSTO'].some(c => tem(p, c))), porPrio, gestao ? desc(p => p.capital || 0) : desc(p => p.qtd)),
    excesso: ord(P.filter(p => tem(p, 'COBERTURA_EXCESSO')), desc(p => p.coberturaDias || 0)),
  };
  if (gestao) {
    r.impacto = ord(P.filter(p => p.risco && ehNum(p.impacto)), desc(p => p.impacto));
    r.capital = ord(sug.filter(p => ehNum(p.capital)), desc(p => p.capital));
  }
  return r;
}

/** Resumo determinístico sobre TODA a lista. Totais financeiros: os do PRÓPRIO motor (resumo_financeiro), só gestão. */
function resumo(P, visao, gestao) {
  const c = visao.sugestoes.contagens || {}, sug = P.filter(p => p.qtd > 0), n = f => P.filter(f).length;
  const r = { produtosParaRepor: sug.length, unidadesSugeridas: sug.reduce((t, p) => t + p.qtd, 0), itensCriticos: n(p => p.qtd > 0 && p.prioridade === 'P1'), podemAguardar: n(p => tem(p, 'PODE_AGUARDAR')),
    riscoRuptura: n(p => p.risco), rupturaAtual: n(p => tem(p, 'RUPTURA_ATUAL')), estoqueNegativo: n(p => tem(p, 'ESTOQUE_NEGATIVO')),
    prioridadeP1: n(p => p.qtd > 0 && p.prioridade === 'P1'), prioridadeP2: n(p => p.qtd > 0 && p.prioridade === 'P2'), prioridadeP3: n(p => p.qtd > 0 && p.prioridade === 'P3'), prioridadeP4: n(p => p.qtd > 0 && p.prioridade === 'P4'),
    produtosEmAtencao: c.atencao && Number.isFinite(c.atencao.produtos) ? c.atencao.produtos : 0, coberturaEmExcesso: c.atencao && c.atencao.por_motivo && Number.isFinite(c.atencao.por_motivo.EXCESS_COVERAGE) ? c.atencao.por_motivo.EXCESS_COVERAGE : 0 };
  const rf = gestao && visao.custos && visao.custos.resumo_financeiro; const pu = rf && rf.purchase;
  if (pu) {
    r.capitalSugerido = reais(pu.capital_cents); r.produtosSemCusto = pu.unpriced_products; r.receitaPotencial = reais(pu.revenue_potential_cents); r.lucroBrutoPotencial = reais(pu.gross_profit_potential_cents);
    if (ehNum(pu.weighted_margin_pct)) r.margemAgregadaPct = pu.weighted_margin_pct; if (ehNum(pu.gross_return_on_capital)) r.retornoBrutoPct = Math.round(pu.gross_return_on_capital * 10000) / 100;
    const bp = rf.by_priority || {}; if (bp.P1) r.capitalP1 = reais(bp.P1.capital_cents); if (bp.P4) r.capitalP4 = reais(bp.P4.capital_cents);
    if (rf.review) { r.sugeridosCustoBaixaConfianca = rf.review.suggested_low_cost_confidence; r.sugeridosMargemNegativa = rf.review.suggested_negative_margin; }
    if (rf.p1_floor && ehNum(rf.p1_floor.capital_cents)) { r.capitalMinimoP1 = reais(rf.p1_floor.capital_cents); r.diasPisoP1 = rf.p1_floor.days; }
  }
  return r;
}

// ── foco da pergunta (palavras-chave; só escolhe QUAIS listas ganham mais espaço) e temas SEM DADO ─────────────────────────────
const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function detectarFoco(pergunta) {
  const t = norm(pergunta);
  if (/\b(adiar|aguardar|esperar|postergar|deixar para depois|segurar)\b/.test(t)) return 'ADIAR';
  if (/impacto|maior perda|vender mais|mais importante.*falt/.test(t)) return 'IMPACTO';
  if (/faltar|falta\b|ruptura|acabar|zerar|sem estoque/.test(t)) return 'RUPTURA';
  if (/demais|excesso|exagero|compro muito|comprando muito/.test(t)) return 'EXCESSO';
  if (/revis|conferir|duvid|suspeit|erro|custo.*(baix|confian)/.test(t)) return 'REVISAO';
  if (/quanto.*(capital|dinheiro|gast|invest)|capital sugerido|capital.*sugerid/.test(t)) return 'CAPITAL';
  if (/resumo|panorama|visao geral/.test(t)) return 'RESUMO';
  if (/urgent|hoje|agora|primeiro|prioridade|comprar|atencao|merece/.test(t)) return 'URGENTE';
  return 'GERAL';
}
const SEM_DADO = [['FORNECEDOR_PRECO_PRAZO', /fornecedor|desconto|negoci|barganh|prazo de entrega|lead ?time|frete|cota[cç]ao|condicao de pagamento|boleto|parcel/], ['PREVISAO_FUTURA', /previs|projec|prever|vai vender|vendera|proximo mes|sazonal|tendencia futura/],
  ['CONCORRENCIA_MERCADO', /concorren|mercado|preco do mercado/], ['CRIAR_PEDIDO', /\b(crie|criar|faca|fazer|envie|enviar|gere|gerar)\b.*\b(pedido|ordem de compra)\b|emitir pedido/]];
function temasSemDado(pergunta) { const t = norm(pergunta); return SEM_DADO.filter(([, re]) => re.test(t)).map(([c]) => c); }

module.exports = { fatosDaLinha, fatosDaVisao, rankings, resumo, detectarFoco, temasSemDado, reais, norm };
