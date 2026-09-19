'use strict';

/**
 * N33.6 — End-to-End Shadow Integration Gate
 *
 * Prova que:
 *   1. Decisões determinísticas (score, tendência, recorrência, decisão, oportunidade) rodam
 *      ANTES e INDEPENDENTES de qualquer LLM.
 *   2. O Seller Assist (LLM) está corretamente integrado ao pipeline via opcoes.sellerAssistProvider.
 *   3. PROGRAMAR_CICLO e NAO_AGIR NUNCA chamam o provider (PROVIDER_CALLS=0).
 *   4. Fallbacks de LLM (timeout, 429, 500, JSON ruim, CONTRACT_BLOCK) deixam o pipeline intacto.
 *   5. O provider NUNCA pode alterar score, prioridade, decisaoAcao ou tipoOportunidade.
 *   6. Nenhum PII, clienteMr4Id ou campo proibido vaza para o prompt do provider.
 *   7. AI_MODE=SHADOW; sideEffects=[]; statusServico='SHADOW'.
 *
 * INVARIANTES:
 *   OPENAI_CALLS=0 | PROD_WRITES=0 | DEPLOYS=0 | AI_MODE=SHADOW
 *   SELLER_VISIBLE_PATHS_CONNECTED=0 (outputs ficam no resultado, nunca chegam ao vendedor)
 */

const { executarPipelineComercial } = require('../lib/ai/servicoAgenteComercial');
const { MockProvider }              = require('../lib/ai/provider');
const {
  FIXTURE_INATIVO_120D,
  FIXTURE_ATIVO_EXCELENTE,
  FIXTURE_NUNCA_COMPROU,
  DATA_REF,
} = require('./fixtures/agente-comercial/perfis-fixture');

// ── Fixtures inline ───────────────────────────────────────────────────────────

// QUEDA limpa: tendência=CAINDO, recorrência=DENTRO_DO_PADRAO (sem JANELA concorrente)
const FIXTURE_QUEDA_LIMPA = {
  clienteMr4Id:  'FIXTURE_QUEDA_LIMPA',
  gestaoClickId: 'gc_queda_limpa',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,
  inativo120d:   false,
  diasSemComprar: 20,            // < round(30*0.85)=26 → DENTRO_DO_PADRAO
  ultimaCompraEm: '2026-08-27',
  faturamentoTotal: 8000,
  faturamento90d:   2000,
  faturamento30d:    300,        // prev30_60 = 1500-300=1200; ratio=300/1200=0.25 → CAINDO
  faturamento60d:   1500,
  faturamento180d:  5000,
  pedidosTotal: 15,
  pedidos90d:    4,
  pedidos30d:    1,
  pedidos60d:    3,
  pedidos180d:   8,
  diasEntreComprasMedio:   32,
  diasEntreComprasMediana: 30,
  quantidadeProdutosDistintos: 5,
  categoriasMaisCompradas: [
    { categoria: 'CAT_A', faturamento: 4500 },
    { categoria: 'CAT_B', faturamento: 3500 },
  ],
};

// JANELA: tendência=ESTAVEL, recorrência=ATRASADO_VS_HISTORICO, !inativo120d
const FIXTURE_JANELA = {
  clienteMr4Id:  'FIXTURE_JANELA_001',
  gestaoClickId: 'gc_janela_001',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,
  inativo120d:   false,
  diasSemComprar: 40,            // > round(30*1.10)=33 → ATRASADO_VS_HISTORICO
  ultimaCompraEm: '2026-08-07',
  faturamentoTotal: 10000,
  faturamento90d:    3000,
  faturamento30d:    1500,       // prev=3000-1500=1500; ratio=1.0 → ESTAVEL (não CAINDO)
  faturamento60d:    3000,
  faturamento180d:   7000,
  pedidosTotal: 20,
  pedidos90d:    6,
  pedidos30d:    2,
  pedidos60d:    4,              // prev=4-2=2; ratio=1.0 → ESTAVEL
  pedidos180d:  12,
  diasEntreComprasMedio:   32,
  diasEntreComprasMediana: 30,
  quantidadeProdutosDistintos: 5,
  categoriasMaisCompradas: [
    { categoria: 'CAT_A', faturamento: 6000 },
    { categoria: 'CAT_B', faturamento: 4000 },
  ],
};

// NAO_AGIR: sem histórico de compras, sem mediana, sem oportunidade gerada
const FIXTURE_NAO_AGIR = {
  clienteMr4Id:  'FIXTURE_NAO_AGIR',
  gestaoClickId: 'gc_nao_agir',
  dataReferencia: DATA_REF,
  nuncaComprou:  false,          // não é PROSPECT_VINCULADO
  inativo120d:   false,          // não é REATIVACAO
  diasSemComprar: 90,            // < 120 → não inativo; mas mediana=null → SEM_BASE
  ultimaCompraEm: '2026-06-17',
  faturamentoTotal: 200,
  faturamento90d:   200,
  faturamento30d:     0,
  faturamento60d:     0,
  faturamento180d:  200,
  pedidosTotal:  1,
  pedidos90d:    0,
  pedidos30d:    0,
  pedidos60d:    0,
  pedidos180d:   1,
  diasEntreComprasMedio:   null,
  diasEntreComprasMediana: null,  // → SEM_BASE → NAO_AGIR
  quantidadeProdutosDistintos: 1,
  categoriasMaisCompradas: [{ categoria: 'CAT_A', faturamento: 200 }],
};

// ── Helpers de provider ───────────────────────────────────────────────────────

function mockOK(comoAbordar = 'Investigue a situação atual.') {
  return new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ comoAbordar }) });
}

function mockError(msg = 'Timeout simulado') {
  return { nome: 'MockError', async complete() { throw new Error(msg); } };
}

function mockBadJson() {
  return new MockProvider({ 'COMO_ABORDAR': 'not-valid-json{{' });
}

function mockCapturador(comoAbordar = 'Investigue a situação.') {
  const chamadas = [];
  return {
    nome: 'MockCapt',
    async complete(prompt, opcoes) {
      chamadas.push({ prompt, opcoes });
      return { texto: JSON.stringify({ comoAbordar }), tokens: 10 };
    },
    getChamadas() { return chamadas; },
  };
}

function mockMalicioso() {
  const payload = JSON.stringify({
    comoAbordar: 'Investigue.',
    scoreTotal: 999,
    decisaoAcaoComercial: 'NAO_AGIR',
    tipoOportunidade: 'CROSS_SELL_CATEGORIA',
    prioridade: 100,
  });
  return new MockProvider({ 'COMO_ABORDAR': payload });
}

// Helper: executa pipeline com sellerAssistProvider (sem o provider padrão do pipeline)
async function executar(perfil, sellerAssistProvider = null, extra = {}) {
  return executarPipelineComercial(perfil, {
    dataReferencia: DATA_REF,
    sellerAssistProvider,
    ...extra,
  });
}

// ── A — Pipeline Routing (10 testes) ─────────────────────────────────────────

describe('A — Pipeline Routing', () => {
  test('A-01: FIXTURE_INATIVO_120D → decisaoAcaoComercial = AGIR_AGORA', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r.decisaoAcaoComercial).toBe('AGIR_AGORA');
  });

  test('A-02: FIXTURE_INATIVO_120D sem provider → sellerAssist.modo = HYBRID', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r.sellerAssist.modo).toBe('HYBRID');
  });

  test('A-03: FIXTURE_ATIVO_EXCELENTE → decisaoAcaoComercial = PROGRAMAR_CICLO', async () => {
    const r = await executar(FIXTURE_ATIVO_EXCELENTE);
    expect(r.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
  });

  test('A-04: FIXTURE_ATIVO_EXCELENTE → sellerAssist.modo = DETERMINISTIC', async () => {
    const r = await executar(FIXTURE_ATIVO_EXCELENTE);
    expect(r.sellerAssist.modo).toBe('DETERMINISTIC');
  });

  test('A-05: FIXTURE_NAO_AGIR → decisaoAcaoComercial = NAO_AGIR', async () => {
    const r = await executar(FIXTURE_NAO_AGIR);
    expect(r.decisaoAcaoComercial).toBe('NAO_AGIR');
  });

  test('A-06: FIXTURE_NAO_AGIR → sellerAssist.modo = DETERMINISTIC', async () => {
    const r = await executar(FIXTURE_NAO_AGIR);
    expect(r.sellerAssist.modo).toBe('DETERMINISTIC');
  });

  test('A-07: AGIR_AGORA sem provider → llmStatus = INFRA_ERROR', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, null);
    expect(r.sellerAssist.metadata.llmStatus).toBe('INFRA_ERROR');
  });

  test('A-08: PROGRAMAR_CICLO → llmStatus = NOT_ELIGIBLE', async () => {
    const r = await executar(FIXTURE_ATIVO_EXCELENTE);
    expect(r.sellerAssist.metadata.llmStatus).toBe('NOT_ELIGIBLE');
  });

  test('A-09: resultado inclui campo sellerAssist', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r).toHaveProperty('sellerAssist');
    expect(r.sellerAssist).toBeDefined();
  });

  test('A-10: resultado inclui campo decisaoAcaoComercial', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r).toHaveProperty('decisaoAcaoComercial');
    expect(['AGIR_AGORA', 'PROGRAMAR_CICLO', 'NAO_AGIR']).toContain(r.decisaoAcaoComercial);
  });
});

// ── B — AGIR_AGORA: REATIVACAO_120D (10 testes) ───────────────────────────────

describe('B — AGIR_AGORA: REATIVACAO_120D', () => {
  let resultado;

  beforeAll(async () => {
    resultado = await executar(FIXTURE_INATIVO_120D, mockOK('Investigue o motivo da pausa nas compras.'));
  });

  test('B-01: llmStatus = LLM_SUCCESS', () => {
    expect(resultado.sellerAssist.metadata.llmStatus).toBe('LLM_SUCCESS');
  });

  test('B-02: comoAbordar é string não vazia', () => {
    expect(typeof resultado.sellerAssist.comoAbordar).toBe('string');
    expect(resultado.sellerAssist.comoAbordar.trim().length).toBeGreaterThan(0);
  });

  test('B-03: modo = HYBRID', () => {
    expect(resultado.sellerAssist.modo).toBe('HYBRID');
  });

  test('B-04: metadata.llmUsed = true', () => {
    expect(resultado.sellerAssist.metadata.llmUsed).toBe(true);
  });

  test('B-05: situacao contém diasSemComprar (150)', () => {
    expect(resultado.sellerAssist.situacao).toContain('150');
  });

  test('B-06: sinais !== null', () => {
    expect(resultado.sellerAssist.sinais).not.toBeNull();
  });

  test('B-07: quando = "Ação recomendada: neste ciclo."', () => {
    expect(resultado.sellerAssist.quando).toBe('Ação recomendada: neste ciclo.');
  });

  test('B-08: pipeline padrão completo (score, tendencia, oportunidades)', () => {
    expect(resultado.score).toBeDefined();
    expect(resultado.tendencia).toBeDefined();
    expect(resultado.oportunidades).toBeDefined();
    expect(resultado.analise).toBeDefined();
  });

  test('B-09: oportunidades[0].tipo = REATIVACAO_120D', () => {
    expect(resultado.oportunidades[0]?.tipo).toBe('REATIVACAO_120D');
  });

  test('B-10: metadata.versaoPrompt = "prompt-como-abordar-v1"', () => {
    expect(resultado.sellerAssist.metadata.versaoPrompt).toBe('prompt-como-abordar-v1');
  });
});

// ── C — AGIR_AGORA: QUEDA_DE_COMPRAS (8 testes) ──────────────────────────────

describe('C — AGIR_AGORA: QUEDA_DE_COMPRAS', () => {
  let resultado;

  beforeAll(async () => {
    resultado = await executar(FIXTURE_QUEDA_LIMPA, mockOK('Investigue a redução no ritmo de compras.'));
  });

  test('C-01: llmStatus = LLM_SUCCESS', () => {
    expect(resultado.sellerAssist.metadata.llmStatus).toBe('LLM_SUCCESS');
  });

  test('C-02: comoAbordar é string não vazia', () => {
    expect(typeof resultado.sellerAssist.comoAbordar).toBe('string');
    expect(resultado.sellerAssist.comoAbordar.trim().length).toBeGreaterThan(0);
  });

  test('C-03: modo = HYBRID', () => {
    expect(resultado.sellerAssist.modo).toBe('HYBRID');
  });

  test('C-04: decisaoAcaoComercial = AGIR_AGORA', () => {
    expect(resultado.decisaoAcaoComercial).toBe('AGIR_AGORA');
  });

  test('C-05: oportunidades[0].tipo = QUEDA_DE_COMPRAS', () => {
    expect(resultado.oportunidades[0]?.tipo).toBe('QUEDA_DE_COMPRAS');
  });

  test('C-06: situacao contém referência a queda ou dias sem comprar', () => {
    const sit = resultado.sellerAssist.situacao.toLowerCase();
    expect(sit.includes('queda') || sit.includes('dias')).toBe(true);
  });

  test('C-07: metadata.llmUsed = true', () => {
    expect(resultado.sellerAssist.metadata.llmUsed).toBe(true);
  });

  test('C-08: pipeline completo (analise presente)', () => {
    expect(resultado.analise).toBeDefined();
    expect(resultado.score).toBeDefined();
  });
});

// ── D — AGIR_AGORA: JANELA_DE_RECOMPRA (8 testes) ────────────────────────────

describe('D — AGIR_AGORA: JANELA_DE_RECOMPRA', () => {
  let resultado;

  beforeAll(async () => {
    resultado = await executar(FIXTURE_JANELA, mockOK('Faça um acompanhamento leve para verificar necessidade.'));
  });

  test('D-01: llmStatus = LLM_SUCCESS', () => {
    expect(resultado.sellerAssist.metadata.llmStatus).toBe('LLM_SUCCESS');
  });

  test('D-02: comoAbordar é string não vazia', () => {
    expect(typeof resultado.sellerAssist.comoAbordar).toBe('string');
    expect(resultado.sellerAssist.comoAbordar.trim().length).toBeGreaterThan(0);
  });

  test('D-03: modo = HYBRID', () => {
    expect(resultado.sellerAssist.modo).toBe('HYBRID');
  });

  test('D-04: oportunidades[0].tipo = JANELA_DE_RECOMPRA', () => {
    expect(resultado.oportunidades[0]?.tipo).toBe('JANELA_DE_RECOMPRA');
  });

  test('D-05: decisaoAcaoComercial = AGIR_AGORA', () => {
    expect(resultado.decisaoAcaoComercial).toBe('AGIR_AGORA');
  });

  test('D-06: metadata.llmUsed = true', () => {
    expect(resultado.sellerAssist.metadata.llmUsed).toBe(true);
  });

  test('D-07: situacao contém "janela" ou "recompra"', () => {
    const sit = resultado.sellerAssist.situacao.toLowerCase();
    expect(sit.includes('janela') || sit.includes('recompra')).toBe(true);
  });

  test('D-08: pipeline completo (score, analise presentes)', () => {
    expect(resultado.score).toBeDefined();
    expect(resultado.analise).toBeDefined();
  });
});

// ── E — PROGRAMAR_CICLO: zero LLM (8 testes) ─────────────────────────────────

describe('E — PROGRAMAR_CICLO: zero LLM', () => {
  let resultado;
  let capturador;

  beforeAll(async () => {
    capturador = mockCapturador();
    resultado = await executar(FIXTURE_ATIVO_EXCELENTE, capturador);
  });

  test('E-01: modo = DETERMINISTIC', () => {
    expect(resultado.sellerAssist.modo).toBe('DETERMINISTIC');
  });

  test('E-02: comoAbordar = null', () => {
    expect(resultado.sellerAssist.comoAbordar).toBeNull();
  });

  test('E-03: metadata.llmUsed = false', () => {
    expect(resultado.sellerAssist.metadata.llmUsed).toBe(false);
  });

  test('E-04: metadata.llmStatus = NOT_ELIGIBLE', () => {
    expect(resultado.sellerAssist.metadata.llmStatus).toBe('NOT_ELIGIBLE');
  });

  test('E-05: situacao é string não vazia (determinístico)', () => {
    expect(typeof resultado.sellerAssist.situacao).toBe('string');
    expect(resultado.sellerAssist.situacao.trim().length).toBeGreaterThan(0);
  });

  test('E-06: quando é string não nula (próximo ciclo)', () => {
    expect(typeof resultado.sellerAssist.quando).toBe('string');
    expect(resultado.sellerAssist.quando.trim().length).toBeGreaterThan(0);
  });

  test('E-07: PROVIDER_CALLS = 0 mesmo com provider injetado', () => {
    expect(capturador.getChamadas().length).toBe(0);
  });

  test('E-08: decisaoAcaoComercial = PROGRAMAR_CICLO', () => {
    expect(resultado.decisaoAcaoComercial).toBe('PROGRAMAR_CICLO');
  });
});

// ── F — NAO_AGIR: zero LLM (6 testes) ────────────────────────────────────────

describe('F — NAO_AGIR: zero LLM', () => {
  let resultado;
  let capturador;

  beforeAll(async () => {
    capturador = mockCapturador();
    resultado = await executar(FIXTURE_NAO_AGIR, capturador);
  });

  test('F-01: modo = DETERMINISTIC', () => {
    expect(resultado.sellerAssist.modo).toBe('DETERMINISTIC');
  });

  test('F-02: comoAbordar = null', () => {
    expect(resultado.sellerAssist.comoAbordar).toBeNull();
  });

  test('F-03: metadata.llmUsed = false', () => {
    expect(resultado.sellerAssist.metadata.llmUsed).toBe(false);
  });

  test('F-04: metadata.llmStatus = NOT_ELIGIBLE', () => {
    expect(resultado.sellerAssist.metadata.llmStatus).toBe('NOT_ELIGIBLE');
  });

  test('F-05: PROVIDER_CALLS = 0', () => {
    expect(capturador.getChamadas().length).toBe(0);
  });

  test('F-06: decisaoAcaoComercial = NAO_AGIR', () => {
    expect(resultado.decisaoAcaoComercial).toBe('NAO_AGIR');
  });
});

// ── G — Fallback (14 testes) ──────────────────────────────────────────────────

describe('G — Fallback: LLM Down', () => {
  test('G-01: provider throw timeout → llmStatus = INFRA_ERROR', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockError('Timeout simulado'));
    expect(r.sellerAssist.metadata.llmStatus).toBe('INFRA_ERROR');
  });

  test('G-02: provider throw → comoAbordar = null', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockError());
    expect(r.sellerAssist.comoAbordar).toBeNull();
  });

  test('G-03: provider throw → modo = HYBRID (tentativa foi feita)', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockError());
    expect(r.sellerAssist.modo).toBe('HYBRID');
  });

  test('G-04: provider throw → situacao e quando preservados', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockError());
    expect(typeof r.sellerAssist.situacao).toBe('string');
    expect(r.sellerAssist.quando).toBe('Ação recomendada: neste ciclo.');
  });

  test('G-05: bad JSON → llmStatus = INFRA_ERROR', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockBadJson());
    expect(r.sellerAssist.metadata.llmStatus).toBe('INFRA_ERROR');
  });

  test('G-06: bad JSON → comoAbordar = null', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockBadJson());
    expect(r.sellerAssist.comoAbordar).toBeNull();
  });

  test('G-07: sem provider (null) para AGIR_AGORA → INFRA_ERROR', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, null);
    expect(r.sellerAssist.metadata.llmStatus).toBe('INFRA_ERROR');
  });

  test('G-08: sem provider → modo = HYBRID (rota AGIR_AGORA foi ativada)', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, null);
    expect(r.sellerAssist.modo).toBe('HYBRID');
  });

  test('G-09: CONTRACT_BLOCK saudação → llmStatus = CONTRACT_BLOCK', async () => {
    const p = new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ comoAbordar: 'Olá! Tudo bem? Vamos ver o que você precisa.' }) });
    const r = await executar(FIXTURE_INATIVO_120D, p);
    expect(r.sellerAssist.metadata.llmStatus).toBe('CONTRACT_BLOCK');
  });

  test('G-10: CONTRACT_BLOCK → llmUsed = true', async () => {
    const p = new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ comoAbordar: 'Olá! Como vai?' }) });
    const r = await executar(FIXTURE_INATIVO_120D, p);
    expect(r.sellerAssist.metadata.llmUsed).toBe(true);
  });

  test('G-11: CONTRACT_BLOCK → comoAbordar = null', async () => {
    const p = new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ comoAbordar: 'Olá! Como vai?' }) });
    const r = await executar(FIXTURE_INATIVO_120D, p);
    expect(r.sellerAssist.comoAbordar).toBeNull();
  });

  test('G-12: CONTRACT_BLOCK autoridade financeira → CONTRACT_BLOCK', async () => {
    const p = new MockProvider({ 'COMO_ABORDAR': JSON.stringify({ comoAbordar: 'Ofereça desconto de 15% no pedido.' }) });
    const r = await executar(FIXTURE_INATIVO_120D, p);
    expect(r.sellerAssist.metadata.llmStatus).toBe('CONTRACT_BLOCK');
  });

  test('G-13: pipeline continua normalmente após falha do Seller Assist', async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockError('500 Internal Server Error'));
    expect(r.analise).toBeDefined();
    expect(r.score).toBeDefined();
    expect(r.oportunidades).toBeDefined();
  });

  test('G-14: provider 429-like (throw) → INFRA_ERROR', async () => {
    const p = mockError('Request failed with status code 429');
    const r = await executar(FIXTURE_INATIVO_120D, p);
    expect(r.sellerAssist.metadata.llmStatus).toBe('INFRA_ERROR');
  });
});

// ── H — Autoridade do LLM (8 testes) ─────────────────────────────────────────

describe('H — LLM Authority: provider não pode alterar decisões determinísticas', () => {
  let resultado;
  const scoreOriginal = {};

  beforeAll(async () => {
    resultado = await executar(FIXTURE_INATIVO_120D, mockMalicioso());
    scoreOriginal.total = resultado.score.scoreTotal;
  });

  test('H-01: scoreTotal não alterado (provider retornou scoreTotal=999)', () => {
    expect(resultado.score.scoreTotal).toBe(scoreOriginal.total);
    expect(resultado.score.scoreTotal).not.toBe(999);
  });

  test('H-02: decisaoAcaoComercial não alterado (provider retornou NAO_AGIR)', () => {
    expect(resultado.decisaoAcaoComercial).toBe('AGIR_AGORA');
    expect(resultado.decisaoAcaoComercial).not.toBe('NAO_AGIR');
  });

  test('H-03: oportunidades[0].tipo não alterado (provider retornou CROSS_SELL)', () => {
    expect(resultado.oportunidades[0]?.tipo).toBe('REATIVACAO_120D');
    expect(resultado.oportunidades[0]?.tipo).not.toBe('CROSS_SELL_CATEGORIA');
  });

  test('H-04: oportunidades[0].prioridade não alterado (provider retornou 100)', () => {
    const prioOriginal = resultado.oportunidades[0]?.prioridade;
    expect(prioOriginal).toBeDefined();
    expect(prioOriginal).not.toBe(100);
  });

  test('H-05: sellerAssist é frozen (imutável)', () => {
    expect(Object.isFrozen(resultado.sellerAssist)).toBe(true);
  });

  test('H-06: sellerAssist.metadata é frozen', () => {
    expect(Object.isFrozen(resultado.sellerAssist.metadata)).toBe(true);
  });

  test('H-07: sellerAssist.sinais é frozen quando presente', () => {
    if (resultado.sellerAssist.sinais !== null) {
      expect(Object.isFrozen(resultado.sellerAssist.sinais)).toBe(true);
    } else {
      expect(resultado.sellerAssist.sinais).toBeNull();
    }
  });

  test('H-08: provider chamado exatamente uma vez (sem loop de retry)', async () => {
    const capt = mockCapturador('Investigue o ciclo.');
    await executar(FIXTURE_INATIVO_120D, capt);
    expect(capt.getChamadas().length).toBe(1);
  });
});

// ── I — Context Leak Prevention (8 testes) ───────────────────────────────────

describe('I — Context Leak: nenhum PII ou ID real no prompt do provider', () => {
  let chamadas;

  beforeAll(async () => {
    const capt = mockCapturador('Investigue.');
    await executar(FIXTURE_INATIVO_120D, capt);
    chamadas = capt.getChamadas();
  });

  test('I-01: provider foi chamado (pré-requisito do grupo)', () => {
    expect(chamadas.length).toBeGreaterThan(0);
  });

  test('I-02: prompt NÃO contém clienteMr4Id (FIXTURE_003)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).not.toContain('FIXTURE_003');
  });

  test('I-03: prompt NÃO contém gestaoClickId (gc_fixture_003)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).not.toContain('gc_fixture_003');
  });

  test('I-04: prompt NÃO contém faturamentoTotal (campo financeiro bruto)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).not.toContain('faturamentoTotal');
  });

  test('I-05: prompt NÃO contém scoreTotal (campo interno)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).not.toContain('scoreTotal');
  });

  test('I-06: prompt NÃO contém prioridade (campo interno de oportunidade)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).not.toContain('prioridade');
  });

  test('I-07: prompt contém "tipoOportunidade" (campo permitido)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).toContain('tipoOportunidade');
  });

  test('I-08: prompt contém "diasSemComprar" (campo permitido)', () => {
    const prompt = chamadas[0].prompt;
    expect(prompt).toContain('diasSemComprar');
  });
});

// ── J — Trace / Audit (4 testes) ─────────────────────────────────────────────

describe('J — Trace: novos spans registrados', () => {
  let traceData;

  beforeAll(async () => {
    const r = await executar(FIXTURE_INATIVO_120D, mockOK('Investigue.'));
    traceData = r.trace;
  });

  test('J-01: span calcularDecisaoAcaoComercial presente', () => {
    const spans = traceData.spans || [];
    expect(spans.some(s => s.nome === 'calcularDecisaoAcaoComercial')).toBe(true);
  });

  test('J-02: span calcularSinaisComerciais presente', () => {
    const spans = traceData.spans || [];
    expect(spans.some(s => s.nome === 'calcularSinaisComerciais')).toBe(true);
  });

  test('J-03: span calcularSellerAssist presente', () => {
    const spans = traceData.spans || [];
    expect(spans.some(s => s.nome === 'calcularSellerAssist')).toBe(true);
  });

  test('J-04: span calcularSellerAssist registra modo e llmStatus em saida', () => {
    const spans = traceData.spans || [];
    const span  = spans.find(s => s.nome === 'calcularSellerAssist');
    expect(span).toBeDefined();
    expect(span.saida).toHaveProperty('modo');
    expect(span.saida).toHaveProperty('llmStatus');
  });
});

// ── K — Shadow Boundary (4 testes) ───────────────────────────────────────────

describe('K — Shadow Boundary', () => {
  test('K-01: aiMode = SHADOW', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r.aiMode).toBe('SHADOW');
  });

  test('K-02: sideEffects = []', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r.sideEffects).toEqual([]);
  });

  test('K-03: statusServico = SHADOW', async () => {
    const r = await executar(FIXTURE_INATIVO_120D);
    expect(r.statusServico).toBe('SHADOW');
  });

  test('K-04: output LLM (comoAbordar) não aparece em analise (engines separados)', async () => {
    const comoAbordar = 'OUTPUT_LLM_UNICO_TESTE_K04';
    const r = await executar(FIXTURE_INATIVO_120D, mockOK(comoAbordar));
    expect(r.sellerAssist.comoAbordar).toBe(comoAbordar);
    const analiseStr = JSON.stringify(r.analise);
    expect(analiseStr).not.toContain(comoAbordar);
  });
});

// ── L — Non-V1 tipo / FAIL_CLOSED (4 testes) ─────────────────────────────────

describe('L — Non-V1 tipo: FAIL_CLOSED', () => {
  test('L-01: PROSPECT_VINCULADO → sellerAssist.modo = FAIL_CLOSED', async () => {
    const r = await executar(FIXTURE_NUNCA_COMPROU, mockOK('Qualquer coisa.'));
    expect(r.sellerAssist.modo).toBe('FAIL_CLOSED');
  });

  test('L-02: PROSPECT_VINCULADO → comoAbordar = null', async () => {
    const r = await executar(FIXTURE_NUNCA_COMPROU);
    expect(r.sellerAssist.comoAbordar).toBeNull();
  });

  test('L-03: PROSPECT_VINCULADO → llmStatus = FAIL_CLOSED', async () => {
    const r = await executar(FIXTURE_NUNCA_COMPROU);
    expect(r.sellerAssist.metadata.llmStatus).toBe('FAIL_CLOSED');
  });

  test('L-04: PROSPECT_VINCULADO → decisaoAcaoComercial = AGIR_AGORA (motor determinístico intacto)', async () => {
    const r = await executar(FIXTURE_NUNCA_COMPROU);
    expect(r.decisaoAcaoComercial).toBe('AGIR_AGORA');
  });
});
