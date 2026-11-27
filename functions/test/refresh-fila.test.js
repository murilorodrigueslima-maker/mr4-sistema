'use strict';
const F = require('../lib/refreshFila');
function fakeDb() { const st = {}; const ref = { get: async () => ({ exists: !!st.d, data: () => st.d }), }; const db = { st, collection: () => ({ doc: () => ref }), runTransaction: async fn => fn({ get: async () => ({ exists: !!st.d, data: () => st.d }), set: (_r, d) => { st.d = d; } }) }; ref.set = async d => { st.d = d; }; return db; }
describe('fila de bloco desatualizado', () => {
  test('venda nova marca vendas/pedidos/perfil360; recebimento/pagamento marcam financeiro; evento desconhecido nada', async () => {
    const db = fakeDb(); expect(await F.marcarSujo({ db, evento: 'venda.cadastrada' })).toEqual(['vendas', 'pedidos', 'perfil360']);
    expect(await F.marcarSujo({ db, evento: 'pagamento.estornado' })).toEqual(['financeiro']); expect(await F.marcarSujo({ db, evento: 'venda.excluida' })).toEqual([]);
    expect(Object.keys(db.st.d.blocos).sort()).toEqual(['financeiro', 'pedidos', 'perfil360', 'vendas']);
  });
  test('coalescência: 50 eventos (duplicados/fora de ordem/estornos) ⇒ UM bloco por nome; nada é somado (só contador de eventos)', async () => {
    const db = fakeDb(); for (let i = 0; i < 50; i++) await F.marcarSujo({ db, evento: i % 2 ? 'venda.situacao_alterada' : 'venda.cadastrada', agoraMs: 1000 + i });
    expect(Object.keys(db.st.d.blocos)).toHaveLength(3); expect(db.st.d.blocos.vendas.eventos).toBe(50); expect(db.st.d.blocos.vendas.sujoDesdeMs).toBe(1000);
    expect(JSON.stringify(db.st.d)).not.toMatch(/valor|total|R\$/);
  });
  test('reclamar devolve os blocos e zera a fila (nova marcação depois é preservada para o próximo ciclo)', async () => {
    const db = fakeDb(); await F.marcarSujo({ db, evento: 'venda.cadastrada' });
    expect((await F.reclamarSujos({ db, execucao: 'a' })).sort()).toEqual(['pedidos', 'perfil360', 'vendas']); expect(await F.temSujos({ db })).toBe(false);
    await F.confirmarPublicados({ db, blocos: ['pedidos', 'perfil360', 'vendas'], execucao: 'a' });
    await F.marcarSujo({ db, evento: 'recebimento.baixado' }); expect(await F.temSujos({ db })).toBe(true); expect(await F.reclamarSujos({ db, execucao: 'b' })).toEqual(['financeiro']);
  });
  test('fila vazia ⇒ nada a fazer', async () => { const db = fakeDb(); expect(await F.reclamarSujos({ db })).toEqual([]); });
});

describe('a pendência só sai depois da publicação', () => {
  test('publicação falhou (ou a execução caiu): o bloco continua pendente e entra na próxima; sem disparo em laço', async () => {
    const db = fakeDb(); await F.marcarSujo({ db, evento: 'venda.cadastrada', agoraMs: 100 });
    await F.reclamarSujos({ db, execucao: 'e1', agoraMs: 200 });
    await F.confirmarPublicados({ db, blocos: ['vendas', 'perfil360'], execucao: 'e1' });          // pedidos não publicou
    expect(Object.keys(db.st.d.emAndamento)).toEqual(['pedidos']); expect(db.st.d.emAndamento.pedidos.sujoDesdeMs).toBe(100);
    expect(await F.temSujos({ db })).toBe(false);                                                   // falha sozinha não dispara outra execução
    await F.marcarSujo({ db, evento: 'recebimento.baixado', agoraMs: 300 });
    expect(db.st.d.emAndamento.pedidos).toBeDefined();                                              // aviso novo não apaga a pendência
    expect((await F.reclamarSujos({ db, execucao: 'e2' })).sort()).toEqual(['financeiro', 'pedidos']);   // execução e2 cai sem confirmar
    expect((await F.reclamarSujos({ db, execucao: 'e3' })).sort()).toEqual(['financeiro', 'pedidos']);
  });
  test('aviso que chega DURANTE a execução é preservado; execução antiga não baixa pendência de outra', async () => {
    const db = fakeDb(); await F.marcarSujo({ db, evento: 'recebimento.baixado' });
    await F.reclamarSujos({ db, execucao: 'e1' }); await F.marcarSujo({ db, evento: 'pagamento.baixado' });
    await F.confirmarPublicados({ db, blocos: ['financeiro'], execucao: 'e1' });
    expect(db.st.d.emAndamento).toEqual({}); expect(db.st.d.blocos.financeiro.eventos).toBe(1); expect(await F.temSujos({ db })).toBe(true);
    await F.reclamarSujos({ db, execucao: 'e2' }); await F.confirmarPublicados({ db, blocos: ['financeiro'], execucao: 'e1' });
    expect(Object.keys(db.st.d.emAndamento)).toEqual(['financeiro']);
  });
});

describe('efeito operacional só no modo ATIVO', () => {
  test.each(['DESLIGADO', 'RECEPCAO', 'SOMBRA'])('%s não toca a fila nem dispara o Job', async modo => {
    const db = fakeDb(); const disparos = []; const r = await F.aplicarModo({ db, modo, evento: 'venda.cadastrada', dispararJob: async () => disparos.push(1) });
    expect(r.efeito).toBe(false); expect(db.st.d).toBeUndefined(); expect(disparos).toHaveLength(0);
  });
  test('ATIVO marca e dispara; falha ao disparar é inócua (blocos seguem marcados)', async () => {
    const db = fakeDb(); const r = await F.aplicarModo({ db, modo: 'ATIVO', evento: 'recebimento.baixado', dispararJob: async () => { throw new Error('x'); } });
    expect(r).toEqual({ efeito: true, blocos: ['financeiro'] }); expect(await F.temSujos({ db })).toBe(true);
  });
});
