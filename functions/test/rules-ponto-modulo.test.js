'use strict';

/**
 * Testes PM-1..PM-11: módulo 'ponto' nas Firestore Rules (S2)
 *
 * Prova os 11 cenários de autorização após a substituição de isGestor()
 * por temModulo('ponto') nas coleções administrativas de ponto.
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore
 *   (porta padrão: 8080)
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=rules-ponto-modulo
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('@firebase/firestore');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

let testEnv;

// ─── UIDs de teste ────────────────────────────────────────────────────────────

const UID_GESTOR_PONTO    = 'pm-gestor-ponto';       // role=gestor + modulos=['ponto']
const UID_GESTOR_ADMIN    = 'pm-gestor-admin';        // role=gestor + admin=true + modulos=[]
const UID_GESTOR_SEM      = 'pm-gestor-sem-ponto';    // role=gestor + sem ponto em modulos
const UID_FUNC_PONTO      = 'pm-func-ponto';          // role=funcionario + modulos=['ponto'] (não deve acessar admin)
const UID_FUNC_SEM        = 'pm-func-sem-ponto';      // role=funcionario + sem ponto
const UID_FUNC_ADMIN_TRUE = 'pm-func-admin-true';     // role=funcionario + admin=true (NÃO deve ganhar acesso admin)

const FUNC_ID_PONTO = 'pm-func-001';
const FUNC_ID_SEM   = 'pm-func-002';
const FUNC_ID_ADMIN = 'pm-func-003';

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function seedAll(db) {
  // users
  await db.collection('users').doc(UID_GESTOR_PONTO).set({
    role: 'gestor', ativo: true, nome: 'Gestor Com Ponto',
  });
  await db.collection('users').doc(UID_GESTOR_ADMIN).set({
    role: 'gestor', ativo: true, nome: 'Gestor Admin',
  });
  await db.collection('users').doc(UID_GESTOR_SEM).set({
    role: 'gestor', ativo: true, nome: 'Gestor Sem Ponto',
  });
  await db.collection('users').doc(UID_FUNC_PONTO).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_PONTO, nome: 'Func Com Ponto',
  });
  await db.collection('users').doc(UID_FUNC_SEM).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_SEM, nome: 'Func Sem Ponto',
  });
  await db.collection('users').doc(UID_FUNC_ADMIN_TRUE).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_ADMIN, nome: 'Func Admin True',
  });

  // sistema_usuarios
  await db.collection('sistema_usuarios').doc(UID_GESTOR_PONTO).set({
    admin: false, modulos: ['ponto', 'expedicao'],
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_ADMIN).set({
    admin: true, modulos: [],   // admin=true sem módulo ponto explícito
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_SEM).set({
    admin: false, modulos: ['expedicao', 'garantia'],  // sem 'ponto'
  });
  await db.collection('sistema_usuarios').doc(UID_FUNC_PONTO).set({
    admin: false, modulos: ['ponto'],
  });
  // UID_FUNC_SEM: sem doc sistema_usuarios (não tem módulo algum)
  await db.collection('sistema_usuarios').doc(UID_FUNC_ADMIN_TRUE).set({
    admin: true, modulos: [],   // role=funcionario mas admin=true em sistema_usuarios
  });

  // funcionarios
  await db.collection('funcionarios').doc(FUNC_ID_PONTO).set({
    nome: 'Func Com Ponto', cargo: 'Vendedor',
  });
  await db.collection('funcionarios').doc(FUNC_ID_SEM).set({
    nome: 'Func Sem Ponto', cargo: 'Vendedor',
  });
  await db.collection('funcionarios').doc(FUNC_ID_ADMIN).set({
    nome: 'Func Admin True', cargo: 'Vendedor',
  });

  // registros para leitura
  await db.collection('registros').doc('reg-ponto').set({
    funcId: FUNC_ID_PONTO, data: '2026-09-01', tipo: 'entrada', hora: '08:00:00',
  });
  await db.collection('registros').doc('reg-sem').set({
    funcId: FUNC_ID_SEM, data: '2026-09-01', tipo: 'entrada', hora: '08:00:00',
  });
  await db.collection('registros').doc('reg-admin').set({
    funcId: FUNC_ID_ADMIN, data: '2026-09-01', tipo: 'entrada', hora: '08:00:00',
  });

  // espelhos para assinatura (S2b: snapshot+hash obrigatórios antes de assinar)
  await db.collection('espelhos').doc('esp-ponto').set({
    funcId: FUNC_ID_PONTO, mes: '2026-09', assinado: false,
    snapshot: { engineVersao: '3.0.0', dias: [], totais: {} },
    hashSnapshot: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  });

  // justificativas para leitura do próprio funcionário
  await db.collection('justificativas').doc('justif-ponto').set({
    funcId: FUNC_ID_PONTO, data: '2026-09-01', motivo: 'Atestado',
    status: 'pendente', lancadoPorGestor: false,
  });
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host: 'localhost',
      port: 8080,
    },
  });
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedAll(ctx.firestore());
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

// ─── PM-1: gestor ativo + modulos=['ponto'] → ALLOW administrativo ────────────
describe('PM-1: gestor ativo + módulo ponto → ALLOW', () => {
  test('lê funcionarios (admin read)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_PONTO).get());
  });
  test('escreve em funcionarios (admin write)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(
      db.collection('funcionarios').doc('func-novo').set({ nome: 'Novo', cargo: 'Teste' })
    );
  });
  test('lê registros (admin read)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-ponto').get());
  });
  test('escreve em registros (admin write)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(
      db.collection('registros').doc('reg-novo').set({
        funcId: FUNC_ID_PONTO, data: '2026-09-02', tipo: 'entrada', hora: '08:00:00',
      })
    );
  });
  test('lê justificativas (admin read)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(db.collection('justificativas').doc('justif-ponto').get());
  });
  test('lê creditos_jornada (admin read)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(db.collection('creditos_jornada').doc('cred-qualquer').get());
  });
  test('lê espelhos (admin read)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(db.collection('espelhos').doc('esp-ponto').get());
  });
  test('cria espelho (admin create)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(
      db.collection('espelhos').doc('esp-gestor-cria').set({
        funcId: FUNC_ID_PONTO, mes: '2026-08', assinado: false,
      })
    );
  });
  test('lê avaliacoes (admin read)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_PONTO).firestore();
    await assertSucceeds(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
});

// ─── PM-2: gestor ativo + admin=true + modulos=[] → ALLOW (admin bypass) ──────
describe('PM-2: gestor ativo + admin=true + modulos=[] → ALLOW', () => {
  test('lê funcionarios', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_ADMIN).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_PONTO).get());
  });
  test('lê registros', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_ADMIN).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-ponto').get());
  });
  test('lê espelhos', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_ADMIN).firestore();
    await assertSucceeds(db.collection('espelhos').doc('esp-ponto').get());
  });
  test('lê justificativas', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_ADMIN).firestore();
    await assertSucceeds(db.collection('justificativas').doc('justif-ponto').get());
  });
  test('escreve creditos_jornada', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_ADMIN).firestore();
    await assertSucceeds(
      db.collection('creditos_jornada').doc('cred-admin').set({
        funcId: FUNC_ID_PONTO, minutos: 480, motivo: 'Feriado',
      })
    );
  });
});

// ─── PM-3: gestor ativo + admin=false + sem módulo ponto → DENY administrativo
describe('PM-3: gestor ativo + sem módulo ponto → DENY', () => {
  test('lê funcionarios → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_PONTO).get());
  });
  test('escreve em funcionarios → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(
      db.collection('funcionarios').doc('func-bloqueado').set({ nome: 'Bloqueado' })
    );
  });
  test('lê registros → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(db.collection('registros').doc('reg-ponto').get());
  });
  test('lê espelhos → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(db.collection('espelhos').doc('esp-ponto').get());
  });
  test('lê justificativas → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(db.collection('justificativas').doc('justif-ponto').get());
  });
  test('lê creditos_jornada → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(db.collection('creditos_jornada').doc('cred-qualquer').get());
  });
  test('lê avaliacoes → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR_SEM).firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
});

// ─── PM-4: funcionário ativo + módulo ponto → DENY administrativo, ALLOW próprios
describe('PM-4: funcionário + módulo ponto → DENY admin, ALLOW próprios dados', () => {
  test('lê funcionarios/{alheio} → DENY (sem isGestor)', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_SEM).get());
  });
  test('lê funcionarios/{próprio} → ALLOW (isFuncionario path)', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_PONTO).get());
  });
  test('escreve em funcionarios → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertFails(
      db.collection('funcionarios').doc(FUNC_ID_PONTO).update({ cargo: 'Modificado' })
    );
  });
  test('lê registros/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertFails(db.collection('registros').doc('reg-sem').get());
  });
  test('lê registros/{próprio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-ponto').get());
  });
  test('lê avaliacoes → DENY (sem path de funcionário)', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
});

// ─── PM-5: funcionário ativo sem módulo ponto → acesso aos próprios dados OK ──
describe('PM-5: funcionário sem módulo ponto → próprios dados preservados', () => {
  test('lê funcionarios/{próprio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_SEM).get());
  });
  test('lê registros/{próprio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-sem').get());
  });
  test('lê registros/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertFails(db.collection('registros').doc('reg-ponto').get());
  });
});

// ─── PM-6: funcionário + admin=true → NÃO ganha acesso administrativo ─────────
describe('PM-6: funcionário + admin=true → DENY administrativo (isGestor=false)', () => {
  test('lê funcionarios/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_ADMIN_TRUE).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_PONTO).get());
  });
  test('lê registros → DENY (admin path bloqueado, isFuncionario path OK só para o próprio)', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_ADMIN_TRUE).firestore();
    // Consegue ler o próprio
    await assertSucceeds(db.collection('registros').doc('reg-admin').get());
    // Não consegue ler o alheio
    await assertFails(db.collection('registros').doc('reg-ponto').get());
  });
  test('escreve em funcionarios → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_ADMIN_TRUE).firestore();
    await assertFails(
      db.collection('funcionarios').doc('func-admin-hack').set({ nome: 'Hack' })
    );
  });
  test('lê avaliacoes → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_ADMIN_TRUE).firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
});

// ─── PM-7: assinatura de espelho pelo próprio funcionário continua ALLOW ───────
describe('PM-7: assinatura de espelho pelo funcionário → ALLOW (regra isFuncionario preservada)', () => {
  test('funcionário assina espelho próprio → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertSucceeds(
      db.collection('espelhos').doc('esp-ponto').update({
        assinado:     true,
        assinaturaImg:'data:image/png;base64,abc',
        assinadoEm:   serverTimestamp(),
        assinadoPor:  'Func Com Ponto',
        status:       'assinado',
      })
    );
  });
  test('funcionário sem módulo ponto assina espelho próprio → ALLOW (isFuncionario path)', async () => {
    // Cria espelho para FUNC_ID_SEM
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-sem').set({
        funcId: FUNC_ID_SEM, mes: '2026-09', assinado: false,
        snapshot: { engineVersao: '3.0.0', dias: [], totais: {} },
        hashSnapshot: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      });
    });
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertSucceeds(
      db.collection('espelhos').doc('esp-sem').update({
        assinado:     true,
        assinaturaImg:'data:image/png;base64,xyz',
        assinadoEm:   serverTimestamp(),
        assinadoPor:  'Func Sem Ponto',
        status:       'assinado',
      })
    );
  });
  test('funcionário NÃO assina espelho alheio → DENY', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-alheio').set({
        funcId: FUNC_ID_PONTO, mes: '2026-08', assinado: false,
      });
    });
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertFails(
      db.collection('espelhos').doc('esp-alheio').update({
        assinado: true,
        assinadoEm: serverTimestamp(),
        assinadoPor: 'Tentativa',
        status: 'assinado',
      })
    );
  });
});

// ─── PM-8: justificativa do próprio funcionário → ALLOW (create + read) ────────
describe('PM-8: justificativa do próprio funcionário → ALLOW', () => {
  test('funcionário cria justificativa pendente → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertSucceeds(
      db.collection('justificativas').doc('justif-func-sem').set({
        funcId:           FUNC_ID_SEM,
        data:             '2026-09-02',
        motivo:           'Consulta médica',
        status:           'pendente',
        lancadoPorGestor: false,
      })
    );
  });
  test('funcionário lê justificativa própria → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertSucceeds(db.collection('justificativas').doc('justif-ponto').get());
  });
  test('funcionário NÃO lê justificativa alheia → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertFails(db.collection('justificativas').doc('justif-ponto').get());
  });
});

// ─── PM-9: leitura de registros próprios → ALLOW ─────────────────────────────
describe('PM-9: leitura dos próprios registros → ALLOW (qualquer funcionário)', () => {
  test('FUNC_PONTO lê reg-ponto → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-ponto').get());
  });
  test('FUNC_SEM lê reg-sem → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-sem').get());
  });
});

// ─── PM-10: leitura de registros de OUTRO funcionário → DENY ──────────────────
describe('PM-10: leitura de registros de outro funcionário → DENY', () => {
  test('FUNC_SEM tenta ler reg-ponto → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_SEM).firestore();
    await assertFails(db.collection('registros').doc('reg-ponto').get());
  });
  test('FUNC_PONTO tenta ler reg-sem → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertFails(db.collection('registros').doc('reg-sem').get());
  });
  test('FUNC_PONTO tenta ler todos registros (getDocs) → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC_PONTO).firestore();
    await assertFails(db.collection('registros').get());
  });
});

// ─── PM-11: Cloud Functions (Admin SDK) não dependem das Rules ────────────────
// Admin SDK bypassa Rules completamente. Este teste documenta isso via comentário
// e verifica que as Rules não interferem com operações via withSecurityRulesDisabled.
describe('PM-11: Admin SDK bypassa Rules (documentado)', () => {
  test('withSecurityRulesDisabled escreve em registros sem verificar módulo ponto', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await assertSucceeds(
        ctx.firestore().collection('registros').doc('reg-admin-sdk').set({
          funcId: FUNC_ID_PONTO,
          data: '2026-09-03',
          tipo: 'entrada',
          hora: '08:00:00',
          fonte: 'admin-sdk',
        })
      );
    });
  });
  test('withSecurityRulesDisabled lê de qualquer coleção', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await assertSucceeds(db.collection('funcionarios').get());
      await assertSucceeds(db.collection('espelhos').get());
    });
  });
});
