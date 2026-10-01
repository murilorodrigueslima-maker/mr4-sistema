'use strict';
// AGENTE FINANCEIRO IA — motor de CONTEXTO (determinístico). NÃO recalcula o Financeiro: lê a geração ativa que o motor da Fase 2 já publicou
// (fin_n1/active → fin_n1_resumo/<geração>__resumo e __entidades) e apenas SELECIONA candidatos e converte centavos em reais.
// Privacidade: só agregados + refs opacas (G001 pagar, G002 receber, F001… fornecedores, C001… clientes). Sem nome, documento, descrição, forma
// de pagamento por título, plano de contas, conta bancária, observações. Funcionários e "outros" nunca viram entidade (folha é dado pessoal).
const K = require('../../../financeiro/canonico');
const A = require('../../../financeiro/agregados');

const COL = { ptr: 'fin_n1', resumo: 'fin_n1_resumo' };
const STALE_HORAS = 6;                                       // mesma régua do painel (financeiro/entrypoints AGENDA.STALE_HORAS = 2 ciclos de 3 h; igualdade garantida por teste)
const CONCENTRACAO_PCT = 25;                                 // um único fornecedor/cliente com ≥25% do aberto
const BASE_ENTIDADES = 8;                                    // candidatos por lado na escala 1
const FAIXAS_ANTIGAS = ['D61_A_90', 'D91_A_180', 'D181_A_365', 'ACIMA_365'];
const TIPOS_PAGAR = ['FORNECEDOR', 'TRANSPORTADORA'];       // folha (FUNCIONARIO) e OUTROS ficam só nos agregados
const TIPOS_RECEBER = ['CLIENTE'];

const reais = c => Math.round(Number(c || 0)) / 100;
const pct = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : 0);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Lê a geração ativa (somente leitura; mesmo caminho do painel). */
async function carregarFinanceiro(store) {
  const ativoS = await store.collection(COL.ptr).doc('active').get(); const ativo = ativoS.exists ? ativoS.data() : null;
  if (!ativo || !ativo.resumo_id) return { ativo: null, meta: null, resumo: null, entidades: null };
  const metaS = await store.collection(COL.ptr).doc('meta').get(); const meta = metaS.exists ? metaS.data() : null;
  const r = await store.collection(COL.resumo).doc(ativo.resumo_id).get(); const resumo = r.exists ? r.data() : null;
  const e = ativo.entidades_id ? await store.collection(COL.resumo).doc(ativo.entidades_id).get() : null; const entidades = e && e.exists ? e.data() : null;
  return { ativo, meta, resumo, entidades };
}

/** Frescor: sourceUpdatedAt = publicação real da geração; desatualizado = idade > 6 h OU geração de outro dia comercial (os "hoje" mudariam). */
function frescor(ativo, resumo, agoraIso) {
  const pub = ativo && ativo.publicado_em ? ativo.publicado_em : null;
  const idadeMin = pub ? Math.round((new Date(agoraIso).getTime() - new Date(pub).getTime()) / 60000) : null;
  const hojeAgora = K.dataComercial(new Date(agoraIso));
  const dataGeracao = resumo ? resumo.data_comercial : null;
  const diaDiverge = !!dataGeracao && dataGeracao !== hojeAgora;
  const velho = idadeMin == null || !Number.isFinite(idadeMin) || idadeMin > STALE_HORAS * 60;
  return { sourceUpdatedAt: pub, idadeMin, dataComercialGeracao: dataGeracao, dataComercialAgora: hojeAgora, diaDiverge, desatualizado: velho || diaDiverge };
}

/** Sinais da PERGUNTA (determinístico): o que foi pedido e este agente NÃO tem. A resposta precisa declarar "indisponível". */
function pedidosIndisponiveis(pergunta) {
  const q = norm(pergunta), out = [];
  if (/saldo|\bbanco\b|bancari|\bcaixa\b|dinheiro|capacidade de (compra|pagamento)|poder de compra|\bsobra|sobrar|\bfolga|liquidez|quanto (posso|consigo|da pra|dá pra) (comprar|gastar|investir|pagar)|extrato|conta corrente|\bpix\b/.test(q)) out.push('SALDO_CAIXA_CAPACIDADE');
  if (/periodo anterior|semana passada|mes passado|mes anterior|semana anterior|\bmudou|comparad|comparac|\bversus\b|\bvs\b|em relacao a|evolu[cç]ao|variou|variacao/.test(q)) out.push('COMPARACAO_PERIODO_ANTERIOR');
  if (/cnpj|\bcpf\b|telefone|e-?mail|endereco|chave pix|numero da conta|agencia|documento|observac|descricao do titulo/.test(q)) out.push('DADO_PESSOAL_OU_BANCARIO');
  return out;
}

function agregado(P, prefixo) {   // fatos de uma natureza (já calculados pelo motor da Fase 2) → métricas em reais
  const e = P.envelhecimento || {}; const antigo = FAIXAS_ANTIGAS.reduce((a, k) => { const x = e[k] || { n: 0, c: 0 }; return { n: a.n + x.n, c: a.c + x.c }; }, { n: 0, c: 0 });
  return {
    [prefixo + '_open']: reais(P.abertos.c), [prefixo + '_open_count']: P.abertos.n,
    [prefixo + '_today']: reais(P.hoje.c), [prefixo + '_today_count']: P.hoje.n,
    [prefixo + '_7d']: reais(P.prox_7d.c), [prefixo + '_7d_count']: P.prox_7d.n,
    [prefixo + '_30d']: reais(P.prox_30d.c), [prefixo + '_30d_count']: P.prox_30d.n,
    [prefixo + '_overdue']: reais(P.vencido.c), [prefixo + '_overdue_count']: P.vencido.n,
    [prefixo + '_overdue_over_60d']: reais(antigo.c), [prefixo + '_overdue_over_60d_count']: antigo.n,
    [prefixo + '_overdue_share_of_open_pct']: pct(P.vencido.c, P.abertos.c),
    needs_review_count: P.requer_conferencia ? P.requer_conferencia.n : 0,
  };
}
function sinaisAgregado(a, P, prefixo, fluxo) {
  const s = [];
  if (a[prefixo + '_today_count'] > 0) s.push('VENCE_HOJE');
  if (a[prefixo + '_overdue_count'] > 0) s.push('VENCIDO');
  if (a[prefixo + '_7d_count'] > 0) s.push('VENCE_7D');
  if (a[prefixo + '_30d_count'] > 0) s.push('VENCE_30D');
  if (a[prefixo + '_overdue_over_60d_count'] > 0) s.push('VENCIDO_ANTIGO');
  if (a.needs_review_count > 0) s.push('REQUER_CONFERENCIA');
  if (prefixo === 'payables') { if (fluxo.d7.liquido_c < 0) s.push('FLUXO_PROGRAMADO_NEGATIVO_7D'); if (fluxo.d30.liquido_c < 0) s.push('FLUXO_PROGRAMADO_NEGATIVO_30D'); }
  return s;
}

function candidatos(lista, tipos, totalAbertoC, k) {
  const ok = (lista || []).filter(x => tipos.includes(x.tipo) && x.chave && !String(x.chave).startsWith('SEM_ENTIDADE') && x.aberto && x.aberto.c > 0);
  const porAberto = [...ok].sort((a, b) => b.aberto.c - a.aberto.c || String(a.chave).localeCompare(String(b.chave))).slice(0, k);
  const porVencido = [...ok].filter(x => x.vencido && x.vencido.c > 0).sort((a, b) => b.vencido.c - a.vencido.c || String(a.chave).localeCompare(String(b.chave))).slice(0, k);
  const uni = {}; for (const x of [...porAberto, ...porVencido]) uni[x.chave] = x;
  return Object.values(uni).sort((a, b) => b.aberto.c - a.aberto.c || String(a.chave).localeCompare(String(b.chave)));
}
function fatosEntidade(x, totalAbertoC) {
  const faixas = Object.entries(x.envelhecimento || {}).filter(([, v]) => v && v.n > 0).map(([k]) => k);
  const ORDEM = ['D1_A_7', 'D8_A_15', 'D16_A_30', 'D31_A_60', 'D61_A_90', 'D91_A_180', 'D181_A_365', 'ACIMA_365'];
  const maisAntiga = ORDEM.filter(k => faixas.includes(k)).pop() || null;
  const f = { open_value: reais(x.aberto.c), open_count: x.aberto.n, open_share_pct: pct(x.aberto.c, totalAbertoC), overdue_value: reais(x.vencido.c), overdue_count: x.vencido.n,
    due_7d_value: reais(x.prox_7d.c), due_30d_value: reais(x.prox_30d.c), oldest_overdue_band: maisAntiga };
  const s = [];
  if (f.overdue_count > 0) s.push('VENCIDO'); if (x.prox_7d.n > 0) s.push('VENCE_7D'); if (x.prox_30d.n > 0) s.push('VENCE_30D');
  if (f.open_share_pct >= CONCENTRACAO_PCT) s.push('CONCENTRACAO_ALTA');
  if (faixas.some(k => FAIXAS_ANTIGAS.includes(k))) s.push('VENCIDO_ANTIGO');
  return { ...f, sinais: s };
}

/**
 * @returns {contexto, mapa, resumo, fallback, bytes, frescor, perguntaSegura, vazio}
 * Contagens/totais SEMPRE da base inteira (resumo da geração); só a lista de entidades é reduzida pela escala.
 */
function montarComEscala(dados, escala, pergunta, agoraIso) {
  const { ativo, resumo: R, entidades: E } = dados;
  const fr = frescor(ativo, R, agoraIso);
  const valida = !!(ativo && R && R.geracao === ativo.geracao && R.pagar && R.receber && R.fluxo_programado);
  if (!valida) return { contexto: { escopo: 'FINANCEIRO_TITULOS', entidades: {}, limitacoes: ['Sem geração financeira válida.'] }, mapa: {}, resumo: null, fallback: [], bytes: 2, frescor: fr, perguntaSegura: pergunta, vazio: true };
  const k = Math.max(1, Math.ceil(BASE_ENTIDADES * escala));
  const aP = agregado(R.pagar, 'payables'), aR = agregado(R.receber, 'receivables');
  const fluxo = { d7: R.fluxo_programado.d7, d30: R.fluxo_programado.d30 };
  const entidades = {}, mapa = {};
  entidades.G001 = { ...aP, programmed_net_7d: reais(fluxo.d7.liquido_c), programmed_net_30d: reais(fluxo.d30.liquido_c), sinais: sinaisAgregado(aP, R.pagar, 'payables', fluxo) };
  entidades.G002 = { ...aR, sinais: sinaisAgregado(aR, R.receber, 'receivables', fluxo) };
  mapa.G001 = { id: 'AGG:PAGAR', nome: 'Contas a pagar (total)', tipo: 'AGREGADO' }; mapa.G002 = { id: 'AGG:RECEBER', nome: 'Contas a receber (total)', tipo: 'AGREGADO' };
  const lado = (lista, tipos, total, letra, tipoRotulo) => candidatos(lista, tipos, total, k).forEach((x, i) => { const ref = letra + String(i + 1).padStart(3, '0'); entidades[ref] = fatosEntidade(x, total); mapa[ref] = { id: x.chave, nome: x.nome || (tipoRotulo + ' ' + ref), tipo: tipoRotulo }; });
  lado(E && E.pagar, TIPOS_PAGAR, R.pagar.abertos.c, 'F', 'Fornecedor');
  lado(E && E.receber, TIPOS_RECEBER, R.receber.abertos.c, 'C', 'Cliente');
  const indisponivel = ['SALDO_BANCARIO', 'CAIXA_DISPONIVEL', 'CAPACIDADE_DE_COMPRA', 'COMPARACAO_COM_PERIODO_ANTERIOR', 'VALOR_PAGO_PARCIAL_OU_SALDO_RESTANTE_POR_TITULO'];
  const contexto = {
    escopo: 'FINANCEIRO_TITULOS_AGREGADOS',
    dataReferencia: R.data_comercial, fuso: R.fuso || 'America/Fortaleza', geracaoPublicadaEm: ativo.publicado_em, geracaoDeOutroDia: fr.diaDiverge,
    janelas: 'hoje = vencimento na data de referência; 7d e 30d = vencimento de hoje até +7 / +30 dias (inclui hoje, exclui vencidos); vencido = vencimento anterior à data de referência',
    parametros: { janelaCurtaDias: 7, janelaLongaDias: 30, vencidoAntigoDias: 60, concentracaoMinimaPct: CONCENTRACAO_PCT },
    totais: { titulosPagar: R.pagar.total_titulos, titulosReceber: R.receber.total_titulos, requerConferenciaPagar: aP.needs_review_count, requerConferenciaReceber: aR.needs_review_count },
    disponibilidade: { saldoBancario: 'INDISPONIVEL', caixaDisponivel: 'INDISPONIVEL', capacidadeDeCompra: 'INDISPONIVEL', comparacaoPeriodoAnterior: 'INDISPONIVEL' },
    entidades,
    limitacoes: [
      'Não há saldo bancário integrado: nunca informe saldo, caixa, capacidade de compra ou sobra.',
      'Valores são de títulos programados no ERP (cada título integral), não extrato bancário.',
      'Fluxo programado é recebimentos programados menos pagamentos programados no período; não é saldo nem caixa.',
      'Título vencido é fato aritmético, não classificação de cliente ou fornecedor.',
      'Não há comparação com período anterior.',
    ],
    pedidoNaoAtendivel: pedidosIndisponiveis(pergunta),
    indisponivel,
  };
  const bytes = Buffer.byteLength(JSON.stringify(contexto));
  const resumoUi = { pagar_hoje: aP.payables_today, receber_hoje: aR.receivables_today, pagar_7d: aP.payables_7d, receber_7d: aR.receivables_7d, pagar_30d: aP.payables_30d, receber_30d: aR.receivables_30d, pagar_vencido: aP.payables_overdue, receber_vencido: aR.receivables_overdue,
    dataReferencia: R.data_comercial, alertas: [...new Set([...entidades.G001.sinais, ...entidades.G002.sinais, ...Object.entries(entidades).filter(([r]) => /^[FC]/.test(r)).flatMap(([, v]) => v.sinais)].filter(s => ['VENCIDO', 'VENCIDO_ANTIGO', 'REQUER_CONFERENCIA', 'FLUXO_PROGRAMADO_NEGATIVO_7D', 'CONCENTRACAO_ALTA'].includes(s)))] };
  return { contexto, mapa, resumo: resumoUi, fallback: Object.keys(entidades).slice(0, 2 + Math.min(3, Object.keys(entidades).length - 2)).map(ref => ({ ref, fallback: true })), bytes, frescor: fr, perguntaSegura: pergunta };
}

const CAMPOS_ENTIDADE = new Set(['sinais', 'open_value', 'open_count', 'open_share_pct', 'overdue_value', 'overdue_count', 'due_7d_value', 'due_30d_value', 'oldest_overdue_band', 'needs_review_count', 'programmed_net_7d', 'programmed_net_30d',
  ...['payables', 'receivables'].flatMap(p => ['open', 'open_count', 'today', 'today_count', '7d', '7d_count', '30d', '30d_count', 'overdue', 'overdue_count', 'overdue_over_60d', 'overdue_over_60d_count', 'overdue_share_of_open_pct'].map(s => p + '_' + s))]);
const CAMPOS_TOPO = new Set(['escopo', 'dataReferencia', 'fuso', 'geracaoPublicadaEm', 'geracaoDeOutroDia', 'janelas', 'parametros', 'totais', 'disponibilidade', 'entidades', 'limitacoes', 'pedidoNaoAtendivel', 'indisponivel']);
/** Auditoria de allowlist: só campos conhecidos; nenhum padrão de PII (CPF/CNPJ/telefone/e-mail/CEP/ids); refs opacas. */
function auditar(ctx) {
  const problemas = [];
  for (const k of Object.keys(ctx)) if (!CAMPOS_TOPO.has(k)) problemas.push('TOPO_FORA:' + k);
  for (const [ref, e] of Object.entries(ctx.entidades || {})) {
    if (!/^(G00[12]|[FC]\d{3})$/.test(ref)) problemas.push('REF_INVALIDA:' + ref);
    for (const k of Object.keys(e)) if (!CAMPOS_ENTIDADE.has(k)) problemas.push('ENTIDADE_CAMPO_FORA:' + k);
  }
  const textos = []; (function w(o) { if (typeof o === 'string') textos.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(w); })(ctx);   // só strings: números do motor não são texto livre
  if (/[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b|\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b|\b\d{5}-?\d{3}\b/.test(textos.join('\n').replace(/\b20\d\d-\d\d-\d\d\b/g, 'DATA'))) problemas.push('PII_PADRAO');
  return { ok: problemas.length === 0, problemas };
}

module.exports = { COL, STALE_HORAS, CONCENTRACAO_PCT, BASE_ENTIDADES, TIPOS_PAGAR, TIPOS_RECEBER, carregarFinanceiro, frescor, pedidosIndisponiveis, montarComEscala, auditar, METRICAS_BLOQUEADAS: A.METRICAS_BLOQUEADAS };
