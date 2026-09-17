'use strict';

/**
 * AI-V1-01 → AI-V1-05
 * Invariantes estruturais dos 5 agentes — N25.
 */

const { analisar }            = require('../lib/ai/agents/analistaCliente');
const { analisarOportunidade }= require('../lib/ai/agents/analistaOportunidade');
const { orientarVendedor }    = require('../lib/ai/agents/assistenteVendedor');
const { auditarOutputs }      = require('../lib/ai/agents/auditorIA');
const { explicarScore }       = require('../lib/ai/agents/explicadorComercial');
const { MockProvider }        = require('../lib/ai/provider');
const { calcularScore }       = require('../lib/scoreComercial');
const { calcularTendencia }   = require('../lib/tendenciaComercial');

function mkProvider() { return new MockProvider(); }

function mkPerfil() {
  return {
    clienteMr4Id:   'SIM_AIV1',
    nuncaComprou:   false,
    inativo120d:    false,
    diasSemComprar: 45,
    pedidosTotal:   3,
    faturamentoTotal: 4500,
  };
}

function mkScore(perfil) {
  return calcularScore(perfil, 'ESTAVEL');
}

function mkTendencia(perfil) {
  return calcularTendencia(perfil);
}

function mkOportunidade() {
  return { tipo: 'JANELA_DE_RECOMPRA', prioridade: 65 };
}

// ── AI-V1-01: todos os 5 agentes existem e exportam corretamente ──────────────

test('AI-V1-01: todos os 5 agentes exportam suas funções principais', () => {
  expect(typeof analisar).toBe('function');
  expect(typeof analisarOportunidade).toBe('function');
  expect(typeof orientarVendedor).toBe('function');
  expect(typeof auditarOutputs).toBe('function');
  expect(typeof explicarScore).toBe('function');
});

// ── AI-V1-02: nenhum agente altera o score ────────────────────────────────────

test('AI-V1-02: analistaCliente não altera score', async () => {
  const perfil = mkPerfil();
  const score  = mkScore(perfil);
  const total  = score.scoreTotal;
  await analisar({
    perfil, score, tendencia: mkTendencia(perfil),
    recorrencia: { status: 'DENTRO_DO_PADRAO' }, oportunidades: [], provider: mkProvider(),
  });
  expect(score.scoreTotal).toBe(total);
});

test('AI-V1-02b: analistaOportunidade não altera score', async () => {
  const perfil = mkPerfil();
  const score  = mkScore(perfil);
  const total  = score.scoreTotal;
  await analisarOportunidade({
    oportunidade: mkOportunidade(), perfil, score,
    tendencia: mkTendencia(perfil), recorrencia: { status: 'DENTRO_DO_PADRAO' },
    provider: mkProvider(),
  });
  expect(score.scoreTotal).toBe(total);
});

// ── AI-V1-03: nenhum agente altera prioridade ─────────────────────────────────

test('AI-V1-03: assistenteVendedor não altera prioridade da oportunidade', async () => {
  const perfil = mkPerfil();
  const oport  = mkOportunidade();
  const prioOriginal = oport.prioridade;
  await orientarVendedor({
    oportunidade: oport, perfil, score: mkScore(perfil),
    tendencia: mkTendencia(perfil), provider: mkProvider(),
  });
  expect(oport.prioridade).toBe(prioOriginal);
  expect(oport.tipo).toBe('JANELA_DE_RECOMPRA');
});

// ── AI-V1-04: nenhum agente cria oportunidade ────────────────────────────────

test('AI-V1-04: nenhum agente adiciona oportunidades ao array de entrada', async () => {
  const perfil = mkPerfil();
  const oports = [mkOportunidade()];
  const len    = oports.length;
  await analisar({
    perfil, score: mkScore(perfil), tendencia: mkTendencia(perfil),
    recorrencia: { status: 'DENTRO_DO_PADRAO' }, oportunidades: oports, provider: mkProvider(),
  });
  expect(oports).toHaveLength(len);
});

// ── AI-V1-05: GroundingFacts minimiza dados ───────────────────────────────────

test('AI-V1-05: buildGroundingFacts não inclui campos sensíveis desnecessários', () => {
  const { buildGroundingFacts } = require('../lib/ai/groundingOutput');
  const facts = buildGroundingFacts(mkPerfil(), mkScore(mkPerfil()), mkTendencia(mkPerfil()));
  // Não deve incluir nome, telefone, email, CPF, endereço
  expect(facts).not.toHaveProperty('nome');
  expect(facts).not.toHaveProperty('telefone');
  expect(facts).not.toHaveProperty('email');
  expect(facts).not.toHaveProperty('cpf');
  expect(facts).not.toHaveProperty('endereco');
  // Deve incluir campos comerciais essenciais
  expect(facts).toHaveProperty('scoreTotal');
  expect(facts).toHaveProperty('diasSemComprar');
  expect(facts).toHaveProperty('pedidosTotal');
});
