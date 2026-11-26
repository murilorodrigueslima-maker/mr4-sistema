'use strict';
// FINANCEIRO · alertas internos de vencimento e atraso: cálculo puro sobre o resumo/entidades já publicados; a tela não consulta nada novo, não envia e não escreve.
const fs = require('fs'), path = require('path'), vm = require('vm');
const V = require('../../modulos/financeiro-view.js');
const A = require('../lib/financeiro/agregados');
const C = require('../lib/financeiro/canonico');
const { FORMAS } = require('./fixtures/financeiro-f1');
const { massa } = require('./fixtures/financeiro-f2');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/financeiro-v2.html'), 'utf8');
const HOJE = '2026-09-28', AGORA = new Date('2026-09-28T15:00:00Z');
const refs = { formasPorId: FORMAS };
const m = massa({ hoje: HOJE, nPagar: 900, nReceber: 2400 });
const g = A.construirGeracao({ canon: [...m.pagamentos.map(b => C.mapearTitulo(b, 'PAGAR', refs)), ...m.recebimentos.map(b => C.mapearTitulo(b, 'RECEBER', refs))], agora: AGORA, geracao: 'gA', hoje: HOJE });

describe('modeloAlertas', () => {
  test('vencimentos hoje/7 dias = agregados da geração; cada um aponta para a lista correspondente', () => {
    const a = V.modeloAlertas(g.resumo, null, HOJE);
    expect(a.vencimentos.map(v => [v.id, v.natureza, v.filtro])).toEqual([['receber_hoje', 'RECEBER', 'hoje'], ['pagar_hoje', 'PAGAR', 'hoje'], ['receber_7d', 'RECEBER', 'd7'], ['pagar_7d', 'PAGAR', 'd7']]);
    expect(a.vencimentos[0]).toMatchObject({ n: g.resumo.receber.hoje.n, c: g.resumo.receber.hoje.c });
    expect(a.vencimentos[3]).toMatchObject({ n: g.resumo.pagar.prox_7d.n, c: g.resumo.pagar.prox_7d.c });
    expect(a.outraData).toBe(false); expect(a.referencia).toBe(HOJE);
  });
  test('5 faixas exclusivas somam exatamente o vencido (quantidade e valor), nas duas naturezas', () => {
    const a = V.modeloAlertas(g.resumo, null, HOJE);
    expect(a.faixas.map(f => f.rotulo)).toEqual(['1–7 dias', '8–30 dias', '31–90 dias', '91–365 dias', 'Mais de 365 dias']);
    for (const nat of ['receber', 'pagar']) {
      expect(a.faixas.reduce((s, f) => s + f[nat].c, 0)).toBe(g.resumo[nat].vencido.c);
      expect(a.faixas.reduce((s, f) => s + f[nat].n, 0)).toBe(g.resumo[nat].vencido.n);
    }
  });
  test('data dos dados diferente de hoje é sinalizada', () => { expect(V.modeloAlertas(g.resumo, null, '2026-09-29').outraData).toBe(true); });
  test('base vazia: tudo neutro, sem divisão por zero, sem concentração inventada', () => {
    const v = A.construirGeracao({ canon: [], agora: AGORA, geracao: 'gE', hoje: HOJE });
    const a = V.modeloAlertas(v.resumo, v.entidades, HOJE);
    expect(a.vencimentos.every(x => x.tom === 'neutro')).toBe(true);
    expect(a.faixas.every(f => f.tom === 'neutro' && f.receber.pct === null)).toBe(true);
    expect(a.concentracao.every(x => x.dados === null)).toBe(true); expect(V.pctBR(null)).toBe('—');
  });
  test('concentração: sem entidades ou de outra geração → null', () => {
    expect(V.modeloAlertas(g.resumo, null, HOJE).concentracao).toBeNull();
    expect(V.modeloAlertas(g.resumo, { ...g.entidades, geracao: 'outra' }, HOJE).concentracao).toBeNull();
  });
  test('concentração: maior e 5 maiores sobre aberto e vencido; limiar só destaca; não reordena o documento original', () => {
    const ent = (chave, ab, ve) => ({ chave, nome: chave, aberto: { n: 1, c: ab }, vencido: { n: ve ? 1 : 0, c: ve } });
    const doc = { geracao: 'gA', pagar: [], receber: [ent('A', 500, 0), ent('B', 100, 90), ent('C', 100, 10), ent('D', 100, 0), ent('E', 100, 0), ent('F', 100, 0)] };
    const copia = JSON.stringify(doc);
    const r = { ...g.resumo, receber: { ...g.resumo.receber, abertos: { n: 6, c: 1000 }, vencido: { n: 2, c: 100 } } };
    const c = V.modeloAlertas(r, doc, HOJE).concentracao;
    expect(c[0].dados).toMatchObject({ nome: 'A', maiorPct: 50, top5Pct: 90, tom: 'atencao', quantas: 6 });
    expect(c[1].dados).toMatchObject({ nome: 'B', maiorPct: 90, top5Pct: 100, quantas: 2 });
    expect(c[2].dados).toBeNull(); expect(JSON.stringify(doc)).toBe(copia);
    const espalhado = { geracao: 'gA', pagar: [], receber: Array.from({ length: 20 }, (_, i) => ent('N' + i, 50, 0)) };
    expect(V.modeloAlertas(r, espalhado, HOJE).concentracao[0].dados).toMatchObject({ maiorPct: 5, top5Pct: 25, tom: 'neutro' });
  });
});

describe('página: alertas sem consulta nova, sem envio e sem escrita', () => {
  const script = HTML.slice(HTML.indexOf('<script type="module">'));
  const bloco = HTML.slice(HTML.indexOf('// ── Alertas internos'), HTML.indexOf('function renderGeral()'));
  test('o bloco não lê Firestore, não chama função/IA, não envia nada', () => {
    expect(bloco.length).toBeGreaterThan(200);
    expect(bloco).not.toMatch(/lerDoc|getDoc|lerFatia|carregarMais|httpsCallable|chamarAgente|mailto:|wa\.me|whatsapp|sendBeacon|fetch\(/i);
    expect(bloco).toMatch(/nada é enviado a clientes e nenhum título é alterado/);
  });
  test('o documento de entidades só é lido por clique (a visão geral não o carrega sozinha)', () => {
    const geral = script.slice(script.indexOf('function renderGeral()'), script.indexOf('// ── listas paginadas'));
    expect(geral).not.toMatch(/garantirEntidades/); expect(bloco).not.toMatch(/garantirEntidades/);
    expect(script).toMatch(/if \(t\.dataset\.conc\) \{[^}]*garantirEntidades\(\)/);
  });

  /** Executa o bloco de alertas + irPara da própria página, sem navegador. */
  function montar(entidades, hoje = HOJE) {
    const S = { resumo: g.resumo, entidades, entErro: null, aba: 'geral', filtro: { PAGAR: 'vencidas', RECEBER: 'abertas' }, crit: { PAGAR: V.criteriosVazios(), RECEBER: { ...V.criteriosVazios(), busca: 'x' } } };
    const Vf = { ...V, dataComercial: () => hoje };
    const ctx = { S, V: Vf, esc: V.esc, tag: (t, tom) => `<span class="tag ${V.esc(tom)}">${V.esc(t)}</span>`, render: () => {} };
    vm.createContext(ctx); vm.runInContext(bloco + '\nthis.blocoAlertas = blocoAlertas; this.irPara = irPara;', ctx);
    return ctx;
  }
  test('renderiza sem entidades (botão sob demanda) e com entidades (tabela); aviso quando a data dos dados não é hoje', () => {
    const sem = montar(null).blocoAlertas();
    expect(sem).toMatch(/data-conc="1"/); expect(sem).toMatch(/Mais de 365 dias/); expect(sem).not.toMatch(/undefined|NaN|\[object/); expect(sem).not.toMatch(/aviso stale/);
    const com = montar(g.entidades, '2026-09-29').blocoAlertas();
    expect(com).not.toMatch(/data-conc/); expect(com).toMatch(/Clientes · em aberto/); expect(com).toMatch(/aviso stale/); expect(com).not.toMatch(/undefined|NaN|\[object/);
    expect(com).not.toMatch(/inadimpl/i);
  });
  test('nome vindo do ERP é escapado', () => {
    const ruim = { ...g.entidades, receber: g.entidades.receber.map(e => ({ ...e, nome: '<img src=x onerror=alert(1)>' })) };
    const h = montar(ruim).blocoAlertas(); expect(h).not.toMatch(/<img/); expect(h).toMatch(/&lt;img/);
  });
  test('"Ver lista" abre a lista do alerta sem filtros antigos; "Ver conferência" abre a aba', () => {
    const c = montar(null); c.irPara('RECEBER:d7');
    expect(c.S.aba).toBe('receber'); expect(c.S.filtro.RECEBER).toBe('d7'); expect(c.S.crit.RECEBER.busca).toBe('');
    c.irPara('CONFERIR:conferencia'); expect(c.S.aba).toBe('conferir'); expect(c.S.filtro.RECEBER).toBe('d7');
  });
});
