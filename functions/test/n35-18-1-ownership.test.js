'use strict';
// N35.18.1 — Ownership persistente entre dias da Worklist V2. Puro (db=null), sem produção.
// Emulador (concorrência/idempotência/troca de data pelo caminho real): n35-18-1-ownership-emulator.test.js
const fs = require('fs');
const path = require('path');
const G = require('../lib/worklistGenerator');
const QC = require('../lib/filaQueueConfig');
const { criarEstadoInicial, claimOportunidade, registrarOutcome } = require('../lib/filaOperacional');
const { contemDocumento } = require('../lib/nomeExibicao');

const D0 = new Date('2026-09-25T09:00:00.000Z'); // sexta 06:00 Fortaleza
const D1 = new Date('2026-09-28T09:00:00.000Z'); // segunda 06:00 Fortaleza
const D2 = new Date('2026-09-29T09:00:00.000Z'); // terça
const quiet = { log() {} };
const fc = (o = {}) => ({ ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10, ...o });
const vend = (uid, o = {}) => [uid, { nome: uid.toUpperCase(), modulos: ['fila-comercial', 'fila-comercial-operar'], admin: false, filaComercial: fc(o) }];
const user = (uid, o = {}) => [uid, { ativo: true, role: 'funcionario', ...o }];

function vendas(n, prefixo = 55500000) {
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
const A = 'vend-a', B = 'vend-b', C = 'vend-c';
function dados({ sistema = [vend(A), vend(B)], users = [user(A), user(B)], estados = new Map(), n = 80, anterior } = {}) {
  const d = { perfis: [], clientes: [], vendas: vendas(n), estados, sistema: new Map(sistema), users: new Map(users) };
  if (anterior !== undefined) d.worklistAnterior = anterior;
  return d;
}
const gerar = (d, now, o = {}) => G.executarGeracaoWorklist({ db: null, now, mode: 'DRY_RUN', logger: quiet, lookupNome: async gc => 'Cliente ' + gc, dados: d, ...o });
const ids = (doc, uid, grupo = 'novas') => ((doc.vendedores[uid] || {})[grupo] || []).map(x => x.opportunityInstanceId);
const todos = (doc, uid) => ['novas', 'pendentes', 'followUps', 'emAtendimento'].flatMap(g => ids(doc, uid, g));
const itemDe = (doc, opp) => {
  for (const v of Object.values(doc.vendedores)) for (const g of ['novas', 'pendentes', 'followUps', 'emAtendimento']) { const x = (v[g] || []).find(i => i.opportunityInstanceId === opp); if (x) return x; }
  return null;
};
function semDuplicidade(doc) {
  const opp = new Map(), ent = new Map();
  for (const uid of doc.vendedoresAtivos) for (const g of ['novas', 'pendentes', 'followUps', 'emAtendimento']) for (const x of doc.vendedores[uid][g] || []) {
    expect(opp.has(x.opportunityInstanceId)).toBe(false);
    if (ent.has(x.commercialEntityId)) expect(ent.get(x.commercialEntityId)).toBe(uid);
    opp.set(x.opportunityInstanceId, uid); ent.set(x.commercialEntityId, uid);
  }
}
/** Nenhuma oportunidade que existia em `antes` troca de dono em `depois`. */
function ownershipPreservado(antes, depois) {
  let trocas = 0;
  for (const [opp, a] of Object.entries(depois.atribuicoes)) if (antes.atribuicoes[opp] && antes.atribuicoes[opp].uid !== a.uid) trocas++;
  return trocas;
}
function estado(item, dono, passos) {
  let e = criarEstadoInicial(item.commercialEntityId, item.opportunityInstanceId, item.tipoOportunidade, '2026-09-25T12:00:00.000Z');
  let t = Date.parse('2026-09-25T12:01:00.000Z');
  for (const p of passos) {
    const iso = new Date(t).toISOString(); t += 60000;
    if (p === 'CLAIM') e = claimOportunidade(e, dono, iso);
    else e = registrarOutcome(e, dono, p.outcome || p, iso, p.meta || {});
  }
  return e;
}

let d0;
beforeAll(async () => { d0 = (await gerar(dados(), D0)).doc; });

describe('BUG — reprodução (comportamento sem ownership anterior)', () => {
  test('BUG-01 sem a worklist anterior, novas não tocadas trocam de vendedor no dia seguinte', async () => {
    // conjunto de 60 clientes: a ordem canônica se mantém entre os dias e o round-robin inverte o vendedor inicial
    const b0 = (await gerar(dados({ n: 60 }), D0)).doc;
    expect(ids(b0, A)).toHaveLength(10);
    expect(ids(b0, B)).toHaveLength(10);
    const s = await gerar(dados({ n: 60 }), D1); // legado: sem worklistAnterior
    const deA = new Set(ids(b0, A)), deB = new Set(ids(b0, B));
    const trocas = ids(s.doc, B).filter(x => deA.has(x)).length + ids(s.doc, A).filter(x => deB.has(x)).length;
    expect(trocas).toBeGreaterThan(0); // CROSS_DAY_REASSIGNMENT_REPRODUCED=YES
  });
});

describe('Ownership entre dias', () => {
  test('OW-01 cliente da vendedora A permanece com A no dia seguinte', async () => {
    const r = (await gerar(dados({ anterior: d0 }), D1)).doc;
    expect(ids(r, A, 'pendentes').sort()).toEqual(ids(d0, A).sort());
    expect(ownershipPreservado(d0, r)).toBe(0);
  });

  test('OW-02 cliente do vendedor B permanece com B', async () => {
    const r = (await gerar(dados({ anterior: d0 }), D1)).doc;
    expect(ids(r, B, 'pendentes').sort()).toEqual(ids(d0, B).sort());
    for (const opp of ids(d0, B)) expect(r.atribuicoes[opp].uid).toBe(B);
  });

  test('OW-03 cliente nunca aparece para dois vendedores (oportunidade e entidade)', async () => {
    const r = (await gerar(dados({ anterior: d0 }), D1)).doc;
    semDuplicidade(r);
    const novasA = new Set(ids(r, A)), novasB = new Set(ids(r, B));
    for (const x of novasA) expect(novasB.has(x)).toBe(false);
    for (const x of [...ids(r, A), ...ids(r, B)]) expect(d0.atribuicoes[x]).toBeUndefined(); // novas são realmente novas
  });

  test('OW-04 10 pendências de A + novas → nenhuma pendência vai para B; limite vale só para novas', async () => {
    const r = (await gerar(dados({ anterior: d0 }), D1)).doc;
    expect(ids(r, A, 'pendentes')).toHaveLength(10);
    expect(ids(r, A)).toHaveLength(10);
    expect(ids(r, B)).toHaveLength(10);
    const deA = new Set(ids(d0, A));
    expect(todos(r, B).filter(x => deA.has(x))).toHaveLength(0);
    expect(r.vendedoresConfig[A].limiteNovas).toBe(10);
    expect(r.contagens.pendenciasCarregadas).toBe(20);
    for (const x of r.vendedores[A].pendentes) expect(x.atribuidoDesde).toBe('2026-09-25');
    for (const opp of ids(d0, A)) expect(r.atribuicoes[opp]).toMatchObject({ uid: A, grupo: 'pendentes', desde: '2026-09-25' });
  });

  test('OW-05 A pausada (recebeNovas=false) mantém as pendências e não recebe novas', async () => {
    const r = (await gerar(dados({ sistema: [vend(A, { recebeNovasOportunidades: false }), vend(B)], anterior: d0 }), D1)).doc;
    expect(ids(r, A)).toHaveLength(0);
    expect(ids(r, A, 'pendentes').sort()).toEqual(ids(d0, A).sort());
    const deA = new Set(ids(d0, A));
    expect(todos(r, B).filter(x => deA.has(x))).toHaveLength(0);
    expect(ids(r, B)).toHaveLength(10);
  });

  test('OW-06 B pausado mantém as pendências', async () => {
    const r = (await gerar(dados({ sistema: [vend(A), vend(B, { recebeNovasOportunidades: false })], anterior: d0 }), D1)).doc;
    expect(ids(r, B)).toHaveLength(0);
    expect(ids(r, B, 'pendentes').sort()).toEqual(ids(d0, B).sort());
    const deB = new Set(ids(d0, B));
    expect(todos(r, A).filter(x => deB.has(x))).toHaveLength(0);
  });

  test('OW-07 follow-up mantém o dono (fora das pendências e das novas)', async () => {
    const it = d0.vendedores[A].novas[0];
    const e = estado(it, A, ['CLAIM', { outcome: 'PEDIU_RETORNO', meta: { scheduledFor: '2026-09-28' } }]);
    const r = (await gerar(dados({ estados: new Map([[it.opportunityInstanceId, e]]), anterior: d0 }), D1)).doc;
    expect(ids(r, A, 'followUps')).toEqual([it.opportunityInstanceId]);
    expect(ids(r, A, 'pendentes')).not.toContain(it.opportunityInstanceId);
    expect(todos(r, B)).not.toContain(it.opportunityInstanceId);
    expect(ids(r, A, 'pendentes')).toHaveLength(9);
  });

  test('OW-08 claim expirado NÃO troca o dono', async () => {
    const it = d0.vendedores[A].novas[1];
    const e = estado(it, A, ['CLAIM']); // claim de sexta 12:01 → expirado na segunda
    const r = (await gerar(dados({ estados: new Map([[it.opportunityInstanceId, e]]), anterior: d0 }), D1)).doc;
    expect(ids(r, A, 'pendentes')).toContain(it.opportunityInstanceId);
    expect(todos(r, B)).not.toContain(it.opportunityInstanceId);
    expect(r.atribuicoes[it.opportunityInstanceId].uid).toBe(A);
  });

  test('OW-09 outcome conclusivo remove da fila ativa (CONCLUIDA + supressão), sem ir para ninguém', async () => {
    const it = d0.vendedores[A].novas[2];
    const e = estado(it, A, ['CLAIM', 'CONVERSA_REALIZADA']);
    const r = (await gerar(dados({ estados: new Map([[it.opportunityInstanceId, e]]), anterior: d0 }), D1)).doc;
    expect(todos(r, A)).not.toContain(it.opportunityInstanceId);
    expect(todos(r, B)).not.toContain(it.opportunityInstanceId);
    expect(Object.values(r.contagens.pendenciasEncerradas).reduce((s, n) => s + n, 0)).toBe(1);
  });

  test('OW-10 cooldown respeitado (SEM_INTERESSE_AGORA e 3× SEM_RESPOSTA)', async () => {
    const i1 = d0.vendedores[A].novas[3], i2 = d0.vendedores[B].novas[0];
    const e1 = estado(i1, A, ['CLAIM', 'SEM_INTERESSE_AGORA']);
    const e2 = estado(i2, B, ['CLAIM', 'SEM_RESPOSTA', 'CLAIM', 'SEM_RESPOSTA', 'CLAIM', 'SEM_RESPOSTA']);
    expect(e2.cooledUntil).toBeTruthy();
    const r = (await gerar(dados({ estados: new Map([[i1.opportunityInstanceId, e1], [i2.opportunityInstanceId, e2]]), anterior: d0 }), D1)).doc;
    for (const opp of [i1.opportunityInstanceId, i2.opportunityInstanceId]) {
      expect(todos(r, A)).not.toContain(opp);
      expect(todos(r, B)).not.toContain(opp);
    }
    expect(r.contagens.pendenciasEncerradas.COOLDOWN).toBe(2);
  });

  test('OW-11 terceiro vendedor adicionado só por configuração: recebe novas, pendências intactas', async () => {
    const r = (await gerar(dados({ sistema: [vend(A), vend(B), vend(C, { limiteNovasPorDia: 5 })], users: [user(A), user(B), user(C)], anterior: d0 }), D1)).doc;
    expect(r.vendedoresAtivos).toEqual([A, B, C]);
    expect(ids(r, C)).toHaveLength(5);
    expect(ids(r, C, 'pendentes')).toHaveLength(0);
    expect(ownershipPreservado(d0, r)).toBe(0);
    semDuplicidade(r);
  });

  test('OW-12 vendedor futuro não exige código: mesma função, só configuração', async () => {
    const X = 'qualquer-uid-futuro-' + Date.now();
    const r = (await gerar(dados({ sistema: [vend(A), vend(B), vend(X)], users: [user(A), user(B), user(X)], anterior: d0 }), D1)).doc;
    expect(r.vendedoresAtivos).toContain(X);
    expect(ids(r, X).length).toBeGreaterThan(0);
    expect(ownershipPreservado(d0, r)).toBe(0);
  });

  test('OW-15 mudança de data mantém ownership em cadeia (sexta → segunda → terça)', async () => {
    const r1 = (await gerar(dados({ anterior: d0 }), D1)).doc;
    const r2 = (await gerar(dados({ anterior: r1 }), D2)).doc;
    expect(ids(r2, A, 'pendentes').sort()).toEqual([...ids(r1, A, 'pendentes'), ...ids(r1, A)].sort());
    expect(ownershipPreservado(d0, r2)).toBe(0);
    expect(ownershipPreservado(r1, r2)).toBe(0);
    for (const opp of ids(d0, A)) expect(r2.atribuicoes[opp].desde).toBe('2026-09-25');
    for (const opp of ids(r1, A)) expect(r2.atribuicoes[opp].desde).toBe('2026-09-28');
    semDuplicidade(r2);
  });

  test('OW-16 nenhum CPF/CNPJ reaparece (nome legado com documento é sanitizado; só documento → retida)', async () => {
    const ant = JSON.parse(JSON.stringify(d0));
    const [o1, o2] = ids(d0, A);
    ant.atribuicoes[o1].nomeCliente = 'MARIA TESTE 123.456.789-09';
    ant.atribuicoes[o2].nomeCliente = '12.345.678/0001-95';
    const lookupNulo = async () => null; // sem GC: nome vem só da atribuição anterior
    const r = (await gerar(dados({ anterior: ant }), D1, { lookupNome: lookupNulo })).doc;
    const nomes = [
      ...Object.values(r.vendedores).flatMap(v => ['novas', 'pendentes', 'followUps', 'emAtendimento'].flatMap(g => v[g].map(x => x.nomeCliente))),
      ...Object.values(r.atribuicoes).map(a => a.nomeCliente),
      ...Object.values(r.pendenciasRetidas).map(a => a.nomeCliente),
    ].filter(Boolean);
    expect(nomes.length).toBeGreaterThan(20);
    for (const n of nomes) expect(contemDocumento(n)).toBe(false);
    expect(itemDe(r, o1).nomeCliente).toBe('MARIA TESTE');
    expect(itemDe(r, o2)).toBeNull();
    expect(r.pendenciasRetidas[o2]).toMatchObject({ uid: A, motivo: 'SEM_NOME' });
    expect(todos(r, B)).not.toContain(o2);
  });

  test('OW-17 canários continuam excluídos mesmo se aparecerem como atribuição anterior', async () => {
    const ant = JSON.parse(JSON.stringify(d0));
    const can = QC.CANARY_OPPORTUNITY_IDS[0];
    ant.atribuicoes[can] = { uid: A, grupo: 'novas', commercialEntityId: 'GC_NATIVE:99999999', tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'CANARIO' };
    const r = (await gerar(dados({ anterior: ant }), D1)).doc;
    for (const c of QC.CANARY_OPPORTUNITY_IDS) { expect(todos(r, A)).not.toContain(c); expect(todos(r, B)).not.toContain(c); expect(r.atribuicoes[c]).toBeUndefined(); }
    expect(r.contagens.pendenciasEncerradas.CANARIO).toBe(1);
  });

  test('OW-18 nenhum UID real de vendedor no código da fila', () => {
    const REAIS = ['UGXinD3KVXX0ouYEfamBWjizC5C2', 'G9JDOBsquwdth77qgwtXpcjSxYd2', 'wVtUJcgwIqQK4VOlYBlREWk8C1Y2', 'BN8skgBkkbbxQvY1kvsBDLCBo6b2'];
    const arquivos = ['dailyWorklist.js', 'worklistGenerator.js', 'filaQueueConfig.js', 'filaOperacional.js', 'worklistUniverso.js'];
    for (const f of arquivos) {
      const src = fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8');
      for (const u of REAIS) expect(src.includes(u)).toBe(false);
    }
    const view = fs.readFileSync(path.join(__dirname, '../../modulos/fila-worklist-view.js'), 'utf8');
    for (const u of REAIS) expect(view.includes(u)).toBe(false);
  });
});

describe('Frontend (view-model) — pendências visíveis', () => {
  const WV = require('../../modulos/fila-worklist-view.js');
  test('OW-V1 vendedora vê pendências antes das novas; limite conta só as novas; gestão enxerga as pendências', async () => {
    const r = (await gerar(dados({ anterior: d0 }), D1)).doc;
    const v = WV.montarVisaoVendedor({ doc: r, uid: A, hoje: '2026-09-28', agoraMs: D1.getTime(), opMap: new Map(), podeOperar: true });
    expect(v.novas).toHaveLength(20);
    expect(v.novas.slice(0, 10).every(x => x.grupoOrigem === 'pendentes')).toBe(true);
    expect(v.contagens.novas).toBe(10);
    expect(v.contagens.pendentesAnteriores).toBe(10);
    const vb = WV.montarVisaoVendedor({ doc: r, uid: B, hoje: '2026-09-28', agoraMs: D1.getTime(), opMap: new Map(), podeOperar: true });
    const deA = new Set(ids(d0, A));
    expect(vb.novas.filter(x => deA.has(x.item.opportunityInstanceId))).toHaveLength(0);
    const g = WV.montarVisaoGestao({ doc: r, hoje: '2026-09-28', agoraMs: D1.getTime(), opMap: new Map() });
    const ga = g.find(s => s.uid === A);
    expect(ga.contagens.anteriores).toBe(10);
    expect(ga.linhas.filter(l => l.grupoOrigem === 'pendentes')).toHaveLength(10);
  });
});

describe('Bordas do ownership', () => {
  test('OW-19 dono removido/inativo → pendências RETIDAS (nem exibidas, nem redistribuídas); voltam quando reativado', async () => {
    const r = (await gerar(dados({ sistema: [vend(A, { ativo: false }), vend(B)], anterior: d0 }), D1)).doc;
    expect(r.vendedoresAtivos).toEqual([B]);
    const deA = ids(d0, A);
    expect(todos(r, B).filter(x => deA.includes(x))).toHaveLength(0);
    for (const opp of deA) expect(r.pendenciasRetidas[opp]).toMatchObject({ uid: A, motivo: 'DONO_FORA_DA_FILA', desde: '2026-09-25' });
    expect(ids(r, B)).toHaveLength(10); // B continua recebendo novas normalmente
    const r2 = (await gerar(dados({ anterior: r }), D2)).doc; // A reativada
    expect(ids(r2, A, 'pendentes').sort()).toEqual([...deA].sort());
    expect(Object.keys(r2.pendenciasRetidas)).toHaveLength(0);
  });

  test('OW-20 usuário users.ativo=false também retém (sem transferência automática)', async () => {
    const r = (await gerar(dados({ users: [user(A, { ativo: false }), user(B)], anterior: d0 }), D1)).doc;
    expect(Object.values(r.pendenciasRetidas).filter(p => p.uid === A)).toHaveLength(10);
    expect(todos(r, B).filter(x => ids(d0, A).includes(x))).toHaveLength(0);
  });

  test('OW-21 mesma data de referência (prévia) mantém as novas do dono como novas e completa só o que falta', async () => {
    const soA = (await gerar(dados({ sistema: [vend(A)], users: [user(A)] }), D0)).doc;
    const r = (await gerar(dados({ anterior: soA }), D0)).doc;
    expect(ids(r, A)).toEqual(ids(soA, A)); // mesma lista, mesma ordem
    expect(ids(r, A, 'pendentes')).toHaveLength(0);
    expect(ids(r, B)).toHaveLength(10);
    for (const x of ids(r, B)) expect(soA.atribuicoes[x]).toBeUndefined();
  });

  test('OW-22 documento anterior legado (sem "desde") usa a data do documento; documento futuro é ignorado', async () => {
    const ant = JSON.parse(JSON.stringify(d0));
    for (const a of Object.values(ant.atribuicoes)) delete a.desde;
    const r = (await gerar(dados({ anterior: ant }), D1)).doc;
    for (const opp of ids(d0, A)) expect(r.atribuicoes[opp].desde).toBe('2026-09-25');
    const futuro = { ...d0, dataReferencia: '2026-10-01' };
    const rf = (await gerar(dados({ anterior: futuro }), D1)).doc;
    expect(rf.contagens.pendenciasCarregadas).toBe(0);
  });
});
