'use strict';
// N35.14 — Resolução de nome SOMENTE para as oportunidades entregues na worklist do dia.
// Nome é apresentação: nunca identidade, join ou chave de deduplicação.
// Sem I/O próprio: o lookup (ex.: API GestãoClick por gestaoClickId) é injetado pelo chamador.

const { sanitizeCommercialDisplayName, contemDocumento } = require('./nomeExibicao');

const MAX_LOOKUPS_PADRAO = 20;

/**
 * @param {Array}    itens        — entradas da worklist (com commercialEntityId, gestaoClickId, nomeCliente?)
 * @param {object}   opts
 * @param {Function} opts.lookupNome — async (gestaoClickId) => string|null
 * @param {number}   [opts.max]      — teto de lookups por execução
 * @returns {Promise<{ itens: Array, lookups: number, naoResolvidos: number }>}
 */
async function resolverNomesSelecionados(itens, { lookupNome, max = MAX_LOOKUPS_PADRAO } = {}) {
  if (!Array.isArray(itens)) throw new Error('resolverNomesSelecionados: itens deve ser array');
  if (typeof lookupNome !== 'function') throw new Error('resolverNomesSelecionados: lookupNome obrigatório');
  let lookups = 0;
  let naoResolvidos = 0;
  const cache = new Map();
  const out = [];
  for (const item of itens) {
    const existente = sanitizeCommercialDisplayName(item.nomeCliente);
    if (existente) { out.push({ ...item, nomeCliente: existente, nameResolved: 'EXISTENTE' }); continue; }
    const gc = item.gestaoClickId ? String(item.gestaoClickId) : null;
    if (!gc) { naoResolvidos++; out.push({ ...item, nameResolved: 'SEM_GC_ID' }); continue; }
    if (!cache.has(gc)) {
      if (lookups >= max) { naoResolvidos++; out.push({ ...item, nameResolved: 'LIMITE' }); continue; }
      lookups++;
      let nome = null;
      try { nome = await lookupNome(gc); } catch (_) { nome = null; }
      cache.set(gc, sanitizeCommercialDisplayName(typeof nome === 'string' ? nome.trim() : null));
    }
    const nome = cache.get(gc);
    if (!nome) naoResolvidos++;
    // identidade intocada: apenas nomeCliente é acrescentado
    out.push({ ...item, nomeCliente: nome, nameResolved: nome ? 'LOOKUP' : 'FALHOU' });
  }
  return { itens: out, lookups, naoResolvidos };
}

const GC_BASE_URL = 'https://api.gestaoclick.com';

/**
 * Lookup de nome no GestãoClick por ID (GET /clientes/{id}). Retorna SOMENTE o nome de exibição
 * (nome_fantasia || razao_social || nome) — nenhum documento, contato ou endereço sai daqui.
 * Credenciais vêm do chamador (Secret Manager na Cloud Function); fetch injetável para testes.
 */
function criarLookupNomeGC({ accessToken, secretToken, fetchImpl = globalThis.fetch }) {
  if (!accessToken || !secretToken) throw new Error('criarLookupNomeGC: credenciais GC ausentes');
  const stats = { sanitized: 0, sanitizedEmpty: 0 }; // contagens apenas — nunca o conteúdo removido
  async function lookupNome(gestaoClickId) {
    const id = String(gestaoClickId || '');
    if (!/^\d+$/.test(id)) return null;
    const res = await fetchImpl(`${GC_BASE_URL}/clientes/${id}`, {
      method: 'GET',
      headers: { 'access-token': accessToken, 'secret-access-token': secretToken, 'Content-Type': 'application/json' },
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const d = (body && body.data) || {};
    if (String(d.id || '') !== id) return null;
    const nome = d.nome_fantasia || d.razao_social || d.nome || null;
    // N35.16.1: o cadastro GC pode trazer CPF/CNPJ dentro do nome — nunca sai daqui com documento
    const bruto = typeof nome === 'string' ? nome.trim() : null;
    const limpo = sanitizeCommercialDisplayName(bruto);
    if (contemDocumento(bruto)) { stats.sanitized++; if (!limpo) stats.sanitizedEmpty++; }
    return limpo;
  }
  lookupNome.stats = stats;
  return lookupNome;
}

module.exports = { resolverNomesSelecionados, criarLookupNomeGC, MAX_LOOKUPS_PADRAO };
