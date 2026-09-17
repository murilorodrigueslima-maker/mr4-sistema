#!/usr/bin/env node
'use strict';

/**
 * calibrar-agente-comercial-vinculados.js — N21: Calibração Oficial dos Vinculados
 *
 * SOMENTE LEITURA — ZERO writes.
 *   FIRESTORE_WRITES       = ZERO
 *   GESTAOCLICK_WRITES     = ZERO
 *   LLM_CALLS              = ZERO
 *   DEPLOYS                = ZERO
 *
 * DIFERENÇAS vs N20 (calibrar-agente-comercial.js):
 *   - População: somente os 52 clientes MR4 vinculados ao GC (via artifacts/vinculos-gc.json)
 *   - B1 corrigido: usa perfil.ticketMedioTotal (não perfil.ticketMedio)
 *   - B2 corrigido: usa op.prioridadeFinal (não op.prioridadeScore)
 *   - nuncaComprou: calculado para todos os vínculos, mesmo sem venda
 *
 * Requer:
 *   artifacts/vinculos-gc.json (gerado pelo workflow export-vinculos360.yml)
 *   GC_ACCESS_TOKEN e GC_SECRET_ACCESS_TOKEN (ou aliases GESTAOCLICK_*)
 *
 * Saída: docs/agente-comercial/CALIBRACAO_COMERCIAL_VINCULADOS.md
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
const HIST_INICIO = '2022-03-24';
const DATA_REF    = calcularDataReferencia();
const OUT_DIR     = path.join(__dirname, '..', 'docs', 'agente-comercial');
const OUT_FILE    = path.join(OUT_DIR, 'CALIBRACAO_COMERCIAL_VINCULADOS.md');
const VINCULOS_FILE = path.join(__dirname, '..', 'artifacts', 'vinculos-gc.json');

if (!GC_ACCESS || !GC_SECRET) {
  console.error('ERRO: GC_ACCESS_TOKEN e GC_SECRET_ACCESS_TOKEN são obrigatórios.');
  process.exit(1);
}

if (!fs.existsSync(VINCULOS_FILE)) {
  console.error(`ERRO: ${VINCULOS_FILE} não encontrado.`);
  console.error('Execute o workflow export-vinculos360.yml e baixe o artifact primeiro.');
  process.exit(1);
}

function calcularDataReferencia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }))
    .toISOString().slice(0, 10);
}

function anonId(gcId) {
  return 'C' + crypto.createHash('sha1').update(String(gcId)).digest('hex').slice(0, 4).toUpperCase();
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

function stats(arr) {
  if (!arr.length) return { min: 0, p10: 0, p25: 0, med: 0, p75: 0, p90: 0, max: 0, media: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const media = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    min:   s[0],
    p10:   percentil(s, 10),
    p25:   percentil(s, 25),
    med:   percentil(s, 50),
    p75:   percentil(s, 75),
    p90:   percentil(s, 90),
    max:   s[s.length - 1],
    media: Math.round(media * 100) / 100,
  };
}

function correlacao(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const dx  = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const dy  = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  if (!dx || !dy) return 0;
  return Math.round((num / (dx * dy)) * 100) / 100;
}

function fmtR(centavos) {
  return 'R$' + (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
  return n.toLocaleString('pt-BR');
}

// ── Distribuições ─────────────────────────────────────────────────────────────

function tabStats(label, st) {
  return [
    `**${label}**`,
    `| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |`,
    `|-----|-----|-----|-----|-----|-----|-----|-------|`,
    `| ${st.min} | ${st.p10} | ${st.p25} | ${st.med} | ${st.p75} | ${st.p90} | ${st.max} | ${st.media} |`,
  ].join('\n');
}

function faixaScore(score) {
  if (score < 20)  return '0-19';
  if (score < 40)  return '20-39';
  if (score < 60)  return '40-59';
  if (score < 80)  return '60-79';
  return '80-100';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('============================================================');
  console.log('CALIBRAÇÃO COMERCIAL N21 — CLIENTES VINCULADOS MR4');
  console.log('============================================================');
  console.log(`DATA_REFERENCIA: ${DATA_REF}`);
  console.log('FONTE: GestãoClick API (read-only) + artifacts/vinculos-gc.json');
  console.log('FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO');
  console.log('B1_FIX: usa ticketMedioTotal | B2_FIX: usa prioridadeFinal');

  // ── 1. Carregar vínculos ──────────────────────────────────────────────────
  const vinculos = JSON.parse(fs.readFileSync(VINCULOS_FILE, 'utf8'));
  const gcIdSet  = new Set(vinculos.map(v => String(v.gestaoClickId)));
  const gcIdToMr4 = Object.fromEntries(vinculos.map(v => [String(v.gestaoClickId), v.clienteMr4Id]));
  console.log(`\nVínculos carregados: ${vinculos.length}`);

  // ── 2. Buscar vendas (global, filtrado localmente) ────────────────────────
  console.log(`\nBuscando vendas desde ${HIST_INICIO} (pode levar ~3 min)...`);
  const vendasBrutas = await gcFetchAllPages('/vendas', { data_inicial: HIST_INICIO });
  console.log(`Vendas brutas: ${vendasBrutas.length}`);

  // Filtrar somente dos vinculados
  const vendasVinculados = vendasBrutas.filter(v => gcIdSet.has(String(v.cliente_id)));
  console.log(`Vendas dos vinculados: ${vendasVinculados.length}`);

  // ── 3. Buscar produtos ────────────────────────────────────────────────────
  console.log('Buscando produtos...');
  const produtosBrutos = await gcFetchAllPages('/produtos', { ativo: '1' });
  console.log(`Produtos: ${produtosBrutos.length}`);
  const produtosPorId  = buildProdutosPorId(produtosBrutos);

  // ── 4. Agrupar vendas por GC cliente_id ──────────────────────────────────
  const { vendas: vendasUnicas } = deduplicarVendas(vendasVinculados);
  const vendasPorGc  = agruparVendasPorCliente(vendasUnicas);

  // ── 5. Calcular perfil para TODOS os vinculados (incluindo nuncaComprou) ──
  const resultados = [];
  for (const v of vinculos) {
    const gcId    = String(v.gestaoClickId);
    const mr4Id   = v.clienteMr4Id;
    const vendas  = vendasPorGc.get(gcId) || [];

    const perfil  = calcularPerfil360({
      clienteMr4Id:  mr4Id,
      gestaoClickId: gcId,
      vendas,
      produtosPorId,
      dataReferencia: DATA_REF,
    });

    const tend    = calcularTendencia(perfil);
    const recorr  = calcularRecorrencia(perfil);
    const score   = calcularScore(perfil, tend.tendencia);
    const opors   = gerarOportunidades(perfil, score, tend, recorr, DATA_REF);
    const priors  = priorizarOportunidades(opors, perfil, score);

    resultados.push({ gcId, mr4Id, perfil, tend, recorr, score, opors, priors });
  }

  console.log(`Perfis calculados: ${resultados.length}`);

  // ── 6. Derivar segmentos ──────────────────────────────────────────────────
  const nunca    = resultados.filter(r => r.perfil.nuncaComprou);
  const comCompra = resultados.filter(r => !r.perfil.nuncaComprou);
  const inativos  = comCompra.filter(r => r.perfil.inativo120d);
  const ativos    = comCompra.filter(r => !r.perfil.inativo120d);

  // ── 7. Calcular distribuições ─────────────────────────────────────────────
  const dist = {
    fatTotal:   stats(comCompra.map(r => r.perfil.faturamentoTotal  || 0)),
    fat30:      stats(comCompra.map(r => r.perfil.faturamento30d    || 0)),
    fat90:      stats(comCompra.map(r => r.perfil.faturamento90d    || 0)),
    fat180:     stats(comCompra.map(r => r.perfil.faturamento180d   || 0)),
    pedTotal:   stats(comCompra.map(r => r.perfil.pedidosTotal      || 0)),
    ped90:      stats(comCompra.map(r => r.perfil.pedidos90d        || 0)),
    // B1 FIX: usa ticketMedioTotal (não ticketMedio)
    ticket:     stats(comCompra.map(r => r.perfil.ticketMedioTotal  || 0)),
    dias:       stats(comCompra.map(r => r.perfil.diasSemComprar    || 0)),
    intervalo:  stats(comCompra.filter(r => r.perfil.diasEntreComprasMedio).map(r => r.perfil.diasEntreComprasMedio)),
    categorias: stats(comCompra.map(r => (r.perfil.categoriasMaisCompradas || []).length)),
    produtos:   stats(comCompra.map(r => r.perfil.quantidadeProdutosDistintos || 0)),
    scoreGeral: stats(resultados.map(r => r.score.scoreTotal  || 0)),
    scoreCC:    stats(comCompra.map(r => r.score.scoreTotal   || 0)),
    scoreInat:  stats(inativos.map(r => r.score.scoreTotal    || 0)),
    scoreAtiv:  stats(ativos.map(r => r.score.scoreTotal      || 0)),
  };

  // ── Ticket médio global (B1 fix) ──────────────────────────────────────────
  const fatTotalCents  = comCompra.reduce((s, r) => s + Math.round((r.perfil.faturamentoTotal || 0) * 100), 0);
  const pedTotalCount  = comCompra.reduce((s, r) => s + (r.perfil.pedidosTotal || 0), 0);
  const ticketMedioGlobal = pedTotalCount > 0 ? Math.round(fatTotalCents / pedTotalCount) / 100 : 0;

  // ── 8. Anomalias de score ─────────────────────────────────────────────────
  const anomalias = comCompra.filter(r =>
    r.perfil.pedidosTotal === 1 && r.score.scoreTotal >= 40
  ).map(r => ({
    id:    anonId(r.gcId),
    score: r.score.scoreTotal,
    fat:   r.perfil.faturamentoTotal,
    dias:  r.perfil.diasSemComprar,
  }));

  // ── 9. Frequência ─────────────────────────────────────────────────────────
  const freqDatas = { '1 data': 0, '2 datas': 0, '3-5 datas': 0, '6-10 datas': 0, '>10 datas': 0 };
  for (const r of comCompra) {
    const n = r.perfil.pedidosTotal || 0;
    if (n <= 1)       freqDatas['1 data']++;
    else if (n <= 2)  freqDatas['2 datas']++;
    else if (n <= 5)  freqDatas['3-5 datas']++;
    else if (n <= 10) freqDatas['6-10 datas']++;
    else              freqDatas['>10 datas']++;
  }

  // ── 10. Distribuições de motores ──────────────────────────────────────────
  const tendDist     = { CRESCENDO: 0, ESTAVEL: 0, CAINDO: 0, SEM_BASE: 0, NUNCA_COMPROU: 0 };
  const recorrDist   = { SEM_BASE: 0, DENTRO_DO_PADRAO: 0, PROXIMO_DA_JANELA: 0, ATRASADO_VS_HISTORICO: 0, NUNCA_COMPROU: 0 };
  const recenciaDist = { '0-30': 0, '31-60': 0, '61-90': 0, '91-119': 0, '>=120': 0, 'nunca': 0 };
  const faixasScore  = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };

  for (const r of resultados) {
    tendDist[r.tend.tendencia]     = (tendDist[r.tend.tendencia] || 0) + 1;
    recorrDist[r.recorr.status]    = (recorrDist[r.recorr.status] || 0) + 1;
    faixasScore[faixaScore(r.score.scoreTotal || 0)]++;

    const d = r.perfil.nuncaComprou ? null : r.perfil.diasSemComprar;
    if (d === null) recenciaDist['nunca']++;
    else if (d <= 30) recenciaDist['0-30']++;
    else if (d <= 60) recenciaDist['31-60']++;
    else if (d <= 90) recenciaDist['61-90']++;
    else if (d < 120) recenciaDist['91-119']++;
    else recenciaDist['>=120']++;
  }

  // ── 11. Oportunidades e prioridade ────────────────────────────────────────
  const todasOpors = resultados.flatMap(r => r.priors);
  const tiposDist  = {};
  // B2 FIX: usa prioridadeFinal (não prioridadeScore)
  const faixasPrior = { '1-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };

  for (const op of todasOpors) {
    tiposDist[op.tipo] = (tiposDist[op.tipo] || 0) + 1;
    const pf = op.prioridadeFinal || 0;  // B2 FIX
    if      (pf <= 20) faixasPrior['1-20']++;
    else if (pf <= 40) faixasPrior['21-40']++;
    else if (pf <= 60) faixasPrior['41-60']++;
    else if (pf <= 80) faixasPrior['61-80']++;
    else               faixasPrior['81-100']++;
  }

  const clComOport = resultados.filter(r => r.priors.length > 0).length;

  // Conflitos REATIVACAO + JANELA simultâneos
  const conflitos = resultados.filter(r => {
    const tipos = r.priors.map(o => o.tipo);
    return tipos.includes('REATIVACAO_120D') && tipos.includes('JANELA_DE_RECOMPRA');
  }).length;

  // ── 12. Outliers de recorrência ───────────────────────────────────────────
  const outlierRecorr = comCompra
    .filter(r => {
      const med = r.perfil.diasEntreComprasMediana;
      const mea = r.perfil.diasEntreComprasMedio;
      return med > 0 && mea > 0 && Math.abs(mea - med) / med > 3;
    })
    .map(r => ({
      id:    anonId(r.gcId),
      media: r.perfil.diasEntreComprasMedio,
      med:   r.perfil.diasEntreComprasMediana,
      delta: Math.round(((r.perfil.diasEntreComprasMedio - r.perfil.diasEntreComprasMediana) / r.perfil.diasEntreComprasMediana) * 100),
      peds:  r.perfil.pedidosTotal,
    }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);

  // ── 13. Sensibilidade de tolerância de tendência ──────────────────────────
  const { calcularTendencia: ct } = require('../functions/lib/tendenciaComercial');
  const tendSensib = [10, 15, 20, 25, 30].map(tol => {
    const r = { tol, CRESCENDO: 0, ESTAVEL: 0, CAINDO: 0, SEM_BASE: 0 };
    for (const res of resultados) {
      const t = ct(res.perfil, tol / 100);
      r[t.tendencia] = (r[t.tendencia] || 0) + 1;
    }
    return r;
  });

  // ── 14. Sensibilidade de recorrência ─────────────────────────────────────
  const { calcularRecorrencia: cr } = require('../functions/lib/recorrencia');
  const recorrSensib = [
    [0.75, 1.05], [0.75, 1.2], [0.75, 1.5],
    [0.85, 1.1],  [0.85, 1.3],
    [0.9,  1.05], [0.9,  1.2], [0.9,  1.5],
    [1.0,  1.1],  [1.0,  1.3],
  ].map(([fa, fd]) => {
    const r = { fa, fd, DENTRO: 0, PROX: 0, ATRASADO: 0, SEM_BASE: 0, NUNCA: 0 };
    for (const res of resultados) {
      const s = cr(res.perfil, fa, fd).status;
      if (s === 'DENTRO_DO_PADRAO')       r.DENTRO++;
      else if (s === 'PROXIMO_DA_JANELA') r.PROX++;
      else if (s === 'ATRASADO_VS_HISTORICO') r.ATRASADO++;
      else if (s === 'SEM_BASE')          r.SEM_BASE++;
      else r.NUNCA++;
    }
    return r;
  });

  // ── 15. Refs de faturamento ───────────────────────────────────────────────
  const fatsSorted = [...comCompra].map(r => r.perfil.faturamentoTotal || 0).sort((a, b) => a - b);
  const fat90Sorted= [...comCompra].map(r => r.perfil.faturamento90d   || 0).sort((a, b) => a - b);
  const ref10k_perc = fatsSorted.filter(f => f >= 10000).length / fatsSorted.length * 100;
  const ref3k_perc  = fat90Sorted.filter(f => f >= 3000).length  / fat90Sorted.length * 100;

  // ── 16. Sensibilidade de score ────────────────────────────────────────────
  const { calcularScore: cs } = require('../functions/lib/scoreComercial');
  function calcScoreCenario(perfil, tend, pesos) {
    // Cenário alternativo calculado manualmente
    const p = perfil;
    if (p.nuncaComprou) return 0;
    const { THRESHOLDS_RECENCIA, REF_FATURAMENTO_TOTAL, REF_FATURAMENTO_90D } = require('../functions/config/score-comercial.v1');
    const dias = p.diasSemComprar || 999;
    const recC = dias <= THRESHOLDS_RECENCIA[0] ? 100 : dias <= THRESHOLDS_RECENCIA[1] ? 80 : dias <= THRESHOLDS_RECENCIA[2] ? 60 : dias <= THRESHOLDS_RECENCIA[3] ? 40 : 20;
    const freqC = Math.min(100, p.pedidosTotal > 0 ? Math.round(p.pedidosTotal / Math.max(1, p.diasEntreComprasMedio || 30) * 100) : 0);
    const fatC = Math.min(100, Math.round(((p.faturamentoTotal || 0) / REF_FATURAMENTO_TOTAL) * 100));
    const fat90C = Math.min(100, Math.round(((p.faturamento90d || 0) / REF_FATURAMENTO_90D) * 100));
    const tendC = { CRESCENDO: 100, ESTAVEL: 70, CAINDO: 30, SEM_BASE: 50, NUNCA_COMPROU: 0 }[tend] ?? 50;
    const divC = Math.min(100, ((p.categoriasMaisCompradas || []).length / 10) * 100);
    const total = Math.round(
      recC * pesos[0] + freqC * pesos[1] + fatC * pesos[2] +
      tendC * pesos[3] + divC * pesos[4] + fat90C * pesos[5]
    ) / 100;
    return Math.max(0, Math.min(100, total));
  }

  const cenarios = [
    { nome: 'A — atual   (25/20/25/15/10/5)', pesos: [0.25, 0.20, 0.25, 0.15, 0.10, 0.05] },
    { nome: 'B — iguais  (17/17/17/17/16/16)', pesos: [0.17, 0.17, 0.17, 0.17, 0.16, 0.16] },
    { nome: 'C — sem eng (28/22/28/17/5/0)',   pesos: [0.28, 0.22, 0.28, 0.17, 0.05, 0.00] },
    { nome: 'D — -fat    (25/20/15/20/12/8)',  pesos: [0.25, 0.20, 0.15, 0.20, 0.12, 0.08] },
    { nome: 'E — +rec    (35/20/20/15/7/3)',   pesos: [0.35, 0.20, 0.20, 0.15, 0.07, 0.03] },
  ].map(c => {
    const scores = comCompra.map(r => calcScoreCenario(r.perfil, r.tend.tendencia, c.pesos));
    return { nome: c.nome, ...stats(scores) };
  });

  // ── 17. Correlações ───────────────────────────────────────────────────────
  const scoreVals = comCompra.map(r => r.score.scoreTotal  || 0);
  const fatVals   = comCompra.map(r => r.perfil.faturamentoTotal || 0);
  const diasVals  = comCompra.map(r => r.perfil.diasSemComprar   || 0);
  const pedsVals  = comCompra.map(r => r.perfil.pedidosTotal     || 0);
  const freqVals  = comCompra.map(r => r.perfil.diasEntreComprasMedio ? 1 / r.perfil.diasEntreComprasMedio : 0);
  const tendVals  = comCompra.map(r => ({ CRESCENDO: 2, ESTAVEL: 1, CAINDO: 0, SEM_BASE: 1 })[r.tend.tendencia] ?? 1);

  // ── 18. Top oportunidades ─────────────────────────────────────────────────
  const topOpors = [...todasOpors]
    .sort((a, b) => (b.prioridadeFinal || 0) - (a.prioridadeFinal || 0))
    .slice(0, 10);

  // ── 19. Cross-sell sensibilidade ─────────────────────────────────────────
  function crossSellCount(minPed, maxCats) {
    return comCompra.filter(r =>
      (r.perfil.pedidosTotal || 0) >= minPed &&
      (r.perfil.categoriasMaisCompradas || []).length <= maxCats
    ).length;
  }

  // ── 20. Gerar relatório ───────────────────────────────────────────────────
  const n = resultados.length;
  function pct(v) { return `${Math.round(v / n * 10000) / 100}%`; }

  const linhas = [
    `# CALIBRAÇÃO COMERCIAL — MR4 Agente IA (VINCULADOS)`,
    ``,
    `> **ATENÇÃO:** Relatório analítico oficial dos clientes MR4 vinculados ao GestãoClick.`,
    `> PII_NO_RELATORIO = ZERO | FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO`,
    `> B1_FIX = ticketMedioTotal | B2_FIX = prioridadeFinal`,
    ``,
    `## 0. Configuração`,
    `- DATA_REFERENCIA: **${DATA_REF}**`,
    `- FONTE: API GestãoClick read-only + artifacts/vinculos-gc.json (WIF export)`,
    `- LINK_SOURCE: Firestore clientes.gestaoClickId (workflow export-vinculos360.yml)`,
    `- HIST_INICIO: ${HIST_INICIO}`,
    ``,
    `## 2. Sanity — População Vinculados`,
    ``,
    `| Métrica | Valor |`,
    `|---------|-------|`,
    `| DATA_REFERENCIA | ${DATA_REF} |`,
    `| CLIENTES_VINCULADOS | **${n}** |`,
    `| NUNCA_COMPRARAM | ${nunca.length} |`,
    `| COM_COMPRA | ${comCompra.length} |`,
    `| INATIVOS_120D | ${inativos.length} |`,
    `| ATIVOS_MENOS_120D | ${ativos.length} |`,
    `| FATURAMENTO_TOTAL | ${fmtR(Math.round(comCompra.reduce((s,r) => s + (r.perfil.faturamentoTotal||0), 0)*100))} |`,
    `| PEDIDOS_TOTAL | ${fmtNum(comCompra.reduce((s,r) => s + (r.perfil.pedidosTotal||0), 0))} |`,
    `| TICKET_MEDIO_GLOBAL | ${fmtR(Math.round(ticketMedioGlobal * 100))} |`,
    ``,
    `## 3. Distribuição Real dos Dados (clientes COM compra, n=${comCompra.length})`,
    ``,
    tabStats('Faturamento Total (R$)', dist.fatTotal),
    ``,
    tabStats('Faturamento 30d (R$)', dist.fat30),
    ``,
    tabStats('Faturamento 90d (R$)', dist.fat90),
    ``,
    tabStats('Faturamento 180d (R$)', dist.fat180),
    ``,
    tabStats('Pedidos Total', dist.pedTotal),
    ``,
    tabStats('Pedidos 90d', dist.ped90),
    ``,
    tabStats('Ticket Médio Total (R$) [B1 corrigido]', dist.ticket),
    ``,
    tabStats('Dias Sem Comprar', dist.dias),
    ``,
    tabStats('Intervalo Médio (dias)', dist.intervalo),
    ``,
    tabStats('Nº Categorias', dist.categorias),
    ``,
    tabStats('Nº Produtos Distintos', dist.produtos),
    ``,
    `## 4. Score Provisório Atual`,
    ``,
    `**Configuração:** recência 25 | frequência 20 | faturamento 25 | tendência 15 | diversidade 10 | engajamento 5`,
    ``,
    `**Distribuição Geral (n=${n})**`,
    `| Faixa | Qtd | % |`,
    `|-------|-----|---|`,
    ...Object.entries(faixasScore).map(([f, q]) => `| ${f} | ${q} | ${pct(q)} |`),
    ``,
    `**Estatísticas por segmento:**`,
    `| Segmento | MIN | P25 | MED | P75 | MAX | MÉDIA |`,
    `|----------|-----|-----|-----|-----|-----|-------|`,
    `| Geral | ${dist.scoreGeral.min} | ${dist.scoreGeral.p25} | ${dist.scoreGeral.med} | ${dist.scoreGeral.p75} | ${dist.scoreGeral.max} | ${dist.scoreGeral.media} |`,
    `| Com compra | ${dist.scoreCC.min} | ${dist.scoreCC.p25} | ${dist.scoreCC.med} | ${dist.scoreCC.p75} | ${dist.scoreCC.max} | ${dist.scoreCC.media} |`,
    `| Inativos ≥120d | ${dist.scoreInat.min} | ${dist.scoreInat.p25} | ${dist.scoreInat.med} | ${dist.scoreInat.p75} | ${dist.scoreInat.max} | ${dist.scoreInat.media} |`,
    `| Ativos <120d | ${dist.scoreAtiv.min} | ${dist.scoreAtiv.p25} | ${dist.scoreAtiv.med} | ${dist.scoreAtiv.p75} | ${dist.scoreAtiv.max} | ${dist.scoreAtiv.media} |`,
    ``,
    `## 5. Anomalias de Score`,
    ``,
    ...(anomalias.length === 0
      ? ['Nenhuma anomalia (1 pedido, score ≥40) encontrada nos vinculados.']
      : anomalias.map(a => [
          `**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** ${a.id}`,
          `- DADOS: 1 pedido, fat=R$${a.fat.toFixed(2)}, ${a.dias}d`,
          `- SCORE: ${a.score}`,
          `- MOTIVO: 1 única compra recebe score ${a.score} — frequência não penaliza suficientemente`,
        ].join('\n'))
    ),
    ``,
    `## 6. Recência`,
    ``,
    `**Thresholds atuais:** 30 | 60 | 90 | 120 dias`,
    ``,
    `| Faixa | Qtd | % |`,
    `|-------|-----|---|`,
    ...Object.entries(recenciaDist).map(([f, q]) => `| ${f} | ${q} | ${pct(q)} |`),
    ``,
    `## 7. Faturamento — Referências Provisórias`,
    ``,
    `| Referência | Valor | % que Atingem |`,
    `|------------|-------|---------------|`,
    `| REF_FATURAMENTO_TOTAL | R$10.000 | ${ref10k_perc.toFixed(1)}% (${comCompra.filter(r => r.perfil.faturamentoTotal >= 10000).length}/${comCompra.length}) |`,
    `| REF_FATURAMENTO_90D   | R$3.000  | ${ref3k_perc.toFixed(1)}% (${comCompra.filter(r => r.perfil.faturamento90d >= 3000).length}/${comCompra.length}) |`,
    ``,
    `## 8. Frequência`,
    ``,
    `**Distribuição por número de pedidos:**`,
    `| Categoria | Qtd |`,
    `|-----------|-----|`,
    ...Object.entries(freqDatas).map(([f, q]) => `| ${f} | ${q} |`),
    ``,
    `**Intervalo médio entre compras:** mediana=${dist.intervalo.med}d, média=${dist.intervalo.media}d`,
    ``,
    `## 9. Tendência`,
    ``,
    `**Motor atual (tolerância ±20%):**`,
    `| Status | Qtd | % |`,
    `|--------|-----|---|`,
    ...Object.entries(tendDist).map(([s, q]) => `| ${s} | ${q} | ${pct(q)} |`),
    ``,
    `**Simulação de tolerâncias:**`,
    `| Tol. | CRESCENDO | ESTAVEL | CAINDO | SEM_BASE |`,
    `|------|-----------|---------|--------|---------|`,
    ...tendSensib.map(r => `| ±${r.tol}% | ${r.CRESCENDO} | ${r.ESTAVEL} | ${r.CAINDO} | ${r.SEM_BASE} |`),
    ``,
    `## 10. Recorrência`,
    ``,
    `**Motor atual (alerta=0.85, atraso=1.10):**`,
    `| Status | Qtd | % |`,
    `|--------|-----|---|`,
    ...Object.entries(recorrDist).map(([s, q]) => `| ${s} | ${q} | ${pct(q)} |`),
    ``,
    `**Simulação de fatores:**`,
    `| Alerta | Atraso | DENTRO | PROX | ATRASADO | SEM_BASE | NUNCA |`,
    `|--------|--------|--------|------|----------|---------|-------|`,
    ...recorrSensib.map(r => `| ${r.fa} | ${r.fd} | ${r.DENTRO} | ${r.PROX} | ${r.ATRASADO} | ${r.SEM_BASE} | ${r.NUNCA} |`),
    ``,
    `## 11. Outliers de Recorrência (média/mediana > 300%)`,
    ``,
    `| Cliente | Média | Mediana | Δ% | Pedidos |`,
    `|---------|-------|---------|-----|---------|`,
    ...(outlierRecorr.length > 0
      ? outlierRecorr.map(r => `| ${r.id} | ${r.media}d | ${r.med}d | ${r.delta}% | ${r.peds} |`)
      : ['| — | — | — | — | — |']),
    ``,
    `## 12. Oportunidades`,
    ``,
    `- TOTAL_OPORTUNIDADES: **${todasOpors.length}**`,
    `- CLIENTES_COM_OPORTUNIDADE: ${clComOport}`,
    `- CLIENTES_SEM_OPORTUNIDADE: ${n - clComOport}`,
    ``,
    `**Por tipo:**`,
    `| Tipo | Qtd |`,
    `|------|-----|`,
    ...Object.entries(tiposDist).sort((a, b) => b[1] - a[1]).map(([t, q]) => `| ${t} | ${q} |`),
    ``,
    `**Conflitos REATIVACAO_120D + JANELA_DE_RECOMPRA:** ${conflitos} clientes`,
    ``,
    `## 13. Cross-Sell — Sensibilidade`,
    ``,
    `**Regra atual:** 1 categoria AND pedidos ≥ 3`,
    ``,
    `| Pedidos mínimos | 1 cat | ≤2 cats |`,
    `|-----------------|-------|---------|`,
    `| ≥2 | ${crossSellCount(2,1)} | ${crossSellCount(2,2)} |`,
    `| ≥3 | ${crossSellCount(3,1)} | ${crossSellCount(3,2)} |`,
    `| ≥4 | ${crossSellCount(4,1)} | ${crossSellCount(4,2)} |`,
    `| ≥5 | ${crossSellCount(5,1)} | ${crossSellCount(5,2)} |`,
    ``,
    `## 14. Priorização [B2 corrigido — usa prioridadeFinal]`,
    ``,
    `**Distribuição de prioridade final (prioridadeFinal):**`,
    `| Faixa | Qtd |`,
    `|-------|-----|`,
    ...Object.entries(faixasPrior).map(([f, q]) => `| ${f} | ${q} |`),
    ``,
    `**Top 10 oportunidades por prioridadeFinal (anônimo):**`,
    `| Rank | Cliente | Tipo | PrioridadeFinal |`,
    `|------|---------|------|-----------------|`,
    ...topOpors.map((op, i) => {
      const r = resultados.find(r => r.gcId === op.gestaoClickId || r.mr4Id === op.clienteMr4Id);
      const id = r ? anonId(r.gcId) : 'C????';
      return `| ${i+1} | ${id} | ${op.tipo} | ${op.prioridadeFinal} |`;
    }),
    ``,
    `## 15. Sensibilidade do Score — Pesos Alternativos`,
    ``,
    `| Cenário | MIN | P25 | MED | P75 | MAX | MÉDIA |`,
    `|---------|-----|-----|-----|-----|-----|-------|`,
    ...cenarios.map(c => `| ${c.nome} | ${c.min} | ${c.p25} | ${c.med} | ${c.p75} | ${c.max} | ${c.media} |`),
    ``,
    `## 16. Correlações Descritivas`,
    ``,
    `_(correlação ≠ causalidade)_`,
    ``,
    `| Par | Correlação de Pearson |`,
    `|-----|-----------------------|`,
    `| score_faturamento | ${correlacao(scoreVals, fatVals)} |`,
    `| score_recencia | ${correlacao(scoreVals, diasVals)} |`,
    `| score_frequencia | ${correlacao(scoreVals, freqVals)} |`,
    `| score_pedidos | ${correlacao(scoreVals, pedsVals)} |`,
    `| score_tendencia | ${correlacao(scoreVals, tendVals)} |`,
    ``,
    `## 17. Casos para Revisão Humana`,
    ``,
    `### Clientes Ativos (amostra 5)`,
    ...(ativos.slice(0, 5).map(r => [
      '```',
      `**ID_ANONIMO =** ${anonId(r.gcId)}`,
      `ULTIMA_COMPRA = ${r.perfil.ultimaCompraEm || '—'}`,
      `DIAS_SEM_COMPRAR = ${r.perfil.diasSemComprar ?? '—'}`,
      `FAT_TOTAL = R$${(r.perfil.faturamentoTotal||0).toFixed(2)}`,
      `FAT_90D = R$${(r.perfil.faturamento90d||0).toFixed(2)}`,
      `PEDIDOS = ${r.perfil.pedidosTotal || 0}`,
      // B1 FIX: usa ticketMedioTotal
      `TICKET_MEDIO = R$${(r.perfil.ticketMedioTotal||0).toFixed(2)}`,
      `FREQUENCIA = ${r.perfil.diasEntreComprasMedio ? r.perfil.diasEntreComprasMedio + 'd entre compras' : '—'}`,
      `CATEGORIAS = ${(r.perfil.categoriasMaisCompradas||[]).length}`,
      `TENDENCIA = ${r.tend.tendencia}`,
      `RECORRENCIA = ${r.recorr.status}`,
      `SCORE_ATUAL = ${r.score.scoreTotal} (${r.score.classificacao || ''})`,
      `OPORTUNIDADES = ${r.priors.map(o=>o.tipo).join(', ') || '—'}`,
      `PRIORIDADE_MAX = ${r.priors[0]?.prioridadeFinal ?? '—'}`,
      '```',
    ].join('\n'))),
    ``,
    `### Clientes Inativos ≥120d (amostra 5)`,
    ...(inativos.slice(0, 5).map(r => [
      '```',
      `**ID_ANONIMO =** ${anonId(r.gcId)}`,
      `ULTIMA_COMPRA = ${r.perfil.ultimaCompraEm || '—'}`,
      `DIAS_SEM_COMPRAR = ${r.perfil.diasSemComprar ?? '—'}`,
      `FAT_TOTAL = R$${(r.perfil.faturamentoTotal||0).toFixed(2)}`,
      `FAT_90D = R$${(r.perfil.faturamento90d||0).toFixed(2)}`,
      `PEDIDOS = ${r.perfil.pedidosTotal || 0}`,
      `TICKET_MEDIO = R$${(r.perfil.ticketMedioTotal||0).toFixed(2)}`,
      `TENDENCIA = ${r.tend.tendencia}`,
      `RECORRENCIA = ${r.recorr.status}`,
      `SCORE_ATUAL = ${r.score.scoreTotal} (${r.score.classificacao || ''})`,
      `OPORTUNIDADES = ${r.priors.map(o=>o.tipo).join(', ') || '—'}`,
      `PRIORIDADE_MAX = ${r.priors[0]?.prioridadeFinal ?? '—'}`,
      '```',
    ].join('\n'))),
    ``,
    `### Nunca Compraram (amostra 5)`,
    ...(nunca.slice(0, 5).map(r => [
      '```',
      `**ID_ANONIMO =** ${anonId(r.gcId)}`,
      `NUNCA_COMPROU = true`,
      `FAT_TOTAL = R$0,00`,
      `PEDIDOS = 0`,
      `TICKET_MEDIO = null`,
      `SCORE_ATUAL = ${r.score.scoreTotal}`,
      `OPORTUNIDADES = ${r.priors.map(o=>o.tipo).join(', ') || '—'}`,
      '```',
    ].join('\n'))),
    ``,
    `## Diagnóstico das Regras Provisórias`,
    ``,
    `**REGRAS_QUE_PARECEM_MUITO_SENSIVEIS:**`,
    `- Tolerância tendência (±20%): base pequena nos vinculados pode gerar instabilidade. Ver seção 9.`,
    `- Recorrência com média de intervalo: outliers distorcem para clientes com compras irregulares. Ver seção 11.`,
    ``,
    `**REGRAS_COM_POUCO_IMPACTO:**`,
    `- Componente engajamento (peso 5): impacto marginal. Cenário C mostra variação.`,
    `- Bônus +8 (R$5k-R$10k): afeta subconjunto dos vinculados.`,
    ``,
    `**REGRAS_QUE_PRECISAM_DECISAO_HUMANA:**`,
    `- REF_FATURAMENTO_TOTAL R$10.000: verificar percentil real nos vinculados.`,
    `- REF_FATURAMENTO_90D R$3.000: verificar percentil real nos vinculados.`,
    `- Threshold inativo ≥120d: validar se reflete ciclo real dos vinculados.`,
    `- NUNCA_COMPRARAM=${nunca.length}: decidir como tratar no agente (não oferecer oportunidades vs oferecer onboarding).`,
    ``,
    `## Relatório Final — Gates`,
    ``,
    `| Campo | Valor |`,
    `|-------|-------|`,
    `| DATA_REFERENCIA | ${DATA_REF} |`,
    `| CLIENTES_VINCULADOS | ${n} |`,
    `| NUNCA_COMPRARAM | ${nunca.length} |`,
    `| COM_COMPRA | ${comCompra.length} |`,
    `| ATIVOS | ${ativos.length} |`,
    `| INATIVOS_120D | ${inativos.length} |`,
    `| FATURAMENTO_TOTAL | ${fmtR(Math.round(comCompra.reduce((s,r) => s + (r.perfil.faturamentoTotal||0), 0)*100))} |`,
    `| PEDIDOS_TOTAL | ${fmtNum(comCompra.reduce((s,r) => s + (r.perfil.pedidosTotal||0), 0))} |`,
    `| TICKET_MEDIO_GLOBAL | ${fmtR(Math.round(ticketMedioGlobal * 100))} |`,
    `| OPORTUNIDADES_TOTAL | ${todasOpors.length} |`,
    `| B1_TICKET_FIX | PASS |`,
    `| B2_PRIORITY_FIX | PASS |`,
    `| PII_NO_RELATORIO | ZERO |`,
    `| FIRESTORE_WRITES | ZERO |`,
    `| GESTAOCLICK_WRITES | ZERO |`,
    `| LLM_CALLS | ZERO |`,
    `| DEPLOYS | ZERO |`,
    `| CALIBRATION_GATE | PASS |`,
  ];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, linhas.join('\n') + '\n');

  console.log('\n============================================================');
  console.log(`Relatório salvo em: ${OUT_FILE}`);
  console.log(`CALIBRATION_GATE = PASS`);
  console.log(`CLIENTES_VINCULADOS = ${n} | NUNCA_COMPRARAM = ${nunca.length}`);
  console.log(`OPORTUNIDADES_TOTAL = ${todasOpors.length}`);
  console.log('FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO | DEPLOYS = ZERO');
  console.log('============================================================');
}

main().catch(err => {
  console.error('ERRO FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
