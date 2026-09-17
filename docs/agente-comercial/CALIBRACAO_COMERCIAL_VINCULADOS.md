# CALIBRAÇÃO COMERCIAL — MR4 Agente IA (VINCULADOS)

> **ATENÇÃO:** Relatório analítico oficial dos clientes MR4 vinculados ao GestãoClick.
> PII_NO_RELATORIO = ZERO | FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO
> B1_FIX = ticketMedioTotal | B2_FIX = prioridadeFinal

## 0. Configuração
- DATA_REFERENCIA: **2026-09-17**
- FONTE: API GestãoClick read-only + artifacts/vinculos-gc.json (WIF export)
- LINK_SOURCE: Firestore clientes.gestaoClickId (workflow export-vinculos360.yml)
- HIST_INICIO: 2022-03-24

## 2. Sanity — População Vinculados

| Métrica | Valor |
|---------|-------|
| DATA_REFERENCIA | 2026-09-17 |
| CLIENTES_VINCULADOS | **52** |
| NUNCA_COMPRARAM | 17 |
| COM_COMPRA | 35 |
| INATIVOS_120D | 15 |
| ATIVOS_MENOS_120D | 20 |
| FATURAMENTO_TOTAL | R$137.631,34 |
| PEDIDOS_TOTAL | 451 |
| TICKET_MEDIO_GLOBAL | R$305,17 |

## 3. Distribuição Real dos Dados (clientes COM compra, n=35)

**Faturamento Total (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 43.6 | 554 | 1081.58 | 1964.24 | 4824.68 | 7041.88 | 23706.25 | 3932.32 |

**Faturamento 30d (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 0 | 118 | 429 | 2979.85 | 251.78 |

**Faturamento 90d (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 92.87 | 877.24 | 2219.12 | 5635.52 | 805.24 |

**Faturamento 180d (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 776.39 | 1375.25 | 2225.74 | 11888.74 | 1576.79 |

**Pedidos Total**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | 1 | 3 | 8 | 16 | 25 | 60 | 12.89 |

**Pedidos 90d**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 1 | 2 | 8 | 18 | 2.77 |

**Ticket Médio Total (R$) [B1 corrigido]**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 43.6 | 118.33 | 137.49 | 272.19 | 448.36 | 597.69 | 1618.47 | 355.55 |

**Dias Sem Comprar**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | 6 | 17 | 62 | 178 | 248 | 692 | 126.89 |

**Intervalo Médio (dias)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 5.83 | 14.53 | 19 | 29.67 | 52.5 | 105.83 | 214.6 | 50.55 |

**Nº Categorias**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | 2 | 5 | 8 | 10 | 10 | 10 | 7.23 |

**Nº Produtos Distintos**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | 4 | 14 | 20 | 42 | 60 | 143 | 33.51 |

## 4. Score Provisório Atual

**Configuração:** recência 25 | frequência 20 | faturamento 25 | tendência 15 | diversidade 10 | engajamento 5

**Distribuição Geral (n=52)**
| Faixa | Qtd | % |
|-------|-----|---|
| 0-19 | 27 | 51.92% |
| 20-39 | 6 | 11.54% |
| 40-59 | 7 | 13.46% |
| 60-79 | 4 | 7.69% |
| 80-100 | 8 | 15.38% |

**Estatísticas por segmento:**
| Segmento | MIN | P25 | MED | P75 | MAX | MÉDIA |
|----------|-----|-----|-----|-----|-----|-------|
| Geral | 0 | 0 | 19 | 52 | 100 | 31.44 |
| Com compra | 10 | 19 | 47 | 74 | 100 | 46.71 |
| Inativos ≥120d | 10 | 14 | 19 | 20 | 27 | 17.67 |
| Ativos <120d | 23 | 50 | 70 | 81 | 100 | 68.5 |

## 5. Anomalias de Score

Nenhuma anomalia (1 pedido, score ≥40) encontrada nos vinculados.

## 6. Recência

**Thresholds atuais:** 30 | 60 | 90 | 120 dias

| Faixa | Qtd | % |
|-------|-----|---|
| 0-30 | 12 | 23.08% |
| 31-60 | 5 | 9.62% |
| 61-90 | 2 | 3.85% |
| 91-119 | 1 | 1.92% |
| >=120 | 15 | 28.85% |
| nunca | 17 | 32.69% |

## 7. Faturamento — Referências Provisórias

| Referência | Valor | % que Atingem |
|------------|-------|---------------|
| REF_FATURAMENTO_TOTAL | R$10.000 | 8.6% (3/35) |
| REF_FATURAMENTO_90D   | R$3.000  | 8.6% (3/35) |

## 8. Frequência

**Distribuição por número de pedidos:**
| Categoria | Qtd |
|-----------|-----|
| 1 data | 4 |
| 2 datas | 3 |
| 3-5 datas | 5 |
| 6-10 datas | 9 |
| >10 datas | 14 |

**Intervalo médio entre compras:** mediana=29.67d, média=50.55d

## 9. Tendência

**Motor atual (tolerância ±20%):**
| Status | Qtd | % |
|--------|-----|---|
| CRESCENDO | 8 | 15.38% |
| ESTAVEL | 0 | 0% |
| CAINDO | 18 | 34.62% |
| SEM_BASE | 9 | 17.31% |
| NUNCA_COMPROU | 17 | 32.69% |

**Simulação de tolerâncias:**
| Tol. | CRESCENDO | ESTAVEL | CAINDO | SEM_BASE |
|------|-----------|---------|--------|---------|
| ±10% | 8 | 0 | 18 | 9 |
| ±15% | 8 | 0 | 18 | 9 |
| ±20% | 8 | 0 | 18 | 9 |
| ±25% | 8 | 0 | 18 | 9 |
| ±30% | 8 | 0 | 18 | 9 |

## 10. Recorrência

**Motor atual (alerta=0.85, atraso=1.10):**
| Status | Qtd | % |
|--------|-----|---|
| SEM_BASE | 4 | 7.69% |
| DENTRO_DO_PADRAO | 15 | 28.85% |
| PROXIMO_DA_JANELA | 1 | 1.92% |
| ATRASADO_VS_HISTORICO | 15 | 28.85% |
| NUNCA_COMPROU | 17 | 32.69% |

**Simulação de fatores:**
| Alerta | Atraso | DENTRO | PROX | ATRASADO | SEM_BASE | NUNCA |
|--------|--------|--------|------|----------|---------|-------|
| 0.75 | 1.05 | 15 | 1 | 15 | 4 | 17 |
| 0.75 | 1.2 | 15 | 1 | 15 | 4 | 17 |
| 0.75 | 1.5 | 15 | 1 | 15 | 4 | 17 |
| 0.85 | 1.1 | 15 | 1 | 15 | 4 | 17 |
| 0.85 | 1.3 | 15 | 1 | 15 | 4 | 17 |
| 0.9 | 1.05 | 15 | 1 | 15 | 4 | 17 |
| 0.9 | 1.2 | 15 | 1 | 15 | 4 | 17 |
| 0.9 | 1.5 | 15 | 1 | 15 | 4 | 17 |
| 1 | 1.1 | 15 | 1 | 15 | 4 | 17 |
| 1 | 1.3 | 15 | 1 | 15 | 4 | 17 |

## 11. Outliers de Recorrência (média/mediana > 300%)

| Cliente | Média | Mediana | Δ% | Pedidos |
|---------|-------|---------|-----|---------|
| — | — | — | — | — |

## 12. Oportunidades

- TOTAL_OPORTUNIDADES: **60**
- CLIENTES_COM_OPORTUNIDADE: 44
- CLIENTES_SEM_OPORTUNIDADE: 8

**Por tipo:**
| Tipo | Qtd |
|------|-----|
| NUNCA_COMPROU | 17 |
| JANELA_DE_RECOMPRA | 16 |
| REATIVACAO_120D | 15 |
| QUEDA_DE_COMPRAS | 12 |

**Conflitos REATIVACAO_120D + JANELA_DE_RECOMPRA:** 10 clientes

## 13. Cross-Sell — Sensibilidade

**Regra atual:** 1 categoria AND pedidos ≥ 3

| Pedidos mínimos | 1 cat | ≤2 cats |
|-----------------|-------|---------|
| ≥2 | 0 | 2 |
| ≥3 | 0 | 1 |
| ≥4 | 0 | 1 |
| ≥5 | 0 | 1 |

## 14. Priorização [B2 corrigido — usa prioridadeFinal]

**Distribuição de prioridade final (prioridadeFinal):**
| Faixa | Qtd |
|-------|-----|
| 1-20 | 0 |
| 21-40 | 18 |
| 41-60 | 2 |
| 61-80 | 26 |
| 81-100 | 14 |

**Top 10 oportunidades por prioridadeFinal (anônimo):**
| Rank | Cliente | Tipo | PrioridadeFinal |
|------|---------|------|-----------------|
| 1 | CDD92 | REATIVACAO_120D | 99 |
| 2 | CE721 | REATIVACAO_120D | 99 |
| 3 | CE1A3 | REATIVACAO_120D | 98 |
| 4 | C1609 | REATIVACAO_120D | 95 |
| 5 | CA0C3 | REATIVACAO_120D | 95 |
| 6 | C0AD8 | REATIVACAO_120D | 95 |
| 7 | C7B97 | REATIVACAO_120D | 95 |
| 8 | C1C55 | REATIVACAO_120D | 93 |
| 9 | CB6F9 | REATIVACAO_120D | 91 |
| 10 | C882C | REATIVACAO_120D | 90 |

## 15. Sensibilidade do Score — Pesos Alternativos

| Cenário | MIN | P25 | MED | P75 | MAX | MÉDIA |
|---------|-----|-----|-----|-----|-----|-------|
| A — atual   (25/20/25/15/10/5) | 0.12 | 0.23 | 0.3 | 0.48 | 0.8 | 0.37 |
| B — iguais  (17/17/17/17/16/16) | 0.12 | 0.23 | 0.33 | 0.48 | 0.86 | 0.39 |
| C — sem eng (28/22/28/17/5/0) | 0.12 | 0.21 | 0.26 | 0.45 | 0.78 | 0.36 |
| D — -fat    (25/20/15/20/12/8) | 0.14 | 0.24 | 0.3 | 0.45 | 0.8 | 0.38 |
| E — +rec    (35/20/20/15/7/3) | 0.14 | 0.22 | 0.27 | 0.43 | 0.72 | 0.35 |

## 16. Correlações Descritivas

_(correlação ≠ causalidade)_

| Par | Correlação de Pearson |
|-----|-----------------------|
| score_faturamento | 0.65 |
| score_recencia | -0.69 |
| score_frequencia | 0.31 |
| score_pedidos | 0.78 |
| score_tendencia | 0.47 |

## 17. Casos para Revisão Humana

### Clientes Ativos (amostra 5)
```
**ID_ANONIMO =** CA02B
ULTIMA_COMPRA = 2026-08-25
DIAS_SEM_COMPRAR = 23
FAT_TOTAL = R$1964.24
FAT_90D = R$1020.97
PEDIDOS = 16
TICKET_MEDIO = R$122.77
FREQUENCIA = 47.5d entre compras
CATEGORIAS = 10
TENDENCIA = CAINDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 70 (BOM)
OPORTUNIDADES = QUEDA_DE_COMPRAS
PRIORIDADE_MAX = 65
```
```
**ID_ANONIMO =** C6A75
ULTIMA_COMPRA = 2026-09-11
DIAS_SEM_COMPRAR = 6
FAT_TOTAL = R$18760.53
FAT_90D = R$4430.24
PEDIDOS = 60
TICKET_MEDIO = R$312.68
FREQUENCIA = 15.25d entre compras
CATEGORIAS = 10
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 100 (EXCELENTE)
OPORTUNIDADES = —
PRIORIDADE_MAX = —
```
```
**ID_ANONIMO =** C1FD0
ULTIMA_COMPRA = 2026-09-08
DIAS_SEM_COMPRAR = 9
FAT_TOTAL = R$5148.21
FAT_90D = R$1412.19
PEDIDOS = 33
TICKET_MEDIO = R$156.01
FREQUENCIA = 24.38d entre compras
CATEGORIAS = 10
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 88 (EXCELENTE)
OPORTUNIDADES = —
PRIORIDADE_MAX = —
```
```
**ID_ANONIMO =** C51CC
ULTIMA_COMPRA = 2026-07-17
DIAS_SEM_COMPRAR = 62
FAT_TOTAL = R$2177.51
FAT_90D = R$875.38
PEDIDOS = 8
TICKET_MEDIO = R$272.19
FREQUENCIA = 46.83d entre compras
CATEGORIAS = 8
TENDENCIA = CAINDO
RECORRENCIA = ATRASADO_VS_HISTORICO
SCORE_ATUAL = 48 (REGULAR)
OPORTUNIDADES = JANELA_DE_RECOMPRA, QUEDA_DE_COMPRAS
PRIORIDADE_MAX = 75
```
```
**ID_ANONIMO =** C8A07
ULTIMA_COMPRA = 2026-08-26
DIAS_SEM_COMPRAR = 22
FAT_TOTAL = R$1530.03
FAT_90D = R$877.24
PEDIDOS = 7
TICKET_MEDIO = R$218.58
FREQUENCIA = 105.83d entre compras
CATEGORIAS = 10
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 80 (EXCELENTE)
OPORTUNIDADES = —
PRIORIDADE_MAX = —
```

### Clientes Inativos ≥120d (amostra 5)
```
**ID_ANONIMO =** C1609
ULTIMA_COMPRA = 2026-03-23
DIAS_SEM_COMPRAR = 178
FAT_TOTAL = R$554.00
FAT_90D = R$0.00
PEDIDOS = 6
TICKET_MEDIO = R$92.33
TENDENCIA = CAINDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 11 (INATIVO)
OPORTUNIDADES = REATIVACAO_120D
PRIORIDADE_MAX = 95
```
```
**ID_ANONIMO =** CDD92
ULTIMA_COMPRA = 2026-05-05
DIAS_SEM_COMPRAR = 135
FAT_TOTAL = R$4824.68
FAT_90D = R$0.00
PEDIDOS = 7
TICKET_MEDIO = R$689.24
TENDENCIA = CAINDO
RECORRENCIA = ATRASADO_VS_HISTORICO
SCORE_ATUAL = 22 (FRACO)
OPORTUNIDADES = REATIVACAO_120D, JANELA_DE_RECOMPRA
PRIORIDADE_MAX = 99
```
```
**ID_ANONIMO =** CD153
ULTIMA_COMPRA = 2025-08-07
DIAS_SEM_COMPRAR = 406
FAT_TOTAL = R$1179.45
FAT_90D = R$0.00
PEDIDOS = 3
TICKET_MEDIO = R$393.15
TENDENCIA = SEM_BASE
RECORRENCIA = ATRASADO_VS_HISTORICO
SCORE_ATUAL = 19 (INATIVO)
OPORTUNIDADES = JANELA_DE_RECOMPRA, REATIVACAO_120D
PRIORIDADE_MAX = 65
```
```
**ID_ANONIMO =** C8818
ULTIMA_COMPRA = 2025-06-20
DIAS_SEM_COMPRAR = 454
FAT_TOTAL = R$1588.40
FAT_90D = R$0.00
PEDIDOS = 5
TICKET_MEDIO = R$317.68
TENDENCIA = SEM_BASE
RECORRENCIA = ATRASADO_VS_HISTORICO
SCORE_ATUAL = 20 (FRACO)
OPORTUNIDADES = JANELA_DE_RECOMPRA, REATIVACAO_120D
PRIORIDADE_MAX = 65
```
```
**ID_ANONIMO =** C559E
ULTIMA_COMPRA = 2026-01-29
DIAS_SEM_COMPRAR = 231
FAT_TOTAL = R$265.90
FAT_90D = R$0.00
PEDIDOS = 1
TICKET_MEDIO = R$265.90
TENDENCIA = SEM_BASE
RECORRENCIA = SEM_BASE
SCORE_ATUAL = 18 (INATIVO)
OPORTUNIDADES = REATIVACAO_120D
PRIORIDADE_MAX = 89
```

### Nunca Compraram (amostra 5)
```
**ID_ANONIMO =** CF3ED
NUNCA_COMPROU = true
FAT_TOTAL = R$0,00
PEDIDOS = 0
TICKET_MEDIO = null
SCORE_ATUAL = 0
OPORTUNIDADES = NUNCA_COMPROU
```
```
**ID_ANONIMO =** CE18D
NUNCA_COMPROU = true
FAT_TOTAL = R$0,00
PEDIDOS = 0
TICKET_MEDIO = null
SCORE_ATUAL = 0
OPORTUNIDADES = NUNCA_COMPROU
```
```
**ID_ANONIMO =** C3669
NUNCA_COMPROU = true
FAT_TOTAL = R$0,00
PEDIDOS = 0
TICKET_MEDIO = null
SCORE_ATUAL = 0
OPORTUNIDADES = NUNCA_COMPROU
```
```
**ID_ANONIMO =** C8B2A
NUNCA_COMPROU = true
FAT_TOTAL = R$0,00
PEDIDOS = 0
TICKET_MEDIO = null
SCORE_ATUAL = 0
OPORTUNIDADES = NUNCA_COMPROU
```
```
**ID_ANONIMO =** CEFF6
NUNCA_COMPROU = true
FAT_TOTAL = R$0,00
PEDIDOS = 0
TICKET_MEDIO = null
SCORE_ATUAL = 0
OPORTUNIDADES = NUNCA_COMPROU
```

## Diagnóstico das Regras Provisórias

**REGRAS_QUE_PARECEM_MUITO_SENSIVEIS:**
- Tolerância tendência (±20%): base pequena nos vinculados pode gerar instabilidade. Ver seção 9.
- Recorrência com média de intervalo: outliers distorcem para clientes com compras irregulares. Ver seção 11.

**REGRAS_COM_POUCO_IMPACTO:**
- Componente engajamento (peso 5): impacto marginal. Cenário C mostra variação.
- Bônus +8 (R$5k-R$10k): afeta subconjunto dos vinculados.

**REGRAS_QUE_PRECISAM_DECISAO_HUMANA:**
- REF_FATURAMENTO_TOTAL R$10.000: verificar percentil real nos vinculados.
- REF_FATURAMENTO_90D R$3.000: verificar percentil real nos vinculados.
- Threshold inativo ≥120d: validar se reflete ciclo real dos vinculados.
- NUNCA_COMPRARAM=17: decidir como tratar no agente (não oferecer oportunidades vs oferecer onboarding).

## Relatório Final — Gates

| Campo | Valor |
|-------|-------|
| DATA_REFERENCIA | 2026-09-17 |
| CLIENTES_VINCULADOS | 52 |
| NUNCA_COMPRARAM | 17 |
| COM_COMPRA | 35 |
| ATIVOS | 20 |
| INATIVOS_120D | 15 |
| FATURAMENTO_TOTAL | R$137.631,34 |
| PEDIDOS_TOTAL | 451 |
| TICKET_MEDIO_GLOBAL | R$305,17 |
| OPORTUNIDADES_TOTAL | 60 |
| B1_TICKET_FIX | PASS |
| B2_PRIORITY_FIX | PASS |
| PII_NO_RELATORIO | ZERO |
| FIRESTORE_WRITES | ZERO |
| GESTAOCLICK_WRITES | ZERO |
| LLM_CALLS | ZERO |
| DEPLOYS | ZERO |
| CALIBRATION_GATE | PASS |
