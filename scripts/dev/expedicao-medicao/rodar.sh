#!/bin/sh
# Pré-visualização manual da Expedição com a medição: emuladores 8350 (Firestore) e 9350 (Auth), site 5350, dados fictícios.
# Uso: sh scripts/dev/expedicao-medicao/rodar.sh /caminho/pasta-fora-do-repositorio     (JAVA_HOME = JDK 11+; Ctrl+C encerra)
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd); RAIZ=$(cd "$AQUI/../../.." && pwd); DIR=$1
[ -n "${JAVA_HOME:-}" ] && PATH="$JAVA_HOME/bin:$PATH" && export PATH
node "$AQUI/preparar.js" "$DIR"
DIR=$(cd "$DIR" && pwd)
EMULADORES=${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}
mkdir -p "$DIR/home-vazia"; cd "$DIR/emu"
# projeto "demo-" + HOME vazia (sem credenciais do gcloud/firebase): nenhum serviço de produção é alcançável
env -u GOOGLE_APPLICATION_CREDENTIALS -u CLOUDSDK_CONFIG HOME="$DIR/home-vazia" FIREBASE_EMULATORS_PATH="$EMULADORES" "$(command -v node)" "$RAIZ/functions/node_modules/.bin/firebase" emulators:exec \
  --project demo-mr4-exp --config "$DIR/emu/firebase.json" --only auth,firestore "node '$AQUI/semente.js' '$DIR'"
