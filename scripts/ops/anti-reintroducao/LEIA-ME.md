# Anti-reintrodução do histórico antigo (incidente de privacidade de 24/11/2026)
O histórico original continha arquivos de dados comerciais/financeiros (`data/*.json`) e relatórios analíticos com dados reais. Ele foi reescrito; **nenhum clone antigo pode ser enviado de volta ao GitHub**.
- `pre-push`: recusa o push se o intervalo enviado contiver (1) algum commit da lista `denylist-commits-antigos.txt` (hashes do histórico antigo — não contém dados) ou (2) objetos em `data/` ou nos 3 relatórios reais. **Falha fechada** (sem a lista, recusa).
- Instalar em cada clone: `sh scripts/ops/anti-reintroducao/instalar.sh`.
- Nunca use `git push --mirror`/`--all` a partir de um clone antigo; recrie o clone a partir do GitHub.
- Os 3 relatórios reais são gerados fora do repositório (`~/mr4-relatorios-privados`) e estão no `.gitignore`; o teste `functions/test/relatorios-reais-nao-rastreados.test.js` falha se voltarem a ser rastreados.
