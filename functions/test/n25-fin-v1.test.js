'use strict';

/**
 * FIN-V1-01 → FIN-V1-06
 * AI_FINANCIAL_AUTHORITY = NONE — N25.
 * A IA não possui autoridade para tomar decisões financeiras.
 */

const { AI_FINANCIAL_AUTHORITY, MARCADORES_PROIBIDOS, validarOutputAgente, mkOutputAgente, GuardrailViolationError } = require('../lib/ai/guardrails');

// ── FIN-V1-00: constante declarada ────────────────────────────────────────────

test('FIN-V1-00: AI_FINANCIAL_AUTHORITY = NONE', () => {
  expect(AI_FINANCIAL_AUTHORITY).toBe('NONE');
});

// ── FIN-V1-01: IA não define preço ───────────────────────────────────────────

test('FIN-V1-01: output com ALTERAR_PRECO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'ALTERAR_PRECO do produto para R$50';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-02: IA não define desconto ────────────────────────────────────────

test('FIN-V1-02a: output com CONCEDER_DESCONTO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'CONCEDER_DESCONTO de 15%';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

test('FIN-V1-02b: output com APROVAR_DESCONTO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'APROVAR_DESCONTO para reativação';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

test('FIN-V1-02c: output com DEFINIR_DESCONTO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'DEFINIR_DESCONTO = 20%';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-03: IA não aprova crédito ─────────────────────────────────────────

test('FIN-V1-03: output com APROVAR_CREDITO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'APROVAR_CREDITO de R$5.000';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-04: IA não define prazo ───────────────────────────────────────────

test('FIN-V1-04: output com APROVAR_PRAZO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'APROVAR_PRAZO de 60 dias';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-05: IA não altera comissão ────────────────────────────────────────

test('FIN-V1-05: output com ALTERAR_COMISSAO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'ALTERAR_COMISSAO para 5%';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-06: IA não altera carteira ────────────────────────────────────────

test('FIN-V1-06: output com ALTERAR_ENCARTEIRAMENTO é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'ALTERAR_ENCARTEIRAMENTO para vendedor X';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-07: cancelar venda é bloqueado ────────────────────────────────────

test('FIN-V1-07: output com CANCELAR_VENDA é bloqueado', () => {
  const output = mkOutputAgente({ tipo: 'SUGESTAO', conteudo: 'x' });
  output.conteudo = 'CANCELAR_VENDA #1234';
  expect(() => validarOutputAgente(output)).toThrow(GuardrailViolationError);
});

// ── FIN-V1-08: todos os marcadores financeiros estão na lista ────────────────

test('FIN-V1-08: todos marcadores financeiros críticos estão em MARCADORES_PROIBIDOS', () => {
  const financeiros = [
    'APROVAR_DESCONTO', 'DEFINIR_DESCONTO', 'CONCEDER_DESCONTO',
    'APROVAR_CREDITO', 'DEFINIR_CREDITO',
    'APROVAR_PRAZO', 'DEFINIR_PRAZO',
    'ALTERAR_COMISSAO', 'ALTERAR_ENCARTEIRAMENTO',
    'APROVAR_DEVOLUCAO', 'APROVAR_GARANTIA',
    'CANCELAR_VENDA',
  ];
  for (const m of financeiros) {
    expect(MARCADORES_PROIBIDOS).toContain(m);
  }
});
