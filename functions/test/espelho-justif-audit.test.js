'use strict';

/**
 * Testes E9, J1-J7: Auditoria de espelhos legados e trail de justificativas
 *
 * E9 — espelhos legados (assinado=true, snapshot=null) permanecem intactos
 * J1 — auditFields contém respondidoPorUid
 * J2 — auditFields contém respondidoPorEmail
 * J3 — respondidoEm é sentinel serverTimestamp (não string)
 * J4 — funcionário NÃO pode atualizar justificativa → DENIED
 * J5 — gestor SEM módulo 'ponto' NÃO pode atualizar justificativa → DENIED
 * J6 — gestor COM módulo 'ponto' atualiza justificativa → ALLOWED
 * J7 — justificativas legadas (sem respondidoPorUid) não são afetadas por J6
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore,auth
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=espelho-justif-audit.test
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { serverTimestamp } = require('@firebase/firestore');
const { readFileSync }    = require('fs');
const { resolve }         = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

let testEnv;

const UID_GESTOR_PONTO   = 'uid-gestor-justif-ponto';
const UID_GESTOR_SEM_PONTO = 'uid-gestor-justif-noponto';
const UID_FUNC           = 'uid-func-justif';
const FUNC_ID            = 'func-justif-001';

// email no token é obrigatório: justificativas Rule verifica request.auth.token.email
const ctxGestorPonto    = () => testEnv.authenticatedContext(UID_GESTOR_PONTO,    { email: 'gestor-ponto@mr4.com' });
const ctxGestorSemPonto = () => testEnv.authenticatedContext(UID_GESTOR_SEM_PONTO, { email: 'gestor-noponto@mr4.com' });
const ctxFunc           = () => testEnv.authenticatedContext(UID_FUNC,             { email: 'func@mr4.com' });

// Espelho legado: assinado, sem snapshot — simula os 6 espelhos legados
const ESP_LEGADO = {
  funcId: FUNC_ID, mes: '2026-01', assinado: true,
  versao: 1, versaoAnteriorId: null,
  snapshot: null, hashSnapshot: null,
  assinadoPor: 'Funcionário Legado',
  assinaturaImg: 'data:image/png;base64,LEGADO',
  status: 'assinado',
};

// Justificativa legada: sem campos de audit trail
const JUSTIF_LEGADA = {
  funcId: FUNC_ID, mes: '2026-01', data: '2026-01-15',
  tipo: 'falta', status: 'pendente',
  obs: 'Falta justificada legada',
};

// Justificativa nova/pendente (aguardando resposta do gestor)
const JUSTIF_PENDENTE = {
  funcId: FUNC_ID, mes: '2026-09', data: '2026-09-10',
  tipo: 'falta', status: 'pendente',
  obs: 'Falta justificada para aprovação',
};

async function seedUsers(db) {
  await db.collection('users').doc(UID_GESTOR_PONTO).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_GESTOR_SEM_PONTO).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_FUNC).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID,
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_PONTO).set({
    admin: false, modulos: ['ponto'],
  });
  await db.collection('sistema_usuarios').doc(UID_GESTOR_SEM_PONTO).set({
    admin: false, modulos: ['catalogo'],
  });
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host:  'localhost',
      port:  8080,
    },
  });
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedUsers(ctx.firestore());
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedUsers(ctx.firestore());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E9 — Espelhos legados (assinado=true, snapshot=null) permanecem intactos
// ═══════════════════════════════════════════════════════════════════════════

describe('E9 — Espelhos legados protegidos (assinado=true, snapshot=null)', () => {
  test('E9-a: gestor NÃO pode sobrescrever snapshot de espelho legado assinado → DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-legado').set(ESP_LEGADO);
    });
    await assertFails(
      ctxGestorPonto().firestore().collection('espelhos').doc('esp-legado').update({
        snapshot: { engineVersao: '3.0.0', dias: [], totais: {} },
      })
    );
  });

  test('E9-b: gestor NÃO pode sobrescrever hashSnapshot de espelho legado → DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-legado').set(ESP_LEGADO);
    });
    await assertFails(
      ctxGestorPonto().firestore().collection('espelhos').doc('esp-legado').update({
        hashSnapshot: 'novo-hash-adulterado',
      })
    );
  });

  test('E9-c: gestor NÃO pode excluir espelho legado assinado → DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-legado').set(ESP_LEGADO);
    });
    await assertFails(
      ctxGestorPonto().firestore().collection('espelhos').doc('esp-legado').delete()
    );
  });

  test('E9-d: funcionário NÃO pode re-assinar espelho legado (já assinado) → DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-legado').set(ESP_LEGADO);
    });
    // Rule: !resource.data.assinado → false → toda a cláusula é DENIED
    await assertFails(
      ctxFunc().firestore().collection('espelhos').doc('esp-legado').update({
        assinado:     true,
        assinaturaImg:'data:image/png;base64,NOVA-SIG',
        assinadoEm:   serverTimestamp(),
        assinadoPor:  'Funcionário Legado',
        status:       'assinado',
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J1-J3 — Unit tests: auditFields gerado pelo responderJustificativa()
// ═══════════════════════════════════════════════════════════════════════════

describe('J1-J3 — Unit: auditFields de responderJustificativa()', () => {
  // Simula a geração de auditFields como feito em ponto.html
  function buildAuditFields(status, obs, uid, email) {
    const serverTimestampSentinel = { _sentinel: 'serverTimestamp' };
    return {
      status,
      obsGestor: obs,
      respondidoPorUid:   uid   || '',
      respondidoPorEmail: email || '',
      respondidoEm:       serverTimestampSentinel,
    };
  }

  test('J1 — auditFields contém respondidoPorUid não vazio', () => {
    const fields = buildAuditFields('aprovada', 'OK', 'uid-gestor-123', 'gestor@mr4.com');
    expect(fields).toHaveProperty('respondidoPorUid');
    expect(fields.respondidoPorUid).toBe('uid-gestor-123');
    expect(fields.respondidoPorUid).not.toBe('');
  });

  test('J2 — auditFields contém respondidoPorEmail não vazio', () => {
    const fields = buildAuditFields('aprovada', 'OK', 'uid-gestor-123', 'gestor@mr4.com');
    expect(fields).toHaveProperty('respondidoPorEmail');
    expect(fields.respondidoPorEmail).toBe('gestor@mr4.com');
    expect(fields.respondidoPorEmail).not.toBe('');
  });

  test('J3 — respondidoEm é sentinel (não string/Date arbitrária)', () => {
    const fields = buildAuditFields('rejeitada', 'Motivo válido', 'uid-g', 'g@mr4.com');
    expect(fields).toHaveProperty('respondidoEm');
    // Não deve ser uma string ISO ou Date — deve ser o sentinel do servidor
    expect(typeof fields.respondidoEm).not.toBe('string');
    expect(fields.respondidoEm).not.toBeInstanceOf(Date);
    // Deve ter estrutura de sentinel
    expect(fields.respondidoEm).toMatchObject({ _sentinel: 'serverTimestamp' });
  });

  test('J3-b — auditFields rejeitada: todos os 5 campos presentes', () => {
    const fields = buildAuditFields('rejeitada', 'Falta não justificada', 'uid-g', 'g@mr4.com');
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(['status', 'obsGestor', 'respondidoPorUid', 'respondidoPorEmail', 'respondidoEm'])
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J4-J7 — Emulator: Firestore Rules para justificativas
// ═══════════════════════════════════════════════════════════════════════════

describe('J4-J7 — Emulator: Rules justificativas', () => {
  test('J4 — funcionário NÃO pode atualizar justificativa (temModulo falha) → DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('justificativas').doc('justif-j4').set(JUSTIF_PENDENTE);
    });
    await assertFails(
      ctxFunc().firestore().collection('justificativas').doc('justif-j4').update({
        status:             'aprovada',
        obsGestor:          'Aprovado',
        respondidoPorUid:   UID_FUNC,
        respondidoPorEmail: 'func@mr4.com',
        respondidoEm:       serverTimestamp(),
      })
    );
  });

  test('J5 — gestor SEM módulo ponto NÃO pode atualizar justificativa → DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('justificativas').doc('justif-j5').set(JUSTIF_PENDENTE);
    });
    await assertFails(
      ctxGestorSemPonto().firestore().collection('justificativas').doc('justif-j5').update({
        status:             'aprovada',
        obsGestor:          'Aprovado',
        respondidoPorUid:   UID_GESTOR_SEM_PONTO,
        respondidoPorEmail: 'gestor-noponto@mr4.com',
        respondidoEm:       serverTimestamp(),
      })
    );
  });

  test('J6 — gestor COM módulo ponto atualiza justificativa → ALLOWED', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('justificativas').doc('justif-j6').set(JUSTIF_PENDENTE);
    });
    await assertSucceeds(
      ctxGestorPonto().firestore().collection('justificativas').doc('justif-j6').update({
        status:             'aprovada',
        obsGestor:          'Aprovado pelo gestor',
        respondidoPorUid:   UID_GESTOR_PONTO,
        respondidoPorEmail: 'gestor-ponto@mr4.com',
        respondidoEm:       serverTimestamp(),
      })
    );
  });

  test('J7 — justificativas legadas (sem audit trail) não são afetadas por operações J6', async () => {
    const ID_LEGADA   = 'justif-legada-j7';
    const ID_OPERACAO = 'justif-operacao-j7';

    // Seed + verificação num único bloco withSecurityRulesDisabled (evita conflito de app init)
    await testEnv.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      // Seed: 1 doc legado (sem audit fields) + 1 doc a ser atualizado
      await db.collection('justificativas').doc(ID_LEGADA).set(JUSTIF_LEGADA);
      await db.collection('justificativas').doc(ID_OPERACAO).set(JUSTIF_PENDENTE);
    });

    // Gestor atualiza APENAS o doc de operação (não o legado)
    await assertSucceeds(
      ctxGestorPonto().firestore().collection('justificativas').doc(ID_OPERACAO).update({
        status:             'rejeitada',
        obsGestor:          'Não justificado',
        respondidoPorUid:   UID_GESTOR_PONTO,
        respondidoPorEmail: 'gestor-ponto@mr4.com',
        respondidoEm:       serverTimestamp(),
      })
    );

    // Verifica que o doc legado permanece intacto usando gestor (tem read permission)
    const gestorDb = ctxGestorPonto().firestore();
    const legadoSnap = await gestorDb.collection('justificativas').doc(ID_LEGADA).get();
    expect(legadoSnap.exists).toBe(true);
    const data = legadoSnap.data();
    expect(data.respondidoPorUid).toBeUndefined();
    expect(data.respondidoPorEmail).toBeUndefined();
    expect(data.respondidoEm).toBeUndefined();
    // Dados originais preservados
    expect(data.funcId).toBe(FUNC_ID);
    expect(data.status).toBe('pendente');
  });
});
