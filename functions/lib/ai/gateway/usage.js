'use strict';
// AI GATEWAY — controle de custo: limite de taxa por usuário (transacional) + registro de uso SEM conteúdo (sem prompt, sem resposta, sem nomes).
// Limites (justificativa): uso humano e interativo; cada chamada leva ~5–20 s, então >8/min é abuso ou loop de front; 100/dia/usuário
// cobre um dia inteiro de trabalho de vendedor/gestor e limita o custo diário máximo por usuário.
const LIMITE_POR_MINUTO = 8, LIMITE_POR_DIA = 100;
const COL = { rate: 'ai_rate', uso: 'ai_uso', chamadas: 'ai_chamadas' };

class LimiteExcedido extends Error { constructor(tipo) { super('RATE_LIMIT_' + tipo); this.codigo = 'RATE_LIMIT_' + tipo; this.tipo = tipo; } }

async function verificarLimite(db, uid, agora = new Date(), lim = { minuto: LIMITE_POR_MINUTO, dia: LIMITE_POR_DIA }) {
  const minuto = Math.floor(agora.getTime() / 60000), dia = agora.toISOString().slice(0, 10);   // dia em UTC: janela de 24 h, sem relação com o dia comercial
  return db.runTransaction(async tx => {
    const ref = db.collection(COL.rate).doc(uid); const s = await tx.get(ref); const d = s.exists ? s.data() : {};
    const nMin = d.minuto === minuto ? d.nMin : 0, nDia = d.dia === dia ? d.nDia : 0;
    if (nMin >= lim.minuto) throw new LimiteExcedido('MINUTO');
    if (nDia >= lim.dia) throw new LimiteExcedido('DIA');
    tx.set(ref, { minuto, nMin: nMin + 1, dia, nDia: nDia + 1 });
    return { restanteMinuto: lim.minuto - nMin - 1, restanteDia: lim.dia - nDia - 1 };
  });
}
/** Custo estimado só se houver tabela de preços configurada (USD por 1M tokens); sem preço verificado não inventa valor. */
function estimarCustoUSD(tokens, precos) {
  if (!precos || !tokens || !(precos.inputPor1M >= 0) || !(precos.outputPor1M >= 0)) return null;
  const cached = tokens.cachedInput || 0, entrada = Math.max(0, (tokens.input || 0) - cached);
  return Math.round(((entrada * precos.inputPor1M + cached * (precos.cachedInputPor1M ?? precos.inputPor1M) + (tokens.output || 0) * precos.outputPor1M) / 1e6) * 1e6) / 1e6;
}
/** Registro técnico (sem conteúdo): agregado diário por usuário + linha por chamada. */
async function registrarUso(db, { uid, agentType, modo, agora = new Date(), latenciaMs = null, modelo = null, tokens = null, custoUSD = null, resultado, erro = null, contextoBytes = null, clientes = null, perguntaChars = null }) {
  const dia = agora.toISOString().slice(0, 10);
  const chamada = { uid, agentType, modo, em: agora.toISOString(), latenciaMs, modelo, tokensEntrada: tokens ? tokens.input : null, tokensSaida: tokens ? tokens.output : null, custoUSD, resultado, erro, contextoBytes, clientes, perguntaChars };
  await db.collection(COL.chamadas).doc(`${agora.getTime()}_${uid.slice(0, 8)}_${Math.random().toString(36).slice(2, 7)}`).set(chamada);
  await db.runTransaction(async tx => {
    const ref = db.collection(COL.uso).doc(`${dia}__${uid}`); const s = await tx.get(ref); const a = s.exists ? s.data() : { dia, uid, requisicoes: 0, ok: 0, falhas: 0, tokensEntrada: 0, tokensSaida: 0, custoUSD: 0, latenciaTotalMs: 0 };
    tx.set(ref, { ...a, requisicoes: a.requisicoes + 1, ok: a.ok + (resultado === 'OK' ? 1 : 0), falhas: a.falhas + (resultado === 'OK' ? 0 : 1), tokensEntrada: a.tokensEntrada + (tokens ? tokens.input : 0), tokensSaida: a.tokensSaida + (tokens ? tokens.output : 0), custoUSD: Math.round((a.custoUSD + (custoUSD || 0)) * 1e6) / 1e6, latenciaTotalMs: a.latenciaTotalMs + (latenciaMs || 0), ultimoEm: chamada.em });
  });
}
module.exports = { LIMITE_POR_MINUTO, LIMITE_POR_DIA, COL, LimiteExcedido, verificarLimite, estimarCustoUSD, registrarUso };
