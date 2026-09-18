'use strict';

/**
 * Decisão de Ação Comercial V1 — N30.
 *
 * Motor determinístico PURO. OPENAI_CALLS=0.
 * Sem Firestore, HTTP, GestãoClick, Firebase Auth, side effects.
 *
 * Executado ANTES do LLM. O LLM apenas explica a decisão — nunca a altera.
 *
 * REGRA A — AGIR_AGORA
 *   tipoOportunidade != null → existe oportunidade determinística acionável.
 *   PROSPECT_VINCULADO é tratado explicitamente: motive indica FILA_PROSPECCAO.
 *
 * REGRA B — PROGRAMAR_CICLO
 *   tipoOportunidade == null
 *   E recorrenciaStatus == 'DENTRO_DO_PADRAO'
 *   E diasEntreComprasMediana != null
 *   E diasSemComprar != null
 *   → acompanhar no ciclo normal.
 *
 * REGRA C — NAO_AGIR
 *   Qualquer outro estado sem sinal determinístico suficiente.
 *   Score isolado (alto ou baixo) NÃO gera oportunidade.
 */

const VERSAO_DECISAO = 'decisao-acao-v1-n30';

// Tipos que pertencem à FILA_PROSPECCAO (não FILA_RECOMPRA).
// Tratados explicitamente para não misturar filas silenciosamente.
const FILA_PROSPECCAO_TIPOS = Object.freeze(['PROSPECT_VINCULADO']);

// Tipos V1 habilitados para FILA_RECOMPRA
const TIPOS_RECOMPRA_V1 = Object.freeze([
  'REATIVACAO_120D',
  'QUEDA_DE_COMPRAS',
  'JANELA_DE_RECOMPRA',
]);

// CROSS_SELL continua desabilitado (CROSS_SELL_ENABLED=false).
// Não inventar novos tipos aqui.

// ── Enums ─────────────────────────────────────────────────────────────────────

const DECISAO_ENUM = Object.freeze({
  AGIR_AGORA:      'AGIR_AGORA',
  PROGRAMAR_CICLO: 'PROGRAMAR_CICLO',
  NAO_AGIR:        'NAO_AGIR',
});

// Mapeamento obrigatório: decisao → acaoTiming estruturado esperado no output V2
const ACAO_TIMING_MAP = Object.freeze({
  AGIR_AGORA:      'AGORA',
  PROGRAMAR_CICLO: 'NO_CICLO',
  NAO_AGIR:        'NENHUMA',
});

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Calcula a decisão de ação comercial deterministicamente.
 *
 * @param {Object} ctx  — deve conter:
 *   tipoOportunidade    {string|null}
 *   recorrenciaStatus   {string|null}
 *   diasEntreComprasMediana {number|null}
 *   diasSemComprar      {number|null}
 *
 * @returns {{
 *   decisaoAcaoComercial: 'AGIR_AGORA'|'PROGRAMAR_CICLO'|'NAO_AGIR',
 *   diasAteProximoCiclo:  number|null,
 *   motivoDeterministico: string
 * }}
 */
function calcularDecisaoAcaoComercial(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('calcularDecisaoAcaoComercial: ctx deve ser objeto');
  }

  const {
    tipoOportunidade,
    recorrenciaStatus,
    diasEntreComprasMediana,
    diasSemComprar,
  } = ctx;

  // ── REGRA A: existe oportunidade determinística ───────────────────────────
  // tipoOportunidade != null inclui todos os tipos V1 habilitados
  // e PROSPECT_VINCULADO (que segue FILA_PROSPECCAO, não FILA_RECOMPRA).
  if (tipoOportunidade != null) {
    const fila = FILA_PROSPECCAO_TIPOS.includes(tipoOportunidade)
      ? 'FILA_PROSPECCAO'
      : 'FILA_RECOMPRA';

    return {
      decisaoAcaoComercial: DECISAO_ENUM.AGIR_AGORA,
      diasAteProximoCiclo:  null,
      motivoDeterministico: `REGRA_A:oportunidade=${tipoOportunidade}:fila=${fila}`,
    };
  }

  // A partir daqui: tipoOportunidade == null

  // ── REGRA B: sem oportunidade + cliente em ciclo normal ──────────────────
  // Requer: DENTRO_DO_PADRAO + mediana válida + diasSemComprar válido.
  // Score alto/baixo isolado não aciona esta regra.
  if (
    recorrenciaStatus === 'DENTRO_DO_PADRAO' &&
    diasEntreComprasMediana != null &&
    diasSemComprar != null
  ) {
    // Invariant: DENTRO_DO_PADRAO do pipeline real sempre implica diasSemComprar < mediana.
    // (recorrencia.js: limiteAlerta = round(mediana × 0.85) ≤ mediana; status = 'DENTRO_DO_PADRAO'
    //  somente quando diasSemComprar < limiteAlerta — logo diasSemComprar < mediana sempre.)
    // Se a entrada viola este invariant, é estado internamente inconsistente.
    // FAIL CLOSED: não criar oportunidade, não criar prioridade. NAO_AGIR conservador.
    if (diasSemComprar >= diasEntreComprasMediana) {
      return {
        decisaoAcaoComercial: DECISAO_ENUM.NAO_AGIR,
        diasAteProximoCiclo:  null,
        motivoDeterministico:
          `REGRA_C:ESTADO_RECORRENCIA_INCONSISTENTE:recorrencia=DENTRO_DO_PADRAO` +
          `:diasSemComprar=${diasSemComprar}:mediana=${diasEntreComprasMediana}`,
      };
    }

    // Estado válido: diasSemComprar < mediana garantido acima.
    // max(0, ...) preservado como barreira adicional para float edge cases.
    const diasAteProximoCiclo = Math.max(0, diasEntreComprasMediana - diasSemComprar);

    return {
      decisaoAcaoComercial: DECISAO_ENUM.PROGRAMAR_CICLO,
      diasAteProximoCiclo,
      motivoDeterministico:
        `REGRA_B:DENTRO_DO_PADRAO:mediana=${diasEntreComprasMediana}` +
        `:diasSemComprar=${diasSemComprar}:diasAteProximoCiclo=${diasAteProximoCiclo}`,
    };
  }

  // ── REGRA C: sem sinal determinístico suficiente ──────────────────────────
  // Cobre: SEM_BASE, mediana=null, recorrenciaStatus desconhecido,
  // PROXIMO_DA_JANELA sem oportunidade, NUNCA_COMPROU sem tipoOportunidade, etc.
  return {
    decisaoAcaoComercial: DECISAO_ENUM.NAO_AGIR,
    diasAteProximoCiclo:  null,
    motivoDeterministico:
      `REGRA_C:sem_oportunidade:recorrencia=${recorrenciaStatus ?? 'null'}` +
      `:mediana=${diasEntreComprasMediana ?? 'null'}`,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_DECISAO,
  DECISAO_ENUM,
  ACAO_TIMING_MAP,
  FILA_PROSPECCAO_TIPOS,
  TIPOS_RECOMPRA_V1,
  calcularDecisaoAcaoComercial,
};
