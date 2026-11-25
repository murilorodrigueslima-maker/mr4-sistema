'use strict';
/** Relatório de validação RECEPCAO/SOMBRA — função pura sobre os documentos de gc_webhook_eventos (só ids/horários/códigos; sem dado pessoal). */
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;
function resumir(eventos) {
  const r = { total: eventos.length, porEvento: {}, porStatus: {}, porResultado: {}, porModo: {}, duplicadosReenviados: 0, foraDeOrdem: 0, estornos: 0, falhas: 0, latGcParaReceptorMs: null, latReceptorParaSombraMs: null, semOcorridoEm: 0 };
  const inc = (o, k) => { o[k || 'NA'] = (o[k || 'NA'] || 0) + 1; };
  const lat1 = [], lat2 = [], porRegistro = {};
  for (const e of eventos) {
    inc(r.porEvento, e.evento); inc(r.porStatus, e.status); inc(r.porResultado, e.resultado); inc(r.porModo, e.modo);
    if ((e.tentativa || 1) > 1) r.duplicadosReenviados++;
    if (/estornado$/.test(e.evento || '')) r.estornos++;
    if (e.status === 'SOMBRA_FALHA' || e.status === 'PENDENTE_SOMBRA') r.falhas++;
    const oc = e.ocorrido_em ? Date.parse(e.ocorrido_em) : NaN;
    if (Number.isFinite(oc) && e.recebido_ms) lat1.push(e.recebido_ms - oc); else r.semOcorridoEm++;
    if (e.processado_ms && e.recebido_ms) lat2.push(e.processado_ms - e.recebido_ms);
    if (Number.isFinite(oc)) (porRegistro[e.recurso + ':' + e.registro_id] = porRegistro[e.recurso + ':' + e.registro_id] || []).push({ oc, rec: e.recebido_ms || 0 });
  }
  for (const k of Object.keys(porRegistro)) { const l = porRegistro[k].sort((a, b) => a.rec - b.rec); for (let i = 1; i < l.length; i++) if (l[i].oc < l[i - 1].oc) { r.foraDeOrdem++; break; } }
  const f = a => a.length ? { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: Math.max(...a) } : null;
  r.latGcParaReceptorMs = f(lat1); r.latReceptorParaSombraMs = f(lat2);
  return r;
}
module.exports = { resumir };
