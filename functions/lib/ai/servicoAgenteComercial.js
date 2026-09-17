'use strict';

/**
 * Serviço Interno do Agente Comercial IA — N17.
 *
 * Camada de orquestração que coordena o pipeline completo:
 *   Perfil360 → Score → Tendência → Recorrência → Oportunidades → Priorizador
 *   → Agentes IA → Guardrails → Auditoria → Trace
 *
 * É a única interface pública do Agente Comercial para consumidores externos.
 * Esconde a complexidade interna e garante que todos os guardrails são aplicados.
 *
 * MODO ATUAL: OFFLINE/DRY-RUN/MOCK apenas.
 * Provider: MockProvider (sem LLM real, sem API key, sem custo).
 * Sem persistência: o chamador decide se/onde armazenar os resultados.
 */

const { calcularScore }           = require('../scoreComercial');
const { calcularTendencia }       = require('../tendenciaComercial');
const { calcularRecorrencia }     = require('../recorrencia');
const { gerarOportunidades }      = require('../oportunidades');
const { priorizarOportunidades }  = require('../priorizadorOportunidades');
const { analisar }                = require('./agents/analistaCliente');
const { explicarScore }           = require('./agents/explicadorComercial');
const { auditarOutputs }          = require('./agents/auditorIA');
const { criarProvider }           = require('./provider');
const { criarTrace }              = require('./trace');
const { validarSchema }           = require('./validatorOutput');

const VERSAO_SERVICO = 'servico-v1';

/**
 * Executa o pipeline completo do Agente Comercial para um cliente.
 *
 * @param {Object} perfil          — Perfil360 completo
 * @param {Object} [opcoes]        — { dataReferencia, tipoProvider, incluirExplicacaoScore }
 * @returns {Promise<Object>}      — resultado completo com análise, oportunidades e trace
 */
async function executarPipelineComercial(perfil, opcoes = {}) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('executarPipelineComercial: perfil inválido ou ausente');
  }

  const dataRef    = opcoes.dataReferencia || perfil.dataReferencia || new Date().toISOString().slice(0, 10);
  const provider   = criarProvider(opcoes.tipoProvider || 'mock');
  const trace      = criarTrace(`svc_${perfil.clienteMr4Id}_${Date.now()}`);
  const outputs    = [];

  // ── Etapa 1: Tendência ──────────────────────────────────────────────────────
  const { encerrar: encTend } = trace.iniciarSpan('calcularTendencia', { clienteMr4Id: perfil.clienteMr4Id });
  const tendencia = calcularTendencia(perfil);
  encTend({ tendencia: tendencia.tendencia });

  // ── Etapa 2: Score ──────────────────────────────────────────────────────────
  const { encerrar: encScore } = trace.iniciarSpan('calcularScore');
  const score = calcularScore(perfil, tendencia.tendencia, { dataReferencia: dataRef });
  encScore({ scoreTotal: score.scoreTotal, classificacao: score.classificacao });

  // ── Etapa 3: Recorrência ────────────────────────────────────────────────────
  const { encerrar: encRecorr } = trace.iniciarSpan('calcularRecorrencia');
  const recorrencia = calcularRecorrencia(perfil);
  encRecorr({ status: recorrencia.status });

  // ── Etapa 4: Oportunidades ──────────────────────────────────────────────────
  const { encerrar: encOport } = trace.iniciarSpan('gerarOportunidades');
  const oportunidades = gerarOportunidades(perfil, score, tendencia, recorrencia, dataRef);
  encOport({ count: oportunidades.length });

  // ── Etapa 5: Priorizador ────────────────────────────────────────────────────
  const { encerrar: encPrio } = trace.iniciarSpan('priorizarOportunidades');
  const oportunidadesRanqueadas = priorizarOportunidades(oportunidades, perfil, score);
  encPrio({ count: oportunidadesRanqueadas.length });

  // ── Etapa 6: Análise do Agente ──────────────────────────────────────────────
  const { encerrar: encAnalise } = trace.iniciarSpan('analistaCliente');
  const analise = await analisar({ perfil, score, tendencia, recorrencia, oportunidades: oportunidadesRanqueadas, provider });
  const analiseValidada = validarSchema(analise);
  outputs.push(analiseValidada);
  encAnalise({ tipo: analise.tipo, mockMode: analise._meta?.mockMode });

  // ── Etapa 7: Explicação do Score (opcional) ─────────────────────────────────
  let explicacao = null;
  if (opcoes.incluirExplicacaoScore) {
    const { encerrar: encExplica } = trace.iniciarSpan('explicadorComercial');
    explicacao = await explicarScore({ score, provider });
    const explicacaoValidada = validarSchema(explicacao);
    outputs.push(explicacaoValidada);
    encExplica({ tipo: explicacao.tipo });
  }

  // ── Etapa 8: Auditoria ──────────────────────────────────────────────────────
  const relatorio = auditarOutputs(outputs);

  trace.finalizar({
    clienteMr4Id:  perfil.clienteMr4Id,
    scoreTotal:    score.scoreTotal,
    oportunidades: oportunidades.length,
    conforme:      relatorio.conformeGeral,
    mockMode:      analise._meta?.mockMode,
  });

  return {
    clienteMr4Id:         perfil.clienteMr4Id,
    dataReferencia:       dataRef,
    score,
    tendencia,
    recorrencia,
    oportunidades:        oportunidadesRanqueadas,
    analise:              analiseValidada,
    explicacaoScore:      explicacao,
    auditoria:            relatorio,
    trace:                trace.serializar(),
    versaoServico:        VERSAO_SERVICO,
    mockMode:             analise._meta?.mockMode === true,
    statusServico:        'PROVISIONAL',
  };
}

module.exports = {
  VERSAO_SERVICO,
  executarPipelineComercial,
};
