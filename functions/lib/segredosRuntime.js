'use strict';
/**
 * Leitura dos segredos do GestãoClick em TEMPO DE EXECUÇÃO (Secret Manager, versão "latest"), com cache curto.
 * Motivo: o Firebase fixa a versão do segredo no deploy; assim a rotação feita pelo módulo Integrações vale em até TTL, SEM reimplantar nada.
 * Só lê os 3 nomes da lista (nunca um nome arbitrário). Falha de leitura ⇒ mantém o valor já existente no ambiente (nunca derruba a função).
 * Nenhum valor é logado ou retornado a navegador.
 */
const PROJETO = 'mr4-ponto';
const NOMES = Object.freeze(['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN', 'GC_WEBHOOK_SECRET']);
const TTL_PADRAO_MS = 5 * 60 * 1000;
const cache = new Map();

async function acessarLatest(nome) {
  const { GoogleAuth } = require('google-auth-library');
  const c = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const r = await c.request({ url: `https://secretmanager.googleapis.com/v1/projects/${PROJETO}/secrets/${nome}/versions/latest:access`, method: 'GET', timeout: 8000 });
  const b64 = r && r.data && r.data.payload && r.data.payload.data;
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : null;
}

/** Valor atual do segredo (cache TTL); em falha devolve `reserva` (valor do ambiente). */
async function lerSegredo(nome, { reserva = null, ttlMs = TTL_PADRAO_MS, agora = () => Date.now(), leitor = acessarLatest } = {}) {
  if (!NOMES.includes(nome)) throw new Error('SEGREDO_FORA_DA_LISTA');
  const c = cache.get(nome); const t = agora();
  if (c && c.ate > t) return c.valor;
  try { const v = await leitor(nome); if (v) { cache.set(nome, { valor: v, ate: t + ttlMs }); return v; } } catch (_) { /* mantém a reserva */ }
  if (reserva) cache.set(nome, { valor: reserva, ate: t + Math.min(ttlMs, 30000) });   // evita martelar a API em falha
  return reserva;
}

/** Atualiza process.env.GC_* com a versão mais recente. Nunca lança. */
async function atualizarEnvGc(opcoes = {}) {
  for (const nome of ['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN']) {
    try { const v = await lerSegredo(nome, { reserva: process.env[nome] || null, ...opcoes }); if (v && v !== process.env[nome]) process.env[nome] = v; } catch (_) { /* mantém o ambiente */ }
  }
}
function _limparCache() { cache.clear(); }
module.exports = { lerSegredo, atualizarEnvGc, NOMES, TTL_PADRAO_MS, _limparCache };
