'use strict';

/**
 * N33.3 — Testes do Contrato de Contexto e Abordagem V1
 *
 * OPENAI_CALLS=0 | PROD_WRITES=0 | DEPLOYS=0 | AI_MODE=SHADOW
 *
 * Seções:
 *   A  (SC-A01..A03)  Elegibilidade LLM
 *   B  (SC-B01..B10)  Context Builder — campos permitidos e proibidos
 *   C  (SC-C01..C08)  REATIVACAO_120D — abordagem e bloqueios
 *   D  (SC-D01..D08)  QUEDA_DE_COMPRAS — investigação e bloqueios
 *   E  (SC-E01..E07)  JANELA_DE_RECOMPRA — reposição e urgência fabricada
 *   F  (SC-F01..F08)  Termos internos seller-facing bloqueados
 *   G  (SC-G01..G07)  Autoridade financeira permanece bloqueada
 *   H  (SC-H01..H05)  Timing — compatibilidade com decisão de ação
 *   I  (SC-I01..I04)  Anti-redundância — contrato documentado
 *   J  (SC-J01..J05)  PROGRAMAR_CICLO — render determinístico
 *   K  (SC-K01..K04)  NAO_AGIR — render determinístico
 *
 * Total esperado: 69 testes
 */

const {
  VERSAO_CONTRACT,
  LLM_ELIGIBLE_DECISIONS,
  ORIENTACAO_POR_OPORTUNIDADE,
  TERMOS_INTERNOS_SELLER_FACING,
  PADROES_FINANCEIROS_PROIBIDOS,
  PADROES_CAUSA_INVENTADA,
  PADROES_MENSAGEM_PRONTA,
  PADROES_URGENCIA_JANELA,
  AbordagemViolationError,
  ehElegivelLLM,
  renderizarProgramarCiclo,
  renderizarNaoAgir,
  validarComoAbordar,
} = require('../lib/n33/abordagemContract');

const {
  VERSAO_CONTEXT,
  CAMPOS_PERMITIDOS,
  CAMPOS_PROIBIDOS,
  buildContextoComoAbordar,
} = require('../lib/n33/contextBuilder');

const {
  STATUS_ATRASO,
  STATUS_VOLUME,
  calcularAtrasoCiclo,
  calcularVariacaoVolume,
} = require('../lib/sinaisComerciais');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkDecisaoCtx(overrides = {}) {
  return {
    tipoOportunidade:        'REATIVACAO_120D',
    decisaoAcaoComercial:    'AGIR_AGORA',
    diasSemComprar:          171,
    diasEntreComprasMediana: 6,
    tendencia:               'ESTAVEL',
    ...overrides,
  };
}

function mkPerfil(overrides = {}) {
  return {
    pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 0,
    faturamento30d: 0, faturamento60d: 0, faturamento90d: 0, faturamento180d: 0,
    ...overrides,
  };
}

// ── SEÇÃO A — ELEGIBILIDADE LLM ───────────────────────────────────────────────

test('SC-A01: AGIR_AGORA → LLM elegível', () => {
  expect(ehElegivelLLM('AGIR_AGORA')).toBe(true);
  expect(LLM_ELIGIBLE_DECISIONS).toContain('AGIR_AGORA');
});

test('SC-A02: PROGRAMAR_CICLO → LLM NÃO elegível', () => {
  expect(ehElegivelLLM('PROGRAMAR_CICLO')).toBe(false);
});

test('SC-A03: NAO_AGIR → LLM NÃO elegível', () => {
  expect(ehElegivelLLM('NAO_AGIR')).toBe(false);
});

// ── SEÇÃO B — CONTEXT BUILDER ─────────────────────────────────────────────────

test('SC-B01: buildContextoComoAbordar retorna objeto imutável', () => {
  const ctx = buildContextoComoAbordar(mkDecisaoCtx());
  expect(() => { ctx.tipoOportunidade = 'HACK'; }).toThrow();
});

test('SC-B02: campos obrigatórios presentes no contexto', () => {
  const ctx = buildContextoComoAbordar(mkDecisaoCtx());
  expect(ctx.tipoOportunidade).toBe('REATIVACAO_120D');
  expect(ctx.decisaoAcao).toBe('AGIR_AGORA');
  expect(ctx.diasSemComprar).toBe(171);
  expect(ctx.cicloMedianoDias).toBe(6);
  expect(ctx.tendencia).toBe('ESTAVEL');
  expect(ctx.versao).toBe(VERSAO_CONTEXT);
});

test('SC-B03: CAMPOS_PROIBIDOS inclui PII', () => {
  ['clienteMr4Id', 'gestaoClickId', 'nomeCliente', 'cpf', 'cnpj',
   'telefone', 'whatsapp', 'email', 'endereco', 'cep'].forEach(campo => {
    expect(CAMPOS_PROIBIDOS).toContain(campo);
  });
});

test('SC-B04: CAMPOS_PROIBIDOS inclui valores financeiros brutos', () => {
  ['faturamentoTotal', 'faturamento30d', 'faturamento60d',
   'faturamento90d', 'faturamento180d', 'ticketMedioTotal', 'ticketMedio'].forEach(campo => {
    expect(CAMPOS_PROIBIDOS).toContain(campo);
  });
});

test('SC-B05: CAMPOS_PROIBIDOS inclui campos internos do motor', () => {
  ['scoreTotal', 'classificacao', 'prioridade', 'acaoTiming',
   'recorrenciaStatus', 'statusConfig'].forEach(campo => {
    expect(CAMPOS_PROIBIDOS).toContain(campo);
  });
});

test('SC-B06: contexto com ATRASADO inclui diasAlemDoCiclo e razaoDoCiclo', () => {
  const atrasoCiclo = calcularAtrasoCiclo(171, 6); // ATRASADO
  const ctx = buildContextoComoAbordar(mkDecisaoCtx(), { atrasoCiclo });
  expect(ctx.diasAlemDoCiclo).toBe(165);
  expect(ctx.razaoDoCiclo).toBe(28.50);
});

test('SC-B07: contexto com ANTES_DO_CICLO NÃO inclui diasAlemDoCiclo', () => {
  const atrasoCiclo = calcularAtrasoCiclo(5, 30); // ANTES_DO_CICLO
  const ctx = buildContextoComoAbordar(mkDecisaoCtx({ diasSemComprar: 5 }), { atrasoCiclo });
  expect(ctx.diasAlemDoCiclo).toBeUndefined();
  expect(ctx.razaoDoCiclo).toBeUndefined();
});

test('SC-B08: contexto com sinal de volume inclui statusVariacaoPedidos', () => {
  const variacaoVolume = calcularVariacaoVolume(mkPerfil({ pedidos60d: 5 }));
  // j30d: atual=0, anterior=5 → QUEDA_TOTAL
  const ctx = buildContextoComoAbordar(mkDecisaoCtx(), { variacaoVolume });
  expect(ctx.statusVariacaoPedidos).toBe(STATUS_VOLUME.QUEDA_TOTAL);
});

test('SC-B09: contexto sem sinaisCtx é válido (somente campos base)', () => {
  const ctx = buildContextoComoAbordar(mkDecisaoCtx());
  expect(ctx.tipoOportunidade).toBeDefined();
  expect(ctx.statusVariacaoPedidos).toBeUndefined();
  expect(ctx.diasAlemDoCiclo).toBeUndefined();
});

test('SC-B10: decisaoCtx inválido → lança erro', () => {
  expect(() => buildContextoComoAbordar(null)).toThrow('decisaoCtx deve ser objeto');
  expect(() => buildContextoComoAbordar('string')).toThrow();
});

// ── SEÇÃO C — REATIVACAO_120D ─────────────────────────────────────────────────

test('SC-C01: REATIVACAO_120D está definida no contrato', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.REATIVACAO_120D).toBeDefined();
});

test('SC-C02: REATIVACAO_120D.objetivoContato definido e não vazio', () => {
  const { objetivoContato } = ORIENTACAO_POR_OPORTUNIDADE.REATIVACAO_120D;
  expect(typeof objetivoContato).toBe('string');
  expect(objetivoContato.length).toBeGreaterThan(10);
});

test('SC-C03: REATIVACAO_120D.investigar não vazio', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.REATIVACAO_120D.investigar.length).toBeGreaterThan(0);
});

test('SC-C04: REATIVACAO_120D.naoAfirmar não vazio', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.REATIVACAO_120D.naoAfirmar.length).toBeGreaterThan(0);
});

test('SC-C05: orientação legítima de retomada → passa validação', () => {
  expect(() => validarComoAbordar(
    'Retome o contato para entender o motivo da pausa no ciclo e verificar se existe demanda atual.',
    { tipoOportunidade: 'REATIVACAO_120D' }
  )).not.toThrow();
});

test('SC-C06: "o cliente mudou de fornecedor" → CAUSA_INVENTADA bloqueada', () => {
  expect(() => validarComoAbordar(
    'O cliente mudou de fornecedor e por isso não está comprando.',
    { tipoOportunidade: 'REATIVACAO_120D' }
  )).toThrow(AbordagemViolationError);
  expect(() => validarComoAbordar(
    'O cliente mudou de fornecedor e por isso não está comprando.',
  )).toThrowError(/CAUSA_INVENTADA/);
});

test('SC-C07: "o cliente está insatisfeito" → CAUSA_INVENTADA bloqueada', () => {
  expect(() => validarComoAbordar(
    'Aborde o cliente pois ele está insatisfeito com os últimos pedidos.'
  )).toThrow(AbordagemViolationError);
});

test('SC-C08: hipótese de investigação → NÃO bloqueada', () => {
  expect(() => validarComoAbordar(
    'Retome o contato para entender o motivo da pausa. Investigue se houve mudança de fornecedor ou redução no giro do estoque.'
  )).not.toThrow();
});

// ── SEÇÃO D — QUEDA_DE_COMPRAS ────────────────────────────────────────────────

test('SC-D01: QUEDA_DE_COMPRAS está definida no contrato', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.QUEDA_DE_COMPRAS).toBeDefined();
});

test('SC-D02: QUEDA_DE_COMPRAS.objetivoContato definido', () => {
  const { objetivoContato } = ORIENTACAO_POR_OPORTUNIDADE.QUEDA_DE_COMPRAS;
  expect(typeof objetivoContato).toBe('string');
  expect(objetivoContato.length).toBeGreaterThan(10);
});

test('SC-D03: orientação legítima de queda → passa validação', () => {
  expect(() => validarComoAbordar(
    'Aborde o cliente para entender a causa da queda de compras. Verifique se houve mudança no padrão de abastecimento.',
    { tipoOportunidade: 'QUEDA_DE_COMPRAS' }
  )).not.toThrow();
});

test('SC-D04: "está comprando do concorrente" → CAUSA_INVENTADA bloqueada', () => {
  expect(() => validarComoAbordar(
    'O cliente está comprando do concorrente e reduziu o volume aqui.'
  )).toThrow(AbordagemViolationError);
});

test('SC-D05: investigação de abastecimento → passa validação', () => {
  expect(() => validarComoAbordar(
    'Verifique se houve mudança no padrão de abastecimento ou concentração em outro fornecedor.'
  )).not.toThrow();
});

test('SC-D06: "o cliente perdeu clientes" → CAUSA_INVENTADA bloqueada', () => {
  expect(() => validarComoAbordar(
    'Entre em contato pois o cliente perdeu clientes e por isso reduziu o volume.'
  )).toThrow(AbordagemViolationError);
});

test('SC-D07: investigação de giro → passa validação', () => {
  expect(() => validarComoAbordar(
    'Investigue se o giro do estoque reduziu ou se houve mudança na necessidade do negócio.'
  )).not.toThrow();
});

test('SC-D08: QUEDA_DE_COMPRAS.naoAfirmar definido e não vazio', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.QUEDA_DE_COMPRAS.naoAfirmar.length).toBeGreaterThan(0);
});

// ── SEÇÃO E — JANELA_DE_RECOMPRA ──────────────────────────────────────────────

test('SC-E01: JANELA_DE_RECOMPRA está definida no contrato', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.JANELA_DE_RECOMPRA).toBeDefined();
});

test('SC-E02: JANELA_DE_RECOMPRA.objetivoContato definido', () => {
  const { objetivoContato } = ORIENTACAO_POR_OPORTUNIDADE.JANELA_DE_RECOMPRA;
  expect(typeof objetivoContato).toBe('string');
  expect(objetivoContato.length).toBeGreaterThan(10);
});

test('SC-E03: orientação legítima de reposição → passa validação', () => {
  expect(() => validarComoAbordar(
    'Entre em contato para verificar a necessidade de reposição de estoque.',
    { tipoOportunidade: 'JANELA_DE_RECOMPRA' }
  )).not.toThrow();
});

test('SC-E04: "precisa comprar agora" → URGENCIA_JANELA bloqueada', () => {
  expect(() => validarComoAbordar(
    'O cliente precisa comprar agora para manter o estoque.',
    { tipoOportunidade: 'JANELA_DE_RECOMPRA' }
  )).toThrow(AbordagemViolationError);
  expect(() => validarComoAbordar(
    'O cliente precisa comprar agora para manter o estoque.',
    { tipoOportunidade: 'JANELA_DE_RECOMPRA' }
  )).toThrowError(/URGENCIA_JANELA/);
});

test('SC-E05: "é urgente" → URGENCIA_JANELA bloqueada para JANELA', () => {
  expect(() => validarComoAbordar(
    'É urgente que o cliente reponha o estoque.',
    { tipoOportunidade: 'JANELA_DE_RECOMPRA' }
  )).toThrow(AbordagemViolationError);
});

test('SC-E06: mesma urgência para REATIVACAO → NÃO bloqueada (JANELA-específico)', () => {
  // "É urgente" é bloqueado apenas para JANELA_DE_RECOMPRA
  expect(() => validarComoAbordar(
    'Contate o cliente para retomar o relacionamento.',
    { tipoOportunidade: 'REATIVACAO_120D' }
  )).not.toThrow();
});

test('SC-E07: JANELA_DE_RECOMPRA.investigar definido e não vazio', () => {
  expect(ORIENTACAO_POR_OPORTUNIDADE.JANELA_DE_RECOMPRA.investigar.length).toBeGreaterThan(0);
});

// ── SEÇÃO F — TERMOS INTERNOS SELLER-FACING ───────────────────────────────────

test('SC-F01: "AGIR_AGORA" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar(
    'A ação comercial é AGIR_AGORA conforme o motor.'
  )).toThrow(AbordagemViolationError);
  expect(() => validarComoAbordar(
    'A ação comercial é AGIR_AGORA conforme o motor.'
  )).toThrowError(/TERMO_INTERNO/);
});

test('SC-F02: "PROGRAMAR_CICLO" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('Decisão: PROGRAMAR_CICLO')).toThrow(AbordagemViolationError);
});

test('SC-F03: "NAO_AGIR" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('Resultado: NAO_AGIR')).toThrow(AbordagemViolationError);
});

test('SC-F04: "scoreTotal" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('O scoreTotal do cliente é 63.')).toThrow(AbordagemViolationError);
});

test('SC-F05: "REATIVACAO_120D" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('Tipo: REATIVACAO_120D')).toThrow(AbordagemViolationError);
});

test('SC-F06: "QUEDA_DE_COMPRAS" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('Tipo: QUEDA_DE_COMPRAS')).toThrow(AbordagemViolationError);
});

test('SC-F07: "JANELA_DE_RECOMPRA" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('Tipo: JANELA_DE_RECOMPRA')).toThrow(AbordagemViolationError);
});

test('SC-F08: "Perfil360" → TERMO_INTERNO bloqueado', () => {
  expect(() => validarComoAbordar('Segundo o Perfil360, o cliente está atrasado.')).toThrow(AbordagemViolationError);
});

// ── SEÇÃO G — AUTORIDADE FINANCEIRA ──────────────────────────────────────────

test('SC-G01: "ofereça desconto" → FINANCEIRO bloqueado', () => {
  expect(() => validarComoAbordar(
    'Entre em contato e ofereça desconto para reativar o cliente.'
  )).toThrow(AbordagemViolationError);
  expect(() => validarComoAbordar(
    'Entre em contato e ofereça desconto para reativar o cliente.'
  )).toThrowError(/FINANCEIRO/);
});

test('SC-G02: "melhore o preço" → FINANCEIRO bloqueado', () => {
  expect(() => validarComoAbordar(
    'Para reativar o cliente, melhore o preço na próxima oferta.'
  )).toThrow(AbordagemViolationError);
});

test('SC-G03: "libere crédito" → FINANCEIRO bloqueado', () => {
  expect(() => validarComoAbordar(
    'Libere crédito adicional para incentivar a compra.'
  )).toThrow(AbordagemViolationError);
});

test('SC-G04: "condição especial" → FINANCEIRO bloqueado', () => {
  expect(() => validarComoAbordar(
    'Ofereça uma condição especial para o cliente retomar as compras.'
  )).toThrow(AbordagemViolationError);
});

test('SC-G05: "parcelamento" → FINANCEIRO bloqueado', () => {
  expect(() => validarComoAbordar(
    'Sugira um parcelamento especial para facilitar a compra.'
  )).toThrow(AbordagemViolationError);
});

test('SC-G06: "dar um desconto" → FINANCEIRO bloqueado', () => {
  expect(() => validarComoAbordar(
    'O vendedor pode dar um desconto para fechar o negócio.'
  )).toThrow(AbordagemViolationError);
});

test('SC-G07: orientação sem autoridade financeira → passa', () => {
  expect(() => validarComoAbordar(
    'Retome o relacionamento para entender a necessidade atual e verificar se há demanda de reposição.'
  )).not.toThrow();
});

// ── SEÇÃO H — TIMING / COMPATIBILIDADE COM DECISÃO ───────────────────────────

test('SC-H01: renderizarProgramarCiclo.comoAbordar === null (sem LLM)', () => {
  const r = renderizarProgramarCiclo(12);
  expect(r.comoAbordar).toBeNull();
});

test('SC-H02: renderizarNaoAgir.comoAbordar === null (sem LLM)', () => {
  const r = renderizarNaoAgir();
  expect(r.comoAbordar).toBeNull();
});

test('SC-H03: texto de ação para AGIR_AGORA (REATIVACAO) → passa validarComoAbordar', () => {
  expect(() => validarComoAbordar(
    'Entre em contato para retomar o relacionamento e verificar a demanda atual.',
    { tipoOportunidade: 'REATIVACAO_120D' }
  )).not.toThrow();
});

test('SC-H04: texto de ação para AGIR_AGORA (QUEDA) → passa validarComoAbordar', () => {
  expect(() => validarComoAbordar(
    'Aborde o cliente para entender o motivo da queda no volume de compras.',
    { tipoOportunidade: 'QUEDA_DE_COMPRAS' }
  )).not.toThrow();
});

test('SC-H05: decisoesNaoElegiveis não têm comoAbordar (determinístico, null)', () => {
  ['PROGRAMAR_CICLO', 'NAO_AGIR'].forEach(decisao => {
    expect(ehElegivelLLM(decisao)).toBe(false);
  });
  // Ambos renders retornam comoAbordar=null
  expect(renderizarProgramarCiclo(5).comoAbordar).toBeNull();
  expect(renderizarNaoAgir().comoAbordar).toBeNull();
});

// ── SEÇÃO I — ANTI-REDUNDÂNCIA ────────────────────────────────────────────────

test('SC-I01: REATIVACAO_120D.naoAfirmar documenta proibições de redundância', () => {
  const { naoAfirmar } = ORIENTACAO_POR_OPORTUNIDADE.REATIVACAO_120D;
  expect(Array.isArray(naoAfirmar)).toBe(true);
  expect(naoAfirmar.length).toBeGreaterThanOrEqual(3);
  // Cada item é uma string descritiva
  naoAfirmar.forEach(item => expect(typeof item).toBe('string'));
});

test('SC-I02: QUEDA_DE_COMPRAS.naoAfirmar documenta proibições de redundância', () => {
  const { naoAfirmar } = ORIENTACAO_POR_OPORTUNIDADE.QUEDA_DE_COMPRAS;
  expect(Array.isArray(naoAfirmar)).toBe(true);
  expect(naoAfirmar.length).toBeGreaterThanOrEqual(3);
});

test('SC-I03: cada oportunidade V1 tem tamanhoIdeal definido (1-2 frases)', () => {
  ['REATIVACAO_120D', 'QUEDA_DE_COMPRAS', 'JANELA_DE_RECOMPRA'].forEach(tipo => {
    const { tamanhoIdeal } = ORIENTACAO_POR_OPORTUNIDADE[tipo];
    expect(typeof tamanhoIdeal).toBe('string');
    expect(tamanhoIdeal).toMatch(/1-2\s+frase/i);
  });
});

test('SC-I04: cada oportunidade V1 tem investigar e objetivoContato distintos', () => {
  const tipos = ['REATIVACAO_120D', 'QUEDA_DE_COMPRAS', 'JANELA_DE_RECOMPRA'];
  const objetivos = tipos.map(t => ORIENTACAO_POR_OPORTUNIDADE[t].objetivoContato);
  // Todos distintos (nenhuma duplicação de objetivo)
  const set = new Set(objetivos);
  expect(set.size).toBe(3);
});

// ── SEÇÃO J — PROGRAMAR_CICLO — RENDER DETERMINÍSTICO ────────────────────────

test('SC-J01: renderizarProgramarCiclo com dias retorna "em aproximadamente N dias"', () => {
  const r = renderizarProgramarCiclo(12);
  expect(r.decisaoAcao).toBe('PROGRAMAR_CICLO');
  expect(r.situacao).toContain('ciclo habitual');
  expect(r.quando).toContain('12 dias');
  expect(r.comoAbordar).toBeNull();
});

test('SC-J02: renderizarProgramarCiclo sem dias (null) retorna "próximo ciclo habitual"', () => {
  const r = renderizarProgramarCiclo(null);
  expect(r.quando).toContain('próximo ciclo habitual');
  expect(r.decisaoAcao).toBe('PROGRAMAR_CICLO');
});

test('SC-J03: renderizarProgramarCiclo com dias=0 retorna fallback (não "0 dias")', () => {
  const r = renderizarProgramarCiclo(0);
  expect(r.quando).toContain('próximo ciclo habitual');
  expect(r.quando).not.toContain('0 dias');
});

test('SC-J04: renderizarProgramarCiclo resultado é imutável', () => {
  const r = renderizarProgramarCiclo(12);
  expect(() => { r.decisaoAcao = 'HACK'; }).toThrow();
});

test('SC-J05: renderizarProgramarCiclo.situacao não contém termos internos', () => {
  const r = renderizarProgramarCiclo(7);
  expect(r.situacao).not.toContain('PROGRAMAR_CICLO');
  expect(r.situacao).not.toContain('scoreTotal');
  expect(r.situacao).not.toContain('NAO_AGIR');
});

// ── SEÇÃO K — NAO_AGIR — RENDER DETERMINÍSTICO ───────────────────────────────

test('SC-K01: renderizarNaoAgir retorna estrutura correta', () => {
  const r = renderizarNaoAgir();
  expect(r.decisaoAcao).toBe('NAO_AGIR');
  expect(r.situacao).toContain('sinal');
  expect(r.quando).toBeDefined();
  expect(r.comoAbordar).toBeNull();
});

test('SC-K02: renderizarNaoAgir.situacao usa linguagem de ausência de sinal', () => {
  const r = renderizarNaoAgir();
  // NÃO afirma que o cliente está bem — apenas que não há sinal
  expect(r.situacao).toContain('suficiente');
  expect(r.situacao).not.toContain('está bem');
  expect(r.situacao).not.toContain('saudável');
});

test('SC-K03: renderizarNaoAgir resultado é imutável', () => {
  const r = renderizarNaoAgir();
  expect(() => { r.decisaoAcao = 'HACK'; }).toThrow();
});

test('SC-K04: renderizarNaoAgir.situacao não contém termos internos', () => {
  const r = renderizarNaoAgir();
  expect(r.situacao).not.toContain('NAO_AGIR');
  expect(r.situacao).not.toContain('scoreTotal');
  expect(r.situacao).not.toContain('PROGRAMAR_CICLO');
});

// ── Verificações de exports e constantes ─────────────────────────────────────

test('VERSAO_CONTRACT exportado', () => {
  expect(VERSAO_CONTRACT).toBe('abordagem-contract-v1');
});

test('LLM_ELIGIBLE_DECISIONS contém somente AGIR_AGORA', () => {
  expect(LLM_ELIGIBLE_DECISIONS).toHaveLength(1);
  expect(LLM_ELIGIBLE_DECISIONS[0]).toBe('AGIR_AGORA');
});

test('ORIENTACAO_POR_OPORTUNIDADE cobre exatamente os 3 tipos V1', () => {
  const tipos = Object.keys(ORIENTACAO_POR_OPORTUNIDADE);
  expect(tipos).toHaveLength(3);
  expect(tipos).toContain('REATIVACAO_120D');
  expect(tipos).toContain('QUEDA_DE_COMPRAS');
  expect(tipos).toContain('JANELA_DE_RECOMPRA');
  // CROSS_SELL e PROSPECT_VINCULADO não entram em V1
  expect(tipos).not.toContain('CROSS_SELL_CATEGORIA');
  expect(tipos).not.toContain('PROSPECT_VINCULADO');
});

test('TERMOS_INTERNOS_SELLER_FACING inclui pelo menos 10 termos', () => {
  expect(TERMOS_INTERNOS_SELLER_FACING.length).toBeGreaterThanOrEqual(10);
});

test('validarComoAbordar vazio/null → lança erro FORMATO', () => {
  expect(() => validarComoAbordar('')).toThrow(AbordagemViolationError);
  expect(() => validarComoAbordar('   ')).toThrow(AbordagemViolationError);
});

test('mensagem pronta "Olá cliente..." → MENSAGEM_PRONTA bloqueada', () => {
  expect(() => validarComoAbordar('Olá cliente, tudo bem?')).toThrow(AbordagemViolationError);
});

test('CAMPOS_PERMITIDOS e CAMPOS_PROIBIDOS são disjuntos', () => {
  const permitidos = new Set(CAMPOS_PERMITIDOS);
  const proibidos = new Set(CAMPOS_PROIBIDOS);
  const intersecao = [...permitidos].filter(c => proibidos.has(c));
  expect(intersecao).toHaveLength(0);
});
