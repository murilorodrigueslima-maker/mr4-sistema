'use strict';
// N35.19/N35.20 — Inteligência Comercial V1: CONTEXTO do cliente na Worklist (explica; não decide).
//
// INVARIANTES:
//   Função PURA: sem I/O, sem Firestore, sem GestãoClick, sem LLM (OPENAI_CALLS=0).
//   Não altera elegibilidade, tipo, prioridade, ownership, distribuição, limite, claim, outcome ou cooldown.
//   Nunca inventa indicador: campo sem dado confiável é OMITIDO (sem null/0 artificiais).
//   Sem PII: texto com CPF/CNPJ/e-mail/telefone/endereço é DESCARTADO (nunca "corrigido").
//   Separação: dados do vendedor × `gestao` (ticket médio). N35.20.1: o gerador usa separarGestao() e grava
//   `gestao` em fila_comercial_gestao (Rules: vendedor DENY); o documento operacional nunca contém `gestao`.
//   Faturamento (totais/janelas) não entra (CAMPOS_BLOQUEADOS da camada de UI).
//   Mesma entrada = mesma saída (ordenações com desempate por ID).

const { contemDocumento } = require('./nomeExibicao');

const VERSAO = 'V1';
const MAX_PRODUTOS = 3;
const MIN_PEDIDOS_RECORRENTE = 4;          // "cliente recorrente": >= 4 pedidos concretizados
const MIN_PEDIDOS_PRODUTO_RECORRENTE = 2;  // produto recorrente: presente em >= 2 pedidos distintos
const MIN_PEDIDOS_CICLO = 3;               // ciclo habitual exige >= 3 pedidos (>= 2 intervalos)
const FATOR_ATRASO_CICLO = 2;              // atrasado: sem comprar há mais de 2× o ciclo habitual
const DIAS_INATIVO = 120;

const ROTULO_TIPO = {
  REATIVACAO_120D: 'Retomar contato',
  JANELA_DE_RECOMPRA: 'Janela de recompra',
  QUEDA_DE_COMPRAS: 'Queda no ritmo',
};
// Apresentação humana da tendência (nunca o enum interno)
const TENDENCIA_LABEL = { CRESCENDO: 'Compras aumentando', CAINDO: 'Compras diminuindo', ESTAVEL: 'Compras estáveis' };

const RE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const RE_TELEFONE = /(\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}/;
const RE_DIGITOS_LONGOS = /\d{8,}/;
const RE_ENDERECO = /\b(rua|avenida|av\.|travessa|rodovia|bairro|cep)\b[\s:.,]/i;

function dataBR(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return null;
  const [y, m, d] = ymd.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** true se o texto contém qualquer dado pessoal/documento. */
function contemPII(texto) {
  if (typeof texto !== 'string') return false;
  return contemDocumento(texto) || RE_EMAIL.test(texto) || RE_TELEFONE.test(texto) || RE_DIGITOS_LONGOS.test(texto) || RE_ENDERECO.test(texto);
}

/** Nome de produto exibível; com PII → null (item descartado, nunca corrigido). */
function nomeProdutoSeguro(nome) {
  if (typeof nome !== 'string') return null;
  const n = nome.replace(/\s+/g, ' ').trim();
  if (!n || contemPII(n)) return null;
  return n.length > 60 ? n.slice(0, 57) + '...' : n;
}

function concretizadas(vendas) {
  return (vendas || []).filter(v => v && v.nome_situacao === 'Concretizada' && typeof v.data === 'string');
}

/** Produtos por nº de pedidos distintos (>= 2), desempate por unidades e produto_id. */
function produtosRecorrentes(vendas) {
  const m = new Map();
  for (const v of concretizadas(vendas)) {
    for (const raw of v.produtos || []) {
      const it = raw.produto || raw;
      const pid = String(it.produto_id ?? '').trim();
      const nome = nomeProdutoSeguro(it.nome_produto);
      if (!pid || !nome) continue;
      if (!m.has(pid)) m.set(pid, { pid, nome, pedidos: new Set(), unidades: 0 });
      const e = m.get(pid);
      e.pedidos.add(String(v.id));
      e.unidades += parseFloat(it.quantidade ?? 0) || 0;
    }
  }
  return [...m.values()]
    .filter(e => e.pedidos.size >= MIN_PEDIDOS_PRODUTO_RECORRENTE)
    .sort((a, b) => (b.pedidos.size - a.pedidos.size) || (b.unidades - a.unidades) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))
    .slice(0, MAX_PRODUTOS)
    .map(e => ({ nome: e.nome, pedidos: e.pedidos.size }));
}

/** Itens das compras concretizadas do dia da última compra (desempate por id da venda). */
function produtosUltimaCompra(vendas, ultimaCompraEm) {
  const dia = ultimaCompraEm ? String(ultimaCompraEm).slice(0, 10) : null;
  const doDia = concretizadas(vendas)
    .filter(v => dia && v.data.slice(0, 10) === dia && (v.produtos || []).length)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  const nomes = [];
  for (const v of doDia) for (const raw of v.produtos) {
    const n = nomeProdutoSeguro((raw.produto || raw).nome_produto);
    if (n && !nomes.includes(n)) nomes.push(n);
  }
  return nomes.slice(0, MAX_PRODUTOS).map(nome => ({ nome }));
}

/**
 * Motivo — texto previsível. Precedência: FOLLOW_UP > PENDENCIA_ANTERIOR > regra da oportunidade.
 * Queda só é afirmada com tendência atual e confiável (tendenciaAtual === 'CAINDO').
 * @returns {{ codigo: string, texto: string }}
 */
function buildOpportunityReason({ tipoOportunidade, grupo, diasSemComprar, cicloHabitualDias, pedidosTotal, tendenciaAtual, nextFollowUpAt, ultimoOutcome, atribuidoDesde, dataReferencia }) {
  if (grupo === 'followUps') {
    const hoje = nextFollowUpAt && dataReferencia && nextFollowUpAt === dataReferencia;
    const texto = ultimoOutcome === 'PEDIU_RETORNO'
      ? `Retorno combinado com o cliente para ${hoje ? 'hoje' : dataBR(nextFollowUpAt) || 'esta data'}.`
      : ultimoOutcome === 'SEM_RESPOSTA'
        ? 'Nova tentativa: o último contato ficou sem resposta.'
        : 'Retorno agendado para hoje.';
    return { codigo: 'FOLLOW_UP', texto };
  }
  // 0 dias → "hoje"; 1 dia → singular (nunca "há 0 dias")
  const temDias = Number.isInteger(diasSemComprar) && diasSemComprar >= 1;
  const comprouHoje = diasSemComprar === 0;
  const dias = n => `${n} ${n === 1 ? 'dia' : 'dias'}`;
  const temCiclo = Number.isInteger(cicloHabitualDias) && cicloHabitualDias > 0;
  const partes = [];
  const ultimaCompraTexto = () => (comprouHoje ? 'A última compra foi hoje.' : temDias ? `A última compra foi há ${dias(diasSemComprar)}.` : null);
  if (tipoOportunidade === 'REATIVACAO_120D') {
    if (temDias) partes.push(`Sem comprar há ${dias(diasSemComprar)}.`);
    else if (comprouHoje) partes.push('A última compra foi hoje.');
    if (Number.isInteger(pedidosTotal) && pedidosTotal >= MIN_PEDIDOS_RECORRENTE && temCiclo) {
      // "parou" só com atraso real (mais de 2× o ciclo); senão, apenas descreve o ritmo habitual
      partes.push(temDias && diasSemComprar > FATOR_ATRASO_CICLO * cicloHabitualDias
        ? `Cliente recorrente que comprava aproximadamente a cada ${dias(cicloHabitualDias)} e parou.`
        : `Costuma comprar aproximadamente a cada ${dias(cicloHabitualDias)}.`);
    } else if (pedidosTotal === 1) {
      partes.push('Fez uma única compra até hoje.');
    }
  } else if (tipoOportunidade === 'JANELA_DE_RECOMPRA') {
    if (temCiclo) partes.push(`Costuma comprar aproximadamente a cada ${dias(cicloHabitualDias)}.`);
    if (ultimaCompraTexto()) partes.push(ultimaCompraTexto());
  } else if (tipoOportunidade === 'QUEDA_DE_COMPRAS') {
    if (tendenciaAtual === 'CAINDO') partes.push('As compras recentes diminuíram em relação ao período anterior.');
    if (ultimaCompraTexto()) partes.push(ultimaCompraTexto());
  } else if (ultimaCompraTexto()) {
    partes.push(ultimaCompraTexto());
  }
  let codigo = tipoOportunidade || 'REGRA';
  if (grupo === 'pendentes') {
    codigo = 'PENDENCIA_ANTERIOR';
    partes.unshift(`Continua na sua fila desde ${dataBR(atribuidoDesde) || 'um dia anterior'}.`);
  }
  if (!partes.length) partes.push('Oportunidade selecionada pelas regras da fila comercial.');
  return { codigo, texto: partes.join(' ') };
}

/**
 * Contexto Comercial V1 de UMA oportunidade (compacto; campos sem dado são omitidos).
 * @param {object} p
 * @param {object} p.item            — { opportunityInstanceId, tipoOportunidade, diasSemComprar?, atribuidoDesde? }
 * @param {object} [p.perfil]        — Perfil360 (calcularPerfil360)
 * @param {boolean} [p.perfilAtual]  — perfil calculado na dataReferencia (janelas/tendência confiáveis)
 * @param {string} [p.tendenciaCodigo] — calcularTendencia(perfil).tendencia
 * @param {Array}  [p.vendas]        — vendas_gc do cliente, em memória (nunca consulta externa)
 * @param {string} [p.grupo]         — 'novas' | 'pendentes' | 'followUps' | 'emAtendimento'
 * @param {object} [p.estadoOperacional] — interacoes_fila (somente leitura)
 * @param {string} p.dataReferencia
 */
function buildContextoComercial({ item, perfil, perfilAtual = false, tendenciaCodigo, vendas, grupo = 'novas', estadoOperacional, dataReferencia }) {
  const pf = perfil && typeof perfil === 'object' ? perfil : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tipo = item && item.tipoOportunidade;

  const ultimaCompraEm = pf && typeof pf.ultimaCompraEm === 'string' ? pf.ultimaCompraEm.slice(0, 10) : null;
  // perfil do dia é a fonte mais atual (coerente com ultimaCompraEm); senão, o valor do item (rebaseado)
  const diasSemComprar = perfilAtual && pf && Number.isInteger(pf.diasSemComprar) ? pf.diasSemComprar
    : Number.isInteger(item && item.diasSemComprar) ? item.diasSemComprar
      : (pf && Number.isInteger(pf.diasSemComprar) ? pf.diasSemComprar : null);
  const pedidosTotal = pf && Number.isInteger(pf.pedidosTotal) && pf.pedidosTotal > 0 ? pf.pedidosTotal : null;
  const cicloBruto = pf ? num(pf.diasEntreComprasMediana) : null;
  const ciclo = cicloBruto !== null && cicloBruto > 0 && pedidosTotal !== null && pedidosTotal >= MIN_PEDIDOS_CICLO ? Math.round(cicloBruto) : null;
  const clienteDesde = pf && typeof pf.primeiraCompraEm === 'string' ? pf.primeiraCompraEm.slice(0, 10) : null;
  const ticketMedio = pf && pedidosTotal ? num(pf.ticketMedioTotal) : null;

  // Tendência: só com perfil do dia e fora de REATIVACAO_120D (queda implícita)
  const tendenciaAtual = perfilAtual && typeof tendenciaCodigo === 'string' && TENDENCIA_LABEL[tendenciaCodigo] ? tendenciaCodigo : null;
  const tendenciaExibida = tendenciaAtual && tipo !== 'REATIVACAO_120D' ? tendenciaAtual : null;

  const temVendas = Array.isArray(vendas) && vendas.length > 0;
  const recorrentes = temVendas ? produtosRecorrentes(vendas) : [];
  const ultimos = temVendas ? produtosUltimaCompra(vendas, ultimaCompraEm) : [];

  const eventos = estadoOperacional && Array.isArray(estadoOperacional.eventos) ? estadoOperacional.eventos : [];
  const ult = [...eventos].reverse().find(e => e && e.tipo === 'OUTCOME_REGISTERED') || null;
  const nextFU = (estadoOperacional && estadoOperacional.nextFollowUpAt) || null;

  // Sinais confiáveis e coerentes com a oportunidade
  const sinais = [];
  if (grupo === 'followUps' && nextFU && dataReferencia) {
    sinais.push(nextFU === dataReferencia ? { tipo: 'RETORNO_HOJE', label: 'Retorno para hoje' } : { tipo: 'RETORNO_VENCIDO', label: `Retorno desde ${dataBR(nextFU)}` });
  }
  if (grupo === 'pendentes') sinais.push({ tipo: 'PENDENCIA_ANTERIOR', label: `Pendente desde ${dataBR(item && item.atribuidoDesde) || 'dia anterior'}` });
  if (diasSemComprar !== null && diasSemComprar >= DIAS_INATIVO) sinais.push({ tipo: 'INATIVO', label: `Sem comprar há ${diasSemComprar} dias` });
  const recorrente = pedidosTotal !== null && pedidosTotal >= MIN_PEDIDOS_RECORRENTE && ciclo !== null;
  if (recorrente) sinais.push({ tipo: 'CLIENTE_RECORRENTE', label: 'Cliente recorrente' });
  if (recorrente && diasSemComprar !== null && diasSemComprar > FATOR_ATRASO_CICLO * ciclo) {
    sinais.push({ tipo: 'ATRASO_CICLO', label: 'Atrasado em relação ao ciclo habitual' });
  }
  if (pedidosTotal === 1) sinais.push({ tipo: 'COMPRA_UNICA', label: 'Uma única compra' });
  if (tendenciaExibida === 'CAINDO') sinais.push({ tipo: 'COMPRAS_DIMINUINDO', label: TENDENCIA_LABEL.CAINDO });

  const motivo = buildOpportunityReason({
    tipoOportunidade: tipo, grupo, diasSemComprar, cicloHabitualDias: ciclo, pedidosTotal, tendenciaAtual,
    nextFollowUpAt: nextFU, ultimoOutcome: ult && ult.outcome, atribuidoDesde: item && item.atribuidoDesde, dataReferencia,
  });

  const historico = {};
  if (ultimaCompraEm) historico.ultimaCompraEm = ultimaCompraEm;
  if (diasSemComprar !== null) historico.diasSemComprar = diasSemComprar;
  if (pedidosTotal !== null) historico.pedidosTotal = pedidosTotal;
  if (clienteDesde) historico.clienteDesde = clienteDesde;
  if (ciclo !== null) historico.cicloHabitualDias = ciclo;

  const ctx = {
    versao: VERSAO,
    motivo: motivo.texto,
    motivoCodigo: motivo.codigo,
    historico,
    produtos: { recorrentes, ultimaCompra: ultimos },
    sinais,
    gestao: ticketMedio === null ? {} : { ticketMedio: Math.round(ticketMedio * 100) / 100 },
  };
  if (ROTULO_TIPO[tipo]) ctx.rotuloTipo = ROTULO_TIPO[tipo];
  if (tendenciaExibida) ctx.tendencia = { codigo: tendenciaExibida, label: TENDENCIA_LABEL[tendenciaExibida] };
  return ctx;
}

/**
 * N35.20.1 — Segregação na FONTE: separa o contexto operacional (legível pelo vendedor) dos dados de gestão.
 * O operacional nunca carrega a chave `gestao`; a gestão só leva campos gerenciais (sem nome/PII).
 * @returns {{ operacional: object, gestao: object|null }}
 */
function separarGestao(ctx) {
  if (!ctx || typeof ctx !== 'object') return { operacional: ctx, gestao: null };
  const { gestao, ...operacional } = ctx;
  const g = {};
  if (gestao && typeof gestao.ticketMedio === 'number' && Number.isFinite(gestao.ticketMedio)) g.ticketMedio = gestao.ticketMedio;
  return { operacional, gestao: Object.keys(g).length ? g : null };
}

// Campos que NUNCA podem aparecer em documento legível pelo vendedor (defesa final no gerador)
const CAMPOS_EXCLUSIVOS_GESTAO = Object.freeze(['gestao', 'ticketMedio', 'ticketMedioTotal', 'faturamento', 'faturamentoTotal', 'margem', 'lucro', 'custo']);

/** Caminhos de campos exclusivos de gestão encontrados (recursivo). Vazio = documento seguro para o vendedor. */
function camposGestaoExpostos(obj, caminho = '') {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = caminho ? `${caminho}.${k}` : k;
    if (CAMPOS_EXCLUSIVOS_GESTAO.includes(k)) out.push(p);
    if (v && typeof v === 'object') out.push(...camposGestaoExpostos(v, p));
  }
  return out;
}

/** Defesa final: nenhum texto do contexto pode conter PII. */
function contextoSemPII(ctx) {
  if (!ctx || typeof ctx !== 'object') return true;
  const textos = [ctx.motivo, ctx.rotuloTipo, ctx.tendencia && ctx.tendencia.label,
    ...(ctx.sinais || []).map(s => s.label),
    ...((ctx.produtos && ctx.produtos.recorrentes) || []).map(p => p.nome),
    ...((ctx.produtos && ctx.produtos.ultimaCompra) || []).map(p => p.nome)];
  return !textos.some(t => contemPII(t));
}

module.exports = {
  buildContextoComercial, buildOpportunityReason, contextoSemPII, contemPII, nomeProdutoSeguro, produtosRecorrentes, produtosUltimaCompra,
  separarGestao, camposGestaoExpostos, CAMPOS_EXCLUSIVOS_GESTAO,
  VERSAO, TENDENCIA_LABEL, ROTULO_TIPO,
  MIN_PEDIDOS_RECORRENTE, MIN_PEDIDOS_PRODUTO_RECORRENTE, MIN_PEDIDOS_CICLO, FATOR_ATRASO_CICLO,
};
