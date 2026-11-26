'use strict';
// INVESTIGAÇÃO de compras no GestãoClick — SOMENTE LEITURA (ponto de entrada: scripts/investigar-compras.js).
//
// Garantias:
//   • só GET pela camada gcHttp, com loja_id=262759 em toda chamada; orçamento máximo de requisições; pausa entre chamadas;
//   • nenhum acesso ao Firestore; nenhuma escrita em lugar algum;
//   • saída "INVC_<SEÇÃO> {json}" com IDs, códigos, datas, quantidades e valores. Sem nomes (fornecedor/cliente/usuário),
//     documentos, telefones, textos de observação, credenciais ou corpo de resposta;
//   • registro que declare outra loja aborta a seção (nada dele é impresso).
const gcHttp = require('./gcHttp');
const { criarLeitorGc, codigoSeguro } = require('./estoqueReconciliacao');
const C = require('./compras/canonico');
const Conf = require('./compras/confiabilidade');
const { mapearTitulo } = require('./financeiro/canonico');

const LOJA = gcHttp.LOJA_ATIVA_ID;
const NOME_LOJA = 'MR4 DISTRIBUIDORA';
const PADRAO = Object.freeze({ maxRequisicoes: 160, pausaMs: 600, diasVendas: 35, anoInicialTitulos: 2022, vendas: ['415281034', '415209360'], produtos: ['47142037', '47142039'] });
const FAIXAS = Object.freeze({ maxRequisicoes: [10, 250], pausaMs: [300, 5000], diasVendas: [1, 90], anoInicialTitulos: [2015, 2026] });
const NOMES = Object.freeze({ 'max-requisicoes': 'maxRequisicoes', 'pausa-ms': 'pausaMs', 'dias-vendas': 'diasVendas', 'ano-inicial-titulos': 'anoInicialTitulos' });
const LISTAS = Object.freeze({ vendas: 'vendas', produtos: 'produtos' });
const POR_LINHA = 20;

const erro = codigo => Object.assign(new Error(codigo), { codigo });
function lerOpcoes(argv = []) {
  const o = { ...PADRAO };
  for (const a of argv) {
    const l = /^--(vendas|produtos)=(\d{1,12}(?:\+\d{1,12}){0,9})$/.exec(a);      // separados por "+": a vírgula é do gcloud --args
    if (l) { o[LISTAS[l[1]]] = l[2].split('+'); continue; }
    const m = /^--([a-z-]+)=(\d+)$/.exec(a), chave = m && NOMES[m[1]];
    if (!chave) throw erro('ARGUMENTO_INVALIDO');
    const v = Number(m[2]), [min, max] = FAIXAS[chave];
    if (v < min || v > max) throw erro('ARGUMENTO_FORA_DA_FAIXA');
    o[chave] = v;
  }
  return o;
}

const nomeNormalizado = s => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
/** 'REGISTRO' = o próprio registro declara a loja ativa; 'FILTRO' = sem campo de loja. Outra loja → aborta. */
function lojaDoRegistro(r) {
  const id = r && r.loja_id !== undefined && r.loja_id !== null ? String(r.loja_id) : '';
  const nome = nomeNormalizado(r && r.nome_loja);
  if (id && id !== LOJA) throw erro('GC_LOJA_DIVERGENTE');
  if (nome && nome !== NOME_LOJA) throw erro('GC_LOJA_DIVERGENTE');
  return id || nome ? 'REGISTRO' : 'FILTRO';
}
const txt = (v, n = 40) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));
const id = v => (/^\d{1,15}$/.test(String(v === undefined || v === null ? '' : v)) ? String(v) : null);
const dataHora = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v) ? v : null);
const desembrulharItem = (x, k) => (x && x[k]) || x || {};
const contar = (l, f) => l.reduce((o, x) => { const k = String(f(x)).slice(0, 40); o[k] = (o[k] || 0) + 1; return o; }, {});

/** Histórico de situações e parcelas da compra: só campos de data, situação e valor (lista branca). */
function historicoSituacoes(c) {
  const l = Array.isArray(c.situacoes) ? c.situacoes.map(x => desembrulharItem(x, 'situacao')) : [];
  return { campos: [...new Set(l.flatMap(x => Object.keys(x)))].map(k => k.slice(0, 40)).sort(),
    itens: l.slice(0, 20).map(x => ({ situacao_id: id(x.situacao_id || x.id), nome: txt(x.nome_situacao || x.situacao_nome), data: dataHora(x.data) || dataHora(x.data_hora) || dataHora(x.cadastrado_em) || dataHora(x.modificado_em) })) };
}
const parcelas = c => (Array.isArray(c.pagamentos) ? c.pagamentos : []).slice(0, 36).map(x => desembrulharItem(x, 'pagamento')).map(x => ({ vencimento: dataHora(x.data_vencimento), valor: txt(x.valor) }));
const PALAVRAS = Object.freeze({ recebimento: /receb|cheg|entreg/i, parcial: /parcial|falt/i, cancelamento: /cancel|devol|estorn/i, duplicidade: /duplic|repetid/i });
const mencoes = c => Object.fromEntries(Object.entries(PALAVRAS).map(([k, re]) => [k, re.test(String(c.observacoes || '') + ' ' + String(c.observacoes_interna || ''))]));

function resumoVenda(v, alvo, grupos) {
  const itens = (v.produtos || []).map((p, i) => ({ linha: i, ...desembrulharItem(p, 'produto') }));
  const ids = itens.map(i => String(i.produto_id || '') + '|' + String(i.variacao_id || '')).filter(x => x !== '|');
  const cli = String(v.cliente_id || '');
  if (cli && !grupos.has(cli)) grupos.set(cli, 'C' + (grupos.size + 1));      // rótulo local: mostra "mesmo cliente?" sem expor ID
  return { id: id(v.id), codigo: txt(v.codigo, 20), data: C.parseData(v.data), situacao: txt(v.nome_situacao), situacao_estoque: txt(v.situacao_estoque, 3), cadastrado_em: dataHora(v.cadastrado_em), modificado_em: dataHora(v.modificado_em),
    cliente: grupos.get(cli) || null, valor_total: txt(v.valor_total, 20), itens_total: itens.length, produto_repetido_na_venda: new Set(ids).size !== ids.length,
    itens_alvo: itens.filter(i => alvo.has(String(i.produto_id))).map(i => ({ linha: i.linha, produto_id: id(i.produto_id), variacao_id: id(i.variacao_id), quantidade: txt(i.quantidade, 20), valor_venda: txt(i.valor_venda, 20), valor_total: txt(i.valor_total, 20), movimenta_estoque: txt(i.movimenta_estoque, 3) })) };
}

async function executarInvestigacao({ transporte, credenciais, agora = new Date(), opcoes = {}, saida, dormir, ambiente = {} }) {
  const o = { ...PADRAO, ...opcoes };
  const emitir = (tag, dados) => saida(`INVC_${tag} ${JSON.stringify(dados)}`);
  const lista = (tag, itens) => { const n = Math.ceil(itens.length / POR_LINHA); for (let i = 0; i < n; i++) emitir(tag, { parte: i + 1, de: n, total: itens.length, itens: itens.slice(i * POR_LINHA, (i + 1) * POR_LINHA) }); };
  const erros = [];
  let gc = null;
  const fim = extra => {
    const uso = gc ? gc.uso : { usadas: 0, por_recurso: {}, esgotado: false }, est = gc ? gc.estatisticas() : { retries: 0, r429: 0 };
    emitir('ORCAMENTO', { maximo: o.maxRequisicoes, usadas: uso.usadas, por_recurso: uso.por_recurso, repeticoes: est.retries, respostas_429: est.r429, esgotado: uso.esgotado, leituras_firestore: 0, escritas_firestore: 0, escritas_gc: 0 });
    const r = { ok: erros.length === 0 && !extra, secoes_com_erro: erros, ...(extra || {}) };
    emitir('FIM', r); return r;
  };
  const hoje = C.dataComercial(agora);
  emitir('INICIO', { loja: LOJA, instante: agora.toISOString(), hoje, opcoes: o, aviso: 'SOMENTE LEITURA. A API não informa data de recebimento.' });
  if (Number(ambiente.CLOUD_RUN_TASK_ATTEMPT || 0) > 0) return fim({ abortado: 'REEXECUCAO_AUTOMATICA_DO_JOB' });
  gc = criarLeitorGc({ transporte, credenciais, maxRequisicoes: o.maxRequisicoes, pausaMs: o.pausaMs, dormir });
  const secao = async (nome, f) => { try { return await f(); } catch (e) { erros.push({ secao: nome, codigo: codigoSeguro(e) }); emitir('ERRO', { secao: nome, codigo: codigoSeguro(e) }); return null; } };

  // 1) Compras (todas)
  const compras = await secao('compras', async () => (await gc.lista('/compras', { data_inicio: '2000-01-01', data_fim: '2099-12-31' }, { desembrulhar: x => x.Compra || x })).itens);
  if (!compras) return fim({ abortado: 'SEM_COMPRAS' });
  const itens = compras.flatMap(c => (c.produtos || []).map(p => desembrulharItem(p, 'produto')));
  const estoqueIds = itens.map(i => String(i.estoque_id || '')).filter(Boolean);
  const codigos = contar(compras.filter(c => c.codigo), c => c.codigo);
  await secao('compras_resumo', async () => emitir('COMPRAS_RESUMO', { total: compras.length, com_campo_de_loja: compras.filter(c => lojaDoRegistro(c) === 'REGISTRO').length, sem_codigo: compras.filter(c => !c.codigo).length,
    codigos_repetidos: Object.values(codigos).filter(n => n > 1).length, situacoes: contar(compras, c => c.nome_situacao), itens: itens.length, itens_com_estoque_id: estoqueIds.length, estoque_ids_distintos: new Set(estoqueIds).size }));

  // 2) Pendentes: detalhe, histórico de situações e parcelas
  for (const c of compras.filter(x => C.situacaoCompra(x.nome_situacao) === 'PENDENTE').slice(0, 20)) {
    await secao('pendente_' + id(c.id), async () => {
      let d = c, detalhe = 'OK';
      try { const j = (await gc.get('/compras/' + encodeURIComponent(c.id), {}, { tipo: 'detalhe' })).data; d = j.Compra || j; } catch (e) { detalhe = codigoSeguro(e); d = c; }
      const loja = lojaDoRegistro(d);
      emitir('PENDENTE', { id: id(c.id), codigo: txt(d.codigo, 20), data_emissao: C.parseData(d.data_emissao), situacao: txt(d.nome_situacao), fornecedor_id: id(d.fornecedor_id), cadastrado_em: dataHora(d.cadastrado_em), modificado_em: dataHora(d.modificado_em),
        valor_total: txt(d.valor_total, 20), tem_nfe: !!d.numero_nfe, loja, detalhe, historico: historicoSituacoes(d), parcelas: parcelas(d), observacao_menciona: mencoes(d) });
    });
  }

  // 3) Vendas dos produtos investigados e das vendas indicadas
  const alvo = new Set(o.produtos), grupos = new Map();
  await secao('vendas', async () => {
    const inicio = C.somarDias(hoje, -o.diasVendas);
    const vendas = (await gc.lista('/vendas', { data_inicio: inicio, data_fim: hoje }, { permitirVazio: true, desembrulhar: x => x.Venda || x })).itens;
    const lojas = vendas.map(lojaDoRegistro);
    const comAlvo = vendas.filter(v => (v.produtos || []).some(p => alvo.has(String(desembrulharItem(p, 'produto').produto_id))));
    emitir('VENDAS_RESUMO', { periodo: { inicio, fim: hoje }, total: vendas.length, loja_confirmada_no_registro: lojas.filter(x => x === 'REGISTRO').length, com_produtos_alvo: comAlvo.length, alvo_presente: Object.fromEntries(o.vendas.map(i => [i, vendas.some(v => String(v.id) === i)])) });
    lista('VENDAS_PRODUTOS', comAlvo.map(v => resumoVenda(v, alvo, grupos)).sort((a, b) => String(a.data).localeCompare(String(b.data)) || String(a.id).localeCompare(String(b.id))));
  });
  for (const vid of o.vendas) {
    try {
      const j = (await gc.get('/vendas/' + vid, {}, { tipo: 'detalhe' })).data, v = j.Venda || j;
      lojaDoRegistro(v);
      emitir('VENDA_DETALHE', { id: vid, encontrada: String(v.id) === vid, venda: String(v.id) === vid ? resumoVenda(v, alvo, grupos) : null });
    } catch (e) { emitir('VENDA_DETALHE', { id: vid, encontrada: false, codigo: codigoSeguro(e) }); }
  }

  // 4) Títulos a pagar da loja ativa → prova de origem
  await secao('titulos', async () => {
    const anos = []; for (let a = o.anoInicialTitulos; a <= Number(hoje.slice(0, 4)) + 2; a++) anos.push([`${a}-01-01`, `${a}-12-31`]);
    anos.push([`${Number(hoje.slice(0, 4)) + 3}-01-01`, '2099-12-31']);
    const porId = new Map();
    for (const [ini, f] of anos) for (const t of (await gc.lista('/pagamentos', { data_inicio: ini, data_fim: f }, { permitirVazio: true })).itens) porId.set(String(t.id), t);
    const amplo = await gc.get('/pagamentos', { data_inicio: `${o.anoInicialTitulos}-01-01`, data_fim: '2099-12-31', pagina: 1, limite: 1 });
    const totalAmplo = Number((amplo.meta || {}).total_registros || 0);
    const loja = new Map([...porId].map(([k, t]) => [k, lojaDoRegistro(t)]));
    const canon = [...porId.values()].map(t => mapearTitulo(t, 'PAGAR'));
    const { porCompra, estados } = Conf.vincularTitulosACompras(compras, canon, k => loja.get(String(k)));
    const completo = totalAmplo === porId.size;
    emitir('TITULOS_RESUMO', { janelas: anos.length, titulos: porId.size, total_consulta_ampla: totalAmplo, completo, loja_confirmada_no_registro: [...loja.values()].filter(x => x === 'REGISTRO').length, so_pelo_filtro: [...loja.values()].filter(x => x === 'FILTRO').length,
      referencia_a_compra: estados, compras_com_titulo: [...porCompra.values()].filter(x => x.titulos > 0).length });
    // colunas: id, codigo, fornecedor_id, titulos, soma_cents, pagos, soma_paga_cents, titulos_com_loja_no_registro, conflitos
    lista('ORIGEM', compras.map(c => { const x = porCompra.get(String(c.id)) || { titulos: 0, soma_cents: 0, pagos: 0, soma_paga_cents: 0, loja_no_registro: 0, conflitos: 0 }; return [id(c.id), txt(c.codigo, 20), id(c.fornecedor_id), x.titulos, x.soma_cents, x.pagos, x.soma_paga_cents, x.loja_no_registro, x.conflitos]; }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (!completo) throw erro('TITULOS_JANELAS_NAO_FECHAM');
  });
  return fim();
}

module.exports = { PADRAO, NOME_LOJA, lerOpcoes, lojaDoRegistro, historicoSituacoes, resumoVenda, executarInvestigacao };
