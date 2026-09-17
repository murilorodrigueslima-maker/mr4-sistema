'use strict';

/**
 * Agente: Assistente do Vendedor.
 *
 * Transforma uma oportunidade validada em orientação prática para o vendedor humano.
 * O vendedor decide TUDO — este agente apenas sugere pontos de conversa.
 *
 * PROIBIÇÕES ABSOLUTAS:
 *   - Enviar WhatsApp, e-mail ou qualquer mensagem
 *   - Criar pedido ou venda
 *   - Definir preço, desconto, prazo, crédito ou limite
 *   - Alterar cadastro ou carteira
 *   - Prometer brinde, frete grátis ou condição especial
 */

const { mkOutputAgente, validarOutputAgente } = require('../guardrails');
const promptTemplate = require('../prompts/assistenteVendedor');

const NOME_AGENTE  = 'assistenteVendedor';
const VERSAO_AGENTE = '1.0.0';

/**
 * @param {Object} params
 * @param {Object} params.oportunidade  — oportunidade determinística { tipo, prioridade, ... }
 * @param {Object} params.perfil        — Perfil360
 * @param {Object} params.score         — resultado de calcularScore()
 * @param {Object} params.tendencia     — resultado de calcularTendencia()
 * @param {Object} params.provider      — instância de provider
 * @returns {Promise<Object>}
 */
async function orientarVendedor({ oportunidade, perfil, score, tendencia, provider }) {
  if (!provider)     throw new Error(`${NOME_AGENTE}: provider ausente`);
  if (!oportunidade) throw new Error(`${NOME_AGENTE}: oportunidade ausente`);
  if (!perfil)       throw new Error(`${NOME_AGENTE}: perfil ausente`);

  const contexto = {
    tipoOportunidade: oportunidade.tipo,
    scoreTotal:       score?.scoreTotal    ?? null,
    classificacao:    score?.classificacao ?? 'DESCONHECIDO',
    diasSemComprar:   perfil.nuncaComprou ? null : (perfil.diasSemComprar ?? null),
    tendencia:        tendencia?.tendencia ?? 'SEM_BASE',
  };

  const prompt   = promptTemplate.build(contexto);
  const resposta = await provider.complete(prompt, {
    chave:     promptTemplate.CHAVE_MOCK,
    maxTokens: 500,
  });

  const output = mkOutputAgente({
    tipo:     'SUGESTAO',
    conteudo: resposta.texto,
    fontes:   ['oportunidade', 'score', 'tendencia'],
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

module.exports = { NOME_AGENTE, VERSAO_AGENTE, orientarVendedor };
