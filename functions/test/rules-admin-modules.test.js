'use strict';

/**
 * Testes dos módulos administrativos — coleções recém-adicionadas às Rules
 *
 * Cobre: compras_config / expedicao_pedidos / marketing_* / garantias /
 *        fornecedores_custo / clientes / conversas(+msgs) / conversas_resumo / chat_status
 *
 * Perfis testados em cada coleção:
 *   A — sem auth          → NEGADO
 *   B — funcionário ativo → NEGADO
 *   C — gestor            → PERMITIDO (CRUD completo)
 *   D — auth sem perfil   → NEGADO
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

const UID_GESTOR    = 'uid-adm-gestor';
const UID_FUNC      = 'uid-adm-func';
const UID_NOPROFILE = 'uid-adm-noprofile';
const FUNC_ID       = 'func-adm-001';

let testEnv;

const SEED = async db => {
  await db.collection('users').doc(UID_GESTOR).set({ role: 'gestor',      ativo: true });
  await db.collection('users').doc(UID_FUNC).set(  { role: 'funcionario', ativo: true,  funcionarioId: FUNC_ID });
  await db.collection('funcionarios').doc(FUNC_ID).set({ nome: 'Func Adm', cargo: 'Vendedor' });
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host: 'localhost', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async ctx => { await SEED(ctx.firestore()); });
});

afterAll(async () => { await testEnv.cleanup(); });

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async ctx => { await SEED(ctx.firestore()); });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const db = (uid) => uid
  ? testEnv.authenticatedContext(uid).firestore()
  : testEnv.unauthenticatedContext().firestore();

// Semear um doc via bypass (para testes de leitura/deleção)
const seed = async (col, id, data) => testEnv.withSecurityRulesDisabled(async ctx =>
  ctx.firestore().collection(col).doc(id).set(data));

// ══════════════════════════════════════════════════════
// Macro: testa os 4 perfis para uma coleção gestor-only
// ══════════════════════════════════════════════════════

function suitesGestorOnly(label, col, docId, docData) {
  describe(`${label} — acesso`, () => {
    test(`${col}:A — sem auth NÃO lê`, async () => {
      await seed(col, docId, docData);
      await assertFails(db(null).collection(col).doc(docId).get());
    });
    test(`${col}:A — sem auth NÃO escreve`, async () => {
      await assertFails(db(null).collection(col).doc(docId).set(docData));
    });
    test(`${col}:B — funcionário NÃO lê`, async () => {
      await seed(col, docId, docData);
      await assertFails(db(UID_FUNC).collection(col).doc(docId).get());
    });
    test(`${col}:B — funcionário NÃO cria`, async () => {
      await assertFails(db(UID_FUNC).collection(col).doc(docId).set(docData));
    });
    test(`${col}:D — sem perfil NÃO lê`, async () => {
      await seed(col, docId, docData);
      await assertFails(db(UID_NOPROFILE).collection(col).doc(docId).get());
    });
    test(`${col}:D — sem perfil NÃO escreve`, async () => {
      await assertFails(db(UID_NOPROFILE).collection(col).doc(docId).set(docData));
    });
    test(`${col}:C — gestor lê`, async () => {
      await seed(col, docId, docData);
      await assertSucceeds(db(UID_GESTOR).collection(col).doc(docId).get());
    });
    test(`${col}:C — gestor cria`, async () => {
      await assertSucceeds(db(UID_GESTOR).collection(col).doc('novo-' + docId).set(docData));
    });
    test(`${col}:C — gestor atualiza`, async () => {
      await seed(col, docId, docData);
      await assertSucceeds(db(UID_GESTOR).collection(col).doc(docId).update({ _ts: Date.now() }));
    });
    test(`${col}:C — gestor deleta`, async () => {
      await seed(col, docId, docData);
      await assertSucceeds(db(UID_GESTOR).collection(col).doc(docId).delete());
    });
  });
}

// ══════════════════════════════════════════════════════
// BLOCO A — compras_config
// ══════════════════════════════════════════════════════

suitesGestorOnly(
  'compras_config',
  'compras_config',
  'settings',
  { caixaDisponivel: 5000, fornecedores: [], mapeamento: {} }
);

// ══════════════════════════════════════════════════════
// BLOCO B — expedicao_pedidos
// ══════════════════════════════════════════════════════

// Expedição P0: a coleção deixou de ser CRUD livre. Leitura igual; criação só em 'ag' com formato conhecido;
// update só por transição com protocolo (coberto em expedicao-p0-emulador.test.js); delete proibido.
describe('expedicao_pedidos — acesso (P0: máquina de estados)', () => {
  const col = 'expedicao_pedidos';
  const pedido = id => ({ numero: id, data: '2026-09-29', hora: '09:00', ingresadoEm: Date.now(), movidoEm: Date.now(), coluna: 'ag', cliente: 'Cliente X', vendedor: 'V', itens: 1, valor: 10, cidade: '', envio: null, saidaEm: null });
  test(`${col}:A — sem auth NÃO lê nem escreve`, async () => {
    await seed(col, 'ped-001', pedido('ped-001'));
    await assertFails(db(null).collection(col).doc('ped-001').get());
    await assertFails(db(null).collection(col).doc('ped-002').set(pedido('ped-002')));
  });
  test(`${col}:B — funcionário sem módulo NÃO lê nem cria`, async () => {
    await seed(col, 'ped-001', pedido('ped-001'));
    await assertFails(db(UID_FUNC).collection(col).doc('ped-001').get());
    await assertFails(db(UID_FUNC).collection(col).doc('ped-002').set(pedido('ped-002')));
  });
  test(`${col}:D — sem perfil NÃO lê nem escreve`, async () => {
    await seed(col, 'ped-001', pedido('ped-001'));
    await assertFails(db(UID_NOPROFILE).collection(col).doc('ped-001').get());
    await assertFails(db(UID_NOPROFILE).collection(col).doc('ped-002').set(pedido('ped-002')));
  });
  test(`${col}:C — gestor lê e cria pedido novo em 'ag'`, async () => {
    await seed(col, 'ped-001', pedido('ped-001'));
    await assertSucceeds(db(UID_GESTOR).collection(col).doc('ped-001').get());
    await assertSucceeds(db(UID_GESTOR).collection(col).doc('novo-ped-001').set(pedido('novo-ped-001')));
  });
  test(`${col}:C — gestor NÃO faz update livre, NÃO cria fora do formato e NÃO deleta`, async () => {
    await seed(col, 'ped-001', pedido('ped-001'));
    await assertFails(db(UID_GESTOR).collection(col).doc('ped-001').update({ _ts: Date.now() }));
    await assertFails(db(UID_GESTOR).collection(col).doc('ped-003').set({ numero: 1, cliente: 'Cliente X', status: 'pendente' }));
    await assertFails(db(UID_GESTOR).collection(col).doc('ped-001').delete());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO C — marketing_conteudos / marketing_ideias / marketing_legendas
// ══════════════════════════════════════════════════════

suitesGestorOnly('marketing_conteudos', 'marketing_conteudos', 'cont-001', { titulo: 'Post 1', etapa: 'ideia' });
suitesGestorOnly('marketing_ideias',    'marketing_ideias',    'ideia-001', { titulo: 'Ideia X', tipo: 'reels' });
suitesGestorOnly('marketing_legendas',  'marketing_legendas',  'leg-001',  { texto: 'Legenda XYZ', criadoEm: Date.now() });

// ══════════════════════════════════════════════════════
// BLOCO D — garantias
// ══════════════════════════════════════════════════════

suitesGestorOnly(
  'garantias',
  'garantias',
  'gar-001',
  { cliente: 'Joao', produto: 'Motor', etapa: 'aberta', criadoEm: Date.now() }
);

// ══════════════════════════════════════════════════════
// BLOCO E — fornecedores_custo
// ══════════════════════════════════════════════════════

suitesGestorOnly(
  'fornecedores_custo',
  'fornecedores_custo',
  'forn-001',
  { nome: 'Fornecedor A', pct_nota: 80, margem_padrao: 25 }
);

// ══════════════════════════════════════════════════════
// BLOCO F — clientes (CRM)
// ══════════════════════════════════════════════════════

suitesGestorOnly(
  'clientes',
  'clientes',
  'cli-001',
  { nome: 'Cliente CRM', pipeline: 'Lead', criado_em: Date.now() }
);

// ══════════════════════════════════════════════════════
// BLOCO G — conversas (raiz) e subcoleção msgs
// ══════════════════════════════════════════════════════

describe('conversas — documento raiz', () => {
  test('conv:A — sem auth NÃO lê', async () => {
    await seed('conversas', '5585999990000', { nome: 'Test' });
    await assertFails(db(null).collection('conversas').doc('5585999990000').get());
  });
  test('conv:B — funcionário NÃO lê', async () => {
    await seed('conversas', '5585999990000', { nome: 'Test' });
    await assertFails(db(UID_FUNC).collection('conversas').doc('5585999990000').get());
  });
  test('conv:C — gestor lê raiz conversas', async () => {
    await seed('conversas', '5585999990000', { nome: 'Test' });
    await assertSucceeds(db(UID_GESTOR).collection('conversas').doc('5585999990000').get());
  });
});

describe('conversas/{phone}/msgs — subcoleção', () => {
  const PHONE = '5585988880000';
  const MSG_ID = 'msg-001';

  test('msgs:A — sem auth NÃO lê msgs', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).set({ texto: 'oi', from: 'cliente' });
    });
    await assertFails(db(null).collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).get());
  });

  test('msgs:B — funcionário NÃO lê msgs', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).set({ texto: 'oi', from: 'cliente' });
    });
    await assertFails(db(UID_FUNC).collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).get());
  });

  test('msgs:B — funcionário NÃO envia msg', async () => {
    await assertFails(db(UID_FUNC).collection(`conversas/${PHONE}/msgs`).add({ texto: 'fraude', from: 'gestor' }));
  });

  test('msgs:D — sem perfil NÃO lê msgs', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).set({ texto: 'oi' });
    });
    await assertFails(db(UID_NOPROFILE).collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).get());
  });

  test('msgs:C — gestor lê msgs', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).set({ texto: 'oi', from: 'cliente' });
    });
    await assertSucceeds(db(UID_GESTOR).collection(`conversas/${PHONE}/msgs`).doc(MSG_ID).get());
  });

  test('msgs:C — gestor envia msg', async () => {
    await assertSucceeds(db(UID_GESTOR).collection(`conversas/${PHONE}/msgs`).add({
      texto: 'Olá, como posso ajudar?', from: 'empresa', momment: new Date().toISOString(),
    }));
  });
});

// ══════════════════════════════════════════════════════
// BLOCO H — conversas_resumo
// ══════════════════════════════════════════════════════

suitesGestorOnly(
  'conversas_resumo',
  'conversas_resumo',
  '5585911110000',
  { nome: 'Fulano', ultimaMensagem: 'oi', naoLidas: 2 }
);

// ══════════════════════════════════════════════════════
// BLOCO I — chat_status
// ══════════════════════════════════════════════════════

suitesGestorOnly(
  'chat_status',
  'chat_status',
  '5585922220000',
  { phone: '5585922220000', status: 'connected', atualizadoEm: new Date().toISOString() }
);
