# Pendências — Decisões Humanas Necessárias

**Este documento lista decisões que NÃO devem ser inventadas pelo sistema.**
**Cada item bloqueia apenas sua funcionalidade específica — não o desenvolvimento estrutural.**

---

## Score Comercial

| # | Pendência | Impacto |
|---|-----------|---------|
| S1 | Pesos definitivos de cada componente do score | Score atual usa pesos PROVISÓRIOS marcados explicitamente |
| S2 | Thresholds comerciais (ex: score >= X = "cliente quente") | Classificações provisórias sem validação empresarial |
| S3 | Quais componentes entram no score (ex: incluir diversidade de categoria?) | Estrutura modular — componentes podem ser adicionados |

## Encarteiramento

| # | Pendência | Impacto |
|---|-----------|---------|
| E1 | Regra de encarteiramento: como associar cliente → vendedor responsável | `vendedorUltimaVendaId` é dado transacional, não carteira |
| E2 | Quais oportunidades são visíveis para qual vendedor | Motor de oportunidades gera para todos — filtro por vendedor = pendente |

## Devoluções e Estornos

| # | Pendência | Impacto |
|---|-----------|---------|
| D1 | Tratamento de vendas devolvidas/estornadas no Perfil360 | Atualmente só `Concretizada` conta — devoluções não subtraem faturamento |
| D2 | Status GC que representa devolução/estorno | Não mapeado |

## Oportunidades

| # | Pendência | Impacto |
|---|-----------|---------|
| O1 | Thresholds para `REATIVACAO_120D` (comunicar antes dos 120d?) | Definir janela de alerta (ex: 90d, 100d, 110d) |
| O2 | Política de cross-sell: quais categorias são complementares? | Motor usa heurística estrutural genérica |
| O3 | Nível mínimo de evidência para criar oportunidade | Definir `SEM_BASE` threshold por tipo |

## IA

| # | Pendência | Impacto |
|---|-----------|---------|
| I1 | Provider real de LLM (Claude API, GPT-4, etc.) | Usando MockProvider até decisão |
| I2 | Orçamento de tokens por execução | Sem limite implementado |
| I3 | Frequência dos agentes (horária, diária, por evento?) | MockProvider não tem custo; produção precisa definir |
| I4 | Retenção de traces de IA | Estrutura local; persistência em produção = pendente |

## Atribuição

| # | Pendência | Impacto |
|---|-----------|---------|
| A1 | Janela oficial de atribuição (ex: compra em até X dias = atribuída) | Arquitetura pronta; janela não definida |
| A2 | Quem valida `ATRIBUIDA` → humano ou automático? | Decisão de processo |
| A3 | Reconciliação financeira de ROI | Fora do escopo desta fase |

## Interface

| # | Pendência | Impacto |
|---|-----------|---------|
| U1 | Permissões de UI: quem vê quais oportunidades | API interna pronta; controle de acesso = pendente |
| U2 | Layout e UX do assistente de vendas | Backend implementado; UI = pendente |

---

## Itens que NÃO são pendências (já definidos)

- Somente `nome_situacao === 'Concretizada'` conta como compra ✓
- Inatividade = 120 dias desde última compra ✓
- `nuncaComprou` ≠ cliente inativo ✓
- Frequência por datas distintas ✓
- Janelas: 30/60/90/180d ✓
- Encarteiramento NÃO inferido do vendedor da venda ✓
- IA nunca altera preço/desconto/crédito/limite/carteira ✓
- Valores monetários cents-safe ✓
