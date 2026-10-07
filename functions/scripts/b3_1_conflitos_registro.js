#!/usr/bin/env node
'use strict';
// B3.1-E — registra de forma PERSISTENTE os grupos de conflito de identidade (identidade_conflitos). NÃO resolve, NÃO funde, NÃO muda owner/carteira.
//   node functions/scripts/b3_1_conflitos_registro.js --mode=dry-run
//   node functions/scripts/b3_1_conflitos_registro.js --mode=execute --expected-grupos=<N>
// GestãoClick: somente GET (credenciais do Secret Manager em memória). Escritas (execute): create-only em identidade_conflitos + auditoria S7. Saída sem PII.
const admin = require('firebase-admin'); const ID = require('../lib/identidadeConflitos'); const CONF = require('../lib/conflitosRegistro'); const { gcClientesDerivados } = require('../lib/gcFetchDerivado');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore(); const { FieldValue } = admin.firestore;
(async () => {
  const gc = args.fixture ? require(require('path').resolve(args.fixture)) : await gcClientesDerivados();
  const cart = new Map((await db.collection('carteira_comercial').get()).docs.map(d => [d.id, d.data()]));
  const c = ID.detectarConflitos(gc, cart, new Date().toISOString());
  const executar = args.mode === 'execute';
  if (executar && String(args['expected-grupos']) !== String(c.grupos.length)) { console.log(JSON.stringify({ ok: false, erro: '--expected-grupos difere do detectado', detectados: c.grupos.length })); process.exit(2); }
  const r = await CONF.registrarGrupos(db, FieldValue, c.grupos, { agoraIso: new Date().toISOString(), executar });
  console.log(JSON.stringify({ ok: true, modo: executar ? 'execute' : 'dry-run', gruposDetectados: c.grupos.length, clientes: c.resumo.clientes, resumo: c.resumo, aCriar: r.novos.length, jaExistentes: r.existentes.length, escritas: executar ? r.novos.length : 0 }, null, 1)); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
