'use strict';

/**
 * gc-link.js — Motor de linkagem GestãoClick ↔ MR4 CRM
 *
 * RESPONSABILIDADE:
 *   Determinar de forma determinística qual cliente GestãoClick
 *   corresponde a qual cliente MR4, sem escrita em nenhum banco.
 *
 * PRINCÍPIOS:
 *   - Funções puras: recebem arrays, retornam estruturas.
 *   - Zero I/O: não lê Firestore, não lê SQLite, não chama GC API.
 *   - Idempotente: cliente já linkado corretamente → nenhuma alteração.
 *   - Conservador: em caso de dúvida, não linka.
 *
 * MÉTODOS DE LINKAGEM:
 *   DOCUMENT   — documento fiscal único e inequívoco (nível A)
 *   PHONE_NAME — telefone único + nome compatível (nível B)
 *
 * SAÍDAS POSSÍVEIS por cliente MR4:
 *   { status: 'MATCH',         gcId, method }   → link confirmado
 *   { status: 'CONFLICT',      gcId, conflictGcId } → já tem ID diferente
 *   { status: 'REVISAO_MANUAL', reason }        → candidato existe, não seguro para link automático
 *   { status: 'AMBIGUOUS',     reason }         → documento fiscal duplicado no GC
 *   { status: 'NO_MATCH',      reason }         → nenhum candidato
 *   { status: 'ALREADY_LINKED', gcId }          → idempotente
 */

// ── Normalização ──────────────────────────────────────────────────────────────

/**
 * Remove máscara e retorna somente dígitos.
 * Aceita CPF (11d) ou CNPJ (14d). Qualquer outro tamanho → null.
 */
function normalizeDoc(s) {
  if (!s || typeof s !== 'string') return null;
  const d = s.replace(/\D/g, '');
  if (d.length === 11 || d.length === 14) return d;
  return null;
}

/**
 * Normaliza telefone: remove DDI 55 se presente, retorna somente dígitos.
 * Aceita formatos com ou sem máscara, com ou sem 9º dígito.
 * Mínimo 10 dígitos (DDD 2d + 8d número).
 */
function normalizeTel(s) {
  if (!s || typeof s !== 'string') return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length < 10) return null;
  return d;
}

/**
 * Retorna TODAS as variantes de um telefone (com e sem 9º dígito).
 * Permite match quando um sistema armazena com 9 e outro sem.
 */
function telVariants(s) {
  const base = normalizeTel(s);
  if (!base) return [];
  const variants = new Set([base]);
  const ddd = base.slice(0, 2);
  const num = base.slice(2);
  if (num.length === 8) variants.add(ddd + '9' + num);
  if (num.length === 9 && num[0] === '9') variants.add(ddd + num.slice(1));
  return [...variants];
}

/**
 * Normaliza email: trim + lowercase.
 */
function normalizeEmail(s) {
  if (!s || typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/**
 * Normaliza nome para comparação: lowercase, sem acentos, sem pontuação extra.
 */
function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verifica compatibilidade de nomes para uso como critério secundário.
 * Não é critério suficiente sozinho — apenas confirma ausência de conflito.
 *
 * Compatível se:
 *   - Primeiro token do nome A aparece no nome B ou vice-versa.
 *
 * Incompatível (retorna false) se:
 *   - Primeiro token de A é completamente diferente do de B.
 *   - Qualquer dos nomes está vazio.
 */
function nameCompatible(nameA, nameB) {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);
  if (!a || !b) return false;
  const firstA = a.split(' ')[0];
  const firstB = b.split(' ')[0];
  if (firstA.length < 2 || firstB.length < 2) return false;
  return (
    firstA === firstB ||
    b.includes(firstA) ||
    a.includes(firstB)
  );
}

// ── Construção de índices GC ──────────────────────────────────────────────────

/**
 * Constrói índices invertidos do array de clientes GestãoClick.
 *
 * @param {Array<{id:string, cpf?:string, cnpj?:string, telefone?:string, celular?:string, email?:string, nome?:string}>} gcClientes
 * @returns {{ byDoc: Map, byTel: Map, byEmail: Map, gcById: Map }}
 *
 * Cada mapa: chave normalizada → [gcId, ...]
 * gcById: gcId → cliente GC original (para consulta de nome)
 */
function buildGcIndexes(gcClientes) {
  const byDoc   = new Map();
  const byTel   = new Map();
  const byEmail = new Map();
  const gcById  = new Map();

  for (const gc of gcClientes) {
    gcById.set(String(gc.id), gc);

    // documento fiscal
    const doc = normalizeDoc(gc.cpf) || normalizeDoc(gc.cnpj);
    if (doc) {
      if (!byDoc.has(doc)) byDoc.set(doc, []);
      byDoc.get(doc).push(String(gc.id));
    }

    // telefone + celular (todas as variantes)
    for (const tel of [gc.telefone, gc.celular]) {
      for (const v of telVariants(tel)) {
        if (!byTel.has(v)) byTel.set(v, []);
        if (!byTel.get(v).includes(String(gc.id))) {
          byTel.get(v).push(String(gc.id));
        }
      }
    }

    // email
    const em = normalizeEmail(gc.email);
    if (em) {
      if (!byEmail.has(em)) byEmail.set(em, []);
      byEmail.get(em).push(String(gc.id));
    }
  }

  return { byDoc, byTel, byEmail, gcById };
}

// ── Motor de linkagem ─────────────────────────────────────────────────────────

/**
 * Tenta linkar um único cliente MR4 a um cliente GestãoClick.
 *
 * Regras em ordem de prioridade:
 *   1. Se já tem gestaoClickId → ALREADY_LINKED (idempotência)
 *   2. PASS 1 — documento fiscal único → MATCH (DOCUMENT)
 *   3. PASS 1 — documento ambíguo → AMBIGUOUS
 *   4. PASS 2 — telefone único + nome compatível → MATCH (PHONE_NAME)
 *   5. PASS 2 — telefone ambíguo → AMBIGUOUS
 *   6. PASS 2 — telefone único + nome incompatível → NO_MATCH (nome não confirma)
 *   7. Sem nenhum match → NO_MATCH
 *
 * NÃO usa: email (0% no MR4), nome fuzzy automático.
 *
 * @param {{
 *   id: string,
 *   nome?: string,
 *   cpf_cnpj?: string,
 *   telefone?: string,
 *   gestaoClickId?: string
 * }} mr4Cliente
 * @param {{ byDoc: Map, byTel: Map, byEmail: Map, gcById: Map }} gcIndexes
 * @returns {{
 *   mr4Id: string,
 *   status: 'MATCH'|'CONFLICT'|'REVISAO_MANUAL'|'AMBIGUOUS'|'NO_MATCH'|'ALREADY_LINKED',
 *   gcId?: string,
 *   method?: 'DOCUMENT'|'PHONE_NAME',
 *   conflictGcId?: string,
 *   reason?: string
 * }}
 */
function linkSingle(mr4Cliente, gcIndexes) {
  const mr4Id = String(mr4Cliente.id);
  const { byDoc, byTel, gcById } = gcIndexes;

  // ── 0. Já linkado ───────────────────────────────────────────────────────────
  if (mr4Cliente.gestaoClickId) {
    return { mr4Id, status: 'ALREADY_LINKED', gcId: String(mr4Cliente.gestaoClickId) };
  }

  // ── PASS 1: documento fiscal ────────────────────────────────────────────────
  const docNorm = normalizeDoc(mr4Cliente.cpf_cnpj);
  if (docNorm) {
    const gcIds = byDoc.get(docNorm) || [];
    if (gcIds.length === 1) {
      return { mr4Id, status: 'MATCH', gcId: gcIds[0], method: 'DOCUMENT' };
    }
    if (gcIds.length > 1) {
      return { mr4Id, status: 'AMBIGUOUS', reason: `doc_duplicado_gc: ${gcIds.join(',')}` };
    }
    // 0 matches por doc — tenta telefone
  }

  // ── PASS 2: telefone ────────────────────────────────────────────────────────
  const telNorm = normalizeTel(mr4Cliente.telefone);
  if (telNorm) {
    const variants = telVariants(mr4Cliente.telefone);
    const allGcIds = new Set();
    for (const v of variants) {
      for (const id of (byTel.get(v) || [])) allGcIds.add(id);
    }

    if (allGcIds.size === 1) {
      const gcId = [...allGcIds][0];
      const gcCliente = gcById.get(gcId);
      // Nome deve ser compatível (ausência de conflito)
      if (!nameCompatible(mr4Cliente.nome, gcCliente ? gcCliente.nome : '')) {
        return {
          mr4Id,
          status: 'REVISAO_MANUAL',
          reason: `tel_unico_nome_incompativel: gcId=${gcId}`,
        };
      }
      return { mr4Id, status: 'MATCH', gcId, method: 'PHONE_NAME' };
    }

    if (allGcIds.size > 1) {
      return {
        mr4Id,
        status: 'REVISAO_MANUAL',
        reason: `tel_ambiguo: ${[...allGcIds].join(',')}`,
      };
    }
  }

  // ── Sem match ───────────────────────────────────────────────────────────────
  const reasons = [];
  if (!docNorm && !telNorm) reasons.push('sem_doc_sem_tel');
  else if (!docNorm)        reasons.push('sem_doc');
  else                      reasons.push('doc_sem_match_gc');
  if (telNorm)              reasons.push('tel_sem_match_gc');

  return { mr4Id, status: 'NO_MATCH', reason: reasons.join(';') };
}

// ── Dry-run em lote ───────────────────────────────────────────────────────────

/**
 * Executa linkagem para todos os clientes MR4 e retorna estatísticas
 * sem modificar nada.
 *
 * Também valida integridade 1:1:
 *   - Um MR4 → máximo 1 GC
 *   - Um GC → máximo 1 MR4
 *
 * Casos com conflito 1:N são removidos dos matches confirmados e
 * registrados em conflicts.
 *
 * @param {Array} mr4Clientes
 * @param {Array} gcClientes
 * @returns {{
 *   total: number,
 *   matchDocument: number,
 *   matchPhoneName: number,
 *   alreadyLinked: number,
 *   revisaoManual: number,
 *   ambiguous: number,
 *   noMatch: number,
 *   conflicts1toN: number,
 *   expectedWrites: number,
 *   results: Array
 * }}
 */
function dryRun(mr4Clientes, gcClientes) {
  const gcIndexes = buildGcIndexes(gcClientes);
  const results   = [];

  // Passo 1: linkar todos
  for (const mr4 of mr4Clientes) {
    results.push(linkSingle(mr4, gcIndexes));
  }

  // Passo 2: validar 1:1 — um GC ID não pode aparecer em dois MATCH
  const gcIdToMr4s = new Map();
  for (const r of results) {
    if (r.status === 'MATCH') {
      if (!gcIdToMr4s.has(r.gcId)) gcIdToMr4s.set(r.gcId, []);
      gcIdToMr4s.get(r.gcId).push(r.mr4Id);
    }
  }

  // Marcar conflitos 1:N (GC→múltiplos MR4)
  let conflicts1toN = 0;
  for (const r of results) {
    if (r.status === 'MATCH') {
      const others = gcIdToMr4s.get(r.gcId) || [];
      if (others.length > 1) {
        r.status   = 'AMBIGUOUS';
        r.reason   = `gc_para_multiplos_mr4: ${others.join(',')}`;
        r.gcId     = undefined;
        r.method   = undefined;
        conflicts1toN++;
      }
    }
  }

  // Contagens finais
  let matchDocument = 0;
  let matchPhoneName = 0;
  let alreadyLinked  = 0;
  let revisaoManual  = 0;
  let ambiguous      = 0;
  let noMatch        = 0;

  for (const r of results) {
    if      (r.status === 'MATCH' && r.method === 'DOCUMENT')    matchDocument++;
    else if (r.status === 'MATCH' && r.method === 'PHONE_NAME')  matchPhoneName++;
    else if (r.status === 'ALREADY_LINKED')                       alreadyLinked++;
    else if (r.status === 'REVISAO_MANUAL')                       revisaoManual++;
    else if (r.status === 'AMBIGUOUS')                            ambiguous++;
    else if (r.status === 'NO_MATCH')                             noMatch++;
  }

  const expectedWrites = matchDocument + matchPhoneName;

  return {
    total:         mr4Clientes.length,
    matchDocument,
    matchPhoneName,
    alreadyLinked,
    revisaoManual,
    ambiguous,
    noMatch,
    conflicts1toN,
    expectedWrites,
    results,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  normalizeDoc,
  normalizeTel,
  telVariants,
  normalizeEmail,
  normalizeName,
  nameCompatible,
  buildGcIndexes,
  linkSingle,
  dryRun,
};
