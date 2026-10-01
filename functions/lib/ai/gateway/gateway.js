'use strict';
// AI GATEWAY interno (reutilizável por commercial / purchasing / finance / inventory / management / marketing).
//   MR4 Gestão → handler (Auth) → Policy/Permission → Context Builder (escopo + allowlist) → provedor de IA → resposta ESTRUTURADA validada → MR4 Gestão
// Cada agente é um registro: { agentType, politica, contextBuilder, instructions, schema, limites }. Só `commercial` existe nesta fase.
const { HttpsError } = require('firebase-functions/v2/https');
const CRM = require('../../crmConsulta').__internals;
const CTX = require('./commercialContext');
const { auditarContexto } = require('./allowlist');
const { RESPONSE_SCHEMA, RespostaInvalida, validarResposta, MOTIVOS } = require('./schema');
const { gerarEstruturado, MODELO_PADRAO, ErroModelo } = require('./openaiClient');
const U = require('./usage');
const INSTR = require('./instructions');

const PERGUNTA_MAX = 400;
const LIMITES = Object.freeze({ MAX_CONTEXTO_BYTES: CTX.LIMITES.MAX_CONTEXTO_BYTES, MAX_OUTPUT_TOKENS: 2000, TIMEOUT_MS: 25000 });
const PERGUNTA_RESUMO = 'Faça o resumo comercial do dia: quantos clientes merecem contato, quedas relevantes, clientes perto de 120 dias e oportunidades de recompra, e liste quem contatar primeiro e por quê.';
const METRICA_ROTULO = { diasSemComprar: 'Dias sem comprar', ultimaCompraEm: 'Última compra', pedidosTotal: 'Pedidos (total)', pedidos30d: 'Pedidos 30d', pedidos60d: 'Pedidos 60d', pedidos90d: 'Pedidos 90d', pedidos180d: 'Pedidos 180d', frequenciaDias: 'Compra a cada (dias)', status120Dias: 'Situação 120 dias',
  recorrencia: 'Recompra', tendencia: 'Tendência', variacaoPedidosPct: 'Variação de pedidos (%)', ultimoOutcome: 'Último resultado', ultimoContatoEm: 'Último contato', diasDesdeUltimoContato: 'Dias desde o último contato', proximoRetornoEm: 'Próximo retorno', situacaoRetorno: 'Situação do retorno', emCooldownAte: 'Em espera até',
  faturamento30d: 'Faturamento 30d', faturamento60d: 'Faturamento 60d', faturamento90d: 'Faturamento 90d', faturamento180d: 'Faturamento 180d', ticketMedio: 'Ticket médio', variacaoFaturamentoPct: 'Variação de faturamento (%)', tipoOportunidade: 'Tipo de oportunidade', estadoOportunidade: 'Estado da oportunidade', prioridadeSugerida: 'Prioridade sugerida', ultimaCompra: 'Última compra', primeiraCompraEm: 'Primeira compra', tendenciaMetodo: 'Método da tendência', nome: 'Cliente', responsavel: 'Responsável' };

class ErroGateway extends Error { constructor(tipo, codigo) { super(codigo); this.tipo = tipo; this.codigo = codigo; } }
const falhaG = (t, c) => { throw new ErroGateway(t, c); };

/** Registro de agentes. Novos agentes entram aqui (contextBuilder + instructions + schema), sem tocar no resto do gateway. */
const AGENTES = {
  commercial: {
    agentType: 'commercial', instructions: INSTR.COMERCIAL, schema: RESPONSE_SCHEMA, schemaName: 'agente_comercial_resposta',
    autorizar: async (store, uid, cfg) => { let acesso; try { acesso = await CRM.perfilDeAcesso(store, uid); } catch (e) { if (e instanceof CRM.ErroCrm) falhaG(e.tipo, e.codigo); throw e; } return portaoPiloto(acesso, uid, cfg); },   // MESMA regra do CRM (gestor ou módulo operar/gestão; ativo; não bloqueado)
    carregar: (store, acesso, agoraIso) => CTX.carregarDados(store, acesso, agoraIso),
    montar: (dados, acesso, pergunta) => CTX.construirContexto({ candidatos: dados.candidatos, vendasPorGc: dados.vendasPorGc, estadosPorEntidade: dados.estadosPorEntidade, hoje: dados.hoje, gestao: acesso.gestao, pergunta, meta: dados.meta }),
  },
};

/**
 * FEATURE GATE do piloto (backend). Vem DEPOIS da autorização normal do CRM (que continua valendo, sem enfraquecer) e é independente do frontend.
 * AI_COMMERCIAL_PILOT: 'MANAGEMENT_ONLY' (padrão; também quando ausente) = só gestão (gestor / módulo de gestão do CRM) · 'OFF' = ninguém ·
 * 'MANAGEMENT_AND_SELLERS' = liberação FUTURA a vendedores (NÃO configurada; só testes) · qualquer outro valor = ninguém (fail closed). Vendedor NÃO tem acesso na fase de preview (SELLER_AI_ACCESS=NO), mesmo que o isolamento por vendedor
 * continue implementado e testado. AI_COMMERCIAL_PILOT_UIDS (opcional, lista de uids separados por vírgula): allowlist TEMPORÁRIA de preview;
 * se definida, só estes uids (que também sejam gestão) entram. Nenhum nome/e-mail fixo no código.
 */
function configPiloto(env = process.env) {
  const modo = String(env.AI_COMMERCIAL_PILOT || 'MANAGEMENT_ONLY').trim().toUpperCase();
  const uids = String(env.AI_COMMERCIAL_PILOT_UIDS || '').split(',').map(x => x.trim()).filter(Boolean);
  return { modo, uids };
}
function portaoPiloto(acesso, uid, cfg) {
  const c = cfg || configPiloto();
  if (c.modo !== 'MANAGEMENT_ONLY' && c.modo !== 'MANAGEMENT_AND_SELLERS') falhaG('permission-denied', 'FORA_DO_PILOTO');
  if (!acesso.gestao && c.modo !== 'MANAGEMENT_AND_SELLERS') falhaG('permission-denied', 'FORA_DO_PILOTO');   // vendedor: DENY durante o piloto
  if (c.uids && c.uids.length && !c.uids.includes(String(uid))) falhaG('permission-denied', 'FORA_DO_PILOTO');
  return acesso;
}

function validarPedido(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) falhaG('invalid-argument', 'PAYLOAD_INVALIDO');
  const extras = Object.keys(data).filter(k => !['agentType', 'modo', 'pergunta'].includes(k)); if (extras.length) falhaG('invalid-argument', 'CAMPOS_NAO_PERMITIDOS');   // ownerId/sellerId/customerId etc. nunca são aceitos: o servidor decide o escopo
  if (!AGENTES[data.agentType]) falhaG('invalid-argument', 'AGENTE_INVALIDO');
  if (!['resumo', 'pergunta', 'contagens', 'acesso'].includes(data.modo)) falhaG('invalid-argument', 'MODO_INVALIDO');   // 'contagens' = só o bloco determinístico (sem chamar a IA)
  if (data.modo === 'pergunta') { if (typeof data.pergunta !== 'string' || !data.pergunta.trim()) falhaG('invalid-argument', 'PERGUNTA_OBRIGATORIA'); if (Array.from(data.pergunta).length > PERGUNTA_MAX) falhaG('invalid-argument', 'PERGUNTA_GRANDE_DEMAIS'); }
  return { agentType: data.agentType, modo: data.modo, pergunta: data.modo !== 'pergunta' ? PERGUNTA_RESUMO : data.pergunta.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() };
}

/**
 * Executa um agente. Retorna SEMPRE o bloco determinístico (resumoDia, fallback); a parte de IA falha de forma isolada (ia.status).
 * deps: { store, apiKey, fetchImpl, agora(), modelo, precos, limites }
 */
async function executarAgente({ uid, data, deps }) {
  const { store } = deps; const agora = deps.agora ? deps.agora() : new Date(); const agoraIso = agora.toISOString();
  const pedido = validarPedido(data); const ag = AGENTES[pedido.agentType];
  const acesso = await ag.autorizar(store, uid, deps.piloto);                       // identidade e permissão vêm do servidor (CRM + gate do piloto)
  if (pedido.modo === 'acesso') return { ok: true, acesso: true, piloto: (deps.piloto || configPiloto()).modo };   // gate do frontend: sem dados, sem IA, sem consumo de limite
  let uso = null;
  if (pedido.modo !== 'contagens') { try { uso = await U.verificarLimite(store, uid, agora, deps.limites); } catch (e) { if (e instanceof U.LimiteExcedido) falhaG('resource-exhausted', e.codigo); throw e; } }   // limite só onde há custo de IA
  const dados = await ag.carregar(store, acesso, agoraIso);
  const montado = ag.montar(dados, acesso, pedido.pergunta);
  const aud = auditarContexto(montado.contexto, { gestao: acesso.gestao }); if (!aud.ok) falhaG('internal', 'CONTEXTO_FORA_DA_ALLOWLIST');   // nada fora da allowlist sai da MR4
  if (montado.bytes > LIMITES.MAX_CONTEXTO_BYTES) falhaG('failed-precondition', 'CONTEXTO_GRANDE_DEMAIS');
  const base = { agentType: pedido.agentType, modo: pedido.modo, geradoEm: agoraIso, hoje: dados.hoje, escopo: montado.contexto.escopo, resumoDia: montado.resumoDia, limitacoes: montado.contexto.limitacoes, frescor: montado.contexto.frescor, limitesUso: uso };
  const fallback = () => montado.fallback.map(x => ({ entidade: montado.mapa[x.ref].entidade, nome: montado.mapa[x.ref].nome, prioridade: x.prioridade, reasonCodes: x.reasonCodes.map(c => ({ code: c, label: MOTIVOS[c] })) }));
  const registrar = (resultado, extra = {}) => U.registrarUso(store, { uid, agentType: pedido.agentType, modo: pedido.modo, agora, contextoBytes: montado.bytes, clientes: Object.keys(montado.contexto.clientes).length + (montado.contexto.clienteEmFoco ? 1 : 0), perguntaChars: pedido.pergunta.length, resultado, ...extra }).catch(() => {});
  if (pedido.modo === 'contagens') return { ok: true, ...base, ia: { status: 'NAO_SOLICITADA' }, answer: null, customers: [], warnings: [], unavailable: [], dataFreshness: null, fallback: fallback() };
  if (!montado.resumoDia.clientesAnalisados) { await registrar('OK', { erro: null }); return { ok: true, ...base, ia: { status: 'SEM_DADOS' }, answer: 'Não encontrei clientes no seu escopo para analisar agora.', customers: [], warnings: [], unavailable: [], dataFreshness: null, fallback: [] }; }
  let r;
  try {
    r = await gerarEstruturado({ fetchImpl: deps.fetchImpl, apiKey: deps.apiKey, modelo: deps.modelo || MODELO_PADRAO, instructions: ag.instructions, schema: ag.schema, schemaName: ag.schemaName, input: JSON.stringify({ pergunta: montado.perguntaSegura != null ? montado.perguntaSegura : pedido.pergunta, contexto: montado.contexto }), maxOutputTokens: LIMITES.MAX_OUTPUT_TOKENS, timeoutMs: LIMITES.TIMEOUT_MS });
    const v = validarResposta(r.json, montado.contexto, montado.mapa);
    const custo = U.estimarCustoUSD(r.tokens, deps.precos);
    await registrar('OK', { latenciaMs: r.latenciaMs, modelo: r.modelo, tokens: r.tokens, custoUSD: custo });
    const customers = v.customers.map(c => { const m = montado.mapa[c.ref]; return { entidade: m.entidade, nome: m.nome, prioridade: m.prioridade, responsavel: acesso.gestao ? m.responsavel : null, reasonCodes: c.reasonCodes.map(x => ({ code: x, label: MOTIVOS[x] })), evidence: c.evidence.map(e => ({ metric: e.metric, label: METRICA_ROTULO[e.metric] || e.metric, value: e.value })) }; });
    return { ok: true, ...base, ia: { status: 'OK', modelo: r.modelo, latenciaMs: r.latenciaMs }, answer: v.answer, customers, warnings: v.warnings, unavailable: v.unavailable, dataFreshness: v.dataFreshness, fallback: [] };
  } catch (e) {
    const codigo = e instanceof ErroModelo || e instanceof RespostaInvalida ? e.codigo : 'ERRO_INTERNO_IA';
    await registrar('FALHA', { erro: String(codigo).slice(0, 60), latenciaMs: r ? r.latenciaMs : null, modelo: r ? r.modelo : null, tokens: r ? r.tokens : null });
    return { ok: true, ...base, ia: { status: 'INDISPONIVEL', motivo: codigo === 'IA_NAO_CONFIGURADA' ? 'IA_NAO_CONFIGURADA' : (e instanceof RespostaInvalida ? 'RESPOSTA_INVALIDA' : codigo === 'TIMEOUT' ? 'TIMEOUT' : codigo === 'RATE_LIMITED' ? 'PROVEDOR_OCUPADO' : 'PROVEDOR_INDISPONIVEL') }, answer: null, customers: [], warnings: [], unavailable: [], dataFreshness: null, fallback: fallback() };   // CRM segue normal; mostra só o determinístico
  }
}

/** Handler onCall: converte erros do gateway em HttpsError sem vazar detalhes. */
async function aiAgenteHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const store = opts.db || require('firebase-admin').firestore();
  const deps = { store, apiKey: opts.apiKey !== undefined ? opts.apiKey : process.env.OPENAI_API_KEY, fetchImpl: opts.fetchImpl || fetch, agora: opts.agora, modelo: opts.modelo || process.env.AI_MODEL || MODELO_PADRAO, precos: opts.precos, limites: opts.limites, piloto: opts.piloto };
  try { return await executarAgente({ uid: request.auth.uid, data: request.data, deps }); }
  catch (e) { if (e instanceof ErroGateway) throw new HttpsError(e.tipo, e.codigo); throw new HttpsError('internal', 'Falha no agente.'); }
}
module.exports = { configPiloto, portaoPiloto, AGENTES, LIMITES, PERGUNTA_MAX, PERGUNTA_RESUMO, METRICA_ROTULO, ErroGateway, validarPedido, executarAgente, aiAgenteHandler };
