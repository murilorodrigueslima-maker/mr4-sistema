'use strict';
// AGENTE COMERCIAL — Context Builder. TODAS as métricas vêm de motores determinísticos já existentes (perfil360, recorrencia,
// tendenciaComercial, filaOperacional/crmTimeline). A IA recebe RESULTADOS, nunca vendas brutas e nunca calcula nada.
// Escopo aplicado ANTES de qualquer dado sair: vendedor = só worklist própria + atribuições/reservas/atendimentos próprios + carteira própria;
// gestão = worklist de todos. R$ só para a gestão. Notas privadas, telefone, e-mail, endereço, documentos: nunca carregados aqui.
const { calcularPerfil360 } = require('../../perfil360');
const { calcularRecorrencia } = require('../../recorrencia');
const { calcularTendencia } = require('../../tendenciaComercial');
const T = require('../../crmTimeline');
const { __internals: CRM } = require('../../crmConsulta');
const { filtrarCliente, AI_DATA_ALLOWLIST } = require('./allowlist');

const VERSAO = 'agente-comercial-ctx-1';
const LIMITES = Object.freeze({
  CAP_CLIENTES_VENDEDOR: 250, CAP_CLIENTES_GESTAO: 150,        // teto de clientes analisados por pedido (leituras de vendas em lote de 10)
  K_PRIORIDADE: 20, K_SEM_COMPRAR: 15, K_QUEDA: 15, K_RECOMPRA: 15,   // tamanho de cada ranking enviado ao modelo
  MAX_CONTEXTO_BYTES: 24000,                                   // ≈ 6–8 mil tokens: cabe com folga e mantém custo/latência previsíveis
  DIAS_SEM_CONTATO: 14, DIAS_DADOS_DESATUALIZADOS: 3, CACHE_TTL_MS: 10 * 60 * 1000,
});
const FORTES = ['SEM_COMPRA_120D', 'ATRASADO_VS_CICLO', 'FOLLOWUP_ATRASADO', 'QUEDA_DE_COMPRAS'];

const diasEntre = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))))) / 86400000);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Fatos determinísticos de um cliente (+ sinais e prioridade por REGRA, sem score numérico). */
function fatosDoCliente({ cand, vendas, estados, hoje, gestao }) {
  const perfil = calcularPerfil360({ clienteMr4Id: cand.gcId, gestaoClickId: cand.gcId, vendas, dataReferencia: hoje });
  let rec = null, ten = null; try { rec = calcularRecorrencia(perfil); } catch (_) {} try { ten = calcularTendencia(perfil); } catch (_) {}
  const nunca = !!perfil.nuncaComprou, dias = nunca ? null : perfil.diasSemComprar;
  const f = { nome: cand.nome || null, responsavel: cand.responsavel || null, tipoOportunidade: (cand.opps[0] || {}).tipo || null, estadoOportunidade: (cand.opps[0] || {}).grupo || null };
  if (!nunca) {
    Object.assign(f, { ultimaCompraEm: perfil.ultimaCompraEm, primeiraCompraEm: perfil.primeiraCompraEm, diasSemComprar: dias, pedidosTotal: perfil.pedidosTotal, pedidos30d: perfil.pedidos30d, pedidos60d: perfil.pedidos60d, pedidos90d: perfil.pedidos90d, pedidos180d: perfil.pedidos180d,
      frequenciaDias: perfil.diasEntreComprasMediana != null ? Math.round(perfil.diasEntreComprasMediana) : null,
      status120Dias: dias >= 120 ? 'ABERTO_120D' : dias >= 90 ? 'PROXIMO_120D' : 'FECHADO_120D' });
    f.produtosMaisComprados = (perfil.produtosMaisComprados || []).map(p => p && p.nome).filter(Boolean);
    f.categorias = (perfil.categoriasMaisCompradas || []).map(c => c && c.categoria).filter(c => c && c !== 'SEM_CATEGORIA');
    if (gestao) Object.assign(f, { faturamento30d: perfil.faturamento30d, faturamento60d: perfil.faturamento60d, faturamento90d: perfil.faturamento90d, faturamento180d: perfil.faturamento180d, ticketMedio: perfil.ticketMedioTotal });
  } else f.status120Dias = 'SEM_COMPRA';
  f.recorrencia = rec ? rec.status : null; f.tendencia = ten ? ten.tendencia : null; f.tendenciaMetodo = ten ? ten.metodo : null;
  f.variacaoPedidosPct = ten && ten.evidencias ? ten.evidencias.variacaoPedidos ?? null : null;
  if (gestao) f.variacaoFaturamentoPct = ten && ten.evidencias ? ten.evidencias.variacaoFaturamento ?? null : null;
  // interação (resultados e retornos já existentes — sem notas)
  let ult = null, proximo = null, cool = null; const outs = [];
  for (const e of estados) {
    for (const x of e.eventos || []) if (x && x.tipo === 'OUTCOME_REGISTERED' && x.timestamp && T.OUTCOMES_CONTATO.includes(x.outcome)) { outs.push({ outcome: x.outcome, em: T.diaComercial(x.timestamp), ts: x.timestamp }); if (!ult || x.timestamp > ult.ts) ult = { outcome: x.outcome, em: T.diaComercial(x.timestamp), ts: x.timestamp }; }
    if (e.nextFollowUpAt && e.estado !== 'CONCLUIDA' && (!proximo || e.nextFollowUpAt < proximo)) proximo = e.nextFollowUpAt;
    if (e.cooledUntil) { const d = String(e.cooledUntil).slice(0, 10); if (d > hoje && (!cool || d > cool)) cool = d; }
  }
  f.ultimoOutcome = ult ? ult.outcome : null; f.ultimoContatoEm = ult ? ult.em : null; f.diasDesdeUltimoContato = ult ? diasEntre(ult.em, hoje) : null;
  f.proximoRetornoEm = proximo; f.situacaoRetorno = proximo ? (proximo < hoje ? 'ATRASADO' : proximo === hoje ? 'HOJE' : 'FUTURO') : null; f.emCooldownAte = cool;
  // sinais (códigos do catálogo) — regras explícitas
  const sin = [];
  if (f.status120Dias === 'ABERTO_120D') sin.push('SEM_COMPRA_120D');
  if (f.status120Dias === 'PROXIMO_120D') sin.push('PROXIMO_120D');
  if (f.recorrencia === 'ATRASADO_VS_HISTORICO') sin.push('ATRASADO_VS_CICLO');
  if (f.recorrencia === 'PROXIMO_DA_JANELA') sin.push('PROXIMO_DA_JANELA_RECOMPRA');
  if (f.tendencia === 'CAINDO') sin.push('QUEDA_DE_COMPRAS');
  if (f.situacaoRetorno === 'ATRASADO') sin.push('FOLLOWUP_ATRASADO'); if (f.situacaoRetorno === 'HOJE') sin.push('FOLLOWUP_HOJE');
  const precisaContato = sin.some(s => FORTES.includes(s) || s === 'PROXIMO_120D' || s === 'PROXIMO_DA_JANELA_RECOMPRA');
  if (precisaContato && (f.diasDesdeUltimoContato == null || f.diasDesdeUltimoContato > LIMITES.DIAS_SEM_CONTATO)) sin.push('SEM_CONTATO_RECENTE');
  if (f.emCooldownAte) sin.push('EM_COOLDOWN');
  if (cand.opps.length) sin.push('OPORTUNIDADE_NA_FILA');
  f.sinais = sin;
  // prioridade por REGRA (não é score): fortes + contato
  const nf = sin.filter(s => FORTES.includes(s)).length;
  let tier = nf >= 2 || (nf >= 1 && sin.includes('SEM_CONTATO_RECENTE')) ? 2 : (nf >= 1 || sin.includes('PROXIMO_120D') || sin.includes('PROXIMO_DA_JANELA_RECOMPRA') || sin.includes('FOLLOWUP_HOJE')) ? 1 : 0;
  if (sin.includes('EM_COOLDOWN') && tier > 0) tier -= 1;
  f.prioridadeSugerida = ['baixa', 'media', 'alta'][tier]; f._tier = tier; f._ultimos = outs.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 5).map(o => `${o.outcome} ${o.em}`);
  return f;
}

/** Núcleo PURO: dados carregados → contexto filtrado + mapa de refs + resumo do dia + fallback sem IA. */
function construirContexto({ candidatos, vendasPorGc, estadosPorEntidade, hoje, gestao, pergunta = '', meta = {} }) {
  const ordenados = [...candidatos].sort((a, b) => String(a.gcId).localeCompare(String(b.gcId), 'en', { numeric: true }));
  const refDe = new Map(); ordenados.forEach((c, i) => refDe.set(c.gcId, 'C' + String(i + 1).padStart(3, '0')));
  const todos = ordenados.map(cand => ({ cand, ref: refDe.get(cand.gcId), f: fatosDoCliente({ cand, vendas: vendasPorGc[cand.gcId] || [], estados: estadosPorEntidade[cand.entidade] || estadosPorEntidade['GC:' + cand.gcId] || [], hoje, gestao }) }));
  const cmp = (a, b) => b.f._tier - a.f._tier || b.f.sinais.length - a.f.sinais.length || (b.f.diasSemComprar || 0) - (a.f.diasSemComprar || 0) || a.ref.localeCompare(b.ref);
  const prioridade = todos.filter(x => x.f._tier > 0).sort(cmp).slice(0, LIMITES.K_PRIORIDADE);
  const semComprar = todos.filter(x => x.f.diasSemComprar != null && x.f.pedidosTotal >= 1).sort((a, b) => b.f.diasSemComprar - a.f.diasSemComprar || a.ref.localeCompare(b.ref)).slice(0, LIMITES.K_SEM_COMPRAR);
  const queda = todos.filter(x => x.f.tendencia === 'CAINDO').sort((a, b) => (a.f.variacaoPedidosPct ?? 0) - (b.f.variacaoPedidosPct ?? 0) || a.ref.localeCompare(b.ref)).slice(0, LIMITES.K_QUEDA);
  const recompra = todos.filter(x => ['ATRASADO_VS_HISTORICO', 'PROXIMO_DA_JANELA'].includes(x.f.recorrencia)).sort((a, b) => (b.f.diasSemComprar || 0) - (a.f.diasSemComprar || 0) || a.ref.localeCompare(b.ref)).slice(0, LIMITES.K_RECOMPRA);
  // cliente em foco (pergunta cita o nome de UM cliente do escopo)
  const q = norm(pergunta); const achados = q ? todos.filter(x => x.f.nome && norm(x.f.nome).length >= 4 && ` ${q} `.includes(` ${norm(x.f.nome)} `)) : [];
  const maxLen = achados.reduce((m, x) => Math.max(m, norm(x.f.nome).length), 0); const melhores = achados.filter(x => norm(x.f.nome).length === maxLen);
  const foco = melhores.length === 1 ? melhores[0] : null; const ambiguo = melhores.length > 1;
  // A pergunta pode citar um nome: o texto enviado ao modelo troca o nome pela ref opaca (ou por [cliente] quando ambíguo). Nome nunca vai ao provedor.
  let perguntaSegura = String(pergunta || '');
  for (const x of achados.sort((a, b) => norm(b.f.nome).length - norm(a.f.nome).length)) { const re = new RegExp(norm(x.f.nome).split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\W_]+'), 'gi'); const ref = melhores.length === 1 ? x.ref : '[cliente]'; perguntaSegura = perguntaSegura.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(re, ref); }
  const incluidos = new Map(); for (const x of [...prioridade, ...semComprar, ...queda, ...recompra]) incluidos.set(x.ref, x);
  const ctxClientes = {}; for (const [ref, x] of incluidos) { const c = filtrarCliente({ ...x.f, ref }, { gestao }); delete c.produtosMaisComprados; delete c.categorias; ctxClientes[ref] = c; }
  let emFoco = null; if (foco) { const c = filtrarCliente({ ...foco.f, ref: foco.ref, ultimosContatos: foco.f._ultimos }, { gestao }); emFoco = c; delete ctxClientes[foco.ref]; }
  const conta = fn => todos.filter(fn).length;
  const resumoDia = { clientesAnalisados: todos.length, prioridadeAlta: conta(x => x.f._tier === 2), merecemContato: conta(x => x.f._tier >= 1), quedaRelevante: conta(x => x.f.tendencia === 'CAINDO'), semCompra120d: conta(x => x.f.status120Dias === 'ABERTO_120D'), proximosDe120: conta(x => x.f.status120Dias === 'PROXIMO_120D'),
    recompraProvavel: conta(x => ['ATRASADO_VS_HISTORICO', 'PROXIMO_DA_JANELA'].includes(x.f.recorrencia)), followUpsAtrasados: conta(x => x.f.situacaoRetorno === 'ATRASADO'), followUpsHoje: conta(x => x.f.situacaoRetorno === 'HOJE'), semContatoRecente: conta(x => x.f.sinais.includes('SEM_CONTATO_RECENTE')) };
  const refs = r => r.map(x => x.ref);
  const defasagem = meta.vendasAte ? diasEntre(meta.vendasAte, hoje) : null; const desatualizado = defasagem != null && defasagem > LIMITES.DIAS_DADOS_DESATUALIZADOS;
  const limitacoes = ['Análise baseada em fila comercial + carteira dentro do seu escopo.', 'Nomes de clientes, notas privadas, telefone, e-mail, endereço e documentos não são enviados ao agente (clientes aparecem por referência).', 'Produtos e categorias só estão disponíveis para o cliente em foco.']
    .concat(gestao ? [] : ['Valores em R$ não estão disponíveis para o perfil de vendedor.']).concat(desatualizado ? [`Dados de vendas desatualizados: a última venda conhecida é de ${defasagem} dias atrás.`] : []).concat(meta.truncado ? [`Análise limitada a ${todos.length} clientes (teto por pedido).`] : []).concat(ambiguo ? ['A pergunta cita mais de um cliente com nome parecido; nenhum foi selecionado.'] : []);
  const contexto = { agenteVersao: VERSAO, geradoEm: meta.geradoEm || null, hoje, escopo: gestao ? 'GESTAO_TODOS_OS_VENDEDORES' : 'VENDEDOR_PROPRIO', resumoDia, rankings: { prioridade: refs(prioridade), maisTempoSemComprar: refs(semComprar), maiorQueda: refs(queda), recompra: refs(recompra) },
    clientes: ctxClientes, ...(emFoco ? { clienteEmFoco: emFoco } : {}), limitacoes,
    regras: { janelasDiasPedidos: [30, 60, 90, 180], limiteInatividadeDias: 120, inicioAlertaInatividadeDias: 90, semContatoRecenteDias: LIMITES.DIAS_SEM_CONTATO },   // números das REGRAS do sistema (o texto pode citá-los)
    frescor: { fonteVendasAte: meta.vendasAte || null, listaDoDia: meta.listaDoDia || null, desatualizado: !!desatualizado }, metricasDisponiveis: ['ultimaCompraEm', 'diasSemComprar', 'pedidos30d/60d/90d/180d', 'pedidosTotal', 'frequenciaDias', 'status120Dias', 'recorrencia', 'tendencia', 'variacaoPedidosPct', 'ultimoOutcome', 'ultimoContatoEm', 'proximoRetornoEm', 'emCooldownAte'].concat(gestao ? ['faturamento30d/60d/90d/180d', 'ticketMedio', 'variacaoFaturamentoPct'] : []) };
  const mapa = {}; for (const x of todos) mapa[x.ref] = { entidade: x.cand.entidade, nome: x.f.nome || null, gcId: x.cand.gcId, responsavel: x.f.responsavel || null, prioridade: x.f.prioridadeSugerida, sinais: x.f.sinais, fatos: x.f };
  const bytes = Buffer.byteLength(JSON.stringify(contexto));
  const fallback = prioridade.slice(0, 10).map(x => ({ ref: x.ref, prioridade: x.f.prioridadeSugerida, reasonCodes: x.f.sinais.filter(s => s !== 'OPORTUNIDADE_NA_FILA') }));
  return { contexto, mapa, resumoDia, fallback, bytes, truncado: !!meta.truncado, perguntaSegura };
}

function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function emLotes(itens, concorrencia, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(concorrencia, itens.length) }, async () => { while (i < itens.length) { const k = i++; out[k] = await fn(itens[k]); } })); return out; }

const CACHE = new Map();      // chave inclui uid e perfil → nunca entrega dados de um vendedor a outro
/** Carrega (com escopo) os dados brutos necessários. I/O somente leitura. */
async function carregarDados(store, acesso, agoraIso, { usarCache = true } = {}) {
  const hoje = T.diaComercial(agoraIso); const chave = `${acesso.uid}|${acesso.gestao ? 'G' : 'V'}|${hoje}`;
  const cached = CACHE.get(chave); if (usarCache && cached && Date.now() - cached.em < LIMITES.CACHE_TTL_MS) return cached.dados;
  const [wlSnap, estSnap] = await Promise.all([store.collection('fila_comercial').doc('worklist').get(), store.collection('interacoes_fila').get()]);
  const wl = wlSnap.exists ? wlSnap.data() : null; const todosEstados = estSnap.docs.map(d => d.data());
  const cand = new Map();       // gcId → candidato
  const add = (entidade, nome, opp, responsavel) => { const gc = entidade && entidade.startsWith('GC_NATIVE:') ? entidade.slice(10) : null; const k = gc || entidade; if (!entidade) return; if (!cand.has(k)) cand.set(k, { gcId: gc, entidade, nome: nome || null, opps: [], responsavel: responsavel || null }); const c = cand.get(k); if (opp) c.opps.push(opp); if (nome && !c.nome) c.nome = nome; };
  const grupos = ['novas', 'followUps', 'emAtendimento', 'pendentes'];
  const donos = acesso.gestao ? Object.entries((wl && wl.vendedores) || {}) : [[acesso.uid, ((wl && wl.vendedores) || {})[acesso.uid] || {}]];
  const rotulos = (wl && wl.vendedoresRotulos) || {};
  for (const [uid, g] of donos) for (const k of grupos) for (const it of g[k] || []) if (it && it.commercialEntityId) add(it.commercialEntityId, it.nomeCliente, { tipo: it.tipoOportunidade || null, grupo: k }, acesso.gestao ? String(rotulos[uid] || '').split(' ')[0] : null);
  if (!acesso.gestao) {
    for (const e of todosEstados) if (e && e.commercialEntityId && ((e.claimAtual && e.claimAtual.operadorId === acesso.uid) || (e.eventos || []).some(x => x && x.operadorId === acesso.uid))) add(e.commercialEntityId, e.nomeCliente, null, null);
    const cart = await store.collection('carteira_comercial').where('ownerUid', '==', acesso.uid).select('portfolioId').get();
    for (const d of cart.docs) { const pid = String(d.data().portfolioId || d.id); if (/^GC:\d+$/.test(pid)) add('GC_NATIVE:' + pid.slice(3), null, null, null); }
  }
  const cap = acesso.gestao ? LIMITES.CAP_CLIENTES_GESTAO : LIMITES.CAP_CLIENTES_VENDEDOR;
  let lista = [...cand.values()].sort((a, b) => (b.opps.length - a.opps.length) || String(a.entidade).localeCompare(String(b.entidade)));
  const truncado = lista.length > cap; lista = lista.slice(0, cap);
  // MR4_LINKED → gcId (vínculo do cadastro)
  const mr4 = lista.filter(c => !c.gcId && c.entidade.startsWith('MR4_LINKED:'));
  if (mr4.length) { const refs = await store.getAll(...mr4.map(c => store.collection('clientes').doc(c.entidade.slice(11)))); refs.forEach((s, i) => { const d = s.exists ? s.data() : null; if (d && d.gestaoClickId != null) { mr4[i].gcId = String(d.gestaoClickId); if (!mr4[i].nome) mr4[i].nome = d.nome || d.razao_social || null; } }); }
  lista = lista.filter(c => c.gcId);
  // nomes faltantes (cadastro MR4 pelo vínculo)
  const semNome = lista.filter(c => !c.nome).map(c => c.gcId);
  for (const ch of chunk(semNome, 10)) { for (const variante of [ch, ch.map(Number).filter(Number.isFinite)]) { if (!variante.length) continue; const s = await store.collection('clientes').where('gestaoClickId', 'in', variante).select('nome', 'razao_social', 'gestaoClickId').get(); for (const d of s.docs) { const x = d.data(); const c = lista.find(y => y.gcId === String(x.gestaoClickId)); if (c && !c.nome) c.nome = x.nome || x.razao_social || null; } } }
  // vendas em lote (campos mínimos; produtos só entram em memória do backend para o motor)
  const vendasPorGc = {}; let vendasAte = null;
  await emLotes(chunk(lista.map(c => c.gcId), 10), 6, async ids => {
    for (const variante of [ids, ids.map(Number).filter(Number.isFinite)]) { if (!variante.length) continue;
      const s = await store.collection('vendas_gc').where('cliente_id', 'in', variante).select(...CRM.CAMPOS_VENDA).get();
      for (const d of s.docs) { const v = d.data(); const k = String(v.cliente_id); (vendasPorGc[k] = vendasPorGc[k] || []).push(v); if (v.data && (!vendasAte || String(v.data) > vendasAte)) vendasAte = String(v.data).slice(0, 10); } }
  });
  const estadosPorEntidade = {}; for (const e of todosEstados) if (e && e.commercialEntityId) (estadosPorEntidade[e.commercialEntityId] = estadosPorEntidade[e.commercialEntityId] || []).push(e);
  const dados = { candidatos: lista, vendasPorGc, estadosPorEntidade, hoje, meta: { truncado, vendasAte, listaDoDia: wl ? wl.dataReferencia || null : null, geradoEm: agoraIso } };
  CACHE.set(chave, { em: Date.now(), dados });
  return dados;
}
function limparCache() { CACHE.clear(); }

module.exports = { VERSAO, LIMITES, FORTES, fatosDoCliente, construirContexto, carregarDados, limparCache, AI_DATA_ALLOWLIST };
