'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — execução em produção: trava (lock com lease), registro de execução e erro sanitizado.
//
// Trava: compras_n0/lock (transação). Só um sync (completo ou incremental) por vez. Uma trava abandonada (processo
// morto) expira pelo lease e a próxima execução a assume. A liberação só apaga a trava se ela ainda for da execução.
// Registro: compras_n0_runs/{run_id} — SÓ metadados seguros (tipo, gatilho, horários, status, quantidades, GETs,
// repetições, tamanhos, policy_version, erro sanitizado). Nunca cliente, telefone, documento, nome ou segredo.
const crypto = require('crypto');
const S = require('./snapshot');
const { POLITICA_VIGENTE } = require('./politica');

// Infraestrutura (não é regra de negócio): lease acima do tempo máximo esperado de cada tipo de execução.
const LEASE_MS = Object.freeze({ FULL: 40 * 60 * 1000, INCREMENTAL: 20 * 60 * 1000 });
const TIPOS = Object.freeze(['FULL', 'INCREMENTAL']);
const GATILHOS = Object.freeze(['MANUAL', 'SCHEDULED']);

/** Remove qualquer coisa que pareça segredo, e-mail ou documento; limita o tamanho. */
function sanitizarErro(e) {
  let m = String((e && (e.codigo || e.message)) || e || 'ERRO');
  m = m.replace(/[A-Za-z0-9_\-]{24,}/g, '[REDACTED]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .replace(/\d{11,14}/g, '[NUM]');
  return m.slice(0, 300);
}

function novoRunId(tipo, agora) {
  return agora.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z-' + tipo.toLowerCase() + '-' + crypto.randomBytes(3).toString('hex');
}

const refLock = db => db.collection('compras_n0').doc('lock');

/** Tenta adquirir a trava. { ok } ou { ok:false, detida_por:{tipo, desde} }. */
async function adquirirLock(db, { runId, tipo, agora }) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(refLock(db));
    const atual = snap.exists ? snap.data() : null;
    if (atual && Date.parse(atual.expires_at) > agora.getTime()) return { ok: false, detida_por: { tipo: atual.tipo, desde: atual.acquired_at } };
    tx.set(refLock(db), { run_id: runId, tipo, acquired_at: agora.toISOString(), expires_at: new Date(agora.getTime() + LEASE_MS[tipo]).toISOString(), assumiu_trava_expirada: !!atual });
    return { ok: true, assumiu_trava_expirada: !!atual };
  });
}

/** Libera a trava SÓ se ainda pertencer a esta execução. */
async function liberarLock(db, runId) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(refLock(db));
    if (snap.exists && snap.data().run_id === runId) { tx.delete(refLock(db)); return true; }
    return false;
  });
}

/** Quantidades seguras (contagens) a partir do snapshot produzido. */
function quantidades(snap) {
  const e = snap.meta.estatisticas || {}, p = snap.resumo.resumo_politica || {};
  return {
    produtos: snap.resumo.produtos,
    vendas: e.vendas ? e.vendas.unique : null, vendas_consulta_ampla: e.vendas ? e.vendas.total_consulta_ampla : null,
    compras: e.compras ? e.compras.unique : null, compras_consulta_ampla: e.compras ? e.compras.total_consulta_ampla : null,
    duplicatas: { vendas: e.vendas ? e.vendas.duplicates : null, compras: e.compras ? e.compras.duplicates : null },
    mescla: e.mescla || null,
    elegiveis: p.TOTAL_ELIGIBLE_PRODUCTS, sugeridos: p.TOTAL_SUGGESTED_PRODUCTS, unidades: p.TOTAL_SUGGESTED_UNITS,
    prioridade: { P1: p.P1_PRODUCTS, P2: p.P2_PRODUCTS, P3: p.P3_PRODUCTS, P4: p.P4_PRODUCTS },
  };
}

/**
 * Executa UM sync (FULL = reconciliação | INCREMENTAL = atualização) com trava e registro.
 * Nunca lança: devolve { status: 'OK' | 'FAILED' | 'SKIPPED_LOCKED', run_id, ... }.
 */
async function executarExecucao({ db, cli, tipo, gatilho, agora = new Date(), politica = POLITICA_VIGENTE, relogio = () => new Date(), fetchMod }) {
  if (!TIPOS.includes(tipo)) throw new Error('TIPO_INVALIDO');
  if (!GATILHOS.includes(gatilho)) throw new Error('GATILHO_INVALIDO');
  const runId = novoRunId(tipo, agora);
  const refRun = db.collection('compras_n0_runs').doc(runId);
  const base = { run_id: runId, tipo, gatilho, inicio: agora.toISOString(), policy_version: politica.policy_version };
  const trava = await adquirirLock(db, { runId, tipo, agora });
  if (!trava.ok) {
    const reg = { ...base, fim: relogio().toISOString(), status: 'SKIPPED_LOCKED', detida_por: trava.detida_por };
    await refRun.set(reg);
    return reg;
  }
  await refRun.set({ ...base, status: 'RUNNING', assumiu_trava_expirada: trava.assumiu_trava_expirada });
  let reg;
  try {
    const exec = tipo === 'FULL' ? S.executarSync : S.executarSyncIncremental;
    const r = await exec({ cli, db, agora, politica, runId, ...(fetchMod ? { fetchMod } : {}) });
    const fim = relogio();
    reg = { ...base, fim: fim.toISOString(), duracao_ms: fim.getTime() - agora.getTime(), status: r.ok ? 'OK' : 'FAILED',
      chamadas_gc: cli.chamadas(), repeticoes: typeof cli.repeticoes === 'function' ? cli.repeticoes() : null,
      quantidades: r.ok ? quantidades(r.snapshot) : null,
      tamanho: r.ok ? (r.snapshot.persistencia || null) : null,
      avisos: r.ok && r.snapshot.persistencia ? r.snapshot.persistencia.avisos : [],
      erro: r.ok ? null : sanitizarErro(r.erro) };
  } catch (e) {
    const fim = relogio();
    reg = { ...base, fim: fim.toISOString(), duracao_ms: fim.getTime() - agora.getTime(), status: 'FAILED', chamadas_gc: cli.chamadas(), erro: sanitizarErro(e) };
  } finally {
    await liberarLock(db, runId);
  }
  await refRun.set(reg);
  return reg;
}

module.exports = { LEASE_MS, TIPOS, GATILHOS, sanitizarErro, novoRunId, adquirirLock, liberarLock, quantidades, executarExecucao };
