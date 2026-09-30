'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — API do GestãoClick FALSA (só GET) e Firestore falso com transações, para testes de paridade.
// Fiel ao que o sync usa: filtros data_inicio/data_fim (vendas.data · compras.data_emissao), paginação (pagina/limite ≤ 100),
// meta.total_registros/total_paginas e a consulta ampla (limite=1) da conferência global. Dados sempre fornecidos pelo teste.
const F = require('../../lib/compras/fetch');

function criarGcFalso({ produtos = [], vendas = [], compras = [], falhas = [] } = {}) {
  const chamadas = []; let i = 0;
  const fetchImpl = async (url, opts) => {
    chamadas.push({ url, method: opts.method });
    const f = falhas[i++]; if (typeof f === 'number') return { ok: false, status: f, json: async () => ({}) };
    const u = new URL(url), q = u.searchParams, pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    const ini = q.get('data_inicio'), fim = q.get('data_fim');
    let lista;
    if (u.pathname === '/produtos') lista = produtos;
    else if (u.pathname === '/vendas') lista = vendas.filter(v => v.data >= ini && v.data <= fim);
    else if (u.pathname === '/compras') lista = compras.filter(c => (c.Compra || c).data_emissao >= ini && (c.Compra || c).data_emissao <= fim);
    else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: lista.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: lista.length, total_paginas: Math.max(1, Math.ceil(lista.length / lim)) } }) };
  };
  return { cli: F.criarClienteGC({ fetchImpl, accessToken: 'tok-FAKE', secretToken: 'sec-FAKE', pausaMs: 0, dormir: async () => {} }), chamadas };
}

function criarDbFalso() {
  const st = {};
  const ler = (c, id) => (st[c] && st[c][id] ? JSON.parse(st[c][id]) : undefined);
  const ref = (c, id) => ({ id, _c: c, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => ler(c, id) }), set: async v => { (st[c] = st[c] || {})[id] = JSON.stringify(v); }, delete: async () => { if (st[c]) delete st[c][id]; } });
  return { st, ler,
    collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }) }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), delete: r => ops.push(() => r.delete()), commit: async () => { for (const o of ops) await o(); } }; },
    runTransaction: async fn => { const w = []; const r = await fn({ get: x => x.get(), set: (x, v) => w.push(() => x.set(v)), delete: x => w.push(() => x.delete()) }); for (const o of w) await o(); return r; } };
}
/** Documentos financeiros persistidos (blocos de custos + visão de custos + resumo) sem carimbos de tempo — para comparar execuções. */
function financeiroPersistido(db) {
  const semTempo = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'gerado_em' ? undefined : x)));
  const blocos = Object.keys(db.st.compras_n0_custos || {}).sort().map(id => semTempo(db.ler('compras_n0_custos', id)));
  return { blocos, view_custos: semTempo(db.ler('compras_n0_view', 'custos')), view_sugestoes: semTempo(db.ler('compras_n0_view', 'sugestoes')) };
}
module.exports = { criarGcFalso, criarDbFalso, financeiroPersistido };
