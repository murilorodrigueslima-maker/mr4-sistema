'use strict';

/**
 * Sistema de Trace — N12.
 *
 * Registra a cadeia de execução do pipeline do Agente Comercial IA.
 * Cada etapa do pipeline gera um span no trace.
 *
 * Permite reconstruir:
 *   - Quais dados foram usados em cada análise
 *   - Quais agentes foram executados
 *   - Em que ordem
 *   - Com qual resultado
 *   - Quanto tempo levou cada etapa
 *
 * NÃO persiste automaticamente (sem Firestore write).
 * Trace é passado para a camada de orquestração que decide se/como persiste.
 */

const VERSAO_TRACE = 'trace-v1';

class Trace {
  constructor(traceId = null) {
    this.traceId   = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.iniciadoEm = new Date().toISOString();
    this.spans     = [];
    this.finalizado = false;
  }

  /**
   * Inicia um span para uma etapa do pipeline.
   * @param {string} nome    — nome da etapa
   * @param {Object} entrada — dados de entrada (nunca dados pessoais completos)
   * @returns {Object}       — span (com .encerrar(saida) para finalizar)
   */
  iniciarSpan(nome, entrada = {}) {
    const spanId   = `${this.traceId}_${this.spans.length}`;
    const inicioMs = Date.now();

    const span = {
      spanId,
      nome,
      iniciadoEm: new Date().toISOString(),
      entrada:    entrada || {},
      saida:      null,
      erro:       null,
      latenciaMs: null,
      encerrado:  false,
    };

    this.spans.push(span);

    const encerrar = (saida = null, erro = null) => {
      span.saida     = saida;
      span.erro      = erro ? String(erro) : null;
      span.latenciaMs = Date.now() - inicioMs;
      span.encerrado = true;
    };

    return { span, encerrar };
  }

  /**
   * Finaliza o trace (marca como encerrado, calcula duração total).
   * @param {Object} resumo — resumo do resultado final do pipeline
   */
  finalizar(resumo = {}) {
    this.finalizadoEm   = new Date().toISOString();
    this.finalizado     = true;
    this.resumo         = resumo;
    this.duracaoTotalMs = this.spans.reduce((s, sp) => s + (sp.latenciaMs || 0), 0);
  }

  /** Retorna representação serializável do trace */
  serializar() {
    return {
      traceId:     this.traceId,
      versao:      VERSAO_TRACE,
      iniciadoEm:  this.iniciadoEm,
      finalizadoEm: this.finalizadoEm || null,
      finalizado:  this.finalizado,
      duracaoTotalMs: this.duracaoTotalMs || null,
      totalSpans:  this.spans.length,
      resumo:      this.resumo || null,
      spans:       this.spans,
    };
  }
}

/**
 * Cria um novo trace.
 * @param {string} [traceId] — opcional: ID externo para correlação
 */
function criarTrace(traceId = null) {
  return new Trace(traceId);
}

module.exports = {
  VERSAO_TRACE,
  Trace,
  criarTrace,
};
