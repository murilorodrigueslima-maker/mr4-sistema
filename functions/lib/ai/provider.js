'use strict';

/**
 * Provider de LLM para o Agente Comercial IA.
 *
 * MODO ATUAL: APENAS MockProvider.
 * Nenhuma chamada real a LLM, nenhuma chave de API, nenhum custo.
 *
 * Decisão pendente:
 *   - Qual modelo usar em produção (ver PENDENCIAS.md I1)
 *   - Orçamento de tokens (ver PENDENCIAS.md I2)
 *   - Latência aceitável (ver PENDENCIAS.md I3)
 *   - Fallback/retry strategy (ver PENDENCIAS.md I4)
 *
 * Interface do provider:
 *   provider.complete(prompt, opcoes) → Promise<{ texto, tokens, modelo, latenciaMs }>
 *
 * MockProvider:
 *   - Retorna respostas pré-definidas por tipo de prompt
 *   - Determinístico: mesma chave de prompt = mesma resposta
 *   - Não faz chamadas externas, não lê variáveis de ambiente
 *   - Sinaliza explicitamente que é MOCK em cada resposta
 */

const VERSAO_PROVIDER = 'provider-v1';

// ── MockProvider ──────────────────────────────────────────────────────────────

class MockProvider {
  constructor(respostas = {}) {
    this.nome = 'MockProvider';
    this._respostas = {
      // Respostas padrão por chave de prompt
      'ANALISE_CLIENTE':    'MOCK: análise do cliente baseada no Perfil360 e score.',
      'EXPLICACAO_SCORE':   'MOCK: o score reflete a frequência e recência das compras.',
      'SUGESTAO_ACAO':      'MOCK: cliente apresenta padrão histórico que indica oportunidade de recompra.',
      'ALERTA_INATIVIDADE': 'MOCK: cliente sem compras por período acima do padrão histórico.',
      'RESUMO_OPORTUNIDADES': 'MOCK: resumo das oportunidades identificadas para este cliente.',
      'DEFAULT':            'MOCK: resposta genérica do MockProvider.',
      ...respostas,
    };
    this._chamadas = [];  // auditoria de chamadas
  }

  /**
   * Simula uma chamada de LLM.
   * @param {string} prompt    — texto do prompt
   * @param {Object} opcoes    — { chave: string, modelo: string, maxTokens: number }
   * @returns {Promise<Object>} — { texto, tokens, modelo, latenciaMs, mock: true }
   */
  async complete(prompt, opcoes = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('MockProvider.complete: prompt inválido ou vazio');
    }

    const chave = opcoes.chave || 'DEFAULT';
    const texto = this._respostas[chave] || this._respostas['DEFAULT'];

    const resultado = {
      texto,
      tokens:      { input: Math.ceil(prompt.length / 4), output: Math.ceil(texto.length / 4) },
      modelo:      opcoes.modelo || 'mock-model',
      latenciaMs:  0,
      mock:        true,
      chaveUsada:  chave,
    };

    this._chamadas.push({ prompt: prompt.slice(0, 100), opcoes, resultado, em: new Date().toISOString() });
    return resultado;
  }

  /** Retorna histórico de chamadas para auditoria em testes */
  getChamadas() {
    return [...this._chamadas];
  }

  /** Reseta histórico de chamadas */
  resetar() {
    this._chamadas = [];
  }
}

// ── Factory de provider ───────────────────────────────────────────────────────

/**
 * Cria um provider de LLM.
 * @param {string} tipo    — 'mock' (único suportado atualmente)
 * @param {Object} opcoes  — opções do provider
 */
function criarProvider(tipo = 'mock', opcoes = {}) {
  if (tipo === 'mock') {
    return new MockProvider(opcoes.respostas || {});
  }
  // Tipos reais serão implementados após decisão empresarial (PENDENCIAS.md I1)
  throw new Error(
    `criarProvider: tipo "${tipo}" não suportado. ` +
    `Apenas "mock" disponível até decisão sobre provedor de produção (PENDENCIAS.md I1).`
  );
}

module.exports = {
  VERSAO_PROVIDER,
  MockProvider,
  criarProvider,
};
