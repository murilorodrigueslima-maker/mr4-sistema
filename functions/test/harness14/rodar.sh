#!/bin/sh
# Harness local do planejamento de compra: emuladores Firestore 8320, Auth 9320 e Functions 5321, dados fictícios, página em 5320.
# Uso (na raiz do repositório):   JAVA_HOME=<JDK 11 ou mais novo> sh functions/test/harness14/rodar.sh
#   rules                          roda os testes de regras e a atualização da base contra o emulador
# A função usa o Node do PATH (o projeto declara Node 22).
set -e
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$RAIZ"
[ -n "$JAVA_HOME" ] && PATH="$JAVA_HOME/bin:$PATH" && export PATH
FIREBASE="$RAIZ/functions/node_modules/.bin/firebase"
# a credencial da máquina não entra nos emuladores: aponta para uma credencial FALSA (o projeto demo- também não existe)
FALSA="$(mktemp)"; printf '{"type":"authorized_user","client_id":"demo","client_secret":"demo","refresh_token":"demo"}' > "$FALSA"
export GOOGLE_APPLICATION_CREDENTIALS="$FALSA"
# com a máquina ocupada, ler o index.js pode passar dos 10 s padrão
export FUNCTIONS_DISCOVERY_TIMEOUT="${FUNCTIONS_DISCOVERY_TIMEOUT:-90}"
if [ "$1" = "rules" ]; then
  # testes: pelo executor isolado (portas exclusivas, trava de rede, projeto demo-)
  exec node scripts/testes/rodar.js -- test/compras-politica-14-rules.test.js test/compras-politica-13-rules.test.js test/compras-planejamento-emulador.test.js --forceExit
fi
exec "$FIREBASE" emulators:exec --config firebase.harness14.json --project demo-mr4-sim14 --only firestore,auth,functions \
  "cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8320 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9320 node test/harness14/semear.js && node test/harness14/servidor.js"
