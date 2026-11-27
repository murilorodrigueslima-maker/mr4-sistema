'use strict';
/**
 * gcQuery — minimização e fronteira de loja (revisão técnica de 27/11/2026, achados 14 e 15).
 * Emulador; fetch simulado (nenhuma chamada ao GestãoClick). Prova também que as telas publicadas não leem o que foi retirado.
 */
process.env.GCLOUD_PROJECT = 'mr4-ponto';
process.env.GC_ACCESS_TOKEN = 'mock-access-token-test';
process.env.GC_SECRET_ACCESS_TOKEN = 'mock-secret-token-test';

const fs = require('fs'), path = require('path');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const { _gcQueryHandler, _gcOperacoes } = require('../index');

const GESTOR = 'uid-gcmin-gestor', EXPEDICAO = 'uid-gcmin-expedicao';
const chamar = (uid, operacao, dados = {}) => _gcQueryHandler({ auth: { uid, token: {} }, data: { operacao, dados } });
const responder = (corpo, { status = 200 } = {}) => { global.fetch = jest.fn(async () => ({ ok: status < 300, status, json: async () => (typeof corpo === 'string' ? JSON.parse(corpo) : corpo), text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) })); };
const VENDA = { id: '1', codigo: '900', data: '2026-11-27', nome_cliente: 'Cliente Sintético', cliente_id: '555', valor_total: '99.00', nome_vendedor: 'V', cidade: 'Fortaleza',
  produtos: [{ produto: { produto_id: '7', nome_produto: 'Peça', quantidade: '2', valor_custo: '31.37', valor_venda: '49.50' } }] };

beforeAll(async () => {
  await db.collection('users').doc(GESTOR).set({ role: 'gestor', ativo: true, nome: 'Gestor' });
  await db.collection('sistema_usuarios').doc(GESTOR).set({ modulos: ['garantia', 'compras', 'expedicao'], admin: false });
  await db.collection('users').doc(EXPEDICAO).set({ role: 'funcionario', ativo: true, nome: 'Exp' });
  await db.collection('sistema_usuarios').doc(EXPEDICAO).set({ modulos: ['expedicao'], admin: false });
});
afterAll(async () => { await admin.app().delete(); });

describe('LISTAR_VENDAS: o que sai para o navegador', () => {
  test('expedição: recebe os campos de despacho, sem custo, preço por item nem código do cliente no ERP', async () => {
    responder({ data: [VENDA], meta: {} });
    const [v] = (await chamar(EXPEDICAO, 'LISTAR_VENDAS')).data;
    expect(v).toMatchObject({ numero: '900', cliente: 'Cliente Sintético', vendedor: 'V', valor: '99.00', itens: 1, cidade: 'Fortaleza', produtos: [{ id: '7', nome: 'Peça', quantidade: 2 }] });
    expect(v).not.toHaveProperty('cliente_id'); expect(v.produtos[0]).not.toHaveProperty('valor_custo'); expect(v.produtos[0]).not.toHaveProperty('valor_venda');
    expect(JSON.stringify(v)).not.toMatch(/31\.37|49\.5|555/);
  });
  test('gestor: mantém código do cliente e preço; custo por item não sai para ninguém', async () => {
    responder({ data: [VENDA], meta: {} });
    const [v] = (await chamar(GESTOR, 'LISTAR_VENDAS')).data;
    expect(v.cliente_id).toBe('555'); expect(v.produtos[0].valor_venda).toBe(49.5); expect(v.produtos[0]).not.toHaveProperty('valor_custo');
  });
  test('o normalizador interno (sync da Expedição) continua completo', () => {
    const d = _gcOperacoes.LISTAR_VENDAS.dto(VENDA); expect(d.cliente_id).toBe('555'); expect(d.produtos[0].valor_custo).toBe(31.37);
  });
});

test('LISTAR_RECEBIMENTOS não devolve o nome do cliente (nenhuma tela usa); LISTAR_PAGAMENTOS inalterado', async () => {
  responder({ data: [{ id: '1', valor: '5', cliente: { nome: 'Pessoa Sintética' }, fornecedor: { nome: 'Fornecedor X' } }], meta: {} });
  const r = (await chamar(GESTOR, 'LISTAR_RECEBIMENTOS')).data[0]; expect(r).toMatchObject({ id: '1', valor: '5' }); expect(JSON.stringify(r)).not.toMatch(/Sint/);
  expect((await chamar(GESTOR, 'LISTAR_PAGAMENTOS')).data[0].fornecedor).toEqual({ nome: 'Fornecedor X' });
});

describe('CONSULTAR_PRODUTO: loja declarada na resposta', () => {
  const detalhe = extra => ({ code: 200, status: 'success', data: { id: '42', nome: 'Produto', ...extra } });
  test.each([[{ loja_id: '424483' }], [{ loja_id: 999999 }], [{ nome_loja: 'FOCUS PARTS' }]])('outra loja declarada %j ⇒ recusa, sem devolver nada', async extra => {
    for (const corpo of [detalhe(extra), { id: '42', nome: 'Produto', ...extra }]) {
      responder(corpo); await expect(chamar(GESTOR, 'CONSULTAR_PRODUTO', { produtoId: '42' })).rejects.toMatchObject({ code: 'failed-precondition' });
    }
  });
  test.each([[{}], [{ loja_id: '262759' }], [{ nome_loja: ' Mr4  Distribuidora ' }]])('loja ativa ou sem declaração %j ⇒ segue como antes', async extra => {
    responder(detalhe(extra)); await expect(chamar(GESTOR, 'CONSULTAR_PRODUTO', { produtoId: '42' })).resolves.toHaveProperty('data');
    responder({ id: '42', nome: 'Produto', preco_custo: '3', ...extra }); expect((await chamar(GESTOR, 'CONSULTAR_PRODUTO', { produtoId: '42' })).data).toMatchObject({ id: '42', preco_custo: '3' });
  });
});

describe('falhas do ERP não vazam para o navegador', () => {
  const SEGREDO = 'cliente 000.000.000-00 token interno';
  const erro = async () => chamar(GESTOR, 'LISTAR_PRODUTOS').then(() => null, e => e);
  test('HTTP de erro: só o status', async () => {
    responder(SEGREDO, { status: 500 }); const e = await erro(); expect(e.code).toBe('unavailable'); expect(e.message).toBe('GestãoClick retornou 500.');
  });
  test('corpo inválido e falha de rede: mensagem fixa', async () => {
    responder('<html>' + SEGREDO, { status: 200 }); let e = await erro(); expect(e.code).toBe('unavailable'); expect(e.message).not.toContain('000.000');
    global.fetch = jest.fn(async () => { throw new Error('getaddrinfo ' + SEGREDO); }); e = await erro(); expect(e.message).toBe('Erro de rede ao chamar GestãoClick.');
  });
});

describe('prova de que nenhuma tela publicada depende do que foi retirado', () => {
  const raiz = path.resolve(__dirname, '../..');
  const telas = [...['modulos', 'js'].flatMap(d => fs.readdirSync(path.join(raiz, d)).filter(f => /\.(html|js)$/.test(f)).map(f => d + '/' + f)), ...fs.readdirSync(raiz).filter(f => f.endsWith('.html'))];
  test('só a Garantia chama gcQuery, e apenas com busca de clientes, lista e detalhe de produto', () => {
    const quem = telas.filter(f => /httpsCallable\([^)]*['"]gcQuery['"]|_gcQuery\(/.test(fs.readFileSync(path.join(raiz, f), 'utf8')));
    expect(quem).toEqual(['modulos/garantia.html']);
    const ops = telas.flatMap(f => [...fs.readFileSync(path.join(raiz, f), 'utf8').matchAll(/operacao:\s*['"]([A-Z_]+)['"]/g)].map(m => m[1]));
    expect([...new Set(ops)].sort()).toEqual(['CONSULTAR_PRODUTO', 'LISTAR_PRODUTOS', 'PESQUISAR_CLIENTES']);
  });
});
