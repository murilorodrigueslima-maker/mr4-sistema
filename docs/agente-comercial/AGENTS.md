# Agentes IA Comerciais

**Diretório:** `functions/lib/ai/agents/`  
**Status:** MockProvider apenas (sem LLM real, sem custo)

## Agentes Disponíveis

### analistaCliente.js

**Função:** `analisar({ perfil, score, tendencia, recorrencia, oportunidades, provider })`  
**Output tipo:** `ANALISE`  
**Responsabilidade:** Análise estruturada do cliente para o vendedor humano.

### explicadorComercial.js

**Função:** `explicarScore({ score, provider })`  
**Output tipo:** `EXPLICACAO`  
**Responsabilidade:** Explicação do Score Comercial em linguagem simples.

### auditorIA.js

**Função:** `auditarOutputs(outputs[])`  
**Output:** Relatório de conformidade  
**Responsabilidade:** Verifica conformidade dos outputs de outros agentes; detecta violações.

## Pipeline Integrado

`servicoAgenteComercial.js` → `executarPipelineComercial(perfil, opcoes)`  
Orquestra todos os motores e agentes em sequência com trace completo.

## MockProvider

```js
const { criarProvider } = require('./provider');
const provider = criarProvider('mock');  // zero custo, zero LLM real
```

Respostas personalizadas injetáveis via construtor:
```js
const provider = criarProvider('mock', { respostas: { ANALISE_CLIENTE: 'minha resposta' } });
```

## Prompts Versionados

| Prompt | Versão | Chave Mock |
|--------|--------|-----------|
| `prompts/analiseCliente.js` | 1.0.0 | `ANALISE_CLIENTE` |
| `prompts/explicadorScore.js` | 1.0.0 | `EXPLICACAO_SCORE` |

Cada prompt tem `build(contexto)` determinístico e `SCHEMA_CONTEXTO` validado.

## Decisões Pendentes

Ver PENDENCIAS.md: I1 (modelo LLM), I2 (orçamento de tokens), I3 (latência), I4 (fallback).
