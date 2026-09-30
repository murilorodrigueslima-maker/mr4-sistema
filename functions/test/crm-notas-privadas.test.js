'use strict';
// CRM MR4 2.0 — notas livres PRIVADAS (crm_notas_privadas). Emulador. Texto da nota nunca em documento legível por outro vendedor.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'mr4-ponto';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const F = require('../lib/filaOperacional'), C = require('../lib/canaryCallable'), Q = require('../lib/crmConsulta');
jest.setTimeout(60000);

const A = 'npv-sellerA', B = 'npv-sellerB', MGR = 'npv-manager', ADM = 'npv-adminflag', DUAL = 'npv-dual', NOMOD = 'npv-nomod', INAT = 'npv-inativo';
const O1 = 'b1b2000000000001', O2 = 'b1b2000000000002';
const E1 = 'GC_NATIVE:99200001', E2 = 'GC_NATIVE:99200002';
const NOTA = 'Cliente pediu retorno na próxima semana.';
const T = '2026-09-28T13:00:00.000Z';
const at = iso => ({ now: () => new Date(iso) });
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
const erro = p => p.then(() => 'OK', e => e.code + ':' + e.message);
const item = (opp, ent, nome) => ({ opportunityInstanceId: opp, commercialEntityId: ent, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: nome,
  contextoComercial: { versao: 'V1', motivo: 'Cliente parado há mais de 120 dias.', rotuloTipo: 'Retomar contato', historico: { ultimaCompraEm: '2026-04-01', diasSemComprar: 180, pedidosTotal: 9, cicloHabitualDias: 30 }, tendencia: 'CAINDO' } });
const worklist = extraB => ({ schemaVersion: 'worklist-v2', versao: 'N35.18.1', dataReferencia: '2026-09-28', cap: 10, vendedoresAtivos: [A, B], vendedoresRotulos: { [A]: 'Alice', [B]: 'Bruno' },
  vendedores: { [A]: { novas: [item(O1, E1, 'Cliente Um')], followUps: [], emAtendimento: [], pendentes: [] }, [B]: { novas: [item(O2, E2, 'Cliente Dois')], followUps: [], emAtendimento: [], pendentes: extraB ? [item('b1b2000000000009', E1, 'Cliente Um')] : [] } },
  atribuicoes: { [O1]: { uid: A, grupo: 'novas', commercialEntityId: E1, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente Um', desde: '2026-09-28' }, [O2]: { uid: B, grupo: 'novas', commercialEntityId: E2, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente Dois', desde: '2026-09-28' } },
  pendenciasRetidas: {}, canarios: [] });
const notasDe = async opp => (await db.collection('crm_notas_privadas').get()).docs.filter(d => d.id.startsWith(opp)).map(d => ({ id: d.id, ...d.data() }));
const evs = async opp => (await db.doc('interacoes_fila/' + opp).get()).data().eventos.filter(e => e.tipo === 'OUTCOME_REGISTERED');
const consulta = (uid, data, now = '2026-09-29T13:00:00.000Z') => Q.crmConsultaHandler(req(uid, data), { db, ...at(now) });
let env, wlAntes;
async function limpar() {
  for (const o of [O1, O2, 'b1b2000000000009']) await db.doc('interacoes_fila/' + o).delete();
  for (const d of (await db.collection('crm_notas_privadas').get()).docs) if (d.id.startsWith('b1b2')) await d.ref.delete();
  await db.doc('fila_comercial/worklist').set(worklist(false));
}
async function registrar(uid, opp, nota, extra = {}) {
  await C.claimOpportunityHandler(req(uid, { opportunityInstanceId: opp }), at(T));
  return C.registerOutcomeHandler(req(uid, { opportunityInstanceId: opp, outcome: 'CONVERSA_REALIZADA', nota, ...extra }), at(T));
}
beforeAll(async () => {
  const w = await db.doc('fila_comercial/worklist').get(); wlAntes = w.exists ? w.data() : null;
  for (const [uid, role, mods, admin_, ativo] of [[A, 'funcionario', ['fila-comercial-operar'], false, true], [B, 'funcionario', ['fila-comercial-operar'], false, true], [MGR, 'gestor', [], false, true],
    [ADM, 'funcionario', [], true, true], [DUAL, 'gestor', ['fila-comercial-operar'], true, true], [NOMOD, 'funcionario', ['ponto'], false, true], [INAT, 'funcionario', ['fila-comercial-operar'], false, false]]) {
    await db.doc('users/' + uid).set({ role, ativo }); await db.doc('sistema_usuarios/' + uid).set({ nome: 'Nome ' + uid.slice(4), bloqueado: false, modulos: mods, admin: admin_ });
  }
  env = await initializeTestEnvironment({ projectId: 'mr4-ponto', firestore: { rules: fs.readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  for (const u of [A, B, MGR, ADM, DUAL, NOMOD, INAT]) { await db.doc('users/' + u).delete(); await db.doc('sistema_usuarios/' + u).delete(); }
  if (wlAntes) await db.doc('fila_comercial/worklist').set(wlAntes); else await db.doc('fila_comercial/worklist').delete();
  if (env) await env.cleanup();
});
const cliente = (uid, ent = E1) => consulta(uid, { acao: 'cliente', entidade: ent });
const fsAs = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

describe('gravação privada', () => {
  test('NP-01 nota vai para crm_notas_privadas (id opp__índice), evento só com temNota; resposta sem texto', async () => {
    const r = await registrar(A, O1, `  ${NOTA}  `);
    const ns = await notasDe(O1);
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ texto: NOTA, operadorId: A, opportunityInstanceId: O1, commercialEntityId: E1, eventoEm: T });
    expect(ns[0].id).toBe(`${O1}__${ns[0].eventoIndex}`);
    expect((await evs(O1))[0].meta).toEqual({ temNota: true });
    expect(JSON.stringify(r)).not.toContain('retorno');
  });
  test('NP-02 o texto não aparece em NENHUM documento compartilhado (interacoes_fila, worklist, cliente 360 de B no escopo, cartões, indicadores)', async () => {
    await registrar(A, O1, NOTA);
    await db.doc('fila_comercial/worklist').set(worklist(true));                      // B passa a ter o cliente de A na própria lista
    const partes = [JSON.stringify((await db.collection('interacoes_fila').get()).docs.map(d => d.data())), JSON.stringify((await db.doc('fila_comercial/worklist').get()).data()),
      JSON.stringify(await cliente(B)), JSON.stringify(await consulta(B, { acao: 'cartoes', entidades: [E1, E2] })), JSON.stringify(await consulta(B, { acao: 'indicadores' })), JSON.stringify(await consulta(A, { acao: 'indicadores' })),
      JSON.stringify(await consulta(A, { acao: 'cartoes', entidades: [E1] }))];
    partes.forEach(p => expect(p).not.toContain('retorno na próxima'));
    // e tudo o que o vendedor B consegue LER direto no Firestore
    let achou = 0;
    for (const col of ['interacoes_fila', 'fila_comercial', 'carteira_comercial', 'users', 'sistema_usuarios', 'clientes', 'perfis_360'])
      try { const s = await fsAs(B).collection(col).get(); achou += JSON.stringify(s.docs.map(d => d.data())).includes('retorno na próxima') ? 1 : 0; } catch (_) { /* negado */ }
    expect(achou).toBe(0);                                                            // NOTE_TEXT_FOUND_IN_SHARED_DOCS=0
  });
  test('NP-03 sem nota / nota vazia / só espaços: nenhum documento privado, sem temNota', async () => {
    await registrar(A, O1, '   ');
    expect(await notasDe(O1)).toHaveLength(0); expect((await evs(O1))[0].meta).toBeUndefined();
    await limpar(); await registrar(A, O1, undefined);
    expect(await notasDe(O1)).toHaveLength(0);
  });
  test('NP-04 limite 280 (code points): 280 ok com Unicode/emoji; 281 rejeita sem gravar nada (nem resultado)', async () => {
    const u = '😀'.repeat(140) + 'ação✓'.repeat(28);                                    // 140 + 140 = 280 pontos de código
    expect(Array.from(u)).toHaveLength(280);
    await C.claimOpportunityHandler(req(A, { opportunityInstanceId: O1 }), at(T));
    expect(await erro(C.registerOutcomeHandler(req(A, { opportunityInstanceId: O1, outcome: 'CONVERSA_REALIZADA', nota: u + 'x' }), at(T)))).toMatch(/^invalid-argument/);
    expect((await db.doc('interacoes_fila/' + O1).get()).data().estado).toBe('EM_ATENDIMENTO'); expect(await notasDe(O1)).toHaveLength(0);
    await C.registerOutcomeHandler(req(A, { opportunityInstanceId: O1, outcome: 'CONVERSA_REALIZADA', nota: u }), at(T));
    expect((await notasDe(O1))[0].texto).toBe(u);
  });
});

describe('isolamento de leitura', () => {
  test('NP-05 A lê a própria nota no Cliente 360 (SELLER_A_OWN_NOTE=ALLOW); gestor e dual-role também', async () => {
    await registrar(A, O1, NOTA);
    expect((await cliente(A)).observacoes[0]).toMatchObject({ nota: NOTA, porUid: A });
    expect((await cliente(MGR)).observacoes[0].nota).toBe(NOTA);
    expect((await cliente(DUAL)).observacoes[0].nota).toBe(NOTA);
    expect((await cliente(A)).timeline.find(x => x.nota).nota).toBe(NOTA);
  });
  test('NP-06 B fora do escopo: negado; B no escopo do mesmo cliente: abre, mas NÃO vê a nota de A', async () => {
    await registrar(A, O1, NOTA);
    expect(await erro(cliente(B))).toMatch(/^permission-denied:CLIENTE_FORA_DO_SEU_ESCOPO/);
    await db.doc('fila_comercial/worklist').set(worklist(true));
    const r = await cliente(B);
    expect(r.observacoes).toEqual([]); expect(JSON.stringify(r)).not.toContain('retorno na próxima');
    expect(r.timeline.every(x => !x.nota)).toBe(true);
  });
  test('NP-07 payload manipulado: não existe ação/parâmetro para buscar nota por opp/evento; campos extras recusados', async () => {
    await registrar(A, O1, NOTA);
    for (const d of [{ acao: 'cliente', entidade: E1, opportunityInstanceId: O1 }, { acao: 'cliente', entidade: E1, eventoIndex: 1 }, { acao: 'notas', opportunityInstanceId: O1 }, { acao: 'cliente', entidade: E1, nota: 'x', operadorId: A }])
      expect(await erro(consulta(B, d))).toMatch(/^invalid-argument/);
    expect(await erro(consulta(B, { acao: 'cliente', entidade: 'GC_NATIVE:99200001/../x' }))).toMatch(/^invalid-argument:ENTIDADE_INVALIDA/);
  });
  test('NP-08 sem módulo, inativo, anônimo, admin=true sem papel/módulo: negados no backend', async () => {
    await registrar(A, O1, NOTA);
    expect(await erro(cliente(NOMOD))).toMatch(/^permission-denied/);
    expect(await erro(cliente(INAT))).toMatch(/^permission-denied/);
    expect(await erro(cliente(ADM))).toMatch(/^permission-denied/);                  // ADMIN_NOTE_ACCESS: só com papel gestor/módulo de gestão
    expect(await erro(cliente(null))).toMatch(/^unauthenticated/);
  });
  test('NP-09 módulo de gestão vê todas; vendedor com nota de OUTRO vendedor no mesmo cliente não a vê (autoria confere com o evento)', async () => {
    await registrar(A, O1, NOTA);
    expect((await cliente(MGR)).observacoes).toHaveLength(1);
    // adulteração do evento público: trocar o operador do evento para B não expõe a nota a B (nota.operadorId ≠ B)
    const ref = db.doc('interacoes_fila/' + O1); const d = (await ref.get()).data();
    d.eventos = d.eventos.map(e => (e.tipo === 'OUTCOME_REGISTERED' ? { ...e, operadorId: B } : e)); await ref.set(d);
    await db.doc('fila_comercial/worklist').set(worklist(true));
    expect((await cliente(B)).observacoes).toEqual([]);
  });
});

describe('Firestore direto (Rules reais)', () => {
  test('NP-10 leitura e escrita direta em crm_notas_privadas: negadas para todos (A, B, gestor, admin, dual, sem módulo, anônimo)', async () => {
    await registrar(A, O1, NOTA);
    const n = (await notasDe(O1))[0];
    for (const uid of [A, B, MGR, ADM, DUAL, NOMOD, INAT, null]) {
      await assertFails(fsAs(uid).doc('crm_notas_privadas/' + n.id).get());
      await assertFails(fsAs(uid).collection('crm_notas_privadas').get());
      await assertFails(fsAs(uid).collection('crm_notas_privadas').where('operadorId', '==', A).get());
      await assertFails(fsAs(uid).doc('crm_notas_privadas/' + n.id).set({ texto: 'x' }));
      await assertFails(fsAs(uid).doc('crm_notas_privadas/' + O2 + '__1').set({ texto: 'forjada', operadorId: uid }));
      await assertFails(fsAs(uid).doc('crm_notas_privadas/' + n.id).delete());
    }
  });
});

describe('idempotência, concorrência, atomicidade', () => {
  test('NP-11 clique duplo / 3 requisições simultâneas: 1 resultado, 1 nota', async () => {
    await C.claimOpportunityHandler(req(A, { opportunityInstanceId: O1 }), at(T));
    const p = { opportunityInstanceId: O1, outcome: 'CONVERSA_REALIZADA', nota: NOTA };
    const r = await Promise.all([1, 2, 3].map(() => erro(C.registerOutcomeHandler(req(A, p), at(T)))));
    expect(r.filter(x => x === 'OK')).toHaveLength(1);
    expect(await evs(O1)).toHaveLength(1); expect(await notasDe(O1)).toHaveLength(1);   // DUPLICATE_OUTCOMES=0, DUPLICATE_PRIVATE_NOTES=0
  });
  test('NP-12 retry depois do sucesso (timeout do cliente): recusado, sem segunda nota; nova rodada gera nota com outro índice', async () => {
    await C.claimOpportunityHandler(req(A, { opportunityInstanceId: O1 }), at(T));
    await C.registerOutcomeHandler(req(A, { opportunityInstanceId: O1, outcome: 'SEM_RESPOSTA', nota: NOTA }), at(T));
    expect(await erro(C.registerOutcomeHandler(req(A, { opportunityInstanceId: O1, outcome: 'SEM_RESPOSTA', nota: NOTA }), at(T)))).toMatch(/^failed-precondition/);
    expect(await notasDe(O1)).toHaveLength(1);
    await C.claimOpportunityHandler(req(A, { opportunityInstanceId: O1 }), at('2026-09-29T13:00:00.000Z'));
    await C.registerOutcomeHandler(req(A, { opportunityInstanceId: O1, outcome: 'SEM_RESPOSTA', nota: 'segunda' }), at('2026-09-29T13:05:00.000Z'));
    const ns = await notasDe(O1); expect(ns.map(x => x.texto).sort()).toEqual(['segunda', NOTA].sort()); expect(new Set(ns.map(x => x.id)).size).toBe(2);
    expect((await cliente(A)).observacoes.map(o => o.nota).sort()).toEqual(['segunda', NOTA].sort());
  });
  test('NP-13 atomicidade: se a nota não puder ser gravada, o resultado também NÃO é (e vice-versa); sem escrita parcial', async () => {
    await C.claimOpportunityHandler(req(A, { opportunityInstanceId: O1 }), at(T));
    const antes = (await db.doc('interacoes_fila/' + O1).get()).data();
    const idx = antes.eventos.length;                                                  // índice que o novo evento teria
    await db.doc('crm_notas_privadas/' + O1 + '__' + idx).set({ texto: 'pré-existente', operadorId: 'x' });   // força colisão do create()
    await expect(C.registerOutcomeHandler(req(A, { opportunityInstanceId: O1, outcome: 'CONVERSA_REALIZADA', nota: NOTA }), at(T))).rejects.toBeTruthy();
    const depois = (await db.doc('interacoes_fila/' + O1).get()).data();
    expect(depois).toEqual(antes);                                                     // resultado não gravado
    expect((await db.doc('crm_notas_privadas/' + O1 + '__' + idx).get()).data().texto).toBe('pré-existente');   // nota intacta
  });
  test('NP-14 dois vendedores simultâneos em oportunidades diferentes: cada nota no seu par, sem cruzar', async () => {
    await Promise.all([registrar(A, O1, 'nota da Alice'), registrar(B, O2, 'nota do Bruno')]);
    expect((await notasDe(O1)).map(x => [x.operadorId, x.texto])).toEqual([[A, 'nota da Alice']]);
    expect((await notasDe(O2)).map(x => [x.operadorId, x.texto])).toEqual([[B, 'nota do Bruno']]);
  });
});

describe('texto não confiável (XSS)', () => {
  const PAYLOADS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>'];
  test('NP-15 payload é guardado como texto puro e devolvido como string (nunca HTML); interface escapa tudo', async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../modulos/crm.html'), 'utf8');
    const esc = eval('(' + src.match(/const esc = (s => [^\n]+);/)[1] + ')');
    for (const p of PAYLOADS) {
      await limpar(); await registrar(A, O1, p);
      const o = (await cliente(A)).observacoes[0];
      expect(o.nota).toBe(p); expect(typeof o.nota).toBe('string');
      const html = esc(o.nota);
      expect(html).not.toMatch(/[<>"]/); expect(html).toMatch(/&lt;|&quot;/);        // NOTE_RENDERED_AS_TEXT / EXECUTABLE_HTML=NO
    }
    // a nota só chega ao HTML por esc() (observações e timeline)
    expect(src).toMatch(/\$\{esc\(o\.nota\)\}|esc\(o\.nota\)/); expect(src).toMatch(/esc\(e\.nota\)/);
  });
});

describe('carregamento inicial não traz notas', () => {
  test('NP-16 Hoje/Agenda (onSnapshot) só veem temNota; crmConsulta cartoes/indicadores não tocam crm_notas_privadas', async () => {
    await registrar(A, O1, NOTA);
    const lidas = [], lidasDoc = []; const store = new Proxy(db, { get(t, k) { const v = t[k]; if (k === 'collection') return c => { lidas.push(c); return t.collection(c); }; if (k === 'getAll') return (...a) => { a.forEach(r => lidasDoc.push(r.path.split('/')[0])); return t.getAll(...a); }; return typeof v === 'function' ? v.bind(t) : v; } });
    await Q.crmConsultaHandler(req(A, { acao: 'cartoes', entidades: [E1] }), { db: store, ...at('2026-09-29T13:00:00.000Z') });
    await Q.crmConsultaHandler(req(A, { acao: 'indicadores' }), { db: store, ...at('2026-09-29T13:00:00.000Z') });
    expect(lidas.concat(lidasDoc)).not.toContain('crm_notas_privadas');
    lidas.length = 0; lidasDoc.length = 0;
    await Q.crmConsultaHandler(req(A, { acao: 'cliente', entidade: E1 }), { db: store, ...at('2026-09-29T13:00:00.000Z') });
    expect(lidasDoc.filter(c => c === 'crm_notas_privadas')).toHaveLength(1);           // 1 leitura por nota existente, só no Cliente 360
  });
});
