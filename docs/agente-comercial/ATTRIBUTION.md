# Arquitetura de Atribuição

**Arquivo:** `functions/lib/ai/atribuicao.js`  
**Versão:** `atribuicao-v1`  
**Status:** PROVISIONAL — decisões A1-A3 pendentes

## Princípio Fundamental

> "Atribuição não é causal."

O fato de a IA ter sugerido uma oportunidade **não significa** que causou a venda.  
O vendedor **sempre** decide. A IA apenas informa.

Todo registro de atribuição carrega o campo:
```
"avisoAtribuicao": "CORRELAÇÃO, NÃO CAUSALIDADE: a IA informou, o vendedor decidiu."
```

## Estrutura de um Registro

```json
{
  "id": "attr_1726512345_a3b2",
  "clienteMr4Id": "...",
  "vendedorId": "...",
  "tipoAcao": "CONTATO",
  "dataAcao": "2026-09-16",
  "oportunidadesRef": ["id_da_oportunidade"],
  "analiseRef": "trace_id_da_analise",
  "observacao": null,
  "versaoAtribuicao": "atribuicao-v1",
  "statusAtribuicao": "PROVISIONAL",
  "avisoAtribuicao": "CORRELAÇÃO, NÃO CAUSALIDADE...",
  "criadoEm": "..."
}
```

## Janela de Atribuição (PROVISIONAL)

`JANELA_ATRIBUICAO_DIAS_PROVISIONAL = 30 dias`

Se uma oportunidade foi gerada até 30 dias antes da ação do vendedor,
considera-se que ela estava "dentro da janela" e pode ser referenciada.

**Pendente (A1):** Definir janela correta com dados reais.

## Decisões Pendentes

| ID | Decisão |
|----|---------|
| A1 | Janela temporal de atribuição (atual: 30 dias) |
| A2 | Critérios de match oportunidade → ação |
| A3 | Persistência: onde e como armazenar registros |

## O que NÃO fazer

- Nunca afirmar que "a IA causou a venda"
- Nunca usar atribuição para comissionar ou penalizar vendedores automaticamente
- Nunca criar atribuições retroativas sem consentimento do vendedor
