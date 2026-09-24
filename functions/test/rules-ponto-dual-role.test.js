'use strict';

/**
 * Testes DR-1..DR-6: dual-role ponto nas Firestore Rules (P0 fix 2026-09-24)
 *
 * Prova que:
 *   - Funcionário comum (sem módulo ponto) → DENY admin, ALLOW próprios dados
 *   - Funcionário dual-role (módulo ponto) → ALLOW admin
 *   - Funcionário dual-role bloqueado → DENY admin
 *   - Gestor com ponto → ALLOW admin (comportamento inalterado)
 *   - Não autenticado → DENY
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore
 *   (porta padrão: 8080)
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=rules-ponto-dual-role
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

// ─── UIDs de teste ─────────────────────────────────────────────────────────────

const UID_DR_COMUM         = 'dr-func-comum';          // role=funcionario, sem sistema_usuarios
const UID_DR_DUAL          = 'dr-func-dual';            // role=funcionario + modulos=['ponto']
const UID_DR_BLOQUEADO     = 'dr-func-bloqueado';       // role=funcionario + ponto + bloqueado=true
const UID_DR_SEM_PONTO     = 'dr-func-sem-ponto';       // role=funcionario + modulos=['expedicao'] (sem ponto)
const UID_DR_GESTOR        = 'dr-gestor-ponto';         // role=gestor + modulos=['ponto']

const FUNC_ID_COMUM    = 'dr-func-001';
const FUNC_ID_DUAL     = 'dr-func-002';
const FUNC_ID_BLOQ     = 'dr-func-003';
const FUNC_ID_SEM      = 'dr-func-004';
const FUNC_ID_GESTOR   = 'dr-func-005';

// ─── Seed ──────────────────────────────────────────────────────────────────────

async function seedAll(db) {
  // users
  await db.collection('users').doc(UID_DR_COMUM).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_COMUM, nome: 'Func Comum DR',
  });
  await db.collection('users').doc(UID_DR_DUAL).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_DUAL, nome: 'Func Dual DR',
  });
  await db.collection('users').doc(UID_DR_BLOQUEADO).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_BLOQ, nome: 'Func Bloqueado DR',
  });
  await db.collection('users').doc(UID_DR_SEM_PONTO).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_SEM, nome: 'Func Sem Ponto DR',
  });
  await db.collection('users').doc(UID_DR_GESTOR).set({
    role: 'gestor', ativo: true, nome: 'Gestor DR',
  });

  // sistema_usuarios
  // UID_DR_COMUM: sem doc sistema_usuarios (funcionário comum puro)
  await db.collection('sistema_usuarios').doc(UID_DR_DUAL).set({
    admin: false, modulos: ['catalogo', 'expedicao', 'ponto', 'garantia'],
    // bloqueado ausente = false por padrão
  });
  await db.collection('sistema_usuarios').doc(UID_DR_BLOQUEADO).set({
    admin: false, modulos: ['ponto'], bloqueado: true,  // bloqueado explícito
  });
  await db.collection('sistema_usuarios').doc(UID_DR_SEM_PONTO).set({
    admin: false, modulos: ['expedicao', 'garantia'],   // ponto ausente
  });
  await db.collection('sistema_usuarios').doc(UID_DR_GESTOR).set({
    admin: false, modulos: ['ponto'],
  });

  // funcionarios
  await db.collection('funcionarios').doc(FUNC_ID_COMUM).set({ nome: 'Func Comum DR', cargo: 'Vendedor' });
  await db.collection('funcionarios').doc(FUNC_ID_DUAL).set({ nome: 'Func Dual DR', cargo: 'Aux Adm' });
  await db.collection('funcionarios').doc(FUNC_ID_BLOQ).set({ nome: 'Func Bloqueado DR', cargo: 'Caixa' });
  await db.collection('funcionarios').doc(FUNC_ID_SEM).set({ nome: 'Func Sem Ponto DR', cargo: 'Estoque' });
  await db.collection('funcionarios').doc(FUNC_ID_GESTOR).set({ nome: 'Gestor DR', cargo: 'Gestão' });

  // registros
  await db.collection('registros').doc('dr-reg-dual').set({
    funcId: FUNC_ID_DUAL, data: '2026-09-01', tipo: 'entrada', hora: '08:00:00',
  });
  await db.collection('registros').doc('dr-reg-comum').set({
    funcId: FUNC_ID_COMUM, data: '2026-09-01', tipo: 'entrada', hora: '08:00:00',
  });
  await db.collection('registros').doc('dr-reg-bloq').set({
    funcId: FUNC_ID_BLOQ, data: '2026-09-01', tipo: 'entrada', hora: '08:00:00',
  });

  // espelhos (para testes de create/update/delete)
  await db.collection('espelhos').doc('dr-esp-dual-unsigned').set({
    funcId: FUNC_ID_DUAL, mes: '2026-09', assinado: false,
    snapshot: { engineVersao: '3.0.0', dias: [], totais: {} },
    hashSnapshot: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
  });

  // justificativas
  await db.collection('justificativas').doc('dr-justif-dual').set({
    funcId: FUNC_ID_DUAL, data: '2026-09-02', motivo: 'Atestado',
    status: 'pendente', lancadoPorGestor: false,
  });
  await db.collection('justificativas').doc('dr-justif-comum').set({
    funcId: FUNC_ID_COMUM, data: '2026-09-02', motivo: 'Consulta',
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

// ─── DR-1: Funcionário comum (sem sistema_usuarios) → DENY admin, ALLOW próprios ──
describe('DR-1: funcionário comum (sem ponto) → DENY admin, ALLOW próprios dados', () => {
  test('lê funcionarios/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_DUAL).get());
  });
  test('lê funcionarios/{próprio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_COMUM).get());
  });
  test('escreve em funcionarios → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertFails(
      db.collection('funcionarios').doc(FUNC_ID_COMUM).update({ cargo: 'Hack' })
    );
  });
  test('lê registros/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertFails(db.collection('registros').doc('dr-reg-dual').get());
  });
  test('lê registros/{próprio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertSucceeds(db.collection('registros').doc('dr-reg-comum').get());
  });
  test('lê justificativas/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertFails(db.collection('justificativas').doc('dr-justif-dual').get());
  });
  test('lê justificativas/{própria} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertSucceeds(db.collection('justificativas').doc('dr-justif-comum').get());
  });
  test('lê avaliacoes → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
  test('lê creditos_jornada/{próprio} → ALLOW', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('creditos_jornada').doc('dr-cred-comum').set({
        funcId: FUNC_ID_COMUM, minutos: 480, motivo: 'Feriado',
      });
    });
    const db = testEnv.authenticatedContext(UID_DR_COMUM).firestore();
    await assertSucceeds(db.collection('creditos_jornada').doc('dr-cred-comum').get());
  });
});

// ─── DR-2: Funcionário dual-role (módulo ponto) → ALLOW admin ──────────────────
describe('DR-2: funcionário dual-role (ponto em modulos) → ALLOW admin', () => {
  test('lê funcionarios/{alheio} → ALLOW (temAcessoModulo)', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_COMUM).get());
  });
  test('escreve em funcionarios → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(
      db.collection('funcionarios').doc('dr-func-novo').set({ nome: 'Novo DR', cargo: 'Teste' })
    );
  });
  test('lê registros/{alheio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(db.collection('registros').doc('dr-reg-comum').get());
  });
  test('cria registro → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(
      db.collection('registros').doc('dr-reg-new').set({
        funcId: FUNC_ID_DUAL, data: '2026-09-03', tipo: 'entrada', hora: '08:00:00',
      })
    );
  });
  test('lê justificativas/{alheio} → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(db.collection('justificativas').doc('dr-justif-comum').get());
  });
  test('cria justificativa pelo gestor (lancadoPorGestor=true) → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    // Usa .add() (auto-ID) para evitar bug do emulador v1.19.8 que avalia update rule em set() de doc novo.
    await assertSucceeds(
      db.collection('justificativas').add({
        funcId: FUNC_ID_COMUM, data: '2026-09-03', motivo: 'Feriado nacional',
        status: 'aprovado', lancadoPorGestor: true,
      })
    );
  });
  test('escreve creditos_jornada → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(
      db.collection('creditos_jornada').doc('dr-cred-dual-adm').set({
        funcId: FUNC_ID_COMUM, minutos: 480, motivo: 'Feriado nacional',
      })
    );
  });
  test('cria espelho não-assinado → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(
      db.collection('espelhos').doc('dr-esp-dual-new').set({
        funcId: FUNC_ID_COMUM, mes: '2026-08', assinado: false,
      })
    );
  });
  test('lê avaliacoes → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
  test('escreve avaliacoes → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(
      db.collection('avaliacoes').doc(FUNC_ID_DUAL).set({
        nota: 4, metas: 'Cumprir escala', obs: '', advertencias: '',
      })
    );
  });
});

// ─── DR-3: Funcionário dual-role bloqueado → DENY admin ────────────────────────
describe('DR-3: funcionário dual-role bloqueado → DENY admin', () => {
  test('lê funcionarios/{alheio} → DENY (bloqueado=true)', async () => {
    const db = testEnv.authenticatedContext(UID_DR_BLOQUEADO).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_DUAL).get());
  });
  test('lê registros/{alheio} → DENY (bloqueado=true)', async () => {
    const db = testEnv.authenticatedContext(UID_DR_BLOQUEADO).firestore();
    await assertFails(db.collection('registros').doc('dr-reg-dual').get());
  });
  test('lê registros/{próprio} → ALLOW (isFuncionario path preservado)', async () => {
    const db = testEnv.authenticatedContext(UID_DR_BLOQUEADO).firestore();
    await assertSucceeds(db.collection('registros').doc('dr-reg-bloq').get());
  });
  test('lê avaliacoes → DENY (bloqueado=true)', async () => {
    const db = testEnv.authenticatedContext(UID_DR_BLOQUEADO).firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
});

// ─── DR-4: Funcionário sem módulo ponto (outro módulo) → DENY admin ────────────
describe('DR-4: funcionário com outro módulo (sem ponto) → DENY admin, ALLOW próprios', () => {
  test('lê funcionarios/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_SEM_PONTO).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_DUAL).get());
  });
  test('lê funcionarios/{próprio} → ALLOW (isFuncionario path)', async () => {
    const db = testEnv.authenticatedContext(UID_DR_SEM_PONTO).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_SEM).get());
  });
  test('lê registros/{alheio} → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_SEM_PONTO).firestore();
    await assertFails(db.collection('registros').doc('dr-reg-dual').get());
  });
  test('lê avaliacoes → DENY', async () => {
    const db = testEnv.authenticatedContext(UID_DR_SEM_PONTO).firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
});

// ─── DR-5: Gestor com ponto → ALLOW (comportamento inalterado) ─────────────────
describe('DR-5: gestor com módulo ponto → ALLOW admin (comportamento inalterado)', () => {
  test('lê funcionarios → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_GESTOR).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID_DUAL).get());
  });
  test('escreve em funcionarios → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_GESTOR).firestore();
    await assertSucceeds(
      db.collection('funcionarios').doc('dr-func-gestor-new').set({ nome: 'Novo Gestor', cargo: 'Teste' })
    );
  });
  test('lê registros → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_GESTOR).firestore();
    await assertSucceeds(db.collection('registros').doc('dr-reg-dual').get());
  });
  test('lê avaliacoes → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_GESTOR).firestore();
    await assertSucceeds(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
  test('cria espelho não-assinado → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_GESTOR).firestore();
    await assertSucceeds(
      db.collection('espelhos').doc('dr-esp-gestor-new').set({
        funcId: FUNC_ID_GESTOR, mes: '2026-08', assinado: false,
      })
    );
  });
});

// ─── DR-6: Não autenticado → DENY ──────────────────────────────────────────────
describe('DR-6: não autenticado → DENY em todas as collections ponto', () => {
  test('lê funcionarios → DENY', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID_DUAL).get());
  });
  test('lê registros → DENY', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('registros').doc('dr-reg-dual').get());
  });
  test('lê justificativas → DENY', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('justificativas').doc('dr-justif-dual').get());
  });
  test('lê avaliacoes → DENY', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('avaliacoes').doc('aval-qualquer').get());
  });
  test('lê espelhos → DENY', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('espelhos').doc('dr-esp-dual-unsigned').get());
  });
});

// ─── DR-7: Funcionário dual-role assina espelho próprio (path isFuncionario preservado)
describe('DR-7: funcionário dual-role assina espelho próprio → ALLOW (isFuncionario path inalterado)', () => {
  test('dual-role assina espelho próprio → ALLOW', async () => {
    const db = testEnv.authenticatedContext(UID_DR_DUAL).firestore();
    await assertSucceeds(
      db.collection('espelhos').doc('dr-esp-dual-unsigned').update({
        assinado:     true,
        assinaturaImg:'data:image/png;base64,drtest',
        assinadoEm:   serverTimestamp(),
        assinadoPor:  'Func Dual DR',
        status:       'assinado',
      })
    );
  });
});
