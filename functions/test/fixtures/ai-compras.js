'use strict';
// Fixture SINTÉTICA do Agente de Compras: as visões REAIS do motor (montarSnapshot → compras_n0_view/compras_n0/meta) sobre produtos fictícios, num Firestore falso.
const F = require('./ai-agente');
const D = require('./compras-ui-dados');
const UID = { GER: 'c-ger', ADM: 'c-adm', FEST: 'c-fest', FCOMP: 'c-fcomp', GSEMEST: 'c-gsemest', CRM: 'c-crm', INAT: 'c-inat', BLOQ: 'c-bloq', GEST2: 'c-gest2' };
const AGORA = new Date('2026-09-28T16:00:00.000Z');          // 1 h depois da geração sintética (fresco)
function usuarios() {
  const u = {}, s = {};
  const add = (id, role, mods, x = {}) => { u[id] = { role, ativo: x.ativo !== false }; s[id] = { nome: 'Nome ' + id, modulos: mods, bloqueado: !!x.bloqueado, admin: !!x.admin }; };
  add(UID.GER, 'gestor', ['compras', 'estoque']); add(UID.GEST2, 'gestor', ['compras', 'estoque']); add(UID.ADM, 'funcionario', [], { admin: true }); add(UID.FEST, 'funcionario', ['estoque']); add(UID.FCOMP, 'funcionario', ['compras', 'estoque']);
  add(UID.GSEMEST, 'gestor', []); add(UID.CRM, 'funcionario', ['fila-comercial-operar']); add(UID.INAT, 'gestor', ['compras', 'estoque'], { ativo: false }); add(UID.BLOQ, 'gestor', ['compras', 'estoque'], { bloqueado: true });
  return { users: u, sistema_usuarios: s };
}
/** extras: nº de produtos sintéticos adicionais (cenário de referência ≈ 40 + extras). opts.sugestoes/custos permitem adulterar as visões. */
function montarDb(extras = 120, { alterar } = {}) {
  const d = D.dados(extras); const sug = JSON.parse(JSON.stringify(d.sugestoes)), cus = JSON.parse(JSON.stringify(d.custos)), meta = JSON.parse(JSON.stringify(d.sn.meta));
  if (alterar) alterar({ sug, cus, meta });
  const st = { ...usuarios(), compras_n0_view: { sugestoes: sug, custos: cus }, compras_n0: { meta } };
  return { db: F.criarDb(st), d, sug, cus, meta };
}
module.exports = { UID, AGORA, montarDb, usuarios, criarDb: F.criarDb, fetchModelo: F.fetchModelo };
