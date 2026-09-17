# Arquitetura — Agente Comercial IA MR4

**Status:** Implementação local — ZERO deploy autorizado neste estágio.

---

## Fluxo de dados

```
GestãoClick (fonte de verdade)
  │
  ▼ sync incremental (2h) via sync-dados.js
vendas_gc  (mirror Firestore — histórico completo)
  │
  ▼ runIncremental / runBootstrap (sync360.js)
perfis_360 (Perfil Comercial 360 por cliente vinculado)
  │
  ├─▶ Motor de Score Comercial  (scoreComercial.js)
  │     ↳ scoreTotal, componentes, motivos, versão
  │
  ├─▶ Motor de Tendência        (tendenciaComercial.js)
  │     ↳ CRESCENDO | ESTAVEL | CAINDO | SEM_BASE | NUNCA_COMPROU
  │
  ├─▶ Motor de Recorrência      (recorrencia.js)
  │     ↳ DENTRO_DO_PADRAO | PROXIMO_DA_JANELA | ATRASADO_VS_HISTORICO | SEM_BASE
  │
  ▼ (todos os motores acima são determinísticos, sem LLM)
Motor de Oportunidades          (oportunidades.js)
  │ recebe: Perfil360 + Score + Tendência + Recorrência
  ▼
Oportunidades Estruturadas
  │ tipo, prioridade, evidências, métricas, datareferência, versão
  │
  ▼
Priorizador de Oportunidades    (priorizadorOportunidades.js)
  │ score de oportunidade ≠ score do cliente
  ▼
Oportunidades Priorizadas
  │
  ├─▶ Guardrails da IA          (ai/guardrails.js)
  │     ↳ valida campos lidos/explicados; bloqueia alterações
  │
  ▼ (somente leitura — NUNCA ação autônoma)
Agentes IA                      (ai/agents/)
  │
  ├─▶ AnalistaCliente           → contexto legível dos dados
  ├─▶ AnalistaOportunidade      → explica por que a oportunidade existe
  ├─▶ ExplicadorComercial       → resume histórico e sinais
  ├─▶ AssistenteVendedor        → sugere abordagem ao vendedor humano
  └─▶ AuditorIA                 → valida se resposta é fundamentada
  │
  ▼ (JSON estruturado validável — sem ações externas)
Trace System                    (ai/trace.js)
  │ inputs + outputs + evidências + metadados técnicos
  ▼
VENDEDOR HUMANO (decisão final)
  │
  ▼ (ação registrada quando aplicável)
Sistema de Atribuição           (atribuicao.js)
  │ opportunityId → saleId → attributionStatus
  ▼
ROI do Agente (futuro — PENDENTE implementação financeira)
```

---

## Princípios da arquitetura

### Dados antes de IA

Os motores determinísticos (Score, Tendência, Recorrência, Oportunidades) rodam **antes** de qualquer LLM. A IA recebe dados já calculados e pode apenas explicá-los. Nunca inverte a ordem.

### IA como amplificador, não como decisor

```
IA → sugere abordagem ao vendedor humano
IA → explica evidências
IA → NÃO envia mensagem
IA → NÃO altera preço/desconto/crédito/carteira
IA → NÃO cria pedido
```

### Separação score cliente × prioridade oportunidade

O `scoreComercial` mede o valor/saúde do cliente.
A `prioridade` da oportunidade mede a urgência/relevância da **ação**.
Esses dois valores são independentes e não podem ser mesclados.

### Atribuição não-causal por padrão

Uma venda posterior à apresentação de uma oportunidade **não é automaticamente** atribuída à IA. O sistema marca `COMPRA_POSTERIOR` e aguarda validação humana para promover para `ATRIBUIDA`.

---

## Camadas e responsabilidades

| Camada | Arquivo | Responsabilidade |
|--------|---------|------------------|
| Dados brutos | `vendas_gc` (Firestore) | Mirror do histórico GC |
| Perfil determinístico | `perfil360.js` | Cálculo puro, sem I/O |
| Orquestração sync | `sync360.js` | Bootstrap + incremental |
| Score | `scoreComercial.js` | Pontuação explicável |
| Tendência | `tendenciaComercial.js` | Classificação de trajetória |
| Recorrência | `recorrencia.js` | Padrão de recompra |
| Oportunidades | `oportunidades.js` | Geração de oportunidades estruturadas |
| Prioridade | `priorizadorOportunidades.js` | Ordenação de oportunidades |
| Guardrails | `ai/guardrails.js` | Validação de I/O da IA |
| Agentes | `ai/agents/*.js` | Responsabilidades lógicas de IA |
| Provider | `ai/provider.js` | Abstração de LLM |
| Prompts | `ai/prompts/*.js` | Prompts versionados |
| Trace | `ai/trace.js` | Auditoria de execuções |
| Simulador | `scripts/simular-agente-comercial.js` | Teste E2E local |

---

## O que NÃO está na arquitetura

- **Chamadas externas autônomas** — o agente não envia WhatsApp, e-mail ou qualquer mensagem
- **Alteração de GestãoClick** — zero writes no sistema de vendas
- **Acesso a crédito/margem/preço** — dados que a IA não tem permissão de ver
- **Deploy automático** — toda ativação em produção é manual e deliberada

---

## Decisões humanas pendentes

Ver [PENDENCIAS.md](PENDENCIAS.md) para a lista completa.
