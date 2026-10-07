#!/usr/bin/env node
'use strict';
// B2 — carteira-v2: backup, dry-run, backfill ADITIVO das carteiras existentes, verificação e rollback.
//   ZERO mudança de owner: o patch só contém schemaVersion, versao e CAMPOS_ADITIVOS; o script recusa qualquer outro campo.
//   Credencial: firebase-admin com Application Default Credentials. GestãoClick: somente GET; credenciais do Secret Manager
//   lidas em memória (nunca impressas/gravadas). Saída: JSON sem PII (ids técnicos e contagens).
//
//   node functions/scripts/b2_carteira_v2.js --mode=backup  --out=<dir>
//   node functions/scripts/b2_carteira_v2.js --mode=dry-run --backup-dir=<dir> --plan-out=<arquivo>
//   node functions/scripts/b2_carteira_v2.js --mode=execute --backup-dir=<dir> --expected-signature=<sig> --confirm=<N>
//   node functions/scripts/b2_carteira_v2.js --mode=verify  --backup-dir=<dir>
//   node functions/scripts/b2_carteira_v2.js --mode=rollback --backup-dir=<dir> --confirm=<N>
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const admin = require('firebase-admin');
const C2 = require('../lib/carteiraV2');
const ID = require('../lib/identidadeConflitos');
const { Timestamp, FieldValue } = admin.firestore;

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const MODE = args.mode, LOTE = args.lote || 'B2_V2_BACKFILL_20261007';
const COLL = 'carteira_comercial', COLL_HIST = 'carteira_comercial_historico';
const sha = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const falhar = (msg, extra) => { console.log(JSON.stringify({ ok: false, erro: msg, ...(extra || {}) }, null, 1)); process.exit(2); };
if (!args.emulator) admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); else admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();

// serialização exata (Timestamp ↔ marcador) para backup/restauração
const ser = v => { if (v instanceof Timestamp) return { __ts: [v.seconds, v.nanoseconds] }; if (Array.isArray(v)) return v.map(ser); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)])); return v; };
const des = v => { if (v && v.__ts) return new Timestamp(v.__ts[0], v.__ts[1]); if (Array.isArray(v)) return v.map(des); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, des(x)])); return v; };

async function lerColecao(nome) {
  const snap = await db.collection(nome).get(); const out = {};
  snap.docs.forEach(d => { out[d.id] = { data: d.data(), updateTime: d.updateTime }; });
  return out;
}
const dadosDe = m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.data]));
const hashColecao = m => sha(Object.keys(m).sort().map(k => k + '=' + JSON.stringify(ser(m[k].data !== undefined && m[k].updateTime !== undefined ? m[k].data : m[k]))).join('\n'));

// ── BACKUP ───────────────────────────────────────────────────────────────────────
async function backup() {
  const dir = args.out || falhar('--out obrigatório'); fs.mkdirSync(dir, { recursive: true });
  const a1 = await lerColecao(COLL), h1 = await lerColecao(COLL_HIST);
  const a2 = await lerColecao(COLL);                                              // segunda leitura: estado estável durante o backup
  if (hashColecao(a1) !== hashColecao(a2)) falhar('carteira_comercial mudou durante o backup — repetir');
  const arq = { [`${COLL}.json`]: Object.fromEntries(Object.entries(a1).map(([k, v]) => [k, { data: ser(v.data), updateTime: [v.updateTime.seconds, v.updateTime.nanoseconds] }])),
                [`${COLL_HIST}.json`]: Object.fromEntries(Object.entries(h1).map(([k, v]) => [k, { data: ser(v.data), updateTime: [v.updateTime.seconds, v.updateTime.nanoseconds] }])) };
  const manifesto = { projeto: 'mr4-ponto', criadoEm: new Date().toISOString(), commit: (() => { try { return cp.execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (_) { return null; } })(),
    colecoes: {}, restauracao: 'node functions/scripts/b2_carteira_v2.js --mode=rollback --backup-dir=<este diretório> (restaura SOMENTE os campos alterados pela B2; nunca escreve ownerUid/ownerDesde). Restauração integral de documento: via este JSON (ver campo data).',
    impressaoOwnership: C2.impressaoOwnership(dadosDe(a1)), contagemPorOwner: C2.contagemPorOwner(dadosDe(a1)) };
  for (const [nome, conteudo] of Object.entries(arq)) {
    const txt = JSON.stringify(conteudo); fs.writeFileSync(path.join(dir, nome), txt, { mode: 0o600 });
    const rel = JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8'));                 // revalida lendo de volta
    manifesto.colecoes[nome] = { documentos: Object.keys(rel).length, sha256: sha(fs.readFileSync(path.join(dir, nome), 'utf8')) };
  }
  if (manifesto.colecoes[`${COLL}.json`].documentos !== Object.keys(a1).length || manifesto.colecoes[`${COLL_HIST}.json`].documentos !== Object.keys(h1).length) falhar('backup inconsistente');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifesto, null, 1), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, modo: 'backup', dir, ...manifesto }, null, 1));
}
function carregarBackup(dir) {
  if (!dir) falhar('--backup-dir obrigatório');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const out = { man };
  for (const nome of [`${COLL}.json`, `${COLL_HIST}.json`]) {
    const txt = fs.readFileSync(path.join(dir, nome), 'utf8');
    if (sha(txt) !== man.colecoes[nome].sha256) falhar('backup corrompido (hash): ' + nome);
    const j = JSON.parse(txt); if (Object.keys(j).length !== man.colecoes[nome].documentos) falhar('backup corrompido (contagem): ' + nome);
    out[nome] = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, { data: des(v.data), updateTime: new Timestamp(v.updateTime[0], v.updateTime[1]) }]));
  }
  out.carteira = out[`${COLL}.json`]; out.historico = out[`${COLL_HIST}.json`]; return out;
}

// ── GestãoClick (somente GET) ───────────────────────────────────────────────────
async function gcClientes() {
  if (process.env.B2_GC_FIXTURE) return JSON.parse(fs.readFileSync(process.env.B2_GC_FIXTURE, 'utf8'));   // ensaio em emulador (clientes já derivados/hashed)
  const seg = n => cp.execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${n}`, '--project=mr4-ponto'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const headers = { 'access-token': seg('GC_ACCESS_TOKEN'), 'secret-access-token': seg('GC_SECRET_ACCESS_TOKEN'), 'Content-Type': 'application/json' };
  const out = []; let total = null;
  for (let pg = 1; pg <= 40; pg++) {
    const r = await fetch(`https://api.gestaoclick.com/clientes?limite=100&pagina=${pg}`, { method: 'GET', headers });
    if (!r.ok) falhar('GC HTTP ' + r.status + ' na página ' + pg);
    const j = await r.json(); total = total ?? (j.meta && j.meta.total_registros);
    const lote = j.data || []; if (!lote.length) break; for (const c of lote) out.push(ID.derivarCliente(c));
    await new Promise(r2 => setTimeout(r2, 700));
  }
  if (total !== null && out.length !== total) falhar('GC: total lido difere do meta', { lidos: out.length, meta: total });
  return out;
}

// ── PLANO (dry-run) ─────────────────────────────────────────────────────────────
async function planejar(bk) {
  const cart = await lerColecao(COLL), hist = await lerColecao(COLL_HIST);
  if (bk) {                                                                        // estado atual precisa ser IDÊNTICO ao backup (nada mudou desde então)
    if (C2.impressaoOwnership(dadosDe(cart)) !== bk.man.impressaoOwnership) falhar('ownership atual difere do backup');
    if (Object.keys(cart).length !== Object.keys(bk.carteira).length || Object.keys(hist).length !== Object.keys(bk.historico).length) falhar('contagens atuais diferem do backup');
    for (const k of Object.keys(cart)) if (cart[k].updateTime.valueOf() !== bk.carteira[k].updateTime.valueOf()) falhar('carteira alterada após o backup', { id: k });
  }
  const cliSnap = await db.collection('clientes').select('gestaoClickId').get(); const link = new Map();
  cliSnap.docs.forEach(d => { const g = d.data().gestaoClickId; if (g !== undefined && g !== null && g !== '') { const k = String(g); link.set(k, (link.get(k) || []).concat(d.id)); } });
  const gc = await gcClientes();
  const mapaCart = new Map(Object.entries(cart).map(([k, v]) => [k, { ownerUid: v.data.ownerUid }]));
  const conf = ID.detectarConflitos(gc, mapaCart, null);
  const evIni = {}; for (const [id, h] of Object.entries(hist)) if (h.data.tipoEvento === 'CARTEIRA_CRIADA') (evIni[h.data.portfolioId] = evIni[h.data.portfolioId] || []).push(id);
  const itens = [], erros = []; let ownerChanges = 0;
  for (const [id, c] of Object.entries(cart).sort()) {
    try {
      if ((evIni[id] || []).length !== 1) throw new Error('evento inicial ausente/múltiplo');
      const gcId = id.slice(3), docs = link.get(gcId) || [];
      const r = C2.montarPatchBackfillV2(c.data, { eventoInicialId: evIni[id][0], clienteMr4Id: docs.length === 1 ? docs[0] : null, conflito: conf.porCarteira.get(id) || null, loteId: LOTE, agoraIso: '__EXECUCAO__' });
      if (C2.linhaOwnership(c.data) !== C2.linhaOwnership(r.depois)) ownerChanges++;
      itens.push({ id, patch: r.patch, vinculoCrmAmbiguo: docs.length > 1 });
    } catch (e) { erros.push({ id, erro: e.message }); }
  }
  if (erros.length) falhar('erros no plano', { erros: erros.slice(0, 10), total: erros.length });
  // métricas de universo (recalculadas agora)
  const vendas = await db.collection('vendas_gc').select('cliente_id', 'data', 'nome_situacao').get(); const ultima = {};
  vendas.docs.forEach(d => { const v = d.data(); if (v.nome_situacao === 'Concretizada' && v.cliente_id) { const c = String(v.cliente_id); if (!ultima[c] || (v.data || '') > ultima[c]) ultima[c] = v.data || ''; } });
  const hoje = new Date(); const idade = c => Math.round((Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()) - Date.parse(ultima[c] + 'T00:00:00Z')) / 86400000);
  const ids = new Set(gc.map(c => c.id)), compradores = [...ids].filter(i => ultima[i]), nunca = [...ids].filter(i => !ultima[i]);
  const semCart = compradores.filter(i => !cart['GC:' + i]);
  const cfg = await db.doc('carteira_comercial_config/regra').get(); const dec = await db.collection('carteira_comercial_decisoes_sombra').count().get();
  const nomes = {}; for (const d of (await db.collection('sistema_usuarios').get()).docs) nomes[d.id] = (d.data().nome || '').split(' ')[0].toUpperCase();
  const itensParaAssinatura = itens.map(i => ({ id: i.id, patch: { ...i.patch, v2MigradoEm: undefined } }));
  const plano = {
    geradoEm: new Date().toISOString(), lote: LOTE,
    carteiras: Object.keys(cart).length, historicoEventos: Object.keys(hist).length, porOwner: C2.contagemPorOwner(dadosDe(cart), nomes), impressaoOwnership: C2.impressaoOwnership(dadosDe(cart)),
    OWNER_CHANGES_PLANNED: ownerChanges, NEW_OWNER_ASSIGNMENTS_PLANNED: 0, TRANSFERS_PLANNED: 0, NEW_CARTEIRAS_PLANNED: 0, HISTORY_EVENTS_PLANNED: 0, CARTEIRAS_A_ATUALIZAR: itens.length,
    mutacoes: { ATIVA: itens.filter(i => i.patch.status === 'ATIVA').length, EM_REVISAO: itens.filter(i => i.patch.status === 'EM_REVISAO').length, comClienteMr4Id: itens.filter(i => i.patch.clienteMr4Id).length, vinculoCrmAmbiguo: itens.filter(i => i.vinculoCrmAmbiguo).length },
    universo: { gcClientes: gc.length, compradores: compradores.length, nuncaCompraram: nunca.length, semCarteira: gc.length - Object.keys(cart).filter(k => ids.has(k.slice(3))).length, compradoresSemCarteira: semCart.length, compradoresSemCarteiraGe120: semCart.filter(i => idade(i) >= 120).length },
    conflitos: conf.resumo, shadow: { modo: cfg.exists ? cfg.data().modo : null, decisoes: dec.data().count },
    assinatura: sha(itensParaAssinatura).slice(0, 16),
    itens: itens.map(i => ({ id: i.id, status: i.patch.status, conflitoGrupo: i.patch.conflito && i.patch.conflito.grupoId, clienteMr4Id: !!i.patch.clienteMr4Id })),
  };
  return { plano, itens, conf };
}
const resumoPlano = p => { const { itens, ...r } = p; return r; };

async function dryRun() {
  const bk = args['backup-dir'] ? carregarBackup(args['backup-dir']) : null; const { plano } = await planejar(bk);
  if (args['plan-out']) fs.writeFileSync(args['plan-out'], JSON.stringify(plano, null, 1), { mode: 0o600 });
  console.log(JSON.stringify({ ok: plano.OWNER_CHANGES_PLANNED === 0 && plano.NEW_OWNER_ASSIGNMENTS_PLANNED === 0 && plano.TRANSFERS_PLANNED === 0, modo: 'dry-run', ...resumoPlano(plano) }, null, 1));
}

// ── EXECUTE ──────────────────────────────────────────────────────────────────────
async function executar() {
  const bk = carregarBackup(args['backup-dir']); const { plano, itens } = await planejar(bk);
  if (plano.OWNER_CHANGES_PLANNED !== 0 || plano.NEW_OWNER_ASSIGNMENTS_PLANNED !== 0 || plano.TRANSFERS_PLANNED !== 0 || plano.NEW_CARTEIRAS_PLANNED !== 0 || plano.HISTORY_EVENTS_PLANNED !== 0) falhar('plano não-zero — PARE', resumoPlano(plano));
  if (plano.shadow.modo !== 'SOMBRA') falhar('regra de 120 dias não está em SOMBRA — PARE', { modo: plano.shadow.modo });
  if (!args['expected-signature'] || args['expected-signature'] !== plano.assinatura) falhar('assinatura difere do dry-run', { atual: plano.assinatura });
  if (String(args.confirm) !== String(plano.carteiras)) falhar('--confirm deve ser igual ao número de carteiras (' + plano.carteiras + ')');
  const cart = await lerColecao(COLL); const agoraIso = new Date().toISOString(); let n = 0;
  const lista = itens.map(i => i); for (let i = 0; i < lista.length; i += 100) {
    const batch = db.batch();
    for (const it of lista.slice(i, i + 100)) {
      const patch = { ...it.patch, v2MigradoEm: agoraIso };
      for (const k of Object.keys(patch)) if (!C2.CAMPOS_ALTERADOS_BACKFILL.includes(k)) falhar('campo fora do patch: ' + k);
      if (['ownerUid', 'ownerDesde', 'origemComercialUid', 'origemComercialGestaoClickId', 'criadoEm', 'atualizadoEm', 'portfolioId'].some(k => k in patch)) falhar('patch toca ownership — ABORTAR');
      batch.update(db.collection(COLL).doc(it.id), patch, { lastUpdateTime: cart[it.id].updateTime });   // precondição: doc inalterado desde a leitura
      n++;
    }
    await batch.commit();
  }
  console.log(JSON.stringify({ ok: true, modo: 'execute', atualizadas: n, lote: LOTE }, null, 1));
}

// ── VERIFY ───────────────────────────────────────────────────────────────────────
async function verificar() {
  const bk = carregarBackup(args['backup-dir']); const cart = await lerColecao(COLL), hist = await lerColecao(COLL_HIST);
  const antes = dadosDe(bk.carteira), depois = dadosDe(cart); const nomes = {};
  for (const d of (await db.collection('sistema_usuarios').get()).docs) nomes[d.id] = (d.data().nome || '').split(' ')[0].toUpperCase();
  const r = { CARTEIRAS_BEFORE: Object.keys(antes).length, CARTEIRAS_AFTER: Object.keys(depois).length, OWNERS_BEFORE: C2.contagemPorOwner(antes, nomes), OWNERS_AFTER: C2.contagemPorOwner(depois, nomes),
    OWNERSHIP_HASH_BEFORE: C2.impressaoOwnership(antes), OWNERSHIP_HASH_AFTER: C2.impressaoOwnership(depois) };
  r.NEW_CARTEIRAS = Object.keys(depois).filter(k => !antes[k]).length; r.DELETED_CARTEIRAS = Object.keys(antes).filter(k => !depois[k]).length;
  r.OWNER_CHANGED = Object.keys(antes).filter(k => depois[k] && C2.linhaOwnership(antes[k]) !== C2.linhaOwnership(depois[k])).length;
  r.HISTORY_BEFORE = Object.keys(bk.historico).length; r.HISTORY_AFTER = Object.keys(hist).length;
  r.HISTORY_LOST = Object.keys(bk.historico).filter(k => !hist[k]).length + Object.keys(bk.historico).filter(k => hist[k] && JSON.stringify(ser(hist[k].data)) !== JSON.stringify(ser(bk.historico[k].data))).length;
  r.HISTORY_ADDED = Object.keys(hist).filter(k => !bk.historico[k]).length;
  let invalidos = 0, camposForaPatch = 0, v2 = 0, v1 = 0, emRevisao = 0, ativa = 0;
  for (const [k, d] of Object.entries(depois)) {
    if (d.schemaVersion === C2.SCHEMA_V2) { v2++; if (C2.validarDocCarteiraV2(d)) invalidos++; d.status === 'EM_REVISAO' ? emRevisao++ : ativa++; } else v1++;
    if (antes[k]) for (const f of Object.keys(antes[k])) if (!C2.CAMPOS_ALTERADOS_BACKFILL.includes(f) && JSON.stringify(ser(antes[k][f])) !== JSON.stringify(ser(d[f]))) camposForaPatch++;
  }
  Object.assign(r, { V2: v2, V1_RESTANTES: v1, V2_INVALIDOS: invalidos, CAMPOS_ORIGINAIS_ALTERADOS: camposForaPatch, STATUS_ATIVA: ativa, STATUS_EM_REVISAO: emRevisao });
  r.ok = r.CARTEIRAS_BEFORE === r.CARTEIRAS_AFTER && r.NEW_CARTEIRAS === 0 && r.DELETED_CARTEIRAS === 0 && r.OWNER_CHANGED === 0 && r.HISTORY_LOST === 0 && r.HISTORY_ADDED === 0
    && r.OWNERSHIP_HASH_BEFORE === r.OWNERSHIP_HASH_AFTER && r.V2_INVALIDOS === 0 && r.CAMPOS_ORIGINAIS_ALTERADOS === 0;
  console.log(JSON.stringify({ modo: 'verify', ...r }, null, 1)); if (!r.ok) process.exit(3);
}

// ── ROLLBACK (aditivo: remove só os campos v2; nunca escreve ownership) ──────────────
async function reverter() {
  const bk = carregarBackup(args['backup-dir']); const cart = await lerColecao(COLL); const ids = Object.keys(bk.carteira);
  if (String(args.confirm) !== String(ids.length)) falhar('--confirm deve ser ' + ids.length);
  for (const id of ids) { const d = cart[id] && cart[id].data; if (!d) falhar('carteira ausente', { id }); if (d.schemaVersion === C2.SCHEMA_V2 && d.v2LoteId !== LOTE) falhar('lote diferente — recusado', { id }); }
  let n = 0; for (let i = 0; i < ids.length; i += 100) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + 100)) {
      if (cart[id].data.schemaVersion !== C2.SCHEMA_V2) continue;                              // já está v1
      const orig = bk.carteira[id].data; const upd = { schemaVersion: orig.schemaVersion, versao: orig.versao };
      for (const f of C2.CAMPOS_ADITIVOS) upd[f] = FieldValue.delete();
      batch.update(db.collection(COLL).doc(id), upd, { lastUpdateTime: cart[id].updateTime }); n++;
    }
    await batch.commit();
  }
  console.log(JSON.stringify({ ok: true, modo: 'rollback', revertidas: n }, null, 1));
}
({ backup, 'dry-run': dryRun, execute: executar, verify: verificar, rollback: reverter }[MODE] || (() => falhar('modo inválido')))().then(() => process.exit(0), e => falhar(e.message));
