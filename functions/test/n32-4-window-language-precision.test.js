'use strict';
/**
 * N32.4 — Window Language Precision Hardening II
 * GAP-4: "no período de N dias" / "na janela de N dias" (âncora locativa analítica)
 * GAP-5: "N em M dias" — elipse de métrica em estrutura coordenada local
 *
 * OPENAI_CALLS=0
 */

const {
  buildGroundingFactsV2,
  validarFatosNoTextoV2,
  REGEX_ANCORA_PERIODO_ANALITICO,
  REGEX_ANCORA_ELIPSE_PEDIDOS,
  _ehElipseMetricaLocal,
  TextFactV2ViolationError,
} = require('../lib/n29/groundingOutput');

// ── Fixture builder ─────────────────────────────────────────────────────────

function buildFacts(ctxPartial, decisao = null) {
  const CTX_DEFAULTS = {
    tipoOportunidade:          null,
    scoreTotal:                50,
    classificacao:             'REGULAR',
    diasSemComprar:            45,
    tendencia:                 'ESTAVEL',
    recorrenciaStatus:         'DENTRO_DO_PADRAO',
    prioridade:                null,
    pedidosTotal:              10,
    pedidos30d:                null,
    pedidos60d:                null,
    pedidos90d:                null,
    pedidos180d:               null,
    faturamentoTotal:          1000,
    faturamento30d:            null,
    faturamento60d:            null,
    faturamento90d:            null,
    faturamento180d:           null,
    ticketMedioTotal:          100,
    diasEntreComprasMedio:     45,
    diasEntreComprasMediana:   30,
    quantidadeProdutosDistintos:   5,
    quantidadeCategoriasDistintas: 2,
  };
  return buildGroundingFactsV2({ ...CTX_DEFAULTS, ...ctxPartial }, decisao);
}

// ── Cenários principais ──────────────────────────────────────────────────────

// GAP-4: janelas 30/60/90/180 todas autorizadas + diasSemComprar=31 (≠ todas as janelas)
const CTX_PERIODO_DE = {
  tipoOportunidade:   'QUEDA_DE_COMPRAS',
  prioridade:         65,
  diasSemComprar:     31,
  diasEntreComprasMedio: 30.43,
  diasEntreComprasMediana: 22,
  pedidosTotal:       9,
  pedidos30d:         0,
  pedidos60d:         2,
  pedidos90d:         2,
  pedidos180d:        6,
  faturamento30d:     0,
  faturamento60d:     92.87,
  faturamento90d:     92.87,
  faturamento180d:    776.39,
};

// GAP-5: pedidos30d=5, pedidos60d=6, pedidos90d=13, pedidos180d=16 (diasSemComprar=0)
const CTX_ELIPSE = {
  tipoOportunidade:   null,
  scoreTotal:         94,
  classificacao:      'EXCELENTE',
  diasSemComprar:     0,
  tendencia:          'CRESCENDO',
  recorrenciaStatus:  'DENTRO_DO_PADRAO',
  pedidosTotal:       17,
  pedidos30d:         5,
  pedidos60d:         6,
  pedidos90d:         13,
  pedidos180d:        16,
  faturamento30d:     319.86,
  faturamento60d:     368.86,
  faturamento90d:     1122.67,
  faturamento180d:    1483.11,
  diasEntreComprasMedio:   15.67,
  diasEntreComprasMediana: 8,
};

// Somente janela 30 autorizada
const CTX_ONLY_30 = {
  diasSemComprar:  15,
  pedidos30d:      3,
  pedidos60d:      null,
  pedidos90d:      null,
  pedidos180d:     null,
  faturamento30d:  50,
  faturamento60d:  null,
  faturamento90d:  null,
  faturamento180d: null,
};

// Controle negativo N32.2 (diasSemComprar=225, janelas 30/60/90/180 todas =0 ≠ null)
const CTX_SHADOW_002 = {
  tipoOportunidade:   'REATIVACAO_120D',
  prioridade:         90,
  scoreTotal:         11,
  classificacao:      'INATIVO',
  diasSemComprar:     225,
  tendencia:          'SEM_BASE',
  recorrenciaStatus:  'SEM_BASE',
  pedidosTotal:       1,
  pedidos30d:         0,
  pedidos60d:         0,
  pedidos90d:         0,
  pedidos180d:        0,
  faturamentoTotal:   200,
  faturamento30d:     0,
  faturamento60d:     0,
  faturamento90d:     0,
  faturamento180d:    0,
};

// ── Helpers de teste ─────────────────────────────────────────────────────────

function shouldPass(texto, ctxPartial, claims = [], decisaoPartial = { decisaoAcaoComercial: 'AGIR_AGORA', diasAteProximoCiclo: null }) {
  const facts = buildFacts(ctxPartial, decisaoPartial);
  expect(() => validarFatosNoTextoV2(texto, claims, facts)).not.toThrow();
}

function shouldBlock(texto, ctxPartial, claims = [], decisaoPartial = { decisaoAcaoComercial: 'AGIR_AGORA', diasAteProximoCiclo: null }) {
  const facts = buildFacts(ctxPartial, decisaoPartial);
  expect(() => validarFatosNoTextoV2(texto, claims, facts)).toThrow(TextFactV2ViolationError);
}

function shouldBlockWith(texto, ctxPartial, tipo, valor, claims = [], decisaoPartial = { decisaoAcaoComercial: 'AGIR_AGORA', diasAteProximoCiclo: null }) {
  const facts = buildFacts(ctxPartial, decisaoPartial);
  expect(() => validarFatosNoTextoV2(texto, claims, facts)).toThrow(
    expect.objectContaining({ tipo, encontrado: valor })
  );
}

// ── SEÇÃO A — GAP-4 PASS ─────────────────────────────────────────────────────
describe('N32.4-A: GAP-4 PASS — período/janela locativo analítico', () => {
  test('A1: "No período de 180 dias, realizou 6 pedidos" → PASS', () => {
    shouldPass('No período de 180 dias, realizou 6 pedidos.', CTX_PERIODO_DE);
  });

  test('A2: "Nesse período de 180 dias" → PASS', () => {
    shouldPass('Nesse período de 180 dias, houve atividade.', CTX_PERIODO_DE);
  });

  test('A3: "Neste período de 60 dias, houve 2 pedidos" → PASS', () => {
    shouldPass('Neste período de 60 dias, houve 2 pedidos.', CTX_PERIODO_DE);
  });

  test('A4: "Na janela de 90 dias, foram registrados 2 pedidos" → PASS', () => {
    shouldPass('Na janela de 90 dias, foram registrados 2 pedidos.', CTX_PERIODO_DE);
  });

  test('A5: "Considerando o período de 30 dias" → PASS', () => {
    shouldPass('Considerando o período de 30 dias, sem pedidos registrados.', CTX_PERIODO_DE);
  });

  test('A6: "Nesta janela de 180 dias, o cliente realizou 6 pedidos" → PASS', () => {
    shouldPass('Nesta janela de 180 dias, o cliente realizou 6 pedidos.', CTX_PERIODO_DE);
  });

  test('A7: "No intervalo de 90 dias, registrou-se 2 pedidos" → PASS', () => {
    shouldPass('No intervalo de 90 dias, registrou-se 2 pedidos.', CTX_PERIODO_DE);
  });

  test('A8: case-insensitive — "NO PERÍODO DE 90 DIAS" → PASS', () => {
    shouldPass('NO PERÍODO DE 90 DIAS, FORAM REGISTRADOS 2 PEDIDOS.', CTX_PERIODO_DE);
  });
});

// ── SEÇÃO B — GAP-4 BLOCK ────────────────────────────────────────────────────
describe('N32.4-B: GAP-4 BLOCK — âncora ausente ou de ação', () => {
  test('B1: "aguarde um período de 180 dias" → BLOCK', () => {
    shouldBlock('aguarde um período de 180 dias para nova avaliação.', CTX_PERIODO_DE);
  });

  test('B2: "retorne após um período de 180 dias" → BLOCK', () => {
    shouldBlock('Retorne após um período de 180 dias.', CTX_PERIODO_DE);
  });

  test('B3: "faça contato em um período de 180 dias" → BLOCK', () => {
    shouldBlock('Faça contato em um período de 180 dias.', CTX_PERIODO_DE);
  });

  test('B4: "condição de pagamento por período de 180 dias" → BLOCK', () => {
    shouldBlock('Ofereça condição de pagamento por período de 180 dias.', CTX_PERIODO_DE);
  });

  test('B5: "espere um período de 60 dias" → BLOCK', () => {
    shouldBlock('Espere um período de 60 dias antes de contatar.', CTX_PERIODO_DE);
  });

  test('B6: "por um período de 90 dias" → BLOCK (preposição de duração, não locativa)', () => {
    shouldBlock('O cliente ficou por um período de 90 dias sem comprar.', CTX_PERIODO_DE);
  });

  test('B7: "um período de 180 dias" sem preposição → BLOCK', () => {
    shouldBlock('Trata-se de um período de 180 dias de inatividade.', CTX_PERIODO_DE);
  });

  test('B8: janela não autorizada — "No período de 60 dias" (CTX_ONLY_30) → BLOCK', () => {
    shouldBlock('No período de 60 dias, houve poucos pedidos.', CTX_ONLY_30);
  });

  test('B9: "prazo de 180 dias" (sem palavra período/janela) → BLOCK', () => {
    shouldBlock('Ofereça prazo de 180 dias para pagamento.', CTX_PERIODO_DE);
  });

  test('B10: "na condição de 180 dias" (palavra errada após "na") → BLOCK', () => {
    shouldBlock('O cliente está na condição de 180 dias de avaliação.', CTX_PERIODO_DE);
  });
});

// ── SEÇÃO C — GAP-5 PASS ─────────────────────────────────────────────────────
describe('N32.4-C: GAP-5 PASS — elipse de métrica em estrutura coordenada', () => {
  test('C1: "5 pedidos em 30 dias e 13 em 90 dias" → PASS', () => {
    shouldPass('Foram registrados 5 pedidos em 30 dias e 13 em 90 dias.', CTX_ELIPSE);
  });

  test('C2: "5 pedidos em 30 dias ou 13 em 90 dias" → PASS (usando "ou")', () => {
    shouldPass('5 pedidos em 30 dias ou 13 em 90 dias.', CTX_ELIPSE);
  });

  test('C3: "5 compras em 30 dias e 13 em 90 dias" → PASS (usando "compras")', () => {
    shouldPass('5 compras em 30 dias e 13 em 90 dias.', CTX_ELIPSE);
  });

  test('C4: "5 pedidos em 30 dias e 16 em 180 dias" → PASS', () => {
    shouldPass('5 pedidos em 30 dias e 16 em 180 dias.', CTX_ELIPSE);
  });

  test('C5: "5 pedidos em 30 dias e 6 em 60 dias" → PASS', () => {
    shouldPass('5 pedidos em 30 dias e 6 em 60 dias.', CTX_ELIPSE);
  });

  test('C6: elipse com texto ao redor → PASS', () => {
    shouldPass(
      'Atividade recente consistente, com 5 pedidos em 30 dias e 13 em 90 dias.',
      CTX_ELIPSE
    );
  });

  test('C7: elipse com texto posterior → PASS', () => {
    shouldPass(
      '5 pedidos em 30 dias e 13 em 90 dias, indicando tendência crescente.',
      CTX_ELIPSE
    );
  });

  test('C8: frase completa com sujeito → PASS', () => {
    shouldPass(
      'O cliente registrou 5 pedidos em 30 dias e 13 em 90 dias.',
      CTX_ELIPSE
    );
  });
});

// ── SEÇÃO D — GAP-5 BLOCK ────────────────────────────────────────────────────
describe('N32.4-D: GAP-5 BLOCK — anti-bypass de elipse', () => {
  test('D1: "5 pedidos em 30 dias e ligar em 90 dias" → BLOCK (verbo de ação)', () => {
    shouldBlock('Foram 5 pedidos em 30 dias e ligar em 90 dias.', CTX_ELIPSE);
  });

  test('D2: "5 pedidos em 30 dias e retornar em 90 dias" → BLOCK', () => {
    shouldBlock('5 pedidos em 30 dias e retornar em 90 dias.', CTX_ELIPSE);
  });

  test('D3: mudança de cláusula por ponto — "5 pedidos em 30 dias. Contatar em 90 dias." → BLOCK', () => {
    shouldBlock('5 pedidos em 30 dias. Contatar em 90 dias.', CTX_ELIPSE);
  });

  test('D4: separação por ponto-e-vírgula — "5 pedidos em 30 dias; aguardar 90 dias" → BLOCK', () => {
    shouldBlock('5 pedidos em 30 dias; aguardar 90 dias.', CTX_ELIPSE);
  });

  test('D5: contagem errada — "5 pedidos em 30 dias e 99 em 90 dias" (pedidos90d=13) → BLOCK', () => {
    shouldBlockWith(
      '5 pedidos em 30 dias e 99 em 90 dias.',
      CTX_ELIPSE, 'DIAS', '90'
    );
  });

  test('D6: mudança semântica — "5 pedidos em 30 dias e cliente está há 90 dias" → BLOCK', () => {
    // diasSemComprar=0, 90 não está em diasFacts, não é elipse válida
    shouldBlock('5 pedidos em 30 dias e cliente está há 90 dias sem comprar.', CTX_ELIPSE);
  });

  test('D7: "5 pedidos em 30 dias e prazo de 90 dias" → BLOCK (sem dígito antes de "em")', () => {
    shouldBlock('5 pedidos em 30 dias e prazo de 90 dias.', CTX_ELIPSE);
  });

  test('D8: "5 pedidos em 30 dias e pagamento em 90 dias" → BLOCK (sem dígito antes de "em")', () => {
    shouldBlock('5 pedidos em 30 dias e pagamento em 90 dias.', CTX_ELIPSE);
  });

  test('D9: janela alvo não autorizada — pedidos90d=null → BLOCK', () => {
    const ctxSem90 = { ...CTX_ELIPSE, pedidos90d: null, faturamento90d: null };
    shouldBlock('5 pedidos em 30 dias e 13 em 90 dias.', ctxSem90);
  });

  test('D10: janela N1 não autorizada — pedidos60d=null e "5 pedidos em 60 dias e 13 em 90 dias" → BLOCK para 90', () => {
    // pedidos60d=null → N1=60 não é janela autorizada → elipse inválida
    const ctxSem60 = { ...CTX_ELIPSE, pedidos60d: null, faturamento60d: null };
    // "5 pedidos em 60 dias" → bloqueia no DIAS(60) já que 60 não está autorizado
    // mas mesmo que passasse, o N1=60 check em _ehElipseMetricaLocal bloquearia
    shouldBlock('5 pedidos em 60 dias e 13 em 90 dias.', ctxSem60);
  });

  test('D11: ordem inversa — "13 em 90 dias e 5 pedidos em 30 dias" → BLOCK para 90 (aparece antes da âncora)', () => {
    // "90 dias" aparece antes de "pedidos em 30 dias" → ctxAntes para 90 = "13 em "
    // sem estrutura coordenada completa → BLOCK
    shouldBlock('13 em 90 dias e 5 pedidos em 30 dias.', CTX_ELIPSE);
  });

  test('D12: separador não suportado — "5 pedidos em 30 dias, sendo 13 em 90 dias" → BLOCK', () => {
    // "sendo" não é "e" nem "ou" → regex não casa
    shouldBlock('5 pedidos em 30 dias, sendo 13 em 90 dias.', CTX_ELIPSE);
  });
});

// ── SEÇÃO E — REPRODUÇÕES REAIS N32.3 ───────────────────────────────────────
describe('N32.4-E: Reproduções reais N32.3', () => {
  test('E1 GAP4_REAL_REPRO: "No período de 180 dias, realizou 6 pedidos e faturou R$ 776,39" + claims → PASS', () => {
    const claims = [
      { field: 'pedidos180d',   value: 6 },
      { field: 'faturamento180d', value: 776.39 },
    ];
    shouldPass(
      'No período de 180 dias, realizou 6 pedidos e faturou R$ 776,39.',
      CTX_PERIODO_DE,
      claims
    );
  });

  test('E2 GAP5_REAL_REPRO: "5 pedidos em 30 dias e 13 em 90 dias" (sinaisRelevantes N32.3-005) → PASS', () => {
    shouldPass(
      'Atividade recente consistente, com 5 pedidos em 30 dias e 13 em 90 dias.',
      CTX_ELIPSE
    );
  });
});

// ── SEÇÃO F — REGRESSÃO N32.2/N31.5/N32.3 ──────────────────────────────────
describe('N32.4-F: Regressão — fixas anteriores preservadas', () => {
  test('F1: GAP-1 preservado — "nos últimos 30, 60, 90 ou 180 dias" → PASS', () => {
    shouldPass(
      'O cliente não realizou pedidos nos últimos 30, 60, 90 ou 180 dias.',
      CTX_PERIODO_DE
    );
  });

  test('F2: GAP-2 preservado — "5 pedidos em 30 dias" → PASS', () => {
    shouldPass('Foram registrados 5 pedidos em 30 dias.', CTX_ELIPSE);
  });

  test('F3: GAP-3 preservado — "faturamento de 180 dias foi R$ 776,39" → PASS', () => {
    const claims = [{ field: 'faturamento180d', value: 776.39 }];
    shouldPass('O faturamento de 180 dias foi R$ 776,39.', CTX_PERIODO_DE, claims);
  });

  test('F4: REAL-SHADOW-002 pattern ainda bloqueia — "há mais de 180 dias" (diasSemComprar=225) → BLOCK', () => {
    shouldBlockWith(
      'Cliente inativo há mais de 180 dias.',
      CTX_SHADOW_002, 'DIAS', '180'
    );
  });

  test('F5: days invented still blocks — "aguardar 777 dias" → BLOCK', () => {
    shouldBlock('Aguardar 777 dias para reavaliação.', CTX_PERIODO_DE);
  });

  test('F6: malformed oportunidadeTipo — schema violation still blocked upstream (not textFact)', () => {
    // Este teste verifica que o pipeline completo ainda detecta oportunidadeTipo malformed
    // via validarClaimsV2 antes de chegar ao textFact — claim com field inválido.
    const { validarClaimsV2, GroundingV2ViolationError } = require('../lib/n29/groundingOutput');
    const facts = buildFacts({ tipoOportunidade: null });
    expect(() => validarClaimsV2(
      [{ field: 'oportunidadeTipo', value: 'REいATIVACAO_120D' }],
      facts
    )).toThrow(GroundingV2ViolationError);
  });

  test('F7: GAP-4 não ativa para número fora de JANELAS_METRICAS — "no período de 31 dias" → diasFacts check', () => {
    // 31 not in JANELAS_METRICAS → _ehReferenciaJanela retorna false imediatamente
    // diasSemComprar=31 (CTX_PERIODO_DE) → coincide via diasFacts → PASS
    shouldPass('No período de 31 dias sem comprar, o cliente precisa de atenção.', CTX_PERIODO_DE);
  });

  test('F8: GAP-5 não ativa para janela não-métrica — "15 pedidos em 31 dias e 6 em 90 dias" → N1=31 não é JANELA_METRICA → BLOCK para 31', () => {
    // 31 dias: não é JANELA_METRICA, não é diasFact para CTX_ELIPSE → BLOCK no parse de 31
    shouldBlock('15 pedidos em 31 dias e 6 em 90 dias.', CTX_ELIPSE);
  });
});

// ── SEÇÃO G — Testes de segurança adicionais ────────────────────────────────
describe('N32.4-G: Segurança — proteções fundamentais preservadas', () => {
  test('G1: dias inventados ainda bloqueiam', () => {
    shouldBlock('O cliente está há 120 dias sem comprar.', CTX_PERIODO_DE);
  });

  test('G2: count de pedidos inventado ainda bloqueia', () => {
    const { TextFactV2ViolationError: TFV2E } = require('../lib/n29/groundingOutput');
    const facts = buildFacts(CTX_ELIPSE);
    // "99 pedidos" não está em nenhum pedidosFact
    expect(() => validarFatosNoTextoV2(
      'O cliente realizou 99 pedidos no total.',
      [],
      facts
    )).toThrow(TFV2E);
  });

  test('G3: score inventado ainda bloqueia', () => {
    const { TextFactV2ViolationError: TFV2E } = require('../lib/n29/groundingOutput');
    const facts = buildFacts({ scoreTotal: 63 });
    expect(() => validarFatosNoTextoV2(
      'Score comercial de 99 pontos.',
      [],
      facts
    )).toThrow(TFV2E);
  });

  test('G4: urgência sem sinal ainda bloqueia', () => {
    const { TextFactV2ViolationError: TFV2E } = require('../lib/n29/groundingOutput');
    // tipoOportunidade=null, prioridade=null → urgência sem sinal
    const facts = buildFacts({ tipoOportunidade: null, prioridade: null });
    expect(() => validarFatosNoTextoV2(
      'Entre em contato imediatamente com o cliente.',
      [],
      facts
    )).toThrow(TFV2E);
  });

  test('G5: marcadores proibidos de autoridade financeira ainda bloqueiam', () => {
    const { validarMarcadoresProibidosV2, GuardrailViolationError } = require('../lib/n29/groundingOutput');
    expect(() => validarMarcadoresProibidosV2({
      diagnostico: 'Cliente tem bom histórico.',
      sinaisRelevantes: ['Tendência crescente.'],
      acaoSugerida: 'CONCEDER_DESCONTO de 10% para incentivar recompra.',
    })).toThrow(GuardrailViolationError);
  });

  test('G6: acaoTiming incoerente ainda bloqueia', () => {
    const { validarCoerenciaAcaoComercial, AcaoCoerenciaViolationError } = require('../lib/n29/groundingOutput');
    expect(() => validarCoerenciaAcaoComercial('AGIR_AGORA', 'NO_CICLO')).toThrow(AcaoCoerenciaViolationError);
  });

  test('G7: GAP-4 não permite "aguarde" mesmo com preposição locativa correta → anti-bypass', () => {
    // "no período de" seguido de contexto de ação: só o DIAS check é afetado
    // A âncora locativa liberaria a JANELA, mas o acaoSugerida seria capturado por validarTextoAcaoComercial
    // Aqui testamos apenas que a âncora locativa NÃO é afetada por palavras de ação em ctxAntes
    // "aguardar o período de 180 dias" → "o período de " → "o" não está na lista → BLOCK
    shouldBlock('Aguardar o período de 180 dias para nova abordagem.', CTX_PERIODO_DE);
  });

  test('G8: GAP-5 exige contagem exata — "5 pedidos em 30 dias e 0 em 90 dias" (pedidos90d=13) → BLOCK', () => {
    shouldBlock('5 pedidos em 30 dias e 0 em 90 dias.', CTX_ELIPSE);
  });
});

// ── SEÇÃO H — Testes de regressão das constantes exportadas ─────────────────
describe('N32.4-H: Constantes exportadas corretas', () => {
  test('H1: REGEX_ANCORA_PERIODO_ANALITICO presente e é RegExp', () => {
    expect(REGEX_ANCORA_PERIODO_ANALITICO).toBeInstanceOf(RegExp);
  });

  test('H2: REGEX_ANCORA_ELIPSE_PEDIDOS presente e é RegExp', () => {
    expect(REGEX_ANCORA_ELIPSE_PEDIDOS).toBeInstanceOf(RegExp);
  });

  test('H3: REGEX_ANCORA_PERIODO_ANALITICO casa com "no período de "', () => {
    expect(REGEX_ANCORA_PERIODO_ANALITICO.test('No período de ')).toBe(true);
  });

  test('H4: REGEX_ANCORA_PERIODO_ANALITICO não casa com "aguarde um período de "', () => {
    expect(REGEX_ANCORA_PERIODO_ANALITICO.test('aguarde um período de ')).toBe(false);
  });

  test('H5: REGEX_ANCORA_ELIPSE_PEDIDOS casa com "5 pedidos em 30 dias e 13 em "', () => {
    expect(REGEX_ANCORA_ELIPSE_PEDIDOS.test('5 pedidos em 30 dias e 13 em ')).toBe(true);
  });

  test('H6: REGEX_ANCORA_ELIPSE_PEDIDOS não casa com "5 pedidos em 30 dias e ligar em "', () => {
    expect(REGEX_ANCORA_ELIPSE_PEDIDOS.test('5 pedidos em 30 dias e ligar em ')).toBe(false);
  });

  test('H7: _ehElipseMetricaLocal retorna false para contagem errada', () => {
    const facts = buildFacts(CTX_ELIPSE);
    const texto = '5 pedidos em 30 dias e 99 em 90 dias';
    const matchIndex = texto.indexOf('90');
    expect(_ehElipseMetricaLocal(texto, matchIndex, 90, facts)).toBe(false);
  });

  test('H8: _ehElipseMetricaLocal retorna true para contagem correta', () => {
    const facts = buildFacts(CTX_ELIPSE);
    const texto = '5 pedidos em 30 dias e 13 em 90 dias';
    const matchIndex = texto.indexOf('90');
    expect(_ehElipseMetricaLocal(texto, matchIndex, 90, facts)).toBe(true);
  });
});
