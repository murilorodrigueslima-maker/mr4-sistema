'use strict';
// AGENTE COMPRAS MR4 — compatibilidade de documento com o Firestore REAL (o emulador NÃO aplica várias destas regras).
// Lição de 24/10/2026: um campo chamado "__SEM_PRODUTO__" foi aceito pelo emulador e RECUSADO em produção
// ("field name ... is reserved"). Esta verificação roda antes de gravar os agregados de fornecedores e nos testes.
// Regras verificadas (documentação do Firestore): nomes de campo não podem ser vazios, nem no formato __algo__, nem passar de 1.500 bytes;
// profundidade máx. 20; sem array dentro de array; sem undefined/NaN/Infinity/função; documento ≤ limite informado.
const RESERVADO = /^__.*__$/;
function problemasFirestore(doc, { maxBytes = 900 * 1024 } = {}) {
  const p = [];
  const visitar = (x, caminho, prof, emArray) => {
    if (prof > 20) { p.push(`PROFUNDIDADE>20 em ${caminho}`); return; }
    if (x === undefined) { p.push(`VALOR_UNDEFINED em ${caminho}`); return; }
    if (typeof x === 'function' || typeof x === 'symbol') { p.push(`TIPO_INVALIDO em ${caminho}`); return; }
    if (typeof x === 'number' && !Number.isFinite(x)) { p.push(`NUMERO_NAO_FINITO em ${caminho}`); return; }
    if (Array.isArray(x)) { if (emArray) { p.push(`ARRAY_ANINHADO em ${caminho}`); return; } x.forEach((y, i) => visitar(y, `${caminho}[${i}]`, prof + 1, true)); return; }
    if (x && typeof x === 'object' && !(x instanceof Date)) {
      for (const [k, v] of Object.entries(x)) {
        if (k === '') p.push(`NOME_DE_CAMPO_VAZIO em ${caminho}`);
        else if (RESERVADO.test(k)) p.push(`NOME_DE_CAMPO_RESERVADO "${k}" em ${caminho}`);
        else if (Buffer.byteLength(k) > 1500) p.push(`NOME_DE_CAMPO_GRANDE_DEMAIS em ${caminho}`);
        visitar(v, `${caminho}/${k}`, prof + 1, false);
      }
    }
  };
  visitar(doc, '', 1, false);
  if (Buffer.byteLength(JSON.stringify(doc)) > maxBytes) p.push('DOCUMENTO_GRANDE_DEMAIS');
  return p;
}
module.exports = { problemasFirestore, RESERVADO };
