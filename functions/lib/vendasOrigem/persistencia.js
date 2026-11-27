'use strict';
/**
 * Persistência — única parte que ESCREVE. Coleções próprias (Rules negam qualquer cliente por padrão):
 *   vendas_origem_candidatos/{vendaId}  estado atual + evidências
 *   vendas_origem_trilha/{vendaId_versao}  trilha APPEND-ONLY (só create)
 * Fora delas, apenas no modo APLICAR (ou ao reverter): `vendas_gc/{id}` (situação marcada, original preservada) e o recálculo de
 * `perfis_360` do cliente. NADA é excluído. Financeiro, carteira, histórico comercial, fila e Expedição nunca são escritos aqui.
 */
const R = require('./regras');
const { calcularPerfil360 } = require('../perfil360');

// Mesmas chaves do processador B3 (teste confere a igualdade com reativacaoVendas.TIPOS_EVENTO_B3, que não é importado
// aqui porque arrasta firebase-functions para o Job).
const TIPOS_EVENTO_B3 = Object.freeze(['TRANSFERIR_REATIVACAO', 'CRIAR_VIA_REATIVACAO', 'CRIAR_PRIMEIRA_VENDA', 'RENOVAR_OWNER', 'COBERTURA_RENOVA_OWNER', 'COBERTURA_PAUSA']);
const refCand = (db, id) => db.collection(R.COLECOES.candidatos).doc(String(id));
const refTrilha = (db, id, versao) => db.collection(R.COLECOES.trilha).doc(`${id}_${String(versao).padStart(5, '0')}`);
const refConfig = db => db.collection(R.COLECOES.config).doc(R.DOC_CONFIG);
const dados = s => (s.exists ? s.data() : null);

/** Grava candidato (versão + 1) e o evento da trilha na MESMA transação. */
function gravar(tx, db, cand, evento) {
  const doc = { ...cand, versao: (cand.versao || 0) + 1 };
  tx.set(refCand(db, doc.vendaId), doc);
  tx.create(refTrilha(db, doc.vendaId, doc.versao), { vendaId: doc.vendaId, versao: doc.versao, estado: doc.estado, classe: doc.classe, invalidacaoAtiva: doc.invalidacaoAtiva, ...evento });
  return doc;
}

async function listarAbertas(db) {
  const q = await db.collection(R.COLECOES.candidatos).where('aberta', '==', true).get();
  return new Map(q.docs.map(d => [String(d.data().vendaId), d.data()]));
}

/** Registra uma observação (transacional: duas execuções simultâneas não contam duas vezes). */
async function registrarObservacao(db, o, { agoraMs, runId, params, modo }) {
  return db.runTransaction(async tx => {
    const anterior = dados(await tx.get(refCand(db, o.vendaId)));
    const r = R.observar(anterior, { vendaId: o.vendaId, classe: o.classe, em: agoraMs, runId }, params);
    if (!r.mudou) return { cand: r.cand, mudou: false, acao: r.acao };
    const espelho = o.evidencia && o.evidencia.espelho;
    const cand = { ...r.cand, dataVenda: (o.evidencia && o.evidencia.data) || r.cand.dataVenda || null,
      provaLoja: !!(r.cand.provaLoja || o.provaLoja),
      modificadoEmObservado: espelho ? espelho.modificado_em : r.cand.modificadoEmObservado || null,
      evidencia: { fonte: o.fonte, em: agoraMs, ...o.evidencia } };
    const doc = gravar(tx, db, cand, { tipo: 'OBSERVACAO', em: agoraMs, runId, modo, fonte: o.fonte, contagem: cand.sequencia ? cand.sequencia.n : 0, evidencia: cand.evidencia });
    return { cand: doc, mudou: true, acao: r.acao };
  });
}

/** Fecha uma candidata que o próprio sync já resolveu (o espelho/base deixaram de contar a venda). */
async function encerrar(db, vendaId, estado, { agoraMs, runId, motivo }) {
  return db.runTransaction(async tx => {
    const c = dados(await tx.get(refCand(db, vendaId)));
    if (!c || !c.aberta || c.invalidacaoAtiva) return false;
    gravar(tx, db, { ...c, estado, aberta: false, sequencia: null }, { tipo: 'ENCERRAMENTO', em: agoraMs, runId, motivo });
    return true;
  });
}

/** Vínculos comerciais da venda (carteira/reativação). Havendo qualquer um, o CRM não é alterado sem liberação explícita. */
async function lerVinculosCarteira(ler, db, vendaId) {
  const H = db.collection('carteira_comercial_historico');
  const [porChave, porReferencia, decisoes] = [
    await ler(H.where('chaveIdempotencia', 'in', TIPOS_EVENTO_B3.map(t => `B3:${t}:${vendaId}`))),
    await ler(H.where('referencias.vendaGcId', '==', String(vendaId))),
    await ler(db.collection('carteira_reativacao_decisoes').where('vendaId', '==', String(vendaId))),
  ];
  const eventos = new Set([...porChave.docs, ...porReferencia.docs].map(d => d.id)).size;
  const creditos = decisoes.docs.filter(d => d.data().reservaChave).length;
  return { eventos, creditos, total: eventos + creditos };
}

/** O que a aplicação afetaria (informativo, uma vez por candidata confirmada): vínculos de carteira e pedido na Expedição. */
async function registrarImpacto(db, vendaId, { agoraMs, runId }) {
  const c = dados(await refCand(db, vendaId).get());
  if (!c || c.impacto) return false;
  const vinculos = await lerVinculosCarteira(q => q.get(), db, vendaId);
  const codigo = String((((c.evidencia || {}).detalhe || (c.evidencia || {}).listada) || {}).codigo || '');
  const p = /^[A-Za-z0-9_-]{1,20}$/.test(codigo) ? dados(await db.collection('expedicao_pedidos').doc(codigo).get()) : null;
  const impacto = { vinculosCarteira: vinculos, expedicao: codigo ? { pedido: codigo, existe: !!p, coluna: p ? String(p.coluna || '') : null } : null };
  return db.runTransaction(async tx => {
    const x = dados(await tx.get(refCand(db, vendaId)));
    if (!x || x.impacto) return false;
    gravar(tx, db, { ...x, impacto }, { tipo: 'IMPACTO', em: agoraMs, runId, impacto });
    return true;
  });
}

/**
 * Aplica uma invalidação CONFIRMADA. Relê dentro da transação: modo (botão de desligar), candidata, espelho e vínculos.
 * Qualquer mudança desde a observação ⇒ não aplica.
 */
async function aplicar(db, vendaId, { agoraMs, runId }) {
  return db.runTransaction(async tx => {
    const cfg = R.lerConfig(dados(await tx.get(refConfig(db))));
    if (cfg.modo !== 'APLICAR') return { status: 'MODO_NAO_APLICA' };
    const c = dados(await tx.get(refCand(db, vendaId)));
    if (!c || c.bloqueada || !c.aberta) return { status: 'NAO_ELEGIVEL' };
    const liberada = cfg.liberadasCarteira.has(String(vendaId));
    const completar = c.estado === R.ESTADOS.APLICADA && c.crm === 'RETIDA_CARTEIRA' && liberada;   // 2ª parte: CRM liberado depois
    if (c.estado !== R.ESTADOS.CONFIRMADA && !completar) return { status: 'NAO_ELEGIVEL' };
    if (!R.CONFIRMAVEIS.includes(c.classe)) return { status: 'NAO_ELEGIVEL' };
    const refV = db.collection('vendas_gc').doc(String(vendaId));
    const v = dados(await tx.get(refV));
    const vinculos = await lerVinculosCarteira(q => tx.get(q), db, vendaId);
    if (v && c.modificadoEmObservado !== null && c.modificadoEmObservado !== undefined && String(v.modificado_em || '') !== String(c.modificadoEmObservado)) {
      gravar(tx, db, { ...c, estado: c.invalidacaoAtiva ? c.estado : R.ESTADOS.OBSERVANDO, sequencia: null, modificadoEmObservado: String(v.modificado_em || '') }, { tipo: 'APLICACAO_ABORTADA', em: agoraMs, runId, motivo: 'ESPELHO_MUDOU' });
      return { status: 'ESPELHO_MUDOU' };
    }
    let crm = 'SEM_ESPELHO';
    if (v && !v.invalidacao_origem && !R.cancelada(v)) crm = vinculos.total && !liberada ? 'RETIDA_CARTEIRA' : 'APLICADA';
    else if (v) crm = 'JA_INVALIDA';
    if (completar && crm === 'RETIDA_CARTEIRA') return { status: 'NAO_ELEGIVEL' };
    if (crm === 'APLICADA') {
      tx.set(refV, { ...v, nome_situacao: R.ROTULO_ESPELHO[c.classe], invalidacao_origem: { classe: c.classe, aplicadaEm: agoraMs, candidato: String(vendaId), situacaoAnterior: v.nome_situacao === undefined ? null : v.nome_situacao } });
    }
    const cliente = v ? String(v.cliente_id || '') : '';
    gravar(tx, db, { ...c, estado: R.ESTADOS.APLICADA, invalidacaoAtiva: true, crm, vinculosCarteira: vinculos, clienteGcId: cliente || c.clienteGcId || null,
      aplicadaEm: c.aplicadaEm || agoraMs, recalculoPendente: crm === 'APLICADA' && !!cliente ? true : !!c.recalculoPendente }, { tipo: 'APLICACAO', em: agoraMs, runId, crm, vinculos });
    return { status: 'APLICADA', crm };
  });
}

/**
 * Reverte uma invalidação (a venda reapareceu, a evidência caiu, ou decisão manual). Restaura o espelho SOMENTE se a marca ainda
 * estiver lá (se o sync regravou a venda, vale o registro novo).
 */
async function reverter(db, vendaId, { agoraMs, runId, motivo, manual = false }) {
  return db.runTransaction(async tx => {
    const c = dados(await tx.get(refCand(db, vendaId)));
    if (!c || !c.invalidacaoAtiva) return { status: 'NADA_A_REVERTER' };
    const refV = db.collection('vendas_gc').doc(String(vendaId));
    const v = dados(await tx.get(refV));
    // se uma reversão B3 já foi executada (venda liberada pela gestão), ela NÃO é desfeita sozinha: fica sinalizada
    const rev = await tx.get(db.collection('carteira_comercial_historico').where('chaveIdempotencia', '==', `B3:REVERSAO:${vendaId}`));
    let restaurado = false;
    if (v && v.invalidacao_origem) {
      const { invalidacao_origem: marca, ...resto } = v;
      tx.set(refV, { ...resto, nome_situacao: marca.situacaoAnterior });
      restaurado = true;
    }
    const crmFoiAlterado = c.crm === 'APLICADA';
    gravar(tx, db, { ...c, estado: manual ? R.ESTADOS.REVERTIDA_MANUAL : R.ESTADOS.REAPARECIDA, invalidacaoAtiva: false, aberta: false, bloqueada: !!manual, sequencia: null, crm: crmFoiAlterado ? 'REVERTIDA' : c.crm,
      aplicadaEm: null, revertidaEm: agoraMs, recalculoPendente: crmFoiAlterado && !!c.clienteGcId, revisarCarteira: !rev.empty }, { tipo: 'REVERSAO', em: agoraMs, runId, motivo, restaurado, revisarCarteira: !rev.empty });
    return { status: 'REVERTIDA', restaurado, revisarCarteira: !rev.empty };
  });
}

/**
 * Recalcula (mesmo motor do sync) os perfis 360 JÁ EXISTENTES dos clientes afetados, a partir do espelho.
 * Idempotente; falha ⇒ a pendência permanece para a próxima execução.
 */
async function recalcularPendentes(db, { agoraMs, runId, hoje, obterProdutosPorId }) {
  const q = await db.collection(R.COLECOES.candidatos).where('recalculoPendente', '==', true).get();
  const out = { pendentes: q.docs.length, clientes: 0, perfis: 0, falhas: 0 };
  if (!q.docs.length) return out;
  let produtosPorId;
  try { produtosPorId = await obterProdutosPorId(); } catch (_) { out.falhas = q.docs.length; return out; }
  const porCliente = new Map();
  for (const d of q.docs) { const c = d.data(); if (!porCliente.has(c.clienteGcId)) porCliente.set(c.clienteGcId, []); porCliente.get(c.clienteGcId).push(c); }
  for (const [gc, cands] of porCliente) {
    try {
      const [perfis, vendas] = [await db.collection('perfis_360').where('gestaoClickId', '==', String(gc)).get(), await db.collection('vendas_gc').where('cliente_id', '==', String(gc)).get()];
      for (const p of perfis.docs) {
        const atual = p.data();
        const novo = calcularPerfil360({ clienteMr4Id: atual.clienteMr4Id || p.id, gestaoClickId: String(gc), vendas: vendas.docs.map(x => x.data()), produtosPorId, dataReferencia: hoje, calculadoEm: new Date(agoraMs).toISOString() });
        await db.collection('perfis_360').doc(p.id).set({ ...atual, ...novo }); out.perfis++;
      }
      for (const c of cands) {
        await db.runTransaction(async tx => {
          const x = dados(await tx.get(refCand(db, c.vendaId)));
          if (!x || !x.recalculoPendente || x.versao !== c.versao) return;                     // mudou no meio: recalcula de novo depois
          gravar(tx, db, { ...x, recalculoPendente: false }, { tipo: 'RECALCULO_PERFIL', em: agoraMs, runId, perfis: perfis.docs.length });
        });
      }
      out.clientes++;
    } catch (_) { out.falhas++; }
  }
  return out;
}

module.exports = { TIPOS_EVENTO_B3, listarAbertas, registrarObservacao, encerrar, lerVinculosCarteira, registrarImpacto, aplicar, reverter, recalcularPendentes };
