#!/bin/bash
# Modo manual do Ponto: emuladores Auth (9310) + Firestore (8310) + Functions (5311) + telas em http://127.0.0.1:5310.
# Dados FICTÍCIOS, projeto "demo-": nenhum acesso à produção (as páginas são servidas com o projeto trocado em memória
# e com Content-Security-Policy que só deixa falar com os emuladores locais; o repositório não é alterado).
# Uso: bash functions/test/harness-ponto/iniciar.sh            (Ctrl+C encerra tudo)
#      TELAS_REF=890594c bash functions/test/harness-ponto/iniciar.sh   (telas publicadas, para conferir compatibilidade)
#      RULES_REF=<commit> ...                                    (Rules de outra etapa)
#      HARNESS_TMP=<pasta> ...                                  (onde criar os arquivos temporários)
# Com o servidor no ar, /antigas/modulos/ponto.html e /antigas/modulos/ponto-func.html abrem as telas publicadas (890594c).
# Requer functions/node_modules e um JDK 11+ (padrão: ~/mr4-trabalho/tools/jdk-21.0.13.1+2). Internet só para o SDK do Firebase (gstatic).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$AQUI/../../.." && pwd)"
JDK="$HOME/mr4-trabalho/tools/jdk-21.0.13.1+2/Contents/Home"
if [ -d "$JDK" ]; then export JAVA_HOME="$JDK"; fi
if [ -n "${JAVA_HOME:-}" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
for p in 8310 9310 5310 5311 4310 4311 9311 4312 4313; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Porta $p em uso. Encerre o processo antes de iniciar." >&2; exit 1; fi
done
# HARNESS_TMP: pasta onde criar o projeto temporário. Não aponte TMPDIR para caminhos longos: o emulador de Functions cria
# um socket local em TMPDIR e o macOS limita o caminho a ~100 caracteres.
TMP="$(mktemp -d "${HARNESS_TMP:-${TMPDIR:-/tmp}}/mr4-harness-ponto.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
if [ -n "${RULES_REF:-}" ]; then git -C "$RAIZ" show "$RULES_REF:modulos/firestore.rules" > "$TMP/firestore.rules"; else cp "$RAIZ/modulos/firestore.rules" "$TMP/firestore.rules"; fi
# cópia das Functions (sem .env) com node_modules por link
mkdir -p "$TMP/functions"
cp -R "$RAIZ/functions/index.js" "$RAIZ/functions/utils.js" "$RAIZ/functions/integracoes-admin.js" "$RAIZ/functions/webhook-gestaoclick.js" "$RAIZ/functions/package.json" "$RAIZ/functions/lib" "$RAIZ/functions/config" "$TMP/functions/"
ln -s "$(cd "$RAIZ/functions/node_modules" && pwd -P)" "$TMP/functions/node_modules"
# Particularidade do emulador de Functions: `admin.firestore.FieldValue` vem indefinido (em produção funciona).
# Troca pela importação modular equivalente SOMENTE na cópia temporária.
find "$TMP/functions/index.js" "$TMP/functions/lib" -type f -name '*.js' -exec sed -i '' "s#admin\.firestore\.FieldValue#require('firebase-admin/firestore').FieldValue#g" {} +
cat > "$TMP/firebase.json" <<'JSON'
{ "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions" },
  "emulators": { "auth": { "host": "127.0.0.1", "port": 9310 }, "firestore": { "host": "127.0.0.1", "port": 8310, "websocketPort": 9311 },
    "functions": { "host": "127.0.0.1", "port": 5311 }, "eventarc": { "host": "127.0.0.1", "port": 4312 }, "tasks": { "host": "127.0.0.1", "port": 4313 },
    "hub": { "host": "127.0.0.1", "port": 4310 }, "logging": { "host": "127.0.0.1", "port": 4311 }, "ui": { "enabled": false }, "singleProjectMode": true } }
JSON
cd "$TMP"      # logs dos emuladores ficam na pasta temporária
# ISOLAMENTO: HOME vazio para o emulador de Functions não encontrar credenciais reais (ADC do gcloud); só o cache dos emuladores.
export FIREBASE_EMULATORS_PATH="${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}"
NODE_DIR="$(dirname "$(command -v node)")"; mkdir -p "$TMP/home"
export HOME="$TMP/home" CLOUDSDK_CONFIG="$TMP/home/gcloud" PATH="$NODE_DIR:$PATH"
unset GOOGLE_APPLICATION_CREDENTIALS || true
export FUNCTIONS_DISCOVERY_TIMEOUT="${FUNCTIONS_DISCOVERY_TIMEOUT:-90}"
RAIZ_REPO="$RAIZ" "$RAIZ/functions/node_modules/.bin/firebase" emulators:exec --config "$TMP/firebase.json" --only auth,firestore,functions --project demo-ponto-manual "node '$AQUI/servidor.js'"
