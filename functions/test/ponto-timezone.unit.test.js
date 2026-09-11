'use strict';

/**
 * Testes de timezone para hoje() e mesAtual() do ponto.html (Etapa 2).
 * Replica a lógica exata das funções corrigidas usando Intl.DateTimeFormat
 * com timeZone:'America/Fortaleza'.
 */

// Implementação exata de hoje() corrigida (copiada de ponto.html Etapa 2)
function hoje(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Implementação exata de mesAtual() corrigida (copiada de ponto.html Etapa 2)
function mesAtual(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza',
    year: 'numeric', month: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}

// ── hoje() ────────────────────────────────────────────────────────────────────

test('TZ-01 hoje() antes da meia-noite UTC (23:59Z = 20:59 Fortaleza) → dia anterior ao UTC', () => {
  // UTC 2026-09-10T23:59Z → Fortaleza ainda é 2026-09-10
  expect(hoje(new Date('2026-09-10T23:59:00Z'))).toBe('2026-09-10');
});

test('TZ-02 hoje() na virada UTC (00:01Z = 21:01 Fortaleza do dia anterior)', () => {
  // UTC 2026-09-11T00:01Z → Fortaleza ainda é 2026-09-10 (UTC-3)
  expect(hoje(new Date('2026-09-11T00:01:00Z'))).toBe('2026-09-10');
});

test('TZ-03 hoje() às 03:00Z = meia-noite exata em Fortaleza → novo dia', () => {
  // UTC 2026-09-11T03:00Z = 2026-09-11 00:00 Fortaleza
  expect(hoje(new Date('2026-09-11T03:00:00Z'))).toBe('2026-09-11');
});

test('TZ-04 hoje() às 02:59Z = 23:59 Fortaleza → ainda dia anterior', () => {
  // UTC 2026-09-11T02:59Z = 2026-09-10 23:59 Fortaleza
  expect(hoje(new Date('2026-09-11T02:59:00Z'))).toBe('2026-09-10');
});

test('TZ-05 hoje() não usa toISOString() — resultado difere do UTC em período de risco', () => {
  // UTC-bugado: às 01:00Z, toISOString() daria 2026-09-11, Fortaleza correto é 2026-09-10
  const nowUTC = new Date('2026-09-11T01:00:00Z');
  const utcBugado = nowUTC.toISOString().slice(0, 10); // bug: '2026-09-11'
  const correto   = hoje(nowUTC);                      // fix: '2026-09-10'
  expect(utcBugado).toBe('2026-09-11');
  expect(correto).toBe('2026-09-10');
  expect(correto).not.toBe(utcBugado);
});

test('TZ-06 hoje() sem DST — fuso sempre UTC-3 em verão e inverno', () => {
  // Fevereiro (inverno brasileiro): UTC-3 fixo
  expect(hoje(new Date('2026-02-15T02:59:00Z'))).toBe('2026-02-14'); // ainda dia 14
  expect(hoje(new Date('2026-02-15T03:00:00Z'))).toBe('2026-02-15'); // vira dia 15
  // Dezembro (verão): UTC-3 fixo (Fortaleza não adota DST)
  expect(hoje(new Date('2026-12-15T02:59:00Z'))).toBe('2026-12-14');
  expect(hoje(new Date('2026-12-15T03:00:00Z'))).toBe('2026-12-15');
});

test('TZ-07 hoje() na virada de mês: 31→01 (meia-noite Fortaleza = 03:00 UTC)', () => {
  // UTC-3: 03:00 UTC = 00:00 Fortaleza; 02:59 UTC = 23:59 do dia ANTERIOR em Fortaleza
  // 2026-09-01T02:59Z → Fortaleza: 2026-08-31 23:59 → ainda agosto
  expect(hoje(new Date('2026-09-01T02:59:00Z'))).toBe('2026-08-31');
  // 2026-09-01T03:00Z → Fortaleza: 2026-09-01 00:00 → já setembro
  expect(hoje(new Date('2026-09-01T03:00:00Z'))).toBe('2026-09-01');
});

test('TZ-08 hoje() na virada de ano: 31/12→01/01 (meia-noite Fortaleza = 03:00 UTC)', () => {
  // 2026-01-01T02:59Z → Fortaleza: 2025-12-31 23:59 → ainda dezembro de 2025
  expect(hoje(new Date('2026-01-01T02:59:00Z'))).toBe('2025-12-31');
  // 2026-01-01T03:00Z → Fortaleza: 2026-01-01 00:00 → já janeiro de 2026
  expect(hoje(new Date('2026-01-01T03:00:00Z'))).toBe('2026-01-01');
});

// ── mesAtual() ────────────────────────────────────────────────────────────────

test('TZ-09 mesAtual() usa Fortaleza — virada de mês na meia-noite Fortaleza', () => {
  // 2026-09-01T02:59Z → Fortaleza ainda é agosto (2026-08-31 23:59)
  expect(mesAtual(new Date('2026-09-01T02:59:00Z'))).toBe('2026-08');
  // 2026-09-01T03:00Z → Fortaleza já é setembro (2026-09-01 00:00)
  expect(mesAtual(new Date('2026-09-01T03:00:00Z'))).toBe('2026-09');
});

test('TZ-10 mesAtual() virada de ano: dezembro→janeiro', () => {
  // 2026-01-01T02:59Z → Fortaleza ainda é 2025-12
  expect(mesAtual(new Date('2026-01-01T02:59:00Z'))).toBe('2025-12');
  // 2026-01-01T03:00Z → Fortaleza já é 2026-01
  expect(mesAtual(new Date('2026-01-01T03:00:00Z'))).toBe('2026-01');
});

test('TZ-11 mesAtual() formato YYYY-MM', () => {
  const result = mesAtual(new Date('2026-09-15T12:00:00Z'));
  expect(result).toMatch(/^\d{4}-\d{2}$/);
});

test('TZ-12 hoje() formato YYYY-MM-DD', () => {
  const result = hoje(new Date('2026-09-15T12:00:00Z'));
  expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
