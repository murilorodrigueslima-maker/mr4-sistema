'use strict';
// COMPRAS — parâmetros por fornecedor: esquema/validação estrita e ESTIMATIVAS a partir do histórico. FUNÇÕES PURAS.
// MANUAL = informado pelo gestor · ESTIMADO = sugestão calculada aqui, aceita sem alteração (o servidor confere o valor).
// Toda estimativa informa a base (método e amostra); sem amostra mínima não há valor — nada é preenchido por premissa.
// O ERP não informa recebimento, mínimo nem embalagem: prazo é PROXY e mínimo/múltiplo são o que foi OBSERVADO nas compras.
const { situacaoCompra, parseData, diffDias, somarDias } = require('./canonico');
const { unidadesPorProduto, valorCompraCents } = require('./confiabilidade');
// quantil por posição (nearest-rank): o valor devolvido é sempre um valor observado
const quantil = (valores, p) => { const o = [...valores].sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.max(0, Math.ceil(p * o.length) - 1))] : null; };

const ORIGENS = Object.freeze(['NACIONAL', 'IMPORTADO']);
const CONFIABILIDADES = Object.freeze(['ALTA', 'MEDIA', 'BAIXA']);
const FONTES = Object.freeze(['MANUAL', 'ESTIMADO']);
const INTEIROS = Object.freeze({ prazoMedioDias: [0, 365], prazoMaxDias: [0, 730], qtdMinima: [1, 1000000], valorMinimoCents: [1, 10000000000], multiploPadrao: [1, 10000], frequenciaReposicaoDias: [1, 365] });
const ENUMS = Object.freeze({ origem: ORIGENS, confiabilidadePrazo: CONFIABILIDADES });
const TEXTOS = Object.freeze({ condicoesPagamento: 200 });
const MAPAS = Object.freeze({ multiplosPorProduto: [1, 10000], qtdMinimaPorProduto: [1, 1000000] });
const ESCALARES = Object.freeze([...Object.keys(INTEIROS), ...Object.keys(TEXTOS), ...Object.keys(ENUMS)]);
const MAX_PRODUTOS_MAPA = 300;
const RE_PRODUTO = /^[A-Za-z0-9-]{1,40}$/;

// Premissas declaradas das estimativas (mostradas na base de cada sugestão).
const REGRAS = Object.freeze({
  janela_prazo_dias: 540, prazo_max_valido_dias: 90, min_amostras_prazo: 5,
  janela_pedidos_dias: 730, min_compras: 5, min_linhas_multiplo: 10, min_compras_multiplo: 3, min_compras_produto: 3, min_datas_frequencia: 5, min_compras_pagamento: 3,
  confiabilidade_alta_ate: 0.25, confiabilidade_media_ate: 0.75,
});
const RE_NOME_IMPORTADO = /ali\s?express|alibaba|co\.?\s*,?\s*ltd|trading|trade co|guangzhou|shenzhen|china|import(adora|a[cç][aã]o)?\b/i;

const inteiroEntre = (v, [a, b]) => Number.isInteger(v) && v >= a && v <= b;
const objeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
const limparTexto = v => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Valida o payload da gravação. `valores` = só os campos preenchidos; `fontes` = origem de cada campo escalar preenchido;
 * `fontesPorProduto` = origem de cada item dos mapas. Devolve { erros[], doc } com todos os campos (ausente = null / {}).
 */
function validarParametros(valores, fontes = {}, fontesPorProduto = {}) {
  const erros = [];
  if (!objeto(valores) || !objeto(fontes) || !objeto(fontesPorProduto)) return { erros: ['PAYLOAD_INVALIDO'], doc: null };
  const doc = { ...Object.fromEntries(ESCALARES.map(k => [k, null])), ...Object.fromEntries(Object.keys(MAPAS).map(k => [k, {}])) };
  const saidaFontes = {}, saidaPorProduto = {};
  for (const k of Object.keys(valores)) if (!ESCALARES.includes(k) && !MAPAS[k]) erros.push('CAMPO_DESCONHECIDO: ' + String(k).slice(0, 40));
  for (const k of Object.keys(fontes)) if (!ESCALARES.includes(k) || valores[k] === undefined) erros.push('FONTE_SEM_CAMPO: ' + String(k).slice(0, 40));
  for (const k of Object.keys(fontesPorProduto)) if (!MAPAS[k]) erros.push('FONTE_SEM_CAMPO: ' + String(k).slice(0, 40));
  for (const k of ESCALARES) {
    const v = valores[k];
    if (v === undefined) continue;
    if (INTEIROS[k]) { if (!inteiroEntre(v, INTEIROS[k])) erros.push(`${k}: inteiro entre ${INTEIROS[k][0]} e ${INTEIROS[k][1]}`); else doc[k] = v; }
    else if (ENUMS[k]) { if (!ENUMS[k].includes(v)) erros.push(`${k}: use ${ENUMS[k].join(' ou ')}`); else doc[k] = v; }
    else { const t = typeof v === 'string' ? limparTexto(v) : ''; if (!t || t.length > TEXTOS[k]) erros.push(`${k}: texto de 1 a ${TEXTOS[k]} caracteres`); else doc[k] = t; }
    if (!FONTES.includes(fontes[k])) erros.push(`${k}: fonte deve ser MANUAL ou ESTIMADO`); else saidaFontes[k] = fontes[k];
  }
  for (const [k, faixa] of Object.entries(MAPAS)) {
    const m = valores[k] === undefined ? {} : valores[k], f = fontesPorProduto[k] === undefined ? {} : fontesPorProduto[k];
    if (!objeto(m) || !objeto(f)) { erros.push(`${k}: formato inválido`); continue; }
    const ids = Object.keys(m);
    if (ids.length > MAX_PRODUTOS_MAPA) { erros.push(`${k}: no máximo ${MAX_PRODUTOS_MAPA} produtos`); continue; }
    if (Object.keys(f).some(id => !ids.includes(id))) erros.push(`${k}: fonte de produto sem valor`);
    for (const id of ids) {
      if (!RE_PRODUTO.test(id)) { erros.push(`${k}: produto inválido`); continue; }
      if (!inteiroEntre(m[id], faixa)) erros.push(`${k}[${id}]: inteiro entre ${faixa[0]} e ${faixa[1]}`);
      else if (!FONTES.includes(f[id])) erros.push(`${k}[${id}]: fonte deve ser MANUAL ou ESTIMADO`);
      else { doc[k][id] = m[id]; (saidaPorProduto[k] || (saidaPorProduto[k] = {}))[id] = f[id]; }
    }
    if (Object.keys(doc[k]).length) saidaFontes[k] = Object.values(saidaPorProduto[k]).every(x => x === 'ESTIMADO') ? 'ESTIMADO' : 'MANUAL';
  }
  if (doc.prazoMedioDias !== null && doc.prazoMaxDias !== null && doc.prazoMaxDias < doc.prazoMedioDias) erros.push('prazoMaxDias não pode ser menor que prazoMedioDias');
  return { erros, doc: erros.length ? null : { ...doc, fontes: saidaFontes, fontesPorProduto: saidaPorProduto } };
}

/** Lista as divergências entre o que veio marcado como ESTIMADO e a sugestão atual do servidor. */
function conferirEstimados(doc, estimativas) {
  const e = estimativas || { campos: {}, produtos: {} }, fora = [];
  for (const k of ESCALARES) if (doc.fontes[k] === 'ESTIMADO' && !(e.campos[k] && e.campos[k].valor === doc[k])) fora.push(k);
  for (const k of Object.keys(MAPAS)) for (const [id, f] of Object.entries(doc.fontesPorProduto[k] || {})) {
    if (f !== 'ESTIMADO') continue;
    const s = e.produtos[id] && e.produtos[id][k];
    if (!(s && s.valor === doc[k][id])) fora.push(`${k}[${id}]`);
  }
  return fora;
}

const mdc = (a, b) => (b ? mdc(b, a % b) : a);
const sug = (valor, amostra, base) => ({ valor, amostra, base });
const falta = (n, min, oque) => ({ valor: null, amostra: n, base: `dados insuficientes: ${n} de ${min} ${oque}` });

/**
 * Sugestões para UM fornecedor.
 * @param compras   base compacta (ou registros da API) — todas; o filtro por fornecedor é feito aqui
 * @param isoladas  Set de ids sem origem comprovada: ficam fora de qualquer estimativa
 * @param vencimentos Map compraId → datas de vencimento dos títulos vinculados (classificação de origem)
 */
function estimarParametros({ compras, fornecedorId, hoje, isoladas = new Set(), vencimentos = new Map(), nome = null, importadosConfigurados = [] }) {
  const R = REGRAS;
  const doFornecedor = (compras || []).map(w => (w && w.Compra) || w).filter(c => String(c.fornecedor_id || '') === String(fornecedorId));
  const confirmadas = doFornecedor.filter(c => situacaoCompra(c.nome_situacao) === 'CONFIRMADA' && parseData(c.data_emissao) && parseData(c.data_emissao) <= hoje);
  const validas = confirmadas.filter(c => !isoladas.has(String(c.id)));
  const cortePrazo = somarDias(hoje, -R.janela_prazo_dias), cortePed = somarDias(hoje, -R.janela_pedidos_dias);
  const campos = {};

  // ── prazo (PROXY: emissão → última alteração) ──
  const prazos = []; let mesmoDia = 0, longas = 0;
  for (const c of validas) {
    const e = parseData(c.data_emissao), m = parseData(c.modificado_em);
    if (!m || m > hoje || e < cortePrazo) continue;
    const d = diffDias(e, m);
    if (d === 0) mesmoDia++; else if (d > R.prazo_max_valido_dias) longas++; else if (d > 0) prazos.push(d);
  }
  const notaPrazo = `compras confirmadas dos últimos ${R.janela_prazo_dias} dias, da emissão à última alteração no ERP (aproximação: a API não informa a data de recebimento); fora: ${mesmoDia} lançada(s) no mesmo dia e ${longas} com mais de ${R.prazo_max_valido_dias} dias`;
  if (prazos.length >= R.min_amostras_prazo) {
    const p50 = quantil(prazos, 0.5), p90 = quantil(prazos, 0.9), disp = (p90 - p50) / Math.max(1, p50);
    campos.prazoMedioDias = sug(p50, prazos.length, `valor típico (mediana) de ${prazos.length} ${notaPrazo}`);
    campos.prazoMaxDias = sug(Math.max(...prazos), prazos.length, `maior prazo observado em ${prazos.length} ${notaPrazo}`);
    campos.confiabilidadePrazo = sug(disp <= R.confiabilidade_alta_ate ? 'ALTA' : disp <= R.confiabilidade_media_ate ? 'MEDIA' : 'BAIXA', prazos.length,
      `dispersão dos prazos: 9 em cada 10 chegam em até ${p90} d contra ${p50} d típicos (até ${R.confiabilidade_alta_ate * 100}% acima = alta; até ${R.confiabilidade_media_ate * 100}% = média; mais = baixa); mesma aproximação do prazo`);
  } else for (const k of ['prazoMedioDias', 'prazoMaxDias', 'confiabilidadePrazo']) campos[k] = falta(prazos.length, R.min_amostras_prazo, 'compras com prazo mensurável');

  // ── pedidos ──
  const pedidos = validas.filter(c => parseData(c.data_emissao) >= cortePed).map(c => ({ c, un: unidadesPorProduto(c) })).filter(x => x.un.size);
  const totais = pedidos.map(x => [...x.un.values()].reduce((s, q) => s + q, 0)).filter(q => q > 0);
  const janela = `compras confirmadas dos últimos ${R.janela_pedidos_dias / 365} anos`;
  campos.qtdMinima = totais.length >= R.min_compras ? sug(Math.max(1, Math.ceil(Math.min(...totais))), totais.length, `menor pedido observado em ${totais.length} ${janela} (o mínimo exigido pelo fornecedor pode ser menor)`) : falta(totais.length, R.min_compras, 'compras');
  const valores = pedidos.map(x => valorCompraCents(x.c)).filter(v => v > 0);
  campos.valorMinimoCents = valores.length >= R.min_compras ? sug(Math.min(...valores), valores.length, `menor valor de pedido observado em ${valores.length} ${janela} (o mínimo exigido pode ser menor)`) : falta(valores.length, R.min_compras, 'compras com valor');
  const linhas = pedidos.flatMap(x => [...x.un.values()]);
  if (linhas.length < R.min_linhas_multiplo || pedidos.length < R.min_compras_multiplo) campos.multiploPadrao = falta(linhas.length, R.min_linhas_multiplo, `itens comprados (em ${R.min_compras_multiplo}+ compras)`);
  else if (!linhas.every(Number.isInteger)) campos.multiploPadrao = sug(null, linhas.length, 'há quantidades fracionadas: não há múltiplo observável');
  else { const g = linhas.reduce(mdc); campos.multiploPadrao = g >= 2 ? sug(g, linhas.length, `todas as ${linhas.length} quantidades compradas em ${pedidos.length} ${janela} são múltiplas de ${g} (observado, não confirmado como embalagem)`) : sug(null, linhas.length, `as ${linhas.length} quantidades compradas não têm múltiplo comum maior que 1`); }
  const datas = [...new Set(pedidos.map(x => parseData(x.c.data_emissao)))].sort();
  if (datas.length >= R.min_datas_frequencia) { const iv = datas.slice(1).map((d, i) => diffDias(datas[i], d)); campos.frequenciaReposicaoDias = sug(Math.min(365, Math.max(1, quantil(iv, 0.5))), datas.length, `intervalo típico (mediana) entre ${datas.length} datas de compra nas ${janela}`); }
  else campos.frequenciaReposicaoDias = falta(datas.length, R.min_datas_frequencia, 'datas de compra distintas');

  // ── condições de pagamento: vencimentos dos títulos a pagar vinculados à compra ──
  const planos = validas.map(c => { const v = vencimentos.get(String(c.id)) || [], e = parseData(c.data_emissao); return e >= cortePed && v.length ? v.map(d => diffDias(e, d)).sort((a, b) => a - b) : null; }).filter(Boolean);
  if (planos.length >= R.min_compras_pagamento) {
    const conta = planos.reduce((m, p) => m.set(p.length, (m.get(p.length) || 0) + 1), new Map());
    const [parcelas, vezes] = [...conta].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const dos = planos.filter(p => p.length === parcelas);
    const dias = Array.from({ length: parcelas }, (_, i) => quantil(dos.map(p => p[i]), 0.5));
    campos.condicoesPagamento = sug(`${parcelas} parcela(s): vencimento típico em ${dias.join('/')} dias da emissão`.slice(0, TEXTOS.condicoesPagamento), planos.length,
      `padrão mais frequente (${vezes} de ${planos.length} compras com títulos a pagar vinculados)`);
  } else campos.condicoesPagamento = falta(planos.length, R.min_compras_pagamento, 'compras com títulos vinculados');

  // ── nacional/importado: só há sugestão com indício; a ausência de indício NÃO vira "nacional" ──
  if (importadosConfigurados.includes(String(fornecedorId))) campos.origem = sug('IMPORTADO', 1, 'fornecedor marcado como importado na configuração da política');
  else if (nome && RE_NOME_IMPORTADO.test(nome)) campos.origem = sug('IMPORTADO', 1, 'indício pelo NOME do fornecedor (a API não informa importação): confira');
  else campos.origem = sug(null, 0, 'o ERP não informa se é importado: informe manualmente');

  // ── por produto ──
  const porProduto = new Map();
  for (const x of pedidos) for (const [id, q] of x.un) (porProduto.get(id) || porProduto.set(id, []).get(id)).push(q);
  const produtos = {};
  for (const [id, l] of porProduto) {
    const p = { compras: l.length, menor: Math.min(...l), maior: Math.max(...l) };
    if (l.length >= R.min_compras_produto) {
      p.qtdMinimaPorProduto = sug(Math.max(1, Math.ceil(p.menor)), l.length, `menor quantidade em ${l.length} compras`);
      if (l.every(Number.isInteger)) { const g = l.reduce(mdc); if (g >= 2) p.multiplosPorProduto = sug(g, l.length, `as ${l.length} quantidades são múltiplas de ${g}`); }
    }
    produtos[id] = p;
  }
  return { fornecedorId: String(fornecedorId), campos, produtos,
    base: { compras_confirmadas: confirmadas.length, usadas: validas.length, excluidas_sem_origem: confirmadas.length - validas.length, na_janela: pedidos.length } };
}

module.exports = { ORIGENS, CONFIABILIDADES, FONTES, ESCALARES, INTEIROS, ENUMS, TEXTOS, MAPAS, MAX_PRODUTOS_MAPA, REGRAS, validarParametros, conferirEstimados, estimarParametros };
