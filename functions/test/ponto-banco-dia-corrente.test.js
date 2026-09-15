'use strict';

/**
 * DIA1–DIA27 — Solução 2: hojeParaBanco via calcTotal()
 *
 * Garante que renderBanco() use o dia correto (hoje vs ontem) para o cálculo
 * do Banco de Horas do mês atual, conforme:
 *   - Se calcTotal(e, sa, ra, s) === null → hojeParaBanco = ontem()
 *   - Se calcTotal(e, sa, ra, s) !== null → hojeParaBanco = hoje()
 *   - Meses históricos (não-atual) → regra não se aplica (usa hojeStr passado diretamente)
 *
 * Todos os testes são unitários puros (sem DOM, sem Firebase, sem emulador).
 * calcTotal e calcBancoMes são importados de ponto-regras.js.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const src = fs.readFileSync(
  path.resolve(__dirname, '../../modulos/ponto-regras.js'),
  'utf8'
);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { calcTotal, calcBancoMes } = ctx;

// ─── Helpers (replicam lógica de ponto.html) ─────────────────────────────────

/** Replica ontem() de ponto.html: subtrai 1 dia de uma data YYYY-MM-DD. */
function ontemDe(hojeStr) {
  const [y, m, d] = hojeStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Replica calcTotal de ponto-regras.js (importado). */
// calcTotal é importado diretamente do módulo.

/**
 * Replica a lógica de renderBanco() para determinar hojeParaBanco de um func.
 * hojeStr: "hoje" simulado. ehMesAtual: se true aplica a regra.
 * regsHoje: registros do dia de hoje desse funcionário.
 */
function computeHojeParaBanco(hojeStr, ehMesAtual, regsHoje) {
  if (!ehMesAtual) return hojeStr;
  const ontemStr = ontemDe(hojeStr);
  const eH  = (regsHoje.find(r => r.tipo === 'entrada'        && r.lancadoPorJustificativa) || regsHoje.find(r => r.tipo === 'entrada'))?.hora?.slice(0, 5);
  const saH = (regsHoje.find(r => r.tipo === 'saida_almoco'   && r.lancadoPorJustificativa) || regsHoje.find(r => r.tipo === 'saida_almoco'))?.hora?.slice(0, 5);
  const raH = (regsHoje.find(r => r.tipo === 'retorno_almoco' && r.lancadoPorJustificativa) || regsHoje.find(r => r.tipo === 'retorno_almoco'))?.hora?.slice(0, 5);
  const sH  = (regsHoje.find(r => r.tipo === 'saida'          && r.lancadoPorJustificativa) || regsHoje.find(r => r.tipo === 'saida'))?.hora?.slice(0, 5);
  return calcTotal(eH, saH, raH, sH) === null ? ontemStr : hojeStr;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HOJE = '2026-09-15'; // segunda-feira
const ONTEM = '2026-09-14'; // domingo

const funcBase = {
  id: 'fAdemir',
  nome: 'Ademir Lopes Furtado',
  jornada: '8',
  controleBancoHoras: true,
  inicioBancoHoras: '2026-09-01',
  afastamentoBanco: null,
};

function reg(tipo, hora, lancadoPorJustificativa = false) {
  return { funcId: 'fAdemir', data: HOJE, tipo, hora, lancadoPorJustificativa };
}

// ─── DIA1–DIA5: ontem() — virada de dia, mês e ano ───────────────────────────

describe('DIA1-DIA5 — ontemDe(): viradas de dia, mês e ano', () => {
  test('DIA1 — dia normal: 2026-09-15 → 2026-09-14', () => {
    expect(ontemDe('2026-09-15')).toBe('2026-09-14');
  });

  test('DIA2 — virada de mês: 2026-09-01 → 2026-08-31', () => {
    expect(ontemDe('2026-09-01')).toBe('2026-08-31');
  });

  test('DIA3 — virada de mês: 2026-03-01 → 2026-02-28 (não-bissexto)', () => {
    expect(ontemDe('2026-03-01')).toBe('2026-02-28');
  });

  test('DIA4 — virada de mês: 2028-03-01 → 2028-02-29 (bissexto)', () => {
    expect(ontemDe('2028-03-01')).toBe('2028-02-29');
  });

  test('DIA5 — virada de ano: 2027-01-01 → 2026-12-31', () => {
    expect(ontemDe('2027-01-01')).toBe('2026-12-31');
  });
});

// ─── DIA6–DIA10: calcTotal() — retornos null vs não-null ─────────────────────

describe('DIA6-DIA10 — calcTotal(): null vs não-null para hojeParaBanco', () => {
  test('DIA6 — sem registros: calcTotal retorna null', () => {
    expect(calcTotal(undefined, undefined, undefined, undefined)).toBeNull();
  });

  test('DIA7 — só entrada: calcTotal retorna null', () => {
    expect(calcTotal('08:00', undefined, undefined, undefined)).toBeNull();
  });

  test('DIA8 — entrada + saída sem almoço (≤6h): calcTotal retorna não-null', () => {
    // DEC-1: almoço só obrigatório quando intervalo > 360 min; 08:00→14:00 = 360 min → ok
    expect(calcTotal('08:00', undefined, undefined, '14:00')).not.toBeNull();
  });

  test('DIA9 — entrada + saída_almoco + retorno + saída: calcTotal retorna não-null', () => {
    expect(calcTotal('08:00', '12:00', '13:00', '17:00')).not.toBeNull();
  });

  test('DIA10 — sequência inválida (saída antes de entrada): calcTotal retorna null', () => {
    // Entrada 17:00, Saída 08:00 → inválido
    expect(calcTotal('17:00', undefined, undefined, '08:00')).toBeNull();
  });
});

// ─── DIA11–DIA15: computeHojeParaBanco sem registros ─────────────────────────

describe('DIA11-DIA15 — hojeParaBanco: sem ponto hoje → usa ontem', () => {
  test('DIA11 — sem registros hoje → hojeParaBanco = ontem', () => {
    const resultado = computeHojeParaBanco(HOJE, true, []);
    expect(resultado).toBe(ONTEM);
  });

  test('DIA12 — apenas registro de entrada hoje → hojeParaBanco = ontem', () => {
    const regs = [reg('entrada', '08:00:00')];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(ONTEM);
  });

  test('DIA13 — só saída_almoco (sem entrada): calcTotal null → hojeParaBanco = ontem', () => {
    const regs = [reg('saida_almoco', '12:00:00')];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(ONTEM);
  });

  test('DIA14 — sequência inválida (saída antes de entrada): calcTotal null → hojeParaBanco = ontem', () => {
    const regs = [reg('entrada', '17:00:00'), reg('saida', '08:00:00')];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(ONTEM);
  });

  test('DIA15 — só saída (sem entrada): calcTotal null → hojeParaBanco = ontem', () => {
    const regs = [reg('saida', '17:00:00')];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(ONTEM);
  });
});

// ─── DIA16–DIA20: computeHojeParaBanco com ponto completo ────────────────────

describe('DIA16-DIA20 — hojeParaBanco: ponto completo hoje → usa hoje', () => {
  test('DIA16 — entrada + saída ≤6h (sem almoço): calcTotal não-null → hojeParaBanco = hoje', () => {
    // 08:00→12:00 = 240 min ≤ 360 → DEC-1 não se aplica → não-null
    const regs = [reg('entrada', '08:00:00'), reg('saida', '12:00:00')];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(HOJE);
  });

  test('DIA17 — jornada completa com almoço: calcTotal não-null → hojeParaBanco = hoje', () => {
    const regs = [
      reg('entrada', '08:00:00'),
      reg('saida_almoco', '12:00:00'),
      reg('retorno_almoco', '13:00:00'),
      reg('saida', '17:00:00'),
    ];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(HOJE);
  });

  test('DIA18 — sábado com entrada + saída parcial (jornada reduzida): calcTotal não-null → hoje', () => {
    // Sábado: 08:30 a 12:00 (sem almoço) — calcTotal retorna 210 min
    const regs = [reg('entrada', '08:30:00'), reg('saida', '12:00:00')];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(HOJE);
  });

  test('DIA19 — registro lancadoPorJustificativa priorizado: calcTotal não-null → hoje', () => {
    // eH vem da justificativa (08:00), sH da saída (12:00): intervalo 4h ≤ 6h → não-null
    const regs = [
      reg('entrada', '09:00:00', false),              // normal (ignorada: justificativa tem prioridade)
      reg('entrada', '08:00:00', true),               // justificativa (prioridade) → eH='08:00'
      reg('saida', '12:00:00', false),                // sH='12:00' → 4h ≤ 6h → DEC-1 não se aplica
    ];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(HOJE);
  });

  test('DIA20 — registro lancadoPorJustificativa com sequência válida: calcTotal não-null → hoje', () => {
    const regs = [
      reg('entrada', '08:00:00', true),
      reg('saida_almoco', '12:00:00', true),
      reg('retorno_almoco', '13:00:00', false),
      reg('saida', '17:00:00', true),
    ];
    const resultado = computeHojeParaBanco(HOJE, true, regs);
    expect(resultado).toBe(HOJE);
  });
});

// ─── DIA21–DIA23: mês histórico — regra não se aplica ────────────────────────

describe('DIA21-DIA23 — mês histórico: ehMesAtual=false → sempre usa hojeStr', () => {
  test('DIA21 — sem registros hoje e ehMesAtual=false → retorna hojeStr (não ontem)', () => {
    const resultado = computeHojeParaBanco(HOJE, false, []);
    expect(resultado).toBe(HOJE);
  });

  test('DIA22 — registros incompletos e ehMesAtual=false → retorna hojeStr', () => {
    const regs = [reg('entrada', '08:00:00')];
    const resultado = computeHojeParaBanco(HOJE, false, regs);
    expect(resultado).toBe(HOJE);
  });

  test('DIA23 — mês passado (agosto): hojeStr passado como parâmetro → retorna hojeStr intacto', () => {
    // Simula _mesFiltro='2026-08' != mesAtual → ehMesAtual=false
    const hojeAgosto = '2026-08-31';
    const resultado = computeHojeParaBanco(hojeAgosto, false, []);
    expect(resultado).toBe(hojeAgosto);
  });
});

// ─── DIA24–DIA27: integração com calcBancoMes ────────────────────────────────

describe('DIA24-DIA27 — integração: hojeParaBanco altera saldo corretamente', () => {
  // Funcionário com inicioBancoHoras em 2026-09-01
  // Hoje = 2026-09-15 (segunda-feira), Ontem = 2026-09-14 (domingo)
  // Registros do mês: só dia 15 (hoje)

  const funcIntegracao = {
    id: 'fInt',
    nome: 'Teste Integração',
    jornada: '8',
    controleBancoHoras: true,
    inicioBancoHoras: '2026-09-01',
    afastamentoBanco: null,
  };

  function regInt(tipo, hora, lancadoPorJustificativa = false) {
    return { funcId: 'fInt', data: HOJE, tipo, hora, lancadoPorJustificativa };
  }

  test('DIA24 — sem ponto hoje: hojeParaBanco=ontem (domingo) → dia 14 ignored (domingo), saldo inclui dia 15 como falta', () => {
    // hojeParaBanco = ontem = 2026-09-14 (domingo)
    // calcBancoMes com hojeStr=2026-09-14: dias úteis 1-14
    //   - dia 14 é domingo → ignored
    //   - dias 1-12 (5 dias úteis: seg a sex) e 13 (sábado) → sem ponto = faltas
    // Com hojeStr=ontem, dia 15 (segunda) está no futuro → não conta como falta
    const regsDoMes = [];
    const credDoMes = [];
    const hojeParaBanco = computeHojeParaBanco(HOJE, true, []);
    expect(hojeParaBanco).toBe(ONTEM); // confirma que usa ontem
    const { saldo: saldoOntem } = calcBancoMes(funcIntegracao, regsDoMes, credDoMes, '2026-09', ONTEM);
    const { saldo: saldoHoje }  = calcBancoMes(funcIntegracao, regsDoMes, credDoMes, '2026-09', HOJE);
    // Com hojeStr=ontem, dia 15 não entra → saldoOntem > saldoHoje (menos faltas)
    expect(saldoOntem).toBeGreaterThan(saldoHoje);
  });

  test('DIA25 — ponto completo hoje (com almoço): hojeParaBanco=hoje → dia 15 entra no banco', () => {
    // Jornada completa com almoço: calcTotal retorna não-null → hojeParaBanco = hoje
    const regs = [
      regInt('entrada', '08:00:00'),
      regInt('saida_almoco', '12:00:00'),
      regInt('retorno_almoco', '13:00:00'),
      regInt('saida', '17:00:00'),
    ];
    const hojeParaBanco = computeHojeParaBanco(HOJE, true, regs);
    expect(hojeParaBanco).toBe(HOJE);
    const { trabMin } = calcBancoMes(funcIntegracao, regs, [], '2026-09', HOJE);
    expect(trabMin).toBeGreaterThan(0);
  });

  test('DIA26 — só entrada (jornada em andamento): hojeParaBanco=ontem → saldo de ontem', () => {
    const regs = [regInt('entrada', '08:00:00')];
    const hojeParaBanco = computeHojeParaBanco(HOJE, true, regs);
    expect(hojeParaBanco).toBe(ONTEM);
    // Com hojeStr=ontem: mesmos dias que DIA24 (saldo idêntico)
    const { saldo: saldoOntem } = calcBancoMes(funcIntegracao, [], [], '2026-09', ONTEM);
    const { saldo } = calcBancoMes(funcIntegracao, regs, [], '2026-09', hojeParaBanco);
    expect(saldo).toBe(saldoOntem);
  });

  test('DIA27 — lancadoPorJustificativa completa saída hoje: hojeParaBanco=hoje', () => {
    // Sem batida real de saída, justificativa preenche o conjunto; intervalo ≤6h para DEC-1 não bloquear
    const regs = [
      regInt('entrada', '08:00:00', false),
      regInt('saida', '12:00:00', true),  // justificativa: 08:00→12:00 = 4h → não-null
    ];
    const hojeParaBanco = computeHojeParaBanco(HOJE, true, regs);
    expect(hojeParaBanco).toBe(HOJE);
    const { trabMin } = calcBancoMes(funcIntegracao, regs, [], '2026-09', HOJE);
    expect(trabMin).toBeGreaterThan(0);
  });
});
