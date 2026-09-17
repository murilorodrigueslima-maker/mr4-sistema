'use strict';

/**
 * Arquitetura de Atribuição — N16.
 *
 * Registra quando um vendedor tomou uma ação comercial, com referência
 * à análise da IA que apoiou (ou não) a decisão.
 *
 * PRINCÍPIO FUNDAMENTAL (do ARCHITECTURE.md):
 *   "Atribuição não é causal."
 *   O fato de a IA ter sugerido uma oportunidade não significa que causou a venda.
 *   O vendedor SEMPRE decide. A IA apenas informa.
 *
 * DECISÕES PENDENTES (ver PENDENCIAS.md A1-A3):
 *   A1: janela temporal de atribuição (quantos dias após a análise?)
 *   A2: critérios de match (qual oportunidade foi "atendida"?)
 *   A3: persistência (onde e como armazenar os registros?)
 *
 * Este módulo cria registros de atribuição LOCAL/OFFLINE apenas.
 * NÃO persiste automaticamente no Firestore — isso é decisão futura (A3).
 */

const VERSAO_ATRIBUICAO = 'atribuicao-v1';

// Janela de atribuição em dias — PROVISIONAL (ver PENDENCIAS.md A1)
const JANELA_ATRIBUICAO_DIAS_PROVISIONAL = 30;

/**
 * Cria um registro de atribuição para uma ação do vendedor.
 *
 * @param {Object} params
 * @param {string} params.clienteMr4Id     — ID do cliente
 * @param {string} params.vendedorId       — ID do vendedor que agiu
 * @param {string} params.tipoAcao         — tipo da ação ('CONTATO', 'VENDA', etc.)
 * @param {string} params.dataAcao         — YYYY-MM-DD quando a ação ocorreu
 * @param {string[]} [params.oportunidadesRef] — IDs das oportunidades que precederam a ação
 * @param {string} [params.analiseRef]     — traceId da análise da IA, se houver
 * @param {string} [params.observacao]     — nota opcional do vendedor
 * @returns {Object}                        — registro de atribuição
 */
function criarRegistroAtribuicao({
  clienteMr4Id,
  vendedorId,
  tipoAcao,
  dataAcao,
  oportunidadesRef = [],
  analiseRef       = null,
  observacao       = null,
}) {
  if (!clienteMr4Id || !vendedorId || !tipoAcao || !dataAcao) {
    throw new Error('criarRegistroAtribuicao: campos obrigatórios ausentes (clienteMr4Id, vendedorId, tipoAcao, dataAcao)');
  }

  return {
    id:               `attr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    clienteMr4Id,
    vendedorId,
    tipoAcao,
    dataAcao,
    oportunidadesRef,
    analiseRef,
    observacao,
    versaoAtribuicao: VERSAO_ATRIBUICAO,
    statusAtribuicao: 'PROVISIONAL',  // pendente decisões A1-A3
    avisoAtribuicao:  'CORRELAÇÃO, NÃO CAUSALIDADE: a IA informou, o vendedor decidiu.',
    criadoEm:         new Date().toISOString(),
  };
}

/**
 * Verifica se uma oportunidade está dentro da janela de atribuição.
 * PROVISIONAL — janela de 30 dias (ver PENDENCIAS.md A1).
 *
 * @param {string} dataOportunidade — YYYY-MM-DD quando a oportunidade foi gerada
 * @param {string} dataAcao         — YYYY-MM-DD quando a ação ocorreu
 * @returns {boolean}
 */
function dentroJanelaAtribuicao(dataOportunidade, dataAcao) {
  const msOport = new Date(dataOportunidade).getTime();
  const msAcao  = new Date(dataAcao).getTime();
  if (isNaN(msOport) || isNaN(msAcao)) return false;
  const diffDias = (msAcao - msOport) / (1000 * 60 * 60 * 24);
  return diffDias >= 0 && diffDias <= JANELA_ATRIBUICAO_DIAS_PROVISIONAL;
}

module.exports = {
  VERSAO_ATRIBUICAO,
  JANELA_ATRIBUICAO_DIAS_PROVISIONAL,
  criarRegistroAtribuicao,
  dentroJanelaAtribuicao,
};
