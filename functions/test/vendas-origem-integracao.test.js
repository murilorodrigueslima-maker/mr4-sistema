'use strict';
// Reconciliação de vendas excluídas/canceladas — integração: Compras (sobreposição), validação somente leitura, operação (CLI) e Job do sync.
const { spawnSync } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const F = require('./fixtures/vendas-origem');
const S = require('../lib/compras/snapshot');
const X = require('./fixtures/compras-estoque-f0');
const G = require('./fixtures/compras-gc-falso');
const V = require('../lib/vendasOrigem/validacao');
const CLI = require('../../scripts/reconciliar-vendas-excluidas');
jest.setTimeout(300000);

describe('Compras: sobreposição no incremental', () => {
  const AG1 = new Date('2026-09-28T06:00:00Z'), AG2 = new Date('2026-09-28T12:00:00Z');
  const prods = [X.produto('P1', { estoque: 5 })];
  const alvo = X.venda('2026-09-20', [['P1', 30]], { id: 'VX-ALVO' }), outra = X.venda('2026-09-21', [['P1', 4]], { id: 'VX-OUTRA' });
  const comColecoes = (db, modo, candidatos) => {
    const orig = db.collection;
    db.collection = c => {
      if (c === 'vendas_origem_config') return { doc: () => ({ get: async () => ({ exists: !!modo, data: () => ({ modo, aprovadoPor: 'integrador', aprovadoEm: '2026-09-28T00:00:00Z' }) }) }) };
      if (c === 'vendas_origem_candidatos') return { where: (campo, op, v) => ({ get: async () => ({ docs: candidatos.filter(x => x[campo] === v).map(x => ({ data: () => x })) }) }) };
      return orig(c);
    };
    return db;
  };
  async function rodar(modo, candidatos, vendasNaLeitura = [outra]) {
    const db = G.criarDbFalso();
    await S.executarSync({ cli: G.criarGcFalso({ produtos: prods, vendas: [alvo, outra] }).cli, db, agora: AG1 });
    comColecoes(db, modo, candidatos);
    const r = await S.executarSyncIncremental({ cli: G.criarGcFalso({ produtos: prods, vendas: vendasNaLeitura }).cli, db, agora: AG2 });
    expect(r.ok).toBe(true);
    const base = (await S.carregarBase(db)).vendas.find(v => v.id === 'VX-ALVO');
    const demanda = db.ler('compras_n0_produtos', 'bloco_000').produtos.find(m => m.product_id === 'P1').suggestion.sales;
    return { r, base, demanda: JSON.stringify(demanda), meta: db.ler('compras_n0', 'meta') };
  }
  const ativa = [{ vendaId: 'VX-ALVO', classe: 'NAO_ENCONTRADA', invalidacaoAtiva: true }];
  test('APLICAR: sai da demanda, mas a base gravada continua com o registro ORIGINAL', async () => {
    const sem = await rodar(null, ativa), com = await rodar('APLICAR', ativa);
    expect(com.demanda).not.toBe(sem.demanda);
    expect(com.base).toEqual(sem.base); expect(com.base.nome_situacao).toBe('Concretizada'); expect(com.base.situacao_estoque).toBe('1');
    expect(com.meta.estatisticas.vendas_invalidadas_na_origem).toBe(1); expect(sem.meta.estatisticas.vendas_invalidadas_na_origem).toBeUndefined();
    expect(com.r.snapshot.base.vendas.find(v => v.id === 'VX-ALVO').situacao_estoque).toBe('0');   // histórico usa o cálculo corrigido
  });
  test('SOMBRA, candidata inativa ou venda que voltou na leitura: nada muda', async () => {
    const ref = await rodar(null, []);
    for (const x of [await rodar('SOMBRA', ativa), await rodar('APLICAR', [{ ...ativa[0], invalidacaoAtiva: false }])]) expect(x.demanda).toBe(ref.demanda);
    const voltouRef = await rodar(null, [], [alvo, outra]), voltou = await rodar('APLICAR', ativa, [alvo, outra]);
    expect(voltou.demanda).toBe(voltouRef.demanda);
  });
  test('falha ao ler as invalidações no modo APLICAR: incremental falha e preserva o último snapshot', async () => {
    const db = G.criarDbFalso();
    await S.executarSync({ cli: G.criarGcFalso({ produtos: prods, vendas: [alvo, outra] }).cli, db, agora: AG1 });
    const antes = JSON.stringify(db.st.compras_n0_produtos);
    comColecoes(db, 'APLICAR', null);
    expect((await S.executarSyncIncremental({ cli: G.criarGcFalso({ produtos: prods, vendas: [outra] }).cli, db, agora: AG2 })).ok).toBe(false);
    expect(JSON.stringify(db.st.compras_n0_produtos)).toBe(antes);
  });
});

describe('validação somente leitura', () => {
  async function rodar() {
    const ALVO = '415281034';
    const m = await F.criarMundo({ extras: [F.gcVenda(ALVO, '2026-11-25')] });
    m.gc.vendas.set(ALVO, { ...m.gc.vendas.get(ALVO), nome_situacao: 'Cancelada', situacao_id: '3952594' }); m.gc.foraDaLista.add(ALVO);
    const antes = JSON.stringify([...m.db.dados].map(([k, v]) => [k, [...v]]));
    const proibida = () => { throw new Error('ESCRITA_PROIBIDA'); };
    const db = { collection: m.db.collection, runTransaction: proibida, batch: proibida };
    const linhas = [];
    const r = await V.validar({ db, transporte: m.gc.transporte, credenciais: { access: 'tok-FAKE', secret: 'sec-FAKE' }, agora: new Date(F.T0), opcoes: V.lerOpcoes([`--vendas=${ALVO}`, '--dias=60']), saida: l => linhas.push(l), dormir: async () => {} });
    const depois = JSON.stringify([...m.db.dados].filter(([, v]) => v.size).map(([k, v]) => [k, [...v]]));
    return { r, linhas, m, antes, depois, de: tag => linhas.filter(l => l.startsWith(`VEXC_${tag} `)).map(l => JSON.parse(l.slice(tag.length + 6))) };
  }
  test('mostra candidata, comportamento da API e orçamento, sem escrever e sem dados pessoais/valores', async () => {
    const x = await rodar();
    expect(x.r.ok).toBe(true); expect(x.depois).toBe(x.antes);
    expect(x.linhas.every(l => l.startsWith('VEXC_'))).toBe(true);
    expect(x.linhas.join('\n')).not.toMatch(/SECRETO|cliente_id|valor_total|100\.00|tok-FAKE|sec-FAKE/);
    expect(x.de('AUSENTES')[0].itens).toEqual(['415281034']);
    expect(x.de('FILTRO_CANCELADAS')[0]).toMatchObject({ total: 1, tambem_na_lista_padrao: 0, ativas_no_mr4: 1, ausentes_cobertas: 1 });
    expect(x.de('CANDIDATO')[0]).toMatchObject({ id: '415281034', classe: 'CANCELADA', fonte: 'CONSULTA_POR_ID', no_filtro_canceladas: true, impacto: { vinculos_carteira: { total: 0 }, na_expedicao: false } });
    expect(x.de('SONDA_INEXISTENTE')[0]).toMatchObject({ http: 404, reconhecida_como_nao_encontrada: true });
    expect(x.de('ORCAMENTO')[0]).toMatchObject({ escritas_firestore: 0, escritas_gc: 0 });
    expect(x.m.gc.chamadas.every(c => c.method === 'GET' && c.loja === '262759')).toBe(true);
  });
  test('invólucro de leitura não expõe escrita', () => {
    const db = V.somenteLeitura(require('./helpers/fakeFirestore').criarFake(), { leituras: 0 });
    const d = db.collection('vendas_gc').doc('1');
    for (const m of ['set', 'update', 'delete', 'create']) { expect(d[m]).toBeUndefined(); expect(db.collection('x')[m]).toBeUndefined(); }
    expect(db.batch).toBeUndefined(); expect(db.runTransaction).toBeUndefined();
  });
  test('opções inválidas são recusadas', () => { for (const a of ['--dias=0', '--dias=9999', '--vendas=abc', '--gravar', '--max-requisicoes=1000']) expect(() => V.lerOpcoes([a])).toThrow(); });
});

describe('operação (CLI)', () => {
  const silencio = () => jest.spyOn(console, 'log').mockImplementation(() => {});
  const env = { GC_ACCESS_TOKEN: 'a', GC_SECRET_ACCESS_TOKEN: 'b' };
  test('argumentos: escrita exige --por; padrão é validação', () => {
    expect(CLI.lerAcao(['--dias=30'])).toBe(null); expect(CLI.lerAcao([])).toBe(null);
    for (const a of [['--definir-modo=APLICAR'], ['--definir-modo=XYZ', '--por=ana'], ['--reverter=abc', '--por=ana'], ['--reverter=1', '--status'], ['--status', '--dias=3']]) expect(() => CLI.lerAcao(a)).toThrow();
  });
  test('sem --confirmar nada é gravado; com --confirmar define o modo com aprovação identificada e trilha', async () => {
    const log = silencio(); const m = await F.criarMundo({ fundo: 1 });
    await CLI.principal(['--definir-modo=APLICAR', '--por=integrador'], env, { db: m.db, transporte: m.gc.transporte });
    expect(await m.doc('vendas_origem_config', 'reconciliacao')).toBe(null);
    await CLI.principal(['--definir-modo=APLICAR', '--por=integrador', '--confirmar'], env, { db: m.db, transporte: m.gc.transporte });
    expect(await m.doc('vendas_origem_config', 'reconciliacao')).toMatchObject({ modo: 'APLICAR', aprovadoPor: 'integrador' });
    expect(Object.values(await m.col('vendas_origem_trilha'))[0]).toMatchObject({ acao: 'definir-modo', para: 'APLICAR' });
    expect(m.gc.chamadas).toHaveLength(0);
    await new Promise(r => setTimeout(r, 5));
    await CLI.principal(['--definir-modo=SOMBRA', '--por=integrador', '--confirmar'], env, { db: m.db, transporte: m.gc.transporte });
    const volta = await m.doc('vendas_origem_config', 'reconciliacao'); expect(volta.modo).toBe('SOMBRA'); expect(volta.aprovadoPor).toBeUndefined(); log.mockRestore();
  });
  test('reverter todas: devolve o espelho, bloqueia e respeita a trava do sync', async () => {
    const log = silencio(); const ALVO = '415281034';
    const m = await F.criarMundo({ extras: [F.gcVenda(ALVO, '2026-11-25')] }); const original = await m.doc('vendas_gc', ALVO);
    await m.modo('APLICAR'); m.gc.vendas.delete(ALVO); await m.vezes(5); expect((await m.cand(ALVO)).invalidacaoAtiva).toBe(true);
    await m.db.collection('gc_sync_lock').doc('sync-dados').set({ expiraEm: Date.now() + 1e12 });
    await CLI.principal(['--reverter=todas', '--por=integrador', '--confirmar'], env, { db: m.db, transporte: m.gc.transporte });
    expect((await m.cand(ALVO)).invalidacaoAtiva).toBe(true);
    await m.db.collection('gc_sync_lock').doc('sync-dados').set({ expiraEm: 0 });
    await CLI.principal(['--reverter=todas', '--por=integrador', '--confirmar'], env, { db: m.db, transporte: m.gc.transporte });
    expect(await m.doc('vendas_gc', ALVO)).toEqual(original);
    expect(await m.cand(ALVO)).toMatchObject({ invalidacaoAtiva: false, bloqueada: true });
    const linhas = log.mock.calls.map(c => c[0]); expect(linhas.join('\n')).toMatch(/VEXC_REVERSAO/); log.mockRestore();
  });
});

describe('Cloud Run Job: gancho no sync', () => {
  const ROOT = path.resolve(__dirname, '../..'), HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
  function rodar(estado, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexc-')), st = path.join(dir, 's.json'), out = path.join(dir, 'o.json'); fs.writeFileSync(st, JSON.stringify(estado));
    const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], { cwd: ROOT, timeout: 120000, encoding: 'utf8',
      env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: 'ok', HARNESS_STATE: st, HARNESS_OUT: out, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '', GITHUB_ACTIONS: '', CLOUD_RUN_JOB: 'mr4-sync-job', CLOUD_RUN_EXECUTION: 'x', ...env } });
    return { ...JSON.parse(fs.readFileSync(out, 'utf8')), exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
  }
  const sombra = () => ({ vendas_origem_config: { reconciliacao: { modo: 'SOMBRA' } } });
  const proprias = w => w.filter(x => x.startsWith('vendas_origem_'));
  test('desligada: o sync é idêntico (nenhuma linha VEXC, nenhuma escrita própria)', () => { const r = rodar({}); expect(r.exitCode).toBe(0); expect(r.log).not.toMatch(/VEXC/); expect(proprias(r.writes)).toEqual([]); });
  test('sombra: roda depois dos blocos, dentro da trava, e só escreve nas coleções próprias', () => {
    const a = rodar({}), r = rodar(sombra());
    expect(r.exitCode).toBe(0); expect(r.log).toMatch(/VEXC_SYNC status=(OK|ANOMALIA|FALHA)/);
    expect(r.writes.filter(w => !w.startsWith('vendas_origem_'))).toEqual(a.writes);
    expect(r.writes.indexOf('vendas_origem_estado/lease')).toBeGreaterThan(r.writes.indexOf('gc_sync_status/ultima'));
    expect(r.writes.lastIndexOf('gc_sync_lock/sync-dados')).toBeGreaterThan(r.writes.lastIndexOf('vendas_origem_estado/lease'));
  });
  test('falha da reconciliação não derruba o sync', () => {
    const r = rodar(sombra(), { HARNESS_FALHA_LEITURA: 'vendas_origem_config/reconciliacao' }); expect(r.exitCode).toBe(0); expect(r.log).toMatch(/VEXC_SYNC falhou \(isolado\) codigo=/); expect(r.log).not.toMatch(/leitura simulada/);
  });
  test('execução direcionada (BLOCOS) não roda a reconciliação', () => { const r = rodar(sombra(), { BLOCOS: 'estoque' }); expect(r.log).not.toMatch(/VEXC/); expect(proprias(r.writes)).toEqual([]); });
});
