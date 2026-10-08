// ponto-regras.js
// Fonte única de verdade para cálculos de jornada e banco de horas.
// Incluído por ponto.html (gestor) e ponto-func.html (funcionário).
// Todas as funções trabalham em MINUTOS INTEIROS — sem floats intermediários.

const JORNADA_SABADO_MIN = 210; // sábado 08:30–12:00 = 3h30

// Motivos que identificam crédito de feriado (usado por getTipoCredito).
const TIPOS_FERIADO = ['Feriado nacional', 'Feriado estadual', 'Feriado municipal'];

// Converte 'HH:MM' ou 'HH:MM:SS' para minutos inteiros. Null se falsy.
function toMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Formata minutos para '8h30', '-1h15', '0h00', '—'.
function fmtMin(m) {
  if (m === null || m === undefined) return '—';
  const s = m < 0 ? '-' : '';
  const a = Math.abs(Math.round(m));
  return s + Math.floor(a / 60) + 'h' + String(a % 60).padStart(2, '0');
}

// Jornada prevista em minutos para um funcionário numa data específica.
//   Domingo  → 0
//   Sábado   → JORNADA_SABADO_MIN (210)
//   Seg–Sex  → (funcionario.jornada || 8) × 60
function getJornadaPrevista(funcionario, data) {
  const d = new Date(data + 'T12:00:00');
  const diaSemana = d.getDay();
  if (diaSemana === 0) return 0;
  if (diaSemana === 6) return JORNADA_SABADO_MIN;
  return (parseFloat(funcionario.jornada) || 8) * 60;
}

// Alias: recebe jornMin (número) em vez do objeto funcionario.
// Nota: retorna 0 para domingo (diaSemana===0 → não é sábado, retorna jornMin — use
// getJornadaPrevista quando domingo=0 for necessário).
function jornadaParaData(data, jornMin) {
  const d = new Date(data + 'T12:00:00');
  return d.getDay() === 6 ? JORNADA_SABADO_MIN : jornMin;
}

// Classifica um motivo de crédito em tipo usado pelo engine de cálculo.
//   'ferias'    → Férias
//   'feriado'   → Feriado nacional / estadual / municipal
//   'folga_comp'→ Folga compensatória
//   'abono'     → tudo mais (atestado, licença, falta justificada, motivo undefined)
function getTipoCredito(motivo) {
  if (motivo === 'Férias') return 'ferias';
  if (TIPOS_FERIADO.includes(motivo)) return 'feriado';
  if (motivo === 'Folga compensatória') return 'folga_comp';
  return 'abono';
}

// Minutos trabalhados num dia. Retorna null se ponto incompleto ou inválido.
//
// Regras (DEC-12, DEC-11, DEC-1):
//   DEC-12: saída < entrada → null (cruzamento de meia-noite não suportado).
//   DEC-11: quando sa e ra presentes: exige entrada < sa < ra < saída (strict).
//           sa == ra (almoço 0 min) → null.
//   DEC-1:  se (saída − entrada) > 360 e almoço incompleto (só sa, só ra, ou nenhum) → null.
//           Sábado (≤210 min) e jornadas 6h (≤360 min) raramente excedem 360 → isentos naturalmente.
function calcTotal(e, sa, ra, s) {
  if (!e || !s) return null;
  const tE = toMin(e);
  const tS = toMin(s);

  // DEC-12: meia-noite
  if (tS < tE) return null;

  const hasSa = !!sa;
  const hasRa = !!ra;

  // DEC-11: sequência inválida quando ambos sa/ra presentes
  if (hasSa && hasRa) {
    const tSa = toMin(sa);
    const tRa = toMin(ra);
    if (tSa <= tE || tSa >= tRa || tRa >= tS) return null;
  }

  // DEC-1: almoço obrigatório quando intervalo > 6h
  if ((tS - tE) > 360 && !(hasSa && hasRa)) return null;

  let t = tS - tE;
  if (hasSa && hasRa) t -= (toMin(ra) - toMin(sa));
  return t;
}

// Saldo do dia em minutos. Null se ponto incompleto.
function calcSaldoDia(totalMin, jornadaMin) {
  if (totalMin === null || totalMin === undefined) return null;
  return totalMin - jornadaMin;
}

// PONTO 2.0 F0 (P1-01): assinadoEm pode ser string ISO (legado) OU Timestamp (fluxo atual, serverTimestamp()).
// Devolve 'YYYY-MM-DD' (dia em America/Fortaleza para Timestamp) ou '' — nunca lança.
function dataIsoDe(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.slice(0, 10);
  let d = null;
  if (typeof v.toDate === 'function') d = v.toDate();
  else if (typeof v.seconds === 'number') d = new Date(v.seconds * 1000);
  else if (Object.prototype.toString.call(v) === '[object Date]') d = v;
  if (!d || isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// PONTO 2.0 F0 (P0-02): registros substituídos por uma correção aprovada continuam gravados (auditoria),
// mas não entram no cálculo. Registros antigos não têm o campo → cálculo histórico idêntico ao anterior.
function registrosEfetivos(registros) {
  return (registros || []).filter(r => r && !r.substituidoPor);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOTOR ÚNICO DO DIA — engine 4.0.0 (PONTO 2.0 · unificação Banco × Espelho)
//
//   BATIDAS EFETIVAS + JORNADA + FERIADOS/CRÉDITOS + JUSTIFICATIVAS + PERÍODO APLICÁVEL
//        ↓ calcDia()               (única implementação das regras)
//   RESULTADO DO DIA (DAY_RESULT)
//        ↓ calcMes()               (única soma)
//   BANCO (calcBancoMes) · ESPELHO (buildEspelhoSnapshot) · PENDÊNCIAS · BLOQUEIO DE ASSINATURA
//
// Banco e Espelho NÃO calculam regras: só adaptam o resultado de calcMes().
//
// Regras oficiais (decisões de 28/09/2026):
//   R1 FERIADO: não trabalhado → saldo 0; trabalhado → todas as horas trabalhadas viram saldo positivo
//      (o crédito do feriado cobre a jornada). Batidas incompletas → PENDENTE (não fecha o dia).
//   R2 ATESTADO + TRABALHO PARCIAL: abono completa o restante da jornada, limitado aos minutos do crédito
//      e nunca além do necessário (abono = min(minutosCrédito, jornada − trabalhado)).
//   R3 JUSTIFICATIVA DE AUSÊNCIA APROVADA SEM CRÉDITO: DATA_INCONSISTENCY (pendência; não abona, não desconta).
//   R4 CORREÇÃO DUPLA LEGADA: vale a correção vigente mais recente (aprovadoEm, senão criadoEm);
//      sem timestamp confiável ou empate → DATA_INCONSISTENCY (nunca escolhe pela ordem do Firestore).
//   R5 CORREÇÃO DE BATIDA corrige só aquela batida; dia ainda incompleto → PENDENTE.
//      Justificativa de AUSÊNCIA só abona através do crédito correspondente.
//   R6 DOMINGO: jornada 0; sem trabalho → nada; trabalhado → horas viram saldo positivo; incompleto → PENDENTE.
//   R7 PERÍODO: fora de inicioBancoHoras / afastamentoBanco / controleBancoHoras=false → sem falta, sem débito,
//      sem pendência (batidas continuam visíveis).
// Mantidos: DEC-1 (almoço obrigatório > 6h), DEC-4 (folga compensatória = débito), DEC-10 (férias = saldo 0),
//   DEC-11/12 (sequência inválida / meia-noite → PENDENTE). Almoço < 1h conta como trabalhado
//   (LUNCH_MINIMUM_RULE=NEEDS_FUTURE_BUSINESS_DECISION — comportamento atual preservado).
// ═══════════════════════════════════════════════════════════════════════════════

const TIPOS_PONTO = ['entrada', 'saida_almoco', 'retorno_almoco', 'saida'];
// Motivos de justificativa aprovada que NÃO geram crédito (mesma lista usada por ponto.html ao aprovar).
const TIPOS_SEM_CREDITO = ['Falta injustificada', 'Folga não remunerada', 'Suspensão disciplinar', 'Home Office'];

const PENDENCIA = { PONTO_INCOMPLETO: 'PONTO_INCOMPLETO', DATA_INCONSISTENCY: 'DATA_INCONSISTENCY' };

// Timestamp confiável em ms (Timestamp do Firestore, {seconds}, ISO string, Date). null se ausente/inválido.
function tsMillis(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? null : t; }
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v) ? null : v.getTime();
  return null;
}

// Justificativa de CORREÇÃO DE BATIDA (vira batida corretiva) × justificativa de AUSÊNCIA (abona via crédito).
function ehCorrecaoDeBatida(j) { return !!(j && j.tipoPonto && j.horarioPonto); }

// R4 — batida vigente de UM tipo, entre os registros efetivos do dia.
// Retorna { reg } ou { reg:null, inconsistencia }.
function escolherBatida(regsTipo) {
  const corretivas = regsTipo.filter(r => r.lancadoPorJustificativa);
  if (corretivas.length === 1) return { reg: corretivas[0] };
  if (corretivas.length > 1) {
    const comTs = corretivas.map(r => ({ r, t: tsMillis(r.aprovadoEm) ?? tsMillis(r.criadoEm) }));
    if (comTs.some(x => x.t == null)) return { reg: null, inconsistencia: 'CORRECAO_DUPLA_SEM_TIMESTAMP' };
    comTs.sort((a, b) => b.t - a.t);
    if (comTs[0].t === comTs[1].t) return { reg: null, inconsistencia: 'CORRECAO_DUPLA_EMPATE' };
    return { reg: comTs[0].r };
  }
  if (regsTipo.length === 0) return { reg: null };
  if (regsTipo.length === 1) return { reg: regsTipo[0] };
  // Originais duplicados (só legado; hoje o ID é único por tipo/dia): determinístico — o mais antigo.
  const ord = [...regsTipo].sort((a, b) =>
    ((tsMillis(a.criadoEm) ?? Infinity) - (tsMillis(b.criadoEm) ?? Infinity)) ||
    String(a.hora || '').localeCompare(String(b.hora || '')) ||
    String(a.id || '').localeCompare(String(b.id || '')));
  return { reg: ord[0] };
}

// Constrói objeto dias { 'YYYY-MM-DD': { entrada, saida_almoco, ... } } a partir de registros efetivos,
// com a MESMA escolha de batida do motor (R4). Tipo com correção dupla inconsistente fica ausente.
function buildDiasFromRegistros(registros) {
  const porData = {};
  registrosEfetivos(registros).forEach(r => { (porData[r.data] = porData[r.data] || []).push(r); });
  const dias = {};
  Object.keys(porData).forEach(data => {
    dias[data] = {};
    TIPOS_PONTO.forEach(tipo => {
      const esc = escolherBatida(porData[data].filter(r => r.tipo === tipo));
      if (esc.reg) dias[data][tipo] = esc.reg.hora;
    });
  });
  return dias;
}

// R7 — o dia pertence ao período aplicável do funcionário?
function periodoDoDia(funcionario, dataStr) {
  if (funcionario.controleBancoHoras === false) return { noPeriodo: false, motivo: 'FORA_DO_BANCO' };
  if (funcionario.inicioBancoHoras && dataStr < funcionario.inicioBancoHoras) return { noPeriodo: false, motivo: 'ANTES_DO_INICIO' };
  const a = funcionario.afastamentoBanco;
  if (a && a.inicio && dataStr >= a.inicio && (!a.fim || dataStr <= a.fim)) return { noPeriodo: false, motivo: 'AFASTAMENTO' };
  return { noPeriodo: true, motivo: null };
}

const ROTULO_FORA_PERIODO = { FORA_DO_BANCO: 'Fora do banco de horas', ANTES_DO_INICIO: 'Antes do início do banco', AFASTAMENTO: 'Afastamento' };
const ROTULO_INCONSISTENCIA = {
  JUSTIFICATIVA_SEM_CREDITO: 'Justificativa aprovada sem crédito',
  CREDITO_SEM_MINUTOS: 'Crédito sem minutos',
  CORRECAO_DUPLA_SEM_TIMESTAMP: 'Correção dupla sem data',
  CORRECAO_DUPLA_EMPATE: 'Correção dupla empatada',
};

function minutosDoCredito(c) {
  if (!c || c.minutos === null || c.minutos === undefined || c.minutos === '') return null;
  const n = Number(c.minutos);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * MOTOR ÚNICO DO DIA.
 * @param funcionario   { jornada, controleBancoHoras?, inicioBancoHoras?, afastamentoBanco? }
 * @param dataStr       'YYYY-MM-DD'
 * @param regsDia       registros do funcId nesse dia (quaisquer; substituídos são ignorados aqui)
 * @param creditoD      crédito de jornada do dia (creditos_jornada) ou null
 * @param justifsDia    justificativas do dia (qualquer status; só 'aprovado' conta)
 * @returns DAY_RESULT  {
 *   data, diaSemana, noPeriodo, foraPeriodoMotivo, jornadaPrevistaMin,
 *   entrada, saidaAlmoco, retornoAlmoco, saida,           // batidas vigentes 'HH:MM'
 *   trabalhadoMin,      // horas válidas trabalhadas (null se não há batida ou dia incompleto/inconsistente)
 *   abonadoMin,         // parte coberta por crédito (feriado/atestado/férias/abono)
 *   saldoMin,           // null quando o dia não entra no saldo
 *   contaNoSaldo,       // entra em Banco e Espelho (esperado += jornada, saldo += saldoMin)
 *   diaTrabalhado,      // conta em "dias trabalhados"
 *   status,             // ok | credito | falta | incompleto | inconsistente | domingo | fora_periodo
 *   pendente,           // true = STATUS PENDENTE (bloqueia assinatura)
 *   pendencias,         // [{ tipo: PONTO_INCOMPLETO|DATA_INCONSISTENCY, motivo? }]
 *   ocorrencia          // texto exibido
 * }
 */
function calcDia(funcionario, dataStr, regsDia, creditoD, justifsDia) {
  const diaSemana = new Date(dataStr + 'T12:00:00').getDay();
  const jornMin = (parseFloat(funcionario.jornada) || 8) * 60;
  const jornadaDia = diaSemana === 0 ? 0 : diaSemana === 6 ? JORNADA_SABADO_MIN : jornMin;

  const efetivos = registrosEfetivos(regsDia);
  const batidas = {};
  let inconsBatida = null;
  TIPOS_PONTO.forEach(tipo => {
    const esc = escolherBatida(efetivos.filter(r => r.tipo === tipo));
    if (esc.inconsistencia && !inconsBatida) inconsBatida = esc.inconsistencia;
    batidas[tipo] = esc.reg && esc.reg.hora ? esc.reg.hora.slice(0, 5) : null;
  });
  const temBatida = efetivos.length > 0;

  const aprovadas = (justifsDia || []).filter(j => j && j.status === 'aprovado')
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  const ausencias = aprovadas.filter(j => !ehCorrecaoDeBatida(j));
  const correcoes = aprovadas.filter(ehCorrecaoDeBatida);

  const periodo = periodoDoDia(funcionario, dataStr);
  const r = {
    data: dataStr, diaSemana, noPeriodo: periodo.noPeriodo, foraPeriodoMotivo: periodo.motivo,
    jornadaPrevistaMin: jornadaDia,
    entrada: batidas.entrada, saidaAlmoco: batidas.saida_almoco, retornoAlmoco: batidas.retorno_almoco, saida: batidas.saida,
    trabalhadoMin: null, abonadoMin: 0, saldoMin: null, contaNoSaldo: false, diaTrabalhado: false,
    status: 'ok', pendente: false, pendencias: [],
    ocorrencia: ausencias[0] ? (ausencias[0].motivo || '')
      : correcoes[0] ? (correcoes[0].motivo || '')
      : (creditoD && !temBatida ? (creditoD.motivo || '') : ''),
  };
  const pendenciar = (tipo, motivo, status) => {
    r.pendencias.push(motivo ? { tipo, motivo } : { tipo });
    r.pendente = true; r.status = status;
  };
  const t = inconsBatida ? null : calcTotal(batidas.entrada, batidas.saida_almoco, batidas.retorno_almoco, batidas.saida);

  // R7 — fora do período aplicável: batidas visíveis, sem falta, sem débito, sem pendência.
  if (!periodo.noPeriodo) {
    r.trabalhadoMin = temBatida ? t : null;
    r.status = 'fora_periodo';
    r.jornadaPrevistaMin = 0;
    if (!r.ocorrencia) r.ocorrencia = ROTULO_FORA_PERIODO[periodo.motivo] || '';
    return r;
  }
  // R4 — correção dupla legada sem critério seguro
  if (inconsBatida) {
    pendenciar(PENDENCIA.DATA_INCONSISTENCY, inconsBatida, 'inconsistente');
    r.ocorrencia = ROTULO_INCONSISTENCIA[inconsBatida];
    return r;
  }
  // R6 — domingo sem batida: nada a contar (crédito em domingo é ignorado, DEC-7)
  if (diaSemana === 0 && !temBatida) { r.status = 'domingo'; return r; }

  const tipoCred = creditoD ? getTipoCredito(creditoD.motivo) : null;
  const minCred = minutosDoCredito(creditoD);
  // Crédito que não informa minutos não pode abonar nada com segurança (férias não dependem de minutos).
  if (creditoD && tipoCred !== 'ferias' && minCred === null && jornadaDia > 0) {
    pendenciar(PENDENCIA.DATA_INCONSISTENCY, 'CREDITO_SEM_MINUTOS', 'inconsistente');
    r.ocorrencia = ROTULO_INCONSISTENCIA.CREDITO_SEM_MINUTOS + (creditoD.motivo ? ' (' + creditoD.motivo + ')' : '');
    return r;
  }
  // R3 — ausência aprovada que deveria ter gerado crédito, mas o crédito não existe
  if (!creditoD && jornadaDia > 0 && ausencias.some(j => !TIPOS_SEM_CREDITO.includes(j.motivo))) {
    pendenciar(PENDENCIA.DATA_INCONSISTENCY, 'JUSTIFICATIVA_SEM_CREDITO', 'inconsistente');
    r.trabalhadoMin = temBatida ? t : null;
    const m = ausencias.find(j => !TIPOS_SEM_CREDITO.includes(j.motivo)).motivo;
    r.ocorrencia = ROTULO_INCONSISTENCIA.JUSTIFICATIVA_SEM_CREDITO + (m ? ' (' + m + ')' : '');
    return r;
  }

  if (temBatida) {
    // R1/R5/R6 + DEC-1/11/12 — dia com batida incompleta ou inválida nunca é fechado automaticamente
    if (t === null) { pendenciar(PENDENCIA.PONTO_INCOMPLETO, null, 'incompleto'); return r; }
    r.trabalhadoMin = t;
    r.contaNoSaldo = true;
    r.diaTrabalhado = true;
    if (tipoCred === 'ferias') {
      // DEC-10: férias → saldo 0 mesmo com ponto
      r.abonadoMin = Math.max(0, jornadaDia - t);
      r.saldoMin = 0;
    } else if (tipoCred === 'feriado') {
      // R1: crédito do feriado cobre a jornada → todas as horas trabalhadas viram saldo positivo
      r.abonadoMin = Math.min(minCred, jornadaDia);
      r.saldoMin = t + r.abonadoMin - jornadaDia;
    } else if (tipoCred === 'abono') {
      // R2: atestado/abono completa só o que falta, limitado aos minutos do crédito
      r.abonadoMin = Math.min(minCred, Math.max(0, jornadaDia - t));
      r.saldoMin = t + r.abonadoMin - jornadaDia;
    } else {
      // sem crédito relevante (null, folga compensatória): ponto normal; domingo tem jornada 0 (R6)
      r.saldoMin = t - jornadaDia;
    }
    r.status = 'ok';
    return r;
  }

  if (creditoD) {
    // dia sem batida coberto por crédito (feriado não trabalhado, atestado, férias, folga compensatória)
    r.contaNoSaldo = true;
    if (tipoCred === 'ferias') { r.abonadoMin = jornadaDia; r.saldoMin = 0; r.diaTrabalhado = true; r.status = 'credito'; return r; }
    r.abonadoMin = Math.min(minCred, jornadaDia);
    r.saldoMin = r.abonadoMin - jornadaDia;            // folga compensatória (0 min) = −jornada (DEC-4)
    r.diaTrabalhado = r.abonadoMin > 0;
    r.status = r.abonadoMin > 0 ? 'credito' : 'ok';
    return r;
  }

  // falta: sem batida e sem crédito
  r.contaNoSaldo = true;
  r.saldoMin = -jornadaDia;
  r.status = 'falta';
  return r;
}

/**
 * Mês completo a partir do motor do dia. Única soma usada por Banco e Espelho.
 * Dias futuros (> hojeStr) não entram.
 */
function calcMes(funcionario, registros, creditos, justificativas, mes, hojeStr) {
  const [ano, mesNum] = mes.split('-').map(Number);
  const diasNoMes = new Date(ano, mesNum, 0).getDate();
  const regsPorData = {}, credPorData = {}, justPorData = {};
  (registros || []).forEach(x => { if (x && x.data && x.data.startsWith(mes)) (regsPorData[x.data] = regsPorData[x.data] || []).push(x); });
  (creditos || []).forEach(x => { if (x && x.data && x.data.startsWith(mes)) credPorData[x.data] = x; });
  (justificativas || []).forEach(x => { if (x && x.data && x.data.startsWith(mes)) (justPorData[x.data] = justPorData[x.data] || []).push(x); });

  const dias = [];
  for (let d = 1; d <= diasNoMes; d++) {
    const dataStr = `${ano}-${String(mesNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dataStr > hojeStr) continue;
    dias.push(calcDia(funcionario, dataStr, regsPorData[dataStr] || [], credPorData[dataStr] || null, justPorData[dataStr] || []));
  }
  let trabMin = 0, esperMin = 0, saldo = 0, diasTrab = 0, abonadoMin = 0;
  const pendencias = [];
  dias.forEach(x => {
    if (x.contaNoSaldo) {
      esperMin += x.jornadaPrevistaMin;
      saldo += x.saldoMin;
      trabMin += x.jornadaPrevistaMin + x.saldoMin;     // horas creditadas (trabalhado + abono), como no banco 3.x
      abonadoMin += x.abonadoMin;
      if (x.diaTrabalhado) diasTrab++;
    }
    x.pendencias.forEach(p => pendencias.push({ data: x.data, ...p }));
  });
  return { mes, dias, totais: { trabMin, esperMin, saldo, diasTrab, abonadoMin }, pendencias };
}

// BANCO DE HORAS — adaptador do motor único (não contém regra).
// `justificativas` (6º parâmetro) é necessário para R3/R5; ausente = nenhuma justificativa.
function calcBancoMes(funcionario, registros, creditos, mes, hojeStr, justificativas) {
  const m = calcMes(funcionario, registros, creditos || [], justificativas || [], mes, hojeStr);
  const { trabMin, esperMin, saldo, diasTrab } = m.totais;
  return { trabMin, esperMin, saldo, diasTrab, pendencias: m.pendencias, dias: m.dias };
}

// Verifica se um espelho pode ser assinado.
//
// Bloqueia se (fonte = pendências do MOTOR ÚNICO, as mesmas do Banco e do Espelho):
//   - Há dia PENDENTE no período: PONTO_INCOMPLETO ou DATA_INCONSISTENCY.
//   - Há justificativas com status='pendente' no período (mês YYYY-MM).
//
// Permite mesmo com:
//   - Saldo negativo, faltas já resolvidas (aprovadas), férias, atestado,
//     folga compensatória, Home Office com ponto correto.
//
// Retorna: { pode: bool, motivo: string|null }
function podeAssinarEspelho(pendencias, justificativas, mes) {
  const inconsist = (pendencias || []).filter(p => p.tipo === PENDENCIA.DATA_INCONSISTENCY);
  if (inconsist.length > 0) {
    return { pode: false, motivo: 'Existem inconsistências administrativas no período (' + inconsist.length + ' dia(s)) — procure o gestor' };
  }
  if ((pendencias || []).length > 0) {
    return { pode: false, motivo: 'Existem pontos incompletos no período' };
  }
  const justifPendentes = (justificativas || []).filter(
    j => j.data && j.data.startsWith(mes) && j.status === 'pendente'
  );
  if (justifPendentes.length > 0) {
    return { pode: false, motivo: 'Existem justificativas pendentes no período' };
  }
  return { pode: true, motivo: null };
}

// ── Snapshot e versionamento de espelho ──────────────────────────────────────

// 4.0.0 = motor único (calcDia/calcMes). Snapshots 3.x continuam renderizados e verificados com as regras 3.x.
const VERSAO_ENGINE = '4.0.0';
function ehSnapshotV4(snap) { return !!(snap && typeof snap.engineVersao === 'string' && /^4\./.test(snap.engineVersao)); }

// ESPELHO — adaptador do motor único (não contém regra).
// O snapshot é o SIGNED_SNAPSHOT: tudo o que o funcionário vê e assina (linhas, totais, pendências, período),
// congelado no documento; mudanças futuras no motor não alteram um snapshot já gravado.
//
// Parâmetros: funcionario { id?, nome, cargo, jornada, inicioBancoHoras?, afastamentoBanco?, controleBancoHoras? },
//   registros/creditos/justificativas (todos do funcId; filtrados internamente por mês), mes 'YYYY-MM', hojeStr.
// Retorna: snapshot sem 'geradoEm' — o caller define e adiciona antes de canonicalizar.
function buildEspelhoSnapshot(funcionario, registros, creditos, justificativas, mes, hojeStr) {
  const m = calcMes(funcionario, registros, creditos, justificativas, mes, hojeStr);
  const dias = m.dias.map(d => ({
    data: d.data, diaSemana: d.diaSemana,
    entrada: d.entrada, saidaAlmoco: d.saidaAlmoco, retornoAlmoco: d.retornoAlmoco, saida: d.saida,
    // Total exibido: horas trabalhadas; em dia só de crédito, os minutos abonados (como no espelho 3.x)
    totalMin: d.trabalhadoMin !== null ? d.trabalhadoMin : (d.contaNoSaldo && d.status !== 'falta' ? d.abonadoMin : null),
    trabalhadoMin: d.trabalhadoMin,
    abonadoMin: d.abonadoMin,
    jornadaDia: d.jornadaPrevistaMin,
    saldoDia: d.contaNoSaldo ? d.saldoMin : null,
    contaNoSaldo: d.contaNoSaldo,
    status: d.status,
    pendente: d.pendente,
    pendencias: d.pendencias.map(p => p.motivo ? p.tipo + ':' + p.motivo : p.tipo),
    ocorrencia: d.ocorrencia,
  }));
  return {
    funcId:      funcionario.id || funcionario.funcId || '',
    funcionario: {
      nome: funcionario.nome || '', cargo: funcionario.cargo || '', jornada: funcionario.jornada || 8,
      // período aplicável usado no cálculo (faz parte do que foi assinado)
      inicioBancoHoras: funcionario.inicioBancoHoras || null,
      afastamentoBanco: funcionario.afastamentoBanco
        ? { inicio: funcionario.afastamentoBanco.inicio || null, fim: funcionario.afastamentoBanco.fim || null, tipo: funcionario.afastamentoBanco.tipo || null }
        : null,
      controleBancoHoras: funcionario.controleBancoHoras !== false,
    },
    mes,
    dias,
    totais: { ...m.totais, pendencias: m.pendencias.length },
    engineVersao: VERSAO_ENGINE,
  };
}

// Representação canônica determinística do snapshot para hashing.
// O campo 'geradoEm' deve ser adicionado ao snapshot pelo caller antes de chamar.
// Versionada: snapshot 3.x usa exatamente o formato 3.x (hashes antigos continuam verificáveis).
function canonicalizarSnapshot(snapshot) {
  if (!ehSnapshotV4(snapshot)) return _canonicalizarSnapshotV3(snapshot);
  const diasOrdenados = [...(snapshot.dias || [])].sort((a, b) => a.data < b.data ? -1 : 1);
  const f = snapshot.funcionario || {};
  const af = f.afastamentoBanco || null;
  return JSON.stringify({
    funcId: snapshot.funcId,
    funcionario: {
      nome: f.nome, cargo: f.cargo, jornada: f.jornada,
      inicioBancoHoras: f.inicioBancoHoras || null,
      afastamentoBanco: af ? { inicio: af.inicio || null, fim: af.fim || null, tipo: af.tipo || null } : null,
      controleBancoHoras: f.controleBancoHoras !== false,
    },
    mes: snapshot.mes,
    dias: diasOrdenados.map(d => ({
      data: d.data, diaSemana: d.diaSemana,
      entrada: d.entrada, saidaAlmoco: d.saidaAlmoco, retornoAlmoco: d.retornoAlmoco, saida: d.saida,
      totalMin: d.totalMin, trabalhadoMin: d.trabalhadoMin, abonadoMin: d.abonadoMin,
      jornadaDia: d.jornadaDia, saldoDia: d.saldoDia, contaNoSaldo: d.contaNoSaldo,
      status: d.status, pendente: d.pendente, pendencias: [...(d.pendencias || [])],
      ocorrencia: d.ocorrencia,
    })),
    totais: {
      trabMin: snapshot.totais.trabMin, esperMin: snapshot.totais.esperMin, saldo: snapshot.totais.saldo,
      diasTrab: snapshot.totais.diasTrab, abonadoMin: snapshot.totais.abonadoMin, pendencias: snapshot.totais.pendencias,
    },
    geradoEm:     snapshot.geradoEm     || '',
    engineVersao: snapshot.engineVersao || '',
  });
}

// Mesmo conteúdo calculado (ignora apenas o momento da geração)? Usado para impedir assinatura de espelho
// desatualizado: o funcionário só assina se o snapshot enviado ainda é o que o motor calcula hoje.
function snapshotsEquivalentes(a, b) {
  if (!a || !b || !ehSnapshotV4(a) || !ehSnapshotV4(b)) return false;
  return canonicalizarSnapshot({ ...a, geradoEm: '' }) === canonicalizarSnapshot({ ...b, geradoEm: '' });
}

// Gera as linhas HTML (<tr>) do corpo da tabela de espelho a partir de um snapshot.
// Usada tanto por ponto.html (gestor) quanto por ponto-func.html (funcionário).
// Versionada: snapshot 3.x é desenhado exatamente como era (documento congelado não muda de aparência).
// PONTO 2.0 F0 (P1-04): ocorrência vem de justificativa (texto do funcionário) — sempre escapada
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])); }
function renderEspelhoRowsHTML(snap) {
  if (!ehSnapshotV4(snap)) return _renderEspelhoRowsHTMLV3(snap);
  const NOMES_DIA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return snap.dias.map(d => {
    const ehFimSemana = d.diaSemana === 0 || d.diaSemana === 6;
    const diaN = parseInt(d.data.split('-')[2], 10);
    const diaSem = NOMES_DIA[d.diaSemana];

    let totalLabel = '—';
    if (d.status === 'incompleto') totalLabel = 'Incompleto';
    else if (d.status === 'inconsistente') totalLabel = 'Inconsistência';
    else if (d.status === 'falta') totalLabel = 'Falta';
    else if (d.totalMin !== null && d.totalMin !== undefined) {
      totalLabel = fmtMin(d.totalMin);
      // trabalho + abono no mesmo dia (feriado trabalhado, atestado parcial): mostra as duas partes
      if (d.trabalhadoMin !== null && d.trabalhadoMin !== undefined && d.abonadoMin > 0) totalLabel += ' + ' + fmtMin(d.abonadoMin) + ' abono';
    }

    const saldoStr = d.saldoDia !== null && d.saldoDia !== undefined ? (d.saldoDia >= 0 ? '+' : '') + fmtMin(d.saldoDia) : '—';
    const bgColor = d.status === 'fora_periodo' ? 'background:#f3f3f3;'
                  : d.pendente ? 'background:#fff4e5;'
                  : ehFimSemana ? 'background:#eeeeee;'
                  : d.status === 'credito' && !d.entrada ? 'background:#f0fff4;'
                  : d.ocorrencia ? 'background:#fff8e1;'
                  : '';
    const totalColor = totalLabel === 'Falta' ? 'color:#c0392b;font-weight:600;'
                     : d.pendente ? 'color:#e67e22;font-weight:600;'
                     : d.status === 'fora_periodo' ? 'color:#777;'
                     : 'color:#111;';
    const saldoColor = d.saldoDia > 0 ? 'color:#1a7a3a;font-weight:600;'
                     : d.saldoDia < 0 ? 'color:#c0392b;font-weight:600;'
                     : 'color:#111;';
    const ocorrColor = d.status === 'credito' && !d.entrada ? 'color:#1a7a3a;'
                     : d.status === 'fora_periodo' ? 'color:#777;'
                     : 'color:#c0392b;';
    return `<tr style="${bgColor}">` +
      `<td style="color:#111;font-weight:600;"><strong>${diaN}</strong> ${diaSem}</td>` +
      `<td style="color:#111;">${d.entrada       || '—'}</td>` +
      `<td style="color:#111;">${d.saidaAlmoco   || '—'}</td>` +
      `<td style="color:#111;">${d.retornoAlmoco || '—'}</td>` +
      `<td style="color:#111;">${d.saida         || '—'}</td>` +
      `<td style="${totalColor}">${totalLabel}</td>` +
      `<td style="${saldoColor}">${saldoStr}</td>` +
      `<td style="${ocorrColor}font-size:10px;">${escHtml(d.ocorrencia || '')}</td>` +
      `</tr>`;
  }).join('');
}

// [3.x] Formato canônico do engine 3.0.0 — PRESERVADO sem alteração para verificar hashes de snapshots 3.x.
// O campo 'geradoEm' deve ser adicionado ao snapshot pelo caller antes de chamar.
// Campos enumerados explicitamente (nunca dependem de ordem de inserção de objeto).
function _canonicalizarSnapshotV3(snapshot) {
  const diasOrdenados = [...(snapshot.dias || [])].sort((a, b) => a.data < b.data ? -1 : 1);
  return JSON.stringify({
    funcId: snapshot.funcId,
    funcionario: {
      nome:    snapshot.funcionario.nome,
      cargo:   snapshot.funcionario.cargo,
      jornada: snapshot.funcionario.jornada,
    },
    mes: snapshot.mes,
    dias: diasOrdenados.map(d => ({
      data:          d.data,
      diaSemana:     d.diaSemana,
      entrada:       d.entrada,
      saidaAlmoco:   d.saidaAlmoco,
      retornoAlmoco: d.retornoAlmoco,
      saida:         d.saida,
      totalMin:      d.totalMin,
      jornadaDia:    d.jornadaDia,
      saldoDia:      d.saldoDia,
      ocorrencia:    d.ocorrencia,
      status:        d.status,
    })),
    totais: {
      trabMin:  snapshot.totais.trabMin,
      esperMin: snapshot.totais.esperMin,
      saldo:    snapshot.totais.saldo,
      diasTrab: snapshot.totais.diasTrab,
    },
    geradoEm:     snapshot.geradoEm     || '',
    engineVersao: snapshot.engineVersao || '',
  });
}

// [3.x] Linhas do espelho como o engine 3.0.0 desenhava — PRESERVADO para snapshots 3.x congelados.
function _renderEspelhoRowsHTMLV3(snap) {
  const NOMES_DIA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return snap.dias.map(d => {
    const ehDomingo   = d.diaSemana === 0;
    const ehFimSemana = d.diaSemana === 0 || d.diaSemana === 6;
    const diaN        = parseInt(d.data.split('-')[2], 10);
    const diaSem      = NOMES_DIA[d.diaSemana];

    let totalLabel = '—';
    if (!ehDomingo) {
      if (d.totalMin !== null && d.totalMin !== undefined) totalLabel = fmtMin(d.totalMin);
      else if (d.status === 'incompleto')                  totalLabel = 'Incompleto';
      else                                                 totalLabel = 'Falta';
    }

    const bgColor       = ehFimSemana                          ? 'background:#eeeeee;'
                        : d.status === 'credito' && !d.entrada ? 'background:#f0fff4;'
                        : d.ocorrencia                         ? 'background:#fff8e1;'
                        : '';
    const totalColor    = totalLabel === 'Falta'      ? 'color:#c0392b;font-weight:600;'
                        : totalLabel === 'Incompleto' ? 'color:#e67e22;font-weight:600;'
                        : 'color:#111;';
    const saldoColor    = d.saldoDia > 0 ? 'color:#1a7a3a;font-weight:600;'
                        : d.saldoDia < 0 ? 'color:#c0392b;font-weight:600;'
                        : 'color:#111;';
    const ocorrColor    = d.status === 'credito' && !d.entrada ? 'color:#1a7a3a;' : 'color:#c0392b;';
    const saldoStr      = d.saldoDia !== null ? (d.saldoDia >= 0 ? '+' : '') + fmtMin(d.saldoDia) : '—';

    return `<tr style="${bgColor}">` +
      `<td style="color:#111;font-weight:600;"><strong>${diaN}</strong> ${diaSem}</td>` +
      `<td style="color:#111;">${d.entrada      || '—'}</td>` +
      `<td style="color:#111;">${d.saidaAlmoco  || '—'}</td>` +
      `<td style="color:#111;">${d.retornoAlmoco|| '—'}</td>` +
      `<td style="color:#111;">${d.saida        || '—'}</td>` +
      `<td style="${totalColor}">${totalLabel}</td>` +
      `<td style="${saldoColor}">${saldoStr}</td>` +
      `<td style="${ocorrColor}font-size:10px;">${escHtml(d.ocorrencia || '')}</td>` +
      `</tr>`;
  }).join('');
}

// ── calcRevisaoPeriodo ────────────────────────────────────────────────────────
// Função pura: monta os documentos para iniciar uma revisão de período.
// Retorna { v2Doc, v1Update } ou null em caso de validação inválida.
//
// Semântica:
//   - v1 permanece como última versão assinada válida enquanto v2 não for assinada.
//   - v1 recebe revisaoEmAndamento:true (NÃO invalidado) para sinalizar revisão aberta.
//   - v2 nasce com status:'aguardando_assinatura' e assinado:false.
//   - v1.invalidado só muda via calcConcluirRevisao, após assinatura da v2.
//
// novoId deve ser gerado pelo chamador (uid()), mantendo a função testável.
function calcRevisaoPeriodo(espExist, novoId, novoSnap, novoHash, motivo, agora) {
  if (!espExist || !espExist.assinado) return null;
  if (!motivo || !motivo.trim()) return null;

  var novaVersao = (espExist.versao || 1) + 1;

  var v2Doc = {
    id: novoId,
    funcId: espExist.funcId,
    mes: espExist.mes,
    mesLabel: espExist.mesLabel || '',
    versao: novaVersao,
    versaoAnteriorId: espExist.id,
    versaoSucessoraId: null,
    invalidado: false,
    invalidadoEm: null,
    motivoInvalidacao: null,
    status: 'aguardando_assinatura',
    motivoRevisao: motivo.trim(),
    geradoEm: novoSnap.geradoEm || agora,
    geradoPor: 'Gestor',
    snapshot: novoSnap,
    hashSnapshot: novoHash,
    assinado: false,
    assinadoEm: null,
    assinadoPor: null,
    assinaturaImg: null,
    criadoEm: agora,
  };

  // v1 não é invalidada agora — continua sendo a última versão assinada válida.
  // Apenas registra que há uma revisão em andamento e aponta para v2.
  var v1Update = {
    versaoSucessoraId: novoId,
    revisaoEmAndamento: true,
    revisaoAbertaEm: agora,
    motivoRevisao: motivo.trim(),
  };

  return { v2Doc: v2Doc, v1Update: v1Update };
}

// ── calcConcluirRevisao ───────────────────────────────────────────────────────
// Função pura: monta as atualizações para concluir uma revisão após o funcionário
// assinar a v2. Retorna { v2Update, v1Update }.
//
// ATENÇÃO — LIMITAÇÃO DE RULES:
//   - v2Update: pode ser aplicado pelo funcionário (campos de assinatura).
//   - v1Update: requer gestor ou Cloud Function.
//     As futuras Rules restringirão o funcionário a
//     hasOnly(['assinado','assinaturaImg','assinadoEm','assinadoPor','status']).
//     O funcionário não poderá atualizar v1 diretamente.
//     A finalização de v1 deverá ocorrer por ação explícita do gestor ou
//     por Cloud Function (onUpdate trigger em espelhos/{id}).
function calcConcluirRevisao(v1Id, v2Id, assinadoPor, assinaturaImg, agora) {
  var v2Update = {
    assinado: true,
    status: 'assinado',
    assinadoPor: assinadoPor,
    assinadoEm: agora,
    assinaturaImg: assinaturaImg,
  };

  // v1Update só pode ser aplicado com permissões de gestor (ver limitação acima).
  var v1Update = {
    revisaoEmAndamento: false,
    substituido: true,
    substituidoEm: agora,
  };

  return { v2Update: v2Update, v1Update: v1Update, v1Id: v1Id, v2Id: v2Id };
}


// ═══════════════════════════════════════════════════════════════════════════════
// BANCO DE HORAS ACUMULATIVO + COMPENSAÇÃO DE FALTAS (funções PURAS, em minutos inteiros)
// NÃO altera o motor do dia nem o espelho: só ENCADEIA os saldos mensais já calculados e aplica
// lançamentos do razão `banco_horas_lancamentos`. Tudo desligado por padrão (banco_horas_config/politica).
// Regras trabalhistas (prazo, limite negativo, quitação) NÃO são definidas aqui: vêm da política cadastrada.
// ═══════════════════════════════════════════════════════════════════════════════

/** Id determinístico do lançamento de compensação (idempotência: 1 por funcionário × data de ausência). */
function idCompensacao(funcId, dataAusencia) { return funcId + '_' + dataAusencia; }

/** Lançamentos de compensação VIGENTES = COMPENSACAO_AUSENCIA que não possuem ESTORNO. */
function compensacoesVigentes(lancamentos) {
  const est = new Set((lancamentos || []).filter(l => l.tipo === 'ESTORNO').map(l => l.estornaId));
  return (lancamentos || []).filter(l => l.tipo === 'COMPENSACAO_AUSENCIA' && !est.has(l.id));
}

/**
 * Encadeia os meses. `meses` = [{ mes:'YYYY-MM', dias:[{data, saldoMin, contaNoSaldo}], congelado?:bool, origem?:string }]
 * em ordem crescente, começando no 1º mês do banco do funcionário.
 * Compensação: o motor já debita uma falta (−jornada). O ajuste do lançamento é só o que o motor NÃO debitou naquele dia
 * (evita débito duplo): extra = −(H − min(H, debitoMotorDoDia)). Se o motor já debitou tudo, é só reclassificação.
 * Ajustes (tipo AJUSTE, minutos com sinal) entram na competência.
 * @returns {Array<{mes, saldoAnterior, creditos, debitos, compensacoes, ajustes, saldoFinal, congelado, origem}>}
 */
function calcBancoAcumulado(meses, lancamentos) {
  const vig = compensacoesVigentes(lancamentos), ajustes = (lancamentos || []).filter(l => l.tipo === 'AJUSTE');
  let ant = 0; const out = [];
  (meses || []).forEach(m => {
    let cred = 0, deb = 0; const porData = {};
    (m.dias || []).forEach(d => {
      if (!d.contaNoSaldo || d.saldoMin === null || d.saldoMin === undefined) return;
      porData[d.data] = d.saldoMin;
      if (d.saldoMin > 0) cred += d.saldoMin; else deb += d.saldoMin;
    });
    let comp = 0;
    vig.filter(l => String(l.dataAusencia || '').startsWith(m.mes)).forEach(l => {
      const motorDebita = Math.max(0, -(porData[l.dataAusencia] || 0));
      comp -= (l.minutos - Math.min(l.minutos, motorDebita));
    });
    const aj = ajustes.filter(l => l.competencia === m.mes).reduce((a, l) => a + l.minutos, 0);
    const fim = ant + cred + deb + comp + aj;
    out.push({ mes: m.mes, saldoAnterior: ant, creditos: cred, debitos: deb, compensacoes: comp, ajustes: aj, saldoFinal: fim, congelado: !!m.congelado, origem: m.origem || 'MOTOR' });
    ant = fim;
  });
  return out;
}

/**
 * Avalia uma compensação ANTES de gravar. `saldoAtualMin` = saldo acumulado final atual (já inclui o débito do motor naquele dia);
 * `debitoMotorDiaMin` = quanto o motor já debitou na data da ausência (≥0). Política desconhecida = NÃO permite saldo negativo.
 */
function avaliarCompensacao(saldoAtualMin, debitoMotorDiaMin, horasMin, politica) {
  const pol = politica || {};
  if (!Number.isInteger(horasMin) || horasMin <= 0 || horasMin > 1440) return { ok: false, motivo: 'HORAS_INVALIDAS' };
  const antes = saldoAtualMin + Math.max(0, debitoMotorDiaMin || 0);      // saldo sem o débito automático daquela ausência
  const depois = antes - horasMin;
  if (depois >= 0) return { ok: true, saldoAntesMin: antes, saldoDepoisMin: depois, negativo: false };
  if (pol.permiteSaldoNegativo !== true) return { ok: false, motivo: 'SALDO_INSUFICIENTE_NEGATIVO_NAO_PERMITIDO', saldoAntesMin: antes, saldoDepoisMin: depois };
  const lim = Number.isInteger(pol.limiteNegativoMin) ? pol.limiteNegativoMin : 100000;
  if (depois < -lim) return { ok: false, motivo: 'EXCEDE_LIMITE_NEGATIVO', saldoAntesMin: antes, saldoDepoisMin: depois };
  return { ok: true, saldoAntesMin: antes, saldoDepoisMin: depois, negativo: true };
}

/** Lista 'YYYY-MM' de `inicio` (YYYY-MM-DD) até `fimMes` inclusive. Sem início → [] (não se acumula sem data de início do banco). */
function mesesDoBanco(inicio, fimMes) {
  if (!inicio || !/^\d{4}-\d{2}/.test(inicio)) return [];
  let [y, m] = inicio.slice(0, 7).split('-').map(Number); const out = [];
  while (`${y}-${String(m).padStart(2, '0')}` <= fimMes) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

/**
 * Monta a entrada de calcBancoAcumulado. Mês com espelho ASSINADO que tem snapshot usa os dias CONGELADOS do snapshot
 * (nunca recalcula). Assinado sem snapshot (legado) usa o motor atual, marcado origem='ASSINADO_SEM_SNAPSHOT'.
 * `mesesDados` = [{ mes, regs, cred, just }]; mês corrente é calculado só até `ontemStr` (dia em andamento fica de fora).
 */
function montarMesesBanco(func, mesesDados, espelhos, hojeStr, ontemStr, mesAtualStr) {
  return (mesesDados || []).map(md => {
    const ass = (espelhos || []).filter(e => e.funcId === func.id && e.mes === md.mes && e.assinado && !e.substituido)
      .sort((a, b) => (b.versao || 0) - (a.versao || 0))[0];
    if (ass && ass.snapshot && Array.isArray(ass.snapshot.dias)) {
      return { mes: md.mes, congelado: true, origem: 'SNAPSHOT_ASSINADO', pendencias: 0,
        dias: ass.snapshot.dias.map(x => ({ data: x.data, saldoMin: x.saldoDia, contaNoSaldo: !!x.contaNoSaldo, status: x.status })) };
    }
    const r = calcBancoMes(func, md.regs || [], md.cred || [], md.mes, md.mes === mesAtualStr ? ontemStr : hojeStr, md.just || []);
    return { mes: md.mes, congelado: false, origem: ass ? 'ASSINADO_SEM_SNAPSHOT' : 'MOTOR', pendencias: r.pendencias.length,
      dias: r.dias.map(x => ({ data: x.data, saldoMin: x.saldoMin, contaNoSaldo: x.contaNoSaldo, status: x.status })) };
  });
}
