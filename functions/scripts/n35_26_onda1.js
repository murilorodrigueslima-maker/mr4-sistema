#!/usr/bin/env node
'use strict';
// N35.26 — Onda 1 da Carteira Comercial: 367 carteiras + 367 eventos CARTEIRA_CRIADA (734 writes).
//
// Credencial: firebase-admin com Application Default Credentials (gcloud auth application-default login)
//             ou GOOGLE_APPLICATION_CREDENTIALS. Nenhuma credencial é lida, montada ou impressa por este script.
//
// Uso:
//   node functions/scripts/n35_26_onda1.js --mode=dry-run --wave=<wave1.json> --expected-signature=393192682ca5bed4 --operador=<uid>
//   node functions/scripts/n35_26_onda1.js --mode=execute --wave=... --expected-signature=... --operador=<uid> --confirm=367
//   node functions/scripts/n35_26_onda1.js --mode=verify  --wave=... --expected-signature=... --operador=<uid>
//   (--emulator só para ensaio local: exige FIRESTORE_EMULATOR_HOST)
//
// Gates embutidos (qualquer falha = exit != 0, nada escrito):
//   assinatura (âncora, owner) = esperada · 367 itens · IDs/âncoras válidos · sem duplicata
//   execute: carteira_comercial e _historico VAZIAS antes · --confirm=367 · failFast (para no 1º conflito)
//   verify: 367/367 documento a documento + dry-run pós-migração (ALREADY_EXISTS_SAME=367)
// Saída: JSON sem PII (IDs técnicos e contagens).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const MODE = args.mode;
const LOTE = args.lote || 'N3526_ONDA1';
const EXPECTED_N = 367;
const MOTIVO = 'Migração N35.26 — Onda 1 (consenso total cadastro × última venda × predominante)';
function falhar(msg, extra) { console.log(JSON.stringify({ ok: false, erro: msg, ...(extra || {}) }, null, 1)); process.exit(2); }

if (!['dry-run', 'execute', 'verify'].includes(MODE)) falhar('--mode deve ser dry-run | execute | verify');
if (!args.wave || !args['expected-signature'] || !args.operador) falhar('--wave, --expected-signature e --operador são obrigatórios');
if (args.emulator && !process.env.FIRESTORE_EMULATOR_HOST) falhar('--emulator exige FIRESTORE_EMULATOR_HOST');
if (!args.emulator && process.env.FIRESTORE_EMULATOR_HOST) falhar('FIRESTORE_EMULATOR_HOST definido sem --emulator (proteção contra alvo errado)');

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'mr4-ponto', ...(args.emulator ? {} : { credential: admin.credential.applicationDefault() }) });
const db = admin.firestore();
const M = require('../lib/carteiraMigracao');
const CI = require('../lib/commercialIdentity');
const V1 = require('../lib/carteiraV1');

const wave = JSON.parse(fs.readFileSync(path.resolve(args.wave), 'utf8'));
const assinatura = crypto.createHash('sha256').update(JSON.stringify(wave.map(x => [x.portfolioId, x.proposedOwnerUid]).sort())).digest('hex').slice(0, 16);
const problemas = [];
if (wave.length !== EXPECTED_N) problemas.push('INPUT=' + wave.length);
if (assinatura !== args['expected-signature']) problemas.push('ASSINATURA=' + assinatura);
if (new Set(wave.map(x => x.portfolioId)).size !== wave.length) problemas.push('DUPLICATAS');
for (const x of wave) {
  if (!CI.PORTFOLIO_ANCHOR_RE.test(x.portfolioId) || !V1.ENT_RE.test(x.identidadeAtual) || !x.proposedOwnerUid || !x.origemComercialUid || !x.origemComercialGestaoClickId) { problemas.push('ITEM_INVALIDO:' + x.portfolioId); break; }
}
if (problemas.length) falhar('Onda divergente da prévia aprovada — STOP', { problemas, WAVE1_INPUT_CHANGED: 'YES' });

const base = { itens: wave, loteId: LOTE, operadorUid: String(args.operador), motivo: MOTIVO, agoraIso: new Date().toISOString() };
const contar = async c => (await db.collection(c).count().get()).data().count;
const resumo = r => ({ total: r.total, criados: r.criados, wouldCreate: r.wouldCreate, jaExistentesMesmoOwner: r.jaExistentesMesmoOwner,
  conflitos: r.conflitos, identidade: r.identidade, paradoEm: r.paradoEm });

(async () => {
  if (MODE === 'dry-run') {
    const r = await M.executarOndaMigracao(db, { ...base, dryRun: true });
    const ok = r.wouldCreate === EXPECTED_N && !r.conflitos.length && !r.identidade.length && r.jaExistentesMesmoOwner === 0;
    console.log(JSON.stringify({ ok, modo: MODE, assinatura, INPUT: wave.length, WOULD_CREATE_PORTFOLIOS: r.wouldCreate, WOULD_CREATE_HISTORY: r.wouldCreate,
      WOULD_WRITE_TOTAL: r.wouldCreate * 2, WOULD_UPDATE_EXISTING: 0, WOULD_DELETE: 0, ALREADY_EXISTS_SAME: r.jaExistentesMesmoOwner, ...resumo(r) }, null, 1));
    process.exit(ok ? 0 : 3);
  }
  if (MODE === 'execute') {
    if (String(args.confirm) !== String(EXPECTED_N)) falhar('--confirm=' + EXPECTED_N + ' obrigatório para escrever');
    const [c0, h0] = await Promise.all([contar(M.COLL), contar(M.COLL_HIST)]);
    if (c0 !== 0 || h0 !== 0) falhar('Coleções de carteira não estão vazias — STOP (use --mode=verify para inspecionar)', { CARTEIRAS_BEFORE: c0, HISTORICO_BEFORE: h0 });
    const r = await M.executarOndaMigracao(db, { ...base, failFast: true });
    const [c1, h1] = await Promise.all([contar(M.COLL), contar(M.COLL_HIST)]);
    const ok = r.criados === EXPECTED_N && !r.paradoEm && c1 === EXPECTED_N && h1 === EXPECTED_N;
    console.log(JSON.stringify({ ok, modo: MODE, assinatura, lote: LOTE, CARTEIRAS_BEFORE: c0, HISTORICO_BEFORE: h0, CARTEIRAS_AFTER: c1, HISTORICO_AFTER: h1, ...resumo(r) }, null, 1));
    process.exit(ok ? 0 : 4);
  }
  // verify: documento a documento + idempotência (dry-run sobre o estado migrado)
  const [cs, hs] = await Promise.all([db.collection(M.COLL).get(), db.collection(M.COLL_HIST).get()]);
  const cart = new Map(cs.docs.map(d => [d.id, d.data()])), hist = new Map(hs.docs.map(d => [d.id, d.data()]));
  const v = { CARTEIRAS_AFTER: cs.size, HISTORICO_AFTER: hs.size, GC_ANCHOR_DOCUMENTS: cs.docs.filter(d => CI.PORTFOLIO_ANCHOR_RE.test(d.id)).length,
    NON_GC_ANCHOR_DOCUMENTS: cs.docs.filter(d => !CI.PORTFOLIO_ANCHOR_RE.test(d.id)).length,
    OWNER_MATCH: 0, OWNER_MISMATCH: 0, ORIGIN_MATCH: 0, ORIGIN_MISMATCH: 0, VERSION_VALID: 0, HISTORY_MATCH: 0, MISSING_PORTFOLIOS: 0, MISSING_HISTORY: 0,
    DOCS_FORA_DA_ONDA: 0, EVENTOS_FORA_DA_ONDA: 0, WHITELIST_OK: 0 };
  const idsOnda = new Set(wave.map(x => x.portfolioId)), evOnda = new Set(wave.map(x => M.idEventoMigracao(LOTE, x.portfolioId)));
  for (const x of wave) {
    const d = cart.get(x.portfolioId), h = hist.get(M.idEventoMigracao(LOTE, x.portfolioId));
    if (!d) { v.MISSING_PORTFOLIOS++; continue; }
    if (V1.validarDocCarteiraV1(d) === null) v.WHITELIST_OK++;
    d.ownerUid === x.proposedOwnerUid ? v.OWNER_MATCH++ : v.OWNER_MISMATCH++;
    (d.origemComercialUid === x.origemComercialUid && d.origemComercialGestaoClickId === x.origemComercialGestaoClickId) ? v.ORIGIN_MATCH++ : v.ORIGIN_MISMATCH++;
    if (d.versao === 1 && d.portfolioId === x.portfolioId) v.VERSION_VALID++;
    if (!h) v.MISSING_HISTORY++;
    else if (h.tipoEvento === 'CARTEIRA_CRIADA' && h.portfolioId === x.portfolioId && h.ownerNovoUid === x.proposedOwnerUid && h.versao === 1 && h.chaveIdempotencia === 'MIGRACAO:' + LOTE + ':' + x.portfolioId) v.HISTORY_MATCH++;
  }
  v.DOCS_FORA_DA_ONDA = [...cart.keys()].filter(k => !idsOnda.has(k)).length;
  v.EVENTOS_FORA_DA_ONDA = [...hist.keys()].filter(k => !evOnda.has(k)).length;
  v.DUPLICATE_HISTORY = hs.docs.filter(d => d.data().tipoEvento === 'CARTEIRA_CRIADA').length - new Set(hs.docs.map(d => d.data().portfolioId)).size;
  const idem = await M.executarOndaMigracao(db, { ...base, dryRun: true });
  v.POST_MIGRATION_DRY_RUN = { ALREADY_EXISTS_SAME: idem.jaExistentesMesmoOwner, WOULD_CREATE: idem.wouldCreate, WOULD_UPDATE: 0, WOULD_DELETE: 0, CONFLICTS: idem.conflitos.length, IDENTITY_ERRORS: idem.identidade.length };
  // rollback: elegível = doc da onda ainda na versão 1, sem eventos além do da onda
  const eventosPorAncora = new Map(); for (const d of hs.docs) eventosPorAncora.set(d.data().portfolioId, (eventosPorAncora.get(d.data().portfolioId) || 0) + 1);
  v.ROLLBACK_ELIGIBLE = wave.filter(x => { const d = cart.get(x.portfolioId); return d && d.versao === 1 && (eventosPorAncora.get(x.portfolioId) || 0) === 1; }).length;
  v.ROLLBACK_BLOCKED_BY_POST_MIGRATION_CHANGE = wave.filter(x => cart.get(x.portfolioId)).length - v.ROLLBACK_ELIGIBLE;
  const ok = v.CARTEIRAS_AFTER === EXPECTED_N && v.HISTORICO_AFTER === EXPECTED_N && v.NON_GC_ANCHOR_DOCUMENTS === 0 && v.OWNER_MATCH === EXPECTED_N && v.ORIGIN_MATCH === EXPECTED_N
    && v.VERSION_VALID === EXPECTED_N && v.HISTORY_MATCH === EXPECTED_N && v.WHITELIST_OK === EXPECTED_N && !v.DOCS_FORA_DA_ONDA && !v.EVENTOS_FORA_DA_ONDA && v.DUPLICATE_HISTORY === 0
    && idem.jaExistentesMesmoOwner === EXPECTED_N && idem.wouldCreate === 0 && !idem.conflitos.length && !idem.identidade.length;
  console.log(JSON.stringify({ ok, modo: MODE, assinatura, lote: LOTE, ...v }, null, 1));
  process.exit(ok ? 0 : 5);
})().catch(e => falhar('erro inesperado: ' + e.message));
