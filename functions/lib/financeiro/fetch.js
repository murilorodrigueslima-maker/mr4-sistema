'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · Busca de títulos no GestãoClick — SOMENTE GET.
//
// Comportamento REAL da API (comprovado por sondagem GET, 29/09/2026):
//  - filtro de status (liquidado, status, em_aberto…) é IGNORADO → não usar;
//  - data_inicio/data_fim filtram pela "data efetiva": liquidação se pago, vencimento se aberto;
//  - sem período → só o mês corrente;
//  - limite máximo 100 por página (valores maiores são reduzidos a 100 sem aviso);
//  - ordem estável, crescente pela data efetiva; página além do fim → lista vazia.
// Estratégia: varrer janelas MENSAIS de data efetiva cobrindo [início, fim], paginar cada janela até o fim,
// conferir IDs únicos == total_registros da janela (senão: snapshot incompleto → falha, preserva o anterior)
// e deduplicar pelo ID de origem (título pago durante a varredura pode "mudar de janela").
// Um título ABERTO sempre está na janela do seu vencimento → vencidos antigos não somem se o início cobrir o
// vencimento mais antigo em aberto (ver OLDEST_OPEN_* no relatório).

const BASE = 'https://api.gestaoclick.com';
const RECURSOS_PERMITIDOS = ['/pagamentos', '/recebimentos', '/formas_pagamentos', '/planos_contas', '/vendas'];
const LIMITE = 100;

/** Cliente GET-only. Qualquer outro método, host ou recurso → erro (GET_ONLY_GUARD). */
function criarClienteGC({ fetchImpl, accessToken, secretToken, pausaMs = 350, timeoutMs = 30000, dormir }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl obrigatório');
  const esperar = dormir || (ms => new Promise(r => setTimeout(r, ms)));
  let chamadas = 0;
  async function get(caminho, opcoes = {}) {
    const metodo = (opcoes.method || 'GET').toUpperCase();
    if (metodo !== 'GET') throw new Error('GET_ONLY_GUARD: método ' + metodo + ' bloqueado');
    const url = new URL(BASE + caminho);
    if (url.origin !== BASE) throw new Error('GET_ONLY_GUARD: host bloqueado');
    if (!RECURSOS_PERMITIDOS.some(p => url.pathname === p || url.pathname.startsWith(p + '/'))) throw new Error('GET_ONLY_GUARD: recurso não permitido ' + url.pathname);
    chamadas++;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tm = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(url.toString(), { method: 'GET', headers: { 'access-token': accessToken, 'secret-access-token': secretToken }, signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('GC HTTP ' + r.status + ' em ' + url.pathname);
      const j = await r.json();
      if (pausaMs) await esperar(pausaMs);
      return j;
    } finally { if (tm) clearTimeout(tm); }
  }
  return { get, chamadas: () => chamadas };
}

/** Janelas mensais [{inicio, fim}] cobrindo [inicio, fim] (datas só-data). */
function janelasMensais(inicio, fim) {
  const out = [];
  let [y, m] = inicio.split('-').map(Number);
  const [fy, fm] = fim.split('-').map(Number);
  while (y < fy || (y === fy && m <= fm)) {
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ini = `${y}-${String(m).padStart(2, '0')}-01`, f = `${y}-${String(m).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
    out.push({ inicio: ini < inicio ? inicio : ini, fim: f > fim ? fim : f });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Busca uma janela inteira, paginando; confere completude. */
async function buscarJanela(cli, recurso, janela) {
  const q = p => `/${recurso}?pagina=${p}&limite=${LIMITE}&data_inicio=${janela.inicio}&data_fim=${janela.fim}`;
  const primeira = await cli.get(q(1));
  const meta = primeira.meta || {};
  const total = meta.total_registros == null ? 0 : Number(meta.total_registros);
  const paginas = meta.total_paginas == null ? (total ? 1 : 0) : Number(meta.total_paginas);
  const itens = [...(Array.isArray(primeira.data) ? primeira.data : [])];
  let p = 2;
  for (; p <= paginas; p++) {
    const r = await cli.get(q(p));
    const d = Array.isArray(r.data) ? r.data : [];
    if (!d.length) break;
    itens.push(...d);
  }
  const unicos = new Set(itens.map(x => String(x.id)));
  if (unicos.size !== total) {
    const e = new Error(`JANELA_INCOMPLETA ${recurso} ${janela.inicio}..${janela.fim}: únicos=${unicos.size} total_registros=${total}`);
    e.codigo = 'JANELA_INCOMPLETA'; throw e;
  }
  return { itens, paginas: Math.max(1, p - 1), total };
}

/** Busca todos os títulos de um recurso no intervalo; deduplica pelo ID (fica a versão mais recente). */
async function buscarTitulos(cli, recurso, { inicio, fim }) {
  const porId = new Map();
  let fetched = 0, paginas = 0;
  const janelas = janelasMensais(inicio, fim);
  for (const j of janelas) {
    const r = await buscarJanela(cli, recurso, j);
    paginas += r.paginas;
    for (const it of r.itens) {
      fetched++;
      const id = String(it.id), atual = porId.get(id);
      if (!atual || String(it.modificado_em || '') >= String(atual.modificado_em || '')) porId.set(id, it);
    }
  }
  return { titulos: [...porId.values()], estatisticas: { recurso, janelas: janelas.length, paginas, fetched, unique: porId.size, duplicates: fetched - porId.size } };
}

/** Tabelas de referência (formas de pagamento e planos de contas). */
async function buscarReferencias(cli) {
  const f = await cli.get('/formas_pagamentos?limite=100');
  const p = await cli.get('/planos_contas?limite=100');
  const formasPorId = {};
  for (const x of (f.data || [])) { const o = x.FormasPagamento || x; formasPorId[String(o.id)] = { nome: o.nome, tipo: o.tipo }; }
  const planos = (p.data || []).map(x => ({ id: String(x.id), classificacao: x.classificacao, tipo: x.tipo, nome: x.nome, mae_id: x.conta_mae_id ? String(x.conta_mae_id) : null, mae_nome: x.nome_conta_mae || null }));
  return { formasPorId, planos };
}

module.exports = { criarClienteGC, janelasMensais, buscarJanela, buscarTitulos, buscarReferencias, RECURSOS_PERMITIDOS, LIMITE };
