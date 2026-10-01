'use strict';
// Agente de Estoque — MOTOR determinístico (sem IA, sem emulador). Dados sintéticos passam pelo motor REAL do módulo Compras (montarSnapshot).
const I = require('./fixtures/ai-inventory');
const A = require('../lib/ai/agents/inventory');
const E = require('../lib/ai/agents/inventory/engine');
const { UID, AGORA } = I;

const carregar = async (uid = UID.GER, o = {}) => { const { st, snap } = I.estadoEstoque(o); const db = I.criarDb(st); const ac = await A.autorizar(db, uid); const dados = await A.carregar(db, ac); return { db, ac, dados, snap, st }; };
const porCodigo = (base, cod) => base.itens.find(i => i.codigo === 'COD-' + cod);

describe('classificação por produto (fatos do motor de Compras → sinais)', () => {
  let b; beforeAll(async () => { const c = await carregar(); b = E.analisarBase(c.dados.produtos, c.dados.custos, { verCusto: true }); b.c = c; });
  test('estoque parado: sem venda >=120 dias; borda 119 NÃO, 120 SIM, 121 SIM', () => {
    expect(porCodigo(b, 'PX-D119').sinais).not.toContain('SEM_VENDA_120D'); expect(porCodigo(b, 'PX-D119').fatos.diasSemVenda).toBe(119);
    expect(porCodigo(b, 'PX-D120').sinais).toContain('SEM_VENDA_120D'); expect(porCodigo(b, 'PX-D120').fatos.diasSemVenda).toBe(120);
    expect(porCodigo(b, 'PX-D121').sinais).toContain('SEM_VENDA_120D');
    expect(porCodigo(b, 'PX-SEM120').sinais).toContain('SEM_VENDA_120D'); expect(porCodigo(b, 'PX-SEM90').sinais).not.toContain('SEM_VENDA_120D');
  });
  test('nunca vendido (com confiança) é separado de sem venda; produto novo nunca é parado', () => {
    const z = porCodigo(b, 'PX-ZEROALTO'); expect(z.sinais).toContain('NUNCA_VENDIDO'); expect(z.sinais).not.toContain('SEM_VENDA_120D'); expect(z.fatos.nuncaVendidoConfianca).toBe('ALTA'); expect(z.fatos.diasSemVenda).toBeUndefined();
    expect(porCodigo(b, 'PX-NUNCA-LOW').fatos.nuncaVendidoConfianca).toBe('BAIXA');
    const novo = porCodigo(b, 'PX-NUNCA-REC'); expect(novo.sinais).not.toContain('NUNCA_VENDIDO'); expect(novo.s.parado).toBe(false);
    expect(porCodigo(b, 'PX-NOVO').sinais.filter(s => ['SEM_VENDA_120D', 'NUNCA_VENDIDO', 'CANDIDATO_LIQUIDACAO'].includes(s))).toEqual([]);
  });
  test('aceleração e desaceleração (sinal do motor); excesso; risco de ruptura; ruptura atual; saldo negativo', () => {
    expect(porCodigo(b, 'PX-ACELERA').sinais).toContain('GIRO_ACELERANDO'); expect(porCodigo(b, 'PX-ACELERA').fatos.tendencia).toBe('ACELERANDO');
    expect(porCodigo(b, 'PX-QUEDA').sinais).toContain('GIRO_EM_QUEDA'); expect(porCodigo(b, 'PX-QUEDA').fatos.tendencia).toBe('DESACELERANDO');
    expect(porCodigo(b, 'PX-EXCESSO').sinais).toContain('ESTOQUE_EXCESSIVO'); expect(porCodigo(b, 'PX-EXCESSO').fatos.coberturaDias).toBeGreaterThan(180);
    expect(porCodigo(b, 'PX-FORTE').sinais).toContain('RISCO_RUPTURA'); expect(porCodigo(b, 'PX-BAIXO').sinais).toContain('RISCO_RUPTURA');
    expect(porCodigo(b, 'PX-RUPTURA').sinais).toEqual(expect.arrayContaining(['RUPTURA_ATUAL'])); expect(porCodigo(b, 'PX-NEGATIVO').sinais).toContain('ESTOQUE_NEGATIVO');
    expect(porCodigo(b, 'PX-GIRO').sinais).toContain('GIRO_ALTO');
  });
  test('inativo e kit ficam fora do escopo (contados à parte); curva ABC e giro/cobertura vêm do motor', () => {
    expect(porCodigo(b, 'PX-INATIVO')).toBeUndefined(); expect(porCodigo(b, 'PX-KIT')).toBeUndefined(); expect(b.resumo.fora).toMatchObject({ inativos: 1, kits: 1 });
    const g = porCodigo(b, 'PX-GIRO'); expect(g.fatos.curvaAbc).toBe('A'); expect(g.fatos.giro90d).toBe(Math.round(g.fatos.vendas90d / g.fatos.estoque * 100) / 100);
    const op = b.c.dados.produtos.find(p => p.code === 'COD-PX-GIRO'); expect(g.fatos.coberturaDias).toBe(op.coverage.dias); expect(g.fatos.vendas90d).toBe(op.units['90']);
  });
  test('candidato a liquidação: parado/excesso/nunca-vendido ALTA, maduro, sem aceleração e com estoque', () => {
    expect(porCodigo(b, 'PX-D120').sinais).toContain('CANDIDATO_LIQUIDACAO'); expect(porCodigo(b, 'PX-EXCESSO').sinais).toContain('CANDIDATO_LIQUIDACAO'); expect(porCodigo(b, 'PX-ZEROALTO').sinais).toContain('CANDIDATO_LIQUIDACAO');
    expect(porCodigo(b, 'PX-ACELERA').sinais).not.toContain('CANDIDATO_LIQUIDACAO');   // excesso, mas acelerando
    expect(porCodigo(b, 'PX-NUNCA-LOW').sinais).not.toContain('CANDIDATO_LIQUIDACAO');  // nunca vendido sem confiança
    expect(porCodigo(b, 'PX-D119').sinais).not.toContain('CANDIDATO_LIQUIDACAO'); expect(porCodigo(b, 'PX-FORTE').sinais).not.toContain('CANDIDATO_LIQUIDACAO');
  });
});

describe('capital imobilizado: só com permissão de custo; indicativo; ausente (nunca 0) sem custo', () => {
  test('gestor: capital = estoque × custo cadastrado; confiança do custo; sem custo → ausente', async () => {
    const c = await carregar(); const b = E.analisarBase(c.dados.produtos, c.dados.custos, { verCusto: true });
    const z = porCodigo(b, 'PX-ZEROALTO'); expect(z.fatos.custoUnitario).toBe(10); expect(z.fatos.capitalImobilizado).toBe(5000); expect(z.fatos.confiancaCusto).toBe('BAIXA');   // custo cadastrado ≠ último custo (compra há 400 d)
    expect(porCodigo(b, 'PX-D120').fatos.confiancaCusto).toBe('CONFIAVEL');
    const sc = porCodigo(b, 'PX-SEMCUSTO'); expect(sc.fatos.confiancaCusto).toBe('SEM_CUSTO'); expect(sc.fatos.capitalImobilizado).toBeUndefined(); expect(sc.fatos.custoUnitario).toBeUndefined();
    expect(porCodigo(b, 'PX-RUPTURA').fatos.capitalImobilizado).toBeUndefined();   // estoque 0 → sem capital
    const soma = b.itens.reduce((t, i) => t + (i.fatos.capitalImobilizado || 0), 0); expect(b.resumo.capitalEmEstoque).toBe(soma);
    expect(b.resumo.capitalParado).toBe(b.itens.filter(i => i.s.parado).reduce((t, i) => t + (i.fatos.capitalImobilizado || 0), 0));
    expect(b.resumo.capitalTop10Pct).toBeGreaterThan(0); expect(b.resumo.capitalCustoConfiavelPct).toBeLessThan(100); expect(z.sinais).toContain('CAPITAL_PARADO');
    expect(b.itens.filter(i => i.sinais.includes('CAPITAL_CONCENTRADO')).length).toBe(10);
  });
  test('sem permissão de custo: nada de custo/capital no motor nem no resumo (e nem a leitura da coleção de custos)', async () => {
    const c = await carregar(UID.FUNC); expect(c.ac).toMatchObject({ gestao: false, verCusto: false }); expect(c.dados.custos).toEqual([]);
    const b = E.analisarBase(c.dados.produtos, c.dados.custos, { verCusto: false });
    expect(JSON.stringify(b.itens.map(i => i.fatos))).not.toMatch(/custo|capital/i); expect(Object.keys(b.resumo).filter(k => /capital|custo/i.test(k))).toEqual([]);
    expect(b.itens.some(i => i.sinais.some(s => /CAPITAL/.test(s)))).toBe(false);
    expect(b.itens.length).toBe(E.analisarBase(c.dados.produtos, [], { verCusto: true }).itens.length);   // mesma base
  });
});

describe('resumo determinístico sobre TODA a base (a IA só explica)', () => {
  test('contagens batem com a contagem independente por produto; não dependem dos candidatos', async () => {
    const c = await carregar(); const b = E.analisarBase(c.dados.produtos, c.dados.custos, { verCusto: true }); const R = b.resumo;
    const ativos = c.dados.produtos.filter(p => p.active && p.moves_stock && !p.kit);
    expect(R.produtosAnalisados).toBe(ativos.length);
    expect(R.semVenda120d).toBe(ativos.filter(p => !p.never_sold && !p.new_product && p.raw_stock > 0 && p.days_since_last_sale >= 120).length);
    expect(R.nuncaVendidos).toBe(ativos.filter(p => p.never_sold && !p.new_product && p.raw_stock > 0).length);
    expect(R.estoqueParado).toBe(R.semVenda120d + R.nuncaVendidos);
    expect(R.estoqueExcessivo).toBe(ativos.filter(p => p.coverage.estado === 'COVERAGE_EXCESS').length);
    expect(R.riscoRuptura).toBe(ativos.filter(p => p.raw_stock > 0 && ['COVERAGE_CRITICAL', 'COVERAGE_LOW'].includes(p.coverage.estado)).length);
    expect(R.acelerando).toBe(ativos.filter(p => p.velocity_signal === 'RECENT_ACCELERATION').length); expect(R.desacelerando).toBe(ativos.filter(p => p.velocity_signal === 'RECENT_DECELERATION').length);
    for (const q of ['O que merece atenção?', 'Quais vendem mais rápido?', 'Onde está o capital?']) expect(A.montar(c.dados, c.ac, q, AGORA.toISOString()).resumo).toMatchObject({ semVenda120d: R.semVenda120d, produtosAnalisados: R.produtosAnalisados, estoqueParado: R.estoqueParado });
    expect(E.alertasDoResumo(R).length).toBeGreaterThan(0);
  });
  test('base grande (~900 produtos): resumo conta tudo; candidatos <= 30; seleção determinística', async () => {
    const c = await carregar(UID.GER, { brutos: I.dadosGrandes(900) }); const b = E.analisarBase(c.dados.produtos, c.dados.custos, { verCusto: true });
    expect(b.resumo.produtosAnalisados).toBeGreaterThan(850); expect(b.resumo.semVenda120d).toBeGreaterThan(100);
    const m1 = A.montar(c.dados, c.ac, 'Quais produtos estão parados?', AGORA.toISOString()), m2 = A.montar(c.dados, c.ac, 'Quais produtos estão parados?', AGORA.toISOString());
    expect(Object.keys(m1.contexto.entidades).length).toBeLessThanOrEqual(30); expect(m1.contexto.resumo.semVenda120d).toBe(b.resumo.semVenda120d); expect(JSON.stringify(m1.contexto)).toBe(JSON.stringify(m2.contexto));
    expect(m1.contexto.foco.find(f => f.categoria === 'SEM_VENDA_120D').totalNaBase).toBe(b.resumo.semVenda120d);
    // ordenação por capital (maior primeiro) dentro da lista de sem venda
    const caps = Object.values(m1.contexto.entidades).filter(e => e.sinais.includes('SEM_VENDA_120D')).map(e => e.capitalImobilizado || 0); expect(caps.slice(0, 5)).toEqual([...caps.slice(0, 5)].sort((x, y) => y - x));
  });
});

describe('intenção da pergunta → candidatos; pedidos sem suporte', () => {
  test('chips e perguntas do escopo mapeiam para o foco certo', () => {
    const f = q => E.interpretarPergunta(q).focos;
    expect(f('O que está errado no meu estoque?')).toContain('ATENCAO'); expect(f('Quais produtos estão parados?')).toContain('PARADOS'); expect(f('Quanto dinheiro tenho em produtos sem giro?')).toEqual(expect.arrayContaining(['CAPITAL', 'PARADOS']));
    expect(f('Quais não vendem há +120 dias?')).toContain('SEM_VENDA_120D'); expect(f('Quais nunca venderam?')).toContain('NUNCA_VENDIDO'); expect(f('Onde há estoque excessivo?')).toContain('EXCESSO'); expect(f('Quais estão perto de faltar?')).toContain('RUPTURA');
    expect(f('Quais vendem mais rápido?')).toContain('RAPIDOS'); expect(f('Quais estão perdendo giro?')).toContain('QUEDA'); expect(f('Onde está concentrado meu capital?')).toContain('CAPITAL'); expect(f('Quais eu deveria tentar liquidar?')).toContain('LIQUIDAR'); expect(f('O que merece atenção hoje?')).toContain('ATENCAO');
    expect(f('bla bla')).toEqual(['ATENCAO']);
  });
  test('previsão / preço / margem / lead time / histórico de saldo → pedidoNaoSuportado no contexto', async () => {
    const c = await carregar(); const n = q => A.montar(c.dados, c.ac, q, AGORA.toISOString()).contexto.pedidoNaoSuportado;
    expect(n('Qual produto vai vender amanhã?')).toEqual(['PREVISAO_DE_DEMANDA']); expect(n('Quanto vou vender no próximo mês?')).toContain('PREVISAO_DE_DEMANDA'); expect(n('Qual a margem do produto?')).toContain('PRECO_OU_MARGEM');
    expect(n('Qual o lead time do fornecedor?')).toContain('LEAD_TIME_OU_FORNECEDOR'); expect(n('Qual era o saldo ontem? histórico de saldo')).toContain('HISTORICO_DE_SALDO'); expect(n('Quais estão parados?')).toBeUndefined();
  });
  test('sem permissão de custo a pergunta de capital não lista a categoria CAPITAL (só parados/excesso)', async () => {
    const c = await carregar(UID.FUNC); const m = A.montar(c.dados, c.ac, 'Onde está concentrado meu capital?', AGORA.toISOString()); expect(m.contexto.foco.map(f => f.categoria)).not.toContain('CAPITAL');
  });
});

describe('frescor da fonte', () => {
  test('sourceUpdatedAt vem do meta do sync; desatualizado por regra (> 6 h) ou ausente', async () => {
    const c = await carregar(); const fr = h => A.montar(c.dados, c.ac, 'x', new Date(AGORA.getTime() + h * 3600000).toISOString()).frescor;
    expect(fr(0)).toMatchObject({ sourceUpdatedAt: '2026-09-28T15:00:00.000Z', desatualizado: false }); expect(fr(6).desatualizado).toBe(false); expect(fr(6.5).desatualizado).toBe(true);
    expect(A.frescorDe({ meta: null, resumoDoc: null }, AGORA.toISOString())).toMatchObject({ sourceUpdatedAt: null, desatualizado: true });
  });
});
