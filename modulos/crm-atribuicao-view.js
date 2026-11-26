// crm-atribuicao-view.js — COM-03: view-model PURO da revisão de atribuição (sem DOM, sem Firebase).
// Incluído por crm-atribuicao.html e testado em functions/test/com03-*.test.js.
// Os indicadores são calculados AQUI (uma implementação só) a partir do que crmAtribuicaoRevisao { acao:'listar' } devolve.
(function (root) {
  'use strict';

  var DECISOES = [
    { codigo: 'COMPROVADA', rotulo: 'Comprovada', ajuda: 'Há prova de que o pedido veio deste contato.' },
    { codigo: 'PROVAVEL', rotulo: 'Provável', ajuda: 'Indícios fortes, sem prova.' },
    { codigo: 'NAO_ATRIBUIDA', rotulo: 'Não atribuída', ajuda: 'O pedido não veio deste contato (ou não dá para afirmar).' },
  ];
  var SITUACOES = ['COMPROVADA', 'PROVAVEL', 'AGUARDANDO', 'NAO_ATRIBUIDA'];
  var ROTULO_SITUACAO = { COMPROVADA: 'Comprovada', PROVAVEL: 'Provável', AGUARDANDO: 'Aguardando revisão', NAO_ATRIBUIDA: 'Não atribuída', SEM_PEDIDO: 'Sem pedido no período', FORA: 'Não conta (pedido não concluído)' };
  var ROTULO_SISTEMA = { ATRIBUIDA_COM_EVIDENCIA: 'Com evidência declarada pelo vendedor', PROVAVEL: 'Provável', NAO_ATRIBUIVEL: 'Não atribuível' };
  var ROTULO_MOTIVO = {
    VENDEDOR_E_INTENCAO: 'mesmo vendedor, com interesse ou proposta declarados',
    SEM_INTENCAO_REGISTRADA: 'mesmo vendedor, dentro de 7 dias, sem interesse ou proposta registrados',
    MAIS_DE_UM_VENDEDOR: 'mais de um vendedor registrou contato',
    VENDEDOR_NAO_VERIFICAVEL: 'não há vínculo para conferir o vendedor',
    VENDEDOR_DIVERGENTE: 'pedido lançado por outro vendedor',
    SEM_INTERESSE_DECLARADO: 'cliente declarou sem interesse',
    PRAZO_LONGO_SEM_INTENCAO: 'mais de 7 dias sem interesse ou proposta registrados',
    PEDIDO_ANTERIOR_AO_CONTATO: 'pedido já cadastrado antes do registro do contato',
    MESMO_DIA_SEM_HORA: 'mesmo dia, sem hora de cadastro do pedido',
    PEDIDO_ADICIONAL: 'recompra depois do 1º pedido do mesmo contato',
    SEM_CONVERSA: 'só houve tentativa sem resposta',
  };
  var ROTULO_SINAL = {
    MAIS_DE_UM_VENDEDOR: 'mais de um vendedor', MAIS_DE_UMA_OPORTUNIDADE: 'mais de uma oportunidade', SEM_INTERESSE_DECLARADO: 'sem interesse declarado',
    VENDEDOR_DIVERGENTE: 'outro vendedor', VENDEDOR_NAO_VERIFICAVEL: 'vendedor não conferido', MESMO_DIA: 'mesmo dia',
    REGISTRO_EM_LOTE: 'registrado em lote', INICIO_E_RESULTADO_JUNTOS: 'iniciado e registrado no mesmo instante',
    PEDIDO_NAO_CONCLUIDO: 'pedido não concluído', DEVOLUCAO_PARCIAL: 'devolução parcial',
  };
  var ROTULO_RESULTADO = { CONVERSA_REALIZADA: 'Contato realizado', SEM_RESPOSTA: 'Sem resposta', PEDIU_RETORNO: 'Pediu retorno', SEM_INTERESSE_AGORA: 'Sem interesse agora', CONTATO_INVALIDO: 'Contato inválido' };
  var OBS_MIN = 3, OBS_MAX = 500;

  /** Decisão tomada sobre outra oportunidade (o caso mudou depois) não vale mais. */
  function desatualizada(c) { return !!(c.revisao && c.revisao.opportunityInstanceId !== c.opportunityInstanceId); }
  function decidido(c) { return !!(c.revisao && !desatualizada(c)); }
  function pendente(c) { return !decidido(c) && (!!c.precisaRevisao || desatualizada(c)); }

  /**
   * Situação de um PEDIDO nos indicadores. "Comprovada" só existe por decisão humana: nem a regra com evidência declarada
   * conta como comprovada. Só pedido concluído conta.
   */
  function situacao(c) {
    if (!c.pedido.concluido) return { codigo: 'FORA', origem: null };
    if (decidido(c)) return { codigo: c.revisao.decisao, origem: 'GESTOR' };
    if (!pendente(c) && c.sistema.nivel === 'PROVAVEL') return { codigo: 'PROVAVEL', origem: 'REGRA' };
    return { codigo: 'AGUARDANDO', origem: null };
  }

  var PRIORIDADE_OPP = ['COMPROVADA', 'PROVAVEL', 'AGUARDANDO', 'NAO_ATRIBUIDA'];   // a melhor situação entre os pedidos da oportunidade

  /**
   * @returns {{ base, porSituacao: {COD:{pedidos,valor,clientes,peloGestor,pelaRegra,oportunidades,taxa}}, semPedido, foraDosIndicadores,
   *             aguardando, decididos, provisorio }}
   * oportunidades/taxa usam o MESMO denominador (`base`) e são excludentes: as 4 situações + sem pedido = base.
   */
  function indicadores(casos, base) {
    var naBase = {}; (base || []).forEach(function (o) { naBase[o] = true; });
    var total = Object.keys(naBase).length;
    var por = {}, clientes = {};
    SITUACOES.forEach(function (s) { por[s] = { pedidos: 0, valor: 0, clientes: 0, peloGestor: 0, pelaRegra: 0, oportunidades: 0, taxa: null }; clientes[s] = {}; });
    var melhor = {}, fora = 0, aguardando = 0, decididos = 0;
    (casos || []).forEach(function (c) {
      if (pendente(c)) aguardando++;
      if (decidido(c)) decididos++;
      var s = situacao(c);
      if (s.codigo === 'FORA') { fora++; return; }
      var x = por[s.codigo];
      x.pedidos++; x.valor += Math.round(c.pedido.valor * 100); clientes[s.codigo][c.clienteGcId] = true;
      if (s.origem === 'GESTOR') x.peloGestor++; if (s.origem === 'REGRA') x.pelaRegra++;
      var o = c.opportunityInstanceId;
      if (naBase[o] && (melhor[o] === undefined || PRIORIDADE_OPP.indexOf(s.codigo) < PRIORIDADE_OPP.indexOf(melhor[o]))) melhor[o] = s.codigo;
    });
    Object.keys(melhor).forEach(function (o) { por[melhor[o]].oportunidades++; });
    SITUACOES.forEach(function (s) { por[s].valor = por[s].valor / 100; por[s].clientes = Object.keys(clientes[s]).length; por[s].taxa = total ? por[s].oportunidades / total : null; });
    return { base: total, porSituacao: por, semPedido: total - Object.keys(melhor).length, foraDosIndicadores: fora, aguardando: aguardando, decididos: decididos,
      provisorio: por.AGUARDANDO.pedidos > 0 };
  }

  function filtrar(casos, f) {
    f = f || {};
    return (casos || []).filter(function (c) {
      if (f.fila === 'pendentes' && !pendente(c)) return false;
      if (f.fila === 'decididos' && !decidido(c)) return false;
      if (f.prioridade && String(c.prioridade) !== String(f.prioridade)) return false;
      if (f.vendedor && c.contato.por !== f.vendedor) return false;
      if (f.busca) {
        var alvo = (c.cliente + ' ' + c.vendaId).toLowerCase();
        if (alvo.indexOf(String(f.busca).trim().toLowerCase()) < 0) return false;
      }
      return true;
    });
  }

  function validarDecisao(sel) {
    var texto = String((sel && sel.observacao) || '').trim();
    var n = Array.from(texto).length;
    var okDecisao = DECISOES.some(function (d) { return d.codigo === (sel && sel.decisao); });
    return { ok: okDecisao && n >= OBS_MIN && n <= OBS_MAX, texto: texto, tamanho: n };
  }

  function dataBR(ymd) { if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ''; var p = String(ymd).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function moedaBR(v) { var n = Number(v); if (!isFinite(n)) return ''; return 'R$\u00a0' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function percentual(t) { return t === null || t === undefined ? '—' : (t * 100).toFixed(1).replace('.', ',') + '%'; }
  function distancia(dias) { return dias === 0 ? 'no mesmo dia' : dias < 0 ? Math.abs(dias) + ' dia(s) antes do contato' : dias + ' dia(s) depois do contato'; }

  var api = {
    DECISOES: DECISOES, SITUACOES: SITUACOES, ROTULO_SITUACAO: ROTULO_SITUACAO, ROTULO_SISTEMA: ROTULO_SISTEMA, ROTULO_MOTIVO: ROTULO_MOTIVO, ROTULO_SINAL: ROTULO_SINAL,
    ROTULO_RESULTADO: ROTULO_RESULTADO, OBS_MIN: OBS_MIN, OBS_MAX: OBS_MAX,
    desatualizada: desatualizada, decidido: decidido, pendente: pendente, situacao: situacao, indicadores: indicadores, filtrar: filtrar, validarDecisao: validarDecisao,
    dataBR: dataBR, moedaBR: moedaBR, percentual: percentual, distancia: distancia,
  };
  root.CrmAtribuicaoView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
