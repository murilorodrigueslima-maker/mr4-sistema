'use strict';
// N35.11 — Cloud Function callables: operação canária da Fila Comercial
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   PROD_WRITES=interacoes_fila SOMENTE (Admin SDK, transação)
//   CLIENT_WRITES_TO_CLIENTES=0
//   CLIENT_WRITES_TO_PERFIS_360=0
//   CAP10_ACTIVATED=NO
//   AUTO_NEW_OPPORTUNITY=NO (N35.14: estado nasce só no 1º claim de oportunidade atribuída ao próprio vendedor)
//
// Arquitetura: frontend envia INTENÇÃO → servidor autentica, valida permissão,
// carrega estado, valida transição, aplica máquina de estado, transaciona, devolve resultado.

const { HttpsError } = require('firebase-functions/v2/https');
const admin          = require('firebase-admin');
const {
  claimOportunidade,
  releaseOportunidade,
  releaseExpiredClaim,
  registrarOutcome,
  isClaimExpired,
  criarEstadoInicial,
  dataComercial,
  OUTCOMES,
  ESTADOS,
  EVENT_TYPES,
  isCooledDown,
  normalizarNota,
} = require('./filaOperacional');
const { sanitizeCommercialDisplayName } = require('./nomeExibicao');

const COLL = 'interacoes_fila';
const WORKLIST_COLL = 'fila_comercial';
const WORKLIST_DOC = 'worklist';
const OPP_ID_RE = /^[0-9a-f]{16}$/;
const ENTITY_RE = /^(MR4_LINKED|GC_NATIVE):.+$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() { return admin.firestore(); }

// CRM 2.0 F1: relógio injetável só para testes (onCall passa `request`; um 2º argumento sem {now: fn} é ignorado)
function agoraIso(opts) { return (opts && typeof opts.now === 'function' ? opts.now() : new Date()).toISOString(); }
const HORIZONTE_RETORNO_DIAS = 180;
/** YYYY-MM-DD de calendário real (rejeita 2026-02-31). */
function dataValida(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(ymd + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === ymd;
}
function somarDiasYmd(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/**
 * CRM 2.0 F1 — dono reservado de um estado existente, verificado no SERVIDOR:
 * follow-up aberto (não concluído, sem cooldown ativo, com nextFollowUpAt) pertence ao autor do último resultado.
 * É a mesma regra que o gerador usa para devolver o retorno ao dono (dailyWorklist.compromissosPorEntidade).
 */
function donoReservado(estado, isoNow) {
  if (!estado || estado.estado === ESTADOS.CONCLUIDA || !estado.nextFollowUpAt) return null;
  if (isCooledDown(estado, isoNow)) return null;
  const outs = (estado.eventos || []).filter(e => e && e.tipo === EVENT_TYPES.OUTCOME_REGISTERED);
  return outs.length ? (outs[outs.length - 1].operadorId || null) : null;
}

/**
 * Verifica autenticação + permissão fila-comercial.
 * Retorna nome do operador (display) ou lança HttpsError.
 * Custo: 2 leituras (users + sistema_usuarios).
 */
async function verificarPermissaoFila(uid) {
  const store = db();
  const [userSnap, sysSnap] = await Promise.all([
    store.collection('users').doc(uid).get(),
    store.collection('sistema_usuarios').doc(uid).get(),
  ]);

  if (!userSnap.exists) throw new HttpsError('not-found', 'Usuário não encontrado.');
  const user = userSnap.data();
  if (!user.ativo) throw new HttpsError('permission-denied', 'Conta inativa.');
  // Dual-role (N35.12): gestor ou funcionario com perfil administrativo válido
  if (user.role !== 'gestor' && user.role !== 'funcionario') {
    throw new HttpsError('permission-denied', 'Acesso negado: role insuficiente.');
  }

  if (!sysSnap.exists) throw new HttpsError('permission-denied', 'Perfil de sistema não encontrado.');
  const sys = sysSnap.data();
  if (sys.bloqueado === true) throw new HttpsError('permission-denied', 'Conta bloqueada.');
  // N35.12S: OPERAÇÃO requer módulo explícito. admin=true e fila-comercial genérico NÃO concedem acesso operacional.
  const podeOperar = Array.isArray(sys.modulos) && sys.modulos.includes('fila-comercial-operar');
  if (!podeOperar) throw new HttpsError('permission-denied', 'Módulo fila-comercial-operar necessário para operar a fila.');

  return sys.nome || user.email?.split('@')[0] || uid;
}

function validarOppId(id) {
  if (!id || typeof id !== 'string' || !OPP_ID_RE.test(id)) {
    throw new HttpsError('invalid-argument', 'opportunityInstanceId inválido (esperado: 16 hex chars).');
  }
}

// ── claimOpportunity ──────────────────────────────────────────────────────────

/**
 * Inicia atendimento de uma oportunidade canária.
 * Entrada: { opportunityInstanceId: string }
 * Saída:   { estado, operadorNome, claimadoEm }
 *
 * Transação garante: sem double-claim, sem last-write-wins.
 * Claim expirado (>4h) é liberado automaticamente antes do novo claim.
 */
async function claimOpportunityHandler(request, opts = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário.');
  const uid = request.auth.uid;

  const operadorNome = await verificarPermissaoFila(uid);

  const { opportunityInstanceId } = request.data || {};
  validarOppId(opportunityInstanceId);

  const store  = db();
  const ref    = store.collection(COLL).doc(opportunityInstanceId);
  const isoNow = agoraIso(opts);
  let novoEstado;

  await store.runTransaction(async tx => {
    const snap = await tx.get(ref);
    // N35.14: worklist do dia define atribuição. Lida na MESMA transação (antes de qualquer write).
    const wlSnap = await tx.get(store.collection(WORKLIST_COLL).doc(WORKLIST_DOC));
    const wl = wlSnap.exists ? wlSnap.data() : null;
    const atrib = (wl && wl.dataReferencia === dataComercial(isoNow))
      ? ((wl.atribuicoes || {})[opportunityInstanceId] || null)
      : null;

    if (atrib && atrib.uid !== uid) {
      throw new HttpsError('permission-denied', 'Oportunidade atribuída a outro vendedor hoje.');
    }
    // CRM 2.0 F1 — sem atribuição de hoje (antes das 06:00, fim de semana, retorno futuro): as reservas continuam valendo
    if (!atrib) {
      const atribAnterior = wl ? ((wl.atribuicoes || {})[opportunityInstanceId] || null) : null;
      if (atribAnterior && atribAnterior.uid && atribAnterior.uid !== uid) {
        throw new HttpsError('permission-denied', 'Oportunidade reservada para outro vendedor.');
      }
      const dono = snap.exists ? donoReservado(snap.data(), isoNow) : null;
      if (dono && dono !== uid) {
        throw new HttpsError('permission-denied', 'Retorno reservado para outro vendedor.');
      }
    }

    let estado;
    if (!snap.exists) {
      // Criação lazy: só nasce no primeiro claim de oportunidade atribuída ao próprio vendedor.
      if (!atrib || !ENTITY_RE.test(atrib.commercialEntityId || '') || !atrib.tipoOportunidade) {
        throw new HttpsError('not-found', 'Oportunidade não encontrada ou não atribuída a você hoje.');
      }
      estado = {
        ...criarEstadoInicial(atrib.commercialEntityId, opportunityInstanceId, atrib.tipoOportunidade, isoNow),
        nomeCliente: sanitizeCommercialDisplayName(atrib.nomeCliente), // exibição apenas, sem CPF/CNPJ
      };
    } else {
      estado = snap.data();
    }

    // Libera claim expirado antes de tentar novo claim (N35.9C)
    if (isClaimExpired(estado, isoNow)) {
      estado = releaseExpiredClaim(estado, isoNow);
    }

    try {
      novoEstado = claimOportunidade(estado, uid, isoNow);
    } catch (err) {
      if (err.message.includes('EM_ATENDIMENTO') || err.message.includes('não permite claim')) {
        throw new HttpsError('already-exists', 'Oportunidade já está em atendimento por outro usuário.');
      }
      if (err.message.includes('cooldown')) {
        throw new HttpsError('failed-precondition', 'Oportunidade em cooldown. Tente novamente mais tarde.');
      }
      throw new HttpsError('failed-precondition', 'Não foi possível iniciar atendimento: ' + err.message);
    }

    // Adiciona nome do operador para exibição (não altera lógica da máquina de estado)
    novoEstado = {
      ...novoEstado,
      claimAtual: {
        ...novoEstado.claimAtual,
        operadorNome,
      },
    };

    tx.set(ref, novoEstado);
  });

  return {
    estado:       novoEstado.estado,
    operadorNome,
    claimadoEm:   novoEstado.claimAtual?.claimadoEm || isoNow,
  };
}

// ── registerOutcome ───────────────────────────────────────────────────────────

/**
 * Registra resultado de um atendimento.
 * Entrada: { opportunityInstanceId, outcome, scheduledFor? (YYYY-MM-DD para PEDIU_RETORNO), nota? (≤280, CRM 2.0 F1) }
 * Saída:   { estado, outcome, nextFollowUpAt, cooledUntil }
 *
 * Apenas o owner do claim pode registrar outcome.
 * PEDIU_RETORNO exige scheduledFor no futuro.
 * Cooldown calculado server-side (SEM_INTERESSE_AGORA / 3× SEM_RESPOSTA).
 */
const COLL_NOTAS = 'crm_notas_privadas';
const notaDocId = (opp, idx) => `${opp}__${idx}`;

async function registerOutcomeHandler(request, opts = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário.');
  const uid = request.auth.uid;

  await verificarPermissaoFila(uid);

  const { opportunityInstanceId, outcome, scheduledFor, nota } = request.data || {};
  validarOppId(opportunityInstanceId);

  if (!outcome || !OUTCOMES[outcome]) {
    throw new HttpsError(
      'invalid-argument',
      `Outcome inválido: "${outcome}". Valores aceitos: ${Object.values(OUTCOMES).join(', ')}.`
    );
  }

  const isoNow = agoraIso(opts);
  // scheduledFor obrigatório e futuro para PEDIU_RETORNO
  if (outcome === OUTCOMES.PEDIU_RETORNO) {
    if (!dataValida(scheduledFor)) {
      throw new HttpsError('invalid-argument', 'scheduledFor (YYYY-MM-DD) obrigatório para PEDIU_RETORNO.');
    }
    // CRM 2.0 F1: "hoje" no fuso comercial (America/Fortaleza), não em UTC — corrige a fronteira das 21h às 24h
    const hoje = dataComercial(isoNow);
    if (scheduledFor <= hoje) {
      throw new HttpsError('invalid-argument', 'Data do retorno deve ser futura (após hoje).');
    }
    if (scheduledFor > somarDiasYmd(hoje, HORIZONTE_RETORNO_DIAS)) {
      throw new HttpsError('invalid-argument', `Data do retorno deve estar nos próximos ${HORIZONTE_RETORNO_DIAS} dias.`);
    }
  }
  // CRM 2.0 F1: observação opcional (texto, trim, até 280) — validada aqui e de novo na máquina de estados
  let notaLimpa;
  try { notaLimpa = normalizarNota(nota); }
  catch (e) { throw new HttpsError('invalid-argument', 'Observação inválida: ' + e.message + '.'); }

  const store  = db();
  const ref    = store.collection(COLL).doc(opportunityInstanceId);
  let novoEstado;

  await store.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Oportunidade não encontrada.');

    const estado = snap.data();

    if (estado.estado !== ESTADOS.EM_ATENDIMENTO) {
      throw new HttpsError('failed-precondition', 'Oportunidade não está em atendimento.');
    }

    // Verificação de ownership server-side (APPLICATION_LEVEL_GAP resolvido aqui)
    if (!estado.claimAtual || estado.claimAtual.operadorId !== uid) {
      throw new HttpsError('permission-denied', 'Apenas o responsável pelo atendimento pode registrar resultado.');
    }

    const meta = {};
    if (outcome === OUTCOMES.PEDIU_RETORNO && scheduledFor) {
      meta.scheduledFor = scheduledFor;
    }
    if (notaLimpa) meta.temNota = true;          // o texto vai só para crm_notas_privadas (nunca para o documento da fila)

    novoEstado = registrarOutcome(estado, uid, outcome, isoNow, meta);
    tx.set(ref, novoEstado);
    if (notaLimpa) {
      // id determinístico = oportunidade + índice do evento (append-only) → 1 nota por resultado; create() recusa duplicata
      const idx = novoEstado.eventos.length - 1;
      tx.create(store.collection(COLL_NOTAS).doc(notaDocId(opportunityInstanceId, idx)), {
        opportunityInstanceId, eventoIndex: idx, eventoEm: isoNow, operadorId: uid,
        commercialEntityId: estado.commercialEntityId || null, texto: notaLimpa, criadoEm: isoNow,
      });
    }
  });

  return {
    estado:         novoEstado.estado,
    outcome,
    nextFollowUpAt: novoEstado.nextFollowUpAt || null,
    cooledUntil:    novoEstado.cooledUntil    || null,
  };
}

// ── releaseOpportunity ────────────────────────────────────────────────────────

/**
 * Libera o claim sem registrar outcome (ex.: usuário cancelou o atendimento).
 * Retorna oportunidade para DISPONIVEL com evento RELEASED no histórico.
 * Entrada: { opportunityInstanceId }
 */
async function releaseOpportunityHandler(request, opts = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário.');
  const uid = request.auth.uid;

  await verificarPermissaoFila(uid);

  const { opportunityInstanceId } = request.data || {};
  validarOppId(opportunityInstanceId);

  const store  = db();
  const ref    = store.collection(COLL).doc(opportunityInstanceId);
  const isoNow = agoraIso(opts);
  let novoEstado;

  await store.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Oportunidade não encontrada.');

    const estado = snap.data();

    if (estado.estado !== ESTADOS.EM_ATENDIMENTO) {
      throw new HttpsError('failed-precondition', 'Oportunidade não está em atendimento.');
    }

    if (!estado.claimAtual || estado.claimAtual.operadorId !== uid) {
      throw new HttpsError('permission-denied', 'Apenas o responsável pelo atendimento pode liberar.');
    }

    novoEstado = releaseOportunidade(estado, uid, isoNow);
    tx.set(ref, novoEstado);
  });

  return { estado: novoEstado.estado };
}

module.exports = {
  COLL_NOTAS,
  notaDocId,
  claimOpportunityHandler,
  registerOutcomeHandler,
  releaseOpportunityHandler,
};
