'use strict';

/**
 * TICKET-01 → TICKET-06
 * Prova root cause B1 (N21): ticketMedio era lido com nome errado no script N20.
 * Verifica que calcularPerfil360 retorna ticketMedioTotal/30d/90d corretamente.
 */

const { calcularPerfil360 } = require('../lib/perfil360');

function mkConc(id, data, valor, clienteId) {
  return {
    id: String(id),
    data,
    nome_situacao: 'Concretizada',
    valor_total: String(valor),
    cliente_id: String(clienteId),
    cadastrado_em: `${data} 12:00:00`,
    vendedor_id: '1',
    nome_vendedor: 'V',
    produtos: [],
  };
}

function mkNaoConc(id, data, valor, clienteId) {
  return { ...mkConc(id, data, valor, clienteId), nome_situacao: 'Cancelada' };
}

// TICKET-01: 0 pedidos (nuncaComprou) → ticketMedioTotal = null
test('TICKET-01: nuncaComprou → ticketMedioTotal=null (não zero)', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_T01',
    gestaoClickId: 'GC_T01',
    vendas: [],
    dataReferencia: '2026-09-17',
  });
  expect(p.nuncaComprou).toBe(true);
  expect(p.ticketMedioTotal).toBeNull();
  expect(p.ticketMedio30d).toBeNull();
  expect(p.ticketMedio90d).toBeNull();
  // prova que null ≠ 0 — era o bug no N20
  expect(p.ticketMedioTotal).not.toBe(0);
});

// TICKET-02: 1 pedido R$100 → ticket = R$100
test('TICKET-02: 1 pedido R$100 → ticketMedioTotal=100', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_T02',
    gestaoClickId: 'GC_T02',
    vendas: [mkConc('1', '2026-09-10', '100.00', 'GC_T02')],
    dataReferencia: '2026-09-17',
  });
  expect(p.pedidosTotal).toBe(1);
  expect(p.faturamentoTotal).toBe(100);
  expect(p.ticketMedioTotal).toBe(100);
});

// TICKET-03: 2 pedidos R$100 + R$200 → ticket = R$150
test('TICKET-03: 2 pedidos R$100 e R$200 → ticketMedioTotal=150', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_T03',
    gestaoClickId: 'GC_T03',
    vendas: [
      mkConc('1', '2026-09-05', '100.00', 'GC_T03'),
      mkConc('2', '2026-09-10', '200.00', 'GC_T03'),
    ],
    dataReferencia: '2026-09-17',
  });
  expect(p.pedidosTotal).toBe(2);
  expect(p.faturamentoTotal).toBeCloseTo(300, 2);
  expect(p.ticketMedioTotal).toBeCloseTo(150, 2);
});

// TICKET-04: pedido Cancelada não entra no ticket
test('TICKET-04: venda não-Concretizada não entra no ticketMedioTotal', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_T04',
    gestaoClickId: 'GC_T04',
    vendas: [
      mkConc   ('1', '2026-09-05', '100.00', 'GC_T04'),
      mkNaoConc('2', '2026-09-10', '999.00', 'GC_T04'),
    ],
    dataReferencia: '2026-09-17',
  });
  expect(p.pedidosTotal).toBe(1);
  expect(p.faturamentoTotal).toBeCloseTo(100, 2);
  expect(p.ticketMedioTotal).toBeCloseTo(100, 2);
});

// TICKET-05: cents-safe — R$1,99 + R$2,01 = R$4,00 exato, ticket = R$2,00
test('TICKET-05: cents-safe — R$1,99 + R$2,01 → ticket=2.00 sem floating-point error', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_T05',
    gestaoClickId: 'GC_T05',
    vendas: [
      mkConc('1', '2026-09-05', '1.99', 'GC_T05'),
      mkConc('2', '2026-09-10', '2.01', 'GC_T05'),
    ],
    dataReferencia: '2026-09-17',
  });
  expect(p.faturamentoTotal).toBeCloseTo(4.00, 10);
  expect(p.ticketMedioTotal).toBeCloseTo(2.00, 10);
});

// TICKET-06: campo correto é ticketMedioTotal, não ticketMedio (prova do bug N20)
test('TICKET-06: campo é ticketMedioTotal — ticketMedio não existe no perfil', () => {
  const p = calcularPerfil360({
    clienteMr4Id: 'MR4_T06',
    gestaoClickId: 'GC_T06',
    vendas: [mkConc('1', '2026-09-10', '500.00', 'GC_T06')],
    dataReferencia: '2026-09-17',
  });
  expect(p.ticketMedioTotal).toBe(500);
  // prova que o campo errado (usado no N20) é undefined, causando o bug
  expect(p.ticketMedio).toBeUndefined();
});
