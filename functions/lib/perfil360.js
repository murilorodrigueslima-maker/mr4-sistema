'use strict';

/**
 * Motor Perfil Comercial 360 — V1
 *
 * Engine DETERMINÍSTICO — mesma entrada + mesma dataReferencia = mesma saída.
 * Sem I/O, sem Firestore, sem GestãoClick.
 * Recebe dados já carregados; retorna o perfil calculado.
 *
 * NÃO contém: score, IA, recomendação, encarteiramento, risco inventado.
 */

const VERSAO_ENGINE = '1.0.0';

// ── Helpers de calendar-date ──────────────────────────────────────────────────

/** Valida se s é uma string no formato YYYY-MM-DD. */
function validDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Retorna a diferença em dias do calendário entre startDate e endDate.
 * Opera em UTC puro a partir de strings YYYY-MM-DD — sem conversão de timezone.
 * Resultado é positivo se endDate > startDate.
 */
function daysBetweenCalendarDates(startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  return Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000
  );
}

/**
 * Retorna a string YYYY-MM-DD que é n dias ANTES de dateStr.
 * Opera em UTC puro — não sofre off-by-one por timezone.
 */
function subtractCalendarDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Verifica se dateStr está dentro do intervalo [windowStart, windowEnd] inclusive.
 * Comparação lexicográfica de strings YYYY-MM-DD é correta para datas ISO.
 */
function isWithinWindow(dateStr, windowStart, windowEnd) {
  return dateStr >= windowStart && dateStr <= windowEnd;
}

// ── Helpers monetários (centavos) ─────────────────────────────────────────────

/**
 * Converte um valor monetário (string, number ou null) para centavos inteiros.
 * Usa Math.round para evitar erros de ponto flutuante na multiplicação × 100.
 */
function toCentavos(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(String(val).trim());
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Converte centavos inteiros para reais com 2 casas decimais. */
function centavosToReais(centavos) {
  return Math.round(centavos) / 100;
}

// ── Deduplicação ──────────────────────────────────────────────────────────────

/**
 * Deduplica um array de vendas por venda.id.
 * Se dois objetos com mesmo ID divergirem em nome_situacao OU valor_total,
 * registra o conflito em `conflicts` e MANTÉM a primeira ocorrência.
 * NÃO descarta silenciosamente.
 *
 * @returns {{ vendas: Array, conflicts: Array }}
 */
function deduplicarVendas(vendas) {
  const seen = new Map();
  const conflicts = [];

  for (const v of (vendas || [])) {
    const id = String(v.id ?? '');
    if (!id) continue;

    if (seen.has(id)) {
      const existing = seen.get(id);
      const statusDiverge = (existing.nome_situacao || '') !== (v.nome_situacao || '');
      const valorDiverge  = toCentavos(existing.valor_total) !== toCentavos(v.valor_total);
      if (statusDiverge || valorDiverge) {
        conflicts.push({ id, existing, duplicate: v });
      }
      // Sempre manter primeira ocorrência — não sobrescrever.
    } else {
      seen.set(id, v);
    }
  }

  return { vendas: Array.from(seen.values()), conflicts };
}

// ── Agrupamento ───────────────────────────────────────────────────────────────

/**
 * Agrupa um array de vendas em Map<string(cliente_id), venda[]>.
 * Vendas com cliente_id ausente/vazio são ignoradas.
 */
function agruparVendasPorCliente(vendas) {
  const map = new Map();
  for (const v of (vendas || [])) {
    const cid = String(v.cliente_id ?? '').trim();
    if (!cid) continue;
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid).push(v);
  }
  return map;
}

// ── Frequência ────────────────────────────────────────────────────────────────

function _calcularMediana(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[Math.floor(n / 2)];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Frequência calculada por DIAS DISTINTOS com compra (não por pedidos individuais).
 * Auditoria confirmou 46 % dos compradores têm ≥ 2 pedidos no mesmo dia —
 * usar datas distintas evita intervalos zero que distorceriam a média.
 */
function _calcularFrequencia(datasDeCompra) {
  const distintas = [...new Set(datasDeCompra)].sort();
  if (distintas.length < 2) {
    return { diasEntreComprasMedio: null, diasEntreComprasMediana: null };
  }
  const intervalos = [];
  for (let i = 1; i < distintas.length; i++) {
    intervalos.push(daysBetweenCalendarDates(distintas[i - 1], distintas[i]));
  }
  const soma = intervalos.reduce((a, b) => a + b, 0);
  return {
    diasEntreComprasMedio:  Math.round((soma / intervalos.length) * 100) / 100,
    diasEntreComprasMediana: _calcularMediana(intervalos),
  };
}

// ── Vendedor da última venda (determinístico) ─────────────────────────────────

/**
 * Seleciona a venda mais recente usando critério determinístico:
 *   1. venda.data DESC  (YYYY-MM-DD, lexicográfico)
 *   2. venda.cadastrado_em DESC  (datetime string, lexicográfico)
 *   3. Number(venda.id) DESC  (ID numérico maior = mais recente no GC)
 */
function _selecionarUltimaVenda(concretizadas) {
  if (!concretizadas.length) return null;
  return concretizadas.reduce((best, v) => {
    const vD = (v.data || '').slice(0, 10);
    const bD = (best.data || '').slice(0, 10);
    if (vD > bD) return v;
    if (vD < bD) return best;
    const vC = String(v.cadastrado_em || '');
    const bC = String(best.cadastrado_em || '');
    if (vC > bC) return v;
    if (vC < bC) return best;
    return Number(v.id) > Number(best.id) ? v : best;
  });
}

// ── Produtos e Categorias ─────────────────────────────────────────────────────

function _calcularProdutosECategorias(concretizadas, produtosPorId) {
  const prodMap = new Map(); // produtoId → { nome, qtdAccum, pedidosSet, fatC }
  const catMap  = new Map(); // categoria  → { qtdAccum, pedidosSet, fatC }

  for (const venda of concretizadas) {
    const vendaId  = String(venda.id);
    const itens    = venda.produtos || [];
    const catsNaVenda = new Set();

    for (const rawItem of itens) {
      // Suporta estrutura flat (API lista) e nested { produto: { ... } } (detalhe)
      const item = rawItem.produto || rawItem;
      const pid  = String(item.produto_id ?? '').trim();
      if (!pid) continue;

      const nome  = String(item.nome_produto ?? '').trim();
      const qtd   = parseFloat(item.quantidade ?? 0) || 0;
      // item.valor_total = subtotal do item (qtd × valor_venda); usar como faturamento do item
      const fatC  = toCentavos(item.valor_total ?? 0);

      // ── Produto ──
      if (!prodMap.has(pid)) {
        prodMap.set(pid, { nome, qtdAccum: 0, pedidosSet: new Set(), fatC: 0 });
      }
      const p = prodMap.get(pid);
      if (!p.nome && nome) p.nome = nome;
      p.qtdAccum += qtd;
      p.pedidosSet.add(vendaId);
      p.fatC += fatC;

      // ── Categoria ──
      const prodInfo = produtosPorId ? (produtosPorId[pid] ?? null) : null;
      const cat = (prodInfo?.nome_grupo) ? String(prodInfo.nome_grupo).trim() : 'SEM_CATEGORIA';
      catsNaVenda.add(cat);

      if (!catMap.has(cat)) {
        catMap.set(cat, { qtdAccum: 0, pedidosSet: new Set(), fatC: 0 });
      }
      const c = catMap.get(cat);
      c.qtdAccum += qtd;
      c.fatC     += fatC;
    }

    // quantidadePedidos da categoria = COUNT DISTINCT venda.id por categoria
    for (const cat of catsNaVenda) {
      catMap.get(cat).pedidosSet.add(vendaId);
    }
  }

  // Montar array de produtos
  const produtosArr = [];
  for (const [produtoId, d] of prodMap.entries()) {
    produtosArr.push({
      produtoId,
      nome:               d.nome,
      quantidadeUnidades: Math.round(d.qtdAccum * 1000) / 1000,
      quantidadePedidos:  d.pedidosSet.size,
      faturamento:        centavosToReais(d.fatC),
    });
  }
  produtosArr.sort((a, b) => {
    if (b.quantidadeUnidades !== a.quantidadeUnidades) return b.quantidadeUnidades - a.quantidadeUnidades;
    if (b.quantidadePedidos  !== a.quantidadePedidos)  return b.quantidadePedidos  - a.quantidadePedidos;
    if (b.faturamento        !== a.faturamento)        return b.faturamento        - a.faturamento;
    return a.produtoId < b.produtoId ? -1 : 1;
  });

  // Montar array de categorias
  const catArr = [];
  for (const [cat, d] of catMap.entries()) {
    catArr.push({
      categoria:          cat,
      quantidadeUnidades: Math.round(d.qtdAccum * 1000) / 1000,
      quantidadePedidos:  d.pedidosSet.size,
      faturamento:        centavosToReais(d.fatC),
    });
  }
  catArr.sort((a, b) => {
    if (b.faturamento        !== a.faturamento)        return b.faturamento        - a.faturamento;
    if (b.quantidadeUnidades !== a.quantidadeUnidades) return b.quantidadeUnidades - a.quantidadeUnidades;
    return a.categoria < b.categoria ? -1 : 1;
  });

  return {
    produtosMaisComprados:     produtosArr.slice(0, 10),
    quantidadeProdutosDistintos: prodMap.size,
    categoriasMaisCompradas:   catArr.slice(0, 10),
  };
}

// ── Perfil vazio (nuncaComprou) ───────────────────────────────────────────────

function _perfilVazio({ clienteMr4Id, gestaoClickId, dataReferencia,
                        calculadoEm, historicoCoberto, conflicts }) {
  return {
    clienteMr4Id,
    gestaoClickId,

    primeiraCompraEm:  null,
    ultimaCompraEm:    null,
    diasSemComprar:    null,

    faturamento30d:   0,
    faturamento60d:   0,
    faturamento90d:   0,
    faturamento180d:  0,
    faturamentoTotal: 0,

    pedidos30d:   0,
    pedidos60d:   0,
    pedidos90d:   0,
    pedidos180d:  0,
    pedidosTotal: 0,

    ticketMedio30d:   null,
    ticketMedio60d:   null,
    ticketMedio90d:   null,
    ticketMedio180d:  null,
    ticketMedioTotal: null,

    diasEntreComprasMedio:   null,
    diasEntreComprasMediana: null,

    quantidadeProdutosDistintos: 0,
    produtosMaisComprados:   [],
    categoriasMaisCompradas: [],

    vendedorUltimaVendaId:   null,
    vendedorUltimaVendaNome: null,

    inativo120d:  false,
    nuncaComprou: true,

    calculadoEm:      calculadoEm ?? null,
    dataReferencia,
    versaoEngine:     VERSAO_ENGINE,
    historicoCoberto: historicoCoberto ?? null,

    _conflicts: conflicts,
  };
}

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * Calcula o Perfil Comercial 360 V1 para um cliente.
 *
 * @param {Object} params
 * @param {string}  params.clienteMr4Id    — Firestore document ID do cliente MR4
 * @param {string}  params.gestaoClickId   — ID do cliente no GestãoClick
 * @param {Array}   params.vendas          — Array de vendas do cliente (todos os status)
 * @param {Object}  [params.produtosPorId] — Map produto_id → { nome_grupo, ... } (opcional)
 * @param {string}  params.dataReferencia  — Data base YYYY-MM-DD (obrigatório, explícito)
 * @param {string}  [params.calculadoEm]   — ISO 8601 do momento de cálculo (metadado externo)
 * @param {Object}  [params.historicoCoberto] — { inicio, fim } período coberto pelo fetch
 * @returns {Object} Perfil360 V1
 */
function calcularPerfil360({
  clienteMr4Id,
  gestaoClickId,
  vendas,
  produtosPorId,
  dataReferencia,
  calculadoEm,
  historicoCoberto,
}) {
  if (!validDateString(dataReferencia)) {
    throw new Error(`dataReferencia inválida ou ausente: "${dataReferencia}"`);
  }

  // 1. Deduplicar por venda.id
  const { vendas: vendasUnicas, conflicts } = deduplicarVendas(vendas);

  // 2. Filtrar somente Concretizadas (trim defensivo; sem transformação)
  const concretizadas = vendasUnicas.filter(
    v => (v.nome_situacao ?? '').trim() === 'Concretizada'
  );

  // 3. Perfil vazio se nenhuma Concretizada
  if (concretizadas.length === 0) {
    return _perfilVazio({ clienteMr4Id, gestaoClickId, dataReferencia,
                          calculadoEm, historicoCoberto, conflicts });
  }

  // 4. Janelas: [ref - (N-1) dias, ref] — exatamente N datas inclusivas
  const w30start  = subtractCalendarDays(dataReferencia, 29);
  const w60start  = subtractCalendarDays(dataReferencia, 59);
  const w90start  = subtractCalendarDays(dataReferencia, 89);
  const w180start = subtractCalendarDays(dataReferencia, 179);

  // 5. Faturamento (centavos) e pedidos por janela
  let fat30c  = 0, fat60c  = 0, fat90c  = 0, fat180c = 0, fatTotc = 0;
  let ped30   = 0, ped60   = 0, ped90   = 0, ped180  = 0, pedTot  = 0;
  const datasDeCompra = [];

  for (const v of concretizadas) {
    const d = (v.data ?? '').slice(0, 10);
    const c = toCentavos(v.valor_total);
    fatTotc += c;
    pedTot  += 1;
    datasDeCompra.push(d);
    if (isWithinWindow(d, w30start,  dataReferencia)) { fat30c  += c; ped30  += 1; }
    if (isWithinWindow(d, w60start,  dataReferencia)) { fat60c  += c; ped60  += 1; }
    if (isWithinWindow(d, w90start,  dataReferencia)) { fat90c  += c; ped90  += 1; }
    if (isWithinWindow(d, w180start, dataReferencia)) { fat180c += c; ped180 += 1; }
  }

  // 6. Datas históricas
  const datasValidas    = datasDeCompra.filter(validDateString);
  const primeiraCompraEm = datasValidas.reduce((a, b) => (a < b ? a : b));
  const ultimaCompraEm   = datasValidas.reduce((a, b) => (a > b ? a : b));
  const diasSemComprar   = daysBetweenCalendarDates(ultimaCompraEm, dataReferencia);

  // 7. Ticket médio (arredondamento ao centavo, null se sem pedidos)
  const tmedio = (fatC, ped) =>
    ped > 0 ? Math.round(fatC / ped) / 100 : null;

  // 8. Frequência por dias distintos
  const { diasEntreComprasMedio, diasEntreComprasMediana }
    = _calcularFrequencia(datasValidas);

  // 9. Produtos e categorias
  const { produtosMaisComprados, quantidadeProdutosDistintos, categoriasMaisCompradas }
    = _calcularProdutosECategorias(concretizadas, produtosPorId);

  // 10. Vendedor da última venda (critério determinístico documentado)
  const ultimaVenda = _selecionarUltimaVenda(concretizadas);
  const vendedorUltimaVendaId   = ultimaVenda
    ? (String(ultimaVenda.vendedor_id  ?? '').trim() || null)
    : null;
  const vendedorUltimaVendaNome = ultimaVenda
    ? (String(ultimaVenda.nome_vendedor ?? '').trim() || null)
    : null;

  // 11. Flags
  const inativo120d = diasSemComprar >= 120;  // exatamente 120 = inativo

  return {
    clienteMr4Id,
    gestaoClickId,

    primeiraCompraEm,
    ultimaCompraEm,
    diasSemComprar,

    faturamento30d:   centavosToReais(fat30c),
    faturamento60d:   centavosToReais(fat60c),
    faturamento90d:   centavosToReais(fat90c),
    faturamento180d:  centavosToReais(fat180c),
    faturamentoTotal: centavosToReais(fatTotc),

    pedidos30d:   ped30,
    pedidos60d:   ped60,
    pedidos90d:   ped90,
    pedidos180d:  ped180,
    pedidosTotal: pedTot,

    ticketMedio30d:   tmedio(fat30c,  ped30),
    ticketMedio60d:   tmedio(fat60c,  ped60),
    ticketMedio90d:   tmedio(fat90c,  ped90),
    ticketMedio180d:  tmedio(fat180c, ped180),
    ticketMedioTotal: tmedio(fatTotc, pedTot),

    diasEntreComprasMedio,
    diasEntreComprasMediana,

    quantidadeProdutosDistintos,
    produtosMaisComprados,
    categoriasMaisCompradas,

    vendedorUltimaVendaId,
    vendedorUltimaVendaNome,

    inativo120d,
    nuncaComprou: false,

    calculadoEm:      calculadoEm ?? null,
    dataReferencia,
    versaoEngine:     VERSAO_ENGINE,
    historicoCoberto: historicoCoberto ?? null,

    _conflicts: conflicts,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  VERSAO_ENGINE,
  calcularPerfil360,
  deduplicarVendas,
  agruparVendasPorCliente,
  // Helpers expostos para testes
  validDateString,
  daysBetweenCalendarDates,
  subtractCalendarDays,
  isWithinWindow,
  toCentavos,
  centavosToReais,
};
