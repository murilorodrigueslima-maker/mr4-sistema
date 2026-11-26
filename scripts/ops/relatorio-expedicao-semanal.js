#!/usr/bin/env node
'use strict';
/**
 * Relatório semanal da Expedição (loja 262759) — SOMENTE LEITURA. Só agregados; operadores como O1, O2.
 * Não grava nada no Firestore: usa apenas :runQuery e GET. Não lê nome, cidade nem dados de cliente.
 *
 * Uso:
 *   node scripts/ops/relatorio-expedicao-semanal.js                          # semana passada (seg–dom)
 *   node scripts/ops/relatorio-expedicao-semanal.js --periodo 30d --com-vendas
 *   node scripts/ops/relatorio-expedicao-semanal.js --de 2026-11-30 --ate 2026-12-06 --saida ~/relatorios
 * Opções:
 *   --periodo hoje|7d|semana-passada|30d   --de/--ate AAAA-MM-DD
 *   --com-vendas        lê vendas_gc para estimar venda → início (+1 leitura por venda do período)
 *   --saida PASTA       grava .md e .json (sem isso, só imprime)
 *   --max-leituras N    trava de custo (padrão 8000)
 *   --emulador H:P      usa o emulador do Firestore (testes)
 *   --projeto ID        padrão mr4-ponto
 * Credencial: `gcloud auth print-access-token` (leitura do Firestore). O token nunca é impresso.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const M = require('../../js/expedicao-medicao-core.js');

const CAMPOS_PEDIDO = ['numero', 'data', 'ingresadoEm', 'movidoEm', 'coluna', 'saidaEm', 'versao', 'itens', 'valor', 'origem', 'criadoEm', 'vendedor'];
const CAMPOS_VENDA = ['data', 'valor_total', 'cadastrado_em', 'produtos', 'nome_vendedor'];
const CAMPOS_EVENTO = ['pedido', 'de', 'para', 'acao', 'versao', 'em', 'por'];   // sem o motivo (texto livre) de reabertura

// ── Firestore REST (somente leitura) ──────────────────────────────────────────
function valor(v) {
  if (v == null || 'nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) return campos(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  return null;
}
const campos = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, valor(v)]));
const filtro = (campo, op, v) => ({ fieldFilter: { field: { fieldPath: campo }, op, value: v } });
const int = n => ({ integerValue: String(Math.trunc(n)) });
const str = s => ({ stringValue: s });
const ts = ms => ({ timestampValue: new Date(ms).toISOString() });

function criarCliente({ projeto, emulador, maxLeituras, fetchImpl = globalThis.fetch, obterToken }) {
  const base = (emulador ? `http://${emulador}` : 'https://firestore.googleapis.com') + `/v1/projects/${projeto}/databases/(default)/documents`;
  let token = null, leituras = 0;
  const cabecalhos = () => {
    if (emulador) return { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
    token = token || obterToken();
    return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': projeto };
  };
  function somar(n) { leituras += n; if (leituras > maxLeituras) { const e = new Error(`TRAVA_DE_LEITURAS (${leituras} > ${maxLeituras}); reduza o período ou use --max-leituras`); e.codigo = 'TRAVA_DE_LEITURAS'; throw e; } }
  async function pedir(url, init) {
    const r = await fetchImpl(url, { ...init, headers: cabecalhos() });
    if (r.status === 404 && (!init || init.method === 'GET')) return null;
    if (!r.ok) throw new Error('LEITURA_FALHOU HTTP ' + r.status);
    return r.json();
  }
  return {
    leituras: () => leituras,
    async consultar(colecao, { onde, selecionar, pai = '' } = {}) {
      if (leituras >= maxLeituras) somar(1);
      const q = { from: [{ collectionId: colecao }], limit: Math.max(1, maxLeituras - leituras + 1) };
      if (onde) q.where = onde.length === 1 ? onde[0] : { compositeFilter: { op: 'AND', filters: onde } };
      if (selecionar) q.select = { fields: selecionar.map(f => ({ fieldPath: f })) };
      const j = await pedir(base + (pai ? '/' + pai : '') + ':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: q }) });
      const docs = (j || []).filter(x => x.document).map(x => ({ _id: x.document.name.split('/').pop(), ...campos(x.document.fields) }));
      somar(Math.max(1, docs.length));   // consulta vazia custa 1 leitura
      return docs;
    },
    async documento(caminho) {
      const j = await pedir(base + '/' + caminho, { method: 'GET' }); somar(1);
      return j ? campos(j.fields) : null;
    },
  };
}

async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => { while (i < itens.length) { const k = i++; saida[k] = await fn(itens[k]); } }));
  return saida;
}

const apelido = s => (s ? 'h' + crypto.createHash('sha256').update(String(s).replace(/^\d{2,3}[.\d]*\s+/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()).digest('hex').slice(0, 16) : '');

async function coletar(db, { inicioMs, fimMs, comVendas }) {
  const config = await db.documento(`${M.CFG_DOC.colecao}/${M.CFG_DOC.id}`);
  const movidos = await db.consultar('expedicao_pedidos', { onde: [filtro('movidoEm', 'GREATER_THAN_OR_EQUAL', int(inicioMs))], selecionar: CAMPOS_PEDIDO });
  const ativos = await db.consultar('expedicao_pedidos', { onde: [filtro('coluna', 'IN', { arrayValue: { values: ['ag', 'se', 'pr'].map(str) } })], selecionar: CAMPOS_PEDIDO });
  const comTrilha = movidos.filter(p => Number(p.versao) >= 1);
  const eventos = (await emParalelo(comTrilha, 10, p => db.consultar('eventos', {
    pai: 'expedicao_pedidos/' + encodeURIComponent(p._id), onde: [filtro('versao', 'GREATER_THAN_OR_EQUAL', int(1))], selecionar: CAMPOS_EVENTO,
  }))).flat();
  const registros = await db.consultar(M.COL_REGISTROS, { onde: [filtro('em', 'GREATER_THAN_OR_EQUAL', ts(inicioMs))] });
  let vendas = null;
  if (comVendas) {
    const de = M.diaFortaleza(inicioMs - 7 * 86400000), ate = M.diaFortaleza(fimMs - 1);
    vendas = (await db.consultar('vendas_gc', { onde: [filtro('data', 'GREATER_THAN_OR_EQUAL', str(de)), filtro('data', 'LESS_THAN_OR_EQUAL', str(ate))], selecionar: CAMPOS_VENDA }))
      .map(v => ({ id: v._id, data: v.data, valor: Number(v.valor_total), cadastradoEm: v.cadastrado_em, linhas: (v.produtos || []).length, vendedor: apelido(v.nome_vendedor) }));
  }
  const limpar = p => ({ ...p, numero: String(p.numero || p._id), vendedor: apelido(p.vendedor) });
  return { config, pedidos: movidos.map(limpar), ativos: ativos.map(limpar), eventos, registros, vendas };
}

function montar(dados, { inicioMs, fimMs, agoraMs }) {
  let vendaMs = null; const notas = [];
  if (dados.vendas) {
    // só pedidos que entraram no período (pela sincronização) entram na ligação com a venda
    const alvo = dados.pedidos.filter(p => { const t = M.emMs(p.criadoEm) ?? M.emMs(p.ingresadoEm); return p.origem === 'sync' && t >= inicioMs && t < fimMs; });
    const v = M.vincularVendas(alvo, dados.vendas); vendaMs = v.vendaMs;
    notas.push(`Venda ligada por aproximação (data + valor + nº de linhas + vendedor): ${v.ligados} de ${v.total} pedidos que entraram no período (${M.pct(v.total ? v.ligados / v.total : null)}). O espelho de vendas é atualizado a cada poucas horas: vendas recentes podem faltar.`);
  }
  notas.push(`Captura opcional: ${M.configAtiva(dados.config) ? 'LIGADA' : 'DESLIGADA'} no momento da geração; ${dados.registros.length} registro(s) desde o início do período.`);
  const r = M.calcular({ pedidos: dados.pedidos, eventos: dados.eventos, registros: dados.registros, ativos: dados.ativos, vendaMs, inicioMs, fimMs, agoraMs });
  return { r, notas };
}

function argumentos(argv) {
  const o = { periodo: 'semana-passada', projeto: 'mr4-ponto', maxLeituras: 8000, comVendas: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], prox = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error('FALTA_VALOR ' + a); return v; };
    if (a === '--periodo') o.periodo = prox();
    else if (a === '--de') o.de = prox();
    else if (a === '--ate') o.ate = prox();
    else if (a === '--saida') o.saida = prox();
    else if (a === '--emulador') o.emulador = prox();
    else if (a === '--projeto') o.projeto = prox();
    else if (a === '--max-leituras') o.maxLeituras = Number(prox());
    else if (a === '--com-vendas') o.comVendas = true;
    else throw new Error('OPCAO_DESCONHECIDA ' + a);
  }
  if (!Number.isInteger(o.maxLeituras) || o.maxLeituras < 1) throw new Error('MAX_LEITURAS_INVALIDO');
  return o;
}
function intervaloDe(o, agoraMs) {
  if (o.de || o.ate) {
    const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
    if (!ok(o.de) || !ok(o.ate) || o.de > o.ate) throw new Error('USE --de AAAA-MM-DD --ate AAAA-MM-DD');
    return { de: o.de, ate: o.ate, inicioMs: Date.parse(o.de + 'T00:00:00-03:00'), fimMs: Date.parse(o.ate + 'T00:00:00-03:00') + 86400000 };
  }
  return M.periodo(o.periodo, agoraMs);
}

async function executar(argv, { agoraMs = Date.now(), escrever = s => process.stdout.write(s + '\n'), fetchImpl } = {}) {
  const o = argumentos(argv), p = intervaloDe(o, agoraMs);
  const db = criarCliente({ projeto: o.projeto, emulador: o.emulador, maxLeituras: o.maxLeituras, fetchImpl,
    obterToken: () => execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() });
  const dados = await coletar(db, { ...p, comVendas: o.comVendas });
  const { r, notas } = montar(dados, { ...p, agoraMs });
  notas.push(`Leituras do Firestore nesta execução: ${db.leituras()} (somente leitura).`);
  const md = M.paraMarkdown(r, { notas });
  escrever(md);
  if (o.saida) {
    fs.mkdirSync(o.saida, { recursive: true });
    const nome = path.join(o.saida, `expedicao-${p.de}_a_${p.ate}`);
    fs.writeFileSync(nome + '.md', md); fs.writeFileSync(nome + '.json', JSON.stringify({ resultado: r, notas }, null, 2));
    escrever('Gravado: ' + nome + '.md e .json');
  }
  return { resultado: r, notas, leituras: db.leituras() };
}

if (require.main === module) executar(process.argv.slice(2)).catch(e => { console.error('Falhou: ' + String(e.message).slice(0, 200)); process.exit(1); });
module.exports = { argumentos, intervaloDe, criarCliente, coletar, montar, executar, valor, apelido, CAMPOS_PEDIDO, CAMPOS_EVENTO };
