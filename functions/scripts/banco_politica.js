#!/usr/bin/env node
'use strict';
// Política do banco de horas — SOMENTE com valores EXPLÍCITOS informados pela gestão/jurídico. Sem defaults: o que faltar fica ausente (= desligado/não permitido).
// Uso (dry-run por padrão):  node scripts/banco_politica.js --acumulativoAtivo=true --compensacaoAtiva=true --permiteSaldoNegativo=true --limiteNegativoMin=600 --prazoCompensacaoDias=90 --baseJuridica="Acordo X cl. Y" [--aplicar]
// NUNCA habilita desconto em folha/rescisão (não existe parâmetro para isso). Registra quem/quando em banco_horas_config/politica_historico/{ts} (append-only).
const admin = require('firebase-admin');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : []; }));
const bool = k => args[k] === undefined ? undefined : (args[k] === 'true' || args[k] === true);
const int = k => args[k] === undefined ? undefined : Number(args[k]);
const pol = { acumulativoAtivo: bool('acumulativoAtivo'), compensacaoAtiva: bool('compensacaoAtiva'), permiteSaldoNegativo: bool('permiteSaldoNegativo'), limiteNegativoMin: int('limiteNegativoMin'), prazoCompensacaoDias: int('prazoCompensacaoDias'), baseJuridica: args.baseJuridica };
Object.keys(pol).forEach(k => pol[k] === undefined && delete pol[k]);
const erros = [];
if (pol.permiteSaldoNegativo === true && !(Number.isInteger(pol.limiteNegativoMin) && pol.limiteNegativoMin > 0)) erros.push('permiteSaldoNegativo=true exige limiteNegativoMin inteiro > 0 (minutos)');
if (pol.prazoCompensacaoDias !== undefined && !(Number.isInteger(pol.prazoCompensacaoDias) && pol.prazoCompensacaoDias > 0)) erros.push('prazoCompensacaoDias deve ser inteiro > 0');
if ((pol.acumulativoAtivo || pol.compensacaoAtiva) && !pol.baseJuridica) erros.push('ativar exige baseJuridica (acordo aplicável validado)');
if (erros.length) { console.log(JSON.stringify({ ok: false, erros })); process.exit(2); }
console.log(JSON.stringify({ ok: true, modo: args.aplicar ? 'APLICAR' : 'DRY-RUN', politica: pol }));
if (!args.aplicar) process.exit(0);
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
(async () => {
  const ref = db.doc('banco_horas_config/politica'); const antes = (await ref.get()).data() || null;
  await db.collection('banco_horas_config_historico').doc(new Date().toISOString().replace(/\W/g, '')).set({ antes, depois: pol, em: admin.firestore.FieldValue.serverTimestamp(), origem: 'scripts/banco_politica.js' });
  await ref.set(pol, { merge: true }); console.log(JSON.stringify({ aplicado: true }));
})().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
