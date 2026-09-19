'use strict';

/**
 * N33.5 — Seller Assist Service — Test Suite
 *
 * OPENAI_CALLS=0 | PROD_WRITES=0 | DEPLOYS=0 | AI_MODE=SHADOW
 * Provider: MockProvider only — nenhuma chamada real ao OpenAI.
 *
 * Seções:
 *   A (12) — Roteamento
 *   B (15) — AGIR_AGORA — caminho de sucesso
 *   C (10) — PROGRAMAR_CICLO — zero LLM
 *   D (10) — NAO_AGIR — zero LLM
 *   E (18) — Cenários de fallback
 *   F (10) — Minimização de contexto
 *   G ( 8) — Sanitização de trace/audit
 *   H ( 8) — Regressão / imutabilidade
 *
 * Total: 91 testes
 */

const {
  calcularSellerAssist,
  VERSAO_SELLER_ASSIST,
  LLM_STATUS,
} = require('../lib/n33/sellerAssistService');

const { MockProvider } = require('../lib/ai/provider');
const { VERSAO_PROMPT } = require('../lib/n33/promptComoAbordar');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockOK(comoAbordar) {
  return new MockProvider({
    'COMO_ABORDAR': JSON.stringify({ comoAbordar }),
  });
}

function mockError(msg = 'Timeout simulado') {
  return {
    nome:     'MockError',
    complete: async () => { throw new Error(msg); },
  };
}

function mockBadJson() {
  return new MockProvider({ 'COMO_ABORDAR': 'not-valid-json{{' });
}

function mockMissingField() {
  return new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ outro: 'campo' }) });
}

function mockEmptyComoAbordar() {
  return new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ comoAbordar: '' }) });
}

function mockCapturador(comoAbordar = 'Investigue a situação.') {
  const chamadas = [];
  const provider = {
    nome: 'MockCapt',
    async complete(prompt, opcoes) {
      chamadas.push({ prompt, opcoes });
      return { texto: JSON.stringify({ comoAbordar }), tokens: { input: 10, output: 5 }, modelo: 'mock', latenciaMs: 0 };
    },
    getChamadas() { return chamadas; },
  };
  return provider;
}

// Contexto base AGIR_AGORA
function ctxAgir(tipo = 'REATIVACAO_120D', extra = {}) {
  return {
    decisaoAcaoComercial:    'AGIR_AGORA',
    tipoOportunidade:        tipo,
    diasSemComprar:          100,
    diasEntreComprasMediana: 20,
    tendencia:               'CAINDO',
    ...extra,
  };
}

// Sinais com ATRASADO e queda de volume
function sinaisAtrasado() {
  return {
    atrasoCiclo: {
      status:          'ATRASADO',
      diasAlemDoCiclo: 80,
      razaoDoCiclo:    5,
      cicloMedianoDias: 20,
    },
    variacaoVolume: {
      j30d: { pedidos: { status: 'QUEDA_TOTAL', variacao: -100 } },
      j90d: { pedidos: { status: 'QUEDA',       variacao: -60  } },
    },
  };
}

// Sinais sem dados de volume
function sinaisSemVolume() {
  return {
    atrasoCiclo: {
      status:          'ATRASADO',
      diasAlemDoCiclo: 30,
      razaoDoCiclo:    1.5,
      cicloMedianoDias: 20,
    },
    variacaoVolume: {
      j30d: { pedidos: { status: 'SEM_MOVIMENTO', variacao: null } },
      j90d: { pedidos: { status: 'SEM_MOVIMENTO', variacao: null } },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A — Roteamento (12 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('A — Roteamento', () => {

  test('A-01: AGIR_AGORA → modo HYBRID', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.modo).toBe('HYBRID');
  });

  test('A-02: PROGRAMAR_CICLO → modo DETERMINISTIC', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 5 });
    expect(r.modo).toBe('DETERMINISTIC');
  });

  test('A-03: NAO_AGIR → modo DETERMINISTIC', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.modo).toBe('DETERMINISTIC');
  });

  test('A-04: decisaoAcao desconhecida → modo FAIL_CLOSED', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'FILA_RECOMPRA' });
    expect(r.modo).toBe('FAIL_CLOSED');
  });

  test('A-05: decisaoAcao null → FAIL_CLOSED', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: null });
    expect(r.modo).toBe('FAIL_CLOSED');
  });

  test('A-06: decisaoAcao undefined → FAIL_CLOSED', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: undefined });
    expect(r.modo).toBe('FAIL_CLOSED');
  });

  test('A-07: decisaoCtx null → FAIL_CLOSED', async () => {
    const r = await calcularSellerAssist(null);
    expect(r.modo).toBe('FAIL_CLOSED');
  });

  test('A-08: decisaoCtx número → FAIL_CLOSED', async () => {
    const r = await calcularSellerAssist(42);
    expect(r.modo).toBe('FAIL_CLOSED');
  });

  test('A-09: AGIR_AGORA com provider válido → llmUsed=true', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.metadata.llmUsed).toBe(true);
  });

  test('A-10: PROGRAMAR_CICLO → llmUsed=false', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.metadata.llmUsed).toBe(false);
  });

  test('A-11: NAO_AGIR → llmUsed=false', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.metadata.llmUsed).toBe(false);
  });

  test('A-12: calcularSellerAssist retorna Promise', () => {
    const p = calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(p).toBeInstanceOf(Promise);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// B — AGIR_AGORA — caminho de sucesso (15 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('B — AGIR_AGORA — caminho de sucesso', () => {

  test('B-01: REATIVACAO_120D → situacao contém diasSemComprar', async () => {
    const r = await calcularSellerAssist(ctxAgir('REATIVACAO_120D'), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.situacao).toContain('100');
  });

  test('B-02: QUEDA_DE_COMPRAS → situacao contém diasSemComprar', async () => {
    const r = await calcularSellerAssist(ctxAgir('QUEDA_DE_COMPRAS'), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.situacao).toContain('100');
  });

  test('B-03: JANELA_DE_RECOMPRA → situacao contém diasSemComprar', async () => {
    const r = await calcularSellerAssist(ctxAgir('JANELA_DE_RECOMPRA'), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.situacao).toContain('100');
  });

  test('B-04: comoAbordar = texto retornado pelo provider', async () => {
    const expected = 'Investigue o motivo da pausa nas compras e se há demanda atual.';
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK(expected) });
    expect(r.comoAbordar).toBe(expected);
  });

  test('B-05: metadata.llmStatus = LLM_SUCCESS', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.SUCCESS);
  });

  test('B-06: metadata.llmUsed = true', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.metadata.llmUsed).toBe(true);
  });

  test('B-07: metadata.versaoPrompt = VERSAO_PROMPT', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.metadata.versaoPrompt).toBe(VERSAO_PROMPT);
  });

  test('B-08: quando = Ação recomendada: neste ciclo.', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.quando).toBe('Ação recomendada: neste ciclo.');
  });

  test('B-09: sinais contém diasSemComprar', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toBeNull();
    expect(r.sinais.diasSemComprar).toBe(100);
  });

  test('B-10: sinais contém cicloMedianoDias', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.cicloMedianoDias).toBe(20);
  });

  test('B-11: sinais contém tendencia', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.tendencia).toBe('CAINDO');
  });

  test('B-12: sinais contém diasAlemDoCiclo quando ATRASADO', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.diasAlemDoCiclo).toBe(80);
  });

  test('B-13: sinais contém statusVariacaoPedidos quando informativo', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.statusVariacaoPedidos).toBe('QUEDA_TOTAL');
  });

  test('B-14: resultado é frozen', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(Object.isFrozen(r)).toBe(true);
  });

  test('B-15: provider.complete chamado com chave COMO_ABORDAR', async () => {
    let opcoesCapturadas;
    const provider = {
      nome:     'MockCapt',
      complete: async (prompt, opcoes) => {
        opcoesCapturadas = opcoes;
        return { texto: JSON.stringify({ comoAbordar: 'Investigue.' }), tokens: { input: 5, output: 5 }, modelo: 'mock', latenciaMs: 0 };
      },
    };
    await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider });
    expect(opcoesCapturadas.chave).toBe('COMO_ABORDAR');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// C — PROGRAMAR_CICLO — zero LLM (10 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('C — PROGRAMAR_CICLO — zero LLM', () => {

  test('C-01: modo = DETERMINISTIC', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.modo).toBe('DETERMINISTIC');
  });

  test('C-02: comoAbordar = null', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.comoAbordar).toBeNull();
  });

  test('C-03: metadata.llmUsed = false', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.metadata.llmUsed).toBe(false);
  });

  test('C-04: metadata.llmStatus = NOT_ELIGIBLE', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.NOT_ELIGIBLE);
  });

  test('C-05: situacao = texto correto', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.situacao).toBe('Cliente dentro do ciclo habitual de compra.');
  });

  test('C-06: diasAteProximoCiclo=5 → quando contém "5 dias"', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 5 });
    expect(r.quando).toContain('5 dias');
  });

  test('C-07: diasAteProximoCiclo=null → quando contém "próximo ciclo habitual"', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: null });
    expect(r.quando).toContain('próximo ciclo habitual');
  });

  test('C-08: sem provider → mesmo resultado (zero LLM)', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.modo).toBe('DETERMINISTIC');
    expect(r.comoAbordar).toBeNull();
  });

  test('C-09: sinais = null', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(r.sinais).toBeNull();
  });

  test('C-10: resultado é frozen', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(Object.isFrozen(r)).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// D — NAO_AGIR — zero LLM (10 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('D — NAO_AGIR — zero LLM', () => {

  test('D-01: modo = DETERMINISTIC', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.modo).toBe('DETERMINISTIC');
  });

  test('D-02: comoAbordar = null', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.comoAbordar).toBeNull();
  });

  test('D-03: metadata.llmUsed = false', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.metadata.llmUsed).toBe(false);
  });

  test('D-04: metadata.llmStatus = NOT_ELIGIBLE', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.NOT_ELIGIBLE);
  });

  test('D-05: situacao = texto correto', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.situacao).toBe('Sem sinal determinístico suficiente para ação comercial.');
  });

  test('D-06: quando = texto correto', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.quando).toBe('Sem ação necessária no momento.');
  });

  test('D-07: sinais = null', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.sinais).toBeNull();
  });

  test('D-08: sem provider → mesmo resultado', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(r.modo).toBe('DETERMINISTIC');
    expect(r.comoAbordar).toBeNull();
  });

  test('D-09: resultado é frozen', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(Object.isFrozen(r)).toBe(true);
  });

  test('D-10: metadata é frozen', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' });
    expect(Object.isFrozen(r.metadata)).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// E — Cenários de fallback (18 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('E — Cenários de fallback', () => {

  test('E-01: provider throws → comoAbordar null', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockError() });
    expect(r.comoAbordar).toBeNull();
  });

  test('E-02: provider throws → llmStatus INFRA_ERROR', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockError() });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.INFRA_ERROR);
  });

  test('E-03: provider throws → modo HYBRID (tentativa falhou)', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockError() });
    expect(r.modo).toBe('HYBRID');
  });

  test('E-04: provider retorna JSON inválido → comoAbordar null, INFRA_ERROR', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockBadJson() });
    expect(r.comoAbordar).toBeNull();
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.INFRA_ERROR);
  });

  test('E-05: provider retorna campo ausente → INFRA_ERROR', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockMissingField() });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.INFRA_ERROR);
  });

  test('E-06: provider retorna comoAbordar vazio → INFRA_ERROR', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockEmptyComoAbordar() });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.INFRA_ERROR);
    expect(r.comoAbordar).toBeNull();
  });

  test('E-07: sem provider (opcoes={}) → INFRA_ERROR, comoAbordar null', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), {});
    expect(r.comoAbordar).toBeNull();
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.INFRA_ERROR);
  });

  test('E-08: comoAbordar com TERMO_INTERNO (AGIR_AGORA) → CONTRACT_BLOCK', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('AGIR_AGORA: cliente deve ser contatado.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.comoAbordar).toBeNull();
  });

  test('E-09: comoAbordar com autoridade financeira → CONTRACT_BLOCK', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Ofereça desconto especial para reativar.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.comoAbordar).toBeNull();
  });

  test('E-10: comoAbordar com causa inventada como fato → CONTRACT_BLOCK', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('O cliente mudou de fornecedor recentemente.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.comoAbordar).toBeNull();
  });

  test('E-11: comoAbordar tipo mensagem pronta → CONTRACT_BLOCK', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Olá cliente, notamos que você está sem comprar.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.comoAbordar).toBeNull();
  });

  test('E-12: comoAbordar urgência para JANELA_DE_RECOMPRA → CONTRACT_BLOCK', async () => {
    const ctx = ctxAgir('JANELA_DE_RECOMPRA');
    const r = await calcularSellerAssist(ctx, sinaisAtrasado(), { provider: mockOK('O cliente precisa comprar agora para não perder a janela.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.comoAbordar).toBeNull();
  });

  test('E-13: fallback (provider throw) → situacao não nula', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockError() });
    expect(r.situacao).toBeTruthy();
  });

  test('E-14: fallback (provider throw) → quando não nulo', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockError() });
    expect(r.quando).toBe('Ação recomendada: neste ciclo.');
  });

  test('E-15: fallback → llmUsed=false (provider nunca foi chamado com sucesso)', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockError() });
    expect(r.metadata.llmUsed).toBe(false);
  });

  test('E-16: sem provider → INFRA_ERROR (não FAIL_CLOSED)', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), {});
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.INFRA_ERROR);
    expect(r.modo).not.toBe('FAIL_CLOSED');
  });

  test('E-17: CONTRACT_BLOCK → llmUsed=true (LLM foi chamada, output bloqueado)', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('O cliente mudou de fornecedor.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.metadata.llmUsed).toBe(true);
  });

  test('E-18: CONTRACT_BLOCK → sinais presente (contexto foi construído)', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('AGIR_AGORA deve ser usado.') });
    expect(r.metadata.llmStatus).toBe(LLM_STATUS.CONTRACT_BLOCK);
    expect(r.sinais).not.toBeNull();
    expect(r.sinais.diasSemComprar).toBe(100);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// F — Minimização de contexto (10 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('F — Minimização de contexto', () => {

  const ctxComProibidos = Object.assign(ctxAgir(), {
    clienteMr4Id:    'REAL-ID-001',
    nomeCliente:     'Cliente Real',
    cpf:             '123.456.789-01',
    cnpj:            '12.345.678/0001-99',
    faturamento30d:  5000,
    pedidos30d:      10,
    scoreTotal:      88,
    gestaoClickId:   'GC-99999',
    observacoes:     'texto livre com PII',
  });

  test('F-01: sinais não contém clienteMr4Id', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('clienteMr4Id');
  });

  test('F-02: sinais não contém nomeCliente', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('nomeCliente');
  });

  test('F-03: sinais não contém cpf', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('cpf');
  });

  test('F-04: sinais não contém faturamento30d', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('faturamento30d');
  });

  test('F-05: sinais não contém pedidos30d', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('pedidos30d');
  });

  test('F-06: sinais não contém scoreTotal', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('scoreTotal');
  });

  test('F-07: sinais não contém observacoes', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais).not.toHaveProperty('observacoes');
  });

  test('F-08: sinais contém diasSemComprar (campo permitido)', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.diasSemComprar).toBe(100);
  });

  test('F-09: sinais contém cicloMedianoDias (campo permitido)', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.cicloMedianoDias).toBe(20);
  });

  test('F-10: sinais contém tendencia (campo permitido)', async () => {
    const r = await calcularSellerAssist(ctxComProibidos, sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(r.sinais.tendencia).toBe('CAINDO');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// G — Sanitização de trace/audit (8 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('G — Sanitização de trace/audit', () => {

  test('G-01: prompt enviado ao provider não contém clienteMr4Id', async () => {
    const mock = mockCapturador('Investigue.');
    const ctx  = Object.assign(ctxAgir(), { clienteMr4Id: 'REAL-ID-001' });
    await calcularSellerAssist(ctx, sinaisAtrasado(), { provider: mock });
    const prompt = mock.getChamadas()[0].prompt;
    expect(prompt).not.toContain('clienteMr4Id');
    expect(prompt).not.toContain('REAL-ID-001');
  });

  test('G-02: prompt não contém nomeCliente', async () => {
    const mock = mockCapturador('Investigue.');
    const ctx  = Object.assign(ctxAgir(), { nomeCliente: 'Cliente Teste' });
    await calcularSellerAssist(ctx, sinaisAtrasado(), { provider: mock });
    const prompt = mock.getChamadas()[0].prompt;
    expect(prompt).not.toContain('nomeCliente');
    expect(prompt).not.toContain('Cliente Teste');
  });

  test('G-03: prompt não contém faturamento30d', async () => {
    const mock = mockCapturador('Investigue.');
    const ctx  = Object.assign(ctxAgir(), { faturamento30d: 9999 });
    await calcularSellerAssist(ctx, sinaisAtrasado(), { provider: mock });
    const prompt = mock.getChamadas()[0].prompt;
    expect(prompt).not.toContain('faturamento30d');
  });

  test('G-04: prompt não contém pedidos30d', async () => {
    const mock = mockCapturador('Investigue.');
    const ctx  = Object.assign(ctxAgir(), { pedidos30d: 25 });
    await calcularSellerAssist(ctx, sinaisAtrasado(), { provider: mock });
    const prompt = mock.getChamadas()[0].prompt;
    expect(prompt).not.toContain('pedidos30d');
  });

  test('G-05: provider.complete chamado com modelo gpt-5.6-luna', async () => {
    let capturedOpcoes;
    const provider = {
      nome:     'MockCapt',
      complete: async (p, o) => { capturedOpcoes = o; return { texto: JSON.stringify({ comoAbordar: 'Investigue.' }), tokens: { input: 5, output: 5 }, modelo: 'mock', latenciaMs: 0 }; },
    };
    await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider });
    expect(capturedOpcoes.modelo).toBe('gpt-5.6-luna');
  });

  test('G-06: resultado para PROGRAMAR_CICLO não expõe campos internos', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO', scoreTotal: 99, prioridade: 1 });
    const json = JSON.stringify(r);
    expect(json).not.toContain('scoreTotal');
    expect(json).not.toContain('prioridade');
  });

  test('G-07: resultado para NAO_AGIR não expõe campos internos', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR', scoreTotal: 50 });
    const json = JSON.stringify(r);
    expect(json).not.toContain('scoreTotal');
  });

  test('G-08: prompt contém tipoOportunidade (campo permitido)', async () => {
    const mock = mockCapturador('Investigue.');
    await calcularSellerAssist(ctxAgir('QUEDA_DE_COMPRAS'), sinaisAtrasado(), { provider: mock });
    const prompt = mock.getChamadas()[0].prompt;
    expect(prompt).toContain('tipoOportunidade');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// H — Regressão / Imutabilidade (8 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('H — Regressão / Imutabilidade', () => {

  test('H-01: VERSAO_SELLER_ASSIST = "seller-assist-v1"', () => {
    expect(VERSAO_SELLER_ASSIST).toBe('seller-assist-v1');
  });

  test('H-02: LLM_STATUS é frozen', () => {
    expect(Object.isFrozen(LLM_STATUS)).toBe(true);
  });

  test('H-03: LLM_STATUS.SUCCESS = "LLM_SUCCESS"', () => {
    expect(LLM_STATUS.SUCCESS).toBe('LLM_SUCCESS');
  });

  test('H-04: metadata frozen para AGIR_AGORA sucesso', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(Object.isFrozen(r.metadata)).toBe(true);
  });

  test('H-05: metadata frozen para PROGRAMAR_CICLO', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'PROGRAMAR_CICLO' });
    expect(Object.isFrozen(r.metadata)).toBe(true);
  });

  test('H-06: metadata frozen para FAIL_CLOSED', async () => {
    const r = await calcularSellerAssist({ decisaoAcaoComercial: 'DESCONHECIDO' });
    expect(Object.isFrozen(r.metadata)).toBe(true);
  });

  test('H-07: sinais frozen quando presente', async () => {
    const r = await calcularSellerAssist(ctxAgir(), sinaisAtrasado(), { provider: mockOK('Investigue.') });
    expect(Object.isFrozen(r.sinais)).toBe(true);
  });

  test('H-08: VERSAO_PROMPT exportado de promptComoAbordar = "prompt-como-abordar-v1"', () => {
    expect(VERSAO_PROMPT).toBe('prompt-como-abordar-v1');
  });

});
