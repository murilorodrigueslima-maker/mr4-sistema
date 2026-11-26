// MR4 — Expedição · medição (cálculo puro; usado pela página, pelo script semanal e pelos testes).
// Entrada: pedidos, eventos imutáveis (eventos/v{n}) e, se houver, os registros opcionais (expedicao_medicao).
// Saída: só agregados do PROCESSO. Nada por pessoa: sem ranking, sem nome, e-mail ou uid.
// IMPORTANTE: todo horário de clique é horário de REGISTRO; só vale como horário do trabalho quando o clique foi na hora.
(function (raiz) {
  'use strict';

  const VERSAO = 2;                      // a tela só usa o núcleo desta versão em diante (JavaScript antigo em cache)
  const MIN = 60000, HORA = 3600000, DIA = 86400000;
  const CFG_DOC = Object.freeze({ colecao: 'expedicao_config', id: 'medicao' });
  const COL_REGISTROS = 'expedicao_medicao';
  const TIPOS = Object.freeze({ CONFERENCIA_INICIO: 'CONFERENCIA_INICIO', CONFERENCIA: 'CONFERENCIA', ENTREGA: 'ENTREGA', OCORRENCIA: 'OCORRENCIA', MARCA: 'MARCA' });
  // Lista curta. As Rules espelham exatamente estes códigos (functions/test/expedicao-medicao-core.test.js confere).
  const MOTIVOS = Object.freeze([
    ['PRODUTO_ERRADO', 'Produto errado'],
    ['QUANTIDADE_ERRADA', 'Quantidade errada'],
    ['ITEM_ESQUECIDO', 'Item esquecido'],
    ['NAO_LOCALIZADO', 'Não achou no local'],
    ['SEM_SALDO_FISICO', 'Sistema tem saldo, prateleira não'],
    ['AVARIA', 'Produto avariado / sem embalagem'],
    ['VENDA_ALTERADA', 'Venda alterada ou cancelada'],
    ['NAO_ENTREGUE', 'Não foi entregue / voltou'],
  ].map(([id, rotulo]) => Object.freeze({ id, rotulo })));
  const MOTIVO_IDS = Object.freeze(MOTIVOS.map(m => m.id));
  const COLUNAS_CONFERENCIA = Object.freeze(['pr']);
  const COLUNAS_ENTREGA = Object.freeze(['de']);
  const COLUNAS_OCORRENCIA = Object.freeze(['se', 'pr', 'de']);
  /** Motivos oferecidos em cada coluna (depois da saída não faz sentido "não achou no local"; antes, "não foi entregue"). */
  const motivosDaColuna = coluna => MOTIVOS.filter(m => (coluna === 'de' ? !['NAO_LOCALIZADO', 'SEM_SALDO_FISICO'].includes(m.id) : m.id !== 'NAO_ENTREGUE'));
  // Só estes envios pedem o clique "Entregue". Retirada, retirada por terceiros e Uber do cliente: a entrega é o próprio "Despachar".
  const ENVIOS_COM_ENTREGA = Object.freeze(['uber-mr4', 'rota-manha', 'rota-tarde']);
  const ETAPAS_MARCA = Object.freeze(['INICIAR_SEPARACAO', 'MARCAR_SEPARADO', 'DESPACHAR']);
  const LOTE_MAX = 30;
  const DIAS_ACOMPANHAMENTO = 7;
  const EXPEDIENTE_PADRAO = Object.freeze({ horaInicio: 7, horaFim: 19 });   // segunda a sábado; domingo é sempre fora
  const DEPOIS_DURA_MS = 10 * MIN;       // o modo "registrando depois" desliga sozinho
  const LIMITE_SEQUENCIA_MS = 2 * MIN;   // parcela informativa de intervalos muito curtos
  const LIMITE_LOTE_MS = MIN;            // mesmo clique, mesma conta, em OUTRO pedido a menos disto (sem lote declarado) = sequência
  const AMOSTRA_MIN = 20;
  const AVISO_USO = 'Estes indicadores mostram gargalos do processo. NÃO servem para punição, desconto ou avaliação de funcionários.';

  const configAtiva = cfg => !!(cfg && cfg.ativa === true);

  function erro(codigo) { const e = new Error(codigo); e.codigo = codigo; return e; }

  /** Identificador de um lote (grupo de pedidos tratados juntos). */
  const novoLote = (agoraMs = Date.now(), sorte = Math.random()) => 'L' + agoraMs.toString(36) + '-' + Math.floor(sorte * 1679616).toString(36).padStart(4, '0');

  function anotacoes(dados, { lote, loteTam, depois }) {
    if (lote) {
      if (!/^L[0-9a-z-]{6,40}$/.test(lote) || !Number.isInteger(loteTam) || loteTam < 1 || loteTam > LOTE_MAX) throw erro('LOTE_INVALIDO');
      dados.lote = lote; dados.loteTam = loteTam;
    }
    if (depois === true) dados.depois = true;
    return dados;
  }

  /** Monta o registro opcional (conferência, entrega ou ocorrência). Não altera o pedido nem a máquina de estados. */
  function planejarRegistro({ pedido, tipo, motivo, retrabalho, uid, config, serverTimestamp, lote, loteTam, depois }) {
    if (!configAtiva(config)) throw erro('MEDICAO_DESLIGADA');
    if (!pedido || !pedido.numero) throw erro('PEDIDO_NAO_ENCONTRADO');
    if (!uid) throw erro('SEM_USUARIO');
    const versao = Number(pedido.versao) || 0;
    const num = String(pedido.numero);
    const dados = anotacoes({ pedido: num, tipo, versao, em: serverTimestamp(), por: uid }, { lote, loteTam, depois });
    if (tipo === TIPOS.CONFERENCIA || tipo === TIPOS.CONFERENCIA_INICIO) {
      if (!COLUNAS_CONFERENCIA.includes(pedido.coluna)) throw erro('ETAPA_INVALIDA');
      return { id: num + (tipo === TIPOS.CONFERENCIA ? '_conf_v' : '_confini_v') + versao, dados };
    }
    if (tipo === TIPOS.ENTREGA) {
      if (!COLUNAS_ENTREGA.includes(pedido.coluna) || !ENVIOS_COM_ENTREGA.includes(pedido.envio)) throw erro('ETAPA_INVALIDA');
      return { id: num + '_entrega_v' + versao, dados };
    }
    if (tipo === TIPOS.OCORRENCIA) {
      if (!COLUNAS_OCORRENCIA.includes(pedido.coluna)) throw erro('ETAPA_INVALIDA');
      if (!MOTIVO_IDS.includes(motivo) || (motivo === 'NAO_ENTREGUE' && pedido.coluna !== 'de')) throw erro('MOTIVO_INVALIDO');
      return { id: num + '_oc_v' + versao + '_' + motivo, dados: { ...dados, motivo, retrabalho: retrabalho === true } };
    }
    throw erro('TIPO_INVALIDO');
  }

  /** Anotação de uma transição já gravada: "foi em lote" e/ou "registrado depois". Sem uma das duas, não há o que anotar. */
  function planejarMarca({ pedido, versao, etapa, uid, config, serverTimestamp, lote, loteTam, depois }) {
    if (!configAtiva(config)) throw erro('MEDICAO_DESLIGADA');
    if (!uid) throw erro('SEM_USUARIO');
    if (!ETAPAS_MARCA.includes(etapa) || !(Number(versao) >= 1)) throw erro('ETAPA_INVALIDA');
    if (!lote && depois !== true) throw erro('NADA_A_ANOTAR');
    const num = String(pedido);
    return { id: num + '_marca_v' + versao, dados: anotacoes({ pedido: num, tipo: TIPOS.MARCA, versao: Number(versao), etapa, em: serverTimestamp(), por: uid }, { lote, loteTam, depois }) };
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
  const diaDaSemana = dia => new Date(dia + 'T12:00:00Z').getUTCDay();   // 0 = domingo

  function expediente(cfg) {
    const a = cfg && cfg.horaInicio, b = cfg && cfg.horaFim;
    return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b <= 24 && a < b ? { horaInicio: a, horaFim: b } : { ...EXPEDIENTE_PADRAO };
  }
  function foraDoExpediente(ms, cfg) {
    const e = expediente(cfg), dia = diaFortaleza(ms), h = (ms - inicioDoDia(dia)) / HORA;
    return diaDaSemana(dia) === 0 || h < e.horaInicio || h >= e.horaFim;
  }
  /** Quanto de um intervalo caiu dentro do expediente (segunda a sábado). */
  function msNoExpediente(de, ate, cfg) {
    const e = expediente(cfg); let total = 0;
    for (let dia = diaFortaleza(de), i = 0; i < 120 && inicioDoDia(dia) < ate; dia = somarDias(dia, 1), i++) {
      if (diaDaSemana(dia) === 0) continue;
      total += Math.max(0, Math.min(ate, inicioDoDia(dia) + e.horaFim * HORA) - Math.max(de, inicioDoDia(dia) + e.horaInicio * HORA));
    }
    return total;
  }

  const diaValido = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00-03:00')) && diaFortaleza(inicioDoDia(s) + 12 * HORA) === s;
  const janela = (de, ate) => ({ de, ate, inicioMs: inicioDoDia(de), fimMs: inicioDoDia(somarDias(ate, 1)) });

  /** Situação do acompanhamento de 7 dias corridos a partir da data escolhida pelo gestor. */
  function estadoAcompanhamento(cfg, agoraMs) {
    if (!cfg || !diaValido(cfg.inicio)) return { estado: 'sem-data' };
    const de = cfg.inicio, ate = somarDias(de, DIAS_ACOMPANHAMENTO - 1), hoje = diaFortaleza(agoraMs);
    if (hoje < de) return { estado: 'antes', de, ate };
    if (hoje > ate) return { estado: 'encerrado', de, ate };
    return { estado: 'andamento', de, ate, dia: Math.round((inicioDoDia(hoje) - inicioDoDia(de)) / DIA) + 1 };
  }

  /** Períodos prontos (dias comerciais de Fortaleza). `fimMs` é exclusivo. */
  function periodo(nome, agoraMs, cfg) {
    const hoje = diaFortaleza(agoraMs);
    if (nome === 'acompanhamento') {
      const e = estadoAcompanhamento(cfg, agoraMs);
      if (e.estado === 'sem-data') throw erro('SEM_DATA_INICIO');
      return janela(e.de, e.ate);
    }
    if (nome === 'hoje') return janela(hoje, hoje);
    if (nome === '7d') return janela(somarDias(hoje, -6), hoje);
    if (nome === '30d') return janela(somarDias(hoje, -29), hoje);
    if (nome === 'semana-passada') {
      const segunda = somarDias(hoje, -((diaDaSemana(hoje) + 6) % 7));
      return janela(somarDias(segunda, -7), somarDias(segunda, -1));
    }
    throw erro('PERIODO_INVALIDO');
  }

  // ── estatística ─────────────────────────────────────────────────────────────
  function quantil(ordenados, q) {
    if (!ordenados.length) return null;
    const p = (ordenados.length - 1) * q, i = Math.floor(p), f = p - i;
    return i + 1 < ordenados.length ? ordenados[i] + f * (ordenados[i + 1] - ordenados[i]) : ordenados[i];
  }
  const medidas = l => { const v = l.slice().sort((a, b) => a - b); return { n: v.length, p50: quantil(v, 0.5), p75: quantil(v, 0.75), p90: quantil(v, 0.9) }; };

  /** Tipos de intervalo: "trabalho" não aceita lote nem clique emendado; "entrega" não aceita confirmação em lote. */
  const CLASSES = Object.freeze({ vendaEntrada: 'sistema', vendaInicio: 'espera', entradaInicio: 'espera', separacao: 'trabalho', separadoConfInicio: 'espera', conferencia: 'trabalho', separadoConferido: 'espera', conferidoDespacho: 'espera', separadoDespacho: 'espera', saidaEntrega: 'entrega', entradaDespacho: 'espera' });
  /** Por que um intervalo NÃO serve como tempo do processo (null = serve). */
  function descarte(classe, x) {
    for (const [q, motivo] of [['DEPOIS', 'depois'], ['FORA', 'fora'], ['SEQUENCIA', 'sequencia']]) if (x.qDe === q || x.qAte === q) return motivo;
    if (classe === 'trabalho' && (x.qDe === 'LOTE' || x.qAte === 'LOTE')) return 'lote';
    if (classe === 'entrega' && x.qAte === 'LOTE') return 'lote';
    if (classe === 'trabalho' && x.ms < LIMITE_LOTE_MS) return 'curto';
    return null;
  }
  function resumo(classe, intervalos, cfg) {
    const n = intervalos.length;
    const parte = f => (n ? intervalos.filter(f).length / n : null);
    const descartes = { depois: 0, fora: 0, sequencia: 0, lote: 0, curto: 0 }, bons = [];
    for (const x of intervalos) { const d = descarte(classe, x); if (d) descartes[d]++; else bons.push(x); }
    return {
      ...medidas(intervalos.map(x => x.ms)),
      uteis: { ...medidas(bons.map(x => x.ms)), p50Expediente: quantil(bons.map(x => msNoExpediente(x.de, x.ate, cfg)).sort((a, b) => a - b), 0.5) },
      descartes,
      emSequencia: parte(x => x.ms < LIMITE_SEQUENCIA_MS),
      viraODia: parte(x => diaFortaleza(x.de) !== diaFortaleza(x.ate)),
    };
  }

  /** Confiabilidade de um intervalo ENTRE CLIQUES. Nunca é "ALTA": clique não é trabalho físico. */
  function confiancaIntervalo(r) {
    if (!r.n) return 'SEM DADO';
    if (r.uteis.n < AMOSTRA_MIN) return 'AMOSTRA PEQUENA';
    if (r.uteis.n / r.n < 0.5) return 'BAIXA';
    return 'MÉDIA';
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
  const ROTULOS_Q = Object.freeze({ NA_HORA: 'naHora', LOTE: 'loteDeclarado', SEQUENCIA: 'sequencia', DEPOIS: 'depois', FORA: 'fora' });
  const ETAPAS_GARGALO = Object.freeze({
    entradaInicio: 'Disponível → começar a separar (espera)', separacao: 'Separando', separadoConferido: 'Separado → conferido (espera + conferência)',
    conferidoDespacho: 'Liberado → sair (espera)', separadoDespacho: 'Separado → sair (espera)', saidaEntrega: 'Na rua até entregar',
  });

  /**
   * @param pedidos   documentos de expedicao_pedidos que se movimentaram no período
   * @param eventos   eventos/v{n} desses pedidos (lista plana; v0 é opcional)
   * @param registros documentos de expedicao_medicao desde o início do período
   * @param ativos    pedidos ag/se/pr no momento do cálculo (fotografia de pendentes); null = não calcular
   * @param vendaMs   Map numero → horário de cadastro da venda (opcional; o campo do pedido tem prioridade)
   * @param config    expedicao_config/medicao (expediente)
   * Um intervalo pertence ao período em que TERMINA.
   */
  function calcular({ pedidos, eventos, registros = [], ativos = null, vendaMs = null, config = null, inicioMs, fimMs, agoraMs }) {
    const dentro = t => t != null && t >= inicioMs && t < fimMs;
    const chave = (p, v) => p + '|' + v;
    const porPedido = new Map(pedidos.map(p => [String(p.numero), p]));
    const normal = x => ({ ...x, pedido: String(x.pedido), t: emMs(x.em), versao: Number(x.versao) || 0 });
    const evs = eventos.map(normal).filter(e => e.t != null && e.versao > 0);
    const regsTodos = registros.map(normal).filter(r => r.t != null);
    const marcas = new Map(regsTodos.filter(r => r.tipo === TIPOS.MARCA).map(r => [chave(r.pedido, r.versao), r]));
    const regs = regsTodos.filter(r => r.tipo !== TIPOS.MARCA);
    for (const e of evs) { const m = marcas.get(chave(e.pedido, e.versao)); e.lote = m && m.etapa === e.acao ? m.lote || null : null; e.depois = !!(m && m.etapa === e.acao && m.depois === true); }

    // qualidade de cada registro: depois > fora do expediente > lote declarado > sequência rápida > na hora
    const cliques = [...evs.filter(e => e.por !== 'sistema'), ...regs];
    const grupos = new Map();
    for (const c of cliques) if (!c.lote) { const k = c.por + '|' + (c.acao || c.tipo); (grupos.get(k) || grupos.set(k, []).get(k)).push(c); }
    grupos.forEach(l => {
      l.sort((a, b) => a.t - b.t);
      for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length && l[j].t - l[i].t < LIMITE_LOTE_MS; j++) if (l[j].pedido !== l[i].pedido) l[i].seq = l[j].seq = true;
    });
    for (const c of cliques) c.q = c.depois === true ? 'DEPOIS' : foraDoExpediente(c.t, config) ? 'FORA' : c.lote ? 'LOTE' : c.seq ? 'SEQUENCIA' : 'NA_HORA';

    const trilha = new Map();
    for (const e of evs) (trilha.get(e.pedido) || trilha.set(e.pedido, []).get(e.pedido)).push(e);
    trilha.forEach(l => l.sort((a, b) => a.versao - b.versao));
    const porTipo = tipo => new Map(regs.filter(r => r.tipo === tipo).map(r => [chave(r.pedido, r.versao), r]));
    const confIni = porTipo(TIPOS.CONFERENCIA_INICIO), conf = porTipo(TIPOS.CONFERENCIA), entregas = porTipo(TIPOS.ENTREGA);

    const I = Object.fromEntries(Object.keys(CLASSES).map(k => [k, []]));
    const sistema = t => (t == null ? null : { t, q: 'NA_HORA' });
    const push = (nome, a, b) => { if (a && b && a.t != null && b.t >= a.t && dentro(b.t)) I[nome].push({ de: a.t, ate: b.t, ms: b.t - a.t, qDe: a.q, qAte: b.q, linhas: b.linhas }); };
    const separadosNoPeriodo = new Map();   // pedido|versao → evento MARCAR_SEPARADO
    let entradas = 0, entradasFora = 0, semTrilha = 0;
    const entradasPorDia = new Map();

    for (const p of pedidos) {
      const num = String(p.numero), l = trilha.get(num) || [];
      const sync = p.origem === 'sync';
      const linhas = Number(p.itens) || 0;
      // pedido reaberto tem ingresadoEm reiniciado: a entrada original é criadoEm (relógio do servidor)
      const entrada = emMs(p.criadoEm) ?? emMs(p.ingresadoEm);
      if (dentro(entrada)) { entradas++; entradasPorDia.set(diaFortaleza(entrada), (entradasPorDia.get(diaFortaleza(entrada)) || 0) + 1); if (!sync) entradasFora++; }
      if (!l.length && (p.coluna === 'de' && dentro(emMs(p.saidaEm)))) semTrilha++;
      const venda = emMs(p.vendaCadastradaEm) ?? (vendaMs ? vendaMs.get(num) ?? null : null);
      if (venda != null && sync && entrada != null && entrada >= venda - 5 * MIN) push('vendaEntrada', sistema(Math.min(venda, entrada)), sistema(entrada));
      let inicioCiclo = sistema(entrada), ciclo = 1, ini = null, sep = null;
      for (const e of l) {
        if (e.acao === 'INICIAR_SEPARACAO') {
          push('entradaInicio', inicioCiclo, e);
          if (ciclo === 1 && venda != null) push('vendaInicio', sistema(venda), e);
          ini = e;
        } else if (e.acao === 'MARCAR_SEPARADO') {
          const k = chave(num, e.versao), ci = confIni.get(k), c = conf.get(k);
          if (ini) push('separacao', ini, { t: e.t, q: e.q, linhas });
          sep = e;
          if (dentro(e.t)) separadosNoPeriodo.set(k, e);
          push('separadoConfInicio', e, ci);
          push('conferencia', ci, c);
          push('separadoConferido', e, c);
        } else if (e.acao === 'DESPACHAR') {
          if (sep) { push('separadoDespacho', sep, e); push('conferidoDespacho', conf.get(chave(num, sep.versao)), e); }
          push('entradaDespacho', inicioCiclo, e);
          push('saidaEntrega', e, entregas.get(chave(num, e.versao)));
        } else if (e.acao === 'REABRIR') { inicioCiclo = e; ciclo++; ini = sep = null; }
      }
    }

    const noPeriodo = cliques.filter(c => dentro(c.t));
    const evP = evs.filter(e => e.por !== 'sistema' && dentro(e.t));
    const regsP = regs.filter(r => dentro(r.t));
    const doTipo = t => regsP.filter(r => r.tipo === t);
    const contar = (a, l = evP) => l.filter(e => e.acao === a).length;
    const qualidade = l => { const c = { total: l.length, naHora: 0, loteDeclarado: 0, sequencia: 0, depois: 0, fora: 0 }; for (const x of l) c[ROTULOS_Q[x.q]]++; return c; };

    const intervalos = {};
    for (const [nome, l] of Object.entries(I)) { const r = resumo(CLASSES[nome], l, config); intervalos[nome] = { ...r, confianca: confiancaIntervalo(r) }; }

    // ── lote × individual ──
    const lotesIni = new Map();
    for (const e of evs) if (e.acao === 'INICIAR_SEPARACAO' && e.lote) (lotesIni.get(e.lote) || lotesIni.set(e.lote, []).get(e.lote)).push(e);
    const medidos = [];
    for (const membros of lotesIni.values()) {
      const pares = [];
      let aberto = false;
      for (const ini of membros) {
        const seg = (trilha.get(ini.pedido) || []).find(x => x.versao === ini.versao + 1);
        if (!seg) aberto = true; else if (seg.acao === 'MARCAR_SEPARADO') pares.push([ini, seg]);
      }
      if (aberto || pares.length < 2 || pares.flat().some(x => x.q === 'DEPOIS' || x.q === 'FORA')) continue;
      const fim = Math.max(...pares.map(p => p[1].t)), ms = fim - Math.min(...pares.map(p => p[0].t));
      if (!dentro(fim) || ms < LIMITE_LOTE_MS) continue;
      medidos.push({ pedidos: pares.length, ms, linhas: pares.reduce((s, p) => s + (Number((porPedido.get(p[0].pedido) || {}).itens) || 0), 0) });
    }
    const porMinuto = l => { const ms = l.reduce((s, x) => s + x.ms, 0); return ms ? l.reduce((s, x) => s + (x.linhas || 0), 0) / (ms / MIN) : null; };
    const individuais = I.separacao.filter(x => !descarte('trabalho', x));
    const declarados = kind => { const l = noPeriodo.filter(c => c.lote && (c.acao || c.tipo) === kind); return { lotes: new Set(l.map(c => c.lote)).size, pedidos: l.length }; };
    const lotes = {
      porEtapa: Object.fromEntries([...ETAPAS_MARCA, TIPOS.CONFERENCIA_INICIO, TIPOS.CONFERENCIA, TIPOS.ENTREGA].map(k => [k, declarados(k)])),
      separacao: {
        emLote: { lotes: medidos.length, pedidos: medidos.reduce((s, x) => s + x.pedidos, 0), p50Pedidos: medidas(medidos.map(x => x.pedidos)).p50, p50DuracaoMs: medidas(medidos.map(x => x.ms)).p50, p50MsPorPedido: medidas(medidos.map(x => x.ms / x.pedidos)).p50, linhasPorMinuto: porMinuto(medidos) },
        individual: { pedidos: individuais.length, p50MsPorPedido: medidas(individuais.map(x => x.ms)).p50, linhasPorMinuto: porMinuto(individuais) },
      },
    };

    // ── conferência, entrega, divergências ──
    const separados = separadosNoPeriodo.size;
    const confSeparados = [...separadosNoPeriodo.keys()].filter(k => conf.has(k)).length;
    const saidas = evP.filter(e => e.acao === 'DESPACHAR').map(e => ({ e, envio: (porPedido.get(e.pedido) || {}).envio }));
    const aConfirmar = saidas.filter(s => ENVIOS_COM_ENTREGA.includes(s.envio));
    const noAto = saidas.filter(s => s.envio && !ENVIOS_COM_ENTREGA.includes(s.envio)).length;
    const confirmadas = aConfirmar.filter(s => entregas.has(chave(s.e.pedido, s.e.versao))).length;
    const oc = doTipo(TIPOS.OCORRENCIA);
    const porMotivo = Object.fromEntries(MOTIVO_IDS.map(m => [m, oc.filter(r => r.motivo === m).length]));
    const depoisDaSaida = r => (trilha.get(r.pedido) || []).some(e => e.acao === 'DESPACHAR' && e.versao === r.versao);
    const cancel = evP.filter(e => e.acao === 'CANCELAR');

    // ── dia a dia ──
    const dias = [];
    for (let d = diaFortaleza(inicioMs), i = 0; i < 31 && inicioDoDia(d) < fimMs; d = somarDias(d, 1), i++) {
      const c = noPeriodo.filter(x => diaFortaleza(x.t) === d), n = t => c.filter(x => x.tipo === t).length;
      dias.push({
        dia: d, futuro: inicioDoDia(d) > agoraMs, entradas: entradasPorDia.get(d) || 0,
        iniciados: contar('INICIAR_SEPARACAO', c), separados: contar('MARCAR_SEPARADO', c), conferidos: n(TIPOS.CONFERENCIA), saidas: contar('DESPACHAR', c),
        entregas: n(TIPOS.ENTREGA) + saidas.filter(s => diaFortaleza(s.e.t) === d && s.envio && !ENVIOS_COM_ENTREGA.includes(s.envio)).length,
        divergencias: n(TIPOS.OCORRENCIA), naHora: c.length ? c.filter(x => x.q === 'NA_HORA').length / c.length : null,
      });
    }

    // ── gargalos (do processo) ──
    const cobertura = separados ? confSeparados / separados : null;
    const etapas = ['entradaInicio', 'separacao', ...(cobertura >= 0.5 ? ['separadoConferido', 'conferidoDespacho'] : ['separadoDespacho']), 'saidaEntrega'].map(k => {
      const u = intervalos[k].uteis;
      return { chave: k, rotulo: ETAPAS_GARGALO[k], n: u.n, p50: u.p50, p50Expediente: u.p50Expediente, p90: u.p90, amostraPequena: u.n < AMOSTRA_MIN };
    });
    const comparaveis = etapas.filter(e => e.n >= 5).sort((a, b) => b.p50Expediente - a.p50Expediente || b.p50 - a.p50);

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

    const diasComClique = new Set(evP.map(e => diaFortaleza(e.t)));
    return {
      periodo: { de: diaFortaleza(inicioMs), ate: diaFortaleza(fimMs - 1), parcial: fimMs > agoraMs },
      geradoEm: new Date(agoraMs).toISOString(),
      expediente: expediente(config),
      contagens: {
        entradas, entradasForaDoSync: entradasFora, iniciados: contar('INICIAR_SEPARACAO'), separados, despachados: saidas.length,
        cancelados: cancel.length, canceladosAposInicio: cancel.filter(e => e.de !== 'ag').length, reaberturas: contar('REABRIR'),
        despachadosSemTrilha: semTrilha, diasComClique: diasComClique.size,
        diasComEntradaSemClique: [...entradasPorDia.keys()].filter(d => !diasComClique.has(d)).length,
        contasQueRegistraram: new Set(noPeriodo.map(c => c.por)).size,
      },
      intervalos,
      cliques: qualidade(noPeriodo),
      lotes,
      conferencia: { iniciadas: doTipo(TIPOS.CONFERENCIA_INICIO).length, registradas: doTipo(TIPOS.CONFERENCIA).length, separadosConferidos: confSeparados, cobertura },
      entregas: { noAtoDaSaida: noAto, aConfirmar: aConfirmar.length, confirmadas, cobertura: aConfirmar.length ? confirmadas / aConfirmar.length : null },
      divergencias: {
        registros: oc.length, pedidos: new Set(oc.map(r => r.pedido)).size, porMotivo, depoisDaSaida: oc.filter(depoisDaSaida).length,
        comRetrabalho: new Set(oc.filter(r => r.retrabalho === true).map(r => chave(r.pedido, r.versao))).size,
        taxaSobreSeparados: oc.length && separados ? new Set(oc.map(r => r.pedido)).size / separados : null,
      },
      dias,
      gargalos: { etapas, maior: comparaveis.length ? comparaveis[0].chave : null },
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
  const decimal = v => (v == null ? '—' : v.toFixed(1).replace('.', ','));
  const dataCurta = d => d.slice(8, 10) + '/' + d.slice(5, 7);

  const LINHAS = Object.freeze([
    ['vendaEntrada', 'Venda recebida (cadastro) → disponível no quadro', 'sistema (não é clique)'],
    ['vendaInicio', 'Venda recebida → início da separação', 'só pedidos com horário de venda'],
    ['entradaInicio', 'Disponível → início da separação', 'espera; noite e fim de semana contam no total'],
    ['separacao', 'Início → fim da separação', 'um pedido por vez; lote fica no quadro próprio'],
    ['separadoConfInicio', 'Fim da separação → início da conferência', 'só com "Conferir" clicado'],
    ['conferencia', 'Início → fim da conferência', 'só com "Conferir" e "Conferido"'],
    ['separadoConferido', 'Fim da separação → conferido e liberado', 'inclui espera'],
    ['conferidoDespacho', 'Liberado → saída para entrega', 'espera'],
    ['separadoDespacho', 'Fim da separação → saída (com ou sem conferência)', 'espera'],
    ['saidaEntrega', 'Saída → entrega concluída', 'só Uber MR4 e rotas'],
    ['entradaDespacho', 'Disponível → saída (total)', 'prazo de calendário'],
  ]);
  function linhasDeTempo(r) {
    return LINHAS.filter(([k]) => r.intervalos[k].n || !/^venda/.test(k)).map(([k, rotulo, obs]) => {
      const x = r.intervalos[k], sis = k === 'vendaEntrada';
      return { chave: k, rotulo, obs, n: x.n, uteis: x.uteis.n, p50: duracao(x.uteis.p50), p90: duracao(x.uteis.p90), p50Expediente: duracao(x.uteis.p50Expediente), p50Todos: duracao(x.p50),
        confianca: sis ? (x.n < AMOSTRA_MIN ? 'AMOSTRA PEQUENA' : 'MÉDIA') : x.confianca };
    });
  }

  /** Conteúdo do relatório, comum ao texto (Markdown) e ao painel (HTML). */
  function secoes(r) {
    const c = r.contagens, d = r.divergencias, q = r.cliques, L = r.lotes, S = [];
    const parte = n => (q.total ? `${n} (${pct(n / q.total)})` : String(n));
    S.push({ titulo: 'Onde o processo espera (gargalos)', cab: ['Etapa', 'Pedidos úteis', 'Mediana', 'Mediana dentro do expediente', '90%', 'Leitura'],
      linhas: r.gargalos.etapas.map(e => [e.rotulo, e.n, duracao(e.p50), duracao(e.p50Expediente), duracao(e.p90), e.chave === r.gargalos.maior ? 'MAIOR TEMPO' + (e.amostraPequena ? ' (amostra pequena)' : '') : e.amostraPequena ? 'amostra pequena' : '']),
      nota: 'Compara etapas do processo, usando só registros feitos na hora. Não há comparação entre pessoas.' });
    S.push({ titulo: 'Dia a dia', cab: ['Dia', 'Disponíveis (novos)', 'Início separação', 'Separados', 'Conferidos', 'Saídas', 'Entregas', 'Divergências', 'Registros na hora'],
      linhas: r.dias.map(x => (x.futuro ? [dataCurta(x.dia), '—', '—', '—', '—', '—', '—', '—', '—'] : [dataCurta(x.dia), x.entradas, x.iniciados, x.separados, x.conferidos, x.saidas, x.entregas, x.divergencias, pct(x.naHora)])) });
    S.push({ titulo: 'Volume', cab: ['Medida', 'Valor'], linhas: [['Pedidos que entraram no quadro', c.entradas], ['Inícios de separação', c.iniciados], ['Pedidos separados', c.separados], ['Saídas para entrega', c.despachados],
      ['Cancelados (após iniciar a separação)', `${c.cancelados} (${c.canceladosAposInicio})`], ['Reaberturas', c.reaberturas], ['Dias com clique', c.diasComClique], ['Dias com pedido novo e nenhum clique no quadro', c.diasComEntradaSemClique], ['Contas diferentes que registraram', c.contasQueRegistraram]] });
    S.push({ titulo: 'Tempos', cab: ['Intervalo', 'n', 'n útil', 'Mediana útil', '90% útil', 'Mediana no expediente', 'Mediana de todos', 'Confiabilidade', 'Leitura'],
      linhas: linhasDeTempo(r).map(x => [x.rotulo, x.n, x.uteis, x.p50, x.p90, x.p50Expediente, x.p50Todos, x.confianca, x.obs]),
      nota: '"Útil" = sem registro atrasado, fora do expediente ou emendado em sequência. Nos tempos de trabalho também saem os lotes e os cliques a menos de 1 min.' });
    S.push({ titulo: 'Qualidade dos registros (hora do clique × hora do trabalho)', cab: ['Como foi registrado', 'Registros'], linhas: [['Na hora, um por vez', parte(q.naHora)], ['Em lote declarado', parte(q.loteDeclarado)],
      ['Em sequência rápida sem declarar lote', parte(q.sequencia)], ['Informado como "registrando depois"', parte(q.depois)], [`Fora do expediente (${r.expediente.horaInicio}h–${r.expediente.horaFim}h, seg–sáb)`, parte(q.fora)], ['Total', q.total]] });
    const li = L.separacao.individual, ll = L.separacao.emLote, etapaLote = (rotulo, k) => [rotulo, L.porEtapa[k].lotes, L.porEtapa[k].pedidos];
    S.push({ titulo: 'Separação: individual × em lote', cab: ['Forma', 'Pedidos medidos', 'Lotes', 'Pedidos por lote (mediana)', 'Duração do lote', 'Tempo por pedido', 'Linhas por minuto'],
      linhas: [['Individual', li.pedidos, '—', '—', '—', duracao(li.p50MsPorPedido), decimal(li.linhasPorMinuto)], ['Em lote', ll.pedidos, ll.lotes, ll.p50Pedidos == null ? '—' : decimal(ll.p50Pedidos), duracao(ll.p50DuracaoMs), duracao(ll.p50MsPorPedido), decimal(ll.linhasPorMinuto)]],
      nota: li.pedidos >= AMOSTRA_MIN && ll.lotes >= 5 ? 'Indício, não prova: os pedidos de cada forma são diferentes.' : 'Amostra insuficiente para concluir se o lote compensa (mínimo: 20 pedidos individuais e 5 lotes).' });
    S.push({ titulo: 'Uso de lote por etapa', cab: ['Etapa', 'Lotes', 'Pedidos'], linhas: [etapaLote('Início da separação', 'INICIAR_SEPARACAO'), etapaLote('Fim da separação', 'MARCAR_SEPARADO'), etapaLote('Início da conferência', 'CONFERENCIA_INICIO'), etapaLote('Fim da conferência', 'CONFERENCIA'), etapaLote('Saída', 'DESPACHAR'), etapaLote('Entrega concluída', 'ENTREGA')] });
    S.push({ titulo: 'Conferência, entrega, divergências e retrabalho', cab: ['Medida', 'Valor'], linhas: [
      ['Separados com "Conferido"', `${r.conferencia.separadosConferidos} de ${c.separados} (${pct(r.conferencia.cobertura)})`], ['Entregues no ato da saída (retirada, Uber do cliente)', r.entregas.noAtoDaSaida],
      ['Saídas Uber MR4/rota com "Entregue"', `${r.entregas.confirmadas} de ${r.entregas.aConfirmar} (${pct(r.entregas.cobertura)})`], ['Divergências registradas (pedidos)', `${d.registros} (${d.pedidos})`], ['Depois da saída', d.depoisDaSaida],
      ['Retrabalho: precisou separar de novo', d.comRetrabalho], ['Retrabalho: pedidos reabertos', c.reaberturas], ['Pedidos com divergência ÷ separados', pct(d.taxaSobreSeparados)],
      ...MOTIVOS.filter(m => d.porMotivo[m.id]).map(m => ['Motivo: ' + m.rotulo, d.porMotivo[m.id]])],
      nota: d.registros ? '' : 'Nenhuma divergência registrada NÃO significa zero erro: pode ser captura desligada ou não usada.' });
    if (r.pendentes) S.push({ titulo: 'Pendentes agora', cab: ['Coluna', 'Total', 'até 2 h', '2–24 h', '1–3 d', '> 3 d', 'Mais antigo'], linhas: [['ag', 'Aguardando'], ['se', 'Separando'], ['pr', 'Pronto']]
      .map(([k, n]) => { const P = r.pendentes[k]; return [n, P.total, P.ate2h, P.de2a24h, P.de1a3d, P.mais3d, P.total ? duracao(P.maisAntigoMs) : '—']; }) });
    return S;
  }

  const NOTA_GERAL = 'Os horários são de registro (clique) ou da sincronização; não medem sozinhos o trabalho físico.';

  function paraMarkdown(r, extra = {}) {
    const L = [`# Expedição — medição de ${r.periodo.de} a ${r.periodo.ate}`, '', `**${AVISO_USO}**`, '',
      `Loja 262759. Gerado em ${r.geradoEm}.${r.periodo.parcial ? ' **Período ainda em andamento (parcial).**' : ''} ${NOTA_GERAL}`, ''];
    for (const s of secoes(r)) {
      L.push('## ' + s.titulo, '| ' + s.cab.join(' | ') + ' |', '|' + s.cab.map(() => '---').join('|') + '|', ...s.linhas.map(l => '| ' + l.join(' | ') + ' |'), '');
      if (s.nota) L.push(s.nota, '');
    }
    if (extra.notas && extra.notas.length) L.push('## Notas da coleta', ...extra.notas.map(n => '- ' + n), '');
    return L.join('\n');
  }

  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Mesmo conteúdo do texto, em HTML, para o painel dentro da Expedição. */
  function paraHtml(r) {
    const c = r.contagens, d = r.divergencias, q = r.cliques;
    const bloco = (rotulo, v) => `<div class="med-num"><span>${esc(rotulo)}</span><strong>${esc(v)}</strong></div>`;
    let h = `<p class="med-aviso"><strong>${esc(AVISO_USO)}</strong><br>${esc(r.periodo.de)} a ${esc(r.periodo.ate)}${r.periodo.parcial ? ' (em andamento)' : ''}. ${esc(NOTA_GERAL)}</p>`;
    h += '<div class="med-nums">' + bloco('Entraram', c.entradas) + bloco('Separados', c.separados) + bloco('Saídas', c.despachados) + bloco('Divergências', d.registros) +
      bloco('Registros na hora', pct(q.total ? q.naHora / q.total : null)) + bloco('Dias sem clique, com pedido novo', c.diasComEntradaSemClique) + '</div>';
    for (const s of secoes(r)) {
      h += `<h4>${esc(s.titulo)}</h4><div class="med-rolagem"><table class="med-tab"><thead><tr>` + s.cab.map(x => `<th>${esc(x)}</th>`).join('') + '</tr></thead><tbody>' +
        s.linhas.map(l => '<tr>' + l.map(x => `<td>${esc(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>' + (s.nota ? `<p class="med-obs">${esc(s.nota)}</p>` : '');
    }
    return h;
  }

  const api = Object.freeze({ VERSAO, CFG_DOC, COL_REGISTROS, TIPOS, MOTIVOS, MOTIVO_IDS, motivosDaColuna, COLUNAS_CONFERENCIA, COLUNAS_ENTREGA, COLUNAS_OCORRENCIA, ENVIOS_COM_ENTREGA, ETAPAS_MARCA,
    LOTE_MAX, DIAS_ACOMPANHAMENTO, EXPEDIENTE_PADRAO, DEPOIS_DURA_MS, LIMITE_SEQUENCIA_MS, LIMITE_LOTE_MS, AMOSTRA_MIN, AVISO_USO,
    configAtiva, novoLote, planejarRegistro, planejarMarca, emMs, diaFortaleza, diaValido, expediente, foraDoExpediente, msNoExpediente, estadoAcompanhamento, periodo, quantil, descarte, resumo, confiancaIntervalo,
    cadastroGcMs, vincularVendas, calcular, duracao, pct, linhasDeTempo, secoes, paraMarkdown, paraHtml });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.ExpedicaoMedicao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
