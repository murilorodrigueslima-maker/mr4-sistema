'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.3 em SOMBRA: leitura, comparação 1.2 × 1.3 e gravação ISOLADA.
// Não é exportado em functions/index.js, não tem agenda e não altera nada de produção. Escreve SOMENTE na coleção
// própria compras_sombra_13 (allowlist abaixo) e só quando alguém chama persistirSombra de propósito.
// Loja: os dados vêm do sync de Compras, que consulta apenas a loja ativa 262759 (lib/lojaAtiva).
const { somarDias, fatosDeVenda, fatosDeCompra } = require('./canonico');
const { calcularTudo } = require('./motor');
const { POLITICA_1_2 } = require('./politica');
const { POLITICA_1_3_SOMBRA } = require('./politica13');
const K = require('./calculadora13');
const Compat = require('./docCompat');

const COLECAO = 'compras_sombra_13';
const RE_DOC = /^(meta|resumo|bloco_\d{3}|dia_\d{4}-\d{2}-\d{2})$/;
const BLOCO = 150;
const DOC_BYTES_MAX = 900 * 1024;
const DIAS_DE_SERIE = 400;            // cobre a janela de 365 dias com folga

// ── Leitura (somente get) ───────────────────────────────────────────────────────────────────────────────────────
async function lerEntradas(db) {
  const { carregarBase } = require('./snapshot');
  const todos = async c => (await db.collection(c).get()).docs.map(d => [d.id, d.data()]);
  const meta = (await db.collection('compras_n0').doc('meta').get()).data();
  if (!meta || !meta.data_comercial) throw new Error('SEM_SNAPSHOT_DE_COMPRAS');
  const base = await carregarBase(db);
  if (!base) throw new Error('BASE_AUSENTE');
  const [produtos, custos, snaps] = [await todos('compras_n0_produtos'), await todos('compras_n0_custos'), await todos('estoque_snapshots')];
  return montarEntradas({ meta, vendas: base.vendas, compras: base.compras, produtos, custos, snaps });
}

/** Converte os documentos já lidos nas entradas da sombra (também usada com cópias locais). */
function montarEntradas({ meta, vendas, compras, produtos, custos, snaps }) {
  const custoPorId = new Map(custos.flatMap(([, d]) => d.produtos || []).map(c => [c.product_id, c]));
  const operacionais = produtos.sort((a, b) => a[0].localeCompare(b[0])).flatMap(([, d]) => d.produtos || []);
  const lista = operacionais.map(m => {
    const c = custoPorId.get(m.product_id) || {};
    return { product_id: m.product_id, code: m.code || null, active: m.active, moves_stock: m.moves_stock, has_composition: !!m.kit, current_stock: m.current_stock,
      registered_cost_cents: c.registered_cost_cents ?? null, sale_price_cents: c.sale_price_cents ?? null,
      // a base operacional não guarda a data de cadastro: quando confiável, a 1ª evidência é equivalente para o motor
      created_at: m.created_at_reliable ? m.first_evidence_date : null, created_at_reliable: !!m.created_at_reliable, erp_min_stock: null, group_id: m.group_id || null };
  });
  const gravado = new Map(operacionais.map(m => [m.product_id, m.suggestion ? m.suggestion.suggested_qty : 0]));
  return { hoje: meta.data_comercial, geradoEm: meta.ultima_sincronizacao_ok, produtos: lista, vendas, compras,
    snapshots: Object.fromEntries(snaps), sugestaoGravada12: gravado };
}

// ── Cálculo comparativo ─────────────────────────────────────────────────────────────────────────────────────────
const mediana = a => { if (!a.length) return 0; const o = [...a].sort((x, y) => x - y), k = Math.floor(o.length / 2); return o.length % 2 ? o[k] : (o[k - 1] + o[k]) / 2; };
const soma = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

function calcularSombra(entradas, { politica13 = POLITICA_1_3_SOMBRA, politica12 = POLITICA_1_2 } = {}) {
  const { hoje, produtos, vendas, compras, snapshots } = entradas;
  const cfg = politica13;
  const fatosVenda = vendas.flatMap(fatosDeVenda), fatosCompra = compras.flatMap(fatosDeCompra);
  const r12 = calcularTudo({ produtos, fatosVenda, fatosCompra, hoje, politica: politica12 });
  const m12 = new Map(r12.metricas.map(m => [m.product_id, m]));
  const series = K.montarSeries({ produtos, fatosVenda, comprasBrutas: compras, snapshots, inicio: somarDias(hoje, -DIAS_DE_SERIE), hoje });
  const t = series.n - 1;
  const fatos = new Map(produtos.map(p => [p.product_id, K.caracteristicas(series.porId.get(p.product_id), series, t, cfg)]));
  const abc = K.classificar(produtos.map(p => { const f = fatos.get(p.product_id); return { id: p.product_id, receita: f.anual.valor, margem: f.anual.margem, volume: f.anual.u }; }), cfg);
  const prazos = K.estimarPrazos(compras, hoje, cfg);
  const transito = K.emTransito(compras, hoje, cfg);

  const linhas = produtos.map(p => {
    const id = p.product_id, f = fatos.get(id), m = m12.get(id), classe = abc.get(id).classe;
    const previsao = K.prever(f, cfg), variab = K.variabilidade(f, cfg), prazo = K.prazoDoProduto(id, prazos, cfg);
    const tr = transito.get(id) || { un: 0, residuo_antigo_un: 0 };
    const custo = p.registered_cost_cents > 0 ? p.registered_cost_cents : null;
    const estoque = p.current_stock;
    const semEstoque = f.curta.dias ? (f.curta.dias - f.curta.disp) / f.curta.dias : 0;
    const revisar = !m.purchase_eligible && m.purchase_exclusions.length === 1 && m.purchase_exclusions[0] === 'INSUFFICIENT_RECENT_DEMAND'
      && semEstoque >= cfg.ruptura_cronica.fracao_dias_sem_estoque && f.longa.u >= cfg.ruptura_cronica.min_unidades_longa;
    const estado = !(m.purchase_eligible || revisar) || estoque === null ? 'FORA_DA_REPOSICAO' : revisar ? 'REVISAR_RUPTURA_LONGA' : 'ELEGIVEL';
    let d = null;
    if (estado !== 'FORA_DA_REPOSICAO') {
      const novo = m.new_product && m.new_product_proven_demand && m.new_product_proven_demand.accepted;
      d = K.decidir({ id, f, previsao, variab, classe, prazo, estoque, transito: tr.un, cfg, velocidadeFixa: novo ? m.policy_velocity : null });
    }
    const perdida = estado === 'FORA_DA_REPOSICAO' ? null : K.vendaPerdida(f, previsao, custo);
    const q12 = m.suggestion.suggested_qty;
    const flags = d ? [...d.flags] : [];
    if (tr.residuo_antigo_un > 0) flags.push('COMPRA_PENDENTE_ANTIGA_IGNORADA');
    if (custo === null) flags.push('SEM_CUSTO');
    if (custo !== null && f.preco_cents !== null && f.preco_cents <= custo) flags.push('MARGEM_NAO_POSITIVA');
    const premissas = [];
    if (d) {
      premissas.push(d.prazo_fonte.startsWith('PREMISSA') ? 'PRAZO_PREMISSA' : d.prazo_fonte.startsWith('PROXY') ? 'PRAZO_APROXIMADO' : 'PRAZO_CADASTRADO');
      if (d.embalagem.fonte_multiplo === 'PREMISSA_SEM_CADASTRO') premissas.push('EMBALAGEM_SEM_CADASTRO');
      if (previsao.fonte !== 'OBSERVADA') premissas.push('DEMANDA_CORRIGIDA_ESTIMATIVA');
    }
    const excessoUn = estoque > 0 ? Math.max(0, estoque - previsao.v * cfg.excesso_dias) : 0;
    return { product_id: id, codigo: p.code || null, estado, exclusoes: m.purchase_exclusions, abc: abc.get(id), classe, xyz: variab.xyz, estoque, custo_cents: custo,
      preco_cents: f.preco_cents === null ? null : Math.round(f.preco_cents), em_transito: tr.un, unidades_90d: f.curta.u, dias_sem_estoque_90d: previsao.dias_sem_estoque,
      excesso_un: excessoUn, excesso_cents: Math.round(excessoUn * (custo || 0)), previsao, variab, prazo, decisao: d, perdida, premissas, flags,
      v12: { classe: m.abc_revenue, velocidade: m.policy_velocity, qtd: q12, prioridade: m.suggestion.priority },
      v13: { qtd: 0, qtd_sugerida: 0, qtd_revisao: 0 } };
  });
  // capital de giro: teto opcional distribuído por prioridade
  const comCompra = linhas.filter(l => l.estado === 'ELEGIVEL' && l.decisao.qtd_sugerida > 0);
  const aloc = K.alocarCapital(comCompra.map(l => ({ id: l.product_id, classe: l.classe, custo_cents: l.custo_cents || 0, margem_unit_cents: l.preco_cents !== null && l.custo_cents !== null ? l.preco_cents - l.custo_cents : 0,
    velocidade: l.decisao.velocidade, qtd_sugerida: l.decisao.qtd_sugerida, qtd_protecao: l.decisao.qtd_protecao, ponto_reposicao: l.decisao.ponto_reposicao, posicao: l.decisao.posicao, embalagem: l.decisao.embalagem })), cfg.capital.teto_compra_cents, cfg);
  for (const l of linhas) {
    const d = l.decisao;
    if (d && l.estado === 'ELEGIVEL') {
      l.v13.qtd_sugerida = d.qtd_sugerida;
      if (d.qtd_sugerida > 0) { d.qtd_final = aloc.alocado.get(l.product_id); if (d.qtd_final < d.qtd_sugerida) { d.limitada_por = 'CAPITAL'; l.flags.push('LIMITADO_PELO_CAPITAL'); } }
      l.v13.qtd = d.qtd_final;
    } else if (d) { l.v13.qtd_revisao = d.qtd_sugerida; d.qtd_final = 0; }
    l.v12.valor_cents = l.v12.qtd * (l.custo_cents || 0);
    l.v13.valor_cents = l.v13.qtd * (l.custo_cents || 0);
    l.delta_qtd = l.v13.qtd - l.v12.qtd;
    l.delta_valor_cents = l.v13.valor_cents - l.v12.valor_cents;
    l.justificativa = d ? K.justificar({ d: { ...d, pedir: d.pedir && l.estado === 'ELEGIVEL' }, abc: l.abc, previsao: l.previsao, variab: l.variab, f: fatos.get(l.product_id), perdida: l.perdida }) : [];
    if (l.estado === 'REVISAR_RUPTURA_LONGA') l.justificativa.unshift(`REVISÃO MANUAL: sem venda recente por ruptura longa; confirmar se o item continua em linha. Referência calculada: ${l.v13.qtd_revisao} un.`);
  }
  const confere = linhas.filter(l => entradas.sugestaoGravada12 && entradas.sugestaoGravada12.has(l.product_id));
  return { hoje, gerado_em_dados: entradas.geradoEm || null, policy_version: cfg.policy_version, baseline_version: politica12.policy_version, politica: cfg, linhas,
    resumo: resumir(linhas, { cfg, prazos, aloc, conferidos: confere.length, divergentes: confere.filter(l => entradas.sugestaoGravada12.get(l.product_id) !== l.v12.qtd).length }) };
}

function resumir(linhas, { cfg, prazos, aloc, conferidos, divergentes }) {
  const perdidaDe = ls => ({ rotulo: 'ESTIMATIVA', janela_dias: cfg.demanda.janela_dias, unidades: Math.round(soma(ls, l => l.perdida && l.perdida.unidades)), receita_cents: soma(ls, l => l.perdida && l.perdida.receita_cents), margem_cents: soma(ls, l => l.perdida && l.perdida.margem_cents) });
  const bloco = ls => {
    const q12 = ls.filter(l => l.v12.qtd > 0), q13 = ls.filter(l => l.v13.qtd > 0), eleg = ls.filter(l => l.estado === 'ELEGIVEL');
    return { produtos: ls.length, elegiveis: eleg.length, revisao_manual: ls.filter(l => l.estado === 'REVISAR_RUPTURA_LONGA').length,
      revisao_manual_valor_cents: soma(ls.filter(l => l.estado === 'REVISAR_RUPTURA_LONGA'), l => l.v13.qtd_revisao * (l.custo_cents || 0)),
      sugestoes_12: q12.length, unidades_12: soma(q12, l => l.v12.qtd), valor_12_cents: soma(q12, l => l.v12.valor_cents), mediana_12: mediana(q12.map(l => l.v12.qtd)),
      sugestoes_13: q13.length, unidades_13: soma(q13, l => l.v13.qtd), valor_13_cents: soma(q13, l => l.v13.valor_cents), mediana_13: mediana(q13.map(l => l.v13.qtd)),
      protecao_13_cents: soma(eleg, l => Math.min(l.decisao.qtd_final, l.decisao.qtd_protecao) * (l.custo_cents || 0)),
      abaixo_do_ponto_de_reposicao: eleg.filter(l => l.decisao.pedir).length,
      zerados_com_demanda: eleg.filter(l => l.estoque <= 0).length,
      mais_que_12: ls.filter(l => l.delta_qtd > 0).length, menos_que_12: ls.filter(l => l.delta_qtd < 0).length,
      estoque_atual_cents: soma(ls, l => Math.max(0, l.estoque) * (l.custo_cents || 0)), excesso_cents: soma(ls, l => l.excesso_cents),
      seguranca_investimento_cents: Math.round(soma(eleg, l => l.decisao.seguranca * (l.custo_cents || 0))),
      estoque_medio_alvo_cents: Math.round(soma(eleg, l => (l.decisao.seguranca + l.decisao.ciclo_un / 2) * (l.custo_cents || 0))),
      // itens em revisão podem estar fora de linha: a venda perdida deles fica separada, para não inflar o total
      venda_perdida_estimada: perdidaDe(eleg), venda_perdida_estimada_itens_em_revisao: perdidaDe(ls.filter(l => l.estado === 'REVISAR_RUPTURA_LONGA')) };
  };
  const contar = (ls, f) => ls.reduce((m, x) => { for (const k of [].concat(f(x))) if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const comDecisao = linhas.filter(l => l.decisao);
  return {
    total: bloco(linhas), por_classe: Object.fromEntries(['A', 'B', 'C'].map(c => [c, bloco(linhas.filter(l => l.classe === c))])),
    matriz_abc_xyz: contar(linhas.filter(l => l.estado === 'ELEGIVEL'), l => l.classe + l.xyz),
    prazo: { geral_proxy: prazos.geral, fornecedores_com_amostra: [...prazos.fornecedor.values()].filter(x => x.n >= cfg.prazo.min_amostras_fornecedor).length, fontes: contar(comDecisao, l => l.decisao.prazo_fonte) },
    premissas: contar(comDecisao, l => l.premissas), alertas: contar(linhas, l => l.flags),
    capital: { teto_compra_cents: aloc.teto_cents, usado_cents: aloc.usado_cents },
    conferencia_12: { produtos_conferidos: conferidos, divergentes },
  };
}

// ── Saídas ──────────────────────────────────────────────────────────────────────────────────────────────────────
const COLUNAS_CSV = ['product_id', 'codigo', 'estado', 'classe_13', 'abc_faturamento', 'abc_margem', 'abc_volume', 'xyz', 'estoque', 'em_transito', 'unidades_90d', 'dias_sem_estoque_90d',
  'venda_dia_12', 'venda_dia_13', 'prazo_dias', 'prazo_fonte', 'seguranca_un', 'ponto_reposicao_un', 'estoque_alvo_un', 'qtd_12', 'qtd_13', 'qtd_revisao_manual', 'diferenca_un',
  'custo_unit_reais', 'valor_12_reais', 'valor_13_reais', 'excesso_un', 'excesso_reais', 'venda_perdida_estimada_un', 'alertas', 'justificativa'];
function linhaCsv(l) {
  const d = l.decisao, n = (x, c = 2) => (x === null || x === undefined ? '' : String(Math.round(x * 10 ** c) / 10 ** c).replace('.', ','));
  const v = [l.product_id, l.codigo, l.estado, l.classe, l.abc.receita, l.abc.margem, l.abc.volume, l.xyz, l.estoque, l.em_transito, n(l.unidades_90d), l.dias_sem_estoque_90d,
    n(l.v12.velocidade, 3), d ? n(d.velocidade, 3) : '', d ? n(d.prazo_dias, 0) : '', d ? d.prazo_fonte : '', d ? n(d.seguranca, 1) : '', d ? n(d.ponto_reposicao, 1) : '', d ? n(d.estoque_alvo, 1) : '',
    l.v12.qtd, l.v13.qtd, l.v13.qtd_revisao, l.delta_qtd, l.custo_cents === null ? '' : n(l.custo_cents / 100), n(l.v12.valor_cents / 100), n(l.v13.valor_cents / 100), n(l.excesso_un, 1), n(l.excesso_cents / 100),
    l.perdida ? n(l.perdida.unidades, 1) : '', l.flags.join('|'), l.justificativa.join(' ')];
  return v.map(x => { const s = x === null || x === undefined ? '' : String(x); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';');
}
/** CSV (separador ";", decimal ",") só com IDs e códigos de produto — nenhum nome de produto, cliente ou fornecedor. */
function gerarCsv(linhas) {
  const ordem = { A: 0, B: 1, C: 2 };
  const sel = linhas.filter(l => l.estado !== 'FORA_DA_REPOSICAO' || l.v12.qtd > 0 || l.excesso_cents > 0)
    .sort((a, b) => ordem[a.classe] - ordem[b.classe] || Math.abs(b.delta_valor_cents) - Math.abs(a.delta_valor_cents) || a.product_id.localeCompare(b.product_id));
  return [COLUNAS_CSV.join(';'), ...sel.map(linhaCsv)].join('\n') + '\n';
}

/** Documentos da sombra (sem nomes e sem IDs de fornecedor). */
function documentosSombra(res, agora = new Date()) {
  const compacta = l => ({ id: l.product_id, codigo: l.codigo, estado: l.estado, classe: l.classe, abc: l.abc, xyz: l.xyz, estoque: l.estoque, transito: l.em_transito,
    q12: l.v12.qtd, q13: l.v13.qtd, q13_revisao: l.v13.qtd_revisao, delta: l.delta_qtd, valor12_cents: l.v12.valor_cents, valor13_cents: l.v13.valor_cents,
    ...(l.decisao ? { v: K.r3(l.decisao.velocidade), prazo: l.decisao.prazo_dias, prazo_fonte: l.decisao.prazo_fonte, ss: K.r2(l.decisao.seguranca), rop: K.r2(l.decisao.ponto_reposicao), alvo: K.r2(l.decisao.estoque_alvo) } : {}),
    perdida_un: l.perdida ? K.r2(l.perdida.unidades) : null, premissas: l.premissas, alertas: l.flags, justificativa: l.justificativa });
  const relevantes = res.linhas.filter(l => l.estado !== 'FORA_DA_REPOSICAO' || l.v12.qtd > 0);
  const base = { policy_version: res.policy_version, baseline_version: res.baseline_version, data_comercial: res.hoje, gerado_em: agora.toISOString() };
  const blocos = [];
  for (let i = 0; i < relevantes.length; i += BLOCO) blocos.push(['bloco_' + String(i / BLOCO).padStart(3, '0'), { ...base, indice: i / BLOCO, n: relevantes.slice(i, i + BLOCO).length, linhas_json: JSON.stringify(relevantes.slice(i, i + BLOCO).map(compacta)) }]);
  // configurações por produto/fornecedor entram só como contagem (sem IDs de fornecedor)
  const politica = { ...res.politica, prazo: { ...res.politica.prazo, fornecedores: Object.keys(res.politica.prazo.fornecedores).length }, embalagem: { ...res.politica.embalagem, fornecedores: Object.keys(res.politica.embalagem.fornecedores).length }, produtos: Object.keys(res.politica.produtos).length,
    fator_demanda: { ...res.politica.fator_demanda, por_produto: Object.keys(res.politica.fator_demanda.por_produto).length } };
  return [...blocos,
    ['resumo', { ...base, resumo: res.resumo }],
    ['dia_' + res.hoje, { ...base, formato: '{id:[q12,q13,q13_revisao]}', qtd_json: JSON.stringify(Object.fromEntries(relevantes.map(l => [l.product_id, [l.v12.qtd, l.v13.qtd, l.v13.qtd_revisao]]))) }],
    ['meta', { ...base, status: 'SOMBRA_NAO_APROVADA', dados_gerados_em: res.gerado_em_dados, blocos: blocos.length, politica }]];
}

/** Grava SOMENTE em compras_sombra_13. Valida todos os documentos antes da primeira escrita. */
async function persistirSombra(db, res, { agora = new Date() } = {}) {
  const docs = documentosSombra(res, agora);
  for (const [id, v] of docs) {
    if (!RE_DOC.test(id)) throw new Error('DOC_FORA_DA_SOMBRA ' + id);
    const problemas = Compat.problemasFirestore(v, { maxBytes: DOC_BYTES_MAX });
    if (problemas.length) throw new Error('DOC_INCOMPATIVEL ' + id + ': ' + problemas.slice(0, 3).join('; '));
  }
  const col = db.collection(COLECAO), lote = db.batch();
  for (const [id, v] of docs) lote.set(col.doc(id), v);
  const nBlocos = docs.filter(([id]) => id.startsWith('bloco_')).length;
  const anterior = (await col.doc('meta').get()).data();
  for (let i = nBlocos; anterior && i < anterior.blocos; i++) lote.delete(col.doc('bloco_' + String(i).padStart(3, '0')));
  await lote.commit();
  return { colecao: COLECAO, documentos: docs.length };
}

module.exports = { COLECAO, RE_DOC, DIAS_DE_SERIE, lerEntradas, montarEntradas, calcularSombra, resumir, COLUNAS_CSV, gerarCsv, documentosSombra, persistirSombra };
