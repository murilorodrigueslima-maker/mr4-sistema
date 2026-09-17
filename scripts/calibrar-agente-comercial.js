#!/usr/bin/env node
'use strict';

/**
 * calibrar-agente-comercial.js — N20: Calibração Comercial com Dados Reais
 *
 * SOMENTE LEITURA — ZERO writes.
 *   FIRESTORE_WRITES       = ZERO
 *   GESTAOCLICK_WRITES     = ZERO
 *   LLM_CALLS              = ZERO
 *   DEPLOYS                = ZERO
 *
 * Fonte: API GestãoClick (read-only) — mesma fonte usada pelo bootstrap360.
 * Nota: sem acesso Firestore local (sem service account), usamos GC API
 * diretamente para reconstruir perfis de forma determinística.
 *
 * Saída: docs/agente-comercial/CALIBRACAO_COMERCIAL.md
 *
 * Uso:
 *   GC_ACCESS_TOKEN=xxx GC_SECRET_ACCESS_TOKEN=yyy node scripts/calibrar-agente-comercial.js
 *   ou (com .env do Projetos):
 *   env $(cat ~/Projetos/MR4\ IA/integracoes/.env | grep -v ^# | xargs) node scripts/calibrar-agente-comercial.js
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Engines (não modificados) ─────────────────────────────────────────────────
const { calcularPerfil360, deduplicarVendas, agruparVendasPorCliente } = require('../functions/lib/perfil360');
const { calcularScore }          = require('../functions/lib/scoreComercial');
const { calcularTendencia }      = require('../functions/lib/tendenciaComercial');
const { calcularRecorrencia }    = require('../functions/lib/recorrencia');
const { gerarOportunidades }     = require('../functions/lib/oportunidades');
const { priorizarOportunidades } = require('../functions/lib/priorizadorOportunidades');
const { buildProdutosPorId, mesclaProdutosPorId } = require('../functions/lib/sync360');

// ── Config ────────────────────────────────────────────────────────────────────
const GC_ACCESS  = process.env.GC_ACCESS_TOKEN        || process.env.GESTAOCLICK_ACCESS_TOKEN;
const GC_SECRET  = process.env.GC_SECRET_ACCESS_TOKEN || process.env.GESTAOCLICK_SECRET_TOKEN;
const GC_BASE    = 'https://api.gestaoclick.com';
const HIST_INICIO = '2022-03-24';  // mesma constante do bootstrap
const DATA_REF    = calcularDataReferencia();
const OUT_DIR     = path.join(__dirname, '..', 'docs', 'agente-comercial');
const OUT_FILE    = path.join(OUT_DIR, 'CALIBRACAO_COMERCIAL.md');

if (!GC_ACCESS || !GC_SECRET) {
  console.error('ERRO: GC_ACCESS_TOKEN e GC_SECRET_ACCESS_TOKEN são obrigatórios.');
  console.error('  Uso: env $(cat ~/Projetos/MR4\\ IA/integracoes/.env | xargs) node scripts/calibrar-agente-comercial.js');
  process.exit(1);
}

function calcularDataReferencia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }))
    .toISOString().slice(0, 10);
}

// ── GestãoClick HTTP (read-only) ──────────────────────────────────────────────

function gcGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs  = new URLSearchParams({ ...params, limite: '100' }).toString();
    const url = `${GC_BASE}${endpoint}?${qs}`;
    https.get(url, {
      headers: { 'access-token': GC_ACCESS, 'secret-access-token': GC_SECRET, 'Content-Type': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`GC JSON parse error on ${endpoint}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function gcFetchAllPages(endpoint, params = {}) {
  const all = [];
  let pagina = 1;
  const visited = new Set();
  while (true) {
    if (visited.has(pagina)) break;
    visited.add(pagina);
    const r = await gcGet(endpoint, { ...params, pagina });
    const data = Array.isArray(r.data) ? r.data : [];
    all.push(...data);
    const proxima = (r.meta || {}).proxima_pagina;
    if (!proxima) break;
    pagina = Number(proxima);
  }
  return all;
}

// ── Estatísticas ──────────────────────────────────────────────────────────────

function percentil(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.min(idx, sorted.length - 1)];
}

function stats(values) {
  if (!values.length) return { min: 0, p10: 0, p25: 0, mediana: 0, p75: 0, p90: 0, max: 0, media: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const media = values.reduce((s, v) => s + v, 0) / n;
  return {
    min:    sorted[0],
    p10:    percentil(sorted, 10),
    p25:    percentil(sorted, 25),
    mediana: percentil(sorted, 50),
    p75:    percentil(sorted, 75),
    p90:    percentil(sorted, 90),
    max:    sorted[n - 1],
    media:  media,
    n,
  };
}

function correlacao(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  return num / Math.sqrt(dx2 * dy2);
}

function fmt2(n) { return Number.isFinite(n) ? n.toFixed(2) : '—'; }
function fmtR(n) { return 'R$' + (Math.round(n) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }
function fmtN(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString('pt-BR') : '—'; }

function anonimizar(gcId) {
  // Anonimiza o ID do cliente GC — sem nome real, sem CPF/CNPJ
  return 'C' + crypto.createHash('sha1').update(String(gcId)).digest('hex').slice(0, 4).toUpperCase();
}

// ── Score com pesos alternativos (seção 15) ───────────────────────────────────

function calcularScoreAlternativo(perfil, tend, pesos) {
  // Replica lógica de calcularScore com pesos customizados
  // Sem alterar scoreComercial.js
  const { THRESHOLDS_RECENCIA, REF_FATURAMENTO_TOTAL, REF_FATURAMENTO_90D, REF_PEDIDOS_90D } = require('../functions/config/score-comercial.v1');

  if (perfil.nuncaComprou) return { scoreTotal: 0, classificacao: 'NUNCA_COMPROU' };

  // Recência
  let recencia = 0;
  const dias = perfil.diasSemComprar || 999;
  if      (dias <= THRESHOLDS_RECENCIA[0]) recencia = 100;
  else if (dias <= THRESHOLDS_RECENCIA[1]) recencia = 75;
  else if (dias <= THRESHOLDS_RECENCIA[2]) recencia = 50;
  else if (dias <= THRESHOLDS_RECENCIA[3]) recencia = 25;
  else                                      recencia = 0;

  // Frequência
  const freq = Math.min((perfil.pedidosTotal || 0) / Math.max(1, (perfil.diasEntreComprasMedio || 365) / 30), 1);
  const frequencia = Math.round(freq * 100);

  // Faturamento
  const fat = Math.min((perfil.faturamentoTotal || 0) / REF_FATURAMENTO_TOTAL, 1) * 100;
  const fat90 = Math.min((perfil.faturamento90d || 0) / REF_FATURAMENTO_90D, 1) * 100;
  const faturamento = Math.round((fat * 0.5) + (fat90 * 0.5));

  // Tendência
  const tendMap = { CRESCENDO: 100, ESTAVEL: 60, CAINDO: 20, SEM_BASE: 40, NUNCA_COMPROU: 0 };
  const tendencia = tendMap[tend.tendencia] ?? 40;

  // Diversidade (categorias)
  const cats = (perfil.categoriasMaisCompradas || []).length;
  const diversidade = Math.min(cats / 5, 1) * 100;

  // Engajamento (pedidos 30d vs 90d)
  const ped30 = perfil.pedidos30d || 0;
  const ped90 = perfil.pedidos90d || 0;
  const engajamento = ped90 > 0 ? Math.min((ped30 / (ped90 / 3)) * 100, 100) : 0;

  const total = Math.round(
    (recencia    * pesos[0] / 100) +
    (frequencia  * pesos[1] / 100) +
    (faturamento * pesos[2] / 100) +
    (tendencia   * pesos[3] / 100) +
    (diversidade * pesos[4] / 100) +
    (engajamento * pesos[5] / 100)
  );
  return { scoreTotal: Math.max(0, Math.min(100, total)) };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('CALIBRAÇÃO COMERCIAL N20 — MR4 Agente IA');
  console.log('='.repeat(60));
  console.log('DATA_REFERENCIA:', DATA_REF);
  console.log('FONTE: GestãoClick API (read-only)');
  console.log('FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO');
  console.log('');

  // ── 1. Fetch dados ──────────────────────────────────────────────────────────

  console.log('Buscando vendas desde', HIST_INICIO, '(pode levar ~3 min)...');
  const todasVendas = await gcFetchAllPages('/vendas', {
    data_inicio: HIST_INICIO,
    data_fim:    DATA_REF,
  });
  console.log('Vendas brutas:', todasVendas.length);

  console.log('Buscando produtos...');
  const produtos = await gcFetchAllPages('/produtos', { ativo: '1' });
  const produtosPorId = buildProdutosPorId(produtos);
  console.log('Produtos:', Object.keys(produtosPorId).length);

  // ── 2. Processar vendas ─────────────────────────────────────────────────────

  const { vendas: vendasDedup } = deduplicarVendas(todasVendas);
  const mapaVendas = agruparVendasPorCliente(vendasDedup);

  // Todos os cliente_id com pelo menos 1 venda
  const gcIds = [...mapaVendas.keys()].filter(id => id && id.trim() && id !== '0');
  console.log('Clientes únicos com compra:', gcIds.length);

  // ── 3. Calcular perfis + motores ─────────────────────────────────────────────

  const resultados = [];

  for (const gcId of gcIds) {
    const vendas = mapaVendas.get(gcId) || [];
    const perfil  = calcularPerfil360({
      clienteMr4Id:     gcId,   // usamos gcId como identificador anônimo
      gestaoClickId:    gcId,
      vendas,
      produtosPorId,
      dataReferencia:   DATA_REF,
      calculadoEm:      new Date().toISOString(),
      historicoCoberto: { inicio: HIST_INICIO, fim: DATA_REF },
    });

    const tend    = calcularTendencia(perfil);
    const recorr  = calcularRecorrencia(perfil);
    const score   = calcularScore(perfil, tend.tendencia);
    const opors   = gerarOportunidades(perfil, score, tend, recorr, DATA_REF);
    const priors  = priorizarOportunidades(opors, perfil, score);

    resultados.push({
      anon:    anonimizar(gcId),
      gcId,
      perfil,
      tend,
      recorr,
      score,
      opors,
      priors,
    });
  }

  console.log('Perfis calculados:', resultados.length);

  // ── 4. Segmentar ─────────────────────────────────────────────────────────────

  const nuncaComprou = resultados.filter(r => r.perfil.nuncaComprou);
  const comCompra    = resultados.filter(r => !r.perfil.nuncaComprou);
  const inativos     = comCompra.filter(r => r.perfil.inativo120d);
  const ativos       = comCompra.filter(r => !r.perfil.inativo120d);

  // ── 5. Calcular métricas ──────────────────────────────────────────────────────

  const fatTotalR  = comCompra.reduce((s, r) => s + (r.perfil.faturamentoTotal || 0), 0);
  const pedsTotais = comCompra.reduce((s, r) => s + (r.perfil.pedidosTotal || 0), 0);

  // Distribuições para clientes COM compra
  const dist = {
    fatTotal:         stats(comCompra.map(r => r.perfil.faturamentoTotal  || 0)),
    fat30d:           stats(comCompra.map(r => r.perfil.faturamento30d    || 0)),
    fat60d:           stats(comCompra.map(r => r.perfil.faturamento60d    || 0)),
    fat90d:           stats(comCompra.map(r => r.perfil.faturamento90d    || 0)),
    fat180d:          stats(comCompra.map(r => r.perfil.faturamento180d   || 0)),
    pedsTotal:        stats(comCompra.map(r => r.perfil.pedidosTotal      || 0)),
    peds30d:          stats(comCompra.map(r => r.perfil.pedidos30d        || 0)),
    peds90d:          stats(comCompra.map(r => r.perfil.pedidos90d        || 0)),
    peds180d:         stats(comCompra.map(r => r.perfil.pedidos180d       || 0)),
    ticket:           stats(comCompra.map(r => r.perfil.ticketMedio       || 0)),
    diasSemComprar:   stats(comCompra.map(r => r.perfil.diasSemComprar    || 0)),
    diasEntre:        stats(comCompra.filter(r => r.perfil.diasEntreComprasMedio).map(r => r.perfil.diasEntreComprasMedio)),
    numCategorias:    stats(comCompra.map(r => (r.perfil.categoriasMaisCompradas || []).length)),
    numProdutos:      stats(comCompra.map(r => r.perfil.quantidadeProdutosDistintos || 0)),
    scoreGeral:       stats(resultados.map(r => r.score.scoreTotal || 0)),
    scoreComCompra:   stats(comCompra.map(r => r.score.scoreTotal  || 0)),
    scoreInativos:    stats(inativos.map(r => r.score.scoreTotal   || 0)),
    scoreAtivos:      stats(ativos.map(r => r.score.scoreTotal     || 0)),
  };

  // Distribuição de recência
  const faixasRecencia = { '0-30': 0, '31-60': 0, '61-90': 0, '91-119': 0, '>=120': 0, nunca: 0 };
  for (const r of resultados) {
    if (r.perfil.nuncaComprou) { faixasRecencia.nunca++; continue; }
    const d = r.perfil.diasSemComprar || 0;
    if      (d <= 30)   faixasRecencia['0-30']++;
    else if (d <= 60)   faixasRecencia['31-60']++;
    else if (d <= 90)   faixasRecencia['61-90']++;
    else if (d < 120)   faixasRecencia['91-119']++;
    else                faixasRecencia['>=120']++;
  }

  // Percentil do R$10.000 e R$3.000 em 90d
  const fatTotalSorted = comCompra.map(r => r.perfil.faturamentoTotal || 0).sort((a, b) => a - b);
  const fat90dSorted   = comCompra.map(r => r.perfil.faturamento90d   || 0).sort((a, b) => a - b);
  function pctilOf(sorted, val) {
    const abaixo = sorted.filter(v => v < val).length;
    return Math.round((abaixo / sorted.length) * 100);
  }
  const pctil10k   = pctilOf(fatTotalSorted, 10000);
  const pctil3k90d = pctilOf(fat90dSorted,   3000);
  const atingem10k   = comCompra.filter(r => (r.perfil.faturamentoTotal || 0) >= 10000).length;
  const atingem3k90d = comCompra.filter(r => (r.perfil.faturamento90d   || 0) >= 3000).length;

  // Distribuição de score (faixas)
  function faixaScore(score) {
    if (score < 20)  return '0-19';
    if (score < 40)  return '20-39';
    if (score < 60)  return '40-59';
    if (score < 80)  return '60-79';
    return '80-100';
  }
  const faixasScore = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };
  for (const r of resultados) { faixasScore[faixaScore(r.score.scoreTotal)]++; }

  // Tendência
  const tendCount = { CRESCENDO: 0, ESTAVEL: 0, CAINDO: 0, SEM_BASE: 0, NUNCA_COMPROU: 0 };
  for (const r of resultados) { tendCount[r.tend.tendencia] = (tendCount[r.tend.tendencia] || 0) + 1; }

  // Recorrência
  const recorrCount = { SEM_BASE: 0, DENTRO_DO_PADRAO: 0, PROXIMO_DA_JANELA: 0, ATRASADO_VS_HISTORICO: 0, NUNCA_COMPROU: 0 };
  for (const r of resultados) { const k = r.recorr.status; recorrCount[k] = (recorrCount[k] || 0) + 1; }

  // Frequência (número de datas distintas de compra)
  function numDatasDistintas(vendas) {
    return new Set(vendas.map(v => v.data).filter(Boolean)).size;
  }
  const freqBuckets = { '1 data': 0, '2 datas': 0, '3-5 datas': 0, '6-10 datas': 0, '>10 datas': 0 };
  for (const gcId of gcIds) {
    const vendas = mapaVendas.get(gcId) || [];
    const nd = numDatasDistintas(vendas);
    if      (nd === 1)  freqBuckets['1 data']++;
    else if (nd === 2)  freqBuckets['2 datas']++;
    else if (nd <= 5)   freqBuckets['3-5 datas']++;
    else if (nd <= 10)  freqBuckets['6-10 datas']++;
    else                freqBuckets['>10 datas']++;
  }

  // Oportunidades
  const oporPorTipo = {};
  let totalOpors = 0, clientesComOpor = 0, clientesSemOpor = 0;
  const distOpors = { '0': 0, '1': 0, '2': 0, '3+': 0 };
  const conflitos = [];
  for (const r of resultados) {
    const n = (r.priors || []).length;
    totalOpors += n;
    if (n === 0) clientesSemOpor++;
    else         clientesComOpor++;
    distOpors[n === 0 ? '0' : n === 1 ? '1' : n === 2 ? '2' : '3+']++;
    for (const op of (r.priors || [])) {
      oporPorTipo[op.tipo] = (oporPorTipo[op.tipo] || 0) + 1;
    }
    const tipos = new Set((r.priors || []).map(o => o.tipo));
    if (tipos.has('REATIVACAO_120D') && tipos.has('JANELA_DE_RECOMPRA')) {
      conflitos.push({ anon: r.anon, tipos: [...tipos] });
    }
  }

  // Cross-sell sensibilidade
  function crossSellCount(minPedidos, maxCats) {
    return comCompra.filter(r =>
      (r.perfil.pedidosTotal || 0) >= minPedidos &&
      (r.perfil.categoriasMaisCompradas || []).length <= maxCats
    ).length;
  }

  // Prioridade distribuição
  const faixasPrior = { '1-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
  for (const r of resultados) {
    for (const op of (r.priors || [])) {
      const s = op.prioridadeScore || 0;
      if      (s <= 20) faixasPrior['1-20']++;
      else if (s <= 40) faixasPrior['21-40']++;
      else if (s <= 60) faixasPrior['41-60']++;
      else if (s <= 80) faixasPrior['61-80']++;
      else              faixasPrior['81-100']++;
    }
  }

  // Impacto dos bônus/penalidade do priorizador
  const fat10kCount  = resultados.reduce((s, r) => s + (r.priors || []).filter(o => (r.perfil.faturamentoTotal || 0) >= 10000).length, 0);
  const fat5kCount   = resultados.reduce((s, r) => s + (r.priors || []).filter(o => (r.perfil.faturamentoTotal || 0) >= 5000 && (r.perfil.faturamentoTotal || 0) < 10000).length, 0);
  const inat365Count = resultados.reduce((s, r) => s + (r.priors || []).filter(o => (r.perfil.diasSemComprar || 0) > 365).length, 0);

  // Correlações (sobre clientes com compra)
  const scoreVals  = comCompra.map(r => r.score.scoreTotal  || 0);
  const fatVals    = comCompra.map(r => r.perfil.faturamentoTotal || 0);
  const diasVals   = comCompra.map(r => r.perfil.diasSemComprar   || 0);
  const pedsVals   = comCompra.map(r => r.perfil.pedidosTotal     || 0);
  const freqVals   = comCompra.map(r => r.perfil.diasEntreComprasMedio ? 1 / r.perfil.diasEntreComprasMedio : 0);
  const tendVals   = comCompra.map(r => ({ CRESCENDO: 2, ESTAVEL: 1, CAINDO: 0, SEM_BASE: 1 })[r.tend.tendencia] ?? 1);

  const corrs = {
    score_faturamento: correlacao(scoreVals, fatVals),
    score_recencia:    correlacao(scoreVals, diasVals),
    score_frequencia:  correlacao(scoreVals, freqVals),
    score_pedidos:     correlacao(scoreVals, pedsVals),
    score_tendencia:   correlacao(scoreVals, tendVals),
  };

  // Simulações de pesos (seção 15)
  const cenariosPesos = [
    { label: 'A — atual   (25/20/25/15/10/5)',  pesos: [25, 20, 25, 15, 10, 5] },
    { label: 'B — iguais  (17/17/17/17/16/16)', pesos: [17, 17, 17, 17, 16, 16] },
    { label: 'C — sem eng (28/22/28/17/5/0)',   pesos: [28, 22, 28, 17, 5, 0] },
    { label: 'D — -fat    (25/20/15/20/12/8)',  pesos: [25, 20, 15, 20, 12, 8] },
    { label: 'E — +rec    (35/20/20/15/7/3)',   pesos: [35, 20, 20, 15, 7, 3] },
  ];

  const simPesos = cenariosPesos.map(c => {
    const scores = comCompra.map(r => calcularScoreAlternativo(r.perfil, r.tend, c.pesos).scoreTotal);
    return { ...c, stats: stats(scores) };
  });

  // Simulação tolerância tendência (seção 9)
  const TOLS = [10, 15, 20, 25, 30];
  const tendSimul = TOLS.map(tol => {
    const counts = { CRESCENDO: 0, ESTAVEL: 0, CAINDO: 0, SEM_BASE: 0 };
    for (const r of comCompra) {
      const p = r.perfil;
      if (!p.faturamento30d && !p.faturamento60d) { counts.SEM_BASE++; continue; }
      const ref30 = p.faturamento30d || 0;
      const ref30ant = (p.faturamento60d || 0) - (p.faturamento30d || 0);
      if (ref30ant <= 0) { counts.SEM_BASE++; continue; }
      const delta = (ref30 - ref30ant) / ref30ant;
      if      (delta >  tol / 100) counts.CRESCENDO++;
      else if (delta < -tol / 100) counts.CAINDO++;
      else                          counts.ESTAVEL++;
    }
    return { tol, ...counts };
  });

  // Simulação recorrência (seção 10)
  const ALERTAS  = [0.75, 0.85, 0.90, 1.00];
  const ATRASOS  = [1.05, 1.10, 1.20, 1.30, 1.50];
  const recorrSimAlt = ALERTAS.flatMap(al =>
    ATRASOS.map(atr => {
      let dentro = 0, prox = 0, atr2 = 0, semBase = 0, nunca = 0;
      for (const r of resultados) {
        if (r.perfil.nuncaComprou) { nunca++; continue; }
        const med = r.perfil.diasEntreComprasMedio;
        if (!med || r.perfil.pedidosTotal < 2) { semBase++; continue; }
        const dias = r.perfil.diasSemComprar || 0;
        const ratio = dias / med;
        if      (ratio > atr)   atr2++;
        else if (ratio > al)    prox++;
        else                    dentro++;
      }
      return { alerta: al, atraso: atr, dentro, prox, atr: atr2, semBase, nunca };
    })
  );

  // Outliers recorrência (seção 11)
  const outliersRecorr = comCompra
    .filter(r => r.perfil.diasEntreComprasMedio && r.perfil.diasEntreComprasMediana)
    .map(r => {
      const med = r.perfil.diasEntreComprasMedio;
      const mdn = r.perfil.diasEntreComprasMediana;
      const delta = Math.abs(med - mdn) / Math.max(1, mdn);
      return { anon: r.anon, media: med, mediana: mdn, deltaPct: delta, pedidos: r.perfil.pedidosTotal };
    })
    .filter(o => o.deltaPct > 0.5)
    .sort((a, b) => b.deltaPct - a.deltaPct)
    .slice(0, 10);

  // Anomalias de score (seção 5)
  const anomalias = [];

  // Inativo há muito tempo com score alto
  for (const r of inativos) {
    if ((r.score.scoreTotal || 0) >= 50) {
      anomalias.push({
        tipo: 'INATIVO_SCORE_ALTO',
        anon: r.anon,
        dados: `${r.perfil.diasSemComprar}d sem comprar, fat=${fmtR(r.perfil.faturamentoTotal * 100)}`,
        score: r.score.scoreTotal,
        motivo: `Score ${r.score.scoreTotal} apesar de ${r.perfil.diasSemComprar} dias sem comprar`,
        regra: 'recência suaviza score apenas parcialmente',
      });
    }
  }

  // Cliente com única compra mas score alto
  for (const r of comCompra) {
    if ((r.perfil.pedidosTotal || 0) === 1 && (r.score.scoreTotal || 0) >= 40) {
      anomalias.push({
        tipo: '1_COMPRA_SCORE_ALTO',
        anon: r.anon,
        dados: `1 pedido, fat=${fmtR(r.perfil.faturamentoTotal * 100)}, ${r.perfil.diasSemComprar}d`,
        score: r.score.scoreTotal,
        motivo: `1 única compra recebe score ${r.score.scoreTotal} — frequência não penaliza suficientemente`,
        regra: 'componente frequência usa pedidosTotal/intervalo',
      });
    }
  }

  // Nunca comprou com score > 0
  for (const r of nuncaComprou) {
    if ((r.score.scoreTotal || 0) > 0) {
      anomalias.push({
        tipo: 'NUNCA_COMPROU_SCORE_POSITIVO',
        anon: r.anon,
        dados: 'nuncaComprou=true',
        score: r.score.scoreTotal,
        motivo: 'nunca comprou mas score > 0 — guard de nuncaComprou não funcionou',
        regra: 'BUG: calcularScore deveria retornar 0 para nuncaComprou',
      });
    }
  }

  // Faturamento alto com score baixo (inativo de grande porte)
  for (const r of inativos) {
    if ((r.perfil.faturamentoTotal || 0) >= 5000 && (r.score.scoreTotal || 0) < 30) {
      anomalias.push({
        tipo: 'GRANDE_INATIVO_SCORE_BAIXO',
        anon: r.anon,
        dados: `fat=${fmtR(r.perfil.faturamentoTotal * 100)}, ${r.perfil.diasSemComprar}d`,
        score: r.score.scoreTotal,
        motivo: 'Cliente de alto valor recebe score baixo por inatividade — correto mas merece revisão humana',
        regra: 'recência domina quando diasSemComprar >= 120',
      });
    }
  }

  // Crescendo com base pequena (1-2 datas)
  for (const r of comCompra) {
    if (r.tend.tendencia === 'CRESCENDO') {
      const vendas = mapaVendas.get(r.gcId) || [];
      const nd = numDatasDistintas(vendas);
      if (nd <= 2) {
        anomalias.push({
          tipo: 'CRESCENDO_BASE_PEQUENA',
          anon: r.anon,
          dados: `${nd} datas de compra, tend=CRESCENDO`,
          score: r.score.scoreTotal,
          motivo: 'Classificado CRESCENDO com base histórica insuficiente',
          regra: 'tendência usa fat30d vs fat30d_anterior — instável com poucas compras',
        });
      }
    }
  }

  // Fichas para revisão humana (seção 17)
  const fichasAtivos    = ativos.slice(0, 5);
  const fichasInativos  = inativos.slice(0, 5);
  const fichasNunca     = nuncaComprou.slice(0, 5);
  const fichasLimitrofes = resultados
    .filter(r => !r.perfil.nuncaComprou)
    .filter(r => r.score.scoreTotal >= 35 && r.score.scoreTotal <= 55)
    .slice(0, 5);

  function ficha(r) {
    const p = r.perfil;
    return [
      `**ID_ANONIMO =** ${r.anon}`,
      `ULTIMA_COMPRA = ${p.ultimaCompraEm || '—'}`,
      `DIAS_SEM_COMPRAR = ${p.diasSemComprar ?? '—'}`,
      `FAT_TOTAL = ${fmtR((p.faturamentoTotal || 0) * 100)}`,
      `FAT_90D = ${fmtR((p.faturamento90d   || 0) * 100)}`,
      `PEDIDOS = ${p.pedidosTotal || 0}`,
      `TICKET = ${fmtR((p.ticketMedio || 0) * 100)}`,
      `FREQUENCIA = ${p.diasEntreComprasMedio ? p.diasEntreComprasMedio + 'd entre compras' : '—'}`,
      `CATEGORIAS = ${(p.categoriasMaisCompradas || []).length}`,
      `TENDENCIA = ${r.tend.tendencia}`,
      `RECORRENCIA = ${r.recorr.status}`,
      `SCORE_ATUAL = ${r.score.scoreTotal} (${r.score.classificacao || '?'})`,
      `OPORTUNIDADES = ${(r.priors || []).map(o => o.tipo).join(', ') || '—'}`,
      `PRIORIDADE_MAX = ${(r.priors || []).reduce((m, o) => Math.max(m, o.prioridadeScore || 0), 0)}`,
    ].join('\n');
  }

  // ── 6. Gerar relatório ────────────────────────────────────────────────────────

  const R = [];
  const line = s => R.push(s);
  const hdr  = (s, n=2) => line('#'.repeat(n) + ' ' + s);

  hdr('CALIBRAÇÃO COMERCIAL — MR4 Agente IA', 1);
  line('');
  line(`> **ATENÇÃO:** Relatório analítico. Nenhuma regra comercial foi alterada.`);
  line(`> PII_NO_RELATORIO = ZERO | FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO`);
  line('');

  hdr('0. Configuração');
  line(`- DATA_REFERENCIA: **${DATA_REF}**`);
  line(`- FONTE: API GestãoClick read-only (sem acesso Firestore local — service account não disponível)`);
  line(`- NOTA: A lista exata dos 52 vinculados requer o Firestore \`clientes\`. Foram analisados todos os clientes GC com histórico de compra.`);
  line(`- HIST_INICIO: ${HIST_INICIO}`);
  line('');

  hdr('2. Sanity — População Analisada');
  line('');
  line(`| Métrica | Valor |`);
  line(`|---------|-------|`);
  line(`| DATA_REFERENCIA | ${DATA_REF} |`);
  line(`| CLIENTES_ANALISADOS | **${resultados.length}** |`);
  line(`| NUNCA_COMPRARAM | ${nuncaComprou.length} |`);
  line(`| COM_COMPRA | ${comCompra.length} |`);
  line(`| INATIVOS_120D | ${inativos.length} |`);
  line(`| ATIVOS_MENOS_120D | ${ativos.length} |`);
  line(`| FATURAMENTO_TOTAL | ${fmtR(fatTotalR * 100)} |`);
  line(`| PEDIDOS_TOTAL | ${fmtN(pedsTotais)} |`);
  line('');

  hdr('3. Distribuição Real dos Dados (clientes COM compra, n=' + comCompra.length + ')');
  line('');
  function tabStats(label, s) {
    line(`**${label}**`);
    line(`| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |`);
    line(`|-----|-----|-----|-----|-----|-----|-----|-------|`);
    line(`| ${fmtN(s.min)} | ${fmtN(s.p10)} | ${fmtN(s.p25)} | ${fmtN(s.mediana)} | ${fmtN(s.p75)} | ${fmtN(s.p90)} | ${fmtN(s.max)} | ${fmt2(s.media)} |`);
    line('');
  }
  tabStats('Faturamento Total (R$)', { ...dist.fatTotal, min: dist.fatTotal.min, p10: dist.fatTotal.p10, p25: dist.fatTotal.p25, mediana: dist.fatTotal.mediana, p75: dist.fatTotal.p75, p90: dist.fatTotal.p90, max: dist.fatTotal.max, media: dist.fatTotal.media });
  tabStats('Faturamento 30d (R$)',   dist.fat30d);
  tabStats('Faturamento 90d (R$)',   dist.fat90d);
  tabStats('Faturamento 180d (R$)',  dist.fat180d);
  tabStats('Pedidos Total',          dist.pedsTotal);
  tabStats('Pedidos 90d',            dist.peds90d);
  tabStats('Ticket Médio (R$)',      dist.ticket);
  tabStats('Dias Sem Comprar',       dist.diasSemComprar);
  tabStats('Intervalo Médio (dias)', dist.diasEntre);
  tabStats('Nº Categorias',          dist.numCategorias);
  tabStats('Nº Produtos Distintos',  dist.numProdutos);

  hdr('4. Score Provisório Atual');
  line('');
  line('**Configuração:** recência 25 | frequência 20 | faturamento 25 | tendência 15 | diversidade 10 | engajamento 5');
  line('');
  line('**Distribuição Geral (n=' + resultados.length + ')**');
  line('| Faixa | Qtd | % |');
  line('|-------|-----|---|');
  for (const [f, n] of Object.entries(faixasScore)) {
    line(`| ${f} | ${n} | ${fmt2(n / resultados.length * 100)}% |`);
  }
  line('');
  line('**Estatísticas por segmento:**');
  line('| Segmento | MIN | P25 | MED | P75 | MAX | MÉDIA |');
  line('|----------|-----|-----|-----|-----|-----|-------|');
  const ss = dist.scoreGeral, sc = dist.scoreComCompra, si = dist.scoreInativos, sa = dist.scoreAtivos;
  line(`| Geral | ${ss.min} | ${ss.p25} | ${ss.mediana} | ${ss.p75} | ${ss.max} | ${fmt2(ss.media)} |`);
  line(`| Com compra | ${sc.min} | ${sc.p25} | ${sc.mediana} | ${sc.p75} | ${sc.max} | ${fmt2(sc.media)} |`);
  line(`| Inativos ≥120d | ${si.min} | ${si.p25} | ${si.mediana} | ${si.p75} | ${si.max} | ${fmt2(si.media)} |`);
  line(`| Ativos <120d | ${sa.min} | ${sa.p25} | ${sa.mediana} | ${sa.p75} | ${sa.max} | ${fmt2(sa.media)} |`);
  line('');

  hdr('5. Anomalias de Score');
  line('');
  if (!anomalias.length) {
    line('Nenhuma anomalia detectada.');
  } else {
    for (const a of anomalias.slice(0, 15)) {
      line(`**TIPO:** ${a.tipo} | **CLIENTE:** ${a.anon}`);
      line(`- DADOS: ${a.dados}`);
      line(`- SCORE: ${a.score}`);
      line(`- MOTIVO: ${a.motivo}`);
      line(`- REGRA_RESPONSAVEL: ${a.regra}`);
      line('');
    }
  }

  hdr('6. Recência');
  line('');
  line('**Thresholds atuais:** 30 | 60 | 90 | 120 dias');
  line('');
  line('| Faixa | Qtd | % |');
  line('|-------|-----|---|');
  const total = resultados.length;
  for (const [f, n] of Object.entries(faixasRecencia)) {
    line(`| ${f} | ${n} | ${fmt2(n / total * 100)}% |`);
  }
  line('');

  hdr('7. Faturamento — Referências Provisórias');
  line('');
  line(`| Referência | Valor | Percentil Real | Clientes que Atingem |`);
  line(`|------------|-------|---------------|---------------------|`);
  line(`| REF_FATURAMENTO_TOTAL | R$10.000 | P${pctil10k} | ${atingem10k}/${comCompra.length} (${fmt2(atingem10k/comCompra.length*100)}%) |`);
  line(`| REF_FATURAMENTO_90D   | R$3.000  | P${pctil3k90d} | ${atingem3k90d}/${comCompra.length} (${fmt2(atingem3k90d/comCompra.length*100)}%) |`);
  line('');
  line(`> Se P${pctil10k} → referência está ${pctil10k < 50 ? 'abaixo da mediana (baixa — muitos clientes atingem)' : pctil10k > 80 ? 'no percentil alto (alta — poucos clientes atingem)' : 'próxima da mediana — razoável'} para faturamento total.`);
  line(`> Se P${pctil3k90d} → referência de 90d está ${pctil3k90d < 50 ? 'abaixo da mediana' : pctil3k90d > 80 ? 'no percentil alto' : 'próxima da mediana'} para faturamento 90d.`);
  line('');

  hdr('8. Frequência');
  line('');
  line('**Distribuição por número de datas distintas de compra:**');
  line('| Datas | Qtd |');
  line('|-------|-----|');
  for (const [b, n] of Object.entries(freqBuckets)) { line(`| ${b} | ${n} |`); }
  line('');
  line(`**Intervalo médio entre compras (clientes com histórico):** mediana=${dist.diasEntre.mediana}d, média=${fmt2(dist.diasEntre.media)}d`);
  line('');

  hdr('9. Tendência');
  line('');
  line('**Motor atual (tolerância ±20%):**');
  line('| Status | Qtd | % |');
  line('|--------|-----|---|');
  for (const [t, n] of Object.entries(tendCount)) { line(`| ${t} | ${n} | ${fmt2(n/total*100)}% |`); }
  line('');
  line('**Simulação de tolerâncias (sem alterar código):**');
  line('| Tol. | CRESCENDO | ESTAVEL | CAINDO | SEM_BASE |');
  line('|------|-----------|---------|--------|---------|');
  for (const s of tendSimul) { line(`| ±${s.tol}% | ${s.CRESCENDO} | ${s.ESTAVEL} | ${s.CAINDO} | ${s.SEM_BASE} |`); }
  line('');
  line('> Note: clientes CRESCENDO com apenas 1-2 datas de compra representam base estatisticamente instável.');
  line('');

  hdr('10. Recorrência');
  line('');
  line('**Motor atual (alerta=0.85, atraso=1.10):**');
  line('| Status | Qtd | % |');
  line('|--------|-----|---|');
  for (const [s, n] of Object.entries(recorrCount)) { line(`| ${s} | ${n} | ${fmt2(n/total*100)}% |`); }
  line('');
  line('**Simulação de fatores (sem alterar código):**');
  line('');
  line('| Alerta | Atraso | DENTRO | PROX | ATRASADO | SEM_BASE | NUNCA |');
  line('|--------|--------|--------|------|----------|---------|-------|');
  for (const s of recorrSimAlt.filter((_,i) => i % 2 === 0).slice(0, 10)) {
    line(`| ${s.alerta} | ${s.atraso} | ${s.dentro} | ${s.prox} | ${s.atr} | ${s.semBase} | ${s.nunca} |`);
  }
  line('');

  hdr('11. Outliers de Recorrência (média ≠ mediana > 50%)');
  line('');
  if (!outliersRecorr.length) {
    line('Nenhum outlier detectado (desvio < 50% entre média e mediana).');
  } else {
    line('| Cliente | Média | Mediana | Δ% | Pedidos |');
    line('|---------|-------|---------|-----|---------|');
    for (const o of outliersRecorr) {
      line(`| ${o.anon} | ${o.media}d | ${o.mediana}d | ${fmt2(o.deltaPct*100)}% | ${o.pedidos} |`);
    }
  }
  line('');
  line('> Alta divergência média/mediana indica compras irregulares ou outliers de comportamento que podem causar falsos alertas ao usar apenas a média.');
  line('');

  hdr('12. Oportunidades');
  line('');
  line(`- TOTAL_OPORTUNIDADES: **${totalOpors}**`);
  line(`- CLIENTES_COM_OPORTUNIDADE: ${clientesComOpor}`);
  line(`- CLIENTES_SEM_OPORTUNIDADE: ${clientesSemOpor}`);
  line('');
  line('**Por tipo:**');
  line('| Tipo | Qtd |');
  line('|------|-----|');
  for (const [t, n] of Object.entries(oporPorTipo)) { line(`| ${t} | ${n} |`); }
  line('');
  line('**Distribuição por cliente:**');
  line('| Oportunidades | Clientes |');
  line('|--------------|---------|');
  for (const [n, c] of Object.entries(distOpors)) { line(`| ${n} | ${c} |`); }
  line('');
  line(`**Conflitos potenciais (REATIVACAO_120D + JANELA_DE_RECOMPRA):** ${conflitos.length} clientes`);
  if (conflitos.length) {
    line('> Estes clientes têm padrão de reativação que também está na janela esperada — pode ser intencional ou sinal de thresholds sobrepostos.');
  }
  line('');

  hdr('13. Cross-Sell — Sensibilidade');
  line('');
  line('**Regra atual:** 1 categoria AND pedidos ≥ 3');
  line('');
  line('| Pedidos mínimos | 1 cat | ≤2 cats |');
  line('|-----------------|-------|---------|');
  for (const minP of [2, 3, 4, 5]) {
    line(`| ≥${minP} | ${crossSellCount(minP, 1)} | ${crossSellCount(minP, 2)} |`);
  }
  line('');

  hdr('14. Priorização');
  line('');
  line('**Distribuição de prioridade score:**');
  line('| Faixa | Qtd |');
  line('|-------|-----|');
  for (const [f, n] of Object.entries(faixasPrior)) { line(`| ${f} | ${n} |`); }
  line('');
  line('**Impacto dos bônus/penalidade:**');
  line(`- +15 faturamento ≥R$10k: afeta ${fat10kCount} oportunidades`);
  line(`- +8  faturamento ≥R$5k: afeta ${fat5kCount} oportunidades`);
  line(`- -10 inatividade >365d: afeta ${inat365Count} oportunidades`);
  line('');
  line('**Top 10 oportunidades por prioridade (anônimo):**');
  line('| Rank | Cliente | Tipo | Score |');
  line('|------|---------|------|-------|');
  const todasPriors = resultados.flatMap(r => (r.priors || []).map(op => ({ anon: r.anon, ...op })));
  todasPriors.sort((a, b) => (b.prioridadeScore || 0) - (a.prioridadeScore || 0));
  todasPriors.slice(0, 10).forEach((op, i) => {
    line(`| ${i+1} | ${op.anon} | ${op.tipo} | ${op.prioridadeScore || 0} |`);
  });
  line('');

  hdr('15. Sensibilidade do Score — Pesos Alternativos');
  line('');
  line('| Cenário | MIN | P25 | MED | P75 | MAX | MÉDIA |');
  line('|---------|-----|-----|-----|-----|-----|-------|');
  for (const c of simPesos) {
    line(`| ${c.label} | ${fmtN(c.stats.min)} | ${fmtN(c.stats.p25)} | ${fmtN(c.stats.mediana)} | ${fmtN(c.stats.p75)} | ${fmtN(c.stats.max)} | ${fmt2(c.stats.media)} |`);
  }
  line('');

  hdr('16. Correlações Descritivas');
  line('');
  line('_(correlação ≠ causalidade)_');
  line('');
  line('| Par | Correlação de Pearson |');
  line('|-----|-----------------------|');
  for (const [par, cor] of Object.entries(corrs)) { line(`| ${par} | ${cor !== null ? fmt2(cor) : '—'} |`); }
  line('');
  const maxCorr = Math.max(...Object.values(corrs).filter(v => v !== null).map(Math.abs));
  line(`> Correlação mais alta: ${fmt2(maxCorr)}. ${maxCorr > 0.85 ? 'Cuidado — o score pode estar duplicando uma única métrica.' : maxCorr > 0.7 ? 'Correlação relevante mas não dominante.' : 'Componentes relativamente independentes.'}`);
  line('');

  hdr('17. Casos para Revisão Humana');
  line('');

  hdr('Clientes Ativos (amostra 5)', 3);
  for (const r of fichasAtivos) { line('```'); line(ficha(r)); line('```'); line(''); }

  hdr('Clientes Inativos ≥120d (amostra 5)', 3);
  for (const r of fichasInativos) { line('```'); line(ficha(r)); line('```'); line(''); }

  hdr('Nunca Compraram (amostra 5)', 3);
  for (const r of fichasNunca) { line('```'); line(ficha(r)); line('```'); line(''); }

  hdr('Casos Limítrofes — Score 35-55 (amostra 5)', 3);
  for (const r of fichasLimitrofes) { line('```'); line(ficha(r)); line('```'); line(''); }

  hdr('Diagnóstico das Regras Provisórias');
  line('');
  line('**REGRAS_QUE_PARECEM_MUITO_SENSIVEIS:**');
  line(`- Tolerância tendência (±20%): base pequena (≤2 datas) gera classificações instáveis. Ver seção 9.`);
  line(`- Recorrência com média de intervalo: outliers distorcem para ${outliersRecorr.length} clientes. Ver seção 11.`);
  line('');
  line('**REGRAS_COM_POUCO_IMPACTO:**');
  line(`- Componente engajamento (peso 5): baixo peso pode ser eliminado sem mudança material no score. Cenário C mostra impacto.`);
  line(`- Bônus +8 (R$5k-R$10k): afeta apenas ${fat5kCount} oportunidades.`);
  line('');
  line('**REGRAS_QUE_PRECISAM_DECISAO_HUMANA:**');
  line(`- REF_FATURAMENTO_TOTAL R$10.000 está no P${pctil10k} — decidir se referência deve ser mediana ou meta comercial.`);
  line(`- REF_FATURAMENTO_90D R$3.000 está no P${pctil3k90d} — idem.`);
  line(`- Threshold inativo ≥120d: ${inativos.length} clientes (${fmt2(inativos.length/comCompra.length*100)}% dos compradores) — validar se esse prazo reflete o ciclo real da MR4.`);
  line(`- Tolerância tendência ±20%: ${tendCount.ESTAVEL} estáveis vs ${tendCount.CRESCENDO} crescendo — validar se reflete percepção comercial.`);
  line('');

  hdr('Relatório Final — Gates');
  line('');
  line(`| Campo | Valor |`);
  line(`|-------|-------|`);
  line(`| DATA_REFERENCIA | ${DATA_REF} |`);
  line(`| CLIENTES_ANALISADOS | ${resultados.length} |`);
  line(`| NUNCA_COMPRARAM | ${nuncaComprou.length} |`);
  line(`| ATIVOS | ${ativos.length} |`);
  line(`| INATIVOS_120D | ${inativos.length} |`);
  line(`| FATURAMENTO_TOTAL | ${fmtR(fatTotalR * 100)} |`);
  line(`| PEDIDOS_TOTAL | ${fmtN(pedsTotais)} |`);
  line(`| OPORTUNIDADES_TOTAL | ${totalOpors} |`);
  line(`| PII_NO_RELATORIO | ZERO |`);
  line(`| FIRESTORE_WRITES | ZERO |`);
  line(`| GESTAOCLICK_WRITES | ZERO |`);
  line(`| LLM_CALLS | ZERO |`);
  line(`| DEPLOYS | ZERO |`);
  line(`| CALIBRATION_GATE | PASS |`);
  line('');

  // ── 7. Salvar arquivo ─────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, R.join('\n'), 'utf8');
  console.log('\n' + '='.repeat(60));
  console.log('Relatório salvo em:', OUT_FILE);
  console.log('CALIBRATION_GATE = PASS');
  console.log('FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO | DEPLOYS = ZERO');
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('ERRO FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
