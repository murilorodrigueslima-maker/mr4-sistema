'use strict';

/**
 * Testes A–L: Firestore Rules — coleção espelhos
 *
 * Cobre:
 *   A-C  Criação (gestor/funcionário)
 *   D-G  Update gestor (não-assinado e assinado)
 *   H-K  Update funcionário (signing)
 *   L    Campos estruturais imutáveis pelo gestor
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore,auth
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=espelho-rules.test
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

const UID_GESTOR   = 'uid-gestor-esp';
const UID_FUNC     = 'uid-func-esp';
const UID_FUNC_ALT = 'uid-func-alt';
const FUNC_ID      = 'func-esp-001';
const FUNC_ID_ALT  = 'func-esp-002';

const ctxGestor  = () => testEnv.authenticatedContext(UID_GESTOR);
const ctxFunc    = () => testEnv.authenticatedContext(UID_FUNC);
const ctxFuncAlt = () => testEnv.authenticatedContext(UID_FUNC_ALT);

const ESP_UNSIGNED = {
  funcId: FUNC_ID, mes: '2026-09', assinado: false,
  versao: 1, versaoAnteriorId: null,
  snapshot: null, hashSnapshot: null,
};
const ESP_SIGNED = {
  funcId: FUNC_ID, mes: '2026-09', assinado: true,
  versao: 1, versaoAnteriorId: null,
  assinadoPor: 'Func Teste',
  assinaturaImg: 'data:image/png;base64,IMG',
  snapshot: { engineVersao: '3.0.0', dias: [], totais: {} },
  hashSnapshot: 'abc123deadbeef',
};

async function seedUsers(db) {
  await db.collection('users').doc(UID_GESTOR).set({ role: 'gestor', ativo: true });
  await db.collection('users').doc(UID_FUNC).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID,
  });
  await db.collection('users').doc(UID_FUNC_ALT).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_ALT,
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
// A-C: Criação
// ═══════════════════════════════════════════════════════════════════════════

test('A — gestor cria espelho não-assinado (assinado:false) → ALLOWED', async () => {
  const db = ctxGestor().firestore();
  await assertSucceeds(db.collection('espelhos').doc('esp-novo').set(ESP_UNSIGNED));
});

test('B — gestor tenta criar espelho com assinado:true → DENIED', async () => {
  const db = ctxGestor().firestore();
  await assertFails(db.collection('espelhos').doc('esp-pre-sign').set(ESP_SIGNED));
});

test('C — funcionario não pode criar espelho (create=gestor only) → DENIED', async () => {
  const db = ctxFunc().firestore();
  await assertFails(db.collection('espelhos').doc('esp-func-cria').set(ESP_UNSIGNED));
});

// ═══════════════════════════════════════════════════════════════════════════
// D-G: Update pelo gestor
// ═══════════════════════════════════════════════════════════════════════════

test('D — gestor atualiza snapshot em espelho não-assinado → ALLOWED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertSucceeds(
    ctxGestor().firestore().collection('espelhos').doc('esp-u').update({
      snapshot:     { engineVersao: '3.0.0', dias: [], totais: {} },
      hashSnapshot: 'newhash123',
    })
  );
});

test('E — gestor tenta sobrescrever snapshot de espelho assinado → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-s').set(ESP_SIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-s').update({
      snapshot: { engineVersao: '3.0.0', dias: [], totais: { saldo: 999 } },
    })
  );
});

test('F — gestor tenta sobrescrever hashSnapshot de espelho assinado → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-s').set(ESP_SIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-s').update({
      hashSnapshot: 'hash-adulterado',
    })
  );
});

test('G — gestor atualiza campos de revisão em espelho assinado → ALLOWED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-s').set(ESP_SIGNED);
  });
  await assertSucceeds(
    ctxGestor().firestore().collection('espelhos').doc('esp-s').update({
      versaoSucessoraId:  'esp-v2-id',
      revisaoEmAndamento: true,
      revisaoAbertaEm:    '2026-09-10T09:00:00.000Z',
      motivoRevisao:      'Correção de horário',
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// H-K: Update pelo funcionário (signing)
// ═══════════════════════════════════════════════════════════════════════════

test('H — funcionario assina espelho com 5 campos permitidos + serverTimestamp → ALLOWED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-assinar').set(ESP_UNSIGNED);
  });
  await assertSucceeds(
    ctxFunc().firestore().collection('espelhos').doc('esp-assinar').update({
      assinado:     true,
      assinaturaImg:'data:image/png;base64,SIG',
      assinadoEm:   serverTimestamp(),
      assinadoPor:  'Func Teste',
      status:       'assinado',
    })
  );
});

test('I — funcionario não pode desassinar (assinado: false) → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-s').set(ESP_SIGNED);
  });
  await assertFails(
    ctxFunc().firestore().collection('espelhos').doc('esp-s').update({
      assinado:     false,
      assinaturaImg:'data:image/png;base64,NEW',
      assinadoEm:   serverTimestamp(),
      assinadoPor:  'Func Teste',
      status:       'aguardando_assinatura',
    })
  );
});

test('I2 — funcionario não pode re-assinar espelho já assinado → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-s').set(ESP_SIGNED);
  });
  // resource.data.assinado já é true → !resource.data.assinado = false → DENIED
  await assertFails(
    ctxFunc().firestore().collection('espelhos').doc('esp-s').update({
      assinado:     true,
      assinaturaImg:'data:image/png;base64,NOVA-SIG',
      assinadoEm:   serverTimestamp(),
      assinadoPor:  'Func Teste',
      status:       'assinado',
    })
  );
});

test('J — funcionario não pode alterar status arbitrário ao assinar → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertFails(
    ctxFunc().firestore().collection('espelhos').doc('esp-u').update({
      assinado:     true,
      assinaturaImg:'data:image/png;base64,SIG',
      assinadoEm:   serverTimestamp(),
      assinadoPor:  'Func Teste',
      status:       'aguardando_assinatura',  // status inválido para assinatura
    })
  );
});

test('J2 — funcionario não pode usar timestamp de cliente em assinadoEm → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertFails(
    ctxFunc().firestore().collection('espelhos').doc('esp-u').update({
      assinado:     true,
      assinaturaImg:'data:image/png;base64,SIG',
      assinadoEm:   '2026-09-09T12:00:00.000Z',  // string arbitrária — NEGADO
      assinadoPor:  'Func Teste',
      status:       'assinado',
    })
  );
});

test('K — funcionario não pode assinar espelho de outro funcionario → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-alheio').set({
      ...ESP_UNSIGNED, funcId: FUNC_ID_ALT,  // pertence ao outro funcionário
    });
  });
  // ctxFunc é UID_FUNC que tem funcionarioId=FUNC_ID, mas o espelho é FUNC_ID_ALT
  await assertFails(
    ctxFunc().firestore().collection('espelhos').doc('esp-alheio').update({
      assinado:     true,
      assinaturaImg:'data:image/png;base64,SIG',
      assinadoEm:   serverTimestamp(),
      assinadoPor:  'Func Teste',
      status:       'assinado',
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// L: Campos estruturais imutáveis pelo gestor
// ═══════════════════════════════════════════════════════════════════════════

test('L — gestor não pode alterar funcId após create → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-u').update({
      funcId: 'outro-func',
    })
  );
});

test('L2 — gestor não pode alterar mes após create → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-u').update({
      mes: '2026-08',
    })
  );
});

test('L3 — gestor não pode alterar versao após create → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-u').update({
      versao: 99,
    })
  );
});

test('L4 — gestor não pode alterar versaoAnteriorId após create → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-u').set(ESP_UNSIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-u').update({
      versaoAnteriorId: 'esp-v1-falso',
    })
  );
});

// ── Gestor pode excluir/não-excluir ──────────────────────────────────────────

test('H-excluir — gestor exclui espelho não-assinado → ALLOWED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-del').set(ESP_UNSIGNED);
  });
  await assertSucceeds(
    ctxGestor().firestore().collection('espelhos').doc('esp-del').delete()
  );
});

test('H-excluir-sign — gestor não pode excluir espelho assinado → DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.firestore().collection('espelhos').doc('esp-s').set(ESP_SIGNED);
  });
  await assertFails(
    ctxGestor().firestore().collection('espelhos').doc('esp-s').delete()
  );
});
