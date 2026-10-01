'use strict';
// FINANCEIRO Fase 2 · sync FULL: trava, geração, troca atômica do ponteiro, falhas, idempotência, logs sem PII, GET-only.
const S = require('../lib/financeiro/sync');
const P = require('../lib/financeiro/publicacao');
const A = require('../lib/financeiro/agregados');
const { gcFalso, dbFalso, massa } = require('./fixtures/financeiro-f2');
const AGORA = new Date('2026-09-28T15:00:00Z'), HOJE = '2026-09-28';
const depois = min => new Date(AGORA.getTime() + min * 60000);
const dados = massa({ hoje: HOJE, nPagar: 60, nReceber: 120 });
const rodar = (db, extra = {}, gcOpts = {}) => { const gc = gcFalso({ ...dados, ...gcOpts }); const logs = []; return S.executarSyncFinanceiro({ cli: gc.cli, db, agora: AGORA, log: e => logs.push(e), ...extra }).then(r => ({ r, gc, logs })); };
const ativo = db => db.ler('fin_n1', 'active');
jest.setTimeout(60000);

describe('publicação por geração', () => {
  test('sucesso: ponteiro aponta para a geração nova; resumo, entidades e fatias existem; meta ok; trava liberada', async () => {
    const db = dbFalso(); const { r } = await rodar(db);
    expect(r.ok).toBe(true);
    const a = ativo(db); expect(a.geracao).toBe(r.geracao); expect(a.anterior).toBeNull();
    expect(db.ler('fin_n1_resumo', a.resumo_id).geracao).toBe(r.geracao); expect(db.ler('fin_n1_resumo', a.entidades_id)).toBeTruthy();
    const nFatias = a.ids.filter(id => /__(PAGAR|RECEBER)__/.test(id)).length; expect(nFatias).toBe(a.fatias); expect(nFatias).toBeGreaterThan(0);
    for (const id of a.ids) expect(db.ler(/__(resumo|entidades)$/.test(id) ? 'fin_n1_resumo' : 'fin_n1_titulos', id)).toBeTruthy();
    expect(db.ler('fin_n1', 'meta')).toMatchObject({ ultima_tentativa_ok: true, geracao_ativa: r.geracao, erro: null }); expect(db.ler('fin_n1_meta', 'x')).toBeUndefined();
    expect(db.ler('fin_n1_ctl', 'lock')).toBeUndefined();
    expect(db.ler('fin_n1', 'meta').pendente).toBeUndefined();
  });
  test('retenção de gerações: ativa + anterior ficam; a terceira apaga a primeira (sem deixar lixo)', async () => {
    const db = dbFalso(); const g = [];
    for (let i = 0; i < 3; i++) { const gc = gcFalso(dados); const r = await S.executarSyncFinanceiro({ cli: gc.cli, db, agora: depois(i * 10), log: () => {} }); expect(r.ok).toBe(true); g.push(r.geracao); }
    const ids = [...Object.keys(db.st.fin_n1_resumo || {}), ...Object.keys(db.st.fin_n1_titulos || {})];
    expect(ids.every(id => id.startsWith(g[1]) || id.startsWith(g[2]))).toBe(true); expect(ids.some(id => id.startsWith(g[0]))).toBe(false);
    expect(ativo(db).anterior.geracao).toBe(g[1]);
  });
  test('IDEMPOTÊNCIA: mesma fonte duas vezes → mesmos agregados e mesmos detalhes (só geração e horário mudam)', async () => {
    const db = dbFalso(); const gcA = gcFalso(dados), gcB = gcFalso(dados);
    const a = await S.executarSyncFinanceiro({ cli: gcA.cli, db, agora: AGORA, log: () => {} });
    const resA = JSON.parse(JSON.stringify(db.ler('fin_n1_resumo', ativo(db).resumo_id))); const fatA = ativo(db).ids.filter(i => /__(PAGAR|RECEBER)__/.test(i)).map(i => db.ler('fin_n1_titulos', i).itens);
    const b = await S.executarSyncFinanceiro({ cli: gcB.cli, db, agora: depois(5), log: () => {} });
    const resB = db.ler('fin_n1_resumo', ativo(db).resumo_id); const fatB = ativo(db).ids.filter(i => /__(PAGAR|RECEBER)__/.test(i)).map(i => db.ler('fin_n1_titulos', i).itens);
    const norm = x => { const o = JSON.parse(JSON.stringify(x)); delete o.geracao; delete o.gerado_em; return o; };
    expect(a.ok && b.ok).toBe(true); expect(a.geracao).not.toBe(b.geracao); expect(norm(resB)).toEqual(norm(resA)); expect(fatB).toEqual(fatA);
  });
});

describe('falha não troca o ponteiro (geração anterior continua ativa)', () => {
  const comAtiva = async () => { const db = dbFalso(); await rodar(db); return { db, antes: JSON.stringify(ativo(db)), ids: JSON.stringify(Object.keys(db.st.fin_n1_titulos).sort()) }; };
  const verifica = async (db, antes, ids, r) => {
    expect(r.ok).toBe(false); expect(JSON.stringify(ativo(db))).toBe(antes);
    const lidos = Object.keys(db.st.fin_n1_titulos).sort(); const novos = lidos.filter(i => !JSON.parse(ids).includes(i));
    expect(novos).toEqual([]);                                                       // nada da geração falha ficou visível/sobrando
    expect(db.ler('fin_n1', 'meta')).toMatchObject({ ultima_tentativa_ok: false, geracao_ativa: JSON.parse(antes).geracao }); expect(db.ler('fin_n1_ctl', 'lock')).toBeUndefined();
  };
  const gcAgora = (extra) => ({ r: null, extra });
  test.each([
    ['erro na página 1', { http: (p, n, u) => (p === '/pagamentos' ? 500 : null) }],
    ['erro numa página intermediária', { http: (p, n, u) => (p === '/recebimentos' && n >= 1 && u.searchParams.get('data_inicio') === '2026-01-01' ? 500 : null) }],
    ['timeout persistente', { timeout: (p) => p === '/recebimentos' }],
    ['JSON inválido persistente', { jsonInvalido: (p) => p === '/pagamentos' }],
    ['resposta parcial (total maior que o entregue)', { total: (p) => (p === '/pagamentos' ? 3 : 0) }],
    ['rate limit persistente', { http: (p) => (p === '/compras' ? 429 : null) }],
  ])('%s', async (_, falhas) => {
    const { db, antes, ids } = await comAtiva(); const { r } = await rodar(db, { agora: undefined, }, { falhas }).catch(e => ({ r: { ok: false } }));
    await verifica(db, antes, ids, r);
  });
  test('falha de gravação no meio do lote: o que foi gravado é apagado e o ponteiro não muda', async () => {
    const { db, antes, ids } = await comAtiva(); let n = 0;
    db.hook = ({ op, col }) => { if (op === 'batchset' && col === 'fin_n1_titulos' && ++n > 2) throw new Error('FIRESTORE_INDISPONIVEL'); };
    const { r } = await rodar(db, { agora: depois(30) }); db.hook = null;
    await verifica(db, antes, ids, r);
  });
  test('falha de validação (fatia sumiu depois de gravar) → não publica', async () => {
    const { db, antes, ids } = await comAtiva(); let lidos = 0;
    db.hook = ({ op, col, id }) => { if (op === 'get' && col === 'fin_n1_titulos' && id.includes('__RECEBER__') && ++lidos === 1) { delete db.st.fin_n1_titulos[id]; } };
    const { r } = await rodar(db, { agora: depois(30) }); db.hook = null;
    await verifica(db, antes, ids, r);
  });
  test('trava perdida antes da troca (outra execução assumiu) → NÃO troca o ponteiro', async () => {
    const { db, antes, ids } = await comAtiva();
    db.hook = ({ op, col }) => { if (op === 'txget' && col === 'fin_n1_ctl') { db.st.fin_n1_ctl = { lock: { run_id: 'OUTRA', expires_at: '2099-01-01T00:00:00Z' } }; } };
    const { r } = await rodar(db, { agora: depois(30) }); db.hook = null;
    expect(r.ok).toBe(false); expect(JSON.stringify(ativo(db))).toBe(antes);
    expect(Object.keys(db.st.fin_n1_titulos).sort().join()).toBe(JSON.parse(ids).join());
  });
});

describe('trava (lock com lease)', () => {
  test('execuções simultâneas: só uma roda; a outra é ignorada com LOCK_ATIVO e não escreve nada', async () => {
    const db = dbFalso(); const gc1 = gcFalso(dados), gc2 = gcFalso(dados); const logs = [];
    const [a, b] = await Promise.all([S.executarSyncFinanceiro({ cli: gc1.cli, db, agora: AGORA, runId: 'r1', log: e => logs.push(e) }), S.executarSyncFinanceiro({ cli: gc2.cli, db, agora: AGORA, runId: 'r2', log: e => logs.push(e) })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]); expect([a, b].find(x => !x.ok).motivo).toBe('LOCK_ATIVO');
    expect((gc1.chamadas.length === 0) !== (gc2.chamadas.length === 0)).toBe(true);               // a perdedora nem falou com o ERP
    expect(Object.keys(db.st.fin_n1_resumo)).toHaveLength(2);                                      // uma só geração
  });
  test('trava vencida (processo morreu) é recuperada; trava válida de outro dono bloqueia', async () => {
    const db = dbFalso({ fin_n1_ctl: { lock: { run_id: 'MORTO', acquired_at: '2026-09-28T10:00:00Z', expires_at: '2026-09-28T10:25:00Z' } } });
    const { r, logs } = await rodar(db); expect(r.ok).toBe(true); expect(logs.some(l => l.evento === 'lock_recuperado')).toBe(true);
    const db2 = dbFalso({ fin_n1_ctl: { lock: { run_id: 'VIVO', acquired_at: '2026-09-28T14:50:00Z', expires_at: '2026-09-28T15:15:00Z' } } });
    const { r: r2 } = await rodar(db2); expect(r2.ok).toBe(false); expect(r2.motivo).toBe('LOCK_ATIVO'); expect(db2.ler('fin_n1_ctl', 'lock').run_id).toBe('VIVO');
  });
  test('crash no meio: lease expira e a próxima execução limpa a geração órfã e publica', async () => {
    const db = dbFalso(); let n = 0;
    db.hook = ({ op, col }) => { if (op === 'batchset' && col === 'fin_n1_titulos' && ++n > 1) { const e = new Error('PROCESSO_MORTO'); throw e; } };
    const gc = gcFalso(dados); const r1 = await S.executarSyncFinanceiro({ cli: gc.cli, db, agora: AGORA, log: () => {} }); db.hook = null;
    expect(r1.ok).toBe(false); expect(ativo(db)).toBeUndefined();
    db.st.fin_n1_ctl = { lock: { run_id: 'x', acquired_at: AGORA.toISOString(), expires_at: depois(25).toISOString() } };            // simula o lock do processo morto
    const gc2 = gcFalso(dados); const r2 = await S.executarSyncFinanceiro({ cli: gc2.cli, db, agora: depois(60), log: () => {} });
    expect(r2.ok).toBe(true); const a = ativo(db); const tudo = Object.keys(db.st.fin_n1_titulos);
    expect(tudo.every(id => a.ids.includes(id))).toBe(true);                                       // nada órfão
  });
  test('renovação (heartbeat) estende a lease e só o dono renova; liberar só o dono', async () => {
    const db = dbFalso();
    expect((await P.adquirirLock(db, { runId: 'A', agora: AGORA })).ok).toBe(true);
    expect((await P.adquirirLock(db, { runId: 'B', agora: depois(5) })).ok).toBe(false);
    expect(await P.renovarLock(db, 'B', depois(6))).toBe(false); expect(await P.renovarLock(db, 'A', depois(20))).toBe(true);
    expect((await P.adquirirLock(db, { runId: 'B', agora: depois(40) })).ok).toBe(false);          // renovada até +45
    expect(await P.liberarLock(db, 'B')).toBe(false); expect(await P.liberarLock(db, 'A')).toBe(true);
    expect((await P.adquirirLock(db, { runId: 'B', agora: depois(41) })).ok).toBe(true);
  });
});

describe('logs, GET-only e escopo temporal', () => {
  test('log estruturado: run_id, tipo, início/fim, duração, páginas, títulos, retries, status, geração; sem PII', async () => {
    const db = dbFalso(); const { logs, r } = await rodar(db);
    const ini = logs.find(l => l.evento === 'inicio'), fim = logs.find(l => l.evento === 'fim');
    expect(ini).toMatchObject({ componente: 'financeiroSync', tipo: 'FULL' }); expect(ini.run_id).toBeTruthy();
    expect(fim).toMatchObject({ status: 'OK', geracao: r.geracao, run_id: ini.run_id }); for (const k of ['duracao_ms', 'paginas', 'titulos', 'retries', 'gets', 'documentos']) expect(typeof fim[k]).toBe('number');
    const txt = JSON.stringify(logs); expect(txt).not.toMatch(/Fictício|Despesa|Venda de nº|Compra de nº|nome_|cpf|cnpj|@|tok-FAKE|sec-FAKE/i);
  });
  test('log de erro é sanitizado (sem ids longos nem e-mails)', () => {
    expect(S.sanitizarErro(new Error('falha para joao@x.com no título 123456789'))).toBe('falha para [email] no título #');
  });
  test('GESTAOCLICK_WRITES=0: toda a varredura (títulos + referências + índices) só faz GET', async () => {
    const { gc } = await rodar(dbFalso()); expect(gc.chamadas.length).toBeGreaterThan(100); expect(new Set(gc.chamadas.map(c => c.method))).toEqual(new Set(['GET']));
  });
  test('a janela cobre histórico antigo e futuro: início 2015, fim hoje+730 dias', async () => {
    const { r } = await rodar(dbFalso()); expect(r.estatisticas.janela).toEqual({ inicio: '2015-01-01', fim: '2028-09-27' });
  });
  test('erro na tomada da trava não derruba o agendador (retorna resultado, não lança)', async () => {
    const db = dbFalso(); db.hook = ({ op, col }) => { if (op === 'txget' && col === 'fin_n1_ctl') throw new Error('FIRESTORE_FORA'); };
    const { r } = await rodar(db); expect(r).toMatchObject({ ok: false, motivo: 'LOCK_ERRO' });
  });
});

describe('rollback de dados (ponteiro volta para a geração anterior, sem apagar nada)', () => {
  test('publica 2 gerações, reverte: ativa = primeira, segunda preservada como anterior; sem anterior → recusa; trava respeitada', async () => {
    const db = dbFalso(); const g = [];
    for (let i = 0; i < 2; i++) { const gc = gcFalso(dados); const r = await S.executarSyncFinanceiro({ cli: gc.cli, db, agora: depois(i * 10), log: () => {} }); g.push(r.geracao); }
    const antes = Object.keys(db.st.fin_n1_titulos).length;
    const rv = await P.reverterParaAnterior(db, { runId: 'rb1', agora: depois(30) });
    expect(rv).toEqual({ ok: true, geracao: g[0] }); const a = ativo(db);
    expect(a.geracao).toBe(g[0]); expect(a.anterior.geracao).toBe(g[1]); expect(a.resumo_id).toBe(g[0] + '__resumo'); expect(db.ler('fin_n1_resumo', a.resumo_id).geracao).toBe(g[0]);
    expect(Object.keys(db.st.fin_n1_titulos).length).toBe(antes); expect(db.ler('fin_n1_ctl', 'lock')).toBeUndefined();
    const db2 = dbFalso(); await rodar(db2); expect((await P.reverterParaAnterior(db2, { runId: 'rb2' })).motivo).toBe('SEM_GERACAO_ANTERIOR');
    await P.adquirirLock(db2, { runId: 'outro', agora: AGORA }); expect((await P.reverterParaAnterior(db2, { runId: 'rb3', agora: depois(1) })).motivo).toBe('LOCK_ATIVO');
  });
});
