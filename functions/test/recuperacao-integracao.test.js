'use strict';
// Recuperação de anomalias integrada ao sync-dados (harness: sem rede/Firestore real). Fluxo completo: queda ⇒ quarentena ⇒ 3 leituras/6 h ⇒ solicitar ⇒ confirmar.
const { spawnSync } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
jest.setTimeout(300000);
const ROOT = path.resolve(__dirname, '../..'), HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
const PREVIO = () => ({
  painel_cache: { vendas: { atualizado_em: 'ANTERIOR', hoje: 999, mes: 90000, vendedores: [], _meta: { vendasTotal: 118, janelaDias: 30, escopo: 'loja_262759', sincronizadoEm: 'ANTERIOR' } }, caixa: { atualizado_em: 'ANTERIOR' },
    estoque: { atualizado_em: 'ANTERIOR', total_produtos: 3 }, estoque_custos: { atualizado_em: 'ANTERIOR' }, produtos_catalogo: { atualizado_em: 'ANTERIOR', total: 3, itens: [] } },
  display_metrics: { latest: { atualizado_em: 'ANTERIOR' } }, pedidos_cache: { latest: { atualizado_em: 'ANTERIOR', total: 10, pedidos: [], _meta: { pedidosTotal: 10 } } }, financeiro_cache: { latest: { atualizado_em: 'ANTERIOR', _meta: { lancamentosTotal: 10 } } },
});
function rodar(estado, now, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), st = path.join(dir, 's.json'), out = path.join(dir, 'o.json'); fs.writeFileSync(st, JSON.stringify(estado));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts', 'sync-dados.js')], { cwd: ROOT, timeout: 120000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: 'vendas_queda', HARNESS_STATE: st, HARNESS_OUT: out, HARNESS_NOW: now, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '', GITHUB_ACTOR: 'titular', GITHUB_RUN_ID: '123456', ...env } });
  return { ...JSON.parse(fs.readFileSync(out, 'utf8')), exitCode: r.status, log: String(r.stdout || '') + String(r.stderr || '') };
}
const t = h => new Date(Date.parse('2026-11-25T09:00:00-03:00') + h * 3600000).toISOString();
const sig8 = r => (r.log.match(/vendas: QUARENTENA[^\n]*ASSINATURA8=([0-9a-f]{8})/) || [])[1];
const evs = r => Object.values(r.state.gc_sync_auditoria || {}).map(e => e.evento);
const MOTIVO_OK = 'Queda real confirmada pelo gestor da loja CONFIRMO-QUEDA-EXTREMA';
const AGENDADO = { GITHUB_EVENT_NAME: 'schedule' }, MANUAL = { GITHUB_EVENT_NAME: 'workflow_dispatch' };

describe('recuperação integrada (vendas_queda: 1 venda lida contra referência 118)', () => {
  let r1, r2, r3;
  beforeAll(() => { r1 = rodar(PREVIO(), t(0), AGENDADO); r2 = rodar(r1.state, t(4), AGENDADO); r3 = rodar(r2.state, t(8.5), AGENDADO); /* 118 → 1 é queda EXTREMA (> 95%): exige 8 h de estabilidade */ });
  test('1ª leitura: bloqueia, entra em QUARENTENA, audita e NÃO publica', () => {
    expect(r1.exitCode).not.toBe(0); expect(r1.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas);
    expect(r1.state.gc_sync_estado.vendas.estado).toBe('QUARENTENA'); expect(evs(r1)).toContain('ENTROU_QUARENTENA'); expect(sig8(r1)).toMatch(/^[0-9a-f]{8}$/);
  });
  test('2 leituras (4 h) ainda não estabilizam; 3 leituras em ≥ 8 h (queda extrema) ⇒ AGUARDANDO_CONFIRMACAO e nada publicado', () => {
    expect(r2.state.gc_sync_estado.vendas.estavel).toBe(false);
    expect(r3.state.gc_sync_estado.vendas.estavel).toBe(true); expect(r3.state.gc_sync_estado.vendas.estado).toBe('AGUARDANDO_CONFIRMACAO'); expect(evs(r3)).toContain('ESTAVEL');
    expect(r3.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas); expect(r3.exitCode).not.toBe(0);
  });
  test('execução AGENDADA nunca aceita: ACAO_ANOMALIA=confirmar_aceite é ignorada fora do workflow_dispatch', () => {
    const r = rodar(r3.state, t(9), { ...AGENDADO, ACAO_ANOMALIA: 'solicitar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), MOTIVO_ANOMALIA: MOTIVO_OK });
    expect(r.state.gc_sync_estado.vendas.aprovacao).toBeFalsy(); expect(r.state.gc_sync_estado.vendas.estado).not.toBe('APROVACAO_PENDENTE');
  });
  test('solicitar (manual): motivo curto é rejeitado; válido gera APROVACAO_PENDENTE e NÃO publica', () => {
    const ruim = rodar(r3.state, t(9), { ...MANUAL, ACAO_ANOMALIA: 'solicitar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), MOTIVO_ANOMALIA: 'curto' });
    expect(ruim.state.gc_sync_estado.vendas.estado).not.toBe('APROVACAO_PENDENTE');
    const ok = rodar(r3.state, t(9), { ...MANUAL, ACAO_ANOMALIA: 'solicitar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), MOTIVO_ANOMALIA: MOTIVO_OK });
    expect(ok.state.gc_sync_estado.vendas.estado).toBe('APROVACAO_PENDENTE'); expect(evs(ok)).toContain('APROVACAO_SOLICITADA'); expect(ok.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas);
    expect(JSON.stringify(ok.log)).not.toMatch(/Queda real confirmada/);   // o motivo livre fica SÓ no Firestore, nunca no log
  });
  test('queda extrema: motivo sem CONFIRMO-QUEDA-EXTREMA é rejeitado', () => {
    const r = rodar(r3.state, t(9), { ...MANUAL, ACAO_ANOMALIA: 'solicitar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), MOTIVO_ANOMALIA: 'Queda real confirmada pelo gestor da loja' });
    expect(r.state.gc_sync_estado.vendas.estado).not.toBe('APROVACAO_PENDENTE');
  });
  test('confirmar: antes do cooldown é rejeitado; depois, com a MESMA assinatura, publica pelo caminho normal, consome e audita; reuso é rejeitado', () => {
    const sol = rodar(r3.state, t(9), { ...MANUAL, ACAO_ANOMALIA: 'solicitar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), MOTIVO_ANOMALIA: MOTIVO_OK });
    const id = sol.state.gc_sync_estado.vendas.aprovacao.id;
    const cedo = rodar(sol.state, t(9.2), { ...MANUAL, ACAO_ANOMALIA: 'confirmar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), APROVACAO_ID_ANOMALIA: id });
    expect(cedo.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas); expect(evs(cedo)).toContain('APROVACAO_REJEITADA');
    const conf = rodar(sol.state, t(9.6), { ...MANUAL, ACAO_ANOMALIA: 'confirmar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), APROVACAO_ID_ANOMALIA: id });
    expect(conf.state.painel_cache.vendas._meta.vendasTotal).toBe(1); expect(conf.state.painel_cache.vendas.atualizado_em).not.toBe('ANTERIOR');
    expect(evs(conf)).toEqual(expect.arrayContaining(['APROVACAO_CONFIRMADA', 'SAIU_QUARENTENA'])); expect(conf.state.gc_sync_estado.vendas.estado).toBe('NORMAL');
    const reuso = rodar(conf.state, t(11), { ...MANUAL, ACAO_ANOMALIA: 'confirmar_aceite', BLOCO_ANOMALIA: 'vendas', ASSINATURA8_ANOMALIA: sig8(r3), APROVACAO_ID_ANOMALIA: id });
    expect(evs(reuso).filter(e => e === 'APROVACAO_CONFIRMADA')).toHaveLength(1);
  });
  test('falha ao gravar o estado ⇒ fail-closed (nada publicado)', () => {
    const r = rodar(PREVIO(), t(0), { ...AGENDADO, HARNESS_FALHA_ESCRITA: 'gc_sync_estado/vendas' }); expect(r.state.painel_cache.vendas).toEqual(PREVIO().painel_cache.vendas); expect(r.exitCode).not.toBe(0);
  });
});
