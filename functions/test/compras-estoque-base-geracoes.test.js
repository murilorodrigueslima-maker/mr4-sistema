'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase E.1: base do incremental por GERAÇÕES (write-then-switch + limpeza por allowlist).
// Fixtures 100% sintéticas. O Firestore falso NÃO permite listar compras_n0_base: o leitor e a limpeza não podem depender disso.
const S = require('../lib/compras/snapshot');
const E = require('../lib/compras/execucao');
const F = require('../lib/compras/fetch');
const X = require('./fixtures/compras-estoque-f0');

function dbFalso({ falharCommit = null, falharDelete = false } = {}) {
  const st = {}; let commits = 0; const log = { listagensBase: 0, deletes: [] };
  const ler = (c, id) => (st[c] && st[c][id] ? JSON.parse(st[c][id]) : undefined);
  const ref = (c, id) => ({ id, _c: c, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => ler(c, id) }), set: async v => { (st[c] = st[c] || {})[id] = JSON.stringify(v); }, delete: async () => { log.deletes.push(c + '/' + id); if (st[c]) delete st[c][id]; } });
  return {
    st, log, ler, commits: () => commits,
    collection: c => ({ doc: id => ref(c, id), get: async () => { if (c === 'compras_n0_base') { log.listagensBase++; throw new Error('LISTAGEM_DA_BASE_PROIBIDA'); } return { docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }; } }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), delete: r => ops.push(() => { if (falharDelete) throw new Error('FALHA_DELETE'); return r.delete(); }), commit: async () => { commits++; if (falharCommit && falharCommit(commits, ops)) throw new Error('FALHA_NO_COMMIT_' + commits); for (const o of ops) await o(); } }; },
    runTransaction: async fn => { const w = []; const r = await fn({ get: x => x.get(), set: (x, v) => w.push(() => x.set(v)), delete: x => w.push(() => x.delete()) }); commits++; if (falharCommit && falharCommit(commits, w)) throw new Error('FALHA_NO_COMMIT_' + commits); for (const o of w) await o(); return r; },
  };
}
const venda = (pref, i, q = 1) => S.compactarVenda({ ...X.venda('2026-09-10', [['A', q, 25]], { id: pref + i }), modificado_em: '2026-09-10 10:00:00' });
// capacidade de UMA fatia (vendas sintéticas do mesmo tamanho) → n vendas que geram exatamente k fatias
const CAP = S.fatiarPorBytes(Array.from({ length: 20000 }, (_, i) => S.codificarVenda(venda('VQ-', 100000 + i))))[0].length;
const vendasPara = (k, pref) => Array.from({ length: (k - 1) * CAP + Math.floor(CAP / 2) }, (_, i) => venda(pref, 100000 + i));
let relogio = Date.parse('2026-09-28T09:00:00Z');
function snap(vendas) {
  const sn = S.montarSnapshot({ brutosProdutos: [X.produto('A', { estoque: 5 })], brutosVendas: [], brutosCompras: [], agora: new Date(relogio += 3600e3) });
  sn.base = { vendas, compras: [] }; return sn;
}
const baseIds = db => Object.keys(db.st.compras_n0_base || {}).sort();
const meta = db => db.ler('compras_n0', 'meta');
async function gravarBase(db, k, pref, opts) { const v = vendasPara(k, pref); const sn = snap(v); await S.persistirSnapshot(db, sn, opts); return { v, sn }; }

describe('persistência por geração — encolher, manter, crescer', () => {
  test('SHRINK 5 → 4: 4 fatias da geração nova; nenhuma fatia antiga; leitor devolve exatamente a base nova', async () => {
    const db = dbFalso();
    const a = await gravarBase(db, 5, 'VA-');
    expect(meta(db).base_ativa.vendas).toBe(5); expect(baseIds(db)).toHaveLength(5);
    const b = await gravarBase(db, 4, 'VB-');
    const m = meta(db);
    expect(m.base_ativa).toMatchObject({ geracao: b.sn.persistencia.geracao, vendas: 4, compras: 0, formato: 'tuplas-json-v1' });
    expect(m.base_docs).toEqual({ vendas: 4, compras: 0 }); expect(m.base_orfas).toBeNull();
    expect(baseIds(db)).toEqual(S.idsDaBase(m.base_ativa).sort());
    expect(baseIds(db).every(id => id.startsWith(m.base_ativa.geracao + '_'))).toBe(true);
    const lida = await S.carregarBase(db);
    expect(lida.vendas).toEqual(b.v); expect(lida.vendas.some(v => v.id.startsWith('VA-'))).toBe(false);
    expect(b.sn.persistencia.limpeza_base).toEqual({ removidos: 5, pendentes: 0 });
    expect(a.sn.persistencia.geracao).not.toBe(b.sn.persistencia.geracao);
  }, 60000);
  test('SAME 5 → 5: remove só a geração anterior; as 5 novas intactas', async () => {
    const db = dbFalso(); await gravarBase(db, 5, 'VA-'); const b = await gravarBase(db, 5, 'VB-');
    expect(baseIds(db)).toEqual(S.idsDaBase(meta(db).base_ativa).sort()); expect(baseIds(db)).toHaveLength(5);
    expect(db.log.deletes.filter(d => d.includes(meta(db).base_ativa.geracao))).toEqual([]);
    expect((await S.carregarBase(db)).vendas).toEqual(b.v);
  }, 60000);
  test('GROW 5 → 6: as 6 válidas', async () => {
    const db = dbFalso(); await gravarBase(db, 5, 'VA-'); const b = await gravarBase(db, 6, 'VB-');
    expect(meta(db).base_ativa.vendas).toBe(6); expect(baseIds(db)).toHaveLength(6);
    expect((await S.carregarBase(db)).vendas).toEqual(b.v);
  }, 60000);
  test('SHRINK 5 → 1: só a base nova', async () => {
    const db = dbFalso(); await gravarBase(db, 5, 'VA-'); const b = await gravarBase(db, 1, 'VB-');
    expect(baseIds(db)).toEqual(S.idsDaBase(meta(db).base_ativa)); expect(baseIds(db)).toHaveLength(1);
    expect((await S.carregarBase(db)).vendas).toEqual(b.v);
  }, 60000);
});

describe('falha parcial e repetição', () => {
  const LOTE = 1300 * 1024;   // força o caminho multi-lote com poucas fatias (2 fatias por lote)
  test('PARTIAL WRITE FAILURE: nova base (4) falha no 2º lote → base anterior (5) segue ativa, íntegra e legível; nada antigo apagado', async () => {
    const db = dbFalso();
    const a = await gravarBase(db, 5, 'VA-');
    const ativaAntes = meta(db).base_ativa, idsAntes = baseIds(db);
    let n = 0; const dbF = Object.assign(Object.create(Object.getPrototypeOf(db)), db);
    const batchOrig = db.batch;
    dbF.batch = () => { const l = batchOrig(); return { ...l, commit: async () => { if (++n === 2) throw new Error('FALHA_NO_LOTE_2'); return l.commit(); } }; };
    const sn = snap(vendasPara(4, 'VB-'));
    await expect(S.persistirSnapshot(dbF, sn, { loteBytesMax: LOTE })).rejects.toThrow(/FALHA_NO_LOTE_2/);
    const m = meta(db);
    expect(m.base_ativa).toEqual(ativaAntes);                            // ponteiro NÃO trocou
    expect(m.base_pendente).toMatchObject({ vendas: 4 });                 // geração nova marcada como pendente
    expect(idsAntes.every(id => db.st.compras_n0_base[id])).toBe(true);   // nenhuma fatia antiga apagada/sobrescrita
    expect(db.log.deletes).toEqual([]);
    expect((await S.carregarBase(db)).vendas).toEqual(a.v);              // base anterior íntegra
  }, 60000);
  test('RETRY após a falha: resultado final = exatamente a base nova; pendente e antiga removidas', async () => {
    const db = dbFalso();
    await gravarBase(db, 5, 'VA-');
    let n = 0; const batchOrig = db.batch;
    db.batch = () => { const l = batchOrig(); return { ...l, commit: async () => { if (++n === 2) throw new Error('FALHA_NO_LOTE_2'); return l.commit(); } }; };
    await expect(S.persistirSnapshot(db, snap(vendasPara(4, 'VB-')), { loteBytesMax: LOTE })).rejects.toThrow();
    const pendente = meta(db).base_pendente;
    db.batch = batchOrig;
    const v = vendasPara(4, 'VC-'); const sn = snap(v);
    await S.persistirSnapshot(db, sn, { loteBytesMax: LOTE });
    const m = meta(db);
    expect(m.base_ativa).toMatchObject({ geracao: sn.persistencia.geracao, vendas: 4 }); expect(m.base_pendente).toBeUndefined(); expect(m.base_orfas).toBeNull();
    expect(baseIds(db)).toEqual(S.idsDaBase(m.base_ativa).sort());
    expect(baseIds(db).some(id => id.startsWith(pendente.geracao))).toBe(false);
    expect((await S.carregarBase(db)).vendas).toEqual(v);
  }, 60000);
  test('repetição com o MESMO instante após falha: geração nova distinta; nenhuma fatia sobrescrita no lugar; pendente sai', async () => {
    const db = dbFalso(); await gravarBase(db, 5, 'VA-');
    let n = 0; const batchOrig = db.batch;
    db.batch = () => { const l = batchOrig(); return { ...l, commit: async () => { if (++n === 3) throw new Error('FALHA_NO_LOTE_3'); return l.commit(); } }; };
    const t = relogio += 3600e3;
    const s1 = S.montarSnapshot({ brutosProdutos: [X.produto('A', { estoque: 5 })], brutosVendas: [], brutosCompras: [], agora: new Date(t) }); s1.base = { vendas: vendasPara(6, 'VB-'), compras: [] };
    await expect(S.persistirSnapshot(db, s1, { loteBytesMax: LOTE })).rejects.toThrow();   // gravou 4 das 6 fatias pendentes
    db.batch = batchOrig;
    const s2 = S.montarSnapshot({ brutosProdutos: [X.produto('A', { estoque: 5 })], brutosVendas: [], brutosCompras: [], agora: new Date(t) }); const v = vendasPara(2, 'VC-'); s2.base = { vendas: v, compras: [] };
    await S.persistirSnapshot(db, s2, { loteBytesMax: LOTE });
    expect(baseIds(db)).toEqual(S.idsDaBase(meta(db).base_ativa).sort()); expect(baseIds(db)).toHaveLength(2);
    expect((await S.carregarBase(db)).vendas).toEqual(v);
  }, 60000);
  test('falha entre a troca e a limpeza: leitor já usa só a geração nova; órfãs ficam em meta.base_orfas e a próxima gravação conclui', async () => {
    const db = dbFalso(); await gravarBase(db, 5, 'VA-');
    const antiga = meta(db).base_ativa;
    const dbF = dbFalso({ falharDelete: true }); Object.assign(dbF.st, db.st);
    const b = await gravarBase(dbF, 4, 'VB-');
    expect(b.sn.persistencia.limpeza_base).toMatchObject({ removidos: 0, pendentes: 5 });
    expect(meta(dbF).base_orfas).toEqual([antiga]);
    expect((await S.carregarBase(dbF)).vendas).toEqual(b.v);                         // órfãs NÃO são carregadas
    const dbOk = dbFalso(); Object.assign(dbOk.st, dbF.st);
    const c = await gravarBase(dbOk, 3, 'VC-');
    expect(baseIds(dbOk)).toEqual(S.idsDaBase(meta(dbOk).base_ativa).sort()); expect(meta(dbOk).base_orfas).toBeNull();
    expect(c.sn.persistencia.limpeza_base.removidos).toBe(9);                          // 5 (órfãs) + 4 (ativa anterior)
  }, 60000);
});

describe('leitor (carregarBase) — falha fechada e sem listagem', () => {
  test('LOADER_STALE_CHUNK: fatia antiga/estranha presente não é concatenada; leitor não lista a coleção', async () => {
    const db = dbFalso(); const b = await gravarBase(db, 2, 'VB-');
    const g = meta(db).base_ativa.geracao;
    const lixo = { geracao: 'g1x000000', gerado_em: 'x', formato: 'tuplas-json-v1', indice: 2, n: 1, registros_json: JSON.stringify([S.codificarVenda(venda('VZ-', 1))]) };
    db.st.compras_n0_base[g + '_v_002'] = JSON.stringify({ ...lixo, geracao: g });   // fatia além da contagem, mesma geração
    db.st.compras_n0_base.v_000 = JSON.stringify(lixo); db.st.compras_n0_base['g1x000000_v_000'] = JSON.stringify(lixo);
    const lida = await S.carregarBase(db);
    expect(lida.vendas).toEqual(b.v); expect(lida.vendas.some(v => v.id.startsWith('VZ-'))).toBe(false);
    expect(db.log.listagensBase).toBe(0);
  }, 60000);
  test('LOADER_MISSING_CHUNK: fatia obrigatória ausente → BASE_INCOMPLETA; incremental falha fechado e preserva o snapshot', async () => {
    const db = dbFalso(); await gravarBase(db, 3, 'VB-');
    const m = meta(db); delete db.st.compras_n0_base[S.idFatia(m.base_ativa, 'v', 1)];
    await expect(S.carregarBase(db)).rejects.toThrow(/BASE_INCOMPLETA/);
    const antes = JSON.stringify(db.st.compras_n0_view || null) + db.st.compras_n0.resumo;
    const cli = F.criarClienteGC({ fetchImpl: async () => { throw new Error('não deveria chamar o GC'); }, accessToken: 't', secretToken: 's', pausaMs: 0, dormir: async () => {} });
    const r = await S.executarSyncIncremental({ cli, db, agora: new Date(relogio += 3600e3) });
    expect(r.ok).toBe(false); expect(meta(db).erro).toMatch(/BASE_INCOMPLETA/); expect(meta(db).base_ativa).toEqual(m.base_ativa);
    expect(JSON.stringify(db.st.compras_n0_view || null) + db.st.compras_n0.resumo).toBe(antes);
  }, 60000);
  test('fatia de outra geração no id esperado, índice ou quantidade divergentes → BASE_INCOMPLETA', async () => {
    for (const estraga of [d => ({ ...d, geracao: 'g999' }), d => ({ ...d, indice: 7 }), d => ({ ...d, n: d.n + 1 }), d => ({ ...d, registros_json: '{' })]) {
      const db = dbFalso(); await gravarBase(db, 1, 'VB-');
      const id = S.idFatia(meta(db).base_ativa, 'v', 0);
      db.st.compras_n0_base[id] = JSON.stringify(estraga(JSON.parse(db.st.compras_n0_base[id])));
      await expect(S.carregarBase(db)).rejects.toThrow(/BASE_INCOMPLETA/);
    }
  }, 60000);
  test('sem ponteiro (meta ausente) → null (exige FULL), mesmo com fatias soltas na coleção', async () => {
    const db = dbFalso(); db.st.compras_n0_base = { v_000: JSON.stringify({ formato: 'tuplas-json-v1', indice: 0, n: 0, registros_json: '[]' }) };
    expect(await S.carregarBase(db)).toBeNull();
  });
});

describe('escopo da exclusão, trava e legado', () => {
  test('DELETE_SCOPE: só ids exatos das gerações substituídas; documentos estranhos na coleção ficam intactos', async () => {
    const db = dbFalso(); await gravarBase(db, 3, 'VA-');
    const antiga = meta(db).base_ativa;
    Object.assign(db.st.compras_n0_base, { manual_x: '{}', v_099: '{}', g1x000000_v_000: '{}', [antiga.geracao + '_v_050']: '{}' });
    await gravarBase(db, 2, 'VB-');
    expect(db.log.deletes.sort()).toEqual(S.idsDaBase(antiga).map(id => 'compras_n0_base/' + id).sort());
    for (const id of ['manual_x', 'v_099', 'g1x000000_v_000', antiga.geracao + '_v_050']) expect(db.st.compras_n0_base[id]).toBe('{}');
    expect(db.log.listagensBase).toBe(0);
  }, 60000);
  test('guarda: a limpeza recusa id fora do padrão ou da geração ativa', async () => {
    const db = dbFalso();
    await expect(S.limparGeracoesSubstituidas(db, { substituidas: [{ geracao: 'g1x000000', vendas: 1, compras: 0 }], idsNovos: new Set(['g1x000000_v_000']), refNova: { geracao: 'g2x000000' }, quando: 'x' })).resolves.toMatchObject({ removidos: 0 });
    await expect(S.limparGeracoesSubstituidas(db, { substituidas: [{ geracao: 'g1x000000', vendas: 2, compras: 0 }], idsNovos: new Set(), refNova: { geracao: 'g2x000000' }, quando: 'x' })).resolves.toMatchObject({ removidos: 2 });
  });
  test('guarda: id fora do padrão da base nunca é apagado', async () => {
    const db = dbFalso(); db.st.compras_n0_base = { 'resumo': '{}' };
    await expect(S.limparGeracoesSubstituidas(db, { substituidas: [{ geracao: 'x/../compras_n0', vendas: 1, compras: 0 }], idsNovos: new Set(), refNova: { geracao: 'g2x000000' }, quando: 'x' })).rejects.toThrow(/LIMPEZA_FORA_DO_ESCOPO/);
    expect(db.log.deletes).toEqual([]);
  });
  test('duas gravações no MESMO instante: gerações diferentes (sem sobrescrever a ativa no lugar)', async () => {
    const t = new Date(relogio += 3600e3); const mk = p => { const s = S.montarSnapshot({ brutosProdutos: [X.produto('A', { estoque: 5 })], brutosVendas: [], brutosCompras: [], agora: t }); s.base = { vendas: vendasPara(2, p), compras: [] }; return s; };
    const db = dbFalso(); const a = mk('VA-'); await S.persistirSnapshot(db, a); const b = mk('VB-'); await S.persistirSnapshot(db, b);
    expect(a.persistencia.geracao).not.toBe(b.persistencia.geracao); expect((await S.carregarBase(db)).vendas.every(v => v.id.startsWith('VB-'))).toBe(true);
  }, 60000);
  test('CLEANUP_LOCK: execução que perdeu a trava não troca o ponteiro nem apaga nada (LOCK_PERDIDO)', async () => {
    const db = dbFalso(); await gravarBase(db, 3, 'VA-');
    const antes = meta(db).base_ativa; const idsAntes = baseIds(db);
    await db.collection('compras_n0').doc('lock').set({ run_id: 'OUTRA', tipo: 'FULL', acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' });
    await expect(S.persistirSnapshot(db, snap(vendasPara(2, 'VB-')), { runId: 'MINHA' })).rejects.toThrow(/LOCK_PERDIDO/);
    expect(meta(db).base_ativa).toEqual(antes); expect(idsAntes.every(id => db.st.compras_n0_base[id])).toBe(true); expect(db.log.deletes).toEqual([]);
  }, 60000);
  test('CLEANUP_LOCK: trava perdida DEPOIS da troca → limpeza adiada (órfãs registradas), nada apagado', async () => {
    const db = dbFalso(); await gravarBase(db, 3, 'VA-');
    await db.collection('compras_n0').doc('lock').set({ run_id: 'MINHA', tipo: 'FULL', acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' });
    const tx = db.runTransaction;
    db.runTransaction = async fn => { await tx(fn); await db.collection('compras_n0').doc('lock').set({ run_id: 'OUTRA' }); };   // outra execução assume logo após a troca
    const sn = snap(vendasPara(2, 'VB-')); await S.persistirSnapshot(db, sn, { runId: 'MINHA' });
    expect(sn.persistencia.limpeza_base).toMatchObject({ removidos: 0, pendentes: 3, motivo: 'LOCK_PERDIDO' }); expect(db.log.deletes).toEqual([]);
    expect(meta(db).base_orfas).toHaveLength(1);
  }, 60000);
  test('executarExecucao passa o run_id: sync com a trava própria troca e limpa normalmente', async () => {
    const db = dbFalso(); await gravarBase(db, 2, 'VA-');
    const c = X.cenario(); const lista = (u) => { const q = new URL(u).searchParams, p = new URL(u).pathname; return p === '/produtos' ? c.produtos : p === '/vendas' ? c.vendas.filter(v => v.data >= q.get('data_inicio') && v.data <= q.get('data_fim')) : c.compras.filter(x => x.Compra.data_emissao >= q.get('data_inicio') && x.Compra.data_emissao <= q.get('data_fim')); };
    const cli = F.criarClienteGC({ fetchImpl: async (u, o) => { const l = lista(u), q = new URL(u).searchParams, pg = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20)); return { ok: true, json: async () => ({ data: l.slice((pg - 1) * lim, pg * lim), meta: { total_registros: l.length, total_paginas: Math.max(1, Math.ceil(l.length / lim)) } }) }; }, accessToken: 't', secretToken: 's', pausaMs: 0, dormir: async () => {} });
    const reg = await E.executarExecucao({ db, cli, tipo: 'FULL', gatilho: 'MANUAL', agora: new Date(relogio += 3600e3) });
    expect(reg.status).toBe('OK'); expect(reg.tamanho.limpeza_base).toMatchObject({ pendentes: 0 });
    expect(baseIds(db)).toEqual(S.idsDaBase(meta(db).base_ativa).sort());
    expect(db.ler('compras_n0', 'lock')).toBeUndefined();
  }, 60000);
  test('LEGADO (formato em produção antes da E.1): v_NNN/c_NNN + meta.base_docs é lido e depois substituído/limpo pela allowlist', async () => {
    const db = dbFalso();
    const v = vendasPara(2, 'VL-'); const fat = S.fatiarPorBytes(v.map(S.codificarVenda)); const q = '2026-09-28T09:00:00.000Z';
    db.st.compras_n0_base = Object.fromEntries(fat.map((b, i) => ['v_' + String(i).padStart(3, '0'), JSON.stringify({ gerado_em: q, formato: 'tuplas-json-v1', indice: i, n: b.length, registros_json: JSON.stringify(b) })]));
    db.st.compras_n0_base.c_000 = JSON.stringify({ gerado_em: q, formato: 'tuplas-json-v1', indice: 0, n: 0, registros_json: '[]' });
    db.st.compras_n0 = { meta: JSON.stringify({ ultima_sincronizacao_ok: q, base_docs: { vendas: fat.length, compras: 1 } }) };
    expect((await S.carregarBase(db)).vendas).toEqual(v);
    const n = await gravarBase(db, 1, 'VN-');
    expect(baseIds(db)).toEqual(S.idsDaBase(meta(db).base_ativa)); expect(db.log.deletes.sort()).toEqual(['compras_n0_base/c_000', 'compras_n0_base/v_000', 'compras_n0_base/v_001']);
    expect((await S.carregarBase(db)).vendas).toEqual(n.v);
    // legado com carimbo divergente (fatia de outra gravação) → falha fechada
    const db2 = dbFalso(); db2.st.compras_n0_base = { v_000: JSON.stringify({ gerado_em: 'outro', formato: 'tuplas-json-v1', indice: 0, n: 0, registros_json: '[]' }) };
    db2.st.compras_n0 = { meta: JSON.stringify({ ultima_sincronizacao_ok: q, base_docs: { vendas: 1, compras: 0 } }) };
    await expect(S.carregarBase(db2)).rejects.toThrow(/BASE_INCOMPLETA/);
  }, 60000);
  test('NESTED_ARRAY_GUARD preservado: fatias são texto JSON; nenhum documento gravado tem array aninhado', async () => {
    const db = dbFalso(); await gravarBase(db, 2, 'VB-');
    for (const [c, docs] of Object.entries(db.st)) for (const d of Object.values(docs)) expect(S.temArrayAninhado(JSON.parse(d))).toBe(false);
    for (const d of Object.values(db.st.compras_n0_base)) { const x = JSON.parse(d); expect(x.formato).toBe('tuplas-json-v1'); expect(typeof x.registros_json).toBe('string'); }
  }, 60000);
});
