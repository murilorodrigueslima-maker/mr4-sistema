'use strict';
/**
 * Etapa A2.1 — Pedidos vazio LEGÍTIMO (feriado prolongado / ausência de vendas) × vazio INDEVIDO (falha da API).
 * Executa o scripts/sync-dados.js REAL no harness (https.get falso + Firestore em memória). Nenhuma rede, nenhum Firestore real.
 * Regra: vazio de Pedidos só é aceito com HTTP 200 + estrutura válida + paginação completa E corroboração independente no mesmo
 * ciclo (vendas de 30 dias íntegras, mesmo escopo, período que cobre a janela, sem venda dentro da janela de Pedidos).
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { avaliarVazioPedidos } = require('../lib/gcHttp');
jest.setTimeout(240000);

const ROOT = path.resolve(__dirname, '../..');
const HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
// Estado anterior: vendas de referência = 4 (a fixture "ok" devolve 4 vendas) e Pedidos anterior com 10 itens
const PREVIO = ({ pedidosTotal = 10 } = {}) => ({
  painel_cache: {
    vendas: { atualizado_em: 'ANTERIOR', hoje: 999, mes: 90000, vendedores: [], _meta: { vendasTotal: 4, janelaDias: 30, escopo: 'loja_262759', sincronizadoEm: 'ANTERIOR' } },
    caixa: { atualizado_em: 'ANTERIOR', hoje: 999 },
    estoque: { atualizado_em: 'ANTERIOR', total_produtos: 3, abaixo_minimo: [], sem_giro: [] },
    estoque_custos: { atualizado_em: 'ANTERIOR', valor_total_estoque: 123, margem_baixa: [] },
    produtos_catalogo: { atualizado_em: 'ANTERIOR', total: 3, itens: [] },
  },
  display_metrics: { latest: { atualizado_em: 'ANTERIOR', faturamento_mes: 90000, vendedores: [] } },
  pedidos_cache: { latest: { atualizado_em: 'ANTERIOR', total: pedidosTotal, pedidos: [{ numero: 'ANT-1' }], _meta: { pedidosTotal } } },
  financeiro_cache: { latest: { atualizado_em: 'ANTERIOR', _meta: { lancamentosTotal: 0 } } },
});
function rodar(modo, estado = PREVIO()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a21-sync-'));
  const st = path.join(dir, 'state.json'), out = path.join(dir, 'out.json');
  fs.writeFileSync(st, JSON.stringify(estado));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], {
    cwd: ROOT, timeout: 90000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '' },
  });
  return { ...JSON.parse(fs.readFileSync(out, 'utf8')), exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
}
const resumo = r => { const l = r.log.split('\n').find(x => x.startsWith('RESUMO_SYNC ')); return l ? JSON.parse(l.slice('RESUMO_SYNC '.length)) : null; };
const tem = (r, bloco, codigo) => ((resumo(r) || {}).falhas || []).some(f => f.bloco === bloco && f.codigo === codigo);
const aviso = (r, codigo) => ((resumo(r) || {}).avisos || []).some(a => a.bloco === 'pedidos' && a.codigo === codigo);
const pedidosPreservado = r => { expect(r.writes).not.toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest).toEqual(PREVIO().pedidos_cache.latest); };

describe('A2.1 — vazio LEGÍTIMO de Pedidos (feriado prolongado): aceito SÓ com corroboração', () => {
  let r; beforeAll(() => { r = rodar('pedidos_vazio_feriado'); });
  test('publica Pedidos vazio (total 0), workflow com sucesso, aviso de auditoria PEDIDOS_VAZIO_CORROBORADO', () => {
    expect(r.exitCode).toBe(0); expect(resumo(r).ok).toBe(true); expect(resumo(r).falhas).toEqual([]);
    expect(aviso(r, 'PEDIDOS_VAZIO_CORROBORADO')).toBe(true);
    expect(r.writes).toContain('pedidos_cache/latest');
    expect(r.state.pedidos_cache.latest.total).toBe(0); expect(r.state.pedidos_cache.latest.pedidos).toEqual([]);
    expect(r.state.pedidos_cache.latest._meta.pedidosTotal).toBe(0);
  });
  test('o vazio vem com anterior = 10 (queda de 100%) e mesmo assim é aceito: a corroboração substitui a regra de queda SÓ neste caso', () => {
    expect(r.log).toMatch(/Pedidos vazio LEGÍTIMO/);
  });
  test('as vendas de 30 dias foram lidas no mesmo ciclo e publicadas normalmente (referência atualizada)', () => {
    expect(r.writes).toEqual(expect.arrayContaining(['painel_cache/vendas', 'painel_cache/caixa', 'display_metrics/latest']));
    expect(r.state.painel_cache.vendas._meta.vendasTotal).toBe(4);
  });
  test('ciclo seguinte (vazio legítimo persistindo) continua publicando: não trava indefinidamente', () => {
    const r2 = rodar('pedidos_vazio_feriado', r.state);
    expect(r2.exitCode).toBe(0); expect(r2.state.pedidos_cache.latest.total).toBe(0);
  });
  test('sem documento anterior de Pedidos (ausência legítima desde o início) ⇒ publica vazio', () => {
    const e = PREVIO(); delete e.pedidos_cache; const r3 = rodar('pedidos_vazio_feriado', e);
    expect(r3.exitCode).toBe(0); expect(r3.writes).toContain('pedidos_cache/latest');
  });
  test('retomada do movimento: depois do vazio, vendas novas voltam a publicar normalmente', () => {
    const r4 = rodar('ok', r.state); expect(r4.exitCode).toBe(0); expect(r4.state.pedidos_cache.latest.total).toBe(4);
  });
});

describe('A2.1 — vazio INDEVIDO de Pedidos: preserva o último válido e alerta', () => {
  test('INCONSISTENTE: Pedidos vazio, mas as vendas de 30 dias têm venda de hoje ⇒ NÃO aceita', () => {
    const r = rodar('pedidos_vazio_inconsistente');
    pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_VAZIO_INESPERADO')).toBe(true); expect(r.exitCode).not.toBe(0); expect(resumo(r).ok).toBe(false);
    expect(r.log).toMatch(/INCONSISTENTE_VENDAS_NA_JANELA_DE_PEDIDOS/); expect(aviso(r, 'PEDIDOS_VAZIO_CORROBORADO')).toBe(false);
  });
  test('vendas de 30 dias com HTTP 500 ⇒ sem corroboração: Pedidos preservado; vendas falha com GC_HTTP_500', () => {
    const r = rodar('pedidos_vazio_vendas30_500');
    pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_VAZIO_INESPERADO')).toBe(true); expect(tem(r, 'vendas', 'GC_HTTP_500')).toBe(true); expect(r.exitCode).not.toBe(0);
  });
  test('vendas de 30 dias com paginação incompleta ⇒ sem corroboração: Pedidos preservado', () => {
    const r = rodar('pedidos_vazio_vendas30_incompleta');
    pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_VAZIO_INESPERADO')).toBe(true); expect(tem(r, 'vendas', 'GC_PAGINACAO_INCOMPLETA')).toBe(true);
  });
  test('API devolvendo vazio para TUDO (vendas 30 dias também vazia) ⇒ nada corrobora: tudo preservado, ambos com erro', () => {
    const r = rodar('pedidos_vazio_vendas30_vazia');
    pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_VAZIO_INESPERADO')).toBe(true); expect(tem(r, 'vendas', 'GC_VAZIO_INESPERADO')).toBe(true);
    expect(r.writes).not.toContain('painel_cache/vendas'); expect(r.state.painel_cache.vendas._meta.vendasTotal).toBe(4);
  });
  test('vendas de 30 dias BLOQUEADA por queda anormal (1 vs referência 4... >70%) ⇒ não é "íntegra": Pedidos vazio não é aceito', () => {
    const e = PREVIO(); e.painel_cache.vendas._meta.vendasTotal = 20;
    const r = rodar('pedidos_vazio_vendas30_queda', e);
    pedidosPreservado(r); expect(tem(r, 'vendas', 'PUBLICACAO_BLOQUEADA')).toBe(true); expect(tem(r, 'pedidos', 'GC_VAZIO_INESPERADO')).toBe(true);
  });
  test('referência de vendas ILEGÍVEL ⇒ vendas bloqueia ⇒ sem corroboração: Pedidos preservado', () => {
    const r = (() => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a21-sync-')); const st = path.join(dir, 's.json'), out = path.join(dir, 'o.json'); fs.writeFileSync(st, JSON.stringify(PREVIO()));
      const p = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], { cwd: ROOT, timeout: 90000, encoding: 'utf8', env: { ...process.env, GC_ACCESS_TOKEN: 'a', GC_SECRET_ACCESS_TOKEN: 'b', HARNESS_MODE: 'pedidos_vazio_feriado', HARNESS_STATE: st, HARNESS_OUT: out, HARNESS_FALHA_LEITURA: 'painel_cache/vendas', GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '' } });
      return { ...JSON.parse(fs.readFileSync(out, 'utf8')), exitCode: p.status, log: String(p.stdout || '') + String(p.stderr || '') }; })();
    pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_VAZIO_INESPERADO')).toBe(true);
  });
  test('resposta 200 com ESTRUTURA INVÁLIDA em Pedidos NÃO é vazio legítimo: GC_RESPOSTA_INESPERADA, preservado', () => {
    const r = rodar('pedidos_estrutura_invalida'); pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_RESPOSTA_INESPERADA')).toBe(true); expect(r.exitCode).not.toBe(0);
  });
  test('HTTP 500 na página 2 de Pedidos NÃO é vazio: GC_HTTP_500, preservado', () => {
    const r = rodar('pedidos_pag2_500'); pedidosPreservado(r); expect(tem(r, 'pedidos', 'GC_HTTP_500')).toBe(true);
  });
  test('Pedidos NÃO vazio mas com queda > 80% continua protegido (a exceção vale só para vazio corroborado)', () => {
    const e = PREVIO({ pedidosTotal: 25 }); const r = rodar('ok', e);
    expect(r.writes).not.toContain('pedidos_cache/latest'); expect(tem(r, 'pedidos', 'PUBLICACAO_BLOQUEADA')).toBe(true);
  });
});

describe('A2.1 — avaliarVazioPedidos (função pura): cada condição de corroboração', () => {
  const janela = { escopo: 'loja_262759', inicio: '2026-12-24', fim: '2026-12-26' };
  const ok = { integra: true, escopo: 'loja_262759', inicio: '2026-11-26', fim: '2026-12-26', datas: ['2026-12-20', '2026-12-21'], semData: 0 };
  test('íntegra, mesmo escopo, período cobre a janela, sem vendas na janela ⇒ aceita', () => expect(avaliarVazioPedidos({ vendas30: ok, janela })).toEqual({ aceitar: true, motivo: 'OK_CORROBORADO' }));
  test.each([
    ['sem leitura de vendas', null, 'VENDAS30_NAO_INTEGRA'],
    ['vendas não íntegra', { ...ok, integra: false }, 'VENDAS30_NAO_INTEGRA'],
    ['escopo diferente', { ...ok, escopo: 'padrao_sem_loja_id' }, 'ESCOPO_INCOMPATIVEL'],
    ['período não cobre o início', { ...ok, inicio: '2026-12-25' }, 'PERIODO_INCOMPATIVEL'],
    ['período termina antes (virada de dia)', { ...ok, fim: '2026-12-25' }, 'PERIODO_INCOMPATIVEL'],
    ['vendas vazia', { ...ok, datas: [] }, 'VENDAS30_VAZIA'],
    ['venda sem data', { ...ok, semData: 1 }, 'VENDAS30_SEM_DATA'],
    ['data inválida', { ...ok, datas: ['ontem'] }, 'VENDAS30_DATA_INVALIDA'],
    ['venda dentro da janela de Pedidos', { ...ok, datas: ['2026-12-20', '2026-12-25'] }, 'INCONSISTENTE_VENDAS_NA_JANELA_DE_PEDIDOS'],
    ['venda no 1º dia da janela', { ...ok, datas: ['2026-12-24'] }, 'INCONSISTENTE_VENDAS_NA_JANELA_DE_PEDIDOS'],
  ])('%s ⇒ NÃO aceita (%s)', (_n, v, motivo) => expect(avaliarVazioPedidos({ vendas30: v, janela })).toEqual({ aceitar: false, motivo }));
  test('janela inválida ⇒ NÃO aceita', () => expect(avaliarVazioPedidos({ vendas30: ok, janela: { escopo: 'loja_262759', inicio: 'x', fim: 'y' } }).aceitar).toBe(false));
  test('sem argumentos ⇒ NÃO aceita', () => expect(avaliarVazioPedidos().aceitar).toBe(false));
});

describe('A2.1 — verificações estáticas', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/sync-dados.js'), 'utf8');
  test('permitirVazio só em financeiro (pagamentos) e pedidos; o de pedidos passa por avaliarVazioPedidos', () => {
    expect((src.match(/permitirVazio: true/g) || []).length).toBe(2);
    const bloco = src.slice(src.indexOf('async function syncPedidos'), src.indexOf('async function syncCatalogoProdutos'));
    expect(bloco).toMatch(/permitirVazio: true/); expect(bloco).toMatch(/avaliarVazioPedidos/);
    expect(src.slice(src.indexOf('async function syncVendasCorpo'), src.indexOf('async function syncEstoque'))).not.toMatch(/permitirVazio/);
  });
  test('syncVendas SEMPRE libera a corroboração (finally) — Pedidos nunca fica esperando', () => {
    expect(src).toMatch(/try \{ await syncVendasCorpo\(\); \} finally \{ _resolverVendas30\(_estadoVendas30\); \}/);
  });
  test('a corroboração não guarda dado pessoal: só datas, escopo, período e contagem', () => {
    const i = src.indexOf('_estadoVendas30 = {'); const t = src.slice(i, src.indexOf('};', i) + 2);
    expect(t).not.toMatch(/nome|cliente|valor|vendedor/);
  });
});
