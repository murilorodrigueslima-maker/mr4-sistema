'use strict';
// Faixa de aviso do endereço antigo: só no github.io, sem redirecionar, dispensável por sessão. DOM mínimo falso.
const A = require('../../js/aviso-endereco.js');
const { aplicar } = require('../../scripts/hosting/aplicar-aviso-endereco.js');
const R = require('../../tools/pages-redirect/gerar.js');

function falso({ host = 'dono.github.io', pathname = '/mr4-sistema/modulos/ponto.html', search = '', hash = '', corpo = {}, html = {}, sessao = {}, semArmazenamento = false } = {}) {
  const criar = tag => ({ tag, style: {}, attrs: {}, filhos: [], eventos: {}, dataset: {},
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(f) { this.filhos.push(f); },
    addEventListener(e, fn) { this.eventos[e] = fn; }, remove() { body.filhos = body.filhos.filter(x => x !== this); } });
  const body = { filhos: ['conteudo'], estilo: { display: 'block', overflow: 'visible', overflowY: 'visible', ...corpo }, get firstChild() { return this.filhos[0]; },
    insertBefore(n) { this.filhos.unshift(n); } };
  const documentElement = { estilo: { overflowY: 'visible', ...html } };
  const store = { ...sessao };
  const win = {
    location: { hostname: host, pathname, search, hash },
    document: { body, documentElement, createElement: criar, getElementById: id => body.filhos.find(x => x.id === id) || null },
    getComputedStyle: el => el.estilo,
    get sessionStorage() { if (semArmazenamento) throw new Error('bloqueado'); return { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } }; },
  };
  return { win, body, store };
}

describe('aviso do endereço antigo', () => {
  test('só o GitHub Pages é endereço antigo; o endereço novo e o local não são afetados', () => {
    expect(A.ehEnderecoAntigo({ hostname: 'dono.github.io' })).toBe(true);
    for (const hostname of ['mr4-ponto.web.app', 'mr4-ponto.firebaseapp.com', 'localhost', '127.0.0.1', 'github.io.exemplo.test', 'meugithub.io', '']) {
      expect(A.ehEnderecoAntigo({ hostname })).toBe(false);
    }
  });
  test('link aponta para a MESMA página no endereço novo, com parâmetros e âncora; destino sempre fixo', () => {
    const d = (pathname, search = '', hash = '') => A.enderecoNovo({ pathname, search, hash });
    expect(d('/mr4-sistema/modulos/ponto.html', '?a=1', '#x')).toBe('https://mr4-ponto.web.app/modulos/ponto.html?a=1#x');
    expect(d('/mr4-sistema/')).toBe('https://mr4-ponto.web.app/');
    expect(d('/mr4-sistema')).toBe('https://mr4-ponto.web.app/');
    expect(d('/mr4-sistema/login.html')).toBe('https://mr4-ponto.web.app/login.html');
    for (const p of ['/mr4-sistema//evil.test', '/mr4-sistema/../x', '/outro/modulos/ponto.html', '/mr4-sistema/docs/x.md']) expect(d(p, '?q=1')).toBe('https://mr4-ponto.web.app/');
    for (const p of R.paginas()) expect(d('/mr4-sistema/' + p)).toBe('https://mr4-ponto.web.app/' + p);
  });
  test('monta sem redirecionar; fecha e não volta na mesma sessão', () => {
    const { win, body, store } = falso();
    const antes = { ...win.location };
    const f = A.montar(win);
    expect(f.attrs['data-modo']).toBe('fluxo'); expect(body.filhos[0]).toBe(f); expect(win.location).toEqual(antes);
    const [, link, fechar] = f.filhos;
    expect(link.href).toBe('https://mr4-ponto.web.app/modulos/ponto.html');
    fechar.eventos.click();
    expect(body.filhos).toEqual(['conteudo']); expect(store[A.CHAVE]).toBe('1');
    expect(A.montar(win)).toBeNull();
  });
  test('não duplica; com armazenamento bloqueado ainda mostra e fecha', () => {
    const { win, body } = falso({ semArmazenamento: true });
    const f = A.montar(win); expect(f).toBeTruthy(); f.id = A.ID; expect(A.montar(win)).toBeNull();
    f.filhos[2].eventos.click(); expect(body.filhos).toEqual(['conteudo']);
  });
  test('tela inteira ou em colunas: flutua (não empurra o layout)', () => {
    for (const corpo of [{ overflow: 'hidden' }, { display: 'flex', flexDirection: 'row' }, { display: 'flex', flexDirection: 'column', alignItems: 'center' }, { display: 'grid' }]) {
      expect(A.montar(falso({ corpo }).win).attrs['data-modo']).toBe('flutuante');
    }
    expect(A.montar(falso({ html: { overflowY: 'hidden' } }).win).attrs['data-modo']).toBe('flutuante');
  });
  test('flutuante se recolhe sozinha sem marcar como fechada; no fluxo permanece', () => {
    const fila = [];
    const a = falso({ corpo: { overflow: 'hidden' } }); a.win.setTimeout = (fn, ms) => fila.push([fn, ms]);
    A.montar(a.win); expect(fila).toHaveLength(1); expect(fila[0][1]).toBe(A.SOME_MS);
    fila[0][0](); expect(a.body.filhos).toEqual(['conteudo']); expect(a.store[A.CHAVE]).toBeUndefined();
    const b = falso(); b.win.setTimeout = () => { throw new Error('não deveria agendar'); };
    expect(A.montar(b.win)).toBeTruthy();
  });
  test('todas as páginas do sistema carregam o aviso (reaplicar: node scripts/hosting/aplicar-aviso-endereco.js)', () => {
    expect(aplicar({ conferir: true })).toEqual({ faltando: [], semHead: [] });
  });
});
