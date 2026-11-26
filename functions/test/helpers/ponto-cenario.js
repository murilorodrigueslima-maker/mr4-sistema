'use strict';
/** Cenário FICTÍCIO comum aos testes de integridade do ponto (nenhum dado real). */
const A_UIDS = { G: 'c-gestor', AD: 'c-admin', DR: 'c-dual', E: 'c-func', E2: 'c-func2', BL: 'c-func-bloq', DISPLAY: 'c-tv' };
const F = { AD: 'fx-admin', DR: 'fx-dual', E: 'fx-func', E2: 'fx-func2', BL: 'fx-bloq' };
const DIA = '2026-09-28', MES_FECHADO = '2026-08';
const NOME = { [F.AD]: 'Alberto Fictício', [F.DR]: 'Dora Fictícia', [F.E]: 'Elisa Fictícia', [F.E2]: 'Enzo Fictício', [F.BL]: 'Breno Fictício' };

async function semear(d) {
  const { G, AD, DR, E, E2, BL, DISPLAY } = A_UIDS;
  const u = (uid, x) => d.doc('users/' + uid).set({ ativo: true, email: uid + '@exemplo.test', ...x });
  await u(G, { role: 'gestor' });
  await u(AD, { role: 'gestor', funcionarioId: F.AD });                 // administrador real que também bate ponto
  await u(DR, { role: 'funcionario', funcionarioId: F.DR });            // dual-role com módulo ponto
  await u(E, { role: 'funcionario', funcionarioId: F.E });
  await u(E2, { role: 'funcionario', funcionarioId: F.E2 });
  await u(BL, { role: 'funcionario', funcionarioId: F.BL });
  await u(DISPLAY, { role: 'display' });
  const s = (uid, x) => d.doc('sistema_usuarios/' + uid).set({ email: uid + '@exemplo.test', ...x });
  await s(G, { modulos: ['ponto'], admin: false });
  await s(AD, { modulos: [], admin: true });
  await s(DR, { modulos: ['ponto'], admin: false });
  await s(BL, { modulos: [], admin: false, bloqueado: true });
  for (const f of Object.values(F)) await d.doc('funcionarios/' + f).set({ nome: NOME[f], cargo: 'Teste', jornada: '8', modalidade: 'PRESENCIAL', inicioBancoHoras: '2026-08-01' });
  const reg = (f, data, tipo, hora) => d.doc(`registros/${f}_${data}_${tipo}`).set({ id: `${f}_${data}_${tipo}`, funcId: f, funcNome: NOME[f], data, tipo, hora: hora + ':00', criadoEm: new Date(data + 'T11:00:00Z') });
  for (const f of [F.E, F.DR, F.AD]) {
    await reg(f, DIA, 'entrada', '08:05'); await reg(f, DIA, 'saida_almoco', '12:00'); await reg(f, DIA, 'retorno_almoco', '13:00'); await reg(f, DIA, 'saida', '17:00');
  }
  await d.doc(`creditos_jornada/cred_${F.E}_2026-09-25`).set({ id: `cred_${F.E}_2026-09-25`, funcId: F.E, funcNome: NOME[F.E], data: '2026-09-25', minutos: 480, motivo: 'Atestado médico', criadoEm: '2026-09-25T12:00:00Z' });
  const j = (id, f, x) => d.doc('justificativas/' + id).set({ id, funcId: f, funcNome: NOME[f], data: DIA, motivo: 'Ponto não batido', descricao: 'Pedido original', tipoPonto: 'saida', horarioPonto: '17:10', status: 'pendente', lancadoPorGestor: false, criadoEm: DIA + 'T20:00:00Z', ...x });
  await j('j-pend', F.E, {});
  await j('j-aprov', F.E, { motivo: 'Atestado médico', tipoPonto: null, horarioPonto: null, status: 'aprovado', respondidoPorUid: G, respondidoPorEmail: G + '@exemplo.test', respondidoEm: new Date() });
  await j('j-dual', F.DR, {});
  await d.doc(`ponto_meses_protegidos/${F.E}_${MES_FECHADO}`).set({ funcId: F.E, mes: MES_FECHADO });
  const esp = (id, f, x) => d.doc('espelhos/' + id).set({ id, funcId: f, mes: '2026-09', versao: 1, versaoAnteriorId: null, versaoSucessoraId: null, assinado: false, assinaturaImg: null, assinadoEm: null, assinadoPor: null,
    snapshot: { totais: { saldo: 0 }, geradoEm: 'g1' }, hashSnapshot: 'hash-original', ...x });
  await esp('esp-aberto', F.E, {});
  await esp('esp-assinado', F.E, { mes: MES_FECHADO, assinado: true, status: 'assinado', assinaturaImg: 'data:image/png;base64,AAAA', assinadoEm: new Date(), assinadoPor: NOME[F.E], hashAssinado: 'hash-original' });
  await esp('esp-bloq', F.BL, {});
  await esp('esp-dual', F.DR, {});
}
module.exports = { A_UIDS, F, DIA, MES_FECHADO, NOME, semear };
