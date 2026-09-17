'use strict';

/**
 * RECORR360-01 → RECORR360-09
 * Testa o motor de Recorrência V1 (recorrencia.js).
 *
 * Invariantes:
 *   - NUNCA_COMPROU → padrao=null, posicaoAtual=null
 *   - SEM_BASE → 1 compra, sem intervalo calculável
 *   - DENTRO_DO_PADRAO → diasSemComprar < alerta
 *   - PROXIMO_DA_JANELA → diasSemComprar >= 85% da média
 *   - ATRASADO_VS_HISTORICO → diasSemComprar >= 110% da média
 *   - limites corretos calculados a partir de FATOR_ALERTA / FATOR_ATRASO
 *   - determinismo garantido
 */

const {
  calcularRecorrencia,
  FATOR_ALERTA,
  FATOR_ATRASO,
  VERSAO_MOTOR,
} = require('../lib/recorrencia');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mkPerfil(overrides = {}) {
  return {
    nuncaComprou:           false,
    diasSemComprar:         15,
    ultimaCompraEm:         '2026-09-01',
    pedidosTotal:           10,
    diasEntreComprasMedio:  25,    // média de 25 dias entre compras
    diasEntreComprasMediana: 22,
    ...overrides,
  };
}

// ── RECORR360-01: NUNCA_COMPROU ────────────────────────────────────────────────

test('RECORR360-01: nuncaComprou=true → status NUNCA_COMPROU', () => {
  const r = calcularRecorrencia({
    nuncaComprou: true,
    diasSemComprar: null,
    pedidosTotal: 0,
    diasEntreComprasMedio: null,
    diasEntreComprasMediana: null,
  });
  expect(r.status).toBe('NUNCA_COMPROU');
  expect(r.padrao).toBeNull();
  expect(r.posicaoAtual).toBeNull();
});

// ── RECORR360-02: SEM_BASE — 1 compra, sem intervalo ─────────────────────────

test('RECORR360-02: 1 compra (diasEntreComprasMedio=null) → status SEM_BASE', () => {
  const r = calcularRecorrencia(mkPerfil({
    pedidosTotal:           1,
    diasEntreComprasMedio:  null,
    diasEntreComprasMediana: null,
    diasSemComprar:         30,
  }));
  expect(r.status).toBe('SEM_BASE');
  expect(r.padrao).toBeNull();
  expect(r.posicaoAtual.diasSemComprar).toBe(30);
});

// ── RECORR360-03: DENTRO_DO_PADRAO ───────────────────────────────────────────

test('RECORR360-03: diasSemComprar < alerta → DENTRO_DO_PADRAO', () => {
  // média=25d, limiteAlerta = round(25*0.85) = 21d
  // diasSemComprar=15 < 21 → DENTRO_DO_PADRAO
  const r = calcularRecorrencia(mkPerfil({ diasSemComprar: 15 }));
  expect(r.status).toBe('DENTRO_DO_PADRAO');
  expect(r.padrao).toBeDefined();
  expect(r.padrao.mediaIntervaloDias).toBe(25);
  expect(r.padrao.limiteAlertaDias).toBe(Math.round(25 * FATOR_ALERTA));
  expect(r.padrao.limiteAtrasoDias).toBe(Math.round(25 * FATOR_ATRASO));
});

// ── RECORR360-04: PROXIMO_DA_JANELA ──────────────────────────────────────────

test('RECORR360-04: diasSemComprar >= 85% da média → PROXIMO_DA_JANELA', () => {
  // média=25d, limiteAlerta = round(25*0.85) = 21d, limiteAtraso = round(25*1.10) = 28d
  // diasSemComprar=22 >= 21 e < 28 → PROXIMO_DA_JANELA
  const limiteAlerta = Math.round(25 * FATOR_ALERTA);
  const r = calcularRecorrencia(mkPerfil({ diasSemComprar: limiteAlerta }));
  expect(r.status).toBe('PROXIMO_DA_JANELA');
});

// ── RECORR360-05: ATRASADO_VS_HISTORICO ──────────────────────────────────────

test('RECORR360-05: diasSemComprar >= 110% da média → ATRASADO_VS_HISTORICO', () => {
  // média=25d, limiteAtraso = round(25*1.10) = 28d
  // diasSemComprar=30 >= 28 → ATRASADO_VS_HISTORICO
  const limiteAtraso = Math.round(25 * FATOR_ATRASO);
  const r = calcularRecorrencia(mkPerfil({ diasSemComprar: limiteAtraso }));
  expect(r.status).toBe('ATRASADO_VS_HISTORICO');
});

// ── RECORR360-06: limites corretos com diferentes médias ─────────────────────

test('RECORR360-06: limites calculados corretamente com média=40d', () => {
  // limiteAlerta = round(40*0.85) = 34d, limiteAtraso = round(40*1.10) = 44d
  const r = calcularRecorrencia(mkPerfil({
    diasEntreComprasMedio: 40,
    diasSemComprar: 10,
  }));
  expect(r.padrao.limiteAlertaDias).toBe(Math.round(40 * FATOR_ALERTA));
  expect(r.padrao.limiteAtrasoDias).toBe(Math.round(40 * FATOR_ATRASO));
  expect(r.status).toBe('DENTRO_DO_PADRAO');
});

// ── RECORR360-07: determinismo ───────────────────────────────────────────────

test('RECORR360-07: mesma entrada = mesmo resultado (determinismo)', () => {
  const p = mkPerfil();
  const r1 = calcularRecorrencia(p);
  const r2 = calcularRecorrencia(p);
  expect(r1.status).toBe(r2.status);
  expect(r1.padrao).toEqual(r2.padrao);
});

// ── RECORR360-08: versaoMotor presente ───────────────────────────────────────

test('RECORR360-08: versaoMotor presente e não-vazio', () => {
  const r = calcularRecorrencia(mkPerfil());
  expect(r.versaoMotor).toBeTruthy();
  expect(VERSAO_MOTOR).toBeTruthy();
});

// ── RECORR360-09: perfil inválido lança erro ──────────────────────────────────

test('RECORR360-09: perfil inválido ou null lança erro descritivo', () => {
  expect(() => calcularRecorrencia(null)).toThrow('calcularRecorrencia: perfil inválido ou ausente');
  expect(() => calcularRecorrencia('string')).toThrow();
});

// ── Constantes exportadas ─────────────────────────────────────────────────────

test('FATOR_ALERTA = 0.85 e FATOR_ATRASO = 1.10 (provisional)', () => {
  expect(FATOR_ALERTA).toBe(0.85);
  expect(FATOR_ATRASO).toBe(1.10);
});

test('fronteira exata: diasSemComprar = limiteAtraso → ATRASADO (limiar inclusivo)', () => {
  const media = 30;
  const limiteAtraso = Math.round(media * FATOR_ATRASO);  // 33
  const r = calcularRecorrencia(mkPerfil({ diasEntreComprasMedio: media, diasSemComprar: limiteAtraso }));
  expect(r.status).toBe('ATRASADO_VS_HISTORICO');
});

test('fronteira exata: diasSemComprar = limiteAlerta-1 → DENTRO_DO_PADRAO', () => {
  const media = 30;
  const limiteAlerta = Math.round(media * FATOR_ALERTA);  // 26
  const r = calcularRecorrencia(mkPerfil({ diasEntreComprasMedio: media, diasSemComprar: limiteAlerta - 1 }));
  expect(r.status).toBe('DENTRO_DO_PADRAO');
});
