#!/usr/bin/env node
'use strict';
/**
 * Compras — análise da Política 1.4 (SOMBRA). Só lê cópias locais; nunca acessa nem grava no Firestore.
 *   node scripts/compras_backtest_14.js --de-arquivo <pasta> --saida <pasta> [--origem <04C.csv>] [--partes hoje,ajuste,fronteira,sensibilidade]
 * hoje          orçamentos de compra imediata (1.4 × 1.2 × 1.3 × "dias × 2,5" no MESMO valor), cenários e curva marginal
 * ajuste        escolha de parâmetros da 1.4 na 1ª metade de 2026, conferida na 2ª metade
 * fronteira     backtest 05/01–25/11/2026 SEM vazamento de futuro: capital médio × atendimento por família de regra
 * sensibilidade prazo real, demanda reprimida e pedido mínimo por fornecedor
 * resumir       refaz as tabelas derivadas (mesmo capital, retornos decrescentes) de uma execução já salva
 */
const fs = require('fs');
const path = require('path');
const { diffDias } = require('../lib/compras/canonico');
const { POLITICA_1_2 } = require('../lib/compras/politica');
const { POLITICA_1_3_SOMBRA: P13, comConfig } = require('../lib/compras/politica13');
const K = require('../lib/compras/calculadora13');
const A = require('../lib/compras/alocacao14');
const S14 = require('../lib/compras/sombra14');
const B13 = require('./compras_backtest_13');
const { argumentos } = require('./compras_sombra_13');
const { lerLocal, configDaGeracao } = require('./compras_sombra_14');

const CLS = ['A', 'B', 'C'];
const soma = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
const r1 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const CORTE_METADE = '2026-07-01';

// ── preparo: fatos de cada revisão com dados SÓ até a véspera ───────────────────────────────────────────────────
function montar(pasta) {
  const dados = B13.preparar(pasta);
  dados.empiricos = B13.prazosEmpiricos(dados.ent.compras);
  return montarDe(dados);
}
function montarDe(dados) {
  const bt = B13.montarBacktest(dados, P13);
  const G = S14.GERACAO.crescimento;
  bt.itens14 = new Map(bt.revisoes.map(t => {
    const mapa = bt.fatos.get(t);
    return [t, bt.universo.map(u => {
      const id = u.p.product_id, x = mapa.get(id), novo = x.eleg.produto_novo;
      // sinal de crescimento calculado como estava na véspera
      const ant = K.caracteristicas(u.s, dados.series, t - 1 - G.janela_dias, P13);
      let g = 1;
      if (ant.obs !== null && ant.obs >= G.janela_dias && x.f.curta.diasVenda >= G.min_dias_com_venda && ant.curta.diasVenda >= G.min_dias_com_venda && x.f.curta.disp >= G.min_dias_disponiveis && ant.curta.disp >= G.min_dias_disponiveis) {
        const va = x.prev.v, vb = K.prever(ant, P13).v;
        if (vb > 0 && va / vb >= G.razao_minima) g = 1 + Math.min(G.teto, G.inclinacao * (va / vb - 1));
      }
      return { id, classe: x.abc.classe, xyz: x.variab.xyz, estado: x.eleg.elegivel ? 'ELEGIVEL' : 'FORA_DA_REPOSICAO', fornecedor_id: x.prazo.fornecedor_id,
        custo_cents: Math.round(u.custo * 100), preco_cents: Math.round(x.f.preco_cents || 0),
        v: novo ? x.eleg.velocidade_novo : x.prev.v, v_observada: novo ? x.eleg.velocidade_novo : x.prev.v_observada, sd_dia: x.variab.desvio_semanal_ajustado / Math.sqrt(7),
        esporadico: x.variab.semanas_com_venda < P13.seguranca.min_semanas_com_venda, novo, prazo_dias: x.prazo.dias, prazo_desvio: x.prazo.desvio_dias, prazo_fonte: x.prazo.fonte,
        crescimento_fator: g, origem_comprovada: true, transito: {} };
    })];
  }));
  return { dados, bt };
}

// ── pedido que cada regra faria na revisão, respeitando o dinheiro disponível ───────────────────────────────────
/** Regras simples sem dinheiro para tudo: ruptura e curva A primeiro, depois menor cobertura. */
function porUrgencia(pedidos, resta) {
  pedidos.sort((a, b) => a.grupo - b.grupo || a.cobertura - b.cobertura || a.k - b.k);
  for (const o of pedidos) { const q = o.custo > 0 ? Math.min(o.q, Math.floor(resta / o.custo + 1e-9)) : o.q; o.q = Math.max(0, q); resta -= o.q * o.custo; }
  return pedidos.filter(o => o.q > 0);
}
/** Alternativa simples de orçamento: cada item leva a mesma fração do que pediu; a sobra do arredondamento vai por urgência. */
function rateado(pedidos, resta) {
  const total = soma(pedidos, o => o.q * o.custo);
  if (total <= resta) return pedidos;
  const pedido = pedidos.map(o => o.q), f = Math.max(0, resta) / total;
  for (const o of pedidos) o.q = Math.floor(o.q * f + 1e-9);
  let sobra = resta - soma(pedidos, o => o.q * o.custo);
  const ordem = pedidos.map((o, i) => [o, pedido[i]]).sort(([a], [b]) => a.grupo - b.grupo || a.cobertura - b.cobertura || a.k - b.k);
  for (const [o, q0] of ordem) { const mais = o.custo > 0 ? Math.max(0, Math.min(q0 - o.q, Math.floor(sobra / o.custo + 1e-9))) : 0; o.q += mais; sobra -= mais * o.custo; }
  return pedidos.filter(o => o.q > 0);
}
function semPequenos(lista, minimo) {
  if (!(minimo > 0)) return lista;
  const total = new Map();
  for (const o of lista) total.set(o.forn, (total.get(o.forn) || 0) + o.q * o.custo);
  return lista.filter(o => !o.forn || total.get(o.forn) >= minimo);
}

/**
 * c = { politica: '12' | 'dias' | '13' | '14', k, ciclo13, cfg14, orcSemana (R$), teto (R$ estoque + a caminho), rateio (regras simples: dividir o dinheiro),
 *       prazoReal: 'empirico' | dias, descensurada, minimoForn (R$), prazoCadastrado }
 */
function simular(m, c) {
  const { dados, bt } = m, { universo, revisoes, fatos, i0, i1 } = bt, emp = dados.empiricos;
  const n = universo.length;
  const est = universo.map(u => u.estoque0), fila = universo.map(() => []);
  const rev = new Set(revisoes), corte = diffDias(dados.series.inicio, CORTE_METADE);
  const zero = () => ({ dem: 0, atendida: 0, diasComDemanda: 0, diasZerado: 0, margemPerdida: 0, estoque: 0, transito: 0, dias: 0, excesso: 0, diasExc: 0, linhas: 0, pedidosForn: 0, comprado: 0, revisoes: 0, demA: 0, atA: 0, zA: 0, nA: 0 });
  const per = { total: zero(), m1: zero(), m2: zero() };
  let capitalMax = 0;
  const futuro = universo.map(u => { const a = new Float64Array(i1 + 2); for (let i = i1; i >= 0; i--) a[i] = a[i + 1] + u.s.dem[i]; return a; });
  const ultimaPrev = universo.map(() => 0);
  const prazoReal = (k, t) => (c.prazoReal === undefined || c.prazoReal === 'empirico' ? emp[Math.floor(B13.sorteio('prazo', universo[k].p.product_id, t) * emp.length)] : c.prazoReal);
  const cfg13 = c.ciclo13 === undefined ? P13 : comConfig(P13, { ciclo_dias: Object.fromEntries(CLS.map(a => [a, Math.max(0.01, P13.ciclo_dias[a] * c.ciclo13)])) });
  const cfg14 = c.politica === '14' ? A.configurar({ ...(c.cfg14 || {}), origem: 'INCLUIR', ...(c.minimoForn ? { minimo_fornecedor: { modo: 'CADASTRADO', valor_padrao_cents: c.minimoForn * 100 } } : { minimo_fornecedor: { modo: 'NENHUM' } }) }) : null;

  for (let t = i0; t <= i1; t++) {
    const alvos = [per.total, dados.series.datas[t] < CORTE_METADE ? per.m1 : per.m2];
    for (let k = 0; k < n; k++) { const q = fila[k]; for (let j = q.length - 1; j >= 0; j--) if (q[j][0] <= t) { est[k] += q[j][1]; q.splice(j, 1); } }
    if (rev.has(t)) {
      const mapa = fatos.get(t), ocupado = universo.reduce((s, u, k) => s + (est[k] + soma(fila[k], o => o[1])) * u.custo, 0);
      let resta = Math.min(c.orcSemana ?? Infinity, c.teto ? Math.max(0, c.teto - ocupado) : Infinity);
      let lista = [];
      const prazoDe = x => (c.prazoCadastrado ? { ...x.prazo, dias: c.prazoCadastrado, desvio_dias: c.prazoCadastrado * 0.25, fonte: 'CONFIG_PRODUTO' } : x.prazo);
      if (c.politica === '14') {
        const itens = bt.itens14.get(t), prontos = [], indice = new Map();
        for (let k = 0; k < n; k++) {
          const it = itens[k];
          ultimaPrev[k] = mapa.get(it.id).prev.v;
          if (it.estado !== 'ELEGIVEL') continue;
          const item = { ...it, estoque: est[k], transito: { recente: soma(fila[k], o => o[1]) }, ...(c.prazoCadastrado ? { prazo_dias: c.prazoCadastrado, prazo_desvio: c.prazoCadastrado * 0.25 } : {}) };
          prontos.push(A.preparar(item, cfg14)); indice.set(it.id, k);
        }
        prontos.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const al = A.alocar(prontos, { ...cfg14, orcamento_cents: resta === Infinity ? null : Math.floor(resta * 100) }, {});
        for (const p of prontos) { const q = al.qtd.get(p.id) || 0; if (q > 0) { const k = indice.get(p.id); lista.push({ k, q, custo: universo[k].custo, forn: p.fornecedor }); } }
      } else {
        const pedir = [];
        for (let k = 0; k < n; k++) {
          const u = universo[k], x = mapa.get(u.p.product_id);
          ultimaPrev[k] = x.prev.v;
          if (!x.eleg.elegivel) continue;
          const pos = soma(fila[k], o => o[1]);
          if (c.politica === '12' || c.politica === 'dias') {
            if (c.politica === '12' && fila[k].length) continue;          // premissa: comprador não repete pedido em aberto
            const v = x.eleg.produto_novo ? x.eleg.velocidade_novo : x.f.v_ingenua;
            const mult = c.politica === 'dias' ? c.k : 1;
            const pol = mult !== 1 ? { ...POLITICA_1_2, target_days: Object.fromEntries(CLS.map(a => [a, POLITICA_1_2.target_days[a] * mult])) } : POLITICA_1_2;
            const posicao = est[k] + (c.politica === 'dias' ? pos : 0);
            const q = K.quantidade12({ velocidade: v, classeReceita: x.abc.receita, estoque: posicao, politica12: pol });
            if (q > 0) { const cl = x.abc.receita === 'SEM_VENDA' ? 'C' : x.abc.receita; pedir.push({ k, q, custo: u.custo, forn: x.prazo.fornecedor_id, grupo: cl === 'A' ? (posicao <= 0 ? 1 : 2) : cl === 'B' && posicao <= 0 ? 3 : 4, cobertura: v > 0 ? posicao / v : 1e9 }); }
          } else {
            const d = K.decidir({ id: u.p.product_id, f: x.f, previsao: x.prev, variab: x.variab, classe: x.abc.classe, prazo: prazoDe(x), estoque: est[k], transito: pos, cfg: cfg13, velocidadeFixa: x.eleg.produto_novo ? x.eleg.velocidade_novo : null });
            if (d.qtd_sugerida > 0) pedir.push({ k, q: d.qtd_sugerida, custo: u.custo, forn: x.prazo.fornecedor_id, d, x });
          }
        }
        if (c.politica === '13') {
          if (resta !== Infinity) {
            const al = K.alocarCapital(pedir.map(o => ({ id: String(o.k), classe: o.d.classe, custo_cents: Math.round(o.custo * 100), margem_unit_cents: Math.round((o.x.f.preco_cents || 0) - o.custo * 100), velocidade: o.d.velocidade,
              qtd_sugerida: o.d.qtd_sugerida, qtd_protecao: o.d.qtd_protecao, ponto_reposicao: o.d.ponto_reposicao, posicao: o.d.posicao, embalagem: o.d.embalagem })), Math.floor(resta * 100), cfg13);
            lista = pedir.map(o => ({ ...o, q: al.alocado.get(String(o.k)) })).filter(o => o.q > 0);
          } else lista = pedir;
        } else lista = resta === Infinity ? pedir : c.rateio ? rateado(pedir, resta) : porUrgencia(pedir, resta);
        lista = semPequenos(lista, c.minimoForn);
      }
      const forns = new Set();
      for (const o of lista) { fila[o.k].push([t + prazoReal(o.k, t), o.q]); forns.add(o.forn || 'SEM'); }
      for (const g of alvos) { g.linhas += lista.length; g.pedidosForn += forns.size; g.comprado += soma(lista, o => o.q * universo[o.k].custo); g.revisoes++; }
    }
    let cap = 0, tr = 0, exc = 0;
    for (let k = 0; k < n; k++) {
      const u = universo[k];
      let d = u.s.dem[t];
      if (c.descensurada && K.indisponivel(u.s, t)) d += ultimaPrev[k];
      const v = Math.min(est[k], d); est[k] -= v;
      const rec90 = futuro[k][Math.max(0, t - 89)] - futuro[k][t + 1];
      const A_ = u.classeInicial === 'A';
      for (const g of alvos) {
        g.dem += d; g.atendida += v; g.margemPerdida += (d - v) * u.margem;
        if (rec90 > 0) { g.diasComDemanda++; if (est[k] <= 0) g.diasZerado++; }
        if (A_) { g.demA += d; g.atA += v; if (rec90 > 0) { g.nA++; if (est[k] <= 0) g.zA++; } }
      }
      cap += est[k] * u.custo; tr += soma(fila[k], o => o[1]) * u.custo;
      if (t + 90 <= i1) exc += Math.max(0, est[k] - (futuro[k][t + 1] - futuro[k][t + 91])) * u.custo;
    }
    capitalMax = Math.max(capitalMax, cap + tr);
    for (const g of alvos) { g.estoque += cap; g.transito += tr; g.dias++; if (t + 90 <= i1) { g.excesso += exc; g.diasExc++; } }
  }
  const fechar = g => ({ atendido_pct: r1(100 * g.atendida / g.dem), atendido_A_pct: r1(100 * g.atA / g.demA), falta_pct: r1(100 * g.diasZerado / g.diasComDemanda), falta_A_pct: r1(100 * g.zA / g.nA),
    estoque_medio: Math.round(g.estoque / g.dias), transito_medio: Math.round(g.transito / g.dias), capital_medio: Math.round((g.estoque + g.transito) / g.dias),
    excesso_medio: g.diasExc ? Math.round(g.excesso / g.diasExc) : null, margem_perdida: Math.round(g.margemPerdida), compra_total: Math.round(g.comprado), compra_semana: Math.round(g.comprado / Math.max(1, g.revisoes)),
    linhas: g.linhas, pedidos_fornecedor: g.pedidosForn, margem_perdida_ano: Math.round(g.margemPerdida * 365 / g.dias) });
  return { ...fechar(per.total), capital_pico: Math.round(capitalMax), metade1: fechar(per.m1), metade2: fechar(per.m2) };
}

// ── fronteira: interpolação ao MESMO capital médio ──────────────────────────────────────────────────────────────
/**
 * Fronteira eficiente de uma família: envoltória dos pontos (capital médio × indicador), a melhor linha que se obtém
 * combinando as configurações simuladas. Mesmo tratamento para todas as famílias; só vai até o melhor ponto de cada uma.
 */
function fronteira(pontos, x = 'capital_medio', y = 'atendido_pct', maiorMelhor = true) {
  const sinal = maiorMelhor ? 1 : -1;
  const o = pontos.map(p => [p[x], sinal * p[y]]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const melhores = [];
  for (const p of o) { const u = melhores[melhores.length - 1]; if (!u || p[1] > u[1]) { if (u && u[0] === p[0]) melhores.pop(); melhores.push(p); } }
  const casco = [];
  const abaixo = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0;   // b não fica acima da reta a–c
  for (const p of melhores) { while (casco.length >= 2 && abaixo(casco[casco.length - 2], casco[casco.length - 1], p)) casco.pop(); casco.push(p); }
  return casco.map(([a, b]) => [a, sinal * b]);
}
function noCapital(pontos, capital, y = 'atendido_pct', maiorMelhor = true) {
  const f = fronteira(pontos, 'capital_medio', y, maiorMelhor);
  if (!f.length || capital < f[0][0] || capital > f[f.length - 1][0]) return null;   // nunca extrapola
  for (let i = 1; i < f.length; i++) if (capital <= f[i][0]) { const [a, b] = [f[i - 1], f[i]]; return r1(a[1] + (b[1] - a[1]) * (capital - a[0]) / (b[0] - a[0] || 1)); }
  return r1(f[0][1]);
}
/**
 * Ponto de retornos decrescentes: menor capital a partir do qual TODA janela seguinte de +R$ 30 mil de capital médio rende,
 * por R$ 10 mil, menos que `limiar` ponto de atendimento (curva sobre a fronteira, sem extrapolar).
 */
function retornoDecrescente(pontos, { passo = 10000, janela = 3, limiar = 0.5, de = 200000, ate = 500000 } = {}) {
  const curva = [];
  for (let c = de; c <= ate; c += passo) { const v = noCapital(pontos, c); if (v !== null) curva.push([c, v]); }
  const ganhos = curva.slice(janela).map((p, i) => [curva[i][0], Math.round((p[1] - curva[i][1]) / janela * 100) / 100]);
  let ponto = null;
  for (let i = ganhos.length - 1; i >= 0 && ganhos[i][1] < limiar; i--) ponto = ganhos[i][0];
  return { limiar_pp_por_10mil: limiar, capital: ponto, curva, ganho_por_10mil_na_janela_seguinte: ganhos };
}

// ── famílias de regra ───────────────────────────────────────────────────────────────────────────────────────────
const cobertura = m => ({ cobertura_dias: { A: 30 * m, B: 21 * m, C: 15 * m } });
function familias(padrao14 = {}) {
  const f = [];
  const add = (familia, nome, c) => f.push({ familia, nome, c });
  add('1.2 atual', '1.2 como é hoje', { politica: '12' });
  for (const k of [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4]) add('dias x k', `dias x ${k}`, { politica: 'dias', k });
  for (const m of [0, 0.25, 0.5, 1, 1.5, 2, 3]) add('1.3', `1.3 ciclo x ${m}`, { politica: '13', ciclo13: m });
  for (const [fam, extra] of [['1.4', {}], ['1.4 com gatilho', { gatilho: 'PONTO' }]]) {
    for (const m of [0, 0.25, 0.5, 1, 1.5, 2, 3]) add(fam, `${fam} cobertura x ${m}`, { politica: '14', cfg14: { ...padrao14, ...extra, ...cobertura(m) } });
    for (const n of [0.6, 0.8]) for (const m of [0, 0.5]) add(fam, `${fam} nível ${n * 100}% cobertura x ${m}`, { politica: '14', cfg14: { ...padrao14, ...extra, ...cobertura(m), nivel_servico: n } });
  }
  for (const t of [225000, 250000, 275000, 300000, 350000]) {
    add('1.2 atual', `1.2 + teto de capital ${t / 1000} mil`, { politica: '12', teto: t });
    add('dias x k', `dias x 3 + teto de capital ${t / 1000} mil`, { politica: 'dias', k: 3, teto: t });
    for (const k of [1.5, 2.5]) add('dias x k', `dias x ${k} rateado + teto de capital ${t / 1000} mil`, { politica: 'dias', k, teto: t, rateio: true });
    add('1.3', `1.3 ciclo x 2 + teto de capital ${t / 1000} mil`, { politica: '13', ciclo13: 2, teto: t });
    add('1.4', `1.4 cobertura x 2 + teto de capital ${t / 1000} mil`, { politica: '14', cfg14: { ...padrao14, ...cobertura(2) }, teto: t });
    add('1.4 com gatilho', `1.4 com gatilho cobertura x 2 + teto de capital ${t / 1000} mil`, { politica: '14', cfg14: { ...padrao14, gatilho: 'PONTO', ...cobertura(2) }, teto: t });
  }
  return f;
}
/** Mesmo orçamento de compra por semana para todas as regras. */
function porOrcamento(padrao14 = {}) {
  const f = [];
  for (const o of [9000, 12000, 15000, 18000, 22000, 28000, 35000, 45000]) {
    f.push({ familia: '1.2 atual', nome: `1.2 · R$ ${o / 1000} mil/semana`, c: { politica: '12', orcSemana: o } });
    f.push({ familia: 'dias x k', nome: `dias x 2,5 · R$ ${o / 1000} mil/semana`, c: { politica: 'dias', k: 2.5, orcSemana: o } });
    for (const k of [1.5, 2.5]) f.push({ familia: 'dias x k', nome: `dias x ${k} rateado · R$ ${o / 1000} mil/semana`, c: { politica: 'dias', k, orcSemana: o, rateio: true } });
    f.push({ familia: '1.3', nome: `1.3 · R$ ${o / 1000} mil/semana`, c: { politica: '13', orcSemana: o } });
    f.push({ familia: '1.4', nome: `1.4 · R$ ${o / 1000} mil/semana`, c: { politica: '14', cfg14: padrao14, orcSemana: o } });
    f.push({ familia: '1.4 com gatilho', nome: `1.4 com gatilho · R$ ${o / 1000} mil/semana`, c: { politica: '14', cfg14: { ...padrao14, gatilho: 'PONTO' }, orcSemana: o } });
  }
  return f;
}
const CAPITAIS = [225000, 250000, 275000, 300000, 325000, 350000, 400000];
const FAMILIAS = ['1.2 atual', 'dias x k', '1.3', '1.4', '1.4 com gatilho'];
/**
 * Todos os indicadores no mesmo capital vêm da MESMA combinação: os dois pontos da fronteira de atendimento que cercam o
 * capital pedido, na proporção que o atinge. Fora do trecho simulado, fica vazio.
 */
function misturaNoCapital(pontos, capital) {
  const f = fronteira(pontos);
  if (!f.length || capital < f[0][0] || capital > f[f.length - 1][0]) return null;
  const achar = ([c, y]) => pontos.find(p => p.capital_medio === c && p.atendido_pct === y);
  const i = Math.max(1, f.findIndex(p => capital <= p[0]));
  const a = achar(f[i - 1]), b = achar(f[Math.min(i, f.length - 1)]);
  const w = b.capital_medio === a.capital_medio ? 0 : (capital - a.capital_medio) / (b.capital_medio - a.capital_medio);
  return k => (a[k] === null || b[k] === null || a[k] === undefined ? null : r1(a[k] + (b[k] - a[k]) * w));
}
const INDICADORES = ['atendido_pct', 'atendido_A_pct', 'falta_A_pct', 'margem_perdida_ano', 'excesso_medio', 'pedidos_fornecedor', 'linhas'];
function mesmoCapital(runs, recorte = r => r) {
  const out = [];
  for (const fam of FAMILIAS) {
    const pts = runs.filter(r => r.familia === fam).map(r => recorte(r.r));
    for (const cap of CAPITAIS) { const m = misturaNoCapital(pts, cap); out.push({ familia: fam, capital: cap, ...Object.fromEntries(INDICADORES.map(k => [k, m ? m(k) : null])) }); }
  }
  return out;
}

// ── ajuste de parâmetros: só a 1ª metade escolhe ────────────────────────────────────────────────────────────────
const IGUAL = Object.fromEntries(['AX', 'AY', 'AZ', 'BX', 'BY', 'BZ', 'CX', 'CY', 'CZ'].map(k => [k, 0.5]));
const M = { gatilho: 'MARGINAL' };
// Ponto de partida fixo (não muda quando o padrão do motor muda): uma mudança por vez e, depois, combinações sem gatilho.
const PARTIDA = { gatilho: 'PONTO', peso_antecipacao: 0.5, censura_peso: 1 };
const VARIANTES = {
  'partida: gatilho no ponto, antecipação 0,5, correção completa': {},
  'sem gatilho (marginal)': { ...M },
  'gatilho; antecipação 0': { peso_antecipacao: 0 },
  'gatilho; antecipação 1': { peso_antecipacao: 1 },
  'gatilho; peso de falta igual nas classes': { peso_indisponibilidade: IGUAL },
  'gatilho; sem sinal de crescimento': { crescimento: { usar: false } },
  'gatilho; sem correção de falta': { censura_peso: 0 },
  'gatilho; sem teto de segurança em dias': { seguranca_teto_dias: { A: 365, B: 365, C: 365 } },
  'marginal; antecipação 0': { ...M, peso_antecipacao: 0 },
  'marginal; antecipação 0,25': { ...M, peso_antecipacao: 0.25 },
  'marginal; antecipação 1': { ...M, peso_antecipacao: 1 },
  'marginal; meia correção de falta': { ...M, censura_peso: 0.5 },
  'marginal; sem correção de falta': { ...M, censura_peso: 0 },
  'marginal; antecipação 0,25; meia correção': { ...M, peso_antecipacao: 0.25, censura_peso: 0.5 },
  'marginal; sem sinal de crescimento': { ...M, crescimento: { usar: false } },
  'marginal; peso de falta igual nas classes': { ...M, peso_indisponibilidade: IGUAL },
  'marginal; peso de falta 3x': { ...M, peso_indisponibilidade: { AX: 3, AY: 2.4, AZ: 1.8, BX: 1.8, BY: 1.5, BZ: 1.2, CX: 0.9, CY: 0.6, CZ: 0.3 } },
  'marginal; custo por ruptura de produto R$ 50': { ...M, custo_ruptura_cents: 5000 },
  'marginal; custo por ruptura de produto R$ 200': { ...M, custo_ruptura_cents: 20000 },
};
const DIAIS = [{ m: 0, nivel: 0.6 }, { m: 0, nivel: 0.8 }, { m: 0 }, { m: 0.25 }, { m: 0.5 }, { m: 1 }, { m: 2 }];
const NIVEIS_AJUSTE = { metade1: [360000, 390000], metade2: [280000, 320000] };
function ajuste(m) {
  const runs = [];
  for (const [nome, v] of Object.entries(VARIANTES)) for (const d of DIAIS) for (const descensurada of [false, true]) runs.push({ variante: nome, dial: d, descensurada, r: simular(m, { politica: '14', descensurada, cfg14: { ...PARTIDA, ...v, ...cobertura(d.m), ...(d.nivel ? { nivel_servico: d.nivel } : {}) } }) });
  const tabela = [];
  for (const descensurada of [false, true]) for (const nome of Object.keys(VARIANTES)) {
    const linha = { demanda: descensurada ? 'com demanda reprimida somada' : 'observada', variante: nome };
    for (const [metade, niveis] of Object.entries(NIVEIS_AJUSTE)) {
      const pts = runs.filter(x => x.variante === nome && x.descensurada === descensurada).map(x => x.r[metade]);
      for (const cap of niveis) { const k = `${metade}_${cap / 1000}`; linha[k + '_atendido'] = noCapital(pts, cap); linha[k + '_falta_A'] = noCapital(pts, cap, 'falta_A_pct', false); }
    }
    const ref = runs.find(x => x.variante === nome && x.descensurada === descensurada && x.dial.m === 0.5);
    linha.linhas_cobertura_05 = ref.r.linhas; linha.pedidos_fornecedor_cobertura_05 = ref.r.pedidos_fornecedor;
    tabela.push(linha);
  }
  return { tabela, runs };
}

// ── hoje: orçamentos de compra imediata ─────────────────────────────────────────────────────────────────────────
const ORCAMENTOS = [40000, 50000, 60000, 80000, 100000, 120000, 150000, 191000];
function hoje(pasta, extra14 = {}, geracao = {}) {
  const ent = lerLocal(pasta), res = S14.calcular(ent, { config: geracao }), base = res.base;
  const l13 = new Map(base.linhas.map(l => [l.product_id, l]));
  const cfg = A.configurar(extra14);
  const prontos = res.itens.map(i => A.preparar(i, cfg)), porId = new Map(prontos.map(p => [p.id, p])), medidores = new Map();
  const liberado = p => p.item.estado === 'ELEGIVEL' && p.item.origem_comprovada && p.margem > 0 && p.custo > 0;
  // quantidades das regras alternativas (mesmo universo liberado), com o mesmo dinheiro
  const simples = k => prontos.filter(liberado).map(p => {
    const l = l13.get(p.id), v = l.v12.velocidade, cl = l.v12.classe, pos = Math.max(0, l.estoque) + (k ? p.transito.recente : 0);
    if (l.exclusoes.length) return null;
    const pol = k ? { ...POLITICA_1_2, target_days: Object.fromEntries(CLS.map(a => [a, POLITICA_1_2.target_days[a] * k])) } : POLITICA_1_2;
    const q = k ? K.quantidade12({ velocidade: v, classeReceita: cl, estoque: pos, politica12: pol }) : l.v12.qtd;
    const c = cl === 'SEM_VENDA' ? 'C' : cl;
    return q > 0 ? { k: p.id, q, custo: p.custo / 100, grupo: c === 'A' ? (pos <= 0 ? 1 : 2) : c === 'B' && pos <= 0 ? 3 : 4, cobertura: v > 0 ? pos / v : 1e9 } : null;
  }).filter(Boolean);
  const regras = {
    '1.4': o => A.alocar(prontos, { ...cfg, orcamento_cents: o }, res.fornecedores).qtd,
    '1.3 com teto': o => { const itens = prontos.filter(liberado).map(p => l13.get(p.id)).filter(l => l.decisao.qtd_sugerida > 0);
      const al = K.alocarCapital(itens.map(l => ({ id: l.product_id, classe: l.classe, custo_cents: l.custo_cents, margem_unit_cents: (l.preco_cents || 0) - l.custo_cents, velocidade: l.decisao.velocidade, qtd_sugerida: l.decisao.qtd_sugerida, qtd_protecao: l.decisao.qtd_protecao, ponto_reposicao: l.decisao.ponto_reposicao, posicao: l.decisao.posicao, embalagem: l.decisao.embalagem })), o === null ? 1e15 : o, P13);
      return al.alocado; },
    '1.2 com teto': o => new Map(porUrgencia(simples(0), o === null ? Infinity : o / 100).map(x => [x.k, x.q])),
    'dias x 2,5 com teto': o => new Map(porUrgencia(simples(2.5), o === null ? Infinity : o / 100).map(x => [x.k, x.q])),
  };
  const medir = qtd => A.avaliar(prontos, qtd, cfg, medidores);
  const semCompra = medir(new Map());
  const tabela = [];
  for (const o of ORCAMENTOS) for (const [regra, f] of Object.entries(regras)) tabela.push({ orcamento: o, regra, ...medir(f(o * 100)) });
  const semTeto = Object.entries(regras).map(([regra, f]) => ({ orcamento: null, regra, ...medir(f(null)) }));
  const curva = [];
  for (let o = 0; o <= 220000; o += 10000) { const q = A.alocar(prontos, { ...cfg, orcamento_cents: o * 100 }, res.fornecedores); const x = medir(q.qtd); curva.push({ orcamento: o, capital: x.capital_cents / 100, atendimento: x.atendimento_pct, atendimento_A: x.atendimento_A_pct, rupturas: x.rupturas_previstas, disp_A: x.disponibilidade_A_pct, margem: x.margem_preservada_cents / 100, excesso_90d: x.excesso_90d_cents / 100, retorno_marginal: q.retorno_marginal, forn: x.pedidos_fornecedores, produtos: x.produtos_contemplados }); }
  const cenarios = {
    'base (antigos ignorados)': {}, 'antigos: receber 50%': { transito: { antigos: 'PARCIAL' } }, 'antigos: receber tudo': { transito: { antigos: 'TUDO' } },
    'incluir compras sem origem comprovada': { origem: 'INCLUIR' }, 'pedido mínimo = pedido típico baixo (p10) por fornecedor': { minimo_fornecedor: { modo: 'HISTORICO_P10' } },
    'pedido mínimo R$ 1.500 por fornecedor': { minimo_fornecedor: { valor_padrao_cents: 150000 } }, 'múltiplo observado nas compras': { usar_multiplo_observado: true },
    'sem correção de falta': { censura_peso: 0 }, 'correção de falta completa': { censura_peso: 1 }, 'sem sinal de crescimento': { crescimento: { usar: false } }, 'cobertura 15 dias': { cobertura_dias: 15 }, 'cobertura 60 dias': { cobertura_dias: 60 },
    'nível de serviço 90%': { nivel_servico: 0.90 }, 'nível de serviço 98%': { nivel_servico: 0.98 }, 'só abaixo do ponto de reposição (com gatilho)': { gatilho: 'PONTO' },
    'retorno mínimo R$ 0,25 por real': { retorno_minimo: 0.25 }, 'prazo x 0,5': { __prazo: 0.5 }, 'prazo x 1,5': { __prazo: 1.5 }, 'prazo x 2': { __prazo: 2 }, 'prazo 45 dias': { __fixo: 45 },
  };
  const sens = [];
  for (const [nome, c] of Object.entries(cenarios)) {
    const { __prazo, __fixo, ...e } = c;
    const dadosC = __prazo || __fixo ? { ...res, itens: res.itens.map(i => ({ ...i, prazo_dias: __fixo || Math.max(1, Math.round(i.prazo_dias * __prazo)), prazo_desvio: __fixo ? __fixo * 0.25 : i.prazo_desvio * __prazo })) } : res;
    for (const o of [49000, 100000]) {
      const s = A.simular(dadosC, { ...extra14, ...e, orcamento_cents: o * 100 });
      sens.push({ cenario: nome, orcamento: o, ...s.totais, produtos_diferentes_da_base: null, qtd: Object.fromEntries(s.linhas.filter(l => l.qtd > 0).map(l => [l.id, l.qtd])) });
    }
  }
  for (const x of sens) { const b = sens.find(y => y.cenario === 'base (antigos ignorados)' && y.orcamento === x.orcamento); const ids = new Set([...Object.keys(x.qtd), ...Object.keys(b.qtd)]); x.produtos_diferentes_da_base = [...ids].filter(id => (x.qtd[id] || 0) !== (b.qtd[id] || 0)).length; x.valor_remanejado = Math.round([...ids].reduce((s, id) => s + Math.max(0, (x.qtd[id] || 0) - (b.qtd[id] || 0)) * porId.get(id).custo, 0) / 100); }
  for (const x of sens) delete x.qtd;
  const recomendacoes = Object.fromEntries([49000, 100000].map(o => [o, A.simular(res, { ...extra14, orcamento_cents: o * 100 })]));
  // composição por classe em cada orçamento
  const porClasse = ORCAMENTOS.map(o => { const q = regras['1.4'](o * 100); const c = { orcamento: o }; for (const cl of CLS) c[cl] = Math.round(soma(prontos.filter(p => p.classe === cl), p => (q.get(p.id) || 0) * p.custo) / 100); return c; });
  return { data: res.hoje, dados_gerados_em: res.gerado_em_dados, resumo: res.resumo, sem_compra: semCompra, tabela, sem_teto: semTeto, curva, sensibilidade: sens, por_classe: porClasse, recomendacoes };
}

// ── CSVs ────────────────────────────────────────────────────────────────────────────────────────────────────────
const celula = x => { if (x === null || x === undefined) return ''; const s = typeof x === 'number' ? String(Math.round(x * 1000) / 1000).replace('.', ',') : String(x); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (linhas, colunas) => '﻿' + [colunas.join(';'), ...linhas.map(l => colunas.map(c => celula(l[c])).join(';'))].join('\n') + '\n';
const reais = x => ({ capital_reais: x.capital_cents / 100, margem_preservada_reais: x.margem_preservada_cents / 100, excesso_90d_reais: x.excesso_90d_cents / 100, acima_180d_reais: x.acima_do_excesso_cents / 100, capital_giro_liquido_reais: x.capital_giro_liquido_cents / 100 });
const COL_HOJE = ['orcamento', 'regra', 'capital_reais', 'atendimento_pct', 'atendimento_A_pct', 'rupturas_previstas', 'disponibilidade_A_pct', 'margem_preservada_reais', 'cobertura_antes_dias', 'cobertura_depois_dias', 'produtos_contemplados', 'unidades', 'pedidos_fornecedores', 'excesso_90d_reais', 'acima_180d_reais', 'capital_giro_liquido_reais'];
const COL_RUN = ['familia', 'nome', 'mecanismo', 'recorte', 'capital_medio', 'estoque_medio', 'transito_medio', 'atendido_pct', 'atendido_A_pct', 'falta_pct', 'falta_A_pct', 'margem_perdida_ano', 'excesso_medio', 'compra_semana', 'linhas', 'pedidos_fornecedor'];
const linhasRun = runs => runs.flatMap(r => [['ano', r.r], ['1a metade', r.r.metade1], ['2a metade', r.r.metade2]].map(([recorte, x]) => ({ familia: r.familia, nome: r.nome, mecanismo: r.mecanismo, recorte, ...x })));

/** Tabelas derivadas da fronteira (mesmo capital e retornos decrescentes) a partir das simulações já feitas. */
function resumirFronteira(runs) {
  const livres = runs.filter(r => r.mecanismo === 'livre');   // cada regra só com o próprio "botão", sem teto de dinheiro
  return { mesmo_capital: { ano: mesmoCapital(runs), metade1: mesmoCapital(runs, r => r.metade1), metade2: mesmoCapital(runs, r => r.metade2), ano_so_livres: mesmoCapital(livres), metade2_so_livres: mesmoCapital(livres, r => r.metade2) },
    retorno_decrescente: Object.fromEntries(FAMILIAS.slice(1).map(f => [f, { todas_as_formas: retornoDecrescente(runs.filter(r => r.familia === f).map(r => r.r)), so_livres: retornoDecrescente(livres.filter(r => r.familia === f).map(r => r.r)) }])) };
}
function gravarResumo(grava, universo, runs) {
  const res = resumirFronteira(runs);
  grava('fronteira.json', JSON.stringify({ universo, runs, ...res }, null, 1));
  grava('02B-14-backtest-fronteira.csv', csv(linhasRun(runs), COL_RUN));
  grava('02G-14-mesmo-capital.csv', csv(Object.entries(res.mesmo_capital).flatMap(([k, v]) => v.map(x => ({ recorte: k, ...x }))), ['recorte', 'familia', 'capital', 'atendido_pct', 'atendido_A_pct', 'falta_A_pct', 'margem_perdida_ano', 'excesso_medio', 'pedidos_fornecedor', 'linhas']));
}

function principal(argv = process.argv.slice(2)) {
  const a = argumentos(argv);
  if (typeof a['de-arquivo'] !== 'string' || typeof a.saida !== 'string') throw new Error('INFORME --de-arquivo <pasta> --saida <pasta>');
  const partes = new Set(String(a.partes || 'hoje,ajuste,fronteira,sensibilidade').split(','));
  const extra14 = typeof a.config14 === 'string' ? JSON.parse(fs.readFileSync(a.config14, 'utf8')) : {};
  fs.mkdirSync(a.saida, { recursive: true });
  const grava = (nome, texto) => fs.writeFileSync(path.join(a.saida, nome), texto);
  const log = x => console.error(new Date().toISOString().slice(11, 19), x);
  if (partes.has('hoje')) {
    log('hoje');
    const h = hoje(a['de-arquivo'], extra14, configDaGeracao({ origem: a.origem }));
    grava('hoje.json', JSON.stringify({ ...h, recomendacoes: undefined }, null, 1));
    grava(`02A-14-orcamentos-hoje-${h.data}.csv`, csv([{ orcamento: 0, regra: 'sem compra', ...h.sem_compra, ...reais(h.sem_compra) }, ...[...h.tabela, ...h.sem_teto].map(x => ({ ...x, orcamento: x.orcamento === null ? 'sem teto' : x.orcamento, ...reais(x) }))], COL_HOJE));
    grava(`02C-14-curva-orcamento-${h.data}.csv`, csv(h.curva, ['orcamento', 'capital', 'atendimento', 'atendimento_A', 'rupturas', 'disp_A', 'margem', 'excesso_90d', 'retorno_marginal', 'forn', 'produtos']));
    grava(`02D-14-cenarios-hoje-${h.data}.csv`, csv(h.sensibilidade.map(x => ({ ...x, ...reais(x) })), ['cenario', 'orcamento', 'capital_reais', 'atendimento_pct', 'atendimento_A_pct', 'rupturas_previstas', 'disponibilidade_A_pct', 'margem_preservada_reais', 'produtos_contemplados', 'pedidos_fornecedores', 'excesso_90d_reais', 'produtos_diferentes_da_base', 'valor_remanejado']));
    for (const [o, s] of Object.entries(h.recomendacoes)) grava(`02E-14-recomendacao-${o / 1000}mil-${h.data}.csv`, '﻿' + A.csv(s.linhas.filter(l => l.qtd > 0 || l.falta_para_o_alvo_cents > 0 || /ORIGEM|REVISAR|FORNECEDOR/.test(l.motivo)), { comNomes: false }));
  }
  if (partes.has('resumir')) {                                   // refaz só as tabelas derivadas, sem simular de novo
    const f = JSON.parse(fs.readFileSync(path.join(a.saida, 'fronteira.json'), 'utf8'));
    gravarResumo(grava, f.universo, f.runs);
    const arq = path.join(a.saida, 'sensibilidade.json');
    if (fs.existsSync(arq)) { const s = JSON.parse(fs.readFileSync(arq, 'utf8')); for (const v of Object.values(s)) v.mesmo_capital = mesmoCapital(v.runs); grava('sensibilidade.json', JSON.stringify(s, null, 1)); }
  }
  if (!['ajuste', 'fronteira', 'sensibilidade'].some(p => partes.has(p))) return;
  log('preparando backtest (fatos por semana, sem futuro)');
  const m = montar(a['de-arquivo']);
  const universo = { produtos: m.bt.universo.length, A: m.bt.universo.filter(u => u.classeInicial === 'A').length, estoque_inicial: Math.round(soma(m.bt.universo, u => u.estoque0 * u.custo)), revisoes: m.bt.revisoes.length };
  if (partes.has('ajuste')) {
    log('ajuste');
    const aj = ajuste(m);
    grava('ajuste.json', JSON.stringify(aj, null, 1));
    grava('02F-14-ajuste-parametros.csv', csv(aj.tabela, Object.keys(aj.tabela[0])));
  }
  if (partes.has('fronteira')) {
    log('fronteira');
    const runs = [...familias(extra14).map(f => ({ ...f, mecanismo: f.c.teto ? 'teto de capital' : 'livre' })), ...porOrcamento(extra14).map(f => ({ ...f, mecanismo: 'orçamento semanal' }))]
      .map((f, i, t) => { if (i % 10 === 0) log(`  ${i}/${t.length}`); return { familia: f.familia, nome: f.nome, mecanismo: f.mecanismo, c: f.c, r: simular(m, f.c) }; });
    gravarResumo(grava, universo, runs);
  }
  if (partes.has('sensibilidade')) {
    log('sensibilidade');
    const sel = familias(extra14).filter(f => !f.c.teto);
    const casos = { 'prazo real 7': { prazoReal: 7 }, 'prazo real 21': { prazoReal: 21 }, 'prazo real 30': { prazoReal: 30 }, 'prazo real 45': { prazoReal: 45 }, 'prazo 30 cadastrado': { prazoReal: 30, prazoCadastrado: 30 }, 'prazo 45 cadastrado': { prazoReal: 45, prazoCadastrado: 45 },
      'demanda reprimida somada': { descensurada: true }, 'pedido mínimo R$ 1.500': { minimoForn: 1500 }, 'pedido mínimo R$ 5.000': { minimoForn: 5000 } };
    const out = {};
    for (const [nome, extra] of Object.entries(casos)) {
      log('  ' + nome);
      const usar = extra.prazoCadastrado ? sel.filter(f => f.c.politica === '13' || f.c.politica === '14') : sel;   // regras sem prazo não mudam ao cadastrá-lo
      const runs = usar.map(f => ({ familia: f.familia, nome: f.nome, mecanismo: 'livre', r: simular(m, { ...f.c, ...extra }) }));
      out[nome] = { runs, mesmo_capital: mesmoCapital(runs) };
    }
    grava('sensibilidade.json', JSON.stringify(out, null, 1));
    grava('02H-14-sensibilidade-backtest.csv', csv(Object.entries(out).flatMap(([caso, v]) => v.runs.map(r => ({ caso, familia: r.familia, nome: r.nome, ...r.r }))), ['caso', 'familia', 'nome', 'capital_medio', 'atendido_pct', 'atendido_A_pct', 'falta_A_pct', 'margem_perdida_ano', 'excesso_medio', 'linhas', 'pedidos_fornecedor']));
  }
  log('fim');
}

if (require.main === module) principal();
module.exports = { principal, montar, montarDe, simular, resumirFronteira, misturaNoCapital, fronteira, noCapital, retornoDecrescente, porUrgencia, rateado, semPequenos, familias, porOrcamento, mesmoCapital, hoje, VARIANTES, ORCAMENTOS };
