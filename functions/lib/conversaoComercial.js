'use strict';
// COM-02 — Medição da conversão comercial: contatado → conversa → interesse → proposta → pedido → reativado → faturamento.
// PURO (sem I/O, sem relógio). Não grava nada e NÃO altera metas, comissões, carteiras, fila ou distribuição.
//
// Unidade de contagem: OPORTUNIDADE (opportunityInstanceId = cliente + tipo + última compra) e CLIENTE. Pedido NÃO é conversão:
// várias compras na janela continuam sendo UMA oportunidade convertida.
//
// Estágios (por oportunidade):
//   trabalhada   ≥ 1 resultado registrado (qualquer um)
//   contatada    ≥ 1 resultado diferente de CONTATO_INVALIDO (tentativa por canal válido; inclui SEM_RESPOSTA)
//   conversa     ≥ 1 CONVERSA_REALIZADA | PEDIU_RETORNO | SEM_INTERESSE_AGORA (o cliente respondeu)
//   interesse    meta.interesse do desfecho (captura nova). Sem captura = NÃO MEDIDO (nunca inferido)
//   proposta     meta.proposta do desfecho (captura nova). Sem captura = NÃO MEDIDO
//   convertida   ≥ 1 pedido válido atribuído (ver abaixo)
//   reativada    convertida cujo cliente estava há ≥ 120 dias sem compra válida no contato creditado
//
// Atribuição (correlação temporal, NÃO causalidade):
//   • contato qualificado = desfecho conforme a base ('CONVERSA' padrão | 'TENTATIVA');
//   • âncora = início do atendimento (CLAIMED do mesmo operador até 4h antes do desfecho) ou o próprio desfecho;
//   • pedido válido (carteiraRegra.validarVenda: Concretizada, com cliente, valor > 0), sem devolução TOTAL;
//   • 0 ≤ dias(contato → data do pedido) ≤ janela; pedido cadastrado ANTES da âncora já existia e não conta;
//     no mesmo dia só conta se o cadastro for posterior à âncora (política 'ordem');
//   • cada pedido vai para NO MÁXIMO uma oportunidade: a do contato qualificado mais recente antes dele (último toque).

const { validarVenda } = require('./carteiraRegra');
const { normalizeGestaoClickId } = require('./commercialIdentity');
const { diaComercial, LIMIAR_INATIVIDADE_DIAS } = require('./crmTimeline');

const OUTCOMES_CONVERSA = Object.freeze(['CONVERSA_REALIZADA', 'PEDIU_RETORNO', 'SEM_INTERESSE_AGORA']);
const OUTCOMES_TENTATIVA = Object.freeze([...OUTCOMES_CONVERSA, 'SEM_RESPOSTA']);
const BASES = Object.freeze({ CONVERSA: OUTCOMES_CONVERSA, TENTATIVA: OUTCOMES_TENTATIVA });
const POLITICAS_MESMO_DIA = Object.freeze(['ordem', 'incluir', 'excluir']);
const JANELA_PADRAO_DIAS = 14;
const JANELAS_SENSIBILIDADE = Object.freeze([7, 14, 30]);
const ATENDIMENTO_MAX_MS = 4 * 3600 * 1000;
const NAO_MEDIDO = 'NAO_MEDIDO';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const CADASTRO = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const dias = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const somarDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const centavos = v => Math.round(Number(v) * 100);
const taxa = (num, den) => (den > 0 ? num / den : null);
/** cadastrado_em do GestãoClick (hora local de Fortaleza, UTC-3) → epoch ms; null se ausente/ilegível. */
const cadastroMs = v => { const c = String((v && v.cadastrado_em) || ''); if (!CADASTRO.test(c)) return null; const t = Date.parse(c.replace(' ', 'T') + '-03:00'); return Number.isFinite(t) ? t : null; };

function gcIdDaEntidade(entidade, gcIdPorEntidade) {
  if (typeof entidade !== 'string') return null;
  if (entidade.startsWith('GC_NATIVE:')) return normalizeGestaoClickId(entidade.slice(10));
  const m = gcIdPorEntidade;
  const g = m ? (m instanceof Map ? m.get(entidade) : m[entidade]) : null;
  return g ? normalizeGestaoClickId(g) : null;
}

/** Resultados registrados de uma oportunidade, com a âncora (início do atendimento) e o dia comercial. Puro. */
function contatosDaOportunidade(estado) {
  const evs = (estado && estado.eventos) || [];
  const out = [];
  evs.forEach((e, i) => {
    if (!e || e.tipo !== 'OUTCOME_REGISTERED' || !e.timestamp || !Number.isFinite(Date.parse(e.timestamp))) return;
    const fim = Date.parse(e.timestamp);
    let ancora = fim;
    for (let j = i - 1; j >= 0; j--) {
      const a = evs[j];
      if (!a || a.operadorId !== e.operadorId) continue;
      if (a.tipo !== 'CLAIMED') break;                       // outro desfecho/liberação: este desfecho não tem início próprio
      const t = Date.parse(a.timestamp);
      if (Number.isFinite(t) && t <= fim && fim - t <= ATENDIMENTO_MAX_MS) ancora = t;
      break;
    }
    const meta = e.meta || {};
    out.push({
      opp: estado.opportunityInstanceId, outcome: e.outcome, operadorId: e.operadorId || null,
      em: e.timestamp, ancoraMs: ancora, dia: diaComercial(new Date(ancora).toISOString()),
      interesse: meta.interesse === 'SIM' || meta.interesse === 'NAO' ? meta.interesse : null,
      proposta: meta.proposta === 'SIM' || meta.proposta === 'NAO' ? meta.proposta : null,
    });
  });
  return out.sort((a, b) => a.ancoraMs - b.ancoraMs);
}

/**
 * Vendas utilizáveis, deduplicadas por id e agrupadas por cliente GC; inválidas ficam à parte com o motivo.
 * Devolução TOTAL invalida; PARCIAL mantém o pedido (não há valor devolvido registrado) e é marcada.
 */
function indexarVendas(vendas, { devolucoes, dataCorte }) {
  const porCliente = new Map(), invalidas = new Map(), vistos = new Set();
  for (const v of vendas || []) {
    const id = v && v.id != null ? String(v.id) : '';
    if (id && vistos.has(id)) continue;
    if (id) vistos.add(id);
    const gc = normalizeGestaoClickId(v && v.cliente_id);
    const data = String((v && v.data) || '').slice(0, 10);
    const dev = devolucoes ? (devolucoes instanceof Map ? devolucoes.get(id) : devolucoes[id]) : null;
    const motivo = validarVenda(v, dataCorte) || (dev === 'TOTAL' ? 'DEVOLUCAO_TOTAL' : null);
    const alvo = motivo ? invalidas : porCliente;
    if (!gc) continue;                                         // sem cliente nunca é atribuível
    if (!alvo.has(gc)) alvo.set(gc, []);
    alvo.get(gc).push({
      id, gc, data, motivo, valorC: centavos((v && v.valor_total) || 0), cadastroMs: cadastroMs(v),
      vendedorId: normalizeGestaoClickId(v.vendedor_id), parcial: dev === 'PARCIAL',
    });
  }
  for (const lista of porCliente.values()) lista.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : 1));
  return { porCliente, invalidas };
}

/** O pedido pode ter vindo deste contato? Devolve null (sim) ou o motivo da recusa. */
function recusaTemporal(venda, contato, janelaDias, mesmoDia) {
  const d = dias(contato.dia, venda.data);
  if (!(d >= 0 && d <= janelaDias)) return 'FORA_DA_JANELA';
  if (d === 0) {
    if (mesmoDia === 'incluir') return null;
    if (mesmoDia === 'excluir') return 'MESMO_DIA';
    if (venda.cadastroMs === null) return 'MESMO_DIA_SEM_HORA';
    return venda.cadastroMs > contato.ancoraMs ? null : 'PEDIDO_ANTERIOR_AO_CONTATO';
  }
  return venda.cadastroMs !== null && venda.cadastroMs <= contato.ancoraMs ? 'PEDIDO_ANTERIOR_AO_CONTATO' : null;
}

/** Dias sem compra válida no momento do contato. null = sem compra anterior conhecida. */
function diasParadoNoContato(contato, vendasCliente, ultimaForaDaCobertura) {
  let ultima = null;
  for (const v of vendasCliente || []) {
    const antes = v.data < contato.dia || (v.data === contato.dia && v.cadastroMs !== null && v.cadastroMs <= contato.ancoraMs);
    if (antes && (!ultima || v.data > ultima)) ultima = v.data;
  }
  if (!ultima && ultimaForaDaCobertura && YMD.test(ultimaForaDaCobertura) && ultimaForaDaCobertura < contato.dia) ultima = ultimaForaDaCobertura;
  return ultima ? dias(ultima, contato.dia) : null;
}

function validarOpcoes(o) {
  const janelaDias = o.janelaDias === undefined ? JANELA_PADRAO_DIAS : o.janelaDias;
  const base = o.base || 'CONVERSA', mesmoDia = o.mesmoDia || 'ordem';
  if (!Number.isInteger(janelaDias) || janelaDias < 0 || janelaDias > 365) throw new Error('janelaDias inválida');
  if (!BASES[base]) throw new Error('base inválida: ' + base);
  if (!POLITICAS_MESMO_DIA.includes(mesmoDia)) throw new Error('mesmoDia inválido: ' + mesmoDia);
  if (!YMD.test(String(o.dataCorte || ''))) throw new Error('dataCorte (YYYY-MM-DD) obrigatória: último dia com vendas sincronizadas');
  for (const k of ['inicio', 'fim']) if (o[k] !== undefined && o[k] !== null && !YMD.test(o[k])) throw new Error(k + ' inválido');
  return { janelaDias, base, mesmoDia, dataCorte: o.dataCorte, inicio: o.inicio || null, fim: o.fim || null, limiarDias: LIMIAR_INATIVIDADE_DIAS };
}

/** Resume um conjunto de oportunidades já classificadas. */
function resumir(opps) {
  const com = opps.filter(o => o.vinculo);
  const contatadas = opps.filter(o => o.contatada), conversa = opps.filter(o => o.conversa);
  const convertidas = opps.filter(o => o.pedidos.length), reativadas = opps.filter(o => o.reativada);
  const clientes = lista => new Set(lista.filter(o => o.vinculo).map(o => o.gc)).size;
  // coorte MADURA: com vínculo GC e janela encerrada para todos os contatos qualificados — único denominador honesto para taxas
  const mContatadas = com.filter(o => o.contatada && o.madura);
  const mConversa = mContatadas.filter(o => o.conversa);
  const mBase = mContatadas.filter(o => o.qualificada);
  const mConvertidas = mBase.filter(o => o.pedidos.length);
  const mInativas = mBase.filter(o => o.inativaNoContato);
  const mReativadas = mInativas.filter(o => o.reativada);

  const capturado = (campo) => {
    const informadas = conversa.filter(o => o[campo] !== null);
    const sim = informadas.filter(o => o[campo] === 'SIM').length;
    return {
      status: informadas.length ? (informadas.length === conversa.length ? 'MEDIDO' : 'PARCIAL') : NAO_MEDIDO,
      informadas: informadas.length, naoInformadas: conversa.length - informadas.length,
      sim: informadas.length ? sim : null, nao: informadas.length ? informadas.length - sim : null,
      taxaSobreInformadas: taxa(sim, informadas.length),
    };
  };
  const pedidos = convertidas.flatMap(o => o.pedidos);
  const soma = lista => lista.reduce((s, p) => s + p.valorC, 0) / 100;
  return {
    oportunidades: {
      trabalhadas: opps.length, semVinculoGc: opps.length - com.length, contatadas: contatadas.length, conversa: conversa.length,
      inativasNoContato: opps.filter(o => o.inativaNoContato).length, convertidas: convertidas.length, reativadas: reativadas.length,
      reativacaoIndeterminada: convertidas.filter(o => o.historicoDesconhecido).length,
    },
    maduras: { contatadas: mContatadas.length, conversa: mConversa.length, base: mBase.length, convertidas: mConvertidas.length, inativas: mInativas.length, reativadas: mReativadas.length },
    clientes: { contatados: clientes(contatadas), conversa: clientes(conversa), convertidos: clientes(convertidas), reativados: clientes(reativadas) },
    interesse: { ...capturado('interesse'), semInteresseDeclarado: conversa.filter(o => o.semInteresse).length },
    proposta: capturado('proposta'),
    pedidos: pedidos.length,
    pedidosMesmoVendedor: pedidos.filter(p => p.mesmoVendedor === true).length,
    pedidosVendedorNaoComparavel: pedidos.filter(p => p.mesmoVendedor === null).length,
    pedidosComDevolucaoParcial: pedidos.filter(p => p.parcial).length,
    faturamento: soma(pedidos),
    faturamentoPrimeiroPedido: soma(convertidas.map(o => o.pedidos[0])),
    faturamentoReativados: soma(reativadas.flatMap(o => o.pedidos)),
    taxas: {
      conversaSobreContatadas: taxa(mConversa.length, mContatadas.length),
      convertidasSobreBase: taxa(mConvertidas.length, mBase.length),          // base = conversa (padrão) ou tentativa
      convertidasSobreContatadas: taxa(mConvertidas.length, mContatadas.length),
      reativadasSobreInativas: taxa(mReativadas.length, mInativas.length),
    },
  };
}

/**
 * Funil completo.
 * @param {object} p
 * @param {object[]} p.estados           documentos de interacoes_fila
 * @param {object[]} p.vendas            documentos de vendas_gc (todos os clientes contatados, cobrindo ≥ 120 dias antes do 1º contato)
 * @param {Map|object} [p.devolucoes]    vendaId → 'TOTAL'|'PARCIAL'
 * @param {Map|object} [p.gcIdPorEntidade]  'MR4_LINKED:x' → gestaoClickId
 * @param {Map|object} [p.vendedorGcPorUid] uid → id do vendedor no GC (só para conferir "mesmo vendedor")
 * @param {Map|object} [p.ultimaCompraForaDaCobertura] gcId → YYYY-MM-DD da última compra anterior ao recorte de `vendas`
 * @param {string} [p.coberturaDesde]    data inicial do recorte de `vendas`. Informada, cliente sem compra anterior e ausente do mapa
 *                                        acima é "histórico desconhecido" se o mapa não foi fornecido
 * @param {object} p.opcoes              { janelaDias=14, base='CONVERSA', mesmoDia='ordem', dataCorte, inicio?, fim? }
 * @returns {{ parametros, total, porVendedor, pedidos, exclusoes }}  porVendedor: uid → resumo (cada oportunidade em UM vendedor);
 *          exclusoes: pedidos perto de algum contato qualificado que NÃO contaram, por motivo (todas as coortes)
 */
function calcularFunil(p) {
  const o = validarOpcoes(p.opcoes || {});
  const baseOk = new Set(BASES[o.base]);
  const { porCliente, invalidas } = indexarVendas(p.vendas, { devolucoes: p.devolucoes, dataCorte: o.dataCorte });
  const mapa = m => (k => (m ? (m instanceof Map ? m.get(k) : m[k]) : undefined));
  const vendedorGc = mapa(p.vendedorGcPorUid), anteriorFora = mapa(p.ultimaCompraForaDaCobertura);

  const vistos = new Set(), opps = [];
  for (const e of p.estados || []) {
    if (!e || !e.opportunityInstanceId || vistos.has(e.opportunityInstanceId)) continue;
    vistos.add(e.opportunityInstanceId);
    const contatos = contatosDaOportunidade(e).filter(c => c.dia <= o.dataCorte);
    if (!contatos.length) continue;
    const validos = contatos.filter(c => OUTCOMES_TENTATIVA.includes(c.outcome));
    const entrada = (validos[0] || contatos[0]).dia;           // coorte pela data do 1º contato
    const gc = gcIdDaEntidade(e.commercialEntityId, p.gcIdPorEntidade);
    const qualificados = validos.filter(c => baseOk.has(c.outcome));
    const conversas = validos.filter(c => OUTCOMES_CONVERSA.includes(c.outcome));
    const ultimoValor = campo => { const x = [...conversas].reverse().find(c => c[campo]); return x ? x[campo] : null; };
    const declarouSemInteresse = conversas.length > 0 && conversas[conversas.length - 1].outcome === 'SEM_INTERESSE_AGORA';
    const ref = qualificados.length ? qualificados : validos;
    const parados = gc ? ref.map(c => diasParadoNoContato(c, porCliente.get(gc), anteriorFora(gc))) : [];
    opps.push({
      opp: e.opportunityInstanceId, tipo: e.tipoOportunidade || null, gc, vinculo: !!gc, entrada,
      contatos: validos, qualificados,
      contatada: validos.length > 0, conversa: conversas.length > 0, qualificada: qualificados.length > 0,
      interesse: ultimoValor('interesse'),
      proposta: conversas.some(c => c.proposta === 'SIM') ? 'SIM' : ultimoValor('proposta'),
      semInteresse: declarouSemInteresse,
      madura: ref.length > 0 && somarDias(ref[ref.length - 1].dia, o.janelaDias) <= o.dataCorte,
      inativaNoContato: parados.some(d => d !== null && d >= o.limiarDias),
      pedidos: [], reativada: false, historicoDesconhecido: false,
      ultimoOperador: (validos[validos.length - 1] || contatos[contatos.length - 1]).operadorId,
      operadores: new Set(contatos.map(c => c.operadorId)),
    });
  }

  // atribuição: para cada pedido válido, o contato qualificado mais recente (último toque) — no máximo uma oportunidade
  const porGc = new Map();
  for (const x of opps) if (x.gc) { if (!porGc.has(x.gc)) porGc.set(x.gc, []); porGc.get(x.gc).push(x); }
  const pedidos = [], exclusoes = {};
  const excluir = motivo => { exclusoes[motivo] = (exclusoes[motivo] || 0) + 1; };
  for (const [gc, doCliente] of porGc) {
    const contatos = doCliente.flatMap(x => x.qualificados.map(c => ({ c, x })));
    if (!contatos.length) continue;
    for (const v of porCliente.get(gc) || []) {
      const avaliados = contatos.map(k => ({ ...k, recusa: recusaTemporal(v, k.c, o.janelaDias, o.mesmoDia) }));
      const validos = avaliados.filter(k => !k.recusa)
        .sort((a, b) => (b.c.ancoraMs - a.c.ancoraMs) || (a.x.opp < b.x.opp ? -1 : a.x.opp > b.x.opp ? 1 : 0));
      if (!validos.length) {
        const dentro = avaliados.find(k => k.recusa !== 'FORA_DA_JANELA');
        if (dentro) excluir(dentro.recusa);
        continue;
      }
      const { c, x } = validos[0];
      const parado = diasParadoNoContato(c, porCliente.get(gc), anteriorFora(gc));
      const gcOperador = normalizeGestaoClickId(vendedorGc(c.operadorId));
      const pedido = {
        vendaId: v.id, opp: x.opp, gc, data: v.data, valorC: v.valorC, valor: v.valorC / 100, parcial: v.parcial,
        contatoDia: c.dia, contatoOutcome: c.outcome, operadorId: c.operadorId, diasAposContato: dias(c.dia, v.data),
        diasParadoNoContato: parado,
        mesmoVendedor: gcOperador && v.vendedorId ? gcOperador === v.vendedorId : null,
      };
      x.pedidos.push(pedido); pedidos.push(pedido);
      if (parado !== null && parado >= o.limiarDias) x.reativada = true;
      if (parado === null && p.coberturaDesde && !p.ultimaCompraForaDaCobertura) x.historicoDesconhecido = true;
    }
    for (const v of invalidas.get(gc) || []) {
      if (contatos.some(k => { const d = dias(k.c.dia, v.data); return d >= 0 && d <= o.janelaDias; })) excluir(v.motivo);
    }
  }
  for (const x of opps) {
    x.pedidos.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.vendaId < b.vendaId ? -1 : 1));
    x.vendedor = x.pedidos.length ? x.pedidos[0].operadorId : x.ultimoOperador;   // convertida → quem fez o contato do 1º pedido
  }

  // O recorte de período é aplicado DEPOIS da atribuição: assim recortes vizinhos nunca contam o mesmo pedido duas vezes.
  const coorte = opps.filter(x => (!o.inicio || x.entrada >= o.inicio) && (!o.fim || x.entrada <= o.fim));
  const porVendedor = {};
  for (const uid of [...new Set(coorte.map(x => x.vendedor))].sort()) porVendedor[uid] = resumir(coorte.filter(x => x.vendedor === uid));
  return {
    parametros: o,
    total: { ...resumir(coorte), oportunidadesComMaisDeUmVendedor: coorte.filter(x => x.operadores.size > 1).length },
    porVendedor, pedidos: coorte.flatMap(x => x.pedidos), exclusoes,
  };
}

/** Mesma entrada, variando janela × base × política do mesmo dia. Uma linha por combinação. */
function sensibilidade(p, { janelas = JANELAS_SENSIBILIDADE, bases = ['CONVERSA', 'TENTATIVA'], mesmoDia = POLITICAS_MESMO_DIA } = {}) {
  const linhas = [];
  for (const base of bases) for (const politica of mesmoDia) for (const janelaDias of janelas) {
    const r = calcularFunil({ ...p, opcoes: { ...p.opcoes, janelaDias, base, mesmoDia: politica } }).total;
    linhas.push({
      base, mesmoDia: politica, janelaDias, convertidas: r.oportunidades.convertidas, reativadas: r.oportunidades.reativadas,
      pedidos: r.pedidos, faturamento: r.faturamento, madurasBase: r.maduras.base, madurasConvertidas: r.maduras.convertidas, taxa: r.taxas.convertidasSobreBase,
    });
  }
  return linhas;
}

// ── Linha de base ("compraria de qualquer forma") ──────────────────────────────────────────────────────────────
const faixaRecencia = d => (d < 15 ? '0-14' : d < 30 ? '15-29' : d < 60 ? '30-59' : d < 120 ? '60-119' : '120+');
const faixaFrequencia = n => (n <= 0 ? '0' : n === 1 ? '1' : n <= 3 ? '2-3' : n <= 9 ? '4-9' : '10+');

/** Estrato do cliente na véspera-limite do dia D (só compras ANTERIORES a D): recência × pedidos nos 180 dias anteriores. */
function estratoEm(vendasCliente, dia) {
  let ultima = null, n = 0;
  const desde = somarDias(dia, -180);
  for (const v of vendasCliente) if (v.data < dia) { if (!ultima || v.data > ultima) ultima = v.data; if (v.data >= desde) n++; }
  return ultima ? faixaRecencia(dias(ultima, dia)) + '|' + faixaFrequencia(n) : null;
}

/**
 * Comparação observacional: clientes contatados × clientes NUNCA registrados na fila, no mesmo estrato e no mesmo dia.
 * Resultado dos dois lados = ao menos um pedido válido em (D, D+janela] (o dia D fica fora para ambos).
 * `grupo`: 'CONVERSA' (cliente respondeu) ou 'SEM_RESPOSTA' (só tentativas) — D = 1º contato do grupo.
 * NÃO é experimento: quem entra na fila é escolhido por regra e quem fica fora pode ser atendido por outros canais.
 */
function linhaDeBase(p) {
  const o = validarOpcoes(p.opcoes || {});
  const { porCliente } = indexarVendas(p.vendas, { devolucoes: p.devolucoes, dataCorte: o.dataCorte });
  const tratados = new Map();      // gc → { conversa: dia|null, tentativa: dia }
  const naFila = new Set();
  for (const e of p.estados || []) {
    const gc = gcIdDaEntidade(e && e.commercialEntityId, p.gcIdPorEntidade);
    if (!gc) continue;
    naFila.add(gc);                // qualquer registro (mesmo só claim ou contato inválido) tira o cliente do controle
    for (const c of contatosDaOportunidade(e)) {
      if (!OUTCOMES_TENTATIVA.includes(c.outcome) || (o.inicio && c.dia < o.inicio) || (o.fim && c.dia > o.fim)) continue;
      const t = tratados.get(gc) || { conversa: null, tentativa: null };
      if (!t.tentativa || c.dia < t.tentativa) t.tentativa = c.dia;
      if (OUTCOMES_CONVERSA.includes(c.outcome) && (!t.conversa || c.dia < t.conversa)) t.conversa = c.dia;
      tratados.set(gc, t);
    }
  }
  const comprou = (gc, d) => (porCliente.get(gc) || []).some(v => v.data > d && v.data <= somarDias(d, o.janelaDias));
  const controles = [...porCliente.keys()].filter(gc => !naFila.has(gc));
  const cache = new Map();
  const taxasDoDia = d => {
    if (cache.has(d)) return cache.get(d);
    const m = new Map();
    for (const gc of controles) {
      const s = estratoEm(porCliente.get(gc), d); if (!s) continue;
      const x = m.get(s) || { n: 0, k: 0 }; x.n++; if (comprou(gc, d)) x.k++; m.set(s, x);
    }
    cache.set(d, m); return m;
  };
  const grupo = (nome, diaDe) => {
    let avaliados = 0, observados = 0, esperados = 0, semControle = 0, imaturos = 0, semHistorico = 0;
    const porRecencia = {};
    for (const [gc, t] of tratados) {
      const d = diaDe(t); if (!d) continue;
      if (somarDias(d, o.janelaDias) > o.dataCorte) { imaturos++; continue; }
      const s = estratoEm(porCliente.get(gc) || [], d); if (!s) { semHistorico++; continue; }
      const c = taxasDoDia(d).get(s);
      if (!c || c.n < (p.minimoControles || 5)) { semControle++; continue; }
      const ok = comprou(gc, d) ? 1 : 0, esp = c.k / c.n;
      avaliados++; observados += ok; esperados += esp;
      const r = s.split('|')[0], x = porRecencia[r] || { avaliados: 0, observados: 0, esperados: 0 };
      x.avaliados++; x.observados += ok; x.esperados += esp; porRecencia[r] = x;
    }
    return { grupo: nome, avaliados, observados, esperados, taxaObservada: taxa(observados, avaliados), taxaEsperada: taxa(esperados, avaliados), semControle, imaturos, semHistorico, porRecencia };
  };
  return {
    parametros: o, controlesElegiveis: controles.length,
    grupos: [grupo('CONVERSA', t => t.conversa), grupo('SEM_RESPOSTA', t => (t.conversa ? null : t.tentativa))],
    aviso: 'CORRELAÇÃO, NÃO CAUSALIDADE: comparação observacional por estrato; não substitui grupo de controle sorteado.',
  };
}

module.exports = {
  OUTCOMES_CONVERSA, OUTCOMES_TENTATIVA, JANELA_PADRAO_DIAS, JANELAS_SENSIBILIDADE, NAO_MEDIDO,
  contatosDaOportunidade, indexarVendas, recusaTemporal, calcularFunil, sensibilidade, linhaDeBase, estratoEm,
};
