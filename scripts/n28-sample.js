#!/usr/bin/env node
'use strict';

/**
 * n28-sample.js — N28: Preflight Gate (read-only, ZERO chamadas LLM)
 *
 * ETAPAS:
 *   A) Leitura autenticada read-only do Firestore (perfis_360) via WIF
 *   B) Enriquecimento local com engines determinísticos (score, tendência, recorrência, oportunidade)
 *   C) Seleção determinística de até 12 clientes (exclui nuncaComprou=true)
 *   D) Pseudonimização SHADOW-001..012 (mapa ephemeral, NUNCA persiste)
 *   E) PII Gate: auditarContextoPrompt + escaneiarTextoParaPII em cada payload
 *   F) Geração de artefato sanitizado (ZERO PII, ZERO IDs reais, ZERO mapa)
 *
 * RESTRIÇÕES ABSOLUTAS:
 *   FIRESTORE_WRITES  = ZERO
 *   PROD_WRITES       = ZERO
 *   LLM_CALLS         = ZERO
 *   DEPLOYS           = ZERO
 *   PII_REAL_SENT     = ZERO
 *   MAPA_PERSISTIDO   = ZERO
 *
 * Autenticação: GOOGLE_APPLICATION_CREDENTIALS (WIF via GitHub Actions OIDC)
 * Service Account: mr4-sync@mr4-ponto.iam.gserviceaccount.com (mesmo do N21)
 *
 * Artefato de saída: artifacts/n28-sample-gates.json + artifacts/n28-sample-summary.txt
 * Artefato NUNCA contém: nome, telefone, email, CPF/CNPJ, endereço, IDs reais,
 *                        número de pedido, vendedor, observações, mapa real→SHADOW
 */

const { Firestore } = require('@google-cloud/firestore');
const fs   = require('fs');
const path = require('path');

// Engines determinísticos (mesmos usados em produção — sem deps externas)
const { calcularScore }       = require('../functions/lib/scoreComercial');
const { calcularTendencia }   = require('../functions/lib/tendenciaComercial');
const { calcularRecorrencia } = require('../functions/lib/recorrencia');
const { gerarOportunidades }  = require('../functions/lib/oportunidades');

// N28: seleção + pseudonimização
const { selecionarAmostra, pseudonimizar } = require('../functions/lib/n28/amostragem');

// N28: PII guard
const { auditarContextoPrompt, escaneiarTextoParaPII, PROMPT_ALLOWLIST } =
  require('../functions/lib/n28/piiGuard');

// ── Configuração ──────────────────────────────────────────────────────────────

const PROJECT_ID       = 'mr4-ponto';
const COLECAO_PERFIS   = 'perfis_360';
const MAX_DOCS         = 500;   // limite de leitura (precaução de custo/tempo)
const OUT_DIR          = path.join(__dirname, '..', 'artifacts');
const GATES_FILE       = path.join(OUT_DIR, 'n28-sample-gates.json');
const SUMMARY_FILE     = path.join(OUT_DIR, 'n28-sample-summary.txt');

// ── Enriquecimento determinístico ─────────────────────────────────────────────

function enriquecerPerfil(perfil) {
  const dataReferencia = new Date().toISOString().slice(0, 10);
  try {
    const tendencia     = calcularTendencia(perfil);
    const score         = calcularScore(perfil, tendencia?.tendencia);
    const recorrencia   = calcularRecorrencia(perfil);
    const oportunidades = gerarOportunidades(perfil, score, tendencia, recorrencia, dataReferencia);
    const oportunidade  = Array.isArray(oportunidades) && oportunidades.length > 0
      ? oportunidades[0] : null;

    return {
      ...perfil,
      _scoreTotal:             score?.scoreTotal            ?? null,
      _classificacao:          score?.classificacao         ?? null,
      _tendencia:              tendencia?.tendencia         ?? null,
      _recorrenciaStatus:      recorrencia?.status          ?? null,
      _oportunidadeTipo:       oportunidade?.tipo           ?? null,
      _oportunidadePrioridade: oportunidade?.prioridade     ?? null,
      _score:                  score,
      _tendenciaObj:           tendencia,
      _recorrenciaObj:         recorrencia,
      _oportunidade:           oportunidade,
      _dataReferencia:         dataReferencia,
    };
  } catch (_) {
    // Perfil com dados insuficientes — mantém sem enriquecimento
    return { ...perfil, _enriquecimentoFalhou: true };
  }
}

// ── PII Gate: constrói contextoRaw e audita ───────────────────────────────────

function construirEAuditarContexto(pseudo) {
  const contextoRaw = {
    tipoOportunidade:  pseudo._oportunidadeTipo  ?? null,
    scoreTotal:        pseudo._scoreTotal         ?? null,
    classificacao:     pseudo._classificacao      ?? null,
    diasSemComprar:    pseudo.diasSemComprar      ?? null,
    tendencia:         pseudo._tendencia          ?? null,
    recorrenciaStatus: pseudo._recorrenciaStatus  ?? null,
    prioridade:        pseudo._oportunidadePrioridade ?? null,
  };

  const auditCtx  = auditarContextoPrompt(contextoRaw);

  // Também escaneia cada valor string no contextoRaw como texto
  const valoresString = Object.values(contextoRaw)
    .filter(v => typeof v === 'string')
    .join(' | ');
  const auditTexto = escaneiarTextoParaPII(valoresString);

  return {
    contextoRaw,
    auditCtx,
    auditTexto,
    piiGateOk: auditCtx.ok && auditTexto.ok,
  };
}

// ── Verificação de segurança do artefato ──────────────────────────────────────

const CAMPOS_PROIBIDOS_NO_ARTEFATO = [
  'clienteMr4Id', 'gestaoClickId', 'nome', 'email', 'telefone',
  'cpf', 'cnpj', 'endereco', 'cep', 'cidade', 'bairro', 'estado',
  'ultimaCompraEm', 'primeiraCompraEm', 'dataReferencia',
  'vendedorId', 'vendedorNome', 'observacoes', 'numeroPedido',
];

function auditarArtefato(entrada) {
  const texto = JSON.stringify(entrada);
  const violacoes = [];

  // 1. Verifica campos proibidos nas chaves
  function verificarObjeto(obj, caminho = '') {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const campoPath = caminho ? `${caminho}.${k}` : k;
      if (CAMPOS_PROIBIDOS_NO_ARTEFATO.includes(k)) {
        violacoes.push(`CAMPO_PROIBIDO: ${campoPath}`);
      }
      if (typeof v === 'object' && v !== null) {
        verificarObjeto(v, campoPath);
      }
    }
  }
  verificarObjeto(entrada);

  // 2. PII regex scan no texto completo do artefato
  const { ok: piiOk, encontrado } = escaneiarTextoParaPII(texto);
  if (!piiOk) {
    violacoes.push(`PII_NO_ARTEFATO: ${encontrado.join(',')}`);
  }

  // 3. Verifica que nenhum shadowId aparece mapeado para um ID real
  // (o mapa nunca deve estar no artefato — verificação defensiva)
  if (texto.includes('clienteMr4Id') || texto.includes('gestaoClickId')) {
    violacoes.push('ID_REAL_NO_ARTEFATO: clienteMr4Id ou gestaoClickId encontrado');
  }

  return { ok: violacoes.length === 0, violacoes };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[N28-SAMPLE] Iniciando preflight gate — READ-ONLY, ZERO LLM');
  console.log(`[N28-SAMPLE] Projeto: ${PROJECT_ID} | Coleção: ${COLECAO_PERFIS}`);

  const t0 = Date.now();
  let firestoreRead = 'FAIL';
  let perfisLidos   = 0;

  // ── A) Leitura Firestore (WIF read-only) ──────────────────────────────────
  const db = new Firestore({ projectId: PROJECT_ID, databaseId: '(default)' });

  let perfisRaw = [];
  try {
    console.log(`[N28-SAMPLE] Lendo até ${MAX_DOCS} documentos de ${COLECAO_PERFIS}...`);
    const snap = await db.collection(COLECAO_PERFIS).limit(MAX_DOCS).get();
    snap.forEach(doc => {
      perfisRaw.push({ clienteMr4Id: doc.id, ...doc.data() });
    });
    perfisLidos   = perfisRaw.length;
    firestoreRead = 'PASS';
    console.log(`[N28-SAMPLE] ${perfisLidos} documentos lidos. FIRESTORE_WRITES=ZERO`);
  } catch (err) {
    console.error(`[N28-SAMPLE] ERRO Firestore: ${err.message}`);
    console.error('[N28-SAMPLE] PARE: FIRESTORE_READ=FAIL');
    process.exit(1);
  }

  // ── B) Enriquecimento local ───────────────────────────────────────────────
  console.log('[N28-SAMPLE] Enriquecendo com engines determinísticos...');
  const perfisEnriquecidos = perfisRaw.map(enriquecerPerfil);

  // ── C) Seleção determinística (≤12, exclui nuncaComprou=true) ─────────────
  console.log('[N28-SAMPLE] Selecionando amostra...');
  const { selecionados, estatisticas } = selecionarAmostra(perfisEnriquecidos);
  console.log(`[N28-SAMPLE] ${selecionados.length} selecionados de ${estatisticas.totalElegiveis} elegíveis`);
  console.log(`[N28-SAMPLE] ${estatisticas.totalNuncaComprou} excluídos (nuncaComprou=true)`);

  // ── D) Pseudonimização (mapa ephemeral — NUNCA incluído no artefato) ───────
  const { pseudonimizados, mapa } = pseudonimizar(selecionados);
  // mapa (SHADOW-XXX → clienteMr4Id) existe SOMENTE nesta variável local,
  // nunca entra no artefato ou em qualquer log.
  console.log(`[N28-SAMPLE] ${pseudonimizados.length} perfis pseudonimizados (SHADOW-001..012)`);

  // ── E) PII Gate em cada payload ───────────────────────────────────────────
  console.log('[N28-SAMPLE] Auditando PII em cada payload...');
  const payloads = [];
  let neverBoughtSent = 0;
  let piiViolacoes    = 0;

  for (const pseudo of pseudonimizados) {
    if (pseudo.nuncaComprou === true) neverBoughtSent++;

    const { contextoRaw, auditCtx, auditTexto, piiGateOk } =
      construirEAuditarContexto(pseudo);

    if (!piiGateOk) {
      piiViolacoes++;
      console.error(`[N28-SAMPLE] PII_BLOCK: ${pseudo.shadowId} — campos=${auditCtx.camposProibidos.join(',')}, pii=${auditCtx.piiEncontrado.join(',')}`);
    }

    payloads.push({
      shadowId:    pseudo.shadowId,
      contextoRaw,   // 7 campos estruturados — allowlist completa
      auditCtx:    { ok: auditCtx.ok, camposProibidos: auditCtx.camposProibidos, piiEncontrado: auditCtx.piiEncontrado },
      auditTexto:  { ok: auditTexto.ok, encontrado: auditTexto.encontrado },
      piiGateOk,
      temOportunidade: !!pseudo._oportunidadeTipo,
    });
  }

  // ── F) Geração do artefato sanitizado ────────────────────────────────────
  const allowlistCampos = [...PROMPT_ALLOWLIST];
  const piiPayloadScan  = piiViolacoes === 0 ? 'PASS' : 'FAIL';
  const allowlistOk     = payloads.every(p => p.auditCtx.ok);
  const allowlistStatus = allowlistOk ? 'PASS' : 'FAIL';

  // Gates finais
  // READ_ONLY_AUTH_METHOD: valor completo (console/summary) — contém email de SA (não é PII de pessoa real)
  // READ_ONLY_AUTH_ARTEFATO: redactado para o JSON do artefato — remove o padrão de email para não disparar
  //   escaneiarTextoParaPII, que não distingue SA email de email de pessoa física.
  const READ_ONLY_AUTH_METHOD    = 'WIF/OIDC — github-actions-pool — mr4-sync@mr4-ponto.iam.gserviceaccount.com';
  const READ_ONLY_AUTH_ARTEFATO  = 'WIF/OIDC — github-actions-pool — [SA:mr4-sync]';
  const FIRESTORE_READ_STATUS  = firestoreRead;
  const SAMPLE_SIZE            = pseudonimizados.length;
  const NEVER_BOUGHT_SENT      = neverBoughtSent;
  const PII_PAYLOAD_SCAN       = piiPayloadScan;
  const ALLOWLIST_PAYLOAD      = allowlistStatus;
  const REAL_IDENTIFIERS_SENT  = 0;  // garantido pela pseudonimização + auditarArtefato abaixo

  const N28_PREFLIGHT_GATE = (
    firestoreRead === 'PASS' &&
    neverBoughtSent === 0 &&
    piiViolacoes   === 0 &&
    allowlistOk
  ) ? 'PASS' : 'FAIL';

  // Artefato: SOMENTE dados pseudonimizados e gates — ZERO PII / ZERO IDs reais
  const artefato = {
    _meta: {
      timestamp:          new Date().toISOString(),
      versao:             'n28-sample-v1',
      projeto:            PROJECT_ID,
      colecao:            COLECAO_PERFIS,
      LLM_CALLS:          0,
      FIRESTORE_WRITES:   0,
      PROD_WRITES:        0,
      DEPLOYS:            0,
      MAPA_PERSISTIDO:    false,
    },
    gates: {
      READ_ONLY_AUTH_METHOD: READ_ONLY_AUTH_ARTEFATO,  // redactado: sem email-pattern no artefato
      FIRESTORE_READ:         FIRESTORE_READ_STATUS,
      SAMPLE_SIZE,
      NEVER_BOUGHT_SENT,
      PII_PAYLOAD_SCAN,
      ALLOWLIST_PAYLOAD,
      REAL_IDENTIFIERS_SENT,
      N28_PREFLIGHT_GATE,
    },
    estatisticas: {
      totalUniverso:      estatisticas.totalUniverso,
      totalElegiveis:     estatisticas.totalElegiveis,
      totalNuncaComprou:  estatisticas.totalNuncaComprou,
      totalSelecionados:  estatisticas.totalSelecionados,
      categoriasCobertas: estatisticas.categoriasCobertas,
      categoriasFaltando: estatisticas.categoriasFaltando,
    },
    // Payload sanitizado de cada cliente selecionado.
    // Contém SOMENTE shadowId + os 7 campos estruturados da allowlist.
    // Nunca contém: IDs reais, nome, email, telefone, CPF/CNPJ, endereço, mapa.
    amostraSanitizada: payloads,
  };

  // Auditoria defensiva: verifica que o artefato não tem PII/IDs reais antes de salvar
  const auditArtefato = auditarArtefato(artefato);
  if (!auditArtefato.ok) {
    console.error('[N28-SAMPLE] ABORT: Artefato contém PII ou ID real!');
    for (const v of auditArtefato.violacoes) {
      console.error(`  VIOLAÇÃO: ${v}`);
    }
    console.error('[N28-SAMPLE] ZERO arquivos salvos. PARE.');
    process.exit(1);
  }

  // ── Salvar artefatos ──────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(GATES_FILE,   JSON.stringify(artefato, null, 2));

  const summary = [
    `DATA_REFERENCIA=${new Date().toISOString().slice(0, 10)}`,
    `READ_ONLY_AUTH_METHOD=${READ_ONLY_AUTH_METHOD}`,
    `FIRESTORE_READ=${FIRESTORE_READ_STATUS}`,
    `DOCS_LIDOS=${perfisLidos}`,
    `SAMPLE_SIZE=${SAMPLE_SIZE}`,
    `NEVER_BOUGHT_SENT=${NEVER_BOUGHT_SENT}`,
    `PII_PAYLOAD_SCAN=${PII_PAYLOAD_SCAN}`,
    `ALLOWLIST_PAYLOAD=${ALLOWLIST_PAYLOAD}`,
    `REAL_IDENTIFIERS_SENT=${REAL_IDENTIFIERS_SENT}`,
    `MAPA_PERSISTIDO=false`,
    `LLM_CALLS=0`,
    `FIRESTORE_WRITES=0`,
    `PROD_WRITES=0`,
    `CATEGORIAS_COBERTAS=${estatisticas.categoriasCobertas.join(',')}`,
    `CATEGORIAS_FALTANDO=${estatisticas.categoriasFaltando.join(',') || 'NENHUMA'}`,
    `DURACAO_MS=${Date.now() - t0}`,
    `N28_PREFLIGHT_GATE=${N28_PREFLIGHT_GATE}`,
  ].join('\n');

  fs.writeFileSync(SUMMARY_FILE, summary);

  // ── Relatório no console ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  N28 — PREFLIGHT GATE (READ-ONLY, ZERO LLM)');
  console.log('═'.repeat(60));
  console.log(`  READ_ONLY_AUTH_METHOD:  WIF/OIDC (mr4-sync SA)`);
  console.log(`  FIRESTORE_READ:         ${FIRESTORE_READ_STATUS}`);
  console.log(`  Documentos lidos:       ${perfisLidos}`);
  console.log(`  SAMPLE_SIZE:            ${SAMPLE_SIZE}`);
  console.log(`  NEVER_BOUGHT_SENT:      ${NEVER_BOUGHT_SENT}`);
  console.log(`  PII_PAYLOAD_SCAN:       ${PII_PAYLOAD_SCAN}`);
  console.log(`  ALLOWLIST_PAYLOAD:      ${ALLOWLIST_PAYLOAD}`);
  console.log(`  REAL_IDENTIFIERS_SENT:  ${REAL_IDENTIFIERS_SENT}`);
  console.log(`  MAPA_PERSISTIDO:        false`);
  console.log(`  LLM_CALLS:              0`);
  console.log(`  FIRESTORE_WRITES:       0`);
  console.log(`  Categorias cobertas:    ${estatisticas.categoriasCobertas.join(', ') || '(nenhuma)'}`);
  console.log(`  Categorias faltando:    ${estatisticas.categoriasFaltando.join(', ') || '(nenhuma)'}`);
  console.log(`  Duração:                ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('');
  console.log(`  N28_PREFLIGHT_GATE:     ${N28_PREFLIGHT_GATE}`);
  console.log('═'.repeat(60) + '\n');

  if (N28_PREFLIGHT_GATE !== 'PASS') {
    console.error('[N28-SAMPLE] GATE FAIL — corrigir problemas antes de prosseguir.');
    process.exit(1);
  }

  console.log('[N28-SAMPLE] GATE PASS — artefato sanitizado gerado.');
  console.log(`[N28-SAMPLE] Artefato: ${GATES_FILE}`);
  console.log('[N28-SAMPLE] Próximo passo: decidir mecanismo para chamadas OpenAI (N28 etapa LLM).');
  console.log('[N28-SAMPLE] PARE — não iniciar N29.\n');
}

main().catch(err => {
  console.error('[N28-SAMPLE] Erro fatal:', err.message);
  process.exit(1);
});
