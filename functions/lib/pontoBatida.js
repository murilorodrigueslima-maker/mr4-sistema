'use strict';
// PONTO MR4 2.0 — Fase 0 · P0-01: batida idempotente por INTENÇÃO.
//
// Uma intenção do funcionário = um toque = um `requestId` (gerado no cliente) + o `tipoEsperado` que a tela mostrou.
//   • mesmo requestId de novo (retry, resposta perdida, duplo envio, 2 abas com a mesma intenção)
//       → JA_PROCESSADO com o MESMO resultado da primeira vez (nunca avança para a próxima batida);
//   • tipoEsperado ≠ próxima batida real (toque repetido com nova intenção, outro aparelho já bateu, fora de ordem)
//       → recusa TIPO_ESPERADO_DIVERGENTE com o estado atual, sem gravar nada;
//   • nova batida legítima (tipoEsperado == próxima) → grava normalmente.
// O ID determinístico funcId_data_tipo (unicidade atômica) e a transação continuam como antes.
// Clientes antigos (sem requestId/tipoEsperado) seguem o comportamento anterior, com cooldown maior.

const TIPOS = ['entrada', 'saida_almoco', 'retorno_almoco', 'saida'];
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Cooldown técnico (proteção SECUNDÁRIA; a principal é a intenção). Ver relatório da Fase 0 para a medição.
const COOLDOWN_COM_INTENCAO_MS = 10000;   // clientes novos: mantém o valor atual (intenção já barra repetição)
const COOLDOWN_LEGADO_MS = 60000;         // clientes sem intenção (páginas antigas em cache durante a transição)

function proximoTipo(ultimo) {
  if (!ultimo) return 'entrada';
  const i = TIPOS.indexOf(ultimo.tipo);
  return i >= 0 && i < TIPOS.length - 1 ? TIPOS[i + 1] : null;
}
/** Registros que valem para a sequência: os substituídos por uma correção ficam de fora (continuam gravados). */
function efetivos(regs) { return (regs || []).filter(r => r && !r.substituidoPor); }

/** Valida os campos de intenção do payload. Retorna {requestId, tipoEsperado} (null quando ausentes = cliente legado). */
function lerIntencao(payload) {
  const { requestId, tipoEsperado } = payload || {};
  if (requestId !== undefined && requestId !== null && !REQUEST_ID_RE.test(String(requestId))) {
    const e = new Error('REQUEST_ID_INVALIDO'); e.codigo = 'REQUEST_ID_INVALIDO'; throw e;
  }
  if (tipoEsperado !== undefined && tipoEsperado !== null && !TIPOS.includes(tipoEsperado)) {
    const e = new Error('TIPO_ESPERADO_INVALIDO'); e.codigo = 'TIPO_ESPERADO_INVALIDO'; throw e;
  }
  return { requestId: requestId ? String(requestId) : null, tipoEsperado: tipoEsperado || null };
}

function millis(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
  return 0;
}
function ordenar(regs) {
  return [...regs].sort((a, b) => {
    if (a.hora !== b.hora) return a.hora > b.hora ? 1 : -1;
    return millis(a.criadoEm) - millis(b.criadoEm);
  });
}

/**
 * Executa a batida dentro de UMA transação.
 * @param db       Firestore (admin)
 * @param ctx      { funcId, uid, func, data, hora, modalidade, dentroRaio, lat, lng, horaCliente, facialScore, foto,
 *                   requestId, tipoEsperado, agoraMs, cooldownOverrideMs, LABEL_PONTO, HttpsError, serverTimestamp }
 * @returns        { status: 'REGISTRADO'|'JA_PROCESSADO', id, tipo, tipoLabel, data, hora, dentroRaio, modalidade }
 */
async function registrarBatidaTx(db, ctx) {
  const { funcId, requestId, tipoEsperado, HttpsError } = ctx;
  const registrosRef = db.collection('registros');
  let resultado = null;
  await db.runTransaction(async (tx) => {
    resultado = null;
    // 1) Idempotência: a mesma intenção já foi gravada (em qualquer dia)? → devolve o mesmo resultado.
    if (requestId) {
      const ja = await tx.get(registrosRef.where('funcId', '==', funcId).where('requestId', '==', requestId).limit(1));
      if (!ja.empty) {
        const r = ja.docs[0].data();
        resultado = { status: 'JA_PROCESSADO', id: ja.docs[0].id, tipo: r.tipo, tipoLabel: r.tipoLabel, data: r.data, hora: r.hora,
          dentroRaio: r.dentroRaio ?? null, modalidade: r.modalidade || ctx.modalidade };
        return;
      }
    }
    // 2) Estado real do dia (sem orderBy na transação; ordena em memória)
    const snap = await tx.get(registrosRef.where('funcId', '==', funcId).where('data', '==', ctx.data));
    const regsHoje = ordenar(efetivos(snap.docs.map(d => d.data())));
    const ultimo = regsHoje[regsHoje.length - 1] || null;
    const tipo = proximoTipo(ultimo);
    if (!tipo) throw new HttpsError('failed-precondition', 'Ponto do dia já completo.', { codigo: 'DIA_COMPLETO', proximo: null, ultimo: ultimo ? ultimo.tipo : null });
    // 3) Intenção explícita: nunca "avançar" para outra batida que o funcionário não pediu
    if (tipoEsperado && tipoEsperado !== tipo) {
      throw new HttpsError('failed-precondition', 'TIPO_ESPERADO_DIVERGENTE', {
        codigo: 'TIPO_ESPERADO_DIVERGENTE', esperado: tipoEsperado, proximo: tipo,
        ultimo: ultimo ? { tipo: ultimo.tipo, hora: ultimo.hora } : null,
      });
    }
    // 4) Unicidade atômica por tipo/dia (como antes)
    const id = funcId + '_' + ctx.data + '_' + tipo;
    const dup = await tx.get(registrosRef.doc(id));
    if (dup.exists) throw new HttpsError('already-exists', 'Este tipo de ponto já foi registrado para esta data.', { codigo: 'JA_REGISTRADO', proximo: tipo });
    // 5) Cooldown técnico (secundário)
    if (ultimo) {
      const janela = Number.isFinite(ctx.cooldownOverrideMs) ? ctx.cooldownOverrideMs : (tipoEsperado ? COOLDOWN_COM_INTENCAO_MS : COOLDOWN_LEGADO_MS);
      if (ctx.agoraMs - millis(ultimo.criadoEm) < janela) {
        throw new HttpsError('resource-exhausted', 'Aguarde alguns segundos antes de registrar outro ponto.', { codigo: 'COOLDOWN', proximo: tipo });
      }
    }
    const tipoLabel = ctx.LABEL_PONTO[tipo];
    tx.set(registrosRef.doc(id), {
      id, funcId, funcNome: ctx.func.nome || '', authUid: ctx.uid, modalidade: ctx.modalidade, data: ctx.data, hora: ctx.hora,
      tipo, tipoLabel, lat: ctx.lat, lng: ctx.lng, dentroRaio: ctx.dentroRaio, horaCliente: ctx.horaCliente,
      facialScore: ctx.facialScore, foto: ctx.foto,
      requestId: requestId || null,              // intenção (auditoria + idempotência)
      tipoEsperado: tipoEsperado || null,
      criadoEm: ctx.serverTimestamp(),
    });
    resultado = { status: 'REGISTRADO', id, tipo, tipoLabel, data: ctx.data, hora: ctx.hora, dentroRaio: ctx.dentroRaio, modalidade: ctx.modalidade };
  });
  return resultado;
}

module.exports = { registrarBatidaTx, lerIntencao, proximoTipo, efetivos, TIPOS, REQUEST_ID_RE, COOLDOWN_COM_INTENCAO_MS, COOLDOWN_LEGADO_MS };
