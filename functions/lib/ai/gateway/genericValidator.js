'use strict';
// AI GATEWAY — validador GENÉRICO pós-modelo (fail closed) + fábrica de schema estruturado por agente.
// Contexto padrão: ctx.entidades = { ref: { ...fatos, sinais: [códigos] } } (+ ctx.entidadeEmFoco). O modelo só cita refs/motivos/métricas/valores que existem.
const { RespostaInvalida, numerosNaoVerificados } = require('./schema');
const { escaneiarTextoParaPII } = require('../../n29/piiGuard');
const falha = (c, d) => { throw new RespostaInvalida(c, d); };
const num = v => typeof v === 'number' && Number.isFinite(v);
const UNIDADES = 'unidades?|un\\.?|itens?|produtos?|pe[cç]as?|skus?|reais|real|semanas?|m[eê]s(?:es)?|fornecedores?|t[ií]tulos?|contas?|boletos?|notas?|vencimentos?|pagamentos?|recebimentos?|parcelas?|lotes?|giros?|x';
const MAX = { answer: 1500, entidades: 12, evidencias: 6, recomendacoes: 8, warnings: 5, rationale: 400 };

/** Schema (Structured Outputs estrito): answer · entities · recommendations · warnings · unavailable · dataFreshness, com enums do agente. */
function criarSchemaAgente({ motivos, acoes }) {
  const ev = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['metric', 'value'], properties: { metric: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] } } } };
  return Object.freeze({
    type: 'object', additionalProperties: false, required: ['answer', 'entities', 'recommendations', 'warnings', 'unavailable', 'dataFreshness'],
    properties: {
      answer: { type: 'string' },
      entities: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'reasonCodes', 'evidence'], properties: { ref: { type: 'string' }, reasonCodes: { type: 'array', items: { type: 'string', enum: motivos } }, evidence: ev } } },
      recommendations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'action', 'rationale'], properties: { ref: { anyOf: [{ type: 'string' }, { type: 'null' }] }, action: { type: 'string', enum: acoes }, rationale: { type: 'string' } } } },
      warnings: { type: 'array', items: { type: 'string' } },
      unavailable: { type: 'array', items: { type: 'string' } },
      dataFreshness: { type: 'string' },
    },
  });
}

/**
 * @param resp  JSON do modelo · @param ctx contexto enviado · @param mapa ref→{...} (só backend) · @param ag definição do agente
 * ag.motivos (códigos), ag.acoes (códigos), ag.validacoesExtras?(resp, ctx) → lança RespostaInvalida · ag.metricasProibidasEmEvidencia?
 */
function validarGenerico(resp, ctx, mapa, ag) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) falha('NAO_OBJETO');
  const req = ['answer', 'entities', 'recommendations', 'warnings', 'unavailable', 'dataFreshness'];
  const extras = Object.keys(resp).filter(k => !req.includes(k)); if (extras.length) falha('CAMPOS_EXTRAS', extras.join(','));
  for (const k of req) if (!(k in resp)) falha('CAMPO_AUSENTE', k);
  if (typeof resp.answer !== 'string' || !resp.answer.trim()) falha('ANSWER_INVALIDO'); if (resp.answer.length > MAX.answer) falha('ANSWER_GRANDE_DEMAIS');
  if (typeof resp.dataFreshness !== 'string' || resp.dataFreshness.length > 240) falha('FRESCOR_INVALIDO');
  for (const k of ['warnings', 'unavailable']) { if (!Array.isArray(resp[k]) || resp[k].some(x => typeof x !== 'string')) falha('LISTA_INVALIDA', k); resp = { ...resp, [k]: resp[k].slice(0, MAX.warnings).map(x => x.slice(0, 300)) }; }
  if (!Array.isArray(resp.entities) || !Array.isArray(resp.recommendations)) falha('LISTAS_INVALIDAS');
  resp = { ...resp, entities: resp.entities.slice(0, MAX.entidades), recommendations: resp.recommendations.slice(0, MAX.recomendacoes) };   // tamanho corta; integridade é estrita
  if (/sk-[A-Za-z0-9_-]{10,}|OPENAI_API_KEY|api[_ -]?key\s*[:=]/i.test(JSON.stringify(resp))) falha('SEGREDO_NA_RESPOSTA');
  const ents = Object.assign({}, ctx.entidades || {}); if (ctx.entidadeEmFoco) ents[ctx.entidadeEmFoco.ref] = ctx.entidadeEmFoco;
  const vistos = new Set(), saida = [];
  for (const e of resp.entities) {
    if (!e || typeof e !== 'object') falha('ENTIDADE_NAO_OBJETO');
    const ex = Object.keys(e).filter(k => !['ref', 'reasonCodes', 'evidence'].includes(k)); if (ex.length) falha('ENTIDADE_CAMPOS_EXTRAS', ex.join(','));
    if (typeof e.ref !== 'string' || !ents[e.ref] || !mapa[e.ref]) falha('ENTIDADE_FORA_DO_CONTEXTO', String(e.ref).slice(0, 12));   // id inventado ou fora do escopo
    if (vistos.has(e.ref)) falha('ENTIDADE_DUPLICADA', e.ref); vistos.add(e.ref);
    const f = ents[e.ref];
    if (!Array.isArray(e.reasonCodes)) falha('MOTIVOS_INVALIDOS');
    for (const rc of e.reasonCodes) if (!(ag.motivos || []).includes(rc) || !(f.sinais || []).includes(rc)) falha('MOTIVO_NAO_COMPROVADO', e.ref + ':' + String(rc).slice(0, 30));
    if (!Array.isArray(e.evidence)) falha('EVIDENCIAS_INVALIDAS');
    const evs = [];
    for (const x of e.evidence.slice(0, MAX.evidencias)) {
      if (!x || typeof x !== 'object' || typeof x.metric !== 'string' || Object.keys(x).some(k => !['metric', 'value'].includes(k))) falha('EVIDENCIA_MAL_FORMADA');
      if (!(x.metric in f) || ['ref', 'sinais'].includes(x.metric)) falha('METRICA_INEXISTENTE', x.metric.slice(0, 30));
      const real = f[x.metric]; if (!((num(real) && num(x.value) && Math.abs(real - x.value) < 0.011) || real === x.value)) falha('EVIDENCIA_DIVERGE_DO_FATO', e.ref + ':' + x.metric);
      evs.push({ metric: x.metric, value: real });
    }
    saida.push({ ref: e.ref, reasonCodes: e.reasonCodes, evidence: evs });
  }
  const recs = [];
  for (const x of resp.recommendations) {
    if (!x || typeof x !== 'object' || Object.keys(x).some(k => !['ref', 'action', 'rationale'].includes(k))) falha('RECOMENDACAO_MAL_FORMADA');
    if (!(ag.acoes || []).includes(x.action)) falha('ACAO_INVALIDA', String(x.action).slice(0, 30));
    if (x.ref !== null && (typeof x.ref !== 'string' || !ents[x.ref] || !mapa[x.ref])) falha('RECOMENDACAO_FORA_DO_CONTEXTO', String(x.ref).slice(0, 12));
    if (typeof x.rationale !== 'string' || !x.rationale.trim() || x.rationale.length > MAX.rationale) falha('RATIONALE_INVALIDO');
    const rn = numerosNaoVerificados(x.rationale, ctx, UNIDADES); if (rn.length) falha('NUMERO_NAO_VERIFICADO', rn.slice(0, 3).join(' | '));
    recs.push({ ref: x.ref, action: x.action, rationale: x.rationale.trim() });
  }
  const pii = escaneiarTextoParaPII(JSON.stringify([resp.answer, resp.warnings, resp.unavailable, resp.dataFreshness, recs]).replace(/\b20\d\d-\d\d-\d\d\b/g, 'DATA')); if (!pii.ok) falha('PII_NA_RESPOSTA', pii.encontrado.join(','));
  const ruins = numerosNaoVerificados(resp.answer, ctx, UNIDADES); if (ruins.length) falha('NUMERO_NAO_VERIFICADO', ruins.slice(0, 3).join(' | '));
  if (typeof ag.validacoesExtras === 'function') ag.validacoesExtras(resp, ctx);   // regras do módulo (ex.: financeiro: nada de saldo/caixa)
  return { answer: resp.answer.trim(), entities: saida, recommendations: recs, warnings: resp.warnings, unavailable: resp.unavailable, dataFreshness: resp.dataFreshness };
}
module.exports = { criarSchemaAgente, validarGenerico, MAX };
