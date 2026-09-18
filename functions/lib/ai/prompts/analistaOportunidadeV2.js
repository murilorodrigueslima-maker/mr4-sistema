'use strict';

const VERSAO_PROMPT = '2.0.0';
const CHAVE_MOCK    = 'ANALISTA_OPORTUNIDADE_V2';

// 22 campos obrigatórios no contextoRaw V2 (valores podem ser null)
const SCHEMA_CONTEXTO_V2 = [
  'tipoOportunidade',
  'scoreTotal',
  'classificacao',
  'diasSemComprar',
  'tendencia',
  'recorrenciaStatus',
  'prioridade',
  'pedidosTotal',
  'pedidos30d',
  'pedidos60d',
  'pedidos90d',
  'pedidos180d',
  'faturamentoTotal',
  'faturamento30d',
  'faturamento60d',
  'faturamento90d',
  'faturamento180d',
  'ticketMedioTotal',
  'diasEntreComprasMedio',
  'diasEntreComprasMediana',
  'quantidadeProdutosDistintos',
  'quantidadeCategoriasDistintas',
];

function _fmt(v, sufixo = '') {
  return v == null ? 'N/A' : `${v}${sufixo}`;
}

function buildV2(ctx) {
  for (const campo of SCHEMA_CONTEXTO_V2) {
    if (!(campo in ctx)) {
      throw new Error(`analistaOportunidadeV2.buildV2: campo obrigatório ausente: "${campo}"`);
    }
  }

  return `
Você é um analista comercial. Responda as 3 perguntas abaixo sobre este cliente.
Baseie-se EXCLUSIVAMENTE nos dados fornecidos. Não invente valores, datas ou produtos.

TIPO DE OPORTUNIDADE: ${ctx.tipoOportunidade ?? 'null'}
PRIORIDADE: ${ctx.prioridade ?? 'null'}

DADOS DO CLIENTE:
- Score Comercial: ${_fmt(ctx.scoreTotal, '/100')} (${_fmt(ctx.classificacao)})
- Tendência: ${_fmt(ctx.tendencia)}
- Recorrência: ${_fmt(ctx.recorrenciaStatus)}
- Dias sem comprar: ${_fmt(ctx.diasSemComprar)}

PEDIDOS:
- Total: ${_fmt(ctx.pedidosTotal)} | 30d: ${_fmt(ctx.pedidos30d)} | 60d: ${_fmt(ctx.pedidos60d)} | 90d: ${_fmt(ctx.pedidos90d)} | 180d: ${_fmt(ctx.pedidos180d)}

FATURAMENTO (R$):
- Total: ${_fmt(ctx.faturamentoTotal)} | 30d: ${_fmt(ctx.faturamento30d)} | 60d: ${_fmt(ctx.faturamento60d)} | 90d: ${_fmt(ctx.faturamento90d)} | 180d: ${_fmt(ctx.faturamento180d)}
- Ticket médio total: ${_fmt(ctx.ticketMedioTotal)}

PADRÃO DE COMPRA:
- Dias médios entre compras: ${_fmt(ctx.diasEntreComprasMedio)}
- Dias medianos entre compras: ${_fmt(ctx.diasEntreComprasMediana)}
- Produtos distintos comprados: ${_fmt(ctx.quantidadeProdutosDistintos)}
- Categorias distintas: ${_fmt(ctx.quantidadeCategoriasDistintas)}

RESPONDA as 3 perguntas:
1. O QUE ESTÁ ACONTECENDO? (campo "diagnostico": ≤100 palavras)
2. POR QUE VALE ATENÇÃO? (campo "sinaisRelevantes": lista de até 3 pontos, cada um ≤60 palavras)
3. QUAL A PRÓXIMA AÇÃO COMERCIAL? (campo "acaoSugerida": ≤80 palavras — apenas timing e abordagem; SEM preços, descontos, crédito, limite, comissão ou promoções)

REGRAS:
1. Use APENAS os dados acima — sem invenção.
2. O tipo de oportunidade é definido pelo sistema determinístico — não altere.
3. NÃO defina preços, descontos, crédito, limite de crédito, comissão ou promoções.
4. NÃO tome ações financeiras. Apenas direcione a abordagem comercial.
5. Português, objetivo, respeite os limites de palavras.
`.trim();
}

module.exports = { VERSAO_PROMPT, CHAVE_MOCK, SCHEMA_CONTEXTO_V2, buildV2 };
