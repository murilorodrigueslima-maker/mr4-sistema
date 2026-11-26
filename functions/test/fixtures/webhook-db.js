'use strict';
// Firestore falso para os testes do webhook: documentos, transação serializada, set/merge, where ==, orderBy, limit e contagem de leituras/gravações.
const copia = v => JSON.parse(JSON.stringify(v));
function dbWebhook(inicial = {}) {
  const st = copia(inicial); const n = { leituras: 0, gravacoes: 0 };
  const db = { st, n, falhar: null };
  const checar = (op, c, id) => { if (db.falhar) db.falhar({ op, c, id }); };
  const ler = (c, id) => { const d = st[c] && st[c][id]; return { id, exists: d !== undefined, data: () => (d === undefined ? undefined : copia(d)) }; };
  const grava = (c, id, v, o) => { n.gravacoes++; st[c] = st[c] || {}; st[c][id] = copia(o && o.merge ? { ...(st[c][id] || {}), ...v } : v); };
  const doc = (c, id) => ({ c, id,
    get: async () => { checar('get', c, id); n.leituras++; return ler(c, id); },
    set: async (v, o) => { checar('set', c, id); grava(c, id, v, o); },
    create: async v => { checar('create', c, id); if (st[c] && st[c][id] !== undefined) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } grava(c, id, v); } });
  const consulta = (c, filtros = [], ordem = null, lim = Infinity) => ({
    where: (campo, op, v) => consulta(c, [...filtros, [campo, v]], ordem, lim),
    orderBy: (campo, dir) => consulta(c, filtros, [campo, dir], lim),
    limit: l => consulta(c, filtros, ordem, l),
    get: async () => { checar('query', c);
      let ids = Object.keys(st[c] || {}).filter(id => filtros.every(([k, v]) => st[c][id][k] === v));
      if (ordem) ids.sort((a, b) => (st[c][a][ordem[0]] - st[c][b][ordem[0]]) * (ordem[1] === 'desc' ? -1 : 1));
      ids = ids.slice(0, lim); n.leituras += Math.max(1, ids.length); return { docs: ids.map(id => ler(c, id)), size: ids.length }; } });
  db.collection = c => Object.assign(consulta(c), { doc: id => doc(c, id) });
  let fila = Promise.resolve();
  db.runTransaction = fn => { const exec = async () => { const efeitos = [];
      const res = await fn({ get: async r => { checar('txget', r.c, r.id); n.leituras++; return ler(r.c, r.id); }, set: (r, v, o) => efeitos.push(() => grava(r.c, r.id, v, o)) });
      for (const e of efeitos) e(); return res; };
    const p = fila.then(exec, exec); fila = p.catch(() => {}); return p; };
  return db;
}
const loggerFalso = () => { const linhas = []; const f = nivel => (msg, dados) => linhas.push({ nivel, msg, ...dados }); return { linhas, info: f('info'), warn: f('warn'), error: f('error'), alertas: () => linhas.filter(l => l.msg === 'WEBHOOK_GC_ALERTA') }; };
module.exports = { dbWebhook, loggerFalso };
