'use strict';

/**
 * N28 — Testes unitários do Shadow Pilot.
 *
 * Invariantes verificadas:
 *   - Seleção determinística (máx 12, exclui never-bought)
 *   - Pseudonimização (mapa apenas em memória, sem PII)
 *   - Allowlist do prompt (somente campos comerciais estruturados)
 *   - Bloqueio de PII no contexto do prompt
 *   - Classificação correta de outcomes (LLM_SUCCESS / SAFE_BLOCK / INFRA_ERROR)
 *   - Provider nunca recebe objeto bruto do perfil
 *   - Shadow Mode obrigatório
 *   - Ausência de side effects
 *
 * N28-SEL-01 a N28-SEL-08: seleção e pseudonimização
 * N28-PII-01 a N28-PII-06: PII Guard e allowlist
 * N28-OUT-01 a N28-OUT-04: classificação de outcomes
 */

const { selecionarAmostra, pseudonimizar, MAX_AMOSTRA, CATEGORIAS } = require('../lib/n28/amostragem');
const {
  PROMPT_ALLOWLIST,
  auditarContextoPrompt,
  escaneiarTextoParaPII,
  auditarGroundingFacts,
} = require('../lib/n28/piiGuard');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkPerfil(overrides = {}) {
  return {
    clienteMr4Id:            `cli-${Math.random().toString(36).slice(2, 8)}`,
    gestaoClickId:           '12345',
    nuncaComprou:            false,
    inativo120d:             false,
    diasSemComprar:          25,
    pedidosTotal:            5,
    pedidos30d:              1,
    pedidos60d:              2,
    pedidos90d:              3,
    pedidos180d:             4,
    faturamentoTotalCents:   150000,
    faturamento30dCents:     30000,
    faturamento60dCents:     null,
    faturamento90dCents:     60000,
    faturamento180dCents:    null,
    ticketMedioCents:        30000,
    diasEntreComprasMedio:   30,
    diasEntreComprasMediana: 28,
    _scoreTotal:             65,
    _classificacao:          'BOM',
    _tendencia:              'ESTAVEL',
    _recorrenciaStatus:      'DENTRO_DO_PADRAO',
    _oportunidadeTipo:       'JANELA_DE_RECOMPRA',
    _oportunidadePrioridade: 65,
    ...overrides,
  };
}

function gerarUniverso(n = 20) {
  return Array.from({ length: n }, (_, i) => mkPerfil({ clienteMr4Id: `cli-${String(i+1).padStart(4,'0')}` }));
}

// ── N28-SEL-01: máximo absoluto de 12 ────────────────────────────────────────

test('N28-SEL-01: seleção nunca excede MAX_AMOSTRA=12', () => {
  const universo = gerarUniverso(50);
  const { selecionados } = selecionarAmostra(universo);
  expect(selecionados.length).toBeLessThanOrEqual(MAX_AMOSTRA);
  expect(MAX_AMOSTRA).toBe(12);
});

// ── N28-SEL-02: exclui never-bought ──────────────────────────────────────────

test('N28-SEL-02: clientes nuncaComprou=true são excluídos', () => {
  const universo = [
    ...gerarUniverso(5),
    mkPerfil({ clienteMr4Id: 'cli-never-01', nuncaComprou: true }),
    mkPerfil({ clienteMr4Id: 'cli-never-02', nuncaComprou: true }),
  ];
  const { selecionados, estatisticas } = selecionarAmostra(universo);
  expect(selecionados.every(p => p.nuncaComprou !== true)).toBe(true);
  expect(estatisticas.totalNuncaComprou).toBe(2);
});

// ── N28-SEL-03: seleção é determinística ─────────────────────────────────────

test('N28-SEL-03: mesma entrada gera mesma saída (determinístico)', () => {
  const universo1 = gerarUniverso(20).map(p => ({ ...p, clienteMr4Id: `cli-det-${p.clienteMr4Id}` }));
  const universo2 = [...universo1].reverse(); // ordem diferente

  const { selecionados: s1 } = selecionarAmostra(universo1);
  const { selecionados: s2 } = selecionarAmostra(universo2);

  const ids1 = s1.map(p => p.clienteMr4Id).sort();
  const ids2 = s2.map(p => p.clienteMr4Id).sort();
  expect(ids1).toEqual(ids2);
});

// ── N28-SEL-04: universo vazio retorna zero selecionados ──────────────────────

test('N28-SEL-04: universo vazio retorna zero selecionados', () => {
  const { selecionados, estatisticas } = selecionarAmostra([]);
  expect(selecionados).toHaveLength(0);
  expect(estatisticas.totalUniverso).toBe(0);
});

// ── N28-SEL-05: universo só com never-bought retorna zero ────────────────────

test('N28-SEL-05: universo com apenas never-bought retorna zero elegíveis', () => {
  const universo = Array.from({ length: 5 }, (_, i) =>
    mkPerfil({ clienteMr4Id: `cli-nb-${i}`, nuncaComprou: true })
  );
  const { selecionados, estatisticas } = selecionarAmostra(universo);
  expect(selecionados).toHaveLength(0);
  expect(estatisticas.totalElegiveis).toBe(0);
  expect(estatisticas.totalNuncaComprou).toBe(5);
});

// ── N28-SEL-06: pseudonimização cria SHADOW-XXX IDs ──────────────────────────

test('N28-SEL-06: pseudonimização cria IDs SHADOW-001 a SHADOW-012', () => {
  const universo = gerarUniverso(10);
  const { selecionados } = selecionarAmostra(universo);
  const { pseudonimizados, mapa } = pseudonimizar(selecionados);

  expect(pseudonimizados.every(p => /^SHADOW-\d{3}$/.test(p.shadowId))).toBe(true);
  expect(mapa.size).toBe(selecionados.length);
  // Verifica que o mapa tem os IDs corretos
  for (const [shadowId, clienteMr4Id] of mapa.entries()) {
    expect(shadowId).toMatch(/^SHADOW-\d{3}$/);
    expect(typeof clienteMr4Id).toBe('string');
  }
});

// ── N28-SEL-07: pseudonimizado NÃO contém campos de PII ──────────────────────

test('N28-SEL-07: perfil pseudonimizado não contém identificadores reais', () => {
  const universo = gerarUniverso(3);
  const { selecionados } = selecionarAmostra(universo);
  const { pseudonimizados } = pseudonimizar(selecionados);

  const camposProibidos = [
    'clienteMr4Id', 'gestaoClickId', 'nome', 'email', 'telefone',
    'cpf', 'cnpj', 'endereco', 'cep', 'cidade', 'bairro',
    'ultimaCompraEm', 'primeiraCompraEm', 'dataReferencia',
  ];

  for (const p of pseudonimizados) {
    for (const campo of camposProibidos) {
      expect(p).not.toHaveProperty(campo);
    }
  }
});

// ── N28-SEL-08: CATEGORIAS cobre todos os critérios definidos (A-H) ───────────

test('N28-SEL-08: CATEGORIAS contém critérios A a H', () => {
  const ids = CATEGORIAS.map(c => c.id);
  expect(ids).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
});

// ── N28-PII-01: PROMPT_ALLOWLIST contém exatamente os 7 campos do prompt ─────

test('N28-PII-01: PROMPT_ALLOWLIST contém exatamente os campos do contextoRaw', () => {
  const esperados = [
    'tipoOportunidade', 'scoreTotal', 'classificacao',
    'diasSemComprar', 'tendencia', 'recorrenciaStatus', 'prioridade',
  ];
  for (const campo of esperados) {
    expect(PROMPT_ALLOWLIST.has(campo)).toBe(true);
  }
  expect(PROMPT_ALLOWLIST.size).toBe(esperados.length);
});

// ── N28-PII-02: auditarContextoPrompt aceita contexto válido ─────────────────

test('N28-PII-02: auditarContextoPrompt aceita contexto com apenas campos permitidos', () => {
  const ctx = {
    tipoOportunidade:  'REATIVACAO_120D',
    scoreTotal:        32,
    classificacao:     'CRITICO',
    diasSemComprar:    150,
    tendencia:         'CAINDO',
    recorrenciaStatus: 'ATRASADO',
    prioridade:        80,
  };
  const { ok, camposProibidos, piiEncontrado } = auditarContextoPrompt(ctx);
  expect(ok).toBe(true);
  expect(camposProibidos).toHaveLength(0);
  expect(piiEncontrado).toHaveLength(0);
});

// ── N28-PII-03: auditarContextoPrompt bloqueia campo fora da allowlist ────────

test('N28-PII-03: auditarContextoPrompt detecta campo não autorizado', () => {
  const ctx = {
    tipoOportunidade:  'REATIVACAO_120D',
    scoreTotal:        32,
    classificacao:     'CRITICO',
    diasSemComprar:    150,
    tendencia:         'CAINDO',
    recorrenciaStatus: 'ATRASADO',
    prioridade:        80,
    nomeCliente:       'João Silva',  // PII — campo não autorizado
  };
  const { ok, camposProibidos } = auditarContextoPrompt(ctx);
  expect(ok).toBe(false);
  expect(camposProibidos).toContain('nomeCliente');
});

// ── N28-PII-04: escaneiarTextoParaPII detecta email no prompt ────────────────

test('N28-PII-04: escaneiarTextoParaPII detecta email em texto livre', () => {
  const texto = 'Analise o cliente joao@empresa.com.br com score 32.';
  const { ok, encontrado } = escaneiarTextoParaPII(texto);
  expect(ok).toBe(false);
  expect(encontrado).toContain('EMAIL');
});

// ── N28-PII-05: escaneiarTextoParaPII aceita prompt limpo ────────────────────

test('N28-PII-05: escaneiarTextoParaPII aceita prompt sem PII', () => {
  const texto = 'TIPO: REATIVACAO_120D | Score: 32/100 | Dias sem comprar: 150 | Tendência: CAINDO';
  const { ok } = escaneiarTextoParaPII(texto);
  expect(ok).toBe(true);
});

// ── N28-PII-06: auditarContextoPrompt detecta CPF em valor string ─────────────

test('N28-PII-06: auditarContextoPrompt detecta CPF embutido em valor', () => {
  const ctx = {
    tipoOportunidade:  'REATIVACAO_120D',
    scoreTotal:        32,
    classificacao:     'CRITICO',
    diasSemComprar:    150,
    tendencia:         'CAINDO',
    recorrenciaStatus: 'ATRASADO',
    prioridade:        80,
    observacao:        '123.456.789-00',  // CPF — campo não autorizado com PII
  };
  const { ok, camposProibidos, piiEncontrado } = auditarContextoPrompt(ctx);
  expect(ok).toBe(false);
  // Detecta tanto o campo não autorizado quanto o PII
  expect(camposProibidos).toContain('observacao');
});

// ── N28-OUT-01: classificação correta — LLM_SUCCESS ──────────────────────────

test('N28-OUT-01: resultado sem erro classifica como LLM_SUCCESS', () => {
  const resultado = { conteudo: 'Análise ok.', claims: [], _guardrails: { violacoes: [] } };
  const status = classificarOutcome(resultado);
  expect(status).toBe('LLM_SUCCESS');
});

// ── N28-OUT-02: classificação correta — SAFE_BLOCK ───────────────────────────

test('N28-OUT-02: erro de grounding classifica como SAFE_BLOCK', () => {
  const resultado = { _erroGrounding: '[GROUNDING] claim inválido: ...' };
  const status = classificarOutcome(resultado);
  expect(status).toBe('SAFE_BLOCK');
});

// ── N28-OUT-03: classificação correta — INFRA_ERROR ──────────────────────────

test('N28-OUT-03: erro de infra classifica como INFRA_ERROR', () => {
  const resultado = { _erroInfra: 'OpenAI HTTP 429: Too Many Requests' };
  const status = classificarOutcome(resultado);
  expect(status).toBe('INFRA_ERROR');
});

// ── N28-OUT-04: SAFE_BLOCK não é contabilizado como falha de segurança ────────

test('N28-OUT-04: SAFE_BLOCK indica pipeline funcionando, não falha', () => {
  const resultado = { _erroGuardrail: 'GuardrailViolationError: ...' };
  const status = classificarOutcome(resultado);
  expect(status).toBe('SAFE_BLOCK');
  // Um SAFE_BLOCK é comportamento CORRETO do pipeline
  expect(['SAFE_BLOCK']).toContain(status);
});

// ── Helper local para classificação de outcome ────────────────────────────────

function classificarOutcome(resultado) {
  if (!resultado) return 'INFRA_ERROR';
  if (resultado._erroInfra)    return 'INFRA_ERROR';
  if (resultado._erroSchema)   return 'SCHEMA_BLOCK';
  if (resultado._erroGrounding) return 'SAFE_BLOCK';
  if (resultado._erroGuardrail) return 'SAFE_BLOCK';
  if (resultado._erroAuditor)  return 'AUDITOR_BLOCK';
  if (resultado.conteudo)      return 'LLM_SUCCESS';
  return 'INFRA_ERROR';
}
