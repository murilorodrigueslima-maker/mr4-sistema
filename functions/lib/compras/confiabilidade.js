'use strict';
// COMPRAS — confiabilidade dos dados. FUNÇÕES PURAS (sem I/O, sem relógio, sem escrita).
//
// Três assuntos, nenhum deles altera a política de compras (elegibilidade, quantidade e prioridade saem do motor):
//   1) compra "A receber"/"Em aberto" antiga → PRECISA DE CONFIRMAÇÃO (regra de idade e situação);
//   2) indícios (nunca presunção) de que as unidades de uma compra pendente entraram ou não no saldo;
//   3) origem da compra: há prova de que pertence à loja ativa? /compras não tem filtro nem campo de loja.
const { situacaoCompra, parseData, diffDias, somarDias, centavos, contaComoDemanda } = require('./canonico');
const { vincularCompra } = require('../financeiro/motor');

const REGRA_PENDENTE = Object.freeze({ versao: 'pend-1', idade_max_dias: 90, max_compras_tela: 50, max_itens_tela: 40 });
const EPS = 1e-9;
const r3 = x => Math.round(x * 1000) / 1000;
const itensDe = c => ((c && c.produtos) || []).map(p => p.produto || p);
const semWrapper = w => (w && w.Compra) || w;
/** Itens com produto e quantidade válidos, somados por produto (a mesma compra pode repetir o produto). */
function unidadesPorProduto(c) {
  const m = new Map();
  for (const it of itensDe(c)) {
    const id = it.produto_id != null ? String(it.produto_id) : '', q = Number(it.quantidade);
    if (id && q > 0) m.set(id, r3((m.get(id) || 0) + q));
  }
  return m;
}
/** Unidades da compra INCLUINDO itens sem produto (o ERP permite linha sem produto_id). */
const unidadesTotais = c => r3(itensDe(c).reduce((s, it) => s + Math.max(0, Number(it.quantidade) || 0), 0));
/** Valor da compra: produtos + frete + impostos − desconto (cabeçalho); sem valor de produtos → soma dos itens. */
function valorCompraCents(c) {
  let vp = centavos(c.valor_produtos);
  if (vp === null) vp = itensDe(c).reduce((s, it) => s + Math.round((Number(it.quantidade) || 0) * (centavos(it.valor_custo) || 0)), 0);
  return vp + (centavos(c.valor_frete) || 0) + (centavos(c.valor_impostos) || 0) - (centavos(c.desconto_valor) || 0);
}

// ── 1) Regra de confirmação ─────────────────────────────────────────────────────────────────────────────────────
/** Todas as compras pendentes; `precisa_confirmacao` = idade > limite, ou sem data de emissão legível. */
function listarPendentes(compras, hoje, regra = REGRA_PENDENTE) {
  return (compras || []).map(semWrapper).filter(c => c && situacaoCompra(c.nome_situacao) === 'PENDENTE').map(c => {
    const emissao = parseData(c.data_emissao), idade = emissao ? diffDias(emissao, hoje) : null, un = unidadesPorProduto(c);
    return { id: String(c.id), data_emissao: emissao, idade_dias: idade, situacao: String(c.nome_situacao || ''), fornecedor_id: c.fornecedor_id ? String(c.fornecedor_id) : null,
      modificado_em: c.modificado_em || null, itens: [...un].map(([produto_id, quantidade]) => ({ produto_id, quantidade })), unidades: r3([...un.values()].reduce((s, q) => s + q, 0)),
      valor_cents: valorCompraCents(c), precisa_confirmacao: idade === null || idade > regra.idade_max_dias };
  }).sort((a, b) => String(a.data_emissao || '').localeCompare(String(b.data_emissao || '')) || a.id.localeCompare(b.id));
}

/**
 * Bloco SOMENTE LEITURA para a tela de Compras (sem custo, valor ou fornecedor). Sem compra a confirmar → null
 * (a visão publicada fica idêntica à anterior).
 */
function blocoPendencias(compras, hoje, produtosPorId = {}, regra = REGRA_PENDENTE) {
  const todas = listarPendentes(compras, hoje, regra), alvo = todas.filter(p => p.precisa_confirmacao);
  if (!alvo.length) return null;
  const porProduto = {};
  for (const p of alvo) for (const it of p.itens) {
    const x = porProduto[it.produto_id] || (porProduto[it.produto_id] = { compras: 0, unidades: 0, idade_max_dias: null });
    x.compras++; x.unidades = r3(x.unidades + it.quantidade);
    if (p.idade_dias !== null && (x.idade_max_dias === null || p.idade_dias > x.idade_max_dias)) x.idade_max_dias = p.idade_dias;
  }
  return {
    regra: regra.versao, idade_max_dias: regra.idade_max_dias, pendentes_total: todas.length, precisam_confirmacao: alvo.length,
    unidades: r3(alvo.reduce((s, p) => s + p.unidades, 0)), produtos: Object.keys(porProduto).length, lista_truncada: alvo.length > regra.max_compras_tela,
    compras: alvo.slice(0, regra.max_compras_tela).map(p => ({ id: p.id, data_emissao: p.data_emissao, idade_dias: p.idade_dias, situacao: p.situacao, unidades: p.unidades, itens_total: p.itens.length,
      itens: p.itens.slice(0, regra.max_itens_tela).map(it => { const d = produtosPorId[it.produto_id] || {}; return { codigo: d.code || null, nome: d.name || null, produto_id: it.produto_id, quantidade: it.quantidade }; }) })),
    por_produto: porProduto,
  };
}

// ── Movimentos por produto ──────────────────────────────────────────────────────────────────────────────────────
/** vendas que baixaram estoque (mesma regra do motor) e compras CONFIRMADAS, por produto. */
function indexarMovimentosProduto(vendas, compras) {
  const saidas = new Map(), entradas = new Map();
  const por = (m, id) => m.get(id) || m.set(id, []).get(id);
  for (const v of vendas || []) {
    const d = parseData(v.data);
    if (!d || !contaComoDemanda(v)) continue;
    for (const [id, q] of unidadesPorProduto(v)) por(saidas, id).push({ data: d, q, id: String(v.id) });
  }
  for (const w of compras || []) {
    const c = semWrapper(w);
    if (situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const emissao = parseData(c.data_emissao), mod = parseData(c.modificado_em);
    for (const [id, q] of unidadesPorProduto(c)) por(entradas, id).push({ data: emissao, mod, q, id: String(c.id), fornecedor_id: c.fornecedor_id ? String(c.fornecedor_id) : null });
  }
  return { saidas, entradas };
}
const soma = (l, f = () => true) => r3((l || []).filter(f).reduce((s, x) => s + x.q, 0));

/** Δsaldo + vendas do dia entre dois snapshots de dias CONSECUTIVOS = entrada líquida observada no saldo. Map dia → Map produto → un. */
function entradasObservadas(snapshots, saidas) {
  const dias = Object.keys(snapshots || {}).sort(), out = new Map();
  const vend = new Map();
  for (const [id, l] of saidas) for (const x of l) vend.set(id + '|' + x.data, (vend.get(id + '|' + x.data) || 0) + x.q);
  for (let i = 1; i < dias.length; i++) {
    const a = dias[i - 1], d = dias[i];
    if (somarDias(a, 1) !== d) continue;
    const m = new Map();
    for (const [id, s] of Object.entries(snapshots[d].saldos || {})) {
      const s0 = (snapshots[a].saldos || {})[id];
      if (typeof s !== 'number' || typeof s0 !== 'number') continue;
      m.set(id, r3(s - s0 + (vend.get(id + '|' + d) || 0)));
    }
    out.set(d, m);
  }
  return out;
}

// ── 3a) Prova de origem pela ENTRADA no saldo da loja ───────────────────────────────────────────────────────────
const CRITERIO_ENTRADA = Object.freeze({ fracao_minima: 0.8, produtos_minimos: 2, quantidade_minima_produto_unico: 5, folga_dias_antes: 1, folga_dias_depois: 3 });
/**
 * Para cada compra CONFIRMADA emitida ou alterada dentro do período dos snapshots: existe UM dia em que a entrada observada no
 * saldo é exatamente a quantidade (da compra, ou da soma das compras do mesmo produto confirmadas naquele dia) para ≥ 80 % dos
 * produtos? Critério conservador: 2+ produtos, ou produto único com ≥ 5 unidades. `deslocarDias` existe só para o teste placebo.
 */
function provaPorEntradaNoSaldo({ compras, snapshots, movimentos, criterio = CRITERIO_ENTRADA, deslocarDias = 0 }) {
  const observadas = entradasObservadas(snapshots, movimentos.saidas), out = new Map();
  const dias = [...observadas.keys()].sort();
  if (!dias.length) return out;
  for (const w of compras || []) {
    const c = semWrapper(w);
    if (situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const un = unidadesPorProduto(c), emissao = parseData(c.data_emissao), mod = parseData(c.modificado_em) || emissao;
    if (!un.size || !emissao) continue;
    const ini = somarDias(somarDias(emissao, -criterio.folga_dias_antes), deslocarDias);
    const fim = somarDias(somarDias(mod > emissao ? mod : emissao, criterio.folga_dias_depois), deslocarDias);
    const janela = dias.filter(d => d >= ini && d <= fim);
    if (!janela.length) continue;
    let melhor = { dia: null, produtos_conferidos: 0, unidades_conferidas: 0 };
    for (const d of janela) {
      let n = 0, u = 0;
      for (const [id, q] of un) {
        const obs = observadas.get(d).get(id);
        if (obs === undefined || !(obs > 0)) continue;
        const doDia = soma(movimentos.entradas.get(id), x => x.mod === d || x.data === d);
        if (Math.abs(obs - q) < EPS || (doDia > q && Math.abs(obs - doDia) < EPS)) { n++; u += q; }
      }
      if (n > melhor.produtos_conferidos || (n === melhor.produtos_conferidos && u > melhor.unidades_conferidas)) melhor = { dia: d, produtos_conferidos: n, unidades_conferidas: r3(u) };
    }
    const fracao = melhor.produtos_conferidos / un.size;
    const suficiente = un.size === 1 ? melhor.unidades_conferidas >= criterio.quantidade_minima_produto_unico : melhor.produtos_conferidos >= criterio.produtos_minimos;
    out.set(String(c.id), { ...melhor, produtos: un.size, comprovada: fracao >= criterio.fracao_minima && suficiente });
  }
  return out;
}

// ── 2) Indícios sobre o recebimento de compra PENDENTE ──────────────────────────────────────────────────────────
const VEREDITOS = Object.freeze({
  DUPLICIDADE_PROVAVEL: 'há compra Confirmada do mesmo fornecedor com os mesmos itens e quantidades (±7 dias) e o saldo fecha sem a pendente; os valores podem diferir (registro repetido ou documento complementar)',
  ENTRADA_VISTA_NO_SALDO: 'um dia dos snapshots mostra entrada igual à quantidade pendente sem compra confirmada que a explique',
  SOBRA_COMPATIVEL_NAO_COMPROVA: 'o saldo tem sobra sobre (confirmadas − vendas) compatível com a quantidade; ajustes manuais também explicam',
  SEM_INDICIO_DE_ENTRADA: 'o saldo não mostra sobra compatível com a quantidade pendente',
});
const TOL_GEMEA_DIAS = 7, FRACAO_SOBRA = 0.5, FRACAO_ITENS = 0.6;
/**
 * Evidência por item e veredito por compra. NENHUM veredito afirma recebimento: a API não informa data de recebimento.
 *   residuo_vida   = saldo − (compras confirmadas − vendas) em todo o histórico: sobra de unidades sem compra confirmada
 *   saldo_implicito_na_emissao = saldo + vendas desde a emissão − confirmadas desde a emissão
 */
function indiciosRecebimento({ pendente, compras, movimentos, saldos, snapshots }) {
  const observadas = entradasObservadas(snapshots, movimentos.saidas);
  const brutas = (compras || []).map(semWrapper);
  const alvo = new Map(pendente.itens.map(i => [i.produto_id, i.quantidade]));
  const gemeas = brutas.filter(c => {
    if (String(c.id) === pendente.id || situacaoCompra(c.nome_situacao) !== 'CONFIRMADA' || String(c.fornecedor_id || '') !== String(pendente.fornecedor_id || '')) return false;
    const e = parseData(c.data_emissao);
    if (!e || !pendente.data_emissao || Math.abs(diffDias(pendente.data_emissao, e)) > TOL_GEMEA_DIAS) return false;
    const un = unidadesPorProduto(c);
    return [...alvo].every(([id, q]) => Math.abs((un.get(id) || 0) - q) < EPS);
  }).map(c => String(c.id));
  const itens = pendente.itens.map(({ produto_id: id, quantidade: q }) => {
    const sai = movimentos.saidas.get(id) || [], ent = movimentos.entradas.get(id) || [];
    const saldo = typeof saldos[id] === 'number' ? saldos[id] : null;
    const desde = x => x.data && x.data >= pendente.data_emissao;
    const vendidoDesde = soma(sai, desde), confirmadoDesde = soma(ent, desde);
    const entradaVista = [...observadas].filter(([d, m]) => d >= pendente.data_emissao && m.has(id) && Math.abs(m.get(id) - soma(ent, x => x.mod === d || x.data === d) - q) < EPS && q >= 5).map(([d]) => d);
    const posteriores = ent.filter(desde);
    return { produto_id: id, quantidade: q, saldo, vendido_desde: vendidoDesde, confirmado_desde: confirmadoDesde,
      compras_confirmadas_posteriores: posteriores.length, do_mesmo_fornecedor: posteriores.filter(x => x.fornecedor_id === pendente.fornecedor_id).length,
      primeira_confirmada_posterior: posteriores.map(x => x.data).sort()[0] || null,
      residuo_vida: saldo === null ? null : r3(saldo - (soma(ent) - soma(sai))),
      saldo_implicito_na_emissao: saldo === null ? null : r3(saldo + vendidoDesde - confirmadoDesde),
      dias_com_entrada_vista: entradaVista };
  });
  const comSobra = itens.filter(i => i.residuo_vida !== null && i.residuo_vida >= FRACAO_SOBRA * i.quantidade).length;
  const semSobraTodos = itens.every(i => i.residuo_vida !== null && i.residuo_vida < FRACAO_SOBRA * i.quantidade);
  let veredito = 'SEM_INDICIO_DE_ENTRADA';
  if (gemeas.length && semSobraTodos) veredito = 'DUPLICIDADE_PROVAVEL';
  else if (itens.length && itens.filter(i => i.dias_com_entrada_vista.length).length / itens.length >= FRACAO_ITENS) veredito = 'ENTRADA_VISTA_NO_SALDO';
  else if (itens.length && comSobra / itens.length >= FRACAO_ITENS) veredito = 'SOBRA_COMPATIVEL_NAO_COMPROVA';
  return { veredito, explicacao: VEREDITOS[veredito], compras_gemeas: gemeas, itens_com_sobra: comSobra, itens_total: itens.length, itens };
}

// ── 3b) Prova de origem por TÍTULO A PAGAR lido com loja_id ─────────────────────────────────────────────────────
/**
 * `titulos` = canônicos (financeiro/canonico.mapearTitulo) lidos de /pagamentos com loja_id da loja ativa.
 * `lojaDoTitulo(id)` → 'REGISTRO' (o título declara a loja ativa) | 'FILTRO' (só o filtro da consulta).
 * Vínculo determinístico já usado pelo Financeiro: "Compra de nº <código>" + código único + mesmo fornecedor.
 */
function vincularTitulosACompras(compras, titulos, lojaDoTitulo = () => 'FILTRO') {
  const porCodigo = {};
  for (const w of compras || []) { const c = semWrapper(w); if (c.codigo === undefined || c.codigo === null || c.codigo === '') continue; (porCodigo[String(c.codigo)] || (porCodigo[String(c.codigo)] = [])).push({ id: String(c.id), fornecedor_id: c.fornecedor_id ? String(c.fornecedor_id) : '' }); }
  const out = new Map(), estados = {};
  const de = id => out.get(id) || out.set(id, { titulos: 0, soma_cents: 0, pagos: 0, soma_paga_cents: 0, loja_no_registro: 0, conflitos: 0, vencimentos: [] }).get(id);
  for (const t of titulos || []) {
    const v = vincularCompra(t, porCodigo);
    estados[v.estado] = (estados[v.estado] || 0) + 1;
    if (v.estado === 'CONFIRMADO') {
      const x = de(v.compra_id); x.titulos++; x.soma_cents += t.final_amount_cents || 0;
      if (t.due_date) x.vencimentos.push(t.due_date);
      if (t.settled_flag === true) { x.pagos++; x.soma_paga_cents += t.final_amount_cents || 0; }
      if (lojaDoTitulo(t.source_id) === 'REGISTRO') x.loja_no_registro++;
    } else if (v.estado === 'CONFLITO_FORNECEDOR' || v.estado === 'CODIGO_DUPLICADO') for (const c of porCodigo[v.codigo] || []) de(c.id).conflitos++;
  }
  return { porCompra: out, estados };
}

/** Custo cadastrado na loja = custo com rateio da ÚLTIMA compra confirmada, valor que nenhuma outra compra do produto tem. */
function indicioPorCusto(fatosCompra, custoCadastradoPorProduto, tolerancia = 0.005) {
  const porProduto = new Map();
  for (const f of fatosCompra) if (f.status === 'CONFIRMADA' && f.product_id && f.landed_unit_cost_cents > 0 && f.issue_date) (porProduto.get(f.product_id) || porProduto.set(f.product_id, []).get(f.product_id)).push(f);
  const out = new Map();
  const perto = (a, b) => Math.abs(a - b) <= Math.max(1, Math.round(b * tolerancia));
  for (const [id, l] of porProduto) {
    l.sort((a, b) => b.issue_date.localeCompare(a.issue_date) || String(b.purchase_id).localeCompare(String(a.purchase_id)));
    const u = l[0], custo = custoCadastradoPorProduto[id];
    if (!(custo > 0) || !perto(custo, u.landed_unit_cost_cents)) continue;
    if (l.some(f => f.purchase_id !== u.purchase_id && perto(custo, f.landed_unit_cost_cents))) continue;   // valor repetido não distingue compra
    out.set(u.purchase_id, (out.get(u.purchase_id) || 0) + 1);
  }
  return out;
}

const NIVEIS = Object.freeze({
  COMPROVADA_TITULO: 'título a pagar da loja ativa referencia a compra (código e fornecedor conferem)',
  COMPROVADA_ENTRADA: 'as quantidades entraram no saldo da loja ativa (snapshots diários)',
  CONFLITO: 'referência ambígua ou fornecedor divergente: conferir manualmente',
  INDICIO_CUSTO: 'custo cadastrado na loja coincide com o desta compra (indício, não prova)',
  SEM_PROVA: 'nenhuma evidência disponível',
});
/**
 * Marca de origem por compra. `usar_em_decisao_automatica` = só com prova (título ou entrada). A marca não é lida pelo motor nem
 * muda a política vigente; a versão persistida (só por título) fica em origem.js e isola as recomendações novas.
 */
function classificarOrigem({ compras, vinculos = null, entradas = new Map(), custo = new Map() }) {
  return (compras || []).map(semWrapper).map(c => {
    const id = String(c.id), t = vinculos ? vinculos.get(id) : null, e = entradas.get(id);
    const porTitulo = !!(t && t.titulos > 0 && !t.conflitos), porEntrada = !!(e && e.comprovada);
    const nivel = porTitulo ? 'COMPROVADA_TITULO' : porEntrada ? 'COMPROVADA_ENTRADA' : (t && t.conflitos ? 'CONFLITO' : (custo.get(id) ? 'INDICIO_CUSTO' : 'SEM_PROVA'));
    return { id, data_emissao: parseData(c.data_emissao), situacao: c.nome_situacao || null, fornecedor_id: c.fornecedor_id ? String(c.fornecedor_id) : null,
      unidades: unidadesTotais(c), valor_cents: valorCompraCents(c), nivel,
      prova_titulo: porTitulo, prova_entrada: porEntrada, indicio_custo: !!custo.get(id), usar_em_decisao_automatica: porTitulo || porEntrada };
  });
}
function resumirOrigem(linhas) {
  const grupo = f => { const l = linhas.filter(f); return { compras: l.length, unidades: r3(l.reduce((s, x) => s + x.unidades, 0)), valor_cents: l.reduce((s, x) => s + x.valor_cents, 0) }; };
  return { total: grupo(() => true), comprovadas: grupo(x => x.usar_em_decisao_automatica), nao_comprovadas: grupo(x => !x.usar_em_decisao_automatica),
    por_nivel: Object.fromEntries(Object.keys(NIVEIS).map(n => [n, grupo(x => x.nivel === n)])), por_prova: { titulo: grupo(x => x.prova_titulo), entrada: grupo(x => x.prova_entrada), as_duas: grupo(x => x.prova_titulo && x.prova_entrada) } };
}

module.exports = { REGRA_PENDENTE, CRITERIO_ENTRADA, VEREDITOS, NIVEIS, unidadesPorProduto, valorCompraCents, listarPendentes, blocoPendencias, indexarMovimentosProduto, entradasObservadas, provaPorEntradaNoSaldo, indiciosRecebimento, vincularTitulosACompras, indicioPorCusto, classificarOrigem, resumirOrigem };
