# PERFIL360 — Contrato Canônico V1

**Versão do motor:** `1.0.0` (constante `VERSAO_ENGINE` em `perfil360.js`)
**Coleção Firestore:** `perfis_360`
**Document ID:** `clienteMr4Id` (ID do documento em `clientes`)

---

## Schema completo

```typescript
interface Perfil360 {
  // Identificadores
  clienteMr4Id:  string;   // ID Firestore do cliente MR4 (não-nulo)
  gestaoClickId: string;   // ID do cliente no GestãoClick (não-nulo)

  // Datas históricas
  primeiraCompraEm: string | null;  // YYYY-MM-DD | null se nunca comprou
  ultimaCompraEm:   string | null;  // YYYY-MM-DD | null se nunca comprou
  diasSemComprar:   number | null;  // inteiro >= 0 | null se nunca comprou

  // Faturamento por janela (reais, 2 casas decimais)
  faturamento30d:   number;  // janela [ref-29, ref] inclusive
  faturamento60d:   number;  // janela [ref-59, ref] inclusive
  faturamento90d:   number;  // janela [ref-89, ref] inclusive
  faturamento180d:  number;  // janela [ref-179, ref] inclusive
  faturamentoTotal: number;  // histórico completo desde HISTORICO_INICIO

  // Pedidos por janela (contagem de vendas Concretizadas)
  pedidos30d:   number;
  pedidos60d:   number;
  pedidos90d:   number;
  pedidos180d:  number;
  pedidosTotal: number;

  // Ticket médio por janela (reais, arredondado ao centavo | null se sem pedidos)
  ticketMedio30d:   number | null;
  ticketMedio60d:   number | null;
  ticketMedio90d:   number | null;
  ticketMedio180d:  number | null;
  ticketMedioTotal: number | null;

  // Frequência (por dias distintos com compra, mín. 2 datas distintas para calcular)
  diasEntreComprasMedio:   number | null;
  diasEntreComprasMediana: number | null;

  // Produtos e categorias
  quantidadeProdutosDistintos: number;
  produtosMaisComprados:   ProdutoResumo[];   // top 10, sorted
  categoriasMaisCompradas: CategoriaResumo[]; // top 10, sorted

  // Vendedor da última venda (NÃO indica carteira — apenas dado transacional)
  vendedorUltimaVendaId:   string | null;
  vendedorUltimaVendaNome: string | null;

  // Flags
  inativo120d:  boolean;  // true se diasSemComprar >= 120
  nuncaComprou: boolean;  // true se zero vendas Concretizadas

  // Metadados
  calculadoEm:      string | null;  // ISO 8601 do momento de cálculo
  dataReferencia:   string;         // YYYY-MM-DD base do cálculo
  versaoEngine:     string;         // '1.0.0'
  historicoCoberto: { inicio: string; fim: string } | null;

  // Debug interno (não usar em UI/IA)
  _conflicts: ConflictRecord[];
}

interface ProdutoResumo {
  produtoId:          string;
  nome:               string;
  quantidadeUnidades: number;   // soma das quantidades (3 decimais)
  quantidadePedidos:  number;   // COUNT DISTINCT venda.id
  faturamento:        number;   // reais
}

interface CategoriaResumo {
  categoria:          string;   // nome_grupo do produto | 'SEM_CATEGORIA'
  quantidadeUnidades: number;
  quantidadePedidos:  number;   // COUNT DISTINCT venda.id nessa categoria
  faturamento:        number;   // reais
}
```

---

## Regras de negócio invariantes

### 1. Somente vendas Concretizadas

```
nome_situacao === 'Concretizada'
```

Canceladas, Em aberto, Devolvidas — ignoradas para todos os cálculos.

### 2. Inatividade comercial

```
inativo120d = diasSemComprar >= 120
```

Exatamente 120 dias = inativo. Contato (ligação, WhatsApp) **não** reinicia os 120 dias.

### 3. Cliente sem compra

```
nuncaComprou = true
ultimaCompraEm = null
diasSemComprar = null
inativo120d = false
```

"Nunca comprou" ≠ cliente inativo. São estados mutuamente exclusivos.

### 4. Receita oficial da venda

```
venda.valor_total
```

Itens (`produtos`) são métricas complementares para análise de produto/categoria.
A soma dos `valor_total` dos itens pode divergir do `venda.valor_total` por arredondamento — usar sempre o campo da venda para faturamento.

### 5. Frequência por datas distintas

Pedidos distintos no mesmo dia contam separadamente para faturamento e pedidosTotal, mas representam **uma única data** para cálculo de intervalos de frequência.

### 6. Janelas temporais (inclusivas)

| Janela | Período |
|--------|---------|
| 30d    | [ref − 29 dias, ref] |
| 60d    | [ref − 59 dias, ref] |
| 90d    | [ref − 89 dias, ref] |
| 180d   | [ref − 179 dias, ref] |

Datas operadas em UTC puro a partir de strings YYYY-MM-DD (sem timezone).

### 7. Encarteiramento — PENDENTE

`vendedorUltimaVendaId` é o vendedor da venda mais recente (critério determinístico), **não** o vendedor da carteira do cliente. Encarteiramento real ainda não está resolvido. Não inferir carteira.

### 8. Cliente não vinculado (gc_id sem match em `clientes`)

Vendas de cliente não vinculado são gravadas no mirror `vendas_gc` mas **não** geram Perfil360. Nenhum dado fictício é criado.

### 9. Devoluções e estornos — PENDENTE

A regra de negócio para devoluções não está resolvida. Continuamos contando somente `nome_situacao === 'Concretizada'` com valor positivo. Nenhuma heurística inventada.

### 10. Valores monetários — cents-safe

Todos os cálculos internos são feitos em centavos inteiros (`Math.round(x * 100)`). Os campos expostos no perfil são convertidos de volta para reais com 2 casas decimais.

---

## Campos que a IA NÃO pode inventar

Os campos abaixo devem vir exclusivamente do motor determinístico:

- `faturamentoTotal`, `faturamento30d`, `faturamento60d`, `faturamento90d`, `faturamento180d`
- `pedidosTotal`, `pedidos30d`, `pedidos60d`, `pedidos90d`, `pedidos180d`
- `ticketMedio*`
- `diasEntreCompras*`
- `primeiraCompraEm`, `ultimaCompraEm`, `diasSemComprar`
- `inativo120d`, `nuncaComprou`
- `categoriasMaisCompradas`, `produtosMaisComprados`

A IA pode **explicar** esses campos em linguagem natural, mas **nunca** alterar, completar ou inferir novos valores.

---

## Ordering determinístico

### produtosMaisComprados (top 10)

1. `quantidadeUnidades` DESC
2. `quantidadePedidos` DESC
3. `faturamento` DESC
4. `produtoId` ASC (tie-break lexicográfico)

### categoriasMaisCompradas (top 10)

1. `faturamento` DESC
2. `quantidadeUnidades` DESC
3. `categoria` ASC (tie-break lexicográfico)

---

## Fonte de categorias

`nome_grupo` vem do endpoint `/produtos` do GestãoClick, re-fetched a cada ciclo incremental. Nunca é armazenado em `vendas_gc`. Produto sem `nome_grupo` → `categoria = 'SEM_CATEGORIA'`.

---

## Limitações conhecidas

| Limitação | Status |
|-----------|--------|
| Encarteiramento | PENDENTE — decisão humana necessária |
| Devoluções/estornos | PENDENTE — regra não definida |
| Histórico de `/produtos` (inativos) | Apenas `ativo=1` buscado no incremental |
| Categorias de vendas antigas | Dependem de produto ainda ativo no GC |
| Reconciliação completa do Perfil360 | PENDENTE |
