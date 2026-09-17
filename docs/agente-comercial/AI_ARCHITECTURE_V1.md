# AI Architecture V1 — Agente Comercial MR4

**Versão:** servico-v2 / grounding-v2  
**Fase:** N25 — Preparação da Camada de IA Real  
**Status:** SHADOW MODE — sem side effects, sem chamadas LLM reais

---

## 1. Princípio fundamental

> A IA fica **depois** dos cálculos determinísticos. Ela **nunca é fonte** de métricas.

O pipeline determinístico — score, tendência, recorrência, oportunidades, prioridade — executa primeiro. A camada de IA recebe os resultados prontos e apenas **analisa, explica e sugere** com base nesses dados.

```
GestãoClick → Perfil360 → [Score → Tendência → Recorrência → Oportunidades → Prioridade]
                                ↓ facts imutáveis
                           GroundingFacts V2
                                ↓
              [analistaCliente → analistaOportunidade? → assistenteVendedor?]
                                ↓
                      explicadorComercial? → auditorIA
                                ↓
                           Resultado SHADOW
```

---

## 2. Agentes V1

| Agente | Arquivo | Tipo de output | Obrigatório |
|--------|---------|----------------|-------------|
| `analistaCliente` | `agents/analistaCliente.js` | `ANALISE` | Sim |
| `analistaOportunidade` | `agents/analistaOportunidade.js` | `ANALISE` | Opcional |
| `assistenteVendedor` | `agents/assistenteVendedor.js` | `SUGESTAO` | Opcional |
| `auditorIA` | `agents/auditorIA.js` | `AUDITORIA` | Sim |
| `explicadorComercial` | `agents/explicadorComercial.js` | `EXPLICACAO` | Opcional |

### O que cada agente **nunca pode fazer**

- Calcular ou inventar: score, dias sem comprar, faturamento, ticket, frequência, recorrência, tendência, prioridade, pedidos, datas, valores
- Executar side effects: CRIAR_PEDIDO, ENVIAR_WHATSAPP, ALTERAR_ENCARTEIRAMENTO, etc.
- Tomar decisões financeiras (`AI_FINANCIAL_AUTHORITY = 'NONE'`)

---

## 3. GroundingFacts V2

Construído por `buildGroundingFacts(perfil, score, tendencia, recorrencia, opcoes)`.

### Campos obrigatórios nos facts

```
clienteMr4Id, _versaoGrounding, _buildEm,
nuncaComprou, inativo120d,
diasSemComprar, ultimaCompraEm, primeiraCompraEm, dataReferencia,
faturamentoTotalCents, faturamento30dCents, faturamento90dCents,
pedidosTotal, pedidos90d,
ticketMedioCents, diasEntreComprasMedio, diasEntreComprasMediana,
scoreTotal, classificacao,
tendencia, recorrenciaStatus
```

### Campos opcionais (via `opcoes`)

```
oportunidadeTipo, oportunidadePrioridade,
produtosIds[], categoriasIds[]
```

### Regra de uso nos prompts

O prompt recebe **apenas os facts**, nunca o `perfil` bruto. Valores monetários são sempre em centavos nos facts e convertidos para `R$` apenas na camada de texto do prompt.

---

## 4. Claims e validação

Todo output de agente que afirmar um fato factual **deve declarar claims**. Um output sem claims bloqueia (`OUTPUT_SEM_CLAIMS = BLOCK`).

### Campos permitidos em claims

Apenas campos que existem em `GroundingFacts`. Campos inventados ou internos (`_versaoGrounding`, `_buildEm`) bloqueiam com `GroundingViolationError`.

### Validação em texto livre (`validarFatosNoTexto`)

Padrões detectados e validados contra claims/facts:
- `R$ N.NNN` — valor monetário
- `YYYY-MM-DD` — data ISO
- `N dias` — contagem de dias

Afirmação no texto sem claim correspondente → `TextFactViolationError` (BLOCK).

---

## 5. Guardrails

**Arquivo:** `lib/ai/guardrails.js`

### Marcadores proibidos (BLOCK imediato)

Qualquer output contendo estes strings é bloqueado com `GuardrailViolationError`:

```
CRIAR_PEDIDO, ENVIAR_WHATSAPP, CRIAR_TAREFA, ALTERAR_DADOS,
EXECUTAR_ACAO, APROVADO, CONCEDER_DESCONTO,
APROVAR_DESCONTO, DEFINIR_DESCONTO, APROVAR_CREDITO, DEFINIR_CREDITO,
APROVAR_PRAZO, DEFINIR_PRAZO, ALTERAR_COMISSAO, ALTERAR_ENCARTEIRAMENTO,
APROVAR_DEVOLUCAO, APROVAR_GARANTIA, CANCELAR_VENDA
```

### Prompt injection (verificarInputSeguro)

Padrões detectados em campos de dados ERP antes de montar prompts:
- `IGNORE`, `SYSTEM PROMPT`, `PRETEND YOU ARE`, `JAILBREAK`, `DAN MODE`
- `FORGET YOUR RULES`, `MUDE O SCORE`, `REVELE O PROMPT`
- `CONSIDERE ESTE CLIENTE VIP`, `APROVADO AUTOMATICAMENTE`, `CRÉDITO LIBERADO`
- `IGNORE PREVIOUS`, `YOU ARE NOW`, `50% DE DESCONTO`, `DAR DESCONTO`

Campos sanitizados por `sanitizarDadoParaPrompt` antes de ir ao LLM.

### AI_FINANCIAL_AUTHORITY = 'NONE'

A IA não possui autoridade financeira de nenhum tipo. Qualquer tentativa de exercer autoridade financeira no output é bloqueada.

---

## 6. Provider

**Arquivo:** `lib/ai/provider.js`

### MockProvider

- Permitido apenas em `NODE_ENV ∈ {test, development, simulation, offline}`
- Bloqueado em `production` com erro explícito
- Retorna `mock: true, latenciaMs: 0`

### Interface de provider real (stub)

**Arquivo:** `lib/ai/providers/realProvider.interface.js`

```javascript
// provider.complete(prompt, opcoes) → Promise<{ texto, tokens, modelo, latenciaMs }>
// provider.nome → string
```

Nenhum SDK real está importado. Nenhuma API key está configurada. O provider real será escolhido e implementado na N26.

---

## 7. Shadow Mode

**`AI_MODE = 'SHADOW'`** (constante em `servicoAgenteComercial.js`)

Em shadow mode:
- Pipeline executa completo com MockProvider
- Resultado **não vai ao vendedor**
- `sideEffects = []` sempre
- `statusServico = 'SHADOW'`

Shadow mode será desativado apenas após aprovação explícita (N26+).

---

## 8. Trace

O trace registra spans de cada etapa do pipeline sem expor PII:

- **Não inclui:** telefone, email, cpf, cnpj, endereço, nome_cliente
- **Não inclui:** payload bruto de perfil (produtosComprados, faturamentoTotal)
- **Inclui:** traceId, versao, iniciadoEm, finalizado, spans[], resumo{scoreTotal, aiMode}

---

## 9. Versões

| Componente | Versão |
|------------|--------|
| `VERSAO_ENGINE` | (em `scoreComercial.js` — não alterada) |
| `VERSAO_SERVICO` | `servico-v2` |
| `VERSAO_GROUNDING` | `grounding-v2` |
| Agentes | `1.0.0` (todos) |
| Prompts | `1.0.0` (todos) |

---

## 10. Restrições absolutas permanentes

- `LLM_REAL_CALLS = ZERO` até N26
- `FIRESTORE_PROD_WRITES = ZERO`
- `GESTAOCLICK_WRITES = ZERO`
- Não tocar em: `calcBancoMes`, `buildEspelhoSnapshot`, `canonicalizarSnapshot`, `calcRevisaoPeriodo`, `calcConcluirRevisao`, `VERSAO_ENGINE`
- Dados protegidos: Ademir, Fabiana, Camila, Gutemberg, Swyanne, Murilo, FUNC_TESTE_001
