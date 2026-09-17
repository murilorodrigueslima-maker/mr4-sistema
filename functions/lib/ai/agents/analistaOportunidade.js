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
async function analisarOportunidade({ oportunidade, perfil, score, tendencia, recorrencia, provider }) {
  if (!provider)     throw new Error(`${NOME_AGENTE}: provider ausente`);
  if (!oportunidade) throw new Error(`${NOME_AGENTE}: oportunidade ausente`);
  if (!perfil)       throw new Error(`${NOME_AGENTE}: perfil ausente`);

  const contexto = {
    tipoOportunidade:  oportunidade.tipo,
    scoreTotal:        score?.scoreTotal    ?? null,
    classificacao:     score?.classificacao ?? 'DESCONHECIDO',
    diasSemComprar:    perfil.nuncaComprou ? null : (perfil.diasSemComprar ?? null),
    tendencia:         tendencia?.tendencia ?? 'SEM_BASE',
    recorrenciaStatus: recorrencia?.status  ?? 'SEM_BASE',
    prioridade:        oportunidade.prioridade ?? null,
  };

  const prompt   = promptTemplate.build(contexto);
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

  return {
    ...validarOutputAgente(output, NOME_AGENTE),
    _meta: {
      agente:           NOME_AGENTE,
      versaoAgente:     VERSAO_AGENTE,
      promptVersao:     promptTemplate.VERSAO_PROMPT,
      tokensUsados:     resposta.tokens,
      mockMode:         resposta.mock === true,
      tipoOportunidade: oportunidade.tipo,
    },
  };
}

module.exports = { NOME_AGENTE, VERSAO_AGENTE, analisarOportunidade };
