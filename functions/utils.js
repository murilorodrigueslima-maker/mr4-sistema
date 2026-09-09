'use strict';

// Raio geodésico da Terra em metros
const R_TERRA = 6371000;

/**
 * Distância em metros entre dois pontos geográficos (fórmula de Haversine).
 * Pura — sem efeitos colaterais, usável em testes unitários sem Firebase.
 */
function distMetros(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_TERRA * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Retorna a data e hora atuais no fuso America/Fortaleza (UTC-3 fixo, sem DST).
 * Formato: { data: 'YYYY-MM-DD', hora: 'HH:MM:SS' }
 */
function fortalezaAgora() {
  const agora = new Date();
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

/**
 * Valida que lat/lng são números dentro dos limites geográficos do Brasil.
 * Retorna true se válidos, false caso contrário.
 * Limites aproximados: lat [-33.8, 5.3], lng [-73.9, -28.8]
 */
function validarLatLng(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!isFinite(lat) || !isFinite(lng)) return false;
  if (lat < -33.8 || lat > 5.3) return false;
  if (lng < -73.9 || lng > -28.8) return false;
  return true;
}

module.exports = { distMetros, fortalezaAgora, validarLatLng };
