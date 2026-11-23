'use strict';
/**
 * Etapa A · A1 — INTEGRIDADE do scripts/sync-dados.js REAL, com GestãoClick e Firestore SIMULADOS (sem rede, sem credenciais).
 *
 * Estratégia "tests-first": cada falha real da API é reproduzida no harness (fixtures/sync-harness.js, novos modos).
 *   • "precondição"/"CARACTERIZAÇÃO": documentam, em testes que PASSAM hoje, o que o código ATUAL faz (o defeito).
 *   • "DESEJADO": o comportamento aprovado (nenhuma escrita nos caches, documentos anteriores intactos, execução com erro).
 *     Estes usam `test.failing`: PASSAM enquanto o defeito existe (provam que o teste o detecta) e viram FALHA vermelha
 *     quando a sub-etapa A2 corrigir — obrigando a converter em teste normal. Para VER o defeito (asserções vermelhas):
 *         VER_DEFEITOS=1 npx jest test/sync-dados-integridade.test.js
 *   • "PROTEÇÕES ATUAIS": limites que JÁ funcionam (Pedidos 80%, Financeiro 70%) e devem ser PRESERVADOS pela A2.
 *
 * Nenhum código de produção é alterado por este arquivo.
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
jest.setTimeout(240000);

const ROOT = path.resolve(__dirname, '../..');
const HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
const defeito = process.env.VER_DEFEITOS === '1' ? test : test.failing;

const PREVIO = () => ({
  painel_cache: {
    vendas: { atualizado_em: 'ANTERIOR', hoje: 999, semana: 5000, mes: 90000, meta_mes: 200000, meta_dia: 8000, meta_semana: 40000, vendedores: [{ nome: 'X', faturamento: 90000, pedidos: 100, ticket_medio: 900 }] },
    caixa: { atualizado_em: 'ANTERIOR', hoje: 999 },
  },
  display_metrics: { latest: { atualizado_em: 'ANTERIOR', faturamento_mes: 90000, vendedores: [] } },
  pedidos_cache: { latest: { atualizado_em: 'ANTERIOR', total: 10, pedidos: [], _meta: { pedidosTotal: 10 } } },
  financeiro_cache: { latest: { atualizado_em: 'ANTERIOR', _meta: { lancamentosTotal: 10 } } },
});

function rodar(modo, estado = PREVIO()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-sync-'));
  const st = path.join(dir, 'state.json'), out = path.join(dir, 'out.json');
  fs.writeFileSync(st, JSON.stringify(estado));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], {
    cwd: ROOT, timeout: 90000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '' },
  });
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { ...res, exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
}
const CACHES_DE_VENDAS = /^(painel_cache\/(vendas|caixa)|display_metrics\/latest)$/;
const escritasDeVendas = r => r.writes.filter(w => CACHES_DE_VENDAS.test(w));
const pagina = (r, p) => r.gcCalls.some(c => c.path === '/vendas' && c.pagina === p);

/** Comportamento DESEJADO (aprovado): falha/incerteza ⇒ nada é publicado, anterior preservado, execução com status de erro. */
function esperaPreservacao(r) {
  expect(escritasDeVendas(r)).toEqual([]);
  expect(r.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas);
  expect(r.state.painel_cache.caixa).toEqual(PREVIO().painel_cache.caixa);
  expect(r.state.display_metrics.latest).toEqual(PREVIO().display_metrics.latest);
  expect(r.exitCode).not.toBe(0);
}

describe('A1 #1 — HTTP 429 durante a paginação de /vendas', () => {
  let r; beforeAll(() => { r = rodar('vendas_pag2_429'); });
  test('precondição: a página 2 foi pedida e respondeu 429 (corpo JSON de erro); credenciais só para o GC', () => {
    expect(pagina(r, 1)).toBe(true); expect(pagina(r, 2)).toBe(true);
    expect(r.gcCalls.every(c => c.host === 'api.gestaoclick.com' && c.temCredencial)).toBe(true);
  });
  test('CARACTERIZAÇÃO (defeito atual): 4 de 8 vendas são publicadas como se fossem o resultado completo; execução termina com sucesso', () => {
    expect(r.writes).toContain('painel_cache/vendas'); expect(r.state.painel_cache.vendas.hoje).toBe(1750); expect(r.exitCode).toBe(0);
    expect(r.log).not.toMatch(/429|Too many|erro|Erro/i);
  });
  defeito('DESEJADO: 429 na paginação ⇒ nenhuma escrita, caches anteriores intactos, execução com erro', () => esperaPreservacao(r));
});

describe('A1 #2 — HTTP 500 durante a paginação de /vendas', () => {
  let r; beforeAll(() => { r = rodar('vendas_pag2_500'); });
  test('precondição: a página 2 foi pedida', () => { expect(pagina(r, 2)).toBe(true); });
  test('CARACTERIZAÇÃO (defeito atual): resultado parcial publicado em silêncio', () => {
    expect(r.writes).toContain('painel_cache/vendas'); expect(r.state.painel_cache.vendas.hoje).toBe(1750); expect(r.exitCode).toBe(0);
  });
  defeito('DESEJADO: 500 na paginação ⇒ nenhuma escrita, caches anteriores intactos, execução com erro', () => esperaPreservacao(r));
});

describe('A1 #3 — HTTP 200 com estrutura inválida (chave "dados" no lugar de "data")', () => {
  let r; beforeAll(() => { r = rodar('vendas_estrutura_invalida'); });
  test('precondição: /vendas foi consultada e respondeu 200', () => { expect(pagina(r, 1)).toBe(true); });
  test('CARACTERIZAÇÃO (defeito atual): ZEROS são publicados por cima do último valor válido (hoje 999 / mês 90.000 ⇒ 0 / 0)', () => {
    expect(r.writes).toContain('painel_cache/vendas'); expect(r.state.painel_cache.vendas.hoje).toBe(0); expect(r.state.painel_cache.vendas.mes).toBe(0);
    expect(r.state.display_metrics.latest.atualizado_em).not.toBe('ANTERIOR'); expect(r.exitCode).toBe(0);
  });
  defeito('DESEJADO: estrutura inválida ⇒ nenhuma escrita, caches anteriores intactos, execução com erro', () => esperaPreservacao(r));
});

describe('A1 #4 — paginação incompleta (total_registros 12, entregues 8)', () => {
  let r; beforeAll(() => { r = rodar('vendas_pag_incompleta'); });
  test('precondição: as 3 páginas foram lidas (a 3ª veio vazia)', () => { expect(pagina(r, 1) && pagina(r, 2) && pagina(r, 3)).toBe(true); });
  test('CARACTERIZAÇÃO (defeito atual): 8 de 12 vendas publicadas como completas; ninguém confere total_registros', () => {
    expect(r.state.painel_cache.vendas.hoje).toBe(2150); expect(r.state.pedidos_cache.latest.total).toBe(8); expect(r.exitCode).toBe(0);
  });
  defeito('DESEJADO: paginação incompleta ⇒ nenhuma escrita, caches anteriores intactos, execução com erro', () => esperaPreservacao(r));
});

describe('A1 #7 — resultado VAZIO inesperado (HTTP 200, formato real de resposta vazia) com dados anteriores relevantes', () => {
  let r; beforeAll(() => { r = rodar('vendas_vazio'); });
  test('precondição: /vendas respondeu vazio e havia documento anterior com mês R$ 90.000', () => { expect(pagina(r, 1)).toBe(true); expect(PREVIO().painel_cache.vendas.mes).toBe(90000); });
  test('CARACTERIZAÇÃO (defeito atual): vendas e display_metrics são SUBSTITUÍDOS por zeros (sem proteção de anomalia nesse bloco)', () => {
    expect(r.state.painel_cache.vendas.hoje).toBe(0); expect(r.state.painel_cache.vendas.mes).toBe(0); expect(r.exitCode).toBe(0);
  });
  defeito('DESEJADO: vazio com dado anterior relevante ⇒ NÃO substitui; bloqueia a publicação e gera alerta (execução com erro)', () => esperaPreservacao(r));
});

describe('A1 #8 — queda anormal de volume (90.000 ⇒ 1.000; queda > 98%)', () => {
  let r; beforeAll(() => { r = rodar('vendas_queda'); });
  test('precondição: /vendas devolveu 1 venda válida (total_registros 1)', () => { expect(pagina(r, 1)).toBe(true); });
  test('CARACTERIZAÇÃO (defeito atual): o bloco de vendas publica a queda sem alerta', () => {
    expect(r.state.painel_cache.vendas.mes).toBe(1000); expect(r.exitCode).toBe(0);
  });
  test('PROTEÇÃO ATUAL (deve ser preservada): Pedidos detecta a queda (10 ⇒ 1) e PRESERVA pedidos_cache/latest', () => {
    expect(r.writes).not.toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest.atualizado_em).toBe('ANTERIOR'); expect(r.log).toMatch(/pedidos_cache\/latest preservado/);
  });
  defeito('DESEJADO: queda > 70% em vendas ⇒ bloqueia a publicação, preserva o anterior e gera alerta (execução com erro)', () => esperaPreservacao(r));
});

describe('PROTEÇÕES ATUAIS que a A2 deve PRESERVAR — limites de anomalia de Pedidos (80%) e Financeiro (70%)', () => {
  const comPedidos = n => { const e = PREVIO(); e.pedidos_cache.latest._meta.pedidosTotal = n; return e; };
  const comFinanceiro = n => { const e = PREVIO(); e.financeiro_cache.latest._meta.lancamentosTotal = n; return e; };
  test('Pedidos (4 pedidos novos): anterior 10 ⇒ queda 60% ⇒ GRAVA', () => { const r = rodar('ok', comPedidos(10)); expect(r.writes).toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest.total).toBe(4); });
  test('Pedidos: anterior 20 ⇒ queda de exatamente 80% (não passa do limite) ⇒ GRAVA', () => { const r = rodar('ok', comPedidos(20)); expect(r.writes).toContain('pedidos_cache/latest'); });
  test('Pedidos: anterior 25 ⇒ queda 84% > 80% ⇒ PRESERVA', () => { const r = rodar('ok', comPedidos(25)); expect(r.writes).not.toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest.atualizado_em).toBe('ANTERIOR'); });
  test('Pedidos: sem documento anterior ⇒ GRAVA', () => { const e = PREVIO(); delete e.pedidos_cache; const r = rodar('ok', e); expect(r.writes).toContain('pedidos_cache/latest'); });
  test('Financeiro (1 lançamento): anterior 3 ⇒ queda 66,7% ⇒ GRAVA', () => { const r = rodar('pagamentos_queda', comFinanceiro(3)); expect(r.writes).toContain('financeiro_cache/latest'); });
  test('Financeiro: anterior 4 ⇒ queda 75% > 70% ⇒ PRESERVA', () => { const r = rodar('pagamentos_queda', comFinanceiro(4)); expect(r.writes).not.toContain('financeiro_cache/latest'); expect(r.state.financeiro_cache.latest.atualizado_em).toBe('ANTERIOR'); });
  test('Financeiro: anterior 10 ⇒ queda 90% ⇒ PRESERVA; log registra a anomalia', () => { const r = rodar('pagamentos_queda', comFinanceiro(10)); expect(r.writes).not.toContain('financeiro_cache/latest'); expect(r.log).toMatch(/financeiro_cache\/latest preservado/); });
  test('modo "falha" (GestãoClick fora do ar) continua preservando os caches (regressão do teste existente)', () => {
    const r = rodar('falha'); expect(r.writes.filter(w => /^(painel_cache|display_metrics)\//.test(w))).toEqual([]);
  });
});
