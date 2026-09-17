'use strict';

/**
 * CATEGORY-SAFE-01 → CATEGORY-SAFE-06
 * Testa preservação de categorias no sync incremental — N19 (C1).
 */

const { buildProdutosPorId, mesclaProdutosPorId } = require('../lib/sync360');

// ── CATEGORY-SAFE-01: API retorna categoria válida ────────────────────────────

test('CATEGORY-SAFE-01: API com nome_grupo válido → preservado sem alteração', () => {
  const produtos = [{ id: '1', nome_grupo: 'Filtros' }];
  const map = buildProdutosPorId(produtos);
  expect(map['1'].nome_grupo).toBe('Filtros');
});

// ── CATEGORY-SAFE-02: API retorna vazio + anterior válido → preserva anterior ─

test('CATEGORY-SAFE-02: API com nome_grupo vazio + anterior válido → preserva anterior', () => {
  const apiMap   = buildProdutosPorId([{ id: '1', nome_grupo: '' }]);
  const anterior = { '1': { id: '1', nome_grupo: 'Filtros' } };
  const merged   = mesclaProdutosPorId(apiMap, anterior);
  expect(merged['1'].nome_grupo).toBe('Filtros');
});

// ── CATEGORY-SAFE-03: API ausente + anterior válido → produto reaparece ───────

test('CATEGORY-SAFE-03: produto saiu da API + categoria anterior válida → produto preservado', () => {
  const apiMap   = {};  // produto não veio da API
  const anterior = { '1': { id: '1', nome_grupo: 'Suspensão' } };
  const merged   = mesclaProdutosPorId(apiMap, anterior);
  expect(merged['1']).toBeDefined();
  expect(merged['1'].nome_grupo).toBe('Suspensão');
});

// ── CATEGORY-SAFE-04: buildProdutosPorId normaliza vazio para undefined ────────

test('CATEGORY-SAFE-04: buildProdutosPorId normaliza nome_grupo vazio para undefined', () => {
  const map = buildProdutosPorId([{ id: '2', nome_grupo: '   ' }]);
  expect(map['2'].nome_grupo).toBeUndefined();
});

// ── CATEGORY-SAFE-05: anterior com categoria vazia → não prevalece sobre API ──

test('CATEGORY-SAFE-05: anterior com nome_grupo vazio → NÃO sobrescreve API válida', () => {
  const apiMap   = buildProdutosPorId([{ id: '3', nome_grupo: 'Arrefecimento' }]);
  const anterior = { '3': { id: '3', nome_grupo: '' } };
  const merged   = mesclaProdutosPorId(apiMap, anterior);
  expect(merged['3'].nome_grupo).toBe('Arrefecimento');
});

// ── CATEGORY-SAFE-06: anterior nulo/ausente → semântica igual a vazio ─────────

test('CATEGORY-SAFE-06: anterior inexistente → não cria produto fantasma', () => {
  const apiMap   = buildProdutosPorId([{ id: '4', nome_grupo: 'Motor' }]);
  const merged   = mesclaProdutosPorId(apiMap, {});
  expect(Object.keys(merged)).toHaveLength(1);
  expect(merged['4'].nome_grupo).toBe('Motor');
});
