'use strict';

const VERSAO_PROMPT = '1.0.0';
const CHAVE_MOCK = 'EXPLICACAO_SCORE';

const SCHEMA_CONTEXTO = [
  'scoreTotal',
  'classificacao',
  'componentes',
  'statusConfig',
];

function build(ctx) {
  for (const campo of SCHEMA_CONTEXTO) {
    if (!(campo in ctx)) {
      throw new Error(`explicadorScore.build: campo obrigatório ausente: "${campo}"`);
    }
  }

  const comps = ctx.componentes || {};
  const linhasComps = Object.entries(comps)
    .map(([nome, c]) => `  - ${nome}: ${c.pontuacao ?? '?'}pts (peso ${c.peso ?? '?'}%, faixa: ${c.faixa ?? '?'})`)
    .join('\n') || '  - (sem componentes)';

  const avisoProvisional = ctx.statusConfig === 'PROVISIONAL'
    ? '\nNOTA: Os pesos deste score são provisórios e não foram validados empresarialmente.'
    : '';

  return `
Explique o Score Comercial abaixo de forma simples para o vendedor.
O score resume o comportamento de compra recente do cliente.${avisoProvisional}

SCORE: ${ctx.scoreTotal}/100 — Classificação: ${ctx.classificacao}

COMPONENTES:
${linhasComps}

REGRAS:
1. Explique em linguagem simples, sem jargão técnico.
2. Não invente causas para o score — baseie-se nos componentes acima.
3. Não recomende ações específicas — isso cabe ao vendedor.
4. Máximo 150 palavras.
`.trim();
}

module.exports = { VERSAO_PROMPT, CHAVE_MOCK, SCHEMA_CONTEXTO, build };
