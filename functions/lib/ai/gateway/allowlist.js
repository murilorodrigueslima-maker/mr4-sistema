'use strict';
// AI GATEWAY — AI_DATA_ALLOWLIST. Nada fora desta lista entra no contexto enviado ao provedor de IA (OpenAI).
// Princípios: minimização (sem CPF/CNPJ, telefone, e-mail, endereço, documentos, tokens, observações/notas livres, dados de outros módulos);
// referência opaca por requisição (C01, C02…) no lugar de qualquer ID interno; nome comercial só quando necessário para o usuário reconhecer o cliente.
// R$ só para a gestão (mesma regra do CRM: vendedor não vê valores em R$ — segregação N35.20.1).
const { escaneiarTextoParaPII } = require('../../n29/piiGuard');

const TIPOS = { N: 'number', S: 'string', B: 'boolean' };
// campo → [tipo, tamanho máximo (strings), somenteGestao]
const CLIENTE = {
  ref: ['S', 8, false],                     // C01… (opaco, por requisição)
  nome: ['S', 60, false],                   // nome comercial (truncado; sanitizado contra instruções/PII)
  responsavel: ['S', 20, false],            // primeiro nome do vendedor responsável (só visão de gestão)
  ultimaCompraEm: ['S', 10, false], diasSemComprar: ['N', 0, false], primeiraCompraEm: ['S', 10, false],
  pedidosTotal: ['N', 0, false], pedidos30d: ['N', 0, false], pedidos60d: ['N', 0, false], pedidos90d: ['N', 0, false], pedidos180d: ['N', 0, false],
  frequenciaDias: ['N', 0, false], status120Dias: ['S', 24, false],
  recorrencia: ['S', 28, false], tendencia: ['S', 16, false], tendenciaMetodo: ['S', 32, false], variacaoPedidosPct: ['N', 0, false],
  faturamento30d: ['N', 0, true], faturamento60d: ['N', 0, true], faturamento90d: ['N', 0, true], faturamento180d: ['N', 0, true],
  ticketMedio: ['N', 0, true], variacaoFaturamentoPct: ['N', 0, true],
  ultimoOutcome: ['S', 24, false], ultimoContatoEm: ['S', 10, false], diasDesdeUltimoContato: ['N', 0, false],
  proximoRetornoEm: ['S', 10, false], situacaoRetorno: ['S', 12, false], emCooldownAte: ['S', 10, false], estadoOportunidade: ['S', 24, false], tipoOportunidade: ['S', 32, false],
  prioridadeSugerida: ['S', 8, false],
};
const LISTAS_CLIENTE = {
  produtosMaisComprados: { max: 5, tamNome: 50 },   // nomes de produto do catálogo (dado comercial, não pessoal)
  categorias: { max: 3, tamNome: 30 },
  sinais: { max: 8, tamNome: 40 },                  // códigos de motivo calculados pelo motor determinístico
  ultimosContatos: { max: 5, tamNome: 40 },         // só no cliente em foco: "CODIGO AAAA-MM-DD" (sem notas/observações)
};
const AI_DATA_ALLOWLIST = Object.freeze({
  contexto: ['agenteVersao', 'geradoEm', 'hoje', 'escopo', 'resumoDia', 'rankings', 'clientes', 'clienteEmFoco', 'limitacoes', 'frescor', 'metricasDisponiveis', 'regras'],
  cliente: Object.keys(CLIENTE).concat(Object.keys(LISTAS_CLIENTE)),
});

const INSTRUCAO_RE = /ignor[ea]\b|ignore (all|previous|todas)|system prompt|prompt do sistema|revele|reveal|api[ _-]?key|chave da api|execute|you are now|voc[eê] [eé] agora|desconsidere|esque[cç]a|jailbreak/i;
/** Texto vindo do cadastro (nome) é DADO: remove controles/aspas estruturais, bloqueia frases de instrução e PII. Nunca vira instrução. */
function sanitizarTexto(v, max) {
  let t = String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F`{}<>\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (INSTRUCAO_RE.test(t) || !escaneiarTextoParaPII(t).ok) return null;
  return Array.from(t).slice(0, max).join('');
}

/** Aplica a allowlist a um cliente: remove campos desconhecidos, tipos errados, R$ (se não for gestão), textos suspeitos. */
function filtrarCliente(c, { gestao }) {
  const out = {};
  for (const [k, [tipo, max, soGestao]] of Object.entries(CLIENTE)) {
    if (!(k in c) || c[k] === undefined) continue;
    if (soGestao && !gestao) continue;
    const v = c[k];
    if (v === null) { out[k] = null; continue; }
    if (tipo === 'N') { if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100; continue; }
    if (tipo === 'S') { const t = k === 'nome' ? sanitizarTexto(v, max) : String(v).slice(0, max); if (t !== null && t !== '') out[k] = t; else if (k === 'nome') out.nome = null; }
  }
  if (!gestao) delete out.responsavel;
  for (const [k, cfg] of Object.entries(LISTAS_CLIENTE)) {
    if (!Array.isArray(c[k])) continue;
    out[k] = c[k].slice(0, cfg.max).map(x => sanitizarTexto(typeof x === 'object' && x ? (x.nome || x.categoria || x.codigo) : x, cfg.tamNome)).filter(Boolean);
  }
  return out;
}
/** Verifica (para testes/auditoria) que o contexto final só tem chaves da allowlist e nenhum valor com PII. */
function auditarContexto(ctx, { gestao }) {
  const problemas = [];
  for (const k of Object.keys(ctx)) if (!AI_DATA_ALLOWLIST.contexto.includes(k)) problemas.push('CAMPO_FORA_DA_ALLOWLIST:' + k);
  const cls = Object.values(ctx.clientes || {}).concat(ctx.clienteEmFoco ? [ctx.clienteEmFoco] : []);
  for (const c of cls) for (const k of Object.keys(c)) { if (!AI_DATA_ALLOWLIST.cliente.includes(k)) problemas.push('CLIENTE_CAMPO_FORA:' + k); if (!gestao && CLIENTE[k] && CLIENTE[k][2]) problemas.push('VALOR_RS_PARA_VENDEDOR:' + k); }
  const strings = []; (function colhe(o) { if (typeof o === 'string') strings.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(colhe); })(ctx);
  const pii = escaneiarTextoParaPII(strings.map(x => x.replace(/\b20\d\d-\d\d-\d\d\b/g, 'DATA')).join(' | '));   // só strings (números/valores não são PII); datas ISO não são PII
  if (!pii.ok) problemas.push('PII:' + pii.encontrado.join(','));
  if (/token|secret|api[_-]?key|senha|password|bearer/i.test(JSON.stringify(ctx))) problemas.push('SEGREDO_NO_CONTEXTO');
  return { ok: problemas.length === 0, problemas };
}
module.exports = { AI_DATA_ALLOWLIST, CLIENTE, LISTAS_CLIENTE, sanitizarTexto, filtrarCliente, auditarContexto, INSTRUCAO_RE };
