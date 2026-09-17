# RELATORIO_NOTURNO — Agente Comercial IA

**Data:** 2026-09-16  
**START_HEAD:** `9df7945`  
**END_HEAD:** `398fabb`  
**Diretório:** `~/Library/Mobile Documents/com~apple~CloudDocs/MR4 IA/mr4-sistema` (iCloud)

---

## Resumo Executivo

Implementação completa do Agente Comercial IA em modo **OFFLINE/DRY-RUN/MOCK**.

**7 commits**, **19 fases** (N0 de sessão anterior + N1-N18 esta sessão), **651 testes unitários passando**.

**Zero:**
- Writes em Firestore ✓
- Deploy Firebase ✓
- Chamadas a LLM real ✓
- Calls ao GestãoClick ✓
- Alteração de dados de produção ✓

---

## Commits da Sessão

| SHA | Fase | Descrição |
|-----|------|-----------|
| `3125675` | N0 | Fundação Perfil360: lock de concorrência, testes CATEG360/LOCK360 |
| `813d1c6` | N1 | Contrato, arquitetura e pendências documentadas |
| `4fb1408` | N2-N5 | Score, Tendência, Recorrência, Oportunidades + 73 testes |
| `900f508` | N6-N7 | Priorizador e Guardrails + 35 testes |
| `5638779` | N8-N11 | Agentes, MockProvider, Prompts, Validator + 20 testes |
| `99c9ac2` | N12-N15 | Trace, Simulação, Adversarial, Fixtures + 16 testes |
| `398fabb` | N16-N18 | Atribuição, Serviço, Documentação + 13 testes |

---

## Arquivos Criados

### Motores Determinísticos (sem LLM, sem I/O)
- `functions/config/score-comercial.v1.js` — configuração versionada dos pesos
- `functions/lib/scoreComercial.js` — score 0-100 por 6 componentes
- `functions/lib/tendenciaComercial.js` — CRESCENDO/ESTAVEL/CAINDO/SEM_BASE
- `functions/lib/recorrencia.js` — padrão histórico de recompra
- `functions/lib/oportunidades.js` — 5 tipos com IDs determinísticos
- `functions/lib/priorizadorOportunidades.js` — ranqueamento por urgência

### Camada de IA (MockProvider apenas)
- `functions/lib/ai/guardrails.js` — segurança, marcadores proibidos, jailbreak detection
- `functions/lib/ai/provider.js` — MockProvider + criarProvider()
- `functions/lib/ai/trace.js` — rastreabilidade por spans
- `functions/lib/ai/validatorOutput.js` — validação de schema
- `functions/lib/ai/atribuicao.js` — correlação, não causalidade
- `functions/lib/ai/servicoAgenteComercial.js` — pipeline orquestrado
- `functions/lib/ai/agents/analistaCliente.js`
- `functions/lib/ai/agents/explicadorComercial.js`
- `functions/lib/ai/agents/auditorIA.js`
- `functions/lib/ai/prompts/analiseCliente.js`
- `functions/lib/ai/prompts/explicadorScore.js`

### Scripts
- `scripts/simular-agente-comercial.js` — 10 cenários sintéticos, DRY-RUN

### Testes
- `functions/test/score360.test.js` — SCORE360-01–11
- `functions/test/tendencia360.test.js` — TEND360-01–10
- `functions/test/recorrencia360.test.js` — RECORR360-01–09
- `functions/test/oportunidades360.test.js` — OPORT360-01–12
- `functions/test/priorizador360.test.js` — PRIO360-01–10
- `functions/test/guardrails360.test.js` — GUARD360-01–09
- `functions/test/agentes360.test.js` — AGENT360-01–20
- `functions/test/adversarial360.test.js` — ADV360-01–16
- `functions/test/servico360.test.js` — SERV360-01–12
- `functions/test/fixtures/agente-comercial/perfis-fixture.js`

### Documentação
- `docs/agente-comercial/README.md`
- `docs/agente-comercial/SCORE.md`
- `docs/agente-comercial/OPORTUNIDADES.md`
- `docs/agente-comercial/AI_GUARDRAILS.md`
- `docs/agente-comercial/AGENTS.md`
- `docs/agente-comercial/ATTRIBUTION.md`
- `docs/agente-comercial/PERFIL360_CONTRACT.md` (N1)
- `docs/agente-comercial/ARCHITECTURE.md` (N1)
- `docs/agente-comercial/PENDENCIAS.md` (N1)

---

## Resultado dos Testes

```
Tests:       651 passed, 651 total
Test Suites: 27 passed, 27 total (unit tests only)
Failures:    0
```

Falhas esperadas (emulator-dependentes, pré-existentes, sem relação com esta sessão):
- `emulator.e2e.test.js`, `rules*.test.js`, `gc-rules.test.js`, etc.
  (requerem Firebase Emulator rodando)

---

## Simulação — 10 Cenários

```
Total simulados: 10
Conformes:       10/10
Mock mode:       10/10
Zero escrita:    ✓ (DRY-RUN)
Zero LLM real:   ✓ (MockProvider)
```

---

## Decisões Pendentes

Ver `docs/agente-comercial/PENDENCIAS.md` para lista completa.

Principais:
- **S1:** Calibração dos pesos do score com dados reais
- **I1:** Escolha do modelo LLM para produção
- **A1:** Janela temporal de atribuição (atual: 30 dias provisional)
- **E1:** Regras de encarteiramento (atribuição de clientes a vendedores)

---

## Gates de Segurança Verificados

- [x] Nenhum write em Firestore
- [x] Nenhum deploy Firebase Functions/Hosting/Rules
- [x] Nenhuma mudança em IAM ou Firebase Auth
- [x] MockProvider: zero chamadas a LLM real
- [x] Nenhuma chamada ao GestãoClick (write)
- [x] Nenhuma alteração em dados de produção
- [x] mr4-webhook intacto
- [x] calcBancoMes / buildEspelhoSnapshot / VERSAO_ENGINE intactos
- [x] Firebase Hosting continua desabilitado
- [x] Nenhuma credencial ou secret exposto nos commits
- [x] Diretório iCloud exclusivo (Dropbox não tocado)
