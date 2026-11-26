#!/usr/bin/env node
'use strict';
// Relatório INTERNO de confiabilidade das compras — roda NA MÁQUINA LOCAL. Somente leitura (Firestore por ADC: só get).
//
//   node functions/scripts/relatorio_compras_confiabilidade.js --saida=<pasta> [--dados=<pasta de cache>] [--log=<log INVC_>]
//
// --dados: se a pasta tiver os JSON, não lê o Firestore; se não tiver, lê uma vez (≈110 documentos) e guarda ali (dados internos).
// --log:   saída do Job (scripts/investigar-compras.js). Sem ele, o que depende do GestãoClick fica marcado como PENDENTE.
// A saída contém nomes de fornecedores: documento INTERNO, não enviar a terceiros nem a revisão externa.
const fs = require('fs'), path = require('path');
const C = require('../lib/compras/confiabilidade');
const K = require('../lib/compras/canonico');
const S = require('../lib/compras/snapshot');
const { calcularTudo } = require('../lib/compras/motor');
const { POLITICA_VIGENTE } = require('../lib/compras/politica');

const ARQUIVOS = ['resumo', 'meta', 'base', 'produtos', 'custos', 'view_sug', 'nomes_forn', 'snapshots', 'fin_pagar'];
const PRODUTOS_VENDA = ['47142037', '47142039'];

// ── Coleta ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function coletar() {
  const { Firestore } = require('@google-cloud/firestore');
  const A = require('../lib/financeiro/agregados');
  const real = new Firestore({ projectId: 'mr4-ponto' });
  let leituras = 0;
  const db = { collection: c => ({ doc: id => ({ get: () => { leituras++; return real.collection(c).doc(id).get(); } }) }) };   // só leitura por id
  const ler = async (c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; };
  const d = {};
  d.resumo = await ler('compras_n0', 'resumo'); d.meta = await ler('compras_n0', 'meta');
  d.base = await S.carregarBase(db);
  d.produtos = []; d.custos = [];
  for (let i = 0; i < d.resumo.blocos; i++) {
    const id = 'bloco_' + String(i).padStart(3, '0');
    d.produtos.push(...(await ler('compras_n0_produtos', id)).produtos); d.custos.push(...(await ler('compras_n0_custos', id)).produtos);
  }
  d.view_sug = await ler('compras_n0_view', 'sugestoes'); d.nomes_forn = await ler('compras_n0_fornecedores', 'nomes');
  d.snapshots = {};
  for (let dia = '2026-09-29'; dia <= d.resumo.data_comercial; dia = K.somarDias(dia, 1)) { const x = await ler('estoque_snapshots', dia); if (x) d.snapshots[dia] = x; }
  d.fin_pagar = [];
  const ativo = await ler('fin_n1', 'active');
  if (ativo) {
    const r = await ler('fin_n1_resumo', A.idResumo(ativo.geracao));
    for (const [g, ix] of Object.entries(r.pagar.detalhe)) for (let i = 0; i < ix.fatias; i++) d.fin_pagar.push(...(await ler('fin_n1_titulos', A.idFatia(ativo.geracao, 'PAGAR', g, i))).itens.map(t => ({ ...t, grupo: g })));
  }
  console.error('leituras Firestore: ' + leituras);
  return d;
}
async function carregarDados(pasta) {
  if (pasta && ARQUIVOS.every(n => fs.existsSync(path.join(pasta, n + '.json')))) return Object.fromEntries(ARQUIVOS.map(n => [n, JSON.parse(fs.readFileSync(path.join(pasta, n + '.json'), 'utf8'))]));
  const d = await coletar();
  if (pasta) { fs.mkdirSync(pasta, { recursive: true }); for (const n of ARQUIVOS) fs.writeFileSync(path.join(pasta, n + '.json'), JSON.stringify(d[n]), { mode: 0o600 }); }
  return d;
}

// ── Log do Job ──────────────────────────────────────────────────────────────────────────────────────────────────
function lerLog(texto) {
  const l = {};
  for (const linha of String(texto).split('\n')) {
    const m = /^INVC_([A-Z_]+) (\{.*\})\s*$/.exec(linha);
    if (!m) continue;
    let j; try { j = JSON.parse(m[2]); } catch (_) { (l.ILEGIVEIS || (l.ILEGIVEIS = [])).push(m[1]); continue; }
    (l[m[1]] || (l[m[1]] = [])).push(j);
  }
  const partes = tag => { const p = l[tag] || []; if (!p.length) return null; const itens = [...p].sort((a, b) => a.parte - b.parte).flatMap(x => x.itens); return { itens, completo: p.length === p[0].de && itens.length === p[0].total }; };
  const um = tag => (l[tag] ? l[tag][l[tag].length - 1] : null);
  const origem = partes('ORIGEM'), titulos = um('TITULOS_RESUMO');
  return {
    inicio: um('INICIO'), fim: um('FIM'), orcamento: um('ORCAMENTO'), erros: l.ERRO || [], ilegiveis: l.ILEGIVEIS || [], compras: um('COMPRAS_RESUMO'), pendentes: new Map((l.PENDENTE || []).map(p => [p.id, p])),
    vendasResumo: um('VENDAS_RESUMO'), vendas: partes('VENDAS_PRODUTOS'), detalhes: l.VENDA_DETALHE || [], titulos,
    // vínculo só vale com a leitura de títulos completa e todas as partes presentes
    origem: origem && origem.completo && titulos && titulos.completo ? new Map(origem.itens.map(([id, codigo, forn, titulos_, soma, pagos, somaPaga, loja, conf]) => [id, { codigo, fornecedor_id: forn, titulos: titulos_, soma_cents: soma, pagos, soma_paga_cents: somaPaga, loja_no_registro: loja, conflitos: conf }])) : null,
    origemIncompleta: !!(origem || titulos) && !(origem && origem.completo && titulos && titulos.completo),
  };
}

// ── Simulação da política vigente ───────────────────────────────────────────────────────────────────────────────
function entradasMotor(d) {
  const custo = new Map(d.custos.map(k => [k.product_id, k]));
  const produtos = d.produtos.map(m => { const k = custo.get(m.product_id) || {}; return { product_id: m.product_id, code: m.code, active: m.active, moves_stock: m.moves_stock, has_composition: m.kit, current_stock: m.raw_stock,
    registered_cost_cents: k.registered_cost_cents ?? null, sale_price_cents: k.sale_price_cents ?? null, created_at: m.created_at_reliable ? m.first_evidence_date : null, created_at_reliable: !!m.created_at_reliable, erp_min_stock: null }; });
  return { produtos, fatosVenda: d.base.vendas.flatMap(K.fatosDeVenda), fatosCompra: d.base.compras.flatMap(K.fatosDeCompra), hoje: d.resumo.data_comercial };
}
function simular(e, { semCompras = new Set(), recebimento = 0, recebidas = new Set(), semVendas = new Set() } = {}, pendentes = []) {
  const extra = new Map();
  if (recebimento > 0) for (const p of pendentes) if (recebidas.has(p.id)) for (const it of p.itens) extra.set(it.produto_id, (extra.get(it.produto_id) || 0) + Math.floor(it.quantidade * recebimento));
  const r = calcularTudo({ politica: POLITICA_VIGENTE, hoje: e.hoje,
    produtos: e.produtos.map(p => (extra.has(p.product_id) && p.current_stock !== null ? { ...p, current_stock: p.current_stock + extra.get(p.product_id) } : p)),
    fatosVenda: semVendas.size ? e.fatosVenda.filter(f => !semVendas.has(f.sale_id)) : e.fatosVenda,
    fatosCompra: semCompras.size || recebidas.size ? e.fatosCompra.filter(f => !semCompras.has(f.purchase_id) && !recebidas.has(f.purchase_id)) : e.fatosCompra });
  return new Map(r.metricas.map(m => [m.product_id, m]));
}
function totaisSugestao(r, custos, ids = null) {
  let produtos = 0, unidades = 0, capital = 0, semCusto = 0; const prio = {};
  for (const [id, m] of r) {
    if (ids && !ids.has(id)) continue;
    const q = m.suggestion.suggested_qty;
    if (!(q > 0)) continue;
    produtos++; unidades += q; prio[m.suggestion.priority] = (prio[m.suggestion.priority] || 0) + 1;
    const c = custos.get(id); if (c > 0) capital += q * c; else semCusto++;
  }
  return { produtos, unidades, capital_cents: Math.round(capital), sem_custo: semCusto, prioridade: prio };
}

// ── Formatação ──────────────────────────────────────────────────────────────────────────────────────────────────
const num = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 }));
const brl = c => (c === null || c === undefined ? '—' : 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const br = d => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const md = v => String(v === null || v === undefined ? '—' : v).replace(/\|/g, '/').replace(/\s+/g, ' ');
const tabela = (cab, linhas) => [`| ${cab.join(' | ')} |`, `|${cab.map(() => '---').join('|')}|`, ...linhas.map(l => `| ${l.map(md).join(' | ')} |`)].join('\n');
function celula(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                     // planilha não interpreta como fórmula
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csv = (cab, linhas) => '﻿' + [cab, ...linhas].map(l => l.map(celula).join(';')).join('\n') + '\n';

// ── Relatório ───────────────────────────────────────────────────────────────────────────────────────────────────
function gerar(d, log = null) {
  const hoje = d.resumo.data_comercial, compras = d.base.compras;
  const porProd = new Map(d.produtos.map(p => [p.product_id, p]));
  const nomeProd = new Map(((d.view_sug && d.view_sug.linhas) || []).map(l => [l.id, l.nome]));
  const custos = new Map(d.custos.map(k => [k.product_id, k.registered_cost_cents]));
  const cod = id => (porProd.get(id) || {}).code || id;
  const nomes = (d.nomes_forn && d.nomes_forn.fornecedores) || {};
  const forn = id => (nomes[id] && nomes[id].nome) || (id ? 'fornecedor ' + id : '—');
  const mov = C.indexarMovimentosProduto(d.base.vendas, compras);
  const saldos = Object.fromEntries(d.produtos.map(p => [p.product_id, p.raw_stock]));
  const dias = Object.keys(d.snapshots).sort();

  const pendentes = C.listarPendentes(compras, hoje), antigas = pendentes.filter(p => p.precisa_confirmacao);
  const ind = new Map(pendentes.map(p => [p.id, C.indiciosRecebimento({ pendente: p, compras, movimentos: mov, saldos, snapshots: d.snapshots })]));
  const entrada = C.provaPorEntradaNoSaldo({ compras, snapshots: d.snapshots, movimentos: mov });
  const placebo = [-28, -21, -14, 14, 21, 28].map(s => { const r = [...C.provaPorEntradaNoSaldo({ compras, snapshots: d.snapshots, movimentos: mov, deslocarDias: s }).values()]; return [s, r.length, r.filter(x => x.comprovada).length]; });

  // taxa de fundo do indício "sobra": a mesma régua aplicada a compras CONFIRMADAS (que não têm nada a receber), sem produtos pendentes
  const idsPendentes = new Set(pendentes.flatMap(x => x.itens.map(i => i.produto_id)));
  const sobraDe = new Map(d.produtos.map(m => { const t = l => (l || []).reduce((s, y) => s + y.q, 0); return [m.product_id, typeof m.raw_stock === 'number' ? m.raw_stock - (t(mov.entradas.get(m.product_id)) - t(mov.saidas.get(m.product_id))) : null]; }));
  const fundo = { avaliadas: 0, compativeis: 0 };
  for (const c of compras) {
    if (K.situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const l = [...C.unidadesPorProduto(c)].filter(([i]) => !idsPendentes.has(i) && sobraDe.get(i) !== undefined && sobraDe.get(i) !== null);
    if (l.length < 5) continue;
    fundo.avaliadas++; if (l.filter(([i, q]) => sobraDe.get(i) >= 0.5 * q).length / l.length >= 0.6) fundo.compativeis++;
  }
  const repetidos = [...idsPendentes].filter(i => antigas.filter(x => x.itens.some(y => y.produto_id === i)).length > 1);

  // cenários
  const E = entradasMotor(d), idsAntigas = new Set(antigas.map(p => p.id)), idsProd = new Set(antigas.flatMap(p => p.itens.map(i => i.produto_id)));
  const atual = simular(E);
  const visao = new Map(((d.view_sug && d.view_sug.linhas) || []).map(l => [l.id, l.qtd]));
  const diverge = [...atual].filter(([id, m]) => (m.suggestion.suggested_qty || 0) !== (visao.get(id) || 0)).length;
  const cenarios = [['ATUAL (produção)', atual], ['IGNORAR pendentes antigas', simular(E, { semCompras: idsAntigas })],
    ['PARCIAL: 50 % de cada item entra no saldo', simular(E, { recebimento: 0.5, recebidas: idsAntigas }, antigas)], ['INTEGRAL: 100 % entra no saldo', simular(E, { recebimento: 1, recebidas: idsAntigas }, antigas)]];
  const porCompra = antigas.map(p => ({ p, r: simular(E, { recebimento: 1, recebidas: new Set([p.id]) }, antigas) }));
  const qtd = (r, id) => (r.get(id) ? r.get(id).suggestion.suggested_qty : 0);

  // origem
  const fatos = E.fatosCompra, custoInd = C.indicioPorCusto(fatos, Object.fromEntries(custos));
  const vinculos = log && log.origem ? log.origem : null;
  const origem = C.classificarOrigem({ compras, vinculos, entradas: entrada, custo: custoInd });
  const res = C.resumirOrigem(origem);
  const titulosRetidos = (d.fin_pagar || []).filter(t => t.lk && t.lk.t === 'COMPRA');
  const codRetidos = new Set(titulosRetidos.map(t => t.lk.cod));
  const noCatalogo = compras.filter(c => { const l = [...C.unidadesPorProduto(c).keys()]; return l.length && l.every(i => porProd.has(i)); }).length;
  const semCodigoProd = compras.filter(c => (c.produtos || []).some(i => !i.produto_id)).length;

  // vendas MR.090 / MR.091
  const alvo = new Set(PRODUTOS_VENDA);
  const desde = K.somarDias(hoje, -30);
  const vendasAlvo = d.base.vendas.filter(v => v.data >= desde && v.data <= hoje && (v.produtos || []).some(i => alvo.has(i.produto_id)))
    .map(v => { const u = C.unidadesPorProduto(v); const ids = v.produtos.map(i => i.produto_id).filter(Boolean);
      return { id: v.id, data: v.data, situacao: v.nome_situacao, baixou: String(v.situacao_estoque), modificado: v.modificado_em, itens: v.produtos.length, q90: u.get(PRODUTOS_VENDA[0]) || 0, q91: u.get(PRODUTOS_VENDA[1]) || 0, repetido: new Set(ids).size !== ids.length }; })
    .sort((a, b) => a.data.localeCompare(b.data) || a.id.localeCompare(b.id));
  const candidata = vendasAlvo.filter(v => v.itens === 2 && v.q90 === 30 && v.q91 === 20);
  const obs = C.entradasObservadas(d.snapshots, mov.saidas);
  const residuos = PRODUTOS_VENDA.map(id => ({ id, dias: [...obs].filter(([dia]) => dia >= desde).map(([dia, m]) => [dia, m.get(id) || 0, (mov.entradas.get(id) || []).filter(x => x.mod === dia).reduce((s, x) => s + x.q, 0)]).filter(([, o, e]) => Math.abs(o - e) > 1e-9) }));
  const semVenda = candidata.length === 1 ? simular(E, { semVendas: new Set([candidata[0].id]) }) : null;
  const noLog = log && log.vendas && log.vendas.completo ? new Set(log.vendas.itens.map(v => v.id)) : null;
  const periodoLog = log && log.vendasResumo ? log.vendasResumo.periodo : null;
  const soMr4 = noLog ? vendasAlvo.filter(v => periodoLog && v.data >= periodoLog.inicio && v.data <= periodoLog.fim && !noLog.has(v.id)) : null;
  const soGc = noLog ? log.vendas.itens.filter(v => v.data >= desde && !vendasAlvo.some(x => x.id === v.id)) : null;

  // ── CSVs ──
  const csvPend = csv(['compra_id', 'numero_pedido', 'data_emissao', 'idade_dias', 'situacao', 'fornecedor_id', 'fornecedor', 'modificado_em', 'valor_compra_reais', 'produto_id', 'codigo', 'qtd_pendente', 'custo_unit_reais', 'saldo_atual', 'vendido_desde_emissao', 'confirmado_desde_emissao', 'compras_confirmadas_posteriores', 'posteriores_mesmo_fornecedor', 'sobra_saldo_vs_historico', 'saldo_implicito_na_emissao', 'dias_com_entrada_no_saldo', 'veredito_da_compra', 'sugestao_atual', 'sugestao_se_50pct', 'sugestao_se_100pct'],
    antigas.flatMap(p => { const raw = compras.find(c => c.id === p.id), r = ind.get(p.id), n = vinculos && vinculos.get(p.id);
      return r.itens.map(i => [p.id, n ? n.codigo : 'PENDENTE_DA_EXECUCAO', p.data_emissao, p.idade_dias, p.situacao, p.fornecedor_id, forn(p.fornecedor_id), p.modificado_em, p.valor_cents / 100, i.produto_id, cod(i.produto_id), i.quantidade,
        (raw.produtos.find(x => x.produto_id === i.produto_id) || {}).valor_custo ? Number(raw.produtos.find(x => x.produto_id === i.produto_id).valor_custo) : null, i.saldo, i.vendido_desde, i.confirmado_desde, i.compras_confirmadas_posteriores, i.do_mesmo_fornecedor, i.residuo_vida, i.saldo_implicito_na_emissao, i.dias_com_entrada_vista.join(' '), r.veredito,
        qtd(atual, i.produto_id), qtd(cenarios[2][1], i.produto_id), qtd(cenarios[3][1], i.produto_id)]); }));
  const csvCen = csv(['produto_id', 'codigo', 'nome', 'unidades_pendentes', 'saldo_atual', 'cobertura_dias', 'sug_atual', 'sug_ignorar', 'sug_parcial_50', 'sug_integral', 'prioridade_atual', 'prioridade_integral', 'custo_cadastrado_reais'],
    [...idsProd].map(id => { const m = atual.get(id) || {}; const un = antigas.reduce((s, p) => s + p.itens.filter(i => i.produto_id === id).reduce((t, i) => t + i.quantidade, 0), 0);
      return [id, cod(id), nomeProd.get(id) || '', un, saldos[id], m.coverage ? m.coverage.dias : null, ...cenarios.map(c => qtd(c[1], id)), (m.suggestion || {}).priority || '', (cenarios[3][1].get(id) || { suggestion: {} }).suggestion.priority || '', custos.get(id) > 0 ? custos.get(id) / 100 : null]; }));
  const csvOri = csv(['compra_id', 'numero_pedido', 'data_emissao', 'situacao', 'fornecedor_id', 'fornecedor', 'unidades', 'valor_reais', 'nivel_de_origem', 'usar_em_decisao_automatica', 'prova_titulo', 'prova_entrada', 'dia_da_entrada', 'indicio_custo', 'titulos_vinculados', 'soma_titulos_reais', 'titulos_pagos'],
    origem.map(o => { const t = vinculos && vinculos.get(o.id), e = entrada.get(o.id);
      return [o.id, t ? t.codigo : '', o.data_emissao, o.situacao, o.fornecedor_id, forn(o.fornecedor_id), o.unidades, o.valor_cents / 100, o.nivel, o.usar_em_decisao_automatica ? 'SIM' : (vinculos ? 'NAO' : 'NAO (provisorio)'), o.prova_titulo ? 'SIM' : (vinculos ? 'NAO' : 'PENDENTE'), o.prova_entrada ? 'SIM' : (e ? 'NAO' : 'SEM_JANELA'), e && e.comprovada ? e.dia : '', o.indicio_custo ? 'SIM' : 'NAO', t ? t.titulos : null, t ? t.soma_cents / 100 : null, t ? t.pagos : null]; }));
  const csvVen = csv(['venda_id', 'data', 'situacao', 'baixou_estoque', 'modificado_em', 'itens_na_venda', 'qtd_MR090', 'qtd_MR091', 'produto_repetido_na_venda', 'presente_no_GC'],
    vendasAlvo.map(v => [v.id, v.data, v.situacao, v.baixou, v.modificado, v.itens, v.q90, v.q91, v.repetido ? 'SIM' : 'NAO', noLog ? (noLog.has(v.id) ? 'SIM' : (periodoLog && v.data >= periodoLog.inicio ? 'NAO' : 'FORA_DA_JANELA')) : 'PENDENTE_DA_EXECUCAO']));

  // ── Documento ──
  const L = [];
  const p = (...x) => L.push(...x, '');
  p('# EXEC2 04 — Compras: confiabilidade dos dados');
  p('**DOCUMENTO INTERNO** (contém nomes de fornecedores e valores). Não enviar ao Codex nem a terceiros.');
  p(`Gerado por \`functions/scripts/relatorio_compras_confiabilidade.js\` · MR4 Gestão, snapshot de ${br(hoje)} (${d.resumo.gerado_em}) · loja 262759 · ${log ? 'COM o log da investigação no GestãoClick (' + ((log.inicio || {}).instante || '?') + ', ok=' + ((log.fim || {}).ok) + ')' : '**SEM execução da investigação no GestãoClick: itens marcados PENDENTE**'}.`);
  if (log && (log.erros.length || log.ilegiveis.length || log.origemIncompleta)) p(`> Atenção: seções com erro: ${JSON.stringify(log.erros)}; linhas ilegíveis: ${log.ilegiveis.length}; títulos incompletos: ${log.origemIncompleta} (nesse caso a prova por título NÃO foi usada).`);
  p('> A API não informa data de recebimento. Nada aqui presume recebimento; "indício" não é prova. Arquivos: `04A-compras-pendentes.csv`, `04B-sugestoes-cenarios.csv`, `04C-origem-das-compras.csv`, `04D-vendas-mr090-mr091.csv`.');

  const tAtual = totaisSugestao(cenarios[0][1], custos, idsProd), tInt = totaisSugestao(cenarios[3][1], custos, idsProd);
  p('## 0. Resumo',
    `- ${antigas.length} compras pendentes antigas (${num(antigas.reduce((s, x) => s + x.unidades, 0))} un, ${brl(antigas.reduce((s, x) => s + x.valor_cents, 0))}). **Nenhuma tem prova de recebimento.** Vereditos: ${Object.entries(antigas.reduce((o, x) => { const v = ind.get(x.id).veredito; o[v] = (o[v] || 0) + 1; return o; }, {})).map(([k, v]) => `${k} ${v}`).join(' · ')}.`,
    `- Sugestões: a política vigente não desconta pendentes; se (hipótese) 100 % já estivesse no estoque sem lançamento, os produtos afetados iriam de ${tAtual.unidades} para ${tInt.unidades} un sugeridas (${brl(tAtual.capital_cents)} → ${brl(tInt.capital_cents)}).`,
    `- MR.090/MR.091: ${candidata.length === 1 ? `a diferença aponta para a venda ${candidata[0].id}, presente no MR4 e (hipótese) excluída no GestãoClick` : 'ver seção 4'}.`,
    `- Origem: ${res.comprovadas.compras} de ${res.total.compras} compras comprovadas (${num(res.comprovadas.unidades)} un, ${brl(res.comprovadas.valor_cents)})${vinculos ? '' : '; **provisório**, falta a prova por título (execução no GestãoClick)'}.`);

  p('## 1. Compras pendentes antigas');
  p(tabela(['Compra (id)', 'Nº pedido', 'Emissão', 'Idade (d)', 'Situação', 'Fornecedor', 'Produtos', 'Unidades', 'Valor', 'Veredito'],
    antigas.map(x => [x.id, vinculos && vinculos.get(x.id) ? vinculos.get(x.id).codigo : 'PENDENTE', br(x.data_emissao), x.idade_dias, x.situacao, forn(x.fornecedor_id), x.itens.length, num(x.unidades), brl(x.valor_cents), ind.get(x.id).veredito])
      .concat([['**Total**', '', '', '', '', '', new Set(antigas.flatMap(x => x.itens.map(i => i.produto_id))).size + ' distintos', num(antigas.reduce((s, x) => s + x.unidades, 0)), brl(antigas.reduce((s, x) => s + x.valor_cents, 0)), '']])));
  p('**Como ler.** "Sobra" = saldo atual − (compras confirmadas − vendas) em todo o histórico (desde 2022): perto da quantidade pendente é compatível com mercadoria que entrou sem confirmação, mas ajustes manuais produzem o mesmo efeito. "Saldo implícito na emissão" = saldo + vendas desde a emissão − confirmadas desde então. Veredito: ' + Object.entries(C.VEREDITOS).map(([k, v]) => `\`${k}\` = ${v}`).join('; ') + '.');
  p(`Os snapshots diários começam em ${br(dias[0])}: entradas anteriores não são observáveis. Dias com entrada igual à quantidade pendente desde então: ${antigas.reduce((s, x) => s + ind.get(x.id).itens.filter(i => i.dias_com_entrada_vista.length).length, 0)} item(ns).`);
  p(`**Força do indício "sobra":** a mesma régua aplicada a compras já confirmadas (5+ produtos, nenhum pendente) marca "compatível" em ${fundo.compativeis} de ${fundo.avaliadas}. É a taxa de fundo causada por ajustes manuais.${repetidos.length ? ` Produto presente em mais de uma pendente (${repetidos.map(cod).join(', ')}): a mesma sobra não sustenta as duas.` : ''}`);
  for (const x of antigas) {
    const r = ind.get(x.id), raw = compras.find(c => c.id === x.id), n = vinculos && vinculos.get(x.id), g = log && log.pendentes.get(x.id);
    p(`### Compra ${x.id} — ${md(forn(x.fornecedor_id))} · ${br(x.data_emissao)} · ${x.situacao} · ${brl(x.valor_cents)}`);
    p(`Última alteração no ERP: ${x.modificado_em || '—'} · impostos ${brl(K.centavos(raw.valor_impostos))} · frete ${brl(K.centavos(raw.valor_frete))} · desconto ${brl(K.centavos(raw.desconto_valor))}. **${r.veredito}**: ${r.explicacao}.${r.compras_gemeas.length ? ` Compra gêmea: ${r.compras_gemeas.map(i => { const t = compras.find(c => c.id === i); const un = C.unidadesPorProduto(t), razoes = (raw.produtos || []).map(y => { const z = (t.produtos || []).find(w => w.produto_id === y.produto_id); return z && K.centavos(y.valor_custo) > 0 ? K.centavos(z.valor_custo) / K.centavos(y.valor_custo) : null; }).filter(v => v !== null); return `${i} (${br(t.data_emissao)}, ${t.nome_situacao}, ${brl(C.valorCompraCents(t))}, frete ${brl(K.centavos(t.valor_frete))}, ${un.size} produto(s); custo unitário da gêmea ÷ o da pendente: ${razoes.length ? num(Math.min(...razoes)) + ' a ' + num(Math.max(...razoes)) : '—'})`; }).join(', ')}.` : ''}`);
    p(tabela(['Código', 'Produto', 'Pendente', 'Custo un.', 'Saldo', 'Vendido desde', 'Confirmado desde', 'Compras post. (mesmo forn.)', '1ª post.', 'Sobra', 'Implícito na emissão', 'Sugestão atual → se 100 % de todas'],
      r.itens.map(i => [cod(i.produto_id), nomeProd.get(i.produto_id) || '—', num(i.quantidade), brl(K.centavos((raw.produtos.find(y => y.produto_id === i.produto_id) || {}).valor_custo)), num(i.saldo), num(i.vendido_desde), num(i.confirmado_desde), `${i.compras_confirmadas_posteriores} (${i.do_mesmo_fornecedor})`, br(i.primeira_confirmada_posterior), num(i.residuo_vida), num(i.saldo_implicito_na_emissao), `${qtd(atual, i.produto_id)} → ${qtd(cenarios[3][1], i.produto_id)}`])));
    if (g) p(`GestãoClick: nº ${g.codigo || '—'} · cadastrada ${g.cadastrado_em || '—'} · NF-e informada: ${g.tem_nfe ? 'sim' : 'não'} · histórico de situações: ${g.historico.itens.length ? g.historico.itens.map(h => `${h.nome || h.situacao_id || '?'} em ${h.data || '?'}`).join(' → ') : 'não fornecido'} · parcelas: ${g.parcelas.length ? g.parcelas.map(q => `${br(q.vencimento)} ${q.valor || ''}`).join(', ') : 'nenhuma'} · observações citam: ${Object.entries(g.observacao_menciona).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nada dos termos pesquisados'} · detalhe: ${g.detalhe}.`);
    else p('GestãoClick (nº do pedido, histórico de situações, parcelas): **PENDENTE da execução**.');
    p(n ? `Títulos a pagar da loja que citam o pedido: ${n.titulos} (${brl(n.soma_cents)}), pagos ${n.pagos} (${brl(n.soma_paga_cents)}). Pagamento comprova obrigação financeira, **não** recebimento.` : `Títulos a pagar: ${vinculos ? 'nenhum' : 'PENDENTE da execução (o Financeiro guarda só 365 dias de pagos; nos títulos retidos nenhum foi associado)'}.`);
  }
  p('**Ação (humana, no GestãoClick):** conferir na NF/fisicamente cada compra; confirmar, cancelar ou corrigir quantidade. Prioridade: a de duplicidade provável (confirmar lançaria o estoque em dobro; antes de cancelar, conferir se há título financeiro próprio, pois os custos diferem) e a de maior sobra compatível. Em compra sem saldo e sem venda desde a emissão, verificar também reembolso/devolução.');

  p('## 2. Regra de sinalização e tela');
  p(`Regra \`${C.REGRA_PENDENTE.versao}\`: situação "A receber" ou "Em aberto" **e** idade da emissão > ${C.REGRA_PENDENTE.idade_max_dias} dias (mesmo corte que a Política 1.3 em sombra usa para ignorar trânsito) → **precisa de confirmação**. Sem data legível também. Compra "Cancelada"/"Confirmada" nunca entra.`);
  p('No branch `exec2/compras-dados`: o sync grava `compras_n0_view/sugestoes.pendencias_compras` (sem custo, valor ou fornecedor; só existe se houver compra a confirmar) e a tela de Compras mostra o aviso com a lista e o selo "COMPRA PENDENTE ANTIGA · CONFIRMAR" nos produtos. Somente leitura; sugestões, política, Rules e pedidos não mudam. **Não publicado** (exige deploy das Functions de Compras e do Hosting).');

  p('## 3. Sugestões da Política ' + POLITICA_VIGENTE.policy_version + ' por cenário');
  p(`Conferência: a simulação local do cenário ATUAL difere da visão publicada em **${diverge}** produto(s). Escopo: ${antigas.length} compras antigas, ${idsProd.size} produtos. Os cenários de recebimento são **hipóteses**.`);
  p(tabela(['Cenário', 'Sugeridos (afetados)', 'Unidades (afetados)', 'Capital a custo cadastrado (afetados)', 'Prioridades (afetados)', 'Total geral: produtos / unidades / capital'],
    cenarios.map(([n, r]) => { const a = totaisSugestao(r, custos, idsProd), t = totaisSugestao(r, custos); return [n, a.produtos, num(a.unidades), brl(a.capital_cents) + (a.sem_custo ? ` (${a.sem_custo} sem custo)` : ''), Object.entries(a.prioridade).sort().map(([k, v]) => `${k}:${v}`).join(' ') || '—', `${t.produtos} / ${num(t.unidades)} / ${brl(t.capital_cents)}`]; })));
  p('Efeito de cada compra, se (hipoteticamente) 100 % dela entrasse no saldo:');
  p(tabela(['Compra', 'Veredito', 'Produtos com sugestão alterada', 'Redução em unidades', 'Redução de capital'], porCompra.map(({ p: x, r }) => { const ids = new Set(x.itens.map(i => i.produto_id)), a = totaisSugestao(atual, custos, ids), b = totaisSugestao(r, custos, ids); return [x.id, ind.get(x.id).veredito, [...ids].filter(i => qtd(atual, i) !== qtd(r, i)).length, num(a.unidades - b.unidades), brl(a.capital_cents - b.capital_cents)]; })));
  p('**Leitura.** A 1.2 não desconta pedido pendente: "ignorar" é idêntico ao atual. Se a mercadoria tiver chegado **e o saldo não tiver sido lançado**, a sugestão atual está inflada até a diferença acima; se o saldo já a contém (entrada por ajuste), a sugestão atual já está certa e não há nada a descontar. A decisão depende da conferência da seção 1. Enquanto não houver confirmação, **não descontar** essas unidades.');

  p('## 4. MR.090 e MR.091 — venda divergente GC × MR4 (−30 e −20 un)');
  p('Reconciliação de 26/11 12:55: GC 497 vendas × MR4 497, com 1 só no GC (nova, posterior à leitura) e **1 só no MR4**; unidades 7.648 × 7.696 (−48 = −30 −20 +1 +1). Logo, um único registro presente só no MR4 responde pelas duas diferenças.');
  p(tabela(['Venda', 'Data', 'Situação', 'Baixou', 'Última alteração', 'Itens', 'MR.090', 'MR.091', 'Produto repetido', 'No GC'], vendasAlvo.map(v => [v.id, br(v.data), v.situacao, v.baixou, v.modificado, v.itens, v.q90 || '', v.q91 || '', v.repetido ? 'sim' : 'não', noLog ? (noLog.has(v.id) ? 'sim' : (periodoLog && v.data >= periodoLog.inicio ? '**NÃO**' : 'fora da janela')) : 'PENDENTE'])));
  p(candidata.length === 1 ? `Única venda com exatamente 30 de MR.090 + 20 de MR.091 **e mais nenhum item** (se faltasse uma venda com outros itens, eles também divergiriam): **${candidata[0].id}** (${br(candidata[0].data)}, alterada ${candidata[0].modificado}). Há outra venda com as mesmas quantidades e itens adicionais: ${vendasAlvo.filter(v => v.id !== candidata[0].id && v.q90 === 30 && v.q91 === 20).map(v => `${v.id} (${br(v.data)}, ${v.itens} itens, alterada ${v.modificado})`).join(', ') || 'nenhuma'}.` : `Venda de dois itens com 30 + 20 na base atual: ${candidata.length} (se zero, a sincronização completa já a removeu).`);
  p('Saldo (entradas observadas além das compras confirmadas, por dia):');
  p(tabela(['Código', 'Dia: unidades a mais no saldo'], residuos.map(r => [cod(r.id), r.dias.map(([dia, o, e]) => `${br(dia)}: ${o - e > 0 ? '+' : ''}${num(o - e)}`).join('; ') || 'nenhuma'])));
  const REF = '415281034', naBase = d.base.vendas.some(v => v.id === REF);
  p(`A volta de +30/+20 ao saldo em 26/11 é compatível com o estorno de uma venda (pares −n/+n em dias seguidos, como em 28–29/10, são venda lançada com a data do dia seguinte e se anulam). Na análise de 26/11 a venda ${REF} (criada 25/11, só esses 2 itens) estava na base do MR4 desde a reconciliação completa das 03:15 e já faltava no GC às 12:55. Base usada nesta geração (completa em ${d.meta.ultima_reconciliacao_completa}): ${naBase ? 'ainda contém a venda' : 'já não contém a venda (removida pela reconciliação completa, o que reforça a exclusão no ERP)'}. O incremental mescla por id e **nunca remove** registro excluído; só o completo (03:15) remove. Hipótese principal: **venda excluída no GestãoClick na manhã de 26/11**, depois de relançada na venda de 6 itens (aparente lançamento em duplicidade). Não há sinal de edição retroativa de quantidade; nenhum produto tem variação.`);
  if (log && log.detalhes.length) p(tabela(['Venda consultada', 'Encontrada no GC', 'Código/erro', 'Situação', 'Cadastrada', 'Alterada', 'Mesmo cliente?'], log.detalhes.map(v => [v.id, v.encontrada ? 'sim' : 'não', v.venda ? v.venda.codigo : v.codigo, v.venda ? v.venda.situacao : '—', v.venda ? v.venda.cadastrado_em : '—', v.venda ? v.venda.modificado_em : '—', v.venda ? v.venda.cliente : '—'])));
  else p('Confirmação no GestãoClick (venda a venda, detalhe por id): **PENDENTE da execução**.');
  if (soMr4) p(`Com o log: só no MR4: ${soMr4.map(v => v.id).join(', ') || 'nenhuma'}; só no GC (produtos alvo): ${soGc.map(v => v.id).join(', ') || 'nenhuma'}.`);
  if (semVenda) p('Efeito de manter a venda na demanda do MR4: ' + PRODUTOS_VENDA.map(id => { const a = atual.get(id), b = semVenda.get(id); return `${cod(id)}: vendas 90 d ${num(a.units[90])} → ${num(b.units[90])}; sugestão ${a.suggestion.suggested_qty} → ${b.suggestion.suggested_qty}`; }).join(' · ') + '.');
  p('**Recomendação (não implementada):** o incremental comparar os ids da janela relida com os da base e remover/sinalizar os ausentes (só com a janela comprovadamente completa).');

  p('## 5. Origem das compras (loja 262759)');
  p(`\`/compras\` não tem filtro de loja comprovado nem campo de loja (618 com e sem \`loja_id\`)${log && log.compras ? `; na execução: ${log.compras.total} registros, ${log.compras.com_campo_de_loja} com campo de loja, ${log.compras.itens_com_estoque_id}/${log.compras.itens} itens com estoque_id (${log.compras.estoque_ids_distintos} distintos)` : ''}. Nenhuma outra loja foi consultada.`);
  p(tabela(['Método', 'Força', 'Alcance', 'Resultado'], [
    ['Título a pagar lido com loja_id=262759: "Compra de nº X", código único e mesmo fornecedor', 'Prova (por registro se o título trouxer a loja; senão depende do filtro documentado)', 'Todo o histórico', vinculos ? `${res.por_prova.titulo.compras} compras; títulos com loja no registro: ${log.titulos.loja_confirmada_no_registro} de ${log.titulos.titulos}` : `PENDENTE. Parcial (Financeiro, títulos retidos): ${codRetidos.size} pedidos distintos citados por ${titulosRetidos.length} títulos (${brl(titulosRetidos.reduce((s, t) => s + (t.val || 0), 0))}); o MR4 não guarda o nº do pedido, então não dá para ligar ao id`],
    ['Entrada no saldo da loja (≥ 80 % dos produtos no mesmo dia, quantidade exata)', 'Prova', `Confirmadas desde ${br(dias[0])}: ${entrada.size} avaliáveis`, `${res.por_prova.entrada.compras} compras comprovadas`],
    ['Custo cadastrado na loja = custo rateado da última compra (valor que só ela tem)', 'Indício (o ERP pode compartilhar custo entre lojas)', 'Última compra de cada produto', `${origem.filter(o => o.indicio_custo).length} compras`],
    ['Todos os produtos no catálogo da loja', 'Nenhuma: o catálogo pode ser comum às lojas', 'Todas', `${noCatalogo} de ${compras.length} (${semCodigoProd} com item sem produto)`],
  ]));
  p(`Teste placebo do método de entrada (janela deslocada em dias → avaliadas / "comprovadas"): ${placebo.map(([s, a, b]) => `${s > 0 ? '+' : ''}${s}: ${a}/${b}`).join(' · ')}. Deslocamentos curtos podem sobrepor a entrada verdadeira.`);
  p(tabela(['Classificação' + (vinculos ? '' : ' (PROVISÓRIA, sem títulos)'), 'Compras', 'Unidades', 'Valor'], [
    ...Object.entries(res.por_nivel).filter(([, g]) => g.compras).map(([n, g]) => [`${n} — ${C.NIVEIS[n]}`, g.compras, num(g.unidades), brl(g.valor_cents)]),
    ['**Comprovadas**', res.comprovadas.compras, num(res.comprovadas.unidades), brl(res.comprovadas.valor_cents)], ['**Não comprovadas**', res.nao_comprovadas.compras, num(res.nao_comprovadas.unidades), brl(res.nao_comprovadas.valor_cents)], ['Total', res.total.compras, num(res.total.unidades), brl(res.total.valor_cents)]]));
  const antigasOri = origem.filter(o => idsAntigas.has(o.id));
  p(`Pendentes antigas: ${antigasOri.map(o => `${o.id}: ${o.nivel}`).join('; ')}.`);
  p('**Limitação.** Comprovar não exclui ninguém: compra sem título (bonificação, pagamento sem vínculo, descrição editada) e anterior aos snapshots continua sem prova, o que não significa ser de outra loja. Código repetido ou fornecedor divergente fica em CONFLITO. A prova por título supõe que o número do pedido não se repete entre lojas para o mesmo fornecedor.');
  p('**Marca `usar_em_decisao_automatica`** (coluna da 04C; função `classificarOrigem`): SIM só com prova. É dado de relatório: o motor não a lê. Proposta (exige aprovação): decisões automáticas futuras (custo de referência, prazo da 1.3, trânsito) ignorarem registros NÃO; hoje a 1.2 usa compras confirmadas para 1ª evidência do produto, último fornecedor e referência de custo, e nada disso define quantidade, exceto a data de 1ª evidência na regra de produto novo.');

  p('## 6. Como completar com o GestãoClick (integrador)');
  p('Somente leitura: GET, loja 262759, sem Firestore, orçamento 160 requisições. Rodar fora dos horários de sync. Publicar a imagem altera o Job (reverter depois).');
  p('```bash', '# na raiz do worktree w2-compras-dados (branch exec2/compras-dados)',
    'IMG=southamerica-east1-docker.pkg.dev/mr4-ponto/mr4-jobs/mr4-sync-job:$(git rev-parse --short HEAD)',
    'ANTES=$(gcloud run jobs describe mr4-sync-job --project=mr4-ponto --region=southamerica-east1 --format=\'value(spec.template.spec.template.spec.containers[0].image)\')',
    'gcloud builds submit --project=mr4-ponto --config cloudrun/cloudbuild.yaml --substitutions _IMAGE=$IMG .',
    'gcloud run jobs update mr4-sync-job --project=mr4-ponto --region=southamerica-east1 --image=$IMG',
    'EXEC=$(gcloud run jobs execute mr4-sync-job --project=mr4-ponto --region=southamerica-east1 --args="node,scripts/investigar-compras.js,--max-requisicoes=160" --wait --format=\'value(metadata.name)\')',
    'gcloud logging read "resource.type=\\"cloud_run_job\\" AND resource.labels.job_name=\\"mr4-sync-job\\" AND labels.\\"run.googleapis.com/execution_name\\"=\\"$EXEC\\" AND textPayload:\\"INVC_\\"" --project=mr4-ponto --order=asc --limit=1000 --format=\'value(textPayload)\' > /Users/murilorodrigueslima/mr4-trabalho/exec-logs/invc-$EXEC.log',
    'gcloud run jobs update mr4-sync-job --project=mr4-ponto --region=southamerica-east1 --image=$ANTES',
    'node functions/scripts/relatorio_compras_confiabilidade.js --log=/Users/murilorodrigueslima/mr4-trabalho/exec-logs/invc-$EXEC.log --saida="/Users/murilorodrigueslima/Library/CloudStorage/Dropbox/MR4 IA/PLANO-MESTRE-2027/EXEC2"', '```');

  return { arquivos: { '04-COMPRAS-CONFIABILIDADE-DOS-DADOS.md': L.join('\n'), '04A-compras-pendentes.csv': csvPend, '04B-sugestoes-cenarios.csv': csvCen, '04C-origem-das-compras.csv': csvOri, '04D-vendas-mr090-mr091.csv': csvVen },
    numeros: { fundo, pendentes: antigas.length, vereditos: Object.fromEntries(antigas.map(x => [x.id, ind.get(x.id).veredito])), diverge, cenarios: cenarios.map(([n, r]) => [n, totaisSugestao(r, custos, idsProd), totaisSugestao(r, custos)]), origem: res, placebo, codRetidos: codRetidos.size, candidata: candidata.map(v => v.id) } };
}

async function principal(argv) {
  const o = {};
  for (const a of argv) { const m = /^--(dados|log|saida)=(.+)$/.exec(a); if (!m) throw new Error('ARGUMENTO_INVALIDO'); o[m[1]] = m[2]; }
  if (!o.saida) throw new Error('--saida obrigatório');
  const d = await carregarDados(o.dados);
  const r = gerar(d, o.log ? lerLog(fs.readFileSync(o.log, 'utf8')) : null);
  fs.mkdirSync(o.saida, { recursive: true });
  for (const [n, c] of Object.entries(r.arquivos)) fs.writeFileSync(path.join(o.saida, n), c);
  console.log(JSON.stringify(r.numeros));
}

if (require.main === module) principal(process.argv.slice(2)).catch(e => { console.error('ERRO', String(e.code || e.message).slice(0, 200)); process.exit(1); });

module.exports = { lerLog, gerar, entradasMotor, simular, totaisSugestao, csv };
