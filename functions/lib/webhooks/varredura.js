'use strict';
/**
 * VARREDURA periódica do webhook (WHK-01, WHK-03 e borda final do gatilho do Financeiro). Roda no pacote do webhook, a cada 10 min.
 *   DESLIGADO / RECEPCAO / configuração ausente ou ilegível : 1 leitura (a configuração) e NADA mais.
 *   SOMBRA : repete as conferências pendentes (só consulta o GestãoClick; nenhum efeito operacional) + monitor.
 *   ATIVO  : além disso, reaplica efeitos não confirmados (processador interrompido) e retoma a pendência do Financeiro.
 * Alertas = log estruturado `WEBHOOK_GC_ALERTA` (Cloud Logging → política de alerta); só códigos, contagens e horas.
 * Nada é apagado.
 */
const R = require('./receptor');
const G = require('../financeiroGatilho');
const RF = require('../refreshFila');

const MIN = 60000, H = 60 * MIN;
const ESPERA_EFEITO_MS = 5 * MIN, MAX_TENTATIVAS_EFEITO = 5, LIMITE = 25;
const ATRASADO_MS = 30 * MIN, FINANCEIRO_ATRASADO_MS = 4 * H, REPETICAO_ALERTA_MS = 6 * H, ORCAMENTO_SOMBRA_MS = 150000;
const DOC_MONITOR = 'monitor';

/** Efeito operacional de UM evento (só ATIVO). Marca `efeito: APLICADO` apenas quando nada ficou por registrar. */
async function aplicarEfeito({ db, modo, id, evDoc, dispararJob, dispararFinanceiro, agoraMs = Date.now() }) {
  const ef = await RF.aplicarModo({ db, modo, evento: evDoc.evento, eventoMs: evDoc.recebido_ms, dispararJob, dispararFinanceiro, agoraMs });
  if (modo === 'ATIVO' && evDoc.efeito === 'PENDENTE' && ef.financeiroN1 !== 'FALHA') await db.collection(R.COL_EVENTOS).doc(id).set({ efeito: 'APLICADO', efeito_ms: agoraMs }, { merge: true });
  return ef;
}

/** Avisos recebidos em ATIVO cujo efeito não foi confirmado (processador caiu, transação falhou, gatilho não disparou). */
async function recuperarEfeitos({ db, dispararJob, dispararFinanceiro, agoraMs }) {
  const snap = await db.collection(R.COL_EVENTOS).where('efeito', '==', 'PENDENTE').limit(LIMITE).get();
  const r = { recuperados: 0, atrasados: 0, falhas: 0 }; let marcouBlocos = false;
  for (const doc of snap.docs) {
    const e = doc.data(), idade = agoraMs - (e.recebido_ms || 0);
    if (idade < ESPERA_EFEITO_MS) continue;                                   // o processador ainda pode estar trabalhando
    try {
      const n = (e.efeito_tentativas || 0) + 1; const ref = db.collection(R.COL_EVENTOS).doc(doc.id);
      if (n > MAX_TENTATIVAS_EFEITO) { await ref.set({ efeito: 'FALHA' }, { merge: true }); r.falhas++; continue; }
      await ref.set({ efeito_tentativas: n }, { merge: true });
      const ef = await aplicarEfeito({ db, modo: 'ATIVO', id: doc.id, evDoc: e, dispararJob: async () => { marcouBlocos = true; }, dispararFinanceiro, agoraMs });
      if (ef.financeiroN1 === 'FALHA') { if (idade >= ATRASADO_MS) r.atrasados++; } else r.recuperados++;
    } catch (_) { if (idade >= ATRASADO_MS) r.atrasados++; }
  }
  if (marcouBlocos) { try { await dispararJob(); } catch (_) { /* blocos seguem marcados; o sync de 2 h reconcilia */ } }   // um disparo por varredura
  return r;
}

/** Condições persistentes são avisadas quando mudam e repetidas a cada 6 h; ocorrências pontuais, sempre. */
async function monitorar({ db, modo, config, resumo, logger, agoraMs }) {
  const ultimo = await db.collection(R.COL_EVENTOS).orderBy('recebido_ms', 'desc').limit(1).get();
  const ultimoEventoMs = ultimo.docs.length ? ultimo.docs[0].data().recebido_ms : null;
  const desde = Date.parse((config && config.atualizadoEm) || '');               // carência após ligar o modo
  const referencia = Math.max(ultimoEventoMs || 0, Number.isFinite(desde) ? desde : 0) || null;
  const silencio = R.avaliarSilencio({ modo, ultimoEventoMs: referencia, agoraMs });

  const motivos = [], pontuais = [];
  const { sombra, efeitos, financeiro } = resumo;
  if (silencio.alerta) motivos.push(ultimoEventoMs === null ? 'NUNCA_RECEBEU' : silencio.motivo);
  if (sombra && sombra.atrasados > 0) motivos.push('SOMBRA_PENDENTES_ATRASADOS');
  if (sombra && sombra.falhas > 0) pontuais.push('SOMBRA_FALHA_DEFINITIVA');
  if (sombra && sombra.divergentes > 0) pontuais.push('LOJA_DIVERGENTE');
  if (efeitos && efeitos.atrasados > 0) motivos.push('EFEITO_PENDENTE_ATRASADO');
  if (efeitos && efeitos.falhas > 0) pontuais.push('EFEITO_FALHA_DEFINITIVA');
  const f = financeiro && financeiro.estado;
  if (f && f.pendente) {
    if (financeiro.acao === 'ESGOTADO') motivos.push('FINANCEIRO_TENTATIVAS_ESGOTADAS');
    if (financeiro.acao === 'TETO_DIARIO') motivos.push('FINANCEIRO_TETO_DIARIO');
    if (f.ultimoDisparoOk === false) motivos.push('FINANCEIRO_FALHA_DISPARO');
    if (Number.isFinite(f.pendenteDesdeMs) && agoraMs - f.pendenteDesdeMs >= FINANCEIRO_ATRASADO_MS) motivos.push('FINANCEIRO_PENDENTE_ATRASADO');
  }
  for (const etapa of resumo.erros) motivos.push('ERRO_ETAPA_' + etapa);

  const contagens = { sombraAtrasados: sombra ? sombra.atrasados : 0, sombraFalhas: sombra ? sombra.falhas : 0, lojaDivergente: sombra ? sombra.divergentes : 0, efeitosAtrasados: efeitos ? efeitos.atrasados : 0, efeitosFalhas: efeitos ? efeitos.falhas : 0, tentativasFinanceiro: f ? f.tentativas || 0 : 0, horasSemAviso: referencia ? Math.round((agoraMs - referencia) / H * 10) / 10 : null };
  const emitir = (nivel, tipo, lista) => logger[nivel]('WEBHOOK_GC_ALERTA', { alerta: 'WEBHOOK_GC', tipo, nivel, modo, motivos: lista, ...contagens });
  const nivelDe = l => l.some(m => /SILENCIO|NUNCA|FALHA|ESGOTAD|DIVERGENTE|ERRO/.test(m)) ? 'error' : 'warn';
  if (pontuais.length) emitir(nivelDe(pontuais), 'OCORRENCIA', pontuais);

  const ref = db.collection(R.COL_STATUS).doc(DOC_MONITOR); const s = await ref.get(); const anterior = s.exists ? s.data() : {};
  const assinatura = motivos.slice().sort().join(',');
  if (assinatura && (assinatura !== anterior.assinatura || agoraMs - (anterior.notificadoMs || 0) >= REPETICAO_ALERTA_MS)) {
    emitir(nivelDe(motivos), 'CONDICAO', motivos); await ref.set({ assinatura, notificadoMs: agoraMs });
  } else if (!assinatura && anterior.assinatura) { emitir('info', 'RECUPERADO', []); await ref.set({ assinatura: '', notificadoMs: agoraMs }); }
  return { motivos, pontuais };
}

async function executarVarredura({ db, buscar, dispararJob, dispararFinanceiro, logger, agora = () => Date.now() }) {
  let config = null;
  try { const s = await db.collection(R.COL_CONFIG).doc(R.DOC_CONFIG).get(); config = s.exists ? s.data() : null; }   // leitura direta (sem cache)
  catch (_) { logger.warn('WEBHOOK_GC_VARREDURA', { erro: 'CONFIG_ILEGIVEL' }); return { modo: 'DESLIGADO', acao: 'NADA' }; }
  const modo = config && R.MODOS.includes(config.modo) ? config.modo : 'DESLIGADO';
  if (modo !== 'SOMBRA' && modo !== 'ATIVO') return { modo, acao: 'NADA' };

  const resumo = { sombra: null, efeitos: null, financeiro: null, erros: [] };
  const etapa = async (nome, fn) => { try { return await fn(); } catch (e) { resumo.erros.push(nome); logger.error('WEBHOOK_GC_VARREDURA', { etapa: nome, erro: String((e && e.code) || (e && e.name) || 'ERRO').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) }); return null; } };
  if (modo === 'ATIVO') {   // primeiro o que é barato e crítico; as consultas da sombra (mais lentas) ficam por último
    resumo.efeitos = await etapa('EFEITOS', () => recuperarEfeitos({ db, dispararJob, dispararFinanceiro, agoraMs: agora() }));
    resumo.financeiro = await etapa('FINANCEIRO', () => G.varrer({ db, disparar: dispararFinanceiro, agoraMs: agora() }));
  }
  resumo.sombra = await etapa('SOMBRA', () => R.reprocessarPendentes({ db, buscar, agora, limite: LIMITE, atrasoMs: ATRASADO_MS, orcamentoMs: ORCAMENTO_SOMBRA_MS }));
  const monitor = await etapa('MONITOR', () => monitorar({ db, modo, config, resumo, logger, agoraMs: agora() }));
  const saida = { modo, acao: 'VARRIDO', sombra: resumo.sombra, efeitos: resumo.efeitos, financeiro: resumo.financeiro ? resumo.financeiro.acao : null, erros: resumo.erros, motivos: monitor ? monitor.motivos : [] };
  logger.info('WEBHOOK_GC_VARREDURA', saida);
  return saida;
}

module.exports = { executarVarredura, aplicarEfeito, recuperarEfeitos, monitorar, ESPERA_EFEITO_MS, MAX_TENTATIVAS_EFEITO, REPETICAO_ALERTA_MS, DOC_MONITOR };
