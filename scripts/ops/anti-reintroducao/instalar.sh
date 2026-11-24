#!/bin/sh
# Instala o hook anti-reintrodução NESTE clone (aponta core.hooksPath para esta pasta). Rode a partir da raiz do repositório.
set -e; AQUI="$(cd "$(dirname "$0")" && pwd)"; git config core.hooksPath "$AQUI"; chmod +x "$AQUI/pre-push"
echo "hook pre-push ativo: $(git config core.hooksPath)"; echo "lista de bloqueio: $(wc -l < "$AQUI/denylist-commits-antigos.txt") commits antigos"
