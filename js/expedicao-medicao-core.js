// MR4 — Expedição · medição (cálculo puro; usado pela página, pelo script semanal e pelos testes).
// Entrada: pedidos, eventos imutáveis (eventos/v{n}) e, se houver, os registros opcionais (expedicao_medicao).
// Saída: só agregados; operadores aparecem como O1, O2… (nunca nome, e-mail ou uid).
// IMPORTANTE: todo horário aqui é horário de CLIQUE (ou da sincronização), não de trabalho físico.
(function (raiz) {
  'use strict';

  const MIN = 60000, HORA = 3600000, DIA = 86400000;
  const CFG_DOC = Object.freeze({ colecao: 'expedicao_config', id: 'medicao' });
  const COL_REGISTROS = 'expedicao_medicao';
  const TIPOS = Object.freeze({ CONFERENCIA: 'CONFERENCIA', OCORRENCIA: 'OCORRENCIA' });
  // Lista curta. As Rules espelham exatamente estes códigos (functions/test/expedicao-medicao-core.test.js confere).
  const MOTIVOS = Object.freeze([
    ['PRODUTO_ERRADO', 'Produto errado'],
    ['QUANTIDADE_ERRADA', 'Quantidade errada'],
    ['ITEM_ESQUECIDO', 'Item esquecido'],
    ['NAO_LOCALIZADO', 'Não achou no local'],
    ['SEM_SALDO_FISICO', 'Sistema tem saldo, prateleira não'],
    ['AVARIA', 'Produto avariado / sem embalagem'],
    ['VENDA_ALTERADA', 'Venda alterada ou cancelada'],
  ].map(([id, rotulo]) => Object.freeze({ id, rotulo })));
  const MOTIVO_IDS = Object.freeze(MOTIVOS.map(m => m.id));
  const COLUNAS_CONFERENCIA = Object.freeze(['pr']);
  const COLUNAS_OCORRENCIA = Object.freeze(['se', 'pr']);
  const LIMITE_SEQUENCIA_MS = 2 * MIN;   // intervalo entre dois cliques do mesmo pedido abaixo disto = clique em sequência
  const LIMITE_LOTE_MS = MIN;            // clique do mesmo operador em OUTRO pedido a menos disto = clique em lote
  const AMOSTRA_MIN = 20;

  const configAtiva = cfg => !!(cfg && cfg.ativa === true);

  function erro(codigo) { const e = new Error(codigo); e.codigo = codigo; return e; }

  /** Monta o registro opcional (conferência ou ocorrência). Não altera o pedido nem a máquina de estados. */
  function planejarRegistro({ pedido, tipo, motivo, retrabalho, uid, config, serverTimestamp }) {
    if (!configAtiva(config)) throw erro('MEDICAO_DESLIGADA');
    if (!pedido || !pedido.numero) throw erro('PEDIDO_NAO_ENCONTRADO');
    if (!uid) throw erro('SEM_USUARIO');
    const versao = Number(pedido.versao) || 0;
    const num = String(pedido.numero);
    const dados = { pedido: num, tipo, versao, em: serverTimestamp(), por: uid };
    if (tipo === TIPOS.CONFERENCIA) {
      if (!COLUNAS_CONFERENCIA.includes(pedido.coluna)) throw erro('ETAPA_INVALIDA');
      return { id: num + '_conf_v' + versao, dados };
    }
    if (tipo === TIPOS.OCORRENCIA) {
      if (!COLUNAS_OCORRENCIA.includes(pedido.coluna)) throw erro('ETAPA_INVALIDA');
      if (!MOTIVO_IDS.includes(motivo)) throw erro('MOTIVO_INVALIDO');
      return { id: num + '_oc_v' + versao + '_' + motivo, dados: { ...dados, motivo, retrabalho: retrabalho === true } };
    }
    throw erro('TIPO_INVALIDO');
  }

  // ── tempo ───────────────────────────────────────────────────────────────────
  /** Aceita ms, Date, Timestamp do Firestore ({toMillis} ou {seconds}) ou string ISO. */
  function emMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (v instanceof Date) return v.getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    const t = Date.parse(v); return Number.isFinite(t) ? t : null;
  }
  const diaFortaleza = ms => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
  const inicioDoDia = dia => Date.parse(dia + 'T00:00:00-03:00');
  const somarDias = (dia, n) => diaFortaleza(inicioDoDia(dia) + n * DIA + 12 * HORA);

  /** Períodos prontos (dias comerciais de Fortaleza). `fimMs` é exclusivo. */
  function periodo(nome, agoraMs) {
    const hoje = diaFortaleza(agoraMs);
    let de, ate;
    if (nome === 'hoje') { de = hoje; ate = hoje; }
    else if (nome === '7d') { de = somarDias(hoje, -6); ate = hoje; }
    else if (nome === '30d') { de = somarDias(hoje, -29); ate = hoje; }
    else if (nome === 'semana-passada') {
      const dow = new Date(hoje + 'T12:00:00Z').getUTCDay();        // 0 = domingo
      const segunda = somarDias(hoje, -((dow + 6) % 7));
      de = somarDias(segunda, -7); ate = somarDias(segunda, -1);
    } else throw erro('PERIODO_INVALIDO');
    return { de, ate, inicioMs: inicioDoDia(de), fimMs: inicioDoDia(somarDias(ate, 1)) };
  }

  // ── estatística ─────────────────────────────────────────────────────────────
  function quantil(ordenados, q) {
    if (!ordenados.length) return null;
    const p = (ordenados.length - 1) * q, i = Math.floor(p), f = p - i;
    return i + 1 < ordenados.length ? ordenados[i] + f * (ordenados[i + 1] - ordenados[i]) : ordenados[i];
  }
  function resumo(intervalos) {
    const v = intervalos.map(x => x.ms).sort((a, b) => a - b), n = v.length;
    const parte = f => (n ? intervalos.filter(f).length / n : null);
    return {
      n, p50: quantil(v, 0.5), p75: quantil(v, 0.75), p90: quantil(v, 0.9),
      emSequencia: parte(x => x.ms < LIMITE_SEQUENCIA_MS),
      viraODia: parte(x => diaFortaleza(x.de) !== diaFortaleza(x.ate)),
    };
  }

  /** Confiabilidade de um intervalo ENTRE CLIQUES. Nunca é "ALTA": clique não é trabalho físico. */
  function confiancaIntervalo(r, lote) {
    if (!r.n) return 'SEM DADO';
    if (r.n < AMOSTRA_MIN) return 'AMOSTRA PEQUENA';
    if (r.emSequencia >= 0.3 || (lote != null && lote >= 0.5)) return 'BAIXA';
    return 'MÉDIA';
  }

  /** uid → O1, O2… (ordem estável pelo identificador interno; o identificador nunca sai daqui). */
  function codigosDeOperador(uids) {
    const m = new Map();
    [...new Set(uids.filter(u => u && u !== 'sistema'))].sort().forEach((u, i) => m.set(u, 'O' + (i + 1)));
    return m;
  }

  // ── ligação com a venda (opcional; só o script semanal usa) ─────────────────
  const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^\d{2,3}[.\d]*\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  /** "AAAA-MM-DD HH:MM:SS" do GestãoClick (hora de Fortaleza) → ms. */
  function cadastroGcMs(s) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s || ''));
    return m ? Date.parse(m[1] + 'T' + m[2] + '-03:00') : null;
  }
  /**
   * Liga pedido ↔ venda por (data, valor em centavos) e desempata por nº de linhas e vendedor. Não existe chave comum
   * (o quadro guarda o código, vendas_gc guarda o id): ligação APROXIMADA; só aceita correspondência única dos dois lados.
   */
  function vincularVendas(pedidos, vendas) {
    const chave = (data, valor) => data + '|' + Math.round(Number(valor) * 100);
    const porChave = new Map();
    for (const v of vendas) { const k = chave(v.data, v.valor); (porChave.get(k) || porChave.set(k, []).get(k)).push(v); }
    const escolhas = new Map(), usos = new Map();
    for (const p of pedidos) {
      let c = porChave.get(chave(p.data, p.valor)) || [];
      if (c.length > 1) { const f = c.filter(v => v.linhas === Number(p.itens)); if (f.length) c = f; }
      if (c.length > 1 && p.vendedor) { const f = c.filter(v => normalizar(v.vendedor) === normalizar(p.vendedor)); if (f.length) c = f; }
      if (c.length === 1 && cadastroGcMs(c[0].cadastradoEm) != null) { escolhas.set(String(p.numero), c[0]); usos.set(c[0].id, (usos.get(c[0].id) || 0) + 1); }
    }
    const vendaMs = new Map();
    for (const [numero, v] of escolhas) if (usos.get(v.id) === 1) vendaMs.set(numero, cadastroGcMs(v.cadastradoEm));
    return { vendaMs, ligados: vendaMs.size, total: pedidos.length };
  }

  // ── cálculo ─────────────────────────────────────────────────────────────────
  /**
   * @param pedidos   documentos de expedicao_pedidos que se movimentaram no período
   * @param eventos   eventos/v{n} desses pedidos (lista plana; v0 é opcional)
   * @param registros documentos de expedicao_medicao desde o início do período
   * @param ativos    pedidos ag/se/pr no momento do cálculo (fotografia de pendentes); null = não calcular
   * @param vendaMs   Map numero → horário de cadastro da venda (opcional)
   * Um intervalo pertence ao período em que TERMINA.
   */
  function calcular({ pedidos, eventos, registros = [], ativos = null, vendaMs = null, inicioMs, fimMs, agoraMs }) {
    const dentro = t => t != null && t >= inicioMs && t < fimMs;
    const porPedido = new Map(pedidos.map(p => [String(p.numero), p]));
    const evs = eventos.map(e => ({ ...e, pedido: String(e.pedido), t: emMs(e.em), versao: Number(e.versao) || 0 }))
      .filter(e => e.t != null && e.versao > 0);
    const regs = registros.map(r => ({ ...r, pedido: String(r.pedido), t: emMs(r.em), versao: Number(r.versao) || 0 })).filter(r => r.t != null);
    const ops = codigosDeOperador([...evs.filter(e => dentro(e.t)), ...regs.filter(r => dentro(r.t))].map(x => x.por));
    const trilha = new Map();
    for (const e of evs) (trilha.get(e.pedido) || trilha.set(e.pedido, []).get(e.pedido)).push(e);
    trilha.forEach(l => l.sort((a, b) => a.versao - b.versao));
    const conf = new Map(regs.filter(r => r.tipo === TIPOS.CONFERENCIA).map(r => [r.pedido + '|' + r.versao, r]));

    const I = { entradaInicio: [], vendaInicio: [], vendaEntrada: [], separacao: [], separadoConferido: [], conferidoDespacho: [], separadoDespacho: [], entradaDespacho: [] };
    const push = (nome, de, ate, op) => { if (de != null && ate != null && ate >= de && dentro(ate)) I[nome].push({ de, ate, ms: ate - de, op }); };
    const separadosNoPeriodo = new Map();   // pedido|versao → evento MARCAR_SEPARADO
    let entradas = 0, entradasFora = 0, semTrilha = 0;
    const diasComEntrada = new Set();

    for (const p of pedidos) {
      const num = String(p.numero), l = trilha.get(num) || [];
      const sync = p.origem === 'sync';
      // pedido reaberto tem ingresadoEm reiniciado: a entrada original é criadoEm (relógio do servidor)
      const entrada = emMs(p.criadoEm) ?? emMs(p.ingresadoEm);
      if (dentro(entrada)) { entradas++; diasComEntrada.add(diaFortaleza(entrada)); if (!sync) entradasFora++; }
      if (!l.length && (p.coluna === 'de' && dentro(emMs(p.saidaEm)))) semTrilha++;
      const venda = vendaMs ? vendaMs.get(num) : null;
      if (venda != null && sync && dentro(entrada) && entrada >= venda - 5 * MIN) I.vendaEntrada.push({ de: venda, ate: entrada, ms: Math.max(0, entrada - venda) });
      let inicioCiclo = entrada, ciclo = 1, ini = null, sep = null;
      for (const e of l) {
        if (e.acao === 'INICIAR_SEPARACAO') {
          push('entradaInicio', inicioCiclo, e.t, e.por);
          if (ciclo === 1 && venda != null) push('vendaInicio', venda, e.t, e.por);
          ini = e;
        } else if (e.acao === 'MARCAR_SEPARADO') {
          if (ini) push('separacao', ini.t, e.t, e.por);
          sep = e;
          if (dentro(e.t)) separadosNoPeriodo.set(num + '|' + e.versao, { ...e, linhas: Number(p.itens) || 0 });
        } else if (e.acao === 'DESPACHAR') {
          if (sep) {
            const c = conf.get(num + '|' + sep.versao);
            push('separadoDespacho', sep.t, e.t, e.por);
            if (c && c.t <= e.t) push('conferidoDespacho', c.t, e.t, e.por);
          }
          push('entradaDespacho', inicioCiclo, e.t, e.por);
        } else if (e.acao === 'REABRIR') { inicioCiclo = e.t; ciclo++; ini = sep = null; }
      }
      for (const e of l) if (e.acao === 'MARCAR_SEPARADO') { const c = conf.get(num + '|' + e.versao); if (c) push('separadoConferido', e.t, c.t, c.por); }
    }

    // cliques em lote: mesmo operador, outro pedido, a menos de LIMITE_LOTE_MS
    const cliques = evs.filter(e => e.por !== 'sistema').sort((a, b) => a.t - b.t);
    const porOp = new Map();
    for (const e of cliques) (porOp.get(e.por) || porOp.set(e.por, []).get(e.por)).push(e);
    const emLote = new Set();
    porOp.forEach(l => {
      for (let i = 0; i < l.length; i++) {
        for (let j = i + 1; j < l.length && l[j].t - l[i].t < LIMITE_LOTE_MS; j++) if (l[j].pedido !== l[i].pedido) { emLote.add(l[i]); emLote.add(l[j]); }
      }
    });
    const fracaoLote = acoes => { const l = cliques.filter(e => dentro(e.t) && acoes.includes(e.acao)); return l.length ? l.filter(e => emLote.has(e)).length / l.length : null; };

    const noPeriodo = cliques.filter(e => dentro(e.t));
    const contar = a => noPeriodo.filter(e => e.acao === a).length;
    const regsP = regs.filter(r => dentro(r.t));
    const confSeparados = [...separadosNoPeriodo.keys()].filter(k => conf.has(k)).length;
    const oc = regsP.filter(r => r.tipo === TIPOS.OCORRENCIA);
    const porMotivo = Object.fromEntries(MOTIVO_IDS.map(m => [m, oc.filter(r => r.motivo === m).length]));
    const cancel = noPeriodo.filter(e => e.acao === 'CANCELAR');

    const operadores = [...ops].map(([uid, codigo]) => {
      const m = noPeriodo.filter(e => e.por === uid), r = regsP.filter(x => x.por === uid);
      const sepOp = [...separadosNoPeriodo.values()].filter(e => e.por === uid);
      return {
        codigo,
        iniciou: m.filter(e => e.acao === 'INICIAR_SEPARACAO').length,
        separou: sepOp.length,
        linhasSeparadas: sepOp.reduce((s, e) => s + e.linhas, 0),
        conferiu: r.filter(x => x.tipo === TIPOS.CONFERENCIA).length,
        despachou: m.filter(e => e.acao === 'DESPACHAR').length,
        cancelou: m.filter(e => e.acao === 'CANCELAR').length,
        ocorrencias: r.filter(x => x.tipo === TIPOS.OCORRENCIA).length,
        diasComClique: new Set([...m, ...r].map(x => diaFortaleza(x.t))).size,
        cliquesEmLote: m.length ? m.filter(e => emLote.has(e)).length / m.length : null,
      };
    }).sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

    let pendentes = null;
    if (ativos) {
      const faixas = () => ({ total: 0, ate2h: 0, de2a24h: 0, de1a3d: 0, mais3d: 0, maisAntigoMs: 0 });
      pendentes = { ag: faixas(), se: faixas(), pr: faixas() };
      for (const p of ativos) {
        const f = pendentes[p.coluna]; if (!f) continue;
        const idade = Math.max(0, agoraMs - (emMs(p.ingresadoEm) ?? agoraMs));
        f.total++; f.maisAntigoMs = Math.max(f.maisAntigoMs, idade);
        f[idade < 2 * HORA ? 'ate2h' : idade < DIA ? 'de2a24h' : idade < 3 * DIA ? 'de1a3d' : 'mais3d']++;
      }
    }

    const loteDe = { entradaInicio: ['INICIAR_SEPARACAO'], vendaInicio: ['INICIAR_SEPARACAO'], separacao: ['INICIAR_SEPARACAO', 'MARCAR_SEPARADO'], separadoConferido: ['MARCAR_SEPARADO'], conferidoDespacho: ['DESPACHAR'], separadoDespacho: ['MARCAR_SEPARADO', 'DESPACHAR'], entradaDespacho: ['DESPACHAR'] };
    const intervalos = {};
    for (const [nome, l] of Object.entries(I)) {
      const r = resumo(l), lote = loteDe[nome] ? fracaoLote(loteDe[nome]) : null;
      intervalos[nome] = { ...r, emLote: lote, confianca: confiancaIntervalo(r, lote) };
    }
    const separados = separadosNoPeriodo.size;
    const diasComClique = new Set(noPeriodo.map(e => diaFortaleza(e.t)));
    return {
      periodo: { de: diaFortaleza(inicioMs), ate: diaFortaleza(fimMs - 1), parcial: fimMs > agoraMs },
      geradoEm: new Date(agoraMs).toISOString(),
      contagens: {
        entradas, entradasForaDoSync: entradasFora, iniciados: contar('INICIAR_SEPARACAO'), separados, despachados: contar('DESPACHAR'),
        cancelados: cancel.length, canceladosAposInicio: cancel.filter(e => e.de !== 'ag').length, reaberturas: contar('REABRIR'),
        despachadosSemTrilha: semTrilha, diasComClique: diasComClique.size,
        diasComEntradaSemClique: [...diasComEntrada].filter(d => !diasComClique.has(d)).length,
      },
      intervalos,
      cliques: { total: noPeriodo.length, emLote: noPeriodo.length ? noPeriodo.filter(e => emLote.has(e)).length / noPeriodo.length : null },
      conferencia: { registradas: regsP.filter(r => r.tipo === TIPOS.CONFERENCIA).length, separadosConferidos: confSeparados, cobertura: separados ? confSeparados / separados : null },
      divergencias: {
        registros: oc.length, pedidos: new Set(oc.map(r => r.pedido)).size, porMotivo,
        comRetrabalho: new Set(oc.filter(r => r.retrabalho === true).map(r => r.pedido + '|' + r.versao)).size,
        taxaSobreSeparados: oc.length && separados ? new Set(oc.map(r => r.pedido)).size / separados : null,
      },
      operadores,
      pendentes,
      pedidosLidos: porPedido.size,
    };
  }

  // ── texto ───────────────────────────────────────────────────────────────────
  function duracao(ms) {
    if (ms == null) return '—';
    if (ms < MIN) return Math.round(ms / 1000) + ' s';
    if (ms < HORA) return (ms / MIN).toFixed(ms < 10 * MIN ? 1 : 0).replace('.', ',') + ' min';
    if (ms < 2 * DIA) return (ms / HORA).toFixed(1).replace('.', ',') + ' h';
    return (ms / DIA).toFixed(1).replace('.', ',') + ' d';
  }
  const pct = f => (f == null ? '—' : Math.round(f * 100) + '%');

  const LINHAS = Object.freeze([
    ['vendaEntrada', 'Venda cadastrada → aparece no quadro', 'sistema (não é clique)'],
    ['vendaInicio', 'Venda cadastrada → "Iniciar"', 'venda ligada por aproximação'],
    ['entradaInicio', 'Entrada no quadro → "Iniciar"', 'espera de calendário (noite e fim de semana contam); a entrada acompanha a venda em cerca de 1 min'],
    ['separacao', '"Iniciar" → "Separado"', 'tempo entre cliques, não trabalho físico'],
    ['separadoConferido', '"Separado" → "Conferido"', 'inclui espera; não é duração da conferência'],
    ['conferidoDespacho', '"Conferido" → "Despachar"', 'tempo entre cliques'],
    ['separadoDespacho', '"Separado" → "Despachar" (liberação)', 'tempo entre cliques'],
    ['entradaDespacho', 'Entrada no quadro → "Despachar"', 'prazo total de calendário'],
  ]);
  function linhasDeTempo(r) {
    return LINHAS.filter(([k]) => r.intervalos[k].n || !/^venda/.test(k)).map(([k, rotulo, obs]) => {
      const x = r.intervalos[k];
      const confianca = k === 'vendaEntrada' ? (x.n < AMOSTRA_MIN ? 'AMOSTRA PEQUENA' : 'MÉDIA') : x.confianca;
      return { chave: k, rotulo, obs, n: x.n, p50: duracao(x.p50), p75: duracao(x.p75), p90: duracao(x.p90), emSequencia: pct(x.emSequencia), viraODia: pct(x.viraODia), confianca };
    });
  }

  function paraMarkdown(r, extra = {}) {
    const c = r.contagens, L = [];
    const tabela = (cab, linhas) => { L.push('| ' + cab.join(' | ') + ' |', '|' + cab.map(() => '---').join('|') + '|', ...linhas.map(l => '| ' + l.join(' | ') + ' |'), ''); };
    L.push(`# Expedição — medição de ${r.periodo.de} a ${r.periodo.ate}`, '',
      `Loja 262759. Gerado em ${r.geradoEm}.${r.periodo.parcial ? ' **Período ainda em andamento (parcial).**' : ''} Todos os horários são de clique ou de sincronização: **não medem trabalho físico**. Não usar para avaliar pessoas.`, '');
    L.push('## Volume (confiabilidade ALTA: fatos gravados pelo sistema)');
    tabela(['Medida', 'Valor'], [['Pedidos que entraram no quadro', c.entradas], ['Cliques "Iniciar"', c.iniciados], ['Pedidos separados', c.separados], ['Pedidos despachados', c.despachados],
      ['Cancelados (após iniciar a separação)', `${c.cancelados} (${c.canceladosAposInicio})`], ['Reaberturas', c.reaberturas], ['Dias com clique', c.diasComClique], ['Dias com pedido novo e nenhum clique no quadro', c.diasComEntradaSemClique]]);
    L.push('## Tempos');
    tabela(['Intervalo', 'n', 'Mediana', '75%', '90%', '< 2 min', 'Vira o dia', 'Confiabilidade', 'Leitura'],
      linhasDeTempo(r).map(x => [x.rotulo, x.n, x.p50, x.p75, x.p90, x.emSequencia, x.viraODia, x.confianca, x.obs]));
    L.push(`Cliques em lote (mesmo operador em outro pedido em menos de 1 min): **${pct(r.cliques.emLote)}** de ${r.cliques.total} cliques.`, '');
    L.push('## Conferência, divergências e retrabalho (só o que foi registrado no botão opcional)');
    const d = r.divergencias;
    tabela(['Medida', 'Valor'], [['Pedidos separados com "Conferido"', `${r.conferencia.separadosConferidos} de ${c.separados} (${pct(r.conferencia.cobertura)})`],
      ['Ocorrências registradas (pedidos)', `${d.registros} (${d.pedidos})`], ['Com retrabalho (separar de novo)', d.comRetrabalho], ['Pedidos com ocorrência ÷ separados', pct(d.taxaSobreSeparados)]]);
    if (d.registros) tabela(['Motivo', 'Registros'], MOTIVOS.filter(m => d.porMotivo[m.id]).map(m => [m.rotulo, d.porMotivo[m.id]]));
    else L.push('Nenhuma ocorrência registrada. Isso **não** significa zero erro: pode ser captura desligada ou não usada.', '');
    if (r.pendentes) {
      L.push('## Pendentes (fotografia no momento da geração)');
      const P = r.pendentes;
      tabela(['Coluna', 'Total', 'até 2 h', '2–24 h', '1–3 d', '> 3 d', 'Mais antigo'], [['ag', 'Aguardando'], ['se', 'Separando'], ['pr', 'Pronto']]
        .map(([k, n]) => [n, P[k].total, P[k].ate2h, P[k].de2a24h, P[k].de1a3d, P[k].mais3d, P[k].total ? duracao(P[k].maisAntigoMs) : '—']));
    }
    L.push('## Cliques por operador (código; não mede esforço)');
    tabela(['Operador', 'Iniciou', 'Separou', 'Linhas separadas', 'Conferiu', 'Despachou', 'Cancelou', 'Ocorrências', 'Dias', 'Em lote'],
      r.operadores.map(o => [o.codigo, o.iniciou, o.separou, o.linhasSeparadas, o.conferiu, o.despachou, o.cancelou, o.ocorrencias, o.diasComClique, pct(o.cliquesEmLote)]));
    L.push('"Linhas" = quantidade de produtos diferentes informada na venda. Quem clica pode não ser quem separou.', '');
    if (extra.notas && extra.notas.length) L.push('## Notas da coleta', ...extra.notas.map(n => '- ' + n), '');
    return L.join('\n');
  }

  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Mesmo conteúdo do texto, em HTML, para o painel dentro da Expedição. */
  function paraHtml(r) {
    const c = r.contagens, d = r.divergencias;
    const tabela = (cab, linhas) => '<div class="med-rolagem"><table class="med-tab"><thead><tr>' + cab.map(x => `<th>${esc(x)}</th>`).join('') + '</tr></thead><tbody>' +
      linhas.map(l => '<tr>' + l.map(x => `<td>${esc(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
    const bloco = (rotulo, v) => `<div class="med-num"><span>${esc(rotulo)}</span><strong>${esc(v)}</strong></div>`;
    let h = `<p class="med-aviso">${esc(r.periodo.de)} a ${esc(r.periodo.ate)}${r.periodo.parcial ? ' (em andamento)' : ''}. Horários de <strong>clique</strong>: não medem trabalho físico e não servem para avaliar pessoas.</p>`;
    h += '<div class="med-nums">' + bloco('Entraram', c.entradas) + bloco('Separados', c.separados) + bloco('Despachados', c.despachados) + bloco('Cancelados', c.cancelados) +
      bloco('Reaberturas', c.reaberturas) + bloco('Cliques em lote', pct(r.cliques.emLote)) + bloco('Dias sem clique, com pedido novo', c.diasComEntradaSemClique) + '</div>';
    h += '<h4>Tempos</h4>' + tabela(['Intervalo', 'n', 'Mediana', '90%', '< 2 min', 'Confiabilidade', 'Leitura'], linhasDeTempo(r).map(x => [x.rotulo, x.n, x.p50, x.p90, x.emSequencia, x.confianca, x.obs]));
    h += '<h4>Conferência, divergências e retrabalho</h4>' + tabela(['Medida', 'Valor'], [
      ['Separados com "Conferido"', `${r.conferencia.separadosConferidos} de ${c.separados} (${pct(r.conferencia.cobertura)})`],
      ['Ocorrências (pedidos)', `${d.registros} (${d.pedidos})`], ['Precisaram separar de novo', d.comRetrabalho],
      ...MOTIVOS.filter(m => d.porMotivo[m.id]).map(m => [m.rotulo, d.porMotivo[m.id]])]);
    if (!d.registros) h += '<p class="med-obs">Sem ocorrências registradas não significa sem erro.</p>';
    if (r.pendentes) h += '<h4>Pendentes agora</h4>' + tabela(['Coluna', 'Total', 'até 2 h', '2–24 h', '1–3 d', '> 3 d', 'Mais antigo'], [['ag', 'Aguardando'], ['se', 'Separando'], ['pr', 'Pronto']]
      .map(([k, n]) => { const P = r.pendentes[k]; return [n, P.total, P.ate2h, P.de2a24h, P.de1a3d, P.mais3d, P.total ? duracao(P.maisAntigoMs) : '—']; }));
    h += '<h4>Cliques por operador</h4>' + tabela(['Operador', 'Iniciou', 'Separou', 'Linhas', 'Conferiu', 'Despachou', 'Ocorr.', 'Dias', 'Em lote'],
      r.operadores.map(o => [o.codigo, o.iniciou, o.separou, o.linhasSeparadas, o.conferiu, o.despachou, o.ocorrencias, o.diasComClique, pct(o.cliquesEmLote)]));
    return h + '<p class="med-obs">Contagem de cliques, não de esforço. Quem clica pode não ser quem separou.</p>';
  }

  const api = Object.freeze({ CFG_DOC, COL_REGISTROS, TIPOS, MOTIVOS, MOTIVO_IDS, COLUNAS_CONFERENCIA, COLUNAS_OCORRENCIA, LIMITE_SEQUENCIA_MS, LIMITE_LOTE_MS, AMOSTRA_MIN,
    configAtiva, planejarRegistro, emMs, diaFortaleza, periodo, quantil, resumo, confiancaIntervalo, codigosDeOperador, cadastroGcMs, vincularVendas, calcular, duracao, pct, linhasDeTempo, paraMarkdown, paraHtml });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.ExpedicaoMedicao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
