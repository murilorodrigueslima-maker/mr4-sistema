'use strict';
// Etapa B — isolamento da loja: só MR4 DISTRIBUIDORA (loja_id=262759); FOCUS PARTS (424483) nunca é consultada nem importada.
const G = require('../lib/gcHttp');
const ok = (data = [], meta = {}) => ({ status: 200, headers: { get: () => null }, json: async () => ({ code: 200, status: 'success', data, meta: { total_registros: data.length || null, proxima_pagina: null, pagina_atual: 1, ...meta } }) });
const mk = (resposta) => { const urls = []; const c = G.criarCliente({ transporte: async u => { urls.push(u); return typeof resposta === 'function' ? resposta(u) : resposta; }, credenciais: { access: 'a', secret: 's' }, dormir: async () => {} }); return { c, urls }; };

describe('Etapa B — consulta', () => {
  test('constantes: loja ativa 262759; FOCUS PARTS bloqueada', () => { expect(G.LOJA_ATIVA_ID).toBe('262759'); expect(G.LOJAS_BLOQUEADAS).toContain('424483'); expect(G.LOJAS_BLOQUEADAS).not.toContain('262759'); });
  test.each(['/vendas', '/pagamentos', '/recebimentos', '/produtos'])('%s leva loja_id=262759 mesmo sem o chamador pedir', async caminho => {
    const { c, urls } = mk(ok([{ id: '1' }])); await c.get(caminho, { pagina: 1 });
    expect(new URL(urls[0]).searchParams.get('loja_id')).toBe('262759');
  });
  test.each(['/clientes', '/fornecedores', '/situacoes_vendas'])('%s (sem escopo de loja na API) não recebe loja_id', async caminho => {
    const { c, urls } = mk(ok([{ id: '1' }])); await c.get(caminho, {}); expect(new URL(urls[0]).searchParams.has('loja_id')).toBe(false);
  });
  test('pedir a FOCUS PARTS (424483) é RECUSADO antes de qualquer chamada', async () => {
    const { c, urls } = mk(ok()); await expect(c.get('/vendas', { loja_id: '424483' })).rejects.toMatchObject({ codigo: 'GC_LOJA_NAO_AUTORIZADA' }); expect(urls).toHaveLength(0);
  });
  test('pedir qualquer outra loja também é recusado; repetir a loja ativa é aceito', async () => {
    const { c, urls } = mk(ok([{ id: '1' }])); await expect(c.get('/vendas', { loja_id: '999' })).rejects.toMatchObject({ codigo: 'GC_LOJA_NAO_AUTORIZADA' });
    await c.get('/vendas', { loja_id: 262759 }); expect(urls).toHaveLength(1);
  });
});

describe('Etapa B — contaminação na resposta', () => {
  test('registro que declara outra loja ABORTA a leitura inteira (nada é aproveitado)', async () => {
    const { c } = mk(ok([{ id: '1', loja_id: '262759' }, { id: '2', loja_id: '424483' }]));
    await expect(G.paginarCompleto(c, '/vendas', {}, { exigirTotal: false })).rejects.toMatchObject({ codigo: 'GC_LOJA_DIVERGENTE' });
  });
  test('registros da loja ativa (ou sem campo loja_id) passam', async () => {
    const { c } = mk(ok([{ id: '1', loja_id: '262759' }, { id: '2' }, { id: '3', loja_id: 262759 }]));
    expect((await G.paginarCompleto(c, '/vendas', {}, { exigirTotal: false })).itens).toHaveLength(3);
  });
});
