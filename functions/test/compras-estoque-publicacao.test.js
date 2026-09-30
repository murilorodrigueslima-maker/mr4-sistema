'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — componentes de PUBLICAÇÃO: trava + registro de execução, pontos de entrada
// (HTTP privado + agendados), visão da tela e verificações estáticas da tela.
const fs = require('fs'), path = require('path');
const E = require('../lib/compras/execucao');
const EP = require('../lib/compras/entrypoints');
const S = require('../lib/compras/snapshot');
const F = require('../lib/compras/fetch');
const X = require('./fixtures/compras-estoque-f0');

// Firestore falso com transação (mesma semântica usada pela trava)
function dbFalso() {
  const st = {};
  const ref = (c, id) => ({ id, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => (st[c] && st[c][id] ? JSON.parse(st[c][id]) : undefined) }), set: async v => { (st[c] = st[c] || {})[id] = JSON.stringify(v); }, delete: async () => { if (st[c]) delete st[c][id]; } });
  return { st, collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }) }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), commit: async () => { for (const o of ops) await o(); } }; },
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, v) => r.set(v), delete: r => r.delete() }) };
}
const le = (db, c, id) => (db.st[c] && db.st[c][id] ? JSON.parse(db.st[c][id]) : undefined);
function gcFalso({ falhas = [] } = {}) {
  const c = X.cenario(); const chamadas = []; let i = 0;
  const fetchImpl = async (url, opts) => {
    chamadas.push({ url, method: opts.method });
    const f = falhas[i++]; if (typeof f === 'number') return { ok: false, status: f, json: async () => ({}) };
    const u = new URL(url), q = u.searchParams, pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    let lista;
    if (u.pathname === '/produtos') lista = c.produtos;
    else if (u.pathname === '/vendas') lista = c.vendas.filter(v => v.data >= q.get('data_inicio') && v.data <= q.get('data_fim'));
    else if (u.pathname === '/compras') lista = c.compras.filter(x => x.Compra.data_emissao >= q.get('data_inicio') && x.Compra.data_emissao <= q.get('data_fim'));
    return { ok: true, json: async () => ({ data: lista.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: lista.length, total_paginas: Math.max(1, Math.ceil(lista.length / lim)) } }) };
  };
  return { cli: F.criarClienteGC({ fetchImpl, accessToken: 'tok-FAKE', secretToken: 'sec-FAKE', pausaMs: 0, dormir: async () => {} }), chamadas };
}
const AG = new Date('2026-09-28T09:00:00Z');

describe('EXECUÇÃO — trava com lease e registro seguro', () => {
  test('adquire, bloqueia a segunda, libera só a própria; trava expirada é assumida', async () => {
    const db = dbFalso();
    expect(await E.adquirirLock(db, { runId: 'r1', tipo: 'FULL', agora: AG })).toMatchObject({ ok: true });
    expect(await E.adquirirLock(db, { runId: 'r2', tipo: 'INCREMENTAL', agora: new Date(AG.getTime() + 60e3) })).toMatchObject({ ok: false, detida_por: { tipo: 'FULL' } });
    expect(await E.liberarLock(db, 'r2')).toBe(false); expect(le(db, 'compras_n0', 'lock').run_id).toBe('r1');
    expect(await E.adquirirLock(db, { runId: 'r3', tipo: 'INCREMENTAL', agora: new Date(AG.getTime() + E.LEASE_MS.FULL + 1) })).toMatchObject({ ok: true, assumiu_trava_expirada: true });
    expect(await E.liberarLock(db, 'r3')).toBe(true); expect(le(db, 'compras_n0', 'lock')).toBeUndefined();
  });
  test('execução OK: registro com metadados seguros, trava liberada, snapshot gravado com a política vigente', async () => {
    const db = dbFalso(); const { cli, chamadas } = gcFalso();
    const reg = await E.executarExecucao({ db, cli, tipo: 'FULL', gatilho: 'MANUAL', agora: AG, relogio: () => new Date(AG.getTime() + 5000) });
    expect(reg).toMatchObject({ status: 'OK', tipo: 'FULL', gatilho: 'MANUAL', policy_version: '1.1', duracao_ms: 5000, chamadas_gc: chamadas.length, erro: null });
    expect(reg.quantidades).toMatchObject({ produtos: X.cenario().produtos.length }); expect(reg.quantidades.vendas).toBe(reg.quantidades.vendas_consulta_ampla);
    expect(reg.tamanho).toMatchObject({ lotes: 1 }); expect(reg.tamanho.maior_doc_bytes).toBeLessThanOrEqual(S.DOC_BYTES_MAX);
    expect(le(db, 'compras_n0_runs', reg.run_id)).toEqual(JSON.parse(JSON.stringify(reg)));
    expect(le(db, 'compras_n0', 'lock')).toBeUndefined();
    expect(JSON.stringify(reg)).not.toMatch(/Produto sintético|tok-FAKE|sec-FAKE|nome_cliente/);
    expect(chamadas.every(c => c.method === 'GET')).toBe(true);
    expect(le(db, 'compras_n0_view', 'sugestoes').policy_version).toBe('1.1');
  });
  test('com a trava ocupada: SKIPPED_LOCKED registrado, nenhuma chamada ao GestãoClick, snapshot intocado', async () => {
    const db = dbFalso(); await E.adquirirLock(db, { runId: 'outro', tipo: 'FULL', agora: AG });
    const { cli, chamadas } = gcFalso();
    const reg = await E.executarExecucao({ db, cli, tipo: 'INCREMENTAL', gatilho: 'SCHEDULED', agora: new Date(AG.getTime() + 1000) });
    expect(reg).toMatchObject({ status: 'SKIPPED_LOCKED', detida_por: { tipo: 'FULL' } });
    expect(chamadas).toEqual([]); expect(db.st.compras_n0_produtos).toBeUndefined(); expect(le(db, 'compras_n0', 'lock').run_id).toBe('outro');
  });
  test('falha do GestãoClick: FAILED com erro sanitizado, último snapshot preservado, trava liberada', async () => {
    const db = dbFalso();
    await E.executarExecucao({ db, cli: gcFalso().cli, tipo: 'FULL', gatilho: 'MANUAL', agora: AG });
    const antes = JSON.stringify(db.st.compras_n0_view);
    const reg = await E.executarExecucao({ db, cli: gcFalso({ falhas: [503, 503, 503] }).cli, tipo: 'INCREMENTAL', gatilho: 'SCHEDULED', agora: new Date(AG.getTime() + 3600e3) });
    expect(reg).toMatchObject({ status: 'FAILED' }); expect(reg.erro).toMatch(/GC HTTP 503/);
    expect(JSON.stringify(db.st.compras_n0_view)).toBe(antes); expect(le(db, 'compras_n0', 'lock')).toBeUndefined();
  });
  test('sanitização de erro: remove token, e-mail e documento', () => {
    const s = E.sanitizarErro(new Error('falha token=abcdefghijklmnopqrstuvwxyz0123456789 de fulano@exemplo.com doc 12345678901234'));
    expect(s).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789|fulano@exemplo\.com|12345678901234/); expect(s).toMatch(/\[REDACTED\].*\[EMAIL\].*\[NUM\]/);
  });
  test('tipo/gatilho inválidos são rejeitados', async () => {
    await expect(E.executarExecucao({ db: dbFalso(), cli: gcFalso().cli, tipo: 'TUDO', gatilho: 'MANUAL' })).rejects.toThrow(/TIPO_INVALIDO/);
    await expect(E.executarExecucao({ db: dbFalso(), cli: gcFalso().cli, tipo: 'FULL', gatilho: 'X' })).rejects.toThrow(/GATILHO_INVALIDO/);
  });
});

describe('ENTRYPOINTS — HTTP privado e agendados', () => {
  const res = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const logs = () => { const l = []; return { l, log: { log: m => l.push(m) } }; };
  test('agenda aprovada: 03:15 (completo) e 06:15–21:15 a cada 3 h (incremental), America/Fortaleza', () => {
    expect(EP.AGENDA).toEqual({ TIMEZONE: 'America/Fortaleza', FULL: '15 3 * * *', INCREMENTAL: '15 6,9,12,15,18,21 * * *' });
  });
  test('manual: só POST; tipo obrigatório; secrets ausentes → 500 sanitizado', async () => {
    let r = res(); await EP.syncManualHandler({ method: 'GET', body: {} }, r, { db: dbFalso() }); expect(r.code).toBe(405);
    r = res(); await EP.syncManualHandler({ method: 'POST', body: { tipo: 'TUDO' } }, r, { db: dbFalso() }); expect(r.code).toBe(400);
    r = res(); await EP.syncManualHandler({ method: 'POST', body: { tipo: 'FULL' } }, r, { db: dbFalso(), criarCliente: () => EP.criarClienteProducao({ env: {} }) }); expect(r).toMatchObject({ code: 500, body: { erro: 'SECRETS_GC_AUSENTES' } });
  });
  test('manual FULL OK → 200 com resumo seguro; log estruturado sem segredo; em seguida incremental OK', async () => {
    const db = dbFalso(), L = logs();
    let r = res(); await EP.syncManualHandler({ method: 'POST', body: { tipo: 'FULL' } }, r, { db, criarCliente: () => gcFalso().cli, log: L.log, agora: AG });
    expect(r.code).toBe(200); expect(r.body).toMatchObject({ status: 'OK', tipo: 'FULL', gatilho: 'MANUAL', policy_version: '1.1' });
    expect(JSON.parse(L.l[0])).toMatchObject({ evento: 'compras_sync', status: 'OK' }); expect(L.l.join('')).not.toMatch(/tok-FAKE|sec-FAKE/);
    r = res(); await EP.syncManualHandler({ method: 'POST', body: { tipo: 'INCREMENTAL' } }, r, { db, criarCliente: () => gcFalso().cli, log: L.log, agora: new Date(AG.getTime() + 3600e3) });
    expect(r.body).toMatchObject({ status: 'OK', tipo: 'INCREMENTAL' }); expect(r.body.quantidades.mescla).toBeTruthy();
  });
  test('manual com trava ocupada → 409', async () => {
    const db = dbFalso(); await E.adquirirLock(db, { runId: 'x', tipo: 'FULL', agora: AG });
    const r = res(); await EP.syncManualHandler({ method: 'POST', body: { tipo: 'FULL' } }, r, { db, criarCliente: () => gcFalso().cli, log: logs().log, agora: new Date(AG.getTime() + 1000) });
    expect(r.code).toBe(409); expect(r.body.status).toBe('SKIPPED_LOCKED');
  });
  test('agendado nunca lança (nem sem secrets)', async () => {
    const reg = await EP.syncAgendadoHandler('FULL', { db: dbFalso(), criarCliente: () => EP.criarClienteProducao({ env: {} }), log: logs().log });
    expect(reg).toMatchObject({ status: 'FAILED', erro: 'SECRETS_GC_AUSENTES', gatilho: 'SCHEDULED' });
  });
  test('cliente de produção é GET-only e usa os secrets existentes', async () => {
    const chamadas = []; const cli = EP.criarClienteProducao({ env: { GC_ACCESS_TOKEN: 'a', GC_SECRET_ACCESS_TOKEN: 'b' }, fetchImpl: async (u, o) => { chamadas.push(o); return { ok: true, json: async () => ({ data: [], meta: { total_registros: 0 } }) }; } });
    await expect(cli.get('/produtos', { method: 'POST' })).rejects.toThrow(/GET_ONLY_GUARD/);
    expect(chamadas).toEqual([]);
  });
});

describe('INDEX — endpoints publicáveis', () => {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'mr4-ponto';
  const idx = require('../index');
  test('manual é HTTP PRIVADO, 1 instância, timeout 30 min, com os secrets GC', () => {
    const e = idx.comprasSyncManual.__endpoint;
    expect(e.httpsTrigger).toEqual({ invoker: ['private'] }); expect(e.maxInstances).toBe(1); expect(e.timeoutSeconds).toBe(1800); expect(e.concurrency).toBe(1);
    expect(e.secretEnvironmentVariables.map(s => s.key).sort()).toEqual(['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN']);
  });
  test('agendados: horários aprovados, fuso de Fortaleza, sem retry, 1 instância', () => {
    const c = idx.comprasSyncCompleto.__endpoint, i = idx.comprasSyncIncremental.__endpoint;
    expect(c.scheduleTrigger).toMatchObject({ schedule: '15 3 * * *', timeZone: 'America/Fortaleza', retryConfig: { retryCount: 0 } });
    expect(i.scheduleTrigger).toMatchObject({ schedule: '15 6,9,12,15,18,21 * * *', timeZone: 'America/Fortaleza', retryConfig: { retryCount: 0 } });
    expect([c.maxInstances, i.maxInstances]).toEqual([1, 1]);
  });
  test('as 11 Functions existentes continuam exportadas (nenhuma removida)', () => {
    for (const f of ['registrarPonto', 'criarContaFuncionario', 'gcQuery', 'syncPainelDisplay', 'concluirRevisaoEspelho', 'gerarFilaSnapshot', 'gerarWorklistDiaria', 'processarCarteiraComercial', 'claimOpportunity', 'registerOutcome', 'releaseOpportunity']) expect(idx[f]).toBeDefined();
  });
});

describe('VISÃO DA TELA — compras_n0_view', () => {
  const c = X.cenarioProdutoNovo();
  const snap = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA });
  const v = snap.view;
  test('linhas = sugeridos + estoque negativo + novos + Atenção (Fase D.1); ordenadas por prioridade; contagens coerentes', () => {
    const atencao = m => S.motivosAtencao(m).some(k => !S.ATENCAO_ANOTACAO.includes(k));
    const esperado = snap.operacional.filter(m => m.suggestion.suggested_qty > 0 || m.raw_stock < 0 || m.new_product || atencao(m)).length;
    expect(v.sugestoes.total_linhas).toBe(esperado); expect(v.sugestoes.linhas.length).toBe(esperado);
    const pr = v.sugestoes.linhas.map(l => l.prioridade || 'P9'); expect([...pr].sort()).toEqual(pr);
    expect(v.sugestoes.contagens.sugeridos).toBe(snap.resumo.resumo_politica.TOTAL_SUGGESTED_PRODUCTS);
    expect(v.sugestoes.contagens.unidades).toBe(snap.resumo.resumo_politica.TOTAL_SUGGESTED_UNITS);
  });
  test('badges: NOVO COM DEMANDA COMPROVADA e ESTOQUE NEGATIVO vêm do servidor', () => {
    const l = id => v.sugestoes.linhas.find(x => x.id === id);
    expect(l('NV-NEG')).toMatchObject({ novo_com_demanda: true, estoque_negativo: true, estoque: -2, disponivel: 0 });
    expect(l('NV-SEM')).toMatchObject({ novo_protegido: true, qtd: 0 });
  });
  test('nome do produto SÓ na visão da tela (operacional/resumo continuam sem nome); sem custo na visão operacional', () => {
    expect(JSON.stringify(v.sugestoes)).toMatch(/Produto sintético/);
    expect(JSON.stringify(snap.operacional) + JSON.stringify(snap.resumo)).not.toMatch(/Produto sintético/);
    expect(JSON.stringify(v.sugestoes)).not.toMatch(/_cents|custo/i);
    // custos continuam SÓ para o conjunto da Fase D (sugestão ∪ negativo ∪ novo); a Atenção não amplia custos
    const ids = snap.operacional.filter(m => m.suggestion.suggested_qty > 0 || m.raw_stock < 0 || m.new_product).map(m => m.product_id).sort();
    expect(Object.keys(v.custos.linhas).sort()).toEqual(ids);
    expect(v.custos.aviso).toMatch(/INDICATIVO/);
  });
  test('tamanho em escala real (877 produtos): visão da tela pequena (< 300 KB)', () => {
    const ps = Array.from({ length: 877 }, (_, i) => X.produto('PX-' + i, { estoque: (i % 9) - 1 }));
    const vs = Array.from({ length: 6000 }, (_, i) => X.venda(X.dia(i % 170), [['PX-' + (i % 877), 1 + (i % 3), 25]], { id: 'VX-' + i }));
    const cs = Array.from({ length: 300 }, (_, i) => X.compra(X.dia(200 + (i % 100)), Array.from({ length: 8 }, (_, j) => ['PX-' + ((i * 8 + j) % 877), 10, 10]), { id: 'CX-' + i }));
    const sn = S.montarSnapshot({ brutosProdutos: ps, brutosVendas: vs, brutosCompras: cs, agora: X.AGORA });
    expect(Buffer.byteLength(JSON.stringify(sn.view.sugestoes))).toBeLessThan(300 * 1024);
    expect(Buffer.byteLength(JSON.stringify(sn.view.custos))).toBeLessThan(300 * 1024);
  });
  test('guarda de compatibilidade Firestore: array aninhado aborta ANTES de gravar; snapshot real não tem nenhum', async () => {
    expect(S.temArrayAninhado({ a: [[1]] })).toBe(true); expect(S.temArrayAninhado({ a: [{ b: [1] }] })).toBe(false); expect(S.temArrayAninhado({ a: [1, 2] })).toBe(false);
    for (const d of [snap.resumo, snap.meta, snap.snapshotEstoque, snap.view.sugestoes, snap.view.custos, ...snap.operacional, ...snap.custos]) expect(S.temArrayAninhado(d)).toBe(false);
    const db = dbFalso(); const ruim = { ...snap, base: null, resumo: { ...snap.resumo, x: [[1, 2]] } };
    await expect(S.persistirSnapshot(db, ruim)).rejects.toThrow(/DOC_INCOMPATIVEL_FIRESTORE/); expect(db.st).toEqual({});
  });
  test('base do incremental gravada como texto JSON (sem array aninhado) e recarregada idêntica', async () => {
    const db = dbFalso(); await S.persistirSnapshot(db, { ...snap, base: { ...snap.base, formato: S.FORMATO_BASE } });   // v2 (Política 1.2): ida e volta completa
    const doc0 = le(db, 'compras_n0_base', S.idFatia(le(db, 'compras_n0', 'meta').base_ativa, 'v', 0));   // id da fatia vem do ponteiro da geração ativa
    expect(doc0.formato).toBe('tuplas-json-v2'); expect(typeof doc0.registros_json).toBe('string'); expect(S.temArrayAninhado(doc0)).toBe(false);
    expect((await S.carregarBase(db)).vendas).toEqual(snap.base.vendas);
  });
  test('a visão é persistida junto do snapshot (mesmo lote)', async () => {
    const db = dbFalso(); await S.persistirSnapshot(db, { ...snap, base: null });
    expect(Object.keys(db.st.compras_n0_view).sort()).toEqual(['custos', 'sugestoes']);
  });
});

describe('TELA — verificações estáticas (compras.html)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../modulos/compras.html'), 'utf8');
  const js = html.slice(html.indexOf('<script type="module">'));
  test('lê SÓ a visão já processada + meta; nada de GestãoClick, base, blocos ou coleções inteiras no navegador', () => {
    const docs = [...js.matchAll(/doc\(db,\s*'([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map(m => m[1] + '/' + m[2]).sort();
    expect(docs).toEqual(['compras_n0/meta', 'compras_n0_view/custos', 'compras_n0_view/sugestoes']);
    expect(js).not.toMatch(/gcQuery|httpsCallable|getFunctions|collection\(|getDocs|compras_n0_base|compras_n0_produtos|compras_n0_custos|api\.gestaoclick/);
  });
  test('linguagem: sugestão de compra, não pedido; nenhuma ação que envie algo a fornecedor', () => {
    expect(html).toMatch(/Sugestões de compra/); expect(html).toMatch(/Sugestão de compra não é pedido/);
    expect(html).not.toMatch(/(Gerar|Enviar|Criar|Fazer)\s+pedido/i);
    expect(js).not.toMatch(/setDoc|updateDoc|addDoc|deleteDoc|fetch\(/);
  });
  test('badges e proteção de custo: custo só se o documento de custos foi lido (Rules decidem)', () => {
    expect(html).toMatch(/NOVO COM DEMANDA COMPROVADA/); expect(html).toMatch(/ESTOQUE NEGATIVO/);
    expect(js).toMatch(/catch \(_\) \{ estado\.custos = null; \}/); expect(js).toMatch(/const comCusto = !!estado\.custos;/);
  });
  test('conteúdo vindo do banco é escapado antes de ir para o HTML', () => {
    expect(js).toMatch(/const esc = s =>/); expect(js).toMatch(/\$\{esc\(l\.nome/); expect(js).toMatch(/\$\{esc\(m\)\}/);
  });
  test('acesso: mesma guarda de módulo do sistema (compras) e responsivo (mobile)', () => {
    expect(js).toMatch(/verificarAcessoModulo\(db, user\.uid, 'compras'\)/); expect(html).toMatch(/@media \(max-width: 900px\)/);
  });
});
