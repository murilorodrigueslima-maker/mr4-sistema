'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.3 (SOMBRA): calculadora PURA (sem I/O). Parâmetros: politica13.js.
// Toda função recebe a data de referência (índice t) e só usa informação até ela: serve igual para a sombra de hoje e para
// o backtest sem vazamento de futuro.
const { somarDias, diffDias, parseData, situacaoCompra } = require('./canonico');
const { curvaABC, avaliarDemandaComprovada } = require('./motor');

const EPS = 1e-9;
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const teto = x => Math.ceil(x - EPS);

// ── Séries diárias por produto ──────────────────────────────────────────────────────────────────────────────────
const itensDe = c => (c.produtos || []).map(p => p.produto || p);      // aceita o registro da API e a base compacta

/**
 * Demanda, valor, margem, entradas e saldo de fim de dia por produto, de `inicio` a `hoje`.
 * Saldo: MEDIDO nos dias com snapshot (e hoje = saldo atual); nos demais é RECONSTRUÍDO de trás para frente
 * (saldo(d−1) = saldo(d) + vendas(d) − entradas(d)), marcado em `medido`. Entrada = data de modificação da compra confirmada.
 */
function montarSeries({ produtos, fatosVenda, comprasBrutas, snapshots = {}, inicio, hoje }) {
  const n = diffDias(inicio, hoje) + 1;
  const datas = Array.from({ length: n }, (_, i) => somarDias(inicio, i));
  const porId = new Map(produtos.map(p => [p.product_id, {
    dem: new Float64Array(n), valor: new Float64Array(n), margem: new Float64Array(n), ent: new Float64Array(n),
    saldo: new Float64Array(n).fill(NaN), medido: new Uint8Array(n), custo: p.registered_cost_cents || 0,
    primeiraEvidencia: p.created_at_reliable && p.created_at ? p.created_at : null, primeiraVenda: null,
  }]));
  const antes = (a, b) => (a === null || b < a ? b : a);
  for (const f of fatosVenda) {
    const s = porId.get(f.product_id);
    if (!s || !f.counts_as_demand || !f.date || f.date > hoje || !(f.qty > 0)) continue;
    s.primeiraEvidencia = antes(s.primeiraEvidencia, f.date); s.primeiraVenda = antes(s.primeiraVenda, f.date);
    const i = diffDias(inicio, f.date);
    if (i < 0) continue;
    const custo = f.unit_cost_snapshot_cents > 0 ? f.unit_cost_snapshot_cents : s.custo;
    s.dem[i] += f.qty; s.valor[i] += f.line_total_cents || 0; s.margem[i] += (f.line_total_cents || 0) - custo * f.qty;
  }
  for (const c of comprasBrutas) {
    if (situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const emissao = parseData(c.data_emissao), entrada = parseData(c.modificado_em) || emissao;
    for (const it of itensDe(c)) {
      const s = porId.get(String(it.produto_id)), q = Number(it.quantidade);
      if (!s || !(q > 0)) continue;
      if (emissao && emissao <= hoje) s.primeiraEvidencia = antes(s.primeiraEvidencia, emissao);
      if (!entrada || entrada > hoje) continue;
      const i = diffDias(inicio, entrada);
      if (i >= 0) s.ent[i] += q;
    }
  }
  const doDia = datas.map(d => snapshots[d] || null);
  for (const p of produtos) {
    const s = porId.get(p.product_id);
    for (let i = n - 1; i >= 0; i--) {
      const snap = doDia[i] ? doDia[i].saldos[p.product_id] : undefined;
      const atual = i === n - 1 && Number.isFinite(p.current_stock) ? p.current_stock : undefined;
      const medido = atual !== undefined ? atual : snap;
      if (medido !== undefined && medido !== null) { s.saldo[i] = medido; s.medido[i] = 1; }
      else if (i < n - 1 && !Number.isNaN(s.saldo[i + 1])) s.saldo[i] = s.saldo[i + 1] + s.dem[i + 1] - s.ent[i + 1];
    }
  }
  return { inicio, hoje, n, datas, porId };
}

/** Dia SEM ESTOQUE O DIA INTEIRO (conservador): terminou e começou sem saldo e não houve venda. Saldo desconhecido = disponível. */
const indisponivel = (s, i) => s.saldo[i] <= 0 && (i === 0 || s.saldo[i - 1] <= 0) && s.dem[i] === 0;

// ── Fatos do produto na data t ──────────────────────────────────────────────────────────────────────────────────
function caracteristicas(s, series, t, cfg) {
  const data = series.datas[t];
  const fe = s.primeiraEvidencia && s.primeiraEvidencia <= data ? s.primeiraEvidencia : null;
  const obs = fe === null ? null : diffDias(fe, data);
  const iFe = fe === null ? t + 1 : Math.max(0, diffDias(series.inicio, fe));
  const janela = w => {
    const a = Math.max(0, t - w + 1);
    let u = 0, valor = 0, margem = 0, dias = 0, disp = 0, diasVenda = 0;
    for (let i = a; i <= t; i++) {
      u += s.dem[i]; valor += s.valor[i]; margem += s.margem[i];
      if (i < iFe) continue;
      dias++; if (!indisponivel(s, i)) disp++; if (s.dem[i] > 0) diasVenda++;
    }
    return { u, valor, margem, dias, disp, diasVenda };
  };
  const D = cfg.demanda;
  const curta = janela(D.janela_dias), longa = janela(D.janela_longa_dias), anual = janela(cfg.abc.janela_dias);
  const semanas = [];
  for (let j = 0; j < cfg.seguranca.semanas_sigma; j++) {
    const fim = t - 7 * j, ini = fim - 6;
    if (ini < 0 || ini < iFe) break;
    let u = 0, sem = 0, medidos = 0;
    for (let i = ini; i <= fim; i++) { u += s.dem[i]; if (indisponivel(s, i)) sem++; medidos += s.medido[i]; }
    semanas.push({ u, valida: sem < cfg.xyz.dias_sem_estoque_invalida_semana, medidos });
  }
  const div = (w, n) => (obs === null ? 0 : w.u / Math.min(n, Math.max(1, obs)));
  let medidos = 0;
  for (let i = Math.max(0, t - D.janela_dias + 1); i <= t; i++) medidos += s.medido[i];
  let vendeu = false, ultima = null;
  for (let i = t; i >= 0; i--) if (s.dem[i] > 0) { vendeu = true; ultima = t - i; break; }
  if (!vendeu && s.primeiraVenda && s.primeiraVenda <= data) vendeu = true;
  return { data, obs, curta, longa, anual, semanas, dias_medidos_janela: medidos, v_ingenua: div(curta, D.janela_dias), v_longa_ingenua: div(longa, D.janela_longa_dias),
    vendeu_alguma_vez: vendeu, dias_sem_venda: ultima, preco_cents: anual.u > 0 ? anual.valor / anual.u : null };
}

// ── Previsão com correção de demanda reprimida (cautelosa) ──────────────────────────────────────────────────────
function prever(f, cfg) {
  const c = cfg.demanda.censura, ing = f.v_ingenua, flags = [];
  const semEstoque = f.curta.dias - f.curta.disp;
  let corrigida = ing, fonte = 'OBSERVADA';
  if (c.aplicar && semEstoque > 0) {
    if (f.curta.disp >= c.min_dias_disponiveis && f.curta.diasVenda >= c.min_dias_com_venda) { corrigida = f.curta.u / f.curta.disp; fonte = 'CORRIGIDA_JANELA_CURTA'; }
    else if (f.longa.disp >= c.min_dias_disponiveis_longa && f.longa.diasVenda >= c.min_dias_com_venda) { corrigida = f.longa.u / f.longa.disp; fonte = 'CORRIGIDA_JANELA_LONGA'; }
    else flags.push('DEMANDA_REPRIMIDA_SEM_BASE_PARA_CORRIGIR');
  }
  const limite = c.teto_multiplicador * Math.max(ing, f.v_longa_ingenua);
  if (corrigida > limite + EPS) { corrigida = limite; flags.push('CORRECAO_LIMITADA_PELO_TETO'); }
  const v = ing + c.peso * Math.max(0, corrigida - ing);                       // a correção nunca reduz a velocidade observada
  if (v <= ing + EPS) fonte = 'OBSERVADA';
  return { v, v_observada: ing, v_corrigida: Math.max(ing, corrigida), fonte, dias_sem_estoque: semEstoque, dias_janela: f.curta.dias, flags };
}

// ── Variabilidade ───────────────────────────────────────────────────────────────────────────────────────────────
const media = a => a.reduce((x, y) => x + y, 0) / a.length;
const desvio = a => { if (a.length < 2) return 0; const m = media(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
/** Quantil por posição mais próxima (determinístico). */
function quantil(valores, p) { const o = [...valores].sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.max(0, Math.ceil(p * o.length) - 1))] : null; }

function variabilidade(f, cfg) {
  const validas = f.semanas.filter(w => w.valida);
  const base = (validas.length >= cfg.xyz.min_semanas_validas ? validas : f.semanas).map(w => w.u);
  const m = base.length ? media(base) : 0, sd = desvio(base);
  const corte = base.length ? quantil(base, cfg.seguranca.winsor_percentil) : 0;
  const sdAjustado = desvio(base.map(x => Math.min(x, corte)));
  const cv = m > 0 && base.length >= 2 ? sd / m : null;
  const xyz = cv === null || base.length < cfg.xyz.min_semanas_validas ? 'Z' : cv <= cfg.xyz.cv_x ? 'X' : cv <= cfg.xyz.cv_y ? 'Y' : 'Z';
  return { semanas_usadas: base.length, semanas_descartadas_por_falta: validas.length >= cfg.xyz.min_semanas_validas ? f.semanas.length - validas.length : 0,
    semanas_com_venda: base.filter(x => x > 0).length, media_semanal: m, desvio_semanal: sd, desvio_semanal_ajustado: sdAjustado, cv, xyz };
}

// ── ABC (faturamento, margem, volume) ───────────────────────────────────────────────────────────────────────────
function classificar(itens, cfg) {
  const P = { ABC_CORTE_A: cfg.abc.corte_a, ABC_CORTE_B: cfg.abc.corte_b };
  const curva = chave => curvaABC(itens.map(x => ({ id: x.id, v: Math.max(0, x[chave]) })), 'v', P);
  const c = { receita: curva('receita'), margem: curva('margem'), volume: curva('volume') };
  return new Map(itens.map(x => {
    const tres = { receita: c.receita[x.id], margem: c.margem[x.id], volume: c.volume[x.id] };
    const usadas = cfg.abc.curvas_que_definem_classe.map(k => (tres[k] === 'SEM_VENDA' ? 'C' : tres[k])).sort();
    return [x.id, { ...tres, classe: usadas[0] || 'C' }];
  }));
}

// ── Prazo de reposição ──────────────────────────────────────────────────────────────────────────────────────────
/** Proxy medido até a data `ref` (nunca usa modificação posterior a `ref`). Também devolve o último fornecedor por produto. */
function estimarPrazos(comprasBrutas, ref, cfg) {
  const P = cfg.prazo, geral = [], porForn = new Map(), ultimo = new Map();
  const corte = somarDias(ref, -P.janela_compras_dias);
  for (const c of comprasBrutas) {
    if (situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const e = parseData(c.data_emissao), m = parseData(c.modificado_em);
    if (!e || e > ref) continue;
    const forn = c.fornecedor_id ? String(c.fornecedor_id) : null;
    if (forn) for (const it of itensDe(c)) { const id = String(it.produto_id), a = ultimo.get(id); if (!a || e > a.data) ultimo.set(id, { data: e, fornecedor: forn }); }
    if (!m || m > ref || e < corte) continue;
    const d = diffDias(e, m);
    if (d < 0 || d > P.max_dias_validos || (P.ignorar_mesmo_dia && d === 0)) continue;
    geral.push(d);
    if (forn) (porForn.get(forn) || porForn.set(forn, []).get(forn)).push(d);
  }
  const resumo = a => ({ n: a.length, p50: quantil(a, 0.5), p90: quantil(a, 0.9) });
  return { geral: resumo(geral), fornecedor: new Map([...porForn].map(([k, a]) => [k, resumo(a)])), ultimoFornecedor: ultimo };
}

const Z90 = 1.2816;
function prazoDoProduto(id, estim, cfg) {
  const P = cfg.prazo, prod = cfg.produtos[id] || {};
  const forn = estim.ultimoFornecedor.get(id) ? estim.ultimoFornecedor.get(id).fornecedor : null;
  const cf = (forn && P.fornecedores[forn]) || {};
  const proxy = r => ({ dias: r.p50, desvio_dias: Math.min(Math.max(0, r.p90 - r.p50) / Z90, r.p50 * P.desvio_max_fracao), n: r.n });
  let x;
  if (prod.prazo_dias) x = { dias: prod.prazo_dias, desvio_dias: prod.prazo_desvio_dias || 0, fonte: 'CONFIG_PRODUTO', n: null };
  else if (cf.dias) x = { dias: cf.dias, desvio_dias: cf.desvio_dias || 0, fonte: 'CONFIG_FORNECEDOR', n: null };
  else if (prod.importado || cf.importado) x = { ...P.importado, fonte: 'PREMISSA_IMPORTADO', n: null };
  else if (forn && estim.fornecedor.get(forn) && estim.fornecedor.get(forn).n >= P.min_amostras_fornecedor) x = { ...proxy(estim.fornecedor.get(forn)), fonte: 'PROXY_FORNECEDOR' };
  else if (estim.geral.n >= P.min_amostras_geral) x = { ...proxy(estim.geral), fonte: 'PROXY_GERAL' };
  else x = { ...P.sem_dado, fonte: 'PREMISSA_SEM_DADO', n: null };
  const conf = cf.confiabilidade === undefined || cf.confiabilidade === null ? null : cf.confiabilidade;
  // fornecedor pouco confiável: a parcela incerta do prazo entra na variabilidade do prazo (e portanto na segurança)
  if (conf !== null) x = { ...x, desvio_dias: Math.sqrt(x.desvio_dias ** 2 + (x.dias * (1 - conf)) ** 2) };
  return { ...x, fornecedor_id: forn, confiabilidade: conf };
}

/** Pedidos em trânsito (compras "A receber"/"Em aberto") recentes; antigas ficam de fora e são contadas como resíduo. */
function emTransito(comprasBrutas, ref, cfg) {
  const out = new Map();
  for (const c of comprasBrutas) {
    if (situacaoCompra(c.nome_situacao) !== 'PENDENTE') continue;
    const e = parseData(c.data_emissao);
    if (!e || e > ref) continue;
    const recente = diffDias(e, ref) <= cfg.transito.idade_max_dias;
    for (const it of itensDe(c)) {
      const id = String(it.produto_id), q = Number(it.quantidade);
      if (!(q > 0)) continue;
      const x = out.get(id) || out.set(id, { un: 0, residuo_antigo_un: 0 }).get(id);
      if (recente) x.un += q; else x.residuo_antigo_un += q;
    }
  }
  return out;
}

// ── Elegibilidade (mesmas portas da 1.2, para o backtest; na sombra vale o resultado do próprio motor) ──────────
function elegibilidade(produto, f, politica12) {
  const ex = [];
  if (!produto.active) ex.push('INACTIVE_PRODUCT');
  if (!produto.moves_stock) ex.push('NOT_STOCK_MOVING');
  if (produto.has_composition) ex.push('KIT_NOT_SUPPORTED');
  if (!f.vendeu_alguma_vez) ex.push('NEVER_SOLD');
  const novo = f.obs !== null && f.obs < politica12.new_product.window_days;
  let velocidadeNovo = null;
  if (novo) {
    const unidades = f.longa.u, idade = f.obs;
    const regra = politica12.new_product.proven_demand;
    const ok = regra && avaliarDemandaComprovada({ age_days: idade, units_since_first_evidence: unidades, reserved_units: 0, distinct_sale_days: f.longa.diasVenda, observed_daily_rate: unidades / Math.max(1, idade), active: produto.active }, regra).accepted;
    if (ok) { const w = politica12.velocity.signal_window_days; velocidadeNovo = r3(Math.min(unidades / Math.max(1, idade), f.curta.u / Math.min(w, Math.max(1, idade)))); } else ex.push('NEW_PRODUCT');
  }
  if (f.vendeu_alguma_vez && f.curta.u < politica12.demand.minimum_units) ex.push('INSUFFICIENT_RECENT_DEMAND');
  return { elegivel: ex.length === 0, exclusoes: ex, produto_novo: novo, velocidade_novo: velocidadeNovo };
}

/** Quantidade da regra 1.2 (cobertura-alvo, sem prazo, sem segurança) — referência para comparação e backtest. */
function quantidade12({ velocidade, classeReceita, estoque, politica12 }) {
  const dias = politica12.target_days[classeReceita === 'SEM_VENDA' ? 'C' : classeReceita];
  const nec = r3(velocidade) * dias - Math.max(0, estoque);
  return nec > EPS ? teto(nec) : 0;
}

// ── Normal inversa (Acklam) ─────────────────────────────────────────────────────────────────────────────────────
function zDe(p) {
  if (!(p > 0 && p < 1)) throw new Error('NIVEL_INVALIDO');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const cauda = q => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return cauda(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -cauda(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── Embalagem ───────────────────────────────────────────────────────────────────────────────────────────────────
function embalagemDe(id, fornecedorId, cfg) {
  const p = cfg.produtos[id] || {}, f = (fornecedorId && cfg.embalagem.fornecedores[fornecedorId]) || {};
  const pega = k => (p[k] !== undefined ? [p[k], 'CONFIG_PRODUTO'] : f[k] !== undefined ? [f[k], 'CONFIG_FORNECEDOR'] : [cfg.embalagem.sem_cadastro[k], 'PREMISSA_SEM_CADASTRO']);
  const [minimo, fm] = pega('minimo_un'), [multiplo, fx] = pega('multiplo_un');
  return { minimo_un: minimo, multiplo_un: multiplo, fonte_minimo: fm, fonte_multiplo: fx };
}
const arredondarEmbalagem = (q, e) => (q > 0 ? Math.ceil(Math.max(q, e.minimo_un) / e.multiplo_un - EPS) * e.multiplo_un : 0);

// ── Decisão de um produto ───────────────────────────────────────────────────────────────────────────────────────
/**
 * @param x { id, f (caracteristicas), previsao, variab, classe, prazo, estoque, transito, cfg, velocidadeFixa? (produto novo), nivel? (força o nível) }
 */
function decidir(x) {
  const { id, f, previsao, variab, classe, prazo, cfg } = x;
  const flags = [...previsao.flags];
  const L = prazo.dias, R = cfg.revisao_dias;
  const mes = String(Number(somarDias(f.data, Math.round(L)).slice(5, 7)));
  const fm = cfg.fator_demanda;
  const fator = fm.global * (fm.por_mes[mes] || 1) * (fm.por_produto[id] || 1);
  const novo = x.velocidadeFixa !== null && x.velocidadeFixa !== undefined;
  const v = (novo ? x.velocidadeFixa : previsao.v) * fator;
  const nivel = x.nivel || cfg.nivel_servico[classe + variab.xyz];
  const z = zDe(nivel);
  const sdDia = variab.desvio_semanal_ajustado / Math.sqrt(7) * fator;
  let bruta = z * Math.sqrt((L + R) * sdDia ** 2 + (v * prazo.desvio_dias) ** 2);
  let motivoSeg = null;
  if (novo) { bruta = 0; motivoSeg = 'PRODUTO_NOVO'; flags.push('PRODUTO_NOVO_SEM_SEGURANCA'); }
  else if (variab.semanas_com_venda < cfg.seguranca.min_semanas_com_venda) { bruta = 0; motivoSeg = 'VENDA_ESPORADICA'; flags.push('VENDA_ESPORADICA_SEM_SEGURANCA'); }
  const tetoSeg = v * cfg.seguranca.teto_dias[classe];
  const seguranca = Math.min(bruta, tetoSeg);
  if (bruta > tetoSeg + EPS) flags.push('SEGURANCA_LIMITADA_PELO_TETO');
  const demandaPrazo = v * (L + R);
  // produto novo não tem segurança estatística: o ponto de reposição nunca fica abaixo da cobertura da classe (a mesma da regra vigente)
  const piso = novo ? v * cfg.ciclo_dias[classe] : 0;
  const rop = Math.max(demandaPrazo + seguranca, piso);
  const ciclo = v * cfg.ciclo_dias[classe];
  const alvo = rop + ciclo;
  const disponivel = Math.max(0, x.estoque);
  const posicao = disponivel + x.transito;
  const prod = cfg.produtos[id] || {};
  const pedir = v > 0 && posicao < rop - EPS && !prod.nao_comprar;
  if (prod.nao_comprar) flags.push('MARCADO_NAO_COMPRAR');
  const necessidade = pedir ? teto(alvo - posicao) : 0;
  const emb = embalagemDe(id, prazo.fornecedor_id, cfg);
  const qtd = arredondarEmbalagem(necessidade, emb);
  const protecao = pedir ? Math.min(qtd, arredondarEmbalagem(teto(rop - posicao), emb)) : 0;
  const cobertura = v > 0 ? posicao / v : null;
  if (cobertura !== null && cobertura > cfg.excesso_dias) flags.push('EXCESSO_DE_COBERTURA');
  return { id, classe, xyz: variab.xyz, velocidade: v, fator_demanda: fator, nivel_servico: nivel, z,
    prazo_dias: L, prazo_desvio_dias: prazo.desvio_dias, prazo_fonte: prazo.fonte, prazo_amostras: prazo.n, revisao_dias: R,
    demanda_no_prazo: demandaPrazo, seguranca_bruta: bruta, seguranca, motivo_sem_seguranca: motivoSeg, ponto_reposicao: rop,
    ciclo_dias: cfg.ciclo_dias[classe], ciclo_un: ciclo, estoque_alvo: alvo, estoque: x.estoque, em_transito: x.transito, posicao, cobertura_dias: cobertura,
    pedir, qtd_necessidade: necessidade, embalagem: emb, qtd_sugerida: qtd, qtd_protecao: protecao, qtd_final: qtd, limitada_por: qtd > necessidade ? 'EMBALAGEM' : null, flags };
}

/** Venda perdida estimada na janela curta (ESTIMATIVA: dias sem estoque × velocidade corrigida e limitada). */
function vendaPerdida(f, previsao, custoCents) {
  const un = previsao.dias_sem_estoque * previsao.v;
  const preco = f.preco_cents || 0;
  return { rotulo: 'ESTIMATIVA', unidades: un, receita_cents: Math.round(un * preco), margem_cents: Math.round(un * Math.max(0, preco - (custoCents || 0))) };
}

// ── Capital de giro ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Distribui um teto de compra: primeiro a PROTEÇÃO (até o ponto de reposição) de A, B e C; depois o CICLO de A, B e C.
 * Dentro de cada degrau, maior margem diária esperada por R$ investido × peso da classe × urgência. Margem ≤ 0 fica por último.
 * Itens: { id, classe, custo_cents, margem_unit_cents, velocidade, qtd_sugerida, qtd_protecao, ponto_reposicao, posicao, embalagem }.
 */
function alocarCapital(itens, tetoCents, cfg) {
  if (tetoCents === null || tetoCents === undefined) return { teto_cents: null, usado_cents: itens.reduce((s, i) => s + i.qtd_sugerida * (i.custo_cents || 0), 0), alocado: new Map(itens.map(i => [i.id, i.qtd_sugerida])) };
  const peso = i => cfg.capital.peso_classe[i.classe] || 1;
  const urg = i => (i.ponto_reposicao > 0 ? Math.min(1, Math.max(0, (i.ponto_reposicao - i.posicao) / i.ponto_reposicao)) : 0);
  const nota = i => (i.custo_cents > 0 ? Math.max(0, i.margem_unit_cents) * i.velocidade / i.custo_cents * peso(i) * (0.1 + urg(i)) : 0);
  const ordem = { A: 0, B: 1, C: 2 };
  const lotes = [];
  for (const i of itens) {
    if (!(i.qtd_sugerida > 0)) continue;
    const ruim = !(i.margem_unit_cents > 0);
    lotes.push({ i, q: i.qtd_protecao, degrau: ruim ? 6 : ordem[i.classe], nota: nota(i) });
    if (i.qtd_sugerida > i.qtd_protecao) lotes.push({ i, q: i.qtd_sugerida - i.qtd_protecao, degrau: ruim ? 7 : 3 + ordem[i.classe], nota: nota(i) });
  }
  lotes.sort((a, b) => a.degrau - b.degrau || b.nota - a.nota || String(a.i.id).localeCompare(String(b.i.id)));
  const alocado = new Map(itens.map(i => [i.id, 0]));
  let resta = tetoCents;
  for (const l of lotes) {
    const c = l.i.custo_cents || 0, e = l.i.embalagem || { minimo_un: 1, multiplo_un: 1 };
    let q = l.q;
    if (c > 0 && q * c > resta) q = Math.floor(Math.floor(resta / c) / e.multiplo_un) * e.multiplo_un;
    if (alocado.get(l.i.id) === 0 && q < e.minimo_un) q = 0;
    if (q <= 0) continue;
    alocado.set(l.i.id, alocado.get(l.i.id) + q); resta -= q * c;
  }
  return { teto_cents: tetoCents, usado_cents: tetoCents - resta, alocado };
}

// ── Justificativa em linguagem de negócio ───────────────────────────────────────────────────────────────────────
const num = (x, casas = 1) => Number(x).toLocaleString('pt-BR', { maximumFractionDigits: casas });
const FONTES_PRAZO = { CONFIG_PRODUTO: 'cadastrado para o produto', CONFIG_FORNECEDOR: 'cadastrado para o fornecedor', PROXY_FORNECEDOR: 'aproximado pelo histórico deste fornecedor',
  PROXY_GERAL: 'aproximado pelo histórico geral de compras', PREMISSA_SEM_DADO: 'PREMISSA, sem dado', PREMISSA_IMPORTADO: 'PREMISSA de importado' };

function justificar({ d, abc, previsao, variab, f, perdida }) {
  const L = [];
  L.push(`Classe ${d.classe} (faturamento ${abc.receita}, margem ${abc.margem}, volume ${abc.volume}); variabilidade ${d.xyz}${variab.cv === null ? ' (histórico curto)' : ` (variação semanal ${num(variab.cv)})`}.`);
  let dem = `Demanda: ${num(f.curta.u, 0)} un nos últimos ${f.curta.dias} dias (${num(previsao.v_observada, 2)}/dia).`;
  if (previsao.dias_sem_estoque > 0 && d.motivo_sem_seguranca === 'PRODUTO_NOVO') dem += ` Ficou ${previsao.dias_sem_estoque} dia(s) sem estoque.`;
  else if (previsao.dias_sem_estoque > 0) dem += ` Ficou ${previsao.dias_sem_estoque} dia(s) sem estoque${previsao.fonte === 'OBSERVADA' ? '; sem base segura para corrigir' : `; corrigida para ${num(previsao.v, 2)}/dia (estimativa${previsao.flags.includes('CORRECAO_LIMITADA_PELO_TETO') ? ', limitada ao teto' : ''})`}.`;
  if (d.motivo_sem_seguranca === 'PRODUTO_NOVO') dem += ` Produto novo: usa ${num(d.velocidade, 2)}/dia (regra vigente).`;
  if (d.fator_demanda !== 1) dem += ` Fator manual de sazonalidade/tendência ${num(d.fator_demanda, 2)}.`;
  L.push(dem);
  L.push(`Prazo: ${num(d.prazo_dias, 0)} dias (${FONTES_PRAZO[d.prazo_fonte]}${d.prazo_amostras ? `, ${d.prazo_amostras} compras` : ''}) + ${d.revisao_dias} até a próxima revisão = ${num(d.demanda_no_prazo)} un.`);
  L.push(d.motivo_sem_seguranca ? `Segurança: 0 un (${d.motivo_sem_seguranca === 'VENDA_ESPORADICA' ? 'venda esporádica' : `produto novo; o ponto de reposição não fica abaixo de ${d.ciclo_dias} dias de venda`}).`
    : `Segurança: ${num(d.seguranca)} un para ${num(d.nivel_servico * 100, 0)}% de chance de não faltar no ciclo${d.flags.includes('SEGURANCA_LIMITADA_PELO_TETO') ? ' (limitada pelo teto de dias da classe)' : ''}.`);
  L.push(`Ponto de reposição: ${num(d.ponto_reposicao)} un. Estoque ${num(Math.max(0, d.estoque), 0)} + a caminho ${num(d.em_transito, 0)} = ${num(d.posicao, 0)} → ${d.pedir ? 'pedir' : 'não pedir agora'}.`);
  if (d.pedir) {
    L.push(`Compra para mais ${d.ciclo_dias} dias (${num(d.ciclo_un)} un): estoque-alvo ${num(d.estoque_alvo)} − posição ${num(d.posicao, 0)} = ${d.qtd_necessidade} un.`);
    if (d.qtd_sugerida !== d.qtd_necessidade) L.push(`Ajuste de embalagem (mínimo ${d.embalagem.minimo_un}, múltiplo ${d.embalagem.multiplo_un}): ${d.qtd_sugerida} un.`);
    else if (d.embalagem.fonte_multiplo === 'PREMISSA_SEM_CADASTRO') L.push('Sem cadastro de mínimo/múltiplo: considera unidade avulsa (premissa).');
    if (d.limitada_por === 'CAPITAL') L.push(`Limitado pelo teto de compra: ${d.qtd_final} de ${d.qtd_sugerida} un.`);
    L.push(`Sugestão: ${d.qtd_final} un.`);
  }
  if (perdida && perdida.unidades >= 0.5) L.push(`Venda perdida na janela (estimativa): ${num(perdida.unidades, 0)} un.`);
  if (d.flags.includes('EXCESSO_DE_COBERTURA')) L.push(`Atenção: estoque cobre ${num(d.cobertura_dias, 0)} dias (excesso).`);
  return L;
}

module.exports = { montarSeries, indisponivel, caracteristicas, prever, variabilidade, classificar, quantil, estimarPrazos, prazoDoProduto, emTransito, elegibilidade, quantidade12, zDe, embalagemDe, arredondarEmbalagem, decidir, vendaPerdida, alocarCapital, justificar, r2, r3 };
