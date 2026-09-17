'use strict';

/**
 * Serviço do Agente Comercial IA — N25.
 *
 * Pipeline completo:
 *   Perfil360 → Score → Tendência → Recorrência → Oportunidades → Priorizador
 *   → GroundingFacts → Agentes IA → Guardrails → AuditorIA → Trace
 *
 * AI_MODE = SHADOW: resultados NÃO chegam ao vendedor; NÃO há side effects.
 * Provider: MockProvider (sem LLM real, sem API key, sem custo).
 * Sem persistência: o chamador decide se/onde armazenar.
 */

const { calcularScore }          = require('../scoreComercial');
const { calcularTendencia }      = require('../tendenciaComercial');
const { calcularRecorrencia }    = require('../recorrencia');
const { gerarOportunidades }     = require('../oportunidades');
const { priorizarOportunidades } = require('../priorizadorOportunidades');
const { analisar }               = require('./agents/analistaCliente');
const { analisarOportunidade }   = require('./agents/analistaOportunidade');
const { orientarVendedor }       = require('./agents/assistenteVendedor');
const { explicarScore }          = require('./agents/explicadorComercial');
const { auditarOutputs }         = require('./agents/auditorIA');
const { criarProvider }          = require('./provider');
const { criarTrace }             = require('./trace');
const { validarSchema }          = require('./validatorOutput');
const { buildGroundingFacts }    = require('./groundingOutput');

const VERSAO_SERVICO = 'servico-v2';

// Shadow Mode: pipeline executa mas resultado NÃO vai para o vendedor.
// Nenhum side effect, nenhuma persistência, nenhuma mensagem.
const AI_MODE = 'SHADOW';

/**
 * Executa o pipeline completo do Agente Comercial para um cliente.
 *
 * @param {Object} perfil   — Perfil360 completo
 * @param {Object} [opcoes] — { dataReferencia, tipoProvider, incluirExplicacaoScore,
 *                              incluirAnalistaOportunidade, incluirAssistenteVendedor }
 * @returns {Promise<Object>}
 */
async function executarPipelineComercial(perfil, opcoes = {}) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('executarPipelineComercial: perfil inválido ou ausente');
  }

  const dataRef  = opcoes.dataReferencia || perfil.dataReferencia || new Date().toISOString().slice(0, 10);
  const provider = criarProvider(opcoes.tipoProvider || 'mock');
  const trace    = criarTrace(`svc_${perfil.clienteMr4Id}_${Date.now()}`);
  const outputs  = [];

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

  // ── Etapa 6: Grounding Facts ────────────────────────────────────────────────
  const { encerrar: encGround } = trace.iniciarSpan('buildGroundingFacts');
  const oportunidadePrincipal   = oportunidadesRanqueadas[0] || null;
  const facts = buildGroundingFacts(perfil, score, tendencia, recorrencia, {
    oportunidade: oportunidadePrincipal,
  });
  encGround({ versaoGrounding: facts._versaoGrounding });

  // ── Etapa 7: Análise do Cliente ─────────────────────────────────────────────
  const { encerrar: encAnalise } = trace.iniciarSpan('analistaCliente');
  const analise = await analisar({ perfil, score, tendencia, recorrencia, oportunidades: oportunidadesRanqueadas, provider });
  const analiseValidada = validarSchema(analise);
  outputs.push(analiseValidada);
  encAnalise({ tipo: analise.tipo, mockMode: analise._meta?.mockMode });

  // ── Etapa 8: Análise de Oportunidade (opcional, para primeira oportunidade) ──
  let analiseOportunidade = null;
  if (opcoes.incluirAnalistaOportunidade && oportunidadePrincipal) {
    const { encerrar: encAO } = trace.iniciarSpan('analistaOportunidade');
    analiseOportunidade = await analisarOportunidade({
      oportunidade: oportunidadePrincipal,
      perfil,
      score,
      tendencia,
      recorrencia,
      provider,
    });
    const aoValidada = validarSchema(analiseOportunidade);
    outputs.push(aoValidada);
    encAO({ tipo: analiseOportunidade.tipo, tipoOportunidade: oportunidadePrincipal.tipo });
  }

  // ── Etapa 9: Assistente do Vendedor (opcional) ──────────────────────────────
  let orientacaoVendedor = null;
  if (opcoes.incluirAssistenteVendedor && oportunidadePrincipal) {
    const { encerrar: encAV } = trace.iniciarSpan('assistenteVendedor');
    orientacaoVendedor = await orientarVendedor({
      oportunidade: oportunidadePrincipal,
      perfil,
      score,
      tendencia,
      provider,
    });
    const avValidada = validarSchema(orientacaoVendedor);
    outputs.push(avValidada);
    encAV({ tipo: orientacaoVendedor.tipo });
  }

  // ── Etapa 10: Explicação do Score (opcional) ────────────────────────────────
  let explicacao = null;
  if (opcoes.incluirExplicacaoScore) {
    const { encerrar: encExplica } = trace.iniciarSpan('explicadorComercial');
    explicacao = await explicarScore({ score, provider });
    const explicacaoValidada = validarSchema(explicacao);
    outputs.push(explicacaoValidada);
    encExplica({ tipo: explicacao.tipo });
  }

  // ── Etapa 11: Auditoria ─────────────────────────────────────────────────────
  const relatorio = auditarOutputs(outputs);

  trace.finalizar({
    clienteMr4Id:  perfil.clienteMr4Id,
    scoreTotal:    score.scoreTotal,
    oportunidades: oportunidades.length,
    conforme:      relatorio.conformeGeral,
    mockMode:      analise._meta?.mockMode,
    aiMode:        AI_MODE,
  });

  return {
    clienteMr4Id:          perfil.clienteMr4Id,
    dataReferencia:        dataRef,
    score,
    tendencia,
    recorrencia,
    oportunidades:         oportunidadesRanqueadas,
    analise:               analiseValidada,
    analiseOportunidade,
    orientacaoVendedor,
    explicacaoScore:       explicacao,
    grounding:             { versao: facts._versaoGrounding, clienteMr4Id: facts.clienteMr4Id },
    auditoria:             relatorio,
    trace:                 trace.serializar(),
    versaoServico:         VERSAO_SERVICO,
    mockMode:              analise._meta?.mockMode === true,
    aiMode:                AI_MODE,
    // Shadow mode: resultado NÃO deve ser entregue ao vendedor nesta fase.
    // Nenhum side effect, nenhuma persistência, nenhuma mensagem enviada.
    sideEffects:           [],
    statusServico:         'SHADOW',
  };
}

module.exports = {
  VERSAO_SERVICO,
  AI_MODE,
  executarPipelineComercial,
};
