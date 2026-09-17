'use strict';

/**
 * SHADOW-V1-01 → SHADOW-V1-04
 * Shadow Mode — pipeline completo com MockProvider, zero side effects — N25.
 */

const { executarPipelineComercial, AI_MODE } = require('../lib/ai/servicoAgenteComercial');

const PERFIL_ATIVO = {
  clienteMr4Id:             'SIM_SHADOW_001',
  gestaoClickId:            'GC_SIM_001',
  nuncaComprou:             false,
  inativo120d:              false,
  diasSemComprar:           40,
  ultimaCompraEm:           '2026-08-08',
  primeiraCompraEm:         '2024-03-01',
  dataReferencia:           '2026-09-17',
  faturamentoTotal:         12000,
  faturamento30d:           1000,
  faturamento90d:           3500,
  faturamento180d:          8000,
  pedidosTotal:             5,
  pedidos30d:               1,
  pedidos90d:               3,
  ticketMedio:              2400,
  diasEntreComprasMedio:    40,
  diasEntreComprasMediana:  35,
};

const PERFIL_PROSPECT = {
  clienteMr4Id:    'SIM_SHADOW_PROSPECT',
  gestaoClickId:   'GC_SIM_002',
  nuncaComprou:    true,
  inativo120d:     false,
  dataReferencia:  '2026-09-17',
  pedidosTotal:    0,
  faturamentoTotal: 0,
};

// ── SHADOW-V1-01: MockProvider executa pipeline completo ─────────────────────

test('SHADOW-V1-01: pipeline completo executa sem erro com MockProvider', async () => {
  const resultado = await executarPipelineComercial(PERFIL_ATIVO, {
    incluirAnalistaOportunidade: true,
    incluirAssistenteVendedor:   true,
    incluirExplicacaoScore:      true,
  });
  expect(resultado).toBeDefined();
  expect(resultado.statusServico).toBe('SHADOW');
  expect(resultado.aiMode).toBe('SHADOW');
  expect(resultado.mockMode).toBe(true);
  expect(resultado.score).toBeDefined();
  expect(resultado.analise).toBeDefined();
  expect(resultado.auditoria.conformeGeral).toBe(true);
}, 15000);

test('SHADOW-V1-01b: pipeline funciona com PROSPECT (nunca comprou)', async () => {
  const resultado = await executarPipelineComercial(PERFIL_PROSPECT);
  expect(resultado.statusServico).toBe('SHADOW');
  expect(resultado.mockMode).toBe(true);
  expect(resultado.oportunidades.map(o => o.tipo)).toContain('PROSPECT_VINCULADO');
}, 10000);

// ── SHADOW-V1-02: resultado inválido (guardrail) → BLOCK ─────────────────────

test('SHADOW-V1-02: provider que retorna marcador proibido → GuardrailViolationError', async () => {
  const { MockProvider, criarProvider } = require('../lib/ai/provider');
  const { GuardrailViolationError } = require('../lib/ai/guardrails');
  // Injetar provider com resposta maliciosa
  process.env.NODE_ENV = 'test';
  const provider = new MockProvider({ ANALISE_CLIENTE: 'CRIAR_PEDIDO agora' });
  // Usar executarPipelineComercial não passa provider diretamente — chamar agente diretamente
  const { analisar } = require('../lib/ai/agents/analistaCliente');
  const { calcularScore } = require('../lib/scoreComercial');
  const { calcularTendencia } = require('../lib/tendenciaComercial');
  const score = calcularScore(PERFIL_ATIVO, 'ESTAVEL');
  await expect(analisar({
    perfil: PERFIL_ATIVO, score,
    tendencia: calcularTendencia(PERFIL_ATIVO),
    recorrencia: { status: 'DENTRO_DO_PADRAO' },
    oportunidades: [],
    provider,
  })).rejects.toThrow(GuardrailViolationError);
});

// ── SHADOW-V1-03: resultado válido → PASS ────────────────────────────────────

test('SHADOW-V1-03: pipeline com dados válidos → auditoria conforme', async () => {
  const resultado = await executarPipelineComercial(PERFIL_ATIVO);
  expect(resultado.auditoria.conformeGeral).toBe(true);
  expect(resultado.auditoria.totalComViolacao).toBe(0);
}, 10000);

// ── SHADOW-V1-04: zero side effects ──────────────────────────────────────────

test('SHADOW-V1-04: resultado em shadow mode tem sideEffects=[]', async () => {
  const resultado = await executarPipelineComercial(PERFIL_ATIVO);
  expect(resultado.sideEffects).toEqual([]);
  expect(resultado.statusServico).toBe('SHADOW');
  // AI_MODE exportado da constante
  expect(AI_MODE).toBe('SHADOW');
}, 10000);
