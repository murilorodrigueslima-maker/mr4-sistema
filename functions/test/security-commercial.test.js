'use strict';

/**
 * Testes de segurança — módulos comerciais (S0)
 *
 * OBJETIVO: Documentar o estado atual de segurança e os GAPs conhecidos.
 *
 * Seção A — Estado correto (já funciona)
 *   Confirma que usuários sem auth e funcionários estão barrados.
 *
 * Seção B — GAPs documentados (vulnerabilidades atuais)
 *   Usa assertSucceeds para CONFIRMAR que o gap existe.
 *   Esses testes passam AGORA, e devem ser INVERTIDOS (assertFails) após S5.
 *   Marcados com comentário GAP:S5.
 *
 * Seção C — Autorização futura (desativados — habilitados em S5)
 *   Testes da autorização real por módulo.
 *   Desativados com test.skip enquanto temModulo() não estiver em produção.
 *
 * Seção D — display_metrics (desativado — habilitado em S3)
 *   Testes da role=display.
 *   Desativados enquanto a collection e a regra não existirem.
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=security-commercial
 *
 * Pré-requisito:
 *   Firebase emulators rodando: firestore (8080) + auth (9099)
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID  = 'mr4-ponto';
const RULES_PATH  = resolve(__dirname, '../../modulos/firestore.rules');

// ── UIDs de teste ──────────────────────────────────────────────────────────────
const UID_GESTOR_SEM_MODULOS  = 'uid-sec-gestor-nenhum-modulo';
const UID_GESTOR_COM_CLIENTES = 'uid-sec-gestor-modulo-clientes';
const UID_GESTOR_FINANCEIRO   = 'uid-sec-gestor-modulo-financeiro';
const UID_GESTOR_EXPEDICAO    = 'uid-sec-gestor-modulo-expedicao';
const UID_FUNC                = 'uid-sec-funcionario';
const UID_SEM_PERFIL          = 'uid-sec-sem-perfil';
const UID_DISPLAY             = 'uid-sec-display';
const FUNC_ID                 = 'func-sec-001';

let testEnv;

const SEED = async (db) => {
  await db.collection('users').doc(UID_GESTOR_SEM_MODULOS).set({
    role: 'gestor', ativo: true, nome: 'Gestor Sem Modulos',
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_SEM_MODULOS).set({
    modulos: [], admin: false,
  });

  await db.collection('users').doc(UID_GESTOR_COM_CLIENTES).set({
    role: 'gestor', ativo: true, nome: 'Gestor Com Clientes',
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_COM_CLIENTES).set({
    modulos: ['clientes'], admin: false,
  });

  await db.collection('users').doc(UID_FUNC).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID, nome: 'Funcionario Teste',
  });
  await db.collection('funcionarios').doc(FUNC_ID).set({
    nome: 'Funcionario Teste', cargo: 'Vendedor', modalidade: 'PRESENCIAL',
  });

  await db.collection('users').doc(UID_GESTOR_FINANCEIRO).set({
    role: 'gestor', ativo: true, nome: 'Gestor Financeiro',
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_FINANCEIRO).set({
    modulos: ['financeiro'], admin: false,
  });

  await db.collection('users').doc(UID_GESTOR_EXPEDICAO).set({
    role: 'gestor', ativo: true, nome: 'Gestor Expedicao',
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_EXPEDICAO).set({
    modulos: ['expedicao'], admin: false,
  });

  // display — só tem users/{uid}, sem sistema_usuarios (não é gestor comercial)
  await db.collection('users').doc(UID_DISPLAY).set({
    role: 'display', ativo: true, nome: 'TV Painel',
  });

  // Dados de exemplo para os testes lerem
  await db.collection('clientes').doc('cliente-001').set({
    nome: 'Cliente Teste', telefone: '85900000000', pipeline: 'ativo',
  });
  await db.collection('garantias').doc('garantia-001').set({
    produto: 'Filtro X', status: 'aberto',
  });
  await db.collection('fornecedores_custo').doc('forn-001').set({
    nome: 'Fornecedor A', percentual: 12,
  });
  await db.collection('compras_config').doc('config-001').set({
    reserva_caixa: 5000,
  });
  await db.collection('display_metrics').doc('latest').set({
    meta_mes: 200000, faturamento_mes: 45169, pct_meta: 22.6,
  });

  // S1: dados de exemplo para financeiro_cache e pedidos_cache
  await db.collection('financeiro_cache').doc('latest').set({
    atualizado_em: '2026-09-09T11:00:00',
    total_vencido: 57741.02, total_a_pagar: 29385.95, total_a_receber: 0,
    inadimplencia_pct: 0, fluxo_caixa: [], contas_vencidas: [], contas_vencendo: [],
    _meta: { lancamentosTotal: 59, sincronizadoEm: '2026-09-09T11:00:00' },
  });
  await db.collection('pedidos_cache').doc('latest').set({
    atualizado_em: '2026-09-09T11:00:00',
    total: 3,
    pedidos: [
      { numero: '1', data: '2026-09-09', cliente: 'PEDRO ARAUJO', vendedor: 'ADEMIR', valor: 500, itens: 2 },
    ],
    _meta: { pedidosTotal: 3, sincronizadoEm: '2026-09-09T11:00:00' },
  });
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

const db = (uid) => uid
  ? testEnv.authenticatedContext(uid).firestore()
  : testEnv.unauthenticatedContext().firestore();

// ── SEÇÃO A — Estado correto (já funciona) ─────────────────────────────────────
describe('Seção A — Acesso negado (estado correto atual)', () => {

  describe('A1 — Sem autenticação', () => {
    const COLECOES = [
      'clientes', 'garantias', 'fornecedores_custo', 'compras_config',
      'expedicao_pedidos', 'marketing_conteudos', 'demandas',
    ];

    COLECOES.forEach(col => {
      test(`A1/${col} — não-autenticado NÃO lê`, async () => {
        await assertFails(db(null).collection(col).get());
      });
    });
  });

  describe('A2 — Funcionário ativo não acessa módulos comerciais', () => {
    test('A2/clientes — funcionário NÃO lê', async () => {
      await assertFails(db(UID_FUNC).collection('clientes').get());
    });
    test('A2/garantias — funcionário NÃO lê', async () => {
      await assertFails(db(UID_FUNC).collection('garantias').get());
    });
    test('A2/fornecedores_custo — funcionário NÃO lê', async () => {
      await assertFails(db(UID_FUNC).collection('fornecedores_custo').get());
    });
    test('A2/compras_config — funcionário NÃO lê', async () => {
      await assertFails(db(UID_FUNC).collection('compras_config').get());
    });
  });

  describe('A3 — Auth sem perfil em users/', () => {
    test('A3/clientes — sem perfil NÃO lê', async () => {
      await assertFails(db(UID_SEM_PERFIL).collection('clientes').get());
    });
    test('A3/garantias — sem perfil NÃO lê', async () => {
      await assertFails(db(UID_SEM_PERFIL).collection('garantias').get());
    });
  });

  describe('A4 — Catch-all: coleção não mapeada', () => {
    test('A4 — coleção arbitrária NÃO acessível', async () => {
      await assertFails(db(UID_GESTOR_SEM_MODULOS).collection('colecao_desconhecida').get());
    });
  });
});

// ── SEÇÃO B — GAPs documentados (vulnerabilidades atuais) ─────────────────────
//
// Estes testes PASSAM AGORA documentando os gaps.
// Em S5, quando temModulo() for aplicado, esses testes serão INVERTIDOS
// (assertSucceeds → assertFails).
// Marcação: GAP:S5 — será corrigido na fase S5.
//
describe('Seção B — GAPs de autorização (vulnerabilidades documentadas)', () => {

  // GAP:S5 — Gestor sem módulo algum consegue ler clientes
  test('GAP:S5 — gestor sem módulo CAN acessar clientes (gap atual)', async () => {
    // VULNERABILIDADE: a Rules só checa isGestor(), não verifica modulos[].
    // Este teste PASSA confirmando o gap. Deve ser INVERTIDO em S5.
    await assertSucceeds(
      db(UID_GESTOR_SEM_MODULOS).collection('clientes').doc('cliente-001').get()
    );
  });

  // GAP:S5
  test('GAP:S5 — gestor sem módulo CAN acessar garantias (gap atual)', async () => {
    await assertSucceeds(
      db(UID_GESTOR_SEM_MODULOS).collection('garantias').doc('garantia-001').get()
    );
  });

  // GAP:S5
  test('GAP:S5 — gestor sem módulo CAN acessar fornecedores_custo (gap atual)', async () => {
    await assertSucceeds(
      db(UID_GESTOR_SEM_MODULOS).collection('fornecedores_custo').doc('forn-001').get()
    );
  });

  // GAP:S5
  test('GAP:S5 — gestor sem módulo CAN acessar compras_config (gap atual)', async () => {
    await assertSucceeds(
      db(UID_GESTOR_SEM_MODULOS).collection('compras_config').doc('config-001').get()
    );
  });

  // GAP:S5 — Gestor com módulo 'clientes' consegue ler outras coleções que não autorizou
  test('GAP:S5 — gestor com módulo=clientes CAN acessar garantias (gap atual)', async () => {
    await assertSucceeds(
      db(UID_GESTOR_COM_CLIENTES).collection('garantias').doc('garantia-001').get()
    );
  });

  // NOTA S0: a regra display_metrics foi adicionada em S0 (antecipando S3).
  // role=display JÁ PODE ler display_metrics — não é um gap, é comportamento correto.
  // Veja Seção D para os testes completos de display_metrics.
  test('S0/display_metrics — role=display PODE ler display_metrics (regra adicionada em S0)', async () => {
    await assertSucceeds(
      db(UID_DISPLAY).collection('display_metrics').doc('latest').get()
    );
  });
});

// ── SEÇÃO C — Autorização futura por módulo (desativada — habilitar em S5) ────
describe.skip('Seção C — [S5] temModulo() enforcement (habilitado após deploy de S5)', () => {

  test('[S5] gestor sem módulo NÃO acessa clientes', async () => {
    await assertFails(
      db(UID_GESTOR_SEM_MODULOS).collection('clientes').doc('cliente-001').get()
    );
  });

  test('[S5] gestor sem módulo NÃO acessa garantias', async () => {
    await assertFails(
      db(UID_GESTOR_SEM_MODULOS).collection('garantias').doc('garantia-001').get()
    );
  });

  test('[S5] gestor COM módulo clientes PODE acessar clientes', async () => {
    await assertSucceeds(
      db(UID_GESTOR_COM_CLIENTES).collection('clientes').doc('cliente-001').get()
    );
  });

  test('[S5] gestor COM módulo clientes NÃO acessa garantias', async () => {
    await assertFails(
      db(UID_GESTOR_COM_CLIENTES).collection('garantias').doc('garantia-001').get()
    );
  });
});

// ── SEÇÃO D — display_metrics com role=display (habilitada em S0) ─────────────
// Regra adicionada em S0. Collection populada pelo sync em S3.
// Testes passam porque o SEED cria display_metrics/latest no emulador.
describe('Seção D — role=display + display_metrics (regra ativa desde S0)', () => {

  test('[S3] role=display PODE ler display_metrics/latest', async () => {
    await assertSucceeds(
      db(UID_DISPLAY).collection('display_metrics').doc('latest').get()
    );
  });

  test('[S3] role=display NÃO pode ler clientes', async () => {
    await assertFails(
      db(UID_DISPLAY).collection('clientes').get()
    );
  });

  test('[S3] role=display NÃO pode escrever em display_metrics', async () => {
    await assertFails(
      db(UID_DISPLAY).collection('display_metrics').doc('latest').set({ meta_mes: 0 })
    );
  });

  test('[S3] role=display NÃO pode ler garantias', async () => {
    await assertFails(
      db(UID_DISPLAY).collection('garantias').get()
    );
  });
});

// ── SEÇÃO E — financeiro_cache + pedidos_cache (S1) ──────────────────────────
// Verifica as regras adicionadas em S1:
//   financeiro_cache → temModulo('financeiro')
//   pedidos_cache    → temModulo('expedicao')
//
describe('Seção E — [S1] financeiro_cache + pedidos_cache protegidos', () => {

  // E1 — financeiro_cache: acesso correto
  test('[S1] E1a — gestor com módulo=financeiro PODE ler financeiro_cache', async () => {
    await assertSucceeds(
      db(UID_GESTOR_FINANCEIRO).collection('financeiro_cache').doc('latest').get()
    );
  });

  // E2 — financeiro_cache: negações
  test('[S1] E2a — gestor SEM módulo NÃO lê financeiro_cache', async () => {
    await assertFails(
      db(UID_GESTOR_SEM_MODULOS).collection('financeiro_cache').doc('latest').get()
    );
  });

  test('[S1] E2b — gestor com módulo=expedicao NÃO lê financeiro_cache', async () => {
    await assertFails(
      db(UID_GESTOR_EXPEDICAO).collection('financeiro_cache').doc('latest').get()
    );
  });

  test('[S1] E2c — funcionário NÃO lê financeiro_cache', async () => {
    await assertFails(
      db(UID_FUNC).collection('financeiro_cache').doc('latest').get()
    );
  });

  test('[S1] E2d — não-autenticado NÃO lê financeiro_cache', async () => {
    await assertFails(db(null).collection('financeiro_cache').doc('latest').get());
  });

  test('[S1] E2e — ninguém escreve em financeiro_cache (somente Admin SDK)', async () => {
    await assertFails(
      db(UID_GESTOR_FINANCEIRO).collection('financeiro_cache').doc('latest').set({ total_vencido: 0 })
    );
  });

  // E3 — pedidos_cache: acesso correto
  test('[S1] E3a — gestor com módulo=expedicao PODE ler pedidos_cache', async () => {
    await assertSucceeds(
      db(UID_GESTOR_EXPEDICAO).collection('pedidos_cache').doc('latest').get()
    );
  });

  // E4 — pedidos_cache: negações
  test('[S1] E4a — gestor SEM módulo NÃO lê pedidos_cache', async () => {
    await assertFails(
      db(UID_GESTOR_SEM_MODULOS).collection('pedidos_cache').doc('latest').get()
    );
  });

  test('[S1] E4b — gestor com módulo=financeiro NÃO lê pedidos_cache', async () => {
    await assertFails(
      db(UID_GESTOR_FINANCEIRO).collection('pedidos_cache').doc('latest').get()
    );
  });

  test('[S1] E4c — funcionário NÃO lê pedidos_cache', async () => {
    await assertFails(
      db(UID_FUNC).collection('pedidos_cache').doc('latest').get()
    );
  });

  test('[S1] E4d — não-autenticado NÃO lê pedidos_cache', async () => {
    await assertFails(db(null).collection('pedidos_cache').doc('latest').get());
  });

  test('[S1] E4e — ninguém escreve em pedidos_cache (somente Admin SDK)', async () => {
    await assertFails(
      db(UID_GESTOR_EXPEDICAO).collection('pedidos_cache').doc('latest').set({ total: 0 })
    );
  });
});
