'use strict';
// COMPRAS — classificação de ORIGEM persistida (compra pertence à loja ativa?). Critério de comprovação: TÍTULO A PAGAR da loja
// ativa (lido pelo sync financeiro com loja_id=262759) que cita "Compra de nº <código>", código único e mesmo fornecedor.
// Nenhuma chamada à API: os títulos e o índice de compras vêm do próprio sync financeiro. Nenhuma outra loja é consultada.
//
//   compras_origem/{compraId}            {nivel, usar_em_decisao_automatica, atualizadoEm, ...evidências}   (contrato; leitura gestor)
//   compras_origem_controle/atual        resumo + mapa de todas as compras em UMA leitura (string JSON: evita índice por campo)
//   compras_origem_confirmacao/{compraId} + historico/   confirmação manual do gestor (escrita só pela callable)
//
// `usar_em_decisao_automatica=false` = a compra fica FORA das recomendações novas até haver prova ou confirmação.
// A Política 1.2 (vigente) NÃO lê estes documentos. Documento AUSENTE = compra ainda não classificada (não é "sem origem").
const Conf = require('./confiabilidade');
const { LOJA_ATIVA_ID } = require('../lojaAtiva');

const SCHEMA = 'origem-1';
const COL = Object.freeze({ origem: 'compras_origem', controle: 'compras_origem_controle', confirmacao: 'compras_origem_confirmacao' });
const CRITERIO = 'TITULO_A_PAGAR';
const NIVEIS_ORIGEM = Object.freeze(['COMPROVADA_TITULO', 'CONFIRMADA_GESTOR', 'CONFLITO', 'SEM_PROVA', 'REJEITADA_GESTOR']);
const DECISOES_ORIGEM = Object.freeze(['CONFIRMADA_LOJA', 'NAO_PERTENCE', 'VOLTAR_AUTOMATICO']);
const LOTE = 200;
const MAX_VENCIMENTOS = 12;
const QUEDA_SUSPEITA = 0.5;          // menos da metade das comprovadas anteriores → leitura suspeita: nada é gravado
const BYTES_MAX = 900 * 1024;

/** Classificação efetiva: prova por título prevalece; a recusa do gestor sempre isola; a confirmação só vale onde não há prova. */
function efetivo(nivelAuto, manual = null) {
  if (manual === 'NAO_PERTENCE') return { nivel: 'REJEITADA_GESTOR', usar_em_decisao_automatica: false };
  if (nivelAuto === 'COMPROVADA_TITULO') return { nivel: nivelAuto, usar_em_decisao_automatica: true };
  if (manual === 'CONFIRMADA_LOJA') return { nivel: 'CONFIRMADA_GESTOR', usar_em_decisao_automatica: true };
  return { nivel: nivelAuto === 'CONFLITO' ? 'CONFLITO' : 'SEM_PROVA', usar_em_decisao_automatica: false };
}

/**
 * @param compras índice de compras { id, codigo, fornecedor_id }
 * @param titulos canônicos do financeiro (só PAGAR são usados)
 * @param lojaPorTitulo Map id do título → loja_id declarado no registro (quando a API informa)
 */
function classificarPorTitulos({ compras, titulos, lojaPorTitulo = new Map() }) {
  const daLoja = [], estat = { lidos: 0, outra_loja: 0, com_loja_no_registro: 0 };
  for (const t of titulos || []) {
    if (t.natureza && t.natureza !== 'PAGAR') continue;
    estat.lidos++;
    const loja = lojaPorTitulo.get(String(t.source_id));
    if (loja !== undefined && loja !== null && loja !== '') {
      if (String(loja) !== LOJA_ATIVA_ID) { estat.outra_loja++; continue; }        // título de outra loja nunca comprova
      estat.com_loja_no_registro++;
    }
    daLoja.push(t);
  }
  const { porCompra } = Conf.vincularTitulosACompras(compras, daLoja);
  const linhas = Conf.classificarOrigem({ compras, vinculos: porCompra });
  const porId = new Map((compras || []).map(c => [String(c.id), c]));
  const out = new Map();
  for (const l of linhas) {
    const v = porCompra.get(l.id) || {}, c = porId.get(l.id) || {};
    out.set(l.id, { nivel_automatico: l.nivel, numero: c.codigo === null || c.codigo === undefined ? null : String(c.codigo), fornecedorId: l.fornecedor_id,
      titulos: v.titulos || 0, titulos_pagos: v.pagos || 0, soma_titulos_cents: v.soma_cents || 0, conflitos: v.conflitos || 0,
      vencimentos: [...(v.vencimentos || [])].sort().slice(0, MAX_VENCIMENTOS) });
  }
  return { porCompra: out, titulos: estat };
}

// mapa compacto do controle (chaves curtas): a = nível automático, m = decisão manual, n = número, f = fornecedor, t/p/s = títulos, x = conflitos, v = vencimentos
const entrada = (a, m) => ({ a: a.nivel_automatico, m: m || null, n: a.numero, f: a.fornecedorId, t: a.titulos, p: a.titulos_pagos, s: a.soma_titulos_cents, x: a.conflitos, v: a.vencimentos });
const mesma = (x, y) => !!x && JSON.stringify(x) === JSON.stringify(y);

function docOrigem(id, e, agora, confirmacao = null) {
  return { compraId: id, ...efetivo(e.a, e.m), nivel_automatico: e.a, numero: e.n, fornecedorId: e.f, titulos: e.t, titulos_pagos: e.p, soma_titulos_cents: e.s, conflitos: e.x,
    criterio: CRITERIO, loja: LOJA_ATIVA_ID, confirmacao_manual: e.m ? { decisao: e.m, ...(confirmacao || {}) } : null, atualizadoEm: agora };
}
function resumoDe(mapa) {
  const por = Object.fromEntries(NIVEIS_ORIGEM.map(n => [n, 0]));
  let comprovadas = 0;
  for (const e of Object.values(mapa)) { const x = efetivo(e.a, e.m); por[x.nivel]++; if (x.usar_em_decisao_automatica) comprovadas++; }
  const total = Object.keys(mapa).length;
  return { total, liberadas: comprovadas, isoladas: total - comprovadas, por_nivel: por };
}

/** Lê o controle (UMA leitura). { disponivel, gerado_em, mapa, isoladas:Set } — controle ausente ou ilegível = indisponível. */
function interpretarControle(d) {
  const vazio = { disponivel: false, gerado_em: null, mapa: {}, isoladas: new Set() };
  if (!d || d.schema !== SCHEMA || typeof d.compras_json !== 'string') return vazio;
  let mapa; try { mapa = JSON.parse(d.compras_json); } catch (_) { return vazio; }
  const isoladas = new Set(Object.entries(mapa).filter(([, e]) => !efetivo(e.a, e.m).usar_em_decisao_automatica).map(([id]) => id));
  return { disponivel: true, gerado_em: d.gerado_em || null, mapa, isoladas, resumo: d.resumo || null };
}
async function lerControle(db) {
  const s = await db.collection(COL.controle).doc('atual').get();
  return interpretarControle(s.exists ? s.data() : null);
}
/** Remove das compras (formato da API, base compacta ou fatos canônicos) as que estão isoladas. */
function isolarCompras(compras, isoladas) {
  if (!isoladas || !isoladas.size) return compras;
  return (compras || []).filter(w => { const c = (w && w.Compra) || w; return !isoladas.has(String(c.purchase_id !== undefined ? c.purchase_id : c.id)); });
}

function docControle(mapa, meta, agora) {
  let json = JSON.stringify(mapa);
  if (Buffer.byteLength(json) > BYTES_MAX) json = JSON.stringify(Object.fromEntries(Object.entries(mapa).map(([k, e]) => [k, { ...e, v: [] }])));
  if (Buffer.byteLength(json) > BYTES_MAX) { const e = new Error('ORIGEM_CONTROLE_GRANDE_DEMAIS'); e.codigo = e.message; throw e; }
  return { schema: SCHEMA, loja: LOJA_ATIVA_ID, criterio: CRITERIO, ...meta, resumo: resumoDe(mapa), compras_json: json, gerado_em: agora.toISOString() };
}

/**
 * Grava/atualiza a classificação. Só escreve o que mudou. Cada lote é uma transação que relê o controle (onde também vive a decisão
 * manual), então nunca desfaz uma confirmação feita ao mesmo tempo. Compra que sumiu do índice não é apagada.
 */
async function persistirOrigem(db, { compras, titulos, lojaPorTitulo, agora = new Date(), runId = null, geracaoFinanceiro = null }) {
  if (!(compras || []).length || !(titulos || []).length) return { gravado: false, motivo: 'DADOS_INSUFICIENTES' };
  const { porCompra, titulos: estatTitulos } = classificarPorTitulos({ compras, titulos, lojaPorTitulo });
  const provadas = [...porCompra.values()].filter(a => a.nivel_automatico === 'COMPROVADA_TITULO').length;
  if (!provadas) return { gravado: false, motivo: 'NENHUMA_COMPRA_COMPROVADA' };
  const refC = db.collection(COL.controle).doc('atual');
  const antesDoc = await refC.get();
  const antes = interpretarControle(antesDoc.exists ? antesDoc.data() : null);
  const provadasAntes = Object.values(antes.mapa).filter(e => e.a === 'COMPROVADA_TITULO').length;
  if (provadasAntes && provadas < provadasAntes * QUEDA_SUSPEITA) return { gravado: false, motivo: 'QUEDA_SUSPEITA', antes: provadasAntes, agora: provadas };
  const mudaram = [...porCompra].filter(([id, a]) => !antes.mapa[id] || !mesma(antes.mapa[id], entrada(a, antes.mapa[id].m))).map(([id]) => id);
  const meta = { run_id: runId, geracao_financeiro: geracaoFinanceiro, titulos: estatTitulos };
  const lotes = []; for (let i = 0; i < mudaram.length; i += LOTE) lotes.push(mudaram.slice(i, i + LOTE));
  if (!lotes.length) lotes.push([]);                                                  // nada mudou: só renova o carimbo do controle
  let resumo;
  for (const lote of lotes) {
    await db.runTransaction(async tx => {
      const s = await tx.get(refC);
      const atual = interpretarControle(s.exists ? s.data() : null).mapa;
      const manuais = new Map();
      for (const id of lote) if (atual[id] && atual[id].m) { const c = await tx.get(db.collection(COL.confirmacao).doc(id)); if (c.exists) manuais.set(id, resumoConfirmacao(c.data())); }
      const mapa = { ...atual };
      for (const id of lote) {
        const e = entrada(porCompra.get(id), atual[id] ? atual[id].m : null);
        mapa[id] = e;
        tx.set(db.collection(COL.origem).doc(id), docOrigem(id, e, agora, manuais.get(id) || null));
      }
      const d = docControle(mapa, meta, agora); resumo = d.resumo;
      tx.set(refC, d);
    });
  }
  return { gravado: true, alteradas: mudaram.length, resumo, titulos: estatTitulos };
}
const resumoConfirmacao = c => ({ observacao: c.observacao || null, atualizadoPorUid: c.atualizadoPorUid || null, atualizadoEm: c.atualizadoEm || null });

module.exports = { SCHEMA, COL, CRITERIO, NIVEIS_ORIGEM, DECISOES_ORIGEM, efetivo, classificarPorTitulos, entrada, docOrigem, docControle, resumoDe, interpretarControle, lerControle, isolarCompras, persistirOrigem };
