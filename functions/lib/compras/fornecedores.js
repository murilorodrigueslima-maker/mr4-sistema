'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase B · Vendas por fornecedor (agregados). FUNÇÃO PURA: sem I/O, sem GestãoClick, sem Firestore.
// Entra com os FATOS CANÔNICOS que o sync já produz (canonico.fatosDeVenda / fatosDeCompra / mapearProduto) e devolve dois
// documentos prontos para a futura aba "Fornecedores":
//   unidades — só quantidades (sem nenhum valor em R$): usuários com o módulo estoque/compras
//   valores  — faturamento líquido de produtos em centavos: só gestor (separação feita AQUI, no backend; as Rules da Fase C
//              deverão proteger os dois documentos com permissões diferentes — a tela nunca recebe o que não pode ver)
//
// REGRAS (todas explícitas, nenhuma nova regra comercial fixa em outro lugar):
//  • Período: os N meses civis COMPLETOS anteriores ao mês corrente (fuso America/Fortaleza, via `hoje` = data comercial) +
//    o mês corrente exibido SEPARADO (fora da média). Mês sem venda = 0 e conta na média. Virada de ano tratada por aritmética de mês.
//  • Venda elegível ("concluída") = a mesma demanda do motor: baixou estoque, não cancelada, data ≤ hoje, qtd > 0.
//    Cancelada (inclui devolução, que a MR4 registra cancelando a venda original) ou sem baixa de estoque = EXCLUÍDA, contada à parte.
//  • Reservado: nunca entra na média principal; fica identificado em campo próprio (por mês, mês corrente e "futuro").
//  • Faturamento líquido de PRODUTOS = valor_total da linha − parcela do desconto do CABEÇALHO do pedido. Frete e serviços ficam de fora.
//    O desconto é rateado entre as linhas do pedido proporcionalmente ao valor da linha, pelo método do MAIOR RESTO (inteiros em
//    centavos): a soma das parcelas é EXATAMENTE o desconto — sem sobra nem falta de centavo.
//  • Fornecedor = ATRIBUIÇÃO GERENCIAL: o da última compra CONFIRMADA do produto (emissão, depois id da compra — mesmo desempate do
//    motor). NÃO afirma a origem histórica do estoque vendido. Cada linha de venda pertence a UM só grupo (sem dupla contagem).
//  • Grupos (quatro, mutuamente exclusivos): externos · internos (ids configurados, ex.: compra própria/transferência) ·
//    produtos sem fornecedor identificado · itens de venda sem produto cadastrado. Os dois últimos não geram sugestão de reposição.
//    Os três fecham com o total elegível, calculado por um caminho independente (conciliação).

const RULES_VERSION = 'FORN_V1';
const SCHEMA_VERSION = 1;
const COLECAO = 'compras_n0_fornecedores', DOC_UNIDADES = 'unidades', DOC_VALORES = 'valores';   // coleção PRÓPRIA: nenhum documento nem regra existente de Compras é tocado

// Parâmetros (futuramente administrados em Configurações, com permissão e auditoria — Fase D). Sobrescrevíveis por `config`.
const DEFAULTS = Object.freeze({
  months: 3,
  internal_supplier_ids: Object.freeze(['2026204']),      // "MR4 DISTRIBUIDORA": compra própria / transferência interna (confirmado pelo gestor em 22/10/2026)
  attribution: 'LAST_CONFIRMED_PURCHASE',
  fetch_names: true,                                       // o sync COMPLETO lê /fornecedores (1 GET) e atualiza o cache de nomes; false = só usa o cache (chave de desligamento)
  names_stale_after_hours: 48,                             // cache de nomes mais velho que isso (ou última leitura falha) ⇒ aviso de nomes desatualizados
  names_suspect_ratio: 0.5,                                // resposta com menos que 50% dos fornecedores já conhecidos é tratada como suspeita (falha), nunca mesclada
});

function validarConfig(c) {
  const e = [];
  if (!c || typeof c !== 'object') return ['config deve ser objeto'];
  if (!(Number.isInteger(c.months) && c.months >= 1 && c.months <= 12)) e.push('months deve ser inteiro entre 1 e 12');
  if (!Array.isArray(c.internal_supplier_ids) || c.internal_supplier_ids.some(x => typeof x !== 'string' || !x)) e.push('internal_supplier_ids deve ser lista de ids (texto)');
  if (c.attribution !== 'LAST_CONFIRMED_PURCHASE') e.push('attribution desconhecida');
  if (typeof c.fetch_names !== 'boolean') e.push('fetch_names deve ser booleano');
  if (!(typeof c.names_stale_after_hours === 'number' && c.names_stale_after_hours > 0)) e.push('names_stale_after_hours deve ser número > 0');
  if (!(typeof c.names_suspect_ratio === 'number' && c.names_suspect_ratio > 0 && c.names_suspect_ratio <= 1)) e.push('names_suspect_ratio deve estar entre 0 (exclusivo) e 1');
  return e;
}

// ── meses civis (YYYY-MM) ─────────────────────────────────────────────────────────────────────────────────────
const mesDe = iso => iso.slice(0, 7);
function somarMeses(ym, n) { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }
function periodoDe(hoje, n) {
  const corrente = mesDe(hoje);
  const meses = Array.from({ length: n }, (_, i) => somarMeses(corrente, i - n));       // do mais antigo ao mais recente
  return { meses, mes_corrente: corrente, hoje, dia_do_mes_corrente: Number(hoje.slice(8, 10)) };
}

// ── rateio do desconto de cabeçalho (maior resto) ────────────────────────────────────────────────────────────
/** Devolve as parcelas inteiras (centavos) do desconto por linha; Σ parcelas === min(desconto, Σ linhas). */
function ratearDesconto(valoresCents, descontoCents) {
  const base = valoresCents.reduce((s, v) => s + v, 0);
  const d = Math.min(Math.max(descontoCents || 0, 0), Math.max(base, 0));
  if (!(d > 0) || !(base > 0)) return { parcelas: valoresCents.map(() => 0), ajustados: 0, desconto: 0 };
  const quotas = valoresCents.map((v, i) => { const num = d * Math.max(v, 0); return { i, piso: Math.floor(num / base), resto: num % base }; });
  let faltam = d - quotas.reduce((s, q) => s + q.piso, 0);
  const ordem = [...quotas].sort((a, b) => b.resto - a.resto || a.i - b.i);
  const parcelas = quotas.map(q => q.piso);
  for (let k = 0; k < ordem.length && faltam > 0; k++, faltam--) parcelas[ordem[k].i]++;
  return { parcelas, ajustados: d - quotas.reduce((s, q) => s + q.piso, 0), desconto: d };
}

// ── atribuição gerencial produto → fornecedor ────────────────────────────────────────────────────────────────
function mapaFornecedores(fatosCompra) {
  const confirmadas = fatosCompra.filter(f => f.status === 'CONFIRMADA' && f.issue_date && f.supplier_id && f.product_id);
  const ultima = {}, todos = {};
  for (const f of confirmadas) {
    (todos[f.product_id] ||= new Set()).add(f.supplier_id);
    const a = ultima[f.product_id];
    if (!a || f.issue_date > a.issue_date || (f.issue_date === a.issue_date && String(f.purchase_id).localeCompare(String(a.purchase_id)) > 0)) ultima[f.product_id] = f;
  }
  return { ultimo: Object.fromEntries(Object.entries(ultima).map(([p, f]) => [p, f.supplier_id])), todos };
}

const SEM_PRODUTO = 'SEM_PRODUTO';   // item de venda sem produto cadastrado (produto_id vazio no ERP): nunca recebe fornecedor por acaso. NÃO usar __x__: o Firestore reserva esses nomes de campo (e esta chave vira nome de campo em `valores`)
const RE_CANCELADA = /cancel|n[aã]o fechou/i;
const arr = (n, v = 0) => Array.from({ length: n }, () => v);
const somar = a => a.reduce((s, x) => s + x, 0);
const r2 = x => Math.round(x * 100) / 100;

/**
 * @param {object} p
 * @param {object[]} p.produtos       saída de canonico.mapearProduto
 * @param {object[]} p.fatosVenda     saída de canonico.fatosDeVenda
 * @param {object[]} p.fatosCompra    saída de canonico.fatosDeCompra
 * @param {string}   p.hoje           data comercial (YYYY-MM-DD, America/Fortaleza)
 * @param {Date}     p.agora          instante da geração
 * @param {string}   p.modo           'FULL' | 'INCREMENTAL'
 * @param {string}   [p.ultimoCompleto]  ISO do último sync completo (incremental)
 * @param {object}   [p.nomes]        { supplier_id: nome | { nome, ativo, nome_anterior, ausente } } — ausente ⇒ "Fornecedor #id". Só APRESENTAÇÃO: não entra em nenhum cálculo.
 * @param {object}   [p.nomesMeta]    situação do cache de nomes (nomesFornecedores.situacao + relatório da última leitura)
 * @param {object}   [p.sync]         { stale_after_hours, full_overdue_after_hours } (da política)
 * @param {object}   [p.config]       parâmetros (DEFAULTS)
 */
function montarFornecedores({ produtos = [], fatosVenda = [], fatosCompra = [], hoje, agora, modo = 'FULL', ultimoCompleto = null, nomes = {}, nomesMeta = null, sync = {}, config = DEFAULTS }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hoje)) || !(agora instanceof Date) || Number.isNaN(agora.getTime())) throw new Error('FORNECEDORES_ENTRADA_INVALIDA: hoje (YYYY-MM-DD) e agora (Date) são obrigatórios — o módulo não lê o relógio');
  const erros = validarConfig(config);
  if (erros.length) throw new Error('FORNECEDORES_CONFIG_INVALIDA: ' + erros.join('; '));
  const N = config.months;
  const per = periodoDe(hoje, N);
  const idx = Object.fromEntries(per.meses.map((m, i) => [m, i]));
  const internos = new Set(config.internal_supplier_ids);
  const porProduto = Object.fromEntries(produtos.map(p => [p.product_id, p]));
  const { ultimo, todos } = mapaFornecedores(fatosCompra);

  // ── classificação de cada linha de venda ───────────────────────────────────────────────────────────────────
  const excl = { cancelada: { linhas: 0, unidades: 0 }, sem_baixa_de_estoque: { linhas: 0, unidades: 0 }, concluida_data_futura: { linhas: 0, unidades: 0 }, qtd_invalida: { linhas: 0 }, sem_data: { linhas: 0 }, fora_do_periodo: { linhas: 0 } };
  const elegiveis = [];                                           // linhas concluídas/reservadas com data ≤ hoje (ou reservadas futuras)
  let vendaMaisAntiga = null;
  for (const f of fatosVenda) {
    if (f.date && (!vendaMaisAntiga || f.date < vendaMaisAntiga)) vendaMaisAntiga = f.date;
    if (!f.counts_as_demand) {
      const q = f.qty > 0 ? f.qty : 0;
      if (RE_CANCELADA.test(String(f.status || ''))) { excl.cancelada.linhas++; excl.cancelada.unidades += q; } else { excl.sem_baixa_de_estoque.linhas++; excl.sem_baixa_de_estoque.unidades += q; }
      continue;
    }
    if (!f.date) { excl.sem_data.linhas++; continue; }
    if (!(f.qty != null && f.qty > 0)) { excl.qtd_invalida.linhas++; continue; }
    const reservado = f.demand_source_status === 'RESERVED';
    const mes = mesDe(f.date);
    let balde;
    if (f.date > hoje) { if (!reservado) { excl.concluida_data_futura.linhas++; excl.concluida_data_futura.unidades += f.qty; continue; } balde = 'futuro'; }
    else if (mes === per.mes_corrente) balde = 'corrente';
    else if (mes in idx) balde = idx[mes];
    else { excl.fora_do_periodo.linhas++; continue; }
    elegiveis.push({ f, reservado, balde });
  }

  // ── rateio do desconto por pedido (só linhas elegíveis do pedido) ──────────────────────────────────────────
  const porVenda = new Map();
  for (const e of elegiveis) { const k = e.f.sale_id; if (!porVenda.has(k)) porVenda.set(k, []); porVenda.get(k).push(e); }
  const rateio = { pedidos: porVenda.size, pedidos_com_desconto: 0, centavos_ajustados: 0, desconto_total_cents: 0, base_divergente: 0 };
  for (const linhas of porVenda.values()) {
    const bruto = linhas.map(e => e.f.line_total_cents || 0);
    const desc = linhas[0].f.header_discount_cents || 0;
    const rt = ratearDesconto(bruto, desc);
    if (rt.desconto > 0) { rateio.pedidos_com_desconto++; rateio.centavos_ajustados += rt.ajustados; rateio.desconto_total_cents += rt.desconto; }
    const cab = linhas[0].f.sale_products_total_cents;
    if (cab != null && linhas.length && Math.abs(cab - somar(bruto)) > 2 && linhas.every(e => e.f.line_total_cents != null)) rateio.base_divergente++;   // itens não elegíveis do mesmo pedido ou valor de cabeçalho diferente
    linhas.forEach((e, i) => { e.liq = bruto[i] - rt.parcelas[i]; });
  }

  const semProd = elegiveis.filter(e => !e.f.product_id);
  const qualidade = { linhas_sem_produto: semProd.length, unidades_sem_produto_concluidas: somar(semProd.filter(e => !e.reservado && e.balde !== 'futuro').map(e => e.f.qty)) };

  // ── agregação por grupo × produto ──────────────────────────────────────────────────────────────────────────
  const grupos = new Map();
  const grupoDe = pid => {
    if (pid === SEM_PRODUTO) return { chave: 'ITENS_SEM_PRODUTO', tipo: 'ITENS_SEM_PRODUTO', supplier_id: null };
    const sid = ultimo[pid] || null;
    if (!sid) return { chave: 'SEM_FORNECEDOR', tipo: 'SEM_FORNECEDOR', supplier_id: null };
    return internos.has(sid) ? { chave: 'INTERNO:' + sid, tipo: 'INTERNO', supplier_id: sid } : { chave: 'EXTERNO:' + sid, tipo: 'EXTERNO', supplier_id: sid };
  };
  const novoProd = () => ({ un: arr(N), liq: arr(N), un_corrente: 0, liq_corrente: 0, res_un: arr(N), res_liq: arr(N), res_un_corrente: 0, res_liq_corrente: 0, res_un_futuro: 0, res_liq_futuro: 0 });
  for (const e of elegiveis) {
    const pid = e.f.product_id || SEM_PRODUTO;
    const g0 = grupoDe(pid);
    let g = grupos.get(g0.chave); if (!g) { g = { ...g0, produtos: new Map() }; grupos.set(g0.chave, g); }
    let pr = g.produtos.get(pid); if (!pr) { pr = novoProd(); g.produtos.set(pid, pr); }
    const q = e.f.qty, v = e.liq;
    if (e.reservado) { if (e.balde === 'futuro') { pr.res_un_futuro += q; pr.res_liq_futuro += v; } else if (e.balde === 'corrente') { pr.res_un_corrente += q; pr.res_liq_corrente += v; } else { pr.res_un[e.balde] += q; pr.res_liq[e.balde] += v; } }
    else if (e.balde === 'corrente') { pr.un_corrente += q; pr.liq_corrente += v; }
    else if (e.balde !== 'futuro') { pr.un[e.balde] += q; pr.liq[e.balde] += v; }
  }
  for (const t of ['SEM_FORNECEDOR', 'ITENS_SEM_PRODUTO']) if (!grupos.has(t)) grupos.set(t, { chave: t, tipo: t, supplier_id: null, produtos: new Map() });

  // ── totais pelo caminho INDEPENDENTE (direto das linhas elegíveis, sem passar pelos grupos) ───────────────────
  const tot = { un: arr(N), liq: arr(N), un_corrente: 0, liq_corrente: 0, res_un: 0, res_liq: 0, produtos: new Set() };
  const liqPedido = new Map();
  for (const [k, linhas] of porVenda) liqPedido.set(k, somar(linhas.map(e => e.liq)));
  for (const e of elegiveis) {
    if (e.reservado) { tot.res_un += e.f.qty; continue; }
    if (e.balde === 'corrente') tot.un_corrente += e.f.qty; else if (e.balde !== 'futuro') { tot.un[e.balde] += e.f.qty; if (e.f.product_id) tot.produtos.add(e.f.product_id); }
  }
  // líquido total independente: Σ por pedido (bruto − desconto limitado), nunca somando as parcelas por linha
  for (const [k, linhas] of porVenda) {
    const base = somar(linhas.map(e => e.f.line_total_cents || 0)), desc = Math.min(Math.max(linhas[0].f.header_discount_cents || 0, 0), Math.max(base, 0));
    // as linhas de um pedido têm o mesmo balde/status; usa a primeira
    const e0 = linhas[0]; const liqPed = base - desc;
    if (e0.reservado) tot.res_liq += liqPed; else if (e0.balde === 'corrente') tot.liq_corrente += liqPed; else if (e0.balde !== 'futuro') tot.liq[e0.balde] += liqPed;
  }

  // ── montagem dos documentos ────────────────────────────────────────────────────────────────────────────────
  const nomeDe = g => {
    if (g.tipo === 'SEM_FORNECEDOR') return { nome: 'Produtos sem fornecedor identificado', nome_origem: 'ROTULO_FIXO' };
    if (g.tipo === 'ITENS_SEM_PRODUTO') return { nome: 'Itens de venda sem produto cadastrado', nome_origem: 'ROTULO_FIXO' };
    const x = nomes[g.supplier_id], info = typeof x === 'string' ? { nome: x } : x;
    if (!info || !info.nome) return { nome: 'Fornecedor #' + g.supplier_id, nome_origem: 'FALLBACK_ID' };
    // atributos de APRESENTAÇÃO (só aparecem quando verdadeiros); o id continua sendo a chave estável do grupo
    return { nome: info.nome, nome_origem: 'GESTAOCLICK', ...(info.ativo === false ? { inativo: true } : {}), ...(info.ausente ? { nome_ausente_na_api: true } : {}), ...(info.nome_anterior ? { nome_anterior: info.nome_anterior } : {}) };
  };
  const lista = [...grupos.values()].map(g => {
    const prods = [...g.produtos.entries()].map(([pid, v]) => ({ pid, v, info: porProduto[pid] || null }));
    const un = arr(N), liq = arr(N), resUn = arr(N), resLiq = arr(N);
    let unC = 0, liqC = 0, resUnC = 0, resLiqC = 0, resUnF = 0, resLiqF = 0;
    prods.forEach(({ v }) => { v.un.forEach((x, i) => { un[i] += x; liq[i] += v.liq[i]; resUn[i] += v.res_un[i]; resLiq[i] += v.res_liq[i]; }); unC += v.un_corrente; liqC += v.liq_corrente; resUnC += v.res_un_corrente; resLiqC += v.res_liq_corrente; resUnF += v.res_un_futuro; resLiqF += v.res_liq_futuro; });
    const vendidos = prods.filter(({ pid, v }) => pid !== SEM_PRODUTO && somar(v.un) > 0);
    return { g, prods, un, liq, resUn, resLiq, unC, liqC, resUnC, resLiqC, resUnF, resLiqF, vendidos: vendidos.length, ...nomeDe(g) };
  });
  const ordenar = (a, b) => (somar(b.un) - somar(a.un)) || String(a.g.chave).localeCompare(String(b.g.chave));
  const ordProd = (a, b) => (somar(b.v.un) - somar(a.v.un)) || String(a.pid).localeCompare(String(b.pid));

  // Itens sem identificação confiável NUNCA geram sugestão automática de reposição (decisão do gestor, 22/10/2026). Nesta fase não há sugestão nenhuma.
  const reposicao = t => t === 'EXTERNO' ? { elegivel: true, motivo: null } : t === 'INTERNO' ? { elegivel: false, motivo: 'ORIGEM_INTERNA_NAO_AVALIADA' } : { elegivel: false, motivo: t === 'ITENS_SEM_PRODUTO' ? 'ITEM_SEM_PRODUTO_CADASTRADO' : 'SEM_FORNECEDOR_IDENTIFICADO' };
  const gUn = L => ({
    chave: L.g.chave, tipo: L.g.tipo, fornecedor_id: L.g.supplier_id, nome: L.nome, nome_origem: L.nome_origem,
    ...(L.inativo ? { inativo: true } : {}), ...(L.nome_ausente_na_api ? { nome_ausente_na_api: true } : {}), ...(L.nome_anterior ? { nome_anterior: L.nome_anterior } : {}),
    reposicao: reposicao(L.g.tipo),
    un: L.un, soma: somar(L.un), media: r2(somar(L.un) / N), mes_corrente: L.unC,
    reservado: { un: L.resUn, mes_corrente: L.resUnC, futuro: L.resUnF, total: somar(L.resUn) + L.resUnC + L.resUnF },
    produtos_vendidos: L.vendidos,
    produtos: [...L.prods].sort(ordProd).map(({ pid, v, info }) => ({
      id: pid, codigo: info ? info.code : null, nome: pid === SEM_PRODUTO ? 'Item sem produto cadastrado' : (info ? info.name : null), grupo: info ? info.group_name : null, estoque: info ? info.current_stock : null,
      un: v.un, soma: somar(v.un), media: r2(somar(v.un) / N), mes_corrente: v.un_corrente,
      reservado: { un: v.res_un, mes_corrente: v.res_un_corrente, futuro: v.res_un_futuro },
      outros_fornecedores: Math.max(0, (todos[pid] ? todos[pid].size : 0) - 1),
    })),
  });
  const gVal = L => ({
    chave: L.g.chave,
    liq_cents: L.liq, soma_cents: somar(L.liq), media_cents: Math.round(somar(L.liq) / N), mes_corrente_cents: L.liqC,
    reservado_liq_cents: { por_mes: L.resLiq, mes_corrente: L.resLiqC, futuro: L.resLiqF, total: somar(L.resLiq) + L.resLiqC + L.resLiqF },
    produtos: Object.fromEntries(L.prods.map(({ pid, v }) => [pid, { liq_cents: v.liq, soma_cents: somar(v.liq), media_cents: Math.round(somar(v.liq) / N), mes_corrente_cents: v.liq_corrente, reservado_liq_cents: somar(v.res_liq) + v.res_liq_corrente + v.res_liq_futuro }])),
  });
  const externos = lista.filter(L => L.g.tipo === 'EXTERNO').sort(ordenar), internosL = lista.filter(L => L.g.tipo === 'INTERNO').sort(ordenar), sem = lista.find(L => L.g.tipo === 'SEM_FORNECEDOR'), semProduto = lista.find(L => L.g.tipo === 'ITENS_SEM_PRODUTO');

  // ── fornecedores conhecidos SEM venda nos meses completos (só apresentação; nenhum número de venda depende disto) ──
  // Conhecidos = ids do cache de nomes ∪ ids que são "última compra" de algum produto. Quem já tem grupo (inclusive grupo só com mês corrente/reservado) NÃO entra aqui.
  const comGrupo = new Set(lista.filter(L => L.g.supplier_id).map(L => String(L.g.supplier_id)));
  const atribuidos = {};
  for (const sid of Object.values(ultimo)) atribuidos[sid] = (atribuidos[sid] || 0) + 1;
  const conhecidos = new Set([...Object.keys(nomes || {}), ...Object.keys(atribuidos)].map(String));
  const semVendas = [...conhecidos].filter(id => !comGrupo.has(id)).map(id => {
    const g = { tipo: internos.has(id) ? 'INTERNO' : 'EXTERNO', supplier_id: id };
    const n = nomeDe(g);
    return { chave: g.tipo + ':' + id, tipo: g.tipo, fornecedor_id: id, nome: n.nome, nome_origem: n.nome_origem,
      ...(n.inativo ? { inativo: true } : {}), ...(n.nome_ausente_na_api ? { nome_ausente_na_api: true } : {}), ...(n.nome_anterior ? { nome_anterior: n.nome_anterior } : {}),
      produtos_atribuidos: atribuidos[id] || 0 };
  }).sort((x, y) => (x.tipo === y.tipo ? 0 : x.tipo === 'EXTERNO' ? -1 : 1) || String(x.nome).localeCompare(String(y.nome), 'pt-BR') || String(x.fornecedor_id).localeCompare(String(y.fornecedor_id)));
  const concForn = { conhecidos: conhecidos.size, com_grupo: [...conhecidos].filter(id => comGrupo.has(id)).length, sem_vendas: semVendas.length };
  concForn.fecha = concForn.com_grupo + concForn.sem_vendas === concForn.conhecidos && !semVendas.some(x => comGrupo.has(x.fornecedor_id));

  // ── conciliação: Σ grupos × total elegível independente ─────────────────────────────────────────────────────
  const somaGrupos = { un: arr(N), liq: arr(N), un_corrente: 0, liq_corrente: 0 };
  lista.forEach(L => { L.un.forEach((x, i) => { somaGrupos.un[i] += x; somaGrupos.liq[i] += L.liq[i]; }); somaGrupos.un_corrente += L.unC; somaGrupos.liq_corrente += L.liqC; });
  const dif = (a, b) => a.map((x, i) => x - b[i]);
  const concUn = { total_elegivel: tot.un, soma_grupos: somaGrupos.un, diferenca: dif(somaGrupos.un, tot.un), mes_corrente: { total: tot.un_corrente, soma: somaGrupos.un_corrente, diferenca: somaGrupos.un_corrente - tot.un_corrente } };
  const concVal = { total_elegivel_cents: tot.liq, soma_grupos_cents: somaGrupos.liq, diferenca_cents: dif(somaGrupos.liq, tot.liq), mes_corrente: { total_cents: tot.liq_corrente, soma_cents: somaGrupos.liq_corrente, diferenca_cents: somaGrupos.liq_corrente - tot.liq_corrente } };
  const fecha = concUn.diferenca.every(x => x === 0) && concUn.mes_corrente.diferenca === 0 && concVal.diferenca_cents.every(x => x === 0) && concVal.mes_corrente.diferenca_cents === 0;

  // ── metadados e atualização ──────────────────────────────────────────────────────────────────────────────────
  const geradoEm = agora.toISOString();
  const staleH = sync.stale_after_hours ?? null, overdueH = sync.full_overdue_after_hours ?? null;
  const completo = modo === 'FULL' ? geradoEm : ultimoCompleto;
  let atualizacao;
  if (modo === 'FULL') atualizacao = { status: 'OK', motivo: 'SYNC_COMPLETO' };
  else if (!completo) atualizacao = { status: 'DESCONHECIDA', motivo: 'ULTIMO_SYNC_COMPLETO_NAO_INFORMADO' };
  else if (overdueH !== null && (agora.getTime() - Date.parse(completo)) / 3600000 > overdueH) atualizacao = { status: 'DESATUALIZADA', motivo: 'SYNC_COMPLETO_ATRASADO' };
  else atualizacao = { status: 'OK', motivo: 'SYNC_INCREMENTAL_SOBRE_COMPLETO_RECENTE' };
  const historicoCobre = vendaMaisAntiga !== null && vendaMaisAntiga <= per.meses[0] + '-01';
  if (!historicoCobre) atualizacao = { status: atualizacao.status === 'OK' ? 'PARCIAL' : atualizacao.status, motivo: atualizacao.motivo + '|HISTORICO_NAO_COBRE_O_PERIODO' };
  const limitacoes = ['ATRIBUICAO_GERENCIAL_ULTIMA_COMPRA_CONFIRMADA', 'DEVOLUCAO_REGISTRADA_COMO_CANCELAMENTO_DA_VENDA_ORIGINAL', 'CANCELAMENTO_POSTERIOR_SO_REFLETE_NO_SYNC_COMPLETO', 'FRETE_E_SERVICOS_FORA_DO_FATURAMENTO'];
  if ([...lista].some(L => L.g.tipo === 'EXTERNO' && L.nome_origem === 'FALLBACK_ID')) limitacoes.push('NOMES_DE_FORNECEDOR_AUSENTES');
  if (nomesMeta && nomesMeta.status === 'DESATUALIZADO') limitacoes.push('NOMES_DE_FORNECEDOR_DESATUALIZADOS');
  if (rateio.base_divergente) limitacoes.push('PEDIDOS_COM_BASE_DE_RATEIO_DIVERGENTE');
  if (qualidade.linhas_sem_produto) limitacoes.push('ITENS_DE_VENDA_SEM_PRODUTO_CADASTRADO');
  if (!fecha) limitacoes.push('CONCILIACAO_NAO_FECHA');
  const meta = {
    schema_version: SCHEMA_VERSION, rules_version: RULES_VERSION, gerado_em: geradoEm, data_comercial: hoje, fuso: 'America/Fortaleza', modo_sync: modo,
    origem: 'GestãoClick (vendas e compras lidas pelo sync de Compras; esta visão não consulta a API)',
    ultimo_sync_completo: completo, valido_ate: staleH === null ? null : new Date(agora.getTime() + staleH * 3600000).toISOString(),
    stale_after_hours: staleH, atualizacao, historico: { venda_mais_antiga: vendaMaisAntiga, cobre_periodo: historicoCobre },
    atribuicao: { regra: config.attribution, natureza: 'GERENCIAL', aviso: 'Fornecedor da última compra confirmada do produto; não representa a origem histórica exata do estoque vendido.' },
    internos: config.internal_supplier_ids, limitacoes,
    nomes_fornecedores: nomesMeta,
  };
  const periodo = { ...per, meses_analisados: N };
  const avisoSugestao = 'Esta visão NÃO gera sugestão de compra.';
  const unidades = {
    ...{ schema_version: SCHEMA_VERSION, rules_version: RULES_VERSION, tipo: 'UNIDADES' }, periodo, meta, aviso: avisoSugestao,
    totais: { un: tot.un, soma: somar(tot.un), media: r2(somar(tot.un) / N), mes_corrente: tot.un_corrente, reservado: tot.res_un, produtos_vendidos: tot.produtos.size },
    externos: externos.map(gUn), internos: internosL.map(gUn), sem_fornecedor: gUn(sem), itens_sem_produto: gUn(semProduto),
    sem_vendas: semVendas,
    excluidas: excl, qualidade, rateio_aplicado: { pedidos: rateio.pedidos, pedidos_com_desconto: rateio.pedidos_com_desconto },
    conciliacao: { fecha, unidades: concUn, fornecedores: concForn },
  };
  const valores = {
    ...{ schema_version: SCHEMA_VERSION, rules_version: RULES_VERSION, tipo: 'VALORES' }, periodo, meta, moeda: 'BRL', unidade_monetaria: 'centavos',
    base: 'faturamento líquido de PRODUTOS (valor da linha − rateio do desconto do pedido); sem frete e sem serviços',
    totais: { liq_cents: tot.liq, soma_cents: somar(tot.liq), media_cents: Math.round(somar(tot.liq) / N), mes_corrente_cents: tot.liq_corrente, reservado_liq_cents: tot.res_liq },
    externos: externos.map(gVal), internos: internosL.map(gVal), sem_fornecedor: gVal(sem), itens_sem_produto: gVal(semProduto),
    rateio,
    conciliacao: { fecha, valores: concVal },
  };
  return { unidades, valores, docs: [[COLECAO, DOC_UNIDADES, unidades], [COLECAO, DOC_VALORES, valores]] };
}

module.exports = { COLECAO, SEM_PRODUTO, RULES_VERSION, SCHEMA_VERSION, DOC_UNIDADES, DOC_VALORES, DEFAULTS, validarConfig, periodoDe, somarMeses, ratearDesconto, mapaFornecedores, montarFornecedores };
