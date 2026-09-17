# Guardrails da IA Comercial

**Arquivo:** `functions/lib/ai/guardrails.js`  
**Versão:** `guardrails-v1`

## Permissões

| Permissão | Descrição |
|-----------|-----------|
| `PODE_LER` | Lê dados do Perfil360, score, tendência, recorrência, oportunidades |
| `PODE_EXPLICAR` | Explica análises em linguagem natural para o vendedor |
| `NÃO_PODE_ALTERAR` | Não cria/altera vendas, preços, pedidos, descontos, crédito, limite |
| `NÃO_PODE_INVENTAR` | Não inventa dados não presentes no perfil |
| `NÃO_PODE_CONTATAR` | Não envia WhatsApp, email ou qualquer mensagem |
| `NÃO_PODE_DECIDIR` | Não toma decisões comerciais autonomamente |

## Marcadores Proibidos em Outputs

Qualquer output contendo os seguintes termos é **rejeitado automaticamente**:

`CRIAR_PEDIDO`, `ALTERAR_PRECO`, `CONCEDER_DESCONTO`, `ALTERAR_LIMITE`,
`ENVIAR_MENSAGEM`, `ENVIAR_WHATSAPP`, `ENVIAR_EMAIL`, `ALTERAR_VENDA`,
`DELETAR_VENDA`, `ACTION:`, `EXECUTE:`, `WRITE:`

A verificação é **case-insensitive**.

## Tipos de Output Permitidos

`ANALISE`, `EXPLICACAO`, `SUGESTAO`, `ALERTA`, `RESUMO`

## Limites

- Conteúdo máximo: 4.000 caracteres

## Detecção de Jailbreak em Inputs

A função `verificarInputSeguro(texto)` detecta padrões como:
- "IGNORE AS INSTRUÇÕES"
- "SYSTEM PROMPT"
- "PRETEND YOU ARE"
- "FORGET YOUR RULES"
- "JAILBREAK"
- "DAN MODE"

## Validação de Schema (N11)

`validarSchema(output)` complementa os guardrails verificando estrutura:
- Campos obrigatórios presentes
- Tipos de dados corretos
- `_guardrails.violacoes = []`

## Auditoria

Todo output validado carrega `_guardrails`:
```json
{
  "validadoEm": "...",
  "versao": "guardrails-v1",
  "agente": "analistaCliente",
  "violacoes": []
}
```
