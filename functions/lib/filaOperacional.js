'use strict';
// N35.8 / N35.9C — Máquina de estado operacional da fila comercial
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   PROD_WRITES=0
//   Funções puras — zero I/O, zero side effects
//   NÃO criar role 'vendedor' (D-VENDEDOR)
//
// N35.9C — Regras operacionais V1 incorporadas:
//   - SEM_INTERESSE_AGORA → cooledUntil + 30 dias (entidade suprimida)
//   - 3× SEM_RESPOSTA consecutivos → cooledUntil + 30 dias (claim bloqueado)
//   - CLAIM_TIMEOUT_HOURS = 4 (não destrói histórico/follow-up/dados financeiros)
//   - FOLLOWUPS_COUNT_TOWARD_CAP = false (follow-ups fora do CAP_10)

const config = require('./operationalConfig');

// ── Helper de data ────────────────────────────────────────────────────────────

/** Adiciona N dias a uma string ISO 8601 e retorna nova string ISO 8601. */
function addDays(isoString, days) {
  const d = new Date(isoString);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ── Constantes ────────────────────────────────────────────────────────────────

const ESTADOS = Object.freeze({
  DISPONIVEL:          'DISPONIVEL',
  EM_ATENDIMENTO:      'EM_ATENDIMENTO',
  AGUARDANDO_RETORNO:  'AGUARDANDO_RETORNO',
  CONCLUIDA:           'CONCLUIDA',
});

const OUTCOMES = Object.freeze({
  CONVERSA_REALIZADA:   'CONVERSA_REALIZADA',
  SEM_RESPOSTA:         'SEM_RESPOSTA',
  PEDIU_RETORNO:        'PEDIU_RETORNO',
  SEM_INTERESSE_AGORA:  'SEM_INTERESSE_AGORA',
  CONTATO_INVALIDO:     'CONTATO_INVALIDO',
});

const EVENT_TYPES = Object.freeze({
  CLAIMED:             'CLAIMED',
  OUTCOME_REGISTERED:  'OUTCOME_REGISTERED',
  RELEASED:            'RELEASED',
});

// Transições: [estadoAtual][outcome] → novoEstado
const TRANSITIONS = Object.freeze({
  [ESTADOS.EM_ATENDIMENTO]: Object.freeze({
    [OUTCOMES.CONVERSA_REALIZADA]:  ESTADOS.CONCLUIDA,
    [OUTCOMES.SEM_RESPOSTA]:        ESTADOS.DISPONIVEL,
    [OUTCOMES.PEDIU_RETORNO]:       ESTADOS.AGUARDANDO_RETORNO,
    [OUTCOMES.SEM_INTERESSE_AGORA]: ESTADOS.CONCLUIDA,
    [OUTCOMES.CONTATO_INVALIDO]:    ESTADOS.CONCLUIDA,
  }),
});

// ── Estado inicial ────────────────────────────────────────────────────────────

/**
 * Cria o estado operacional inicial para uma oportunidade.
 *
 * @param {string} commercialEntityId
 * @param {string} opportunityInstanceId
 * @param {string} tipoOportunidade
 * @param {string} isoNow — timestamp ISO 8601
 * @returns {object} estado operacional inicial
 */
function criarEstadoInicial(commercialEntityId, opportunityInstanceId, tipoOportunidade, isoNow) {
  if (!commercialEntityId) throw new Error('criarEstadoInicial: commercialEntityId obrigatório');
  if (!opportunityInstanceId) throw new Error('criarEstadoInicial: opportunityInstanceId obrigatório');
  if (!tipoOportunidade) throw new Error('criarEstadoInicial: tipoOportunidade obrigatório');
  if (!isoNow) throw new Error('criarEstadoInicial: isoNow obrigatório');

  return {
    commercialEntityId,
    opportunityInstanceId,
    tipoOportunidade,
    estado:           ESTADOS.DISPONIVEL,
    criadoEm:         isoNow,
    atualizadoEm:     isoNow,
    claimAtual:       null,
    cooledUntil:      null,   // N35.9C: timestamp ISO 8601 do fim do cooldown, ou null
    nextFollowUpAt:   null,   // N35.9C: data YYYY-MM-DD do próximo follow-up agendado, ou null
    eventos:          [],
  };
}

// ── Cooldown queries ──────────────────────────────────────────────────────────

/**
 * Retorna o número de SEM_RESPOSTA consecutivos mais recentes no histórico.
 * Uma interação válida (qualquer outro outcome) interrompe a sequência.
 */
function getConsecutiveSemRespostaCount(estado) {
  const eventos = estado.eventos
    .filter(e => e.tipo === EVENT_TYPES.OUTCOME_REGISTERED)
    .slice()
    .reverse(); // mais recente primeiro

  let count = 0;
  for (const ev of eventos) {
    if (ev.outcome === OUTCOMES.SEM_RESPOSTA) {
      count++;
    } else {
      break; // qualquer outro outcome quebra a sequência
    }
  }
  return count;
}

/**
 * Retorna true se a oportunidade está em cooldown ativo em relação a `now`.
 * Cooldown expirou em exatamente cooledUntil (now >= cooledUntil → não está em cooldown).
 */
function isCooledDown(estado, now) {
  if (!estado.cooledUntil) return false;
  return new Date(now) < new Date(estado.cooledUntil);
}

/** Retorna o timestamp de fim do cooldown ou null se não houver. */
function getCooledUntil(estado) {
  return estado.cooledUntil || null;
}

// ── Claim timeout queries ─────────────────────────────────────────────────────

/**
 * Retorna true se o claim ativo expirou (>= CLAIM_TIMEOUT_HOURS).
 * Um claim expirado deve ser liberado antes de novo claim.
 * NÃO destrói histórico, follow-up ou dados financeiros.
 *
 * @param {object} estado
 * @param {string} now — ISO 8601
 * @param {number} [timeoutHours] — padrão: config.CLAIM_TIMEOUT_HOURS
 */
function isClaimExpired(estado, now, timeoutHours) {
  if (timeoutHours === undefined) timeoutHours = config.CLAIM_TIMEOUT_HOURS;
  if (estado.estado !== ESTADOS.EM_ATENDIMENTO) return false;
  if (!estado.claimAtual || !estado.claimAtual.claimadoEm) return false;

  const elapsed = new Date(now).getTime() - new Date(estado.claimAtual.claimadoEm).getTime();
  return elapsed >= timeoutHours * 3600 * 1000;
}

// ── Claim ─────────────────────────────────────────────────────────────────────

/**
 * Tenta fazer claim de uma oportunidade para um operador.
 * Retorna novo estado ou lança erro se inválido.
 *
 * Estados que aceitam claim: DISPONIVEL, AGUARDANDO_RETORNO
 * Proibido: estado em cooldown ativo (isCooledDown)
 *
 * @param {object} estado — estado atual (imutável)
 * @param {string} operadorId — ID do operador
 * @param {string} isoNow
 * @returns {object} novo estado
 */
function claimOportunidade(estado, operadorId, isoNow) {
  if (!estado) throw new Error('claimOportunidade: estado obrigatório');
  if (!operadorId || typeof operadorId !== 'string' || operadorId.trim() === '') {
    throw new Error('claimOportunidade: operadorId obrigatório');
  }
  if (!isoNow) throw new Error('claimOportunidade: isoNow obrigatório');

  const claimableStates = [ESTADOS.DISPONIVEL, ESTADOS.AGUARDANDO_RETORNO];
  if (!claimableStates.includes(estado.estado)) {
    throw new Error(
      `claimOportunidade: estado "${estado.estado}" não permite claim ` +
      `(opp=${estado.opportunityInstanceId})`
    );
  }

  // N35.9C: bloquear claim se oportunidade está em cooldown
  if (isCooledDown(estado, isoNow)) {
    throw new Error(
      `claimOportunidade: oportunidade em cooldown até ${estado.cooledUntil} ` +
      `(opp=${estado.opportunityInstanceId})`
    );
  }

  const evento = {
    tipo:         EVENT_TYPES.CLAIMED,
    operadorId:   operadorId.trim(),
    estadoAntes:  estado.estado,
    estadoDepois: ESTADOS.EM_ATENDIMENTO,
    timestamp:    isoNow,
  };

  return {
    ...estado,
    estado:       ESTADOS.EM_ATENDIMENTO,
    atualizadoEm: isoNow,
    claimAtual:   {
      operadorId: operadorId.trim(),
      claimadoEm: isoNow,
    },
    eventos: [...estado.eventos, evento],
  };
}

// ── Release (liberar sem registrar outcome) ───────────────────────────────────

/**
 * Libera o claim atual sem registrar outcome (ex: operador saiu sem interagir).
 * Estado retorna para DISPONIVEL.
 *
 * @param {object} estado
 * @param {string} operadorId
 * @param {string} isoNow
 * @returns {object} novo estado
 */
function releaseOportunidade(estado, operadorId, isoNow) {
  if (!estado) throw new Error('releaseOportunidade: estado obrigatório');
  if (estado.estado !== ESTADOS.EM_ATENDIMENTO) {
    throw new Error(
      `releaseOportunidade: estado "${estado.estado}" não é EM_ATENDIMENTO ` +
      `(opp=${estado.opportunityInstanceId})`
    );
  }
  if (!operadorId || typeof operadorId !== 'string') {
    throw new Error('releaseOportunidade: operadorId obrigatório');
  }

  const claimAtual = estado.claimAtual;
  if (claimAtual && claimAtual.operadorId !== operadorId.trim()) {
    throw new Error(
      `releaseOportunidade: operador "${operadorId}" não possui o claim ` +
      `(claim pertence a "${claimAtual.operadorId}")`
    );
  }

  const evento = {
    tipo:         EVENT_TYPES.RELEASED,
    operadorId:   operadorId.trim(),
    estadoAntes:  ESTADOS.EM_ATENDIMENTO,
    estadoDepois: ESTADOS.DISPONIVEL,
    timestamp:    isoNow,
  };

  return {
    ...estado,
    estado:       ESTADOS.DISPONIVEL,
    atualizadoEm: isoNow,
    claimAtual:   null,
    eventos:      [...estado.eventos, evento],
  };
}

// ── Release por timeout ───────────────────────────────────────────────────────

/**
 * Libera um claim expirado pelo timeout (N35.9C: CLAIM_TIMEOUT_HOURS=4).
 * Não verifica ownership — qualquer entidade sistêmica pode liberar um claim expirado.
 * NÃO destrói: histórico de eventos, nextFollowUpAt, cooledUntil, dados financeiros.
 *
 * @param {object} estado
 * @param {string} now — ISO 8601
 * @param {number} [timeoutHours] — padrão: config.CLAIM_TIMEOUT_HOURS
 * @returns {object} novo estado
 */
function releaseExpiredClaim(estado, now, timeoutHours) {
  if (!isClaimExpired(estado, now, timeoutHours)) {
    const elapsed = estado.claimAtual
      ? Math.round((new Date(now).getTime() - new Date(estado.claimAtual.claimadoEm).getTime()) / 60000)
      : 0;
    throw new Error(
      `releaseExpiredClaim: claim ainda ativo (${elapsed} min < ${timeoutHours || config.CLAIM_TIMEOUT_HOURS}h, ` +
      `opp=${estado.opportunityInstanceId})`
    );
  }

  const evento = {
    tipo:         EVENT_TYPES.RELEASED,
    operadorId:   estado.claimAtual.operadorId,
    estadoAntes:  ESTADOS.EM_ATENDIMENTO,
    estadoDepois: ESTADOS.DISPONIVEL,
    timestamp:    now,
    meta:         { reason: 'CLAIM_TIMEOUT' },
  };

  return {
    ...estado,
    estado:       ESTADOS.DISPONIVEL,
    atualizadoEm: now,
    claimAtual:   null,
    // cooledUntil e nextFollowUpAt preservados (não destruir dados)
    eventos:      [...estado.eventos, evento],
  };
}

// ── Registrar Outcome ─────────────────────────────────────────────────────────

/**
 * Registra o resultado de um atendimento e transiciona o estado.
 * Só pode ser chamado quando estado = EM_ATENDIMENTO.
 *
 * N35.9C — Aplica regras de cooldown:
 *   - SEM_INTERESSE_AGORA → cooledUntil = now + SEM_INTERESSE_COOLDOWN_DAYS
 *   - 3× SEM_RESPOSTA consecutivos (incluindo este) → cooledUntil = now + SEM_RESPOSTA_COOLDOWN_DAYS
 *   - PEDIU_RETORNO → nextFollowUpAt = meta.scheduledFor (YYYY-MM-DD)
 *   - Qualquer outro outcome → nextFollowUpAt = null (limpar agendamento)
 *
 * @param {object} estado
 * @param {string} operadorId
 * @param {string} outcome — um dos OUTCOMES
 * @param {string} isoNow
 * @param {object} [meta={}] — metadados opcionais (nota, scheduledFor, etc.)
 * @returns {object} novo estado
 */
function registrarOutcome(estado, operadorId, outcome, isoNow, meta = {}) {
  if (!estado) throw new Error('registrarOutcome: estado obrigatório');
  if (estado.estado !== ESTADOS.EM_ATENDIMENTO) {
    throw new Error(
      `registrarOutcome: estado "${estado.estado}" não é EM_ATENDIMENTO ` +
      `(opp=${estado.opportunityInstanceId})`
    );
  }
  if (!operadorId || typeof operadorId !== 'string') {
    throw new Error('registrarOutcome: operadorId obrigatório');
  }
  if (!outcome || !OUTCOMES[outcome]) {
    throw new Error(`registrarOutcome: outcome inválido: "${outcome}"`);
  }
  if (!isoNow) throw new Error('registrarOutcome: isoNow obrigatório');

  const transicoes = TRANSITIONS[ESTADOS.EM_ATENDIMENTO];
  const novoEstado = transicoes[outcome];
  if (!novoEstado) {
    throw new Error(`registrarOutcome: sem transição para outcome "${outcome}" (impossível, invariante quebrado)`);
  }

  // N35.9C — Calcular cooledUntil
  let cooledUntil = estado.cooledUntil || null; // preservar se já havia

  if (outcome === OUTCOMES.SEM_INTERESSE_AGORA) {
    // Entidade suprimida por 30 dias (armazenado no doc CONCLUIDA para worklist usar)
    cooledUntil = addDays(isoNow, config.SEM_INTERESSE_COOLDOWN_DAYS);
  } else if (outcome === OUTCOMES.SEM_RESPOSTA) {
    // +1 porque este outcome ainda não está no eventos[]
    const consecutivo = getConsecutiveSemRespostaCount(estado) + 1;
    if (consecutivo >= config.SEM_RESPOSTA_MAX_CONSECUTIVE) {
      cooledUntil = addDays(isoNow, config.SEM_RESPOSTA_COOLDOWN_DAYS);
    }
  }
  // Outros outcomes preservam cooledUntil existente (pode já estar expirado)

  // N35.9C — Calcular nextFollowUpAt
  let nextFollowUpAt = null; // limpar por padrão
  if (outcome === OUTCOMES.PEDIU_RETORNO) {
    nextFollowUpAt = (meta && meta.scheduledFor) ? meta.scheduledFor : null;
  }

  const evento = {
    tipo:         EVENT_TYPES.OUTCOME_REGISTERED,
    operadorId:   operadorId.trim(),
    outcome,
    estadoAntes:  ESTADOS.EM_ATENDIMENTO,
    estadoDepois: novoEstado,
    timestamp:    isoNow,
    ...( Object.keys(meta).length > 0 ? { meta } : {} ),
  };

  return {
    ...estado,
    estado:         novoEstado,
    atualizadoEm:   isoNow,
    claimAtual:     null,
    cooledUntil,
    nextFollowUpAt,
    eventos:        [...estado.eventos, evento],
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** @returns {boolean} true se oportunidade pode ser claimada (considera cooldown) */
function isClaimavel(estado) {
  return [ESTADOS.DISPONIVEL, ESTADOS.AGUARDANDO_RETORNO].includes(estado.estado);
}

/** @returns {boolean} true se oportunidade está em atendimento ativo */
function isEmAtendimento(estado) {
  return estado.estado === ESTADOS.EM_ATENDIMENTO;
}

/** @returns {boolean} true se oportunidade está encerrada */
function isConcluida(estado) {
  return estado.estado === ESTADOS.CONCLUIDA;
}

/** @returns {string|null} operadorId do claim atual, ou null */
function getOperadorAtual(estado) {
  return estado.claimAtual ? estado.claimAtual.operadorId : null;
}

/** @returns {string} último outcome registrado, ou null */
function getUltimoOutcome(estado) {
  const evts = estado.eventos.filter(e => e.tipo === EVENT_TYPES.OUTCOME_REGISTERED);
  return evts.length > 0 ? evts[evts.length - 1].outcome : null;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ESTADOS,
  OUTCOMES,
  EVENT_TYPES,
  TRANSITIONS,
  criarEstadoInicial,
  claimOportunidade,
  releaseOportunidade,
  releaseExpiredClaim,
  registrarOutcome,
  isClaimavel,
  isEmAtendimento,
  isConcluida,
  getOperadorAtual,
  getUltimoOutcome,
  // N35.9C
  getConsecutiveSemRespostaCount,
  isClaimExpired,
  isCooledDown,
  getCooledUntil,
};
