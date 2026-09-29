'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · verificações estáticas de privacidade e escopo.
const fs = require('fs'), path = require('path');
const LIB = path.join(__dirname, '../lib/financeiro');
const ROOT = path.resolve(__dirname, '../..');
const fontes = fs.readdirSync(LIB).map(f => [f, fs.readFileSync(path.join(LIB, f), 'utf8')]);

test('fixtures sintéticas: sem CPF, CNPJ, e-mail ou telefone', () => {
  const fx = fs.readFileSync(path.join(__dirname, 'fixtures/financeiro-f1.js'), 'utf8');
  expect(fx).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);            // CPF
  expect(fx).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);     // CNPJ
  expect(fx).not.toMatch(/[\w.]+@[\w-]+\.[a-z]{2,}/i);            // e-mail
  expect(fx).not.toMatch(/\(?\d{2}\)?\s?9?\d{4}-?\d{4}/);         // telefone
});
test('biblioteca não escreve log (nenhum valor, nome ou credencial em console)', () => {
  for (const [f, s] of fontes) expect([f, /console\./.test(s)]).toEqual([f, false]);
});
test('métricas bloqueadas não são calculadas (só listadas como bloqueadas)', () => {
  const motor = fontes.find(([f]) => f === 'motor.js')[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // só código, sem comentários
  expect(motor).not.toMatch(/saldo_bancario|caixa_disponivel|capacidade_compra|runway|free_cash/i);
  const snap = require('../lib/financeiro/snapshot');
  expect(snap.METRICAS_BLOQUEADAS).toEqual(expect.arrayContaining(['SALDO_DISPONIVEL', 'SALDO_BANCARIO', 'CAIXA_REAL', 'CAIXA_PARA_COMPRAS', 'CAPACIDADE_DE_COMPRA', 'RUNWAY', 'FREE_CASH', 'PROJECAO_DE_CAIXA']));
});
test('o motor não é carregado pelo frontend nem publica arquivo', () => {
  const html = [];
  const varrer = d => { for (const n of fs.readdirSync(d)) { if (['node_modules', '.git', 'functions', 'artifacts'].includes(n)) continue; const p = path.join(d, n), st = fs.lstatSync(p); if (st.isSymbolicLink()) continue; if (st.isDirectory()) varrer(p); else if (/\.(html|js)$/.test(n)) html.push(p); } };
  varrer(ROOT);
  for (const f of html) expect([path.relative(ROOT, f), /lib\/financeiro|fin_n1_titulos_abertos/.test(fs.readFileSync(f, 'utf8'))]).toEqual([path.relative(ROOT, f), false]);
  for (const [f, s] of fontes) expect([f, /writeFile|data\//.test(s)]).toEqual([f, false]);
});
