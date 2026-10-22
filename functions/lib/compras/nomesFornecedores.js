'use strict';
// AGENTE COMPRAS MR4 — Fase C.2 · Nomes de fornecedor: cache e mesclagem. FUNÇÕES PURAS (sem I/O, sem relógio).
//
// Princípios:
//  • O ID do fornecedor é o identificador estável; o NOME é só atributo de apresentação. Nada aqui altera quantidade, faturamento,
//    média ou atribuição de produto — o agregador recebe os nomes depois de calcular tudo (teste de invariância).
//  • O cache é a fonte de verdade para exibição: uma leitura que falha, vem vazia, parcial ou suspeita NUNCA apaga nomes conhecidos.
//  • Só id, nome e situação (ativo) são guardados — nunca CNPJ, CPF, contatos ou endereço.
//  • Cache = { versao, atualizado_em, ultima_tentativa, ultima_tentativa_ok, erro, fornecedores: { id: { nome, ativo, visto_em,
//    nome_anterior?, renomeado_em?, ausente_desde? } } }
const VERSAO = 1;
const NOME_MAX = 120;

/** Texto de apresentação seguro: sem caracteres de controle, espaços normalizados, tamanho limitado. Vazio ⇒ null. */
function sanitizarNome(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOME_MAX);
  return s || null;
}
const ativoDe = v => (v === '0' || v === 0 || v === false ? false : v === '1' || v === 1 || v === true ? true : null);

/** Itens crus da API (/fornecedores) → [{ id, nome, ativo }] (só esses 3 campos; duplicados por id: vence o último). */
function normalizarResposta(itens) {
  const porId = new Map();
  for (const x of itens || []) {
    const it = (x && (x.Fornecedor || x)) || {};
    if (it.id === null || it.id === undefined || String(it.id).trim() === '') continue;
    porId.set(String(it.id), { id: String(it.id), nome: sanitizarNome(it.nome), ativo: ativoDe(it.ativo) });
  }
  return [...porId.values()];
}

const cacheVazio = () => ({ versao: VERSAO, atualizado_em: null, ultima_tentativa: null, ultima_tentativa_ok: null, erro: null, fornecedores: {} });
const valido = c => c && typeof c === 'object' && c.fornecedores && typeof c.fornecedores === 'object' && !Array.isArray(c.fornecedores);
const copia = c => (valido(c) ? JSON.parse(JSON.stringify(c)) : cacheVazio());

/**
 * Mescla uma resposta VÁLIDA da API no cache.
 *   • novo id → entra; nome diferente → atualiza e guarda nome_anterior/renomeado_em; ativo muda → atualiza;
 *   • nome ausente/vazio na resposta → MANTÉM o nome conhecido (se não houver nenhum, fica sem nome);
 *   • id no cache e ausente na resposta → MANTÉM, marcando ausente_desde (nunca apaga);
 *   • id que reaparece → limpa ausente_desde.
 * Resposta suspeita (vazia ou menor que `ratioMin` do cache conhecido) NÃO é mesclada: é tratada como falha por quem chama (ver validarResposta).
 */
function validarResposta(cache, lista, ratioMin) {
  const conhecidos = Object.keys((valido(cache) ? cache : cacheVazio()).fornecedores).length;
  if (!lista.length) return { ok: false, codigo: conhecidos ? 'RESPOSTA_VAZIA_COM_CACHE' : 'RESPOSTA_VAZIA' };
  if (conhecidos && lista.length < Math.floor(conhecidos * ratioMin)) return { ok: false, codigo: 'RESPOSTA_SUSPEITA_MENOR_QUE_O_CACHE' };
  return { ok: true };
}
function mesclarResposta(cacheAnterior, lista, agora) {
  const cache = copia(cacheAnterior), t = agora.toISOString();
  const rel = { total_resposta: lista.length, novos: 0, renomeados: 0, inativos: 0, reativados: 0, sem_nome_na_resposta: 0, ausentes: 0, reaparecidos: 0 };
  const vistos = new Set();
  for (const it of lista) {
    vistos.add(it.id);
    const a = cache.fornecedores[it.id];
    if (!a) { cache.fornecedores[it.id] = { nome: it.nome, ativo: it.ativo, visto_em: t }; rel.novos++; if (it.nome === null) rel.sem_nome_na_resposta++; if (it.ativo === false) rel.inativos++; continue; }
    const novo = { ...a, visto_em: t };
    if (it.nome === null) rel.sem_nome_na_resposta++;
    else if (it.nome !== a.nome) { if (a.nome) { novo.nome_anterior = a.nome; novo.renomeado_em = t; rel.renomeados++; } novo.nome = it.nome; }
    if (a.ausente_desde) { delete novo.ausente_desde; rel.reaparecidos++; }
    if (it.ativo !== null && it.ativo !== a.ativo) { novo.ativo = it.ativo; if (it.ativo === false) rel.inativos++; else rel.reativados++; }
    cache.fornecedores[it.id] = novo;
  }
  for (const [id, a] of Object.entries(cache.fornecedores)) if (!vistos.has(id)) { rel.ausentes++; if (!a.ausente_desde) cache.fornecedores[id] = { ...a, ausente_desde: t }; }
  cache.versao = VERSAO; cache.atualizado_em = t; cache.ultima_tentativa = t; cache.ultima_tentativa_ok = true; cache.erro = null;
  return { cache, relatorio: rel };
}
/** Falha (API, validação, rede): o cache de nomes fica INTACTO; só registra a tentativa e o motivo. */
function registrarFalha(cacheAnterior, agora, erro) {
  const cache = copia(cacheAnterior);
  cache.ultima_tentativa = agora.toISOString(); cache.ultima_tentativa_ok = false;
  cache.erro = String((erro && (erro.codigo || erro.message)) || erro || 'ERRO').replace(/[A-Za-z0-9_\-]{24,}/g, '[REDACTED]').slice(0, 120);
  return cache;
}

/** Situação do cache para a tela e para os metadados. */
function situacao(cache, agora, staleAfterHours) {
  const c = valido(cache) ? cache : cacheVazio();
  const total = Object.keys(c.fornecedores).length;
  const idadeH = c.atualizado_em ? (agora.getTime() - Date.parse(c.atualizado_em)) / 3600000 : null;
  let status = 'OK', motivo = null;
  if (!total) { status = 'AUSENTE'; motivo = 'SEM_NOMES_CONHECIDOS'; }
  else if (c.ultima_tentativa_ok === false) { status = 'DESATUALIZADO'; motivo = 'ULTIMA_LEITURA_FALHOU'; }
  else if (idadeH === null || (staleAfterHours != null && idadeH > staleAfterHours)) { status = 'DESATUALIZADO'; motivo = 'CACHE_ANTIGO'; }
  return { status, motivo, atualizado_em: c.atualizado_em, ultima_tentativa: c.ultima_tentativa, ultima_tentativa_ok: c.ultima_tentativa_ok, erro: c.erro,
    idade_horas: idadeH === null ? null : Math.round(idadeH * 10) / 10, stale_after_hours: staleAfterHours ?? null, conhecidos: total };
}
/** Cache → mapa de apresentação usado pelo agregador: { id: { nome, ativo, nome_anterior, ausente } } (só quem tem nome). */
function paraApresentacao(cache) {
  const out = {};
  for (const [id, f] of Object.entries((valido(cache) ? cache : cacheVazio()).fornecedores)) {
    if (!f.nome) continue;
    out[id] = { nome: f.nome, ativo: f.ativo === false ? false : f.ativo === true ? true : null, nome_anterior: f.nome_anterior || null, renomeado_em: f.renomeado_em || null, ausente: !!f.ausente_desde };
  }
  return out;
}

module.exports = { VERSAO, NOME_MAX, sanitizarNome, normalizarResposta, cacheVazio, valido, validarResposta, mesclarResposta, registrarFalha, situacao, paraApresentacao };
