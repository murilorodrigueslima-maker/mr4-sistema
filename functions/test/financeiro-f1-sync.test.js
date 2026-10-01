'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · busca GET-only, paginação/deduplicação, falha da API, frescor e persistência.
const F = require('../lib/financeiro/fetch');
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

