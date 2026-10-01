'use strict';
// AGENTE FINANCEIRO MR4 — Fase 2 · ponto de entrada do agendador (sem HTTP público, sem callable; o painel lê o Firestore protegido).
const F = require('./fetch');
const S = require('./sync');

// Agenda proposta: de 3 em 3 horas, minuto 40 (fora dos minutos de Compras :15, Carteira :45, Painel). Uma execução FULL dura ≈ 10 min.
// STALE_THRESHOLD = 6 h = 2 ciclos perdidos (+ folga) → painel sinaliza "dados desatualizados" depois disso.
const AGENDA = { CRON: '40 */3 * * *', TIMEZONE: 'America/Fortaleza', STALE_HORAS: 6 };

async function syncAgendadoHandler({ db, env = process.env, fetchImpl = fetch, log = () => {}, pausaMs = 350 }) {
  const cli = F.criarClienteGC({ fetchImpl, accessToken: env.GC_ACCESS_TOKEN, secretToken: env.GC_SECRET_ACCESS_TOKEN, pausaMs });
  return S.executarSyncFinanceiro({ cli, db, log });
}
module.exports = { AGENDA, syncAgendadoHandler };
