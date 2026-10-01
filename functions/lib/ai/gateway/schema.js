'use strict';
// AI GATEWAY — resposta ESTRUTURADA do agente + validação no backend (fail closed) + camada de evidência.
// O front nunca interpreta texto livre para lógica: usa só os campos validados (customers/reasonCodes/evidence).

/** Catálogo de códigos de motivo (calculados pelo motor determinístico; o modelo só ESCOLHE entre os que o cliente tem). */
const MOTIVOS = Object.freeze({
  SEM_COMPRA_120D: 'Sem comprar há 120 dias ou mais',
  PROXIMO_120D: 'Perto de completar 120 dias sem comprar',
  ATRASADO_VS_CICLO: 'Atrasado em relação ao ciclo habitual de compra',
  PROXIMO_DA_JANELA_RECOMPRA: 'Chegando na janela habitual de recompra',
  QUEDA_DE_COMPRAS: 'Queda nas compras (tendência)',
  FOLLOWUP_ATRASADO: 'Retorno agendado em atraso',
  FOLLOWUP_HOJE: 'Retorno agendado para hoje',
  SEM_CONTATO_RECENTE: 'Sem contato registrado recentemente',
  EM_COOLDOWN: 'Em período de espera após o último contato',
  OPORTUNIDADE_NA_FILA: 'Há oportunidade aberta na fila comercial',
});
const CODIGOS = Object.keys(MOTIVOS);
const MAX_ANSWER = 1500, MAX_CLIENTES_RESP = 12, MAX_EVIDENCIAS = 8, MAX_WARNINGS = 5;

/** JSON Schema (Structured Outputs estrito da Responses API). */
const RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['answer', 'customers', 'warnings', 'unavailable', 'dataFreshness'],
  properties: {
    answer: { type: 'string' },
    customers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'reasonCodes', 'evidence'], properties: {
      ref: { type: 'string' },
      reasonCodes: { type: 'array', items: { type: 'string', enum: CODIGOS } },
      evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['metric', 'value'], properties: { metric: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] } } } },
    } } },
    warnings: { type: 'array', items: { type: 'string' } },
    unavailable: { type: 'array', items: { type: 'string' } },
    dataFreshness: { type: 'string' },
  },
});

class RespostaInvalida extends Error { constructor(codigo, detalhe) { super(codigo + (detalhe ? ':' + detalhe : '')); this.codigo = codigo; this.detalhe = detalhe || null; } }
const falha = (c, d) => { throw new RespostaInvalida(c, d); };
const { escaneiarTextoParaPII } = require('../../n29/piiGuard');
const num = v => typeof v === 'number' && Number.isFinite(v);

/** Todos os números do contexto (para checar números citados no texto). */
function numerosDoContexto(ctx) { const s = new Set(); (function w(o) { if (num(o)) s.add(Math.round(o * 100) / 100); else if (o && typeof o === 'object') Object.values(o).forEach(w); })(ctx); return s; }
/** Números do texto acompanhados de unidade (dias, pedidos, clientes, %, R$) precisam existir no contexto. Datas dd/mm não contam. */
function numerosNaoVerificados(texto, ctx) {
  const ok = numerosDoContexto(ctx), ruins = [];
  const t = String(texto).replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const re = /(R\$\s?)?(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(%|dias?|pedidos?|compras?|clientes?|oportunidades?|vezes)?/gi;
  let m;
  while ((m = re.exec(t))) {
    if (!m[1] && !m[3]) continue;                                   // número solto (ordinal, lista) não é afirmação factual
    const bruto = m[2]; const n = parseFloat(bruto.includes(',') ? bruto.replace(/\./g, '').replace(',', '.') : (/^\d{1,3}(\.\d{3})+$/.test(bruto) ? bruto.replace(/\./g, '') : bruto));
    if (!Number.isFinite(n)) continue; const r = Math.round(n * 100) / 100;
    const aprox = [...ok].some(x => Math.abs(x - r) < 0.011 || Math.abs(Math.abs(x) - r) < 0.011 || Math.abs(Math.round(x) - r) < 0.011);
    if (!aprox && r >= 10) ruins.push(m[0].trim());                 // < 10 ("2 pedidos") tolerado: contagens pequenas de agrupamento
  }
  return ruins;
}

/**
 * Valida a resposta do modelo contra o CONTEXTO enviado. Qualquer violação → RespostaInvalida (o chamador falha FECHADO).
 * @param {object} resp  JSON do modelo
 * @param {object} ctx   contexto enviado (já filtrado) — refs válidos = ctx.clientes + ctx.clienteEmFoco
 * @param {object} mapa  ref → {entidade,...} (só no backend)
 */
function validarResposta(resp, ctx, mapa) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) falha('NAO_OBJETO');
  const extras = Object.keys(resp).filter(k => !RESPONSE_SCHEMA.required.includes(k)); if (extras.length) falha('CAMPOS_EXTRAS', extras.join(','));
  for (const k of RESPONSE_SCHEMA.required) if (!(k in resp)) falha('CAMPO_AUSENTE', k);
  if (typeof resp.answer !== 'string' || !resp.answer.trim()) falha('ANSWER_INVALIDO');
  if (resp.answer.length > MAX_ANSWER) falha('ANSWER_GRANDE_DEMAIS');
  if (typeof resp.dataFreshness !== 'string' || resp.dataFreshness.length > 200) falha('FRESCOR_INVALIDO');
  for (const k of ['warnings', 'unavailable']) { if (!Array.isArray(resp[k]) || resp[k].some(x => typeof x !== 'string')) falha('LISTA_INVALIDA', k); resp = { ...resp, [k]: resp[k].slice(0, MAX_WARNINGS).map(x => x.slice(0, 300)) }; }
  if (!Array.isArray(resp.customers)) falha('CLIENTES_INVALIDOS');
  resp = { ...resp, customers: resp.customers.slice(0, MAX_CLIENTES_RESP) };      // limites de TAMANHO são suaves (corta); integridade dos fatos é estrita
  if (/sk-[A-Za-z0-9_-]{10,}|OPENAI_API_KEY|api[_ -]?key\s*[:=]/i.test(JSON.stringify(resp))) falha('SEGREDO_NA_RESPOSTA');
  const clientes = Object.assign({}, ctx.clientes || {}); if (ctx.clienteEmFoco) clientes[ctx.clienteEmFoco.ref] = ctx.clienteEmFoco;
  const vistos = new Set(), saida = [];
  for (const c of resp.customers) {
    if (!c || typeof c !== 'object') falha('CLIENTE_NAO_OBJETO');
    const ex = Object.keys(c).filter(k => !['ref', 'reasonCodes', 'evidence'].includes(k)); if (ex.length) falha('CLIENTE_CAMPOS_EXTRAS', ex.join(','));
    if (typeof c.ref !== 'string' || !clientes[c.ref] || !mapa[c.ref]) falha('CLIENTE_FORA_DO_CONTEXTO', String(c.ref).slice(0, 12));   // refs inventados ou de fora do escopo
    if (vistos.has(c.ref)) falha('CLIENTE_DUPLICADO', c.ref); vistos.add(c.ref);
    const f = clientes[c.ref];
    if (!Array.isArray(c.reasonCodes)) falha('MOTIVOS_INVALIDOS');
    for (const rc of c.reasonCodes) if (!CODIGOS.includes(rc) || !(f.sinais || []).includes(rc)) falha('MOTIVO_NAO_COMPROVADO', c.ref + ':' + String(rc).slice(0, 30));   // só motivos que o motor calculou para ESTE cliente
    if (!Array.isArray(c.evidence)) falha('EVIDENCIAS_INVALIDAS');
    const evs = [];
    for (const e of c.evidence.slice(0, MAX_EVIDENCIAS)) {
      if (!e || typeof e !== 'object' || typeof e.metric !== 'string' || Object.keys(e).some(k => !['metric', 'value'].includes(k))) falha('EVIDENCIA_MAL_FORMADA');
      if (!(e.metric in f) || e.metric === 'ref' || e.metric === 'sinais') falha('METRICA_INEXISTENTE', e.metric.slice(0, 30));
      const real = f[e.metric]; const ok = (num(real) && num(e.value) && Math.abs(real - e.value) < 0.011) || real === e.value;
      if (!ok) falha('EVIDENCIA_DIVERGE_DO_FATO', c.ref + ':' + e.metric);                   // número/valor inventado ou alterado
      evs.push({ metric: e.metric, value: real });
    }
    saida.push({ ref: c.ref, reasonCodes: c.reasonCodes, evidence: evs });
  }
  const pii = escaneiarTextoParaPII(JSON.stringify([resp.answer, resp.warnings, resp.unavailable, resp.dataFreshness]).replace(/\b20\d\d-\d\d-\d\d\b/g, 'DATA')); if (!pii.ok) falha('PII_NA_RESPOSTA', pii.encontrado.join(','));   // telefone/CPF/e-mail nunca saem na resposta
  const ruins = numerosNaoVerificados(resp.answer, ctx); if (ruins.length) falha('NUMERO_NAO_VERIFICADO', ruins.slice(0, 3).join(' | '));
  return { answer: resp.answer.trim(), customers: saida, warnings: resp.warnings, unavailable: resp.unavailable, dataFreshness: resp.dataFreshness };
}
module.exports = { MOTIVOS, CODIGOS, RESPONSE_SCHEMA, RespostaInvalida, validarResposta, numerosNaoVerificados, MAX_ANSWER, MAX_CLIENTES_RESP };
