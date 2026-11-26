'use strict';
// PLANEJAMENTO DE COMPRA — callable `planejamentoComprasAtualizar`: SOMENTE gestor com módulo Estoque (ou administrador), não bloqueado
// (o mesmo critério das Rules para custo). Payload estrito { forcar?: boolean }. Resposta sem custo, preço, nome ou fornecedor.
const { HttpsError } = require('firebase-functions/v2/https');
const { exigirNaoBloqueado } = require('./usuarioOperacional');
const B = require('./compras/simuladorBase');

const negar = () => new HttpsError('permission-denied', 'Exclusivo da gestão com o módulo Estoque.');

async function exigirGestaoDeCusto(db, uid) {
  const u = await db.collection('users').doc(uid).get(), perfil = u.exists ? u.data() : null;
  if (!perfil || perfil.role !== 'gestor' || perfil.ativo !== true) throw negar();
  const sis = await exigirNaoBloqueado(db, uid);
  if (!sis || !(sis.admin === true || (Array.isArray(sis.modulos) && sis.modulos.includes('estoque')))) throw negar();
}

async function handler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data === null || request.data === undefined ? {} : request.data;
  if (typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => k !== 'forcar') || (d.forcar !== undefined && typeof d.forcar !== 'boolean')) throw new HttpsError('invalid-argument', 'Pedido inválido.');
  const db = opts.db || require('firebase-admin').firestore();
  await exigirGestaoDeCusto(db, request.auth.uid);
  try {
    const r = await B.atualizarBase(db, { forcar: d.forcar === true, ...(opts.agora ? { agora: opts.agora() } : {}) });
    (opts.log || console).log(JSON.stringify({ evento: 'planejamento_compras_atualizar', ...r }));
    return r;
  } catch (e) {
    const codigo = require('./compras/execucao').sanitizarErro(e);
    (opts.log || console).log(JSON.stringify({ evento: 'planejamento_compras_atualizar', status: 'FALHOU', erro: codigo }));
    throw new HttpsError('internal', 'Não foi possível atualizar a base agora. A base anterior foi mantida.');
  }
}

module.exports = { handler, exigirGestaoDeCusto };
