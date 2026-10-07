#!/usr/bin/env node
'use strict';
// B3.3 — verificação técnica de saúde (somente leitura; --disparar aciona o disjuntor se houver violação). Saída sem PII.
const admin = require('firebase-admin'); const SA = require('../lib/reativacaoSaude');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
(async () => {
  const cfg = (await db.doc('carteira_comercial_config/reativacao').get()).data() || {}; const h = await SA.verificarSaude(db, { cfg, desde: cfg.ativadoEm || null });
  if (!h.ok && args.disparar) await SA.dispararDisjuntor(db, admin.firestore.FieldValue, h.violacoes, { agoraIso: new Date().toISOString(), origem: 'SCRIPT_SAUDE' });
  console.log(JSON.stringify({ ok: h.ok, modo: cfg.modo || 'DESLIGADO', carteiras: h.carteiras, reservas: h.reservas, eventos: h.eventos, violacoes: h.violacoes }, null, 1)); process.exit(h.ok ? 0 : 3);
})().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
