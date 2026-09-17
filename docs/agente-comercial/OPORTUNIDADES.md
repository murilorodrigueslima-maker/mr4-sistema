# Motor de Oportunidades Comerciais V1

**Arquivo:** `functions/lib/oportunidades.js`  
**Priorizador:** `functions/lib/priorizadorOportunidades.js`  
**Status:** PROVISIONAL — thresholds e prioridades não validados empresarialmente

## Tipos de Oportunidade

| Tipo | Condição | Prioridade Base |
|------|----------|----------------|
| `NUNCA_COMPROU` | `nuncaComprou = true` | 30 |
| `REATIVACAO_120D` | `inativo120d = true` e `nuncaComprou = false` | 50-100 (decai com tempo) |
| `QUEDA_DE_COMPRAS` | Tendência = CAINDO + ativo + não-nuncaComprou | 65 |
| `JANELA_DE_RECOMPRA` | Recorrência = PROXIMO_DA_JANELA | 60 |
| `JANELA_DE_RECOMPRA` | Recorrência = ATRASADO_VS_HISTORICO | 75 |
| `CROSS_SELL_CATEGORIA` | 1 categoria + ≥ 3 pedidos + ativo | 40 |

## Regras de Exclusão

- `nuncaComprou = true` → apenas `NUNCA_COMPROU` (sem outros tipos)
- `inativo120d = true` → sem `QUEDA_DE_COMPRAS` ou `CROSS_SELL_CATEGORIA`
- `pedidosTotal < 3` → sem `CROSS_SELL_CATEGORIA`
- `categoriasMaisCompradas.length != 1` → sem `CROSS_SELL_CATEGORIA`

## Priorizador

Ajuste na prioridade final:
- `faturamentoTotal >= R$10.000` → +15 pts
- `faturamentoTotal >= R$5.000` → +8 pts
- `diasSemComprar > 365` → -10 pts

Score do cliente é **informativo** no priorizador — não entra no cálculo da prioridade.

## IDs Determinísticos

`id = sha1(clienteMr4Id + ':' + tipo + ':' + dataReferencia).slice(0,16)`

Garante idempotência: mesma análise no mesmo dia gera o mesmo ID.

## Decisões Pendentes

Ver PENDENCIAS.md: O1 (thresholds de inatividade), O2 (prioridades), O3 (cross-sell critérios).
