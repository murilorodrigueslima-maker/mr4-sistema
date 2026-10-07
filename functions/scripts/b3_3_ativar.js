#!/usr/bin/env node
'use strict';
// B3.3 — ATIVAÇÃO PILOTO. Pré-checagens críticas (qualquer falha ⇒ aborta SEM ativar), registro do instante de ativação como CORTE, ativação do motor B3,
// primeira liberação do piloto (limite persistente no servidor) e validação imediata. Credencial: ADC; GestãoClick só GET (Secret Manager em memória).
//   node functions/scripts/b3_3_ativar.js --backup-dir=<dir> --limite=5 --confirm=ATIVAR_PILOTO
const admin = require('firebase-admin'); const cp = require('child_process'); const fs = require('fs'), path = require('path');
const C2 = require('../lib/carteiraV2'); const MOTOR = require('../lib/motorCarteira'); const SA = require('../lib/reativacaoSaude'); const JOB = require('../lib/reativacaoJob'); const { criarLookupNomeGC } = require('../lib/filaNomes');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore(); const FV = admin.firestore.FieldValue;
const falha = (m, x) => { console.log(JSON.stringify({ ok: false, ativado: false, erro: m, ...(x || {}) }, null, 1)); process.exit(2); };
const seg = n => cp.execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${n}`, '--project=mr4-ponto'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
(async () => {
  if (args.confirm !== 'ATIVAR_PILOTO') falha('--confirm=ATIVAR_PILOTO obrigatório');
  const limite = Number(args.limite); if (!Number.isInteger(limite) || limite < 1 || limite > 5) falha('--limite deve ser 1..5 (piloto)');
  // 1) estado atual DESLIGADO
  const [cm, cr, cg] = await Promise.all([db.doc('carteira_comercial_config/motor').get(), db.doc('carteira_comercial_config/reativacao').get(), db.doc('carteira_comercial_config/regra').get()]);
  if (MOTOR.lerMotor(cm.data()) !== 'NENHUM') falha('motor não está NENHUM');
  if (cr.exists && cr.data().modo && cr.data().modo !== 'DESLIGADO') falha('reativacao já está ligada');
  if (!cg.exists || cg.data().modo !== 'SOMBRA') falha('regra R2 não está em SOMBRA');
  // 2) backup válido e idêntico ao estado atual
  const man = JSON.parse(fs.readFileSync(path.join(args['backup-dir'], 'manifest.json'), 'utf8')); const cart = (await db.collection('carteira_comercial').get()); const docs = Object.fromEntries(cart.docs.map(d => [d.id, d.data()]));
  if (C2.impressaoOwnership(docs) !== man.impressaoOwnership) falha('ownership atual difere do backup'); if (cart.size !== 367) falha('carteiras != 367', { n: cart.size });
  const owners = C2.contagemPorOwner(docs); const vals = Object.values(owners).sort((a, b) => a - b); if (vals.join() !== '152,215') falha('contagem por dono inesperada', { owners });
  // 3) saúde do estado atual
  const h = await SA.verificarSaude(db, { cfg: {} }); if (!h.ok) falha('saúde com violações', { violacoes: h.violacoes });
  if (!(await db.collection('carteira_reativacoes').limit(1).get()).empty) falha('já existem reservas — esperado piloto limpo');
  // 4) corte = instante da ativação (hora de Fortaleza para comparar com vendas_gc.cadastrado_em)
  const agora = new Date(); const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(agora);
  const cfg = { modo: 'ATIVO', corte: hoje, corteTs: agora.toISOString(), ativadoEm: agora.toISOString(), limiteDiario: limite, maxReservasAtivas: limite, incluirSemCarteira: false, piloto: true, ativadoPor: 'B3.3', backup: path.basename(args['backup-dir']) };
  await db.doc('carteira_comercial_config/reativacao').set(cfg); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3', alteradoEm: agora.toISOString(), alteradoPor: 'B3.3' });
  // 5) primeira execução do job (mesmo código do agendador) com consulta de nomes real (GET)
  const lookupNome = criarLookupNomeGC({ accessToken: seg('GC_ACCESS_TOKEN'), secretToken: seg('GC_SECRET_ACCESS_TOKEN') });
  const rr = await JOB.executarReativacaoDiaria(db, FV, { hoje, agoraIso: agora.toISOString(), lookupNome });
  if (rr.status !== 'ATIVO') { await db.doc('carteira_comercial_config/reativacao').set({ modo: 'DESLIGADO', abortadoEm: new Date().toISOString(), abortadoMotivo: 'primeira execução não ATIVA: ' + rr.status }, { merge: true }); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'NENHUM' }); falha('primeira execução não ficou ATIVA; motor desligado de volta', { status: rr.status }); }
  console.log(JSON.stringify({ ok: true, ativado: true, ativacao: agora.toISOString(), corte: hoje, limite, criadas: rr.criadas, repetidas: rr.repetidas, semNome: rr.semNome, expiradas: rr.expiradas }, null, 1)); process.exit(0);
})().catch(e => falha(e.message));
