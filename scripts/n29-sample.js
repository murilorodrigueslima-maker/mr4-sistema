#!/usr/bin/env node
'use strict';

/**
 * n29-sample.js — N29: Preflight Gate (read-only, ZERO chamadas LLM)
 *
 * ETAPAS:
 *   A) Leitura autenticada read-only do Firestore (perfis_360) via WIF
 *   B) Enriquecimento local com engines determinísticos (score, tendência, recorrência, oportunidade)
 *   C) Seleção determinística de até 12 clientes (exclui nuncaComprou=true) — reutiliza N28
 *   D) Pseudonimização V2 — SHADOW-001..012, 22 campos (mapa ephemeral, NUNCA persiste)
 *   E) PII Gate V2: auditarContextoPromptV2 + escaneiarTextoParaPII em cada payload
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
 * Service Account: mr4-sync@mr4-ponto.iam.gserviceaccount.com
 *
 * Artefato de saída: artifacts/n29-sample-gates.json + artifacts/n29-sample-summary.txt
 * Artefato NUNCA contém: nome, telefone, email, CPF/CNPJ, endereço, IDs reais,
 *                        número de pedido, vendedor, observações, mapa real→SHADOW,
 *                        texto livre de ERP (produtosMaisComprados, categoriasMaisCompradas)
 */

const { Firestore } = require('@google-cloud/firestore');
const fs   = require('fs');
const path = require('path');

// Engines determinísticos (mesmos usados em produção)
const { calcularScore }       = require('../functions/lib/scoreComercial');
const { calcularTendencia }   = require('../functions/lib/tendenciaComercial');
const { calcularRecorrencia } = require('../functions/lib/recorrencia');
const { gerarOportunidades }  = require('../functions/lib/oportunidades');

// N28: seleção (reutilizada — critérios idênticos, N28 amostragem.js é frozen)
const { selecionarAmostra } = require('../functions/lib/n28/amostragem');

// N29: PII guard V2
const { auditarContextoPromptV2, escaneiarTextoParaPII, PROMPT_ALLOWLIST_V2 } =
  require('../functions/lib/n29/piiGuard');

// ── Configuração ──────────────────────────────────────────────────────────────

const PROJECT_ID     = 'mr4-ponto';
const COLECAO_PERFIS = 'perfis_360';
const MAX_DOCS       = 500;
const OUT_DIR        = path.join(__dirname, '..', 'artifacts');
const GATES_FILE     = path.join(OUT_DIR, 'n29-sample-gates.json');
const SUMMARY_FILE   = path.join(OUT_DIR, 'n29-sample-summary.txt');

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
      _dataReferencia:         dataReferencia,
    };
  } catch (_) {
    return { ...perfil, _enriquecimentoFalhou: true };
  }
}

// ── Pseudonimização V2 (22 campos, inline — não modifica n28/amostragem.js) ───

function pseudonimizarV2(selecionados) {
  const mapa = new Map();
  const pseudonimizados = [];

  for (let i = 0; i < selecionados.length; i++) {
    const shadowId = `SHADOW-${String(i + 1).padStart(3, '0')}`;
    const o        = selecionados[i];

    mapa.set(shadowId, o.clienteMr4Id);

    // quantidadeCategoriasDistintas: contagem segura a partir do array Firestore.
    // O campo categoriasMaisCompradas[] contém texto ERP (nome_grupo) — excluído do artefato.
    const quantidadeCategoriasDistintas =
      Array.isArray(o.categoriasMaisCompradas) ? o.categoriasMaisCompradas.length : null;

    const pseudo = {
      shadowId,
      // Campos N28 (preservados)
      nuncaComprou:            o.nuncaComprou,
      inativo120d:             o.inativo120d,
      diasSemComprar:          o.diasSemComprar          ?? null,
      pedidosTotal:            o.pedidosTotal            ?? null,
      pedidos30d:              o.pedidos30d              ?? 0,
      pedidos60d:              o.pedidos60d              ?? 0,
      pedidos90d:              o.pedidos90d              ?? 0,
      pedidos180d:             o.pedidos180d             ?? 0,
      diasEntreComprasMedio:   o.diasEntreComprasMedio   ?? null,
      diasEntreComprasMediana: o.diasEntreComprasMediana ?? null,
      _scoreTotal:             o._scoreTotal,
      _classificacao:          o._classificacao,
      _tendencia:              o._tendencia,
      _recorrenciaStatus:      o._recorrenciaStatus,
      _oportunidadeTipo:       o._oportunidadeTipo,
      _oportunidadePrioridade: o._oportunidadePrioridade,
      // Campos N29 novos — faturamento/ticket em R$ (Firestore armazena como float)
      faturamentoTotal:          o.faturamentoTotal          ?? null,
      faturamento30d:            o.faturamento30d            ?? null,
      faturamento60d:            o.faturamento60d            ?? null,
      faturamento90d:            o.faturamento90d            ?? null,
      faturamento180d:           o.faturamento180d           ?? null,
      ticketMedioTotal:          o.ticketMedioTotal          ?? null,
      quantidadeProdutosDistintos: o.quantidadeProdutosDistintos ?? null,
      quantidadeCategoriasDistintas,
      // SEM: clienteMr4Id, gestaoClickId, nome, email, telefone, cpf, cnpj,
      //       endereço, cep, cidade, ultimaCompraEm, primeiraCompraEm, dataReferencia,
      //       vendedorUltimaVendaNome, vendedorUltimaVendaId,
      //       produtosMaisComprados[] (ERP text), categoriasMaisCompradas[] (ERP text)
    };

    pseudonimizados.push(pseudo);
  }

  return { pseudonimizados, mapa };
}

// ── PII Gate V2: constrói contextoRaw V2 e audita ────────────────────────────

function construirEAuditarContextoV2(pseudo) {
  const contextoRaw = {
    tipoOportunidade:            pseudo._oportunidadeTipo       ?? null,
    scoreTotal:                  pseudo._scoreTotal              ?? null,
    classificacao:               pseudo._classificacao           ?? null,
    diasSemComprar:              pseudo.diasSemComprar           ?? null,
    tendencia:                   pseudo._tendencia               ?? null,
    recorrenciaStatus:           pseudo._recorrenciaStatus       ?? null,
    prioridade:                  pseudo._oportunidadePrioridade  ?? null,
    pedidosTotal:                pseudo.pedidosTotal             ?? null,
    pedidos30d:                  pseudo.pedidos30d               ?? null,
    pedidos60d:                  pseudo.pedidos60d               ?? null,
    pedidos90d:                  pseudo.pedidos90d               ?? null,
    pedidos180d:                 pseudo.pedidos180d              ?? null,
    faturamentoTotal:            pseudo.faturamentoTotal         ?? null,
    faturamento30d:              pseudo.faturamento30d           ?? null,
    faturamento60d:              pseudo.faturamento60d           ?? null,
    faturamento90d:              pseudo.faturamento90d           ?? null,
    faturamento180d:             pseudo.faturamento180d          ?? null,
    ticketMedioTotal:            pseudo.ticketMedioTotal         ?? null,
    diasEntreComprasMedio:       pseudo.diasEntreComprasMedio    ?? null,
    diasEntreComprasMediana:     pseudo.diasEntreComprasMediana  ?? null,
    quantidadeProdutosDistintos: pseudo.quantidadeProdutosDistintos ?? null,
    quantidadeCategoriasDistintas: pseudo.quantidadeCategoriasDistintas ?? null,
  };

  const auditCtx   = auditarContextoPromptV2(contextoRaw);

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
  'vendedorId', 'vendedorNome', 'vendedorUltimaVendaNome', 'vendedorUltimaVendaId',
  'observacoes', 'numeroPedido',
  'produtosMaisComprados', 'categoriasMaisCompradas',
];

function auditarArtefato(entrada) {
  const texto = JSON.stringify(entrada);
  const violacoes = [];

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

  const { ok: piiOk, encontrado } = escaneiarTextoParaPII(texto);
  if (!piiOk) {
    violacoes.push(`PII_NO_ARTEFATO: ${encontrado.join(',')}`);
  }

  if (texto.includes('clienteMr4Id') || texto.includes('gestaoClickId')) {
    violacoes.push('ID_REAL_NO_ARTEFATO: clienteMr4Id ou gestaoClickId encontrado');
  }

  return { ok: violacoes.length === 0, violacoes };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[N29-SAMPLE] Iniciando preflight gate V2 — READ-ONLY, ZERO LLM');
  console.log(`[N29-SAMPLE] Projeto: ${PROJECT_ID} | Coleção: ${COLECAO_PERFIS}`);

  const t0 = Date.now();
  let firestoreRead = 'FAIL';
  let perfisLidos   = 0;

  // ── A) Leitura Firestore (WIF read-only) ──────────────────────────────────
  const db = new Firestore({ projectId: PROJECT_ID, databaseId: '(default)' });

  let perfisRaw = [];
  try {
    console.log(`[N29-SAMPLE] Lendo até ${MAX_DOCS} documentos de ${COLECAO_PERFIS}...`);
    const snap = await db.collection(COLECAO_PERFIS).limit(MAX_DOCS).get();
    snap.forEach(doc => {
      perfisRaw.push({ clienteMr4Id: doc.id, ...doc.data() });
    });
    perfisLidos   = perfisRaw.length;
    firestoreRead = 'PASS';
    console.log(`[N29-SAMPLE] ${perfisLidos} documentos lidos. FIRESTORE_WRITES=ZERO`);
  } catch (err) {
    console.error(`[N29-SAMPLE] ERRO Firestore: ${err.message}`);
    console.error('[N29-SAMPLE] PARE: FIRESTORE_READ=FAIL');
    process.exit(1);
  }

  // ── B) Enriquecimento local ───────────────────────────────────────────────
  console.log('[N29-SAMPLE] Enriquecendo com engines determinísticos...');
  const perfisEnriquecidos = perfisRaw.map(enriquecerPerfil);

  // ── C) Seleção determinística (≤12, exclui nuncaComprou=true) ─────────────
  console.log('[N29-SAMPLE] Selecionando amostra (critérios N28 reusados)...');
  const { selecionados, estatisticas } = selecionarAmostra(perfisEnriquecidos);
  console.log(`[N29-SAMPLE] ${selecionados.length} selecionados de ${estatisticas.totalElegiveis} elegíveis`);
  console.log(`[N29-SAMPLE] ${estatisticas.totalNuncaComprou} excluídos (nuncaComprou=true)`);

  // ── D) Pseudonimização V2 (mapa ephemeral — NUNCA incluído no artefato) ───
  const { pseudonimizados, mapa } = pseudonimizarV2(selecionados);
  // mapa (SHADOW-XXX → clienteMr4Id) existe SOMENTE nesta variável local.
  console.log(`[N29-SAMPLE] ${pseudonimizados.length} perfis pseudonimizados V2 (22 campos)`);

  // ── E) PII Gate V2 em cada payload ───────────────────────────────────────
  console.log('[N29-SAMPLE] Auditando PII V2 em cada payload...');
  const payloads = [];
  let neverBoughtSent = 0;
  let piiViolacoes    = 0;

  for (const pseudo of pseudonimizados) {
    if (pseudo.nuncaComprou === true) neverBoughtSent++;

    const { contextoRaw, auditCtx, auditTexto, piiGateOk } =
      construirEAuditarContextoV2(pseudo);

    if (!piiGateOk) {
      piiViolacoes++;
      console.error(`[N29-SAMPLE] PII_BLOCK: ${pseudo.shadowId} — campos=${auditCtx.camposProibidos.join(',')}, pii=${auditCtx.piiEncontrado.join(',')}`);
    }

    payloads.push({
      shadowId:    pseudo.shadowId,
      contextoRaw,
      auditCtx:    { ok: auditCtx.ok, camposProibidos: auditCtx.camposProibidos, piiEncontrado: auditCtx.piiEncontrado },
      auditTexto:  { ok: auditTexto.ok, encontrado: auditTexto.encontrado },
      piiGateOk,
      temOportunidade: !!pseudo._oportunidadeTipo,
    });
  }

  // ── F) Geração do artefato sanitizado ────────────────────────────────────
  const allowlistCampos = [...PROMPT_ALLOWLIST_V2];
  const piiPayloadScan  = piiViolacoes === 0 ? 'PASS' : 'FAIL';
  const allowlistOk     = payloads.every(p => p.auditCtx.ok);
  const allowlistStatus = allowlistOk ? 'PASS' : 'FAIL';

  const READ_ONLY_AUTH_METHOD   = 'WIF/OIDC — github-actions-pool — mr4-sync@mr4-ponto.iam.gserviceaccount.com';
  const READ_ONLY_AUTH_ARTEFATO = 'WIF/OIDC — github-actions-pool — [SA:mr4-sync]';
  const FIRESTORE_READ_STATUS   = firestoreRead;
  const SAMPLE_SIZE             = pseudonimizados.length;
  const NEVER_BOUGHT_SENT       = neverBoughtSent;
  const PII_PAYLOAD_SCAN        = piiPayloadScan;
  const ALLOWLIST_PAYLOAD       = allowlistStatus;
  const REAL_IDENTIFIERS_SENT   = 0;

  const N29_PREFLIGHT_GATE = (
    firestoreRead === 'PASS' &&
    neverBoughtSent === 0 &&
    piiViolacoes   === 0 &&
    allowlistOk
  ) ? 'PASS' : 'FAIL';

  const artefato = {
    _meta: {
      timestamp:        new Date().toISOString(),
      versao:           'n29-sample-v1',
      projeto:          PROJECT_ID,
      colecao:          COLECAO_PERFIS,
      camposContexto:   allowlistCampos.length,
      LLM_CALLS:        0,
      FIRESTORE_WRITES: 0,
      PROD_WRITES:      0,
      DEPLOYS:          0,
      MAPA_PERSISTIDO:  false,
    },
    gates: {
      READ_ONLY_AUTH_METHOD: READ_ONLY_AUTH_ARTEFATO,
      FIRESTORE_READ:         FIRESTORE_READ_STATUS,
      SAMPLE_SIZE,
      NEVER_BOUGHT_SENT,
      PII_PAYLOAD_SCAN,
      ALLOWLIST_PAYLOAD,
      REAL_IDENTIFIERS_SENT,
      N29_PREFLIGHT_GATE,
    },
    estatisticas: {
      totalUniverso:      estatisticas.totalUniverso,
      totalElegiveis:     estatisticas.totalElegiveis,
      totalNuncaComprou:  estatisticas.totalNuncaComprou,
      totalSelecionados:  estatisticas.totalSelecionados,
      categoriasCobertas: estatisticas.categoriasCobertas,
      categoriasFaltando: estatisticas.categoriasFaltando,
    },
    // Payload sanitizado de cada cliente: SOMENTE shadowId + 22 campos da allowlist V2.
    // Nunca contém: IDs reais, nome, email, telefone, CPF/CNPJ, endereço, mapa,
    //               texto ERP (produtosMaisComprados, categoriasMaisCompradas).
    amostraSanitizada: payloads,
  };

  const auditArtefato = auditarArtefato(artefato);
  if (!auditArtefato.ok) {
    console.error('[N29-SAMPLE] ABORT: Artefato contém PII ou campo proibido!');
    for (const v of auditArtefato.violacoes) {
      console.error(`  VIOLAÇÃO: ${v}`);
    }
    console.error('[N29-SAMPLE] ZERO arquivos salvos. PARE.');
    process.exit(1);
  }

  // ── Salvar artefatos ──────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(GATES_FILE, JSON.stringify(artefato, null, 2));

  const summary = [
    `DATA_REFERENCIA=${new Date().toISOString().slice(0, 10)}`,
    `READ_ONLY_AUTH_METHOD=${READ_ONLY_AUTH_METHOD}`,
    `FIRESTORE_READ=${FIRESTORE_READ_STATUS}`,
    `DOCS_LIDOS=${perfisLidos}`,
    `SAMPLE_SIZE=${SAMPLE_SIZE}`,
    `CAMPOS_CONTEXTO=${allowlistCampos.length}`,
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
    `N29_PREFLIGHT_GATE=${N29_PREFLIGHT_GATE}`,
  ].join('\n');

  fs.writeFileSync(SUMMARY_FILE, summary);

  // ── Relatório no console ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  N29 — PREFLIGHT GATE V2 (READ-ONLY, ZERO LLM)');
  console.log('═'.repeat(60));
  console.log(`  READ_ONLY_AUTH_METHOD:  WIF/OIDC (mr4-sync SA)`);
  console.log(`  FIRESTORE_READ:         ${FIRESTORE_READ_STATUS}`);
  console.log(`  Documentos lidos:       ${perfisLidos}`);
  console.log(`  SAMPLE_SIZE:            ${SAMPLE_SIZE}`);
  console.log(`  Campos de contexto:     ${allowlistCampos.length} (V2)`);
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
  console.log(`  N29_PREFLIGHT_GATE:     ${N29_PREFLIGHT_GATE}`);
  console.log('═'.repeat(60) + '\n');

  if (N29_PREFLIGHT_GATE !== 'PASS') {
    console.error('[N29-SAMPLE] GATE FAIL — corrigir problemas antes de prosseguir.');
    process.exit(1);
  }

  console.log('[N29-SAMPLE] GATE PASS — artefato sanitizado V2 gerado.');
  console.log(`[N29-SAMPLE] Artefato: ${GATES_FILE}`);
  console.log('[N29-SAMPLE] PARE — aguardar revisão humana antes de autorizar chamadas Luna.');
  console.log('[N29-SAMPLE] NÃO iniciar N30. NÃO ativar ASSIST. NÃO fazer deploy.\n');
}

main().catch(err => {
  console.error('[N29-SAMPLE] Erro fatal:', err.message);
  process.exit(1);
});
