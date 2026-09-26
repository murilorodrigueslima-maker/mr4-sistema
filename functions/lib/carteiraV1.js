'use strict';
// N35.25 — Carteira Comercial V1 (definitiva, LOCAL; nada é gravado em produção por este módulo).
//
// Decisões do proprietário (N35.25):
//   D1 Modelo C  — carteira persiste após 120 dias; reativação ABERTA derivada (nunca armazenada);
//                  claim / outcome / venda NÃO transferem; só transferência administrativa explícita.
//   D2 N3        — origem comercial ≠ carteira; quem nunca comprou fica sem carteira até a 1ª venda.
//   D5 Híbrida   — MR4 é mestre da carteira; GestãoClick = cadastro, vendas, vendedor da venda, origem histórica.
//                  O GC nunca sobrescreve a carteira; divergência vira fato/alerta.
//   D6           — preferência de carteira na distribuição só para relacionamento ativo (< 120 dias). SIMULADO aqui.
//
// FRONTEIRA DOS 120 DIAS (regra existente do sistema, não inventada aqui):
//   perfil360.js:414  `inativo120d = diasSemComprar >= 120`  ("exatamente 120 = inativo")
//   oportunidades.js  REATIVACAO_120D quando inativo120d (>= 120)
//   ⇒ 119 = FECHADA · 120 = ABERTA · 121 = ABERTA.
//
// Este módulo é PURO: sem banco, sem rede, sem relógio implícito (referenceDate é sempre explícito).

const { buildCommercialEntityId, portfolioAnchorFromGcId, resolvePortfolioAnchor, knownIdentitiesForGc, PORTFOLIO_ANCHOR_RE } = require('./commercialIdentity');
// N35.25.1: a carteira é gravada sob a ÂNCORA ESTÁVEL "GC:<gcId>" (commercialIdentity.resolvePortfolioAnchor),
// nunca sob o commercialEntityId da fila (que muda de GC_NATIVE para MR4_LINKED quando o cliente é vinculado).
const { classificarFontes, grupoMigracao } = require('./carteiraComercial');

const DIAS_REATIVACAO = 120;
const SCHEMA = 'carteira-v1';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ENT_RE = /^(GC_NATIVE:\d{1,20}|MR4_LINKED:[A-Za-z0-9_-]{1,40})$/;
const TIPOS_EVENTO = Object.freeze(['CARTEIRA_CRIADA', 'TRANSFERENCIA', 'CORRECAO_ADMINISTRATIVA']);
// Campos do documento de carteira (whitelist). Justificativa de cada um no relatório N35.25.
const CAMPOS_CARTEIRA = Object.freeze(['schemaVersion', 'portfolioId', 'ownerUid', 'ownerDesde',
  'origemComercialUid', 'origemComercialGestaoClickId', 'criadoEm', 'atualizadoEm', 'versao']);
const CAMPOS_HISTORICO = Object.freeze(['portfolioId', 'identidadeUsada', 'tipoEvento', 'ownerAnteriorUid', 'ownerNovoUid',
  'motivo', 'operadorUid', 'criadoEm', 'versao', 'chaveIdempotencia']);
const PROIBIDO = /nome|cpf|cnpj|telefone|email|endereco|faturamento|ticket|margem|lucro|custo|score|ranking|reativacao|diasSemComprar|ultimaCompra|ultimaVenda|predominante/i;

function diasEntre(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }

/**
 * Estado DERIVADO de reativação (nunca persistido).
 * @param {{ ultimaCompraEm: 'YYYY-MM-DD'|null, referenceDate: 'YYYY-MM-DD', dias?: number }} p
 * @returns {{ estado: 'FECHADA'|'ABERTA'|'SEM_COMPRA'|'DATA_INVALIDA', reativacaoAberta: boolean, diasSemComprar: number|null }}
 */
function calcularReativacao({ ultimaCompraEm, referenceDate, dias = DIAS_REATIVACAO } = {}) {
  if (typeof referenceDate !== 'string' || !YMD.test(referenceDate)) throw new Error('calcularReativacao: referenceDate explícito (YYYY-MM-DD) é obrigatório');
  if (ultimaCompraEm === null || ultimaCompraEm === undefined || ultimaCompraEm === '') return { estado: 'SEM_COMPRA', reativacaoAberta: false, diasSemComprar: null };
  const d = String(ultimaCompraEm).slice(0, 10);
  if (!YMD.test(d) || !Number.isFinite(Date.parse(d + 'T12:00:00Z'))) return { estado: 'DATA_INVALIDA', reativacaoAberta: false, diasSemComprar: null };
  const n = diasEntre(d, referenceDate);
  if (n < 0) return { estado: 'DATA_INVALIDA', reativacaoAberta: false, diasSemComprar: null }; // compra no futuro
  const aberta = n >= dias;
  return { estado: aberta ? 'ABERTA' : 'FECHADA', reativacaoAberta: aberta, diasSemComprar: n };
}

/** commercialEntityId canônico a partir do cliente GC (+ vínculo MR4, se existir). Reusa commercialIdentity. */
function entidadeDoClienteGc(gcId, mr4IdVinculado) {
  return mr4IdVinculado ? buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: mr4IdVinculado })
    : buildCommercialEntityId({ source: 'GC_NATIVE', gestaoClickId: String(gcId) });
}

/** Documento V1 (valida whitelist; rejeita qualquer campo proibido/derivável). */
function montarDocCarteiraV1({ portfolioId, ownerUid, ownerDesde, origemComercialUid, origemComercialGestaoClickId, criadoEm, atualizadoEm, versao }) {
  if (!PORTFOLIO_ANCHOR_RE.test(String(portfolioId || ''))) throw new Error('portfolioId inválido (esperado GC:<gcId>)');
  if (!Number.isInteger(versao) || versao < 1) throw new Error('versao inválida');
  return { schemaVersion: SCHEMA, portfolioId, ownerUid: ownerUid || null, ownerDesde: ownerUid ? (ownerDesde || null) : null,
    origemComercialUid: origemComercialUid || null, origemComercialGestaoClickId: origemComercialGestaoClickId || null,
    criadoEm, atualizadoEm, versao };
}
function validarDocCarteiraV1(doc) {
  const extras = Object.keys(doc || {}).filter(k => !CAMPOS_CARTEIRA.includes(k));
  if (extras.length) return 'CAMPOS_NAO_PERMITIDOS:' + extras.join(',');
  const valores = Object.keys(doc).filter(k => PROIBIDO.test(k));
  if (valores.length) return 'CAMPO_PROIBIDO:' + valores.join(',');
  if (!PORTFOLIO_ANCHOR_RE.test(String(doc.portfolioId))) return 'ANCORA_INVALIDA';
  return null;
}
function montarEventoHistoricoV1({ portfolioId, identidadeUsada, tipoEvento, ownerAnteriorUid, ownerNovoUid, motivo, operadorUid, criadoEm, versao, chaveIdempotencia }) {
  if (!TIPOS_EVENTO.includes(tipoEvento)) throw new Error('tipoEvento inválido: ' + tipoEvento);
  if (!PORTFOLIO_ANCHOR_RE.test(String(portfolioId || ''))) throw new Error('portfolioId inválido');
  return { portfolioId, identidadeUsada: identidadeUsada || null, tipoEvento, ownerAnteriorUid: ownerAnteriorUid || null, ownerNovoUid: ownerNovoUid || null,
    motivo: motivo || null, operadorUid: operadorUid || null, criadoEm, versao, ...(chaveIdempotencia ? { chaveIdempotencia } : {}) };
}

/**
 * N3 — primeira venda cria a carteira (MODELO; nesta fase nada é gravado automaticamente).
 * Idempotente: chave = PRIMEIRA_VENDA:<vendaId>; carteira com owner já existente → NENHUMA.
 * @returns {{ acao:'CRIAR'|'NENHUMA', motivo?, chaveIdempotencia, doc?, evento? }}
 */
function planejarPrimeiraVenda({ portfolioId, identidadeUsada, carteiraAtual, venda, origemComercialUid, origemComercialGestaoClickId, agoraIso, historicoChaves }) {
  if (!venda || !venda.vendaId || !venda.sellerUid) throw new Error('venda com vendaId e sellerUid obrigatória');
  const chave = 'PRIMEIRA_VENDA:' + venda.vendaId;
  if (historicoChaves && historicoChaves.has && historicoChaves.has(chave)) return { acao: 'NENHUMA', motivo: 'VENDA_JA_PROCESSADA', chaveIdempotencia: chave };
  if (carteiraAtual && carteiraAtual.ownerUid) return { acao: 'NENHUMA', motivo: 'CARTEIRA_JA_EXISTE', chaveIdempotencia: chave };
  const versao = ((carteiraAtual && carteiraAtual.versao) || 0) + 1;
  const doc = montarDocCarteiraV1({ portfolioId, ownerUid: venda.sellerUid, ownerDesde: agoraIso,
    origemComercialUid: (carteiraAtual && carteiraAtual.origemComercialUid) || origemComercialUid,
    origemComercialGestaoClickId: (carteiraAtual && carteiraAtual.origemComercialGestaoClickId) || origemComercialGestaoClickId,
    criadoEm: (carteiraAtual && carteiraAtual.criadoEm) || agoraIso, atualizadoEm: agoraIso, versao });
  const evento = montarEventoHistoricoV1({ portfolioId, identidadeUsada, tipoEvento: 'CARTEIRA_CRIADA', ownerAnteriorUid: null, ownerNovoUid: venda.sellerUid,
    motivo: 'Primeira compra (N3)', operadorUid: null, criadoEm: agoraIso, versao, chaveIdempotencia: chave });
  return { acao: 'CRIAR', chaveIdempotencia: chave, doc, evento };
}

// ── Prévia de migração (em memória) ─────────────────────────────────────────
/**
 * @param {object} p
 *   clientes: [{ gcId, cad, ult, pred, comprou, ultimaData, pedidosPorVendedor:{gcSellerId:n} }]
 *   mr4PorGc: Map gcId→mr4Id · uidPorGc: Map gcSellerId→uid · participantesGc: Set gcSellerId (operação ativa)
 *   referenceDate
 */
function previaMigracao({ clientes, mr4PorGc, uidPorGc, participantesGc, referenceDate }) {
  const out = { AUTO_MIGRATE: [], CONFLICT_REVIEW: [], LEGACY_REVIEW: [], NEVER_PURCHASED: [], UNASSIGNED: [] };
  const vistos = new Set(); const invalidos = []; const duplicados = [];
  const uid = g => (g && (uidPorGc.get ? uidPorGc.get(g) : uidPorGc[g])) || null;
  for (const c of clientes) {
    let ent, pid;
    const mr4 = mr4PorGc && (mr4PorGc.get ? mr4PorGc.get(c.gcId) : mr4PorGc[c.gcId]);
    try { ent = entidadeDoClienteGc(c.gcId, mr4); pid = portfolioAnchorFromGcId(c.gcId); } catch (e) { invalidos.push(c.gcId); continue; }
    if (vistos.has(pid)) { duplicados.push(pid); continue; }   // unicidade pela ÂNCORA (N35.25.1)
    vistos.add(pid);
    const ident = { portfolioId: pid, identidadeAtual: ent, aliases: knownIdentitiesForGc(c.gcId, mr4 ? [mr4] : []).aliases };
    const classe = classificarFontes({ cadastro: c.cad, ultima: c.ult, predominante: c.pred, comprou: c.comprou });
    const grupo = grupoMigracao({ classe, cadastroLegado: !!c.cad && !participantesGc.has(c.cad), semFonteConfiavel: !c.cad && !c.pred });
    const origem = { origemComercialUid: uid(c.cad), origemComercialGestaoClickId: c.cad || null };
    const reat = calcularReativacao({ ultimaCompraEm: c.ultimaData, referenceDate });
    if (grupo === 'AUTO_MIGRATE') {
      out.AUTO_MIGRATE.push({ commercialEntityId: ent, ...ident, proposedOwnerUid: uid(c.cad), proposedOwnerGestaoClickId: c.cad, ...origem,
        confidence: 'HIGH', migrationReason: 'CONSENSUS_TOTAL', reativacao: reat.estado });
    } else if (grupo === 'REVIEW') {
      const sinais = [];
      if (!c.cad) sinais.push('REGISTRATION_MISSING');
      if (c.cad && c.ult && c.ult !== c.cad) sinais.push('LAST_SALE_DIFFERS');
      if (c.cad && c.pred && c.pred !== c.cad) sinais.push('PREDOMINANT_DIFFERS');
      if (c.cad && c.ult && c.pred && c.ult === c.pred && c.ult !== c.cad) sinais.push('REGISTRATION_DIFFERS');
      if (new Set([c.cad, c.ult, c.pred].filter(Boolean)).size >= 3) sinais.push('MULTIPLE_SOURCES_CONFLICT');
      out.CONFLICT_REVIEW.push({ commercialEntityId: ent, ...ident, registrationSeller: c.cad || null, lastSaleSeller: c.ult || null, predominantSeller: c.pred || null,
        conflictType: classe, suggestedReviewSignals: sinais, reativacao: reat.estado });
    } else if (grupo === 'LEGACY_SELLER_REVIEW') {
      out.LEGACY_REVIEW.push({ commercialEntityId: ent, ...ident, legacySeller: c.cad, ...origem, lastSaleSeller: c.ult || null, predominantSeller: c.pred || null,
        pedidosPorVendedor: c.pedidosPorVendedor || {}, diasSemComprar: reat.diasSemComprar, reativacao: reat.estado });
    } else if (grupo === 'NEVER_PURCHASED') {
      out.NEVER_PURCHASED.push({ commercialEntityId: ent, ...ident, ...origem, portfolioOwnerUid: null, status: 'SEM_CARTEIRA_ATE_PRIMEIRA_COMPRA' });
    } else {
      out.UNASSIGNED.push({ commercialEntityId: ent, ...ident, HAS_REGISTRATION_SELLER: !!c.cad, HAS_LAST_SALE_SELLER: !!c.ult, HAS_PREDOMINANT_SELLER: !!c.pred,
        HAS_VALID_COMMERCIAL_ENTITY_ID: ENT_RE.test(ent), status: 'MANUAL_REVIEW' });
    }
  }
  const total = Object.values(out).reduce((s, l) => s + l.length, 0);
  // N35.25.1: após a migração, TODA transição futura GC_NATIVE→MR4_LINKED resolve para a MESMA âncora (prova no relatório)
  return { grupos: out, TOTAL_INPUT: clientes.length, TOTAL_OUTPUT: total, DUPLICATES: duplicados.length, INVALID_IDS: invalidos.length,
    MISSING: clientes.length - total - duplicados.length - invalidos.length };
}

/**
 * M5 (prévia) para clientes de vendedor legado: ativos (< 120 d) → candidato só quando o relacionamento ATUAL é inequívoco
 * (última venda = predominante = Fabiana|Ademir); relacionamento ainda com o legado → KEEP; misto → MANUAL_REVIEW;
 * inativos (>= 120 d) → REACTIVATION_OPEN (mantêm a carteira/origem histórica). Não executa nada.
 */
function classificarM5(item, { gcFabiana, gcAdemir, referenceDate }) {
  const r = calcularReativacao({ ultimaCompraEm: item.ultimaData, referenceDate });
  if (r.reativacaoAberta) return 'REACTIVATION_OPEN';
  if (r.estado !== 'FECHADA') return 'MANUAL_REVIEW';
  const u = item.lastSaleSeller, p = item.predominantSeller;
  if (u === item.legacySeller && p === item.legacySeller) return 'KEEP';
  if (u && u === p && u === gcFabiana) return 'CANDIDATE_FABIANA';
  if (u && u === p && u === gcAdemir) return 'CANDIDATE_ADEMIR';
  return 'MANUAL_REVIEW';
}

// ── Distribuição com preferência de carteira (SIMULAÇÃO; o gerador LIVE não é alterado) ───────────
/**
 * Pós-processa a atribuição da worklist: item ATIVO (reativação FECHADA) com carteira de vendedor participante vai ao
 * dono da carteira; item com reativação ABERTA segue a distribuição atual. Dono pausado (não participa):
 *   PRESERVE_OWNER → item fica reservado ao dono (fora da lista de hoje; conta como "reservado");
 *   ALLOW_COVERAGE → segue a distribuição atual (cobertura; carteira não muda).
 * Oportunidade já com ownership persistente (pendentes/followUps/emAtendimento) NUNCA é movida (N35.18.1).
 */
function distribuirComCarteira({ itens, carteiraDe, ultimaCompraDe, participantes, referenceDate, politicaPausado = 'ALLOW_COVERAGE' }) {
  if (!['PRESERVE_OWNER', 'ALLOW_COVERAGE'].includes(politicaPausado)) throw new Error('politicaPausado inválida');
  const part = participantes instanceof Set ? participantes : new Set(participantes || []);
  return itens.map(it => {
    const owner = carteiraDe(it.commercialEntityId);
    const r = calcularReativacao({ ultimaCompraEm: ultimaCompraDe(it.commercialEntityId), referenceDate });
    const base = { ...it, portfolioOwnerUid: owner || null, reativacao: r.estado, novoUid: it.uid, motivo: 'SEM_MUDANCA' };
    if (it.grupo && it.grupo !== 'novas') return { ...base, motivo: 'OWNERSHIP_PERSISTENTE' };
    if (!owner) return { ...base, motivo: 'SEM_CARTEIRA' };
    if (r.reativacaoAberta || r.estado !== 'FECHADA') return { ...base, motivo: 'REATIVACAO_ABERTA' };
    if (owner === it.uid) return { ...base, motivo: 'JA_COM_DONO' };
    if (part.has(owner)) return { ...base, novoUid: owner, motivo: 'PREFERENCIA_CARTEIRA' };
    return politicaPausado === 'PRESERVE_OWNER' ? { ...base, novoUid: null, motivo: 'RESERVADO_DONO_PAUSADO' } : { ...base, motivo: 'COBERTURA_DONO_PAUSADO' };
  });
}

/** Contexto gerencial para o Agente (somente leitura; só fatos). */
function contextoAgenteCarteira({ carteira, ultimaCompraEm, referenceDate, opportunityOwnerUid, claimOperatorUid, lastSaleSellerUid, nome }) {
  const n = nome || (u => u);
  const r = calcularReativacao({ ultimaCompraEm, referenceDate });
  const owner = carteira && carteira.ownerUid || null;
  const ctx = { portfolioOwner: owner, commercialOrigin: carteira && carteira.origemComercialUid || null, reactivationOpen: !!owner && r.reativacaoAberta,
    opportunityOwner: opportunityOwnerUid || null, claimOperator: claimOperatorUid || null, lastSaleSeller: lastSaleSellerUid || null };
  const fatos = [];
  fatos.push(owner ? 'Cliente da carteira de ' + n(owner) + '.' : 'Cliente sem vendedor de carteira.');
  if (ctx.commercialOrigin && ctx.commercialOrigin !== owner) fatos.push('Origem comercial: ' + n(ctx.commercialOrigin) + '.');
  if (ctx.reactivationOpen) fatos.push('Está aberto à reativação.');
  if (ctx.opportunityOwner) fatos.push('A oportunidade atual está com ' + n(ctx.opportunityOwner) + '.');
  if (ctx.claimOperator) fatos.push('Atendimento iniciado por ' + n(ctx.claimOperator) + '.');
  if (r.diasSemComprar !== null) fatos.push('Última compra há ' + r.diasSemComprar + ' dias.');
  if (ctx.lastSaleSeller) fatos.push('A última venda foi realizada por ' + n(ctx.lastSaleSeller) + '.');
  return { ...ctx, fatos };
}

/** Prévia de transferência em massa V1 (nenhuma execução; nenhum endpoint). */
function previewTransferenciaEmMassaV1({ carteiras, origemUid, destinoUid, filtro, motivo }) {
  if (!origemUid) throw new Error('ORIGEM_OBRIGATORIA');
  if (!destinoUid) throw new Error('DESTINO_OBRIGATORIO');
  if (!motivo || String(motivo).trim().length < 3) throw new Error('MOTIVO_OBRIGATORIO');
  if (origemUid === destinoUid) throw new Error('ORIGEM_IGUAL_DESTINO');
  const elegiveis = [], ignorados = [], conflitos = [];
  for (const c of carteiras || []) {
    if (c.ownerUid !== origemUid) continue;
    if (filtro && !filtro(c)) { ignorados.push({ commercialEntityId: c.commercialEntityId, motivo: 'FORA_DO_FILTRO' }); continue; }
    if (!Number.isInteger(c.versao)) { conflitos.push({ commercialEntityId: c.commercialEntityId, motivo: 'SEM_VERSAO' }); continue; }
    elegiveis.push({ commercialEntityId: c.commercialEntityId, expectedVersao: c.versao });
  }
  elegiveis.sort((a, b) => (a.commercialEntityId < b.commercialEntityId ? -1 : 1));
  const token = require('crypto').createHash('sha256').update(JSON.stringify([origemUid, destinoUid, elegiveis])).digest('hex').slice(0, 16);
  return { PREVIEW_REQUIRED: true, CONFIRMATION_REQUIRED: true, REASON_REQUIRED: true, origemUid, destinoUid, motivo: String(motivo).trim(),
    quantidade: elegiveis.length, elegiveis, conflitos, ignorados, versoes: Object.fromEntries(elegiveis.map(e => [e.commercialEntityId, e.expectedVersao])), token };
}

/** Guarda de execução futura (nenhum endpoint nesta fase): preview + motivo + token + quantidade confirmada. */
function validarExecucaoEmMassaV1({ preview, motivo, token, confirmacaoQuantidade }) {
  if (!preview || !Array.isArray(preview.elegiveis)) return 'PREVIEW_OBRIGATORIO';
  if (!motivo || String(motivo).trim().length < 3) return 'MOTIVO_OBRIGATORIO';
  if (token !== preview.token) return 'PREVIEW_DESATUALIZADO';
  if (confirmacaoQuantidade !== preview.quantidade) return 'CONFIRMACAO_INVALIDA';
  if (preview.conflitos && preview.conflitos.length) return 'CONFLITOS_PENDENTES';
  if (!preview.quantidade) return 'NADA_A_TRANSFERIR';
  return null;
}

/**
 * N35.25.1 — Auditoria de identidade das carteiras existentes (somente leitura; nunca funde nada).
 * docs: [{ id, data }] da coleção carteira_comercial. Chave fora do formato âncora = LEGADO (ex.: GC_NATIVE:/MR4_LINKED:).
 * Retorna por âncora: CONFLITO_OWNERS (owners diferentes) | DUPLICATA_MESMO_OWNER | CHAVE_LEGADA | NAO_RESOLVIDA.
 */
function auditarIdentidadeCarteiras(docs, links) {
  const porAncora = new Map(); const naoResolvidas = [];
  for (const d of docs || []) {
    let anchor = null;
    if (PORTFOLIO_ANCHOR_RE.test(d.id)) anchor = d.id;
    else { const r = resolvePortfolioAnchor(d.id, links); if (r.status === 'RESOLVED') anchor = r.anchorId; else { naoResolvidas.push({ id: d.id, reason: r.reason }); continue; } }
    const l = porAncora.get(anchor) || []; l.push({ id: d.id, ownerUid: (d.data && d.data.ownerUid) || null, legado: d.id !== anchor }); porAncora.set(anchor, l);
  }
  const achados = [];
  for (const [anchor, l] of porAncora) {
    const owners = new Set(l.map(x => x.ownerUid).filter(Boolean));
    if (l.length > 1 && owners.size > 1) achados.push({ anchor, tipo: 'CONFLITO_OWNERS', registros: l, acao: 'REVISAO_IDENTIDADE_NECESSARIA' });
    else if (l.length > 1) achados.push({ anchor, tipo: 'DUPLICATA_MESMO_OWNER', registros: l, acao: 'REVISAO_IDENTIDADE_NECESSARIA' });
    else if (l[0].legado) achados.push({ anchor, tipo: 'CHAVE_LEGADA', registros: l, acao: 'REVISAO_IDENTIDADE_NECESSARIA' });
  }
  return { ancoras: porAncora.size, achados, naoResolvidas, AUTO_MERGE: false };
}

module.exports = {
  auditarIdentidadeCarteiras,
  validarExecucaoEmMassaV1,
  DIAS_REATIVACAO, SCHEMA, TIPOS_EVENTO, CAMPOS_CARTEIRA, CAMPOS_HISTORICO, ENT_RE,
  calcularReativacao, entidadeDoClienteGc, montarDocCarteiraV1, validarDocCarteiraV1, montarEventoHistoricoV1, planejarPrimeiraVenda,
  previaMigracao, classificarM5, distribuirComCarteira, contextoAgenteCarteira, previewTransferenciaEmMassaV1,
};
