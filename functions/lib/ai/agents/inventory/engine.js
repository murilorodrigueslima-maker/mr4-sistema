'use strict';
// AGENTE DE ESTOQUE — motor DETERMINÍSTICO (sem IA). Lê os fatos JÁ calculados pelo motor do módulo Compras & Estoque
// (compras_n0_produtos / compras_n0_custos) e apenas CLASSIFICA, CONTA e SELECIONA candidatos. Não recalcula demanda, velocidade,
// cobertura nem ABC (reutiliza); não altera nada no módulo Compras. Custo/capital só quando verCusto (regra real do módulo).
const { LIMIAR_SEM_VENDA_DIAS } = require('./catalogo');

const r2 = x => Math.round(x * 100) / 100;
const num = v => typeof v === 'number' && Number.isFinite(v);
const TEND = { STABLE: 'ESTAVEL', RECENT_ACCELERATION: 'ACELERANDO', RECENT_DECELERATION: 'DESACELERANDO', INSUFFICIENT_HISTORY: 'HISTORICO_INSUFICIENTE' };
const CONF_NUNCA = { HIGH: 'ALTA', MEDIUM: 'MEDIA', LOW: 'BAIXA' };
const ABC_ORDEM = { A: 0, B: 1, C: 2, SEM_VENDA: 3 };

/** Um produto → fatos + sinais. Retorna null se fora do escopo (inativo, não movimenta estoque, kit, saldo desconhecido). */
function classificarProduto(m, custo, { verCusto }) {
  if (!m || m.active === false || m.moves_stock === false || m.kit === true || !num(m.raw_stock)) return null;
  const estoque = m.raw_stock, u = m.units || {}, v30 = num(u['30']) ? u['30'] : 0, v90 = num(u['90']) ? u['90'] : 0;
  const novo = m.new_product === true;
  const dias = m.never_sold ? null : (num(m.days_since_last_sale) ? m.days_since_last_sale : null);
  const cov = m.coverage || {};
  const sinais = [];
  const s = { semVenda120: false, nunca: false, excesso: false, risco: false, ruptura: false, negativo: false, queda: false, acelera: false, giroAlto: false, parado: false, liquidar: false };
  if (estoque > 0 && !novo) {
    if (m.never_sold) s.nunca = true;
    else if (dias !== null && dias >= LIMIAR_SEM_VENDA_DIAS) s.semVenda120 = true;      // >= 120; 119 não (igual ao CRM)
  }
  if (cov.estado === 'COVERAGE_EXCESS') s.excesso = true;
  if (estoque > 0 && (cov.estado === 'COVERAGE_CRITICAL' || cov.estado === 'COVERAGE_LOW')) s.risco = true;
  if (estoque === 0 && v90 > 0) s.ruptura = true;
  if (estoque < 0) s.negativo = true;
  if (m.velocity_signal === 'RECENT_DECELERATION' || (m.sales_stopped_recently === true && estoque > 0)) s.queda = true;
  if (m.velocity_signal === 'RECENT_ACCELERATION') s.acelera = true;
  if (m.abc_units === 'A' && v90 > 0) s.giroAlto = true;
  s.parado = s.semVenda120 || s.nunca;
  s.liquidar = estoque > 0 && !novo && !s.acelera && (s.semVenda120 || s.excesso || (s.nunca && m.never_sold_confidence === 'HIGH'));
  // custo (só se permitido): capital = estoque × custo CADASTRADO (indicativo). Sem custo → ausente (nunca 0).
  let custoUnit = null, capital = null, confCusto = null;
  if (verCusto && custo) {
    if (num(custo.registered_cost_cents) && custo.registered_cost_cents > 0) { custoUnit = r2(custo.registered_cost_cents / 100); confCusto = custo.cost_confidence === 'KNOWN_COST' ? 'CONFIAVEL' : 'BAIXA'; }
    else confCusto = 'SEM_CUSTO';
    if (estoque > 0 && num(custo.indicative_registered_cost_value_cents)) capital = Math.round(custo.indicative_registered_cost_value_cents / 100);
  }
  if (capital !== null && s.parado) sinais.push('CAPITAL_PARADO');
  if (s.semVenda120) sinais.push('SEM_VENDA_120D'); if (s.nunca) sinais.push('NUNCA_VENDIDO'); if (s.excesso) sinais.push('ESTOQUE_EXCESSIVO');
  if (s.risco) sinais.push('RISCO_RUPTURA'); if (s.ruptura) sinais.push('RUPTURA_ATUAL'); if (s.negativo) sinais.push('ESTOQUE_NEGATIVO');
  if (s.queda) sinais.push('GIRO_EM_QUEDA'); if (s.acelera) sinais.push('GIRO_ACELERANDO'); if (s.giroAlto) sinais.push('GIRO_ALTO'); if (s.liquidar) sinais.push('CANDIDATO_LIQUIDACAO');
  const fatos = { estoque, vendas30d: v30, vendas90d: v90, curvaAbc: m.abc_revenue || 'SEM_VENDA', tendencia: TEND[m.velocity_signal] || 'HISTORICO_INSUFICIENTE' };
  if (dias !== null) fatos.diasSemVenda = dias;
  if (num(cov.dias)) fatos.coberturaDias = cov.dias;
  if (estoque > 0) fatos.giro90d = r2(v90 / estoque);
  if (m.never_sold) fatos.nuncaVendidoConfianca = CONF_NUNCA[m.never_sold_confidence] || 'BAIXA';
  if (custoUnit !== null) fatos.custoUnitario = custoUnit;
  if (capital !== null) fatos.capitalImobilizado = capital;
  if (confCusto !== null) fatos.confiancaCusto = confCusto;
  return { id: String(m.product_id), codigo: m.code || null, s, sinais, fatos, capital, abcOrdem: ABC_ORDEM[fatos.curvaAbc] === undefined ? 4 : ABC_ORDEM[fatos.curvaAbc], confCusto };
}

/** Classifica TODA a base e calcula o resumo (contagens sobre tudo; o contexto só leva candidatos). */
function analisarBase(produtos, custos, { verCusto }) {
  const custoPorId = new Map((custos || []).map(c => [String(c.product_id), c]));
  const itens = [], fora = { inativos: 0, kits: 0, semMovimento: 0, saldoDesconhecido: 0 };
  for (const m of produtos || []) {
    const it = classificarProduto(m, custoPorId.get(String(m.product_id)), { verCusto });
    if (it) itens.push(it);
    else if (m && m.active === false) fora.inativos++; else if (m && m.kit === true) fora.kits++; else if (m && m.moves_stock === false) fora.semMovimento++; else fora.saldoDesconhecido++;
  }
  itens.sort((a, b) => a.id.localeCompare(b.id));
  // concentração: 10 maiores capitais (só com custo)
  const comCapital = itens.filter(i => i.capital !== null && i.capital > 0).sort((a, b) => b.capital - a.capital || a.id.localeCompare(b.id));
  if (verCusto) for (const i of comCapital.slice(0, 10)) { i.sinais.push('CAPITAL_CONCENTRADO'); i.s.concentrado = true; }
  const n = f => itens.filter(f).length;
  const resumo = {
    produtosAnalisados: itens.length, riscoRuptura: n(i => i.s.risco), rupturaAtual: n(i => i.s.ruptura), estoqueNegativo: n(i => i.s.negativo),
    estoqueParado: n(i => i.s.parado), semVenda120d: n(i => i.s.semVenda120), nuncaVendidos: n(i => i.s.nunca), estoqueExcessivo: n(i => i.s.excesso),
    acelerando: n(i => i.s.acelera), desacelerando: n(i => i.fatos.tendencia === 'DESACELERANDO'), giroEmQueda: n(i => i.s.queda), candidatosLiquidacao: n(i => i.s.liquidar),
    fora,
  };
  if (verCusto) {
    const soma = f => comCapital.filter(f).reduce((t, i) => t + i.capital, 0);
    const total = soma(() => true), parado = soma(i => i.s.parado), confiavel = soma(i => i.confCusto === 'CONFIAVEL'), top10 = comCapital.slice(0, 10).reduce((t, i) => t + i.capital, 0);
    const semGiro = soma(i => i.fatos.curvaAbc === 'C' || i.fatos.curvaAbc === 'SEM_VENDA');
    const pct = x => (total > 0 ? Math.round(x / total * 1000) / 10 : null);
    resumo.capitalEmEstoque = total; resumo.capitalParado = parado; resumo.capitalCustoConfiavelPct = pct(confiavel); resumo.capitalTop10Pct = pct(top10); resumo.capitalCurvaCSemVendaPct = pct(semGiro);
    resumo.produtosEmEstoqueSemCusto = n(i => i.fatos.estoque > 0 && (i.fatos.confiancaCusto === 'SEM_CUSTO' || i.fatos.confiancaCusto === undefined));
  }
  return { itens, resumo, comCapital };
}

/** Alertas legíveis (determinísticos; só no retorno ao usuário, não vão ao modelo). */
function alertasDoResumo(r) {
  const out = [], p = (n, s, pl) => (n === 1 ? s : pl);
  if (r.estoqueNegativo) out.push({ codigo: 'ESTOQUE_NEGATIVO', n: r.estoqueNegativo, texto: `${r.estoqueNegativo} ${p(r.estoqueNegativo, 'produto com saldo negativo', 'produtos com saldo negativo')}: conferir lançamentos.` });
  if (r.rupturaAtual) out.push({ codigo: 'RUPTURA_ATUAL', n: r.rupturaAtual, texto: `${r.rupturaAtual} ${p(r.rupturaAtual, 'produto zerado', 'produtos zerados')} com venda nos últimos 90 dias.` });
  if (r.riscoRuptura) out.push({ codigo: 'RISCO_RUPTURA', n: r.riscoRuptura, texto: `${r.riscoRuptura} ${p(r.riscoRuptura, 'produto com cobertura', 'produtos com cobertura')} abaixo de 30 dias.` });
  if (r.semVenda120d) out.push({ codigo: 'SEM_VENDA_120D', n: r.semVenda120d, texto: `${r.semVenda120d} ${p(r.semVenda120d, 'produto', 'produtos')} com estoque e sem venda há 120 dias ou mais.` });
  if (r.nuncaVendidos) out.push({ codigo: 'NUNCA_VENDIDO', n: r.nuncaVendidos, texto: `${r.nuncaVendidos} ${p(r.nuncaVendidos, 'produto', 'produtos')} com estoque e nenhuma venda no histórico disponível.` });
  if (r.estoqueExcessivo) out.push({ codigo: 'ESTOQUE_EXCESSIVO', n: r.estoqueExcessivo, texto: `${r.estoqueExcessivo} ${p(r.estoqueExcessivo, 'produto', 'produtos')} com cobertura acima de 180 dias.` });
  if (r.capitalParado) out.push({ codigo: 'CAPITAL_PARADO', n: r.capitalParado, texto: `Capital parado (indicativo): R$ ${r.capitalParado.toLocaleString('pt-BR')}.` });
  return out.slice(0, 6);
}

// ── Intenção da pergunta (determinística, só para escolher candidatos; nunca decide fatos) ───────────────────────────────
const sem = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const RE_FOCO = [
  ['PARADOS', /parad|sem giro|encalhad|obsolet|imobiliz/], ['SEM_VENDA_120D', /120|sem venda|nao vend(e|em|eu)|quatro meses/], ['NUNCA_VENDIDO', /nunca (vend|sai)|jamais vend|nunca tiv/],
  ['EXCESSO', /exce[sc]|demais|sobra|muito estoque|estoque alto|cobertura alta/], ['RUPTURA', /falt|ruptura|acab|zerad|reposi|repor|negativ/], ['RAPIDOS', /mais rapid|vendem mais|mais vendid|giro alto|maior giro|campe|curva a\b|top\b/],
  ['QUEDA', /perd(endo|eu) giro|queda|desacelera|caindo|vendendo menos|diminu/], ['ACELERANDO', /acelera|crescendo|subindo/], ['CAPITAL', /dinheiro|capital|concentr|r\$|valor em estoque/], ['LIQUIDAR', /liquida|desova|queimar|escoar|promoc/],
  ['ATENCAO', /errado|aten[cç]|hoje|problema|resumo|priorid|olhar/],
];
const RE_NAO_SUPORTADO = [
  ['PREVISAO_DE_DEMANDA', /\b(vai|vou|vamos|va)\s+(vender|sair|esgotar|acabar|faltar)|venderao?\b|vendera\b|amanha|previs|prever|projec|forecast|demanda futura|proximos? (dias?|semanas?|mes(es)?|trimestres?|anos?)|semana que vem|mes que vem/],
  ['PRECO_OU_MARGEM', /preco de venda|margem|lucro|quanto (eu )?cobro|markup/], ['LEAD_TIME_OU_FORNECEDOR', /lead ?time|prazo de entrega|fornecedor|quem vende pra mim/],
  ['HISTORICO_DE_SALDO', /historico de (saldo|estoque)|ruptura (passada|anterior|historica)|estoque (de|em) (ontem|mes passado)/], ['ESTOQUE_MINIMO_DO_ERP', /estoque minimo/],
];
function interpretarPergunta(p) {
  const t = sem(p); const focos = RE_FOCO.filter(([, re]) => re.test(t)).map(([k]) => k);
  const naoSuportado = RE_NAO_SUPORTADO.filter(([, re]) => re.test(t)).map(([k]) => k);
  return { focos: focos.length ? focos : ['ATENCAO'], naoSuportado };
}

// ── Listas de candidatos por categoria (ordem determinística; empate por id) ─────────────────────────────────────────────
const porId = (a, b) => a.id.localeCompare(b.id);
const capDesc = (a, b) => (b.capital || 0) - (a.capital || 0) || (b.fatos.estoque - a.fatos.estoque) || porId(a, b);
const LISTAS = {
  SEM_VENDA_120D: { nome: 'SEM_VENDA_120D', pega: i => i.s.semVenda120, ordem: (a, b) => capDesc(a, b) || 0 },
  NUNCA_VENDIDO: { nome: 'NUNCA_VENDIDO', pega: i => i.s.nunca, ordem: capDesc },
  EXCESSO: { nome: 'ESTOQUE_EXCESSIVO', pega: i => i.s.excesso, ordem: (a, b) => (b.capital || 0) - (a.capital || 0) || ((b.fatos.coberturaDias || 0) - (a.fatos.coberturaDias || 0)) || porId(a, b) },
  RUPTURA: { nome: 'RISCO_RUPTURA', pega: i => i.s.risco || i.s.ruptura || i.s.negativo, ordem: (a, b) => (b.s.negativo - a.s.negativo) || (a.abcOrdem - b.abcOrdem) || ((a.fatos.coberturaDias ?? -1) - (b.fatos.coberturaDias ?? -1)) || (b.fatos.vendas90d - a.fatos.vendas90d) || porId(a, b) },
  RAPIDOS: { nome: 'GIRO_ALTO', pega: i => i.fatos.vendas90d > 0, ordem: (a, b) => (b.fatos.vendas90d - a.fatos.vendas90d) || (b.fatos.vendas30d - a.fatos.vendas30d) || porId(a, b) },
  QUEDA: { nome: 'GIRO_EM_QUEDA', pega: i => i.s.queda, ordem: (a, b) => (b.capital || 0) - (a.capital || 0) || (b.fatos.vendas90d - a.fatos.vendas90d) || porId(a, b) },
  ACELERANDO: { nome: 'GIRO_ACELERANDO', pega: i => i.s.acelera, ordem: (a, b) => (b.fatos.vendas30d - a.fatos.vendas30d) || porId(a, b) },
  CAPITAL: { nome: 'CAPITAL', pega: i => i.capital !== null && i.capital > 0, ordem: (a, b) => (b.capital - a.capital) || porId(a, b) },
  LIQUIDAR: { nome: 'CANDIDATO_LIQUIDACAO', pega: i => i.s.liquidar, ordem: capDesc },
};
const FOCO_PARA_LISTAS = {
  PARADOS: ['SEM_VENDA_120D', 'NUNCA_VENDIDO'], SEM_VENDA_120D: ['SEM_VENDA_120D'], NUNCA_VENDIDO: ['NUNCA_VENDIDO'], EXCESSO: ['EXCESSO'], RUPTURA: ['RUPTURA'], RAPIDOS: ['RAPIDOS'], QUEDA: ['QUEDA'],
  ACELERANDO: ['ACELERANDO'], CAPITAL: ['CAPITAL', 'SEM_VENDA_120D', 'EXCESSO'], LIQUIDAR: ['LIQUIDAR'], ATENCAO: ['RUPTURA', 'SEM_VENDA_120D', 'EXCESSO', 'QUEDA', 'NUNCA_VENDIDO', 'LIQUIDAR'],
};

/** Seleciona até `max` candidatos por rodízio entre as listas do foco (sem repetir). Retorna { selecionados, foco:[{categoria,totalNaBase,exibidos}] }. */
function selecionarCandidatos(itens, focos, max, { verCusto = true } = {}) {
  const nomes = [...new Set(focos.flatMap(f => FOCO_PARA_LISTAS[f] || []))].filter(n => verCusto || n !== 'CAPITAL');
  const listas = nomes.map(n => ({ n, itens: itens.filter(LISTAS[n].pega).sort(LISTAS[n].ordem) }));
  const vistos = new Set(), selecionados = [], exibidos = Object.fromEntries(nomes.map(n => [n, 0]));
  for (let rodada = 0; selecionados.length < max && rodada < max; rodada++) {
    let andou = false;
    for (const l of listas) {
      if (selecionados.length >= max) break;
      let it; while ((it = l.itens[exibidos[l.n]]) && vistos.has(it.id)) exibidos[l.n]++;
      if (it) { vistos.add(it.id); selecionados.push(it); exibidos[l.n]++; andou = true; }
    }
    if (!andou) break;
  }
  const foco = listas.map(l => ({ categoria: LISTAS[l.n].nome, totalNaBase: l.itens.length, exibidos: l.itens.filter(i => selecionados.includes(i)).length }));
  return { selecionados, foco };
}

module.exports = { LIMIAR_SEM_VENDA_DIAS, classificarProduto, analisarBase, alertasDoResumo, interpretarPergunta, selecionarCandidatos, TEND };
