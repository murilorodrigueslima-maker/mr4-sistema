'use strict';

/**
 * sensibilidade360.test.js — N22: Testes analíticos de sensibilidade de score
 *
 * Prova que o helper calcScoreCenario produz escala 0-100 (não 0-1 como N21).
 * NÃO altera engines. NÃO usa dados reais. NÃO conecta GC/Firestore.
 */

const {
  calcularRecencia,
  calcularFrequencia,
  calcularFaturamento,
  calcularTendenciaPontuacao,
  calcularDiversidade,
  calcularEngajamento,
} = require('../lib/scoreComercial');

// ── Helper corrigido (N22) ─────────────────────────────────────────────────────
// BUG N21: usava pesos=[0.25,...] array com / 100 → resultado 0-1
// FIX N22: pesos={recencia:25,...} objeto, soma=100, sem / 100 extra
function calcScoreCenarioN22(perfil, tendencia, pesos) {
  if (perfil.nuncaComprou) return 0;
  const recP  = calcularRecencia(perfil).pontuacao;
  const freqP = calcularFrequencia(perfil).pontuacao;
  const fatP  = calcularFaturamento(perfil).pontuacao;
  const tendP = calcularTendenciaPontuacao(tendencia).pontuacao;
  const divP  = calcularDiversidade(perfil).pontuacao;
  const engP  = calcularEngajamento(perfil).pontuacao;
  // componentes: 0-100 | pesos: soma=100
  // resultado = (sum * pesos) / 100 ∈ [0,100]
  return Math.max(0, Math.min(100, Math.round(
    (recP  * pesos.recencia    +
     freqP * pesos.frequencia  +
     fatP  * pesos.faturamento +
     tendP * pesos.tendencia   +
     divP  * pesos.diversidade +
     engP  * pesos.engajamento) / 100
  )));
}

// ── Helper BUGADO (N21) ────────────────────────────────────────────────────────
// Reproduz o bug para provar que N22 o corrigiu.
function calcScoreCenarioN21_bugado(pesos_array, perfil, tend) {
  if (perfil.nuncaComprou) return 0;
  const recC  = perfil.diasSemComprar <= 30 ? 100 : perfil.diasSemComprar <= 60 ? 80 : 60;
  const freqC = Math.min(100, perfil.pedidosTotal > 0 ? Math.round(perfil.pedidosTotal / Math.max(1, perfil.diasEntreComprasMedio || 30) * 100) : 0);
  const fatC  = Math.min(100, Math.round(((perfil.faturamentoTotal || 0) / 10000) * 100));
  const fat90C = Math.min(100, Math.round(((perfil.faturamento90d || 0) / 3000) * 100));
  const tendC = { CRESCENDO: 100, ESTAVEL: 70, CAINDO: 30, SEM_BASE: 50, NUNCA_COMPROU: 0 }[tend] ?? 50;
  const divC  = Math.min(100, ((perfil.categoriasMaisCompradas || []).length / 10) * 100);
  return Math.max(0, Math.min(100,
    Math.round(
      recC  * pesos_array[0] + freqC  * pesos_array[1] + fatC  * pesos_array[2] +
      tendC * pesos_array[3] + divC   * pesos_array[4] + fat90C * pesos_array[5]
    ) / 100  // ← BUG: divide por 100 quando pesos já são frações → resultado 0-1
  ));
}

// ── Perfis de referência ───────────────────────────────────────────────────────

const perfilAtivo = {
  clienteMr4Id: 'SENS_ATIVO',
  gestaoClickId: '999001',
  nuncaComprou: false,
  inativo120d: false,
  diasSemComprar: 20,
  pedidos30d: 3, pedidos60d: 5, pedidos90d: 6, pedidos180d: 9,
  faturamento30d: 1200, faturamento60d: 2000, faturamento90d: 2400, faturamento180d: 4000,
  faturamentoTotal: 8000,
  faturamento90d: 2400,
  pedidosTotal: 15,
  categoriasMaisCompradas: [{ categoria: 'A' }, { categoria: 'B' }],
  quantidadeProdutosDistintos: 8,
  diasEntreComprasMedio: 22,
  diasEntreComprasMediana: 20,
  ticketMedioTotal: 533,
  ultimaCompraEm: '2026-08-28',
};

const perfilInativo = {
  clienteMr4Id: 'SENS_INATIVO',
  gestaoClickId: '999002',
  nuncaComprou: false,
  inativo120d: true,
  diasSemComprar: 200,
  pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 1,
  faturamento30d: 0, faturamento60d: 0, faturamento90d: 0, faturamento180d: 500,
  faturamentoTotal: 3000,
  faturamento90d: 0,
  pedidosTotal: 4,
  categoriasMaisCompradas: [{ categoria: 'A' }],
  quantidadeProdutosDistintos: 2,
  diasEntreComprasMedio: 60,
  diasEntreComprasMediana: 55,
  ticketMedioTotal: 750,
  ultimaCompraEm: '2026-03-01',
};

const perfilNuncaComprou = {
  clienteMr4Id: 'SENS_NUNCA',
  gestaoClickId: '999003',
  nuncaComprou: true,
  inativo120d: false,
  diasSemComprar: null,
  pedidos30d: 0, pedidos60d: 0, pedidos90d: 0, pedidos180d: 0,
  faturamento30d: 0, faturamento60d: 0, faturamento90d: 0, faturamento180d: 0,
  faturamentoTotal: 0,
  pedidosTotal: 0,
  categoriasMaisCompradas: [],
  quantidadeProdutosDistintos: 0,
  diasEntreComprasMedio: null,
  diasEntreComprasMediana: null,
  ticketMedioTotal: null,
  ultimaCompraEm: null,
};

const PESOS_ATUAL = { recencia: 25, frequencia: 20, faturamento: 25, tendencia: 15, diversidade: 10, engajamento: 5 };
const PESOS_S1    = { recencia: 35, frequencia: 30, faturamento: 15, tendencia: 10, diversidade: 7, engajamento: 3 };
const PESOS_S2    = { recencia: 15, frequencia: 15, faturamento: 40, tendencia: 15, diversidade: 10, engajamento: 5 };
const PESOS_S3    = { recencia: 20, frequencia: 20, faturamento: 20, tendencia: 20, diversidade: 10, engajamento: 10 };
const PESOS_S4    = { recencia: 27, frequencia: 22, faturamento: 27, tendencia: 16, diversidade: 8, engajamento: 0 };

// ── Testes ─────────────────────────────────────────────────────────────────────

describe('Sensibilidade de Score — N22 (SENS-01..06)', () => {

  test('SENS-01: score analítico deve permanecer na escala 0-100 (cliente ativo)', () => {
    const score = calcScoreCenarioN22(perfilAtivo, 'CRESCENDO', PESOS_ATUAL);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(score)).toBe(true);
  });

  test('SENS-02: cenário com score ~70 NÃO pode aparecer como 0.70 (bug N21 provado)', () => {
    const scoreCorreto = calcScoreCenarioN22(perfilAtivo, 'CRESCENDO', PESOS_ATUAL);
    const scoreBugado  = calcScoreCenarioN21_bugado([0.25, 0.20, 0.25, 0.15, 0.10, 0.05], perfilAtivo, 'CRESCENDO');

    // Correto: inteiro >= 1 (escala 0-100)
    expect(scoreCorreto).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(scoreCorreto)).toBe(true);

    // Bugado: decimal < 1 (escala 0-1) — prova o bug N21
    expect(scoreBugado).toBeLessThan(1);
    expect(scoreBugado).toBeGreaterThan(0);

    // O ponto é a diferença de escala — os métodos têm lógica de componentes diferente
    // mas ambos calculam o mesmo cliente. O correto devolve 0-100, o bugado 0-1.
    expect(scoreCorreto).toBeGreaterThan(scoreBugado); // 100-scale > 1-scale sempre
  });

  test('SENS-03: nuncaComprou → score = 0 em todos os cenários', () => {
    for (const pesos of [PESOS_ATUAL, PESOS_S1, PESOS_S2, PESOS_S3, PESOS_S4]) {
      expect(calcScoreCenarioN22(perfilNuncaComprou, 'NUNCA_COMPROU', pesos)).toBe(0);
    }
  });

  test('SENS-04: pesos somam 100 (cada cenário)', () => {
    for (const [nome, pesos] of [
      ['S0', PESOS_ATUAL], ['S1', PESOS_S1], ['S2', PESOS_S2],
      ['S3', PESOS_S3], ['S4', PESOS_S4],
    ]) {
      const soma = Object.values(pesos).reduce((a, b) => a + b, 0);
      expect(soma).toBe(100);
    }
  });

  test('SENS-05: S2 (peso faturamento alto) > S1 (peso recência alto) para cliente com fat alto mas inativo', () => {
    const scoreS1 = calcScoreCenarioN22(perfilInativo, 'CAINDO', PESOS_S1);
    const scoreS2 = calcScoreCenarioN22(perfilInativo, 'CAINDO', PESOS_S2);
    // Inativo: recência=0, faturamento moderado → S2 deve valorizar mais
    expect(scoreS2).toBeGreaterThanOrEqual(scoreS1);
  });

  test('SENS-06: S4 (sem engajamento=0) resultado válido — não perde escala', () => {
    const score = calcScoreCenarioN22(perfilAtivo, 'CRESCENDO', PESOS_S4);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(score)).toBe(true);
    // S4 pesos somam 100 (engajamento=0, redistribuído)
    const somaS4 = Object.values(PESOS_S4).reduce((a, b) => a + b, 0);
    expect(somaS4).toBe(100);
  });

});
