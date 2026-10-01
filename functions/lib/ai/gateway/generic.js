'use strict';
// AI GATEWAY — fluxo GENÉRICO para agentes especializados (inventory / purchasing / finance / …). O agente comercial mantém o fluxo próprio (gateway.js).
//   handler → permissão do MÓDULO (+ gate do piloto) → limite global+por agente → carga com escopo → MOTOR DETERMINÍSTICO (fatos) → contexto reduzido (candidatos)
//   → allowlist/auditoria → provedor → validação estrita (entidade, motivo, métrica, valor, números) → reidratação de nomes SÓ no backend → resposta.
// A IA não calcula nada: ela interpreta fatos recebidos. Falha da IA nunca derruba o módulo (ia.status INDISPONIVEL + resultado determinístico).
const { gerarEstruturado, MODELO_PADRAO, ErroModelo } = require('./openaiClient');
const { RespostaInvalida } = require('./schema');
const { validarGenerico } = require('./genericValidator');
const U = require('./usage');

const LIMITES_GENERICO = Object.freeze({ MAX_CONTEXTO_BYTES: 24000, MAX_OUTPUT_TOKENS: 2000, TIMEOUT_MS: 25000, PERGUNTA_MAX: 400 });
class ErroGateway extends Error { constructor(tipo, codigo) { super(codigo); this.tipo = tipo; this.codigo = codigo; } }
const falhaG = (t, c) => { throw new ErroGateway(t, c); };

/**
 * FEATURE GATE do piloto POR AGENTE (backend). Depois da permissão do módulo (que continua valendo). Padrão MANAGEMENT_ONLY (também quando ausente);
 * OFF/valor desconhecido = ninguém (fail closed); MANAGEMENT_AND_SELLERS = liberação futura (só configuração explícita/testes).
 * Variáveis: AI_<AGENTE>_PILOT e AI_<AGENTE>_PILOT_UIDS (allowlist temporária, só entre quem já tem acesso de gestão). Nada de nome/e-mail no código.
 */
function configPilotoAgente(agentType, env = process.env) {
  const k = 'AI_' + String(agentType).toUpperCase();
  return { modo: String(env[k + '_PILOT'] || 'MANAGEMENT_ONLY').trim().toUpperCase(), uids: String(env[k + '_PILOT_UIDS'] || '').split(',').map(x => x.trim()).filter(Boolean) };
}
function portaoPilotoAgente(acesso, uid, cfg) {
  if (cfg.modo !== 'MANAGEMENT_ONLY' && cfg.modo !== 'MANAGEMENT_AND_SELLERS') falhaG('permission-denied', 'FORA_DO_PILOTO');
  if (!acesso.gestao && cfg.modo !== 'MANAGEMENT_AND_SELLERS') falhaG('permission-denied', 'FORA_DO_PILOTO');
  if (cfg.uids && cfg.uids.length && !cfg.uids.includes(String(uid))) falhaG('permission-denied', 'FORA_DO_PILOTO');
  return acesso;
}

/**
 * Permissão por MÓDULO (nunca só "autenticado"): usuário ativo, não bloqueado, com doc em sistema_usuarios. Quem decide se o módulo X é permitido é o agente
 * (acesso CRM ≠ Financeiro ≠ Compras). admin=true SOZINHO não dá acesso (mesma regra do CRM). Retorna o perfil bruto; o agente aplica a regra do módulo.
 */
async function perfilModulo(store, uid) {
  const u = await store.collection('users').doc(uid).get(); const ud = u.exists ? u.data() : null;
  if (!ud || ud.ativo !== true) falhaG('permission-denied', 'USUARIO_INATIVO_OU_INEXISTENTE');
  const s = await store.collection('sistema_usuarios').doc(uid).get(); const sd = s.exists ? s.data() : null;
  if (!sd || sd.bloqueado === true) falhaG('permission-denied', 'SEM_ACESSO');
  return { uid, role: ud.role || null, modulos: Array.isArray(sd.modulos) ? sd.modulos : [], admin: sd.admin === true };
}

/** Reduz o contexto de forma DETERMINÍSTICA até caber (nunca trunca JSON): tenta escalas decrescentes da função de montagem. */
function ajustarAoLimite(montarComEscala, { escalas = [1, 0.75, 0.55, 0.4, 0.3, 0.2], alvoBytes = 22000 } = {}) {
  let r; for (const e of escalas) { r = montarComEscala(e); r.escala = e; if (r.bytes <= alvoBytes) break; }
  return r;
}

function validarPedidoGenerico(data, ag) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) falhaG('invalid-argument', 'PAYLOAD_INVALIDO');
  const extras = Object.keys(data).filter(k => !['agentType', 'modo', 'pergunta'].includes(k)); if (extras.length) falhaG('invalid-argument', 'CAMPOS_NAO_PERMITIDOS');   // module/entityId/ownerId etc. nunca são aceitos
  if (!['resumo', 'pergunta', 'contagens', 'acesso'].includes(data.modo)) falhaG('invalid-argument', 'MODO_INVALIDO');
  if (data.modo === 'pergunta') { if (typeof data.pergunta !== 'string' || !data.pergunta.trim()) falhaG('invalid-argument', 'PERGUNTA_OBRIGATORIA'); if (Array.from(data.pergunta).length > LIMITES_GENERICO.PERGUNTA_MAX) falhaG('invalid-argument', 'PERGUNTA_GRANDE_DEMAIS'); }
  return { agentType: data.agentType, modo: data.modo, pergunta: data.modo === 'pergunta' ? data.pergunta.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() : ag.perguntaResumo };
}

async function executarGenerico({ uid, data, ag, deps }) {
  const { store } = deps; const agora = deps.agora ? deps.agora() : new Date(); const agoraIso = agora.toISOString();
  const pedido = validarPedidoGenerico(data, ag);
  const acesso = await ag.autorizar(store, uid, falhaG);                                       // permissão do MÓDULO (backend)
  portaoPilotoAgente(acesso, uid, deps.piloto && deps.piloto[ag.agentType] ? deps.piloto[ag.agentType] : configPilotoAgente(ag.agentType));
  if (pedido.modo === 'acesso') return { ok: true, acesso: true, agentType: ag.agentType, modulo: ag.modulo };   // gate do frontend: sem dados, sem IA, sem limite
  let uso = null;
  if (pedido.modo !== 'contagens') { try { uso = await U.verificarLimite(store, uid, agora, deps.limites, ag.agentType); } catch (e) { if (e instanceof U.LimiteExcedido) falhaG('resource-exhausted', e.codigo); throw e; } }
  const dados = await ag.carregar(store, acesso, agoraIso);
  const montado = ag.montar(dados, acesso, pedido.pergunta, agoraIso);
  const aud = ag.auditar(montado.contexto, acesso); if (!aud.ok) falhaG('internal', 'CONTEXTO_FORA_DA_ALLOWLIST');
  if (/sk-[A-Za-z0-9_-]{10,}|api[_-]?key|bearer\s|secret/i.test(JSON.stringify(montado.contexto))) falhaG('internal', 'SEGREDO_NO_CONTEXTO');
  if (montado.bytes > LIMITES_GENERICO.MAX_CONTEXTO_BYTES) falhaG('failed-precondition', 'CONTEXTO_GRANDE_DEMAIS');
  const frescor = { ...(montado.frescor || {}), contextBuiltAt: agoraIso };
  const base = { agentType: ag.agentType, modulo: ag.modulo, modo: pedido.modo, geradoEm: agoraIso, escopo: montado.contexto.escopo || null, resumo: montado.resumo, limitacoes: montado.contexto.limitacoes || [], frescor, avisoFrescor: frescor.desatualizado ? (ag.avisoDesatualizado || 'Dados desatualizados: confira a data da fonte antes de decidir.') : null, limitesUso: uso };
  const apresentarFallback = () => (montado.fallback || []).map(x => ag.apresentar(x, montado, acesso));
  const registrar = (resultado, extra = {}) => U.registrarUso(store, { uid, agentType: ag.agentType, modulo: ag.modulo, modo: pedido.modo, agora, contextoBytes: montado.bytes, clientes: Object.keys(montado.contexto.entidades || {}).length, perguntaChars: pedido.pergunta.length, resultado, ...extra }).catch(() => {});
  if (pedido.modo === 'contagens') return { ok: true, ...base, ia: { status: 'NAO_SOLICITADA' }, answer: null, entities: [], recommendations: [], warnings: [], unavailable: [], dataFreshness: null, fallback: apresentarFallback() };
  if (!montado.resumo || montado.vazio) { await registrar('OK'); return { ok: true, ...base, ia: { status: 'SEM_DADOS' }, answer: ag.msgSemDados || 'Não há dados para analisar agora.', entities: [], recommendations: [], warnings: [], unavailable: [], dataFreshness: null, fallback: [] }; }
  let r;
  try {
    r = await gerarEstruturado({ fetchImpl: deps.fetchImpl, apiKey: deps.apiKey, modelo: deps.modelo || MODELO_PADRAO, instructions: ag.instructions, schema: ag.schema, schemaName: ag.schemaName, input: JSON.stringify({ pergunta: montado.perguntaSegura != null ? montado.perguntaSegura : pedido.pergunta, contexto: montado.contexto }), maxOutputTokens: LIMITES_GENERICO.MAX_OUTPUT_TOKENS, timeoutMs: LIMITES_GENERICO.TIMEOUT_MS });
    const v = validarGenerico(r.json, montado.contexto, montado.mapa, ag);
    await registrar('OK', { latenciaMs: r.latenciaMs, modelo: r.modelo, tokens: r.tokens, custoUSD: U.estimarCustoUSD(r.tokens, deps.precos) });
    const reidratar = t => typeof t === 'string' && ag.refPattern ? t.replace(ag.refPattern, ref => (montado.mapa[ref] ? (montado.mapa[ref].nome || ref) : ref)) : t;   // nomes só aqui, depois da validação
    const entities = v.entities.map(e => ({ ...ag.apresentar({ ref: e.ref }, montado, acesso), reasonCodes: e.reasonCodes.map(c => ({ code: c, label: (ag.rotulos.motivos || {})[c] || c })), evidence: e.evidence.map(x => ({ metric: x.metric, label: (ag.rotulos.metricas || {})[x.metric] || x.metric, value: x.value })) }));
    const recommendations = v.recommendations.map(x => ({ entity: x.ref ? ag.apresentar({ ref: x.ref }, montado, acesso) : null, action: x.action, actionLabel: (ag.rotulos.acoes || {})[x.action] || x.action, rationale: reidratar(x.rationale) }));
    return { ok: true, ...base, ia: { status: 'OK', modelo: r.modelo, latenciaMs: r.latenciaMs }, answer: reidratar(v.answer), entities, recommendations, warnings: v.warnings.map(reidratar), unavailable: v.unavailable.map(reidratar), dataFreshness: v.dataFreshness, fallback: [] };
  } catch (e) {
    const codigo = e instanceof ErroModelo || e instanceof RespostaInvalida ? e.codigo : 'ERRO_INTERNO_IA';
    await registrar('FALHA', { erro: String(codigo).slice(0, 60), latenciaMs: r ? r.latenciaMs : null, modelo: r ? r.modelo : null, tokens: r ? r.tokens : null });
    return { ok: true, ...base, ia: { status: 'INDISPONIVEL', motivo: codigo === 'IA_NAO_CONFIGURADA' ? 'IA_NAO_CONFIGURADA' : (e instanceof RespostaInvalida ? 'RESPOSTA_INVALIDA' : codigo === 'TIMEOUT' ? 'TIMEOUT' : codigo === 'RATE_LIMITED' ? 'PROVEDOR_OCUPADO' : 'PROVEDOR_INDISPONIVEL') }, answer: null, entities: [], recommendations: [], warnings: [], unavailable: [], dataFreshness: null, fallback: apresentarFallback() };   // o módulo segue normal
  }
}
module.exports = { LIMITES_GENERICO, ErroGateway, falhaG, configPilotoAgente, portaoPilotoAgente, perfilModulo, ajustarAoLimite, validarPedidoGenerico, executarGenerico };
