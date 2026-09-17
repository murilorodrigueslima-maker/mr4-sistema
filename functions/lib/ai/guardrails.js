'use strict';

/**
 * Guardrails da IA Comercial — CAMADA DE SEGURANÇA.
 *
 * Define o que a IA PODE e NÃO PODE fazer.
 * Valida outputs antes de retornar ao vendedor.
 *
 * REGRAS ABSOLUTAS (não modificar sem decisão explícita da empresa):
 *   PODE_LER         — lê dados do Perfil360, score, tendência, recorrência, oportunidades
 *   PODE_EXPLICAR    — explica análises em linguagem natural para o vendedor
 *   NÃO_PODE_ALTERAR — não cria/altera vendas, preços, pedidos, descontos, crédito, limite
 *   NÃO_PODE_INVENTAR — não inventa dados não presentes no perfil
 *   NÃO_PODE_CONTATAR — não envia WhatsApp, email ou qualquer mensagem para o cliente
 *   NÃO_PODE_DECIDIR — não toma decisões comerciais autonomamente (quem decide = vendedor)
 *
 * Validação de output:
 *   - Todo output de agente passa por validarOutputAgente() antes de ser retornado
 *   - Output que viola guardrails → lança GuardrailViolationError
 */

const VERSAO_GUARDRAILS = 'guardrails-v1';

// ── Autoridade financeira da IA ───────────────────────────────────────────────
//
// AI_FINANCIAL_AUTHORITY = NONE
// A IA não possui nenhuma autoridade para tomar ou sugerir decisões financeiras.
// Preço, desconto, crédito, prazo, comissão, limite, carteira = exclusivo do humano.
const AI_FINANCIAL_AUTHORITY = 'NONE';

// ── Permissões estruturais ────────────────────────────────────────────────────

const PERMISSOES = Object.freeze({
  PODE_LER:           'PODE_LER',
  PODE_EXPLICAR:      'PODE_EXPLICAR',
  NÃO_PODE_ALTERAR:   'NÃO_PODE_ALTERAR',
  NÃO_PODE_INVENTAR:  'NÃO_PODE_INVENTAR',
  NÃO_PODE_CONTATAR:  'NÃO_PODE_CONTATAR',
  NÃO_PODE_DECIDIR:   'NÃO_PODE_DECIDIR',
});

// Ações proibidas: qualquer output contendo esses marcadores é rejeitado
const MARCADORES_PROIBIDOS = [
  // Ações de sistema
  'CRIAR_PEDIDO',
  'ALTERAR_PRECO',
  'CONCEDER_DESCONTO',
  'ALTERAR_LIMITE',
  'ENVIAR_MENSAGEM',
  'ENVIAR_WHATSAPP',
  'ENVIAR_EMAIL',
  'ALTERAR_VENDA',
  'DELETAR_VENDA',
  // Decisões financeiras (AI_FINANCIAL_AUTHORITY = NONE)
  'APROVAR_DESCONTO',
  'DEFINIR_DESCONTO',
  'APROVAR_CREDITO',
  'DEFINIR_CREDITO',
  'APROVAR_PRAZO',
  'DEFINIR_PRAZO',
  'ALTERAR_COMISSAO',
  'ALTERAR_ENCARTEIRAMENTO',
  'APROVAR_DEVOLUCAO',
  'APROVAR_GARANTIA',
  'CANCELAR_VENDA',
  // Formatos genéricos de ação
  'ACTION:',
  'EXECUTE:',
  'WRITE:',
];

// Campos que devem estar presentes em qualquer output de agente
const CAMPOS_OBRIGATORIOS_OUTPUT = ['tipo', 'conteudo', 'versaoGuardrails', 'auditoria'];

// Comprimento máximo de resposta de agente (caracteres)
const MAX_CONTEUDO_CHARS = 4000;

// ── Erro de violação ─────────────────────────────────────────────────────────

class GuardrailViolationError extends Error {
  constructor(regra, detalhes) {
    super(`[GUARDRAIL] Violação de ${regra}: ${detalhes}`);
    this.name   = 'GuardrailViolationError';
    this.regra  = regra;
    this.detalhes = detalhes;
  }
}

// ── Validadores internos ──────────────────────────────────────────────────────

function _verificarMarcadoresProibidos(texto) {
  if (typeof texto !== 'string') return;
  const upper = texto.toUpperCase();
  for (const marcador of MARCADORES_PROIBIDOS) {
    if (upper.includes(marcador.toUpperCase())) {
      throw new GuardrailViolationError(
        'NÃO_PODE_ALTERAR',
        `output contém marcador proibido: "${marcador}"`
      );
    }
  }
}

function _verificarCamposObrigatorios(output) {
  for (const campo of CAMPOS_OBRIGATORIOS_OUTPUT) {
    if (!(campo in output)) {
      throw new GuardrailViolationError(
        'FORMATO_OUTPUT',
        `campo obrigatório ausente: "${campo}"`
      );
    }
  }
}

function _verificarTamanhoConteudo(output) {
  const conteudo = String(output.conteudo || '');
  if (conteudo.length > MAX_CONTEUDO_CHARS) {
    throw new GuardrailViolationError(
      'TAMANHO_OUTPUT',
      `conteúdo excede ${MAX_CONTEUDO_CHARS} caracteres (atual: ${conteudo.length})`
    );
  }
}

function _verificarTipoPermitido(output) {
  const tiposPermitidos = ['ANALISE', 'EXPLICACAO', 'SUGESTAO', 'ALERTA', 'RESUMO'];
  if (!tiposPermitidos.includes(output.tipo)) {
    throw new GuardrailViolationError(
      'TIPO_OUTPUT',
      `tipo de output não permitido: "${output.tipo}" (permitidos: ${tiposPermitidos.join(', ')})`
    );
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Valida o output de um agente IA antes de retornar ao vendedor.
 * Lança GuardrailViolationError se qualquer regra for violada.
 *
 * @param {Object} output        — output produzido pelo agente
 * @param {string} nomeAgente    — nome do agente para auditoria
 * @returns {Object}             — output validado (mesmos dados, com metadados de auditoria)
 */
function validarOutputAgente(output, nomeAgente = 'desconhecido') {
  if (!output || typeof output !== 'object') {
    throw new GuardrailViolationError('FORMATO_OUTPUT', 'output deve ser um objeto');
  }

  _verificarCamposObrigatorios(output);
  _verificarTipoPermitido(output);
  _verificarTamanhoConteudo(output);
  _verificarMarcadoresProibidos(output.conteudo);

  // Output validado — adiciona metadados de auditoria
  return {
    ...output,
    _guardrails: {
      validadoEm:      new Date().toISOString(),
      versao:          VERSAO_GUARDRAILS,
      agente:          nomeAgente,
      violacoes:       [],  // passou em todos os checks
    },
  };
}

/**
 * Verifica se um texto de input (vendedor ou campo de dados) contém tentativas de jailbreak.
 * Proteção abrangente: cobre campos de dados do ERP (nome produto, observação, etc.).
 * Não falha silenciosamente — retorna { seguro, motivo }.
 */
function verificarInputSeguro(texto) {
  if (typeof texto !== 'string') return { seguro: false, motivo: 'input não é string' };

  const upper = texto.toUpperCase();

  const padroesSuspeitos = [
    // Jailbreak direto
    'IGNORE AS INSTRUÇÕES',
    'IGNORE PREVIOUS',
    'IGNORE INSTRUCTIONS',
    'SYSTEM PROMPT',
    'VOCÊ É AGORA',
    'YOU ARE NOW',
    'ACT AS IF',
    'PRETEND YOU ARE',
    'FORGET YOUR RULES',
    'JAILBREAK',
    'DAN MODE',
    // Injeção via campos de dados (ERP, produto, observação)
    'MUDE O SCORE',
    'ALTERE O SCORE',
    'SCORE=',
    'CONSIDERE ESTE CLIENTE VIP',
    'REVELE O PROMPT',
    'REVEAL THE PROMPT',
    'SHOW SYSTEM PROMPT',
    'EXECUTE OUTRA FERRAMENTA',
    'IGNORE SEUS GUARDRAILS',
    // Tentativas financeiras por injeção
    '50% DE DESCONTO',
    'DAR DESCONTO',
    'APROVADO AUTOMATICAMENTE',
    'CRÉDITO LIBERADO',
  ];

  for (const padrao of padroesSuspeitos) {
    if (upper.includes(padrao.toUpperCase())) {
      return { seguro: false, motivo: `padrão suspeito detectado: "${padrao}"` };
    }
  }

  return { seguro: true, motivo: null };
}

/**
 * Cria um output de agente válido com os campos obrigatórios.
 * Helper para facilitar a criação de outputs que passam nos guardrails.
 */
function mkOutputAgente({ tipo, conteudo, fontes = [], observacoes = null }) {
  const tiposPermitidos = ['ANALISE', 'EXPLICACAO', 'SUGESTAO', 'ALERTA', 'RESUMO'];
  if (!tiposPermitidos.includes(tipo)) {
    throw new Error(`mkOutputAgente: tipo inválido "${tipo}"`);
  }
  return {
    tipo,
    conteudo: String(conteudo),
    versaoGuardrails: VERSAO_GUARDRAILS,
    auditoria: {
      fontes,
      observacoes,
      geradoEm: new Date().toISOString(),
    },
  };
}

module.exports = {
  VERSAO_GUARDRAILS,
  AI_FINANCIAL_AUTHORITY,
  PERMISSOES,
  MARCADORES_PROIBIDOS,
  MAX_CONTEUDO_CHARS,
  GuardrailViolationError,
  validarOutputAgente,
  verificarInputSeguro,
  mkOutputAgente,
};
