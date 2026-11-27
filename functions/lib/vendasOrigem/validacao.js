'use strict';
/**
 * VALIDAÇÃO com dados reais — SOMENTE LEITURA (GestãoClick só GET, loja 262759; Firestore por um invólucro sem escrita).
 * Mostra o que a reconciliação veria HOJE e comprova como a API se comporta (lista padrão × filtro de canceladas × consulta por id).
 * Saída: linhas "VEXC_<SEÇÃO> {json}" com ids/códigos de venda, datas, situações e contagens. Nunca nome, documento, contato,
 * id de cliente, valor, corpo de resposta, mensagem de exceção ou credencial.
 */
const R = require('./regras');
const L = require('./leitura');
const P = require('./persistencia');
const C = require('../compras/canonico');
const { criarLeitorGc, codigoSeguro } = require('../estoqueReconciliacao');

const PADRAO = Object.freeze({ dias: 60, maxRequisicoes: 120, pausaMs: 500, maxDetalhes: 30, vendas: [] });
const FAIXAS = Object.freeze({ dias: [1, 400], maxRequisicoes: [10, 250], pausaMs: [300, 5000], maxDetalhes: [1, 60] });
const NOMES = Object.freeze({ dias: 'dias', 'max-requisicoes': 'maxRequisicoes', 'pausa-ms': 'pausaMs', 'max-detalhes': 'maxDetalhes' });
const ID_INEXISTENTE = '999999999999';
const erro = codigo => Object.assign(new Error(codigo), { codigo });

function lerOpcoes(argv = []) {
  const o = { ...PADRAO };
  for (const a of argv) {
    if (a === '--validar') continue;
    const l = /^--vendas=(\d{1,15}(?:\+\d{1,15}){0,19})$/.exec(a);               // separados por "+": a vírgula é do gcloud --args
    if (l) { o.vendas = l[1].split('+'); continue; }
    const m = /^--([a-z-]+)=(\d+)$/.exec(a), k = m && NOMES[m[1]];
    if (!k) throw erro('ARGUMENTO_INVALIDO');
    const v = Number(m[2]); if (v < FAIXAS[k][0] || v > FAIXAS[k][1]) throw erro('ARGUMENTO_FORA_DA_FAIXA');
    o[k] = v;
  }
  return o;
}

/** Só expõe leitura. Não há set/update/delete/create/batch/transação. */
function somenteLeitura(db, contador) {
  const consulta = ref => ({
    where: (...a) => consulta(ref.where(...a)),
    select: (...a) => consulta(ref.select(...a)),
    get: async () => { const s = await ref.get(); contador.leituras += Math.max(1, s.docs.length); return s; },
    doc: id => ({ get: async () => { contador.leituras++; return ref.doc(id).get(); } }),
  });
  return { collection: c => consulta(db.collection(c)) };
}

async function validar({ db, transporte, credenciais, agora = new Date(), opcoes = {}, saida, dormir, ambiente = {} }) {
  const o = { ...PADRAO, ...opcoes };
  const emitir = (tag, d) => saida(`VEXC_${tag} ${JSON.stringify(d)}`);
  const emLotes = (tag, itens, n = 50) => { const t = Math.max(1, Math.ceil(itens.length / n)); for (let i = 0; i < t; i++) emitir(tag, { parte: i + 1, de: t, total: itens.length, itens: itens.slice(i * n, (i + 1) * n) }); };
  const contador = { leituras: 0 }, erros = [];
  const sonda = {};
  const espiao = async (url, op) => {
    const r = await transporte(url, op);
    if (!String(url).includes('/vendas/' + ID_INEXISTENTE)) return r;
    sonda.http = r.status;
    return { status: r.status, ok: r.ok, headers: r.headers, json: async () => { const j = await r.json(); Object.assign(sonda, { code: j && j.code !== undefined ? String(j.code).slice(0, 10) : null, status: j && j.status !== undefined ? String(j.status).slice(0, 20) : null, data: Array.isArray(j && j.data) ? `lista(${j.data.length})` : j && j.data === null ? 'null' : typeof (j && j.data) }); return j; } };
  };
  let leitor = null;
  const fim = extra => {
    emitir('ORCAMENTO', { maximo: o.maxRequisicoes, usadas: leitor ? leitor.uso.usadas : 0, esgotado: leitor ? leitor.uso.esgotado : false, leituras_firestore: contador.leituras, escritas_firestore: 0, escritas_gc: 0 });
    const r = { ok: !extra && !erros.length, erros, ...(extra || {}) }; emitir('FIM', r); return r;
  };
  const hoje = C.dataComercial(agora), janela = { inicio: C.somarDias(hoje, -o.dias), fim: hoje };
  emitir('INICIO', { loja: R.LOJA, instante: agora.toISOString(), janela, opcoes: o, aviso: 'SOMENTE LEITURA.' });
  if (Number(ambiente.CLOUD_RUN_TASK_ATTEMPT || 0) > 0) return fim({ abortado: 'REEXECUCAO_AUTOMATICA_DO_JOB' });
  try {
    const ro = somenteLeitura(db, contador);
    leitor = criarLeitorGc({ transporte: espiao, credenciais, maxRequisicoes: o.maxRequisicoes, pausaMs: o.pausaMs, dormir });
    const cfgSnap = await ro.collection(R.COLECOES.config).doc(R.DOC_CONFIG).get();
    emitir('CONFIG', { modo: R.lerConfig(cfgSnap.exists ? cfgSnap.data() : null).modo, documento_existe: cfgSnap.exists });
    const { conhecidas, uso } = await L.lerConhecidas(ro, { ...janela, extras: o.vendas });
    const todas = [...conhecidas.values()].filter(c => c.data >= janela.inicio && c.data <= janela.fim);
    emitir('CONHECIDAS', { no_periodo: todas.length, ativas: todas.filter(c => c.ativa).length, com_espelho: todas.filter(c => c.espelho).length, na_base_compras: todas.filter(c => c.base).length, base_disponivel: uso.baseDisponivel, com_prova_de_loja: todas.filter(c => c.ativa && c.provaLoja).length });

    // lista padrão (guardada para os cruzamentos) + detecção com os limites de volume desligados (calibração)
    const lista = await L.listar(leitor, janela.inicio, janela.fim, false);
    const situacoes = {}; for (const v of lista.values()) { const k = String(v.nome_situacao || '').slice(0, 40); situacoes[k] = (situacoes[k] || 0) + 1; }
    emitir('LISTA', { total: lista.size, completa: true, situacoes, canceladas_na_lista_padrao: [...lista.values()].filter(R.cancelada).length, loja_declarada: [...lista.values()].filter(v => R.lojaDe(v) === 'ATIVA').length });
    const params = { ...R.PARAMS, ausentesMin: 1e9, listaMinimaFracao: 0, maxDetalhes: o.maxDetalhes };
    const d = await L.detectar({ leitor, conhecidas, janela, agoraMs: agora.getTime(), params });
    const anomaliaPadrao = R.anomalia({ ativas: d.contagens.conhecidasAtivas, lidas: d.contagens.listadas, ausentes: d.contagens.ausentesNoPeriodo });
    emLotes('AUSENTES', (d.ausentes || []).slice().sort());

    let canceladasFiltro = null;
    try {
      const r = await leitor.lista('/vendas', { data_inicio: janela.inicio, data_fim: janela.fim, situacao_id: R.SITUACAO_ID_CANCELADA }, { permitirVazio: true, desembrulhar: x => x.Venda || x });
      canceladasFiltro = new Set(r.itens.map(v => String(v.id)));
      emitir('FILTRO_CANCELADAS', { total: r.itens.length, tambem_na_lista_padrao: [...canceladasFiltro].filter(i => lista.has(i)).length, ativas_no_mr4: [...canceladasFiltro].filter(i => (conhecidas.get(i) || {}).ativa).length,
        ausentes_cobertas: (d.ausentes || []).filter(i => canceladasFiltro.has(i)).length });
    } catch (e) { erros.push({ secao: 'filtro_canceladas', codigo: codigoSeguro(e) }); }

    for (const x of d.observacoes) {
      const c = conhecidas.get(x.vendaId) || {};
      let impacto = null;
      if (R.CONFIRMAVEIS.includes(x.classe)) {
        try {
          const codigo = String(((x.evidencia.detalhe || x.evidencia.listada) || {}).codigo || '');
          const p = /^[A-Za-z0-9_-]{1,20}$/.test(codigo) ? await ro.collection('expedicao_pedidos').doc(codigo).get() : null;
          impacto = { vinculos_carteira: await P.lerVinculosCarteira(q => q.get(), ro, x.vendaId), na_expedicao: !!(p && p.exists), coluna_expedicao: p && p.exists ? String(p.data().coluna || '') : null };
        } catch (e) { erros.push({ secao: 'impacto', codigo: codigoSeguro(e) }); }
      }
      emitir('CANDIDATO', { id: x.vendaId, classe: x.classe, fonte: x.fonte, data: c.data || null, prova_de_loja: x.provaLoja, ativa_no_mr4: !!c.ativa,
        mr4: L.resumoEspelho(c), gc_detalhe: x.evidencia.detalhe || null, gc_listada: x.evidencia.listada || null, erro: x.evidencia.erro || null, no_filtro_canceladas: canceladasFiltro ? canceladasFiltro.has(x.vendaId) : null, impacto });
    }

    for (const id of o.vendas) {
      const dt = await L.detalhar(leitor, id), c = conhecidas.get(id);
      emitir('VENDA', { id, na_lista_periodo: lista.has(id), no_filtro_canceladas: canceladasFiltro ? canceladasFiltro.has(id) : null, mr4: c ? L.resumoEspelho(c) : null, prova_de_loja: c ? c.provaLoja : null, gc_detalhe: L.resumoRegistro(dt.registro), erro: dt.erro || null });
    }
    const s = await L.detalhar(leitor, ID_INEXISTENTE);
    emitir('SONDA_INEXISTENTE', { ...sonda, codigo_cliente: s.erro || null, registro_devolvido: !!s.registro, reconhecida_como_nao_encontrada: s.erro === 'GC_HTTP_404' });

    const porClasse = {}; for (const x of d.observacoes) porClasse[x.classe] = (porClasse[x.classe] || 0) + 1;
    emitir('RESUMO', { integra: d.integra, anomalia_na_deteccao: d.anomalia, anomalia_com_limites_padrao: anomaliaPadrao, ...d.contagens, por_classe: porClasse, erros_deteccao: [...new Set(d.erros)] });
  } catch (e) { return fim({ abortado: codigoSeguro(e) }); }
  return fim();
}

module.exports = { PADRAO, ID_INEXISTENTE, lerOpcoes, somenteLeitura, validar };
