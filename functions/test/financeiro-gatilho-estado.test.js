'use strict';
// Gatilho do Financeiro baseado em ESTADO: borda final, concorrência, fora de ordem, estorno, trava, falhas, retentativas e confirmação pelo sync REAL.
const G = require('../lib/financeiroGatilho');
const S = require('../lib/financeiro/sync');
const { gcFalso, massa } = require('./fixtures/financeiro-f2');
const { dbWebhook } = require('./fixtures/webhook-db');

const MIN = 60000, H = 60 * MIN, T0 = Date.parse('2026-11-26T12:00:00Z'), em = m => T0 + m * MIN;
const CTL = db => (db.st.gc_refresh_fila || {}).financeiro_n1;
function cena() {
  const db = dbWebhook(); const pedidos = [];
  let agora = T0;
  const disparar = async () => { pedidos.push((agora - T0) / MIN); };
  return { db, pedidos,
    evento: (m, extra = {}) => { agora = em(m); return G.solicitar({ db, evento: 'recebimento.baixado', disparar, agoraMs: agora, ...extra }); },
    varre: (m, extra = {}) => { agora = em(m); return G.varrer({ db, disparar, agoraMs: agora, ...extra }); },
    publica: inicioMin => { db.st.fin_n1 = { active: { geracao: 'g' + inicioMin, publicado_em: new Date(em(inicioMin)).toISOString() } }; },
    trava: ateMin => { db.st.fin_n1_ctl = { lock: { run_id: 'x', expires_at: new Date(em(ateMin)).toISOString() } }; } };
}

describe('borda final (defeito corrigido)', () => {
  test('evento dentro da janela é processado depois dela, sem depender de novo evento, e só é baixado por geração iniciada depois dele', async () => {
    const c = cena();
    expect((await c.evento(0)).acao).toBe('DISPARADO'); c.publica(1);                        // 1ª geração cobre o 1º evento
    expect((await c.evento(5)).acao).toBe('COALESCIDO');
    expect((await c.varre(20)).acao).toBe('AGUARDANDO_JANELA');
    expect((await c.varre(30)).acao).toBe('DISPARADO'); expect(c.pedidos).toEqual([0, 30]);
    c.publica(31);
    expect((await c.varre(40)).acao).toBe('CONFIRMADO'); expect(CTL(c.db)).toMatchObject({ pendente: false, tentativas: 0, geracaoConfirmada: 'g31', pendenteDesdeMs: null });
    c.db.n.leituras = 0; c.db.n.gravacoes = 0; expect((await c.varre(50)).acao).toBe('SEM_PENDENCIA'); expect(c.db.n).toEqual({ leituras: 1, gravacoes: 0 });
  });
  test('geração que começou ANTES do último evento (ou sem a folga) não confirma', async () => {
    const c = cena(); await c.evento(0); await c.evento(10); c.publica(9);
    expect((await c.varre(15)).acao).toBe('AGUARDANDO_JANELA'); expect(CTL(c.db).pendente).toBe(true);
    c.publica(10.5); expect((await c.varre(16)).acao).toBe('AGUARDANDO_JANELA'); expect(CTL(c.db).pendente).toBe(true);
    c.publica(11); expect((await c.varre(17)).acao).toBe('CONFIRMADO');
  });
  test('sem nenhuma pendência (documento inexistente) a varredura lê 1 documento e não grava', async () => {
    const c = cena(); expect((await c.varre(0)).acao).toBe('SEM_PENDENCIA'); expect(c.db.n).toEqual({ leituras: 1, gravacoes: 0 });
  });
});

describe('concorrência, duplicidade, fora de ordem e estornos', () => {
  test('20 eventos simultâneos ⇒ um único pedido; nenhum evento perdido', async () => {
    const c = cena(); const r = await Promise.all(Array.from({ length: 20 }, (_, i) => c.evento(0, { eventoMs: T0 - i * 1000 })));
    expect(r.filter(x => x.acao === 'DISPARADO')).toHaveLength(1); expect(c.pedidos).toHaveLength(1); expect(CTL(c.db)).toMatchObject({ eventos: 20, pendente: true, ultimoEventoMs: T0 });
  });
  test('varreduras e evento ao mesmo tempo, com a janela vencida ⇒ um único pedido', async () => {
    const c = cena(); await c.evento(0); await c.evento(5); await Promise.all([c.varre(31), c.varre(31), c.evento(31)]); expect(c.pedidos).toHaveLength(2);
  });
  test('fora de ordem não regride o último evento; reentrega já coberta não reabre pendência nem pede sync', async () => {
    const c = cena(); await c.evento(10); await c.evento(11, { eventoMs: em(2) }); expect(CTL(c.db).ultimoEventoMs).toBe(em(10)); expect(CTL(c.db).pendenteDesdeMs).toBe(em(2));
    c.publica(15); await c.varre(20); expect(CTL(c.db).pendente).toBe(false);
    expect((await c.evento(90, { eventoMs: em(10) })).acao).toBe('JA_COBERTO'); expect(CTL(c.db).pendente).toBe(false); expect(c.pedidos).toEqual([10]);
  });
  test('estorno (inclusive antes da baixa) segue o mesmo caminho e nada de valor é guardado', async () => {
    const c = cena(); await c.evento(0, { evento: 'recebimento.estornado' }); await c.evento(1, { evento: 'recebimento.baixado' }); await c.evento(2, { evento: 'pagamento.estornado' });
    expect(c.pedidos).toHaveLength(1); expect(CTL(c.db)).toMatchObject({ pendente: true, ultimoEventoMs: em(2) }); expect(JSON.stringify(c.db.st)).not.toMatch(/valor|total|R\$/);
  });
});

describe('trava, falhas e retentativas', () => {
  test('com sync em andamento (trava ativa) nada é pedido nem consome tentativa; ao liberar, pede', async () => {
    const c = cena(); await c.evento(0); await c.evento(35, { eventoMs: em(34) }); expect(c.pedidos).toEqual([0, 35]);
    c.trava(60); await c.evento(50); expect((await c.varre(55)).acao).toBe('AGUARDANDO_EXECUCAO');
    const antes = CTL(c.db).tentativas; expect((await c.varre(59)).acao).toBe('AGUARDANDO_EXECUCAO'); expect(CTL(c.db).tentativas).toBe(antes);
    c.publica(36);                                                          // a execução em curso começou antes do evento de 50 min
    expect((await c.varre(70)).acao).toBe('DISPARADO'); expect(CTL(c.db)).toMatchObject({ pendente: true, tentativas: 1 });
  });
  test('trava ativa no primeiro evento (LOCK_ATIVO) mantém pendente sem pedir', async () => {
    const c = cena(); c.trava(20); expect(await c.evento(0)).toEqual({ acao: 'COALESCIDO', motivo: 'AGUARDANDO_EXECUCAO' }); expect(c.pedidos).toEqual([]);
    expect((await c.varre(21)).acao).toBe('DISPARADO');
  });
  test('sync que não publica: esperas 30/60/120/180/180, limite de 5, depois ESGOTADO; a publicação do sync de 3 h reabre ou confirma', async () => {
    const c = cena(); await c.evento(0); let acoes = [];
    for (let m = 10; m <= 900; m += 10) acoes.push((await c.varre(m)).acao);
    expect(c.pedidos).toEqual([0, 30, 90, 210, 390]); expect(acoes[acoes.length - 1]).toBe('ESGOTADO'); expect(CTL(c.db).pendente).toBe(true);
    await c.evento(905); c.publica(904);                                    // publicou, mas antes do evento novo
    expect((await c.varre(940)).acao).toBe('DISPARADO'); expect(CTL(c.db).tentativas).toBe(1);
    c.publica(941); expect((await c.varre(950)).acao).toBe('CONFIRMADO');
  });
  test('eventos contínuos com sync saudável nunca esgotam as tentativas', async () => {
    const c = cena(); for (let m = 0; m <= 600; m += 10) { await c.evento(m); const ult = c.pedidos[c.pedidos.length - 1]; if (m - ult >= 10) c.publica(ult + 1); await c.varre(m + 1); }
    expect(c.pedidos.length).toBeGreaterThan(15); expect(CTL(c.db).tentativas).toBeLessThanOrEqual(1);
  });
  test('falha temporária ao disparar: pendência mantida, anotada e repetida', async () => {
    const c = cena(); const falha = async () => { throw new Error('503'); };
    expect((await c.evento(0, { disparar: falha })).acao).toBe('FALHA_DISPARO'); expect(CTL(c.db)).toMatchObject({ pendente: true, ultimoDisparoOk: false });
    expect((await c.varre(30, { disparar: falha })).acao).toBe('FALHA_DISPARO'); expect((await c.varre(90)).acao).toBe('DISPARADO'); expect(CTL(c.db).ultimoDisparoOk).toBe(true);
  });
  test('teto diário de pedidos (cota do GestãoClick) e reabertura no dia seguinte (Fortaleza)', async () => {
    const c = cena(); for (let m = 0; m < 899; m += 31) { if ((await c.evento(m)).acao === 'DISPARADO') c.publica(m + 2); }        // 09:00 → 23:59 em Fortaleza, sync sempre saudável
    expect(c.pedidos).toHaveLength(G.TETO_DIARIO); expect(CTL(c.db).pendente).toBe(true);
    expect((await c.varre(899)).acao).toBe('TETO_DIARIO'); expect((await c.varre(901)).acao).toBe('DISPARADO');   // 00:01 do dia seguinte
  });
  test('recuperação após interrupção: pedido reservado e processo morto antes de disparar ⇒ a varredura repete', async () => {
    const c = cena(); c.db.st.gc_refresh_fila = { financeiro_n1: { pendente: true, ultimoEventoMs: T0, pendenteDesdeMs: T0, ultimoPedidoMs: T0, tentativas: 1, proximaTentativaMs: em(30) } };
    expect((await c.varre(30)).acao).toBe('DISPARADO');
  });
  test('documento no formato antigo (só pendente/ultimoPedidoMs) é aproveitado', async () => {
    const c = cena(); c.db.st.gc_refresh_fila = { financeiro_n1: { pendente: true, ultimoPedidoMs: T0, eventos: 2 } };
    expect((await c.varre(31)).acao).toBe('DISPARADO'); expect(CTL(c.db).ultimoEventoMs).toBe(em(31));
  });
});

test('ponteiro e trava do Financeiro nunca entram em transação nem são gravados', async () => {
  const c = cena(); c.publica(-100); c.trava(-1); const tocados = [];
  c.db.falhar = ({ op, c: col }) => { if (col.startsWith('fin_n1')) tocados.push(op); };
  await c.evento(0); await c.varre(31); expect(new Set(tocados)).toEqual(new Set(['get']));
});

describe('contrato com o financeiroSync REAL', () => {
  const rodar = (db, agora) => S.executarSyncFinanceiro({ cli: gcFalso(massa({ hoje: '2026-11-26', nPagar: 10, nReceber: 15 })).cli, db: Object.assign(db, { batch: () => { const ops = []; return { set: (r, v) => ops.push([r, v]), commit: async () => { for (const [r, v] of ops) await r.set(v); } }; } }), agora, log: () => {} });
  test('`publicado_em` é o INÍCIO da execução (base da confirmação) e a geração publicada baixa a pendência', async () => {
    const c = cena(); await c.evento(0); const inicio = new Date(em(2));
    const r = await rodar(c.db, inicio); expect(r.ok).toBe(true);
    expect(c.db.st.fin_n1.active.publicado_em).toBe(inicio.toISOString()); expect((await c.varre(15)).acao).toBe('CONFIRMADO');
  });
  test('sync que falha não confirma: segue pendente e é repetido', async () => {
    const c = cena(); await c.evento(0);
    const r = await S.executarSyncFinanceiro({ cli: gcFalso({ falhas: { http: () => 500 } }).cli, db: c.db, agora: new Date(em(2)), log: () => {} }); expect(r.ok).toBe(false);
    expect((await c.varre(31)).acao).toBe('DISPARADO'); expect(CTL(c.db).pendente).toBe(true);
  });
});
