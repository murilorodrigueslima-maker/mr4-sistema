'use strict';
/**
 * Contato (telefone) do cliente direto do GestãoClick — SOMENTE leitura, sob demanda, nunca persistido nem logado.
 * Prioridade: celular/WhatsApp válido; senão telefone comercial (fixo). Números normalizados com a mesma regra da identidade (celular antigo de 10 dígitos → 9º dígito).
 */
const { telCanon } = require('./identidadeConflitos');
const GC_BASE_URL = 'https://api.gestaoclick.com';

function criarLookupContatoGC({ accessToken, secretToken, fetchImpl = globalThis.fetch }) {
  if (!accessToken || !secretToken) throw new Error('criarLookupContatoGC: credenciais GC ausentes');
  return async gcId => {
    const id = String(gcId || ''); if (!/^\d+$/.test(id)) return null;
    const res = await fetchImpl(`${GC_BASE_URL}/clientes/${id}`, { method: 'GET', headers: { 'access-token': accessToken, 'secret-access-token': secretToken, 'Content-Type': 'application/json' } });
    if (!res || !res.ok) return null; const body = await res.json(); const d = (body && body.data) || {};
    if (String(d.id || '') !== id) return null;
    return { celular: d.celular, telefone: d.telefone, fax: d.fax, contatos: d.contatos };                 // só campos de telefone; nada mais sai daqui
  };
}
const fmt = n => (n.length === 11 ? `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}` : `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`);
/** @returns {null | {tipo:'CELULAR'|'COMERCIAL', numero:string, exibicao:string, whatsapp:string|null}} */
function escolherContato(c) {
  if (!c) return null; const brutos = [];
  ['celular', 'telefone'].forEach(k => brutos.push(c[k]));
  for (const ct of c.contatos || []) { const x = ct && ct.contato ? ct.contato : ct; if (x && typeof x === 'object') { brutos.push(x.celular); brutos.push(x.telefone); } }
  brutos.push(c.fax);
  const vistos = new Set(), cands = [];
  for (const b of brutos) { const n = telCanon(b); if (n && !vistos.has(n)) { vistos.add(n); cands.push(n); } }
  const movel = cands.find(n => n.length === 11 && n[2] === '9'); if (movel) return { tipo: 'CELULAR', numero: movel, exibicao: fmt(movel), whatsapp: '55' + movel };
  const fixo = cands.find(n => n.length === 10); return fixo ? { tipo: 'COMERCIAL', numero: fixo, exibicao: fmt(fixo), whatsapp: null } : null;
}
module.exports = { criarLookupContatoGC, escolherContato };
