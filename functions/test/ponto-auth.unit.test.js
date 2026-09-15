'use strict';

/**
 * Testes de autorização do painel administrativo ponto.html (A-1..A-8)
 *
 * Simula a lógica de autenticação do onAuthStateChanged de ponto.html:
 *   1. Usuário autenticado (user != null)
 *   2. users/{uid}: role='gestor', ativo=true
 *   3. sistema_usuarios/{uid}: admin=true OU modulos inclui 'ponto'
 *
 * NÃO testa Firebase diretamente — replica a lógica de decisão em JS puro
 * para garantir que nenhuma regressão seja introduzida nos critérios de acesso.
 *
 * Grupos:
 *   A-1..A-3 : gestores com/sem módulo ponto
 *   A-4      : gestor inativo
 *   A-5      : funcionário (role='funcionario')
 *   A-6      : conta sem perfil (users doc não existe)
 *   A-7      : gestor admin=true sem módulo explícito
 *   A-8      : regressão — ponto-func.html não exige módulo
 */

// ─── Replica a lógica de decisão de acesso de ponto.html ─────────────────────

/**
 * Retorna:
 *   'redirect_func'   → redireciona para ponto-func.html (funcionário)
 *   'deny_role'       → acesso negado (sem role=gestor ativo)
 *   'deny_module'     → acesso negado (sem módulo ponto liberado)
 *   'allow'           → acesso concedido
 *   'no_user'         → não autenticado → redirect login
 */
function pontoHtmlAuthDecision(user, usersDoc, sistemaUsuariosDoc) {
  // Etapa 0: usuário autenticado
  if (!user) return 'no_user';

  // Etapa 1: verificar role (ponto-func.html redirect)
  if (usersDoc && usersDoc.role === 'funcionario') return 'redirect_func';

  // Etapa 2: FAIL CLOSED — role=gestor + ativo
  if (!usersDoc || !usersDoc.ativo || usersDoc.role !== 'gestor') return 'deny_role';

  // Etapa 3: módulo ponto
  const sysData = sistemaUsuariosDoc || null;
  const temAcesso = sysData && (sysData.admin === true || (sysData.modulos || []).includes('ponto'));
  if (!temAcesso) return 'deny_module';

  return 'allow';
}

/**
 * Replica a lógica de ponto-func.html:
 * funcionário autenticado, ativo, role='funcionario' → acesso normal.
 * NÃO verifica sistema_usuarios.
 */
function pontoFuncHtmlAuthDecision(user, usersDoc) {
  if (!user) return 'no_user';
  if (!usersDoc || !usersDoc.ativo) return 'deny_inactive';
  if (usersDoc.role !== 'funcionario') return 'deny_not_func';
  return 'allow_func';
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = { uid: 'uid_test', email: 'test@mr4.com' };

const gestorAtivoComPonto = {
  usersDoc: { role: 'gestor', ativo: true },
  sysDoc:   { admin: false, modulos: ['ponto', 'expedicao'] },
};
const gestorAtivoSemPonto = {
  usersDoc: { role: 'gestor', ativo: true },
  sysDoc:   { admin: false, modulos: ['expedicao', 'garantia'] },
};
const gestorInativoComPonto = {
  usersDoc: { role: 'gestor', ativo: false },
  sysDoc:   { admin: false, modulos: ['ponto'] },
};
const funcionarioAtivo = {
  usersDoc: { role: 'funcionario', ativo: true, funcionarioId: 'FUNC001' },
  sysDoc:   null, // funcionários não têm sistema_usuarios
};
const semPerfil = {
  usersDoc: null,
  sysDoc:   null,
};
const gestorAdminSemModuloExplicito = {
  usersDoc: { role: 'gestor', ativo: true },
  sysDoc:   { admin: true, modulos: [] }, // admin=true → acesso independente de modulos
};

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('Autorização ponto.html (A-1..A-8)', () => {
  // A-1: gestor ativo com módulo 'ponto' → ALLOW
  test('A-1: gestor+ponto → allow', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      gestorAtivoComPonto.usersDoc,
      gestorAtivoComPonto.sysDoc
    );
    expect(result).toBe('allow');
  });

  // A-2: gestor ativo SEM módulo 'ponto' → DENY (módulo)
  test('A-2: gestor sem módulo ponto → deny_module', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      gestorAtivoSemPonto.usersDoc,
      gestorAtivoSemPonto.sysDoc
    );
    expect(result).toBe('deny_module');
  });

  // A-3: gestor sem sistema_usuarios doc → DENY (módulo)
  test('A-3: gestor sem doc sistema_usuarios → deny_module', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      { role: 'gestor', ativo: true },
      null
    );
    expect(result).toBe('deny_module');
  });

  // A-4: gestor inativo com módulo 'ponto' → DENY (role/ativo)
  test('A-4: gestor inativo+ponto → deny_role', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      gestorInativoComPonto.usersDoc,
      gestorInativoComPonto.sysDoc
    );
    expect(result).toBe('deny_role');
  });

  // A-5: funcionário → redirect para ponto-func.html
  test('A-5: funcionário → redirect_func', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      funcionarioAtivo.usersDoc,
      funcionarioAtivo.sysDoc
    );
    expect(result).toBe('redirect_func');
  });

  // A-6: conta sem doc users/{uid} → DENY (role)
  test('A-6: sem perfil users/{uid} → deny_role', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      semPerfil.usersDoc,
      semPerfil.sysDoc
    );
    expect(result).toBe('deny_role');
  });

  // A-7: gestor admin=true sem módulo explícito → ALLOW (admin bypass)
  test('A-7: gestor admin=true sem módulo explícito → allow', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      gestorAdminSemModuloExplicito.usersDoc,
      gestorAdminSemModuloExplicito.sysDoc
    );
    expect(result).toBe('allow');
  });

  // A-8: usuário não autenticado → no_user
  test('A-8: sem usuário → no_user', () => {
    const result = pontoHtmlAuthDecision(null, null, null);
    expect(result).toBe('no_user');
  });
});

describe('ponto-func.html NÃO exige módulo ponto (A-9..A-10)', () => {
  // A-9: funcionário ativo → acesso em ponto-func.html independente de sistema_usuarios
  test('A-9: funcionário ativo → allow_func (sem verificar sistema_usuarios)', () => {
    const result = pontoFuncHtmlAuthDecision(USER, funcionarioAtivo.usersDoc);
    expect(result).toBe('allow_func');
  });

  // A-10: funcionário sem módulo 'ponto' em sistema_usuarios → ainda acessa ponto-func.html
  test('A-10: funcionário sem sistema_usuarios → allow_func', () => {
    const result = pontoFuncHtmlAuthDecision(USER, { role: 'funcionario', ativo: true });
    expect(result).toBe('allow_func');
  });
});

describe('Regressão: lógica de acesso é consistente (A-11..A-12)', () => {
  // A-11: módulos=['ponto'] com outros módulos → acesso permitido
  test('A-11: modulos inclui ponto entre outros → allow', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      { role: 'gestor', ativo: true },
      { admin: false, modulos: ['catalogo', 'ponto', 'demandas'] }
    );
    expect(result).toBe('allow');
  });

  // A-12: modulos=['PONTO'] (case-sensitive) → DENY (módulo id é lowercase 'ponto')
  test('A-12: modulos com PONTO uppercase → deny_module (case-sensitive)', () => {
    const result = pontoHtmlAuthDecision(
      USER,
      { role: 'gestor', ativo: true },
      { admin: false, modulos: ['PONTO'] }
    );
    expect(result).toBe('deny_module');
  });
});
