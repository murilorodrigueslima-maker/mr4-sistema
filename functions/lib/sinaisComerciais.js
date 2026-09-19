'use strict';

/**
 * Sinais Comerciais Determinísticos V1 — ZERO LLM, ZERO I/O.
 *
 * Dois sinais pré-calculados para apresentação ao vendedor:
 *
 *   1. ATRASO RELATIVO AO CICLO HABITUAL
 *      calcularAtrasoCiclo(diasSemComprar, diasEntreComprasMediana)
 *      Responde: "o cliente está N dias / X× além do ciclo habitual?"
 *
 *   2. VARIAÇÃO DE VOLUME DE COMPRAS
 *      calcularVariacaoVolume(perfil)
 *      Responde: "pedidos e faturamento cresceram, caíram ou estão estáveis?"
 *      Janelas não sobrepostas por subtração de acumulados (mesma estratégia
 *      que tendenciaComercial.js). Pedidos e faturamento tratados separadamente.
 *
 * Política de arredondamento (documentada):
 *   diasAlemDoCiclo      → Math.round()            (inteiro)
 *   razaoDoCiclo         → Math.round(x*100)/100   (2 casas)
 *   percentualAlemDoCiclo → Math.round(x*10)/10    (1 casa)
 *   variacao (volume)    → Math.round(x*10)/10     (1 casa)
 *
 * Invariante: não modifica entradas, não realiza I/O, sem randomização.
 * Mesma entrada + mesma chamada = mesma saída.
 *
 * N33.2 — NÃO integrado ao provider ainda. Somente criar/calcular/testar.
 */

const VERSAO_SINAIS = 'sinais-comerciais-v1';

// Tolerância de variação para CRESCIMENTO/QUEDA/ESTAVEL — alinhada com
// tendenciaComercial.js (TOLERANCIA_ESTAVEL = 0.20).
const TOLERANCIA_ESTAVEL_VOLUME = 0.20;

// ── Status ATRASO_CICLO ───────────────────────────────────────────────────────

const STATUS_ATRASO = Object.freeze({
  SEM_BASE:       'SEM_BASE',       // dados inválidos/ausentes
  ANTES_DO_CICLO: 'ANTES_DO_CICLO', // diasSemComprar < mediana
  NO_CICLO:       'NO_CICLO',       // diasSemComprar === mediana (exato)
  ATRASADO:       'ATRASADO',       // diasSemComprar > mediana
});

// ── Status VARIACAO_VOLUME ────────────────────────────────────────────────────

const STATUS_VOLUME = Object.freeze({
  SEM_BASE:              'SEM_BASE',              // entrada inválida
  SEM_MOVIMENTO:         'SEM_MOVIMENTO',         // atual=0 e anterior=0
  BASE_ZERO_CRESCIMENTO: 'BASE_ZERO_CRESCIMENTO', // anterior=0, atual>0
  QUEDA_TOTAL:           'QUEDA_TOTAL',           // anterior>0, atual=0
  CRESCIMENTO:           'CRESCIMENTO',           // variação ≥ +20%
  QUEDA:                 'QUEDA',                 // variação ≤ -20%
  ESTAVEL:               'ESTAVEL',               // variação dentro de ±20%
});

// ── SINAL 1: ATRASO RELATIVO AO CICLO HABITUAL ───────────────────────────────

/**
 * Calcula o atraso do cliente em relação ao seu ciclo habitual de recompra.
 *
 * @param {*} diasSemComprar         — número de dias desde a última compra
 * @param {*} diasEntreComprasMediana — mediana dos intervalos entre compras
 * @returns {Object} — resultado imutável (Object.freeze)
 */
function calcularAtrasoCiclo(diasSemComprar, diasEntreComprasMediana) {
  // Validação de entradas
  const dscValido =
    typeof diasSemComprar === 'number' &&
    isFinite(diasSemComprar) &&
    diasSemComprar >= 0;

  const medValida =
    typeof diasEntreComprasMediana === 'number' &&
    isFinite(diasEntreComprasMediana) &&
    diasEntreComprasMediana > 0;

  if (!dscValido || !medValida) {
    return Object.freeze({
      status:               STATUS_ATRASO.SEM_BASE,
      diasSemComprar:       dscValido ? diasSemComprar : null,
      cicloMedianoDias:     medValida ? diasEntreComprasMediana : null,
      diasAlemDoCiclo:      null,
      razaoDoCiclo:         null,
      percentualAlemDoCiclo: null,
    });
  }

  const dsc = diasSemComprar;
  const med = diasEntreComprasMediana;

  // razaoDoCiclo: sempre calculado quando os dados são válidos
  const razaoDoCiclo = Math.round((dsc / med) * 100) / 100;

  if (dsc < med) {
    return Object.freeze({
      status:               STATUS_ATRASO.ANTES_DO_CICLO,
      diasSemComprar:       dsc,
      cicloMedianoDias:     med,
      diasAlemDoCiclo:      null,
      razaoDoCiclo,
      percentualAlemDoCiclo: null,
    });
  }

  // dsc >= med: NO_CICLO (igual) ou ATRASADO (maior)
  const diasAlemDoCiclo      = Math.round(dsc - med);
  const percentualAlemDoCiclo = Math.round(((dsc - med) / med) * 1000) / 10;
  const status = dsc === med ? STATUS_ATRASO.NO_CICLO : STATUS_ATRASO.ATRASADO;

  return Object.freeze({
    status,
    diasSemComprar:       dsc,
    cicloMedianoDias:     med,
    diasAlemDoCiclo,
    razaoDoCiclo,
    percentualAlemDoCiclo,
  });
}

// ── SINAL 2: VARIAÇÃO DE VOLUME DE COMPRAS ────────────────────────────────────

/**
 * Classifica a variação entre atual e anterior para um único indicador.
 * @param {number} atual
 * @param {number} anterior
 * @returns {string} STATUS_VOLUME
 */
function _statusVolume(atual, anterior) {
  if (typeof atual !== 'number' || typeof anterior !== 'number') {
    return STATUS_VOLUME.SEM_BASE;
  }
  if (atual === 0 && anterior === 0) return STATUS_VOLUME.SEM_MOVIMENTO;
  if (anterior === 0 && atual > 0)   return STATUS_VOLUME.BASE_ZERO_CRESCIMENTO;
  if (anterior > 0  && atual === 0)  return STATUS_VOLUME.QUEDA_TOTAL;
  // Ambos > 0
  const v = (atual - anterior) / anterior;
  if (v >=  TOLERANCIA_ESTAVEL_VOLUME) return STATUS_VOLUME.CRESCIMENTO;
  if (v <= -TOLERANCIA_ESTAVEL_VOLUME) return STATUS_VOLUME.QUEDA;
  return STATUS_VOLUME.ESTAVEL;
}

/**
 * Variação percentual com 1 casa decimal. null quando base=0 e ambos=0.
 */
function _variacaoPct(atual, anterior) {
  if (anterior === 0) return null; // divisão por zero → sem variação calculável
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

/**
 * Calcula um par {atual, anterior, variacao, status} para um indicador.
 */
function _calcularJanela(atual, anterior) {
  return Object.freeze({
    atual,
    anterior,
    variacao: _variacaoPct(atual, anterior),
    status:   _statusVolume(atual, anterior),
  });
}

/**
 * Calcula variação de volume para janelas 30d e 90d (não sobrepostas).
 *
 * Derivação das janelas anteriores por subtração de acumulados:
 *   30d-anterior = pedidos60d  − pedidos30d   (dias 31-60)
 *   90d-anterior = pedidos180d − pedidos90d   (dias 91-180)
 *
 * Mesma estratégia de tendenciaComercial.js — sem duplicar o motor de
 * classificação, somente expondo os números absolutos e status separados
 * por indicador (pedidos ≠ faturamento).
 *
 * @param {Object} perfil — campos de janela do Perfil360
 * @returns {Object} — resultado imutável
 */
function calcularVariacaoVolume(perfil) {
  if (!perfil || typeof perfil !== 'object') {
    throw new Error('calcularVariacaoVolume: perfil deve ser objeto');
  }

  const ped30   = perfil.pedidos30d      || 0;
  const ped60   = perfil.pedidos60d      || 0;
  const ped90   = perfil.pedidos90d      || 0;
  const ped180  = perfil.pedidos180d     || 0;
  const fat30   = perfil.faturamento30d  || 0;
  const fat60   = perfil.faturamento60d  || 0;
  const fat90   = perfil.faturamento90d  || 0;
  const fat180  = perfil.faturamento180d || 0;

  // Períodos anteriores (não sobrepostos)
  const ped30ant  = ped60  - ped30;   // dias 31-60
  const fat30ant  = fat60  - fat30;
  const ped90ant  = ped180 - ped90;   // dias 91-180
  const fat90ant  = fat180 - fat90;

  return Object.freeze({
    j30d: Object.freeze({
      pedidos:     _calcularJanela(ped30, ped30ant),
      faturamento: _calcularJanela(fat30, fat30ant),
    }),
    j90d: Object.freeze({
      pedidos:     _calcularJanela(ped90, ped90ant),
      faturamento: _calcularJanela(fat90, fat90ant),
    }),
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_SINAIS,
  TOLERANCIA_ESTAVEL_VOLUME,
  STATUS_ATRASO,
  STATUS_VOLUME,
  calcularAtrasoCiclo,
  calcularVariacaoVolume,
  // Helpers expostos para testes
  _statusVolume,
  _variacaoPct,
  _calcularJanela,
};
