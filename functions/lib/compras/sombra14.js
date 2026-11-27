'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.4 em SOMBRA: monta as ENTRADAS do simulador a partir das leituras já existentes
// de Compras e grava SOMENTE na coleção própria compras_sombra_14 (só gestão). Chamado pelo comando manual e pela callable
// planejamentoComprasAtualizar (simuladorBase.js); não tem agenda, não cria pedido e não altera nada de produção (a 1.2 e o sync
// não dependem deste arquivo). Loja: dados do sync de Compras (loja ativa 262759).
const { somarDias, diffDias, parseData, situacaoCompra, fatosDeVenda } = require('./canonico');
const K = require('./calculadora13');
const S13 = require('./sombra13');
const { POLITICA_1_3_SOMBRA } = require('./politica13');
const A = require('./alocacao14');
const Compat = require('./docCompat');

const COLECAO = 'compras_sombra_14';
const FORMATO = 2;                      // 2 = base do planejamento (regras 1.2/1.3 por produto, pedidos grandes, compras pendentes)
const LINHAS_JANELA_DIAS = 365;         // tamanho das linhas de venda (pedido grande)
const RE_DOC = /^(meta|bloco_\d{3})$/;
const BLOCO = 150;
const DOC_BYTES_MAX = 900 * 1024;

// Parâmetros da GERAÇÃO (o que o dono pode informar num arquivo --config). Vazio = não informado; nada é inventado.
const GERACAO = Object.freeze({
  // Compras sem prova de que são da loja ativa não decidem sozinhas. A lista vem de quem confere a origem (relatório de
  // confiabilidade das compras, coluna usar_em_decisao_automatica) — ver lerOrigemCsv e --origem no comando.
  // compras_com_origem: confirmadas pela gestão (coleção compras_origem), prevalecem sobre as demais listas
  origem: { compras_sem_origem: [], compras_com_origem: [], fornecedores_sem_origem: [], exigir_fornecedor: true },
  fornecedores: {},                  // { id: { minimo_cents, minimo_un } }
  marcas: {},                        // { produto: 'marca' } — o ERP lido pelo sistema não informa marca
  crescimento: { janela_dias: 90, min_dias_com_venda: 6, min_dias_disponiveis: 45, razao_minima: 1.2, inclinacao: 0.25, teto: 0.10 },
  multiplo_observado: { janela_dias: 720, min_compras: 3 },
  pedido_tipico: { janela_dias: 365, min_pedidos: 3, percentil: 0.10 },
});

const itensDe = c => (c.produtos || []).map(p => p.produto || p);
const mdc = (a, b) => (b ? mdc(b, a % b) : a);

/** IDs das compras que o relatório de origem manda NÃO usar em decisão automática (CSV ";" com compra_id e usar_em_decisao_automatica). */
function lerOrigemCsv(texto) {
  const linhas = String(texto).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const cab = (linhas.shift() || '').split(';'), id = cab.indexOf('compra_id'), usar = cab.indexOf('usar_em_decisao_automatica');
  if (id < 0 || usar < 0) throw new Error('ORIGEM_CSV_SEM_COLUNAS compra_id/usar_em_decisao_automatica');
  return linhas.map(l => l.split(';')).filter(c => c[usar] !== 'SIM').map(c => c[id]).filter(Boolean);
}

/** Compra com origem comprovada = com fornecedor identificado e fora das listas informadas como sem prova. */
function origemDaCompra(c, cfg) {
  const o = cfg.origem, forn = c.fornecedor_id ? String(c.fornecedor_id) : null;
  if ((o.compras_com_origem || []).includes(String(c.id))) return null;
  if (o.compras_sem_origem.includes(String(c.id))) return 'MARCADA_SEM_ORIGEM';
  if (!forn) return o.exigir_fornecedor ? 'SEM_FORNECEDOR' : null;
  if (o.fornecedores_sem_origem.includes(forn)) return 'FORNECEDOR_MARCADO';
  return null;
}
const ROTULO_ORIGEM = { MARCADA_SEM_ORIGEM: 'última compra sem prova de origem', SEM_FORNECEDOR: 'última compra sem fornecedor', FORNECEDOR_MARCADO: 'fornecedor informado como sem origem comprovada' };

/** Nome, código e categoria vêm das visões já gravadas pelo sync (o motor não os guarda nos blocos operacionais). */
function cadastro({ view, fornecedores }) {
  const porId = new Map();
  const juntar = (id, x) => { const a = porId.get(String(id)) || {}; porId.set(String(id), { nome: a.nome || x.nome || null, grupo: a.grupo || x.grupo || null }); };
  for (const l of (view && view.linhas) || []) juntar(l.id, l);
  const u = (fornecedores && fornecedores.unidades) || {};
  for (const g of [...(u.externos || []), ...(u.internos || []), u.sem_fornecedor, u.sem_vendas].filter(Boolean)) for (const p of g.produtos || []) juntar(p.id, p);
  const cache = (fornecedores && fornecedores.nomes && fornecedores.nomes.fornecedores) || {};
  return { produtos: porId, nomesForn: new Map(Object.entries(cache).filter(([, f]) => f && f.nome).map(([id, f]) => [id, f.nome])) };
}
/** Categoria de quem não aparece nas visões: o mesmo grupo (id) de um produto que aparece. */
function categoriasPorGrupo(produtos, cad) {
  const porGrupo = new Map();
  for (const p of produtos) { const c = cad.produtos.get(p.product_id); if (p.group_id && c && c.grupo && !porGrupo.has(p.group_id)) porGrupo.set(p.group_id, c.grupo); }
  return new Map(produtos.map(p => [p.product_id, (p.group_id && porGrupo.get(p.group_id)) || null]));
}

/**
 * Tamanho das linhas de venda por produto (soma do produto dentro da mesma venda) nos últimos 365 dias. É a venda OBSERVADA:
 * quando faltou estoque o cliente pode ter levado menos, então o tamanho "grande" real tende a ser igual ou maior.
 */
function linhasDeVenda(fatosVenda, hoje, janela = LINHAS_JANELA_DIAS) {
  const desde = somarDias(hoje, -janela), porVenda = new Map();
  fatosVenda.forEach((f, i) => {
    if (!f.counts_as_demand || !f.date || f.date <= desde || f.date > hoje || !(f.qty > 0) || !f.product_id) return;
    const k = f.product_id + '\u0000' + (f.sale_id === null ? 'sem-id-' + i : f.sale_id);
    porVenda.set(k, (porVenda.get(k) || 0) + f.qty);
  });
  const porId = new Map();
  for (const [k, q] of porVenda) { const id = k.slice(0, k.indexOf('\u0000')); (porId.get(id) || porId.set(id, []).get(id)).push(q); }
  return new Map([...porId].map(([id, a]) => [id, { n: a.length, p50: K.r2(K.quantil(a, 0.5)), p80: K.r2(K.quantil(a, 0.8)), p90: K.r2(K.quantil(a, 0.9)), p95: K.r2(K.quantil(a, 0.95)), max: K.r2(Math.max(...a)) }]));
}

/**
 * @param entradas  saída de sombra13.montarEntradas + { view, fornecedores, grupos? }
 * @returns { hoje, itens, fornecedores, resumo }
 */
function calcular(entradas, { config = {}, politica13 = POLITICA_1_3_SOMBRA } = {}) {
  const cfg = { ...GERACAO, ...config, origem: { ...GERACAO.origem, ...(config.origem || {}) }, crescimento: { ...GERACAO.crescimento, ...(config.crescimento || {}) } };
  const { hoje, produtos, vendas, compras, snapshots } = entradas;
  const base = S13.calcularSombra(entradas, { politica13 });
  const confirmadas = compras.filter(c => situacaoCompra(c.nome_situacao) === 'CONFIRMADA' && parseData(c.data_emissao) && parseData(c.data_emissao) <= hoje);
  const comOrigem = compras.filter(c => !origemDaCompra(c, cfg)), semOrigem = compras.filter(c => origemDaCompra(c, cfg));
  const prazos = K.estimarPrazos(comOrigem, hoje, politica13);                          // prazo e fornecedor só com origem comprovada
  const transito = K.emTransito(comOrigem, hoje, politica13), transitoSem = K.emTransito(semOrigem, hoje, politica13);
  const cad = cadastro(entradas), categoria = categoriasPorGrupo(produtos, cad);

  const ultima = new Map(), quantidades = new Map(), pedidos = new Map();
  for (const c of confirmadas) {
    const e = parseData(c.data_emissao);
    for (const it of itensDe(c)) {
      const id = String(it.produto_id), a = ultima.get(id);
      if (!a || e > a.data || (e === a.data && String(c.id).localeCompare(a.id) > 0)) ultima.set(id, { data: e, id: String(c.id), compra: c });
      const q = Number(it.quantidade);
      if (q > 0 && Number.isInteger(q) && diffDias(e, hoje) <= cfg.multiplo_observado.janela_dias) (quantidades.get(id) || quantidades.set(id, []).get(id)).push(q);
    }
    if (!origemDaCompra(c, cfg) && diffDias(e, hoje) <= cfg.pedido_tipico.janela_dias) {
      const valor = itensDe(c).reduce((s, it) => s + (Number(it.quantidade) || 0) * (Number(it.valor_custo) || 0) * 100, 0);
      const f = String(c.fornecedor_id);
      (pedidos.get(f) || pedidos.set(f, []).get(f)).push(Math.round(valor));
    }
  }

  const fatosVenda = vendas.flatMap(fatosDeVenda);
  const tamanhos = linhasDeVenda(fatosVenda, hoje);
  const series = K.montarSeries({ produtos, fatosVenda, comprasBrutas: compras, snapshots, inicio: somarDias(hoje, -S13.DIAS_DE_SERIE), hoje });
  const t = series.n - 1, G = cfg.crescimento;
  const crescimento = id => {
    const s = series.porId.get(id), a = K.caracteristicas(s, series, t, politica13), b = K.caracteristicas(s, series, t - G.janela_dias, politica13);
    if (b.obs === null || b.obs < G.janela_dias || a.curta.diasVenda < G.min_dias_com_venda || b.curta.diasVenda < G.min_dias_com_venda || a.curta.disp < G.min_dias_disponiveis || b.curta.disp < G.min_dias_disponiveis) return { fator: 1, razao: null };
    const va = K.prever(a, politica13).v, vb = K.prever(b, politica13).v, razao = vb > 0 ? va / vb : null;
    return { fator: razao !== null && razao >= G.razao_minima ? K.r3(1 + Math.min(G.teto, G.inclinacao * (razao - 1))) : 1, razao: razao === null ? null : K.r2(razao) };
  };

  const itens = base.linhas.filter(l => l.estado !== 'FORA_DA_REPOSICAO' && l.decisao).map(l => {
    const id = l.product_id, d = l.decisao, prazo = K.prazoDoProduto(id, prazos, politica13), novo = d.motivo_sem_seguranca === 'PRODUTO_NOVO';
    const u = ultima.get(id), motivo = u ? origemDaCompra(u.compra, cfg) : null;       // sem compra registrada: não há registro a desconfiar
    const emb = K.embalagemDe(id, prazo.fornecedor_id, politica13), qs = quantidades.get(id) || [];
    const tr = transito.get(id) || { un: 0, residuo_antigo_un: 0 }, trs = transitoSem.get(id) || { un: 0, residuo_antigo_un: 0 };
    const g = crescimento(id), c = cad.produtos.get(id) || {}, p = politica13.produtos[id] || {};
    return {
      id, codigo: l.codigo, nome: c.nome || null, categoria: c.grupo || categoria.get(id) || null, marca: cfg.marcas[id] || null,
      fornecedor_id: prazo.fornecedor_id, classe: l.classe, xyz: l.xyz, estado: l.estado,
      estoque: l.estoque, transito: { recente: tr.un, antigo: tr.residuo_antigo_un, recente_sem_origem: trs.un, antigo_sem_origem: trs.residuo_antigo_un },
      custo_cents: l.custo_cents, preco_cents: l.preco_cents,
      v: K.r3(d.velocidade), v_observada: novo ? K.r3(d.velocidade) : K.r3(l.previsao.v_observada), unidades_90d: l.unidades_90d, dias_sem_estoque_90d: l.dias_sem_estoque_90d,
      sd_dia: K.r3(l.variab.desvio_semanal_ajustado / Math.sqrt(7)), esporadico: l.variab.semanas_com_venda < politica13.seguranca.min_semanas_com_venda, novo,
      prazo_dias: prazo.dias, prazo_desvio: K.r2(prazo.desvio_dias), prazo_fonte: prazo.fonte, importado: !!(p.importado || (politica13.prazo.fornecedores[prazo.fornecedor_id] || {}).importado),
      minimo_un: emb.minimo_un, multiplo_un: emb.multiplo_un, multiplo_observado: qs.length >= cfg.multiplo_observado.min_compras ? qs.reduce(mdc) : 1,
      nao_comprar: !!p.nao_comprar, crescimento_fator: g.fator, crescimento_razao: g.razao,
      origem_comprovada: !motivo, origem_motivo: motivo ? ROTULO_ORIGEM[motivo] : null, ultima_compra_id: u ? u.id : null,
      linhas_venda: tamanhos.get(id) || null,
      // regras de comparação, calculadas pelos próprios motores: 1.2 (vigente) e 1.3 (sombra)
      r12: { q: l.v12.qtd, abc: l.v12.classe, v: K.r3(l.v12.velocidade) },
      r13: p.nao_comprar ? null : { v: d.velocidade, rop: d.ponto_reposicao, alvo: d.estoque_alvo },
    };
  });

  const fornecedores = {};
  for (const id of new Set(itens.map(i => i.fornecedor_id).filter(Boolean))) {
    const valores = (pedidos.get(id) || []).sort((a, b) => a - b), m = cfg.fornecedores[id] || {};
    fornecedores[id] = { nome: cad.nomesForn.get(id) || 'Fornecedor #' + id, minimo_cents: m.minimo_cents || null, minimo_un: m.minimo_un || null,
      pedidos_12m: valores.length, pedido_p10_cents: valores.length >= cfg.pedido_tipico.min_pedidos ? K.quantil(valores, cfg.pedido_tipico.percentil) : null };
  }

  const antigas = compras.filter(c => situacaoCompra(c.nome_situacao) === 'PENDENTE' && parseData(c.data_emissao) && diffDias(parseData(c.data_emissao), hoje) > politica13.transito.idade_max_dias);
  // compras pendentes, item a item, para a tela aplicar a confirmação (recebida, duplicada, cancelada) sem nova geração
  const noEscopo = new Set(itens.map(i => i.id));
  const pendentes = compras.filter(c => situacaoCompra(c.nome_situacao) === 'PENDENTE' && parseData(c.data_emissao) && parseData(c.data_emissao) <= hoje).map(c => ({
    id: String(c.id), data: parseData(c.data_emissao), antiga: diffDias(parseData(c.data_emissao), hoje) > politica13.transito.idade_max_dias, fornecedor_id: c.fornecedor_id ? String(c.fornecedor_id) : null, sem_origem: !!origemDaCompra(c, cfg),
    itens: itensDe(c).filter(it => Number(it.quantidade) > 0 && noEscopo.has(String(it.produto_id))).map(it => [String(it.produto_id), Number(it.quantidade)]),
  })).filter(c => c.itens.length);
  const resumo = {
    itens: itens.length, elegiveis: itens.filter(i => i.estado === 'ELEGIVEL').length, em_revisao_falta_longa: itens.filter(i => i.estado === 'REVISAR_RUPTURA_LONGA').length,
    sem_origem_comprovada: itens.filter(i => !i.origem_comprovada).length, sem_nome: itens.filter(i => !i.nome).length, sem_categoria: itens.filter(i => !i.categoria).length, com_marca: itens.filter(i => i.marca).length,
    compras_sem_origem: semOrigem.length, lista_de_origem_informada: cfg.origem.compras_sem_origem.length, compras_pendentes_antigas: antigas.length, compras_pendentes_antigas_un: antigas.reduce((s, c) => s + itensDe(c).reduce((a, i) => a + (Number(i.quantidade) || 0), 0), 0),
  };
  return { hoje, gerado_em_dados: entradas.geradoEm || null, itens, fornecedores, pendentes, resumo, base };
}

/** Documentos da sombra 1.4 (texto JSON por bloco; sem clientes, sem documentos fiscais). Leitura só gestão pelas Rules. */
function documentos(res, agora = new Date()) {
  const base = { policy_version: A.PARAMETROS.policy_version, data_comercial: res.hoje, gerado_em: agora.toISOString() };
  const blocos = [];
  for (let i = 0; i < res.itens.length; i += BLOCO) {
    const fatia = res.itens.slice(i, i + BLOCO);
    blocos.push(['bloco_' + String(i / BLOCO).padStart(3, '0'), { ...base, indice: i / BLOCO, n: fatia.length, itens_json: JSON.stringify(fatia) }]);
  }
  return [...blocos, ['meta', { ...base, formato: FORMATO, status: 'SOMBRA_NAO_APROVADA', dados_gerados_em: res.gerado_em_dados, blocos: blocos.length, itens: res.itens.length, fornecedores_json: JSON.stringify(res.fornecedores), pendentes_json: JSON.stringify(res.pendentes || []), resumo: res.resumo }]];
}

/** Grava SOMENTE em compras_sombra_14. Valida todos os documentos antes da primeira escrita. */
async function persistir(db, res, { agora = new Date() } = {}) {
  const docs = documentos(res, agora);
  for (const [id, v] of docs) {
    if (!RE_DOC.test(id)) throw new Error('DOC_FORA_DA_SOMBRA ' + id);
    const problemas = Compat.problemasFirestore(v, { maxBytes: DOC_BYTES_MAX });
    if (problemas.length) throw new Error('DOC_INCOMPATIVEL ' + id + ': ' + problemas.slice(0, 3).join('; '));
  }
  const col = db.collection(COLECAO), lote = db.batch();
  const anterior = (await col.doc('meta').get()).data();
  for (const [id, v] of docs) lote.set(col.doc(id), v);
  const n = docs.length - 1;
  for (let i = n; anterior && i < anterior.blocos; i++) lote.delete(col.doc('bloco_' + String(i).padStart(3, '0')));
  await lote.commit();
  return { colecao: COLECAO, documentos: docs.length };
}

/** Leitura (somente get): entradas da sombra 1.3 + os dois documentos que trazem nomes e categorias. */
async function lerEntradas(db, opcoes) {
  const entradas = await S13.lerEntradas(db, opcoes);
  const d = async (c, id) => (await db.collection(c).doc(id).get()).data() || null;
  return { ...entradas, view: await d('compras_n0_view', 'sugestoes'), fornecedores: { unidades: await d('compras_n0_fornecedores', 'unidades'), nomes: await d('compras_n0_fornecedores', 'nomes') } };
}

module.exports = { COLECAO, FORMATO, DIAS_DE_SERIE: S13.DIAS_DE_SERIE, RE_DOC, GERACAO, lerOrigemCsv, origemDaCompra, linhasDeVenda, cadastro, calcular, documentos, persistir, lerEntradas };
