'use strict';
// AGENTE DE COMPRAS — AI CONTEXT BUILDER + ALLOWLIST. O motor (compras_n0_view) seleciona/ordena; aqui só se escolhem CANDIDATOS (≈30 de centenas),
// refs opacas (P001…) e fatos. Sem nome/código de produto, sem fornecedor, sem ids do ERP, sem texto livre: textos do cadastro nunca chegam ao modelo.
const F = require('./fatos');
const O = require('./orcamento');
const { MOTIVOS, ROTULOS } = require('./prompt');
const { escaneiarTextoParaPII } = require('../../../n29/piiGuard');

const VERSAO = 'compras-ia-1', FRESCO_HORAS = 6;   // FRESCO_HORAS: igual ao limiar de frescor da tela (compras.html)

function calcularFrescor(visao, meta, agoraIso) {
  const s = visao.sugestoes || {}, c = visao.custos || null;
  const em = (meta && meta.ultima_sincronizacao_ok) || s.gerado_em || null;
  const horas = em ? Math.max(0, Math.round((new Date(agoraIso).getTime() - new Date(em).getTime()) / 36e5)) : null;
  const falhou = !!(meta && meta.ultima_tentativa_ok === false), desalinhada = !!(c && c.gerado_em && s.gerado_em && c.gerado_em !== s.gerado_em);
  const desatualizado = !em || !meta || horas > FRESCO_HORAS || falhou || desalinhada;
  return { sourceUpdatedAt: em, desatualizado, contexto: { atualizadoEm: em, dataComercial: s.data_comercial || null, versaoPolitica: s.policy_version || null, modoUltimaGeracao: (meta && meta.modo_sync) || null, horasDesdeAtualizacao: horas, desatualizado, ultimaTentativaFalhou: falhou, visoesDesalinhadas: desalinhada } };
}

const DESC = { RUPTURA: 'risco', IMPACTO: 'impacto', ADIAR: 'adiar', REVISAO: 'revisar', EXCESSO: 'excesso', CAPITAL: 'capital', URGENTE: 'urgentes', GERAL: 'urgentes', RESUMO: 'urgentes', ORCAMENTO: 'urgentes' };
const LISTAS = ['urgentes', 'risco', 'impacto', 'adiar', 'revisar', 'capital', 'excesso'];

/** Resultado da cesta → fatos do orçamento (em R$/inteiros) + anotações por produto. */
function fatosOrcamento(cesta, valorCents) {
  const s = cesta.sim, c = v => Math.round(v) / 100;
  const cont = m => cesta.fora.filter(x => x.motivo === m).length;
  return { status: 'OK', valor: c(valorCents), estrategia: cesta.estrategia, capitalUsado: c(s.spent_cents), sobra: c(s.left_cents), produtosContemplados: s.products_funded, produtosElegiveis: s.full.products, unidadesFinanciadas: s.units_funded, unidadesElegiveis: s.full.units,
    capitalCompraCompleta: c(s.full.capital_cents), p1Contemplados: s.p1.funded, p1ComCusto: s.p1.products_with_cost, p1NaoContemplados: s.p1.unfunded, p1PisoAtingido: s.p1.floor_covered, p1CapitalMinimoPiso: c(s.p1.minimum_capital_floor_cents), diasPisoP1: null,
    pisoP1Insuficiente: s.alerts.includes('P1_FLOOR_INSUFFICIENT'), receitaPotencial: c(s.revenue_potential_cents), lucroBrutoPotencial: c(s.gross_profit_potential_cents), margemAgregadaPct: s.gross_margin_pct, retornoBrutoPct: s.gross_return_on_capital === null ? null : Math.round(s.gross_return_on_capital * 10000) / 100,
    foraOrcamentoEsgotado: cont('ORCAMENTO_ESGOTADO'), foraSemCusto: cont('SEM_CUSTO'), foraUnidadeMaisCara: cont('UNIDADE_MAIS_CARA_QUE_ORCAMENTO'), comprasParciais: cont('COMPRA_PARCIAL') };
}

/** @param visao {sugestoes, custos|null} · meta · opts {gestao, pergunta, agoraIso, escala} */
function construirContexto(visao, meta, { gestao, pergunta, agoraIso, escala = 1 }) {
  const P = F.fatosDaVisao(visao, gestao), foco0 = F.detectarFoco(pergunta), semDado = F.temasSemDado(pergunta);
  const orc = O.parsearOrcamento(pergunta), rf = visao.custos && visao.custos.resumo_financeiro;
  const R = F.rankings(P, gestao), resumoGeral = F.resumo(P, visao, gestao), fr = calcularFrescor(visao, meta, agoraIso);
  // ── orçamento: cesta determinística (nunca o modelo) ──
  let orcamento = null, cesta = null, foco = foco0;
  if (orc.status !== 'NENHUM') {
    foco = 'ORCAMENTO';
    if (orc.status !== 'OK') orcamento = { status: orc.status, minimoReais: O.ORCAMENTO_MIN_REAIS, maximoReais: O.ORCAMENTO_MAX_REAIS };
    else if (!gestao) orcamento = { status: 'SEM_PERMISSAO_DE_CUSTO' };
    else if (!(rf && rf.simulator && rf.simulator.strategy)) orcamento = { status: 'SIMULADOR_INDISPONIVEL' };
    else { cesta = O.montarCesta(visao.sugestoes.linhas, (visao.custos && visao.custos.linhas) || {}, rf.simulator, orc.valorCents); orcamento = fatosOrcamento(cesta, orc.valorCents); orcamento.diasPisoP1 = rf.simulator.p1_floor_days; }
  }
  const porId = new Map(P.map(p => [p.id, p])), aloc = cesta ? new Map(cesta.sim.items.map(a => [a.id, a])) : new Map(), fora = cesta ? new Map(cesta.fora.map(x => [x.id, x.motivo])) : new Map();
  const notas = id => { const p = porId.get(id), a = aloc.get(id), m = fora.get(id), extra = {}, sin = []; if (!cesta) return { extra, sin };
    if (a) { extra.cestaQtd = a.qty_1_2; extra.cestaCapital = Math.round(a.capital_cents) / 100; sin.push('NA_CESTA'); if (a.qty_1_2 !== p.qtd) sin.push('CESTA_PARCIAL'); }
    if (m === 'ORCAMENTO_ESGOTADO') sin.push('FORA_ORCAMENTO_ESGOTADO'); else if (m === 'SEM_CUSTO') sin.push('FORA_SEM_CUSTO'); else if (m === 'UNIDADE_MAIS_CARA_QUE_ORCAMENTO') sin.push('FORA_UNIDADE_MAIS_CARA');
    return { extra, sin }; };
  // ── seleção de candidatos (determinística; escala reduz) ──
  const k = n => Math.max(1, Math.ceil(n * escala)), escolhidos = [], vistos = new Set();
  const add = (ids, n) => { let c = 0; for (const id of ids) { if (c >= n) break; if (!vistos.has(id)) { vistos.add(id); escolhidos.push(id); c++; } } };
  if (cesta) { add(cesta.sim.items.map(a => a.id), k(20)); add(cesta.fora.filter(x => porId.get(x.id).prioridade === 'P1').map(x => x.id), k(6)); add(R.urgentes, k(4)); }
  else {
    const foco1 = foco === 'EXCESSO' ? ['adiar', 'excesso', 'revisar'] : [DESC[foco] === 'impacto' && !R.impacto ? 'risco' : DESC[foco] === 'capital' && !R.capital ? 'urgentes' : DESC[foco]];
    for (const l of foco1) add(R[l] || [], k(foco === 'EXCESSO' ? 10 : 14));
    if (foco === 'URGENTE' || foco === 'GERAL' || foco === 'RESUMO') add(R.capital || [], k(4));
    for (const l of ['urgentes', 'risco', 'adiar', 'revisar', 'excesso']) add(R[l] || [], k(5));
  }
  const entidades = {}, mapa = {}, refDe = new Map();
  escolhidos.forEach((id, n) => { const p = porId.get(id), ref = 'P' + String(n + 1).padStart(3, '0'), nt = notas(id); refDe.set(id, ref);
    const sinais = [...p.sinais, ...nt.sin].filter((v, i, a) => a.indexOf(v) === i); entidades[ref] = { ref, ...p.f, ...nt.extra, sinais }; mapa[ref] = { id: p.id, codigo: p.codigo, nome: p.nome || p.codigo || p.id }; });
  const refs = ids => ids.filter(i => refDe.has(i)).map(i => refDe.get(i));
  const rankings = {}; for (const l of LISTAS) if (R[l]) { const r = refs(R[l]); if (r.length) rankings[l] = r.slice(0, 20); }
  if (orcamento && orcamento.status === 'OK') orcamento.cesta = refs(cesta.sim.items.map(a => a.id));
  const limitacoes = ['Sugestões, prioridades, quantidades e totais vêm do motor de Compras; o agente não recalcula nada.', 'Custos e margens são estimativas (custo cadastrado no ERP); a confiança de cada custo está em custoConfianca.',
    'Não há dados de fornecedor, prazo de entrega, desconto, previsão futura nem concorrência.', 'Só entram produtos que o motor lista (com sugestão, estoque negativo, produto novo ou em atenção).'];
  if (!gestao) limitacoes.push('Custo, capital, margem e valores em R$ são restritos à gestão: não estão neste contexto.');
  else if (!rf) limitacoes.push('A visão de custos/rentabilidade não está disponível nesta geração: sem capital, margem nem orçamento.');
  if (P.length === 0) limitacoes.push('A lista do motor está vazia.');
  const contexto = { agenteVersao: VERSAO, geradoEm: agoraIso, foco, escopo: gestao ? 'COMPRAS_GESTAO' : 'COMPRAS_OPERACIONAL', visaoFinanceira: !!gestao, resumo: resumoGeral, rankings, entidades, limitacoes, frescor: fr.contexto, ...(orcamento ? { orcamento } : {}), ...(semDado.length ? { pedidoSemDado: semDado } : {}) };
  const fallback = (cesta ? cesta.sim.items.map(a => a.id) : (R[DESC[foco]] || R.urgentes)).filter(i => refDe.has(i)).slice(0, 10).map(i => ({ ref: refDe.get(i) }));
  return { contexto, mapa, resumo: P.length ? resumoGeral : null, fallback, bytes: Buffer.byteLength(JSON.stringify(contexto)), frescor: { sourceUpdatedAt: fr.sourceUpdatedAt, desatualizado: fr.desatualizado }, perguntaSegura: pergunta, vazio: P.length === 0 };
}

// ── ALLOWLIST (auditoria do contexto antes de sair para o provedor) ─────────────────────────────────────────────────────────
const CAMPO = { ref: 'S', prioridade: 'S', curvaAbc: 'S', estoque: 'N', coberturaDias: 'N', coberturaEstado: 'S', alvoDias: 'N', velocidadeDia: 'N', vendas30d: 'N', vendas90d: 'N', qtdSugerida: 'N', sinais: 'L', cestaQtd: 'N' };
const CAMPO_GESTAO = { capitalNecessario: 'N', custoUnitario: 'N', custoConfianca: 'S', precoUnitario: 'N', margemPct: 'N', retornoPct: 'N', lucroPotencial: 'N', receitaPotencial: 'N', impactoReceitaDia: 'N', cestaCapital: 'N' };
const ENUM = { prioridade: ['P1', 'P2', 'P3', 'P4'], coberturaEstado: ['CURRENT_STOCKOUT', 'NEGATIVE_STOCK', 'COVERAGE_CRITICAL', 'COVERAGE_LOW', 'COVERAGE_OK', 'COVERAGE_EXCESS', 'INSUFFICIENT_HISTORY', 'NO_DEMAND_OBSERVED', 'UNKNOWN'], custoConfianca: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] };
const TOPO = ['agenteVersao', 'geradoEm', 'foco', 'escopo', 'visaoFinanceira', 'resumo', 'rankings', 'entidades', 'limitacoes', 'frescor', 'orcamento', 'pedidoSemDado'];
const RESUMO_BASE = ['produtosParaRepor', 'unidadesSugeridas', 'itensCriticos', 'podemAguardar', 'riscoRuptura', 'rupturaAtual', 'estoqueNegativo', 'prioridadeP1', 'prioridadeP2', 'prioridadeP3', 'prioridadeP4', 'produtosEmAtencao', 'coberturaEmExcesso'];
const RESUMO_GESTAO = ['capitalSugerido', 'produtosSemCusto', 'receitaPotencial', 'lucroBrutoPotencial', 'margemAgregadaPct', 'retornoBrutoPct', 'capitalP1', 'capitalP4', 'sugeridosCustoBaixaConfianca', 'sugeridosMargemNegativa', 'capitalMinimoP1', 'diasPisoP1'];
const ORC_BASE = ['status', 'minimoReais', 'maximoReais'];
const ORC_OK = ['valor', 'estrategia', 'capitalUsado', 'sobra', 'produtosContemplados', 'produtosElegiveis', 'unidadesFinanciadas', 'unidadesElegiveis', 'capitalCompraCompleta', 'p1Contemplados', 'p1ComCusto', 'p1NaoContemplados', 'p1PisoAtingido', 'p1CapitalMinimoPiso', 'diasPisoP1',
  'pisoP1Insuficiente', 'receitaPotencial', 'lucroBrutoPotencial', 'margemAgregadaPct', 'retornoBrutoPct', 'foraOrcamentoEsgotado', 'foraSemCusto', 'foraUnidadeMaisCara', 'comprasParciais', 'cesta'];
const FRESCOR = ['atualizadoEm', 'dataComercial', 'versaoPolitica', 'modoUltimaGeracao', 'horasDesdeAtualizacao', 'desatualizado', 'ultimaTentativaFalhou', 'visoesDesalinhadas'];
const SEM_DADO_COD = ['FORNECEDOR_PRECO_PRAZO', 'PREVISAO_FUTURA', 'CONCORRENCIA_MERCADO', 'CRIAR_PEDIDO'];

function auditarContexto(ctx, acesso) {
  const p = [], gestao = !!(acesso && acesso.gestao), chave = (o, ok, nome) => { for (const k of Object.keys(o || {})) if (!ok.includes(k)) p.push(nome + ':' + k); };
  chave(ctx, TOPO, 'contexto'); chave(ctx.resumo, gestao ? RESUMO_BASE.concat(RESUMO_GESTAO) : RESUMO_BASE, 'resumo'); chave(ctx.frescor, FRESCOR, 'frescor');
  if (ctx.orcamento) { if (!gestao && ctx.orcamento.status === 'OK') p.push('orcamento:sem_gestao'); chave(ctx.orcamento, ORC_BASE.concat(ORC_OK), 'orcamento'); if (Array.isArray(ctx.orcamento.cesta) && ctx.orcamento.cesta.some(r => !ctx.entidades[r])) p.push('orcamento:cesta_ref'); }
  if (ctx.pedidoSemDado && ctx.pedidoSemDado.some(c => !SEM_DADO_COD.includes(c))) p.push('pedidoSemDado');
  for (const [ref, e] of Object.entries(ctx.entidades || {})) {
    if (!/^P\d{3}$/.test(ref) || e.ref !== ref) p.push('ref:' + ref);
    const ok = gestao ? { ...CAMPO, ...CAMPO_GESTAO } : CAMPO;
    for (const [k, v] of Object.entries(e)) {
      const t = ok[k]; if (!t) { p.push('entidade.' + k); continue; }
      if (t === 'N' && !(typeof v === 'number' && Number.isFinite(v))) p.push('tipo.' + k);
      if (t === 'S' && !(typeof v === 'string' && v.length <= 24 && /^[A-Za-z0-9_]+$/.test(v) && (!ENUM[k] || ENUM[k].includes(v)))) p.push('valor.' + k);
      if (t === 'L' && !(Array.isArray(v) && v.every(x => MOTIVOS.includes(x)))) p.push('sinais');
    }
    if (!gestao && e.sinais && e.sinais.some(x => ['SEM_CUSTO', 'CUSTO_BAIXA_CONFIANCA', 'MARGEM_NEGATIVA', 'MARGEM_BAIXA', 'MARGEM_ALTA', 'RETORNO_ALTO', 'RETORNO_BAIXO', 'ALTA_DEMANDA_MARGEM_BAIXA', 'CAPITAL_POUCO_ATRATIVO', 'NA_CESTA'].includes(x))) p.push('sinal_financeiro_sem_gestao');
  }
  for (const [k, l] of Object.entries(ctx.rankings || {})) if (!Array.isArray(l) || l.some(r => !ctx.entidades[r])) p.push('ranking:' + k);
  const pii = escaneiarTextoParaPII(JSON.stringify([ctx.limitacoes, ctx.frescor, ctx.foco]).replace(/\b20\d\d-\d\d-\d\d(T[\d:.]+Z)?\b/g, 'DATA')); if (!pii.ok) p.push('pii');
  return { ok: p.length === 0, problemas: p };
}
module.exports = { VERSAO, FRESCO_HORAS, calcularFrescor, construirContexto, auditarContexto, ROTULOS };
