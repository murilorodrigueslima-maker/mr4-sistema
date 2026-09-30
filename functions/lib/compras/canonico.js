'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · Modelo canônico (produtos, fatos de venda, fatos de compra).
// Adaptado à realidade COMPROVADA da API do GestãoClick (sondagens GET de 29/09/2026):
//   /produtos  — 877 produtos, todos ativo=1; estoque atual; valor_custo (custo CADASTRADO); valor_venda; grupo;
//                cadastrado_em confiável para ~853 (os de 14–15/04/2026 tratados como carga: baixa confiança); SEM estoque mínimo;
//                SEM fornecedor; possui_composicao=0 em todos (sem kits estruturados); sem histórico de estoque.
//   /vendas    — itens em produtos[]: produto_id, variacao_id, quantidade, valor_venda, valor_custo (cópia do custo
//                cadastrado no momento da venda), valor_total; situacao_estoque ("1" = baixou estoque).
//   /compras   — {Compra:{...}}: data_emissao, cadastrado_em, fornecedor_id, nome_situacao (Confirmada / A receber /
//                Em aberto / Cancelada), produtos[] com produto_id, quantidade, valor_custo; frete e impostos só no total.
//                Sem data de pedido × recebimento → sem lead time.
// Dinheiro em centavos. Datas só-data. Nada inventado: ausente/ inválido → null.

const TZ_COMERCIAL = 'America/Fortaleza';
const DATAS_DE_CARGA = ['2026-04-14', '2026-04-15'];   // cadastro em massa: não é data de criação do produto

function dataComercial(instante = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_COMERCIAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}
function parseData(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
function somarDias(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function diffDias(a, b) { const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((t(b) - t(a)) / 86400000); }
function centavos(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [int, dec = ''] = s.replace('-', '').split('.');
  const c = Number(int) * 100 + Number((dec + '00').slice(0, 2)) + (Number((dec + '000')[2] || 0) >= 5 ? 1 : 0);
  return s.startsWith('-') ? -c : c;
}
function numero(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function mapearProduto(raw) {
  const criado = parseData(raw.cadastrado_em);
  return {
    product_id: raw.id != null ? String(raw.id) : null,
    code: raw.codigo_interno ? String(raw.codigo_interno) : null,
    name: raw.nome != null ? String(raw.nome) : null,                  // só no detalhe protegido
    group_id: raw.grupo_id ? String(raw.grupo_id) : null,
    group_name: raw.nome_grupo ? String(raw.nome_grupo) : null,
    active: raw.ativo === '1' || raw.ativo === 1 || raw.ativo === true,
    moves_stock: raw.movimenta_estoque === '1' || raw.movimenta_estoque === 1,
    has_variation: raw.possui_variacao === '1',
    has_composition: raw.possui_composicao === '1',                    // kit/composição estruturado
    current_stock: numero(raw.estoque),
    registered_cost_cents: centavos(raw.valor_custo),                   // custo CADASTRADO (≠ último custo de compra em 78%)
    sale_price_cents: centavos(raw.valor_venda),
    created_at: criado,
    created_at_reliable: !!criado && !DATAS_DE_CARGA.includes(criado),
    erp_min_stock: null,                                                 // a API não tem estoque mínimo
    updated_at: raw.modificado_em || null,
  };
}

// ── Regra de DEMANDA (explícita): conta só venda que baixou estoque e não está cancelada ──
const RE_CANCELADA = /cancel|n[aã]o fechou/i;
function contaComoDemanda(venda) {
  return String(venda.situacao_estoque) === '1' && !RE_CANCELADA.test(String(venda.nome_situacao || ''));
}
/**
 * Origem da demanda (rastreável, nunca misturada em silêncio):
 *   COMPLETED          — "Concretizada" que baixou estoque
 *   RESERVED           — "Reservado" que baixou estoque (conta como demanda operacional, identificada à parte)
 *   OTHER_STOCK_MOVED  — outra situação não cancelada que baixou estoque
 *   NOT_DEMAND         — cancelada/estornada ou sem baixa de estoque
 * O estado é sempre o ATUAL do registro: uma reserva depois cancelada volta como NOT_DEMAND na próxima leitura
 * (o registro mais recente por id substitui o anterior — ver fetch.mesclarRegistros).
 */
function origemDemanda(venda) {
  if (!contaComoDemanda(venda)) return 'NOT_DEMAND';
  const n = String(venda.nome_situacao || '').trim().toLowerCase();
  if (n === 'concretizada') return 'COMPLETED';
  if (n === 'reservado' || n === 'reservada') return 'RESERVED';
  return 'OTHER_STOCK_MOVED';
}
/** Fatos de venda (1 por item). Linhas repetidas do mesmo produto na mesma venda são somadas depois pelo motor. */
function fatosDeVenda(raw) {
  const data = parseData(raw.data);
  const demanda = contaComoDemanda(raw);
  const origem = origemDemanda(raw);
  return (raw.produtos || []).map((p, i) => {
    const it = p.produto || p;
    return {
      sale_id: raw.id != null ? String(raw.id) : null, line: i, date: data, status: raw.nome_situacao || null,
      stock_status: raw.situacao_estoque != null ? String(raw.situacao_estoque) : null, counts_as_demand: demanda && !!data, demand_source_status: origem,
      product_id: it.produto_id != null ? String(it.produto_id) : null, variation_id: it.variacao_id != null ? String(it.variacao_id) : null,
      qty: numero(it.quantidade), unit: it.sigla_unidade || null,
      unit_price_cents: centavos(it.valor_venda), unit_cost_snapshot_cents: centavos(it.valor_custo), line_total_cents: centavos(it.valor_total),
    };
  });
}
/** Fatos de compra (1 por item). Só "Confirmada" é entrada confirmada; "A receber"/"Em aberto" = pendente; "Cancelada" não conta. */
function situacaoCompra(nome) {
  const n = String(nome || '').toLowerCase();
  if (n.includes('cancel')) return 'CANCELADA';
  if (n === 'confirmada') return 'CONFIRMADA';
  if (n === 'a receber' || n === 'em aberto') return 'PENDENTE';
  return 'DESCONHECIDA';
}
function fatosDeCompra(rawWrap) {
  const raw = rawWrap.Compra || rawWrap;
  const st = situacaoCompra(raw.nome_situacao);
  return (raw.produtos || []).map((p, i) => {
    const it = p.produto || p;
    return {
      purchase_id: raw.id != null ? String(raw.id) : null, line: i, issue_date: parseData(raw.data_emissao), registered_date: parseData(raw.cadastrado_em),
      status: st, supplier_id: raw.fornecedor_id ? String(raw.fornecedor_id) : null,
      product_id: it.produto_id != null ? String(it.produto_id) : null, qty: numero(it.quantidade), unit_cost_cents: centavos(it.valor_custo),
      freight_taxes_not_allocated: !!(Number(raw.valor_frete) || Number(raw.valor_impostos)),
    };
  });
}

module.exports = { TZ_COMERCIAL, DATAS_DE_CARGA, dataComercial, parseData, somarDias, diffDias, centavos, numero, mapearProduto, contaComoDemanda, origemDemanda, fatosDeVenda, situacaoCompra, fatosDeCompra, RE_CANCELADA };
