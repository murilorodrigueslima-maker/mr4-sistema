'use strict';
// Validações EXTRAS do Agente Financeiro (pós-modelo, fail closed): NUNCA afirmar saldo/caixa/capacidade/sobra, nunca alegar execução,
// e declarar "indisponível" quando a pergunta pede o que o sistema não tem.
const { RespostaInvalida } = require('../../gateway/schema');
const falha = (c, d) => { throw new RespostaInvalida(c, d); };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TERMO = /saldo|\bcaixa\b|dinheiro|capacidade de (compra|pagamento|pagar|comprar)|poder de (compra|pagamento)|\bsobra|\bsobrar|\bfolga|liquidez|runway|fol[e]go|suficiente|disponivel em conta|no banco|investir|reserva financeira|\bcobrir\b|consegue(m)? (pagar|cobrir|quitar|comprar)|da (pra|para) (pagar|comprar|quitar)|pode(r|ria)? (comprar|gastar|investir)|\btem\b.{0,25}\bem (caixa|conta)/;
const NEGACAO = /\bnao\b|\bnenhum|indisponivel|inexistente|\bsem\b|\bnem\b|nao (esta|ha|existe|integrad|dispon|e possivel)|ainda nao|impossivel|nao (tenho|temos|consigo)/;
const VALOR = /r\$\s?\d|\d+[.,]\d{2}\b|\b\d{4,}\b|\b\d+\s?(mil|reais)\b/;
const EXECUCAO = /\b(paguei|transferi|conciliei|exclui|editei|lancei|baixei|agendei|enviei|programei|quitei|cancelei)\b|\bvou (pagar|transferir|conciliar|excluir|editar|agendar|enviar|lancar|baixar|quitar)\b|\bfoi (pago|transferido|conciliado|agendado|quitado|baixado|lancado)\b|\bja (paguei|transferi)/;
const sentencas = t => String(t || '').split(/(?<=[.!?;\n])\s+|\n/).filter(Boolean);

function textos(resp) { return [resp.answer, ...resp.recommendations.map(r => r.rationale), ...resp.warnings, resp.dataFreshness]; }
function validarFinanceiro(resp, ctx) {
  for (const t of textos(resp)) for (const s of sentencas(t)) {
    const n = norm(s);
    if (EXECUCAO.test(n)) falha('ACAO_EXECUTADA_ALEGADA', n.slice(0, 40));
    if (TERMO.test(n)) {
      if (VALOR.test(n)) falha('SALDO_CAIXA_COM_VALOR', n.slice(0, 40));            // termo de caixa + número na mesma frase: nunca (mesmo negado)
      if (!NEGACAO.test(n)) falha('AFIRMA_SALDO_CAIXA_CAPACIDADE', n.slice(0, 40));  // afirmação sem negação/indisponibilidade
    }
  }
  const pedido = (ctx && ctx.pedidoNaoAtendivel) || [];
  if (pedido.length && !(resp.unavailable || []).some(x => String(x).trim().length > 5)) falha('INDISPONIVEL_NAO_DECLARADO', pedido.join(','));
  if (pedido.includes('SALDO_CAIXA_CAPACIDADE')) {   // a resposta tem que dizer explicitamente que não está disponível
    if (!/indispon|nao (esta|ha|existe|tenho|temos|integrad|dispon)|nao (e )?possivel|sem (saldo|integracao)/.test(norm(resp.answer))) falha('RESPOSTA_SALDO_SEM_INDISPONIBILIDADE');
  }
  // entidades: nenhuma entidade pode alegar motivo fora dos sinais (já checado) e nenhuma recomendação pode citar nome real
  return true;
}
module.exports = { validarFinanceiro, TERMO, NEGACAO, VALOR, EXECUCAO };
