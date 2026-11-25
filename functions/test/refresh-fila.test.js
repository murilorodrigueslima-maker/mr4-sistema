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
    expect((await F.reclamarSujos({ db })).sort()).toEqual(['pedidos', 'perfil360', 'vendas']); expect(await F.temSujos({ db })).toBe(false);
    await F.marcarSujo({ db, evento: 'recebimento.baixado' }); expect(await F.temSujos({ db })).toBe(true); expect(await F.reclamarSujos({ db })).toEqual(['financeiro']);
  });
  test('fila vazia ⇒ nada a fazer', async () => { const db = fakeDb(); expect(await F.reclamarSujos({ db })).toEqual([]); });
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
