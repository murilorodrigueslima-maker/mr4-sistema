'use strict';
// AGENTE FINANCEIRO MR4 — Fase 2 · Construção de uma GERAÇÃO (agregados + detalhes protegidos). Função pura e determinística.
//
// Saídas (todas só em Firestore protegido; nada público):
//   resumo     1 documento pequeno (< 100 KB): cards, janelas, envelhecimento, formas, planos, fluxo programado, vínculos, qualidade.
//   entidades  1 documento: agregado por fornecedor (pagar) e por cliente (receber) — carregado sob demanda.
//   fatias     detalhes em fatias de ≤ 250 títulos, id determinístico <geracao>__<NATUREZA>__<GRUPO>__<nnn>; o navegador lê UMA fatia por vez.
// Grupos de detalhe: VENCIDO · HOJE · FUTURO · UNKNOWN (requer conferência) · PAGO (só os últimos RETENCAO_PAGOS_DIAS dias de baixa).
// Política de retenção: títulos ABERTOS e UNKNOWN são mantidos sem limite de idade (>365 dias continua contabilizado e visível);
// pagos: detalhe dos últimos 365 dias; os totais históricos de pagos ficam no resumo.
//
// NÃO calcula nem expõe: saldo bancário, caixa disponível, capacidade de compra, projeção de caixa, % de inadimplência, score.
const { diffDias } = require('./canonico');
const M = require('./motor');

const VERSAO = 'fin-n1-2';
const TAM_FATIA = 250;
const RETENCAO_PAGOS_DIAS = 365;
const JANELAS_DIAS = { PROX_3D: 3, PROX_7D: 7, PROX_15D: 15, PROX_30D: 30 };
const GRUPOS = ['VENCIDO', 'HOJE', 'FUTURO', 'UNKNOWN', 'PAGO'];
const METRICAS_BLOQUEADAS = ['SALDO_DISPONIVEL', 'SALDO_BANCARIO', 'CAIXA_REAL', 'CAIXA_PARA_COMPRAS', 'CAPACIDADE_DE_COMPRA', 'RUNWAY', 'FREE_CASH', 'PROJECAO_DE_CAIXA'];

const MOTIVO_TEXTO = {
  ABERTO_COM_DATA_LIQUIDACAO: 'Status aberto, mas existe data de liquidação',
  DATA_LIQUIDACAO_FUTURA: 'Baixa registrada com data futura',
  LIQUIDADO_SEM_DATA: 'Marcado como liquidado, mas sem data de liquidação',
  DATA_LIQUIDACAO_INVALIDA: 'Data de liquidação inválida',
  VENCIMENTO_INVALIDO: 'Data de vencimento inválida',
  SEM_VENCIMENTO: 'Sem data de vencimento',
  VALOR_FINAL_INVALIDO: 'Valor inválido',
  VALOR_FINAL_NEGATIVO: 'Valor negativo',
  FLAG_LIQUIDADO_INVALIDA: 'Situação de liquidação inválida',
  SEM_ID: 'Título sem identificador',
};

const ag = () => ({ n: 0, c: 0 });                    // n = quantidade, c = centavos
const add = (a, t) => { a.n++; a.c += t.final_amount_cents; };

/** Rótulo factual da forma de pagamento (nada além do que a fonte permite afirmar). */
const FORMA_ROTULO = { PIX: 'PIX', BOLETO: 'Boleto', AMBIGUOUS: 'Boleto Inter/Pix', CARTAO_CREDITO: 'Cartão', CARTAO_DEBITO: 'Cartão', DINHEIRO: 'Dinheiro', TRANSFERENCIA: 'Transferência', CREDITO_CLIENTE: 'Outros', OUTROS: 'Outros', UNKNOWN: 'Não identificado', MISSING: 'Não identificado' };
const formaRotulo = t => FORMA_ROTULO[t.payment_method.normalized] || 'Não identificado';

function agruparGrupo(t, st, hoje) {
  if (st.status === 'UNKNOWN') return 'UNKNOWN';
  if (st.status === 'SETTLED') return 'PAGO';
  return st.status === 'OVERDUE' ? 'VENCIDO' : st.status === 'DUE_TODAY' ? 'HOJE' : 'FUTURO';
}

/** Constrói a geração. `canon`: títulos canônicos (mapearTitulo) de PAGAR e RECEBER, já deduplicados. */
function construirGeracao({ canon, vendasPorCodigo = {}, comprasPorCodigo = {}, agora = new Date(), geracao, hoje, retencaoPagosDias = RETENCAO_PAGOS_DIAS, tamFatia = TAM_FATIA }) {
  const gerado = agora.toISOString();
  const resumo = { versao: VERSAO, geracao, gerado_em: gerado, data_comercial: hoje, fuso: 'America/Fortaleza',
    metricas_bloqueadas: METRICAS_BLOQUEADAS,
    bankBalance: { available: false, motivo: 'Saldo bancário real não integrado: a API do ERP não fornece saldo nem movimentação bancária.' },
    purchaseCapacity: { status: 'BLOCKED', motivo: 'Indisponível — saldo bancário ainda não integrado.' },
    retencao: { abertos_unknown: 'sem limite de idade', pagos_detalhe_dias: retencaoPagosDias, tamanho_fatia: tamFatia },
    limitacoes: [
      'O Financeiro acompanha títulos e compromissos programados. O saldo bancário real ainda não está integrado.',
      'A API do ERP não informa valor pago nem saldo restante: cada título é tratado como integral.',
      '"Pago/Recebido" é a baixa registrada no ERP, não extrato bancário.',
      'Fluxo programado = recebimentos programados − pagamentos programados no período; NÃO é saldo nem caixa.',
      'Título vencido não é classificação do cliente ou do fornecedor.',
    ] };
  const entidades = { versao: VERSAO, geracao, gerado_em: gerado, pagar: {}, receber: {} };
  const grupos = { PAGAR: Object.fromEntries(GRUPOS.map(g => [g, []])), RECEBER: Object.fromEntries(GRUPOS.map(g => [g, []])) };
  const por = {};

  for (const nat of ['PAGAR', 'RECEBER']) {
    por[nat] = { abertos: ag(), vencido: ag(), hoje: ag(), prox_3d: ag(), prox_7d: ag(), prox_15d: ag(), prox_30d: ag(), unknown: ag(), unknown_motivos: {}, pago_total_historico: ag(), pago_30d: ag(), pago_mes: ag(),
      envelhecimento: Object.fromEntries(M.FAIXAS_ATRASO.map(([k]) => [k, ag()])), por_forma: {}, por_plano: {}, vinculo: {}, total_titulos: 0 };
  }
  const inicioMes = hoje.slice(0, 8) + '01';

  for (const t of canon) {
    const nat = t.natureza, P = por[nat]; P.total_titulos++;
    const st = M.status(t, hoje), grupo = agruparGrupo(t, st, hoje);
    // vínculo (determinístico; heurística nunca entra)
    const vinc = nat === 'RECEBER' ? M.vincularVenda(t, vendasPorCodigo) : M.vincularCompra(t, comprasPorCodigo);
    P.vinculo[vinc.estado] = (P.vinculo[vinc.estado] || 0) + 1;
    const dias = t.due_date ? diffDias(hoje, t.due_date) : null;
    const forma = formaRotulo(t);
    const planoKey = t.chart_account.id ? t.chart_account.id : 'SEM_PLANO';
    const planoNome = t.chart_account.id ? (t.chart_account.name || t.chart_account.id) : 'Sem classificação';
    if (grupo === 'UNKNOWN') {
      add(P.unknown, { final_amount_cents: Math.max(0, t.final_amount_cents || 0) });     // valor inválido/negativo não entra na soma de "requer conferência"
      P.unknown_motivos[st.motivo] = (P.unknown_motivos[st.motivo] || 0) + 1;
    }
    else if (grupo === 'PAGO') {
      add(P.pago_total_historico, t);
      const ds = diffDias(t.settlement_date, hoje);
      if (ds >= 0 && ds < 30) add(P.pago_30d, t);
      if (t.settlement_date >= inicioMes && t.settlement_date <= hoje) add(P.pago_mes, t);
    } else {
      add(P.abertos, t);
      if (grupo === 'VENCIDO') { add(P.vencido, t); add(P.envelhecimento[M.faixaAtraso(t, hoje)], t); }
      if (grupo === 'HOJE') add(P.hoje, t);
      if (dias >= 0) for (const [k, n] of Object.entries(JANELAS_DIAS)) if (dias <= n) add(P[k.toLowerCase()], t);
      const fk = forma; P.por_forma[fk] = P.por_forma[fk] || { aberto: ag(), vencido: ag(), ambigua: formaAmbigua(t) }; add(P.por_forma[fk].aberto, t); if (grupo === 'VENCIDO') add(P.por_forma[fk].vencido, t);
      P.por_plano[planoKey] = P.por_plano[planoKey] || { nome: planoNome, aberto: ag(), vencido: ag() }; add(P.por_plano[planoKey].aberto, t); if (grupo === 'VENCIDO') add(P.por_plano[planoKey].vencido, t);
      // entidade (fornecedor/cliente)
      const ek = t.entity_id ? t.entity_type + ':' + t.entity_id : 'SEM_ENTIDADE:' + t.entity_type;
      const E = (nat === 'PAGAR' ? entidades.pagar : entidades.receber);
      E[ek] = E[ek] || { chave: ek, tipo: t.entity_type, nome: t.entity_name || null, aberto: ag(), vencido: ag(), prox_7d: ag(), prox_30d: ag(), envelhecimento: {} };
      add(E[ek].aberto, t); if (grupo === 'VENCIDO') { add(E[ek].vencido, t); const f = M.faixaAtraso(t, hoje); E[ek].envelhecimento[f] = E[ek].envelhecimento[f] || ag(); add(E[ek].envelhecimento[f], t); }
      if (dias >= 0 && dias <= 7) add(E[ek].prox_7d, t); if (dias >= 0 && dias <= 30) add(E[ek].prox_30d, t);
    }
    // detalhe (compacto)
    const retem = grupo !== 'PAGO' || (diffDias(t.settlement_date, hoje) <= retencaoPagosDias);
    if (retem) {
      const rec = { id: t.source_id, cod: t.source_code, v: t.due_date, desc: t.description ? String(t.description).slice(0, 140) : null, ent: t.entity_name || null, et: t.entity_type, val: t.final_amount_cents,
        pl: t.chart_account.id ? (t.chart_account.name || t.chart_account.id) : null, fp: forma, amb: formaAmbigua(t) || undefined,
        lk: vinc.estado === 'CONFIRMADO' ? { t: nat === 'RECEBER' ? 'VENDA' : 'COMPRA', cod: vinc.codigo, regra: nat === 'RECEBER' ? 'SAFE_DETERMINISTIC' : 'SAFE_DETERMINISTIC_TEXT_LINK' } : (vinc.estado === 'CONFLITO_CLIENTE' || vinc.estado === 'CONFLITO_FORNECEDOR' || vinc.estado === 'CODIGO_DUPLICADO' ? { t: 'AMBIGUO' } : undefined) };
      if (grupo === 'VENCIDO') rec.ag = M.faixaAtraso(t, hoje);
      if (grupo === 'PAGO') rec.sd = t.settlement_date;
      if (grupo === 'UNKNOWN') { rec.mot = st.motivo; rec.motx = MOTIVO_TEXTO[st.motivo] || 'Dados contraditórios no ERP'; rec.sd = t.settlement_date || undefined; }
      grupos[nat][grupo].push(rec);
    }
  }

  // ordenação determinística dos detalhes
  const cmpAsc = (a, b) => String(a.v).localeCompare(String(b.v)) || String(a.id).localeCompare(String(b.id));
  const cmpPago = (a, b) => String(b.sd).localeCompare(String(a.sd)) || String(a.id).localeCompare(String(b.id));
  const fatias = []; const indice = { PAGAR: {}, RECEBER: {} };
  for (const nat of ['PAGAR', 'RECEBER']) for (const g of GRUPOS) {
    const lista = grupos[nat][g].sort(g === 'PAGO' ? cmpPago : cmpAsc);
    const n = Math.max(0, Math.ceil(lista.length / tamFatia)); indice[nat][g] = { fatias: n, titulos: lista.length };
    for (let i = 0; i < n; i++) fatias.push({ id: idFatia(geracao, nat, g, i), doc: { versao: VERSAO, geracao, natureza: nat, grupo: g, indice: i, total_grupo: lista.length, itens: lista.slice(i * tamFatia, (i + 1) * tamFatia) } });
  }

  const sai = nat => {
    const P = por[nat];
    const mapa = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, c: v.c }]));
    return { total_titulos: P.total_titulos, abertos: P.abertos, vencido: P.vencido, hoje: P.hoje, prox_3d: P.prox_3d, prox_7d: P.prox_7d, prox_15d: P.prox_15d, prox_30d: P.prox_30d,
      requer_conferencia: { ...P.unknown, motivos: Object.fromEntries(Object.entries(P.unknown_motivos).map(([k, v]) => [k, { n: v, texto: MOTIVO_TEXTO[k] || 'Dados contraditórios no ERP' }])) },
      envelhecimento: mapa(P.envelhecimento), pago: { historico: P.pago_total_historico, ultimos_30d: P.pago_30d, mes_corrente: P.pago_mes },
      por_forma: Object.entries(P.por_forma).map(([k, v]) => ({ forma: k, ambigua: v.ambigua, aberto: v.aberto, vencido: v.vencido })).sort((a, b) => b.aberto.c - a.aberto.c || a.forma.localeCompare(b.forma)),
      por_plano: Object.entries(P.por_plano).map(([k, v]) => ({ plano_id: k === 'SEM_PLANO' ? null : k, nome: v.nome, aberto: v.aberto, vencido: v.vencido })).sort((a, b) => b.aberto.c - a.aberto.c || String(a.plano_id).localeCompare(String(b.plano_id))),
      vinculos: P.vinculo, detalhe: indice[nat] };
  };
  resumo.pagar = sai('PAGAR'); resumo.receber = sai('RECEBER');
  const fluxo = k => ({ receber_c: por.RECEBER[k].c, pagar_c: por.PAGAR[k].c, liquido_c: por.RECEBER[k].c - por.PAGAR[k].c });
  resumo.fluxo_programado = { definicao: 'recebimentos programados − pagamentos programados no período (vencimentos a partir de hoje); NÃO é saldo bancário nem caixa', d7: fluxo('prox_7d'), d15: fluxo('prox_15d'), d30: fluxo('prox_30d') };
  const ordena = o => Object.values(o).sort((a, b) => b.aberto.c - a.aberto.c || a.chave.localeCompare(b.chave));
  entidades.pagar = ordena(entidades.pagar); entidades.receber = ordena(entidades.receber);
  resumo.contagem_fatias = fatias.length;
  return { resumo, entidades, fatias };
}

function formaAmbigua(t) { return !!t.payment_method.ambiguous; }
const idFatia = (geracao, nat, grupo, i) => `${geracao}__${nat}__${grupo}__${String(i).padStart(3, '0')}`;
const idResumo = geracao => `${geracao}__resumo`;
const idEntidades = geracao => `${geracao}__entidades`;
/** Id de geração: ordenável, sem caracteres especiais. */
const novaGeracao = agora => 'g' + agora.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

module.exports = { METRICAS_BLOQUEADAS, VERSAO, TAM_FATIA, RETENCAO_PAGOS_DIAS, GRUPOS, MOTIVO_TEXTO, FORMA_ROTULO, construirGeracao, idFatia, idResumo, idEntidades, novaGeracao };
