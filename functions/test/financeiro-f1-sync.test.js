'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · busca GET-only, paginação/deduplicação, falha da API, frescor e persistência.
const F = require('../lib/financeiro/fetch');
const S = require('../lib/financeiro/snapshot');
const { FORMAS, titulo, receber } = require('./fixtures/financeiro-f1');

// ── GestãoClick falso: aplica a MESMA semântica comprovada (data efetiva, limite 100, ordem por data efetiva) ──
function gcFalso({ pagamentos = [], recebimentos = [], falhar = false, mentirTotal = false } = {}) {
  const chamadas = [];
  const efetiva = t => (t.liquidado === '1' ? t.data_liquidacao : t.data_vencimento);
  const fetchImpl = async (url, opts) => {
    chamadas.push({ url, method: opts.method });
    if (falhar) return { ok: false, status: 503, json: async () => ({}) };
    const u = new URL(url), q = u.searchParams;
    if (u.pathname === '/formas_pagamentos') return { ok: true, json: async () => ({ data: Object.entries(FORMAS).map(([id, f]) => ({ FormasPagamento: { id, ...f } })), meta: { total_registros: 6, total_paginas: 1 } }) };
    if (u.pathname === '/planos_contas') return { ok: true, json: async () => ({ data: [{ id: 'P1', classificacao: '1.2.2', tipo: 'D', nome: 'Compras', conta_mae_id: 'P0', nome_conta_mae: 'Despesas' }], meta: { total_registros: 1, total_paginas: 1 } }) };
    const base = u.pathname === '/pagamentos' ? pagamentos : recebimentos;
    const ini = q.get('data_inicio'), fim = q.get('data_fim'), pagina = Number(q.get('pagina') || 1), lim = Math.min(100, Number(q.get('limite') || 20));
    const lista = base.filter(t => efetiva(t) >= ini && efetiva(t) <= fim).sort((a, b) => efetiva(a).localeCompare(efetiva(b)) || a.id.localeCompare(b.id));
    const total = lista.length;
    return { ok: true, json: async () => ({ data: lista.slice((pagina - 1) * lim, pagina * lim), meta: { total_registros: mentirTotal ? total + 1 : total, total_paginas: Math.max(1, Math.ceil(total / lim)) } }) };
  };
  return { cli: F.criarClienteGC({ fetchImpl, accessToken: 'tok-FAKE', secretToken: 'sec-FAKE', pausaMs: 0 }), chamadas };
}
// ── Firestore falso com batch ──
function dbFalso(inicial = {}) {
  const st = JSON.parse(JSON.stringify(inicial));
  const ref = (c, id) => ({ id, get: async () => ({ exists: !!(st[c] && st[c][id]), data: () => (st[c] && st[c][id] ? JSON.parse(JSON.stringify(st[c][id])) : undefined) }),
    set: async v => { (st[c] = st[c] || {})[id] = JSON.parse(JSON.stringify(v)); }, delete: async () => { if (st[c]) delete st[c][id]; } });
  return {
    st,
    collection: c => ({ doc: id => ref(c, id), get: async () => ({ docs: Object.keys(st[c] || {}).map(id => ({ id, ref: ref(c, id) })) }) }),
    batch: () => { const ops = []; return { set: (r, v) => ops.push(() => r.set(v)), commit: async () => { for (const o of ops) await o(); } }; },
  };
}
const AGORA = new Date('2026-09-28T15:00:00Z');   // 12:00 em Fortaleza

describe('GET_ONLY_GUARD', () => {
  test('bloqueia POST/PUT/PATCH/DELETE, outro host e recurso fora da lista', async () => {
    const { cli, chamadas } = gcFalso();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(cli.get('/pagamentos', { method: m })).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('//evil.example/x')).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('/clientes?limite=1')).rejects.toThrow(/GET_ONLY_GUARD/);
    expect(chamadas).toEqual([]);   // nada saiu
  });
  test('o módulo financeiro não contém nenhuma chamada de mutação', () => {
    const fs = require('fs'), path = require('path');
    for (const f of fs.readdirSync(path.join(__dirname, '../lib/financeiro'))) {
      const src = fs.readFileSync(path.join(__dirname, '../lib/financeiro', f), 'utf8');
      expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
      expect(src).not.toMatch(/require\(['"]fs['"]\)/);
    }
  });
});

describe('Paginação, janelas e deduplicação', () => {
  test('pagina até o fim (250 títulos no mesmo mês = 3 páginas) e confere com total_registros', async () => {
    const ts = Array.from({ length: 250 }, (_, i) => titulo({ id: 'P' + i, data_vencimento: '2026-09-' + String(1 + (i % 28)).padStart(2, '0') }));
    const { cli } = gcFalso({ pagamentos: ts });
    const r = await F.buscarTitulos(cli, 'pagamentos', { inicio: '2026-09-01', fim: '2026-09-30' });
    expect(r.estatisticas).toMatchObject({ janelas: 1, paginas: 3, fetched: 250, unique: 250, duplicates: 0 });
  });
  test('vencido antigo em aberto é encontrado (janela do vencimento), pago recente na janela da liquidação', async () => {
    const ts = [titulo({ id: 'ANTIGO', data_vencimento: '2019-03-10' }), titulo({ id: 'PAGO', liquidado: '1', data_vencimento: '2018-01-01', data_liquidacao: '2026-09-02' })];
    const { cli } = gcFalso({ pagamentos: ts });
    const r = await F.buscarTitulos(cli, 'pagamentos', { inicio: '2015-01-01', fim: '2026-12-31' });
    expect(r.titulos.map(t => t.id).sort()).toEqual(['ANTIGO', 'PAGO']);
  });
  test('duplicata entre páginas/janelas (título pago durante a varredura) → deduplicado pelo ID, fica o mais recente', async () => {
    const velho = titulo({ id: 'DUP', data_vencimento: '2026-08-20', modificado_em: '2026-08-01 10:00:00' });
    const novo = { ...velho, liquidado: '1', data_liquidacao: '2026-09-05', modificado_em: '2026-09-05 10:00:00' };
    const { cli } = gcFalso({ pagamentos: [velho, novo] });   // a API "vê" as duas versões em janelas diferentes
    const r = await F.buscarTitulos(cli, 'pagamentos', { inicio: '2026-08-01', fim: '2026-09-30' });
    expect(r.estatisticas).toMatchObject({ fetched: 2, unique: 1, duplicates: 1 });
    expect(r.titulos[0].liquidado).toBe('1');
  });
  test('janelas mensais cobrem o intervalo sem buraco', () => {
    const j = F.janelasMensais('2026-01-15', '2026-03-10');
    expect(j).toEqual([{ inicio: '2026-01-15', fim: '2026-01-31' }, { inicio: '2026-02-01', fim: '2026-02-28' }, { inicio: '2026-03-01', fim: '2026-03-10' }]);
  });
  test('API incompleta (total_registros não bate) → erro JANELA_INCOMPLETA', async () => {
    const { cli } = gcFalso({ pagamentos: [titulo({ id: 'a' })], mentirTotal: true });
    await expect(F.buscarTitulos(cli, 'pagamentos', { inicio: '2026-09-01', fim: '2026-09-30' })).rejects.toThrow(/JANELA_INCOMPLETA/);
  });
});

describe('Sync, snapshot anterior e frescor', () => {
  const pagamentos = [titulo({ id: 'p1', data_vencimento: '2026-09-20' }), titulo({ id: 'p2', data_vencimento: '2026-10-01' })];
  const recebimentos = [receber({ id: 'r1', data_vencimento: '2026-09-28' })];
  const rodar = (gc, db) => S.executarSync({ cli: gc.cli, db, agora: AGORA, inicio: '2026-08-01', horizonteDias: 60 });

  test('sucesso: grava resumo (sem nomes/IDs de títulos), auditoria, meta e títulos abertos', async () => {
    const db = dbFalso();
    const r = await rodar(gcFalso({ pagamentos, recebimentos }), db);
    expect(r.ok).toBe(true);
    const resumo = db.st.fin_n1.resumo;
    expect(resumo.data_comercial).toBe('2026-09-28');
    expect(resumo.pagar.buckets_exclusivos.VENCIDO).toEqual({ quantidade: 1, total_cents: 10000 });
    expect(resumo.receber.buckets_exclusivos.HOJE.quantidade).toBe(1);
    expect(JSON.stringify(resumo)).not.toMatch(/Fornecedor Fictício|Cliente Fictício|"p1"|"r1"/);   // sem nomes e sem IDs de títulos
    expect(resumo.metricas_bloqueadas).toEqual(expect.arrayContaining(['SALDO_DISPONIVEL', 'CAIXA_PARA_COMPRAS', 'CAPACIDADE_DE_COMPRA']));
    expect(db.st.fin_n1.auditoria.pagar.buckets_exclusivos.VENCIDO).toEqual(['p1']);
    expect(db.st.fin_n1_titulos_abertos.bloco_000.titulos.length).toBe(3);
    expect(db.st.fin_n1.meta).toMatchObject({ ultima_tentativa_ok: true, erro: null });
  });
  test('API indisponível: snapshot válido anterior PRESERVADO (nada vira zero); só meta registra a falha', async () => {
    const db = dbFalso();
    await rodar(gcFalso({ pagamentos, recebimentos }), db);
    const antes = JSON.parse(JSON.stringify(db.st));
    const r = await S.executarSync({ cli: gcFalso({ falhar: true }).cli, db, agora: new Date('2026-09-28T18:00:00Z'), inicio: '2026-08-01', horizonteDias: 60 });
    expect(r.ok).toBe(false);
    expect(db.st.fin_n1.resumo).toEqual(antes.fin_n1.resumo);
    expect(db.st.fin_n1_titulos_abertos).toEqual(antes.fin_n1_titulos_abertos);
    expect(db.st.fin_n1.meta).toMatchObject({ ultima_sincronizacao_ok: antes.fin_n1.meta.ultima_sincronizacao_ok, ultima_tentativa_ok: false });
    expect(db.st.fin_n1.meta.erro).toMatch(/503/);
  });
  test('API incompleta também preserva o anterior', async () => {
    const db = dbFalso();
    await rodar(gcFalso({ pagamentos, recebimentos }), db);
    const resumoAntes = JSON.stringify(db.st.fin_n1.resumo);
    const r = await rodar(gcFalso({ pagamentos, recebimentos, mentirTotal: true }), db);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(db.st.fin_n1.resumo)).toBe(resumoAntes);
    expect(db.st.fin_n1.meta.erro).toBe('JANELA_INCOMPLETA');
  });
  test('ausência de cache → UNAVAILABLE; recente → CURRENT; antigo → STALE (limiar explícito de 6 h)', () => {
    expect(S.frescor(null, AGORA).estado).toBe('UNAVAILABLE');
    expect(S.frescor('2026-09-28T12:00:00Z', AGORA)).toMatchObject({ estado: 'CURRENT', idade_min: 180, limiar_horas: 6 });
    expect(S.frescor('2026-09-28T08:00:00Z', AGORA).estado).toBe('STALE');
  });
  test('sem cache anterior e API fora: nenhum resumo é criado (não aparece R$ 0)', async () => {
    const db = dbFalso();
    const r = await rodar(gcFalso({ falhar: true }), db);
    expect(r.ok).toBe(false);
    expect(db.st.fin_n1.resumo).toBeUndefined();
    expect(db.st.fin_n1.meta.ultima_sincronizacao_ok).toBeUndefined();
  });
});
