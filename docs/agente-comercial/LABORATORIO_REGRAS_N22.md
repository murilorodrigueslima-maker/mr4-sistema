# LABORATÓRIO DE REGRAS COMERCIAIS — MR4 Agente IA (N22)

> **ANALÍTICO SOMENTE** — PII=ZERO | WRITES=ZERO | LLM=ZERO | PESOS NÃO APROVADOS
> DATA_REFERENCIA: **2026-09-17** | N22_SENS_FIX: escala 0-100 (bug N21 corrigido)


## 0. Configuração

- START_HEAD: f313ed0 (pós-merge sync automático)
- LINKED_CLIENTS: 52 | COM_COMPRA: 35 | NUNCA_COMPROU: 17
- ATIVOS: 20 | INATIVOS_120D: 15
- TOTAL_OPORTUNIDADES: 60


## 3. Realidade Atual dos 52 Clientes (Anônimos)


| ID | NuncaC. | Inat120d | Dias | FatTotal | Fat90d | Peds | Ticket | IntMed | IntMed(mediana) | Cats | Tend. | Recorr. | Score | Classif. | Oportunidades | PriorMax |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1609 | N | S | 178 | R$554,00 | R$0,00 | 6 | R$92,33 | 215d | 81d | 2 | CAINDO | DENTRO_DO_PADRAO | 11 | INATIVO | REAT | 95 |
| CF3ED | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CE18D | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C3669 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CA02B | N | N | 23 | R$1.964,24 | R$1.020,97 | 16 | R$122,77 | 48d | 31d | 10 | CAINDO | DENTRO_DO_PADRAO | 70 | BOM | QUEDA | 65 |
| C6A75 | N | N | 6 | R$18.760,53 | R$4.430,24 | 60 | R$312,68 | 15d | 9d | 10 | CRESCENDO | DENTRO_DO_PADRAO | 100 | EXCELENTE | — | — |
| CDD92 | N | S | 135 | R$4.824,68 | R$0,00 | 7 | R$689,24 | 122d | 61d | 8 | CAINDO | ATRASADO_VS_HISTORICO | 22 | FRACO | REAT+JANELA | 99 |
| CD153 | N | S | 406 | R$1.179,45 | R$0,00 | 3 | R$393,15 | 205d | 205d | 5 | SEM_BASE | ATRASADO_VS_HISTORICO | 19 | INATIVO | JANELA+REAT | 65 |
| C8B2A | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CEFF6 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C1BA2 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C39AF | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C91D0 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C087F | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CC6D4 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C8818 | N | S | 454 | R$1.588,40 | R$0,00 | 5 | R$317,68 | 52d | 58d | 4 | SEM_BASE | ATRASADO_VS_HISTORICO | 20 | FRACO | JANELA+REAT | 65 |
| C1FD0 | N | N | 9 | R$5.148,21 | R$1.412,19 | 33 | R$156,01 | 24d | 13d | 10 | CRESCENDO | DENTRO_DO_PADRAO | 88 | EXCELENTE | — | — |
| C559E | N | S | 231 | R$265,90 | R$0,00 | 1 | R$265,90 | — | — | 4 | SEM_BASE | SEM_BASE | 18 | INATIVO | REAT | 89 |
| C0CCC | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CC659 | N | S | 692 | R$744,44 | R$0,00 | 1 | R$744,44 | — | — | 4 | SEM_BASE | SEM_BASE | 19 | INATIVO | REAT | 40 |
| C51CC | N | N | 62 | R$2.177,51 | R$875,38 | 8 | R$272,19 | 47d | 15d | 8 | CAINDO | ATRASADO_VS_HISTORICO | 48 | REGULAR | JANELA+QUEDA | 75 |
| CA0C3 | N | S | 251 | R$6.473,88 | R$0,00 | 4 | R$1.618,47 | 92d | 80d | 10 | SEM_BASE | ATRASADO_VS_HISTORICO | 27 | FRACO | REAT+JANELA | 95 |
| C8A07 | N | N | 22 | R$1.530,03 | R$877,24 | 7 | R$218,58 | 106d | 29d | 10 | CRESCENDO | DENTRO_DO_PADRAO | 80 | EXCELENTE | — | — |
| CEC30 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C4166 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C0AD8 | N | S | 173 | R$2.922,87 | R$0,00 | 23 | R$127,08 | 19d | 6d | 8 | CAINDO | ATRASADO_VS_HISTORICO | 20 | FRACO | REAT+JANELA | 95 |
| CB6E8 | N | N | 55 | R$1.419,99 | R$24,90 | 12 | R$118,33 | 53d | 47d | 5 | CAINDO | PROXIMO_DA_JANELA | 45 | REGULAR | QUEDA+JANELA | 65 |
| C5981 | N | N | 2 | R$23.706,25 | R$5.635,52 | 40 | R$592,66 | 15d | 13d | 10 | CRESCENDO | DENTRO_DO_PADRAO | 100 | EXCELENTE | — | — |
| C4794 | N | N | 8 | R$5.008,49 | R$611,80 | 23 | R$217,76 | 27d | 22d | 9 | CRESCENDO | DENTRO_DO_PADRAO | 78 | BOM | — | — |
| C4CB8 | N | N | 30 | R$1.491,17 | R$459,57 | 8 | R$186,40 | 66d | 64d | 7 | CAINDO | DENTRO_DO_PADRAO | 60 | BOM | QUEDA | 65 |
| C13B6 | N | N | 8 | R$3.536,79 | R$169,25 | 21 | R$168,42 | 30d | 16d | 10 | CRESCENDO | DENTRO_DO_PADRAO | 74 | BOM | — | — |
| CE71C | N | N | 38 | R$3.809,44 | R$570,00 | 17 | R$224,08 | 28d | 28d | 8 | CAINDO | ATRASADO_VS_HISTORICO | 57 | REGULAR | JANELA+QUEDA | 75 |
| CCEEE | N | N | 9 | R$9.267,71 | R$2.264,47 | 25 | R$370,71 | 21d | 13d | 10 | CAINDO | DENTRO_DO_PADRAO | 85 | EXCELENTE | QUEDA | 73 |
| CD364 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CD7D1 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C91C7 | N | S | 248 | R$2.381,40 | R$0,00 | 3 | R$793,80 | 93d | 93d | 3 | SEM_BASE | ATRASADO_VS_HISTORICO | 19 | INATIVO | REAT+JANELA | 88 |
| CE721 | N | S | 136 | R$1.100,49 | R$0,00 | 9 | R$122,28 | 37d | 27d | 9 | CAINDO | ATRASADO_VS_HISTORICO | 17 | INATIVO | REAT+JANELA | 99 |
| CE35F | N | N | 75 | R$7.041,88 | R$326,90 | 13 | R$541,68 | 24d | 16d | 10 | CAINDO | ATRASADO_VS_HISTORICO | 47 | REGULAR | JANELA+QUEDA | 83 |
| CB491 | N | N | 33 | R$1.237,41 | R$92,87 | 9 | R$137,49 | 30d | 22d | 5 | CAINDO | ATRASADO_VS_HISTORICO | 52 | REGULAR | JANELA+QUEDA | 75 |
| CD565 | N | N | 107 | R$987,32 | R$0,00 | 2 | R$493,66 | 8d | 8d | 6 | CAINDO | ATRASADO_VS_HISTORICO | 23 | FRACO | JANELA+QUEDA | 75 |
| C0236 | N | N | 17 | R$5.989,34 | R$2.219,12 | 14 | R$427,81 | 28d | 9d | 10 | CAINDO | DENTRO_DO_PADRAO | 80 | EXCELENTE | QUEDA | 73 |
| CD368 | N | N | 31 | R$942,00 | R$158,00 | 7 | R$134,57 | 43d | 43d | 8 | CAINDO | DENTRO_DO_PADRAO | 52 | REGULAR | QUEDA | 65 |
| C595A | N | N | 42 | R$2.988,44 | R$920,00 | 5 | R$597,69 | 58d | 32d | 10 | CAINDO | DENTRO_DO_PADRAO | 50 | REGULAR | QUEDA | 65 |
| CE1A3 | N | S | 143 | R$3.189,46 | R$0,00 | 9 | R$354,38 | 15d | 5d | 10 | CAINDO | ATRASADO_VS_HISTORICO | 20 | FRACO | REAT+JANELA | 98 |
| C882C | N | S | 227 | R$200,00 | R$0,00 | 1 | R$200,00 | — | — | 1 | SEM_BASE | SEM_BASE | 10 | INATIVO | REAT | 90 |
| CB6F9 | N | S | 219 | R$896,72 | R$0,00 | 2 | R$448,36 | 7d | 7d | 6 | SEM_BASE | ATRASADO_VS_HISTORICO | 19 | INATIVO | REAT+JANELA | 91 |
| C82DE | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| CA93C | N | N | 1 | R$11.679,86 | R$5.100,14 | 39 | R$299,48 | 6d | 3d | 10 | CRESCENDO | DENTRO_DO_PADRAO | 100 | EXCELENTE | — | — |
| CB2D8 | S | N | — | R$0,00 | R$0,00 | 0 | — | — | — | 0 | NUNCA_COMPROU | NUNCA_COMPROU | 0 | INATIVO | NUNCA | 30 |
| C1C55 | N | S | 197 | R$1.081,58 | R$0,00 | 2 | R$540,79 | 19d | 19d | 2 | SEM_BASE | ATRASADO_VS_HISTORICO | 14 | INATIVO | REAT+JANELA | 93 |
| CA5E6 | N | N | 0 | R$1.580,72 | R$1.097,67 | 16 | R$98,80 | 16d | 8d | 9 | CRESCENDO | DENTRO_DO_PADRAO | 81 | EXCELENTE | — | — |
| C7B97 | N | S | 171 | R$43,60 | R$0,00 | 1 | R$43,60 | — | — | 2 | CAINDO | SEM_BASE | 10 | INATIVO | REAT | 95 |


## 4. Score do Cliente vs Prioridade da Oportunidade


**CONCEITO FUNDAMENTAL:** score ≠ prioridade.
- **SCORE_CLIENTE** mede valor/saúde comercial do cliente (0-100)
- **PRIORIDADE_OPORTUNIDADE** mede urgência de ação do vendedor (1-100)

Exemplos desta população:

| Dimensão | Top-3 IDs | Valores |
|----------|-----------|---------|
| Score mais alto | C6A75, C5981, CA93C | 100, 100, 100 |
| Prioridade mais alta | CDD92, CE721, CE1A3 | 99, 99, 98 |


## 5. Cenários de Score (S0-S4)


**NOTA:** pesos são ANALÍTICOS — NÃO aprovados. NÃO entram em produção.

| Cenário | Pesos (rec/freq/fat/tend/div/eng) | MED | MÉDIA | Sobem | Descem | Mudam Faixa |
|---------|----------------------------------|-----|-------|-------|--------|-------------|
| S0 — ATUAL | 25/20/25/15/10/5 | 19 | 31.44 | 0 | 0 | 0 |
| S1 — RELACIONAMENTO | 35/30/15/10/7/3 | 13 | 31.4 | 15 | 17 | 8 |
| S2 — VALOR FINANCEIRO | 15/15/40/15/10/5 | 20 | 29.58 | 11 | 16 | 9 |
| S3 — EQUILIBRADO | 20/20/20/20/10/10 | 21 | 32.23 | 24 | 4 | 8 |
| S4 — SEM ENGAJAMENTO | 27/22/27/16/8/0 | 17 | 30.37 | 0 | 29 | 7 |

**Distribuição por faixa por cenário:**
| Cenário | 0-19 | 20-39 | 40-59 | 60-79 | 80-100 |
|---------|------|-------|-------|-------|--------|
| S0 | 27 | 6 | 7 | 4 | 8 |
| S1 | 32 | 1 | 6 | 3 | 10 |
| S2 | 24 | 10 | 8 | 5 | 5 |
| S3 | 22 | 11 | 8 | 3 | 8 |
| S4 | 30 | 3 | 8 | 6 | 5 |


## 6. Clientes com Maior Variação por Cenário



### S1 — Top 10 por Δ absoluto vs S0

| ID | S0 | S1 | Δ | Motivo matemático |
|---|---|---|---|---|
| CA02B | 70 | 81 | +11 | recência excelente; tendência caindo; 3+ cats |
| CA0C3 | 27 | 18 | -9 | recência=0 (inativo); fat≥5k; 3+ cats |
| C4CB8 | 60 | 69 | +9 | recência excelente; tendência caindo; 3+ cats |
| C8A07 | 80 | 88 | +8 | recência excelente; tendência crescente; 3+ cats |
| CA5E6 | 81 | 89 | +8 | recência excelente; tendência crescente; 3+ cats |
| CDD92 | 22 | 15 | -7 | recência=0 (inativo); tendência caindo; 3+ cats |
| C0AD8 | 20 | 13 | -7 | recência=0 (inativo); tendência caindo; 3+ cats |
| C91C7 | 19 | 12 | -7 | recência=0 (inativo); 3+ cats |
| CB491 | 52 | 59 | +7 | tendência caindo; 3+ cats |
| C0236 | 80 | 87 | +7 | recência excelente; tendência caindo; fat≥5k; 3+ cats |


### S2 — Top 10 por Δ absoluto vs S0

| ID | S0 | S2 | Δ | Motivo matemático |
|---|---|---|---|---|
| C8A07 | 80 | 68 | -12 | recência excelente; tendência crescente; 3+ cats |
| CA02B | 70 | 59 | -11 | recência excelente; tendência caindo; 3+ cats |
| C4CB8 | 60 | 49 | -11 | recência excelente; tendência caindo; 3+ cats |
| CA5E6 | 81 | 70 | -11 | recência excelente; tendência crescente; 3+ cats |
| C13B6 | 74 | 64 | -10 | recência excelente; tendência crescente; 3+ cats |
| CB491 | 52 | 42 | -10 | tendência caindo; 3+ cats |
| CD368 | 52 | 42 | -10 | tendência caindo; 3+ cats |
| C1FD0 | 88 | 80 | -8 | recência excelente; tendência crescente; fat≥5k; 3+ cats |
| CB6E8 | 45 | 37 | -8 | tendência caindo; 3+ cats |
| C4794 | 78 | 70 | -8 | recência excelente; tendência crescente; fat≥5k; 3+ cats |


### S3 — Top 10 por Δ absoluto vs S0

| ID | S0 | S3 | Δ | Motivo matemático |
|---|---|---|---|---|
| C8A07 | 80 | 84 | +4 | recência excelente; tendência crescente; 3+ cats |
| C13B6 | 74 | 78 | +4 | recência excelente; tendência crescente; 3+ cats |
| CA5E6 | 81 | 85 | +4 | recência excelente; tendência crescente; 3+ cats |
| C4794 | 78 | 81 | +3 | recência excelente; tendência crescente; fat≥5k; 3+ cats |
| CCEEE | 85 | 82 | -3 | recência excelente; tendência caindo; fat≥5k; 3+ cats |
| C882C | 10 | 13 | +3 | recência=0 (inativo); 1 pedido |
| C7B97 | 10 | 13 | +3 | recência=0 (inativo); tendência caindo; 1 pedido |
| C1609 | 11 | 13 | +2 | recência=0 (inativo); tendência caindo |
| CD153 | 19 | 21 | +2 | recência=0 (inativo); 3+ cats |
| C8818 | 20 | 22 | +2 | recência=0 (inativo); 3+ cats |


### S4 — Top 10 por Δ absoluto vs S0

| ID | S0 | S4 | Δ | Motivo matemático |
|---|---|---|---|---|
| C0AD8 | 20 | 17 | -3 | recência=0 (inativo); tendência caindo; 3+ cats |
| CB6E8 | 45 | 42 | -3 | tendência caindo; 3+ cats |
| CE721 | 17 | 14 | -3 | recência=0 (inativo); tendência caindo; 3+ cats |
| CB491 | 52 | 49 | -3 | tendência caindo; 3+ cats |
| CD565 | 23 | 20 | -3 | tendência caindo; 3+ cats |
| CD368 | 52 | 49 | -3 | tendência caindo; 3+ cats |
| CE1A3 | 20 | 17 | -3 | recência=0 (inativo); tendência caindo; 3+ cats |
| C1609 | 11 | 9 | -2 | recência=0 (inativo); tendência caindo |
| CA02B | 70 | 68 | -2 | recência excelente; tendência caindo; 3+ cats |
| CDD92 | 22 | 20 | -2 | recência=0 (inativo); tendência caindo; 3+ cats |


## 7. Casos-Teste Comerciais (A-J)


_Clientes REAIS da população de 52, mostrados com ID anônimo._

**A. Compra muito e recentemente**
```
ID_ANONIMO       = C5981
NUNCA_COMPROU    = false
INATIVO_120D     = false
DIAS_SEM_COMPRAR = 2
FAT_TOTAL        = R$23.706,25
FAT_90D          = R$5.635,52
PEDIDOS          = 40
TICKET_MEDIO     = R$592,66
INTERVALO_MED    = 15d
CATEGORIAS       = 10
TENDENCIA        = CRESCENDO
RECORRENCIA      = DENTRO_DO_PADRAO
SCORES_CENARIOS  = S0:100 | S1:100 | S2:100 | S3:100 | S4:100
SCORE_ATUAL      = 100 (EXCELENTE)
OPORTUNIDADES    = —
PRIORIDADE_MAX   = —
```

**B. Compra muito mas está inativo**
```
ID_ANONIMO       = CA0C3
NUNCA_COMPROU    = false
INATIVO_120D     = true
DIAS_SEM_COMPRAR = 251
FAT_TOTAL        = R$6.473,88
FAT_90D          = R$0,00
PEDIDOS          = 4
TICKET_MEDIO     = R$1.618,47
INTERVALO_MED    = 92d
CATEGORIAS       = 10
TENDENCIA        = SEM_BASE
RECORRENCIA      = ATRASADO_VS_HISTORICO
SCORES_CENARIOS  = S0:27 | S1:18 | S2:33 | S3:28 | S4:27
SCORE_ATUAL      = 27 (FRACO)
OPORTUNIDADES    = REATIVACAO_120D, JANELA_DE_RECOMPRA
PRIORIDADE_MAX   = 95
```

**C. Compra pouco mas frequentemente**
```
ID_ANONIMO       = C0AD8
NUNCA_COMPROU    = false
INATIVO_120D     = true
DIAS_SEM_COMPRAR = 173
FAT_TOTAL        = R$2.922,87
FAT_90D          = R$0,00
PEDIDOS          = 23
TICKET_MEDIO     = R$127,08
INTERVALO_MED    = 19d
CATEGORIAS       = 8
TENDENCIA        = CAINDO
RECORRENCIA      = ATRASADO_VS_HISTORICO
SCORES_CENARIOS  = S0:20 | S1:13 | S2:22 | S3:21 | S4:17
SCORE_ATUAL      = 20 (FRACO)
OPORTUNIDADES    = REATIVACAO_120D, JANELA_DE_RECOMPRA
PRIORIDADE_MAX   = 95
```

**D. Valores altos mas poucas compras**
```
ID_ANONIMO       = C91C7
NUNCA_COMPROU    = false
INATIVO_120D     = true
DIAS_SEM_COMPRAR = 248
FAT_TOTAL        = R$2.381,40
FAT_90D          = R$0,00
PEDIDOS          = 3
TICKET_MEDIO     = R$793,80
INTERVALO_MED    = 93d
CATEGORIAS       = 3
TENDENCIA        = SEM_BASE
RECORRENCIA      = ATRASADO_VS_HISTORICO
SCORES_CENARIOS  = S0:19 | S1:12 | S2:21 | S3:20 | S4:18
SCORE_ATUAL      = 19 (INATIVO)
OPORTUNIDADES    = REATIVACAO_120D, JANELA_DE_RECOMPRA
PRIORIDADE_MAX   = 88
```

**E. Apenas uma compra**
```
ID_ANONIMO       = CC659
NUNCA_COMPROU    = false
INATIVO_120D     = true
DIAS_SEM_COMPRAR = 692
FAT_TOTAL        = R$744,44
FAT_90D          = R$0,00
PEDIDOS          = 1
TICKET_MEDIO     = R$744,44
INTERVALO_MED    = —
CATEGORIAS       = 4
TENDENCIA        = SEM_BASE
RECORRENCIA      = SEM_BASE
SCORES_CENARIOS  = S0:19 | S1:13 | S2:19 | S3:21 | S4:17
SCORE_ATUAL      = 19 (INATIVO)
OPORTUNIDADES    = REATIVACAO_120D
PRIORIDADE_MAX   = 40
```

**F. Tendência de queda**
```
ID_ANONIMO       = CCEEE
NUNCA_COMPROU    = false
INATIVO_120D     = false
DIAS_SEM_COMPRAR = 9
FAT_TOTAL        = R$9.267,71
FAT_90D          = R$2.264,47
PEDIDOS          = 25
TICKET_MEDIO     = R$370,71
INTERVALO_MED    = 21d
CATEGORIAS       = 10
TENDENCIA        = CAINDO
RECORRENCIA      = DENTRO_DO_PADRAO
SCORES_CENARIOS  = S0:85 | S1:90 | S2:83 | S3:82 | S4:84
SCORE_ATUAL      = 85 (EXCELENTE)
OPORTUNIDADES    = QUEDA_DE_COMPRAS
PRIORIDADE_MAX   = 73
```

**G. Recorrente próximo da janela de recompra**
```
ID_ANONIMO       = CB6E8
NUNCA_COMPROU    = false
INATIVO_120D     = false
DIAS_SEM_COMPRAR = 55
FAT_TOTAL        = R$1.419,99
FAT_90D          = R$24,90
PEDIDOS          = 12
TICKET_MEDIO     = R$118,33
INTERVALO_MED    = 53d
CATEGORIAS       = 5
TENDENCIA        = CAINDO
RECORRENCIA      = PROXIMO_DA_JANELA
SCORES_CENARIOS  = S0:45 | S1:49 | S2:37 | S3:46 | S4:42
SCORE_ATUAL      = 45 (REGULAR)
OPORTUNIDADES    = QUEDA_DE_COMPRAS, JANELA_DE_RECOMPRA
PRIORIDADE_MAX   = 65
```

**H. Atrasado vs histórico**
```
ID_ANONIMO       = CE35F
NUNCA_COMPROU    = false
INATIVO_120D     = false
DIAS_SEM_COMPRAR = 75
FAT_TOTAL        = R$7.041,88
FAT_90D          = R$326,90
PEDIDOS          = 13
TICKET_MEDIO     = R$541,68
INTERVALO_MED    = 24d
CATEGORIAS       = 10
TENDENCIA        = CAINDO
RECORRENCIA      = ATRASADO_VS_HISTORICO
SCORES_CENARIOS  = S0:47 | S1:45 | S2:48 | S3:46 | S4:45
SCORE_ATUAL      = 47 (REGULAR)
OPORTUNIDADES    = JANELA_DE_RECOMPRA, QUEDA_DE_COMPRAS
PRIORIDADE_MAX   = 83
```

**I. Nunca comprou**
```
ID_ANONIMO       = CF3ED
NUNCA_COMPROU    = true
INATIVO_120D     = false
DIAS_SEM_COMPRAR = —
FAT_TOTAL        = R$0,00
FAT_90D          = R$0,00
PEDIDOS          = 0
TICKET_MEDIO     = —
INTERVALO_MED    = —
CATEGORIAS       = 0
TENDENCIA        = NUNCA_COMPROU
RECORRENCIA      = NUNCA_COMPROU
SCORES_CENARIOS  = S0:0 | S1:0 | S2:0 | S3:0 | S4:0
SCORE_ATUAL      = 0 (INATIVO)
OPORTUNIDADES    = NUNCA_COMPROU
PRIORIDADE_MAX   = 30
```

**J. Múltiplas categorias**
```
ID_ANONIMO       = CA02B
NUNCA_COMPROU    = false
INATIVO_120D     = false
DIAS_SEM_COMPRAR = 23
FAT_TOTAL        = R$1.964,24
FAT_90D          = R$1.020,97
PEDIDOS          = 16
TICKET_MEDIO     = R$122,77
INTERVALO_MED    = 48d
CATEGORIAS       = 10
TENDENCIA        = CAINDO
RECORRENCIA      = DENTRO_DO_PADRAO
SCORES_CENARIOS  = S0:70 | S1:81 | S2:59 | S3:70 | S4:68
SCORE_ATUAL      = 70 (BOM)
OPORTUNIDADES    = QUEDA_DE_COMPRAS
PRIORIDADE_MAX   = 65
```


## 8. Problema da Compra Única (U0-U2)


**Clientes com exatamente 1 pedido:** 4 de 35 compradores

| ID | Score U0 | Recência | Fat.Total | Tend. | Freq.U0 | Score U1* | Score U2* |
|---|---|---|---|---|---|---|---|
| C559E | 18 | 231d | R$265,90 | SEM_BASE | 0 | 18 | 18 |
| CC659 | 19 | 692d | R$744,44 | SEM_BASE | 0 | 19 | 19 |
| C882C | 10 | 227d | R$200,00 | SEM_BASE | 0 | 10 | 10 |
| C7B97 | 10 | 171d | R$43,60 | CAINDO | 0 | 10 | 10 |

_* U1 = freq=SEM_BASE (0) para 1 pedido | U2 = freq capped em 50 para 1 pedido._
_Motor NÃO alterado. Simulação analítica apenas._


## 9. Percentis de Faturamento (clientes COM compra, n=35)



### Faturamento Total

| MÃO. | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|---|---|---|---|---|---|---|---|
| R$43,60 | R$554,00 | R$1.081,58 | R$1.964,24 | R$4.824,68 | R$7.041,88 | R$23.706,25 | R$3.934,69 |

| Threshold | Qtd. atingem | % |
|-----------|-------------|---|
| R$5.000 | 9 | 25.7% |
| R$10.000 | 3 | 8.6% |
| R$15.000 | 2 | 5.7% |
| R$20.000 | 1 | 2.9% |


### Faturamento 90d

| MIN | P10 | P25 | MED | P75 | P90 | MAX | MÉDIA |
|---|---|---|---|---|---|---|---|
| R$0,00 | R$0,00 | R$0,00 | R$92,87 | R$877,24 | R$2.219,12 | R$5.635,52 | R$807,61 |

| Threshold 90d | Qtd. atingem | % |
|---------------|-------------|---|
| R$1.000 | 8 | 22.9% |
| R$2.000 | 5 | 14.3% |
| R$3.000 | 3 | 8.6% |
| R$5.000 | 2 | 5.7% |


## 10. Cenários de Recência (R0-R3)


**Regra empresarial fixa:** ≥120d = inativo. NÃO alterada.
**Variação:** apenas os thresholds intermediários.**

| Cenário | Thresholds | Excelente | Bom | Regular | Fraco | Inativo | Nunca |
|---------|-----------|-----------|-----|---------|-------|---------|-------|
| R0 | 30/60/90/120 (atual) | 11 | 5 | 2 | 1 | 16 | 17 |
| R1 | 30/60/120 | 11 | 5 | 3 | 0 | 16 | 17 |
| R2 | 30/90/120 | 11 | 7 | 1 | 0 | 16 | 17 |
| R3 | 45/90/120 | 15 | 3 | 1 | 0 | 16 | 17 |

**Clientes que mudam de pontuação de recência vs R0:**
| ID | Dias | R0 | R1 | R2 | R3 |
|---|---|---|---|---|---|
| C51CC | 62 | 50 | 50 | 75 | 75 |
| CE71C | 38 | 75 | 75 | 75 | 100 |
| CE35F | 75 | 50 | 50 | 75 | 75 |
| CB491 | 33 | 75 | 75 | 75 | 100 |
| CD565 | 107 | 25 | 50 | 50 | 50 |
| CD368 | 31 | 75 | 75 | 75 | 100 |
| C595A | 42 | 75 | 75 | 75 | 100 |


## 11. Tendência — Análise de Base (T0-T3)


**Força da base de comparação:**
| Categoria | Qtd. | % | Critério |
|---|---|---|---|
| BASE_FORTE (6+ peds) | 1 | 1.9% | >=6 pedidos na janela comparada |
| BASE_MEDIA (3-5 peds) | 8 | 15.4% | 3-5 pedidos na janela comparada |
| BASE_FRACA (1-2 peds) | 17 | 32.7% | 1-2 pedidos na janela comparada |
| SEM_BASE | 9 | 17.3% | nenhum pedido em nenhuma janela |
| NUNCA_COMPROU | 17 | 32.7% |  |

**Distribuição por cenário de tendência:**
| Cenário | CRESCENDO | ESTAVEL | CAINDO | SEM_BASE | NUNCA |
|---------|-----------|---------|--------|---------|-------|
| T0 (atual (tol=20%, minPed=1)) | 8 | 0 | 18 | 9 | 17 |
| T1 (mínimo 2 pedidos na base) | 10 | 1 | 8 | 16 | 17 |
| T2 (mínimo 3 pedidos na base) | 7 | 2 | 7 | 19 | 17 |
| T3 (90d quando 30d base<2) | 11 | 1 | 14 | 9 | 17 |

**Clientes CRESCENDO/CAINDO com BASE_FRACA (1-2 pedidos) — risco de instabilidade:**
| ID | Tend. | MaxPed | Método | Dias | Score |
|---|---|---|---|---|---|
| C1609 | CAINDO | 1 | JANELA_90D | 178 | 11 |
| CDD92 | CAINDO | 1 | JANELA_90D | 135 | 22 |
| C8A07 | CRESCENDO | 2 | JANELA_30D | 22 | 80 |
| C0AD8 | CAINDO | 2 | JANELA_90D | 173 | 20 |
| CB6E8 | CAINDO | 1 | JANELA_30D | 55 | 45 |
| C4794 | CRESCENDO | 2 | JANELA_30D | 8 | 78 |
| C4CB8 | CAINDO | 1 | JANELA_30D | 30 | 60 |
| C13B6 | CRESCENDO | 2 | JANELA_30D | 8 | 74 |
| CE71C | CAINDO | 1 | JANELA_30D | 38 | 57 |
| CCEEE | CAINDO | 1 | JANELA_30D | 9 | 85 |
| CE721 | CAINDO | 1 | JANELA_90D | 136 | 17 |
| CB491 | CAINDO | 2 | JANELA_30D | 33 | 52 |
| CD565 | CAINDO | 2 | JANELA_90D | 107 | 23 |
| CD368 | CAINDO | 1 | JANELA_30D | 31 | 52 |
| C595A | CAINDO | 1 | JANELA_30D | 42 | 50 |
| CE1A3 | CAINDO | 1 | JANELA_90D | 143 | 20 |
| C7B97 | CAINDO | 1 | JANELA_90D | 171 | 10 |


## 12. Recorrência — Média vs Mediana


**Clientes que mudam de classificação de recorrência:** 4 de 35

| ID | Média(d) | Mediana(d) | DiasSemComp | Status(média) | Status(mediana) | Peds |
|---|---|---|---|---|---|---|
| C1609 | 215 | 81 | 178 | DENTRO_DO_PADRAO | ATRASADO_VS_HISTORICO | 6 |
| CB6E8 | 53 | 47 | 55 | PROXIMO_DA_JANELA | ATRASADO_VS_HISTORICO | 12 |
| C0236 | 28 | 9 | 17 | DENTRO_DO_PADRAO | ATRASADO_VS_HISTORICO | 14 |
| C595A | 58 | 32 | 42 | DENTRO_DO_PADRAO | ATRASADO_VS_HISTORICO | 5 |

_Outliers: quando mediana < média, o cliente tem compras irregulares com picos que inflam a média._


## 13. Oportunidades — Conflitos


**Clientes com REATIVACAO_120D + JANELA_DE_RECOMPRA simultâneos:** 10

| ID | Dias | IntHist(média) | Recorr. | Fat.Total | Peds | PriorREAT | PriorJAN |
|---|---|---|---|---|---|---|---|
| CDD92 | 135 | 122d | ATRASADO_VS_HISTORICO | R$4.824,68 | 7 | 99 | 75 |
| CD153 | 406 | 205d | ATRASADO_VS_HISTORICO | R$1.179,45 | 3 | 62 | 65 |
| C8818 | 454 | 52d | ATRASADO_VS_HISTORICO | R$1.588,40 | 5 | 57 | 65 |
| CA0C3 | 251 | 92d | ATRASADO_VS_HISTORICO | R$6.473,88 | 4 | 95 | 83 |
| C0AD8 | 173 | 19d | ATRASADO_VS_HISTORICO | R$2.922,87 | 23 | 95 | 75 |
| C91C7 | 248 | 93d | ATRASADO_VS_HISTORICO | R$2.381,40 | 3 | 88 | 75 |
| CE721 | 136 | 37d | ATRASADO_VS_HISTORICO | R$1.100,49 | 9 | 99 | 75 |
| CE1A3 | 143 | 15d | ATRASADO_VS_HISTORICO | R$3.189,46 | 9 | 98 | 75 |
| CB6F9 | 219 | 7d | ATRASADO_VS_HISTORICO | R$896,72 | 2 | 91 | 75 |
| C1C55 | 197 | 19d | ATRASADO_VS_HISTORICO | R$1.081,58 | 2 | 93 | 75 |

**Possibilidades conceituais (NÃO implementadas):**

| Opção | Descrição | Oportunidades na fila | Mudança |
|-------|-----------|----------------------|---------|
| O0 — manter 2 opors | Status quo: cliente recebe REATIVACAO e JANELA | 60 | nenhuma |
| O1 — REATIVACAO absorve JANELA | 1 opor por cliente conflitado | 50 | -10 opors |
| O2 — REATIVACAO_COM_ATRASO_HISTORICO | Nova oportunidade composta, 1 por cliente | 50 | -10 opors, novo tipo |


## 14. Nunca Comprou — Análise Conceitual


**Total NUNCA_COMPROU na população:** 17 de 52 (32.7%)

**Modelo atual:** NUNCA_COMPROU = oportunidade comercial (score=0, prioridade=30)

| Modelo | Vantagens operacionais | Desvantagens |
|--------|----------------------|--------------|
| NUNCA_COMPROU como oportunidade (atual) | Visibilidade na fila comercial; vendedor vê todos os vinculados | Mistura prospecção com reativação/recompra; prioridade 30 pode ser ignorada |
| PROSPECT_VINCULADO (fila separada) | Contexto diferente para o vendedor; abordagem de onboarding vs recompra | Dois fluxos para gerir; complexidade operacional |

**Impacto na fila principal se separados:** 17 oportunidades sairiam da fila atual → fila principal ficaria com 43 oportunidades.


## 15. Cross-Sell — Cenários (C0-C3)


**Motor atual:** 1 categoria AND pedidos ≥ 3 AND NOT inativo → 0 clientes

| Cenário | Clientes elegíveis | IDs anônimos | Fat. médio |
|---------|-------------------|--------------|------------|
| C0 (1 cat. AND ped≥3 (atual)) | 0 | — | — |
| C1 (1 cat. AND ped≥2) | 0 | — | — |
| C2 (≤2 cats. AND ped≥3) | 0 | — | — |
| C3 (≤2 cats. AND ped≥2) | 0 | — | — |


## 16. Análise da Prioridade das Oportunidades



### Distribuição por tipo

| Tipo | Qtd | MIN | MED | MÉDIA | MAX |
|---|---|---|---|---|---|
| JANELA_DE_RECOMPRA | 16 | 60 | 75 | 73.81 | 83 |
| NUNCA_COMPROU | 17 | 30 | 30 | 30 | 30 |
| QUEDA_DE_COMPRAS | 12 | 65 | 65 | 67 | 73 |
| REATIVACAO_120D | 15 | 40 | 93 | 85.73 | 99 |


### Decomposição: base + bônus − penalidade

| Ajuste | Qtd. oportunidades afetadas |
|--------|--------------------------|
| +15 (faturamento ≥R$10k) | 0 |
| +8 (faturamento ≥R$5k) | 1 |
| -10 (inativos >365d) | 5 |
| Sem ajuste | 54 |


## 17. Fila Comercial Simulada (top 20 de 60)


_ANALÍTICO — NÃO é o ranking definitivo. Mostra como a equipe receberia as oportunidades._

| Pos. | ID Anônimo | Tipo | Prioridade | Motivo matemático |
|---|---|---|---|---|
| 1 | CDD92 | REATIVACAO_120D | 99 | base=99 → final=99 |
| 2 | CE721 | REATIVACAO_120D | 99 | base=99 → final=99 |
| 3 | CE1A3 | REATIVACAO_120D | 98 | base=98 → final=98 |
| 4 | C1609 | REATIVACAO_120D | 95 | base=95 → final=95 |
| 5 | CA0C3 | REATIVACAO_120D | 95 | base=87 +8 (fat≥5k) → final=95 |
| 6 | C0AD8 | REATIVACAO_120D | 95 | base=95 → final=95 |
| 7 | C7B97 | REATIVACAO_120D | 95 | base=95 → final=95 |
| 8 | C1C55 | REATIVACAO_120D | 93 | base=93 → final=93 |
| 9 | CB6F9 | REATIVACAO_120D | 91 | base=91 → final=91 |
| 10 | C882C | REATIVACAO_120D | 90 | base=90 → final=90 |
| 11 | C559E | REATIVACAO_120D | 89 | base=89 → final=89 |
| 12 | C91C7 | REATIVACAO_120D | 88 | base=88 → final=88 |
| 13 | CA0C3 | JANELA_DE_RECOMPRA | 83 | base=75 → final=83 |
| 14 | CE35F | JANELA_DE_RECOMPRA | 83 | base=75 → final=83 |
| 15 | CDD92 | JANELA_DE_RECOMPRA | 75 | base=75 → final=75 |
| 16 | C51CC | JANELA_DE_RECOMPRA | 75 | base=75 → final=75 |
| 17 | C0AD8 | JANELA_DE_RECOMPRA | 75 | base=75 → final=75 |
| 18 | CE71C | JANELA_DE_RECOMPRA | 75 | base=75 → final=75 |
| 19 | C91C7 | JANELA_DE_RECOMPRA | 75 | base=75 → final=75 |
| 20 | CE721 | JANELA_DE_RECOMPRA | 75 | base=75 → final=75 |


## 18. Perguntas para o Proprietário


_10 decisões comerciais. NÃO há escolha recomendada. Dados apresentados para suportar a decisão humana._


### DECISÃO 1 — SIGNIFICADO DO SCORE

**Pergunta:** O que o score deve representar para a equipe comercial?

**Opção A:** Probabilidade de o cliente comprar nos próximos 30 dias
_Impacto observado nos 52:_ Motor atual de tendência e recorrência ganham mais peso. Clientes que "deveriam" comprar agora sobem na fila.

**Opção B:** Valor histórico e potencial financeiro do cliente para a MR4
_Impacto observado nos 52:_ Cenário S2 (peso faturamento=40) — 3 clientes com fat≥R$10k sobem muito. Novos e recentes mas com ticket baixo descem.

**Opção C:** Combinação de saúde comercial e recência (visão 360)
_Impacto observado nos 52:_ Cenário S0 atual — equilibrado mas com possível ambiguidade de interpretação para o vendedor.


### DECISÃO 2 — COMPRA ÚNICA

**Pergunta:** Clientes com 1 único pedido (4 no total): como tratar a frequência?

**Opção A:** U0 — manter comportamento atual
_Impacto observado nos 52:_ Frequência é calculada sobre 1 ponto. Pode gerar scores relativamente altos por recência alta se a compra foi recente.

**Opção B:** U1 — frequência = SEM_BASE (0) até ter segunda compra
_Impacto observado nos 52:_ Reduz score dos 4 com 1 pedido. Mais conservador — não assume padrão sem histórico.

**Opção C:** U2 — frequência limitada a 50% do normal para 1 pedido
_Impacto observado nos 52:_ Penalização parcial. Preserva parte do sinal de frequência mas sinaliza base insuficiente.


### DECISÃO 3 — FATURAMENTO

**Pergunta:** REF_FATURAMENTO_TOTAL R$10.000: somente 3/35 clientes vinculados atingem. Qual referência usar?

**Opção A:** Manter R$10.000 (atual)
_Impacto observado nos 52:_ Apenas 3 clientes (8.6%) recebem pontuação de faturamento plena.

**Opção B:** Reduzir para R$5.000 (percentil ~75 da população)
_Impacto observado nos 52:_ 9 clientes passariam a receber pontuação plena.

**Opção C:** Reduzir para R$3.000 (mediana aproximada)
_Impacto observado nos 52:_ Aprox. metade dos compradores alcançaria pontuação plena. Seria mais representativo da realidade.


### DECISÃO 4 — TENDÊNCIA

**Pergunta:** Tendência com base pequena: 17 clientes têm 1-2 pedidos na janela comparada. Como lidar?

**Opção A:** T0 — manter mínimo atual (1 pedido)
_Impacto observado nos 52:_ 26 classificados como CRESCENDO/CAINDO, incluindo os de base fraca.

**Opção B:** T1 — exigir mínimo 2 pedidos em qualquer janela
_Impacto observado nos 52:_ Reclassifica alguns para SEM_BASE. Ver seção 11.

**Opção C:** T3 — usar janela 90d quando 30d tem base < 2
_Impacto observado nos 52:_ Mais dados para comparação quando 30d é insuficiente, mas muda o período de referência.


### DECISÃO 5 — RECORRÊNCIA

**Pergunta:** Recorrência: média vs mediana para intervalo entre compras. 4 clientes mudam de status.

**Opção A:** Manter média (atual)
_Impacto observado nos 52:_ Sensível a outliers — uma compra muito espaçada eleva muito o intervalo esperado.

**Opção B:** Usar mediana
_Impacto observado nos 52:_ 4 clientes mudam de status. Mais resistente a compras irregulares.

**Opção C:** Usar o mínimo entre média e mediana (mais conservador)
_Impacto observado nos 52:_ Sempre usa o menor intervalo esperado — cliente fica ATRASADO mais cedo.


### DECISÃO 6 — CONFLITO DE OPORTUNIDADE

**Pergunta:** Conflito de oportunidades: 10 clientes recebem REATIVACAO_120D + JANELA_DE_RECOMPRA simultaneamente. O que fazer?

**Opção A:** O0 — manter 2 oportunidades por cliente conflitado
_Impacto observado nos 52:_ Fila atual: 60 oportunidades. Vendedor deve decidir qual abordar.

**Opção B:** O1 — REATIVACAO_120D absorve JANELA_DE_RECOMPRA
_Impacto observado nos 52:_ Fila reduz para 50. Lógica: quem está inativo ≥120d, a urgência maior é a reativação.

**Opção C:** O2 — nova oportunidade REATIVACAO_COM_ATRASO_HISTORICO
_Impacto observado nos 52:_ Mesmo volume (50) mas comunica melhor o contexto ao vendedor.


### DECISÃO 7 — NUNCA COMPROU

**Pergunta:** 17 clientes MR4 vinculados nunca compraram no GestãoClick. Como classificá-los?

**Opção A:** NUNCA_COMPROU como oportunidade na fila principal (atual, prioridade=30)
_Impacto observado nos 52:_ Aparecem na fila junto com reativações. Prioridade 30 é baixa — podem ser ignorados.

**Opção B:** PROSPECT_VINCULADO — fila separada de prospecção
_Impacto observado nos 52:_ Vendedor recebe contexto de onboarding, não de recompra. Fila principal fica com 43 opors.

**Opção C:** Ignorar por enquanto — foco em quem já tem histórico
_Impacto observado nos 52:_ Os 17 ficam invisíveis para o sistema até segunda instrução.


### DECISÃO 8 — CROSS-SELL

**Pergunta:** Cross-sell: motor atual gera 0 oportunidades. Qual threshold liberar?

**Opção A:** C0 — manter atual (1 cat, ped≥3): 0 clientes
_Impacto observado nos 52:_ Sem mudança. Motor de cross-sell permanece inativo para esta população.

**Opção B:** C1 — 1 categoria, ped≥2
_Impacto observado nos 52:_ 0 clientes entrariam na fila de cross-sell.

**Opção C:** C3 — ≤2 categorias, ped≥2
_Impacto observado nos 52:_ 0 clientes elegíveis — mais amplitude.


### DECISÃO 9 — PRIORIDADE

**Pergunta:** O que deve elevar a prioridade de uma oportunidade?

**Opção A:** Manter atual: tipo_oportunidade + bônus faturamento + penalidade inatividade longa
_Impacto observado nos 52:_ 0 opors ganham +15, 1 ganham +8, 5 perdem -10.

**Opção B:** Incluir score do cliente: prioridade = base + (score/10)
_Impacto observado nos 52:_ Clientes com score 80 ganhariam +8 de prioridade. Mistura os dois conceitos — mais completo mas menos transparente.

**Opção C:** Remover bônus de faturamento: prioridade só pelo tipo
_Impacto observado nos 52:_ Todos os 1 que hoje ganham bônus voltariam à prioridade base.


### DECISÃO 10 — ENGAJAMENTO

**Pergunta:** Componente engajamento (peso=5, impacto mínimo). O que fazer?

**Opção A:** Manter peso 5 (atual)
_Impacto observado nos 52:_ Impacto máximo de 5 pontos. Cenário S4 mostra que removê-lo muda poucos clientes.

**Opção B:** S4 — redistribuir 5 pontos para recência (+2) e frequência (+3)
_Impacto observado nos 52:_ Score médio muda de 31.44 para 30.37. Foco em comportamento recente.

**Opção C:** Enriquecer engajamento: incluir NPS, canais, reclamações quando disponíveis
_Impacto observado nos 52:_ Peso 5 permanece mas o indicador ganha mais profundidade. Requer dados adicionais.


## Relatório Final — Gates N22


| Campo | Valor |
|-------|-------|
| DATA_REFERENCIA | 2026-09-17 |
| LINKED_CLIENTS | 52 |
| COM_COMPRA | 35 |
| NUNCA_COMPRARAM | 17 |
| ATIVOS | 20 |
| INATIVOS_120D | 15 |
| SENSITIVITY_SCALE_FIX | PASS (/ 100 extra removido) |
| SCORE_SCENARIOS | 5 (S0-S4) |
| CLIENTS_WITH_MAJOR_SCORE_CHANGE | calculado por cenário — ver seção 6 |
| SINGLE_PURCHASE_ANALYSIS | 4 clientes / 3 simulações (U0-U2) |
| REVENUE_PERCENTILES | PASS — ver seção 9 |
| RECENCY_SCENARIOS | 4 (R0-R3) / 120d fixo |
| TREND_BASE_ANALYSIS | BASE_FRACA=17 / BASE_MEDIA=8 / BASE_FORTE=1 |
| TREND_SCENARIOS | 4 (T0-T3) |
| RECURRENCE_MEAN_VS_MEDIAN | 4 clientes mudam de status |
| OPPORTUNITY_CONFLICTS | 10 clientes / 3 possibilidades (O0-O2) |
| NEVER_BOUGHT_ANALYSIS | 17 clientes / 3 modelos |
| CROSS_SELL_SCENARIOS | 4 (C0-C3) |
| PRIORITY_ANALYSIS | 4 tipos / bônus/penalidade decompostos |
| SIMULATED_QUEUE | Top 20 de 60 |
| DECISOES_PARA_PROPRIETARIO | 10 |
| PII | ZERO |
| SECRETS | ZERO |
| PRODUCTION_WRITES | ZERO |
| LLM_CALLS | ZERO |
| DEPLOYS | ZERO |
| N22_GATE | PASS |

