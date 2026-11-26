'use strict';
// FINANCEIRO · indicadores de atraso (a receber): fórmula e denominador explícitos; safra e recebidos após o vencimento só por clique,
// calculados das fatias já publicadas; o que a fonte não informa fica "não disponível". Sem escrita, sem envio, sem consulta nova automática.
const fs = require('fs'), path = require('path'), vm = require('vm');
const V = require('../../modulos/financeiro-view.js');
const A = require('../lib/financeiro/agregados');
const C = require('../lib/financeiro/canonico');
const M = require('../lib/financeiro/motor');
const { FORMAS, receber } = require('./fixtures/financeiro-f1');
const { massa } = require('./fixtures/financeiro-f2');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/financeiro-v2.html'), 'utf8');
const refs = { formasPorId: FORMAS };
const HOJE = '2026-09-28', AGORA = new Date('2026-09-28T15:00:00Z');
const d = n => C.somarDias(HOJE, n);

const gerar = (recebimentos, geracao = 'gI', hoje = HOJE) => A.construirGeracao({ canon: recebimentos.map(b => C.mapearTitulo(b, 'RECEBER', refs)), agora: AGORA, geracao, hoje });
const docsDe = g => { const porId = Object.fromEntries(g.fatias.map(f => [f.id, f.doc])); return V.planoHistorico(g.resumo).map(f => porId[f.id]); };
let seq = 0;
const titulo = (venc, valor, pagoEm) => receber({ id: 'T' + (++seq), codigo: String(seq), valor: valor.toFixed(2), valor_total: valor.toFixed(2), data_vencimento: venc, liquidado: pagoEm ? '1' : '0', data_liquidacao: pagoEm || '' });

// Massa de conta feita à mão (valores em reais; resultado em centavos)
const MANUAL = [
  titulo(d(-1), 100),                 // vencido 1 dia
  titulo(d(-31), 200),                // vencido 31 dias
  titulo(d(-400), 300),               // antigo (> 365): fora da safra de 365 dias
  titulo(d(0), 150),                  // vence hoje: carteira sim, vencido não, safra não
  titulo(d(10), 250),                 // a vencer
  titulo(d(-5), 400, d(-5)),          // pago no dia: não é recuperado
  titulo(d(-10), 500, d(-9)),         // 1 dia após
  titulo(d(-100), 600, d(-50)),       // 50 dias após
  titulo(d(-40), 700, d(-45)),        // antecipado
  titulo(d(-500), 800, d(-20)),       // vencimento antigo recebido agora: recuperado (> 365), fora da safra
  titulo(d(-900), 900, d(-600)),      // baixa fora do detalhe retido: não entra em nada
  receber({ id: 'U1', data_vencimento: d(-3), liquidado: '0', data_liquidacao: d(-1), valor: '999.00', valor_total: '999.00' }),   // requer conferência: fora
];
const gm = gerar(MANUAL);

describe('indicadores do resumo (1, 3, 6) — sem leitura adicional', () => {
  const i = V.modeloIndicadores(gm.resumo);
  test('1: vencido ÷ carteira em aberto (vencidos + hoje + a vencer), em valor e quantidade', () => {
    expect(i.carteira).toEqual({ n: 3, c: 60000, totalN: 5, totalC: 100000, pctN: 60, pctC: 60 });
  });
  test('3: faixas sobre a carteira somam o indicador 1', () => {
    expect(i.faixas.map(f => [f.id, f.aberto.c, f.aberto.pctC])).toEqual([['ate7', 10000, 10], ['de8a30', 0, 0], ['de31a90', 20000, 20], ['de91a365', 0, 0], ['mais365', 30000, 30]]);
    expect(i.faixas.reduce((s, f) => s + f.aberto.c, 0)).toBe(i.carteira.c); expect(i.faixas.every(f => f.aberto.totalC === i.carteira.totalC)).toBe(true);
  });
  test('6: antigos = vencidos há mais de 365 dias, com os dois denominadores', () => {
    expect(i.antigos.vencido).toMatchObject({ n: 1, c: 30000, totalC: 60000, pctC: 50 }); expect(i.antigos.aberto).toMatchObject({ totalC: 100000, pctC: 30 });
  });
  test('5 e 7: não disponíveis, com o motivo e o que falta; nenhum campo numérico', () => {
    for (const k of ['renegociados', 'parciais']) { expect(Object.keys(i[k]).sort()).toEqual(['falta', 'motivo']); expect(JSON.stringify(i[k])).not.toMatch(/\d/); }
  });
  test('base vazia: percentuais "—", sem divisão por zero', () => {
    const v = V.modeloIndicadores(gerar([], 'gE').resumo); expect(v.carteira.pctC).toBeNull(); expect(v.antigos.vencido.pctN).toBeNull(); expect(v.faixas.every(f => f.aberto.pctC === null)).toBe(true);
  });
});

describe('safra (2) e recebidos após o vencimento (4)', () => {
  const h = V.modeloHistorico(gm.resumo, docsDe(gm));
  test('2: sem baixa ÷ tudo que venceu de 1 a 365 dias atrás; hoje, a vencer, antigos e conferência ficam fora', () => {
    expect(h.ok).toBe(true);
    expect(h.safra.periodo).toMatchObject({ de: d(-365), ate: d(-1), n: 2, c: 30000, totalN: 6, totalC: 30000 + 400 * 100 + 500 * 100 + 600 * 100 + 700 * 100 });
    expect(h.safra.periodo.mais30).toMatchObject({ n: 1, c: 20000, totalC: h.safra.periodo.totalC });
  });
  test('2: meses só inteiros dentro do detalhe retido; mês em andamento vai até a véspera', () => {
    const ms = h.safra.meses; expect(ms[0].mes).toBe('2025-10'); expect(ms[ms.length - 1]).toMatchObject({ mes: '2026-09', parcial: true, ate: '2026-09-27' });
    expect(ms).toHaveLength(12); expect(ms.slice(0, -1).every(x => !x.parcial)).toBe(true);
    expect(ms.reduce((s, x) => s + x.totalC, 0)).toBe(h.safra.periodo.totalC);        // nesta massa não há título no mês incompleto do início
    expect(ms.find(x => x.mes === '2026-01')).toMatchObject({ totalC: 0, pctC: null });
  });
  test('2: no dia 1º o mês corrente (sem nada vencido) não aparece', () => {
    const hoje = '2026-10-01', g = gerar([titulo('2026-09-30', 10)], 'g1', hoje), m = V.modeloHistorico(g.resumo, docsDe(g)).safra.meses;
    expect(m[m.length - 1]).toMatchObject({ mes: '2026-09', parcial: false, c: 1000 }); expect(m[0].mes).toBe('2025-10');
  });
  test('4: baixa posterior ao vencimento ÷ todas as baixas retidas; no dia ou antes não é recuperado', () => {
    const r = h.recuperados;
    expect(r.total).toMatchObject({ n: 3, c: 190000, totalN: 5, totalC: 300000, pctC: 63.3, pctN: 60 });
    expect(r.ateVencimento).toMatchObject({ n: 2, c: 110000 });
    expect(r.faixas.filter(f => f.n).map(f => [f.id, f.c])).toEqual([['ate3', 50000], ['de31a90', 60000], ['mais365', 80000]]);
    expect(r.faixas.reduce((s, f) => s + f.c, 0) + r.ateVencimento.c).toBe(r.total.totalC); expect(r.semVencimento).toBe(0);
  });
  test('bordas das faixas de atraso do recebimento são contíguas e exclusivas', () => {
    const dias = [1, 3, 4, 7, 8, 30, 31, 90, 91, 180, 181, 365, 366];
    const g = gerar(dias.map(n => titulo(d(-n - 1), 1, d(-1))), 'gB'), r = V.modeloHistorico(g.resumo, docsDe(g)).recuperados;
    expect(r.faixas.map(f => f.n)).toEqual([2, 2, 2, 2, 2, 2, 1]); expect(r.total.pctN).toBe(100);
  });
  test('massa grande: mesmos números de um cálculo independente sobre os títulos canônicos (motor de status)', () => {
    const mm = massa({ hoje: HOJE, nPagar: 100, nReceber: 3000 }), canon = mm.recebimentos.map(b => C.mapearTitulo(b, 'RECEBER', refs));
    const g = A.construirGeracao({ canon, agora: AGORA, geracao: 'gG', hoje: HOJE }), x = V.modeloHistorico(g.resumo, docsDe(g)); expect(x.ok).toBe(true);
    const st = canon.map(t => ({ t, s: M.status(t, HOJE).status }));
    const ab = st.filter(o => o.s === 'OVERDUE'), pg = st.filter(o => o.s === 'SETTLED' && C.diffDias(o.t.settlement_date, HOJE) <= 365);
    const soma = l => ({ n: l.length, c: l.reduce((s, o) => s + o.t.final_amount_cents, 0) });
    const noPeriodo = (l, de, ate) => l.filter(o => o.t.due_date >= de && o.t.due_date <= ate);
    for (const per of [x.safra.periodo, ...x.safra.meses]) {
      const a = soma(noPeriodo(ab, per.de, per.ate)), p = soma(noPeriodo(pg, per.de, per.ate));
      expect({ n: per.n, c: per.c, totalN: per.totalN, totalC: per.totalC }).toEqual({ n: a.n, c: a.c, totalN: a.n + p.n, totalC: a.c + p.c });
    }
    const atr = soma(pg.filter(o => o.t.settlement_date > o.t.due_date)), tot = soma(pg);
    expect(x.recuperados.total).toMatchObject({ n: atr.n, c: atr.c, totalN: tot.n, totalC: tot.c });
    expect(g.resumo.receber.detalhe.PAGO.fatias).toBeGreaterThan(1);
  });
  test('falha fechada: fatia faltando, de outra geração, repetida ou soma diferente do resumo → nenhum número', () => {
    const docs = docsDe(gm), clone = () => JSON.parse(JSON.stringify(docs));
    const casos = [clone().slice(1), clone().map((x, i) => i ? x : { ...x, geracao: 'outra' }), [docs[0], docs[0]], clone().map(x => x.grupo === 'VENCIDO' ? { ...x, itens: x.itens.slice(1) } : x),
      clone().map(x => x.grupo === 'PAGO' ? { ...x, itens: x.itens.slice(1) } : x), clone().map(x => x.grupo === 'PAGO' ? { ...x, itens: x.itens.map(i => ({ ...i, val: i.val + 1 })) } : x),
      clone().map((x, i) => i ? x : { ...x, natureza: 'PAGAR' }), [undefined, docs[1]]];
    for (const c of casos) { const r = V.modeloHistorico(gm.resumo, c); expect(r.ok).toBe(false); expect(r.safra).toBeUndefined(); expect(r.recuperados).toBeUndefined(); }
  });
  test('plano e custo: só VENCIDO e PAGO a receber; fatia já em memória não conta', () => {
    expect(V.planoHistorico(gm.resumo).map(f => f.id)).toEqual(['gI__RECEBER__VENCIDO__000', 'gI__RECEBER__PAGO__000']);
    const cache = V.criarCacheFatias(); expect(V.custoHistorico(gm.resumo, cache)).toMatchObject({ fatias: 2, pendentes: 2 });
    cache.definir('gI__RECEBER__VENCIDO__000', {}); expect(V.custoHistorico(gm.resumo, cache).pendentes).toBe(1);
  });
});

describe('página: indicadores visíveis, histórico só por clique, sem escrita', () => {
  const script = HTML.slice(HTML.indexOf('<script type="module">'));
  const bloco = HTML.slice(HTML.indexOf('// ── Alertas internos'), HTML.indexOf('function renderGeral()'));
  const carregador = script.slice(script.indexOf('// ── safra e recebidos após o vencimento'), script.indexOf('// ── fornecedores / clientes'));
  function montar(g, { falha = false } = {}) {
    const porId = Object.fromEntries(g.fatias.map(f => [f.id, f.doc])), lidas = [];
    const S = { resumo: g.resumo, entidades: null, entErro: null, aba: 'geral', hist: null, cache: V.criarCacheFatias(), filtro: {}, crit: {} };
    let redesenhos = 0;
    const ctx = { S, V: { ...V, dataComercial: () => HOJE }, esc: V.esc, tag: (t, tom) => `<span class="tag ${V.esc(tom)}">${V.esc(t)}</span>`, render: () => { redesenhos++; },
      lerFatia: id => S.cache.ler(id, async i => { lidas.push(i); if (falha) throw new Error('permission-denied'); return porId[i]; }) };
    vm.createContext(ctx); vm.runInContext(bloco + '\n' + carregador + '\nthis.blocoAlertas = blocoAlertas; this.carregarHistorico = carregarHistorico;', ctx);
    return { ctx, S, lidas, redesenhos: () => redesenhos };
  }
  const limpo = h => { expect(h).not.toMatch(/undefined|NaN|Infinity|\[object/); return h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); };

  test('antes do clique: os 7 indicadores com fórmula e denominador; 2 e 4 sem número; 5 e 7 "Não disponível"; botão informa o custo; nada é lido', () => {
    const p = montar(gm), h = p.ctx.blocoAlertas(), t = limpo(h);
    for (const n of ['1 · Vencido na carteira em aberto', '2 · Safra', '3 · Inadimplência por faixa de atraso', '4 · Valores recuperados', '5 · Renegociados', '6 · Títulos antigos', '7 · Pagamentos parciais']) expect(t).toContain(n);
    expect(t).toMatch(/60,0% do valor em aberto/); expect(t).toContain('R$ 600,00 ÷ R$ 1.000,00'); expect(t).toContain('3 ÷ 5 títulos');
    expect(t).toContain('R$ 300,00 ÷ R$ 600,00'); expect(t).toContain('vencido em aberto ÷ tudo que venceu no período (em aberto + recebido)');
    expect(t.match(/Não disponível/g)).toHaveLength(2); expect(t.match(/Use o botão abaixo para calcular/g)).toHaveLength(2);
    expect(h).toMatch(/data-hist="1">Calcular safra e recuperados \(lê 2 fatias, ~0,1 MB\)/); expect(t).not.toMatch(/Mês do vencimento/);
    expect(p.lidas).toEqual([]);
  });
  test('depois do clique: lê só as fatias VENCIDO e PAGO a receber, uma vez cada; tela mostra os mesmos números do modelo', async () => {
    const p = montar(gm); await p.ctx.carregarHistorico(); await p.ctx.carregarHistorico();
    expect(p.lidas).toEqual(['gI__RECEBER__VENCIDO__000', 'gI__RECEBER__PAGO__000']); expect(p.redesenhos()).toBe(2);
    const x = V.modeloHistorico(gm.resumo, docsDe(gm)), h = p.ctx.blocoAlertas(), t = limpo(h);
    expect(h).not.toMatch(/data-hist/); expect(t).toContain(V.pctBR(x.safra.periodo.pctC) + ' do que venceu');
    expect(t).toContain(V.brl(x.safra.periodo.c) + ' ÷ ' + V.brl(x.safra.periodo.totalC)); expect(t).toContain('63,3% do valor recebido'); expect(t).toContain('R$ 1.900,00 ÷ R$ 3.000,00');
    expect(t).toMatch(/Mês do vencimento/); expect(t).toContain('09/2026'); expect(t).toContain('em andamento'); expect(t).toContain('Total após o vencimento');
  });
  test('falha de leitura (ex.: sem permissão): mensagem "Não disponível", nenhum percentual de 2 e 4, botão para tentar de novo', async () => {
    const p = montar(gm, { falha: true }); await p.ctx.carregarHistorico(); const h = p.ctx.blocoAlertas();
    expect(h).toMatch(/class="erro"[^>]*>Não disponível/); expect(h).toMatch(/data-hist="1"/); expect(h).not.toMatch(/Mês do vencimento|do que venceu<\/|do valor recebido/);
  });
  test('resultado de uma geração não aparece em outra', async () => {
    const p = montar(gm); await p.ctx.carregarHistorico(); p.S.resumo = gerar(MANUAL, 'gNova').resumo;
    const h = p.ctx.blocoAlertas(); expect(h).toMatch(/data-hist="1"/); expect(h).not.toMatch(/Mês do vencimento/);
  });
  test('o carregador não redesenha outra aba (conversa do Agente preservada)', async () => {
    const p = montar(gm); const fim = p.ctx.carregarHistorico(); p.S.aba = 'agente'; await fim; expect(p.redesenhos()).toBe(1);
  });
  test('só o clique dispara o carregador; sem escrita, envio ou consulta ampla', () => {
    expect(script.match(/carregarHistorico\(\)/g)).toHaveLength(2);     // declaração + clique
    expect(script).toMatch(/if \(t\.dataset\.hist\) \{ carregarHistorico\(\); return; \}/);
    expect(bloco).not.toMatch(/carregarHistorico|lerFatia|lerDoc|getDoc/);
    expect(carregador).not.toMatch(/lerDoc|getDoc|setDoc|addDoc|updateDoc|deleteDoc|httpsCallable|chamarAgente|fetch\(|mailto:|wa\.me|whatsapp/i);
  });
  test('"inadimplência" aparece só como nome do indicador 3; ninguém é chamado de inadimplente', () => {
    const t = montar(gm).ctx.blocoAlertas(); expect(t.match(/inadimpl/gi)).toHaveLength(1); expect(t).toContain('3 · Inadimplência por faixa de atraso'); expect(t).not.toMatch(/inadimplente/i);
  });
  test('permissão inalterada: a página só segue com módulo financeiro (ou admin), não bloqueado', () => {
    expect(script).toMatch(/if \(!sd \|\| sd\.bloqueado === true \|\| !\(sd\.admin === true \|\| mods\.includes\('financeiro'\)\)\)/);
    expect(script.indexOf("mods.includes('financeiro')")).toBeLessThan(script.indexOf('await carregarFin();'));
  });
});
