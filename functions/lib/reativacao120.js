'use strict';
/**
 * B3 — Motor dos 120 dias + reativação controlada. PURO (sem I/O). Não ativa nada.
 *
 * Regra aprovada:
 *  • dentro de 119 dias da última compra que RENOVA o ciclo, o owner mantém exclusividade; com >=120 dias (120 exato) a exclusividade termina;
 *  • >=120 dias NÃO transfere a carteira: abre uma OPORTUNIDADE DE REATIVAÇÃO para o OUTRO vendedor (reserva de 7 dias);
 *  • só uma venda válida desse vendedor, DURANTE a reserva, transfere a carteira (owner novo por 120 dias);
 *  • cobertura (outro vendedor vende antes de 120 dias) NÃO muda owner e renova o ciclo do owner original;
 *  • venda da gestão/outros funcionários é NEUTRA (não renova, não transfere, não entra na meta/comissão dos vendedores);
 *  • sem carteira: o cliente continua SEM CARTEIRA; o primeiro vendedor que fizer a venda válida na reativação vira owner;
 *  • conflito de identidade (EM_REVISAO), NÃO CONTATAR, cooldown e follow-up real bloqueiam a automação.
 */
const crypto = require('crypto');
const { validarVenda } = require('./carteiraRegra');
const { calcularReativacao } = require('./carteiraV1');
const { situacaoVendedor } = require('./carteiraRegra');
const { normalizeGestaoClickId } = require('./commercialIdentity');

const DIAS_CICLO = 120, RESERVA_DIAS = 7, LIMITE_DIARIO = 10, COOLDOWN_SEM_INTERESSE_DIAS = 30;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DECISOES = Object.freeze({
  IGNORAR_INVALIDA: 'IGNORAR_INVALIDA', VENDA_GESTAO_NEUTRA: 'VENDA_GESTAO_NEUTRA', RENOVAR_OWNER: 'RENOVAR_OWNER', COBERTURA_RENOVA_OWNER: 'COBERTURA_RENOVA_OWNER',
  COBERTURA_PAUSA: 'COBERTURA_PAUSA', TRANSFERIR_REATIVACAO: 'TRANSFERIR_REATIVACAO', CRIAR_PRIMEIRA_VENDA: 'CRIAR_PRIMEIRA_VENDA', CRIAR_VIA_REATIVACAO: 'CRIAR_VIA_REATIVACAO',
  MANTER_SEM_CARTEIRA: 'MANTER_SEM_CARTEIRA', MANTER_SEM_OPORTUNIDADE: 'MANTER_SEM_OPORTUNIDADE', BLOQUEADO_CONFLITO: 'BLOQUEADO_CONFLITO', VENDEDOR_NAO_ELEGIVEL: 'VENDEDOR_NAO_ELEGIVEL',
});
const ALTERA_OWNER = Object.freeze([DECISOES.TRANSFERIR_REATIVACAO, DECISOES.CRIAR_PRIMEIRA_VENDA, DECISOES.CRIAR_VIA_REATIVACAO]);
const RENOVA_CICLO = Object.freeze([DECISOES.RENOVAR_OWNER, DECISOES.COBERTURA_RENOVA_OWNER, DECISOES.COBERTURA_PAUSA, DECISOES.TRANSFERIR_REATIVACAO, DECISOES.CRIAR_PRIMEIRA_VENDA, DECISOES.CRIAR_VIA_REATIVACAO]);

const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const somarDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dataDe = v => String(v.data).slice(0, 10);
const chaveOrdem = v => dataDe(v) + '|' + String(v.id).padStart(20, '0');
const gcId = v => normalizeGestaoClickId(v.cliente_id);
const portfolioDe = id => 'GC:' + id;
/** Chave determinística de reativação: um ciclo (= data da última compra que renovou) gera NO MÁXIMO uma reserva. */
const chaveReativacao = (portfolioId, ciclo) => `REATIV:${portfolioId}:${ciclo}`;

// ── vendedores ───────────────────────────────────────────────────────────────
/** configs: [{uid, user, sistema}] → { porUid, porGc } com situação comercial (elegível, pausa). */
function indexarVendedores(configs) {
  const porUid = new Map(), porGc = new Map(), ambiguos = new Set();
  for (const c of configs || []) {
    const sit = situacaoVendedor(c.user, c.sistema); const g = normalizeGestaoClickId(c.sistema && c.sistema.carteiraComercial && c.sistema.carteiraComercial.gestaoClickVendedorId);
    const e = { uid: c.uid, gcVendedorId: g || null, ...sit, limiteDiario: Number(c.sistema && c.sistema.filaComercial && c.sistema.filaComercial.limiteNovasPorDia) || LIMITE_DIARIO,
      recebe: !(c.sistema && c.sistema.filaComercial && (c.sistema.filaComercial.ativo === false || c.sistema.filaComercial.recebeNovasOportunidades === false)) };
    porUid.set(c.uid, e);
    if (g) { if (porGc.has(g)) ambiguos.add(g); else porGc.set(g, e); }
  }
  ambiguos.forEach(g => porGc.delete(g));
  return { porUid, porGc, ambiguos };
}
/** Classe da venda quanto à autoria comercial. 'VENDEDOR_CARTEIRA' = vendedor habilitado a possuir carteira. */
function classeDaVenda(venda, vend) {
  const g = normalizeGestaoClickId(venda.vendedor_id);
  if (!g) return { classe: 'SEM_VENDEDOR', uid: null, elegivel: false };
  const e = vend.porGc.get(g);
  if (!e) return { classe: 'GESTAO_OU_OUTRO', uid: null, elegivel: false };               // proprietário, Camila e demais funcionários
  return { classe: 'VENDEDOR_CARTEIRA', uid: e.uid, elegivel: e.elegivel === true, situacao: e.situacao };
}

// ── vendas válidas (cancelada/não concretizada/zerada/futura fora; devolução TOTAL anula) ───────────────────────
/** devolucoes: Map(vendaId → 'TOTAL'|'PARCIAL'). Sem fonte confiável a fonte é vazia (ver relatório: RETURN_DETECTION). */
function validas(vendas, hoje, devolucoes) {
  const vistos = new Set();
  return (vendas || []).filter(v => !validarVenda(v, hoje)).filter(v => (devolucoes && devolucoes.get(String(v.id)) === 'TOTAL') ? false : true)
    .filter(v => (vistos.has(String(v.id)) ? false : vistos.add(String(v.id)))).sort((a, b) => (chaveOrdem(a) < chaveOrdem(b) ? -1 : 1));
}

/**
 * Ciclo de 120 dias de um cliente na data `hoje`.
 *  - COM carteira: só compras de vendedores habilitados (owner ou cobertura) renovam; gestão/outros/sem vendedor são neutras.
 *  - SEM carteira: qualquer compra válida conta como "última compra válida".
 */
function cicloDoCliente({ vendasCliente, carteira, vend, hoje, devolucoes, ate }) {
  const todas = validas(vendasCliente, hoje, devolucoes).filter(v => !ate || chaveOrdem(v) < ate);
  const renovam = carteira && carteira.ownerUid ? todas.filter(v => classeDaVenda(v, vend).classe === 'VENDEDOR_CARTEIRA' && classeDaVenda(v, vend).elegivel) : todas;
  let ultima = renovam.length ? dataDe(renovam[renovam.length - 1]) : null;
  if (carteira && carteira.cicloAncoraEm && (!ultima || carteira.cicloAncoraEm > ultima)) ultima = carteira.cicloAncoraEm;
  const r = calcularReativacao({ ultimaCompraEm: ultima, referenceDate: hoje });
  return { ultimaRenovacao: ultima, dias: r.diasSemComprar, aberta: r.reativacaoAberta, ciclo: ultima, totalVendas: todas.length, renovam };
}

// ── prioridade (RFM) ─────────────────────────────────────────────────────────
/** Rank determinístico: valor histórico (M) 50%, frequência (F) 30%, recência dentro dos elegíveis (R: quem acabou de vencer primeiro) 20%. */
function prioridadesRfm(itens) {
  const rank = (arr, f, desc = true) => { const s = [...arr].sort((a, b) => (desc ? f(b) - f(a) : f(a) - f(b)) || (a.id < b.id ? -1 : 1)); const m = new Map(); s.forEach((x, i) => m.set(x.id, arr.length > 1 ? 1 - i / (arr.length - 1) : 1)); return m; };
  const M = rank(itens, x => x.monetario), F = rank(itens, x => x.pedidos), R = rank(itens, x => x.dias, false);
  return new Map(itens.map(x => [x.id, Math.round((0.5 * M.get(x.id) + 0.3 * F.get(x.id) + 0.2 * R.get(x.id)) * 1000) / 1000]));
}

// ── planejamento diário de liberações (06:00) ───────────────────────────────
/**
 * @param {object} p  hoje; carteiras: Map(portfolioId → doc); semCarteira: [{id, ...}] (ids GC compradores); vendasPorCliente: Map(gcId → vendas[]);
 *   vend (indexarVendedores); conflitosGc: Set(gcId); naoContatar: Set(gcId); cooldowns: Map(gcId → ymd até); followUps: Map(gcId → ymd);
 *   reservasExistentes: Map(chave → reserva); devolucoes; limitePorVendedor; incluirSemCarteira (false por padrão)
 */
function planejarLiberacao(p) {
  const { hoje, carteiras, vend, vendasPorCliente } = p; const limite = p.limitePorVendedor || LIMITE_DIARIO;
  const bloq = { CONFLITO: [], NAO_CONTATAR: [], COOLDOWN: [], FOLLOWUP: [], OWNER_EM_PAUSA: [], SEM_VENDEDOR_DESTINO: [], RESERVA_JA_CRIADA: [] };
  const vendedoresDestino = [...vend.porUid.values()].filter(e => e.elegivel && !e.pausaProtegida && e.recebe).sort((a, b) => (a.uid < b.uid ? -1 : 1));
  const candidatos = [];
  const ids = new Set([...(carteiras.keys())].map(k => k.slice(3)));
  if (p.incluirSemCarteira) for (const id of p.semCarteira || []) ids.add(String(id));
  for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
    const portfolioId = portfolioDe(id), cart = carteiras.get(portfolioId) || null;
    const ciclo = cicloDoCliente({ vendasCliente: vendasPorCliente.get(id) || [], carteira: cart, vend, hoje, devolucoes: p.devolucoes });
    if (!ciclo.aberta) continue;                                                            // <120 dias (ou sem compra): ainda protegido/não elegível
    const chave = chaveReativacao(portfolioId, ciclo.ciclo);
    const motivo = cart && (cart.status === 'EM_REVISAO' || (cart.conflito && cart.conflito.revisao === 'PENDENTE')) || (p.conflitosGc && p.conflitosGc.has(id)) ? 'CONFLITO'
      : p.naoContatar && p.naoContatar.has(id) ? 'NAO_CONTATAR'
      : p.cooldowns && p.cooldowns.get(id) && p.cooldowns.get(id) > hoje ? 'COOLDOWN'
      : p.followUps && p.followUps.get(id) && p.followUps.get(id) >= hoje ? 'FOLLOWUP'
      : p.reservasExistentes && p.reservasExistentes.has(chave) ? 'RESERVA_JA_CRIADA' : null;
    if (motivo) { bloq[motivo].push(id); continue; }
    let destinos;
    if (cart && cart.ownerUid) {
      const dono = vend.porUid.get(cart.ownerUid);
      if (dono && dono.pausaProtegida) { bloq.OWNER_EM_PAUSA.push(id); continue; }              // pausa protege a carteira (G2)
      destinos = vendedoresDestino.filter(e => e.uid !== cart.ownerUid);
    } else destinos = vendedoresDestino;
    if (!destinos.length) { bloq.SEM_VENDEDOR_DESTINO.push(id); continue; }
    const vs = (vendasPorCliente.get(id) || []); const val = validas(vs, hoje, p.devolucoes);
    candidatos.push({ id, portfolioId, chave, ciclo: ciclo.ciclo, dias: ciclo.dias, tipo: cart && cart.ownerUid ? 'CARTEIRA' : 'SEM_CARTEIRA', ownerUid: cart ? cart.ownerUid : null, destinos: destinos.map(d => d.uid),
      monetario: val.reduce((a, v) => a + (parseFloat(v.valor_total) || 0), 0), pedidos: val.length });
  }
  const pr = prioridadesRfm(candidatos); candidatos.forEach(c => { c.prioridade = pr.get(c.id); });
  candidatos.sort((a, b) => b.prioridade - a.prioridade || (a.id < b.id ? -1 : 1));
  // Atribuição: carteira → o(s) outro(s) vendedor(es); sem carteira → balanceado entre os elegíveis (nenhum owner é criado agora)
  const fila = new Map(vendedoresDestino.map(e => [e.uid, []])); const carga = new Map(vendedoresDestino.map(e => [e.uid, 0]));
  for (const c of candidatos) {
    const alvo = [...c.destinos].sort((a, b) => carga.get(a) - carga.get(b) || (a < b ? -1 : 1))[0]; c.destinoUid = alvo; carga.set(alvo, carga.get(alvo) + 1); fila.get(alvo).push(c);
  }
  const jaHoje = uid => [...(p.reservasExistentes ? p.reservasExistentes.values() : [])].filter(r => r.destinoUid === uid && r.liberadoEm === hoje).length;
  // B3.3 piloto: teto de reservas ATIVAS (RESERVADA) por vendedor; persistente no servidor (configuração + checagem transacional em liberarReserva)
  const ativas = uid => [...(p.reservasExistentes ? p.reservasExistentes.values() : [])].filter(r => r.destinoUid === uid && r.estado === 'RESERVADA').length;
  const liberar = []; const backlog = {}; const dias = {};
  for (const [uid, lista] of fila) {
    const cap = Math.min(limite, (vend.porUid.get(uid) || {}).limiteDiario || limite), livre = Math.max(0, Math.min(cap - jaHoje(uid), Number.isFinite(p.maxAtivas) ? p.maxAtivas - ativas(uid) : Infinity));
    lista.slice(0, livre).forEach(c => liberar.push({ ...c, liberadoEm: hoje, reservaAte: somarDias(hoje, RESERVA_DIAS) }));
    backlog[uid] = Math.max(0, lista.length - livre); dias[uid] = lista.length ? Math.ceil(lista.length / cap) : 0;
  }
  return { liberar, bloqueados: bloq, candidatosElegiveis: candidatos.length, porDestino: Object.fromEntries([...fila].map(([u, l]) => [u, l.length])), backlog, diasEstimados: Math.max(0, ...Object.values(dias)), diasPorVendedor: dias, limite };
}

// ── decisão por venda ────────────────────────────────────────────────────────
/** Reserva utilizável pela venda? (mesmo vendedor, estado ativo, data da venda dentro da janela + extensão por follow-up real) */
function reservaValida(reserva, vendedorUid, dataVenda) {
  if (!reserva || reserva.estado !== 'RESERVADA' || reserva.destinoUid !== vendedorUid) return false;
  const fim = reserva.followUpAte && reserva.followUpAte > reserva.reservaAte ? reserva.followUpAte : reserva.reservaAte;
  return dataVenda >= reserva.liberadoEm && dataVenda <= fim;
}
/**
 * Decide o efeito comercial de UMA venda (pura). `vendasCliente` = todas as vendas do cliente (a função filtra as anteriores).
 * @returns {{decisao, motivo, ownerAntesUid, ownerDepoisUid, creditoUid, renovaCicloDe, gestaoReview, referencias}}
 */
function decidirVendaB3({ venda, vendasCliente, carteira, vend, reservas, hoje, devolucoes, conflitoGc }) {
  const ownerAntes = (carteira && carteira.ownerUid) || null;
  const out = (decisao, motivo, x = {}) => ({ decisao, motivo, ownerAntesUid: ownerAntes, ownerDepoisUid: ownerAntes, creditoUid: null, renovaCicloDe: null, gestaoReview: false, referencias: null, ...x });
  const inval = validarVenda(venda, hoje);
  if (inval) return out(DECISOES.IGNORAR_INVALIDA, inval);
  if (devolucoes && devolucoes.get(String(venda.id)) === 'TOTAL') return out(DECISOES.IGNORAR_INVALIDA, 'DEVOLUCAO_TOTAL');
  const id = gcId(venda), portfolioId = portfolioDe(id), k = chaveOrdem(venda), data = dataDe(venda);
  const classe = classeDaVenda(venda, vend);
  const emConflito = (carteira && (carteira.status === 'EM_REVISAO' || (carteira.conflito && carteira.conflito.revisao === 'PENDENTE'))) || (conflitoGc && conflitoGc.has(id));
  if (emConflito) return out(DECISOES.BLOQUEADO_CONFLITO, 'CONFLITO_DE_IDENTIDADE_EM_REVISAO', { gestaoReview: true, creditoUid: classe.uid });
  if (classe.classe !== 'VENDEDOR_CARTEIRA') return out(DECISOES.VENDA_GESTAO_NEUTRA, classe.classe === 'SEM_VENDEDOR' ? 'VENDA_SEM_VENDEDOR_NEUTRA' : 'VENDA_DA_GESTAO_NEUTRA');
  if (!classe.elegivel) return out(DECISOES.VENDEDOR_NAO_ELEGIVEL, 'VENDEDOR_NAO_ELEGIVEL', { gestaoReview: true });
  const vendedorUid = classe.uid;
  const ciclo = cicloDoCliente({ vendasCliente, carteira, vend, hoje: data, devolucoes, ate: k });       // estado do ciclo imediatamente ANTES desta venda
  const base = { creditoUid: vendedorUid, referencias: { vendaId: String(venda.id), portfolioId, ciclo: ciclo.ciclo } };
  if (ownerAntes) {
    if (vendedorUid === ownerAntes) return out(DECISOES.RENOVAR_OWNER, 'VENDA_DO_DONO', { ...base, renovaCicloDe: ownerAntes });
    if (!ciclo.aberta) {
      const dono = vend.porUid.get(ownerAntes);
      return out(DECISOES.COBERTURA_RENOVA_OWNER, 'COBERTURA_ANTES_DE_120D', { ...base, renovaCicloDe: ownerAntes, gestaoReview: false, ...(dono && dono.pausaProtegida ? { decisao: DECISOES.COBERTURA_PAUSA, motivo: 'COBERTURA_DURANTE_PAUSA' } : {}) });
    }
    const dono = vend.porUid.get(ownerAntes); if (dono && dono.pausaProtegida) return out(DECISOES.COBERTURA_PAUSA, 'COBERTURA_DURANTE_PAUSA', { ...base, renovaCicloDe: ownerAntes });
    const chave = chaveReativacao(portfolioId, ciclo.ciclo); const reserva = reservas && reservas.get(chave);
    if (reservaValida(reserva, vendedorUid, data)) return out(DECISOES.TRANSFERIR_REATIVACAO, 'REATIVACAO_120D', { ...base, ownerDepoisUid: vendedorUid, renovaCicloDe: vendedorUid, referencias: { ...base.referencias, reservaChave: chave } });
    return out(DECISOES.MANTER_SEM_OPORTUNIDADE, 'REATIVACAO_SEM_OPORTUNIDADE_VALIDA_PARA_O_VENDEDOR', { ...base, gestaoReview: true });
  }
  // sem carteira
  if (ciclo.totalVendas === 0) return out(DECISOES.CRIAR_PRIMEIRA_VENDA, 'PRIMEIRA_VENDA_VALIDA', { ...base, ownerDepoisUid: vendedorUid, renovaCicloDe: vendedorUid });
  if (!ciclo.aberta) return out(DECISOES.MANTER_SEM_CARTEIRA, 'SEM_CARTEIRA_AGUARDANDO_REATIVACAO_120D', base);
  const chave = chaveReativacao(portfolioId, ciclo.ciclo); const reserva = reservas && reservas.get(chave);
  if (reservaValida(reserva, vendedorUid, data)) return out(DECISOES.CRIAR_VIA_REATIVACAO, 'REATIVACAO_120D_SEM_CARTEIRA', { ...base, ownerDepoisUid: vendedorUid, renovaCicloDe: vendedorUid, referencias: { ...base.referencias, reservaChave: chave } });
  return out(DECISOES.MANTER_SEM_OPORTUNIDADE, 'SEM_CARTEIRA_SEM_OPORTUNIDADE_VALIDA', { ...base, gestaoReview: true });
}

/** Sequência de um cliente em ordem comercial, com o dono evoluindo (para comparação com a sombra). */
function sequenciaB3({ vendasCliente, carteiraInicial, vend, reservas, hoje, devolucoes, conflitoGc, corte }) {
  const todas = validas(vendasCliente, hoje, devolucoes); let cart = carteiraInicial ? { ...carteiraInicial } : null; const out = [];
  for (const v of todas) {
    if (corte && dataDe(v) < corte) continue;                                  // antes do corte: só HISTÓRICO (não cria/transfere nem renova nada)
    const d = decidirVendaB3({ venda: v, vendasCliente, carteira: cart, vend, reservas, hoje, devolucoes, conflitoGc }); out.push({ venda: v, d });
    if (ALTERA_OWNER.includes(d.decisao)) cart = { ...(cart || {}), ownerUid: d.ownerDepoisUid, cicloAncoraEm: dataDe(v) };
    else if (RENOVA_CICLO.includes(d.decisao) && cart) cart = { ...cart, cicloAncoraEm: dataDe(v) };
  }
  return out;
}
module.exports = { DIAS_CICLO, RESERVA_DIAS, LIMITE_DIARIO, COOLDOWN_SEM_INTERESSE_DIAS, DECISOES, ALTERA_OWNER, RENOVA_CICLO, chaveReativacao, indexarVendedores, classeDaVenda, validas, cicloDoCliente,
  prioridadesRfm, planejarLiberacao, decidirVendaB3, reservaValida, sequenciaB3, somarDias, diasEntre, portfolioDe, gcId, chaveOrdem };
