// guard.js — dual-role administrative identity and module access checks (P0 fix 2026-09-22)
//
// verificarAcessoAdmin(db, uid)
//   IDENTITY ONLY — true if admin-capable identity (gestor OR funcionario+sistema_usuarios+!bloqueado)
//   Does NOT check which modules are allowed.
//
// verificarAcessoModulo(db, uid, modulo)
//   IDENTITY + MODULE — true if admin-capable AND (admin=true OR modulo in modulos[])
//   Gestor: always allowed (backward compat, no sistema_usuarios required)
//   Funcionario: requires sistema_usuarios with admin=true or modulo in modulos[]
//   FAIL CLOSED on any error.

import { doc, getDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

export async function verificarAcessoAdmin(db, uid) {
  try {
    const rSnap = await getDoc(doc(db, 'users', uid));
    if (!rSnap.exists() || !rSnap.data().ativo) return false;
    const role = rSnap.data().role;
    if (role === 'gestor') return true;
    if (role !== 'funcionario') return false;
    const sysSnap = await getDoc(doc(db, 'sistema_usuarios', uid));
    if (!sysSnap.exists() || sysSnap.data().bloqueado) return false;
    return true;
  } catch(e) {
    return false; // FAIL CLOSED
  }
}

export async function verificarAcessoModulo(db, uid, modulo) {
  try {
    const rSnap = await getDoc(doc(db, 'users', uid));
    if (!rSnap.exists() || !rSnap.data().ativo) return false;
    const role = rSnap.data().role;
    if (role === 'gestor') return true; // gestor: acesso a qualquer módulo (backward compat)
    if (role !== 'funcionario') return false;
    const sysSnap = await getDoc(doc(db, 'sistema_usuarios', uid));
    if (!sysSnap.exists() || sysSnap.data().bloqueado) return false;
    const sys = sysSnap.data();
    return sys.admin === true || (Array.isArray(sys.modulos) && sys.modulos.includes(modulo));
  } catch(e) {
    return false; // FAIL CLOSED
  }
}
