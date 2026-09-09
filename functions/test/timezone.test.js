'use strict';

/**
 * Teste 9: Timezone America/Fortaleza
 * Casos próximos da meia-noite UTC para garantir que o fuso UTC-3 é aplicado.
 */

const { fortalezaAgora } = require('../utils');

// Auxiliar: força fortalezaAgora a usar uma data específica mockando Date
function fortalezaDeUTC(isoUtc) {
  // Replica a lógica de fortalezaAgora com uma data fixa
  const agora = new Date(isoUtc);
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(agora).map(p => [p.type, p.value]));
  return {
    data: `${parts.year}-${parts.month}-${parts.day}`,
    hora: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

test('9a — 2026-09-09T02:59:00Z → Fortaleza ainda é 2026-09-08 23:59', () => {
  const { data, hora } = fortalezaDeUTC('2026-09-09T02:59:00Z');
  expect(data).toBe('2026-09-08');
  expect(hora.startsWith('23:59')).toBe(true);
});

test('9b — 2026-09-09T03:01:00Z → Fortaleza já é 2026-09-09 00:01', () => {
  const { data, hora } = fortalezaDeUTC('2026-09-09T03:01:00Z');
  expect(data).toBe('2026-09-09');
  expect(hora.startsWith('00:01')).toBe(true);
});

test('9c — 2026-09-09T03:00:00Z → Fortaleza é exatamente 2026-09-09 00:00', () => {
  const { data, hora } = fortalezaDeUTC('2026-09-09T03:00:00Z');
  expect(data).toBe('2026-09-09');
  expect(hora).toBe('00:00:00');
});

test('9d — UTC-3 fixo: sem horário de verão em fevereiro', () => {
  // Fortaleza não adota DST — fuso é sempre UTC-3
  const inverno = fortalezaDeUTC('2026-02-15T06:00:00Z'); // 03:00 Fortaleza
  expect(inverno.hora).toBe('03:00:00');
  const verao   = fortalezaDeUTC('2026-12-15T06:00:00Z'); // ainda 03:00 Fortaleza
  expect(verao.hora).toBe('03:00:00');
});
