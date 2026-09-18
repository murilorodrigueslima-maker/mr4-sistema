'use strict';

/**
 * Agente: Analista de Oportunidade Comercial.
 *
 * Explica POR QUE uma oportunidade existe para um cliente.
 * Recebe oportunidade + prioridade já calculadas pelos engines determinísticos.
 * NÃO escolhe nem altera o tipo de oportunidade.
 * NÃO sugere contato — apenas explica a evidência.
 */

const { mkOutputAgente, validarOutputAgente } = require('../guardrails');
const { prepararContextoParaPrompt } = require('../groundingOutput');
const promptTemplate = require('../prompts/analistaOportunidade');

const NOME_AGENTE  = 'analistaOportunidade';
const VERSAO_AGENTE = '1.0.0';

/**
 * @param {Object} params
 * @param {Object} params.oportunidade  — oportunidade determinística { tipo, prioridade, ... }
 * @param {Object} params.perfil        — Perfil360
 * @param {Object} params.score         — resultado de calcularScore()
 * @param {Object} params.tendencia     — resultado de calcularTendencia()
 * @param {Object} params.recorrencia   — resultado de calcularRecorrencia()
 * @param {Object} params.provider      — instância de provider
 * @returns {Promise<Object>}
 */
async function analisarOportunidade({ oportunidade, perfil, score, tendencia, recorrencia, provider, facts = null }) {
  if (!provider)     throw new Error(`${NOME_AGENTE}: provider ausente`);
  if (!oportunidade) throw new Error(`${NOME_AGENTE}: oportunidade ausente`);
  if (!perfil)       throw new Error(`${NOME_AGENTE}: perfil ausente`);

  const contextoRaw = {
    tipoOportunidade:  oportunidade.tipo,
    scoreTotal:        score?.scoreTotal    ?? null,
    classificacao:     score?.classificacao ?? 'DESCONHECIDO',
    diasSemComprar:    perfil.nuncaComprou ? null : (perfil.diasSemComprar ?? null),
    tendencia:         tendencia?.tendencia ?? 'SEM_BASE',
    recorrenciaStatus: recorrencia?.status  ?? 'SEM_BASE',
    prioridade:        oportunidade.prioridade ?? null,
  };

  const { contextoSanitizado, suspeitos } = prepararContextoParaPrompt(contextoRaw, facts || {});
  const prompt   = promptTemplate.build(contextoSanitizado);
  const resposta = await provider.complete(prompt, {
    chave:     promptTemplate.CHAVE_MOCK,
    maxTokens: 400,
  });

  const output = mkOutputAgente({
    tipo:     'ANALISE',
    conteudo: resposta.texto,
    fontes:   ['perfil360', 'score', 'tendencia', 'recorrencia', 'oportunidade'],
    observacoes: resposta.mock ? `[MOCK] provider: ${provider.nome}` : null,
  });

  // Inclui claims do provider real (OpenAI retorna claims estruturados; mock não)
  const claimsDaIA = Array.isArray(resposta.claims) && resposta.claims.length > 0
    ? resposta.claims
    : undefined;

  const outputComClaims = claimsDaIA ? { ...output, claims: claimsDaIA } : output;

  return {
    ...validarOutputAgente(outputComClaims, NOME_AGENTE),
    _meta: {
      agente:           NOME_AGENTE,
      versaoAgente:     VERSAO_AGENTE,
      promptVersao:     promptTemplate.VERSAO_PROMPT,
      tokensUsados:     resposta.tokens,
      mockMode:         resposta.mock === true,
      tipoOportunidade: oportunidade.tipo,
      sanitizacao:      { suspeitos },
    },
  };
}

module.exports = { NOME_AGENTE, VERSAO_AGENTE, analisarOportunidade };
