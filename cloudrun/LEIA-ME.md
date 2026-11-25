# Cloud Run Job `mr4-sync-job`
Executa `scripts/sync-dados.js` (o mesmo do GitHub Actions) no projeto `mr4-ponto`, região `southamerica-east1`, com a conta `mr4-sync` (papéis: `datastore.user` + `secretAccessor` SÓ nos 2 segredos do GestãoClick). Sem token do GitHub.
- Build: `gcloud builds submit --config cloudrun/cloudbuild.yaml --substitutions _IMAGE=<imagem> .`
- Disparo: Cloud Scheduler → `jobs:run` com a conta `mr4-sync-scheduler` (só `run.invoker` NESTE job). Variáveis de execução: `INTERVALO_MIN_MINUTOS` (ignora se houver execução recente), `BLOCOS=vendas,pedidos` (execução direcionada).
- Trava compartilhada com o GitHub Actions: `gc_sync_lock/sync-dados` (TTL 25 min; só o detentor libera; falha ao acessar ⇒ não executa).
