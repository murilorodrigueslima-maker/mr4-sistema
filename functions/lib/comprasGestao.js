'use strict';
// COMPRAS — gestão interna (callables): parâmetros por fornecedor, situação de compras pendentes antigas e origem das compras.
//
// Tudo é informação INTERNA do MR4: nada é enviado ao GestãoClick (este módulo não faz nenhuma chamada à API) e a Política 1.2
// (sugestões, prioridade, quantidade) não lê nenhum destes documentos. Os dados exibidos vêm do que o sync já gravou no Firestore.
// Escrita só aqui (Admin SDK): gestor ativo, não bloqueado, com admin ou módulo 'estoque'; payload estrito; versão conferida;
// histórico append-only (create) e trilha em audit_log no MESMO commit.
const { HttpsError } = require('firebase-functions/v2/https');
const { exigirNaoBloqueado } = require('./usuarioOperacional');
const A = require('./auditoria');
const K = require('./compras/canonico');
const S = require('./compras/snapshot');
const C = require('./compras/confiabilidade');
const O = require('./compras/origem');
const P = require('./compras/parametrosFornecedor');
const Nomes = require('./compras/nomesFornecedores');
const Forn = require('./compras/fornecedores');
const { calcularTudo } = require('./compras/motor');
const { POLITICA_VIGENTE } = require('./compras/politica');

const COL = Object.freeze({ parametros: 'compras_fornecedor_parametros', pendencias: 'compras_pendencias_confirmacao', ...O.COL });
const STATUS_PENDENCIA = Object.freeze(['PENDENTE', 'RECEBIDA', 'DUPLICADA', 'CANCELADA', 'AGUARDANDO_CONFERENCIA']);
const EXIGE_OBSERVACAO = Object.freeze(['RECEBIDA', 'DUPLICADA', 'CANCELADA']);
const SECOES = Object.freeze(['FORNECEDORES', 'PENDENCIAS', 'ORIGEM']);
const OBS_MAX = 500, OBS_MIN = 5, HIST_MAX = 30, DIAS_SNAPSHOT = 90;
const RE_ID = /^[A-Za-z0-9_-]{1,40}$/;

const invalido = m => new HttpsError('invalid-argument', m);
const conflito = m => new HttpsError('failed-precondition', m);
const estrito = (d, chaves) => { if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !chaves.includes(k))) throw invalido('Payload inválido.'); return d; };
const idOk = v => typeof v === 'string' && RE_ID.test(v);
const versaoOk = v => Number.isInteger(v) && v >= 0 && v <= 1000000;
function observacaoDe(v, obrigatoria) {
  if (v !== undefined && v !== null && typeof v !== 'string') throw invalido('Observação inválida.');
  const t = String(v || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').trim();
  if (t.length > OBS_MAX) throw invalido(`Observação com no máximo ${OBS_MAX} caracteres.`);
  if (obrigatoria && t.length < OBS_MIN) throw invalido(`Observação obrigatória (${OBS_MIN} a ${OBS_MAX} caracteres): diga o que foi conferido.`);
  return t || null;
}
const iso = v => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
const carimbo = () => require('firebase-admin/firestore').FieldValue.serverTimestamp();

function ambiente(opts) { return { db: opts.db || require('firebase-admin').firestore(), agora: opts.now ? opts.now() : new Date() }; }

/** Gestor ativo, não bloqueado, com admin ou módulo 'estoque' (mesmo critério de quem lê custo em Compras). Fail closed. */
async function autorizar(db, request) {
  const uid = request && request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const u = await db.collection('users').doc(uid).get();
  if (!u.exists || u.data().ativo !== true || u.data().role !== 'gestor') throw new HttpsError('permission-denied', 'Acesso restrito à gestão.');
  const perfil = await exigirNaoBloqueado(db, uid);
  if (!perfil || !(perfil.admin === true || (Array.isArray(perfil.modulos) && perfil.modulos.includes('estoque')))) throw new HttpsError('permission-denied', 'Acesso restrito à gestão de Compras.');
  return { uid, type: 'USER', role: 'gestor', admin: perfil.admin === true, origin: 'CALLABLE_AUTH' };
}

// ── Leituras (somente Firestore) ────────────────────────────────────────────────────────────────────────────────
const lerDoc = async (db, c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; };
const lerColecao = async (db, c) => (await db.collection(c).get()).docs.map(d => [d.id, d.data()]);
async function lerBase(db) {
  const base = await S.carregarBase(db);
  if (!base) throw conflito('SEM_DADOS_DE_COMPRAS: aguarde a sincronização de Compras.');
  return base;
}
const nomesDe = async db => Nomes.paraApresentacao(await lerDoc(db, Forn.COLECAO, 'nomes'));
const nomeForn = (nomes, id) => (id ? (nomes[id] && nomes[id].nome) || 'Fornecedor #' + id : 'Sem fornecedor no registro');
async function catalogo(db, view = null) {
  const c = await lerDoc(db, 'painel_cache', 'produtos_catalogo');
  const m = new Map(((c && c.itens) || []).map(p => [String(p.id), { codigo: p.codigo || null, nome: p.nome || null }]));
  for (const l of (view && view.linhas) || []) if (!m.has(l.id)) m.set(l.id, { codigo: l.codigo || null, nome: l.nome || null });
  return m;
}
async function nomesDeUsuarios(db, uids) {
  const out = new Map();
  for (const uid of new Set(uids.filter(Boolean))) {
    const [u, s] = await Promise.all([lerDoc(db, 'users', uid), lerDoc(db, 'sistema_usuarios', uid)]);
    out.set(uid, (s && s.nome) || (u && (u.nome || u.email)) || 'usuário ' + uid.slice(0, 6));
  }
  return out;
}
async function historicoDe(db, col, id) {
  return (await db.collection(`${col}/${id}/historico`).get()).docs.map(d => d.data()).sort((a, b) => b.versao - a.versao).slice(0, HIST_MAX);
}
/** Entradas do motor reconstruídas do snapshot publicado (para SIMULAR, sem gravar; o dia comercial é o do snapshot). */
async function entradasDoMotor(db, base, agora) {
  const meta = await lerDoc(db, 'compras_n0', 'meta');
  const blocos = async c => (await lerColecao(db, c)).sort((a, b) => a[0].localeCompare(b[0])).flatMap(([, d]) => d.produtos || []);
  const [operacionais, custos] = [await blocos('compras_n0_produtos'), await blocos('compras_n0_custos')];
  const custo = new Map(custos.map(c => [c.product_id, c]));
  const produtos = operacionais.map(m => { const c = custo.get(m.product_id) || {};
    return { product_id: m.product_id, code: m.code || null, active: m.active, moves_stock: m.moves_stock, has_composition: !!m.kit, current_stock: m.current_stock,
      registered_cost_cents: c.registered_cost_cents ?? null, sale_price_cents: c.sale_price_cents ?? null,
      // a base operacional não guarda a data de cadastro: quando confiável, a 1ª evidência é equivalente para o motor
      created_at: m.created_at_reliable ? m.first_evidence_date : null, created_at_reliable: !!m.created_at_reliable, erp_min_stock: null }; });
  return { meta, produtos, hoje: (meta && meta.data_comercial) || K.dataComercial(agora), custoPorId: new Map(custos.map(c => [c.product_id, c.registered_cost_cents])),
    fatosVenda: base.vendas.flatMap(K.fatosDeVenda), fatosCompra: base.compras.flatMap(K.fatosDeCompra) };
}
const rodarMotor = (e, produtos, compras) => new Map(calcularTudo({ produtos, fatosVenda: e.fatosVenda, fatosCompra: compras, hoje: e.hoje, politica: POLITICA_VIGENTE }).metricas.map(m => [m.product_id, m]));
const itensDaCompra = (c, cat, custo = true) => (c.produtos || []).map(p => p.produto || p).map(i => { const d = cat.get(String(i.produto_id)) || {};
  return { produto_id: i.produto_id || null, codigo: d.codigo || null, nome: d.nome || null, quantidade: Number(i.quantidade) || 0, ...(custo ? { custo_unit_cents: K.centavos(i.valor_custo) } : {}) }; });

// ── Seção: fornecedores e parâmetros ────────────────────────────────────────────────────────────────────────────
const vencimentosDe = controle => new Map(Object.entries(controle.mapa).map(([id, e]) => [id, e.v || []]));
const importados = () => (POLITICA_VIGENTE.profitability && POLITICA_VIGENTE.profitability.cost.imported_supplier_ids) || [];
function parametrosPublicos(d, usuarios) {
  if (!d) return null;
  const { atualizadoEm, atualizadoPorUid, ...resto } = d;
  return { ...resto, atualizadoEm: iso(atualizadoEm), atualizadoPor: usuarios.get(atualizadoPorUid) || null };
}
async function secaoFornecedores(db, agora) {
  const base = await lerBase(db);
  const [nomes, cat, params, controle, meta] = [await nomesDe(db), await catalogo(db), await lerColecao(db, COL.parametros), await O.lerControle(db), await lerDoc(db, 'compras_n0', 'meta')];
  const hoje = K.dataComercial(agora), venc = vencimentosDe(controle), porId = new Map(params);
  const usuarios = await nomesDeUsuarios(db, params.map(([, d]) => d.atualizadoPorUid));
  const grupos = new Map();
  for (const c of base.compras) if (c.fornecedor_id) (grupos.get(c.fornecedor_id) || grupos.set(c.fornecedor_id, []).get(c.fornecedor_id)).push(c);
  for (const [id] of params) if (!grupos.has(id)) grupos.set(id, []);
  const produtos = {};
  const fornecedores = [...grupos].map(([id, compras]) => {
    const est = P.estimarParametros({ compras, fornecedorId: id, hoje, isoladas: controle.isoladas, vencimentos: venc, nome: (nomes[id] || {}).nome || null, importadosConfigurados: importados() });
    const p = porId.get(id) || null;
    for (const pid of [...Object.keys(est.produtos), ...Object.keys((p && p.multiplosPorProduto) || {}), ...Object.keys((p && p.qtdMinimaPorProduto) || {})]) { const d = cat.get(pid) || {}; produtos[pid] = { codigo: d.codigo || null, nome: d.nome || null }; }
    return { id, nome: nomeForn(nomes, id), interno: Forn.DEFAULTS.internal_supplier_ids.includes(id), compras: compras.length, ultima_compra: compras.map(c => K.parseData(c.data_emissao)).filter(Boolean).sort().pop() || null,
      parametros: parametrosPublicos(p, usuarios), estimativas: est };
  }).sort((a, b) => String(b.ultima_compra || '').localeCompare(String(a.ultima_compra || '')) || a.nome.localeCompare(b.nome, 'pt-BR'));
  return { dados_em: (meta && meta.ultima_sincronizacao_ok) || null, origem: { disponivel: controle.disponivel, gerado_em: controle.gerado_em }, regras: P.REGRAS, fornecedores, produtos };
}

// ── Seção: compras pendentes antigas ────────────────────────────────────────────────────────────────────────────
const EFEITO_ESTADO = Object.freeze({
  PENDENTE: 'Nenhuma mudança: a política vigente não desconta compra pendente das sugestões.',
  RECEBIDA: 'Hipótese: só muda se a mercadoria chegou e o saldo do ERP AINDA NÃO a contém (a entrada seria lançada no GestãoClick). Se o saldo já a contém, nada muda.',
  DUPLICADA: 'Nenhuma mudança nas sugestões: registro repetido não representa mercadoria a receber (corrigir no GestãoClick evita entrada em dobro).',
  CANCELADA: 'Nenhuma mudança nas sugestões: compra cancelada não traz mercadoria.',
  AGUARDANDO_CONFERENCIA: 'Nenhuma mudança: fica sinalizada até a conferência.',
});
function resumoSugestao(r, ids, custoPorId) {
  let produtos = 0, unidades = 0, capital = 0, semCusto = 0;
  for (const id of ids) { const m = r.get(id), q = m ? m.suggestion.suggested_qty : 0; if (!(q > 0)) continue; produtos++; unidades += q; const c = custoPorId.get(id); if (c > 0) capital += Math.round(q * c); else semCusto++; }
  return { produtos, unidades, capital_cents: capital, sem_custo: semCusto };
}
function impactoEstados(p, e, atual, cat) {
  const ids = [...new Set(p.itens.map(i => i.produto_id))];
  const extra = new Map(p.itens.map(i => [i.produto_id, i.quantidade]));
  const sim = rodarMotor(e, e.produtos.map(x => (extra.has(x.product_id) && x.current_stock !== null ? { ...x, current_stock: x.current_stock + extra.get(x.product_id) } : x)), e.fatosCompra.filter(f => f.purchase_id !== p.id));
  const todos = [...atual.keys()];
  const mudou = todos.filter(id => ((atual.get(id) || {}).suggestion || {}).suggested_qty !== ((sim.get(id) || {}).suggestion || {}).suggested_qty);
  const antes = resumoSugestao(atual, ids, e.custoPorId), depois = resumoSugestao(sim, ids, e.custoPorId);
  const semMudanca = { antes, depois: antes, produtos_alterados: [] };
  return Object.fromEntries(STATUS_PENDENCIA.map(s => [s, s !== 'RECEBIDA' ? { descricao: EFEITO_ESTADO[s], hipotese: false, ...semMudanca } : { descricao: EFEITO_ESTADO[s], hipotese: true, antes, depois,
    produtos_alterados: mudou.map(id => ({ produto_id: id, ...(cat.get(id) || {}), antes: atual.get(id).suggestion.suggested_qty, depois: sim.get(id) ? sim.get(id).suggestion.suggested_qty : 0 })) }]));
}
async function secaoPendencias(db, agora) {
  const base = await lerBase(db);
  const e = await entradasDoMotor(db, base, agora);
  const hoje = K.dataComercial(agora);
  const view = await lerDoc(db, 'compras_n0_view', 'sugestoes');
  const [nomes, cat, controle, confirmacoes] = [await nomesDe(db), await catalogo(db, view), await O.lerControle(db), new Map(await lerColecao(db, COL.pendencias))];
  const snaps = Object.fromEntries((await db.collection('estoque_snapshots').where('data_comercial', '>=', K.somarDias(hoje, -DIAS_SNAPSHOT)).get()).docs.map(d => [d.id, d.data()]));
  const antigas = C.listarPendentes(base.compras, hoje).filter(p => p.precisa_confirmacao);
  const mov = C.indexarMovimentosProduto(base.vendas, base.compras);
  const saldos = Object.fromEntries(e.produtos.map(p => [p.product_id, p.current_stock]));
  const atual = rodarMotor(e, e.produtos, e.fatosCompra);
  const historicos = new Map();
  for (const id of confirmacoes.keys()) historicos.set(id, await historicoDe(db, COL.pendencias, id));
  const usuarios = await nomesDeUsuarios(db, [...historicos.values()].flat().map(h => h.atualizadoPorUid));
  const registro = id => { const d = confirmacoes.get(id); if (!d) return { confirmacao: null, historico: [] };
    const h = (historicos.get(id) || []).map(x => ({ versao: x.versao, status: x.status, observacao: x.observacao, quem: usuarios.get(x.atualizadoPorUid) || null, quando: iso(x.atualizadoEm) }));
    return { confirmacao: { status: d.status, observacao: d.observacao, versao: d.versao, quem: usuarios.get(d.atualizadoPorUid) || (h[0] && h[0].quem) || null, quando: iso(d.atualizadoEm) }, historico: h }; };
  const compras = antigas.map(p => {
    const bruta = base.compras.find(c => c.id === p.id), ent = controle.mapa[p.id] || null;
    const ind = C.indiciosRecebimento({ pendente: p, compras: base.compras, movimentos: mov, saldos, snapshots: snaps });
    const evid = new Map(ind.itens.map(i => [i.produto_id, i]));
    return { id: p.id, numero: ent ? ent.n : null, data_emissao: p.data_emissao, idade_dias: p.idade_dias, situacao_erp: p.situacao, modificado_em: p.modificado_em, fornecedor_id: p.fornecedor_id, fornecedor: nomeForn(nomes, p.fornecedor_id),
      unidades: p.unidades, valor_cents: p.valor_cents,
      itens: itensDaCompra(bruta, cat).map(i => { const x = evid.get(String(i.produto_id)); return { ...i, ...(x ? { saldo: x.saldo, vendido_desde: x.vendido_desde, confirmado_desde: x.confirmado_desde, compras_posteriores: x.compras_confirmadas_posteriores, sobra_saldo: x.residuo_vida, dias_com_entrada: x.dias_com_entrada_vista } : {}) }; }),
      evidencias: { veredito: ind.veredito, explicacao: ind.explicacao, compras_gemeas: ind.compras_gemeas.map(id => ({ id, numero: controle.mapa[id] ? controle.mapa[id].n : null })), itens_com_sobra: ind.itens_com_sobra, itens_total: ind.itens_total,
        titulos: ent ? { vinculados: ent.t, pagos: ent.p, soma_cents: ent.s } : null },
      origem: ent ? O.efetivo(ent.a, ent.m) : null,
      impacto: impactoEstados(p, e, atual, cat), ...registro(p.id) };
  });
  const ativos = new Set(antigas.map(p => p.id));
  const encerradas = [...confirmacoes.keys()].filter(id => !ativos.has(id)).map(id => { const c = base.compras.find(x => x.id === id);
    return { id, numero: controle.mapa[id] ? controle.mapa[id].n : null, situacao_erp: c ? c.nome_situacao : 'não encontrada na base', ...registro(id) }; });
  return { dados_em: (e.meta && e.meta.ultima_sincronizacao_ok) || null, idade_max_dias: C.REGRA_PENDENTE.idade_max_dias, status_possiveis: STATUS_PENDENCIA, origem: { disponivel: controle.disponivel, gerado_em: controle.gerado_em }, compras, fora_da_lista: encerradas };
}

// ── Seção: origem ───────────────────────────────────────────────────────────────────────────────────────────────
/** Efeito HIPOTÉTICO se a política vigente ignorasse as compras confirmadas isoladas. Nada é aplicado. */
function impactoNaVigente(e, isoladas) {
  const a = rodarMotor(e, e.produtos, e.fatosCompra), b = rodarMotor(e, e.produtos, O.isolarCompras(e.fatosCompra, isoladas));
  const dif = f => [...a.keys()].filter(id => f(a.get(id)) !== f(b.get(id))).length;
  return { quantidade_sugerida: dif(m => m.suggestion.suggested_qty), ultimo_fornecedor: dif(m => m.last_supplier), primeira_evidencia: dif(m => m.first_evidence_date), confianca_do_custo: dif(m => m.cost_confidence) };
}
async function secaoOrigem(db, agora) {
  const controle = await O.lerControle(db);
  if (!controle.disponivel) return { disponivel: false, compras: [] };
  const base = await lerBase(db);
  const e = await entradasDoMotor(db, base, agora);
  const view = await lerDoc(db, 'compras_n0_view', 'sugestoes');
  const [nomes, cat, confirmacoes] = [await nomesDe(db), await catalogo(db, view), new Map(await lerColecao(db, COL.confirmacao))];
  const ids = Object.entries(controle.mapa).filter(([id, x]) => controle.isoladas.has(id) || x.m).map(([id]) => id);
  const historicos = new Map();
  for (const id of confirmacoes.keys()) historicos.set(id, await historicoDe(db, COL.confirmacao, id));
  const usuarios = await nomesDeUsuarios(db, [...historicos.values()].flat().map(h => h.atualizadoPorUid));
  const porId = new Map(base.compras.map(c => [c.id, c]));
  const compras = ids.map(id => {
    const x = controle.mapa[id], c = porId.get(id), conf = confirmacoes.get(id) || null;
    return { id, numero: x.n, fornecedor_id: x.f, fornecedor: nomeForn(nomes, x.f), presente_na_base: !!c, data_emissao: c ? K.parseData(c.data_emissao) : null, situacao_erp: c ? c.nome_situacao : null,
      // unidades incluem item sem produto cadastrado
      unidades: c ? (c.produtos || []).reduce((s, i) => s + Math.max(0, Number((i.produto || i).quantidade) || 0), 0) : null,
      valor_cents: c ? C.valorCompraCents(c) : null, itens: c ? itensDaCompra(c, cat) : [],
      nivel_automatico: x.a, ...O.efetivo(x.a, x.m), titulos: { vinculados: x.t, pagos: x.p, soma_cents: x.s, conflitos: x.x }, versao: conf ? conf.versao : 0,
      historico: (historicos.get(id) || []).map(h => ({ versao: h.versao, decisao: h.decisao, observacao: h.observacao, quem: usuarios.get(h.atualizadoPorUid) || null, quando: iso(h.atualizadoEm) })) };
  }).sort((a, b) => (a.usar_em_decisao_automatica - b.usar_em_decisao_automatica) || String(b.data_emissao || '').localeCompare(String(a.data_emissao || '')));
  const confirmadasIsoladas = new Set([...controle.isoladas].filter(id => porId.has(id) && K.situacaoCompra(porId.get(id).nome_situacao) === 'CONFIRMADA'));
  return { disponivel: true, gerado_em: controle.gerado_em, resumo: controle.resumo, criterio: O.CRITERIO, loja: require('./lojaAtiva').LOJA_ATIVA_ID, compras,
    politica_vigente: { versao: POLITICA_VIGENTE.policy_version, confirmadas_isoladas: confirmadasIsoladas.size, impacto_se_ignorasse: impactoNaVigente(e, confirmadasIsoladas) } };
}

async function dadosHandler(request, opts = {}) {
  const { db, agora } = ambiente(opts);
  await autorizar(db, request);
  const d = estrito(request.data, ['secao']);
  if (!SECOES.includes(d.secao)) throw invalido('Seção inválida.');
  if (d.secao === 'FORNECEDORES') return secaoFornecedores(db, agora);
  if (d.secao === 'PENDENCIAS') return secaoPendencias(db, agora);
  return secaoOrigem(db, agora);
}

// ── Escrita ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Histórico (create: nunca sobrescreve) + auditoria, dentro da transação da mudança. */
function registrar(tx, db, { col, id, versao, doc, ator, action, entityType, source, before, after, metadata }) {
  tx.create(db.collection(`${col}/${id}/historico`).doc(String(versao).padStart(7, '0')), doc);
  tx.create(db.collection(A.COLECAO).doc(`${col}_${id}_v${versao}`), { ...A.evento({ ator, action, category: A.CATEGORIAS.PURCHASING, entityType, entityId: id, source, before, after, metadata }), at: carimbo() });
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ordenado = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordenado(v[k])])) : v);
const CAMPOS_DOC = [...P.ESCALARES, ...Object.keys(P.MAPAS), 'fontes', 'fontesPorProduto'];
const retrato = d => ordenado(Object.fromEntries(CAMPOS_DOC.map(k => [k, d && d[k] !== undefined ? d[k] : null])));

async function salvarParametrosHandler(request, opts = {}) {
  const { db, agora } = ambiente(opts);
  const ator = await autorizar(db, request);
  const d = estrito(request.data, ['fornecedorId', 'valores', 'fontes', 'fontesPorProduto', 'versaoAnterior']);
  if (typeof d.fornecedorId !== 'string' || !/^\d{1,20}$/.test(d.fornecedorId)) throw invalido('Fornecedor inválido.');
  if (!versaoOk(d.versaoAnterior)) throw invalido('versaoAnterior obrigatória.');
  const { erros, doc } = P.validarParametros(d.valores, d.fontes, d.fontesPorProduto);
  if (erros.length) throw invalido(erros.slice(0, 8).join(' | '));
  const id = d.fornecedorId;
  const nomes = await nomesDe(db);
  const temEstimado = [...Object.values(doc.fontes), ...Object.values(doc.fontesPorProduto).flatMap(Object.values)].includes('ESTIMADO');
  let base = null;
  if (!nomes[id] || temEstimado) base = await lerBase(db);
  if (!nomes[id] && !base.compras.some(c => c.fornecedor_id === id)) throw new HttpsError('not-found', 'Fornecedor desconhecido.');
  const ref = db.collection(COL.parametros).doc(id);
  const previo = await ref.get();
  if (temEstimado) {
    // um valor ESTIMADO que já estava gravado continua válido; um novo precisa bater com a sugestão calculada agora
    const controle = await O.lerControle(db);
    const est = P.estimarParametros({ compras: base.compras, fornecedorId: id, hoje: K.dataComercial(agora), isoladas: controle.isoladas, vencimentos: vencimentosDe(controle), nome: (nomes[id] || {}).nome || null, importadosConfigurados: importados() });
    const antes = previo.exists ? previo.data() : null;
    const fora = P.conferirEstimados(doc, est).filter(k => {
      const m = k.match(/^(\w+)\[(.+)\]$/);
      if (!antes) return true;
      if (m) return !(((antes.fontesPorProduto || {})[m[1]] || {})[m[2]] === 'ESTIMADO' && (antes[m[1]] || {})[m[2]] === doc[m[1]][m[2]]);
      return !((antes.fontes || {})[k] === 'ESTIMADO' && antes[k] === doc[k]);
    });
    if (fora.length) throw conflito('SUGESTAO_MUDOU: recarregue e aceite a sugestão atual ou informe como MANUAL (' + fora.slice(0, 5).join(', ') + ').');
  }
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const antes = s.exists ? s.data() : null, versaoAtual = antes ? antes.versao || 0 : 0;
    if (antes && antes.atualizadoPorUid === ator.uid && igual(retrato(antes), retrato(doc))) return { ok: true, repetido: true, versao: versaoAtual };
    if (versaoAtual !== d.versaoAnterior) throw conflito('VERSAO_DESATUALIZADA: outra alteração foi gravada; recarregue.');
    const versao = versaoAtual + 1;
    const novo = { fornecedorId: id, ...doc, versao, atualizadoPorUid: ator.uid, atualizadoEm: carimbo() };
    tx.set(ref, novo);
    registrar(tx, db, { col: COL.parametros, id, versao, doc: novo, ator, action: 'SUPPLIER_PARAMS_SAVED', entityType: 'supplier_params', source: 'callable:gestaoComprasParametrosSalvar', before: antes ? retrato(antes) : null, after: retrato(doc), metadata: { versao } });
    return { ok: true, repetido: false, versao };
  });
}

async function confirmarPendenciaHandler(request, opts = {}) {
  const { db, agora } = ambiente(opts);
  const ator = await autorizar(db, request);
  const d = estrito(request.data, ['compraId', 'status', 'observacao', 'versaoAnterior']);
  if (!idOk(d.compraId)) throw invalido('Compra inválida.');
  if (!STATUS_PENDENCIA.includes(d.status)) throw invalido('Situação inválida.');
  if (!versaoOk(d.versaoAnterior)) throw invalido('versaoAnterior obrigatória.');
  const observacao = observacaoDe(d.observacao, EXIGE_OBSERVACAO.includes(d.status));
  const base = await lerBase(db);
  if (!base.compras.some(c => c.id === d.compraId)) throw new HttpsError('not-found', 'Compra não encontrada.');
  const p = C.listarPendentes(base.compras, K.dataComercial(agora)).find(x => x.id === d.compraId);
  if (!p || !p.precisa_confirmacao) throw conflito('COMPRA_NAO_E_PENDENTE_ANTIGA: no ERP ela não está pendente há mais de 90 dias.');
  const ref = db.collection(COL.pendencias).doc(d.compraId);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const antes = s.exists ? s.data() : null, versaoAtual = antes ? antes.versao : 0;
    if (antes && antes.atualizadoPorUid === ator.uid && antes.status === d.status && antes.observacao === observacao) return { ok: true, repetido: true, versao: versaoAtual };
    if (versaoAtual !== d.versaoAnterior) throw conflito('VERSAO_DESATUALIZADA: outra alteração foi gravada; recarregue.');
    const versao = versaoAtual + 1;
    const novo = { compraId: d.compraId, status: d.status, observacao, versao, atualizadoPorUid: ator.uid, atualizadoEm: carimbo(),
      // retrato do ERP no momento da decisão (evidência; o ERP não é alterado)
      situacaoErp: p.situacao, idadeDias: p.idade_dias, unidades: p.unidades, valorCents: p.valor_cents };
    tx.set(ref, novo);
    registrar(tx, db, { col: COL.pendencias, id: d.compraId, versao, doc: novo, ator, action: 'PENDING_PURCHASE_STATUS_SET', entityType: 'purchase', source: 'callable:gestaoComprasPendenciaConfirmar',
      before: antes ? { status: antes.status } : null, after: { status: d.status }, metadata: { versao, temObservacao: !!observacao } });
    return { ok: true, repetido: false, versao };
  });
}

async function confirmarOrigemHandler(request, opts = {}) {
  const { db, agora } = ambiente(opts);
  const ator = await autorizar(db, request);
  const d = estrito(request.data, ['compraId', 'decisao', 'observacao', 'versaoAnterior']);
  if (!idOk(d.compraId)) throw invalido('Compra inválida.');
  if (!O.DECISOES_ORIGEM.includes(d.decisao)) throw invalido('Decisão inválida.');
  if (!versaoOk(d.versaoAnterior)) throw invalido('versaoAnterior obrigatória.');
  const observacao = observacaoDe(d.observacao, d.decisao !== 'VOLTAR_AUTOMATICO');
  const decisao = d.decisao === 'VOLTAR_AUTOMATICO' ? null : d.decisao;
  const refC = db.collection(COL.controle).doc('atual'), ref = db.collection(COL.confirmacao).doc(d.compraId);
  return db.runTransaction(async tx => {
    const [sc, s] = [await tx.get(refC), await tx.get(ref)];
    const controle = O.interpretarControle(sc.exists ? sc.data() : null);
    if (!controle.disponivel) throw conflito('ORIGEM_NAO_CLASSIFICADA: aguarde a sincronização financeira.');
    const atual = controle.mapa[d.compraId];
    if (!atual) throw new HttpsError('not-found', 'Compra sem classificação de origem.');
    const antes = s.exists ? s.data() : null, versaoAtual = antes ? antes.versao : 0;
    if (antes && antes.atualizadoPorUid === ator.uid && antes.decisao === decisao && antes.observacao === observacao && atual.m === decisao) return { ok: true, repetido: true, versao: versaoAtual, ...O.efetivo(atual.a, atual.m) };
    if (versaoAtual !== d.versaoAnterior) throw conflito('VERSAO_DESATUALIZADA: outra alteração foi gravada; recarregue.');
    if (decisao && atual.a === 'COMPROVADA_TITULO') throw conflito('COMPRA_JA_COMPROVADA_POR_TITULO');
    if (!decisao && !atual.m) throw conflito('SEM_CONFIRMACAO_MANUAL_PARA_DESFAZER');
    const versao = versaoAtual + 1;
    const novo = { compraId: d.compraId, decisao, observacao, versao, atualizadoPorUid: ator.uid, atualizadoEm: carimbo(), nivelAutomaticoNaDecisao: atual.a };
    const mapa = { ...controle.mapa, [d.compraId]: { ...atual, m: decisao } };
    const bruto = sc.data();
    tx.set(ref, novo);
    tx.set(db.collection(COL.origem).doc(d.compraId), O.docOrigem(d.compraId, mapa[d.compraId], agora, decisao ? { observacao, atualizadoPorUid: ator.uid, atualizadoEm: agora } : null));
    tx.set(refC, O.docControle(mapa, { run_id: bruto.run_id || null, geracao_financeiro: bruto.geracao_financeiro || null, titulos: bruto.titulos || null }, new Date(bruto.gerado_em)));
    registrar(tx, db, { col: COL.confirmacao, id: d.compraId, versao, doc: novo, ator, action: 'PURCHASE_ORIGIN_DECISION', entityType: 'purchase', source: 'callable:gestaoComprasOrigemConfirmar',
      before: O.efetivo(atual.a, atual.m), after: O.efetivo(atual.a, decisao), metadata: { versao, decisao: d.decisao, temObservacao: !!observacao } });
    return { ok: true, repetido: false, versao, ...O.efetivo(atual.a, decisao) };
  });
}

module.exports = { COL, STATUS_PENDENCIA, SECOES, DECISOES_ORIGEM: O.DECISOES_ORIGEM, autorizar, dadosHandler, salvarParametrosHandler, confirmarPendenciaHandler, confirmarOrigemHandler };
