'use strict';

/**
 * Testes unitários da engine de cálculo: ponto-regras.js
 *
 * Carrega o arquivo via vm.runInContext — sem modificar ponto-regras.js.
 * Documenta o comportamento ATUAL. Onde existe bug conhecido, o teste
 * captura o valor atual e o comenta claramente.
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=ponto-regras.unit.test
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ─── Carrega ponto-regras.js sem alterar o arquivo original ───────────────────
const src = fs.readFileSync(
  path.resolve(__dirname, '../../modulos/ponto-regras.js'),
  'utf8'
);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const {
  toMin,
  fmtMin,
  calcTotal,
  calcSaldoDia,
  getJornadaPrevista,
  jornadaParaData,
  buildDiasFromRegistros,
  calcBancoMes,
} = ctx;

// ─── Constantes de referência ─────────────────────────────────────────────────
// Setembro de 2026 — dias da semana verificados:
//   09-01 = terça (2)   09-02 = quarta (3)  09-03 = quinta (4)
//   09-04 = sexta (5)   09-05 = sábado (6)  09-06 = domingo (0)
//   09-07 = segunda (1)
const MES    = '2026-09';
const SEG    = '2026-09-07'; // segunda
const TER    = '2026-09-01'; // terça
const QUA    = '2026-09-02'; // quarta
const QUI    = '2026-09-03'; // quinta
const SEX    = '2026-09-04'; // sexta
const SAB    = '2026-09-05'; // sábado
const DOM    = '2026-09-06'; // domingo

const JORNADA_8H = 480; // min
const JORNADA_6H = 360; // min
const JORNADA_SAB = 210; // min (sábado: 3h30)

const func8h = { jornada: '8' };
const func6h = { jornada: '6' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Monta array de registros para um dia.
 * tipos: { entrada, saida_almoco, retorno_almoco, saida } — HH:MM:SS ou HH:MM
 */
function regsDia(data, tipos = {}) {
  const r = [];
  if (tipos.entrada)        r.push({ data, tipo: 'entrada',        hora: tipos.entrada });
  if (tipos.saida_almoco)   r.push({ data, tipo: 'saida_almoco',   hora: tipos.saida_almoco });
  if (tipos.retorno_almoco) r.push({ data, tipo: 'retorno_almoco', hora: tipos.retorno_almoco });
  if (tipos.saida)          r.push({ data, tipo: 'saida',          hora: tipos.saida });
  return r;
}

/** Monta crédito de jornada para um dia. */
function cred(data, minutos) {
  return { data, minutos };
}

// ─── SANIDADE: verificar dias da semana assumidos ─────────────────────────────

test('SANIDADE — 2026-09-05 é sábado', () => {
  expect(new Date(2026, 8, 5).getDay()).toBe(6);
});

test('SANIDADE — 2026-09-06 é domingo', () => {
  expect(new Date(2026, 8, 6).getDay()).toBe(0);
});

test('SANIDADE — 2026-09-01 é dia útil (terça)', () => {
  expect(new Date(2026, 8, 1).getDay()).toBe(2);
});

// ═══════════════════════════════════════════════════════════════════════════════
// A) toMin e calcTotal
// ═══════════════════════════════════════════════════════════════════════════════

describe('toMin', () => {
  test('A-toMin-1 — converte HH:MM corretamente', () => {
    expect(toMin('08:00')).toBe(480);
    expect(toMin('12:30')).toBe(750);
    expect(toMin('00:00')).toBe(0);
    expect(toMin('23:59')).toBe(1439);
  });

  test('A-toMin-2 — ignora segundos (fatiamento implícito em calcBancoMes)', () => {
    // toMin recebe apenas a fatia HH:MM; segundos não participam
    expect(toMin('08:00')).toBe(toMin('08:00:45'));
  });

  test('A-toMin-3 — retorna null para valor falsy', () => {
    expect(toMin(null)).toBeNull();
    expect(toMin('')).toBeNull();
    expect(toMin(undefined)).toBeNull();
  });
});

describe('calcTotal', () => {
  test('A-1 — entrada + saída sem almoço', () => {
    // 08:00 → 17:00 = 9h = 540 min
    expect(calcTotal('08:00', null, null, '17:00')).toBe(540);
  });

  test('A-2 — jornada completa com almoço', () => {
    // 08:00 → 17:00 = 540; almoço 12:00–13:00 = 60 → 480 (8h)
    expect(calcTotal('08:00', '12:00', '13:00', '17:00')).toBe(480);
  });

  test('A-3 — almoço de 1 hora exata', () => {
    expect(calcTotal('08:00', '12:00', '13:00', '17:00')).toBe(480);
  });

  test('A-4 — almoço de 30 minutos', () => {
    // 08:00 → 17:00 = 540; almoço 12:00–12:30 = 30 → 510
    expect(calcTotal('08:00', '12:00', '12:30', '17:00')).toBe(510);
  });

  test('A-5 — almoço parcial: só saida_almoco (sem retorno) — COMPORTAMENTO ATUAL: sem desconto', () => {
    // if (sa && ra) → falso → almoço NÃO é descontado mesmo com sa preenchido
    // NOTA: pode ser bug de regra de negócio — infla total trabalhado
    const total = calcTotal('08:00', '12:00', null, '17:00');
    expect(total).toBe(540); // retorna 9h, não 8h
  });

  test('A-6 — almoço parcial: só retorno_almoco (sem saída almoço) — COMPORTAMENTO ATUAL: sem desconto', () => {
    // if (sa && ra) → falso → almoço NÃO é descontado
    const total = calcTotal('08:00', null, '13:00', '17:00');
    expect(total).toBe(540); // retorna 9h, não 8h
  });

  test('A-7 — sem entrada retorna null', () => {
    expect(calcTotal(null, null, null, '17:00')).toBeNull();
    expect(calcTotal(undefined, null, null, '17:00')).toBeNull();
    expect(calcTotal('', null, null, '17:00')).toBeNull();
  });

  test('A-8 — sem saída retorna null', () => {
    expect(calcTotal('08:00', null, null, null)).toBeNull();
    expect(calcTotal('08:00', '12:00', '13:00', null)).toBeNull();
  });

  test('A-9 — todos null retorna null', () => {
    expect(calcTotal(null, null, null, null)).toBeNull();
  });

  test('A-10 — virada de meia-noite produz total negativo (comportamento atual — sem suporte a turno noturno)', () => {
    // 23:00 → 07:00 (dia seguinte): implementação não detecta virada
    // toMin('07:00') - toMin('23:00') = 420 - 1380 = -960
    // NOTA: bug de regra de negócio — o sistema não suporta jornada noturna cruzando meia-noite
    const total = calcTotal('23:00', null, null, '07:00');
    expect(total).toBe(-960);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B) Jornada normal (calcBancoMes — 1 dia útil)
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — jornada normal', () => {
  test('B-1 — jornada 8h, trabalhou exatamente 8h → saldo zero', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(480);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(0);
    expect(r.diasTrab).toBe(1);
  });

  test('B-2 — jornada 6h, trabalhou exatamente 6h → saldo zero', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida: '14:00' }); // sem almoço
    const r = calcBancoMes(func6h, regs, [], MES, TER);
    expect(r.trabMin).toBe(360);
    expect(r.esperMin).toBe(360);
    expect(r.saldo).toBe(0);
  });

  test('B-3 — trabalhou acima da jornada (hora extra) → saldo positivo', () => {
    // 08:00 → 18:00 sem almoço = 600 min; jornada 8h = 480
    const regs = regsDia(TER, { entrada: '08:00', saida: '18:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(600);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(120); // +2h
  });

  test('B-4 — trabalhou abaixo da jornada → saldo negativo', () => {
    // 08:00 → 15:00 sem almoço = 420 min; jornada 8h = 480
    const regs = regsDia(TER, { entrada: '08:00', saida: '15:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(420);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(-60); // -1h
  });

  test('B-5 — múltiplos dias acumulam trabMin corretamente', () => {
    // TER e QUA — 8h exatas cada dia
    const regs = [
      ...regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
      ...regsDia(QUA, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
    ];
    const r = calcBancoMes(func8h, regs, [], MES, QUA);
    expect(r.trabMin).toBe(960);  // 2 × 480
    expect(r.esperMin).toBe(960);
    expect(r.saldo).toBe(0);
    expect(r.diasTrab).toBe(2);
  });

  test('B-6 — saldo acumula corretamente entre dias positivos e negativos', () => {
    // TER: +2h (hora extra), QUA: -1h (saiu cedo)
    const regs = [
      ...regsDia(TER, { entrada: '08:00', saida: '18:00' }),        // 600 trab
      ...regsDia(QUA, { entrada: '08:00', saida: '15:00' }),        // 420 trab
    ];
    const r = calcBancoMes(func8h, regs, [], MES, QUA);
    expect(r.trabMin).toBe(1020);  // 600 + 420
    expect(r.esperMin).toBe(960);  // 480 + 480
    expect(r.saldo).toBe(60);     // +1h líquido
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C) Sábado
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — sábado', () => {
  test('C-1 — jornada esperada no sábado é 210 min (3h30)', () => {
    // Falta no sábado: esperMin deve crescer exatamente 210
    const r = calcBancoMes(func8h, [], [], MES, SAB);
    // Dias 09-01..09-04 = 4 dias úteis faltas (4×480), 09-05 = sábado falta (210)
    expect(r.esperMin).toBe(4 * 480 + 210);
  });

  test('C-2 — trabalhou exatamente 3h30 no sábado → saldo zero do dia', () => {
    // 08:30 → 12:00 = 210 min = exatamente a jornada do sábado
    const regs = regsDia(SAB, { entrada: '08:30', saida: '12:00' });
    const r       = calcBancoMes(func8h, regs, [], MES, SAB);
    const rSemSab = calcBancoMes(func8h, [],   [], MES, SAB);
    // NOTA: esperMin é idêntico nos dois casos — tanto ponto completo quanto falta
    // adicionam jornadaDia a esperMin. O que muda é trabMin.
    expect(r.trabMin  - rSemSab.trabMin).toBe(210);   // sábado contribuiu 210 trab
    expect(r.esperMin - rSemSab.esperMin).toBe(0);    // esperMin não muda entre os cenários
    expect(r.saldo    - rSemSab.saldo).toBe(210);     // melhora de saldo vs falta no sábado
  });

  test('C-3 — trabalhou mais de 3h30 no sábado → saldo positivo para o dia', () => {
    // 08:00 → 12:00 = 240 min > 210
    const regs = regsDia(SAB, { entrada: '08:00', saida: '12:00' });
    const rComSab = calcBancoMes(func8h, regs, [], MES, SAB);
    const rSemSab = calcBancoMes(func8h, [],   [], MES, SAB);
    // trabMin melhorou 240; esperMin igual nos dois cenários
    expect(rComSab.trabMin - rSemSab.trabMin).toBe(240);
    expect(rComSab.esperMin - rSemSab.esperMin).toBe(0);
    // Melhora de saldo = 240; o dia em si ficou +30 (240 trab − 210 esper)
    expect(rComSab.saldo - rSemSab.saldo).toBe(240);
  });

  test('C-4 — trabalhou menos de 3h30 no sábado → saldo negativo para o dia', () => {
    // 09:00 → 12:00 = 180 min < 210
    const regs = regsDia(SAB, { entrada: '09:00', saida: '12:00' });
    const rComSab = calcBancoMes(func8h, regs, [], MES, SAB);
    const rSemSab = calcBancoMes(func8h, [],   [], MES, SAB);
    expect(rComSab.trabMin - rSemSab.trabMin).toBe(180);
    expect(rComSab.esperMin - rSemSab.esperMin).toBe(0);
    // Melhora vs falta = +180; o dia em si ficou -30 (180 − 210)
    expect(rComSab.saldo - rSemSab.saldo).toBe(180);
  });

  test('C-5 — sábado com falta: esperMin cresce 210, trabMin não', () => {
    // Apenas dias até sábado sem registros
    const rSex = calcBancoMes(func8h, [], [], MES, SEX); // hojeStr = sexta
    const rSab = calcBancoMes(func8h, [], [], MES, SAB); // hojeStr = sábado
    // A diferença é exatamente o sábado sem registro
    expect(rSab.trabMin - rSex.trabMin).toBe(0);     // sábado não trabalhou
    expect(rSab.esperMin - rSex.esperMin).toBe(210); // esperMin cresceu 210
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D) Domingo
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — domingo', () => {
  test('D-1 — domingo não gera jornada esperada (não é falta)', () => {
    const rSab = calcBancoMes(func8h, [], [], MES, SAB); // até sábado
    const rDom = calcBancoMes(func8h, [], [], MES, DOM); // até domingo
    // Adicionar domingo não deve mudar esperMin nem trabMin
    expect(rDom.trabMin).toBe(rSab.trabMin);
    expect(rDom.esperMin).toBe(rSab.esperMin);
    expect(rDom.saldo).toBe(rSab.saldo);
  });

  test('D-2 — registros em domingo são ignorados pelo engine', () => {
    const semDom = calcBancoMes(func8h, [], [], MES, DOM);
    // Adicionar registros de ponto completo no domingo
    const comDom = calcBancoMes(func8h,
      regsDia(DOM, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
      [], MES, DOM
    );
    // Resultados devem ser idênticos
    expect(comDom.trabMin).toBe(semDom.trabMin);
    expect(comDom.esperMin).toBe(semDom.esperMin);
    expect(comDom.diasTrab).toBe(semDom.diasTrab);
  });

  test('D-3 — crédito em domingo é ignorado', () => {
    const semCred = calcBancoMes(func8h, [], [], MES, DOM);
    const comCred = calcBancoMes(func8h, [], [cred(DOM, 480)], MES, DOM);
    expect(comCred.trabMin).toBe(semCred.trabMin);
    expect(comCred.esperMin).toBe(semCred.esperMin);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E) Falta injustificada
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — falta injustificada', () => {
  test('E-1 — dia útil sem registro e sem crédito: esperMin cresce, trabMin não', () => {
    // Apenas TER, nenhum registro
    const r = calcBancoMes(func8h, [], [], MES, TER);
    // 09-01 (Ter) = falta → esperMin += 480, trabMin += 0
    // Não há outros dias (hojeStr = TER)
    expect(r.esperMin).toBe(480);
    expect(r.trabMin).toBe(0);
    expect(r.saldo).toBe(-480);
    expect(r.diasTrab).toBe(0);
  });

  test('E-2 — falta no sábado: esperMin cresce 210, trabMin não muda', () => {
    // hojeStr = SAB, só sábado sem registros naquele dia; dias anteriores também sem reg
    // Contribuição isolada do sábado:
    const rSex = calcBancoMes(func8h, [], [], MES, SEX);
    const rSab = calcBancoMes(func8h, [], [], MES, SAB);
    expect(rSab.esperMin - rSex.esperMin).toBe(210);
    expect(rSab.trabMin).toBe(0);
    expect(rSab.saldo).toBe(-(4 * 480 + 210)); // 4 dias úteis + sábado
  });

  test('E-3 — múltiplas faltas acumulam saldo negativo corretamente', () => {
    // TER, QUA, QUI sem registros → -3 × 480
    const r = calcBancoMes(func8h, [], [], MES, QUI);
    expect(r.esperMin).toBe(3 * 480);
    expect(r.trabMin).toBe(0);
    expect(r.saldo).toBe(-3 * 480);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F) Ponto incompleto
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — ponto incompleto', () => {
  test('F-1 — só entrada: dia fica PENDENTE, não contribui para trab/esper', () => {
    const regs = regsDia(TER, { entrada: '08:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias).toHaveLength(1);
    expect(r.pendencias[0]).toEqual({ data: TER, tipo: 'PONTO_INCOMPLETO' });
    // Nem trabMin nem esperMin crescem pelo dia incompleto
    expect(r.esperMin).toBe(0);
    expect(r.trabMin).toBe(0);
  });

  test('F-2 — entrada + saida_almoco (sem retorno e sem saída): PENDENTE', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias).toHaveLength(1);
    expect(r.esperMin).toBe(0);
    expect(r.trabMin).toBe(0);
  });

  test('F-3 — entrada + saida_almoco + retorno_almoco (sem saída final): PENDENTE', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias).toHaveLength(1);
    expect(r.trabMin).toBe(0);
  });

  test('F-4 — ponto incompleto não gera saldo negativo (dia fica suspenso)', () => {
    const regs = regsDia(TER, { entrada: '08:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    // Diferente de falta: falta gera -480; incompleto gera 0 neste acumulado
    expect(r.saldo).toBe(0);
  });

  test('F-5 — múltiplos dias: incompleto e completo convivem corretamente', () => {
    // TER: incompleto (só entrada); QUA: completo 8h
    const regs = [
      ...regsDia(TER, { entrada: '08:00' }),
      ...regsDia(QUA, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
    ];
    const r = calcBancoMes(func8h, regs, [], MES, QUA);
    expect(r.pendencias).toHaveLength(1);
    expect(r.pendencias[0].data).toBe(TER);
    expect(r.trabMin).toBe(480);   // só o dia completo (QUA)
    expect(r.esperMin).toBe(480);  // só o dia completo conta
    expect(r.saldo).toBe(0);
    expect(r.diasTrab).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G) Créditos de jornada
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — créditos de jornada', () => {
  test('G-1 — crédito de jornada completa (feriado/atestado): saldo neutro', () => {
    // Dia sem ponto mas com crédito igual à jornada → saldo 0
    const r = calcBancoMes(func8h, [], [cred(TER, 480)], MES, TER);
    // trabMin += 480, esperMin += 480 → saldo = 0
    expect(r.trabMin).toBe(480);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(0);
    expect(r.diasTrab).toBe(1); // crédito > 0 conta como dia trabalhado
  });

  test('G-2 — crédito de atestado médico (jornada completa) = feriado', () => {
    // Mesmo comportamento: 480 minutos de crédito
    const r = calcBancoMes(func8h, [], [cred(TER, 480)], MES, TER);
    expect(r.saldo).toBe(0);
  });

  test('G-3 — crédito de férias (minutos = jornada do dia)', () => {
    // Férias: crédito com minutos = jornada dia → saldo 0
    const r = calcBancoMes(func8h, [], [cred(TER, JORNADA_8H)], MES, TER);
    expect(r.saldo).toBe(0);
    expect(r.trabMin).toBe(JORNADA_8H);
  });

  test('G-4 — crédito parcial (ex: meio-dia de atestado): saldo negativo', () => {
    // Crédito de 240 min para jornada de 480 → saldo -240
    const r = calcBancoMes(func8h, [], [cred(TER, 240)], MES, TER);
    expect(r.trabMin).toBe(240);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(-240);
    expect(r.diasTrab).toBe(1); // crédito > 0 conta como dia trabalhado
  });

  test('G-5 — crédito não gera double-count quando também há ponto completo', () => {
    // Ponto prevalece sobre crédito: ambos no mesmo dia → ponto é usado
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const creditos = [cred(TER, 480)];
    const r = calcBancoMes(func8h, regs, creditos, MES, TER);
    // Com ponto completo, o crédito é ignorado (branch `if (diaRegs)`)
    expect(r.trabMin).toBe(480);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(0);
  });

  test('G-6 — crédito em sábado usa jornada do sábado (210 min)', () => {
    // No sábado, jornadaDia = 210. Crédito 210 → saldo 0
    const r = calcBancoMes(func8h, [], [cred(SAB, 210)], MES, SAB);
    // Dias 09-01..09-04 = faltas; 09-05 sábado com crédito
    const rSemSab = calcBancoMes(func8h, [], [], MES, SEX);
    const deltaTrab  = r.trabMin  - rSemSab.trabMin;
    const deltaEsper = r.esperMin - rSemSab.esperMin;
    expect(deltaTrab).toBe(210);
    expect(deltaEsper).toBe(210); // jornadaDia = JORNADA_SAB = 210
  });

  test('G-7 — diasTrab não aumenta com crédito de 0 minutos (folga comp)', () => {
    const r = calcBancoMes(func8h, [], [cred(TER, 0)], MES, TER);
    expect(r.diasTrab).toBe(0); // crédito 0 não conta como dia trabalhado
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H) Folga compensatória — COMPORTAMENTO ATUAL documentado
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — folga compensatória', () => {
  // COMPORTAMENTO ATUAL: folga comp tem minutos=0 → trabMin não cresce,
  // esperMin cresce pela jornada do dia → saldo fica negativo.
  // Isso é o DESIGN INTENCIONAL: folga comp debita do banco de horas acumulado.

  test('H-1 — minutos=0: trabMin não cresce', () => {
    const r = calcBancoMes(func8h, [], [cred(TER, 0)], MES, TER);
    const rFalta = calcBancoMes(func8h, [], [], MES, TER);
    // Com crédito 0, trabMin = 0 (igual à falta)
    expect(r.trabMin).toBe(rFalta.trabMin);
  });

  test('H-2 — esperMin cresce pela jornada do dia (480)', () => {
    const r = calcBancoMes(func8h, [], [cred(TER, 0)], MES, TER);
    expect(r.esperMin).toBe(480);
  });

  test('H-3 — saldo = -jornadaDia (débito do banco de horas)', () => {
    const r = calcBancoMes(func8h, [], [cred(TER, 0)], MES, TER);
    expect(r.saldo).toBe(-480);
    // NOTA: este comportamento INTENCIONAL permite que folga compensatória
    // "consuma" o banco de horas positivo acumulado anteriormente.
  });

  test('H-4 — folga comp em sábado debita 210 min do banco', () => {
    const r = calcBancoMes(func8h, [], [cred(SAB, 0)], MES, SAB);
    const rSemCred = calcBancoMes(func8h, [], [], MES, SAB);
    // Crédito 0 em sábado vs falta em sábado: resultado idêntico
    // (ambos: trabMin += 0, esperMin += 210)
    expect(r.trabMin).toBe(rSemCred.trabMin);
    expect(r.esperMin).toBe(rSemCred.esperMin);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// I) Home Office
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — Home Office', () => {
  // Home Office não tem tratamento especial no engine de cálculo.
  // A fonte de verdade é o ponto — igual a presencial.
  // A exclusão de crédito_jornada para HO está em ponto.html, não aqui.

  test('I-1 — HO com ponto completo = mesmo comportamento que presencial', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(480);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(0);
  });

  test('I-2 — HO com hora extra = saldo positivo como qualquer dia', () => {
    // 08:00 → 18:30 sem almoço = 630 min
    const regs = regsDia(TER, { entrada: '08:00', saida: '18:30' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(630);
    expect(r.saldo).toBe(630 - 480); // +150 min = +2h30
  });

  test('I-3 — HO sem crédito especial: apenas ponto conta', () => {
    // Confirma que não há dupla-contagem se por engano um crédito de HO for lançado
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const credHO = [cred(TER, 480)]; // não deveria existir, mas se existir...
    const r = calcBancoMes(func8h, regs, credHO, MES, TER);
    // Ponto prevalece; crédito é ignorado pelo branch `if (diaRegs)`
    expect(r.trabMin).toBe(480);
    expect(r.saldo).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// J) Múltiplos dias — cenário combinado
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — múltiplos dias combinados', () => {
  // Semana de 09-01 (Ter) a 09-07 (Seg)
  // TER: completo 8h exatas         → trab=480, esper=480
  // QUA: hora extra (+2h)           → trab=600, esper=480
  // QUI: falta injustificada        → trab=0,   esper=480
  // SEX: ponto incompleto (s/saída) → PENDENTE (0/0)
  // SAB: crédito feriado (210)      → trab=210, esper=210
  // DOM: ignorado                   → 0/0
  // SEG: ponto 6h30 (sem almoço)    → trab=390, esper=480

  const regsSeq = [
    ...regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
    ...regsDia(QUA, { entrada: '08:00', saida: '18:00' }), // 600 min
    // QUI: sem registros (falta)
    ...regsDia(SEX, { entrada: '08:00' }), // incompleto
    // SAB: crédito via creditos array
    ...regsDia(DOM, { entrada: '08:00', saida: '17:00' }), // domingo — deve ser ignorado
    ...regsDia(SEG, { entrada: '08:00', saida: '14:30' }), // 6h30 = 390 min
  ];
  const credSeq = [cred(SAB, 210)];

  test('J-1 — trabMin total acumula corretamente', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    // 480 (TER) + 600 (QUA) + 0 (QUI-falta) + 0 (SEX-incompleto) + 210 (SAB-cred) + 0 (DOM) + 390 (SEG)
    expect(r.trabMin).toBe(480 + 600 + 0 + 0 + 210 + 0 + 390); // 1680
  });

  test('J-2 — esperMin total acumula corretamente', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    // 480(TER) + 480(QUA) + 480(QUI-falta) + 0(SEX-incompleto) + 210(SAB-cred) + 0(DOM) + 480(SEG)
    expect(r.esperMin).toBe(480 + 480 + 480 + 0 + 210 + 0 + 480); // 2130
  });

  test('J-3 — saldo final combinado', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    expect(r.saldo).toBe(1680 - 2130); // -450 min = -7h30
  });

  test('J-4 — diasTrab conta apenas dias com ponto completo ou crédito > 0', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    // TER (completo), QUA (completo), SAB (crédito 210>0), SEG (completo) = 4
    expect(r.diasTrab).toBe(4);
  });

  test('J-5 — pendências contém apenas o dia incompleto', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    expect(r.pendencias).toHaveLength(1);
    expect(r.pendencias[0]).toEqual({ data: SEX, tipo: 'PONTO_INCOMPLETO' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// K) Limites de data
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcBancoMes — limites de data', () => {
  test('K-1 — dia futuro não entra no cálculo', () => {
    // hojeStr = TER; registros em QUA (dia seguinte) devem ser ignorados
    const regs = regsDia(QUA, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    // QUA é futuro → ignorado; TER sem registro → falta
    expect(r.trabMin).toBe(0);
    expect(r.esperMin).toBe(480); // só TER conta como falta
  });

  test('K-2 — hojeStr exato (dia de hoje entra)', () => {
    // hojeStr = TER; registro em TER deve ser processado
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(480);
    expect(r.diasTrab).toBe(1);
  });

  test('K-3 — primeiro dia do mês é processado', () => {
    // TER = 2026-09-01 = primeiro dia do mês
    const regs = regsDia(TER, { entrada: '08:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(540); // 9h sem almoço
  });

  test('K-4 — crédito de dia futuro não entra', () => {
    // hojeStr = TER; crédito em QUA
    const credFuturo = [cred(QUA, 480)];
    const r = calcBancoMes(func8h, [], credFuturo, MES, TER);
    // QUA é futuro → crédito ignorado; TER falta
    expect(r.trabMin).toBe(0);
    expect(r.esperMin).toBe(480);
  });

  test('K-5 — último dia do mês é processado (setembro tem 30 dias)', () => {
    const ULT = '2026-09-30'; // quarta-feira
    const regs = regsDia(ULT, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, ULT);
    // Todos os dias do mês até ULT são processados; só ULT tem registro
    // Restante = faltas/sábados sem registro
    expect(r.trabMin).toBeGreaterThan(0);
    expect(r.diasTrab).toBeGreaterThanOrEqual(1);
  });

  test('K-6 — mês com apenas 1 dia útil: calcula corretamente', () => {
    // Usar apenas o TER como único dia no range
    const r = calcBancoMes(func8h, [], [], MES, TER);
    // Resultado = falta em TER
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(-480);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Extra) buildDiasFromRegistros — lógica de precedência
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildDiasFromRegistros', () => {
  test('BR-1 — organiza registros por data e tipo corretamente', () => {
    const regs = [
      { data: TER, tipo: 'entrada',   hora: '08:00:00' },
      { data: TER, tipo: 'saida',     hora: '17:00:00' },
    ];
    const dias = buildDiasFromRegistros(regs);
    expect(dias[TER].entrada).toBe('08:00:00');
    expect(dias[TER].saida).toBe('17:00:00');
  });

  test('BR-2 — sem lancadoPorJustificativa: primeiro registro prevalece', () => {
    const regs = [
      { data: TER, tipo: 'entrada', hora: '08:00:00' },
      { data: TER, tipo: 'entrada', hora: '09:00:00' }, // duplicata
    ];
    const dias = buildDiasFromRegistros(regs);
    expect(dias[TER].entrada).toBe('08:00:00');
  });

  test('BR-3 — lancadoPorJustificativa: justificativa aprovada sobrescreve', () => {
    const regs = [
      { data: TER, tipo: 'entrada', hora: '08:00:00' },
      { data: TER, tipo: 'entrada', hora: '09:00:00', lancadoPorJustificativa: true },
    ];
    const dias = buildDiasFromRegistros(regs);
    expect(dias[TER].entrada).toBe('09:00:00'); // justificativa prevalece
  });

  test('BR-4 — registros de datas diferentes ficam separados', () => {
    const regs = [
      { data: TER, tipo: 'entrada', hora: '08:00:00' },
      { data: QUA, tipo: 'entrada', hora: '08:30:00' },
    ];
    const dias = buildDiasFromRegistros(regs);
    expect(dias[TER].entrada).toBe('08:00:00');
    expect(dias[QUA].entrada).toBe('08:30:00');
    expect(Object.keys(dias)).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Extra) getJornadaPrevista e jornadaParaData
// ═══════════════════════════════════════════════════════════════════════════════

describe('getJornadaPrevista', () => {
  test('GP-1 — dia útil retorna jornada × 60', () => {
    expect(getJornadaPrevista(func8h, TER)).toBe(480);
    expect(getJornadaPrevista(func6h, TER)).toBe(360);
  });

  test('GP-2 — sábado retorna 210 independente da jornada do funcionário', () => {
    expect(getJornadaPrevista(func8h, SAB)).toBe(210);
    expect(getJornadaPrevista(func6h, SAB)).toBe(210);
  });

  test('GP-3 — domingo retorna 0', () => {
    expect(getJornadaPrevista(func8h, DOM)).toBe(0);
    expect(getJornadaPrevista(func6h, DOM)).toBe(0);
  });

  test('GP-4 — jornada ausente usa default 8h', () => {
    expect(getJornadaPrevista({}, TER)).toBe(480);
    expect(getJornadaPrevista({ jornada: '' }, TER)).toBe(480);
  });
});

describe('fmtMin', () => {
  test('FM-1 — formata minutos positivos', () => {
    expect(fmtMin(480)).toBe('8h00');
    expect(fmtMin(90)).toBe('1h30');
    expect(fmtMin(0)).toBe('0h00');
  });

  test('FM-2 — formata minutos negativos com sinal de menos', () => {
    expect(fmtMin(-60)).toBe('-1h00');
    expect(fmtMin(-90)).toBe('-1h30');
  });

  test('FM-3 — null/undefined retorna "—"', () => {
    expect(fmtMin(null)).toBe('—');
    expect(fmtMin(undefined)).toBe('—');
  });
});
