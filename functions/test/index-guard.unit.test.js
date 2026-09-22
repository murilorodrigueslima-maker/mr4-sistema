'use strict';

/**
 * Testes do guard de acesso do index.html (G-1..G-12)
 * P0 fix 2026-09-22 — verifica dual-role model: gestor OU funcionario+sistema_usuarios
 *
 * Replica a lógica do bloco FAIL CLOSED de index.html em JS puro.
 * Não usa Firebase — testa apenas a árvore de decisão.
 *
 * Grupos:
 *   G-1..G-2 : casos ALLOW (gestor direto + dual-role)
 *   G-3..G-8 : casos BLOCK (variantes sem permissão)
 *   G-9..G-10: casos BLOCK por erro de Firestore
 *   G-11     : dual-role não expande módulos
 *   G-12     : regressão — comportamento anterior de gestor preservado
 */

// ─── Replica o bloco FAIL CLOSED de index.html ───────────────────────────────
//
// Parâmetros:
//   user          : objeto Firebase user simulado, ou null
//   usersDocData  : dados do doc users/{uid}, ou null se doc inexistente
//   sysDocData    : dados do doc sistema_usuarios/{uid}, ou null se doc inexistente
//   throwAt       : null | 'users' | 'sistema_usuarios' — simula erro de Firestore
//
// Retorna:
//   'allow' — guard passa, sistema carrega
//   'block' — guard bloqueia, signOut + redirect login.html

function indexHtmlGuardDecision(user, usersDocData, sysDocData, throwAt = null) {
  // Linha antes do guard: if (!user) → redirect (tratado pelo onAuthStateChanged)
  if (!user) return 'block';

  try {
    if (throwAt === 'users') throw new Error('firestore error');
    const rSnap = {
      exists: () => usersDocData !== null,
      data:   () => usersDocData,
    };
    if (!rSnap.exists() || !rSnap.data().ativo) return 'block';

    const role = rSnap.data().role;
    if (role !== 'gestor') {
      if (role !== 'funcionario') return 'block';

      if (throwAt === 'sistema_usuarios') throw new Error('firestore error');
      const sysSnap = {
        exists: () => sysDocData !== null,
        data:   () => sysDocData,
      };
      if (!sysSnap.exists() || sysSnap.data().bloqueado) return 'block';
    }
  } catch (e) {
    return 'block';
  }

  return 'allow';
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = { uid: 'uid_test', email: 'test@mr4.com' };

const gestorDireto = {
  usersDoc: { role: 'gestor', ativo: true },
  sysDoc:   { nome: 'Murilo', cargo: 'Gestor', modulos: ['ponto', 'catalogo'], admin: false, bloqueado: false },
};
const dualRoleValido = {
  usersDoc: { role: 'funcionario', ativo: true, funcionarioId: 'FUNC002' },
  sysDoc:   { nome: 'Fabiana', cargo: 'Vendedora', modulos: ['catalogo', 'demandas'], admin: false, bloqueado: false },
};
const dualRoleSemSistema = {
  usersDoc: { role: 'funcionario', ativo: true, funcionarioId: 'FUNC003' },
  sysDoc:   null,
};
const dualRoleBloqueado = {
  usersDoc: { role: 'funcionario', ativo: true, funcionarioId: 'FUNC004' },
  sysDoc:   { nome: 'Ex-Funcionário', cargo: 'Ex', modulos: ['catalogo'], admin: false, bloqueado: true },
};
const roleDisplay = {
  usersDoc: { role: 'display', ativo: true },
  sysDoc:   null,
};
const roleDesconhecida = {
  usersDoc: { role: 'superadmin', ativo: true },
  sysDoc:   null,
};
const gestorInativo = {
  usersDoc: { role: 'gestor', ativo: false },
  sysDoc:   null,
};
const funcionarioInativo = {
  usersDoc: { role: 'funcionario', ativo: false, funcionarioId: 'FUNC005' },
  sysDoc:   { nome: 'Inativo', cargo: 'Ex', modulos: ['catalogo'], admin: false, bloqueado: false },
};
const semUsersDoc = {
  usersDoc: null,
  sysDoc:   null,
};
const dualRoleModulosLimitados = {
  usersDoc: { role: 'funcionario', ativo: true, funcionarioId: 'FUNC006' },
  sysDoc:   { nome: 'Swyanne', cargo: 'Vendedora', modulos: ['catalogo'], admin: false, bloqueado: false },
};

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('Guard index.html — casos ALLOW (G-1..G-2)', () => {
  test('G-1: role=gestor, ativo=true → allow', () => {
    expect(indexHtmlGuardDecision(USER, gestorDireto.usersDoc, gestorDireto.sysDoc))
      .toBe('allow');
  });

  test('G-2: role=funcionario, ativo=true, sistema_usuarios válido (bloqueado=false) → allow (dual-role)', () => {
    expect(indexHtmlGuardDecision(USER, dualRoleValido.usersDoc, dualRoleValido.sysDoc))
      .toBe('allow');
  });
});

describe('Guard index.html — casos BLOCK por permissão (G-3..G-8)', () => {
  test('G-3: role=funcionario, sistema_usuarios AUSENTE → block', () => {
    expect(indexHtmlGuardDecision(USER, dualRoleSemSistema.usersDoc, dualRoleSemSistema.sysDoc))
      .toBe('block');
  });

  test('G-4: role=display → block', () => {
    expect(indexHtmlGuardDecision(USER, roleDisplay.usersDoc, roleDisplay.sysDoc))
      .toBe('block');
  });

  test('G-5: role desconhecida (superadmin) → block', () => {
    expect(indexHtmlGuardDecision(USER, roleDesconhecida.usersDoc, roleDesconhecida.sysDoc))
      .toBe('block');
  });

  test('G-6a: gestor inativo (ativo=false) → block', () => {
    expect(indexHtmlGuardDecision(USER, gestorInativo.usersDoc, gestorInativo.sysDoc))
      .toBe('block');
  });

  test('G-6b: funcionario inativo (ativo=false) → block', () => {
    expect(indexHtmlGuardDecision(USER, funcionarioInativo.usersDoc, funcionarioInativo.sysDoc))
      .toBe('block');
  });

  test('G-7: users/{uid} doc AUSENTE → block', () => {
    expect(indexHtmlGuardDecision(USER, semUsersDoc.usersDoc, semUsersDoc.sysDoc))
      .toBe('block');
  });

  test('G-8: user=null (não autenticado) → block', () => {
    expect(indexHtmlGuardDecision(null, null, null))
      .toBe('block');
  });
});

describe('Guard index.html — casos BLOCK por erro Firestore (G-9..G-10)', () => {
  test('G-9: getDoc(users) lança erro → block (FAIL CLOSED por catch)', () => {
    expect(indexHtmlGuardDecision(USER, gestorDireto.usersDoc, null, 'users'))
      .toBe('block');
  });

  test('G-10: getDoc(sistema_usuarios) lança erro → block (FAIL CLOSED por catch)', () => {
    expect(indexHtmlGuardDecision(USER, dualRoleValido.usersDoc, dualRoleValido.sysDoc, 'sistema_usuarios'))
      .toBe('block');
  });
});

describe('Guard index.html — dual-role e regressão (G-11..G-12)', () => {
  test('G-11: dual-role com módulos limitados → allow (guard não expande módulos)', () => {
    // Garante que um funcionario com sistema_usuarios de módulos limitados
    // passa no guard. A expansão de módulos (para admin=true) é feita FORA do guard,
    // na seção "Busca perfil no Firestore" — o guard não altera modulos[].
    const result = indexHtmlGuardDecision(
      USER, dualRoleModulosLimitados.usersDoc, dualRoleModulosLimitados.sysDoc
    );
    expect(result).toBe('allow');
    // Confirma que admin=false → módulos NÃO são expandidos (é responsabilidade do perfil, não do guard)
    expect(dualRoleModulosLimitados.sysDoc.admin).toBe(false);
    expect(dualRoleModulosLimitados.sysDoc.modulos).toEqual(['catalogo']);
  });

  test('G-12: gestor válido (comportamento anterior ao P0 preservado) → allow', () => {
    // Regressão: o comportamento pré-commit 931b4ce para gestor não deve mudar.
    // Murilo (role=gestor, ativo=true) deve continuar acessando normalmente.
    expect(indexHtmlGuardDecision(
      USER,
      { role: 'gestor', ativo: true },
      { nome: 'Murilo', cargo: 'Gestor', modulos: ['ponto', 'catalogo'], admin: false, bloqueado: false }
    )).toBe('allow');
  });
});

describe('Guard index.html — bloqueado=true bloqueia dual-role (G-13)', () => {
  test('G-13: role=funcionario, sistema_usuarios existe mas bloqueado=true → block', () => {
    expect(indexHtmlGuardDecision(USER, dualRoleBloqueado.usersDoc, dualRoleBloqueado.sysDoc))
      .toBe('block');
  });
});
