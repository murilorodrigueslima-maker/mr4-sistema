'use strict';
// AGENTE COMPRAS MR4 — Fase C · Rules (EMULADOR): vendas por fornecedor. Unidades = módulo estoque; VALORES EM R$ = só gestor (+ admin|módulo estoque).
// Os documentos usados são os GERADOS pelo agregador real (não fixtures vazias).
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const K = require('../lib/compras/canonico');
const Forn = require('../lib/compras/fornecedores');
jest.setTimeout(60000);
let env, DOCS;
const PERFIS = {
  admin:            { users: { role: 'gestor', ativo: true }, sys: { modulos: [], admin: true } },
  gestorComEstoque: { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'] } },
  gestorSemEstoque: { users: { role: 'gestor', ativo: true }, sys: { modulos: ['vendas'] } },
  funcComEstoque:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['estoque'] } },
  funcSemEstoque:   { users: { role: 'funcionario', ativo: true }, sys: { modulos: ['ponto'] } },
  bloqueado:        { users: { role: 'gestor', ativo: true }, sys: { modulos: ['estoque'], admin: true, bloqueado: true } },
  inativo:          { users: { role: 'funcionario', ativo: false }, sys: { modulos: ['estoque'] } },
  gestorInativo:    { users: { role: 'gestor', ativo: false }, sys: { modulos: ['estoque'] } },
  semPerfilSistema: { users: { role: 'gestor', ativo: true } },
};
const LE_UNIDADES = { admin: true, gestorComEstoque: true, funcComEstoque: true };          // quantidades
const LE_VALORES = { admin: true, gestorComEstoque: true };                                  // R$: funcionário com estoque NÃO lê
const ref = (uid, id) => env.authenticatedContext(uid).firestore().doc('compras_n0_fornecedores/' + id);

beforeAll(async () => {
  const venda = (data, pid, q, t, o = {}) => ({ id: 'V' + data + pid, data, nome_situacao: 'Concretizada', situacao_estoque: '1', valor_produtos: t.toFixed(2), desconto_valor: '0.00', produtos: [{ produto: { produto_id: pid, quantidade: String(q), valor_venda: '1', valor_total: t.toFixed(2) } }] });
  const compra = { Compra: { id: 'C1', data_emissao: '2026-01-01', nome_situacao: 'Confirmada', fornecedor_id: 'F1', valor_produtos: '10.00', produtos: [{ produto: { produto_id: 'P1', quantidade: '1', valor_custo: '10' } }] } };
  const r = Forn.montarFornecedores({ fatosVenda: [venda('2026-08-10', 'P1', 3, 123.45)].flatMap(K.fatosDeVenda), fatosCompra: K.fatosDeCompra(compra), hoje: '2026-10-22', agora: new Date('2026-10-22T19:00:00Z'), nomes: { F1: 'FORNECEDOR TESTE' } });
  DOCS = { unidades: r.unidades, valores: r.valores };
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    for (const [uid, p] of Object.entries(PERFIS)) { await db.doc('users/' + uid).set(p.users); if (p.sys) await db.doc('sistema_usuarios/' + uid).set(p.sys); }
    await db.doc('compras_n0_fornecedores/unidades').set(JSON.parse(JSON.stringify(DOCS.unidades)));
    await db.doc('compras_n0_fornecedores/valores').set(JSON.parse(JSON.stringify(DOCS.valores)));
    await db.doc('compras_n0_fornecedores/outro').set({ fixture: true });
  });
});
afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });

describe('Vendas por fornecedor — matriz de permissões (backend)', () => {
  test('o documento de unidades que a Rules protege NÃO contém nenhum campo monetário; o de valores contém', () => {
    const k = []; const a = x => { if (x && typeof x === 'object') for (const [n, v] of Object.entries(x)) { k.push(n); a(v); } }; a(DOCS.unidades);
    expect(k.filter(n => /cents|liq|faturamento|valor|preco|pre[cç]o|custo|moeda|brl/i.test(n))).toEqual([]);
    expect(DOCS.valores.totais.soma_cents).toBe(12345);
  });
  test.each(['unidades', 'valores'])('ANÔNIMO não lê %s', async id => { await assertFails(env.unauthenticatedContext().firestore().doc('compras_n0_fornecedores/' + id).get()); });
  for (const uid of Object.keys(PERFIS)) {
    test(`${uid} ${LE_UNIDADES[uid] ? 'LÊ' : 'NÃO lê'} unidades`, async () => { const op = ref(uid, 'unidades').get(); await (LE_UNIDADES[uid] ? assertSucceeds(op) : assertFails(op)); });
    test(`${uid} ${LE_VALORES[uid] ? 'LÊ' : 'NÃO lê'} VALORES em R$`, async () => { const op = ref(uid, 'valores').get(); await (LE_VALORES[uid] ? assertSucceeds(op) : assertFails(op)); });
  }
  test('funcionário com estoque lê as quantidades e o que ele recebe não tem NENHUM centavo', async () => {
    const d = (await assertSucceeds(ref('funcComEstoque', 'unidades').get())).data();
    const k = []; const a = x => { if (x && typeof x === 'object') for (const [n, v] of Object.entries(x)) { k.push(n); a(v); } }; a(d);
    expect(k.filter(n => /cents|liq|faturamento|valor|preco|pre[cç]o|custo|moeda|brl/i.test(n))).toEqual([]); expect(JSON.stringify(d)).not.toMatch(/12345|123[,.]45/); expect(d.totais.soma).toBe(3);
  });
  test('leitura de valores devolve o conteúdo completo ao gestor', async () => {
    const d = (await assertSucceeds(ref('gestorComEstoque', 'valores').get())).data();
    expect(d.totais.soma_cents).toBe(12345); expect(d.externos[0].soma_cents).toBe(12345);
  });
  test('listar a coleção inteira é negado a todos (não há atalho para obter o documento de valores)', async () => {
    for (const uid of ['funcComEstoque', 'gestorComEstoque', 'admin']) await assertFails(env.authenticatedContext(uid).firestore().collection('compras_n0_fornecedores').get());
  });
  test('docId fora da lista é negado; ninguém escreve, nem admin (create/update/delete)', async () => {
    await assertFails(ref('admin', 'outro').get());
    for (const uid of ['admin', 'gestorComEstoque', 'funcComEstoque']) {
      await assertFails(ref(uid, 'unidades').set({ x: 1 })); await assertFails(ref(uid, 'valores').update({ 'totais.soma_cents': 1 })); await assertFails(ref(uid, 'valores').delete()); await assertFails(ref(uid, 'novo').set({ x: 1 }));
    }
  });
  test('as regras existentes de Compras continuam como estavam (custos/tela/execuções)', async () => {
    await env.withSecurityRulesDisabled(async c => { const db = c.firestore(); for (const d of ['compras_n0_view/sugestoes', 'compras_n0_view/custos', 'compras_n0_runs/r1']) await db.doc(d).set({ fixture: true }); await db.doc('compras_n0_custos/bloco_000').set({ fixture: true }); });
    const db = uid => env.authenticatedContext(uid).firestore();
    await assertSucceeds(db('funcComEstoque').doc('compras_n0_view/sugestoes').get()); await assertFails(db('funcComEstoque').doc('compras_n0_view/custos').get());
    await assertSucceeds(db('gestorComEstoque').doc('compras_n0_view/custos').get()); await assertFails(db('funcComEstoque').doc('compras_n0_custos/bloco_000').get());
    await assertFails(db('admin').doc('compras_n0_view/fornecedores').get());      // não existe regra para o caminho antigo
  });
});
