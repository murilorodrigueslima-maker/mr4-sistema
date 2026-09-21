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

const { calcularScore }               = require('./scoreComercial');
const { calcularTendencia }           = require('./tendenciaComercial');
const { calcularRecorrencia }         = require('./recorrencia');
const { gerarOportunidades }          = require('./oportunidades');
const { priorizarOportunidades }      = require('./priorizadorOportunidades');
const { calcularDecisaoAcaoComercial }= require('./decisaoAcaoComercial');
const { calcularPerfil360 }           = require('./perfil360');
const {
  QUANDO_AGIR_AGORA,
  renderizarAgirAgora,
  renderizarProgramarCiclo,
  renderizarNaoAgir,
} = require('./n33/abordagemContract');

const PIPELINE_VERSION = 'N34.3.2-local';

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

  return {
    clienteMr4Id:            clienteInput.clienteMr4Id,
    nomeCliente:             clienteInput.nomeCliente || null,
    tipoOportunidade:        oportunidadePrincipal?.tipo ?? null,
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

module.exports = {
  PIPELINE_VERSION,
  processarCliente,
  processarClientesParaFila,
};
