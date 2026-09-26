'use strict';
// N35.23 — Carteira Comercial (PROTÓTIPO LOCAL; nada é gravado em produção, nada influencia a distribuição).
//
// Quatro conceitos SEPARADOS:
//   carteira    — vínculo estrutural cliente → vendedor responsável (meses). Muda SÓ por ação administrativa explícita.
//   ownership   — dono operacional da oportunidade na worklist (fila_comercial/worklist.atribuicoes).
//   claim       — alguém iniciou o atendimento (interacoes_fila.claimAtual). Nunca muda carteira.
//   transferência de oportunidade — muda ownership (N35.22C). Nunca muda carteira.
//
// Identidade: cliente = commercialEntityId (GC_NATIVE:<gcId> | MR4_LINKED:<mr4Id>) resolvido para o id do cliente no
// GestãoClick; vendedor = id de usuário do GestãoClick (vendedor_id) ↔ uid Firebase via e-mail (mapa explícito).
// Nome NUNCA é chave. Nenhum CPF/CNPJ é lido ou armazenado.

const DIAS_REATIVACAO = 120;
const MODELOS_120 = ['A', 'B', 'C', 'D'];
const FONTES = {
  GC_CADASTRO: 'GC_CADASTRO',           // A: vendedor cadastrado no cliente (GestãoClick clientes.vendedor_id)
  VENDAS_PREDOMINANTE: 'VENDAS_PREDOMINANTE', // B: vendedor com mais vendas concretizadas
  ULTIMA_VENDA: 'ULTIMA_VENDA',         // C: vendedor da última venda concretizada
  MR4: 'MR4',                           // D: vínculo MR4 (inexistente hoje)
};

function diasEntre(ymdA, ymdB) {
  return Math.round((Date.parse(ymdB + 'T12:00:00Z') - Date.parse(ymdA + 'T12:00:00Z')) / 86400000);
}

/** GC id do cliente a partir do commercialEntityId (MR4_LINKED resolve pelo cadastro MR4 → gestaoClickId). */
function gcIdDaEntidade(commercialEntityId, gcIdPorMr4) {
  const s = String(commercialEntityId || '');
  if (s.startsWith('GC_NATIVE:')) return s.slice('GC_NATIVE:'.length) || null;
  if (s.startsWith('MR4_LINKED:')) {
    const m = s.slice('MR4_LINKED:'.length);
    const g = gcIdPorMr4 && (gcIdPorMr4.get ? gcIdPorMr4.get(m) : gcIdPorMr4[m]);
    return g ? String(g) : null;
  }
  return null;
}

/** Agrega vendas concretizadas por cliente GC: vendedores (contagem), última venda e seu vendedor. */
function indexarVendas(vendas) {
  const por = new Map();
  for (const v of vendas || []) {
    if (!v || String(v.nome_situacao || '').trim() !== 'Concretizada') continue;
    const cli = String(v.cliente_id || ''); const vid = String(v.vendedor_id || '').trim(); const d = String(v.data || '').slice(0, 10);
    if (!cli || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const e = por.get(cli) || { contagem: {}, ultima: null, ultimaVendedor: null, vendas: [] };
    if (vid) e.contagem[vid] = (e.contagem[vid] || 0) + 1;
    e.vendas.push({ d, vid });
    if (!e.ultima || d > e.ultima || (d === e.ultima && vid && !e.ultimaVendedor)) { e.ultima = d; e.ultimaVendedor = vid || null; }
    por.set(cli, e);
  }
  return por;
}

function predominante(contagem) {
  const l = Object.entries(contagem || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (!l.length) return { vendedor: null, empate: false };
  return { vendedor: l[0][0], empate: l.length > 1 && l[1][1] === l[0][1] };
}

/**
 * Reconstrói (em memória, NUNCA grava) a carteira a partir das fontes existentes.
 * @param {object} p { cadastroGc: Map gcId→{vendedor_id}, vendas, uidPorVendedorGc: Map gcSellerId→uid, hoje:'YYYY-MM-DD' }
 * @returns {Map gcId → { clienteId, vendedorGcId, vendedorUid, fonte, confianca, ultimaVenda, diasSemComprar,
 *   vendedorPredominante, vendedorUltimaVenda, vendedoresDistintos, conflitoPredominante, conflitoUltimaVenda }>}
 */
function reconstruirCarteira({ cadastroGc, vendas, uidPorVendedorGc, hoje }) {
  const idx = indexarVendas(vendas);
  const uid = g => (g && uidPorVendedorGc && (uidPorVendedorGc.get ? uidPorVendedorGc.get(g) : uidPorVendedorGc[g])) || null;
  const out = new Map();
  const ids = new Set([...(cadastroGc ? cadastroGc.keys() : []), ...idx.keys()]);
  for (const cli of ids) {
    const cad = cadastroGc && cadastroGc.get(cli);
    const cadVend = cad && String(cad.vendedor_id || '').trim() || null;
    const ev = idx.get(cli) || null;
    const pred = predominante(ev && ev.contagem);
    const ult = ev ? ev.ultimaVendedor : null;
    let vendedorGcId = null, fonte = null, confianca = 'NENHUMA';
    if (cadVend) { vendedorGcId = cadVend; fonte = FONTES.GC_CADASTRO; confianca = 'ALTA'; }
    else if (pred.vendedor && !pred.empate) { vendedorGcId = pred.vendedor; fonte = FONTES.VENDAS_PREDOMINANTE; confianca = 'MEDIA'; }
    else if (ult) { vendedorGcId = ult; fonte = FONTES.ULTIMA_VENDA; confianca = 'BAIXA'; }
    const distintos = ev ? Object.keys(ev.contagem).length : 0;
    out.set(cli, {
      clienteId: cli, vendedorGcId, vendedorUid: uid(vendedorGcId), fonte, confianca,
      ultimaVenda: ev ? ev.ultima : null, diasSemComprar: ev && ev.ultima && hoje ? diasEntre(ev.ultima, hoje) : null,
      vendedorPredominante: pred.vendedor, empatePredominante: pred.empate, vendedorUltimaVenda: ult, uidUltimaVenda: uid(ult), vendedoresDistintos: distintos,
      conflitoPredominante: !!(cadVend && pred.vendedor && !pred.empate && pred.vendedor !== cadVend),
      conflitoUltimaVenda: !!(cadVend && ult && ult !== cadVend),
    });
  }
  return out;
}

/**
 * Política dos 120 dias — SIMULAÇÃO (nenhuma é adotada).
 *  A permanente · B libera após 120d · C mantém carteira, reativação aberta após 120d ·
 *  D carteira segue o vendedor da última venda concretizada (prática observada no cadastro GC; ver relatório)
 * @returns {{ carteiraUid, carteiraGcId, exclusivo:boolean, liberado:boolean, reativacaoAberta:boolean }}
 */
function aplicarModelo120(entrada, modelo, dias = DIAS_REATIVACAO) {
  if (!MODELOS_120.includes(modelo)) throw new Error('modelo inválido: ' + modelo);
  const e = entrada || {};
  const inativo = typeof e.diasSemComprar === 'number' && e.diasSemComprar >= dias; // N35.25: fronteira = regra existente (>= 120)
  const base = { carteiraUid: e.vendedorUid || null, carteiraGcId: e.vendedorGcId || null };
  if (!base.carteiraGcId) return { ...base, exclusivo: false, liberado: false, reativacaoAberta: true };
  if (modelo === 'A') return { ...base, exclusivo: true, liberado: false, reativacaoAberta: false };
  if (modelo === 'B') return inativo ? { carteiraUid: null, carteiraGcId: null, exclusivo: false, liberado: true, reativacaoAberta: true } : { ...base, exclusivo: true, liberado: false, reativacaoAberta: false };
  if (modelo === 'C') return { ...base, exclusivo: !inativo, liberado: false, reativacaoAberta: inativo };
  // D: a carteira é a do vendedor da última venda (quando houver venda); o cadastro só vale sem vendas
  const g = e.vendedorUltimaVenda || e.vendedorGcId;
  return { carteiraUid: g === e.vendedorGcId ? e.vendedorUid : (e.uidUltimaVenda || null), carteiraGcId: g, exclusivo: true, liberado: false, reativacaoAberta: false };
}

/** Relação carteira × oportunidade (fato; divergência não é erro). */
function relacaoCarteiraWorklist(carteiraUid, worklistUid) {
  if (!carteiraUid) return 'SEM_CARTEIRA';
  if (!worklistUid) return 'SEM_OPORTUNIDADE';
  return carteiraUid === worklistUid ? 'MESMO_VENDEDOR' : 'OUTRO_VENDEDOR';
}

/** Cenários: quem é cada "dono". Carteira NUNCA muda por claim, outcome ou transferência de oportunidade. */
function resolverCenario({ carteira, atribuicao, estado }) {
  const claimOp = estado && estado.estado === 'EM_ATENDIMENTO' && estado.claimAtual ? estado.claimAtual.operadorId : null;
  return {
    CARTEIRA_OWNER: (carteira && carteira.ativo !== false && carteira.ownerUid) || null,
    WORKLIST_OWNER: (atribuicao && atribuicao.uid) || null,
    CLAIM_OPERATOR: claimOp,
    CARTEIRA_CHANGES: 'NO',
  };
}

/** Fatos para o Agente/painel (somente contexto; nunca julgamento, recomendação ou comparação). */
function fatosCarteira({ carteiraUid, worklistUid, diasSemComprar, nome }) {
  const n = nome || (u => u);
  const f = [];
  if (!carteiraUid) f.push('Cliente sem vendedor de carteira.');
  else if (worklistUid && worklistUid !== carteiraUid) f.push('Oportunidade está com ' + n(worklistUid) + ', mas o cliente pertence à carteira de ' + n(carteiraUid) + '.');
  else f.push('Cliente da carteira de ' + n(carteiraUid) + '.');
  if (typeof diasSemComprar === 'number' && diasSemComprar >= DIAS_REATIVACAO) f.push('Cliente está há ' + diasSemComprar + ' dias sem comprar.');
  return f;
}
const TEXTO_PROIBIDO_CARTEIRA = /perdeu|melhor|pior|transfira|deveria|culpa|desempenho|ranking|score|nota /i;

/** Documento proposto carteira_comercial/{commercialEntityId} (sem CPF/CNPJ/nome). */
function montarDocCarteira({ commercialEntityId, gcClienteId, vendedorUid, vendedorGcId, origem, atribuidoPor, motivo, em }) {
  return { schemaVersion: 'carteira-v1', commercialEntityId, gcClienteId: gcClienteId || null, vendedorUid, vendedorGcId: vendedorGcId || null,
    origem, atribuidoEm: em, atribuidoPor: atribuidoPor || null, motivo: motivo || null, ativo: true, atualizadoEm: em };
}

// ── N35.24 ──────────────────────────────────────────────────────────────────────
// Modelo C (simulado; NÃO aprovado): carteira histórica preservada + reativação aberta após 120 dias.
// `reativacaoAberta` é DERIVADA de ultimaCompraEm (não armazenada) → C1 ≡ C2 por construção.
function situacaoModeloC({ carteira, ultimaCompraEm, hoje, dias = DIAS_REATIVACAO }) {
  const owner = (carteira && carteira.ativo !== false && carteira.ownerUid) || null;
  const d = ultimaCompraEm ? diasEntre(String(ultimaCompraEm).slice(0, 10), hoje) : null;
  return { portfolioOwner: owner, diasSemComprar: d, reativacaoAberta: !!owner && d !== null && d >= dias, nuncaComprou: !ultimaCompraEm };
}

/**
 * Efeito de um evento comercial sobre a carteira. SOMENTE 'TRANSFERENCIA_ADMINISTRATIVA' muda o responsável.
 * claim / outcome / transferência de oportunidade / venda → carteira inalterada (venda só atualiza a data de compra,
 * que é derivada das vendas, não da carteira).
 */
const EVENTOS_QUE_NAO_MUDAM_CARTEIRA = ['CLAIM', 'OUTCOME', 'TRANSFERENCIA_OPORTUNIDADE', 'VENDA', 'COBERTURA_TEMPORARIA'];
function aplicarEvento(carteira, evento) {
  if (!evento || !evento.tipo) throw new Error('evento inválido');
  if (EVENTOS_QUE_NAO_MUDAM_CARTEIRA.includes(evento.tipo)) return carteira;
  if (evento.tipo === 'TRANSFERENCIA_ADMINISTRATIVA') {
    if (!evento.operadorUid || !evento.motivo || !evento.novoUid) throw new Error('transferência exige operador, motivo e destino');
    return { ...carteira, ownerUid: evento.novoUid, versao: ((carteira && carteira.versao) || 0) + 1 };
  }
  throw new Error('evento desconhecido: ' + evento.tipo);
}

/**
 * Clientes que nunca compraram. N1 cadastro cria carteira · N2 primeira venda cria carteira ·
 * N3 origem comercial guardada separada; carteira nasce num evento formal (ex.: primeira venda).
 */
function politicaSemCompra(politica, { vendedorCadastroGc, vendedorCadastroUid, primeiraVenda }) {
  if (!['N1', 'N2', 'N3'].includes(politica)) throw new Error('política inválida');
  const venda = primeiraVenda && primeiraVenda.vendedorUid ? primeiraVenda : null;
  if (politica === 'N1') return { portfolioOwner: vendedorCadastroUid || null, origemComercialUid: null, origemComercialGestaoClickId: null };
  const owner = venda ? venda.vendedorUid : null;
  if (politica === 'N2') return { portfolioOwner: owner, origemComercialUid: null, origemComercialGestaoClickId: null };
  return { portfolioOwner: owner, origemComercialUid: vendedorCadastroUid || null, origemComercialGestaoClickId: vendedorCadastroGc || null };
}

/** Classe analítica (exatamente uma) a partir das três fontes (IDs GC). */
function classificarFontes({ cadastro, ultima, predominante, comprou }) {
  if (!comprou) return cadastro ? 'CADASTRO_SEM_COMPRA' : 'OWNER_DESCONHECIDO';
  if (!cadastro || !ultima) return 'SEM_OWNER_CADASTRO';
  if (cadastro === ultima && ultima === predominante) return 'CONSENSO_TOTAL';
  if (cadastro === predominante) return 'CADASTRO_DIFERE_ULTIMA';
  if (cadastro === ultima) return 'CADASTRO_DIFERE_PREDOMINANTE';
  if (ultima === predominante) return 'CADASTRO_DIFERE_VENDAS';
  return 'TODAS_FONTES_DIVERGEM';
}

/**
 * Grupo de migração MUTUAMENTE EXCLUSIVO (precedência fixa). `legado` = vendedor do cadastro não participa da operação.
 * NEVER_PURCHASED > UNASSIGNED > LEGACY_SELLER_REVIEW > AUTO_MIGRATE (consenso total) > REVIEW.
 */
function grupoMigracao({ classe, cadastroLegado, semFonteConfiavel }) {
  if (classe === 'CADASTRO_SEM_COMPRA') return 'NEVER_PURCHASED';
  if (classe === 'OWNER_DESCONHECIDO' || semFonteConfiavel) return 'UNASSIGNED'; // sem cadastro e sem vendedor identificável nas vendas
  if (cadastroLegado) return 'LEGACY_SELLER_REVIEW';
  if (classe === 'CONSENSO_TOTAL') return 'AUTO_MIGRATE';
  return 'REVIEW';
}

/**
 * Transferência em massa — PREVIEW (puro; não executa). Gera a lista exata, contagens e um token que amarra a execução
 * futura ao preview (qualquer mudança na lista invalida a confirmação).
 */
function previewTransferenciaEmMassa({ itens, origemUid, destinoDe, filtro }) {
  if (!origemUid) throw new Error('origem obrigatória');
  if (typeof destinoDe !== 'function') throw new Error('regra de destino obrigatória (função explícita)');
  const sel = (itens || []).filter(x => x.ownerUid === origemUid && (!filtro || filtro(x)));
  const plano = sel.map(x => ({ commercialEntityId: x.commercialEntityId, de: origemUid, para: destinoDe(x) || null }))
    .sort((a, b) => (a.commercialEntityId < b.commercialEntityId ? -1 : 1));
  const porDestino = plano.reduce((m, p) => (m[p.para || 'SEM_DESTINO'] = (m[p.para || 'SEM_DESTINO'] || 0) + 1, m), {});
  const token = require('crypto').createHash('sha256').update(JSON.stringify(plano)).digest('hex').slice(0, 16);
  return { quantidade: plano.length, porDestino, semDestino: porDestino.SEM_DESTINO || 0, plano, token };
}
/** Guarda de execução futura: exige preview, motivo e confirmação explícita (quantidade digitada + token). Nunca "transferir todos". */
function validarExecucaoEmMassa({ preview, motivo, confirmacaoQuantidade, token }) {
  if (!preview || !preview.plano) return 'PREVIEW_OBRIGATORIO';
  if (!motivo || String(motivo).trim().length < 3) return 'MOTIVO_OBRIGATORIO';
  if (token !== preview.token) return 'PREVIEW_DESATUALIZADO';
  if (confirmacaoQuantidade !== preview.quantidade) return 'CONFIRMACAO_INVALIDA';
  if (preview.semDestino) return 'ITENS_SEM_DESTINO';
  if (!preview.quantidade) return 'NADA_A_TRANSFERIR';
  return null;
}

/** Alertas gerenciais da carteira (fatos determinísticos; somente exibição; nunca ação). */
function alertasCarteira({ carteiraUid, worklistUid, reativacaoAberta, vendedorCarteiraAtivo, classe, nuncaComprou }) {
  const a = [];
  if (!carteiraUid) a.push('SEM_CARTEIRA');
  else {
    if (worklistUid && worklistUid !== carteiraUid && !reativacaoAberta) a.push('CARTEIRA_ATIVA_OUTRO_VENDEDOR');
    if (reativacaoAberta) a.push('REATIVACAO_ABERTA');
    if (vendedorCarteiraAtivo === false) a.push('VENDEDOR_CARTEIRA_INATIVO');
  }
  if (classe && !['CONSENSO_TOTAL', 'CADASTRO_SEM_COMPRA', 'OWNER_DESCONHECIDO'].includes(classe)) a.push('CONFLITO_FONTES');
  if (nuncaComprou) a.push('NUNCA_COMPROU');
  return a;
}

module.exports = {
  situacaoModeloC, aplicarEvento, EVENTOS_QUE_NAO_MUDAM_CARTEIRA, politicaSemCompra, classificarFontes, grupoMigracao,
  previewTransferenciaEmMassa, validarExecucaoEmMassa, alertasCarteira,
  DIAS_REATIVACAO, MODELOS_120, FONTES, TEXTO_PROIBIDO_CARTEIRA,
  diasEntre, gcIdDaEntidade, indexarVendas, predominante, reconstruirCarteira, aplicarModelo120,
  relacaoCarteiraWorklist, resolverCenario, fatosCarteira, montarDocCarteira,
};
