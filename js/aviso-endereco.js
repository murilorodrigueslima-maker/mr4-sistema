/**
 * Faixa de aviso exibida SOMENTE no endereço antigo (GitHub Pages): orienta a usar o endereço novo, com link para a mesma página.
 * Não redireciona, não bloqueia, pode ser fechada (vale para a sessão da aba). Em qualquer outro endereço não faz nada.
 * Em telas de página inteira ela flutua no topo e se recolhe sozinha após 12 s, para não encobrir botões.
 * Não coleta nem envia dado algum.
 */
(function (raiz) {
  'use strict';
  var NOVO = 'https://mr4-ponto.web.app';
  var BASE = '/mr4-sistema';
  var CHAVE = 'mr4_aviso_endereco_fechado';
  var ID = 'mr4-aviso-endereco';
  var SOME_MS = 12000;

  function ehEnderecoAntigo(loc) {
    return /(^|\.)github\.io$/i.test(String(loc && loc.hostname || ''));
  }
  /** Mesma página, parâmetros e âncora no endereço novo; destino sempre fixo em NOVO. */
  function enderecoNovo(loc) {
    var p = String(loc.pathname || '/');
    if (p === BASE) p = '/';
    else if (p.indexOf(BASE + '/') === 0) p = p.slice(BASE.length);
    if (!/^\/(?:|index\.html|login\.html|painel-comercial(?:-preview)?\.html|modulos\/[A-Za-z0-9._-]+\.html)$/.test(p)) return NOVO + '/';
    return NOVO + p + String(loc.search || '') + String(loc.hash || '');
  }
  function fechado(win) {
    try { return win.sessionStorage.getItem(CHAVE) === '1'; } catch (e) { return false; }
  }
  /** Páginas que ocupam a tela inteira (sem rolagem ou em colunas) não podem ser empurradas: a faixa flutua. */
  function podeEmpurrar(win, corpo) {
    var b = win.getComputedStyle(corpo), h = win.getComputedStyle(win.document.documentElement);
    if (b.overflow === 'hidden' || b.overflowY === 'hidden' || h.overflowY === 'hidden') return false;
    if (b.display === 'block') return true;
    return b.display === 'flex' && b.flexDirection === 'column' && b.alignItems !== 'center' && b.justifyContent === 'normal';
  }
  function montar(win) {
    var doc = win.document, corpo = doc.body;
    if (!corpo || doc.getElementById(ID) || fechado(win)) return null;
    var fluxo = podeEmpurrar(win, corpo);
    var faixa = doc.createElement('div');
    faixa.id = ID;
    faixa.setAttribute('role', 'region');
    faixa.setAttribute('aria-label', 'Aviso de mudança de endereço');
    faixa.setAttribute('data-modo', fluxo ? 'fluxo' : 'flutuante');
    faixa.style.cssText = 'box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;'
      + 'background:#1e3a8a;color:#fff;font:500 12.5px/1.3 system-ui,-apple-system,sans-serif;letter-spacing:normal;text-transform:none;text-align:center;'
      + (fluxo ? 'width:100%;flex:none;flex-wrap:wrap;column-gap:8px;row-gap:0;padding:2px 8px;'
        : 'position:fixed;top:4px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 120px);white-space:nowrap;padding:0 2px 0 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35);z-index:2147483000;');
    var texto = doc.createElement('span');
    texto.textContent = fluxo ? 'Mudamos de endereço.' : 'Novo endereço:';
    var link = doc.createElement('a');
    link.href = enderecoNovo(win.location);
    link.textContent = fluxo ? 'Abrir no novo endereço' : 'abrir';
    link.title = 'Abrir esta página no novo endereço (mr4-ponto.web.app)';
    link.setAttribute('aria-label', 'Abrir esta página no novo endereço');
    link.rel = 'noreferrer';
    link.style.cssText = 'color:#fff;font-weight:700;text-decoration:underline;padding:6px 2px;';
    var fechar = doc.createElement('button');
    fechar.type = 'button';
    fechar.textContent = '×';
    fechar.setAttribute('aria-label', 'Fechar aviso');
    fechar.style.cssText = 'flex:none;width:30px;height:30px;margin:0;padding:0;border:0;border-radius:999px;background:transparent;color:#fff;font:400 20px/1 system-ui,sans-serif;cursor:pointer;';
    fechar.addEventListener('click', function () {
      try { win.sessionStorage.setItem(CHAVE, '1'); } catch (e) { /* sem armazenamento: só fecha nesta página */ }
      faixa.remove();
    });
    faixa.appendChild(texto); faixa.appendChild(link); faixa.appendChild(fechar);
    corpo.insertBefore(faixa, corpo.firstChild);
    // Flutuando, pode encobrir um botão do topo: sai sozinha depois de um tempo (volta na próxima página; não conta como fechada).
    if (!fluxo && win.setTimeout) win.setTimeout(function () { faixa.remove(); }, SOME_MS);
    return faixa;
  }

  var api = { ehEnderecoAntigo: ehEnderecoAntigo, enderecoNovo: enderecoNovo, podeEmpurrar: podeEmpurrar, montar: montar, CHAVE: CHAVE, ID: ID, SOME_MS: SOME_MS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  raiz.MR4AvisoEndereco = api;
  if (!ehEnderecoAntigo(raiz.location)) return;
  if (raiz.document.readyState === 'loading') raiz.document.addEventListener('DOMContentLoaded', function () { montar(raiz); });
  else montar(raiz);
})(typeof window !== 'undefined' ? window : this);
