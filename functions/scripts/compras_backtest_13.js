#!/usr/bin/env node
'use strict';
/**
 * Compras — simulações da Política 1.3 (SOMBRA). Só lê cópias locais; nunca acessa nem grava no Firestore.
 *   node scripts/compras_backtest_13.js --de-arquivo <pasta> [--saida <arquivo.json>]
 * Partes: (1) precisão da previsão com/sem correção de demanda reprimida; (2) backtest 2026 SEM vazamento de futuro
 * (cada decisão usa só dados anteriores ao dia da revisão); (3) investimento hoje por nível de atendimento;
 * (4) projeção de redistribuição sem aumentar o capital (PREMISSA: demanda futura = reamostragem das últimas 26 semanas,
 * com e sem recuperação da demanda reprimida).
 */
const fs = require('fs');
const { somarDias, diffDias, fatosDeVenda, fatosDeCompra, parseData, situacaoCompra } = require('../lib/compras/canonico');
const { POLITICA_1_2 } = require('../lib/compras/politica');
const { POLITICA_1_3_SOMBRA, comConfig } = require('../lib/compras/politica13');
const K = require('../lib/compras/calculadora13');
const S = require('../lib/compras/sombra13');
const { argumentos, lerDeArquivos } = require('./compras_sombra_13');

const INICIO_SERIE = '2022-03-01', INICIO_AVAL = '2026-01-05', FIM_AVAL = '2026-11-25';
const CLS = ['A', 'B', 'C'];
const soma = (a, f = x => x) => a.reduce((s, x) => s + f(x), 0);
/** Gerador determinístico (mulberry32) por chave: os mesmos sorteios valem para todas as políticas. */
function sorteio(...chave) {
  let h = 2166136261;
  for (const c of chave.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h = Math.imul(h ^ (h >>> 15), h | 1); h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}
const niveis = p => Object.fromEntries(['AX', 'AY', 'AZ', 'BX', 'BY', 'BZ', 'CX', 'CY', 'CZ'].map(k => [k, p]));

function preparar(pasta) {
  const ent = lerDeArquivos(pasta);
  const snapFim = ent.snapshots[FIM_AVAL];
  const produtos = ent.produtos.map(p => ({ ...p, current_stock: snapFim.saldos[p.product_id] ?? p.current_stock }));
  const fatosVenda = ent.vendas.flatMap(fatosDeVenda), fatosCompra = ent.compras.flatMap(fatosDeCompra);
  const series = K.montarSeries({ produtos, fatosVenda, comprasBrutas: ent.compras, snapshots: ent.snapshots, inicio: INICIO_SERIE, hoje: FIM_AVAL });
  return { ent, produtos, fatosVenda, fatosCompra, series };
}

/** Distribuição "do mundo" para o prazo real de cada pedido simulado (compras 2025-2026, sem mesmo dia, ≤ 90 dias). */
function prazosEmpiricos(compras) {
  const out = [];
  for (const c of compras) {
    if (situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const e = parseData(c.data_emissao), m = parseData(c.modificado_em);
    if (!e || !m || e < '2025-01-01') continue;
    const d = diffDias(e, m);
    if (d >= 1 && d <= 90) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

// ── (1) previsão: observada × corrigida, avaliada nos dias FUTUROS com estoque ─────────────────────────────────
function testePrevisao({ produtos, series }, cfg) {
  const acc = () => ({ abs: 0, err: 0, real: 0 });
  const r = {};
  const marcar = (g, k, prev, real) => { const x = ((r[g] ||= {})[k] ||= acc()); x.abs += Math.abs(prev - real); x.err += prev - real; x.real += real; };
  const ini = diffDias(INICIO_SERIE, '2025-06-02'), fim = series.n - 29, meio = diffDias(INICIO_SERIE, '2026-02-01');
  const variantes = { observada_90d: { demanda: { censura: { aplicar: false } } }, corrigida_modulo: {}, corrigida_sem_teto: { demanda: { censura: { teto_multiplicador: 100 } } }, corrigida_meio_peso: { demanda: { censura: { peso: 0.5 } } } };
  const cfgs = Object.fromEntries(Object.entries(variantes).map(([k, v]) => [k, comConfig(cfg, v)]));
  for (let t = ini; t <= fim; t += 14) {
    for (const p of produtos) {
      const s = series.porId.get(p.product_id), f = K.caracteristicas(s, series, t, cfg);
      if (f.obs === null || f.obs < 90 || !(f.curta.u > 0)) continue;
      let u = 0, d = 0;
      for (let i = t + 1; i <= t + 28; i++) if (!K.indisponivel(s, i)) { u += s.dem[i]; d++; }
      if (d < 14) continue;
      const real = u / d * 28, afetado = (f.curta.dias - f.curta.disp) / f.curta.dias >= 0.2;
      for (const [k, c] of Object.entries(cfgs)) {
        const prev = K.prever(f, c).v * 28;
        marcar('todos', k, prev, real); marcar(t < meio ? 'metade_1_ate_jan26' : 'metade_2_desde_fev26', k, prev, real);
        if (afetado) marcar('com_20pct_ou_mais_sem_estoque', k, prev, real);
      }
    }
  }
  return Object.fromEntries(Object.entries(r).map(([g, m]) => [g, Object.fromEntries(Object.entries(m).map(([k, x]) => [k, { wape_pct: +(x.abs / x.real * 100).toFixed(1), vies_pct: +(x.err / x.real * 100).toFixed(1) }]))]));
}

// ── (2) backtest ────────────────────────────────────────────────────────────────────────────────────────────────
function montarBacktest(dados, cfg) {
  const { produtos, series, ent } = dados;
  const i0 = diffDias(INICIO_SERIE, INICIO_AVAL), i1 = series.n - 1;
  const universo = produtos.filter(p => {
    const s = series.porId.get(p.product_id), f = K.caracteristicas(s, series, i0 - 1, cfg);
    return f.obs !== null && f.obs >= 90 && f.anual.u >= 3 && p.registered_cost_cents > 0 && !Number.isNaN(s.saldo[i0 - 1]);
  });
  const revisoes = []; for (let t = i0; t <= i1; t += 7) revisoes.push(t);
  const semCensura = comConfig(cfg, { demanda: { censura: { aplicar: false } } });
  const fatos = new Map();
  for (const t of revisoes) {
    const ref = series.datas[t - 1];
    const todos = produtos.map(p => ({ p, f: K.caracteristicas(series.porId.get(p.product_id), series, t - 1, cfg) }));
    const abc = K.classificar(todos.map(({ p, f }) => ({ id: p.product_id, receita: f.anual.valor, margem: f.anual.margem, volume: f.anual.u })), cfg);
    const prazos = K.estimarPrazos(ent.compras, ref, cfg);
    const porId = new Map(todos.map(x => [x.p.product_id, x.f]));
    fatos.set(t, new Map(universo.map(p => {
      const f = porId.get(p.product_id), id = p.product_id;
      return [id, { f, abc: abc.get(id), prev: K.prever(f, cfg), prevSem: K.prever(f, semCensura), variab: K.variabilidade(f, cfg), prazo: K.prazoDoProduto(id, prazos, cfg), eleg: K.elegibilidade(p, f, POLITICA_1_2) }];
    })));
  }
  const info = universo.map(p => {
    const s = series.porId.get(p.product_id), f = K.caracteristicas(s, series, i0 - 1, cfg);
    const custo = p.registered_cost_cents / 100, preco = (f.preco_cents || 0) / 100;
    return { p, s, custo, margem: Math.max(0, preco - custo), classeInicial: fatos.get(i0).get(p.product_id).abc.receita.replace('SEM_VENDA', 'C'), estoque0: Math.max(0, s.saldo[i0 - 1]) };
  });
  return { universo: info, revisoes, fatos, i0, i1 };
}

/**
 * Roda uma política. cenario: { prazoReal: 'empirico' | dias, demandaDescensurada, politica: '12' | '12pos' | '13', mult12, cfg, semCensura, capital: null | 'INICIAL' }
 */
function simular(bt, dados, c) {
  const { universo, revisoes, fatos, i0, i1 } = bt;
  const emp = dados.empiricos, datas = dados.series.datas;
  const cfg = c.cfg || POLITICA_1_3_SOMBRA;
  const est = universo.map(u => u.estoque0), fila = universo.map(() => []);
  const rev = new Set(revisoes);
  const m = Object.fromEntries([...CLS, 'T'].map(k => [k, { dem: 0, atendida: 0, diasComDemanda: 0, diasZerado: 0, margemPerdida: 0 }]));
  let capital = 0, transito = 0, capitalMax = 0, excesso = 0, diasExc = 0, pedidos = 0, unPedidas = 0, comprado = 0;
  const teto = c.capital === 'INICIAL' ? soma(universo, u => u.estoque0 * u.custo) : typeof c.capital === 'number' ? c.capital : null;
  const futuro90 = universo.map(u => { const a = new Float64Array(i1 + 2); for (let i = i1; i >= 0; i--) a[i] = a[i + 1] + u.s.dem[i]; return a; });
  const ultimaPrev = universo.map(() => 0);
  const prazoReal = (k, t) => (c.prazoReal === 'empirico' ? emp[Math.floor(sorteio('prazo', universo[k].p.product_id, t) * emp.length)] : c.prazoReal);
  for (let t = i0; t <= i1; t++) {
    for (let k = 0; k < universo.length; k++) {
      const q = fila[k];
      for (let j = q.length - 1; j >= 0; j--) if (q[j][0] <= t) { est[k] += q[j][1]; q.splice(j, 1); }
    }
    if (rev.has(t)) {
      const mapa = fatos.get(t), pedir = [];
      for (let k = 0; k < universo.length; k++) {
        const u = universo[k], x = mapa.get(u.p.product_id);
        ultimaPrev[k] = x.prev.v;
        if (!x.eleg.elegivel) continue;
        const pos = soma(fila[k], o => o[1]);
        if (c.politica === '12' || c.politica === '12pos') {
          if (c.politica === '12' && fila[k].length) continue;       // premissa: comprador não repete pedido em aberto
          const v = x.eleg.produto_novo ? x.eleg.velocidade_novo : x.f.v_ingenua;
          const pol = c.mult12 ? { ...POLITICA_1_2, target_days: Object.fromEntries(CLS.map(a => [a, POLITICA_1_2.target_days[a] * c.mult12])) } : POLITICA_1_2;
          const q = K.quantidade12({ velocidade: v, classeReceita: x.abc.receita, estoque: est[k] + (c.politica === '12pos' ? pos : 0), politica12: pol });
          if (q > 0) pedir.push({ k, q });
        } else {
          const d = K.decidir({ id: u.p.product_id, f: x.f, previsao: c.semCensura ? x.prevSem : x.prev, variab: x.variab, classe: x.abc.classe, prazo: x.prazo, estoque: est[k], transito: pos, cfg, velocidadeFixa: x.eleg.produto_novo ? x.eleg.velocidade_novo : null });
          if (d.qtd_sugerida > 0) pedir.push({ k, q: d.qtd_sugerida, d, x });
        }
      }
      let lista = pedir;
      if (teto !== null) {
        const ocupado = universo.reduce((s, u, k) => s + (est[k] + soma(fila[k], o => o[1])) * u.custo, 0);
        const al = K.alocarCapital(pedir.map(o => ({ id: String(o.k), classe: o.d.classe, custo_cents: Math.round(universo[o.k].custo * 100), margem_unit_cents: Math.round(((o.x.f.preco_cents || 0) - universo[o.k].custo * 100)), velocidade: o.d.velocidade,
          qtd_sugerida: o.d.qtd_sugerida, qtd_protecao: o.d.qtd_protecao, ponto_reposicao: o.d.ponto_reposicao, posicao: o.d.posicao, embalagem: o.d.embalagem })), Math.max(0, Math.round((teto - ocupado) * 100)), cfg);
        lista = pedir.map(o => ({ k: o.k, q: al.alocado.get(String(o.k)) })).filter(o => o.q > 0);
      }
      for (const o of lista) { fila[o.k].push([t + prazoReal(o.k, t), o.q]); pedidos++; unPedidas += o.q; comprado += o.q * universo[o.k].custo; }
    }
    let cap = 0, tr = 0, exc = 0;
    for (let k = 0; k < universo.length; k++) {
      const u = universo[k];
      let d = u.s.dem[t];
      if (c.demandaDescensurada && K.indisponivel(u.s, t)) d += ultimaPrev[k];
      const v = Math.min(est[k], d); est[k] -= v;
      let rec90 = futuro90[k][Math.max(0, t - 89)] - futuro90[k][t + 1];
      const ativos = [m.T, m[u.classeInicial]];
      for (const g of ativos) { g.dem += d; g.atendida += v; g.margemPerdida += (d - v) * u.margem; if (rec90 > 0) { g.diasComDemanda++; if (est[k] <= 0) g.diasZerado++; } }
      cap += est[k] * u.custo; tr += soma(fila[k], o => o[1]) * u.custo;
      if (t + 90 <= i1) exc += Math.max(0, est[k] - (futuro90[k][t + 1] - futuro90[k][t + 91])) * u.custo;
    }
    capital += cap; transito += tr; capitalMax = Math.max(capitalMax, cap + tr); if (t + 90 <= i1) { excesso += exc; diasExc++; }
  }
  const dias = i1 - i0 + 1;
  const g = x => ({ fill_pct: +(x.atendida / x.dem * 100).toFixed(1), ruptura_pct: +(x.diasZerado / x.diasComDemanda * 100).toFixed(1), margem_perdida: Math.round(x.margemPerdida) });
  const fim = universo.reduce((s, u, k) => s + est[k] * u.custo, 0);
  return { ...g(m.T), A: g(m.A), B: g(m.B), C: g(m.C), estoque_medio: Math.round(capital / dias), transito_medio: Math.round(transito / dias), capital_pico: Math.round(capitalMax), estoque_final: Math.round(fim),
    excesso_medio: Math.round(excesso / diasExc), compras: Math.round(comprado), pedidos, un_por_pedido: +(unPedidas / Math.max(1, pedidos)).toFixed(1) };
}

/** O que de fato aconteceu no mesmo universo (saldo reconstruído/medido): referência, sem simulação. */
function realizado(bt) {
  const z = { A: [0, 0], T: [0, 0] }; let capital = 0;
  for (let t = bt.i0; t <= bt.i1; t++) {
    for (const u of bt.universo) {
      capital += Math.max(0, u.s.saldo[t]) * u.custo;
      let rec = 0; for (let i = t - 89; i <= t; i++) rec += u.s.dem[i];
      if (rec > 0) for (const g of u.classeInicial === 'A' ? ['A', 'T'] : ['T']) { z[g][1]++; if (u.s.saldo[t] <= 0) z[g][0]++; }
    }
  }
  return { estoque_medio: Math.round(capital / (bt.i1 - bt.i0 + 1)), ruptura_A_pct: +(z.A[0] / z.A[1] * 100).toFixed(1), ruptura_pct: +(z.T[0] / z.T[1] * 100).toFixed(1) };
}

// ── (3) investimento hoje por nível ─────────────────────────────────────────────────────────────────────────────
function investimentoHoje(ent, extra = {}) {
  const casos = { 'padrao_por_classe': {}, 'nivel_90': { nivel_servico: niveis(0.90) }, 'nivel_95': { nivel_servico: niveis(0.95) }, 'nivel_97': { nivel_servico: niveis(0.97) }, 'nivel_98': { nivel_servico: niveis(0.98) },
    'padrao_sem_seguranca': { seguranca: { teto_dias: { A: 0, B: 0, C: 0 } } }, 'padrao_sem_correcao': { demanda: { censura: { aplicar: false } } },
    'prazo_x0_5': { __fator: 0.5 }, 'prazo_x1_5': { __fator: 1.5 }, 'prazo_x2': { __fator: 2 }, 'prazo_45_fixo': { __fixo: 45 }, 'prazo_60_fixo': { __fixo: 60 } };
  const base = S.calcularSombra(ent);
  const out = {};
  for (const [nome, c] of Object.entries(casos)) {
    const { __fator, __fixo, ...resto } = c;
    let porProduto = {};
    if (__fator || __fixo) for (const l of base.linhas) porProduto[l.product_id] = { prazo_dias: __fixo || Math.max(1, Math.round(l.prazo.dias * __fator)), prazo_desvio_dias: __fixo ? __fixo * 0.33 : l.prazo.desvio_dias * __fator };
    const r = S.calcularSombra(ent, { politica13: comConfig(POLITICA_1_3_SOMBRA, { ...resto, ...extra, produtos: porProduto }) });
    const f = x => ({ sugestoes: x.sugestoes_13, unidades: x.unidades_13, compra_agora: x.valor_13_cents / 100, protecao: x.protecao_13_cents / 100, seguranca: x.seguranca_investimento_cents / 100, estoque_medio_alvo: x.estoque_medio_alvo_cents / 100 });
    out[nome] = { total: f(r.resumo.total), A: f(r.resumo.por_classe.A), B: f(r.resumo.por_classe.B), C: f(r.resumo.por_classe.C) };
  }
  return out;
}

// ── (4) projeção: redistribuir sem aumentar o capital ───────────────────────────────────────────────────────────
function projetar(dados, ent, { repeticoes = 60, semanas = 52, demanda = 'recuperada' } = {}) {
  const r = S.calcularSombra(ent);
  const cfg = r.politica;
  const hoje = r.hoje;
  const series = K.montarSeries({ produtos: ent.produtos, fatosVenda: ent.vendas.flatMap(fatosDeVenda), comprasBrutas: ent.compras, snapshots: ent.snapshots, inicio: somarDias(hoje, -S.DIAS_DE_SERIE), hoje });
  const t = series.n - 2;                                                      // último dia completo
  const itens = r.linhas.map(l => {
    const s = series.porId.get(l.product_id), f = K.caracteristicas(s, series, t, cfg);
    // blocos = as 26 semanas observadas; na premissa "recuperada" a média diária passa a ser a previsão 1.3 (falta corrigida, com teto)
    let blocos = [];
    for (let j = 0; j < 26; j++) { const fim = t - 7 * j, dias = []; for (let i = fim - 6; i <= fim; i++) dias.push(s.dem[i]); blocos.push(dias); }
    if (demanda === 'recuperada') {
      const m = soma(blocos, b => soma(b)) / (26 * 7), v = l.previsao.v;
      blocos = m > 0 ? blocos.map(b => b.map(x => x * v / m)) : [Array(7).fill(v)];
    }
    const custo = (l.custo_cents || 0) / 100;
    return { id: l.product_id, l, f, custo, preco: (l.preco_cents || 0) / 100, classe: l.classe, vendeu: f.curta.u > 0 || l.estado === 'REVISAR_RUPTURA_LONGA', blocos,
      v13: l.previsao.v, v12: l.v12.velocidade || 0, estoque: Math.max(0, l.estoque || 0), abcRec: l.abc.receita };
  });
  const emp = dados.empiricos, dias = semanas * 7, C0 = soma(itens, i => i.estoque * i.custo);
  const excesso0 = soma(itens, i => Math.max(0, i.estoque - i.v13 * cfg.excesso_dias) * i.custo);
  const cenarios = { regra_12: { politica: '12' }, regra_13_sem_teto: { politica: '13' }, regra_13_capital_travado: { politica: '13', teto: C0 },
    travado_mais_escoamento_5pct_mes: { politica: '13', teto: C0, escoa: 0.05 }, travado_mais_escoamento_10pct_mes: { politica: '13', teto: C0, escoa: 0.10 },
    travado_prazo_dobrado: { politica: '13', teto: C0, fatorPrazo: 2 }, travado_com_ponte_30mil_8_semanas: { politica: '13', teto: C0, ponte: 30000 }, travado_com_ponte_60mil_8_semanas: { politica: '13', teto: C0, ponte: 60000 } };
  const marcos = [1, 2, 3, 6, 9, 12], porMes = Math.floor(dias / 12);
  const out = {};
  for (const [nome, c] of Object.entries(cenarios)) {
    const acc = marcos.map(() => ({ estoque: 0, transito: 0, excesso: 0, demA: 0, atA: 0, dem: 0, at: 0, zA: 0, nA: 0, zE: 0, nE: 0, compras: 0, escoado: 0, n: 0 }));
    for (let rep = 0; rep < repeticoes; rep++) {
      const est = itens.map(i => i.estoque), fila = itens.map(() => []);
      let compras = 0, escoado = 0, mes = { demA: 0, atA: 0, dem: 0, at: 0, zA: 0, nA: 0, zE: 0, nE: 0 };
      const blocoAtual = itens.map(() => null);
      for (let d = 0; d < porMes * 12; d++) {
        for (let k = 0; k < itens.length; k++) { const q = fila[k]; for (let j = q.length - 1; j >= 0; j--) if (q[j][0] <= d) { est[k] += q[j][1]; q.splice(j, 1); } }
        if (d % 7 === 0) {
          const pedir = [];
          for (let k = 0; k < itens.length; k++) {
            const it = itens[k], l = it.l;
            blocoAtual[k] = it.blocos[Math.floor(sorteio('dem', rep, it.id, d) * it.blocos.length)];
            const pos = soma(fila[k], o => o[1]);
            if (c.politica === '12') {
              if (l.estado !== 'ELEGIVEL' || fila[k].length) continue;
              const q = K.quantidade12({ velocidade: it.v12, classeReceita: it.abcRec, estoque: est[k], politica12: POLITICA_1_2 });
              if (q > 0) pedir.push({ k, q });
            } else {
              if (l.estado !== 'ELEGIVEL') continue;                         // revisão manual não é comprada automaticamente
              const x = l.decisao, p = pos + est[k];
              if (!(x.velocidade > 0) || !(p < x.ponto_reposicao)) continue;
              const q = K.arredondarEmbalagem(Math.ceil(x.estoque_alvo - p - 1e-9), x.embalagem);
              pedir.push({ k, q, prot: Math.min(q, K.arredondarEmbalagem(Math.ceil(x.ponto_reposicao - p - 1e-9), x.embalagem)), x, p });
            }
          }
          let lista = pedir;
          if (c.teto) {
            const ocupado = itens.reduce((s, it, k) => s + (est[k] + soma(fila[k], o => o[1])) * it.custo, 0);
            const al = K.alocarCapital(pedir.map(o => ({ id: String(o.k), classe: itens[o.k].classe, custo_cents: Math.round(itens[o.k].custo * 100), margem_unit_cents: Math.round((itens[o.k].preco - itens[o.k].custo) * 100), velocidade: o.x.velocidade,
              qtd_sugerida: o.q, qtd_protecao: o.prot, ponto_reposicao: o.x.ponto_reposicao, posicao: o.p, embalagem: o.x.embalagem })), Math.max(0, Math.round((c.teto + (d < 56 ? c.ponte || 0 : 0) - ocupado) * 100)), cfg);
            lista = pedir.map(o => ({ k: o.k, q: al.alocado.get(String(o.k)) })).filter(o => o.q > 0);
          }
          for (const o of lista) { const L = emp[Math.floor(sorteio('L', rep, itens[o.k].id, d) * emp.length)] * (c.fatorPrazo || 1); fila[o.k].push([d + L, o.q]); compras += o.q * itens[o.k].custo; }
        }
        for (let k = 0; k < itens.length; k++) {
          const it = itens[k], dem = blocoAtual[k][d % 7], v = Math.min(est[k], dem);
          est[k] -= v; mes.dem += dem; mes.at += v;
          if (it.classe === 'A' && it.vendeu) { mes.demA += dem; mes.atA += v; mes.nA++; if (est[k] <= 0) mes.zA++; if (it.l.estado === 'ELEGIVEL') { mes.nE++; if (est[k] <= 0) mes.zE++; } }
          if (c.escoa) { const ex = Math.max(0, est[k] - it.v13 * cfg.excesso_dias); if (ex > 0) { const sai = ex * (1 - Math.pow(1 - c.escoa, 1 / porMes)); est[k] -= sai; escoado += sai * it.custo; } }
        }
        if ((d + 1) % porMes === 0) {
          const n = (d + 1) / porMes, j = marcos.indexOf(n);
          if (j >= 0) {
            const a = acc[j];
            a.estoque += itens.reduce((s, it, k) => s + est[k] * it.custo, 0);
            a.transito += itens.reduce((s, it, k) => s + soma(fila[k], o => o[1]) * it.custo, 0);
            a.excesso += itens.reduce((s, it, k) => s + Math.max(0, est[k] - it.v13 * cfg.excesso_dias) * it.custo, 0);
            for (const key of ['demA', 'atA', 'dem', 'at', 'zA', 'nA', 'zE', 'nE']) a[key] += mes[key];
            a.compras += compras; a.escoado += escoado; a.n++;
          }
          mes = { demA: 0, atA: 0, dem: 0, at: 0, zA: 0, nA: 0, zE: 0, nE: 0 };
        }
      }
    }
    out[nome] = marcos.map((mm, j) => { const a = acc[j]; return { mes: mm, estoque: Math.round(a.estoque / a.n), transito: Math.round(a.transito / a.n), capital_total: Math.round((a.estoque + a.transito) / a.n), excesso: Math.round(a.excesso / a.n),
      ruptura_A_pct: +(a.zA / a.nA * 100).toFixed(1), ruptura_A_elegiveis_pct: +(a.zE / a.nE * 100).toFixed(1), fill_A_pct: +(a.atA / a.demA * 100).toFixed(1), fill_pct: +(a.at / a.dem * 100).toFixed(1), compras_acumuladas: Math.round(a.compras / a.n), escoado_acumulado: Math.round(a.escoado / a.n) }; });
  }
  // escoamento natural do excesso ao ritmo atual (sem nova compra desses itens)
  const natural = [1, 3, 6, 12, 24].map(meses => ({ meses, excesso_restante: Math.round(soma(itens, i => Math.max(0, i.estoque - i.v13 * cfg.excesso_dias - i.v13 * meses * 30.4) * i.custo)),
    cmv_potencial_dos_itens_com_excesso: Math.round(soma(itens, i => { const ex = Math.max(0, i.estoque - i.v13 * cfg.excesso_dias); return ex > 0 ? Math.min(i.estoque, i.v13 * meses * 30.4) * i.custo : 0; })) }));
  // quadro de hoje: o que falta nos itens abaixo do ponto de reposição, por classe
  const hojeAbaixo = Object.fromEntries(CLS.map(cl => { const a = r.linhas.filter(l => l.classe === cl && l.estado === 'ELEGIVEL' && l.decisao.pedir);
    return [cl, { produtos: a.length, zerados: a.filter(l => l.estoque <= 0).length, protecao: Math.round(soma(a, l => l.decisao.qtd_protecao * (l.custo_cents || 0)) / 100), ate_o_alvo: Math.round(soma(a, l => l.decisao.qtd_sugerida * (l.custo_cents || 0)) / 100) }]; }));
  const custoMensalDemanda = Math.round(soma(itens, i => soma(i.blocos, b => soma(b)) / (i.blocos.length * 7) * 30.4 * i.custo));
  return { hoje_abaixo_do_ponto: hojeAbaixo, custo_mensal_da_demanda_simulada: custoMensalDemanda, capital_inicial: Math.round(C0), excesso_inicial: Math.round(excesso0), excesso_sem_venda_90d: Math.round(soma(itens, i => (i.v13 > 0 ? 0 : i.estoque * i.custo))), escoamento_natural: natural, cenarios: out };
}

function principal(argv = process.argv.slice(2)) {
  const a = argumentos(argv);
  if (typeof a['de-arquivo'] !== 'string') throw new Error('INFORME --de-arquivo <pasta>');
  const dados = preparar(a['de-arquivo']);
  dados.empiricos = prazosEmpiricos(dados.ent.compras);
  const cfg = POLITICA_1_3_SOMBRA;
  const q = p => dados.empiricos[Math.floor(p * (dados.empiricos.length - 1))];
  const saida = { janela: [INICIO_AVAL, FIM_AVAL], prazo_empirico: { n: dados.empiricos.length, p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), media: +(soma(dados.empiricos) / dados.empiricos.length).toFixed(1) } };
  saida.previsao = testePrevisao(dados, cfg);
  const bt = montarBacktest(dados, cfg);
  saida.universo = { produtos: bt.universo.length, A: bt.universo.filter(u => u.classeInicial === 'A').length, B: bt.universo.filter(u => u.classeInicial === 'B').length, C: bt.universo.filter(u => u.classeInicial === 'C').length, estoque_inicial: Math.round(soma(bt.universo, u => u.estoque0 * u.custo)) };
  const lv = p => comConfig(cfg, { nivel_servico: niveis(p) });
  const politicas = {
    '1.2 atual': { politica: '12' }, '1.2 descontando em trânsito': { politica: '12pos' }, '1.2 com dias x2 (só referência)': { politica: '12', mult12: 2 }, '1.2 com dias x3 (só referência)': { politica: '12', mult12: 3 },
    '1.3 só prazo + trânsito': { politica: '13', cfg: comConfig(cfg, { seguranca: { teto_dias: { A: 0, B: 0, C: 0 } } }), semCensura: true },
    '1.3 sem correção de falta': { politica: '13', cfg, semCensura: true }, '1.3 padrão (por classe)': { politica: '13', cfg },
    '1.3 nível 90': { politica: '13', cfg: lv(0.90) }, '1.3 nível 95': { politica: '13', cfg: lv(0.95) }, '1.3 nível 97': { politica: '13', cfg: lv(0.97) }, '1.3 nível 98': { politica: '13', cfg: lv(0.98) },
    '1.3 padrão, capital travado no inicial': { politica: '13', cfg, capital: 'INICIAL' },
    '1.3 ciclo pela metade': { politica: '13', cfg: comConfig(cfg, { ciclo_dias: { A: 15, B: 10.5, C: 7.5 } }) },
    '1.2 em trânsito, dias x2 (só referência)': { politica: '12pos', mult12: 2 }, '1.2 em trânsito, dias x2,5 (só referência)': { politica: '12pos', mult12: 2.5 }, '1.2 em trânsito, dias x3 (só referência)': { politica: '12pos', mult12: 3 },
  };
  saida.realizado = realizado(bt);
  politicas['1.3 padrão, capital travado no médio realizado'] = { politica: '13', cfg, capital: saida.realizado.estoque_medio };
  saida.backtest = {};
  for (const [nome, p] of Object.entries(politicas)) saida.backtest[nome] = simular(bt, dados, { ...p, prazoReal: 'empirico' });
  saida.sensibilidade_prazo = {};
  const chaves = ['1.2 atual', '1.3 padrão (por classe)', '1.3 nível 90', '1.3 nível 95', '1.3 nível 97', '1.3 nível 98', '1.3 padrão, capital travado no inicial', '1.3 padrão, capital travado no médio realizado', '1.3 ciclo pela metade', '1.2 em trânsito, dias x2,5 (só referência)', '1.2 em trânsito, dias x3 (só referência)'];
  for (const L of [7, 14, 21, 30, 45]) saida.sensibilidade_prazo['real_' + L] = Object.fromEntries(chaves.map(n => [n, simular(bt, dados, { ...politicas[n], prazoReal: L })]));
  for (const L of [30, 45]) {   // prazo conhecido pela política (cadastrado)
    const prod = Object.fromEntries(bt.universo.map(u => [u.p.product_id, { prazo_dias: L, prazo_desvio_dias: L * 0.25 }]));
    const cfgL = comConfig(cfg, { produtos: prod });
    const bt2 = montarBacktest(dados, cfgL);
    saida.sensibilidade_prazo['real_' + L + '_cadastrado'] = { '1.3 padrão (por classe)': simular(bt2, dados, { politica: '13', cfg: cfgL, prazoReal: L }) };
  }
  saida.demanda_descensurada = Object.fromEntries([...chaves, '1.3 sem correção de falta', '1.2 em trânsito, dias x2 (só referência)'].map(n => [n, simular(bt, dados, { ...politicas[n], prazoReal: 'empirico', demandaDescensurada: true })]));
  saida.investimento_hoje = investimentoHoje(dados.ent);
  saida.projecao = projetar(dados, dados.ent);
  saida.projecao_demanda_observada = projetar(dados, dados.ent, { demanda: 'observada' });
  if (typeof a.saida === 'string') fs.writeFileSync(a.saida, JSON.stringify(saida, null, 1));
  else console.log(JSON.stringify(saida, null, 1));
  return saida;
}

if (require.main === module) principal();
module.exports = { principal, preparar, prazosEmpiricos, sorteio, montarBacktest, simular, realizado, testePrevisao, investimentoHoje, projetar };
