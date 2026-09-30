'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · busca GET-only, janelas/paginação/deduplicação, API incompleta/fora,
// frescor e preservação do último snapshot.
const F = require('../lib/compras/fetch');
const S = require('../lib/compras/snapshot');
const X = require('./fixtures/compras-estoque-f0');

// GestãoClick falso com a semântica comprovada: limite 100, /vendas por `data`, /compras por `data_emissao` (embrulhado).
function gcFalso({ produtos = [], vendas = [], compras = [], falhar = false, mentirTotal = false, repetirEmJanelas = null } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, opts) => {
    chamadas.push({ url, method: opts.method });
    if (falhar) return { ok: false, status: 503, json: async () => ({}) };
    const u = new URL(url), q = u.searchParams, pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    let lista;
    if (u.pathname === '/produtos') lista = produtos;
    else if (u.pathname === '/vendas') lista = vendas.filter(v => v.data >= q.get('data_inicio') && v.data <= q.get('data_fim')).sort((a, b) => b.data.localeCompare(a.data) || a.id.localeCompare(b.id));
    else if (u.pathname === '/compras') lista = compras.filter(c => (c.Compra.data_emissao >= q.get('data_inicio') && c.Compra.data_emissao <= q.get('data_fim')) || (repetirEmJanelas && repetirEmJanelas === c.Compra.id));
    else return { ok: false, status: 404, json: async () => ({}) };
    const total = lista.length;
    return { ok: true, json: async () => ({ data: lista.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: mentirTotal ? total + 1 : total, total_paginas: Math.max(1, Math.ceil(total / lim)) } }) };
  };
  return { cli: F.criarClienteGC({ fetchImpl, accessToken: 'tok-FAKE', secretToken: 'sec-FAKE', pausaMs: 0, dormir: async () => {} }), chamadas };
}
function dbFalso(inicial = {}) {
  const st = JSON.parse(JSON.stringify(inicial));
  const ref = (c, id) => ({ id, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => (st[c] && st[c][id] ? JSON.parse(JSON.stringify(st[c][id])) : undefined) }),
    set: async v => { (st[c] = st[c] || {})[id] = JSON.parse(JSON.stringify(v)); }, delete: async () => { if (st[c]) delete st[c][id]; } });
  return { st, collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }) }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), commit: async () => { for (const o of ops) await o(); } }; } };
}

describe('GET_ONLY_GUARD', () => {
  test('bloqueia POST/PUT/PATCH/DELETE, outro host e recurso fora da lista', async () => {
    const { cli, chamadas } = gcFalso();
    for (const mt of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(cli.get('/produtos', { method: mt })).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('//evil.example/x')).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('/clientes?limite=1')).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('/recebimentos')).rejects.toThrow(/GET_ONLY_GUARD/);
    expect(chamadas).toEqual([]);
  });
  test('o módulo compras não contém chamada de mutação nem acesso a disco', () => {
    const fs = require('fs'), path = require('path');
    for (const f of fs.readdirSync(path.join(__dirname, '../lib/compras'))) {
      const src = fs.readFileSync(path.join(__dirname, '../lib/compras', f), 'utf8');
      expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
      expect(src).not.toMatch(/require\(['"]fs['"]\)/);
    }
  });
});

describe('Repetição controlada (GET idempotente)', () => {
  const resp = (ok, status, body = { data: [], meta: { total_registros: 0, total_paginas: 1 } }) => ({ ok, status, json: async () => body });
  test('timeout/5xx/429 repetem até 3 tentativas e então sucesso', async () => {
    const seq = [() => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); }, () => resp(false, 503), () => resp(true, 200)];
    let i = 0; const esperas = [];
    const cli = F.criarClienteGC({ fetchImpl: async () => seq[i++](), accessToken: 'a', secretToken: 'b', pausaMs: 0, dormir: async ms => esperas.push(ms) });
    await expect(cli.get('/produtos?pagina=1')).resolves.toMatchObject({ data: [] });
    expect(cli.chamadas()).toBe(3); expect(cli.repeticoes()).toBe(2); expect(esperas).toEqual([2000, 4000]);
  });
  test('esgota as tentativas → erro (o sync preserva o último snapshot)', async () => {
    const cli = F.criarClienteGC({ fetchImpl: async () => resp(false, 429), accessToken: 'a', secretToken: 'b', pausaMs: 0, dormir: async () => {} });
    await expect(cli.get('/produtos')).rejects.toThrow(/GC HTTP 429/); expect(cli.chamadas()).toBe(3);
  });
  test('4xx (≠429) não repete', async () => {
    const cli = F.criarClienteGC({ fetchImpl: async () => resp(false, 401), accessToken: 'a', secretToken: 'b', pausaMs: 0, dormir: async () => {} });
    await expect(cli.get('/produtos')).rejects.toThrow(/GC HTTP 401/); expect(cli.chamadas()).toBe(1);
  });
});

describe('Paginação, janelas e deduplicação', () => {
  test('produtos: 877 em 9 páginas, conferido com total_registros', async () => {
    const produtos = Array.from({ length: 877 }, (_, i) => X.produto('PX-' + i));
    const { cli, chamadas } = gcFalso({ produtos });
    const r = await F.buscarProdutos(cli);
    expect(r.produtos.length).toBe(877); expect(r.estatisticas.paginas).toBe(9); expect(chamadas.every(c => c.method === 'GET')).toBe(true);
  });
  test('vendas: 250 no mesmo mês = 3 páginas; janelas mensais cobrem o período', async () => {
    const vendas = Array.from({ length: 250 }, (_, i) => X.venda('2026-09-' + String(1 + (i % 28)).padStart(2, '0'), [['PX-1', 1]], { id: 'VX-' + i }));
    vendas.push(X.venda('2026-07-15', [['PX-1', 1]], { id: 'VX-JUL' }));
    const { cli } = gcFalso({ vendas });
    const r = await F.buscarPorJanelas(cli, 'vendas', { inicio: '2026-07-01', fim: '2026-09-28' });
    expect(r.registros.length).toBe(251); expect(r.estatisticas).toMatchObject({ janelas: 5, paginas: 7, unique: 251, duplicates: 0, total_consulta_ampla: 251 });
  });
  test('compras: desembrulha {Compra} e deduplica registro repetido entre janelas', async () => {
    const compras = [X.compra('2026-08-10', [['PX-1', 1]], { id: 'CX-A' }), X.compra('2026-09-10', [['PX-1', 1]], { id: 'CX-B' })];
    const { cli } = gcFalso({ compras, repetirEmJanelas: 'CX-A' });
    const r = await F.buscarPorJanelas(cli, 'compras', { inicio: '2026-08-01', fim: '2026-09-28' });
    expect(r.registros.map(x => x.id).sort()).toEqual(['CX-A', 'CX-B']); expect(r.estatisticas.duplicates).toBe(3);   // 4 janelas (anterior + 2 mensais + futura)
    expect(r.registros[0].Compra).toBeUndefined();
  });
  test('venda com data FUTURA e registro anterior ao início entram (janelas extras) e a soma bate com a consulta ampla', async () => {
    const vendas = [X.venda('2026-09-10', [['PX-1', 1]], { id: 'VX-A' }), X.venda('2026-09-30', [['PX-1', 1]], { id: 'VX-FUT', situacao: 'Reservado' }), X.venda('2019-05-02', [['PX-1', 1]], { id: 'VX-OLD' })];
    const { cli } = gcFalso({ vendas });
    const r = await F.buscarPorJanelas(cli, 'vendas', { inicio: '2026-09-01', fim: '2026-09-28' });
    expect(r.registros.map(x => x.id).sort()).toEqual(['VX-A', 'VX-FUT', 'VX-OLD']); expect(r.estatisticas).toMatchObject({ janelas: 3, unique: 3, total_consulta_ampla: 3 });
  });
  test('soma das janelas ≠ consulta ampla → COBERTURA_INCOMPLETA', async () => {
    const vendas = [X.venda('2026-09-10', [['PX-1', 1]], { id: 'VX-A' })];
    const base = gcFalso({ vendas });
    const cli = { chamadas: base.cli.chamadas, get: async caminho => { const j = await base.cli.get(caminho); if (/2099-12-31&pagina=1&limite=1$/.test(caminho)) j.meta.total_registros = 2; return j; } };
    await expect(F.buscarPorJanelas(cli, 'vendas', { inicio: '2026-09-01', fim: '2026-09-28' })).rejects.toThrow(/COBERTURA_INCOMPLETA/);
  });
  test('janelasMensais: recorta início/fim e vira o ano', () => {
    expect(F.janelasMensais('2025-12-15', '2026-02-10')).toEqual([{ inicio: '2025-12-15', fim: '2025-12-31' }, { inicio: '2026-01-01', fim: '2026-01-31' }, { inicio: '2026-02-01', fim: '2026-02-10' }]);
  });
  test('API INCOMPLETA (únicos ≠ total_registros) → erro JANELA_INCOMPLETA', async () => {
    const { cli } = gcFalso({ vendas: [X.venda('2026-09-01', [['PX-1', 1]])], mentirTotal: true });
    await expect(F.buscarPorJanelas(cli, 'vendas', { inicio: '2026-09-01', fim: '2026-09-28' })).rejects.toThrow(/JANELA_INCOMPLETA/);
  });
});

describe('Sync: sucesso, falha preserva o último snapshot, frescor', () => {
  const base = () => { const c = X.cenario(); return gcFalso({ produtos: c.produtos, vendas: c.vendas, compras: c.compras }); };
  test('sucesso grava resumo/meta/blocos operacionais/blocos de custo/snapshot diário de estoque', async () => {
    const db = dbFalso(); const { cli } = base();
    const r = await S.executarSync({ cli, db, agora: X.AGORA, inicio: '2022-01-01' });
    expect(r.ok).toBe(true);
    expect(Object.keys(db.st.compras_n0).sort()).toEqual(['meta', 'resumo']);
    expect(Object.keys(db.st.compras_n0_produtos)).toEqual(['bloco_000']); expect(Object.keys(db.st.compras_n0_custos)).toEqual(['bloco_000']);
    expect(db.st.estoque_snapshots['2026-09-28'].saldos['PX-FORTE']).toBe(5);
    expect(db.st.compras_n0.meta).toMatchObject({ ultima_tentativa_ok: true, erro: null });
    expect(db.st.compras_n0.meta.estatisticas.vendas.duplicates).toBe(0);
  });
  test('API FORA → nada é sobrescrito; meta registra a falha; frescor vira STALE com o tempo', async () => {
    const db = dbFalso(); await S.executarSync({ cli: base().cli, db, agora: X.AGORA });
    const antes = JSON.stringify({ r: db.st.compras_n0.resumo, p: db.st.compras_n0_produtos, c: db.st.compras_n0_custos });
    const depois = new Date(X.AGORA.getTime() + 7 * 3600e3);
    const r = await S.executarSync({ cli: gcFalso({ falhar: true }).cli, db, agora: depois });
    expect(r.ok).toBe(false);
    expect(JSON.stringify({ r: db.st.compras_n0.resumo, p: db.st.compras_n0_produtos, c: db.st.compras_n0_custos })).toBe(antes);
    expect(db.st.compras_n0.meta).toMatchObject({ ultima_tentativa_ok: false, ultima_sincronizacao_ok: X.AGORA.toISOString() });
    expect(db.st.compras_n0.meta.erro).toMatch(/GC HTTP 503/);
    expect(S.frescor(db.st.compras_n0.meta.ultima_sincronizacao_ok, depois).estado).toBe('STALE');
  });
  test('API INCOMPLETA no meio do sync → último snapshot preservado', async () => {
    const db = dbFalso(); await S.executarSync({ cli: base().cli, db, agora: X.AGORA });
    const c = X.cenario(); const antes = JSON.stringify(db.st.compras_n0_produtos);
    const r = await S.executarSync({ cli: gcFalso({ produtos: c.produtos, vendas: c.vendas, compras: c.compras, mentirTotal: true }).cli, db, agora: X.AGORA });
    expect(r.ok).toBe(false); expect(JSON.stringify(db.st.compras_n0_produtos)).toBe(antes); expect(db.st.compras_n0.meta.erro).toBe('JANELA_INCOMPLETA');
  });
  test('frescor CURRENT (≤6h) / STALE / UNAVAILABLE (nunca sincronizou)', () => {
    expect(S.frescor('2026-09-28T10:00:00Z', new Date('2026-09-28T15:00:00Z')).estado).toBe('CURRENT');
    expect(S.frescor('2026-09-28T08:00:00Z', new Date('2026-09-28T15:00:00Z')).estado).toBe('STALE');
    expect(S.frescor(null).estado).toBe('UNAVAILABLE');
  });
  test('blocos excedentes de um snapshot maior anterior são removidos', async () => {
    const db = dbFalso({ compras_n0_produtos: { bloco_000: {}, bloco_001: {}, bloco_002: {} }, compras_n0_custos: { bloco_000: {}, bloco_001: {} } });
    await S.executarSync({ cli: base().cli, db, agora: X.AGORA });
    expect(Object.keys(db.st.compras_n0_produtos)).toEqual(['bloco_000']); expect(Object.keys(db.st.compras_n0_custos)).toEqual(['bloco_000']);
  });
});
