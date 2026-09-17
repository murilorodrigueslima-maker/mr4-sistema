'use strict';

/**
 * Fixtures de Perfis360 sintéticos e anônimos para testes.
 * N15 — dados de teste isolados, sem dados reais de clientes.
 *
 * Todos os clienteMr4Id são prefixados com 'FIXTURE_' para fácil identificação.
 * Nenhum dado real de cliente, vendedor, produto ou empresa.
 */

const DATA_REF = '2026-09-16';

const FIXTURE_ATIVO_EXCELENTE = {
  clienteMr4Id:  'FIXTURE_001',
  gestaoClickId: 'gc_fixture_001',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,
  inativo120d:   false,
  diasSemComprar: 5,
  ultimaCompraEm: '2026-09-11',
  faturamentoTotal:  25000,
  faturamento90d:     8000,
  faturamento30d:     3000,
  faturamento60d:     5500,
  faturamento180d:   15000,
  pedidosTotal:  40,
  pedidos90d:    10,
  pedidos30d:     4,
  pedidos60d:     7,
  pedidos180d:   20,
  diasEntreComprasMedio:   10,
  diasEntreComprasMediana:  9,
  quantidadeProdutosDistintos: 18,
  categoriasMaisCompradas: [
    { categoria: 'CAT_A', faturamento: 12000 },
    { categoria: 'CAT_B', faturamento:  8000 },
    { categoria: 'CAT_C', faturamento:  5000 },
  ],
};

const FIXTURE_NUNCA_COMPROU = {
  clienteMr4Id:  'FIXTURE_002',
  gestaoClickId: 'gc_fixture_002',
  dataReferencia: DATA_REF,
  nuncaComprou:  true,
  inativo120d:   false,
  diasSemComprar: null,
  ultimaCompraEm: null,
  faturamentoTotal: 0,
  faturamento90d:   0,
  faturamento30d:   0,
  faturamento60d:   0,
  faturamento180d:  0,
  pedidosTotal: 0,
  pedidos90d:   0,
  pedidos30d:   0,
  pedidos60d:   0,
  pedidos180d:  0,
  diasEntreComprasMedio:   null,
  diasEntreComprasMediana: null,
  quantidadeProdutosDistintos: 0,
  categoriasMaisCompradas: [],
};

const FIXTURE_INATIVO_120D = {
  clienteMr4Id:  'FIXTURE_003',
  gestaoClickId: 'gc_fixture_003',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,
  inativo120d:   true,
  diasSemComprar: 150,
  ultimaCompraEm: '2026-04-19',
  faturamentoTotal: 12000,
  faturamento90d:    0,
  faturamento30d:    0,
  faturamento60d:    0,
  faturamento180d:  3000,
  pedidosTotal: 15,
  pedidos90d:    0,
  pedidos30d:    0,
  pedidos60d:    0,
  pedidos180d:   2,
  diasEntreComprasMedio:   30,
  diasEntreComprasMediana: 28,
  quantidadeProdutosDistintos: 7,
  categoriasMaisCompradas: [],
};

const FIXTURE_CAINDO = {
  clienteMr4Id:  'FIXTURE_004',
  gestaoClickId: 'gc_fixture_004',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,
  inativo120d:   false,
  diasSemComprar: 25,
  ultimaCompraEm: '2026-08-22',
  faturamentoTotal:  7000,
  faturamento90d:    1000,
  faturamento30d:     150,
  faturamento60d:     600,
  faturamento180d:   4500,
  pedidosTotal: 10,
  pedidos90d:    2,
  pedidos30d:    1,
  pedidos60d:    2,
  pedidos180d:   6,
  diasEntreComprasMedio:   25,
  diasEntreComprasMediana: 22,
  quantidadeProdutosDistintos: 5,
  categoriasMaisCompradas: [
    { categoria: 'CAT_A', faturamento: 4000 },
    { categoria: 'CAT_B', faturamento: 3000 },
  ],
};

const FIXTURE_CROSS_SELL = {
  clienteMr4Id:  'FIXTURE_005',
  gestaoClickId: 'gc_fixture_005',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,
  inativo120d:   false,
  diasSemComprar: 12,
  ultimaCompraEm: '2026-09-04',
  faturamentoTotal:  5500,
  faturamento90d:    2000,
  faturamento30d:     800,
  faturamento60d:    1500,
  faturamento180d:   3500,
  pedidosTotal:  8,
  pedidos90d:    3,
  pedidos30d:    1,
  pedidos60d:    2,
  pedidos180d:   5,
  diasEntreComprasMedio:   38,
  diasEntreComprasMediana: 35,
  quantidadeProdutosDistintos: 4,
  categoriasMaisCompradas: [
    { categoria: 'CAT_UNICA', faturamento: 5500 },
  ],
};

module.exports = {
  DATA_REF,
  FIXTURE_ATIVO_EXCELENTE,
  FIXTURE_NUNCA_COMPROU,
  FIXTURE_INATIVO_120D,
  FIXTURE_CAINDO,
  FIXTURE_CROSS_SELL,
  TODOS: [
    FIXTURE_ATIVO_EXCELENTE,
    FIXTURE_NUNCA_COMPROU,
    FIXTURE_INATIVO_120D,
    FIXTURE_CAINDO,
    FIXTURE_CROSS_SELL,
  ],
};
