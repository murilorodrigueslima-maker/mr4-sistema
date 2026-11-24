'use strict';
/**
 * Monitor independente de DADOS DESATUALIZADOS do sync (não depende do GitHub Actions).
 * Lê `gc_sync_status/ultima` (heartbeat gravado pelo sync) e decide o nível:
 *   OK ≤ 4 h · AVISO > 4 h · CRÍTICO > 8 h · SEM_REGISTRO (heartbeat inexistente/ilegível).
 * Notificação (evita spam): ao PIORAR de nível; ao RECUPERAR (volta a OK); e repetida enquanto persistir
 * (AVISO a cada 4 h, CRÍTICO a cada 2 h). Função PURA — o envio é um log estruturado (Cloud Logging → política de alerta).
 * Só códigos, níveis e horas: nenhum dado do negócio.
 */
const H = 3600000;
const LIMITES = Object.freeze({ avisoMs: 4 * H, criticoMs: 8 * H, repeticaoAvisoMs: 4 * H, repeticaoCriticoMs: 2 * H });
const RANK = { OK: 0, SEM_REGISTRO: 1, AVISO: 1, CRITICO: 2 };

function nivelPorIdade(idadeMs) { return idadeMs > LIMITES.criticoMs ? 'CRITICO' : idadeMs > LIMITES.avisoMs ? 'AVISO' : 'OK'; }

/**
 * @param {{agoraMs:number, ultimoSucessoCompletoEm:(string|null|undefined), estadoAnterior:(null|{nivel:string,notificadoEmMs:(number|null)})}} p
 * @returns {{nivel:string, idadeMs:(number|null), notificar:boolean, tipo:(string|null), novoEstado:{nivel:string, notificadoEmMs:(number|null), atualizadoEmMs:number}}}
 */
function avaliarDesatualizacao({ agoraMs, ultimoSucessoCompletoEm, estadoAnterior = null } = {}) {
  const ult = ultimoSucessoCompletoEm ? Date.parse(ultimoSucessoCompletoEm) : NaN;
  const idadeMs = Number.isFinite(ult) && ult <= agoraMs + 5 * 60000 ? Math.max(0, agoraMs - ult) : null;   // data no futuro (> 5 min) = inválida
  const nivel = idadeMs === null ? 'SEM_REGISTRO' : nivelPorIdade(idadeMs);
  const ant = estadoAnterior && typeof estadoAnterior.nivel === 'string' ? estadoAnterior : { nivel: 'OK', notificadoEmMs: null };
  const antNotificadoEm = Number.isFinite(ant.notificadoEmMs) ? ant.notificadoEmMs : null;
  let notificar = false, tipo = null;
  if (nivel === 'OK') { if (ant.nivel !== 'OK') { notificar = true; tipo = 'RECUPERADO'; } }
  else {
    const piorou = RANK[nivel] > (RANK[ant.nivel] ?? 0) || (nivel !== ant.nivel && ant.nivel === 'OK');
    const repeticao = nivel === 'CRITICO' ? LIMITES.repeticaoCriticoMs : LIMITES.repeticaoAvisoMs;
    if (piorou || ant.nivel === 'OK') { notificar = true; tipo = nivel === 'CRITICO' ? 'CRITICO' : nivel === 'AVISO' ? 'AVISO' : 'SEM_REGISTRO'; }
    else if (antNotificadoEm === null || agoraMs - antNotificadoEm >= repeticao) { notificar = true; tipo = 'REPETICAO_' + nivel; }
  }
  return { nivel, idadeMs, notificar, tipo, novoEstado: { nivel, notificadoEmMs: nivel === 'OK' ? null : (notificar ? agoraMs : antNotificadoEm), atualizadoEmMs: agoraMs } };
}

/** Handler (injetável): lê o heartbeat, avalia, grava o estado e emite UM log estruturado quando deve notificar. */
async function monitorarHandler({ db, logger, agora = () => Date.now() }) {
  const agoraMs = agora();
  let hb = null, lerOk = true;
  try { const s = await db.collection('gc_sync_status').doc('ultima').get(); hb = s.exists ? s.data() : null; } catch (_) { lerOk = false; }
  let est = null; try { const s = await db.collection('gc_sync_alertas').doc('estado').get(); est = s.exists ? s.data() : null; } catch (_) { est = null; }
  const r = avaliarDesatualizacao({ agoraMs, ultimoSucessoCompletoEm: lerOk && hb ? hb.ultimoSucessoCompletoEm : null, estadoAnterior: est });
  if (r.notificar) {
    const idadeHoras = r.idadeMs === null ? null : Math.round((r.idadeMs / H) * 10) / 10;
    const payload = { alerta: 'SYNC_DESATUALIZADO', tipo: r.tipo, nivel: r.nivel, idadeHoras, limitesHoras: { aviso: 4, critico: 8 }, leituraHeartbeat: lerOk ? 'OK' : 'FALHOU' };
    (r.nivel === 'CRITICO' ? logger.error : r.nivel === 'OK' ? logger.info : logger.warn).call(logger, 'SYNC_DESATUALIZADO', payload);
  }
  try { await db.collection('gc_sync_alertas').doc('estado').set(r.novoEstado); } catch (_) { /* best-effort: o próximo ciclo reavalia */ }
  return r;
}

module.exports = { LIMITES, avaliarDesatualizacao, monitorarHandler };
