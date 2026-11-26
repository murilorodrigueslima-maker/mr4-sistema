#!/usr/bin/env node
'use strict';
/**
 * Compras — Política 1.3 em SOMBRA (opcional, manual). Por padrão NÃO grava nada no Firestore.
 *
 *   node scripts/compras_sombra_13.js --saida <pasta>                      lê (somente get) e escreve CSV + resumo locais
 *   node scripts/compras_sombra_13.js --de-arquivo <pasta> --saida <pasta> usa cópias locais das coleções (sem rede)
 *   ... --config <config.json>      decisões do dono (prazos, mínimos, múltiplos, teto de compra) mescladas sobre a política
 *   ... --gravar --confirmo=compras_sombra_13   grava SOMENTE na coleção própria compras_sombra_13 (feito pelo integrador)
 */
const fs = require('fs');
const path = require('path');
const S = require('../lib/compras/sombra13');
const { POLITICA_1_3_SOMBRA, comConfig } = require('../lib/compras/politica13');
const { LOJA_ATIVA_ID } = require('../lib/lojaAtiva');

function argumentos(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw new Error('ARGUMENTO_INVALIDO ' + argv[i]);
    a[m[1]] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return a;
}

/** Cópias locais: um arquivo <colecao>.json por coleção, no formato { docId: dados }. */
function lerDeArquivos(pasta) {
  const ler = c => JSON.parse(fs.readFileSync(path.join(pasta, c + '.json'), 'utf8'));
  const base = ler('compras_n0_base'), meta = ler('compras_n0').meta;
  const { decodificarVenda, decodificarCompra, refBaseAtiva, idsDaBase } = require('../lib/compras/snapshot');
  const vendas = [], compras = [];
  for (const id of idsDaBase(refBaseAtiva(meta))) {
    if (!base[id]) throw new Error('BASE_INCOMPLETA ' + id);
    const regs = JSON.parse(base[id].registros_json);
    if (id.includes('v_')) vendas.push(...regs.map(decodificarVenda)); else compras.push(...regs.map(decodificarCompra));
  }
  return S.montarEntradas({ meta, vendas, compras, produtos: Object.entries(ler('compras_n0_produtos')), custos: Object.entries(ler('compras_n0_custos')), snaps: Object.entries(ler('estoque_snapshots')) });
}

async function principal(argv = process.argv.slice(2), saidaTexto = console.log) {
  const a = argumentos(argv);
  if (LOJA_ATIVA_ID !== '262759') throw new Error('LOJA_INESPERADA');
  if (a.gravar && a.confirmo !== S.COLECAO) throw new Error('GRAVACAO_EXIGE --confirmo=' + S.COLECAO);
  if (a.gravar && a['de-arquivo']) throw new Error('NAO_GRAVAR_A_PARTIR_DE_COPIA_LOCAL');
  const politica13 = a.config ? comConfig(POLITICA_1_3_SOMBRA, JSON.parse(fs.readFileSync(a.config, 'utf8'))) : POLITICA_1_3_SOMBRA;
  let db = null, entradas;
  if (a['de-arquivo']) entradas = lerDeArquivos(a['de-arquivo']);
  else {
    const admin = require('firebase-admin');
    admin.initializeApp({ projectId: typeof a.projeto === 'string' ? a.projeto : 'mr4-ponto' });
    db = admin.firestore();
    entradas = await S.lerEntradas(db);
  }
  const res = S.calcularSombra(entradas, { politica13 });
  if (typeof a.saida === 'string') {
    fs.mkdirSync(a.saida, { recursive: true });
    fs.writeFileSync(path.join(a.saida, `compras-sombra13-comparacao-${res.hoje}.csv`), '﻿' + S.gerarCsv(res.linhas));
    fs.writeFileSync(path.join(a.saida, `compras-sombra13-resumo-${res.hoje}.json`), JSON.stringify({ data: res.hoje, dados_gerados_em: res.gerado_em_dados, resumo: res.resumo }, null, 1));
  }
  const gravado = a.gravar ? await S.persistirSombra(db, res) : null;
  saidaTexto(JSON.stringify({ evento: 'compras_sombra_13', data: res.hoje, modo: gravado ? 'GRAVADO' : 'SEM_ESCRITA', gravado, total: res.resumo.total, conferencia_12: res.resumo.conferencia_12 }, null, 1));
  return res;
}

if (require.main === module) principal().then(() => process.exit(0)).catch(e => { console.error(String(e.message || e).slice(0, 300)); process.exit(1); });
module.exports = { principal, argumentos, lerDeArquivos };
