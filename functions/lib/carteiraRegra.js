'use strict';
// N35.29/N35.30 — Regra DEFINITIVA da Carteira Comercial (R2). Publicada na N35.30 SOMENTE em modo SOMBRA.
//
// Decisões do proprietário:
//   G1 R2  — carteira protegida < 120 dias; com >= 120 dias sem comprar a reativação abre e a PRIMEIRA nova venda
//            válida de outro vendedor habilitado transfere a carteira para ele. Claim/contato/follow-up/Worklist nunca transferem.
//   G2     — pausa temporária (férias, licença, afastamento, pausa de distribuição) protege a carteira: venda de outro
//            vendedor vira COBERTURA e não dispara R2. Pausa vem SÓ de configuração explícita.
//   G3–G6  — nada retroativo: só vendas com data >= corte de ativação (regra.ativoDesde) são avaliadas.
//   G7/G8  — sem venda não há carteira; cadastro/vendedor do GestãoClick nunca cria carteira.
//   G9     — primeira venda cria carteira só para vendedor elegível (configuração do usuário); senão revisão da gestão.
//   G10    — desligamento nunca redistribui: só transferência administrativa explícita.
//
// Configuração por usuário (sem UID fixo no código) — sistema_usuarios/{uid}.carteiraComercial (conceitos SEPARADOS):
//   podePossuirCarteira  : true  → pode ter/receber carteira
//   ativoComercialmente  : true  → vendedor em atividade comercial
//   pausaTemporaria      : bool  → férias/licença/afastamento (pausaMotivo: 'FERIAS'|'LICENCA'|'AFASTAMENTO'|'OUTRO')
//   desligado            : bool  → saída definitiva (nunca recebe; carteira só sai por transferência administrativa)
//   gestaoClickVendedorId: '<id do vendedor no GC>' (mapa venda → UID)
//   Conceitos que continuam onde já estão e NÃO são inferidos daqui: podeOperarFila = modulos 'fila-comercial-operar';
//   participaDistribuicao = filaComercial.ativo/recebeNovasOportunidades. Por decisão de negócio (G2), a PAUSA DE
//   DISTRIBUIÇÃO explícita (filaComercial.ativo === false ou recebeNovasOportunidades === false) também protege a carteira.
//   + users/{uid}.ativo === true e sistema_usuarios/{uid}.bloqueado !== true.
//
// Configuração da regra — carteira_comercial_config/regra:
//   { modo: 'DESLIGADO'|'SOMBRA'|'ATIVO', ativoDesde: 'YYYY-MM-DD' (corte de ativação = data comercial da venda no GC,
//     sem relógio/fuso da máquina), politicaSemCarteiraComHistorico: 'SOMENTE_APOS_120D' (padrão) | 'PROXIMA_VENDA' }
//   Ausente ou inválida ⇒ DESLIGADO (fail-safe; kill switch = gravar modo='DESLIGADO').
//
// Isolamento: em SOMBRA (ou com forcarSombra=true) a ÚNICA escrita é a decisão em carteira_comercial_decisoes_sombra.
// Carteira oficial, histórico oficial e decisões oficiais só são escritos com modo ATIVO E forcarSombra !== true.
// Não lê nem escreve fila_comercial, interacoes_fila, perfis_360 (clientes só é lido para o vínculo, via resolverAncoraTx).

const { calcularReativacao, montarDocCarteiraV1, montarEventoHistoricoV1, DIAS_REATIVACAO } = require('./carteiraV1');
const { portfolioAnchorFromGcId, normalizeGestaoClickId } = require('./commercialIdentity');
const { resolverAncoraTx } = require('./carteiraMigracao');

const COLL = 'carteira_comercial';
const COLL_HIST = 'carteira_comercial_historico';
const COLL_DEC = 'carteira_comercial_decisoes';
const COLL_DEC_SOMBRA = 'carteira_comercial_decisoes_sombra';
const COLL_CONFIG = 'carteira_comercial_config';
const REF_CONFIG = [COLL_CONFIG, 'regra'];
const REGRA_VERSAO = 'N35.32';
const OPERADOR_SISTEMA = 'SISTEMA:carteira-regra';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SITUACAO_VALIDA = 'Concretizada';
const JANELA_REVISITA_DIAS = 7;   // vendas lançadas com atraso de até 7 dias em relação à maior data já avaliada

const DECISOES = Object.freeze({
  CRIAR_PRIMEIRA_VENDA: 'CRIAR_PRIMEIRA_VENDA',
  CRIAR_REATIVACAO: 'CRIAR_REATIVACAO',
  TRANSFERIR_R2: 'TRANSFERIR_R2',
  MANTER: 'MANTER',
  PENDENCIA_GESTAO: 'PENDENCIA_GESTAO',
});
const ALTERA_CARTEIRA = [DECISOES.CRIAR_PRIMEIRA_VENDA, DECISOES.CRIAR_REATIVACAO, DECISOES.TRANSFERIR_R2];

// Campos permitidos numa decisão (oficial ou sombra). Nada de nome, documento, contato, valor ou texto livre.
const CAMPOS_DECISAO = Object.freeze(['decisionId', 'vendaId', 'portfolioId', 'dataVenda', 'vendedorGestaoClickId', 'vendedorUid',
  'decisao', 'decisaoSombra', 'motivo', 'ownerAntesUid', 'ownerDepoisUid', 'diasSemComprar', 'gestaoReview', 'modo', 'regraVersao', 'processadoEm', 'runId',
  // N35.32 — revisões auditáveis (venda atrasada / alterada / cancelada)
  'revisao', 'substitui', 'causa', 'revisaoVenda', 'chaveConteudo', 'vendaModificadaEm', 'diasAteDeteccao', 'vendaTardia']);
const PROIBIDO_DECISAO = /nome|cpf|cnpj|telefone|fone|email|endereco|observ|ticket|valor|faturamento|margem|lucro|custo|senha|token|segredo|secret|credencial/i;

// ── Venda válida ─────────────────────────────────────────────────────────────
/**
 * Venda capaz de contar como compra (e, com vendedor elegível, criar/transferir carteira).
 * Critérios (auditados em vendas_gc): situação exatamente 'Concretizada'; id; cliente_id; data YYYY-MM-DD não futura;
 * valor_total > 0 (exclui trocas/brindes a zero). Orçamento, em aberto/andamento/reservado e cancelada NÃO são válidas.
 * Vendedor ausente NÃO invalida a compra (conta para os 120 dias), mas não cria/transfere (revisão da gestão).
 */
function validarVenda(v, hojeYmd) {
  if (!v || !v.id) return 'SEM_ID';
  if (String(v.nome_situacao || '').trim() !== SITUACAO_VALIDA) return 'SITUACAO_NAO_CONCRETIZADA';
  if (!normalizeGestaoClickId(v.cliente_id)) return 'SEM_CLIENTE';
  const d = String(v.data || '').slice(0, 10);
  if (!YMD.test(d) || !Number.isFinite(Date.parse(d + 'T12:00:00Z'))) return 'DATA_INVALIDA';
  if (hojeYmd && d > hojeYmd) return 'DATA_FUTURA';
  if (!(parseFloat(v.valor_total) > 0)) return 'VALOR_ZERADO';
  return null;
}
const chaveOrdem = v => String(v.data).slice(0, 10) + '|' + String(v.id).padStart(20, '0');
/** Vendas válidas do cliente estritamente anteriores a `venda` (ordem data, id), sem duplicatas de id. */
function vendasAnteriores(todas, venda, hojeYmd) {
  const k = chaveOrdem(venda), vistos = new Set();
  return (todas || []).filter(v => !validarVenda(v, hojeYmd) && String(v.id) !== String(venda.id) && chaveOrdem(v) < k)
    .filter(v => (vistos.has(String(v.id)) ? false : vistos.add(String(v.id))))
    .sort((a, b) => (chaveOrdem(a) < chaveOrdem(b) ? -1 : 1));
}

// ── Vendedor elegível / situação ─────────────────────────────────────────────
/**
 * Situação comercial de um usuário para a carteira. Puro.
 * @returns {{ situacao: 'ATIVO'|'PAUSA_TEMPORARIA'|'DESLIGADO'|'INATIVO'|'NAO_HABILITADO'|'DESCONHECIDO', elegivel: boolean, pausaProtegida: boolean, motivo: string|null }}
 */
function situacaoVendedor(user, sistema) {
  if (!user || !sistema) return { situacao: 'DESCONHECIDO', elegivel: false, pausaProtegida: false, motivo: 'VENDEDOR_DESCONHECIDO' };
  const cc = sistema.carteiraComercial || {};
  if (cc.desligado === true) return { situacao: 'DESLIGADO', elegivel: false, pausaProtegida: false, motivo: 'VENDEDOR_DESLIGADO' };
  if (user.ativo !== true || sistema.bloqueado === true || cc.ativoComercialmente !== true) return { situacao: 'INATIVO', elegivel: false, pausaProtegida: false, motivo: 'VENDEDOR_INATIVO' };
  if (cc.podePossuirCarteira !== true) return { situacao: 'NAO_HABILITADO', elegivel: false, pausaProtegida: false, motivo: 'VENDEDOR_NAO_HABILITADO' };
  const fc = sistema.filaComercial || null;
  const pausaDistribuicao = !!fc && (fc.ativo === false || fc.recebeNovasOportunidades === false);
  if (cc.pausaTemporaria === true || pausaDistribuicao) {
    return { situacao: 'PAUSA_TEMPORARIA', elegivel: true, pausaProtegida: true, motivo: cc.pausaTemporaria === true ? 'PAUSA_' + (cc.pausaMotivo || 'TEMPORARIA') : 'PAUSA_DISTRIBUICAO' };
  }
  return { situacao: 'ATIVO', elegivel: true, pausaProtegida: false, motivo: null };
}
/** Pode possuir / receber carteira (primeira venda e R2). Pausa temporária continua elegível. */
function isPortfolioEligibleSeller(user, sistema) { return situacaoVendedor(user, sistema).elegivel; }

/** GC vendedor_id → UID pela configuração (carteiraComercial.gestaoClickVendedorId). Puro. */
function resolverVendedorPorGc(configs, gcVendedorId) {
  const g = normalizeGestaoClickId(gcVendedorId);
  if (!g) return { status: 'SEM_VENDEDOR', uid: null };
  const hits = (configs || []).filter(c => normalizeGestaoClickId(c.sistema && c.sistema.carteiraComercial && c.sistema.carteiraComercial.gestaoClickVendedorId) === g);
  if (hits.length === 1) return { status: 'RESOLVIDO', uid: hits[0].uid };
  return { status: hits.length ? 'AMBIGUO' : 'NAO_RESOLVIDO', uid: null };
}

// ── Configuração da regra ────────────────────────────────────────────────────
function lerRegra(doc) {
  const d = doc || {};
  const modo = ['DESLIGADO', 'SOMBRA', 'ATIVO'].includes(d.modo) ? d.modo : 'DESLIGADO';
  if (modo !== 'DESLIGADO' && !(typeof d.ativoDesde === 'string' && YMD.test(d.ativoDesde))) return { modo: 'DESLIGADO', motivo: 'ATIVO_DESDE_INVALIDO' };
  const pol = d.politicaSemCarteiraComHistorico === 'PROXIMA_VENDA' ? 'PROXIMA_VENDA' : 'SOMENTE_APOS_120D';
  return { modo, ativoDesde: d.ativoDesde || null, politicaSemCarteiraComHistorico: pol };
}
/** Modo efetivamente aplicado: ATIVO só se configurado ATIVO e sem trava de sombra. */
function modoEfetivo(regra, forcarSombra) {
  if (regra.modo === 'DESLIGADO') return 'DESLIGADO';
  if (forcarSombra === true || regra.modo === 'SOMBRA') return 'SOMBRA';
  return 'ATIVO';
}

// ── Decisão (pura) ───────────────────────────────────────────────────────────
function decidirVendaCarteira({ carteira, anteriores, venda, vendedor, dono, regra }) {
  const ownerAntes = (carteira && carteira.ownerUid) || null;
  const ultimaAnterior = anteriores && anteriores.length ? String(anteriores[anteriores.length - 1].data).slice(0, 10) : null;
  const r = ultimaAnterior ? calcularReativacao({ ultimaCompraEm: ultimaAnterior, referenceDate: String(venda.data).slice(0, 10) }) : null;
  const dias = r ? r.diasSemComprar : null;
  const reativacao = !!(r && r.reativacaoAberta);                                  // >= 120 (119 fechado, 120 aberto)
  const base = { ownerAntesUid: ownerAntes, ownerDepoisUid: ownerAntes, diasSemComprar: dias, vendedorUid: vendedor.uid || null, gestaoReview: false };
  const out = (decisao, motivo, extra = {}) => ({ ...base, decisao, motivo, ...extra });
  const elegivel = vendedor.status === 'RESOLVIDO' && vendedor.situacao && vendedor.situacao.elegivel;
  const motivoVendedor = vendedor.status !== 'RESOLVIDO' ? 'VENDEDOR_' + vendedor.status : (vendedor.situacao && vendedor.situacao.motivo) || 'VENDEDOR_NAO_ELEGIVEL';

  if (!ownerAntes) {
    const primeira = !anteriores || anteriores.length === 0;
    if (!primeira && !reativacao && regra.politicaSemCarteiraComHistorico !== 'PROXIMA_VENDA') return out(DECISOES.MANTER, 'SEM_CARTEIRA_AGUARDANDO_REATIVACAO_120D');
    if (!elegivel) return out(DECISOES.PENDENCIA_GESTAO, motivoVendedor, { gestaoReview: true });
    return out(primeira ? DECISOES.CRIAR_PRIMEIRA_VENDA : DECISOES.CRIAR_REATIVACAO, primeira ? 'PRIMEIRA_VENDA_VALIDA' : 'VENDA_VALIDA_SEM_CARTEIRA',
      { ownerDepoisUid: vendedor.uid });
  }
  if (vendedor.uid && vendedor.uid === ownerAntes) return out(DECISOES.MANTER, 'VENDA_DO_DONO');
  if (!reativacao) return out(DECISOES.MANTER, 'CARTEIRA_PROTEGIDA_MENOS_120D');       // cobertura / venda pontual
  if (dono && dono.pausaProtegida) return out(DECISOES.MANTER, 'COBERTURA_PAUSA_TEMPORARIA');
  if (!elegivel) return out(DECISOES.MANTER, 'R2_BLOQUEADA_' + motivoVendedor, { gestaoReview: true });
  return out(DECISOES.TRANSFERIR_R2, 'REATIVACAO_120D_PRIMEIRA_VENDA', { ownerDepoisUid: vendedor.uid });
}

/** Rótulo legível do que a regra FARIA (usado na sombra e nos relatórios). */
function rotuloSombra(d) {
  if (d.decisao === 'VENDA_INVALIDADA') return 'INVALIDADA';
  if (d.decisao === DECISOES.CRIAR_PRIMEIRA_VENDA) return 'CRIARIA_CARTEIRA';
  if (d.decisao === DECISOES.CRIAR_REATIVACAO) return 'CRIARIA_CARTEIRA_REATIVACAO';
  if (d.decisao === DECISOES.TRANSFERIR_R2) return 'TRANSFERIRIA_R2';
  if (d.decisao === DECISOES.PENDENCIA_GESTAO || d.gestaoReview) return 'REVISAO_GESTAO';
  if (d.motivo === 'SEM_CARTEIRA_AGUARDANDO_REATIVACAO_120D') return 'NAO_CRIAR';
  if (d.motivo === 'VENDA_DO_DONO') return 'SEM_ACAO';
  return 'NAO_TRANSFERIR';                                  // carteira protegida / cobertura de pausa
}

/** Whitelist estrita de uma decisão. null = ok. */
function validarDecisao(doc) {
  const extras = Object.keys(doc || {}).filter(k => !CAMPOS_DECISAO.includes(k));
  if (extras.length) return 'CAMPOS_NAO_PERMITIDOS:' + extras.join(',');
  const proib = Object.keys(doc).filter(k => PROIBIDO_DECISAO.test(k));
  if (proib.length) return 'CAMPO_PROIBIDO:' + proib.join(',');
  for (const [k, v] of Object.entries(doc)) if (v !== null && typeof v === 'object') return 'VALOR_NAO_ESCALAR:' + k;
  return null;
}

const idDecisao = vendaId => 'V_' + String(vendaId).replace(/[^A-Za-z0-9_-]/g, '_');
const idEvento = (prefixo, vendaId) => prefixo + '_' + String(vendaId).replace(/[^A-Za-z0-9_-]/g, '_');

// ── Execução transacional ────────────────────────────────────────────────────
async function lerConfigsVendedores(tx, store) {
  const s = await tx.get(store.collection('sistema_usuarios').where('carteiraComercial.podePossuirCarteira', 'in', [true, false]));
  return s.docs.map(d => ({ uid: d.id, sistema: d.data() }));
}
async function situacaoPorUid(tx, store, uid) {
  if (!uid) return null;
  const [u, s] = await Promise.all([tx.get(store.collection('users').doc(uid)), tx.get(store.collection('sistema_usuarios').doc(uid))]);
  return situacaoVendedor(u.exists ? u.data() : null, s.exists ? s.data() : null);
}

/**
 * Processa UMA venda (por id) numa transação. Idempotente (decisão create-only por venda) e seguro sob concorrência.
 * @param p.forcarSombra  true ⇒ nunca escreve carteira/histórico/decisão oficial, qualquer que seja o modo configurado.
 * @returns {{ status: 'PROCESSADA'|'JA_PROCESSADA'|'IGNORADA'|'DESLIGADO', modo?, decisao?, motivo? }}
 */
async function processarVendaCarteira(store, { vendaId, agoraIso, regraDoc, forcarSombra, runId }) {
  const regra = lerRegra(regraDoc);
  const modo = modoEfetivo(regra, forcarSombra);
  if (modo === 'DESLIGADO') return { status: 'DESLIGADO', motivo: regra.motivo || 'REGRA_DESLIGADA' };
  const sombra = modo === 'SOMBRA';
  const collDec = sombra ? COLL_DEC_SOMBRA : COLL_DEC;
  const hoje = String(agoraIso).slice(0, 10);
  let res;
  await store.runTransaction(async tx => {
    const vSnap = await tx.get(store.collection('vendas_gc').where('id', '==', String(vendaId)));
    const venda = vSnap.empty ? null : vSnap.docs[0].data();
    const refDec = store.collection(collDec).doc(idDecisao(vendaId));
    const decSnap = await tx.get(refDec);
    // decisão já existe ⇒ nada muda, mesmo que a venda tenha sido alterada depois (quem sinaliza é processarVendasRecentes)
    if (decSnap.exists) { res = { status: 'JA_PROCESSADA', modo, decisao: decSnap.data().decisao, motivo: decSnap.data().motivo }; return; }
    const inval = validarVenda(venda, hoje);
    if (inval) { res = { status: 'IGNORADA', motivo: inval }; return; }
    if (String(venda.data).slice(0, 10) < regra.ativoDesde) { res = { status: 'IGNORADA', motivo: 'ANTES_DO_CORTE' }; return; }

    const gcCliente = normalizeGestaoClickId(venda.cliente_id);
    const portfolioId = portfolioAnchorFromGcId(gcCliente);
    const registro = (d) => {
      const doc = { decisionId: idDecisao(venda.id), vendaId: String(venda.id), portfolioId, dataVenda: String(venda.data).slice(0, 10),
        vendedorGestaoClickId: normalizeGestaoClickId(venda.vendedor_id) || null, vendedorUid: d.vendedorUid || null, decisao: d.decisao,
        decisaoSombra: rotuloSombra(d), motivo: d.motivo, ownerAntesUid: d.ownerAntesUid || null, ownerDepoisUid: d.ownerDepoisUid || null,
        diasSemComprar: Number.isInteger(d.diasSemComprar) ? d.diasSemComprar : null, gestaoReview: d.gestaoReview === true,
        modo, regraVersao: REGRA_VERSAO, processadoEm: agoraIso, runId: runId || null };
      const erro = validarDecisao(doc);
      if (erro) throw new Error('DECISAO_FORA_DA_WHITELIST:' + erro);
      return doc;
    };

    // identidade (vínculo MR4 ambíguo / carteira em chave legada) — mesma verificação da migração
    try { await resolverAncoraTx(tx, store, 'GC_NATIVE:' + gcCliente); } catch (e) {
      const d = { decisao: DECISOES.PENDENCIA_GESTAO, motivo: 'IDENTIDADE_' + ((String(e.message).match(/\(([A-Z_]+)\)/) || [])[1] || 'NAO_RESOLVIDA'),
        ownerAntesUid: null, ownerDepoisUid: null, vendedorUid: null, diasSemComprar: null, gestaoReview: true };
      tx.create(refDec, registro(d)); res = { status: 'PROCESSADA', modo, ...d }; return;
    }
    const [todas, cSnap, configs, decididas] = await Promise.all([
      tx.get(store.collection('vendas_gc').where('cliente_id', '==', String(gcCliente))),
      tx.get(store.collection(COLL).doc(portfolioId)),
      lerConfigsVendedores(tx, store),
      tx.get(store.collection(collDec).where('portfolioId', '==', portfolioId)),
    ]);
    const carteira = cSnap.exists ? cSnap.data() : null;
    const anteriores = vendasAnteriores(todas.docs.map(d => d.data()), venda, hoje);
    const kVenda = chaveOrdem(venda);
    const foraDeOrdem = decididas.docs.some(d => (d.data().dataVenda + '|' + String(d.data().vendaId).padStart(20, '0')) > kVenda);
    const rv = resolverVendedorPorGc(configs, venda.vendedor_id);
    const sitVendedor = rv.uid ? await situacaoPorUid(tx, store, rv.uid) : null;
    const dono = carteira && carteira.ownerUid ? await situacaoPorUid(tx, store, carteira.ownerUid) : null;
    const d = foraDeOrdem
      ? { decisao: DECISOES.PENDENCIA_GESTAO, motivo: 'VENDA_FORA_DE_ORDEM', ownerAntesUid: carteira ? carteira.ownerUid : null, ownerDepoisUid: carteira ? carteira.ownerUid : null,
          vendedorUid: rv.uid, diasSemComprar: null, gestaoReview: true }
      : decidirVendaCarteira({ carteira, anteriores, venda, vendedor: { ...rv, situacao: sitVendedor }, dono, regra });

    if (!sombra && ALTERA_CARTEIRA.includes(d.decisao)) {                               // SÓ modo ATIVO
      // B3.1: exclusão mútua — R2 só escreve ownership se carteira_comercial_config/motor.motorAtivo === 'R2'
      if (!require('./motorCarteira').podeEscreverOwnership(await require('./motorCarteira').motorNaTx(tx, store), 'R2')) throw new Error('MOTOR_R2_NAO_AUTORIZADO');
      const versao = ((carteira && carteira.versao) || 0) + 1;
      const tipoEvento = d.decisao === DECISOES.TRANSFERIR_R2 ? 'REATIVACAO_120D_PRIMEIRA_VENDA'
        : d.decisao === DECISOES.CRIAR_PRIMEIRA_VENDA ? 'CARTEIRA_CRIADA_PRIMEIRA_VENDA' : 'CARTEIRA_CRIADA_REATIVACAO';
      const gcVend = normalizeGestaoClickId(venda.vendedor_id);
      const doc = montarDocCarteiraV1({ portfolioId, ownerUid: d.ownerDepoisUid, ownerDesde: agoraIso,
        origemComercialUid: carteira ? carteira.origemComercialUid : d.ownerDepoisUid,                // R2 preserva a origem
        origemComercialGestaoClickId: carteira ? carteira.origemComercialGestaoClickId : gcVend,
        criadoEm: carteira && carteira.criadoEm ? carteira.criadoEm : agoraIso, atualizadoEm: agoraIso, versao });
      const refHist = store.collection(COLL_HIST).doc(idEvento(d.decisao === DECISOES.TRANSFERIR_R2 ? 'R2' : 'PRIMEIRA_VENDA', venda.id));
      tx.set(store.collection(COLL).doc(portfolioId), doc);
      tx.create(refHist, montarEventoHistoricoV1({ portfolioId, identidadeUsada: 'GC_NATIVE:' + gcCliente, tipoEvento, ownerAnteriorUid: d.ownerAntesUid,
        ownerNovoUid: d.ownerDepoisUid, motivo: d.motivo + ' (venda ' + venda.id + ')', operadorUid: OPERADOR_SISTEMA, criadoEm: agoraIso, versao,
        chaveIdempotencia: (d.decisao === DECISOES.TRANSFERIR_R2 ? 'R2:' : 'PRIMEIRA_VENDA:') + venda.id }));
    }
    tx.create(refDec, registro(d));
    res = { status: 'PROCESSADA', modo, ...d };
  });
  return res;
}

// ── N35.32 — SOMBRA segura para vendas atrasadas ─────────────────────────────
// Duas datas SEPARADAS:
//   • data comercial da venda (vendas_gc.data)        → ordem comercial e regra dos 120 dias;
//   • data de detecção (vendas_gc.modificado_em, GC)  → só decide QUANDO reavaliar (marca d'água).
// Detecção: (A) modificado_em >= marcaDagua − 72 h, com "vistos" (id|modificado) para não repetir trabalho;
//           (B) data comercial nos últimos 7 dias sem decisão (vendas pré-datadas cuja data chegou).
// A marca d'água nunca passa do cursor já confirmado pelo sync (sync_state/perfil360.modifiedSinceCursor),
// nem do "agora" no fuso do GC (America/Fortaleza, UTC−3). Só avança se a execução terminar sem erro.
// Reavaliação: para cada cliente tocado, TODA a sequência de vendas válidas com data >= corte é recalculada em ordem
// comercial (data, id), com o dono "sombra" evoluindo como no modo ATIVO. Cada venda tem revisões create-only
// S_<vendaId>_r<n>: nova revisão só quando o conteúdo da decisão muda (venda atrasada, alterada, cancelada ou movida).
const COLL_CHECKPOINT_V2 = 'checkpoint_sombra_v2';
const SOBREPOSICAO_HORAS = 72;
const JANELA_DATA_DIAS = 7;
const TS_GC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const FUSO_GC_HORAS = -3;
const sha8 = x => require('crypto').createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
function tsMais(ts, horas) { return new Date(Date.parse(ts.replace(' ', 'T') + 'Z') + horas * 3600000).toISOString().replace('T', ' ').slice(0, 19); }
function agoraNoFusoGc(agoraIso) { return new Date(Date.parse(agoraIso) + FUSO_GC_HORAS * 3600000).toISOString().replace('T', ' ').slice(0, 19); }
const idDecisaoV2 = (vendaId, rev) => 'S_' + String(vendaId).replace(/[^A-Za-z0-9_-]/g, '_') + '_r' + rev;
/** Campos da venda que mudam a decisão comercial (outras edições — produtos, valor > 0 → > 0 — não reavaliam). */
function revisaoComercialVenda(v, hoje) {
  return sha8([String(v.data || '').slice(0, 10), normalizeGestaoClickId(v.cliente_id), normalizeGestaoClickId(v.vendedor_id), validarVenda(v, hoje) || 'VALIDA']);
}

/**
 * Planeja (puro) a sequência de decisões de UM cliente, em ordem comercial, com o dono sombra evoluindo.
 * @returns {Array<{venda, d, revisaoVenda}>} só vendas válidas com data >= corte (e não futuras)
 */
function planejarSequenciaCliente({ vendasCliente, carteira, configs, situacaoDe, regra, hoje }) {
  const vistos = new Set();
  const validas = (vendasCliente || []).filter(v => !validarVenda(v, hoje)).filter(v => (vistos.has(String(v.id)) ? false : vistos.add(String(v.id))))
    .sort((a, b) => (chaveOrdem(a) < chaveOrdem(b) ? -1 : 1));
  let dono = (carteira && carteira.ownerUid) || null;
  const out = [];
  for (let i = 0; i < validas.length; i++) {
    const venda = validas[i];
    if (String(venda.data).slice(0, 10) < regra.ativoDesde) continue;           // antes do corte: só serve de histórico
    const rv = resolverVendedorPorGc(configs, venda.vendedor_id);
    const d = decidirVendaCarteira({ carteira: dono ? { ownerUid: dono } : null, anteriores: validas.slice(0, i), venda,
      vendedor: { ...rv, situacao: rv.uid ? situacaoDe(rv.uid) : null }, dono: dono ? situacaoDe(dono) : null, regra });
    out.push({ venda, d, revisaoVenda: revisaoComercialVenda(venda, hoje) });
    if (ALTERA_CARTEIRA.includes(d.decisao)) dono = d.ownerDepoisUid;             // dono sombra evolui (sem gravar nada oficial)
  }
  return out;
}

/** Reavalia TODA a sequência de um cliente numa transação e grava só as revisões novas (sombra). */
async function reavaliarClienteSombra(store, { gcCliente, agoraIso, regra, runId }) {
  const hoje = String(agoraIso).slice(0, 10);
  const portfolioId = portfolioAnchorFromGcId(gcCliente);
  const res = { criadas: 0, reavaliacoes: 0, invalidadas: 0, inalteradas: 0, porDecisaoSombra: {} };
  await store.runTransaction(async tx => {
    Object.assign(res, { criadas: 0, reavaliacoes: 0, invalidadas: 0, inalteradas: 0, porDecisaoSombra: {} });
    let identidadeErro = null;
    try { await resolverAncoraTx(tx, store, 'GC_NATIVE:' + gcCliente); } catch (e) {
      identidadeErro = 'IDENTIDADE_' + ((String(e.message).match(/\(([A-Z_]+)\)/) || [])[1] || 'NAO_RESOLVIDA');
    }
    const [vSnap, cSnap, configs, decPort] = await Promise.all([
      tx.get(store.collection('vendas_gc').where('cliente_id', '==', String(gcCliente))),
      tx.get(store.collection(COLL).doc(portfolioId)),
      lerConfigsVendedores(tx, store),
      tx.get(store.collection(COLL_DEC_SOMBRA).where('portfolioId', '==', portfolioId)),
    ]);
    const vendasCliente = vSnap.docs.map(d => d.data());
    const carteira = cSnap.exists ? cSnap.data() : null;
    // revisões existentes: por venda (global — a venda pode ter mudado de cliente)
    const idsVenda = [...new Set([...vendasCliente.map(v => String(v.id)), ...decPort.docs.map(d => String(d.data().vendaId))])];
    const docsDec = new Map(decPort.docs.map(d => [d.id, d.data()]));
    for (let i = 0; i < idsVenda.length; i += 30) {
      const s = await tx.get(store.collection(COLL_DEC_SOMBRA).where('vendaId', 'in', idsVenda.slice(i, i + 30)));
      for (const d of s.docs) docsDec.set(d.id, d.data());
    }
    const ultimaPorVenda = new Map();
    for (const d of docsDec.values()) {
      if (!Number.isInteger(d.revisao)) continue;                                   // decisões do formato anterior (N35.30) não participam
      const u = ultimaPorVenda.get(d.vendaId);
      if (!u || d.revisao > u.revisao) ultimaPorVenda.set(d.vendaId, d);
    }
    const uids = new Set(configs.map(c => c.uid)); if (carteira && carteira.ownerUid) uids.add(carteira.ownerUid);
    const sits = new Map();
    for (const uid of uids) sits.set(uid, await situacaoPorUid(tx, store, uid));
    const situacaoDe = uid => sits.get(uid) || situacaoVendedor(null, null);

    const plano = identidadeErro ? [] : planejarSequenciaCliente({ vendasCliente, carteira, configs, situacaoDe, regra, hoje });
    const escrever = [];
    const novoDoc = (venda, d, extra) => {
      const u = ultimaPorVenda.get(String(venda.id));
      const conteudo = [d.decisao, d.motivo, d.ownerAntesUid || null, d.ownerDepoisUid || null, d.vendedorUid || null, Number.isInteger(d.diasSemComprar) ? d.diasSemComprar : null,
        d.gestaoReview === true, String(venda.data || '').slice(0, 10), normalizeGestaoClickId(venda.vendedor_id) || null, portfolioId];
      const chave = sha8(conteudo);
      if (u && u.chaveConteudo === chave) { res.inalteradas++; return; }
      const revisao = u ? u.revisao + 1 : 1;
      const dataV = String(venda.data || '').slice(0, 10);
      const det = u ? u.diasAteDeteccao : Math.max(0, Math.round((Date.parse(hoje + 'T12:00:00Z') - Date.parse(dataV + 'T12:00:00Z')) / 86400000));
      const doc = { decisionId: idDecisaoV2(venda.id, revisao), vendaId: String(venda.id), portfolioId, dataVenda: dataV,
        vendedorGestaoClickId: normalizeGestaoClickId(venda.vendedor_id) || null, vendedorUid: d.vendedorUid || null, decisao: d.decisao, decisaoSombra: rotuloSombra(d),
        motivo: d.motivo, ownerAntesUid: d.ownerAntesUid || null, ownerDepoisUid: d.ownerDepoisUid || null,
        diasSemComprar: Number.isInteger(d.diasSemComprar) ? d.diasSemComprar : null, gestaoReview: d.gestaoReview === true, modo: 'SOMBRA', regraVersao: REGRA_VERSAO,
        processadoEm: agoraIso, runId: runId || null, revisao, substitui: u ? u.decisionId : null,
        causa: !u ? null : (extra.causa || (u.revisaoVenda !== extra.revisaoVenda ? 'VENDA_ALTERADA' : 'SEQUENCIA_ALTERADA')),
        revisaoVenda: extra.revisaoVenda || null, chaveConteudo: chave, vendaModificadaEm: TS_GC.test(String(venda.modificado_em || '')) ? venda.modificado_em : null,
        diasAteDeteccao: det, vendaTardia: det > JANELA_DATA_DIAS };
      const erro = validarDecisao(doc);
      if (erro) throw new Error('DECISAO_FORA_DA_WHITELIST:' + erro);
      escrever.push(doc);
      if (!u) res.criadas++; else if (d.decisao === 'VENDA_INVALIDADA') res.invalidadas++; else res.reavaliacoes++;
      res.porDecisaoSombra[doc.decisaoSombra] = (res.porDecisaoSombra[doc.decisaoSombra] || 0) + 1;
    };
    if (identidadeErro) {
      for (const v of vendasCliente.filter(x => !validarVenda(x, hoje) && String(x.data).slice(0, 10) >= regra.ativoDesde))
        novoDoc(v, { decisao: DECISOES.PENDENCIA_GESTAO, motivo: identidadeErro, ownerAntesUid: null, ownerDepoisUid: null, vendedorUid: null, diasSemComprar: null, gestaoReview: true },
          { revisaoVenda: revisaoComercialVenda(v, hoje) });
    }
    for (const p of plano) novoDoc(p.venda, p.d, { revisaoVenda: p.revisaoVenda });
    // vendas que tinham decisão vigente neste cliente e deixaram de ser decidíveis aqui (cancelada, movida, data < corte)
    const vigentes = new Set(identidadeErro ? vendasCliente.map(v => String(v.id)) : plano.map(p => String(p.venda.id)));
    for (const [vendaId, u] of ultimaPorVenda) {
      if (u.portfolioId !== portfolioId || vigentes.has(vendaId) || u.decisao === 'VENDA_INVALIDADA') continue;
      const v = vendasCliente.find(x => String(x.id) === vendaId);
      const motivo = !v ? 'VENDA_MOVIDA_OU_REMOVIDA' : validarVenda(v, hoje) ? 'VENDA_INVALIDADA_' + validarVenda(v, hoje) : 'VENDA_ANTES_DO_CORTE';
      novoDoc(v || { id: vendaId, data: u.dataVenda, vendedor_id: u.vendedorGestaoClickId }, { decisao: 'VENDA_INVALIDADA', motivo, ownerAntesUid: u.ownerAntesUid, ownerDepoisUid: u.ownerAntesUid,
        vendedorUid: u.vendedorUid, diasSemComprar: null, gestaoReview: false }, { revisaoVenda: v ? revisaoComercialVenda(v, hoje) : 'REMOVIDA', causa: v ? 'VENDA_ALTERADA' : 'VENDA_MOVIDA' });
    }
    for (const doc of escrever) tx.create(store.collection(COLL_DEC_SOMBRA).doc(doc.decisionId), doc);
  });
  return res;
}

/**
 * Execução SOMBRA segura para vendas atrasadas (N35.32). Nunca escreve carteira, histórico ou decisão oficial.
 * Checkpoint V2 próprio (checkpoint_sombra_v2); o checkpoint V1 (checkpoint_sombra) é preservado e não é mais usado.
 */
async function processarVendasSombraV2(store, { agoraIso, runId, regra }) {
  const inicioMs = Date.now();
  const hoje = String(agoraIso).slice(0, 10);
  const cpRef = store.collection(COLL_CONFIG).doc(COLL_CHECKPOINT_V2);
  const [cpSnap, syncSnap] = await Promise.all([cpRef.get(), store.collection('sync_state').doc('perfil360').get()]);
  const cp = cpSnap.exists && cpSnap.data().corte === regra.ativoDesde ? cpSnap.data() : null;     // corte mudou ⇒ recomeça
  const cursorSync = syncSnap.exists && TS_GC.test(String(syncSnap.data().modifiedSinceCursor || '')) ? syncSnap.data().modifiedSinceCursor : null;
  const agoraGc = agoraNoFusoGc(agoraIso);
  const resumo = { runId: runId || null, modo: 'SOMBRA', regraVersao: REGRA_VERSAO, mecanismo: 'MARCA_DAGUA_MODIFICADO_EM+JANELA_DATA', corte: regra.ativoDesde,
    checkpointAntes: cp ? cp.marcaDagua : null, checkpointDepois: null, cursorSync, lidas: 0, clientesReavaliados: 0,
    processadas: 0, reavaliacoes: 0, invalidadas: 0, inalteradas: 0, porDecisaoSombra: {}, ignoradasPorMotivo: {}, erros: 0, duracaoMs: 0 };
  // marca inicial: corte − 90 dias (cobre vendas pré-datadas); o corte comercial continua valendo para decidir
  const marca = cp ? cp.marcaDagua : diasAntes(regra.ativoDesde, 90) + ' 00:00:00';
  const desde = tsMais(marca, -SOBREPOSICAO_HORAS);
  const vistosAntes = new Set(cp && Array.isArray(cp.vistos) ? cp.vistos : []);
  const [snapA, snapB, decB] = await Promise.all([
    store.collection('vendas_gc').where('modificado_em', '>=', desde).get(),
    store.collection('vendas_gc').where('data', '>=', [regra.ativoDesde, diasAntes(hoje, JANELA_DATA_DIAS)].sort().pop()).get(),
    store.collection(COLL_DEC_SOMBRA).where('dataVenda', '>=', [regra.ativoDesde, diasAntes(hoje, JANELA_DATA_DIAS)].sort().pop()).get(),
  ]);
  const A = snapA.docs.map(d => d.data()).filter(v => v && v.id);
  const B = snapB.docs.map(d => d.data()).filter(v => v && v.id);
  resumo.lidas = A.length + B.length;
  const unicas = new Map([...A, ...B].map(v => [String(v.id), v]));
  for (const v of unicas.values()) {
    const m = validarVenda(v, hoje);
    if (m && String(v.data || '').slice(0, 10) >= regra.ativoDesde) resumo.ignoradasPorMotivo[m] = (resumo.ignoradasPorMotivo[m] || 0) + 1;
  }
  const decididasB = new Set(decB.docs.map(d => String(d.data().vendaId)));
  const clientes = new Set(), antigos = new Set();
  for (const v of A) {
    const gc = normalizeGestaoClickId(v.cliente_id);
    if (!gc || vistosAntes.has(String(v.id) + '|' + v.modificado_em)) continue;
    // venda com data >= corte: sempre reavalia; venda anterior ao corte só importa se o cliente já tem decisão sombra
    if (String(v.data || '').slice(0, 10) >= regra.ativoDesde) clientes.add(gc); else antigos.add(gc);
  }
  // venda que MUDOU de cliente: a decisão antiga fica no cliente anterior ⇒ reavaliar também quem tem decisão desta venda
  const idsA = [...new Set(A.filter(v => !vistosAntes.has(String(v.id) + '|' + v.modificado_em)).map(v => String(v.id)))];
  for (let i = 0; i < idsA.length; i += 30) {
    const s = await store.collection(COLL_DEC_SOMBRA).where('vendaId', 'in', idsA.slice(i, i + 30)).get();
    for (const d of s.docs) if (d.data().portfolioId) clientes.add(String(d.data().portfolioId).slice(3));
  }
  const listaAntigos = [...antigos].filter(gc => !clientes.has(gc));
  for (let i = 0; i < listaAntigos.length; i += 30) {
    const s = await store.collection(COLL_DEC_SOMBRA).where('portfolioId', 'in', listaAntigos.slice(i, i + 30).map(g => portfolioAnchorFromGcId(g))).get();
    for (const d of s.docs) clientes.add(String(d.data().portfolioId).slice(3));
  }
  for (const v of B) if (!validarVenda(v, hoje) && !decididasB.has(String(v.id))) clientes.add(normalizeGestaoClickId(v.cliente_id));
  for (const gc of [...clientes].sort()) {
    try {
      const r = await reavaliarClienteSombra(store, { gcCliente: gc, agoraIso, regra, runId });
      resumo.clientesReavaliados++;
      resumo.processadas += r.criadas; resumo.reavaliacoes += r.reavaliacoes; resumo.invalidadas += r.invalidadas; resumo.inalteradas += r.inalteradas;
      for (const [k, n] of Object.entries(r.porDecisaoSombra)) resumo.porDecisaoSombra[k] = (resumo.porDecisaoSombra[k] || 0) + n;
    } catch (e) {
      resumo.erros++;
      console.error(JSON.stringify({ job: 'carteiraRegra', runId: runId || null, cliente: 'GC:' + gc, erro: String(e && e.message || e).slice(0, 200) }));
    }
  }
  if (resumo.erros === 0) {
    const maxVisto = A.map(v => v.modificado_em).filter(t => TS_GC.test(String(t || ''))).sort().pop() || marca;
    const nova = [marca, [maxVisto, cursorSync || maxVisto, agoraGc].sort()[0]].sort().pop();      // nunca recua; nunca passa do sync nem do agora
    const limiteVistos = tsMais(nova, -SOBREPOSICAO_HORAS);
    const vistos = A.filter(v => TS_GC.test(String(v.modificado_em || '')) && v.modificado_em >= limiteVistos).map(v => String(v.id) + '|' + v.modificado_em).sort();
    await cpRef.set({ versao: 2, corte: regra.ativoDesde, marcaDagua: nova, vistos, ultimaExecucaoOk: agoraIso, runId: runId || null, regraVersao: REGRA_VERSAO,
      clientesReavaliados: resumo.clientesReavaliados });
    resumo.checkpointDepois = nova;
  } else resumo.checkpointDepois = resumo.checkpointAntes;                               // falhou ⇒ não avança
  resumo.duracaoMs = Date.now() - inicioMs;
  return { status: resumo.erros ? 'ERRO_PARCIAL' : 'OK', ...resumo };
}

// ── Execução em lote com corte + checkpoint ──────────────────────────────────
function diasAntes(ymd, n) { return new Date(Date.parse(ymd + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10); }
const refCheckpoint = (store, modo) => store.collection(COLL_CONFIG).doc(modo === 'SOMBRA' ? 'checkpoint_sombra' : 'checkpoint_ativo');

/**
 * Processa as vendas a partir do corte de ativação, em ordem (data, id), pulando as já decididas.
 * Janela: data >= max(corte, maiorDataAvaliada - 7 dias) — o checkpoint só avança se a execução terminar sem erro.
 * Primeira execução (sem checkpoint): janela = corte; vendas anteriores ao corte nunca são lidas como novas.
 * Também sinaliza venda que perdeu validade DEPOIS de uma decisão que alteraria carteira (sem reverter nada).
 */
async function processarVendasRecentes(store, { agoraIso, forcarSombra, runId }) {
  const inicioMs = Date.now();
  const regraSnap = await store.collection(REF_CONFIG[0]).doc(REF_CONFIG[1]).get();
  const regraDoc = regraSnap.exists ? regraSnap.data() : null;
  const regra = lerRegra(regraDoc);
  const modo = modoEfetivo(regra, forcarSombra);
  const resumo = { runId: runId || null, modo, regraVersao: REGRA_VERSAO, corte: regra.ativoDesde || null, checkpointAntes: null, checkpointDepois: null,
    lidas: 0, processadas: 0, porDecisao: {}, porDecisaoSombra: {}, jaProcessadas: 0, ignoradas: 0, ignoradasPorMotivo: {}, invalidadasAposDecisao: 0, erros: 0, duracaoMs: 0 };
  if (modo === 'DESLIGADO') { resumo.duracaoMs = Date.now() - inicioMs; return { status: 'DESLIGADO', ...resumo }; }
  // N35.32: SOMBRA usa o mecanismo seguro para vendas atrasadas. O caminho abaixo (janela por data) fica só para o
  // modo ATIVO, que NÃO está publicado e precisará do mesmo mecanismo antes de qualquer ativação.
  if (modo === 'SOMBRA') return processarVendasSombraV2(store, { agoraIso, runId, regra });
  const collDec = modo === 'SOMBRA' ? COLL_DEC_SOMBRA : COLL_DEC;
  const cpRef = refCheckpoint(store, modo);
  const cpSnap = await cpRef.get();
  const cp = cpSnap.exists && cpSnap.data().corte === regra.ativoDesde ? cpSnap.data() : null;   // corte mudou ⇒ checkpoint descartado
  resumo.checkpointAntes = cp ? cp.maiorDataAvaliada || null : null;
  const inicio = [regra.ativoDesde, cp && cp.maiorDataAvaliada ? diasAntes(cp.maiorDataAvaliada, JANELA_REVISITA_DIAS) : null].filter(Boolean).sort().pop();
  const hoje = String(agoraIso).slice(0, 10);
  const [snap, decSnap] = await Promise.all([
    store.collection('vendas_gc').where('data', '>=', inicio).get(),
    store.collection(collDec).where('dataVenda', '>=', inicio).get(),
  ]);
  const decididas = new Map(decSnap.docs.map(d => [d.id, d.data()]));
  const vendas = snap.docs.map(d => d.data()).filter(v => v && v.id).sort((a, b) => (chaveOrdem(a) < chaveOrdem(b) ? -1 : 1));
  resumo.lidas = vendas.length;
  let maior = cp ? cp.maiorDataAvaliada || null : null;
  for (const v of vendas) {
    const dataV = String(v.data).slice(0, 10);
    const ja = decididas.get(idDecisao(v.id));
    try {
      if (ja) {
        resumo.jaProcessadas++;
        if (validarVenda(v, hoje) && ALTERA_CARTEIRA.includes(ja.decisao)) {
          const ref = store.collection(collDec).doc(idDecisao(v.id) + '_INVALIDADA');
          const doc = { decisionId: idDecisao(v.id) + '_INVALIDADA', vendaId: String(v.id), portfolioId: ja.portfolioId, dataVenda: dataV,
            decisao: DECISOES.PENDENCIA_GESTAO, decisaoSombra: 'REVISAO_GESTAO', motivo: 'VENDA_INVALIDADA_APOS_DECISAO', gestaoReview: true,
            modo, regraVersao: REGRA_VERSAO, processadoEm: agoraIso, runId: runId || null };
          try { await ref.create(doc); resumo.invalidadasAposDecisao++; }
          catch (e) { if (!(e && (e.code === 6 || e.code === 'already-exists'))) throw e; }
        }
      } else {
        const r = await processarVendaCarteira(store, { vendaId: v.id, agoraIso, regraDoc, forcarSombra, runId });
        if (r.status === 'JA_PROCESSADA') resumo.jaProcessadas++;
        else if (r.status === 'IGNORADA') { resumo.ignoradas++; resumo.ignoradasPorMotivo[r.motivo] = (resumo.ignoradasPorMotivo[r.motivo] || 0) + 1; }
        else if (r.status === 'PROCESSADA') {
          resumo.processadas++;
          resumo.porDecisao[r.decisao] = (resumo.porDecisao[r.decisao] || 0) + 1;
          const rs = rotuloSombra(r); resumo.porDecisaoSombra[rs] = (resumo.porDecisaoSombra[rs] || 0) + 1;
        }
      }
      if (dataV >= regra.ativoDesde && dataV <= hoje && (!maior || dataV > maior)) maior = dataV;
    } catch (e) {
      resumo.erros++;
      console.error(JSON.stringify({ job: 'carteiraRegra', runId: runId || null, vendaId: String(v.id), erro: String(e && e.message || e).slice(0, 200) }));
    }
  }
  if (resumo.erros === 0) {
    await cpRef.set({ corte: regra.ativoDesde, maiorDataAvaliada: maior, ultimaExecucaoOk: agoraIso, runId: runId || null, modo, regraVersao: REGRA_VERSAO,
      processadas: resumo.processadas }, { merge: false });
    resumo.checkpointDepois = maior;
  } else resumo.checkpointDepois = resumo.checkpointAntes;                              // falhou ⇒ checkpoint NÃO avança
  resumo.duracaoMs = Date.now() - inicioMs;
  return { status: resumo.erros ? 'ERRO_PARCIAL' : 'OK', ...resumo };
}

/** Desligamento: NUNCA redistribui. Só informa o que exige ação administrativa. Puro. */
function avaliarDesligamento({ carteiras, uid }) {
  const afetadas = (carteiras || []).filter(c => c.ownerUid === uid);
  return { AUTO_REDISTRIBUTION: 0, AUTO_TRANSFER: 0, MANAGEMENT_ACTION_REQUIRED: afetadas.length > 0, carteirasAfetadas: afetadas.length,
    acao: afetadas.length ? 'TRANSFERENCIA_ADMINISTRATIVA (prévia + motivo + confirmação)' : 'NENHUMA' };
}

module.exports = {
  validarVenda, vendasAnteriores, situacaoVendedor, isPortfolioEligibleSeller, resolverVendedorPorGc, lerRegra, modoEfetivo,
  decidirVendaCarteira, rotuloSombra, validarDecisao, processarVendaCarteira, processarVendasRecentes, avaliarDesligamento, idDecisao,
  planejarSequenciaCliente, reavaliarClienteSombra, processarVendasSombraV2, revisaoComercialVenda, idDecisaoV2, tsMais, agoraNoFusoGc,
  DECISOES, CAMPOS_DECISAO, COLL, COLL_HIST, COLL_DEC, COLL_DEC_SOMBRA, COLL_CONFIG, COLL_CHECKPOINT_V2, REF_CONFIG, REGRA_VERSAO, OPERADOR_SISTEMA,
  DIAS_REATIVACAO, SOBREPOSICAO_HORAS, JANELA_DATA_DIAS,
};
