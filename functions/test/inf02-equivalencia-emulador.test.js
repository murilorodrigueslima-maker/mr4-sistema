'use strict';
// INF-02 — EQUIVALÊNCIA (EMULADOR): as consultas escopadas de crmConsulta devolvem o mesmo resultado que a leitura da coleção
// inteira (oráculo = regra original sobre TODOS os documentos), lendo menos. Dados sintéticos com semente fixa. + Rules do sinalizador.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const Q = require('../lib/crmConsulta');
const T = require('../lib/crmTimeline');
const SINAL = require('../lib/filaSinal');
jest.setTimeout(120000);

const AGORA = '2026-11-26T15:00:00.000Z', HOJE = '2026-11-26';
const A = 'inf2-a', B = 'inf2-b', G = 'inf2-ges', OUTRO = 'inf2-x';
const COLS = ['interacoes_fila', 'fila_comercial', 'carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial', 'vendas_gc', 'clientes', 'crm_fila_versao'];
let semente = 20261126;
const rnd = () => ((semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0) / 4294967296);
const um = l => l[Math.floor(rnd() * l.length)];
const somar = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const opp = i => 'abcd' + String(i).padStart(12, '0');
const ENTS = Array.from({ length: 70 }, (_, i) => (i % 7 === 0 ? 'MR4_LINKED:inf2cli' + String(i).padStart(4, '0') : 'GC_NATIVE:' + (99300000 + i)));
const gcDe = e => (e.startsWith('GC_NATIVE:') ? e.slice(10) : String(99400000 + Number(e.slice(-4))));
const estadosTodos = [];

async function limpar() { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } }

beforeAll(async () => {
  await limpar();
  for (const [uid, role, mods] of [[A, 'funcionario', ['fila-comercial-operar']], [B, 'funcionario', ['fila-comercial-operar']], [G, 'gestor', []]]) {
    await db.doc('users/' + uid).set({ role, ativo: true }); await db.doc('sistema_usuarios/' + uid).set({ nome: 'Pessoa ' + uid, modulos: mods });
  }
  const lote = [];
  for (let i = 0; i < 220; i++) {
    const eventos = []; let dia = somar(HOJE, -Math.floor(rnd() * 130));
    const dono = um([A, A, B, B, OUTRO]);
    for (let k = 0, n = Math.floor(rnd() * 4); k < n; k++) {
      if (dia > HOJE) dia = HOJE;
      eventos.push({ tipo: um(['OUTCOME_REGISTERED', 'OUTCOME_REGISTERED', 'CLAIMED', 'RELEASED']), operadorId: rnd() < 0.8 ? dono : um([A, B, OUTRO]), timestamp: dia + 'T13:00:0' + k + '.000Z',
        outcome: um(['CONVERSA_REALIZADA', 'SEM_RESPOSTA', 'PEDIU_RETORNO', 'CONTATO_INVALIDO']) });
      dia = somar(dia, Math.floor(rnd() * 25));
    }
    const claim = rnd() < 0.12;
    const e = { opportunityInstanceId: opp(i), commercialEntityId: um(ENTS), estado: claim ? 'EM_ATENDIMENTO' : um(['DISPONIVEL', 'CONCLUIDA', 'CONCLUIDA', 'AGUARDANDO_RETORNO']),
      claimAtual: claim ? { operadorId: um([A, B, OUTRO]), claimadoEm: AGORA } : null, eventos, nextFollowUpAt: rnd() < 0.15 ? somar(HOJE, Math.floor(rnd() * 9) - 4) : null,
      atualizadoEm: eventos.length ? eventos[eventos.length - 1].timestamp : somar(HOJE, -Math.floor(rnd() * 130)) + 'T10:00:00.000Z' };
    estadosTodos.push(e); lote.push(db.doc('interacoes_fila/' + opp(i)).set(e));
  }
  ENTS.forEach((e, i) => {
    if (e.startsWith('MR4_LINKED:')) lote.push(db.doc('clientes/' + e.slice(11)).set({ nome: 'Cliente ' + i, gestaoClickId: gcDe(e) }));
    const vendeuNaSemana = rnd() < 0.35;                                   // histórico longo, poucas vendas recentes (como na base real)
    for (let k = 0, n = 8 + Math.floor(rnd() * 20); k < n; k++) {
      const id = `inf2v${i}_${k}`; const data = somar(HOJE, vendeuNaSemana && k < 2 ? -Math.floor(rnd() * 7) : -7 - Math.floor(rnd() * 400));
      lote.push(db.doc('vendas_gc/' + id).set({ id, cliente_id: rnd() < 0.2 ? Number(gcDe(e)) : gcDe(e), data, nome_situacao: rnd() < 0.1 ? 'Cancelada' : 'Concretizada', valor_total: rnd() < 0.1 ? '0' : '150' }));
    }
  });
  // worklist: A com mais de 60 oportunidades (3 lotes de 'in'), parte sem documento de atendimento; B com poucas
  const item = (i, e) => ({ opportunityInstanceId: opp(i), commercialEntityId: e, nomeCliente: 'N' + i, tipoOportunidade: 'REATIVACAO_120D' });
  const itensA = Array.from({ length: 70 }, (_, k) => item(k < 25 ? k * 3 : 500 + k, ENTS[k % 40])), itensB = Array.from({ length: 12 }, (_, k) => item(100 + k, ENTS[40 + k]));
  lote.push(db.doc('fila_comercial/worklist').set({ schemaVersion: 'worklist-v2', dataReferencia: HOJE, vendedoresAtivos: [A, B], vendedoresRotulos: { [A]: 'A', [B]: 'B' },
    vendedores: { [A]: { novas: itensA.slice(0, 10), pendentes: itensA.slice(10), followUps: [], emAtendimento: [] }, [B]: { novas: itensB, pendentes: [], followUps: [], emAtendimento: [] } },
    atribuicoes: Object.fromEntries([...itensA.map(i => [i.opportunityInstanceId, { uid: A, commercialEntityId: i.commercialEntityId }]), ...itensB.map(i => [i.opportunityInstanceId, { uid: B, commercialEntityId: i.commercialEntityId }])]),
    pendenciasRetidas: {} }));
  for (const [n, uid, i] of [[1, A, 201], [2, B, 202]]) lote.push(db.doc('carteira_reativacoes/inf2r' + n).set({ destinoUid: uid, estado: 'RESERVADA', portfolioId: 'GC:' + (99300060 + n), opportunityInstanceId: opp(i), reservaAte: somar(HOJE, 5), nomeCliente: 'R' + n }));
  lote.push(db.doc('carteira_comercial/GC:99300066').set({ ownerUid: A }));
  await Promise.all(lote);
});
afterAll(async () => { await limpar(); for (const u of [A, B, G]) { await db.doc('users/' + u).delete(); await db.doc('sistema_usuarios/' + u).delete(); } });

/** Conta documentos cobrados (consulta vazia = 1 leitura). */
function contador() {
  const n = { total: 0, porColecao: {} };
  const soma = (c, q) => { n.total += q; n.porColecao[c] = (n.porColecao[c] || 0) + q; };
  const consulta = (c, q) => new Proxy(q, { get(t, k) {
    const v = t[k]; if (typeof v !== 'function') return v;
    if (k === 'get') return async (...a) => { const s = await v.apply(t, a); soma(c, s.docs ? Math.max(1, s.docs.length) : 1); return s; };
    return (...a) => { const r = v.apply(t, a); return ['where', 'select', 'limit', 'orderBy', 'doc'].includes(k) ? consulta(c, r) : r; };
  } });
  const store = { collection: c => consulta(c, db.collection(c)), getAll: async (...r) => { soma('getAll', r.length); return db.getAll(...r.map(x => db.doc(x.path))); } };
  return { store, n };
}
const chamar = (uid, data, store = db) => Q.crmConsultaHandler({ auth: { uid }, data }, { db: store, now: () => new Date(AGORA) });
const outcomes = e => (e.eventos || []).filter(x => x.tipo === 'OUTCOME_REGISTERED');
const todos = async () => (await db.collection('interacoes_fila').get()).docs.map(d => d.data());

describe('fila', () => {
  test.each([A, B])('vendedor %s: mesmas interações (conteúdo e ordem) da leitura completa, só as dele, lendo menos', async uid => {
    const { store, n } = contador(); const r = await chamar(uid, { acao: 'fila' }, store);
    const wl = (await db.doc('fila_comercial/worklist').get()).data();
    const minhas = new Set(Object.values(wl.vendedores[uid]).flat().map(i => i.opportunityInstanceId).concat(r.reativacoes.map(x => x.opportunityInstanceId)));
    const esperado = (await todos()).filter(e => { const u = outcomes(e).slice(-1)[0];
      return (e.claimAtual && e.claimAtual.operadorId === uid) || (u && u.operadorId === uid && e.estado !== 'CONCLUIDA' && e.nextFollowUpAt) || minhas.has(e.opportunityInstanceId); });
    expect(esperado.length).toBeGreaterThan(5);
    expect(r.interacoes.map(i => i.opportunityInstanceId)).toEqual(esperado.map(i => i.opportunityInstanceId));
    r.interacoes.forEach((i, k) => {
      const e = esperado[k];
      expect(i.eventos).toEqual(e.eventos.map(x => (x.operadorId !== uid ? { tipo: x.tipo, outcome: x.outcome, timestamp: x.timestamp, operadorId: 'OUTRO' } : x)));
      expect([i.estado, i.nextFollowUpAt, i.commercialEntityId]).toEqual([e.estado, e.nextFollowUpAt, e.commercialEntityId]);
    });
    expect(JSON.stringify(r)).not.toContain(uid === A ? B : A);
    expect(n.porColecao.interacoes_fila).toBeLessThan(estadosTodos.length / 2);
  });
  test('gestão continua recebendo todos os atendimentos', async () => {
    const r = await chamar(G, { acao: 'fila' });
    expect(r.escopo).toBe('GESTAO'); expect(r.interacoes).toEqual(await todos());
  });
  test('a resposta traz a versão do sinalizador (vazia quando ainda não existe)', async () => {
    expect((await chamar(A, { acao: 'fila' })).versao).toBe('');
    await SINAL.sinalizarFila({ db, FieldValue: admin.firestore.FieldValue, eventId: 'evt-9' });
    for (const u of [A, G]) expect((await chamar(u, { acao: 'fila' })).versao).toBe('evt-9');
    expect(Object.keys((await db.doc('crm_fila_versao/estado').get()).data()).sort()).toEqual(['atualizadoEm', 'versao']);
  });
});

describe('cartões, Cliente 360 e indicadores', () => {
  test.each([A, B])('vendedor %s: cartões negam exatamente as mesmas entidades', async uid => {
    const wl = (await db.doc('fila_comercial/worklist').get()).data();
    const escopo = await Q.__internals.escopoVendedor(db, uid, wl, await todos());          // regra original sobre TODOS os documentos
    const { store, n } = contador(); const r = await chamar(uid, { acao: 'cartoes', entidades: ENTS }, store);
    expect(r.negadas).toBe(ENTS.filter(e => !escopo.has(e)).length);
    for (const e of Object.keys(r.cartoes)) expect(escopo.has(e)).toBe(true);
    expect(n.porColecao.interacoes_fila || 0).toBeLessThan(estadosTodos.length);
  });
  test.each([A, B])('vendedor %s: Cliente 360 autoriza/nega igual, cliente a cliente, sem varrer a coleção', async uid => {
    const wl = (await db.doc('fila_comercial/worklist').get()).data();
    const escopo = await Q.__internals.escopoVendedor(db, uid, wl, await todos());
    let negados = 0, lidas = 0;
    for (const e of ENTS) {
      const cart = await db.doc('carteira_comercial/GC:' + gcDe(e)).get();
      const esperado = escopo.has(e) || (cart.exists && cart.data().ownerUid === uid);
      const { store, n } = contador();
      const obtido = await chamar(uid, { acao: 'cliente', entidade: e }, store).then(() => true, x => { if (x.message !== 'CLIENTE_FORA_DO_SEU_ESCOPO') throw x; return false; });
      expect([e, obtido]).toEqual([e, esperado]); if (!obtido) negados++;
      lidas = Math.max(lidas, n.porColecao.interacoes_fila || 0);
    }
    expect(negados).toBeGreaterThan(0); expect(lidas).toBeLessThan(25);
  });
  test.each([[A, A], [B, B], [G, A], [G, B]])('indicadores (%s sobre %s): mesmos números da regra com leitura completa, lendo menos', async (quem, alvo) => {
    const estados = await todos(); const somas = { contatosHoje: 0, retornosAtrasados: 0, retornosHoje: 0, vendasAposContato7d: 0, indeterminadas7d: 0 };
    const inicio = somar(HOJE, -37), recentes = new Set();
    for (const e of estados) {
      for (const x of outcomes(e)) if (x.operadorId === alvo) { const d = T.diaComercial(x.timestamp); if (d === HOJE) somas.contatosHoje++; if (d >= inicio && T.OUTCOMES_CONTATO.includes(x.outcome)) recentes.add(e.commercialEntityId); }
      const u = outcomes(e).slice(-1)[0];
      if (u && u.operadorId === alvo && e.nextFollowUpAt && e.estado !== 'CONCLUIDA') { if (e.nextFollowUpAt < HOJE) somas.retornosAtrasados++; else if (e.nextFollowUpAt === HOJE) somas.retornosHoje++; }
    }
    let historicoCompleto = 0;
    for (const ent of recentes) {
      const gc = gcDe(ent);
      const vs = (await db.collection('vendas_gc').where('cliente_id', 'in', [gc, Number(gc)]).get()).docs.map(d => ({ id: d.id, ...d.data() })); historicoCompleto += vs.length;
      const proprios = estados.filter(e => e.commercialEntityId === ent).map(e => ({ ...e, eventos: e.eventos.filter(x => x.operadorId === alvo) }));
      for (const v of T.vendasAposContato({ estados: proprios, vendas: vs })) {
        if (v.venda.data < somar(HOJE, -6) || v.venda.data > HOJE) continue;
        if (v.relacao === 'APOS' && v.diasAposContato <= 30) somas.vendasAposContato7d++; else if (v.relacao === 'INDETERMINADO') somas.indeterminadas7d++;
      }
    }
    const { store, n } = contador(); const r = await chamar(quem, { acao: 'indicadores', vendedorUid: alvo }, store);
    expect(r).toMatchObject(somas);
    expect(somas.vendasAposContato7d + somas.indeterminadas7d).toBeGreaterThan(0);
    expect(n.porColecao.vendas_gc).toBeLessThan(historicoCompleto);
  });
});

describe('Rules do sinalizador', () => {
  let env;
  beforeAll(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    env = await initializeTestEnvironment({ projectId: 'mr4-ponto-inf2', firestore: { host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '../../modulos/firestore.rules'), 'utf8') } });
    await env.withSecurityRulesDisabled(async c => {
      const f = c.firestore();
      for (const [u, role, mods, extra] of [['v', 'funcionario', ['fila-comercial-operar']], ['c', 'funcionario', ['fila-comercial-gestao']], ['g', 'gestor', []], ['s', 'funcionario', ['ponto']], ['b', 'funcionario', ['fila-comercial-operar'], { bloqueado: true }]]) {
        await f.doc('users/' + u).set({ role, ativo: true }); await f.doc('sistema_usuarios/' + u).set({ modulos: mods, admin: false, ...extra });
      }
      await f.doc('crm_fila_versao/estado').set({ versao: 'x' });
    });
  });
  afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });
  const doc = u => (u ? env.authenticatedContext(u) : env.unauthenticatedContext()).firestore().doc('crm_fila_versao/estado');
  test('vendedor, gestão e gestor leem; sem módulo, bloqueado e anônimo não', async () => {
    for (const u of ['v', 'c', 'g']) await assertSucceeds(doc(u).get());
    for (const u of ['s', 'b', null]) await assertFails(doc(u).get());
  });
  test('ninguém escreve nem lista pelo cliente', async () => {
    for (const u of ['v', 'c', 'g', null]) { await assertFails(doc(u).set({ versao: 'y' })); await assertFails(doc(u).delete()); }
    await assertFails(env.authenticatedContext('g').firestore().collection('crm_fila_versao').get());
  });
});
