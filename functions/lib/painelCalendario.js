'use strict';
/**
 * Calendário comercial do Painel (PURO). Peso do dia = horas de expediente ÷ horas de um dia completo (seg–sex 9h ⇒ 1,0; sábado 3,5h ⇒ ~0,389; domingo 0).
 * Feriados/exceções vêm de painel_calendario/default (configurável). NADA aqui toca o módulo Ponto. Projeção é ESTIMATIVA, nunca valor realizado.
 */
const PADRAO = {
  inicio: '08:30',
  horasPorDiaSemana: { 0: 0, 1: 9, 2: 9, 3: 9, 4: 9, 5: 9, 6: 3.5 },   // seg–sex 08:30–17:30; sáb 08:30–12:00; dom fechado
  horasDiaCompleto: 9,
  // expediente: 'FECHADO' (0 h) | 'NORMAL' | 'REDUZIDO' (horas informadas). `verificado` = confirmado por vendas reais em ocorrência anterior.
  feriados: [],
};
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

function normalizar(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const h = { ...PADRAO.horasPorDiaSemana, ...(c.horasPorDiaSemana || {}) };
  return { inicio: /^\d{2}:\d{2}$/.test(c.inicio || '') ? c.inicio : PADRAO.inicio, horasPorDiaSemana: h,
    horasDiaCompleto: Number(c.horasDiaCompleto) > 0 ? Number(c.horasDiaCompleto) : PADRAO.horasDiaCompleto,
    feriados: Array.isArray(c.feriados) ? c.feriados : [], excecoes: Array.isArray(c.excecoes) ? c.excecoes : [] };
}

/** { horas, peso, motivo } do dia. Exceção cadastrada vence feriado, que vence a semana padrão. */
function diaComercial(cfg, dataStr) {
  const c = normalizar(cfg);
  const ex = c.excecoes.find(e => e && e.data === dataStr && Number.isFinite(Number(e.horas)));
  if (ex) return { horas: Number(ex.horas), peso: Number(ex.horas) / c.horasDiaCompleto, motivo: 'EXCECAO:' + (ex.nome || '') };
  const fe = c.feriados.find(f => f && f.data === dataStr);
  const base = c.horasPorDiaSemana[dow(dataStr)] || 0;
  if (fe) {
    const modo = fe.expediente || 'FECHADO';
    if (modo === 'FECHADO') return { horas: 0, peso: 0, motivo: 'FERIADO:' + (fe.nome || '') };
    if (modo === 'REDUZIDO' && Number.isFinite(Number(fe.horas))) return { horas: Number(fe.horas), peso: Number(fe.horas) / c.horasDiaCompleto, motivo: 'FERIADO_REDUZIDO:' + (fe.nome || '') };
    return { horas: base, peso: base / c.horasDiaCompleto, motivo: 'FERIADO_COM_EXPEDIENTE:' + (fe.nome || '') };
  }
  return { horas: base, peso: base / c.horasDiaCompleto, motivo: dow(dataStr) === 0 ? 'DOMINGO' : 'NORMAL' };
}

function diasDoMes(cfg, mes) {
  const [y, m] = mes.split('-').map(Number), n = new Date(Date.UTC(y, m, 0)).getUTCDate(), out = [];
  for (let i = 1; i <= n; i++) { const d = `${mes}-${String(i).padStart(2, '0')}`; out.push({ d, dow: dow(d), ...diaComercial(cfg, d) }); }
  return out;
}

/** Fração do expediente de HOJE já decorrida (0..1) segundo a hora de Fortaleza 'HH:MM'. */
function fracaoHoje(cfg, dataStr, hora) {
  const c = normalizar(cfg), dc = diaComercial(c, dataStr);
  if (!(dc.horas > 0)) return 0;
  const ini = hhmm(c.inicio), fim = ini + dc.horas * 60, t = hhmm(hora);
  return Math.min(1, Math.max(0, (t - ini) / (fim - ini)));
}

function confiabilidade(eq) { return eq < 1 ? 'INSUFICIENTE' : eq < 3 ? 'BAIXA' : eq < 8 ? 'MEDIA' : 'ALTA'; }

/**
 * acumulado em REAIS (já conciliado). Retorna ritmo e projeção — informativos.
 */
function ritmoEProjecao({ cfg, mes, hojeStr, hora, acumulado, meta }) {
  const dias = diasDoMes(cfg, mes);
  const hojeNoMes = hojeStr.startsWith(mes);
  const fr = hojeNoMes ? fracaoHoje(cfg, hojeStr, hora) : (hojeStr > mes + '-31' ? 1 : 0);
  let dec = 0, rest = 0;
  dias.forEach(x => {
    if (x.d < hojeStr) dec += x.peso; else if (x.d > hojeStr) rest += x.peso;
    else { dec += x.peso * fr; rest += x.peso * (1 - fr); }
  });
  const r2 = v => Math.round(v * 100) / 100;
  const conf = confiabilidade(dec);
  const media = dec > 0 ? acumulado / dec : 0;
  const falta = Math.max(0, (meta || 0) - acumulado);
  const metaNec = rest > 0 ? falta / rest : null;
  const projecao = conf === 'INSUFICIENTE' ? null : acumulado + rest * media;
  return {
    diasEquivalentesTotal: r2(dec + rest), diasEquivalentesDecorridos: r2(dec), diasEquivalentesRestantes: r2(rest), fracaoHoje: r2(fr),
    mediaPorDiaUtil: dec >= 1 ? r2(media) : null, metaNecessariaPorDiaUtil: metaNec === null ? null : r2(metaNec),
    projecaoFechamento: projecao === null ? null : r2(projecao), diferencaProjetadaMeta: projecao === null || !meta ? null : r2(projecao - meta),
    pctProjetadoMeta: projecao === null || !meta ? null : Math.round((projecao / meta) * 1000) / 10,
    confiabilidade: conf, estimativa: true, metodo: 'media_por_dia_util_equivalente',
    situacao: projecao === null || !meta ? 'SEM_BASE' : projecao >= meta ? 'NO_RITMO' : projecao >= meta * 0.85 ? 'ATENCAO' : 'ABAIXO',
  };
}

/**
 * Comparativo com o mês anterior no MESMO PERÍODO COMERCIAL EQUIVALENTE: consome, nos dias do mês anterior, o mesmo nº de dias
 * equivalentes decorridos no mês atual (último dia parcial é proporcional — estimativa).
 * diarioAnterior: { 'YYYY-MM-DD': { v: centavos, p: pedidos } }
 */
function comparativoMesAnterior({ cfg, mesAnterior, diasEquivalentesDecorridos, diarioAnterior, acumuladoAtual, pedidosAtual }) {
  if (!diarioAnterior) return null;
  const dias = diasDoMes(cfg, mesAnterior);
  let consumido = 0, v = 0, p = 0, ate = null, total = 0, totalP = 0;
  dias.forEach(x => { const r = diarioAnterior[x.d] || { v: 0, p: 0 }; total += r.v; totalP += r.p; });
  for (const x of dias) {
    const r = diarioAnterior[x.d] || { v: 0, p: 0 };
    const falta = diasEquivalentesDecorridos - consumido;
    if (falta <= 1e-9) break;
    if (x.peso <= 0) { v += r.v; p += r.p; ate = x.d; continue; }          // dia sem expediente: vendas dele entram na cronologia, sem consumir equivalência
    if (x.peso <= falta + 1e-9) { v += r.v; p += r.p; consumido += x.peso; ate = x.d; }
    else { const f = falta / x.peso; v += r.v * f; p += r.p * f; consumido += falta; ate = x.d; break; }
  }
  const valor = Math.round(v) / 100, ped = Math.round(p);
  const dif = Math.round((acumuladoAtual - valor) * 100) / 100;
  return { mes: mesAnterior, ateData: ate, valor, pedidos: ped, totalMesAnterior: Math.round(total) / 100, pedidosMesAnterior: totalP,
    diferenca: dif, variacaoPct: valor > 0 ? Math.round((dif / valor) * 1000) / 10 : null, diasEquivalentes: Math.round(diasEquivalentesDecorridos * 100) / 100,
    estimativaProporcional: true };
}

module.exports = { PADRAO, normalizar, diaComercial, diasDoMes, fracaoHoje, ritmoEProjecao, comparativoMesAnterior, confiabilidade };
