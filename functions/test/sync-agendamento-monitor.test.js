'use strict';
/**
 * Agendamento e monitoramento do sync (branch isolada; NADA ativado em produção):
 *  - workflow: cron 17 a cada 2 horas (minuto 17), concorrência SEM cancelar, timeout validado pela duração histórica;
 *  - heartbeat `gc_sync_status/ultima` gravado pelo sync (só códigos e horários);
 *  - monitor independente: aviso > 4 h, crítico > 8 h, recuperação, repetição sem spam.
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { avaliarDesatualizacao, monitorarHandler, LIMITES } = require('../lib/syncMonitor');
jest.setTimeout(240000);
const ROOT = path.resolve(__dirname, '../..'); const HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
const H = 3600000, T0 = Date.parse('2026-12-01T12:00:00Z');
const ago = h => new Date(T0 - h * H).toISOString();

describe('workflow sync-dados.yml', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/sync-dados.yml'), 'utf8');
  test('GitHub Actions SEM agendamento (contingência manual); o agendamento operacional é o Cloud Scheduler → Cloud Run Job', () => { expect(wf).not.toMatch(/^\s*schedule:/m); expect(wf).not.toMatch(/cron:/); expect(wf).toMatch(/workflow_dispatch:/); expect(wf).toMatch(/Cloud Run Job/); });
  test('concorrência: um grupo, SEM cancelar a execução em andamento', () => { expect(wf).toMatch(/concurrency:\s*\n\s*group: sync-dados\s*\n\s*cancel-in-progress: false/); expect(wf).not.toMatch(/cancel-in-progress: true/); });
  test('timeout-minutes definido e coerente com o histórico (mediana 4,8 min; máx 20,6 min) ⇒ 30', () => { const m = wf.match(/timeout-minutes: (\d+)/); expect(m).toBeTruthy(); expect(Number(m[1])).toBeGreaterThanOrEqual(30); expect(Number(m[1])).toBeLessThanOrEqual(45); });
  test('segurança do workflow preservada: sem continue-on-error, só leitura do repositório, OIDC, segredos só no passo do sync', () => {
    expect(wf).not.toMatch(/continue-on-error/); expect(wf).toMatch(/contents: read/); expect(wf).toMatch(/id-token: write/); expect(wf).toMatch(/run: node scripts\/sync-dados\.js/);
  });
});

describe('avaliarDesatualizacao (função pura)', () => {
  const ev = (idadeH, ant) => avaliarDesatualizacao({ agoraMs: T0, ultimoSucessoCompletoEm: ago(idadeH), estadoAnterior: ant });
  test('limites: ≤ 4 h OK; > 4 h AVISO; > 8 h CRÍTICO (bordas exatas)', () => {
    expect(ev(0).nivel).toBe('OK'); expect(ev(4).nivel).toBe('OK'); expect(ev(4.01).nivel).toBe('AVISO'); expect(ev(8).nivel).toBe('AVISO'); expect(ev(8.01).nivel).toBe('CRITICO'); expect(LIMITES.avisoMs).toBe(4 * H); expect(LIMITES.criticoMs).toBe(8 * H);
  });
  test('OK sem alerta anterior ⇒ não notifica', () => expect(ev(1, null).notificar).toBe(false));
  test('OK → AVISO notifica uma vez; no ciclo seguinte (30 min) NÃO repete', () => {
    const a = ev(4.5, { nivel: 'OK', notificadoEmMs: null }); expect(a).toMatchObject({ nivel: 'AVISO', notificar: true, tipo: 'AVISO' });
    const b = avaliarDesatualizacao({ agoraMs: T0 + 0.5 * H, ultimoSucessoCompletoEm: ago(4.5), estadoAnterior: a.novoEstado }); expect(b.notificar).toBe(false);
  });
  test('AVISO repete a cada 4 h enquanto persistir (sem spam entre as repetições)', () => {
    const base = T0 + 5 * H;      // ciclo atual; o último sucesso foi há 5 h ⇒ AVISO
    const ult = new Date(base - 5 * H).toISOString();
    const dentro = avaliarDesatualizacao({ agoraMs: base + 3.9 * H - 3 * H, ultimoSucessoCompletoEm: ult, estadoAnterior: { nivel: 'AVISO', notificadoEmMs: base - 0.1 * H } });
    expect(dentro).toMatchObject({ nivel: 'AVISO', notificar: false });
    const rep = avaliarDesatualizacao({ agoraMs: base + 0.9 * H, ultimoSucessoCompletoEm: ult, estadoAnterior: { nivel: 'AVISO', notificadoEmMs: base - 3.1 * H } });
    expect(rep).toMatchObject({ nivel: 'AVISO', notificar: true, tipo: 'REPETICAO_AVISO' });
  });
  test('AVISO → CRÍTICO notifica imediatamente (piora); CRÍTICO repete a cada 2 h', () => {
    const c = ev(8.5, { nivel: 'AVISO', notificadoEmMs: T0 - 1 * H }); expect(c).toMatchObject({ nivel: 'CRITICO', notificar: true, tipo: 'CRITICO' });
    const dentro = avaliarDesatualizacao({ agoraMs: T0 + 1.9 * H, ultimoSucessoCompletoEm: ago(8.5), estadoAnterior: c.novoEstado }); expect(dentro.notificar).toBe(false);
    const rep = avaliarDesatualizacao({ agoraMs: T0 + 2 * H, ultimoSucessoCompletoEm: ago(8.5), estadoAnterior: c.novoEstado }); expect(rep).toMatchObject({ notificar: true, tipo: 'REPETICAO_CRITICO' });
  });
  test('recuperação: de AVISO/CRÍTICO para OK notifica UMA vez (RECUPERADO) e zera o controle', () => {
    const r = ev(0.5, { nivel: 'CRITICO', notificadoEmMs: T0 - H }); expect(r).toMatchObject({ nivel: 'OK', notificar: true, tipo: 'RECUPERADO' }); expect(r.novoEstado.notificadoEmMs).toBeNull();
    expect(avaliarDesatualizacao({ agoraMs: T0, ultimoSucessoCompletoEm: ago(0.5), estadoAnterior: r.novoEstado }).notificar).toBe(false);
  });
  test('heartbeat inexistente/inválido ⇒ SEM_REGISTRO (notifica); data no futuro é inválida', () => {
    expect(avaliarDesatualizacao({ agoraMs: T0, ultimoSucessoCompletoEm: null })).toMatchObject({ nivel: 'SEM_REGISTRO', notificar: true });
    expect(avaliarDesatualizacao({ agoraMs: T0, ultimoSucessoCompletoEm: 'lixo' }).nivel).toBe('SEM_REGISTRO');
    expect(avaliarDesatualizacao({ agoraMs: T0, ultimoSucessoCompletoEm: new Date(T0 + 3 * H).toISOString() }).nivel).toBe('SEM_REGISTRO');
  });
  test('sem argumentos não lança', () => expect(() => avaliarDesatualizacao()).not.toThrow());
});

describe('monitorarHandler (db e logger falsos)', () => {
  const mkDb = ({ hb, est, falhaLeitura = false, falhaEscrita = false }) => { const escritos = []; return { escritos, collection: col => ({ doc: id => ({
    get: async () => { if (falhaLeitura && col === 'gc_sync_status') throw new Error('UNAVAILABLE'); const d = col === 'gc_sync_status' ? hb : est; return { exists: !!d, data: () => d }; },
    set: async d => { if (falhaEscrita) throw new Error('x'); escritos.push({ col, id, d }); } }) }) }; };
  const mkLog = () => { const l = []; const f = nivel => (msg, p) => l.push({ nivel, msg, p }); return { l, info: f('info'), warn: f('warn'), error: f('error') }; };
  test('crítico ⇒ log de severidade ERROR com payload só de nível/horas (sem dados do negócio)', async () => {
    const lg = mkLog(); const db = mkDb({ hb: { ultimoSucessoCompletoEm: ago(9), ultimaExecucao: { falhas: [{ bloco: 'vendas', codigo: 'X' }] } }, est: { nivel: 'AVISO', notificadoEmMs: T0 - 5 * H } });
    await monitorarHandler({ db, logger: lg, agora: () => T0 }); expect(lg.l).toHaveLength(1); expect(lg.l[0].nivel).toBe('error');
    expect(Object.keys(lg.l[0].p).sort()).toEqual(['alerta', 'idadeHoras', 'leituraHeartbeat', 'limitesHoras', 'nivel', 'tipo']); expect(JSON.stringify(lg.l[0].p)).not.toMatch(/vendas|R\$|cliente/);
    expect(db.escritos[0]).toMatchObject({ col: 'gc_sync_alertas', id: 'estado' });
  });
  test('aviso ⇒ WARN; saudável ⇒ nenhum log; recuperado ⇒ INFO', async () => {
    const a = mkLog(); await monitorarHandler({ db: mkDb({ hb: { ultimoSucessoCompletoEm: ago(5) }, est: null }), logger: a, agora: () => T0 }); expect(a.l.map(x => x.nivel)).toEqual(['warn']);
    const b = mkLog(); await monitorarHandler({ db: mkDb({ hb: { ultimoSucessoCompletoEm: ago(1) }, est: { nivel: 'OK', notificadoEmMs: null } }), logger: b, agora: () => T0 }); expect(b.l).toEqual([]);
    const c = mkLog(); await monitorarHandler({ db: mkDb({ hb: { ultimoSucessoCompletoEm: ago(1) }, est: { nivel: 'CRITICO', notificadoEmMs: T0 - H } }), logger: c, agora: () => T0 }); expect(c.l.map(x => x.nivel)).toEqual(['info']);
  });
  test('falha ao LER o heartbeat ⇒ trata como SEM_REGISTRO (fail-safe: alerta, não silêncio); falha ao gravar estado não derruba', async () => {
    const lg = mkLog(); const r = await monitorarHandler({ db: mkDb({ hb: null, est: null, falhaLeitura: true, falhaEscrita: true }), logger: lg, agora: () => T0 });
    expect(r.nivel).toBe('SEM_REGISTRO'); expect(lg.l[0].p.leituraHeartbeat).toBe('FALHOU');
  });
});

describe('Function exportada e código do monitor', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8'); const mon = fs.readFileSync(path.join(ROOT, 'functions/lib/syncMonitor.js'), 'utf8');
  test('monitorarSyncDesatualizado: onSchedule a cada 30 min, região do projeto, sem segredos', () => {
    const b = idx.slice(idx.indexOf('exports.monitorarSyncDesatualizado'), idx.indexOf('exports.syncPainelDisplay')); expect(b).toMatch(/every 30 minutes/); expect(b).not.toMatch(/secrets/);
  });
  test('o monitor não usa rede nem segredos e só toca gc_sync_status (leitura) e gc_sync_alertas', () => {
    expect(mon).not.toMatch(/https?:|require\('https'\)|fetch\(|process\.env|secret/i); expect((mon.match(/collection\('([a-z_]+)'\)/g) || []).sort()).toEqual(["collection('gc_sync_alertas')", "collection('gc_sync_alertas')", "collection('gc_sync_status')"]);
  });
});

// ── Heartbeat gravado pelo sync real (harness) ─────────────────────────────────
const PREVIO = () => ({
  painel_cache: { vendas: { atualizado_em: 'ANTERIOR', _meta: { vendasTotal: 4, janelaDias: 30, escopo: 'loja_262759' } }, caixa: {}, estoque: { total_produtos: 3 }, estoque_custos: {}, produtos_catalogo: { total: 3 } },
  display_metrics: { latest: {} }, pedidos_cache: { latest: { _meta: { pedidosTotal: 4 } } }, financeiro_cache: { latest: { _meta: { lancamentosTotal: 0 } } },
  gc_sync_status: { ultima: { schema: 1, ultimoSucessoCompletoEm: '2026-11-20T10:00:00.000Z', ultimoSucessoPorBloco: { vendas: '2026-11-20T10:00:00.000Z', estoque: '2026-11-20T10:00:00.000Z', financeiro: '2026-11-19T10:00:00.000Z', pedidos: '2026-11-20T10:00:00.000Z', catalogo: '2026-11-20T10:00:00.000Z', perfil360: '2026-11-20T10:00:00.000Z' } } },
});
function rodar(modo, estado = PREVIO(), env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-')); const st = path.join(dir, 's.json'), out = path.join(dir, 'o.json'); fs.writeFileSync(st, JSON.stringify(estado));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts/sync-dados.js')], { cwd: ROOT, timeout: 90000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'a', GC_SECRET_ACCESS_TOKEN: 'b', HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '', ...env } });
  return { ...JSON.parse(fs.readFileSync(out, 'utf8')), exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
}
describe('heartbeat gc_sync_status/ultima gravado pelo sync', () => {
  test('ciclo SEM falhas: grava ultimoSucessoCompletoEm e todos os blocos; ok=true; só códigos/horários/runId', () => {
    const e = PREVIO(); e.pedidos_cache.latest._meta.pedidosTotal = 4; const r = rodar('ok', e, { GITHUB_RUN_ID: '123456789' });
    const h = r.state.gc_sync_status.ultima; expect(r.writes).toContain('gc_sync_status/ultima');
    expect(Object.keys(h).sort()).toEqual(['schema', 'ultimaExecucao', 'ultimaTentativaEm', 'ultimoSucessoCompletoEm', 'ultimoSucessoPorBloco']);
    expect(Date.parse(h.ultimoSucessoCompletoEm)).toBeGreaterThan(Date.parse('2026-11-20T10:00:00.000Z'));
    expect(h.ultimaExecucao).toMatchObject({ runId: '123456789', ok: r.exitCode === 0 }); expect(Object.keys(h.ultimoSucessoPorBloco).sort()).toEqual(['catalogo', 'estoque', 'financeiro', 'pedidos', 'perfil360', 'vendas']);
    expect(JSON.stringify(h)).not.toMatch(/R\$|cliente|Vendedor|Produto/);
  });
  test('ciclo COM falha (HTTP 500 em vendas): NÃO avança ultimoSucessoCompletoEm; avança só os blocos que não falharam; registra a falha (código)', () => {
    const r = rodar('vendas_pag2_500'); const h = r.state.gc_sync_status.ultima;
    expect(h.ultimoSucessoCompletoEm).toBe('2026-11-20T10:00:00.000Z'); expect(h.ultimaExecucao.ok).toBe(false); expect(h.ultimaExecucao.falhas.map(f => f.bloco)).toEqual(expect.arrayContaining(['vendas', 'pedidos']));
    expect(h.ultimoSucessoPorBloco.vendas).toBe('2026-11-20T10:00:00.000Z'); expect(Date.parse(h.ultimoSucessoPorBloco.estoque)).toBeGreaterThan(Date.parse('2026-11-20T10:00:00.000Z'));
    expect(r.exitCode).not.toBe(0);
  });
  test('sem heartbeat anterior: cria (primeira execução)', () => { const e = PREVIO(); delete e.gc_sync_status; const r = rodar('ok', e); expect(r.state.gc_sync_status.ultima.schema).toBe(1); });
  test('falha de LEITURA do heartbeat anterior ⇒ não grava (preserva histórico) e o sync segue', () => {
    const r = rodar('ok', PREVIO(), { HARNESS_FALHA_LEITURA: 'gc_sync_status/ultima' }); expect(r.writes).not.toContain('gc_sync_status/ultima'); expect(r.state.gc_sync_status.ultima.ultimoSucessoCompletoEm).toBe('2026-11-20T10:00:00.000Z'); expect(r.log).toMatch(/Heartbeat não gravado/);
  });
  test('falha de ESCRITA do heartbeat NÃO muda o resultado do sync (exit code igual) e não vaza a mensagem', () => {
    const base = rodar('ok'); const r = rodar('ok', PREVIO(), { HARNESS_FALHA_ESCRITA: 'gc_sync_status/ultima' });
    expect(r.exitCode).toBe(base.exitCode); expect(r.log).toMatch(/Heartbeat não gravado/); expect(r.log).not.toMatch(/escrita simulada|UNAVAILABLE/);
  });
});
