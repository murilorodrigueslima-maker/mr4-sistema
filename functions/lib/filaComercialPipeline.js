'use strict';
// N34.3.2 — Fila Comercial Pipeline (refatorado)
// Pipeline determinístico: transforma dados brutos de clientes em clientesBrutos
// prontos para construirSnapshot(). Sem Seller Assist. Sem OpenAI. Sem erros de infra.
//
// INVARIANTES:
//   OPENAI_CALLS=0        (sem LLM — renderer puro de abordagemContract)
//   PROD_WRITES=0         (este módulo não acessa Firestore)
//   SELLER_ASSIST=NO      (situacao/quando via renderers diretos de abordagemContract)
//   prioridadeFinal→prioridade no clienteBruto (para filtrarOrdenarFilaHoje)
//   N35.11: opportunityInstanceId incluído no output para join com interacoes_fila

const { calcularScore }               = require('./scoreComercial');
const { calcularTendencia }           = require('./tendenciaComercial');
const { calcularRecorrencia }         = require('./recorrencia');
const { gerarOportunidades }          = require('./oportunidades');
const { priorizarOportunidades }      = require('./priorizadorOportunidades');
const { calcularDecisaoAcaoComercial }= require('./decisaoAcaoComercial');
const { calcularPerfil360 }           = require('./perfil360');
const {
  buildOpportunityInstanceId,
  buildCommercialEntityId,
  commercialEntityIdFromPerfil360,
  SOURCES,
} = require('./commercialIdentity');
const {
  QUANDO_AGIR_AGORA,
  renderizarAgirAgora,
  renderizarProgramarCiclo,
  renderizarNaoAgir,
} = require('./n33/abordagemContract');

const PIPELINE_VERSION = 'N34.6.1'; // Gate 5A.5: Cenário B (QUEDA vence JANELA quando CAINDO+>=1.5x)

/**
 * Processa um único cliente e retorna clienteBruto para construirSnapshot().
 *
 * @param {object} clienteInput — { clienteMr4Id, nomeCliente, vendas[] }
 * @param {object} opts         — { dataReferencia?: Date|string }
 * @returns {Promise<object>}   — clienteBruto com campos para construirSnapshot
 */
async function processarCliente(clienteInput, opts = {}) {
  const dataRef = opts.dataReferencia
    ? (opts.dataReferencia instanceof Date
        ? opts.dataReferencia.toISOString().slice(0, 10)
        : opts.dataReferencia)
    : new Date().toISOString().slice(0, 10);

  // 1. Perfil360 (síncrono)
  const perfil = calcularPerfil360({
    clienteMr4Id: clienteInput.clienteMr4Id,
    vendas:        clienteInput.vendas || [],
    dataReferencia: dataRef,
  });

  // 2. Tendência
  const tendenciaResult = calcularTendencia(perfil);

  // 3. Score
  const score = calcularScore(perfil, tendenciaResult.tendencia, { dataReferencia: dataRef });

  // 4. Recorrência
  const recorrencia = calcularRecorrencia(perfil);

  // 5. Oportunidades
  const oportunidades = gerarOportunidades(perfil, score, tendenciaResult, recorrencia, dataRef);

  // 6. Priorização — adiciona prioridadeFinal a cada oportunidade
  const oportunidadesRanqueadas = priorizarOportunidades(oportunidades, perfil, score);
  const oportunidadePrincipal = oportunidadesRanqueadas[0] || null;

  // 7. Decisão de Ação Comercial (N30) — inclui diasAteProximoCiclo
  const decisaoResult = calcularDecisaoAcaoComercial({
    tipoOportunidade:        oportunidadePrincipal?.tipo ?? null,
    recorrenciaStatus:       recorrencia.status,
    diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    diasSemComprar:          perfil.diasSemComprar,
  });

  // 8. Renderer determinístico — zero Seller Assist, zero LLM, zero erros de infra
  const decisaoAcao = decisaoResult.decisaoAcaoComercial;
  let situacaoFila, quandoFila;

  if (decisaoAcao === 'AGIR_AGORA') {
    situacaoFila = renderizarAgirAgora({
      tipoOportunidade:        oportunidadePrincipal?.tipo ?? null,
      diasSemComprar:          perfil.diasSemComprar,
      diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    });
    quandoFila = QUANDO_AGIR_AGORA;
  } else if (decisaoAcao === 'PROGRAMAR_CICLO') {
    const rendered = renderizarProgramarCiclo(decisaoResult.diasAteProximoCiclo);
    situacaoFila   = rendered.situacao;
    quandoFila     = rendered.quando;
  } else {
    // NAO_AGIR e fallback
    const rendered = renderizarNaoAgir();
    situacaoFila   = rendered.situacao;
    quandoFila     = rendered.quando;
  }

  // N35.11: oportunityInstanceId para join com interacoes_fila (não é PII)
  let opportunityInstanceId = null;
  let entityId = null;
  const tipo = oportunidadePrincipal?.tipo ?? null;
  try {
    entityId = buildCommercialEntityId({ source: SOURCES.MR4_LINKED, mr4ClientId: clienteInput.clienteMr4Id });
  } catch (_) { /* identidade inválida */ }
  if (tipo && entityId) {
    opportunityInstanceId = buildOpportunityInstanceId(entityId, tipo, perfil.ultimaCompraEm || null);
  }

  return {
    clienteMr4Id:            clienteInput.clienteMr4Id,
    commercialEntityId:      entityId,
    source:                  SOURCES.MR4_LINKED,
    gestaoClickId:           clienteInput.gestaoClickId ? String(clienteInput.gestaoClickId) : null,
    nomeCliente:             clienteInput.nomeCliente || null,
    tipoOportunidade:        tipo,
    opportunityInstanceId,
    prioridade:              oportunidadePrincipal?.prioridadeFinal ?? null,  // prioridadeFinal → prioridade
    decisaoAcaoComercial:    decisaoResult.decisaoAcaoComercial,
    diasAteProximoCiclo:     decisaoResult.diasAteProximoCiclo,
    diasSemComprar:          perfil.diasSemComprar,
    diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    tendencia:               tendenciaResult.tendencia,
    sellerAssist: {
      situacao: situacaoFila,
      quando:   quandoFila,
      sinais: {
        diasSemComprar:   perfil.diasSemComprar,
        cicloMedianoDias: perfil.diasEntreComprasMediana,
        tendencia:        tendenciaResult.tendencia,
      },
    },
  };
}

/**
 * Processa uma lista de clientes e retorna clientesBrutos para construirSnapshot().
 *
 * @param {object[]} clientes — array de { clienteMr4Id, nomeCliente, vendas[] }
 * @param {object}   opts     — { dataReferencia?: Date|string }
 * @returns {Promise<object[]>}
 */
async function processarClientesParaFila(clientes, opts = {}) {
  if (!Array.isArray(clientes)) {
    throw new TypeError('processarClientesParaFila: clientes deve ser Array');
  }
  const resultados = await Promise.all(clientes.map(c => processarCliente(c, opts)));
  return resultados.filter(Boolean);
}

/**
 * N34.5 — Entry point alternativo: aceita perfil360 já calculado (de perfis_360).
 * Evita re-leitura de vendas_gc e re-computação de calcularPerfil360.
 * Executa apenas as etapas 2-8 do pipeline (tendência → renderer).
 *
 * @param {object} perfil360   — output de calcularPerfil360, tal como gravado em perfis_360
 * @param {string} nomeCliente — nome do cliente (de clientes/{clienteMr4Id})
 * @param {object} opts        — { dataReferencia?: string YYYY-MM-DD }
 * @returns {Promise<object>}  — mesmo shape que processarCliente()
 */
async function processarPerfilParaFila(perfil360, nomeCliente, opts = {}) {
  const dataRef = opts.dataReferencia
    || (typeof perfil360.dataReferencia === 'string' ? perfil360.dataReferencia : null)
    || new Date().toISOString().slice(0, 10);

  // perfil360 É o output de calcularPerfil360 — usado diretamente como perfil (etapa 1 pulada)
  const perfil = perfil360;

  // 2. Tendência
  const tendenciaResult = calcularTendencia(perfil);

  // 3. Score
  const score = calcularScore(perfil, tendenciaResult.tendencia, { dataReferencia: dataRef });

  // 4. Recorrência
  const recorrencia = calcularRecorrencia(perfil);

  // 5. Oportunidades
  const oportunidades = gerarOportunidades(perfil, score, tendenciaResult, recorrencia, dataRef);

  // 6. Priorização
  const oportunidadesRanqueadas = priorizarOportunidades(oportunidades, perfil, score);
  const oportunidadePrincipal   = oportunidadesRanqueadas[0] || null;

  // 7. Decisão de Ação Comercial
  const decisaoResult = calcularDecisaoAcaoComercial({
    tipoOportunidade:        oportunidadePrincipal?.tipo ?? null,
    recorrenciaStatus:       recorrencia.status,
    diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    diasSemComprar:          perfil.diasSemComprar,
  });

  // 8. Renderer determinístico — zero Seller Assist, zero LLM
  const decisaoAcao = decisaoResult.decisaoAcaoComercial;
  let situacaoFila, quandoFila;

  if (decisaoAcao === 'AGIR_AGORA') {
    situacaoFila = renderizarAgirAgora({
      tipoOportunidade:        oportunidadePrincipal?.tipo ?? null,
      diasSemComprar:          perfil.diasSemComprar,
      diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    });
    quandoFila = QUANDO_AGIR_AGORA;
  } else if (decisaoAcao === 'PROGRAMAR_CICLO') {
    const rendered = renderizarProgramarCiclo(decisaoResult.diasAteProximoCiclo);
    situacaoFila   = rendered.situacao;
    quandoFila     = rendered.quando;
  } else {
    const rendered = renderizarNaoAgir();
    situacaoFila   = rendered.situacao;
    quandoFila     = rendered.quando;
  }

  // N35.11: oportunityInstanceId para join com interacoes_fila
  // N35.14: commercialEntityId/source/gestaoClickId expostos no bruto (uso interno; prepararDadosUI não os publica)
  const tipoPerf = oportunidadePrincipal?.tipo ?? null;
  let opportunityInstanceIdPerf = null;
  let entityIdPerf = null;
  try { entityIdPerf = commercialEntityIdFromPerfil360(perfil360); } catch (_) { /* identidade inválida */ }
  if (tipoPerf && entityIdPerf) {
    opportunityInstanceIdPerf = buildOpportunityInstanceId(entityIdPerf, tipoPerf, perfil360.ultimaCompraEm || null);
  }

  return {
    clienteMr4Id:            perfil360.clienteMr4Id,
    commercialEntityId:      entityIdPerf,
    source:                  perfil360.source === SOURCES.GC_NATIVE ? SOURCES.GC_NATIVE : SOURCES.MR4_LINKED,
    gestaoClickId:           perfil360.gestaoClickId ? String(perfil360.gestaoClickId) : null,
    nomeCliente:             nomeCliente || null,
    tipoOportunidade:        tipoPerf,
    opportunityInstanceId:   opportunityInstanceIdPerf,
    prioridade:              oportunidadePrincipal?.prioridadeFinal ?? null,
    decisaoAcaoComercial:    decisaoResult.decisaoAcaoComercial,
    diasAteProximoCiclo:     decisaoResult.diasAteProximoCiclo,
    diasSemComprar:          perfil.diasSemComprar,
    diasEntreComprasMediana: perfil.diasEntreComprasMediana,
    tendencia:               tendenciaResult.tendencia,
    sellerAssist: {
      situacao: situacaoFila,
      quando:   quandoFila,
      sinais: {
        diasSemComprar:   perfil.diasSemComprar,
        cicloMedianoDias: perfil.diasEntreComprasMediana,
        tendencia:        tendenciaResult.tendencia,
      },
    },
  };
}

/**
 * N34.5 — Processa lista de { perfil360, nomeCliente } para fila comercial.
 * Equivalente a processarClientesParaFila mas aceita perfis pré-calculados.
 *
 * @param {Array<{ perfil360: object, nomeCliente: string|null }>} perfisComNomes
 * @param {object} opts — { dataReferencia?: string YYYY-MM-DD }
 * @returns {Promise<object[]>}
 */
async function processarPerfisParaFila(perfisComNomes, opts = {}) {
  if (!Array.isArray(perfisComNomes)) {
    throw new TypeError('processarPerfisParaFila: perfisComNomes deve ser Array');
  }
  const resultados = await Promise.all(
    perfisComNomes.map(({ perfil360, nomeCliente }) =>
      processarPerfilParaFila(perfil360, nomeCliente, opts)
    )
  );
  return resultados.filter(Boolean);
}

module.exports = {
  PIPELINE_VERSION,
  processarCliente,
  processarClientesParaFila,
  processarPerfilParaFila,
  processarPerfisParaFila,
};
