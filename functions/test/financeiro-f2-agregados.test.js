'use strict';
// FINANCEIRO Fase 2 · agregados da geração, regras de produto, fuso, vínculos, tamanho, e comparação com ORÁCULO independente.
const C = require('../lib/financeiro/canonico');
const A = require('../lib/financeiro/agregados');
const { FORMAS, titulo, receber } = require('./fixtures/financeiro-f1');
const { massa } = require('./fixtures/financeiro-f2');
const { oraculo, doResumo } = require('./helpers/financeiro-oraculo');
const refs = { formasPorId: FORMAS };
const HOJE = '2026-09-28', AGORA = new Date('2026-09-28T15:00:00Z');
const d = n => C.somarDias(HOJE, n);
const canonDe = (ps, rs) => [...ps.map(b => C.mapearTitulo(b, 'PAGAR', refs)), ...rs.map(b => C.mapearTitulo(b, 'RECEBER', refs))];
const gera = (ps, rs, extra = {}) => A.construirGeracao({ canon: canonDe(ps, rs), agora: AGORA, geracao: 'gT', hoje: HOJE, ...extra });
const todasFatias = g => g.fatias.flatMap(f => f.doc.itens.map(i => ({ ...i, _g: f.doc.grupo, _n: f.doc.natureza })));

describe('classificação e agregados (cards)', () => {
  const ps = [titulo({ id: 'v1', data_vencimento: d(-3), valor: '100.00', valor_total: '100.00' }), titulo({ id: 'h', data_vencimento: HOJE, valor: '50.00', valor_total: '50.00' }), titulo({ id: 'f2', data_vencimento: d(2), valor: '10.00', valor_total: '10.00' }), titulo({ id: 'f20', data_vencimento: d(20), valor: '5.00', valor_total: '5.00' }),
    titulo({ id: 'pago', liquidado: '1', data_liquidacao: d(-1), valor: '7.00', valor_total: '7.00' }), titulo({ id: 'unk', liquidado: '0', data_liquidacao: d(-1), valor: '9.00', valor_total: '9.00' })];
  const g = gera(ps, []);
  test('abertos / vencido / hoje / janelas acumuladas / requer conferência / pago', () => {
    const p = g.resumo.pagar;
    expect(p.abertos).toEqual({ n: 4, c: 16500 }); expect(p.vencido).toEqual({ n: 1, c: 10000 }); expect(p.hoje).toEqual({ n: 1, c: 5000 });
    expect(p.prox_3d).toEqual({ n: 2, c: 6000 }); expect(p.prox_7d.n).toBe(2); expect(p.prox_15d.n).toBe(2); expect(p.prox_30d).toEqual({ n: 3, c: 6500 });
    expect(p.requer_conferencia.n).toBe(1); expect(p.pago.historico).toEqual({ n: 1, c: 700 });
  });
  test('UNKNOWN nunca entra em aberto/vencido/pago e traz motivo factual em português', () => {
    const p = g.resumo.pagar; expect(p.abertos.n + p.pago.historico.n + p.requer_conferencia.n).toBe(p.total_titulos);
    expect(p.requer_conferencia.motivos.ABERTO_COM_DATA_LIQUIDACAO.texto).toBe('Status aberto, mas existe data de liquidação');
    const u = todasFatias(g).find(i => i.id === 'unk'); expect(u).toMatchObject({ _g: 'UNKNOWN', mot: 'ABERTO_COM_DATA_LIQUIDACAO', motx: 'Status aberto, mas existe data de liquidação' });
    expect(todasFatias(g).filter(i => i.id === 'unk')).toHaveLength(1);
  });
  test('fluxo programado = recebimentos − pagamentos programados; rotulado, sem virar saldo', () => {
    const r = [receber({ id: 'r1', data_vencimento: d(2), valor: '300.00', valor_total: '300.00' })];
    const f = gera(ps, r).resumo.fluxo_programado;
    expect(f.d7).toEqual({ receber_c: 30000, pagar_c: 6000, liquido_c: 30000 - 6000 }); expect(f.definicao).toMatch(/NÃO é saldo bancário nem caixa/);
  });
  test('saldo e capacidade de compra: modelo pronto, valores ausentes (nenhum número, nenhum R$ 0)', () => {
    const r = g.resumo; expect(r.bankBalance).toMatchObject({ available: false }); expect(r.purchaseCapacity.status).toBe('BLOCKED');
    expect(JSON.stringify(r)).not.toMatch(/"(saldo|caixa_disponivel|capacidade_de_compra|free_cash|runway|inadimplencia_pct|inadimplencia_percent)[a-z_]*"\s*:\s*-?\d/i);
    expect(JSON.stringify(r)).not.toMatch(/inadimpl[^"]*pct|percentual_inadimpl/i);
  });
});

describe('envelhecimento: >365 dias preservado e visível', () => {
  test('títulos de 400 e 1000 dias de atraso entram em ACIMA_365, no total vencido e na lista; nada é descartado por idade', () => {
    const rs = [receber({ id: 'a400', data_vencimento: d(-400), valor: '20.00', valor_total: '20.00' }), receber({ id: 'a1000', data_vencimento: d(-1000), valor: '30.00', valor_total: '30.00' }), receber({ id: 'a10', data_vencimento: d(-10), valor: '1.00', valor_total: '1.00' })];
    const g = gera([], rs); const r = g.resumo.receber;
    expect(r.envelhecimento.ACIMA_365).toEqual({ n: 2, c: 5000 }); expect(r.vencido).toEqual({ n: 3, c: 5100 });
    expect(Object.values(r.envelhecimento).reduce((a, x) => a + x.c, 0)).toBe(r.vencido.c);
    const venc = todasFatias(g).filter(i => i._g === 'VENCIDO'); expect(venc.map(i => i.id).sort()).toEqual(['a10', 'a1000', 'a400']); expect(venc.find(i => i.id === 'a1000').ag).toBe('ACIMA_365');
  });
  test('as 8 faixas aprovadas e exclusivas', () => { expect(require('../lib/financeiro/motor').FAIXAS_ATRASO.map(f => f[0])).toEqual(['D1_A_7', 'D8_A_15', 'D16_A_30', 'D31_A_60', 'D61_A_90', 'D91_A_180', 'D181_A_365', 'ACIMA_365']); });
});

describe('forma de pagamento factual', () => {
  test('"boleto Inter/Pix" permanece AMBÍGUO ("Boleto Inter/Pix"); não vira PIX nem Boleto; categorias só as que a fonte suporta', () => {
    const rs = [receber({ id: 'x1', forma_pagamento_id: 'f_bolpix', nome_forma_pagamento: 'boleto Inter/Pix', data_vencimento: d(1), valor: '10.00', valor_total: '10.00' }), receber({ id: 'x2', forma_pagamento_id: 'f_pix', nome_forma_pagamento: 'Pix', data_vencimento: d(1), valor: '5.00', valor_total: '5.00' }),
      receber({ id: 'x3', forma_pagamento_id: 'f_bol', nome_forma_pagamento: 'Boleto Bancário', data_vencimento: d(1), valor: '2.00', valor_total: '2.00' }), receber({ id: 'x4', forma_pagamento_id: 'zzz', nome_forma_pagamento: 'Forma desconhecida', data_vencimento: d(1), valor: '1.00', valor_total: '1.00' })];
    const g = gera([], rs); const f = Object.fromEntries(g.resumo.receber.por_forma.map(x => [x.forma, x]));
    expect(Object.keys(f).sort()).toEqual(['Boleto', 'Boleto Inter/Pix', 'Não identificado', 'PIX']);
    expect(f['Boleto Inter/Pix']).toMatchObject({ ambigua: true, aberto: { n: 1, c: 1000 } }); expect(f.PIX.aberto.c).toBe(500); expect(f.Boleto.aberto.c).toBe(200);
    expect(todasFatias(g).find(i => i.id === 'x1')).toMatchObject({ fp: 'Boleto Inter/Pix', amb: true });
  });
});

describe('vínculos (nunca heurística como fato)', () => {
  test('venda: texto exato + venda única + mesmo cliente → SAFE_DETERMINISTIC; conflito/duplicado → AMBIGUO; inexistente → sem vínculo', () => {
    const rs = [receber({ id: 'ok', descricao: 'Venda de nº 1', cliente_id: 'C1' }), receber({ id: 'conf', descricao: 'Venda de nº 2', cliente_id: 'C1' }), receber({ id: 'dup', descricao: 'Venda de nº 3', cliente_id: 'C1' }), receber({ id: 'nao', descricao: 'Venda de nº 9', cliente_id: 'C1' }), receber({ id: 'livre', descricao: 'Algo', cliente_id: 'C1' })];
    const vendas = { 1: [{ id: 'V1', codigo: '1', cliente_id: 'C1' }], 2: [{ id: 'V2', codigo: '2', cliente_id: 'OUTRO' }], 3: [{ id: 'V3', codigo: '3', cliente_id: 'C1' }, { id: 'V3b', codigo: '3', cliente_id: 'C1' }] };
    const g = gera([], rs, { vendasPorCodigo: vendas }); const m = Object.fromEntries(todasFatias(g).map(i => [i.id, i.lk]));
    expect(m.ok).toEqual({ t: 'VENDA', cod: '1', regra: 'SAFE_DETERMINISTIC' }); expect(m.conf).toEqual({ t: 'AMBIGUO' }); expect(m.dup).toEqual({ t: 'AMBIGUO' }); expect(m.nao).toBeUndefined(); expect(m.livre).toBeUndefined();
    expect(g.resumo.receber.vinculos).toMatchObject({ CONFIRMADO: 1, CONFLITO_CLIENTE: 1, CODIGO_DUPLICADO: 1, NAO_RESOLVIDO: 1, SEM_REFERENCIA: 1 });
  });
  test('compra: SAFE_DETERMINISTIC_TEXT_LINK só com texto exato + fornecedor igual; fornecedor+valor+data sem referência NÃO vincula (HEURISTIC_ONLY não aparece)', () => {
    const ps = [titulo({ id: 'c1', descricao: 'Compra de nº 10', fornecedor_id: 'F1' }), titulo({ id: 'h1', descricao: 'Mercadoria', fornecedor_id: 'F1', valor: '500.00', valor_total: '500.00' }), titulo({ id: 'c2', descricao: 'Compra de nº 11', fornecedor_id: 'F2' })];
    const compras = { 10: [{ id: 'CP10', codigo: '10', fornecedor_id: 'F1', valor_total: '500.00' }], 11: [{ id: 'CP11', codigo: '11', fornecedor_id: 'F1' }] };
    const g = gera(ps, [], { comprasPorCodigo: compras }); const m = Object.fromEntries(todasFatias(g).map(i => [i.id, i.lk]));
    expect(m.c1).toEqual({ t: 'COMPRA', cod: '10', regra: 'SAFE_DETERMINISTIC_TEXT_LINK' }); expect(m.h1).toBeUndefined(); expect(m.c2).toEqual({ t: 'AMBIGUO' });
    expect(JSON.stringify(g)).not.toMatch(/HEURISTIC_ONLY/);
  });
});

describe('fuso America/Fortaleza e calendário', () => {
  test.each([
    ['23:59 de 30/09 em Fortaleza (02:59Z de 01/10)', '2026-10-01T02:59:00Z', '2026-09-30'], ['00:00 de 01/10 em Fortaleza (03:00Z)', '2026-10-01T03:00:00Z', '2026-10-01'],
    ['virada de ano 31/12 23:59', '2027-01-01T02:59:00Z', '2026-12-31'], ['fevereiro bissexto 2028', '2028-03-01T02:59:00Z', '2028-02-29'], ['fevereiro comum 2027', '2027-03-01T02:59:00Z', '2027-02-28'],
  ])('%s → hoje = %s; vencimento "hoje" é DUE_TODAY; ontem é vencido; amanhã é futuro', (_, iso, hoje) => {
    expect(C.dataComercial(new Date(iso))).toBe(hoje);
    const g = A.construirGeracao({ canon: canonDe([titulo({ id: 'o', data_vencimento: C.somarDias(hoje, -1) }), titulo({ id: 'h', data_vencimento: hoje }), titulo({ id: 'a', data_vencimento: C.somarDias(hoje, 1) })], []), agora: new Date(iso), geracao: 'gT', hoje });
    expect(g.resumo.pagar.vencido.n).toBe(1); expect(g.resumo.pagar.hoje.n).toBe(1); expect(g.resumo.pagar.prox_3d.n).toBe(2);
  });
});

describe('detalhes em fatias e tamanhos', () => {
  const m = massa({ hoje: HOJE, nPagar: 700, nReceber: 1600 });
  const g = gera(m.pagamentos, m.recebimentos);
  test('fatias ≤ 250 títulos, ids determinísticos, índice do resumo confere, ordem estável (vencidos: mais antigo primeiro; pagos: mais recente primeiro)', () => {
    for (const f of g.fatias) { expect(f.doc.itens.length).toBeLessThanOrEqual(250); expect(f.id).toBe(`gT__${f.doc.natureza}__${f.doc.grupo}__${String(f.doc.indice).padStart(3, '0')}`); }
    for (const nat of ['pagar', 'receber']) for (const [gr, ix] of Object.entries(g.resumo[nat].detalhe)) { const fs = g.fatias.filter(f => f.doc.natureza === nat.toUpperCase() && f.doc.grupo === gr); expect(fs.length).toBe(ix.fatias); expect(fs.reduce((a, f) => a + f.doc.itens.length, 0)).toBe(ix.titulos); }
    const venc = g.fatias.filter(f => f.doc.natureza === 'RECEBER' && f.doc.grupo === 'VENCIDO').flatMap(f => f.doc.itens).map(i => i.v); expect(venc).toEqual([...venc].sort());
    const pagos = g.fatias.filter(f => f.doc.natureza === 'RECEBER' && f.doc.grupo === 'PAGO').flatMap(f => f.doc.itens).map(i => i.sd); expect(pagos).toEqual([...pagos].sort().reverse());
  });
  test('resumo pequeno (< 100 KB) e fatia < 400 KB: dashboard nunca carrega a base', () => {
    const b = x => Buffer.byteLength(JSON.stringify(x)); expect(b(g.resumo)).toBeLessThan(100000); expect(Math.max(...g.fatias.map(f => b(f.doc)))).toBeLessThan(400000); expect(b(g.entidades)).toBeLessThan(500000);
  });
  test('retenção: pagos com baixa há > 365 dias saem do detalhe mas continuam no total histórico; abertos e UNKNOWN de qualquer idade ficam', () => {
    const ps = [titulo({ id: 'velhoPago', liquidado: '1', data_liquidacao: d(-400), data_vencimento: d(-400), valor: '1.00', valor_total: '1.00' }), titulo({ id: 'novoPago', liquidado: '1', data_liquidacao: d(-5), data_vencimento: d(-5), valor: '2.00', valor_total: '2.00' }),
      titulo({ id: 'velhoAberto', data_vencimento: d(-900), valor: '3.00', valor_total: '3.00' }), titulo({ id: 'velhoUnk', liquidado: '0', data_liquidacao: d(-800), data_vencimento: d(-800), valor: '4.00', valor_total: '4.00' })];
    const gg = gera(ps, []); const ids = todasFatias(gg).map(i => i.id).sort();
    expect(ids).toEqual(['novoPago', 'velhoAberto', 'velhoUnk']); expect(gg.resumo.pagar.pago.historico).toEqual({ n: 2, c: 300 });
  });
  test('resumo e entidades: entidades (com nomes) só no documento sob demanda; resumo sem nomes nem ids de título', () => {
    const txt = JSON.stringify(g.resumo); expect(txt).not.toMatch(/Fictício/); expect(txt).not.toMatch(/"id":"(AP|AR)\d/);
    expect(JSON.stringify(g.entidades)).toMatch(/Fornecedor Fictício/);
  });
});

describe('GOLDEN: motor × oráculo independente (dados brutos sintéticos, 5 sementes, várias datas "hoje")', () => {
  test.each([[1, '2026-09-28'], [2, '2026-09-30'], [3, '2027-01-01'], [4, '2028-02-29'], [5, '2026-12-31']])('semente %i, hoje %s: FINANCIAL_GOLDEN_DIFF=0', (sem, hoje) => {
    const m = massa({ hoje, nPagar: 400, nReceber: 900, semente: sem });
    // contradições injetadas: aberto com data de baixa, liquidado sem data, baixa futura, valor negativo, valor zero pago
    m.pagamentos.push(titulo({ id: 'X1', liquidado: '0', data_liquidacao: C.somarDias(hoje, -2) }), titulo({ id: 'X2', liquidado: '1', data_liquidacao: '' }), titulo({ id: 'X3', liquidado: '1', data_liquidacao: C.somarDias(hoje, 3) }), titulo({ id: 'X4', valor_total: '-1.00' }), titulo({ id: 'X5', liquidado: '1', data_liquidacao: hoje, valor_total: '0.00' }));
    const g = A.construirGeracao({ canon: canonDe(m.pagamentos, m.recebimentos), agora: new Date(hoje + 'T15:00:00Z'), geracao: 'gG', hoje });
    expect(doResumo(g.resumo.pagar)).toEqual(oraculo(m.pagamentos, hoje)); expect(doResumo(g.resumo.receber)).toEqual(oraculo(m.recebimentos, hoje));
    expect(g.resumo.pagar.requer_conferencia.n).toBeGreaterThanOrEqual(4);
  });
});
