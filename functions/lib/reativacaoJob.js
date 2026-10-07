'use strict';
/**
 * B3 — job diário de reativação (06:00 America/Fortaleza). PREPARADO E INATIVO: NÃO é exportado por index.js e não há agendamento.
 * FORCAR_DRY = true é trava de código: mesmo com carteira_comercial_config/reativacao.modo='ATIVO' o job NÃO escreve. Para ativar,
 * o proprietário autoriza, a trava é removida em commit próprio e o agendador é criado (fora da B3).
 */
const R = require('./reativacao120'); const OPS = require('./reativacaoOps'); const { carregarContexto } = require('./reativacaoContexto');
const FORCAR_DRY = true;
const REF_CONFIG = ['carteira_comercial_config', 'reativacao'];

async function executarReativacaoDiaria(store, FieldValue, { hoje, agoraIso, forcarDry = FORCAR_DRY, conflitosGcExtra, incluirSemCarteira = false }) {
  const cfg = await store.doc(REF_CONFIG.join('/')).get(); const modo = cfg.exists ? cfg.data().modo : 'DESLIGADO';
  if (modo === 'DESLIGADO') return { status: 'DESLIGADO' };
  const ctx = await carregarContexto(store, { hoje, conflitosGcExtra });
  const plano = R.planejarLiberacao({ hoje, carteiras: ctx.carteiras, semCarteira: ctx.semCarteira, vendasPorCliente: ctx.vendasPorCliente, vend: ctx.vend, conflitosGc: ctx.conflitosGc,
    naoContatar: ctx.naoContatar, cooldowns: ctx.cooldowns, followUps: ctx.followUps, reservasExistentes: ctx.reservasExistentes, devolucoes: ctx.devolucoes, incluirSemCarteira });
  if (forcarDry === true || modo !== 'ATIVO') return { status: 'DRY', modo, plano, fontes: ctx.fontes };
  const criadas = []; for (const it of plano.liberar) {
    const r = await OPS.liberarReserva(store, FieldValue, { chave: it.chave, portfolioId: it.portfolioId, ciclo: it.ciclo, tipo: it.tipo, ownerUid: it.ownerUid, destinoUid: it.destinoUid, liberadoEm: hoje, prioridade: it.prioridade, agoraIso });
    criadas.push({ chave: it.chave, repetido: r.repetido });
  }
  const expiradas = await OPS.expirarReservas(store, hoje, FieldValue);
  return { status: 'ATIVO', criadas: criadas.filter(c => !c.repetido).length, repetidas: criadas.filter(c => c.repetido).length, expiradas, plano: { ...plano, liberar: undefined } };
}
module.exports = { executarReativacaoDiaria, FORCAR_DRY, REF_CONFIG };
