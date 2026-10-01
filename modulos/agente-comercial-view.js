/* Agente Comercial — apresentação PURA (sem DOM/rede). Testada em Node; no navegador vira window.AgenteComercialView.
 * O texto do modelo e os nomes vêm de dados: a página sempre imprime via esc(). Nada aqui chama IA nem escreve dados. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.AgenteComercialView = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PERGUNTA_MAX = 400;
  var SUGESTOES = [
    { id: 'hoje', rotulo: 'Quem devo contatar hoje?', modo: 'pergunta', pergunta: 'Quem eu deveria ligar hoje?' },
    { id: 'risco', rotulo: 'Clientes em risco', modo: 'pergunta', pergunta: 'Quais clientes estão em risco de parar de comprar?' },
    { id: 'queda', rotulo: 'Clientes com queda de compras', modo: 'pergunta', pergunta: 'Quais clientes reduziram as compras?' },
    { id: 'recompra', rotulo: 'Oportunidades de recompra', modo: 'pergunta', pergunta: 'Quem tem maior potencial de recompra?' },
    { id: 'carteira', rotulo: 'Resumo da minha carteira', modo: 'pergunta', pergunta: 'Quais clientes da minha carteira estão há mais tempo sem comprar?' },
    { id: 'dia', rotulo: 'Resumo comercial do dia', modo: 'resumo', pergunta: null },
  ];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function validarPergunta(t) { var s = String(t == null ? '' : t).replace(/[\u0000-\u001F\u007F]/g, ' ').trim(); var n = Array.from(s).length; return { ok: n > 0 && n <= PERGUNTA_MAX, texto: s, tamanho: n }; }
  var PRIO = { alta: ['Alta', 'alta'], media: ['Média', 'media'], baixa: ['Baixa', 'baixa'] };
  function prioridade(p) { var x = PRIO[p] || ['—', 'baixa']; return { rotulo: x[0], classe: x[1] }; }
  var MOTIVO_IA = { IA_NAO_CONFIGURADA: 'O agente ainda não está habilitado neste ambiente.', TIMEOUT: 'O agente demorou demais para responder.', PROVEDOR_OCUPADO: 'O serviço de IA está ocupado. Tente de novo em instantes.', PROVEDOR_INDISPONIVEL: 'O serviço de IA está indisponível agora.', RESPOSTA_INVALIDA: 'A resposta do agente não passou na validação de segurança e foi descartada.' };
  function mensagemIA(ia) { if (!ia) return null; if (ia.status === 'OK' || ia.status === 'NAO_SOLICITADA') return null; if (ia.status === 'SEM_DADOS') return 'Não encontrei clientes no seu escopo para analisar agora.'; return (MOTIVO_IA[ia.motivo] || 'O agente está indisponível agora.') + ' O CRM continua funcionando normalmente.'; }
  function dataBR(ymd) { return /^\d{4}-\d{2}-\d{2}/.test(String(ymd || '')) ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : String(ymd); }
  var ROT = { tendencia: { CAINDO: 'Caindo', ESTAVEL: 'Estável', CRESCENDO: 'Crescendo', SEM_BASE: 'Sem base' }, recorrencia: { ATRASADO_VS_HISTORICO: 'Atrasado vs. histórico', PROXIMO_DA_JANELA: 'Próximo da janela', DENTRO_DO_PADRAO: 'Dentro do padrão', SEM_BASE: 'Sem base', NUNCA_COMPROU: 'Nunca comprou' },
    status120Dias: { ABERTO_120D: '120 dias ou mais', PROXIMO_120D: 'Perto de 120 dias', FECHADO_120D: 'Abaixo de 120 dias', SEM_COMPRA: 'Sem compra' }, situacaoRetorno: { ATRASADO: 'Atrasado', HOJE: 'Hoje', FUTURO: 'Futuro' } };
  /** Valor de evidência para exibição (o valor vem do motor; aqui só formatamos). */
  function valorEvidencia(metric, v) {
    if (v == null) return '—'; if (ROT[metric] && ROT[metric][v]) return ROT[metric][v];
    if (/Em$|EmAte$|em$/.test(metric) || /^(ultimaCompra|ultimoContato|proximoRetorno|emCooldown|primeiraCompra)/.test(metric)) return dataBR(v);
    if (typeof v === 'number') { if (/Pct$/.test(metric)) return v.toLocaleString('pt-BR') + '%'; if (/^(faturamento|ticket)/.test(metric)) return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v.toLocaleString('pt-BR'); }
    return String(v);
  }
  var CARDS = [['prioridadeAlta', 'Prioridade alta'], ['merecemContato', 'Merecem contato'], ['quedaRelevante', 'Queda nas compras'], ['proximosDe120', 'Perto de 120 dias'], ['recompraProvavel', 'Recompra provável'], ['followUpsAtrasados', 'Retornos atrasados']];
  function cardsResumo(r) { r = r || {}; return CARDS.map(function (c) { return { id: c[0], rotulo: c[1], valor: r[c[0]] == null ? 0 : r[c[0]] }; }); }
  /** Modelo de resposta para a tela (dados prontos; a página só escapa e imprime). */
  function modeloResposta(resp) {
    var msg = mensagemIA(resp.ia);
    var clientes = (resp.customers && resp.customers.length ? resp.customers : (resp.fallback || [])).map(function (c) {
      return { entidade: c.entidade, nome: c.nome || 'Cliente sem nome', prioridade: prioridade(c.prioridade), responsavel: c.responsavel || null, motivos: (c.reasonCodes || []).map(function (m) { return m.label || m.code; }), evidencias: (c.evidence || []).map(function (e) { return { rotulo: e.label || e.metric, valor: valorEvidencia(e.metric, e.value) }; }), deterministico: !(resp.customers && resp.customers.length) };
    });
    return { ok: !!resp.ok, iaOk: !!(resp.ia && resp.ia.status === 'OK'), mensagem: msg, resposta: resp.answer || null, clientes: clientes, avisos: (resp.warnings || []).concat(resp.limitacoes && resp.ia && resp.ia.status === 'OK' ? [] : []), indisponivel: resp.unavailable || [], frescor: resp.dataFreshness || null, rodape: resp.ia && resp.ia.status === 'OK' ? 'Gerado por IA a partir de fatos calculados pelo MR4 · ' + (resp.ia.latenciaMs != null ? (resp.ia.latenciaMs / 1000).toFixed(1) + ' s' : '') : null, limitacoes: resp.limitacoes || [] };
  }
  return { PERGUNTA_MAX: PERGUNTA_MAX, SUGESTOES: SUGESTOES, esc: esc, validarPergunta: validarPergunta, prioridade: prioridade, mensagemIA: mensagemIA, valorEvidencia: valorEvidencia, cardsResumo: cardsResumo, modeloResposta: modeloResposta, dataBR: dataBR };
});
