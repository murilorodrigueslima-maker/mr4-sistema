'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · Busca no GestãoClick — SOMENTE GET.
// Comprovado: limite 100/página; /produtos lista os 877 ativos (ativo=0 não retorna nada); /vendas e /compras filtram
// por data (venda / emissão) com data_inicio/data_fim; /compras vem embrulhado em {Compra:{...}}.
// Estratégia: janelas mensais + paginação até o fim + conferência (únicos == total_registros) + deduplicação por ID.
const BASE = 'https://api.gestaoclick.com';
const RECURSOS_PERMITIDOS = ['/produtos', '/vendas', '/compras', '/situacoes_vendas', '/situacoes_compras'];
const LIMITE = 100;

function criarClienteGC({ fetchImpl, accessToken, secretToken, pausaMs = 300, timeoutMs = 60000, tentativas = 3, dormir }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl obrigatório');
  const esperar = dormir || (ms => new Promise(r => setTimeout(r, ms)));
  let chamadas = 0, repeticoes = 0;
  async function get(caminho, opcoes = {}) {
    const metodo = (opcoes.method || 'GET').toUpperCase();
    if (metodo !== 'GET') throw new Error('GET_ONLY_GUARD: método ' + metodo + ' bloqueado');
    const url = new URL(BASE + caminho);
    if (url.origin !== BASE) throw new Error('GET_ONLY_GUARD: host bloqueado');
    if (!RECURSOS_PERMITIDOS.some(p => url.pathname === p || url.pathname.startsWith(p + '/'))) throw new Error('GET_ONLY_GUARD: recurso não permitido ' + url.pathname);
    // GET é idempotente: repete (com espera crescente) só em timeout, falha de rede, 429 e 5xx. 4xx ≠ 429 falha na hora.
    for (let t = 1; ; t++) {
      chamadas++;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const tm = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      let repetivel = true;
      try {
        const r = await fetchImpl(url.toString(), { method: 'GET', headers: { 'access-token': accessToken, 'secret-access-token': secretToken }, signal: ctl ? ctl.signal : undefined });
        if (!r.ok) { repetivel = r.status === 429 || r.status >= 500; throw new Error('GC HTTP ' + r.status + ' em ' + url.pathname); }
        const j = await r.json();
        if (pausaMs) await esperar(pausaMs);
        return j;
      } catch (e) {
        if (!repetivel || t >= tentativas) throw e;
        repeticoes++;
        await esperar(1000 * 2 ** t);
      } finally { if (tm) clearTimeout(tm); }
    }
  }
  return { get, chamadas: () => chamadas, repeticoes: () => repeticoes };
}

function janelasMensais(inicio, fim) {
  const out = [];
  let [y, m] = inicio.split('-').map(Number);
  const [fy, fm] = fim.split('-').map(Number);
  while (y < fy || (y === fy && m <= fm)) {
    const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ini = `${y}-${String(m).padStart(2, '0')}-01`, f = `${y}-${String(m).padStart(2, '0')}-${String(ult).padStart(2, '0')}`;
    out.push({ inicio: ini < inicio ? inicio : ini, fim: f > fim ? fim : f });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
const desembrulhar = x => (x && (x.Compra || x.Venda || x.Produto)) || x;

/** Pagina uma consulta até o fim e confere a completude. */
async function paginar(cli, caminhoBase, rotulo) {
  const sep = caminhoBase.includes('?') ? '&' : '?';
  const q = p => `${caminhoBase}${sep}pagina=${p}&limite=${LIMITE}`;
  const primeira = await cli.get(q(1));
  const meta = primeira.meta || {};
  const total = meta.total_registros == null ? 0 : Number(meta.total_registros);
  const paginas = meta.total_paginas == null ? (total ? 1 : 0) : Number(meta.total_paginas);
  const itens = (primeira.data || []).map(desembrulhar);
  let p = 2;
  for (; p <= paginas; p++) {
    const d = ((await cli.get(q(p))).data || []).map(desembrulhar);
    if (!d.length) break;
    itens.push(...d);
  }
  const unicos = new Set(itens.map(x => String(x.id)));
  if (unicos.size !== total) { const e = new Error(`JANELA_INCOMPLETA ${rotulo}: únicos=${unicos.size} total_registros=${total}`); e.codigo = 'JANELA_INCOMPLETA'; throw e; }
  return { itens, paginas: Math.max(1, p - 1) };
}

const LIMITE_INFERIOR = '2000-01-01', LIMITE_SUPERIOR = '2099-12-31';
const diaAnterior = iso => new Date(Date.parse(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
const diaSeguinte = iso => new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

/**
 * Janelas mensais de `inicio` a `fim` + UMA janela antes (registros antigos) + UMA depois (data futura — ex.: venda
 * "Reservado" com data à frente). Ao final, confere a soma com o total da consulta ampla: diferença → erro.
 */
async function buscarPorJanelas(cli, recurso, { inicio, fim, janelaAnterior = true, conferenciaGlobal = true }) {
  const porId = new Map();
  let fetched = 0, paginas = 0;
  // incremental: sem janela anterior e sem conferência global (a soma parcial nunca bate com o total do ERP);
  // cada janela continua conferida (únicos == total_registros).
  const janelas = [...(janelaAnterior ? [{ inicio: LIMITE_INFERIOR, fim: diaAnterior(inicio) }] : []), ...janelasMensais(inicio, fim), { inicio: diaSeguinte(fim), fim: LIMITE_SUPERIOR }];
  for (const j of janelas) {
    const r = await paginar(cli, `/${recurso}?data_inicio=${j.inicio}&data_fim=${j.fim}`, `${recurso} ${j.inicio}..${j.fim}`);
    paginas += r.paginas;
    for (const it of r.itens) { fetched++; const id = String(it.id), a = porId.get(id); if (!a || String(it.modificado_em || '') >= String(a.modificado_em || '')) porId.set(id, it); }
  }
  if (!conferenciaGlobal) return { registros: [...porId.values()], estatisticas: { recurso, janelas: janelas.length, paginas, fetched, unique: porId.size, duplicates: fetched - porId.size, total_consulta_ampla: null } };
  const amplo = await cli.get(`/${recurso}?data_inicio=${LIMITE_INFERIOR}&data_fim=${LIMITE_SUPERIOR}&pagina=1&limite=1`);
  const totalAmplo = Number((amplo.meta || {}).total_registros || 0);
  if (totalAmplo !== porId.size) { const e = new Error(`COBERTURA_INCOMPLETA ${recurso}: janelas=${porId.size} consulta_ampla=${totalAmplo}`); e.codigo = 'COBERTURA_INCOMPLETA'; throw e; }
  return { registros: [...porId.values()], estatisticas: { recurso, janelas: janelas.length, paginas, fetched, unique: porId.size, duplicates: fetched - porId.size, total_consulta_ampla: totalAmplo } };
}

async function buscarProdutos(cli) {
  const r = await paginar(cli, '/produtos', 'produtos');
  const porId = new Map(r.itens.map(p => [String(p.id), p]));
  return { produtos: [...porId.values()], estatisticas: { recurso: 'produtos', paginas: r.paginas, fetched: r.itens.length, unique: porId.size, duplicates: r.itens.length - porId.size } };
}

// ── Sync INCREMENTAL (Fase 1: só planejamento/simulação; nada agendado) ─────────────────────────────────────
// Comprovado: a API ignora filtros por data de alteração → o incremental relê por DATA DA VENDA/EMISSÃO numa
// janela de retrovisão (lookback) + a janela futura, e relê TODOS os produtos (9 páginas). O registro mais novo
// (modificado_em) substitui o anterior — assim uma reserva depois cancelada deixa de compor demanda.
function planoIncremental(hoje, lookbackDias) {
  const inicio = new Date(Date.parse(hoje + 'T00:00:00Z') - lookbackDias * 86400000).toISOString().slice(0, 10);
  return { produtos: 'TODOS', vendas: { inicio, fim: hoje, futura: true }, compras: { inicio, fim: hoje, futura: true }, lookback_dias: lookbackDias };
}

/** Mescla registros novos sobre a base (por id; vence o modificado_em mais recente). Nunca apaga o que não veio. */
function mesclarRegistros(base, novos) {
  const porId = new Map(base.map(x => [String(x.id), x]));
  let inseridos = 0, substituidos = 0, ignorados = 0;
  for (const n of novos) {
    const id = String(n.id), a = porId.get(id);
    if (!a) { porId.set(id, n); inseridos++; }
    else if (String(n.modificado_em || '') >= String(a.modificado_em || '')) { porId.set(id, n); substituidos++; }
    else ignorados++;
  }
  return { registros: [...porId.values()], inseridos, substituidos, ignorados };
}

/**
 * Defasagem entre a data de negócio (venda/emissão) e a última modificação, para dimensionar o lookback.
 * cobertura(L) = % das modificações POSTERIORES ao cadastro cuja data de negócio está a ≤ L dias da modificação.
 */
function analisarDefasagem(registros, campoData, lookbacks = [7, 15, 30, 45, 60, 90, 120, 180]) {
  const dia = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const dif = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const linhas = registros.map(r => ({ neg: dia(r[campoData]), mod: dia(r.modificado_em), cad: dia(r.cadastrado_em) })).filter(l => l.neg && l.mod);
  const posteriores = linhas.filter(l => l.cad && l.mod > l.cad);
  const lag = l => dif(l.neg, l.mod);
  const cob = (lista, L) => (lista.length ? Math.round(lista.filter(l => lag(l) <= L).length / lista.length * 10000) / 100 : 100);
  const ord = posteriores.map(lag).sort((a, b) => a - b);
  const pct = q => (ord.length ? ord[Math.min(ord.length - 1, Math.floor(q * ord.length))] : null);
  return {
    registros: linhas.length, modificados_apos_cadastro: posteriores.length,
    data_negocio_futura_no_cadastro: linhas.filter(l => l.cad && l.neg > l.cad).length,
    defasagem_dias_p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: ord.length ? ord[ord.length - 1] : null,
    cobertura_por_lookback_pct: Object.fromEntries(lookbacks.map(L => [L + 'd', cob(posteriores, L)])),
  };
}

/** Estimativa de GETs de uma sincronização a partir das contagens reais por janela (100 por página). */
function estimarChamadas(registros, campoData, { inicio, fim }) {
  const janelas = [...janelasMensais(inicio, fim), { inicio: diaSeguinte(fim), fim: LIMITE_SUPERIOR }];
  let chamadas = 0;
  for (const j of janelas) { const n = registros.filter(r => { const d = String(r[campoData] || '').slice(0, 10); return d >= j.inicio && d <= j.fim; }).length; chamadas += Math.max(1, Math.ceil(n / LIMITE)); }
  return { janelas: janelas.length, chamadas: chamadas + 1 };   // + consulta ampla de conferência
}

module.exports = { criarClienteGC, janelasMensais, paginar, buscarPorJanelas, buscarProdutos, planoIncremental, mesclarRegistros, analisarDefasagem, estimarChamadas, RECURSOS_PERMITIDOS, LIMITE };
