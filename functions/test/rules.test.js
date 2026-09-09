'use strict';

/**
 * Testes A–I: Firestore Rules no emulador
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore,auth
 *   (porta padrão: firestore=8080, auth=9099)
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=rules.test
 *
 * IMPORTANTE: Não altera dados históricos nem produção.
 *             Todos os dados são criados e limpos no emulador.
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

let testEnv;

// UIDs e dados de teste
const UID_GESTOR    = 'uid-gestor-test';
const UID_FUNC      = 'uid-func-test';
const UID_ANONIMO   = 'uid-anonimo-test';
const FUNC_ID       = 'func-test-001';

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host: 'localhost',
      port: 8080,
    },
  });

  // Seed: criar documentos base sem passar pelas Rules (Admin SDK do emulador)
  await testEnv.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.collection('users').doc(UID_GESTOR).set({
      role: 'gestor', ativo: true, nome: 'Gestor Teste',
    });
    await db.collection('users').doc(UID_FUNC).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_ID, nome: 'Func Teste',
    });
    await db.collection('funcionarios').doc(FUNC_ID).set({
      nome: 'Func Teste', cargo: 'Vendedor', modalidade: 'PRESENCIAL',
    });
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
  // Re-seed após cada limpeza
  await testEnv.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.collection('users').doc(UID_GESTOR).set({
      role: 'gestor', ativo: true, nome: 'Gestor Teste',
    });
    await db.collection('users').doc(UID_FUNC).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_ID, nome: 'Func Teste',
    });
    await db.collection('funcionarios').doc(FUNC_ID).set({
      nome: 'Func Teste', cargo: 'Vendedor', modalidade: 'PRESENCIAL',
    });
  });
});

// ─── Teste A: isGestor() FAIL CLOSED ──────────────────────────────────────────
test('A — usuário sem doc users/ não acessa funcionarios (isGestor FAIL CLOSED)', async () => {
  const db = testEnv.authenticatedContext(UID_ANONIMO).firestore();
  await assertFails(
    db.collection('funcionarios').doc(FUNC_ID).get()
  );
});

// ─── Teste B: gestor com role='gestor' e ativo=true acessa funcionarios ───────
test('B — gestor com role=gestor e ativo=true lê funcionarios', async () => {
  const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
  await assertSucceeds(
    db.collection('funcionarios').doc(FUNC_ID).get()
  );
});

// ─── Teste C: funcionario lê apenas o próprio funcionario/{id} ───────────────
test('C — funcionario lê apenas o próprio documento em funcionarios', async () => {
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID).get());
  await assertFails(db.collection('funcionarios').doc('outro-func').get());
});

// ─── Teste D: funcionario NÃO pode criar registro diretamente em registros ────
test('D — funcionario não pode criar registro diretamente (bypass bloqueado)', async () => {
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertFails(
    db.collection('registros').doc('reg-direto').set({
      funcId:    FUNC_ID,
      authUid:   UID_FUNC,
      data:      '2026-09-01',
      hora:      '08:00:00',
      tipo:      'entrada',
      tipoLabel: 'Entrada',
    })
  );
});

// ─── Teste E: gestor pode criar registro (lançamento manual) ──────────────────
test('E — gestor pode criar registro manual em registros', async () => {
  const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
  await assertSucceeds(
    db.collection('registros').doc('reg-gestor').set({
      funcId:    FUNC_ID,
      authUid:   UID_GESTOR,
      data:      '2026-09-01',
      hora:      '08:00:00',
      tipo:      'entrada',
      tipoLabel: 'Entrada',
      lancadoPorGestor: true,
    })
  );
});

// ─── Teste F: funcionario lê apenas seus próprios registros ──────────────────
test('F — funcionario lê apenas registros com seu funcId', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.collection('registros').doc('reg-proprio').set({ funcId: FUNC_ID });
    await db.collection('registros').doc('reg-alheio').set({ funcId: 'outro-func' });
  });

  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertSucceeds(db.collection('registros').doc('reg-proprio').get());
  await assertFails(db.collection('registros').doc('reg-alheio').get());
});

// ─── Teste G: funcionario NÃO pode deletar nem atualizar registro ─────────────
test('G — funcionario não pode deletar nem atualizar registros', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('registros').doc('reg-del').set({ funcId: FUNC_ID });
  });
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertFails(db.collection('registros').doc('reg-del').delete());
  await assertFails(db.collection('registros').doc('reg-del').update({ hora: '09:00:00' }));
});

// ─── Teste H: usuário não autenticado não acessa nada ────────────────────────
test('H — usuário não autenticado é barrado em todas as coleções', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(db.collection('funcionarios').get());
  await assertFails(db.collection('registros').get());
  await assertFails(db.collection('users').get());
});

// ─── Teste I: funcionario pode criar justificativa com status=pendente ────────
test('I — funcionario cria justificativa com status=pendente (aprovada pelo gestor depois)', async () => {
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertSucceeds(
    db.collection('justificativas').doc('justif-test').set({
      funcId:             FUNC_ID,
      data:               '2026-09-01',
      motivo:             'Atestado médico',
      status:             'pendente',
      lancadoPorGestor:   false,
    })
  );
  // Mas não pode criar com status=aprovado
  await assertFails(
    db.collection('justificativas').doc('justif-bad').set({
      funcId:           FUNC_ID,
      data:             '2026-09-01',
      motivo:           'Tentativa',
      status:           'aprovado',
      lancadoPorGestor: false,
    })
  );
});
