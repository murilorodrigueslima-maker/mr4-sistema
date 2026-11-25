#!/usr/bin/env node
'use strict';
/**
 * Empacota o front-end do MR4 Gestão para o Firebase Hosting com LISTA PERMITIDA (nada além do sistema vai para fora).
 * Uso: node scripts/hosting/empacotar.js [pasta-de-saida=dist]
 * Só copia: index.html, login.html, painel-comercial*.html, modulos/*.html, modulos/*.js, js/*.js, assets/*.{png,jpg,svg,ico,webp}.
 * Depois verifica: nenhum arquivo fora da lista, nenhum .rules/.md/.env/.json, e nenhum padrão de segredo/dado sensível. Falha (exit 1) se algo violar.
 */
const fs = require('fs'), path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
const SAIDA = path.resolve(RAIZ, process.argv[2] || 'dist');
const PERMITIDOS = [
  /^index\.html$/, /^login\.html$/, /^painel-comercial(-preview)?\.html$/,
  /^modulos\/[A-Za-z0-9._-]+\.html$/, /^modulos\/[A-Za-z0-9._-]+\.js$/,
  /^js\/[A-Za-z0-9._-]+\.js$/, /^assets\/[A-Za-z0-9._-]+\.(png|jpe?g|svg|ico|webp)$/,
];
const PROIBIDOS_NOME = /\.(rules|md|env|json|log|bak|map|pem|key)$|(^|\/)\.|node_modules|serviceAccount|\.test\.js$/i;
const SEGREDOS = [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"\s*:/, /AKIA[0-9A-Z]{16}/, /xox[bap]-[0-9A-Za-z-]{10,}/, /GC_(SECRET_)?ACCESS_TOKEN\s*[:=]\s*['"][A-Za-z0-9]{12,}/];
function listar(dir, base = '') {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap(e => {
    const rel = base ? base + '/' + e.name : e.name;
    return e.isDirectory() ? (['node_modules', '.git', 'functions', 'scripts', 'docs', 'artifacts', 'tools', 'worker', 'dist'].includes(e.name) && !base ? [] : listar(dir, rel)) : [rel];
  });
}
function main() {
  fs.rmSync(SAIDA, { recursive: true, force: true }); fs.mkdirSync(SAIDA, { recursive: true });
  const copiados = [];
  for (const rel of listar(RAIZ)) {
    if (!PERMITIDOS.some(r => r.test(rel)) || PROIBIDOS_NOME.test(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(SAIDA, rel)), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, rel), path.join(SAIDA, rel)); copiados.push(rel);
  }
  const erros = [];
  for (const rel of listar(SAIDA)) {
    if (!PERMITIDOS.some(r => r.test(rel))) erros.push('fora da lista: ' + rel);
    if (PROIBIDOS_NOME.test(rel)) erros.push('nome proibido: ' + rel);
    if (/\.(html|js)$/.test(rel)) { const t = fs.readFileSync(path.join(SAIDA, rel), 'utf8'); for (const re of SEGREDOS) if (re.test(t)) erros.push('padrão de segredo em ' + rel + ' (' + re.source.slice(0, 24) + ')'); }
  }
  if (!copiados.includes('index.html') || !copiados.includes('login.html')) erros.push('index.html/login.html ausentes');
  const bytes = copiados.reduce((s, r) => s + fs.statSync(path.join(SAIDA, r)).size, 0);
  console.log(`arquivos: ${copiados.length} | ${(bytes / 1048576).toFixed(2)} MB | saída: ${path.relative(RAIZ, SAIDA)}`);
  if (erros.length) { console.error('FALHOU:\n  ' + erros.join('\n  ')); process.exit(1); }
  console.log('OK: pacote dentro da lista permitida, sem segredos.');
}
if (require.main === module) main();
module.exports = { PERMITIDOS, PROIBIDOS_NOME, SEGREDOS, listar };
