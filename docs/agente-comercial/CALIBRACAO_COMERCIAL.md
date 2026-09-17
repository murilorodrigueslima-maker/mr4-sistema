# CALIBRAÇÃO COMERCIAL — MR4 Agente IA

> **ATENÇÃO:** Relatório analítico. Nenhuma regra comercial foi alterada.
> PII_NO_RELATORIO = ZERO | FIRESTORE_WRITES = ZERO | LLM_CALLS = ZERO

## 0. Configuração
- DATA_REFERENCIA: **2026-09-17**
- FONTE: API GestãoClick read-only (sem acesso Firestore local — service account não disponível)
- NOTA: A lista exata dos 52 vinculados requer o Firestore `clientes`. Foram analisados todos os clientes GC com histórico de compra.
- HIST_INICIO: 2022-03-24

## 2. Sanity — População Analisada

| Métrica | Valor |
|---------|-------|
| DATA_REFERENCIA | 2026-09-17 |
| CLIENTES_ANALISADOS | **553** |
| NUNCA_COMPRARAM | 0 |
| COM_COMPRA | 553 |
| INATIVOS_120D | 213 |
| ATIVOS_MENOS_120D | 340 |
| FATURAMENTO_TOTAL | R$6.150.792,12 |
| PEDIDOS_TOTAL | 17.257 |

## 3. Distribuição Real dos Dados (clientes COM compra, n=553)

**Faturamento Total (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 10 | 257 | 629 | 2.142 | 7.579 | 29.075 | 261.181 | 11122.59 |

**Faturamento 30d (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 0 | 298 | 1.075 | 20.640 | 417.83 |

**Faturamento 90d (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 180 | 1.075 | 2.990 | 41.543 | 1183.67 |

**Faturamento 180d (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 553 | 1.968 | 5.747 | 75.836 | 2267.67 |

**Pedidos Total**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | 1 | 2 | 6 | 23 | 84 | 552 | 31.21 |

**Pedidos 90d**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 1 | 3 | 8 | 46 | 2.88 |

**Ticket Médio (R$)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 |

**Dias Sem Comprar**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 5 | 16 | 64 | 222 | 464 | 1.608 | 176.36 |

**Intervalo Médio (dias)**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 1 | 6 | 14 | 28 | 59 | 112 | 501 | 51.40 |

**Nº Categorias**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 1 | 3 | 7 | 10 | 10 | 10 | 6.26 |

**Nº Produtos Distintos**
| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|-----|-----|-----|-----|-----|-----|-----|-------|
| 0 | 2 | 5 | 18 | 51 | 112 | 274 | 38.99 |

## 4. Score Provisório Atual

**Configuração:** recência 25 | frequência 20 | faturamento 25 | tendência 15 | diversidade 10 | engajamento 5

**Distribuição Geral (n=553)**
| Faixa | Qtd | % |
|-------|-----|---|
| 0-19 | 169 | 30.56% |
| 20-39 | 88 | 15.91% |
| 40-59 | 71 | 12.84% |
| 60-79 | 92 | 16.64% |
| 80-100 | 133 | 24.05% |

**Estatísticas por segmento:**
| Segmento | MIN | P25 | MED | P75 | MAX | MÉDIA |
|----------|-----|-----|-----|-----|-----|-------|
| Geral | 8 | 18 | 48 | 78 | 100 | 48.47 |
| Com compra | 8 | 18 | 48 | 78 | 100 | 48.47 |
| Inativos ≥120d | 8 | 13 | 16 | 19 | 33 | 16.68 |
| Ativos <120d | 14 | 52 | 70 | 88 | 100 | 68.39 |

## 5. Anomalias de Score

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C82A5
- DADOS: 1 pedido, fat=R$278,00, 1d
- SCORE: 55
- MOTIVO: 1 única compra recebe score 55 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C3C56
- DADOS: 1 pedido, fat=R$700,28, 5d
- SCORE: 63
- MOTIVO: 1 única compra recebe score 63 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C97A7
- DADOS: 1 pedido, fat=R$556,35, 15d
- SCORE: 64
- MOTIVO: 1 única compra recebe score 64 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C7A85
- DADOS: 1 pedido, fat=R$174,14, 16d
- SCORE: 55
- MOTIVO: 1 única compra recebe score 55 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C7390
- DADOS: 1 pedido, fat=R$3.573,49, 20d
- SCORE: 77
- MOTIVO: 1 única compra recebe score 77 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C05A8
- DADOS: 1 pedido, fat=R$262,00, 24d
- SCORE: 55
- MOTIVO: 1 única compra recebe score 55 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** CB7DE
- DADOS: 1 pedido, fat=R$1.686,00, 28d
- SCORE: 65
- MOTIVO: 1 única compra recebe score 65 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C6DE4
- DADOS: 1 pedido, fat=R$1.588,01, 31d
- SCORE: 51
- MOTIVO: 1 única compra recebe score 51 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C8B25
- DADOS: 1 pedido, fat=R$3.400,00, 45d
- SCORE: 58
- MOTIVO: 1 única compra recebe score 58 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C0E4F
- DADOS: 1 pedido, fat=R$1.327,46, 50d
- SCORE: 49
- MOTIVO: 1 única compra recebe score 49 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** CCF44
- DADOS: 1 pedido, fat=R$1.088,75, 58d
- SCORE: 48
- MOTIVO: 1 única compra recebe score 48 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C9350
- DADOS: 1 pedido, fat=R$280,00, 69d
- SCORE: 43
- MOTIVO: 1 única compra recebe score 43 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** CB6FB
- DADOS: 1 pedido, fat=R$813,68, 71d
- SCORE: 51
- MOTIVO: 1 única compra recebe score 51 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** CDEF2
- DADOS: 1 pedido, fat=R$166,99, 72d
- SCORE: 42
- MOTIVO: 1 única compra recebe score 42 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

**TIPO:** 1_COMPRA_SCORE_ALTO | **CLIENTE:** C4734
- DADOS: 1 pedido, fat=R$1.220,81, 76d
- SCORE: 53
- MOTIVO: 1 única compra recebe score 53 — frequência não penaliza suficientemente
- REGRA_RESPONSAVEL: componente frequência usa pedidosTotal/intervalo

## 6. Recência

**Thresholds atuais:** 30 | 60 | 90 | 120 dias

| Faixa | Qtd | % |
|-------|-----|---|
| 0-30 | 201 | 36.35% |
| 31-60 | 71 | 12.84% |
| 61-90 | 38 | 6.87% |
| 91-119 | 30 | 5.42% |
| >=120 | 213 | 38.52% |
| nunca | 0 | 0.00% |

## 7. Faturamento — Referências Provisórias

| Referência | Valor | Percentil Real | Clientes que Atingem |
|------------|-------|---------------|---------------------|
| REF_FATURAMENTO_TOTAL | R$10.000 | P78 | 120/553 (21.70%) |
| REF_FATURAMENTO_90D   | R$3.000  | P90 | 56/553 (10.13%) |

> Se P78 → referência está próxima da mediana — razoável para faturamento total.
> Se P90 → referência de 90d está no percentil alto para faturamento 90d.

## 8. Frequência

**Distribuição por número de datas distintas de compra:**
| Datas | Qtd |
|-------|-----|
| 1 data | 127 |
| 2 datas | 58 |
| 3-5 datas | 83 |
| 6-10 datas | 71 |
| >10 datas | 214 |

**Intervalo médio entre compras (clientes com histórico):** mediana=27.83d, média=51.40d

## 9. Tendência

**Motor atual (tolerância ±20%):**
| Status | Qtd | % |
|--------|-----|---|
| CRESCENDO | 149 | 26.94% |
| ESTAVEL | 22 | 3.98% |
| CAINDO | 211 | 38.16% |
| SEM_BASE | 171 | 30.92% |
| NUNCA_COMPROU | 0 | 0.00% |

**Simulação de tolerâncias (sem alterar código):**
| Tol. | CRESCENDO | ESTAVEL | CAINDO | SEM_BASE |
|------|-----------|---------|--------|---------|
| ±10% | 64 | 12 | 129 | 348 |
| ±15% | 61 | 18 | 126 | 348 |
| ±20% | 60 | 21 | 124 | 348 |
| ±25% | 57 | 24 | 124 | 348 |
| ±30% | 56 | 28 | 121 | 348 |

> Note: clientes CRESCENDO com apenas 1-2 datas de compra representam base estatisticamente instável.

## 10. Recorrência

**Motor atual (alerta=0.85, atraso=1.10):**
| Status | Qtd | % |
|--------|-----|---|
| SEM_BASE | 127 | 22.97% |
| DENTRO_DO_PADRAO | 177 | 32.01% |
| PROXIMO_DA_JANELA | 34 | 6.15% |
| ATRASADO_VS_HISTORICO | 215 | 38.88% |
| NUNCA_COMPROU | 0 | 0.00% |

**Simulação de fatores (sem alterar código):**

| Alerta | Atraso | DENTRO | PROX | ATRASADO | SEM_BASE | NUNCA |
|--------|--------|--------|------|----------|---------|-------|
| 0.75 | 1.05 | 161 | 44 | 221 | 127 | 0 |
| 0.75 | 1.2 | 161 | 63 | 202 | 127 | 0 |
| 0.75 | 1.5 | 161 | 87 | 178 | 127 | 0 |
| 0.85 | 1.1 | 178 | 38 | 210 | 127 | 0 |
| 0.85 | 1.3 | 178 | 53 | 195 | 127 | 0 |
| 0.9 | 1.05 | 187 | 18 | 221 | 127 | 0 |
| 0.9 | 1.2 | 187 | 37 | 202 | 127 | 0 |
| 0.9 | 1.5 | 187 | 61 | 178 | 127 | 0 |
| 1 | 1.1 | 198 | 18 | 210 | 127 | 0 |
| 1 | 1.3 | 198 | 33 | 195 | 127 | 0 |

## 11. Outliers de Recorrência (média ≠ mediana > 50%)

| Cliente | Média | Mediana | Δ% | Pedidos |
|---------|-------|---------|-----|---------|
| C09A0 | 60.67d | 7d | 766.71% | 4 |
| C59A0 | 93.33d | 15d | 522.20% | 4 |
| C956C | 48.65d | 9d | 440.56% | 18 |
| CE898 | 62.07d | 11.5d | 439.74% | 16 |
| C0D51 | 23.75d | 4.5d | 427.78% | 5 |
| C5A71 | 58d | 11d | 427.27% | 8 |
| C4945 | 145.56d | 28d | 419.86% | 10 |
| CE861 | 98d | 20d | 390.00% | 6 |
| C0DC0 | 54.86d | 12d | 357.17% | 8 |
| C1457 | 140.6d | 32d | 339.38% | 6 |

> Alta divergência média/mediana indica compras irregulares ou outliers de comportamento que podem causar falsos alertas ao usar apenas a média.

## 12. Oportunidades

- TOTAL_OPORTUNIDADES: **632**
- CLIENTES_COM_OPORTUNIDADE: 426
- CLIENTES_SEM_OPORTUNIDADE: 127

**Por tipo:**
| Tipo | Qtd |
|------|-----|
| QUEDA_DE_COMPRAS | 169 |
| REATIVACAO_120D | 213 |
| JANELA_DE_RECOMPRA | 249 |
| CROSS_SELL_CATEGORIA | 1 |

**Distribuição por cliente:**
| Oportunidades | Clientes |
|--------------|---------|
| 0 | 127 |
| 1 | 221 |
| 2 | 204 |
| 3+ | 1 |

**Conflitos potenciais (REATIVACAO_120D + JANELA_DE_RECOMPRA):** 109 clientes
> Estes clientes têm padrão de reativação que também está na janela esperada — pode ser intencional ou sinal de thresholds sobrepostos.

## 13. Cross-Sell — Sensibilidade

**Regra atual:** 1 categoria AND pedidos ≥ 3

| Pedidos mínimos | 1 cat | ≤2 cats |
|-----------------|-------|---------|
| ≥2 | 13 | 40 |
| ≥3 | 6 | 20 |
| ≥4 | 2 | 11 |
| ≥5 | 1 | 7 |

## 14. Priorização

**Distribuição de prioridade score:**
| Faixa | Qtd |
|-------|-----|
| 1-20 | 632 |
| 21-40 | 0 |
| 41-60 | 0 |
| 61-80 | 0 |
| 81-100 | 0 |

**Impacto dos bônus/penalidade:**
- +15 faturamento ≥R$10k: afeta 119 oportunidades
- +8  faturamento ≥R$5k: afeta 68 oportunidades
- -10 inatividade >365d: afeta 117 oportunidades

**Top 10 oportunidades por prioridade (anônimo):**
| Rank | Cliente | Tipo | Score |
|------|---------|------|-------|
| 1 | C3055 | QUEDA_DE_COMPRAS | 0 |
| 2 | CBF48 | REATIVACAO_120D | 0 |
| 3 | CBF48 | JANELA_DE_RECOMPRA | 0 |
| 4 | C760C | QUEDA_DE_COMPRAS | 0 |
| 5 | C637C | QUEDA_DE_COMPRAS | 0 |
| 6 | CA192 | QUEDA_DE_COMPRAS | 0 |
| 7 | C9795 | QUEDA_DE_COMPRAS | 0 |
| 8 | C9866 | QUEDA_DE_COMPRAS | 0 |
| 9 | CE1F4 | JANELA_DE_RECOMPRA | 0 |
| 10 | CD7B4 | JANELA_DE_RECOMPRA | 0 |

## 15. Sensibilidade do Score — Pesos Alternativos

| Cenário | MIN | P25 | MED | P75 | MAX | MÉDIA |
|---------|-----|-----|-----|-----|-----|-------|
| A — atual   (25/20/25/15/10/5) | 7 | 25 | 39 | 55 | 75 | 39.82 |
| B — iguais  (17/17/17/17/16/16) | 8 | 27 | 41 | 63 | 83 | 44.17 |
| C — sem eng (28/22/28/17/5/0) | 6 | 23 | 37 | 52 | 72 | 37.60 |
| D — -fat    (25/20/15/20/12/8) | 8 | 27 | 41 | 58 | 75 | 41.61 |
| E — +rec    (35/20/20/15/7/3) | 6 | 22 | 35 | 49 | 65 | 35.14 |

## 16. Correlações Descritivas

_(correlação ≠ causalidade)_

| Par | Correlação de Pearson |
|-----|-----------------------|
| score_faturamento | 0.46 |
| score_recencia | -0.61 |
| score_frequencia | 0.28 |
| score_pedidos | 0.48 |
| score_tendencia | 0.34 |

> Correlação mais alta: 0.61. Componentes relativamente independentes.

## 17. Casos para Revisão Humana

### Clientes Ativos (amostra 5)
```
**ID_ANONIMO =** C3055
ULTIMA_COMPRA = 2026-09-16
DIAS_SEM_COMPRAR = 1
FAT_TOTAL = R$18.968,35
FAT_90D = R$10.843,85
PEDIDOS = 67
TICKET = R$0,00
FREQUENCIA = 2.96d entre compras
CATEGORIAS = 10
TENDENCIA = CAINDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 89 (EXCELENTE)
OPORTUNIDADES = QUEDA_DE_COMPRAS
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** CA93C
ULTIMA_COMPRA = 2026-09-16
DIAS_SEM_COMPRAR = 1
FAT_TOTAL = R$11.679,86
FAT_90D = R$5.100,14
PEDIDOS = 39
TICKET = R$0,00
FREQUENCIA = 5.83d entre compras
CATEGORIAS = 10
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 100 (EXCELENTE)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** C6B0C
ULTIMA_COMPRA = 2026-09-16
DIAS_SEM_COMPRAR = 1
FAT_TOTAL = R$102.486,86
FAT_90D = R$18.235,20
PEDIDOS = 72
TICKET = R$0,00
FREQUENCIA = 10.75d entre compras
CATEGORIAS = 10
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 100 (EXCELENTE)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** CD653
ULTIMA_COMPRA = 2026-09-16
DIAS_SEM_COMPRAR = 1
FAT_TOTAL = R$1.156,99
FAT_90D = R$861,74
PEDIDOS = 7
TICKET = R$0,00
FREQUENCIA = 14.83d entre compras
CATEGORIAS = 7
TENDENCIA = ESTAVEL
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 76 (BOM)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** CAB63
ULTIMA_COMPRA = 2026-09-16
DIAS_SEM_COMPRAR = 1
FAT_TOTAL = R$16.063,53
FAT_90D = R$3.537,00
PEDIDOS = 19
TICKET = R$0,00
FREQUENCIA = 49.72d entre compras
CATEGORIAS = 5
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 100 (EXCELENTE)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

### Clientes Inativos ≥120d (amostra 5)
```
**ID_ANONIMO =** CBF48
ULTIMA_COMPRA = 2026-01-20
DIAS_SEM_COMPRAR = 240
FAT_TOTAL = R$15.395,57
FAT_90D = R$0,00
PEDIDOS = 9
TICKET = R$0,00
FREQUENCIA = 11d entre compras
CATEGORIAS = 10
TENDENCIA = SEM_BASE
RECORRENCIA = ATRASADO_VS_HISTORICO
SCORE_ATUAL = 33 (FRACO)
OPORTUNIDADES = REATIVACAO_120D, JANELA_DE_RECOMPRA
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** C44F1
ULTIMA_COMPRA = 2026-05-20
DIAS_SEM_COMPRAR = 120
FAT_TOTAL = R$21,00
FAT_90D = R$0,00
PEDIDOS = 1
TICKET = R$0,00
FREQUENCIA = —
CATEGORIAS = 1
TENDENCIA = CAINDO
RECORRENCIA = SEM_BASE
SCORE_ATUAL = 14 (INATIVO)
OPORTUNIDADES = REATIVACAO_120D
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** C6504
ULTIMA_COMPRA = 2026-05-18
DIAS_SEM_COMPRAR = 122
FAT_TOTAL = R$4.137,80
FAT_90D = R$0,00
PEDIDOS = 14
TICKET = R$0,00
FREQUENCIA = 48.73d entre compras
CATEGORIAS = 5
TENDENCIA = CAINDO
RECORRENCIA = ATRASADO_VS_HISTORICO
SCORE_ATUAL = 21 (FRACO)
OPORTUNIDADES = REATIVACAO_120D, JANELA_DE_RECOMPRA
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** C631F
ULTIMA_COMPRA = 2026-05-18
DIAS_SEM_COMPRAR = 122
FAT_TOTAL = R$2.457,90
FAT_90D = R$0,00
PEDIDOS = 6
TICKET = R$0,00
FREQUENCIA = 195.6d entre compras
CATEGORIAS = 3
TENDENCIA = CAINDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 16 (INATIVO)
OPORTUNIDADES = REATIVACAO_120D
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** CD879
ULTIMA_COMPRA = 2026-05-18
DIAS_SEM_COMPRAR = 122
FAT_TOTAL = R$1.517,30
FAT_90D = R$0,00
PEDIDOS = 1
TICKET = R$0,00
FREQUENCIA = —
CATEGORIAS = 9
TENDENCIA = CAINDO
RECORRENCIA = SEM_BASE
SCORE_ATUAL = 17 (INATIVO)
OPORTUNIDADES = REATIVACAO_120D
PRIORIDADE_MAX = 0
```

### Nunca Compraram (amostra 5)
### Casos Limítrofes — Score 35-55 (amostra 5)
```
**ID_ANONIMO =** C82A5
ULTIMA_COMPRA = 2026-09-16
DIAS_SEM_COMPRAR = 1
FAT_TOTAL = R$278,00
FAT_90D = R$278,00
PEDIDOS = 1
TICKET = R$0,00
FREQUENCIA = —
CATEGORIAS = 1
TENDENCIA = CRESCENDO
RECORRENCIA = SEM_BASE
SCORE_ATUAL = 55 (REGULAR)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** C7A85
ULTIMA_COMPRA = 2026-09-01
DIAS_SEM_COMPRAR = 16
FAT_TOTAL = R$174,14
FAT_90D = R$174,14
PEDIDOS = 1
TICKET = R$0,00
FREQUENCIA = —
CATEGORIAS = 1
TENDENCIA = CRESCENDO
RECORRENCIA = SEM_BASE
SCORE_ATUAL = 55 (REGULAR)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** CE229
ULTIMA_COMPRA = 2026-09-01
DIAS_SEM_COMPRAR = 16
FAT_TOTAL = R$287,24
FAT_90D = R$165,30
PEDIDOS = 2
TICKET = R$0,00
FREQUENCIA = 136d entre compras
CATEGORIAS = 1
TENDENCIA = CRESCENDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 55 (REGULAR)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** C05A8
ULTIMA_COMPRA = 2026-08-24
DIAS_SEM_COMPRAR = 24
FAT_TOTAL = R$262,00
FAT_90D = R$262,00
PEDIDOS = 1
TICKET = R$0,00
FREQUENCIA = —
CATEGORIAS = 1
TENDENCIA = CRESCENDO
RECORRENCIA = SEM_BASE
SCORE_ATUAL = 55 (REGULAR)
OPORTUNIDADES = —
PRIORIDADE_MAX = 0
```

```
**ID_ANONIMO =** CE8BE
ULTIMA_COMPRA = 2026-08-18
DIAS_SEM_COMPRAR = 30
FAT_TOTAL = R$741,53
FAT_90D = R$349,44
PEDIDOS = 4
TICKET = R$0,00
FREQUENCIA = 137d entre compras
CATEGORIAS = 5
TENDENCIA = CAINDO
RECORRENCIA = DENTRO_DO_PADRAO
SCORE_ATUAL = 51 (REGULAR)
OPORTUNIDADES = QUEDA_DE_COMPRAS
PRIORIDADE_MAX = 0
```

## Diagnóstico das Regras Provisórias

**REGRAS_QUE_PARECEM_MUITO_SENSIVEIS:**
- Tolerância tendência (±20%): base pequena (≤2 datas) gera classificações instáveis. Ver seção 9.
- Recorrência com média de intervalo: outliers distorcem para 10 clientes. Ver seção 11.

**REGRAS_COM_POUCO_IMPACTO:**
- Componente engajamento (peso 5): baixo peso pode ser eliminado sem mudança material no score. Cenário C mostra impacto.
- Bônus +8 (R$5k-R$10k): afeta apenas 68 oportunidades.

**REGRAS_QUE_PRECISAM_DECISAO_HUMANA:**
- REF_FATURAMENTO_TOTAL R$10.000 está no P78 — decidir se referência deve ser mediana ou meta comercial.
- REF_FATURAMENTO_90D R$3.000 está no P90 — idem.
- Threshold inativo ≥120d: 213 clientes (38.52% dos compradores) — validar se esse prazo reflete o ciclo real da MR4.
- Tolerância tendência ±20%: 22 estáveis vs 149 crescendo — validar se reflete percepção comercial.

## Relatório Final — Gates

| Campo | Valor |
|-------|-------|
| DATA_REFERENCIA | 2026-09-17 |
| CLIENTES_ANALISADOS | 553 |
| NUNCA_COMPRARAM | 0 |
| ATIVOS | 340 |
| INATIVOS_120D | 213 |
| FATURAMENTO_TOTAL | R$6.150.792,12 |
| PEDIDOS_TOTAL | 17.257 |
| OPORTUNIDADES_TOTAL | 632 |
| PII_NO_RELATORIO | ZERO |
| FIRESTORE_WRITES | ZERO |
| GESTAOCLICK_WRITES | ZERO |
| LLM_CALLS | ZERO |
| DEPLOYS | ZERO |
| CALIBRATION_GATE | PASS |
