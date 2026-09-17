#!/usr/bin/env node
'use strict';

/**
 * Simulação do Agente Comercial IA — N13.
 * 10 cenários sintéticos e anônimos.
 *
 * DRY-RUN / OFFLINE / FIXTURES apenas:
 *   - Zero escrita em Firestore
 *   - Zero chamadas a LLM real
 *   - Zero chamadas ao GestãoClick
 *   - Usa MockProvider exclusivamente
 *
 * Uso:
 *   node scripts/simular-agente-comercial.js
 */

const { calcularScore }           = require('../functions/lib/scoreComercial');
const { calcularTendencia }       = require('../functions/lib/tendenciaComercial');
const { calcularRecorrencia }     = require('../functions/lib/recorrencia');
const { gerarOportunidades }      = require('../functions/lib/oportunidades');
const { priorizarOportunidades }  = require('../functions/lib/priorizadorOportunidades');
const { analisar }                = require('../functions/lib/ai/agents/analistaCliente');
const { criarProvider }           = require('../functions/lib/ai/provider');
const { criarTrace }              = require('../functions/lib/ai/trace');
const { auditarOutputs }          = require('../functions/lib/ai/agents/auditorIA');

// ── Fixtures de perfis sintéticos ────────────────────────────────────────────

const DATA_REF = '2026-09-16';

const PERFIS_FIXTURE = [
  // 1. Cliente ativo excelente
  { clienteMr4Id: 'SIM_001', gestaoClickId: 'gc_sim_001', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 8, ultimaCompraEm: '2026-09-08', faturamentoTotal: 22000, faturamento90d: 7000,
    faturamento30d: 2500, faturamento60d: 4800, faturamento180d: 14000,
    pedidosTotal: 35, pedidos90d: 8, pedidos30d: 3, pedidos60d: 6, pedidos180d: 18,
    diasEntreComprasMedio: 12, diasEntreComprasMediana: 10,
    quantidadeProdutosDistintos: 15, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 12000 }, { categoria: 'OLEO', faturamento: 6000 }, { categoria: 'FREIO', faturamento: 4000 }] },

  // 2. Cliente que nunca comprou
  { clienteMr4Id: 'SIM_002', gestaoClickId: 'gc_sim_002', nuncaComprou: true, inativo120d: false,
    diasSemComprar: null, ultimaCompraEm: null, faturamentoTotal: 0, faturamento90d: 0,
    faturamento30d: 0, faturamento60d: 0, faturamento180d: 0,
    pedidosTotal: 0, pedidos90d: 0, pedidos30d: 0, pedidos60d: 0, pedidos180d: 0,
    diasEntreComprasMedio: null, diasEntreComprasMediana: null,
    quantidadeProdutosDistintos: 0, dataReferencia: DATA_REF, categoriasMaisCompradas: [] },

  // 3. Cliente inativo (180 dias sem comprar)
  { clienteMr4Id: 'SIM_003', gestaoClickId: 'gc_sim_003', nuncaComprou: false, inativo120d: true,
    diasSemComprar: 180, ultimaCompraEm: '2026-03-20', faturamentoTotal: 15000, faturamento90d: 0,
    faturamento30d: 0, faturamento60d: 0, faturamento180d: 2000,
    pedidosTotal: 18, pedidos90d: 0, pedidos30d: 0, pedidos60d: 0, pedidos180d: 2,
    diasEntreComprasMedio: 35, diasEntreComprasMediana: 30,
    quantidadeProdutosDistintos: 8, dataReferencia: DATA_REF, categoriasMaisCompradas: [] },

  // 4. Cliente em queda de compras
  { clienteMr4Id: 'SIM_004', gestaoClickId: 'gc_sim_004', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 30, ultimaCompraEm: '2026-08-17', faturamentoTotal: 8000, faturamento90d: 1200,
    faturamento30d: 200, faturamento60d: 700, faturamento180d: 4000,
    pedidosTotal: 12, pedidos90d: 2, pedidos30d: 1, pedidos60d: 2, pedidos180d: 6,
    diasEntreComprasMedio: 28, diasEntreComprasMediana: 25,
    quantidadeProdutosDistintos: 6, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'OLEO', faturamento: 5000 }, { categoria: 'FILTRO', faturamento: 3000 }] },

  // 5. Cliente na janela de recompra (próximo do padrão)
  { clienteMr4Id: 'SIM_005', gestaoClickId: 'gc_sim_005', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 24, ultimaCompraEm: '2026-08-23', faturamentoTotal: 12000, faturamento90d: 4000,
    faturamento30d: 1500, faturamento60d: 2800, faturamento180d: 7000,
    pedidosTotal: 20, pedidos90d: 5, pedidos30d: 2, pedidos60d: 4, pedidos180d: 10,
    diasEntreComprasMedio: 25, diasEntreComprasMediana: 22,
    quantidadeProdutosDistintos: 9, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 7000 }, { categoria: 'FREIO', faturamento: 5000 }] },

  // 6. Cliente com apenas 1 categoria (cross-sell)
  { clienteMr4Id: 'SIM_006', gestaoClickId: 'gc_sim_006', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 15, ultimaCompraEm: '2026-09-01', faturamentoTotal: 6000, faturamento90d: 2000,
    faturamento30d: 800, faturamento60d: 1500, faturamento180d: 3500,
    pedidosTotal: 10, pedidos90d: 3, pedidos30d: 1, pedidos60d: 2, pedidos180d: 6,
    diasEntreComprasMedio: 40, diasEntreComprasMediana: 35,
    quantidadeProdutosDistintos: 3, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 6000 }] },

  // 7. Cliente crescendo (tendência CRESCENDO)
  { clienteMr4Id: 'SIM_007', gestaoClickId: 'gc_sim_007', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 5, ultimaCompraEm: '2026-09-11', faturamentoTotal: 18000, faturamento90d: 9000,
    faturamento30d: 4500, faturamento60d: 6000, faturamento180d: 12000,
    pedidosTotal: 28, pedidos90d: 10, pedidos30d: 5, pedidos60d: 7, pedidos180d: 15,
    diasEntreComprasMedio: 10, diasEntreComprasMediana: 9,
    quantidadeProdutosDistintos: 12, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 9000 }, { categoria: 'OLEO', faturamento: 5000 }, { categoria: 'FILTRO', faturamento: 4000 }] },

  // 8. Cliente com 1 compra apenas (SEM_BASE para recorrência)
  { clienteMr4Id: 'SIM_008', gestaoClickId: 'gc_sim_008', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 45, ultimaCompraEm: '2026-08-02', faturamentoTotal: 800, faturamento90d: 800,
    faturamento30d: 0, faturamento60d: 800, faturamento180d: 800,
    pedidosTotal: 1, pedidos90d: 1, pedidos30d: 0, pedidos60d: 1, pedidos180d: 1,
    diasEntreComprasMedio: null, diasEntreComprasMediana: null,
    quantidadeProdutosDistintos: 2, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'OLEO', faturamento: 800 }] },

  // 9. Cliente muito inativo (> 365 dias — penalidade no priorizador)
  { clienteMr4Id: 'SIM_009', gestaoClickId: 'gc_sim_009', nuncaComprou: false, inativo120d: true,
    diasSemComprar: 400, ultimaCompraEm: '2025-08-12', faturamentoTotal: 35000, faturamento90d: 0,
    faturamento30d: 0, faturamento60d: 0, faturamento180d: 0,
    pedidosTotal: 42, pedidos90d: 0, pedidos30d: 0, pedidos60d: 0, pedidos180d: 0,
    diasEntreComprasMedio: 30, diasEntreComprasMediana: 28,
    quantidadeProdutosDistintos: 20, dataReferencia: DATA_REF, categoriasMaisCompradas: [] },

  // 10. Cliente ativo sem padrão definido (baixa frequência mas compra)
  { clienteMr4Id: 'SIM_010', gestaoClickId: 'gc_sim_010', nuncaComprou: false, inativo120d: false,
    diasSemComprar: 80, ultimaCompraEm: '2026-06-27', faturamentoTotal: 5000, faturamento90d: 2000,
    faturamento30d: 0, faturamento60d: 0, faturamento180d: 3500,
    pedidosTotal: 5, pedidos90d: 1, pedidos30d: 0, pedidos60d: 0, pedidos180d: 3,
    diasEntreComprasMedio: 60, diasEntreComprasMediana: 58,
    quantidadeProdutosDistintos: 4, dataReferencia: DATA_REF,
    categoriasMaisCompradas: [{ categoria: 'PNEU', faturamento: 3000 }, { categoria: 'FREIO', faturamento: 2000 }] },
];

// ── Pipeline de simulação ─────────────────────────────────────────────────────

async function simularCliente(perfil, provider) {
  const trace   = criarTrace(`sim_${perfil.clienteMr4Id}`);
  const outputs = [];

  // 1. Score
  const { encerrar: encScore } = trace.iniciarSpan('calcularScore');
  const score = calcularScore(perfil, 'SEM_BASE');  // tendência será sobrescrita abaixo
  encScore({ scoreTotal: score.scoreTotal });

  // 2. Tendência
  const { encerrar: encTend } = trace.iniciarSpan('calcularTendencia');
  const tendencia = calcularTendencia(perfil);
  encScore({ tendencia: tendencia.tendencia });
  encTend({ tendencia: tendencia.tendencia });

  // 3. Score com tendência real
  const { encerrar: encScore2 } = trace.iniciarSpan('calcularScoreComTendencia');
  const scoreComTend = calcularScore(perfil, tendencia.tendencia);
  encScore2({ scoreTotal: scoreComTend.scoreTotal });

  // 4. Recorrência
  const { encerrar: encRecorr } = trace.iniciarSpan('calcularRecorrencia');
  const recorrencia = calcularRecorrencia(perfil);
  encRecorr({ status: recorrencia.status });

  // 5. Oportunidades
  const { encerrar: encOport } = trace.iniciarSpan('gerarOportunidades');
  const oportunidades = gerarOportunidades(perfil, scoreComTend, tendencia, recorrencia, DATA_REF);
  encOport({ count: oportunidades.length });

  // 6. Priorizador
  const { encerrar: encPrio } = trace.iniciarSpan('priorizarOportunidades');
  const oportunidadesRanqueadas = priorizarOportunidades(oportunidades, perfil, scoreComTend);
  encPrio({ count: oportunidadesRanqueadas.length });

  // 7. Agente IA
  const { encerrar: encAgente } = trace.iniciarSpan('analistaCliente');
  const analise = await analisar({
    perfil,
    score:         scoreComTend,
    tendencia,
    recorrencia,
    oportunidades: oportunidadesRanqueadas,
    provider,
  });
  outputs.push(analise);
  encAgente({ tipo: analise.tipo, mockMode: analise._meta?.mockMode });

  // 8. Auditoria
  const relatorio = auditarOutputs(outputs);

  trace.finalizar({ scoreTotal: scoreComTend.scoreTotal, oportunidades: oportunidades.length, conforme: relatorio.conformeGeral });

  return {
    clienteMr4Id:    perfil.clienteMr4Id,
    scoreTotal:      scoreComTend.scoreTotal,
    classificacao:   scoreComTend.classificacao,
    tendencia:       tendencia.tendencia,
    recorrencia:     recorrencia.status,
    oportunidades:   oportunidades.map(o => o.tipo),
    analise:         analise.conteudo,
    mockMode:        analise._meta?.mockMode,
    conforme:        relatorio.conformeGeral,
    trace:           trace.serializar(),
  };
}

async function main() {
  console.log('\n=== SIMULAÇÃO AGENTE COMERCIAL IA — DRY-RUN / OFFLINE ===');
  console.log(`Data de referência: ${DATA_REF}`);
  console.log(`Total de cenários: ${PERFIS_FIXTURE.length}\n`);

  const provider = criarProvider('mock');
  const resultados = [];

  for (const perfil of PERFIS_FIXTURE) {
    const resultado = await simularCliente(perfil, provider);
    resultados.push(resultado);

    console.log(`── ${resultado.clienteMr4Id} ──────────────────────────────`);
    console.log(`   Score: ${resultado.scoreTotal}/100 (${resultado.classificacao})`);
    console.log(`   Tendência: ${resultado.tendencia} | Recorrência: ${resultado.recorrencia}`);
    console.log(`   Oportunidades: ${resultado.oportunidades.join(', ') || '(nenhuma)'}`);
    console.log(`   Mock: ${resultado.mockMode} | Conforme: ${resultado.conforme}`);
    console.log(`   Análise: ${resultado.analise.slice(0, 80)}...`);
    console.log();
  }

  const totalConformes = resultados.filter(r => r.conforme).length;
  const totalMock      = resultados.filter(r => r.mockMode).length;

  console.log('=== SUMÁRIO ==========================================');
  console.log(`Total simulados: ${resultados.length}`);
  console.log(`Conformes:       ${totalConformes}/${resultados.length}`);
  console.log(`Mock mode:       ${totalMock}/${resultados.length}`);
  console.log(`Zero escrita:    ✓ (DRY-RUN)`);
  console.log(`Zero LLM real:   ✓ (MockProvider)`);
  console.log('=====================================================\n');

  if (totalConformes < resultados.length) {
    process.exit(1);  // sinaliza falha para CI
  }
}

main().catch(err => {
  console.error('[ERRO FATAL]', err.message);
  process.exit(1);
});
