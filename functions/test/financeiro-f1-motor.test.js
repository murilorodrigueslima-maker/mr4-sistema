'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · motor Nível 1 com fixtures sintéticas.
const C = require('../lib/financeiro/canonico');
const M = require('../lib/financeiro/motor');
const { HOJE, FORMAS, titulo, receber } = require('./fixtures/financeiro-f1');
const refs = { formasPorId: FORMAS };
const pag = o => C.mapearTitulo(titulo(o), 'PAGAR', refs);
const rec = o => C.mapearTitulo(receber(o), 'RECEBER', refs);
const d = n => C.somarDias(HOJE, n);

describe('Modelo canônico', () => {
  test('mapeia campos reais → canônico, dinheiro em centavos, taxas separadas e somadas', () => {
    const t = pag({ valor: '1000.00', juros: '12.34', desconto: '2.00', taxa_banco: '1.99', taxa_operadora: '7.91', valor_total: '1000.44' });
    expect(t).toMatchObject({ original_amount_cents: 100000, interest_cents: 1234, discount_cents: 200, bank_fee_cents: 199, operator_fee_cents: 791, fees_cents: 990, final_amount_cents: 100044, entity_type: 'FORNECEDOR', entity_id: 'FORN1', issue_date: null });
    expect(t.original_amount_cents + t.interest_cents - t.discount_cents - t.fees_cents).toBe(t.final_amount_cents);
  });
  test('entidade: C cliente, U funcionário, O outros (sem id), ausente', () => {
    expect(rec({}).entity_type).toBe('CLIENTE');
    expect(pag({ entidade: 'U', fornecedor_id: '', funcionario_id: 'FUNC9', nome_funcionario: 'Func Teste' })).toMatchObject({ entity_type: 'FUNCIONARIO', entity_id: 'FUNC9' });
    expect(pag({ entidade: 'O', fornecedor_id: '' })).toMatchObject({ entity_type: 'OUTROS', entity_id: null });
    expect(pag({ entidade: '' }).entity_type).toBe('AUSENTE');
  });
  test('datas inválidas → null (nada inventado)', () => {
    expect(C.parseData('2026-02-30')).toBeNull();
    expect(C.parseData('30/09/2026')).toBeNull();
    expect(C.parseData('0000-00-00')).toBeNull();
    expect(C.parseData('2026-09-28 10:00:00')).toBe('2026-09-28');
  });
  test('valores inválidos → null; arredondamento determinístico', () => {
    expect(C.centavos('abc')).toBeNull(); expect(C.centavos('')).toBeNull();
    expect(C.centavos('0.1')).toBe(10); expect(C.centavos('12.345')).toBe(1235); expect(C.centavos(-5)).toBe(-500);
  });
});

describe('Formas de pagamento (RAW preservado; ambiguidade explícita)', () => {
  test('tipo GC → normalizada; "boleto Inter/Pix" = AMBIGUOUS (não vira Pix)', () => {
    expect(pag({ forma_pagamento_id: 'f_pix', nome_forma_pagamento: 'Pix' }).payment_method).toMatchObject({ raw_name: 'Pix', normalized: 'PIX', ambiguous: false });
    expect(pag({ forma_pagamento_id: 'f_bolpix', nome_forma_pagamento: 'boleto Inter/Pix' }).payment_method).toMatchObject({ raw_name: 'boleto Inter/Pix', tipo_gc: 'BB', normalized: 'AMBIGUOUS', ambiguous: true });
    expect(pag({ forma_pagamento_id: 'f_cc', nome_forma_pagamento: 'Cartão de Crédito' }).payment_method.normalized).toBe('CARTAO_CREDITO');
    expect(pag({ forma_pagamento_id: 'desconhecida', nome_forma_pagamento: 'Forma nova' }).payment_method.normalized).toBe('UNKNOWN');
    expect(pag({ forma_pagamento_id: '', nome_forma_pagamento: '' }).payment_method.normalized).toBe('MISSING');
  });
});

describe('Status determinístico', () => {
  test('OVERDUE / DUE_TODAY / FUTURE / SETTLED', () => {
    expect(M.status(pag({ data_vencimento: d(-1) }), HOJE).status).toBe('OVERDUE');
    expect(M.status(pag({ data_vencimento: HOJE }), HOJE).status).toBe('DUE_TODAY');
    expect(M.status(pag({ data_vencimento: d(1) }), HOJE).status).toBe('FUTURE');
    expect(M.status(pag({ liquidado: '1', data_liquidacao: d(-2), data_vencimento: d(-10) }), HOJE).status).toBe('SETTLED');
  });
  test('contradições e ausências → UNKNOWN com motivo (nunca inventa)', () => {
    expect(M.status(pag({ liquidado: '1', data_liquidacao: '' }), HOJE)).toEqual({ status: 'UNKNOWN', motivo: 'LIQUIDADO_SEM_DATA' });
    expect(M.status(pag({ liquidado: '0', data_liquidacao: d(-1) }), HOJE)).toEqual({ status: 'UNKNOWN', motivo: 'ABERTO_COM_DATA_LIQUIDACAO' });
    expect(M.status(pag({ data_vencimento: '2026-13-01' }), HOJE)).toEqual({ status: 'UNKNOWN', motivo: 'VENCIMENTO_INVALIDO' });
    expect(M.status(pag({ valor_total: 'x' }), HOJE)).toEqual({ status: 'UNKNOWN', motivo: 'VALOR_FINAL_INVALIDO' });
    expect(M.status(pag({ liquidado: 'talvez' }), HOJE)).toEqual({ status: 'UNKNOWN', motivo: 'FLAG_LIQUIDADO_INVALIDA' });
  });
});

describe('Buckets e janelas (contas a pagar)', () => {
  const ts = [
    pag({ id: 'V90', data_vencimento: d(-90), valor_total: '900.00' }),       // vencido > 60 dias
    pag({ id: 'V1', data_vencimento: d(-1), valor_total: '10.00' }),
    pag({ id: 'H0', data_vencimento: HOJE, valor_total: '20.00' }),
    pag({ id: 'A1', data_vencimento: d(1), valor_total: '30.00' }),
    pag({ id: 'D7', data_vencimento: d(7), valor_total: '40.00' }),
    pag({ id: 'D15', data_vencimento: d(15), valor_total: '50.00' }),
    pag({ id: 'D30', data_vencimento: d(30), valor_total: '60.00' }),
    pag({ id: 'D31', data_vencimento: d(31), valor_total: '70.00' }),
    pag({ id: 'L', liquidado: '1', data_liquidacao: HOJE, data_vencimento: d(-3), valor_total: '5.00' }),
    pag({ id: 'X', liquidado: '1', data_liquidacao: '' }),                     // contraditório
  ];
  const r = M.calcularNatureza(ts, 'PAGAR', HOJE);
  test('cada título aberto em exatamente um bucket exclusivo (soma = abertos)', () => {
    expect(r.buckets.VENCIDO.ids.sort()).toEqual(['V1', 'V90']);
    expect(r.buckets.HOJE.ids).toEqual(['H0']);
    expect(r.buckets.AMANHA.ids).toEqual(['A1']);
    expect(r.buckets.D2_A_7.ids).toEqual(['D7']);
    expect(r.buckets.D8_A_15.ids).toEqual(['D15']);
    expect(r.buckets.D16_A_30.ids).toEqual(['D30']);
    expect(r.buckets.ACIMA_30.ids).toEqual(['D31']);
    const soma = Object.values(r.buckets).reduce((s, b) => s + b.total_cents, 0);
    expect(soma).toBe(r.abertos.total_cents);
    expect(Object.values(r.buckets).reduce((s, b) => s + b.quantidade, 0)).toBe(r.abertos.quantidade);
  });
  test('janelas acumuladas NÃO incluem vencidos e incluem hoje', () => {
    expect(r.janelas.A_VENCER_ATE_7D.ids.sort()).toEqual(['A1', 'D7', 'H0']);
    expect(r.janelas.A_VENCER_ATE_15D.ids.sort()).toEqual(['A1', 'D15', 'D7', 'H0']);
    expect(r.janelas.A_VENCER_ATE_30D.ids.sort()).toEqual(['A1', 'D15', 'D30', 'D7', 'H0']);
  });
  test('vencido há mais de 60 dias aparece (não some com a janela antiga)', () => {
    expect(r.vencido_mais_60d.ids).toEqual(['V90']);
  });
  test('liquidado é realizado, separado de previsto; contraditório vai para UNKNOWN', () => {
    expect(r.liquidado.HOJE.ids).toEqual(['L']);
    expect(r.abertos.ids).not.toContain('L');
    expect(r.desconhecidos).toEqual([{ id: 'X', motivo: 'LIQUIDADO_SEM_DATA' }]);
    expect(r.contagem_status.UNKNOWN).toBe(1);
  });
  test('maiores pagamentos e auditoria: agregado → IDs', () => {
    expect(r.maiores[0]).toMatchObject({ id: 'V90', total_cents: 90000, status: 'OVERDUE' });
    expect(r.abertos.ids.length).toBe(r.abertos.quantidade);
  });
});

describe('Plano de contas, sem plano, concentração, recorrência', () => {
  test('plano preservado da origem; "SEM_PLANO" explícito', () => {
    const r = M.calcularNatureza([pag({ id: 'a' }), pag({ id: 'b', plano_contas_id: '', nome_plano_conta: '' })], 'PAGAR', HOJE);
    expect(r.por_plano.map(p => p.plano_nome)).toEqual(expect.arrayContaining(['Compras', null]));
    expect(r.por_plano.find(p => p.plano_id === null).aberto.ids).toEqual(['b']);
  });
  test('concentração por entidade (ID) com participação; entidade ausente separada', () => {
    const r = M.calcularNatureza([pag({ id: 'a', valor_total: '300.00' }), pag({ id: 'b', valor_total: '100.00', fornecedor_id: 'FORN2' }), pag({ id: 'c', entidade: 'O', fornecedor_id: '', valor_total: '100.00' })], 'PAGAR', HOJE);
    expect(r.concentracao[0]).toMatchObject({ entity_id: 'FORN1', participacao_pct: 60 });
    expect(r.concentracao.map(x => x.chave)).toContain('SEM_ENTIDADE:OUTROS');
  });
  test('recorrência candidata: mesma entidade + plano em ≥ 3 meses', () => {
    const ts = [pag({ id: 'r1', data_vencimento: '2026-07-10', liquidado: '1', data_liquidacao: '2026-07-10' }), pag({ id: 'r2', data_vencimento: '2026-08-10', liquidado: '1', data_liquidacao: '2026-08-10' }), pag({ id: 'r3', data_vencimento: '2026-09-10' })];
    expect(M.calcularNatureza(ts, 'PAGAR', HOJE).recorrencia_candidata[0]).toMatchObject({ meses_distintos: 3, ids: ['r1', 'r2', 'r3'] });
  });
});

describe('Contas a receber e vínculo com venda', () => {
  test('buckets de recebíveis e "título vencido" sem classificar cliente', () => {
    const r = M.calcularNatureza([rec({ id: 'rv', data_vencimento: d(-5) }), rec({ id: 'rh', data_vencimento: HOJE }), rec({ id: 'rl', liquidado: '1', data_liquidacao: d(-1) })], 'RECEBER', HOJE);
    expect(r.buckets.VENCIDO.ids).toEqual(['rv']);
    expect(r.liquidado.ULTIMOS_7D.ids).toEqual(['rl']);
    expect(Object.keys(r)).not.toContain('inadimplencia');
    expect(r.concentracao[0]).toMatchObject({ entity_type: 'CLIENTE', entity_id: 'CLI1' });
    expect(r.concentracao[0].vencido.ids).toEqual(['rv']);
  });
  test('venda: confirmado só com descrição exata + venda existente + mesmo cliente', () => {
    const vendas = { 5001: { id: 'V1', cliente_id: 'CLI1' }, 5002: { id: 'V2', cliente_id: 'OUTRO' } };
    expect(M.vincularVenda(rec({ descricao: 'Venda de nº 5001' }), vendas)).toMatchObject({ estado: 'CONFIRMADO', venda_id: 'V1' });
    expect(M.vincularVenda(rec({ descricao: 'Venda de nº 5002' }), vendas).estado).toBe('CONFLITO_CLIENTE');
    expect(M.vincularVenda(rec({ descricao: 'Venda de nº 9999' }), vendas).estado).toBe('NAO_RESOLVIDO');
    expect(M.vincularVenda(rec({ descricao: 'Venda 5001 parcial' }), vendas).estado).toBe('SEM_REFERENCIA');
  });
});
