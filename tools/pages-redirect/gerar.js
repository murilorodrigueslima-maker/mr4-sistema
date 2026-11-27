#!/usr/bin/env node
'use strict';
/**
 * Gera o redirecionamento do GitHub Pages para o Firebase Hosting. NÃO publica nada.
 * Uso: node tools/pages-redirect/gerar.js <pasta-de-saida>
 *   <saida>/branch-pages/  conteúdo para um branch só de redirecionamento (repositório ainda público)
 *   <saida>/site-usuario/  conteúdo para o repositório <usuario>.github.io (repositório do sistema já privado)
 */
const fs = require('fs'), path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');

function paginas() {
  const naRaiz = fs.readdirSync(RAIZ).filter(f => /^(index|login|painel-comercial(-preview)?)\.html$/.test(f));
  const modulos = fs.readdirSync(path.join(RAIZ, 'modulos')).filter(f => f.endsWith('.html')).map(f => 'modulos/' + f);
  return naRaiz.concat(modulos);
}

function gravar(destino, conteudo) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, conteudo);
}

function gerar(saida) {
  if (fs.existsSync(saida) && fs.readdirSync(saida).length) throw new Error('A pasta de saída precisa estar vazia ou não existir.');
  const html = fs.readFileSync(path.join(__dirname, 'pagina.html'), 'utf8');
  const lista = paginas();
  for (const base of [path.join(saida, 'branch-pages'), path.join(saida, 'site-usuario', 'mr4-sistema')]) {
    for (const rel of lista.concat('404.html')) gravar(path.join(base, rel), html);
  }
  // no site do usuário só o 404.html da raiz é usado pelo GitHub para caminhos inexistentes
  gravar(path.join(saida, 'site-usuario', '404.html'), html);
  for (const d of ['branch-pages', 'site-usuario']) gravar(path.join(saida, d, '.nojekyll'), '');
  return lista;
}

if (require.main === module) {
  const saida = process.argv[2];
  if (!saida) { console.error('Informe a pasta de saída.'); process.exit(2); }
  console.log(`geradas ${gerar(path.resolve(saida)).length} páginas + 404 em ${saida}`);
}
module.exports = { gerar, paginas };
