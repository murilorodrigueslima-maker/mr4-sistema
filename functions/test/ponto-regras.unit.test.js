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

/** Monta crédito de jornada com motivo (para testes de férias, feriado, folga, atestado). */
function credMot(data, minutos, motivo) {
  return { data, minutos, motivo };
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
  test('A-1 — entrada + saída sem almoço e intervalo > 6h: null (DEC-1 almoço obrigatório)', () => {
    // tS−tE = 540 > 360 e almoço ausente → PENDENTE (NOVA REGRA DEC-1)
    expect(calcTotal('08:00', null, null, '17:00')).toBeNull();
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

  test('A-5 — almoço parcial: só saida_almoco sem retorno (>6h): null (DEC-1)', () => {
    // tS−tE=540>360 e ra ausente → almoço incompleto → PENDENTE (NOVA REGRA DEC-1)
    const total = calcTotal('08:00', '12:00', null, '17:00');
    expect(total).toBeNull();
  });

  test('A-6 — almoço parcial: só retorno_almoco sem saída_almoco (>6h): null (DEC-1)', () => {
    // tS−tE=540>360 e sa ausente → almoço incompleto → PENDENTE (NOVA REGRA DEC-1)
    const total = calcTotal('08:00', null, '13:00', '17:00');
    expect(total).toBeNull();
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

  test('A-10 — virada de meia-noite retorna null (DEC-12)', () => {
    // saída(07:00) < entrada(23:00) → cruzamento de meia-noite → PENDENTE (NOVA REGRA DEC-12)
    const total = calcTotal('23:00', null, null, '07:00');
    expect(total).toBeNull();
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

  test('B-3 — trabalhou acima da jornada com almoço (hora extra) → saldo positivo', () => {
    // 08:00 → 18:00 com almoço 12:00–13:00 = 9h líquido; jornada 8h = saldo +1h
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '18:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(540); // 10h−1h almoço = 9h
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(60); // +1h
  });

  test('B-4 — trabalhou abaixo da jornada (≤6h, sem almoço válido) → saldo negativo', () => {
    // 08:00 → 14:00 sem almoço = 6h; tS−tE=360 ≤ 360 → almoço não obrigatório
    const regs = regsDia(TER, { entrada: '08:00', saida: '14:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(360);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(-120); // -2h
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
    // TER: +1h (hora extra com almoço), QUA: -2h (saiu cedo, ≤6h)
    const regs = [
      ...regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '18:00' }), // 540 trab
      ...regsDia(QUA, { entrada: '08:00', saida: '14:00' }), // 360 trab (6h, ≤360 → sem almoço obrigatório)
    ];
    const r = calcBancoMes(func8h, regs, [], MES, QUA);
    expect(r.trabMin).toBe(900);   // 540 + 360
    expect(r.esperMin).toBe(960);  // 480 + 480
    expect(r.saldo).toBe(-60);     // -1h líquido
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

  test('D-2 — domingo com ponto completo contribui para saldo positivo (DEC-7 NOVA REGRA)', () => {
    // NOVA REGRA DEC-7: domingo com ponto → jornadaDia=0, saldo = +t (todo trabalho positivo)
    const semDom = calcBancoMes(func8h, [], [], MES, DOM);
    const comDom = calcBancoMes(func8h,
      regsDia(DOM, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
      [], MES, DOM
    );
    // t = 540−60 = 480; jornadaDia = 0 → saldo delta = +480
    expect(comDom.trabMin - semDom.trabMin).toBe(480);
    expect(comDom.esperMin - semDom.esperMin).toBe(0); // jornadaDia=0
    expect(comDom.saldo - semDom.saldo).toBe(480);
    expect(comDom.diasTrab - semDom.diasTrab).toBe(1);
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

  test('I-2 — HO com hora extra e almoço = saldo positivo', () => {
    // 08:00 → 18:30 com almoço 1h = 9h30 líquido; tS−tE>360 → almoço obrigatório (DEC-1)
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '18:30' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(570); // 10h30−1h = 9h30 = 570 min
    expect(r.saldo).toBe(570 - 480); // +90 min = +1h30
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
  // Semana de 09-01 (Ter) a 09-07 (Seg) — todos os pontos respeitam DEC-1 (almoço quando >6h)
  // TER: completo 8h c/ almoço       → trab=480, esper=480
  // QUA: hora extra +1h c/ almoço   → trab=540, esper=480
  // QUI: falta injustificada         → trab=0,   esper=480
  // SEX: ponto incompleto (s/saída)  → PENDENTE (0/0)
  // SAB: crédito abono (210)         → trab=210, esper=210
  // DOM: ponto 8h c/ almoço (DEC-7) → trab=480, esper=0 (jornadaDia=0)
  // SEG: ponto 6h (≤360, sem almoço) → trab=360, esper=480

  const regsSeq = [
    ...regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }),
    ...regsDia(QUA, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '18:00' }), // 9h c/ almoço
    // QUI: sem registros (falta)
    ...regsDia(SEX, { entrada: '08:00' }), // incompleto
    // SAB: crédito via creditos array
    ...regsDia(DOM, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' }), // domingo c/ ponto
    ...regsDia(SEG, { entrada: '08:00', saida: '14:00' }), // 6h (360 ≤ 360 → sem almoço obrigatório)
  ];
  const credSeq = [cred(SAB, 210)];

  test('J-1 — trabMin total acumula corretamente', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    // 480(TER) + 540(QUA) + 0(QUI-falta) + 0(SEX-pendente) + 210(SAB-cred) + 480(DOM) + 360(SEG)
    expect(r.trabMin).toBe(480 + 540 + 0 + 0 + 210 + 480 + 360); // 2070
  });

  test('J-2 — esperMin total acumula corretamente', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    // 480(TER) + 480(QUA) + 480(QUI-falta) + 0(SEX-pendente) + 210(SAB) + 0(DOM,jornada=0) + 480(SEG)
    expect(r.esperMin).toBe(480 + 480 + 480 + 0 + 210 + 0 + 480); // 2130
  });

  test('J-3 — saldo final combinado', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    expect(r.saldo).toBe(2070 - 2130); // -60 min = -1h
  });

  test('J-4 — diasTrab conta dias com ponto completo ou crédito > 0', () => {
    const r = calcBancoMes(func8h, regsSeq, credSeq, MES, SEG);
    // TER(1) + QUA(1) + SAB-cred(1) + DOM(1) + SEG(1) = 5
    expect(r.diasTrab).toBe(5);
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
    // TER = 2026-09-01 = primeiro dia do mês; com almoço para respeitar DEC-1
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.trabMin).toBe(480); // 8h com almoço
    expect(r.diasTrab).toBe(1);
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

// ═══════════════════════════════════════════════════════════════════════════════
// ETAPA 3 — Testes para as 14 Decisões de Negócio Aprovadas
// ═══════════════════════════════════════════════════════════════════════════════

// ─── getTipoCredito ────────────────────────────────────────────────────────────
// NOVA FUNÇÃO — ainda não existe em ponto-regras.js; todos estes testes falharão
// até a implementação da ETAPA B.

describe('getTipoCredito — classificação de créditos', () => {
  test('TipoCredito-1 — Férias retorna "ferias"', () => {
    expect(ctx.getTipoCredito('Férias')).toBe('ferias');
  });

  test('TipoCredito-2 — Feriado nacional retorna "feriado"', () => {
    expect(ctx.getTipoCredito('Feriado nacional')).toBe('feriado');
  });

  test('TipoCredito-3 — Feriado estadual retorna "feriado"', () => {
    expect(ctx.getTipoCredito('Feriado estadual')).toBe('feriado');
  });

  test('TipoCredito-4 — Feriado municipal retorna "feriado"', () => {
    expect(ctx.getTipoCredito('Feriado municipal')).toBe('feriado');
  });

  test('TipoCredito-5 — Folga compensatória retorna "folga_comp"', () => {
    expect(ctx.getTipoCredito('Folga compensatória')).toBe('folga_comp');
  });

  test('TipoCredito-6 — undefined/null retorna "abono"', () => {
    expect(ctx.getTipoCredito(undefined)).toBe('abono');
    expect(ctx.getTipoCredito(null)).toBe('abono');
  });

  test('TipoCredito-7 — outros motivos (atestado, licença, falta justificada) retornam "abono"', () => {
    expect(ctx.getTipoCredito('Atestado médico')).toBe('abono');
    expect(ctx.getTipoCredito('Licença maternidade')).toBe('abono');
    expect(ctx.getTipoCredito('Falta justificada')).toBe('abono');
  });
});

// ─── DEC-1: Almoço obrigatório ─────────────────────────────────────────────────
// Regra: se (saída − entrada) > 360 E (sa ou ra ausentes) → calcTotal retorna null
// Sábado (210 min) e jornada 6h (360 min) são isentos.

describe('DEC-1 — Almoço obrigatório', () => {
  test('DEC-1-1 — sábado (tS−tE=210, ≤360): sem almoço é válido', () => {
    expect(calcTotal('08:00', null, null, '11:30')).toBe(210);
  });

  test('DEC-1-2 — jornada 6h (tS−tE=360, exatamente ≤360): sem almoço é válido', () => {
    expect(calcTotal('08:00', null, null, '14:00')).toBe(360);
  });

  test('DEC-1-3 — jornada 8h com almoço completo: válido (540−60=480)', () => {
    expect(calcTotal('08:00', '12:00', '13:00', '17:00')).toBe(480);
  });

  test('DEC-1-4 — jornada 8h SEM almoço (tS−tE=540>360, !sa !ra): PENDENTE → null', () => {
    // NOVA REGRA: atualmente retorna 540; deve retornar null após implementação
    expect(calcTotal('08:00', null, null, '17:00')).toBeNull();
  });

  test('DEC-1-5 — só saida_almoco sem retorno (tS−tE>360): PENDENTE → null', () => {
    // NOVA REGRA: atualmente retorna 540; deve retornar null após implementação
    expect(calcTotal('08:00', '12:00', null, '17:00')).toBeNull();
  });

  test('DEC-1-6 — só retorno_almoco sem saída_almoco (tS−tE>360): PENDENTE → null', () => {
    // NOVA REGRA: atualmente retorna 540; deve retornar null após implementação
    expect(calcTotal('08:00', null, '13:00', '17:00')).toBeNull();
  });

  test('DEC-1-7 — calcBancoMes: dia útil sem almoço (8h) gera PONTO_INCOMPLETO', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias.some(p => p.data === TER && p.tipo === 'PONTO_INCOMPLETO')).toBe(true);
  });
});

// ─── DEC-11: Sequência inválida de horários ────────────────────────────────────
// Regra: quando todos os 4 campos presentes, exige entrada<sa<ra<saída.
// Sequência violada → null.

describe('DEC-11 — Sequência inválida de horários', () => {
  test('DEC-11-1 — sa > ra (almoço invertido): null', () => {
    // NOVA REGRA: sa=13:00 > ra=12:00 → inválido → null
    expect(calcTotal('08:00', '13:00', '12:00', '17:00')).toBeNull();
  });

  test('DEC-11-2 — sa < entrada: null', () => {
    // NOVA REGRA: sa=07:00 < entrada=08:00 → inválido → null
    expect(calcTotal('08:00', '07:00', '13:00', '17:00')).toBeNull();
  });

  test('DEC-11-3 — ra > saída: null', () => {
    // NOVA REGRA: ra=18:00 > saída=17:00 → inválido → null
    expect(calcTotal('08:00', '12:00', '18:00', '17:00')).toBeNull();
  });

  test('DEC-11-4 — sequência válida não é afetada', () => {
    expect(calcTotal('08:00', '12:00', '13:00', '17:00')).toBe(480);
  });

  test('DEC-11-5 — saida_almoco == retorno_almoco (almoço de 0 min): null', () => {
    // sa=ra → sequência violada (sa não é estritamente menor que ra)
    expect(calcTotal('08:00', '12:00', '12:00', '17:00')).toBeNull();
  });
});

// ─── DEC-12: Cruzamento de meia-noite ─────────────────────────────────────────
// Regra: se saída < entrada → PENDENTE (null). Turno noturno não suportado.

describe('DEC-12 — Cruzamento de meia-noite', () => {
  test('DEC-12-1 — saída < entrada (virada de dia): calcTotal retorna null', () => {
    // NOVA REGRA: atualmente retorna -960 (bug documentado em A-10); deve retornar null
    expect(calcTotal('23:00', null, null, '07:00')).toBeNull();
  });

  test('DEC-12-2 — calcBancoMes: ponto com meia-noite gera PONTO_INCOMPLETO', () => {
    const regs = regsDia(TER, { entrada: '23:00', saida: '07:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias.some(p => p.data === TER && p.tipo === 'PONTO_INCOMPLETO')).toBe(true);
  });
});

// ─── DEC-7: Domingo trabalhado ─────────────────────────────────────────────────
// Regra: domingo sem ponto → saldo=0 (ignorado). Domingo com ponto → esperMin=0,
// todas horas trabalhadas = saldo positivo. Domingo com ponto incompleto → PENDENTE.

describe('DEC-7 — Domingo trabalhado', () => {
  test('DEC-7-1 — domingo sem ponto não altera trabMin/esperMin/saldo vs sábado', () => {
    // calcBancoMes até SAB vs até DOM: DOM sem ponto não deve mudar nada
    const rSab = calcBancoMes(func8h, [], [], MES, SAB);
    const rDom = calcBancoMes(func8h, [], [], MES, DOM);
    expect(rDom.trabMin).toBe(rSab.trabMin);
    expect(rDom.esperMin).toBe(rSab.esperMin);
    expect(rDom.saldo).toBe(rSab.saldo);
  });

  test('DEC-7-2 — domingo com ponto completo: delta trabMin=+360, esperMin=0, saldo=+360', () => {
    // NOVA REGRA DEC-7: DOM ponto contribui; jornadaDia=0 → todo trabalho = saldo positivo
    const rSab = calcBancoMes(func8h, [], [], MES, SAB);
    const regs = regsDia(DOM, { entrada: '08:00', saida: '14:00' }); // 6h, tS-tE=360 <= 360
    const rDom = calcBancoMes(func8h, regs, [], MES, DOM);
    expect(rDom.trabMin  - rSab.trabMin).toBe(360);
    expect(rDom.esperMin - rSab.esperMin).toBe(0);
    expect(rDom.saldo    - rSab.saldo).toBe(360);
  });

  test('DEC-7-3 — domingo com ponto incompleto (só entrada): PONTO_INCOMPLETO', () => {
    // NOVA REGRA: domingo incompleto → PENDENTE
    const regs = regsDia(DOM, { entrada: '08:00' });
    const r = calcBancoMes(func8h, regs, [], MES, DOM);
    expect(r.pendencias.some(p => p.data === DOM && p.tipo === 'PONTO_INCOMPLETO')).toBe(true);
  });

  test('DEC-7-4 — domingo com crédito mas sem ponto: crédito ignorado (mesmo total que sem crédito)', () => {
    // Sem ponto em domingo → continue, crédito em DOM não é processado
    const rSemCred = calcBancoMes(func8h, [], [], MES, DOM);
    const rComCred = calcBancoMes(func8h, [], [credMot(DOM, 480, 'Férias')], MES, DOM);
    expect(rComCred.saldo).toBe(rSemCred.saldo);
    expect(rComCred.esperMin).toBe(rSemCred.esperMin);
    expect(rComCred.trabMin).toBe(rSemCred.trabMin);
  });
});

// ─── DEC-8: Feriado trabalhado ─────────────────────────────────────────────────
// Regra: crédito feriado + horas trabalhadas = saldo positivo.
// Sem ponto → saldo=0 (jornada abonada). Com ponto → saldo = t (horas trabalhadas).

describe('DEC-8 — Feriado trabalhado', () => {
  test('DEC-8-1 — feriado sem ponto: saldo=0 (crédito cobre jornada)', () => {
    // Comportamento atual já correto para branch 2 (sem ponto)
    const r = calcBancoMes(func8h, [], [credMot(TER, 480, 'Feriado nacional')], MES, TER);
    expect(r.trabMin).toBe(480);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(0);
  });

  test('DEC-8-2 — feriado com ponto parcial (4h): saldo = +240', () => {
    // NOVA REGRA: trabMin = t(240) + crédito(480) = 720; esperMin=480; saldo=+240
    // Atualmente branch 1 ignora o crédito → saldo = 240−480 = −240
    const regs = regsDia(TER, { entrada: '08:00', saida: '12:00' });
    const r = calcBancoMes(func8h, regs, [credMot(TER, 480, 'Feriado nacional')], MES, TER);
    expect(r.esperMin).toBe(480);
    expect(r.trabMin).toBe(720);
    expect(r.saldo).toBe(240);
  });

  test('DEC-8-3 — feriado com ponto completo 8h (com almoço): saldo = +480', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [credMot(TER, 480, 'Feriado nacional')], MES, TER);
    expect(r.saldo).toBe(480);
  });

  test('DEC-8-4 — feriado estadual e municipal seguem mesma regra', () => {
    const r1 = calcBancoMes(func8h, [], [credMot(TER, 480, 'Feriado estadual')], MES, TER);
    const r2 = calcBancoMes(func8h, [], [credMot(TER, 480, 'Feriado municipal')], MES, TER);
    expect(r1.saldo).toBe(0);
    expect(r2.saldo).toBe(0);
  });
});

// ─── DEC-9: Atestado + ponto ───────────────────────────────────────────────────
// Regra: abono = max(0, jornadaDia − t); trabMin += t + abono; saldo nunca inflado.

describe('DEC-9 — Atestado com ponto (abono = max(0, jornada − trabalhado))', () => {
  test('DEC-9-1 — atestado sem ponto: crédito cobre jornada, saldo=0', () => {
    // Comportamento já correto (branch 2: minutos=480, esperMin=480)
    const r = calcBancoMes(func8h, [], [cred(TER, 480)], MES, TER);
    expect(r.saldo).toBe(0);
  });

  test('DEC-9-2 — atestado com ponto parcial (3h): abono cobre diferença, saldo=0', () => {
    // NOVA REGRA: abono=max(0,480−180)=300; trabMin=480; esperMin=480; saldo=0
    // Atualmente: branch 1 ignora crédito; trabMin=180; saldo=−300
    const regs = regsDia(TER, { entrada: '08:00', saida: '11:00' });
    const r = calcBancoMes(func8h, regs, [cred(TER, 480)], MES, TER);
    expect(r.saldo).toBe(0);
  });

  test('DEC-9-3 — atestado com ponto completo 8h: abono=0, saldo=0', () => {
    // abono=max(0,480−480)=0; trabMin=480; saldo=0
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [cred(TER, 480)], MES, TER);
    expect(r.saldo).toBe(0);
  });

  test('DEC-9-4 — atestado com ponto parcial em dia com crédito maior que jornada: abono não excede diferença', () => {
    // func6h (jornadaDia=360), ponto 4h (240min), crédito 360min
    // abono=max(0,360−240)=120; trabMin=240+120=360; esperMin=360; saldo=0
    const regs = regsDia(TER, { entrada: '08:00', saida: '12:00' }); // 4h, tS−tE=240≤360 → válido sem almoço
    const r = calcBancoMes(func6h, regs, [cred(TER, 360)], MES, TER);
    expect(r.saldo).toBe(0);
  });
});

// ─── DEC-10: Férias ────────────────────────────────────────────────────────────
// Regra: sempre saldo=0 (trabMin=esperMin=jornadaDia), independente de ponto.

describe('DEC-10 — Férias (saldo sempre zero)', () => {
  test('DEC-10-1 — férias dia útil sem ponto: saldo=0', () => {
    const r = calcBancoMes(func8h, [], [credMot(TER, 480, 'Férias')], MES, TER);
    expect(r.trabMin).toBe(480);
    expect(r.esperMin).toBe(480);
    expect(r.saldo).toBe(0);
  });

  test('DEC-10-2 — férias sábado: delta saldo=0 para o dia (neutro)', () => {
    // Delta: saldo(até SAB com férias) − saldo(até SEX) deve ser 0 (férias não debita)
    const rSexta = calcBancoMes(func8h, [], [], MES, SEX);
    const rSabFerias = calcBancoMes(func8h, [], [credMot(SAB, 210, 'Férias')], MES, SAB);
    expect(rSabFerias.saldo - rSexta.saldo).toBe(0);
  });

  test('DEC-10-3 — férias domingo (sem ponto): não altera totais vs sábado', () => {
    // DOM sem ponto: continue; crédito férias em DOM é ignorado
    const rSab = calcBancoMes(func8h, [], [], MES, SAB);
    const rDom = calcBancoMes(func8h, [], [credMot(DOM, 480, 'Férias')], MES, DOM);
    expect(rDom.saldo).toBe(rSab.saldo);
    expect(rDom.esperMin).toBe(rSab.esperMin);
  });

  test('DEC-10-4 — férias com ponto parcial (4h): saldo forçado para 0', () => {
    // NOVA REGRA: mesmo com ponto parcial no dia de férias → saldo=0
    // Atualmente: branch 1 roda (crédito ignorado), saldo=240−480=−240
    const regs = regsDia(TER, { entrada: '08:00', saida: '12:00' }); // 4h sem almoço (≤360, válido)
    const r = calcBancoMes(func8h, regs, [credMot(TER, 480, 'Férias')], MES, TER);
    expect(r.saldo).toBe(0);
  });
});

// ─── DEC-4: Folga compensatória ────────────────────────────────────────────────
// Regra: saque do banco → debita jornadaDia (8h útil, 3h30 sábado).

describe('DEC-4 — Folga compensatória (saldo = −jornadaDia)', () => {
  test('DEC-4-1 — folga comp dia útil: saldo = −480', () => {
    const r = calcBancoMes(func8h, [], [credMot(TER, 0, 'Folga compensatória')], MES, TER);
    expect(r.saldo).toBe(-480);
  });

  test('DEC-4-2 — folga comp sábado debita 210 (delta vs sexta)', () => {
    // Delta: saldo(até SAB com folga) − saldo(até SEX) = −210 (débito do sábado)
    const rSexta = calcBancoMes(func8h, [], [], MES, SEX);
    const rSabFolga = calcBancoMes(func8h, [], [credMot(SAB, 0, 'Folga compensatória')], MES, SAB);
    expect(rSabFolga.saldo - rSexta.saldo).toBe(-210);
  });
});

// ─── DEC-2: Home Office ────────────────────────────────────────────────────────
// Regra: sem crédito automático. Sem ponto → déficit. Ponto incompleto → PENDENTE.
// Ponto completo com almoço → saldo normal.

describe('DEC-2 — Home Office', () => {
  test('DEC-2-1 — HO sem ponto (tratado como falta): saldo = −480', () => {
    // HO não gera crédito (tiposSemCredito); branch "falta" roda → saldo=−jornada
    const r = calcBancoMes(func8h, [], [], MES, TER);
    expect(r.saldo).toBe(-480);
  });

  test('DEC-2-2 — HO com ponto incompleto (só entrada): PONTO_INCOMPLETO', () => {
    const regs = regsDia(TER, { entrada: '08:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias.some(p => p.data === TER && p.tipo === 'PONTO_INCOMPLETO')).toBe(true);
  });

  test('DEC-2-3 — HO com ponto 8h sem almoço: PONTO_INCOMPLETO (regra almoço)', () => {
    // NOVA REGRA: >6h sem almoço → PENDENTE mesmo em Home Office
    const regs = regsDia(TER, { entrada: '08:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.pendencias.some(p => p.data === TER && p.tipo === 'PONTO_INCOMPLETO')).toBe(true);
  });

  test('DEC-2-4 — HO com ponto completo e almoço: saldo normal', () => {
    const regs = regsDia(TER, { entrada: '08:00', saida_almoco: '12:00', retorno_almoco: '13:00', saida: '17:00' });
    const r = calcBancoMes(func8h, regs, [], MES, TER);
    expect(r.saldo).toBe(0);
    expect(r.pendencias).toHaveLength(0);
  });
});

// ─── DEC-14: podeAssinarEspelho ────────────────────────────────────────────────
// NOVA FUNÇÃO — não existe em ponto-regras.js ainda; todos estes testes falharão
// até a implementação da ETAPA B.

describe('DEC-14 — podeAssinarEspelho', () => {
  test('DEC-14-1 — sem pendências nem justificativas pendentes: pode assinar', () => {
    const r = ctx.podeAssinarEspelho([], [], MES);
    expect(r.pode).toBe(true);
    expect(r.motivo).toBeNull();
  });

  test('DEC-14-2 — PONTO_INCOMPLETO no período: não pode assinar', () => {
    const pendencias = [{ data: TER, tipo: 'PONTO_INCOMPLETO' }];
    const r = ctx.podeAssinarEspelho(pendencias, [], MES);
    expect(r.pode).toBe(false);
    expect(r.motivo).toBeTruthy();
  });

  test('DEC-14-3 — justificativa status=pendente no período: não pode assinar', () => {
    const justifs = [{ data: TER, status: 'pendente', funcId: 'f1' }];
    const r = ctx.podeAssinarEspelho([], justifs, MES);
    expect(r.pode).toBe(false);
    expect(r.motivo).toBeTruthy();
  });

  test('DEC-14-4 — justificativa status=aprovada no período: pode assinar', () => {
    const justifs = [{ data: TER, status: 'aprovada', funcId: 'f1' }];
    const r = ctx.podeAssinarEspelho([], justifs, MES);
    expect(r.pode).toBe(true);
  });

  test('DEC-14-5 — justificativa pendente fora do mês avaliado: pode assinar', () => {
    const justifs = [{ data: '2026-08-15', status: 'pendente', funcId: 'f1' }];
    const r = ctx.podeAssinarEspelho([], justifs, MES);
    expect(r.pode).toBe(true);
  });

  test('DEC-14-6 — saldo negativo (sem pendências): não bloqueia assinatura', () => {
    // Saldo negativo não gera pendências — pode assinar
    const r = ctx.podeAssinarEspelho([], [], MES);
    expect(r.pode).toBe(true);
  });

  test('DEC-14-7 — falta resolvida (justif aprovada) não bloqueia', () => {
    const justifs = [{ data: TER, status: 'aprovada', funcId: 'f1' }];
    const r = ctx.podeAssinarEspelho([], justifs, MES);
    expect(r.pode).toBe(true);
  });
});
