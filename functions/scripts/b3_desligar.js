#!/usr/bin/env node
'use strict';
// B3.3 — KILL SWITCH: desliga imediatamente o motor B3 SEM apagar reservas, carteiras ou histórico.
//   node functions/scripts/b3_desligar.js [--motivo="texto"]   (efeito na próxima execução dos agendadores; também pausa os 2 agendadores se --pausar-agendadores)
//   Religar exige autorização explícita (reescrever carteira_comercial_config/reativacao.modo e motor).
const admin = require('firebase-admin'); const cp = require('child_process');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
(async () => {
  const agora = new Date().toISOString();
  await db.doc('carteira_comercial_config/reativacao').set({ modo: 'DESLIGADO', desligadoManualEm: agora, desligadoMotivo: String(args.motivo || 'manual') }, { merge: true });
  await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'NENHUM', alteradoEm: agora }, { merge: true });
  const out = { ok: true, modo: 'DESLIGADO', motor: 'NENHUM', em: agora, apagado: 0 };
  if (args['pausar-agendadores']) { out.agendadores = []; for (const j of ['firebase-schedule-reativacaoDiaria-southamerica-east1', 'firebase-schedule-reativacaoVendas-southamerica-east1']) { try { cp.execFileSync('gcloud', ['scheduler', 'jobs', 'pause', j, '--location=southamerica-east1', '--project=mr4-ponto'], { stdio: 'ignore' }); out.agendadores.push({ job: j, pausado: true }); } catch (e) { out.agendadores.push({ job: j, pausado: false }); } } }
  console.log(JSON.stringify(out, null, 1)); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
