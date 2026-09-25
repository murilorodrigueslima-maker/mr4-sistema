'use strict';
// N35.14 — Ordenação canônica única da Fila Comercial (snapshot HOJE e worklist diária).
//   1. prioridade DESC
//   2. diasSemComprar DESC
//   3. identidade canônica ASC (commercialEntityId; fallback clienteMr4Id → opportunityInstanceId)
// Comparação por código de caractere (não localeCompare) para ser byte-estável em qualquer runtime.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : -Infinity;
}

function chaveIdentidade(c) {
  return String(c.commercialEntityId || c.clienteMr4Id || c.opportunityInstanceId || '');
}

function compararOrdemCanonica(a, b) {
  const pa = num(a.prioridade), pb = num(b.prioridade);
  if (pa !== pb) return pb > pa ? 1 : -1;
  const da = num(a.diasSemComprar), db = num(b.diasSemComprar);
  if (da !== db) return db > da ? 1 : -1;
  const ka = chaveIdentidade(a), kb = chaveIdentidade(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

module.exports = { compararOrdemCanonica, chaveIdentidade };
