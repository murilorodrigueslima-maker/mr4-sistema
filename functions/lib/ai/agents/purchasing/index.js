'use strict';
// AGENTE DE COMPRAS (agentType 'purchasing', módulo 'compras') — definição para o AI Gateway genérico (gateway/generic.js).
//   compras_n0_view/{sugestoes,custos} + compras_n0/meta (JÁ calculados pelo motor Compras 1.2 no servidor) → fatos/sinais/rankings → cesta de orçamento
//   determinística (simulador do motor) → contexto reduzido → modelo (só interpreta) → validação estrita → reidratação de nomes só no backend.
// NÃO altera o motor: só LÊ as visões que a própria tela de Compras lê. Sem escrita, sem fornecedor, sem pedido.
const G = require('../../gateway/generic');
const { RespostaInvalida } = require('../../gateway/schema');
const { MOTIVOS, ACOES, ACAO_EXIGE, ROTULOS, SCHEMA, INSTRUCTIONS } = require('./prompt');
const C = require('./contexto');

/**
 * Autorização = a regra REAL da tela + das Rules (nunca "autenticado"):
 *   tela (js/guard.js · verificarAcessoModulo 'compras'): gestor ativo, OU funcionário ativo/não bloqueado com admin=true ou módulo 'compras';
 *   dados (Rules compras_n0_view/sugestoes = temAcessoModulo('estoque')): admin=true OU módulo 'estoque' em sistema_usuarios.
 * O agente exige AS DUAS (quem não lê a visão na tela também não lê pelo agente). gestao (custo/margem/capital/orçamento) = Rules de compras_n0_view/custos:
 * role 'gestor' + (admin | estoque) + não bloqueado. Piloto MANAGEMENT_ONLY = gestao.
 */
async function autorizar(store, uid) {
  const p = await G.perfilModulo(store, uid);
  if (p.role !== 'gestor' && p.role !== 'funcionario') G.falhaG('permission-denied', 'SEM_MODULO_COMPRAS');
  const tela = p.role === 'gestor' || p.admin === true || p.modulos.includes('compras'), dados = p.admin === true || p.modulos.includes('estoque');
  if (!(tela && dados)) G.falhaG('permission-denied', 'SEM_MODULO_COMPRAS');
  return { ...p, gestao: p.role === 'gestor' };
}

async function ler(store, col, id) { const s = await store.collection(col).doc(id).get(); return s.exists ? s.data() : null; }
/** Leitura SOMENTE LEITURA das 3 visões já processadas (as mesmas da tela). Custos só para gestão (a leitura nem acontece sem a permissão). */
async function carregar(store, acesso) {
  const [sugestoes, meta, custos] = await Promise.all([ler(store, 'compras_n0_view', 'sugestoes'), ler(store, 'compras_n0', 'meta'), acesso.gestao ? ler(store, 'compras_n0_view', 'custos') : Promise.resolve(null)]);
  return { sugestoes, meta, custos };
}
const VISAO_VAZIA = { sugestoes: { linhas: [], contagens: {} }, custos: null };
function montar(dados, acesso, pergunta, agoraIso) {
  const visao = dados.sugestoes && Array.isArray(dados.sugestoes.linhas) ? { sugestoes: dados.sugestoes, custos: dados.custos } : VISAO_VAZIA;
  return G.ajustarAoLimite(escala => C.construirContexto(visao, dados.meta, { gestao: !!acesso.gestao, pergunta, agoraIso, escala }), { alvoBytes: 22000 });
}

/** Regras do módulo pós-modelo (além do validador genérico): ação só para quem tem o sinal; sem dado → sem recomendação; sem gestão → sem R$/custo/margem. */
function validacoesExtras(resp, ctx) {
  const falha = (c, d) => { throw new RespostaInvalida(c, d); };
  const texto = JSON.stringify([resp.answer, resp.warnings, resp.unavailable, resp.recommendations.map(r => r.rationale)]);
  const ents = ctx.entidades || {};
  for (const r of resp.recommendations) {
    if (r.ref === null) falha('RECOMENDACAO_SEM_REF');
    const exige = ACAO_EXIGE[r.action] || [], f = ents[r.ref]; if (!f || !exige.some(c => (f.sinais || []).includes(c))) falha('ACAO_SEM_SINAL', r.ref + ':' + r.action);
  }
  if (ctx.pedidoSemDado && ctx.pedidoSemDado.length) { if (!resp.unavailable.length) falha('DADO_AUSENTE_NAO_DECLARADO', ctx.pedidoSemDado.join(',')); if (resp.recommendations.length) falha('RECOMENDACAO_SEM_DADO'); }
  if (ctx.orcamento && ctx.orcamento.status !== 'OK') { if (!resp.unavailable.length) falha('ORCAMENTO_SEM_ESCLARECIMENTO', ctx.orcamento.status); if (resp.recommendations.length || resp.entities.length) falha('ORCAMENTO_INVALIDO_COM_RECOMENDACAO'); }
  if (ctx.orcamento && ctx.orcamento.status === 'OK') {
    const cesta = new Set((ctx.orcamento.cesta || []));
    for (const r of resp.recommendations) if (r.action === 'PRIORIZAR_NA_CESTA' && !cesta.has(r.ref)) falha('PRIORIZAR_FORA_DA_CESTA', r.ref);
  }
  if (!ctx.visaoFinanceira && /margem|lucro|custo|capital|R\$|reais/i.test(texto)) falha('VALOR_FINANCEIRO_SEM_GESTAO');
  if (/fornecedor/i.test(texto) && !(resp.unavailable || []).some(x => /fornecedor/i.test(x)) && !/n[aã]o (h[aá]|tem|existe|est[aá])[^"]{0,60}fornecedor|fornecedor[^"]{0,60}(n[aã]o|indispon)/i.test(texto)) falha('FORNECEDOR_INVENTADO');
}

const fmtNum = (n) => (typeof n === 'number' ? n : null);
/** Item para a tela. Para o fallback (sem IA) também traz motivos/evidências calculados pelo sistema. */
function apresentar({ ref }, montado) {
  const m = montado.mapa[ref], e = montado.contexto.entidades[ref] || {};
  const extras = ['prioridade', 'qtdSugerida', 'estoque', 'capitalNecessario', 'cestaQtd'].filter(k => e[k] !== undefined).map(k => ({ label: ROTULOS.metricas[k], metric: k, value: e[k] }));
  return { id: m.codigo || m.id, nome: m.nome, tipo: 'Produto', prioridade: null, extras,
    reasonCodes: (e.sinais || []).slice(0, 4).map(c => ({ code: c, label: ROTULOS.motivos[c] || c })),
    evidence: ['coberturaDias', 'velocidadeDia', 'qtdSugerida', 'capitalNecessario'].filter(k => fmtNum(e[k]) !== null).map(k => ({ metric: k, label: ROTULOS.metricas[k], value: e[k] })) };
}

const agente = {
  agentType: 'purchasing', modulo: 'compras', generico: true, schemaName: 'compras_resposta', perguntaResumo: 'Resumo de compras: o que repor, capital sugerido, itens críticos, o que pode aguardar e risco de ruptura.',
  instructions: INSTRUCTIONS, motivos: MOTIVOS, acoes: ACOES, schema: SCHEMA, refPattern: /\bP\d{3}\b/g, rotulos: ROTULOS,
  autorizar, carregar, montar, auditar: C.auditarContexto, apresentar, validacoesExtras,
  avisoDesatualizado: 'Os dados de Compras estão desatualizados (última geração do motor há mais de 6 horas, falha na última tentativa ou visões desalinhadas). Confira a data antes de decidir.',
  msgSemDados: 'O motor de Compras ainda não tem sugestões geradas para analisar.',
};
module.exports = { agente, autorizar, carregar, montar, validacoesExtras, apresentar };
