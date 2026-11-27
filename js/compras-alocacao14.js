(function (raiz, fabrica) {
  'use strict';
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api; else raiz.Compras14 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // AGENTE COMPRAS & ESTOQUE MR4 — Política 1.4 (SOMBRA / SIMULAÇÃO): distribui um orçamento de compra pelo retorno esperado
  // de cada real. PURO: sem I/O, relógio, sorteio ou IA. NÃO cria pedido, não altera sugestão, estoque nem a política vigente.
  // O MESMO arquivo roda nos testes e na geração (servidor) e no navegador (cópia idêntica em js/, conferida por teste).
  // Dinheiro em centavos; quantidades inteiras. Todo parâmetro marcado PREMISSA é uma escolha declarada, não uma medição.
  //
  // Valor esperado da n-ésima unidade de um produto (posição n = estoque + a caminho + compra):
  //   (margem + custo de indisponibilidade) × P(venda no prazo + revisão ≥ n)          → falta que esta compra evita
  // + custo fixo de o produto faltar × redução da chance de ruptura (opcional)
  // + peso de antecipação × margem × [P(venda até o fim da cobertura ≥ n) − anterior]  → venda que ainda poderia esperar
  // − custo de manter a unidade pelo tempo até ela sair
  // O orçamento vai, lote a lote, para o maior valor por real investido (retornos decrescentes por produto).

  const ROTULO = 'PLANEJAMENTO (SIMULAÇÃO) — estimativa; não substitui a política 1.2; nenhum pedido é criado';
  const CLASSES = ['A', 'B', 'C'];
  const PERCENTIS = [80, 90, 95];
  const EPS = 1e-9;
  const SEM_LIMITE = Number.MAX_SAFE_INTEGER;

  function congelar(o) { Object.values(o).forEach(v => { if (v && typeof v === 'object') congelar(v); }); return Object.freeze(o); }

  const PARAMETROS = congelar({
    policy_version: '1.4-SOMBRA',
    status: 'SHADOW_NOT_APPROVED',
    orcamento_cents: null,                                   // null = sem teto
    cobertura_dias: { A: 30, B: 21, C: 15 },                 // mesmo ciclo da 1.3 (PREMISSA); aceita um número único
    nivel_servico: { AX: 0.97, AY: 0.95, AZ: 0.95, BX: 0.95, BY: 0.92, BZ: 0.90, CX: 0.90, CY: 0.85, CZ: 0.80 },   // PREMISSA
    seguranca_teto_dias: { A: 45, B: 30, C: 15 },            // a proteção nunca passa de N dias de venda (como na 1.3)
    revisao_dias: 7,                                         // PREMISSA
    horizonte_dias: 30,                                      // janela dos indicadores: da chegada (prazo) até +30 dias
    gatilho: 'MARGINAL',                                     // 'MARGINAL' = qualquer posição abaixo do alvo (usa melhor o capital); 'PONTO' = só abaixo do ponto de reposição (menos pedidos)
    peso_indisponibilidade: { AX: 1.0, AY: 0.8, AZ: 0.6, BX: 0.6, BY: 0.5, BZ: 0.4, CX: 0.3, CY: 0.2, CZ: 0.1 },   // PREMISSA: custo extra de faltar, em múltiplos da margem
    piso_penalidade_preco: 0.10,                             // PREMISSA: faltar nunca "vale" menos que 10 % do preço (× peso)
    custo_ruptura_cents: 0,                                  // PREMISSA: custo fixo de um produto faltar (além das unidades), × peso da classe
    peso_antecipacao: 0.25,                                  // PREMISSA escolhida no teste histórico da 1ª metade de 2026
    custo_manutencao_anual: 0.30,                            // PREMISSA: capital + armazenagem + obsolescência
    retorno_minimo: 0,                                       // só compra lote com valor esperado por real acima disto
    censura_peso: 0.5,                                       // 0 = venda observada; 1 = correção cautelosa de falta da 1.3; 0,5 escolhido no teste da 1ª metade de 2026
    crescimento: { usar: true, teto: 0.10 },                 // sinal conservador, só na parcela de cobertura
    fator_demanda: 1,                                        // sazonalidade/evento manual: neutro
    excesso_dias: 180,
    usar_multiplo_observado: false,                          // PREMISSA opcional: múltiplo inferido das compras passadas
    transito: { antigos: 'IGNORAR', fracao_parcial: 0.5 },   // pedidos "A receber/Em aberto" com mais de 90 dias: IGNORAR | PARCIAL | TUDO
    origem: 'REVISAR',                                       // compra sem origem comprovada: REVISAR (não decide sozinha) | INCLUIR
    minimo_fornecedor: { modo: 'CADASTRADO', valor_padrao_cents: null, por_fornecedor: {}, cobertura_max_dias: 90 },   // modo: CADASTRADO | NENHUM | HISTORICO_P10
    filtros: { fornecedores: [], categorias: [], marcas: [], curvas: [], xyz: [] },
    orcamento_fornecedor_cents: {},                          // { id: centavos } teto por fornecedor nesta compra
    prazo: { modo: 'DADOS', dias: null, fator: 1, por_fornecedor: {} },   // DADOS = prazo do item; FIXO = `dias` para todos; `por_fornecedor` (tela) prevalece
    embalagem: { minimo_padrao: null, multiplo_padrao: null, por_fornecedor: {}, por_produto: {} },   // tela: produto > fornecedor > cadastro do item > padrão > 1
    // Pedido grande (cliente distribuidor): reserva parte do orçamento para ter, na posição, o tamanho de linha de venda do percentil escolhido.
    // PREMISSA opcional, desligada por padrão: no teste histórico não melhorou o resultado no mesmo capital (ver documento).
    pedido_grande: { usar: false, percentil: 90, teto_dias: 60, fracao_max_orcamento: 0.2, min_linhas: 10, somar_prazo: false },
    prioritarios: [],
    excluidos: [],
    ajustes: {},                                             // { produto: quantidade } — ajuste manual da simulação
  });

  const objeto = x => !!x && typeof x === 'object' && !Array.isArray(x);
  /** Mescla uma configuração sobre os parâmetros e recusa valores fora de faixa. */
  function configurar(extra) {
    const mesclar = (a, b) => {
      if (b === undefined) return a;
      if (!objeto(b) || !objeto(a)) return b;
      const out = { ...a };
      for (const k of Object.keys(b)) out[k] = mesclar(a[k], b[k]);
      return out;
    };
    const c = mesclar(JSON.parse(JSON.stringify(PARAMETROS)), extra || {});
    const erros = validar(c);
    if (erros.length) { const e = new Error('POLITICA_14_INVALIDA: ' + erros.join('; ')); e.codigo = 'POLITICA_14_INVALIDA'; throw e; }
    return c;
  }
  function validar(c) {
    const e = [], num = v => typeof v === 'number' && Number.isFinite(v);
    if (c.status !== 'SHADOW_NOT_APPROVED') e.push('status deve permanecer SHADOW_NOT_APPROVED');
    if (c.orcamento_cents !== null && !(num(c.orcamento_cents) && c.orcamento_cents >= 0)) e.push('orcamento_cents deve ser null ou ≥ 0');
    for (const cl of CLASSES) {
      const d = typeof c.cobertura_dias === 'number' ? c.cobertura_dias : c.cobertura_dias[cl];
      if (!(num(d) && d >= 0 && d <= 365)) e.push('cobertura_dias.' + cl + ' deve estar entre 0 e 365');
      for (const x of ['X', 'Y', 'Z']) {
        const n = typeof c.nivel_servico === 'number' ? c.nivel_servico : c.nivel_servico[cl + x];
        if (!(num(n) && n >= 0.5 && n <= 0.999)) e.push('nivel_servico.' + cl + x + ' deve estar entre 0,5 e 0,999');
        if (!(num(c.peso_indisponibilidade[cl + x]) && c.peso_indisponibilidade[cl + x] >= 0)) e.push('peso_indisponibilidade.' + cl + x + ' deve ser ≥ 0');
      }
    }
    for (const k of ['revisao_dias', 'piso_penalidade_preco', 'custo_ruptura_cents', 'custo_manutencao_anual', 'retorno_minimo']) if (!(num(c[k]) && c[k] >= 0)) e.push(k + ' deve ser ≥ 0');
    if (!(num(c.horizonte_dias) && c.horizonte_dias > 0)) e.push('horizonte_dias deve ser > 0');
    if (!(num(c.peso_antecipacao) && c.peso_antecipacao >= 0 && c.peso_antecipacao <= 1)) e.push('peso_antecipacao deve estar entre 0 e 1');
    if (!(num(c.censura_peso) && c.censura_peso >= 0 && c.censura_peso <= 1)) e.push('censura_peso deve estar entre 0 e 1');
    if (!(num(c.fator_demanda) && c.fator_demanda > 0)) e.push('fator_demanda deve ser > 0');
    if (!['PONTO', 'MARGINAL'].includes(c.gatilho)) e.push('gatilho desconhecido');
    if (!['IGNORAR', 'PARCIAL', 'TUDO'].includes(c.transito.antigos)) e.push('transito.antigos desconhecido');
    if (!(num(c.transito.fracao_parcial) && c.transito.fracao_parcial >= 0 && c.transito.fracao_parcial <= 1)) e.push('transito.fracao_parcial deve estar entre 0 e 1');
    if (!['REVISAR', 'INCLUIR'].includes(c.origem)) e.push('origem desconhecida');
    if (!['CADASTRADO', 'NENHUM', 'HISTORICO_P10'].includes(c.minimo_fornecedor.modo)) e.push('minimo_fornecedor.modo desconhecido');
    for (const [id, q] of Object.entries(c.ajustes)) if (!(Number.isInteger(q) && q >= 0)) e.push('ajuste inválido: ' + id);
    for (const [id, v] of Object.entries(c.orcamento_fornecedor_cents)) if (!(num(v) && v >= 0)) e.push('teto do fornecedor inválido: ' + id);
    if (!['DADOS', 'FIXO'].includes(c.prazo.modo)) e.push('prazo.modo desconhecido');
    if (c.prazo.modo === 'FIXO' && !(num(c.prazo.dias) && c.prazo.dias >= 0 && c.prazo.dias <= 365)) e.push('prazo.dias deve estar entre 0 e 365');
    if (!(num(c.prazo.fator) && c.prazo.fator > 0 && c.prazo.fator <= 10)) e.push('prazo.fator deve estar entre 0 e 10');
    for (const [id, v] of Object.entries(c.prazo.por_fornecedor)) if (!(num(v) && v >= 0 && v <= 365)) e.push('prazo do fornecedor inválido: ' + id);
    const inteiro1 = v => Number.isInteger(v) && v >= 1 && v <= 1000000;
    for (const k of ['minimo_padrao', 'multiplo_padrao']) if (c.embalagem[k] !== null && !inteiro1(c.embalagem[k])) e.push('embalagem.' + k + ' deve ser inteiro ≥ 1');
    for (const g of ['por_fornecedor', 'por_produto']) for (const [id, v] of Object.entries(c.embalagem[g])) for (const k of ['minimo', 'multiplo']) if (v[k] !== undefined && !inteiro1(v[k])) e.push('embalagem inválida: ' + id);
    const pg = c.pedido_grande;
    if (!PERCENTIS.includes(pg.percentil)) e.push('pedido_grande.percentil deve ser 80, 90 ou 95');
    if (!(num(pg.teto_dias) && pg.teto_dias >= 0)) e.push('pedido_grande.teto_dias deve ser ≥ 0');
    if (!(num(pg.fracao_max_orcamento) && pg.fracao_max_orcamento >= 0 && pg.fracao_max_orcamento <= 1)) e.push('pedido_grande.fracao_max_orcamento deve estar entre 0 e 1');
    if (!(num(pg.min_linhas) && pg.min_linhas >= 1)) e.push('pedido_grande.min_linhas deve ser ≥ 1');
    return e;
  }

  // ── Demanda no período: binomial negativa (venda em blocos) ou Poisson quando não há dispersão ──────────────────
  /** tail[k] = P(D ≥ k); prefix[x] = E[min(D, x)] = Σ_{k=1..x} P(D ≥ k). */
  function distribuicao(mu, variancia) {
    if (!(mu > 1e-12)) return { mu: 0, tail: [1, 0], prefix: [0, 0] };
    const v = Math.max(variancia || 0, mu);
    const poisson = v <= mu * (1 + 1e-6);
    const r = poisson ? 0 : mu * mu / (v - mu);
    const q = poisson ? 0 : mu / (r + mu);
    const limite = Math.min(200000, Math.ceil(mu + 40 * Math.sqrt(v) + 60));
    let logp = poisson ? -mu : r * Math.log(r / (r + mu));
    const tail = [1], prefix = [0];
    let acumulado = 0;
    for (let k = 0; k < limite; k++) {
      acumulado += Math.exp(logp);
      const t = Math.max(0, 1 - acumulado);
      tail.push(t); prefix.push(prefix[k] + t);
      if (t < 1e-9 && k >= mu) break;
      logp += poisson ? Math.log(mu / (k + 1)) : Math.log(q * (k + r) / (k + 1));
    }
    return { mu, tail, prefix };
  }
  /** P(D ≥ k) para k inteiro. */
  const probAoMenos = (d, k) => (k <= 0 ? 1 : k < d.tail.length ? d.tail[k] : 0);
  /** E[min(D, x)] (x pode ser fracionário). */
  function esperadoAte(d, x) {
    if (!(x > 0)) return 0;
    const n = Math.floor(x);
    if (n >= d.prefix.length - 1) return d.prefix[d.prefix.length - 1];
    return d.prefix[n] + (x - n) * d.tail[n + 1];
  }
  /** Menor k com P(D ≤ k) ≥ p. */
  function quantil(d, p) {
    let a = 0, b = d.tail.length - 1;
    while (a < b) { const m = (a + b) >> 1; if (probAoMenos(d, m + 1) <= 1 - p + 1e-12) b = m; else a = m + 1; }
    return a;
  }

  const acimaMultiplo = (q, m) => Math.ceil(q / m - EPS) * m;
  const abaixoMultiplo = (q, m) => Math.floor(q / m + EPS) * m;
  const coberturaDe = (classe, cfg) => (typeof cfg.cobertura_dias === 'number' ? cfg.cobertura_dias : cfg.cobertura_dias[classe]);
  const nivelDe = (chave, cfg) => (typeof cfg.nivel_servico === 'number' ? cfg.nivel_servico : cfg.nivel_servico[chave]);

  /** A caminho conforme o cenário: recentes sempre; antigos por cenário; sem origem comprovada só quando o filtro manda incluir. */
  function aCaminho(item, cfg) {
    const t = item.transito || {};
    const inclui = cfg.origem === 'INCLUIR';
    const recente = (t.recente || 0) + (inclui ? t.recente_sem_origem || 0 : 0);
    const antigo = (t.antigo || 0) + (inclui ? t.antigo_sem_origem || 0 : 0);
    const f = cfg.transito.antigos === 'TUDO' ? 1 : cfg.transito.antigos === 'PARCIAL' ? cfg.transito.fracao_parcial : 0;
    return { recente, antigo_considerado: Math.floor(antigo * f + EPS), antigo_total: (t.antigo || 0) + (t.antigo_sem_origem || 0) };
  }

  /** Estado numérico de um produto para uma configuração. */
  function preparar(item, cfg) {
    const classe = CLASSES.includes(item.classe) ? item.classe : 'C';
    const chave = classe + (['X', 'Y', 'Z'].includes(item.xyz) ? item.xyz : 'Z');
    const vObs = item.v_observada === undefined || item.v_observada === null ? item.v || 0 : item.v_observada;
    const base = item.novo ? item.v || 0 : vObs + cfg.censura_peso * ((item.v || 0) - vObs);
    const v = Math.max(0, base) * cfg.fator_demanda;
    const prazo = prazoDe(item, cfg), L = prazo.dias, sL = prazo.desvio;
    const R = item.revisao_dias > 0 ? item.revisao_dias : cfg.revisao_dias;
    const C = coberturaDe(classe, cfg);
    const sd = Math.max(0, item.sd_dia || 0) * cfg.fator_demanda;
    const variancia = (T, comPrazo) => T * sd * sd + (comPrazo ? (v * sL) ** 2 : 0);
    const cresc = cfg.crescimento.usar && item.crescimento_fator > 1 ? Math.min(item.crescimento_fator, 1 + cfg.crescimento.teto) : 1;
    const nivel = nivelDe(chave, cfg);
    const D1 = distribuicao(v * (L + R), variancia(L + R, true));
    let ponto;
    if (!(v > 0)) ponto = 0;
    else if (item.novo) ponto = Math.ceil(v * Math.max(L + R, C) - EPS);            // produto novo: sem proteção estatística (como na 1.3)
    else if (item.esporadico) ponto = Math.ceil(v * (L + R) - EPS);                 // venda esporádica: sem proteção automática
    else ponto = Math.min(quantil(D1, nivel), Math.ceil(v * (L + R + cfg.seguranca_teto_dias[classe]) - EPS));
    const alvo = ponto + Math.ceil(v * cresc * C - EPS);
    const D2 = distribuicao(v * (L + R) + v * cresc * C, variancia(L + R + C, true));
    const tr = aCaminho(item, cfg);
    const estoque = Math.max(0, item.estoque || 0);
    const posicao = Math.floor(estoque + tr.recente + tr.antigo_considerado + EPS);
    const custo = item.custo_cents > 0 ? item.custo_cents : 0;
    const preco = item.preco_cents > 0 ? item.preco_cents : 0;
    const margem = Math.max(0, preco - custo);
    const penalidade = cfg.peso_indisponibilidade[chave] * Math.max(margem, cfg.piso_penalidade_preco * preco);
    const penalidadeEvento = cfg.peso_indisponibilidade[chave] * cfg.custo_ruptura_cents;
    const { multiplo, minimo } = embalagemDe(item, cfg);
    const grande = pedidoGrande(item, cfg, v, L);
    const lote = Math.max(multiplo, acimaMultiplo(Math.max(1, Math.ceil((Math.max(alvo, grande.piso) - posicao) / 60)), multiplo));   // granularidade do cálculo (≤ ~60 lotes por produto)
    return { item, id: item.id, classe, chave, v, v_observada: vObs, L, sL, prazo_fonte: prazo.fonte, R, C, sd, cresc, nivel, D1, D2, ponto, alvo, posicao, estoque, transito: tr,
      custo, preco, margem, penalidade, penalidadeEvento, multiplo, minimo, lote, grande, fornecedor: item.fornecedor_id || null };
  }

  /** Prazo usado: o informado na tela para o fornecedor > prazo fixo da simulação > o do item. Prazo simulado leva 25 % de incerteza (PREMISSA). */
  function prazoDe(item, cfg) {
    const f = item.fornecedor_id ? cfg.prazo.por_fornecedor[item.fornecedor_id] : undefined;
    if (f !== undefined) return { dias: f, desvio: f * 0.25, fonte: 'SIMULADO_FORNECEDOR' };
    if (cfg.prazo.modo === 'FIXO') return { dias: cfg.prazo.dias, desvio: cfg.prazo.dias * 0.25, fonte: 'SIMULADO_GERAL' };
    const dias = Math.max(0, item.prazo_dias || 0), desvio = Math.max(0, item.prazo_desvio || 0), x = cfg.prazo.fator;
    return { dias: dias * x, desvio: desvio * x, fonte: x === 1 ? item.prazo_fonte : 'SIMULADO_FATOR' };
  }

  /** Mínimo e múltiplo: tela (produto > fornecedor) > cadastro do item > múltiplo observado (opção) > padrão da simulação > unidade avulsa. */
  function embalagemDe(item, cfg) {
    const E = cfg.embalagem, p = E.por_produto[item.id] || {}, f = (item.fornecedor_id && E.por_fornecedor[item.fornecedor_id]) || {};
    const observado = cfg.usar_multiplo_observado && item.multiplo_observado > 1 ? item.multiplo_observado : null;
    const multiplo = Math.max(1, p.multiplo ?? f.multiplo ?? (item.multiplo_un > 1 || item.multiplo_cadastrado ? item.multiplo_un : null) ?? observado ?? E.multiplo_padrao ?? 1);
    const minimo = Math.max(1, p.minimo ?? f.minimo ?? (item.minimo_un > 1 || item.minimo_cadastrado ? item.minimo_un : null) ?? E.minimo_padrao ?? 1);
    return { multiplo, minimo: acimaMultiplo(minimo, multiplo) };
  }

  /**
   * Tamanho de pedido grande do produto: percentil do tamanho das linhas de venda dos últimos 12 meses (observado; vendas limitadas por
   * falta de estoque aparecem menores). `piso` = posição mínima buscada pela reserva (0 quando desligada ou sem amostra).
   */
  function pedidoGrande(item, cfg, v, L) {
    const G = cfg.pedido_grande, x = item.linhas_venda;
    const q = x && x.n >= G.min_linhas && x['p' + G.percentil] > 0 ? x['p' + G.percentil] : 0;
    const piso = G.usar && q > 0 && v > 0 ? Math.min(Math.ceil(q), Math.ceil(v * G.teto_dias - EPS)) + (G.somar_prazo ? Math.ceil(v * L - EPS) : 0) : 0;
    return { un: q ? Math.ceil(q) : 0, linhas: q ? x.n : 0, piso };
  }

  const dentro = (lista, v) => !lista || !lista.length || lista.includes(v === null || v === undefined ? '' : v);
  function noFiltro(item, f) {
    return dentro(f.fornecedores, item.fornecedor_id) && dentro(f.categorias, item.categoria) && dentro(f.marcas, item.marca) && dentro(f.curvas, item.classe) && dentro(f.xyz, item.xyz);
  }

  /** Por que o produto pode (null) ou não pode disputar o orçamento automaticamente. Produto prioritário supera revisões, nunca falta de custo/demanda. */
  function impedimento(p, cfg, prioritarios, excluidos) {
    const it = p.item;
    if (it.estado === 'FORA_DA_REPOSICAO') return 'FORA_DA_REPOSICAO';
    if (!noFiltro(it, cfg.filtros)) return 'FORA_DO_FILTRO';
    if (excluidos.has(p.id)) return 'EXCLUIDO_PELO_USUARIO';
    if (!(p.v > 0)) return 'SEM_DEMANDA';
    if (!(p.custo > 0)) return 'SEM_CUSTO';
    if (!prioritarios.has(p.id)) {
      if (it.estado === 'REVISAR_RUPTURA_LONGA') return 'REVISAR_RUPTURA_LONGA';
      if (it.origem_comprovada === false && cfg.origem === 'REVISAR') return 'ORIGEM_NAO_COMPROVADA';
      if (it.nao_comprar) return 'MARCADO_NAO_COMPRAR';
      if (!(p.margem > 0)) return 'MARGEM_NAO_POSITIVA';
      if (cfg.gatilho === 'PONTO' && p.posicao >= p.ponto && !(p.posicao < p.grande.piso)) return 'ACIMA_DO_PONTO';
    }
    if (p.posicao >= Math.max(p.alvo, p.grande.piso)) return 'ESTOQUE_SUFICIENTE';
    return null;
  }

  /** Σ dias até a saída das unidades (de+1 .. de+q), em ritmo médio, limitado a 365 dias por unidade. */
  function somaDias(de, q, v) {
    const ultimoRapido = Math.floor(365 * v + 0.5);
    const a = de + 1, b = Math.min(de + q, ultimoRapido);
    const rapidas = b >= a ? (b - a + 1) * (a + b - 1) / 2 / v : 0;
    return rapidas + 365 * Math.max(0, de + q - Math.max(de, ultimoRapido));
  }
  /** Valor esperado (centavos) das unidades `de+1 .. de+q` na posição do produto. */
  function valorDoLote(p, de, q, cfg) {
    const protegidas = esperadoAte(p.D1, de + q) - esperadoAte(p.D1, de);
    const cobertas = esperadoAte(p.D2, de + q) - esperadoAte(p.D2, de);
    const evento = p.penalidadeEvento * (probAoMenos(p.D1, de + 1) - probAoMenos(p.D1, de + q + 1));   // queda na chance de o produto faltar
    const beneficio = (p.margem + p.penalidade) * protegidas + evento + cfg.peso_antecipacao * p.margem * Math.max(0, cobertas - protegidas);
    return beneficio - p.custo * cfg.custo_manutencao_anual / 365 * somaDias(de, q, p.v);
  }

  // ── Fila de prioridade (maior valor por real primeiro; empate pelo id — resultado independe da ordem de entrada) ──
  function criarFila() {
    const h = [];
    const antes = (a, b) => (a.razao !== b.razao ? a.razao > b.razao : String(a.p.id) < String(b.p.id));
    return {
      get tamanho() { return h.length; },
      itens: h,
      por(x) { h.push(x); let i = h.length - 1; while (i > 0) { const pai = (i - 1) >> 1; if (!antes(h[i], h[pai])) break; [h[i], h[pai]] = [h[pai], h[i]]; i = pai; } },
      tirar() {
        const topo = h[0], fim = h.pop();
        if (h.length) { h[0] = fim; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < h.length && antes(h[a], h[m])) m = a; if (b < h.length && antes(h[b], h[m])) m = b; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } }
        return topo;
      },
    };
  }

  /**
   * Compra lote a lote os candidatos na ordem do valor por real. `estado` é compartilhado entre as fases.
   * opts: { limite(p) nível máximo; minimoRazao (null = aceita qualquer); parar() encerra a fase; razao(p, nivel, n) ordem própria;
   *         teto (centavos que a fase pode gastar); semCorte = a fase não registra o motivo de quem não coube }
   */
  function comprarFase(lista, estado, cfg, opts) {
    const fila = criarFila();
    const razaoDe = opts.razao || ((p, nivel, n) => valorDoLote(p, nivel, n, cfg) / (n * p.custo));
    const tetoForn = p => { const t = p.fornecedor ? cfg.orcamento_fornecedor_cents[p.fornecedor] : undefined; return t === undefined ? SEM_LIMITE : t - (estado.gastoForn.get(p.fornecedor) || 0); };
    let restaFase = opts.teto === undefined ? SEM_LIMITE : opts.teto;
    const proximo = p => {
      const q = estado.qtd.get(p.id) || 0, nivel = p.posicao + q, falta = opts.limite(p) - nivel;
      if (!(falta > 0)) return null;
      let n = Math.min(p.lote, acimaMultiplo(falta, p.multiplo));
      if (q === 0) n = Math.max(n, p.minimo);
      return { p, n, razao: razaoDe(p, nivel, n) };
    };
    for (const p of lista) { const x = proximo(p); if (x) fila.por(x); }
    while (fila.tamanho) {
      if (opts.parar && opts.parar()) break;
      const x = fila.tirar(), p = x.p, q = estado.qtd.get(p.id) || 0;
      if (opts.minimoRazao !== null && !(x.razao > opts.minimoRazao)) {   // o topo é o melhor: nenhum outro lote passa do corte
        for (const y of [x, ...fila.itens]) estado.corte.set(y.p.id, 'RETORNO_INSUFICIENTE');
        break;
      }
      const doForn = tetoForn(p), disponivel = Math.min(estado.resta, doForn, restaFase);
      if (x.n * p.custo > disponivel) {
        const cabe = abaixoMultiplo(Math.floor(disponivel / p.custo + EPS), p.multiplo);
        const precisa = q === 0 ? p.minimo : p.multiplo;
        if (cabe >= precisa && cabe < x.n) fila.por({ p, n: cabe, razao: razaoDe(p, p.posicao + q, cabe) });
        else if (!opts.semCorte) estado.corte.set(p.id, doForn < Math.min(estado.resta, restaFase) ? 'SEM_ORCAMENTO_DO_FORNECEDOR' : 'SEM_ORCAMENTO');
        continue;
      }
      estado.qtd.set(p.id, q + x.n);
      estado.resta -= x.n * p.custo; restaFase -= x.n * p.custo;
      if (p.fornecedor) estado.gastoForn.set(p.fornecedor, (estado.gastoForn.get(p.fornecedor) || 0) + x.n * p.custo);
      // objetivo = valor esperado em centavos (comparável entre fases, mesmo quando a ordem da fase é outra)
      estado.objetivo += (opts.razao ? valorDoLote(p, p.posicao + q, x.n, cfg) : x.razao * x.n * p.custo);
      if (opts.registrar) estado.ultimaRazao = x.razao;
      if (opts.marcar) estado.grande.set(p.id, (estado.grande.get(p.id) || 0) + x.n);
      estado.corte.delete(p.id);
      const y = proximo(p);
      if (y) fila.por(y);
    }
  }

  function minimoDoFornecedor(id, cfg, fornecedores) {
    if (!id || cfg.minimo_fornecedor.modo === 'NENHUM') return null;
    const f = (fornecedores && fornecedores[id]) || {};
    const manual = cfg.minimo_fornecedor.por_fornecedor[id] || {};
    const historico = cfg.minimo_fornecedor.modo === 'HISTORICO_P10' ? f.pedido_p10_cents : null;
    const cents = manual.cents ?? f.minimo_cents ?? historico ?? cfg.minimo_fornecedor.valor_padrao_cents ?? null;
    const un = manual.un ?? f.minimo_un ?? null;
    if (!(cents > 0) && !(un > 0)) return null;
    const fonte = manual.cents !== undefined || manual.un !== undefined ? 'INFORMADO' : f.minimo_cents > 0 || f.minimo_un > 0 ? 'CADASTRADO' : historico > 0 ? 'PREMISSA_HISTORICO' : 'PREMISSA_PADRAO';
    return { cents: cents > 0 ? cents : 0, un: un > 0 ? un : 0, fonte };
  }
  function totalDoFornecedor(prontos, qtd, id) {
    let cents = 0, un = 0;
    for (const p of prontos) if (p.fornecedor === id) { const q = qtd.get(p.id) || 0; cents += q * p.custo; un += q; }
    return { cents, un };
  }
  const atingeMinimo = (t, m) => t.cents >= m.cents && t.un >= m.un;

  /** Uma passada completa: prioritários até o ponto de reposição → fornecedores a completar → reserva para pedido grande → disputa geral. */
  function passada(candidatos, cfg, fornecedores, prioritarios, excluidosForn, completar) {
    const estado = { qtd: new Map(), corte: new Map(), resta: cfg.orcamento_cents === null ? SEM_LIMITE : cfg.orcamento_cents, objetivo: 0, ultimaRazao: null, inviaveis: new Set(), gastoForn: new Map(), grande: new Map() };
    const lista = candidatos.filter(p => !excluidosForn.has(p.fornecedor));
    const pri = lista.filter(p => prioritarios.has(p.id));
    comprarFase(pri, estado, cfg, { limite: p => Math.max(p.ponto, p.posicao + 1), minimoRazao: null });
    for (const id of completar) {
      const m = minimoDoFornecedor(id, cfg, fornecedores);
      const doForn = lista.filter(p => p.fornecedor === id);
      const pronto = () => atingeMinimo(totalDoFornecedor(doForn, estado.qtd, id), m);
      comprarFase(doForn, estado, cfg, { limite: p => p.alvo, minimoRazao: null, parar: pronto });
      // se o alvo não basta, completa com folga limitada a N dias de venda (aparece como risco de excesso)
      if (!pronto()) comprarFase(doForn, estado, cfg, { limite: p => Math.max(p.alvo, Math.ceil(p.v * cfg.minimo_fornecedor.cobertura_max_dias)), minimoRazao: null, parar: pronto });
      if (!pronto()) estado.inviaveis.add(id);
    }
    if (cfg.pedido_grande.usar) comprarFase(lista.filter(p => p.grande.piso > 0), estado, cfg, { limite: p => p.grande.piso, minimoRazao: null, marcar: true, semCorte: true,
      teto: cfg.orcamento_cents === null ? undefined : Math.floor(cfg.orcamento_cents * cfg.pedido_grande.fracao_max_orcamento),
      // ordem: margem esperada das linhas grandes por real investido (mais frequentes e mais baratas primeiro)
      razao: p => p.grande.linhas * p.margem / p.custo });
    comprarFase(lista, estado, cfg, { limite: p => p.alvo, minimoRazao: cfg.retorno_minimo, registrar: true });
    return estado;
  }

  /** Alocação com pedido mínimo por fornecedor: para cada fornecedor abaixo do mínimo, compara completar × deixar de fora. */
  function alocar(prontos, cfg, fornecedores) {
    const prioritarios = new Set(cfg.prioritarios), excluidos = new Set(cfg.excluidos);
    const motivos = new Map(), candidatos = [];
    for (const p of prontos) { const m = impedimento(p, cfg, prioritarios, excluidos); if (m) motivos.set(p.id, m); else candidatos.push(p); }
    const fora = new Set(), completar = [], decisoes = {};
    let estado = passada(candidatos, cfg, fornecedores, prioritarios, fora, completar);
    const ids = [...new Set(candidatos.map(p => p.fornecedor).filter(Boolean))];
    for (let i = 0; i <= ids.length; i++) {
      const abaixo = ids.map(id => ({ id, m: minimoDoFornecedor(id, cfg, fornecedores) })).filter(x => x.m && !fora.has(x.id) && !completar.includes(x.id))
        .map(x => ({ ...x, t: totalDoFornecedor(candidatos, estado.qtd, x.id) })).filter(x => x.t.un > 0 && !atingeMinimo(x.t, x.m))
        .map(x => ({ ...x, fracao: Math.min(x.m.cents ? x.t.cents / x.m.cents : 1, x.m.un ? x.t.un / x.m.un : 1) }))
        .sort((a, b) => a.fracao - b.fracao || String(a.id).localeCompare(String(b.id)));
      if (!abaixo.length) break;
      const { id } = abaixo[0];
      const sem = passada(candidatos, cfg, fornecedores, prioritarios, new Set([...fora, id]), completar);
      const com = passada(candidatos, cfg, fornecedores, prioritarios, fora, [...completar, id]);
      const viavel = !com.inviaveis.size && [...completar, id].every(f => atingeMinimo(totalDoFornecedor(candidatos, com.qtd, f), minimoDoFornecedor(f, cfg, fornecedores)));
      if (viavel && com.objetivo > sem.objetivo) { completar.push(id); decisoes[id] = 'COMPLETADO_ATE_O_MINIMO'; estado = com; }
      else { fora.add(id); decisoes[id] = 'FORA_POR_NAO_ATINGIR_O_MINIMO'; estado = sem; }
    }
    for (const p of candidatos) {
      const q = estado.qtd.get(p.id) || 0;
      if (fora.has(p.fornecedor)) motivos.set(p.id, 'FORNECEDOR_ABAIXO_DO_MINIMO');
      else if (q === 0) motivos.set(p.id, estado.corte.get(p.id) || (p.posicao >= p.alvo ? 'ESTOQUE_SUFICIENTE' : 'SEM_ORCAMENTO'));
      else if (estado.corte.get(p.id) === 'SEM_ORCAMENTO_DO_FORNECEDOR') motivos.set(p.id, 'PARCIAL_POR_TETO_DO_FORNECEDOR');
      else if (estado.corte.get(p.id) === 'SEM_ORCAMENTO' || (p.posicao + q < p.alvo && estado.corte.get(p.id) !== 'RETORNO_INSUFICIENTE')) motivos.set(p.id, 'PARCIAL_POR_ORCAMENTO');
      else motivos.set(p.id, 'CONTEMPLADO');
    }
    return { qtd: estado.qtd, grande: estado.grande, motivos, decisoes, usado_cents: candidatos.reduce((s, p) => s + (estado.qtd.get(p.id) || 0) * p.custo, 0), retorno_marginal: estado.ultimaRazao, objetivo_cents: estado.objetivo };
  }

  // ── Indicadores (ESTIMATIVA pelo modelo de demanda; janela: prazo de entrega + horizonte) ───────────────────────
  // "Falta" = alguma venda não atendida nos dias do horizonte DEPOIS da chegada: é o trecho que esta compra pode mudar.
  // A falta antes da chegada é informada à parte (nenhuma compra de hoje a evita).
  const PONTOS = 40;
  function medidor(p, cfg) {
    const H = cfg.horizonte_dias, variancia = (T, comPrazo) => T * p.sd * p.sd + (comPrazo ? (p.v * p.sL) ** 2 : 0);
    const antes = distribuicao(p.v * p.L, variancia(p.L, true)), depois = distribuicao(p.v * H, variancia(H, false));
    const d90 = distribuicao(p.v * 90, variancia(90, false));
    const amostras = Array.from({ length: PONTOS }, (_, i) => quantil(antes, (i + 0.5) / PONTOS));
    const ateChegada = esperadoAte(antes, p.posicao);
    // vendas atendidas: até a chegada só com a posição atual; depois, com a sobra mais a compra
    const atendida = q => ateChegada + amostras.reduce((s, d) => s + esperadoAte(depois, Math.max(0, p.posicao - d) + q), 0) / PONTOS;
    // chance de a sobra da chegada mais a compra não cobrirem a procura do horizonte
    const falta = q => amostras.reduce((s, d) => s + probAoMenos(depois, Math.floor(Math.max(0, p.posicao - d) + q) + 1), 0) / PONTOS;
    // chance de, na chegada, a sobra mais a compra cobrirem de uma vez uma linha do tamanho grande observado
    const grande = q => (p.grande.un ? amostras.filter(d => Math.max(0, p.posicao - d) + q >= p.grande.un - EPS).length / PONTOS : null);
    const base = atendida(0), faltaBase = p.v > 0 ? falta(0) : 0, faltaAntes = probAoMenos(antes, p.posicao + 1);
    return q => {
      const x = p.posicao + q, servida = q > 0 ? atendida(q) : base;
      const sobra = n => n - esperadoAte(d90, n);
      return { demanda: antes.mu + depois.mu, atendida: servida, atendida_sem_compra: base, p_falta: q > 0 && p.v > 0 ? falta(q) : faltaBase, p_falta_sem_compra: faltaBase, p_falta_antes_da_chegada: faltaAntes,
        margem_preservada_cents: p.margem * Math.max(0, servida - base), recuperado_cmv_cents: p.custo * Math.max(0, servida - base),
        p_pedido_grande: grande(q), p_pedido_grande_sem_compra: grande(0),
        cobertura_antes: p.v > 0 ? p.posicao / p.v : null, cobertura_depois: p.v > 0 ? x / p.v : null,
        excesso_90d_cents: q > 0 ? p.custo * Math.max(0, sobra(x) - sobra(p.posicao)) : 0,
        acima_excesso_cents: p.v > 0 ? p.custo * Math.max(0, Math.min(q, x - p.v * cfg.excesso_dias)) : p.custo * q };
    };
  }
  const noEscopo = (p, cfg) => p.item.estado === 'ELEGIVEL' && p.v > 0 && noFiltro(p.item, cfg.filtros);

  /** Indicadores agregados para QUALQUER lista de quantidades (usado pela 1.4, pelos ajustes manuais e para avaliar outras regras). */
  function avaliar(prontos, qtd, cfg, medidores) {
    const t = { demanda: 0, atendida: 0, atendidaSem: 0, demandaA: 0, atendidaA: 0, atendidaSemA: 0, rupturas: 0, rupturasSem: 0, nA: 0, dispA: 0, dispSemA: 0, margem: 0, recuperado: 0, excesso90: 0, acima: 0, estoqueCusto: 0, compra: 0, cmvDia: 0, capital: 0, unidades: 0, produtos: 0, escopo: 0, pgPeso: 0, pg: 0, pgSem: 0 };
    const forn = new Set();
    for (const p of prontos) {
      const q = qtd.get(p.id) || 0;
      if (q > 0) { t.capital += q * p.custo; t.unidades += q; t.produtos++; forn.add(p.fornecedor || 'SEM_FORNECEDOR'); }
      if (!noEscopo(p, cfg)) continue;
      let m = medidores && medidores.get(p.id);
      if (!m) { m = medidor(p, cfg); if (medidores) medidores.set(p.id, m); }
      const x = m(q);
      t.escopo++; t.demanda += x.demanda; t.atendida += x.atendida; t.atendidaSem += x.atendida_sem_compra; t.rupturas += x.p_falta; t.rupturasSem += x.p_falta_sem_compra;
      if (p.classe === 'A') { t.demandaA += x.demanda; t.atendidaA += x.atendida; t.atendidaSemA += x.atendida_sem_compra; t.nA++; t.dispA += 1 - x.p_falta; t.dispSemA += 1 - x.p_falta_sem_compra; }
      if (x.p_pedido_grande !== null) { t.pgPeso += p.grande.linhas; t.pg += p.grande.linhas * x.p_pedido_grande; t.pgSem += p.grande.linhas * x.p_pedido_grande_sem_compra; }
      t.margem += x.margem_preservada_cents; t.recuperado += x.recuperado_cmv_cents; t.excesso90 += x.excesso_90d_cents; t.acima += x.acima_excesso_cents;
      t.estoqueCusto += p.posicao * p.custo; t.compra += q * p.custo; t.cmvDia += p.v * p.custo;
    }
    const pct = (a, b) => (b > 0 ? 100 * a / b : null);
    return {
      rotulo: 'ESTIMATIVA', produtos_no_escopo: t.escopo, produtos_A_no_escopo: t.nA,
      capital_cents: Math.round(t.capital), unidades: t.unidades, produtos_contemplados: t.produtos, pedidos_fornecedores: forn.size,
      atendimento_pct: pct(t.atendida, t.demanda), atendimento_sem_compra_pct: pct(t.atendidaSem, t.demanda),
      atendimento_A_pct: pct(t.atendidaA, t.demandaA), atendimento_A_sem_compra_pct: pct(t.atendidaSemA, t.demandaA),
      rupturas_previstas: t.rupturas, rupturas_sem_compra: t.rupturasSem,
      disponibilidade_A_pct: pct(t.dispA, t.nA), disponibilidade_A_sem_compra_pct: pct(t.dispSemA, t.nA),
      margem_preservada_cents: Math.round(t.margem),
      pedido_grande_pct: pct(t.pg, t.pgPeso), pedido_grande_sem_compra_pct: pct(t.pgSem, t.pgPeso),
      cobertura_antes_dias: t.cmvDia > 0 ? t.estoqueCusto / t.cmvDia : null, cobertura_depois_dias: t.cmvDia > 0 ? (t.estoqueCusto + t.compra) / t.cmvDia : null,
      excesso_90d_cents: Math.round(t.excesso90), acima_do_excesso_cents: Math.round(t.acima),
      capital_giro_liquido_cents: Math.round(t.capital - t.recuperado),
    };
  }

  // ── Justificativa em linguagem de negócio ─────────────────────────────────────────────────────────────────────
  const num = (x, casas = 1) => Number(x).toLocaleString('pt-BR', { maximumFractionDigits: casas });
  const reais = c => 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MOTIVOS = {
    CONTEMPLADO: 'Contemplado', PARCIAL_POR_ORCAMENTO: 'Parcial: orçamento acabou', SEM_ORCAMENTO: 'Não contemplado: falta de orçamento',
    PARCIAL_POR_TETO_DO_FORNECEDOR: 'Parcial: teto do fornecedor', SEM_ORCAMENTO_DO_FORNECEDOR: 'Não contemplado: teto do fornecedor',
    RETORNO_INSUFICIENTE: 'Não compensa: retorno esperado abaixo do corte', FORNECEDOR_ABAIXO_DO_MINIMO: 'Fornecedor não atinge o pedido mínimo',
    ACIMA_DO_PONTO: 'Estoque ainda acima do ponto de reposição', ESTOQUE_SUFICIENTE: 'Estoque suficiente', REVISAR_RUPTURA_LONGA: 'Revisão manual: falta longa sem venda recente',
    ORIGEM_NAO_COMPROVADA: 'Revisão manual: compra sem origem comprovada', MARGEM_NAO_POSITIVA: 'Revisão manual: preço realizado não supera o custo',
    MARCADO_NAO_COMPRAR: 'Marcado para não comprar', SEM_DEMANDA: 'Sem demanda prevista', SEM_CUSTO: 'Sem custo cadastrado', EXCLUIDO_PELO_USUARIO: 'Excluído pelo usuário', FORA_DO_FILTRO: 'Fora do filtro', FORA_DA_REPOSICAO: 'Fora da reposição (regra vigente)',
  };
  const PRAZOS = { CONFIG_PRODUTO: 'cadastrado', CONFIG_FORNECEDOR: 'cadastrado no fornecedor', PROXY_FORNECEDOR: 'aproximado pelo histórico do fornecedor', PROXY_GERAL: 'aproximado pelo histórico geral', PREMISSA_SEM_DADO: 'premissa', PREMISSA_IMPORTADO: 'premissa de importado', CADASTRO_INFORMADO: 'informado no cadastro do fornecedor', CADASTRO_ESTIMADO: 'cadastro do fornecedor, valor estimado', SIMULADO_FORNECEDOR: 'definido nesta simulação para o fornecedor', SIMULADO_GERAL: 'definido nesta simulação', SIMULADO_FATOR: 'ajustado por fator nesta simulação' };
  const SEM_ORCAMENTO_ALGUM = ['SEM_ORCAMENTO', 'PARCIAL_POR_ORCAMENTO', 'SEM_ORCAMENTO_DO_FORNECEDOR', 'PARCIAL_POR_TETO_DO_FORNECEDOR'];
  function justificar(p, q, motivo, m, cfg, decisaoForn, unGrande = 0) {
    const it = p.item, L = [];
    L.push(`Classe ${p.classe}${p.chave[1]} · venda prevista ${num(p.v, 2)}/dia${p.v > p.v_observada + 1e-9 ? ` (observada ${num(p.v_observada, 2)}; corrigida por falta de estoque, estimativa)` : ''}${p.cresc > 1 ? ` · sinal de crescimento +${num((p.cresc - 1) * 100, 0)}% na cobertura` : ''}.`);
    L.push(`Prazo ${num(p.L, 0)} dias (${PRAZOS[p.prazo_fonte] || 'não informado'}) + ${num(p.R, 0)} de revisão; cobertura ${num(p.C, 0)} dias.`);
    L.push(`Posição ${num(p.posicao, 0)} un (estoque ${num(p.estoque, 0)} + a caminho ${num(p.transito.recente, 0)}${p.transito.antigo_total ? ` + pedido antigo considerado ${num(p.transito.antigo_considerado, 0)} de ${num(p.transito.antigo_total, 0)}` : ''}) · ponto de reposição ${num(p.ponto, 0)} (${num(p.nivel * 100, 0)}% de nível de serviço) · alvo ${num(p.alvo, 0)}.`);
    if (m) L.push(`Chance de faltar nos ${num(cfg.horizonte_dias, 0)} dias após a chegada: ${num(m.p_falta_sem_compra * 100, 0)}% sem compra → ${num(m.p_falta * 100, 0)}% com ${num(q, 0)} un. Antes da chegada (não evitável por esta compra): ${num(m.p_falta_antes_da_chegada * 100, 0)}%. Margem preservada estimada: ${reais(m.margem_preservada_cents)}.`);
    if (q > 0 && p.custo > 0) L.push(`Valor esperado destas unidades por real investido: ${num(valorDoLote(p, p.posicao, q, cfg) / (q * p.custo), 2)} (margem unitária ${reais(p.margem)}, custo ${reais(p.custo)}).`);
    if (p.multiplo > 1 || p.minimo > 1) L.push(`Embalagem: mínimo ${p.minimo}, múltiplo ${p.multiplo}.`);
    if (m && p.grande.un) L.push(`Pedido grande (percentil ${cfg.pedido_grande.percentil} das linhas de venda: ${num(p.grande.un, 0)} un, ${num(p.grande.linhas, 0)} linhas em 12 meses): chance de ter estoque para ele na chegada ${num(m.p_pedido_grande_sem_compra * 100, 0)}% sem compra → ${num(m.p_pedido_grande * 100, 0)}%.${unGrande > 0 ? ` ${num(unGrande, 0)} un entraram pela reserva para pedido grande (custo ${reais(unGrande * p.custo)}; manter parado custa cerca de ${reais(unGrande * p.custo * cfg.custo_manutencao_anual)} por ano).` : ''}`);
    if (it.origem_comprovada === false) L.push(`Atenção: origem de abastecimento não comprovada (${it.origem_motivo || 'sem detalhe'}).`);
    if (decisaoForn) L.push(decisaoForn === 'COMPLETADO_ATE_O_MINIMO' ? 'O fornecedor foi completado até o pedido mínimo.' : 'O fornecedor ficou de fora por não atingir o pedido mínimo com retorno suficiente.');
    L.push(MOTIVOS[motivo] || motivo);
    return L;
  }

  /**
   * Simulação completa. dados = { itens, fornecedores: { id: { nome, minimo_cents?, minimo_un?, pedido_p10_cents? } } }
   * `opts.semNecessario` evita a segunda passada sem teto (usada em varreduras).
   */
  function simular(dados, extra, opts = {}) {
    const cfg = configurar(extra);
    const fornecedores = dados.fornecedores || {};
    const prontos = [...dados.itens].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(i => preparar(i, cfg));
    const aloc = alocar(prontos, cfg, fornecedores);
    const medidores = new Map();
    const finais = new Map(aloc.qtd);
    for (const [id, q] of Object.entries(cfg.ajustes)) if (prontos.some(p => p.id === id && p.custo > 0)) finais.set(id, q);
    const totais = avaliar(prontos, finais, cfg, medidores);
    totais.orcamento_cents = cfg.orcamento_cents;
    totais.saldo_cents = cfg.orcamento_cents === null ? null : cfg.orcamento_cents - totais.capital_cents;
    totais.retorno_marginal = aloc.retorno_marginal;
    if (!opts.semNecessario) totais.capital_necessario_cents = cfg.orcamento_cents === null ? aloc.usado_cents : alocar(prontos, { ...cfg, orcamento_cents: null }, fornecedores).usado_cents;
    // custo explícito da reserva para pedido grande: unidades compradas por ela e o custo anual de mantê-las
    if (cfg.pedido_grande.usar) {
      const reservado = prontos.reduce((s, p) => s + (aloc.grande.get(p.id) || 0) * p.custo, 0);
      totais.pedido_grande = { capital_reservado_cents: Math.round(reservado), custo_anual_cents: Math.round(reservado * cfg.custo_manutencao_anual), taxa_anual: cfg.custo_manutencao_anual };
    }

    const linhas = [];
    for (const p of prontos) {
      const motivo = aloc.motivos.get(p.id), q = finais.get(p.id) || 0, rec = aloc.qtd.get(p.id) || 0;
      if ((motivo === 'FORA_DA_REPOSICAO' || motivo === 'FORA_DO_FILTRO') && !q) continue;
      let med = medidores.get(p.id);
      if (!med && p.v > 0) { med = medidor(p, cfg); medidores.set(p.id, med); }
      const m = med ? med(q) : null;
      const ajustado = Object.prototype.hasOwnProperty.call(cfg.ajustes, p.id) && q !== rec;
      const it = p.item;
      linhas.push({ id: p.id, codigo: it.codigo || null, nome: it.nome || null, categoria: it.categoria || null, marca: it.marca || null, fornecedor_id: p.fornecedor, classe: p.classe, xyz: p.chave[1],
        estado: it.estado, estoque: p.estoque, a_caminho: p.posicao - p.estoque, posicao: p.posicao, ponto: p.ponto, alvo: p.alvo, multiplo: p.multiplo, minimo: p.minimo,
        qtd_recomendada: rec, qtd: q, ajustado, custo_cents: p.custo, valor_cents: q * p.custo, motivo, motivo_texto: MOTIVOS[motivo] || motivo,
        falta_para_o_alvo_cents: SEM_ORCAMENTO_ALGUM.includes(motivo) ? Math.max(0, acimaMultiplo(Math.max(0, p.alvo - p.posicao), p.multiplo) - q) * p.custo : 0,
        prazo_dias: p.L, prazo_fonte: p.prazo_fonte, prazo_texto: PRAZOS[p.prazo_fonte] || 'não informado', pedido_grande_un: p.grande.un || null, reservado_pedido_grande: aloc.grande.get(p.id) || 0,
        risco_pedido_grande: m && m.p_pedido_grande !== null ? 1 - m.p_pedido_grande : null,
        valor_por_real: q > 0 && p.custo > 0 && p.v > 0 ? valorDoLote(p, p.posicao, q, cfg) / (q * p.custo) : null,
        ordem_recomendada: rec > 0 && p.custo > 0 && p.v > 0 ? valorDoLote(p, p.posicao, rec, cfg) / (rec * p.custo) : null,
        cobertura_antes: m ? m.cobertura_antes : null, cobertura_depois: m ? m.cobertura_depois : null, risco_antes: m ? m.p_falta_sem_compra : null, risco_depois: m ? m.p_falta : null,
        margem_preservada_cents: m ? Math.round(m.margem_preservada_cents) : 0, excesso_90d_cents: m ? Math.round(m.excesso_90d_cents) : 0,
        justificativa: [...justificar(p, q, motivo, m, cfg, aloc.decisoes[p.fornecedor], aloc.grande.get(p.id) || 0), ...(ajustado ? [`Ajuste manual: ${num(q, 0)} un (recomendado ${num(rec, 0)}).`] : [])] });
    }
    // a ordem segue a RECOMENDAÇÃO (um ajuste manual não faz a linha mudar de lugar)
    linhas.sort((a, b) => (b.qtd_recomendada > 0) - (a.qtd_recomendada > 0) || (b.ordem_recomendada || 0) - (a.ordem_recomendada || 0) || (b.falta_para_o_alvo_cents - a.falta_para_o_alvo_cents) || String(a.id).localeCompare(String(b.id)));

    const porForn = new Map();
    for (const l of linhas) {
      if (!(l.qtd > 0) && !aloc.decisoes[l.fornecedor_id]) continue;
      const k = l.fornecedor_id || '';
      const g = porForn.get(k) || porForn.set(k, { fornecedor_id: l.fornecedor_id, nome: l.fornecedor_id ? (fornecedores[l.fornecedor_id] || {}).nome || 'Fornecedor #' + l.fornecedor_id : 'Sem fornecedor identificado', valor_cents: 0, unidades: 0, produtos: 0 }).get(k);
      if (l.qtd > 0) { g.valor_cents += l.valor_cents; g.unidades += l.qtd; g.produtos++; }
    }
    for (const g of porForn.values()) {
      const m = minimoDoFornecedor(g.fornecedor_id, cfg, fornecedores);
      g.minimo = m;
      g.situacao = aloc.decisoes[g.fornecedor_id] || (m ? 'ATENDE_O_MINIMO' : 'SEM_MINIMO_INFORMADO');
      if (m && g.unidades > 0 && !atingeMinimo({ cents: g.valor_cents, un: g.unidades }, m)) g.situacao = 'ABAIXO_DO_MINIMO';
    }
    const lista = [...porForn.values()].sort((a, b) => b.valor_cents - a.valor_cents || String(a.nome).localeCompare(String(b.nome)));
    const alertas = [];
    if (cfg.orcamento_cents !== null && totais.capital_cents > cfg.orcamento_cents) alertas.push('AJUSTES_ULTRAPASSAM_O_ORCAMENTO');
    if (lista.some(g => g.fornecedor_id && cfg.orcamento_fornecedor_cents[g.fornecedor_id] !== undefined && g.valor_cents > cfg.orcamento_fornecedor_cents[g.fornecedor_id])) alertas.push('AJUSTES_ULTRAPASSAM_O_TETO_DO_FORNECEDOR');
    if (linhas.some(l => l.ajustado && l.qtd > 0 && (l.qtd < l.minimo || l.qtd % l.multiplo !== 0))) alertas.push('AJUSTES_FORA_DO_MINIMO_OU_MULTIPLO');
    if (lista.some(g => g.situacao === 'ABAIXO_DO_MINIMO')) alertas.push('FORNECEDOR_ABAIXO_DO_MINIMO');
    if (linhas.some(l => l.motivo === 'ORIGEM_NAO_COMPROVADA')) alertas.push('HA_PRODUTOS_SEM_ORIGEM_COMPROVADA');
    if (linhas.some(l => l.motivo === 'REVISAR_RUPTURA_LONGA')) alertas.push('HA_PRODUTOS_EM_REVISAO_MANUAL');
    return { rotulo: ROTULO, policy_version: cfg.policy_version, config: cfg, totais, fornecedores: lista, linhas,
      nao_contemplados: linhas.filter(l => l.falta_para_o_alvo_cents > 0).sort((a, b) => b.falta_para_o_alvo_cents - a.falta_para_o_alvo_cents || String(a.id).localeCompare(String(b.id))), alertas };
  }

  const COLUNAS = ['produto', 'codigo', 'nome', 'fornecedor_id', 'categoria', 'classe', 'xyz', 'estoque', 'a_caminho', 'qtd_recomendada', 'qtd_simulada', 'custo_reais', 'valor_reais', 'situacao', 'cobertura_antes_dias', 'cobertura_depois_dias', 'risco_falta_antes_pct', 'risco_falta_depois_pct', 'margem_preservada_reais', 'justificativa'];
  /** CSV (";" e vírgula decimal). Textos que começam como fórmula são neutralizados para planilhas. `extras` = { coluna: linha => valor }. */
  function csv(linhas, { comNomes = true, extras = {} } = {}) {
    const dec = (x, c = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '' : String(Math.round(x * 10 ** c) / 10 ** c).replace('.', ','));
    const texto = x => { let s = x === null || x === undefined ? '' : String(x); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = "'" + s; return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const cols = [...COLUNAS.filter(c => comNomes || c !== 'nome'), ...Object.keys(extras)];
    const linha = l => ({ produto: l.id, codigo: l.codigo, nome: l.nome, fornecedor_id: l.fornecedor_id, categoria: l.categoria, classe: l.classe, xyz: l.xyz, estoque: dec(l.estoque), a_caminho: dec(l.a_caminho), qtd_recomendada: l.qtd_recomendada, qtd_simulada: l.qtd,
      custo_reais: dec(l.custo_cents / 100), valor_reais: dec(l.valor_cents / 100), situacao: l.motivo_texto, cobertura_antes_dias: dec(l.cobertura_antes, 0), cobertura_depois_dias: dec(l.cobertura_depois, 0),
      risco_falta_antes_pct: dec(l.risco_antes === null ? null : l.risco_antes * 100, 0), risco_falta_depois_pct: dec(l.risco_depois === null ? null : l.risco_depois * 100, 0), margem_preservada_reais: dec(l.margem_preservada_cents / 100), justificativa: (l.justificativa || []).join(' ') });
    return [[...cols].join(';'), ...linhas.map(l => { const o = linha(l); for (const [c, f] of Object.entries(extras)) o[c] = f(l); return cols.map(c => texto(o[c])).join(';'); })].join('\n') + '\n';
  }

  return { ROTULO, PARAMETROS, MOTIVOS, PRAZOS, PERCENTIS, SEM_ORCAMENTO_ALGUM, configurar, validar, distribuicao, probAoMenos, esperadoAte, quantil, aCaminho, preparar, prazoDe, embalagemDe, pedidoGrande, noFiltro, impedimento, valorDoLote, somaDias, minimoDoFornecedor, alocar, avaliar, medidor, justificar, simular, csv };
});
