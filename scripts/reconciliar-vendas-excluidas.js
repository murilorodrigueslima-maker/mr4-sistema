#!/usr/bin/env node
'use strict';
// Vendas excluídas/canceladas na origem — validação e operação. Roda DENTRO do Cloud Run Job mr4-sync-job (argumentos sobrescritos).
//
//   SOMENTE LEITURA (padrão):
//     node scripts/reconciliar-vendas-excluidas.js [--validar] [--dias=60] [--max-requisicoes=120] [--pausa-ms=500]
//                                                  [--max-detalhes=30] [--vendas=ID+ID]
//     node scripts/reconciliar-vendas-excluidas.js --status
//   ESCRITA (sem --confirmar só mostra a prévia):
//     --definir-modo=DESLIGADO|SOMBRA|APLICAR --por=nome --confirmar
//     --liberar-carteira=ID+ID --por=nome --confirmar      libera o CRM de vendas retidas por vínculo de carteira
//     --reverter=ID+ID|todas  --por=nome --confirmar       devolve a venda aos cálculos e impede reaplicação
//
// Lógica em functions/lib/vendasOrigem. Termina com código 0 mesmo com erro (para o Job NÃO repetir as chamadas ao GestãoClick):
// confira a linha VEXC_FIM (campo ok).
const gcHttp = require('../functions/lib/gcHttp');
const R = require('../functions/lib/vendasOrigem/regras');
const P = require('../functions/lib/vendasOrigem/persistencia');
const V = require('../functions/lib/vendasOrigem/validacao');
const S360 = require('../functions/lib/sync360');
const { criarLeitorGc, codigoSeguro } = require('../functions/lib/estoqueReconciliacao');

const saida = l => console.log(l);
const emitir = (tag, d) => saida(`VEXC_${tag} ${JSON.stringify(d)}`);
const encerrar = extra => { emitir('FIM', { ok: false, ...extra }); };
const erro = codigo => Object.assign(new Error(codigo), { codigo });
const ACOES = ['status', 'definir-modo', 'liberar-carteira', 'reverter'];
const IDS = /^\d{1,15}(\+\d{1,15}){0,49}$/;

/** Ações de operação (null = validação). */
function lerAcao(argv) {
  const a = { acao: null, valor: null, por: null, confirmar: false };
  if (!argv.some(x => ACOES.some(n => x === '--' + n || x.startsWith(`--${n}=`)))) return null;
  for (const x of argv) {
    if (x === '--confirmar') { a.confirmar = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(x); if (!m) throw erro('ARGUMENTO_INVALIDO');
    if (m[1] === 'por' && /^[A-Za-z0-9._-]{3,40}$/.test(m[2] || '')) a.por = m[2];
    else if (ACOES.includes(m[1]) && !a.acao) { a.acao = m[1]; a.valor = m[2] || null; }
    else throw erro('ARGUMENTO_INVALIDO');
  }
  if (a.acao === 'definir-modo' && !R.MODOS.includes(a.valor)) throw erro('MODO_INVALIDO');
  if (a.acao === 'liberar-carteira' && !IDS.test(a.valor || '')) throw erro('IDS_INVALIDOS');
  if (a.acao === 'reverter' && !(a.valor === 'todas' || IDS.test(a.valor || ''))) throw erro('IDS_INVALIDOS');
  if (a.acao === 'status' && a.valor !== null) throw erro('ARGUMENTO_INVALIDO');
  if (a.acao !== 'status' && !a.por) throw erro('INFORME_POR');
  return a;
}

async function operar(a, { db, env, agoraMs = Date.now(), transporte }) {
  const refCfg = db.collection(R.COLECOES.config).doc(R.DOC_CONFIG);
  const atual = await refCfg.get().then(s => (s.exists ? s.data() : {}));
  const ativas = async () => (await db.collection(R.COLECOES.candidatos).where('invalidacaoAtiva', '==', true).get()).docs.map(d => d.data());
  if (a.acao === 'status') {
    const q = await db.collection(R.COLECOES.candidatos).get();
    const cfg = R.lerConfig(atual);
    emitir('STATUS', { modo: cfg.modo, motivo: cfg.motivo, candidatas: q.docs.length });
    for (const d of q.docs) {
      const c = d.data();
      emitir('SITUACAO', { id: c.vendaId, estado: c.estado, classe: c.classe, aberta: c.aberta, ativa: c.invalidacaoAtiva, crm: c.crm || null, observacoes: c.sequencia ? c.sequencia.n : 0,
        primeira: c.sequencia ? new Date(c.sequencia.primeiraEm).toISOString() : null, ultima: c.ultimaObservacaoEm ? new Date(c.ultimaObservacaoEm).toISOString() : null, data: c.dataVenda || null,
        impacto: c.impacto || null, recalculo_pendente: !!c.recalculoPendente, revisar_carteira: !!c.revisarCarteira });
    }
    return emitir('FIM', { ok: true });
  }
  const ids = a.valor === 'todas' ? (await ativas()).map(c => c.vendaId) : a.acao === 'definir-modo' ? [] : a.valor.split('+');
  emitir('PREVIA', { acao: a.acao, modo_atual: R.lerConfig(atual).modo, valor: a.acao === 'definir-modo' ? a.valor : undefined, vendas: ids, confirmar: a.confirmar });
  if (!a.confirmar) return emitir('FIM', { ok: true, nada_gravado: true });
  const trilha = d => db.collection(R.COLECOES.trilha).doc(`config_${agoraMs}`).create({ tipo: 'OPERACAO', acao: a.acao, por: a.por, em: agoraMs, ...d });
  if (a.acao === 'definir-modo') {
    const { aprovadoPor: _p, aprovadoEm: _e, ...resto } = atual;           // aprovação não sobrevive a uma troca de modo
    const novo = { ...resto, modo: a.valor, alteradoPor: a.por, alteradoEm: new Date(agoraMs).toISOString(), ...(a.valor === 'APLICAR' ? { aprovadoPor: a.por, aprovadoEm: new Date(agoraMs).toISOString() } : {}) };
    await trilha({ de: atual.modo || null, para: a.valor }); await refCfg.set(novo);
    return emitir('FIM', { ok: true, modo: R.lerConfig(novo).modo });
  }
  if (a.acao === 'liberar-carteira') {
    await trilha({ vendas: ids }); await refCfg.set({ ...atual, liberadasCarteira: [...new Set([...(atual.liberadasCarteira || []).map(String), ...ids])] });
    return emitir('FIM', { ok: true });
  }
  // reverter
  const trava = await db.collection('gc_sync_lock').doc('sync-dados').get();
  if (trava.exists && Number(trava.data().expiraEm) > agoraMs) return encerrar({ abortado: 'SYNC_EM_ANDAMENTO' });
  const ctx = { agoraMs, runId: `manual-${a.por}-${agoraMs}` };
  await trilha({ vendas: ids });
  for (const id of ids) emitir('REVERSAO', { id, ...(await P.reverter(db, id, { ...ctx, motivo: 'MANUAL_' + a.por, manual: true })) });
  const leitor = criarLeitorGc({ transporte, credenciais: { access: env.GC_ACCESS_TOKEN, secret: env.GC_SECRET_ACCESS_TOKEN }, maxRequisicoes: 40, pausaMs: 300 });
  const recalculo = await P.recalcularPendentes(db, { ...ctx, hoje: S360.calcularDataReferencia(new Date(agoraMs)), obterProdutosPorId: async () => S360.buildProdutosPorId((await leitor.lista('/produtos', { ativo: 1 })).itens) });
  return emitir('FIM', { ok: recalculo.falhas === 0, recalculo });
}

async function principal(argv, env, { db, transporte } = {}) {
  let acao, opcoes;
  try { acao = lerAcao(argv); if (!acao) opcoes = V.lerOpcoes(argv); } catch (e) { encerrar({ abortado: codigoSeguro(e) }); return; }
  const precisaGc = !acao || acao.acao === 'reverter';
  if (precisaGc && (!env.GC_ACCESS_TOKEN || !env.GC_SECRET_ACCESS_TOKEN)) { encerrar({ abortado: 'CREDENCIAIS_AUSENTES' }); return; }
  try {
    const base = db || new (require('@google-cloud/firestore').Firestore)({ projectId: 'mr4-ponto' });
    const t = transporte || gcHttp.criarTransporteHttps();
    if (acao) await operar(acao, { db: base, env, transporte: t });
    else await V.validar({ db: base, transporte: t, credenciais: { access: env.GC_ACCESS_TOKEN, secret: env.GC_SECRET_ACCESS_TOKEN }, opcoes, saida, ambiente: env });
  } catch (e) { encerrar({ abortado: codigoSeguro(e) }); }
}

if (require.main === module) principal(process.argv.slice(2), process.env);

module.exports = { principal, lerAcao, operar };
