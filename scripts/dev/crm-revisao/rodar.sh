#!/bin/sh
# Prepara, sobe os emuladores (portas 8370/9370/5371), executa um roteiro e encerra tudo.
# Uso: sh scripts/dev/crm-revisao/rodar.sh /caminho/pasta [roteiro.js | manual]   (JAVA_HOME deve apontar para um JDK 11+)
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd); RAIZ=$(cd "$AQUI/../../.." && pwd); DIR=$1
[ -n "${JAVA_HOME:-}" ] && PATH="$JAVA_HOME/bin:$PATH" && export PATH
node "$AQUI/preparar.js" "$DIR"
DIR=$(cd "$DIR" && pwd)
ROTEIRO=${2:-$AQUI/e2e.js}; [ "$ROTEIRO" = "manual" ] && ROTEIRO="$AQUI/semente.js"
SCRIPT="node '$ROTEIRO' '$DIR'"
EMULADORES=${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}
mkdir -p "$DIR/home-vazia"; cd "$DIR/emu"
# projeto "demo-" + HOME vazia (sem credenciais do gcloud/firebase): nenhum serviço de produção é alcançável
env -u GOOGLE_APPLICATION_CREDENTIALS -u CLOUDSDK_CONFIG HOME="$DIR/home-vazia" FIREBASE_EMULATORS_PATH="$EMULADORES" "$(command -v node)" "$RAIZ/functions/node_modules/.bin/firebase" emulators:exec \
  --project demo-mr4-crm --config "$DIR/emu/firebase.json" --only auth,firestore,functions "$SCRIPT"
