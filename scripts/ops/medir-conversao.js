#!/usr/bin/env node
'use strict';
/**
 * COM-02 — medição da conversão comercial. SOMENTE LEITURA (REST do Firestore: GET, runQuery, batchGet; nenhuma escrita).
 * Imprime apenas AGREGADOS, com vendedores rotulados V1, V2… (ordem = nº de vendas em 12 meses). Sem nomes de clientes ou pessoas.
 *
 * Uso:  node scripts/ops/medir-conversao.js [--corte AAAA-MM-DD] [--desde AAAA-MM-DD] [--janela 14] [--cache /caminho/fora/do/repo.json]
 *   --corte  último dia com vendas completas (padrão: ontem, fuso de Fortaleza)
 *   --desde  início do recorte de vendas (padrão: 13 meses antes do corte). Clientes contatados sem compra no recorte são consultados à parte.
 *   --cache  reaproveita a leitura (se o arquivo existir, não consulta nada). Contém IDs e valores: nunca versionar.
 * Autenticação: `gcloud auth print-access-token` da sessão local (o token fica só em memória; nunca é impresso ou gravado).
 * Custo típico: ~8 mil leituras.
 */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const RAIZ = path.resolve(__dirname, '..', '..');
const C = require(path.join(RAIZ, 'functions/lib/conversaoComercial'));
const { validarVenda } = require(path.join(RAIZ, 'functions/lib/carteiraRegra'));
const { diaComercial } = require(path.join(RAIZ, 'functions/lib/crmTimeline'));

const BASE = 'https://firestore.googleapis.com/v1/projects/mr4-ponto/databases/(default)/documents';
const CAMPOS_VENDA = ['id', 'cliente_id', 'data', 'nome_situacao', 'valor_total', 'vendedor_id', 'cadastrado_em'];
const arg = (n, padrao) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : padrao; };
const somarDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let TOKEN = null, leituras = 0;
async function http(url, body) {
  if (!TOKEN) TOKEN = execFileSync('gcloud', ['auth', 'print-access-token'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url.split('/documents')[1] || url}`);
  return r.json();
}
function valor(v) {
  const k = Object.keys(v)[0], x = v[k];
  if (k === 'mapValue') return campos(x.fields);
  if (k === 'arrayValue') return (x.values || []).map(valor);
  if (k === 'nullValue') return null;
  if (k === 'integerValue') return Number(x);
  return x;
}
const campos = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, valor(v)]));
const doc = d => ({ _id: d.name.split('/').pop(), ...campos(d.fields) });

async function listar(colecao, mascara) {
  const out = []; let pagina = null;
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const m of mascara) q.append('mask.fieldPaths', m);
    if (pagina) q.set('pageToken', pagina);
    const r = await http(`${BASE}/${colecao}?${q}`);
    for (const d of r.documents || []) out.push(doc(d));
    pagina = r.nextPageToken;
  } while (pagina);
  leituras += Math.max(1, out.length);
  return out;
}
async function consultar(colecao, campo, op, v) {
  const r = await http(`${BASE}:runQuery`, { structuredQuery: {
    from: [{ collectionId: colecao }], select: { fields: CAMPOS_VENDA.map(fieldPath => ({ fieldPath })) },
    where: { fieldFilter: { field: { fieldPath: campo }, op, value: { stringValue: v } } } } });
  const out = r.filter(x => x.document).map(x => { const d = doc(x.document); return { ...d, id: d.id || d._id }; });
  leituras += Math.max(1, out.length);
  return out;
}

const gcDe = (e, vinculos) => (String(e.commercialEntityId).startsWith('GC_NATIVE:') ? e.commercialEntityId.slice(10) : vinculos[e.commercialEntityId]);

async function ler(desde) {
  const estados = await listar('interacoes_fila', ['opportunityInstanceId', 'commercialEntityId', 'tipoOportunidade', 'estado', 'eventos']);
  const vendas = await consultar('vendas_gc', 'data', 'GREATER_THAN_OR_EQUAL', desde);
  const devolucoes = (await listar('carteira_comercial_devolucoes', ['vendaId', 'tipo'])).map(d => ({ vendaId: String(d.vendaId), tipo: d.tipo }));
  const gcIdPorEntidade = {};
  const mr4 = [...new Set(estados.map(e => e.commercialEntityId).filter(e => String(e).startsWith('MR4_LINKED:')))];
  for (let i = 0; i < mr4.length; i += 100) {
    const nomes = mr4.slice(i, i + 100).map(e => `${BASE.split('/v1/')[1]}/clientes/${e.slice(11)}`);
    const r = await http(`${BASE}:batchGet`, { documents: nomes, mask: { fieldPaths: ['gestaoClickId'] } });
    leituras += nomes.length;
    for (const x of r) if (x.found) { const d = doc(x.found); if (d.gestaoClickId != null) gcIdPorEntidade['MR4_LINKED:' + d._id] = String(d.gestaoClickId); }
  }
  // histórico anterior ao recorte: só para clientes contatados sem nenhuma compra antes do 1º contato
  const primeiro = new Map();
  for (const e of estados) {
    const gc = gcDe(e, gcIdPorEntidade);
    for (const c of C.contatosDaOportunidade(e)) if (gc && (!primeiro.has(gc) || c.dia < primeiro.get(gc))) primeiro.set(gc, c.dia);
  }
  let consultasHistorico = 0;
  for (const [gc, dia] of primeiro) {
    if (vendas.some(v => String(v.cliente_id) === gc && v.data < dia && !validarVenda(v))) continue;
    vendas.push(...(await consultar('vendas_gc', 'cliente_id', 'EQUAL', gc)).filter(v => v.data < desde)); consultasHistorico++;
  }
  const usuarios = (await listar('sistema_usuarios', ['carteiraComercial.gestaoClickVendedorId']))
    .map(u => ({ uid: u._id, gc: u.carteiraComercial && u.carteiraComercial.gestaoClickVendedorId ? String(u.carteiraComercial.gestaoClickVendedorId) : null }));
  const carteira = (await listar('carteira_comercial', ['ownerUid'])).map(c => ({ gc: c._id.replace(/^GC:/, ''), ownerUid: c.ownerUid || null }));
  return { lidoEm: new Date().toISOString(), desde, leituras, consultasHistorico, estados, vendas, devolucoes, gcIdPorEntidade, usuarios, carteira };
}

/** uid → V1, V2…: ordem pelo nº de vendas válidas em 12 meses do vendedor GC mapeado; sem mapeamento, depois, por uid. */
function rotular(dados, corte) {
  const desde = somarDias(corte, -365), porGc = {};
  for (const v of dados.vendas) if (!validarVenda(v, corte) && v.data > desde) porGc[v.vendedor_id] = (porGc[v.vendedor_id] || 0) + 1;
  const ordemGc = Object.entries(porGc).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const rotuloGc = Object.fromEntries(ordemGc.map((id, i) => [id, 'V' + (i + 1)]));
  const rotuloUid = {}; let n = ordemGc.length;
  const usados = new Set([...dados.estados.flatMap(e => (e.eventos || []).map(x => x.operadorId)), ...dados.carteira.map(c => c.ownerUid)].filter(Boolean));
  for (const uid of [...usados].sort()) {
    const u = dados.usuarios.find(x => x.uid === uid);
    rotuloUid[uid] = (u && u.gc && rotuloGc[u.gc]) || 'V' + (++n) + ' (sem vínculo GC)';
  }
  return { rotuloUid, vendasPorVendedor12m: Object.fromEntries(ordemGc.map(id => [rotuloGc[id], porGc[id]])) };
}

function relatorio(dados, { corte, janela }) {
  const { rotuloUid, vendasPorVendedor12m } = rotular(dados, corte);
  const r = u => rotuloUid[u] || 'desconhecido';
  const entrada = {
    estados: dados.estados, vendas: dados.vendas, gcIdPorEntidade: dados.gcIdPorEntidade,
    devolucoes: new Map(dados.devolucoes.slice().sort((a, b) => (a.tipo === 'TOTAL') - (b.tipo === 'TOTAL')).map(d => [d.vendaId, d.tipo])),   // TOTAL prevalece
    vendedorGcPorUid: Object.fromEntries(dados.usuarios.filter(u => u.gc).map(u => [u.uid, u.gc])),
    opcoes: { dataCorte: corte, janelaDias: janela },
  };
  const f = C.calcularFunil(entrada);
  const porRotulo = res => Object.fromEntries(Object.entries(res).map(([u, x]) => [r(u), x]).sort());
  const resultados = {}, tipos = {};
  for (const e of dados.estados) for (const c of C.contatosDaOportunidade(e)) if (c.dia <= corte) {
    const k = r(c.operadorId); resultados[k] = resultados[k] || {}; resultados[k][c.outcome] = (resultados[k][c.outcome] || 0) + 1;
  }
  for (const t of [...new Set(dados.estados.map(e => e.tipoOportunidade))]) {
    const x = C.calcularFunil({ ...entrada, estados: dados.estados.filter(e => e.tipoOportunidade === t) }).total;
    // atribuição por tipo isolado (sem concorrência entre tipos): só para leitura relativa, não somar
    tipos[t] = { contatadas: x.oportunidades.contatadas, conversa: x.oportunidades.conversa, convertidas: x.oportunidades.convertidas, base: x.maduras.base, convertidasMaduras: x.maduras.convertidas };
  }
  // meses (coorte pela data do 1º contato)
  const meses = {};
  for (const m of [...new Set(dados.estados.flatMap(e => C.contatosDaOportunidade(e).map(c => c.dia.slice(0, 7))))].sort()) {
    const x = C.calcularFunil({ ...entrada, opcoes: { ...entrada.opcoes, inicio: m + '-01', fim: m + '-31' } }).total;
    meses[m] = { contatadas: x.oportunidades.contatadas, conversa: x.oportunidades.conversa, convertidas: x.oportunidades.convertidas, pedidos: x.pedidos, faturamento: x.faturamento, base: x.maduras.base, convertidasMaduras: x.maduras.convertidas };
  }
  // cobertura da carteira e referência: faturamento total dos vendedores no período
  const contatados = new Set(dados.estados.filter(e => C.contatosDaOportunidade(e).some(c => c.outcome !== 'CONTATO_INVALIDO' && c.dia <= corte))
    .map(e => gcDe(e, dados.gcIdPorEntidade)));
  const carteira = {};
  for (const c of dados.carteira) { const k = c.ownerUid ? r(c.ownerUid) : 'sem dono'; carteira[k] = carteira[k] || { clientes: 0, contatados: 0 }; carteira[k].clientes++; if (contatados.has(c.gc)) carteira[k].contatados++; }
  const dias1 = dados.estados.flatMap(e => C.contatosDaOportunidade(e).map(c => c.dia)).sort();
  const inicio = dias1[0] || corte;
  const vendasPeriodo = C.indexarVendas(dados.vendas, { dataCorte: corte }).porCliente;
  let pedidosPeriodo = 0, fatPeriodo = 0;
  for (const l of vendasPeriodo.values()) for (const v of l) if (v.data >= inicio && v.data <= corte) { pedidosPeriodo++; fatPeriodo += v.valorC; }
  const linhas = C.JANELAS_SENSIBILIDADE.map(j => ({ janelaDias: j, ...C.linhaDeBase({ ...entrada, opcoes: { ...entrada.opcoes, janelaDias: j } }) }));
  return {
    meta: { lidoEm: dados.lidoEm, corte, janelaDias: janela, vendasDesde: dados.desde, leituras: dados.leituras, consultasHistorico: dados.consultasHistorico,
      interacoes: dados.estados.length, vendasLidas: dados.vendas.length, devolucoes: dados.devolucoes.length, primeiroContato: inicio, ultimoContato: dias1[dias1.length - 1] || null,
      ultimoCadastroDeVenda: dados.vendas.map(v => v.cadastrado_em || '').sort().pop() || null },
    vendasPorVendedor12m, resultadosPorVendedor: resultados,
    total: f.total, porVendedor: porRotulo(f.porVendedor), exclusoes: f.exclusoes,
    sensibilidade: C.sensibilidade(entrada),
    sensibilidadePorVendedor: Object.fromEntries(C.JANELAS_SENSIBILIDADE.map(j => [j, Object.fromEntries(Object.entries(porRotulo(C.calcularFunil({ ...entrada, opcoes: { ...entrada.opcoes, janelaDias: j } }).porVendedor))
      .map(([k, x]) => [k, { convertidas: x.oportunidades.convertidas, reativadas: x.oportunidades.reativadas, pedidos: x.pedidos, faturamento: x.faturamento, base: x.maduras.base, convertidasMaduras: x.maduras.convertidas }]))])),
    porTipo: tipos, porMesDoPrimeiroContato: meses, carteira,
    referenciaPeriodo: { de: inicio, ate: corte, pedidosValidos: pedidosPeriodo, faturamento: fatPeriodo / 100 },
    linhaDeBase: linhas.map(x => ({ janelaDias: x.janelaDias, controlesElegiveis: x.controlesElegiveis, grupos: x.grupos })),
    aviso: linhas[0].aviso,
  };
}

async function main() {
  const corte = arg('corte', somarDias(diaComercial(new Date().toISOString()), -1));
  const desde = arg('desde', somarDias(corte, -395));
  const janela = Number(arg('janela', C.JANELA_PADRAO_DIAS));
  const cache = arg('cache', null);
  if (cache && path.resolve(cache).startsWith(RAIZ + path.sep)) throw new Error('--cache deve ficar FORA do repositório');
  let dados;
  if (cache && fs.existsSync(cache)) dados = JSON.parse(fs.readFileSync(cache, 'utf8'));
  else { dados = await ler(desde); if (cache) fs.writeFileSync(cache, JSON.stringify(dados), { mode: 0o600 }); }
  console.log(JSON.stringify(relatorio(dados, { corte, janela }), null, 1));
}
if (require.main === module) main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
module.exports = { relatorio, rotular };
