'use strict';

/**
 * Testes do guard compartilhado — js/guard.js (P0 fix 2026-09-22)
 *
 * Replica verificarAcessoAdmin e verificarAcessoModulo em JS puro.
 * Não usa Firebase — testa apenas a lógica.
 *
 * GU-1..GU-2  : verificarAcessoAdmin — ALLOW
 * GU-3..GU-7  : verificarAcessoAdmin — BLOCK
 * GU-8..GU-9  : verificarAcessoAdmin — FAIL CLOSED
 * GU-10       : verificarAcessoAdmin — regressão gestor
 * GM-1..GM-5  : verificarAcessoModulo — ALLOW (correto + gestor + admin)
 * GM-6..GM-10 : verificarAcessoModulo — BLOCK (módulo errado, bloqueado, inativo, etc.)
 * GM-11       : verificarAcessoModulo — FAIL CLOSED
 */

// ─── Replica verificarAcessoAdmin ────────────────────────────────────────────

async function verificarAcessoAdmin(db, uid) {
  try {
    const rSnap = await db.getDoc('users', uid);
    if (!rSnap.exists || !rSnap.data.ativo) return false;
    const role = rSnap.data.role;
    if (role === 'gestor') return true;
    if (role !== 'funcionario') return false;
    const sysSnap = await db.getDoc('sistema_usuarios', uid);
    if (!sysSnap.exists || sysSnap.data.bloqueado) return false;
    return true;
  } catch(e) {
    return false;
  }
}

// ─── Replica verificarAcessoModulo ───────────────────────────────────────────

async function verificarAcessoModulo(db, uid, modulo) {
  try {
    const rSnap = await db.getDoc('users', uid);
    if (!rSnap.exists || !rSnap.data.ativo) return false;
    const role = rSnap.data.role;
    if (role === 'gestor') return true;
    if (role !== 'funcionario') return false;
    const sysSnap = await db.getDoc('sistema_usuarios', uid);
    if (!sysSnap.exists || sysSnap.data.bloqueado) return false;
    const sys = sysSnap.data;
    return sys.admin === true || (Array.isArray(sys.modulos) && sys.modulos.includes(modulo));
  } catch(e) {
    return false;
  }
}

// ─── Mock de Firestore ────────────────────────────────────────────────────────

function makeDb({ usersData, sysData, throwAt = null }) {
  return {
    getDoc: async (col, uid) => {
      if (throwAt === col) throw new Error('firestore error');
      if (col === 'users') {
        return { exists: usersData !== null, data: usersData };
      }
      if (col === 'sistema_usuarios') {
        return { exists: sysData !== null, data: sysData };
      }
      return { exists: false, data: null };
    },
  };
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('guard.js verificarAcessoAdmin — casos ALLOW (GU-1..GU-2)', () => {
  test('GU-1: role=gestor, ativo=true → true', async () => {
    const db = makeDb({ usersData: { role: 'gestor', ativo: true }, sysData: null });
    expect(await verificarAcessoAdmin(db, 'uid-1')).toBe(true);
  });

  test('GU-2: role=funcionario, ativo=true, sistema_usuarios válido (bloqueado=false) → true', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['demandas'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoAdmin(db, 'uid-2')).toBe(true);
  });
});

describe('guard.js verificarAcessoAdmin — casos BLOCK (GU-3..GU-7)', () => {
  test('GU-3: role=funcionario, sistema_usuarios AUSENTE → false', async () => {
    const db = makeDb({ usersData: { role: 'funcionario', ativo: true }, sysData: null });
    expect(await verificarAcessoAdmin(db, 'uid-3')).toBe(false);
  });

  test('GU-4: role=funcionario, bloqueado=true → false', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['demandas'], bloqueado: true },
    });
    expect(await verificarAcessoAdmin(db, 'uid-4')).toBe(false);
  });

  test('GU-5: role=display → false', async () => {
    const db = makeDb({ usersData: { role: 'display', ativo: true }, sysData: null });
    expect(await verificarAcessoAdmin(db, 'uid-5')).toBe(false);
  });

  test('GU-6: users/{uid} ausente (doc inexistente) → false', async () => {
    const db = makeDb({ usersData: null, sysData: null });
    expect(await verificarAcessoAdmin(db, 'uid-6')).toBe(false);
  });

  test('GU-7: ativo=false → false', async () => {
    const db = makeDb({ usersData: { role: 'gestor', ativo: false }, sysData: null });
    expect(await verificarAcessoAdmin(db, 'uid-7')).toBe(false);
  });
});

describe('guard.js verificarAcessoAdmin — FAIL CLOSED por erro (GU-8..GU-9)', () => {
  test('GU-8: getDoc(users) lança → false', async () => {
    const db = makeDb({ usersData: { role: 'gestor', ativo: true }, sysData: null, throwAt: 'users' });
    expect(await verificarAcessoAdmin(db, 'uid-8')).toBe(false);
  });

  test('GU-9: getDoc(sistema_usuarios) lança → false', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { bloqueado: false },
      throwAt:   'sistema_usuarios',
    });
    expect(await verificarAcessoAdmin(db, 'uid-9')).toBe(false);
  });
});

describe('guard.js verificarAcessoAdmin — regressão gestor (GU-10)', () => {
  test('GU-10: gestor original (Murilo) continua passando', async () => {
    const db = makeDb({
      usersData: { role: 'gestor', ativo: true },
      sysData:   { modulos: ['ponto', 'catalogo'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoAdmin(db, 'uid-murilo')).toBe(true);
  });
});

// ─── verificarAcessoModulo — ALLOW ────────────────────────────────────────────

describe('guard.js verificarAcessoModulo — ALLOW (GM-1..GM-5)', () => {
  test('GM-1: funcionario com modulo correto → true', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['clientes'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-sw', 'clientes')).toBe(true);
  });

  test('GM-2: gestor sem sistema_usuarios → true (backward compat)', async () => {
    const db = makeDb({ usersData: { role: 'gestor', ativo: true }, sysData: null });
    expect(await verificarAcessoModulo(db, 'uid-g', 'financeiro')).toBe(true);
  });

  test('GM-3: funcionario admin=true → true para qualquer módulo', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: [], admin: true, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-adm', 'garantia')).toBe(true);
  });

  test('GM-4: funcionario com múltiplos módulos, verifica o segundo → true', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['demandas', 'expedicao'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-m', 'expedicao')).toBe(true);
  });

  test('GM-5: gestor com sistema_usuarios → true (isGestor short-circuit)', async () => {
    const db = makeDb({
      usersData: { role: 'gestor', ativo: true },
      sysData:   { modulos: ['ponto'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-g2', 'marketing')).toBe(true);
  });
});

// ─── verificarAcessoModulo — BLOCK ────────────────────────────────────────────

describe('guard.js verificarAcessoModulo — BLOCK (GM-6..GM-10)', () => {
  test('GM-6: Swyanne (modulos=[clientes]) tenta financeiro → false (ESCAPE=0)', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['clientes'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-sw', 'financeiro')).toBe(false);
  });

  test('GM-7: Swyanne tenta garantia → false (ESCAPE=0)', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['clientes'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-sw', 'garantia')).toBe(false);
  });

  test('GM-8: Fabiana (demandas) tenta clientes → false (ESCAPE=0)', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['demandas'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-fab', 'clientes')).toBe(false);
  });

  test('GM-9: bloqueado com modulo correto → false (ESCAPE=0)', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['demandas'], admin: false, bloqueado: true },
    });
    expect(await verificarAcessoModulo(db, 'uid-bl', 'demandas')).toBe(false);
  });

  test('GM-10: inativo com modulo correto → false (ESCAPE=0)', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: false },
      sysData:   { modulos: ['demandas'], admin: false, bloqueado: false },
    });
    expect(await verificarAcessoModulo(db, 'uid-in', 'demandas')).toBe(false);
  });
});

// ─── verificarAcessoModulo — FAIL CLOSED ──────────────────────────────────────

describe('guard.js verificarAcessoModulo — FAIL CLOSED (GM-11)', () => {
  test('GM-11: getDoc(sistema_usuarios) lança → false', async () => {
    const db = makeDb({
      usersData: { role: 'funcionario', ativo: true },
      sysData:   { modulos: ['demandas'], bloqueado: false },
      throwAt:   'sistema_usuarios',
    });
    expect(await verificarAcessoModulo(db, 'uid-err', 'demandas')).toBe(false);
  });
});
