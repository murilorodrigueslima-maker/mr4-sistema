'use strict';
/**
 * MATRIZ PERMANENTE de acesso (perfil × coleção) das Firestore Rules.
 * Política: (1) usuário bloqueado/inativo NÃO acessa nada, independentemente do cargo; (2) gestor ativo lê pela visão de gestão (isGestor);
 * (3) funcionário só por módulo explícito (dual-role); (4) `admin=true` é atalho de módulo só onde a regra usa temAcessoModulo;
 * (5) fila_comercial_gestao e clientes/conversas/painel_config NÃO têm atalho admin para dual-role.
 * Os valores esperados vêm da POLÍTICA (comentários das regras, commits 7f462a9/fa488bd/S4) — não foram ajustados para "fazer passar".
 * R1: o bloqueio vale também para role=gestor.
 * Executa com o emulador do Firestore (node scripts/testes/rodar.js).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const RULES = readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
let env;

// perfil: users/{uid} + sistema_usuarios/{uid} (opcional)
const PERFIS = {
  anonimo:                          null,
  'gestor ativo, módulos=[ponto]':  { u: { role: 'gestor', ativo: true }, s: { modulos: ['ponto'], admin: false } },
  'gestor ativo, módulos=[]':       { u: { role: 'gestor', ativo: true }, s: { modulos: [], admin: false } },
  'gestor ativo, admin=true':       { u: { role: 'gestor', ativo: true }, s: { modulos: [], admin: true } },
  'gestor ativo, SEM sistema_usuarios': { u: { role: 'gestor', ativo: true } },
  'gestor INATIVO (users.ativo=false)': { u: { role: 'gestor', ativo: false }, s: { modulos: ['ponto'], admin: true } },
  'gestor BLOQUEADO (admin=true, módulos=[ponto])': { u: { role: 'gestor', ativo: true }, s: { modulos: ['ponto'], admin: true, bloqueado: true } },
  'gestor BLOQUEADO (módulos=[])':  { u: { role: 'gestor', ativo: true }, s: { modulos: [], admin: false, bloqueado: true } },
  'gestor ativo, bloqueado=false explícito': { u: { role: 'gestor', ativo: true }, s: { modulos: ['ponto'], admin: false, bloqueado: false } },
  'dual-role admin=true':           { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-A' }, s: { modulos: [], admin: true } },
  'dual-role módulos=[ponto]':      { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-B' }, s: { modulos: ['ponto'], admin: false } },
  'dual-role módulos=[demandas]':   { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-C' }, s: { modulos: ['demandas'], admin: false } },
  'dual-role fila-comercial-gestao': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-D' }, s: { modulos: ['fila-comercial-gestao'], admin: false } },
  'vendedor fila-comercial-operar': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-E' }, s: { modulos: ['fila-comercial-operar'], admin: false } },
  'dual-role admin=true BLOQUEADO': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-F' }, s: { modulos: ['ponto', 'demandas'], admin: true, bloqueado: true } },
  'dual-role módulos=[ponto] BLOQUEADO': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-G' }, s: { modulos: ['ponto'], admin: false, bloqueado: true } },
  'dual-role INATIVO':              { u: { role: 'funcionario', ativo: false, funcionarioId: 'F-H' }, s: { modulos: ['ponto'], admin: true } },
  'funcionário comum (sem perfil)': { u: { role: 'funcionario', ativo: true, funcionarioId: 'F-I' } },
  display:                          { u: { role: 'display', ativo: true } },
  'role desconhecida':              { u: { role: 'desconhecido', ativo: true } },
};
// coleção → [col, doc]
const ALVOS = {
  'registros(outro func)': ['registros', 'r1'], 'fila_comercial/snapshot': ['fila_comercial', 'snapshot'], 'fila_comercial/{doc}': ['fila_comercial', 'outro'],
  interacoes_fila: ['interacoes_fila', 'i1'], fila_comercial_gestao: ['fila_comercial_gestao', 'g1'], clientes: ['clientes', 'c1'],
  'sistema_usuarios(outro)': ['sistema_usuarios', 'ALVO'], painel_config: ['painel_config', 'p1'], demandas: ['demandas', 'd1'], gc_audit: ['gc_audit', 'a1'],
};
const L = true, N = false;
// ordem das colunas: registros, snapshot, fila{doc}, interacoes, fila_gestao, clientes, sistema_usuarios, painel_config, demandas, gc_audit
const ESPERADO = {
  anonimo:                                  [N, N, N, N, N, N, N, N, N, N],
  'gestor ativo, módulos=[ponto]':          [L, L, L, L, L, L, L, L, L, L],
  'gestor ativo, módulos=[]':               [N, L, L, L, L, L, L, L, L, L],   // ponto exige módulo até do gestor
  'gestor ativo, admin=true':               [L, L, L, L, L, L, L, L, L, L],
  'gestor ativo, SEM sistema_usuarios':     [N, L, L, L, L, L, L, L, L, L],
  'gestor INATIVO (users.ativo=false)':     [N, N, N, N, N, N, N, N, N, N],
  'gestor BLOQUEADO (admin=true, módulos=[ponto])': [N, N, N, N, N, N, N, N, N, N],   // R1: bloqueio vale para gestor
  'gestor BLOQUEADO (módulos=[])':          [N, N, N, N, N, N, N, N, N, N],
  'gestor ativo, bloqueado=false explícito': [L, L, L, L, L, L, L, L, L, L],
  'dual-role admin=true':                   [L, L, L, L, N, N, N, N, L, N],   // atalho admin só onde há temAcessoModulo; sem atalho em gestao/clientes/painel_config
  'dual-role módulos=[ponto]':              [L, N, N, N, N, N, N, N, N, N],
  'dual-role módulos=[demandas]':           [N, N, N, N, N, N, N, N, L, N],
  'dual-role fila-comercial-gestao':        [N, L, L, L, L, N, N, N, N, N],
  'vendedor fila-comercial-operar':         [N, L, N, N, N, N, N, N, N, N],   // só o snapshot
  'dual-role admin=true BLOQUEADO':         [N, N, N, N, N, N, N, N, N, N],
  'dual-role módulos=[ponto] BLOQUEADO':    [N, N, N, N, N, N, N, N, N, N],
  'dual-role INATIVO':                      [N, N, N, N, N, N, N, N, N, N],
  'funcionário comum (sem perfil)':         [N, N, N, N, N, N, N, N, N, N],
  display:                                  [N, N, N, N, N, N, N, N, N, N],
  'role desconhecida':                      [N, N, N, N, N, N, N, N, N, N],
};

const uidDe = nome => 'u' + Object.keys(PERFIS).indexOf(nome);
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'mr4-matriz-bloqueio', firestore: { rules: RULES, ...require('./_ambiente/emulador').firestore() } });
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore();
    for (const [n, p] of Object.entries(PERFIS)) { if (!p) continue; await d.collection('users').doc(uidDe(n)).set(p.u); if (p.s) await d.collection('sistema_usuarios').doc(uidDe(n)).set(p.s); }
    await d.collection('registros').doc('r1').set({ funcId: 'F-OUTRO', data: '2026-11-01' });
    for (const [col, id] of [['fila_comercial', 'snapshot'], ['fila_comercial', 'outro'], ['interacoes_fila', 'i1'], ['fila_comercial_gestao', 'g1'], ['clientes', 'c1'], ['painel_config', 'p1'], ['demandas', 'd1'], ['gc_audit', 'a1']]) await d.collection(col).doc(id).set({ x: 1 });
    await d.collection('sistema_usuarios').doc('ALVO').set({ modulos: [], admin: false });
  });
});
afterAll(async () => { if (env) await env.cleanup(); });

describe('matriz perfil × coleção (leitura)', () => {
  const linhas = [];
  for (const nome of Object.keys(PERFIS)) Object.keys(ALVOS).forEach((alvo, i) => linhas.push([nome, alvo, ESPERADO[nome][i]]));
  test.each(linhas)('%s → %s: %s', async (nome, alvo, permitido) => {
    const [col, id] = ALVOS[alvo];
    const db = PERFIS[nome] ? env.authenticatedContext(uidDe(nome)).firestore() : env.unauthenticatedContext().firestore();
    await (permitido ? assertSucceeds : assertFails)(db.collection(col).doc(id).get());
  });
});

describe('cobertura da matriz', () => {
  test('todas as linhas têm uma expectativa para cada coleção (sem buracos)', () => {
    for (const n of Object.keys(PERFIS)) expect({ n, cols: (ESPERADO[n] || []).length }).toEqual({ n, cols: Object.keys(ALVOS).length });
  });
  test('qualquer perfil BLOQUEADO ou INATIVO (inclusive gestor) é negado em TODAS as coleções', () => {
    for (const n of Object.keys(PERFIS).filter(k => /BLOQUEADO|INATIVO/.test(k))) expect({ n, algumPermitido: ESPERADO[n].some(Boolean) }).toEqual({ n, algumPermitido: false });
  });
});
