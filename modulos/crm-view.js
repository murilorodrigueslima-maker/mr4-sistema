// crm-view.js — CRM MR4 2.0 / Fase 1
// View-model PURO (sem DOM, sem Firebase). Incluído por crm.html e testado em functions/test/crm-f1-*.test.js.
// NÃO decide distribuição: CONSOME fila_comercial/worklist + interacoes_fila exatamente como o gerador deixou.
// Reaproveita FilaWorklistView (fila-worklist-view.js) para o estado visual de cada item.
(function (root) {
  'use strict';

  var FWV = root.FilaWorklistView || (typeof require === 'function' ? require('./fila-worklist-view.js') : null);
  var TZ = 'America/Fortaleza';
  var NOTA_MAX = 280;

  var RESULTADOS = [
    { codigo: 'CONVERSA_REALIZADA',  rotulo: 'Contato realizado',  curto: 'Falei',          exigeData: false },
    { codigo: 'SEM_RESPOSTA',        rotulo: 'Sem resposta',       curto: 'Não atendeu',    exigeData: false },
    { codigo: 'PEDIU_RETORNO',       rotulo: 'Pediu retorno',      curto: 'Ligar depois',   exigeData: true  },
    { codigo: 'SEM_INTERESSE_AGORA', rotulo: 'Sem interesse agora', curto: 'Sem interesse', exigeData: false },
    { codigo: 'CONTATO_INVALIDO',    rotulo: 'Contato inválido',   curto: 'Contato errado', exigeData: false },
  ];
  var ROTULO_RESULTADO = {};
  RESULTADOS.forEach(function (r) { ROTULO_RESULTADO[r.codigo] = r.rotulo; });
  var ROTULO_TENDENCIA = { CRESCENDO: 'em alta', ESTAVEL: 'estável', CAINDO: 'em queda' };

  function dataComercial(date) { return FWV.dataComercial(date || new Date()); }
  function somarDias(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function diaDaSemana(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }   // 0 = domingo
  /** Último dia (domingo) da semana corrente de `hoje`. */
  function fimDaSemana(ymd) { var dw = diaDaSemana(ymd); return somarDias(ymd, dw === 0 ? 0 : 7 - dw); }

  function ultimoOutcome(op) {
    var evs = ((op && op.eventos) || []).filter(function (e) { return e && e.tipo === 'OUTCOME_REGISTERED'; });
    return evs.length ? evs[evs.length - 1] : null;
  }
  function emCooldown(op, agoraMs) { return !!(op && op.cooledUntil && agoraMs < Date.parse(op.cooledUntil)); }
  /** Dono do retorno = autor do último resultado (mesma regra do gerador e do servidor). */
  function donoDoRetorno(op, agoraMs) {
    if (!op || op.estado === 'CONCLUIDA' || !op.nextFollowUpAt || emCooldown(op, agoraMs)) return null;
    var u = ultimoOutcome(op);
    return u ? u.operadorId || null : null;
  }

  /**
   * HOJE — ordem operacional: ATRASADOS → RETORNOS DE HOJE → EM ATENDIMENTO → PENDENTES → NOVAS (+ trabalhados hoje).
   * Base: FilaWorklistView.montarVisaoVendedor (worklist de hoje). Acrescenta retornos vencidos do próprio vendedor
   * que existem em interacoes_fila mas não estão na worklist do dia (ex.: fim de semana, antes das 06:00).
   */
  function montarHoje(p) {
    var hoje = p.hoje, agoraMs = p.agoraMs, uid = p.uid;
    var out = { atrasados: [], retornosHoje: [], emAtendimento: [], pendentes: [], novas: [], trabalhadasHoje: [], worklistDeHoje: false, cap: null };
    var visao = FWV.montarVisaoVendedor({ doc: p.doc, opMap: p.opMap, uid: uid, hoje: hoje, agoraMs: agoraMs, podeOperar: p.podeOperar });
    var vistos = {};
    if (visao) {
      out.worklistDeHoje = true; out.cap = visao.contagens.cap;
      visao.retornos.forEach(function (v) {
        var op = p.opMap && p.opMap.get ? p.opMap.get(v.item.opportunityInstanceId) : null;
        var data = (op && op.nextFollowUpAt) || v.item.nextFollowUpAt || null;
        v.dataRetorno = data;
        (data && data < hoje ? out.atrasados : out.retornosHoje).push(v);
        vistos[v.item.opportunityInstanceId] = true;
      });
      visao.emAtendimento.forEach(function (v) { out.emAtendimento.push(v); vistos[v.item.opportunityInstanceId] = true; });
      visao.novas.forEach(function (v) { (v.grupoOrigem === 'pendentes' ? out.pendentes : out.novas).push(v); vistos[v.item.opportunityInstanceId] = true; });
      visao.trabalhadasHoje.forEach(function (v) { out.trabalhadasHoje.push(v); vistos[v.item.opportunityInstanceId] = true; });
    }
    // B3.1 — oportunidades de REATIVAÇÃO (reservas ativas do próprio vendedor), independentes da worklist do dia. Reserva ≠ ownership.
    out.reativacoes = [];
    (p.reativacoes || []).forEach(function (item) {
      if (!item || !item.opportunityInstanceId || vistos[item.opportunityInstanceId]) return;
      var op = p.opMap && p.opMap.get ? p.opMap.get(item.opportunityInstanceId) : null;
      out.reativacoes.push({ item: item, grupoOrigem: 'reativacoes', estado: FWV.estadoVisual(op, { uid: uid, hoje: hoje, agoraMs: agoraMs, podeOperar: p.podeOperar }) });
      vistos[item.opportunityInstanceId] = true;
    });
    // retornos próprios vencidos que não vieram na worklist do dia (estado real em interacoes_fila)
    if (p.opMap && p.opMap.forEach) {
      p.opMap.forEach(function (op, oppId) {
        if (vistos[oppId]) return;
        if (donoDoRetorno(op, agoraMs) !== uid || op.nextFollowUpAt > hoje) return;
        var item = { opportunityInstanceId: oppId, commercialEntityId: op.commercialEntityId, tipoOportunidade: op.tipoOportunidade, nomeCliente: op.nomeCliente || null };
        var v = { item: item, grupoOrigem: 'followUps', estado: FWV.estadoVisual(op, { uid: uid, hoje: hoje, agoraMs: agoraMs, podeOperar: p.podeOperar }), dataRetorno: op.nextFollowUpAt, foraDaWorklist: true };
        if (v.estado.codigo === 'EM_ATENDIMENTO_MEU') out.emAtendimento.push(v);
        else (op.nextFollowUpAt < hoje ? out.atrasados : out.retornosHoje).push(v);
      });
    }
    out.atrasados.sort(function (a, b) { return String(a.dataRetorno || '') < String(b.dataRetorno || '') ? -1 : 1; });
    out.contagens = { atrasados: out.atrasados.length, retornosHoje: out.retornosHoje.length, emAtendimento: out.emAtendimento.length,
      pendentes: out.pendentes.length, novas: out.novas.length, trabalhadasHoje: out.trabalhadasHoje.length, reativacoes: out.reativacoes.length };
    return out;
  }

  /**
   * AGENDA — retornos do vendedor `uid` (gestão pode passar qualquer uid; estrutura pronta para "todos").
   * Baldes: ATRASADOS (< hoje) · HOJE · AMANHÃ (hoje+1) · ESTA SEMANA (até domingo) · DEPOIS.
   */
  function montarAgenda(p) {
    var hoje = p.hoje, agoraMs = p.agoraMs;
    var amanha = somarDias(hoje, 1), fim = fimDaSemana(hoje);
    var out = { atrasados: [], hoje: [], amanha: [], semana: [], depois: [] };
    if (!p.opMap || !p.opMap.forEach) return out;
    p.opMap.forEach(function (op, oppId) {
      var dono = donoDoRetorno(op, agoraMs);
      if (!dono || (p.uid && dono !== p.uid)) return;
      var u = ultimoOutcome(op);
      var it = { opportunityInstanceId: oppId, commercialEntityId: op.commercialEntityId, nomeCliente: op.nomeCliente || null, tipoOportunidade: op.tipoOportunidade,
        data: op.nextFollowUpAt, estado: op.estado, donoUid: dono, ultimoResultado: u ? { outcome: u.outcome, rotulo: ROTULO_RESULTADO[u.outcome] || u.outcome, em: u.timestamp, temNota: !!(u.meta && u.meta.temNota) } : null };
      var d = op.nextFollowUpAt;
      if (d < hoje) out.atrasados.push(it);
      else if (d === hoje) out.hoje.push(it);
      else if (d === amanha) out.amanha.push(it);
      else if (d <= fim) out.semana.push(it);
      else out.depois.push(it);
    });
    Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return a.data < b.data ? -1 : a.data > b.data ? 1 : String(a.nomeCliente) < String(b.nomeCliente) ? -1 : 1; }); });
    return out;
  }

  /**
   * CARTÃO — só campos com dado confiável (ausente ⇒ não aparece).
   * extras (opcional, de crmConsulta 'cartoes'): { categorias[], faixaValor, frequenciaDias, ticketMedio180d?, faturamento180d? }
   */
  function modeloCartao(v, op, extras) {
    var item = v.item || {};
    var base = FWV.modeloCard(item);
    var ctx = item.contextoComercial || {};
    var h = ctx.historico || {};
    var u = ultimoOutcome(op);
    var linhas = [];
    if (h.diasSemComprar != null) linhas.push({ k: 'Dias sem comprar', v: String(h.diasSemComprar) });
    if (h.ultimaCompraEm) linhas.push({ k: 'Última compra', v: dataBR(h.ultimaCompraEm) });
    if (h.pedidosTotal != null) linhas.push({ k: 'Pedidos', v: String(h.pedidosTotal) });
    var freq = (h.cicloHabitualDias != null) ? h.cicloHabitualDias : (extras && extras.frequenciaDias != null ? extras.frequenciaDias : null);
    if (freq != null) linhas.push({ k: 'Compra a cada', v: '~' + freq + ' dias' });
    if (ctx.tendencia && ROTULO_TENDENCIA[ctx.tendencia]) linhas.push({ k: 'Tendência', v: ROTULO_TENDENCIA[ctx.tendencia] });
    if (extras && extras.categorias && extras.categorias.length) linhas.push({ k: 'Categorias', v: extras.categorias.join(', ') });
    if (extras && extras.ticketMedio180d != null) linhas.push({ k: 'Ticket 180d', v: moedaBR(extras.ticketMedio180d) });
    return {
      opportunityInstanceId: item.opportunityInstanceId, entidade: item.commercialEntityId,
      nome: item.nomeCliente || 'Cliente', tipo: ctx.rotuloTipo || item.labelOp || null, motivo: base && base.motivo ? base.motivo : null,
      linhas: linhas, altoValor: !!(extras && extras.faixaValor === 'ALTO_VALOR'),
      ultimoResultado: u ? { rotulo: ROTULO_RESULTADO[u.outcome] || u.outcome, em: u.timestamp, temNota: !!(u.meta && u.meta.temNota) } : null,
      proximoRetorno: (op && op.nextFollowUpAt && op.estado !== 'CONCLUIDA') ? op.nextFollowUpAt : (v.dataRetorno || null),
      estado: v.estado, grupoOrigem: v.grupoOrigem, pendenteDesde: item.atribuidoDesde || null,
    };
  }

  /** Observação: trim; vazio permitido; máximo 280 (code points) — espelho da regra do servidor. */
  function validarNota(texto) {
    var t = String(texto == null ? '' : texto).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    var n = Array.from(t).length;
    return { ok: n <= NOTA_MAX, texto: t, tamanho: n, restante: NOTA_MAX - n };
  }
  /** Data mínima/máxima aceitas para "pediu retorno" (servidor aplica a mesma regra: > hoje e ≤ hoje+180). */
  function limitesRetorno(hoje) { return { min: somarDias(hoje, 1), max: somarDias(hoje, 180) }; }

  function dataBR(ymd) { if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ''; var p = String(ymd).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  // ausente (null/undefined/'') → '' (a tela omite); nunca vira "R$ 0,00"
  function moedaBR(v) { if (v === null || v === undefined || v === '') return ''; var n = Number(v); if (!isFinite(n)) return ''; return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function horaBR(iso) {
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch (e) { return ''; }
  }
  function rotuloDia(ymd, hoje) {
    if (ymd === hoje) return 'Hoje';
    if (ymd === somarDias(hoje, 1)) return 'Amanhã';
    if (ymd === somarDias(hoje, -1)) return 'Ontem';
    return dataBR(ymd);
  }

  var api = {
    RESULTADOS: RESULTADOS, ROTULO_RESULTADO: ROTULO_RESULTADO, NOTA_MAX: NOTA_MAX,
    dataComercial: dataComercial, somarDias: somarDias, fimDaSemana: fimDaSemana, ultimoOutcome: ultimoOutcome, donoDoRetorno: donoDoRetorno,
    montarHoje: montarHoje, montarAgenda: montarAgenda, modeloCartao: modeloCartao, validarNota: validarNota, limitesRetorno: limitesRetorno,
    dataBR: dataBR, moedaBR: moedaBR, horaBR: horaBR, rotuloDia: rotuloDia,
  };
  root.CrmView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
