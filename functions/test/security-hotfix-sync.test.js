'use strict';
// MR4 SECURITY HOTFIX — dry-run do scripts/sync-dados.js REAL com GestãoClick e Firestore simulados (sem rede).
// Prova: resposta do GC → transformação → painel_cache esperado; falha do GC preserva o último cache válido.
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
jest.setTimeout(120000);

const ROOT = path.resolve(__dirname, '../..');
const HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
const TOKEN_A = 'tok-acesso-FAKE-9f8e7d', TOKEN_S = 'tok-segredo-FAKE-1a2b3c';

function rodarSync(modo, estadoInicial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-sync-'));
  const st = path.join(dir, 'state.json'), out = path.join(dir, 'out.json');
  fs.writeFileSync(st, JSON.stringify(estadoInicial || {}));
  let log = '';
  try {
    log = execFileSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], {
      cwd: ROOT, timeout: 90000,
      env: { ...process.env, GC_ACCESS_TOKEN: TOKEN_A, GC_SECRET_ACCESS_TOKEN: TOKEN_S, HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out,
        GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '' },
    }).toString();
  } catch (e) { log = String(e.stdout || '') + String(e.stderr || ''); }
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  r.log = log;
  return r;
}

describe('SYNC_TRANSFORMATION_TEST', () => {
  let r;
  beforeAll(() => { r = rodarSync('ok', {}); });

  test('grava exatamente os 5 documentos protegidos (+ display_metrics) e NENHUM arquivo em disco', () => {
    for (const d of ['vendas', 'caixa', 'estoque', 'estoque_custos', 'produtos_catalogo']) expect(r.writes).toContain('painel_cache/' + d);
    expect(r.writes).toContain('display_metrics/latest');
    expect(r.diskWrites.filter(p => p !== process.env.HARNESS_OUT && !p.includes('hf-sync-'))).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, 'data', 'vendas.json'))).toBe(false);
  });
  test('painel_cache/vendas: totais, metas e vendedores (mesma regra de antes: todos os status)', () => {
    const v = r.state.painel_cache.vendas;
    expect(v).toMatchObject({ hoje: 1750, meta_mes: 200000, meta_dia: 8000, meta_semana: 40000 });
    expect(v.mes).toBeGreaterThanOrEqual(1750);
    expect(v.vendedores.map(x => x.nome)).toEqual(['Vendedor B', 'Vendedor A']);   // 2500 × 1250
    expect(v.vendedores.find(x => x.nome === 'Vendedor A')).toMatchObject({ faturamento: 1250, pedidos: 2, ticket_medio: 625 });
    expect(v.ultimos_7_dias).toHaveLength(7);
  });
  test('painel_cache/caixa: só atualizado_em e hoje (menor privilégio)', () => {
    expect(Object.keys(r.state.painel_cache.caixa).sort()).toEqual(['atualizado_em', 'hoje']);
    expect(r.state.painel_cache.caixa.hoje).toBe(1750);
  });
  test('estoque operacional SEM custo/preço/margem/valor; custos separados', () => {
    const op = r.state.painel_cache.estoque, ct = r.state.painel_cache.estoque_custos;
    expect(Object.keys(op).sort()).toEqual(['abaixo_minimo', 'atualizado_em', 'sem_giro', 'total_produtos']);
    expect(JSON.stringify(op)).not.toMatch(/custo|preco|margem|valor_total/);
    expect(op.total_produtos).toBe(3);
    expect(op.abaixo_minimo).toEqual([{ ref: 'A1', nome: 'Produto A', estoque: 10, minimo: 20, falta: 10 }]);
    expect(ct.valor_total_estoque).toBe(10 * 5 + 2 * 9);
    expect(ct.margem_baixa.map(x => x.ref)).toEqual(['B2']);
    expect(ct.margem_baixa[0]).toMatchObject({ margem: '10.0', preco: 10, custo: 9 });
  });
  test('catálogo: id, código, nome, fabricante', () => {
    const c = r.state.painel_cache.produtos_catalogo;
    expect(c.total).toBe(3);
    expect(c.itens[0]).toEqual({ id: '10', codigo: 'A1', nome: 'Produto A', fabricante: 'Fab X' });
  });
  test('nenhum segredo nos documentos; credenciais só vão para o GestãoClick', () => {
    const tudo = JSON.stringify(r.state);
    expect(tudo).not.toContain(TOKEN_A);
    expect(tudo).not.toContain(TOKEN_S);
    expect(r.gcCalls.length).toBeGreaterThan(0);
    expect(r.gcCalls.every(c => c.host === 'api.gestaoclick.com' && c.temCredencial)).toBe(true);
  });
});

describe('SYNC_FAILURE_PRESERVES_CACHE', () => {
  test('GestãoClick fora do ar → painel_cache e display_metrics permanecem iguais ao último válido', () => {
    const valido = {
      painel_cache: {
        vendas: { atualizado_em: '2026-09-28T10:00:00', hoje: 999, semana: 5000, mes: 90000, meta_mes: 200000, meta_dia: 8000, meta_semana: 40000, vendedores: [{ nome: 'X', faturamento: 999, pedidos: 1, ticket_medio: 999 }], ultimos_7_dias: [] },
        caixa: { atualizado_em: '2026-09-28T10:00:00', hoje: 999 },
        estoque: { atualizado_em: '2026-09-28T10:00:00', total_produtos: 900, abaixo_minimo: [], sem_giro: [] },
        estoque_custos: { atualizado_em: '2026-09-28T10:00:00', valor_total_estoque: 123456, margem_baixa: [] },
        produtos_catalogo: { atualizado_em: '2026-09-28T10:00:00', total: 1, itens: [{ id: '1', codigo: 'A', nome: 'N', fabricante: 'F' }] },
      },
      display_metrics: { latest: { atualizado_em: '2026-09-28T10:00:00', faturamento_mes: 90000, vendedores: [] } },
    };
    const r = rodarSync('falha', valido);
    expect(r.state.painel_cache).toEqual(valido.painel_cache);
    expect(r.state.display_metrics).toEqual(valido.display_metrics);
    expect(r.writes.filter(w => w.startsWith('painel_cache/') || w.startsWith('display_metrics/'))).toEqual([]);
    expect((r.log.match(/↩ Mantendo painel_cache/g) || []).length).toBe(3);
  });
});
