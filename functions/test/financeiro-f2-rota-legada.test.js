'use strict';
// FINANCEIRO · rota de compatibilidade: financeiro.html → financeiro-v2.html (query/hash preservados, sem loop, sem poluir o histórico).
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const lerHtml = f => fs.readFileSync(path.join(ROOT, 'modulos', f), 'utf8');
const LEGADA = lerHtml('financeiro.html'), V2 = lerHtml('financeiro-v2.html');
const BASE = 'd6b256f';
const git = c => execSync('git ' + c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let temGit = true; try { git('cat-file -e ' + BASE + '^{commit}'); } catch (_) { temGit = false; }
const dt = temGit ? test : test.skip;

/** Executa o <script> inline da rota legada num "navegador" falso e devolve o que ele fez com location. */
function navegar(urlInicial) {
  const u = new URL(urlInicial); const chamadas = []; const hist = [urlInicial];
  const location = { search: u.search, hash: u.hash, pathname: u.pathname,
    replace: dest => { const d = new URL(dest, urlInicial).href; chamadas.push(['replace', d]); hist[hist.length - 1] = d; },
    assign: dest => { chamadas.push(['assign', dest]); hist.push(new URL(dest, urlInicial).href); }, set href(v) { chamadas.push(['href', v]); hist.push(new URL(v, urlInicial).href); } };
  const src = LEGADA.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(src, { location });
  return { chamadas, hist, destino: chamadas.length ? chamadas[0][1] : null };
}
const BASE_URL = 'https://murilorodrigueslima-maker.github.io/mr4-sistema/modulos/';

describe('redirecionamento', () => {
  test('acesso direto → financeiro-v2.html (mesma pasta)', () => { expect(navegar(BASE_URL + 'financeiro.html').destino).toBe(BASE_URL + 'financeiro-v2.html'); });
  test('query string preservada', () => { expect(navegar(BASE_URL + 'financeiro.html?origem=menu').destino).toBe(BASE_URL + 'financeiro-v2.html?origem=menu'); });
  test('hash preservado', () => { expect(navegar(BASE_URL + 'financeiro.html#receber').destino).toBe(BASE_URL + 'financeiro-v2.html#receber'); });
  test('query + hash preservados, caracteres especiais intactos', () => { expect(navegar(BASE_URL + 'financeiro.html?a=1&b=x%20y#sec-2').destino).toBe(BASE_URL + 'financeiro-v2.html?a=1&b=x%20y#sec-2'); });
  test('uma única navegação, e por replace() (não empilha histórico: botão Voltar não volta para a rota legada)', () => {
    const r = navegar(BASE_URL + 'financeiro.html?x=1#y'); expect(r.chamadas).toHaveLength(1); expect(r.chamadas[0][0]).toBe('replace');
    expect(r.hist).toHaveLength(1); expect(r.hist[0]).toMatch(/financeiro-v2\.html/); expect(r.hist.some(h => /\/financeiro\.html/.test(h))).toBe(false);   // a entrada antiga foi SUBSTITUÍDA
    expect(LEGADA).not.toMatch(/location\.(assign|href\s*=)|history\.pushState/);
  });
  test('fallback sem JavaScript: <noscript> com refresh para o MESMO destino (sem dois destinos conflitantes)', () => {
    const alvo = LEGADA.match(/<noscript><meta http-equiv="refresh" content="0;url=([^"]+)"><\/noscript>/); expect(alvo && alvo[1]).toBe('financeiro-v2.html');
    expect([...LEGADA.matchAll(/financeiro-v2\.html/g)].length).toBeGreaterThanOrEqual(3);          // script, noscript e link manual: todos para o mesmo arquivo
    const outros = [...LEGADA.matchAll(/(?:href|url)=["']?([^"' >;]+\.html)/g)].map(m => m[1]).filter(x => x !== 'financeiro-v2.html'); expect(outros).toEqual([]);
  });
});

describe('sem loop', () => {
  test('a rota legada não aponta para si mesma; o destino não referencia nem redireciona de volta', () => {
    expect(LEGADA.replace(/financeiro-v2\.html/g, '')).not.toMatch(/financeiro\.html/);
    expect(V2).not.toMatch(/financeiro\.html/); expect(V2).not.toMatch(/location\.(replace|assign)\s*\(\s*['"][^'"]*financeiro/); expect(V2).not.toMatch(/http-equiv="refresh"/);
    const v2view = fs.readFileSync(path.join(ROOT, 'modulos/financeiro-view.js'), 'utf8'); expect(v2view).not.toMatch(/financeiro\.html/);
  });
  test('simulação: legado → v2 e para (REDIRECT_LOOP=NO); o v2 não tem redirecionamento para a rota legada', () => {
    const r = navegar(BASE_URL + 'financeiro.html'); expect(new URL(r.destino).pathname.endsWith('/financeiro-v2.html')).toBe(true);
    const v2Redireciona = /location\.(replace|assign)|location\.href\s*=/.test(V2.replace(/location\.href\s*=\s*'\.\.\/login\.html'/g, ''));
    expect(v2Redireciona).toBe(false);                     // só o redirecionamento de login (../login.html) existe no v2
  });
});

describe('destino existe e carrega', () => {
  test('financeiro-v2.html existe, tem título, carrega a lógica pela versão no endereço e o arquivo da lógica existe', () => {
    expect(V2).toMatch(/<title>Financeiro — MR4<\/title>/);
    const src = V2.match(/<script src="(financeiro-view\.js)\?v=\w+"><\/script>/); expect(src).not.toBeNull(); expect(fs.existsSync(path.join(ROOT, 'modulos', src[1]))).toBe(true);
  });
  test('o destino do script legado resolve para um arquivo que existe no repositório', () => { expect(fs.existsSync(path.join(ROOT, 'modulos', new URL(navegar(BASE_URL + 'financeiro.html').destino).pathname.split('/').pop()))).toBe(true); });
});

describe('links antigos (caixa, estoque, vendas) continuam intocados e chegam ao v2', () => {
  test.each(['caixa.html', 'estoque.html', 'vendas.html'])('%s: link para financeiro.html leva ao v2 (caixa e vendas, byte a byte iguais ao main aprovado; estoque.html foi alterado depois, por autorização: UI do agente e filtros da Fase A)', f => {
    if (temGit && f !== 'estoque.html') expect(git(`diff ${BASE} -- modulos/${f}`)).toBe('');
    const html = lerHtml(f); const links = [...html.matchAll(/<a[^>]*href="(\.?\/?financeiro\.html)"/g)].map(m => m[1]); expect(links.length).toBeGreaterThanOrEqual(1);
    for (const l of links) { const resolvido = new URL(l, BASE_URL + f).href; expect(resolvido).toBe(BASE_URL + 'financeiro.html'); expect(navegar(resolvido).destino).toBe(BASE_URL + 'financeiro-v2.html'); }
  });
});

dt('escopo: caixa e vendas não aparecem no diff contra o main aprovado', () => {
  const lista = git(`diff --name-only ${BASE}`).split('\n').filter(Boolean);
  for (const f of ['modulos/caixa.html', 'modulos/vendas.html']) expect(lista).not.toContain(f);   // estoque.html saiu desta lista: alterado depois por autorização (agente e Fase A de filtros)
});
