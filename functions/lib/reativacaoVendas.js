'use strict';
/**
 * B3.2 — processamento IDEMPOTENTE de vendas novas / alteradas / canceladas / devolvidas para o motor B3. PREPARADO E INATIVO:
 * sem agendador, não exportado por index.js; modo vem de carteira_comercial_config/reativacao { modo, corte } e é limitado pela trava FORCAR_DRY.
 *   DESLIGADO (padrão/ausente) → nada; DRY → calcula e devolve, ZERO escritas; SOMBRA → grava só decisões em carteira_reativacao_decisoes_sombra (sem ownership);
 *   ATIVO → aplica via reativacaoOps (exige motor B3 autorizado) — bloqueado enquanto FORCAR_DRY=true.
 * Regras: só vendas com data >= corte (nunca retroativo); venda da gestão é NEUTRA; venda fora de ordem NÃO é aplicada (revisão da gestão);
 * decisão por venda é create-only com revisão (nova revisão só quando o conteúdo comercial da venda muda); devolução só da coleção controlada.
 */
const crypto = require('crypto');
const R = require('./reativacao120'); const OPS = require('./reativacaoOps'); const REV = require('./reativacaoReversao'); const { carregarContexto } = require('./reativacaoContexto');
const { validarVenda } = require('./carteiraRegra'); const { normalizeGestaoClickId } = require('./commercialIdentity'); const A = require('./auditoria');

const FORCAR_DRY = false;      // B3.3: trava removida — segurança = configuração (modo/motor/corte) + disjuntor de saúde + kill switch
const REF_CONFIG = ['carteira_comercial_config', 'reativacao'];
const COLL_DEC = 'carteira_reativacao_decisoes', COLL_DEC_SOMBRA = 'carteira_reativacao_decisoes_sombra';
const REGRA_VERSAO = 'B3.2';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const sha8 = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const idDec = (vendaId, rev) => `B3_${String(vendaId).replace(/[^A-Za-z0-9_-]/g, '_')}_r${rev}`;
/** Campos da venda que mudam a decisão (data, cliente, vendedor, validade). Outras edições não geram nova revisão. */
const revisaoVenda = (v, hoje, devolucoes) => sha8([String(v.data || '').slice(0, 10), normalizeGestaoClickId(v.cliente_id), normalizeGestaoClickId(v.vendedor_id), validarVenda(v, hoje) || 'VALIDA', devolucoes && devolucoes.get(String(v.id)) === 'TOTAL' ? 'DEV_TOTAL' : '']);
const CAMPOS = ['decisionId', 'vendaId', 'portfolioId', 'dataVenda', 'vendedorUid', 'decisao', 'motivo', 'ownerAntesUid', 'ownerDepoisUid', 'creditoUid', 'gestaoReview', 'modo', 'revisao', 'revisaoVenda', 'regraVersao', 'processadoEm', 'runId', 'reservaChave'];
function docDecisao(v, d, modo, rev, rv, agoraIso, runId) {
  const doc = { decisionId: idDec(v.id, rev), vendaId: String(v.id), portfolioId: 'GC:' + normalizeGestaoClickId(v.cliente_id), dataVenda: String(v.data).slice(0, 10), vendedorUid: d.creditoUid || null, decisao: d.decisao, motivo: d.motivo,
    ownerAntesUid: d.ownerAntesUid || null, ownerDepoisUid: d.ownerDepoisUid || null, creditoUid: d.creditoUid || null, gestaoReview: d.gestaoReview === true, modo, revisao: rev, revisaoVenda: rv, regraVersao: REGRA_VERSAO,
    processadoEm: agoraIso, runId: runId || null, reservaChave: (d.referencias && d.referencias.reservaChave) || null };
  const extras = Object.keys(doc).filter(k => !CAMPOS.includes(k)); if (extras.length) throw new Error('DECISAO_FORA_DA_WHITELIST:' + extras.join(','));
  return doc;
}
/** Modo efetivo: ausente/inválido ⇒ DESLIGADO; FORCAR_DRY limita a DRY. */
function modoEfetivo(cfg, forcarDry) {
  const m = ['DESLIGADO', 'DRY', 'SOMBRA', 'ATIVO'].includes(cfg && cfg.modo) ? cfg.modo : 'DESLIGADO';
  if (m === 'DESLIGADO') return 'DESLIGADO';
  if (forcarDry === true) return 'DRY';
  return m;
}

async function processarVendas(store, FieldValue, { agoraIso, forcarDry = FORCAR_DRY, runId = null, modoForcado = null, cfgOverride = null } = {}) {
  const cfgSnap = cfgOverride ? null : await store.doc(REF_CONFIG.join('/')).get(); const cfg = cfgOverride || (cfgSnap.exists ? cfgSnap.data() : null);       // cfgOverride: simulação (dry-run de impacto) sem depender do documento de configuração
  const modo = modoForcado ? modoEfetivo({ modo: modoForcado }, forcarDry) : modoEfetivo(cfg, forcarDry);
  if (modo === 'DESLIGADO') return { status: 'DESLIGADO' };
  const corte = cfg && YMD.test(String(cfg.corte)) ? cfg.corte : null;
  if (!corte) return { status: 'SEM_CORTE', modo: 'DESLIGADO', motivo: 'carteira_comercial_config/reativacao.corte ausente — sem corte não há processamento (nada retroativo)' };
  const hoje = agoraIso.slice(0, 10);
  if (modo === 'ATIVO') {                                                               // saúde e motor ANTES de qualquer escrita
    const SA = require('./reativacaoSaude'); const MOTOR = require('./motorCarteira'); const h = await SA.verificarSaude(store, { cfg: cfg || {}, desde: (cfg && cfg.ativadoEm) || null });
    if (!h.ok) { await SA.dispararDisjuntor(store, FieldValue, h.violacoes, { agoraIso, origem: 'PROCESSADOR_VENDAS' }); return { status: 'DISJUNTOR', violacoes: h.violacoes }; }
    const m = MOTOR.lerMotor((await store.doc(MOTOR.REF.join('/')).get()).data()); if (m !== 'B3') return { status: 'MOTOR_NAO_B3', motor: m };
  }
  const corteTs = cfg && cfg.corteTs && !isNaN(Date.parse(cfg.corteTs)) ? Date.parse(cfg.corteTs) : null;
  /** Venda posterior ao instante de ativação: cadastrado_em (hora de Fortaleza, UTC-3) >= corteTs; sem cadastrado_em ⇒ só se a DATA for posterior ao dia do corte (conservador). */
  const depoisDoCorte = v => { if (!corteTs) return true; const c = String(v.cadastrado_em || ''); if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c)) return Date.parse(c.replace(' ', 'T') + '-03:00') >= corteTs; return String(v.data).slice(0, 10) > corte; };
  const ctx = await carregarContexto(store, { hoje });
  const decSnap = await store.collection(modo === 'ATIVO' ? COLL_DEC : COLL_DEC_SOMBRA).get(); const feitas = new Map();               // vendaId → { revisao, revisaoVenda }
  decSnap.docs.forEach(d => { const x = d.data(); const k = String(x.vendaId); if (!feitas.has(k) || x.revisao > feitas.get(k).revisao) feitas.set(k, x); });
  const out = { status: 'OK', modo, corte, hoje, vendasAvaliadas: 0, ignoradasAntesDoCorte: 0, jaProcessadas: 0, novas: 0, novasRevisoes: 0, foraDeOrdem: [], decisoes: {}, aplicadas: 0, erros: [], porClienteComRevisao: [] };
  const aGravar = [];
  for (const [gc, todas] of ctx.vendasPorCliente) {
    const posCorte = todas.filter(v => String(v.data || '').slice(0, 10) >= corte && String(v.data || '').length >= 10 && depoisDoCorte(v)).sort((a, b) => (R.chaveOrdem(a) < R.chaveOrdem(b) ? -1 : 1));
    out.ignoradasAntesDoCorte += todas.length - posCorte.length; if (!posCorte.length) continue;
    const pend = posCorte.filter(v => { const f = feitas.get(String(v.id)); return !f || f.revisaoVenda !== revisaoVenda(v, hoje, ctx.devolucoes); });
    out.vendasAvaliadas += posCorte.length; out.jaProcessadas += posCorte.length - pend.length; if (!pend.length) continue;
    // venda fora de ordem (nova venda com data anterior a uma já decidida): NÃO aplica automaticamente
    const maiorFeita = posCorte.filter(v => feitas.has(String(v.id))).map(R.chaveOrdem).sort().pop();
    const portfolioId = 'GC:' + gc; const cart0 = ctx.carteiras.get(portfolioId) || null;
    const reservas = new Map(); for (const [k, r] of ctx.reservasExistentes) if (r.portfolioId === portfolioId) reservas.set(k, r);
    const seq = R.sequenciaB3({ vendasCliente: todas, carteiraInicial: cart0 ? { ...cart0 } : null, vend: ctx.vend, reservas, hoje, devolucoes: ctx.devolucoes, conflitoGc: ctx.conflitosGc, corte });
    const porVenda = new Map(seq.map(s => [String(s.venda.id), s.d]));
    for (const v of pend) {
      const vid = String(v.id); const inval = validarVenda(v, hoje); const d = porVenda.get(vid);
      const f = feitas.get(vid); const rev = f ? f.revisao + 1 : 1;
      const decisao = d || { decisao: 'IGNORAR_INVALIDA', motivo: inval || (ctx.devolucoes.get(vid) === 'TOTAL' ? 'DEVOLUCAO_TOTAL' : 'SEM_DECISAO'), ownerAntesUid: cart0 ? cart0.ownerUid : null, ownerDepoisUid: cart0 ? cart0.ownerUid : null, creditoUid: null, gestaoReview: false, referencias: null };
      const fora = !f && maiorFeita && R.chaveOrdem(v) < maiorFeita;
      if (fora) { out.foraDeOrdem.push(vid); decisao.gestaoReview = true; decisao.decisao = 'FORA_DE_ORDEM'; decisao.motivo = 'VENDA_FORA_DE_ORDEM_REVISAO_DA_GESTAO'; decisao.ownerDepoisUid = decisao.ownerAntesUid; }
      out.decisoes[decisao.decisao] = (out.decisoes[decisao.decisao] || 0) + 1; f ? out.novasRevisoes++ : out.novas++;
      aGravar.push({ v, decisao, rev, rv: revisaoVenda(v, hoje, ctx.devolucoes), cart0 });
    }
  }
  if (modo === 'SOMBRA' || modo === 'ATIVO') {
    for (const g of aGravar) {
      try {
        if (modo === 'ATIVO' && R.ALTERA_OWNER.concat(R.RENOVA_CICLO).includes(g.decisao.decisao)) {                      // aplica ANTES de registrar a decisão; relê o estado atual
          const atual = (await store.collection('carteira_comercial').doc('GC:' + normalizeGestaoClickId(g.v.cliente_id)).get()); const reservas = await OPS.carregarReservasDoCliente(store, 'GC:' + normalizeGestaoClickId(g.v.cliente_id));
          const dReal = R.decidirVendaB3({ venda: g.v, vendasCliente: ctx.vendasPorCliente.get(normalizeGestaoClickId(g.v.cliente_id)), carteira: atual.exists ? atual.data() : null, vend: ctx.vend, reservas, hoje, devolucoes: ctx.devolucoes, conflitoGc: ctx.conflitosGc });
          const r = await OPS.aplicarDecisaoVenda(store, FieldValue, { decisao: dReal, venda: g.v, carteira: atual.exists ? atual.data() : null, agoraIso }); if (!r.ignorado && !r.repetido) out.aplicadas++; g.decisao = dReal;
        }
        await store.collection(modo === 'ATIVO' ? COLL_DEC : COLL_DEC_SOMBRA).doc(idDec(g.v.id, g.rev)).create(docDecisao(g.v, g.decisao, modo, g.rev, g.rv, agoraIso, runId));
      } catch (e) { if (!(e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))))) out.erros.push({ vendaId: String(g.v.id), erro: e.message }); }
    }
  }
  // invalidações: transferências/criações cuja venda deixou de valer ⇒ reversão (DRY: só relata; ATIVO: executa/encaminha à gestão); renovações invalidadas ⇒ revisão
  if (modo === 'ATIVO' && out.erros.length) { const SA = require('./reativacaoSaude'); await SA.dispararDisjuntor(store, FieldValue, out.erros.map(e => ({ tipo: 'ERRO_NO_PROCESSAMENTO_DE_VENDAS', vendaId: e.vendaId })), { agoraIso, origem: 'PROCESSADOR_VENDAS' }); out.status = 'DISJUNTOR_ERRO'; return out; }
  out.reversoes = await varrerInvalidacoes(store, FieldValue, { hoje, agoraIso, executar: modo === 'ATIVO', devolucoes: ctx.devolucoes });
  return out;
}

/** Eventos criados pelo B3 (chaves B3:…:<vendaId>) cuja venda hoje é inválida. */
async function varrerInvalidacoes(store, FieldValue, { hoje, agoraIso, executar }) {
  const evs = await store.collection('carteira_comercial_historico').where('schemaVersion', '==', 'historico-v2').get(); const r = { candidatas: 0, reverter: 0, ambiguas: 0, renovacoesInvalidadas: 0, executadas: 0, detalhes: [] };
  for (const d of evs.docs) {
    const e = d.data(); const m = /^B3:(TRANSFERIR_REATIVACAO|CRIAR_VIA_REATIVACAO|CRIAR_PRIMEIRA_VENDA|RENOVAR_OWNER|COBERTURA_RENOVA_OWNER|COBERTURA_PAUSA):(\d+)$/.exec(e.chaveIdempotencia || ''); if (!m) continue;
    const vendaId = m[2]; const sv = await store.collection('vendas_gc').doc(vendaId).get(); const dev = await store.collection('carteira_comercial_devolucoes').where('vendaId', '==', vendaId).get();
    const invalida = !sv.exists || !!validarVenda({ id: sv.id, ...sv.data() }, hoje) || dev.docs.some(x => x.data().tipo === 'TOTAL'); if (!invalida) continue;
    if (['TRANSFERIR_REATIVACAO', 'CRIAR_VIA_REATIVACAO', 'CRIAR_PRIMEIRA_VENDA'].includes(m[1])) {
      r.candidatas++; const av = await REV.avaliarReversao(store, { portfolioId: e.portfolioId, vendaId, hoje }); if (av.decisao === 'REVERTER') r.reverter++; else if (av.decisao === 'AMBIGUA') r.ambiguas++;
      r.detalhes.push({ portfolioId: e.portfolioId, vendaId, acao: av.decisao, motivos: av.motivos });
      if (executar && av.decisao !== 'NAO_NECESSARIA') { const x = await REV.executarReversao(store, FieldValue, { portfolioId: e.portfolioId, vendaId, operadorUid: null, agoraIso }); if (x.status === 'REVERTIDA') r.executadas++; }
    } else {                                                                                                   // renovação cuja venda caiu: o âncora do ciclo ficou "esticado" ⇒ revisão da gestão (não corrige sozinho)
      r.renovacoesInvalidadas++; r.detalhes.push({ portfolioId: e.portfolioId, vendaId, acao: 'RENOVACAO_INVALIDADA_REVISAO' });
      if (executar) await REV.registrarRevisao(store, FieldValue, { portfolioId: e.portfolioId, vendaId, motivos: ['RENOVACAO_INVALIDADA'], agoraIso });
    }
  }
  return r;
}
module.exports = { FORCAR_DRY, REF_CONFIG, COLL_DEC, COLL_DEC_SOMBRA, modoEfetivo, processarVendas, varrerInvalidacoes, revisaoVenda, idDec, docDecisao };
