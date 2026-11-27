(function (raiz, fabrica) {
  'use strict';
  const motor = typeof module === 'object' && module.exports ? require('./compras-alocacao14.js') : raiz.Compras14;
  const api = fabrica(motor);
  if (typeof module === 'object' && module.exports) module.exports = api; else raiz.ComprasPlano = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';
  // PLANEJAMENTO DE COMPRA (somente leitura): aplica o cadastro de fornecedores e as confirmações sobre a base, compara as regras
  // 1.2 × 1.3 × 1.4 com o mesmo dinheiro, calcula a fronteira de eficiência e o plano semanal. PURO: sem rede, armazenamento ou
  // sorteio; a data de referência vem dos dados. NÃO cria pedido nem altera nada. Dinheiro em centavos.
  const EPS = 1e-9;
  const Z_MAX = 2;                                   // PREMISSA: o prazo máximo informado fica a cerca de 2 desvios do médio
  const CONFIABILIDADE = { ALTA: 1, MEDIA: 0.8, BAIXA: 0.6 };                      // PREMISSA
  const IMPORTADO = { dias: 60, desvio_dias: 20 };                                 // PREMISSA (a mesma da 1.3)
  const STATUS_FORA_DO_CAMINHO = ['RECEBIDA', 'DUPLICADA', 'CANCELADA'];
  const NAO_CONFIRMADO = {
    PRAZO_ESTIMADO: 'prazo estimado',
    EMBALAGEM_NAO_INFORMADA: 'mínimo/múltiplo não informado',
    PENDENTE_SEM_CONFIRMACAO: 'compra pendente sem confirmação',
    ORIGEM_NAO_COMPROVADA: 'origem da compra não comprovada',
    SEM_FORNECEDOR: 'fornecedor não identificado',
  };

  const objeto = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const positivo = (x, max) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= max ? x : null);
  const inteiro = (x, max = 1000000) => (Number.isInteger(x) && x >= 1 && x <= max ? x : null);

  /** Cadastro do fornecedor com SOMENTE valores válidos; o que vier fora do formato é ignorado (padrão seguro = não informado). */
  function sanearParametros(doc) {
    const d = objeto(doc) ? doc : {}, ignorados = [];
    const pega = (campo, f) => { if (d[campo] === undefined || d[campo] === null || d[campo] === '') return null; const v = f(d[campo]); if (v === null) ignorados.push(campo); return v; };
    const mapa = campo => {
      const out = {};
      if (d[campo] === undefined || d[campo] === null) return out;
      if (!objeto(d[campo])) { ignorados.push(campo); return out; }
      for (const [id, v] of Object.entries(d[campo])) { if (inteiro(v) !== null) out[id] = v; else ignorados.push(campo + '.' + id); }
      return out;
    };
    const fontes = objeto(d.fontes) ? d.fontes : {};
    return {
      prazoMedioDias: pega('prazoMedioDias', v => positivo(v, 365)), prazoMaxDias: pega('prazoMaxDias', v => positivo(v, 730)),
      qtdMinima: pega('qtdMinima', v => inteiro(v)), valorMinimoCents: pega('valorMinimoCents', v => inteiro(v, 1e11)),
      multiploPadrao: pega('multiploPadrao', v => inteiro(v)), multiplosPorProduto: mapa('multiplosPorProduto'), qtdMinimaPorProduto: mapa('qtdMinimaPorProduto'),
      frequenciaReposicaoDias: pega('frequenciaReposicaoDias', v => positivo(v, 365)),
      condicoesPagamento: typeof d.condicoesPagamento === 'string' ? d.condicoesPagamento.slice(0, 200) : null,
      origem: pega('origem', v => (v === 'NACIONAL' || v === 'IMPORTADO' ? v : null)),
      confiabilidadePrazo: pega('confiabilidadePrazo', v => (CONFIABILIDADE[v] !== undefined ? v : null)),
      fontes, ignorados,
    };
  }
  const natureza = (p, campo) => (p.fontes[campo] === 'MANUAL' ? 'INFORMADO' : 'ESTIMADO');

  /** `a caminho` por produto a partir das compras pendentes, considerando a confirmação (status) e a marca de origem. */
  function transitoDasPendencias(pendentes, pendencias, origem) {
    const out = new Map();
    for (const c of pendentes || []) {
      const st = (pendencias[c.id] || {}).status;
      const o = (origem[c.id] || {}).usar_em_decisao_automatica;
      const semOrigem = o === false ? true : o === true ? false : !!c.sem_origem;
      for (const [id, q] of c.itens || []) {
        const x = out.get(id) || out.set(id, { recente: 0, antigo: 0, recente_sem_origem: 0, antigo_sem_origem: 0, sem_confirmacao: 0, fora_por_status: 0 }).get(id);
        if (STATUS_FORA_DO_CAMINHO.includes(st)) { x.fora_por_status += q; continue; }   // nunca soma ao estoque: não presume recebimento
        x[(c.antiga ? 'antigo' : 'recente') + (semOrigem ? '_sem_origem' : '')] += q;
        x.sem_confirmacao += q;
      }
    }
    return out;
  }

  /**
   * Base da geração + cadastros lidos na hora. Ausentes = nada muda (padrão seguro).
   * @param dados { itens, fornecedores, pendentes? }
   * @param cad   { parametros: {fornecedorId: doc}, pendencias: {compraId: doc}, origem: {compraId: doc} }
   */
  function aplicarCadastros(dados, cad = {}) {
    const parametros = cad.parametros || {}, pendencias = cad.pendencias || {}, origem = cad.origem || {};
    const saneados = new Map(Object.entries(parametros).map(([id, d]) => [id, sanearParametros(d)]));
    const transito = Array.isArray(dados.pendentes) ? transitoDasPendencias(dados.pendentes, pendencias, origem) : null;
    const fornecedores = {};
    for (const [id, f] of Object.entries(dados.fornecedores || {})) {
      const p = saneados.get(id);
      fornecedores[id] = p ? { ...f, cadastrado: true, minimo_cents: p.valorMinimoCents ?? f.minimo_cents ?? null, minimo_un: p.qtdMinima ?? f.minimo_un ?? null,
        minimo_natureza: p.valorMinimoCents ? natureza(p, 'valorMinimoCents') : p.qtdMinima ? natureza(p, 'qtdMinima') : null, parametros: p } : { ...f, cadastrado: false };
    }
    const itens = dados.itens.map(item => {
      const x = { ...item }, p = x.fornecedor_id ? saneados.get(x.fornecedor_id) : null;
      const marca = x.ultima_compra_id ? (origem[x.ultima_compra_id] || {}).usar_em_decisao_automatica : undefined;
      if (marca === false) { x.origem_comprovada = false; x.origem_motivo = 'última compra marcada para não decidir sozinha'; }
      else if (marca === true) { x.origem_comprovada = true; x.origem_motivo = null; }
      let semConfirmacao = 0;
      if (transito) {
        const t = transito.get(x.id) || { recente: 0, antigo: 0, recente_sem_origem: 0, antigo_sem_origem: 0, sem_confirmacao: 0, fora_por_status: 0 };
        x.transito = { recente: t.recente, antigo: t.antigo, recente_sem_origem: t.recente_sem_origem, antigo_sem_origem: t.antigo_sem_origem };
        semConfirmacao = t.sem_confirmacao;
        if (t.fora_por_status) x.pendente_fora_por_status = t.fora_por_status;
      }
      if (p) {
        if (p.prazoMedioDias) {
          const L = p.prazoMedioDias, conf = CONFIABILIDADE[p.confiabilidadePrazo] ?? 1;
          const base = p.prazoMaxDias && p.prazoMaxDias >= L ? (p.prazoMaxDias - L) / Z_MAX : L * 0.25;
          x.prazo_dias = L; x.prazo_desvio = Math.sqrt(base ** 2 + (L * (1 - conf)) ** 2);
          x.prazo_fonte = natureza(p, 'prazoMedioDias') === 'INFORMADO' ? 'CADASTRO_INFORMADO' : 'CADASTRO_ESTIMADO';
        } else if (p.origem === 'IMPORTADO') { x.prazo_dias = IMPORTADO.dias; x.prazo_desvio = IMPORTADO.desvio_dias; x.prazo_fonte = 'PREMISSA_IMPORTADO'; }
        if (p.origem === 'IMPORTADO') x.importado = true;
        if (p.frequenciaReposicaoDias) x.revisao_dias = p.frequenciaReposicaoDias;
        const mult = p.multiplosPorProduto[x.id] ?? p.multiploPadrao;
        if (mult) { x.multiplo_un = mult; x.multiplo_cadastrado = true; x.multiplo_natureza = natureza(p, p.multiplosPorProduto[x.id] ? 'multiplosPorProduto' : 'multiploPadrao'); }
        const min = p.qtdMinimaPorProduto[x.id];
        if (min) { x.minimo_un = min; x.minimo_cadastrado = true; }
      }
      const falta = [];
      if (x.prazo_fonte !== 'CADASTRO_INFORMADO' && x.prazo_fonte !== 'CONFIG_PRODUTO' && x.prazo_fonte !== 'CONFIG_FORNECEDOR') falta.push('PRAZO_ESTIMADO');
      const confirmada = x.multiplo_cadastrado ? x.multiplo_natureza === 'INFORMADO' : x.multiplo_un > 1 || x.minimo_un > 1;
      if (!confirmada) falta.push('EMBALAGEM_NAO_INFORMADA');
      if (semConfirmacao > 0) falta.push('PENDENTE_SEM_CONFIRMACAO');
      if (x.origem_comprovada === false) falta.push('ORIGEM_NAO_COMPROVADA');
      if (!x.fornecedor_id) falta.push('SEM_FORNECEDOR');
      x.nao_confirmado = falta;
      return x;
    });
    const ignorados = [...saneados].flatMap(([id, p]) => p.ignorados.map(c => id + ': ' + c));
    return { ...dados, itens, fornecedores, cadastro: { fornecedores_com_cadastro: Object.values(fornecedores).filter(f => f.cadastrado).length, fornecedores: Object.keys(fornecedores).length, campos_ignorados: ignorados } };
  }

  /** Limite desta compra = o menor entre total, semanal e mensal (descontado o já comprometido). Nada informado = sem teto. */
  function limiteDaCompra(o = {}) {
    const lista = [['total', o.total_cents, 0], ['semanal', o.semanal_cents, o.comprometido_semana_cents], ['mensal', o.mensal_cents, o.comprometido_mes_cents]]
      .filter(([, v]) => v !== null && v !== undefined).map(([nome, v, usado]) => [nome, Math.max(0, v - (usado || 0))]);
    if (!lista.length) return { cents: null, limitante: null };
    const [limitante, cents] = lista.reduce((a, b) => (b[1] < a[1] ? b : a));
    return { cents, limitante };
  }

  const prepararTodos = (dados, cfg) => [...dados.itens].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(i => M.preparar(i, cfg));
  /** Universo comum da comparação: os mesmos produtos que podem disputar o dinheiro automaticamente. */
  function liberado(p, cfg, excluidos) {
    const it = p.item;
    return it.estado === 'ELEGIVEL' && M.noFiltro(it, cfg.filtros) && !excluidos.has(p.id) && p.v >= 0 && p.custo > 0 &&
      (cfg.prioritarios.includes(p.id) || ((it.origem_comprovada !== false || cfg.origem === 'INCLUIR') && !it.nao_comprar && p.margem > 0));
  }
  const arredondar = (q, p) => (q > 0 ? Math.ceil(Math.max(q, p.minimo) / p.multiplo - EPS) * p.multiplo : 0);
  /** Corta uma lista já ordenada pelo dinheiro total e pelo teto de cada fornecedor, respeitando mínimo e múltiplo. */
  function cortar(lotes, cfg) {
    let resta = cfg.orcamento_cents === null ? Infinity : cfg.orcamento_cents;
    const gasto = new Map(), qtd = new Map();
    for (const { p, q } of lotes) {
      const teto = p.fornecedor && cfg.orcamento_fornecedor_cents[p.fornecedor] !== undefined ? cfg.orcamento_fornecedor_cents[p.fornecedor] - (gasto.get(p.fornecedor) || 0) : Infinity;
      const disp = Math.min(resta, teto), ja = qtd.get(p.id) || 0;
      let n = q;
      if (n * p.custo > disp) n = Math.floor(Math.floor(disp / p.custo + EPS) / p.multiplo + EPS) * p.multiplo;
      if (ja === 0 && n < p.minimo) n = 0;
      if (n <= 0) continue;
      qtd.set(p.id, ja + n); resta -= n * p.custo;
      if (p.fornecedor) gasto.set(p.fornecedor, (gasto.get(p.fornecedor) || 0) + n * p.custo);
    }
    return qtd;
  }

  /** Regra 1.2 (quantidade calculada no servidor); sem dinheiro para tudo: prioritários, ruptura/curva A, depois menor cobertura. */
  function regra12(prontos, cfg) {
    const excl = new Set(cfg.excluidos), pri = new Set(cfg.prioritarios);
    const lista = [];
    for (const p of prontos) {
      const r = p.item.r12;
      if (!r || !liberado(p, cfg, excl) || !(r.q > 0)) continue;
      const cl = r.abc === 'SEM_VENDA' ? 'C' : r.abc, pos = Math.max(0, p.item.estoque || 0);
      lista.push({ p, q: arredondar(r.q, p), grupo: pri.has(p.id) ? 0 : cl === 'A' ? (pos <= 0 ? 1 : 2) : cl === 'B' && pos <= 0 ? 3 : 4, cobertura: r.v > 0 ? pos / r.v : 1e9 });
    }
    lista.sort((a, b) => a.grupo - b.grupo || a.cobertura - b.cobertura || String(a.p.id).localeCompare(String(b.p.id)));
    return cortar(lista, cfg);
  }

  const PESO_CLASSE_13 = { A: 3, B: 2, C: 1 };        // os mesmos pesos da 1.3
  /** Quantidade da 1.3 na posição atual (a caminho recente, como a 1.3 faz) e distribuição do teto na ordem dela. */
  function regra13(prontos, cfg) {
    const excl = new Set(cfg.excluidos), pri = new Set(cfg.prioritarios), itens = [];
    for (const p of prontos) {
      const r = p.item.r13, t = p.item.transito || {};
      if (!r || !liberado(p, cfg, excl)) continue;
      const pos = Math.max(0, p.item.estoque || 0) + (t.recente || 0) + (t.recente_sem_origem || 0);
      if (!(r.v > 0 && pos < r.rop - EPS)) continue;
      const q = arredondar(Math.ceil(r.alvo - pos - EPS), p);
      if (!(q > 0)) continue;
      const protecao = Math.min(q, arredondar(Math.ceil(r.rop - pos - EPS), p));
      const urgencia = r.rop > 0 ? Math.min(1, Math.max(0, (r.rop - pos) / r.rop)) : 0;
      const nota = Math.max(0, p.preco - p.custo) * r.v / p.custo * (PESO_CLASSE_13[p.classe] || 1) * (0.1 + urgencia);
      itens.push({ p, q, protecao, nota });
    }
    const ordem = { A: 0, B: 1, C: 2 }, lotes = [];
    for (const i of itens) {
      const ruim = !(i.p.margem > 0), base = pri.has(i.p.id) ? -1 : null;
      lotes.push({ p: i.p, q: i.protecao, degrau: base ?? (ruim ? 6 : ordem[i.p.classe]), nota: i.nota });
      if (i.q > i.protecao) lotes.push({ p: i.p, q: i.q - i.protecao, degrau: ruim ? 7 : 3 + ordem[i.p.classe], nota: i.nota });
    }
    lotes.sort((a, b) => a.degrau - b.degrau || b.nota - a.nota || String(a.p.id).localeCompare(String(b.p.id)));
    return cortar(lotes, cfg);
  }

  function abaixoDoMinimo(prontos, qtd, cfg, fornecedores) {
    const total = new Map();
    for (const p of prontos) { const q = qtd.get(p.id) || 0; if (q > 0 && p.fornecedor) { const t = total.get(p.fornecedor) || { cents: 0, un: 0 }; t.cents += q * p.custo; t.un += q; total.set(p.fornecedor, t); } }
    return [...total].filter(([id, t]) => { const m = M.minimoDoFornecedor(id, cfg, fornecedores); return m && (t.cents < m.cents || t.un < m.un); }).map(([id]) => id);
  }

  const REGRAS = [
    { id: 'r12', nome: 'Política 1.2 (vigente)' },
    { id: 'r13', nome: 'Política 1.3 (sombra)' },
    { id: 'r14', nome: 'Política 1.4 (planejamento)' },
  ];
  /** 1.2 × 1.3 × 1.4 com o mesmo dinheiro, os mesmos filtros e a mesma embalagem; indicadores pelo mesmo modelo (o da 1.4). */
  function comparar(dados, extra) {
    const cfg = M.configurar({ ...(extra || {}), ajustes: {} });
    const fornecedores = dados.fornecedores || {}, prontos = prepararTodos(dados, cfg), medidores = new Map();
    const qtds = { r12: regra12(prontos, cfg), r13: regra13(prontos, cfg), r14: M.alocar(prontos, cfg, fornecedores).qtd };
    const semCompra = M.avaliar(prontos, new Map(), cfg, medidores);
    return { rotulo: 'ESTIMATIVA', sem_compra: semCompra, disponivel: prontos.some(p => p.item.r12 || p.item.r13),
      regras: REGRAS.map(r => ({ ...r, qtd: qtds[r.id], totais: M.avaliar(prontos, qtds[r.id], cfg, medidores), fornecedores_abaixo_do_minimo: abaixoDoMinimo(prontos, qtds[r.id], cfg, fornecedores) })) };
  }

  /**
   * Fronteira de eficiência para os filtros escolhidos: de R$ 0 até o capital que leva todos os produtos do escopo ao alvo.
   * Devolve um "calculador" para a tela poder ceder o processador entre os pontos.
   */
  function criarFronteira(dados, extra, { pontos = 20 } = {}) {
    const cfg = M.configurar({ ...(extra || {}), ajustes: {}, orcamento_cents: null });
    const fornecedores = dados.fornecedores || {}, prontos = prepararTodos(dados, cfg), medidores = new Map();
    const necessario = M.alocar(prontos, cfg, fornecedores).usado_cents;
    const orcamentos = necessario > 0 ? [...new Set(Array.from({ length: pontos + 1 }, (_, i) => Math.round(necessario * i / pontos)))] : [0];
    const medir = (qtd) => { const t = M.avaliar(prontos, qtd, cfg, medidores); return { capital_cents: t.capital_cents, atendimento_pct: t.atendimento_pct, atendimento_A_pct: t.atendimento_A_pct, margem_preservada_cents: t.margem_preservada_cents, rupturas_previstas: t.rupturas_previstas }; };
    return {
      capital_necessario_cents: necessario, orcamentos,
      ponto(i) {
        const c = { ...cfg, orcamento_cents: orcamentos[i] };
        // no último ponto a 1.4 compra sem teto (é o capital que define a escala); 1.2 e 1.3 continuam com o mesmo dinheiro
        const c14 = i === orcamentos.length - 1 ? { ...c, orcamento_cents: null } : c;
        return { orcamento_cents: orcamentos[i], r14: medir(M.alocar(prontos, c14, fornecedores).qtd), r13: medir(regra13(prontos, c)), r12: medir(regra12(prontos, c)) };
      },
    };
  }
  /**
   * Ponto de retorno decrescente: primeiro capital a partir do qual TODO trecho seguinte rende menos que `limiar` ponto de
   * atendimento por R$ 10 mil. `noventa` = menor capital que já obtém 90 % de todo o ganho possível (não depende do tamanho do escopo).
   */
  function retornoDecrescente(curva, { limiar = 1 } = {}) {
    const pts = [];
    for (const c of curva) { const x = c.r14 || c; if (x.atendimento_pct === null) continue; const u = pts[pts.length - 1]; if (!u || x.capital_cents > u.capital_cents) pts.push(x); }
    if (pts.length < 2) return { limiar, ponto: null, noventa: null, ganhos: [] };
    const ganhos = pts.slice(1).map((p, i) => ({ de_cents: pts[i].capital_cents, ate_cents: p.capital_cents, pp_por_10mil: (p.atendimento_pct - pts[i].atendimento_pct) / ((p.capital_cents - pts[i].capital_cents) / 1000000) }));
    let ponto = null;
    for (let i = ganhos.length - 1; i >= 0 && ganhos[i].pp_por_10mil < limiar; i--) ponto = pts[i];
    const base = pts[0].atendimento_pct, total = pts[pts.length - 1].atendimento_pct - base;
    const noventa = total > 0 ? pts.find(p => p.atendimento_pct - base >= 0.9 * total - 1e-9) || null : null;
    return { limiar, ponto, noventa, ganhos };
  }

  const somarDias = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  /**
   * Plano de compras semana a semana (ESTIMATIVA pela venda média, sem variação): cada semana compra com o limite que sobra,
   * o que chega entra no estoque e a venda média é descontada. Serve para dimensionar dinheiro por semana e por mês.
   */
  function planoSemanal(dados, extra, { semanas = 8, hoje, total_cents = null, semanal_cents = null, mensal_cents = null, comprometido_semana_cents = 0, comprometido_mes_cents = 0 } = {}) {
    if (semanal_cents === null && mensal_cents === null) return { erro: 'Informe o orçamento semanal ou o mensal para montar o plano.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hoje || '')) return { erro: 'Data de referência ausente.' };
    const cfg = M.configurar({ ...(extra || {}), ajustes: {}, orcamento_cents: null });
    const fornecedores = dados.fornecedores || {};
    const chegaEm = L => Math.max(1, Math.ceil(L / 7 - EPS));
    const estado = prepararTodos(dados, cfg).map(p => {
      const aCaminho = p.transito.recente + p.transito.antigo_considerado;
      return { item: p.item, custo: p.custo, v: p.v, L: p.L, fornecedor: p.fornecedor, estoque: p.estoque, fila: aCaminho > 0 ? [[chegaEm(p.L), aCaminho]] : [] };
    });
    const gastoMes = new Map(), porSemana = [], porProduto = new Map(), porForn = new Map();
    let gastoTotal = 0, demanda = 0, vendida = 0;
    for (let w = 0; w < semanas; w++) {
      const data = somarDias(hoje, 7 * w), mes = data.slice(0, 7);
      if (!gastoMes.has(mes)) gastoMes.set(mes, w === 0 ? comprometido_mes_cents || 0 : 0);
      for (const e of estado) { e.estoque += e.fila.filter(x => x[0] <= w).reduce((s, x) => s + x[1], 0); e.fila = e.fila.filter(x => x[0] > w); }
      const limite = limiteDaCompra({ total_cents: total_cents === null ? null : Math.max(0, total_cents - gastoTotal), semanal_cents, comprometido_semana_cents: w === 0 ? comprometido_semana_cents : 0, mensal_cents, comprometido_mes_cents: gastoMes.get(mes) });
      const prontos = estado.map(e => M.preparar({ ...e.item, estoque: e.estoque, transito: { recente: e.fila.reduce((s, x) => s + x[1], 0) } }, cfg));
      const aloc = M.alocar(prontos, { ...cfg, orcamento_cents: limite.cents }, fornecedores);
      let usado = 0, produtos = 0; const forns = new Set();
      for (const e of estado) {
        const q = aloc.qtd.get(e.item.id) || 0;
        if (q > 0) {
          e.fila.push([w + chegaEm(e.L), q]); usado += q * e.custo; produtos++; forns.add(e.fornecedor || '');
          (porProduto.get(e.item.id) || porProduto.set(e.item.id, Array(semanas).fill(0)).get(e.item.id))[w] = q;
          const f = porForn.get(e.fornecedor || '') || porForn.set(e.fornecedor || '', { fornecedor_id: e.fornecedor, meses: {}, total_cents: 0 }).get(e.fornecedor || '');
          f.meses[mes] = (f.meses[mes] || 0) + q * e.custo; f.total_cents += q * e.custo;
        }
      }
      gastoTotal += usado; gastoMes.set(mes, gastoMes.get(mes) + usado);
      let dSem = 0, vSem = 0, zerados = 0, estoqueCusto = 0;
      for (const e of estado) {
        if (e.item.estado !== 'ELEGIVEL' || !(e.v > 0) || !M.noFiltro(e.item, cfg.filtros)) continue;
        const d = e.v * 7, s = Math.min(e.estoque, d); e.estoque -= s; dSem += d; vSem += s;
        if (e.estoque <= EPS) zerados++;
        estoqueCusto += e.estoque * e.custo;
      }
      demanda += dSem; vendida += vSem;
      porSemana.push({ semana: w + 1, data, mes, limite_cents: limite.cents, limitante: limite.limitante, usado_cents: usado, produtos, fornecedores: forns.size,
        atendimento_pct: dSem > 0 ? 100 * vSem / dSem : null, zerados_no_fim: zerados, estoque_custo_fim_cents: Math.round(estoqueCusto) });
    }
    const meses = [...new Set(porSemana.map(s => s.mes))].map(mes => ({ mes, usado_cents: porSemana.filter(s => s.mes === mes).reduce((t, s) => t + s.usado_cents, 0), semanas: porSemana.filter(s => s.mes === mes).length }));
    return { rotulo: 'ESTIMATIVA', semanas: porSemana, meses, usado_cents: gastoTotal, atendimento_pct: demanda > 0 ? 100 * vendida / demanda : null,
      por_fornecedor: [...porForn.values()].sort((a, b) => b.total_cents - a.total_cents), por_produto: porProduto };
  }

  const AVISO_CSV = 'LISTA DE PLANEJAMENTO — NÃO É PEDIDO DE COMPRA. Estimativas e dados não confirmados indicados por linha.';
  /** CSV da lista de planejamento (nunca é enviada a lugar algum: o arquivo é gerado no navegador). */
  function csvPlanejamento(sim, { comparacao = null, dados = null, data = '', premissas = [] } = {}) {
    const porId = new Map(((dados && dados.itens) || []).map(i => [i.id, i]));
    const forn = (dados && dados.fornecedores) || {};
    const q = (regra, id) => { const r = comparacao && comparacao.regras.find(x => x.id === regra); return r ? r.qtd.get(id) || 0 : ''; };
    const extras = {
      fornecedor: l => (l.fornecedor_id ? (forn[l.fornecedor_id] || {}).nome || 'Fornecedor #' + l.fornecedor_id : 'Sem fornecedor identificado'),
      prazo_dias: l => Math.round(l.prazo_dias), prazo_origem: l => l.prazo_texto, minimo: l => l.minimo, multiplo: l => l.multiplo,
      qtd_regra_1_2: l => q('r12', l.id), qtd_regra_1_3: l => q('r13', l.id),
      pedido_grande_un: l => l.pedido_grande_un || '',
      dados_nao_confirmados: l => (((porId.get(l.id) || {}).nao_confirmado) || []).map(c => NAO_CONFIRMADO[c] || c).join(' | '),
    };
    const limpo = t => String(t).replace(/;/g, ',').replace(/[\r\n]+/g, ' ').replace(/^[=+\-@\t]+/, '');
    const cabecalho = [AVISO_CSV, M.ROTULO, data ? 'Base de dados do dia ' + data : '', ...premissas].filter(Boolean).map(limpo);
    return [...cabecalho, M.csv(sim.linhas.filter(l => l.qtd > 0 || l.ajustado || l.falta_para_o_alvo_cents > 0), { extras })].join('\n');
  }

  return { NAO_CONFIRMADO, AVISO_CSV, REGRAS, sanearParametros, transitoDasPendencias, aplicarCadastros, limiteDaCompra, regra12, regra13, comparar, criarFronteira, retornoDecrescente, planoSemanal, csvPlanejamento };
});
