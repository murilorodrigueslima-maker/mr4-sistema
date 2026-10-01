'use strict';
// AGENTE FINANCEIRO MR4 — gates do RC final: envelhecimento, janela de 3 dias, baixa com data futura, vínculo pagar→compra,
// fuso de Fortaleza, ausência de saldo/caixa, privacidade do resumo, determinismo. Fixtures 100% sintéticas.
const fs = require('fs'), path = require('path');
const C = require('../lib/financeiro/canonico');
const M = require('../lib/financeiro/motor');
const A = require('../lib/financeiro/agregados');
const { HOJE, FORMAS, titulo, receber } = require('./fixtures/financeiro-f1');
const refs = { formasPorId: FORMAS };
const pag = o => C.mapearTitulo(titulo(o), 'PAGAR', refs);
const rec = o => C.mapearTitulo(receber(o), 'RECEBER', refs);
const d = n => C.somarDias(HOJE, n);

describe('envelhecimento de vencidos (faixas exclusivas)', () => {
  const casos = [[1, 'D1_A_7'], [7, 'D1_A_7'], [8, 'D8_A_15'], [15, 'D8_A_15'], [16, 'D16_A_30'], [30, 'D16_A_30'], [31, 'D31_A_60'], [60, 'D31_A_60'], [61, 'D61_A_90'], [90, 'D61_A_90'], [91, 'D91_A_180'], [180, 'D91_A_180'], [181, 'D181_A_365'], [365, 'D181_A_365'], [366, 'ACIMA_365'], [1200, 'ACIMA_365']];
  test.each(casos)('%i dias de atraso → %s', (dias, faixa) => {
    expect(M.faixaAtraso(rec({ data_vencimento: d(-dias) }), HOJE)).toBe(faixa);
  });
  test('vence hoje e futuro não entram no envelhecimento', () => {
    expect(M.faixaAtraso(rec({ data_vencimento: HOJE }), HOJE)).toBeNull();
    expect(M.faixaAtraso(rec({ data_vencimento: d(3) }), HOJE)).toBeNull();
  });
  test('as faixas somam exatamente o bucket VENCIDO (quantidade e centavos) e UNKNOWN/pagos ficam de fora', () => {
    const ts = casos.map(([dias], i) => rec({ id: 'E' + i, data_vencimento: d(-dias), valor: String(10 + i) + '.00', valor_total: String(10 + i) + '.00' }));
    ts.push(rec({ id: 'PAGO', liquidado: '1', data_liquidacao: d(-2), data_vencimento: d(-50) }), rec({ id: 'UNK', liquidado: '0', data_liquidacao: d(-2), data_vencimento: d(-50) }));
    const r = M.calcularNatureza(ts, 'RECEBER', HOJE);
    const soma = Object.values(r.envelhecimento_vencidos).reduce((a, x) => ({ q: a.q + x.quantidade, c: a.c + x.total_cents }), { q: 0, c: 0 });
    expect(soma).toEqual({ q: r.buckets.VENCIDO.quantidade, c: r.buckets.VENCIDO.total_cents });
    expect(r.contagem_status.UNKNOWN).toBe(1);
    expect(Object.keys(r.envelhecimento_vencidos)).toEqual(M.FAIXAS_ATRASO.map(f => f[0]));
  });
  test('título parcial não é provável: todo título é integral; nenhuma classificação de cliente', () => {
    const r = M.calcularNatureza([rec({ data_vencimento: d(-400) })], 'RECEBER', HOJE);
    expect(JSON.stringify(r)).not.toMatch(/inadimplente|mau pagador|score|risco/i);
  });
});

describe('janelas e fuso', () => {
  test('janela de 3 dias inclui hoje, exclui vencidos e o 4º dia', () => {
    const ts = [-1, 0, 1, 3, 4, 7].map((n, i) => pag({ id: 'J' + i, data_vencimento: d(n) }));
    const r = M.calcularNatureza(ts, 'PAGAR', HOJE);
    expect(r.janelas.A_VENCER_ATE_3D.ids.sort()).toEqual(['J1', 'J2', 'J3']);
    expect(r.janelas.A_VENCER_ATE_7D.ids).toHaveLength(5);
  });
  test('"hoje" comercial é o de Fortaleza: 02:59Z ainda é o dia anterior; 03:00Z vira o dia (incl. virada de ano)', () => {
    expect(C.dataComercial(new Date('2026-10-01T02:59:59Z'))).toBe('2026-09-30');
    expect(C.dataComercial(new Date('2026-10-01T03:00:00Z'))).toBe('2026-10-01');
    expect(C.dataComercial(new Date('2027-01-01T02:59:59Z'))).toBe('2026-12-31');
    expect(C.dataComercial(new Date('2024-03-01T02:59:59Z'))).toBe('2024-02-29');
  });
  test('vencimento = hoje é DUE_TODAY (não vencido) em qualquer fuso da máquina', () => {
    expect(M.status(pag({ data_vencimento: HOJE }), HOJE).status).toBe('DUE_TODAY');
    expect(M.status(pag({ data_vencimento: d(-1) }), HOJE).status).toBe('OVERDUE');
  });
});

describe('baixa e UNKNOWN', () => {
  test('liquidado com data de liquidação FUTURA → UNKNOWN(DATA_LIQUIDACAO_FUTURA); hoje e passado seguem SETTLED', () => {
    expect(M.status(rec({ liquidado: '1', data_liquidacao: d(1) }), HOJE)).toEqual({ status: 'UNKNOWN', motivo: 'DATA_LIQUIDACAO_FUTURA' });
    expect(M.status(rec({ liquidado: '1', data_liquidacao: HOJE }), HOJE).status).toBe('SETTLED');
    expect(M.status(rec({ liquidado: '1', data_liquidacao: d(-400) }), HOJE).status).toBe('SETTLED');
  });
  test('contradições preservadas como UNKNOWN: aberto com data de baixa, liquidado sem data, valor negativo', () => {
    expect(M.status(pag({ liquidado: '0', data_liquidacao: d(-3) }), HOJE).motivo).toBe('ABERTO_COM_DATA_LIQUIDACAO');
    expect(M.status(pag({ liquidado: '1', data_liquidacao: '' }), HOJE).motivo).toBe('LIQUIDADO_SEM_DATA');
    expect(M.status(pag({ valor_total: '-5.00' }), HOJE).motivo).toBe('VALOR_FINAL_NEGATIVO');
  });
  test('diferença de R$ 0,01 entre valor_total e a fórmula (arredondamento de taxas do ERP) não muda o status nem o total usado', () => {
    const t = rec({ liquidado: '1', data_liquidacao: d(-1), valor: '100.00', taxa_operadora: '2.335', valor_total: '97.66' });
    expect(M.status(t, HOJE).status).toBe('SETTLED'); expect(t.final_amount_cents).toBe(9766);
  });
});

describe('vínculo pagar → compra (determinístico; heurística nunca confirma)', () => {
  const compras = { 100: [{ id: 'C100', codigo: '100', fornecedor_id: 'FORN1' }], 200: [{ id: 'C200', codigo: '200', fornecedor_id: 'FORN2' }], 300: [{ id: 'C300a', codigo: '300', fornecedor_id: 'FORN1' }, { id: 'C300b', codigo: '300', fornecedor_id: 'FORN1' }] };
  test('confirmado: texto exato + compra única + mesmo fornecedor', () => {
    expect(M.vincularCompra(pag({ descricao: 'Compra de nº 100', fornecedor_id: 'FORN1' }), compras)).toEqual({ estado: 'CONFIRMADO', codigo: '100', compra_id: 'C100' });
  });
  test.each([
    ['Compra de nº 200', { fornecedor_id: 'FORN1' }, 'CONFLITO_FORNECEDOR'],
    ['Compra de nº 999', { fornecedor_id: 'FORN1' }, 'NAO_RESOLVIDO'],
    ['Compra de nº 300', { fornecedor_id: 'FORN1' }, 'CODIGO_DUPLICADO'],
    ['Compra de nº 100', { entidade: 'O', fornecedor_id: '' }, 'FORNECEDOR_AUSENTE'],
    ['Devolução de nº 100', { fornecedor_id: 'FORN1' }, 'DEVOLUCAO_OUTRA_REFERENCIA'],
    ['Salário Fulano', { entidade: 'U', fornecedor_id: '', funcionario_id: 'F1' }, 'SEM_REFERENCIA'],
    ['compra de nº 100', { fornecedor_id: 'FORN1' }, 'SEM_REFERENCIA'],
    ['Compra de nº 100 (parcela 2)', { fornecedor_id: 'FORN1' }, 'SEM_REFERENCIA'],
  ])('%s → %s', (descricao, extra, estado) => { expect(M.vincularCompra(pag({ descricao, ...extra }), compras).estado).toBe(estado); });
  test('mesmo fornecedor + valor igual + data próxima, SEM referência, não vira vínculo', () => {
    expect(M.vincularCompra(pag({ descricao: 'Mercadoria', fornecedor_id: 'FORN1', valor_total: '500.00' }), compras).estado).toBe('SEM_REFERENCIA');
  });
  test('vínculo de venda sem cliente no título (ou cliente nulo dos dois lados) NÃO confirma — só o código não basta', () => {
    expect(M.vincularVenda(rec({ descricao: 'Venda de nº 500', cliente_id: '', nome_cliente: '' }), { 500: [{ id: 'V1', cliente_id: null }] }).estado).toBe('CLIENTE_AUSENTE');
  });
  test('vínculo de venda (recebível) continua exato: cliente diferente → conflito', () => {
    expect(M.vincularVenda(rec({ descricao: 'Venda de nº 500', cliente_id: 'CLI1' }), { 500: { id: 'V1', cliente_id: 'CLI2' } }).estado).toBe('CONFLITO_CLIENTE');
  });
});

describe('geração: sem caixa/saldo, privacidade e determinismo', () => {
  const brutosP = [titulo({ id: 'A', data_vencimento: d(-10) }), titulo({ id: 'B', data_vencimento: d(2), nome_fornecedor: 'Fornecedor Fictício Um' })];
  const brutosR = [receber({ id: 'R1', data_vencimento: d(-40), nome_cliente: 'Cliente Fictício Um' }), receber({ id: 'R2', data_vencimento: d(5) })];
  const agora = new Date('2026-09-28T15:00:00Z');
  const canon = (ps, rs) => [...ps.map(b => C.mapearTitulo(b, 'PAGAR', refs)), ...rs.map(b => C.mapearTitulo(b, 'RECEBER', refs))];
  const monta = (ps = brutosP, rs = brutosR) => A.construirGeracao({ canon: canon(ps, rs), agora, geracao: 'gTeste', hoje: HOJE });
  test('resumo não traz nomes de pessoas/empresas nem IDs de título; traz envelhecimento e janela de 3 dias', () => {
    const s = monta(); const txt = JSON.stringify(s.resumo);
    expect(txt).not.toMatch(/Fictício|nome_fornecedor|nome_cliente/); expect(txt).not.toContain('"R1"');
    expect(s.resumo.receber.envelhecimento.D31_A_60.n).toBe(1);
    expect(s.resumo.pagar.prox_3d.n).toBe(1);
  });
  test('saldo bancário, caixa disponível e capacidade de compra continuam BLOQUEADOS e não existem como números', () => {
    const s = monta();
    for (const k of ['SALDO_BANCARIO', 'CAIXA_REAL', 'CAPACIDADE_DE_COMPRA', 'PROJECAO_DE_CAIXA']) expect(s.resumo.metricas_bloqueadas).toContain(k);
    expect(s.resumo.bankBalance.available).toBe(false); expect(s.resumo.purchaseCapacity.status).toBe('BLOCKED');
    expect(JSON.stringify(s.resumo)).not.toMatch(/"(saldo|caixa_disponivel|capacidade_de_compra|free_cash|runway)[a-z_]*"\s*:\s*-?\d/i);
  });
  test('mesmo insumo → mesmo resultado (determinístico, independe da ordem de entrada)', () => {
    const a = JSON.stringify(monta().resumo), b = JSON.stringify(monta([...brutosP].reverse(), [...brutosR].reverse()).resumo);
    expect(b).toBe(a);
  });
  test('cliente GestãoClick: só GET, só hosts/recursos permitidos', async () => {
    const F = require('../lib/financeiro/fetch');
    const cli = F.criarClienteGC({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), accessToken: 'x', secretToken: 'y', pausaMs: 0 });
    await expect(cli.get('/pagamentos', { method: 'POST' })).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('/contas_bancarias')).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('/pagamentos?limite=1')).resolves.toBeDefined();
  });
  test('nenhum arquivo do Financeiro expõe chave do ERP nem fala com GestãoClick fora de fetch.js', () => {
    const dir = path.join(__dirname, '../lib/financeiro');
    for (const f of fs.readdirSync(dir)) { const src = fs.readFileSync(path.join(dir, f), 'utf8'); if (f !== 'fetch.js') expect(src).not.toMatch(/api\.gestaoclick|access-token/i); expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i); }
    expect(fs.readFileSync(path.join(__dirname, '../../modulos/financeiro.html'), 'utf8')).not.toMatch(/api\.gestaoclick|access-token|secret-access/i);
  });
});
