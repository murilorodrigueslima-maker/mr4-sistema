'use strict';
/**
 * INF-01 / INF-12 — execução INCREMENTAL e com trava do processador de vendas da reativação (agendador `reativacaoVendas`).
 *
 * A regra comercial NÃO está aqui: continua em reativacaoVendas.processarVendas. Este módulo só decide QUAIS documentos ler.
 *
 * Por que é equivalente à varredura completa: depois de uma execução limpa, uma venda só volta a ficar pendente se
 *   (a) mudou no espelho        → vendas_gc.modificado_em >= marca d'água − 72 h (a marca nunca passa do cursor já confirmado pelo sync);
 *   (b) a data comercial chegou → data em (hoje anterior, hoje]  (venda pré-datada deixa de ser DATA_FUTURA sem ser regravada);
 *   (c) mudou a devolução       → comparação com as devoluções vistas na execução anterior;
 *   (d) mudou corte/modo/regra, o sync reconciliou/refez o histórico, ou sumiu venda/decisão → varredura completa.
 * Cada candidata é conferida pela MESMA função (revisaoVenda); para os clientes com pendência lê-se o histórico inteiro do cliente.
 * Invalidações: reavalia os eventos B3 das candidatas inválidas e das que já estavam inválidas na execução anterior.
 * Vendas regravadas sem mudança não geram trabalho (a conferência é por conteúdo), então o sync não precisou mudar.
 *
 * FAIL-CLOSED: qualquer dúvida (sem estado, estado adulterado, execução anterior incompleta, erro de leitura, volume alto) ⇒ varredura
 * completa. Reconciliação: uma completa por dia (primeira execução a partir de 05:00 de Fortaleza) e nunca mais de 25 h sem uma.
 * Desligar sem implantar: carteira_comercial_config/reativacao.incremental = false (volta a varrer tudo a cada execução).
 *
 * Documentos próprios (Admin SDK; Rules negam o cliente por padrão): reativacao_estado/vendas (marca d'água) e reativacao_estado/lease.
 */
const crypto = require('crypto');
const PV = require('./reativacaoVendas'); const CTX = require('./reativacaoContexto');
const { validarVenda, tsMais, agoraNoFusoGc } = require('./carteiraRegra'); const { normalizeGestaoClickId } = require('./commercialIdentity');
const { criarContador } = require('./contadorLeituras');

const COLL_ESTADO = 'reativacao_estado';
const REF_ESTADO = `${COLL_ESTADO}/vendas`, REF_LEASE = `${COLL_ESTADO}/lease`;
const VERSAO_ESTADO = 1;
const LEASE_TTL_MS = 6 * 60000;                         // maior que o timeout da função (300 s): a trava nunca vence com a dona ainda viva
const SOBREPOSICAO_HORAS = 72;
const HORA_COMPLETA = 5;                                 // Fortaleza: a execução das 05:50 reconcilia antes do job diário das 06:00
const MAX_ENTRE_COMPLETAS_MS = 25 * 3600000;
const LIMITES = Object.freeze({ candidatas: 500, clientes: 100, invalidas: 200 });   // acima disso a completa é mais segura (e de custo parecido)
const TS_GC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, YMD = /^\d{4}-\d{2}-\d{2}$/;

const canonico = v => (Array.isArray(v) ? '[' + v.map(canonico).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v));
const sha = v => crypto.createHash('sha256').update(canonico(v)).digest('hex').slice(0, 32);
const integridadeDe = estado => { const { integridade, pendente, ...resto } = estado; return sha(resto); };
const assinaturaCfg = (cfg, modo) => sha([PV.REGRA_VERSAO, VERSAO_ESTADO, modo, cfg.corte || null, cfg.corteTs || null, cfg.ativadoEm || null]);
/** Dia de referência da reconciliação: vira às HORA_COMPLETA de Fortaleza (UTC−3). */
const diaReferencia = agoraIso => new Date(Date.parse(agoraIso) - (3 + HORA_COMPLETA) * 3600000).toISOString().slice(0, 10);
const lotes = (arr, n = 30) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };
const porId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const falha = codigo => Object.assign(new Error(codigo), { codigo });

function estadoValido(e) {
  return !!e && e.versao === VERSAO_ESTADO && typeof e.integridade === 'string' && e.integridade === integridadeDe(e)
    && TS_GC.test(String(e.marca)) && YMD.test(String(e.hoje)) && YMD.test(String(e.diaCompleta)) && Number.isFinite(Date.parse(e.completaEm))
    && Number.isInteger(e.totalVendas) && e.totalVendas >= 0 && Number.isInteger(e.totalDecisoes) && e.totalDecisoes >= 0
    && !!e.devolucoes && typeof e.devolucoes === 'object' && !!e.sync && typeof e.sync === 'object'
    && Array.isArray(e.invalidas) && e.invalidas.every(x => /^\d+$/.test(String(x)));
}

/** PURO — null = pode ler incrementalmente; senão o motivo (enum) da varredura completa. */
function motivoCompleta({ cfg, estado, sinais, agoraIso }) {
  if (cfg.incremental === false) return 'INCREMENTAL_DESATIVADO';
  if (!estado) return 'SEM_ESTADO';
  if (estado.pendente === true) return 'EXECUCAO_ANTERIOR_INCOMPLETA';
  if (!estadoValido(estado)) return 'ESTADO_INVALIDO';
  if (estado.assinatura !== assinaturaCfg(cfg, 'ATIVO')) return 'CONFIGURACAO_OU_REGRA_ALTERADA';
  if (!sinais) return 'SINAIS_INDISPONIVEIS';
  if (!sinais.sync) return 'SYNC_NAO_CONFIAVEL';
  if (estado.hoje > agoraIso.slice(0, 10) || estado.marca > sinais.sync.cursor || estado.marca > agoraNoFusoGc(agoraIso) || Date.parse(estado.completaEm) > Date.parse(agoraIso)) return 'CURSOR_INCONSISTENTE';
  if (estado.sync.reconciliacao !== sinais.sync.reconciliacao || estado.sync.bootstrap !== sinais.sync.bootstrap) return 'SYNC_RECONCILIOU';
  if (sinais.totalVendas < estado.totalVendas) return 'VENDAS_REMOVIDAS';
  if (sinais.totalDecisoes < estado.totalDecisoes) return 'DECISOES_REMOVIDAS';
  if (estado.invalidas.length > LIMITES.invalidas) return 'VOLUME_ALTO';
  if (estado.diaCompleta !== diaReferencia(agoraIso)) return 'RECONCILIACAO_DIARIA';
  if (Date.parse(agoraIso) - Date.parse(estado.completaEm) > MAX_ENTRE_COMPLETAS_MS) return 'RECONCILIACAO_VENCIDA';
  return null;
}

const contar = async (store, colecao) => (await store.collection(colecao).count().get()).data().count;
/** Sinais baratos, lidos ANTES das vendas: cursor confirmado pelo sync e totais (agregação). */
async function lerSinais(store) {
  const [s, totalVendas, totalDecisoes] = await Promise.all([store.collection('sync_state').doc('perfil360').get(), contar(store, 'vendas_gc'), contar(store, PV.COLL_DEC)]);
  const d = s.exists ? s.data() : null;
  const sync = d && d.status === 'READY' && TS_GC.test(String(d.modifiedSinceCursor || ''))
    ? { cursor: d.modifiedSinceCursor, reconciliacao: String(d.lastReconciliationAt || ''), bootstrap: String(d.lastBootstrapAt || '') } : null;
  return { sync, totalVendas, totalDecisoes };
}

/** Leitura incremental (SOMENTE LEITURA): devolve a carga no formato de processarVendas, ou LANÇA (⇒ varredura completa). */
async function carregarIncremental(store, { estado, hoje, corte, corteTs, limites = LIMITES }) {
  const V = store.collection('vendas_gc');
  const ler = async q => (await q.select(...CTX.CAMPOS_VENDA).get()).docs;
  const [modificadas, viradas, devSnap] = await Promise.all([
    ler(V.where('modificado_em', '>=', tsMais(estado.marca, -SOBREPOSICAO_HORAS)).limit(limites.candidatas + 1)),
    hoje > estado.hoje ? ler(store.collection('vendas_gc').where('data', '>', estado.hoje).where('data', '<=', hoje).limit(limites.candidatas + 1)) : [],
    store.collection('carteira_comercial_devolucoes').get(),
  ]);
  const devolucoes = CTX.montarDevolucoes(devSnap.docs);
  const candidatas = new Map([...modificadas, ...viradas].map(d => [d.id, { id: d.id, ...d.data() }]));
  if (candidatas.size > limites.candidatas) throw falha('VOLUME_ALTO');
  // venda cuja devolução foi criada/alterada/removida: buscada por id (ela não é modificada)
  const idsDev = new Set([...devolucoes.keys(), ...Object.keys(estado.devolucoes)]);
  const mudaramDev = [...idsDev].filter(id => (devolucoes.get(id) || null) !== (estado.devolucoes[id] || null));
  const extras = mudaramDev.filter(id => !candidatas.has(id));
  if (extras.length > limites.candidatas) throw falha('VOLUME_ALTO');
  const removidas = [];
  for (const s of await Promise.all(extras.map(id => store.collection('vendas_gc').doc(String(id)).get()))) s.exists ? candidatas.set(s.id, { id: s.id, ...s.data() }) : removidas.push(s.id);

  const decisoes = new Map(), consultadas = new Set();
  const lerDecisoes = async ids => {
    const novos = ids.filter(id => !consultadas.has(id)); novos.forEach(id => consultadas.add(id));
    for (const s of await Promise.all(lotes(novos).map(l => store.collection(PV.COLL_DEC).where('vendaId', 'in', l).get()))) s.docs.forEach(d => decisoes.set(d.id, d.data()));
  };
  const posCorte = [...candidatas.values()].filter(v => PV.ehPosCorte(v, corte, corteTs));
  await lerDecisoes(posCorte.map(v => v.id));
  const ultima = new Map(); for (const x of decisoes.values()) { const k = String(x.vendaId); if (!ultima.has(k) || x.revisao > ultima.get(k).revisao) ultima.set(k, x); }
  const pendentes = posCorte.filter(v => normalizeGestaoClickId(v.cliente_id) && (!ultima.has(v.id) || ultima.get(v.id).revisaoVenda !== PV.revisaoVenda(v, hoje, devolucoes)));
  const clientes = [...new Set(pendentes.map(v => normalizeGestaoClickId(v.cliente_id)))];
  if (pendentes.some(v => String(v.cliente_id) !== normalizeGestaoClickId(v.cliente_id))) throw falha('CLIENTE_ID_NAO_CANONICO');
  if (clientes.length > limites.clientes) throw falha('VOLUME_ALTO');

  const ctx = { carteiras: new Map(), vend: CTX.montarVendedores([], []), vendasPorCliente: new Map(), conflitosGc: new Set(), reservasExistentes: new Map(), devolucoes };
  if (clientes.length) {
    const portfolios = clientes.map(g => 'GC:' + g);
    const [historicos, users, sistema, carteiras, emConflito, registro, reservas] = await Promise.all([
      Promise.all(lotes(clientes).map(l => ler(store.collection('vendas_gc').where('cliente_id', 'in', l)))),
      store.collection('users').get(), store.collection('sistema_usuarios').get(),
      Promise.all(portfolios.map(p => store.collection('carteira_comercial').doc(p).get())),
      store.collection('carteira_comercial').where('conflito.revisao', '==', 'PENDENTE').get(),
      store.collection('identidade_conflitos').where('status', '==', 'PENDENTE').get(),
      Promise.all(lotes(portfolios).map(l => store.collection('carteira_reativacoes').where('portfolioId', 'in', l).get())),
    ]);
    const vendas = historicos.flat().sort(porId);                  // mesma ordem (id) da leitura integral
    ctx.vendasPorCliente = CTX.agruparVendas(vendas);
    const lidas = new Set(vendas.map(d => d.id));
    if (pendentes.some(v => !lidas.has(v.id))) throw falha('HISTORICO_INCONSISTENTE');
    ctx.vend = CTX.montarVendedores(users.docs, sistema.docs);
    ctx.carteiras = new Map([...emConflito.docs, ...carteiras.filter(s => s.exists)].map(d => [d.id, d.data()]));
    ctx.conflitosGc = CTX.montarConflitos(ctx.carteiras, registro.docs);
    ctx.reservasExistentes = new Map(reservas.flatMap(s => s.docs).sort(porId).map(d => [d.data().chave, d.data()]));
    await lerDecisoes(vendas.map(d => ({ id: d.id, ...d.data() })).filter(v => PV.ehPosCorte(v, corte, corteTs)).map(v => v.id));
  }

  /** Eventos B3 a reavaliar: vendas hoje inválidas (ou sumidas), as que já estavam inválidas e as processadas agora. */
  const eventos = async idsProcessadas => {
    const invalida = v => !!validarVenda(v, hoje) || devolucoes.get(v.id) === 'TOTAL';
    const ids = [...new Set([...[...candidatas.values()].filter(invalida).map(v => v.id), ...removidas, ...estado.invalidas, ...idsProcessadas])].filter(id => /^\d+$/.test(id));
    const chaves = ids.flatMap(id => PV.TIPOS_EVENTO_B3.map(t => `B3:${t}:${id}`));
    const snaps = await Promise.all(lotes(chaves).map(l => store.collection('carteira_comercial_historico').where('chaveIdempotencia', 'in', l).get()));
    return snaps.flatMap(s => s.docs).filter(d => d.data().schemaVersion === 'historico-v2').sort(porId);
  };
  return { ctx, decisoes: [...decisoes.values()], eventos, candidatas: candidatas.size, clientes: clientes.length };
}

// ── trava (lease) ────────────────────────────────────────────────────────────
async function adquirirLease(store, detentor, agoraMs) {
  const ref = store.doc(REF_LEASE);
  return store.runTransaction(async tx => {
    const s = await tx.get(ref); const d = s.exists ? s.data() : null;
    if (d && Number(d.expiraEm) > agoraMs && d.detentor !== detentor) return false;
    tx.set(ref, { detentor, adquiridaEm: agoraMs, expiraEm: agoraMs + LEASE_TTL_MS });
    return true;
  });
}
async function liberarLease(store, detentor) {
  try {
    const ref = store.doc(REF_LEASE);
    await store.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists && s.data().detentor === detentor) tx.set(ref, { ...s.data(), expiraEm: 0 }); });
  } catch (_) { /* melhor esforço: o vencimento recupera */ }
}
/** Grava o estado SOMENTE se a trava ainda é desta execução. */
async function salvarEstado(store, detentor, estado) {
  return store.runTransaction(async tx => {
    const l = await tx.get(store.doc(REF_LEASE)); if (!l.exists || l.data().detentor !== detentor) return false;
    tx.set(store.doc(REF_ESTADO), { ...estado, pendente: false, integridade: integridadeDe(estado) }); return true;
  });
}

/** Ponto de entrada do agendador. Devolve o resultado de processarVendas + { execucao, motivo, leituras, … }. */
async function executarReativacaoVendas(store, FieldValue, { agoraIso, runId = null, forcarDry = PV.FORCAR_DRY, relogio = Date.now, limites = LIMITES } = {}) {
  const inicio = relogio(); const contador = criarContador(store); const db = contador.store;
  const info = { execucao: 'NENHUMA', motivo: null, candidatas: null, clientesAfetados: null, estadoSalvo: false };   // NENHUMA = vendas não chegaram a ser lidas
  const fim = r => ({ ...r, ...info, ...contador.resumo(), duracaoMs: relogio() - inicio });
  try {
    const cfgSnap = await db.doc(PV.REF_CONFIG.join('/')).get(); const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    const modo = PV.modoEfetivo(cfg, forcarDry);
    const rodar = fontes => PV.processarVendas(db, FieldValue, { agoraIso, runId, forcarDry, cfgOverride: cfg, fontes });
    // DESLIGADO / sem corte / DRY: nada é escrito (nem trava)
    const integral = async () => { info.motivo = 'MODO_NAO_ATIVO'; const r = await rodar(null); if (r.status === 'OK') info.execucao = 'COMPLETA'; return fim(r); };
    if (modo === 'DESLIGADO' || modo === 'DRY' || !YMD.test(String(cfg.corte))) return await integral();

    const detentor = crypto.randomUUID();
    if (!(await adquirirLease(db, detentor, relogio()))) { info.motivo = 'OUTRA_EXECUCAO'; return fim({ status: 'OUTRA_EXECUCAO', modo }); }   // erro aqui ⇒ nada roda
    try {
      if (modo !== 'ATIVO') return await integral();                           // SOMBRA: sempre completa
      let estado = null, sinais = null, erroEstado = false;
      try { const s = await db.doc(REF_ESTADO).get(); estado = s.exists ? s.data() : null; } catch (_) { erroEstado = true; }
      try { sinais = await lerSinais(db); } catch (_) { sinais = null; }
      const motivo = erroEstado ? 'ESTADO_ILEGIVEL' : motivoCompleta({ cfg, estado, sinais, agoraIso });
      // marca "em andamento" ANTES de qualquer escrita: queda no meio ⇒ a próxima execução varre tudo
      await db.doc(REF_ESTADO).set({ pendente: true, iniciadoEm: agoraIso }, { merge: true });
      let devolucoes = null;
      const fontes = async ({ hoje, corte, corteTs, completo }) => {
        info.motivo = motivo;
        if (!motivo) {
          try {
            const c = await carregarIncremental(db, { estado, hoje, corte, corteTs, limites });
            info.execucao = 'INCREMENTAL'; info.candidatas = c.candidatas; info.clientesAfetados = c.clientes; devolucoes = c.ctx.devolucoes;
            return c;
          } catch (e) { info.motivo = (e && e.codigo) || 'ERRO_NA_LEITURA_INCREMENTAL'; }
        }
        info.execucao = 'COMPLETA'; const c = await completo(); devolucoes = c.ctx.devolucoes; return c;
      };
      const r = await rodar(fontes);
      if (r.status === 'OK' && !r.erros.length && sinais && sinais.sync && devolucoes) {
        try {
          const incremental = info.execucao === 'INCREMENTAL';
          const invalidas = [...new Set(r.reversoes.detalhes.filter(d => d.acao !== 'RENOVACAO_INVALIDADA_REVISAO').map(d => String(d.vendaId)))].sort();
          info.estadoSalvo = await salvarEstado(db, detentor, {
            versao: VERSAO_ESTADO, assinatura: assinaturaCfg(cfg, modo), marca: [sinais.sync.cursor, agoraNoFusoGc(agoraIso)].sort()[0], hoje: r.hoje,
            sync: { reconciliacao: sinais.sync.reconciliacao, bootstrap: sinais.sync.bootstrap }, totalVendas: sinais.totalVendas, totalDecisoes: await contar(db, PV.COLL_DEC),
            devolucoes: Object.fromEntries([...devolucoes].map(([k, v]) => [k, v || null])), invalidas,
            completaEm: incremental ? estado.completaEm : agoraIso, diaCompleta: incremental ? estado.diaCompleta : diaReferencia(agoraIso), atualizadoEm: agoraIso, runId,
          });
        } catch (_) { info.estadoSalvo = false; }                          // sem estado salvo ⇒ "pendente" permanece ⇒ próxima é completa
      }
      return fim(r);
    } finally { await liberarLease(db, detentor); }
  } catch (e) { e.resumoExecucao = { ...info, ...contador.resumo(), duracaoMs: relogio() - inicio }; throw e; }
}

/** Linha de log: só enums e contagens (sem ids de venda/cliente, nomes ou valores). */
function resumoLog(r) {
  return { status: r.status, modo: r.modo, novas: r.novas, aplicadas: r.aplicadas, erros: r.erros && r.erros.length, reversoes: r.reversoes && { executadas: r.reversoes.executadas, ambiguas: r.reversoes.ambiguas },
    novasRevisoes: r.novasRevisoes, execucao: r.execucao, motivo: r.motivo, candidatas: r.candidatas, clientesAfetados: r.clientesAfetados, estadoSalvo: r.estadoSalvo, leituras: r.leituras, leiturasPorColecao: r.leiturasPorColecao, duracaoMs: r.duracaoMs };
}

module.exports = { COLL_ESTADO, REF_ESTADO, REF_LEASE, LEASE_TTL_MS, SOBREPOSICAO_HORAS, HORA_COMPLETA, LIMITES, executarReativacaoVendas, carregarIncremental, motivoCompleta, estadoValido, integridadeDe, assinaturaCfg, diaReferencia, resumoLog };
