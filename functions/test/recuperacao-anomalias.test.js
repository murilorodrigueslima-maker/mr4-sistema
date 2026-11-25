'use strict';
const R = require('../lib/recuperacaoAnomalias');
const H = 3600000, T0 = Date.parse('2026-11-25T00:00:00Z');
const ids = (n, off = 0) => Array.from({ length: n }, (_, i) => String(1000 + off + i));
const L = (bloco, h, total, extra = {}) => ({ bloco, agoraMs: T0 + h * H, total, ids: ids(total), escopo: 'loja_262759', janelaInicio: '2026-10-26', janelaFim: '2026-11-25', janelaDias: 30, referencia: 5000, motivo: 'QUEDA_ACIMA_DO_LIMITE', particaoOk: true, ...extra });
const ciclo = (est, leituras) => leituras.reduce((e, l) => R.registrarBloqueio(e, l).estado, est);

describe('assinatura', () => {
  const base = { bloco: 'vendas', escopo: 'e', janelaInicio: 'a', janelaFim: 'b', total: 3, ids: ['3', '1', '2'] };
  test('independe da ordem dos ids e muda com qualquer campo', () => {
    expect(R.assinatura(base)).toBe(R.assinatura({ ...base, ids: ['1', '2', '3'] }));
    for (const k of [{ total: 4 }, { escopo: 'x' }, { janelaInicio: 'z' }, { ids: ['1', '2', '4'] }, { bloco: 'estoque' }]) expect(R.assinatura({ ...base, ...k })).not.toBe(R.assinatura(base));
  });
});

describe('quarentena e estabilidade', () => {
  test('queda completa ⇒ QUARENTENA, auditada, sem estabilizar com 1 leitura', () => {
    const r = R.registrarBloqueio(null, L('vendas', 0, 1000)); expect(r.estado.estado).toBe('QUARENTENA'); expect(r.estado.estavel).toBe(false);
    expect(r.eventos.map(e => e.evento)).toContain('ENTROU_QUARENTENA');
  });
  test('3 leituras mas em < 6 h ⇒ NÃO estável (JANELA_CURTA)', () => {
    const e = ciclo(null, [L('vendas', 0, 1000), L('vendas', 2, 1000), L('vendas', 5, 1000)]); expect(e.estavel).toBe(false); expect(R.avaliarEstabilidade(e).motivos).toContain('JANELA_CURTA');
  });
  test('3 leituras ≥ 6 h, variação ≤ 5% e ids iguais ⇒ estável ⇒ AGUARDANDO_CONFIRMACAO (e evento ESTAVEL)', () => {
    let e = null, evs = []; for (const l of [L('vendas', 0, 1000), L('vendas', 3, 1010), L('vendas', 6.5, 1005)]) { const r = R.registrarBloqueio(e, l); e = r.estado; evs.push(...r.eventos.map(x => x.evento)); }
    expect(e.estavel).toBe(true); expect(e.estado).toBe('AGUARDANDO_CONFIRMACAO'); expect(evs).toContain('ESTAVEL');
  });
  test('variação > 5% ⇒ não estável', () => { const e = ciclo(null, [L('vendas', 0, 1000), L('vendas', 4, 1200), L('vendas', 7, 1000)]); expect(R.avaliarEstabilidade(e).motivos).toContain('VARIACAO_ALTA'); });
  test('bloco pequeno usa tolerância absoluta mínima de ±2', () => {
    const e = ciclo(null, [L('estoque', 0, 20), L('estoque', 4, 21), L('estoque', 7, 22)]);   // 5% de 21 = 1,05; ±2 permite
    expect(R.avaliarEstabilidade(e, { idsAtuais: ids(22) }).motivos).not.toContain('VARIACAO_ALTA');
  });
  test('sobreposição de ids < 90% (primeira × última) ⇒ não estável', () => {
    let e = ciclo(null, [L('vendas', 0, 1000), L('vendas', 4, 1000)]); const ult = L('vendas', 7, 1000, { ids: ids(1000, 500) });
    const r = R.registrarBloqueio(e, ult); expect(r.estabilidade.motivos).toContain('SOBREPOSICAO_BAIXA'); expect(r.estado.estavel).toBe(false);
  });
  test('reconciliação por partição falhou ⇒ nunca estabiliza', () => {
    const e = ciclo(null, [L('vendas', 0, 1000), L('vendas', 4, 1000, { particaoOk: false }), L('vendas', 7, 1000)]); expect(e.estavel).toBe(false); expect(R.avaliarEstabilidade(e).motivos).toContain('PARTICAO_FALHOU');
  });
  test('falha/leitura incompleta só conta falhasSeguidas, nunca vira leitura', () => {
    let e = ciclo(null, [L('vendas', 0, 1000)]); const f = R.registrarFalha(e, 'vendas').estado; expect(f.falhasSeguidas).toBe(1); expect(f.leituras).toHaveLength(1);
  });
  test('queda extrema (> 95%) exige 8 h, não 6', () => {
    const l = (h, t) => L('vendas', h, t, { referencia: 100000 }); const e = ciclo(null, [l(0, 1000), l(3, 1000), l(6.5, 1000)]);
    expect(R.avaliarEstabilidade(e).motivos).toContain('JANELA_CURTA'); const e2 = ciclo(e, [l(8.5, 1000)]); expect(R.avaliarEstabilidade(e2).motivos).not.toContain('JANELA_CURTA');
  });
  test('volume normaliza ⇒ SAIU_QUARENTENA sem aceite', () => {
    const e = ciclo(null, [L('vendas', 0, 1000)]); const r = R.registrarNormal(e, { bloco: 'vendas', total: 5000 }); expect(r.estado.estado).toBe('NORMAL'); expect(r.eventos[0].evento).toBe('SAIU_QUARENTENA');
  });
  test('mudança de escopo ⇒ ESCOPO_ALTERADO auditado e estado reiniciado', () => {
    const e = ciclo(null, [L('vendas', 0, 1000)]); const r = R.registrarBloqueio(e, L('vendas', 1, 900, { escopo: 'outro' })); expect(r.eventos.map(x => x.evento)).toContain('ESCOPO_ALTERADO'); expect(r.estado.leituras).toHaveLength(1);
  });
});

function estavel(bloco = 'vendas', ref = 5000, total = 1000) { let e = null; for (const [h, t] of [[0, total], [3, total + 5], [6.5, total]]) e = R.registrarBloqueio(e, L(bloco, h, t, { referencia: ref })).estado; return e; }
const MOTIVO = 'Queda real confirmada pelo gestor: loja fechou filial';

describe('aceite em duas etapas', () => {
  const e0 = estavel(), sig = e0.leituras[e0.leituras.length - 1].assinatura8, AG = T0 + 10 * H;
  const pedir = (extra = {}) => R.solicitarAceite(e0, { assinatura8: sig, motivo: MOTIVO, ator: 'murilo', agoraMs: AG, runId: '1', ...extra });
  test('solicitar: exige AGUARDANDO, assinatura igual à última leitura e motivo ≥ 20 caracteres', () => {
    expect(pedir().ok).toBe(true);
    expect(pedir({ assinatura8: 'deadbeef' }).codigo).toBe('ASSINATURA_DIFERENTE'); expect(pedir({ assinatura8: 'XYZ' }).codigo).toBe('ASSINATURA_INVALIDA');
    expect(pedir({ motivo: 'curto' }).codigo).toBe('MOTIVO_INVALIDO'); expect(pedir({ motivo: 'linha1\nlinha2 com mais de vinte caracteres' }).codigo).toBe('MOTIVO_INVALIDO');
    expect(R.solicitarAceite(R.estadoNovo('vendas'), { assinatura8: sig, motivo: MOTIVO, ator: 'a', agoraMs: AG }).codigo).toBe('ESTADO_INVALIDO');
  });
  test('queda extrema exige a palavra CONFIRMO-QUEDA-EXTREMA no motivo', () => {
    const ex = estavel('vendas', 500000, 1000); const s = ex.leituras[2].assinatura8;
    // com 3 leituras em 6,5 h ainda não é estável (precisa 8 h)
    expect(R.avaliarEstabilidade(ex).estavel).toBe(false);
    const ex2 = R.registrarBloqueio(ex, L('vendas', 9, 1000, { referencia: 500000 })).estado; const s2 = ex2.leituras[ex2.leituras.length - 1].assinatura8;
    expect(R.solicitarAceite(ex2, { assinatura8: s2, motivo: MOTIVO, ator: 'a', agoraMs: T0 + 10 * H }).codigo).toBe('PALAVRA_EXTREMA_AUSENTE');
    expect(R.solicitarAceite(ex2, { assinatura8: s2, motivo: MOTIVO + ' CONFIRMO-QUEDA-EXTREMA', ator: 'a', agoraMs: T0 + 10 * H }).ok).toBe(true);
  });
  const pend = pedir().estado, ap = pend.aprovacao, atual = { completa: true, assinatura8: sig, particaoOk: true };
  const conf = (extra = {}) => R.confirmarAceite(pend, { id: ap.id, assinatura8: sig, ator: 'murilo', agoraMs: AG + 31 * 60000, leituraAtual: atual, runId: '2', ...extra });
  test('confirmar válido: publica, consome, audita e o bloco volta a NORMAL', () => {
    const r = conf(); expect(r.ok).toBe(true); expect(r.publicar).toBe(true); expect(r.estado.estado).toBe('NORMAL'); expect(r.aprovacaoConsumida.consumidoEm).toBeGreaterThan(0);
    expect(r.eventos.map(e => e.evento)).toEqual(expect.arrayContaining(['APROVACAO_CONFIRMADA', 'SAIU_QUARENTENA']));
  });
  test.each([
    ['antes do cooldown (30 min)', { agoraMs: AG + 10 * 60000 }, 'COOLDOWN'],
    ['assinatura errada', { assinatura8: 'deadbeef' }, 'ASSINATURA_DIFERENTE'],
    ['id errado', { id: 'vendas-1' }, 'ID_DIFERENTE'],
    ['resultado mudou entre A e B', { leituraAtual: { ...atual, assinatura8: '12345678' } }, 'RESULTADO_MUDOU'],
    ['leitura atual incompleta', { leituraAtual: { ...atual, completa: false } }, 'LEITURA_ATUAL_INCOMPLETA'],
    ['partição falhou', { leituraAtual: { ...atual, particaoOk: false } }, 'PARTICAO_FALHOU'],
    ['sem leitura atual', { leituraAtual: null }, 'LEITURA_ATUAL_INCOMPLETA'],
  ])('rejeita: %s', (_n, extra, codigo) => { const r = conf(extra); expect(r.ok).toBe(false); expect(r.publicar).toBe(false); expect(r.codigo).toBe(codigo); });
  test('expirada (> 24 h) ⇒ APROVACAO_EXPIRADA e volta a AGUARDANDO', () => {
    const r = conf({ agoraMs: AG + 25 * H }); expect(r.codigo).toBe('APROVACAO_EXPIRADA'); expect(r.estado.estado).toBe('AGUARDANDO_CONFIRMACAO'); expect(r.estado.aprovacao).toBeNull();
  });
  test('uso único: depois de consumida não confirma de novo (estado NORMAL ⇒ sem aprovação pendente)', () => {
    const r1 = conf(); const r2 = R.confirmarAceite(r1.estado, { id: ap.id, assinatura8: sig, ator: 'murilo', agoraMs: AG + 40 * 60000, leituraAtual: atual }); expect(r2.ok).toBe(false); expect(r2.codigo).toBe('SEM_APROVACAO_PENDENTE');
    const consumida = { ...pend, aprovacao: { ...ap, consumidoEm: 1 } }; expect(R.confirmarAceite(consumida, { id: ap.id, assinatura8: sig, ator: 'a', agoraMs: AG + 40 * 60000, leituraAtual: atual }).codigo).toBe('APROVACAO_JA_CONSUMIDA');
  });
  test('segundo ator opcional: exigido ⇒ mesmo ator rejeitado; padrão (false) aceita', () => {
    expect(conf({ exigirSegundoAtor: true }).codigo).toBe('MESMO_ATOR'); expect(conf({ exigirSegundoAtor: true, ator: 'outra' }).ok).toBe(true);
  });
  test('resultado diferente numa leitura bloqueada entre A e B invalida a aprovação pendente', () => {
    const r = R.registrarBloqueio(pend, L('vendas', 11, 700)); expect(r.eventos.map(e => e.evento)).toContain('APROVACAO_REJEITADA'); expect(r.estado.aprovacao).toBeNull();
  });
});

describe('entradas do workflow_dispatch', () => {
  test('validação estrita', () => {
    expect(R.validarEntradas({}).ok).toBe(true); expect(R.validarEntradas({ acao: 'apagar' }).codigo).toBe('ACAO_INVALIDA');
    expect(R.validarEntradas({ acao: 'solicitar_aceite', bloco: 'x', assinatura8: 'abcd1234', motivo: MOTIVO }).codigo).toBe('BLOCO_INVALIDO');
    expect(R.validarEntradas({ acao: 'solicitar_aceite', bloco: 'vendas', assinatura8: 'ZZ', motivo: MOTIVO }).codigo).toBe('ASSINATURA_INVALIDA');
    expect(R.validarEntradas({ acao: 'solicitar_aceite', bloco: 'vendas', assinatura8: 'abcd1234', motivo: 'curto' }).codigo).toBe('MOTIVO_INVALIDO');
    expect(R.validarEntradas({ acao: 'confirmar_aceite', bloco: 'vendas', assinatura8: 'abcd1234', aprovacaoId: 'vendas-1764028800000' }).ok).toBe(true);
    expect(R.validarEntradas({ acao: 'confirmar_aceite', bloco: 'vendas', assinatura8: 'abcd1234', aprovacaoId: '../x' }).codigo).toBe('ID_INVALIDO');
  });
});

describe('adaptador Firestore: auditoria é create-only', () => {
  test('create por evento; nunca set/update/delete na auditoria', async () => {
    const chamadas = []; const doc = nome => ({ get: async () => ({ exists: false }), set: async d => chamadas.push(['set', nome, d]), create: async d => chamadas.push(['create', nome, d]), update: async () => { throw new Error('proibido'); }, delete: async () => { throw new Error('proibido'); } });
    const db = { collection: nome => ({ doc: () => doc(nome) }) };
    await R.auditar(db, { evento: 'ENTROU_QUARENTENA', bloco: 'vendas' }, T0, 'github'); await R.gravarEstado(db, R.estadoNovo('vendas'));
    expect(chamadas.filter(c => c[1] === R.COL_AUDITORIA).map(c => c[0])).toEqual(['create']); expect(chamadas.find(c => c[1] === R.COL_ESTADO)[0]).toBe('set');
    const campos = Object.keys(chamadas[0][2]); expect(campos).not.toEqual(expect.arrayContaining(['nome', 'cliente', 'valor']));
  });
});

describe('workflow sync-dados: entradas da recuperação', () => {
  const fs = require('fs'), path = require('path'); const y = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'sync-dados.yml'), 'utf8');
  test('inputs só em workflow_dispatch; vão por env (nunca interpolados no run); agendamento não os define', () => {
    expect(y).toMatch(/workflow_dispatch:\s*#[^\n]*\n\s+inputs:/);
    for (const k of ['ACAO_ANOMALIA', 'BLOCO_ANOMALIA', 'ASSINATURA8_ANOMALIA', 'MOTIVO_ANOMALIA', 'APROVACAO_ID_ANOMALIA']) expect(y).toMatch(new RegExp(k + ':\\s+\\$\\{\\{ inputs\\.'));
    const run = y.split('\n').filter(l => /^\s+run:/.test(l)).join('\n'); expect(run).not.toMatch(/\$\{\{/);
  });
  test('o script ignora ação fora de workflow_dispatch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'sync-dados.js'), 'utf8'); expect(src).toMatch(/GITHUB_EVENT_NAME !== 'workflow_dispatch'\) return \{ ok: true, acao: 'normal' \}/);
  });
});
