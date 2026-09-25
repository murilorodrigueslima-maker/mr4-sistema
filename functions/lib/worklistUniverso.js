'use strict';
// N35.15 — Universo híbrido de candidatos da Worklist V2 (puro, sem I/O).
//   MR4_LINKED: perfis_360 existentes (não-GC_NATIVE) + nome do cadastro clientes/
//   GC_NATIVE : perfis_360 GC_NATIVE existentes + compradores GC não vinculados calculados
//               EM MEMÓRIA a partir de vendas_gc (nada é gravado em perfis_360)
// Nome é apresentação: nunca participa de identidade, join ou deduplicação.

const { calcularPerfil360 } = require('./perfil360');
const { rebasarTemporalPerfil } = require('./filaSnapshotGenerator');
const { processarPerfisParaFila } = require('./filaComercialPipeline');
const { filtrarOrdenarFilaHoje } = require('./filaComercialUtils');

function agruparVendasPorCliente(vendas) {
  const m = new Map();
  for (const v of vendas || []) {
    const k = String((v && v.cliente_id) || '');
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  }
  return m;
}

/**
 * @param {object} p
 * @param {Array<{id, data}>} p.perfis    — docs de perfis_360
 * @param {Array<{id, data}>} p.clientes  — docs de clientes
 * @param {Array<object>}     p.vendas    — registros de vendas_gc
 * @param {string}            p.dataReferencia — YYYY-MM-DD
 * @returns {Promise<{ brutos: object[], hoje: object[], stats: object }>}
 */
async function construirUniversoHibrido({ perfis, clientes, vendas, dataReferencia }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia || '')) throw new Error('construirUniversoHibrido: dataReferencia obrigatória');
  const nomePorClienteMr4 = new Map((clientes || []).map(c => [c.id, (c.data && (c.data.nome || c.data.razao_social || c.data.nomeCliente)) || null]));
  const gcVinculados = new Set((clientes || []).filter(c => c.data && c.data.gestaoClickId).map(c => String(c.data.gestaoClickId)));

  const itens = [];
  const gcComPerfil = new Map();
  let mr4 = 0;
  for (const p of perfis || []) {
    const d = p.data || {};
    if (!d.clienteMr4Id) continue;
    if (d.source === 'GC_NATIVE') { gcComPerfil.set(String(d.gestaoClickId), d); continue; }
    itens.push({ perfil360: d, nomeCliente: nomePorClienteMr4.get(p.id) || d.nomeCliente || null });
    mr4++;
  }

  let gcMemoria = 0;
  for (const [gcId, vs] of agruparVendasPorCliente(vendas)) {
    if (gcVinculados.has(gcId)) continue;
    if (gcComPerfil.has(gcId)) {
      const d = gcComPerfil.get(gcId);
      itens.push({ perfil360: d, nomeCliente: d.nomeCliente || null });
      continue;
    }
    const perf = calcularPerfil360({ clienteMr4Id: gcId, gestaoClickId: gcId, vendas: vs, dataReferencia });
    itens.push({ perfil360: { ...perf, source: 'GC_NATIVE', mr4ClientId: null, nomeCliente: null }, nomeCliente: null });
    gcMemoria++;
  }

  const rebased = itens.map(i => ({ perfil360: rebasarTemporalPerfil(i.perfil360, dataReferencia), nomeCliente: i.nomeCliente }));
  const brutos = await processarPerfisParaFila(rebased, { dataReferencia });
  // anexa ultimaCompraEm (auditoria de identidade) sem expor faturamento
  brutos.forEach((b, i) => { b.ultimaCompraEm = rebased[i].perfil360.ultimaCompraEm || null; });
  const hoje = filtrarOrdenarFilaHoje(brutos);
  return {
    brutos,
    hoje,
    stats: {
      perfisMr4Linked: mr4,
      gcNativeComPerfil: gcComPerfil.size,
      gcNativeEmMemoria: gcMemoria,
      totalProcessados: brutos.length,
      hoje: hoje.length,
    },
  };
}

module.exports = { construirUniversoHibrido, agruparVendasPorCliente };
