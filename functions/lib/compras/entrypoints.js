'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — pontos de entrada de produção (ligados em functions/index.js).
//   comprasSyncManual       HTTP PRIVADO (IAM; sem acesso público) · POST { tipo: 'FULL' | 'INCREMENTAL' }
//   comprasSyncCompleto     agendado · reconciliação diária
//   comprasSyncIncremental  agendado · atualização a cada 3 h
// GestãoClick: somente GET (guarda no cliente). Credenciais: secrets GC_ACCESS_TOKEN / GC_SECRET_ACCESS_TOKEN.
// Respostas e logs: só metadados seguros do registro de execução.
const F = require('./fetch');
const E = require('./execucao');

// Agenda APROVADA pelo gestor em 29/09/2026 (America/Fortaleza). Infraestrutura, não regra de negócio.
const AGENDA = Object.freeze({
  TIMEZONE: 'America/Fortaleza',
  FULL: '15 3 * * *',                         // 03:15 todo dia
  INCREMENTAL: '15 6,9,12,15,18,21 * * *',    // 06:15 · 09:15 · 12:15 · 15:15 · 18:15 · 21:15
});
const PAUSA_ENTRE_GETS_MS = 350;

function criarClienteProducao({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.GC_ACCESS_TOKEN || !env.GC_SECRET_ACCESS_TOKEN) { const e = new Error('SECRETS_GC_AUSENTES'); e.codigo = 'SECRETS_GC_AUSENTES'; throw e; }
  return F.criarClienteGC({ fetchImpl, accessToken: env.GC_ACCESS_TOKEN, secretToken: env.GC_SECRET_ACCESS_TOKEN, pausaMs: PAUSA_ENTRE_GETS_MS });
}

/** Resumo seguro de um registro de execução (para resposta HTTP e log). */
function resumoSeguro(reg) {
  const { run_id, tipo, gatilho, status, inicio, fim, duracao_ms, chamadas_gc, repeticoes, policy_version, quantidades, tamanho, avisos, erro, detida_por } = reg;
  return { run_id, tipo, gatilho, status, inicio, fim, duracao_ms, chamadas_gc, repeticoes, policy_version, quantidades, tamanho, avisos, erro, detida_por };
}
function logar(reg, log = console) { log.log(JSON.stringify({ evento: 'compras_sync', ...resumoSeguro(reg) })); }

/** HTTP privado. Só POST; tipo obrigatório; resposta = resumo seguro. */
async function syncManualHandler(req, res, { db, criarCliente = criarClienteProducao, log = console, agora } = {}) {
  if (req.method !== 'POST') { res.status(405).json({ erro: 'METODO_NAO_PERMITIDO' }); return; }
  const tipo = req.body && req.body.tipo;
  if (!E.TIPOS.includes(tipo)) { res.status(400).json({ erro: 'TIPO_INVALIDO', permitido: E.TIPOS }); return; }
  let cli;
  try { cli = criarCliente(); } catch (e) { res.status(500).json({ erro: E.sanitizarErro(e) }); return; }
  const reg = await E.executarExecucao({ db, cli, tipo, gatilho: 'MANUAL', ...(agora ? { agora } : {}) });
  logar(reg, log);
  res.status(reg.status === 'OK' ? 200 : reg.status === 'SKIPPED_LOCKED' ? 409 : 500).json(resumoSeguro(reg));
}

/** Agendado. Nunca lança (falha fica no registro e no meta; o último snapshot válido é preservado). */
async function syncAgendadoHandler(tipo, { db, criarCliente = criarClienteProducao, log = console, agora } = {}) {
  try {
    const reg = await E.executarExecucao({ db, cli: criarCliente(), tipo, gatilho: 'SCHEDULED', ...(agora ? { agora } : {}) });
    logar(reg, log);
    return reg;
  } catch (e) {
    const reg = { tipo, gatilho: 'SCHEDULED', status: 'FAILED', erro: E.sanitizarErro(e) };
    logar(reg, log);
    return reg;
  }
}

module.exports = { AGENDA, PAUSA_ENTRE_GETS_MS, criarClienteProducao, resumoSeguro, syncManualHandler, syncAgendadoHandler };
