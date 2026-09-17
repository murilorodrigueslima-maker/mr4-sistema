# Motor de Score Comercial V1

**Arquivo:** `functions/lib/scoreComercial.js`  
**Config:** `functions/config/score-comercial.v1.js`  
**Status:** PROVISIONAL — pesos não validados empresarialmente

## Componentes do Score (soma de pesos = 100)

| Componente | Peso | O que mede |
|-----------|------|-----------|
| Recência | 25% | Dias desde a última compra |
| Faturamento | 25% | Volume financeiro (total + 90d) |
| Frequência | 20% | Pedidos em 90 dias |
| Tendência | 15% | Trajetória de compras (recebe do motor tendência) |
| Diversidade | 10% | Variedade de categorias |
| Engajamento | 5% | Proporção de janelas com compra |

## Faixas de Score

| Faixa | Range |
|-------|-------|
| EXCELENTE | 80-100 |
| BOM | 60-79 |
| REGULAR | 40-59 |
| FRACO | 20-39 |
| INATIVO | 0-19 |

## Thresholds de Recência (PROVISIONAL)

| Faixa | Dias | Pontos |
|-------|------|--------|
| Excelente | ≤ 30 | 100 |
| Bom | 31-60 | 75 |
| Regular | 61-90 | 50 |
| Fraco | 91-120 | 25 |
| Inativo | > 120 | 0 |

## Referências de Faturamento (PROVISIONAL)

- `REF_FATURAMENTO_TOTAL = R$10.000` → pontuação base máxima
- `REF_FATURAMENTO_90D = R$3.000` → pontuação 90d boa
- `REF_PEDIDOS_90D = 3` → frequência de referência

## Invariantes

1. `statusConfig = 'PROVISIONAL'` sempre presente no output
2. `scoreTotal` entre 0 e 100
3. Soma dos pesos = 100
4. Determinístico: mesma entrada = mesmo score
5. `nuncaComprou = true` → todos os componentes zerados

## Decisões Pendentes

Ver PENDENCIAS.md: S1 (calibração dos pesos), S2 (thresholds), S3 (referências de faturamento).
