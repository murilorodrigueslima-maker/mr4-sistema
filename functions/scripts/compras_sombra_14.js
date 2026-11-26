#!/usr/bin/env node
'use strict';
/**
 * Compras — Política 1.4 em SOMBRA (manual). Por padrão NÃO grava nada no Firestore.
 *
 *   node scripts/compras_sombra_14.js --saida <pasta> [--orcamento 49000]     lê (somente get) e escreve a simulação local (CSV)
 *   node scripts/compras_sombra_14.js --de-arquivo <pasta> --saida <pasta>    usa cópias locais das coleções (sem rede)
 *   ... --origem <04C-origem-das-compras.csv>   compras que NÃO podem decidir sozinhas (coluna usar_em_decisao_automatica)
 *   ... --config <geracao.json>     compras/fornecedores sem origem, mínimos por fornecedor, marcas (ver sombra14.GERACAO)
 *   ... --config13 <config.json>    prazos, embalagens e premissas por produto/fornecedor (mesmo formato da 1.3)
 *   ... --gravar --confirmo=compras_sombra_14   grava SOMENTE na coleção própria compras_sombra_14 (feito pelo integrador)
 */
const fs = require('fs');
const path = require('path');
const S = require('../lib/compras/sombra14');
const A = require('../lib/compras/alocacao14');
const { POLITICA_1_3_SOMBRA, comConfig } = require('../lib/compras/politica13');
const { LOJA_ATIVA_ID } = require('../lib/lojaAtiva');
const { argumentos, lerDeArquivos } = require('./compras_sombra_13');

function lerLocal(pasta) {
  const ler = c => { try { return JSON.parse(fs.readFileSync(path.join(pasta, c + '.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
  const f = ler('compras_n0_fornecedores');
  return { ...lerDeArquivos(pasta), view: ler('compras_n0_view').sugestoes || null, fornecedores: { unidades: f.unidades || null, nomes: f.nomes || null } };
}

/** Configuração da geração: arquivo do dono + lista de origem (CSV). */
function configDaGeracao(a) {
  const config = typeof a.config === 'string' ? JSON.parse(fs.readFileSync(a.config, 'utf8')) : {};
  if (typeof a.origem === 'string') {
    const o = config.origem || {};
    config.origem = { ...o, compras_sem_origem: [...new Set([...(o.compras_sem_origem || []), ...S.lerOrigemCsv(fs.readFileSync(a.origem, 'utf8'))])] };
  }
  return config;
}

async function principal(argv = process.argv.slice(2), saidaTexto = console.log) {
  const a = argumentos(argv);
  if (LOJA_ATIVA_ID !== '262759') throw new Error('LOJA_INESPERADA');
  if (a.gravar && a.confirmo !== S.COLECAO) throw new Error('GRAVACAO_EXIGE --confirmo=' + S.COLECAO);
  if (a.gravar && a['de-arquivo']) throw new Error('NAO_GRAVAR_A_PARTIR_DE_COPIA_LOCAL');
  const config = configDaGeracao(a);
  const politica13 = typeof a.config13 === 'string' ? comConfig(POLITICA_1_3_SOMBRA, JSON.parse(fs.readFileSync(a.config13, 'utf8'))) : POLITICA_1_3_SOMBRA;
  let db = null, entradas;
  if (a['de-arquivo']) entradas = lerLocal(a['de-arquivo']);
  else {
    const admin = require('firebase-admin');
    admin.initializeApp({ projectId: typeof a.projeto === 'string' ? a.projeto : 'mr4-ponto' });
    db = admin.firestore();
    entradas = await S.lerEntradas(db);
  }
  const res = S.calcular(entradas, { config, politica13 });
  const orcamento = a.orcamento === undefined ? null : Math.round(Number(a.orcamento) * 100);
  if (orcamento !== null && !(orcamento >= 0)) throw new Error('ORCAMENTO_INVALIDO');
  const sim = A.simular(res, { orcamento_cents: orcamento });
  if (typeof a.saida === 'string') {
    fs.mkdirSync(a.saida, { recursive: true });
    fs.writeFileSync(path.join(a.saida, `compras-sombra14-simulacao-${res.hoje}.csv`), '﻿' + A.csv(sim.linhas, { comNomes: false }));
  }
  const gravado = a.gravar ? await S.persistir(db, res) : null;
  saidaTexto(JSON.stringify({ evento: 'compras_sombra_14', data: res.hoje, modo: gravado ? 'GRAVADO' : 'SEM_ESCRITA', gravado, resumo: res.resumo, simulacao: sim.totais }, null, 1));
  return { res, sim };
}

if (require.main === module) principal().then(() => process.exit(0)).catch(e => { console.error(String(e.message || e).slice(0, 300)); process.exit(1); });
module.exports = { principal, lerLocal, configDaGeracao };
