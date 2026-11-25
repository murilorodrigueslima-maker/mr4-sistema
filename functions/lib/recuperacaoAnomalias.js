'use strict';
/**
 * Recuperação SEGURA de anomalias de volume do sync (Etapa A · recuperação) — especificação aprovada.
 *
 * Princípios: (1) NENHUMA anomalia comercial é aprovada automaticamente; (2) a referência nunca é reduzida sem aceite humano;
 * (3) o aceite é vinculado à ASSINATURA do resultado observado, expira (24 h), tem cooldown (30 min) e é de USO ÚNICO;
 * (4) a confirmação exige NOVA leitura completa com a mesma assinatura; (5) tudo é auditado, append-only (create apenas);
 * (6) falha ao gravar estado/auditoria ⇒ fail-closed (não publica). Só contagens/hashes — nenhum dado do negócio ou de cliente.
 *
 * Funções PURAS (decisões) + adaptador Firestore injetável. Estado em `gc_sync_estado/{bloco}`; auditoria em `gc_sync_auditoria/{id}`.
 */
const crypto = require('crypto');

const BLOCOS = Object.freeze(['vendas', 'estoque', 'catalogo', 'financeiro', 'pedidos']);
const H = 3600000, MIN = 60000;
const PARAMS = Object.freeze({
  minLeituras: 3, minHoras: 6, minHorasExtremo: 8, tolPct: 5, tolAbsMin: 2, blocoPequeno: 40, sobreposicaoMin: 0.9,
  validadeMs: 24 * H, cooldownMs: 30 * MIN, maxLeituras: 10, quedaExtrema: 0.95, minMotivo: 20, maxMotivo: 200, palavraExtrema: 'CONFIRMO-QUEDA-EXTREMA',
});
const ESTADOS = Object.freeze({ NORMAL: 'NORMAL', QUARENTENA: 'QUARENTENA', AGUARDANDO: 'AGUARDANDO_CONFIRMACAO', PENDENTE: 'APROVACAO_PENDENTE' });
const COL_ESTADO = 'gc_sync_estado', COL_AUDITORIA = 'gc_sync_auditoria';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const curto = id => sha(String(id)).slice(0, 6);

/** assinatura = SHA-256(bloco | escopo | janelaInicio | janelaFim | total | IDs ordenados). Só os 8 primeiros caracteres vão a logs/estado. */
function assinatura({ bloco, escopo = '', janelaInicio = '', janelaFim = '', total, ids = [] }) {
  return sha([bloco, escopo, janelaInicio, janelaFim, total, [...ids].map(String).sort().join(',')].join('|'));
}
const a8 = assinaturaCompleta => String(assinaturaCompleta).slice(0, 8);

function sobreposicao(idsA = [], idsB = []) {
  const A = new Set(idsA.map(String)), B = new Set(idsB.map(String)); if (!A.size && !B.size) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(A.size, B.size);
}

/** Estado inicial (NORMAL, sem leituras). */
const estadoNovo = bloco => ({ bloco, estado: ESTADOS.NORMAL, motivo: null, referencia: null, observado: null, janelaDias: null, escopo: null, leituras: [], idsPrimeira: [], falhasSeguidas: 0, estavel: false, estavelDesde: null, aprovacao: null });

/** Queda relativa (0..1) — null se não há referência. */
function quedaPct(referencia, observado) { return Number.isFinite(referencia) && referencia > 0 ? Math.max(0, (referencia - observado) / referencia) : null; }
const extremo = e => { const q = quedaPct(e.referencia, e.observado); return q !== null && q > PARAMS.quedaExtrema; };

/**
 * Estabilidade: ≥ 3 leituras COMPLETAS (execuções distintas), ≥ 6 h (8 h se queda extrema) entre a primeira e a última,
 * variação ≤ 5% da média (blocos < 40 itens: tolerância absoluta mínima de ±2), sobreposição de IDs ≥ 90% (primeira × última)
 * e reconciliação por partição ok em TODAS as leituras em que ela se aplica (particaoOk === false reprova; null = não se aplica).
 */
function avaliarEstabilidade(estado, { idsAtuais = null } = {}) {
  const L = (estado.leituras || []).filter(l => l && l.completa === true);
  const motivos = [];
  if (L.length < PARAMS.minLeituras) motivos.push('POUCAS_LEITURAS');
  if (L.length >= 2) {
    const horas = (L[L.length - 1].em - L[0].em) / H, minimo = extremo(estado) ? PARAMS.minHorasExtremo : PARAMS.minHoras;
    if (horas < minimo) motivos.push('JANELA_CURTA');
    const totais = L.map(l => l.total), media = totais.reduce((s, x) => s + x, 0) / totais.length;
    const tol = media < PARAMS.blocoPequeno ? Math.max(PARAMS.tolAbsMin, media * PARAMS.tolPct / 100) : media * PARAMS.tolPct / 100;
    if (totais.some(t => Math.abs(t - media) > tol)) motivos.push('VARIACAO_ALTA');
    if (idsAtuais && estado.idsPrimeira && estado.idsPrimeira.length) {
      const atuaisCurtos = idsAtuais.map(curto);
      if (sobreposicao(estado.idsPrimeira, atuaisCurtos) < PARAMS.sobreposicaoMin) motivos.push('SOBREPOSICAO_BAIXA');
    }
  }
  if (L.some(l => l.particaoOk === false)) motivos.push('PARTICAO_FALHOU');
  return { estavel: motivos.length === 0, motivos };
}

const evento = (tipo, e, x = {}) => ({ evento: tipo, bloco: e.bloco, ...x });

/**
 * Registra uma leitura COMPLETA bloqueada pela proteção de queda. Nunca publica. Entra/permanece em quarentena e reavalia estabilidade.
 * `leitura` = { agoraMs, total, ids, escopo, janelaInicio, janelaFim, janelaDias, referencia, motivo, particaoOk (true|false|null) }
 * Devolve { estado, eventos[] }.
 */
function registrarBloqueio(estadoAnt, leitura) {
  const e = JSON.parse(JSON.stringify(estadoAnt || estadoNovo(leitura.bloco))); const eventos = [];
  const sigCompleta = assinatura({ bloco: e.bloco, escopo: leitura.escopo, janelaInicio: leitura.janelaInicio, janelaFim: leitura.janelaFim, total: leitura.total, ids: leitura.ids || [] });
  const sig8 = a8(sigCompleta);
  const mudouEscopo = e.escopo && leitura.escopo && e.escopo !== leitura.escopo;
  if (e.estado === ESTADOS.NORMAL || mudouEscopo) {
    if (mudouEscopo) eventos.push(evento('ESCOPO_ALTERADO', e, { antes: e.referencia, depois: leitura.referencia, motivo: `${e.escopo}->${leitura.escopo}` }));
    Object.assign(e, estadoNovo(e.bloco), { estado: ESTADOS.QUARENTENA });
    eventos.push(evento('ENTROU_QUARENTENA', e, { antes: leitura.referencia, depois: leitura.total, assinatura8: sig8, motivo: leitura.motivo }));
  }
  e.motivo = leitura.motivo || e.motivo; e.referencia = leitura.referencia ?? e.referencia; e.observado = leitura.total; e.janelaDias = leitura.janelaDias ?? e.janelaDias; e.escopo = leitura.escopo ?? e.escopo;
  e.falhasSeguidas = 0;
  e.leituras = [...(e.leituras || []), { em: leitura.agoraMs, total: leitura.total, assinatura8: sig8, completa: true, particaoOk: leitura.particaoOk === undefined ? null : leitura.particaoOk }].slice(-PARAMS.maxLeituras);
  if (!e.idsPrimeira || e.idsPrimeira.length === 0) e.idsPrimeira = (leitura.ids || []).map(curto);
  // um resultado diferente do aceite solicitado invalida a aprovação pendente (vinculada à assinatura)
  if (e.aprovacao && !e.aprovacao.consumidoEm && e.aprovacao.assinatura8 !== sig8 && e.estado === ESTADOS.PENDENTE) {
    eventos.push(evento('APROVACAO_REJEITADA', e, { assinatura8: sig8, motivo: 'RESULTADO_MUDOU' })); e.aprovacao = null; e.estado = ESTADOS.QUARENTENA;
  }
  const est = avaliarEstabilidade(e, { idsAtuais: leitura.ids || [] });
  const antesEstavel = e.estavel;
  e.estavel = est.estavel; e.estavelDesde = est.estavel ? (antesEstavel ? e.estavelDesde : leitura.agoraMs) : null;
  if (est.estavel && !antesEstavel) eventos.push(evento('ESTAVEL', e, { assinatura8: sig8, depois: leitura.total }));
  if (e.estado === ESTADOS.QUARENTENA && est.estavel) e.estado = ESTADOS.AGUARDANDO;
  if (e.estado === ESTADOS.AGUARDANDO && !est.estavel) e.estado = ESTADOS.QUARENTENA;
  // expiração da aprovação pendente
  if (e.aprovacao && !e.aprovacao.consumidoEm && leitura.agoraMs > e.aprovacao.expiraEm) { eventos.push(evento('APROVACAO_EXPIRADA', e, { assinatura8: e.aprovacao.assinatura8 })); e.aprovacao = null; e.estado = est.estavel ? ESTADOS.AGUARDANDO : ESTADOS.QUARENTENA; }
  return { estado: e, eventos, assinatura8: sig8, assinaturaCompleta: sigCompleta, estabilidade: est };
}

/** Falha/leitura incompleta: só conta falhas seguidas (NUNCA estabiliza nem vira leitura). */
function registrarFalha(estadoAnt, bloco) {
  const e = JSON.parse(JSON.stringify(estadoAnt || estadoNovo(bloco))); if (e.estado === ESTADOS.NORMAL) return { estado: e, eventos: [] };
  e.falhasSeguidas = (e.falhasSeguidas || 0) + 1; return { estado: e, eventos: [] };
}

/** Leitura normal (publicação liberada pela proteção) com bloco em quarentena ⇒ SAIU_QUARENTENA e volta a NORMAL (sem aceite necessário). */
function registrarNormal(estadoAnt, { bloco, total }) {
  if (!estadoAnt || estadoAnt.estado === ESTADOS.NORMAL) return { estado: estadoAnt || null, eventos: [] };
  const e = estadoNovo(bloco); return { estado: e, eventos: [evento('SAIU_QUARENTENA', e, { depois: total, motivo: 'VOLUME_NORMALIZOU' })] };
}

const entradaMotivo = m => typeof m === 'string' && !/[\r\n]/.test(m) && m.trim().length >= PARAMS.minMotivo && m.length <= PARAMS.maxMotivo;
const ehA8 = s => /^[0-9a-f]{8}$/.test(String(s || ''));

/** Etapa A — SOLICITAR o aceite (só execução manual). Não publica nada. */
function solicitarAceite(estado, { assinatura8, motivo, ator, agoraMs, runId = null, exigirSegundoAtor = false }) {
  const rej = codigo => ({ ok: false, codigo, estado, eventos: [evento('APROVACAO_REJEITADA', estado || {}, { motivo: codigo })] });
  if (!estado || estado.estado !== ESTADOS.AGUARDANDO) return rej('ESTADO_INVALIDO');
  if (!ehA8(assinatura8)) return rej('ASSINATURA_INVALIDA');
  const ult = estado.leituras[estado.leituras.length - 1]; if (!ult || ult.assinatura8 !== assinatura8) return rej('ASSINATURA_DIFERENTE');
  if (!entradaMotivo(motivo)) return rej('MOTIVO_INVALIDO');
  if (extremo(estado) && !String(motivo).includes(PARAMS.palavraExtrema)) return rej('PALAVRA_EXTREMA_AUSENTE');
  const e = JSON.parse(JSON.stringify(estado));
  e.estado = ESTADOS.PENDENTE;
  e.aprovacao = { id: `${e.bloco}-${agoraMs}`, assinatura8, solicitadoEm: agoraMs, solicitadoPor: String(ator || 'desconhecido').slice(0, 60), expiraEm: agoraMs + PARAMS.validadeMs, confirmavelApos: agoraMs + PARAMS.cooldownMs, motivoTexto: String(motivo).trim(), consumidoEm: null, runId };
  return { ok: true, codigo: 'APROVACAO_SOLICITADA', estado: e, aprovacaoId: e.aprovacao.id, eventos: [evento('APROVACAO_SOLICITADA', e, { assinatura8, ator: e.aprovacao.solicitadoPor, run_id: runId })] };
}

/**
 * Etapa B — CONFIRMAR o aceite. Exige: dentro da validade; passado o cooldown; não consumida; assinatura igual à do aceite;
 * NOVA leitura completa agora com a MESMA assinatura (resultado idêntico); reconciliação por partição ok; (opcional) outro ator.
 * Se tudo valer ⇒ { publicar:true } e a aprovação é CONSUMIDA (uso único) — o chamador publica pelo caminho normal.
 */
function confirmarAceite(estado, { id, assinatura8, ator, agoraMs, leituraAtual, runId = null, exigirSegundoAtor = false }) {
  const rej = codigo => ({ ok: false, publicar: false, codigo, estado, eventos: [evento('APROVACAO_REJEITADA', estado || {}, { motivo: codigo, run_id: runId })] });
  if (!estado || estado.estado !== ESTADOS.PENDENTE || !estado.aprovacao) return rej('SEM_APROVACAO_PENDENTE');
  const ap = estado.aprovacao;
  if (ap.consumidoEm) return rej('APROVACAO_JA_CONSUMIDA');
  if (agoraMs > ap.expiraEm) { const e = JSON.parse(JSON.stringify(estado)); e.aprovacao = null; e.estado = ESTADOS.AGUARDANDO; return { ok: false, publicar: false, codigo: 'APROVACAO_EXPIRADA', estado: e, eventos: [evento('APROVACAO_EXPIRADA', e, { assinatura8: ap.assinatura8, run_id: runId })] }; }
  if (id !== ap.id) return rej('ID_DIFERENTE');
  if (!ehA8(assinatura8) || assinatura8 !== ap.assinatura8) return rej('ASSINATURA_DIFERENTE');
  if (agoraMs < ap.confirmavelApos) return rej('COOLDOWN');
  if (exigirSegundoAtor && String(ator) === ap.solicitadoPor) return rej('MESMO_ATOR');
  if (!leituraAtual || leituraAtual.completa !== true) return rej('LEITURA_ATUAL_INCOMPLETA');
  if (leituraAtual.assinatura8 !== ap.assinatura8) return rej('RESULTADO_MUDOU');
  if (leituraAtual.particaoOk === false) return rej('PARTICAO_FALHOU');
  const e = JSON.parse(JSON.stringify(estado)); e.aprovacao = { ...ap, consumidoEm: agoraMs, confirmadoPor: String(ator || 'desconhecido').slice(0, 60) };
  const novo = estadoNovo(e.bloco);   // após publicar, o bloco volta a NORMAL (a nova _meta é a nova referência); o registro da aprovação fica na auditoria
  return { ok: true, publicar: true, codigo: 'APROVACAO_CONFIRMADA', estado: novo, aprovacaoConsumida: e.aprovacao,
    eventos: [evento('APROVACAO_CONFIRMADA', e, { assinatura8: ap.assinatura8, ator: e.aprovacao.confirmadoPor, run_id: runId, antes: estado.referencia, depois: estado.observado }), evento('SAIU_QUARENTENA', e, { motivo: 'ACEITE_HUMANO', depois: estado.observado })] };
}

/** Validação das entradas do workflow_dispatch (sem execução agendada): acao ∈ {normal, solicitar_aceite, confirmar_aceite}. */
function validarEntradas({ acao = 'normal', bloco = '', assinatura8 = '', motivo = '', aprovacaoId = '' } = {}) {
  if (!['normal', 'solicitar_aceite', 'confirmar_aceite'].includes(acao)) return { ok: false, codigo: 'ACAO_INVALIDA' };
  if (acao === 'normal') return { ok: true, acao };
  if (!BLOCOS.includes(bloco)) return { ok: false, codigo: 'BLOCO_INVALIDO' };
  if (!ehA8(assinatura8)) return { ok: false, codigo: 'ASSINATURA_INVALIDA' };
  if (acao === 'solicitar_aceite' && !entradaMotivo(motivo)) return { ok: false, codigo: 'MOTIVO_INVALIDO' };
  if (acao === 'confirmar_aceite' && !/^[a-z]+-\d{10,14}$/.test(String(aprovacaoId))) return { ok: false, codigo: 'ID_INVALIDO' };
  return { ok: true, acao, bloco, assinatura8, motivo, aprovacaoId };
}

// ── adaptador Firestore (fail-closed) ─────────────────────────────────────────────────────────────────────────────
let _seq = 0;
async function lerEstado(db, bloco) { const s = await db.collection(COL_ESTADO).doc(bloco).get(); return s.exists ? s.data() : null; }
async function gravarEstado(db, e) { await db.collection(COL_ESTADO).doc(e.bloco).set(e); }
async function auditar(db, ev, agoraMs, ator) {
  const id = `${ev.bloco}-${agoraMs}-${String(++_seq).padStart(3, '0')}`;
  await db.collection(COL_AUDITORIA).doc(id).create({ ...ev, ator: ev.ator || ator || 'sistema', em: agoraMs });   // create-only: nunca update/delete
  return id;
}

module.exports = { BLOCOS, PARAMS, ESTADOS, COL_ESTADO, COL_AUDITORIA, assinatura, a8, sobreposicao, estadoNovo, quedaPct, avaliarEstabilidade, registrarBloqueio, registrarFalha, registrarNormal, solicitarAceite, confirmarAceite, validarEntradas, lerEstado, gravarEstado, auditar, curto };
