/* Widget GENÉRICO dos Agentes de IA do MR4 (estoque / compras / financeiro). Mesmo padrão visual do Agente Comercial do CRM.
 * Parte PURA (sem DOM/rede, testada em Node): esc, validarPergunta, mensagemIA, formatar, modeloResposta, htmlResposta, htmlCartoes, htmlChips.
 * Parte de DOM (navegador): montar(container, cfg). O texto do modelo, nomes e motivos vêm de dados: tudo é impresso por esc().
 * O agente só LÊ e RECOMENDA; este widget nunca escreve dados nem executa ações do módulo. A IA falhar não afeta o módulo (mensagem + resultado determinístico). */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.AgenteIaWidget = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PERGUNTA_MAX = 400;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function validarPergunta(t) { var s = String(t == null ? '' : t).replace(/[\u0000-\u001F\u007F]/g, ' ').trim(); var n = Array.from(s).length; return { ok: n > 0 && n <= PERGUNTA_MAX, texto: s, tamanho: n }; }
  var MOTIVO_IA = { IA_NAO_CONFIGURADA: 'O agente ainda não está habilitado neste ambiente.', TIMEOUT: 'O agente demorou demais para responder.', PROVEDOR_OCUPADO: 'O serviço de IA está ocupado. Tente de novo em instantes.', RESPOSTA_INVALIDA: 'Não consegui validar a resposta da IA com os dados do sistema, então não vou exibi-la.', PROVEDOR_INDISPONIVEL: 'O serviço de IA está indisponível agora.' };
  function mensagemIA(ia, semDados) { if (!ia) return null; if (ia.status === 'OK' || ia.status === 'NAO_SOLICITADA') return null; if (ia.status === 'SEM_DADOS') return semDados || 'Não há dados para analisar agora.'; return (MOTIVO_IA[ia.motivo] || 'O agente não está disponível agora.') + ' O módulo continua funcionando normalmente.'; }
  function dataBR(ymd) { return /^\d{4}-\d{2}-\d{2}/.test(String(ymd || '')) ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : String(ymd); }
  function brl(v) { return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** Formata um valor vindo do motor (só apresentação). cfg.formatos = { metrica: 'brl'|'pct'|'int'|'data'|'dias'|'texto' }; cfg.rotulosValor = { metrica: { CODIGO: 'Rótulo' } }. */
  function formatar(metric, v, cfg) {
    cfg = cfg || {}; if (v == null) return '—';
    var rv = cfg.rotulosValor && cfg.rotulosValor[metric]; if (rv && rv[v]) return rv[v];
    var f = (cfg.formatos || {})[metric];
    if (!f) { if (/(Em|EmAte|Data)$/.test(metric) && /^\d{4}-\d{2}-\d{2}/.test(String(v))) f = 'data'; else if (/Pct$/.test(metric)) f = 'pct'; else if (/(Cents|Valor|Capital)$/.test(metric) && typeof v === 'number') f = 'brl'; else f = typeof v === 'number' ? 'int' : 'texto'; }
    if (f === 'data') return dataBR(v); if (f === 'pct') return Number(v).toLocaleString('pt-BR') + '%'; if (f === 'brl') return brl(v); if (f === 'dias') return Number(v).toLocaleString('pt-BR') + ' dias';
    if (f === 'int') return Number(v).toLocaleString('pt-BR'); return String(v);
  }
  var PRIO = { alta: ['Alta', 'alta'], media: ['Média', 'media'], baixa: ['Baixa', 'baixa'] };
  function entidadeParaTela(e, cfg) {
    return { id: e.id == null ? null : e.id, nome: e.nome || cfg.rotuloSemNome || 'Item sem nome', tipo: e.tipo || null, prioridade: e.prioridade && PRIO[e.prioridade] ? { rotulo: PRIO[e.prioridade][0], classe: PRIO[e.prioridade][1] } : null, extras: (e.extras || []).map(function (x) { return { rotulo: x.label, valor: formatar(x.metric, x.value, cfg) }; }),
      motivos: (e.reasonCodes || []).map(function (m) { return m.label || m.code; }), evidencias: (e.evidence || []).map(function (x) { return { rotulo: x.label || x.metric, valor: formatar(x.metric, x.value, cfg) }; }) };
  }
  /** Modelo de resposta para a tela. resp = retorno do aiAgente. */
  function modeloResposta(resp, cfg) {
    cfg = cfg || {}; var ent = (resp.entities && resp.entities.length ? resp.entities : (resp.fallback || [])).map(function (e) { return entidadeParaTela(e, cfg); });
    var recs = (resp.recommendations || []).map(function (r) { return { entidade: r.entity ? (r.entity.nome || null) : null, acao: r.actionLabel || r.action, justificativa: r.rationale }; });
    var iaOk = !!(resp.ia && resp.ia.status === 'OK');
    return { ok: !!resp.ok, iaOk: iaOk, mensagem: mensagemIA(resp.ia, cfg.msgSemDados), resposta: resp.answer || null, entidades: ent, recomendacoes: recs, avisos: (resp.warnings || []).concat(resp.avisoFrescor ? [resp.avisoFrescor] : []).concat(!iaOk ? (resp.limitacoes || []) : []),
      indisponivel: resp.unavailable || [], frescor: resp.dataFreshness || null, rodape: resp.ia && resp.ia.modelo ? 'Respostas de IA podem conter erros: confira os números no módulo. O agente só recomenda; não altera nada.' : null };
  }
  function cartoes(resumo, cfg) { resumo = resumo || {}; return (cfg.cartoes || []).map(function (c) { var v = resumo[c.chave]; return { rotulo: c.rotulo, valor: v == null ? 0 : formatar(c.chave, v, cfg) }; }); }
  function htmlCartoes(resumo, cfg) { return cartoes(resumo, cfg).map(function (c) { return '<div class="agw-card"><b>' + esc(c.valor) + '</b><span>' + esc(c.rotulo) + '</span></div>'; }).join(''); }
  function htmlChips(cfg, ocupado) { return (cfg.sugestoes || []).map(function (s, i) { return '<button type="button" class="agw-chip" data-agw="' + i + '"' + (ocupado ? ' disabled' : '') + '>' + esc(s.rotulo) + '</button>'; }).join(''); }
  function htmlResposta(m, cfg) {
    var h = [];
    if (m.mensagem) h.push('<div class="agw-msg">' + esc(m.mensagem) + '</div>');
    if (m.resposta) h.push('<div class="agw-txt">' + esc(m.resposta) + '</div>');
    if (m.entidades.length) { if (!m.iaOk) h.push('<div class="agw-sub">Resultado calculado pelo sistema (sem IA):</div>');
      h.push(m.entidades.map(function (c) { return '<div class="agw-ent"><div class="agw-n">' + esc(c.nome) + (c.prioridade ? ' <span class="agw-tag ' + esc(c.prioridade.classe) + '">Prioridade ' + esc(c.prioridade.rotulo) + '</span>' : '') + (c.tipo ? ' <span class="agw-sub">' + esc(c.tipo) + '</span>' : '') + (c.id != null && cfg.onAbrir ? ' <button type="button" class="agw-link" data-agw-abrir="' + esc(c.id) + '">' + esc(cfg.rotuloAbrir || 'Abrir') + '</button>' : '') + '</div>' +
        (c.motivos.length ? '<div class="agw-mot">' + c.motivos.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' : '') +
        (c.evidencias.length ? '<div class="agw-ev">' + c.evidencias.map(function (e) { return '<span>' + esc(e.rotulo) + ': <b>' + esc(e.valor) + '</b></span>'; }).join('') + '</div>' : '') + '</div>'; }).join('')); }
    if (m.recomendacoes.length) h.push('<div class="agw-sub" style="margin-top:.4rem">Recomendações (sugestões, não ações):</div>' + m.recomendacoes.map(function (r) { return '<div class="agw-rec"><b>' + esc(r.acao) + '</b>' + (r.entidade ? ' — ' + esc(r.entidade) : '') + '<div class="agw-sub">' + esc(r.justificativa) + '</div></div>'; }).join(''));
    if (m.indisponivel.length) h.push('<div class="agw-sub">Não disponível: ' + m.indisponivel.map(esc).join('; ') + '</div>');
    if (m.avisos.length) h.push('<div class="agw-sub">' + m.avisos.map(esc).join(' · ') + '</div>');
    if (m.frescor) h.push('<div class="agw-foot">' + esc(m.frescor) + '</div>');
    if (m.rodape) h.push('<div class="agw-foot">' + esc(m.rodape) + '</div>');
    return h.join('');
  }
  var CSS = '.agw-box{background:#fff;border:1px solid #e8eaed;border-radius:12px;padding:1rem}.agw-h{display:flex;align-items:center;gap:.5rem;font-weight:700;font-size:1.02rem}.agw-beta{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#174ea6;background:#e8f0fe;border-radius:999px;padding:.1rem .5rem}.agw-sub{font-size:.8rem;color:#5f6368}.agw-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.55rem;margin:.6rem 0 .9rem}.agw-card{background:#f8f9fa;border-radius:10px;padding:.5rem .65rem}.agw-card b{display:block;font-size:1.2rem}.agw-card span{font-size:.7rem;color:#5f6368;text-transform:uppercase;letter-spacing:.03em}.agw-chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.7rem}.agw-chip{border:1px solid #dadce0;background:#fff;border-radius:999px;padding:.38rem .8rem;font-size:.8rem;font-weight:600;cursor:pointer}.agw-chip:hover:not(:disabled){border-color:#1a73e8;color:#174ea6}.agw-chip:disabled{opacity:.55;cursor:default}.agw-form{display:flex;gap:.5rem;align-items:flex-start;margin-bottom:.9rem}.agw-form textarea{flex:1;border:1px solid #dadce0;border-radius:10px;padding:.55rem .7rem;font:inherit;min-height:44px;resize:vertical}.agw-form button{border:0;background:#1a73e8;color:#fff;border-radius:10px;padding:.6rem 1rem;font-weight:700;cursor:pointer}.agw-form button:disabled{opacity:.55}.agw-resp{border-top:1px solid #f1f3f4;padding-top:.9rem}.agw-txt{white-space:pre-wrap;font-size:.92rem;margin-bottom:.8rem}.agw-msg{background:#fef7e0;border:1px solid #fde293;border-radius:10px;padding:.55rem .75rem;font-size:.85rem;margin-bottom:.7rem}.agw-ent{border:1px solid #f1f3f4;border-radius:10px;padding:.65rem .8rem;margin-bottom:.55rem}.agw-n{font-weight:700;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.agw-tag{font-size:.68rem;font-weight:700;border-radius:6px;padding:.1rem .45rem}.agw-tag.alta{background:#fce8e6;color:#b31412}.agw-tag.media{background:#fef7e0;color:#92400e}.agw-tag.baixa{background:#e8f0fe;color:#174ea6}.agw-link{border:0;background:none;color:#1a73e8;font-weight:600;cursor:pointer;padding:0}.agw-mot{display:flex;flex-wrap:wrap;gap:.3rem;margin:.35rem 0}.agw-mot span{font-size:.75rem;background:#f1f3f4;border-radius:6px;padding:.1rem .45rem}.agw-ev{font-size:.76rem;color:#5f6368;display:flex;flex-wrap:wrap;gap:.2rem .9rem}.agw-ev b{color:#202124}.agw-rec{margin-bottom:.4rem}.agw-foot{font-size:.72rem;color:#80868b;margin-top:.6rem}.agw-load{color:#5f6368;font-size:.9rem}';
  /** DOM (navegador). cfg: { agentType, titulo, sub, cartoes:[{chave,rotulo}], sugestoes:[{rotulo,modo,pergunta}], placeholder, chamar(payload)→Promise<data>, onAbrir?(id), rotuloAbrir?, formatos?, rotulosValor?, msgSemDados? } */
  function montar(container, cfg) {
    if (!document.getElementById('agw-css')) { var st = document.createElement('style'); st.id = 'agw-css'; st.textContent = CSS; document.head.appendChild(st); }
    var estado = { ocupado: false, carregado: false };
    container.innerHTML = '<div class="agw-box"><div class="agw-h">' + esc(cfg.titulo) + ' <span class="agw-beta">beta</span></div><div class="agw-sub" style="margin:.25rem 0 .6rem">' + esc(cfg.sub || 'Interpreta fatos calculados pelo sistema. Recomenda — não altera nada.') + '</div><div class="agw-cards" data-r="cards"></div><div class="agw-chips" data-r="chips"></div><form class="agw-form" data-r="form"><textarea data-r="q" maxlength="' + PERGUNTA_MAX + '" rows="2" placeholder="' + esc(cfg.placeholder || 'Pergunte ao agente') + '" aria-label="Pergunta ao agente"></textarea><button type="submit" data-r="enviar">Perguntar</button></form><div class="agw-resp" data-r="resp" aria-live="polite"></div></div>';
    var $ = function (n) { return container.querySelector('[data-r="' + n + '"]'); }; var ultimaResposta = null;
    function chips() { $('chips').innerHTML = htmlChips(cfg, estado.ocupado); }
    function erro(e) { var cod = e && e.code ? String(e.code) : ''; return cod.includes('resource-exhausted') ? 'Muitas perguntas em pouco tempo (ou limite diário do agente). Tente mais tarde.' : cod.includes('permission-denied') ? 'Você não tem acesso a este agente.' : 'Não foi possível consultar o agente agora. O módulo continua funcionando normalmente.'; }
    async function perguntar(modo, pergunta) {
      if (estado.ocupado) return;
      if (modo === 'pergunta') { var v = validarPergunta(pergunta); if (!v.ok) { $('resp').innerHTML = '<div class="agw-msg">' + esc(v.tamanho ? 'Pergunta passa de ' + PERGUNTA_MAX + ' caracteres.' : 'Escreva uma pergunta.') + '</div>'; return; } pergunta = v.texto; }
      estado.ocupado = true; chips(); $('enviar').disabled = true; $('resp').innerHTML = '<div class="agw-load">Analisando…</div>';
      try { var r = await cfg.chamar(modo === 'resumo' ? { agentType: cfg.agentType, modo: 'resumo' } : { agentType: cfg.agentType, modo: 'pergunta', pergunta: pergunta }); ultimaResposta = r; $('resp').innerHTML = htmlResposta(modeloResposta(r, cfg), cfg); if (r.resumo) $('cards').innerHTML = htmlCartoes(r.resumo, cfg); }
      catch (e) { $('resp').innerHTML = '<div class="agw-msg">' + esc(erro(e)) + '</div>'; }
      finally { estado.ocupado = false; chips(); $('enviar').disabled = false; }
    }
    async function abrir() { chips(); if (estado.carregado) return; estado.carregado = true; try { var r = await cfg.chamar({ agentType: cfg.agentType, modo: 'contagens' }); $('cards').innerHTML = htmlCartoes(r.resumo, cfg); if (r.avisoFrescor) $('resp').innerHTML = '<div class="agw-msg">' + esc(r.avisoFrescor) + '</div>'; } catch (e) { estado.carregado = false; $('cards').innerHTML = ''; } }
    $('form').addEventListener('submit', function (e) { e.preventDefault(); perguntar('pergunta', $('q').value); });
    $('chips').addEventListener('click', function (e) { var b = e.target.closest('[data-agw]'); if (!b) return; var s = (cfg.sugestoes || [])[Number(b.getAttribute('data-agw'))]; if (!s) return; if (s.pergunta) $('q').value = s.pergunta; perguntar(s.modo || 'pergunta', s.pergunta); });
    $('resp').addEventListener('click', function (e) { var b = e.target.closest('[data-agw-abrir]'); if (b && cfg.onAbrir) cfg.onAbrir(b.getAttribute('data-agw-abrir')); });
    return { abrir: abrir, perguntar: perguntar };
  }
  /** Gate do frontend: só mostra o botão/aba depois que o BACKEND confirma (modo acesso). Esconder a aba nunca é a proteção. */
  function liberarSePermitido(chamar, agentType, aoLiberar) { return chamar({ agentType: agentType, modo: 'acesso' }).then(function (r) { if (r && r.acesso === true) aoLiberar(); }).catch(function () {}); }
  return { PERGUNTA_MAX: PERGUNTA_MAX, esc: esc, validarPergunta: validarPergunta, mensagemIA: mensagemIA, formatar: formatar, modeloResposta: modeloResposta, htmlResposta: htmlResposta, htmlCartoes: htmlCartoes, htmlChips: htmlChips, montar: montar, liberarSePermitido: liberarSePermitido };
});
