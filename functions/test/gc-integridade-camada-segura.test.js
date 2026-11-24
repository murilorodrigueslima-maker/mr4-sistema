'use strict';
/**
 * Etapa A · A1 — MATRIZ das 8 situações aplicada à CAMADA SEGURA (gcHttp), com a comparação lado a lado com o CÓDIGO ATUAL.
 *   1 HTTP 429 durante paginação · 2 HTTP 500 durante paginação · 3 HTTP 200 com estrutura inválida · 4 paginação incompleta
 *   5 filtro ignorado pela API · 6 cursor avançando indevidamente · 7 resultado vazio inesperado · 8 queda anormal de volume
 * Os mesmos cenários são reproduzidos contra o código atual em sync-dados-integridade.test.js e sync360-integridade.test.js
 * (onde expõem o defeito). Aqui mostramos que a camada segura OFERECE a proteção prevista. A camada ainda NÃO está ligada.
 */
const G = require('../lib/gcHttp');
const { fetchAllPagesByProximaPagina } = require('../lib/sync360');
const { criarCliente, paginarCompleto, verificarFiltroModificacao, avaliarPublicacao, decidirCursor, CODIGOS } = G;

const fmt = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const resp = (status, corpo, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: k => headers[String(k).toLowerCase()] ?? null }, json: async () => corpo });
const itens = (n, ini = 1) => Array.from({ length: n }, (_, i) => ({ id: String(ini + i), modificado_em: fmt(Date.UTC(2026, 10, 20, 10, 0, 0) + i * 60000) }));
const VAZIA = { code: 200, status: 'success', meta: { total_registros: null, total_paginas: null, total_registros_pagina: null, pagina_atual: 1, limite_por_pagina: 100, pagina_anterior: null, url_anterior: null, proxima_pagina: null, proxima_url: null }, data: [], error: '', message: '' };

/** servidor de páginas: `total` declarado, `entrega` = itens realmente entregues; `falha` por página */
function api({ total = 118, entrega = total, falha = {}, estrutura = null, vazio = false } = {}) {
  const todos = itens(entrega); const chamadas = [];
  const transporte = async url => {
    const u = new URL(url); const p = Number(u.searchParams.get('pagina') || 1); chamadas.push(p);
    if (vazio) return resp(200, VAZIA);
    if (falha[p]) return falha[p]();
    if (estrutura) return resp(200, estrutura);
    const tp = Math.ceil(total / 100); const data = todos.slice((p - 1) * 100, p * 100);
    return resp(200, { code: 200, status: 'success', meta: { total_registros: total, total_paginas: tp, pagina_atual: p, limite_por_pagina: 100, proxima_pagina: p < tp ? p + 1 : null }, data });
  };
  return { transporte, chamadas, todos };
}
const cli = a => criarCliente({ transporte: a.transporte, credenciais: { access: 'a', secret: 'b' }, dormir: async () => {} });
const erroDe = async p => { try { await p; } catch (e) { return e; } return null; };

/** O "bloco de cache" que a A2 montará com a camada segura: lê completo → avalia publicação → só então publica. */
async function blocoSeguro({ a, anterior, limiteQuedaPct = 0.70, permitirVazio = false }) {
  let r; try { r = await paginarCompleto(cli(a), '/vendas', { loja_id: '262759' }, { permitirVazio }); } catch (e) { return { publicado: false, motivo: e.codigo }; }
  const av = avaliarPublicacao({ novo: r.itens.length, anterior, limiteQuedaPct });
  return av.publicar ? { publicado: true, linhas: r.itens.length } : { publicado: false, motivo: av.motivo };
}

describe('MATRIZ — camada segura × situações A1 #1–#8 (nenhuma publica resultado inválido)', () => {
  test('controle: leitura completa e válida (118 vendas, anterior 100) ⇒ PUBLICA', async () => {
    expect(await blocoSeguro({ a: api(), anterior: 100 })).toEqual({ publicado: true, linhas: 118 });
  });
  test('#1 HTTP 429 na página 2 (Retry-After 1 s) ⇒ não publica; no máximo 3 tentativas na página 2', async () => {
    const a = api({ total: 250, falha: { 2: () => resp(429, { code: 429 }, { 'retry-after': '1' }) } });
    expect(await blocoSeguro({ a, anterior: 100 })).toEqual({ publicado: false, motivo: CODIGOS.R429_ESGOTADO });
    expect(a.chamadas.filter(p => p === 2)).toHaveLength(3);
  });
  test('#2 HTTP 500 na página 2 ⇒ não publica', async () => {
    const a = api({ total: 250, falha: { 2: () => resp(500, { code: 500 }) } });
    expect(await blocoSeguro({ a, anterior: 100 })).toEqual({ publicado: false, motivo: 'GC_HTTP_500' });
  });
  test('#3 HTTP 200 com estrutura inválida ("dados") ⇒ não publica (hoje o código publica ZEROS)', async () => {
    const a = api({ estrutura: { code: 200, status: 'success', dados: [{ id: '1' }], meta: { total_registros: 1, total_paginas: 1 } } });
    expect(await blocoSeguro({ a, anterior: 100 })).toEqual({ publicado: false, motivo: CODIGOS.RESPOSTA_INESPERADA });
  });
  test('#4 paginação incompleta (total 12, entrega 8 em 1 página) ⇒ não publica', async () => {
    const a = api({ total: 12, entrega: 8 });
    expect(await blocoSeguro({ a, anterior: 100 })).toEqual({ publicado: false, motivo: CODIGOS.PAGINACAO_INCOMPLETA });
  });
  test('#7 resultado vazio (HTTP 200, formato real) com dado anterior ⇒ não publica; sem permitirVazio é erro, com permitirVazio é bloqueado pela avaliação', async () => {
    expect(await blocoSeguro({ a: api({ vazio: true }), anterior: 118 })).toEqual({ publicado: false, motivo: CODIGOS.VAZIO_INESPERADO });
    expect(await blocoSeguro({ a: api({ vazio: true }), anterior: 118, permitirVazio: true })).toEqual({ publicado: false, motivo: 'VAZIO_COM_DADOS_ANTERIORES' });
  });
  test('#7 vazio legítimo SEM dado anterior relevante pode ser aceito (distingue falha de vazio)', async () => {
    expect(await blocoSeguro({ a: api({ vazio: true }), anterior: null, permitirVazio: true })).toEqual({ publicado: true, linhas: 0 });
  });
  test('#8 queda anormal (118 ⇒ 30; queda 74,6% > 70%) ⇒ não publica; 118 ⇒ 36 (69,5%) publica', async () => {
    expect(await blocoSeguro({ a: api({ total: 30 }), anterior: 118 })).toEqual({ publicado: false, motivo: 'QUEDA_ACIMA_DO_LIMITE' });
    expect(await blocoSeguro({ a: api({ total: 36 }), anterior: 118 })).toEqual({ publicado: true, linhas: 36 });
  });
  test('#8 limites ATUAIS preservados por parâmetro: Pedidos 80% e Financeiro 70%', async () => {
    expect((await blocoSeguro({ a: api({ total: 25 }), anterior: 100, limiteQuedaPct: 0.80 })).publicado).toBe(true);    // queda 75% < 80%
    expect((await blocoSeguro({ a: api({ total: 15 }), anterior: 100, limiteQuedaPct: 0.80 })).publicado).toBe(false);   // 85% > 80%
    expect((await blocoSeguro({ a: api({ total: 25 }), anterior: 100, limiteQuedaPct: 0.70 })).publicado).toBe(false);   // 75% > 70%
  });
});

describe('MATRIZ #5 — filtro ignorado: o detector puro identifica; o código atual não', () => {
  const historico = itens(450).reverse();                      // histórico inteiro devolvido (inclui registros muito antigos)
  test('filtro IGNORADO ⇒ violações detectadas (linhas anteriores ao dia pedido)', () => {
    const v = verificarFiltroModificacao(historico.map((x, i) => ({ ...x, modificado_em: i < 20 ? x.modificado_em : '2022-03-24 10:00:00' })), { pisoDia: '2026-11-20' });
    expect(v).toMatchObject({ honrado: false, filtroIgnorado: true }); expect(v.violacoes).toBe(430);
  });
  test('filtro HONRADO ⇒ sem violações', () => {
    expect(verificarFiltroModificacao(itens(37), { pisoDia: '2026-11-20' })).toMatchObject({ honrado: true, violacoes: 0 });
  });
  test('o canário (data futura devolvendo registros) é detectado pelo mesmo helper', () => {
    expect(verificarFiltroModificacao(itens(3), { pisoDia: '2030-01-01' }).filtroIgnorado).toBe(true);
  });
});

describe('MATRIZ #6 — cursor: a camada segura só o avança com leitura completa, sem erro e escritas confirmadas', () => {
  const cursorAtual = '2026-11-20 10:00:00', novoCursor = '2026-11-22 09:00:00';
  test('leitura parcial (erro na página 2) ⇒ cursor INALTERADO; o código atual avançaria', async () => {
    const a = api({ total: 250, falha: { 2: () => resp(429, {}, { 'retry-after': '1' }) } });
    const erro = await erroDe(paginarCompleto(cli(a), '/vendas', {}));
    expect(erro).not.toBeNull();
    expect(decidirCursor({ cursorAtual, novoCursor, leituraCompleta: false, erro, escritasConfirmadas: false })).toEqual({ cursor: cursorAtual, avancou: false });
  });
  test('leitura completa mas escrita falhou ⇒ cursor inalterado; tudo confirmado ⇒ avança', () => {
    expect(decidirCursor({ cursorAtual, novoCursor, leituraCompleta: true, erro: null, escritasConfirmadas: false }).avancou).toBe(false);
    expect(decidirCursor({ cursorAtual, novoCursor, leituraCompleta: true, erro: null, escritasConfirmadas: true })).toEqual({ cursor: novoCursor, avancou: true });
  });
});

describe('LADO A LADO — mesma resposta com falha na página 2: código ATUAL × camada segura', () => {
  test('ATUAL devolve 100 de 150 em silêncio; SEGURA lança erro e não devolve nada', async () => {
    const todos = itens(150); let atualChamadas = 0;
    const gcAtual = async (endpoint, params) => { atualChamadas++; return params.pagina === 1 || params.pagina === undefined ? { data: todos.slice(0, 100), meta: { proxima_pagina: 2, total_registros: 150, total_paginas: 2 } } : { data: [], meta: {} }; };   // wrapper engole o erro
    const atual = await fetchAllPagesByProximaPagina(gcAtual, '/vendas', {});
    expect(atual).toHaveLength(100);                                                      // ← defeito: parcial tratado como completo
    const a = api({ total: 150, falha: { 2: () => resp(500, { code: 500 }) } });
    const erro = await erroDe(paginarCompleto(cli(a), '/vendas', {}));
    expect(erro).toBeInstanceOf(G.GcErro); expect(erro.codigo).toBe('GC_HTTP_500');
  });
  test('ATUAL: resposta vazia com HTTP de erro vira lista vazia; SEGURA: erro explícito', async () => {
    const atualVazio = async () => ({ data: [], meta: {} });                              // wrapper atual diante de {code:429,status:'error'}
    expect(await fetchAllPagesByProximaPagina(atualVazio, '/vendas', {})).toEqual([]);    // ← defeito: "nenhuma venda"
    const erro = await erroDe(paginarCompleto(cli({ transporte: async () => resp(429, { code: 429, status: 'error' }, { 'retry-after': '1' }) }), '/vendas', {}));
    expect(erro.codigo).toBe(CODIGOS.R429_ESGOTADO);
  });
});

describe('Conexão da camada segura: SÓ o scripts/sync-dados.js (A2); os demais fluxos continuam fora (A3, A4, B, C)', () => {
  const fs = require('fs'), path = require('path'); const raiz = path.resolve(__dirname, '../..');
  const le = f => fs.readFileSync(path.join(raiz, f), 'utf8');
  test('scripts/sync-dados.js usa gcHttp (A2)', () => { expect(/require\('\.\.\/functions\/lib\/gcHttp'\)/.test(le('scripts/sync-dados.js'))).toBe(true); });
  test('nenhum OUTRO arquivo de produção referencia gcHttp', () => {
    const alvos = ['functions/index.js', 'scripts/incremental360.js', 'scripts/bootstrap360.js', 'functions/lib/sync360.js', 'functions/lib/painelSync.js', 'functions/lib/expedicao/sync.js', 'functions/lib/financeiro/fetch.js', 'functions/lib/compras/fetch.js'];
    for (const f of alvos) expect({ f, usa: /gcHttp/.test(le(f)) }).toEqual({ f, usa: false });
  });
});
