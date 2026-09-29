'use strict';
// Harness carregado com `node -r` ANTES de scripts/sync-dados.js (SECURITY HOTFIX P0 — testes de dry-run).
// Substitui, só neste processo: https.get (GestãoClick falso, fixture ou falha), @google-cloud/firestore
// (Firestore em memória, estado inicial vindo de arquivo) e registra qualquer escrita em disco.
// Nenhuma rede, nenhum Firestore real. Ao sair, grava o resultado em HARNESS_OUT.
const Module = require('module');
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');

const MODE = process.env.HARNESS_MODE;                       // 'ok' | 'falha'
const state = JSON.parse(fs.readFileSync(process.env.HARNESS_STATE, 'utf8'));
const writes = [], diskWrites = [], gcCalls = [];
const escreverDisco = fs.writeFileSync.bind(fs);

// retries/backoff instantâneos
const realSetTimeout = global.setTimeout;
global.setTimeout = (f, ms, ...a) => realSetTimeout(f, Math.min(Number(ms) || 0, 5), ...a);

// qualquer escrita em disco feita pelo script é registrada (o sync não deve escrever nenhuma)
for (const nome of ['writeFileSync', 'writeFile', 'appendFileSync']) {
  const orig = fs[nome].bind(fs);
  fs[nome] = (p, ...a) => { diskWrites.push(String(p)); return orig(p, ...a); };
}

// ── Firestore em memória ───────────────────────────────────────────────────
const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
class Snap { constructor(id, d) { this.id = id; this._d = d; this.exists = d !== undefined; } data() { return clone(this._d); } }
class Query {
  constructor(col) { this.col = col; }
  where() { return this; } orderBy() { return this; } limit() { return this; } select() { return this; } startAfter() { return this; }
  async get() { const docs = Object.entries(state[this.col] || {}).map(([id, d]) => new Snap(id, d)); return { docs, empty: !docs.length, size: docs.length, forEach: f => docs.forEach(f) }; }
}
class DocRef {
  constructor(col, id) { this.col = col; this.id = id; }
  async get() { return new Snap(this.id, (state[this.col] || {})[this.id]); }
  async set(d, opt) { const cur = (state[this.col] || {})[this.id]; (state[this.col] = state[this.col] || {})[this.id] = opt && opt.merge ? { ...cur, ...clone(d) } : clone(d); writes.push(this.col + '/' + this.id); }
  async update(d) { return this.set(d, { merge: true }); }
}
class CollectionRef extends Query { doc(id) { return new DocRef(this.col, id); } }
class Firestore {
  collection(n) { return new CollectionRef(n); }
  batch() { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const op of ops) await op(); } }; }
  async runTransaction(fn) { return fn({ get: r => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d) }); }
}
const FieldValue = { serverTimestamp: () => '__serverTimestamp__', increment: n => n, arrayUnion: (...a) => a, delete: () => undefined };
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === '@google-cloud/firestore') return { Firestore, FieldValue, Timestamp: { now: () => ({ seconds: 0 }) } };
  return origLoad.call(this, req, ...rest);
};

// ── GestãoClick falso ──────────────────────────────────────────────────────
function hojeComoOSync() {   // mesma expressão de hoje()/diasAtras() do sync
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  return d;
}
const iso = d => d.toISOString().slice(0, 10);
const HOJE = iso(hojeComoOSync());
const ONTEM = (() => { const d = hojeComoOSync(); d.setDate(d.getDate() - 1); return iso(d); })();
const FIXTURE = {
  '/vendas': [
    { id: '1', data: HOJE, valor_total: '1000.00', nome_vendedor: 'Vendedor A', situacao_id: '3952593' },
    { id: '2', data: HOJE, valor_total: '500.00', nome_vendedor: 'Vendedor B', situacao_id: '3952593' },
    { id: '3', data: HOJE, valor_total: '250.00', nome_vendedor: 'Vendedor A', situacao_id: '999' },   // não concretizada
    { id: '4', data: ONTEM, valor_total: '2000.00', nome_vendedor: 'Vendedor B', situacao_id: '3952593' },
  ],
  '/produtos': [
    { id: '10', codigo_interno: 'A1', nome: 'Produto A', marca: 'Fab X', estoque: '10', valor_custo: '5', valor_venda: '10', estoque_minimo: '20' },
    { id: '11', codigo_interno: 'B2', nome: 'Produto B', marca: 'Fab Y', estoque: '2', valor_custo: '9', valor_venda: '10', estoque_minimo: '0' },
    { id: '12', codigo_interno: 'C3', nome: 'Produto C', marca: 'Fab Z', estoque: '0', valor_custo: '1', valor_venda: '4', estoque_minimo: '0' },
  ],
};
https.get = function (url, opts, cb) {
  const u = new URL(url);
  const h = (opts && opts.headers) || {};
  gcCalls.push({ host: u.host, path: u.pathname, temCredencial: !!(h['access-token'] && h['secret-access-token']) });
  const req = new EventEmitter();
  process.nextTick(() => {
    if (MODE === 'falha') { req.emit('error', new Error('ECONNRESET (simulado)')); return; }
    const res = new EventEmitter();
    cb(res);
    res.emit('data', JSON.stringify({ data: FIXTURE[u.pathname] || [], meta: { total_paginas: 1, total_registros: (FIXTURE[u.pathname] || []).length } }));
    res.emit('end');
  });
  return req;
};

process.on('exit', () => {
  escreverDisco(process.env.HARNESS_OUT, JSON.stringify({ state, writes, diskWrites, gcCalls, HOJE }));
});
