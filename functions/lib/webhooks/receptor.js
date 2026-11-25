'use strict';
/**
 * Receptor de WEBHOOKS do GestãoClick (arquitetura aprovada; NÃO ATIVO em produção).
 *
 * Segurança: endpoint isolado, só POST, corpo CRU, assinatura HMAC-SHA256 (`X-Webhook-Assinatura: t=<epoch>,v1=<hex>` sobre `t + "." + corpo`)
 * em tempo constante, janela anti-replay de 5 min, idempotência por `X-Webhook-Id` (create-only), validação da LOJA ATIVA (262759),
 * resposta 2xx rápida (só grava e responde; processamento é assíncrono), chave de desligamento (kill switch) e modos:
 *   DESLIGADO (padrão; responde 200 sem gravar) · RECEPCAO (grava o aviso; não processa) · SOMBRA (grava + processa em sombra: só COMPARA, sem efeitos) · ATIVO (reservado: exige autorização).
 * Privacidade: nada de nome/CPF/valores/corpo cru — só ids, evento, loja, recurso, horários, tentativa e SHA-256 do corpo.
 */
const crypto = require('crypto');
const { LOJA_ATIVA_ID, LOJAS_BLOQUEADAS } = require('../gcHttp');

const EVENTOS = Object.freeze(['venda.cadastrada', 'venda.situacao_alterada', 'recebimento.baixado', 'recebimento.estornado', 'pagamento.baixado', 'pagamento.estornado']);
const RECURSO_POR_EVENTO = Object.freeze({ 'venda.cadastrada': 'vendas', 'venda.situacao_alterada': 'vendas', 'recebimento.baixado': 'recebimentos', 'recebimento.estornado': 'recebimentos', 'pagamento.baixado': 'pagamentos', 'pagamento.estornado': 'pagamentos' });
const MODOS = Object.freeze(['DESLIGADO', 'RECEPCAO', 'SOMBRA', 'ATIVO']);
const JANELA_REPLAY_S = 300, MAX_CORPO = 64 * 1024, CACHE_CONFIG_MS = 30000;
const COL_EVENTOS = 'gc_webhook_eventos', COL_CONFIG = 'gc_webhook_config', DOC_CONFIG = 'estado', COL_STATUS = 'gc_webhook_status';

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const igualConstante = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

/** Valida `t=<epoch>,v1=<hex>` e o HMAC sobre `t + "." + corpoCru`. Devolve { ok, codigo }. */
function verificarAssinatura({ cabecalho, corpoCru, segredo, agoraMs }) {
  if (!segredo) return { ok: false, codigo: 'SEGREDO_NAO_CONFIGURADO' };
  const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(String(cabecalho || '').trim());
  if (!m) return { ok: false, codigo: 'ASSINATURA_MALFORMADA' };
  const t = Number(m[1]);
  if (Math.abs(agoraMs / 1000 - t) > JANELA_REPLAY_S) return { ok: false, codigo: 'FORA_DA_JANELA' };
  const esperado = crypto.createHmac('sha256', segredo).update(`${m[1]}.`).update(corpoCru).digest('hex');
  return igualConstante(esperado, m[2]) ? { ok: true, codigo: 'OK' } : { ok: false, codigo: 'ASSINATURA_INVALIDA' };
}

const idTexto = v => (typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_.:-]{1,64}$/.test(String(v)) ? String(v) : null;

/** Valida o formato do aviso e extrai só o que será guardado. */
function normalizarAviso(corpo, cab) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return { ok: false, codigo: 'CORPO_INVALIDO' };
  const id = idTexto(corpo.id), evento = String(corpo.evento || ''), lojaId = idTexto(corpo.loja_id), empresaId = idTexto(corpo.empresa_id), dadosId = idTexto(corpo.dados && corpo.dados.id);
  if (!id) return { ok: false, codigo: 'ID_INVALIDO' };
  if (cab.id && cab.id !== id) return { ok: false, codigo: 'ID_DIVERGENTE' };
  if (!EVENTOS.includes(evento)) return { ok: false, codigo: 'EVENTO_NAO_SUPORTADO', evento: evento.slice(0, 40), id };
  if (cab.evento && cab.evento !== evento) return { ok: false, codigo: 'EVENTO_DIVERGENTE', id };
  if (!lojaId) return { ok: false, codigo: 'LOJA_AUSENTE', id };
  if (!dadosId) return { ok: false, codigo: 'REGISTRO_AUSENTE', id };
  const rec = RECURSO_POR_EVENTO[evento];
  if (corpo.recurso !== undefined && corpo.recurso !== null && String(corpo.recurso) !== rec && String(corpo.recurso) !== rec.replace(/s$/, '')) return { ok: false, codigo: 'RECURSO_INCOMPATIVEL', id };
  const ocorrido = typeof corpo.ocorrido_em === 'string' ? corpo.ocorrido_em.slice(0, 40) : null;
  return { ok: true, aviso: { id, evento, recurso: rec, empresa_id: empresaId, loja_id: lojaId, registro_id: dadosId, codigo: idTexto(corpo.dados && corpo.dados.codigo), ocorrido_em: ocorrido } };
}

/** Configuração com cache curto (evita 1 leitura por aviso). Ausente/ilegível ⇒ DESLIGADO (fail-closed). */
function criarLeitorConfig({ db, agora = () => Date.now() }) {
  let cache = null, quando = 0;
  return async function ler() {
    const t = agora(); if (cache && t - quando < CACHE_CONFIG_MS) return cache;
    let cfg = { modo: 'DESLIGADO', lojasPermitidas: [LOJA_ATIVA_ID], eventosAtivos: EVENTOS.slice() };
    try { const s = await db.collection(COL_CONFIG).doc(DOC_CONFIG).get(); if (s.exists) { const d = s.data(); cfg = { modo: MODOS.includes(d.modo) ? d.modo : 'DESLIGADO', lojasPermitidas: Array.isArray(d.lojasPermitidas) && d.lojasPermitidas.length ? d.lojasPermitidas.map(String) : [LOJA_ATIVA_ID], eventosAtivos: Array.isArray(d.eventosAtivos) ? d.eventosAtivos.filter(e => EVENTOS.includes(e)) : EVENTOS.slice() }; } }
    catch (_) { /* ilegível ⇒ DESLIGADO */ }
    cfg.lojasPermitidas = cfg.lojasPermitidas.filter(l => !LOJAS_BLOQUEADAS.includes(l));   // a loja desativada NUNCA é permitida, mesmo por configuração
    cache = cfg; quando = t; return cfg;
  };
}

/**
 * Processa UMA requisição (função pura-ish; I/O injetado). Devolve { status, corpo } — nunca lança.
 * req = { metodo, cabecalhos (minúsculos), corpoCru (Buffer), }
 */
async function tratarRequisicao({ req, db, segredo, lerConfig, agora = () => Date.now(), log = () => {}, serverTimestamp = () => Date.now() }) {
  const resp = (status, codigo, extra = {}) => { log({ webhook: codigo, status, ...extra }); return { status, corpo: { ok: status < 300, codigo } }; };
  try {
    if (req.metodo !== 'POST') return resp(405, 'METODO_NAO_PERMITIDO');
    const cfg = await lerConfig();
    if (cfg.modo === 'DESLIGADO') return resp(200, 'DESLIGADO');                       // kill switch: não valida, não grava (o GC considera entregue)
    const corpoCru = Buffer.isBuffer(req.corpoCru) ? req.corpoCru : Buffer.from(String(req.corpoCru || ''));
    if (corpoCru.length === 0 || corpoCru.length > MAX_CORPO) return resp(413, 'CORPO_FORA_DO_LIMITE');
    const agoraMs = agora();
    const ass = verificarAssinatura({ cabecalho: req.cabecalhos['x-webhook-assinatura'], corpoCru, segredo, agoraMs });
    if (!ass.ok) return resp(ass.codigo === 'SEGREDO_NAO_CONFIGURADO' ? 503 : 401, ass.codigo);
    let corpo; try { corpo = JSON.parse(corpoCru.toString('utf8')); } catch (_) { return resp(400, 'JSON_INVALIDO'); }
    const cab = { id: idTexto(req.cabecalhos['x-webhook-id']), evento: String(req.cabecalhos['x-webhook-evento'] || '') || null };
    const n = normalizarAviso(corpo, cab);
    if (!n.ok) return resp(n.codigo === 'EVENTO_NAO_SUPORTADO' ? 200 : 400, n.codigo, { id: n.id, evento: n.evento });   // evento não suportado: entregue (sem reprocesso do GC)
    const a = n.aviso;
    if (!cfg.eventosAtivos.includes(a.evento)) return resp(200, 'EVENTO_DESATIVADO', { id: a.id, evento: a.evento });
    if (!cfg.lojasPermitidas.includes(a.loja_id)) {                                      // outra loja (ex.: FOCUS PARTS): registra só o fato, ignora o conteúdo
      return resp(200, 'LOJA_IGNORADA', { id: a.id, evento: a.evento, loja_id: a.loja_id });
    }
    const tentativa = Number(req.cabecalhos['x-webhook-tentativa']); const ref = db.collection(COL_EVENTOS).doc(a.id);
    const doc = { ...a, tentativa: Number.isInteger(tentativa) && tentativa >= 1 && tentativa <= 20 ? tentativa : 1, corpo_sha256: sha256(corpoCru), recebido_em: serverTimestamp(), recebido_ms: agoraMs, modo: cfg.modo,
      status: cfg.modo === 'RECEPCAO' ? 'RECEBIDO' : 'PENDENTE_SOMBRA', resultado: null };
    try { await ref.create(doc); }
    catch (e) { if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) return resp(200, 'DUPLICADO', { id: a.id, evento: a.evento }); throw e; }
    return resp(200, 'RECEBIDO', { id: a.id, evento: a.evento, loja_id: a.loja_id, tentativa: doc.tentativa });
  } catch (e) {
    return resp(500, 'ERRO_INTERNO', { erro: String((e && e.code) || (e && e.name) || 'ERRO').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) });   // 5xx ⇒ o GC repete (idempotente)
  }
}

/**
 * Processamento ASSÍNCRONO em SOMBRA: busca o registro na API (GET /{recurso}/{id}, já com loja_id=262759) e só COMPARA existência/loja.
 * NÃO escreve em nenhuma coleção de negócio. Resultado fica no próprio evento. `buscar` = (recurso, id) → {status} | lança.
 */
async function processarSombra({ db, id, buscar, agora = () => Date.now() }) {
  const ref = db.collection(COL_EVENTOS).doc(id); const s = await ref.get(); if (!s.exists) return { ok: false, codigo: 'EVENTO_INEXISTENTE' };
  const e = s.data(); if (e.status !== 'PENDENTE_SOMBRA') return { ok: true, codigo: 'JA_PROCESSADO' };
  let resultado;
  try { const r = await buscar(e.recurso, e.registro_id); resultado = r && r.status === 404 ? 'ORIGEM_INDISPONIVEL' : (r && r.loja_id && String(r.loja_id) !== LOJA_ATIVA_ID ? 'LOJA_DIVERGENTE' : 'CONFERIDO'); }
  catch (err) { resultado = 'FALHA_CONSULTA'; }
  await ref.set({ status: resultado === 'FALHA_CONSULTA' ? 'PENDENTE_SOMBRA' : 'SOMBRA_CONCLUIDA', resultado, processado_ms: agora() }, { merge: true });
  return { ok: true, codigo: resultado };
}


/**
 * Reprocessamento de pendentes em SOMBRA (varredura periódica): eventos cuja consulta falhou (FALHA_CONSULTA) voltam a ser tentados,
 * no máximo `maxTentativas` vezes; depois ficam SOMBRA_FALHA (visível para conferência — nunca descartados nem apagados).
 */
async function reprocessarPendentes({ db, buscar, agora = () => Date.now(), maxTentativas = 5, esperaMinMs = 5 * 60000, limite = 50 }) {
  const snap = await db.collection(COL_EVENTOS).where('status', '==', 'PENDENTE_SOMBRA').limit(limite).get();
  let tentados = 0, falhas = 0;
  for (const doc of snap.docs) {
    const e = doc.data(); if (agora() - (e.recebido_ms || 0) < esperaMinMs) continue;
    const n = (e.tentativas_sombra || 0) + 1; tentados++;
    if (n > maxTentativas) { await db.collection(COL_EVENTOS).doc(doc.id).set({ status: 'SOMBRA_FALHA', resultado: 'FALHA_CONSULTA_DEFINITIVA' }, { merge: true }); falhas++; continue; }
    await db.collection(COL_EVENTOS).doc(doc.id).set({ tentativas_sombra: n }, { merge: true });
    await processarSombra({ db, id: doc.id, buscar, agora });
  }
  return { tentados, falhas };
}

/**
 * Comparação SOMBRA × POLLING: cada evento CONFERIDO de venda deve existir no espelho do polling (`existeNoPolling(recurso, id)`).
 * Só contagens. Divergências são esperadas por defasagem do polling (a cada ~2 h): `atrasoMs` separa "ainda cedo" de "ausente de fato".
 */
async function compararComPolling({ db, existeNoPolling, agora = () => Date.now(), atrasoMs = 3 * 3600000, limite = 500 }) {
  const snap = await db.collection(COL_EVENTOS).where('status', '==', 'SOMBRA_CONCLUIDA').limit(limite).get();
  const r = { total: 0, no_polling: 0, ausente_ainda_cedo: 0, ausente_apos_atraso: 0, origem_indisponivel: 0, loja_divergente: 0 };
  for (const d of snap.docs) {
    const e = d.data(); r.total++;
    if (e.resultado === 'ORIGEM_INDISPONIVEL') { r.origem_indisponivel++; continue; }          // venda excluída na origem: preservar histórico, sinalizar (D2) — nada é apagado
    if (e.resultado === 'LOJA_DIVERGENTE') { r.loja_divergente++; continue; }
    if (await existeNoPolling(e.recurso, e.registro_id)) r.no_polling++;
    else if (agora() - (e.recebido_ms || 0) < atrasoMs) r.ausente_ainda_cedo++; else r.ausente_apos_atraso++;
  }
  return r;
}

/** Monitoramento de silêncio: com o webhook ATIVO/SOMBRA, sem nenhum aviso há ≥ 24 h ⇒ alerta (o GC pausa o endereço após falhas repetidas). */
function avaliarSilencio({ modo, ultimoEventoMs, agoraMs, limiteMs = 24 * 3600000 }) {
  if (!['SOMBRA', 'ATIVO'].includes(modo)) return { alerta: false, motivo: 'MODO_SEM_MONITORAMENTO' };
  if (!Number.isFinite(ultimoEventoMs)) return { alerta: true, motivo: 'NUNCA_RECEBEU' };
  return agoraMs - ultimoEventoMs >= limiteMs ? { alerta: true, motivo: 'SILENCIO_24H' } : { alerta: false, motivo: 'OK' };
}

module.exports = { reprocessarPendentes, compararComPolling, avaliarSilencio, EVENTOS, MODOS, JANELA_REPLAY_S, COL_EVENTOS, COL_CONFIG, COL_STATUS, verificarAssinatura, normalizarAviso, criarLeitorConfig, tratarRequisicao, processarSombra, sha256 };
