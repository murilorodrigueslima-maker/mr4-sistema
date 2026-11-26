'use strict';
// Mundo sintético para a reconciliação de vendas excluídas/canceladas: Firestore em memória (ou emulador) + GestãoClick falso (só GET).
const FAKE = require('../helpers/fakeFirestore');
const X = require('../../lib/vendasOrigem/execucao');
const { criarLeitorGc } = require('../../lib/estoqueReconciliacao');

const LOJA = '262759', NOME = 'MR4 DISTRIBUIDORA';
const T0 = Date.parse('2026-12-01T12:00:00.000Z'), H = 3600000;
const HOJE = '2026-12-01';

/** Venda como o GestãoClick devolve. */
const gcVenda = (id, data, ex = {}) => ({ id: String(id), codigo: '9' + id, loja_id: LOJA, nome_loja: NOME, cliente_id: '300', data, nome_situacao: 'Concretizada', situacao_id: '3952593', situacao_estoque: '1', valor_total: '100.00',
  vendedor_id: '111', modificado_em: data + ' 10:00:00', cadastrado_em: data + ' 10:00:00', produtos: [{ produto: { produto_id: 'P1', quantidade: '2', valor_total: '100.00', nome_produto: 'NOME-SECRETO' } }], nome_cliente: 'CLIENTE-SECRETO', ...ex });
/** Como o sync grava no espelho. */
const espelho = v => require('../../lib/sync360').minimalVenda(v);

/**
 * GestãoClick falso. `g.vendas` = o que existe na origem. Controles:
 *   g.foraDaLista (Set)      existe por id, mas a lista (sem filtro de situação) não traz
 *   g.detalhe (Map id → status HTTP | objeto)  resposta forçada da consulta por id
 *   g.falha(url) → status | 'incompleta' | null
 */
function criarGc(vendas = []) {
  const g = { vendas: new Map(vendas.map(v => [v.id, v])), foraDaLista: new Set(), detalhe: new Map(), falha: null, chamadas: [], produtos: [{ id: 'P1', nome_grupo: 'LAMPADAS' }] };
  const resp = (status, corpo) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => corpo });
  g.transporte = async (url, op) => {
    const u = new URL(url); g.chamadas.push({ url, method: op.method, loja: u.searchParams.get('loja_id') });
    const f = g.falha ? g.falha(u) : null; if (typeof f === 'number') return resp(f, {});
    const m = /^\/vendas\/(\d+)$/.exec(u.pathname);
    if (m) {
      const forcado = g.detalhe.get(m[1]);
      if (typeof forcado === 'number') return resp(forcado, {});
      const v = forcado || g.vendas.get(m[1]);
      return v ? resp(200, { code: 200, status: 'success', data: v }) : resp(404, {});
    }
    let lista;
    if (u.pathname === '/produtos') lista = g.produtos;
    else {
      const q = u.searchParams, ini = q.get('data_inicio'), fim = q.get('data_fim'), sit = q.get('situacao_id');
      lista = [...g.vendas.values()].filter(v => v.data >= ini && v.data <= fim && (sit ? v.situacao_id === sit : !g.foraDaLista.has(v.id)));
    }
    const pagina = Number(u.searchParams.get('pagina') || 1), lim = Number(u.searchParams.get('limite') || 100), total = lista.length;
    if (!total) return resp(200, { code: 200, status: 'success', data: [], meta: { total_registros: null, total_paginas: null, pagina_atual: 1, proxima_pagina: null, limite_por_pagina: lim } });
    const paginas = Math.ceil(total / lim);
    let dados = lista.slice((pagina - 1) * lim, pagina * lim);
    if (f === 'incompleta') dados = dados.slice(0, -1);
    return resp(200, { code: 200, status: 'success', data: dados, meta: { total_registros: total, total_paginas: paginas, pagina_atual: pagina, proxima_pagina: pagina < paginas ? pagina + 1 : null, limite_por_pagina: lim } });
  };
  return g;
}

const leitorDe = g => o => criarLeitorGc({ transporte: g.transporte, credenciais: { access: 'tok-FAKE', secret: 'sec-FAKE' }, maxRequisicoes: o.maxRequisicoes, pausaMs: 0, dormir: async () => {} });

/** N vendas de fundo (presentes nos dois lados) + as indicadas. */
async function criarMundo({ db = FAKE.criarFake(), extras = [], fundo = 30 } = {}) {
  const vendas = [...Array.from({ length: fundo }, (_, i) => gcVenda(1000 + i, `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, { cliente_id: '999' })), ...extras];
  const gc = criarGc(vendas);
  for (const v of vendas) await db.collection('vendas_gc').doc(v.id).set(espelho(v));
  const m = { db, gc, agora: T0, n: 0 };
  m.modo = async (modo, ex = {}) => db.collection('vendas_origem_config').doc('reconciliacao').set({ modo, ...(modo === 'APLICAR' ? { aprovadoPor: 'integrador', aprovadoEm: '2026-12-01T00:00:00.000Z' } : {}), ...ex });
  m.rodar = async ({ avancar = 6, ...o } = {}) => { m.agora += avancar * H; m.n++; return X.executar({ db, criarLeitor: leitorDe(gc), agoraMs: m.agora, runId: 'run-' + m.n, ...o }); };
  m.vezes = async (n, o) => { let r; for (let i = 0; i < n; i++) r = await m.rodar(o); return r; };
  m.doc = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
  m.cand = id => m.doc('vendas_origem_candidatos', id);
  m.col = async c => Object.fromEntries((await db.collection(c).get()).docs.map(d => [d.id, d.data()]));
  return m;
}
module.exports = { LOJA, NOME, T0, H, HOJE, gcVenda, espelho, criarGc, leitorDe, criarMundo };
