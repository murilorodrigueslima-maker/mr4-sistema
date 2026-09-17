'use strict';

/**
 * TRACE-V1-01 → TRACE-V1-02
 * Trace não contém PII nem payload bruto — N25.
 */

const { executarPipelineComercial } = require('../lib/ai/servicoAgenteComercial');

const PERFIL = {
  clienteMr4Id:    'SIM_TRACE_001',
  nuncaComprou:    false,
  inativo120d:     false,
  diasSemComprar:  50,
  dataReferencia:  '2026-09-17',
  faturamentoTotal: 5000,
  pedidosTotal:    3,
};

// ── TRACE-V1-01: trace não contém PII ────────────────────────────────────────

test('TRACE-V1-01: trace serializado não contém campos de PII', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  const traceStr = JSON.stringify(resultado.trace);

  // PII que nunca deve estar no trace
  expect(traceStr).not.toContain('"telefone"');
  expect(traceStr).not.toContain('"email"');
  expect(traceStr).not.toContain('"cpf"');
  expect(traceStr).not.toContain('"cnpj"');
  expect(traceStr).not.toContain('"endereco"');
  expect(traceStr).not.toContain('"nome_cliente"');
}, 10000);

// ── TRACE-V1-02: trace não contém payload bruto do cliente ───────────────────

test('TRACE-V1-02: spans do trace não contêm faturamento ou ticket em centavos brutos', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  // Spans individuais: entrada/saída não devem vazar o perfil completo
  for (const span of resultado.trace.spans) {
    const entradaStr = JSON.stringify(span.entrada || {});
    // Não deve conter faturamento ou outros valores brutos completos
    expect(entradaStr).not.toContain('"faturamentoTotal"');
    expect(entradaStr).not.toContain('"produtosComprados"');
  }
  // Resumo pode ter scoreTotal e clienteMr4Id — esperados
  expect(resultado.trace.resumo).toHaveProperty('scoreTotal');
  expect(resultado.trace.resumo).toHaveProperty('aiMode');
}, 10000);

// ── TRACE-V1-03: trace tem campos obrigatórios ───────────────────────────────

test('TRACE-V1-03: trace serializado tem campos obrigatórios', async () => {
  const resultado = await executarPipelineComercial(PERFIL);
  expect(resultado.trace).toHaveProperty('traceId');
  expect(resultado.trace).toHaveProperty('versao');
  expect(resultado.trace).toHaveProperty('iniciadoEm');
  expect(resultado.trace).toHaveProperty('finalizado', true);
  expect(resultado.trace).toHaveProperty('spans');
  expect(Array.isArray(resultado.trace.spans)).toBe(true);
  expect(resultado.trace.spans.length).toBeGreaterThan(0);
}, 10000);
