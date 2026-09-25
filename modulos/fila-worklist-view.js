// fila-worklist-view.js — N35.15
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
    (minha.novas || []).forEach(function (i) { colocar(i, 'novas'); });
    out.contagens = {
      novas: (minha.novas || []).filter(exibivel).length,
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
      ['followUps', 'emAtendimento', 'novas'].forEach(function (grupo) {
        (g[grupo] || []).filter(exibivel).forEach(function (item) {
          var op = p.opMap && p.opMap.get ? p.opMap.get(item.opportunityInstanceId) : null;
          linhas.push({ item: item, grupoOrigem: grupo, estado: estadoVisual(op, ctx) });
        });
      });
      var cont = { novas: (g.novas || []).filter(exibivel).length, retornos: (g.followUps || []).filter(exibivel).length, emAtendimento: 0, concluidas: 0, retornoAgendado: 0, pendentes: 0 };
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
    OUTCOME_LABELS: OUTCOME_LABELS,
  };
  root.FilaWorklistView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
