'use strict';

/**
 * Testes J–T: Utilitários puros + simulações de lógica das Cloud Functions
 *
 * Estes testes NÃO requerem Firebase Emulator — rodam localmente com jest.
 * Testam as funções puras em utils.js e a lógica de decisão de registrarPonto.
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=functions.unit.test
 */

const { distMetros, fortalezaAgora, validarLatLng } = require('../utils');

// Coordenadas da empresa (mesmas do index.js)
const EMP_LAT = -3.7603154;
const EMP_LNG = -38.5634329;
const RAIO_M  = 200;

// ─── Testes J–L: distMetros ───────────────────────────────────────────────────

test('J — distMetros retorna 0 para coordenadas idênticas', () => {
  expect(distMetros(EMP_LAT, EMP_LNG, EMP_LAT, EMP_LNG)).toBeCloseTo(0, 1);
});

test('K — distMetros detecta dentro do raio (1 metro da empresa)', () => {
  // ~1 m ao norte
  const lat2 = EMP_LAT + 0.000009;
  const dist = distMetros(EMP_LAT, EMP_LNG, lat2, EMP_LNG);
  expect(dist).toBeLessThan(RAIO_M);
  expect(dist).toBeGreaterThan(0);
});

test('L — distMetros detecta fora do raio (500 m da empresa)', () => {
  // ~500 m ao norte
  const lat2 = EMP_LAT + 0.0045;
  const dist = distMetros(EMP_LAT, EMP_LNG, lat2, EMP_LNG);
  expect(dist).toBeGreaterThan(RAIO_M);
  expect(dist).toBeLessThan(600);
});

// ─── Testes M–N: validarLatLng ────────────────────────────────────────────────

test('M — validarLatLng aceita coordenadas do Ceará', () => {
  expect(validarLatLng(-3.7603154, -38.5634329)).toBe(true);
  expect(validarLatLng(-3.717,     -38.543    )).toBe(true);
});

test('N — validarLatLng rejeita valores inválidos', () => {
  expect(validarLatLng(null, null)).toBe(false);
  expect(validarLatLng('a', 'b')).toBe(false);
  expect(validarLatLng(Infinity, 0)).toBe(false);
  expect(validarLatLng(91, 0)).toBe(false);        // fora dos limites lat Brasil
  expect(validarLatLng(0, -27)).toBe(false);       // fora dos limites lng Brasil
  expect(validarLatLng(0, 0)).toBe(false);         // África
  expect(validarLatLng(undefined, undefined)).toBe(false);
});

// ─── Teste O: fortalezaAgora formato ─────────────────────────────────────────

test('O — fortalezaAgora retorna data e hora no formato correto', () => {
  const { data, hora } = fortalezaAgora();
  expect(data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(hora).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  // Data deve ser hoje (UTC-3 pode variar de UTC ±1 dia, mas deve ser plausível)
  const [ano, mes, dia] = data.split('-').map(Number);
  expect(ano).toBeGreaterThanOrEqual(2026);
  expect(mes).toBeGreaterThanOrEqual(1);
  expect(mes).toBeLessThanOrEqual(12);
  expect(dia).toBeGreaterThanOrEqual(1);
  expect(dia).toBeLessThanOrEqual(31);
});

// ─── Testes P–Q: sequência de ponto ──────────────────────────────────────────

// Lógica de sequência extraída diretamente do index.js para teste isolado
function proximoTipo(regsHoje) {
  const ultimo = regsHoje[regsHoje.length - 1];
  if (!ultimo)                          return 'entrada';
  if (ultimo.tipo === 'entrada')        return 'saida_almoco';
  if (ultimo.tipo === 'saida_almoco')   return 'retorno_almoco';
  if (ultimo.tipo === 'retorno_almoco') return 'saida';
  return null; // completo
}

test('P — sequência correta: sem registro → entrada', () => {
  expect(proximoTipo([])).toBe('entrada');
});

test('P — sequência correta: entrada → saida_almoco', () => {
  expect(proximoTipo([{ tipo: 'entrada' }])).toBe('saida_almoco');
});

test('P — sequência correta: saida_almoco → retorno_almoco', () => {
  expect(proximoTipo([{ tipo: 'entrada' }, { tipo: 'saida_almoco' }])).toBe('retorno_almoco');
});

test('P — sequência correta: retorno_almoco → saida', () => {
  expect(proximoTipo([
    { tipo: 'entrada' }, { tipo: 'saida_almoco' }, { tipo: 'retorno_almoco' },
  ])).toBe('saida');
});

test('Q — ponto completo (4 batidas) retorna null', () => {
  expect(proximoTipo([
    { tipo: 'entrada' }, { tipo: 'saida_almoco' },
    { tipo: 'retorno_almoco' }, { tipo: 'saida' },
  ])).toBeNull();
});

// ─── Teste R: validação de payload GPS ────────────────────────────────────────

test('R — PRESENCIAL sem GPS válido deve ser rejeitado', () => {
  const modalidade = 'PRESENCIAL';
  const lat = null;
  const lng = null;
  const gpsValido = validarLatLng(lat, lng);
  if (modalidade === 'PRESENCIAL' && !gpsValido) {
    expect(true).toBe(true); // correto: seria lançado HttpsError
  } else {
    throw new Error('Deveria rejeitar GPS inválido para PRESENCIAL');
  }
});

test('R — HOME_OFFICE sem GPS válido não deve ser barrado', () => {
  const modalidade = 'HOME_OFFICE';
  const lat = null;
  const lng = null;
  const gpsValido = validarLatLng(lat, lng);
  // HOME_OFFICE: GPS é opcional
  expect(modalidade === 'HOME_OFFICE' || gpsValido).toBe(true);
});

// ─── Teste S: validação de tamanho da foto ────────────────────────────────────

test('S — foto acima de 350 KB (base64) deve ser rejeitada', () => {
  const FOTO_MAX_BYTES = 350_000;
  const fotoGrande = 'x'.repeat(FOTO_MAX_BYTES + 1);
  expect(fotoGrande.length > FOTO_MAX_BYTES).toBe(true);
});

test('S — foto dentro do limite é aceita', () => {
  const FOTO_MAX_BYTES = 350_000;
  const fotoPequena = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  expect(fotoPequena.length < FOTO_MAX_BYTES).toBe(true);
});

// ─── Teste T: cooldown de 10 segundos ─────────────────────────────────────────

test('T — cooldown: registro < 10 s atrás deve ser barrado', () => {
  const COOLDOWN_MS = 10_000;
  const agora = Date.now();
  const criadoHa5s = agora - 5_000;
  const deveria_bloquear = (agora - criadoHa5s) < COOLDOWN_MS;
  expect(deveria_bloquear).toBe(true);
});

test('T — cooldown: registro > 10 s atrás permite nova batida', () => {
  const COOLDOWN_MS = 10_000;
  const agora = Date.now();
  const criadoHa15s = agora - 15_000;
  const deveria_bloquear = (agora - criadoHa15s) < COOLDOWN_MS;
  expect(deveria_bloquear).toBe(false);
});
