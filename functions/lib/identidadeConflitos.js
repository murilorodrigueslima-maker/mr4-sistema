'use strict';
/**
 * B2 — conflitos de identidade (sinais: CPF/CNPJ, telefone, e-mail) entre clientes do GestãoClick.
 * Sinais só DETECTAM conflito; NUNCA escolhem owner nem fundem cadastros. Saída sem PII (ids técnicos + hash agregado).
 */
const crypto = require('crypto');
const { grupoIdDe } = require('./carteiraV2');

const h = s => crypto.createHash('sha256').update('mr4id|' + s).digest('hex').slice(0, 16);
const dig = s => String(s == null ? '' : s).replace(/\D/g, '');
function cpfOk(d) { if (d.length !== 11 || new Set(d).size === 1) return false; for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); if (((s * 10) % 11) % 10 !== +d[n]) return false; } return true; }
function cnpjOk(d) {
  if (d.length !== 14 || new Set(d).size === 1) return false;
  const dv = (b, w) => { const r = b.split('').reduce((a, x, i) => a + +x * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  return dv(d.slice(0, 12), w1) === +d[12] && dv(d.slice(0, 13), [6, ...w1]) === +d[13];
}
function telCanon(raw) {
  let d = dig(raw); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (!(d.length === 10 || d.length === 11) || new Set(d).size === 1 || d[0] === '0' || d[1] === '0') return null;
  if (d.length === 11) return d[2] === '9' ? d : null;
  if (!/[2-9]/.test(d[2])) return null;
  return /[6-9]/.test(d[2]) ? d.slice(0, 2) + '9' + d.slice(2) : d;                   // celular antigo de 10 dígitos → forma canônica
}
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || '') && e.length <= 120;

/** Cliente GC bruto → registro derivado (hashes). O bruto não sai desta função. */
function derivarCliente(c) {
  const docRaw = dig(c.cnpj) || dig(c.cpf);
  const docOk = docRaw.length === 11 ? cpfOk(docRaw) : docRaw.length === 14 ? cnpjOk(docRaw) : false;
  const fones = new Set(); const add = v => { const t = telCanon(v); if (t) fones.add(h(t)); };
  ['telefone', 'celular', 'fax'].forEach(k => add(c[k]));
  for (const ct of c.contatos || []) { const x = ct && ct.contato ? ct.contato : ct; if (x && typeof x === 'object') ['telefone', 'celular'].forEach(k => add(x[k])); }
  const em = String(c.email || '').trim().toLowerCase();
  return { id: String(c.id), doc: docOk ? h(docRaw) : null, fones: [...fones], email: emailOk(em) ? h(em) : null, vendedorCadastral: String(c.vendedor_id || '') };
}

/** Grupos de conflito por componentes conectados. `carteiras`: Map('GC:id' → {ownerUid}). */
function detectarConflitos(clientes, carteiras = new Map(), agoraIso = null) {
  const par = new Map(); const find = x => { if (!par.has(x)) par.set(x, x); while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  const uni = (a, b) => par.set(find(a), find(b));
  const idx = { DOC_IGUAL: new Map(), TELEFONE_IGUAL: new Map(), EMAIL_IGUAL: new Map() };
  const put = (t, k, id) => { if (!idx[t].has(k)) idx[t].set(k, new Set()); idx[t].get(k).add(id); };
  for (const c of clientes) { if (c.doc) put('DOC_IGUAL', c.doc, c.id); c.fones.forEach(f => put('TELEFONE_IGUAL', f, c.id)); if (c.email) put('EMAIL_IGUAL', c.email, c.id); }
  const tiposPorId = new Map();
  for (const [t, m] of Object.entries(idx)) for (const ids of m.values()) if (ids.size > 1) {
    const L = [...ids]; L.slice(1).forEach(x => uni(L[0], x)); L.forEach(i => { if (!tiposPorId.has(i)) tiposPorId.set(i, new Set()); tiposPorId.get(i).add(t); });
  }
  const comps = new Map(); for (const id of tiposPorId.keys()) { const r = find(id); if (!comps.has(r)) comps.set(r, new Set()); comps.get(r).add(id); }
  const grupos = [];
  for (const ids of comps.values()) {
    const lista = [...ids].sort((a, b) => Number(a) - Number(b)); const tipos = new Set(); lista.forEach(i => tiposPorId.get(i).forEach(t => tipos.add(t)));
    const comCart = lista.filter(i => carteiras.has('GC:' + i)); const donos = new Set(comCart.map(i => carteiras.get('GC:' + i).ownerUid));
    grupos.push({ grupoId: grupoIdDe(lista), ids: lista, tipos: ['DOC_IGUAL', 'TELEFONE_IGUAL', 'EMAIL_IGUAL'].filter(t => tipos.has(t)),
      forca: tipos.has('DOC_IGUAL') ? 'FORTE' : tipos.has('TELEFONE_IGUAL') ? 'MEDIA' : 'FRACA', comCarteira: comCart, semCarteira: lista.filter(i => !carteiras.has('GC:' + i)), donosDiferentes: donos.size > 1 });
  }
  grupos.sort((a, b) => a.grupoId.localeCompare(b.grupoId));
  /** conflito por carteira (objeto do schema v2). */
  const porCarteira = new Map();
  for (const g of grupos) for (const id of g.comCarteira)
    porCarteira.set('GC:' + id, { grupoId: g.grupoId, tipos: g.tipos, forca: g.forca, relacionados: g.ids.filter(x => x !== id).map(x => 'GC:' + x), donosDiferentes: g.donosDiferentes,
      revisao: 'PENDENTE', revisores: ['PROPRIETARIO', 'CAMILA'], detectadoEm: agoraIso, origemDeteccao: 'B2_BACKFILL' });
  return { grupos, porCarteira, resumo: { grupos: grupos.length, clientes: grupos.reduce((a, g) => a + g.ids.length, 0), comCarteiraDeDonosDiferentes: grupos.filter(g => g.donosDiferentes).length,
    comCarteiraEIrmaoSem: grupos.filter(g => g.comCarteira.length && g.semCarteira.length).length, semNenhumaCarteira: grupos.filter(g => !g.comCarteira.length).length, carteirasMarcadas: porCarteira.size } };
}
module.exports = { derivarCliente, detectarConflitos, telCanon, cpfOk, cnpjOk, emailOk };
