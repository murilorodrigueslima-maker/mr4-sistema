'use strict';

/**
 * Agente: Explicador Comercial.
 *
 * Responsabilidade: explicar o Score Comercial em linguagem simples para o vendedor.
 * Segue os guardrails — não toma ações, não inventa dados.
 */

const { mkOutputAgente, validarOutputAgente } = require('../guardrails');
const { prepararContextoParaPrompt } = require('../groundingOutput');
const promptTemplate = require('../prompts/explicadorScore');

const NOME_AGENTE = 'explicadorComercial';
const VERSAO_AGENTE = '1.0.0';

async function explicarScore({ score, provider, facts = null }) {
  if (!provider) throw new Error(`${NOME_AGENTE}: provider ausente`);
  if (!score)    throw new Error(`${NOME_AGENTE}: score ausente`);

  const contextoRaw = {
    scoreTotal:    score.scoreTotal,
    classificacao: score.classificacao,
    componentes:   score.componentes,
    statusConfig:  score.statusConfig,
  };

  const { contextoSanitizado, suspeitos } = prepararContextoParaPrompt(contextoRaw, facts || {});
  const prompt = promptTemplate.build(contextoSanitizado);
  const resposta = await provider.complete(prompt, {
    chave:     promptTemplate.CHAVE_MOCK,
    maxTokens: 300,
  });

  const output = mkOutputAgente({
    tipo:     'EXPLICACAO',
    conteudo: resposta.texto,
    fontes:   ['score'],
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
      sanitizacao:  { suspeitos },
    },
  };
}

module.exports = { NOME_AGENTE, VERSAO_AGENTE, explicarScore };
