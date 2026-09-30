'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Snapshot, frescor, persistência, histórico de saldo e sync (completo × incremental).
//
// Armazenamento (Firestore protegido; escrita só Admin SDK; nada público). Tudo grava `policy_version`.
//   compras_n0/resumo              contagens, listas operacionais (IDs), política, resumo da política — SEM custo/faturamento
//   compras_n0/meta                frescor, modo do sync, última reconciliação completa, estatísticas
//   compras_n0_produtos/bloco_NNN  métricas operacionais + sugestão explicada por produto — SEM custo/faturamento
//   compras_n0_custos/bloco_NNN    custo cadastrado/último custo de compra/faturamento/valor INDICATIVO — só gestor
//   compras_n0_base/{v_NNN,c_NNN}  base compacta p/ o incremental (itens de venda/compra SEM cliente) — ninguém lê pelo app
//   estoque_snapshots/{YYYY-MM-DD} snapshot COMPLETO diário do saldo bruto (dia comercial America/Fortaleza)
const { dataComercial, mapearProduto, fatosDeVenda, fatosDeCompra, centavos, brutoDaLinha } = require('./canonico');
const { calcularTudo, RULES_VERSION } = require('./motor');
const { resumoCalibracao, resumoPolitica } = require('./calibracao');
const { POLITICA_VIGENTE } = require('./politica');
const Rent = require('./rentabilidade');

// Limites de ARMAZENAMENTO (não são regra de negócio). Firestore: documento ≤ 1 MiB; commit ≤ 10 MiB e ≤ 500 operações.
const BLOCO = 150;                       // produtos por documento (medido: ~430 KB com a sugestão explicada)
const BASE_BYTES_MAX = 600 * 1024;       // teto por documento da base compacta
const DOC_BYTES_MAX = 900 * 1024;        // guarda: nenhum documento acima disso é gravado
const LOTE_BYTES_MAX = 8 * 1024 * 1024;  // guarda: acima disso a base vai em lotes próprios antes do snapshot
const LOTE_OPS_MAX = 450;
// Base histórica COMPLETA do incremental (decisão: manter todo o histórico; nunca apagar automaticamente).
// Limite OPERACIONAL (não é limite do Firestore): acima dele o sync ainda grava (lotes divididos), mas a leitura
// do incremental fica cara — hora de rever o formato. Aviso determinístico a partir de 75%.
const BASE_LIMITE_OPERACIONAL_BYTES = 20 * 1024 * 1024;
const BASE_AVISO_FRACAO = 0.75;
/** Firestore rejeita array dentro de array (INVALID_ARGUMENT "Nested arrays are not allowed"). Guarda antes da escrita. */
function temArrayAninhado(v, dentroDeArray = false) {
  if (Array.isArray(v)) return dentroDeArray || v.some(x => temArrayAninhado(x, true));
  if (v && typeof v === 'object') return Object.values(v).some(x => temArrayAninhado(x, false));
  return false;
}
function avisosBase(bytes) {
  if (bytes >= BASE_LIMITE_OPERACIONAL_BYTES) return ['INCREMENTAL_BASE_OVER_OPERATIONAL_LIMIT'];
  if (bytes >= BASE_AVISO_FRACAO * BASE_LIMITE_OPERACIONAL_BYTES) return ['INCREMENTAL_BASE_NEAR_OPERATIONAL_LIMIT'];
  return [];
}
const LIMITACOES = [
  'HISTORICAL_STOCK_BALANCE_AVAILABLE=NO — ausência de venda não prova ausência de demanda',
  'HISTORICAL_STOCKOUT=UNSUPPORTED — só a ruptura atual é afirmada',
  'LEAD_TIME_SUPPORT=NO — sugestão = POLÍTICA DE COBERTURA, não ponto de pedido por lead time',
  'COST_CONFIDENCE=LOW — custo cadastrado ≠ último custo de compra em ~78% dos produtos; frete/impostos não rateados',
  'COST_USED_IN_DECISION=NO — custo não define elegibilidade, prioridade nem quantidade',
  'ABC_MARGIN=BLOCKED · TIED_CAPITAL=INDICATIVO (não é verdade contábil)',
  'ERP_MIN_STOCK_SUPPORT=NO — o ERP não expõe estoque mínimo',
  'KIT_SUPPORT=NO — nenhuma composição estruturada (possui_composicao=0)',
  'SUGESTAO≠PEDIDO — prioridade P1 = maior prioridade para ANÁLISE, não compra automática',
  'PURCHASE_AFFORDABILITY=BLOCKED — sem saldo bancário real (REAL_BANK_BALANCE_AVAILABLE=NO)',
];

function frescor(ultimoSucessoISO, agora = new Date(), limiarHoras = POLITICA_VIGENTE.sync.stale_after_hours) {
  if (!ultimoSucessoISO) return { estado: 'UNAVAILABLE', idade_min: null, limiar_horas: limiarHoras };
  const idade = Math.round((agora.getTime() - new Date(ultimoSucessoISO).getTime()) / 60000);
  return { estado: idade <= limiarHoras * 60 ? 'CURRENT' : 'STALE', idade_min: idade, limiar_horas: limiarHoras };
}

// ── Base compacta: SÓ o que o motor usa (sem cliente, vendedor, documento, endereço, observação) ────────────────────
// Em memória: objetos. No Firestore: tuplas (formato 'tuplas-v1') — ~5× menor.
// Layout 2 (Política 1.2): além do que o motor usa, guarda o necessário para a RENTABILIDADE SEM refazer a leitura completa:
//   venda  — valor_produtos e desconto do cabeçalho (só se > 0) e, por item, o custo gravado na venda (custo DA ÉPOCA no ERP);
//   compra — valor_produtos, frete, impostos e desconto do cabeçalho (rateio do custo). Ainda SEM cliente/vendedor/documento.
// Leitura retrocompatível: tuplas v1 (sem esses campos) decodificam com os campos ausentes → a rentabilidade marca "dado ausente".
const nz = v => (v !== undefined && v !== null && v !== '' && Number(v) > 0 ? String(v) : null);
function compactarVenda(v) {
  return { id: String(v.id), data: v.data || null, nome_situacao: v.nome_situacao || null, situacao_estoque: v.situacao_estoque != null ? String(v.situacao_estoque) : null, modificado_em: v.modificado_em || null,
    valor_produtos: v.valor_produtos !== undefined && v.valor_produtos !== null && v.valor_produtos !== '' ? String(v.valor_produtos) : null, desconto_valor: nz(v.desconto_valor), desconto_porcentagem: nz(v.desconto_porcentagem),
    produtos: (v.produtos || []).map(p => { const it = p.produto || p; return { produto_id: it.produto_id != null ? String(it.produto_id) : null, quantidade: it.quantidade, valor_total: it.valor_total, valor_custo: it.valor_custo !== undefined && it.valor_custo !== null && it.valor_custo !== '' ? String(it.valor_custo) : null,
      // preço de tabela só quando houve desconto REAL no item (≈ 3 % dos itens): suficiente e idêntico ao cálculo com o registro completo
      valor_venda: brutoDaLinha(Number(it.quantidade), centavos(it.valor_venda), centavos(it.valor_total)) !== centavos(it.valor_total) ? String(it.valor_venda) : null }; }) };
}
const str = v => (v !== undefined && v !== null && v !== '' ? String(v) : null);
function compactarCompra(w) {
  const c = w.Compra || w;
  return { id: String(c.id), data_emissao: c.data_emissao || null, modificado_em: c.modificado_em || null, nome_situacao: c.nome_situacao || null,
    fornecedor_id: c.fornecedor_id ? String(c.fornecedor_id) : null, valor_frete: str(c.valor_frete), valor_impostos: str(c.valor_impostos), valor_produtos: str(c.valor_produtos), desconto_valor: str(c.desconto_valor),
    produtos: (c.produtos || []).map(p => { const it = p.produto || p; return { produto_id: it.produto_id != null ? String(it.produto_id) : null, quantidade: it.quantidade, valor_custo: it.valor_custo }; }) };
}
// LAYOUT da base (mesmo rótulo de formato 'tuplas-json-v1' nos dois): 1 = idêntico ao do backend anterior; 2 = Política 1.2 (rentabilidade).
// O layout 2 só ACRESCENTA posições ao FIM das tuplas e mantém o sinalizador 1/0 de frete na posição 5: o backend anterior ignora o que vem depois
// e lê a base da 1.2 sem perda — rollback de backend nunca encontra base que não entenda (provado contra o código de produção em test/compras-estoque-deploy-compat).
const codificarVenda = (v, layout) => layout === 1 ? [v.id, v.data, v.nome_situacao, v.situacao_estoque, v.modificado_em, v.produtos.map(i => [i.produto_id, i.quantidade, i.valor_total])] : [v.id, v.data, v.nome_situacao, v.situacao_estoque, v.modificado_em, v.produtos.map(i => [i.produto_id, i.quantidade, i.valor_total, i.valor_custo === undefined ? null : i.valor_custo, i.valor_venda === undefined ? null : i.valor_venda]), v.valor_produtos === undefined ? null : v.valor_produtos, v.desconto_valor || null, v.desconto_porcentagem || null];
const decodificarVenda = t => ({ id: t[0], data: t[1], nome_situacao: t[2], situacao_estoque: t[3], modificado_em: t[4], valor_produtos: t[6] === undefined ? null : t[6], desconto_valor: t[7] === undefined ? null : t[7], desconto_porcentagem: t[8] === undefined ? null : t[8],
  produtos: (t[5] || []).map(i => ({ produto_id: i[0], quantidade: i[1], valor_total: i[2], valor_custo: i[3] === undefined ? null : i[3], valor_venda: i[4] === undefined ? null : i[4] })) });
const flagFrete = c => ((Number(c.valor_frete) || Number(c.valor_impostos)) ? 1 : 0);
const codificarCompra = (c, layout) => layout === 1 ? [c.id, c.data_emissao, c.nome_situacao, c.fornecedor_id, c.modificado_em, flagFrete(c), c.produtos.map(i => [i.produto_id, i.quantidade, i.valor_custo])]
  : [c.id, c.data_emissao, c.nome_situacao, c.fornecedor_id, c.modificado_em, flagFrete(c), c.produtos.map(i => [i.produto_id, i.quantidade, i.valor_custo]), c.valor_produtos === undefined ? null : c.valor_produtos, c.valor_impostos === undefined ? null : c.valor_impostos, c.desconto_valor === undefined ? null : c.desconto_valor, c.valor_frete === undefined ? null : c.valor_frete];
// posição 5: sinalizador 1/0 de frete/imposto (layout 1: sem valores → o landed fica indisponível); layout 2 traz o valor do frete na posição 10
const decodificarCompra = t => ({ id: t[0], data_emissao: t[1], nome_situacao: t[2], fornecedor_id: t[3], modificado_em: t[4], valor_frete: t[10] !== undefined ? t[10] : (typeof t[5] === 'number' ? (t[5] ? '1' : null) : (t[5] === undefined ? null : t[5])), valor_impostos: t[8] === undefined ? null : t[8],
  valor_produtos: t[7] === undefined ? null : t[7], desconto_valor: t[9] === undefined ? null : t[9], produtos: (t[6] || []).map(i => ({ produto_id: i[0], quantidade: i[1], valor_custo: i[2] })) });
function fatiarPorBytes(lista, max = BASE_BYTES_MAX) {
  const out = []; let atual = [], tam = 2;
  for (const x of lista) { const b = Buffer.byteLength(JSON.stringify(x)) + 1; if (atual.length && tam + b > max) { out.push(atual); atual = []; tam = 2; } atual.push(x); tam += b; }
  if (atual.length) out.push(atual);
  return out;
}

/** Snapshot diário COMPLETO do saldo (opção A). Independe de qualquer outro dia. */
function montarSnapshotEstoque(produtos, agora, politica = POLITICA_VIGENTE) {
  return {
    schema_version: politica.stock_snapshot.schema_version, policy_version: politica.policy_version, rules_version: RULES_VERSION,
    data_comercial: dataComercial(agora), timezone: politica.stock_snapshot.timezone, gerado_em: agora.toISOString(),
    produtos_total: produtos.length,
    saldos: Object.fromEntries(produtos.map(p => [p.product_id, p.current_stock])),          // RAW (negativo preservado)
    inativos: produtos.filter(p => !p.active).map(p => p.product_id),
  };
}

/**
 * Visão da TELA (compras_n0_view) — só o que a tela operacional precisa, já processado no servidor:
 *   sugestoes: produtos com sugestão > 0, com estoque negativo ou novos (inclui nome/código para operação; SEM custo)
 *   custos:    custo indicativo por produto da visão — leitura só para gestor (Rules); a tela NÃO calcula nada pesado
 */
// ATENÇÃO (Fase D.1) — só VISIBILIDADE: nunca muda elegibilidade, quantidade ou prioridade (a sugestão vem pronta do
// motor). Cada motivo é derivado de um sinal que o motor já prova; um produto = UMA linha com attention_reasons[].
//   NEVER_SOLD            sem nenhuma venda válida no histórico (sem "última venda" — não se inventa data)
//   NO_SALE_365D/180D/120D  faixa de parado do motor (estoque > 0, não novo); só a faixa MAIS FORTE; nunca junto de NEVER_SOLD
//   EXCESS_COVERAGE       cobertura > limite da política (só existe com velocidade > 0 — sem demanda não há cobertura)
//   INACTIVE_PRODUCT      produto inativo no ERP
//   NEW_PRODUCT_PROTECTED produto novo que ainda NÃO passou na exceção de demanda comprovada (continua sem sugestão)
//   NEGATIVE_STOCK        estoque bruto negativo
//   NO_COST               sem custo cadastrado (rótulo; nenhum valor de custo vai para esta view)
//   LOW_COST_CONFIDENCE   só ANOTAÇÃO: não coloca o produto na aba sozinho (vale para a maior parte do catálogo)
const FAIXAS_SEM_VENDA = ['NO_SALE_365D', 'NO_SALE_180D', 'NO_SALE_120D'];   // da mais forte para a mais fraca
const ATENCAO_ANOTACAO = ['LOW_COST_CONFIDENCE'];
const ATENCAO_MOTIVOS = ['NEGATIVE_STOCK', 'NEVER_SOLD', ...FAIXAS_SEM_VENDA, 'EXCESS_COVERAGE', 'INACTIVE_PRODUCT', 'NEW_PRODUCT_PROTECTED', 'NO_COST', ...ATENCAO_ANOTACAO];

function motivosAtencao(m) {
  const r = m.reason_codes || [], out = [];
  if (m.raw_stock !== null && m.raw_stock < 0) out.push('NEGATIVE_STOCK');
  if (m.never_sold) out.push('NEVER_SOLD');
  else { const faixa = FAIXAS_SEM_VENDA.find(f => r.includes(f)); if (faixa) out.push(faixa); }
  if (m.coverage && m.coverage.estado === 'COVERAGE_EXCESS') out.push('EXCESS_COVERAGE');
  if (m.active === false) out.push('INACTIVE_PRODUCT');
  if (m.new_product && !(m.new_product_proven_demand && m.new_product_proven_demand.accepted)) out.push('NEW_PRODUCT_PROTECTED');
  if (m.cost_confidence === 'NO_COST') out.push('NO_COST');
  if (m.cost_confidence === 'LOW_CONFIDENCE_COST') out.push('LOW_COST_CONFIDENCE');
  return out;
}

function montarView(r, porId, custos, agora, hoje, financeiro = null, softLimitBytes = null) {
  // conjunto da Fase D (sugestão ∪ negativo ∪ novo) — o documento de custos continua restrito a ele
  const incluirSugestao = m => m.suggestion.suggested_qty > 0 || m.raw_stock < 0 || m.new_product;
  const linha = m => {
    const p = porId[m.product_id] || {};
    const s = m.suggestion;
    return {
      id: m.product_id, codigo: p.code || null, nome: p.name || null, grupo: p.group_name || null,
      abc: m.abc_revenue, abc_unidades: m.abc_units, estoque: m.raw_stock, disponivel: m.available_stock_for_replenishment,
      vendas: s.sales, velocidade: m.policy_velocity, cobertura_dias: m.coverage.dias, cobertura_estado: m.coverage.estado,
      alvo_dias: s.target_days, qtd: s.suggested_qty, prioridade: s.priority,
      novo_com_demanda: s.eligibility_path === 'NEW_PRODUCT_WITH_PROVEN_DEMAND', novo_protegido: m.new_product && s.eligibility_path !== 'NEW_PRODUCT_WITH_PROVEN_DEMAND',
      estoque_negativo: m.raw_stock < 0, motivos: m.reason_codes, ultima_venda: m.last_sale_date, fornecedor: m.last_supplier,
      attention_reasons: motivosAtencao(m),
    };
  };
  // linha COMPACTA de quem entra só pela Atenção (sem sugestão): sem fornecedor/velocidade/alvo, sem campos vazios e,
  // no lugar da lista completa de reason codes, só o PORQUÊ de não haver sugestão (exclusões da política)
  const linhaAtencao = m => {
    const p = porId[m.product_id] || {};
    const l = { id: m.product_id, codigo: p.code || null, nome: p.name || null, abc: m.abc_revenue, estoque: m.raw_stock, vendas: m.suggestion.sales,
      cobertura_estado: m.coverage.estado, qtd: 0, prioridade: null, attention_reasons: motivosAtencao(m), sem_sugestao_por: m.suggestion.exclusions || [] };
    if (p.group_name) l.grupo = p.group_name;
    if (m.coverage.dias !== null && m.coverage.dias !== undefined) l.cobertura_dias = m.coverage.dias;
    if (m.last_sale_date) l.ultima_venda = m.last_sale_date;
    return l;
  };
  const doAtencao = m => motivosAtencao(m).some(k => !ATENCAO_ANOTACAO.includes(k));
  const linhas = r.metricas.filter(m => incluirSugestao(m) || doAtencao(m))
    .map(m => (incluirSugestao(m) ? linha(m) : linhaAtencao(m)))
    .sort((a, b) => (a.prioridade || 'P9').localeCompare(b.prioridade || 'P9') || (b.qtd - a.qtd) || String(a.id).localeCompare(String(b.id)));
  const idsSugestao = new Set(r.metricas.filter(incluirSugestao).map(m => m.product_id));
  const cont = f => linhas.filter(f).length;
  const soAtencao = linhas.filter(l => !(l.qtd > 0) && l.attention_reasons.some(k => !ATENCAO_ANOTACAO.includes(k)));
  const custoPorId = Object.fromEntries(custos.map(k => [k.product_id, k]));
  // REVISÃO DE RENTABILIDADE (Política 1.2): produtos FORA da lista operacional que precisam de olhar financeiro (margem negativa, custo de baixa
  // confiança/ausente, alta demanda + margem baixa, preço cadastrado em vez de realizado). Linhas ENXUTAS (sem estoque/cobertura) que ficam só
  // neste documento — `sugestoes.linhas` (e a aba Atenção) não mudam. Se o documento passar do limite brando, as de "só preço cadastrado" saem primeiro.
  const precisaRevisao = f => !!f && ((f.margin && f.margin.negative === true) || !(f.cost && f.cost.unit_cents > 0) || (f.cost && (f.cost.confidence === 'LOW' || f.cost.confidence === 'UNKNOWN')) || ((f.decision && f.decision.signals) || []).includes('HIGH_DEMAND_LOW_MARGIN'));
  const soFallback = f => f.price && f.price.source === 'REGISTERED_FALLBACK';
  const revisaoLinhas = (incluirFallback, completa) => !financeiro ? [] : r.metricas.filter(m => !idsSugestao.has(m.product_id)).map(m => ({ m, f: financeiro.porProduto.get(m.product_id) }))
    .filter(x => x.f && (precisaRevisao(x.f) || (incluirFallback && soFallback(x.f)))).sort((a, b) => String(a.m.product_id).localeCompare(String(b.m.product_id)))
    .map(({ m, f }) => { const p = porId[m.product_id] || {}; const o = { id: m.product_id, codigo: p.code || null, nome: p.name || null, abc: m.abc_revenue, fin: Rent.fichaDaLista(f, completa && precisaRevisao(f)) }; if (p.group_name) o.grupo = p.group_name; return o; });
  const docCustos = (completa, revFallback = true) => ({ policy_version: r.policy_version, gerado_em: agora.toISOString(), aviso: 'CUSTO INDICATIVO (cadastrado no ERP; confiança baixa; sem frete/impostos rateados) — não é necessidade financeira',
      // Política 1.2 (só quando ativa): rentabilidade por linha e resumo agregado — ficam SÓ neste documento (leitura de gestor)
      ...(financeiro ? { resumo_financeiro: financeiro.resumo, detalhe_financeiro: completa ? 'COMPLETO' : 'RESUMIDO', revisao: revisaoLinhas(revFallback, completa), revisao_parcial: !revFallback } : {}),
      linhas: Object.fromEntries(linhas.filter(l => idsSugestao.has(l.id)).map(l => { const k = custoPorId[l.id] || {}; return [l.id, { custo_cadastrado_cents: k.registered_cost_cents ?? null, ultimo_custo_compra_cents: k.last_purchase_cost_cents ?? null, confianca: k.cost_confidence || null, valor_sugestao_custo_conhecido_cents: k.suggestion_value_known_cost_only_cents ?? null, ...(financeiro ? { fin: Rent.fichaDaLista(financeiro.porProduto.get(l.id), completa) } : {}) }]; })) });
  let viewCustos = docCustos(true);
  const passou = d => Buffer.byteLength(JSON.stringify(d)) > softLimitBytes;
  if (financeiro && softLimitBytes !== null && passou(viewCustos)) viewCustos = docCustos(false);                       // degrau 1: ficha enxuta
  if (financeiro && softLimitBytes !== null && passou(viewCustos)) viewCustos = docCustos(false, false);                // degrau 2: sai a revisão de "só preço cadastrado" (contagem continua no resumo)
  return {
    sugestoes: { policy_version: r.policy_version, gerado_em: agora.toISOString(), data_comercial: hoje, total_linhas: linhas.length,
      contagens: { sugeridos: cont(l => l.qtd > 0), unidades: linhas.reduce((t, l) => t + (l.qtd || 0), 0), P1: cont(l => l.prioridade === 'P1'), P2: cont(l => l.prioridade === 'P2'), P3: cont(l => l.prioridade === 'P3'), P4: cont(l => l.prioridade === 'P4'), estoque_negativo: cont(l => l.estoque_negativo), novo_com_demanda: cont(l => l.novo_com_demanda), novo_protegido: cont(l => l.novo_protegido),
        atencao: { produtos: soAtencao.length, por_motivo: Object.fromEntries(ATENCAO_MOTIVOS.map(k => [k, soAtencao.filter(l => l.attention_reasons.includes(k)).length])) } },
      linhas },
    custos: viewCustos,
  };
}

/** O resumo é lido por quem tem o módulo estoque: a política publicada ali NÃO leva o bloco de rentabilidade (limiares de margem, fornecedores importados). */
function semRentabilidade(politica) { if (!politica.profitability) return politica; const { profitability, ...resto } = politica; return resto; }   // 1.0/1.1: o próprio objeto (identidade preservada)

function montarSnapshot({ brutosProdutos, brutosVendas, brutosCompras, agora = new Date(), estatisticas = {}, politica = POLITICA_VIGENTE, modo = 'FULL' }) {
  const hoje = dataComercial(agora);
  const produtos = brutosProdutos.map(mapearProduto);
  const fatosVenda = brutosVendas.flatMap(fatosDeVenda);
  const fatosCompra = brutosCompras.flatMap(fatosDeCompra);
  const r = calcularTudo({ produtos, fatosVenda, fatosCompra, hoje, politica });
  const porId = Object.fromEntries(produtos.map(p => [p.product_id, p]));
  const ultimoCustoCompra = {};
  for (const f of fatosCompra) if (f.status === 'CONFIRMADA' && f.product_id && f.unit_cost_cents != null && (!ultimoCustoCompra[f.product_id] || f.issue_date > ultimoCustoCompra[f.product_id].data)) ultimoCustoCompra[f.product_id] = { data: f.issue_date, custo: f.unit_cost_cents };
  const operacional = r.metricas.map(m => { const { revenue_cents, ...resto } = m; return { ...resto, code: porId[m.product_id].code, group_id: porId[m.product_id].group_id }; });
  const custos = r.metricas.map(m => {
    const p = porId[m.product_id];
    return { product_id: m.product_id, policy_version: r.policy_version, registered_cost_cents: p.registered_cost_cents, sale_price_cents: p.sale_price_cents,
      last_purchase_cost_cents: ultimoCustoCompra[m.product_id] ? ultimoCustoCompra[m.product_id].custo : null, last_purchase_cost_date: ultimoCustoCompra[m.product_id] ? ultimoCustoCompra[m.product_id].data : null,
      revenue_cents: m.revenue_cents,
      indicative_registered_cost_value_cents: m.current_stock > 0 && p.registered_cost_cents != null ? Math.round(m.current_stock * p.registered_cost_cents) : null,
      cost_confidence: m.cost_confidence,
      // Valor da sugestão SÓ com KNOWN_COST; parcial, sem frete/impostos rateados. NÃO é necessidade financeira.
      suggestion_value_known_cost_only_cents: m.cost_confidence === 'KNOWN_COST' && m.suggestion.suggested_qty > 0 ? m.suggestion.suggested_qty * p.registered_cost_cents : null,
      scenario_purchase_value_known_cost_only_cents: Object.fromEntries(Object.entries(m.scenarios).map(([n, sc]) => [n, m.cost_confidence === 'KNOWN_COST' && sc.suggested_qty > 0 ? sc.suggested_qty * p.registered_cost_cents : null])) };
  });
  // Política 1.2 (rentabilidade): só se a política tiver o bloco ativo. A decisão de compra (1.1) já está calculada e NÃO é tocada.
  const financeiro = politica.profitability && politica.profitability.enabled ? Rent.calcularFinanceiro({ produtos, metricas: r.metricas, fatosVenda, fatosCompra, hoje, politica }) : null;
  if (financeiro) { for (const [id, f] of financeiro.porProduto) financeiro.porProduto.set(id, Rent.compactarFin(f)); for (const k of custos) k.fin = financeiro.porProduto.get(k.product_id); }   // grava a forma compacta (decisões já calculadas)
  const cont = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.length : cont(v)]));
  const pol = resumoPolitica(r);
  delete pol.stockout_not_suggested_detail;   // detalhe por produto fica fora do resumo compartilhado
  return {
    resumo: { versao: RULES_VERSION, policy_version: r.policy_version, politica: semRentabilidade(r.politica), gerado_em: agora.toISOString(), data_comercial: hoje, fuso: politica.stock_snapshot.timezone, modo_sync: modo,
      produtos: produtos.length, contagens: cont(r.agregados), listas: r.agregados, data_venda_mais_antiga: r.data_venda_mais_antiga,
      produtos_de_venda_nao_encontrados: r.produtos_de_venda_nao_encontrados.length, limitacoes: LIMITACOES,
      resumo_politica: pol, calibracao: resumoCalibracao(r) },
    operacional, custos,
    meta: { versao: RULES_VERSION, policy_version: r.policy_version, modo_sync: modo, ultima_sincronizacao_ok: agora.toISOString(), data_comercial: hoje, estatisticas: { ...estatisticas, duplicatas_de_linha: r.duplicatas } },
    snapshotEstoque: montarSnapshotEstoque(produtos, agora, politica),
    view: montarView(r, porId, custos, agora, hoje, financeiro, financeiro ? politica.profitability.view.soft_limit_bytes : null),
    base: { layout: layoutDaPolitica(politica), vendas: brutosVendas.map(compactarVenda), compras: brutosCompras.map(compactarCompra) },
  };
}

// ── Base do incremental: GERAÇÕES (write-then-switch) ─────────────────────────────────────────────────────────────
// Cada gravação da base cria uma GERAÇÃO nova (ids próprios: <geracao>_v_000…, <geracao>_c_000…); a geração ativa é
// apontada por compras_n0/meta.base_ativa {geracao, formato, vendas, compras, gerado_em}. Sequência:
//   1) grava TODAS as fatias da geração nova (nunca sobrescreve a ativa);
//   2) troca o ponteiro no MESMO commit do snapshot visível (transação que confere a trava, quando há run_id);
//   3) só então apaga as fatias das gerações substituídas — allowlist exata calculada dos ponteiros do meta
//      (ativa anterior, pendente de tentativa que falhou, órfãs de limpeza interrompida). Nunca lista/apaga por prefixo.
// O leitor usa SÓ o ponteiro: busca cada fatia pelo id, confere geração/índice/quantidade e falha FECHADO se faltar.
// Legado (antes das gerações): ids v_NNN/c_NNN com meta.base_docs; lido e substituído pela mesma regra.
const FORMATO_BASE = 'tuplas-json-v1';                          // rótulo de formato: o MESMO em produção e na 1.2 (o backend anterior só aceita este)
const LAYOUT_BASE_V2 = 2;                                        // layout da Política 1.2 (campos de rentabilidade no fim das tuplas); ausente = layout 1 (produção)
const layoutDaPolitica = politica => (politica && politica.profitability && politica.profitability.enabled ? LAYOUT_BASE_V2 : 1);   // 1.0/1.1 continuam gravando o layout 1
const FORMATOS_BASE_ACEITOS = [FORMATO_BASE];
const RE_ID_FATIA = /^(g\d+x[0-9a-f]{6}_)?[vc]_\d{3}$/;
// geração ÚNICA por tentativa (instante + sufixo aleatório): duas gravações nunca compartilham ids, nem no mesmo instante
const idGeracao = quando => 'g' + String(quando).replace(/\D/g, '') + 'x' + require('crypto').randomBytes(3).toString('hex');
const idFatia = (ref, tipo, i) => (ref.geracao ? ref.geracao + '_' : '') + tipo + '_' + String(i).padStart(3, '0');
function idsDaBase(ref) {
  if (!ref) return [];
  return [...Array.from({ length: ref.vendas || 0 }, (_, i) => idFatia(ref, 'v', i)), ...Array.from({ length: ref.compras || 0 }, (_, i) => idFatia(ref, 'c', i))];
}
/** Ponteiro da base ativa a partir do meta (geração ou legado). null = não há base. */
function refBaseAtiva(meta) {
  if (!meta) return null;
  if (meta.base_ativa && meta.base_ativa.geracao) return meta.base_ativa;
  if (meta.base_docs && (meta.base_docs.vendas || meta.base_docs.compras)) return { geracao: null, formato: FORMATO_BASE, vendas: meta.base_docs.vendas || 0, compras: meta.base_docs.compras || 0, gerado_em: meta.ultima_sincronizacao_ok, legado: true };
  return null;
}
function erroBase(codigo, detalhe) { const e = new Error(codigo + (detalhe ? ' ' + detalhe : '')); e.codigo = codigo; return e; }

/**
 * Grava o snapshot. Guardas ANTES de qualquer escrita: nenhum documento > DOC_BYTES_MAX (senão aborta sem gravar).
 * Se o total couber num commit → UM commit atômico (base nova + snapshot + ponteiro). Se não couber → as fatias da
 * geração nova vão antes, em lotes próprios (ids novos: a base ativa continua intacta), e o snapshot visível + o
 * ponteiro vão num commit final — o app e o incremental nunca veem metade de uma base ou de um snapshot.
 * opts.runId: confere na transação final que a trava ainda é desta execução (senão LOCK_PERDIDO, nada troca).
 */
async function persistirSnapshot(db, snap, { runId, loteBytesMax = LOTE_BYTES_MAX } = {}) {   // loteBytesMax: só testes
  const blocos = (lista) => { const b = []; for (let i = 0; i < lista.length; i += BLOCO) b.push(lista.slice(i, i + BLOCO)); return b; };
  const op = blocos(snap.operacional), ct = blocos(snap.custos);
  const layout = snap.base ? (snap.base.layout || LAYOUT_BASE_V2) : null;   // montarSnapshot sempre informa o layout (1 na 1.0/1.1, 2 na 1.2)
  const marcaLayout = layout === LAYOUT_BASE_V2 ? { layout: LAYOUT_BASE_V2 } : {};
  const bv = snap.base ? fatiarPorBytes(snap.base.vendas.map(x => codificarVenda(x, layout))) : [], bc = snap.base ? fatiarPorBytes(snap.base.compras.map(x => codificarCompra(x, layout))) : [];
  const pv = snap.meta.policy_version, quando = snap.meta.ultima_sincronizacao_ok;
  const refMeta = db.collection('compras_n0').doc('meta'), refLock = db.collection('compras_n0').doc('lock');
  const metaAnt = (await refMeta.get()).data() || {};
  const ativaAnt = refBaseAtiva(metaAnt);
  const refNova = snap.base ? { geracao: idGeracao(quando), formato: FORMATO_BASE, ...marcaLayout, vendas: bv.length, compras: bc.length, gerado_em: quando } : null;
  // Firestore NÃO aceita arrays aninhados: cada fatia de tuplas vai como UMA string JSON (campo texto).
  const docsBase = refNova ? [...bv.map((b, i) => ['compras_n0_base', idFatia(refNova, 'v', i), { geracao: refNova.geracao, gerado_em: quando, formato: FORMATO_BASE, ...marcaLayout, indice: i, n: b.length, registros_json: JSON.stringify(b) }]),
    ...bc.map((b, i) => ['compras_n0_base', idFatia(refNova, 'c', i), { geracao: refNova.geracao, gerado_em: quando, formato: FORMATO_BASE, ...marcaLayout, indice: i, n: b.length, registros_json: JSON.stringify(b) }])] : [];
  const baseBytes = docsBase.reduce((s, d) => s + Buffer.byteLength(JSON.stringify(d[2])), 0);
  // gerações substituídas (allowlist): ativa anterior + pendente de tentativa que falhou + órfãs de limpeza interrompida
  const substituidas = refNova ? [ativaAnt, metaAnt.base_pendente, ...(metaAnt.base_orfas || [])].filter(r => r && (r.legado || r.geracao !== refNova.geracao)) : [];
  const idsNovos = new Set(docsBase.map(d => d[1]));
  const baseMeta = refNova
    ? { base_ativa: refNova, base_docs: { vendas: bv.length, compras: bc.length }, base_bytes: baseBytes, avisos: avisosBase(baseBytes), base_orfas: substituidas.length ? substituidas : null }
    : { base_ativa: metaAnt.base_ativa || null, base_docs: metaAnt.base_docs || { vendas: 0, compras: 0 }, base_bytes: metaAnt.base_bytes ?? snap.meta.base_bytes ?? null, avisos: [], base_orfas: metaAnt.base_orfas || null };
  const docsVisiveis = [...op.map((b, i) => ['compras_n0_produtos', 'bloco_' + String(i).padStart(3, '0'), { gerado_em: quando, policy_version: pv, indice: i, produtos: b }]),
    ...ct.map((b, i) => ['compras_n0_custos', 'bloco_' + String(i).padStart(3, '0'), { gerado_em: quando, policy_version: pv, indice: i, produtos: b }]),
    ['compras_n0', 'resumo', { ...snap.resumo, blocos: op.length }],
    ['compras_n0', 'meta', { ...snap.meta, ...baseMeta, base_limite_operacional_bytes: BASE_LIMITE_OPERACIONAL_BYTES, ultima_tentativa: quando, ultima_tentativa_ok: true, erro: null }],
    ['estoque_snapshots', snap.snapshotEstoque.data_comercial, snap.snapshotEstoque],   // mesmo dia: substitui (último sync vence)
    ...(snap.view ? [['compras_n0_view', 'sugestoes', snap.view.sugestoes], ['compras_n0_view', 'custos', snap.view.custos]] : [])];
  const tam = d => Buffer.byteLength(JSON.stringify(d[2]));
  for (const d of [...docsBase, ...docsVisiveis]) if (tam(d) > DOC_BYTES_MAX) { const e = new Error(`DOC_GRANDE_DEMAIS ${d[0]}/${d[1]}: ${tam(d)} bytes`); e.codigo = 'DOC_GRANDE_DEMAIS'; throw e; }
  for (const d of [...docsBase, ...docsVisiveis]) if (temArrayAninhado(d[2])) { const e = new Error(`DOC_INCOMPATIVEL_FIRESTORE ${d[0]}/${d[1]}: array aninhado`); e.codigo = 'DOC_INCOMPATIVEL_FIRESTORE'; throw e; }
  const gravar = async docs => { const l = db.batch(); for (const [c, id, v] of docs) l.set(db.collection(c).doc(id), v); await l.commit(); };
  // commit final: com runId, transação que confere a trava antes de trocar o ponteiro (execução que perdeu a trava não troca nada)
  const trocar = async docs => {
    if (!runId) return gravar(docs);
    return db.runTransaction(async tx => {
      const t = await tx.get(refLock);
      if (!t.exists || t.data().run_id !== runId) throw erroBase('LOCK_PERDIDO', 'a trava não pertence mais a esta execução');
      for (const [c, id, v] of docs) tx.set(db.collection(c).doc(id), v);
    });
  };
  const total = [...docsBase, ...docsVisiveis].reduce((s, d) => s + tam(d), 0);
  let lotes = 1;
  if (total <= loteBytesMax && docsBase.length + docsVisiveis.length <= LOTE_OPS_MAX) await trocar([...docsBase, ...docsVisiveis]);
  else {
    // marca a geração nova como PENDENTE antes de gravar fatias fora do commit final: se falhar no meio, a próxima
    // gravação sabe exatamente quais ids apagar. A base ativa e o ponteiro continuam intactos.
    if (refNova) await refMeta.set({ ...metaAnt, base_pendente: refNova });
    let atual = [], bytes = 0; lotes = 0;
    for (const d of docsBase) { if (atual.length && (bytes + tam(d) > loteBytesMax || atual.length >= LOTE_OPS_MAX)) { await gravar(atual); lotes++; atual = []; bytes = 0; } atual.push(d); bytes += tam(d); }
    if (atual.length) { await gravar(atual); lotes++; }
    await trocar(docsVisiveis); lotes++;
  }
  snap.persistencia = { lotes, bytes_total: total, maior_doc_bytes: Math.max(...[...docsBase, ...docsVisiveis].map(tam)), base_bytes: snap.base ? baseBytes : null, avisos: snap.base ? avisosBase(baseBytes) : [], geracao: refNova ? refNova.geracao : null };
  // blocos visíveis excedentes (fora da base; mesmo comportamento anterior)
  for (const [col, pref, n] of [['compras_n0_produtos', 'bloco_', op.length], ['compras_n0_custos', 'bloco_', ct.length]]) {
    for (const d of (await db.collection(col).get()).docs) if (d.id.startsWith(pref) && Number(d.id.slice(pref.length)) >= n) await d.ref.delete();
  }
  snap.persistencia.limpeza_base = refNova ? await limparGeracoesSubstituidas(db, { substituidas, idsNovos, refNova, runId, quando }) : { removidos: 0, pendentes: 0 };
}

/**
 * Apaga SÓ as fatias das gerações substituídas (ids exatos derivados dos ponteiros), depois que a geração nova já está
 * ativa. Nunca toca a geração ativa, nunca lista a coleção. Com runId, só limpa se a trava ainda for desta execução.
 * Se não conseguir, as órfãs continuam registradas em meta.base_orfas e a próxima gravação conclui a limpeza.
 */
async function limparGeracoesSubstituidas(db, { substituidas, idsNovos, refNova, runId, quando }) {
  const alvo = [...new Set(substituidas.flatMap(idsDaBase))].filter(id => !idsNovos.has(id));
  for (const id of alvo) if (!RE_ID_FATIA.test(id) || idsNovos.has(id)) throw erroBase('LIMPEZA_FORA_DO_ESCOPO', id);   // nunca a geração ativa
  const refMeta = db.collection('compras_n0').doc('meta'), refLock = db.collection('compras_n0').doc('lock');
  try {
    if (runId) { const t = await refLock.get(); if (!t.exists || t.data().run_id !== runId) return { removidos: 0, pendentes: alvo.length, motivo: 'LOCK_PERDIDO' }; }
    for (let i = 0; i < alvo.length; i += LOTE_OPS_MAX) {
      const l = db.batch();
      for (const id of alvo.slice(i, i + LOTE_OPS_MAX)) l.delete(db.collection('compras_n0_base').doc(id));
      await l.commit();
    }
    // limpeza concluída: tira as órfãs do meta (só se o meta ainda for desta gravação)
    const m = (await refMeta.get()).data();
    if (m && m.base_ativa && m.base_ativa.geracao === refNova.geracao && m.ultima_sincronizacao_ok === quando && m.base_orfas) { const { base_orfas, ...resto } = m; await refMeta.set({ ...resto, base_orfas: null }); }
    return { removidos: alvo.length, pendentes: 0 };
  } catch (e) {
    return { removidos: 0, pendentes: alvo.length, motivo: String(e.codigo || e.message).slice(0, 80) };   // órfãs seguem em meta.base_orfas
  }
}

/**
 * Lê a base compacta da GERAÇÃO ATIVA (para o incremental). null se não houver base.
 * Busca cada fatia pelo id derivado do ponteiro (sem listar a coleção); fatia ausente, de outra geração, com índice ou
 * quantidade divergente → BASE_INCOMPLETA (falha fechada: o incremental não roda sobre base parcial).
 */
async function carregarBase(db) {
  const meta = (await db.collection('compras_n0').doc('meta').get()).data();
  const ref = refBaseAtiva(meta);
  if (!ref) return null;
  const vendas = [], compras = [];
  for (const id of idsDaBase(ref)) {
    const d = await db.collection('compras_n0_base').doc(id).get();
    if (!d.exists) throw erroBase('BASE_INCOMPLETA', 'fatia ausente ' + id);
    const x = d.data() || {};
    const indice = Number(id.slice(-3));
    if (!FORMATOS_BASE_ACEITOS.includes(x.formato) || (x.layout || 1) !== (ref.layout || 1) || x.indice !== indice || (ref.geracao ? x.geracao !== ref.geracao : x.gerado_em !== ref.gerado_em)) throw erroBase('BASE_INCOMPLETA', 'fatia de outra geração ' + id);
    let regs; try { regs = JSON.parse(x.registros_json); } catch (e) { throw erroBase('BASE_INCOMPLETA', 'fatia ilegível ' + id); }
    if (!Array.isArray(regs) || regs.length !== x.n) throw erroBase('BASE_INCOMPLETA', 'quantidade divergente ' + id);
    if (id.includes('v_')) vendas.push(...regs.map(decodificarVenda)); else compras.push(...regs.map(decodificarCompra));
  }
  return { vendas, compras, formato: ref.formato || FORMATO_BASE, layout: ref.layout || 1 };
}

async function registrarFalha(db, agora, e, modo) {
  const ref = db.collection('compras_n0').doc('meta');
  const anterior = (await ref.get()).data() || {};
  await ref.set({ ...anterior, ultima_tentativa: agora.toISOString(), ultima_tentativa_ok: false, ultima_tentativa_modo: modo, erro: String(e.codigo || e.message).slice(0, 200) });
}

/** SYNC COMPLETO (reconciliação): relê tudo e SUBSTITUI a base (remove o que foi excluído no ERP). */
async function executarSync({ cli, db, agora = new Date(), inicio = '2022-01-01', fetchMod = require('./fetch'), politica = POLITICA_VIGENTE, runId }) {
  const hoje = dataComercial(agora);
  try {
    const pr = await fetchMod.buscarProdutos(cli);
    const ve = await fetchMod.buscarPorJanelas(cli, 'vendas', { inicio, fim: hoje });
    const co = await fetchMod.buscarPorJanelas(cli, 'compras', { inicio, fim: hoje });
    const snap = montarSnapshot({ brutosProdutos: pr.produtos, brutosVendas: ve.registros, brutosCompras: co.registros, agora, politica, modo: 'FULL', estatisticas: { produtos: pr.estatisticas, vendas: ve.estatisticas, compras: co.estatisticas } });
    snap.meta.ultima_reconciliacao_completa = agora.toISOString();
    await persistirSnapshot(db, snap, { runId });
    return { ok: true, modo: 'FULL', snapshot: snap };
  } catch (e) {
    await registrarFalha(db, agora, e, 'FULL');
    return { ok: false, modo: 'FULL', erro: e.message };
  }
}

/**
 * SYNC INCREMENTAL (atualização operacional): todos os produtos + vendas/compras pela retrovisão da política (+ futuro),
 * mesclados sobre a base pela versão mais recente. Não enxerga exclusões nem alterações mais antigas que a
 * retrovisão — por isso o COMPLETO diário é obrigatório. Sem base → exige completo.
 */
async function executarSyncIncremental({ cli, db, agora = new Date(), fetchMod = require('./fetch'), politica = POLITICA_VIGENTE, runId }) {
  const hoje = dataComercial(agora);
  try {
    const base = await carregarBase(db);
    if (!base) { const e = new Error('BASE_AUSENTE: executar sync completo primeiro'); e.codigo = 'BASE_AUSENTE_EXIGE_FULL'; throw e; }
    // Política 1.2 precisa dos campos de rentabilidade que só a base v2 guarda; base v1 ⇒ falha FECHADA antes de qualquer leitura no ERP (o COMPLETO regrava em v2)
    if (politica.profitability && politica.profitability.enabled && base.layout !== LAYOUT_BASE_V2) { const e = new Error('BASE_V1_EXIGE_FULL: a Política 1.2 exige sync completo para gravar a base com layout 2'); e.codigo = 'BASE_V1_EXIGE_FULL'; throw e; }
    const metaAnterior = (await db.collection('compras_n0').doc('meta').get()).data() || {};
    const plano = fetchMod.planoIncremental(hoje, politica.sync.incremental_lookback_days);
    const pr = await fetchMod.buscarProdutos(cli);
    const ve = await fetchMod.buscarPorJanelas(cli, 'vendas', { inicio: plano.vendas.inicio, fim: hoje, janelaAnterior: false, conferenciaGlobal: false });
    const co = await fetchMod.buscarPorJanelas(cli, 'compras', { inicio: plano.compras.inicio, fim: hoje, janelaAnterior: false, conferenciaGlobal: false });
    const mv = fetchMod.mesclarRegistros(base.vendas, ve.registros.map(compactarVenda));
    const mc = fetchMod.mesclarRegistros(base.compras, co.registros.map(compactarCompra));
    const snap = montarSnapshot({ brutosProdutos: pr.produtos, brutosVendas: mv.registros, brutosCompras: mc.registros, agora, politica, modo: 'INCREMENTAL',
      estatisticas: { produtos: pr.estatisticas, vendas: ve.estatisticas, compras: co.estatisticas, lookback_dias: plano.lookback_dias,
        mescla: { vendas: { inseridos: mv.inseridos, substituidos: mv.substituidos, ignorados: mv.ignorados }, compras: { inseridos: mc.inseridos, substituidos: mc.substituidos, ignorados: mc.ignorados } } } });
    const ultFull = metaAnterior.ultima_reconciliacao_completa || null;
    snap.meta.ultima_reconciliacao_completa = ultFull;
    snap.meta.reconciliacao_atrasada = !ultFull || (agora.getTime() - Date.parse(ultFull)) / 3600000 > politica.sync.full_overdue_after_hours;
    await persistirSnapshot(db, snap, { runId });
    return { ok: true, modo: 'INCREMENTAL', snapshot: snap };
  } catch (e) {
    await registrarFalha(db, agora, e, 'INCREMENTAL');
    return { ok: false, modo: 'INCREMENTAL', erro: e.message };
  }
}

// ── Snapshot diário: leitura, retenção ────────────────────────────────────────────────────────────────────────────
/** Lê o saldo de UM dia comercial — um único documento, sem depender do dia anterior. */
async function lerSaldoDoDia(db, dia) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error('DIA_INVALIDO');
  const d = (await db.collection('estoque_snapshots').doc(dia).get()).data();
  return d ? { dia, policy_version: d.policy_version, schema_version: d.schema_version, saldos: d.saldos, inativos: d.inativos || [] } : null;
}
/** Dias fora da retenção da política (só lista; a exclusão real será uma decisão/rotina futura). */
function diasParaExpurgo(dias, hoje, politica = POLITICA_VIGENTE) {
  const corte = new Date(Date.parse(hoje + 'T00:00:00Z') - politica.stock_snapshot.retention_days * 86400000).toISOString().slice(0, 10);
  return dias.filter(d => d < corte).sort();
}

// ── Opção B (avaliada na Fase 1, NÃO adotada): delta + baseline ───────────────────────────────────────────────────
function snapshotDelta(anterior, atual) {
  const mud = {};
  for (const [id, v] of Object.entries(atual)) if (anterior[id] !== v) mud[id] = v;
  for (const id of Object.keys(anterior)) if (!(id in atual)) mud[id] = null;
  return mud;
}
function reconstruirSaldos(baseline, deltas, dia) {
  if (!baseline || baseline.data > dia) throw new Error('SEM_BASELINE_ATE_' + dia);
  const out = { ...baseline.saldos };
  for (const d of [...deltas].filter(x => x.data > baseline.data && x.data <= dia).sort((a, b) => a.data.localeCompare(b.data))) {
    for (const [id, v] of Object.entries(d.mudancas)) { if (v === null) delete out[id]; else out[id] = v; }
  }
  return out;
}
/** Estimativa de armazenamento (bytes) das opções A e B. */
function estimarArmazenamento({ produtos, bytesPorProduto, mudancasPorDia, anos, crescimentoAnual = 0.15, baselineACadaDias = 7 }) {
  let a = 0, b = 0, n = produtos;
  for (let ano = 0; ano < anos; ano++) {
    const docA = n * bytesPorProduto + 32, delta = Math.min(n, mudancasPorDia * (1 + crescimentoAnual) ** ano) * bytesPorProduto + 32;
    a += 365 * docA;
    b += (365 / baselineACadaDias) * docA + (365 - 365 / baselineACadaDias) * delta;
    n = Math.round(n * (1 + crescimentoAnual));
  }
  return { opcao_A_bytes: Math.round(a), opcao_B_bytes: Math.round(b), produtos_no_fim: n };
}

module.exports = { FORMATO_BASE, LAYOUT_BASE_V2, layoutDaPolitica, FORMATOS_BASE_ACEITOS, idGeracao, idFatia, idsDaBase, refBaseAtiva, limparGeracoesSubstituidas, LIMITACOES, montarView, motivosAtencao, ATENCAO_MOTIVOS, ATENCAO_ANOTACAO, FAIXAS_SEM_VENDA, temArrayAninhado, BLOCO, DOC_BYTES_MAX, LOTE_BYTES_MAX, LOTE_OPS_MAX, BASE_LIMITE_OPERACIONAL_BYTES, avisosBase, frescor, compactarVenda, compactarCompra, codificarVenda, decodificarVenda, codificarCompra, decodificarCompra, fatiarPorBytes, montarSnapshotEstoque, montarSnapshot, persistirSnapshot, carregarBase, executarSync, executarSyncIncremental, lerSaldoDoDia, diasParaExpurgo, snapshotDelta, reconstruirSaldos, estimarArmazenamento };
