'use strict';
/**
 * Detecção — SOMENTE LEITURA (Firestore: get/where; GestãoClick: GET, loja 262759, com orçamento).
 * Compara as vendas conhecidas pelo MR4 (espelho `vendas_gc` + base de Compras) com a lista COMPLETA do período e classifica cada
 * diferença. Não grava nada: devolve as observações para quem decide.
 */
const R = require('./regras');
const C = require('../compras/canonico');
const { codigoSeguro } = require('../estoqueReconciliacao');

const CAMPOS_ESPELHO = Object.freeze(['cliente_id', 'data', 'nome_situacao', 'modificado_em', 'cadastrado_em', 'invalidacao_origem']);
const dia = v => String(v || '').slice(0, 10);
const desembrulhar = x => (x && x.Venda) || x;

const ativaNoEspelho = m => !!m && !m.invalidacao_origem && !R.cancelada(m);
const ativaNaBase = b => !!b && !R.cancelada(b);

/** Junta espelho e base numa entrada por venda. */
function entrada(id, espelho, base) {
  const data = dia((espelho && espelho.data) || (base && base.data));
  return { id: String(id), data, espelho: espelho || null, base: base || null, ativa: ativaNoEspelho(espelho) || ativaNaBase(base),
    provaLoja: !!base || [espelho && espelho.cadastrado_em, espelho && espelho.modificado_em].some(t => String(t || '') >= R.PARAMS.pisoProvaLoja) };
}

/** Base de Compras (ids/situação), opcional: indisponível ⇒ segue só com o espelho. */
async function lerBaseCompras(db) {
  try { const b = await require('../compras/snapshot').carregarBase(db); return b ? new Map(b.vendas.map(v => [String(v.id), v])) : new Map(); }
  catch (_) { return null; }
}

/** Vendas conhecidas no período [inicio, fim] + as indicadas em `extras` (candidatas abertas fora dele). Lida ANTES do GestãoClick. */
async function lerConhecidas(db, { inicio, fim, extras = [] }) {
  const uso = { leiturasEspelho: 0, baseDisponivel: true };
  const q = await db.collection('vendas_gc').where('data', '>=', inicio).where('data', '<=', fim).select(...CAMPOS_ESPELHO).get();
  uso.leiturasEspelho += q.docs.length;
  const espelho = new Map(q.docs.map(d => [d.id, d.data()]));
  const base = await lerBaseCompras(db);
  if (!base) uso.baseDisponivel = false;
  const faltam = extras.map(String).filter(id => !espelho.has(id));
  for (const id of faltam) { const s = await db.collection('vendas_gc').doc(id).get(); uso.leiturasEspelho++; if (s.exists) espelho.set(id, s.data()); }
  const ids = new Set(espelho.keys());
  for (const [id, v] of base || []) if (dia(v.data) >= inicio && dia(v.data) <= fim) ids.add(id);
  for (const id of faltam) if (base && base.has(id)) ids.add(id);
  return { conhecidas: new Map([...ids].map(id => [id, entrada(id, espelho.get(id), base && base.get(id))])), uso };
}

async function listar(leitor, inicio, fim, permitirVazio) {
  const r = await leitor.lista('/vendas', { data_inicio: inicio, data_fim: fim }, { permitirVazio, desembrulhar });
  return new Map(r.itens.map(v => [String(v.id), v]));
}

async function detalhar(leitor, id) {
  try { const j = await leitor.get('/vendas/' + encodeURIComponent(id), {}, { tipo: 'detalhe' }); return { registro: desembrulhar(j.data) }; }
  catch (e) { return { erro: codigoSeguro(e) }; }
}

const resumoRegistro = r => (r ? { data: dia(r.data), situacao: String(r.nome_situacao || '').slice(0, 40), situacao_id: String(r.situacao_id || '').slice(0, 15), situacao_estoque: r.situacao_estoque != null ? String(r.situacao_estoque).slice(0, 3) : null, modificado_em: String(r.modificado_em || '').slice(0, 19), codigo: String(r.codigo || '').slice(0, 20), loja: R.lojaDe(r) } : null);
const resumoEspelho = c => ({ data: c.data || null,
  espelho: c.espelho ? { situacao: String(c.espelho.nome_situacao || '').slice(0, 40), modificado_em: String(c.espelho.modificado_em || '').slice(0, 19) } : null,
  base: c.base ? { situacao: String(c.base.nome_situacao || '').slice(0, 40), modificado_em: String(c.base.modificado_em || '').slice(0, 19) } : null });

/**
 * @param {object} p
 *   leitor       criarLeitorGc(...) (GET, loja ativa, orçamento)
 *   conhecidas   Map de lerConhecidas
 *   abertas      Map(vendaId → candidato) com aberta=true
 *   janela       { inicio, fim }
 *   detalharAplicadas    re-consulta por id as invalidações ativas ausentes (execução profunda)
 *   detalharConfirmadas  re-consulta por id as já confirmadas (execução profunda, ou sempre no modo APLICAR)
 * @returns { integra, anomalia, observacoes: [{vendaId, classe, fonte, evidencia, provaLoja}], contagens, erros }
 * Lança se a lista principal do período não puder ser lida por inteiro (execução sem efeito).
 */
async function detectar({ leitor, conhecidas, abertas = new Map(), janela, agoraMs, params = R.PARAMS, detalharAplicadas = false, detalharConfirmadas = true }) {
  const observacoes = [], erros = [];
  const lista = await listar(leitor, janela.inicio, janela.fim, false);
  const emJanela = c => c.data >= janela.inicio && c.data <= janela.fim;
  const alvos = new Map();                                                  // vendaId → entrada conhecida que precisa de verificação
  for (const c of conhecidas.values()) if (c.ativa && emJanela(c)) alvos.set(c.id, c);
  for (const id of abertas.keys()) if (conhecidas.has(id)) alvos.set(id, conhecidas.get(id));
  const ativas = [...conhecidas.values()].filter(c => c.ativa && emJanela(c)).length;
  const obs = (id, classe, fonte, evidencia) => observacoes.push({ vendaId: id, classe, fonte, evidencia: { ...(conhecidas.has(id) ? resumoEspelho(conhecidas.get(id)) : {}), ...(evidencia || {}) }, provaLoja: !!(conhecidas.get(id) || {}).provaLoja });

  const daLista = (id, r, fonte) => {
    const classe = R.classificarListado(r);
    // venda presente e ativa que nunca foi candidata não gera observação
    if (classe === R.CLASSE.PRESENTE && !abertas.has(id)) return;
    obs(id, classe, fonte, { listada: resumoRegistro(r) });
  };

  let ausentes = [];
  const datasFora = new Map();
  for (const [id, c] of alvos) {
    if (lista.has(id)) daLista(id, lista.get(id), 'LISTA_PERIODO');
    else if (emJanela(c)) ausentes.push(id);
    else if (c.data) { if (!datasFora.has(c.data)) datasFora.set(c.data, []); datasFora.get(c.data).push(id); }
  }
  const contagens = { conhecidasAtivas: ativas, listadas: lista.size, ausentesNoPeriodo: ausentes.length, detalhes: 0, semVerificacao: 0 };
  // o limite de volume olha só ausências NOVAS: as já confirmadas/aplicadas se acumulam por natureza
  const jaConhecida = id => { const k = abertas.get(id); return !!k && (k.invalidacaoAtiva || k.estado === R.ESTADOS.CONFIRMADA); };
  const motivoAnomalia = R.anomalia({ ativas, lidas: lista.size, ausentes: ausentes.filter(id => !jaConhecida(id)).length }, params);
  if (motivoAnomalia) {
    // só evidência POSITIVA (presença) é aproveitada: é a única que não pode retirar nada dos cálculos
    return { integra: false, anomalia: motivoAnomalia, observacoes: observacoes.filter(o => o.classe === R.CLASSE.PRESENTE), contagens, erros, ausentes };
  }

  // candidatas com data fora do período: leitura completa do próprio dia
  let datasUsadas = 0;
  for (const [data, ids] of [...datasFora].sort()) {
    if (datasUsadas >= params.maxDatas) { contagens.semVerificacao += ids.length; continue; }
    datasUsadas++;
    try { const d = await listar(leitor, data, data, true); for (const id of ids) d.has(id) ? daLista(id, d.get(id), 'LISTA_DIA') : ausentes.push(id); }
    catch (e) { erros.push(codigoSeguro(e)); contagens.semVerificacao += ids.length; }
  }

  // 2ª leitura independente: cada ausência precisa se repetir numa consulta restrita ao dia da venda
  const porData = new Map();
  for (const id of ausentes.filter(i => emJanela(alvos.get(i)))) { const d = alvos.get(id).data; if (!porData.has(d)) porData.set(d, []); porData.get(d).push(id); }
  const naoConfirmadas = new Set();
  const grupos = porData.size <= params.maxDatas ? [...porData].map(([d, ids]) => ({ inicio: d, fim: d, ids })) : metades(janela, porData);
  for (const g of grupos) {
    try {
      const l = await listar(leitor, g.inicio, g.fim, true);
      for (const id of g.ids) if (l.has(id)) { naoConfirmadas.add(id); daLista(id, l.get(id), 'LISTA_CONFERENCIA'); }
    } catch (e) { erros.push(codigoSeguro(e)); for (const id of g.ids) { naoConfirmadas.add(id); contagens.semVerificacao++; } }
  }
  ausentes = ausentes.filter(id => !naoConfirmadas.has(id));

  // fila da consulta individual: nunca observadas primeiro, depois as mais antigas
  const fila = ausentes.filter(id => {
    const k = abertas.get(id);
    if (k && k.bloqueada) return false;
    if (k && R.cedoDemais(k, agoraMs, params)) return false;
    if (k && k.invalidacaoAtiva && !detalharAplicadas) return false;
    if (k && !k.invalidacaoAtiva && k.estado === R.ESTADOS.CONFIRMADA && !detalharConfirmadas) return false;
    return true;
  }).sort((a, b) => (((abertas.get(a) || {}).ultimaObservacaoEm || 0) - ((abertas.get(b) || {}).ultimaObservacaoEm || 0)) || a.localeCompare(b));
  if (!fila.length) return { integra: true, anomalia: null, observacoes, contagens, erros, ausentes };

  // controle positivo: uma venda presente na lista PRECISA responder por id; sem isso, um 404 não significa nada
  const controle = [...lista.values()].find(v => !R.cancelada(v) && R.lojaDe(v) === 'ATIVA') || null;
  const c = controle ? await detalhar(leitor, String(controle.id)) : { erro: 'SEM_CONTROLE' };
  const controleOk = !!c.registro && String(c.registro.id) === String(controle && controle.id) && R.lojaDe(c.registro) === 'ATIVA';
  if (!controleOk) { erros.push('CONTROLE_POR_ID_FALHOU'); contagens.semVerificacao += fila.length; return { integra: false, anomalia: 'CONTROLE_POR_ID_FALHOU', observacoes, contagens, erros, ausentes }; }

  for (const id of fila) {
    if (contagens.detalhes >= params.maxDetalhes || leitor.uso.esgotado) { contagens.semVerificacao++; continue; }
    contagens.detalhes++;
    const d = await detalhar(leitor, id), conhecida = alvos.get(id);
    const classe = R.classificarDetalhe({ id, registro: d.registro, erro: d.erro, dataConhecida: conhecida.data, provaLoja: conhecida.provaLoja || !!(abertas.get(id) || {}).provaLoja });
    if (classe === R.CLASSE.ERRO_TEMPORARIO) erros.push(d.erro || 'DETALHE_INCONSISTENTE');
    obs(id, classe, 'CONSULTA_POR_ID', { detalhe: resumoRegistro(d.registro), erro: d.erro || null });
  }
  return { integra: true, anomalia: null, observacoes, contagens, erros, ausentes };
}

/** Muitas datas: confere em duas metades do período. */
function metades(janela, porData) {
  const ms = d => Date.parse(d + 'T00:00:00Z'), iso = m => new Date(m).toISOString().slice(0, 10);
  const meio = iso(Math.floor((ms(janela.inicio) + ms(janela.fim)) / 2 / 86400000) * 86400000);
  const g = [{ inicio: janela.inicio, fim: meio, ids: [] }, { inicio: C.somarDias(meio, 1), fim: janela.fim, ids: [] }];
  for (const [d, ids] of porData) g[d <= meio ? 0 : 1].ids.push(...ids);
  return g.filter(x => x.ids.length);
}

module.exports = { CAMPOS_ESPELHO, ativaNoEspelho, ativaNaBase, entrada, lerConhecidas, listar, detalhar, detectar, resumoRegistro, resumoEspelho };
