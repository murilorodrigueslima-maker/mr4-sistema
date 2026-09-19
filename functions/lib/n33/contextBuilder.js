'use strict';

/**
 * N33.3 — Context Builder para COMO_ABORDAR V1
 *
 * Monta o contexto MÍNIMO para a futura chamada LLM de comoAbordar.
 * ZERO I/O, ZERO OpenAI, ZERO side effects.
 *
 * Separação de responsabilidades:
 *   FATOS                 → campos diretos do contextoRaw (determinísticos)
 *   SINAIS DERIVADOS      → sinaisComerciais.js (N33.2)
 *   CONTEXTO MÍNIMO       → este módulo (escolha deliberada de campos)
 *
 * Princípio de minimização:
 *   "Esse campo pode mudar COMO o vendedor deveria conduzir a conversa?"
 *   Se NÃO → NOT_NEEDED.
 *
 * Regra de PII/IDs:
 *   Nenhum identificador real (clienteMr4Id, gestaoClickId, nome, CPF,
 *   CNPJ, telefone, email, endereço) entra no contexto enviado ao provider.
 *
 * N33.3 — NÃO integrado ao provider ainda. Apenas criação e testes.
 */

const VERSAO_CONTEXT = 'context-como-abordar-v1';

// ── Campos e política de inclusão ────────────────────────────────────────────

/**
 * Campos permitidos no contexto enviado ao provider para comoAbordar.
 *
 * Classificação:
 *   tipoOportunidade     REQUIRED — orienta o prompt por tipo
 *   decisaoAcao          REQUIRED — confirmação de que é AGIR_AGORA
 *   diasSemComprar       REQUIRED — central para os 3 tipos de oportunidade
 *   cicloMedianoDias     REQUIRED — "qual era o ciclo normal?"
 *   diasAlemDoCiclo      OPTIONAL — quando ATRASADO; adiciona precisão
 *   razaoDoCiclo         OPTIONAL — múltiplo do ciclo (ex: 28×); muito útil para REATIVACAO
 *   statusVariacaoPedidos OPTIONAL — sinal de volume para QUEDA_DE_COMPRAS
 *   variacaoPedidosPct   OPTIONAL — severidade da variação (1dp)
 *   tendencia            REQUIRED — CAINDO é gatilho de QUEDA_DE_COMPRAS
 */
const CAMPOS_PERMITIDOS = Object.freeze([
  'tipoOportunidade',
  'decisaoAcao',
  'diasSemComprar',
  'cicloMedianoDias',
  'diasAlemDoCiclo',
  'razaoDoCiclo',
  'statusVariacaoPedidos',
  'variacaoPedidosPct',
  'tendencia',
]);

/**
 * Campos que NUNCA devem entrar no contexto enviado ao provider.
 *
 * Motivação por categoria:
 *   PII/IDs              — política zero-PII ao provider (REAL_CUSTOMER_DATA_SENT=0)
 *   Financeiros brutos   — LLM não precisa de valores para orientar o COMO; UI mostra
 *   Contagens brutas     — sinais derivados (statusVariacaoPedidos) são mais úteis que raw
 *   Internos do motor    — scoreTotal etc. não mudam a abordagem; terminologia interna
 *   Janelas distintas    — não alteram a conduta do contato
 */
const CAMPOS_PROIBIDOS = Object.freeze([
  // PII e identificadores reais
  'clienteMr4Id',
  'gestaoClickId',
  'nomeCliente',
  'nomeVendedor',
  'cpf',
  'cnpj',
  'telefone',
  'whatsapp',
  'email',
  'endereco',
  'cep',
  // Valores financeiros brutos (não mudam a abordagem; são da UI determinística)
  'faturamentoTotal',
  'faturamento30d',
  'faturamento60d',
  'faturamento90d',
  'faturamento180d',
  'ticketMedioTotal',
  'ticketMedio',
  // Contagens brutas de janela (substituídas por sinais derivados)
  'pedidosTotal',
  'pedidos30d',
  'pedidos60d',
  'pedidos90d',
  'pedidos180d',
  // Campos internos do motor de decisão
  'scoreTotal',
  'classificacao',
  'prioridade',
  'acaoTiming',
  'recorrenciaStatus',
  'statusConfig',
  'motivoDeterministico',
  // Dimensões que não mudam a abordagem
  'quantidadeProdutosDistintos',
  'quantidadeCategoriasDistintas',
  // Campos de texto livre com risco de PII/injeção
  'observacoes',
  'nomeProduto',
  'nomeCategoria',
]);

// ── Seleção de sinal de volume mais informativo ───────────────────────────────

const _STATUS_INFORMATIVOS = new Set([
  'QUEDA_TOTAL',
  'QUEDA',
  'CRESCIMENTO',
  'BASE_ZERO_CRESCIMENTO',
]);

function _selecionarMelhorJanelaVolume(variacaoVolume) {
  if (!variacaoVolume) return null;
  const j30 = variacaoVolume.j30d?.pedidos;
  const j90 = variacaoVolume.j90d?.pedidos;
  // Preferir j30d se tem sinal informativo; fallback j90d
  if (j30 && _STATUS_INFORMATIVOS.has(j30.status)) return j30;
  if (j90 && _STATUS_INFORMATIVOS.has(j90.status)) return j90;
  // Fallback: ESTAVEL é informativo também
  if (j30 && j30.status === 'ESTAVEL') return j30;
  if (j90 && j90.status === 'ESTAVEL') return j90;
  return null;
}

// ── buildContextoComoAbordar ──────────────────────────────────────────────────

/**
 * Monta o contexto mínimo para a futura chamada LLM de comoAbordar.
 *
 * Somente para AGIR_AGORA (verificar com ehElegivelLLM antes de chamar).
 * Retorna objeto imutável (Object.freeze).
 *
 * @param {Object} decisaoCtx — contexto do motor de decisão (22 campos ou subset)
 *   Campos usados: tipoOportunidade, decisaoAcaoComercial, diasSemComprar,
 *                  diasEntreComprasMediana, tendencia
 *
 * @param {Object} [sinaisCtx] — sinais pré-calculados (N33.2)
 *   Forma: { atrasoCiclo: <resultado de calcularAtrasoCiclo>,
 *             variacaoVolume: <resultado de calcularVariacaoVolume> }
 *
 * @returns {Object} — contexto imutável com somente os campos permitidos
 */
function buildContextoComoAbordar(decisaoCtx, sinaisCtx = {}) {
  if (!decisaoCtx || typeof decisaoCtx !== 'object') {
    throw new Error('buildContextoComoAbordar: decisaoCtx deve ser objeto');
  }

  const {
    tipoOportunidade,
    decisaoAcaoComercial,
    diasSemComprar,
    diasEntreComprasMediana,
    tendencia,
  } = decisaoCtx;

  const { atrasoCiclo, variacaoVolume } = sinaisCtx;

  // Base sempre presente
  const ctx = {
    versao:           VERSAO_CONTEXT,
    tipoOportunidade: tipoOportunidade   ?? null,
    decisaoAcao:      decisaoAcaoComercial ?? null,
    diasSemComprar:   typeof diasSemComprar === 'number' ? diasSemComprar : null,
    // cicloMedianoDias: preferência por sinais (já validado) > campo raw do ctx
    cicloMedianoDias: atrasoCiclo?.cicloMedianoDias
                      ?? (typeof diasEntreComprasMediana === 'number' ? diasEntreComprasMediana : null),
    tendencia:        tendencia ?? null,
  };

  // Campos de atraso: somente quando status ATRASADO ou NO_CICLO
  if (atrasoCiclo) {
    const s = atrasoCiclo.status;
    if (s === 'ATRASADO') {
      ctx.diasAlemDoCiclo = atrasoCiclo.diasAlemDoCiclo;  // int
      ctx.razaoDoCiclo    = atrasoCiclo.razaoDoCiclo;     // 2dp
    }
  }

  // Sinal de volume: somente quando informativo
  const janelaVolume = _selecionarMelhorJanelaVolume(variacaoVolume);
  if (janelaVolume) {
    ctx.statusVariacaoPedidos = janelaVolume.status;
    if (janelaVolume.variacao !== null) {
      ctx.variacaoPedidosPct = janelaVolume.variacao;  // 1dp
    }
  }

  return Object.freeze(ctx);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_CONTEXT,
  CAMPOS_PERMITIDOS,
  CAMPOS_PROIBIDOS,
  buildContextoComoAbordar,
};
