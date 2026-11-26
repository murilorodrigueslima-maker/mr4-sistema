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
// Etapas separadas (campo `etapas`): contatado → interessado → proposta apresentada → pedido realizado (qualquer situação,
// valor > 0) → venda concluída (situação válida, sem devolução total) → reativado. Sem fonte de dado = 'NAO_MEDIDO' (nunca 0).
//
// Atribuição por evidência (OPÇÃO `opcoes.atribuicao='EVIDENCIA'`; o padrão segue 'ULTIMO_TOQUE'). Proposta aguardando o dono.
//   Não toca em carteira, comissão ou meta. A classificação é calculada sempre (campo `evidencia`) e só alimenta o funil
//   quando a opção é escolhida. Níveis, por pedido (cliente = mesmo ID GC; contato = CONVERSA anterior, dentro da janela):
//     ATRIBUIDA_COM_EVIDENCIA  vendedor do pedido = autor do contato E interesse/proposta 'SIM' capturado E um só vendedor
//     PROVAVEL                 vendedor = autor e (prazo ≤ 7 dias OU interesse/proposta 'SIM'); ou 'SIM' com vendedor não verificável
//     NAO_ATRIBUIVEL           demais (com o motivo)
//   Um pedido → no máximo uma oportunidade; uma oportunidade leva só o 1º pedido concluído que atende os critérios
//   (os seguintes: PEDIDO_ADICIONAL).
//
// Atribuição padrão (correlação temporal, NÃO causalidade):
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
const NIVEIS = Object.freeze({ ATRIBUIDA: 'ATRIBUIDA_COM_EVIDENCIA', PROVAVEL: 'PROVAVEL', NAO: 'NAO_ATRIBUIVEL' });
const REGRAS_ATRIBUICAO = Object.freeze(['ULTIMO_TOQUE', 'EVIDENCIA']);
const NIVEIS_MINIMOS = Object.freeze([NIVEIS.ATRIBUIDA, NIVEIS.PROVAVEL]);
const PRAZO_PROVAVEL_DIAS = 7;
const LOTE_MS = 60000;            // resultado gravado < 60 s depois do anterior da mesma pessoa
const JUNTOS_MS = 30000;          // "iniciar" e "registrar" no mesmo gesto
// motivos de indexarVendas que não formam um "pedido realizado" (registro inutilizável ou troca/brinde)
const NAO_E_PEDIDO = Object.freeze(['SEM_ID', 'DATA_INVALIDA', 'DATA_FUTURA', 'VALOR_ZERADO']);
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
      vendedorId: normalizeGestaoClickId(v.vendedor_id), parcial: dev === 'PARCIAL', situacaoNome: String((v && v.nome_situacao) || ''),
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
  const atribuicao = o.atribuicao || 'ULTIMO_TOQUE', nivelMinimo = o.nivelMinimo || NIVEIS.PROVAVEL;
  const prazoProvavelDias = o.prazoProvavelDias === undefined ? PRAZO_PROVAVEL_DIAS : o.prazoProvavelDias;
  if (!REGRAS_ATRIBUICAO.includes(atribuicao)) throw new Error('atribuicao inválida: ' + atribuicao);
  if (!NIVEIS_MINIMOS.includes(nivelMinimo)) throw new Error('nivelMinimo inválido: ' + nivelMinimo);
  if (!Number.isInteger(prazoProvavelDias) || prazoProvavelDias < 0 || prazoProvavelDias > 365) throw new Error('prazoProvavelDias inválido');
  if (atribuicao === 'EVIDENCIA' && base !== 'CONVERSA') throw new Error('base inválida para atribuição por evidência: só CONVERSA');
  return { janelaDias, base, mesmoDia, dataCorte: o.dataCorte, inicio: o.inicio || null, fim: o.fim || null, limiarDias: LIMIAR_INATIVIDADE_DIAS,
    atribuicao, nivelMinimo, prazoProvavelDias };
}

/** Pedidos registrados do cliente (qualquer situação, valor > 0), concluídos ou não, em ordem (data, id). */
function pedidosRegistrados(validas, invalidas) {
  return [...(validas || []), ...(invalidas || []).filter(v => !NAO_E_PEDIDO.includes(v.motivo) && v.id && YMD.test(v.data) && v.valorC > 0)]
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Classifica cada pedido registrado próximo de algum contato do cliente. Puro.
 * @returns {object[]} um caso por pedido: { vendaId, gc, opp, tipo, data, valorC, concluida, situacao, nivel, motivo, sinais[],
 *   operadorId, vendedorPedidoId, mesmoVendedor, contatoDia, contatoOutcome, diasAposContato, intencao, venda }
 */
function classificarAtribuicao({ opps, porCliente, invalidas, vendedorGc, registrosPorOperador, opcoes: o }) {
  const casos = [];
  const porGc = new Map();
  for (const x of opps) if (x.gc) { if (!porGc.has(x.gc)) porGc.set(x.gc, []); porGc.get(x.gc).push(x); }
  const maisRecente = (a, b) => (b.c.ancoraMs - a.c.ancoraMs) || (a.x.opp < b.x.opp ? -1 : a.x.opp > b.x.opp ? 1 : 0);
  const emLote = c => {
    const fim = Date.parse(c.em);
    return (registrosPorOperador.get(c.operadorId) || []).some(t => t < fim && fim - t < LOTE_MS);
  };
  for (const [gc, doCliente] of porGc) {
    const todos = doCliente.flatMap(x => x.contatos.map(c => ({ c, x })));
    const conversas = todos.filter(k => OUTCOMES_CONVERSA.includes(k.c.outcome));
    const tentativas = todos.filter(k => !OUTCOMES_CONVERSA.includes(k.c.outcome));
    for (const v of pedidosRegistrados(porCliente.get(gc), invalidas.get(gc))) {
      const comRecusa = k => ({ ...k, recusa: recusaTemporal(v, k.c, o.janelaDias, o.mesmoDia) });
      const mesmo = k => { const g = normalizeGestaoClickId(vendedorGc(k.c.operadorId)); return g && v.vendedorId ? g === v.vendedorId : null; };
      const avaliadas = conversas.map(comRecusa);
      const candidatos = avaliadas.filter(k => !k.recusa).sort(maisRecente);
      let escolhido, nivel = NIVEIS.NAO, motivo, intencao = false;
      const sinais = [];
      if (!candidatos.length) {
        escolhido = avaliadas.filter(k => k.recusa !== 'FORA_DA_JANELA').sort(maisRecente)[0];
        if (escolhido) motivo = escolhido.recusa;
        else {
          escolhido = tentativas.map(comRecusa).filter(k => !k.recusa).sort(maisRecente)[0];
          if (!escolhido) continue;                           // pedido sem relação temporal com a fila: não é caso
          motivo = 'SEM_CONVERSA';
        }
      } else {
        const ordem = k => { const m = mesmo(k); return m === true ? 0 : m === null ? 1 : 2; };
        escolhido = [...candidatos].sort((a, b) => (ordem(a) - ordem(b)) || maisRecente(a, b))[0];
        const m = mesmo(escolhido), d = dias(escolhido.c.dia, v.data);
        const ultimo = candidatos[0].c;                       // a manifestação mais recente do cliente antes do pedido
        const negativo = ultimo.outcome === 'SEM_INTERESSE_AGORA' || ultimo.interesse === 'NAO';
        const variosVendedores = new Set(candidatos.map(k => k.c.operadorId)).size > 1;
        intencao = candidatos.some(k => k.x === escolhido.x && k.c.operadorId === escolhido.c.operadorId && (k.c.interesse === 'SIM' || k.c.proposta === 'SIM'));
        if (variosVendedores) sinais.push('MAIS_DE_UM_VENDEDOR');
        if (new Set(candidatos.map(k => k.x.opp)).size > 1) sinais.push('MAIS_DE_UMA_OPORTUNIDADE');
        if (negativo) sinais.push('SEM_INTERESSE_DECLARADO');
        if (m === false) motivo = 'VENDEDOR_DIVERGENTE';
        else if (negativo) motivo = 'SEM_INTERESSE_DECLARADO';
        else if (m === true && intencao && !variosVendedores) { nivel = NIVEIS.ATRIBUIDA; motivo = 'VENDEDOR_E_INTENCAO'; }
        else if (m === true && (intencao || d <= o.prazoProvavelDias)) { nivel = NIVEIS.PROVAVEL; motivo = intencao ? 'MAIS_DE_UM_VENDEDOR' : 'SEM_INTENCAO_REGISTRADA'; }
        else if (m === null && intencao) { nivel = NIVEIS.PROVAVEL; motivo = 'VENDEDOR_NAO_VERIFICAVEL'; }
        else motivo = m === null ? 'VENDEDOR_NAO_VERIFICAVEL' : 'PRAZO_LONGO_SEM_INTENCAO';
      }
      const { c, x } = escolhido, m = mesmo(escolhido);
      if (m === false) sinais.push('VENDEDOR_DIVERGENTE');
      if (m === null) sinais.push('VENDEDOR_NAO_VERIFICAVEL');
      if (c.dia === v.data) sinais.push('MESMO_DIA');
      if (emLote(c)) sinais.push('REGISTRO_EM_LOTE');
      if (Date.parse(c.em) - c.ancoraMs < JUNTOS_MS) sinais.push('INICIO_E_RESULTADO_JUNTOS');
      if (v.motivo) sinais.push('PEDIDO_NAO_CONCLUIDO');
      if (v.parcial) sinais.push('DEVOLUCAO_PARCIAL');
      casos.push({
        vendaId: v.id, gc, opp: x.opp, tipo: x.tipo, data: v.data, valorC: v.valorC, valor: v.valorC / 100, concluida: !v.motivo, situacao: v.motivo || 'CONCLUIDA',
        nivel, motivo, sinais, operadorId: c.operadorId, vendedorPedidoId: v.vendedorId, mesmoVendedor: m, contatoDia: c.dia, contatoOutcome: c.outcome,
        diasAposContato: dias(c.dia, v.data), intencao, venda: v, contato: c,
      });
    }
  }
  // uma oportunidade leva só o 1º pedido CONCLUÍDO atribuível; os seguintes são recompra e ficam para validação
  const comPedido = new Set();
  const cad = k => (k.venda.cadastroMs === null ? 0 : k.venda.cadastroMs);
  for (const k of [...casos].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : (cad(a) - cad(b)) || (a.vendaId < b.vendaId ? -1 : 1)))) {
    if (k.nivel === NIVEIS.NAO || !k.concluida) continue;
    if (comPedido.has(k.opp)) { k.nivel = NIVEIS.NAO; k.motivo = 'PEDIDO_ADICIONAL'; } else comPedido.add(k.opp);
  }
  return casos;
}

/** Contagem por nível e por motivo (pedidos registrados; valor só dos concluídos). */
function resumirEvidencia(casos) {
  const porNivel = {};
  for (const n of Object.values(NIVEIS)) {
    const l = casos.filter(k => k.nivel === n), ok = l.filter(k => k.concluida);
    porNivel[n] = { pedidos: l.length, concluidos: ok.length, valorConcluido: ok.reduce((s, k) => s + k.valorC, 0) / 100,
      oportunidades: new Set(ok.map(k => k.opp)).size, clientes: new Set(ok.map(k => k.gc)).size };
  }
  const porMotivo = {};
  for (const k of casos) { const c = k.nivel + ':' + k.motivo; porMotivo[c] = (porMotivo[c] || 0) + 1; }
  return { porNivel, porMotivo, casos };
}

/** Etapas separadas do funil. Sem fonte para a etapa → NAO_MEDIDO e contagens nulas (nunca zero). */
function montarEtapas(opps, { temVendas, devolucaoRegistrada }) {
  const clientes = lista => new Set(lista.filter(o => o.vinculo).map(o => o.gc)).size;
  const naoMedido = { status: NAO_MEDIDO, oportunidades: null, clientes: null };
  const etapa = (lista, extra = {}) => ({ status: 'MEDIDO', oportunidades: lista.length, clientes: clientes(lista), ...extra });
  const conversa = opps.filter(o => o.conversa);
  const declarada = campo => {
    const informadas = conversa.filter(o => o[campo] !== null), sim = informadas.filter(o => o[campo] === 'SIM');
    const n = { informadas: informadas.length, naoInformadas: conversa.length - informadas.length };
    if (!informadas.length) return { ...naoMedido, ...n };
    return { ...etapa(sim, n), status: n.naoInformadas ? 'PARCIAL' : 'MEDIDO' };
  };
  const total = lista => lista.reduce((s, p) => s + p.valorC, 0) / 100;
  const realizadas = opps.filter(o => o.registrados.length), concluidas = opps.filter(o => o.pedidos.length), reativadas = opps.filter(o => o.reativada);
  const indeterminadas = concluidas.filter(o => o.historicoDesconhecido).length;
  const registrados = realizadas.flatMap(o => o.registrados), naoConcluidos = {};
  for (const p of registrados) if (p.motivo) naoConcluidos[p.motivo] = (naoConcluidos[p.motivo] || 0) + 1;
  return {
    contatado: opps.length ? etapa(opps.filter(o => o.contatada)) : naoMedido,
    interessado: declarada('interesse'),
    propostaApresentada: declarada('proposta'),
    pedidoRealizado: temVendas ? etapa(realizadas, { pedidos: registrados.length, valor: total(registrados), naoConcluidos }) : naoMedido,
    vendaConcluida: temVendas ? etapa(concluidas, { pedidos: concluidas.reduce((s, o) => s + o.pedidos.length, 0), valor: total(concluidas.flatMap(o => o.pedidos)),
      devolucao: devolucaoRegistrada ? 'PELO_REGISTRO_MANUAL' : NAO_MEDIDO }) : naoMedido,
    reativado: temVendas ? { ...etapa(reativadas, { valor: total(reativadas.flatMap(o => o.pedidos)), indeterminadas }), status: indeterminadas ? 'PARCIAL' : 'MEDIDO' } : naoMedido,
  };
}

/** Resume um conjunto de oportunidades já classificadas. */
function resumir(opps, contexto) {
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
    etapas: montarEtapas(opps, contexto),
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
 * @param {object} p.opcoes              { janelaDias=14, base='CONVERSA', mesmoDia='ordem', dataCorte, inicio?, fim?,
 *                                          atribuicao='ULTIMO_TOQUE'|'EVIDENCIA', nivelMinimo='PROVAVEL', prazoProvavelDias=7 }
 * @returns {{ parametros, total, porVendedor, pedidos, exclusoes, evidencia, coorte }}  porVendedor: uid → resumo (cada oportunidade em UM vendedor);
 *          exclusoes: pedidos perto de algum contato qualificado que NÃO contaram, por motivo (todas as coortes);
 *          evidencia: { porNivel, porMotivo, casos } da coorte, calculada nas duas regras
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
      contatos: validos, qualificados, registros: contatos,
      contatada: validos.length > 0, conversa: conversas.length > 0, qualificada: qualificados.length > 0,
      interesse: ultimoValor('interesse'),
      proposta: conversas.some(c => c.proposta === 'SIM') ? 'SIM' : ultimoValor('proposta'),
      semInteresse: declarouSemInteresse,
      madura: ref.length > 0 && somarDias(ref[ref.length - 1].dia, o.janelaDias) <= o.dataCorte,
      inativaNoContato: parados.some(d => d !== null && d >= o.limiarDias),
      pedidos: [], registrados: [], reativada: false, historicoDesconhecido: false,
      ultimoOperador: (validos[validos.length - 1] || contatos[contatos.length - 1]).operadorId,
      operadores: new Set(contatos.map(c => c.operadorId)),
    });
  }

  const registrosPorOperador = new Map();
  for (const x of opps) for (const c of x.registros) {
    if (!registrosPorOperador.has(c.operadorId)) registrosPorOperador.set(c.operadorId, []);
    registrosPorOperador.get(c.operadorId).push(Date.parse(c.em));
  }
  const casos = classificarAtribuicao({ opps, porCliente, invalidas, vendedorGc, registrosPorOperador, opcoes: o });

  const pedidos = [], exclusoes = {};
  const excluir = motivo => { exclusoes[motivo] = (exclusoes[motivo] || 0) + 1; };
  /** Credita um pedido CONCLUÍDO à oportunidade, a partir do contato escolhido pela regra. */
  const creditar = (x, c, v) => {
    const parado = diasParadoNoContato(c, porCliente.get(v.gc), anteriorFora(v.gc));
    const gcOperador = normalizeGestaoClickId(vendedorGc(c.operadorId));
    const pedido = {
      vendaId: v.id, opp: x.opp, gc: v.gc, data: v.data, valorC: v.valorC, valor: v.valorC / 100, parcial: v.parcial,
      contatoDia: c.dia, contatoOutcome: c.outcome, operadorId: c.operadorId, diasAposContato: dias(c.dia, v.data),
      diasParadoNoContato: parado,
      mesmoVendedor: gcOperador && v.vendedorId ? gcOperador === v.vendedorId : null,
    };
    x.pedidos.push(pedido); pedidos.push(pedido); x.registrados.push(v);
    if (parado !== null && parado >= o.limiarDias) x.reativada = true;
    if (parado === null && p.coberturaDesde && !p.ultimaCompraForaDaCobertura) x.historicoDesconhecido = true;
  };

  if (o.atribuicao === 'EVIDENCIA') {
    const porOpp = new Map(opps.map(x => [x.opp, x]));
    const aceito = k => k.nivel === NIVEIS.ATRIBUIDA || (o.nivelMinimo === NIVEIS.PROVAVEL && k.nivel === NIVEIS.PROVAVEL);
    for (const k of casos) {
      if (!aceito(k)) { excluir(k.nivel === NIVEIS.NAO ? k.motivo : 'ABAIXO_DO_NIVEL_MINIMO'); continue; }
      if (k.concluida) creditar(porOpp.get(k.opp), k.contato, k.venda);
      else { porOpp.get(k.opp).registrados.push(k.venda); excluir(k.situacao); }
    }
  } else {
    // último toque: para cada pedido, o contato qualificado mais recente — no máximo uma oportunidade
    const porGc = new Map();
    for (const x of opps) if (x.gc) { if (!porGc.has(x.gc)) porGc.set(x.gc, []); porGc.get(x.gc).push(x); }
    for (const [gc, doCliente] of porGc) {
      const contatos = doCliente.flatMap(x => x.qualificados.map(c => ({ c, x })));
      if (!contatos.length) continue;
      for (const v of pedidosRegistrados(porCliente.get(gc), invalidas.get(gc))) {
        const avaliados = contatos.map(k => ({ ...k, recusa: recusaTemporal(v, k.c, o.janelaDias, o.mesmoDia) }));
        const validos = avaliados.filter(k => !k.recusa)
          .sort((a, b) => (b.c.ancoraMs - a.c.ancoraMs) || (a.x.opp < b.x.opp ? -1 : a.x.opp > b.x.opp ? 1 : 0));
        if (v.motivo) { if (validos.length) validos[0].x.registrados.push(v); continue; }      // realizado, mas não concluído
        if (!validos.length) {
          const dentro = avaliados.find(k => k.recusa !== 'FORA_DA_JANELA');
          if (dentro) excluir(dentro.recusa);
          continue;
        }
        creditar(validos[0].x, validos[0].c, v);
      }
      for (const v of invalidas.get(gc) || []) {
        if (contatos.some(k => { const d = dias(k.c.dia, v.data); return d >= 0 && d <= o.janelaDias; })) excluir(v.motivo);
      }
    }
  }
  for (const x of opps) {
    x.pedidos.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.vendaId < b.vendaId ? -1 : 1));
    x.vendedor = x.pedidos.length ? x.pedidos[0].operadorId : x.ultimoOperador;   // convertida → quem fez o contato do 1º pedido
  }

  // O recorte de período é aplicado DEPOIS da atribuição: assim recortes vizinhos nunca contam o mesmo pedido duas vezes.
  const coorte = opps.filter(x => (!o.inicio || x.entrada >= o.inicio) && (!o.fim || x.entrada <= o.fim));
  const contexto = { temVendas: Array.isArray(p.vendas) && p.vendas.length > 0,
    devolucaoRegistrada: !!p.devolucoes && (p.devolucoes instanceof Map ? p.devolucoes.size : Object.keys(p.devolucoes).length) > 0 };
  const porVendedor = {};
  for (const uid of [...new Set(coorte.map(x => x.vendedor))].sort()) porVendedor[uid] = resumir(coorte.filter(x => x.vendedor === uid), contexto);
  const naCoorte = new Set(coorte.map(x => x.opp));
  return {
    parametros: o,
    total: { ...resumir(coorte, contexto), oportunidadesComMaisDeUmVendedor: coorte.filter(x => x.operadores.size > 1).length },
    porVendedor, pedidos: coorte.flatMap(x => x.pedidos), exclusoes,
    evidencia: resumirEvidencia(casos.filter(k => naCoorte.has(k.opp))),
    // uma linha por oportunidade da coorte: `base` = denominador das taxas (vínculo GC, cliente respondeu, janela encerrada)
    coorte: coorte.map(x => ({ opp: x.opp, base: x.vinculo && x.contatada && x.madura && x.qualificada })),
  };
}

/** Mesma entrada, variando janela × base × política do mesmo dia. Uma linha por combinação. */
function sensibilidade(p, { janelas = JANELAS_SENSIBILIDADE, bases, mesmoDia = POLITICAS_MESMO_DIA } = {}) {
  if (!bases) bases = p.opcoes && p.opcoes.atribuicao === 'EVIDENCIA' ? ['CONVERSA'] : ['CONVERSA', 'TENTATIVA'];
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

// ── Casos ambíguos para validação humana ───────────────────────────────────────────────────────────────────────
const PERGUNTAS_AMBIGUOS = Object.freeze({
  VENDEDOR_DIVERGENTE: 'Pedido lançado por outro vendedor: o contato registrado teve participação?',
  SEM_INTERESSE_DECLARADO: 'Cliente declarou sem interesse e depois comprou: houve novo contato não registrado?',
  PEDIDO_ANTERIOR_AO_CONTATO: 'Pedido já cadastrado antes do registro: o contato real foi antes do pedido?',
  MESMO_DIA_SEM_HORA: 'Pedido do mesmo dia sem hora de cadastro: o contato veio antes?',
  PRAZO_LONGO_SEM_INTENCAO: 'Pedido depois de 7 dias sem interesse/proposta registrados: veio deste contato?',
  SEM_CONVERSA: 'Só houve tentativa sem resposta: o cliente chegou a ser atendido?',
  PEDIDO_ADICIONAL: 'Recompra depois do 1º pedido atribuído: conta para o mesmo contato?',
  SEM_INTENCAO_REGISTRADA: 'Provável (mesmo vendedor, até 7 dias), mas com sinal de conflito: confirma?',
  MAIS_DE_UM_VENDEDOR: 'Mais de um vendedor registrou contato: quem trouxe o pedido?',
  VENDEDOR_NAO_VERIFICAVEL: 'Não há vínculo para conferir o vendedor: quem trouxe o pedido?',
});
const SINAIS_CONFLITO = Object.freeze(['MAIS_DE_UM_VENDEDOR', 'MESMO_DIA', 'PEDIDO_NAO_CONCLUIDO', 'VENDEDOR_NAO_VERIFICAVEL']);
const MOTIVOS_CONFLITO = Object.freeze(['VENDEDOR_DIVERGENTE', 'SEM_INTERESSE_DECLARADO', 'PEDIDO_ANTERIOR_AO_CONTATO', 'MESMO_DIA_SEM_HORA']);

/**
 * Casos que a regra não resolve sozinha. Prioridade 1 = sinais em conflito; 2 = prazo longo / só tentativa; 3 = pedido adicional.
 * 'ATRIBUIDA_COM_EVIDENCIA' e 'PROVAVEL' sem conflito não entram.
 */
function casosAmbiguos(casos) {
  return (casos || []).filter(k => k.nivel !== NIVEIS.ATRIBUIDA).map(k => {
    const conflito = MOTIVOS_CONFLITO.includes(k.motivo) || k.sinais.some(s => SINAIS_CONFLITO.includes(s));
    if (k.nivel === NIVEIS.PROVAVEL && !conflito) return null;
    return { ...k, prioridade: conflito ? 1 : k.motivo === 'PEDIDO_ADICIONAL' ? 3 : 2, pergunta: PERGUNTAS_AMBIGUOS[k.motivo] || 'Este pedido veio do contato registrado?' };
  }).filter(Boolean).sort((a, b) => (a.prioridade - b.prioridade) || (a.motivo < b.motivo ? -1 : a.motivo > b.motivo ? 1 : 0) || (b.valorC - a.valorC) || (a.vendaId < b.vendaId ? -1 : 1));
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
  NIVEIS, REGRAS_ATRIBUICAO, PRAZO_PROVAVEL_DIAS,
  contatosDaOportunidade, indexarVendas, recusaTemporal, pedidosRegistrados, classificarAtribuicao, casosAmbiguos, calcularFunil, sensibilidade, linhaDeBase, estratoEm,
};
