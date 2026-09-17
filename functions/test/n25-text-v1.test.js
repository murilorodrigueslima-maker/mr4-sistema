'use strict';

/**
 * TEXT-V1-01 → TEXT-V1-03
 * Validação de fatos factuais no texto livre da IA — N25.
 */

const {
  buildGroundingFacts,
  validarFatosNoTexto,
  validarOutputComGrounding,
  TextFactViolationError,
  GroundingViolationError,
} = require('../lib/ai/groundingOutput');

const PERFIL = {
  clienteMr4Id:            'SIM_TEXT_001',
  nuncaComprou:            false,
  inativo120d:             false,
  diasSemComprar:          90,
  ultimaCompraEm:          '2026-06-19',
  dataReferencia:          '2026-09-17',
  faturamentoTotal:        15000,
  pedidosTotal:            6,
  ticketMedio:             2500,
  diasEntreComprasMedio:   30,
  diasEntreComprasMediana: 28,
};

const SCORE  = { scoreTotal: 40, classificacao: 'REGULAR', statusConfig: 'PROVISIONAL' };
const TEND   = { tendencia: 'CAINDO' };
const RECORR = { status: 'ATRASADO_VS_HISTORICO' };

let facts;
beforeAll(() => { facts = buildGroundingFacts(PERFIL, SCORE, TEND, RECORR); });

// ── TEXT-V1-01: valor monetário no texto sem claim bloqueia ──────────────────

test('TEXT-V1-01: "R$ 20.000" inventado no texto sem claim monetário bloqueia', () => {
  expect(() => validarFatosNoTexto('O cliente faturou R$ 20.000 nos últimos meses.', [], facts))
    .toThrow(TextFactViolationError);
});

test('TEXT-V1-01b: valor monetário com claim correspondente passa', () => {
  const claims = [{ field: 'faturamentoTotalCents', value: facts.faturamentoTotalCents }];
  expect(() => validarFatosNoTexto('O cliente faturou R$ 15.000 no total.', claims, facts))
    .not.toThrow();
});

// ── TEXT-V1-02: data ISO no texto sem claim bloqueia ─────────────────────────

test('TEXT-V1-02: data ISO inventada "2026-08-01" no texto sem claim de data bloqueia', () => {
  expect(() => validarFatosNoTexto('Última compra em 2026-08-01.', [], facts))
    .toThrow(TextFactViolationError);
});

test('TEXT-V1-02b: data ISO com claim correspondente passa', () => {
  const claims = [{ field: 'ultimaCompraEm', value: facts.ultimaCompraEm }];
  expect(() => validarFatosNoTexto('Última compra em 2026-06-19.', claims, facts))
    .not.toThrow();
});

// ── TEXT-V1-03: percentual inventado ─────────────────────────────────────────

test('TEXT-V1-03: percentuais no texto são permitidos (contexto de score)', () => {
  // Percentuais são aceitos — score e componentes são expressos em %
  expect(() => validarFatosNoTexto('O score está em 40%, indicando REGULAR.', [], facts))
    .not.toThrow();
});

test('TEXT-V1-03b: dias específicos no texto sem claim e sem coincidência com facts bloqueia', () => {
  // "150 dias" não é um valor em facts (diasSemComprar=90, medio=30, mediana=28)
  // E não há claim de dias
  expect(() => validarFatosNoTexto('O cliente está inativo há 150 dias.', [], facts))
    .toThrow(TextFactViolationError);
});

test('TEXT-V1-03c: dias que coincidem com facts passam mesmo sem claim', () => {
  // 90 dias = diasSemComprar — valor coincide, não bloqueia
  expect(() => validarFatosNoTexto('O cliente está sem comprar há 90 dias.', [], facts))
    .not.toThrow();
});
