'use strict';
// N35.17 — Worklist multi-vendedor por CONFIGURAÇÃO (sistema_usuarios.filaComercial). Puro, sem produção.
const fs = require('fs');
const path = require('path');
const { resolverParticipantes, gerarWorklistPorVendedor, indiceAtribuicoes } = require('../lib/dailyWorklist');
const { criarEstadoInicial, claimOportunidade, registrarOutcome } = require('../lib/filaOperacional');
const G = require('../lib/worklistGenerator');
const config = require('../lib/operationalConfig');

const NOW = new Date('2026-09-25T09:00:00.000Z'); // 06:00 America/Fortaleza
const quiet = { log() {} };
const fc = (o = {}) => ({ ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10, ...o });
const vend = (uid, o = {}) => [uid, { nome: uid.toUpperCase(), modulos: ['fila-comercial', 'fila-comercial-operar'], admin: false, filaComercial: fc(o) }];
const user = (uid, role = 'funcionario') => [uid, { ativo: true, role }];

function vendas(n, prefixo = 44400000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const gc = String(prefixo + i);
    for (let k = 0; k < 5; k++) {
      const d = new Date(Date.UTC(2026, 2, 5 + (i % 25)) - k * 20 * 86400000).toISOString().slice(0, 10);
      out.push({ id: gc + 'v' + k, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: String(200 + i), cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
    }
  }
  return out;
}
function dados({ sistema, users, estados = new Map(), n = 40 }) {
  return { perfis: [], clientes: [], vendas: vendas(n), estados, sistema: new Map(sistema), users: new Map(users) };
}
const gerar = (d, o = {}) => G.executarGeracaoWorklist({ db: null, now: NOW, mode: 'DRY_RUN', logger: quiet, lookupNome: async gc => 'Cliente ' + gc, dados: d, ...o });
const novas = (r, uid) => (r.doc.vendedores[uid] || { novas: [] }).novas.map(x => x.opportunityInstanceId);
function estadoPR(item, dono, dia = '2026-09-25') {
  let e = criarEstadoInicial(item.commercialEntityId, item.opportunityInstanceId, item.tipoOportunidade, '2026-09-22T12:00:00.000Z');
  e = claimOportunidade(e, dono, '2026-09-22T12:01:00.000Z');
  return { ...registrarOutcome(e, dono, 'PEDIU_RETORNO', '2026-09-22T12:02:00.000Z', { scheduledFor: dia }), nomeCliente: 'Nome do estado' };
}

const A = 'vend-a', B = 'vend-b', C = 'vend-c';

test('MV-01 1 vendedor ativo → recebe até 10 novas', async () => {
  const r = await gerar(dados({ sistema: [vend(A)], users: [user(A)] }));
  expect(novas(r, A)).toHaveLength(10);
});

test('MV-02 2 vendedores ativos → cada um recebe sua lista', async () => {
  const r = await gerar(dados({ sistema: [vend(A), vend(B)], users: [user(A), user(B)] }));
  expect(novas(r, A)).toHaveLength(10);
  expect(novas(r, B)).toHaveLength(10);
  expect(r.doc.vendedoresAtivos.sort()).toEqual([A, B]);
});

test('MV-03 nenhum opportunityInstanceId (nem entidade) duplicado entre listas', async () => {
  const r = await gerar(dados({ sistema: [vend(A), vend(B), vend(C)], users: [user(A), user(B), user(C)] }));
  const todos = [A, B, C].flatMap(u => novas(r, u));
  expect(todos).toHaveLength(30);
  expect(new Set(todos).size).toBe(30);
  const ents = Object.values(r.doc.atribuicoes).map(a => a.commercialEntityId);
  expect(new Set(ents).size).toBe(ents.length);
});

test('MV-04 vendedor pausado (recebeNovasOportunidades=false) → 0 novas', async () => {
  const r = await gerar(dados({ sistema: [vend(A, { recebeNovasOportunidades: false }), vend(B)], users: [user(A), user(B)] }));
  expect(novas(r, A)).toHaveLength(0);
  expect(novas(r, B)).toHaveLength(10);
});

test('MV-05 vendedor pausado MANTÉM seus follow-ups (não redistribui)', async () => {
  const base = await gerar(dados({ sistema: [vend(A)], users: [user(A)] }));
  const it = base.doc.vendedores[A].novas[3];
  const est = new Map([[it.opportunityInstanceId, estadoPR(it, A)]]);
  const r = await gerar(dados({ sistema: [vend(A, { recebeNovasOportunidades: false }), vend(B)], users: [user(A), user(B)], estados: est }));
  expect(r.doc.vendedores[A].followUps.map(x => x.opportunityInstanceId)).toEqual([it.opportunityInstanceId]);
  expect(r.doc.vendedores[A].novas).toHaveLength(0);
  expect(novas(r, B)).not.toContain(it.opportunityInstanceId);
});

test('MV-06 vendedor sem fila-comercial-operar → não participa', async () => {
  const s = [[A, { nome: 'A', modulos: ['fila-comercial'], filaComercial: fc() }]];
  const r = await gerar(dados({ sistema: s, users: [user(A)] }));
  expect(r.doc.vendedoresAtivos).toEqual([]);
  expect(resolverParticipantes(new Map(s), new Map([user(A)])).rejeitados).toEqual([{ uid: A, motivo: 'SEM_MODULO_OPERAR' }]);
});

test('MV-07 gestor → não participa, mesmo configurado e com operar', async () => {
  const r = await gerar(dados({ sistema: [vend('gestor-x')], users: [user('gestor-x', 'gestor')] }));
  expect(r.doc.vendedoresAtivos).toEqual([]);
});

test('MV-08 fila-comercial-gestao → não participa (gestão não opera)', async () => {
  const s = [['camila-x', { nome: 'C', modulos: ['fila-comercial-gestao', 'fila-comercial-operar'], filaComercial: fc() }]];
  expect(resolverParticipantes(new Map(s), new Map([user('camila-x')])).rejeitados).toEqual([{ uid: 'camila-x', motivo: 'PERFIL_GESTAO' }]);
});

test('MV-09 limite individual 5 → no máximo 5 (o outro continua 10)', async () => {
  const r = await gerar(dados({ sistema: [vend(A, { limiteNovasPorDia: 5 }), vend(B)], users: [user(A), user(B)] }));
  expect(novas(r, A)).toHaveLength(5);
  expect(novas(r, B)).toHaveLength(10);
  expect(r.doc.vendedoresConfig[A]).toEqual({ recebeNovas: true, limiteNovas: 5 });
});

test('MV-10 limite 10 → no máximo 10; limite inválido/absurdo → padrão/teto', async () => {
  const r = await gerar(dados({ sistema: [vend(A, { limiteNovasPorDia: 10 })], users: [user(A)] }));
  expect(novas(r, A)).toHaveLength(10);
  const p = resolverParticipantes(new Map([vend(A, { limiteNovasPorDia: 'dez' }), vend(B, { limiteNovasPorDia: 9999 })]), new Map([user(A), user(B)])).participantes;
  expect(p.find(x => x.uid === A).limite).toBe(config.DAILY_NEW_OPPORTUNITY_CAP);
  expect(p.find(x => x.uid === B).limite).toBe(config.MAX_NEW_OPPORTUNITY_CAP_PER_SELLER);
});

test('MV-11 retry da geração → resultado idêntico (mesmos dados)', async () => {
  const d = () => dados({ sistema: [vend(A), vend(B)], users: [user(A), user(B)] });
  const a = await gerar(d()); const b = await gerar(d());
  const sem = x => { const { geradoEm, ...y } = x; return JSON.stringify(y); };
  expect(sem(b.doc)).toBe(sem(a.doc));
});

test('MV-13 data de negócio em America/Fortaleza (22:30 local de 25/09 = 01:30Z de 26/09)', async () => {
  const r = await gerar(dados({ sistema: [vend(A)], users: [user(A)] }), { now: new Date('2026-09-26T01:30:00.000Z') });
  expect(r.doc.dataReferencia).toBe('2026-09-25');
});

test('MV-14 follow-up permanece com o dono mesmo com outros vendedores ativos', async () => {
  const base = await gerar(dados({ sistema: [vend(A), vend(B)], users: [user(A), user(B)] }));
  const it = base.doc.vendedores[B].novas[0];
  const est = new Map([[it.opportunityInstanceId, estadoPR(it, B)]]);
  const r = await gerar(dados({ sistema: [vend(A), vend(B)], users: [user(A), user(B)], estados: est }));
  expect(r.doc.vendedores[B].followUps.map(x => x.opportunityInstanceId)).toEqual([it.opportunityInstanceId]);
  expect(r.doc.vendedores[A].followUps).toHaveLength(0);
  expect(novas(r, A).concat(novas(r, B))).not.toContain(it.opportunityInstanceId);
});

test('MV-15 vendedor novo passa a receber worklist só com configuração (nenhum uid no código)', async () => {
  const antes = await gerar(dados({ sistema: [vend(A)], users: [user(A)] }));
  expect(antes.doc.vendedores['vendedor-teste-03']).toBeUndefined();
  const depois = await gerar(dados({ sistema: [vend(A), vend('vendedor-teste-03', { limiteNovasPorDia: 7 })], users: [user(A), user('vendedor-teste-03')] }));
  expect(novas(depois, 'vendedor-teste-03')).toHaveLength(7);
  expect(depois.doc.vendedoresRotulos['vendedor-teste-03']).toBe('VENDEDOR-TESTE-03');
});

test('MV-16 nenhum uid, e-mail ou nome de vendedor no código da fila', () => {
  const LIB = path.join(__dirname, '..', 'lib');
  const arquivos = ['dailyWorklist.js', 'worklistGenerator.js', 'filaQueueConfig.js', 'canaryCallable.js', 'worklistUniverso.js', 'filaNomes.js'];
  const src = arquivos.map(f => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(__dirname, '..', '..', 'modulos', 'fila-comercial.html'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', '..', 'modulos', 'fila-worklist-view.js'), 'utf8');
  expect(src).not.toMatch(/fabiana|ademir|camila|UGXinD3KVXX0ouYEfamBWjizC5C2|G9JDOBsquwdth77qgwtXpcjSxYd2|wVtUJcgwIqQK4VOlYBlREWk8C1Y2/i);
});

test('MV-17 algoritmo: distribuição justa e sem colisão com limites diferentes (5/10/3)', () => {
  const cands = Array.from({ length: 50 }, (_, i) => ({
    commercialEntityId: 'GC_NATIVE:' + (9000 + i), opportunityInstanceId: (9000 + i).toString(16).padStart(16, '0'),
    tipoOportunidade: 'REATIVACAO_120D', decisaoAcaoComercial: 'AGIR_AGORA', prioridade: 90, diasSemComprar: 300 - i,
  }));
  const wl = gerarWorklistPorVendedor({ candidatos: cands, estados: new Map(), dataReferencia: '2026-09-25',
    participantes: [{ uid: A, recebeNovas: true, limite: 5 }, { uid: B, recebeNovas: true, limite: 10 }, { uid: C, recebeNovas: true, limite: 3 }] });
  expect([A, B, C].map(u => wl.porVendedor[u].newOpportunities.length)).toEqual([5, 10, 3]);
  expect(() => indiceAtribuicoes(wl)).not.toThrow();
  expect(wl.backlog).toHaveLength(32);
});
