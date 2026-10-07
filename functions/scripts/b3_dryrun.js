#!/usr/bin/env node
'use strict';
// B3 — DRY-RUN READ-ONLY do motor de 120 dias / reativação. Nenhuma escrita (só get/select/count/list). Saída sem PII (ids técnicos e contagens).
//   node functions/scripts/b3_dryrun.js [--hoje=YYYY-MM-DD] [--sem-gc]
const admin = require('firebase-admin');
const R = require('../lib/reativacao120'); const { carregarContexto } = require('../lib/reativacaoContexto');
const PV = require('../lib/reativacaoVendas'); const ID = require('../lib/identidadeConflitos'); const { gcClientesDerivados } = require('../lib/gcFetchDerivado');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
const HOJE = args.hoje || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
const cnt = a => a.length; const val = (v, n) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? x.length : x]));

(async () => {
  // conflitos de identidade (GC, somente leitura) → ids bloqueados mesmo sem carteira
  let conflitosExtra = [], gruposConf = null;
  if (!args['sem-gc']) { const gc = await gcClientesDerivados(); const carteirasIni = new Map((await db.collection('carteira_comercial').get()).docs.map(d => [d.id, d.data()])); const c = ID.detectarConflitos(gc, carteirasIni, null); conflitosExtra = c.grupos.flatMap(g => g.ids); gruposConf = c.resumo; }
  const ctx = await carregarContexto(db, { hoje: HOJE, conflitosGcExtra: conflitosExtra });
  const { carteiras, vend, vendasPorCliente } = ctx; const base = { hoje: HOJE, carteiras, vend, vendasPorCliente, conflitosGc: ctx.conflitosGc, naoContatar: ctx.naoContatar, cooldowns: ctx.cooldowns, followUps: ctx.followUps, reservasExistentes: ctx.reservasExistentes, devolucoes: ctx.devolucoes, semCarteira: ctx.semCarteira };
  const pCart = R.planejarLiberacao(base), pSem = R.planejarLiberacao({ ...base, incluirSemCarteira: true });
  const nome = {}; for (const d of (await db.collection('sistema_usuarios').get()).docs) nome[d.id] = (d.data().nome || '').split(' ')[0].toUpperCase();
  const por = (plan, tipo) => { const o = {}; plan.liberar.forEach(x => { if (!tipo || x.tipo === tipo) o[nome[x.destinoUid] || x.destinoUid] = (o[nome[x.destinoUid] || x.destinoUid] || 0) + 1; }); return o; };

  // A) carteiras >=120d (elegíveis antes dos bloqueios) e efeito da regra "gestão é neutra"
  let aberta = 0, abertaNaive = 0, soPorGestao = 0, owners = {};
  for (const [pid, c] of carteiras) {
    const id = pid.slice(3), vs = vendasPorCliente.get(id) || [];
    const b3 = R.cicloDoCliente({ vendasCliente: vs, carteira: c, vend, hoje: HOJE, devolucoes: ctx.devolucoes });
    const ingenuo = R.cicloDoCliente({ vendasCliente: vs, carteira: null, vend, hoje: HOJE, devolucoes: ctx.devolucoes });       // qualquer venda válida renova
    if (b3.aberta) aberta++; if (ingenuo.aberta) abertaNaive++; if (b3.aberta && !ingenuo.aberta) soPorGestao++;
    if (b3.aberta) owners[nome[c.ownerUid] || c.ownerUid] = (owners[nome[c.ownerUid] || c.ownerUid] || 0) + 1;
  }
  // sem carteira >=120d (compradores)
  const semAbertos = ctx.semCarteira.filter(id => R.cicloDoCliente({ vendasCliente: vendasPorCliente.get(id), carteira: null, vend, hoje: HOJE, devolucoes: ctx.devolucoes }).aberta);
  const semLiberaveis = pSem.candidatosElegiveis - pCart.candidatosElegiveis;
  const cfgRegra = await db.doc('carteira_comercial_config/regra').get(); const CORTE = cfgRegra.exists ? cfgRegra.data().ativoDesde : null;
  // decisões em sombra x motor B3 (só vendas >= corte são avaliadas; antes do corte = histórico)
  const decSnap = await db.collection('carteira_comercial_decisoes_sombra').get(); const ultimaRev = new Map();
  decSnap.docs.forEach(d => { const x = d.data(); const k = String(x.vendaId); if (!ultimaRev.has(k) || Number(x.revisao || 1) > Number(ultimaRev.get(k).revisao || 1)) ultimaRev.set(k, x); });
  const todasDec = decSnap.docs.map(d => d.data());
  const porCliente = new Map(); for (const d of ultimaRev.values()) { const g = String(d.portfolioId).slice(3); if (!porCliente.has(g)) porCliente.set(g, []); porCliente.get(g).push(d); }
  const EQ = { 'MANTER:VENDA_DO_DONO': ['RENOVAR_OWNER'], 'MANTER:CARTEIRA_PROTEGIDA_MENOS_120D': ['COBERTURA_RENOVA_OWNER'], 'MANTER:COBERTURA_PAUSA_TEMPORARIA': ['COBERTURA_PAUSA'], 'MANTER:SEM_CARTEIRA_AGUARDANDO_REATIVACAO_120D': ['MANTER_SEM_CARTEIRA'],
    'CRIAR_PRIMEIRA_VENDA:PRIMEIRA_VENDA_VALIDA': ['CRIAR_PRIMEIRA_VENDA'], 'VENDA_INVALIDADA:VENDA_INVALIDADA_SITUACAO_NAO_CONCRETIZADA': ['IGNORAR_INVALIDA'] };
  const cmp = { iguais: 0, divergentes: 0, porCategoria: {}, criacaoTeorica: 0, transferenciaTeorica: 0, bloqueadosPorConflito: 0, renovacoesB3: 0, divergentesIds: [] };
  for (const [g, ds] of porCliente) {
    const cart0 = carteiras.get('GC:' + g) || null; const seq = R.sequenciaB3({ vendasCliente: vendasPorCliente.get(g) || [], carteiraInicial: cart0 ? { ownerUid: cart0.ownerUid } : null, vend, reservas: new Map(), hoje: HOJE, devolucoes: ctx.devolucoes, conflitoGc: ctx.conflitosGc, corte: CORTE });
    const porVenda = new Map(seq.map(s => [String(s.venda.id), s.d]));
    for (const d of ds) {
      const b3 = porVenda.get(String(d.vendaId)) || { decisao: d.decisao === 'VENDA_INVALIDADA' ? 'IGNORAR_INVALIDA' : 'SEM_REAVALIACAO' };
      if (d.decisao === 'CRIAR_REATIVACAO') cmp.criacaoTeorica++; if (d.decisao === 'TRANSFERIR_R2') cmp.transferenciaTeorica++;
      if (b3.decisao === 'BLOQUEADO_CONFLITO') cmp.bloqueadosPorConflito++; if (['RENOVAR_OWNER', 'COBERTURA_RENOVA_OWNER', 'COBERTURA_PAUSA'].includes(b3.decisao)) cmp.renovacoesB3++;
      const ok = (EQ[d.decisao + ':' + d.motivo] || []).includes(b3.decisao);
      if (ok) cmp.iguais++; else { cmp.divergentes++; const cat = d.decisao + '/' + d.motivo + ' -> ' + b3.decisao; cmp.porCategoria[cat] = (cmp.porCategoria[cat] || 0) + 1; if (cmp.divergentesIds.length < 15) cmp.divergentesIds.push(String(d.vendaId)); }
    }
  }
  // fontes de devolução/cancelamento (evidência)
  const situ = {}; let totalVendas = 0, zerado = 0; for (const vs of vendasPorCliente.values()) for (const v of vs) { totalVendas++; situ[v.nome_situacao] = (situ[v.nome_situacao] || 0) + 1; if (!(parseFloat(v.valor_total) > 0)) zerado++; }
  let titDev = 0, titTotal = 0; try { const t = await db.collection('fin_n1_titulos').get(); titTotal = t.size; t.docs.forEach(d => { if (/devolu/i.test(JSON.stringify(d.data()))) titDev++; }); } catch (_) { /* coleção ausente */ }
  const cfgReat = await db.doc('carteira_comercial_config/reativacao').get();
  // impacto de vendas novas / cancelamentos / devoluções desde o corte (SIMULAÇÃO: modo DRY forçado, ZERO escritas)
  const imp = CORTE ? await PV.processarVendas(db, admin.firestore.FieldValue, { agoraIso: new Date().toISOString(), forcarDry: true, cfgOverride: { modo: 'DRY', corte: CORTE } }) : null;
  let canceladasDesdeCorte = 0, vendasDesdeCorte = 0; for (const vs of vendasPorCliente.values()) for (const v of vs) if (String(v.data).slice(0, 10) >= (CORTE || '9999')) { vendasDesdeCorte++; if (v.nome_situacao !== 'Concretizada') canceladasDesdeCorte++; }
  const relat = {
    ok: true, hoje: HOJE, escritasEmProducao: 0,
    carteiras: carteiras.size, owners: val(Object.fromEntries(Object.entries(require('../lib/carteiraV2').contagemPorOwner(Object.fromEntries([...carteiras].map(([k, v]) => [k, v])), nome)).map(([k, v]) => [k, v])), {}),
    A_carteiras_ge120: { b3: aberta, ingenuo_qualquer_venda: abertaNaive, abertas_somente_porque_ultima_venda_foi_da_gestao: soPorGestao, porOwner: owners },
    elegiveis_carteiras_apos_bloqueios: pCart.candidatosElegiveis, B_para_ademir: pCart.porDestino[Object.keys(nome).find(k => nome[k] === 'ADEMIR')] || 0, C_para_fabiana: pCart.porDestino[Object.keys(nome).find(k => nome[k] === 'FABIANA')] || 0,
    D_sem_carteira_compradores_ge120: semAbertos.length, D_sem_carteira_elegiveis_apos_bloqueios: semLiberaveis,
    E_bloqueados_conflito: { carteiras: pCart.bloqueados.CONFLITO.length, semCarteira: pSem.bloqueados.CONFLITO.length - pCart.bloqueados.CONFLITO.length },
    F_bloqueados_nao_contatar: pSem.bloqueados.NAO_CONTATAR.length, G_bloqueados_cooldown: pSem.bloqueados.COOLDOWN.length, G_bloqueados_followup: pSem.bloqueados.FOLLOWUP.length,
    outros_bloqueios: { owner_em_pausa: pSem.bloqueados.OWNER_EM_PAUSA.length, sem_vendedor_destino: pSem.bloqueados.SEM_VENDEDOR_DESTINO.length, reserva_ja_criada: pSem.bloqueados.RESERVA_JA_CRIADA.length },
    H_limite: pSem.limite, H_dias_carteiras: pCart.diasEstimados, H_dias_com_sem_carteira: pSem.diasEstimados, H_dias_por_vendedor: Object.fromEntries(Object.entries(pSem.diasPorVendedor).map(([u, d]) => [nome[u] || u, d])),
    primeiro_dia_liberacao: { carteiras: por(pCart), com_sem_carteira: por(pSem), so_sem_carteira: por(pSem, 'SEM_CARTEIRA') },
    destino_total_com_sem_carteira: Object.fromEntries(Object.entries(pSem.porDestino).map(([u, n]) => [nome[u] || u, n])),
    conflitos_gc: gruposConf, fontes: ctx.fontes, shadow: { decisoesBrutas: todasDec.length, porDecisaoTodasRevisoes: todasDec.reduce((o, d) => (o[d.decisao] = (o[d.decisao] || 0) + 1, o), {}), porDecisaoUltimaRevisao: [...ultimaRev.values()].reduce((o, d) => (o[d.decisao] = (o[d.decisao] || 0) + 1, o), {}), criacoesTeoricasUltimaRevisao: [...ultimaRev.values()].filter(d => d.decisao === 'CRIAR_PRIMEIRA_VENDA' || d.decisao === 'CRIAR_REATIVACAO').length, executadas_oficialmente: 0, ultimasRevisoesPorVenda: ultimaRev.size, modoRegra: cfgRegra.exists ? cfgRegra.data().modo : null, modoReativacao: cfgReat.exists ? cfgReat.data().modo : 'AUSENTE (DESLIGADO)', comparacao: cmp },
    impacto_vendas_desde_o_corte: imp ? { corte: CORTE, vendasAvaliadas: imp.vendasAvaliadas, ignoradasAntesDoCorte: imp.ignoradasAntesDoCorte, decisoes: imp.decisoes, foraDeOrdem: imp.foraDeOrdem.length, reversoes: imp.reversoes ? { candidatas: imp.reversoes.candidatas, reverter: imp.reversoes.reverter, ambiguas: imp.reversoes.ambiguas, renovacoesInvalidadas: imp.reversoes.renovacoesInvalidadas } : null, vendasNaoConcretizadasDesdeCorte: canceladasDesdeCorte, vendasDesdeCorteComStatusDiferenteOuTotal: vendasDesdeCorte, devolucoesRegistradas: ctx.devolucoes.size } : null,
    evidencias: { vendas_por_situacao: situ, vendas_total_com_cliente: totalVendas, vendas_valor_zerado: zerado, titulos_financeiros_total: titTotal, titulos_com_texto_devolucao: titDev, devolucoes_registradas_fonte: ctx.devolucoes.size },
  };
  console.log(JSON.stringify(relat, null, 1)); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
