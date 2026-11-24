'use strict';
/**
 * Etapa A · A2 — INTEGRIDADE do scripts/sync-dados.js REAL, com GestãoClick e Firestore SIMULADOS (sem rede, sem credenciais).
 *
 * Na A1 estes cenários foram escritos como `test.failing` (provavam o defeito). Com a A2 (camada segura ligada ao script)
 * eles foram CONVERTIDOS em testes normais: o comportamento aprovado agora é exigido —
 *   falha/incerteza ⇒ nenhuma escrita nos caches, documentos anteriores intactos, workflow com status de erro.
 * As "CARACTERIZAÇÕES" do defeito foram removidas (o defeito deixou de existir); o histórico está nos commits A1.
 *
 * Cobre: 429/500 na paginação; 200 com estrutura inválida; paginação incompleta; vazio legítimo × inesperado; queda > 70%;
 * 1ª execução sem `_meta.vendasTotal`; virada de mês; total que muda durante a paginação; falha de gravação (atomicidade);
 * preservação dos dados anteriores; status final de erro; limites atuais de Pedidos (80%) e Financeiro (70%).
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
jest.setTimeout(240000);

const ROOT = path.resolve(__dirname, '../..');
const HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');

const REF = n => ({ vendasTotal: n, janelaDias: 30, escopo: 'padrao_sem_loja_id', sincronizadoEm: 'ANTERIOR' });
const PREVIO = ({ vendasRef = 118 } = {}) => ({
  painel_cache: {
    vendas: { atualizado_em: 'ANTERIOR', hoje: 999, semana: 5000, mes: 90000, meta_mes: 200000, meta_dia: 8000, meta_semana: 40000, vendedores: [{ nome: 'X', faturamento: 90000, pedidos: 100, ticket_medio: 900 }], _meta: REF(vendasRef) },
    caixa: { atualizado_em: 'ANTERIOR', hoje: 999 },
    estoque: { atualizado_em: 'ANTERIOR', total_produtos: 3, abaixo_minimo: [], sem_giro: [] },
    estoque_custos: { atualizado_em: 'ANTERIOR', valor_total_estoque: 123, margem_baixa: [] },
    produtos_catalogo: { atualizado_em: 'ANTERIOR', total: 3, itens: [] },
  },
  display_metrics: { latest: { atualizado_em: 'ANTERIOR', faturamento_mes: 90000, vendedores: [] } },
  pedidos_cache: { latest: { atualizado_em: 'ANTERIOR', total: 10, pedidos: [], _meta: { pedidosTotal: 10 } } },
  financeiro_cache: { latest: { atualizado_em: 'ANTERIOR', _meta: { lancamentosTotal: 10 } } },
});

function rodar(modo, estado = PREVIO(), extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-sync-'));
  const st = path.join(dir, 'state.json'), out = path.join(dir, 'out.json');
  fs.writeFileSync(st, JSON.stringify(estado));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], {
    cwd: ROOT, timeout: 90000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '', ...extraEnv },
  });
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { ...res, exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
}
const GRUPO_VENDAS = ['painel_cache/vendas', 'painel_cache/caixa', 'display_metrics/latest'];
const GRUPO_ESTOQUE = ['painel_cache/estoque', 'painel_cache/estoque_custos'];
const escritasDeVendas = r => r.writes.filter(w => GRUPO_VENDAS.includes(w));
const pagina = (r, p) => r.gcCalls.some(c => c.path === '/vendas' && c.pagina === p);
const resumo = r => { const l = r.log.split('\n').find(x => x.startsWith('RESUMO_SYNC ')); return l ? JSON.parse(l.slice('RESUMO_SYNC '.length)) : null; };
const tem = (r, bloco, codigo) => ((resumo(r) || {}).falhas || []).some(f => f.bloco === bloco && f.codigo === codigo);

/** Comportamento APROVADO: nada do grupo de vendas é publicado, anterior intacto, workflow com erro. */
function esperaPreservacaoDeVendas(r) {
  expect(escritasDeVendas(r)).toEqual([]);
  expect(r.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas);          // inclusive o `_meta` de referência: NÃO atualizado
  expect(r.state.painel_cache.caixa).toEqual(PREVIO().painel_cache.caixa);
  expect(r.state.display_metrics.latest).toEqual(PREVIO().display_metrics.latest);
  expect(r.exitCode).not.toBe(0);
  expect(resumo(r).ok).toBe(false);
}
/** Falha de leitura de /vendas: o bloco de pedidos (mesma API) também é preservado; os blocos INDEPENDENTES seguem publicando. */
function esperaIndependencia(r) {
  expect(r.writes).not.toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest).toEqual(PREVIO().pedidos_cache.latest);
  for (const d of [...GRUPO_ESTOQUE, 'painel_cache/produtos_catalogo']) expect(r.writes).toContain(d);
}

describe('A2 #1 — HTTP 429 durante a paginação de /vendas', () => {
  let r; beforeAll(() => { r = rodar('vendas_pag2_429'); });
  test('precondição: a página 2 foi pedida (e re-pedida com limite de tentativas); credenciais só para o GC', () => {
    expect(pagina(r, 1) && pagina(r, 2)).toBe(true);
    expect(r.gcCalls.filter(c => c.path === '/vendas' && c.pagina === 2).length).toBeGreaterThanOrEqual(3);   // 3 tentativas por bloco que lê /vendas (vendas e pedidos)
    expect(r.gcCalls.every(c => c.host === 'api.gestaoclick.com' && c.temCredencial)).toBe(true);
  });
  test('nenhuma escrita, caches anteriores intactos, workflow com erro, código GC_429_ESGOTADO', () => { esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'GC_429_ESGOTADO')).toBe(true); });
  test('pedidos preservado; estoque e catálogo (independentes) continuam publicando', () => esperaIndependencia(r));
});

describe('A2 #1b — 429 TRANSITÓRIO na página 2 (uma vez) e depois dados completos', () => {
  test('retentativa limitada recupera: publica as 8 vendas completas e o workflow termina com sucesso', () => {
    const r = rodar('vendas_pag2_429_transitorio', {});
    expect(r.exitCode).toBe(0); expect(resumo(r).ok).toBe(true);
    expect(r.state.painel_cache.vendas.hoje).toBe(2150);                                 // 4 da página 1 + 4 da 2 (1750 + 400)
    expect(r.state.painel_cache.vendas._meta.vendasTotal).toBe(8);
  });
});

describe('A2 #2 — HTTP 500 durante a paginação de /vendas', () => {
  let r; beforeAll(() => { r = rodar('vendas_pag2_500'); });
  test('nenhuma escrita, anterior intacto, workflow com erro, código GC_HTTP_500', () => { esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'GC_HTTP_500')).toBe(true); });
  test('pedidos preservado; blocos independentes continuam', () => esperaIndependencia(r));
});

describe('A2 #3 — HTTP 200 com estrutura inválida (chave "dados" no lugar de "data")', () => {
  let r; beforeAll(() => { r = rodar('vendas_estrutura_invalida'); });
  test('NÃO publica zeros: nenhuma escrita, anterior intacto, workflow com erro, GC_RESPOSTA_INESPERADA', () => {
    esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'GC_RESPOSTA_INESPERADA')).toBe(true);
    expect(r.state.painel_cache.vendas.hoje).toBe(999); expect(r.state.painel_cache.vendas.mes).toBe(90000);
  });
  test('pedidos preservado; blocos independentes continuam', () => esperaIndependencia(r));
});

describe('A2 #4 — paginação incompleta (total_registros 12, entregues 8; página 3 vazia)', () => {
  let r; beforeAll(() => { r = rodar('vendas_pag_incompleta'); });
  test('precondição: as 3 páginas foram lidas', () => { expect(pagina(r, 1) && pagina(r, 2) && pagina(r, 3)).toBe(true); });
  test('NÃO publica 8 de 12: nenhuma escrita, anterior intacto, workflow com erro, GC_PAGINACAO_INCOMPLETA', () => { esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'GC_PAGINACAO_INCOMPLETA')).toBe(true); });
  test('pedidos preservado (não vira "8 pedidos"); blocos independentes continuam', () => esperaIndependencia(r));
});

describe('A2 — total_registros ALTERADO durante a paginação (8 ⇒ 9)', () => {
  let r; beforeAll(() => { r = rodar('vendas_total_muda'); });
  test('aborta: nada publicado, anterior intacto, workflow com erro, GC_PAGINACAO_INCONSISTENTE', () => { esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'GC_PAGINACAO_INCONSISTENTE')).toBe(true); });
  test('pedidos preservado; blocos independentes continuam', () => esperaIndependencia(r));
});

describe('A2 #7 — resultado VAZIO: inesperado (vendas) × legítimo (pagamentos)', () => {
  test('vendas vazio (HTTP 200, formato real) ⇒ GC_VAZIO_INESPERADO: NÃO substitui por zeros', () => {
    const r = rodar('vendas_vazio'); esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'GC_VAZIO_INESPERADO')).toBe(true);
    expect(r.state.painel_cache.vendas.mes).toBe(90000);
  });
  test('pagamentos vazio + financeiro anterior com 10 lançamentos ⇒ vazio INESPERADO sobre dado válido: preserva e alerta', () => {
    const r = rodar('ok', PREVIO({ vendasRef: 4 }));                                     // /pagamentos devolve vazio no formato real
    expect(r.writes).not.toContain('financeiro_cache/latest'); expect(r.state.financeiro_cache.latest).toEqual(PREVIO().financeiro_cache.latest);
    expect(tem(r, 'financeiro', 'PUBLICACAO_BLOQUEADA')).toBe(true); expect(r.exitCode).not.toBe(0);
  });
  test('pagamentos vazio SEM documento anterior (ausência legítima de movimentação) ⇒ publica lista vazia, sucesso', () => {
    const r = rodar('ok', {});
    expect(r.writes).toContain('financeiro_cache/latest'); expect(r.state.financeiro_cache.latest._meta.lancamentosTotal).toBe(0);
    expect(r.exitCode).toBe(0); expect(resumo(r).ok).toBe(true);
  });
  test('pagamentos vazio com anterior TAMBÉM vazio (0) ⇒ publica, sucesso', () => {
    const e = PREVIO({ vendasRef: 4 }); e.financeiro_cache.latest._meta.lancamentosTotal = 0;
    const r = rodar('ok', e); expect(r.writes).toContain('financeiro_cache/latest'); expect(tem(r, 'financeiro', 'PUBLICACAO_BLOQUEADA')).toBe(false);
  });
  test('HTTP 500 em /pagamentos NÃO é "vazio legítimo": nada publicado mesmo sem anterior; erro GC_HTTP_500', () => {
    const r = rodar('pagamentos_erro500', {});
    expect(r.writes).not.toContain('financeiro_cache/latest'); expect(tem(r, 'financeiro', 'GC_HTTP_500')).toBe(true); expect(r.exitCode).not.toBe(0);
  });
});

describe('A2 #8 — queda anormal de volume de vendas (referência _meta.vendasTotal = 118; chegam 1)', () => {
  let r; beforeAll(() => { r = rodar('vendas_queda'); });
  test('bloqueia a publicação (queda > 70%), preserva o anterior (inclusive a referência) e alerta', () => {
    esperaPreservacaoDeVendas(r); expect(tem(r, 'vendas', 'PUBLICACAO_BLOQUEADA')).toBe(true); expect(r.log).toMatch(/QUEDA_ACIMA_DO_LIMITE/);
  });
  test('Pedidos (10 ⇒ 1) continua sendo protegido pelo limite de 80% e agora também alerta', () => {
    expect(r.writes).not.toContain('pedidos_cache/latest'); expect(tem(r, 'pedidos', 'PUBLICACAO_BLOQUEADA')).toBe(true);
  });
  test('queda LEVE não bloqueia: referência 5 e 4 vendas (queda 20%) publica o grupo de vendas', () => {
    const o = rodar('ok', PREVIO({ vendasRef: 5 }), {}); expect(o.writes).toEqual(expect.arrayContaining(GRUPO_VENDAS));
  });
});

describe('A2 — referência `_meta.vendasTotal`: 1ª execução, virada de mês, escopo/janela diferentes e leitura falha', () => {
  test('1ª execução (documento anterior SEM `_meta`): publica e GRAVA a referência', () => {
    const e = PREVIO(); delete e.painel_cache.vendas._meta;
    const r = rodar('vendas_queda', e);                                                   // 1 venda — sem referência não há o que comparar
    expect(r.writes).toEqual(expect.arrayContaining(GRUPO_VENDAS)); expect(tem(r, 'vendas', 'PUBLICACAO_BLOQUEADA')).toBe(false);
    expect(r.state.painel_cache.vendas._meta).toMatchObject({ vendasTotal: 1, janelaDias: 30, escopo: 'padrao_sem_loja_id' });
  });
  test('1ª execução absoluta (nenhum documento de vendas): publica', () => {
    const e = PREVIO(); delete e.painel_cache.vendas; const r = rodar('ok', e);
    expect(r.writes).toEqual(expect.arrayContaining(GRUPO_VENDAS)); expect(r.state.painel_cache.vendas._meta.vendasTotal).toBe(4);
  });
  test('VIRADA DE MÊS não gera falso bloqueio: `mes` cai de 90.000 para 1.750, mas a referência é o nº de vendas da janela de 30 dias', () => {
    const e = PREVIO({ vendasRef: 4 }); delete e.financeiro_cache;
    const r = rodar('ok', e, { HARNESS_NOW: '2026-12-01T10:00:00-03:00' });
    expect(r.writes).toEqual(expect.arrayContaining(GRUPO_VENDAS)); expect(tem(r, 'vendas', 'PUBLICACAO_BLOQUEADA')).toBe(false);
    expect(r.state.painel_cache.vendas.mes).toBe(1750); expect(r.state.painel_cache.vendas.mes).toBeLessThan(PREVIO().painel_cache.vendas.mes * 0.3);
    expect(r.state.painel_cache.vendas._meta.vendasTotal).toBe(4);
  });
  test('referência de OUTRO escopo ou OUTRA janela não é comparável ⇒ tratada como 1ª execução', () => {
    for (const meta of [{ vendasTotal: 5000, janelaDias: 30, escopo: 'loja_262759' }, { vendasTotal: 5000, janelaDias: 7, escopo: 'padrao_sem_loja_id' }, { vendasTotal: 'x', janelaDias: 30, escopo: 'padrao_sem_loja_id' }, { vendasTotal: -3, janelaDias: 30, escopo: 'padrao_sem_loja_id' }]) {
      const e = PREVIO(); e.painel_cache.vendas._meta = meta; const r = rodar('ok', e);
      expect(r.writes).toEqual(expect.arrayContaining(GRUPO_VENDAS)); expect(tem(r, 'vendas', 'PUBLICACAO_BLOQUEADA')).toBe(false);
    }
  });
  test('FALHA DE LEITURA da referência NÃO é tratada como 1ª execução: bloqueia (REFERENCIA_ILEGIVEL) e preserva', () => {
    const r = rodar('ok', PREVIO({ vendasRef: 4 }), { HARNESS_FALHA_LEITURA: 'painel_cache/vendas' });
    expect(escritasDeVendas(r)).toEqual([]); expect(r.state.painel_cache.vendas).toEqual(PREVIO({ vendasRef: 4 }).painel_cache.vendas);
    expect(r.log).toMatch(/REFERENCIA_ILEGIVEL/); expect(r.exitCode).not.toBe(0);
  });
  test('execução parcial/reprovada NUNCA atualiza a referência (429, queda, total que muda)', () => {
    for (const modo of ['vendas_pag2_429', 'vendas_queda', 'vendas_total_muda', 'vendas_pag_incompleta', 'vendas_estrutura_invalida']) {
      const r = rodar(modo); expect(r.state.painel_cache.vendas._meta).toEqual(REF(118));
    }
  });
});

describe('A2 — FALHA DE GRAVAÇÃO e ATOMICIDADE dos grupos', () => {
  test('GRUPO VENDAS: falha em painel_cache/caixa ⇒ NENHUM dos 3 documentos é alterado (vendas, caixa, display_metrics) e a referência não muda', () => {
    const r = rodar('ok', PREVIO({ vendasRef: 4 }), { HARNESS_FALHA_ESCRITA: 'painel_cache/caixa' });
    expect(escritasDeVendas(r)).toEqual([]);
    expect(r.state.painel_cache.vendas).toEqual(PREVIO({ vendasRef: 4 }).painel_cache.vendas); expect(r.state.display_metrics.latest).toEqual(PREVIO().display_metrics.latest);
    expect(tem(r, 'vendas', 'GRAVACAO_FALHOU')).toBe(true); expect(r.exitCode).not.toBe(0);
    expect(r.log).toMatch(/lote atômico: nenhum documento foi alterado/);
  });
  test('GRUPO ESTOQUE: falha em estoque_custos ⇒ NENHUM dos 2 é alterado (consistentes entre si)', () => {
    const r = rodar('ok', PREVIO({ vendasRef: 4 }), { HARNESS_FALHA_ESCRITA: 'painel_cache/estoque_custos' });
    for (const d of GRUPO_ESTOQUE) expect(r.writes).not.toContain(d);
    expect(r.state.painel_cache.estoque).toEqual(PREVIO().painel_cache.estoque); expect(r.state.painel_cache.estoque_custos).toEqual(PREVIO().painel_cache.estoque_custos);
    expect(tem(r, 'estoque', 'GRAVACAO_FALHOU')).toBe(true); expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(expect.arrayContaining(GRUPO_VENDAS));                       // o grupo de vendas é INDEPENDENTE e foi publicado
  });
  test.each([['pedidos_cache/latest', 'pedidos'], ['painel_cache/produtos_catalogo', 'catalogo'], ['financeiro_cache/latest', 'financeiro']])('INDEPENDENTE %s: falha ⇒ só esse bloco falha (GRAVACAO_FALHOU) e os demais publicam', (doc, bloco) => {
    const e = PREVIO({ vendasRef: 4 }); e.pedidos_cache.latest._meta.pedidosTotal = 4; e.financeiro_cache.latest._meta.lancamentosTotal = 0;
    const r = rodar('ok', e, { HARNESS_FALHA_ESCRITA: doc });
    expect(r.writes).not.toContain(doc); expect(tem(r, bloco, 'GRAVACAO_FALHOU')).toBe(true); expect(r.exitCode).not.toBe(0);
    const outros = ['painel_cache/vendas', 'painel_cache/estoque', 'painel_cache/produtos_catalogo', 'pedidos_cache/latest', 'financeiro_cache/latest'].filter(d => d !== doc);
    for (const d of outros) expect(r.writes).toContain(d);
  });
});

describe('A2 — status do workflow e fluxo saudável', () => {
  test('fluxo saudável (modo ok, sem documentos anteriores): 8 documentos, `_meta` aditivo, RESUMO ok, exit 0', () => {
    const r = rodar('ok', {});
    expect(r.exitCode).toBe(0); expect(resumo(r)).toEqual({ ok: true, falhas: [] });
    expect([...r.writes].sort()).toEqual(['display_metrics/latest', 'financeiro_cache/latest', 'painel_cache/caixa', 'painel_cache/estoque', 'painel_cache/estoque_custos', 'painel_cache/produtos_catalogo', 'painel_cache/vendas', 'pedidos_cache/latest']);
    expect(r.state.painel_cache.vendas._meta).toMatchObject({ vendasTotal: 4, janelaDias: 30, escopo: 'padrao_sem_loja_id' });
    expect(r.diskWrites.filter(p => p !== process.env.HARNESS_OUT && !p.includes('a2-sync-'))).toEqual([]);
  });
  test('GestãoClick fora do ar (modo "falha"): todos os caches preservados, workflow com erro, GC_REDE no resumo', () => {
    const r = rodar('falha', PREVIO());
    expect(r.writes.filter(w => /^(painel_cache|display_metrics|pedidos_cache|financeiro_cache)\//.test(w))).toEqual([]);
    expect(r.exitCode).not.toBe(0); expect(tem(r, 'vendas', 'GC_REDE')).toBe(true); expect(tem(r, 'estoque', 'GC_REDE')).toBe(true);
    expect((r.log.match(/↩ Mantendo painel_cache/g) || []).length).toBe(3);
  });
  test('o resumo e os logs contêm só códigos e contagens: nenhum segredo, nome de cliente ou valor', () => {
    const r = rodar('vendas_pag2_429');
    expect(r.log).not.toContain('tok-a-FAKE'); expect(r.log).not.toContain('tok-s-FAKE'); expect(r.log).not.toMatch(/Vendedor [AB]/);
  });
});

describe('PROTEÇÕES ATUAIS preservadas — limites de anomalia de Pedidos (80%) e Financeiro (70%)', () => {
  const comPedidos = n => { const e = PREVIO({ vendasRef: 4 }); e.pedidos_cache.latest._meta.pedidosTotal = n; return e; };
  const comFinanceiro = n => { const e = PREVIO({ vendasRef: 4 }); e.financeiro_cache.latest._meta.lancamentosTotal = n; return e; };
  test('Pedidos (4 pedidos novos): anterior 10 ⇒ queda 60% ⇒ GRAVA', () => { const r = rodar('ok', comPedidos(10)); expect(r.writes).toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest.total).toBe(4); });
  test('Pedidos: anterior 20 ⇒ queda de exatamente 80% (não passa do limite) ⇒ GRAVA', () => { const r = rodar('ok', comPedidos(20)); expect(r.writes).toContain('pedidos_cache/latest'); });
  test('Pedidos: anterior 25 ⇒ queda 84% > 80% ⇒ PRESERVA e alerta', () => { const r = rodar('ok', comPedidos(25)); expect(r.writes).not.toContain('pedidos_cache/latest'); expect(r.state.pedidos_cache.latest.atualizado_em).toBe('ANTERIOR'); expect(tem(r, 'pedidos', 'PUBLICACAO_BLOQUEADA')).toBe(true); });
  test('Pedidos: sem documento anterior ⇒ GRAVA', () => { const e = PREVIO({ vendasRef: 4 }); delete e.pedidos_cache; const r = rodar('ok', e); expect(r.writes).toContain('pedidos_cache/latest'); });
  test('Financeiro (1 lançamento): anterior 3 ⇒ queda 66,7% ⇒ GRAVA', () => { const r = rodar('pagamentos_queda', comFinanceiro(3)); expect(r.writes).toContain('financeiro_cache/latest'); });
  test('Financeiro: anterior 4 ⇒ queda 75% > 70% ⇒ PRESERVA e alerta', () => { const r = rodar('pagamentos_queda', comFinanceiro(4)); expect(r.writes).not.toContain('financeiro_cache/latest'); expect(r.state.financeiro_cache.latest.atualizado_em).toBe('ANTERIOR'); expect(tem(r, 'financeiro', 'PUBLICACAO_BLOQUEADA')).toBe(true); });
  test('Financeiro: anterior 10 ⇒ queda 90% ⇒ PRESERVA; log registra a anomalia', () => { const r = rodar('pagamentos_queda', comFinanceiro(10)); expect(r.writes).not.toContain('financeiro_cache/latest'); expect(r.log).toMatch(/financeiro_cache\/latest preservado/); });
});

describe('ESTÁTICO — o script usa a camada segura e o workflow falha quando o script falha', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-dados.js'), 'utf8');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'sync-dados.yml'), 'utf8');
  test('sem laços while(true) de paginação, sem fetchGC/chamarGCComRetry; usa gcHttp, lerLista e batch atômico', () => {
    expect(src).not.toMatch(/while \(true\)/); expect(src).not.toMatch(/function (fetchGC|chamarGCComRetry)|await chamarGCComRetry/);
    expect(src).toMatch(/require\('\.\.\/functions\/lib\/gcHttp'\)/); expect((src.match(/await lerLista\(/g) || []).length).toBe(5);
    expect((src.match(/firestoreBatchSet\(\[/g) || []).length).toBe(2);
  });
  test('o único `JSON.parse(body)` restante é o do Perfil360 (gcReq360) — escopo da A3', () => {
    const ocorrencias = src.split('\n').filter(l => /JSON\.parse\(body\)/.test(l)); expect(ocorrencias).toHaveLength(1);
    expect(src.indexOf('JSON.parse(body)')).toBeGreaterThan(src.indexOf('async function syncPerfil360'));
  });
  test('falha ⇒ process.exitCode = 1 e RESUMO_SYNC; permitirVazio SÓ no bloco de pagamentos', () => {
    expect(src).toMatch(/process\.exitCode = 1/); expect(src).toMatch(/RESUMO_SYNC/);
    expect((src.match(/permitirVazio: true/g) || []).length).toBe(1); expect(src.indexOf('permitirVazio: true')).toBeGreaterThan(src.indexOf('async function syncFinanceiro'));
    expect(src.indexOf('permitirVazio: true')).toBeLessThan(src.indexOf('async function syncPedidos'));
  });
  test('workflow: o passo executa o script SEM continue-on-error (exit ≠ 0 ⇒ job vermelho)', () => {
    expect(wf).toMatch(/run: node scripts\/sync-dados\.js/); expect(wf).not.toMatch(/continue-on-error/);
  });
  test('o campo aditivo `_meta` não interfere nos consumidores: nenhuma tela o usa nem enumera o documento inteiro', () => {
    for (const f of ['modulos/vendas.html', 'modulos/caixa.html', 'modulos/estoque.html']) {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect({ f, usaMeta: /\._meta|\['_meta'\]/.test(t), enumera: /Object\.(keys|entries|values)\((data|snap\.data\(\))\)|JSON\.stringify\(data\)/.test(t) }).toEqual({ f, usaMeta: false, enumera: false });
    }
  });
});
