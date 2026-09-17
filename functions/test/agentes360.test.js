'use strict';

/**
 * AGENT360-01 → AGENT360-20
 * Testa: MockProvider (N9), Agentes (N8), Validator de Output (N11).
 *
 * Invariantes:
 *   - MockProvider: retorna mock:true, sem chamadas externas
 *   - Agentes: output sempre passa pelos guardrails
 *   - Agentes: mockMode=true sinalizando que está em modo simulado
 *   - AuditorIA: detecta violações e sinaliza conformidade
 *   - ValidatorSchema: valida estrutura do output
 *   - Providers reais rejeitados (tipo != 'mock' lança erro)
 */

const { MockProvider, criarProvider } = require('../lib/ai/provider');
const { analisar }     = require('../lib/ai/agents/analistaCliente');
const { explicarScore } = require('../lib/ai/agents/explicadorComercial');
const { auditarOutputs } = require('../lib/ai/agents/auditorIA');
const { validarSchema, SchemaValidationError } = require('../lib/ai/validatorOutput');
const { GuardrailViolationError } = require('../lib/ai/guardrails');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkProvider() {
  return new MockProvider();
}

function mkPerfil() {
  return {
    clienteMr4Id:   'cli_001',
    diasSemComprar: 20,
    nuncaComprou:   false,
    inativo120d:    false,
  };
}

function mkScore() {
  return {
    scoreTotal:   72,
    classificacao: 'BOM',
    componentes:  {
      recencia:    { pontuacao: 75, peso: 25, faixa: 'bom' },
      frequencia:  { pontuacao: 60, peso: 20, faixa: 'MEDIA' },
      faturamento: { pontuacao: 70, peso: 25, faixa: 'MEDIO' },
      tendencia:   { pontuacao: 75, peso: 15, tendencia: 'ESTAVEL' },
      diversidade: { pontuacao: 50, peso: 10, faixa: 'MEDIA' },
      engajamento: { pontuacao: 50, peso: 5,  faixa: 'MODERADO' },
    },
    statusConfig:   'PROVISIONAL',
    versaoMotor:    'score-v1',
    versaoConfig:   'score-v1-provisional',
  };
}

function mkTendencia() {
  return { tendencia: 'ESTAVEL', metodo: 'JANELA_30D_VS_30D_ANTERIOR' };
}

function mkRecorrencia() {
  return { status: 'DENTRO_DO_PADRAO' };
}

// ── MockProvider ──────────────────────────────────────────────────────────────

describe('MockProvider (N9)', () => {
  test('AGENT360-01: complete() retorna mock:true e texto não-vazio', async () => {
    const p = mkProvider();
    const r = await p.complete('prompt qualquer', { chave: 'ANALISE_CLIENTE' });
    expect(r.mock).toBe(true);
    expect(r.texto).toBeTruthy();
    expect(typeof r.latenciaMs).toBe('number');
  });

  test('AGENT360-02: chave DEFAULT quando chave não existe', async () => {
    const p = mkProvider();
    const r = await p.complete('x', { chave: 'CHAVE_INEXISTENTE' });
    expect(r.texto).toContain('MOCK');
  });

  test('AGENT360-03: getChamadas() registra auditoria de chamadas', async () => {
    const p = mkProvider();
    await p.complete('prompt 1', {});
    await p.complete('prompt 2', {});
    expect(p.getChamadas()).toHaveLength(2);
  });

  test('AGENT360-04: resetar() limpa histórico de chamadas', async () => {
    const p = mkProvider();
    await p.complete('x', {});
    p.resetar();
    expect(p.getChamadas()).toHaveLength(0);
  });

  test('AGENT360-05: prompt vazio → erro', async () => {
    const p = mkProvider();
    await expect(p.complete('   ', {})).rejects.toThrow('prompt inválido');
  });

  test('AGENT360-06: criarProvider("mock") → MockProvider', () => {
    const p = criarProvider('mock');
    expect(p).toBeInstanceOf(MockProvider);
  });

  test('AGENT360-07: criarProvider("openai") → erro (não suportado)', () => {
    expect(() => criarProvider('openai')).toThrow('não suportado');
  });

  test('AGENT360-08: MockProvider personalizado aceita respostas injetadas', async () => {
    const p = criarProvider('mock', { respostas: { 'MINHA_CHAVE': 'resposta personalizada' } });
    const r = await p.complete('x', { chave: 'MINHA_CHAVE' });
    expect(r.texto).toBe('resposta personalizada');
  });
});

// ── analistaCliente ───────────────────────────────────────────────────────────

describe('analistaCliente (N8)', () => {
  test('AGENT360-09: analisar() retorna output válido com _guardrails', async () => {
    const result = await analisar({
      perfil:        mkPerfil(),
      score:         mkScore(),
      tendencia:     mkTendencia(),
      recorrencia:   mkRecorrencia(),
      oportunidades: [],
      provider:      mkProvider(),
    });
    expect(result.tipo).toBe('ANALISE');
    expect(result._guardrails).toBeDefined();
    expect(result._guardrails.violacoes).toHaveLength(0);
    expect(result._meta.mockMode).toBe(true);
  });

  test('AGENT360-10: analisar() sem provider → erro imediato', async () => {
    await expect(analisar({ perfil: mkPerfil(), score: mkScore(), provider: null }))
      .rejects.toThrow('provider ausente');
  });

  test('AGENT360-11: analisar() sem perfil → erro imediato', async () => {
    await expect(analisar({ perfil: null, score: mkScore(), provider: mkProvider() }))
      .rejects.toThrow('perfil ausente');
  });

  test('AGENT360-12: analisar() com oportunidades passa a lista no contexto', async () => {
    const oport = { tipo: 'REATIVACAO_120D', prioridade: 70 };
    const result = await analisar({
      perfil:        mkPerfil(),
      score:         mkScore(),
      tendencia:     mkTendencia(),
      recorrencia:   mkRecorrencia(),
      oportunidades: [oport],
      provider:      mkProvider(),
    });
    expect(result.tipo).toBe('ANALISE');
  });
});

// ── explicadorComercial ───────────────────────────────────────────────────────

describe('explicadorComercial (N8)', () => {
  test('AGENT360-13: explicarScore() retorna output EXPLICACAO válido', async () => {
    const result = await explicarScore({ score: mkScore(), provider: mkProvider() });
    expect(result.tipo).toBe('EXPLICACAO');
    expect(result._meta.mockMode).toBe(true);
  });

  test('AGENT360-14: explicarScore() sem score → erro', async () => {
    await expect(explicarScore({ score: null, provider: mkProvider() }))
      .rejects.toThrow('score ausente');
  });
});

// ── auditorIA ─────────────────────────────────────────────────────────────────

describe('auditorIA (N8)', () => {
  test('AGENT360-15: auditarOutputs() de outputs válidos → conformeGeral=true', async () => {
    const out1 = await analisar({ perfil: mkPerfil(), score: mkScore(), tendencia: mkTendencia(), recorrencia: mkRecorrencia(), oportunidades: [], provider: mkProvider() });
    const out2 = await explicarScore({ score: mkScore(), provider: mkProvider() });
    const relatorio = auditarOutputs([out1, out2]);
    expect(relatorio.conformeGeral).toBe(true);
    expect(relatorio.totalOutputs).toBe(2);
    expect(relatorio.totalConformes).toBe(2);
    expect(relatorio.totalEmMock).toBe(2);
  });

  test('AGENT360-16: auditarOutputs([]) → totalOutputs=0, conformeGeral=true', () => {
    const relatorio = auditarOutputs([]);
    expect(relatorio.totalOutputs).toBe(0);
    expect(relatorio.conformeGeral).toBe(true);
  });

  test('AGENT360-17: auditarOutputs(não-array) → erro', () => {
    expect(() => auditarOutputs(null)).toThrow('deve ser array');
  });
});

// ── validatorOutput (N11) ─────────────────────────────────────────────────────

describe('validatorOutput (N11)', () => {
  test('AGENT360-18: validarSchema() aceita output válido de agente', async () => {
    const out = await analisar({ perfil: mkPerfil(), score: mkScore(), tendencia: mkTendencia(), recorrencia: mkRecorrencia(), oportunidades: [], provider: mkProvider() });
    const resultado = validarSchema(out);
    expect(resultado._schemaValidation).toBeDefined();
    expect(resultado._schemaValidation.tipoSchema).toBe('ANALISE');
  });

  test('AGENT360-19: validarSchema() com campo obrigatório ausente → SchemaValidationError', () => {
    const outputIncompleto = { tipo: 'ANALISE', conteudo: 'x', versaoGuardrails: 'v1' }; // sem auditoria, _guardrails
    expect(() => validarSchema(outputIncompleto)).toThrow(SchemaValidationError);
  });

  test('AGENT360-20: validarSchema() com tipo desconhecido → erro', () => {
    expect(() => validarSchema({ tipo: 'TIPO_DESCONHECIDO' })).toThrow(SchemaValidationError);
  });
});
