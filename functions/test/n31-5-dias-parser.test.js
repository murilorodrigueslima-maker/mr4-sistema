'use strict';

/**
 * N31.5 — DAYS PARSER PRECISION HARDENING
 *
 * Testa as duas correções de parsing do validator DIAS:
 *   Fix 1: REGEX_DIAS captura decimal completo ("17,5" / "17.5") — elimina falso positivo
 *           onde vírgula/ponto criava word boundary e "5" de "17,5 dias" gerava match autônomo.
 *   Fix 2: _ehReferenciaJanela detecta lista de janelas com âncora léxica obrigatória
 *           ("nos últimos 30, 60, 90 e 180 dias") sem bypass cego.
 *
 * OPENAI_CALLS=0 | PROD_WRITES=0 | REAL_DATA=NONE
 */

const {
  buildGroundingFactsV2,
  validarFatosNoTextoV2,
  TextFactV2ViolationError,
} = require('../lib/n29/groundingOutput');

// ── Fixtures ──────────────────────────────────────────────────────────────────

// CTX para testes decimais: diasEntreComprasMedio=17.5, diasEntreComprasMediana=23.5
const CTX_DEC = Object.freeze({
  tipoOportunidade:              null,
  prioridade:                    null,
  scoreTotal:                    70,
  classificacao:                 'BOM',
  tendencia:                     'ESTAVEL',
  recorrenciaStatus:             'DENTRO_DO_PADRAO',
  diasSemComprar:                null,           // null: não interfere nos checks DIAS
  pedidosTotal:                  15,
  pedidos30d:                    2,
  pedidos60d:                    5,
  pedidos90d:                    9,
  pedidos180d:                   15,
  faturamentoTotal:              1500,
  faturamento30d:                200,
  faturamento60d:                500,
  faturamento90d:                900,
  faturamento180d:               1500,
  ticketMedioTotal:              100,
  diasEntreComprasMedio:         17.5,
  diasEntreComprasMediana:       23.5,
  quantidadeProdutosDistintos:   4,
  quantidadeCategoriasDistintas: 2,
});

// CTX para testes de rounding N31.3: diasEntreComprasMedio=20.5
const CTX_ROUNDING = Object.freeze({
  tipoOportunidade:              null,
  prioridade:                    null,
  scoreTotal:                    65,
  classificacao:                 'BOM',
  tendencia:                     'ESTAVEL',
  recorrenciaStatus:             'DENTRO_DO_PADRAO',
  diasSemComprar:                null,
  pedidosTotal:                  12,
  pedidos30d:                    2,
  pedidos60d:                    5,
  pedidos90d:                    8,
  pedidos180d:                   12,
  faturamentoTotal:              1200,
  faturamento30d:                200,
  faturamento60d:                450,
  faturamento90d:                800,
  faturamento180d:               1200,
  ticketMedioTotal:              100,
  diasEntreComprasMedio:         20.5,
  diasEntreComprasMediana:       21,
  quantidadeProdutosDistintos:   4,
  quantidadeCategoriasDistintas: 2,
});

// CTX para testes de lista de janelas: todas as 4 janelas com dados
const CTX_WINLIST = Object.freeze({
  tipoOportunidade:              null,
  prioridade:                    null,
  scoreTotal:                    60,
  classificacao:                 'BOM',
  tendencia:                     'CAINDO',
  recorrenciaStatus:             'ATRASADO',
  diasSemComprar:                null,           // null: não é fact DIAS neste contexto
  pedidosTotal:                  20,
  pedidos30d:                    3,
  pedidos60d:                    8,
  pedidos90d:                    12,
  pedidos180d:                   18,
  faturamentoTotal:              2000,
  faturamento30d:                200,
  faturamento60d:                500,
  faturamento90d:                900,
  faturamento180d:               2000,
  ticketMedioTotal:              100,
  diasEntreComprasMedio:         null,
  diasEntreComprasMediana:       null,
  quantidadeProdutosDistintos:   5,
  quantidadeCategoriasDistintas: 2,
});

// CTX com janela 180 NÃO autorizada (pedidos180d=null, faturamento180d=null)
const CTX_WINLIST_SEM180 = Object.freeze({
  ...CTX_WINLIST,
  pedidos180d:     null,
  faturamento180d: null,
});

// CTX NAO_AGIR: diasSemComprar=null, pedidos/faturamento 30/60/90/180 = 0 (dado presente)
const CTX_P3_SAFE = Object.freeze({
  tipoOportunidade:              null,
  prioridade:                    null,
  scoreTotal:                    35,
  classificacao:                 'RUIM',
  tendencia:                     'CAINDO',
  recorrenciaStatus:             'SEM_BASE',
  diasSemComprar:                null,
  pedidosTotal:                  2,
  pedidos30d:                    0,
  pedidos60d:                    0,
  pedidos90d:                    0,
  pedidos180d:                   0,
  faturamentoTotal:              1200,
  faturamento30d:                0,
  faturamento60d:                0,
  faturamento90d:                0,
  faturamento180d:               0,
  ticketMedioTotal:              600,
  diasEntreComprasMedio:         null,
  diasEntreComprasMediana:       null,
  quantidadeProdutosDistintos:   1,
  quantidadeCategoriasDistintas: 1,
});

// Decisão PROGRAMAR_CICLO com diasAteProximoCiclo=12
const DECISAO_12 = Object.freeze({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 12 });
// Decisão PROGRAMAR_CICLO com diasAteProximoCiclo=9
const DECISAO_9  = Object.freeze({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 9  });
// Decisão PROGRAMAR_CICLO com diasAteProximoCiclo=8
const DECISAO_8  = Object.freeze({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 8  });
// Decisão NAO_AGIR
const DECISAO_NAO_AGIR = Object.freeze({ decisaoAcaoComercial: 'NAO_AGIR', diasAteProximoCiclo: null });

function decFacts(d = null)        { return buildGroundingFactsV2(CTX_DEC, d);            }
function roundingFacts(d = null)   { return buildGroundingFactsV2(CTX_ROUNDING, d);       }
function winFacts(d = null)        { return buildGroundingFactsV2(CTX_WINLIST, d);         }
function winSem180Facts(d = null)  { return buildGroundingFactsV2(CTX_WINLIST_SEM180, d); }
function p3SafeFacts(d = null)     { return buildGroundingFactsV2(CTX_P3_SAFE, d);        }

// ── DEC: Testes de decimais ───────────────────────────────────────────────────

describe('N31.5 — DEC: Decimal parser precision', () => {

  test('DEC-01: diasMedio=17.5, "17,5 dias" (vírgula) → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Intervalo médio entre compras: 17,5 dias.',
      [{ field: 'diasEntreComprasMedio', value: 17.5 }],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-02: diasMedio=17.5, "17.5 dias" (ponto) → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Intervalo médio entre compras: 17.5 dias.',
      [{ field: 'diasEntreComprasMedio', value: 17.5 }],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-03: diasMedio=17.5, "5 dias" → BLOCK (5 não é fact)', () => {
    expect(() => validarFatosNoTextoV2(
      'Agendar contato em 5 dias.',
      [],
      decFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('DEC-04: diasMedio=17.5, "18,5 dias" → BLOCK (18.5 ≠ 17.5)', () => {
    expect(() => validarFatosNoTextoV2(
      'Intervalo aproximado de 18,5 dias.',
      [{ field: 'diasEntreComprasMedio', value: 17.5 }],
      decFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('DEC-05: diasMediana=23.5, "23,5 dias" (vírgula) → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Mediana do ciclo de 23,5 dias.',
      [{ field: 'diasEntreComprasMediana', value: 23.5 }],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-06: diasMediana=23.5, "23.5 dias" (ponto) → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Mediana do ciclo de 23.5 dias.',
      [{ field: 'diasEntreComprasMediana', value: 23.5 }],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-07: diasMediana=23.5, "5 dias" → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Retorno em 5 dias.',
      [],
      decFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  // ── DEC-08..11: compatibilidade com contrato N31.3 de rounding ────────────

  test('DEC-08: diasMedio=20.5, "20 dias" → PASS (floor — contrato N31.3)', () => {
    expect(() => validarFatosNoTextoV2(
      'Média aproximada de 20 dias entre compras.',
      [{ field: 'diasEntreComprasMedio', value: 20.5 }],
      roundingFacts()
    )).not.toThrow();
  });

  test('DEC-09: diasMedio=20.5, "21 dias" → PASS (ceil — contrato N31.3)', () => {
    expect(() => validarFatosNoTextoV2(
      'Média aproximada de 21 dias entre compras.',
      [{ field: 'diasEntreComprasMedio', value: 20.5 }],
      roundingFacts()
    )).not.toThrow();
  });

  test('DEC-10: diasMedio=20.5, "19 dias" → BLOCK (19 ∉ {floor,ceil,exact})', () => {
    expect(() => validarFatosNoTextoV2(
      'Média de 19 dias entre compras.',
      [],
      roundingFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('DEC-11: diasMedio=20.5, "22 dias" → BLOCK (22 > ceil(20.5)=21)', () => {
    expect(() => validarFatosNoTextoV2(
      'Média de 22 dias entre compras.',
      [],
      roundingFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  // ── DEC-12..13: regressão específica para o bug "5 de 17,5" ──────────────

  test('DEC-12: "17,5 dias" grounded não gera BLOCK por "5" autônomo', () => {
    // Se o bug existir: REGEX_DIAS capturaria "5 dias" separadamente → BLOCK.
    // Fix N31.5: captura "17,5" como unidade → "17.5" === fact 17.5 → PASS.
    expect(() => validarFatosNoTextoV2(
      'O intervalo médio registrado é de 17,5 dias entre compras.',
      [{ field: 'diasEntreComprasMedio', value: 17.5 }],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-13: "17.5 dias" grounded não gera BLOCK por "5" autônomo', () => {
    expect(() => validarFatosNoTextoV2(
      'O intervalo médio registrado é de 17.5 dias entre compras.',
      [{ field: 'diasEntreComprasMedio', value: 17.5 }],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-14: dois decimais no mesmo texto — ambos grounded → PASS', () => {
    // "17,5 dias" + "23,5 dias" — ambos em facts
    expect(() => validarFatosNoTextoV2(
      'Média de 17,5 dias. Mediana de 23,5 dias.',
      [
        { field: 'diasEntreComprasMedio',   value: 17.5 },
        { field: 'diasEntreComprasMediana', value: 23.5 },
      ],
      decFacts()
    )).not.toThrow();
  });

  test('DEC-15: decimal não grounded → BLOCK', () => {
    // "12,5 dias" — não existe fact 12.5 no contexto
    expect(() => validarFatosNoTextoV2(
      'Intervalo calculado de 12,5 dias.',
      [],
      decFacts()
    )).toThrow(TextFactV2ViolationError);
  });

});

// ── WINLIST: Testes de lista de janelas ───────────────────────────────────────

describe('N31.5 — WINLIST: Window list detection', () => {

  // ── PASS: referências legítimas de lista ─────────────────────────────────

  test('WINLIST-01: "nos últimos 30, 60, 90 e 180 dias" — todas autorizadas → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Não houve pedidos nos últimos 30, 60, 90 e 180 dias.',
      [],
      winFacts()
    )).not.toThrow();
  });

  test('WINLIST-02: "nos últimos 30 e 60 dias" — ambas autorizadas → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Avaliação nos últimos 30 e 60 dias sem crescimento.',
      [],
      winFacts()
    )).not.toThrow();
  });

  test('WINLIST-03: "nos últimos 30, 60 e 90 dias" — todas autorizadas → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Queda de pedidos nos últimos 30, 60 e 90 dias.',
      [],
      winFacts()
    )).not.toThrow();
  });

  test('WINLIST-04: "considerando as janelas de 30, 60, 90 e 180 dias" → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Análise considerando as janelas de 30, 60, 90 e 180 dias.',
      [],
      winFacts()
    )).not.toThrow();
  });

  test('WINLIST-09: "nos últimos 180 dias" singular — janela autorizada → PASS', () => {
    // Compatibilidade com contrato N31.3 (PREC-DAY-04)
    expect(() => validarFatosNoTextoV2(
      'Avaliação completa dos últimos 180 dias.',
      [],
      winFacts()
    )).not.toThrow();
  });

  // ── BLOCK: anti-bypass ────────────────────────────────────────────────────

  test('WINLIST-05: "nos últimos 30, 60, 90 e 180 dias" — janela 180 NÃO autorizada → BLOCK para 180', () => {
    // pedidos180d=null, faturamento180d=null → 180 não entra em janelasAutorizadas
    expect(() => validarFatosNoTextoV2(
      'Sem pedidos nos últimos 30, 60, 90 e 180 dias.',
      [],
      winSem180Facts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-06: "nos últimos 30, 60 e 90 dias, o cliente está há 180 dias sem comprar" → BLOCK (180 fora da lista)', () => {
    // "180 dias" não é parte do construto de lista → não tem âncora → diasSemComprar=null → BLOCK
    expect(() => validarFatosNoTextoV2(
      'Sem histórico nos últimos 30, 60 e 90 dias, o cliente está há 180 dias sem comprar.',
      [],
      winFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-07: "nos últimos 30, 60 e 90 dias, aguarde 180 dias" → BLOCK (180 como espera)', () => {
    // diasAteProximoCiclo=8 ≠ 180 → BLOCK
    expect(() => validarFatosNoTextoV2(
      'Análise dos últimos 30, 60 e 90 dias. Aguarde 180 dias para nova abordagem.',
      [],
      winFacts(DECISAO_8)
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-08: "nos últimos 30 dias e nova abordagem em 5 dias" — 5 não é fact → BLOCK', () => {
    // "30 dias" bypassa; "5 dias" não tem âncora → check contra facts → diasAteProximoCiclo=8 ≠ 5 → BLOCK
    expect(() => validarFatosNoTextoV2(
      'Análise dos últimos 30 dias. Nova abordagem em 5 dias.',
      [],
      winFacts(DECISAO_8)
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-10: "180 dias sem comprar" — diasSemComprar=null, janela180 autorizada → BLOCK', () => {
    // "180" não tem âncora de lista → va para diasFacts → diasSemComprar=null → diasFacts=[] → BLOCK
    expect(() => validarFatosNoTextoV2(
      'O cliente está há 180 dias sem comprar.',
      [],
      winFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-11: "aguarde 180 dias" — janela180 autorizada, diasAteProximoCiclo=8 → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Aguarde 180 dias para contato.',
      [],
      winFacts(DECISAO_8)
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-12: "últimos resultados indicam contato em 180 dias" → BLOCK (âncora distante)', () => {
    // "últimos" está em "últimos resultados", não imediatamente antes de "180 dias"
    // → REGEX_ANCORA_JANELA não casa → não é referência de janela → BLOCK
    expect(() => validarFatosNoTextoV2(
      'Os últimos resultados indicam que devemos aguardar 180 dias.',
      [],
      winFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('WINLIST-13: lista reordenada "nos últimos 60 e 30 dias" → PASS', () => {
    // Ordem inversa ainda é construto de lista válido
    expect(() => validarFatosNoTextoV2(
      'Avaliação nos últimos 60 e 30 dias consistente.',
      [],
      winFacts()
    )).not.toThrow();
  });

});

// ── N31.4 REPRODUCTIONS: reproduzir padrões observados no N31.4 ─────────────

describe('N31.5 — N31.4 Reproductions: padrões textuais reais de Luna', () => {

  // P2-SAFE: diasEntreComprasMedio=17.5, diasAteProximoCiclo=12
  // Luna escreveu "intervalos médio de 17.5 dias" → bloqueou com DIAS "5"
  test('P2-SAFE reproduction: "17,5 dias" grounded + "12 dias" ciclo → PASS', () => {
    const ctxP2 = Object.freeze({
      tipoOportunidade: null, prioridade: null,
      scoreTotal: 68, classificacao: 'BOM',
      tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
      diasSemComprar: 6,
      pedidosTotal: 22, pedidos30d: 2, pedidos60d: 4, pedidos90d: 6, pedidos180d: 12,
      faturamentoTotal: 11000, faturamento30d: 1000, faturamento60d: 2000,
      faturamento90d: 3000, faturamento180d: 6000, ticketMedioTotal: 500,
      diasEntreComprasMedio: 17.5, diasEntreComprasMediana: 18,
      quantidadeProdutosDistintos: 6, quantidadeCategoriasDistintas: 2,
    });
    const facts = buildGroundingFactsV2(ctxP2, DECISAO_12);
    // Simula o texto que Luna gerou (com "17,5 dias" e "12 dias")
    expect(() => validarFatosNoTextoV2(
      'A recorrência está dentro do padrão, e os dias sem comprar são inferiores aos intervalos médio de 17,5 dias e mediano de 18 dias. Programar a abordagem para o próximo ciclo, em 12 dias.',
      [
        { field: 'diasEntreComprasMedio',   value: 17.5 },
        { field: 'diasEntreComprasMediana', value: 18   },
        { field: 'diasAteProximoCiclo',     value: 12   },
      ],
      facts
    )).not.toThrow();
  });

  // P3-SAFE: NAO_AGIR, diasSemComprar=null, pedidos30/60/90/180=0
  // Luna escreveu "nos últimos 30, 60, 90 e 180 dias" → bloqueou com DIAS "180"
  test('P3-SAFE reproduction: "nos últimos 30, 60, 90 e 180 dias" com pedidos=0 → PASS', () => {
    const facts = buildGroundingFactsV2(CTX_P3_SAFE, DECISAO_NAO_AGIR);
    expect(() => validarFatosNoTextoV2(
      'Não houve pedidos nem faturamento nos últimos 30, 60, 90 e 180 dias.',
      [],
      facts
    )).not.toThrow();
  });

  // P4-SAFE: diasEntreComprasMedio=23.5, diasAteProximoCiclo=9
  // Luna escreveu "intervalo médio entre compras é de 23,5 dias" → bloqueou com DIAS "5"
  test('P4-SAFE reproduction: "23,5 dias" grounded + "9 dias" ciclo → PASS', () => {
    const ctxP4 = Object.freeze({
      tipoOportunidade: null, prioridade: null,
      scoreTotal: 67, classificacao: 'BOM',
      tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
      diasSemComprar: 15,
      pedidosTotal: 22, pedidos30d: 0, pedidos60d: 2, pedidos90d: 4, pedidos180d: 8,
      faturamentoTotal: 11000, faturamento30d: 0, faturamento60d: 1100,
      faturamento90d: 2200, faturamento180d: 4400, ticketMedioTotal: 500,
      diasEntreComprasMedio: 23.5, diasEntreComprasMediana: 24,
      quantidadeProdutosDistintos: 6, quantidadeCategoriasDistintas: 2,
    });
    const facts = buildGroundingFactsV2(ctxP4, DECISAO_9);
    expect(() => validarFatosNoTextoV2(
      'O intervalo médio entre compras é de 23,5 dias e a mediana é de 24 dias. Programar a abordagem para o próximo ciclo, em 9 dias.',
      [
        { field: 'diasEntreComprasMedio',   value: 23.5 },
        { field: 'diasEntreComprasMediana', value: 24   },
        { field: 'diasAteProximoCiclo',     value: 9    },
      ],
      facts
    )).not.toThrow();
  });

  // P4-UNSAFE: diasEntreComprasMedio=10.5 → "10,5 dias" legítimo
  // Mas "7 dias" inventado deve continuar bloqueando
  test('P4-UNSAFE v1: "10,5 dias" grounded + "9 dias" ciclo → PASS (modelo obedeceu)', () => {
    const ctxP4U = Object.freeze({
      tipoOportunidade: null, prioridade: null,
      scoreTotal: 72, classificacao: 'BOM',
      tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
      diasSemComprar: 2,
      pedidosTotal: 28, pedidos30d: 2, pedidos60d: 4, pedidos90d: 7, pedidos180d: 14,
      faturamentoTotal: 14000, faturamento30d: 1000, faturamento60d: 2000,
      faturamento90d: 3500, faturamento180d: 7000, ticketMedioTotal: 500,
      diasEntreComprasMedio: 10.5, diasEntreComprasMediana: 11,
      quantidadeProdutosDistintos: 7, quantidadeCategoriasDistintas: 3,
    });
    const facts = buildGroundingFactsV2(ctxP4U, DECISAO_9);
    expect(() => validarFatosNoTextoV2(
      'A recorrência está DENTRO_DO_PADRAO, com apenas 2 dias sem comprar e intervalo médio de 10,5 dias entre compras. Programar a abordagem para o próximo ciclo, daqui a 9 dias.',
      [
        { field: 'diasSemComprar',          value: 2    },
        { field: 'diasEntreComprasMedio',   value: 10.5 },
        { field: 'diasEntreComprasMediana', value: 11   },
        { field: 'diasAteProximoCiclo',     value: 9    },
      ],
      facts
    )).not.toThrow();
  });

  test('P4-UNSAFE v2: número inventado "7 dias" com diasAteProximoCiclo=9 → BLOCK', () => {
    const ctxP4U = Object.freeze({
      tipoOportunidade: null, prioridade: null,
      scoreTotal: 72, classificacao: 'BOM',
      tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
      diasSemComprar: 2,
      pedidosTotal: 28, pedidos30d: 2, pedidos60d: 4, pedidos90d: 7, pedidos180d: 14,
      faturamentoTotal: 14000, faturamento30d: 1000, faturamento60d: 2000,
      faturamento90d: 3500, faturamento180d: 7000, ticketMedioTotal: 500,
      diasEntreComprasMedio: 10.5, diasEntreComprasMediana: 11,
      quantidadeProdutosDistintos: 7, quantidadeCategoriasDistintas: 3,
    });
    const facts = buildGroundingFactsV2(ctxP4U, DECISAO_9);
    expect(() => validarFatosNoTextoV2(
      'Agende contato em 7 dias.',
      [],
      facts
    )).toThrow(TextFactV2ViolationError);
  });

});

// ── SECURITY: testes de segurança — os bloqueios existentes devem continuar ──

describe('N31.5 — SECURITY: bloqueios existentes inalterados', () => {

  const CTX_SEC = Object.freeze({
    tipoOportunidade:              'AUMENTO_FREQUENCIA',
    prioridade:                    'ALTA',
    scoreTotal:                    80,
    classificacao:                 'MUITO_BOM',
    tendencia:                     'CRESCENDO',
    recorrenciaStatus:             'DENTRO_DO_PADRAO',
    diasSemComprar:                10,
    pedidosTotal:                  30,
    pedidos30d:                    4,
    pedidos60d:                    9,
    pedidos90d:                    15,
    pedidos180d:                   30,
    faturamentoTotal:              8000,
    faturamento30d:                1200,
    faturamento60d:                2500,
    faturamento90d:                4000,
    faturamento180d:               8000,
    ticketMedioTotal:              266,
    diasEntreComprasMedio:         9.0,
    diasEntreComprasMediana:       9,
    quantidadeProdutosDistintos:   8,
    quantidadeCategoriasDistintas: 3,
  });
  const DECISAO_AGIR = Object.freeze({
    decisaoAcaoComercial: 'AGIR_AGORA',
    diasAteProximoCiclo:  null,
  });

  function secFacts() { return buildGroundingFactsV2(CTX_SEC, DECISAO_AGIR); }

  test('SEC-N31.5-01: diasSemComprar inventado → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'O cliente está há 55 dias sem comprar.',
      [{ field: 'diasSemComprar', value: 10 }],
      secFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-02: diasAteProximoCiclo inventado (context AGIR_AGORA, null) → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Entrar em contato nos próximos 30 dias.',
      [{ field: 'diasSemComprar', value: 10 }],
      secFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-03: número de dias inventado sem qualquer fact → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'O prazo para pagamento é de 45 dias.',
      [],
      secFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-04: número de dias inventado "180 dias de prazo" sem âncora → BLOCK', () => {
    // janela 180 autorizada, mas "180 dias de prazo" não tem âncora de janela → BLOCK
    expect(() => validarFatosNoTextoV2(
      'A condição especial tem prazo de 180 dias.',
      [],
      secFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-05: decimal inventado "14,5 dias" (fact é 9.0 inteiro) → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Intervalo médio de 14,5 dias.',
      [],
      secFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-06: urgência sem sinal — "ação urgente necessária" → BLOCK', () => {
    // CTX_SEC tem tipoOportunidade=AUMENTO_FREQUENCIA (não null) → urgência tem sinal → PASS
    // Para testar bloqueio: precisa de contexto sem oportunidade
    const ctxSemOp = { ...CTX_SEC, tipoOportunidade: null, prioridade: null };
    const factsNoOp = buildGroundingFactsV2(ctxSemOp, DECISAO_AGIR);
    expect(() => validarFatosNoTextoV2(
      'Ação urgente necessária agora mesmo.',
      [],
      factsNoOp
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-07: faturamento inventado → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'O cliente faturou R$ 50000 no período.',
      [],
      secFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-N31.5-08: lista de janelas com número inventado no final → BLOCK', () => {
    // "nos últimos 30, 60 e 90 dias" bypassa 90; "45 dias" adicional → BLOCK
    expect(() => validarFatosNoTextoV2(
      'Nos últimos 30, 60 e 90 dias sem pedidos. Contato em 45 dias.',
      [],
      winFacts(DECISAO_8)
    )).toThrow(TextFactV2ViolationError);
  });

});
