'use strict';
// Trava transacional compartilhada (Cloud Run Job × GitHub Actions), intervalo mínimo e execução direcionada por blocos. Harness: sem rede/Firestore real.
const { spawnSync } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
jest.setTimeout(300000);
const ROOT = path.resolve(__dirname, '../..'), HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
const AGORA = Date.parse('2026-11-25T12:00:00-03:00');
const base = () => ({ painel_cache: { vendas: { _meta: { vendasTotal: 4, janelaDias: 30, escopo: 'loja_262759' } }, estoque: { total_produtos: 3 }, produtos_catalogo: { total: 3, itens: [] } }, pedidos_cache: { latest: { total: 1, _meta: { pedidosTotal: 1 } } }, financeiro_cache: { latest: { _meta: { lancamentosTotal: 1 } } } });
function rodar(estado, env = {}, modo = 'ok') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trv-')), st = path.join(dir, 's.json'), out = path.join(dir, 'o.json'); fs.writeFileSync(st, JSON.stringify(estado));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], { cwd: ROOT, timeout: 120000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out, HARNESS_NOW: new Date(AGORA).toISOString(), GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '', GITHUB_ACTIONS: '', CLOUD_RUN_JOB: '', CLOUD_RUN_EXECUTION: '', GITHUB_RUN_ID: '', ...env } });
  return { ...JSON.parse(fs.readFileSync(out, 'utf8')), exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
}
const lock = r => r.state.gc_sync_lock && r.state.gc_sync_lock['sync-dados'];
const CR = { CLOUD_RUN_JOB: 'mr4-sync-job', CLOUD_RUN_EXECUTION: 'mr4-sync-job-abc12' }, GH = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '999' };

describe('trava compartilhada', () => {
  test('execução normal adquire e LIBERA a trava (expiraEm = 0) e sincroniza tudo', () => {
    const r = rodar({}, CR); expect(r.exitCode).toBe(0); expect(r.log).toMatch(/TRAVA_ADQUIRIDA origem=cloudrun/);
    expect(lock(r).expiraEm).toBe(0); expect(lock(r).origem).toBe('cloudrun'); expect(r.writes).toContain('gc_sync_status/ultima'); expect(r.state.gc_sync_status.ultima.ultimaExecucao.origem).toBe('cloudrun');
  });
  test('trava em uso por outra origem (GitHub) ⇒ o Job IGNORA (exit 0), não escreve nada de dados e NÃO mexe na trava alheia', () => {
    const e = base(); e.gc_sync_lock = { 'sync-dados': { detentor: 'github-777', origem: 'github', adquiridaEm: AGORA - 60000, expiraEm: AGORA + 20 * 60000 } };
    const r = rodar(e, CR); expect(r.exitCode).toBe(0); expect(r.log).toMatch(/SYNC_IGNORADO_TRAVA/); expect(r.writes.filter(w => !w.startsWith('gc_sync_lock'))).toEqual([]); expect(lock(r).detentor).toBe('github-777');
  });
  test('e o inverso: GitHub ignora quando o Job detém a trava', () => {
    const e = base(); e.gc_sync_lock = { 'sync-dados': { detentor: 'cloudrun-x', origem: 'cloudrun', adquiridaEm: AGORA, expiraEm: AGORA + 10 * 60000 } };
    const r = rodar(e, GH); expect(r.log).toMatch(/SYNC_IGNORADO_TRAVA/); expect(r.exitCode).toBe(0); expect(r.writes.filter(w => !w.startsWith('gc_sync_lock'))).toEqual([]);
  });
  test('trava EXPIRADA (execução anterior caiu) ⇒ assumida com segurança e a execução segue', () => {
    const e = {}; e.gc_sync_lock = { 'sync-dados': { detentor: 'github-old', origem: 'github', adquiridaEm: AGORA - 3600000, expiraEm: AGORA - 600000 } };
    const r = rodar(e, CR); expect(r.log).toMatch(/TRAVA_EXPIRADA_ASSUMIDA/); expect(r.exitCode).toBe(0); expect(r.writes).toContain('painel_cache/vendas'); expect(lock(r).expiraEm).toBe(0);
  });
  test('falha ao ler/gravar a trava ⇒ NÃO executa (fail-closed) e sai com erro', () => {
    const r = rodar(base(), { ...CR, HARNESS_FALHA_LEITURA: 'gc_sync_lock/sync-dados' }); expect(r.exitCode).not.toBe(0); expect(r.log).toMatch(/TRAVA_INDISPONIVEL|trava indisponível/); expect(r.writes.filter(w => !w.startsWith('gc_sync_lock'))).toEqual([]);
  });
  test('liberação só pelo detentor: depois da execução a trava de outro não é liberada por engano', () => {
    const r = rodar(base(), CR); expect(lock(r).detentor).toMatch(/^cloudrun-/);
  });
});

describe('intervalo mínimo e blocos direcionados', () => {
  test('INTERVALO_MIN_MINUTOS: execução recente ⇒ ignora (sem trava, sem escrita)', () => {
    const e = base(); e.gc_sync_status = { ultima: { ultimaTentativaEm: new Date(AGORA - 20 * 60000).toISOString() } };
    const r = rodar(e, { ...CR, INTERVALO_MIN_MINUTOS: '60' }); expect(r.log).toMatch(/SYNC_IGNORADO_INTERVALO/); expect(r.writes).toEqual([]);
    const r2 = rodar(e, { ...CR, INTERVALO_MIN_MINUTOS: '10' }); expect(r2.log).not.toMatch(/SYNC_IGNORADO_INTERVALO/); expect(r2.writes).toContain('painel_cache/vendas');
  });
  test('BLOCOS=vendas,pedidos: só esses blocos escrevem; heartbeat NÃO declara sucesso completo', () => {
    const e = base(); e.gc_sync_status = { ultima: { ultimoSucessoCompletoEm: '2026-11-25T00:00:00.000Z', ultimaTentativaEm: '2026-11-25T00:00:00.000Z', ultimoSucessoPorBloco: { estoque: 'ANTES' } } };
    const r = rodar(e, { ...CR, BLOCOS: 'vendas,pedidos' });
    expect(r.exitCode).toBe(0); expect(r.writes).toContain('painel_cache/vendas'); expect(r.writes).toContain('pedidos_cache/latest');
    for (const w of ['painel_cache/estoque', 'financeiro_cache/latest', 'painel_cache/produtos_catalogo']) expect(r.writes).not.toContain(w);
    const hb = r.state.gc_sync_status.ultima; expect(hb.ultimoSucessoCompletoEm).toBe('2026-11-25T00:00:00.000Z'); expect(hb.ultimaExecucao.parcial).toBe(true); expect(hb.ultimoSucessoPorBloco.estoque).toBe('ANTES'); expect(hb.ultimoSucessoPorBloco.vendas).not.toBe(undefined);
  });
  test('pedidos sem vendas não trava esperando a corroboração', () => { const r = rodar(base(), { ...CR, BLOCOS: 'pedidos' }); expect(r.exitCode).toBe(0); expect(r.writes).toContain('pedidos_cache/latest'); });
  test('BLOCOS inválido ⇒ erro e NADA executa', () => { const r = rodar(base(), { ...CR, BLOCOS: 'vendas,apagar' }); expect(r.exitCode).not.toBe(0); expect(r.writes).toEqual([]); });
});
