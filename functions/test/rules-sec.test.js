'use strict';

/**
 * Testes de segurança — coleções novas + cenários de escalada de privilégio
 *
 * Cobre: users / sistema_usuarios / produto_equivalentes / demandas / painel_config
 * Perfis: sem auth, funcionário, gestor, auth-sem-perfil, inativo
 *
 * Executar junto com a suíte principal:
 *   cd functions && npm test
 */

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve }      = require('path');

const PROJECT_ID   = 'mr4-ponto';
const RULES_PATH   = resolve(__dirname, '../../modulos/firestore.rules');

const UID_GESTOR    = 'uid-sec-gestor';
const UID_FUNC      = 'uid-sec-func';
const UID_FUNC2     = 'uid-sec-func2';
const UID_NOPROFILE = 'uid-sec-noprofile';   // Auth válido, sem doc users/{uid}
const UID_INATIVO   = 'uid-sec-inativo';     // users/{uid} com ativo=false
const FUNC_ID       = 'func-sec-001';
const FUNC_ID2      = 'func-sec-002';

let testEnv;

const SEED = async db => {
  await db.collection('users').doc(UID_GESTOR).set({ role: 'gestor',      ativo: true,  nome: 'Gestor Sec'  });
  await db.collection('users').doc(UID_FUNC).set(  { role: 'funcionario', ativo: true,  funcionarioId: FUNC_ID,  nome: 'Func Sec'   });
  await db.collection('users').doc(UID_FUNC2).set( { role: 'funcionario', ativo: true,  funcionarioId: FUNC_ID2, nome: 'Func Sec 2' });
  await db.collection('users').doc(UID_INATIVO).set({ role: 'funcionario',ativo: false, funcionarioId: 'func-inativo', nome: 'Inativo' });
  await db.collection('funcionarios').doc(FUNC_ID).set(  { nome: 'Func Sec',   cargo: 'Vendedor' });
  await db.collection('funcionarios').doc(FUNC_ID2).set( { nome: 'Func Sec 2', cargo: 'Vendedor' });
  await db.collection('sistema_usuarios').doc(UID_GESTOR).set({ nome: 'Gestor Sec', cargo: 'Gestor', admin: false, modulos: ['financeiro','estoque','ponto'] });
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

// ══════════════════════════════════════════════════════
// BLOCO 1 — coleção: users
// ══════════════════════════════════════════════════════

describe('users — leitura', () => {
  test('U1 — sem auth não lê users/{uid}', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('users').doc(UID_FUNC).get());
  });

  test('U2 — funcionário lê o próprio users/{uid}', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertSucceeds(db.collection('users').doc(UID_FUNC).get());
  });

  test('U3 — funcionário NÃO lê users/{uid} de outro usuário', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('users').doc(UID_FUNC2).get());
  });

  test('U4 — funcionário NÃO lê users/{uid} do gestor', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('users').doc(UID_GESTOR).get());
  });

  test('U5 — gestor lê qualquer users/{uid}', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('users').doc(UID_FUNC).get());
    await assertSucceeds(db.collection('users').doc(UID_FUNC2).get());
    await assertSucceeds(db.collection('users').doc(UID_GESTOR).get());
  });

  test('U6 — auth sem perfil NÃO lê users de outro', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('users').doc(UID_FUNC).get());
  });

  test('U7 — auth sem perfil lê o próprio users/{uid} (doc inexistente = 404, não negado)', async () => {
    // A regra permite read do próprio uid; o doc não existe, mas a permissão é concedida.
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertSucceeds(db.collection('users').doc(UID_NOPROFILE).get());
  });
});

describe('users — ESCALADA DE PRIVILÉGIO (write bloqueado para não-gestores)', () => {
  test('U8 — funcionário NÃO altera o próprio role', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('users').doc(UID_FUNC).update({ role: 'gestor' }));
  });

  test('U9 — funcionário NÃO altera o próprio ativo', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('users').doc(UID_FUNC).update({ ativo: false }));
  });

  test('U10 — funcionário NÃO altera o próprio funcionarioId', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('users').doc(UID_FUNC).update({ funcionarioId: FUNC_ID2 }));
  });

  test('U11 — funcionário NÃO cria novo users/{uid}', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('users').doc('uid-novo').set({ role: 'gestor', ativo: true }));
  });

  test('U12 — auth sem perfil NÃO cria doc users/{uid}', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('users').doc(UID_NOPROFILE).set({ role: 'gestor', ativo: true }));
  });

  test('U13 — sem auth NÃO escreve em users/{uid}', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('users').doc(UID_FUNC).update({ role: 'gestor' }));
  });

  test('U14 — gestor PODE escrever em users/{uid}', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('users').doc(UID_FUNC).update({ ativo: true }));
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 2 — coleção: sistema_usuarios
// ══════════════════════════════════════════════════════

describe('sistema_usuarios — leitura', () => {
  test('S1 — sem auth não lê sistema_usuarios', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_GESTOR).get());
  });

  test('S2 — funcionário lê o próprio sistema_usuarios (doc inexistente = 404, não negado)', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertSucceeds(db.collection('sistema_usuarios').doc(UID_FUNC).get());
  });

  test('S3 — funcionário NÃO lê sistema_usuarios do gestor', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_GESTOR).get());
  });

  test('S4 — gestor lê qualquer sistema_usuarios', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('sistema_usuarios').doc(UID_GESTOR).get());
    await assertSucceeds(db.collection('sistema_usuarios').doc(UID_FUNC).get());
  });

  test('S5 — auth sem perfil NÃO lê sistema_usuarios de outros', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_GESTOR).get());
  });
});

describe('sistema_usuarios — ESCALADA (write bloqueado para não-gestores)', () => {
  test('S6 — funcionário NÃO cria perfil admin em sistema_usuarios', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_FUNC).set({
      admin: true, modulos: ['financeiro','estoque','admin'],
    }));
  });

  test('S7 — funcionário NÃO atualiza sistema_usuarios existente', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_GESTOR).update({ admin: true }));
  });

  test('S8 — auth sem perfil NÃO cria sistema_usuarios', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_NOPROFILE).set({ admin: true }));
  });

  test('S9 — sem auth NÃO escreve em sistema_usuarios', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_GESTOR).update({ admin: true }));
  });

  test('S10 — gestor PODE escrever em sistema_usuarios', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('sistema_usuarios').doc(UID_FUNC).set({
      nome: 'Func Sec', cargo: 'Vendedor', modulos: [],
    }));
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 3 — coleção: produto_equivalentes
// ══════════════════════════════════════════════════════

describe('produto_equivalentes — acesso', () => {
  test('P1 — sem auth não lê produto_equivalentes', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('produto_equivalentes').doc('eq-001').get());
  });

  test('P2 — funcionário NÃO lê produto_equivalentes', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('produto_equivalentes').doc('eq-001').set({ codigo: 'ABC', equivalente: 'XYZ' });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('produto_equivalentes').doc('eq-001').get());
  });

  test('P3 — funcionário NÃO cria produto_equivalentes', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('produto_equivalentes').doc('eq-novo').set({ codigo: 'ABC' }));
  });

  test('P4 — auth sem perfil NÃO acessa produto_equivalentes', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('produto_equivalentes').doc('eq-001').get());
  });

  test('P5 — gestor lê produto_equivalentes', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('produto_equivalentes').doc('eq-001').set({ codigo: 'ABC' });
    });
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('produto_equivalentes').doc('eq-001').get());
  });

  test('P6 — gestor cria produto_equivalentes', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('produto_equivalentes').doc('eq-novo').set({ codigo: 'DEF', equivalente: 'GHI' }));
  });

  test('P7 — gestor deleta produto_equivalentes', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('produto_equivalentes').doc('eq-del').set({ codigo: 'DEL' });
    });
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('produto_equivalentes').doc('eq-del').delete());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 4 — coleção: demandas
// ══════════════════════════════════════════════════════

describe('demandas — acesso', () => {
  test('D1 — sem auth não lê demandas', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('demandas').doc('dem-001').get());
  });

  test('D2 — funcionário NÃO lê demandas', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('demandas').doc('dem-001').set({ titulo: 'Tarefa', status: 'aberta' });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('demandas').doc('dem-001').get());
  });

  test('D3 — funcionário NÃO cria demanda', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('demandas').doc('dem-nova').set({ titulo: 'Nova', status: 'aberta' }));
  });

  test('D4 — auth sem perfil NÃO acessa demandas', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('demandas').doc('dem-001').get());
  });

  test('D5 — gestor lê demandas', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('demandas').doc('dem-001').set({ titulo: 'Tarefa', status: 'aberta' });
    });
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('demandas').doc('dem-001').get());
  });

  test('D6 — gestor cria demanda', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('demandas').doc('dem-nova').set({ titulo: 'Nova tarefa', status: 'aberta' }));
  });

  test('D7 — gestor deleta demanda', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('demandas').doc('dem-del').set({ titulo: 'Del' });
    });
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('demandas').doc('dem-del').delete());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 5 — coleção: painel_config
// ══════════════════════════════════════════════════════

describe('painel_config — acesso', () => {
  test('PC1 — sem auth não lê painel_config', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('painel_config').doc('config').get());
  });

  test('PC2 — funcionário NÃO lê painel_config', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('painel_config').doc('config').set({ chave: 'valor' });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('painel_config').doc('config').get());
  });

  test('PC3 — funcionário NÃO escreve em painel_config', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('painel_config').doc('config').set({ chave: 'nova' }));
  });

  test('PC4 — auth sem perfil NÃO acessa painel_config', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('painel_config').doc('config').get());
  });

  test('PC5 — gestor lê painel_config', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('painel_config').doc('config').set({ chave: 'valor' });
    });
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('painel_config').doc('config').get());
  });

  test('PC6 — gestor escreve em painel_config', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('painel_config').doc('nova').set({ chave: 'nova' }));
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 6 — usuário INATIVO
// ══════════════════════════════════════════════════════

describe('usuário inativo — acesso negado mesmo com role correto', () => {
  test('I1 — inativo (ativo=false) NÃO lê funcionarios', async () => {
    const db = testEnv.authenticatedContext(UID_INATIVO).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID).get());
  });

  test('I2 — inativo NÃO lê registros', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('registros').doc('reg-i').set({ funcId: 'func-inativo' });
    });
    const db = testEnv.authenticatedContext(UID_INATIVO).firestore();
    await assertFails(db.collection('registros').doc('reg-i').get());
  });

  test('I3 — inativo NÃO escreve em users/{uid}', async () => {
    const db = testEnv.authenticatedContext(UID_INATIVO).firestore();
    await assertFails(db.collection('users').doc(UID_INATIVO).update({ ativo: true }));
  });

  test('I4 — inativo NÃO acessa sistema_usuarios', async () => {
    const db = testEnv.authenticatedContext(UID_INATIVO).firestore();
    await assertFails(db.collection('sistema_usuarios').doc(UID_GESTOR).get());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 7 — auth sem perfil (sem doc users/{uid})
// ══════════════════════════════════════════════════════

describe('auth sem perfil — fail closed em todos os acessos protegidos', () => {
  test('NP1 — sem perfil não lê funcionarios', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('funcionarios').doc(FUNC_ID).get());
  });

  test('NP2 — sem perfil não lê registros', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('registros').doc('reg-np').set({ funcId: 'func-np' });
    });
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('registros').doc('reg-np').get());
  });

  test('NP3 — sem perfil não cria justificativa', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('justificativas').doc('just-np').set({
      funcId: 'func-np', data: '2026-09-01', status: 'pendente', lancadoPorGestor: false,
    }));
  });

  test('NP4 — sem perfil não escreve em painel_config', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('painel_config').doc('config').set({ x: 1 }));
  });

  test('NP5 — sem perfil não acessa demandas', async () => {
    const db = testEnv.authenticatedContext(UID_NOPROFILE).firestore();
    await assertFails(db.collection('demandas').doc('dem-np').get());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 8 — funcionário: isolamento entre funcionários
// ══════════════════════════════════════════════════════

describe('funcionário — não acessa dados de outro funcionário', () => {
  test('FI1 — func1 NÃO lê registros de func2', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('registros').doc('reg-f2').set({ funcId: FUNC_ID2 });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('registros').doc('reg-f2').get());
  });

  test('FI2 — func1 NÃO lê justificativas de func2', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('justificativas').doc('just-f2').set({ funcId: FUNC_ID2, status: 'pendente', lancadoPorGestor: false });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('justificativas').doc('just-f2').get());
  });

  test('FI3 — func1 NÃO cria justificativa com funcId de func2', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('justificativas').doc('just-spoof').set({
      funcId: FUNC_ID2, data: '2026-09-01', motivo: 'Fraude', status: 'pendente', lancadoPorGestor: false,
    }));
  });

  test('FI4 — func1 NÃO lê creditos_jornada de func2', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('creditos_jornada').doc('cred-f2').set({ funcId: FUNC_ID2, horas: 2 });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('creditos_jornada').doc('cred-f2').get());
  });

  test('FI5 — func1 NÃO lê espelho de func2', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('espelhos').doc('esp-f2').set({ funcId: FUNC_ID2, mes: '2026-09', assinado: false });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('espelhos').doc('esp-f2').get());
  });

  test('FI6 — func1 NÃO altera registros de func2', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('registros').doc('reg-f2-upd').set({ funcId: FUNC_ID2 });
    });
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('registros').doc('reg-f2-upd').update({ hora: '09:00:00' }));
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 9 — coleção catch-all: qualquer coleção desconhecida é negada
// ══════════════════════════════════════════════════════

describe('catch-all — coleções não mapeadas são negadas', () => {
  test('CA1 — sem auth não acessa coleção desconhecida', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('qualquer_coisa').doc('doc').get());
  });

  test('CA2 — funcionário não acessa coleção desconhecida', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('clientes_crm').doc('cli').get());
  });

  test('CA3 — gestor NÃO acessa coleção desconhecida (catch-all if false)', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertFails(db.collection('colecao_inexistente').doc('doc').get());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 10 — gestor: operações legítimas completas
// ══════════════════════════════════════════════════════

describe('gestor — todas as operações legítimas continuam funcionando', () => {
  test('G1 — gestor lê e escreve funcionarios', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('funcionarios').doc(FUNC_ID).get());
    await assertSucceeds(db.collection('funcionarios').doc('func-novo').set({ nome: 'Novo', cargo: 'Vendedor', modalidade: 'PRESENCIAL' }));
  });

  test('G2 — gestor cria registro manual', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('registros').doc('reg-gestor-g2').set({
      funcId: FUNC_ID, authUid: UID_GESTOR, data: '2026-09-09', hora: '08:00:00', tipo: 'entrada', tipoLabel: 'Entrada', lancadoPorGestor: true,
    }));
  });

  test('G3 — gestor lê registros de qualquer funcionário', async () => {
    // Gestor tem write em registros — semear sem bypass de regras
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await db.collection('registros').doc('reg-g3').set({ funcId: FUNC_ID, lancadoPorGestor: true, tipo: 'entrada', tipoLabel: 'Entrada', data: '2026-09-09', hora: '08:00:00', authUid: UID_GESTOR });
    await db.collection('registros').doc('reg-g3b').set({ funcId: FUNC_ID2, lancadoPorGestor: true, tipo: 'entrada', tipoLabel: 'Entrada', data: '2026-09-09', hora: '08:00:00', authUid: UID_GESTOR });
    await assertSucceeds(db.collection('registros').doc('reg-g3').get());
    await assertSucceeds(db.collection('registros').doc('reg-g3b').get());
  });

  test('G4 — gestor aprova justificativa (update status)', async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await ctx.firestore().collection('justificativas').doc('just-g4').set({ funcId: FUNC_ID, status: 'pendente', lancadoPorGestor: false });
    });
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('justificativas').doc('just-g4').update({ status: 'aprovado', aprovadoPor: UID_GESTOR }));
  });

  test('G5 — gestor cria e lê espelho', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('espelhos').doc('esp-g5').set({ funcId: FUNC_ID, mes: '2026-09', assinado: false }));
    await assertSucceeds(db.collection('espelhos').doc('esp-g5').get());
  });

  test('G6 — gestor escreve creditos_jornada', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('creditos_jornada').doc('cred-g6').set({ funcId: FUNC_ID, horas: 2, motivo: 'Horas extras' }));
  });

  test('G7 — gestor lê e escreve avaliacoes', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('avaliacoes').doc('aval-g7').set({ funcId: FUNC_ID, nota: 8 }));
    await assertSucceeds(db.collection('avaliacoes').doc('aval-g7').get());
  });
});

// ══════════════════════════════════════════════════════
// BLOCO 11 — assinatura de espelho pelo funcionário
// Cobre: ponto-func.html confirmarAssinatura()
// Campos permitidos: assinado, assinaturaImg, assinadoEm, assinadoPor
// Campos proibidos: funcId, mes, qualquer campo extra
// ══════════════════════════════════════════════════════

describe('assinatura de espelho — Rule hasOnly([...4 campos])', () => {
  const ESP_PROPRIO  = 'esp-sig-proprio';
  const ESP_ALHEIO   = 'esp-sig-alheio';

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await db.collection('espelhos').doc(ESP_PROPRIO).set({
        funcId: FUNC_ID, mes: '2026-09', assinado: false, horas: '160h',
      });
      await db.collection('espelhos').doc(ESP_ALHEIO).set({
        funcId: FUNC_ID2, mes: '2026-09', assinado: false, horas: '160h',
      });
    });
  });

  test('E1 — funcionário assina o próprio espelho (4 campos exatos) → PASS', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertSucceeds(db.collection('espelhos').doc(ESP_PROPRIO).update({
      assinado: true,
      assinaturaImg: 'data:image/png;base64,ABC',
      assinadoEm: '2026-09-09T14:00:00.000Z',
      assinadoPor: 'Func Sec',
    }));
  });

  test('E2 — funcionário assina espelho de outro funcionário → NEGADO', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('espelhos').doc(ESP_ALHEIO).update({
      assinado: true,
      assinaturaImg: 'data:image/png;base64,ABC',
      assinadoEm: '2026-09-09T14:00:00.000Z',
      assinadoPor: 'Func Sec',
    }));
  });

  test('E3 — funcionário envia campo extra authUid junto com assinatura → NEGADO', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('espelhos').doc(ESP_PROPRIO).update({
      assinado: true,
      assinaturaImg: 'data:image/png;base64,ABC',
      assinadoEm: '2026-09-09T14:00:00.000Z',
      assinadoPor: 'Func Sec',
      authUid: UID_FUNC,
    }));
  });

  test('E4 — funcionário tenta alterar funcId junto com assinatura → NEGADO', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('espelhos').doc(ESP_PROPRIO).update({
      assinado: true,
      assinaturaImg: 'data:image/png;base64,ABC',
      assinadoEm: '2026-09-09T14:00:00.000Z',
      assinadoPor: 'Func Sec',
      funcId: FUNC_ID2,
    }));
  });

  test('E5 — funcionário tenta alterar período (mes) junto com assinatura → NEGADO', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('espelhos').doc(ESP_PROPRIO).update({
      assinado: true,
      assinaturaImg: 'data:image/png;base64,ABC',
      assinadoEm: '2026-09-09T14:00:00.000Z',
      assinadoPor: 'Func Sec',
      mes: '2025-01',
    }));
  });

  test('E6 — funcionário tenta alterar horas sem assinar → NEGADO', async () => {
    const db = testEnv.authenticatedContext(UID_FUNC).firestore();
    await assertFails(db.collection('espelhos').doc(ESP_PROPRIO).update({
      horas: '999h',
    }));
  });

  test('E7 — funcionário inativo NÃO consegue assinar → NEGADO', async () => {
    const db = testEnv.authenticatedContext(UID_INATIVO).firestore();
    await assertFails(db.collection('espelhos').doc(ESP_PROPRIO).update({
      assinado: true,
      assinaturaImg: 'data:image/png;base64,ABC',
      assinadoEm: '2026-09-09T14:00:00.000Z',
      assinadoPor: 'Inativo',
    }));
  });

  test('E8 — gestor pode atualizar espelho livremente (não restrito a hasOnly) → PASS', async () => {
    const db = testEnv.authenticatedContext(UID_GESTOR).firestore();
    await assertSucceeds(db.collection('espelhos').doc(ESP_PROPRIO).update({
      assinado: false, horas: '168h', observacoes: 'Corrigido',
    }));
  });
});
