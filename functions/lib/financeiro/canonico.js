'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · Modelo canônico de títulos (contas a pagar / a receber).
//
// Regras de base:
//  - Datas comerciais em America/Fortaleza, SEM depender do fuso da máquina (Intl + aritmética de data pura).
//  - Dinheiro em CENTAVOS inteiros (nada de float acumulado).
//  - Nada é inventado: campo ausente/ inválido → null e o título pode virar UNKNOWN (com motivo).
//
// Mapa GestãoClick → canônico (comprovado por sondagem GET em 28–29/09/2026; /pagamentos e /recebimentos têm o mesmo formato):
//   id                    → source_id              (string; chave de deduplicação)
//   codigo                → source_code
//   entidade              → entity_type            (F fornecedor · U funcionário · O outros · C cliente · T transportadora)
//   fornecedor_id|cliente_id|funcionario_id|transportadora_id (conforme entidade) → entity_id
//   nome_fornecedor|nome_cliente|nome_funcionario|nome_transportadora              → entity_name (dado pessoal/comercial: só no detalhe protegido)
//   descricao             → description
//   data_competencia      → competence_date        (a API não tem "data de emissão"; issue_date = NÃO DISPONÍVEL)
//   data_vencimento       → due_date
//   valor                 → original_amount_cents
//   juros                 → interest_cents          (do título; não há baixa separada)
//   desconto              → discount_cents
//   taxa_banco            → bank_fee_cents
//   taxa_operadora        → operator_fee_cents
//   valor_total           → final_amount_cents      (= valor + juros − desconto − taxas; conferido em 100% da amostra)
//   liquidado ("0"/"1")   → settled_flag
//   data_liquidacao       → settlement_date
//   (derivado)            → settlement_amount_cents = final_amount_cents SE liquidado (a API não informa valor pago por baixa)
//   forma_pagamento_id / nome_forma_pagamento → payment_method {raw_id, raw_name, tipo_gc, normalized, ambiguous}
//   plano_contas_id / nome_plano_conta         → chart_account {id, name} (preservado exatamente como na origem)
//   conta_bancaria_id / nome_conta_bancaria    → bank_account {id, name} (hoje: 1 conta genérica, sem saldo)
//   cadastrado_em         → source_created_at
//   modificado_em         → source_updated_at
//   (sync)                → synced_at

const TZ_COMERCIAL = 'America/Fortaleza';

/** Data comercial (YYYY-MM-DD) em Fortaleza para um instante — independente do fuso da máquina. */
function dataComercial(instante = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_COMERCIAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}
/** YYYY-MM-DD válido (calendário real) ou null. Datas da API são só-data (sem fuso). */
function parseData(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
/** Soma dias a uma data só-data (aritmética UTC pura; sem fuso da máquina). */
function somarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Diferença em dias inteiros (b − a) entre datas só-data. */
function diffDias(a, b) {
  const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}
/** Valor monetário → centavos inteiros; inválido → null. Aceita "1234.56", 1234.56, "0". */
function centavos(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [int, dec = ''] = s.replace('-', '').split('.');
  const c = Number(int) * 100 + Number((dec + '00').slice(0, 2)) + (Number((dec + '000')[2] || 0) >= 5 ? 1 : 0);
  return s.startsWith('-') ? -c : c;
}

// ── Formas de pagamento ─────────────────────────────────────────────────────
// tipo GC (tabela /formas_pagamentos) → classe normalizada. Ambiguidade explícita, nunca "chute".
const TIPO_GC = { PI: 'PIX', BB: 'BOLETO', CC: 'CARTAO_CREDITO', CD: 'CARTAO_DEBITO', DI: 'DINHEIRO', TB: 'TRANSFERENCIA', CL: 'CREDITO_CLIENTE', OU: 'OUTROS' };
function normalizarForma(rawId, rawName, formasPorId) {
  const ref = formasPorId && rawId != null ? formasPorId[String(rawId)] : null;
  const tipo = ref && ref.tipo ? String(ref.tipo) : null;
  const nome = String(rawName || (ref && ref.nome) || '');
  const n = nome.toLowerCase();
  const mencionaPix = /\bpix\b/.test(n), mencionaBoleto = /boleto/.test(n);
  let normalized = tipo && TIPO_GC[tipo] ? TIPO_GC[tipo] : 'UNKNOWN';
  let ambiguous = false;
  // "boleto Inter/Pix" (tipo BB): o título pode ter sido pago por boleto OU por Pix → não afirmar nenhum
  if (mencionaPix && mencionaBoleto) { normalized = 'AMBIGUOUS'; ambiguous = true; }
  if (!rawId && !nome) normalized = 'MISSING';
  return { raw_id: rawId != null && rawId !== '' ? String(rawId) : null, raw_name: nome || null, tipo_gc: tipo, normalized, ambiguous };
}

// ── Entidade ────────────────────────────────────────────────────────────────
const ENTIDADE = {
  F: ['fornecedor_id', 'nome_fornecedor', 'FORNECEDOR'],
  U: ['funcionario_id', 'nome_funcionario', 'FUNCIONARIO'],
  C: ['cliente_id', 'nome_cliente', 'CLIENTE'],
  T: ['transportadora_id', 'nome_transportadora', 'TRANSPORTADORA'],
  O: [null, null, 'OUTROS'],
};

/**
 * Converte um título bruto da API em título canônico.
 * @param raw        objeto de /pagamentos ou /recebimentos
 * @param natureza   'PAGAR' | 'RECEBER'
 * @param refs       { formasPorId, syncedAt }
 */
function mapearTitulo(raw, natureza, refs = {}) {
  const e = ENTIDADE[raw.entidade] || null;
  const entityId = e && e[0] && raw[e[0]] ? String(raw[e[0]]) : null;
  const entityName = e && e[1] && raw[e[1]] ? String(raw[e[1]]) : null;
  const bank = centavos(raw.taxa_banco), op = centavos(raw.taxa_operadora);
  const final = centavos(raw.valor_total);
  const liquidado = raw.liquidado === '1' || raw.liquidado === 1 ? true : raw.liquidado === '0' || raw.liquidado === 0 ? false : null;
  return {
    source_id: raw.id != null ? String(raw.id) : null,
    source_code: raw.codigo != null ? String(raw.codigo) : null,
    natureza,
    entity_type: e ? e[2] : (raw.entidade ? 'DESCONHECIDA:' + raw.entidade : 'AUSENTE'),
    entity_id: entityId,
    entity_name: entityName,
    description: raw.descricao != null ? String(raw.descricao) : null,
    competence_date: parseData(raw.data_competencia),
    issue_date: null,                                   // não disponível na API
    due_date: parseData(raw.data_vencimento),
    due_date_raw: raw.data_vencimento != null ? String(raw.data_vencimento) : null,
    original_amount_cents: centavos(raw.valor),
    interest_cents: centavos(raw.juros),
    discount_cents: centavos(raw.desconto),
    bank_fee_cents: bank,
    operator_fee_cents: op,
    fees_cents: bank === null && op === null ? null : (bank || 0) + (op || 0),
    final_amount_cents: final,
    settled_flag: liquidado,
    settlement_date: parseData(raw.data_liquidacao),
    settlement_date_raw: raw.data_liquidacao ? String(raw.data_liquidacao) : null,
    settlement_amount_cents: liquidado === true ? final : null,   // derivado: a API não tem valor pago por baixa
    payment_method: normalizarForma(raw.forma_pagamento_id, raw.nome_forma_pagamento, refs.formasPorId),
    chart_account: { id: raw.plano_contas_id ? String(raw.plano_contas_id) : null, name: raw.nome_plano_conta ? String(raw.nome_plano_conta) : null },
    bank_account: { id: raw.conta_bancaria_id ? String(raw.conta_bancaria_id) : null, name: raw.nome_conta_bancaria ? String(raw.nome_conta_bancaria) : null },
    source_created_at: raw.cadastrado_em || null,
    source_updated_at: raw.modificado_em || null,
    synced_at: refs.syncedAt || null,
  };
}

module.exports = { TZ_COMERCIAL, dataComercial, parseData, somarDias, diffDias, centavos, normalizarForma, mapearTitulo, TIPO_GC };
