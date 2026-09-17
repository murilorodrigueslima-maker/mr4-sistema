# AI Activation Checklist — Agente Comercial MR4

**Fase atual:** N25 SHADOW MODE  
**Próxima fase:** N26 (provider real — NÃO INICIAR sem completar este checklist)

---

## Status atual: SHADOW MODE ✅

O sistema está em shadow mode. O pipeline executa completamente com MockProvider, mas o resultado não vai ao vendedor e não há side effects.

---

## Checklist de ativação do provider real (N26)

### Pré-requisitos obrigatórios (todos devem ser ✅ antes de N26)

#### A. Testes N25

- [ ] `n25-ai-v1.test.js` — PASS (AI-V1-01 a AI-V1-05)
- [ ] `n25-claims-v1.test.js` — PASS (CLAIM-V1-01 a CLAIM-V1-09b)
- [ ] `n25-text-v1.test.js` — PASS (TEXT-V1-01 a TEXT-V1-03c)
- [ ] `n25-injection-v1.test.js` — PASS (INJECTION-V1-01 a INJECTION-V1-07)
- [ ] `n25-fin-v1.test.js` — PASS (FIN-V1-00 a FIN-V1-08)
- [ ] `n25-shadow-v1.test.js` — PASS (SHADOW-V1-01 a SHADOW-V1-04)
- [ ] `n25-trace-v1.test.js` — PASS (TRACE-V1-01 a TRACE-V1-03)
- [ ] `n25-provider-v1.test.js` — PASS (PROVIDER-V1-01 a PROVIDER-V1-03c)
- [ ] `n25-adversarial-v1.test.js` — PASS (N25-ADV-01 a N25-ADV-60)
- [ ] TOTAL_FAIL = 0 com `npx jest --runInBand`

#### B. Gate N25

- [ ] `N25_GATE = PASS`
- [ ] `LLM_REAL_CALLS_N25 = 0`
- [ ] `PROD_WRITES_N25 = 0`
- [ ] `DEPLOYS_N25 = 0`
- [ ] Commits N25 no main

#### C. Escolha do provider (N26)

- [ ] Provider escolhido: `[ ] OpenAI GPT-4o  [ ] Anthropic Claude  [ ] Gemini`
- [ ] API key gerada e armazenada em Secret Manager (nunca em código)
- [ ] `realProvider.interface.js` implementado (SDK real, não stub)
- [ ] Teste de integração com provider real em ambiente `development` (não `production`)
- [ ] `PROVIDER_V1_INTEGRATION = PASS`

#### D. Configuração de segurança (N26)

- [ ] API key em Secret Manager, nunca exposta em logs
- [ ] Rate limiting configurado
- [ ] Timeout configurado (máximo 10s por chamada)
- [ ] Fallback para MockProvider em caso de falha do provider real
- [ ] Custo máximo por chamada definido e monitorado

#### E. Validação pré-produção (N26)

- [ ] Pipeline completo testado com provider real em `development`
- [ ] Outputs auditados manualmente: nenhum marcador proibido, nenhuma invenção factual
- [ ] Latência p95 < 5s medida
- [ ] `auditorIA` revisado e conforme com todos os outputs de teste
- [ ] Shadow mode mantido por pelo menos 48h em produção antes de ativar entrega ao vendedor

#### F. Ativação gradual (N26)

- [ ] Shadow mode em produção: `AI_MODE = 'SHADOW'` — resultado registrado mas não entregue
- [ ] Revisão manual de 50+ outputs em produção (shadow): todos conformes
- [ ] Ativação para 10% dos clientes ativos
- [ ] Monitoramento por 24h: zero GuardrailViolationError, zero TextFactViolationError
- [ ] Ativação para 100%

---

## O que NUNCA pode mudar ao ativar o provider real

- `calcBancoMes` — INTACTO
- `buildEspelhoSnapshot` — INTACTO
- `canonicalizarSnapshot` — INTACTO
- `calcRevisaoPeriodo` — INTACTO
- `calcConcluirRevisao` — INTACTO
- `VERSAO_ENGINE` — INTACTO
- Dados de: Ademir, Fabiana, Camila, Gutemberg, Swyanne, Murilo, FUNC_TESTE_001 — INTACTOS
- Worker `mr4-webhook` — INTACTO
- `AI_FINANCIAL_AUTHORITY` — permanece `'NONE'`
- `MARCADORES_PROIBIDOS` — apenas pode crescer, nunca encolher
- Firebase Hosting — permanece DESABILITADO

---

## Decisões bloqueadas até N26

| Decisão | Status |
|---------|--------|
| Qual provider usar (OpenAI / Anthropic / Gemini) | PENDENTE |
| Qual modelo exato | PENDENTE |
| Qual temperatura / parâmetros | PENDENTE |
| Custo máximo por cliente/mês | PENDENTE |
| Política de fallback | PENDENTE |
| Quando desativar shadow mode | PENDENTE |

---

## Como executar o checklist de testes N25

```bash
cd "/Users/murilorodrigueslima/Library/Mobile Documents/com~apple~CloudDocs/MR4 IA/mr4-sistema/functions"
npx jest --runInBand --testPathPattern="n25-"
```

Critério de aprovação: `TOTAL_FAIL = 0`

---

**Última atualização:** 2026-09-17  
**Fase:** N25  
**N26 pode começar apenas após:** N25_GATE = PASS
