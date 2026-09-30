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
  for (const f of arqs) expect([path.relative(ROOT, f), /lib\/compras|compras_n0_custos/.test(fs.readFileSync(f, 'utf8'))]).toEqual([path.relative(ROOT, f), false]);
  for (const [f, s] of fontes) expect([f, /writeFile|data\//.test(s)]).toEqual([f, false]);
});
