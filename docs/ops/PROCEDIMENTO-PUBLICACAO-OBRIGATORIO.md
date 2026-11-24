# Procedimento obrigatório de publicação — MR4 Gestão

**Regra permanente.** Antes de QUALQUER publicação, compare o estado do repositório com o estado EFETIVAMENTE implantado em produção.
Se houver divergência: **interrompa a publicação, identifique a origem e reconcilie as versões antes de prosseguir.**
Vale para: Firestore Rules, Cloud Functions, Hosting, workflows do GitHub e configurações relevantes (WIF, Auth, chaves de API, Scheduler, Secrets).

## Por quê
Em 24/11/2026 descobriu-se que as Rules publicadas em 24/10/2026 tinham um bloco (`compras_n0_fornecedores`) que nunca foi commitado. Publicar o arquivo do repositório teria apagado essa regra e derrubado a aba Fornecedores de Compras. A conferência abaixo teria detectado o desvio.

## Passo a passo (nesta ordem)
1. **Conferência (somente leitura):**
   `python3 scripts/ops/conferir-divergencia.py --funcoes <funções que serão publicadas>`
   - `OK` em todas as áreas ⇒ pode seguir.
   - `DIVERGE` ⇒ **pare**. Documente a origem (quem publicou, quando, por qual caminho) e reconcilie **no Git** (commit separado, com o identificador do que está em produção) ou **reverta a produção** — nunca "publique por cima".
   - `NAO_VERIFICADO` ⇒ resolva a permissão/erro; não publique às cegas.
2. **Sem sync em andamento** (`gh run list --status in_progress`), fora de :50–:10 quando o sync for afetado.
3. **Backup do que está em produção** (cópia fiel guardada fora do Git público): Rules (arquivo do ruleset publicado), versão/revisão das Functions (nome da revisão), versão do Hosting (id), configuração alterada (snapshot).
4. **Publicar o artefato testado** (o MESMO arquivo/pacote que passou nos testes — por hash), uma peça por vez, com simulação antes (`--dry`/simulação quando existir).
5. **Verificação pós-publicação** (somente leitura + 1 chamada sem credencial): reexecutar a conferência; confirmar que só mudou o que devia.
6. **Rollback pronto antes de publicar** (Rules: arquivo anterior; Functions: revisão anterior do Cloud Run; Hosting: versão anterior; workflows: revert).

## O que a conferência cobre
| Área | Como compara | Divergência típica |
|---|---|---|
| **Firestore Rules** | `modulos/firestore.rules` × conjunto publicado (release `cloud.firestore`), byte a byte | regra publicada fora do Git (caso de 24/10/2026) |
| **Functions** | funções implantadas × `exports` do `index.js`; por função: handler do repositório × handler da fonte REALMENTE implantada; commits em `functions/` após a data de implantação | função/versão implantada fora do Git; código novo ainda não implantado (INFO) |
| **Hosting** | (a implementar com a migração) hashes da versão no ar × `dist/`; hoje: Pages | arquivo no ar diferente do build |
| **Workflows** | `.github/workflows/*` locais × `main` remoto (SHA de blob); estado ativo/desativado | workflow alterado/desativado pela interface |
| **Configurações** | snapshot (WIF e condição, domínios autorizados do Auth, chaves de API e restrições, jobs do Scheduler, nomes de Secrets) × baseline versionado | mudança de IAM/chave/agendamento feita no console |

## Baseline de configurações
`estado-esperado-producao.json` guarda o estado esperado (somente nomes, condições e agendamentos — **nunca valores de segredos**). Toda mudança aprovada de configuração atualiza o baseline NA MESMA mudança:
`python3 scripts/ops/conferir-divergencia.py --so config --baseline <arquivo> --atualizar-baseline`.
Enquanto o repositório for público, o baseline fica fora do Git (variável `MR4_BASELINE` ou `--baseline`); ao migrar para o repositório privado, passa para `docs/ops/`.

## Limites conhecidos
- Functions: a comparação detalhada usa o handler pelo nome (`<nome>Handler`); funções com outro padrão exigem comparação manual (a ferramenta avisa).
- Rules e config exigem credencial `gcloud` com leitura; sem ela, o resultado é `NAO_VERIFICADO` (código 2), nunca "OK".
- O script só faz leituras (GET/describe/list/download de fonte); um teste automatizado garante que não contenha comandos de escrita.
