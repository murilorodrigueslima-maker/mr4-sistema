'use strict';
const G = require('../lib/financeiroGatilho'); const RF = require('../lib/refreshFila');
const fakeDb = () => { const m = {}; return { m, collection: c => ({ doc: i => ({ _k: c + '/' + i }) }), runTransaction: async fn => fn({ get: async r => ({ exists: r._k in m, data: () => m[r._k] }), set: (r, v) => { m[r._k] = v; } }) }; };
describe('Gatilho do Financeiro (só ATIVO, coalescido, inócuo em falha)', () => {
  test('primeiro evento dispara; os seguintes dentro de 30 min são coalescidos e marcam pendente', async () => {
    const db = fakeDb(); let n = 0; const disparar = async () => { n++; };
    expect((await G.solicitar({ db, evento: 'recebimento.baixado', disparar, agoraMs: 1000 })).acao).toBe('DISPARADO');
    expect((await G.solicitar({ db, evento: 'pagamento.estornado', disparar, agoraMs: 1000 + 60000 })).acao).toBe('COALESCIDO');
    expect(db.m['gc_refresh_fila/financeiro_n1'].pendente).toBe(true); expect(n).toBe(1);
    expect((await G.solicitar({ db, evento: 'recebimento.estornado', disparar, agoraMs: 1000 + G.INTERVALO_MIN_MS })).acao).toBe('DISPARADO'); expect(n).toBe(2);
  });
  test('evento de venda não aciona o Financeiro; falha ao disparar não propaga', async () => {
    const db = fakeDb(); expect((await G.solicitar({ db, evento: 'venda.cadastrada', disparar: async () => { throw new Error('x'); } })).acao).toBe('IGNORADO');
    expect((await G.solicitar({ db, evento: 'recebimento.baixado', disparar: async () => { throw new Error('sem permissão'); } })).acao).toBe('FALHA_DISPARO');
  });
  test('aplicarModo: fora do ATIVO nada é tocado; no ATIVO marca bloco, dispara Job e pede o Financeiro', async () => {
    const db = fakeDb(); let job = 0, fin = 0;
    for (const modo of ['DESLIGADO', 'RECEPCAO', 'SOMBRA']) { const r = await RF.aplicarModo({ db, modo, evento: 'recebimento.baixado', dispararJob: async () => { job++; }, dispararFinanceiro: async () => { fin++; } }); expect(r.efeito).toBe(false); }
    expect(Object.keys(db.m).length).toBe(0); expect(job + fin).toBe(0);
    const r = await RF.aplicarModo({ db, modo: 'ATIVO', evento: 'recebimento.baixado', dispararJob: async () => { job++; }, dispararFinanceiro: async () => { fin++; } });
    expect(r.blocos).toEqual(['financeiro']); expect(r.financeiroN1).toBe('DISPARADO'); expect(job).toBe(1); expect(fin).toBe(1);
  });
  test('o módulo não apaga nada nem escreve em fin_n1*', () => { const src = require('fs').readFileSync(require.resolve('../lib/financeiroGatilho'), 'utf8'); expect(src).not.toMatch(/\.delete\(|fin_n1_|'fin_n1'/); });
});
describe('Financeiro v2 ao vivo', () => {
  const H = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'modulos', 'financeiro-v2.html'), 'utf8');
  test('1 listener no ponteiro da geração; reutiliza o carregador; sem escrita', () => {
    expect((H.match(/observarAtualizacao\(/g) || []).length).toBe(1);
    expect(H).toMatch(/colecao: 'fin_n1', id: 'active', marcador: d => d\.geracao/); expect(H).toMatch(/async function carregarFin\(\)/); expect(H).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc)\b/);
  });
});
