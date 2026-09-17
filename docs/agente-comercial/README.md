# Agente Comercial IA — MR4 Distribuidora

Sistema de apoio comercial baseado em análise estruturada do comportamento de compra de clientes.

## Status

**MODO ATUAL:** OFFLINE / DRY-RUN / MOCK  
**LLM real:** NÃO habilitado (MockProvider apenas)  
**Writes em Firestore:** ZERO  
**Pesos e thresholds:** PROVISIONAL — ver [PENDENCIAS.md](PENDENCIAS.md)

---

## O que o sistema faz

1. **Calcula** Score Comercial, Tendência e Recorrência a partir do Perfil360 de cada cliente
2. **Identifica** oportunidades estruturadas (REATIVACAO_120D, QUEDA_DE_COMPRAS, etc.)
3. **Prioriza** oportunidades por urgência e contexto do cliente
4. **Gera** análise em linguagem natural via agente IA (Mock)
5. **Audita** todos os outputs antes de disponibilizá-los ao vendedor
6. **Rastreia** cada etapa via trace com spans

O sistema **nunca decide**: o vendedor humano é sempre o decisor.

---

## Arquitetura de camadas

```
GestãoClick → vendas_gc → perfis_360 (Firestore mirror)
                              │
                    Motores determinísticos
                    ┌──────────────────────┐
                    │ scoreComercial.js    │
                    │ tendenciaComercial.js│
                    │ recorrencia.js       │
                    │ oportunidades.js     │
                    │ priorizadorOport.js  │
                    └──────────────────────┘
                              │
                    Camada de IA (MockProvider)
                    ┌──────────────────────┐
                    │ guardrails.js        │
                    │ agents/analista...   │
                    │ agents/explicador... │
                    │ agents/auditorIA.js  │
                    │ validatorOutput.js   │
                    │ trace.js             │
                    └──────────────────────┘
                              │
                    servicoAgenteComercial.js
                    (interface pública)
                              │
                        Vendedor Humano
```

---

## Arquivos principais

| Arquivo | Responsabilidade |
|---------|-----------------|
| `functions/lib/scoreComercial.js` | Score 0-100 por 6 componentes |
| `functions/lib/tendenciaComercial.js` | CRESCENDO/ESTAVEL/CAINDO/SEM_BASE |
| `functions/lib/recorrencia.js` | Padrão histórico de recompra |
| `functions/lib/oportunidades.js` | Geração de oportunidades estruturadas |
| `functions/lib/priorizadorOportunidades.js` | Ranqueamento por urgência |
| `functions/lib/ai/guardrails.js` | Segurança dos outputs de IA |
| `functions/lib/ai/provider.js` | MockProvider (sem LLM real) |
| `functions/lib/ai/trace.js` | Rastreabilidade por spans |
| `functions/lib/ai/validatorOutput.js` | Validação de schema |
| `functions/lib/ai/atribuicao.js` | Registro de atribuição (correlação, não causalidade) |
| `functions/lib/ai/servicoAgenteComercial.js` | Pipeline orquestrado |
| `functions/config/score-comercial.v1.js` | Configuração versionada dos pesos |
| `scripts/simular-agente-comercial.js` | Simulação com 10 cenários (DRY-RUN) |

---

## Como executar a simulação

```bash
node scripts/simular-agente-comercial.js
```

Roda 10 cenários sintéticos offline. Zero escrita, zero custo.

---

## Contratos e docs complementares

- [PERFIL360_CONTRACT.md](PERFIL360_CONTRACT.md) — schema e invariantes do Perfil360
- [ARCHITECTURE.md](ARCHITECTURE.md) — fluxo de dados e princípios
- [SCORE.md](SCORE.md) — detalhes do motor de score
- [OPORTUNIDADES.md](OPORTUNIDADES.md) — tipos e critérios de oportunidades
- [AI_GUARDRAILS.md](AI_GUARDRAILS.md) — regras da IA
- [AGENTS.md](AGENTS.md) — agentes disponíveis
- [PENDENCIAS.md](PENDENCIAS.md) — decisões pendentes (pesos, thresholds, provider)
