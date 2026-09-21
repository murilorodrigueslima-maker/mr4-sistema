'use strict';

/**
 * N33.5 — Seller Assist Service V1
 *
 * Roteador de renderização para o Hybrid Seller Assist:
 *   AGIR_AGORA      → HYBRID: deterministic facts + LLM para comoAbordar
 *   PROGRAMAR_CICLO → DETERMINISTIC: renderizarProgramarCiclo (sem LLM)
 *   NAO_AGIR        → DETERMINISTIC: renderizarNaoAgir (sem LLM)
 *   desconhecido    → FAIL_CLOSED
 *
 * INVARIANTES:
 *   AI_MODE=SHADOW — resultado nunca chega ao vendedor em produção
 *   OPENAI_CALLS=0 em testes — provider sempre injetado via opcoes.provider
 *   PROD_WRITES=0 | DEPLOYS=0
 *
 * Provider é injetado via opcoes.provider (interface: { complete(prompt, opts) }).
 * MockProvider em testes, OpenAIProvider em produção.
 *
 * Estrutura do resultado:
 *   { modo, situacao, sinais, quando, comoAbordar, metadata: { llmUsed, llmStatus, versaoPrompt? } }
 */

const { buildContextoComoAbordar }   = require('./contextBuilder');
const {
  QUANDO_AGIR_AGORA,
  renderizarAgirAgora,
  renderizarProgramarCiclo,
  renderizarNaoAgir,
  validarComoAbordar,
  AbordagemViolationError,
} = require('./abordagemContract');
const { construirUserPrompt, VERSAO_PROMPT } = require('./promptComoAbordar');
const { TIPOS_RECOMPRA_V1 } = require('../decisaoAcaoComercial');

// ── Constantes ─────────────────────────────────────────────────────────────────

const VERSAO_SELLER_ASSIST = 'seller-assist-v1';

const LLM_STATUS = Object.freeze({
  SUCCESS:        'LLM_SUCCESS',
  NOT_ELIGIBLE:   'NOT_ELIGIBLE',
  INFRA_ERROR:    'INFRA_ERROR',
  CONTRACT_BLOCK: 'CONTRACT_BLOCK',
  FAIL_CLOSED:    'FAIL_CLOSED',
});

// QUANDO_AGIR_AGORA e renderizarAgirAgora importados de abordagemContract (single source)

// ── Helpers de construção de resultado ────────────────────────────────────────

function _buildDeterministicResult(renderOutput) {
  return Object.freeze({
    modo:        'DETERMINISTIC',
    situacao:    renderOutput.situacao,
    sinais:      null,
    quando:      renderOutput.quando,
    comoAbordar: null,
    metadata:    Object.freeze({
      llmUsed:   false,
      llmStatus: LLM_STATUS.NOT_ELIGIBLE,
    }),
  });
}

function _buildHybridResult(situacao, sinais, quando, comoAbordar, llmStatus, llmUsed) {
  const meta = {
    llmUsed,
    llmStatus,
    versaoPrompt: VERSAO_PROMPT,
  };
  return Object.freeze({
    modo:        'HYBRID',
    situacao,
    sinais:      sinais ? Object.freeze({ ...sinais }) : null,
    quando,
    comoAbordar,
    metadata:    Object.freeze(meta),
  });
}

function _buildFailClosedResult(situacao) {
  return Object.freeze({
    modo:        'FAIL_CLOSED',
    situacao,
    sinais:      null,
    quando:      null,
    comoAbordar: null,
    metadata:    Object.freeze({
      llmUsed:   false,
      llmStatus: LLM_STATUS.FAIL_CLOSED,
    }),
  });
}

// ── Extração de sinais (subset do contextoProvider) ──────────────────────────

function _extrairSinais(contextoProvider) {
  const campos = [
    'diasSemComprar', 'cicloMedianoDias', 'tendencia',
    'diasAlemDoCiclo', 'razaoDoCiclo',
    'statusVariacaoPedidos', 'variacaoPedidosPct',
  ];
  const s = {};
  for (const c of campos) {
    if (c in contextoProvider && contextoProvider[c] !== undefined) {
      s[c] = contextoProvider[c];
    }
  }
  return Object.freeze(s);
}

// ── Rotas ──────────────────────────────────────────────────────────────────────

function _rotaDeterministicProgramar(decisaoCtx) {
  const dias = decisaoCtx.diasAteProximoCiclo ?? null;
  return _buildDeterministicResult(renderizarProgramarCiclo(dias));
}

function _rotaDeterministicNaoAgir() {
  return _buildDeterministicResult(renderizarNaoAgir());
}

async function _rotaHybridLLM(decisaoCtx, sinaisCtx, opcoes) {
  const provider = opcoes.provider;
  const situacao = renderizarAgirAgora(decisaoCtx);   // single source: abordagemContract
  const quando   = QUANDO_AGIR_AGORA;                 // single source: abordagemContract

  // Guard: provider ausente ou interface inválida
  if (!provider || typeof provider.complete !== 'function') {
    return _buildHybridResult(situacao, null, quando, null, LLM_STATUS.INFRA_ERROR, false);
  }

  // Construir contexto mínimo sanitizado
  let contextoProvider;
  try {
    contextoProvider = buildContextoComoAbordar(decisaoCtx, sinaisCtx);
  } catch (_) {
    return _buildHybridResult(situacao, null, quando, null, LLM_STATUS.INFRA_ERROR, false);
  }

  const tipoOportunidade = decisaoCtx.tipoOportunidade;
  const sinais           = _extrairSinais(contextoProvider);

  // Construir prompt
  let userPrompt;
  try {
    userPrompt = construirUserPrompt(contextoProvider, tipoOportunidade);
  } catch (_) {
    return _buildHybridResult(situacao, sinais, quando, null, LLM_STATUS.INFRA_ERROR, false);
  }

  // Chamar provider
  let providerResult;
  try {
    providerResult = await provider.complete(userPrompt, {
      chave:  'COMO_ABORDAR',
      modelo: 'gpt-5.6-luna',
    });
  } catch (_) {
    return _buildHybridResult(situacao, sinais, quando, null, LLM_STATUS.INFRA_ERROR, false);
  }

  // Parsear output JSON
  let comoAbordar;
  try {
    const parsed = JSON.parse(providerResult.texto);
    comoAbordar  = parsed?.comoAbordar;
    if (typeof comoAbordar !== 'string' || !comoAbordar.trim()) {
      return _buildHybridResult(situacao, sinais, quando, null, LLM_STATUS.INFRA_ERROR, true);
    }
  } catch (_) {
    return _buildHybridResult(situacao, sinais, quando, null, LLM_STATUS.INFRA_ERROR, true);
  }

  // Validar via contrato N33.3
  try {
    validarComoAbordar(comoAbordar, { tipoOportunidade });
  } catch (e) {
    const llmStatus = e instanceof AbordagemViolationError
      ? LLM_STATUS.CONTRACT_BLOCK
      : LLM_STATUS.INFRA_ERROR;
    return _buildHybridResult(situacao, sinais, quando, null, llmStatus, true);
  }

  return _buildHybridResult(situacao, sinais, quando, comoAbordar, LLM_STATUS.SUCCESS, true);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Calcula o Seller Assist para a decisão comercial dada.
 *
 * @param {Object} decisaoCtx — saída do motor de decisão (calcularDecisaoAcaoComercial)
 *   Campos obrigatórios para AGIR_AGORA: decisaoAcaoComercial, tipoOportunidade,
 *     diasSemComprar, diasEntreComprasMediana, tendencia
 *   Campo extra para PROGRAMAR_CICLO: diasAteProximoCiclo (opcional)
 * @param {Object} [sinaisCtx={}] — sinais de N33.2 { atrasoCiclo, variacaoVolume }
 * @param {Object} [opcoes={}] — { provider: <objeto com .complete()>, trace? }
 * @returns {Promise<Object>} — resultado imutável com modo/situacao/sinais/quando/comoAbordar/metadata
 */
async function calcularSellerAssist(decisaoCtx, sinaisCtx = {}, opcoes = {}) {
  if (!decisaoCtx || typeof decisaoCtx !== 'object') {
    return _buildFailClosedResult('decisaoCtx inválido.');
  }

  const decisaoAcao = decisaoCtx.decisaoAcaoComercial;

  if (decisaoAcao === 'AGIR_AGORA') {
    const tipo = decisaoCtx.tipoOportunidade;
    if (!tipo || !TIPOS_RECOMPRA_V1.includes(tipo)) {
      return _buildFailClosedResult(`Tipo de oportunidade não suportado pelo Seller Assist V1: "${tipo ?? 'null'}".`);
    }
    return _rotaHybridLLM(decisaoCtx, sinaisCtx, opcoes);
  }

  if (decisaoAcao === 'PROGRAMAR_CICLO') {
    return _rotaDeterministicProgramar(decisaoCtx);
  }

  if (decisaoAcao === 'NAO_AGIR') {
    return _rotaDeterministicNaoAgir();
  }

  return _buildFailClosedResult(`Decisão desconhecida: "${decisaoAcao ?? 'null'}".`);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_SELLER_ASSIST,
  LLM_STATUS,
  calcularSellerAssist,
};
