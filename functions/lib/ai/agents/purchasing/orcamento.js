'use strict';
// AGENTE DE COMPRAS — orçamento ("tenho R$ X"). 100% DETERMINÍSTICO: o valor sai da pergunta por parsing no backend e a cesta é montada pelo
// SIMULADOR DE ORÇAMENTO DO MOTOR (lib/compras/simulador.js — o MESMO que a tela "Planejar orçamento" usa; estratégia e piso vêm da política gravada
// em compras_n0_view/custos.resumo_financeiro.simulator). Aqui só: (1) extrair o valor, (2) montar os itens como a tela monta, (3) verificar invariantes,
// (4) explicar por que cada item ficou de fora. O modelo NUNCA escolhe item nem soma: recebe a cesta como FATO.
const Sim = require('../../../compras/simulador');

const ORCAMENTO_MIN_REAIS = 100, ORCAMENTO_MAX_REAIS = 5000000;
const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Extrai o orçamento da pergunta. status: NENHUM (a pergunta não fala de valor) | OK | AMBIGUO (mais de um valor distinto) | SEM_VALOR_NUMERICO
 * ("dez mil": exige número) | FORA_DA_FAIXA (< R$ 100 ou > R$ 5.000.000). Nunca adivinha: na dúvida pede esclarecimento.
 */
function parsearOrcamento(texto) {
  const t = norm(texto);
  const dicaDinheiro = /(r\$|\breais\b|\breal\b|\bmil\b|\d\s*k\b)/.test(t);
  const verbo = /\b(tenho|tiver|disponivel|orcamento|investir|gastar|verba|colocar|aplicar|dinheiro|caixa|capital)\b/.test(t);
  const re = /(r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(mil\b|k\b|reais\b|real\b)?/g;
  const achados = []; let m;
  while ((m = re.exec(t))) {
    const bruto = m[2]; let n = parseFloat(bruto.includes(',') ? bruto.replace(/\./g, '').replace(',', '.') : (/^\d{1,3}(\.\d{3})+$/.test(bruto) ? bruto.replace(/\./g, '') : bruto));
    if (!Number.isFinite(n)) continue;
    if (m[3] === 'mil' || m[3] === 'k') n *= 1000;
    achados.push({ valor: Math.round(n * 100) / 100, dinheiro: !!(m[1] || m[3]) });
  }
  let cand = achados.filter(a => a.dinheiro);
  if (!cand.length && verbo) cand = achados.filter(a => a.valor >= ORCAMENTO_MIN_REAIS);          // "tenho 10000 para comprar": número solto só conta com verbo de orçamento
  const distintos = [...new Set(cand.map(a => a.valor))];
  if (!distintos.length) return dicaDinheiro ? { status: 'SEM_VALOR_NUMERICO' } : { status: 'NENHUM' };
  if (distintos.length > 1) return { status: 'AMBIGUO', quantidade: distintos.length };
  const v = distintos[0];
  if (!(v >= ORCAMENTO_MIN_REAIS && v <= ORCAMENTO_MAX_REAIS)) return { status: 'FORA_DA_FAIXA' };
  return { status: 'OK', valorCents: Math.round(v * 100) };
}

/** Itens do simulador EXATAMENTE como a tela monta (compras.html · itensOrcamento): só produtos com sugestão; custo/preço da ficha financeira. */
function itensDaVisao(linhas, custosLinhas) {
  return linhas.filter(l => l.qtd > 0).map(l => {
    const f = (custosLinhas[l.id] || {}).fin || {}, c = f.cost || {}, p = f.price || {}, pu = f.purchase || {};
    return { id: String(l.id), priority: l.prioridade, qty: l.qtd, cost_cents: c.unit_cents > 0 ? c.unit_cents : null, price_cents: p.unit_cents > 0 ? p.unit_cents : null, velocity: pu.velocity || 0, efficiency: pu.efficiency === undefined ? null : pu.efficiency };
  });
}

/** Invariantes que NUNCA podem falhar (se falhar, o agente não responde com cesta: falha fechada). */
function verificarInvariantes(sim, itens, orcamentoCents) {
  const porId = new Map(itens.map(i => [i.id, i]));
  const gasto = sim.items.reduce((t, a) => t + a.qty_1_2 * porId.get(a.id).cost_cents, 0);
  const erros = [];
  if (sim.spent_cents !== gasto) erros.push('GASTO_DIVERGE_DOS_ITENS');
  if (sim.spent_cents > orcamentoCents) erros.push('GASTO_ACIMA_DO_ORCAMENTO');
  if (sim.spent_cents + sim.left_cents !== orcamentoCents) erros.push('SOBRA_INCONSISTENTE');
  for (const a of sim.items) { const i = porId.get(a.id); if (!(a.qty_1_2 >= 1 && a.qty_1_2 <= i.qty)) erros.push('QTD_FORA_DO_LIMITE_DA_SUGESTAO'); }
  if (new Set(sim.items.map(a => a.id)).size !== sim.items.length) erros.push('ITEM_DUPLICADO');
  if (erros.length) { const e = new Error('CESTA_INVARIANTE_VIOLADA: ' + [...new Set(erros)].join(',')); e.codigo = 'CESTA_INVARIANTE_VIOLADA'; throw e; }
}

/** Motivo (código) de cada produto sugerido que NÃO entrou integralmente na cesta. */
function explicarFora(sim, itens, orcamentoCents) {
  const fin = new Map(sim.items.map(a => [a.id, a])), fora = [];
  for (const i of [...itens].sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0) || b.qty - a.qty || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const a = fin.get(i.id);
    if (a && a.qty_1_2 === i.qty) continue;
    let motivo;
    if (a) motivo = 'COMPRA_PARCIAL';                                  // financiado, mas menos que a sugestão do motor
    else if (!(i.cost_cents > 0)) motivo = 'SEM_CUSTO';                // fora da simulação: exige decisão manual
    else if (i.cost_cents > orcamentoCents) motivo = 'UNIDADE_MAIS_CARA_QUE_ORCAMENTO';
    else motivo = 'ORCAMENTO_ESGOTADO';                                // o dinheiro foi para itens melhor posicionados (e o custo unitário > sobra)
    fora.push({ id: i.id, motivo });
  }
  return fora;
}

/**
 * Cesta determinística. cfgSim = resumo_financeiro.simulator ({strategy, p1_floor_days, priorities, scale}) da política gravada pelo servidor.
 * @returns {{ sim, itens, fora, estrategia }} · lança ORCAMENTO_INVALIDO / ESTRATEGIA_INVALIDA / CESTA_INVARIANTE_VIOLADA
 */
function montarCesta(linhas, custosLinhas, cfgSim, orcamentoCents) {
  if (!cfgSim || !cfgSim.strategy) { const e = new Error('SIMULADOR_INDISPONIVEL'); e.codigo = 'SIMULADOR_INDISPONIVEL'; throw e; }
  if (!(Number.isInteger(orcamentoCents) && orcamentoCents >= 0)) { const e = new Error('ORCAMENTO_INVALIDO'); e.codigo = 'ORCAMENTO_INVALIDO'; throw e; }
  const itens = itensDaVisao(linhas, custosLinhas);
  const sim = Sim.simular(itens, orcamentoCents, cfgSim.strategy, cfgSim);
  verificarInvariantes(sim, itens, orcamentoCents);
  return { sim, itens, fora: explicarFora(sim, itens, orcamentoCents), estrategia: cfgSim.strategy };
}
module.exports = { ORCAMENTO_MIN_REAIS, ORCAMENTO_MAX_REAIS, parsearOrcamento, itensDaVisao, verificarInvariantes, explicarFora, montarCesta };
