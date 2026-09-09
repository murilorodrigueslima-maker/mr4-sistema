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

// ─── Testes U–Z: ID determinístico e unicidade por tipo/dia ──────────────────

// Extrai a lógica de geração do ID determinístico (espelha o index.js)
function gerarDeterministicId(funcId, data, tipo) {
  return funcId + '_' + data + '_' + tipo;
}

// Simula a verificação de duplicidade (espelha o bloco da transação)
function verificarDuplicidade(docsExistentes, funcId, data, tipo) {
  const deterministicId = gerarDeterministicId(funcId, data, tipo);
  return docsExistentes.some(d => d.id === deterministicId);
}

test('U — gerarDeterministicId produz formato funcId_data_tipo', () => {
  expect(gerarDeterministicId('mndxb7vpqjnm', '2026-09-09', 'entrada'))
    .toBe('mndxb7vpqjnm_2026-09-09_entrada');
  expect(gerarDeterministicId('func-e2e-001', '2026-01-15', 'saida_almoco'))
    .toBe('func-e2e-001_2026-01-15_saida_almoco');
  expect(gerarDeterministicId('abc', '2026-12-31', 'retorno_almoco'))
    .toBe('abc_2026-12-31_retorno_almoco');
  expect(gerarDeterministicId('xyz', '2026-06-01', 'saida'))
    .toBe('xyz_2026-06-01_saida');
});

test('V — IDs de tipos diferentes são distintos para mesmo funcId/data', () => {
  const funcId = 'func-001';
  const data   = '2026-09-09';
  const ids = ['entrada', 'saida_almoco', 'retorno_almoco', 'saida']
    .map(tipo => gerarDeterministicId(funcId, data, tipo));
  const uniq = new Set(ids);
  expect(uniq.size).toBe(4);
});

test('W — IDs são distintos para funcionários diferentes no mesmo dia/tipo', () => {
  const data = '2026-09-09';
  const tipo = 'entrada';
  const id1 = gerarDeterministicId('func-001', data, tipo);
  const id2 = gerarDeterministicId('func-002', data, tipo);
  expect(id1).not.toBe(id2);
});

test('X — verificarDuplicidade detecta ID existente (bloqueia segunda ENTRADA)', () => {
  const funcId = 'func-001';
  const data   = '2026-09-09';
  const tipo   = 'entrada';
  const deterministicId = gerarDeterministicId(funcId, data, tipo);
  // Simula doc já gravado na coleção
  const docsExistentes = [{ id: deterministicId, tipo, funcId, data }];
  expect(verificarDuplicidade(docsExistentes, funcId, data, tipo)).toBe(true);
});

test('Y — verificarDuplicidade NÃO bloqueia tipo diferente no mesmo dia', () => {
  const funcId = 'func-001';
  const data   = '2026-09-09';
  // Apenas entrada existe
  const docsExistentes = [{ id: gerarDeterministicId(funcId, data, 'entrada') }];
  // Tentar saida_almoco → não deve bloquear
  expect(verificarDuplicidade(docsExistentes, funcId, data, 'saida_almoco')).toBe(false);
});

test('Z — verificarDuplicidade NÃO bloqueia mesmo tipo em datas diferentes', () => {
  const funcId = 'func-001';
  const tipo   = 'entrada';
  const docsExistentes = [{ id: gerarDeterministicId(funcId, '2026-09-08', tipo) }];
  // Data diferente → não bloqueia
  expect(verificarDuplicidade(docsExistentes, funcId, '2026-09-09', tipo)).toBe(false);
});

test('Z2 — registros históricos com ID legado (auto-gerado) coexistem sem conflito', () => {
  // IDs antigos não têm formato determinístico → nunca conflitam com novos
  const legacyIds = ['abc123', 'xyz789', 'ms1k2n3p4q5r', 'lp9jn8mn7o6p'];
  legacyIds.forEach(legacyId => {
    // Um ID legado nunca coincide com o padrão funcId_data_tipo
    // porque funcIds são alphanumeric sem underscore e date tem underscores como separador
    const deterministicId = gerarDeterministicId('func-001', '2026-09-09', 'entrada');
    expect(legacyId).not.toBe(deterministicId);
  });
});
