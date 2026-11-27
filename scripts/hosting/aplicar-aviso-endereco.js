#!/usr/bin/env node
'use strict';
/**
 * Garante que toda página HTML do sistema carregue js/aviso-endereco.js (faixa só no endereço antigo).
 * Idempotente: pode ser executado de novo após mesclas. Uso: node scripts/hosting/aplicar-aviso-endereco.js [--conferir]
 */
const fs = require('fs'), path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
const paginas = () => require('../../tools/pages-redirect/gerar.js').paginas();
const marca = rel => `<script src="${rel.startsWith('modulos/') ? '../' : ''}js/aviso-endereco.js" defer></script>`;

function aplicar({ conferir = false, raiz = RAIZ } = {}) {
  const faltando = [], semHead = [];
  for (const rel of paginas()) {
    const arq = path.join(raiz, rel); const t = fs.readFileSync(arq, 'utf8');
    if (t.includes(marca(rel))) continue;
    // primeiro </head> do documento (modelos de impressão dentro de scripts vêm depois)
    const m = t.match(/<\/head>/i);
    if (!m) { semHead.push(rel); continue; }
    faltando.push(rel);
    if (!conferir) fs.writeFileSync(arq, t.slice(0, m.index) + marca(rel) + '\n' + t.slice(m.index));
  }
  return { faltando, semHead };
}

if (require.main === module) {
  const conferir = process.argv.includes('--conferir');
  const r = aplicar({ conferir });
  console.log(`${conferir ? 'sem o aviso' : 'aviso inserido em'}: ${r.faltando.length}${r.faltando.length ? ' (' + r.faltando.join(', ') + ')' : ''}`);
  if (r.semHead.length) console.log('sem </head>: ' + r.semHead.join(', '));
  process.exit((conferir && r.faltando.length) || r.semHead.length ? 1 : 0);
}
module.exports = { aplicar, marca };
