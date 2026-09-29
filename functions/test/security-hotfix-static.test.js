'use strict';
// MR4 SECURITY HOTFIX P0 — verificações estáticas do estado final (sem rede, sem produção).
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const ler = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Todos os arquivos servidos/executados em runtime (Pages + scripts), exceto node_modules, testes e artefatos
function arquivosRuntime(dir = ROOT, out = []) {
  for (const nome of fs.readdirSync(dir)) {
    if (['node_modules', '.git', 'artifacts', 'test', 'docs', '.tools'].includes(nome)) continue;
    const p = path.join(dir, nome), st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) arquivosRuntime(p, out);
    else if (/\.(html|js|mjs|json|yml|yaml|toml)$/.test(nome)) out.push(p);
  }
  return out;
}
const JSONS = /data\/(vendas|estoque|produtos)\.json/;

describe('ACTIVE_RUNTIME_REFERENCES=0', () => {
  test('nenhum arquivo de runtime carrega data/vendas.json, data/estoque.json ou data/produtos.json', () => {
    const achados = [];
    for (const f of arquivosRuntime()) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
        if (!JSONS.test(l)) return;
        if (/^\s*(\/\/|\*|#|<!--)/.test(l) || /SECURITY HOTFIX P0/.test(l)) return;   // comentário documental
        achados.push(path.relative(ROOT, f) + ':' + (i + 1));
      });
    }
    expect(achados).toEqual([]);
  });
  test('os três arquivos públicos não existem mais no diretório servido', () => {
    for (const f of ['vendas', 'estoque', 'produtos']) expect(fs.existsSync(path.join(ROOT, 'data', f + '.json'))).toBe(false);
  });
  test('nenhuma URL pública alternativa (github.io/raw) entrega os mesmos dados', () => {
    for (const f of arquivosRuntime()) {
      const s = fs.readFileSync(f, 'utf8');
      expect(/raw\.githubusercontent\.com[^'"\s]*data\//.test(s) || /github\.io\/mr4-sistema\/data\//.test(s)).toBe(false);
    }
  });
});

describe('Telas leem somente a fonte protegida', () => {
  test('vendas.html → painel_cache/vendas', () => {
    const s = ler('modulos/vendas.html');
    expect(s).toMatch(/getDoc\(doc\(db, 'painel_cache', 'vendas'\)\)/);
    expect(s).not.toMatch(/fetch\(/);
  });
  test('caixa.html → painel_cache/caixa (só o faturamento do dia)', () => {
    const s = ler('modulos/caixa.html');
    expect(s).toMatch(/getDoc\(doc\(db, 'painel_cache', 'caixa'\)\)/);
    expect(s).not.toMatch(/fetch\('\.\.\/data/);
  });
  test('estoque.html → painel_cache/estoque + estoque_custos (restrito tratado) + produtos_catalogo', () => {
    const s = ler('modulos/estoque.html');
    expect(s).toMatch(/'painel_cache', 'estoque'\)/);
    expect(s).toMatch(/'painel_cache', 'estoque_custos'\)/);
    expect(s).toMatch(/'painel_cache', 'produtos_catalogo'\)/);
    expect(s).toMatch(/custosRestritos \? 'Restrito'/);
    expect(s).not.toMatch(/fetch\('\.\.\/data/);
  });
});

describe('Gerador e workflow não publicam dados comerciais', () => {
  const sync = ler('scripts/sync-dados.js');
  test('sync-dados.js não grava arquivos e escreve os 5 documentos protegidos', () => {
    expect(sync).not.toMatch(/writeFileSync|require\('fs'\)/);
    for (const d of ['vendas', 'caixa', 'estoque', 'estoque_custos', 'produtos_catalogo'])
      expect(sync).toContain(`firestoreSet('painel_cache', '${d}'`);
  });
  test('documento operacional de estoque não contém custo, preço, margem nem valor do estoque', () => {
    const bloco = sync.slice(sync.indexOf('const estoqueOperacional'), sync.indexOf('const estoqueCustos'));
    expect(bloco).not.toMatch(/custo|preco|margem|valor_total/i);
    expect(bloco).toMatch(/abaixo_minimo/);
  });
  test('documento do caixa contém só atualizado_em e hoje', () => {
    expect(sync).toMatch(/firestoreSet\('painel_cache', 'caixa', \{ atualizado_em: dadosVendas\.atualizado_em, hoje: fatHoje \}\)/);
  });
  test('falha do GestãoClick não sobrescreve os caches com zeros', () => {
    expect((sync.match(/↩ Mantendo painel_cache/g) || []).length).toBe(3);
  });
  test('workflow não commita data/ e tem só leitura no repositório', () => {
    const wf = ler('.github/workflows/sync-dados.yml');
    expect(wf).not.toMatch(/git add|git push|git commit/);
    expect(wf).toMatch(/contents: read/);
    expect(wf).not.toMatch(/contents: write/);
  });
});

describe('Segredos e GestãoClick', () => {
  test('nenhuma tela/JS do frontend contém credenciais ou cabeçalhos do GestãoClick', () => {
    for (const f of arquivosRuntime().filter(f => /\.(html|mjs)$/.test(f) || /[\\/]js[\\/]/.test(f))) {
      const s = fs.readFileSync(f, 'utf8');
      expect([path.relative(ROOT, f), /GC_(SECRET_)?ACCESS_TOKEN|secret-access-token|['"]access-token['"]/.test(s)]).toEqual([path.relative(ROOT, f), false]);
    }
  });
  test('gc-proxy é fail-closed: 410 para tudo, nunca chama o GestãoClick', () => {
    const src = ler('worker/gc-proxy.js');
    expect(src).not.toMatch(/api\.gestaoclick\.com|(?<!async )\bfetch\(/);   // o handler se chama fetch(); chamada de rede não
    // executa o worker de verdade (ESM) num processo Node separado
    const { execFileSync } = require('child_process');
    const code = "const m = await import(" + JSON.stringify('file://' + path.join(ROOT, 'worker/gc-proxy.js')) + ");" +
      "const out = []; for (const x of ['GET','POST','OPTIONS']) { const r = await m.default.fetch(new Request('https://x.example/?endpoint=/pagamentos', { method: x })); out.push(r.status); }" +
      "console.log(JSON.stringify(out));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code]).toString().trim();
    expect(JSON.parse(out)).toEqual([410, 410, 410]);
  });
  test('ZAPI_SCOPE=UNCHANGED: clientes.html não foi tocado por este hotfix', () => {
    // o hotfix não altera modulos/clientes.html (P0 da Z-API é tratado em outro trabalho)
    const { execFileSync } = require('child_process');
    let alterado = '';
    try { alterado = execFileSync('git', ['-C', ROOT, 'diff', '--name-only', 'd3822fa', '--', 'modulos/clientes.html']).toString().trim(); } catch { alterado = '?'; }
    expect(alterado).toBe('');
  });
});

describe('Contrato de dados: cada campo que a tela lê existe no documento protegido gravado pelo sync', () => {
  const sync = ler('scripts/sync-dados.js');
  const chavesDoObjeto = nome => {
    const i = sync.indexOf('const ' + nome + ' = {'); const f = sync.indexOf('};', i);
    return (sync.slice(i, f).match(/^\s{4}([a-z_0-9]+)[:,]/gm) || []).map(x => x.trim().replace(/[:,]$/, ''));   // inclui shorthand
  };
  test('vendas.html ← painel_cache/vendas (mesmo objeto dadosVendas que ia para o JSON)', () => {
    const chaves = chavesDoObjeto('dadosVendas');
    for (const c of ['atualizado_em', 'hoje', 'semana', 'mes', 'meta_mes', 'meta_dia', 'meta_semana', 'vendedores', 'ultimos_7_dias']) expect(chaves).toContain(c);
  });
  test('estoque.html ← estoque (operacional) + estoque_custos', () => {
    const op = chavesDoObjeto('estoqueOperacional'), ct = chavesDoObjeto('estoqueCustos');
    for (const c of ['atualizado_em', 'total_produtos', 'abaixo_minimo', 'sem_giro']) expect(op).toContain(c);
    for (const c of ['valor_total_estoque', 'margem_baixa']) expect(ct).toContain(c);
  });
});
