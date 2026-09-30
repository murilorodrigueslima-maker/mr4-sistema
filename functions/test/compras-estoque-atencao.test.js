'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase D.1: aba ATENÇÃO completa na visão da tela (compras_n0_view/sugestoes).
// Só visibilidade: a decisão de compra (Política 1.1) não pode mudar. Fixtures 100% sintéticas.
const path = require('path');
const S = require('../lib/compras/snapshot');
const Pol = require('../lib/compras/politica');
const X = require('./fixtures/compras-estoque-f0');
const OLD = path.join(__dirname, 'fixtures', 'compras-view-fase-d-golden.json');

const gerar = c => S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: X.AGORA, politica: Pol.POLITICA_1_1 });   // golden da Fase D = Política 1.1
const snapA = gerar(X.cenario()), snapN = gerar(X.cenarioProdutoNovo());
const linhas = s => s.view.sugestoes.linhas;
const L = (s, id) => linhas(s).find(l => l.id === id);
const soAtencao = s => linhas(s).filter(l => !(l.qtd > 0) && l.attention_reasons.some(k => !S.ATENCAO_ANOTACAO.includes(k)));

describe('ATENÇÃO — categorias (só sinais que o motor prova)', () => {
  test('1. NEVER_SOLD: sem última venda inventada e separado das faixas sem venda', () => {
    for (const id of ['PX-ZEROALTO', 'PX-NUNCA-LOW', 'PX-NUNCA-ANTIGO', 'PX-SOCANCEL']) {
      const l = L(snapA, id);
      expect(l.attention_reasons).toContain('NEVER_SOLD');
      expect(l.attention_reasons.some(k => k.startsWith('NO_SALE_'))).toBe(false);
      expect(l.ultima_venda).toBeUndefined();
      expect(l.qtd).toBe(0);
    }
    // o motor marca faixa de parado para nunca vendido antigo; a visão NÃO repete isso como "sem venda há X dias"
    const m = snapA.operacional.find(x => x.product_id === 'PX-NUNCA-ANTIGO');
    expect(m.never_sold).toBe(true); expect(m.last_sale_date).toBeNull();
  });
  test('2–4. NO_SALE_120D / 180D / 365D: uma única faixa, a mais forte', () => {
    expect(L(snapA, 'PX-SEM120').attention_reasons).toEqual(['NO_SALE_120D']);
    expect(L(snapA, 'PX-SEM180').attention_reasons).toEqual(['NO_SALE_180D']);
    expect(L(snapA, 'PX-SEM365').attention_reasons.filter(k => k.startsWith('NO_SALE_'))).toEqual(['NO_SALE_365D']);
    for (const l of linhas(snapA)) expect(l.attention_reasons.filter(k => k.startsWith('NO_SALE_')).length).toBeLessThanOrEqual(1);
    // abaixo de 120 dias sem venda não entra
    expect(L(snapA, 'PX-SEM90')).toBeUndefined();
    // precedência direta
    const base = { raw_stock: 5, never_sold: false, coverage: { estado: 'NO_DEMAND_OBSERVED' }, active: true, new_product: false, cost_confidence: 'KNOWN_COST' };
    expect(S.motivosAtencao({ ...base, reason_codes: ['NO_SALE_120D', 'NO_SALE_180D', 'NO_SALE_365D'] })).toEqual(['NO_SALE_365D']);
    expect(S.motivosAtencao({ ...base, reason_codes: ['NO_SALE_120D', 'NO_SALE_180D'] })).toEqual(['NO_SALE_180D']);
    expect(S.motivosAtencao({ ...base, never_sold: true, reason_codes: ['NO_SALE_365D'] })).toEqual(['NEVER_SOLD']);
  });
  test('5. EXCESS_COVERAGE: cobertura > limite da política e só com velocidade > 0', () => {
    const lim = Pol.POLITICA_1_1.coverage_indicators.excess_above_days;
    const l = L(snapA, 'PX-EXCESSO');
    expect(l.attention_reasons).toContain('EXCESS_COVERAGE'); expect(l.cobertura_dias).toBeGreaterThan(lim); expect(l.qtd).toBe(0);
    for (const m of [...snapA.operacional, ...snapN.operacional]) if (S.motivosAtencao(m).includes('EXCESS_COVERAGE')) { expect(m.policy_velocity).toBeGreaterThan(0); expect(m.coverage.dias).toBeGreaterThan(lim); }
    // nunca vendido (sem demanda) não recebe cobertura fictícia
    for (const id of ['PX-ZEROALTO', 'PX-NUNCA-ANTIGO']) expect(L(snapA, id).attention_reasons).not.toContain('EXCESS_COVERAGE');
  });
  test('6. INACTIVE_PRODUCT: aparece e continua sem sugestão (mesmo com demanda e ruptura)', () => {
    const l = L(snapA, 'PX-INATIVO');
    expect(l.attention_reasons).toContain('INACTIVE_PRODUCT'); expect(l.qtd).toBe(0); expect(l.sem_sugestao_por).toContain('INACTIVE_PRODUCT');
  });
  test('7. produto novo NÃO elegível: NEW_PRODUCT_PROTECTED e suggested_qty 0 (7 dias / 5 un / 3 dias intactos)', () => {
    for (const id of ['NV-SEM', 'NV-UMA', 'NV-DIA1', 'NV-DOIS', 'NV-CANC', 'NV-I6', 'NV-INAT']) {
      const l = L(snapN, id);
      expect(l.attention_reasons).toContain('NEW_PRODUCT_PROTECTED'); expect(l.qtd).toBe(0); expect(l.prioridade).toBeNull();
    }
    const r = Pol.POLITICA_1_1.new_product.proven_demand;
    expect([r.minimum_age_days, r.minimum_units, r.minimum_distinct_sale_days, r.require_active]).toEqual([7, 5, 3, true]);
  });
  test('8. produto novo ELEGÍVEL continua na sugestão normal (sem NEW_PRODUCT_PROTECTED)', () => {
    for (const id of ['NV-TRES', 'NV-I7', 'NV-POS', 'NV-NEG']) {
      const l = L(snapN, id);
      expect(l.qtd).toBeGreaterThan(0); expect(l.novo_com_demanda).toBe(true); expect(l.attention_reasons).not.toContain('NEW_PRODUCT_PROTECTED');
    }
  });
  test('NO_COST / LOW_COST_CONFIDENCE: rótulos; LOW_COST_CONFIDENCE sozinho não coloca produto na aba', () => {
    expect(L(snapA, 'PX-SEMCUSTO').attention_reasons).toContain('NO_COST');
    const base = { raw_stock: 5, never_sold: false, coverage: { estado: 'COVERAGE_OK' }, active: true, new_product: false, reason_codes: [] };
    expect(S.motivosAtencao({ ...base, cost_confidence: 'LOW_CONFIDENCE_COST' })).toEqual(['LOW_COST_CONFIDENCE']);
    for (const l of soAtencao(snapA)) expect(l.attention_reasons.some(k => k !== 'LOW_COST_CONFIDENCE')).toBe(true);
    const soBaixa = snapA.operacional.filter(m => { const r = S.motivosAtencao(m); return r.length === 1 && r[0] === 'LOW_COST_CONFIDENCE' && !(m.suggestion.suggested_qty > 0) && !(m.raw_stock < 0) && !m.new_product; });
    for (const m of soBaixa) expect(L(snapA, m.product_id)).toBeUndefined();
  });
});

describe('ATENÇÃO — estrutura, segurança e tamanho', () => {
  test('9. vários motivos → UMA linha com attention_reasons[] (sem duplicar produto)', () => {
    for (const s of [snapA, snapN]) { const ids = linhas(s).map(l => l.id); expect(new Set(ids).size).toBe(ids.length); }
    expect(L(snapA, 'PX-NUNCA-REC').attention_reasons).toEqual(['NEVER_SOLD', 'NEW_PRODUCT_PROTECTED']);
    expect(L(snapN, 'NV-INAT').attention_reasons).toEqual(expect.arrayContaining(['INACTIVE_PRODUCT', 'NEW_PRODUCT_PROTECTED']));
    expect(L(snapN, 'MA').attention_reasons).toEqual(['EXCESS_COVERAGE', 'LOW_COST_CONFIDENCE']);
    const c = snapA.view.sugestoes.contagens.atencao;
    expect(c.produtos).toBe(soAtencao(snapA).length);
    for (const k of S.ATENCAO_MOTIVOS) expect(c.por_motivo[k]).toBe(soAtencao(snapA).filter(l => l.attention_reasons.includes(k)).length);
  });
  test('10. itens só de Atenção têm qtd 0 e sem prioridade; a Atenção nunca cria sugestão', () => {
    for (const s of [snapA, snapN]) for (const l of soAtencao(s)) {
      expect(l.qtd).toBe(0); expect(l.prioridade).toBeNull();
      const m = s.operacional.find(x => x.product_id === l.id); expect(m.suggestion.suggested_qty).toBe(0);
    }
    for (const s of [snapA, snapN]) expect(s.view.sugestoes.contagens.sugeridos).toBe(s.resumo.resumo_politica.TOTAL_SUGGESTED_PRODUCTS);
  });
  test('11. custos não vazam: nenhuma chave/valor de custo na visão operacional; custos não crescem com a Atenção', () => {
    for (const s of [snapA, snapN]) {
      // todas as CHAVES do documento (recursivo) — nomes de produto sintéticos como "PX-SEMCUSTO" não contam
      const chaves = []; const andar = v => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) chaves.push(k); andar(x); } };
      andar(s.view.sugestoes);
      // rótulos de categoria (NO_COST / LOW_COST_CONFIDENCE) são contagens, não valores de custo
      expect(chaves.filter(k => !S.ATENCAO_MOTIVOS.includes(k) && /cost|custo|cents|preco|price|valor/i.test(k))).toEqual([]);
      for (const l of linhas(s)) expect(Object.keys(l).filter(k => /cost|custo|cents|preco|price|valor/i.test(k))).toEqual([]);
      const idsSug = s.operacional.filter(m => m.suggestion.suggested_qty > 0 || m.raw_stock < 0 || m.new_product).map(m => m.product_id).sort();
      expect(Object.keys(s.view.custos.linhas).sort()).toEqual(idsSug);
      for (const l of soAtencao(s)) if (!idsSug.includes(l.id)) expect(s.view.custos.linhas[l.id]).toBeUndefined();
    }
  });
  test('12. visão compacta: linha só-Atenção sem fornecedor/velocidade/alvo; 877 produtos todos em Atenção < 400 KB e sem histórico bruto', () => {
    const l = L(snapA, 'PX-SEM180');
    for (const k of ['fornecedor', 'velocidade', 'alvo_dias', 'abc_unidades', 'disponivel', 'motivos']) expect(l).not.toHaveProperty(k);
    const ps = Array.from({ length: 877 }, (_, i) => X.produto('PZ-' + i, { estoque: 50 + (i % 9), cadastrado_em: '2021-01-01 10:00:00' }));
    const cs = Array.from({ length: 110 }, (_, i) => X.compra(X.dia(500), Array.from({ length: 8 }, (_, j) => ['PZ-' + ((i * 8 + j) % 877), 60, 10]), { id: 'CZ-' + i }));
    const vs = Array.from({ length: 877 }, (_, i) => X.venda(X.dia(130 + (i % 300)), [['PZ-' + i, 1, 25]], { id: 'VZ-' + i }));
    const sn = S.montarSnapshot({ brutosProdutos: ps, brutosVendas: vs, brutosCompras: cs, agora: X.AGORA });
    expect(sn.view.sugestoes.contagens.atencao.produtos).toBe(877);
    const txt = JSON.stringify(sn.view.sugestoes);
    expect(Buffer.byteLength(txt)).toBeLessThan(400 * 1024);
    expect(txt).not.toMatch(/VZ-|CZ-|registros_json|cliente/);
  });
  test('13. Política 1.1 não muda: decisão de compra idêntica à da Fase D (mesma entrada)', () => {
    const golden = require(OLD);
    for (const [nome, s] of [['cenario', snapA], ['cenarioProdutoNovo', snapN]]) {
      const atual = Object.fromEntries(s.operacional.map(m => [m.product_id, [m.purchase_eligible, m.suggestion.suggested_qty, m.suggestion.priority, m.policy_velocity, m.abc_revenue, !!(m.new_product_proven_demand && m.new_product_proven_demand.accepted)]]));
      expect(atual).toEqual(golden[nome].decisao);
      const semAt = s.view.sugestoes.linhas.filter(l => golden[nome].linhas_fase_d[l.id]).map(l => { const { attention_reasons, ...x } = l; return [l.id, x]; });
      expect(Object.fromEntries(semAt)).toEqual(golden[nome].linhas_fase_d);
      expect(s.view.custos.linhas).toEqual(golden[nome].custos);
    }
    expect(Pol.POLITICA_1_1.policy_version).toBe('1.1');   // a 1.1 segue intacta (a vigente agora é a 1.2, que herda seus parâmetros)
    expect(Pol.POLITICA_1_1.target_days).toEqual({ A: 30, B: 21, C: 15 });
  });
});
