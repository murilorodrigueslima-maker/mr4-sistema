'use strict';
/**
 * Núcleo de segurança do módulo Integrações e Credenciais.
 * - Master: uid na lista `integracoes_config/acesso.masters` (documento só de backend) + users.ativo + role gestor + sistema_usuarios.admin e não bloqueado.
 * - Reautenticação recente: auth_time do token ≤ 5 min (operações com segredo).
 * - Limitação de requisições por usuário (janela deslizante em Firestore).
 * - Auditoria append-only: usuário, integração, ação, resultado, código — NUNCA valores de segredo.
 */
class IntErro extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

async function exigirMaster({ db, auth, agoraMs = Date.now(), reauth = false, reauthJanelaS = 300 }) {
  if (!auth || !auth.uid) throw new IntErro('unauthenticated', 'Login necessário.');
  const uid = auth.uid;
  const [cfg, us, ss] = await Promise.all([db.collection('integracoes_config').doc('acesso').get(), db.collection('users').doc(uid).get(), db.collection('sistema_usuarios').doc(uid).get()]);
  const masters = cfg.exists && Array.isArray(cfg.data().masters) ? cfg.data().masters : [];
  const u = us.exists ? us.data() : null, s = ss.exists ? ss.data() : null;
  const ok = masters.includes(uid) && u && u.ativo === true && u.role === 'gestor' && s && s.bloqueado !== true && s.admin === true;
  if (!ok) throw new IntErro('permission-denied', 'Acesso restrito ao administrador master.');
  if (reauth) {
    const t = Number(auth.token && auth.token.auth_time);
    if (!Number.isFinite(t) || agoraMs / 1000 - t > reauthJanelaS) throw new IntErro('failed-precondition', 'REAUTENTICACAO_NECESSARIA');
  }
  return { uid };
}

async function limitar({ db, uid, chave, max, janelaMs, agoraMs = Date.now() }) {
  const ref = db.collection('integracoes_limite').doc(uid + '_' + chave); let negado = false;
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : {};
    const t = (d.tentativas || []).filter(x => agoraMs - x < janelaMs);
    if (t.length >= max) { negado = true; return; }
    t.push(agoraMs); tx.set(ref, { tentativas: t });
  });
  if (negado) throw new IntErro('resource-exhausted', 'LIMITE_DE_REQUISICOES');
}

const INTEGRACOES = ['GESTAOCLICK_API', 'GESTAOCLICK_WEBHOOK', 'GOOGLE_CLOUD'];
const codigoSeguro = c => (typeof c === 'string' && /^[A-Z0-9_]{2,60}$/.test(c) ? c : null);
async function auditar({ db, uid, integracao, acao, resultado, codigo, agoraMs = Date.now() }) {
  if (!INTEGRACOES.includes(integracao) || !['OK', 'FALHA', 'NEGADO'].includes(resultado) || !/^[a-zA-Z0-9_]{2,40}$/.test(acao)) return;
  try { await db.collection('integracoes_auditoria').add({ uid, integracao, acao, resultado, codigo: codigoSeguro(codigo), em: agoraMs, emIso: new Date(agoraMs).toISOString() }); } catch (_) { /* a operação já ocorreu; o log de função registra o código */ }
}

/** Valida formato do valor de credencial/segredo (sem eco do valor em mensagens). */
function valorValido(v, { min = 8, max = 300 } = {}) { return typeof v === 'string' && v.length >= min && v.length <= max && /^[\x21-\x7E]+$/.test(v); }

module.exports = { IntErro, exigirMaster, limitar, auditar, valorValido, INTEGRACOES };
