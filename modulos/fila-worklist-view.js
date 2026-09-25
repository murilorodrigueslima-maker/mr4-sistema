// fila-worklist-view.js — N35.15 (N35.18.1: grupo "pendentes" de dias anteriores; N35.20: contexto comercial V1)
// View-model PURO da Worklist V2 (sem DOM, sem Firebase). Incluído por fila-comercial.html
// e testado em functions/test/n35-15-*.test.js. Nenhuma decisão de negócio nova aqui:
// só interpreta o documento fila_comercial/worklist + estados de interacoes_fila para exibição.
(function (root) {
  'use strict';

  var TZ = 'America/Fortaleza';
  var CLAIM_TIMEOUT_MS = 4 * 3600 * 1000;
  var SCHEMA = 'worklist-v2';
  var OUTCOME_LABELS = {
    CONVERSA_REALIZADA: 'Contato realizado',
    SEM_RESPOSTA: 'Sem resposta',
    PEDIU_RETORNO: 'Pediu para ligar depois',
    SEM_INTERESSE_AGORA: 'Sem interesse agora',
    CONTATO_INVALIDO: 'Contato inválido',
  };

  function dataComercial(date) {
    var partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date || new Date());
    var p = function (t) { return partes.filter(function (x) { return x.type === t; })[0].value; };
    return p('year') + '-' + p('month') + '-' + p('day');
  }

  function worklistDeHoje(doc, hoje) {
    if (!doc || doc.schemaVersion !== SCHEMA) return null;
    return doc.dataReferencia === hoje ? doc : null;
  }

  function ultimoOutcome(op) {
    var evs = (op && op.eventos || []).filter(function (e) { return e.tipo === 'OUTCOME_REGISTERED'; });
    return evs.length ? evs[evs.length - 1] : null;
  }

  function claimAtivo(op, agoraMs) {
    if (!op || op.estado !== 'EM_ATENDIMENTO' || !op.claimAtual || !op.claimAtual.claimadoEm) return false;
    return (agoraMs - Date.parse(op.claimAtual.claimadoEm)) < CLAIM_TIMEOUT_MS;
  }

  /**
   * Estado visual de um item para um usuário. Sem documento operacional = DISPONIVEL (criação lazy no claim).
   * podeIniciar/podeRegistrar/podeCancelar só são true para quem pode operar.
   */
  function estadoVisual(op, ctx) {
    var uid = ctx.uid, hoje = ctx.hoje, agoraMs = ctx.agoraMs, podeOperar = !!ctx.podeOperar;
    var r = { codigo: 'DISPONIVEL', rotulo: 'Disponível', podeIniciar: podeOperar, podeRegistrar: false, podeCancelar: false, detalhe: null };
    if (!op) return r;
    if (op.cooledUntil && agoraMs < Date.parse(op.cooledUntil)) {
      return { codigo: 'PAUSA', rotulo: 'Em pausa', podeIniciar: false, podeRegistrar: false, podeCancelar: false, detalhe: op.cooledUntil.slice(0, 10) };
    }
    if (op.estado === 'EM_ATENDIMENTO' && claimAtivo(op, agoraMs)) {
      var meu = op.claimAtual.operadorId === uid;
      return {
        codigo: meu ? 'EM_ATENDIMENTO_MEU' : 'EM_ATENDIMENTO_OUTRO',
        rotulo: meu ? 'Em atendimento por você' : ('Em atendimento' + (op.claimAtual.operadorNome ? ' por ' + op.claimAtual.operadorNome : '')),
        podeIniciar: false, podeRegistrar: meu && podeOperar, podeCancelar: meu && podeOperar, detalhe: null,
      };
    }
    if (op.estado === 'CONCLUIDA') {
      var u = ultimoOutcome(op);
      return { codigo: 'CONCLUIDA', rotulo: 'Concluído', podeIniciar: false, podeRegistrar: false, podeCancelar: false, detalhe: u ? (OUTCOME_LABELS[u.outcome] || u.outcome) : null };
    }
    if (op.nextFollowUpAt && op.nextFollowUpAt > hoje) {
      var ult = ultimoOutcome(op);
      return { codigo: 'RETORNO_AGENDADO', rotulo: 'Retorno agendado', podeIniciar: false, podeRegistrar: false, podeCancelar: false, detalhe: op.nextFollowUpAt, outcome: ult ? ult.outcome : null };
    }
    // DISPONIVEL, AGUARDANDO_RETORNO vencido, ou EM_ATENDIMENTO expirado (a callable libera no próximo claim)
    return r;
  }

  // ── N35.20: Inteligência Comercial V1 (apresentação; nenhuma decisão) ────────────
  var ROTULO_TIPO = { REATIVACAO_120D: 'Retomar contato', JANELA_DE_RECOMPRA: 'Janela de recompra', QUEDA_DE_COMPRAS: 'Queda no ritmo' };
  var TENDENCIA_HUMANA = {
    CRESCENDO: 'Compras aumentando', SUBINDO: 'Compras aumentando', '↗ Subindo': 'Compras aumentando',
    CAINDO: 'Compras diminuindo', '↘ Caindo': 'Compras diminuindo',
    ESTAVEL: 'Compras estáveis', '→ Estável': 'Compras estáveis',
    SEM_BASE: 'Histórico insuficiente',
  };
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function dataBR(ymd) {
    if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return null;
    var p = ymd.slice(0, 10).split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }
  function mesAno(ymd) {
    if (typeof ymd !== 'string' || !/^\d{4}-\d{2}/.test(ymd)) return null;
    var m = MESES[parseInt(ymd.slice(5, 7), 10) - 1];
    return m ? m.charAt(0).toUpperCase() + m.slice(1) + '/' + ymd.slice(0, 4) : null;
  }
  function moedaBR(v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return 'R$ ' + v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function inteiroPositivo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }
  function contexto(item) {
    var c = item && item.contextoComercial;
    return c && typeof c === 'object' && c.versao === 'V1' && typeof c.motivo === 'string' && c.motivo ? c : null;
  }

  /** Valor de sinal legado (sinaisVisiveis) sem enum técnico. Enum desconhecido → null (omitido). */
  function humanizarValorLegado(valor) {
    if (typeof valor !== 'string' || !valor.trim()) return null;
    var v = valor.trim();
    if (TENDENCIA_HUMANA[v]) return TENDENCIA_HUMANA[v];
    if (/^[A-Z][A-Z_]+$/.test(v)) return null;
    return v;
  }
  function sinaisLegadosSeguros(sinais) {
    return (Array.isArray(sinais) ? sinais : []).map(function (s) {
      var val = humanizarValorLegado(s && s.valor);
      return s && s.label && val ? { label: String(s.label), valor: val } : null;
    }).filter(Boolean);
  }

  /**
   * Card do vendedor: tipo + motivo + (última compra · pedidos). Nunca produtos, ticket, IDs ou enums.
   * Sem contexto (worklist legada): usa `situacao` como antes.
   */
  function modeloCard(item) {
    var ctx = contexto(item);
    if (!ctx) return { usaContexto: false, motivo: (item && item.situacao) || null, linhaHistorico: null };
    var h = ctx.historico || {};
    var partes = [];
    var motivo = ctx.motivo;
    // Pendência: no card o prefixo vira "Pendente desde dd/mm" na linha de histórico (motivo real visível
    // nas 2 linhas do card); o detalhe mantém o motivo completo.
    var pref = /^Continua na sua fila desde (\d{2})\/(\d{2})\/\d{4}\.\s*/.exec(motivo);
    if (ctx.motivoCodigo === 'PENDENCIA_ANTERIOR' && pref) {
      motivo = motivo.slice(pref[0].length) || motivo;
      partes.push('Pendente desde ' + pref[1] + '/' + pref[2]);
    }
    if (dataBR(h.ultimaCompraEm)) partes.push('Última compra: ' + dataBR(h.ultimaCompraEm));
    if (inteiroPositivo(h.pedidosTotal)) partes.push(h.pedidosTotal + (h.pedidosTotal === 1 ? ' pedido' : ' pedidos'));
    return { usaContexto: true, motivo: motivo, linhaHistorico: partes.length ? partes.join(' · ') : null };
  }

  /**
   * Detalhe: motivo, histórico, produtos, sinais. `gestao` só com opts.gestao=true e opts.dadosGestao
   * (undefined = carregando; null = indisponível; { ticketMedio } = dado do documento gerencial).
   * Campos ausentes são omitidos (nunca null/undefined/N/A/"0 dias").
   */
  function modeloDetalhe(item, opts) {
    var ctx = contexto(item);
    var gestao = !!(opts && opts.gestao);
    if (!ctx) {
      return { usaContexto: false, motivo: (item && item.situacao) || null, quando: (item && item.quando) || null, sinaisLegados: sinaisLegadosSeguros(item && item.sinaisVisiveis) };
    }
    var h = ctx.historico || {};
    var historico = [];
    if (dataBR(h.ultimaCompraEm)) historico.push({ label: 'Última compra', valor: dataBR(h.ultimaCompraEm) });
    if (inteiroPositivo(h.diasSemComprar)) historico.push({ label: 'Sem comprar', valor: h.diasSemComprar + (h.diasSemComprar === 1 ? ' dia' : ' dias') });
    if (inteiroPositivo(h.pedidosTotal)) historico.push({ label: 'Pedidos', valor: String(h.pedidosTotal) });
    if (mesAno(h.clienteDesde)) historico.push({ label: 'Cliente desde', valor: mesAno(h.clienteDesde) });
    if (inteiroPositivo(h.cicloHabitualDias)) historico.push({ label: 'Ciclo habitual', valor: '~' + h.cicloHabitualDias + ' dias' });
    if (ctx.tendencia && TENDENCIA_HUMANA[ctx.tendencia.codigo]) historico.push({ label: 'Tendência', valor: TENDENCIA_HUMANA[ctx.tendencia.codigo] });
    var prod = ctx.produtos || {};
    var out = {
      usaContexto: true,
      rotuloTipo: ctx.rotuloTipo || ROTULO_TIPO[item.tipoOportunidade] || null,
      motivo: ctx.motivo,
      historico: historico,
      produtosRecorrentes: (prod.recorrentes || []).filter(function (p) { return p && p.nome && inteiroPositivo(p.pedidos) && p.pedidos >= 2; })
        .slice(0, 3).map(function (p) { return { nome: p.nome, detalhe: p.pedidos + ' pedidos' }; }),
      produtosUltimaCompra: (prod.ultimaCompra || []).filter(function (p) { return p && p.nome; }).slice(0, 3).map(function (p) { return p.nome; }),
      sinais: (ctx.sinais || []).filter(function (s) { return s && s.label; }).map(function (s) { return s.label; }),
      gestao: null,
    };
    // N35.20.1: dado gerencial vem SOMENTE de opts.dadosGestao (fila_comercial_gestao, lido só pela gestão).
    // `ctx.gestao` (formato N35.20 local) é ignorado. Vendedor: sempre null.
    if (gestao) {
      var dg = opts.dadosGestao;
      if (dg === undefined) out.gestao = { estado: 'carregando' };
      else if (dg && moedaBR(dg.ticketMedio)) out.gestao = { ticketMedio: moedaBR(dg.ticketMedio) };
      else out.gestao = { estado: 'indisponivel' };
    }
    return out;
  }

  var ATIVOS = { DISPONIVEL: 1, EM_ATENDIMENTO_MEU: 1, EM_ATENDIMENTO_OUTRO: 1 };

  function exibivel(item) {
    return !!(item && item.opportunityInstanceId && typeof item.nomeCliente === 'string' && item.nomeCliente.trim());
  }

  /**
   * Visão da vendedora: SOMENTE a própria worklist de hoje.
   * @returns {null | { retornos, emAtendimento, novas, trabalhadasHoje, contagens }}
   */
  function montarVisaoVendedor(p) {
    var doc = worklistDeHoje(p.doc, p.hoje);
    if (!doc || !doc.vendedores || !doc.vendedores[p.uid]) return null;
    var minha = doc.vendedores[p.uid];
    var ctx = { uid: p.uid, hoje: p.hoje, agoraMs: p.agoraMs, podeOperar: p.podeOperar };
    var out = { retornos: [], emAtendimento: [], novas: [], trabalhadasHoje: [] };
    var vistos = {};
    function colocar(item, grupoOrigem) {
      if (!exibivel(item) || vistos[item.opportunityInstanceId]) return;
      vistos[item.opportunityInstanceId] = true;
      var op = p.opMap && p.opMap.get ? p.opMap.get(item.opportunityInstanceId) : null;
      var ev = estadoVisual(op, ctx);
      var v = { item: item, grupoOrigem: grupoOrigem, estado: ev };
      if (ev.codigo === 'EM_ATENDIMENTO_MEU') out.emAtendimento.push(v);
      else if (ev.codigo === 'EM_ATENDIMENTO_OUTRO') out.trabalhadasHoje.push(v); // não deveria ocorrer; nunca operável
      else if (!ATIVOS[ev.codigo]) out.trabalhadasHoje.push(v);
      else if (grupoOrigem === 'followUps') out.retornos.push(v);
      else if (grupoOrigem === 'emAtendimento') out.novas.push(v); // claim expirou: volta como disponível
      else out.novas.push(v);
    }
    (minha.followUps || []).forEach(function (i) { colocar(i, 'followUps'); });
    (minha.emAtendimento || []).forEach(function (i) { colocar(i, 'emAtendimento'); });
    // N35.18.1: pendências de dias anteriores (continuam suas; fora do limite de novas) antes das novas
    (minha.pendentes || []).forEach(function (i) { colocar(i, 'pendentes'); });
    (minha.novas || []).forEach(function (i) { colocar(i, 'novas'); });
    out.contagens = {
      novas: (minha.novas || []).filter(exibivel).length,
      pendentesAnteriores: (minha.pendentes || []).filter(exibivel).length,
      retornos: out.retornos.length,
      emAtendimento: out.emAtendimento.length,
      trabalhadasHoje: out.trabalhadasHoje.length,
      cap: doc.cap,
    };
    return out;
  }

  /** Visão de gestão: todos os vendedores, somente leitura (nenhum botão habilitado). */
  function montarVisaoGestao(p) {
    var doc = worklistDeHoje(p.doc, p.hoje);
    if (!doc) return null;
    var ctx = { uid: null, hoje: p.hoje, agoraMs: p.agoraMs, podeOperar: false };
    return (doc.vendedoresAtivos || []).map(function (uid) {
      var g = doc.vendedores[uid] || {};
      var linhas = [];
      ['followUps', 'emAtendimento', 'pendentes', 'novas'].forEach(function (grupo) {
        (g[grupo] || []).filter(exibivel).forEach(function (item) {
          var op = p.opMap && p.opMap.get ? p.opMap.get(item.opportunityInstanceId) : null;
          linhas.push({ item: item, grupoOrigem: grupo, estado: estadoVisual(op, ctx) });
        });
      });
      var cont = { novas: (g.novas || []).filter(exibivel).length, anteriores: (g.pendentes || []).filter(exibivel).length, retornos: (g.followUps || []).filter(exibivel).length, emAtendimento: 0, concluidas: 0, retornoAgendado: 0, pendentes: 0 };
      // N35.20: contagens por tipo de oportunidade (sem ranking, sem valores financeiros)
      cont.porTipo = {};
      linhas.forEach(function (l) {
        var rt = ROTULO_TIPO[l.item.tipoOportunidade] || 'Outros';
        cont.porTipo[rt] = (cont.porTipo[rt] || 0) + 1;
      });
      linhas.forEach(function (l) {
        var c = l.estado.codigo;
        if (c === 'EM_ATENDIMENTO_OUTRO' || c === 'EM_ATENDIMENTO_MEU') cont.emAtendimento++;
        else if (c === 'CONCLUIDA' || c === 'PAUSA') cont.concluidas++;
        else if (c === 'RETORNO_AGENDADO') cont.retornoAgendado++;
        else cont.pendentes++;
      });
      return { uid: uid, rotulo: (doc.vendedoresRotulos && doc.vendedoresRotulos[uid]) || 'Vendedor', contagens: cont, linhas: linhas };
    });
  }

  var api = {
    dataComercial: dataComercial,
    worklistDeHoje: worklistDeHoje,
    estadoVisual: estadoVisual,
    claimAtivo: claimAtivo,
    exibivel: exibivel,
    montarVisaoVendedor: montarVisaoVendedor,
    montarVisaoGestao: montarVisaoGestao,
    // N35.20
    modeloCard: modeloCard,
    modeloDetalhe: modeloDetalhe,
    humanizarValorLegado: humanizarValorLegado,
    sinaisLegadosSeguros: sinaisLegadosSeguros,
    OUTCOME_LABELS: OUTCOME_LABELS,
  };
  root.FilaWorklistView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
