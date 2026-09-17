'use strict';

/**
 * Interface para Provider Real de LLM — N25 (stub).
 *
 * DECISÃO PENDENTE: qual provider ativar (OpenAI / Anthropic / Gemini / outro).
 * NÃO instalar SDK, NÃO configurar API key, NÃO chamar API externa.
 * Este arquivo define APENAS o contrato que qualquer provider real deve implementar.
 *
 * Quando o provider real for decidido, criar:
 *   providers/openaiProvider.js  (ou anthropicProvider.js, etc.)
 * que implemente esta interface e registre-o em provider.js.
 *
 * CONTRATO:
 *   provider.complete(prompt, opcoes) → Promise<{ texto, tokens, modelo, latenciaMs }>
 *
 * RESTRIÇÕES DO PROVIDER (não negociáveis):
 *   - NÃO pode acessar Firestore diretamente
 *   - NÃO pode acessar GestãoClick diretamente
 *   - NÃO pode acessar Auth diretamente
 *   - NÃO pode enviar WhatsApp, e-mail ou mensagem
 *   - Recebe APENAS o payload preparado pelo servicoAgenteComercial
 *   - Retorna APENAS texto + metadados de uso (tokens, latência, modelo)
 *
 * CHECKLIST DE ATIVAÇÃO (ver AI_ACTIVATION_CHECKLIST.md):
 *   [ ] Decisão empresarial sobre provider (modelo, custo, latência)
 *   [ ] Orçamento de tokens aprovado
 *   [ ] API key criada e registrada no Secret Manager
 *   [ ] Testes de integração com MockProvider substituídos por testes reais
 *   [ ] Adversarial matrix revalidada com LLM real
 *   [ ] Shadow Mode ativo por período mínimo antes de exibir ao vendedor
 */

// ── Interface esperada ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProviderOptions
 * @property {string} [chave]      — chave de identificação do prompt (para cache/trace)
 * @property {string} [modelo]     — nome/alias do modelo
 * @property {number} [maxTokens]  — limite de tokens de saída
 * @property {number} [temperature] — temperatura (0 = determinístico)
 */

/**
 * @typedef {Object} ProviderResult
 * @property {string} texto       — texto gerado pelo modelo
 * @property {Object} tokens      — { input: number, output: number }
 * @property {string} modelo      — modelo que gerou a resposta
 * @property {number} latenciaMs  — latência em milissegundos
 * @property {boolean} [mock]     — true se for MockProvider
 */

/**
 * Valida se um objeto implementa a interface de provider.
 * Lança erro se a interface não for satisfeita.
 *
 * @param {Object} provider — instância a verificar
 */
function verificarInterfaceProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('verificarInterfaceProvider: provider deve ser objeto');
  }
  if (typeof provider.complete !== 'function') {
    throw new Error('verificarInterfaceProvider: provider.complete(prompt, opcoes) é obrigatório');
  }
  if (!provider.nome || typeof provider.nome !== 'string') {
    throw new Error('verificarInterfaceProvider: provider.nome (string) é obrigatório');
  }
}

module.exports = { verificarInterfaceProvider };
