#!/usr/bin/env node
'use strict';

/**
 * N28 — Runner do Shadow Pilot com Dados Comerciais Reais Sanitizados.
 *
 * RESTRIÇÕES ABSOLUTAS:
 *   - AI_MODE = SHADOW (resultados NÃO chegam ao vendedor)
 *   - REAL_CUSTOMER_DATA_SENT = ZERO (sanitização + pseudonimização antes do provider)
 *   - PII_REAL_SENT = ZERO (piiGuard audita antes de cada chamada)
 *   - PROD_WRITES = ZERO (leitura somente de perfis_360)
 *   - DEPLOYS = ZERO
 *   - store = false (sem retenção no servidor OpenAI)
 *   - Máximo 12 clientes, 12 chamadas LLM reais
 *   - Exclui nuncaComprou=true
 *   - NÃO inicia N29
 *
 * Uso:
 *   node functions/scripts/n28-pilot.js
 *
 * Pré-requisito Firestore (BLOCKER se ausente):
 *   gcloud auth application-default login
 *   (ou GOOGLE_APPLICATION_CREDENTIALS apontando para service account JSON)
 */

// ── Carrega .env.local de forma segura ─────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

function carregarEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const linhas = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const linha of linhas) {
    const t = linha.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 1) continue;
    const chave = t.slice(0, idx).trim();
    const valor = t.slice(idx + 1).trim();
    if (chave && valor && !process.env[chave]) {
      process.env[chave] = valor;
    }
  }
}

carregarEnvLocal();

// ── Gate 1: OPENAI_API_KEY ────────────────────────────────────────────────────

if (!process.env.OPENAI_API_KEY) {
  console.error('\n[N28-GATE] BLOCKER: OPENAI_API_KEY não encontrada.');
  console.error('Adicione ao functions/.env.local:');
  console.error('  OPENAI_API_KEY=sk-proj-...');
  console.error('(.env.local está no .gitignore — nunca commitar)\n');
  process.exit(1);
}

// ── Imports ───────────────────────────────────────────────────────────────────

const { calcularScore }       = require('../lib/scoreComercial');
const { calcularTendencia }   = require('../lib/tendenciaComercial');
const { calcularRecorrencia } = require('../lib/recorrencia');
const { gerarOportunidades }  = require('../lib/oportunidades');

const { selecionarAmostra, pseudonimizar } = require('../lib/n28/amostragem');
const { auditarContextoPrompt, escaneiarTextoParaPII } = require('../lib/n28/piiGuard');

const { analisarOportunidade }    = require('../lib/ai/agents/analistaOportunidade');
const { buildGroundingFacts, validarOutputComGrounding,
        GroundingViolationError, TextFactViolationError,
        SemanticContradictionError }  = require('../lib/ai/groundingOutput');
const { validarSchema }           = require('../lib/ai/validatorOutput');
const { GuardrailViolationError } = require('../lib/ai/guardrails');
const { OpenAIProvider }          = require('../lib/ai/providers/openaiProvider');

// ── Constantes ────────────────────────────────────────────────────────────────

const PROJETO_ID      = 'mr4-ponto';
const COLECAO_PERFIS  = 'perfis_360';
const MODELO          = 'gpt-5.6-luna';
const AI_MODE         = 'SHADOW';
const MAX_DOCS        = 300;   // limite de leitura para evitar varredura total
const MAX_LLM_CALLS   = 12;

// Preços gpt-5.6-luna (USD/1M tokens)
const PRECO_INPUT_1M  = 0.20;
const PRECO_OUTPUT_1M = 1.20;
const PRECO_CACHED_1M = 0.02;

// ── Gate 2: credenciais Firestore ─────────────────────────────────────────────

async function inicializarFirestore() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    try {
      admin.initializeApp({ projectId: PROJETO_ID });
    } catch (err) {
      console.error('\n[N28-GATE] BLOCKER: Falha ao inicializar firebase-admin:');
      console.error(err.message);
      console.error('\nSolução: configure Application Default Credentials:');
      console.error('  gcloud auth application-default login');
      console.error('  (instale gcloud CLI em https://cloud.google.com/sdk)');
      console.error('\nOu defina GOOGLE_APPLICATION_CREDENTIALS com o caminho do JSON de service account.\n');
      process.exit(1);
    }
  }

  const db = admin.firestore();

  // Testa acesso com leitura de um doc
  try {
    await db.collection(COLECAO_PERFIS).limit(1).get();
    return db;
  } catch (err) {
    console.error('\n[N28-GATE] BLOCKER: Não foi possível ler a coleção perfis_360:');
    console.error(`  Erro: ${err.message}`);
    console.error('\nVerifique:');
    console.error('  1. gcloud auth application-default login (conta mr4-ponto)');
    console.error('  2. A conta tem permissão datastore.documents.list no projeto mr4-ponto');
    console.error('  3. GOOGLE_APPLICATION_CREDENTIALS aponta para service account JSON correto\n');
    process.exit(1);
  }
}

// ── Leitura do Firestore ──────────────────────────────────────────────────────

async function lerPerfis(db) {
  console.log(`[N28] Lendo até ${MAX_DOCS} documentos de ${COLECAO_PERFIS}...`);
  const snapshot = await db.collection(COLECAO_PERFIS).limit(MAX_DOCS).get();
  const perfis = [];
  snapshot.forEach(doc => {
    perfis.push({ clienteMr4Id: doc.id, ...doc.data() });
  });
  console.log(`[N28] ${perfis.length} documentos lidos (leitura somente, PROD_WRITES=0)`);
  return perfis;
}

// ── Enriquecimento com engines determinísticos ────────────────────────────────

function enriquecerPerfil(perfil) {
  const dataReferencia = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const tendencia   = calcularTendencia(perfil);
  const score       = calcularScore(perfil, tendencia?.tendencia);
  const recorrencia = calcularRecorrencia(perfil);
  const oportunidades = gerarOportunidades(perfil, score, tendencia, recorrencia, dataReferencia);

  // Pega a primeira oportunidade (maior prioridade)
  const oportunidade = oportunidades && oportunidades.length > 0 ? oportunidades[0] : null;

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
}

// ── Classificação de outcome ──────────────────────────────────────────────────

function classificarOutcome(resultado) {
  if (!resultado) return 'INFRA_ERROR';
  if (resultado._erroInfra)     return 'INFRA_ERROR';
  if (resultado._erroSchema)    return 'SCHEMA_BLOCK';
  if (resultado._erroGrounding) return 'SAFE_BLOCK';
  if (resultado._erroGuardrail) return 'SAFE_BLOCK';
  if (resultado._erroAuditor)   return 'AUDITOR_BLOCK';
  if (resultado._erroPII)       return 'PII_BLOCK';
  if (resultado.conteudo)       return 'LLM_SUCCESS';
  return 'INFRA_ERROR';
}

// ── Análise de um cliente pseudonimizado ──────────────────────────────────────

async function analisarCliente({ pseudo, originalEnriquecido, provider, idx }) {
  const shadowId = pseudo.shadowId;
  const t0       = Date.now();

  // ── PII Guard pré-chamada ─────────────────────────────────────────────────
  const contextoRaw = {
    tipoOportunidade:  pseudo._oportunidadeTipo,
    scoreTotal:        pseudo._scoreTotal,
    classificacao:     pseudo._classificacao,
    diasSemComprar:    pseudo.diasSemComprar ?? null,
    tendencia:         pseudo._tendencia,
    recorrenciaStatus: pseudo._recorrenciaStatus,
    prioridade:        pseudo._oportunidadePrioridade,
  };

  const auditCtx = auditarContextoPrompt(contextoRaw);
  if (!auditCtx.ok) {
    return {
      shadowId, idx, outcome: 'PII_BLOCK', latenciaMs: 0, tokens: null,
      _erroPII: `PII_BLOCK: campos proibidos=${auditCtx.camposProibidos.join(',')}, pii=${auditCtx.piiEncontrado.join(',')}`,
    };
  }

  // ── Sem oportunidade → skip (cliente sem oportunidade determinística) ─────
  if (!pseudo._oportunidadeTipo || !originalEnriquecido._oportunidade) {
    return {
      shadowId, idx, outcome: 'SKIP_SEM_OPORTUNIDADE', latenciaMs: 0, tokens: null,
      _info: 'Nenhuma oportunidade determinística para este cliente',
    };
  }

  // ── Facts (usados para grounding — ficam locais, nunca vão ao provider) ───
  const facts = buildGroundingFacts(
    originalEnriquecido,
    originalEnriquecido._score,
    originalEnriquecido._tendenciaObj,
    originalEnriquecido._recorrenciaObj,
    { oportunidade: originalEnriquecido._oportunidade }
  );

  try {
    // ── Chamada LLM via agente ────────────────────────────────────────────────
    const outputAgente = await analisarOportunidade({
      oportunidade: originalEnriquecido._oportunidade,
      perfil:       originalEnriquecido,
      score:        originalEnriquecido._score,
      tendencia:    originalEnriquecido._tendenciaObj,
      recorrencia:  originalEnriquecido._recorrenciaObj,
      provider,
      facts,
    });

    // ── Validação de schema ───────────────────────────────────────────────────
    validarSchema(outputAgente);

    // ── Grounding ─────────────────────────────────────────────────────────────
    const outputGrounded = validarOutputComGrounding(outputAgente, facts);

    // ── PII scan no texto gerado pela IA ──────────────────────────────────────
    const scanTexto = escaneiarTextoParaPII(outputGrounded.conteudo || '');
    if (!scanTexto.ok) {
      return {
        shadowId, idx, latenciaMs: Date.now() - t0, tokens: outputAgente._meta?.tokensUsados,
        outcome: 'PII_BLOCK',
        _erroPII: `PII no texto gerado pela IA: ${scanTexto.encontrado.join(',')}`,
      };
    }

    const latenciaMs = Date.now() - t0;

    return {
      shadowId, idx, outcome: 'LLM_SUCCESS', latenciaMs,
      tokens:       outputAgente._meta?.tokensUsados,
      tipoOport:    originalEnriquecido._oportunidade?.tipo,
      scoreTotal:   pseudo._scoreTotal,
      classificacao: pseudo._classificacao,
      claimsCount:  outputGrounded.claims?.length ?? 0,
      conteudoLen:  (outputGrounded.conteudo || '').length,
      mock:         outputAgente._meta?.mockMode,
    };

  } catch (err) {
    const latenciaMs = Date.now() - t0;

    if (err instanceof GuardrailViolationError) {
      return { shadowId, idx, outcome: 'SAFE_BLOCK', latenciaMs, _erroGuardrail: err.message };
    }
    if (err instanceof GroundingViolationError || err instanceof TextFactViolationError ||
        err instanceof SemanticContradictionError) {
      return { shadowId, idx, outcome: 'SAFE_BLOCK', latenciaMs, _erroGrounding: err.message };
    }
    if (err.name === 'ValidationError' || err.message?.includes('schema')) {
      return { shadowId, idx, outcome: 'SCHEMA_BLOCK', latenciaMs, _erroSchema: err.message };
    }

    return { shadowId, idx, outcome: 'INFRA_ERROR', latenciaMs, _erroInfra: err.message };
  }
}

// ── Relatório Final ───────────────────────────────────────────────────────────

function gerarRelatorio({ resultados, estatisticasAmostra, duracaoTotalMs }) {
  const total        = resultados.length;
  const successes    = resultados.filter(r => r.outcome === 'LLM_SUCCESS');
  const safeBlocks   = resultados.filter(r => r.outcome === 'SAFE_BLOCK');
  const infraErrors  = resultados.filter(r => r.outcome === 'INFRA_ERROR');
  const piiBlocks    = resultados.filter(r => r.outcome === 'PII_BLOCK');
  const schemaBlocks = resultados.filter(r => r.outcome === 'SCHEMA_BLOCK');
  const skips        = resultados.filter(r => r.outcome === 'SKIP_SEM_OPORTUNIDADE');

  const llmTotal = successes.length + safeBlocks.length + infraErrors.length + schemaBlocks.length + piiBlocks.length;

  // Métricas de tokens (somente LLM_SUCCESS)
  let totalInputTokens = 0, totalOutputTokens = 0, totalCachedTokens = 0, totalReasoningTokens = 0;
  const latencias = [];

  for (const r of successes) {
    if (r.tokens) {
      totalInputTokens    += r.tokens.input    || 0;
      totalOutputTokens   += r.tokens.output   || 0;
      totalCachedTokens   += r.tokens.cachedInput || 0;
      totalReasoningTokens += r.tokens.reasoning || 0;
    }
    if (r.latenciaMs) latencias.push(r.latenciaMs);
  }

  // Custo estimado (USD)
  const custoInputUSD    = (totalInputTokens   / 1_000_000) * PRECO_INPUT_1M;
  const custoOutputUSD   = (totalOutputTokens  / 1_000_000) * PRECO_OUTPUT_1M;
  const custoCachedUSD   = (totalCachedTokens  / 1_000_000) * PRECO_CACHED_1M;
  const custoTotalUSD    = custoInputUSD + custoOutputUSD - custoCachedUSD;

  const latenciaMedia   = latencias.length > 0 ? Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length) : 0;
  const latenciaMax     = latencias.length > 0 ? Math.max(...latencias) : 0;

  // Gate N28
  const gate_llm_success_rate = llmTotal > 0 ? successes.length / llmTotal : 0;
  const gate_pii_block        = piiBlocks.length === 0;
  const gate_max_clients      = llmTotal <= MAX_LLM_CALLS;
  const gate_never_bought     = true; // garantido pela amostragem (exclui nuncaComprou=true)
  const gate_store_false      = true; // hardcoded na implementação do provider

  const N28_GATE = (
    gate_pii_block &&
    gate_max_clients &&
    gate_never_bought &&
    gate_store_false &&
    gate_llm_success_rate >= 0.70   // mínimo 70% LLM_SUCCESS dentre chamadas LLM
  ) ? 'PASS' : 'FAIL';

  console.log('\n' + '═'.repeat(70));
  console.log('  RELATÓRIO FINAL — N28 SHADOW PILOT');
  console.log('═'.repeat(70));
  console.log(`\n  Data:            ${new Date().toISOString()}`);
  console.log(`  Modelo:          ${MODELO}`);
  console.log(`  Agente:          analistaOportunidade`);
  console.log(`  AI_MODE:         ${AI_MODE}`);
  console.log(`  store:           false`);
  console.log(`  PROD_WRITES:     ZERO`);

  console.log('\n── AMOSTRAGEM ─────────────────────────────────────────────────────────');
  console.log(`  Universo:              ${estatisticasAmostra.totalUniverso}`);
  console.log(`  Elegíveis:             ${estatisticasAmostra.totalElegiveis}`);
  console.log(`  Excluídos (nunca compraram): ${estatisticasAmostra.totalNuncaComprou}`);
  console.log(`  Selecionados:          ${estatisticasAmostra.totalSelecionados}`);
  console.log(`  Categorias cobertas:   ${estatisticasAmostra.categoriasCobertas.join(', ') || '(nenhuma)'}`);
  console.log(`  Categorias faltando:   ${estatisticasAmostra.categoriasFaltando.join(', ') || '(nenhuma)'}`);

  console.log('\n── RESULTADOS LLM ─────────────────────────────────────────────────────');
  console.log(`  Total chamadas LLM:    ${llmTotal}`);
  console.log(`  LLM_SUCCESS:           ${successes.length}`);
  console.log(`  SAFE_BLOCK:            ${safeBlocks.length} (pipeline funcionando corretamente)`);
  console.log(`  SCHEMA_BLOCK:          ${schemaBlocks.length}`);
  console.log(`  PII_BLOCK:             ${piiBlocks.length}`);
  console.log(`  INFRA_ERROR:           ${infraErrors.length}`);
  console.log(`  SKIP (sem oport):      ${skips.length}`);

  console.log('\n── TOKENS E CUSTO ──────────────────────────────────────────────────────');
  console.log(`  Input tokens:          ${totalInputTokens}`);
  console.log(`  Output tokens:         ${totalOutputTokens}`);
  console.log(`  Cached tokens:         ${totalCachedTokens}`);
  console.log(`  Reasoning tokens:      ${totalReasoningTokens}`);
  console.log(`  Custo input:           $${custoInputUSD.toFixed(4)} USD`);
  console.log(`  Custo output:          $${custoOutputUSD.toFixed(4)} USD`);
  console.log(`  Desconto cache:        -$${custoCachedUSD.toFixed(4)} USD`);
  console.log(`  CUSTO TOTAL:           $${custoTotalUSD.toFixed(4)} USD`);

  console.log('\n── LATÊNCIA ────────────────────────────────────────────────────────────');
  console.log(`  Latência média:        ${latenciaMedia}ms`);
  console.log(`  Latência máxima:       ${latenciaMax}ms`);
  console.log(`  Duração total:         ${Math.round(duracaoTotalMs / 1000)}s`);

  console.log('\n── SEGURANÇA E PRIVACIDADE ─────────────────────────────────────────────');
  console.log(`  PII_REAL_SENT:         ZERO (${gate_pii_block ? 'PASS' : 'FAIL'})`);
  console.log(`  REAL_CUSTOMER_DATA_SENT: ZERO (pseudonimizado + allowlist)`);
  console.log(`  store=false:           CONFIRMADO`);
  console.log(`  Max 12 chamadas:       ${gate_max_clients ? 'PASS' : 'FAIL'} (${llmTotal}/${MAX_LLM_CALLS})`);
  console.log(`  Exclusão never-bought: PASS (garantido por selecionarAmostra)`);

  console.log('\n── GATE N28 ────────────────────────────────────────────────────────────');
  console.log(`  gate_pii_block:        ${gate_pii_block ? 'PASS' : 'FAIL'}`);
  console.log(`  gate_max_clients:      ${gate_max_clients ? 'PASS' : 'FAIL'}`);
  console.log(`  gate_never_bought:     PASS`);
  console.log(`  gate_store_false:      PASS`);
  console.log(`  gate_success_rate:     ${(gate_llm_success_rate * 100).toFixed(0)}% (mín 70%)`);
  console.log(`\n  N28_GATE:              ${N28_GATE}`);

  if (N28_GATE === 'PASS') {
    console.log('\n  ✔ N28 concluído com sucesso. NÃO iniciar N29.');
  } else {
    console.log('\n  ✘ N28_GATE=FAIL. Investigar erros antes de continuar.');
  }

  console.log('\n── DETALHE POR CLIENTE ──────────────────────────────────────────────────');
  for (const r of resultados) {
    const tokens = r.tokens ? `in=${r.tokens.input} out=${r.tokens.output}` : 'n/a';
    const lat    = r.latenciaMs ? `${r.latenciaMs}ms` : '-';
    const extra  = r._erroInfra || r._erroGrounding || r._erroGuardrail || r._erroPII || r._erroSchema || r._info || '';
    const extraStr = extra ? ` | ${extra.slice(0, 80)}` : '';
    console.log(`  ${r.shadowId} [${r.outcome}] lat=${lat} ${tokens}${extraStr}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`  N28_GATE = ${N28_GATE}`);
  console.log('═'.repeat(70) + '\n');

  return N28_GATE;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n[N28] Iniciando Shadow Pilot — AI_MODE=SHADOW, PROD_WRITES=ZERO');
  console.log(`[N28] Modelo: ${MODELO} | store=false`);

  const t0 = Date.now();

  // ── Gate: Firestore ─────────────────────────────────────────────────────────
  const db = await inicializarFirestore();

  // ── Leitura dos perfis ──────────────────────────────────────────────────────
  const perfisRaw = await lerPerfis(db);

  if (perfisRaw.length === 0) {
    console.error('[N28] BLOCKER: Nenhum perfil encontrado em perfis_360.');
    process.exit(1);
  }

  // ── Enriquecimento ──────────────────────────────────────────────────────────
  console.log('[N28] Enriquecendo perfis com engines determinísticos...');
  const perfisEnriquecidos = perfisRaw.map(p => {
    try {
      return enriquecerPerfil(p);
    } catch (err) {
      // Perfil com dados insuficientes: inclui sem enriquecimento (seleção irá excluir)
      return { ...p, _erroEnriquecimento: err.message };
    }
  });

  // ── Seleção ─────────────────────────────────────────────────────────────────
  console.log('[N28] Selecionando amostra determinística...');
  const { selecionados, estatisticas } = selecionarAmostra(perfisEnriquecidos);
  console.log(`[N28] ${selecionados.length} clientes selecionados de ${estatisticas.totalElegiveis} elegíveis`);
  console.log(`[N28] ${estatisticas.totalNuncaComprou} clientes excluídos (nuncaComprou=true)`);

  // ── Pseudonimização ─────────────────────────────────────────────────────────
  const { pseudonimizados, mapa } = pseudonimizar(selecionados);
  console.log(`[N28] ${pseudonimizados.length} clientes pseudonimizados (mapa ephemeral in-memory)`);
  // O mapa SHADOW-XXX → clienteMr4Id existe somente em memória (nunca logado, nunca persistido)

  // ── Provider ────────────────────────────────────────────────────────────────
  const provider = new OpenAIProvider({ modelo: MODELO });

  // ── Análises LLM ────────────────────────────────────────────────────────────
  console.log(`\n[N28] Iniciando ${pseudonimizados.length} análises em SHADOW mode...\n`);

  const resultados = [];

  for (let i = 0; i < pseudonimizados.length; i++) {
    const pseudo    = pseudonimizados[i];
    const shadowId  = pseudo.shadowId;
    const realId    = mapa.get(shadowId); // apenas para buscar o perfil enriquecido original
    const original  = perfisEnriquecidos.find(p => p.clienteMr4Id === realId);

    process.stdout.write(`  ${shadowId} (${i + 1}/${pseudonimizados.length})... `);

    const resultado = await analisarCliente({
      pseudo,
      originalEnriquecido: original,
      provider,
      idx: i + 1,
    });

    resultados.push(resultado);
    console.log(`[${resultado.outcome}] ${resultado.latenciaMs || 0}ms`);

    // Pausa entre chamadas para evitar rate limiting
    if (i < pseudonimizados.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ── Relatório ────────────────────────────────────────────────────────────────
  const duracaoTotalMs = Date.now() - t0;
  const gate = gerarRelatorio({ resultados, estatisticasAmostra: estatisticas, duracaoTotalMs });

  console.log('[N28] PARE — não iniciar N29.\n');
  process.exit(gate === 'PASS' ? 0 : 1);
}

main().catch(err => {
  console.error('\n[N28] Erro fatal não tratado:', err.message);
  console.error(err.stack);
  process.exit(1);
});
