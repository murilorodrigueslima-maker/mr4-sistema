'use strict';
// Dados SINTÉTICOS para a tela da Política 1.2: passam pelo pipeline REAL (montarSnapshot) e entregam exatamente o que a tela lê
// (compras_n0_view/sugestoes e compras_n0_view/custos). Nomes e códigos fictícios; nenhum dado real.
const S = require('../../lib/compras/snapshot');
const Pol = require('../../lib/compras/politica');
const Fx = require('./compras-rentabilidade-fx');
const X = Fx.X;
const P12 = Pol.POLITICA_1_2;
const politica = { ...P12, profitability: { ...P12.profitability, cost: { ...P12.profitability.cost, imported_supplier_ids: ['IMP-1'] } } };

/** cenário de referência + `extras` produtos sintéticos variados (margens, demanda, custo com/sem referência) */
function cenario(extras = 0, escala = 1) {
  const c = Fx.cenario();
  for (let n = 0; n < extras; n++) {
    const id = 'SYN-' + String(n).padStart(3, '0');
    const custo = 8 + (n * 7) % 40, margem = [-0.2, 0.05, 0.12, 0.2, 0.3, 0.45, 0.6][n % 7];
    const preco = Math.max(2, Math.round(custo / (1 - margem) * 100) / 100);
    c.produtos.push(Fx.produto(id, { estoque: n % 5 === 0 ? 0 : (n % 4) * 3, custo: custo.toFixed(2), venda: preco.toFixed(2) }));
    if (n % 6 !== 5) c.compras.push(Fx.compra(X.dia(120 + (n % 9) * 40), [[id, 50, custo]]));
    if (n % 8 !== 7) c.vendas.push(...Fx.serie(id, { de: 89, passo: 2 + (n % 5), qtd: (1 + (n % 3)) * escala, preco, custo }));
  }
  return c;
}
function dados(extras = 0, agora = X.AGORA, escala = 1) {
  const c = cenario(extras, escala);
  const sn = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora, politica });
  const sn11 = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora });   // Política vigente (1.1)
  return { sn, sn11, sugestoes: sn.view.sugestoes, custos: sn.view.custos, sugestoes11: sn11.view.sugestoes, custos11: sn11.view.custos };
}
module.exports = { cenario, dados, politica };
