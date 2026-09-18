'use strict';

/**
 * N32.2 — WINDOW ANCHOR PRECISION HARDENING
 *
 * 3 FALSE_POSITIVE_VALIDATOR fixes in validarFatosNoTextoV2:
 *   GAP-1: conjunção "ou" em listas de janelas ("30, 60, 90 ou 180 dias")
 *   GAP-2: construção "pedidos em N dias" / "compras em N dias"
 *   GAP-3: construção "faturamento de N dias" e variantes preposicionais
 *
 * Não corrigir:
 *   REAL-SHADOW-002 (MODEL_CONTRACT_VIOLATION) → continua BLOCK
 *   REAL-SHADOW-010 (SCHEMA_OUTPUT_ERROR)      → não abordado aqui
 *
 * OPENAI_CALLS=0 | PROD_WRITES=0 | REAL_DATA=NONE
 */

const {
  buildGroundingFactsV2,
  validarFatosNoTextoV2,
  TextFactV2ViolationError,
} = require('../lib/n29/groundingOutput');

// ── Fixture base ──────────────────────────────────────────────────────────────

const CTX_BASE = Object.freeze({
  tipoOportunidade:              null,
  prioridade:                    null,
  scoreTotal:                    50,
  classificacao:                 'REGULAR',
  tendencia:                     'ESTAVEL',
  recorrenciaStatus:             'DENTRO_DO_PADRAO',
  diasSemComprar:                null,
  pedidosTotal:                  10,
  pedidos30d:                    0,
  pedidos60d:                    0,
  pedidos90d:                    0,
  pedidos180d:                   0,
  faturamentoTotal:              1000,
  faturamento30d:                0,
  faturamento60d:                0,
  faturamento90d:                0,
  faturamento180d:               0,
  ticketMedioTotal:              100,
  diasEntreComprasMedio:         null,
  diasEntreComprasMediana:       null,
  quantidadeProdutosDistintos:   5,
  quantidadeCategoriasDistintas: 2,
});

// Fixture com todas as janelas com dados (para testes de lista)
const CTX_JANELAS_COMPLETAS = Object.freeze({
  ...CTX_BASE,
  pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 0,
  faturamento30d: 0, faturamento60d: 0, faturamento90d: 0, faturamento180d: 0,
});

// Fixture para testes de pedidos
const CTX_PEDIDOS_EM = Object.freeze({
  ...CTX_BASE,
  pedidos30d: 5,
  pedidos60d: 7,
  pedidos180d: 16,
  faturamento30d: 500,
  faturamento180d: 1600,
  diasSemComprar: 0,
  diasEntreComprasMediana: 8,
  diasAteProximoCiclo: 8,  // não existe no schema base, mas aceito via decisao
});

// Fixture para testes de faturamento
const CTX_FATURAMENTO_DE = Object.freeze({
  ...CTX_BASE,
  pedidos180d: 6,
  faturamento60d: 92.87,
  faturamento180d: 776.39,
  diasSemComprar: 31,
  diasEntreComprasMedio: 30.43,
  diasEntreComprasMediana: 22,
});

// Fixture REAL-SHADOW-002 (continua BLOCK)
const CTX_SHADOW_002 = Object.freeze({
  ...CTX_BASE,
  tipoOportunidade: 'REATIVACAO_120D',
  prioridade: 90,
  scoreTotal: 11,
  classificacao: 'INATIVO',
  diasSemComprar: 225,
  tendencia: 'SEM_BASE',
  recorrenciaStatus: 'SEM_BASE',
  pedidosTotal: 1,
  pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 0,
  faturamentoTotal: 200,
  faturamento30d: 0, faturamento60d: 0, faturamento90d: 0, faturamento180d: 0,
  ticketMedioTotal: 200,
});

// Fixture REAL-SHADOW-007 (lista com "ou" — devia PASS)
const CTX_SHADOW_007 = Object.freeze({
  ...CTX_BASE,
  tipoOportunidade: 'REATIVACAO_120D',
  prioridade: 50,
  scoreTotal: 17,
  classificacao: 'INATIVO',
  diasSemComprar: 690,
  tendencia: 'SEM_BASE',
  recorrenciaStatus: 'SEM_BASE',
  pedidosTotal: 1,
  pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 0,
  faturamento30d: 0, faturamento60d: 0, faturamento90d: 0, faturamento180d: 0,
});

// Helpers
function buildFacts(ctx, decisao) {
  return buildGroundingFactsV2(ctx, decisao || null);
}

function shouldPass(facts, texto, claims) {
  expect(() => validarFatosNoTextoV2(texto, claims || [], facts)).not.toThrow();
}

function shouldBlock(facts, texto, claims) {
  expect(() => validarFatosNoTextoV2(texto, claims || [], facts)).toThrow(TextFactV2ViolationError);
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. LISTA COM "OU" — GAP-1
// ═══════════════════════════════════════════════════════════════════════════════

describe('N32.2-A: Lista com "ou" (GAP-1)', () => {
  const facts = buildFacts(CTX_JANELAS_COMPLETAS);

  test('A1: "30, 60, 90 ou 180 dias" com âncora "nos últimos" → PASS', () => {
    shouldPass(facts,
      'O cliente não registra pedidos nos últimos 30, 60, 90 ou 180 dias.',
      []
    );
  });

  test('A2: "30 ou 60 dias" com âncora "nos últimos" → PASS', () => {
    shouldPass(facts,
      'Ausência de compras nos últimos 30 ou 60 dias indica redução de frequência.',
      []
    );
  });

  test('A3: "60, 90 ou 180 dias" (lista parcial) → PASS', () => {
    shouldPass(facts,
      'Nenhum faturamento nos últimos 60, 90 ou 180 dias.',
      [{ field: 'faturamento60d', value: 0 }]
    );
  });

  test('A4: "30, 60, 90 e 180 dias" (conjunção "e" existente) → PASS', () => {
    shouldPass(facts,
      'Zero pedidos nos últimos 30, 60, 90 e 180 dias.',
      []
    );
  });

  test('A5: misto vírgula e "ou": "30, 60 ou 90 dias" → PASS', () => {
    shouldPass(facts,
      'Sem compras nos últimos 30, 60 ou 90 dias.',
      []
    );
  });

  test('A6: apenas "ou" sem vírgulas: "90 ou 180 dias" → PASS', () => {
    shouldPass(facts,
      'Inatividade nos últimos 90 ou 180 dias.',
      []
    );
  });

  test('A7: "ou" em texto não conectado com lista de janelas → BLOCK', () => {
    // "nos últimos 30 dias" passa (âncora), mas "180 dias" no final não tem âncora
    // este cenário não deve causar bypass indevido
    const factsLocal = buildFacts({ ...CTX_BASE, pedidos30d: 0, faturamento30d: 0, diasSemComprar: 225 });
    shouldBlock(factsLocal,
      'Não comprou nos últimos 30 dias ou está há 225 dias sem comprar há 180 dias inativo.',
      []
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. PEDIDOS EM N DIAS — GAP-2
// ═══════════════════════════════════════════════════════════════════════════════

describe('N32.2-B: "pedidos em N dias" (GAP-2)', () => {
  const facts = buildFacts(CTX_PEDIDOS_EM, { decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 8 });

  test('B1: "5 pedidos em 30 dias" com pedidos30d=5 → PASS', () => {
    shouldPass(facts,
      'Foram registrados 5 pedidos em 30 dias no período.',
      [{ field: 'pedidos30d', value: 5 }]
    );
  });

  test('B2: "nenhum pedido em 180 dias" com pedidos180d=0 → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos180d: 0, faturamento180d: 0 });
    shouldPass(f,
      'Não houve nenhum pedido em 180 dias.',
      []
    );
  });

  test('B3: "houve 7 pedidos em 60 dias" com pedidos60d=7 → PASS', () => {
    shouldPass(facts,
      'O cliente realizou 7 pedidos em 60 dias, demonstrando boa frequência.',
      [{ field: 'pedidos60d', value: 7 }]
    );
  });

  test('B4: "0 compras em 30 dias" com pedidos30d=0 → PASS', () => {
    shouldPass(facts,
      'Registrou 0 compras em 30 dias.',
      []
    );
  });

  test('B5: "pedido em 30 dias" (singular) → PASS', () => {
    shouldPass(facts,
      'Apenas 1 pedido em 30 dias foi registrado.',
      [{ field: 'pedidos30d', value: 5 }]
    );
  });

  test('B6: "5 compras em 30 dias" com pedidos30d=5 → PASS', () => {
    shouldPass(facts,
      'Realizou 5 compras em 30 dias.',
      [{ field: 'pedidos30d', value: 5 }]
    );
  });

  test('B7 anti-bypass: "ligar em 30 dias" sem âncora métrica → BLOCK', () => {
    // diasAteProximoCiclo=8, 30 não em diasFacts → BLOCK
    shouldBlock(facts,
      'Programar retorno: ligar em 30 dias.',
      []
    );
  });

  test('B8 anti-bypass: "retornar em 30 dias" → BLOCK', () => {
    shouldBlock(facts,
      'Ideal retornar em 30 dias para acompanhar.',
      []
    );
  });

  test('B9 anti-bypass: "nova abordagem em 30 dias" → BLOCK', () => {
    shouldBlock(facts,
      'Fazer nova abordagem em 30 dias.',
      []
    );
  });

  test('B10 anti-bypass: "aguardar 30 dias" (sem "em") → BLOCK', () => {
    // "30 dias" sem âncora metric, 30 não em diasFacts → BLOCK
    shouldBlock(facts,
      'Aguardar 30 dias antes de contatar novamente.',
      []
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. FATURAMENTO DE N DIAS — GAP-3
// ═══════════════════════════════════════════════════════════════════════════════

describe('N32.2-C: "faturamento de N dias" (GAP-3)', () => {
  const facts = buildFacts(CTX_FATURAMENTO_DE);

  test('C1: "faturamento de 180 dias foi R$ 776,39" → PASS', () => {
    shouldPass(facts,
      'O faturamento de 180 dias foi R$ 776,39, enquanto nos últimos 60 dias foi R$ 92,87.',
      [
        { field: 'faturamento180d', value: 776.39 },
        { field: 'faturamento60d', value: 92.87 },
      ]
    );
  });

  test('C2: "faturamento dos últimos 180 dias" → PASS', () => {
    shouldPass(facts,
      'O faturamento dos últimos 180 dias totalizou R$ 776,39.',
      [{ field: 'faturamento180d', value: 776.39 }]
    );
  });

  test('C3: "faturamento no período de 90 dias" com faturamento90d → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos90d: 2, faturamento90d: 326.9 });
    shouldPass(f,
      'O faturamento no período de 90 dias foi R$ 326,90.',
      [{ field: 'faturamento90d', value: 326.9 }]
    );
  });

  test('C4: "faturamento de 60 dias" com faturamento60d → PASS', () => {
    shouldPass(facts,
      'O faturamento de 60 dias foi R$ 92,87.',
      [{ field: 'faturamento60d', value: 92.87 }]
    );
  });

  test('C5: "faturamento de 30 dias" com faturamento30d → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos30d: 3, faturamento30d: 300 });
    shouldPass(f,
      'O faturamento de 30 dias atingiu R$ 300,00.',
      [{ field: 'faturamento30d', value: 300 }]
    );
  });

  test('C6: "faturamento dos últimos 60 dias" → PASS', () => {
    shouldPass(facts,
      'O faturamento dos últimos 60 dias foi R$ 92,87.',
      [{ field: 'faturamento60d', value: 92.87 }]
    );
  });

  test('C7 anti-bypass: "prazo de 30 dias" sem "faturamento" → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos30d: 0, faturamento30d: 0, diasAteProximoCiclo: 8 },
                         { decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 8 });
    shouldBlock(f,
      'Oferecer prazo de 30 dias para pagamento.',
      []
    );
  });

  test('C8 anti-bypass: "condição de 30 dias" → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos30d: 0, faturamento30d: 0 });
    shouldBlock(f,
      'Oferecer condição de 30 dias no boleto.',
      []
    );
  });

  test('C9 anti-bypass: "dar prazo de pagamento de 180 dias" → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos180d: 0, faturamento180d: 0 });
    shouldBlock(f,
      'Sugere-se dar prazo de pagamento de 180 dias.',
      []
    );
  });

  test('C10 anti-bypass: janela180 autorizada mas "ligar em 180 dias" → BLOCK', () => {
    // 180 authorized via faturamento180d, but "ligar em" has no metric anchor
    // also diasAteProximoCiclo not 180 → BLOCK via diasFacts mismatch
    const f = buildFacts({ ...CTX_BASE, pedidos180d: 0, faturamento180d: 0, diasSemComprar: 31 });
    shouldBlock(f,
      'Faturamento baixo; ligar em 180 dias para reativar.',
      []
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. ANTI-BYPASS ABRANGENTE
// ═══════════════════════════════════════════════════════════════════════════════

describe('N32.2-D: Anti-bypass', () => {

  test('D1: dias inventados sem qualquer âncora → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, diasSemComprar: 45 });
    shouldBlock(f, 'Cliente está há 90 dias sem comprar.', []);
  });

  test('D2: diasSemComprar inventado → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, diasSemComprar: null });
    shouldBlock(f, 'Há 30 dias sem comprar.', []);
  });

  test('D3: diasAteProximoCiclo não coincide → BLOCK', () => {
    const f = buildFacts(CTX_BASE, { decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 8 });
    shouldBlock(f, 'Próxima visita em 30 dias.', []);
  });

  test('D4: janela autorizada mas contexto de ação imediata → BLOCK', () => {
    // pedidos30d=0 autoriza janela30, mas "ligar em 30 dias" usa "em" sem "pedidos"
    const f = buildFacts({ ...CTX_BASE, pedidos30d: 0, faturamento30d: 0,
                           diasSemComprar: 90, diasAteProximoCiclo: null },
                         null);
    shouldBlock(f, 'Ligar em 30 dias para tentar reativação.', []);
  });

  test('D5: "ou" fora de lista de janelas não bypassa → BLOCK', () => {
    // "180 dias" no contexto "ligue em 180 dias" não tem âncora "últimos" no ctxAntes imediato
    const f = buildFacts({ ...CTX_BASE, pedidos180d: 0, faturamento180d: 0, diasSemComprar: 200 });
    shouldBlock(f,
      'Faturamento caiu. Ligue em 180 dias ou descarte.',
      []
    );
  });

  test('D6: "de N dias" genérico sem "faturamento" → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos30d: 0, faturamento30d: 0 });
    shouldBlock(f, 'Oferta de 30 dias de carência no pagamento.', []);
  });

  test('D7: inatividade inventada com valor errado → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, diasSemComprar: 120 });
    shouldBlock(f, 'Cliente está há 90 dias sem comprar.', []);
  });

  test('D8: urgência sem sinal determinístico → BLOCK', () => {
    const f = buildFacts({ ...CTX_BASE, tipoOportunidade: null, prioridade: null });
    expect(() => validarFatosNoTextoV2(
      'Entre em contato imediatamente com o cliente.',
      [],
      f
    )).toThrow(TextFactV2ViolationError);
  });

  test('D9: R$ sem claim → BLOCK', () => {
    const f = buildFacts(CTX_BASE);
    shouldBlock(f, 'Cliente tem faturamento de R$ 5000 no período.', []);
  });

  test('D10: data ISO inventada → BLOCK', () => {
    const f = buildFacts(CTX_BASE);
    shouldBlock(f, 'Última compra em 2026-01-15.', []);
  });

  test('D11: "ou" em lista com janela não autorizada → BLOCK para o N não autorizado', () => {
    // pedidos30d=0 autoriza janela30; pedidos180d=null+faturamento180d=null → janela180 NÃO autorizada
    // "180 dias" na lista: janelasAutorizadas.has(180)=false → _ehReferenciaJanela=false
    // diasFacts=[] (tudo null) → 180 não coincide → BLOCK
    const f = buildFacts({
      ...CTX_BASE,
      pedidos30d: 0, faturamento30d: 0,   // janela30 autorizada
      pedidos180d: null, faturamento180d: null, // janela180 NÃO autorizada
    });
    shouldBlock(f,
      'Nenhum pedido nos últimos 30 ou 180 dias.',
      []
    );
  });

  test('D12: "faturamento de N dias" onde N não é janela autorizada → BLOCK', () => {
    // faturamento45d não existe no schema — 45 não é {30,60,90,180}
    const f = buildFacts({ ...CTX_BASE, faturamento180d: 500 });
    shouldBlock(f, 'O faturamento de 45 dias foi R$ 200,00.', [
      { field: 'faturamento180d', value: 500 },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. REPRODUÇÕES N32 EXATAS
// ═══════════════════════════════════════════════════════════════════════════════

describe('N32.2-E: Reproduções N32 exatas', () => {

  test('E1 (REAL-SHADOW-004 repro): "O faturamento de 180 dias foi R$ 776,39" → PASS', () => {
    const facts = buildFacts(CTX_FATURAMENTO_DE);
    // Reproduz o padrão exato do sinaisRelevantes[2] de SHADOW-004
    shouldPass(facts,
      'O faturamento de 180 dias foi R$ 776,39, enquanto nos últimos 60 dias foi R$ 92,87.',
      [
        { field: 'faturamento180d', value: 776.39 },
        { field: 'faturamento60d', value: 92.87 },
      ]
    );
  });

  test('E2 (REAL-SHADOW-005 repro): "Foram registrados 5 pedidos em 30 dias" → PASS', () => {
    const facts = buildFacts(CTX_PEDIDOS_EM, { decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 8 });
    // Reproduz o padrão exato do sinaisRelevantes[2] de SHADOW-005
    shouldPass(facts,
      'Foram registrados 5 pedidos em 30 dias, com intervalo mediano de 8 dias.',
      [{ field: 'pedidos30d', value: 5 }]
    );
  });

  test('E3 (REAL-SHADOW-007 repro): "nos últimos 30, 60, 90 ou 180 dias" → PASS', () => {
    const facts = buildFacts(CTX_SHADOW_007);
    // Reproduz o padrão exato do diagnostico de SHADOW-007
    shouldPass(facts,
      'O cliente está há 690 dias sem comprar e não registra pedidos nos últimos 30, 60, 90 ou 180 dias.',
      []
    );
  });

  test('E4 (REAL-SHADOW-002 repro): "realizado há mais de 180 dias" → CONTINUA BLOCK', () => {
    const facts = buildFacts(CTX_SHADOW_002);
    // Reproduz o padrão exato de SHADOW-002: "realizado há mais de 180 dias"
    // diasFacts=[225], 180 ≠ 225, sem âncora → BLOCK esperado (MODEL_CONTRACT_VIOLATION)
    shouldBlock(facts,
      'Possui apenas 1 pedido, realizado há mais de 180 dias.',
      []
    );
  });

  test('E5 (REAL-SHADOW-002): "nos últimos 30, 60, 90 e 180 dias" no mesmo cliente → PASS', () => {
    // Esta construção em sinaisRelevantes de 002 passava antes e deve continuar passando
    const facts = buildFacts(CTX_SHADOW_002);
    shouldPass(facts,
      'Ausência de compras nos últimos 30, 60, 90 e 180 dias, indicando inatividade prolongada.',
      []
    );
  });

  test('E6 (REAL-SHADOW-010 schema): "REいATIVACAO_120D" continua violação de claims', () => {
    // Confirma que malformed enum não passa por validarClaimsV2
    const { validarClaimsV2, GroundingV2ViolationError } = require('../lib/n29/groundingOutput');
    const f = buildFacts({
      ...CTX_BASE,
      tipoOportunidade: 'REATIVACAO_120D',
      prioridade: 72,
      diasSemComprar: 404,
      diasEntreComprasMedio: 204.5,
      diasEntreComprasMediana: 204.5,
      pedidos180d: 0, faturamento180d: 0,
    });
    expect(() => validarClaimsV2(
      [{ field: 'oportunidadeTipo', value: 'REいATIVACAO_120D' }],
      f
    )).toThrow(GroundingV2ViolationError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. REGRESSÃO — comportamento anterior preservado
// ═══════════════════════════════════════════════════════════════════════════════

describe('N32.2-F: Regressão — comportamento N31.x preservado', () => {

  test('F1: "nos últimos 180 dias" singular → PASS (N31.3)', () => {
    const f = buildFacts({ ...CTX_BASE, pedidos180d: 0, faturamento180d: 0 });
    shouldPass(f, 'Não houve pedidos nos últimos 180 dias.', []);
  });

  test('F2: "nos últimos 30, 60, 90 e 180 dias" com e → PASS (N31.5)', () => {
    const f = buildFacts(CTX_JANELAS_COMPLETAS);
    shouldPass(f, 'Zero faturamento nos últimos 30, 60, 90 e 180 dias.', []);
  });

  test('F3: decimal "17,5 dias" → PASS sem falso split (N31.5 Fix1)', () => {
    const f = buildFacts({ ...CTX_BASE, diasEntreComprasMedio: 17.5 });
    shouldPass(f, 'Intervalo médio de 17,5 dias entre compras.', []);
  });

  test('F4: decimal "23.5 dias" → PASS (N31.5 Fix1)', () => {
    const f = buildFacts({ ...CTX_BASE, diasEntreComprasMediana: 23.5 });
    shouldPass(f, 'Mediana de 23.5 dias entre compras.', []);
  });

  test('F5: diasSemComprar correto → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, diasSemComprar: 45 });
    shouldPass(f, 'O cliente está há 45 dias sem comprar.', []);
  });

  test('F6: diasAteProximoCiclo correto → PASS', () => {
    const f = buildFacts(CTX_BASE, { decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 12 });
    shouldPass(f, 'Próximo ciclo em 12 dias.', []);
  });

  test('F7: R$ com claim correto → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, faturamento30d: 500 });
    shouldPass(f, 'Faturou R$ 500,00 nos últimos 30 dias.', [
      { field: 'faturamento30d', value: 500 },
    ]);
  });

  test('F8: urgência com oportunidade definida → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, tipoOportunidade: 'REATIVACAO_120D', prioridade: 80,
                           diasSemComprar: 150 });
    shouldPass(f,
      'O cliente está há 150 dias sem comprar — entre em contato imediatamente.',
      []
    );
  });

  test('F9: negação de urgência → PASS (N31.3)', () => {
    const f = buildFacts({ ...CTX_BASE });
    shouldPass(f, 'Não há necessidade de ação imediata no momento.', []);
  });

  test('F10: score correto → PASS', () => {
    const f = buildFacts({ ...CTX_BASE, scoreTotal: 75 });
    shouldPass(f, 'Score comercial de 75 pontos.', []);
  });
});
