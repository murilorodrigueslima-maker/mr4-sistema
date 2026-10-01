'use strict';
// AGENTE DE ESTOQUE (agentType 'inventory', módulo 'estoque') — definição para o fluxo genérico (gateway/generic.js).
//   DADOS REAIS (compras_n0_*: fatos do motor do módulo Compras & Estoque) → MOTOR DO AGENTE (classificar/contar/selecionar candidatos)
//   → CONTEXTO (só refs P001… + métricas) → AI GATEWAY → INTERPRETAÇÃO + EVIDÊNCIA validada. A IA não calcula nada e não prevê nada.
const G = require('../../gateway/generic');
const { RespostaInvalida } = require('../../gateway/schema');
const { escaneiarTextoParaPII } = require('../../../n29/piiGuard');
const C = require('./catalogo');
const E = require('./engine');

const MAX_CANDIDATOS = 30, ALVO_BYTES = 22000, STALE_PADRAO_HORAS = 6;
const COLS = { meta: ['compras_n0', 'meta'], resumo: ['compras_n0', 'resumo'], view: ['compras_n0_view', 'sugestoes'], catalogo: ['painel_cache', 'produtos_catalogo'] };

/**
 * Autorização = regra REAL do módulo Estoque (modulos/firestore.rules + js/guard.js):
 *   acesso aos dados operacionais  → temAcessoModulo('estoque'): usuário ativo (users.ativo), role gestor|funcionario, sistema_usuarios não bloqueado e (admin=true | 'estoque' em modulos).
 *   custo / valor de estoque       → temModulo('estoque'): ISGESTOR (role gestor) + (admin | módulo estoque) + não bloqueado.
 * gestao (piloto MANAGEMENT_ONLY) = a mesma regra de custo: role gestor com acesso ao módulo. verCusto = gestao (nunca mais amplo que a Rule).
 */
async function autorizar(store, uid) {
  const p = await G.perfilModulo(store, uid);                                            // ativo, sistema_usuarios existe e não bloqueado
  if (p.role !== 'gestor' && p.role !== 'funcionario') G.falhaG('permission-denied', 'SEM_MODULO_ESTOQUE');
  if (!p.modulos.includes('estoque')) G.falhaG('permission-denied', 'SEM_MODULO_ESTOQUE');   // módulo EXPLÍCITO (decisão de produto): admin=true sozinho NÃO basta para a IA, mesmo que as Rules do módulo aceitem
  const gestao = p.role === 'gestor';
  return { uid, role: p.role, gestao, verCusto: gestao };
}

const lerDoc = async (store, [c, id]) => { try { const s = await store.collection(c).doc(id).get(); return s.exists ? s.data() : null; } catch (e) { return null; } };
/** Leitura SOMENTE LEITURA (Admin SDK) dos fatos já publicados pelo sync do módulo Compras. Custos só são lidos para quem pode ver custo. */
async function carregar(store, acesso) {
  const lerBlocos = async col => ((await store.collection(col).get()).docs || []).map(d => ({ id: d.id, ...d.data() })).filter(d => /^bloco_\d+$/.test(d.id)).sort((a, b) => a.id.localeCompare(b.id)).flatMap(d => d.produtos || []);
  const [meta, resumoDoc, view, cat] = await Promise.all([lerDoc(store, COLS.meta), lerDoc(store, COLS.resumo), lerDoc(store, COLS.view), lerDoc(store, COLS.catalogo)]);
  const produtos = await lerBlocos('compras_n0_produtos');
  const custos = acesso.verCusto ? await lerBlocos('compras_n0_custos') : [];
  const nomes = { viewPorId: {}, catPorCodigo: {}, catPorId: {} };
  for (const l of (view && Array.isArray(view.linhas) ? view.linhas : [])) if (l && l.id != null && l.nome) nomes.viewPorId[String(l.id)] = String(l.nome);
  for (const p of (cat && Array.isArray(cat.itens) ? cat.itens : [])) { if (p && p.nome) { if (p.codigo) nomes.catPorCodigo[String(p.codigo)] = String(p.nome); if (p.id != null) nomes.catPorId[String(p.id)] = String(p.nome); } }
  return { meta, resumoDoc, produtos, custos, nomes };
}
const nomeDe = (it, nomes) => nomes.viewPorId[it.id] || nomes.catPorId[it.id] || (it.codigo && nomes.catPorCodigo[it.codigo]) || ('Produto ' + (it.codigo || it.id));

const LIMITACOES = [
  'Só o passado: não há previsão de demanda. Ausência de venda não prova ausência de demanda (o ERP não guarda histórico de saldo).',
  'Regra de "sem venda": 120 dias ou mais (119 não conta). Produto novo (menos de 60 dias) nunca é classificado como parado.',
  'Entidades são candidatos selecionados pelo sistema; o resumo conta toda a base de estoque ativo.',
  'Sem estoque mínimo do ERP, lead time, fornecedor, preço ou margem neste agente.',
];
const LIMITACAO_CUSTO = 'Capital = estoque x custo CADASTRADO (indicativo): o custo do ERP difere do último custo de compra em boa parte dos produtos e não rateia frete/impostos.';
const LIMITACAO_SEM_CUSTO = 'Valores em R$ (custo e capital) não estão disponíveis para este perfil.';

function frescorDe(dados, agoraIso) {
  const fonte = (dados.meta && (dados.meta.ultima_sincronizacao_ok || null)) || (dados.resumoDoc && dados.resumoDoc.gerado_em) || null;
  const lim = (dados.resumoDoc && dados.resumoDoc.politica && dados.resumoDoc.politica.sync && dados.resumoDoc.politica.sync.stale_after_hours) || STALE_PADRAO_HORAS;
  const idadeH = fonte ? Math.round((new Date(agoraIso).getTime() - new Date(fonte).getTime()) / 3600000 * 10) / 10 : null;
  return { sourceUpdatedAt: fonte, desatualizado: !fonte || !(idadeH <= lim), idadeHoras: idadeH, limiteHoras: lim };
}

/** Limiares que o texto pode citar (como números do contexto). Vêm da política publicada pelo sync; padrão = política vigente. */
function regrasDe(dados) {
  const pol = (dados.resumoDoc && dados.resumoDoc.politica) || {}, ci = pol.coverage_indicators || {}, v = pol.velocity || {}, nw = pol.new_product || {};
  return { semVendaDias: C.LIMIAR_SEM_VENDA_DIAS, coberturaCriticaDias: ci.critical_below_days || 15, coberturaBaixaDias: ci.low_below_days || 30, coberturaExcessoDias: ci.excess_above_days || 180, produtoNovoDias: nw.window_days || 60, janelaVelocidadeDias: v.window_days || 90, janelaSinalDias: v.signal_window_days || 30, janelaAbcDias: (pol.abc && pol.abc.window_days) || 365, maxCandidatos: MAX_CANDIDATOS };
}
function montarComEscala(dados, acesso, pergunta, agoraIso, escala, base) {
  const { itens, resumo } = base;
  const intent = E.interpretarPergunta(pergunta);
  const max = Math.max(3, Math.floor(MAX_CANDIDATOS * escala));
  const { selecionados, foco } = E.selecionarCandidatos(itens, intent.focos, max, { verCusto: acesso.verCusto });
  const entidades = {}, mapa = {};
  selecionados.forEach((it, n) => { const ref = 'P' + String(n + 1).padStart(3, '0'); entidades[ref] = { ...it.fatos, sinais: it.sinais }; mapa[ref] = { id: it.id, codigo: it.codigo, nome: nomeDe(it, dados.nomes), fatos: it.fatos, sinais: it.sinais }; });
  const fr = frescorDe(dados, agoraIso);
  const hoje = (dados.meta && dados.meta.data_comercial) || (dados.resumoDoc && dados.resumoDoc.data_comercial) || null;
  const resumoCtx = { ...resumo }; 
  const contexto = {
    escopo: 'ESTOQUE_ATIVO_SEM_KITS', dataBase: hoje, permissoes: { custoVisivel: acesso.verCusto === true }, regras: regrasDe(dados), resumo: resumoCtx, foco,
    entidades, limitacoes: [...LIMITACOES, acesso.verCusto ? LIMITACAO_CUSTO : LIMITACAO_SEM_CUSTO],
    metricasIndisponiveis: Object.keys(C.METRICAS.MISSING), frescor: { fonteAtualizadaEm: fr.sourceUpdatedAt ? String(fr.sourceUpdatedAt).slice(0, 10) : null, idadeHoras: fr.idadeHoras, desatualizado: fr.desatualizado },
  };
  if (intent.naoSuportado.length) contexto.pedidoNaoSuportado = intent.naoSuportado;
  const fallbackN = Math.min(10, selecionados.length);
  return { contexto, mapa, resumo: { ...resumo, alertas: E.alertasDoResumo(resumo) }, fallback: Object.keys(entidades).slice(0, fallbackN).map(ref => ({ ref })), bytes: Buffer.byteLength(JSON.stringify(contexto)), frescor: fr, perguntaSegura: pergunta, vazio: itens.length === 0 };
}
function montar(dados, acesso, pergunta, agoraIso) {
  const base = E.analisarBase(dados.produtos, dados.custos, { verCusto: acesso.verCusto });
  return G.ajustarAoLimite(escala => montarComEscala(dados, acesso, pergunta, agoraIso, escala, base), { alvoBytes: ALVO_BYTES });
}

// ── Auditoria do contexto (allowlist) ─────────────────────────────────────────────────────────────────────────────────
const CHAVES_TOPO = new Set(['escopo', 'dataBase', 'permissoes', 'regras', 'resumo', 'foco', 'entidades', 'limitacoes', 'metricasIndisponiveis', 'frescor', 'pedidoNaoSuportado']);
const CHAVES_ENTIDADE = new Set(['estoque', 'vendas30d', 'vendas90d', 'diasSemVenda', 'coberturaDias', 'giro90d', 'curvaAbc', 'tendencia', 'nuncaVendidoConfianca', 'custoUnitario', 'capitalImobilizado', 'confiancaCusto', 'sinais']);
const CHAVES_CUSTO = new Set(['custoUnitario', 'capitalImobilizado', 'confiancaCusto']);
const CHAVES_RESUMO_CUSTO = ['capitalEmEstoque', 'capitalParado', 'capitalCustoConfiavelPct', 'capitalTop10Pct', 'capitalCurvaCSemVendaPct', 'produtosEmEstoqueSemCusto'];
const PROIBIDAS = /^(nome|name|codigo|code|id|product_id|fornecedor|supplier|suppliers|last_supplier|descricao|observacao|telefone|email|cnpj|cpf|token|segredo|cliente)$/i;
function auditar(ctx, acesso) {
  const problemas = [];
  for (const k of Object.keys(ctx)) if (!CHAVES_TOPO.has(k)) problemas.push('CHAVE_TOPO:' + k);
  const varrer = (o, caminho) => { if (Array.isArray(o)) o.forEach((x, i) => varrer(x, caminho + '[]')); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (PROIBIDAS.test(k)) problemas.push('CHAVE_PROIBIDA:' + caminho + '.' + k); varrer(v, caminho + '.' + k); } };
  varrer(ctx, 'ctx');
  const cod = /^[A-Z][A-Z0-9_]*$/;
  for (const [ref, e] of Object.entries(ctx.entidades || {})) {
    if (!/^P\d{3}$/.test(ref)) problemas.push('REF_INVALIDA');
    for (const [k, v] of Object.entries(e)) {
      if (!CHAVES_ENTIDADE.has(k)) problemas.push('CHAVE_ENTIDADE:' + k);
      if (!acesso.verCusto && CHAVES_CUSTO.has(k)) problemas.push('CUSTO_SEM_PERMISSAO:' + k);
      if (typeof v === 'string' && !cod.test(v)) problemas.push('TEXTO_LIVRE_EM_ENTIDADE:' + k);
      if (Array.isArray(v) && v.some(x => typeof x !== 'string' || !cod.test(x))) problemas.push('SINAL_INVALIDO');
    }
  }
  if (!acesso.verCusto) { for (const k of CHAVES_RESUMO_CUSTO) if (ctx.resumo && k in ctx.resumo) problemas.push('CUSTO_NO_RESUMO:' + k); if (ctx.permissoes && ctx.permissoes.custoVisivel !== false) problemas.push('PERMISSAO_INCONSISTENTE'); }
  const textos = []; (function c(o) { if (typeof o === 'string') textos.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(c); })(ctx);
  const pii = escaneiarTextoParaPII(textos.join(' | ').replace(/\b20\d\d-\d\d-\d\d\b/g, 'DATA')); if (!pii.ok) problemas.push('PII:' + pii.encontrado.join(','));
  return { ok: problemas.length === 0, problemas };
}

function apresentar({ ref }, montado) {
  const m = montado.mapa[ref]; const f = m.fatos;
  const ev = ['estoque', 'vendas90d', 'diasSemVenda', 'coberturaDias', 'capitalImobilizado'].filter(k => k in f).map(k => ({ metric: k, label: C.ROTULOS.metricas[k], value: f[k] }));
  return { id: m.id, nome: m.nome, codigo: m.codigo, tipo: m.codigo ? 'Cód. ' + m.codigo : null, reasonCodes: m.sinais.map(c => ({ code: c, label: C.ROTULOS.motivos[c] || c })), evidence: ev };
}

// ── Regras pós-modelo específicas do módulo (além do validador genérico) ───────────────────────────────────────────────
const semAcento = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const RE_PREVISAO_AFIRMADA = /\b(vai|vao|ira|sera)\s+(vender|sair|esgotar|acabar|faltar|zerar)\b|\bvendera\b|\bvenderao\b|\besgotara\b|\bamanha\b/i;   // aplicada ao texto SEM acentos
function validacoesExtras(resp, ctx) {
  const falha = (c, d) => { throw new RespostaInvalida(c, d); };
  const ents = ctx.entidades || {};
  const textos = [resp.answer, ...(resp.recommendations || []).map(r => r && r.rationale)].filter(t => typeof t === 'string');
  if (textos.some(t => RE_PREVISAO_AFIRMADA.test(semAcento(t)))) falha('PREVISAO_AFIRMADA_COMO_FATO');     // o sistema não prevê vendas
  if (Array.isArray(ctx.pedidoNaoSuportado) && ctx.pedidoNaoSuportado.length && !(resp.unavailable || []).some(u => typeof u === 'string' && u.trim())) falha('PEDIDO_NAO_SUPORTADO_SEM_UNAVAILABLE', ctx.pedidoNaoSuportado.join(','));
  if (ctx.permissoes && ctx.permissoes.custoVisivel === false && textos.some(t => /R\$|\bcusto\b|\bcapital\b|imobiliz/i.test(t))) falha('VALOR_SEM_PERMISSAO');
  const exigeSinal = { AVALIAR_LIQUIDACAO: ['CANDIDATO_LIQUIDACAO'], AVALIAR_REPOSICAO: ['RISCO_RUPTURA', 'RUPTURA_ATUAL'], CONFERIR_SALDO: ['ESTOQUE_NEGATIVO'] };
  for (const r of resp.recommendations || []) {
    const req = exigeSinal[r.action]; if (!req) continue;
    const sinais = r.ref && ents[r.ref] ? ents[r.ref].sinais || [] : [];
    if (!req.some(s => sinais.includes(s))) falha('ACAO_SEM_SINAL_DO_MOTOR', r.action + ':' + String(r.ref).slice(0, 8));
  }
}

/**
 * Previsão de demanda NÃO existe (não há dado confiável): perguntas explicitamente preditivas são respondidas de forma DETERMINÍSTICA, sem modelo.
 * Não transforma tendência histórica em previsão factual. Perguntas sobre cobertura/ruptura/giro (fatos do motor) NÃO entram aqui.
 */
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const PADROES_PREVISAO = [
  /\b(vai|vao|ira|irao|devera|deverao|podera|poderao|vamos)\s+(vender|sair|girar)/,
  /\bvender(a|ao|ia|iam)\b/,
  /\bquanto\s+(vou|vamos|vao|ira|irei)\s+vender/,
  /\b(previsao|prever|previsto|projecao|projetar|estimativa|estimar|forecast)\b.{0,25}\b(venda|vendas|demanda|giro|consumo|saida)/,
  /\b(venda|vendas|demanda|giro|consumo|saida)\b.{0,25}\b(previs\w+|futur\w+)/,
  /\bvend\w*\b.{0,30}\b(amanha|semana que vem|mes que vem|proxim[oa]s?\s+(dia|dias|semana|semanas|mes|meses))\b/,
  /\b(amanha|semana que vem|mes que vem|proxim[oa]s?\s+(dia|dias|semana|semanas|mes|meses))\b.{0,30}\bvend\w*/,
];
function respostaPrevia(pergunta) {
  const q = norm(pergunta); if (!PADROES_PREVISAO.some(r => r.test(q))) return null;
  return { motivo: 'PREVISAO_INDISPONIVEL', answer: 'O sistema não possui previsão de demanda confiável, então não vou prever vendas futuras (nem transformar a tendência histórica em previsão). Posso mostrar fatos já calculados: giro, cobertura em dias, produtos acelerando ou perdendo giro e risco de ruptura.', unavailable: ['Previsão de demanda / vendas futuras'] };
}

const agente = {
  agentType: 'inventory', modulo: 'estoque', generico: true, schemaName: 'estoque_resposta', perguntaResumo: C.PERGUNTA_RESUMO, instructions: C.INSTRUCTIONS,
  motivos: [...C.MOTIVOS], acoes: [...C.ACOES], schema: C.SCHEMA, refPattern: /\bP\d{3}\b/g, rotulos: C.ROTULOS,
  autorizar, carregar, montar, auditar, apresentar, validacoesExtras, respostaPrevia,
  avisoDesatualizado: 'Dados de estoque desatualizados: a última sincronização passou do limite. Confira a data da fonte antes de decidir.',
  msgSemDados: 'Ainda não há dados de estoque sincronizados. Aguarde a próxima sincronização do módulo Compras & Estoque.',
};
module.exports = { agente, respostaPrevia, autorizar, carregar, montar, montarComEscala, auditar, apresentar, validacoesExtras, frescorDe, LIMITACOES, MAX_CANDIDATOS, ALVO_BYTES, ROTULOS_VALOR: C.ROTULOS_VALOR, METRICAS: C.METRICAS };
