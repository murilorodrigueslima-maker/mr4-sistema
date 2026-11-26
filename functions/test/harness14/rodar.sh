#!/bin/sh
# Harness local do simulador 1.4: emuladores Firestore 8210 e Auth 9210, dados fictícios, servidor estático 5210.
# Uso (na raiz do repositório):   JAVA_HOME=<JDK 11 ou mais novo> sh functions/test/harness14/rodar.sh
#   rules                          roda só o teste de regras da coleção compras_sombra_14
set -e
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$RAIZ"
[ -n "$JAVA_HOME" ] && PATH="$JAVA_HOME/bin:$PATH" && export PATH
FIREBASE="$RAIZ/functions/node_modules/.bin/firebase"
if [ "$1" = "rules" ]; then
  exec "$FIREBASE" emulators:exec --config firebase.harness14.json --project demo-mr4-sim14 --only firestore \
    "cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8210 npx jest test/compras-politica-14-rules.test.js test/compras-politica-13-rules.test.js --runInBand --forceExit"
fi
exec "$FIREBASE" emulators:exec --config firebase.harness14.json --project demo-mr4-sim14 --only firestore,auth \
  "cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8210 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9210 node test/harness14/semear.js && node test/harness14/servidor.js"
