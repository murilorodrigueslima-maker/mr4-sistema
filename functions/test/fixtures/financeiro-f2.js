'use strict';
// Fixtures SINTÉTICAS da Fase 2: ERP falso (mesma semântica comprovada da API: data efetiva, limite 100, ordem por data efetiva,
// compras/vendas por data de emissão) com injeção de falhas, e Firestore falso (batch, transação serializada, ganchos de falha).
const F = require('../../lib/financeiro/fetch');
const { FORMAS, titulo, receber } = require('./financeiro-f1');

const efetiva = t => (t.liquidado === '1' ? t.data_liquidacao : t.data_vencimento);
/**
 * opts: pagamentos, recebimentos, compras:[{id,codigo,fornecedor_id,data_emissao}], vendas:[{id,codigo,cliente_id,data}]
 *       falhas: { http: (path, n) => status|null, timeout: (path,n)=>bool, jsonInvalido:(path,n)=>bool, repetirPagina:(path,pagina)=>bool, total:(path)=>delta, vazio:(path)=>bool }
 */
function gcFalso(opts = {}) {
  const { pagamentos = [], recebimentos = [], compras = [], vendas = [], falhas = {} } = opts;
  const chamadas = []; const porPath = {};
  const fetchImpl = async (url, o) => {
    const u = new URL(url); const path = u.pathname; const key = path + u.search;
    chamadas.push({ url, method: o.method, path }); porPath[key] = (porPath[key] || 0) + 1; const n = porPath[key];
    if (falhas.timeout && falhas.timeout(path, n, u)) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const st = falhas.http && falhas.http(path, n, u); if (st) return { ok: false, status: st, json: async () => ({}) };
    if (falhas.jsonInvalido && falhas.jsonInvalido(path, n, u)) return { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    const q = u.searchParams; const ok = body => ({ ok: true, json: async () => body });
    if (path === '/formas_pagamentos') return ok({ data: Object.entries(FORMAS).map(([id, f]) => ({ FormasPagamento: { id, ...f } })), meta: { total_registros: 6, total_paginas: 1 } });
    if (path === '/planos_contas') return ok({ data: [{ id: 'P1', classificacao: '1.2.2', tipo: 'D', nome: 'Compras', conta_mae_id: 'P0', nome_conta_mae: 'Despesas' }], meta: { total_registros: 1, total_paginas: 1 } });
    const base = path === '/pagamentos' ? pagamentos : path === '/recebimentos' ? recebimentos : path === '/compras' ? compras : path === '/vendas' ? vendas : null;
    if (!base) return { ok: false, status: 404, json: async () => ({}) };
    const dataDe = x => path === '/pagamentos' || path === '/recebimentos' ? efetiva(x) : (path === '/compras' ? x.data_emissao : x.data);
    const ini = q.get('data_inicio'), fim = q.get('data_fim'), pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    let lista = base.filter(t => dataDe(t) >= ini && dataDe(t) <= fim).sort((a, b) => dataDe(a).localeCompare(dataDe(b)) || String(a.id).localeCompare(String(b.id)));
    if (falhas.vazio && falhas.vazio(path, pagina)) lista = [];
    const total = lista.length; const delta = falhas.total ? falhas.total(path) : 0;
    const pg = falhas.repetirPagina && falhas.repetirPagina(path, pagina) ? 1 : pagina;
    let itens = lista.slice((pg - 1) * lim, pg * lim);
    if (path === '/compras') itens = itens.map(x => ({ Compra: x })); if (path === '/vendas') itens = itens.map(x => ({ Venda: x }));
    return ok({ data: itens, meta: { total_registros: total + delta, total_paginas: Math.max(1, Math.ceil(total / lim)) } });
  };
  const dormidas = [];
  const cli = F.criarClienteGC({ fetchImpl, accessToken: 'tok-FAKE', secretToken: 'sec-FAKE', pausaMs: opts.pausaMs == null ? 0 : opts.pausaMs, backoffMs: 1, dormir: async ms => { dormidas.push(ms); } });
  return { cli, chamadas, dormidas, porPath };
}

/** Firestore falso: coleções em memória, batch, transação (serializada, como a contenção real), getAll não usado. hook({op,col,id}) pode lançar. */
function dbFalso(inicial = {}) {
  const st = JSON.parse(JSON.stringify(inicial)); const contagem = { set: 0, delete: 0, commit: 0, tx: 0 };
  const db = { st, hook: null, contagem };
  const chama = (op, col, id) => { if (db.hook) db.hook({ op, col, id }); };
  const lerDoc = (c, id) => (st[c] && st[c][id] !== undefined ? JSON.parse(JSON.stringify(st[c][id])) : undefined);
  const escreve = (c, id, v) => { (st[c] = st[c] || {})[id] = JSON.parse(JSON.stringify(v)); };
  const ref = (c, id) => ({ col: c, id, path: c + '/' + id,
    get: async () => { chama('get', c, id); const d = lerDoc(c, id); return { exists: d !== undefined, data: () => d, id }; },
    set: async v => { chama('set', c, id); contagem.set++; escreve(c, id, v); },
    delete: async () => { chama('delete', c, id); contagem.delete++; if (st[c]) delete st[c][id]; } });
  db.collection = c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, data: () => lerDoc(c, id), ref: ref(c, id) })) }) });
  db.batch = () => { const ops = []; return { set: (r, v) => ops.push([r, v]), commit: async () => { contagem.commit++; for (const [r, v] of ops) { chama('batchset', r.col, r.id); } for (const [r, v] of ops) { contagem.set++; escreve(r.col, r.id, v); } } }; };
  let fila = Promise.resolve();
  db.runTransaction = fn => { const exec = async () => { contagem.tx++; const efeitos = [];
      const tx = { get: async r => { chama('txget', r.col, r.id); const d = lerDoc(r.col, r.id); return { exists: d !== undefined, data: () => d }; }, set: (r, v) => efeitos.push(() => escreve(r.col, r.id, v)), delete: r => efeitos.push(() => { if (st[r.col]) delete st[r.col][r.id]; }) };
      const res = await fn(tx); for (const e of efeitos) { e(); } return res; };
    const p = fila.then(exec, exec); fila = p.catch(() => {}); return p; };
  db.ler = (c, id) => lerDoc(c, id);
  return db;
}

/** Gera massa sintética determinística (semente) com formas variadas. Datas relativas a `hoje`. */
function massa({ hoje, nPagar = 200, nReceber = 400, semente = 7, compras = true } = {}) {
  let s = semente; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const soma = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const pagamentos = [], recebimentos = [], comprasL = [], vendasL = [];
  const formas = ['f_pix', 'f_bol', 'f_bolpix', 'f_cc', 'f_din'];
  for (let i = 0; i < nPagar; i++) {
    const aberto = rnd() < 0.3; const v = soma(hoje, Math.floor(rnd() * 900) - 700); const forn = 'FORN' + (1 + Math.floor(rnd() * 8));
    const cod = String(5000 + i); const f = formas[Math.floor(rnd() * formas.length)];
    const o = { id: 'AP' + i, codigo: String(i), descricao: rnd() < 0.5 ? 'Compra de nº ' + cod : 'Despesa ' + i, entidade: 'F', fornecedor_id: forn, nome_fornecedor: 'Fornecedor Fictício ' + forn, valor: (10 + Math.floor(rnd() * 90000) / 100).toFixed(2), forma_pagamento_id: f, nome_forma_pagamento: FORMAS[f].nome, data_vencimento: v, liquidado: aberto ? '0' : '1', data_liquidacao: aberto ? '' : (v > hoje ? hoje : v), data_competencia: v };
    o.valor_total = o.valor; pagamentos.push(titulo(o)); if (compras) comprasL.push({ id: 'C' + i, codigo: cod, fornecedor_id: forn, data_emissao: soma(v, -10) });
  }
  for (let i = 0; i < nReceber; i++) {
    const aberto = rnd() < 0.2; const v = soma(hoje, Math.floor(rnd() * 900) - 800); const cli = 'CLI' + (1 + Math.floor(rnd() * 30)); const cod = String(9000 + i); const f = formas[Math.floor(rnd() * formas.length)];
    const o = { id: 'AR' + i, codigo: String(i), descricao: 'Venda de nº ' + cod, cliente_id: cli, nome_cliente: 'Cliente Fictício ' + cli, valor: (5 + Math.floor(rnd() * 50000) / 100).toFixed(2), forma_pagamento_id: f, nome_forma_pagamento: FORMAS[f].nome, data_vencimento: v, liquidado: aberto ? '0' : '1', data_liquidacao: aberto ? '' : (v > hoje ? hoje : v), data_competencia: v };
    o.valor_total = o.valor; recebimentos.push(receber(o)); vendasL.push({ id: 'V' + i, codigo: cod, cliente_id: cli, data: soma(v, -3) });
  }
  return { pagamentos, recebimentos, compras: comprasL, vendas: vendasL };
}
module.exports = { gcFalso, dbFalso, massa, efetiva };
