'use strict';
// COM-03 — callable crmAtribuicaoRevisao. EMULADOR local (FIRESTORE_EMULATOR_HOST; padrão emulador isolado. Dados sintéticos; PROD_WRITES=0.
process.env.GCLOUD_PROJECT = 'demo-mr4-com03';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin');
const app = admin.initializeApp({ projectId: 'demo-mr4-com03' }, 'com03');
const db = app.firestore();
const R = require('../lib/atribuicaoRevisao');
const V = require('../../modulos/crm-atribuicao-view');
jest.setTimeout(120000);

const VEND = 'com03-vendedor', OUTRO = 'com03-outro', GEST = 'com03-gestor', CAM = 'com03-revisor4', BLOQ = 'com03-bloqueado';
const AGORA = '2026-11-26T15:00:00.000Z';
const opts = { db, now: () => new Date(AGORA) };
const pedir = (uid, data, o = opts) => R.atribuicaoRevisaoHandler({ auth: uid ? { uid } : null, data }, o);
const erro = p => p.then(() => 'OK', e => e.code + ':' + e.message);
const OPP = i => 'c003' + String(i).padStart(12, '0');
const COLS = ['users', 'sistema_usuarios', 'interacoes_fila', 'vendas_gc', 'clientes', 'crm_notas_privadas', 'carteira_comercial_devolucoes', 'carteira_comercial', 'carteira_reativacoes', 'audit_log', R.COLL, 'fila_comercial'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); for (const d of s.docs) await db.recursiveDelete(d.ref); } };

const atendimento = (i, entidade, dia, outcome, meta, op = VEND, hora = '12:00') => ({ opportunityInstanceId: OPP(i), commercialEntityId: entidade, tipoOportunidade: 'JANELA_DE_RECOMPRA', estado: 'CONCLUIDA',
  nomeCliente: 'Loja Fictícia ' + i, atualizadoEm: `${dia}T${hora}:20.000Z`, eventos: [{ tipo: 'CLAIMED', operadorId: op, timestamp: `${dia}T${hora}:00.000Z` },
    { tipo: 'OUTCOME_REGISTERED', operadorId: op, outcome, timestamp: `${dia}T${hora}:20.000Z`, ...(meta ? { meta } : {}) }] });
const venda = (id, cli, data, vendedor = '111', ex = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: vendedor, nome_vendedor: vendedor === '111' ? 'Vendedor Um' : 'Vendedor Dois',
  nome_situacao: 'Concretizada', valor_total: '100.50', cadastrado_em: data + ' 18:00:00', produtos: [{ produto_id: '1', nome_produto: 'Item Fictício', quantidade: '2', valor_total: '100.50' }], ...ex });

/** coleção → [id, JSON] ordenado: prova de que a revisão não altera mais nada. */
async function retrato(colecoes) {
  const out = {};
  for (const c of colecoes) out[c] = (await db.collection(c).get()).docs.map(d => [d.id, JSON.stringify(d.data())]).sort();
  return out;
}
const INTOCADAS = ['users', 'sistema_usuarios', 'interacoes_fila', 'vendas_gc', 'clientes', 'crm_notas_privadas', 'carteira_comercial_devolucoes', 'carteira_comercial', 'carteira_reativacoes', 'fila_comercial'];

beforeAll(async () => {
  await limpar();
  for (const [uid, role, mods, nome, gc, bloq] of [[VEND, 'funcionario', ['fila-comercial-operar'], 'Vendedor Um', '111'], [OUTRO, 'funcionario', ['fila-comercial-operar'], 'Vendedor Dois', '222'],
    [GEST, 'gestor', [], 'Gestora Teste'], [CAM, 'funcionario', ['fila-comercial-gestao'], 'Supervisora Teste'], [BLOQ, 'gestor', [], 'Bloqueada', null, true]]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome, modulos: mods, bloqueado: !!bloq, ...(gc ? { carteiraComercial: { gestaoClickVendedorId: gc } } : {}) });
  }
  const docs = {
    1: atendimento(1, 'GC_NATIVE:99300001', '2026-11-02', 'CONVERSA_REALIZADA', { temNota: true }),            // pedido do mesmo vendedor, 3 dias → provável
    2: atendimento(2, 'GC_NATIVE:99300002', '2026-11-02', 'CONVERSA_REALIZADA'),                               // outro vendedor → ambíguo
    3: atendimento(3, 'MR4_LINKED:FICTICIO0001', '2026-11-03', 'SEM_INTERESSE_AGORA'),                         // sem interesse e comprou → ambíguo
    4: atendimento(4, 'GC_NATIVE:99300004', '2026-11-03', 'CONVERSA_REALIZADA', { interesse: 'SIM' }),         // evidência declarada → a confirmar
    5: atendimento(5, 'GC_NATIVE:99300005', '2026-11-04', 'CONVERSA_REALIZADA'),                               // sem pedido
  };
  for (const d of Object.values(docs)) await db.doc('interacoes_fila/' + d.opportunityInstanceId).set(d);
  await db.doc(`crm_notas_privadas/${OPP(1)}__1`).set({ opportunityInstanceId: OPP(1), eventoIndex: 1, operadorId: VEND, texto: 'observação fictícia do contato' });
  await db.doc('clientes/FICTICIO0001').set({ nome: 'Cadastro Fictício', gestaoClickId: '99300003' });
  for (const v of [venda(8001, 99300001, '2026-11-05'), venda(8002, 99300002, '2026-11-04', '222'), venda(8003, 99300003, '2026-11-06'), venda(8004, 99300004, '2026-11-07'),
    venda(8006, 99300002, '2026-11-09', '222', { nome_situacao: 'Em aberto' }), venda(8099, 99300009, '2026-11-06')]) await db.doc('vendas_gc/' + v.id).set(v);
});
afterAll(async () => { await limpar(); await app.delete(); });

describe('acesso e payload', () => {
  test('anônimo, vendedor, bloqueado e desconhecido não listam nem decidem', async () => {
    expect(await erro(pedir(null, { acao: 'listar' }))).toMatch(/^unauthenticated/);
    for (const u of [VEND, OUTRO, BLOQ, 'inexistente-x']) {
      expect(await erro(pedir(u, { acao: 'listar' }))).toMatch(/^permission-denied/);
      expect(await erro(pedir(u, { acao: 'decidir', vendaId: '8001', opportunityInstanceId: OPP(1), decisao: 'COMPROVADA', observacao: 'tentativa', revisaoVista: 0, requestId: 'com03-neg-0001' }))).toMatch(/^permission-denied/);
    }
    expect((await db.collection(R.COLL).get()).size).toBe(0);
  });
  test('payload estrito: ação, campo extra (inclusive identidade) e janela', async () => {
    for (const data of [null, {}, { acao: 'apagar' }, { acao: 'listar', uid: GEST }, { acao: 'listar', janelaDias: 90 }, { acao: '__proto__' }])
      expect(await erro(pedir(GEST, data))).toMatch(/^invalid-argument/);
  });
});

describe('listar', () => {
  test('gera a lista a partir dos dados, com nomes, pedido, datas, contato e observação; não escreve nada', async () => {
    const antes = await retrato([...INTOCADAS, R.COLL, 'audit_log']);
    const r = await pedir(GEST, { acao: 'listar' });
    expect(await retrato([...INTOCADAS, R.COLL, 'audit_log'])).toEqual(antes);
    expect(r).toMatchObject({ dataCorte: '2026-11-25', janelaDias: 14, primeiroContato: '2026-11-02' });
    expect(r.casos.map(c => c.vendaId).sort()).toEqual(['8001', '8002', '8003', '8004', '8006']);   // 8099: cliente sem contato não é caso
    const por = Object.fromEntries(r.casos.map(c => [c.vendaId, c]));
    expect(por['8001']).toMatchObject({ cliente: 'Loja Fictícia 1', precisaRevisao: false, sistema: { nivel: 'PROVAVEL' }, contato: { por: 'Vendedor Um', dia: '2026-11-02', diasAntesDoPedido: 3 },
      pedido: { data: '2026-11-05', hora: '18:00', valor: 100.5, concluido: true, vendedor: 'Vendedor Um', itens: [{ nome: 'Item Fictício', quantidade: 2 }] } });
    expect(por['8001'].contatos[0]).toMatchObject({ por: 'Vendedor Um', horaInicio: '09:00', horaRegistro: '09:00', resultado: 'CONVERSA_REALIZADA', observacao: 'observação fictícia do contato' });
    expect(por['8002']).toMatchObject({ precisaRevisao: true, prioridade: 1, sistema: { motivo: 'VENDEDOR_DIVERGENTE' }, pedido: { vendedor: 'Vendedor Dois' } });
    expect(por['8002'].outrosPedidos.map(o => o.vendaId)).toEqual(['8006']);
    expect(por['8003']).toMatchObject({ cliente: 'Loja Fictícia 3', clienteGcId: '99300003', precisaRevisao: true, sistema: { motivo: 'SEM_INTERESSE_DECLARADO' } });
    expect(por['8004']).toMatchObject({ precisaRevisao: true, prioridade: 1, sistema: { nivel: 'ATRIBUIDA_COM_EVIDENCIA' } });
    expect(por['8006'].pedido).toMatchObject({ concluido: false, situacao: 'Em aberto' });
    expect(r.base.sort()).toEqual([1, 2, 3, 4, 5].map(OPP));
    const i = V.indicadores(r.casos, r.base);
    expect([i.porSituacao.COMPROVADA.pedidos, i.porSituacao.PROVAVEL.pedidos, i.porSituacao.AGUARDANDO.pedidos, i.porSituacao.NAO_ATRIBUIDA.pedidos, i.semPedido]).toEqual([0, 1, 3, 0, 1]);
  });
  test('supervisão com o módulo de gestão também lista', async () => {
    expect((await pedir(CAM, { acao: 'listar', janelaDias: 7 })).casos.length).toBeGreaterThan(0);
  });
});

describe('decidir', () => {
  const base = { acao: 'decidir', vendaId: '8002', opportunityInstanceId: OPP(2), decisao: 'PROVAVEL', observacao: 'cliente confirmou que falou com o vendedor', revisaoVista: 0, requestId: 'com03-req-0001' };

  test('entradas inválidas não gravam nada', async () => {
    for (const ex of [{ decisao: 'SIM' }, { observacao: '  ' }, { observacao: undefined }, { observacao: 'x'.repeat(501) }, { revisaoVista: -1 }, { revisaoVista: '0' }, { requestId: 'curto' }, { vendaId: 'abc' }, { opportunityInstanceId: 'x' }])
      expect(await erro(pedir(GEST, { ...base, ...ex }))).toMatch(/^invalid-argument/);
    expect(await erro(pedir(GEST, { ...base, vendaId: '123456' }))).toMatch(/^not-found/);
    expect(await erro(pedir(GEST, { ...base, vendaId: '8099' }))).toMatch(/^failed-precondition:PEDIDO_SEM_CONTATO_RELACIONADO/);
    expect(await erro(pedir(GEST, { ...base, opportunityInstanceId: OPP(1) }))).toMatch(/^aborted:CASO_MUDOU/);
    expect((await db.collection(R.COLL).get()).size).toBe(0);
    expect((await db.collection('audit_log').get()).size).toBe(0);
  });
  test('grava decisão, versão e auditoria; NÃO altera venda, carteira, atendimento, usuário nem fila', async () => {
    const antes = await retrato(INTOCADAS);
    const r = await pedir(GEST, base);
    expect(r).toMatchObject({ repetido: false, revisao: { decisao: 'PROVAVEL', revisao: 1, por: 'Gestora Teste', opportunityInstanceId: OPP(2) } });
    expect(await retrato(INTOCADAS)).toEqual(antes);
    const d = (await db.doc(R.COLL + '/8002').get()).data();
    expect(d).toMatchObject({ schemaVersion: R.SCHEMA, decisao: 'PROVAVEL', decididoPorUid: GEST, decididoPorPapel: 'PROPRIETARIO', decididoEm: AGORA,
      retrato: { nivelSistema: 'NAO_ATRIBUIVEL', motivoSistema: 'VENDEDOR_DIVERGENTE', dataPedido: '2026-11-04', valor: 100.5, pedidoConcluido: true, contatoOperadorUid: VEND, janelaDias: 14 } });
    expect(JSON.stringify(d)).not.toMatch(/Loja Fictícia|Vendedor Um/);                 // sem nomes no documento
    expect((await db.collection(R.COLL + '/8002/versoes').get()).size).toBe(1);
    const a = (await db.doc('audit_log/atrib_8002_1').get()).data();
    expect(a).toMatchObject({ action: 'ATTRIBUTION_REVIEW_DECIDED', category: 'COMMERCIAL', entityId: '8002', actorUid: GEST, actorRole: 'gestor', before: null, after: { decisao: 'PROVAVEL', revisao: 1 },
      metadata: { opportunityInstanceId: OPP(2), nivelSistema: 'NAO_ATRIBUIVEL', temObservacao: true } });
    expect(JSON.stringify(a)).not.toContain('cliente confirmou');
  });
  test('repetir o mesmo requestId não duplica; reutilizá-lo com outro conteúdo é recusado', async () => {
    expect(await pedir(GEST, base)).toMatchObject({ repetido: true, revisao: { revisao: 1 } });
    expect(await erro(pedir(GEST, { ...base, decisao: 'COMPROVADA' }))).toMatch(/^already-exists/);
    expect(await erro(pedir(CAM, base))).toMatch(/^already-exists/);
    expect((await db.collection('audit_log').get()).size).toBe(1);
  });
  test('quem viu versão antiga não sobrescreve; a alteração preserva o histórico', async () => {
    const novo = { ...base, decisao: 'NAO_ATRIBUIDA', observacao: 'conferido: veio de outro canal', requestId: 'com03-req-0002' };
    expect(await erro(pedir(CAM, novo))).toMatch(/^aborted:DECISAO_JA_ALTERADA/);
    expect(await pedir(CAM, { ...novo, revisaoVista: 1 })).toMatchObject({ revisao: { decisao: 'NAO_ATRIBUIDA', revisao: 2, por: 'Supervisora Teste' } });
    expect((await db.collection(R.COLL + '/8002/versoes').get()).docs.map(x => x.data().decisao).sort()).toEqual(['NAO_ATRIBUIDA', 'PROVAVEL']);
    expect((await db.doc('audit_log/atrib_8002_2').get()).data()).toMatchObject({ action: 'ATTRIBUTION_REVIEW_CHANGED', before: { decisao: 'PROVAVEL', revisao: 1 }, after: { decisao: 'NAO_ATRIBUIDA', revisao: 2 } });
  });
  test('a repetição tardia do primeiro pedido não desfaz a decisão mais nova', async () => {
    expect(await pedir(GEST, base)).toMatchObject({ repetido: true });
    expect((await db.doc(R.COLL + '/8002').get()).data().decisao).toBe('NAO_ATRIBUIDA');
  });
  test('duas decisões simultâneas sobre a mesma versão: só uma vale', async () => {
    const um = ex => pedir(GEST, { ...base, vendaId: '8004', opportunityInstanceId: OPP(4), decisao: 'COMPROVADA', observacao: 'orçamento conferido', ...ex });
    const r = await Promise.allSettled([um({ requestId: 'com03-conc-001' }), um({ requestId: 'com03-conc-002' })]);
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await db.doc(R.COLL + '/8004').get()).data().revisao).toBe(1);
  });
  test('quem fez o contato não decide o próprio caso, mesmo com papel de gestão', async () => {
    await db.doc('users/' + VEND).update({ role: 'gestor' });
    try { expect(await erro(pedir(VEND, { ...base, vendaId: '8001', opportunityInstanceId: OPP(1), requestId: 'com03-req-0009' }))).toMatch(/^permission-denied:Quem fez/); }
    finally { await db.doc('users/' + VEND).update({ role: 'funcionario' }); }
  });
  test('a lista passa a mostrar a decisão e os indicadores separam as situações', async () => {
    const r = await pedir(GEST, { acao: 'listar' });
    const i = V.indicadores(r.casos, r.base);
    expect([i.porSituacao.COMPROVADA.pedidos, i.porSituacao.PROVAVEL.pedidos, i.porSituacao.AGUARDANDO.pedidos, i.porSituacao.NAO_ATRIBUIDA.pedidos]).toEqual([1, 1, 1, 1]);
    expect(r.casos.find(c => c.vendaId === '8004').revisao).toMatchObject({ decisao: 'COMPROVADA', por: 'Gestora Teste' });
  });
});

describe('publicação', () => {
  test('exportada no index; Rules não dão acesso direto à coleção (negada por padrão)', () => {
    expect(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')).toMatch(/exports\.crmAtribuicaoRevisao = onCall/);
    const regras = fs.readFileSync(path.join(__dirname, '../../modulos/firestore.rules'), 'utf8');
    expect(regras).not.toContain(R.COLL);
    expect(regras).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  });
});
