'use strict';
// N35.16.1 — Sanitização do NOME DE EXIBIÇÃO de clientes (camada MR4). Função pura, determinística.
//
// Finalidade estrita: remover CPF/CNPJ que cadastros externos (GestãoClick) embutem no campo de nome.
// NÃO altera dados de origem, NÃO participa de identidade/join/deduplicação, NÃO muda caixa.
//
// Removido (sequência de dígitos isolada — não pode estar colada a outros dígitos):
//   CNPJ formatado        00.000.000/0000-00   (e 00000000/0000-00, 000000000000-00)
//   CPF formatado         000.000.000-00       (e 000000000-00)
//   Raiz formatada CNPJ   00.000.000           (padrão de razão social de MEI; nunca é CEP, ano ou código)
//   CPF/CNPJ sem máscara  exatamente 11 ou 14 dígitos
//   Rótulo opcional antes do número: "CPF", "CNPJ", "CPF:", "CNPJ nº" …
// Preservado: números curtos, CEP (00000-000 / 00.000-000), anos, códigos e modelos ("LOJA 10 AUTO SOM", "K2", "2026").

const ROTULO = '(?:C\\.?\\s?N\\.?\\s?P\\.?\\s?J\\.?|C\\.?\\s?P\\.?\\s?F\\.?)\\s*(?:n[º°o]\\.?)?\\s*[:#.-]?\\s*';
const DOCUMENTO = [
  '\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}', // CNPJ formatado
  '\\d{8}\\/\\d{4}-?\\d{2}',                   // CNPJ semi-formatado
  '\\d{12}-\\d{2}',                            // CNPJ só com dígito verificador separado
  '\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}',          // CPF formatado
  '\\d{9}-\\d{2}',                             // CPF só com dígito verificador separado
  '\\d{2}\\.\\d{3}\\.\\d{3}(?![.\\/-]?\\d)',  // raiz formatada de CNPJ (MEI)
  '\\d{14}',                                   // CNPJ sem máscara
  '\\d{11}',                                   // CPF sem máscara
].join('|');
const PADRAO = `(?:${ROTULO})?(?<!\\d)(?:${DOCUMENTO})(?!\\d)`;
const SEP_CHARS = '\\-–—|\\/,;:';
const SEP = `[${SEP_CHARS}]`;

function contemDocumento(nome) {
  if (typeof nome !== 'string') return false;
  return new RegExp(PADRAO, 'i').test(nome);
}

/**
 * @param {*} nome
 * @returns {string|null} nome sem CPF/CNPJ, ou null se não sobrar um nome exibível (fail closed)
 */
function sanitizeCommercialDisplayName(nome) {
  if (typeof nome !== 'string') return null;
  if (!contemDocumento(nome)) return nome.trim() ? nome : null; // sem documento: nome intacto
  let s = nome.replace(new RegExp(PADRAO, 'gi'), ' ');
  s = s.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ');                                   // parênteses que ficaram vazios
  s = s.replace(/\s+/g, ' ');
  s = s.replace(new RegExp(`\\s*(${SEP})\\s*(?:${SEP}\\s*)+`, 'g'), ' $1 ');       // separadores repetidos → um
  s = s.replace(new RegExp(`^[\\s.${SEP_CHARS}]+|[\\s${SEP_CHARS}]+$`, 'g'), '');   // separadores órfãos nas pontas
  s = s.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-zÀ-ÿ]/.test(s)) return null;                                             // sem letras → não exibível
  if (contemDocumento(s)) return null;                                                 // defesa: nunca devolver documento
  return s;
}

module.exports = { sanitizeCommercialDisplayName, contemDocumento };
