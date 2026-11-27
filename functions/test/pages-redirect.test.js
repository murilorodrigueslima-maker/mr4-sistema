'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { gerar, paginas } = require('../../tools/pages-redirect/gerar');

const HTML = fs.readFileSync(path.join(__dirname, '../../tools/pages-redirect/pagina.html'), 'utf8');
const mod = { exports: {} };
vm.runInNewContext(HTML.match(/<script>([\s\S]*?)<\/script>/)[1], { module: mod });
const { destino, dadosLocais } = mod.exports;
const ir = (pathname, search = '', hash = '') => destino({ pathname, search, hash });
const NOVO = 'https://mr4-ponto.web.app';

describe('redirecionamento do Pages', () => {
  test('preserva página, parâmetros e âncora', () => {
    expect(ir('/mr4-sistema/modulos/ponto-func.html', '?a=1', '#b')).toBe(NOVO + '/modulos/ponto-func.html?a=1#b');
    expect(ir('/mr4-sistema/login.html')).toBe(NOVO + '/login.html');
    expect(ir('/mr4-sistema')).toBe(NOVO + '/');
    expect(ir('/mr4-sistema/')).toBe(NOVO + '/');
  });
  test('caminho desconhecido ou malicioso vai para a página inicial do host fixo', () => {
    for (const p of ['/outro', '/mr4-sistema//exemplo.invalid', '/mr4-sistema/functions/index.js', '/mr4-sistemaX/login.html', '/mr4-sistema/modulos/../x.html']) {
      expect(ir(p, '?x=1')).toBe(NOVO + '/');
    }
  });
  test('só exporta as chaves conhecidas e ignora listas vazias', () => {
    const dados = { mr4_caixa_historico: '[1]', mr4_chat_pins: '[]', 'firebase:authUser:x': 'segredo' };
    expect(Object.keys(dadosLocais({ getItem: k => dados[k] || null }))).toEqual(['mr4_caixa_historico']);
  });
  test('gera todas as páginas do sistema e o 404 nos dois formatos', () => {
    const saida = fs.mkdtempSync(path.join(os.tmpdir(), 'redir-'));
    try {
      const lista = gerar(saida);
      expect(lista).toEqual(paginas());
      for (const rel of lista.concat('404.html')) {
        expect(fs.existsSync(path.join(saida, 'branch-pages', rel))).toBe(true);
        expect(fs.existsSync(path.join(saida, 'site-usuario/mr4-sistema', rel))).toBe(true);
      }
      expect(fs.existsSync(path.join(saida, 'site-usuario/404.html'))).toBe(true);
      expect(() => gerar(saida)).toThrow(/vazia/);
    } finally { fs.rmSync(saida, { recursive: true, force: true }); }
  });
});
