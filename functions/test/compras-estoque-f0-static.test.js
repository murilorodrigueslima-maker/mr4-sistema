'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · privacidade e escopo (estático).
const fs = require('fs'), path = require('path');
const LIB = path.join(__dirname, '../lib/compras'), ROOT = path.resolve(__dirname, '../..');
const fontes = fs.readdirSync(LIB).map(f => [f, fs.readFileSync(path.join(LIB, f), 'utf8')]);
const codigo = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('fixtures sintéticas: sem CPF, CNPJ, e-mail ou telefone', () => {
  const fx = fs.readFileSync(path.join(__dirname, 'fixtures/compras-estoque-f0.js'), 'utf8');
  expect(fx).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/); expect(fx).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  expect(fx).not.toMatch(/[\w.]+@[\w-]+\.[a-z]{2,}/i); expect(fx).not.toMatch(/\(?\d{2}\)?\s?9\d{4}-?\d{4}/);
});
test('biblioteca não escreve log', () => { for (const [f, s] of fontes) expect([f, /console\./.test(s)]).toEqual([f, false]); });
test('sem lead time inventado, sem "custo real", sem inferência de fornecedor por texto, sem IA', () => {
  for (const [f, s] of fontes) {
    const c = codigo(s);
    expect([f, /lead_?time\s*[:=]\s*\d|LEAD_TIME_PADRAO|leadTime\s*=\s*\d/i.test(c)]).toEqual([f, false]);
    expect([f, /custo_real|real_cost/i.test(c)]).toEqual([f, false]);
    expect([f, /nome_fornecedor|razao_social|\.includes\(\s*nome/i.test(c)]).toEqual([f, false]);
    expect([f, /openai|anthropic|gpt|llm/i.test(c)]).toEqual([f, false]);
    expect([f, /9999|Infinity/.test(c)]).toEqual([f, false]);
  }
});
test('motor não calcula margem nem capital parado como verdade', () => {
  const motor = codigo(fontes.find(([f]) => f === 'motor.js')[1]);
  expect(motor).not.toMatch(/margem\s*[:=]|margin_cents|capital_parado|tied_capital/i);
});
test('nada do módulo é carregado pelo frontend nem exportado para arquivo público', () => {
  const arqs = [];
  const varrer = d => { for (const n of fs.readdirSync(d)) { if (['node_modules', '.git', 'functions', 'artifacts'].includes(n)) continue; const p = path.join(d, n), st = fs.lstatSync(p); if (st.isSymbolicLink()) continue; if (st.isDirectory()) varrer(p); else if (/\.(html|js)$/.test(n)) arqs.push(p); } };
  varrer(ROOT);
  // Exceção documentada: modulos/estoque.html (aba Produtos, Fase A) lê compras_n0_custos SOMENTE dentro de carregarProdutos(), em tentativa protegida pelas Rules
  // (gestor com módulo estoque); sem permissão a página esconde o capital. Nenhum outro arquivo pode referenciar o módulo; lib/compras continua proibido em todos.
  for (const f of arqs) {
    const rel = path.relative(ROOT, f), src = fs.readFileSync(f, 'utf8');
    if (rel === path.join('modulos', 'estoque.html')) {
      expect([rel, /lib\/compras/.test(src)]).toEqual([rel, false]);
      const codigo = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'), usos = [...codigo.matchAll(/compras_n0_custos/g)].length, dentro = (codigo.match(/async function carregarProdutos[\s\S]*?function abrirProdutos/) || [''])[0].match(/compras_n0_custos/g);   // só código (sem comentários)
      expect([rel, usos, dentro ? dentro.length : 0]).toEqual([rel, usos, usos]);   // todos os usos estão dentro de carregarProdutos()
      continue;
    }
    expect([rel, /lib\/compras|compras_n0_custos/.test(src)]).toEqual([rel, false]);
  }
  for (const [f, s] of fontes) expect([f, /writeFile|data\//.test(s)]).toEqual([f, false]);
});
