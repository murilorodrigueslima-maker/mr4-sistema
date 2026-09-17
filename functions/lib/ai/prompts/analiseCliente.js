'use strict';

/**
 * Prompt versionado: Análise de Cliente Comercial.
 *
 * Cada prompt tem:
 *   - versao: semver do prompt
 *   - chave: chave usada no MockProvider
 *   - schema: campos esperados no contexto de entrada
 *   - build(contexto): monta o texto do prompt com dados reais
 *
 * NÃO incluir: nome de clientes reais, IDs internos, ou dados pessoais no template.
 * O template recebe dados estruturados e os insere de forma auditável.
 */

const VERSAO_PROMPT = '1.0.0';
const CHAVE_MOCK = 'ANALISE_CLIENTE';

/** Campos obrigatórios no contexto para montar o prompt */
const SCHEMA_CONTEXTO = [
  'clienteMr4Id',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'oportunidades',
];

/**
 * Constrói o prompt de análise de cliente.
 * @param {Object} ctx — campos conforme SCHEMA_CONTEXTO
 * @returns {string}   — texto do prompt
 */
function build(ctx) {
  for (const campo of SCHEMA_CONTEXTO) {
    if (!(campo in ctx)) {
      throw new Error(`analiseCliente.build: campo obrigatório ausente: "${campo}"`);
    }
  }

  const oportunidadesStr = (ctx.oportunidades || [])
    .map(o => `  - ${o.tipo} (prioridade: ${o.prioridade})`)
    .join('\n') || '  - (nenhuma identificada)';

  return `
Você é um analista comercial assistente. Analise o perfil do cliente abaixo e forneça
uma análise estruturada para apoiar o vendedor humano. Não tome decisões por conta própria.

DADOS DO CLIENTE:
- Score Comercial: ${ctx.scoreTotal}/100 (${ctx.classificacao})
- Dias sem comprar: ${ctx.diasSemComprar ?? 'desconhecido'}
- Tendência de compras: ${ctx.tendencia}
- Status de recorrência: ${ctx.recorrenciaStatus}

OPORTUNIDADES IDENTIFICADAS:
${oportunidadesStr}

REGRAS:
1. Baseie-se APENAS nos dados acima — não invente informações.
2. Não tome ações comerciais. Apenas descreva a situação e apoie o vendedor.
3. Responda em português, de forma objetiva e estruturada.
4. Limite: até 300 palavras.
`.trim();
}

module.exports = {
  VERSAO_PROMPT,
  CHAVE_MOCK,
  SCHEMA_CONTEXTO,
  build,
};
