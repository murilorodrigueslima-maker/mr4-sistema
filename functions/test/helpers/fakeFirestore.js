'use strict';
/** Firestore em memória (só o subconjunto usado pela reativação). Rejeita `undefined`, create() duplicado e transação atômica serializada. */
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function validar(v, caminho) {
  if (v === undefined) throw new Error('UNDEFINED_NAO_PERMITIDO:' + caminho);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) validar(x, caminho + '.' + k);
}
const ler = (o, campo) => campo.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const ordem = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const OPS = {
  '==': (x, v) => x === v, '>=': (x, v) => typeof x === typeof v && x >= v, '>': (x, v) => typeof x === typeof v && x > v, '<=': (x, v) => typeof x === typeof v && x <= v,
  in: (x, v) => { if (!v.length || v.length > 30) throw new Error('IN_INVALIDO:' + v.length); return v.includes(x); }, 'array-contains': (x, v) => Array.isArray(x) && x.includes(v),
};
function criarFake() {
  const dados = new Map();                                   // coleção → Map(id → doc)
  const col = n => { if (!dados.has(n)) dados.set(n, new Map()); return dados.get(n); };
  const snapDoc = (ref, d, campos) => ({ id: ref.id, ref, exists: d !== undefined, data: () => { if (d === undefined) return undefined; const c = clone(d); return campos ? Object.fromEntries(Object.entries(c).filter(([k]) => campos.includes(k))) : c; } });
  class Doc {
    constructor(c, id) { if (!id || String(id).includes('/')) throw new Error('ID_INVALIDO'); this.c = c; this.id = String(id); this.path = c + '/' + id; }
    async get() { return snapDoc(this, col(this.c).get(this.id)); }
    _set(v, o) { validar(v, this.path); col(this.c).set(this.id, o && o.merge ? { ...(col(this.c).get(this.id) || {}), ...clone(v) } : clone(v)); }
    _create(v) { if (col(this.c).has(this.id)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }); this._set(v); }
    _update(v) { if (!col(this.c).has(this.id)) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 }); this._set(v, { merge: true }); }
    async set(v, o) { this._set(v, o); } async create(v) { this._create(v); } async update(v) { this._update(v); } async delete() { col(this.c).delete(this.id); }
  }
  class Query {
    constructor(c, filtros = [], campos = null, max = null) { Object.assign(this, { c, filtros, campos, max }); }
    where(f, op, v) { if (!OPS[op]) throw new Error('OP_NAO_SUPORTADA:' + op); return new Query(this.c, [...this.filtros, [f, op, v]], this.campos, this.max); }
    select(...campos) { return new Query(this.c, this.filtros, campos, this.max); }
    limit(n) { return new Query(this.c, this.filtros, this.campos, n); }
    _docs() { let r = [...col(this.c)].filter(([, d]) => this.filtros.every(([f, op, v]) => OPS[op](ler(d, f), v))).sort((a, b) => ordem(a[0], b[0])); if (this.max != null) r = r.slice(0, this.max); return r.map(([id, d]) => snapDoc(new Doc(this.c, id), d, this.campos)); }
    async get() { const docs = this._docs(); return { docs, size: docs.length, empty: !docs.length }; }
    count() { const q = this; return { get: async () => { const n = q._docs().length; return { data: () => ({ count: n }) }; } }; }
  }
  class Collection extends Query { doc(id) { return new Doc(this.c, id); } }
  let fila = Promise.resolve();
  return {
    dados,
    collection: n => new Collection(n),
    doc: p => { const [c, id, resto] = p.split('/'); if (resto) throw new Error('SUBCOLECAO_NAO_SUPORTADA'); return new Doc(c, id); },
    runTransaction(fn) {
      const exec = async () => {
        const ops = [];
        const tx = { get: r => r.get(), set: (r, v, o) => ops.push(() => r._set(v, o)), create: (r, v) => ops.push(() => r._create(v)), update: (r, v) => ops.push(() => r._update(v)), delete: r => ops.push(() => col(r.c).delete(r.id)) };
        const res = await fn(tx);
        const antes = new Map([...dados].map(([k, m]) => [k, new Map(m)]));
        try { ops.forEach(o => o()); } catch (e) { dados.clear(); antes.forEach((m, k) => dados.set(k, m)); throw e; }
        return res;
      };
      const p = fila.then(exec); fila = p.catch(() => {}); return p;
    },
  };
}
const FieldValue = { serverTimestamp: () => 'TS_SERVIDOR' };
module.exports = { criarFake, FieldValue };
