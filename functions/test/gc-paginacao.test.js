'use strict';
// Etapa A · A0 — paginação completa (gcHttp.paginarCompleto) e helpers puros. Sem rede.
const { criarCliente, paginarCompleto, verificarFiltroModificacao, avaliarPublicacao, decidirCursor, GcErro, CODIGOS } = require('../lib/gcHttp');

const mkItens = (n, ini = 1) => Array.from({ length: n }, (_, i) => ({ id: String(ini + i), modificado_em: `2026-11-20 ${String(10 + (i % 10)).padStart(2, '0')}:00:00` }));
function resp(status, corpo, headers = {}) { return { status, ok: status >= 200 && status < 300, headers: { get: k => headers[String(k).toLowerCase()] ?? null }, json: async () => corpo }; }

/**
 * Servidor de páginas simulado. `itens` = lista completa; `limite` do pedido; `falhas` = { [pagina]: (corpo)=>resposta } para injetar defeitos.
 * `ajustaMeta(meta, pagina)` permite corromper o meta por página.
 */
function servidor(itens, { falhas = {}, ajustaMeta = (m) => m, ajustaData = (d) => d, totalDeclarado = itens.length } = {}) {
  const chamadas = [];
  const transporte = async (url) => {
    const u = new URL(url); const pagina = Number(u.searchParams.get('pagina') || 1); const limite = Number(u.searchParams.get('limite') || 100);
    chamadas.push(pagina);
    if (falhas[pagina]) { const r = falhas[pagina](); if (r) return r; }
    const tp = Math.max(1, Math.ceil(totalDeclarado / limite)); const data = ajustaData(itens.slice((pagina - 1) * limite, pagina * limite), pagina);
    const meta = ajustaMeta({ total_registros: totalDeclarado, total_paginas: tp, total_registros_pagina: data.length, pagina_atual: pagina, limite_por_pagina: limite, pagina_anterior: pagina > 1 ? pagina - 1 : null, url_anterior: null, proxima_pagina: pagina < tp ? pagina + 1 : null, proxima_url: null }, pagina);
    return resp(200, { code: 200, status: 'success', meta, data });
  };
  return { transporte, chamadas };
}
const cli = (s, extra = {}) => criarCliente({ transporte: s.transporte, credenciais: { access: 'a', secret: 'b' }, dormir: async () => {}, ...extra });
const falha = async p => { try { await p; } catch (e) { return e; } throw new Error('esperava erro'); };
const VAZIA = () => resp(200, { code: 200, status: 'success', meta: { total_registros: null, total_paginas: null, total_registros_pagina: null, pagina_atual: 1, limite_por_pagina: 100, pagina_anterior: null, url_anterior: null, proxima_pagina: null, proxima_url: null }, data: [], error: '', message: '' });

describe('paginarCompleto — leitura completa', () => {
  test('118 registros em 2 páginas (formato real) ⇒ lista completa, únicos == total', async () => {
    const s = servidor(mkItens(118)); const r = await paginarCompleto(cli(s), '/vendas', { loja_id: '262759' });
    expect(r.itens).toHaveLength(118); expect(r.total).toBe(118); expect(r.paginas).toBe(2); expect(r.vazio).toBe(false); expect(s.chamadas).toEqual([1, 2]);
  });
  test('página única, múltiplo exato do limite e limite pequeno', async () => {
    expect((await paginarCompleto(cli(servidor(mkItens(37))), '/vendas')).itens).toHaveLength(37);
    expect((await paginarCompleto(cli(servidor(mkItens(200))), '/vendas')).paginas).toBe(2);
    expect((await paginarCompleto(cli(servidor(mkItens(118))), '/vendas', {}, { limite: 25 })).paginas).toBe(5);
  });
  test('proxima_pagina numérica em texto é aceita; desembrulhar ({Compra:{…}})', async () => {
    const s = servidor(mkItens(150).map(x => ({ Compra: x })), { ajustaMeta: m => ({ ...m, proxima_pagina: m.proxima_pagina === null ? null : String(m.proxima_pagina) }) });
    const r = await paginarCompleto(cli(s), '/compras', {}, { desembrulhar: x => x.Compra }); expect(r.itens).toHaveLength(150);
  });
  test('duplicatas (mesmo id em páginas diferentes) são deduplicadas e contadas; total confere pelos únicos', async () => {
    const base = mkItens(150); const s = servidor(base, { ajustaData: (d, p) => (p === 2 ? [base[99], ...d.slice(1)] : d) });   // p2 começa repetindo o último da p1 e perde um
    const e = await falha(paginarCompleto(cli(s), '/vendas'));
    expect(e.codigo).toBe(CODIGOS.PAGINACAO_INCOMPLETA);                                   // únicos 149 < total 150
  });
  test('mantém o registro de maior modificado_em quando o id se repete (deslocamento de página)', async () => {
    const base = mkItens(100); const dup = { ...base[3], modificado_em: '2026-11-21 23:59:59' };
    const itens = [...base.slice(0, 75), dup, ...base.slice(76)];
    const s = servidor(itens, { ajustaMeta: m => ({ ...m, total_registros: null, total_paginas: null }) });
    const r = await paginarCompleto(cli(s), '/vendas', {}, { limite: 50, exigirTotal: false });
    expect(r.itens).toHaveLength(99); expect(r.duplicatas).toBe(1);
    expect(r.itens.find(x => x.id === base[3].id).modificado_em).toBe('2026-11-21 23:59:59');
  });
});

describe('paginarCompleto — NUNCA devolve resultado parcial (A1 #1–#4 na camada segura)', () => {
  test('HTTP 429 persistente na página 2 ⇒ erro; nenhum item devolvido', async () => {
    const s = servidor(mkItens(118), { falhas: { 2: () => resp(429, { code: 429 }, { 'retry-after': '1' }) } });
    const e = await falha(paginarCompleto(cli(s), '/vendas')); expect(e).toBeInstanceOf(GcErro); expect(e.codigo).toBe(CODIGOS.R429_ESGOTADO);
  });
  test('HTTP 500 persistente na página 2 ⇒ erro', async () => {
    const s = servidor(mkItens(118), { falhas: { 2: () => resp(500, {}) } });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe('GC_HTTP_500');
  });
  test('200 com estrutura inválida na página 2 ⇒ erro', async () => {
    const s = servidor(mkItens(118), { falhas: { 2: () => resp(200, { code: 200, status: 'success', dados: [] }) } });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.RESPOSTA_INESPERADA);
  });
  test('429 transitório na página 2 e depois 200 ⇒ lista COMPLETA (retentativa limitada funciona)', async () => {
    let n = 0; const s = servidor(mkItens(118), { falhas: { 2: () => (n++ === 0 ? resp(429, {}, { 'retry-after': '1' }) : null) } });
    const r = await paginarCompleto(cli(s), '/vendas'); expect(r.itens).toHaveLength(118);
  });
  test('paginação incompleta: total_registros maior que o entregue ⇒ GC_PAGINACAO_INCOMPLETA', async () => {
    const s = servidor(mkItens(117), { totalDeclarado: 118 });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCOMPLETA);
  });
  test('página vazia antes do fim ⇒ INCOMPLETA', async () => {
    const s = servidor(mkItens(250), { ajustaData: (d, p) => (p === 2 ? [] : d) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCOMPLETA);
  });
  test('proxima_pagina nula antes de total_paginas ⇒ INCOMPLETA', async () => {
    const s = servidor(mkItens(250), { ajustaMeta: (m, p) => (p === 1 ? { ...m, proxima_pagina: null } : m) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCOMPLETA);
  });
  test('página repetida ⇒ PAGINACAO_REPETIDA', async () => {
    const base = mkItens(250); const s = servidor(base, { ajustaData: (d, p) => (p === 2 ? base.slice(0, 100) : d) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_REPETIDA);
  });
  test('proxima_pagina circular ⇒ erro (nunca laço infinito)', async () => {
    const s = servidor(mkItens(250), { ajustaMeta: (m, p) => (p === 2 ? { ...m, proxima_pagina: 1 } : m) });
    const e = await falha(paginarCompleto(cli(s), '/vendas')); expect([CODIGOS.PAGINACAO_CIRCULAR, CODIGOS.PAGINACAO_INCONSISTENTE]).toContain(e.codigo);
  });
  test('proxima_pagina que pula página, inválida ou além de total_paginas ⇒ INCONSISTENTE', async () => {
    for (const ajust of [m => ({ ...m, proxima_pagina: 3 }), m => ({ ...m, proxima_pagina: 'x' }), m => ({ ...m, proxima_pagina: 2, total_paginas: 1 })]) {
      const s = servidor(mkItens(250), { ajustaMeta: (m, p) => (p === 1 ? ajust(m) : m) });
      expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
    }
  });
  test('total_registros mudando durante a leitura, total_paginas incoerente e pagina_atual errada ⇒ INCONSISTENTE', async () => {
    let s = servidor(mkItens(250), { ajustaMeta: (m, p) => (p === 2 ? { ...m, total_registros: 251 } : m) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
    s = servidor(mkItens(250), { ajustaMeta: m => ({ ...m, total_paginas: 7 }) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
    s = servidor(mkItens(250), { ajustaMeta: (m, p) => (p === 2 ? { ...m, pagina_atual: 1 } : m) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
  });
  test('únicos maiores que o total ⇒ INCONSISTENTE; sem total_registros ⇒ PAGINACAO_SEM_TOTAL (a menos que permitido)', async () => {
    let s = servidor(mkItens(150), { totalDeclarado: 149, ajustaMeta: m => ({ ...m, total_paginas: 2 }) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
    s = servidor(mkItens(50), { ajustaMeta: m => ({ ...m, total_registros: null, total_paginas: null }) });
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.PAGINACAO_SEM_TOTAL);
    s = servidor(mkItens(50), { ajustaMeta: m => ({ ...m, total_registros: null, total_paginas: null }) });
    expect((await paginarCompleto(cli(s), '/vendas', {}, { exigirTotal: false })).itens).toHaveLength(50);
  });
  test('registro sem id ⇒ erro', async () => {
    const s = servidor([{ id: '1' }, { nome: 'sem id' }]);
    expect((await falha(paginarCompleto(cli(s), '/vendas'))).codigo).toBe(CODIGOS.RESPOSTA_INESPERADA);
  });
  test('PROPRIEDADE: falha injetada em QUALQUER página e de QUALQUER tipo ⇒ sempre erro, nunca lista parcial', async () => {
    const tipos = { http429: () => resp(429, {}, { 'retry-after': '1' }), http500: () => resp(500, {}), http403: () => resp(403, {}), estruturaInvalida: () => resp(200, { code: 200, status: 'success', dados: [] }), semMeta: () => resp(200, { code: 200, status: 'success', data: [{ id: 'x' }] }) };
    for (const pagina of [1, 2, 3, 4]) for (const [nome, f] of Object.entries(tipos)) {
      const s = servidor(mkItens(350), { falhas: { [pagina]: f } });
      let devolveu = null; let erro = null;
      try { devolveu = await paginarCompleto(cli(s), '/vendas'); } catch (e) { erro = e; }
      expect({ pagina, nome, devolveuLista: devolveu !== null }).toEqual({ pagina, nome, devolveuLista: false });
      expect(erro).toBeInstanceOf(GcErro);
    }
  });
});

describe('paginarCompleto — vazio legítimo × falha (A1 #7)', () => {
  test('resposta vazia REAL (total nulo, proxima nula) com permitirVazio ⇒ vazio legítimo', async () => {
    const r = await paginarCompleto(cli({ transporte: async () => VAZIA() }), '/vendas', { data_modificado_inicio: '2030-01-01' }, { permitirVazio: true });
    expect(r).toMatchObject({ itens: [], vazio: true, total: 0 });
  });
  test('resposta vazia SEM permitirVazio ⇒ GC_VAZIO_INESPERADO (zero não é esperado)', async () => {
    expect((await falha(paginarCompleto(cli({ transporte: async () => VAZIA() }), '/vendas'))).codigo).toBe(CODIGOS.VAZIO_INESPERADO);
  });
  test('"vazio" com total_registros > 0, ou com proxima_pagina, ou com estrutura inválida ⇒ NÃO é vazio legítimo', async () => {
    const mk = (m, extra = {}) => ({ transporte: async () => resp(200, { code: 200, status: 'success', meta: { pagina_atual: 1, limite_por_pagina: 100, ...m }, data: [], ...extra }) });
    expect((await falha(paginarCompleto(cli(mk({ total_registros: 118, total_paginas: 2, proxima_pagina: null })), '/vendas', {}, { permitirVazio: true }))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
    expect((await falha(paginarCompleto(cli(mk({ total_registros: null, proxima_pagina: 2 })), '/vendas', {}, { permitirVazio: true }))).codigo).toBe(CODIGOS.PAGINACAO_INCONSISTENTE);
    expect((await falha(paginarCompleto(cli({ transporte: async () => resp(200, { code: 200, status: 'success', dados: [] }) }), '/vendas', {}, { permitirVazio: true }))).codigo).toBe(CODIGOS.RESPOSTA_INESPERADA);
    expect((await falha(paginarCompleto(cli({ transporte: async () => resp(500, {}) }), '/vendas', {}, { permitirVazio: true }))).codigo).toBe('GC_HTTP_500');
  });
});

describe('paginarCompleto — limites que ABORTAM e nunca truncam (A1 #4)', () => {
  test('total_paginas acima de maxPaginas ⇒ aborta ANTES de ler as demais páginas', async () => {
    const s = servidor(mkItens(1000)); const e = await falha(paginarCompleto(cli(s), '/vendas', {}, { maxPaginas: 5 }));
    expect(e.codigo).toBe(CODIGOS.LIMITE_PAGINAS); expect(s.chamadas).toEqual([1]);
  });
  test('maxPaginas sem total_paginas informado ⇒ aborta ao exceder, sem devolver o que leu', async () => {
    const s = servidor(mkItens(1000), { ajustaMeta: m => ({ ...m, total_paginas: null }) });
    const e = await falha(paginarCompleto(cli(s), '/vendas', {}, { maxPaginas: 3 })); expect(e.codigo).toBe(CODIGOS.LIMITE_PAGINAS);
  });
  test('maxLinhas: aborta quando total_registros já excede; e quando o acumulado excede', async () => {
    let e = await falha(paginarCompleto(cli(servidor(mkItens(500))), '/vendas', {}, { maxLinhas: 300 })); expect(e.codigo).toBe(CODIGOS.LIMITE_LINHAS);
    const s = servidor(mkItens(500), { ajustaMeta: m => ({ ...m, total_registros: 150, total_paginas: 2 }) });
    e = await falha(paginarCompleto(cli(s), '/vendas', {}, { maxLinhas: 150 }));
    expect([CODIGOS.LIMITE_LINHAS, CODIGOS.PAGINACAO_INCONSISTENTE]).toContain(e.codigo);
  });
  test('exatamente no limite NÃO aborta', async () => {
    const r = await paginarCompleto(cli(servidor(mkItens(300))), '/vendas', {}, { maxPaginas: 3, maxLinhas: 300 }); expect(r.itens).toHaveLength(300);
  });
});

describe('helpers puros', () => {
  test('verificarFiltroModificacao — filtro honrado × IGNORADO (A1 #5)', () => {
    const ok = [{ modificado_em: '2026-11-20 00:00:00' }, { modificado_em: '2026-11-22 10:00:00' }];
    expect(verificarFiltroModificacao(ok, { pisoDia: '2026-11-20' })).toMatchObject({ honrado: true, filtroIgnorado: false, violacoes: 0 });
    const ignorado = [{ modificado_em: '2022-03-24 10:00:00' }, ...ok];
    expect(verificarFiltroModificacao(ignorado, { pisoDia: '2026-11-20' })).toMatchObject({ honrado: false, filtroIgnorado: true, violacoes: 1, primeiraViolacaoDia: '2022-03-24' });
    expect(verificarFiltroModificacao([{ id: 1 }], { pisoDia: '2026-11-20' })).toMatchObject({ semCampo: 1, violacoes: 0 });
    expect(() => verificarFiltroModificacao([], { pisoDia: 'ontem' })).toThrow();
  });
  test('avaliarPublicacao — queda > 70% ou vazio com dado anterior bloqueia (A1 #7/#8); limites atuais preservados', () => {
    expect(avaliarPublicacao({ novo: 0, anterior: 118 })).toMatchObject({ publicar: false, motivo: 'VAZIO_COM_DADOS_ANTERIORES' });
    expect(avaliarPublicacao({ novo: 30, anterior: 118 })).toMatchObject({ publicar: false, motivo: 'QUEDA_ACIMA_DO_LIMITE' });     // queda 74,6%
    expect(avaliarPublicacao({ novo: 36, anterior: 118 }).publicar).toBe(true);                                                     // queda 69,5%
    expect(avaliarPublicacao({ novo: 100, anterior: 118 })).toMatchObject({ publicar: true, motivo: 'OK' });
    expect(avaliarPublicacao({ novo: 500, anterior: 118 }).publicar).toBe(true);
    expect(avaliarPublicacao({ novo: 0, anterior: null })).toMatchObject({ publicar: true, motivo: 'SEM_REFERENCIA_ANTERIOR' });
    expect(avaliarPublicacao({ novo: 0, anterior: 0 }).publicar).toBe(true);
    // limite do Financeiro (0,70) e de Pedidos (0,80) preservados por parâmetro
    expect(avaliarPublicacao({ novo: 25, anterior: 100, limiteQuedaPct: 0.70 }).publicar).toBe(false);   // queda 75%
    expect(avaliarPublicacao({ novo: 25, anterior: 100, limiteQuedaPct: 0.80 }).publicar).toBe(true);    // 75% < 80%
    expect(avaliarPublicacao({ novo: 15, anterior: 100, limiteQuedaPct: 0.80 }).publicar).toBe(false);   // 85% > 80%
    expect(avaliarPublicacao({ novo: NaN, anterior: 10 }).motivo).toBe('VALOR_NOVO_INVALIDO');
    expect(avaliarPublicacao({ novo: -1, anterior: 10 }).publicar).toBe(false);
  });
  test('decidirCursor — só avança com leitura completa, sem erro e escritas confirmadas (A1 #6)', () => {
    const base = { cursorAtual: '2026-11-20 10:00:00', novoCursor: '2026-11-22 09:00:00', leituraCompleta: true, erro: null, escritasConfirmadas: true };
    expect(decidirCursor(base)).toEqual({ cursor: '2026-11-22 09:00:00', avancou: true });
    for (const alt of [{ leituraCompleta: false }, { erro: new Error('x') }, { escritasConfirmadas: false }, { novoCursor: null }, { novoCursor: '' }, { novoCursor: '2026-11-19 00:00:00' }]) {
      expect(decidirCursor({ ...base, ...alt })).toEqual({ cursor: '2026-11-20 10:00:00', avancou: false });
    }
    expect(decidirCursor({ ...base, cursorAtual: null })).toEqual({ cursor: '2026-11-22 09:00:00', avancou: true });
    expect(decidirCursor({ cursorAtual: null, novoCursor: null }).cursor).toBeNull();
  });
});
