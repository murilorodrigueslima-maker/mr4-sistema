#!/usr/bin/env node
'use strict';
/**
 * Pré-condição para publicar as Functions do painel (SOMENTE LEITURA, um GET): o documento protegido
 * painel_mapeamento/vendedores precisa existir e produzir as mesmas chaves que antes estavam no código.
 *   node scripts/ops/privacidade/conferir-config.js [--esperado ~/mr4-ops/privacidade/painel-mapeamento.json]
 * Imprime só contagens e verdadeiro/falso (nunca nomes ou ids). Saída 0 = pode publicar; 1 = não publicar.
 * Usa a credencial do gcloud já conectado, apenas em memória.
 */
const cp = require('child_process');
const fs = require('fs');
const { chavesDoMapa } = require('../../../functions/lib/painelMetricas');

const URL_DOC = 'https://firestore.googleapis.com/v1/projects/mr4-ponto/databases/(default)/documents/painel_mapeamento/vendedores';
/** Converte o formato REST do Firestore em objeto simples. */
function simples(v) {
  if (v && v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, simples(x)]));
  if (v && 'integerValue' in v) return Number(v.integerValue);
  return v ? Object.values(v)[0] : undefined;
}
function avaliar(vendedores, esperado) {
  const r = { documentoExiste: !!vendedores, vendedores: Object.keys(vendedores || {}).length, chaves: chavesDoMapa(vendedores).length };
  r.entradasCompletas = r.vendedores > 0 && Object.values(vendedores).every(m => m && m.chave && m.nomeConfig);
  if (esperado) {
    const e = esperado.vendedores || {};
    r.mesmasChavesNaMesmaOrdem = JSON.stringify(chavesDoMapa(vendedores)) === JSON.stringify(chavesDoMapa(e));
    r.idsAnterioresPreservados = Object.keys(e).every(id => vendedores && vendedores[id] && vendedores[id].chave === e[id].chave && vendedores[id].nomeConfig === e[id].nomeConfig);
  }
  r.podePublicar = r.documentoExiste && r.entradasCompletas && r.chaves > 0 && (!esperado || (r.mesmasChavesNaMesmaOrdem && r.idsAnterioresPreservados));
  return r;
}
async function principal(argv) {
  const i = argv.indexOf('--esperado');
  const esperado = i >= 0 ? JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')) : null;
  const token = cp.execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const resp = await fetch(URL_DOC, { method: 'GET', headers: { Authorization: 'Bearer ' + token, 'x-goog-user-project': 'mr4-ponto' } });
  if (!resp.ok && resp.status !== 404) { console.log(JSON.stringify({ podePublicar: false, erro: 'LEITURA_HTTP_' + resp.status })); return 1; }
  const doc = resp.ok ? await resp.json() : null;
  const r = avaliar(doc ? simples((doc.fields || {}).vendedores) : null, esperado);
  console.log(JSON.stringify(r));
  return r.podePublicar ? 0 : 1;
}
if (require.main === module) principal(process.argv.slice(2)).then(c => { process.exitCode = c; }).catch(e => { console.log(JSON.stringify({ podePublicar: false, erro: e.code || 'FALHA' })); process.exitCode = 1; });
module.exports = { avaliar, simples };
