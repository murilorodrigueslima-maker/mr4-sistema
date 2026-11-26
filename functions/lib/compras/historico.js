'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Histórico diário de estoque (EXTENSÃO de estoque_snapshots; não há segunda base de saldos).
//
// Quem grava o saldo: snapshot.persistirSnapshot (sync de Compras, completo + incrementais) em estoque_snapshots/{dia}; o mesmo dia
// é substituído pelo último sync. Esta camada acrescenta:
//   1) validação da leitura de origem ANTES de gravar o dia (leitura incompleta/inconsistente ⇒ o dia não é gravado);
//   2) consolidação dos dias FECHADOS (anteriores a hoje), usando a base de vendas/compras que o sync já tem em memória
//      (nenhuma chamada nova ao GestãoClick):
//        estoque_snapshots/{dia}                  + fluxo_json {v,e,aj} (vendas e entradas REGISTRADAS; aj = resíduo INFERIDO) e totais
//        estoque_historico/resumo                 JSON agregado e legível (sem valores em R$)
//        estoque_historico/produtos               métricas por produto (matriz compacta em string; sem custo)
//        estoque_historico/resumo_valor           capital investido/excesso (R$) — leitura só gestor
//        estoque_historico/valor_{dia}            capital do dia + custos ALTERADOS (delta) — só gestor; só no fechamento
//        estoque_historico/custos_vigentes        último custo cadastrado conhecido (base do delta) — ninguém lê pelo app
//        estoque_historico/estado                 ponteiro de idempotência
// Regras: sem histórico inventado (só dias com snapshot real); idempotente por dia; um único lote atômico por consolidação.
// "Estoque registrado" é o saldo do ERP: NÃO é contagem física.
const { dataComercial, somarDias, parseData, numero, fatosDeVenda, situacaoCompra, TZ_COMERCIAL } = require('./canonico');
const { problemasFirestore } = require('./docCompat');
const { POLITICA_VIGENTE } = require('./politica');

const VERSAO = 1;
const COLECAO_DIA = 'estoque_snapshots';
const COLECAO = 'estoque_historico';
// Parâmetros de INFRAESTRUTURA do histórico (não são regra de compra; os limiares de cobertura/excesso vêm da política vigente).
const CFG = Object.freeze({
  janela_dias: 90,                 // janela das métricas (e leituras por consolidação: janela + 1)
  queda_maxima: 0.30,              // produtos a menos que a referência acima disso ⇒ leitura suspeita
  nulos_maximo: 0.005,             // fração máxima de saldos ilegíveis
  amostra_minima_comparacao: 20,   // comparações proporcionais só com referência deste tamanho
  dias_minimos_giro: 14,
  hora_fechamento: 18,             // último saldo do dia antes desta hora ⇒ marcado como fechamento parcial
  itens_por_lista: 20,
  serie_valor_max: 400,
  lote_max_bytes: 8 * 1024 * 1024,
  lote_max_ops: 450,
});
const AVISOS = Object.freeze([
  'ESTOQUE REGISTRADO no ERP: não é contagem física conferida',
  'Vendas e entradas são as registradas no ERP; entrada = compra Confirmada na data da última modificação (a API não informa recebimento)',
  'Entradas/saídas INFERIDAS = variação do saldo não explicada por vendas e entradas (ajuste, devolução, edição retroativa ou defasagem de horário)',
  'Itens de venda sem produto cadastrado não entram',
  'Métricas só sobre dias com snapshot real; dias ausentes não são reconstruídos',
]);
const COLUNAS_PRODUTO = Object.freeze(['id', 'abc', 'saldo', 'vend30', 'vend90', 'ent90', 'obs30', 'sem30', 'obs', 'sem', 'sem_seguidos', 'cobertura', 'giro', 'excesso_un', 'risco', 'inf_ent', 'inf_sai']);

const EPS = 1e-9;
const r3 = x => Math.round(x * 1000) / 1000;
const soma = xs => xs.reduce((s, x) => s + x, 0);
const bytes = v => Buffer.byteLength(JSON.stringify(v));

// ── 1) Validação da origem ──────────────────────────────────────────────────────────────────────────────────────────
/** Pura. `referencia` = snapshot válido anterior (mesmo dia mais cedo ou dia anterior); sem referência valem só as checagens internas. */
function validarOrigemEstoque(snap, referencia = null) {
  const saldos = snap && snap.saldos;
  if (!saldos || typeof saldos !== 'object') return { ok: false, motivos: ['SALDOS_AUSENTES'], produtos: 0, ilegiveis: 0 };
  const motivos = [], ids = Object.keys(saldos), n = ids.length;
  if (!n) motivos.push('LEITURA_VAZIA');
  if (snap.produtos_total !== n) motivos.push('IDS_DUPLICADOS_OU_AUSENTES');
  if (ids.some(i => !i || i === 'null' || i === 'undefined')) motivos.push('ID_INVALIDO');
  const ilegiveis = ids.filter(i => !Number.isFinite(saldos[i])).length;
  if (n && ilegiveis / n > CFG.nulos_maximo) motivos.push('SALDOS_ILEGIVEIS');
  const ref = referencia && referencia.saldos ? Object.values(referencia.saldos) : null;
  if (ref && ref.length >= CFG.amostra_minima_comparacao) {
    if ((ref.length - n) / ref.length > CFG.queda_maxima) motivos.push('QUEDA_DE_PRODUTOS');
    const positivos = xs => xs.filter(v => v > 0).length;
    if (n && positivos(ref) / ref.length > 0.3 && positivos(Object.values(saldos)) / n < 0.05) motivos.push('SALDOS_ZERADOS_EM_MASSA');
  }
  return { ok: motivos.length === 0, motivos, produtos: n, ilegiveis };
}

const lerDoc = async (db, col, id) => { const s = await db.collection(col).doc(id).get(); return s.exists ? s.data() : null; };

/** Referência para validar o saldo de hoje: o próprio dia (sync anterior) ou, se não houver, o dia anterior. 1–2 leituras. */
async function lerReferencia(db, dia) {
  return (await lerDoc(db, COLECAO_DIA, dia)) || (await lerDoc(db, COLECAO_DIA, somarDias(dia, -1)));
}

// ── 2) Movimentos registrados (a partir da base compacta do sync) ───────────────────────────────────────────────────
function acumular(mapa, dia, id, qtd) {
  let m = mapa.get(dia); if (!m) mapa.set(dia, (m = new Map()));
  m.set(id, (m.get(id) || 0) + qtd);
}
/** vendas: demanda (baixou estoque, não cancelada) por data da venda · entradas: compra CONFIRMADA por data da última modificação. */
function indexarMovimentos(base) {
  const vendas = new Map(), entradas = new Map();
  for (const v of (base && base.vendas) || []) {
    for (const f of fatosDeVenda(v)) if (f.counts_as_demand && f.product_id && f.qty > 0) acumular(vendas, f.date, f.product_id, f.qty);
  }
  for (const w of (base && base.compras) || []) {
    const c = w.Compra || w;
    if (situacaoCompra(c.nome_situacao) !== 'CONFIRMADA') continue;
    const dia = parseData(c.modificado_em) || parseData(c.data_emissao);
    if (!dia) continue;
    for (const p of c.produtos || []) {
      const it = p.produto || p, q = numero(it.quantidade);
      if (it.produto_id != null && q > 0) acumular(entradas, dia, String(it.produto_id), q);
    }
  }
  return { vendas, entradas };
}

function horaLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ_COMERCIAL, hour: '2-digit', hourCycle: 'h23' }).format(d));
}
function fechamentoParcial(doc, dia) {
  if (!doc.gerado_em) return true;
  const h = horaLocal(doc.gerado_em);
  return dataComercial(new Date(doc.gerado_em)) === dia && h !== null && h < CFG.hora_fechamento;
}

/** Fluxo de UM dia: vendas e entradas registradas (esparsas) e resíduo inferido (só se o dia anterior existir). Pura. */
function calcularFluxoDoDia({ dia, doc, anterior = null, movimentos, origem, consolidadoEm }) {
  const saldos = doc.saldos, ids = Object.keys(saldos);
  const mv = movimentos.vendas.get(dia) || new Map(), me = movimentos.entradas.get(dia) || new Map();
  const v = {}, e = {}, aj = {};
  for (const id of ids) {
    const qv = mv.get(id) || 0, qe = me.get(id) || 0;
    if (qv) v[id] = r3(qv);
    if (qe) e[id] = r3(qe);
    if (!anterior) continue;
    const s0 = anterior.saldos[id], s1 = saldos[id];
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;      // produto novo/ilegível: não se infere nada
    const resto = (s1 - s0) - (qe - qv);
    if (Math.abs(resto) > EPS) aj[id] = r3(resto);
  }
  const valores = Object.values(saldos).filter(Number.isFinite), ajustes = Object.values(aj);
  return {
    fluxo_json: JSON.stringify({ v, e, aj }),
    fluxo: {
      versao: VERSAO, origem, consolidado_em: consolidadoEm, anterior: anterior ? somarDias(dia, -1) : null,
      fechamento_parcial: fechamentoParcial(doc, dia),
      vendas_un: r3(soma(Object.values(v))), entradas_un: r3(soma(Object.values(e))),
      inferido_entrada_un: anterior ? r3(soma(ajustes.filter(x => x > 0))) : null,
      inferido_saida_un: anterior ? r3(-soma(ajustes.filter(x => x < 0))) : null,
      produtos_com_ajuste: anterior ? ajustes.length : null,
      unidades_em_estoque: r3(soma(valores.map(x => Math.max(0, x)))),
      sem_estoque: valores.filter(x => x <= 0).length, negativos: valores.filter(x => x < 0).length,
    },
  };
}

// ── 3) Métricas por produto e resumos ───────────────────────────────────────────────────────────────────────────────
/** Totais por produto numa janela de calendário (uma passada; evita varrer o histórico por produto). */
function totaisPorProduto(mapaPorDia, depoisDe, ate) {
  const t = new Map();
  for (const [dia, m] of mapaPorDia) if (dia > depoisDe && dia <= ate) for (const [id, q] of m) t.set(id, (t.get(id) || 0) + q);
  return t;
}

/**
 * Métricas por produto na janela que termina em `diaBase`.
 * @param dias       [{dia, saldos, fluxo:{v,e,aj}}] — só dias com snapshot válido, em ordem crescente
 * @param porId      Map product_id → métricas do motor (velocidade da política, ABC, código)
 */
function calcularMetricas({ diaBase, dias, movimentos, porId, politica = POLITICA_VIGENTE }) {
  const lim = politica.coverage_indicators;
  const base = dias[dias.length - 1];
  const ini30 = somarDias(diaBase, -30), ini90 = somarDias(diaBase, -CFG.janela_dias);
  const v30 = totaisPorProduto(movimentos.vendas, ini30, diaBase), v90 = totaisPorProduto(movimentos.vendas, ini90, diaBase), e90 = totaisPorProduto(movimentos.entradas, ini90, diaBase);
  return Object.keys(base.saldos).sort().map(id => {
    const m = porId.get(id) || {};
    const saldo = Number.isFinite(base.saldos[id]) ? base.saldos[id] : null;
    let obs = 0, sem = 0, obs30 = 0, sem30 = 0, somaEstoque = 0, vendObs = 0, infEnt = 0, infSai = 0;
    for (const d of dias) {
      const s = d.saldos[id];
      if (!Number.isFinite(s)) continue;
      obs++; somaEstoque += Math.max(0, s); vendObs += d.fluxo.v[id] || 0;
      if (s <= 0) sem++;
      if (d.dia > ini30) { obs30++; if (s <= 0) sem30++; }
      const a = d.fluxo.aj[id] || 0;
      if (a > 0) infEnt += a; else infSai -= a;
    }
    let semSeguidos = 0, esperado = diaBase;
    for (let i = dias.length - 1; i >= 0; i--) {            // sequência atual: dias consecutivos (um buraco interrompe)
      const s = dias[i].saldos[id];
      if (dias[i].dia !== esperado || !Number.isFinite(s) || s > 0) break;
      semSeguidos++; esperado = somarDias(esperado, -1);
    }
    const disponivel = saldo === null ? null : Math.max(0, saldo);
    const vel = m.policy_velocity > 0 ? m.policy_velocity : null;
    const vend90 = r3(v90.get(id) || 0);
    const cobertura = vel && disponivel !== null ? Math.round(disponivel / vel * 10) / 10 : null;
    const media = obs ? somaEstoque / obs : 0;
    const giro = obs >= CFG.dias_minimos_giro && media > 0 ? Math.round(vendObs / media * (365 / obs) * 100) / 100 : null;
    const excesso = cobertura !== null && cobertura > lim.excess_above_days ? Math.floor(disponivel - vel * lim.excess_above_days + EPS) : 0;
    let risco;
    if (saldo === null) risco = 'SALDO_ILEGIVEL';
    else if (saldo <= 0) risco = vend90 > 0 ? 'RUPTURA' : 'SEM_ESTOQUE_SEM_DEMANDA';
    else if (vend90 <= 0) risco = 'SEM_DEMANDA';
    else if (cobertura === null) risco = 'SEM_VELOCIDADE';
    else if (cobertura < lim.critical_below_days) risco = 'CRITICO';
    else if (cobertura < lim.low_below_days) risco = 'BAIXO';
    else risco = cobertura > lim.excess_above_days ? 'EXCESSO' : 'OK';
    return {
      id, codigo: m.code || null, abc: m.abc_revenue || null, saldo, vend30: r3(v30.get(id) || 0), vend90, ent90: r3(e90.get(id) || 0),
      obs30, sem30, obs, sem, sem_seguidos: semSeguidos, cobertura, giro, excesso_un: excesso, risco, inf_ent: r3(infEnt), inf_sai: r3(infSai),
      venda_observada: r3(vendObs), estoque_medio: r3(media),
    };
  });
}

const contarPor = (xs, f) => xs.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
const ORDEM_ABC = { A: 0, B: 1, C: 2, SEM_VENDA: 3 };
const porAbc = x => (x in ORDEM_ABC ? ORDEM_ABC[x] : 4);
const enxuto = (m, extras) => ({ id: m.id, codigo: m.codigo, abc: m.abc, saldo: m.saldo, ...Object.fromEntries(extras.map(k => [k, m[k]])) });

function montarResumo({ diaBase, dias, metricas, diasFaltantes, diasInvalidos, geradoEm, politicaVersao }) {
  const topo = (f, ordem, extras) => metricas.filter(f).sort((a, b) => ordem(a, b) || a.id.localeCompare(b.id)).slice(0, CFG.itens_por_lista).map(m => enxuto(m, extras));
  const comDemanda = metricas.filter(m => m.vend90 > 0);
  const taxa = classe => {
    const xs = comDemanda.filter(m => !classe || m.abc === classe), obs = soma(xs.map(m => m.obs));
    return obs ? Math.round(soma(xs.map(m => m.sem)) / obs * 1000) / 10 : null;
  };
  const comGiro = metricas.filter(m => m.obs >= CFG.dias_minimos_giro);
  const medioTotal = soma(comGiro.map(m => m.estoque_medio));
  const giroUn = medioTotal > 0 ? Math.round(soma(comGiro.map(m => m.venda_observada / m.obs)) * 365 / medioTotal * 100) / 100 : null;
  const excesso = metricas.filter(m => m.excesso_un > 0), semDemanda = metricas.filter(m => m.risco === 'SEM_DEMANDA');
  return {
    versao: VERSAO, policy_version: politicaVersao, gerado_em: geradoEm, dia_base: diaBase, avisos: AVISOS,
    janela: { dias: CFG.janela_dias, dias_observados: dias.length, primeiro_dia: dias[0].dia, ultimo_dia: diaBase, dias_faltantes: diasFaltantes, dias_invalidos: diasInvalidos, fechamentos_parciais: dias.filter(d => d.resumo.fechamento_parcial).map(d => d.dia) },
    totais: {
      produtos: metricas.length, unidades_registradas: r3(soma(metricas.map(m => Math.max(0, m.saldo || 0)))),
      sem_estoque: metricas.filter(m => m.saldo !== null && m.saldo <= 0).length, negativos: metricas.filter(m => m.saldo < 0).length,
      risco: contarPor(metricas, m => m.risco),
      ruptura_por_abc: contarPor(metricas.filter(m => m.risco === 'RUPTURA'), m => m.abc || 'SEM_CLASSE'),
      taxa_produto_dias_sem_estoque_pct: { geral: taxa(null), A: taxa('A'), B: taxa('B'), C: taxa('C') },
      excesso: { produtos: excesso.length, unidades: soma(excesso.map(m => m.excesso_un)) },
      sem_demanda_90d: { produtos: semDemanda.length, unidades: r3(soma(semDemanda.map(m => m.saldo))) },
      vendas_un_30d: r3(soma(metricas.map(m => m.vend30))), vendas_un_90d: r3(soma(metricas.map(m => m.vend90))), entradas_un_90d: r3(soma(metricas.map(m => m.ent90))),
      inferido_entrada_un: r3(soma(metricas.map(m => m.inf_ent))), inferido_saida_un: r3(soma(metricas.map(m => m.inf_sai))),
      giro_anual_unidades: giroUn,
    },
    serie: dias.map(d => ({ d: d.dia, origem: d.resumo.origem, unidades: d.resumo.unidades_em_estoque, sem_estoque: d.resumo.sem_estoque, vendas: d.resumo.vendas_un, entradas: d.resumo.entradas_un, inferido_entrada: d.resumo.inferido_entrada_un, inferido_saida: d.resumo.inferido_saida_un })),
    listas: {
      risco_ruptura: topo(m => m.risco === 'RUPTURA' || m.risco === 'CRITICO', (a, b) => porAbc(a.abc) - porAbc(b.abc) || b.vend90 - a.vend90, ['risco', 'vend90', 'cobertura', 'sem_seguidos']),
      mais_dias_sem_estoque: topo(m => m.sem > 0 && m.vend90 > 0, (a, b) => b.sem - a.sem || porAbc(a.abc) - porAbc(b.abc) || b.vend90 - a.vend90, ['sem', 'obs', 'sem_seguidos', 'vend90']),
      excesso: topo(m => m.excesso_un > 0, (a, b) => b.excesso_un - a.excesso_un, ['excesso_un', 'cobertura', 'vend90']),
      variacao_nao_explicada: topo(m => m.inf_ent + m.inf_sai > 0, (a, b) => (b.inf_ent + b.inf_sai) - (a.inf_ent + a.inf_sai), ['inf_ent', 'inf_sai']),
    },
  };
}

/** Capital a custo CADASTRADO (indicativo) do dia fechado, delta de custos e resumo financeiro. Pura. */
function montarValor({ diaBase, metricas, custosPorId, custosAnteriores = {}, serieAnterior = [], geradoEm }) {
  const custos = {};
  for (const [id, c] of custosPorId) if (c > 0) custos[id] = c;
  const mudancas = {};
  for (const [id, c] of Object.entries(custos)) if (custosAnteriores[id] !== c) mudancas[id] = c;
  for (const id of Object.keys(custosAnteriores)) if (!(id in custos)) mudancas[id] = null;
  const linhas = metricas.map(m => {
    const c = custos[m.id] || null, un = Math.max(0, m.saldo || 0);
    return { m, c, capital: c ? Math.round(un * c) : 0, excesso: c ? Math.round(m.excesso_un * c) : 0, semDemanda: c && m.risco === 'SEM_DEMANDA' ? Math.round(un * c) : 0, semCusto: !c && un > 0 };
  });
  const porClasse = {};
  for (const l of linhas) { const k = l.m.abc || 'SEM_CLASSE'; porClasse[k] = (porClasse[k] || 0) + l.capital; }
  const atual = {
    capital_cents: soma(linhas.map(l => l.capital)), capital_excesso_cents: soma(linhas.map(l => l.excesso)), capital_sem_demanda_cents: soma(linhas.map(l => l.semDemanda)),
    capital_por_abc_cents: porClasse, produtos_com_estoque_sem_custo: linhas.filter(l => l.semCusto).length,
  };
  const comGiro = linhas.filter(l => l.c && l.m.obs >= CFG.dias_minimos_giro);
  const medio = soma(comGiro.map(l => l.m.estoque_medio * l.c));
  const giro = medio > 0 ? Math.round(soma(comGiro.map(l => l.m.venda_observada / l.m.obs * l.c)) * 365 / medio * 100) / 100 : null;
  const aviso = 'Valores INDICATIVOS: custo cadastrado no ERP no momento do fechamento, aplicado ao saldo registrado (não é contagem física nem valor contábil)';
  const ponto = { d: diaBase, capital_cents: atual.capital_cents, excesso_cents: atual.capital_excesso_cents, sem_demanda_cents: atual.capital_sem_demanda_cents };
  const serie = [...serieAnterior.filter(x => x.d !== diaBase), ponto].sort((a, b) => a.d.localeCompare(b.d)).slice(-CFG.serie_valor_max);
  const topo = campo => linhas.filter(l => l[campo] > 0).sort((a, b) => b[campo] - a[campo] || a.m.id.localeCompare(b.m.id)).slice(0, CFG.itens_por_lista)
    .map(l => ({ ...enxuto(l.m, ['cobertura', 'excesso_un', 'vend90']), valor_cents: l[campo] }));
  return {
    doDia: { versao: VERSAO, dia: diaBase, gerado_em: geradoEm, aviso, ...atual, custos_alterados_json: JSON.stringify(mudancas), custos_alterados: Object.keys(mudancas).length },
    vigentes: { versao: VERSAO, dia: diaBase, gerado_em: geradoEm, custos_json: JSON.stringify(custos) },
    resumo: { versao: VERSAO, dia_base: diaBase, gerado_em: geradoEm, aviso, atual, giro_anual_a_custo: giro, serie, listas: { maior_capital: topo('capital'), maior_excesso: topo('excesso'), maior_sem_demanda: topo('semDemanda') } },
  };
}

// ── 4) Consolidação (I/O) ───────────────────────────────────────────────────────────────────────────────────────────
async function emBlocos(xs, n, f) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(f)));
  return out;
}

async function consolidar({ db, snap, agora, politica }) {
  const hoje = snap.snapshotEstoque.data_comercial, alvo = somarDias(hoje, -1);   // só dias FECHADOS
  let leituras = 1;
  const estado = await lerDoc(db, COLECAO, 'estado');
  if (estado && estado.versao === VERSAO && estado.verificado_ate >= alvo) return { ok: true, pulado: 'JA_CONSOLIDADO', dia_base: estado.dia_base || null, leituras, escritas: 0 };

  const datas = Array.from({ length: CFG.janela_dias + 1 }, (_, i) => somarDias(alvo, i - CFG.janela_dias));
  const docs = await emBlocos(datas, 15, d => lerDoc(db, COLECAO_DIA, d));
  leituras += datas.length;
  const movimentos = indexarMovimentos(snap.base);
  const geradoEm = agora.toISOString();
  const validos = new Map(), diasInvalidos = [];
  datas.forEach((dia, i) => {
    const doc = docs[i];
    if (!doc) return;
    // referência = SÓ o dia imediatamente anterior válido: uma mudança real e persistente do catálogo não bloqueia os dias seguintes
    if (!validarOrigemEstoque(doc, validos.get(somarDias(dia, -1)) || null).ok) { diasInvalidos.push(dia); return; }
    validos.set(dia, doc);
  });

  const dias = [], escritas = [];
  for (const dia of datas.slice(1)) {
    const doc = validos.get(dia);
    if (!doc) continue;
    let { fluxo_json: fj, fluxo } = doc;
    if (!fj || !fluxo || fluxo.versao !== VERSAO) {            // dia já consolidado NUNCA é recalculado (preserva o observado no fechamento)
      const novo = calcularFluxoDoDia({ dia, doc, anterior: validos.get(somarDias(dia, -1)) || null, movimentos, origem: dia === alvo ? 'FECHAMENTO' : 'RETROATIVO', consolidadoEm: geradoEm });
      fj = novo.fluxo_json; fluxo = novo.fluxo;
      escritas.push([COLECAO_DIA, dia, { ...doc, ...novo }]);
    }
    dias.push({ dia, saldos: doc.saldos, fluxo: JSON.parse(fj), resumo: fluxo });
  }
  const diasConsolidados = escritas.length;
  const diaBase = dias.length ? dias[dias.length - 1].dia : null;

  if (diaBase) {
    const porId = new Map(snap.operacional.map(m => [m.product_id, m]));
    const metricas = calcularMetricas({ diaBase, dias, movimentos, porId, politica });
    const primeiro = dias[0].dia, presentes = new Set(dias.map(d => d.dia));
    const faltantes = datas.filter(d => d >= primeiro && !presentes.has(d));
    escritas.push([COLECAO, 'resumo', montarResumo({ diaBase, dias, metricas, diasFaltantes: faltantes, diasInvalidos, geradoEm, politicaVersao: politica.policy_version })]);
    escritas.push([COLECAO, 'produtos', { versao: VERSAO, dia_base: diaBase, gerado_em: geradoEm, colunas: [...COLUNAS_PRODUTO], total: metricas.length, linhas_json: JSON.stringify(metricas.map(m => COLUNAS_PRODUTO.map(c => m[c]))) }]);
    if (diaBase === alvo) {                                    // capital só no fechamento: custo de dias passados não é conhecido
      const [vig, ant] = [await lerDoc(db, COLECAO, 'custos_vigentes'), await lerDoc(db, COLECAO, 'resumo_valor')];
      leituras += 2;
      const jaFeito = vig && vig.dia >= alvo;                  // reprocessamento: não sobrescreve o delta do dia com um delta vazio
      if (!jaFeito) {
        const v = montarValor({ diaBase, metricas, custosPorId: new Map(snap.custos.map(c => [c.product_id, c.registered_cost_cents])), custosAnteriores: vig ? JSON.parse(vig.custos_json) : {}, serieAnterior: ant ? ant.serie || [] : [], geradoEm });
        escritas.push([COLECAO, 'valor_' + diaBase, v.doDia], [COLECAO, 'custos_vigentes', v.vigentes], [COLECAO, 'resumo_valor', v.resumo]);
      }
    }
  }
  escritas.push([COLECAO, 'estado', { versao: VERSAO, verificado_ate: alvo, dia_base: diaBase, gerado_em: geradoEm, dias_na_janela: dias.length }]);

  for (const [c, id, v] of escritas) {
    const p = problemasFirestore(v);
    if (p.length) { const e = new Error(`HISTORICO_DOC_INCOMPATIVEL ${c}/${id}: ${p[0]}`); e.codigo = 'HISTORICO_DOC_INCOMPATIVEL'; throw e; }
  }
  const total = soma(escritas.map(x => bytes(x[2])));
  if (total > CFG.lote_max_bytes || escritas.length > CFG.lote_max_ops) { const e = new Error('HISTORICO_LOTE_GRANDE_DEMAIS'); e.codigo = 'HISTORICO_LOTE_GRANDE_DEMAIS'; throw e; }
  const lote = db.batch();
  for (const [c, id, v] of escritas) lote.set(db.collection(c).doc(id), v);
  await lote.commit();                                         // tudo ou nada
  return { ok: true, dia_base: diaBase, verificado_ate: alvo, dias_consolidados: diasConsolidados, leituras, escritas: escritas.length, bytes: total };
}

/** Ponto de entrada do sync. NUNCA lança: uma falha aqui não desfaz nem marca como falho o snapshot de Compras. */
async function consolidarHistorico({ db, snap, agora = new Date(), politica = POLITICA_VIGENTE }) {
  try { return await consolidar({ db, snap, agora, politica }); }
  catch (e) { return { ok: false, erro: String((e && (e.codigo || e.message)) || 'ERRO').slice(0, 120) }; }
}

module.exports = { VERSAO, CFG, COLECAO, COLECAO_DIA, AVISOS, COLUNAS_PRODUTO, validarOrigemEstoque, lerReferencia, indexarMovimentos, totaisPorProduto, fechamentoParcial, calcularFluxoDoDia, calcularMetricas, montarResumo, montarValor, consolidarHistorico };
