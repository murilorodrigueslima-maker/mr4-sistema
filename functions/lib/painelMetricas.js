'use strict';
/**
 * Painel Comercial — apuração do faturamento (PURA, sem I/O). Fonte oficial: GestãoClick /vendas (situação Concretizada).
 *  • Dinheiro em CENTAVOS inteiros (nada de ponto flutuante na soma); saída em reais com 2 casas.
 *  • Vendedor por `vendedor_id` (mapeamento auditado); id desconhecido ou ausente ⇒ "Outros". Nunca por nome.
 *  • Deduplicação por `id` estável; o mesmo id com VALORES diferentes é divergência (não publica).
 *  • Só entram vendas cuja situacao_id ∈ STATUS_CONCRETIZADOS; canceladas contadas à parte.
 *  • Chaves de vendedor vêm do mapeamento protegido (painel_mapeamento/vendedores); nenhum nome fica no código.
 *  • Invariante: soma das chaves + outros == geral (em centavos). Sem mapeamento ⇒ erro (nada é publicado).
 */
const STATUS_CONCRETIZADOS = ['3952593'];       // "Concretizada" (vendas). 3952589/3952597 pertencem a orçamentos/OS (não são /vendas) e não têm vendas em 2026.
const STATUS_CANCELADA = '3952594';             // "Cancelada" (vendas)
const RESERVADAS = ['geral', 'outros'];
/** Chaves do mapeamento { vendedor_id → { chave, nomeConfig, ordem? } }, sem repetição. Ordem: campo `ordem`; senão a do objeto (ids numéricos ⇒ crescente). */
function chavesDoMapa(mapa) {
  const itens = Object.values(mapa || {}).filter(m => m && typeof m.chave === 'string' && m.chave && !RESERVADAS.includes(m.chave));
  const peso = m => (Number.isFinite(m.ordem) ? m.ordem : Number.MAX_SAFE_INTEGER);
  return [...new Set(itens.sort((a, b) => peso(a) - peso(b)).map(m => m.chave))];
}

const reDin = /^\d+(\.\d{1,2})?$/;
function centavos(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!reDin.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
const reais = c => Math.round(c) / 100;
const div = (a, b) => (b > 0 ? Math.round(a / b) : 0);        // ticket médio em centavos (arredondado)

function vazio() { return { totalHoje: 0, totalMes: 0, pedidosHoje: 0, pedidosMes: 0, custoMes: 0 }; }
function saida(b) {
  return { totalHoje: reais(b.totalHoje), totalMes: reais(b.totalMes), pedidosHoje: b.pedidosHoje, pedidosMes: b.pedidosMes,
    ticketHoje: reais(div(b.totalHoje, b.pedidosHoje)), ticketMes: reais(div(b.totalMes, b.pedidosMes)) };
}

/**
 * vendas: registros do GC (qualquer situação); hojeStr 'YYYY-MM-DD' (America/Fortaleza); mes 'YYYY-MM' alvo.
 * cfg: { mapa, metas:{<chave>}, metaGeral, outrosConhecidos }
 * Retorna { ok, erros[], geral, <uma entrada por chave do mapa>, outros, qualidade, cancelamentos }.
 */
function calcular({ vendas, hojeStr, mes, cfg }) {
  const mapa = (cfg && cfg.mapa) || {};
  const chaves = chavesDoMapa(mapa);
  const erros = chaves.length ? [] : ['MAPEAMENTO_AUSENTE'];
  const q = { vendasLidas: 0, vendasConsideradas: 0, vendasSemVendedor: 0, vendedoresNaoMapeados: 0, duplicidadesDetectadas: 0, conflitosDeDuplicidade: 0,
    valoresInvalidos: 0, foraDoPeriodo: 0, naoConcretizadas: 0, canceladasQtd: 0, canceladasCentavos: 0, semCusto: 0 };
  const vistos = new Map();
  const b = Object.fromEntries(['geral', ...chaves, 'outros'].map(k => [k, vazio()]));
  const porChave = fn => Object.fromEntries(chaves.map(k => [k, fn(k)]));
  const canc = new Map();
  const diario = {};
  (vendas || []).forEach(v => {
    q.vendasLidas++;
    const id = v && v.id !== undefined && v.id !== null ? String(v.id) : null;
    if (!id) { erros.push('VENDA_SEM_ID'); return; }
    const sit = String(v.situacao_id);
    if (sit === STATUS_CANCELADA) {
      const c = centavos(v.valor_total);
      if (!canc.has(id) && c !== null && String(v.data || '').startsWith(mes)) { canc.set(id, c); q.canceladasQtd++; q.canceladasCentavos += c; }
      return;
    }
    if (!STATUS_CONCRETIZADOS.includes(sit)) { q.naoConcretizadas++; return; }
    const data = String(v.data || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { erros.push('DATA_INVALIDA:' + id); return; }
    if (!data.startsWith(mes)) { q.foraDoPeriodo++; return; }
    const c = centavos(v.valor_total);
    if (c === null) { q.valoresInvalidos++; erros.push('VALOR_INVALIDO:' + id); return; }
    if (vistos.has(id)) {
      q.duplicidadesDetectadas++;
      if (vistos.get(id) !== c) { q.conflitosDeDuplicidade++; erros.push('DUPLICIDADE_CONFLITANTE:' + id); }
      return;
    }
    vistos.set(id, c);
    q.vendasConsideradas++;
    const vid = v.vendedor_id === undefined || v.vendedor_id === null || String(v.vendedor_id).trim() === '' ? null : String(v.vendedor_id);
    let alvo = 'outros';
    if (vid === null) q.vendasSemVendedor++;
    else if (mapa[vid]) alvo = chaves.includes(mapa[vid].chave) ? mapa[vid].chave : 'outros';
    else if (!(cfg && cfg.outrosConhecidos && cfg.outrosConhecidos[vid])) q.vendedoresNaoMapeados++;   // id conhecido de outro responsável (gestão, apoio…) não é "não mapeado"
    const custo = centavos(v.valor_custo);
    if (custo === null || custo === 0) q.semCusto++;
    diario[data] = diario[data] || { v: 0, p: 0 }; diario[data].v += c; diario[data].p += 1;
    const hoje = data === hojeStr;
    for (const k of [alvo, 'geral']) {
      b[k].totalMes += c; b[k].pedidosMes += 1; b[k].custoMes += (custo || 0);
      if (hoje) { b[k].totalHoje += c; b[k].pedidosHoje += 1; }
    }
  });
  // invariantes de reconciliação (em centavos)
  const soma = chaves.reduce((s, k) => s + b[k].totalMes, 0) + b.outros.totalMes;
  const pedidos = chaves.reduce((s, k) => s + b[k].pedidosMes, 0) + b.outros.pedidosMes;
  if (soma !== b.geral.totalMes) erros.push('SOMA_NAO_FECHA_VALOR');
  if (pedidos !== b.geral.pedidosMes) erros.push('SOMA_NAO_FECHA_PEDIDOS');
  if (q.vendasConsideradas !== vistos.size) erros.push('CONTAGEM_INCONSISTENTE');
  const metas = (cfg && cfg.metas) || {}; const metaGeral = Number(cfg && cfg.metaGeral) || 0;
  const comMeta = (bk, meta) => { const o = saida(b[bk]); o.meta = meta || 0; o.pctMeta = meta ? Math.round((b[bk].totalMes / 100 / meta) * 1000) / 10 : 0; o.restante = meta ? Math.max(0, Math.round((meta * 100 - b[bk].totalMes)) / 100) : 0; return o; };
  const out = {
    ok: erros.length === 0, erros,
    geral: comMeta('geral', metaGeral), ...porChave(k => comMeta(k, metas[k])),
    outros: saida(b.outros),                                            // sem meta presumida
    custo: { mesCentavos: b.geral.custoMes, cobertura: q.vendasConsideradas ? Math.round(1000 * (q.vendasConsideradas - q.semCusto) / q.vendasConsideradas) / 10 : 0,
      porChave: { ...porChave(k => b[k].custoMes), outros: b.outros.custoMes } },
    cancelamentos: { qtd: q.canceladasQtd, valor: reais(q.canceladasCentavos) },
    qualidade: { vendasConsideradas: q.vendasConsideradas, vendasSemVendedor: q.vendasSemVendedor, vendedoresNaoMapeados: q.vendedoresNaoMapeados,
      duplicidadesDetectadas: q.duplicidadesDetectadas, conflitosDeDuplicidade: q.conflitosDeDuplicidade, valoresInvalidos: q.valoresInvalidos,
      foraDoPeriodo: q.foraDoPeriodo, naoConcretizadas: q.naoConcretizadas, divergencias: erros.length, reconciliado: erros.length === 0 },
    centavos: { geral: b.geral.totalMes, ...porChave(k => b[k].totalMes), outros: b.outros.totalMes },
    diario,
  };
  return out;
}

module.exports = { calcular, chavesDoMapa, centavos, reais, STATUS_CONCRETIZADOS, STATUS_CANCELADA };
