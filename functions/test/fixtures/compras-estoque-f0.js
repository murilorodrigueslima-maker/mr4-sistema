'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · fixtures 100% SINTÉTICAS no formato bruto comprovado do GestãoClick.
// IDs fictícios (PX-*, VX-*, CX-*, FX-*); nenhum produto, cliente ou fornecedor real.
const HOJE = '2026-09-28';
const AGORA = new Date('2026-09-28T15:00:00Z');   // 12:00 em Fortaleza
const dia = n => { const [y, m, d] = HOJE.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10); };

function produto(id, o = {}) {
  return { id, codigo_interno: 'COD-' + id, nome: 'Produto sintético ' + id, grupo_id: o.grupo_id || 'GX-1', nome_grupo: 'Grupo sintético',
    ativo: o.ativo || '1', movimenta_estoque: o.movimenta_estoque || '1', possui_variacao: '0', possui_composicao: o.possui_composicao || '0',
    estoque: o.estoque === undefined ? '0' : String(o.estoque), valor_custo: o.valor_custo === undefined ? '10.00' : o.valor_custo,
    valor_venda: o.valor_venda || '25.00', cadastrado_em: o.cadastrado_em || '2026-04-14 10:00:00', modificado_em: '2026-09-01 10:00:00' };
}
let seqV = 0, seqC = 0;
/** itens: [[produto_id, quantidade, preço unitário]] */
function venda(data, itens, o = {}) {
  return { id: o.id || 'VX-' + (++seqV), codigo: 'V' + seqV, data, nome_situacao: o.situacao || 'Concretizada',
    situacao_estoque: o.situacao_estoque === undefined ? '1' : o.situacao_estoque, situacao_financeiro: '1', modificado_em: data + ' 12:00:00',
    produtos: itens.map(([pid, q, pr = 25]) => ({ produto: { produto_id: pid, variacao_id: null, quantidade: String(q), valor_venda: String(pr), valor_custo: '10.00', valor_total: String(q * pr), sigla_unidade: 'UN' } })) };
}
/** itens: [[produto_id, quantidade, custo]] — devolve o formato embrulhado {Compra:{...}} */
function compra(data_emissao, itens, o = {}) {
  return { Compra: { id: o.id || 'CX-' + (++seqC), data_emissao, cadastrado_em: data_emissao + ' 09:00:00', nome_situacao: o.situacao || 'Confirmada',
    fornecedor_id: o.fornecedor_id === undefined ? 'FX-1' : o.fornecedor_id, valor_frete: o.frete || '0.00', valor_impostos: '0.00', modificado_em: data_emissao + ' 09:00:00',
    produtos: itens.map(([pid, q, c = 10]) => ({ produto: { produto_id: pid, quantidade: String(q), valor_custo: String(c), estoque_id: '1', quantidade_saida: '0' } })) } };
}
/** vendas regulares: `qtd` unidades a cada `passo` dias entre `de` e `ate` dias atrás. */
function serie(pid, { de, ate = 0, passo, qtd = 1, preco = 25 }) {
  const out = [];
  for (let n = de; n >= ate; n -= passo) out.push(venda(dia(n), [[pid, qtd, preco]]));
  return out;
}

/** Cenário completo (um produto por situação). */
function cenario() {
  seqV = 0; seqC = 0;
  const P = [], V = [], C = [];
  // âncora do histórico: venda antiga (define OLDEST_SALES_DATE = 2022-01-10)
  P.push(produto('PX-BASE', { estoque: 3 })); V.push(venda('2022-01-10', [['PX-BASE', 1]])); C.push(compra('2022-01-05', [['PX-BASE', 5]]));
  // venda forte + estoque baixo: 2 un a cada 3 dias por 180 dias → média 90d ≈ 0,667/dia; estoque 5 → ~7,5 dias (crítica)
  P.push(produto('PX-FORTE', { estoque: 5 })); V.push(...serie('PX-FORTE', { de: 180, passo: 3, qtd: 2 })); C.push(compra(dia(200), [['PX-FORTE', 150]], { fornecedor_id: 'FX-1' }), compra(dia(100), [['PX-FORTE', 40]], { fornecedor_id: 'FX-2' }));
  // estoque baixo com venda (cobertura baixa ~22,5d) e excesso (~300d)
  P.push(produto('PX-BAIXO', { estoque: 15 })); V.push(...serie('PX-BAIXO', { de: 180, passo: 3, qtd: 2 })); C.push(compra(dia(200), [['PX-BAIXO', 150]]));
  P.push(produto('PX-EXCESSO', { estoque: 200 })); V.push(...serie('PX-EXCESSO', { de: 180, passo: 3, qtd: 2 })); C.push(compra(dia(200), [['PX-EXCESSO', 400]]));
  // sem venda há 35/65/95/125/185/370 dias (estoque > 0, compra antes da última venda → evidência de estoque)
  for (const [n, d] of [[30, 35], [60, 65], [90, 95], [120, 125], [180, 185], [365, 370]]) {
    const id = 'PX-SEM' + n; P.push(produto(id, { estoque: 10 })); C.push(compra(dia(d + 40), [[id, 20]])); V.push(venda(dia(d), [[id, 3]]));   // observado > janela de produto novo (60d)
  }
  // sem venda há 95 dias, mas com compra DEPOIS da última venda → histórico de estoque desconhecido
  P.push(produto('PX-SEMINCERTO', { estoque: 10 })); V.push(venda(dia(95), [['PX-SEMINCERTO', 3]])); C.push(compra(dia(40), [['PX-SEMINCERTO', 10]]));
  // venda zero com estoque alto (compra há 400 dias, nunca vendeu, dentro do histórico → nunca vendido ALTA confiança)
  P.push(produto('PX-ZEROALTO', { estoque: 500 })); C.push(compra(dia(400), [['PX-ZEROALTO', 500]]));
  // nunca vendido: recente (MEDIUM), sem início confiável (LOW), vida anterior ao histórico (MEDIUM)
  P.push(produto('PX-NUNCA-REC', { estoque: 4 })); C.push(compra(dia(45), [['PX-NUNCA-REC', 4]]));
  P.push(produto('PX-NUNCA-LOW', { estoque: 4 }));
  P.push(produto('PX-NUNCA-ANTIGO', { estoque: 4, cadastrado_em: '2021-06-01 10:00:00' }));
  // produto novo (observado há 8 dias)
  P.push(produto('PX-NOVO', { estoque: 6, cadastrado_em: dia(8) + ' 10:00:00' })); C.push(compra(dia(8), [['PX-NOVO', 8]])); V.push(venda(dia(3), [['PX-NOVO', 2]]));
  // ruptura atual com demanda recente; estoque negativo
  P.push(produto('PX-RUPTURA', { estoque: 0 })); V.push(...serie('PX-RUPTURA', { de: 150, passo: 5, qtd: 1 })); C.push(compra(dia(160), [['PX-RUPTURA', 30]]));
  P.push(produto('PX-NEGATIVO', { estoque: -2 })); V.push(...serie('PX-NEGATIVO', { de: 150, passo: 5, qtd: 1 })); C.push(compra(dia(160), [['PX-NEGATIVO', 28]]));
  // inativo com demanda e ruptura → nunca sugerido
  P.push(produto('PX-INATIVO', { estoque: 0, ativo: '0' })); V.push(...serie('PX-INATIVO', { de: 150, passo: 5, qtd: 1 })); C.push(compra(dia(160), [['PX-INATIVO', 30]]));
  // kit estruturado → não suportado
  P.push(produto('PX-KIT', { estoque: 0, possui_composicao: '1' })); V.push(...serie('PX-KIT', { de: 150, passo: 5, qtd: 1 })); C.push(compra(dia(160), [['PX-KIT', 30]]));
  // sem custo e sem fornecedor (compra sem fornecedor_id)
  P.push(produto('PX-SEMCUSTO', { estoque: 3, valor_custo: '' })); V.push(...serie('PX-SEMCUSTO', { de: 150, passo: 10, qtd: 1 })); C.push(compra(dia(160), [['PX-SEMCUSTO', 20]], { fornecedor_id: null }));
  // cancelamentos: 3 un válidas + 5 un canceladas + 4 un de orçamento sem baixa de estoque
  P.push(produto('PX-CANCEL', { estoque: 50 })); C.push(compra(dia(200), [['PX-CANCEL', 60]]));
  V.push(venda(dia(10), [['PX-CANCEL', 3]]), venda(dia(9), [['PX-CANCEL', 5]], { situacao: 'Cancelada' }), venda(dia(8), [['PX-CANCEL', 4]], { situacao: 'Em aberto', situacao_estoque: '0' }));
  // só venda cancelada → nunca vendido
  P.push(produto('PX-SOCANCEL', { estoque: 5 })); C.push(compra(dia(300), [['PX-SOCANCEL', 5]])); V.push(venda(dia(20), [['PX-SOCANCEL', 5]], { situacao: 'Venda cancelada' }));
  // compra pendente e compra cancelada (fornecedor da cancelada NÃO vira vínculo)
  P.push(produto('PX-PENDENTE', { estoque: 1 })); V.push(...serie('PX-PENDENTE', { de: 150, passo: 5, qtd: 1 }));
  C.push(compra(dia(160), [['PX-PENDENTE', 30]], { fornecedor_id: 'FX-3' }), compra(dia(2), [['PX-PENDENTE', 20]], { situacao: 'A receber', fornecedor_id: 'FX-4' }), compra(dia(1), [['PX-PENDENTE', 20]], { situacao: 'Cancelada', fornecedor_id: 'FX-9' }));
  // tendência: acelerando (quase tudo nos últimos 30d) e caindo (quase tudo entre 60 e 90d)
  P.push(produto('PX-ACELERA', { estoque: 100 })); V.push(...serie('PX-ACELERA', { de: 89, ate: 31, passo: 20, qtd: 1 }), ...serie('PX-ACELERA', { de: 29, passo: 2, qtd: 2 })); C.push(compra(dia(120), [['PX-ACELERA', 150]]));
  P.push(produto('PX-QUEDA', { estoque: 100 })); V.push(...serie('PX-QUEDA', { de: 89, ate: 61, passo: 2, qtd: 2 }), venda(dia(15), [['PX-QUEDA', 1]])); C.push(compra(dia(120), [['PX-QUEDA', 150]]));
  // venda futura (data > hoje) não conta; item de produto que não existe mais (órfão)
  V.push(venda('2026-10-05', [['PX-FORTE', 99]]), venda(dia(5), [['PX-EXCLUIDO', 1]]));
  return { produtos: P, vendas: V, compras: C };
}

/**
 * Cenário de PRODUTO NOVO (janela 60d). Idade = dias desde a primeira evidência (aqui: compra confirmada).
 * Vendas sempre dentro da idade. Um produto maduro dá escala para a curva ABC.
 */
function cenarioProdutoNovo() {
  seqV = 0; seqC = 0;
  const P = [], V = [], C = [];
  const novo = (id, idade, o = {}) => { P.push(produto(id, { estoque: o.estoque === undefined ? 0 : o.estoque, ativo: o.ativo })); C.push(compra(dia(idade), [[id, 20]])); };
  const vendasEm = (id, dias, qtd = 2, o = {}) => dias.forEach(d => V.push(venda(dia(d), [[id, qtd, o.preco || 10]], o)));
  // maduro de referência (escala do ABC): 78 un × R$10 em 365d
  P.push(produto('MA', { estoque: 500 })); C.push(compra(dia(400), [['MA', 600]])); V.push(...serie('MA', { de: 360, passo: 5, qtd: 1, preco: 10 }).slice(0, 78));
  novo('NV-SEM', 20, { estoque: 5 });                                             // sem venda
  novo('NV-UMA', 20); vendasEm('NV-UMA', [5], 1);                                  // 1 venda, 1 un
  novo('NV-DIA1', 20); vendasEm('NV-DIA1', [3], 10);                               // 10 un num único dia
  novo('NV-DOIS', 20); vendasEm('NV-DOIS', [10], 2); vendasEm('NV-DOIS', [4], 1);  // 3 un em 2 dias
  novo('NV-TRES', 20); vendasEm('NV-TRES', [12, 8, 2], 2);                         // 6 un em 3 dias
  novo('NV-CANC', 20); vendasEm('NV-CANC', [12], 2); vendasEm('NV-CANC', [8, 2], 2, { situacao: 'Cancelada' });   // só 2 un valem
  novo('NV-RES', 20); vendasEm('NV-RES', [12, 8, 2], 2, { situacao: 'Reservado' });                               // só reservado
  novo('NV-MISTO', 20); vendasEm('NV-MISTO', [12, 8], 2); vendasEm('NV-MISTO', [2], 2, { situacao: 'Reservado' }); // concluído + reservado
  novo('NV-NEG', 30, { estoque: -2 }); vendasEm('NV-NEG', [20, 10, 3], 2);         // negativo
  novo('NV-POS', 30, { estoque: 3 }); vendasEm('NV-POS', [20, 10, 3], 2);          // com estoque
  novo('NV-INAT', 20, { ativo: '0' }); vendasEm('NV-INAT', [12, 8, 2], 2);         // inativo
  for (const idade of [6, 7, 59, 60, 61]) { novo('NV-I' + idade, idade); vendasEm('NV-I' + idade, [idade - 1, Math.floor(idade / 2), 1], 2); }
  return { produtos: P, vendas: V, compras: C };
}
/** Três produtos novos com classes ABC de receita determinísticas (A, B, C) + um maduro dominante. */
function cenarioProdutoNovoABC() {
  seqV = 0; seqC = 0;
  const P = [], V = [], C = [];
  P.push(produto('MA', { estoque: 500 })); C.push(compra(dia(400), [['MA', 600]])); V.push(...serie('MA', { de: 360, passo: 4, qtd: 1, preco: 10 }).slice(0, 78));   // 780 (78%)
  const novo = (id, dias, qtd, preco) => { P.push(produto(id, { estoque: 0 })); C.push(compra(dia(20), [[id, 20]])); dias.forEach((d, i) => V.push(venda(dia(d), [[id, qtd[i], preco]]))); };
  novo('NX', [12, 8, 2], [2, 2, 2], 20);   // 120 (12%) → A
  novo('NY', [12, 8, 2], [2, 2, 2], 10);   //  60 ( 6%) → B
  novo('NZ', [12, 8, 2], [2, 1, 1], 10);   //  40 ( 4%) → C
  return { produtos: P, vendas: V, compras: C };
}

module.exports = { HOJE, AGORA, dia, produto, venda, compra, serie, cenario, cenarioProdutoNovo, cenarioProdutoNovoABC };
