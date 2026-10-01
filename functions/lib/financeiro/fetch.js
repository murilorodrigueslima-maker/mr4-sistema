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
const RECURSOS_PERMITIDOS = ['/pagamentos', '/recebimentos', '/formas_pagamentos', '/planos_contas', '/vendas', '/compras'];
const LIMITE = 100;

/** Cliente GET-only. Qualquer outro método, host ou recurso → erro (GET_ONLY_GUARD). */
function criarClienteGC({ fetchImpl, accessToken, secretToken, pausaMs = 350, timeoutMs = 30000, dormir, tentativas = 3, backoffMs = 1500 }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl obrigatório');
  const esperar = dormir || (ms => new Promise(r => setTimeout(r, ms)));
  let chamadas = 0, retries = 0;
  const transitorio = e => e && (e.transitorio === true || e.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(String(e.message)));
  async function get(caminho, opcoes = {}) {
    const metodo = (opcoes.method || 'GET').toUpperCase();
    if (metodo !== 'GET') throw new Error('GET_ONLY_GUARD: método ' + metodo + ' bloqueado');
    const url = new URL(BASE + caminho);
    if (url.origin !== BASE) throw new Error('GET_ONLY_GUARD: host bloqueado');
    if (!RECURSOS_PERMITIDOS.includes(url.pathname)) throw new Error('GET_ONLY_GUARD: recurso não permitido ' + url.pathname);
    let ultimo;
    for (let t = 1; t <= tentativas; t++) {
      chamadas++;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const tm = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const r = await fetchImpl(url.toString(), { method: 'GET', headers: { 'access-token': accessToken, 'secret-access-token': secretToken }, signal: ctl ? ctl.signal : undefined });
        if (!r.ok) { const e = new Error('GC HTTP ' + r.status + ' em ' + url.pathname); e.transitorio = r.status === 429 || r.status >= 500; e.status = r.status; throw e; }
        let j;
        try { j = await r.json(); } catch (_) { const e = new Error('GC JSON inválido em ' + url.pathname); e.transitorio = true; throw e; }
        if (j === null || typeof j !== 'object') { const e = new Error('GC resposta vazia em ' + url.pathname); e.transitorio = true; throw e; }
        if (pausaMs) await esperar(pausaMs);
        return j;
      } catch (e) {
        ultimo = e;
        if (!transitorio(e) || t === tentativas) throw e;      // erro definitivo (4xx) não é repetido; transitório: backoff exponencial
        retries++;
        await esperar(backoffMs * Math.pow(2, t - 1));
      } finally { if (tm) clearTimeout(tm); }
    }
    throw ultimo;
  }
  return { get, chamadas: () => chamadas, retries: () => retries };
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

/** Compras/vendas vêm embrulhadas ({Compra:{…}} / {Venda:{…}}); títulos vêm planos. */
const desembrulha = x => (x && (x.Compra || x.Venda)) || x;

/** Busca uma janela inteira, paginando; confere completude. */
async function buscarJanela(cli, recurso, janela) {
  const q = p => `/${recurso}?pagina=${p}&limite=${LIMITE}&data_inicio=${janela.inicio}&data_fim=${janela.fim}`;
  const primeira = await cli.get(q(1));
  const meta = primeira.meta || {};
  const total = meta.total_registros == null ? 0 : Number(meta.total_registros);
  const paginas = meta.total_paginas == null ? (total ? 1 : 0) : Number(meta.total_paginas);
  if (paginas > 5000) { const e = new Error('PAGINAS_DEMAIS'); e.codigo = 'PAGINAS_DEMAIS'; throw e; }
  const itens = [...(Array.isArray(primeira.data) ? primeira.data : [])];
  let p = 2;
  let assinaturaAnterior = JSON.stringify(desembrulha(itens[0] || {}).id) + '|' + JSON.stringify(desembrulha(itens[itens.length - 1] || {}).id);
  for (; p <= paginas; p++) {
    const r = await cli.get(q(p));
    const d = Array.isArray(r.data) ? r.data : [];
    if (!d.length) break;
    const assinatura = JSON.stringify(desembrulha(d[0]).id) + '|' + JSON.stringify(desembrulha(d[d.length - 1]).id);
    if (assinatura === assinaturaAnterior) { const e = new Error(`PAGINA_REPETIDA ${recurso} ${janela.inicio}..${janela.fim} pág ${p}`); e.codigo = 'PAGINA_REPETIDA'; throw e; }   // API devolvendo a mesma página: não segue em loop nem conta em dobro
    assinaturaAnterior = assinatura;
    itens.push(...d);
  }
  const unicos = new Set(itens.map(x => String(desembrulha(x).id)));
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

/** Índices mínimos para vínculos (só campos necessários; nada de PII): compras {id,codigo,fornecedor_id}, vendas {id,codigo,cliente_id}. */
async function buscarIndicesComerciais(cli, { inicio, fim }) {
  const out = { compras: [], vendas: [], estatisticas: {} };
  for (const [recurso, chave, bloco, campoEnt] of [['compras', 'compras', 'Compra', 'fornecedor_id'], ['vendas', 'vendas', 'Venda', 'cliente_id']]) {
    const porId = new Map(); let paginas = 0;
    for (const j of janelasMensais(inicio, fim)) {
      const r = await buscarJanela(cli, recurso, j); paginas += r.paginas;
      for (const x of r.itens) { const o = x[bloco] || x; porId.set(String(o.id), { id: String(o.id), codigo: o.codigo != null ? String(o.codigo) : null, [campoEnt]: o[campoEnt] != null && o[campoEnt] !== '' ? String(o[campoEnt]) : null }); }
    }
    out[chave] = [...porId.values()]; out.estatisticas[recurso] = { paginas, unique: porId.size };
  }
  return out;
}

module.exports = { criarClienteGC, buscarIndicesComerciais, janelasMensais, buscarJanela, buscarTitulos, buscarReferencias, RECURSOS_PERMITIDOS, LIMITE };
