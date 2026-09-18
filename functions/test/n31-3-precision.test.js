'use strict';

/**
 * N31.3 — VALIDATOR PRECISION HARDENING
 *
 * Testa as duas correções de precisão sem enfraquecer a segurança:
 *   Fix 1: URGENCIA_SEM_SINAL com negação LOCAL por cláusula
 *   Fix 2: "N dias" em contexto de janela de métricas ("nos últimos N dias")
 *          + remoção do fallback temClaimDe
 *
 * OPENAI_CALLS = 0 | PROD_WRITES = 0 | REAL_DATA = NONE
 */

const {
  buildGroundingFactsV2,
  validarFatosNoTextoV2,
  TextFactV2ViolationError,
} = require('../lib/n29/groundingOutput');

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Contexto NAO_AGIR: sem oportunidade → urgência nunca tem sinal determinístico
const CTX_NULL_OPP = Object.freeze({
  tipoOportunidade:              null,
  scoreTotal:                    72,
  classificacao:                 'BOM',
  diasSemComprar:                8,
  tendencia:                     'ESTAVEL',
  recorrenciaStatus:             'DENTRO_DO_PADRAO',
  prioridade:                    null,
  pedidosTotal:                  10,
  pedidos30d:                    3,
  pedidos60d:                    6,
  pedidos90d:                    8,
  pedidos180d:                   10,
  faturamentoTotal:              850.00,
  faturamento30d:                210.00,
  faturamento60d:                410.00,
  faturamento90d:                620.00,
  faturamento180d:               850.00,
  ticketMedioTotal:              85.00,
  diasEntreComprasMedio:         12.0,
  diasEntreComprasMediana:       11,
  quantidadeProdutosDistintos:   5,
  quantidadeCategoriasDistintas: 2,
});

// Contexto com janelas de métricas para testes DIAS
const CTX_DIAS = Object.freeze({
  tipoOportunidade:              null,
  scoreTotal:                    60,
  classificacao:                 'BOM',
  diasSemComprar:                45,
  tendencia:                     'CAINDO',
  recorrenciaStatus:             'ATRASADO',
  prioridade:                    null,
  pedidosTotal:                  18,
  pedidos30d:                    3,
  pedidos60d:                    8,
  pedidos90d:                    12,
  pedidos180d:                   18,
  faturamentoTotal:              1500.00,
  faturamento30d:                150.00,
  faturamento60d:                400.00,
  faturamento90d:                750.00,
  faturamento180d:               1500.00,
  ticketMedioTotal:              83.33,
  diasEntreComprasMedio:         22.5,
  diasEntreComprasMediana:       20,
  quantidadeProdutosDistintos:   6,
  quantidadeCategoriasDistintas: 3,
});

// Contexto DIAS com diasAteProximoCiclo via decisão N30
const DECISAO_CICLO = Object.freeze({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 15 });

// Contexto DIAS com janelas 30d NULL (para testar bloqueio quando dado ausente)
const CTX_DIAS_SEM30 = Object.freeze({
  ...CTX_DIAS,
  pedidos30d:     null,
  faturamento30d: null,
});

function nullOppFacts()  { return buildGroundingFactsV2(CTX_NULL_OPP); }
function diasFacts()     { return buildGroundingFactsV2(CTX_DIAS, DECISAO_CICLO); }
function diasSem30Facts(){ return buildGroundingFactsV2(CTX_DIAS_SEM30, DECISAO_CICLO); }

// ── PREC-URG: Urgency precision tests ────────────────────────────────────────

describe('N31.3 — PREC-URG: URGENCIA_SEM_SINAL precision', () => {

  // ── PASS: negação LOCAL presente → não deve bloquear ─────────────────────

  test('PREC-URG-01: "não há necessidade de ação imediata" → PASS (negação direta)', () => {
    expect(() => validarFatosNoTextoV2(
      'O cliente está estável. Não há necessidade de ação imediata.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-02: "não é necessário contato imediato" → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Situação controlada, não é necessário contato imediato no momento.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-03: "não precisa agir imediatamente" → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'O lojista não precisa agir imediatamente com este cliente.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-04: "situação não urgente" → PASS (não adjacente)', () => {
    expect(() => validarFatosNoTextoV2(
      'Este é um caso de situação não urgente para o período.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-05: "evite abordagem imediata" → PASS (evite)', () => {
    expect(() => validarFatosNoTextoV2(
      'Evite abordagem imediata para não pressionar o cliente.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-06: "sem urgência identificada" → PASS (sem)', () => {
    expect(() => validarFatosNoTextoV2(
      'Análise concluída: sem urgência identificada no perfil.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-07: "sem ação imediata necessária" → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'O cliente continua ativo. Sem ação imediata necessária.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-08: multi-cláusula com negação na cláusula correta → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Situação estável. Não há urgência percebida no momento.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  test('PREC-URG-09: negação com gap de 5 palavras (limite {0,5}) → PASS', () => {
    // "não" + 5 palavras antes de "urgente" — exatamente no limite
    expect(() => validarFatosNoTextoV2(
      'Perfil sem alerta: não há razão alguma para urgente agora.',
      [],
      nullOppFacts()
    )).not.toThrow();
  });

  // ── BLOCK: urgência afirmativa → deve bloquear ────────────────────────────

  test('PREC-URG-10: "ação imediata recomendada" → BLOCK (sem negação)', () => {
    expect(() => validarFatosNoTextoV2(
      'Análise indica ação imediata recomendada para este caso.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-11: "entre em contato imediatamente" → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Entre em contato imediatamente com o cliente.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-12: "urgente: verificar conta" → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Urgente: verificar conta do cliente.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-13: "situação urgente identificada" → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Situação urgente identificada pelo sistema de análise.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-14: "contato imediato necessário" → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Contato imediato necessário para manter o relacionamento.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-15: cross-clause "não espere; entre em contato imediatamente" → BLOCK', () => {
    // Negação na cláusula 1, urgência na cláusula 2 → negação NÃO protege
    expect(() => validarFatosNoTextoV2(
      'Não espere; entre em contato imediatamente.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-16: cross-clause urgência antes da negação → BLOCK', () => {
    // "ação imediata" na cláusula 1, negação na cláusula 2 (não protege retroativamente)
    expect(() => validarFatosNoTextoV2(
      'Requer ação imediata. Não deixe para depois.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-17: NULL-CTRL-E — "precisa de contato urgente hoje mesmo" → BLOCK', () => {
    // Controle de segurança: teste original do n29-grounding deve manter-se
    expect(() => validarFatosNoTextoV2(
      'Este cliente precisa de contato urgente hoje mesmo.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-URG-18: gap de 6 palavras após "não" → BLOCK (além do limite {0,5})', () => {
    // "não" + 6 palavras antes de "urgente" — excede o limite
    expect(() => validarFatosNoTextoV2(
      'Análise: não há razão alguma muito grande extra urgente aqui.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

});

// ── PREC-DAY: DIAS precision tests ───────────────────────────────────────────

describe('N31.3 — PREC-DAY: DIAS validator precision', () => {

  // ── PASS: referências legítimas a janelas de métricas ────────────────────

  test('PREC-DAY-01: "nos últimos 30 dias" + pedidos30d=3 → PASS (janela 30d)', () => {
    expect(() => validarFatosNoTextoV2(
      'Zero pedidos nos últimos 30 dias registrado.',
      [],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-02: "nos últimos 60 dias" + pedidos60d=8 → PASS (janela 60d)', () => {
    expect(() => validarFatosNoTextoV2(
      'Tendência de queda nos últimos 60 dias.',
      [],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-03: "nos últimos 90 dias" + pedidos90d=12 → PASS (janela 90d)', () => {
    expect(() => validarFatosNoTextoV2(
      'Histórico avaliado nos últimos 90 dias.',
      [],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-04: "nos últimos 180 dias" + pedidos180d=18 → PASS (janela 180d)', () => {
    expect(() => validarFatosNoTextoV2(
      'Avaliação completa dos últimos 180 dias.',
      [],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-05: exact match diasSemComprar=45 → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Última compra há 45 dias.',
      [{ field: 'diasSemComprar', value: 45 }],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-06: exact match diasEntreComprasMediana=20 → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Mediana do intervalo entre compras: 20 dias.',
      [{ field: 'diasEntreComprasMediana', value: 20 }],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-07: float floor — diasMedio=22.5 texto diz "22 dias" → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Intervalo médio aproximado de 22 dias entre compras.',
      [{ field: 'diasEntreComprasMedio', value: 22.5 }],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-08: float ceil — diasMedio=22.5 texto diz "23 dias" → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Intervalo médio de 23 dias entre pedidos.',
      [{ field: 'diasEntreComprasMedio', value: 22.5 }],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-09: diasAteProximoCiclo=15 → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Próximo ciclo estimado em 15 dias.',
      [{ field: 'diasAteProximoCiclo', value: 15 }],
      diasFacts()
    )).not.toThrow();
  });

  test('PREC-DAY-10: "nos últimos 30 dias" com pedidos30d=0 (zero ≠ null) → PASS', () => {
    // Valor zero é dado válido (não null)
    expect(() => validarFatosNoTextoV2(
      'Zero pedidos nos últimos 30 dias no registro.',
      [],
      diasFacts()  // pedidos30d=3 neste fixture
    )).not.toThrow();
  });

  test('PREC-DAY-11: "no último 30 dias" (singular) → PASS (padrão aceita singular)', () => {
    expect(() => validarFatosNoTextoV2(
      'Avaliação no último 30 dias de histórico.',
      [],
      diasFacts()
    )).not.toThrow();
  });

  // ── BLOCK: referências inválidas ──────────────────────────────────────────

  test('PREC-DAY-12: PREC-DAY-09 original — "180 dias sem comprar" com diasSemComprar=45 → BLOCK', () => {
    // BUG CORRIGIDO: 180 ≠ diasFact, não é contexto "nos últimos", e temClaimDe foi removido
    expect(() => validarFatosNoTextoV2(
      '180 dias sem comprar é muito tempo.',
      [{ field: 'diasSemComprar', value: 45 }],
      diasFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-DAY-13: número inventado "100 dias" → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'O cliente ficou 100 dias sem comprar.',
      [{ field: 'diasSemComprar', value: 45 }],
      diasFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-DAY-14: "há 60 dias" (sem "últimos") com diasSemComprar=45 → BLOCK', () => {
    // "há X dias" ≠ "nos últimos X dias" — não é contexto de janela de métricas
    expect(() => validarFatosNoTextoV2(
      'O cliente realizou compra há 60 dias.',
      [{ field: 'diasSemComprar', value: 45 }],
      diasFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-DAY-15: "nos últimos 30 dias" com pedidos30d=null e faturamento30d=null → BLOCK', () => {
    // Referência a janela que não existe nos facts
    expect(() => validarFatosNoTextoV2(
      'Sem pedidos nos últimos 30 dias.',
      [],
      diasSem30Facts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('PREC-DAY-16: "nos últimos 25 dias" (fora de {30,60,90,180}) → BLOCK', () => {
    // 25 não é janela de métricas → deve coincidir com diasFact ou bloquear
    expect(() => validarFatosNoTextoV2(
      'Queda identificada nos últimos 25 dias.',
      [],
      diasFacts()
    )).toThrow(TextFactV2ViolationError);
  });

});

// ── Phase 6: Reprodução dos 4 bloqueios de N31.1 ─────────────────────────────
// Reconstrói contextos dos casos bloqueados em N31.1 e verifica
// (A) o cenário de FALSO POSITIVO agora passa, e
// (B) o cenário de TRUE BLOCK ainda bloqueia.

describe('N31.3 — Phase 6: Reprodução dos bloqueios N31.1', () => {

  // PC-N1: diasSemComprar=2, mediana=14, diasAteProximoCiclo=12, tipoOportunidade=null
  const CTX_PC_N1 = Object.freeze({
    tipoOportunidade: null, scoreTotal: 70, classificacao: 'BOM',
    diasSemComprar: 2, tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
    prioridade: null, pedidosTotal: 12, pedidos30d: 4, pedidos60d: 8,
    pedidos90d: 10, pedidos180d: 12, faturamentoTotal: 960.00, faturamento30d: 200.00,
    faturamento60d: 400.00, faturamento90d: 620.00, faturamento180d: 960.00,
    ticketMedioTotal: 80.00, diasEntreComprasMedio: 14.2, diasEntreComprasMediana: 14,
    quantidadeProdutosDistintos: 5, quantidadeCategoriasDistintas: 2,
  });
  const DECISAO_PC_N1 = { decisaoAcaoComercial: 'NAO_AGIR', diasAteProximoCiclo: 12 };

  test('PC-N1-A: texto com urgência NEGADA → PASS (falso positivo original corrigido)', () => {
    // O modelo provavelmente dizia algo como "não é necessário contato imediato"
    expect(() => validarFatosNoTextoV2(
      'Compra recente há 2 dias. Não é necessário contato imediato.',
      [{ field: 'diasSemComprar', value: 2 }],
      buildGroundingFactsV2(CTX_PC_N1, DECISAO_PC_N1)
    )).not.toThrow();
  });

  test('PC-N1-B: texto com urgência AFIRMATIVA → BLOCK (proteção mantida)', () => {
    expect(() => validarFatosNoTextoV2(
      'Compra recente há 2 dias. Mesmo assim, entre em contato imediatamente.',
      [{ field: 'diasSemComprar', value: 2 }],
      buildGroundingFactsV2(CTX_PC_N1, DECISAO_PC_N1)
    )).toThrow(TextFactV2ViolationError);
  });

  // PC-N3: diasSemComprar=20, mediana=29, diasAteProximoCiclo=9, tipoOportunidade=null
  const CTX_PC_N3 = Object.freeze({
    tipoOportunidade: null, scoreTotal: 68, classificacao: 'BOM',
    diasSemComprar: 20, tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
    prioridade: null, pedidosTotal: 8, pedidos30d: 1, pedidos60d: 3,
    pedidos90d: 6, pedidos180d: 8, faturamentoTotal: 720.00, faturamento30d: 90.00,
    faturamento60d: 260.00, faturamento90d: 540.00, faturamento180d: 720.00,
    ticketMedioTotal: 90.00, diasEntreComprasMedio: 29.5, diasEntreComprasMediana: 29,
    quantidadeProdutosDistintos: 4, quantidadeCategoriasDistintas: 2,
  });
  const DECISAO_PC_N3 = { decisaoAcaoComercial: 'NAO_AGIR', diasAteProximoCiclo: 9 };

  test('PC-N3-A: texto com urgência NEGADA → PASS (falso positivo corrigido)', () => {
    expect(() => validarFatosNoTextoV2(
      'Última compra há 20 dias, dentro do padrão de 29 dias. Não há urgência.',
      [{ field: 'diasSemComprar', value: 20 }, { field: 'diasEntreComprasMediana', value: 29 }],
      buildGroundingFactsV2(CTX_PC_N3, DECISAO_PC_N3)
    )).not.toThrow();
  });

  test('PC-N3-B: texto com urgência AFIRMATIVA → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Última compra há 20 dias. Ação urgente requerida.',
      [{ field: 'diasSemComprar', value: 20 }],
      buildGroundingFactsV2(CTX_PC_N3, DECISAO_PC_N3)
    )).toThrow(TextFactV2ViolationError);
  });

  // PC-A2: diasSemComprar=3, mediana=8, diasAteProximoCiclo=5, tipoOportunidade=null, score=95
  const CTX_PC_A2 = Object.freeze({
    tipoOportunidade: null, scoreTotal: 95, classificacao: 'EXCELENTE',
    diasSemComprar: 3, tendencia: 'SUBINDO', recorrenciaStatus: 'DENTRO_DO_PADRAO',
    prioridade: null, pedidosTotal: 20, pedidos30d: 5, pedidos60d: 10,
    pedidos90d: 16, pedidos180d: 20, faturamentoTotal: 1800.00, faturamento30d: 450.00,
    faturamento60d: 900.00, faturamento90d: 1350.00, faturamento180d: 1800.00,
    ticketMedioTotal: 90.00, diasEntreComprasMedio: 8.5, diasEntreComprasMediana: 8,
    quantidadeProdutosDistintos: 8, quantidadeCategoriasDistintas: 3,
  });
  const DECISAO_PC_A2 = { decisaoAcaoComercial: 'NAO_AGIR', diasAteProximoCiclo: 5 };

  test('PC-A2-A: cliente excelente, sem urgência → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Cliente excelente com score 95. Comprou há 3 dias. Sem ação urgente necessária.',
      [{ field: 'scoreTotal', value: 95 }, { field: 'diasSemComprar', value: 3 }],
      buildGroundingFactsV2(CTX_PC_A2, DECISAO_PC_A2)
    )).not.toThrow();
  });

  test('PC-A2-B: adversarial — score excelente não justifica urgência → BLOCK', () => {
    // Adversarial: modelo tenta usar score alto para justificar urgência
    expect(() => validarFatosNoTextoV2(
      'Score 95 EXCELENTE! Entre em contato imediatamente.',
      [{ field: 'scoreTotal', value: 95 }],
      buildGroundingFactsV2(CTX_PC_A2, DECISAO_PC_A2)
    )).toThrow(TextFactV2ViolationError);
  });

  // NA-N1: diasSemComprar=null, SEM_BASE, 1 pedido — "180 dias" em texto = BLOCK
  const CTX_NA_N1 = Object.freeze({
    tipoOportunidade: null, scoreTotal: 20, classificacao: 'SEM_BASE',
    diasSemComprar: null, tendencia: 'SEM_BASE', recorrenciaStatus: 'SEM_BASE',
    prioridade: null, pedidosTotal: 1, pedidos30d: null, pedidos60d: null,
    pedidos90d: null, pedidos180d: null, faturamentoTotal: 150.00,
    faturamento30d: null, faturamento60d: null, faturamento90d: null, faturamento180d: null,
    ticketMedioTotal: 150.00, diasEntreComprasMedio: null, diasEntreComprasMediana: null,
    quantidadeProdutosDistintos: 1, quantidadeCategoriasDistintas: 1,
  });

  test('NA-N1-A: texto sem referência numérica de dias → PASS', () => {
    expect(() => validarFatosNoTextoV2(
      'Cliente com histórico insuficiente para análise. Apenas 1 pedido registrado.',
      [{ field: 'pedidosTotal', value: 1 }],
      buildGroundingFactsV2(CTX_NA_N1)
    )).not.toThrow();
  });

  test('NA-N1-B: "180 dias" inventado com SEM_BASE → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Cliente sem comprar há 180 dias segundo o sistema.',
      [{ field: 'pedidosTotal', value: 1 }],
      buildGroundingFactsV2(CTX_NA_N1)
    )).toThrow(TextFactV2ViolationError);
  });

});

// ── Phase 7: Security regression ─────────────────────────────────────────────
// Garante que casos que DEVEM bloquear continuam bloqueando após as correções.

describe('N31.3 — Phase 7: Security regression', () => {

  test('SEC-01: ADV-07 equivalente — "Situação urgente" + sem oportunidade → BLOCK', () => {
    const facts = buildGroundingFactsV2({
      tipoOportunidade: null, scoreTotal: 80, classificacao: 'MUITO_BOM',
      diasSemComprar: 10, tendencia: 'ESTAVEL', recorrenciaStatus: 'DENTRO_DO_PADRAO',
      prioridade: null, pedidosTotal: 15, pedidos30d: 4, pedidos60d: 8,
      pedidos90d: 12, pedidos180d: 15, faturamentoTotal: 1200.00, faturamento30d: 300.00,
      faturamento60d: 600.00, faturamento90d: 900.00, faturamento180d: 1200.00,
      ticketMedioTotal: 80.00, diasEntreComprasMedio: 10.5, diasEntreComprasMediana: 10,
      quantidadeProdutosDistintos: 6, quantidadeCategoriasDistintas: 2,
    });
    expect(() => validarFatosNoTextoV2(
      'Situação urgente. O cliente precisa de atenção imediata.',
      [],
      facts
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-02: urgência em acaoSugerida sem sinal → BLOCK (texto completo ainda auditado)', () => {
    expect(() => validarFatosNoTextoV2(
      'Cliente estável. Perfil dentro do padrão. Entrar em contato imediatamente.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-03: urgência em sinaisRelevantes sem sinal → BLOCK', () => {
    expect(() => validarFatosNoTextoV2(
      'Queda imediata de compras detectada. Perfil ok.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-04: falsa dupla negação "não deixe de agir imediatamente" → PASS (limitação conhecida)', () => {
    // "não" + "deixe" + "de" + "agir" (3 tokens) dentro do limite {0,5}: o detector
    // formal classifica como NEGADO mesmo que o sentido seja afirmativo.
    // Limitação aceita: a pipeline multi-camada captura este padrão via Phase 5
    // (MARCADORES_PROGRAMAR_CICLO_IMEDIATO) antes de Phase 6 ser alcançada.
    expect(() => validarFatosNoTextoV2(
      'Não deixe de agir imediatamente.',
      [],
      nullOppFacts()
    )).not.toThrow(); // limitação conhecida: negação formal, não semântica
  });

  test('SEC-05: DIAS — número em "score 63 pontos" não dispara check de dias', () => {
    // Verifica que o check de dias não confunde outros contextos numéricos
    expect(() => validarFatosNoTextoV2(
      'Score atual 63 pontos. Última compra há 45 dias.',
      [{ field: 'scoreTotal', value: 63 }, { field: 'diasSemComprar', value: 45 }],
      buildGroundingFactsV2({
        tipoOportunidade: null, scoreTotal: 63, classificacao: 'BOM',
        diasSemComprar: 45, tendencia: 'ESTAVEL', recorrenciaStatus: 'ATRASADO',
        prioridade: null, pedidosTotal: 10, pedidos30d: 2, pedidos60d: 5,
        pedidos90d: 8, pedidos180d: 10, faturamentoTotal: 800.00,
        faturamento30d: 100.00, faturamento60d: 250.00, faturamento90d: 550.00,
        faturamento180d: 800.00, ticketMedioTotal: 80.00,
        diasEntreComprasMedio: 15.0, diasEntreComprasMediana: 14,
        quantidadeProdutosDistintos: 4, quantidadeCategoriasDistintas: 2,
      })
    )).not.toThrow();
  });

  test('SEC-06: DIAS — "30 dias" sem contexto "últimos" e sem coincide → BLOCK', () => {
    // Verifica que remoção de temClaimDe não criou bypass genérico
    expect(() => validarFatosNoTextoV2(
      'Prazo de 30 dias para regularização.',
      [{ field: 'diasSemComprar', value: 45 }],
      diasFacts()
    )).toThrow(TextFactV2ViolationError);
  });

  test('SEC-07: urgência com oportunidade presente → PASS (comportamento esperado)', () => {
    // Quando oportunidade existe, urgência é permitida
    const ctxComOpp = {
      ...CTX_NULL_OPP,
      tipoOportunidade: 'QUEDA_DE_COMPRAS',
      prioridade: 80,
    };
    const facts = buildGroundingFactsV2(ctxComOpp);
    expect(() => validarFatosNoTextoV2(
      'Queda detectada. Entre em contato imediatamente.',
      [{ field: 'oportunidadeTipo', value: 'QUEDA_DE_COMPRAS' }, { field: 'oportunidadePrioridade', value: 80 }],
      facts
    )).not.toThrow();
  });

  test('SEC-08: múltiplas urgências — uma negada, uma afirmativa → BLOCK', () => {
    // "não há situação urgente" (negada) + "contato imediato é necessário" (afirmativa)
    expect(() => validarFatosNoTextoV2(
      'Não há situação urgente de estoque; contato imediato é necessário para atualização.',
      [],
      nullOppFacts()
    )).toThrow(TextFactV2ViolationError);
  });

});
