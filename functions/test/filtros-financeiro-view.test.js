'use strict';
// FINANCEIRO · Fase A: busca, período, filtros combináveis, ordenação, chips, limpeza e cache de fatias (funções puras; nenhuma consulta nova).
const fs = require('fs'), path = require('path');
const V = require('../../modulos/financeiro-view.js');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/financeiro-v2.html'), 'utf8');
const HOJE = '2026-10-01';   // quinta-feira
const T = (id, o = {}) => ({ id, cod: 'T' + id, v: '2026-10-05', desc: 'Compra de nº ' + id, ent: 'Fornecedor ' + id, et: 'FORNECEDOR', val: 10000, pl: 'Compras', fp: 'Boleto', _g: 'FUTURO', ...o });
const BASE = [
  T('1', { ent: 'Auto Peças São João Ltda', desc: 'Compra de nº 77', v: '2026-09-20', val: 718004, pl: 'Impostos - importação', fp: 'Boleto', _g: 'VENCIDO', lk: { t: 'COMPRA', cod: '77' } }),
  T('2', { ent: 'LOCAL DISTRIBUIDORA DE PEÇAS LTDA', desc: 'Compra de nº 181', v: '2026-10-01', val: 19560, _g: 'HOJE', lk: { t: 'AMBIGUO' } }),
  T('3', { ent: null, et: 'FUNCIONARIO', desc: 'Folha setembro', v: '2026-10-07', val: 350000, pl: 'Folha', fp: 'Pix', _g: 'FUTURO' }),
  T('4', { ent: 'Maria  da Silva', desc: 'Troca de nº 12', v: '2026-08-30', val: 300, pl: 'Devolução de vendas', fp: '—', _g: 'VENCIDO' }),
  T('5', { ent: 'Transportes Rápido', desc: 'Frete', v: '2026-10-31', sd: '2026-09-29', val: 55000, pl: 'Frete', fp: 'Pix', _g: 'PAGO' }),
  T('6', { ent: 'Zeta', desc: 'Sem valor', v: null, val: null, pl: null, fp: null, _g: 'UNKNOWN' }),
];
const ids = l => l.map(i => i.id);
const C = (o = {}) => ({ ...V.criteriosVazios(), ...o });

describe('busca rápida (campos existentes; sem acento/caixa/espaços; AND dos termos)', () => {
  test('entidade, descrição, código do título, plano e forma', () => {
    expect(ids(V.filtrarItens(BASE, C({ busca: 'sao joao' }), HOJE))).toEqual(['1']);            // acento e caixa
    expect(ids(V.filtrarItens(BASE, C({ busca: '  PEÇAS   ltda ' }), HOJE))).toEqual(['1', '2']); // espaços extras, ç/c
    expect(ids(V.filtrarItens(BASE, C({ busca: 'nº 181' }), HOJE))).toEqual(['2']);               // descrição
    expect(ids(V.filtrarItens(BASE, C({ busca: 'T3' }), HOJE))).toEqual(['3']);                   // código do título
    expect(ids(V.filtrarItens(BASE, C({ busca: 'impostos' }), HOJE))).toEqual(['1']);             // plano
    expect(ids(V.filtrarItens(BASE, C({ busca: 'pix' }), HOJE))).toEqual(['3', '5']);             // forma
    expect(ids(V.filtrarItens(BASE, C({ busca: 'maria silva' }), HOJE))).toEqual(['4']);          // AND de termos, espaço duplo no dado
  });
  test('campo inexistente não é pesquisado e dado nulo não quebra', () => {
    expect(V.filtrarItens(BASE, C({ busca: 'observação' }), HOJE)).toEqual([]);
    expect(() => V.textoBuscavel({})).not.toThrow(); expect(V.textoBuscavel({ ent: null, desc: undefined })).toBe('');
    expect(V.filtrarItens(BASE, C({ busca: '   ' }), HOJE)).toHaveLength(BASE.length);              // vazio = sem filtro
  });
  test('não altera os dados', () => { const copia = JSON.stringify(BASE); V.filtrarItens(BASE, C({ busca: 'a', plano: 'Compras' }), HOJE); V.ordenarItens(BASE, 'valor', 'desc'); expect(JSON.stringify(BASE)).toBe(copia); });
});

describe('períodos (datas só-data America/Fortaleza; comparação por texto: nada desloca de dia)', () => {
  test('atalhos a partir de quinta 01/10/2026', () => {
    expect(V.intervaloPeriodo('hoje', HOJE)).toEqual({ de: HOJE, ate: HOJE });
    expect(V.intervaloPeriodo('ontem', HOJE)).toEqual({ de: '2026-09-30', ate: '2026-09-30' });
    expect(V.intervaloPeriodo('semana', HOJE)).toEqual({ de: '2026-09-28', ate: '2026-10-04' });   // segunda a domingo
    expect(V.intervaloPeriodo('mes', HOJE)).toEqual({ de: '2026-10-01', ate: '2026-10-31' });
    expect(V.intervaloPeriodo('mes_passado', HOJE)).toEqual({ de: '2026-09-01', ate: '2026-09-30' });
    expect(V.intervaloPeriodo('ult7', HOJE)).toEqual({ de: '2026-09-25', ate: HOJE });
    expect(V.intervaloPeriodo('ult30', HOJE)).toEqual({ de: '2026-09-02', ate: HOJE });
    expect(V.intervaloPeriodo('ult90', HOJE)).toEqual({ de: '2026-07-04', ate: HOJE });
  });
  test('bordas: domingo, segunda, virada de ano, fevereiro bissexto e mês passado em janeiro', () => {
    expect(V.intervaloPeriodo('semana', '2026-10-04')).toEqual({ de: '2026-09-28', ate: '2026-10-04' });   // domingo
    expect(V.intervaloPeriodo('semana', '2026-09-28')).toEqual({ de: '2026-09-28', ate: '2026-10-04' });   // segunda
    expect(V.intervaloPeriodo('mes_passado', '2026-01-15')).toEqual({ de: '2025-12-01', ate: '2025-12-31' });
    expect(V.intervaloPeriodo('ontem', '2026-01-01')).toEqual({ de: '2025-12-31', ate: '2025-12-31' });
    expect(V.intervaloPeriodo('mes', '2028-02-10')).toEqual({ de: '2028-02-01', ate: '2028-02-29' });
    expect(V.intervaloPeriodo('mes_passado', '2028-03-10')).toEqual({ de: '2028-02-01', ate: '2028-02-29' });
  });
  test('personalizado: inverte datas trocadas, aceita ponta aberta, ignora data inválida', () => {
    expect(V.intervaloPeriodo('personalizado', HOJE, '2026-09-10', '2026-09-01')).toEqual({ de: '2026-09-01', ate: '2026-09-10' });
    expect(V.intervaloPeriodo('personalizado', HOJE, '2026-09-10', '')).toEqual({ de: '2026-09-10', ate: null });
    expect(V.intervaloPeriodo('personalizado', HOJE, '2026-02-30', '')).toBeNull(); expect(V.intervaloPeriodo('personalizado', HOJE, '', '')).toBeNull();
    expect(V.periodoAtivo({ id: 'personalizado', de: '', ate: '' })).toBe(false);
  });
  test('referência vencimento x pagamento; título sem a data fica FORA; limites inclusivos', () => {
    const P = (id, ref, de, ate) => C({ periodo: { id, ref, de, ate } });
    expect(ids(V.filtrarItens(BASE, P('hoje', 'vencimento'), HOJE))).toEqual(['2']);
    expect(ids(V.filtrarItens(BASE, P('mes_passado', 'vencimento'), HOJE))).toEqual(['1']);   // 20/09 sim; 30/08 não
    expect(ids(V.filtrarItens(BASE, P('ult7', 'pagamento'), HOJE))).toEqual(['5']);           // só pagos têm data de pagamento
    expect(V.filtrarItens(BASE, P('hoje', 'pagamento'), HOJE)).toEqual([]);                   // ninguém pagou hoje
    expect(ids(V.filtrarItens(BASE, P('personalizado', 'vencimento', '2026-09-20', '2026-10-01'), HOJE))).toEqual(['1', '2']);   // inclusivo nas duas pontas
    expect(ids(V.filtrarItens(BASE, P('mes', 'vencimento'), HOJE))).toEqual(['2', '3', '5']); // 6 sem vencimento fica fora
  });
});

describe('valor, vínculo, plano, forma, entidade — combináveis', () => {
  test('parseReais aceita formatos brasileiros', () => {
    expect(V.parseReais('1.234,56')).toBe(123456); expect(V.parseReais('R$ 1.000')).toBe(100000); expect(V.parseReais('1000,5')).toBe(100050); expect(V.parseReais('1000.50')).toBe(100050);
    expect(V.parseReais('0')).toBe(0); expect(V.parseReais('')).toBeNull(); expect(V.parseReais('abc')).toBeNull(); expect(V.parseReais('1,234,56')).toBeNull();
  });
  test('faixa de valor (inclusiva; sem valor fica fora quando há limite)', () => {
    expect(ids(V.filtrarItens(BASE, C({ min: 100000, max: 400000 }), HOJE))).toEqual(['3']);
    expect(ids(V.filtrarItens(BASE, C({ min: 300 }), HOJE))).toEqual(['1', '2', '3', '4', '5']);       // 6 (valor nulo) fora
    expect(ids(V.filtrarItens(BASE, C({ max: 300 }), HOJE))).toEqual(['4']);
    expect(ids(V.filtrarItens(BASE, C({ min: 0 }), HOJE))).toHaveLength(5);
  });
  test('vínculo: com / ambíguo / sem', () => {
    expect(ids(V.filtrarItens(BASE, C({ vinculo: 'com' }), HOJE))).toEqual(['1']); expect(ids(V.filtrarItens(BASE, C({ vinculo: 'ambiguo' }), HOJE))).toEqual(['2']); expect(ids(V.filtrarItens(BASE, C({ vinculo: 'sem' }), HOJE))).toEqual(['3', '4', '5', '6']);
  });
  test('plano e forma usam o mesmo rótulo da tabela (ausente = "Sem classificação" / "—")', () => {
    expect(ids(V.filtrarItens(BASE, C({ plano: 'Sem classificação' }), HOJE))).toEqual(['6']); expect(ids(V.filtrarItens(BASE, C({ forma: '—' }), HOJE))).toEqual(['4', '6']); expect(ids(V.filtrarItens(BASE, C({ forma: 'Pix' }), HOJE))).toEqual(['3', '5']);
    expect(V.opcoesDistintas(BASE, 'pl').map(o => o.valor)).toEqual(['Compras', 'Devolução de vendas', 'Folha', 'Frete', 'Impostos - importação', 'Sem classificação']);
  });
  test('entidade (contém, sem acento) e combinação de 4 critérios', () => {
    expect(ids(V.filtrarItens(BASE, C({ entidade: 'distribuidora' }), HOJE))).toEqual(['2']);
    const c = C({ busca: 'compra', plano: 'Impostos - importação', min: 100000, max: 900000, entidade: 'auto pecas' });
    expect(ids(V.filtrarItens(BASE, c, HOJE))).toEqual(['1']); expect(V.filtrarItens(BASE, { ...c, max: 100 }, HOJE)).toEqual([]);   // um critério a mais derruba
  });
});

describe('ordenação (ausentes sempre no fim; estável; direção)', () => {
  test('vencimento, valor, entidade, situação, pagamento', () => {
    expect(ids(V.ordenarItens(BASE, 'venc', 'asc'))).toEqual(['4', '1', '2', '3', '5', '6']);
    expect(ids(V.ordenarItens(BASE, 'venc', 'desc'))).toEqual(['5', '3', '2', '1', '4', '6']);                 // sem vencimento (6) no fim nos DOIS sentidos
    expect(ids(V.ordenarItens(BASE, 'valor', 'desc'))).toEqual(['1', '3', '5', '2', '4', '6']);
    expect(ids(V.ordenarItens(BASE, 'valor', 'asc'))).toEqual(['4', '2', '5', '3', '1', '6']);                 // sem valor (6) no fim
    expect(ids(V.ordenarItens(BASE, 'entidade', 'asc'))).toEqual(['1', '2', '4', '5', '6', '3']);               // sem entidade (3) no fim; sem acento/caixa
    expect(ids(V.ordenarItens(BASE, 'entidade', 'desc'))).toEqual(['6', '5', '4', '2', '1', '3']);
    expect(ids(V.ordenarItens(BASE, 'situacao', 'asc'))).toEqual(['4', '1', '2', '3', '6', '5']);                // vencido < hoje < a vencer < conferência < pago; empate por vencimento
    expect(V.ordenarItens(BASE, 'situacao', 'asc').map(i => i._g)).toEqual(['VENCIDO', 'VENCIDO', 'HOJE', 'FUTURO', 'UNKNOWN', 'PAGO']);
    expect(ids(V.ordenarItens(BASE, 'pagamento', 'desc'))[0]).toBe('5'); expect(ids(V.ordenarItens(BASE, 'pagamento', 'asc'))[0]).toBe('5');   // só o 5 tem pagamento; ausentes depois
  });
  test('sem campo = ordem original; empate estável por vencimento e id; não muta', () => {
    expect(ids(V.ordenarItens(BASE, null, 'asc'))).toEqual(ids(BASE));
    const igual = [T('b', { val: 5 }), T('a', { val: 5 })]; expect(ids(V.ordenarItens(igual, 'valor', 'asc'))).toEqual(['a', 'b']);
    const antes = ids(BASE); V.ordenarItens(BASE, 'valor', 'asc'); expect(ids(BASE)).toEqual(antes);
  });
});

describe('chips ativos, remover um critério e limpar', () => {
  const est = () => ({ situacao: 'vencidas', criterios: C({ busca: 'peças', periodo: { id: 'mes_passado', ref: 'vencimento', de: '', ate: '' }, plano: 'Compras', entidade: 'João', min: 100000, max: 500000, vinculo: 'com', forma: 'Pix' }), ordem: { campo: 'valor', dir: 'desc' } });
  test('um chip por critério, com rótulo legível', () => {
    const r = V.chipsAtivos('vencidas', est().criterios, 'PAGAR').map(c => c.id); expect(r).toEqual(['situacao', 'busca', 'periodo', 'plano', 'forma', 'vinculo', 'entidade', 'valor']);
    expect(V.chipsAtivos('vencidas', C(), 'PAGAR').map(c => c.rotulo)).toEqual(['Vencidas']); expect(V.chipsAtivos('pagas', C(), 'RECEBER')[0].rotulo).toBe('Recebidas'); expect(V.chipsAtivos('abertas', C(), 'PAGAR')[0].rotulo).toBe('Em aberto');
    expect(V.chipsAtivos('vencidas', C({ entidade: 'X' }), 'PAGAR').pop().rotulo).toBe('Fornecedor: X'); expect(V.chipsAtivos('vencidas', C({ entidade: 'X' }), 'RECEBER').pop().rotulo).toBe('Cliente: X');
    expect(V.chipsAtivos('vencidas', C({ min: 100000, max: 500000 }), 'PAGAR').pop().rotulo).toBe('Valor: R$ 1.000,00 a R$ 5.000,00');
  });
  test('remover um chip retira SOMENTE aquele critério (sem mutar o original)', () => {
    const e0 = est(); const e1 = V.removerCriterio(e0, 'plano'); expect(e1.criterios.plano).toBe(''); expect(e1.criterios.busca).toBe('peças'); expect(e1.criterios.min).toBe(100000); expect(e1.situacao).toBe('vencidas'); expect(e0.criterios.plano).toBe('Compras');
    expect(V.removerCriterio(e0, 'valor').criterios).toMatchObject({ min: null, max: null, plano: 'Compras', busca: 'peças' });
    expect(V.removerCriterio(e0, 'periodo').criterios.periodo).toBeNull(); expect(V.removerCriterio(e0, 'periodo').criterios.entidade).toBe('João');
    expect(V.removerCriterio(e0, 'situacao').situacao).toBe('abertas'); expect(V.removerCriterio(e0, 'situacao').criterios.plano).toBe('Compras');
  });
  test('limpar filtros zera critérios e situação (volta a "Em aberto"), mantendo a ordenação', () => {
    const l = V.limparFiltros(est()); expect(l.situacao).toBe('abertas'); expect(V.temCriterio(l.criterios)).toBe(false); expect(l.ordem).toEqual({ campo: 'valor', dir: 'desc' });
  });
});

describe('cache de fatias: trocar de chip não relê; falha não fica no cache', () => {
  const resumo = { pagar: { detalhe: { VENCIDO: { fatias: 1 }, HOJE: { fatias: 1 }, FUTURO: { fatias: 1 }, PAGO: { fatias: 11 }, UNKNOWN: { fatias: 1 } } } };
  test('cada id é lido UMA vez por sessão', async () => {
    const cache = V.criarCacheFatias(); let lidas = []; const leitor = async id => { lidas.push(id); return { geracao: 'g', itens: [] }; };
    await cache.ler('a', leitor); await cache.ler('a', leitor); await cache.ler('b', leitor); await cache.ler('a', leitor);
    expect(lidas).toEqual(['a', 'b']); expect(cache.leituras()).toBe(2); expect(cache.tamanho()).toBe(2);
  });
  test('documento inexistente (null) não é guardado; erro propaga e não contamina', async () => {
    const cache = V.criarCacheFatias(); expect(await cache.ler('x', async () => null)).toBeNull(); expect(cache.tem('x')).toBe(false);
    await expect(cache.ler('y', async () => { throw new Error('rede'); })).rejects.toThrow('rede'); expect(cache.tem('y')).toBe(false);
  });
  test('pagos históricos continuam sob demanda: o plano de "Pagas" só conta o que falta ler', () => {
    const cache = V.criarCacheFatias(); expect(V.fatiasPendentes('g', 'PAGAR', 'pagas', resumo, cache)).toBe(11); cache.definir('g__PAGAR__PAGO__000', {});
    expect(V.fatiasPendentes('g', 'PAGAR', 'pagas', resumo, cache)).toBe(10); expect(V.fatiasPendentes('g', 'PAGAR', 'abertas', resumo, cache)).toBe(3);   // abertas = vencidas+hoje+futuro (3 fatias)
  });
  test('"Em aberto" não altera o contrato de V.FILTROS e usa as mesmas fatias', () => {
    expect(Object.keys(V.FILTROS)).toEqual(['vencidas', 'hoje', 'd7', 'd30', 'conferencia', 'pagas']); expect(V.defFiltro('abertas').grupos).toEqual(['VENCIDO', 'HOJE', 'FUTURO']);
    expect(V.planoLeitura('g', 'PAGAR', 'abertas', resumo).map(f => f.grupo)).toEqual(['VENCIDO', 'HOJE', 'FUTURO']);
  });
});

describe('página do Financeiro: só filtros locais (sem novas consultas)', () => {
  test('não usa where/orderBy/query/collection/getDocs; só getDoc por id (via cache)', () => {
    const js = HTML.slice(HTML.indexOf('<script type="module">'));
    expect(js).not.toMatch(/\bwhere\(|\borderBy\(|\bquery\(|\bcollection\(|\bgetDocs\(|\blimit\(|onSnapshot|setDoc|addDoc|updateDoc|deleteDoc|fetch\(/);
    expect(js).toMatch(/const lerFatia = id => S\.cache\.ler\(id/);
    expect([...js.matchAll(/lerDoc\('([a-z0-9_]+)'/g)].map(m => m[1]).sort()).toEqual(['fin_n1', 'fin_n1_resumo', 'fin_n1_resumo', 'fin_n1_titulos']);   // mesmas coleções de antes; a de fatias SÓ dentro do cache (abaixo)
    expect(js.match(/lerDoc\('fin_n1_titulos'/g)).toHaveLength(1); expect(js).toMatch(/const lerFatia = id => S\.cache\.ler\(id, async i => lerDoc\('fin_n1_titulos', i\)\)/);
  });
  test('pagos não são carregados automaticamente: "Carregar todos" é ação explícita do usuário', () => {
    expect(HTML).toMatch(/data-tudo/); expect(HTML).toMatch(/const completo = tudo \|\| S\.filtro\[nat\] !== 'pagas'/);
    expect(HTML).toMatch(/data-aba=\"agente\"/);   // aba do agente intacta
  });
  test('filtros não chamam IA (FILTER_AI_CALLS=0): o único aiAgente é o do widget/gate do agente', () => {
    const trecho = HTML.slice(HTML.indexOf('// Fase A: critérios locais'), HTML.indexOf('setInterval(renderFresco'));
    expect(trecho).not.toMatch(/aiAgente|chamarAgente|httpsCallable/);
    const lista = HTML.slice(HTML.indexOf('// ── listas paginadas'), HTML.indexOf('function renderConferir()'));
    expect(lista).not.toMatch(/aiAgente|chamarAgente|httpsCallable/);
  });
  test('UI: busca, painel de filtros, ordenação, chips ativos, Limpar filtros e cabeçalhos ordenáveis', () => {
    for (const rx of [/data-crit="busca"/, /data-painel=/, /data-crit="ordem"/, /data-rm=/, /data-limpar=/, /data-ordem=/, /aria-sort=/, /data-crit="periodo"/, /data-crit="ref"/, /data-crit="min"/, /data-crit="max"/, /data-crit="plano"/, /data-crit="forma"/, /data-crit="vinculo"/, /data-crit="entidade"/]) expect(HTML).toMatch(rx);
    expect(HTML).toMatch(/Limpar filtros/); expect(HTML).toMatch(/@media\(max-width:640px\)\{[^}]*\.painel\.aberto/);   // mobile: painel em 2 colunas, busca em linha própria
  });
});
