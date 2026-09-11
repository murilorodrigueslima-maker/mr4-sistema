'use strict';

/**
 * Testes A–W: Firestore Rules no emulador
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
const { serverTimestamp, deleteField } = require('@firebase/firestore');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const PROJECT_ID = 'mr4-ponto';
const RULES_PATH = resolve(__dirname, '../../modulos/firestore.rules');

let testEnv;

// UIDs e dados de teste
const UID_GESTOR    = 'uid-gestor-test';
const UID_GESTOR_2  = 'uid-gestor2-test';
const UID_FUNC      = 'uid-func-test';
const UID_ANONIMO   = 'uid-anonimo-test';
const FUNC_ID       = 'func-test-001';
// Emails usados como token.email nos contextos autenticados
const EMAIL_GESTOR   = 'gestor@test.com';
const EMAIL_GESTOR_2 = 'gestor2@test.com';

// Contextos com token.email injetado (necessário para validação nas Rules)
const ctxGestor  = () => testEnv.authenticatedContext(UID_GESTOR,   { email: EMAIL_GESTOR   });
const ctxGestor2 = () => testEnv.authenticatedContext(UID_GESTOR_2, { email: EMAIL_GESTOR_2 });
const ctxFunc    = () => testEnv.authenticatedContext(UID_FUNC);

async function seedBase(db) {
  await db.collection('users').doc(UID_GESTOR).set({
    role: 'gestor', ativo: true, nome: 'Gestor Teste',
  });
  await db.collection('users').doc(UID_GESTOR_2).set({
    role: 'gestor', ativo: true, nome: 'Gestor Dois',
  });
  await db.collection('users').doc(UID_FUNC).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID, nome: 'Func Teste',
  });
  await db.collection('funcionarios').doc(FUNC_ID).set({
    nome: 'Func Teste', cargo: 'Vendedor', modalidade: 'PRESENCIAL',
  });
}

async function seedJustifPendente(db, id = 'justif-auditoria') {
  await db.collection('justificativas').doc(id).set({
    id, funcId: FUNC_ID, funcNome: 'Func Teste',
    data: '2026-09-01', motivo: 'Atestado médico',
    status: 'pendente', lancadoPorGestor: false,
    criadoEm: '2026-09-01T08:00:00.000Z',
  });
}

async function seedJustifRespondida(db, id = 'justif-respondida') {
  await db.collection('justificativas').doc(id).set({
    id, funcId: FUNC_ID, funcNome: 'Func Teste',
    data: '2026-09-01', motivo: 'Atestado médico',
    status: 'aprovado', lancadoPorGestor: false,
    criadoEm: '2026-09-01T08:00:00.000Z',
    respondidoPorUid:   UID_GESTOR,
    respondidoPorEmail: EMAIL_GESTOR,
    respondidoEm:       new Date('2026-09-01T10:00:00Z'),
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
    await seedBase(ctx.firestore());
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedBase(ctx.firestore());
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

// ─── Teste J: funcionario NÃO pode criar espelho (create=gestor only) ─────────
test('J — funcionario não pode criar espelho (only gestor can create)', async () => {
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertFails(
    db.collection('espelhos').doc('esp-func').set({
      funcId:   FUNC_ID,
      mes:      '2026-09',
      assinado: false,
    })
  );
});

// ─── Teste K: funcionario pode assinar espelho (update campos permitidos) ─────
test('K — funcionario pode atualizar espelho com campos de assinatura', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-assinar').set({
      funcId: FUNC_ID, mes: '2026-09', assinado: false,
    });
  });
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertSucceeds(
    db.collection('espelhos').doc('esp-assinar').update({
      assinado:     true,
      assinaturaImg:'data:image/png;base64,abc',
      assinadoEm:   '2026-09-09T12:00:00.000Z',
      assinadoPor:  'Func Teste',
    })
  );
});

// ─── Teste L: funcionario NÃO pode atualizar espelho com campos fora do set ───
test('L — funcionario não pode alterar espelho além dos campos de assinatura', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-restrito').set({
      funcId: FUNC_ID, mes: '2026-09', assinado: false,
    });
  });
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  // Tentativa de alterar campo 'mes' (não permitido)
  await assertFails(
    db.collection('espelhos').doc('esp-restrito').update({
      assinado: true,
      mes:      '2026-08',
    })
  );
});

// ─── Teste M: funcionario NÃO pode criar justificativa com lancadoPorGestor=true
test('M — funcionario não pode criar justificativa com lancadoPorGestor=true', async () => {
  const db = testEnv.authenticatedContext(UID_FUNC).firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-gestor-flag').set({
      funcId:           FUNC_ID,
      data:             '2026-09-01',
      motivo:           'Fraude de flag',
      status:           'pendente',
      lancadoPorGestor: true,
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Testes N–W: Auditoria de justificativas e semântica de merge (Etapa 2)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Teste N: gestor aprova com próprio UID/email → permitido ─────────────────
test('N — gestor aprova justificativa com próprio UID e email → permitido', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifPendente(ctx.firestore());
  });
  const db = ctxGestor().firestore();
  await assertSucceeds(
    db.collection('justificativas').doc('justif-auditoria').update({
      status:             'aprovado',
      obsGestor:          '',
      respondidoPorUid:   UID_GESTOR,
      respondidoPorEmail: EMAIL_GESTOR,
      respondidoEm:       serverTimestamp(),
    })
  );
});

// ─── Teste O: gestor tenta usar UID de outro gestor → negado ──────────────────
test('O — gestor tenta usar respondidoPorUid de outro gestor → negado', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifPendente(ctx.firestore());
  });
  const db = ctxGestor().firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-auditoria').update({
      status:             'aprovado',
      respondidoPorUid:   UID_GESTOR_2,   // UID de OUTRO gestor
      respondidoPorEmail: EMAIL_GESTOR,
      respondidoEm:       serverTimestamp(),
    })
  );
});

// ─── Teste P: gestor tenta usar email de outro gestor → negado ────────────────
test('P — gestor tenta usar respondidoPorEmail de outro gestor → negado', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifPendente(ctx.firestore());
  });
  const db = ctxGestor().firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-auditoria').update({
      status:             'aprovado',
      respondidoPorUid:   UID_GESTOR,
      respondidoPorEmail: EMAIL_GESTOR_2, // email de OUTRO gestor
      respondidoEm:       serverTimestamp(),
    })
  );
});

// ─── Teste Q: gestor tenta gravar timestamp arbitrário → negado ───────────────
test('Q — gestor tenta gravar timestamp de cliente em respondidoEm → negado', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifPendente(ctx.firestore());
  });
  const db = ctxGestor().firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-auditoria').update({
      status:             'aprovado',
      respondidoPorUid:   UID_GESTOR,
      respondidoPorEmail: EMAIL_GESTOR,
      respondidoEm:       new Date('2020-01-01T00:00:00Z'),  // timestamp arbitrário
    })
  );
});

// ─── Teste R: gestor tenta alterar respondidoPorUid depois da resposta → negado
test('R — gestor não pode alterar respondidoPorUid após resposta (imutabilidade)', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifRespondida(ctx.firestore());
  });
  const db = ctxGestor2().firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-respondida').update({
      respondidoPorUid:   UID_GESTOR_2,  // tenta trocar o autor da decisão
      respondidoPorEmail: EMAIL_GESTOR_2,
      respondidoEm:       serverTimestamp(),
    })
  );
});

// ─── Teste S: gestor tenta remover campos de auditoria → negado ───────────────
test('S — gestor não pode remover respondidoPorUid via FieldValue.delete()', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifRespondida(ctx.firestore());
  });
  const db = ctxGestor().firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-respondida').update({
      respondidoPorUid: deleteField(),
    })
  );
});

// ─── Teste T: funcionário tenta aprovar justificativa → negado ────────────────
test('T — funcionario não pode atualizar justificativa (update=gestor only)', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifPendente(ctx.firestore());
  });
  const db = ctxFunc().firestore();
  await assertFails(
    db.collection('justificativas').doc('justif-auditoria').update({
      status: 'aprovado',
    })
  );
});

// ─── Teste U: criação legítima de justificativa pelo funcionário continua ok ──
test('U — funcionario cria justificativa pendente (fluxo legítimo preservado)', async () => {
  const db = ctxFunc().firestore();
  await assertSucceeds(
    db.collection('justificativas').doc('justif-nova-func').set({
      funcId:           FUNC_ID,
      data:             '2026-09-02',
      motivo:           'Consulta médica',
      status:           'pendente',
      lancadoPorGestor: false,
    })
  );
});

// ─── Teste V: update legítimo sem campos de auditoria continua funcionando ────
test('V — gestor pode atualizar obsGestor sem tocar campos de auditoria', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await seedJustifPendente(ctx.firestore());
  });
  const db = ctxGestor().firestore();
  await assertSucceeds(
    db.collection('justificativas').doc('justif-auditoria').update({
      obsGestor: 'Gestor adicionou nota sem responder ainda',
    })
  );
});

// ─── Teste W: merge — campo extra em creditos_jornada preservado ──────────────
test('W — batch.set(merge:true) preserva campo extra preexistente em creditos_jornada', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('creditos_jornada').doc('cred-merge-test').set({
      id: 'cred-merge-test', funcId: FUNC_ID, funcNome: 'Func Teste',
      data: '2026-09-01', minutos: 480, motivo: 'Atestado',
      criadoEm: '2026-09-01T08:00:00.000Z',
      observacao: 'campo-extra-preexistente',
    });
  });

  const db = ctxGestor().firestore();
  const batch = db.batch();
  batch.set(
    db.collection('creditos_jornada').doc('cred-merge-test'),
    { id:'cred-merge-test', funcId:FUNC_ID, funcNome:'Func Teste',
      data:'2026-09-01', minutos:480, motivo:'Atestado',
      criadoEm: new Date().toISOString() },
    { merge: true }
  );
  await assertSucceeds(batch.commit());

  // Lê com gestor (tem acesso de leitura) para verificar o campo extra
  const dbRead = ctxGestor().firestore();
  const snap = await dbRead.collection('creditos_jornada').doc('cred-merge-test').get();
  expect(snap.data().observacao).toBe('campo-extra-preexistente');
});
