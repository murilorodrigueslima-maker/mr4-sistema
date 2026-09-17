'use strict';

const VERSAO_PROMPT = '1.0.0';
const CHAVE_MOCK    = 'ANALISTA_OPORTUNIDADE';

const SCHEMA_CONTEXTO = [
  'tipoOportunidade',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'prioridade',
];

function build(ctx) {
  for (const campo of SCHEMA_CONTEXTO) {
    if (!(campo in ctx)) {
      throw new Error(`analistaOportunidade.build: campo obrigatório ausente: "${campo}"`);
    }
  }

  return `
Você é um analista comercial. Explique POR QUE a oportunidade abaixo existe para este cliente.
Baseie-se EXCLUSIVAMENTE nos dados fornecidos. Não invente valores, datas ou produtos.

TIPO DE OPORTUNIDADE: ${ctx.tipoOportunidade}
PRIORIDADE: ${ctx.prioridade}

DADOS DO CLIENTE:
- Score Comercial: ${ctx.scoreTotal}/100 (${ctx.classificacao})
- Dias sem comprar: ${ctx.diasSemComprar ?? 'N/A (nunca comprou)'}
- Tendência: ${ctx.tendencia}
- Recorrência: ${ctx.recorrenciaStatus}

REGRAS:
1. Use APENAS os dados acima — sem invenção.
2. O tipo de oportunidade é definido pelo sistema determinístico — não altere.
3. Não tome ações. Não sugira contato. Apenas explique o porquê.
4. Português, objetivo, máximo 200 palavras.
`.trim();
}

module.exports = { VERSAO_PROMPT, CHAVE_MOCK, SCHEMA_CONTEXTO, build };
