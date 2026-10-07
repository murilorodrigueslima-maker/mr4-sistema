'use strict';
/**
 * B3 — job diário de reativação (06:00 America/Fortaleza). PREPARADO E INATIVO: NÃO é exportado por index.js e não há agendamento.
 * FORCAR_DRY = true é trava de código: mesmo com carteira_comercial_config/reativacao.modo='ATIVO' o job NÃO escreve. Para ativar,
 * o proprietário autoriza, a trava é removida em commit próprio e o agendador é criado (fora da B3).
 */
const R = require('./reativacao120'); const OPS = require('./reativacaoOps'); const { carregarContexto } = require('./reativacaoContexto');
const FORCAR_DRY = false;      // B3.3: trava removida — a segurança passa a ser a CONFIGURAÇÃO (modo/motor) + disjuntor de saúde + kill switch (scripts/b3_desligar.js)
const REF_CONFIG = ['carteira_comercial_config', 'reativacao'];

async function executarReativacaoDiaria(store, FieldValue, { hoje, agoraIso, forcarDry = FORCAR_DRY, conflitosGcExtra, incluirSemCarteira = false, lookupNome = null }) {
  const cfgSnap = await store.doc(REF_CONFIG.join('/')).get(); const cfg = cfgSnap.exists ? cfgSnap.data() : {}; const modo = cfg.modo || 'DESLIGADO';
  if (modo === 'DESLIGADO') return { status: 'DESLIGADO' };
  if (modo === 'ATIVO' && !forcarDry) {                                              // saúde ANTES de qualquer escrita; violação desliga o motor e aborta
    const SA = require('./reativacaoSaude'); const h = await SA.verificarSaude(store, { cfg, desde: cfg.ativadoEm || null });
    if (!h.ok) { await SA.dispararDisjuntor(store, FieldValue, h.violacoes, { agoraIso, origem: 'JOB_DIARIO' }); return { status: 'DISJUNTOR', violacoes: h.violacoes }; }
    const MOTOR = require('./motorCarteira'); const m = MOTOR.lerMotor((await store.doc(MOTOR.REF.join('/')).get()).data()); if (m !== 'B3') return { status: 'MOTOR_NAO_B3', motor: m };
  }
  const ctx = await carregarContexto(store, { hoje, conflitosGcExtra });
  const plano = R.planejarLiberacao({ hoje, carteiras: ctx.carteiras, semCarteira: ctx.semCarteira, vendasPorCliente: ctx.vendasPorCliente, vend: ctx.vend, conflitosGc: ctx.conflitosGc,
    naoContatar: ctx.naoContatar, cooldowns: ctx.cooldowns, followUps: ctx.followUps, reservasExistentes: ctx.reservasExistentes, devolucoes: ctx.devolucoes, incluirSemCarteira: incluirSemCarteira && cfg.incluirSemCarteira === true, limitePorVendedor: Number.isFinite(cfg.limiteDiario) ? cfg.limiteDiario : undefined, maxAtivas: Number.isFinite(cfg.maxReservasAtivas) ? cfg.maxReservasAtivas : undefined });
  if (forcarDry === true || modo !== 'ATIVO') return { status: 'DRY', modo, plano, fontes: ctx.fontes };
  // B3.2 — nome correto do cliente (GestãoClick, GET, sanitizado: sem CPF/CNPJ); sem nome resolvido ⇒ NÃO libera hoje (tenta de novo no próximo ciclo)
  if (typeof lookupNome !== 'function') throw new Error('LOOKUP_NOME_OBRIGATORIO');
  const { resolverNomesSelecionados } = require('./filaNomes');
  const nomes = await resolverNomesSelecionados(plano.liberar.map(it => ({ ...it, gestaoClickId: it.id, nomeCliente: null })), { lookupNome, max: 40 });
  const semNome = []; const criadas = []; for (let i = 0; i < plano.liberar.length; i++) {
    const it = plano.liberar[i]; const nome = nomes.itens[i] && nomes.itens[i].nomeCliente;
    if (!nome) { semNome.push(it.id); continue; }
    const r = await OPS.liberarReserva(store, FieldValue, { chave: it.chave, portfolioId: it.portfolioId, ciclo: it.ciclo, tipo: it.tipo, ownerUid: it.ownerUid, destinoUid: it.destinoUid, liberadoEm: hoje, prioridade: it.prioridade, nomeCliente: nome, agoraIso, limiteDiario: Number.isFinite(cfg.limiteDiario) ? cfg.limiteDiario : undefined, maxAtivas: Number.isFinite(cfg.maxReservasAtivas) ? cfg.maxReservasAtivas : undefined });
    criadas.push({ chave: it.chave, repetido: r.repetido });
  }
  const expiradas = await OPS.expirarReservas(store, hoje, FieldValue);
  return { status: 'ATIVO', semNome: semNome.length, criadas: criadas.filter(c => !c.repetido).length, repetidas: criadas.filter(c => c.repetido).length, expiradas, plano: { ...plano, liberar: undefined } };
}
module.exports = { executarReativacaoDiaria, FORCAR_DRY, REF_CONFIG };
