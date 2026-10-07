'use strict';
/**
 * B3.1 — exclusão mútua dos motores de ownership. Há DOIS escritores possíveis de ownership automático:
 *   R2 (N35.30, carteiraRegra.js) e B3 (reativacao120/reativacaoOps). Exatamente UM pode estar autorizado por vez, via
 *   carteira_comercial_config/motor { motorAtivo: 'NENHUM' | 'R2' | 'B3' }. Ausente/inválido ⇒ 'NENHUM' (nenhum escreve ownership).
 * Hoje: documento ausente ⇒ NENHUM; R2 também segue com FORCAR_SOMBRA=true; B3 é DRY (FORCAR_DRY=true).
 */
const REF = ['carteira_comercial_config', 'motor'];
const MOTORES = Object.freeze(['NENHUM', 'R2', 'B3']);
const lerMotor = doc => { const m = doc && doc.motorAtivo; return MOTORES.includes(m) ? m : 'NENHUM'; };
const podeEscreverOwnership = (motor, quem) => lerMotor({ motorAtivo: motor }) === quem && quem !== 'NENHUM';
/** Leitura dentro de transação: devolve o motor ativo. */
async function motorNaTx(tx, store) { return lerMotor((await tx.get(store.collection(REF[0]).doc(REF[1]))).data()); }
module.exports = { REF, MOTORES, lerMotor, podeEscreverOwnership, motorNaTx };
