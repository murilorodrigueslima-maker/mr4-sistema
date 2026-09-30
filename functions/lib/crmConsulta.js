'use strict';
// CRM MR4 2.0 — Fase 1: callable SOMENTE LEITURA `crmConsulta` { acao: 'cliente' | 'cartoes' | 'indicadores' }.
// Não escreve em nenhuma coleção. Reutiliza: perfil360.calcularPerfil360, recorrencia, tendenciaComercial,
// priorizador (REF_FATURAMENTO_ALTO), crmTimeline. A Worklist é só LIDA (fila_comercial/worklist).
//
// Segurança (servidor, nunca só a interface):
//   • login + users.ativo + role gestor|funcionario + sistema_usuarios não bloqueado;
//   • GESTÃO = role gestor ou módulo 'fila-comercial-gestao' → vê qualquer cliente e valores em R$;
//   • VENDEDOR = módulo 'fila-comercial-operar' → só clientes do próprio escopo (worklist, reservas, histórico
//     de atendimento próprio, carteira própria) e SEM valores em R$ (regra N35.20.1 de segregação mantida).

const { HttpsError } = require('firebase-functions/v2/https');
const { calcularPerfil360 } = require('./perfil360');
const { calcularRecorrencia } = require('./recorrencia');
const { calcularTendencia } = require('./tendenciaComercial');
const { REF_FATURAMENTO_ALTO } = require('./priorizadorOportunidades');
const T = require('./crmTimeline');

const ACOES = ['cliente', 'cartoes', 'indicadores'];
const PERMITIDOS = { cliente: ['acao', 'entidade'], cartoes: ['acao', 'entidades'], indicadores: ['acao', 'vendedorUid'] };
const ENTITY_RE = /^(MR4_LINKED:[A-Za-z0-9]{6,40}|GC_NATIVE:\d{3,12})$/;
const MAX_CARTOES = 80;
const MAX_COMPRAS = 60;
const JANELA_VENDA_APOS_CONTATO_DIAS = 30;    // indicador do topo: contato até 30 dias antes da venda
const CAMPOS_VENDA = ['id', 'cliente_id', 'data', 'nome_situacao', 'valor_total', 'vendedor_id', 'nome_vendedor', 'produtos'];

class ErroCrm extends Error { constructor(tipo, codigo) { super(codigo); this.tipo = tipo; this.codigo = codigo; } }
const falha = (tipo, codigo) => { throw new ErroCrm(tipo, codigo); };

function validarPedido(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) falha('invalid-argument', 'PAYLOAD_INVALIDO');
  if (!ACOES.includes(data.acao)) falha('invalid-argument', 'ACAO_INVALIDA');
  const extras = Object.keys(data).filter(k => !PERMITIDOS[data.acao].includes(k));
  if (extras.length) falha('invalid-argument', 'CAMPOS_NAO_PERMITIDOS');
  if (data.acao === 'cliente' && !ENTITY_RE.test(String(data.entidade || ''))) falha('invalid-argument', 'ENTIDADE_INVALIDA');
  if (data.acao === 'cartoes') {
    if (!Array.isArray(data.entidades) || data.entidades.length > MAX_CARTOES || !data.entidades.every(e => ENTITY_RE.test(String(e)))) falha('invalid-argument', 'ENTIDADES_INVALIDAS');
  }
  if (data.acao === 'indicadores' && data.vendedorUid !== undefined && !/^[A-Za-z0-9_-]{6,64}$/.test(String(data.vendedorUid))) falha('invalid-argument', 'VENDEDOR_INVALIDO');
}

async function perfilDeAcesso(store, uid) {
  const [u, s] = await Promise.all([store.collection('users').doc(uid).get(), store.collection('sistema_usuarios').doc(uid).get()]);
  if (!u.exists || !s.exists) falha('permission-denied', 'SEM_PERMISSAO');
  const user = u.data(), sys = s.data();
  if (!user.ativo || !['gestor', 'funcionario'].includes(user.role) || sys.bloqueado === true) falha('permission-denied', 'SEM_PERMISSAO');
  const mods = Array.isArray(sys.modulos) ? sys.modulos : [];
  const gestao = user.role === 'gestor' || mods.includes('fila-comercial-gestao');
  const vendedor = mods.includes('fila-comercial-operar');
  if (!gestao && !vendedor) falha('permission-denied', 'SEM_PERMISSAO');
  return { uid, gestao, vendedor, nome: sys.nome || null };
}

const hojeFortaleza = iso => T.diaComercial(iso);
const somarDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ultimoOutcome = e => { const o = ((e && e.eventos) || []).filter(x => x && x.tipo === 'OUTCOME_REGISTERED'); return o.length ? o[o.length - 1] : null; };

/** Entidades que o vendedor pode abrir: worklist (qualquer dia), reservas/atendimentos próprios e carteira própria. */
async function escopoVendedor(store, uid, wl, estados) {
  const ents = new Set();
  if (wl) {
    const g = (wl.vendedores || {})[uid] || {};
    for (const k of ['novas', 'followUps', 'emAtendimento', 'pendentes']) for (const it of g[k] || []) if (it && it.commercialEntityId) ents.add(it.commercialEntityId);
    for (const a of Object.values(wl.atribuicoes || {})) if (a && a.uid === uid && a.commercialEntityId) ents.add(a.commercialEntityId);
    for (const r of Object.values(wl.pendenciasRetidas || {})) if (r && r.uid === uid && r.commercialEntityId) ents.add(r.commercialEntityId);
  }
  for (const e of estados) {
    if (!e || !e.commercialEntityId) continue;
    const tocou = (e.claimAtual && e.claimAtual.operadorId === uid) || ((e.eventos || []).some(x => x && x.operadorId === uid));
    if (tocou) ents.add(e.commercialEntityId);
  }
  return ents;
}

/** GC id da entidade (GC_NATIVE direto; MR4_LINKED pelo vínculo do cadastro). */
async function resolverCliente(store, entidade) {
  if (entidade.startsWith('GC_NATIVE:')) return { gcId: entidade.slice(10), clienteMr4Id: null, cadastro: null };
  const id = entidade.slice(11);
  const s = await store.collection('clientes').doc(id).get();
  const d = s.exists ? s.data() : null;
  return { gcId: d && d.gestaoClickId != null ? String(d.gestaoClickId) : null, clienteMr4Id: id, cadastro: d };
}

async function vendasDoCliente(store, gcId) {
  if (!gcId) return [];
  const col = store.collection('vendas_gc');
  const consultas = [col.where('cliente_id', '==', String(gcId)).select(...CAMPOS_VENDA).get()];
  if (/^\d+$/.test(gcId)) consultas.push(col.where('cliente_id', '==', Number(gcId)).select(...CAMPOS_VENDA).get());
  const snaps = await Promise.all(consultas);
  const porId = new Map();
  for (const s of snaps) for (const d of s.docs) porId.set(d.id, d.data());
  return [...porId.values()];
}

async function nomesDe(store, uids) {
  const lista = [...new Set(uids.filter(Boolean))];
  if (!lista.length) return {};
  const snaps = await store.getAll(...lista.map(u => store.collection('sistema_usuarios').doc(u)));
  const out = {};
  snaps.forEach((s, i) => { if (s.exists) out[lista[i]] = String(s.data().nome || '').split(' ')[0] || 'Vendedor'; });
  return out;
}

/** Categorias só quando a fonte é confiável (perfil gravado com catálogo; nunca "SEM_CATEGORIA"). */
function categoriasConfiaveis(perfilGravado) {
  const cats = (perfilGravado && perfilGravado.categoriasMaisCompradas) || [];
  return cats.filter(c => c && c.categoria && c.categoria !== 'SEM_CATEGORIA').slice(0, 5).map(c => ({ categoria: c.categoria, pedidos: c.quantidadePedidos ?? null }));
}

function faixaValor(faturamentoTotal) {
  return Number(faturamentoTotal) >= REF_FATURAMENTO_ALTO ? 'ALTO_VALOR' : null;   // mesma régua do priorizador
}

/**
 * Notas livres ficam em crm_notas_privadas (Rules: nenhum acesso do cliente). Busca por id determinístico (opp__índice),
 * sem query/índice, apenas dos eventos marcados meta.temNota. Autorização no servidor: gestão vê todas; vendedor só as próprias
 * (nota.operadorId === uid E evento.operadorId === uid). O texto é posto em memória no evento só para montar a resposta.
 */
async function hidratarNotasPrivadas(store, acesso, estados) {
  const pedidos = [];
  for (const e of estados) (e.eventos || []).forEach((x, i) => {
    if (x && x.tipo === 'OUTCOME_REGISTERED' && x.meta && x.meta.temNota === true && (acesso.gestao || x.operadorId === acesso.uid)) pedidos.push({ e, i });
  });
  if (!pedidos.length) return estados;
  const snaps = await store.getAll(...pedidos.map(p => store.collection('crm_notas_privadas').doc(`${p.e.opportunityInstanceId}__${p.i}`)));
  const texto = new Map();
  snaps.forEach((s, k) => {
    if (!s.exists) return;
    const n = s.data(), { e, i } = pedidos[k];
    if (n.operadorId !== e.eventos[i].operadorId || (!acesso.gestao && n.operadorId !== acesso.uid)) return;
    if (typeof n.texto === 'string' && n.texto) texto.set(k, n.texto);
  });
  const porEstado = new Map();
  pedidos.forEach((p, k) => { if (texto.has(k)) { if (!porEstado.has(p.e)) porEstado.set(p.e, new Map()); porEstado.get(p.e).set(p.i, texto.get(k)); } });
  return estados.map(e => {
    const m = porEstado.get(e); if (!m) return e;
    return { ...e, eventos: e.eventos.map((x, i) => (m.has(i) ? { ...x, meta: { ...x.meta, nota: m.get(i) } } : x)) };
  });
}

// ── ação: cliente (Cliente 360) ─────────────────────────────────────────────────────────────────────────
async function consultarCliente(store, acesso, entidade, agoraIso) {
  const hoje = hojeFortaleza(agoraIso);
  const [wlSnap, estSnap, cli] = await Promise.all([
    store.collection('fila_comercial').doc('worklist').get(),
    store.collection('interacoes_fila').where('commercialEntityId', '==', entidade).get(),
    resolverCliente(store, entidade),
  ]);
  const wl = wlSnap.exists ? wlSnap.data() : null;
  let estados = estSnap.docs.map(d => d.data());
  if (!acesso.gestao) {
    // atalho: cliente da worklist / estados do próprio cliente já decidem; só então varre interacoes_fila
    let permitido = (await escopoVendedor(store, acesso.uid, wl, estados)).has(entidade);
    if (!permitido) {
      const todos = (await store.collection('interacoes_fila').get()).docs.map(d => d.data());
      permitido = (await escopoVendedor(store, acesso.uid, wl, todos)).has(entidade);
    }
    if (!permitido && cli.gcId) {
      const cart = await store.collection('carteira_comercial').doc('GC:' + cli.gcId).get();
      permitido = cart.exists && cart.data().ownerUid === acesso.uid;
    }
    if (!permitido) falha('permission-denied', 'CLIENTE_FORA_DO_SEU_ESCOPO');
  }
  estados = await hidratarNotasPrivadas(store, acesso, estados);      // só após a checagem de escopo; só notas permitidas
  const [vendas, perfilSnap, cartSnap, histSnap] = await Promise.all([
    vendasDoCliente(store, cli.gcId),
    cli.clienteMr4Id ? store.collection('perfis_360').doc(cli.clienteMr4Id).get() : Promise.resolve(null),
    cli.gcId ? store.collection('carteira_comercial').doc('GC:' + cli.gcId).get() : Promise.resolve(null),
    cli.gcId ? store.collection('carteira_comercial_historico').where('portfolioId', '==', 'GC:' + cli.gcId).get() : Promise.resolve(null),
  ]);
  const perfilGravado = perfilSnap && perfilSnap.exists ? perfilSnap.data() : null;
  // Perfil sempre recalculado das vendas (mesmo motor do Perfil 360) → números atuais e consistentes
  const perfil = calcularPerfil360({ clienteMr4Id: cli.clienteMr4Id || cli.gcId || entidade, gestaoClickId: cli.gcId, vendas, dataReferencia: hoje });
  let recorrencia = null, tendencia = null;
  try { recorrencia = calcularRecorrencia(perfil); } catch (_) { /* sem base */ }
  try { tendencia = calcularTendencia(perfil); } catch (_) { /* sem base */ }
  const carteira = cartSnap && cartSnap.exists ? cartSnap.data() : null;
  const carteiraHistorico = histSnap ? histSnap.docs.map(d => d.data()) : [];

  // oportunidades atuais do cliente na worklist (qualquer vendedor; sem expor o que não é do vendedor além do dono)
  const oportunidades = [];
  const atribuicoes = [];
  if (wl) {
    for (const [opp, a] of Object.entries(wl.atribuicoes || {})) if (a && a.commercialEntityId === entidade) {
      atribuicoes.push({ opp, uid: a.uid, desde: a.desde || wl.dataReferencia || null, grupo: a.grupo, tipoOportunidade: a.tipoOportunidade });
    }
  }
  const uids = [...atribuicoes.map(a => a.uid), carteira && carteira.ownerUid, ...carteiraHistorico.map(h => h.ownerNovoUid),
    ...estados.flatMap(e => (e.eventos || []).map(x => x.operadorId)), ...estados.map(e => ultimoOutcome(e) && ultimoOutcome(e).operadorId)];
  const nomePorUid = await nomesDe(store, uids);
  for (const a of atribuicoes) {
    const est = estados.find(e => e.opportunityInstanceId === a.opp) || null;
    const u = ultimoOutcome(est);
    oportunidades.push({ opportunityInstanceId: a.opp, tipoOportunidade: a.tipoOportunidade, grupo: a.grupo, desde: a.desde,
      responsavel: nomePorUid[a.uid] || 'Vendedor', responsavelUid: a.uid, estado: est ? est.estado : 'DISPONIVEL',
      ultimoResultado: u ? { outcome: u.outcome, em: u.timestamp } : null, nextFollowUpAt: est ? est.nextFollowUpAt || null : null });
  }
  const followUps = estados.filter(e => e.nextFollowUpAt && e.estado !== 'CONCLUIDA').map(e => {
    const u = ultimoOutcome(e);
    return { opportunityInstanceId: e.opportunityInstanceId, data: e.nextFollowUpAt, estado: e.estado,
      situacao: e.nextFollowUpAt < hoje ? 'ATRASADO' : e.nextFollowUpAt === hoje ? 'HOJE' : 'FUTURO',
      responsavel: u ? (nomePorUid[u.operadorId] || 'Vendedor') : null, responsavelUid: u ? u.operadorId : null };
  }).sort((a, b) => (a.data < b.data ? -1 : 1));

  const podeVerValores = acesso.gestao;
  const compras = T.vendasOrdenadas(vendas, { incluirValorZero: true }).reverse().slice(0, MAX_COMPRAS).map(v => ({ data: v.data, itens: v.itens, vendedor: v.vendedorNome || null, ...(podeVerValores ? { valor: v.valor } : {}) }));
  const vac = T.vendasAposContato({ estados, vendas }).map(x => ({ relacao: x.relacao, dataVenda: x.venda.data, diasAposContato: x.diasAposContato,
    contato: { em: x.contato.em, outcome: x.contato.outcome, por: nomePorUid[x.contato.operadorId] || 'Vendedor' }, ...(podeVerValores ? { valor: x.venda.valor } : {}) })).reverse();
  const rec = T.clienteRecuperado({ estados, vendas });
  const recuperado = rec ? { status: rec.status, dataContato: rec.contato.dia, diasParadoNoContato: rec.diasParadoNoContato, ultimaCompraAntes: rec.ultimaCompraAntes,
    dataVenda: rec.venda.data, diasAteVenda: rec.diasAteVenda, vendedorVenda: rec.venda.vendedorNome || null, contatoPor: nomePorUid[rec.contato.operadorId] || 'Vendedor',
    ...(podeVerValores ? { valorVenda: rec.venda.valor } : {}) } : null;

  const resumo = {
    ultimaCompraEm: perfil.ultimaCompraEm, diasSemComprar: perfil.nuncaComprou ? null : perfil.diasSemComprar, primeiraCompraEm: perfil.primeiraCompraEm,
    pedidosTotal: perfil.pedidosTotal, pedidos30d: perfil.pedidos30d, pedidos60d: perfil.pedidos60d, pedidos90d: perfil.pedidos90d, pedidos180d: perfil.pedidos180d,
    frequenciaDias: perfil.diasEntreComprasMediana ?? null, inativo120d: !!perfil.inativo120d, nuncaComprou: !!perfil.nuncaComprou,
    recorrencia: recorrencia ? recorrencia.status || null : null, tendencia: tendencia ? tendencia.tendencia || null : null,
    faixaValor: faixaValor(perfil.faturamentoTotal),
    ...(podeVerValores ? { valores: { faturamento30d: perfil.faturamento30d, faturamento60d: perfil.faturamento60d, faturamento90d: perfil.faturamento90d,
      faturamento180d: perfil.faturamento180d, faturamentoTotal: perfil.faturamentoTotal, ticketMedio180d: perfil.ticketMedio180d, ticketMedioTotal: perfil.ticketMedioTotal } } : {}),
  };
  const cad = cli.cadastro || {};
  const telefone = cad.whatsapp || cad.telefone || cad.celular || null;
  return {
    geradoEm: agoraIso, hoje, podeVerValores,
    cliente: { entidade, gestaoClickId: cli.gcId, nome: cad.nome || cad.razao_social || (estados[0] && estados[0].nomeCliente) || (cli.gcId ? 'Cliente GC ' + cli.gcId : 'Cliente'),
      cidade: cad.cidade || null, telefone: telefone ? String(telefone) : null,
      responsavelCarteira: carteira ? (nomePorUid[carteira.ownerUid] || 'Vendedor') : null },
    resumo,
    compras,
    produtos: { maisComprados: (perfil.produtosMaisComprados || []).slice(0, 10).filter(p => p && p.nome).map(p => ({ nome: p.nome, pedidos: p.quantidadePedidos ?? null, unidades: p.quantidadeUnidades ?? null })),
      categorias: categoriasConfiaveis(perfilGravado) },
    oportunidades, followUps,
    observacoes: T.observacoes(estados, nomePorUid),
    timeline: T.montarTimeline({ estados, vendas, atribuicoes: atribuicoes.map(a => ({ desde: a.desde, uid: a.uid })), carteiraHistorico, nomePorUid, podeVerValores }),
    vendaAposContato: vac,
    recuperado,
  };
}

// ── ação: cartoes (dados extras do cartão para os clientes da própria lista) ────────────────────────────
async function consultarCartoes(store, acesso, entidades) {
  const wlSnap = await store.collection('fila_comercial').doc('worklist').get();
  const wl = wlSnap.exists ? wlSnap.data() : null;
  let permitidas = new Set(entidades);
  if (!acesso.gestao) {
    const todos = (await store.collection('interacoes_fila').get()).docs.map(d => d.data());
    const escopo = await escopoVendedor(store, acesso.uid, wl, todos);
    permitidas = new Set(entidades.filter(e => escopo.has(e)));
  }
  const mr4 = [...permitidas].filter(e => e.startsWith('MR4_LINKED:'));
  const snaps = mr4.length ? await store.getAll(...mr4.map(e => store.collection('perfis_360').doc(e.slice(11)))) : [];
  const out = {};
  snaps.forEach((s, i) => {
    if (!s.exists) return;
    const p = s.data();
    out[mr4[i]] = { categorias: categoriasConfiaveis(p).slice(0, 2).map(c => c.categoria), faixaValor: faixaValor(p.faturamentoTotal),
      frequenciaDias: p.diasEntreComprasMediana ?? null,
      ...(acesso.gestao ? { ticketMedio180d: p.ticketMedio180d ?? null, faturamento180d: p.faturamento180d ?? null } : {}) };
  });
  return { cartoes: out, podeVerValores: acesso.gestao, negadas: entidades.length - permitidas.size };
}

// ── ação: indicadores (topo da Home) ────────────────────────────────────────────────────────────────────
function nomeCasa(a, b) {   // mesma lógica de nomeMatchPainel (index.js) — casamento por nome do painel de metas
  a = String(a || '').toLowerCase().trim(); b = String(b || '').toLowerCase().trim();
  if (!a || !b) return false;
  return a === b || a.startsWith(b.split(' ')[0]) || b.startsWith(a.split(' ')[0]) || a.includes(b.split(' ')[0]);
}
async function consultarIndicadores(store, acesso, vendedorUid, agoraIso) {
  const alvo = vendedorUid && acesso.gestao ? vendedorUid : acesso.uid;
  if (vendedorUid && !acesso.gestao && vendedorUid !== acesso.uid) falha('permission-denied', 'SEM_PERMISSAO');
  const hoje = hojeFortaleza(agoraIso);
  const [estSnap, painelSnap, sysSnap] = await Promise.all([
    store.collection('interacoes_fila').get(),
    store.collection('display_metrics').doc('painel_comercial').get(),
    store.collection('sistema_usuarios').doc(alvo).get(),
  ]);
  const estados = estSnap.docs.map(d => d.data());
  let contatosHoje = 0, retornosAtrasados = 0, retornosHoje = 0;
  const contatadosRecentes = new Map();    // entidade → estados
  const inicioJanela = somarDias(hoje, -(JANELA_VENDA_APOS_CONTATO_DIAS + 7));
  for (const e of estados) {
    for (const x of e.eventos || []) {
      if (x && x.tipo === 'OUTCOME_REGISTERED' && x.operadorId === alvo && x.timestamp) {
        const dia = T.diaComercial(x.timestamp);
        if (dia === hoje) contatosHoje++;
        if (dia >= inicioJanela && T.OUTCOMES_CONTATO.includes(x.outcome)) {
          if (!contatadosRecentes.has(e.commercialEntityId)) contatadosRecentes.set(e.commercialEntityId, []);
        }
      }
    }
    const u = ultimoOutcome(e);
    if (u && u.operadorId === alvo && e.nextFollowUpAt && e.estado !== 'CONCLUIDA') {
      if (e.nextFollowUpAt < hoje) retornosAtrasados++; else if (e.nextFollowUpAt === hoje) retornosHoje++;
    }
  }
  for (const e of estados) if (contatadosRecentes.has(e.commercialEntityId)) contatadosRecentes.get(e.commercialEntityId).push(e);
  // vendas após contato nos últimos 7 dias (contato do vendedor até 30 dias antes; mesmo dia = indeterminado)
  let vendasAposContato7d = 0, indeterminadas7d = 0;
  const inicio7 = somarDias(hoje, -6);
  for (const [ent, ests] of contatadosRecentes) {
    const cli = await resolverCliente(store, ent);
    const vendas = await vendasDoCliente(store, cli.gcId);
    const proprios = ests.map(e => ({ ...e, eventos: (e.eventos || []).filter(x => x.operadorId === alvo) }));
    for (const r of T.vendasAposContato({ estados: proprios, vendas })) {
      if (r.venda.data < inicio7 || r.venda.data > hoje) continue;
      if (r.relacao === 'APOS' && r.diasAposContato <= JANELA_VENDA_APOS_CONTATO_DIAS) vendasAposContato7d++;
      else if (r.relacao === 'INDETERMINADO') indeterminadas7d++;
    }
  }
  // meta do mês: display_metrics/painel_comercial (mesmo dado do painel TV); omitida se o nome não casar com segurança
  let meta = null;
  if (painelSnap.exists && sysSnap.exists) {
    const nome = sysSnap.data().nome || '';
    const cands = (painelSnap.data().vendedores || []).filter(v => nomeCasa(v.nome, nome));
    if (cands.length === 1 && Number(cands[0].meta) > 0) meta = { meta: Number(cands[0].meta), realizado: Number(cands[0].totalMes) || 0, pct: Math.round(((Number(cands[0].totalMes) || 0) / Number(cands[0].meta)) * 100) };
  }
  return { hoje, vendedorUid: alvo, contatosHoje, retornosAtrasados, retornosHoje, vendasAposContato7d, indeterminadas7d, meta,
    podeVerValores: acesso.gestao || alvo === acesso.uid };
}

async function crmConsulta(store, { operadorUid, data, agoraIso }) {
  validarPedido(data);
  const acesso = await perfilDeAcesso(store, operadorUid);
  if (data.acao === 'cliente') return consultarCliente(store, acesso, data.entidade, agoraIso);
  if (data.acao === 'cartoes') return consultarCartoes(store, acesso, data.entidades);
  return consultarIndicadores(store, acesso, data.vendedorUid, agoraIso);
}

async function crmConsultaHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const store = opts.db || require('firebase-admin').firestore();
  const agoraIso = (opts && typeof opts.now === 'function' ? opts.now() : new Date()).toISOString();
  try { return await crmConsulta(store, { operadorUid: request.auth.uid, data: request.data, agoraIso }); }
  catch (e) { if (e instanceof ErroCrm) throw new HttpsError(e.tipo, e.codigo); throw e; }
}

module.exports = { crmConsulta, crmConsultaHandler, validarPedido, faixaValor, categoriasConfiaveis, ACOES, MAX_CARTOES, JANELA_VENDA_APOS_CONTATO_DIAS };
