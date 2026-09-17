'use strict';

/**
 * Agente: Analista de Cliente Comercial.
 *
 * Responsabilidade:
 *   - Receber Perfil360 + análises (score, tendência, recorrência, oportunidades)
 *   - Montar prompt estruturado
 *   - Chamar provider
 *   - Validar output nos guardrails
 *   - Retornar análise auditável para o vendedor
 *
 * MODO ATUAL: MockProvider apenas (sem LLM real, sem custo, sem API key).
 * IA trabalha exclusivamente em modo de leitura — nunca escreve, altera ou contacta.
 */

const { mkOutputAgente, validarOutputAgente } = require('../guardrails');
const promptTemplate = require('../prompts/analiseCliente');

const NOME_AGENTE = 'analistaCliente';
const VERSAO_AGENTE = '1.0.0';

/**
 * Executa análise do cliente e retorna output validado.
 *
 * @param {Object} params
 * @param {Object} params.perfil       — Perfil360
 * @param {Object} params.score        — resultado de calcularScore()
 * @param {Object} params.tendencia    — resultado de calcularTendencia()
 * @param {Object} params.recorrencia  — resultado de calcularRecorrencia()
 * @param {Object[]} params.oportunidades — resultado de gerarOportunidades()
 * @param {Object} params.provider     — instância de MockProvider (ou real no futuro)
 * @returns {Promise<Object>}          — output validado com metadados
 */
async function analisar({ perfil, score, tendencia, recorrencia, oportunidades, provider }) {
  if (!provider) throw new Error(`${NOME_AGENTE}: provider ausente`);
  if (!perfil)   throw new Error(`${NOME_AGENTE}: perfil ausente`);

  const contexto = {
    clienteMr4Id:      perfil.clienteMr4Id,
    scoreTotal:        score?.scoreTotal   ?? null,
    classificacao:     score?.classificacao ?? 'DESCONHECIDO',
    diasSemComprar:    perfil.diasSemComprar,
    tendencia:         tendencia?.tendencia ?? 'SEM_BASE',
    recorrenciaStatus: recorrencia?.status  ?? 'SEM_BASE',
    oportunidades:     oportunidades || [],
  };

  const prompt = promptTemplate.build(contexto);
  const resposta = await provider.complete(prompt, {
    chave:     promptTemplate.CHAVE_MOCK,
    maxTokens: 500,
  });

  const output = mkOutputAgente({
    tipo:     'ANALISE',
    conteudo: resposta.texto,
    fontes:   ['perfil360', 'score', 'tendencia', 'recorrencia', 'oportunidades'],
    observacoes: resposta.mock ? `[MOCK] provider: ${provider.nome}` : null,
  });

  return {
    ...validarOutputAgente(output, NOME_AGENTE),
    _meta: {
      agente:       NOME_AGENTE,
      versaoAgente: VERSAO_AGENTE,
      promptVersao: promptTemplate.VERSAO_PROMPT,
      tokensUsados: resposta.tokens,
      mockMode:     resposta.mock === true,
    },
  };
}

module.exports = { NOME_AGENTE, VERSAO_AGENTE, analisar };
