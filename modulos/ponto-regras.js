// ponto-regras.js
// Fonte única de verdade para cálculos de jornada e banco de horas.
// Incluído por ponto.html (gestor) e ponto-func.html (funcionário).
// Todas as funções trabalham em MINUTOS INTEIROS — sem floats intermediários.

const JORNADA_SABADO_MIN = 210; // sábado 08:30–12:00 = 3h30

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
function jornadaParaData(data, jornMin) {
  const d = new Date(data + 'T12:00:00');
  return d.getDay() === 6 ? JORNADA_SABADO_MIN : jornMin;
}

// Minutos trabalhados num dia. Retorna null se ponto incompleto.
function calcTotal(e, sa, ra, s) {
  if (!e || !s) return null;
  let t = toMin(s) - toMin(e);
  if (sa && ra) t -= (toMin(ra) - toMin(sa));
  return t;
}

// Saldo do dia em minutos. Null se ponto incompleto.
function calcSaldoDia(totalMin, jornadaMin) {
  if (totalMin === null || totalMin === undefined) return null;
  return totalMin - jornadaMin;
}

// Constrói objeto dias { 'YYYY-MM-DD': { entrada, saida_almoco, ... } } a partir de registros.
// lancadoPorJustificativa: batida corretiva aprovada pelo gestor sempre prevalece.
function buildDiasFromRegistros(registros) {
  const dias = {};
  registros.forEach(r => {
    if (!dias[r.data]) dias[r.data] = {};
    if (!dias[r.data][r.tipo] || r.lancadoPorJustificativa)
      dias[r.data][r.tipo] = r.hora;
  });
  return dias;
}

// Engine único de cálculo de banco de horas.
//
// Parâmetros:
//   funcionario — objeto com { jornada: '8' | '6' | ... }
//   registros   — array já filtrado por funcId e mês
//   creditos    — array já filtrado por funcId e mês (coleção creditos_jornada)
//   mes         — 'YYYY-MM'
//   hojeStr     — 'YYYY-MM-DD' (dias futuros são ignorados)
//
// Retorna: { trabMin, esperMin, saldo, diasTrab, pendencias }
//   pendencias = [{ data: 'YYYY-MM-DD', tipo: 'PONTO_INCOMPLETO' }]
//
// Regras:
//   FALTA INJUSTIFICADA  = sem registro + sem crédito → esperMin cresce, trabMin não → saldo cai.
//   PONTO INCOMPLETO     = tem registro mas calcTotal=null → NEM esperMin NEM trabMin mudam.
//                          Dia fica PENDENTE até regularização. Não gera −jornada automaticamente.
//   PONTO COMPLETO       = calcTotal > null → trabMin e esperMin crescem normalmente.
//   CRÉDITO SEM PONTO    = atestado/feriado/folga comp → usa creditoD.minutos (0=folga comp).
//   HOME OFFICE          = não gera crédito; ponto é a fonte de verdade.
//   SÁBADO               = jornadaParaData = 210 min.
//   REGISTRO CORRIGIDO   = lancadoPorJustificativa via buildDiasFromRegistros.
function calcBancoMes(funcionario, registros, creditos, mes, hojeStr) {
  const jornMin = (parseFloat(funcionario.jornada) || 8) * 60;
  const [ano, mesNum] = mes.split('-').map(Number);
  const diasNoMes = new Date(ano, mesNum, 0).getDate();

  const diasMap = buildDiasFromRegistros(registros);
  const creditoMap = {};
  creditos.forEach(c => { creditoMap[c.data] = c; });

  let trabMin = 0, esperMin = 0, diasTrab = 0;
  const pendencias = [];

  for (let d = 1; d <= diasNoMes; d++) {
    const dataStr = `${ano}-${String(mesNum).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const diaSemana = new Date(ano, mesNum - 1, d).getDay();
    if (diaSemana === 0) continue;   // domingo: sem jornada
    if (dataStr > hojeStr) continue; // futuro: não conta

    const jornadaDia = jornadaParaData(dataStr, jornMin);
    const diaRegs = diasMap[dataStr];
    const creditoD = creditoMap[dataStr];

    if (diaRegs) {
      const t = calcTotal(
        diaRegs.entrada?.slice(0, 5),
        diaRegs.saida_almoco?.slice(0, 5),
        diaRegs.retorno_almoco?.slice(0, 5),
        diaRegs.saida?.slice(0, 5)
      );
      if (t !== null && t !== undefined) {
        // ponto completo: usa horas reais; ignora crédito (evita double-count de HO)
        trabMin += t;
        esperMin += jornadaDia;
        diasTrab++;
      } else {
        // ponto incompleto: nem trabMin nem esperMin mudam → saldo não consolidado
        pendencias.push({ data: dataStr, tipo: 'PONTO_INCOMPLETO' });
      }
    } else if (creditoD) {
      // dia sem ponto mas com crédito (atestado, feriado, férias)
      // folga comp: creditoD.minutos = 0 → trabMin += 0 → saldo cai = débito do banco
      trabMin += creditoD.minutos || 0;
      esperMin += jornadaDia;
      if ((creditoD.minutos || 0) > 0) diasTrab++;
    } else {
      // falta injustificada: esperMin cresce, trabMin não → saldo decresce por jornadaDia
      esperMin += jornadaDia;
    }
  }

  const saldo = trabMin - esperMin;
  return { trabMin, esperMin, saldo, diasTrab, pendencias };
}
