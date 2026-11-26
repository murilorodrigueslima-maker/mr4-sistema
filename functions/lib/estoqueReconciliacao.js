'use strict';
// RECONCILIAÇÃO GestãoClick × MR4 Gestão — lógica SOMENTE LEITURA (ponto de entrada: scripts/reconciliar-estoque.js).
//
// Garantias:
//   • GestãoClick: só GET pela camada gcHttp; loja fixa 262759; pausa entre chamadas; ORÇAMENTO máximo de requisições.
//   • Firestore: só leitura (o acesso passa por um invólucro que não tem set/update/delete/batch).
//   • Saída: linhas "RECON_<SEÇÃO> {json}" só com agregados e IDs/códigos de produto (sem nomes de clientes/fornecedores/documentos).
//   • Nunca emite credencial, corpo de resposta ou mensagem de exceção (só códigos).
// "Estoque registrado" (GestãoClick ou MR4) NÃO é estoque físico conferido: use a lista RECON_CONTAGEM_FISICA.
const crypto = require('crypto');
const gcHttp = require('./gcHttp');
const C = require('./compras/canonico');
const S = require('./compras/snapshot');
const H = require('./compras/historico');

const LOJA = gcHttp.LOJA_ATIVA_ID;
const ITENS_POR_LINHA = 25;
const EPS = 1e-9;
const RE_CAMPO_SUSPEITO = /reserv|dispon|transit|tr[aâ]nsito|minim|m[ií]nim|maxim|pendent|futur|caminho|alocad|bloquead|comprometid|empenh|deposit/i;
const PADRAO = Object.freeze({ maxRequisicoes: 80, diasVendas: 30, diasCompras: 90, pausaMs: 600, maxItens: 100, amostraContagem: 60, ignorarTrava: false });
const FAIXAS = Object.freeze({ maxRequisicoes: [5, 200], diasVendas: [1, 120], diasCompras: [1, 400], pausaMs: [300, 5000], maxItens: [10, 500], amostraContagem: [10, 150] });
const NOMES = Object.freeze({ 'max-requisicoes': 'maxRequisicoes', 'dias-vendas': 'diasVendas', 'dias-compras': 'diasCompras', 'pausa-ms': 'pausaMs', 'max-itens': 'maxItens', 'amostra-contagem': 'amostraContagem' });

const erro = codigo => Object.assign(new Error(codigo), { codigo });
function codigoSeguro(e) {
  if (e && typeof e.codigo === 'string' && /^[A-Z0-9_]{3,60}$/.test(e.codigo)) return e.codigo;
  if (e && e.code !== undefined && /^[A-Za-z0-9_]{1,40}$/.test(String(e.code))) return 'ERRO_' + String(e.code).toUpperCase();
  return 'ERRO_INESPERADO';
}

function lerOpcoes(argv = []) {
  const o = { ...PADRAO };
  for (const a of argv) {
    if (a === '--ignorar-trava') { o.ignorarTrava = true; continue; }
    const m = /^--([a-z-]+)=(\d+)$/.exec(a), chave = m && NOMES[m[1]];
    if (!chave) throw erro('ARGUMENTO_INVALIDO');
    const v = Number(m[2]), [min, max] = FAIXAS[chave];
    if (v < min || v > max) throw erro('ARGUMENTO_FORA_DA_FAIXA');
    o[chave] = v;
  }
  return o;
}

/** Invólucro que só expõe leitura de documento por id. Qualquer tentativa de escrita falha por não existir o método. */
function somenteLeitura(db, contador = { leituras: 0 }) {
  return { collection: c => ({ doc: id => ({ get: () => { contador.leituras++; return db.collection(c).doc(id).get(); } }) }) };
}

/** Leitor do GestãoClick com orçamento: toda requisição (inclusive repetição) é contada ANTES de sair. */
function criarLeitorGc({ transporte, credenciais, maxRequisicoes, pausaMs, dormir }) {
  const uso = { usadas: 0, esgotado: false, por_recurso: {} };
  const contado = (url, o) => {
    if (uso.usadas >= maxRequisicoes) { uso.esgotado = true; return Promise.reject(erro('RECON_ORCAMENTO_ESGOTADO')); }
    uso.usadas++;
    const recurso = new URL(url).pathname.split('/')[1];
    uso.por_recurso[recurso] = (uso.por_recurso[recurso] || 0) + 1;
    return transporte(url, o);
  };
  const cliente = gcHttp.criarCliente({ transporte: contado, credenciais, pausaMs, ...(dormir ? { dormir } : {}) });
  async function get(caminho, params, opcoes) {
    if (uso.usadas >= maxRequisicoes) { uso.esgotado = true; throw erro('RECON_ORCAMENTO_ESGOTADO'); }
    try { return await cliente.get(caminho, { ...params, loja_id: LOJA }, opcoes); }
    catch (e) { if (uso.esgotado) throw erro('RECON_ORCAMENTO_ESGOTADO'); throw e; }
  }
  /** Lista COMPLETA ou erro; se o total de páginas não cabe no que resta do orçamento, aborta após a 1ª página. */
  const lista = (caminho, params, opcoes = {}) => gcHttp.paginarCompleto({ get }, caminho, params, { limite: 100, maxPaginas: Math.max(1, maxRequisicoes - uso.usadas), ...opcoes });
  return { get, lista, uso, estatisticas: () => cliente.estatisticas() };
}

// ── Leitura do MR4 Gestão ───────────────────────────────────────────────────────────────────────────────────────────
async function lerMr4(db, agora) {
  const ler = async (c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; };
  const resumo = await ler('compras_n0', 'resumo');
  if (!resumo || !resumo.blocos) throw erro('MR4_SEM_SNAPSHOT');
  const operacional = [], custos = [], avisos = [];
  for (let i = 0; i < resumo.blocos; i++) {
    const id = 'bloco_' + String(i).padStart(3, '0');
    const [p, k] = [await ler('compras_n0_produtos', id), await ler('compras_n0_custos', id)];
    if (!p) throw erro('MR4_BLOCO_AUSENTE');
    if (p.gerado_em !== resumo.gerado_em) avisos.push('MR4_LEITURA_DURANTE_SINCRONIZACAO');
    operacional.push(...p.produtos); custos.push(...((k && k.produtos) || []));
  }
  const base = await S.carregarBase(db);
  if (!base) throw erro('MR4_BASE_AUSENTE');
  const hoje = C.dataComercial(agora);
  const snapshots = [];
  for (let n = 8; n >= 0; n--) { const dia = C.somarDias(hoje, -n), d = await ler('estoque_snapshots', dia); if (d) snapshots.push({ dia, doc: d }); }
  const painel = await ler('painel_cache', 'estoque');
  return { resumo, operacional, custos, base, snapshots, painel, avisos: [...new Set(avisos)] };
}

async function travaEmUso(db, agora) {
  const ler = async (c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; };
  const job = await ler('gc_sync_lock', 'sync-dados'), compras = await ler('compras_n0', 'lock');
  const em = [];
  if (job && Number(job.expiraEm) > agora.getTime()) em.push('SYNC_GERAL');
  if (compras && Date.parse(compras.expires_at) > agora.getTime()) em.push('SYNC_COMPRAS');
  return em;
}

// ── Comparações (puras) ─────────────────────────────────────────────────────────────────────────────────────────────
/** "YYYY-MM-DD HH:MM:SS" no fuso comercial (formato do modificado_em do GestãoClick). */
function localDe(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: C.TZ_COMERCIAL, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const somar = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
const r3 = x => Math.round(x * 1000) / 1000;
const porId = xs => new Map(xs.map(x => [String(x.id), x]));
const contar = (xs, f) => xs.reduce((o, x) => { const k = String(f(x)).slice(0, 40); o[k] = (o[k] || 0) + 1; return o; }, {});

function unidadesVenda(v) {
  const m = new Map();
  if (v) for (const f of C.fatosDeVenda(v)) if (f.counts_as_demand && f.product_id && f.qty > 0) somar(m, f.product_id, f.qty);
  return m;
}
function itensCompra(c) {
  return ((c && c.produtos) || []).map(p => p.produto || p).filter(it => it.produto_id != null && Number(it.quantidade) > 0).map(it => [String(it.produto_id), Number(it.quantidade)]);
}
function unidadesCompra(c, situacao = 'CONFIRMADA') {
  const m = new Map();
  if (c && C.situacaoCompra(c.nome_situacao) === situacao) for (const [id, q] of itensCompra(c)) somar(m, id, q);
  return m;
}

/** Efeito no saldo das alterações POSTERIORES à leitura do MR4: (versão atual no GC) − (versão que o MR4 conhecia). */
function efeitoPosterior({ vendasGc, comprasGc, base, refLocal }) {
  const efeito = new Map(), tocados = new Set();
  const aplicar = (registros, antigos, unidades, sinal) => {
    for (const r of registros) {
      if (!(String(r.modificado_em || '') > refLocal)) continue;
      const velho = antigos.get(String(r.id));
      const novo = unidades(r), ant = unidades(velho);
      for (const p of [...(r.produtos || []), ...((velho && velho.produtos) || [])]) { const it = p.produto || p; if (it.produto_id != null) tocados.add(String(it.produto_id)); }
      for (const id of new Set([...novo.keys(), ...ant.keys()])) somar(efeito, id, sinal * ((novo.get(id) || 0) - (ant.get(id) || 0)));
    }
  };
  aplicar(vendasGc || [], porId(base.vendas), unidadesVenda, -1);
  aplicar(comprasGc || [], porId(base.compras), unidadesCompra, +1);
  return { efeito, tocados };
}

function compararQuantidade(gc, mr4, mov) {
  const itens = [];
  for (const [id, g] of gc) {
    const m = mr4.get(id);
    if (!m) continue;
    const a = g.current_stock, b = m.raw_stock;
    if (a === b) continue;
    const dif = a === null || b === null ? null : r3(a - b);
    let classe = 'SEM_EXPLICACAO';
    if (dif === null) classe = 'SALDO_ILEGIVEL';
    else if (mov.tocados.has(id)) classe = Math.abs(dif - (mov.efeito.get(id) || 0)) < EPS ? 'EXPLICADA_POR_MOVIMENTO_POSTERIOR' : 'MOVIMENTO_POSTERIOR_NAO_FECHA';
    itens.push({ id, codigo: g.code, abc: m.abc_revenue || null, gc: a, mr4: b, dif, classe });
  }
  const peso = x => (x.classe === 'EXPLICADA_POR_MOVIMENTO_POSTERIOR' ? 1 : 0);
  return itens.sort((a, b) => peso(a) - peso(b) || String(a.abc).localeCompare(String(b.abc)) || Math.abs(b.dif || 0) - Math.abs(a.dif || 0) || a.id.localeCompare(b.id));
}

/** Compara unidades por produto de dois conjuntos de registros já restritos ao mesmo período. */
function compararMovimento({ gc, mr4, unidades, refLocal, codigoDe }) {
  const total = regs => { const m = new Map(); for (const r of regs) for (const [id, q] of unidades(r)) somar(m, id, q); return m; };
  const a = total(gc), b = total(mr4), mgc = porId(gc), mm = porId(mr4);
  const soGc = [...mgc.keys()].filter(i => !mm.has(i)), soMr4 = [...mm.keys()].filter(i => !mgc.has(i));
  const posterior = new Set();
  for (const r of gc) if (String(r.modificado_em || '') > refLocal) for (const p of r.produtos || []) posterior.add(String((p.produto || p).produto_id));
  const itens = [...new Set([...a.keys(), ...b.keys()])].filter(id => Math.abs((a.get(id) || 0) - (b.get(id) || 0)) > EPS)
    .map(id => ({ id, codigo: codigoDe(id), gc: r3(a.get(id) || 0), mr4: r3(b.get(id) || 0), dif: r3((a.get(id) || 0) - (b.get(id) || 0)), alterado_apos_mr4: posterior.has(id) }))
    .sort((x, y) => Number(x.alterado_apos_mr4) - Number(y.alterado_apos_mr4) || Math.abs(y.dif) - Math.abs(x.dif) || x.id.localeCompare(y.id));
  const soma = m => r3([...m.values()].reduce((s, x) => s + x, 0));
  return {
    resumo: { registros_gc: mgc.size, registros_mr4: mm.size, so_no_gc: soGc.length, so_no_gc_alterados_apos_mr4: soGc.filter(i => String(mgc.get(i).modificado_em || '') > refLocal).length, so_no_mr4: soMr4.length,
      unidades_gc: soma(a), unidades_mr4: soma(b), produtos_comparados: new Set([...a.keys(), ...b.keys()]).size, produtos_divergentes: itens.length, divergentes_sem_alteracao_posterior: itens.filter(i => !i.alterado_apos_mr4).length },
    itens,
  };
}

function ultimasDatas(vendas, compras) {
  const venda = new Map(), entrada = new Map(), guardar = (m, id, d) => { if (d && (!m.get(id) || m.get(id) < d)) m.set(id, d); };
  for (const v of vendas) for (const f of C.fatosDeVenda(v)) if (f.counts_as_demand && f.product_id && f.qty > 0) guardar(venda, f.product_id, f.date);
  for (const c of compras) for (const id of unidadesCompra(c).keys()) guardar(entrada, id, C.parseData(c.modificado_em) || C.parseData(c.data_emissao));
  return { venda, entrada };
}

function semMovimentacao({ gc, mr4, vendas, compras, hoje }) {
  const { venda, entrada } = ultimasDatas(vendas.filter(v => String(v.data || '') <= hoje), compras);
  const itens = [];
  for (const [id, g] of gc) {
    if (!(g.current_stock > 0)) continue;
    const uv = venda.get(id) || null, ue = entrada.get(id) || null;
    const dias = uv ? C.diffDias(uv, hoje) : null;
    if (dias !== null && dias < 90) continue;                      // mesma fronteira do motor: venda com data > hoje − 90 conta
    itens.push({ id, codigo: g.code, abc: (mr4.get(id) || {}).abc_revenue || null, saldo: g.current_stock, dias_sem_venda: dias, nunca_vendido: uv === null, entrada_90d: !!ue && C.diffDias(ue, hoje) < 90, capital: g.registered_cost_cents > 0 ? Math.round(g.current_stock * g.registered_cost_cents) : 0 });
  }
  itens.sort((a, b) => b.capital - a.capital || a.id.localeCompare(b.id));
  const grupo = f => { const x = itens.filter(f); return { produtos: x.length, unidades: r3(x.reduce((s, i) => s + i.saldo, 0)), capital_custo_cadastrado_cents: x.reduce((s, i) => s + i.capital, 0) }; };
  return {
    resumo: { criterio: 'saldo registrado no GC > 0 e nenhuma venda nos últimos 90 dias (histórico do MR4 + leitura atual do GC)', sem_venda_90d: grupo(() => true), sem_venda_180d: grupo(i => i.nunca_vendido || i.dias_sem_venda >= 180), sem_venda_365d: grupo(i => i.nunca_vendido || i.dias_sem_venda >= 365), nunca_vendido: grupo(i => i.nunca_vendido), sem_venda_e_sem_entrada_90d: grupo(i => !i.entrada_90d) },
    itens: itens.map(({ capital, ...i }) => i),                              // ordenados por capital; valor por produto não é impresso
  };
}

/** Variação de saldo não explicada nos últimos snapshots (pares de dias consecutivos). */
function residuosRecentes(snapshots, base) {
  const movimentos = H.indexarMovimentos(base), total = new Map();
  let pares = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1], b = snapshots[i];
    if (C.somarDias(a.dia, 1) !== b.dia || i === snapshots.length - 1) continue;   // o dia mais recente pode estar aberto
    pares++;
    const f = H.calcularFluxoDoDia({ dia: b.dia, doc: b.doc, anterior: a.doc, movimentos, origem: 'RECONCILIACAO', consolidadoEm: null });
    for (const [id, v] of Object.entries(JSON.parse(f.fluxo_json).aj)) somar(total, id, Math.abs(v));
  }
  return { pares, itens: [...total].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, un]) => ({ id, un: r3(un) })) };
}

/** Lista de contagem física: divergentes, negativos, A suspeitos/valiosos, variação não explicada e amostra A (sorteio reprodutível). */
function listaContagem({ gc, mr4, divergencias, residuos, semente, tamanho }) {
  const motivos = new Map();
  const marcar = (ids, motivo, cota) => { for (const id of ids.filter(i => gc.has(i)).slice(0, cota)) { if (!motivos.has(id)) motivos.set(id, new Set()); motivos.get(id).add(motivo); } };
  const todos = [...gc.keys()], m = id => mr4.get(id) || {}, g = id => gc.get(id);
  const capital = id => Math.max(0, g(id).current_stock || 0) * (g(id).registered_cost_cents || 0);
  const ehA = id => m(id).abc_revenue === 'A';
  const sorteio = id => crypto.createHash('sha256').update(semente + ':' + id).digest('hex');
  const cota = f => Math.max(2, Math.round(tamanho * f));
  marcar(divergencias.filter(d => d.classe !== 'EXPLICADA_POR_MOVIMENTO_POSTERIOR').map(d => d.id), 'DIVERGENTE_GC_MR4', cota(0.25));
  marcar(todos.filter(i => g(i).current_stock < 0).sort(), 'SALDO_NEGATIVO', cota(0.1));
  marcar(todos.filter(i => ehA(i) && g(i).current_stock <= 0 && ((m(i).units || {})[90] > 0)).sort((a, b) => (m(b).units[90] - m(a).units[90]) || a.localeCompare(b)), 'A_SEM_ESTOQUE_COM_DEMANDA', cota(0.15));
  marcar(todos.filter(i => ehA(i) && capital(i) > 0).sort((a, b) => capital(b) - capital(a) || a.localeCompare(b)), 'A_MAIOR_CAPITAL', cota(0.2));
  marcar(residuos.map(x => x.id), 'VARIACAO_NAO_EXPLICADA_7D', cota(0.15));
  marcar(todos.filter(i => ehA(i) && !motivos.has(i)).sort((a, b) => sorteio(a).localeCompare(sorteio(b))), 'A_AMOSTRA_ALEATORIA', Math.max(0, tamanho - motivos.size));
  return [...motivos].slice(0, tamanho).map(([id, s]) => ({ id, codigo: g(id).code, abc: m(id).abc_revenue || null, registrado_gc: g(id).current_stock, registrado_mr4: m(id).raw_stock === undefined ? null : m(id).raw_stock, motivos: [...s], contagem_fisica: null }));
}

function chavesDe(objetos) { const s = new Set(); for (const o of objetos) if (o && typeof o === 'object') for (const k of Object.keys(o)) s.add(k.slice(0, 60)); return [...s].sort(); }
const filhos = (regs, campo, dentro) => regs.flatMap(r => (Array.isArray(r[campo]) ? r[campo] : [])).map(x => x[dentro] || x);

// ── Execução ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function executarReconciliacao({ transporte, credenciais, db, agora = new Date(), opcoes = {}, saida, dormir, ambiente = {} }) {
  const o = { ...PADRAO, ...opcoes };
  const emitir = (tag, dados) => saida(`RECON_${tag} ${JSON.stringify(dados)}`);
  const lista = (tag, itens, max = o.maxItens) => {
    const cortada = itens.slice(0, max), partes = Math.ceil(cortada.length / ITENS_POR_LINHA);
    for (let i = 0; i < partes; i++) emitir(tag, { parte: i + 1, de: partes, total: itens.length, truncado: itens.length > cortada.length, itens: cortada.slice(i * ITENS_POR_LINHA, (i + 1) * ITENS_POR_LINHA) });
  };
  const erros = [], contador = { leituras: 0 };
  let gcLeitor = null;
  const fim = extra => {
    const uso = gcLeitor ? gcLeitor.uso : { usadas: 0, por_recurso: {}, esgotado: false }, est = gcLeitor ? gcLeitor.estatisticas() : { retries: 0, r429: 0 };
    emitir('ORCAMENTO', { maximo: o.maxRequisicoes, usadas: uso.usadas, por_recurso: uso.por_recurso, repeticoes: est.retries, respostas_429: est.r429, esgotado: uso.esgotado, leituras_firestore: contador.leituras, escritas_firestore: 0, escritas_gc: 0 });
    const r = { ok: erros.length === 0 && !extra, secoes_com_erro: erros, ...(extra || {}) };
    emitir('FIM', r); return r;
  };
  emitir('INICIO', { loja: LOJA, instante: agora.toISOString(), opcoes: o, aviso: 'SOMENTE LEITURA. Estoque REGISTRADO (GC ou MR4) NÃO é estoque físico conferido.' });
  if (Number(ambiente.CLOUD_RUN_TASK_ATTEMPT || 0) > 0) return fim({ abortado: 'REEXECUCAO_AUTOMATICA_DO_JOB' });

  const ro = somenteLeitura(db, contador);
  let mr4, gcProdutosBrutos;
  try {
    const trava = await travaEmUso(ro, agora);
    if (trava.length && !o.ignorarTrava) return fim({ abortado: 'SINCRONIZACAO_EM_ANDAMENTO', travas: trava });
    mr4 = await lerMr4(ro, agora);
    gcLeitor = criarLeitorGc({ transporte, credenciais, maxRequisicoes: o.maxRequisicoes, pausaMs: o.pausaMs, dormir });
    gcProdutosBrutos = (await gcLeitor.lista('/produtos', { ativo: 1 }, { desembrulhar: x => x.Produto || x })).itens;
  } catch (e) { erros.push({ secao: mr4 ? 'produtos' : 'mr4', codigo: codigoSeguro(e) }); return fim({ abortado: 'SEM_DADOS_ESSENCIAIS' }); }

  const secao = async (nome, f) => { try { return await f(); } catch (e) { erros.push({ secao: nome, codigo: codigoSeguro(e) }); emitir('ERRO', { secao: nome, codigo: codigoSeguro(e) }); return null; } };
  const hoje = C.dataComercial(agora), refLocal = localDe(mr4.resumo.gerado_em);
  const gc = new Map(gcProdutosBrutos.map(p => { const x = C.mapearProduto(p); return [x.product_id, x]; }));
  const m = new Map(mr4.operacional.map(x => [x.product_id, x]));
  const custoMr4 = new Map(mr4.custos.map(x => [x.product_id, x.registered_cost_cents]));
  const codigoDe = id => (gc.get(id) && gc.get(id).code) || (m.get(id) && m.get(id).code) || null;

  const iniVendas = C.somarDias(hoje, -o.diasVendas);
  const vendasGc = await secao('vendas', async () => (await gcLeitor.lista('/vendas', { data_inicio: iniVendas, data_fim: hoje }, { permitirVazio: true, desembrulhar: x => x.Venda || x })).itens);
  const comprasGc = await secao('compras', async () => (await gcLeitor.lista('/compras', { data_inicio: '2000-01-01', data_fim: '2099-12-31' }, { desembrulhar: x => x.Compra || x })).itens);

  // 1) O que o GestãoClick fornece (somente NOMES de campos)
  const detalhe = async id => { const d = (await gcLeitor.get('/produtos/' + encodeURIComponent(id), {}, { tipo: 'detalhe' })).data; return d.Produto || d; };
  const detalheAmostra = await secao('detalhe', () => detalhe([...gc.keys()].sort()[0]));
  const campos = {
    produto: chavesDe(gcProdutosBrutos), produto_detalhe: chavesDe([detalheAmostra]), variacao: chavesDe(filhos(gcProdutosBrutos, 'variacoes', 'variacao')),
    venda: chavesDe(vendasGc || []), venda_item: chavesDe(filhos(vendasGc || [], 'produtos', 'produto')), compra: chavesDe(comprasGc || []), compra_item: chavesDe(filhos(comprasGc || [], 'produtos', 'produto')),
  };
  const suspeitos = Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v.filter(c => RE_CAMPO_SUSPEITO.test(c))]).filter(([, v]) => v.length));
  emitir('CAMPOS', { campos });
  emitir('CAMPOS_SALDO', { campos_com_nome_de_reserva_disponivel_transito_minimo: suspeitos, declaracao: Object.keys(suspeitos).length ? 'Há campos com nome sugestivo: conferir manualmente o significado; a comparação usa apenas "estoque"' : 'A resposta não traz campos de reservado, disponível, em trânsito ou mínimo: o GC fornece um único saldo ("estoque")' });

  // 2) Cadastro, ativos e variações
  const soGc = [...gc.keys()].filter(id => !m.has(id)).sort(), soMr4 = [...m.keys()].filter(id => !gc.has(id)).sort();
  const inativos = await secao('inativos', async () => {
    const j = await gcLeitor.get('/produtos', { ativo: 0, pagina: 1, limite: 100 });
    return { total_registros: j.meta.total_registros === undefined ? null : j.meta.total_registros, linhas_pagina_1: j.data.length, com_ativo_0: j.data.filter(p => String((p.Produto || p).ativo) === '0').length, tambem_na_lista_de_ativos: j.data.filter(p => gc.has(String((p.Produto || p).id))).length };
  });
  const ausentes = [];
  for (const id of soMr4.slice(0, 5)) {
    try {
      const d = await detalhe(id);
      if (d.loja_id !== undefined && d.loja_id !== null && d.loja_id !== '' && String(d.loja_id) !== LOJA) throw erro('GC_LOJA_DIVERGENTE');
      ausentes.push({ id, situacao: String(d.ativo) === '1' ? 'ATIVO_NO_DETALHE' : 'INATIVO_NO_DETALHE' });
    } catch (e) { ausentes.push({ id, situacao: codigoSeguro(e) }); }
  }
  const variacoes = gcProdutosBrutos.filter(p => String(p.possui_variacao) === '1' && Array.isArray(p.variacoes) && p.variacoes.length)
    .map(p => ({ id: String(p.id), soma: r3(p.variacoes.reduce((s, v) => s + Number((v.variacao || v).estoque || 0), 0)), saldo: Number(p.estoque || 0) }));
  const snapRecente = mr4.snapshots.length ? mr4.snapshots[mr4.snapshots.length - 1] : null;
  const difSnap = snapRecente ? [...m].filter(([id, x]) => snapRecente.doc.saldos[id] !== x.raw_stock).length : null;
  const ativoDiverge = [...gc].filter(([id, g]) => m.has(id) && m.get(id).active !== g.active).map(([id, g]) => ({ id, codigo: g.code, gc_ativo: g.active, mr4_ativo: m.get(id).active }));
  emitir('RESUMO', {
    mr4_gerado_em: mr4.resumo.gerado_em, idade_min_mr4: Math.round((agora - new Date(mr4.resumo.gerado_em)) / 60000), avisos: mr4.avisos,
    produtos: { gc_ativos: gc.size, mr4: m.size, painel_cache: mr4.painel ? mr4.painel.total_produtos : null, em_ambos: gc.size - soGc.length, so_no_gc: soGc.length, so_no_mr4: soMr4.length, ativo_divergente: ativoDiverge.length },
    snapshot_diario: { dia: snapRecente ? snapRecente.dia : null, produtos_divergentes_do_mr4: difSnap },
    saldo_gc: { negativos: [...gc.values()].filter(x => x.current_stock < 0).length, zerados: [...gc.values()].filter(x => x.current_stock === 0).length, ilegiveis: [...gc.values()].filter(x => x.current_stock === null).length, fracionados: [...gc.values()].filter(x => x.current_stock !== null && !Number.isInteger(x.current_stock)).length, unidades_positivas: r3([...gc.values()].reduce((s, x) => s + Math.max(0, x.current_stock || 0), 0)), unidades_positivas_mr4: r3([...m.values()].reduce((s, x) => s + Math.max(0, x.raw_stock || 0), 0)) },
    variacoes: { produtos_com_variacao: variacoes.length, soma_diferente_do_saldo: variacoes.filter(v => Math.abs(v.soma - v.saldo) > EPS).length },
    consulta_inativos: inativos,
  });
  lista('CADASTRO_SO_GC', soGc.map(id => ({ id, codigo: codigoDe(id), saldo: gc.get(id).current_stock })));
  lista('CADASTRO_SO_MR4', soMr4.map(id => ({ id, codigo: codigoDe(id), saldo_mr4: m.get(id).raw_stock })));
  if (ausentes.length) lista('CADASTRO_AUSENTES_DETALHE', ausentes);
  lista('CADASTRO_ATIVO_DIVERGENTE', ativoDiverge);
  lista('VARIACOES_DIVERGENTES', variacoes.filter(v => Math.abs(v.soma - v.saldo) > EPS));

  // 3) Quantidade
  const mov = efeitoPosterior({ vendasGc: vendasGc || [], comprasGc: comprasGc || [], base: mr4.base, refLocal });
  const difQtd = compararQuantidade(gc, m, mov);
  emitir('QUANTIDADE', { comparados: gc.size - soGc.length, divergentes: difQtd.length, por_classe: contar(difQtd, x => x.classe), por_abc: contar(difQtd, x => x.abc), soma_modulo_dif_un: r3(difQtd.reduce((s, x) => s + Math.abs(x.dif || 0), 0)), movimentos_considerados_completos: !!(vendasGc && comprasGc), limite: 'edições posteriores em vendas anteriores à janela lida não são vistas' });
  lista('DIVERGENCIA_QTD', difQtd);

  // 4) Custo cadastrado
  const difCusto = [...gc].filter(([id, g]) => m.has(id) && (g.registered_cost_cents ?? null) !== (custoMr4.get(id) ?? null))
    .map(([id, g]) => { const b = custoMr4.get(id); return { id, codigo: g.code, abc: m.get(id).abc_revenue || null, dif_pct: b > 0 && g.registered_cost_cents !== null ? Math.round((g.registered_cost_cents - b) / b * 1000) / 10 : null }; })
    .sort((a, b) => Math.abs(b.dif_pct || 0) - Math.abs(a.dif_pct || 0) || a.id.localeCompare(b.id));
  const capital = (mapa, saldo, custo) => [...mapa.keys()].reduce((s, id) => s + (custo(id) > 0 ? Math.round(Math.max(0, saldo(id) || 0) * custo(id)) : 0), 0);
  emitir('CUSTO', { divergentes: difCusto.length, gc_sem_custo: [...gc.values()].filter(g => !(g.registered_cost_cents > 0)).length, gc_sem_custo_com_estoque: [...gc.values()].filter(g => !(g.registered_cost_cents > 0) && g.current_stock > 0).length, mr4_sem_custo: [...m.keys()].filter(id => !(custoMr4.get(id) > 0)).length,
    capital_custo_cadastrado_cents: { gc: capital(gc, id => gc.get(id).current_stock, id => gc.get(id).registered_cost_cents), mr4: capital(m, id => m.get(id).raw_stock, id => custoMr4.get(id)) }, observacao: 'custo CADASTRADO (indicativo), não é custo contábil nem último custo de compra' });
  lista('DIVERGENCIA_CUSTO', difCusto);

  // 5) Vendas da janela
  if (vendasGc) {
    const mr4Janela = mr4.base.vendas.filter(v => v.data >= iniVendas && v.data <= hoje);
    const noPeriodo = vendasGc.filter(v => String(v.data) >= iniVendas && String(v.data) <= hoje);
    const r = compararMovimento({ gc: noPeriodo, mr4: mr4Janela, unidades: unidadesVenda, refLocal, codigoDe });
    const abertas = noPeriodo.filter(v => !C.contaComoDemanda(v) && !C.RE_CANCELADA.test(String(v.nome_situacao || '')));
    const itensVenda = noPeriodo.flatMap(v => C.fatosDeVenda(v)).filter(f => f.counts_as_demand);
    emitir('VENDAS', { periodo: { inicio: iniVendas, fim: hoje }, ...r.resumo, por_situacao_gc: contar(noPeriodo, v => v.nome_situacao),
      itens_sem_produto: { linhas: itensVenda.filter(f => !f.product_id).length, unidades: r3(itensVenda.filter(f => !f.product_id).reduce((s, f) => s + (f.qty || 0), 0)) },
      nao_baixaram_estoque_nao_canceladas: { vendas: abertas.length, unidades: r3(abertas.flatMap(v => C.fatosDeVenda(v)).reduce((s, f) => s + (f.qty || 0), 0)) } });
    lista('DIVERGENCIA_VENDAS', r.itens);
  }

  // 6) Compras, entradas e "em trânsito"
  if (comprasGc) {
    const iniCompras = C.somarDias(hoje, -o.diasCompras), naJanela = c => String(c.data_emissao || '') >= iniCompras && String(c.data_emissao || '') <= hoje;
    const geral = compararMovimento({ gc: comprasGc, mr4: mr4.base.compras, unidades: unidadesCompra, refLocal, codigoDe });
    const janela = compararMovimento({ gc: comprasGc.filter(naJanela), mr4: mr4.base.compras.filter(naJanela), unidades: unidadesCompra, refLocal, codigoDe });
    const mapaBase = porId(mr4.base.compras);
    const confirmadas = comprasGc.filter(c => naJanela(c) && C.situacaoCompra(c.nome_situacao) === 'CONFIRMADA');
    emitir('COMPRAS', { total: geral.resumo, janela_emissao: { inicio: iniCompras, fim: hoje, ...janela.resumo },
      por_situacao_gc: contar(comprasGc, c => c.nome_situacao), por_situacao_mr4: contar(mr4.base.compras, c => c.nome_situacao),
      situacao_divergente: comprasGc.filter(c => mapaBase.has(String(c.id)) && C.situacaoCompra(mapaBase.get(String(c.id)).nome_situacao) !== C.situacaoCompra(c.nome_situacao)).length,
      entradas_janela: { compras_confirmadas: confirmadas.length, modificadas_em_dia_diferente_da_emissao: confirmadas.filter(c => C.parseData(c.modificado_em) !== C.parseData(c.data_emissao)).length, aviso: 'a API não informa data de recebimento: modificado_em é só um indício' } });
    lista('DIVERGENCIA_ENTRADAS', janela.itens);
    const pendentes = comprasGc.filter(c => C.situacaoCompra(c.nome_situacao) === 'PENDENTE');
    const idade = c => { const d = C.parseData(c.data_emissao); if (!d) return 'sem_data'; const n = C.diffDias(d, hoje); return n <= 30 ? 'ate_30d' : n <= 90 ? 'de_31_a_90d' : 'mais_de_90d'; };
    const unidadesPend = regs => { const x = new Map(); for (const c of regs) for (const [id, q] of unidadesCompra(c, 'PENDENTE')) somar(x, id, q); return x; };
    const tg = unidadesPend(comprasGc), tm = unidadesPend(mr4.base.compras);
    emitir('TRANSITO', { declaracao: 'O GestãoClick não fornece "em trânsito"; proxy = compras "A receber"/"Em aberto"', compras_pendentes_gc: pendentes.length, por_idade_emissao: contar(pendentes, idade), unidades_gc: r3([...tg.values()].reduce((s, x) => s + x, 0)), produtos_gc: tg.size, unidades_mr4: r3([...tm.values()].reduce((s, x) => s + x, 0)), produtos_mr4: tm.size });
    lista('TRANSITO_ITENS', [...new Set([...tg.keys(), ...tm.keys()])].map(id => ({ id, codigo: codigoDe(id), pendente_gc: r3(tg.get(id) || 0), pendente_mr4: r3(tm.get(id) || 0), saldo_gc: gc.has(id) ? gc.get(id).current_stock : null })).sort((a, b) => b.pendente_gc - a.pendente_gc || a.id.localeCompare(b.id)));
  }

  // 7) Sem movimentação
  const unir = (a, b) => { const x = porId(a); for (const r of b || []) x.set(String(r.id), r); return [...x.values()]; };
  const parado = semMovimentacao({ gc, mr4: m, vendas: unir(mr4.base.vendas, vendasGc), compras: unir(mr4.base.compras, comprasGc), hoje });
  emitir('SEM_MOVIMENTO', parado.resumo);
  lista('SEM_MOVIMENTO_ITENS', parado.itens);

  // 8) Contagem física
  const residuos = residuosRecentes(mr4.snapshots, mr4.base);
  const contagem = listaContagem({ gc, mr4: m, divergencias: difQtd, residuos: residuos.itens, semente: hoje, tamanho: o.amostraContagem });
  emitir('CONTAGEM_RESUMO', { itens: contagem.length, por_motivo: contar(contagem.flatMap(c => c.motivos), x => x), pares_de_snapshots_para_variacao: residuos.pares, instrucao: 'Contar fisicamente SEM ver o saldo registrado; anotar data/hora; comparar com o saldo do mesmo instante. Registrado ≠ físico conferido.' });
  lista('CONTAGEM_FISICA', contagem, o.amostraContagem);
  return fim();
}

module.exports = { PADRAO, codigoSeguro, lerOpcoes, somenteLeitura, criarLeitorGc, localDe, efeitoPosterior, compararQuantidade, compararMovimento, semMovimentacao, residuosRecentes, listaContagem, executarReconciliacao };
