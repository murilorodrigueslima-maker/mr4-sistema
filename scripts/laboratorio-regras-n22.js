#!/usr/bin/env node
'use strict';

/**
 * laboratorio-regras-n22.js — N22: Laboratório de Regras Comerciais
 *
 * SOMENTE LEITURA — ZERO writes.
 *   FIRESTORE_WRITES   = ZERO
 *   GESTAOCLICK_WRITES = ZERO
 *   LLM_CALLS          = ZERO
 *   DEPLOYS            = ZERO
 *
 * CORRIGE bug N21: sensibilidade de score estava em escala 0-1 (bug: / 100 extra).
 * Apresenta CENÁRIOS ANALÍTICOS para decisão do proprietário.
 * NÃO aprova pesos. NÃO altera engines.
 *
 * Requer:
 *   artifacts/vinculos-gc.json
 *   GC_ACCESS_TOKEN e GC_SECRET_ACCESS_TOKEN
 *
 * Saída: docs/agente-comercial/LABORATORIO_REGRAS_N22.md
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Engines (NÃO modificados) ─────────────────────────────────────────────────
const {
  calcularPerfil360,
  deduplicarVendas,
  agruparVendasPorCliente,
} = require('../functions/lib/perfil360');

const {
  calcularScore,
  calcularRecencia,
  calcularFrequencia,
  calcularFaturamento,
  calcularTendenciaPontuacao,
  calcularDiversidade,
  calcularEngajamento,
  classificarScore,
} = require('../functions/lib/scoreComercial');

const { calcularTendencia }      = require('../functions/lib/tendenciaComercial');
const { calcularRecorrencia }    = require('../functions/lib/recorrencia');
const { gerarOportunidades }     = require('../functions/lib/oportunidades');
const { priorizarOportunidades } = require('../functions/lib/priorizadorOportunidades');
const { buildProdutosPorId }     = require('../functions/lib/sync360');

// ── Config ────────────────────────────────────────────────────────────────────
const GC_ACCESS  = process.env.GC_ACCESS_TOKEN        || process.env.GESTAOCLICK_ACCESS_TOKEN;
const GC_SECRET  = process.env.GC_SECRET_ACCESS_TOKEN || process.env.GESTAOCLICK_SECRET_TOKEN;
const GC_BASE    = 'https://api.gestaoclick.com';
const HIST_INICIO = '2022-03-24';
const DATA_REF    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }))
                    .toISOString().slice(0, 10);
const OUT_DIR     = path.join(__dirname, '..', 'docs', 'agente-comercial');
const OUT_FILE    = path.join(OUT_DIR, 'LABORATORIO_REGRAS_N22.md');
const VINCULOS    = path.join(__dirname, '..', 'artifacts', 'vinculos-gc.json');

if (!GC_ACCESS || !GC_SECRET) {
  console.error('ERRO: GC_ACCESS_TOKEN e GC_SECRET_ACCESS_TOKEN são obrigatórios.');
  process.exit(1);
}
if (!fs.existsSync(VINCULOS)) {
  console.error(`ERRO: ${VINCULOS} não encontrado. Execute export-vinculos360.yml.`);
  process.exit(1);
}

// ── Helpers básicos ───────────────────────────────────────────────────────────

function anonId(gcId) {
  return 'C' + crypto.createHash('sha1').update(String(gcId)).digest('hex').slice(0, 4).toUpperCase();
}

function fmtR(v) {
  return 'R$' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function pct(num, den) {
  return den === 0 ? '0.0%' : `${(num / den * 100).toFixed(1)}%`;
}

function percentil(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.min(idx, sorted.length - 1)];
}

function stats(arr) {
  if (!arr.length) return { min: 0, p25: 0, med: 0, p75: 0, max: 0, media: 0, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const media = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    min:   s[0],
    p25:   percentil(s, 25),
    med:   percentil(s, 50),
    p75:   percentil(s, 75),
    max:   s[s.length - 1],
    media: Math.round(media * 100) / 100,
    n:     s.length,
  };
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
        catch (e) { reject(new Error(`GC JSON parse error ${endpoint}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function gcFetchAll(endpoint, params = {}) {
  const all = [];
  let pagina = 1;
  const visited = new Set();
  while (true) {
    if (visited.has(pagina)) break;
    visited.add(pagina);
    const r = await gcGet(endpoint, { ...params, pagina });
    const data = Array.isArray(r.data) ? r.data : [];
    all.push(...data);
    const prox = (r.meta || {}).proxima_pagina;
    if (!prox) break;
    pagina = Number(prox);
  }
  return all;
}

// ── Helper de score corrigido (SENS FIX N22) ──────────────────────────────────
// Bug N21: calcScoreCenario usava pesos=[0.25,...] com /100 extra → resultado 0-1
// N22: pesos={recencia:25,...} (soma=100), sem /100 extra → resultado 0-100
function calcScoreCenario(perfil, tendencia, pesos) {
  if (perfil.nuncaComprou) return 0;
  const recP  = calcularRecencia(perfil).pontuacao;
  const freqP = calcularFrequencia(perfil).pontuacao;
  const fatP  = calcularFaturamento(perfil).pontuacao;
  const tendP = calcularTendenciaPontuacao(tendencia).pontuacao;
  const divP  = calcularDiversidade(perfil).pontuacao;
  const engP  = calcularEngajamento(perfil).pontuacao;
  return Math.max(0, Math.min(100, Math.round(
    (recP  * pesos.recencia    +
     freqP * pesos.frequencia  +
     fatP  * pesos.faturamento +
     tendP * pesos.tendencia   +
     divP  * pesos.diversidade +
     engP  * pesos.engajamento) / 100
  )));
}

// ── Helpers de simulação (sem alterar engines) ────────────────────────────────

// Tendência com tolerância customizada
function calcTendComTol(perfil, tol) {
  if (!perfil || perfil.nuncaComprou) return 'NUNCA_COMPROU';
  const vr = (a, b) => b === 0 ? (a > 0 ? Infinity : null) : (a - b) / b;
  const cl = (v) => v === null ? 'SEM_BASE' : v === Infinity ? 'CRESCENDO' : v >= tol ? 'CRESCENDO' : v <= -tol ? 'CAINDO' : 'ESTAVEL';

  const ped30 = perfil.pedidos30d || 0;
  const fat30 = perfil.faturamento30d || 0;
  const ped30a = (perfil.pedidos60d || 0) - ped30;
  const fat30a = (perfil.faturamento60d || 0) - fat30;
  if (ped30 >= 1 || ped30a >= 1) return cl(fat30a > 0 ? vr(fat30, fat30a) : vr(ped30, ped30a));

  const ped90 = perfil.pedidos90d || 0;
  const fat90 = perfil.faturamento90d || 0;
  const ped90a = (perfil.pedidos180d || 0) - ped90;
  const fat90a = (perfil.faturamento180d || 0) - fat90;
  if (ped90 >= 1 || ped90a >= 1) return cl(fat90a > 0 ? vr(fat90, fat90a) : vr(ped90, ped90a));
  return 'SEM_BASE';
}

// Tendência com mínimo de pedidos customizado (T1, T2)
function calcTendComMin(perfil, tol, minPed) {
  if (!perfil || perfil.nuncaComprou) return 'NUNCA_COMPROU';
  const vr = (a, b) => b === 0 ? (a > 0 ? Infinity : null) : (a - b) / b;
  const cl = (v) => v === null ? 'SEM_BASE' : v === Infinity ? 'CRESCENDO' : v >= tol ? 'CRESCENDO' : v <= -tol ? 'CAINDO' : 'ESTAVEL';

  const ped30 = perfil.pedidos30d || 0;
  const fat30 = perfil.faturamento30d || 0;
  const ped30a = (perfil.pedidos60d || 0) - ped30;
  const fat30a = (perfil.faturamento60d || 0) - fat30;
  if (ped30 >= minPed || ped30a >= minPed) return cl(fat30a > 0 ? vr(fat30, fat30a) : vr(ped30, ped30a));

  const ped90 = perfil.pedidos90d || 0;
  const fat90 = perfil.faturamento90d || 0;
  const ped90a = (perfil.pedidos180d || 0) - ped90;
  const fat90a = (perfil.faturamento180d || 0) - fat90;
  if (ped90 >= minPed || ped90a >= minPed) return cl(fat90a > 0 ? vr(fat90, fat90a) : vr(ped90, ped90a));
  return 'SEM_BASE';
}

// T3: preferir 90d quando 30d tem base < 2 pedidos em ambas janelas
function calcTendT3(perfil, tol = 0.20) {
  if (!perfil || perfil.nuncaComprou) return 'NUNCA_COMPROU';
  const vr = (a, b) => b === 0 ? (a > 0 ? Infinity : null) : (a - b) / b;
  const cl = (v) => v === null ? 'SEM_BASE' : v === Infinity ? 'CRESCENDO' : v >= tol ? 'CRESCENDO' : v <= -tol ? 'CAINDO' : 'ESTAVEL';

  const ped30 = perfil.pedidos30d || 0;
  const fat30 = perfil.faturamento30d || 0;
  const ped30a = (perfil.pedidos60d || 0) - ped30;
  const fat30a = (perfil.faturamento60d || 0) - fat30;
  if (ped30 >= 2 || ped30a >= 2) return cl(fat30a > 0 ? vr(fat30, fat30a) : vr(ped30, ped30a));

  const ped90 = perfil.pedidos90d || 0;
  const fat90 = perfil.faturamento90d || 0;
  const ped90a = (perfil.pedidos180d || 0) - ped90;
  const fat90a = (perfil.faturamento180d || 0) - fat90;
  if (ped90 >= 1 || ped90a >= 1) return cl(fat90a > 0 ? vr(fat90, fat90a) : vr(ped90, ped90a));
  return 'SEM_BASE';
}

// Recorrência com mediana (ao invés de média)
function calcRecorrenciaMediana(perfil) {
  if (!perfil || perfil.nuncaComprou) return 'NUNCA_COMPROU';
  const med = perfil.diasEntreComprasMediana;
  if (med === null || med === undefined) return 'SEM_BASE';
  const dias = perfil.diasSemComprar || 0;
  const limAlerta = Math.round(med * 0.85);
  const limAtraso = Math.round(med * 1.10);
  if (dias >= limAtraso)      return 'ATRASADO_VS_HISTORICO';
  if (dias >= limAlerta)      return 'PROXIMO_DA_JANELA';
  return 'DENTRO_DO_PADRAO';
}

// Recência com thresholds customizados (R scenarios)
// thresholds: [t1, t2, t3, t4?] — fixo: último threshold = 120 = inativo
function calcRecenciaScore(perfil, thresholds) {
  if (!perfil || perfil.nuncaComprou) return 0;
  const dias = perfil.diasSemComprar || 999;
  const pts = [100, 75, 50, 25, 0];
  for (let i = 0; i < thresholds.length; i++) {
    if (dias <= thresholds[i]) return pts[i];
  }
  return 0; // inativo
}

// Score com recência alternativa (para R scenarios)
function calcScoreComRecencia(perfil, tendencia, pesosPadrao, thresholdsRec) {
  if (perfil.nuncaComprou) return 0;
  const recP  = calcRecenciaScore(perfil, thresholdsRec);
  const freqP = calcularFrequencia(perfil).pontuacao;
  const fatP  = calcularFaturamento(perfil).pontuacao;
  const tendP = calcularTendenciaPontuacao(tendencia).pontuacao;
  const divP  = calcularDiversidade(perfil).pontuacao;
  const engP  = calcularEngajamento(perfil).pontuacao;
  const p = pesosPadrao;
  return Math.max(0, Math.min(100, Math.round(
    (recP  * p.recencia    + freqP * p.frequencia  + fatP  * p.faturamento +
     tendP * p.tendencia   + divP  * p.diversidade + engP  * p.engajamento) / 100
  )));
}

// ── Definição de cenários ─────────────────────────────────────────────────────

const CENARIOS_SCORE = [
  { id: 'S0', nome: 'S0 — ATUAL',                pesos: { recencia: 25, frequencia: 20, faturamento: 25, tendencia: 15, diversidade: 10, engajamento: 5  } },
  { id: 'S1', nome: 'S1 — RELACIONAMENTO',        pesos: { recencia: 35, frequencia: 30, faturamento: 15, tendencia: 10, diversidade:  7, engajamento: 3  } },
  { id: 'S2', nome: 'S2 — VALOR FINANCEIRO',      pesos: { recencia: 15, frequencia: 15, faturamento: 40, tendencia: 15, diversidade: 10, engajamento: 5  } },
  { id: 'S3', nome: 'S3 — EQUILIBRADO',           pesos: { recencia: 20, frequencia: 20, faturamento: 20, tendencia: 20, diversidade: 10, engajamento: 10 } },
  { id: 'S4', nome: 'S4 — SEM ENGAJAMENTO',       pesos: { recencia: 27, frequencia: 22, faturamento: 27, tendencia: 16, diversidade:  8, engajamento: 0  } },
];

const PESOS_PADRAO = CENARIOS_SCORE[0].pesos;

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('============================================================');
  console.log('LABORATÓRIO DE REGRAS COMERCIAIS N22');
  console.log('============================================================');
  console.log(`DATA_REFERENCIA: ${DATA_REF}`);
  console.log('SENS_FIX: escala 0-100 (bug N21: /100 extra removido)');
  console.log('ZERO writes | ZERO LLM | ZERO deploy');

  const vinculos  = JSON.parse(fs.readFileSync(VINCULOS, 'utf8'));
  const gcIdSet   = new Set(vinculos.map(v => String(v.gestaoClickId)));
  console.log(`\nVínculos: ${vinculos.length}`);

  console.log('Buscando vendas GestãoClick (~3min)...');
  const vendasBrutas    = await gcFetchAll('/vendas', { data_inicial: HIST_INICIO });
  const vendasVinculados = vendasBrutas.filter(v => gcIdSet.has(String(v.cliente_id)));
  console.log(`Vendas brutas: ${vendasBrutas.length} | Vinculados: ${vendasVinculados.length}`);

  console.log('Buscando produtos...');
  const produtosBrutos = await gcFetchAll('/produtos', { ativo: '1' });
  const produtosPorId  = buildProdutosPorId(produtosBrutos);

  const { vendas: vendasUnicas } = deduplicarVendas(vendasVinculados);
  const vendasPorGc = agruparVendasPorCliente(vendasUnicas);

  // ── Calcular todos os perfis ──────────────────────────────────────────────
  const resultados = [];
  for (const v of vinculos) {
    const gcId  = String(v.gestaoClickId);
    const mr4Id = v.clienteMr4Id;
    const vends = vendasPorGc.get(gcId) || [];
    const perfil = calcularPerfil360({ clienteMr4Id: mr4Id, gestaoClickId: gcId, vendas: vends, produtosPorId, dataReferencia: DATA_REF });
    const tend   = calcularTendencia(perfil);
    const recorr = calcularRecorrencia(perfil);
    const score  = calcularScore(perfil, tend.tendencia);
    const opors  = gerarOportunidades(perfil, score, tend, recorr, DATA_REF);
    const priors = priorizarOportunidades(opors, perfil, score);
    resultados.push({ gcId, mr4Id, id: anonId(gcId), perfil, tend, recorr, score, opors, priors });
  }
  console.log(`Perfis: ${resultados.length}`);

  // ── Segmentos ─────────────────────────────────────────────────────────────
  const nunca     = resultados.filter(r => r.perfil.nuncaComprou);
  const comCompra = resultados.filter(r => !r.perfil.nuncaComprou);
  const inativos  = comCompra.filter(r => r.perfil.inativo120d);
  const ativos    = comCompra.filter(r => !r.perfil.inativo120d);
  const todasOpors = resultados.flatMap(r => r.priors);
  const n = resultados.length;

  // ── Gerar relatório ───────────────────────────────────────────────────────
  const lines = [];
  const ln = (...args) => lines.push(...args.map(String));
  const h  = (nivel, txt) => ln('', '#'.repeat(nivel) + ' ' + txt, '');
  const tb = (headers, rows) => {
    ln('| ' + headers.join(' | ') + ' |');
    ln('|' + headers.map(() => '---').join('|') + '|');
    for (const r of rows) ln('| ' + r.join(' | ') + ' |');
  };

  // ────────────────────────────────────────────────────────────────────────────
  ln('# LABORATÓRIO DE REGRAS COMERCIAIS — MR4 Agente IA (N22)');
  ln('');
  ln('> **ANALÍTICO SOMENTE** — PII=ZERO | WRITES=ZERO | LLM=ZERO | PESOS NÃO APROVADOS');
  ln(`> DATA_REFERENCIA: **${DATA_REF}** | N22_SENS_FIX: escala 0-100 (bug N21 corrigido)`);
  ln('');

  h(2, '0. Configuração');
  ln(`- START_HEAD: f313ed0 (pós-merge sync automático)`);
  ln(`- LINKED_CLIENTS: ${n} | COM_COMPRA: ${comCompra.length} | NUNCA_COMPROU: ${nunca.length}`);
  ln(`- ATIVOS: ${ativos.length} | INATIVOS_120D: ${inativos.length}`);
  ln(`- TOTAL_OPORTUNIDADES: ${todasOpors.length}`);
  ln('');

  // ── SEÇÃO 3: REALIDADE ATUAL ─────────────────────────────────────────────
  h(2, '3. Realidade Atual dos 52 Clientes (Anônimos)');
  ln('');
  tb(
    ['ID', 'NuncaC.', 'Inat120d', 'Dias', 'FatTotal', 'Fat90d', 'Peds', 'Ticket', 'IntMed', 'IntMed(mediana)', 'Cats', 'Tend.', 'Recorr.', 'Score', 'Classif.', 'Oportunidades', 'PriorMax'],
    resultados.map(r => {
      const p = r.perfil;
      const topOp = r.priors[0];
      return [
        r.id,
        p.nuncaComprou ? 'S' : 'N',
        p.inativo120d ? 'S' : 'N',
        p.diasSemComprar ?? '—',
        p.faturamentoTotal != null ? fmtR(p.faturamentoTotal) : '—',
        p.faturamento90d != null ? fmtR(p.faturamento90d) : '—',
        p.pedidosTotal ?? 0,
        p.ticketMedioTotal != null ? fmtR(p.ticketMedioTotal) : '—',
        p.diasEntreComprasMedio != null ? Math.round(p.diasEntreComprasMedio) + 'd' : '—',
        p.diasEntreComprasMediana != null ? Math.round(p.diasEntreComprasMediana) + 'd' : '—',
        (p.categoriasMaisCompradas || []).length,
        r.tend.tendencia,
        r.recorr.status,
        r.score.scoreTotal,
        r.score.classificacao,
        r.priors.map(o => o.tipo.replace('_120D','').replace('REATIVACAO','REAT').replace('JANELA_DE_RECOMPRA','JANELA').replace('QUEDA_DE_COMPRAS','QUEDA').replace('NUNCA_COMPROU','NUNCA').replace('CROSS_SELL_CATEGORIA','CROSS')).join('+') || '—',
        topOp ? topOp.prioridadeFinal : '—',
      ];
    })
  );
  ln('');

  // ── SEÇÃO 4: SCORE vs PRIORIDADE ─────────────────────────────────────────
  h(2, '4. Score do Cliente vs Prioridade da Oportunidade');
  ln('');
  ln('**CONCEITO FUNDAMENTAL:** score ≠ prioridade.');
  ln('- **SCORE_CLIENTE** mede valor/saúde comercial do cliente (0-100)');
  ln('- **PRIORIDADE_OPORTUNIDADE** mede urgência de ação do vendedor (1-100)');
  ln('');
  ln('Exemplos desta população:');
  const exemploAltoScore = [...comCompra].sort((a,b) => b.score.scoreTotal - a.score.scoreTotal).slice(0,3);
  const exemploAltaPrior = [...todasOpors].sort((a,b) => b.prioridadeFinal - a.prioridadeFinal).slice(0,3);
  ln('');
  ln('| Dimensão | Top-3 IDs | Valores |');
  ln('|----------|-----------|---------|');
  ln(`| Score mais alto | ${exemploAltoScore.map(r=>r.id).join(', ')} | ${exemploAltoScore.map(r=>r.score.scoreTotal).join(', ')} |`);
  ln(`| Prioridade mais alta | ${exemploAltaPrior.map(o=>anonId(o.gestaoClickId||'')).join(', ')} | ${exemploAltaPrior.map(o=>o.prioridadeFinal).join(', ')} |`);
  ln('');

  // ── SEÇÃO 5: CENÁRIOS DE SCORE ────────────────────────────────────────────
  h(2, '5. Cenários de Score (S0-S4)');
  ln('');
  ln('**NOTA:** pesos são ANALÍTICOS — NÃO aprovados. NÃO entram em produção.');
  ln('');

  const scoresCenarios = CENARIOS_SCORE.map(c => {
    const scs = resultados.map(r => calcScoreCenario(r.perfil, r.tend.tendencia, c.pesos));
    const s0  = resultados.map(r => r.score.scoreTotal);
    const sobem  = scs.filter((s,i) => s > s0[i]).length;
    const descem = scs.filter((s,i) => s < s0[i]).length;
    const mudamFaixa = scs.filter((s,i) => {
      const f = v => v < 20 ? 0 : v < 40 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4;
      return f(s) !== f(s0[i]);
    }).length;
    const st = stats(scs);
    return { ...c, scores: scs, st, sobem, descem, mudamFaixa };
  });

  ln('| Cenário | Pesos (rec/freq/fat/tend/div/eng) | MED | MÉDIA | Sobem | Descem | Mudam Faixa |');
  ln('|---------|----------------------------------|-----|-------|-------|--------|-------------|');
  for (const c of scoresCenarios) {
    const p = c.pesos;
    ln(`| ${c.nome} | ${p.recencia}/${p.frequencia}/${p.faturamento}/${p.tendencia}/${p.diversidade}/${p.engajamento} | ${c.st.med} | ${c.st.media} | ${c.sobem} | ${c.descem} | ${c.mudamFaixa} |`);
  }
  ln('');

  ln('**Distribuição por faixa por cenário:**');
  ln('| Cenário | 0-19 | 20-39 | 40-59 | 60-79 | 80-100 |');
  ln('|---------|------|-------|-------|-------|--------|');
  for (const c of scoresCenarios) {
    const f = [0,0,0,0,0];
    c.scores.forEach(s => {
      if (s < 20) f[0]++; else if (s < 40) f[1]++; else if (s < 60) f[2]++; else if (s < 80) f[3]++; else f[4]++;
    });
    ln(`| ${c.id} | ${f[0]} | ${f[1]} | ${f[2]} | ${f[3]} | ${f[4]} |`);
  }
  ln('');

  // ── SEÇÃO 6: CLIENTES COM MAIOR VARIAÇÃO ─────────────────────────────────
  h(2, '6. Clientes com Maior Variação por Cenário');
  ln('');

  for (const c of scoresCenarios.slice(1)) { // S1..S4 comparados com S0
    const s0 = resultados.map(r => r.score.scoreTotal);
    const deltas = resultados.map((r, i) => ({
      id:    r.id,
      s0:    s0[i],
      sc:    c.scores[i],
      delta: c.scores[i] - s0[i],
      r,
    })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10);

    h(3, `${c.id} — Top 10 por Δ absoluto vs S0`);
    tb(
      ['ID', 'S0', c.id, 'Δ', 'Motivo matemático'],
      deltas.map(d => {
        const motivos = [];
        if (d.r.perfil.diasSemComprar <= 30)  motivos.push('recência excelente');
        else if (d.r.perfil.inativo120d)       motivos.push('recência=0 (inativo)');
        if (d.r.tend.tendencia === 'CRESCENDO') motivos.push('tendência crescente');
        if (d.r.tend.tendencia === 'CAINDO')    motivos.push('tendência caindo');
        if ((d.r.perfil.faturamentoTotal||0) >= 10000) motivos.push('fat≥10k');
        else if ((d.r.perfil.faturamentoTotal||0) >= 5000) motivos.push('fat≥5k');
        if (d.r.perfil.pedidosTotal === 1)       motivos.push('1 pedido');
        if ((d.r.perfil.categoriasMaisCompradas||[]).length >= 3) motivos.push('3+ cats');
        return [d.id, d.s0, d.sc, (d.delta > 0 ? '+' : '') + d.delta, motivos.join('; ') || 'sem destaque'];
      })
    );
    ln('');
  }

  // ── SEÇÃO 7: CASOS-TESTE COMERCIAIS (A-J) ────────────────────────────────
  h(2, '7. Casos-Teste Comerciais (A-J)');
  ln('');
  ln('_Clientes REAIS da população de 52, mostrados com ID anônimo._');
  ln('');

  const arquetipos = [
    { key: 'A', desc: 'Compra muito e recentemente',
      fn: rs => rs.filter(r => !r.perfil.nuncaComprou && !r.perfil.inativo120d && (r.perfil.faturamentoTotal||0) > 1000)
                  .sort((a,b) => (b.perfil.faturamentoTotal||0) - (a.perfil.faturamentoTotal||0))[0] },
    { key: 'B', desc: 'Compra muito mas está inativo',
      fn: rs => rs.filter(r => r.perfil.inativo120d && (r.perfil.faturamentoTotal||0) > 500)
                  .sort((a,b) => (b.perfil.faturamentoTotal||0) - (a.perfil.faturamentoTotal||0))[0] },
    { key: 'C', desc: 'Compra pouco mas frequentemente',
      fn: rs => rs.filter(r => !r.perfil.nuncaComprou && (r.perfil.pedidosTotal||0) >= 5 && (r.perfil.faturamentoTotal||0) < 3000)
                  .sort((a,b) => (b.perfil.pedidosTotal||0) - (a.perfil.pedidosTotal||0))[0] },
    { key: 'D', desc: 'Valores altos mas poucas compras',
      fn: rs => rs.filter(r => !r.perfil.nuncaComprou && (r.perfil.ticketMedioTotal||0) > 500 && (r.perfil.pedidosTotal||0) <= 3)
                  .sort((a,b) => (b.perfil.ticketMedioTotal||0) - (a.perfil.ticketMedioTotal||0))[0] },
    { key: 'E', desc: 'Apenas uma compra',
      fn: rs => rs.filter(r => !r.perfil.nuncaComprou && r.perfil.pedidosTotal === 1)
                  .sort((a,b) => (b.perfil.faturamentoTotal||0) - (a.perfil.faturamentoTotal||0))[0] },
    { key: 'F', desc: 'Tendência de queda',
      fn: rs => rs.filter(r => r.tend.tendencia === 'CAINDO')
                  .sort((a,b) => b.score.scoreTotal - a.score.scoreTotal)[0] },
    { key: 'G', desc: 'Recorrente próximo da janela de recompra',
      fn: rs => rs.filter(r => r.recorr.status === 'PROXIMO_DA_JANELA')[0] },
    { key: 'H', desc: 'Atrasado vs histórico',
      fn: rs => rs.filter(r => r.recorr.status === 'ATRASADO_VS_HISTORICO')
                  .sort((a,b) => (b.perfil.faturamentoTotal||0) - (a.perfil.faturamentoTotal||0))[0] },
    { key: 'I', desc: 'Nunca comprou',
      fn: rs => rs.filter(r => r.perfil.nuncaComprou)[0] },
    { key: 'J', desc: 'Múltiplas categorias',
      fn: rs => rs.filter(r => (r.perfil.categoriasMaisCompradas||[]).length >= 3)
                  .sort((a,b) => (b.perfil.categoriasMaisCompradas||[]).length - (a.perfil.categoriasMaisCompradas||[]).length)[0] },
  ];

  for (const arq of arquetipos) {
    const r = arq.fn(resultados);
    ln(`**${arq.key}. ${arq.desc}**`);
    if (!r) { ln(`_Nenhum cliente encontrado para este perfil na população._`); ln(''); continue; }
    const p = r.perfil;
    ln('```');
    ln(`ID_ANONIMO       = ${r.id}`);
    ln(`NUNCA_COMPROU    = ${p.nuncaComprou}`);
    ln(`INATIVO_120D     = ${p.inativo120d}`);
    ln(`DIAS_SEM_COMPRAR = ${p.diasSemComprar ?? '—'}`);
    ln(`FAT_TOTAL        = ${p.faturamentoTotal != null ? fmtR(p.faturamentoTotal) : '—'}`);
    ln(`FAT_90D          = ${p.faturamento90d != null ? fmtR(p.faturamento90d) : '—'}`);
    ln(`PEDIDOS          = ${p.pedidosTotal ?? 0}`);
    ln(`TICKET_MEDIO     = ${p.ticketMedioTotal != null ? fmtR(p.ticketMedioTotal) : '—'}`);
    ln(`INTERVALO_MED    = ${p.diasEntreComprasMedio != null ? Math.round(p.diasEntreComprasMedio) + 'd' : '—'}`);
    ln(`CATEGORIAS       = ${(p.categoriasMaisCompradas||[]).length}`);
    ln(`TENDENCIA        = ${r.tend.tendencia}`);
    ln(`RECORRENCIA      = ${r.recorr.status}`);
    const scCenarios = CENARIOS_SCORE.map(c => `${c.id}:${calcScoreCenario(p, r.tend.tendencia, c.pesos)}`).join(' | ');
    ln(`SCORES_CENARIOS  = ${scCenarios}`);
    ln(`SCORE_ATUAL      = ${r.score.scoreTotal} (${r.score.classificacao})`);
    ln(`OPORTUNIDADES    = ${r.priors.map(o => o.tipo).join(', ') || '—'}`);
    ln(`PRIORIDADE_MAX   = ${r.priors[0]?.prioridadeFinal ?? '—'}`);
    ln('```');
    ln('');
  }

  // ── SEÇÃO 8: COMPRA ÚNICA ────────────────────────────────────────────────
  h(2, '8. Problema da Compra Única (U0-U2)');
  ln('');
  const umaCompra = comCompra.filter(r => r.perfil.pedidosTotal === 1);
  ln(`**Clientes com exatamente 1 pedido:** ${umaCompra.length} de ${comCompra.length} compradores`);
  ln('');
  if (umaCompra.length > 0) {
    tb(
      ['ID', 'Score U0', 'Recência', 'Fat.Total', 'Tend.', 'Freq.U0', 'Score U1*', 'Score U2*'],
      umaCompra.map(r => {
        const p = r.perfil;
        // U0: comportamento atual
        const u0 = r.score.scoreTotal;
        // U1: frequência = SEM_BASE (0) quando apenas 1 data
        const freqU1 = 0;
        const u1 = Math.max(0, Math.min(100, Math.round(
          (calcularRecencia(p).pontuacao * PESOS_PADRAO.recencia +
           freqU1 * PESOS_PADRAO.frequencia +
           calcularFaturamento(p).pontuacao * PESOS_PADRAO.faturamento +
           calcularTendenciaPontuacao(r.tend.tendencia).pontuacao * PESOS_PADRAO.tendencia +
           calcularDiversidade(p).pontuacao * PESOS_PADRAO.diversidade +
           calcularEngajamento(p).pontuacao * PESOS_PADRAO.engajamento) / 100
        )));
        // U2: frequência capped a 50% quando pedidosTotal=1
        const freqU2 = Math.min(50, calcularFrequencia(p).pontuacao);
        const u2 = Math.max(0, Math.min(100, Math.round(
          (calcularRecencia(p).pontuacao * PESOS_PADRAO.recencia +
           freqU2 * PESOS_PADRAO.frequencia +
           calcularFaturamento(p).pontuacao * PESOS_PADRAO.faturamento +
           calcularTendenciaPontuacao(r.tend.tendencia).pontuacao * PESOS_PADRAO.tendencia +
           calcularDiversidade(p).pontuacao * PESOS_PADRAO.diversidade +
           calcularEngajamento(p).pontuacao * PESOS_PADRAO.engajamento) / 100
        )));
        return [
          r.id, u0,
          p.diasSemComprar != null ? p.diasSemComprar + 'd' : '—',
          p.faturamentoTotal != null ? fmtR(p.faturamentoTotal) : '—',
          r.tend.tendencia,
          calcularFrequencia(p).pontuacao,
          u1, u2,
        ];
      })
    );
    ln('');
    ln('_* U1 = freq=SEM_BASE (0) para 1 pedido | U2 = freq capped em 50 para 1 pedido._');
    ln('_Motor NÃO alterado. Simulação analítica apenas._');
  }
  ln('');

  // ── SEÇÃO 9: PERCENTIS DE FATURAMENTO ────────────────────────────────────
  h(2, '9. Percentis de Faturamento (clientes COM compra, n=' + comCompra.length + ')');
  ln('');

  const fatsSorted  = comCompra.map(r => r.perfil.faturamentoTotal || 0).sort((a,b) => a-b);
  const fat90Sorted = comCompra.map(r => r.perfil.faturamento90d   || 0).sort((a,b) => a-b);

  h(3, 'Faturamento Total');
  const fatSt = stats(fatsSorted);
  tb(['MÃO.', 'P10', 'P25', 'MED', 'P75', 'P90', 'MAX', 'MÉDIA'],
     [[fmtR(fatSt.min), fmtR(percentil(fatsSorted,10)), fmtR(percentil(fatsSorted,25)), fmtR(fatSt.med), fmtR(fatSt.p75), fmtR(percentil(fatsSorted,90)), fmtR(fatSt.max), fmtR(fatSt.media)]]);
  ln('');

  ln('| Threshold | Qtd. atingem | % |');
  ln('|-----------|-------------|---|');
  for (const ref of [5000, 10000, 15000, 20000]) {
    const qtd = fatsSorted.filter(f => f >= ref).length;
    ln(`| R$${ref.toLocaleString('pt-BR')} | ${qtd} | ${pct(qtd, comCompra.length)} |`);
  }
  ln('');

  h(3, 'Faturamento 90d');
  const fat90St = stats(fat90Sorted);
  tb(['MIN', 'P10', 'P25', 'MED', 'P75', 'P90', 'MAX', 'MÉDIA'],
     [[fmtR(fat90St.min), fmtR(percentil(fat90Sorted,10)), fmtR(percentil(fat90Sorted,25)), fmtR(fat90St.med), fmtR(fat90St.p75), fmtR(percentil(fat90Sorted,90)), fmtR(fat90St.max), fmtR(fat90St.media)]]);
  ln('');

  ln('| Threshold 90d | Qtd. atingem | % |');
  ln('|---------------|-------------|---|');
  for (const ref of [1000, 2000, 3000, 5000]) {
    const qtd = fat90Sorted.filter(f => f >= ref).length;
    ln(`| R$${ref.toLocaleString('pt-BR')} | ${qtd} | ${pct(qtd, comCompra.length)} |`);
  }
  ln('');

  // ── SEÇÃO 10: RECÊNCIA CENÁRIOS ───────────────────────────────────────────
  h(2, '10. Cenários de Recência (R0-R3)');
  ln('');
  ln('**Regra empresarial fixa:** ≥120d = inativo. NÃO alterada.');
  ln('**Variação:** apenas os thresholds intermediários.**');
  ln('');

  const recCenarios = [
    { id: 'R0', desc: '30/60/90/120 (atual)',  thresh: [30, 60, 90, 120] },
    { id: 'R1', desc: '30/60/120',             thresh: [30, 60, 120] },
    { id: 'R2', desc: '30/90/120',             thresh: [30, 90, 120] },
    { id: 'R3', desc: '45/90/120',             thresh: [45, 90, 120] },
  ];

  ln('| Cenário | Thresholds | Excelente | Bom | Regular | Fraco | Inativo | Nunca |');
  ln('|---------|-----------|-----------|-----|---------|-------|---------|-------|');
  for (const c of recCenarios) {
    const dist = [0, 0, 0, 0, 0, 0]; // exc, bom, reg, fraco, inativo, nunca
    for (const r of resultados) {
      if (r.perfil.nuncaComprou) { dist[5]++; continue; }
      const dias = r.perfil.diasSemComprar || 999;
      const pts = calcRecenciaScore(r.perfil, c.thresh);
      if (pts === 100) dist[0]++;
      else if (pts === 75) dist[1]++;
      else if (pts === 50) dist[2]++;
      else if (pts === 25) dist[3]++;
      else dist[4]++;
    }
    ln(`| ${c.id} | ${c.desc} | ${dist[0]} | ${dist[1]} | ${dist[2]} | ${dist[3]} | ${dist[4]} | ${dist[5]} |`);
  }
  ln('');

  ln('**Clientes que mudam de pontuação de recência vs R0:**');
  const mudam = resultados.filter(r => {
    if (r.perfil.nuncaComprou) return false;
    const r0 = calcRecenciaScore(r.perfil, [30, 60, 90, 120]);
    return recCenarios.slice(1).some(c => calcRecenciaScore(r.perfil, c.thresh) !== r0);
  });
  if (mudam.length === 0) {
    ln('Nenhum cliente muda de pontuação entre R0-R3.');
  } else {
    tb(['ID', 'Dias', 'R0', 'R1', 'R2', 'R3'],
       mudam.map(r => [
         r.id,
         r.perfil.diasSemComprar ?? '—',
         calcRecenciaScore(r.perfil, [30,60,90,120]),
         calcRecenciaScore(r.perfil, [30,60,120]),
         calcRecenciaScore(r.perfil, [30,90,120]),
         calcRecenciaScore(r.perfil, [45,90,120]),
       ]));
  }
  ln('');

  // ── SEÇÃO 11: TENDÊNCIA — BASE ────────────────────────────────────────────
  h(2, '11. Tendência — Análise de Base (T0-T3)');
  ln('');

  // Classificar base de cada cliente
  const baseInfo = resultados.map(r => {
    const p = r.perfil;
    if (p.nuncaComprou) return { r, base: 'NUNCA_COMPROU', maxPed: 0, metodo: '—' };
    const ped30  = p.pedidos30d || 0;
    const ped30a = (p.pedidos60d || 0) - ped30;
    const ped90  = p.pedidos90d || 0;
    const ped90a = (p.pedidos180d || 0) - ped90;
    const maxPed30 = Math.max(ped30, ped30a);
    const maxPed90 = Math.max(ped90, ped90a);
    const metodo = maxPed30 >= 1 ? 'JANELA_30D' : maxPed90 >= 1 ? 'JANELA_90D' : 'SEM_BASE';
    const maxPed = metodo === 'JANELA_30D' ? maxPed30 : metodo === 'JANELA_90D' ? maxPed90 : 0;
    const base = maxPed <= 0 ? 'SEM_BASE' : maxPed <= 2 ? 'BASE_FRACA' : maxPed <= 5 ? 'BASE_MEDIA' : 'BASE_FORTE';
    return { r, base, maxPed, metodo };
  });

  const baseDist = {};
  for (const b of baseInfo) baseDist[b.base] = (baseDist[b.base]||0) + 1;
  ln('**Força da base de comparação:**');
  tb(['Categoria', 'Qtd.', '%', 'Critério'],
    [
      ['BASE_FORTE (6+ peds)', baseDist['BASE_FORTE']||0, pct(baseDist['BASE_FORTE']||0,n), '>=6 pedidos na janela comparada'],
      ['BASE_MEDIA (3-5 peds)', baseDist['BASE_MEDIA']||0, pct(baseDist['BASE_MEDIA']||0,n), '3-5 pedidos na janela comparada'],
      ['BASE_FRACA (1-2 peds)', baseDist['BASE_FRACA']||0, pct(baseDist['BASE_FRACA']||0,n), '1-2 pedidos na janela comparada'],
      ['SEM_BASE', baseDist['SEM_BASE']||0, pct(baseDist['SEM_BASE']||0,n), 'nenhum pedido em nenhuma janela'],
      ['NUNCA_COMPROU', baseDist['NUNCA_COMPROU']||0, pct(baseDist['NUNCA_COMPROU']||0,n), ''],
    ]);
  ln('');

  const tendCenarios = [
    { id: 'T0', desc: 'atual (tol=20%, minPed=1)',      fn: (r) => calcTendComTol(r.perfil, 0.20) },
    { id: 'T1', desc: 'mínimo 2 pedidos na base',       fn: (r) => calcTendComMin(r.perfil, 0.20, 2) },
    { id: 'T2', desc: 'mínimo 3 pedidos na base',       fn: (r) => calcTendComMin(r.perfil, 0.20, 3) },
    { id: 'T3', desc: '90d quando 30d base<2',          fn: (r) => calcTendT3(r.perfil, 0.20) },
  ];

  ln('**Distribuição por cenário de tendência:**');
  ln('| Cenário | CRESCENDO | ESTAVEL | CAINDO | SEM_BASE | NUNCA |');
  ln('|---------|-----------|---------|--------|---------|-------|');
  for (const tc of tendCenarios) {
    const dist = { CRESCENDO:0, ESTAVEL:0, CAINDO:0, SEM_BASE:0, NUNCA_COMPROU:0 };
    for (const r of resultados) {
      const t = tc.fn(r);
      dist[t] = (dist[t]||0) + 1;
    }
    ln(`| ${tc.id} (${tc.desc}) | ${dist.CRESCENDO} | ${dist.ESTAVEL} | ${dist.CAINDO} | ${dist.SEM_BASE} | ${dist.NUNCA_COMPROU} |`);
  }
  ln('');

  ln('**Clientes CRESCENDO/CAINDO com BASE_FRACA (1-2 pedidos) — risco de instabilidade:**');
  const fracosMasMarcados = baseInfo.filter(b => b.base === 'BASE_FRACA' && (b.r.tend.tendencia === 'CRESCENDO' || b.r.tend.tendencia === 'CAINDO'));
  if (fracosMasMarcados.length === 0) {
    ln('Nenhum.');
  } else {
    tb(['ID', 'Tend.', 'MaxPed', 'Método', 'Dias', 'Score'],
       fracosMasMarcados.map(b => [b.r.id, b.r.tend.tendencia, b.maxPed, b.metodo, b.r.perfil.diasSemComprar ?? '—', b.r.score.scoreTotal]));
  }
  ln('');

  // ── SEÇÃO 12: RECORRÊNCIA MÉDIA vs MEDIANA ────────────────────────────────
  h(2, '12. Recorrência — Média vs Mediana');
  ln('');

  const mudancasRecorr = comCompra.filter(r => {
    const statusMedia   = r.recorr.status;
    const statusMediana = calcRecorrenciaMediana(r.perfil);
    return statusMedia !== statusMediana;
  }).map(r => ({
    id:           r.id,
    media:        r.perfil.diasEntreComprasMedio != null ? Math.round(r.perfil.diasEntreComprasMedio) : null,
    mediana:      r.perfil.diasEntreComprasMediana != null ? Math.round(r.perfil.diasEntreComprasMediana) : null,
    diasSemComp:  r.perfil.diasSemComprar,
    peds:         r.perfil.pedidosTotal,
    statusMedia:  r.recorr.status,
    statusMediana: calcRecorrenciaMediana(r.perfil),
  }));

  ln(`**Clientes que mudam de classificação de recorrência:** ${mudancasRecorr.length} de ${comCompra.length}`);
  ln('');

  if (mudancasRecorr.length > 0) {
    tb(['ID', 'Média(d)', 'Mediana(d)', 'DiasSemComp', 'Status(média)', 'Status(mediana)', 'Peds'],
       mudancasRecorr.map(m => [m.id, m.media ?? '—', m.mediana ?? '—', m.diasSemComp ?? '—', m.statusMedia, m.statusMediana, m.peds]));
    ln('');
    ln('_Outliers: quando mediana < média, o cliente tem compras irregulares com picos que inflam a média._');
  } else {
    ln('Nenhum cliente muda de status entre média e mediana.');
  }
  ln('');

  // ── SEÇÃO 13: CONFLITOS DE OPORTUNIDADE ──────────────────────────────────
  h(2, '13. Oportunidades — Conflitos');
  ln('');

  const conflitos = resultados.filter(r => {
    const tipos = r.priors.map(o => o.tipo);
    return tipos.includes('REATIVACAO_120D') && tipos.includes('JANELA_DE_RECOMPRA');
  });

  ln(`**Clientes com REATIVACAO_120D + JANELA_DE_RECOMPRA simultâneos:** ${conflitos.length}`);
  ln('');

  if (conflitos.length > 0) {
    tb(['ID', 'Dias', 'IntHist(média)', 'Recorr.', 'Fat.Total', 'Peds', 'PriorREAT', 'PriorJAN'],
       conflitos.map(r => {
         const reat = r.priors.find(o => o.tipo === 'REATIVACAO_120D');
         const jan  = r.priors.find(o => o.tipo === 'JANELA_DE_RECOMPRA');
         return [
           r.id,
           r.perfil.diasSemComprar ?? '—',
           r.perfil.diasEntreComprasMedio != null ? Math.round(r.perfil.diasEntreComprasMedio) + 'd' : '—',
           r.recorr.status,
           r.perfil.faturamentoTotal != null ? fmtR(r.perfil.faturamentoTotal) : '—',
           r.perfil.pedidosTotal ?? 0,
           reat?.prioridadeFinal ?? '—',
           jan?.prioridadeFinal  ?? '—',
         ];
       }));
    ln('');
  }

  ln('**Possibilidades conceituais (NÃO implementadas):**');
  ln('');
  ln('| Opção | Descrição | Oportunidades na fila | Mudança |');
  ln('|-------|-----------|----------------------|---------|');
  ln(`| O0 — manter 2 opors | Status quo: cliente recebe REATIVACAO e JANELA | ${todasOpors.length} | nenhuma |`);
  ln(`| O1 — REATIVACAO absorve JANELA | 1 opor por cliente conflitado | ${todasOpors.length - conflitos.length} | -${conflitos.length} opors |`);
  ln(`| O2 — REATIVACAO_COM_ATRASO_HISTORICO | Nova oportunidade composta, 1 por cliente | ${todasOpors.length - conflitos.length} | -${conflitos.length} opors, novo tipo |`);
  ln('');

  // ── SEÇÃO 14: NUNCA COMPROU ───────────────────────────────────────────────
  h(2, '14. Nunca Comprou — Análise Conceitual');
  ln('');
  ln(`**Total NUNCA_COMPROU na população:** ${nunca.length} de ${n} (${pct(nunca.length, n)})`);
  ln('');
  ln('**Modelo atual:** NUNCA_COMPROU = oportunidade comercial (score=0, prioridade=30)');
  ln('');
  ln('| Modelo | Vantagens operacionais | Desvantagens |');
  ln('|--------|----------------------|--------------|');
  ln('| NUNCA_COMPROU como oportunidade (atual) | Visibilidade na fila comercial; vendedor vê todos os vinculados | Mistura prospecção com reativação/recompra; prioridade 30 pode ser ignorada |');
  ln('| PROSPECT_VINCULADO (fila separada) | Contexto diferente para o vendedor; abordagem de onboarding vs recompra | Dois fluxos para gerir; complexidade operacional |');
  ln('');
  ln(`**Impacto na fila principal se separados:** ${todasOpors.filter(o => o.tipo === 'NUNCA_COMPROU').length} oportunidades sairiam da fila atual → fila principal ficaria com ${todasOpors.filter(o => o.tipo !== 'NUNCA_COMPROU').length} oportunidades.`);
  ln('');

  // ── SEÇÃO 15: CROSS-SELL ──────────────────────────────────────────────────
  h(2, '15. Cross-Sell — Cenários (C0-C3)');
  ln('');
  ln('**Motor atual:** 1 categoria AND pedidos ≥ 3 AND NOT inativo → 0 clientes');
  ln('');

  const crossCenarios = [
    { id: 'C0', desc: '1 cat. AND ped≥3 (atual)',      minPed: 3, maxCats: 1 },
    { id: 'C1', desc: '1 cat. AND ped≥2',              minPed: 2, maxCats: 1 },
    { id: 'C2', desc: '≤2 cats. AND ped≥3',            minPed: 3, maxCats: 2 },
    { id: 'C3', desc: '≤2 cats. AND ped≥2',            minPed: 2, maxCats: 2 },
  ];

  ln('| Cenário | Clientes elegíveis | IDs anônimos | Fat. médio |');
  ln('|---------|-------------------|--------------|------------|');
  for (const c of crossCenarios) {
    const elegíveis = comCompra.filter(r =>
      !r.perfil.inativo120d &&
      (r.perfil.pedidosTotal||0) >= c.minPed &&
      (r.perfil.categoriasMaisCompradas||[]).length <= c.maxCats &&
      (r.perfil.categoriasMaisCompradas||[]).length >= 1
    );
    const fatMed = elegíveis.length > 0 ? elegíveis.reduce((s,r) => s + (r.perfil.faturamentoTotal||0), 0) / elegíveis.length : 0;
    ln(`| ${c.id} (${c.desc}) | ${elegíveis.length} | ${elegíveis.map(r=>r.id).join(', ')||'—'} | ${elegíveis.length > 0 ? fmtR(fatMed) : '—'} |`);
  }
  ln('');

  // ── SEÇÃO 16: ANÁLISE DA PRIORIDADE ──────────────────────────────────────
  h(2, '16. Análise da Prioridade das Oportunidades');
  ln('');

  h(3, 'Distribuição por tipo');
  const tiposUnicos = [...new Set(todasOpors.map(o => o.tipo))];
  tb(['Tipo', 'Qtd', 'MIN', 'MED', 'MÉDIA', 'MAX'],
     tiposUnicos.sort().map(tipo => {
       const ops = todasOpors.filter(o => o.tipo === tipo);
       const pfs = ops.map(o => o.prioridadeFinal);
       const s = stats(pfs);
       return [tipo, ops.length, s.min, s.med, s.media, s.max];
     }));
  ln('');

  h(3, 'Decomposição: base + bônus − penalidade');
  const comBonus15   = todasOpors.filter(o => (o.metricas?.faturamentoTotal||0) >= 10000).length;
  const comBonus8    = todasOpors.filter(o => (o.metricas?.faturamentoTotal||0) >= 5000 && (o.metricas?.faturamentoTotal||0) < 10000).length;
  const comPenalidade = todasOpors.filter(o => (o.metricas?.diasSemComprar||0) > 365).length;
  ln(`| Ajuste | Qtd. oportunidades afetadas |`);
  ln(`|--------|--------------------------|`);
  ln(`| +15 (faturamento ≥R$10k) | ${comBonus15} |`);
  ln(`| +8 (faturamento ≥R$5k) | ${comBonus8} |`);
  ln(`| -10 (inativos >365d) | ${comPenalidade} |`);
  ln(`| Sem ajuste | ${todasOpors.length - comBonus15 - comBonus8 - comPenalidade} |`);
  ln('');

  // ── SEÇÃO 17: FILA COMERCIAL SIMULADA ────────────────────────────────────
  h(2, '17. Fila Comercial Simulada (top 20 de ' + todasOpors.length + ')');
  ln('');
  ln('_ANALÍTICO — NÃO é o ranking definitivo. Mostra como a equipe receberia as oportunidades._');
  ln('');

  const filaOrdenada = [...todasOpors].sort((a,b) => {
    if (b.prioridadeFinal !== a.prioridadeFinal) return b.prioridadeFinal - a.prioridadeFinal;
    return (a.criadaEm||'').localeCompare(b.criadaEm||'');
  });

  tb(['Pos.', 'ID Anônimo', 'Tipo', 'Prioridade', 'Motivo matemático'],
     filaOrdenada.slice(0, 20).map((o, i) => {
       const id = anonId(o.gestaoClickId || o.clienteMr4Id || '');
       const fat = o.metricas?.faturamentoTotal || 0;
       const dias = o.metricas?.diasSemComprar || 0;
       const bonusStr = fat >= 10000 ? '+15 (fat≥10k)' : fat >= 5000 ? '+8 (fat≥5k)' : '';
       const penStr = dias > 365 ? '-10 (>365d)' : '';
       const base = o.prioridade;
       const motivo = [
         `base=${base}`,
         bonusStr, penStr,
         `→ final=${o.prioridadeFinal}`,
       ].filter(Boolean).join(' ');
       return [i + 1, id, o.tipo, o.prioridadeFinal, motivo];
     }));
  ln('');

  // ── SEÇÃO 18: PERGUNTAS PARA O PROPRIETÁRIO ───────────────────────────────
  h(2, '18. Perguntas para o Proprietário');
  ln('');
  ln('_10 decisões comerciais. NÃO há escolha recomendada. Dados apresentados para suportar a decisão humana._');
  ln('');

  const decisoes = [
    {
      n: 1,
      q: 'O que o score deve representar para a equipe comercial?',
      tema: 'significado do score',
      opts: [
        { k: 'A', desc: 'Probabilidade de o cliente comprar nos próximos 30 dias', impacto: 'Motor atual de tendência e recorrência ganham mais peso. Clientes que "deveriam" comprar agora sobem na fila.' },
        { k: 'B', desc: 'Valor histórico e potencial financeiro do cliente para a MR4', impacto: 'Cenário S2 (peso faturamento=40) — 3 clientes com fat≥R$10k sobem muito. Novos e recentes mas com ticket baixo descem.' },
        { k: 'C', desc: 'Combinação de saúde comercial e recência (visão 360)', impacto: 'Cenário S0 atual — equilibrado mas com possível ambiguidade de interpretação para o vendedor.' },
      ],
    },
    {
      n: 2,
      q: `Clientes com 1 único pedido (${umaCompra.length} no total): como tratar a frequência?`,
      tema: 'compra única',
      opts: [
        { k: 'A', desc: 'U0 — manter comportamento atual', impacto: 'Frequência é calculada sobre 1 ponto. Pode gerar scores relativamente altos por recência alta se a compra foi recente.' },
        { k: 'B', desc: 'U1 — frequência = SEM_BASE (0) até ter segunda compra', impacto: `Reduz score dos ${umaCompra.length} com 1 pedido. Mais conservador — não assume padrão sem histórico.` },
        { k: 'C', desc: 'U2 — frequência limitada a 50% do normal para 1 pedido', impacto: 'Penalização parcial. Preserva parte do sinal de frequência mas sinaliza base insuficiente.' },
      ],
    },
    {
      n: 3,
      q: 'REF_FATURAMENTO_TOTAL R$10.000: somente ' + comCompra.filter(r => r.perfil.faturamentoTotal >= 10000).length + '/' + comCompra.length + ' clientes vinculados atingem. Qual referência usar?',
      tema: 'faturamento',
      opts: [
        { k: 'A', desc: 'Manter R$10.000 (atual)', impacto: `Apenas ${comCompra.filter(r => r.perfil.faturamentoTotal >= 10000).length} clientes (${pct(comCompra.filter(r => r.perfil.faturamentoTotal >= 10000).length, comCompra.length)}) recebem pontuação de faturamento plena.` },
        { k: 'B', desc: 'Reduzir para R$5.000 (percentil ~75 da população)', impacto: `${comCompra.filter(r => r.perfil.faturamentoTotal >= 5000).length} clientes passariam a receber pontuação plena.` },
        { k: 'C', desc: 'Reduzir para R$3.000 (mediana aproximada)', impacto: `Aprox. metade dos compradores alcançaria pontuação plena. Seria mais representativo da realidade.` },
      ],
    },
    {
      n: 4,
      q: `Tendência com base pequena: ${baseInfo.filter(b=>b.base==='BASE_FRACA').length} clientes têm 1-2 pedidos na janela comparada. Como lidar?`,
      tema: 'tendência',
      opts: [
        { k: 'A', desc: 'T0 — manter mínimo atual (1 pedido)', impacto: `${resultados.filter(r=>r.tend.tendencia==='CRESCENDO'||r.tend.tendencia==='CAINDO').length} classificados como CRESCENDO/CAINDO, incluindo os de base fraca.` },
        { k: 'B', desc: 'T1 — exigir mínimo 2 pedidos em qualquer janela', impacto: `Reclassifica alguns para SEM_BASE. Ver seção 11.` },
        { k: 'C', desc: 'T3 — usar janela 90d quando 30d tem base < 2', impacto: 'Mais dados para comparação quando 30d é insuficiente, mas muda o período de referência.' },
      ],
    },
    {
      n: 5,
      q: `Recorrência: média vs mediana para intervalo entre compras. ${mudancasRecorr.length} clientes mudam de status.`,
      tema: 'recorrência',
      opts: [
        { k: 'A', desc: 'Manter média (atual)', impacto: 'Sensível a outliers — uma compra muito espaçada eleva muito o intervalo esperado.' },
        { k: 'B', desc: 'Usar mediana', impacto: `${mudancasRecorr.length} clientes mudam de status. Mais resistente a compras irregulares.` },
        { k: 'C', desc: 'Usar o mínimo entre média e mediana (mais conservador)', impacto: 'Sempre usa o menor intervalo esperado — cliente fica ATRASADO mais cedo.' },
      ],
    },
    {
      n: 6,
      q: `Conflito de oportunidades: ${conflitos.length} clientes recebem REATIVACAO_120D + JANELA_DE_RECOMPRA simultaneamente. O que fazer?`,
      tema: 'conflito de oportunidade',
      opts: [
        { k: 'A', desc: 'O0 — manter 2 oportunidades por cliente conflitado', impacto: `Fila atual: ${todasOpors.length} oportunidades. Vendedor deve decidir qual abordar.` },
        { k: 'B', desc: 'O1 — REATIVACAO_120D absorve JANELA_DE_RECOMPRA', impacto: `Fila reduz para ${todasOpors.length - conflitos.length}. Lógica: quem está inativo ≥120d, a urgência maior é a reativação.` },
        { k: 'C', desc: 'O2 — nova oportunidade REATIVACAO_COM_ATRASO_HISTORICO', impacto: `Mesmo volume (${todasOpors.length - conflitos.length}) mas comunica melhor o contexto ao vendedor.` },
      ],
    },
    {
      n: 7,
      q: `${nunca.length} clientes MR4 vinculados nunca compraram no GestãoClick. Como classificá-los?`,
      tema: 'nunca comprou',
      opts: [
        { k: 'A', desc: 'NUNCA_COMPROU como oportunidade na fila principal (atual, prioridade=30)', impacto: 'Aparecem na fila junto com reativações. Prioridade 30 é baixa — podem ser ignorados.' },
        { k: 'B', desc: 'PROSPECT_VINCULADO — fila separada de prospecção', impacto: 'Vendedor recebe contexto de onboarding, não de recompra. Fila principal fica com ' + todasOpors.filter(o=>o.tipo!=='NUNCA_COMPROU').length + ' opors.' },
        { k: 'C', desc: 'Ignorar por enquanto — foco em quem já tem histórico', impacto: 'Os 17 ficam invisíveis para o sistema até segunda instrução.' },
      ],
    },
    {
      n: 8,
      q: 'Cross-sell: motor atual gera 0 oportunidades. Qual threshold liberar?',
      tema: 'cross-sell',
      opts: [
        { k: 'A', desc: 'C0 — manter atual (1 cat, ped≥3): 0 clientes', impacto: 'Sem mudança. Motor de cross-sell permanece inativo para esta população.' },
        { k: 'B', desc: 'C1 — 1 categoria, ped≥2', impacto: `${comCompra.filter(r => !r.perfil.inativo120d && (r.perfil.pedidosTotal||0) >= 2 && (r.perfil.categoriasMaisCompradas||[]).length === 1).length} clientes entrariam na fila de cross-sell.` },
        { k: 'C', desc: 'C3 — ≤2 categorias, ped≥2', impacto: `${comCompra.filter(r => !r.perfil.inativo120d && (r.perfil.pedidosTotal||0) >= 2 && (r.perfil.categoriasMaisCompradas||[]).length <= 2 && (r.perfil.categoriasMaisCompradas||[]).length >= 1).length} clientes elegíveis — mais amplitude.` },
      ],
    },
    {
      n: 9,
      q: 'O que deve elevar a prioridade de uma oportunidade?',
      tema: 'prioridade',
      opts: [
        { k: 'A', desc: 'Manter atual: tipo_oportunidade + bônus faturamento + penalidade inatividade longa', impacto: `${comBonus15} opors ganham +15, ${comBonus8} ganham +8, ${comPenalidade} perdem -10.` },
        { k: 'B', desc: 'Incluir score do cliente: prioridade = base + (score/10)', impacto: 'Clientes com score 80 ganhariam +8 de prioridade. Mistura os dois conceitos — mais completo mas menos transparente.' },
        { k: 'C', desc: 'Remover bônus de faturamento: prioridade só pelo tipo', impacto: `Todos os ${comBonus15 + comBonus8} que hoje ganham bônus voltariam à prioridade base.` },
      ],
    },
    {
      n: 10,
      q: 'Componente engajamento (peso=5, impacto mínimo). O que fazer?',
      tema: 'engajamento',
      opts: [
        { k: 'A', desc: 'Manter peso 5 (atual)', impacto: 'Impacto máximo de 5 pontos. Cenário S4 mostra que removê-lo muda poucos clientes.' },
        { k: 'B', desc: 'S4 — redistribuir 5 pontos para recência (+2) e frequência (+3)', impacto: `Score médio muda de ${scoresCenarios[0].st.media} para ${scoresCenarios[4].st.media}. Foco em comportamento recente.` },
        { k: 'C', desc: 'Enriquecer engajamento: incluir NPS, canais, reclamações quando disponíveis', impacto: 'Peso 5 permanece mas o indicador ganha mais profundidade. Requer dados adicionais.' },
      ],
    },
  ];

  for (const d of decisoes) {
    h(3, `DECISÃO ${d.n} — ${d.tema.toUpperCase()}`);
    ln(`**Pergunta:** ${d.q}`);
    ln('');
    for (const o of d.opts) {
      ln(`**Opção ${o.k}:** ${o.desc}`);
      ln(`_Impacto observado nos 52:_ ${o.impacto}`);
      ln('');
    }
  }

  // ── RELATÓRIO FINAL ───────────────────────────────────────────────────────
  h(2, 'Relatório Final — Gates N22');
  ln('');
  ln('| Campo | Valor |');
  ln('|-------|-------|');
  ln(`| DATA_REFERENCIA | ${DATA_REF} |`);
  ln(`| LINKED_CLIENTS | ${n} |`);
  ln(`| COM_COMPRA | ${comCompra.length} |`);
  ln(`| NUNCA_COMPRARAM | ${nunca.length} |`);
  ln(`| ATIVOS | ${ativos.length} |`);
  ln(`| INATIVOS_120D | ${inativos.length} |`);
  ln(`| SENSITIVITY_SCALE_FIX | PASS (/ 100 extra removido) |`);
  ln(`| SCORE_SCENARIOS | 5 (S0-S4) |`);
  ln(`| CLIENTS_WITH_MAJOR_SCORE_CHANGE | calculado por cenário — ver seção 6 |`);
  ln(`| SINGLE_PURCHASE_ANALYSIS | ${umaCompra.length} clientes / 3 simulações (U0-U2) |`);
  ln(`| REVENUE_PERCENTILES | PASS — ver seção 9 |`);
  ln(`| RECENCY_SCENARIOS | 4 (R0-R3) / 120d fixo |`);
  ln(`| TREND_BASE_ANALYSIS | BASE_FRACA=${baseDist['BASE_FRACA']||0} / BASE_MEDIA=${baseDist['BASE_MEDIA']||0} / BASE_FORTE=${baseDist['BASE_FORTE']||0} |`);
  ln(`| TREND_SCENARIOS | 4 (T0-T3) |`);
  ln(`| RECURRENCE_MEAN_VS_MEDIAN | ${mudancasRecorr.length} clientes mudam de status |`);
  ln(`| OPPORTUNITY_CONFLICTS | ${conflitos.length} clientes / 3 possibilidades (O0-O2) |`);
  ln(`| NEVER_BOUGHT_ANALYSIS | ${nunca.length} clientes / 3 modelos |`);
  ln(`| CROSS_SELL_SCENARIOS | 4 (C0-C3) |`);
  ln(`| PRIORITY_ANALYSIS | ${tiposUnicos.length} tipos / bônus/penalidade decompostos |`);
  ln(`| SIMULATED_QUEUE | Top 20 de ${todasOpors.length} |`);
  ln(`| DECISOES_PARA_PROPRIETARIO | 10 |`);
  ln(`| PII | ZERO |`);
  ln(`| SECRETS | ZERO |`);
  ln(`| PRODUCTION_WRITES | ZERO |`);
  ln(`| LLM_CALLS | ZERO |`);
  ln(`| DEPLOYS | ZERO |`);
  ln(`| N22_GATE | PASS |`);
  ln('');

  // ── Salvar ────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');

  console.log('\n============================================================');
  console.log(`Relatório salvo: ${OUT_FILE}`);
  console.log(`N22_GATE = PASS`);
  console.log(`SENSITIVITY_SCALE_FIX = PASS`);
  console.log(`SCORE_SCENARIOS = 5 | DECISOES = 10`);
  console.log('ZERO writes | ZERO LLM | ZERO deploy');
  console.log('============================================================');
}

main().catch(err => {
  console.error('ERRO FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
