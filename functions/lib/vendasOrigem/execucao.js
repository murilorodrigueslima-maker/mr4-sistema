'use strict';
/**
 * Uma execução da reconciliação (chamada pelo Job do sync, dentro da trava compartilhada, DEPOIS dos blocos).
 *   DESLIGADO (padrão) → 1 leitura de documento e nada mais.
 *   SOMBRA             → observa e registra candidatas/evidências nas coleções próprias; nenhum indicador muda.
 *   APLICAR            → além disso, aplica as confirmadas com observação fresca nesta execução.
 * Reversões (a venda reapareceu) são feitas em SOMBRA e APLICAR: só devolvem dados ao estado original.
 */
const R = require('./regras');
const L = require('./leitura');
const P = require('./persistencia');
const C = require('../compras/canonico');
const { codigoSeguro } = require('../estoqueReconciliacao');
const S360 = require('../sync360');

const H = 3600000;
const TRAVA_TTL_MS = 15 * 60000;
const DIAS_RECHECAR_APLICADA = 30;
const refEstado = (db, id) => db.collection(R.COLECOES.estado).doc(id);

async function adquirir(db, detentor, agoraMs) {
  const ref = refEstado(db, 'lease');
  return db.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : null;
    if (d && Number(d.expiraEm) > agoraMs && d.detentor !== detentor) return false;
    tx.set(ref, { detentor, adquiridaEm: agoraMs, expiraEm: agoraMs + TRAVA_TTL_MS });
    return true;
  });
}
async function liberar(db, detentor) {
  try {
    const ref = refEstado(db, 'lease');
    await db.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists && s.data().detentor === detentor) tx.set(ref, { ...s.data(), expiraEm: 0 }); });
  } catch (_) { /* o vencimento recupera */ }
}

/**
 * @param {object} p
 *   db           Firestore
 *   criarLeitor  ({ maxRequisicoes, pausaMs }) → leitor GC (criarLeitorGc)
 *   agoraMs, runId
 *   ignorarIntervalo
 */
async function executar({ db, criarLeitor, agoraMs = Date.now(), runId, ignorarIntervalo = false }) {
  const cfgSnap = await db.collection(R.COLECOES.config).doc(R.DOC_CONFIG).get();
  const cfg = R.lerConfig(cfgSnap.exists ? cfgSnap.data() : null);
  if (cfg.modo === 'DESLIGADO') return { status: 'DESLIGADO', modo: cfg.modo };
  const params = cfg.params;
  const lerEstado = async () => { const s = await refEstado(db, R.DOC_CONFIG).get(); return s.exists ? s.data() : {}; };
  const cedo = e => !ignorarIntervalo && !!e.ultimaDeteccaoEm && agoraMs - e.ultimaDeteccaoEm < params.intervaloHoras * H;
  if (cedo(await lerEstado())) return { status: 'AGUARDANDO_INTERVALO', modo: cfg.modo };
  if (!(await adquirir(db, runId, agoraMs))) return { status: 'OUTRA_EXECUCAO', modo: cfg.modo };
  let est;
  try { est = await lerEstado(); } catch (e) { await liberar(db, runId); throw e; }
  if (cedo(est)) { await liberar(db, runId); return { status: 'AGUARDANDO_INTERVALO', modo: cfg.modo }; }   // outra execução terminou enquanto esta pedia a trava

  const resumo = { status: 'OK', modo: cfg.modo, motivoModo: cfg.motivo, profunda: false, anomalia: null, observacoes: {}, confirmadas: 0, aplicadas: 0, retidasCarteira: 0, revertidas: 0, encerradas: 0, erros: [], requisicoesGc: 0, leiturasEspelho: 0, recalculo: null };
  const ctx = { agoraMs, runId };
  let leitor = null;
  try {
    resumo.profunda = !est.ultimaProfundaEm || agoraMs - est.ultimaProfundaEm >= params.intervaloProfundoHoras * H;
    const hoje = C.dataComercial(new Date(agoraMs));
    const janela = { inicio: C.somarDias(hoje, -(resumo.profunda ? params.janelaProfundaDias : params.janelaRecenteDias)), fim: hoje };
    const abertas = await P.listarAbertas(db);
    // invalidações antigas e fora do período deixam de ser relidas (a candidata continua registrada e ativa)
    for (const [id, c] of abertas) if (c.invalidacaoAtiva && agoraMs - (c.aplicadaEm || 0) > DIAS_RECHECAR_APLICADA * 24 * H && !(c.dataVenda >= janela.inicio)) abertas.delete(id);
    const { conhecidas, uso } = await L.lerConhecidas(db, { ...janela, extras: [...abertas.keys()] });
    resumo.leiturasEspelho = uso.leiturasEspelho;

    for (const [id, c] of [...abertas]) {
      const e = conhecidas.get(id);
      if (c.invalidacaoAtiva) {
        // o sync regravou a venda como ativa (ela voltou na lista dele) ⇒ a marca caiu: registra a reversão
        if (c.crm === 'APLICADA' && e && e.espelho && L.ativaNoEspelho(e.espelho)) {
          const x = await P.reverter(db, id, { ...ctx, motivo: 'ESPELHO_REGRAVADO_PELO_SYNC' });
          if (x.status === 'REVERTIDA') resumo.revertidas++;
          abertas.delete(id);
        }
      } else if (uso.baseDisponivel && (!e || !e.ativa)) {
        if (await P.encerrar(db, id, R.ESTADOS.RESOLVIDA_PELO_SYNC, { ...ctx, motivo: 'ESPELHO_E_BASE_JA_NAO_CONTAM' })) resumo.encerradas++;
        abertas.delete(id);
      }
    }

    leitor = criarLeitor({ maxRequisicoes: params.maxRequisicoes, pausaMs: params.pausaMs });
    const d = await L.detectar({ leitor, conhecidas, abertas, janela, agoraMs, params, detalharAplicadas: resumo.profunda, detalharConfirmadas: resumo.profunda || cfg.modo === 'APLICAR' });
    resumo.anomalia = d.anomalia; resumo.erros = [...new Set(d.erros)]; resumo.contagens = d.contagens;
    if (!d.integra) resumo.status = 'ANOMALIA';

    const aAplicar = [];
    for (const o of d.observacoes) {
      resumo.observacoes[o.classe] = (resumo.observacoes[o.classe] || 0) + 1;
      const x = await P.registrarObservacao(db, o, { ...ctx, params, modo: cfg.modo });
      if (x.acao === 'REVERTER') { const y = await P.reverter(db, o.vendaId, { ...ctx, motivo: 'EVIDENCIA_' + o.classe }); if (y.status === 'REVERTIDA') resumo.revertidas++; continue; }
      if (!d.integra || !R.CONFIRMAVEIS.includes(o.classe) || !x.cand || x.cand.classe !== o.classe) continue;
      if (x.cand.estado === R.ESTADOS.CONFIRMADA) {
        resumo.confirmadas++;
        await P.registrarImpacto(db, o.vendaId, ctx);
        aAplicar.push(o.vendaId);
      } else if (x.cand.estado === R.ESTADOS.APLICADA && x.cand.crm === 'RETIDA_CARTEIRA' && cfg.liberadasCarteira.has(o.vendaId)) aAplicar.push(o.vendaId);
    }
    if (cfg.modo === 'APLICAR') for (const id of aAplicar) {
      const y = await P.aplicar(db, id, ctx);
      if (y.status === 'APLICADA') { resumo.aplicadas++; if (y.crm === 'RETIDA_CARTEIRA') resumo.retidasCarteira++; }
    }
    resumo.recalculo = await P.recalcularPendentes(db, { ...ctx, hoje: S360.calcularDataReferencia(new Date(agoraMs)),
      obterProdutosPorId: async () => S360.buildProdutosPorId((await leitor.lista('/produtos', { ativo: 1 })).itens) });
    resumo.requisicoesGc = leitor.uso.usadas;
    await refEstado(db, R.DOC_CONFIG).set({ ...est, ultimaTentativaEm: agoraMs, ultimaDeteccaoEm: agoraMs, ...(resumo.profunda && d.integra ? { ultimaProfundaEm: agoraMs } : {}), ultimaExecucao: resumo });
    return resumo;
  } catch (e) {
    const falha = { ...resumo, status: 'FALHA', codigo: codigoSeguro(e), requisicoesGc: leitor ? leitor.uso.usadas : 0 };
    try { await refEstado(db, R.DOC_CONFIG).set({ ...est, ultimaTentativaEm: agoraMs, ultimaExecucao: falha }); } catch (_) { /* melhor esforço */ }
    return falha;
  } finally { await liberar(db, runId); }
}

module.exports = { TRAVA_TTL_MS, DIAS_RECHECAR_APLICADA, executar, adquirir, liberar };
