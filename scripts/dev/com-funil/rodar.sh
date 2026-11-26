#!/bin/sh
# Prepara, sobe os emuladores (portas 8240/9240/5241), roda o roteiro no navegador e encerra tudo.
# Uso: sh scripts/dev/com-funil/rodar.sh /caminho/pasta          (JAVA_HOME deve apontar para um JDK 11+)
#      sh scripts/dev/com-funil/rodar.sh /caminho/pasta manual   (deixa emuladores e site no ar para teste à mão)
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd); RAIZ=$(cd "$AQUI/../../.." && pwd); DIR=$1
[ -n "${JAVA_HOME:-}" ] && PATH="$JAVA_HOME/bin:$PATH" && export PATH
node "$AQUI/preparar.js" "$DIR"
DIR=$(cd "$DIR" && pwd)
SCRIPT="node '$AQUI/e2e.js' '$DIR'"; [ "${2:-}" = "manual" ] && SCRIPT="node '$AQUI/semente.js' '$DIR'"
EMULADORES=${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}
mkdir -p "$DIR/home-vazia"; cd "$DIR/emu"
# projeto "demo-" + HOME vazia (sem credenciais do gcloud/firebase): nenhum serviço de produção é alcançável
env -u GOOGLE_APPLICATION_CREDENTIALS -u CLOUDSDK_CONFIG HOME="$DIR/home-vazia" FIREBASE_EMULATORS_PATH="$EMULADORES" "$(command -v node)" "$RAIZ/functions/node_modules/.bin/firebase" emulators:exec \
  --project demo-mr4-com --config "$DIR/emu/firebase.json" --only auth,firestore,functions "$SCRIPT"
