'use strict';
// CRM MR4 2.0 — Fase 1: timeline comercial do cliente, "venda após contato" e "cliente recuperado".
// PURO (sem I/O). Tudo é DERIVADO na hora da consulta a partir de fontes que já existem:
//   interacoes_fila.eventos  (CLAIMED / RELEASED / OUTCOME_REGISTERED, com meta.nota e meta.scheduledFor)
//   vendas_gc                (data comercial SÓ COM DIA — sem hora)
//   fila_comercial/worklist  (atribuicoes[opp].desde = entrada na oportunidade, enquanto pendente)
//   carteira_comercial_historico (criação/transferência da carteira)
// Nada aqui grava dado, nem afirma causalidade: "venda após contato" é só a ordem temporal.

const TZ = 'America/Fortaleza';
const LIMIAR_INATIVIDADE_DIAS = 120;                      // mesma regra do REATIVACAO_120D / perfil inativo120d
const OUTCOMES_CONTATO = ['CONVERSA_REALIZADA', 'SEM_RESPOSTA', 'PEDIU_RETORNO', 'SEM_INTERESSE_AGORA'];   // CONTATO_INVALIDO não é contato
const OUTCOME_LABELS = {
  CONVERSA_REALIZADA: 'Contato realizado', SEM_RESPOSTA: 'Sem resposta', PEDIU_RETORNO: 'Pediu retorno',
  SEM_INTERESSE_AGORA: 'Sem interesse agora', CONTATO_INVALIDO: 'Contato inválido',
};

/** Data comercial (YYYY-MM-DD) de um instante ISO, no fuso de Fortaleza. */
function diaComercial(iso) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const p = t => partes.find(x => x.type === t).value;
  return `${p('year')}-${p('month')}-${p('day')}`;
}
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
// Pedido concretizado = mesmo critério do Perfil 360 (conta pedidos de valor zero). "Venda" para fins de
// venda-após-contato / recuperado exige valor > 0 (um pedido sem valor não é venda).
const pedidoConcretizado = v => v && String(v.nome_situacao || '').trim() === 'Concretizada' && /^\d{4}-\d{2}-\d{2}/.test(String(v.data || ''));
const vendaValida = v => pedidoConcretizado(v) && Number(v.valor_total) > 0;
const valorVenda = v => Math.round(Number(v.valor_total) * 100) / 100;

/** Vendas (valor > 0) — ou todos os pedidos concretizados com {incluirValorZero:true} — deduplicados e em ordem de data. */
function vendasOrdenadas(vendas, opcoes = {}) {
  const vistos = new Set(); const out = [];
  const aceita = opcoes.incluirValorZero ? pedidoConcretizado : vendaValida;
  for (const v of vendas || []) {
    if (!aceita(v)) continue;
    const id = String(v.id || ''); if (id && vistos.has(id)) continue; if (id) vistos.add(id);
    out.push({ id, data: String(v.data).slice(0, 10), valor: valorVenda(v), vendedorId: v.vendedor_id != null ? String(v.vendedor_id) : null,
      vendedorNome: v.nome_vendedor || null, itens: Array.isArray(v.produtos) ? v.produtos.length : null });
  }
  return out.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : 1));
}

/** Contatos (resultados registrados) de todas as instâncias do cliente, em ordem. */
function contatosDe(estados) {
  const out = [];
  for (const e of estados || []) for (const ev of (e && e.eventos) || []) {
    if (ev && ev.tipo === 'OUTCOME_REGISTERED' && OUTCOMES_CONTATO.includes(ev.outcome) && ev.timestamp) {
      out.push({ em: ev.timestamp, dia: diaComercial(ev.timestamp), outcome: ev.outcome, operadorId: ev.operadorId || null, opp: e.opportunityInstanceId || null });
    }
  }
  return out.sort((a, b) => (a.em < b.em ? -1 : 1));
}

/**
 * VENDA APÓS CONTATO — para cada venda válida, o último contato ANTERIOR a ela.
 *   contato em dia anterior à venda            → APOS (diasAposContato)
 *   só existe contato no MESMO dia da venda    → INDETERMINADO (vendas_gc não tem hora)
 *   sem contato antes                          → a venda não entra
 * Não grava nada e não afirma causalidade.
 */
function vendasAposContato({ estados, vendas }) {
  const contatos = contatosDe(estados);
  if (!contatos.length) return [];
  const out = [];
  for (const v of vendasOrdenadas(vendas)) {
    const antes = contatos.filter(c => c.dia < v.data);
    const mesmoDia = contatos.filter(c => c.dia === v.data);
    if (antes.length) {
      const c = antes[antes.length - 1];
      out.push({ relacao: 'APOS', venda: v, contato: c, diasAposContato: diasEntre(c.dia, v.data) });
    } else if (mesmoDia.length) {
      out.push({ relacao: 'INDETERMINADO', venda: v, contato: mesmoDia[0], diasAposContato: 0 });
    }
  }
  return out;
}

/**
 * CLIENTE RECUPERADO — cliente que, no dia do contato, estava há ≥ 120 dias sem compra válida
 * (ou nunca tinha comprado não conta: recuperar exige histórico) e comprou DEPOIS do contato.
 *   status RECUPERADO_APOS_CONTATO | INDETERMINADO (venda no mesmo dia do contato) | null
 * Não afirma que a venda foi causada pelo contato.
 */
function clienteRecuperado({ estados, vendas, limiarDias = LIMIAR_INATIVIDADE_DIAS }) {
  const vs = vendasOrdenadas(vendas);
  for (const c of contatosDe(estados)) {
    const anteriores = vs.filter(v => v.data < c.dia);
    if (!anteriores.length) continue;                                   // sem histórico → não é "recuperação"
    const ultima = anteriores[anteriores.length - 1];
    const diasParado = diasEntre(ultima.data, c.dia);
    if (diasParado < limiarDias) continue;
    const depois = vs.find(v => v.data > c.dia);
    const mesmoDia = vs.find(v => v.data === c.dia);
    if (depois) return { status: 'RECUPERADO_APOS_CONTATO', contato: c, ultimaCompraAntes: ultima.data, diasParadoNoContato: diasParado, venda: depois, diasAteVenda: diasEntre(c.dia, depois.data) };
    if (mesmoDia) return { status: 'INDETERMINADO', contato: c, ultimaCompraAntes: ultima.data, diasParadoNoContato: diasParado, venda: mesmoDia, diasAteVenda: 0 };
  }
  return null;
}

/**
 * TIMELINE — lista cronológica única (mais recente primeiro). Cada evento:
 *   { quando, precisao: 'HORA'|'DIA', ator: 'SISTEMA'|'VENDEDOR'|'VENDA', tipo, titulo, detalhe, porUid, nota }
 * Eventos só com dia (vendas, entrada na worklist) ficam ANTES dos eventos com hora do mesmo dia na ordem crescente,
 * porque não sabemos a hora — por isso a "venda após contato" do mesmo dia é INDETERMINADO.
 */
function montarTimeline({ estados = [], vendas = [], atribuicoes = [], carteiraHistorico = [], nomePorUid = {}, podeVerValores = false }) {
  const nome = uid => (uid && nomePorUid[uid]) || (uid ? 'Vendedor' : null);
  const ev = [];
  for (const a of atribuicoes || []) if (a && a.desde) {
    ev.push({ quando: a.desde, precisao: 'DIA', ator: 'SISTEMA', tipo: 'ENTROU_WORKLIST', titulo: 'Entrou na lista de ' + (nome(a.uid) || 'vendedor'), detalhe: a.rotuloTipo || null, porUid: a.uid || null });
  }
  for (const e of estados || []) for (const x of (e && e.eventos) || []) {
    if (!x || !x.timestamp) continue;
    if (x.tipo === 'CLAIMED') ev.push({ quando: x.timestamp, precisao: 'HORA', ator: 'VENDEDOR', tipo: 'INICIOU', titulo: nome(x.operadorId) + ' iniciou atendimento', porUid: x.operadorId || null });
    else if (x.tipo === 'RELEASED') ev.push({ quando: x.timestamp, precisao: 'HORA', ator: x.meta && x.meta.reason === 'CLAIM_TIMEOUT' ? 'SISTEMA' : 'VENDEDOR', tipo: 'CANCELOU',
      titulo: x.meta && x.meta.reason === 'CLAIM_TIMEOUT' ? 'Atendimento expirou (4 h sem resultado)' : nome(x.operadorId) + ' cancelou o atendimento', porUid: x.operadorId || null });
    else if (x.tipo === 'OUTCOME_REGISTERED') {
      const sched = x.meta && x.meta.scheduledFor;
      ev.push({ quando: x.timestamp, precisao: 'HORA', ator: 'VENDEDOR', tipo: 'RESULTADO', outcome: x.outcome,
        titulo: nome(x.operadorId) + ': ' + (OUTCOME_LABELS[x.outcome] || x.outcome), detalhe: sched ? 'Retorno marcado para ' + sched.split('-').reverse().join('/') : null,
        nota: (x.meta && typeof x.meta.nota === 'string') ? x.meta.nota : null, porUid: x.operadorId || null });
    }
  }
  for (const e of estados || []) {
    if (e && e.nextFollowUpAt && e.estado !== 'CONCLUIDA') {
      ev.push({ quando: e.nextFollowUpAt, precisao: 'DIA', ator: 'SISTEMA', tipo: 'RETORNO_PREVISTO', titulo: 'Retorno previsto', futuro: true });
    }
  }
  for (const v of vendasOrdenadas(vendas, { incluirValorZero: true })) {
    ev.push({ quando: v.data, precisao: 'DIA', ator: 'VENDA', tipo: 'VENDA', titulo: v.valor > 0 ? 'Pedido concretizado' : 'Pedido concretizado (sem valor)',
      detalhe: [v.vendedorNome ? 'Vendedor: ' + v.vendedorNome : null, v.itens != null ? v.itens + ' itens' : null].filter(Boolean).join(' · ') || null,
      ...(podeVerValores ? { valor: v.valor } : {}) });       // vendedor: a chave nem existe (N35.20.1)
  }
  for (const h of carteiraHistorico || []) if (h && h.criadoEm) {
    const t = String(h.tipoEvento || '');
    const titulo = t.startsWith('CARTEIRA_CRIADA') ? 'Carteira criada para ' + (nome(h.ownerNovoUid) || 'vendedor')
      : t === 'ATRIBUICAO_INICIAL_REVERTIDA' ? 'Atribuição de carteira revertida'
      // B2 (histórico v2): eventos que NÃO trocam o dono não podem aparecer como transferência
      : t === 'RENOVACAO_CICLO' ? 'Ciclo da carteira renovado'
      : t === 'CONFLITO_ABERTO' ? 'Cadastro em revisão de identidade (dono mantido)'
      : t === 'CONFLITO_RESOLVIDO' ? 'Revisão de identidade concluída (dono mantido)'
      : t === 'MIGRATED_BASELINE' ? 'Estado inicial da carteira migrado'
      : t === 'LIBERACAO' ? 'Carteira liberada'
      : t === 'REVERSAO_TRANSFERENCIA' ? 'Transferência revertida (venda deixou de ser válida)'
      : 'Carteira passou para ' + (nome(h.ownerNovoUid) || 'vendedor');
    ev.push({ quando: typeof h.criadoEm === 'string' ? h.criadoEm : String(h.criadoEm), precisao: 'HORA', ator: 'SISTEMA', tipo: 'CARTEIRA', titulo });
  }
  // ordem crescente: pelo dia comercial; no mesmo dia, eventos só-dia antes dos com hora; depois pela hora
  const chave = x => {
    const dia = x.precisao === 'DIA' ? String(x.quando).slice(0, 10) : diaComercial(x.quando);
    return [dia, x.precisao === 'DIA' ? 0 : 1, x.precisao === 'DIA' ? '' : x.quando];
  };
  ev.sort((a, b) => { const ka = chave(a), kb = chave(b); for (let i = 0; i < 3; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; });
  ev.forEach(x => { x.dia = chave(x)[0]; });
  return ev.reverse();
}

/** Observações do vendedor (histórico, nunca sobrescritas): meta.nota dos resultados. Mais recente primeiro. */
function observacoes(estados, nomePorUid = {}) {
  const out = [];
  for (const e of estados || []) for (const x of (e && e.eventos) || []) {
    if (x && x.tipo === 'OUTCOME_REGISTERED' && x.meta && typeof x.meta.nota === 'string' && x.meta.nota) {
      out.push({ em: x.timestamp, por: nomePorUid[x.operadorId] || 'Vendedor', porUid: x.operadorId || null, outcome: x.outcome, nota: x.meta.nota });
    }
  }
  return out.sort((a, b) => (a.em < b.em ? 1 : -1));
}

module.exports = {
  diaComercial, vendasOrdenadas, contatosDe, vendasAposContato, clienteRecuperado, montarTimeline, observacoes,
  LIMIAR_INATIVIDADE_DIAS, OUTCOMES_CONTATO, OUTCOME_LABELS,
};
