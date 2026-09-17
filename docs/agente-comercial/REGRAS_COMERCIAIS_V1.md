# Regras Comerciais V1

**Status:** APROVADO_PROPRIETARIO_2026-09-17  
**Versão:** `PROPENSAO_RECOMPRA_V1`  
**Arquivo de config:** `functions/config/score-comercial.v1.js`

---

## 1. Significado oficial do score

> **Score = "FORÇA DOS SINAIS DE QUE O CLIENTE PODE VOLTAR A COMPRAR."**

O score **não é** probabilidade. O score **não é** percentual de chance.  
Score 90 = sinais comerciais muito fortes de possível nova compra.  
Score 30 = sinais fracos ou ausentes.

Identificador técnico: `SCORE_PROPENSAO_RECOMPRA`

---

## 2. Pesos dos componentes (soma = 100)

| Componente    | Peso | Máx. contribuição | Observação                              |
|---------------|-----:|------------------:|-----------------------------------------|
| Recência      |   38 |           38 pts  | Quão recente foi a última compra        |
| Frequência    |   30 |           30 pts  | Ritmo de compras (via mediana)          |
| Tendência     |   15 |           15 pts  | Trajetória (crescendo / caindo)         |
| Faturamento   |   10 |           10 pts  | Volume financeiro (tiers progressivos)  |
| Diversidade   |    7 |            7 pts  | Variedade de categorias                 |
| Engajamento   |    0 |            0 pts  | DESATIVADO — sem fonte confiável em V1  |

---

## 3. Recência

**Regra empresarial inamovível:** `>= 120 dias sem comprar = INATIVO`.

| Dias sem comprar | Faixa     | Pontuação |
|------------------:|-----------|----------:|
| 0 – 30           | excelente |       100 |
| 31 – 60          | bom       |        75 |
| 61 – 90          | regular   |        50 |
| 91 – 119         | fraco     |        25 |
| ≥ 120            | inativo   |         0 |

`nuncaComprou = true` → faixa `NUNCA_COMPROU`, pontuação 0. **Nunca-comprou não é inativo.**

---

## 4. Frequência / Recorrência

### 4.1 Pedido único → SEM_BASE

Se `pedidosTotal <= 1` **ou** `diasEntreComprasMediana === null` → componente retorna `SEM_BASE`, pontuação 0.

Razão: pedidos no mesmo dia não criam intervalo. Frequência exige ≥ 2 datas distintas de compra.

### 4.2 Ciclo de recompra: MEDIANA (V1)

A partir da 2ª data distinta, o ciclo de referência é `diasEntreComprasMediana`.  
A média (`diasEntreComprasMedio`) é preservada no perfil e no resultado apenas como métrica **informativa**.

Motivação: intervalos excepcionalmente longos (ex.: paralisação operacional) não devem distorcer o ciclo normal de recompra.

### 4.3 Limites de alerta

```
limiteAlerta = round(medianaIntervaloDias × 0.85)  → PROXIMO_DA_JANELA
limiteAtraso = round(medianaIntervaloDias × 1.10)  → ATRASADO_VS_HISTORICO
```

---

## 5. Tendência

**Base mínima:** 2 pedidos em qualquer janela de comparação.

Com somente 1 pedido em todas as janelas → `SEM_BASE` (evidência insuficiente).  
A partir de 2 pedidos numa janela → classificação é possível.

| Classificação | Pontuação |
|---------------|----------:|
| CRESCENDO     |       100 |
| ESTAVEL       |        75 |
| SEM_BASE      |        50 |
| CAINDO        |        25 |
| NUNCA_COMPROU |         0 |

Tolerância para ESTÁVEL: ±20% de variação relativa.

---

## 6. Faturamento — tiers progressivos

Baseados na realidade dos compradores vinculados (mediana ≈ R$1.964, P75 ≈ R$4.824).

| Faixa de faturamento total | Pontuação | Contribuição máxima |
|---------------------------|----------:|--------------------:|
| ≥ R$10.000                |       100 |            10 pts   |
| R$5.000 – R$9.999,99      |        80 |             8 pts   |
| R$2.000 – R$4.999,99      |        60 |             6 pts   |
| R$1.000 – R$1.999,99      |        40 |             4 pts   |
| R$0 – R$999,99            |        20 |             2 pts   |

---

## 7. Diversidade de categorias

| Nº de categorias | Pontuação | Contribuição máxima |
|-----------------:|----------:|--------------------:|
| 0                |         0 |             0 pts   |
| 1                |        25 |          1,75 pts   |
| 2                |        50 |          3,50 pts   |
| 3                |        75 |          5,25 pts   |
| ≥ 4              |       100 |             7 pts   |

---

## 8. Engajamento

**Desativado em V1.** Peso = 0. Sem fonte de dados confiável (NPS, cliques, canais digitais não disponíveis).

O componente está preservado no motor para facilitar a ativação futura.

---

## 9. Classificação final do score

| Score | Classificação |
|------:|---------------|
| 80–100 | EXCELENTE     |
| 60–79  | BOM           |
| 40–59  | REGULAR       |
| 20–39  | FRACO         |
| 0–19   | INATIVO       |

---

## 10. Oportunidades e filas

### 10.1 Tipos de oportunidade

| Tipo                  | Fila              | Condição de geração                                |
|-----------------------|-------------------|----------------------------------------------------|
| `PROSPECT_VINCULADO`  | FILA_PROSPECCAO   | `nuncaComprou = true`                              |
| `REATIVACAO_120D`     | FILA_RECOMPRA     | `inativo120d = true` e `nuncaComprou = false`       |
| `QUEDA_DE_COMPRAS`    | FILA_RECOMPRA     | tendência CAINDO + ativo + não-nuncaComprou         |
| `JANELA_DE_RECOMPRA`  | FILA_RECOMPRA     | recorrência PROXIMO_DA_JANELA ou ATRASADO (e ativo)|
| `CROSS_SELL_CATEGORIA`| —                 | **DESATIVADO** (`CROSS_SELL_ENABLED = false`)       |

### 10.2 Decisão O1 — REATIVACAO_120D absorve JANELA_DE_RECOMPRA

Se `inativo120d = true`, a oportunidade gerada é **somente `REATIVACAO_120D`**.  
`JANELA_DE_RECOMPRA` não é gerada para clientes inativos.  

Motivação: evitar duplicidade de sinal. A `REATIVACAO_120D` já inclui como evidência o ciclo histórico de recompra quando a recorrência indica atraso.

### 10.3 PROSPECT_VINCULADO ≠ INATIVO

Clientes que nunca compraram **não são inativos**. Eles entram em `FILA_PROSPECCAO` (não em `FILA_RECOMPRA`). O campo `inativo120d` permanece `false`.

### 10.4 Score ≠ Prioridade

O score de propensão é um **sinal de força comercial**; a prioridade da oportunidade é calculada separadamente (com ajustes de urgência). Não confundir score 90 com prioridade 90.

Ajustes de prioridade mantidos: +15 / +8 / -10 (conforme implementação existente).

---

## 11. Cross-sell

`CROSS_SELL_ENABLED = false` em V1.

O motor de cross-sell está preservado no código mas retorna `null` enquanto o flag está desativado. Nenhuma oportunidade `CROSS_SELL_CATEGORIA` é gerada oficialmente.

---

## 12. Arquivo de configuração

`functions/config/score-comercial.v1.js`

Exporta: `VERSAO_CONFIG`, `SCORE_SIGNIFICADO`, `PESOS`, `THRESHOLDS_RECENCIA`, `PONTOS_RECENCIA`, `FAIXAS_FATURAMENTO`, `PONTOS_TENDENCIA`, `FAIXAS_SCORE`, `CROSS_SELL_ENABLED`.

---

## 13. Testes de especificação

`functions/test/regras-comerciais-v1.test.js` — 48 testes que codificam as regras acima:

- `SCORE-V1-01` a `SCORE-V1-08`: pesos, limites de contribuição por componente
- `SINGLE-V1-01`, `SINGLE-V1-02`: pedido único → SEM_BASE; 2 datas → calculável
- `RECURRENCE-V1-01` a `RECURRENCE-V1-03`: mediana como ciclo, outlier, mesmo dia
- `TREND-V1-01`, `TREND-V1-02`: base mínima 2 pedidos
- `NEVER-V1-01` a `NEVER-V1-03`: never bought — identidade, campos nulos
- `OPP-V1-01`, `OPP-V1-02`: conflito O1, janela válida
- `CROSS-V1-01`: cross-sell desativado
- `QUEUE-V1-01`, `QUEUE-V1-02`: filas corretas
- `FRONTIER-RECENCIA` (12 casos): thresholds exatos 29/30/31/.../121 dias
- `FRONTIER-FATURAMENTO` (10 casos): limites exatos de cada tier

---

## 14. Restrições de produção

- `FIRESTORE_WRITES = ZERO` — scores não são persistidos automaticamente
- `FUNCTIONS_DEPLOY = ZERO` — nenhum deploy realizado nesta fase
- `LLM = ZERO` — motor é 100% determinístico, sem IA generativa
- `WHATSAPP = ZERO`, `EMAIL = ZERO` — sem envio de mensagens

Qualquer persistência de scores deve ser autorizada explicitamente pelo proprietário em fase posterior.
