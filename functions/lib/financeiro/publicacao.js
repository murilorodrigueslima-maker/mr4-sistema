'use strict';
// AGENTE FINANCEIRO MR4 — Fase 2 · trava, publicação atômica por GERAÇÃO e limpeza.
//
// Por que não copiar Compras 1:1: Compras tem base grande reutilizada pelo incremental (camadas "base" + "snapshot visível") e fatias do
// motor. Aqui TODA execução é FULL (a API não tem incremental confiável) e o painel lê só uma geração por vez; então o modelo é mais simples:
//   1) trava com lease (fin_n1_ctl/lock; sem acesso do navegador);
//   2) grava a geração NOVA inteira em ids novos (nada visível ainda; o ponteiro continua na geração anterior);
//   3) valida (resumo + todas as fatias existem e batem com o índice do resumo);
//   4) TROCA O PONTEIRO (fin_n1/active) numa transação que confere a trava — ponto único de atomicidade;
//   5) limpeza posterior (mantém ativa + anterior para rollback; apaga as mais antigas e órfãs).
// Falha em qualquer etapa até o passo 4 → ponteiro intacto → painel continua na geração anterior.
const { idResumo, idEntidades } = require('./agregados');

const COL = { ctl: 'fin_n1_ctl', ptr: 'fin_n1', resumo: 'fin_n1_resumo', fatias: 'fin_n1_titulos' };
const LEASE_MS = 25 * 60 * 1000;     // execução típica ≈ 10 min; teto da Function 30 min
const LOTE = 400;

const refLock = db => db.collection(COL.ctl).doc('lock');
const refAtivo = db => db.collection(COL.ptr).doc('active');
const refMeta = db => db.collection(COL.ptr).doc('meta');

async function adquirirLock(db, { runId, tipo = 'FULL', agora = new Date(), leaseMs = LEASE_MS }) {
  return db.runTransaction(async tx => {
    const s = await tx.get(refLock(db));
    if (s.exists) {
      const l = s.data();
      if (new Date(l.expires_at).getTime() > agora.getTime()) return { ok: false, motivo: 'LOCK_ATIVO', dono: l.run_id, expira_em: l.expires_at };
    }
    tx.set(refLock(db), { run_id: runId, tipo, acquired_at: agora.toISOString(), expires_at: new Date(agora.getTime() + leaseMs).toISOString(), recuperado: s.exists ? true : false });
    return { ok: true, recuperado: s.exists };
  });
}
async function renovarLock(db, runId, agora = new Date(), leaseMs = LEASE_MS) {
  return db.runTransaction(async tx => {
    const s = await tx.get(refLock(db));
    if (!s.exists || s.data().run_id !== runId) return false;
    tx.set(refLock(db), { ...s.data(), expires_at: new Date(agora.getTime() + leaseMs).toISOString(), heartbeat_at: agora.toISOString() });
    return true;
  });
}
async function liberarLock(db, runId) {
  return db.runTransaction(async tx => {
    const s = await tx.get(refLock(db));
    if (s.exists && s.data().run_id === runId) { tx.delete(refLock(db)); return true; }
    return false;
  });
}

const colDe = id => (id.endsWith('__resumo') || id.endsWith('__entidades') ? COL.resumo : COL.fatias);
async function apagarIds(db, ids) {
  let n = 0;
  for (const id of ids) { try { await db.collection(colDe(id)).doc(id).delete(); n++; } catch (_) { /* limpeza best-effort; o que sobrar vira órfão e é tentado de novo */ } }
  return n;
}

/**
 * Publica uma geração. Retorna { ok, geracao, ids } ou lança (e nesse caso o ponteiro NÃO mudou).
 */
async function publicarGeracao(db, { geracao, resumo, entidades, fatias, runId, agora = new Date(), estatisticas = {}, aoProgredir = async () => {} }) {
  const idR = idResumo(geracao), idE = idEntidades(geracao);
  const todos = [[COL.resumo, idR, resumo], [COL.resumo, idE, entidades], ...fatias.map(f => [COL.fatias, f.id, f.doc])];
  const ids = todos.map(t => t[1]);
  // pendente: se esta execução morrer no meio, a próxima sabe o que limpar
  const metaAnt = (await refMeta(db).get()).data() || {};
  await refMeta(db).set({ ...metaAnt, pendente: { geracao, ids, run_id: runId, em: agora.toISOString() } });
  try {
    for (let i = 0; i < todos.length; i += LOTE) {
      const lote = db.batch();
      for (const [c, id, doc] of todos.slice(i, i + LOTE)) lote.set(db.collection(c).doc(id), doc);
      await lote.commit();
      await aoProgredir();
    }
    // validação: o que foi gravado confere com o índice do resumo
    const lidos = await Promise.all(todos.map(async ([c, id]) => { const s = await db.collection(c).doc(id).get(); return [id, s.exists ? s.data() : null]; }));
    const faltando = lidos.filter(([, d]) => !d).length;
    if (faltando) throw Object.assign(new Error('VALIDACAO_FALTAM_DOCUMENTOS:' + faltando), { codigo: 'VALIDACAO' });
    for (const nat of ['pagar', 'receber']) for (const [g, ix] of Object.entries(resumo[nat].detalhe)) {
      const f = lidos.filter(([id, d]) => d && d.natureza === nat.toUpperCase() && d.grupo === g);
      if (f.length !== ix.fatias || f.reduce((a, [, d]) => a + d.itens.length, 0) !== ix.titulos) throw Object.assign(new Error(`VALIDACAO_INDICE:${nat}:${g}`), { codigo: 'VALIDACAO' });
    }
    // TROCA DO PONTEIRO — atômica; só com a trava ainda nossa
    let anteriorAtiva = null;
    await db.runTransaction(async tx => {
      const [tl, ta, tm] = [await tx.get(refLock(db)), await tx.get(refAtivo(db)), await tx.get(refMeta(db))];
      if (!tl.exists || tl.data().run_id !== runId) throw Object.assign(new Error('TRAVA_PERDIDA'), { codigo: 'TRAVA_PERDIDA' });
      anteriorAtiva = ta.exists ? ta.data() : null;
      const ativo = { versao: resumo.versao, geracao, publicado_em: agora.toISOString(), data_comercial: resumo.data_comercial, run_id: runId, resumo_id: idR, entidades_id: idE, fatias: fatias.length, ids,
        anterior: anteriorAtiva ? { geracao: anteriorAtiva.geracao, ids: anteriorAtiva.ids, publicado_em: anteriorAtiva.publicado_em } : null };
      tx.set(refAtivo(db), ativo);
      const m = tm.exists ? tm.data() : {};
      const { pendente, ...resto } = m;
      tx.set(refMeta(db), { ...resto, ultima_tentativa: agora.toISOString(), ultima_tentativa_ok: true, ultima_sincronizacao_ok: agora.toISOString(), erro: null, geracao_ativa: geracao, estatisticas, orfas: m.orfas || [] });
    });
    // limpeza posterior: a geração "anterior da anterior" e órfãs (nunca a ativa nem a anterior imediata)
    const apagar = [];
    if (anteriorAtiva && anteriorAtiva.anterior && anteriorAtiva.anterior.ids) apagar.push(...anteriorAtiva.anterior.ids);
    const mAtual = (await refMeta(db).get()).data() || {};
    for (const o of mAtual.orfas || []) apagar.push(...(o.ids || []));
    if (metaAnt.pendente && metaAnt.pendente.geracao !== geracao) apagar.push(...(metaAnt.pendente.ids || []));
    const protegidos = new Set(ids.concat(anteriorAtiva ? anteriorAtiva.ids : []));
    const removidos = await apagarIds(db, [...new Set(apagar)].filter(id => !protegidos.has(id)));
    await refMeta(db).set({ ...mAtual, orfas: [] });
    return { ok: true, geracao, ids, removidos };
  } catch (e) {
    // falha antes da troca: o ponteiro segue na geração anterior; tenta apagar o que gravou (senão fica como órfã)
    const apagados = await apagarIds(db, ids);
    const m = (await refMeta(db).get()).data() || {};
    if (apagados < ids.length) await refMeta(db).set({ ...m, orfas: [...(m.orfas || []), { geracao, ids }] });
    throw e;
  }
}

/** Lê o ponteiro ativo (mesmo caminho do painel). */
async function lerAtivo(db) { const s = await refAtivo(db).get(); return s.exists ? s.data() : null; }

module.exports = { COL, LEASE_MS, adquirirLock, renovarLock, liberarLock, publicarGeracao, lerAtivo, apagarIds };
