'use strict';
// ORÁCULO INDEPENDENTE do Financeiro: recalcula os agregados direto dos itens BRUTOS da API, sem usar canonico/motor/agregados.
// Aritmética de datas por contagem de dias desde 1970 (Date.UTC), dinheiro por parseFloat→centavos. Usado em testes e na comparação com dados reais.
const dias = ymd => { const [y, m, d] = ymd.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const cent = v => Math.round(parseFloat(v) * 100);
const dataOk = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)));
const FAIXAS = [['D1_A_7', 1, 7], ['D8_A_15', 8, 15], ['D16_A_30', 16, 30], ['D31_A_60', 31, 60], ['D61_A_90', 61, 90], ['D91_A_180', 91, 180], ['D181_A_365', 181, 365], ['ACIMA_365', 366, 1e9]];

function oraculo(brutos, hoje) {
  const H = dias(hoje); const o = { total: brutos.length, abertos: [0, 0], vencido: [0, 0], hoje: [0, 0], d3: [0, 0], d7: [0, 0], d15: [0, 0], d30: [0, 0], unknown: [0, 0], pago: [0, 0], aging: {} };
  FAIXAS.forEach(([k]) => { o.aging[k] = [0, 0]; });
  const s = (a, v) => { a[0]++; a[1] += v; };
  for (const t of brutos) {
    const v = cent(t.valor_total), liq = String(t.liquidado);
    const vOk = !isNaN(v) && v >= 0 && t.id != null && t.id !== '';
    const venc = dataOk(t.data_vencimento) ? t.data_vencimento.slice(0, 10) : null, dl = dataOk(t.data_liquidacao) ? t.data_liquidacao.slice(0, 10) : null;
    const temDl = t.data_liquidacao != null && t.data_liquidacao !== '';
    let est;
    if (!vOk) est = 'U';
    else if (liq === '1') est = !dl ? 'U' : (dias(dl) > H ? 'U' : 'P');
    else if (liq === '0') est = temDl ? 'U' : (!venc ? 'U' : (dias(venc) < H ? 'V' : dias(venc) === H ? 'H' : 'F'));
    else est = 'U';
    if (est === 'U') { s(o.unknown, vOk ? v : 0); continue; }
    if (est === 'P') { s(o.pago, v); continue; }
    s(o.abertos, v);
    const d = dias(venc) - H;
    if (est === 'V') { s(o.vencido, v); const atraso = -d; const f = FAIXAS.find(([, lo, hi]) => atraso >= lo && atraso <= hi)[0]; s(o.aging[f], v); }
    if (d >= 0) { if (d === 0) s(o.hoje, v); if (d <= 3) s(o.d3, v); if (d <= 7) s(o.d7, v); if (d <= 15) s(o.d15, v); if (d <= 30) s(o.d30, v); }
  }
  return o;
}
/** Lê os mesmos números do `resumo` da geração (formato {n,c}) para comparar. */
const doResumo = (r) => ({ total: r.total_titulos, abertos: [r.abertos.n, r.abertos.c], vencido: [r.vencido.n, r.vencido.c], hoje: [r.hoje.n, r.hoje.c], d3: [r.prox_3d.n, r.prox_3d.c], d7: [r.prox_7d.n, r.prox_7d.c], d15: [r.prox_15d.n, r.prox_15d.c], d30: [r.prox_30d.n, r.prox_30d.c],
  unknown: [r.requer_conferencia.n, r.requer_conferencia.c], pago: [r.pago.historico.n, r.pago.historico.c], aging: Object.fromEntries(Object.entries(r.envelhecimento).map(([k, v]) => [k, [v.n, v.c]])) });
module.exports = { oraculo, doResumo, FAIXAS };
