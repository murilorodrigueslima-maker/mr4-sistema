'use strict';
// Fixtures SINTÉTICAS do Agente Financeiro Fase 1 (nenhum dado real: nomes fictícios, IDs inventados, sem CPF/CNPJ/contato).
// Formato idêntico ao retornado por GET /pagamentos e /recebimentos do GestãoClick (comprovado por sondagem).
const HOJE = '2026-09-28';
const FORMAS = {
  f_pix: { nome: 'Pix', tipo: 'PI' }, f_bol: { nome: 'Boleto Bancário', tipo: 'BB' }, f_bolpix: { nome: 'boleto Inter/Pix', tipo: 'BB' },
  f_cc: { nome: 'Cartão de Crédito', tipo: 'CC' }, f_din: { nome: 'Dinheiro à Vista', tipo: 'DI' }, f_cl: { nome: 'Crédito cliente', tipo: 'CL' },
};
let seq = 0;
function titulo(o = {}) {
  seq++;
  const base = {
    id: 'T' + String(seq).padStart(5, '0'), codigo: String(1000 + seq), descricao: 'Despesa de teste', valor: '100.00', juros: '0.00', desconto: '0.00',
    taxa_banco: '0.00', taxa_operadora: '0.00', valor_total: '100.00', plano_contas_id: 'P1', nome_plano_conta: 'Compras', centro_custo_id: '', nome_centro_custo: '',
    conta_bancaria_id: 'CB1', nome_conta_bancaria: 'Conta bancária', forma_pagamento_id: 'f_pix', nome_forma_pagamento: 'Pix', entidade: 'F',
    fornecedor_id: 'FORN1', nome_fornecedor: 'Fornecedor Fictício Um', cliente_id: '', nome_cliente: '', transportadora_id: '', nome_transportadora: '',
    funcionario_id: '', nome_funcionario: '', liquidado: '0', data_vencimento: HOJE, data_liquidacao: '', data_competencia: HOJE,
    usuario_id: 'U1', nome_usuario: 'Usuário Teste', loja_id: 'L1', nome_loja: 'Loja Teste', cadastrado_em: '2026-09-01 10:00:00', modificado_em: '2026-09-01 10:00:00', atributos: [],
  };
  return { ...base, ...o };
}
const receber = (o = {}) => titulo({ entidade: 'C', fornecedor_id: '', nome_fornecedor: '', cliente_id: 'CLI1', nome_cliente: 'Cliente Fictício Um', plano_contas_id: 'P9', nome_plano_conta: 'Vendas de produtos', descricao: 'Venda de nº 5001', ...o });
module.exports = { HOJE, FORMAS, titulo, receber };
