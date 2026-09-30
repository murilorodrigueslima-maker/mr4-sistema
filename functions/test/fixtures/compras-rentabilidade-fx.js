'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.2 · fixtures 100% SINTÉTICAS no formato bruto COMPROVADO do GestãoClick.
// (cabeçalho de venda com desconto/frete, item com custo DA ÉPOCA e desconto, compra com frete/impostos/desconto rateáveis).
// IDs fictícios; nenhum produto, cliente ou fornecedor real.
const X = require('./compras-estoque-f0');

const r2 = n => (Math.round(n * 100) / 100).toFixed(2);
let seq = 0;
/**
 * itens: [pid, qtd, precoTabela, { custo, descPct, descValor }]  (custo = custo gravado NA VENDA; descPct/descValor = desconto do ITEM)
 * o: { id, situacao, situacao_estoque, descValor, descPct (cabeçalho), frete }
 */
function venda(data, itens, o = {}) {
  const its = itens.map(([pid, qtd, preco, x = {}]) => {
    const bruto = qtd * preco;
    const total = x.descValor != null ? bruto - x.descValor : x.descPct != null ? bruto * (1 - x.descPct / 100) : bruto;
    return { produto: { produto_id: pid, variacao_id: null, nome_produto: 'Produto sintético ' + pid, quantidade: String(qtd), valor_venda: r2(preco), valor_custo: x.custo === null ? '' : r2(x.custo === undefined ? 10 : x.custo),
      tipo_desconto: x.descPct != null ? '%' : 'R$', desconto_valor: x.descValor != null ? r2(x.descValor) : '', desconto_porcentagem: x.descPct != null ? String(x.descPct) : '', valor_total: r2(total), sigla_unidade: 'UN' } };
  });
  const vp = its.reduce((t, i) => t + Number(i.produto.valor_total), 0);
  const dv = o.descValor != null ? o.descValor : o.descPct != null ? 0 : 0, fr = o.frete || 0;
  const descCab = o.descValor != null ? o.descValor : o.descPct != null ? vp * o.descPct / 100 : 0;
  return { id: o.id || 'VR-' + (++seq), codigo: 'V' + seq, data, nome_situacao: o.situacao || 'Concretizada', situacao_estoque: o.situacao_estoque === undefined ? '1' : o.situacao_estoque, situacao_financeiro: '1', modificado_em: o.modificado_em || data + ' 12:00:00',
    valor_produtos: r2(vp), desconto_valor: o.descValor != null ? r2(o.descValor) : '0.00', desconto_porcentagem: o.descPct != null ? String(o.descPct) : '0.00', valor_frete: r2(fr), valor_total: r2(vp - descCab + fr), produtos: its };
}
/** itens: [pid, qtd, custoUnit]; o: { id, fornecedor_id, frete, impostos, desconto, situacao } */
function compra(data, itens, o = {}) {
  const vp = itens.reduce((t, [, q, c]) => t + q * c, 0);
  return { Compra: { id: o.id || 'CR-' + (++seq), data_emissao: data, cadastrado_em: data + ' 09:00:00', modificado_em: o.modificado_em || data + ' 09:00:00', nome_situacao: o.situacao || 'Confirmada', fornecedor_id: o.fornecedor_id === undefined ? 'FX-1' : o.fornecedor_id,
    valor_produtos: r2(vp), valor_frete: r2(o.frete || 0), valor_impostos: r2(o.impostos || 0), desconto_valor: r2(o.desconto || 0), valor_total: r2(vp + (o.frete || 0) + (o.impostos || 0) - (o.desconto || 0)),
    produtos: itens.map(([pid, q, c]) => ({ produto: { produto_id: pid, quantidade: String(q), valor_custo: r2(c), estoque_id: '1', quantidade_saida: '0' } })) } };
}
/** vendas regulares: `qtd` unidades a cada `passo` dias, de `de` a `ate` dias atrás, preço de tabela `preco`, custo da época `custo`. */
function serie(pid, { de, ate = 0, passo, qtd = 1, preco, custo = 10, itemExtra = {}, cab = {} }) {
  const out = [];
  for (let n = de; n >= ate; n -= passo) out.push(venda(X.dia(n), [[pid, qtd, preco, { custo, ...itemExtra }]], cab));
  return out;
}
/** Produto com custo/preço cadastrados (strings como a API). */
const produto = (id, o = {}) => X.produto(id, { estoque: 0, valor_custo: o.custo === undefined ? '10.00' : o.custo, valor_venda: o.venda === undefined ? '25.00' : o.venda, ...o });

/**
 * Cenário de referência: histórico antigo (âncora) + um produto por situação.
 * Custo cadastrado = custo com rateio da última compra (como o ERP) → confiança HIGH, salvo onde o caso diz o contrário.
 */
function cenario() {
  seq = 0;
  const P = [], V = [], C = [];
  // âncora do histórico (define a venda mais antiga)
  P.push(produto('RB-BASE', { estoque: 3 })); V.push(venda('2022-01-10', [['RB-BASE', 1, 25, { custo: 10 }]])); C.push(compra('2022-01-05', [['RB-BASE', 5, 10]]));
  // A: alta demanda + ALTA margem (custo 10 → preço 30: margem 66,7 %); estoque 0 → sugestão P1
  P.push(produto('RB-A-ALTA', { estoque: 0, custo: '10.00', venda: '30.00' })); C.push(compra(X.dia(200), [['RB-A-ALTA', 200, 10]])); V.push(...serie('RB-A-ALTA', { de: 89, passo: 2, qtd: 4, preco: 30, custo: 10 }));
  // A: alta demanda + BAIXA margem (custo 25 → preço 30: 16,7 %)
  P.push(produto('RB-A-BAIXA', { estoque: 0, custo: '25.00', venda: '30.00' })); C.push(compra(X.dia(200), [['RB-A-BAIXA', 200, 25]])); V.push(...serie('RB-A-BAIXA', { de: 89, passo: 2, qtd: 4, preco: 30, custo: 25 }));
  // A: alta demanda + margem NEGATIVA (custo 40 → preço 30)
  P.push(produto('RB-A-NEG', { estoque: 0, custo: '40.00', venda: '30.00' })); C.push(compra(X.dia(200), [['RB-A-NEG', 200, 40]])); V.push(...serie('RB-A-NEG', { de: 89, passo: 2, qtd: 4, preco: 30, custo: 40 }));
  // C: baixa demanda + ALTA margem (vende pouco, preço 60, custo 20 → 66,7 %), estoque 0
  P.push(produto('RB-C-ALTA', { estoque: 0, custo: '20.00', venda: '60.00' })); C.push(compra(X.dia(200), [['RB-C-ALTA', 10, 20]])); V.push(...serie('RB-C-ALTA', { de: 80, passo: 20, qtd: 1, preco: 60, custo: 20 }));
  // SEM CUSTO cadastrado (vende normalmente; 1.1 sugere)
  P.push(produto('RB-SEMCUSTO', { estoque: 0, custo: '', venda: '30.00' })); V.push(...serie('RB-SEMCUSTO', { de: 89, passo: 3, qtd: 3, preco: 30, custo: null }));
  // CUSTO ZERO cadastrado
  P.push(produto('RB-CUSTOZERO', { estoque: 0, custo: '0.00', venda: '30.00' })); C.push(compra(X.dia(150), [['RB-CUSTOZERO', 50, 12]])); V.push(...serie('RB-CUSTOZERO', { de: 89, passo: 3, qtd: 3, preco: 30, custo: 0 }));
  // SEM VENDA NA JANELA de 90 dias (vendeu há 150 dias): preço cai no cadastrado (marcado)
  P.push(produto('RB-SEMVENDA', { estoque: 10, custo: '10.00', venda: '25.00' })); C.push(compra(X.dia(200), [['RB-SEMVENDA', 20, 10]])); V.push(venda(X.dia(150), [['RB-SEMVENDA', 2, 25, { custo: 10 }]]));
  // IMPORTADO (fornecedor IMP-1) com custo coerente com a compra, mas componentes de custo não provados
  P.push(produto('RB-IMPORTADO', { estoque: 0, custo: '10.00', venda: '25.00' })); C.push(compra(X.dia(100), [['RB-IMPORTADO', 100, 10]], { fornecedor_id: 'IMP-1' })); V.push(...serie('RB-IMPORTADO', { de: 89, passo: 3, qtd: 3, preco: 25, custo: 10 }));
  return { produtos: P, vendas: V, compras: C };
}
module.exports = { r2, venda, compra, serie, produto, cenario, X };
