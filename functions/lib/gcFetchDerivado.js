'use strict';
/** Leitura (GET) da base de clientes do GestãoClick; devolve SÓ registros derivados (hashes). Credenciais do Secret Manager em memória. */
const cp = require('child_process');
const ID = require('./identidadeConflitos');
async function gcClientesDerivados({ fetchImpl = globalThis.fetch, projeto = 'mr4-ponto', pausaMs = 700 } = {}) {
  const seg = n => cp.execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${n}`, `--project=${projeto}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const headers = { 'access-token': seg('GC_ACCESS_TOKEN'), 'secret-access-token': seg('GC_SECRET_ACCESS_TOKEN'), 'Content-Type': 'application/json' };
  const out = []; let total = null;
  for (let pg = 1; pg <= 60; pg++) {
    const r = await fetchImpl(`https://api.gestaoclick.com/clientes?limite=100&pagina=${pg}`, { method: 'GET', headers });
    if (!r.ok) throw new Error('GC HTTP ' + r.status + ' página ' + pg);
    const j = await r.json(); total = total ?? (j.meta && j.meta.total_registros); const lote = j.data || []; if (!lote.length) break;
    for (const c of lote) out.push(ID.derivarCliente(c)); await new Promise(res => setTimeout(res, pausaMs));
  }
  if (total !== null && out.length !== total) throw new Error('GC: total lido difere do meta ' + out.length + '/' + total);
  return out;
}
module.exports = { gcClientesDerivados };
