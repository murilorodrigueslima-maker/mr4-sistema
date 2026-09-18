'use strict';

/**
 * N28 — Seleção Determinística de Amostra e Pseudonimização.
 *
 * Seleciona até 12 clientes reais para o Shadow Pilot.
 * Nunca persiste o mapa cliente → SHADOW-XXX.
 * Nunca envia PII ao provider.
 *
 * Critérios de seleção (PASSO 5):
 *   A) compradores ativos (diasSemComprar < 30)
 *   B) inativos >= 120 dias
 *   C) janela de recompra
 *   D) tendência de queda
 *   E) alta força de sinal (scoreTotal >= 70)
 *   F) baixa força de sinal (scoreTotal < 40)
 *   G) single purchase (pedidosTotal === 1)
 *   H) recorrência com mediana relevante (diasEntreComprasMedio >= 20)
 *
 * EXCLUÍDOS: nuncaComprou=true (PROSPECT_VINCULADO / never-bought)
 *
 * MÁXIMO ABSOLUTO: 12 clientes.
 */

const MAX_AMOSTRA = 12;

// Categorias de seleção e seus critérios (função: perfil → boolean)
const CATEGORIAS = [
  { id: 'A', nome: 'ATIVO',          fn: p => !p.nuncaComprou && p.diasSemComprar != null && p.diasSemComprar < 30 },
  { id: 'B', nome: 'INATIVO_120D',   fn: p => !p.nuncaComprou && p.inativo120d === true },
  { id: 'C', nome: 'JANELA_RECOMPRA',fn: p => !p.nuncaComprou && p._oportunidadeTipo === 'JANELA_DE_RECOMPRA' },
  { id: 'D', nome: 'QUEDA',          fn: p => !p.nuncaComprou && p._tendencia === 'CAINDO' },
  { id: 'E', nome: 'ALTA_FORCA',     fn: p => !p.nuncaComprou && p._scoreTotal != null && p._scoreTotal >= 70 },
  { id: 'F', nome: 'BAIXA_FORCA',    fn: p => !p.nuncaComprou && p._scoreTotal != null && p._scoreTotal < 40 },
  { id: 'G', nome: 'SINGLE_PURCHASE',fn: p => !p.nuncaComprou && p.pedidosTotal === 1 },
  { id: 'H', nome: 'RECORRENCIA',    fn: p => !p.nuncaComprou && p.diasEntreComprasMedio != null && p.diasEntreComprasMedio >= 20 },
];

/**
 * Determina a chave de ordenação determinística para um perfil.
 * Usa clienteMr4Id (string) para ordenação consistente.
 *
 * @param {Object} perfil
 * @returns {string}
 */
function _chaveOrdenacao(perfil) {
  return String(perfil.clienteMr4Id || '').toLowerCase();
}

/**
 * Seleciona amostra determinística de até MAX_AMOSTRA clientes.
 *
 * Algoritmo:
 *   1. Exclui nuncaComprou=true
 *   2. Ordena alfabeticamente por clienteMr4Id (reprodutível)
 *   3. Para cada categoria A..H, tenta adicionar o primeiro elegível ainda não selecionado
 *   4. Preenche vagas restantes com os primeiros da lista ordenada ainda não selecionados
 *   5. Limita a MAX_AMOSTRA
 *
 * @param {Object[]} todosOsPerfis - array de perfis enriquecidos (com _scoreTotal, _tendencia, _oportunidadeTipo)
 * @returns {{ selecionados: Object[], categoriasPorId: Object, estatisticas: Object }}
 */
function selecionarAmostra(todosOsPerfis) {
  if (!Array.isArray(todosOsPerfis)) {
    throw new Error('selecionarAmostra: todosOsPerfis deve ser array');
  }

  // Exclui never-bought
  const elegíveis = todosOsPerfis
    .filter(p => p.nuncaComprou !== true)
    .sort((a, b) => _chaveOrdenacao(a).localeCompare(_chaveOrdenacao(b)));

  const selecionados = [];
  const idsSelecionados = new Set();
  const categoriasPorId = {};

  // Passo 1: um representante por categoria
  for (const cat of CATEGORIAS) {
    if (selecionados.length >= MAX_AMOSTRA) break;
    const candidato = elegíveis.find(p => !idsSelecionados.has(p.clienteMr4Id) && cat.fn(p));
    if (candidato) {
      selecionados.push(candidato);
      idsSelecionados.add(candidato.clienteMr4Id);
      categoriasPorId[candidato.clienteMr4Id] = cat.id;
    }
  }

  // Passo 2: preenche vagas restantes (primeiros da lista ordenada não ainda selecionados)
  for (const p of elegíveis) {
    if (selecionados.length >= MAX_AMOSTRA) break;
    if (!idsSelecionados.has(p.clienteMr4Id)) {
      selecionados.push(p);
      idsSelecionados.add(p.clienteMr4Id);
      categoriasPorId[p.clienteMr4Id] = 'FILL';
    }
  }

  // Estatísticas
  const categoriasRepresentadas = new Set(Object.values(categoriasPorId));
  const categoriasFaltando = CATEGORIAS
    .filter(c => !Object.values(categoriasPorId).includes(c.id))
    .map(c => `${c.id}:${c.nome}`);

  return {
    selecionados,
    categoriasPorId,
    estatisticas: {
      totalUniverso:         todosOsPerfis.length,
      totalElegiveis:        elegíveis.length,
      totalNuncaComprou:     todosOsPerfis.length - elegíveis.length,
      totalSelecionados:     selecionados.length,
      categoriasCobertas:    [...categoriasRepresentadas].filter(c => c !== 'FILL'),
      categoriasFaltando,
    },
  };
}

/**
 * Pseudonimiza a lista de selecionados.
 * Cria mapa SOMENTE em memória — nunca persiste.
 *
 * @param {Object[]} selecionados - perfis selecionados
 * @returns {{ pseudonimizados: Object[], mapa: Map }} — mapa: SHADOW-XXX → clienteMr4Id (apenas em memória)
 */
function pseudonimizar(selecionados) {
  // Mapa efêmero: SHADOW-XXX → clienteMr4Id
  const mapa = new Map();
  const pseudonimizados = [];

  for (let i = 0; i < selecionados.length; i++) {
    const shadowId = `SHADOW-${String(i + 1).padStart(3, '0')}`;
    const original = selecionados[i];

    mapa.set(shadowId, original.clienteMr4Id);

    // Remove todos os identificadores diretos do perfil pseudonimizado
    // Mantém apenas campos comerciais estruturados
    const pseudo = {
      shadowId,
      // Campos comerciais estruturados (sem PII)
      nuncaComprou:            original.nuncaComprou,
      inativo120d:             original.inativo120d,
      diasSemComprar:          original.diasSemComprar ?? null,
      pedidosTotal:            original.pedidosTotal ?? null,
      pedidos30d:              original.pedidos30d ?? 0,
      pedidos60d:              original.pedidos60d ?? 0,
      pedidos90d:              original.pedidos90d ?? 0,
      pedidos180d:             original.pedidos180d ?? 0,
      faturamentoTotalCents:   original.faturamentoTotalCents ?? null,
      faturamento30dCents:     original.faturamento30dCents ?? null,
      faturamento60dCents:     original.faturamento60dCents ?? null,
      faturamento90dCents:     original.faturamento90dCents ?? null,
      faturamento180dCents:    original.faturamento180dCents ?? null,
      ticketMedioCents:        original.ticketMedioCents ?? null,
      diasEntreComprasMedio:   original.diasEntreComprasMedio ?? null,
      diasEntreComprasMediana: original.diasEntreComprasMediana ?? null,
      // Derivados pré-computados (sem identificadores)
      _scoreTotal:      original._scoreTotal,
      _classificacao:   original._classificacao,
      _tendencia:       original._tendencia,
      _recorrenciaStatus: original._recorrenciaStatus,
      _oportunidadeTipo:  original._oportunidadeTipo,
      _oportunidadePrioridade: original._oportunidadePrioridade,
      // SEM: clienteMr4Id, gestaoClickId, nome, email, telefone, cpf, cnpj,
      //       endereço, cep, cidade, bairro, ultimaCompraEm, primeiraCompraEm, dataReferencia
    };

    pseudonimizados.push(pseudo);
  }

  // O mapa só existe em memória — nunca serializado ou logado
  return { pseudonimizados, mapa };
}

module.exports = {
  MAX_AMOSTRA,
  CATEGORIAS,
  selecionarAmostra,
  pseudonimizar,
};
