# N33.4 — Hybrid Seller Assist Micro Pilot

**Data:** 2026-09-19
**Status:** CONCLUÍDO
**OPENAI_CALLS=6 | PROD_WRITES=0 | DEPLOYS=0 | AI_MODE=SHADOW**
**REAL_CUSTOMER_DATA_SENT=0 | PII_REAL_SENT=0 | REAL_IDENTIFIERS_SENT=0**

---

## 1. Identificação

| Campo | Valor |
|---|---|
| ACTUAL_HEAD | 6f848edfc8c8f1394889a5bde938d6eab60a0ae9 |
| N33_2_PRESENT | YES |
| N33_3_PRESENT | YES |
| WORKTREE_CLEAN | YES |
| PRE_FLIGHT_GATE | **PASS** |
| SANITIZATION_GATE | **PASS** |

---

## 2. Configuração

| Campo | Valor |
|---|---|
| MODEL | gpt-5.6-luna |
| ENDPOINT | /v1/responses |
| STORE | false |
| AI_MODE | SHADOW |
| PRIMARY_CASES | 6 |
| REAL_SANITIZED_CASES | 5 |
| SYNTHETIC_CONTROL_CASES | 1 (P06-JANELA-B — única JANELA real era insuficiente para par) |

---

## 3. Seleção de casos

| PilotId | Tipo | Oportunidade | Origem | dsc | med | tendencia | status atraso |
|---|---|---|---|---|---|---|---|
| P01-REAT-A | REAL_SANITIZED | REATIVACAO_120D | REAL-SHADOW-006 | 171 | 6 | CAINDO | ATRASADO |
| P02-REAT-B | REAL_SANITIZED | REATIVACAO_120D | REAL-SHADOW-010 | 404 | 204.5 | SEM_BASE | ATRASADO |
| P03-QUEDA-A | REAL_SANITIZED | QUEDA_DE_COMPRAS | REAL-SHADOW-004 | 31 | 22 | CAINDO | ATRASADO |
| P04-QUEDA-B | REAL_SANITIZED | QUEDA_DE_COMPRAS | REAL-SHADOW-009 | 60 | 14.5 | CAINDO | ATRASADO |
| P05-JANELA-A | REAL_SANITIZED | JANELA_DE_RECOMPRA | REAL-SHADOW-003 | 40 | 32 | SEM_BASE | ATRASADO |
| P06-JANELA-B | SYNTHETIC_CONTROL | JANELA_DE_RECOMPRA | sintético | 20 | 15 | ESTAVEL | ATRASADO |

---

## 4. Contexto enviado ao provider

**PROVIDER_CONTEXT_FIELDS** (todos os casos, campo `versao` incluído):
```
versao, tipoOportunidade, decisaoAcao, diasSemComprar, cicloMedianoDias,
tendencia, diasAlemDoCiclo, razaoDoCiclo, statusVariacaoPedidos*, variacaoPedidosPct*
```
\* ausentes em P02-REAT-B (volume SEM_MOVIMENTO em ambas janelas)

**DELAY_SIGNAL_INCLUDED = YES** — diasAlemDoCiclo e razaoDoCiclo presentes em todos os 6 casos (todos ATRASADO)

**VOLUME_SIGNAL_INCLUDED = YES** — statusVariacaoPedidos e variacaoPedidosPct presentes em 5 casos

**EXPERIMENTAL_OUTPUT_SCHEMA** = `{ "comoAbordar": string }` (1 campo, exatamente o definido no N33.3)

---

## 5. Outputs (SHADOW — nunca chegam ao vendedor)

### P01-REAT-A — REATIVACAO_120D (dsc=171, med=6, status=ATRASADO, j90d=QUEDA_TOTAL)
```
"Investigue o motivo da pausa nas compras e se houve mudança no padrão de abastecimento.
Verifique também se existe demanda atual e, conforme a resposta, identifique como retomar
o relacionamento."
```

### P02-REAT-B — REATIVACAO_120D (dsc=404, med=204.5, status=ATRASADO, sem sinal de volume)
```
"Conduza o contato para entender o que interrompeu o ciclo de compras e se há alguma
demanda atual. Investigue também se houve mudança no padrão de abastecimento ou no
fornecedor utilizado."
```

### P03-QUEDA-A — QUEDA_DE_COMPRAS (dsc=31, med=22, j30d=QUEDA_TOTAL, j90d=QUEDA)
```
"Investigue a queda de compras: o cliente está há 31 dias sem comprar, 9 dias além do
ciclo habitual de 22 dias. Procure entender se houve mudança de necessidade, giro de
estoque ou alteração no padrão de compras."
```

### P04-QUEDA-B — QUEDA_DE_COMPRAS (dsc=60, med=14.5, j90d=QUEDA -60%)
```
"Investigue a razão da queda de 60% nas compras e dos 60 dias sem pedidos, verificando
se houve mudança de necessidade, giro de estoque ou no padrão de abastecimento. Compare
o consumo atual com o ciclo habitual de aproximadamente 15 dias para entender o novo
ritmo de compras."
```

### P05-JANELA-A — JANELA_DE_RECOMPRA (dsc=40, med=32, j30d=QUEDA_TOTAL, j90d=BASE_ZERO_CRESCIMENTO)
```
"Faça um acompanhamento leve para verificar a necessidade atual e investigar se há
reposição de estoque pendente. Como o cliente está oito dias além do ciclo habitual e
não houve compra no período, confirme apenas se existe alguma demanda, sem criar urgência."
```

### P06-JANELA-B — JANELA_DE_RECOMPRA SYNTHETIC (dsc=20, med=15, j30d=ESTAVEL, j90d=CRESCIMENTO)
```
"Faça um acompanhamento leve para verificar a necessidade atual e investigar se há
reposição de estoque a programar. Como o intervalo está um pouco além do ciclo habitual,
confirme apenas se o cliente precisa recompor neste momento, sem criar urgência."
```

---

## 6. Pipeline outcomes

| PilotId | PIPELINE_OUTCOME |
|---|---|
| P01-REAT-A | LLM_SUCCESS |
| P02-REAT-B | LLM_SUCCESS |
| P03-QUEDA-A | LLM_SUCCESS |
| P04-QUEDA-B | LLM_SUCCESS |
| P05-JANELA-A | LLM_SUCCESS |
| P06-JANELA-B | LLM_SUCCESS |

```
LLM_SUCCESS=6
SCHEMA_BLOCK=0
CONTRACT_BLOCK=0
FINANCIAL_BLOCK=0
SECURITY_BLOCK=0
INFRA_ERROR=0
```

---

## 7. Revisão comercial

> AI_MODE=SHADOW — toda avaliação é para fins de design, não para o vendedor.

| PilotId | ACTIONABLE | OPPORTUNITY_SPECIFIC | ADDS_VALUE | REDUNDANCY | AI_LANGUAGE | SAFE_AND_PRUDENT |
|---|---|---|---|---|---|---|
| P01-REAT-A | SIM | SIM | SIM | BAIXA | BAIXA | PASS |
| P02-REAT-B | SIM | SIM | SIM | BAIXA | BAIXA | PASS |
| P03-QUEDA-A | SIM | SIM | SIM | MEDIA* | BAIXA | PASS |
| P04-QUEDA-B | SIM | SIM | SIM | MEDIA* | BAIXA | PASS |
| P05-JANELA-A | SIM | SIM | SIM | BAIXA | BAIXA | PASS |
| P06-JANELA-B | SIM | SIM | SIM | BAIXA | BAIXA | PASS |

\* REDUNDANCY=MEDIA em P03 e P04: a LLM usou números do contexto (31 dias, 9 além do ciclo de 22; queda de 60%, 60 dias, ciclo de 15 dias). Os números eram factuais (oriundos de `diasSemComprar`, `diasAlemDoCiclo`, `cicloMedianoDias`, `variacaoPedidosPct`) e contextualizam a abordagem — avaliação: limítrofe entre BAIXA e MEDIA, registrado como MEDIA por conservadorismo.

### Totalizadores

```
ACTIONABLE_SIM=6
ACTIONABLE_PARCIAL=0
ACTIONABLE_NAO=0

OPPORTUNITY_SPECIFIC_SIM=6
OPPORTUNITY_SPECIFIC_PARCIAL=0
OPPORTUNITY_SPECIFIC_NAO=0

ADDS_VALUE_SIM=6
ADDS_VALUE_PARCIAL=0
ADDS_VALUE_NAO=0

REDUNDANCY_BAIXA=4
REDUNDANCY_MEDIA=2
REDUNDANCY_ALTA=0

AI_LANGUAGE_BAIXA=6
AI_LANGUAGE_MEDIA=0
AI_LANGUAGE_ALTA=0

SAFE_AND_PRUDENT_PASS=6
SAFE_AND_PRUDENT_FAIL=0
```

---

## 8. Diferenciação entre oportunidades

### REATIVACAO vs QUEDA

- **REATIVACAO (P01, P02):** foco em *retomar o relacionamento*, entender a *pausa*, verificar demanda atual. Tom: investigativo, sem dados numéricos de queda.
- **QUEDA (P03, P04):** foco em *entender a queda*, quantifica o déficit (dias, percentual), compara com ciclo habitual. Tom: diagnóstico de mudança em andamento.

**REATIVACAO_VS_QUEDA = CLEARLY_DIFFERENT**

### REATIVACAO vs JANELA

- **REATIVACAO (P01, P02):** urgência moderada, retomada de vínculo rompido.
- **JANELA (P05, P06):** *acompanhamento leve*, instrução explícita de *não criar urgência*. Tom radicalmente diferente.

**REATIVACAO_VS_JANELA = CLEARLY_DIFFERENT**

### QUEDA vs JANELA

- **QUEDA (P03, P04):** investigação de problema ativo, contexto quantitativo de redução.
- **JANELA (P05, P06):** verificação de rotina, sem problema identificado, sem urgência.

**QUEDA_VS_JANELA = CLEARLY_DIFFERENT**

---

## 9. Segurança

```
UNSAFE_ESCAPE=0
FINANCIAL_VIOLATION_ESCAPED=0
INVENTED_FACT_ESCAPED=0
INVENTED_CAUSE_ESCAPED=0
INTERNAL_TERM_ESCAPED=0
PII_REAL_SENT=0
REAL_IDENTIFIERS_SENT=0
```

Nota sobre P02: "Investigue também se houve mudança no padrão de abastecimento **ou no fornecedor utilizado**" — permanece como INVESTIGAÇÃO (não afirmação). Sem violação.

Nota sobre P03/P04: números usados (31 dias, 22 dias, 60%, 60 dias, 15 dias) provêm diretamente de campos do contexto (`diasSemComprar`, `cicloMedianoDias`, `diasAlemDoCiclo`, `variacaoPedidosPct`). Fatos, não invenção.

---

## 10. Tokens / Latência

```
INPUT_TOKENS_TOTAL=2855
OUTPUT_TOKENS_TOTAL=390
TOTAL_TOKENS=3245
LATENCY_AVG_MS=1815
LATENCY_P50_MS=1588
LATENCY_P95_MS=3264
COST_USD=NOT_AVAILABLE
```

---

## 11. Regressão final

```
FULL_REGRESSION=PASS
FULL_REGRESSION_SUITES=71
FULL_REGRESSION_TESTS_PASS=1944
FULL_REGRESSION_TESTS_SKIP=4
FULL_REGRESSION_FAILURES=0
```

---

## 12. Gates

```
N33_4_TECHNICAL_GATE=PASS
N33_4_COMMERCIAL_GATE=PASS
```

**Critérios do commercial gate:**

| Critério | Exigido | Obtido |
|---|---|---|
| ACTIONABLE_SIM | ≥ 4 | 6 ✓ |
| OPPORTUNITY_SPECIFIC_SIM | ≥ 4 | 6 ✓ |
| ADDS_VALUE_SIM | ≥ 4 | 6 ✓ |
| SAFE_AND_PRUDENT_FAIL | = 0 | 0 ✓ |
| REATIVACAO_VS_QUEDA | ≠ GENERICALLY_SIMILAR | CLEARLY_DIFFERENT ✓ |
| REATIVACAO_VS_JANELA | ≠ GENERICALLY_SIMILAR | CLEARLY_DIFFERENT ✓ |
| QUEDA_VS_JANELA | ≠ GENERICALLY_SIMILAR | CLEARLY_DIFFERENT ✓ |

---

## 13. Relatório completo

```
ACTUAL_HEAD=6f848edfc8c8f1394889a5bde938d6eab60a0ae9

PRE_FLIGHT_GATE=PASS
SANITIZATION_GATE=PASS

MODEL=gpt-5.6-luna
ENDPOINT=/v1/responses
STORE=false
AI_MODE=SHADOW

PRIMARY_CASES=6
REAL_SANITIZED_CASES=5
SYNTHETIC_CONTROL_CASES=1

PRIMARY_HTTP_CALLS=6
RETRY_HTTP_CALLS=0
TOTAL_HTTP_CALLS=6

PROVIDER_CONTEXT_FIELDS=versao,tipoOportunidade,decisaoAcao,diasSemComprar,cicloMedianoDias,tendencia,diasAlemDoCiclo,razaoDoCiclo,statusVariacaoPedidos*,variacaoPedidosPct*
DELAY_SIGNAL_INCLUDED=YES
VOLUME_SIGNAL_INCLUDED=YES
EXPERIMENTAL_OUTPUT_SCHEMA={"comoAbordar":"string"}

LLM_SUCCESS=6
SCHEMA_BLOCK=0
CONTRACT_BLOCK=0
GROUNDING_BLOCK=0
FINANCIAL_BLOCK=0
SECURITY_BLOCK=0
INFRA_ERROR=0

ACTIONABLE_SIM=6
ACTIONABLE_PARCIAL=0
ACTIONABLE_NAO=0

OPPORTUNITY_SPECIFIC_SIM=6
OPPORTUNITY_SPECIFIC_PARCIAL=0
OPPORTUNITY_SPECIFIC_NAO=0

ADDS_VALUE_SIM=6
ADDS_VALUE_PARCIAL=0
ADDS_VALUE_NAO=0

REDUNDANCY_BAIXA=4
REDUNDANCY_MEDIA=2
REDUNDANCY_ALTA=0

AI_LANGUAGE_BAIXA=6
AI_LANGUAGE_MEDIA=0
AI_LANGUAGE_ALTA=0

SAFE_AND_PRUDENT_PASS=6
SAFE_AND_PRUDENT_FAIL=0

REATIVACAO_VS_QUEDA=CLEARLY_DIFFERENT
REATIVACAO_VS_JANELA=CLEARLY_DIFFERENT
QUEDA_VS_JANELA=CLEARLY_DIFFERENT

UNSAFE_ESCAPE=0
FINANCIAL_VIOLATION_ESCAPED=0
INVENTED_FACT_ESCAPED=0
INVENTED_CAUSE_ESCAPED=0
INTERNAL_TERM_ESCAPED=0

PII_REAL_SENT=0
REAL_IDENTIFIERS_SENT=0

INPUT_TOKENS_TOTAL=2855
OUTPUT_TOKENS_TOTAL=390
TOTAL_TOKENS=3245
LATENCY_AVG_MS=1815
LATENCY_P50_MS=1588
LATENCY_P95_MS=3264
COST_USD=NOT_AVAILABLE

FULL_REGRESSION=PASS
FULL_REGRESSION_SUITES=71
FULL_REGRESSION_TESTS_PASS=1944
FULL_REGRESSION_TESTS_SKIP=4
FULL_REGRESSION_FAILURES=0

N33_4_TECHNICAL_GATE=PASS
N33_4_COMMERCIAL_GATE=PASS

ARTIFACT=artifacts/N33_4_HYBRID_SELLER_ASSIST_MICRO_PILOT.md
ARTIFACT_JSON=artifacts/N33_4_HYBRID_SELLER_ASSIST_RESULTS.json
```

---

## 14. O que NÃO foi feito (por especificação)

- NÃO modificado prompt após observar outputs
- NÃO repetidos casos ruins (0 falhas — não houve caso ruim)
- NÃO expandida amostra além de 6
- NÃO integrado permanentemente ao provider de produção
- NÃO alterado `servicoAgenteComercial.js`
- NÃO criada UI
- NÃO ativado ASSIST
- NÃO feito deploy
- NÃO enviadas mensagens para vendedores ou clientes
- N33.5 NÃO iniciado

---

## 15. Próxima decisão

**A próxima decisão será humana.**

O piloto mostrou que o desenho HYBRID (determinístico + LLM para `comoAbordar` somente) produz orientações diferenciadas, seguras e acionáveis para os 3 tipos V1. A integração ao serviço de produção — conectando contextBuilder + prompt N33.4 ao `servicoAgenteComercial.js` — requer autorização explícita.

Pontos de atenção para N33.5 (se autorizado):
1. **Redundância numérica (MEDIA em P03/P04):** o modelo tende a repetir números do contexto para QUEDA; avaliar se isso deve ser suprimido via instrução de prompt.
2. **P06 JANELA SYNTHETIC muito similar a P05:** outputs quase idênticos — esperado para contextos muito parecidos, mas confirmar se há casos reais com perfil diferente.
3. **Comprimento:** todos os outputs respeitaram o guia de 1-2 frases; nenhum foi excessivamente longo.
