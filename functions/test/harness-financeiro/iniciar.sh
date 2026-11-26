#!/bin/bash
# Harness local do Financeiro: emuladores Auth (9230) + Firestore (8230) + página em http://localhost:5230. Dados FICTÍCIOS, projeto "demo-".
# Uso: bash functions/test/harness-financeiro/iniciar.sh          (Ctrl+C encerra tudo)
# Requer functions/node_modules e um JDK 11+ (JAVA_HOME; padrão: ~/mr4-trabalho/tools/jdk-21.0.13.1+2).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$AQUI/../../.." && pwd)"
JDK="$HOME/mr4-trabalho/tools/jdk-21.0.13.1+2/Contents/Home"
if [ -d "$JDK" ]; then export JAVA_HOME="$JDK"; fi
if [ -n "${JAVA_HOME:-}" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
for p in 8230 9230 5230 4230 4231 9231; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Porta $p em uso. Encerre o processo antes de iniciar o harness." >&2; exit 1; fi
done
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mr4-harness-fin.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
cp "$RAIZ/modulos/firestore.rules" "$TMP/firestore.rules"      # as MESMAS Rules do repositório
cat > "$TMP/firebase.json" <<'JSON'
{ "firestore": { "rules": "firestore.rules" },
  "emulators": { "auth": { "host": "127.0.0.1", "port": 9230 }, "firestore": { "host": "127.0.0.1", "port": 8230, "websocketPort": 9231 },
    "hub": { "host": "127.0.0.1", "port": 4230 }, "logging": { "host": "127.0.0.1", "port": 4231 }, "ui": { "enabled": false }, "singleProjectMode": true } }
JSON
cd "$TMP"      # logs dos emuladores ficam na pasta temporária
"$RAIZ/functions/node_modules/.bin/firebase" emulators:exec --config "$TMP/firebase.json" --only auth,firestore --project demo-mr4-fin "node '$AQUI/servidor.js'"
